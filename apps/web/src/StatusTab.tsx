import { useEffect, useState } from "react";
import { api } from "./api";

type Store = { id: string; label: string; logo: string };
type Post = { group_jid?: string; status?: string; whatsapp_id?: number | string; marketplace?: string; created_at?: string; title?: string; error?: string };

type Props = {
  conn: any;
  stores: Store[];
  posts: Post[];
  activeGroups: number;
  ago: (iso?: string | null) => string;
  speakWait: (seconds: number) => string;
  onSaved: () => Promise<void>;
  tell: (title: string, text: string, tone?: "ok" | "bad") => void;
};

const STATUS_JID = "status@broadcast";
const DEFAULT_WAIT = 3600;

/** Aba "Status" da conexão: mesmos controles dos grupos (lojas, intervalo por loja, ofertas por vez) + máximo por dia. */
export function StatusTab({ conn, stores, posts, activeGroups, ago, speakWait, onSaved, tell }: Props) {
  const saved = conn.status_cadence && Object.keys(conn.status_cadence).length ? conn.status_cadence : {};
  const [enabled, setEnabled] = useState<boolean>(Boolean(conn.status_enabled));
  const [chosen, setChosen] = useState<string[]>(Array.isArray(conn.status_stores) ? conn.status_stores : []);
  const [cadence, setCadence] = useState<Record<string, number>>(() =>
    Object.fromEntries(stores.map((store) => [store.id, Number(saved[store.id]) > 0 ? Number(saved[store.id]) : DEFAULT_WAIT]))
  );
  const [perCycle, setPerCycle] = useState<number | "">(conn.status_per_cycle ?? 1);
  const [perDay, setPerDay] = useState<number | "">(conn.status_per_day ?? 6);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const mine = posts.filter((post) => post.group_jid === STATUS_JID && Number(post.whatsapp_id) === conn.id);
  const sent = mine.filter((post) => post.status === "sent").sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  const today = Number(conn.status_today ?? sent.filter((post) => new Date(String(post.created_at)).toDateString() === new Date().toDateString()).length);
  const lastError = mine.filter((post) => post.status === "error").sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))[0];
  const showError = lastError && (!sent[0] || String(lastError.created_at) > String(sent[0].created_at));
  const lastOf = (store: string) => sent.find((post) => post.marketplace === store)?.created_at || null;
  const active = (id: string) => !chosen.length || chosen.includes(id);
  const shown = stores.filter((store) => active(store.id));
  const limit = Number(perDay) || 6;

  const nextOf = (store: string) => {
    if (!conn.status_enabled) return "desligado";
    if (conn.status !== "connected") return "WhatsApp desconectado";
    if (today >= limit) return "amanhã (limite do dia atingido)";
    const last = lastOf(store);
    if (!last) return "na próxima busca";
    const left = Math.ceil((cadence[store] ?? DEFAULT_WAIT) - (Date.now() - new Date(last).getTime()) / 1000);
    return left > 0 ? `em ${speakWait(left)}` : "na próxima busca";
  };

  const change = () => { setNote(""); setDirty(true); };
  const setPart = (id: string, part: "minutes" | "seconds", raw: string) => {
    const total = cadence[id] ?? DEFAULT_WAIT;
    const minutes = part === "minutes" ? Math.min(1440, Math.max(0, Number(raw) || 0)) : Math.floor(total / 60);
    const seconds = part === "seconds" ? Math.min(59, Math.max(0, Number(raw) || 0)) : total % 60;
    change();
    setCadence({ ...cadence, [id]: minutes * 60 + seconds });
  };

  const save = async (nextEnabled = enabled) => {
    const problems: string[] = [];
    for (const store of shown) if ((cadence[store.id] ?? 0) < 15) problems.push(`${store.label}: o intervalo mínimo é 15 segundos.`);
    if (perCycle === "" || perCycle < 1 || perCycle > 5) problems.push("Ofertas por vez: de 1 a 5.");
    if (perDay === "" || perDay < 1 || perDay > 30) problems.push("Máximo por dia: de 1 a 30.");
    if (problems.length) return setNote(problems.join(" "));
    setSaving(true);
    try {
      await api(`/api/connections/${conn.id}`, {
        method: "PATCH",
        body: JSON.stringify({ statusEnabled: nextEnabled, statusStores: chosen, statusCadence: cadence, statusPerCycle: perCycle, statusPerDay: perDay })
      });
      setEnabled(nextEnabled);
      setDirty(false);
      await onSaved();
      tell("Salvo", nextEnabled ? "As ofertas vão para o Status desta conexão." : "O Status desta conexão está desligado.");
    } catch (err) {
      tell("Não salvou", err instanceof Error ? err.message : "Não foi possível salvar o Status", "bad");
    } finally {
      setSaving(false);
    }
  };

  const on = Boolean(conn.status_enabled);
  return (
    <div className="aff-prefs">
      <div className={`aff-wastate ${on ? "is-on" : "is-qr"}`}>
        <strong>{on ? "Status LIGADO" : "Status DESLIGADO"}</strong>
        <span>
          {on
            ? `Hoje: ${today} de ${conn.status_per_day ?? 6} publicações. Último Status: ${conn.status_last_at || sent[0] ? ago(conn.status_last_at || sent[0].created_at) : "ainda não"}.`
            : "Nada vai para o Status desta conexão. Ligue abaixo para publicar as ofertas também lá."}
        </span>
      </div>
      {showError ? <p className="aff-config-error">Última falha no Status ({ago(lastError.created_at)}): {String(lastError.error || "").replace(/^Status:\s*/, "")}</p> : null}
      <div className="aff-conn__actions">
        <button type="button" className={on ? "" : "is-solid"} disabled={saving} onClick={() => save(!on)}>{on ? "Desligar Status" : "Ligar Status"}</button>
      </div>
      <p className="aff-note">
        Só texto, no formato curto, com a prévia do link. Quem vê: participantes dos {activeGroups} grupo(s) ativos desta conexão e os contatos da Base. O WhatsApp só mostra para quem tem o seu número salvo.
      </p>

      <p><strong>Lojas</strong> (nenhuma marcada = todas as ativas)</p>
      <div className="aff-filters">
        {stores.map((store) => (
          <button key={store.id} type="button" className={chosen.includes(store.id) ? "is-on" : ""} onClick={() => {
            change();
            setChosen(chosen.includes(store.id) ? chosen.filter((id) => id !== store.id) : [...chosen, store.id]);
          }}>{store.label}</button>
        ))}
      </div>
      {shown.map((store) => {
        const total = cadence[store.id] ?? DEFAULT_WAIT;
        const last = lastOf(store.id);
        return (
          <article key={store.id} className="aff-sendcard">
            <img src={`/deals-logos/${store.logo}`} alt="" />
            <div><strong>{store.label}</strong><p>Último Status: {last ? ago(last) : "ainda não"}</p><p>Próximo: {nextOf(store.id)}</p></div>
            <div className="aff-sendcard__time">
              <span>Intervalo</span>
              <label>minutos<input type="number" min="0" max="1440" value={Math.floor(total / 60)} onChange={(event) => setPart(store.id, "minutes", event.target.value)} /></label>
              <label>segundos<input type="number" min="0" max="59" value={total % 60} onChange={(event) => setPart(store.id, "seconds", event.target.value)} /></label>
              <small className={total < 15 ? "is-bad" : ""}>Mínimo de 15 segundos.</small>
            </div>
          </article>
        );
      })}
      <article className="aff-pref">
        <label>Ofertas por vez<input type="number" min="1" max="5" value={perCycle} onChange={(event) => { change(); setPerCycle(event.target.value === "" ? "" : Number(event.target.value)); }} /></label>
        <small>Quantas ofertas de cada loja vão para o Status quando o intervalo vence.</small>
      </article>
      <article className="aff-pref">
        <label>Máximo por dia<input type="number" min="1" max="30" value={perDay} onChange={(event) => { change(); setPerDay(event.target.value === "" ? "" : Number(event.target.value)); }} /></label>
        <small>Somando todas as lojas. Zera à meia-noite (horário de Brasília).</small>
      </article>
      {note ? <p className="aff-config-error">{note}</p> : null}
      <div className="aff-conn__actions">
        <button type="button" className="is-solid" disabled={saving || !dirty} onClick={() => save()}>{saving ? "Salvando…" : dirty ? "Salvar alterações" : "Tudo salvo"}</button>
      </div>
    </div>
  );
}
