import { DealOffer } from "./types";

const asinOf = (value: string): string => {
  const text = String(value || "");
  const match = text.match(/\/(?:dp|gp\/product|gp\/aw\/d|d)\/([A-Z0-9]{10})(?:[/?#]|$)/i)
    || text.match(/[?&]asin=([A-Z0-9]{10})(?:&|$)/i);
  return match ? match[1].toUpperCase() : "";
};

/** Link curto da barra SiteStripe (amzn.to/xxxx): já sai da Amazon com a tag de quem gerou. */
const shortLinkOf = (value: string): string => {
  const match = String(value || "").match(/^https?:\/\/amzn\.to\/([A-Za-z0-9]{4,20})\/?$/i);
  return match ? `https://amzn.to/${match[1]}` : "";
};

/** Links que o cliente colou. A tag da conta entra no endereço. Não consulta a Amazon. */
export const amazonOffersFromLinks = (raw: unknown, partnerTag: string): DealOffer[] => {
  const tag = String(partnerTag || "").trim();
  if (!tag) return [];
  const seen = new Set<string>();
  const offers: DealOffer[] = [];
  String(raw || "").split(/\n+/).forEach(line => {
    const parts = line.split("|").map(part => part.trim()).filter(Boolean);
    const urlPart = parts.find(part => /amazon\.|amzn\.to\//i.test(part)) || "";
    if (!urlPart) return;
    const asin = asinOf(urlPart);
    const short = asin ? "" : shortLinkOf(urlPart);
    const key = asin || short;
    if (!key || seen.has(key)) return;
    seen.add(key);
    const title = parts.find(part => part !== urlPart && !/^https?:/i.test(part) && !/^\d+([.,]\d{1,2})?$/.test(part)) || "";
    const priceRaw = parts.find(part => /^\d+([.,]\d{1,2})?$/.test(part));
    const priceCents = priceRaw ? Math.round(Number(priceRaw.replace(",", ".")) * 100) : 0;
    offers.push({
      externalId: asin || short.replace("https://", ""),
      title: title.slice(0, 180) || "Oferta na Amazon",
      priceCents: Number.isFinite(priceCents) ? priceCents : 0,
      url: asin ? `https://www.amazon.com.br/dp/${asin}?tag=${encodeURIComponent(tag)}` : short,
      marketplace: "amazon",
      category: "link"
    });
  });
  return offers.slice(0, 40);
};
