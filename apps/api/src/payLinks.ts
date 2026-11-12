/**
 * Link de pagamento do PagBank (Pix, cartão ou boleto na página deles) por período do plano. Serve enquanto a API
 * de cobrança do PagBank não está liberada para a conta (conta PF / homologação pendente, 11/2026).
 * O PagBank não avisa o sistema quando o link é pago: o super admin confirma em Pagamentos.
 */
const PAY_LINK_HOSTS = ["pagbank.com.br", "pagseguro.uol.com.br", "pagseguro.com.br", "pag.ae"];
export const PAY_LINK_CYCLES = ["monthly", "quarterly", "semiannual", "yearly"];

/** "" quando vazio, a URL normalizada quando é https num domínio do PagBank, null quando é inválido. */
export const payLinkOf = (value: unknown): string | null => {
  const text = String(value ?? "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || !PAY_LINK_HOSTS.some(item => host === item || host.endsWith(`.${item}`))) return null;
    return url.toString();
  } catch {
    return null;
  }
};

/** Links por período; null se algum for inválido (o painel mostra o erro em vez de gravar calado). */
export const payLinksOf = (value: unknown): Record<string, string> | null => {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const links: Record<string, string> = {};
  for (const cycle of PAY_LINK_CYCLES) {
    const link = payLinkOf(raw[cycle]);
    if (link === null) return null;
    if (link) links[cycle] = link;
  }
  return links;
};
