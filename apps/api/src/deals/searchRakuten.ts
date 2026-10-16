import axios from "axios";
import { DealOffer } from "./types";

const centsOf = (raw: string): number => {
  const cleaned = String(raw || "")
    .replace(/[^\d,.-]/g, "")
    .replace(/\.(?=\d{3}(?:\D|$))/g, "")
    .replace(",", ".");
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * 100);
};

const tag = (block: string, name: string): string => {
  const match = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return match ? match[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : "";
};

/**
 * Product Search oficial da Rakuten Advertising.
 * O token sai do client id + secret; o SID é o escopo da conta.
 */
export const searchRakuten = async (opts: {
  query: string;
  clientId: string;
  clientSecret: string;
  sid: string;
}): Promise<DealOffer[]> => {
  const basic = Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString("base64");
  const tokenRes = await axios.post(
    "https://api.linksynergy.com/token",
    new URLSearchParams({ scope: opts.sid }).toString(),
    {
      headers: {
        Authorization: `Bearer ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      timeout: 15000
    }
  );
  const access = String(tokenRes.data?.access_token || "");
  if (!access) throw new Error("Rakuten não devolveu o token da API");

  const search = await axios.get("https://api.linksynergy.com/productsearch/1.0", {
    params: { keyword: opts.query || "oferta", max: 10 },
    headers: { Authorization: `Bearer ${access}` },
    timeout: 20000,
    responseType: "text"
  });
  const xml = String(search.data || "");
  const items = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  const offers: Array<DealOffer | null> = items.map(block => {
      const sale = centsOf(tag(block, "saleprice"));
      const price = centsOf(tag(block, "price"));
      const current = sale || price;
      const title = tag(block, "productname");
      const url = tag(block, "linkurl");
      if (!title || !url || !current) return null;
      const discount = price > current ? Math.round((1 - current / price) * 100) : 0;
      return {
        externalId: `rakuten-${tag(block, "sku") || tag(block, "linkid") || title}`,
        title: title.slice(0, 180),
        priceCents: current,
        originalPriceCents: price > current ? price : undefined,
        discountPercent: discount || undefined,
        url,
        imageUrl: tag(block, "imageurl") || undefined,
        marketplace: "rakuten",
        category: tag(block, "merchantname") || tag(block, "category")
      } as DealOffer;
    });
  return offers.filter((row): row is DealOffer => !!row).slice(0, 8);
};
