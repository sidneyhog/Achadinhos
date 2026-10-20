import axios from "axios";
import { loadPlatform } from "./platform";
import { decrypt } from "./secrets";

/**
 * PagBank (API de Pedidos): cada cobrança é um pedido com um QR Code Pix próprio.
 * O aviso de pagamento chega em notification_urls, mas o sistema nunca confia nele sozinho:
 * sempre consulta o pedido no PagBank com o token antes de liberar a assinatura.
 */
export const loadPagbank = async () => {
  const row = await loadPlatform();
  return {
    token: decrypt(row.pagbank_token_enc || ""),
    sandbox: row.pagbank_sandbox !== false,
    publicUrl: String(row.public_url || "").replace(/\/+$/, ""),
    active: row.payment_provider === "pagbank"
  };
};

// PAGBANK_API_URL só existe para os testes apontarem para um PagBank simulado.
const base = (sandbox: boolean) => process.env.PAGBANK_API_URL || (sandbox ? "https://sandbox.api.pagseguro.com" : "https://api.pagseguro.com");

const client = async () => {
  const cfg = await loadPagbank();
  if (!cfg.token) throw new Error("PagBank sem token. Cole o token em Integrações.");
  return {
    cfg,
    http: axios.create({
      baseURL: base(cfg.sandbox),
      timeout: 20000,
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json", accept: "application/json" }
    })
  };
};

/** Mensagem legível a partir do erro do PagBank. */
export const pagbankError = (err: unknown) => {
  const data = (err as { response?: { status?: number; data?: { error_messages?: Array<{ description?: string; parameter_name?: string }> } } })?.response;
  const first = data?.data?.error_messages?.[0];
  if (data?.status === 401 || data?.status === 403) return "O PagBank recusou o token. Confira o token e o ambiente (teste ou produção).";
  if (first?.description) return `PagBank: ${first.description}${first.parameter_name ? ` (${first.parameter_name})` : ""}`;
  return (err as Error)?.message || "Falha ao falar com o PagBank";
};

export const createPagbankPix = async (input: {
  referenceId: string;
  amountCents: number;
  itemName: string;
  customer: { name: string; email: string; taxId: string };
  expiresAt: Date;
  notificationUrl?: string;
}) => {
  const { http } = await client();
  const { data } = await http.post("/orders", {
    reference_id: input.referenceId,
    customer: { name: input.customer.name.slice(0, 120), email: input.customer.email, tax_id: input.customer.taxId },
    items: [{ reference_id: "assinatura", name: input.itemName.slice(0, 100), quantity: 1, unit_amount: input.amountCents }],
    qr_codes: [{ amount: { value: input.amountCents }, expiration_date: input.expiresAt.toISOString() }],
    ...(input.notificationUrl ? { notification_urls: [input.notificationUrl] } : {})
  });
  const qr = data?.qr_codes?.[0] || {};
  const image = (qr.links || []).find((link: { rel?: string; href?: string }) => String(link.rel || "").toUpperCase().includes("PNG"))?.href || "";
  return { orderId: String(data?.id || ""), qrText: String(qr.text || ""), qrImage: String(image) };
};

/** Situação do pedido no PagBank: pago (com o valor pago) ou ainda não. */
export const getPagbankOrder = async (orderId: string) => {
  const { http } = await client();
  const { data } = await http.get(`/orders/${encodeURIComponent(orderId)}`);
  const charges: Array<{ status?: string; amount?: { value?: number; summary?: { paid?: number } } }> = Array.isArray(data?.charges) ? data.charges : [];
  const paid = charges.filter(charge => String(charge.status || "").toUpperCase() === "PAID");
  const paidCents = paid.reduce((sum, charge) => sum + Number(charge.amount?.summary?.paid ?? charge.amount?.value ?? 0), 0);
  return { paid: paid.length > 0, paidCents, raw: data };
};

/** Testa o token: um pedido inexistente devolve 404/400 com token bom e 401/403 com token ruim. */
export const testPagbank = async () => {
  const { http, cfg } = await client();
  try {
    await http.get("/orders/ORDE_00000000-0000-0000-0000-000000000000");
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 401 || status === 403) throw new Error(pagbankError(err));
    if (status && status >= 500) throw new Error("O PagBank não respondeu agora. Tente de novo em instantes.");
  }
  return { ok: true, sandbox: cfg.sandbox };
};
