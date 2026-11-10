import axios from "axios";

/**
 * Fontes da Amazon: canais públicos do Telegram que postam promoções. O Telegram mostra as últimas postagens
 * de qualquer canal público em https://t.me/s/<canal>, sem login. O robô lê essas páginas, separa as postagens
 * com produto da Amazon e preço, e põe numa fila central. Cada empresa publica dessa fila com a própria tag.
 * O site da Amazon nunca é acessado: o produto (ASIN) sai do link da postagem, e o link curto amzn.to só é
 * seguido até o primeiro redirecionamento, que já traz o endereço do produto.
 */

export type SourcePost = {
  source: string;
  postId: string;
  postedAt: number;
  title: string;
  priceCents: number;
  originalPriceCents: number | null;
  imageUrl: string | null;
  links: string[];
};

/** Nome do canal a partir do que for colado: t.me/nome, https://t.me/s/nome, @nome ou nome. */
export const channelName = (raw: string) => {
  const value = String(raw || "").trim().replace(/^https?:\/\//i, "").replace(/^(www\.)?t(elegram)?\.me\/(s\/)?/i, "").replace(/^@/, "");
  const name = value.split(/[/?#\s]/)[0];
  return /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(name) ? name.toLowerCase() : "";
};

/** Lista de canais do super admin (uma por linha ou separada por vírgula), sem repetir, até 30. */
export const channelList = (raw: string) =>
  [...new Set(String(raw || "").split(/[\n,;]+/).map(channelName).filter(Boolean))].slice(0, 30);

const decode = (html: string) =>
  html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;/gi, "'")
    .replace(/&#036;|&#x24;/gi, "$")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));

const toCents = (raw: string) => {
  const clean = raw.replace(/\s/g, "");
  // 1.234,56 | 1234,56 | 1.234 | 229 (sem centavos)
  const normalized = /,\d{1,2}$/.test(clean) ? clean.replace(/\./g, "").replace(",", ".") : clean.replace(/\./g, "");
  const value = Number(normalized);
  return Number.isFinite(value) && value > 0 && value < 1_000_000 ? Math.round(value * 100) : 0;
};

const PRICE = /R\$\s?([\d.]+(?:,\d{1,2})?)/gi;

/**
 * Preço da postagem. "De R$ X por R$ Y" vira original e preço; sem isso, o menor valor que não seja de cupom
 * ("R$ 20 OFF", "cupom de R$ 50", "acima de R$ 199") é o preço. Exportada para teste.
 */
export const readPrices = (text: string): { priceCents: number; originalPriceCents: number | null } => {
  let original = 0;
  let now = 0;
  const candidates: number[] = [];
  for (const match of text.matchAll(PRICE)) {
    const before = text.slice(Math.max(0, (match.index || 0) - 18), match.index || 0).toLowerCase();
    const after = text.slice((match.index || 0) + match[0].length, (match.index || 0) + match[0].length + 14).toLowerCase();
    // Valor de cupom, frete ou cashback não é preço ("cupom de R$ 1000 OFF", "acima de R$ 99").
    if (/off|desconto|de volta|cashback/.test(after) || /cupom|acima de|compras? (de|acima)|ganhe|frete/.test(before)) continue;
    const cents = toCents(match[1]);
    if (!cents) continue;
    if (/\bde:?\s*$/.test(before)) original ||= cents;
    else if (/\b(por|apenas|sai(ndo)? por|só|pix|à vista):?\s*$/.test(before)) now ||= cents;
    else candidates.push(cents);
  }
  const priceCents = now || (candidates.length ? Math.min(...candidates) : 0);
  return { priceCents, originalPriceCents: priceCents && original > priceCents ? original : null };
};

/** Nome do produto: a primeira linha com texto de verdade, sem enfeites nem chamadas de oferta. Exportada para teste. */
export const readTitle = (text: string) => {
  for (const line of text.split("\n")) {
    const clean = line
      .replace(/https?:\/\/\S+/g, "")
      .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "")
      .replace(/^[\s\-–•*|:>»]+|[\s\-–•*|:]+$/g, "")
      .trim();
    if (clean.length < 8 || /R\$/.test(clean)) continue;
    if (/^(oferta|promo(ção)?|corre|achadinho|imperd[ií]vel|bug|cupom|link|compre aqui|confira|aproveite)\b/i.test(clean) && clean.length < 25) continue;
    return clean.slice(0, 140);
  }
  return "";
};

/** Postagens da página t.me/s/<canal>. Exportada para teste. */
export const readChannelPage = (html: string, source: string): SourcePost[] => {
  const posts: SourcePost[] = [];
  const blocks = String(html || "").split(/<div class="tgme_widget_message_wrap/).slice(1);
  for (const block of blocks) {
    const id = block.match(/data-post="([^"]+)"/)?.[1] || "";
    const textHtml = block.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1] || "";
    if (!id || !textHtml) continue;
    const text = decode(textHtml);
    const hrefs = [...textHtml.matchAll(/href="([^"]+)"/g)].map(match => decode(match[1]));
    const inText = text.match(/https?:\/\/\S+/g) || [];
    const links = [...new Set([...hrefs, ...inText])].filter(link => /amzn\.to\/|amazon\.com\.br\//i.test(link));
    if (!links.length) continue;
    const { priceCents, originalPriceCents } = readPrices(text);
    const title = readTitle(text);
    const when = Date.parse(block.match(/<time[^>]+datetime="([^"]+)"/)?.[1] || "");
    const image = block.match(/tgme_widget_message_photo_wrap[^>]*background-image:url\('([^']+)'\)/)?.[1] || null;
    posts.push({
      source,
      postId: id,
      postedAt: Number.isFinite(when) ? when : 0,
      title,
      priceCents,
      originalPriceCents,
      imageUrl: image && /^https:\/\/[\w.-]*telesco\.pe\//.test(image) ? image : null,
      links
    });
  }
  return posts;
};

/** ASIN de um endereço da Amazon (/dp/, /gp/product/, /gp/aw/d/). Página de categoria ou busca não tem. Exportada para teste. */
export const asinFromUrl = (url: string) =>
  String(url || "").match(/amazon\.com\.br\/(?:[^?#]*\/)?(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i)?.[1]?.toUpperCase() || "";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
const shortLinks = new Map<string, string>();

/** amzn.to → endereço do produto, seguindo só o redirecionamento do encurtador (o site da Amazon não é aberto). */
export const resolveAsin = async (link: string): Promise<string> => {
  const direct = asinFromUrl(link);
  if (direct) return direct;
  if (!/^https?:\/\/amzn\.to\/[A-Za-z0-9]+/i.test(link)) return "";
  const cached = shortLinks.get(link);
  if (cached != null) return cached;
  let asin = "";
  try {
    const response = await axios.get(link, { maxRedirects: 0, validateStatus: status => status >= 300 && status < 400, timeout: 10000, headers: { "User-Agent": UA } });
    asin = asinFromUrl(String(response.headers.location || ""));
  } catch {
    asin = "";
  }
  shortLinks.set(link, asin);
  if (shortLinks.size > 5000) shortLinks.delete(shortLinks.keys().next().value as string);
  return asin;
};

/** Lê um canal público. */
export const fetchChannel = async (source: string): Promise<SourcePost[]> => {
  const { data } = await axios.get(`https://t.me/s/${source}`, {
    timeout: 20000,
    responseType: "text",
    maxRedirects: 0,
    validateStatus: status => status === 200,
    headers: { "User-Agent": UA, Accept: "text/html", "Accept-Language": "pt-BR" }
  });
  return readChannelPage(String(data), source);
};
