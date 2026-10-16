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
  assert.equal(vazio.blocked, false);
});

test("Mercado Livre: reconhece a página de verificação de conta (bloqueio sem login)", async () => {
  const { offersFromOffersPage } = await import("../src/deals/searchMercadoLivre");
  // Trecho real (encurtado) do que /ofertas devolve em 16/10/2026, da VPS e de IP residencial: 302 -> /gz/account-verification.
  const ctx = {
    flags: {},
    assets: {},
    support: {},
    title: "Mercado Libre",
    framework: {},
    appProps: {
      pageProps: {
        openInApp: { shouldRedirect: false, from: { all: false }, redirectUrl: null },
        deviceType: "desktop",
        deviceOS: "windows",
        tid: "8e8e50bd-40e4-4b29-8a3f-cf454cc91f06",
        inWebview: false,
        authLinks: {
          login: "https://www.mercadolivre.com/jms/mlb/lgz/login?platform_id=ml&go=https%3A%2F%2Fwww.mercadolivre.com.br%2Fofertas&loginType=negative_traffic&trace_id=8e8e50bd-40e4-4b29-8a3f-cf454cc91f06",
          registration: "https://www.mercadolivre.com.br/registration?confirmation_url=https%3A%2F%2Fwww.mercadolivre.com.br%2Fofertas&registrationType=negative_traffic&trace_id=8e8e50bd-40e4-4b29-8a3f-cf454cc91f06"
        },
        header: { logoUrl: "https://http2.mlstatic.com/frontend-assets/ui-navigation/5.21.22/mercadolibre/logo__small@2x.png" }
      }
    },
    mainEntry: "gz-account-verification-index"
  };
  const html = `<html><head><title id="root-title">Mercado Libre</title></head><body><script>window.__NORDIC_RENDERING_CTX__ = ${JSON.stringify(ctx)};</script></body></html>`;
  const result = offersFromOffersPage(html);
  assert.equal(result.blocked, true);
  assert.equal(result.offers.length, 0);
});

test("Mercado Livre: lê o cartão real da página /ofertas logada e separa da parede sem login", async () => {
  const { offersFromOffersPage } = await import("../src/deals/searchMercadoLivre");
  // Trecho real de /ofertas com sessão logada em 16/10/2026 (1º de 48 itens; campos de sessão e rastreio removidos).
  const card = {
    metadata: { id: "MLB5187281878", variation_id: "186130844567", pid: "MLBI5187281878", pid_extended: "MLBI5187281878", url: "produto.mercadolivre.com.br/MLB-5187281878-camisa-gola-polo-masculina-pique-premium-algodo-confortavel-_JM", card_type: "grid-card", vertical: "" },
    pictures: { scale: "FILL", pictures: [{ id: "804138-MLB113502958558_072026" }], square: "Q", alt_text: "Imagem", sanitized_title: "-camisa-gola-polo-masculina-pique-premium-algodo-confortavel", overlay: true, variation_id: "186130844567" },
    components: [
      { type: "title", id: "title", title: { text: "Camisa Gola Polo Masculina Pique Premium Algodão Confortável", long_title: false, title_tag: "h3" } },
      { type: "seller", id: "seller", seller: { text: "mm {icon_cockade}", values: [{ key: "icon_cockade", type: "icon", icon: { key: "icon_cockade", alt_text: "Loja oficial", icon_id: "icon_cockade" } }] } },
      { type: "review_compacted", id: "review_compacted", review_compacted: { text: "{icon_star_fill} {label} {label2}", alt_text: "Classificação 4.7 de 5 estrelas. Mais de 100mil produtos vendidos.", values: [{ key: "icon_star_fill", type: "icon", icon: { key: "icon_star_fill", icon_id: "icon_star_fill" } }, { key: "label", type: "label", label: { text: "4.7" } }, { key: "label2", type: "label", label: { text: "| +100mil vendidos" } }] } },
      { type: "price", id: "price_v2", price: { price_labels: [{ version: "1", text: "{previous_price}", values: [{ type: "price", key: "previous_price", price: { value: 54.9, currency: "BRL", previous: true } }] }], discount_polylabel: { version: "1", text: "{previous_label}", values: [{ type: "pill", key: "previous_label", pill: { text: "38% OFF" } }] }, current_price: { value: 33.9, currency: "BRL", weight: "regular" } } },
      { type: "shipping_v2", id: "shipping_v2", shipping_v2: [{ version: "1", text: "{next_day_free_shipping} {full_icon}", values: [{ type: "pill", key: "next_day_free_shipping", pill: { text: "Chegará grátis amanhã" } }, { type: "icon", key: "full_icon", icon: { key: "vpp_full_icon", alt_text: "Enviado pelo FULL" } }] }] }
    ]
  };
  const logada = { title: "Ofertas | Mercadolivre Brasil", scopes: {}, flags: {}, support: {}, framework: {}, mainEntry: "desktopView", appProps: { pageProps: { data: { siteId: "MLB", paging: {}, items: [{ card, position: 1, type: "ORGANIC_ITEM" }] }, siteId: "MLB" } } };
  const script = (ctx: unknown) => `<html><head><title>Mercado Libre</title></head><body><script id="__NORDIC_RENDERING_CTX__" nonce="x">_n.ctx.r=${JSON.stringify(ctx)};</script></body></html>`;

  const result = offersFromOffersPage(script(logada), "https://www.mercadolivre.com.br/ofertas");
  assert.equal(result.blocked, false);
  assert.equal(result.how, "lista padrão");
  assert.equal(result.offers.length, 1);
  const [offer] = result.offers;
  assert.equal(offer.externalId, "MLB5187281878");
  assert.equal(offer.title, "Camisa Gola Polo Masculina Pique Premium Algodão Confortável");
  assert.equal(offer.priceCents, 3390);
  assert.equal(offer.originalPriceCents, 5490);
  assert.equal(offer.discountPercent, 38);
  assert.equal(offer.freeShipping, true);
  assert.equal(offer.rating, 4.7);
  assert.equal(offer.soldQuantity, 100000);
  assert.equal(offer.url, "https://produto.mercadolivre.com.br/MLB-5187281878-camisa-gola-polo-masculina-pique-premium-algodo-confortavel-_JM");
  assert.equal(offer.imageUrl, "https://http2.mlstatic.com/D_NQ_NP_804138-MLB113502958558_072026-O.webp");

  // Parede sem login com as mesmas chaves de topo vistas na VPS, mesmo sem o mainEntry e o loginType conhecidos.
  const parede = { flags: {}, assets: {}, support: {}, title: "Mercado Libre", framework: {}, appProps: { pageProps: { deviceType: "desktop", authLinks: { login: "https://www.mercadolivre.com/jms/mlb/lgz/login" } } }, mainEntry: "outra-pagina" };
  assert.equal(offersFromOffersPage(script(parede)).blocked, true, "pageProps sem data e com authLinks é a parede");
  assert.equal(offersFromOffersPage("<html></html>", "https://www.mercadolivre.com.br/gz/account-verification?go=x").blocked, true, "redirecionou para /gz/account-verification");
});

test("Mercado Livre: /ofertas leva o cookie de sessão salvo pela empresa", async () => {
  const { offersPageHeaders } = await import("../src/deals/searchMercadoLivre");
  assert.equal(offersPageHeaders(" ssid=abc; nsa_rotok=x.y.z ").Cookie, "ssid=abc; nsa_rotok=x.y.z");
  assert.equal("Cookie" in offersPageHeaders(""), false, "sem cookie salvo, não manda cabeçalho vazio");
  assert.equal("Cookie" in offersPageHeaders(), false);
});

test("Status respeita o limite diário e o espaço mínimo entre publicações", async () => {
  const { statusAllowed, clampStatusPace, STATUS_LIMITS } = await import("../src/deals/statusPolicy");
  const now = Date.parse("2026-10-16T15:00:00Z");
  const pace = { perDay: 3, gapMinutes: 60 };
  assert.equal(statusAllowed({ ...pace, sentToday: 0, lastAt: null, now }), true, "primeiro Status do dia sai");
  assert.equal(statusAllowed({ ...pace, sentToday: 1, lastAt: now - 30 * 60_000, now }), false, "30 min depois ainda espera");
  assert.equal(statusAllowed({ ...pace, sentToday: 1, lastAt: now - 61 * 60_000, now }), true, "passada 1 h, libera");
  assert.equal(statusAllowed({ ...pace, sentToday: 3, lastAt: now - 5 * 3600_000, now }), false, "bateu o limite do dia");
  assert.deepEqual(clampStatusPace({ perDay: 999, gapMinutes: 1 }), { perDay: STATUS_LIMITS.maxPerDay, gapMinutes: STATUS_LIMITS.minGapMinutes });
  assert.deepEqual(clampStatusPace({ perDay: null, gapMinutes: "x" }), { perDay: STATUS_LIMITS.defaultPerDay, gapMinutes: STATUS_LIMITS.defaultGapMinutes });
  assert.equal(statusAllowed({ perDay: 999, gapMinutes: 0, sentToday: 30, lastAt: null, now }), false, "teto vale mesmo com valor salvo alto");
});

test("Status vai para os participantes dos grupos, sem repetir e sem o próprio número", async () => {
  const { statusRecipients } = await import("../src/deals/statusPolicy");
  const list = statusRecipients(
    [
      { id: "111@lid" },
      { jid: "5519999990000@s.whatsapp.net", lid: "222@lid" },
      { id: "111:3@lid" },
      { id: "333@lid" },
      { id: "120363@g.us" },
      { id: "5519988887777@s.whatsapp.net" }
    ],
    ["5519988887777@s.whatsapp.net", "333:12@lid"]
  );
  assert.deepEqual(list, ["111@lid", "222@lid"]);
  assert.equal(statusRecipients([{ id: "1@lid" }, { id: "2@lid" }, { id: "3@lid" }], [], 2).length, 2);
});

test("chave da extensão: formato, hash estável e cookie com sessão do ML", async () => {
  const { newExtensionKey, hashExtensionKey, looksLikeExtensionKey, isMlSessionCookie } = await import("../src/deals/extensionKey");
  const { key, hash } = newExtensionKey();
  assert.ok(looksLikeExtensionKey(key));
  assert.equal(hashExtensionKey(key), hash);
  assert.notEqual(newExtensionKey().hash, hash, "cada chave é nova");
  assert.equal(looksLikeExtensionKey("ach_123"), false);
  assert.equal(isMlSessionCookie("_d2id=abc; ssid=ghy-123; nsa_rotok=x.y.z"), true);
  assert.equal(isMlSessionCookie("_d2id=abc; nsa_rotok=x.y.z"), false, "sem ssid não é sessão");
  assert.equal(isMlSessionCookie(`ssid=1; x=${"a".repeat(20_001)}`), false, "texto gigante é recusado");
});
