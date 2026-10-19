import axios from "axios";
import { createHash } from "node:crypto";
import { DealOffer } from "./types";
import { applyMlTracking, MlTracking } from "./mlAffiliate";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const discountOf = (priceCents: number, originalCents?: number): number | undefined => {
  if (!originalCents || originalCents <= priceCents) return undefined;
  return Math.round(((originalCents - priceCents) / originalCents) * 100);
};

const fold = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

const extractObject = (html: string, marker: string): any => {
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const start = html.indexOf("{", at);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < html.length; index += 1) {
    const char = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(html.slice(start, index + 1));
    }
  }
  return null;
};

const ENDING_SOON = /rel[aâ]mpago|acaba em|acaba hoje|últimas unidades|ultimas unidades|estoque baixo|por tempo limitado|termina em|s[oó] hoje|últimas horas|ultimas horas|hora rel/i;

export const offerEndsSoonText = (value: unknown): boolean =>
  ENDING_SOON.test(typeof value === "string" ? value : JSON.stringify(value || "").slice(0, 8000));

const soldOf = (text: string): number => {
  const mil = text.replace(/\./g, "").match(/(\d+)\s*mil/i);
  if (mil) return Number(mil[1]) * 1000;
  const plain = text.match(/(\d[\d.]*)/);
  if (!plain) return 0;
  return Number(plain[1].replace(/\./g, "")) || 0;
};

const cardToOffer = (card: any): DealOffer | null => {
  const id = String(card?.metadata?.id || "").trim();
  const rawUrl = String(card?.metadata?.url || "").trim();
  const components = Array.isArray(card?.components) ? card.components : [];
  const title = String(
    components.find((part: any) => part?.type === "title")?.title?.text || ""
  ).trim();
  const priceBlock = components.find((part: any) => part?.type === "price")?.price;
  const price = Number(priceBlock?.current_price?.value);
  if (!id || !title || !rawUrl || !Number.isFinite(price)) return null;
  const previous = Number(
    priceBlock?.price_labels?.[0]?.values?.find((value: any) => value?.key === "previous_price")
      ?.price?.value
  );
  const priceCents = Math.round(price * 100);
  const originalPriceCents =
    Number.isFinite(previous) && previous > price ? Math.round(previous * 100) : undefined;
  const review = components.find((part: any) => part?.type === "review_compacted");
  const ratingText = String(
    review?.review_compacted?.values?.find((value: any) => value?.key === "label")?.label?.text || ""
  );
  const soldText = String(review?.review_compacted?.alt_text || "");
  const shipping = components.find((part: any) => String(part?.type || "").startsWith("shipping"));
  const coupon = components.find((part: any) => part?.type === "promotions")?.promotions?.[0];
  const couponAmount = Number(
    coupon?.values?.find((value: any) => value?.type === "price")?.price?.value
  );
  const couponLabel = Number.isFinite(couponAmount)
    ? /off/i.test(String(coupon?.text || ""))
      ? `${couponAmount.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })} OFF`
      : couponAmount.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })
    : undefined;
  const picture = String(card?.pictures?.pictures?.[0]?.id || "");
  const permalink = rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`;
  return {
    externalId: id,
    title,
    priceCents,
    originalPriceCents,
    discountPercent: discountOf(priceCents, originalPriceCents),
    freeShipping: /gr[aá]tis/i.test(JSON.stringify(shipping || {})),
    couponLabel,
    pix: /pix/i.test(String(priceBlock?.unit_description?.text || "")),
    soldQuantity: soldOf(soldText),
    rating: Number(ratingText) || undefined,
    category: "",
    url: permalink,
    imageUrl: picture
      ? `https://http2.mlstatic.com/D_NQ_NP_${picture}-O.webp`
      : undefined,
    marketplace: "ml",
    urgent: offerEndsSoonText(card)
  };
};

/** Procura cartões de produto (formato "polycard": metadata.id + metadata.url + components) em qualquer lugar do objeto. */
const findCards = (root: unknown): any[] => {
  const found: any[] = [];
  const seen = new Set<unknown>();
  const walk = (node: unknown, depth: number) => {
    if (!node || typeof node !== "object" || depth > 40 || seen.has(node)) return;
    seen.add(node);
    const value = node as Record<string, any>;
    if (value.metadata?.id && value.metadata?.url && Array.isArray(value.components)) {
      found.push(value);
      return;
    }
    for (const child of Array.isArray(node) ? node : Object.values(value)) walk(child, depth + 1);
  };
  walk(root, 0);
  return found;
};

/** Reserva: produtos nos dados estruturados (JSON-LD) que a página publica para buscadores. */
const fromJsonLd = (html: string): DealOffer[] => {
  const offers: DealOffer[] = [];
  const blocks = html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || [];
  const products: any[] = [];
  const collect = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(collect);
    if (node["@type"] === "Product") products.push(node);
    if (node.item) collect(node.item);
    if (node.itemListElement) collect(node.itemListElement);
    if (node["@graph"]) collect(node["@graph"]);
  };
  for (const block of blocks) {
    try {
      collect(JSON.parse(block.replace(/^<script[^>]*>/i, "").replace(/<\/script>$/i, "")));
    } catch {
      /* bloco inválido: ignora */
    }
  }
  for (const product of products) {
    const offer = Array.isArray(product.offers) ? product.offers[0] : product.offers;
    const price = Number(offer?.price ?? offer?.lowPrice);
    const url = String(product.url || offer?.url || "");
    const id = (url.match(/MLB-?\d+/i)?.[0] || String(product.sku || product.productID || "")).replace("-", "");
    const title = String(product.name || "").trim();
    if (!id || !title || !url || !Number.isFinite(price)) continue;
    const image = Array.isArray(product.image) ? product.image[0] : product.image;
    offers.push({
      externalId: id,
      title,
      priceCents: Math.round(price * 100),
      url: url.startsWith("http") ? url : `https://${url}`,
      imageUrl: typeof image === "string" ? image : undefined,
      marketplace: "ml",
      category: ""
    });
  }
  return offers;
};

/**
 * Sem login, o ML redireciona (302) /ofertas e lista.* para /gz/account-verification ("negative_traffic").
 * O axios segue o redirecionamento e recebe HTTP 200 com __NORDIC_RENDERING_CTX__, mas sem nenhum produto.
 * Essa parede tem só flags, assets, support, title, framework, appProps e mainEntry, e pageProps sem "data" mas com
 * authLinks. A página logada de verdade tem pageProps.data.items (48 cartões em 16/10/2026).
 */
const isVerificationWall = (parsed: any, html: string, finalUrl = ""): boolean =>
  /\/gz\/account-verification/i.test(finalUrl) ||
  /account-verification/i.test(String(parsed?.mainEntry || "")) ||
  /loginType=negative_traffic/i.test(JSON.stringify(parsed?.appProps?.pageProps?.authLinks || "")) ||
  (!!parsed?.appProps?.pageProps?.authLinks && !parsed?.appProps?.pageProps?.data) ||
  (!parsed && /\/gz\/account-verification/i.test(html));

/** Ofertas da página /ofertas do ML. `finalUrl` é o endereço depois dos redirecionamentos. Exportada para teste. */
export const offersFromOffersPage = (
  html: string,
  finalUrl = ""
): { offers: DealOffer[]; how: string; keys: string; blocked: boolean } => {
  let parsed: any = null;
  try {
    parsed = extractObject(html, "__NORDIC_RENDERING_CTX__");
  } catch {
    parsed = null;
  }
  if (isVerificationWall(parsed, html, finalUrl)) return { offers: [], how: "", keys: "", blocked: true };
  const direct = parsed?.appProps?.pageProps?.data?.items;
  if (Array.isArray(direct) && direct.length) {
    const offers = direct.map((item: any) => cardToOffer(item?.card)).filter((offer): offer is DealOffer => !!offer);
    if (offers.length) return { offers, how: "lista padrão", keys: "", blocked: false };
  }
  const deep = findCards(parsed).map(cardToOffer).filter((offer): offer is DealOffer => !!offer);
  if (deep.length) return { offers: deep, how: "cartões encontrados na página", keys: "", blocked: false };
  const ld = fromJsonLd(html);
  if (ld.length) return { offers: ld, how: "dados estruturados", keys: "", blocked: false };
  const data = parsed?.appProps?.pageProps?.data;
  const keys = data && typeof data === "object" ? Object.keys(data).slice(0, 12).join(",") : parsed ? Object.keys(parsed).slice(0, 12).join(",") : "";
  return { offers: [], how: "", keys, blocked: false };
};

/** Uma entrada por cookie: o catálogo lido com a sessão de uma empresa não vai para outra. */
const catalogCache = new Map<string, { at: number; offers: DealOffer[] }>();

/**
 * O /ofertas tem 20+ páginas de 48 ofertas (19/10/2026), mas ler só as páginas 1 e 2 fazia o robô repetir
 * os mesmos produtos todo dia. Cada leitura pega a página 1 (as novidades) e mais 3 fontes em rodízio;
 * o que foi lido fica num acervo por algumas horas, então o robô escolhe entre centenas de ofertas.
 */
export const ML_SOURCES: Array<Record<string, string | number>> = [
  ...Array.from({ length: 19 }, (_, index) => ({ page: index + 2 })),
  { promotion_type: "lightning" },
  { promotion_type: "deal_of_the_day" }
];
export const ML_ROTATING_PER_LOAD = 3;
const POOL_HOURS = 6;
const POOL_MAX = 1200;

/** Fontes de uma leitura: a página 1 e as próximas do rodízio a partir de `cursor`. Exportada para teste. */
export const sourcesFor = (cursor: number): Array<Record<string, string | number>> => [
  {},
  ...Array.from({ length: ML_ROTATING_PER_LOAD }, (_, index) => ML_SOURCES[(cursor + index) % ML_SOURCES.length])
];

const rotation = new Map<string, number>();
const pools = new Map<string, Map<string, { at: number; offer: DealOffer }>>();

/** Junta o que acabou de ser lido ao acervo, tira o que ficou velho e devolve do mais novo para o mais antigo. Exportada para teste. */
export const mergeIntoPool = (
  pool: Map<string, { at: number; offer: DealOffer }>,
  fresh: DealOffer[],
  now: number,
  maxAgeMs = POOL_HOURS * 3600_000,
  max = POOL_MAX
): DealOffer[] => {
  for (const offer of fresh) pool.set(offer.externalId, { at: now, offer });
  for (const [id, entry] of pool) if (now - entry.at > maxAgeMs) pool.delete(id);
  const ordered = [...pool.entries()].sort((a, b) => b[1].at - a[1].at);
  for (const [id] of ordered.slice(max)) pool.delete(id);
  return ordered.slice(0, max).map(([, entry]) => entry.offer);
};

/** O que o ML respondeu na última tentativa; vai para a mensagem de erro do painel quando não vem nenhuma oferta. */
const lastFetch = { api: "", page: "" };

/** Cabeçalhos do /ofertas. Com o cookie de sessão salvo pela empresa, o ML não manda para a verificação de conta. Exportada para teste. */
export const offersPageHeaders = (cookie?: string): Record<string, string> => {
  const headers: Record<string, string> = {
    "User-Agent": UA,
    Accept: "text/html",
    "Accept-Language": "pt-BR,pt;q=0.9"
  };
  const trimmed = String(cookie || "").trim();
  if (trimmed) headers.Cookie = trimmed;
  return headers;
};

const pageSummary = (status: number, html: string, items: number): string => {
  const title = (html.match(/<title[^>]*>([^<]{0,80})/i)?.[1] || "").trim();
  const marker = html.includes("__NORDIC_RENDERING_CTX__") ? "com dados" : "sem dados de ofertas";
  return `HTTP ${status}, ${marker}, ${items} itens${title ? `, título "${title}"` : ""}`;
};

const loadOfferCatalog = async (cookie = ""): Promise<DealOffer[]> => {
  const cacheKey = cookie ? createHash("sha256").update(cookie).digest("hex") : "";
  const cached = catalogCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 3 * 60 * 1000) {
    return cached.offers;
  }
  const cursor = rotation.get(cacheKey) || 0;
  rotation.set(cacheKey, (cursor + ML_ROTATING_PER_LOAD) % ML_SOURCES.length);
  const settled = await Promise.allSettled(
    sourcesFor(cursor).map(async (params, index) => {
      const page = index + 1;
      const response = await axios.get("https://www.mercadolivre.com.br/ofertas", {
        params,
        timeout: 20000,
        responseType: "text",
        headers: offersPageHeaders(cookie)
      });
      const html = String(response.data);
      const finalUrl = String((response.request as any)?.res?.responseUrl || "");
      const result = offersFromOffersPage(html, finalUrl);
      if (page === 1) {
        lastFetch.page = result.blocked
          ? cookie
            ? "o ML redirecionou para a verificação de conta mesmo com o cookie salvo (sessão expirada ou recusada)"
            : "o ML redirecionou para a verificação de conta (login exigido; salve o cookie de sessão do Mercado Livre nas configurações)"
          : pageSummary(response.status, html, result.offers.length) + (result.keys ? `, chaves: ${result.keys}` : "");
      }
      return result.offers;
    })
  );
  const failed = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
  if (failed && settled.every(item => item.status === "rejected")) throw failed.reason;
  const fresh = settled.flatMap(item => (item.status === "fulfilled" ? item.value : []));
  const pool = pools.get(cacheKey) || new Map();
  pools.set(cacheKey, pool);
  // Sessão bloqueada não deve continuar publicando o acervo antigo como se estivesse tudo bem.
  const offers = fresh.length ? mergeIntoPool(pool, fresh, Date.now()) : [];
  catalogCache.set(cacheKey, { at: Date.now(), offers });
  return offers;
};

export const catalogImageMap = async (cookie = ""): Promise<Map<string, string>> => {
  const offers = await loadOfferCatalog(cookie);
  const images = new Map<string, string>();
  offers.forEach(offer => {
    if (offer.externalId && offer.imageUrl) images.set(offer.externalId, offer.imageUrl);
  });
  return images;
};

const fromApi = async (query: string): Promise<DealOffer[]> => {
  const { data } = await axios.get("https://api.mercadolibre.com/sites/MLB/search", {
    params: { q: query, limit: 8 },
    timeout: 12000,
    headers: { "User-Agent": UA, Accept: "application/json" }
  });
  const results = Array.isArray(data?.results) ? data.results : [];
  return results
    .map((item: any): DealOffer | null => {
      const id = String(item?.id || "").trim();
      const title = String(item?.title || "").trim();
      const price = Number(item?.price);
      const permalink = String(item?.permalink || "").trim();
      if (!id || !title || !permalink || !Number.isFinite(price)) return null;
      const original = Number(item?.original_price);
      const priceCents = Math.round(price * 100);
      const originalPriceCents =
        Number.isFinite(original) && original > price ? Math.round(original * 100) : undefined;
      return {
        externalId: id,
        title,
        priceCents,
        originalPriceCents,
        discountPercent: discountOf(priceCents, originalPriceCents),
        freeShipping: !!item?.shipping?.free_shipping,
        soldQuantity: Number(item?.sold_quantity) || 0,
        category: String(item?.category_id || ""),
        url: permalink,
        imageUrl: item?.thumbnail
          ? String(item.thumbnail).replace("-I.jpg", "-O.jpg").replace(/^http:/, "https:")
          : undefined,
        marketplace: "ml",
        urgent: offerEndsSoonText(item?.title) || offerEndsSoonText(item?.tags)
      };
    })
    .filter(Boolean) as DealOffer[];
};

const matchesQuery = (offer: DealOffer, query: string): boolean => {
  const words = fold(query)
    .split(/\s+/)
    .filter(word => word.length > 2);
  if (!words.length) return true;
  const title = fold(offer.title);
  return words.some(word => title.includes(word));
};

/** A API de busca responde 403. O catálogo público de ofertas entra no lugar. */
export const searchMercadoLivre = async (
  query: string,
  tracking: MlTracking,
  cookie = ""
): Promise<DealOffer[]> => {
  let offers: DealOffer[] = [];
  try {
    offers = await fromApi(query);
    lastFetch.api = `${offers.length} resultados`;
  } catch (err) {
    const status = (err as { response?: { status?: number } }).response?.status;
    lastFetch.api = status ? `HTTP ${status}` : String((err as Error).message || err).slice(0, 60);
    offers = [];
  }
  if (!offers.length) offers = await loadOfferCatalog(cookie);
  if (!offers.length) {
    // Sem isto o painel mostrava "Nenhuma oferta passou nos filtros", e o problema real (ML sem resposta útil) ficava escondido.
    throw new Error(`o Mercado Livre não devolveu ofertas para este servidor (busca: ${lastFetch.api || "sem resposta"}; página de ofertas: ${lastFetch.page || "sem resposta"}). ${lastFetch.page.includes("verificação de conta") ? "O ML exige uma sessão logada para ler as ofertas." : "Pode ser bloqueio do ML ao IP da VPS."}`);
  }
  const wanted = offers.filter(offer => matchesQuery(offer, query));
  const pool = (wanted.length ? wanted : offers).sort(
    (a, b) =>
      (b.discountPercent || 0) - (a.discountPercent || 0) ||
      (b.soldQuantity || 0) - (a.soldQuantity || 0)
  );
  const withCoupon = pool.filter(offer => offer.couponLabel);
  const ordered = [...withCoupon, ...pool.filter(offer => !offer.couponLabel)];
  const seen = new Set<string>();
  const chosen: DealOffer[] = [];
  ordered.forEach(offer => {
    if (seen.has(offer.externalId) || chosen.length >= 300) return;
    seen.add(offer.externalId);
    chosen.push(offer);
  });
  return chosen.map(offer => ({
    ...offer,
    url: applyMlTracking(offer.url, tracking)
  }));
};
