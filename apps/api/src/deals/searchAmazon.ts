import crypto from "crypto";
import axios from "axios";
import { DealOffer } from "./types";

const hmac = (key: crypto.BinaryLike, data: string): Buffer =>
  crypto.createHmac("sha256", key).update(data, "utf8").digest();

const sha256 = (data: string): string =>
  crypto.createHash("sha256").update(data, "utf8").digest("hex");

/**
 * Product Advertising API 5 (SearchItems) — API oficial de associados.
 * Sem access key, secret e partner tag a busca não roda.
 */
export const searchAmazon = async (opts: {
  query: string;
  partnerTag: string;
  accessKey: string;
  secretKey: string;
}): Promise<DealOffer[]> => {
  const host = "webservices.amazon.com.br";
  const region = "us-east-1";
  const service = "ProductAdvertisingAPI";
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payload = JSON.stringify({
    Keywords: opts.query,
    SearchIndex: "All",
    ItemCount: 5,
    Resources: [
      "ItemInfo.Title",
      "Images.Primary.Large",
      "Offers.Listings.Price",
      "Offers.Listings.SavingBasis",
      "DetailPageURL"
    ],
    PartnerTag: opts.partnerTag,
    PartnerType: "Associates",
    Marketplace: "www.amazon.com.br"
  });

  const canonicalHeaders = [
    "content-encoding:amz-1.0",
    "content-type:application/json; charset=utf-8",
    `host:${host}`,
    `x-amz-date:${amzDate}`,
    "x-amz-target:com.amazon.paapi5.v1.ProductAdvertisingAPIv1.SearchItems",
    ""
  ].join("\n");
  const signedHeaders = "content-encoding;content-type;host;x-amz-date;x-amz-target";
  const canonicalRequest = [
    "POST",
    "/paapi5/searchitems",
    "",
    canonicalHeaders,
    signedHeaders,
    sha256(payload)
  ].join("\n");
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256(canonicalRequest)
  ].join("\n");
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${opts.secretKey}`, dateStamp), region), service),
    "aws4_request"
  );
  const signature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  const { data } = await axios.post(`https://${host}/paapi5/searchitems`, payload, {
    timeout: 20000,
    headers: {
      Authorization: `AWS4-HMAC-SHA256 Credential=${opts.accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      "content-encoding": "amz-1.0",
      "content-type": "application/json; charset=utf-8",
      host,
      "x-amz-date": amzDate,
      "x-amz-target": "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.SearchItems"
    }
  });

  const items = Array.isArray(data?.SearchResult?.Items) ? data.SearchResult.Items : [];
  return items
    .map((item: any): DealOffer | null => {
      const listing = item?.Offers?.Listings?.[0];
      const amount = Number(listing?.Price?.Amount);
      const basis = Number(listing?.SavingBasis?.Amount);
      const title = String(item?.ItemInfo?.Title?.DisplayValue || "").trim();
      const url = String(item?.DetailPageURL || "").trim();
      const id = String(item?.ASIN || "").trim();
      if (!id || !title || !url || !Number.isFinite(amount)) return null;
      const priceCents = Math.round(amount * 100);
      const originalPriceCents =
        Number.isFinite(basis) && basis > amount ? Math.round(basis * 100) : undefined;
      const discountPercent =
        originalPriceCents && originalPriceCents > priceCents
          ? Math.round(((originalPriceCents - priceCents) / originalPriceCents) * 100)
          : undefined;
      return {
        externalId: id,
        title,
        priceCents,
        originalPriceCents,
        discountPercent,
        url,
        imageUrl: item?.Images?.Primary?.Large?.URL,
        marketplace: "amazon"
      };
    })
    .filter(Boolean) as DealOffer[];
};
