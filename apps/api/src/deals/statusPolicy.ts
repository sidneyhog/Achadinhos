/** Regras do Status do WhatsApp: quantas ofertas por dia, espaço entre elas e quem vê. */

export const STATUS_JID = "status@broadcast";

export const STATUS_LIMITS = {
  defaultPerDay: 6,
  maxPerDay: 30,
  defaultGapMinutes: 60,
  minGapMinutes: 15,
  maxGapMinutes: 720,
  maxRecipients: 5000
};

export const clampStatusPace = (raw: { perDay?: unknown; gapMinutes?: unknown }) => {
  const perDay = Math.round(Number(raw.perDay ?? STATUS_LIMITS.defaultPerDay));
  const gap = Math.round(Number(raw.gapMinutes ?? STATUS_LIMITS.defaultGapMinutes));
  return {
    perDay: Math.min(STATUS_LIMITS.maxPerDay, Math.max(1, Number.isFinite(perDay) ? perDay : STATUS_LIMITS.defaultPerDay)),
    gapMinutes: Math.min(
      STATUS_LIMITS.maxGapMinutes,
      Math.max(STATUS_LIMITS.minGapMinutes, Number.isFinite(gap) ? gap : STATUS_LIMITS.defaultGapMinutes)
    )
  };
};

/** Pode publicar mais uma oferta no Status agora? */
export const statusAllowed = (input: {
  sentToday: number;
  lastAt: number | null;
  now: number;
  perDay: number;
  gapMinutes: number;
}) => {
  const pace = clampStatusPace(input);
  if (input.sentToday >= pace.perDay) return false;
  if (input.lastAt && input.now - input.lastAt < pace.gapMinutes * 60_000) return false;
  return true;
};

/**
 * O Status só chega a quem estiver na lista de envio. Usa os participantes dos
 * grupos da conexão (LID quando houver, como o próprio WhatsApp faz), sem repetir
 * e sem o próprio número.
 */
export const statusRecipients = (
  participants: Array<{ id?: string; jid?: string; lid?: string }>,
  self: string[] = [],
  cap = STATUS_LIMITS.maxRecipients
) => {
  const mine = new Set(self.map(value => String(value || "").split("@")[0].split(":")[0]).filter(Boolean));
  const out = new Set<string>();
  for (const participant of participants) {
    const raw = String(participant.id || participant.jid || "");
    const jid = participant.lid && participant.lid.endsWith("@lid") ? participant.lid : raw;
    if (!jid.endsWith("@lid") && !jid.endsWith("@s.whatsapp.net")) continue;
    const user = jid.split("@")[0].split(":")[0];
    if (mine.has(user)) continue;
    out.add(`${user}@${jid.split("@")[1]}`);
    if (out.size >= cap) break;
  }
  return [...out];
};
