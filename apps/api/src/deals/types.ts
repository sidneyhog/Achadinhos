export type DealMarketplace =
  | "ml"
  | "amazon"
  | "shopee"
  | "aliexpress"
  | "magalu"
  | "terabyte"
  | "awin"
  | "rakuten"
  | "samsung"
  | "casasbahia"
  | "natura"
  | "paguemenos"
  | "epoca"
  | "shein";

export type DealOffer = {
  externalId: string;
  title: string;
  priceCents: number;
  originalPriceCents?: number;
  discountPercent?: number;
  freeShipping?: boolean;
  couponLabel?: string;
  pix?: boolean;
  soldQuantity?: number;
  rating?: number;
  category?: string;
  url: string;
  imageUrl?: string;
  marketplace: DealMarketplace;
  score?: number;
  /** Oferta relâmpago ou com prazo curto. Dentro da loja, sai antes das outras. */
  urgent?: boolean;
};

export const scoreOffer = (offer: DealOffer): number => {
  let score = 0;
  const discount = Number(offer.discountPercent) || 0;
  if (discount >= 40) score += 30;
  else if (discount >= 25) score += 20;
  else if (discount >= 10) score += 8;
  if (offer.freeShipping) score += 15;
  if (offer.couponLabel) score += 12;
  if (offer.pix) score += 5;
  if ((offer.soldQuantity || 0) >= 50) score += 10;
  if ((offer.rating || 0) >= 4.5) score += 10;
  return score;
};

export const formatDealBRL = (cents: number): string =>
  (Number(cents || 0) / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL"
  });

export const marketplaceLabel = (marketplace: string): string => {
  if (marketplace === "ml") return "Mercado Livre";
  if (marketplace === "amazon") return "Amazon";
  if (marketplace === "shopee") return "Shopee";
  if (marketplace === "aliexpress") return "AliExpress";
  if (marketplace === "magalu") return "Magalu";
  if (marketplace === "terabyte") return "Terabyte";
  if (marketplace === "awin") return "Awin";
  if (marketplace === "rakuten") return "Rakuten Advertising";
  if (marketplace === "samsung") return "Clube Samsung";
  if (marketplace === "casasbahia") return "Casas Bahia";
  if (marketplace === "natura") return "Natura";
  if (marketplace === "paguemenos") return "Pague Menos";
  if (marketplace === "epoca") return "Época Cosméticos";
  if (marketplace === "shein") return "Shein";
  return marketplace;
};
