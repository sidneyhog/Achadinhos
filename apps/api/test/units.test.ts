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

test("Mercado Livre: acha ofertas na lista padrão, em outro lugar da página e no JSON-LD", async () => {
  const { offersFromOffersPage } = await import("../src/deals/searchMercadoLivre");
  const card = (id: string, title: string, price: number) => ({
    metadata: { id, url: `produto.mercadolivre.com.br/${id}-x` },
    components: [{ type: "title", title: { text: title } }, { type: "price", price: { current_price: { value: price } } }]
  });
  const page = (ctx: unknown) => `<html><title>Mercado Libre</title><script>window.__NORDIC_RENDERING_CTX__ = ${JSON.stringify(ctx)};</script></html>`;

  const antigo = offersFromOffersPage(page({ appProps: { pageProps: { data: { items: [{ card: card("MLB1", "Fone", 99.9) }] } } } }));
  assert.equal(antigo.offers.length, 1);
  assert.equal(antigo.how, "lista padrão");
  assert.equal(antigo.offers[0].priceCents, 9990);

  const mudou = offersFromOffersPage(page({ appProps: { pageProps: { data: { sections: [{ content: { polycards: [card("MLB2", "Air fryer", 300), card("MLB3", "Mouse", 50)] } }] } } } }));
  assert.equal(mudou.offers.length, 2, "cartões fora da lista padrão também são lidos");
  assert.equal(mudou.how, "cartões encontrados na página");

  const ld = `<html><script type="application/ld+json">${JSON.stringify({ "@type": "ItemList", itemListElement: [{ item: { "@type": "Product", name: "Cafeteira", url: "https://produto.mercadolivre.com.br/MLB-123-cafeteira", offers: { price: "149.90" } } }] })}</script></html>`;
  const viaLd = offersFromOffersPage(ld);
  assert.equal(viaLd.offers.length, 1);
  assert.equal(viaLd.offers[0].externalId, "MLB123");
  assert.equal(viaLd.how, "dados estruturados");

  const vazio = offersFromOffersPage(page({ appProps: { pageProps: { data: { banners: [], filtros: {} } } } }));
  assert.equal(vazio.offers.length, 0);
  assert.equal(vazio.keys, "banners,filtros", "sem ofertas, mostra as chaves para diagnóstico");
});
