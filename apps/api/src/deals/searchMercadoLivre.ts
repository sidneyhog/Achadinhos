import axios from "axios";
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

let catalogCache: { at: number; offers: DealOffer[] } | null = null;

const loadOfferCatalog = async (): Promise<DealOffer[]> => {
  if (catalogCache && Date.now() - catalogCache.at < 3 * 60 * 1000) {
    return catalogCache.offers;
  }
  const pages = await Promise.all(
    [1, 2].map(async page => {
      const response = await axios.get("https://www.mercadolivre.com.br/ofertas", {
        params: page === 1 ? {} : { page },
        timeout: 20000,
        responseType: "text",
        headers: {
          "User-Agent": UA,
          Accept: "text/html",
          "Accept-Language": "pt-BR,pt;q=0.9"
        }
      });
      const parsed = extractObject(String(response.data), "__NORDIC_RENDERING_CTX__");
      const items = parsed?.appProps?.pageProps?.data?.items;
      return Array.isArray(items) ? items : [];
    })
  );
  const offers = pages
    .flat()
    .map(item => cardToOffer(item?.card))
    .filter((offer): offer is DealOffer => !!offer);
  catalogCache = { at: Date.now(), offers };
  return offers;
};

export const catalogImageMap = async (): Promise<Map<string, string>> => {
  const offers = await loadOfferCatalog();
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
  tracking: MlTracking
): Promise<DealOffer[]> => {
  let offers: DealOffer[] = [];
  try {
    offers = await fromApi(query);
  } catch (err) {
    offers = [];
  }
  if (!offers.length) offers = await loadOfferCatalog();
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
    if (seen.has(offer.externalId) || chosen.length >= 120) return;
    seen.add(offer.externalId);
    chosen.push(offer);
  });
  return chosen.map(offer => ({
    ...offer,
    url: applyMlTracking(offer.url, tracking)
  }));
};
