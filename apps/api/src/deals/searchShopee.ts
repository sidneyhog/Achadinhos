import crypto from "crypto";
import axios from "axios";
import { DealOffer } from "./types";

const SHOPEE_ATTEMPTS = 3;
const SHOPEE_RETRY_MS = 1500;

/** Erro passageiro da Open API da Shopee (código 10000, "System Error"): vale tentar de novo. Exportada para teste. */
export const shopeeTransientError = (error: unknown): boolean => {
  const value = error as { message?: unknown; extensions?: { code?: unknown } } | null;
  const text = `${value?.extensions?.code ?? ""} ${value?.message ?? ""}`;
  return /\b10000\b|system error/i.test(text);
};

/**
 * Buscas que o robô alterna quando a empresa não tem campanha da Shopee. Antes era sempre "oferta", página 1,
 * 5 produtos: a mesma lista toda vez, e depois de alguns dias a regra de repetição barrava tudo (11/11/2026).
 */
export const SHOPEE_KEYWORDS = [
  "cozinha", "organizador", "fone bluetooth", "carregador", "capinha celular", "smartwatch", "maquiagem",
  "skincare", "perfume", "camiseta", "tênis", "bolsa", "relógio", "brinquedo", "pet", "ferramenta",
  "decoração", "luminária", "jogo de cama", "toalha", "garrafa térmica", "academia", "bebê", "papelaria",
  "panela", "ventilador", "limpeza", "banheiro", "cabelo", "óculos de sol", "mochila", "jardim"
];
const SHOPEE_PAGES = 3;
const SHOPEE_LIMIT = 20;

/** Escolhe a busca desta rodada: a campanha (se houver) ou uma palavra da lista, numa página de 1 a 3. Exportada para teste. */
export const shopeeSearchPlan = (query: string, random: () => number = Math.random) => {
  const custom = query.replace(/"/g, "").trim();
  const keyword = custom && custom.toLowerCase() !== "oferta"
    ? custom
    : SHOPEE_KEYWORDS[Math.floor(random() * SHOPEE_KEYWORDS.length) % SHOPEE_KEYWORDS.length];
  const page = 1 + (Math.floor(random() * SHOPEE_PAGES) % SHOPEE_PAGES);
  return { keyword, page };
};

/**
 * API oficial de afiliados Shopee (GraphQL productOfferV2).
 * Exige App ID e segredo do painel de afiliados.
 */
export const searchShopee = async (opts: {
  query: string;
  appId: string;
  secret: string;
}): Promise<DealOffer[]> => {
  const { keyword, page } = shopeeSearchPlan(opts.query);
  const body = JSON.stringify({
    query: `{
      productOfferV2(keyword: "${keyword}", listType: 0, sortType: 2, page: ${page}, limit: ${SHOPEE_LIMIT}) {
        nodes {
          itemId
          productName
          offerLink
          imageUrl
          priceMin
        }
      }
    }`
  });
  // Cada tentativa assina de novo (o timestamp entra na assinatura).
  const request = async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = crypto
      .createHash("sha256")
      .update(`${opts.appId}${timestamp}${body}${opts.secret}`)
      .digest("hex");
    const { data } = await axios.post(
      "https://open-api.affiliate.shopee.com.br/graphql",
      body,
      {
        timeout: 20000,
        headers: {
          "Content-Type": "application/json",
          Authorization: `SHA256 Credential=${opts.appId}, Timestamp=${timestamp}, Signature=${signature}`
        }
      }
    );
    return data;
  };

  // "error [10000]: System Error" é instabilidade do lado da Shopee: a mesma credencial publicou minutos depois
  // (10/11/2026). Tenta mais duas vezes antes de desistir, em vez de derrubar a rodada da Shopee na primeira falha.
  let data: any = null;
  for (let attempt = 0; attempt < SHOPEE_ATTEMPTS; attempt += 1) {
    try {
      data = await request();
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (attempt < SHOPEE_ATTEMPTS - 1 && (!status || status >= 500)) {
        await new Promise(resolve => setTimeout(resolve, SHOPEE_RETRY_MS * (attempt + 1)));
        continue;
      }
      throw err;
    }
    if (!data?.errors?.length) break;
    if (attempt < SHOPEE_ATTEMPTS - 1 && shopeeTransientError(data.errors[0])) {
      await new Promise(resolve => setTimeout(resolve, SHOPEE_RETRY_MS * (attempt + 1)));
      continue;
    }
    throw new Error(String(data.errors[0]?.message || "Shopee recusou a consulta"));
  }

  const nodes = data?.data?.productOfferV2?.nodes;
  const list = Array.isArray(nodes) ? nodes : [];
  return list
    .map((node: any): DealOffer | null => {
      const id = String(node?.itemId || "").trim();
      const title = String(node?.productName || "").trim();
      const url = String(node?.offerLink || "").trim();
      const price = Number(String(node?.priceMin || "").replace(",", "."));
      if (!id || !title || !url || !Number.isFinite(price)) return null;
      return {
        externalId: id,
        title,
        priceCents: Math.round(price * 100),
        url,
        imageUrl: node?.imageUrl ? String(node.imageUrl) : undefined,
        category: keyword,
        marketplace: "shopee"
      };
    })
    .filter(Boolean) as DealOffer[];
};
