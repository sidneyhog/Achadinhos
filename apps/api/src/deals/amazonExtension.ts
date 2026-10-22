import { DealOffer } from "./types";

/**
 * Botão "Enviar ao Achadinhos" da extensão na página do produto da Amazon. A empresa escolhe o produto no próprio
 * navegador e a extensão manda ASIN, nome, preço e foto. Enquanto a Creators API não libera (10 vendas em 30 dias),
 * é o jeito de ter ofertas da Amazon sem colar link por link.
 */

/** Preço da Amazon muda no mesmo dia: o produto sai da fila depois disto. */
export const AMAZON_ITEM_HOURS = 24;
/** Teto de produtos ativos por empresa na fila. */
export const AMAZON_QUEUE_MAX = 200;

export type AmazonItem = {
  asin: string;
  title: string;
  priceCents: number;
  originalPriceCents: number | null;
  imageUrl: string | null;
};

const cents = (value: unknown): number | null => {
  const number = Math.round(Number(value));
  return Number.isFinite(number) && number > 0 && number < 100_000_000 ? number : null;
};

/** Confere o que a extensão mandou. Devolve null se não der para publicar com segurança. Exportada para teste. */
export const readAmazonItem = (body: unknown): AmazonItem | null => {
  const raw = (body || {}) as Record<string, unknown>;
  const asin = String(raw.asin || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(asin)) return null;
  const title = String(raw.title || "").replace(/\s+/g, " ").trim().slice(0, 180);
  if (title.length < 3) return null;
  const priceCents = cents(raw.priceCents);
  if (!priceCents) return null;
  const original = cents(raw.originalPriceCents);
  const image = String(raw.imageUrl || "").trim();
  // Só foto do CDN da Amazon: o endereço vai para o WhatsApp e não pode apontar para qualquer lugar.
  const imageUrl = /^https:\/\/[a-z0-9.-]*media-amazon\.com\/images\/[\w%+./-]+\.(jpg|jpeg|png|webp)$/i.test(image) ? image : null;
  return { asin, title, priceCents, originalPriceCents: original && original > priceCents ? original : null, imageUrl };
};

/** Linha da fila vira oferta com a tag da empresa. Exportada para teste. */
export const amazonQueueOffer = (
  row: { external_id: string; title: string; price_cents: number; original_price_cents: number | null; image_url: string | null },
  partnerTag: string
): DealOffer => {
  const original = row.original_price_cents && row.original_price_cents > row.price_cents ? row.original_price_cents : undefined;
  return {
    externalId: row.external_id,
    title: row.title,
    priceCents: row.price_cents,
    originalPriceCents: original,
    discountPercent: original ? Math.round(((original - row.price_cents) / original) * 100) : undefined,
    url: `https://www.amazon.com.br/dp/${row.external_id}?tag=${encodeURIComponent(partnerTag)}`,
    imageUrl: row.image_url || undefined,
    marketplace: "amazon",
    category: "extensão"
  };
};
