import { useEffect, useRef, useState } from "react";
import { api } from "./api";

type Invoice = { id: number; amountCents: number; cycle: string; status: string; provider: string; qrText: string; qrImage: string; expiresAt: string | null; paidAt: string | null };
type Billing = {
  provider: "pagbank" | "efi" | null;
  plan: { name: string; prices: Record<string, number | null> };
  subscription: { status: string; cycle: string | null; trialEndsAt: string | null; currentPeriodEnd: string | null; companyStatus: string };
  taxIdHint: string;
  open: Invoice | null;
  history: Invoice[];
};

const CYCLES: Array<[string, string]> = [["monthly", "Mensal"], ["quarterly", "Trimestral"], ["semiannual", "Semestral"], ["yearly", "Anual"]];
const money = (cents: number) => (Number(cents || 0) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const day = (iso?: string | null) => iso ? new Date(iso).toLocaleDateString("pt-BR") : "—";
const cycleName = (id?: string | null) => CYCLES.find(([key]) => key === id)?.[1] || "Mensal";

/** "Minha assinatura": paga com Pix (PagBank) e a tela confirma sozinha quando o pagamento cai. */
export function BillingView({ onPaid, tell }: { onPaid: () => Promise<unknown>; tell: (title: string, text: string, tone?: "ok" | "bad") => void }) {
  const [data, setData] = useState<Billing | null>(null);
  const [cycle, setCycle] = useState("monthly");
  const [coupon, setCoupon] = useState("");
  const [taxId, setTaxId] = useState("");
  const [busy, setBusy] = useState(false);
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [paidUntil, setPaidUntil] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const checking = useRef(false);

  const load = async () => {
    const next = await api<Billing>("/api/billing");
    setData(next);
    if (next.open) setInvoice((current) => current || next.open);
    if (next.subscription.cycle && next.plan.prices[next.subscription.cycle] != null) setCycle(next.subscription.cycle);
    return next;
  };
  useEffect(() => { load().catch((err) => tell("Não carregou", err instanceof Error ? err.message : "Falha", "bad")); }, []);

  // Enquanto o Pix está na tela: relógio a cada segundo e consulta a cada 5 s.
  useEffect(() => {
    if (!invoice || invoice.status !== "pending") return;
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    const poll = window.setInterval(() => { void check(false); }, 5000);
    return () => { window.clearInterval(clock); window.clearInterval(poll); };
  }, [invoice?.id, invoice?.status]);

  const check = async (force: boolean) => {
    if (!invoice || checking.current) return;
    checking.current = true;
    try {
      const result = await api<{ invoice: Invoice; currentPeriodEnd: string | null }>(`/api/billing/invoices/${invoice.id}${force ? "?check=1" : ""}`);
      setInvoice(result.invoice);
      if (result.invoice.status === "paid") {
        setPaidUntil(result.currentPeriodEnd);
        await onPaid();
        await load();
      } else if (force) {
        tell("Ainda não caiu", "O PagBank ainda não confirmou. Pode levar alguns segundos; a tela atualiza sozinha.");
      }
    } catch (err) {
      if (force) tell("Não consultou", err instanceof Error ? err.message : "Falha", "bad");
    } finally {
      checking.current = false;
    }
  };

  const pay = async () => {
    setBusy(true);
    try {
      const result = await api<{ configured: boolean; message?: string; invoice?: Invoice }>("/api/billing/checkout", { method: "POST", body: JSON.stringify({ cycle, coupon, taxId }) });
      if (!result.configured) { tell("Pagamento", result.message || "O pagamento online ainda não está ativo.", "bad"); return; }
      if (result.invoice) { setInvoice(result.invoice); setPaidUntil(null); }
    } catch (err) {
      tell("Não gerou o Pix", err instanceof Error ? err.message : "Falha", "bad");
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!invoice) return;
    try {
      await navigator.clipboard.writeText(invoice.qrText);
      tell("Copiado", "Cole no app do seu banco, na opção Pix copia e cola.");
    } catch {
      tell("Copie o código", "Toque e segure o código abaixo para copiar.", "bad");
    }
  };

  if (!data) return <section className="aff-block"><p>Carregando…</p></section>;
  const sub = data.subscription;
  const ends = sub.status === "trialing" ? sub.trialEndsAt : sub.currentPeriodEnd;
  const late = ends ? new Date(ends).getTime() < Date.now() : false;
  const statusText = sub.companyStatus === "suspended" ? "Suspensa: pague para voltar a publicar" : sub.status === "trialing" ? (late ? "Teste encerrado" : "Teste grátis") : sub.status === "active" ? (late ? "Vencida" : "Ativa") : "Cancelada";
  const left = invoice?.expiresAt ? Math.max(0, Math.floor((new Date(invoice.expiresAt).getTime() - now) / 1000)) : 0;
  const expired = invoice?.status === "expired" || (invoice?.status === "pending" && invoice.expiresAt && left === 0);

  return (
    <section className="aff-block" style={{ maxWidth: 560 }}>
      <header className="aff-guide__head"><h2>Minha assinatura</h2><p>Pague com Pix e a liberação é na hora.</p></header>
      <div className="aff-prefs">
        <div className={`aff-wastate ${sub.companyStatus === "suspended" || late ? "is-off" : sub.status === "active" ? "is-on" : "is-qr"}`}>
          <strong>{data.plan.name} · {statusText}</strong>
          <span>{sub.status === "trialing" ? "Teste até" : "Válida até"} {day(ends)}{sub.status === "active" ? ` · ${cycleName(sub.cycle)}` : ""}</span>
        </div>

        {invoice?.status === "paid" ? (
          <div className="aff-wastate is-on">
            <strong>✅ Pagamento confirmado!</strong>
            <span>Obrigado. Sua assinatura está ativa{paidUntil ? ` até ${day(paidUntil)}` : ""}.</span>
          </div>
        ) : null}

        {!data.provider ? (
          <p className="aff-config-error">O pagamento online ainda não está ativo. Fale com o suporte para renovar.</p>
        ) : invoice && invoice.status === "pending" && !expired ? (
          <article className="aff-pref" style={{ justifyItems: "center", textAlign: "center" }}>
            <strong>Pague {money(invoice.amountCents)} com Pix</strong>
            {invoice.qrImage ? <img src={invoice.qrImage} alt="QR Code Pix" width={260} height={260} /> : null}
            <small>Abra o app do banco, escolha Pix e leia o QR Code, ou use o copia e cola.</small>
            <textarea readOnly value={invoice.qrText} rows={3} style={{ width: "100%", fontSize: 12 }} onFocus={(event) => event.currentTarget.select()} />
            <div className="aff-conn__actions">
              <button type="button" className="is-solid" onClick={copy}>Copiar código Pix</button>
              <button type="button" onClick={() => check(true)}>Já paguei</button>
            </div>
            <small>⏳ Aguardando pagamento · expira em {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}</small>
            <small>Assim que o Pix cair, esta tela confirma sozinha.</small>
          </article>
        ) : (
          <article className="aff-pref">
            {expired ? <p className="aff-config-error">⏱️ Esse Pix expirou sem pagamento. Gere um novo abaixo.</p> : null}
            <label>Período
              <select value={cycle} onChange={(event) => setCycle(event.target.value)}>
                {CYCLES.filter(([key]) => data.plan.prices[key] != null).map(([key, label]) => <option key={key} value={key}>{label} · {money(Number(data.plan.prices[key]))}</option>)}
              </select>
            </label>
            {data.provider === "pagbank" ? (
              <label>CPF ou CNPJ de quem paga<input inputMode="numeric" value={taxId} placeholder={data.taxIdHint || "000.000.000-00"} onChange={(event) => setTaxId(event.target.value)} /></label>
            ) : null}
            <label>Cupom (opcional)<input value={coupon} onChange={(event) => setCoupon(event.target.value.toUpperCase())} /></label>
            <small>{data.taxIdHint ? "Em branco usa o CPF/CNPJ já informado. " : ""}O PagBank exige o documento de quem paga.</small>
            <div className="aff-conn__actions">
              <button type="button" className="is-solid" disabled={busy} onClick={pay}>{busy ? "Gerando Pix…" : "Pagar com Pix"}</button>
            </div>
          </article>
        )}

        {data.history.length ? (
          <article className="aff-pref">
            <strong>Pagamentos</strong>
            {data.history.map((item) => <small key={item.id}>{day(item.paidAt)} · {money(item.amountCents)} · {cycleName(item.cycle)}</small>)}
          </article>
        ) : null}
      </div>
    </section>
  );
}
