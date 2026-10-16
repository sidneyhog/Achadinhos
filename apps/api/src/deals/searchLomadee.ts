import crypto from "crypto";
import axios from "axios";
import { DealOffer, DealMarketplace } from "./types";

const BASE = "https://api.lomadee.com.br";

type Brand = { id?: string; organizationId?: string; name?: string };
type Product = {
  id?: string;
  name?: string;
  url?: string;
  organizationId?: string;
  images?: Array<{ url?: string }>;
  options?: Array<{ pricing?: Array<{ price?: number; listPrice?: number }> }>;
};

const explain = (err: unknown): never => {
  const status = axios.isAxiosError(err) ? err.response?.status : 0;
  if (status === 401 || status === 403) {
    throw new Error("A chave da Lomadee foi recusada. Use uma chave de afiliado com acesso a marcas, produtos e encurtador.");
  }
  const message = err instanceof Error ? err.message : "Falha na Lomadee";
  throw new Error(message.slice(0, 240));
};

const brandCache = new Map<string, { at: number; id: string }>();

const fold = (value: string): string =>
  value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

const brandId = (row: Brand): string => String(row.organizationId || row.id || "").trim();

const findBrand = async (apiKey: string, brand: string): Promise<string> => {
  const cacheKey = crypto.createHash("sha256").update(`${brand}:${apiKey}`).digest("hex").slice(0, 16);
  const cached = brandCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 6 * 60 * 60 * 1000) return cached.id;
  const needle = fold(brand);
  for (let page = 1; page <= 5; page += 1) {
    const { data } = await axios.get(`${BASE}/affiliate/brands`, {
      headers: { "x-api-key": apiKey },
      params: { page, limit: 20 },
      timeout: 20000
    }).catch(explain);
    const rows: Brand[] = Array.isArray(data?.data) ? data.data : [];
    const match = rows.find(row => fold(String(row.name || "")).includes(needle));
    const id = match ? brandId(match) : "";
    if (id) {
      brandCache.set(cacheKey, { at: Date.now(), id });
      return id;
    }
    const totalPages = Number(data?.pagination?.totalPages || 1);
    if (!rows.length || page >= totalPages) break;
  }
  throw new Error("A Lomadee não listou essa marca na chave informada. Confira se o programa está aprovado na conta.");
};

const shorten = async (apiKey: string, organizationId: string, url: string): Promise<string> => {
  const { data } = await axios.post(
    `${BASE}/affiliate/shortener/url`,
    { organizationId, type: "Custom", url },
    {
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
      timeout: 15000
    }
  ).catch(explain);
  const channels = Array.isArray(data) ? data : [];
  for (const channel of channels) {
    const link = Array.isArray(channel?.shortUrls) ? String(channel.shortUrls[0] || "") : "";
    if (/^https:\/\//i.test(link)) return link;
  }
  return "";
};

/**
 * Catálogo oficial da Lomadee. O link publicado é o encurtado da conta,
 * não o endereço cru da loja.
 * https://api.lomadee.com.br/affiliate/products
 */
export const searchLomadee = async (opts: {
  apiKey: string;
  brand: string;
  marketplace: DealMarketplace;
}): Promise<DealOffer[]> => {
  const organizationId = await findBrand(opts.apiKey, opts.brand);
  const { data } = await axios.get(`${BASE}/affiliate/products`, {
    headers: { "x-api-key": opts.apiKey },
    params: { organizationIds: organizationId, limit: 8, page: 1, isAvailable: true },
    timeout: 20000
  }).catch(explain);
  const products: Product[] = Array.isArray(data?.data) ? data.data : [];
  const offers: DealOffer[] = [];
  for (const product of products) {
    const title = String(product.name || "").trim();
    const page = String(product.url || "").trim();
    if (!title || !/^https:\/\//i.test(page)) continue;
    const url = await shorten(opts.apiKey, product.organizationId || organizationId, page);
    if (!url) continue;
    const pricing = product.options?.[0]?.pricing?.[0];
    const price = Number(pricing?.price) || 0;
    const list = Number(pricing?.listPrice) || 0;
    const priceCents = price > 0 ? Math.round(price) : 0;
    const originalPriceCents = list > priceCents ? Math.round(list) : undefined;
    offers.push({
      externalId: `${opts.marketplace}-${product.id || title}`,
      title: title.slice(0, 180),
      priceCents,
      originalPriceCents,
      discountPercent:
        originalPriceCents && priceCents
          ? Math.round((1 - priceCents / originalPriceCents) * 100)
          : undefined,
      url,
      imageUrl: product.images?.[0]?.url || undefined,
      marketplace: opts.marketplace
    });
    if (offers.length >= 4) break;
  }
  if (!offers.length) {
    throw new Error("A Lomadee não devolveu link de afiliado para essa marca.");
  }
  return offers;
};
