import { q } from "../db";
import { getLive } from "../zapo/session";
import {
  AUDIENCE_LIMITS,
  brasiliaDayStart,
  clampJobPace,
  gateContact,
  jobIsDue,
  normalizeAudiencePhone,
  phoneFromParticipant,
  prepareAudienceRows,
  withinCaps
} from "../deals/audiencePolicy";

const weekStart = (now: Date) => {
  const start = brasiliaDayStart(now);
  const day = start.getUTCDay();
  const diff = day === 0 ? 6 : day - 1;
  return new Date(start.getTime() - diff * 24 * 60 * 60 * 1000);
};

export const saveContacts = async (
  companyId: number,
  rows: Array<{ phone?: unknown; name?: unknown; tags?: string[]; source?: string; lid?: unknown }>
) => {
  const prepared = prepareAudienceRows(rows);
  let created = 0;
  for (const row of prepared.unique) {
    const existing = await q<{ id: number; names: string[]; tags: string[] }>(
      "SELECT id, names, tags FROM contacts WHERE company_id = $1 AND phone = $2",
      [companyId, row.phone]
    );
    if (existing[0]) {
      const names = [...new Set([...(existing[0].names || []), row.name].filter(Boolean))].slice(0, 8);
      const tags = [...new Set([...(existing[0].tags || []), ...row.tags])].slice(0, 12);
      await q(
        "UPDATE contacts SET name = COALESCE(NULLIF(name, ''), $3), names = $4::jsonb, tags = $5::jsonb, updated_at = now() WHERE id = $1 AND company_id = $2",
        [existing[0].id, companyId, row.name, JSON.stringify(names), JSON.stringify(tags)]
      );
    } else {
      await q(
        `INSERT INTO contacts (company_id, phone, name, names, tags, source, lid)
         VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7)`,
        [companyId, row.phone, row.name, JSON.stringify(row.name ? [row.name] : []), JSON.stringify(row.tags), row.source, row.lid || ""]
      );
      created += 1;
    }
  }
  return { ...prepared, created };
};

const adminOf = (
  meta: { owner?: string; participants?: Array<{ jid?: string; id?: string; isAdmin?: boolean; isSuperAdmin?: boolean; phoneNumber?: string; lid?: string }> },
  me: string
) => {
  const meBare = me.split(":")[0];
  if (meta.owner && meta.owner.split(":")[0] === meBare) return true;
  return (meta.participants || []).some(participant => {
    const ids = [participant.jid, participant.id, participant.phoneNumber, participant.lid].map(value => String(value || ""));
    const mine = ids.some(value => value.split(":")[0] === meBare);
    return mine && (participant.isAdmin || participant.isSuperAdmin);
  });
};

export const tickAudience = async () => {
  const jobs = await q<{
    id: number;
    company_id: number;
    whatsapp_id: number;
    group_jid: string;
    group_name: string;
    mode: string;
    interval_seconds: number;
    per_hour: number;
    per_day: number;
    per_week: number;
    batch_size: number;
    last_tick_at: string | null;
    invite_url: string | null;
  }>("SELECT * FROM audience_jobs WHERE status = 'running' ORDER BY last_tick_at NULLS FIRST LIMIT 20");

  let handled = 0;
  const now = new Date();
  for (const job of jobs) {
    const pace = clampJobPace(job);
    const perWeek = Math.min(2000, Math.max(1, Number(job.per_week) || 400));
    if (!jobIsDue(job.last_tick_at ? new Date(job.last_tick_at) : null, pace.intervalSeconds, now)) continue;
    await q("UPDATE audience_jobs SET last_tick_at = now() WHERE id = $1", [job.id]);
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const [{ hour }] = await q<{ hour: string }>(
      "SELECT count(*)::text AS hour FROM audience_items WHERE job_id = $1 AND status = 'added' AND processed_at >= $2",
      [job.id, hourAgo]
    );
    const [{ day }] = await q<{ day: string }>(
      "SELECT count(*)::text AS day FROM audience_items WHERE job_id = $1 AND status = 'added' AND processed_at >= $2",
      [job.id, brasiliaDayStart(now)]
    );
    const [{ week }] = await q<{ week: string }>(
      "SELECT count(*)::text AS week FROM audience_items WHERE job_id = $1 AND status = 'added' AND processed_at >= $2",
      [job.id, weekStart(now)]
    );
    if (!withinCaps(Number(hour), Number(day), pace) || Number(week) >= perWeek) {
      await q("UPDATE audience_jobs SET last_error = $2 WHERE id = $1", [job.id, "Limite por hora, dia ou semana atingido"]);
      continue;
    }
    const pending = await q<{ id: number; phone: string; contact_id: number | null }>(
      "SELECT id, phone, contact_id FROM audience_items WHERE job_id = $1 AND status = 'pending' ORDER BY id ASC LIMIT $2",
      [job.id, pace.batchSize]
    );
    if (!pending.length) {
      await q("UPDATE audience_jobs SET status = 'done', last_error = NULL WHERE id = $1", [job.id]);
      continue;
    }
    const live = getLive(job.whatsapp_id);
    if (!live?.client.group?.addParticipants || !live.client.group.queryGroupMetadata) {
      await q("UPDATE audience_jobs SET last_error = $2 WHERE id = $1", [job.id, "WhatsApp offline ou sem administração de grupos"]);
      continue;
    }
    let meta: Awaited<ReturnType<NonNullable<typeof live.client.group.queryGroupMetadata>>>;
    try {
      meta = await live.client.group.queryGroupMetadata(job.group_jid);
    } catch (err) {
      await q("UPDATE audience_jobs SET last_error = $2 WHERE id = $1", [job.id, String((err as Error).message).slice(0, 180)]);
      continue;
    }
    const sessions = await q<{ phone: string }>("SELECT phone FROM whatsapp_sessions WHERE id = $1", [job.whatsapp_id]);
    const creds = live.client.getCredentials?.() || null;
    const mine = [sessions[0]?.phone, creds?.meJid, creds?.meLid].map(value => String(value || "").split("@")[0].split(":")[0]).filter(Boolean);
    if (!mine.some(id => adminOf(meta, id.includes("@") ? id : `${id}@s.whatsapp.net`))) {
      await q("UPDATE audience_jobs SET status = 'paused', last_error = $2 WHERE id = $1", [job.id, "A conexão deixou de ser administradora"]);
      continue;
    }
    const members = new Set<string>();
    for (const participant of meta.participants || []) {
      const identity = phoneFromParticipant(participant);
      if (identity.phone) members.add(identity.phone);
    }
    for (const item of pending) {
      const phone = normalizeAudiencePhone(item.phone);
      const contact = item.contact_id
        ? (await q<{ blocked: boolean; anonymized_at: string | null; has_whatsapp: boolean | null }>(
            "SELECT blocked, anonymized_at, has_whatsapp FROM contacts WHERE id = $1 AND company_id = $2",
            [item.contact_id, job.company_id]
          ))[0]
        : null;
      const gate = gateContact({
        phone,
        blocked: Boolean(contact?.blocked),
        anonymized: Boolean(contact?.anonymized_at),
        alreadyMember: Boolean(phone && members.has(phone)),
        alreadyProcessed: false,
        hasWhatsapp: contact?.has_whatsapp === false ? false : null
      });
      if (gate.ok === false) {
        await q("UPDATE audience_items SET status = $2, reason = $3, processed_at = now() WHERE id = $1", [item.id, gate.status, gate.reason]);
        handled += 1;
        continue;
      }
      try {
        if (job.mode === "message") {
          let url = job.invite_url || "";
          if (!url && live.client.group.queryInviteCode) {
            url = `https://chat.whatsapp.com/${await live.client.group.queryInviteCode(job.group_jid)}`;
            await q("UPDATE audience_jobs SET invite_url = $2 WHERE id = $1", [job.id, url]);
          }
          await live.client.message.send(`${phone}@s.whatsapp.net`, `Olá! Segue o convite para o grupo ${job.group_name || "de ofertas"}: ${url}`);
          await q("UPDATE audience_items SET status = 'added', reason = $2, processed_at = now() WHERE id = $1", [item.id, "convite enviado"]);
        } else {
          const results = await live.client.group.addParticipants(job.group_jid, [`${phone}@s.whatsapp.net`]);
          const first = results?.[0];
          const code = Number(first?.code || 0);
          const ok = first?.status === "ok" || code === 200;
          const status = ok ? "added" : code === 409 ? "skipped" : "failed";
          const reason = ok ? "WhatsApp aceitou" : code === 409 ? "já está no grupo" : code === 403 ? "privacidade ou sem permissão" : code === 404 ? "não tem WhatsApp" : code === 408 ? "inclusão não permitida" : "falha";
          await q("UPDATE audience_items SET status = $2, reason = $3, processed_at = now() WHERE id = $1", [item.id, status, reason]);
        }
        handled += 1;
      } catch (err) {
        await q("UPDATE audience_items SET status = 'failed', reason = $2, processed_at = now() WHERE id = $1", [item.id, String((err as Error).message).slice(0, 180)]);
        handled += 1;
      }
    }
    const left = await q<{ count: string }>("SELECT count(*)::text AS count FROM audience_items WHERE job_id = $1 AND status = 'pending'", [job.id]);
    if (Number(left[0]?.count || 0) === 0) await q("UPDATE audience_jobs SET status = 'done' WHERE id = $1", [job.id]);
  }
  return handled;
};

export { AUDIENCE_LIMITS };
