import { audit, q } from "./db";
import { sendMail, smtpReady } from "./mail";
import { loadPlatform } from "./platform";

const dayLabel = (days: number) => days <= 0 ? "hoje" : days === 1 ? "amanhã" : `em ${days} dias`;

export const remindDue = async () => {
  const platform = await loadPlatform();
  const wanted = new Set(String(platform.warn_days || "7,3,1").split(",").map((item) => Number(item.trim())).filter((item) => Number.isFinite(item)));
  wanted.add(0);
  const rows = await q<{ id: number; name: string; email: string; owner: string; ends_at: string }>(
    `SELECT c.id, c.name, u.email, u.name AS owner, coalesce(s.current_period_end, s.trial_ends_at) AS ends_at
     FROM subscriptions s
     JOIN companies c ON c.id = s.company_id
     JOIN LATERAL (SELECT name, email FROM users WHERE company_id = c.id AND role = 'owner' ORDER BY id LIMIT 1) u ON true
     WHERE c.status = 'active' AND s.status IN ('trialing', 'active')
       AND coalesce(s.current_period_end, s.trial_ends_at) IS NOT NULL`
  );
  const mailOn = await smtpReady();
  for (const row of rows) {
    const ends = new Date(row.ends_at);
    const days = Math.ceil((ends.getTime() - Date.now()) / 86400000);
    if (!wanted.has(days) || days < 0) continue;
    const kind = `due_${days}:${ends.toISOString().slice(0, 10)}`;
    const title = days <= 0 ? "A assinatura vence hoje" : `A assinatura vence ${dayLabel(days)}`;
    const body = `${row.name} vence em ${ends.toLocaleDateString("pt-BR")}. Entre no painel para renovar.`;
    const inserted = await q<{ id: number }>(
      `INSERT INTO notices (company_id, kind, title, body, channel, status)
       VALUES ($1,$2,$3,$4,'panel','open')
       ON CONFLICT (company_id, kind) DO NOTHING
       RETURNING id`,
      [row.id, kind, title, body]
    );
    if (!inserted.length) continue;
    await audit(row.id, null, "remind", title);
    if (!mailOn || !row.email) {
      await q("UPDATE notices SET detail = $2 WHERE id = $1", [inserted[0].id, mailOn ? "sem e-mail do dono" : "SMTP não configurado; aviso só no painel"]);
      continue;
    }
    try {
      await sendMail({ to: row.email, subject: title, text: `Olá, ${row.owner}.\n\n${body}\n` });
      await q("UPDATE notices SET channel = 'email', status = 'sent', detail = $2 WHERE id = $1", [inserted[0].id, row.email]);
    } catch (err) {
      await q("UPDATE notices SET status = 'failed', detail = $2 WHERE id = $1", [inserted[0].id, String((err as Error).message || err).slice(0, 180)]);
    }
  }
};
