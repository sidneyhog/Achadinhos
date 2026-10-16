export const AUDIENCE_TAGS = [
  "Cliente",
  "Afiliado",
  "Grupo Achadinhos",
  "Mercado Livre",
  "Shopee",
  "Amazon",
  "Importado",
  "Manual"
] as const;

export const AUDIENCE_LIMITS = {
  minIntervalSeconds: 60,
  maxIntervalSeconds: 24 * 60 * 60,
  maxPerHour: 30,
  maxPerDay: 150,
  maxBatch: 3,
  maxQueued: 5000,
  maxNames: 8,
  maxTags: 12
};

export type JobPace = {
  intervalSeconds: number;
  perHour: number;
  perDay: number;
  batchSize: number;
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.trunc(value)));

export const clampJobPace = (input: Partial<JobPace>): JobPace => ({
  intervalSeconds: clamp(
    Number(input.intervalSeconds) || 300,
    AUDIENCE_LIMITS.minIntervalSeconds,
    AUDIENCE_LIMITS.maxIntervalSeconds
  ),
  perHour: clamp(Number(input.perHour) || 12, 1, AUDIENCE_LIMITS.maxPerHour),
  perDay: clamp(Number(input.perDay) || 80, 1, AUDIENCE_LIMITS.maxPerDay),
  batchSize: clamp(Number(input.batchSize) || 1, 1, AUDIENCE_LIMITS.maxBatch)
});

/** +55 34 99999-9999, (34)99999-9999 e 5534999999999 viram 5534999999999. */
export const normalizeAudiencePhone = (raw: unknown): string | null => {
  let digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if ((digits.length === 10 || digits.length === 11) && !digits.startsWith("55")) {
    digits = `55${digits}`;
  }
  if (!digits.startsWith("55") || (digits.length !== 12 && digits.length !== 13)) return null;
  const ddd = Number(digits.slice(2, 4));
  if (ddd < 11 || ddd > 99) return null;
  return digits;
};

export const maskPhone = (phone: string): string => {
  const value = String(phone || "");
  if (value.startsWith("anon-")) return "anonimizado";
  if (value.length < 8) return "****";
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
};

export const mergeLabels = (current: string[], incoming: string[], max: number): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const label of [...current, ...incoming]) {
    const clean = String(label || "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (!clean) continue;
    const key = clean.toLocaleLowerCase("pt-BR");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= max) break;
  }
  return out;
};

export type PreparedRow = {
  phone: string;
  name: string;
  lid: string;
  tags: string[];
  source: string;
};

export type PrepareReport = {
  unique: PreparedRow[];
  found: number;
  invalid: number;
  duplicates: number;
  noPhone: number;
};

export const prepareAudienceRows = (
  rows: Array<{
    phone?: unknown;
    name?: unknown;
    lid?: unknown;
    tags?: string[];
    source?: string;
  }>
): PrepareReport => {
  const unique = new Map<string, PreparedRow>();
  let found = 0;
  let invalid = 0;
  let duplicates = 0;
  let noPhone = 0;

  for (const row of rows) {
    found += 1;
    const lid = String(row.lid || "").endsWith("@lid") ? String(row.lid) : "";
    const phone = normalizeAudiencePhone(row.phone);
    if (!phone) {
      if (lid) noPhone += 1;
      else invalid += 1;
      continue;
    }
    const name = String(row.name || "").replace(/\s+/g, " ").trim().slice(0, 80);
    const tags = mergeLabels([], row.tags || [], AUDIENCE_LIMITS.maxTags);
    const source = String(row.source || "manual").slice(0, 40);
    const prev = unique.get(phone);
    if (prev) {
      duplicates += 1;
      prev.name = prev.name || name;
      prev.lid = prev.lid || lid;
      prev.tags = mergeLabels(prev.tags, tags, AUDIENCE_LIMITS.maxTags);
      continue;
    }
    unique.set(phone, { phone, name, lid, tags, source });
  }

  return {
    unique: [...unique.values()],
    found,
    invalid,
    duplicates,
    noPhone
  };
};

export const phoneFromParticipant = (participant: {
  id?: string;
  jid?: string;
  phoneNumber?: string;
  lid?: string;
}): { phone: string | null; lid: string } => {
  const rawId = String(participant.id || participant.jid || "");
  const lid = String(participant.lid || (rawId.endsWith("@lid") ? rawId : ""));
  const candidates = [participant.phoneNumber, participant.id, participant.jid];
  for (const candidate of candidates) {
    const value = String(candidate || "");
    if (!value || value.endsWith("@lid") || value.endsWith("@g.us")) continue;
    const phone = normalizeAudiencePhone(value.split("@")[0].split(":")[0]);
    if (phone) return { phone, lid };
  }
  return { phone: null, lid };
};

export type GateResult =
  | { ok: true }
  | { ok: false; status: "failed" | "skipped"; reason: string };

export const gateContact = (input: {
  phone: string | null;
  blocked: boolean;
  anonymized: boolean;
  alreadyMember: boolean;
  alreadyProcessed: boolean;
  hasWhatsapp: boolean | null;
}): GateResult => {
  if (!input.phone || input.anonymized) {
    return { ok: false, status: "skipped", reason: "número inválido" };
  }
  if (input.blocked) return { ok: false, status: "skipped", reason: "número bloqueado" };
  if (input.alreadyProcessed) {
    return { ok: false, status: "skipped", reason: "já processado nesta fila" };
  }
  if (input.alreadyMember) {
    return { ok: false, status: "skipped", reason: "já está no grupo" };
  }
  if (input.hasWhatsapp === false) {
    return { ok: false, status: "failed", reason: "não tem WhatsApp" };
  }
  return { ok: true };
};

export const jobIsDue = (
  lastTickAt: Date | null,
  intervalSeconds: number,
  now: Date
): boolean => {
  if (!lastTickAt) return true;
  return now.getTime() - lastTickAt.getTime() >= intervalSeconds * 1000;
};

export const brasiliaDayStart = (now: Date): Date => {
  const offsetMs = -3 * 60 * 60 * 1000;
  const local = new Date(now.getTime() + offsetMs);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - offsetMs);
};

export const withinCaps = (addedLastHour: number, addedToday: number, pace: JobPace): boolean =>
  addedLastHour < pace.perHour && addedToday < pace.perDay;

export const readJsonList = (raw: unknown): string[] => {
  if (Array.isArray(raw)) return raw.map(item => String(item));
  try {
    const parsed = JSON.parse(String(raw || "[]"));
    return Array.isArray(parsed) ? parsed.map(item => String(item)) : [];
  } catch {
    return [];
  }
};

export const audienceRowsFromTable = (rows: string[][]) => {
  if (!rows.length) return [];
  const header = rows[0].map(cell => String(cell || "").trim().toLowerCase());
  const headerKeywords = /^(nome|name|numero|número|number|telefone|phone|celular)$/i;
  const hasHeader = header.some(cell => headerKeywords.test(cell)) &&
    !header.some(cell => normalizeAudiencePhone(cell));
  const data = hasHeader ? rows.slice(1) : rows;
  let nameCol = hasHeader ? header.findIndex(cell => /nome|name/.test(cell)) : -1;
  let phoneCol = hasHeader
    ? header.findIndex(cell => /numero|número|number|telefone|phone|celular/.test(cell))
    : -1;
  if (nameCol < 0) nameCol = 0;
  if (phoneCol < 0) phoneCol = 1;

  return data.map(row => {
    const cells = (Array.isArray(row) ? row : [row]).map(cell => String(cell ?? "").trim());
    if (cells.length === 1 || phoneCol >= cells.length) {
      const only = cells.find(cell => normalizeAudiencePhone(cell)) || cells[0];
      return { phone: only, name: cells.find(cell => cell !== only && !normalizeAudiencePhone(cell)) || "", source: "arquivo" };
    }
    return {
      phone: cells[phoneCol] || cells.find(cell => normalizeAudiencePhone(cell)) || "",
      name: cells[nameCol] || "",
      source: "arquivo"
    };
  });
};

export const parseAudienceTable = (rows: string[][]): PrepareReport =>
  prepareAudienceRows(audienceRowsFromTable(rows));
