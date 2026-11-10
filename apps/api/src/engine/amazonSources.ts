import { q } from "../db";
import { channelList, fetchChannel, resolveAsin } from "../deals/telegramSources";

/** Quanto tempo uma promoção de fonte vale depois de postada (preço da Amazon muda no mesmo dia). */
export const SOURCE_OFFER_HOURS = 6;
const EVERY_MS = 10 * 60 * 1000;
let lastRun = 0;

/**
 * Lê os canais cadastrados no super admin e renova a fila central de promoções da Amazon (source_offers).
 * Roda no worker a cada 10 minutos. Cada canal é lido uma vez por rodada, com pausa entre eles.
 */
export const refreshAmazonSources = async (force = false): Promise<number> => {
  if (!force && Date.now() - lastRun < EVERY_MS) return 0;
  lastRun = Date.now();
  const [platform] = await q<{ amazon_sources: string }>("SELECT amazon_sources FROM platform_settings WHERE id = 1");
  const channels = channelList(platform?.amazon_sources || "");
  let saved = 0;
  for (const channel of channels) {
    let found = 0;
    let error: string | null = null;
    try {
      const posts = await fetchChannel(channel);
      const fresh = posts.filter(post => post.postedAt > Date.now() - SOURCE_OFFER_HOURS * 3600_000 && post.priceCents > 0 && post.title);
      for (const post of fresh) {
        let asin = "";
        for (const link of post.links) {
          asin = await resolveAsin(link);
          if (asin) break;
        }
        if (!asin) continue;
        await q(
          `INSERT INTO source_offers (marketplace, external_id, title, price_cents, original_price_cents, image_url, source, post_id, posted_at, expires_at)
           VALUES ('amazon', $1, $2, $3, $4, $5, $6, $7, to_timestamp($8 / 1000.0), to_timestamp($8 / 1000.0) + make_interval(hours => $9))
           ON CONFLICT (marketplace, external_id) DO UPDATE SET
             title = EXCLUDED.title, price_cents = EXCLUDED.price_cents, original_price_cents = EXCLUDED.original_price_cents,
             image_url = coalesce(EXCLUDED.image_url, source_offers.image_url), source = EXCLUDED.source, post_id = EXCLUDED.post_id,
             posted_at = EXCLUDED.posted_at, expires_at = EXCLUDED.expires_at
           WHERE EXCLUDED.posted_at >= source_offers.posted_at`,
          [asin, post.title, post.priceCents, post.originalPriceCents, post.imageUrl, channel, post.postId, post.postedAt, SOURCE_OFFER_HOURS]
        );
        found += 1;
      }
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      error = status ? `o Telegram respondeu ${status} (canal privado, inexistente ou sem página pública)` : String((err as Error).message || err).slice(0, 160);
    }
    await q(
      `INSERT INTO source_channels (name, last_read_at, last_error, last_found) VALUES ($1, now(), $2, $3)
       ON CONFLICT (name) DO UPDATE SET last_read_at = now(), last_error = $2, last_found = $3`,
      [channel, error, found]
    );
    saved += found;
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  await q("DELETE FROM source_offers WHERE expires_at < now() - interval '1 day'");
  return saved;
};
