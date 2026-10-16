import crypto from "crypto";
import axios from "axios";
import { DealOffer } from "./types";

/**
 * API oficial de afiliados Shopee (GraphQL productOfferV2).
 * Exige App ID e segredo do painel de afiliados.
 */
export const searchShopee = async (opts: {
  query: string;
  appId: string;
  secret: string;
}): Promise<DealOffer[]> => {
  const keyword = opts.query.replace(/"/g, "");
  const body = JSON.stringify({
    query: `{
      productOfferV2(keyword: "${keyword}", listType: 0, sortType: 2, page: 1, limit: 5) {
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

  if (data?.errors?.length) {
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
        marketplace: "shopee"
      };
    })
    .filter(Boolean) as DealOffer[];
};
