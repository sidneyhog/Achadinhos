import axios from "axios";
import { DealOffer } from "./types";

/**
 * Ofertas do Mercado Livre pela API oficial, com o token do próprio app (client_credentials).
 * Desde 21/10/2026 a página /ofertas responde com a tela "Segurança — Mercado Livre" para a VPS, e a busca
 * pública (/sites/MLB/search) dá 403 mesmo com token. Testado com o app em 21/10/2026, funcionam:
 * /highlights/MLB/category/{id} (20 mais vendidos), /products/{id}, /products/{id}/items e /products/search.
 * Produtos de vendedor (MLBU) e /items de terceiros dão 403/404 para o app, então ficam de fora.
 */

const API = "https://api.mercadolibre.com";
const CACHE_MS = 30 * 60 * 1000;
const PARALLEL = 4;
const TIMEOUT_MS = 15000;

/** Categorias de topo do MLB que têm "mais vendidos" (as outras quatro devolvem 404: carros, imóveis, ingressos, serviços). */
export const ML_HIGHLIGHT_CATEGORIES: Record<string, string> = {
  MLB5672: "Acessórios para Veículos",
  MLB271599: "Agro",
  MLB1403: "Alimentos e Bebidas",
  MLB1071: "Animais",
  MLB1367: "Antiguidades e Coleções",
  MLB1368: "Arte, Papelaria e Armarinho",
  MLB1384: "Bebês",
  MLB1246: "Beleza e Cuidado Pessoal",
  MLB1132: "Brinquedos e Hobbies",
  MLB1430: "Calçados, Roupas e Bolsas",
  MLB1039: "Câmeras e Acessórios",
  MLB1574: "Casa, Móveis e Decoração",
  MLB1051: "Celulares e Telefones",
  MLB1500: "Construção",
  MLB5726: "Eletrodomésticos",
  MLB1000: "Eletrônicos, Áudio e Vídeo",
  MLB1276: "Esportes e Fitness",
  MLB263532: "Ferramentas",
  MLB12404: "Festas e Lembrancinhas",
  MLB1144: "Games",
  MLB1499: "Indústria e Comércio",
  MLB1648: "Informática",
  MLB1182: "Instrumentos Musicais",
  MLB3937: "Joias e Relógios",
  MLB1196: "Livros, Revistas e Comics",
  MLB1168: "Música, Filmes e Seriados",
  MLB264586: "Saúde",
  MLB1953: "Mais Categorias"
};

export type MlGet = (path: string) => Promise<any>;

type ProductRef = { id: string; name?: string; pictures?: Array<{ id?: string; url?: string; secure_url?: string }>; category?: string };

/**
 * A API devolve a foto grande ("-F.jpg", ~160 KB) e o cartão de prévia do WhatsApp saiu sem imagem com ela.
 * A versão "-O" (~50 KB) é a mesma que a página /ofertas usava e que aparecia no cartão. Exportada para teste.
 */
export const mlPictureUrl = (picture: { id?: string; url?: string; secure_url?: string } | undefined): string | undefined => {
  const id = String(picture?.id || "");
  if (/^\d+-[A-Z]{3}\d+_\d+$/.test(id)) return `https://http2.mlstatic.com/D_NQ_NP_${id}-O.webp`;
  const url = String(picture?.secure_url || picture?.url || "");
  return /^https:\/\//.test(url) ? url : undefined;
};

type BestItem = { itemId: string; price: number; original: number; freeShipping: boolean };

/** Sem as duas variáveis da stack, a API oficial fica desligada (nada de chave padrão). */
export const mlOfficialConfigured = (): boolean =>
  Boolean(String(process.env.ML_CLIENT_ID || "").trim() && String(process.env.ML_CLIENT_SECRET || "").trim());

/**
 * O anúncio mais barato entre os que têm desconto de verdade. Preço e "antes" saem do mesmo anúncio: o mais
 * barato do produto às vezes não tem preço antigo, e juntar o preço de um com o "antes" de outro inventaria desconto.
 * Exportada para teste.
 */
export const bestDiscountedItem = (results: unknown): BestItem | null => {
  if (!Array.isArray(results)) return null;
  let best: BestItem | null = null;
  for (const row of results) {
    const price = Number(row?.price);
    const original = Number(row?.original_price);
    const itemId = String(row?.item_id || "");
    if (!itemId || !Number.isFinite(price) || price <= 0 || !Number.isFinite(original) || original <= price) continue;
    if (String(row?.currency_id || "BRL") !== "BRL") continue;
    if (!best || price < best.price) best = { itemId, price, original, freeShipping: Boolean(row?.shipping?.free_shipping) };
  }
  return best;
};

/** Monta a oferta com o anúncio escolhido. O link abre a página do produto já nesse anúncio. Exportada para teste. */
export const productOffer = (product: ProductRef, best: BestItem): DealOffer | null => {
  const title = String(product.name || "").trim();
  if (!title || !/^MLB\d+$/.test(product.id)) return null;
  const priceCents = Math.round(best.price * 100);
  const originalPriceCents = Math.round(best.original * 100);
  const picture = (product.pictures || []).map(mlPictureUrl).find(Boolean);
  return {
    externalId: best.itemId,
    title,
    priceCents,
    originalPriceCents,
    discountPercent: Math.round(((originalPriceCents - priceCents) / originalPriceCents) * 100),
    freeShipping: best.freeShipping,
    category: product.category || "",
    url: `https://www.mercadolivre.com.br/p/${product.id}?pdp_filters=item_id:${best.itemId}`,
    imageUrl: picture,
    marketplace: "ml"
  };
};

/** Executa em lotes de `limit` ao mesmo tempo; para no primeiro 429 e devolve o que já tiver. */
const inBatches = async <T, R>(list: T[], limit: number, work: (item: T) => Promise<R | null>): Promise<R[]> => {
  const done: R[] = [];
  for (let index = 0; index < list.length; index += limit) {
    const settled = await Promise.allSettled(list.slice(index, index + limit).map(work));
    for (const item of settled) {
      if (item.status === "fulfilled" && item.value) done.push(item.value);
    }
    if (settled.some(item => item.status === "rejected" && statusOf(item.reason) === 429)) break;
  }
  return done;
};

const statusOf = (err: unknown): number | undefined => (err as { response?: { status?: number } })?.response?.status;

/** Preço de cada produto e, só para quem tem desconto, nome e fotos. Exportada para teste. */
export const offersForProducts = async (get: MlGet, products: ProductRef[], parallel = PARALLEL): Promise<DealOffer[]> =>
  inBatches(products, parallel, async product => {
    const items = await get(`/products/${product.id}/items?limit=20`);
    const best = bestDiscountedItem(items?.results);
    if (!best) return null;
    let details = product;
    if (!details.name || !details.pictures?.length) {
      const full = await get(`/products/${product.id}`);
      details = { ...product, name: full?.name, pictures: full?.pictures };
    }
    return productOffer(details, best);
  });

/** Mais vendidos de cada categoria (só produtos de catálogo). Exportada para teste. */
export const highlightProducts = async (get: MlGet, categories: Record<string, string>, parallel = PARALLEL): Promise<ProductRef[]> => {
  const lists = await inBatches(Object.entries(categories), parallel, async ([id, name]) => {
    const data = await get(`/highlights/MLB/category/${id}`);
    const content = Array.isArray(data?.content) ? data.content : [];
    return content
      .filter((entry: any) => entry?.type === "PRODUCT" && /^MLB\d+$/.test(String(entry?.id)))
      .map((entry: any): ProductRef => ({ id: String(entry.id), category: name }));
  });
  const seen = new Set<string>();
  return lists.flat().filter(item => !seen.has(item.id) && seen.add(item.id));
};

const token = { value: "", until: 0, loading: null as Promise<string> | null };

const appToken = async (): Promise<string> => {
  if (token.value && Date.now() < token.until) return token.value;
  if (token.loading) return token.loading;
  token.loading = (async () => {
    // Parâmetros no corpo do POST, como pede a página "Desenvolvimento seguro" do ML.
    const { data } = await axios.post(
      `${API}/oauth/token`,
      new URLSearchParams({
        grant_type: "client_credentials",
        client_id: String(process.env.ML_CLIENT_ID || "").trim(),
        client_secret: String(process.env.ML_CLIENT_SECRET || "").trim()
      }).toString(),
      { headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, timeout: TIMEOUT_MS }
    );
    if (!data?.access_token) throw new Error("o ML não devolveu token para o app");
    const seconds = Math.max(120, Number(data.expires_in) || 3600);
    token.value = String(data.access_token);
    token.until = Date.now() + (seconds - 60) * 1000;
    return token.value;
  })().finally(() => {
    token.loading = null;
  });
  return token.loading;
};

const apiGet: MlGet = async path => {
  const call = async () =>
    (await axios.get(`${API}${path}`, { headers: { Authorization: `Bearer ${await appToken()}`, Accept: "application/json" }, timeout: TIMEOUT_MS })).data;
  try {
    return await call();
  } catch (err) {
    if (statusOf(err) !== 401) throw err;
    token.value = "";
    return call();
  }
};

/**
 * Só as 28 categorias de topo davam ~340 ofertas, e a empresa que publica a cada 5 min esgotava o acervo em menos
 * de 3 dias (22% de repetição em 26/10/2026). As 403 subcategorias de 2º nível somam ~3.700 produtos de catálogo.
 * Cada rodada lê um bloco de categorias e soma ao acervo; o preço é conferido de novo na hora de publicar.
 */
export const CATEGORIES_PER_LOAD = 40;
export const POOL_HOURS = 12;
const CATEGORY_LIST_MS = 24 * 3600 * 1000;

/** Categorias de topo seguidas das subcategorias de 2º nível. Exportada para teste. */
export const expandCategories = (
  top: Record<string, string>,
  children: Record<string, Array<{ id?: unknown; name?: unknown }>>
): Record<string, string> => {
  const all: Record<string, string> = { ...top };
  // Uma subcategoria de cada categoria-mãe por vez: em ordem, o primeiro bloco do rodízio pegava 12 subcategorias de
  // "Acessórios para Veículos" e o grupo recebeu cinco produtos de carro seguidos (26/10/2026).
  const lists = Object.entries(top).map(([parent, name]) => ({ name, kids: children[parent] || [] }));
  const longest = Math.max(0, ...lists.map(list => list.kids.length));
  for (let index = 0; index < longest; index += 1) {
    for (const { name, kids } of lists) {
      const child = kids[index];
      const id = String(child?.id || "");
      if (/^MLB\d+$/.test(id) && !all[id]) all[id] = `${name} > ${String(child?.name || "").trim()}`;
    }
  }
  return all;
};

/** Próximo bloco do rodízio de categorias, voltando ao começo da lista. Exportada para teste. */
export const categorySlice = (ids: string[], cursor: number, size: number): string[] => {
  if (!ids.length) return [];
  const start = ((cursor % ids.length) + ids.length) % ids.length;
  return Array.from({ length: Math.min(size, ids.length) }, (_, index) => ids[(start + index) % ids.length]);
};

/** Junta a rodada nova ao acervo e tira o que passou de POOL_HOURS. Exportada para teste. */
export const mergeOfficialPool = (
  pool: Map<string, { at: number; offer: DealOffer }>,
  fresh: DealOffer[],
  now: number
): DealOffer[] => {
  for (const offer of fresh) pool.set(offer.externalId, { at: now, offer });
  for (const [key, entry] of pool) {
    if (now - entry.at > POOL_HOURS * 3600 * 1000) pool.delete(key);
  }
  return [...pool.values()].map(entry => entry.offer);
};

const categoryList = { at: 0, all: ML_HIGHLIGHT_CATEGORIES as Record<string, string> };

const loadCategoryList = async (): Promise<Record<string, string>> => {
  if (Date.now() - categoryList.at < CATEGORY_LIST_MS) return categoryList.all;
  const children: Record<string, Array<{ id?: unknown; name?: unknown }>> = {};
  await inBatches(Object.keys(ML_HIGHLIGHT_CATEGORIES), PARALLEL, async id => {
    const detail = await apiGet(`/categories/${id}`);
    children[id] = Array.isArray(detail?.children_categories) ? detail.children_categories : [];
    return id;
  });
  const all = expandCategories(ML_HIGHLIGHT_CATEGORIES, children);
  // Sem subcategoria nenhuma (ML fora do ar), tenta de novo na próxima rodada em vez de esperar 24 h.
  if (Object.keys(all).length > Object.keys(ML_HIGHLIGHT_CATEGORIES).length) categoryList.at = Date.now();
  categoryList.all = all;
  return all;
};

/** Um acervo para todas as empresas: mais vendidos não dependem de quem pergunta. */
const catalog = { at: 0, offers: [] as DealOffer[], cursor: 0, loading: null as Promise<DealOffer[]> | null };
const officialPool = new Map<string, { at: number; offer: DealOffer }>();
const searches = new Map<string, { at: number; offers: DealOffer[] }>();

const loadCatalog = async (): Promise<DealOffer[]> => {
  if (catalog.offers.length && Date.now() - catalog.at < CACHE_MS) return catalog.offers;
  if (catalog.loading) return catalog.loading;
  catalog.loading = (async () => {
    const all = await loadCategoryList();
    const ids = Object.keys(all);
    const slice = categorySlice(ids, catalog.cursor, CATEGORIES_PER_LOAD);
    catalog.cursor = (catalog.cursor + slice.length) % Math.max(1, ids.length);
    const chosen = Object.fromEntries(slice.map(id => [id, all[id]]));
    const products = await highlightProducts(apiGet, chosen);
    const offers = await offersForProducts(apiGet, products);
    // Rodada vazia (ML fora do ar, limite) não apaga o acervo anterior.
    catalog.offers = mergeOfficialPool(officialPool, offers, Date.now());
    if (offers.length) catalog.at = Date.now();
    return catalog.offers;
  })().finally(() => {
    catalog.loading = null;
  });
  return catalog.loading;
};

const OFFICIAL_URL = /mercadolivre\.com\.br\/p\/(MLB\d+)\?pdp_filters=item_id:(MLB\d+)/;

/**
 * Oferta vinda da API oficial pode ter horas no acervo: confere o preço atual antes de publicar. Devolve a oferta
 * atualizada, null se o desconto acabou, ou a mesma oferta se não for da API oficial ou o ML não responder.
 */
export const confirmOfficialMlOffer = async (offer: DealOffer, get: MlGet = apiGet): Promise<DealOffer | null> => {
  const match = offer.url.match(OFFICIAL_URL);
  if (offer.marketplace !== "ml" || !match) return offer;
  let items: any;
  try {
    items = await get(`/products/${match[1]}/items?limit=20`);
  } catch {
    return offer;
  }
  const best = bestDiscountedItem(items?.results);
  if (!best) return null;
  const priceCents = Math.round(best.price * 100);
  const originalPriceCents = Math.round(best.original * 100);
  return {
    ...offer,
    externalId: best.itemId,
    priceCents,
    originalPriceCents,
    discountPercent: Math.round(((originalPriceCents - priceCents) / originalPriceCents) * 100),
    freeShipping: best.freeShipping,
    url: offer.url.replace(`pdp_filters=item_id:${match[2]}`, `pdp_filters=item_id:${best.itemId}`)
  };
};

const loadSearch = async (query: string): Promise<DealOffer[]> => {
  const key = query.trim().toLowerCase();
  const cached = searches.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.offers;
  const data = await apiGet(`/products/search?status=active&site_id=MLB&q=${encodeURIComponent(query.trim())}&limit=20`);
  const products: ProductRef[] = (Array.isArray(data?.results) ? data.results : [])
    .filter((row: any) => /^MLB\d+$/.test(String(row?.id)) && row?.status !== "inactive")
    .map((row: any) => ({ id: String(row.id), name: row.name, pictures: row.pictures }));
  const offers = await offersForProducts(apiGet, products);
  searches.set(key, { at: Date.now(), offers });
  if (searches.size > 200) searches.delete(searches.keys().next().value as string);
  return offers;
};

/** Com palavra-chave, busca no catálogo; sem, usa os mais vendidos das categorias e subcategorias (em rodízio). */
export const officialMlOffers = async (query: string): Promise<DealOffer[]> =>
  query.trim() ? loadSearch(query) : loadCatalog();
