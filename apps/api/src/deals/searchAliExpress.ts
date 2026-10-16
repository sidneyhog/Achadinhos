import crypto from "crypto";
import axios from "axios";
import { cache } from "../cache";
import { DealOffer } from "./types";

const GATEWAY = "https://api-sg.aliexpress.com/sync";
const offersKey = (companyId: number) => `deals:aliexpress:offers:${companyId}`;

const fold = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

const priceCentsOf = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.round(value * 100);
  }
  const raw = String(value ?? "")
    .replace(/[^\d,.-]/g, "")
    .trim();
  if (!raw) return 0;
  const normalized = raw.includes(",") && !raw.includes(".")
    ? raw.replace(/\./g, "").replace(",", ".")
    : raw.replace(/,/g, "");
  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Math.round(amount * 100);
};

const discountOf = (value: unknown): number | undefined => {
  const amount = Number(String(value ?? "").replace("%", "").replace(",", "."));
  if (!Number.isFinite(amount) || amount <= 0 || amount >= 90) return undefined;
  return Math.round(amount);
};

const affiliateUrl = (item: any): string => {
  const raw = String(
    item?.promotion_link || item?.promotionLink || item?.aff_url || item?.affiliate_url || ""
  ).trim();
  return /s\.click\.aliexpress|aff_short_key|aff_trace_key|a\.aliexpress\.com/i.test(raw) ? raw : "";
};

export const offerFromAliItem = (item: any): DealOffer | null => {
  const externalId = String(item?.product_id || item?.productId || "").trim();
  const title = String(item?.product_title || item?.productTitle || item?.title || "").trim();
  const url = affiliateUrl(item);
  const priceCents = priceCentsOf(
    item?.target_sale_price || item?.sale_price || item?.app_sale_price || item?.price
  );
  if (!externalId || !title || !priceCents || !url) return null;
  const discountPercent = discountOf(item?.discount);
  const originalPriceCents = priceCentsOf(
    item?.target_original_price || item?.original_price || item?.app_original_price
  );
  return {
    externalId,
    title: title.slice(0, 180),
    priceCents,
    originalPriceCents: originalPriceCents > priceCents ? originalPriceCents : undefined,
    discountPercent,
    soldQuantity: Number(item?.lastest_volume || item?.volume || item?.orders) || 0,
    rating: Number(String(item?.evaluate_rate || "").replace("%", "")) || undefined,
    url,
    imageUrl: String(item?.product_main_image_url || item?.image_url || item?.image || "") || undefined,
    marketplace: "aliexpress"
  };
};

export const rememberAliExpressOffers = async (companyId: number, incoming: DealOffer[]): Promise<void> => {
  if (!companyId || !incoming.length) return;
  const merged = new Map<string, DealOffer>();
  try {
    const raw = await cache.get(offersKey(companyId));
    const current = raw ? JSON.parse(raw) : [];
    if (Array.isArray(current)) {
      current.forEach((item: DealOffer) => {
        if (item?.externalId && item.url) merged.set(item.externalId, item);
      });
    }
  } catch {
    merged.clear();
  }
  incoming.forEach(item => merged.set(item.externalId, item));
  const offers = Array.from(merged.values()).slice(0, 40);
  await cache.set(offersKey(companyId), JSON.stringify(offers), "EX", 12 * 3600);
};

export const rememberedAliExpressOffers = async (companyId?: number): Promise<DealOffer[]> => {
  if (!companyId) return [];
  try {
    const raw = await cache.get(offersKey(companyId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(item => item?.url && item?.title) : [];
  } catch {
    return [];
  }
};

const collectProducts = (node: unknown, found: any[], depth = 0): void => {
  if (!node || depth > 7) return;
  if (Array.isArray(node)) {
    node.forEach(item => {
      if (item && typeof item === "object") {
        const offer = offerFromAliItem(item);
        if (offer) found.push(item);
      }
      collectProducts(item, found, depth + 1);
    });
    return;
  }
  if (typeof node === "object") {
    Object.values(node as Record<string, unknown>).forEach(value => collectProducts(value, found, depth + 1));
  }
};

export const rememberAliExpressPayload = async (companyId: number, payload: unknown): Promise<number> => {
  const rows: any[] = [];
  collectProducts(payload, rows);
  const offers = rows
    .map(offerFromAliItem)
    .filter((offer): offer is DealOffer => !!offer);
  await rememberAliExpressOffers(companyId, offers);
  return offers.length;
};

const signParams = (params: Record<string, string>, secret: string): string => {
  const base = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], "");
  return crypto.createHmac("sha256", secret).update(base, "utf8").digest("hex").toUpperCase();
};

const callApi = async (
  method: string,
  creds: { appKey: string; appSecret: string; trackingId: string },
  extra: Record<string, string>
): Promise<any> => {
  const params: Record<string, string> = {
    app_key: creds.appKey,
    method,
    sign_method: "sha256",
    timestamp: String(Date.now()),
    format: "json",
    v: "2.0",
    tracking_id: creds.trackingId,
    target_currency: "BRL",
    target_language: "PT",
    ship_to_country: "BR",
    page_no: "1",
    page_size: "20",
    ...extra
  };
  params.sign = signParams(params, creds.appSecret);
  const response = await axios.post(GATEWAY, new URLSearchParams(params).toString(), {
    timeout: 20000,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    validateStatus: () => true
  });
  const error = response.data?.error_response;
  if (error) {
    const message = String(error.msg || error.message || "A AliExpress recusou a consulta.");
    throw new Error(`AliExpress: ${message}`);
  }
  return response.data;
};

const productPage = (item: any): string => {
  const raw = String(item?.product_detail_url || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return raw.split("?")[0];
  }
};

const shortLinks = async (
  creds: { appKey: string; appSecret: string; trackingId: string },
  pages: string[]
): Promise<Map<string, string>> => {
  const map = new Map<string, string>();
  const sources = [...new Set(pages.filter(Boolean))].slice(0, 20);
  if (!sources.length) return map;
  const params: Record<string, string> = {
    app_key: creds.appKey,
    method: "aliexpress.affiliate.link.generate",
    sign_method: "sha256",
    timestamp: String(Date.now()),
    format: "json",
    v: "2.0",
    tracking_id: creds.trackingId,
    promotion_link_type: "0",
    source_values: sources.join(",")
  };
  params.sign = signParams(params, creds.appSecret);
  const response = await axios.post(GATEWAY, new URLSearchParams(params).toString(), {
    timeout: 20000,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    validateStatus: () => true
  });
  const error = response.data?.error_response;
  if (error) {
    throw new Error(`AliExpress: ${String(error.msg || error.message || "não gerou o link curto")}`);
  }
  const rows = response.data?.aliexpress_affiliate_link_generate_response?.resp_result?.result?.promotion_links?.promotion_link;
  const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
  list.forEach((row: any) => {
    const source = productPage({ product_detail_url: row?.source_value });
    const link = String(row?.promotion_link || "").trim();
    if (source && /^https:\/\/s\.click\.aliexpress\.com\/e\//i.test(link) && link.length <= 80) {
      map.set(source, link);
    }
  });
  return map;
};

const filterOffers = (offers: DealOffer[], query: string): DealOffer[] => {
  const words = fold(query)
    .split(/\s+/)
    .filter(word => word.length > 2 && word !== "oferta");
  const wanted = words.length
    ? offers.filter(offer => words.some(word => fold(offer.title).includes(word)))
    : offers;
  return (wanted.length ? wanted : offers).slice(0, 20);
};

export const searchAliExpress = async (opts: {
  query: string;
  companyId?: number;
  appKey?: string;
  appSecret?: string;
  trackingId?: string;
}): Promise<DealOffer[]> => {
  const appKey = String(opts.appKey || "").trim();
  const appSecret = String(opts.appSecret || "").trim();
  const trackingId = String(opts.trackingId || "").trim();
  if (appKey && appSecret && trackingId) {
    try {
      const words = ["fone", "relogio", "bolsa", "lampada", "cabo", "garrafa", "tenis", "mochila", "panela", "creme"];
      const slot = Math.floor(Date.now() / 60000);
      const catalogWord = words[slot % words.length];
      const pageNo = String((slot % 4) + 1);
      const queryProducts = async (keywords: string, page = "1") => callApi(
        "aliexpress.affiliate.product.query",
        { appKey, appSecret, trackingId },
        { keywords, page_no: page }
      );
      const offersFrom = async (data: any) => {
        const rows: any[] = [];
        collectProducts(data, rows);
        const creds = { appKey, appSecret, trackingId };
        const shorts = await shortLinks(creds, rows.map(productPage));
        return filterOffers(
          rows
            .map(item => {
              const page = productPage(item);
              const link = shorts.get(page);
              if (!link) return null;
              return offerFromAliItem({ ...item, promotion_link: link });
            })
            .filter((offer): offer is DealOffer => !!offer && offer.url.length <= 80),
          opts.query
        );
      };
      if (opts.query) {
        const offers = await offersFrom(await queryProducts(opts.query));
        if (offers.length) {
          if (opts.companyId) await rememberAliExpressOffers(opts.companyId, offers);
          return offers;
        }
      } else {
        const first = await offersFrom(await queryProducts(catalogWord, pageNo));
        const nextPage = pageNo === "4" ? "1" : String(Number(pageNo) + 1);
        const second = await offersFrom(await queryProducts(catalogWord, nextPage));
        const seen = new Set<string>();
        const offers = [...first, ...second].filter(offer => {
          if (seen.has(offer.externalId)) return false;
          seen.add(offer.externalId);
          return true;
        });
        if (offers.length) {
          if (opts.companyId) await rememberAliExpressOffers(opts.companyId, offers);
          return offers;
        }
      }
    } catch (err) {
      const saved = filterOffers(await rememberedAliExpressOffers(opts.companyId), opts.query)
        .filter(offer => offer.url.length <= 80);
      if (saved.length) return saved;
      throw err;
    }
  }
  const saved = filterOffers(await rememberedAliExpressOffers(opts.companyId), opts.query)
    .filter(offer => offer.url.length <= 80);
  if (saved.length) return saved;
  throw new Error("AliExpress: entre pelo botão Conectar e abra a lista de produtos, ou informe App Key, Secret e Tracking ID.");
};
