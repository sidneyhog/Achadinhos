import crypto from "crypto";
import axios from "axios";
import { cache } from "../cache";
import { DealOffer } from "./types";

const PORTAL = "https://affiliate.shopee.com.br";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const LINK_QUERY = `
  query batchGetProductOfferLink(
    $sourceCaller: SourceCaller!
    $productOfferLinkParams: [ProductOfferLinkParam!]!
  ) {
    productOfferLinks(
      productOfferLinkParams: $productOfferLinkParams
      sourceCaller: $sourceCaller
    ) {
      itemId
      shopId
      productOfferLink
    }
  }
`;

const fold = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

const cookieValue = (cookie: string, name: string): string => {
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`, "i"));
  return match ? decodeURIComponent(match[1]) : "";
};

const cleanCookie = (raw: string): string =>
  String(raw || "")
    .replace(/^cookie\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 12000);

const headersFor = (cookie: string): Record<string, string> => {
  const csrf = cookieValue(cookie, "csrftoken") || cookieValue(cookie, "csrf-token");
  const headers: Record<string, string> = {
    Cookie: cookie,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "pt-BR,pt;q=0.9",
    Referer: `${PORTAL}/offer/product_offer`,
    Origin: PORTAL,
    "User-Agent": UA
  };
  if (csrf) headers["csrf-token"] = csrf;
  return headers;
};

const portalError = (data: any, status?: number): string | null => {
  if (data?.is_login === false || status === 401) {
    return "A sessão da Shopee expirou. Em Achadinhos, abra Conectar na Shopee e entre de novo.";
  }
  if (status === 403 || Number(data?.error) === 90309999) {
    return "A Shopee recusou a sessão. Em Achadinhos, abra Conectar na Shopee e entre de novo.";
  }
  return null;
};

const listKey = (companyId: number) => `deals:shopee:list:${companyId}`;
const linkKey = (companyId: number) => `deals:shopee:links:${companyId}`;

export const rememberShopeeList = async (companyId: number, items: any[]): Promise<void> => {
  if (!companyId || !Array.isArray(items) || !items.length) return;
  await cache.set(listKey(companyId), JSON.stringify(items.slice(0, 40)), "EX", 12 * 3600);
};

export const rememberShopeeLinks = async (
  companyId: number,
  links: Record<string, string>
): Promise<void> => {
  const entries = Object.entries(links).filter(([, url]) => /^https?:\/\//i.test(url));
  if (!companyId || !entries.length) return;
  let current: Record<string, string> = {};
  try {
    const raw = await cache.get(linkKey(companyId));
    if (raw) current = JSON.parse(raw);
  } catch {
    current = {};
  }
  entries.forEach(([id, url]) => {
    current[id] = url;
  });
  await cache.set(linkKey(companyId), JSON.stringify(current), "EX", 12 * 3600);
};

const rememberedList = async (companyId?: number): Promise<any[] | null> => {
  if (!companyId) return null;
  try {
    const raw = await cache.get(listKey(companyId));
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) && parsed.length ? parsed : null;
  } catch {
    return null;
  }
};

const rememberedLinks = async (companyId?: number): Promise<Map<string, string>> => {
  const links = new Map<string, string>();
  if (!companyId) return links;
  try {
    const raw = await cache.get(linkKey(companyId));
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object") {
      Object.entries(parsed).forEach(([id, url]) => {
        if (id && /^https?:\/\//i.test(String(url))) links.set(id, String(url));
      });
    }
  } catch {
    return links;
  }
  return links;
};

const priceCentsOf = (value: unknown): number => {
  const raw = String(value ?? "").trim().replace(/\s/g, "");
  if (!raw) return 0;
  const normalized = raw.includes(",") && !raw.includes(".")
    ? raw.replace(/\./g, "").replace(",", ".")
    : raw.replace(/,/g, "");
  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  if (amount >= 100000) return Math.round((amount / 100000) * 100);
  return Math.round(amount * 100);
};

const imageOf = (value: unknown): string | undefined => {
  const raw = String(value || "").trim();
  if (!raw) return undefined;
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://down-br.img.susercontent.com/file/${raw.replace(/^file\//, "")}`;
};

const pick = (item: any, keys: string[]): unknown => {
  for (const key of keys) {
    if (item?.[key] != null && item[key] !== "") return item[key];
  }
  return undefined;
};

let catalogCache: { key: string; at: number; items: any[] } | null = null;

const loadPortalItems = async (cookie: string, companyId?: number): Promise<any[]> => {
  const key = crypto.createHash("sha256").update(cookie).digest("hex").slice(0, 16);
  if (catalogCache && catalogCache.key === key && Date.now() - catalogCache.at < 3 * 60 * 1000) {
    return catalogCache.items;
  }
  let response;
  try {
    response = await axios.get(`${PORTAL}/api/v3/offer/product/list`, {
      params: {
        list_type: 0,
        page_offset: 0,
        page_limit: 20,
        client_type: 1
      },
      timeout: 20000,
      headers: headersFor(cookie),
      validateStatus: () => true
    });
  } catch (err) {
    const saved = await rememberedList(companyId);
    if (saved) return saved;
    throw new Error(`Shopee painel: ${(err as Error)?.message || err}`);
  }
  const refused = portalError(response.data, response.status);
  const list = response.data?.data?.list || response.data?.list;
  if (refused || !Array.isArray(list)) {
    const saved = await rememberedList(companyId);
    if (saved) return saved;
    throw new Error(refused || "A Shopee não devolveu a lista de ofertas do painel.");
  }
  catalogCache = { key, at: Date.now(), items: list };
  if (companyId) await rememberShopeeList(companyId, list);
  return list;
};

const affiliateLinks = async (
  cookie: string,
  items: Array<{ itemId: string; shopId: string }>,
  companyId?: number
): Promise<Map<string, string>> => {
  const links = new Map<string, string>();
  if (!items.length) return links;
  try {
    const response = await axios.post(
      `${PORTAL}/api/v3/gql?q=productOfferLinks`,
      {
        operationName: "batchGetProductOfferLink",
        query: LINK_QUERY,
        variables: {
          sourceCaller: "WEB_SITE_CALLER",
          productOfferLinkParams: items.map(item => ({
            itemId: item.itemId,
            shopId: item.shopId
          }))
        }
      },
      {
        timeout: 20000,
        headers: { ...headersFor(cookie), "Content-Type": "application/json" },
        validateStatus: () => true
      }
    );
    const refused = portalError(response.data, response.status);
    if (refused) return rememberedLinks(companyId);
    const rows = response.data?.data?.productOfferLinks;
    if (Array.isArray(rows)) {
      rows.forEach((row: any) => {
        const id = String(row?.itemId || "");
        const url = String(row?.productOfferLink || "").trim();
        if (id && /^https?:\/\//i.test(url)) links.set(id, url);
      });
    }
  } catch {
    return rememberedLinks(companyId);
  }
  if (!links.size) return rememberedLinks(companyId);
  return links;
};

/** Confere se a sessão enxerga a lista de ofertas, sem App Secret. */
export const probeShopeeSession = async (session: string): Promise<void> => {
  const cookie = cleanCookie(session);
  if (!cookie.includes("=")) {
    throw new Error("Cole o cookie da sessão. O texto precisa ter um nome e um valor separados por igual.");
  }
  await loadPortalItems(cookie);
};
export const searchShopeePortal = async (
  query: string,
  session: string,
  companyId?: number
): Promise<DealOffer[]> => {
  const cookie = cleanCookie(session);
  if (!cookie.includes("=")) {
    throw new Error("Em Achadinhos, abra Conectar na Shopee e entre na sua conta.");
  }
  const items = await loadPortalItems(cookie, companyId);
  const words = fold(query)
    .split(/\s+/)
    .filter(word => word.length > 2 && word !== "oferta");
  const wanted = words.length
    ? items.filter(item => {
        const title = fold(String(pick(item, ["product_name", "name", "item_name"]) || ""));
        return words.some(word => title.includes(word));
      })
    : items;
  const pool = (wanted.length ? wanted : items).slice(0, 8);
  const identities = pool
    .map(item => ({
      itemId: String(pick(item, ["item_id", "itemId"]) || ""),
      shopId: String(pick(item, ["shop_id", "shopId"]) || "")
    }))
    .filter(item => item.itemId);
  const links = await affiliateLinks(cookie, identities, companyId);

  const offers = pool
    .map((item): DealOffer | null => {
      const externalId = String(pick(item, ["item_id", "itemId"]) || "").trim();
      const title = String(pick(item, ["product_name", "name", "item_name"]) || "").trim();
      const priceCents = priceCentsOf(pick(item, ["price", "price_min", "priceMin"]));
      const tracked = links.get(externalId);
      const fallback = String(pick(item, ["product_link", "productLink", "offer_link", "long_link"]) || "");
      const url = tracked || (/affiliate|shope\.ee|an_redir/i.test(fallback) ? fallback : "");
      if (!externalId || !title || !priceCents || !url) return null;
      const discount = Number(pick(item, ["price_discount_rate", "discount", "discount_rate"]));
      const originalPriceCents =
        Number.isFinite(discount) && discount > 0 && discount < 90
          ? Math.round(priceCents / (1 - discount / 100))
          : undefined;
      return {
        externalId,
        title,
        priceCents,
        originalPriceCents,
        discountPercent: Number.isFinite(discount) && discount > 0 ? Math.round(discount) : undefined,
        soldQuantity: Number(pick(item, ["sales", "sold", "historical_sold"])) || 0,
        url,
        imageUrl: imageOf(pick(item, ["image", "image_url", "product_image"])),
        marketplace: "shopee"
      };
    })
    .filter((offer): offer is DealOffer => !!offer);
  if (!offers.length) {
    throw new Error("A Shopee listou o painel, mas não gerou o link de afiliado. Abra Conectar na Shopee e deixe a lista de ofertas carregar.");
  }
  return offers;
};
