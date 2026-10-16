import { getRedis } from "./redis";

/** Compatível com o cache que as buscas da AliExpress e da Shopee já usam. */
export const cache = {
  async get(key: string): Promise<string | null> {
    const redis = getRedis();
    if (!redis) return memory.get(key) ?? null;
    return redis.get(key);
  },
  async set(key: string, value: string, _ex: "EX", seconds: number): Promise<void> {
    const redis = getRedis();
    if (!redis) {
      memory.set(key, value);
      setTimeout(() => memory.delete(key), seconds * 1000).unref?.();
      return;
    }
    await redis.set(key, value, "EX", seconds);
  }
};

const memory = new Map<string, string>();
