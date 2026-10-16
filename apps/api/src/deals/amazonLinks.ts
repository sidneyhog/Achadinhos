import { DealOffer } from "./types";

const asinOf = (value: string): string => {
  const text = String(value || "");
  const match = text.match(/\/(?:dp|gp\/product|gp\/aw\/d|d)\/([A-Z0-9]{10})(?:[/?#]|$)/i)
    || text.match(/[?&]asin=([A-Z0-9]{10})(?:&|$)/i);
  return match ? match[1].toUpperCase() : "";
};

/** Links que o cliente colou. A tag da conta entra no endereço. Não consulta a Amazon. */
export const amazonOffersFromLinks = (raw: unknown, partnerTag: string): DealOffer[] => {
  const tag = String(partnerTag || "").trim();
  if (!tag) return [];
  const seen = new Set<string>();
  const offers: DealOffer[] = [];
  String(raw || "").split(/\n+/).forEach(line => {
    const parts = line.split("|").map(part => part.trim()).filter(Boolean);
    const urlPart = parts.find(part => /amazon\./i.test(part)) || "";
    if (!urlPart) return;
    const asin = asinOf(urlPart);
    if (!asin || seen.has(asin)) return;
    seen.add(asin);
    const title = parts.find(part => part !== urlPart && !/^https?:/i.test(part) && !/^\d+([.,]\d{1,2})?$/.test(part)) || "";
    const priceRaw = parts.find(part => /^\d+([.,]\d{1,2})?$/.test(part));
    const priceCents = priceRaw ? Math.round(Number(priceRaw.replace(",", ".")) * 100) : 0;
    offers.push({
      externalId: asin,
      title: title.slice(0, 180) || "Oferta na Amazon",
      priceCents: Number.isFinite(priceCents) ? priceCents : 0,
      url: `https://www.amazon.com.br/dp/${asin}?tag=${encodeURIComponent(tag)}`,
      marketplace: "amazon",
      category: "link"
    });
  });
  return offers.slice(0, 40);
};
