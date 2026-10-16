import { audit, migrate, q } from "./db";
import { remindDue } from "./reminders";
import { runDueDeals } from "./engine/runDeals";
import { tickAudience } from "./engine/audience";
import { phoneFromParticipant } from "./deals/audiencePolicy";
import { getRedis } from "./redis";
import { withLock } from "./locks";
import { assertAppSecret, loadAutoSecrets } from "./secrets";

loadAutoSecrets("worker");
assertAppSecret("worker");
import { WA_REQ } from "./zapo/bridge";
import { getLive, liveIds, startSession, stopSession, type LiveSession } from "./zapo/session";

type WaNode = { tag?: string; attrs?: Record<string, string>; content?: WaNode[] | string };

const walkGroups = (node: WaNode | undefined, into: WaNode[]) => {
  if (!node || typeof node !== "object") return;
  if (node.tag === "group") into.push(node);
  if (Array.isArray(node.content)) for (const child of node.content) walkGroups(child, into);
};

const bareId = (value?: string) => String(value || "").split("@")[0].split(":")[0];

const meIds = (session: LiveSession) => {
  const creds = session.client.getCredentials?.() || session.client.auth?.getCredentials?.() || null;
  return [...new Set([bareId(creds?.meJid), bareId(creds?.meLid)].filter(Boolean))];
};

const selfIsAdmin = (participants: Array<{ jid?: string; id?: string; phoneNumber?: string; lid?: string; isAdmin?: boolean; isSuperAdmin?: boolean }> | undefined, mes: string[], owner?: string) => {
  if (!mes.length) return false;
  if (mes.includes(bareId(owner))) return true;
  return (participants || []).some(item => {
    const ids = [item.jid, item.id, item.phoneNumber, item.lid].map(value => bareId(value));
    return ids.some(id => mes.includes(id)) && (item.isAdmin || item.isSuperAdmin);
  });
};

const listParticipating = async (session: LiveSession) => {
  const found = new Map<string, { jid: string; name: string; members: number; admin: boolean; admins: number }>();
  const put = (jid: string, name: string, members: number, admin: boolean, admins: number) => {
    const clean = jid.includes("@") ? jid : jid ? `${jid}@g.us` : "";
    if (!clean.endsWith("@g.us")) return;
    const prev = found.get(clean);
    found.set(clean, {
      jid: clean,
      name: name || prev?.name || clean,
      members: members || prev?.members || 0,
      admin: Boolean(prev?.admin || admin),
      admins: Math.max(prev?.admins || 0, admins || 0)
    });
  };
  if (session.client.lowlevel?.query) {
    try {
      const result = await session.client.lowlevel.query({
        tag: "iq",
        attrs: { to: "g.us", type: "get", xmlns: "w:g2" },
        content: [{
          tag: "participating",
          attrs: {},
          content: [{ tag: "participants", attrs: {} }, { tag: "description", attrs: {} }]
        }]
      }, 40_000);
      const nodes: WaNode[] = [];
      walkGroups(result as WaNode, nodes);
      const mes = meIds(session);
      for (const node of nodes) {
        const kids = Array.isArray(node.content) ? node.content : [];
        const owner = [node.attrs?.creator, node.attrs?.creator_pn, node.attrs?.s_o, node.attrs?.s_o_pn].map(value => bareId(value)).some(id => mes.includes(id));
        const admin = owner || kids.some(child => {
          if (child.tag !== "participant") return false;
          const type = child.attrs?.type;
          if (type !== "admin" && type !== "superadmin") return false;
          return [child.attrs?.jid, child.attrs?.phone_number, child.attrs?.lid, child.attrs?.id].map(value => bareId(value)).some(id => mes.includes(id));
        });
        const admins = kids.filter(child => child.tag === "participant" && (child.attrs?.type === "admin" || child.attrs?.type === "superadmin")).length;
        put(String(node.attrs?.id || node.attrs?.jid || ""), String(node.attrs?.subject || ""), Number(node.attrs?.size || 0) || 0, admin, admins);
      }
    } catch (err) {
      console.error("[worker] lista leve de grupos", err);
    }
  }
  if (session.client.group?.queryAllGroups) {
    const mes = meIds(session);
    let listed: Awaited<ReturnType<NonNullable<NonNullable<LiveSession["client"]["group"]>["queryAllGroups"]>>> = [];
    try {
      listed = await session.client.group.queryAllGroups() || [];
    } catch (err) {
      console.error("[worker] lista completa de grupos", err);
    }
    for (const group of listed) {
      const participants = (group as { participants?: Array<{ jid?: string; id?: string; phoneNumber?: string; isAdmin?: boolean; isSuperAdmin?: boolean }> }).participants;
      const owner = (group as { owner?: string }).owner;
      const admins = (participants || []).filter(item => item.isAdmin || item.isSuperAdmin).length;
      put(
        String(group.jid || ""),
        String(group.subject || ""),
        Number(group.size) || (Array.isArray(participants) ? participants.length : 0),
        selfIsAdmin(participants, mes, owner),
        admins
      );
    }
  }
  const groups = [...found.values()].slice(0, 500);
  console.log(`[worker] grupos=${groups.length} admin=${groups.filter(group => group.admin).length}`);
  return groups;
};

const redis = getRedis();
if (redis) {
  const sub = redis.duplicate();
  await sub.subscribe(WA_REQ);
  sub.on("message", (_channel, raw) => {
    void (async () => {
      let job: { requestId?: string; op?: string; sessionId?: number; groupJids?: string[]; groupJid?: string } = {};
      try {
        job = JSON.parse(raw);
      } catch {
        return;
      }
      const reply = async (payload: unknown) => {
        if (!job.requestId) return;
        const key = `achadinhos:wa:res:${job.requestId}`;
        await redis.lpush(key, JSON.stringify(payload));
        await redis.expire(key, 30);
      };
      try {
        const live = getLive(Number(job.sessionId));
        if (!live?.client.group) return reply({ ok: false, error: "O WhatsApp desta conexão ainda não está pronto." });
        if (job.op === "groups") {
          const groups = await listParticipating(live);
          if (!groups.length) return reply({ ok: false, error: "O WhatsApp não devolveu os grupos desta conta." });
          return reply({ ok: true, groups });
        }
        if (job.op === "group-meta") {
          const groupJid = String(job.groupJid || "");
          if (!groupJid.endsWith("@g.us") || !live.client.group.queryGroupMetadata) {
            return reply({ ok: false, error: "Grupo inválido." });
          }
          const meta = await live.client.group.queryGroupMetadata(groupJid);
          return reply({
            ok: true,
            subject: String(meta.subject || ""),
            admin: selfIsAdmin(meta.participants, meIds(live), meta.owner)
          });
        }
        if (job.op === "extract") {
          if (!live.client.group.queryGroupMetadata) return reply({ ok: false, error: "Esta sessão não lê participantes." });
          const rows: Array<{ phone: string | null; lid: string; name: string }> = [];
          for (const jid of (job.groupJids || []).slice(0, 8)) {
            const meta = await live.client.group.queryGroupMetadata(jid);
            for (const participant of meta.participants || []) {
              const identity = phoneFromParticipant(participant);
              rows.push({ phone: identity.phone, lid: identity.lid, name: "" });
            }
          }
          return reply({ ok: true, rows });
        }
        return reply({ ok: false, error: "Pedido desconhecido" });
      } catch (err) {
        const message = String((err as Error)?.message || err);
        return reply({
          ok: false,
          error: message.includes("429") || message.includes("rate-overlimit")
            ? "O WhatsApp pediu uma pausa. Espere um minuto e atualize."
            : message.slice(0, 180)
        });
      }
    })();
  });
}

await migrate();

const resume = async () => {
  const rows = await q<{ id: number; company_id: number; name: string }>(
    "SELECT id, company_id, name FROM whatsapp_sessions WHERE status IN ('connected','qrcode','opening','reconnecting')"
  );
  const wanted = new Set(rows.map(row => row.id));
  for (const id of liveIds()) {
    if (!wanted.has(id)) await stopSession(id);
  }
  for (const row of rows) {
    if (!getLive(row.id)) await startSession(row);
  }
};

await resume();
setInterval(() => {
  resume().catch(err => console.error("[worker] sessão", err));
}, 2000);

const suspendExpired = async () => {
  const rows = await q<{ id: number; name: string }>(
    `UPDATE companies c SET status = 'suspended', updated_at = now()
     FROM subscriptions s
     CROSS JOIN platform_settings ps
     WHERE s.company_id = c.id AND ps.id = 1
       AND c.status = 'active' AND s.status = 'trialing'
       AND s.trial_ends_at IS NOT NULL
       AND s.trial_ends_at + (ps.block_after_days || ' days')::interval < now()
       AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.company_id = c.id AND i.status = 'paid')
     RETURNING c.id, c.name`
  );
  for (const row of rows) await audit(row.id, null, "suspend", `Teste de ${row.name} venceu e a empresa foi suspensa`);
};

// setInterval não espera a rodada anterior terminar. Uma rodada com pausas entre envios passa de 30 s,
// e duas rodadas ao mesmo tempo publicavam a mesma oferta duas vezes no mesmo grupo.
let ticking = false;
const tick = async () => {
  if (ticking) return;
  ticking = true;
  try {
    await suspendExpired();
    await remindDue();
    const sent = await runDueDeals();
    const moved = (await withLock("audience", 600, tickAudience)) ?? 0;
    if (sent || moved) console.log(`[worker] ofertas=${sent} contatos=${moved}`);
  } catch (err) {
    console.error("[worker]", err);
  } finally {
    ticking = false;
  }
};

setInterval(tick, 30_000);
void tick();
console.log("Worker Achadinhos a cada 30s");
