/** Começo do dia de hoje em São Paulo, para "hoje" no painel (o servidor roda em UTC). */
export const DAY_START = "(date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')";

export type PostFilter = {
  by: "posts" | "clicks";
  period: "today" | "7d" | "30d" | "all";
  store: string;
  dest: string;
  status: "" | "sent" | "error";
  q: string;
  sort: "recent" | "clicks";
};

const STORES = /^(ml|amazon|shopee|aliexpress|magalu|awin|rakuten|samsung|casasbahia|natura|paguemenos|epoca|terabyte|shein)$/;

/**
 * Filtros da tela Publicações, vindos da URL. Só aceita valores conhecidos: o resto vira o padrão.
 * O destino é "status", "telegram" ou o JID de um grupo do WhatsApp. Exportada para teste.
 */
export const readPostFilter = (raw: Record<string, unknown>): PostFilter => {
  const text = (value: unknown) => String(value ?? "").trim();
  const by = text(raw.by) === "clicks" ? "clicks" : "posts";
  const period = (["today", "7d", "30d", "all"] as const).find(item => item === text(raw.period)) || "7d";
  const store = STORES.test(text(raw.store)) ? text(raw.store) : "";
  const destRaw = text(raw.dest);
  const dest = destRaw === "status" || destRaw === "telegram" || /^[\w.-]+@g\.us$/.test(destRaw) ? destRaw : "";
  const status = text(raw.status) === "sent" ? "sent" : text(raw.status) === "error" ? "error" : "";
  const q = text(raw.q).replace(/[%_\\]/g, " ").slice(0, 80);
  const sort = text(raw.sort) === "clicks" ? "clicks" : "recent";
  return { by, period, store, dest, status, q, sort };
};
