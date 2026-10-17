import { DealOffer, formatDealBRL, marketplaceLabel } from "./types";

const discountOf = (offer: DealOffer): number => {
  const hasOldPrice = Boolean(offer.originalPriceCents && offer.priceCents > 0 && offer.originalPriceCents > offer.priceCents);
  return offer.discountPercent || (hasOldPrice ? Math.round((1 - offer.priceCents / (offer.originalPriceCents || offer.priceCents)) * 100) : 0);
};

const hasOldPrice = (offer: DealOffer) =>
  Boolean(offer.originalPriceCents && offer.priceCents > 0 && offer.originalPriceCents > offer.priceCents);

/** Legenda dos grupos (formato de sempre). Vai como texto; a imagem chega pela prévia do link. */
export const groupCaption = (offer: DealOffer, url: string) => {
  const lines = ["🔥 OFERTA ENCONTRADA", "", `📦 ${offer.title}`];
  const priceLines: string[] = [];
  if (hasOldPrice(offer)) priceLines.push(`💰 De: ${formatDealBRL(offer.originalPriceCents || 0)}`);
  if (offer.priceCents > 0) priceLines.push(`🔥 Por: ${formatDealBRL(offer.priceCents)}`);
  const discount = discountOf(offer);
  if (discount > 0) priceLines.push("", `📉 Desconto: ${discount}%`);
  if (offer.couponLabel) priceLines.push(`🎟️ Cupom: ${offer.couponLabel}`);
  if (offer.freeShipping) priceLines.push("🚚 Frete grátis");
  if (priceLines.length) lines.push("", ...priceLines);
  lines.push("", `🏪 ${marketplaceLabel(offer.marketplace)}`, "", "🛒 Comprar:", url, "", "⏳ Oferta sujeita a alteração sem aviso.");
  return lines.join("\n");
};

// Palavras que costumam encerrar a parte útil do título (cor, voltagem, códigos de modelo).
const COLORS = /^(preto|preta|branco|branca|cinza|prata|azul|vermelho|vermelha|rosa|verde|amarelo|amarela|dourado|dourada|bege|marrom|grafite|inox)$/i;
const VOLTAGE = /^(bivolt|\d{3}v|\d{3}\/\d{3}v?)$/i;
const MODEL_CODE = /^(?=.*\d)(?=.*[a-z])[a-z0-9-]{5,}$/i; // ex.: Pfr2200p, SM-A155M
const UNIT = /^\d+([.,]\d+)?(l|ml|kg|g|w|gb|tb|mah|pol|"|cm|mm|m)$/i; // 6,5l, 128gb, 1200w: não é código

/** Título curto em maiúsculas para o Status: sem código de modelo, voltagem e cor, até ~40 caracteres. */
export const shortTitle = (title: string, max = 40) => {
  const words = String(title || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const kept = words.filter(word => !VOLTAGE.test(word) && !COLORS.test(word) && (UNIT.test(word) || !MODEL_CODE.test(word)));
  let out = "";
  for (const word of kept.length ? kept : words) {
    const next = out ? `${out} ${word}` : word;
    if (next.length > max) break;
    out = next;
  }
  return (out || words.join(" ").slice(0, max)).toLocaleUpperCase("pt-BR");
};

/** Texto curto do Status (formato aprovado pelo cliente). */
export const statusCaption = (offer: DealOffer, url: string) => {
  const lines = [`🔥 ${shortTitle(offer.title)} 🔥`, ""];
  if (offer.priceCents > 0) {
    lines.push(hasOldPrice(offer)
      ? `💰 De ${formatDealBRL(offer.originalPriceCents || 0)} por ${formatDealBRL(offer.priceCents)}`
      : `💰 Por apenas ${formatDealBRL(offer.priceCents)}`);
  }
  const discount = discountOf(offer);
  if (discount > 0 && offer.freeShipping) lines.push(`📉 ${discount}% OFF + FRETE GRÁTIS 🚚`);
  else if (discount > 0) lines.push(`📉 ${discount}% OFF`);
  else if (offer.freeShipping) lines.push("🚚 FRETE GRÁTIS");
  if (offer.couponLabel) lines.push(`🎟️ Cupom: ${offer.couponLabel}`);
  lines.push("", "🛒 Garanta a sua aqui 👇", url, "", "⏳ Oferta sujeita a alteração.");
  return lines.join("\n");
};

/** Título e descrição do cartão de prévia do link. */
export const previewText = (offer: DealOffer) => {
  const parts: string[] = [];
  if (offer.priceCents > 0) parts.push(`Por ${formatDealBRL(offer.priceCents)}`);
  const discount = discountOf(offer);
  if (discount > 0) parts.push(`${discount}% OFF`);
  if (offer.freeShipping) parts.push("Frete grátis");
  return { title: offer.title.slice(0, 120), description: parts.join(" · ") || marketplaceLabel(offer.marketplace) };
};

/** A prévia do WhatsApp aceita só JPEG. */
export const isJpeg = (bytes: Uint8Array) => bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

/** Endereços a tentar para conseguir a imagem em JPEG (o ML serve .webp e .jpg no mesmo caminho). */
export const jpegCandidates = (imageUrl: string) => {
  const list = [imageUrl];
  if (/\.webp(\?|$)/i.test(imageUrl)) list.push(imageUrl.replace(/\.webp(\?|$)/i, ".jpg$1"));
  return [...new Set(list)];
};
