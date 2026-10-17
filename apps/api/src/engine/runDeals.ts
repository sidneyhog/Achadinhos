import crypto from "node:crypto";
import axios from "axios";
import { audit, q } from "../db";
import { withLock } from "../locks";
import { decrypt } from "../secrets";
import { getLive, sendStatus, sendTextWithPreview, type LinkPreview } from "../zapo/session";
import { groupCaption, isJpeg, jpegCandidates, previewText, statusCaption } from "../deals/messages";
import { searchMercadoLivre, offerEndsSoonText } from "../deals/searchMercadoLivre";
import { searchAmazon } from "../deals/searchAmazon";
import { amazonOffersFromLinks } from "../deals/amazonLinks";
import { searchShopee } from "../deals/searchShopee";
import { searchAliExpress } from "../deals/searchAliExpress";
import { searchAwinPromotions } from "../deals/searchAwin";
import { searchRakuten } from "../deals/searchRakuten";
import { searchLomadee } from "../deals/searchLomadee";
import { cadenceSeconds, readSendCadence } from "../deals/sendCadence";
import { insideSchedule } from "../deals/schedule";
import { STATUS_JID, STATUS_LIMITS, statusRecipients } from "../deals/statusPolicy";
import {
  createOfficialMlLink,
  resolveMlTracking,
  stripMlTracking
} from "../deals/mlAffiliate";
import { DealOffer, marketplaceLabel, scoreOffer } from "../deals/types";

type Setting = {
  company_id: number;
  enabled: boolean;
  hour_start: number | null;
  hour_end: number | null;
  allowed_days: string;
  min_discount: number | null;
  min_price_cents: number | null;
  max_price_cents: number | null;
  allowed_categories: string;
  banned_words: string;
  blocked_categories: string;
  send_all_groups: boolean;
  random_catalog: boolean;
  posts_per_cycle: number;
  interval_seconds: number;
  send_cadence: Record<string, number> | string;
  ml_tag: string;
  ml_matt_tool: string;
  ml_matt_word: string;
  ml_official: boolean;
  ml_cookie_enc: string;
};

type StoreRow = {
  marketplace: string;
  enabled: boolean;
  public_config: Record<string, string>;
  secrets_enc: string;
};

type Campaign = {
  marketplace: string;
  query: string;
  min_discount: number | null;
  max_price_cents: number | null;
  priority: number;
};

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const wordsOf = (raw: string) =>
  String(raw || "")
    .split(/[,;\n]/)
    .map(item => item.trim().toLowerCase())
    .filter(Boolean);

const secretsOf = (row: StoreRow): Record<string, string> => {
  const raw = decrypt(row.secrets_enc);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
};

/** Texto dos grupos e do Telegram (formato de sempre). */
const caption = groupCaption;

/** Baixa a imagem do produto em JPEG (a prévia do link e o Status exigem JPEG). Devolve undefined se não conseguir. */
const loadJpeg = async (imageUrl?: string): Promise<Uint8Array | undefined> => {
  if (!imageUrl || !/^https:\/\//i.test(imageUrl)) return undefined;
  for (const candidate of jpegCandidates(imageUrl)) {
    try {
      const response = await axios.get(candidate, { responseType: "arraybuffer", timeout: 15000, maxContentLength: 4 * 1024 * 1024 });
      const bytes = new Uint8Array(response.data);
      if (isJpeg(bytes)) return bytes;
    } catch {
      /* tenta o próximo formato */
    }
  }
  return undefined;
};

const passes = (offer: DealOffer, setting: Setting) => {
  const title = offer.title.toLowerCase();
  if (wordsOf(setting.banned_words).some(word => title.includes(word))) return false;
  if (offer.priceCents > 0 && setting.min_price_cents && offer.priceCents < setting.min_price_cents) return false;
  if (offer.priceCents > 0 && setting.max_price_cents && offer.priceCents > setting.max_price_cents) return false;
  if (setting.min_discount && (offer.discountPercent || 0) < setting.min_discount) return false;
  const blocked = wordsOf(setting.blocked_categories);
  const hay = `${title} ${offer.category || ""}`;
  if (blocked.some(word => hay.includes(word))) return false;
  return true;
};

const textMatches = (offer: DealOffer, categories: string) => {
  const words = wordsOf(categories);
  if (!words.length) return true;
  const hay = `${offer.title} ${offer.category || ""}`.toLowerCase();
  return words.some(word => hay.includes(word));
};

/** Participantes dos grupos da conexão: é quem vai ver o Status. */
const loadStatusRecipients = async (whatsappId: number, groups: Array<{ group_jid: string }>) => {
  const session = getLive(whatsappId);
  const query = session?.client.group?.queryGroupMetadata;
  if (!session || !query) return [];
  const creds = session.client.getCredentials?.() || session.client.auth?.getCredentials?.() || null;
  const participants: Array<{ id?: string; jid?: string; lid?: string }> = [];
  for (const group of groups) {
    try {
      const meta = await query(group.group_jid);
      participants.push(...(meta.participants || []));
    } catch {
      /* grupo sem leitura: segue com os outros */
    }
  }
  return statusRecipients(participants, [creds?.meJid || "", creds?.meLid || ""]);
};

/** Intervalo do Status por loja; sem valor salvo, 1 hora (o mesmo padrão mostrado no painel). */
const statusWait = (cadence: Record<string, number>, marketplace: string) => cadence[marketplace] || 3600;

/** Quem vê o Status: participantes dos grupos da conexão + contatos da Base (sem bloqueados), sem repetir. */
const statusAudience = async (companyId: number, whatsappId: number, groups: Array<{ group_jid: string }>) => {
  const fromGroups = groups.length ? await loadStatusRecipients(whatsappId, groups) : [];
  const contacts = await q<{ phone: string }>(
    "SELECT phone FROM contacts WHERE company_id = $1 AND blocked = false AND anonymized_at IS NULL AND phone ~ '^[0-9]{10,15}$' ORDER BY updated_at DESC LIMIT $2",
    [companyId, STATUS_LIMITS.maxRecipients]
  );
  const own = getLive(whatsappId)?.client;
  const creds = own?.getCredentials?.() || own?.auth?.getCredentials?.() || null;
  const extra = statusRecipients(contacts.map(row => ({ jid: `${row.phone}@s.whatsapp.net` })), [creds?.meJid || ""]);
  // O Status sai pelo LID da conta; o WhatsApp recusa (erro 400) lista com número de telefone misturado.
  // Converte os números para LID e descarta quem não tem LID conhecido.
  const lids = new Set<string>();
  const phones: string[] = [];
  for (const jid of [...fromGroups, ...extra]) {
    if (jid.endsWith("@lid")) lids.add(jid);
    else phones.push(jid.split("@")[0]);
  }
  const lookup = own?.profile?.getLidsByPhoneNumbers;
  if (lookup) {
    for (let i = 0; i < phones.length && lids.size < STATUS_SEND_CAP; i += 100) {
      try {
        const found = await lookup(phones.slice(i, i + 100));
        for (const row of found) {
          if (row.exists !== false && row.lidJid) lids.add(`${row.lidJid.split("@")[0].split(":")[0]}@lid`);
        }
      } catch {
        /* lote sem resposta: segue com os outros */
      }
    }
  }
  const meLid = String(creds?.meLid || "").split("@")[0].split(":")[0];
  return [...lids].filter(jid => jid.split("@")[0] !== meLid).slice(0, STATUS_SEND_CAP);
};

/** Até quantas pessoas um Status vai: listas grandes demais também são recusadas pelo WhatsApp. */
const STATUS_SEND_CAP = 1000;

const AWIN: Record<string, string> = {
  samsung: "58389",
  casasbahia: "85979",
  natura: "17658",
  paguemenos: "64086"
};

const fetchOffers = async (
  marketplace: string,
  query: string,
  setting: Setting,
  stores: Map<string, StoreRow>,
  ml: Awaited<ReturnType<typeof resolveMlTracking>> | null
): Promise<DealOffer[]> => {
  const store = stores.get(marketplace);
  const secret = store ? secretsOf(store) : {};
  const pub = store?.public_config || {};
  if (marketplace === "ml") {
    if (!ml) throw new Error("Mercado Livre sem código de afiliado");
    return searchMercadoLivre(query, ml, decrypt(setting.ml_cookie_enc || ""));
  }
  if (marketplace === "amazon") {
    const links = amazonOffersFromLinks(secret.links || pub.links || "", pub.partnerTag || secret.partnerTag || "");
    if (secret.partnerTag && secret.accessKey && secret.secretKey) {
      try {
        const found = await searchAmazon({
          query,
          partnerTag: secret.partnerTag,
          accessKey: secret.accessKey,
          secretKey: secret.secretKey
        });
        return [...found, ...links];
      } catch (err) {
        if (links.length) return links;
        throw err;
      }
    }
    return links;
  }
  if (marketplace === "shopee") {
    // O painel salva o App ID em public_config e só o Secret nos segredos.
    const appId = secret.appId || pub.appId || "";
    if (!appId || !secret.secret) throw new Error(`Shopee publica com App ID e Secret (falta ${!appId ? "o App ID" : "o Secret"})`);
    return searchShopee({ query: query || "oferta", appId, secret: secret.secret });
  }
  if (marketplace === "aliexpress") {
    return searchAliExpress({
      query,
      companyId: setting.company_id,
      // App Key e Tracking ID ficam em public_config (formulário do painel); o Secret, nos segredos.
      appKey: secret.appKey || pub.appKey,
      appSecret: secret.appSecret,
      trackingId: secret.trackingId || pub.trackingId
    });
  }
  if (marketplace === "awin" || AWIN[marketplace]) {
    const awin = stores.get("awin");
    const awinSecret = awin ? secretsOf(awin) : {};
    const publisherId = awin?.public_config?.publisherId || secret.publisherId || "";
    const token = secret.token || awinSecret.token || "";
    if (!publisherId || !token) throw new Error("Awin precisa do publisher e do token");
    return searchAwinPromotions({
      publisherId,
      token,
      marketplace,
      advertiserId: AWIN[marketplace],
      excludeAdvertiserIds: marketplace === "awin" ? Object.values(AWIN) : undefined
    });
  }
  if (marketplace === "rakuten") {
    if (!secret.clientId || !secret.clientSecret || !pub.sid) throw new Error("Rakuten incompleta");
    return searchRakuten({ query, clientId: secret.clientId, clientSecret: secret.clientSecret, sid: pub.sid });
  }
  if (marketplace === "epoca") {
    if (!secret.apiKey) throw new Error("Época precisa da chave Lomadee");
    return searchLomadee({ apiKey: secret.apiKey, brand: "epoca", marketplace: "epoca" });
  }
  return [];
};

const subscriptionOpen = (row: { status: string; company_status: string; trial_ends_at: string | null; current_period_end: string | null; sub_status: string }) => {
  if (row.company_status !== "active") return false;
  if (row.sub_status === "trialing") return !row.trial_ends_at || new Date(row.trial_ends_at) > new Date();
  if (row.sub_status === "active") return !row.current_period_end || new Date(row.current_period_end) > new Date();
  return false;
};

export const runDueDeals = async (onlyCompanyId?: number): Promise<number> => {
  const companies = await q<{
    id: number;
    company_status: string;
    sub_status: string;
    trial_ends_at: string | null;
    current_period_end: string | null;
    max_posts_per_day: number | null;
    max_posts_per_month: number | null;
  }>(
    `SELECT c.id, c.status AS company_status, s.status AS sub_status, s.trial_ends_at, s.current_period_end, p.max_posts_per_day, p.max_posts_per_month
     FROM companies c
     JOIN subscriptions s ON s.company_id = c.id
     JOIN plans p ON p.id = s.plan_id
     WHERE ($1::int IS NULL OR c.id = $1)`,
    [onlyCompanyId ?? null]
  );

  let sent = 0;
  for (const company of companies) {
   const before = sent;
   const ran = await withLock(`deals:${company.id}`, 90, async () => {
   await (async () => {
   try {
    if (!subscriptionOpen({ ...company, status: company.sub_status })) {
      if (company.sub_status === "trialing" && company.trial_ends_at && new Date(company.trial_ends_at) <= new Date()) {
        await q("UPDATE subscriptions SET status = 'past_due', updated_at = now() WHERE company_id = $1 AND status = 'trialing'", [company.id]);
      }
      return;
    }
    const setting = await q<Setting>("SELECT * FROM settings WHERE company_id = $1", [company.id]);
    const current = setting[0];
    if (!current?.enabled) return;
    if (!insideSchedule({ hourStart: current.hour_start, hourEnd: current.hour_end, allowedDays: current.allowed_days })) {
      await q("UPDATE settings SET last_error = $2, updated_at = now() WHERE company_id = $1", [company.id, "Fora do horário ou do dia permitido"]);
      return;
    }
    if (company.max_posts_per_day) {
      const [{ count }] = await q<{ count: string }>(
        `SELECT count(*)::text AS count FROM posts WHERE company_id = $1 AND status = 'sent' AND created_at >= (date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')`,
        [company.id]
      );
      if (Number(count) >= company.max_posts_per_day) {
        await q("UPDATE settings SET last_error = $2 WHERE company_id = $1", [company.id, "Limite diário de publicações do plano"]);
        return;
      }
    }
    if (company.max_posts_per_month) {
      const [{ count }] = await q<{ count: string }>(
        `SELECT count(*)::text AS count FROM posts WHERE company_id = $1 AND status = 'sent' AND created_at >= (date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')`,
        [company.id]
      );
      if (Number(count) >= company.max_posts_per_month) {
        await q("UPDATE settings SET last_error = $2 WHERE company_id = $1", [company.id, "Limite mensal de publicações do plano"]);
        return;
      }
    }

    const storeRows = await q<StoreRow>("SELECT marketplace, enabled, public_config, secrets_enc FROM stores WHERE company_id = $1 AND enabled = true", [company.id]);
    const stores = new Map(storeRows.map(row => [row.marketplace, row]));
    let campaigns = await q<Campaign>(
      "SELECT marketplace, query, min_discount, max_price_cents, priority FROM campaigns WHERE company_id = $1 AND enabled = true ORDER BY priority DESC, id ASC",
      [company.id]
    );
    if (current.random_catalog) {
      campaigns = campaigns.filter(item => item.marketplace !== "ml");
      if (stores.has("ml")) campaigns = [{ marketplace: "ml", query: "", min_discount: null, max_price_cents: null, priority: 0 }, ...campaigns];
    }
    for (const id of ["shopee", "amazon", "aliexpress", "awin", "rakuten", "epoca", "samsung", "casasbahia", "natura", "paguemenos"]) {
      if (stores.has(id) && !campaigns.some(item => item.marketplace === id)) {
        campaigns.push({ marketplace: id, query: "", min_discount: null, max_price_cents: null, priority: 0 });
      }
    }
    if (!campaigns.length) return;

    const sessions = await q<{
      id: number;
      stores: string[];
      status: string;
      send_cadence: Record<string, number> | null;
      interval_seconds: number | null;
      posts_per_cycle: number | null;
      status_enabled: boolean;
      status_per_day: number | null;
      status_cadence: Record<string, number> | null;
      status_per_cycle: number | null;
      status_stores: string[] | null;
    }>(
      `SELECT id, stores, status, send_cadence, interval_seconds, posts_per_cycle,
              status_enabled, status_per_day, status_cadence, status_per_cycle, status_stores
       FROM whatsapp_sessions WHERE company_id = $1 AND enabled = true`,
      [company.id]
    );
    const groups = await q<{ group_jid: string; name: string; categories: string; whatsapp_id: number | null; enabled: boolean }>(
      "SELECT group_jid, name, categories, whatsapp_id, enabled FROM groups WHERE company_id = $1 AND enabled = true AND whatsapp_id IS NOT NULL",
      [company.id]
    );
    const publishers: Array<{
      id: number;
      stores: string[];
      groups: Array<{ group_jid: string; name: string; categories: string }>;
      cadence: ReturnType<typeof readSendCadence>;
      intervalMs: number;
      perCycle: number;
      lastSent: Map<string, number>;
      posted: Map<string, number>;
      failed: boolean;
    }> = [];
    // Status: publicador próprio da conexão, com lojas, intervalo por loja, ofertas por vez e máximo por dia.
    const statusPubs: Array<{
      id: number;
      stores: string[];
      groups: Array<{ group_jid: string }>;
      cadence: ReturnType<typeof readSendCadence>;
      intervalMs: number;
      perCycle: number;
      perDay: number;
      sentToday: number;
      lastSent: Map<string, number>;
      posted: Map<string, number>;
      recipients: string[] | null;
      failed: boolean;
    }> = [];
    for (const session of sessions) {
      if (session.status !== "connected" || !getLive(session.id)) continue;
      const mine = groups.filter(group => Number(group.whatsapp_id) === session.id);
      if (session.status_enabled) {
        const statusRows = await q<{ marketplace: string; last_at: string; today: string }>(
          `SELECT marketplace, max(created_at) AS last_at,
                  count(*) FILTER (WHERE created_at >= (date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'))::text AS today
           FROM posts WHERE company_id = $1 AND whatsapp_id = $2 AND group_jid = $3 AND status = 'sent' GROUP BY marketplace`,
          [company.id, session.id, STATUS_JID]
        );
        statusPubs.push({
          id: session.id,
          stores: session.status_stores || [],
          groups: mine,
          cadence: readSendCadence(session.status_cadence || {}),
          intervalMs: Math.min(180, Math.max(5, Number(session.interval_seconds ?? current.interval_seconds) || 20)) * 1000,
          perCycle: Math.min(5, Math.max(1, Number(session.status_per_cycle) || 1)),
          perDay: Math.min(STATUS_LIMITS.maxPerDay, Math.max(1, Number(session.status_per_day) || STATUS_LIMITS.defaultPerDay)),
          sentToday: statusRows.reduce((sum, row) => sum + Number(row.today || 0), 0),
          lastSent: new Map(statusRows.map(row => [row.marketplace, new Date(row.last_at).getTime()])),
          posted: new Map(),
          recipients: null,
          failed: false
        });
      }
      if (!mine.length) continue;
      const own = session.send_cadence && Object.keys(session.send_cadence).length ? session.send_cadence : current.send_cadence;
      const lastRows = await q<{ marketplace: string; last_at: string }>(
        "SELECT marketplace, max(created_at) AS last_at FROM posts WHERE company_id = $1 AND whatsapp_id = $2 AND status = 'sent' AND group_jid <> $3 GROUP BY marketplace",
        [company.id, session.id, STATUS_JID]
      );
      publishers.push({
        id: session.id,
        stores: session.stores || [],
        groups: mine,
        cadence: readSendCadence(own),
        intervalMs: Math.min(180, Math.max(5, Number(session.interval_seconds ?? current.interval_seconds) || 20)) * 1000,
        perCycle: Math.min(5, Math.max(1, Number(session.posts_per_cycle ?? current.posts_per_cycle) || 1)),
        lastSent: new Map(lastRows.map(row => [row.marketplace, new Date(row.last_at).getTime()])),
        posted: new Map(),
        failed: false
      });
    }
    const bots = await q<{ token_enc: string; enabled: boolean; stores: string[]; chats: Array<{ chatId: string; enabled?: boolean; stores?: string[]; categories?: string; title?: string }> }>(
      "SELECT token_enc, enabled, stores, chats FROM telegram_bots WHERE company_id = $1 AND enabled = true",
      [company.id]
    );
    if (!publishers.length && !bots.length && !statusPubs.length) {
      await q("UPDATE settings SET last_error = $2 WHERE company_id = $1", [company.id, "Ative um grupo ou o Status na conexão que deve publicar, ou conecte um bot do Telegram"]);
      return;
    }

    let ml: Awaited<ReturnType<typeof resolveMlTracking>> | null = null;
    if (stores.has("ml")) {
      try {
        ml = await resolveMlTracking({
          code: current.ml_tag,
          mattTool: current.ml_matt_tool,
          mattWord: current.ml_matt_word
        });
      } catch (err) {
        await q("UPDATE settings SET last_error = $2 WHERE company_id = $1", [company.id, String((err as Error).message).slice(0, 400)]);
      }
    }

    const companyCadence = readSendCadence(current.send_cadence);
    const botLastRows = bots.length
      ? await q<{ marketplace: string; last_at: string }>(
        "SELECT marketplace, max(created_at) AS last_at FROM posts WHERE company_id = $1 AND status = 'sent' AND group_jid LIKE 'telegram:%' GROUP BY marketplace",
        [company.id]
      )
      : [];
    const botLast = new Map(botLastRows.map(row => [row.marketplace, new Date(row.last_at).getTime()]));
    const ranked: DealOffer[] = [];
    const errors: string[] = [];
    for (const watch of campaigns) {
      const waDue = publishers.some(pub => {
        if (pub.stores.length && !pub.stores.includes(watch.marketplace)) return false;
        const last = pub.lastSent.get(watch.marketplace) || 0;
        return !last || Date.now() - last >= cadenceSeconds(pub.cadence, watch.marketplace) * 1000;
      });
      const botDue = bots.some(() => {
        const last = botLast.get(watch.marketplace) || 0;
        return !last || Date.now() - last >= cadenceSeconds(companyCadence, watch.marketplace) * 1000;
      });
      const statusDue = statusPubs.some(pub => {
        if (pub.sentToday >= pub.perDay) return false;
        if (pub.stores.length && !pub.stores.includes(watch.marketplace)) return false;
        const last = pub.lastSent.get(watch.marketplace) || 0;
        return !last || Date.now() - last >= statusWait(pub.cadence, watch.marketplace) * 1000;
      });
      if (!waDue && !botDue && !statusDue) continue;
      try {
        const offers = await fetchOffers(watch.marketplace, watch.query, current, stores, ml);
        for (const offer of offers) {
          offer.score = scoreOffer(offer) + Number(watch.priority || 0);
          if (passes(offer, current)) ranked.push(offer);
        }
      } catch (err) {
        errors.push(`${marketplaceLabel(watch.marketplace)}: ${(err as Error).message}`);
      }
    }
    if (!ranked.length) {
      await q("UPDATE settings SET last_run_at = now(), last_error = $2 WHERE company_id = $1", [
        company.id,
        errors[0] || "Nenhuma oferta passou nos filtros"
      ]);
      return;
    }
    await q("UPDATE settings SET last_run_at = now(), last_error = NULL WHERE company_id = $1", [company.id]);
    const seen = new Set<string>();
    for (const offer of ranked.sort((a, b) => (b.score || 0) - (a.score || 0))) {
      const key = `${offer.marketplace}:${offer.externalId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await q(
        `INSERT INTO offers (company_id, marketplace, external_id, title, price_cents, original_price_cents, discount_percent, url, image_url, category, score, found_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
         ON CONFLICT (company_id, marketplace, external_id) DO UPDATE SET title = EXCLUDED.title, price_cents = EXCLUDED.price_cents, url = EXCLUDED.url, score = EXCLUDED.score, found_at = now()`,
        [company.id, offer.marketplace, offer.externalId, offer.title, offer.priceCents, offer.originalPriceCents || null, offer.discountPercent || null, offer.url, offer.imageUrl || null, offer.category || null, offer.score || 0]
      );
    }

    const byStore = new Map<string, DealOffer[]>();
    for (const offer of ranked) {
      const list = byStore.get(offer.marketplace) || [];
      list.push(offer);
      byStore.set(offer.marketplace, list);
    }
    for (const [marketplace, list] of byStore) {
      const ordered = [...list].sort((a, b) => Number(offerEndsSoonText(b.title)) - Number(offerEndsSoonText(a.title)));
      for (const offer of ordered) {
        let published = offer.url;
        if (offer.marketplace === "ml" && current.ml_official && current.ml_cookie_enc) {
          try {
            published = await createOfficialMlLink({
              cookie: decrypt(current.ml_cookie_enc),
              tag: current.ml_tag || current.ml_matt_word,
              productUrl: stripMlTracking(offer.url)
            });
          } catch {
            published = offer.url;
          }
        }
        // Imagem e prévia montadas uma vez por oferta e reaproveitadas em todos os grupos e no Status.
        let jpeg: Uint8Array | undefined;
        let jpegLoaded = false;
        const imageOf = async () => {
          if (!jpegLoaded) {
            jpeg = await loadJpeg(offer.imageUrl);
            jpegLoaded = true;
          }
          return jpeg;
        };
        const previewOf = async (): Promise<LinkPreview> => ({ ...previewText(offer), thumbnail: await imageOf() });
        for (const pub of publishers) {
          if (pub.failed) continue;
          if ((pub.posted.get(marketplace) || 0) >= pub.perCycle) continue;
          if (pub.stores.length && !pub.stores.includes(offer.marketplace)) continue;
          const last = pub.lastSent.get(marketplace) || 0;
          if (last && Date.now() - last < cadenceSeconds(pub.cadence, marketplace) * 1000) continue;
          const matching = pub.groups.filter(group => textMatches(offer, group.categories));
          const destinations = (matching.length ? matching : pub.groups).slice(0, 40);
          for (const group of destinations) {
            const since = await q(
              `SELECT id FROM posts WHERE company_id = $1 AND group_jid = $2 AND status = 'sent' AND created_at > now() - interval '24 hours' AND ((marketplace = $3 AND external_id = $4) OR url = $5) LIMIT 1`,
              [company.id, group.group_jid, offer.marketplace, offer.externalId, published]
            );
            if (since.length) continue;
            const token = crypto.randomBytes(8).toString("hex");
            try {
              // Só texto: a imagem chega pelo cartão de prévia do link e não pesa o celular de quem está no grupo.
              await sendTextWithPreview(pub.id, group.group_jid, caption(offer, published), await previewOf());
              await q(
                `INSERT INTO posts (company_id, marketplace, external_id, title, price_cents, url, image_url, group_jid, group_name, status, click_token, whatsapp_id)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'sent',$10,$11)`,
                [company.id, offer.marketplace, offer.externalId, offer.title, offer.priceCents, published, offer.imageUrl || null, group.group_jid, group.name, token, pub.id]
              );
              sent += 1;
              pub.posted.set(marketplace, (pub.posted.get(marketplace) || 0) + 1);
              pub.lastSent.set(marketplace, Date.now());
              await delay(pub.intervalMs);
            } catch (err) {
              pub.failed = true;
              await q(
                `INSERT INTO posts (company_id, marketplace, external_id, title, price_cents, url, group_jid, status, error, whatsapp_id) VALUES ($1,$2,$3,$4,$5,$6,$7,'error',$8,$9)`,
                [company.id, offer.marketplace, offer.externalId, offer.title, offer.priceCents, offer.url, group.group_jid, String((err as Error).message).slice(0, 400), pub.id]
              );
              await q("UPDATE settings SET last_error = $2 WHERE company_id = $1", [company.id, String((err as Error).message).slice(0, 400)]);
              break;
            }
          }
        }
        for (const pub of statusPubs) {
          if (pub.failed || pub.sentToday >= pub.perDay) continue;
          if ((pub.posted.get(marketplace) || 0) >= pub.perCycle) continue;
          if (pub.stores.length && !pub.stores.includes(offer.marketplace)) continue;
          const last = pub.lastSent.get(marketplace) || 0;
          if (last && Date.now() - last < statusWait(pub.cadence, marketplace) * 1000) continue;
          const repeated = await q(
            `SELECT id FROM posts WHERE company_id = $1 AND whatsapp_id = $2 AND group_jid = $3 AND status = 'sent' AND created_at > now() - interval '24 hours' AND ((marketplace = $4 AND external_id = $5) OR url = $6) LIMIT 1`,
            [company.id, pub.id, STATUS_JID, offer.marketplace, offer.externalId, published]
          );
          if (repeated.length) continue;
          try {
            pub.recipients ??= await statusAudience(company.id, pub.id, pub.groups);
            if (!pub.recipients.length) throw new Error("ninguém para ver: ative um grupo nesta conexão ou traga contatos para a Base");
            // Status só de texto (formato curto); a foto do produto aparece no cartão de prévia do link.
            const preview = await previewOf();
            const send = (to: string[]) => sendStatus(pub.id, to, null, statusCaption(offer, published), preview);
            try {
              await send(pub.recipients);
            } catch (err) {
              // Recusa do WhatsApp (400): tenta uma vez com uma lista menor antes de desistir.
              if (!/error=400/.test(String((err as Error).message)) || pub.recipients.length <= 200) throw err;
              pub.recipients = pub.recipients.slice(0, 200);
              await send(pub.recipients);
            }
            await q(
              `INSERT INTO posts (company_id, marketplace, external_id, title, price_cents, url, image_url, group_jid, group_name, status, click_token, whatsapp_id)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Status','sent',$9,$10)`,
              [company.id, offer.marketplace, offer.externalId, offer.title, offer.priceCents, published, offer.imageUrl || null, STATUS_JID, crypto.randomBytes(8).toString("hex"), pub.id]
            );
            sent += 1;
            pub.sentToday += 1;
            pub.posted.set(marketplace, (pub.posted.get(marketplace) || 0) + 1);
            pub.lastSent.set(marketplace, Date.now());
            await delay(pub.intervalMs);
          } catch (err) {
            pub.failed = true;
            const message = `Status: ${String((err as Error).message)}`.slice(0, 400);
            await q(
              `INSERT INTO posts (company_id, marketplace, external_id, title, price_cents, url, group_jid, group_name, status, error, whatsapp_id) VALUES ($1,$2,$3,$4,$5,$6,$7,'Status','error',$8,$9)`,
              [company.id, offer.marketplace, offer.externalId, offer.title, offer.priceCents, offer.url, STATUS_JID, message, pub.id]
            );
            await q("UPDATE settings SET last_error = $2 WHERE company_id = $1", [company.id, message]);
          }
        }
        if (!publishers.length || publishers.some(pub => !pub.failed)) {
          for (const bot of bots) {
            const tokenBot = decrypt(bot.token_enc);
            if (!tokenBot) continue;
            for (const chat of bot.chats || []) {
              if (chat.enabled === false) continue;
              const allow = (chat.stores && chat.stores.length ? chat.stores : bot.stores) || [];
              if (allow.length && !allow.includes(offer.marketplace)) continue;
              if (!textMatches(offer, chat.categories || "")) continue;
              const jid = `telegram:${chat.chatId}`;
              const dup = await q(
                `SELECT id FROM posts WHERE company_id = $1 AND group_jid = $2 AND status = 'sent' AND created_at > now() - interval '24 hours' AND external_id = $3 LIMIT 1`,
                [company.id, jid, offer.externalId]
              );
              if (dup.length) continue;
              const click = crypto.randomBytes(8).toString("hex");
              try {
                const text = caption(offer, published);
                if (offer.imageUrl) {
                  try {
                    await axios.post(`https://api.telegram.org/bot${tokenBot}/sendPhoto`, {
                      chat_id: chat.chatId,
                      photo: offer.imageUrl,
                      caption: text.slice(0, 1024)
                    }, { timeout: 20000 });
                  } catch {
                    await axios.post(`https://api.telegram.org/bot${tokenBot}/sendMessage`, {
                      chat_id: chat.chatId,
                      text: text.slice(0, 4000)
                    }, { timeout: 15000 });
                  }
                } else {
                  await axios.post(`https://api.telegram.org/bot${tokenBot}/sendMessage`, {
                    chat_id: chat.chatId,
                    text: text.slice(0, 4000)
                  }, { timeout: 15000 });
                }
                await q(
                  `INSERT INTO posts (company_id, marketplace, external_id, title, price_cents, url, image_url, group_jid, group_name, status, click_token)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'sent',$10)`,
                  [company.id, offer.marketplace, offer.externalId, offer.title, offer.priceCents, published, offer.imageUrl || null, jid, chat.title || chat.chatId, click]
                );
                sent += 1;
              } catch {
                /* o próximo ciclo tenta de novo */
              }
            }
          }
        }
      }
    }
    if (sent > before) await audit(company.id, null, "publish", `${sent - before} oferta(s) nesta rodada`);
   } catch (err) {
     console.error(`[deals] company=${company.id}`, err);
   }
   })();
   return true; // distingue "rodou" de "pulou porque outra rodada segura a trava" (undefined)
   });
   if (ran === undefined) console.log(`[deals] company=${company.id} já está em outra rodada; pulando`);
  }
  return sent;
};
