/**
 * Pagamento manual por período do plano, enquanto a API de cobrança não está liberada (conta PF / homologação
 * pendente, 11/2026). Aceita:
 *  - link de pagamento do PagBank (Pix, cartão ou boleto na página deles), ou
 *  - código Pix copia e cola de valor fixo (ex.: cobrança gerada no app do Nubank).
 * Nenhum dos dois avisa o sistema quando é pago: o super admin confirma em Pagamentos.
 */
const PAY_LINK_HOSTS = ["pagbank.com.br", "pagseguro.uol.com.br", "pagseguro.com.br", "pag.ae", "nubank.com.br"];
export const PAY_LINK_CYCLES = ["monthly", "quarterly", "semiannual", "yearly"];

/** CRC16-CCITT (0xFFFF) usado no fim do Pix copia e cola (campo 63). */
const crc16 = (text: string) => {
  let crc = 0xffff;
  for (const byte of Buffer.from(text, "utf8")) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
};

/** Código Pix copia e cola válido (começa em 000201, é Pix e o CRC confere). */
export const isPixCode = (value: string) => {
  const code = value.trim();
  if (!/^000201/.test(code) || !/br\.gov\.bcb\.pix/i.test(code) || code.length < 50 || code.length > 600) return false;
  const tail = code.slice(-8);
  if (!/^6304[0-9A-Fa-f]{4}$/.test(tail)) return false;
  return crc16(code.slice(0, -4)) === tail.slice(-4).toUpperCase();
};

/** "" quando vazio; o link (https do PagBank/Nubank) ou o código Pix quando válido; null quando inválido. */
export const payLinkOf = (value: unknown): string | null => {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (text.startsWith("000201")) return isPixCode(text) ? text : null;
  try {
    const url = new URL(text);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || !PAY_LINK_HOSTS.some(item => host === item || host.endsWith(`.${item}`))) return null;
    return url.toString();
  } catch {
    return null;
  }
};

/** Links/códigos por período; null se algum for inválido (o painel mostra o erro em vez de gravar calado). */
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
