/** Horário de São Paulo. Valores antigos de 0 a 23 são horas. O restante é minuto do dia. */
export const clockMinutes = (value: unknown): number | null => {
  if (value == null || value === "") return null;
  if (typeof value === "string" && value.includes(":")) {
    const [hourText, minuteText] = value.split(":");
    const hour = Number(hourText);
    const minute = Number(minuteText);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return hour * 60 + minute;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const rounded = Math.round(numeric);
  if (rounded >= 0 && rounded <= 23) return rounded * 60;
  return Math.min(Math.max(rounded, 0), 24 * 60);
};

const saoPauloNow = (date = new Date()): { minuteOfDay: number; weekday: number } => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short"
  }).formatToParts(date);
  const hour = Number(parts.find(part => part.type === "hour")?.value || "0");
  const minute = Number(parts.find(part => part.type === "minute")?.value || "0");
  const weekdayName = parts.find(part => part.type === "weekday")?.value || "Sun";
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { minuteOfDay: hour * 60 + minute, weekday: map[weekdayName] ?? 0 };
};

export const insideSchedule = (
  setting: { hourStart?: number | string | null; hourEnd?: number | string | null; allowedDays?: string | null },
  date = new Date()
): boolean => {
  const { minuteOfDay, weekday } = saoPauloNow(date);
  const days = String(setting.allowedDays || "")
    .split(",")
    .map(item => item.trim())
    .filter(item => item !== "");
  if (days.length && !days.includes(String(weekday))) return false;
  const from = clockMinutes(setting.hourStart);
  const to = clockMinutes(setting.hourEnd);
  if (from == null || to == null || from === to) return true;
  if (from < to) return minuteOfDay >= from && minuteOfDay < to;
  return minuteOfDay >= from || minuteOfDay < to;
};

const ROUTE_STORES = new Set([
  "ml", "amazon", "shopee", "aliexpress", "awin", "rakuten",
  "samsung", "casasbahia", "natura", "paguemenos", "epoca", "magalu", "shein", "terabyte"
]);

export type ConnectionRoute = { enabled: boolean; stores: string[] };

export const readConnectionRoutes = (raw: unknown): Record<string, ConnectionRoute> => {
  let source = raw;
  if (typeof raw === "string" && raw.trim()) {
    try {
      source = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (!source || typeof source !== "object") return {};
  const out: Record<string, ConnectionRoute> = {};
  Object.entries(source as Record<string, { enabled?: unknown; stores?: unknown }>).forEach(([id, value]) => {
    if (!/^\d+$/.test(id) || !value || typeof value !== "object") return;
    const stores = Array.isArray(value.stores)
      ? value.stores.map(item => String(item)).filter(item => ROUTE_STORES.has(item))
      : [];
    out[id] = { enabled: value.enabled !== false, stores };
  });
  return out;
};

export type TelegramTarget = {
  chatId: string;
  title: string;
  enabled: boolean;
  stores: string[];
  categories: string;
};

export const readTelegramTargets = (raw: unknown): TelegramTarget[] => {
  let source = raw;
  if (typeof raw === "string" && raw.trim()) {
    try {
      source = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(source)) return [];
  const seen = new Set<string>();
  const out: TelegramTarget[] = [];
  source.forEach(item => {
    if (!item || typeof item !== "object") return;
    const chatId = String((item as { chatId?: unknown }).chatId || "").trim();
    if (!/^-?\d{4,}$/.test(chatId) && !/^@[A-Za-z][\w]{3,}$/.test(chatId)) return;
    if (seen.has(chatId)) return;
    seen.add(chatId);
    const stores = Array.isArray((item as { stores?: unknown }).stores)
      ? (item as { stores: unknown[] }).stores.map(store => String(store)).filter(store => ROUTE_STORES.has(store))
      : [];
    out.push({
      chatId,
      title: String((item as { title?: unknown }).title || chatId).trim().slice(0, 80) || chatId,
      enabled: (item as { enabled?: unknown }).enabled !== false,
      stores,
      categories: String((item as { categories?: unknown }).categories || "").trim().slice(0, 240)
    });
  });
  return out.slice(0, 30);
};

export type TelegramBot = {
  id: string;
  name: string;
  enabled: boolean;
  stores: string[];
  categories: string;
  token: string;
  chats: TelegramTarget[];
};

const TOKEN_PATTERN = /^\d{6,}:[A-Za-z0-9_-]{20,}$/;

const asStores = (value: unknown): string[] => (
  Array.isArray(value) ? value.map(item => String(item)).filter(item => ROUTE_STORES.has(item)) : []
);

const sanitizeBots = (raw: unknown, previous: TelegramBot[] = []): TelegramBot[] => {
  if (!Array.isArray(raw)) return [];
  const prev = new Map(previous.map(bot => [bot.id, bot]));
  const seen = new Set<string>();
  const out: TelegramBot[] = [];
  raw.forEach((item, index) => {
    if (!item || typeof item !== "object") return;
    const source = item as {
      id?: unknown;
      name?: unknown;
      enabled?: unknown;
      stores?: unknown;
      categories?: unknown;
      token?: unknown;
      chats?: unknown;
    };
    const id = String(source.id || `bot${index + 1}`).replace(/[^\w-]/g, "").slice(0, 40);
    if (!id || seen.has(id)) return;
    seen.add(id);
    const typed = String(source.token || "").trim();
    const token = TOKEN_PATTERN.test(typed) ? typed : (prev.get(id)?.token || "");
    out.push({
      id,
      name: String(source.name || "Bot").trim().slice(0, 60) || "Bot",
      enabled: source.enabled !== false,
      stores: asStores(source.stores),
      categories: String(source.categories || "").trim().slice(0, 240),
      token,
      chats: readTelegramTargets(source.chats)
    });
  });
  return out.slice(0, 8);
};

export const readTelegramBots = (targetsRaw: unknown, tokenRaw?: unknown): TelegramBot[] => {
  let source = targetsRaw;
  if (typeof targetsRaw === "string" && targetsRaw.trim()) {
    try {
      source = JSON.parse(targetsRaw);
    } catch {
      source = null;
    }
  }
  if (source && typeof source === "object" && !Array.isArray(source) && Array.isArray((source as { bots?: unknown }).bots)) {
    return sanitizeBots((source as { bots: unknown }).bots);
  }
  const chats = readTelegramTargets(source);
  const token = String(tokenRaw || "").trim();
  if (!token && !chats.length) return [];
  return [{
    id: "principal",
    name: "Bot principal",
    enabled: true,
    stores: [],
    categories: "",
    token: TOKEN_PATTERN.test(token) ? token : "",
    chats
  }];
};

export const publicTelegramBots = (bots: TelegramBot[]) => bots.map(bot => ({
  id: bot.id,
  name: bot.name,
  enabled: bot.enabled,
  stores: bot.stores,
  categories: bot.categories,
  tokenSet: !!bot.token,
  chats: bot.chats
}));

export const mergeTelegramBots = (previous: TelegramBot[], incoming: unknown): TelegramBot[] => (
  Array.isArray(incoming) ? sanitizeBots(incoming, previous) : previous
);
