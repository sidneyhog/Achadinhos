/** Testes unitários sem banco: rodam com `npm run test:unit`. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { clampJobPace, AUDIENCE_LIMITS } from "../src/deals/audiencePolicy";
import { jobPaceOf } from "../src/engine/audience";
import { withLock } from "../src/locks";

test("ritmo salvo na fila (snake_case) chega ao clampJobPace", () => {
  const row = { interval_seconds: 900, per_hour: 4, per_day: 20, batch_size: 2 };
  assert.deepEqual(clampJobPace(jobPaceOf(row)), { intervalSeconds: 900, perHour: 4, perDay: 20, batchSize: 2 });
});

test("ritmo da fila continua limitado pelos tetos da política", () => {
  const pace = clampJobPace(jobPaceOf({ interval_seconds: 1, per_hour: 999, per_day: 9999, batch_size: 50 }));
  assert.equal(pace.intervalSeconds, AUDIENCE_LIMITS.minIntervalSeconds);
  assert.equal(pace.perHour, AUDIENCE_LIMITS.maxPerHour);
  assert.equal(pace.perDay, AUDIENCE_LIMITS.maxPerDay);
  assert.equal(pace.batchSize, AUDIENCE_LIMITS.maxBatch);
});

test("withLock sem Redis impede duas rodadas simultâneas da mesma chave", async () => {
  const saved = process.env.REDIS_URL;
  delete process.env.REDIS_URL;
  try {
    let release!: () => void;
    const first = withLock("unit", 5, () => new Promise<string>(resolve => { release = () => resolve("primeira"); }));
    const second = await withLock("unit", 5, async () => "segunda");
    assert.equal(second, undefined, "a segunda rodada deveria ser pulada");
    release();
    assert.equal(await first, "primeira");
    assert.equal(await withLock("unit", 5, async () => "depois"), "depois", "o lock é liberado ao terminar");
  } finally {
    if (saved) process.env.REDIS_URL = saved;
  }
});

test("segredos automáticos: gera uma vez, reaproveita e respeita o ambiente", async () => {
  const { loadAutoSecrets } = await import("../src/secrets");
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "ach-secrets-"));
  const keys = ["JWT_SECRET", "APP_SECRET", "EFI_WEBHOOK_SECRET", "AUTO_SECRETS_FILE"] as const;
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    process.env.AUTO_SECRETS_FILE = join(dir, "sub", "segredos.json");
    loadAutoSecrets("teste");
    const first = { jwt: process.env.JWT_SECRET, app: process.env.APP_SECRET };
    assert.match(String(first.jwt), /^[0-9a-f]{64}$/);
    assert.notEqual(first.jwt, first.app);
    delete process.env.JWT_SECRET;
    delete process.env.APP_SECRET;
    loadAutoSecrets("teste");
    assert.equal(process.env.APP_SECRET, first.app, "na segunda subida o APP_SECRET não pode mudar");
    process.env.JWT_SECRET = "definido-no-ambiente";
    delete process.env.APP_SECRET;
    loadAutoSecrets("teste");
    assert.equal(process.env.JWT_SECRET, "definido-no-ambiente", "variável do ambiente vence o arquivo");
    const onDisk = JSON.parse(readFileSync(process.env.AUTO_SECRETS_FILE, "utf8"));
    assert.equal(onDisk.APP_SECRET, first.app);
  } finally {
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    rmSync(dir, { recursive: true, force: true });
  }
});
