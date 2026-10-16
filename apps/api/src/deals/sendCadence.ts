const DEFAULT_SECONDS = 120;
const MIN_SECONDS = 15;
const MAX_SECONDS = 24 * 60 * 60;

export const readSendCadence = (raw: unknown): Record<string, number> => {
  let source = raw;
  if (typeof raw === "string") {
    try {
      source = JSON.parse(raw);
    } catch {
      source = {};
    }
  }
  if (!source || typeof source !== "object") return {};
  const out: Record<string, number> = {};
  Object.entries(source as Record<string, unknown>).forEach(([key, value]) => {
    const id = String(key || "").trim();
    const seconds = Math.round(Number(value));
    if (!id || !Number.isFinite(seconds)) return;
    out[id] = Math.min(Math.max(seconds, MIN_SECONDS), MAX_SECONDS);
  });
  return out;
};

export const cadenceSeconds = (raw: unknown, marketplace: string): number =>
  readSendCadence(raw)[marketplace] || DEFAULT_SECONDS;
