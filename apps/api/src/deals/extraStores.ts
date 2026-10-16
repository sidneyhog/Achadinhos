import axios from "axios";

const STORE_IDS = [
  "magalu",
  "terabyte",
  "awin",
  "rakuten",
  "samsung",
  "casasbahia",
  "natura",
  "paguemenos",
  "epoca",
  "shein"
] as const;

const SECRET_KEYS = new Set(["token", "clientSecret", "apiKey"]);

export type StoreAccount = Record<string, string>;

const clip = (value: unknown): string =>
  String(value || "").trim().slice(0, 400);

const decodePart = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** Shein identifica o afiliado em ismg_ol ou em url_from. O caminho do onelink é o produto. */
export const sheinAffiliateCode = (value: unknown): string => {
  const text = String(value || "").trim().replace(/&amp;/g, "&");
  if (!text) return "";
  const fromIsmg = text.match(/[?&]ismg_ol=([^&#"'\s]+)/i);
  if (fromIsmg) return decodePart(fromIsmg[1]).slice(0, 120);
  const fromUrl = text.match(/[?&]url_from=([^&#"'\s]+)/i);
  if (fromUrl) return decodePart(fromUrl[1]).slice(0, 120);
  const koc = text.match(/affiliate_koc_\d+/i);
  if (koc) return koc[0].slice(0, 120);
  if (/^https?:\/\//i.test(text)) return "";
  return text.slice(0, 120);
};

/** Abre um onelink curto e lê o código que a Shein devolve na página. */
export const resolveSheinOnelink = async (value: unknown): Promise<string> => {
  const direct = sheinAffiliateCode(value);
  if (direct) return direct;
  const link = String(value || "").trim();
  if (!/^https:\/\/onelink\.shein\.com\/[A-Za-z0-9/_-]{1,80}$/i.test(link)) {
    throw new Error("Cole um link https://onelink.shein.com/...");
  }
  const response = await axios.get(link, {
    timeout: 15000,
    maxRedirects: 5,
    headers: {
      Accept: "text/html",
      "User-Agent": "Mozilla/5.0"
    },
    validateStatus: () => true,
    responseType: "text"
  });
  const code = sheinAffiliateCode(String(response.data || "").slice(0, 200000));
  if (!code) {
    throw new Error("A Shein não mostrou o código de afiliado nesse link.");
  }
  return code;
};

export const readExtraStores = (raw: string | null | undefined): Record<string, StoreAccount> => {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, StoreAccount> = {};
    STORE_IDS.forEach(id => {
      const row = (parsed as Record<string, unknown>)[id];
      if (!row || typeof row !== "object") return;
      const clean: StoreAccount = {};
      Object.entries(row as Record<string, unknown>).forEach(([key, value]) => {
        if (key.endsWith("Set")) return;
        const text = clip(value);
        if (text) clean[key] = text;
      });
      if (Object.keys(clean).length) out[id] = clean;
    });
    return out;
  } catch {
    return {};
  }
};

export const publicExtraStores = (raw: string | null | undefined) => {
  const rows = readExtraStores(raw);
  const view: Record<string, Record<string, string | boolean>> = {};
  STORE_IDS.forEach(id => {
    const row = rows[id] || {};
    const pub: Record<string, string | boolean> = {};
    Object.entries(row).forEach(([key, value]) => {
      if (SECRET_KEYS.has(key)) pub[`${key}Set`] = true;
      else pub[key] = value;
    });
    if (id === "samsung") pub.advertiserId = "58389";
    if (id === "casasbahia") pub.advertiserId = "85979";
    if (id === "natura") pub.advertiserId = "17658";
    if (id === "paguemenos") pub.advertiserId = "64086";
    view[id] = pub;
  });
  return view;
};

export const mergeExtraStores = (currentRaw: string | null | undefined, incoming: unknown): string => {
  const merged = readExtraStores(currentRaw);
  const body = incoming && typeof incoming === "object" ? (incoming as Record<string, unknown>) : {};
  STORE_IDS.forEach(id => {
    const patch = body[id];
    if (!patch || typeof patch !== "object") return;
    const row: StoreAccount = { ...(merged[id] || {}) };
    Object.entries(patch as Record<string, unknown>).forEach(([key, value]) => {
      if (key.endsWith("Set") || typeof value !== "string") return;
      const text = clip(value);
      if (!text && SECRET_KEYS.has(key)) return;
      if (!text) delete row[key];
      else row[key] = text;
    });
    if (id === "samsung") row.advertiserId = "58389";
    if (id === "casasbahia") row.advertiserId = "85979";
    if (id === "natura") row.advertiserId = "17658";
    if (id === "paguemenos") row.advertiserId = "64086";
    if (id === "shein") {
      const source = (patch as Record<string, unknown>).ismgOl || (patch as Record<string, unknown>).affiliateLink;
      const code = sheinAffiliateCode(source);
      if (code) row.ismgOl = code;
      else if (String(source || "").trim()) delete row.ismgOl;
      delete row.affiliateLink;
      delete row.uid;
      delete row.token;
    }
    merged[id] = row;
  });
  return JSON.stringify(merged);
};
