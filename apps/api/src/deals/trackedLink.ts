/**
 * Link rastreado do Achadinhos: a mensagem leva /go/<token> e o clique é contado antes de ir para a loja.
 * O destino é sempre o `url` gravado na própria publicação: o link de afiliado daquela empresa, montado
 * na hora do envio. O redirecionamento não monta nada novo, então não tem como cair em outra loja ou
 * em outro afiliado.
 */
export const trackedUrl = (base: string, token: string) => `${String(base || "").replace(/\/+$/, "")}/go/${token}`;

/** Endereço público só vale com http(s) e sem caminho estranho; vazio desliga o link rastreado. */
export const publicBase = (raw: string) => {
  const value = String(raw || "").trim().replace(/\/+$/, "");
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) ? url.origin : "";
  } catch {
    return "";
  }
};

/** Pré-visualizações e robôs abrem links sem ser gente: não contam como clique. */
const BOTS = /bot|crawl|spider|slurp|facebookexternalhit|facebookcatalog|^WhatsApp\/|preview|curl|wget|python|httpclient|axios|node-fetch|go-http|java\/|headless|monitor|uptime/i;

export const countsAsClick = (method: string, userAgent: string) =>
  method === "GET" && Boolean(userAgent) && !BOTS.test(userAgent);

/** Só redireciona para http(s); qualquer outra coisa gravada por engano não sai daqui. */
export const redirectTarget = (url: string | null | undefined) => {
  try {
    const parsed = new URL(String(url || ""));
    return /^https?:$/.test(parsed.protocol) ? parsed.toString() : null;
  } catch {
    return null;
  }
};
