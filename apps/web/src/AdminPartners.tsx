import { Fragment, useState } from "react";
import { api } from "./api";

const money = (cents: number) => (Number(cents || 0) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const day = (iso?: string | null) => iso ? new Date(iso).toLocaleDateString("pt-BR") : "—";
const reaisToCents = (raw: string) => {
  const text = raw.trim().replace(/\s/g, "");
  if (!text) return null;
  const value = Number(text.includes(",") ? text.replace(/\./g, "").replace(",", ".") : text);
  return Number.isFinite(value) ? Math.round(value * 100) : null;
};

type Props = {
  partners: any[];
  run: (title: string, text: string, job: () => Promise<unknown>) => Promise<boolean>;
  tell: (title: string, text: string, tone?: "ok" | "bad") => void;
};

/** Parceiros (ADMs de grupo, indicadores): código, empresas ligadas, comissão a pagar e pagamentos feitos. */
export function AdminPartners({ partners, run, tell }: Props) {
  const [open, setOpen] = useState<number | null>(null);
  const [info, setInfo] = useState<{ companies: any[]; commissions: any[]; payouts: any[] } | null>(null);
  const balance = (p: any) => Number(p.earned_cents || 0) - Number(p.paid_cents || 0);
  const totalDue = partners.reduce((sum, p) => sum + Math.max(0, balance(p)), 0);
  const linkOf = (code: string) => `${window.location.origin}/cadastro?ref=${encodeURIComponent(code)}`;

  const show = async (id: number) => {
    if (open === id) { setOpen(null); return; }
    setOpen(id);
    setInfo(null);
    try {
      setInfo(await api(`/api/admin/partners/${id}`));
    } catch (err) {
      tell("Não carregou", err instanceof Error ? err.message : "Falha", "bad");
    }
  };

  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(linkOf(code));
      tell("Copiado", "Link de indicação copiado. Mande para o parceiro.");
    } catch {
      tell("Link do parceiro", linkOf(code));
    }
  };

  return (
    <>
      <section className="sx-stats">
        <article className="sx-stat is-active"><span>Parceiros ativos</span><strong>{partners.filter((p) => p.active).length}</strong></article>
        <article className="sx-stat is-trial"><span>Clientes indicados</span><strong>{partners.reduce((sum, p) => sum + Number(p.companies || 0), 0)}</strong></article>
        <article className="sx-stat is-active"><span>Indicados pagando</span><strong>{partners.reduce((sum, p) => sum + Number(p.active_companies || 0), 0)}</strong></article>
        <article className="sx-stat is-suspended"><span>Comissão do mês</span><strong>{money(partners.reduce((sum, p) => sum + Number(p.earned_month_cents || 0), 0))}</strong></article>
        <article className="sx-stat is-blocked"><span>A pagar</span><strong>{money(totalDue)}</strong></article>
      </section>

      <article className="sx-card">
        <div className="sx-card__head"><h2>Novo parceiro</h2></div>
        <p className="sx-note">Cada parceiro ganha um código. Quem se cadastrar com o link ou o código fica ligado a ele, e cada pagamento dessa empresa gera a comissão. Parou de pagar, para de gerar.</p>
        <form className="sx-form" onSubmit={async (event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = new FormData(form);
          const ok = await run("Criado", "O parceiro foi cadastrado.", () => api("/api/admin/partners", { method: "POST", body: JSON.stringify({
            name: data.get("name"), phone: data.get("phone"), code: data.get("code"), percent: data.get("percent"), notes: data.get("notes")
          }) }));
          if (ok) form.reset();
        }}>
          <label>Nome<input name="name" required placeholder="Fulano (ADM Desapega Rio Claro)" /></label>
          <label>WhatsApp<input name="phone" inputMode="tel" placeholder="19 99999-9999" /></label>
          <label>Código<input name="code" required placeholder="RIOCLARO" onChange={(event) => { event.target.value = event.target.value.toUpperCase(); }} /></label>
          <label>Comissão (%)<input name="percent" required inputMode="numeric" defaultValue="20" /></label>
          <label className="is-wide">Observações<input name="notes" placeholder="Combinado: paga todo dia 10" /></label>
          <div><button className="sx-btn is-solid" type="submit">Salvar parceiro</button></div>
        </form>
      </article>

      <div className="sx-tablewrap">
        <table className="sx-table">
          <thead><tr><th>Parceiro</th><th>Código</th><th>%</th><th>Clientes</th><th>Mês</th><th>Total</th><th>Pago</th><th>A pagar</th><th></th></tr></thead>
          <tbody>{partners.map((p) => (
            <Fragment key={p.id}>
              <tr>
                <td><strong>{p.name}</strong>{p.active ? null : <small> · pausado</small>}{p.phone ? <><br /><small>{p.phone}</small></> : null}</td>
                <td><span className="sx-code">{p.code}</span></td>
                <td>{p.percent}%</td>
                <td>{p.active_companies} pagando / {p.companies}</td>
                <td>{money(p.earned_month_cents)}</td>
                <td>{money(p.earned_cents)}</td>
                <td>{money(p.paid_cents)}</td>
                <td><strong>{money(balance(p))}</strong></td>
                <td>
                  <button type="button" className="sx-btn" onClick={() => copy(p.code)}>Copiar link</button>{" "}
                  <button type="button" className="sx-btn" onClick={() => show(p.id)}>{open === p.id ? "Fechar" : "Detalhes"}</button>
                </td>
              </tr>
              {open === p.id ? (
                <tr>
                  <td colSpan={9}>
                    <p className="sx-note">Link de indicação: <span className="sx-code">{linkOf(p.code)}</span></p>
                    <form className="sx-form" onSubmit={async (event) => {
                      event.preventDefault();
                      const form = event.currentTarget;
                      const data = new FormData(form);
                      const cents = reaisToCents(String(data.get("amount") || ""));
                      if (!cents) { tell("Valor", "Informe o valor pago ao parceiro.", "bad"); return; }
                      const ok = await run("Registrado", `Pagamento a ${p.name} registrado.`, () => api(`/api/admin/partners/${p.id}/payouts`, { method: "POST", body: JSON.stringify({ amountCents: cents, note: data.get("note") }) }));
                      if (ok) { form.reset(); setInfo(await api(`/api/admin/partners/${p.id}`)); }
                    }}>
                      <label>Paguei ao parceiro (R$)<input name="amount" placeholder={(Math.max(0, balance(p)) / 100).toFixed(2).replace(".", ",")} /></label>
                      <label>Observação<input name="note" placeholder="Pix de outubro" /></label>
                      <div><button className="sx-btn is-solid" type="submit">Registrar pagamento</button></div>
                    </form>
                    <form className="sx-form" onSubmit={async (event) => {
                      event.preventDefault();
                      const data = new FormData(event.currentTarget);
                      await run("Salvo", "Parceiro atualizado.", () => api(`/api/admin/partners/${p.id}`, { method: "PATCH", body: JSON.stringify({ percent: data.get("percent"), phone: data.get("phone"), notes: data.get("notes") }) }));
                    }}>
                      <label>Comissão (%)<input name="percent" inputMode="numeric" defaultValue={p.percent} /></label>
                      <label>WhatsApp<input name="phone" defaultValue={p.phone} /></label>
                      <label className="is-wide">Observações<input name="notes" defaultValue={p.notes} /></label>
                      <div>
                        <button className="sx-btn is-solid" type="submit">Salvar</button>{" "}
                        <button type="button" className="sx-btn" onClick={() => run(p.active ? "Pausado" : "Ativado", p.active ? "Novos pagamentos deixam de gerar comissão para ele." : "Voltou a gerar comissão.", () => api(`/api/admin/partners/${p.id}`, { method: "PATCH", body: JSON.stringify({ active: !p.active }) }))}>{p.active ? "Pausar" : "Ativar"}</button>
                      </div>
                    </form>
                    <p className="sx-note">Mudar a porcentagem vale para os próximos pagamentos; o que já foi pago fica como estava.</p>
                    {!info ? <p className="sx-note">Carregando…</p> : (
                      <>
                        <h3>Clientes indicados</h3>
                        {info.companies.length ? (
                          <table className="sx-table">
                            <thead><tr><th>Empresa</th><th>Situação</th><th>Validade</th><th>Desde</th><th>Comissão gerada</th></tr></thead>
                            <tbody>{info.companies.map((c) => <tr key={c.id}><td>{c.name}</td><td>{c.sub_status === "active" && c.status === "active" ? "Pagando" : c.sub_status === "trialing" ? "Teste" : "Parada"}</td><td>{day(c.ends_at)}</td><td>{day(c.partner_since)}</td><td>{money(c.earned_cents)}</td></tr>)}</tbody>
                          </table>
                        ) : <p className="sx-note">Nenhum cliente com esse código ainda.</p>}
                        <h3>Comissões</h3>
                        {info.commissions.length ? (
                          <table className="sx-table">
                            <thead><tr><th>Data</th><th>Empresa</th><th>Pagamento</th><th>Comissão</th></tr></thead>
                            <tbody>{info.commissions.map((c) => <tr key={c.id}><td>{day(c.paid_at)}</td><td>{c.company}</td><td>{money(c.amount_cents)}{c.method === "manual" ? " (manual)" : ""}</td><td>{money(c.partner_cents)}</td></tr>)}</tbody>
                          </table>
                        ) : <p className="sx-note">Nenhum pagamento de cliente indicado ainda.</p>}
                        <h3>Pagamentos ao parceiro</h3>
                        {info.payouts.length ? (
                          <table className="sx-table">
                            <thead><tr><th>Data</th><th>Valor</th><th>Observação</th></tr></thead>
                            <tbody>{info.payouts.map((o) => <tr key={o.id}><td>{day(o.paid_at)}</td><td>{money(o.amount_cents)}</td><td>{o.note || "—"}</td></tr>)}</tbody>
                          </table>
                        ) : <p className="sx-note">Nenhum pagamento registrado.</p>}
                      </>
                    )}
                  </td>
                </tr>
              ) : null}
            </Fragment>
          ))}</tbody>
        </table>
        {!partners.length ? <div className="sx-empty"><strong>Nenhum parceiro</strong>Cadastre o primeiro ADM ou indicador acima.</div> : null}
      </div>
    </>
  );
}
