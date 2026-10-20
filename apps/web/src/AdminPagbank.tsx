import { useState } from "react";
import { api } from "./api";

type Props = {
  platform: { paymentProvider?: string; pagbankSet?: boolean; pagbankSandbox?: boolean; publicUrl?: string };
  run: (title: string, text: string, job: () => Promise<unknown>) => Promise<boolean>;
  tell: (title: string, text: string, tone?: "ok" | "bad") => void;
};

/** Integrações → PagBank: token, ambiente e se é a cobrança ativa da tela "Minha assinatura". */
export function AdminPagbank({ platform, run, tell }: Props) {
  const [token, setToken] = useState("");
  const [sandbox, setSandbox] = useState(platform.pagbankSandbox !== false);
  const [active, setActive] = useState(platform.paymentProvider === "pagbank");
  const [result, setResult] = useState<null | "ok" | "bad">(null);
  const on = platform.paymentProvider === "pagbank" && platform.pagbankSet;

  return (
    <section className="sx-efi">
      <article className="sx-card sx-efi__status">
        <span className={`sx-badge ${on ? "is-ok" : "is-off"}`}>{on ? "Cobrando pelo PagBank" : platform.pagbankSet ? "Token salvo, desligado" : "Não configurado"}</span>
        <strong>PagBank (Pix)</strong>
        <p className="sx-note">O cliente paga em "Minha assinatura" com o Pix gerado pelo PagBank. A confirmação é automática e a assinatura é liberada na hora.</p>
        <div className="sx-meta">
          <div><span>Token</span><b>{platform.pagbankSet ? "gravado" : "vazio"}</b></div>
          <div><span>Ambiente</span><b>{platform.pagbankSandbox !== false ? "Teste (sandbox)" : "Produção"}</b></div>
          <div><span>Site</span><b>{platform.publicUrl || window.location.origin}</b></div>
        </div>
        {result ? <div className={`sx-result is-${result}`}>{result === "ok" ? "O PagBank aceitou o token" : "O PagBank recusou"}</div> : null}
      </article>
      <article className="sx-card">
        <form className="sx-form" onSubmit={async (event) => {
          event.preventDefault();
          const ok = await run("Salvo", active ? "O PagBank é a cobrança ativa." : "PagBank gravado (desligado).", () => api("/api/admin/platform", { method: "PUT", body: JSON.stringify({
            pagbankToken: token, pagbankSandbox: sandbox, paymentProvider: active ? "pagbank" : (platform.paymentProvider === "pagbank" ? "" : platform.paymentProvider || ""), publicUrl: window.location.origin.startsWith("https://") ? window.location.origin : (platform.publicUrl || "")
          }) }));
          if (ok) setToken("");
        }}>
          <label className="is-wide">Token do PagBank<input type="password" value={token} placeholder={platform.pagbankSet ? "em branco mantém o atual" : "cole o token de integração"} onChange={(event) => setToken(event.target.value)} autoComplete="new-password" /></label>
          <label>Ambiente<select value={sandbox ? "sandbox" : "production"} onChange={(event) => setSandbox(event.target.value === "sandbox")}><option value="sandbox">Teste (sandbox)</option><option value="production">Produção (dinheiro de verdade)</option></select></label>
          <label>Cobrança ativa<select value={active ? "yes" : "no"} onChange={(event) => setActive(event.target.value === "yes")}><option value="yes">Sim, cobrar pelo PagBank</option><option value="no">Não</option></select></label>
          <p className="sx-note is-wide">O token de teste e o de produção são diferentes: use o token do mesmo ambiente escolhido.</p>
          <div className="sx-actions">
            <button className="sx-btn is-solid" type="submit">Salvar</button>
            <button type="button" className="sx-btn" onClick={async () => {
              try {
                await api("/api/admin/pagbank/test", { method: "POST" });
                setResult("ok");
                tell("PagBank", "O token foi aceito.");
              } catch (err) {
                setResult("bad");
                tell("PagBank", err instanceof Error ? err.message : "A conexão falhou", "bad");
              }
            }}>Testar conexão</button>
          </div>
        </form>
      </article>
    </section>
  );
}
