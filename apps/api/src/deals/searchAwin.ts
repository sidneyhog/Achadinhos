import axios from "axios";
import { DealOffer } from "./types";

type AwinPromo = {
  promotionId?: number;
  title?: string;
  description?: string;
  url?: string;
  urlTracking?: string;
  advertiser?: { id?: number; name?: string };
  voucher?: { code?: string } | null;
};

/**
 * API oficial de promoções do publisher Awin.
 * https://api.awin.com/publishers/{id}/promotions
 */
export const searchAwinPromotions = async (opts: {
  publisherId: string;
  token: string;
  marketplace: string;
  advertiserId?: string;
  excludeAdvertiserIds?: string[];
}): Promise<DealOffer[]> => {
  const { data } = await axios.get(
    `https://api.awin.com/publishers/${encodeURIComponent(opts.publisherId)}/promotions`,
    {
      params: opts.advertiserId ? { advertiserId: opts.advertiserId } : undefined,
      headers: { Authorization: `Bearer ${opts.token}` },
      timeout: 20000
    }
  );
  const rows: AwinPromo[] = Array.isArray(data)
    ? data
    : Array.isArray(data?.promotions)
      ? data.promotions
      : Array.isArray(data?.data)
        ? data.data
        : [];
  const excluded = new Set(opts.excludeAdvertiserIds || []);
  return rows
    .filter(row => {
      const advertiser = String(row.advertiser?.id || "");
      if (opts.advertiserId && advertiser && advertiser !== opts.advertiserId) return false;
      if (advertiser && excluded.has(advertiser)) return false;
      return !!(row.urlTracking || row.url) && !!(row.title || row.description);
    })
    .slice(0, 8)
    .map(row => ({
      externalId: `awin-${row.promotionId || row.urlTracking || row.title}`,
      title: String(row.title || row.description || "Promoção").slice(0, 180),
      priceCents: 0,
      couponLabel: row.voucher?.code || undefined,
      url: String(row.urlTracking || row.url),
      marketplace: opts.marketplace as DealOffer["marketplace"],
      category: row.advertiser?.name || ""
    }));
};
