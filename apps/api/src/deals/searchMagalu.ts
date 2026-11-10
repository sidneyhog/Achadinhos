import axios from "axios";
import { DealOffer } from "./types";
import { mergeIntoPool } from "./searchMercadoLivre";

/**
 * Magalu pelo Parceiro Magalu (magazinevoce.com.br). O programa não tem API de produtos, mas as páginas de
 * categoria, seleção e busca da vitrine do parceiro já chegam do servidor com os produtos no __NEXT_DATA__
 * (nome, preço, preço cheio, foto e endereço). O link de afiliado é o próprio endereço do produto dentro da
 * loja do parceiro: /magazine<loja>/<produto>/p/<código>/..., então basta trocar a loja pela de cada cliente.
 *
 * Como no Mercado Livre, o catálogo é um só para todas as empresas: cada leitura pega a seleção
 * "ofertas do dia" e mais 3 categorias em rodízio (mais vendidos), e o que foi lido fica guardado por algumas horas.
 */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const HOST = "https://www.magazinevoce.com.br";

/** Categorias da vitrine (slug e código), sem as que não fazem sentido para oferta em grupo. */
export const MAGALU_CATEGORIES: Array<[string, string]> = [
  ["eletroportateis", "ep"], ["celulares-e-smartphones", "te"], ["eletrodomesticos", "ed"], ["informatica", "in"],
  ["tv-e-video", "et"], ["audio", "ea"], ["games", "ga"], ["ar-e-ventilacao", "ar"], ["utilidades-domesticas", "ud"],
  ["moveis", "mo"], ["cama-mesa-e-banho", "cm"], ["beleza-e-perfumaria", "pf"], ["saude-e-cuidados-pessoais", "cp"],
  ["mercado", "me"], ["bebe", "bb"], ["brinquedos", "br"], ["esporte-e-lazer", "es"], ["ferramentas", "fs"],
  ["automotivo", "au"], ["casa-e-construcao", "cj"], ["pet-shop", "pe"], ["moda-e-acessorios", "md"],
  ["relogios", "re"], ["tablets-ipads-e-e-reader", "tb"], ["cameras-e-drones", "cf"], ["suplementos-alimentares", "sa"]
];
export const MAGALU_ROTATING_PER_LOAD = 3;
const SORT = "sortOrientation=desc&sortType=soldQuantity";
const CATALOG_FRESH_MS = 3 * 60 * 1000;
const SEARCH_FRESH_MS = 10 * 60 * 1000;

/**
 * Loja do parceiro no formato do endereço ("magazinein_3139904"). Aceita o que o cliente colar:
 * o endereço inteiro, o nome com ou sem "magazine", ou só o Promoter Id ("in_3139904").
 */
export const magaluStoreSlug = (storeName?: string, promoterId?: string) => {
  const raw = String(storeName || promoterId || "").trim();
  if (!raw) return "";
  let slug = raw;
  const fromUrl = raw.match(/magazinevoce\.com\.br\/([^/?#\s]+)/i);
  if (fromUrl) slug = fromUrl[1];
  slug = slug.replace(/^\/+|\/+$/g, "").toLowerCase();
  if (!/^[a-z0-9_-]{2,60}$/.test(slug)) return "";
  return slug.startsWith("magazine") ? slug : `magazine${slug}`;
};

/** Endereço do produto dentro da loja do cliente: troca a loja (primeira parte do caminho). */
export const magaluAffiliateUrl = (path: string, storeSlug: string) => {
  const rest = String(path || "").replace(/^https?:\/\/[^/]+/i, "").replace(/^\/[^/]+/, "");
  return `${HOST}/${storeSlug}${rest.startsWith("/") ? rest : `/${rest}`}`;
};

const cents = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number * 100) : 0;
};

/** Produtos do __NEXT_DATA__ de uma página da vitrine. O `url` sai com a loja de quem leu; troque com magaluAffiliateUrl. Exportada para teste. */
export const magaluOffersFromPage = (html: string): DealOffer[] => {
  const match = String(html || "").match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) return [];
  let products: any[] = [];
  try {
    products = JSON.parse(match[1])?.props?.pageProps?.data?.search?.products || [];
  } catch {
    return [];
  }
  const offers: DealOffer[] = [];
  for (const product of products) {
    if (!product || product.available === false || product.ads) continue;
    const price = product.price || {};
    const priceCents = cents(price.bestPrice) || cents(price.price);
    const full = cents(price.fullPrice) || cents(price.price);
    const path = String(product.url || product.path || "");
    const id = String(product.variationId || product.id || "");
    const title = String(product.title || "").trim();
    if (!id || !title || !priceCents || !/\/p\//.test(path)) continue;
    const originalPriceCents = full > priceCents ? full : undefined;
    offers.push({
      externalId: id,
      title,
      priceCents,
      originalPriceCents,
      discountPercent: originalPriceCents ? Math.round((1 - priceCents / originalPriceCents) * 100) : undefined,
      pix: /pix/i.test(String(price.paymentMethodDescription || "")),
      rating: Number(product.rating?.score) || undefined,
      category: String(product.category?.name || ""),
      url: path,
      imageUrl: product.image ? String(product.image).replace("{w}x{h}", "618x463") : undefined,
      marketplace: "magalu"
    });
  }
  return offers;
};

const fetchPage = async (storeSlug: string, path: string) => {
  const { data } = await axios.get(`${HOST}/${storeSlug}${path}`, {
    timeout: 20000,
    responseType: "text",
    headers: { "User-Agent": UA, Accept: "text/html", "Accept-Language": "pt-BR,pt;q=0.9" }
  });
  return magaluOffersFromPage(String(data));
};

/** Fontes de uma leitura: ofertas do dia e as próximas categorias do rodízio. Exportada para teste. */
export const magaluSourcesFor = (cursor: number) => [
  "/selecao/ofertasdodia/",
  ...Array.from({ length: MAGALU_ROTATING_PER_LOAD }, (_, index) => {
    const [slug, code] = MAGALU_CATEGORIES[(cursor + index) % MAGALU_CATEGORIES.length];
    return `/${slug}/l/${code}/?${SORT}`;
  })
];

const catalog = { at: 0, offers: [] as DealOffer[], cursor: 0, loading: null as Promise<DealOffer[]> | null };
const pool = new Map<string, { at: number; offer: DealOffer }>();
const searches = new Map<string, { at: number; offers: DealOffer[] }>();

const loadCatalog = async (storeSlug: string): Promise<DealOffer[]> => {
  if (catalog.offers.length && Date.now() - catalog.at < CATALOG_FRESH_MS) return catalog.offers;
  if (catalog.loading) return catalog.loading;
  catalog.loading = (async () => {
    const cursor = catalog.cursor;
    catalog.cursor = (cursor + MAGALU_ROTATING_PER_LOAD) % MAGALU_CATEGORIES.length;
    const settled = await Promise.allSettled(magaluSourcesFor(cursor).map(path => fetchPage(storeSlug, path)));
    const fresh = settled.flatMap(item => (item.status === "fulfilled" ? item.value : []));
    if (!fresh.length) {
      const failed = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
      if (!pool.size && failed) throw failed.reason;
      catalog.offers = mergeIntoPool(pool, [], Date.now());
      return catalog.offers;
    }
    catalog.offers = mergeIntoPool(pool, fresh, Date.now());
    catalog.at = Date.now();
    return catalog.offers;
  })().finally(() => {
    catalog.loading = null;
  });
  return catalog.loading;
};

/** Busca por palavra (campanhas da empresa), mais vendidos primeiro. */
const loadSearch = async (storeSlug: string, query: string) => {
  const key = query.trim().toLowerCase();
  const cached = searches.get(key);
  if (cached && Date.now() - cached.at < SEARCH_FRESH_MS) return cached.offers;
  const offers = await fetchPage(storeSlug, `/busca/${encodeURIComponent(key)}/?${SORT}`);
  searches.set(key, { at: Date.now(), offers });
  if (searches.size > 200) searches.delete(searches.keys().next().value as string);
  return offers;
};

export const searchMagalu = async (input: { query: string; storeName?: string; promoterId?: string }): Promise<DealOffer[]> => {
  const store = magaluStoreSlug(input.storeName, input.promoterId);
  if (!store) throw new Error("Magalu precisa do nome da loja do Parceiro Magalu (ex.: magazinein_3139904)");
  const offers = input.query.trim() ? await loadSearch(store, input.query) : await loadCatalog(store);
  if (!offers.length) throw new Error("a Magalu não devolveu produtos para este servidor agora");
  // O mesmo produto pode vir de mais de uma fonte; cada empresa recebe o link da própria loja.
  const seen = new Set<string>();
  return offers
    .filter(offer => (seen.has(offer.externalId) ? false : (seen.add(offer.externalId), true)))
    .map(offer => ({ ...offer, url: magaluAffiliateUrl(offer.url, store) }));
};
