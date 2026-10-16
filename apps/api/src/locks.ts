import { randomUUID } from "node:crypto";
import { getRedis } from "./redis";

const local = new Set<string>();

const RELEASE = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
const EXTEND = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";

/**
 * Executa `fn` só se ninguém (outro tick do worker ou o "Buscar agora" da API) já segura a mesma chave.
 * Com Redis o lock vale entre processos; sem Redis vale dentro do processo.
 * O lock é renovado enquanto `fn` roda e expira sozinho se o processo morrer.
 * Devolve `undefined` quando a chave já está ocupada.
 */
export const withLock = async <T>(name: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T | undefined> => {
  const key = `achadinhos:lock:${name}`;
  const redis = getRedis();
  if (!redis) {
    if (local.has(key)) return undefined;
    local.add(key);
    try {
      return await fn();
    } finally {
      local.delete(key);
    }
  }
  const token = randomUUID();
  const ok = await redis.set(key, token, "EX", ttlSeconds, "NX");
  if (ok !== "OK") return undefined;
  const timer = setInterval(() => {
    redis.eval(EXTEND, 1, key, token, String(ttlSeconds * 1000)).catch(() => undefined);
  }, Math.max(1000, (ttlSeconds * 1000) / 3));
  timer.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(timer);
    await redis.eval(RELEASE, 1, key, token).catch(() => undefined);
  }
};
