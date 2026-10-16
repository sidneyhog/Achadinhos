import Redis from "ioredis";

let client: Redis | null = null;

export const getRedis = (): Redis | null => {
  if (client) return client;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  client = new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: false });
  client.on("error", () => undefined);
  return client;
};
