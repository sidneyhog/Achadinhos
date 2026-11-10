import { useEffect, useState } from "react";
import { api } from "./api";

/**
 * Tela Publicações: tudo o que o robô publicou, com filtros que também servem de destino para os cartões
 * do painel (Publicadas hoje, Cliques hoje, Melhor loja...). Os filtros ficam no endereço da página.
 */
export type PostFilter = { by: string; period: string; store: string; dest: string; status: string; q: string; sort: string };
export const POST_FILTER_DEFAULT: PostFilter = { by: "posts", period: "7d", store: "", dest: "", status: "", q: "", sort: "recent" };

export const readFilter = (search: string): PostFilter => {
  const params = new URLSearchParams(search);
  const out = { ...POST_FILTER_DEFAULT };
  (Object.keys(out) as Array<keyof PostFilter>).forEach((key) => {
    const value = params.get(key);
    if (value != null) out[key] = value;
  });
  return out;
};

export const filterHref = (base: string, filter: Partial<PostFilter>) => {
  const params = new URLSearchParams();
  const full = { ...POST_FILTER_DEFAULT, ...filter };
  (Object.keys(full) as Array<keyof PostFilter>).forEach((key) => {
    if (full[key] && full[key] !== POST_FILTER_DEFAULT[key]) params.set(key, full[key]);
  });
  const query = params.toString();
  return query ? `${base}?${query}` : base;
};

/** Destino de uma publicação no formato do filtro: Status, Telegram ou o grupo. */
export const destOf = (groupJid: string) => (groupJid === "status@broadcast" ? "status" : String(groupJid || "").startsWith("telegram:") ? "telegram" : groupJid);

const money = (cents: number) => (Number(cents || 0) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const when = (iso: string) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const PERIODS: Array<[string, string]> = [["today", "Hoje"], ["7d", "7 dias"], ["30d", "30 dias"], ["all", "Tudo"]];
const PERIOD_LABEL: Record<string, string> = { today: "hoje", "7d": "nos últimos 7 dias", "30d": "nos últimos 30 dias", all: "desde o início" };

export function PostsView({ search, stores, onFilter }: {
  search: string;
  stores: Array<{ id: string; label: string; logo: string }>;
  onFilter: (filter: Partial<PostFilter>) => void;
}) {
  const filter = readFilter(search);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState(filter.q);
  const storeLabel = (id: string) => stores.find((store) => store.id === id)?.label || id;
  const set = (patch: Partial<PostFilter>) => onFilter({ ...filter, ...patch });

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    setError("");
    api<any>(`/api/posts/search${search || ""}`)
      .then((body) => { if (!cancel) setData(body); })
      .catch((err) => { if (!cancel) setError(err instanceof Error ? err.message : "Não foi possível carregar as publicações."); })
      .finally(() => { if (!cancel) setLoading(false); });
    return () => { cancel = true; };
  }, [search]);

  useEffect(() => { setText(filter.q); }, [filter.q]);

  const summary = data?.summary || { posts: 0, sent: 0, errors: 0, clicks: 0 };
  const destName = (row: any) => (row.group_jid === "status@broadcast" ? "Status do WhatsApp" : String(row.group_jid || "").startsWith("telegram:") ? `Telegram · ${row.group_name || ""}` : row.group_name || row.group_jid);
  const chips: Array<[string, () => void]> = [];
  if (filter.store) chips.push([`Loja: ${storeLabel(filter.store)}`, () => set({ store: "" })]);
  if (filter.dest) {
    const row = (data?.byDest || []).find((item: any) => destOf(item.group_jid) === filter.dest);
    chips.push([`Destino: ${row ? destName(row) : filter.dest === "status" ? "Status" : filter.dest === "telegram" ? "Telegram" : "grupo"}`, () => set({ dest: "" })]);
  }
  if (filter.status) chips.push([filter.status === "error" ? "Só com erro" : "Só enviadas", () => set({ status: "" })]);
  if (filter.q) chips.push([`Busca: ${filter.q}`, () => set({ q: "" })]);
  if (filter.by === "clicks") chips.push(["Só o que recebeu cliques", () => set({ by: "posts" })]);

  return (
    <section className="aff-block aff-posts">
      <header className="aff-posts__head">
        <div>
          <h2>Publicações</h2>
          <p>{filter.by === "clicks" ? `Ofertas que receberam cliques ${PERIOD_LABEL[filter.period]}, da mais clicada para a menos.` : `Tudo o que o robô publicou ${PERIOD_LABEL[filter.period]}. Toque num número ou numa loja para filtrar.`}</p>
        </div>
        <div className="aff-filters">
          {PERIODS.map(([id, label]) => <button key={id} type="button" className={filter.period === id ? "is-on" : ""} onClick={() => set({ period: id })}>{label}</button>)}
        </div>
      </header>

      <div className="aff-metrics aff-posts__sum">
        {[
          ["Publicações", summary.posts, filter.by === "posts" && !filter.status, () => set({ by: "posts", status: "" })],
          ["Enviadas", summary.sent, filter.by === "posts" && filter.status === "sent", () => set({ by: "posts", status: "sent" })],
          ["Com erro", summary.errors, filter.status === "error", () => set({ by: "posts", status: "error" })],
          ["Cliques", summary.clicks, filter.by === "clicks", () => set({ by: "clicks", status: "" })]
        ].map(([label, value, on, click]) => (
          <button key={String(label)} type="button" className={`aff-metric${on ? " is-on" : ""}`} onClick={click as () => void}>
            <span>{label as string}</span><strong>{Number(value || 0).toLocaleString("pt-BR")}</strong>
          </button>
        ))}
      </div>

      <div className="aff-posts__bar">
        <form onSubmit={(event) => { event.preventDefault(); set({ q: text.trim() }); }}>
          <input value={text} onChange={(event) => setText(event.target.value)} placeholder="Buscar pelo nome do produto" />
        </form>
        <div className="aff-filters">
          {[["recent", "Mais recentes"], ["clicks", "Mais clicadas"]].map(([id, label]) => <button key={id} type="button" className={(filter.by === "clicks" ? "clicks" : filter.sort) === id ? "is-on" : ""} onClick={() => set({ sort: id })}>{label}</button>)}
        </div>
      </div>

      {chips.length ? (
        <div className="aff-posts__chips">
          {chips.map(([label, clear]) => <button key={label} type="button" onClick={clear}>{label} <b aria-hidden="true">×</b></button>)}
          <button type="button" className="is-clear" onClick={() => onFilter({ period: filter.period })}>Limpar filtros</button>
        </div>
      ) : null}

      <div className="aff-posts__split">
        <aside>
          <h3>Por loja</h3>
          {(data?.byStore || []).map((row: any) => (
            <button key={row.marketplace} type="button" className={filter.store === row.marketplace ? "is-on" : ""} onClick={() => set({ store: filter.store === row.marketplace ? "" : row.marketplace })}>
              <span>{storeLabel(row.marketplace)}</span><small>{row.posts} publ. · {row.clicks} cliques</small>
            </button>
          ))}
          <h3>Por destino</h3>
          {(data?.byDest || []).map((row: any) => {
            const dest = destOf(row.group_jid);
            return (
              <button key={row.group_jid} type="button" className={filter.dest === dest ? "is-on" : ""} onClick={() => set({ dest: filter.dest === dest ? "" : dest })}>
                <span>{destName(row)}</span><small>{row.posts} publ. · {row.clicks} cliques</small>
              </button>
            );
          })}
        </aside>

        <div className="aff-posts__list">
          {error ? <p className="aff-config-error">{error}</p> : null}
          {loading && !data ? <p>Carregando…</p> : null}
          {(data?.posts || []).map((post: any) => (
            <article key={post.id} className={post.status === "error" ? "is-error" : ""}>
              {post.image_url ? <img src={post.image_url} alt="" loading="lazy" /> : <img src={`/deals-logos/${stores.find((store) => store.id === post.marketplace)?.logo || "ml.svg"}`} alt="" />}
              <div>
                <strong>{post.title}</strong>
                <p>{storeLabel(post.marketplace)} · {money(post.price_cents)} · {destName(post)} · {when(post.created_at)}</p>
                {post.status === "error" ? <p className="aff-config-error">{post.error || "Não foi enviada"}</p> : null}
              </div>
              <div className="aff-posts__clicks">
                <b>{post.clicks}</b>
                <small>{post.clicks === 1 ? "clique" : "cliques"} {filter.period === "all" ? "" : PERIOD_LABEL[filter.period]}</small>
                {post.click_count > post.clicks ? <small>{post.click_count} no total</small> : null}
                {post.url && post.status === "sent" ? <a href={post.url} target="_blank" rel="noreferrer">Abrir oferta</a> : null}
              </div>
            </article>
          ))}
          {data && !(data.posts || []).length ? (
            <div className="aff-empty">
              <strong>Nada por aqui com esses filtros</strong>
              <p>{filter.by === "clicks" ? "Nenhuma oferta recebeu clique nesse período. Os cliques são contados pelo link do Achadinhos desde 10/11/2026." : "Troque o período ou limpe os filtros."}</p>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
