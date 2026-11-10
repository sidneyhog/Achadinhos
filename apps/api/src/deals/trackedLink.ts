/**
 * Link rastreado do Achadinhos: a mensagem leva /<código curto> e o clique é contado antes de ir para a loja.
 * O destino é sempre o `url` gravado na própria publicação: o link de afiliado daquela empresa, montado
 * na hora do envio. O redirecionamento não monta nada novo, então não tem como cair em outra loja ou
 * em outro afiliado.
 */
export const trackedUrl = (base: string, token: string) => {
  const root = String(base || "").replace(/\/+$/, "");
  // Código curto fica na raiz (https://dominio/aB3x9Kp); os antigos, de 16 letras, continuam em /go/.
  return isShortCode(token) ? `${root}/${token}` : `${root}/go/${token}`;
};

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const SHORT_CODE_LENGTH = 7;

/** 7 caracteres com pelo menos um número: nunca bate com uma página do painel (/login, /vitrine...). */
export const isShortCode = (value: string) => /^(?=[A-Za-z]*[0-9])[0-9A-Za-z]{7}$/.test(String(value || ""));

/** Código antigo (16 hexadecimais) ou curto: é o que a rota de clique aceita. */
export const isClickToken = (value: string) => /^[0-9a-f]{16}$/.test(String(value || "")) || isShortCode(value);

/** Sorteia um código curto. `random` devolve bytes aleatórios (crypto.randomBytes). */
export const newShortCode = (random: (size: number) => Uint8Array) => {
  for (;;) {
    const bytes = random(SHORT_CODE_LENGTH * 2);
    let code = "";
    // Descarta bytes acima de 247 para não puxar o sorteio para as primeiras letras.
    for (const byte of bytes) {
      if (byte >= 248) continue;
      code += ALPHABET[byte % 62];
      if (code.length === SHORT_CODE_LENGTH) break;
    }
    if (isShortCode(code)) return code;
  }
};

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
