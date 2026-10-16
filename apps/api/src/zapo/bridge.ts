import { randomUUID } from "node:crypto";
import { getRedis } from "../redis";

export const WA_REQ = "achadinhos:wa:req";

export type WaGroup = { jid: string; name: string; members: number; admin: boolean; admins: number };
export type WaContact = { phone: string | null; lid: string; name: string };

export type WaReply =
  | { ok: true; groups: WaGroup[] }
  | { ok: true; rows: WaContact[] }
  | { ok: true; subject: string; admin: boolean }
  | { ok: false; error: string };

export const askWorker = async (body: Record<string, unknown>, timeoutSec = 25): Promise<WaReply> => {
  const redis = getRedis();
  if (!redis) return { ok: false, error: "Redis indisponível" };
  const requestId = randomUUID();
  const key = `achadinhos:wa:res:${requestId}`;
  const waiter = redis.duplicate();
  try {
    await redis.publish(WA_REQ, JSON.stringify({ requestId, ...body }));
    const popped = await waiter.blpop(key, timeoutSec);
    if (!popped) return { ok: false, error: "A sessão não respondeu. Aguarde o WhatsApp ficar conectado e atualize." };
    return JSON.parse(popped[1]) as WaReply;
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message || err).slice(0, 180) };
  } finally {
    waiter.disconnect();
  }
};
