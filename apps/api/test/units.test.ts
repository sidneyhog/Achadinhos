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

test("Mercado Livre: reconhece a página de segurança que aparece mesmo com o cookie salvo", async () => {
  const { offersFromOffersPage } = await import("../src/deals/searchMercadoLivre");
  // Chaves de topo e título vistos na VPS em 21/10/2026 com o cookie da empresa.
  const ctx = { title: "Segurança — Mercado Livre", scopes: {}, flags: {}, support: {}, framework: {}, mainEntry: "security", wrapperProps: {}, appProps: { pageProps: { deviceType: "desktop" } } };
  const html = `<html><head><title>Segurança — Mercado Livre</title></head><body><script id="__NORDIC_RENDERING_CTX__">_n.ctx.r=${JSON.stringify(ctx)};</script></body></html>`;
  const result = offersFromOffersPage(html, "https://www.mercadolivre.com.br/ofertas");
  assert.equal(result.blocked, true);
  assert.equal(result.security, true);
  assert.equal(result.offers.length, 0);
  const semTitulo = offersFromOffersPage(`<html><head><title>Segurança — Mercado Livre</title></head><body></body></html>`);
  assert.equal(semTitulo.security, true, "sem o contexto, o título já basta");
  const ofertas = offersFromOffersPage(html.replace(/Segurança — Mercado Livre/g, "Ofertas | Mercadolivre Brasil"));
  assert.equal(ofertas.security, false, "página comum sem itens não é confundida com a de segurança");
});

test("grupo que recusa com 403 (número removido ou banido) é reconhecido para ser desativado", async () => {
  const { removedFromGroup } = await import("../src/engine/runDeals");
  // Mensagem real gravada em posts.error em 20-21/10/2026 nos três grupos que baniram o número.
  assert.equal(removedFromGroup(new Error("group.metadata iq failed (403: forbidden)")), true);
  assert.equal(removedFromGroup(new Error("Connection Closed")), false, "queda de conexão não desativa grupo");
  assert.equal(removedFromGroup(new Error("timed out after 4030ms")), false);
});

test("Mercado Livre API oficial: preço e 'antes' saem do mesmo anúncio com desconto de verdade", async () => {
  const { bestDiscountedItem } = await import("../src/deals/mlOfficial");
  // Resposta real de /products/MLB54982411/items em 21/10/2026: o mais barato não tem preço antigo.
  const results = [
    { item_id: "MLB7076175320", price: 1349, original_price: null, currency_id: "BRL", shipping: { free_shipping: true } },
    { item_id: "MLB7854529398", price: 1380, original_price: null, currency_id: "BRL", shipping: { free_shipping: true } },
    { item_id: "MLB4217058289", price: 1392, original_price: 1699, currency_id: "BRL", shipping: { free_shipping: true } }
  ];
  assert.deepEqual(bestDiscountedItem(results), { itemId: "MLB4217058289", price: 1392, original: 1699, freeShipping: true });
  assert.equal(bestDiscountedItem(results.slice(0, 2)), null, "sem preço antigo não há desconto para anunciar");
  assert.equal(bestDiscountedItem([{ item_id: "MLB1", price: 100, original_price: 90, currency_id: "BRL" }]), null, "'antes' menor que o preço não conta");
  assert.equal(bestDiscountedItem(undefined), null);
});

test("Mercado Livre API oficial: mais vendidos viram ofertas com nome, foto, link e desconto", async () => {
  const { highlightProducts, offersForProducts } = await import("../src/deals/mlOfficial");
  // Trechos reais de /highlights/MLB/category/MLB1055, /products/{id} e /products/{id}/items (21/10/2026).
  const responses: Record<string, unknown> = {
    "/highlights/MLB/category/MLB1055": {
      query_data: { highlight_type: "BEST_SELLER", criteria: "CATEGORY", id: "MLB1055" },
      content: [
        { id: "MLB54982411", position: 1, type: "PRODUCT" },
        { id: "MLBU4367700495", position: 2, type: "USER_PRODUCT" },
        { id: "MLB55762063", position: 3, type: "PRODUCT" }
      ]
    },
    "/products/MLB54982411/items?limit=20": {
      paging: { total: 16, offset: 0, limit: 20 },
      results: [
        { item_id: "MLB7076175320", price: 1349, original_price: null, currency_id: "BRL", shipping: { free_shipping: true } },
        { item_id: "MLB4217058289", price: 1392, original_price: 1699, currency_id: "BRL", shipping: { free_shipping: true } }
      ]
    },
    "/products/MLB55762063/items?limit=20": { results: [{ item_id: "MLB999", price: 50, original_price: null, currency_id: "BRL" }] },
    "/products/MLB54982411": {
      id: "MLB54982411",
      name: "Celular Samsung Galaxy A17 Com Ia, 256gb, 8gb Ram, Câm De 50mp, Tela De 6.7 , Nfc, Ip54 - Azul",
      permalink: "",
      pictures: [{ id: "889169-MLA96868779849_102025", url: "https://http2.mlstatic.com/D_NQ_NP_889169-MLA96868779849_102025-F.jpg" }]
    }
  };
  const asked: string[] = [];
  const get = async (path: string) => {
    asked.push(path);
    if (!(path in responses)) throw Object.assign(new Error("404"), { response: { status: 404 } });
    return responses[path];
  };
  const products = await highlightProducts(get, { MLB1055: "Celulares e Telefones" });
  assert.deepEqual(products.map(item => item.id), ["MLB54982411", "MLB55762063"], "produto de vendedor (MLBU) fica de fora");
  const offers = await offersForProducts(get, products);
  assert.equal(offers.length, 1, "produto sem desconto não vira oferta");
  const [offer] = offers;
  assert.equal(offer.externalId, "MLB4217058289");
  assert.equal(offer.priceCents, 139200);
  assert.equal(offer.originalPriceCents, 169900);
  assert.equal(offer.discountPercent, 18);
  assert.equal(offer.freeShipping, true);
  assert.equal(offer.category, "Celulares e Telefones");
  assert.equal(offer.url, "https://www.mercadolivre.com.br/p/MLB54982411?pdp_filters=item_id:MLB4217058289");
  assert.equal(offer.imageUrl, "https://http2.mlstatic.com/D_NQ_NP_889169-MLA96868779849_102025-O.webp", "foto média, a que cabe no cartão de prévia");
  assert.match(offer.title, /^Celular Samsung Galaxy A17/);
  assert.equal(asked.includes("/products/MLB55762063"), false, "sem desconto, não gasta chamada buscando nome e foto");
});

test("ofertas do mesmo tipo não saem em sequência", async () => {
  const { productTypeKeys, spreadByType } = await import("../src/deals/variety");
  assert.deepEqual(productTypeKeys({ title: "Fone de Ouvido Bluetooth JBL Tune 520BT", category: "Eletrônicos, Áudio e Vídeo > Fones" }), ["cat:eletronicos, audio e video", "word:fone"]);
  assert.deepEqual(productTypeKeys({ title: "Kit 2 Refil De Água Acqua Pure Electrolux" }), ["word:refil"], "'kit' e números não definem o tipo");
  assert.deepEqual(productTypeKeys({ title: "Fones Bluetooth X", category: "na fila" }), ["word:fone"], "plural vira singular; etiqueta da fila não é categoria");

  const item = (title: string, category = "") => ({ title, category });
  const sorteio = [
    item("Air Fryer Philco 6,5L", "Eletrodomésticos"),
    item("Air Fryer Mondial 4L", "Eletrodomésticos"),
    item("Air Fryer Fischer 8L", "Eletrodomésticos"),
    item("Fone Bluetooth JBL", "Eletrônicos, Áudio e Vídeo"),
    item("Whey Protein 900g", "Esportes e Fitness"),
    item("Fone Bluetooth QCY", "Eletrônicos, Áudio e Vídeo"),
    item("Lixeira Inteligente", "Casa, Móveis e Decoração")
  ];
  const ordem = spreadByType(sorteio).map(entry => entry.title);
  assert.deepEqual(ordem.slice(0, 5), ["Air Fryer Philco 6,5L", "Fone Bluetooth JBL", "Whey Protein 900g", "Lixeira Inteligente", "Air Fryer Mondial 4L"], "intercala os tipos mantendo a ordem do sorteio");
  assert.equal(ordem.length, sorteio.length, "nada some, só muda de lugar");
  const depois = spreadByType(sorteio, ["cat:eletrodomesticos", "word:air"]).map(entry => entry.title);
  assert.equal(depois[0], "Fone Bluetooth JBL", "tipo que saiu há pouco vai para o fim");
  assert.deepEqual(spreadByType([item("Air Fryer A"), item("Air Fryer B")]).map(entry => entry.title), ["Air Fryer A", "Air Fryer B"], "só tem um tipo: segue a ordem");
});

test("Mercado Livre API oficial: acervo maior com subcategorias em rodízio", async () => {
  const { expandCategories, categorySlice, mergeOfficialPool, POOL_HOURS } = await import("../src/deals/mlOfficial");
  const all = expandCategories(
    { MLB1574: "Casa, Móveis e Decoração", MLB1051: "Celulares e Telefones" },
    { MLB1574: [{ id: "MLB1631", name: "Cozinha" }, { id: "x", name: "inválida" }], MLB1051: [{ id: "MLB1055", name: "Celulares e Smartphones" }] }
  );
  assert.deepEqual(Object.keys(all), ["MLB1574", "MLB1051", "MLB1631", "MLB1055"], "topo primeiro, depois as subcategorias");
  assert.equal(all.MLB1631, "Casa, Móveis e Decoração > Cozinha");
  const misturado = expandCategories(
    { MLB5672: "Acessórios para Veículos", MLB1246: "Beleza" },
    { MLB5672: [{ id: "MLB1", name: "Peças" }, { id: "MLB2", name: "Som" }, { id: "MLB3", name: "Limpeza" }], MLB1246: [{ id: "MLB9", name: "Cabelos" }] }
  );
  assert.deepEqual(Object.keys(misturado), ["MLB5672", "MLB1246", "MLB1", "MLB9", "MLB2", "MLB3"], "subcategorias intercaladas entre as categorias-mãe");

  const ids = ["a", "b", "c", "d", "e"];
  assert.deepEqual(categorySlice(ids, 0, 2), ["a", "b"]);
  assert.deepEqual(categorySlice(ids, 4, 3), ["e", "a", "b"], "volta ao começo da lista");
  assert.deepEqual(categorySlice(ids, 0, 9), ids, "bloco maior que a lista não repete categoria");
  assert.deepEqual(categorySlice([], 3, 2), []);

  const offer = (id: string) => ({ externalId: id, title: id, priceCents: 100, url: "u", marketplace: "ml" as const });
  const pool = new Map();
  const now = Date.parse("2026-10-26T12:00:00Z");
  mergeOfficialPool(pool, [offer("A"), offer("B")], now - (POOL_HOURS + 1) * 3600_000);
  const merged = mergeOfficialPool(pool, [offer("B"), offer("C")], now);
  assert.deepEqual(merged.map(item => item.externalId).sort(), ["B", "C"], "o que passou do prazo sai; o que voltou na rodada fica");
});

test("Mercado Livre API oficial: preço conferido na hora de publicar", async () => {
  const { confirmOfficialMlOffer } = await import("../src/deals/mlOfficial");
  const base = {
    externalId: "MLB4217058289",
    title: "Celular Samsung Galaxy A17",
    priceCents: 139200,
    originalPriceCents: 169900,
    discountPercent: 18,
    url: "https://www.mercadolivre.com.br/p/MLB54982411?pdp_filters=item_id:MLB4217058289&matt_word=empresa1",
    marketplace: "ml" as const
  };
  const answer = (results: unknown) => async () => ({ results });
  const mudou = await confirmOfficialMlOffer(base, answer([{ item_id: "MLB999", price: 1299, original_price: 1699, currency_id: "BRL", shipping: { free_shipping: true } }]));
  assert.equal(mudou?.priceCents, 129900, "preço novo");
  assert.equal(mudou?.discountPercent, 24);
  assert.equal(mudou?.url, "https://www.mercadolivre.com.br/p/MLB54982411?pdp_filters=item_id:MLB999&matt_word=empresa1", "link aponta para o anúncio atual e mantém a tag");
  assert.equal(await confirmOfficialMlOffer(base, answer([{ item_id: "MLB1", price: 1392, original_price: null, currency_id: "BRL" }])), null, "desconto acabou: não publica");
  const falhou = await confirmOfficialMlOffer(base, async () => { throw new Error("timeout"); });
  assert.equal(falhou, base, "ML fora do ar: publica como estava");
  const pagina = { ...base, url: "https://produto.mercadolivre.com.br/MLB-123-x" };
  assert.equal(await confirmOfficialMlOffer(pagina, async () => { throw new Error("não devia chamar"); }), pagina, "oferta que não veio da API oficial passa direto");
});

test("Mercado Livre API oficial: fica desligada sem as duas variáveis da stack", async () => {
  const { mlOfficialConfigured } = await import("../src/deals/mlOfficial");
  const saved = { id: process.env.ML_CLIENT_ID, secret: process.env.ML_CLIENT_SECRET };
  try {
    delete process.env.ML_CLIENT_ID;
    delete process.env.ML_CLIENT_SECRET;
    assert.equal(mlOfficialConfigured(), false);
    process.env.ML_CLIENT_ID = "505076077288559";
    assert.equal(mlOfficialConfigured(), false, "só o ID não basta");
    process.env.ML_CLIENT_SECRET = "   ";
    assert.equal(mlOfficialConfigured(), false, "chave em branco não conta");
    process.env.ML_CLIENT_SECRET = "x";
    assert.equal(mlOfficialConfigured(), true);
  } finally {
    if (saved.id === undefined) delete process.env.ML_CLIENT_ID; else process.env.ML_CLIENT_ID = saved.id;
    if (saved.secret === undefined) delete process.env.ML_CLIENT_SECRET; else process.env.ML_CLIENT_SECRET = saved.secret;
  }
});

test("Amazon: links colados levam a tag da empresa, e o link curto da SiteStripe também entra", async () => {
  const { amazonOffersFromLinks } = await import("../src/deals/amazonLinks");
  const raw = [
    "https://www.amazon.com.br/Echo-Pop/dp/B09WXVH7WK/ref=sr_1_1?tag=outra-20 | Echo Pop | 299,00",
    "https://amzn.to/3XyZ9ab | Fone JBL | 189,90",
    "https://amzn.to/3XyZ9ab | repetido | 1",
    "https://www.amazon.com.br/dp/B09WXVH7WK | repetido pelo ASIN | 1",
    "https://amzn.to/ab | curto demais",
    "https://exemplo.com/amazon.html | não é Amazon"
  ].join("\n");
  const offers = amazonOffersFromLinks(raw, "sidneyhog-20");
  assert.equal(offers.length, 2);
  assert.equal(offers[0].url, "https://www.amazon.com.br/dp/B09WXVH7WK?tag=sidneyhog-20", "a tag colada no link é trocada pela da empresa");
  assert.equal(offers[0].priceCents, 29900);
  assert.equal(offers[1].url, "https://amzn.to/3XyZ9ab", "link curto segue como veio (já tem a tag de quem gerou)");
  assert.equal(offers[1].externalId, "amzn.to/3XyZ9ab");
  assert.equal(offers[1].title, "Fone JBL");
  assert.deepEqual(amazonOffersFromLinks(raw, ""), [], "sem tag não publica nada");
});

test("loja habilitada entra nas conexões que têm lista de lojas, com intervalo seguro", async () => {
  const { listWithStore, cadenceWithStore, NEW_STORE_DEFAULT_SECONDS } = await import("../src/deals/storeRollout");
  // Situação real de 22/10/2026: conexão "achei" salva só com ML, ML a cada 6 h; Amazon habilitada depois.
  assert.deepEqual(listWithStore(["ml"], "amazon"), ["ml", "amazon"]);
  assert.equal(listWithStore([], "amazon"), null, "lista vazia já publica todas as lojas");
  assert.equal(listWithStore(["ml", "amazon"], "amazon"), null, "já está na lista");
  assert.deepEqual(listWithStore('["ml"]', "shopee"), ["ml", "shopee"], "aceita a lista como texto JSON");
  assert.deepEqual(cadenceWithStore({ ml: 21600 }, "amazon"), { ml: 21600, amazon: 21600 }, "herda o intervalo mais longo da conexão");
  assert.deepEqual(cadenceWithStore({}, "natura"), { natura: NEW_STORE_DEFAULT_SECONDS }, "sem intervalo nenhum: 1 por hora, não o padrão de 2 min");
  assert.equal(cadenceWithStore({ ml: 300, amazon: 900 }, "amazon"), null, "intervalo que a empresa já escolheu não muda");
});

test("Amazon pela extensão: valida o produto enviado e monta a oferta com a tag da empresa", async () => {
  const { readAmazonItem, amazonQueueOffer } = await import("../src/deals/amazonExtension");
  const ok = readAmazonItem({
    asin: "b09wxvh7wk",
    title: "  Echo Pop | Smart speaker   compacto ",
    priceCents: 29900,
    originalPriceCents: 39900,
    imageUrl: "https://m.media-amazon.com/images/I/61u48FEs0rL._AC_SL1000_.jpg"
  });
  assert.deepEqual(ok, {
    asin: "B09WXVH7WK",
    title: "Echo Pop | Smart speaker compacto",
    priceCents: 29900,
    originalPriceCents: 39900,
    imageUrl: "https://m.media-amazon.com/images/I/61u48FEs0rL._AC_SL1000_.jpg"
  });
  assert.equal(readAmazonItem({ ...ok, asin: "123" }), null, "ASIN inválido");
  assert.equal(readAmazonItem({ ...ok, priceCents: 0 }), null, "sem preço não publica");
  assert.equal(readAmazonItem({ ...ok, imageUrl: "https://exemplo.com/x.jpg" })?.imageUrl, null, "foto só do CDN da Amazon");
  assert.equal(readAmazonItem({ ...ok, originalPriceCents: 100 })?.originalPriceCents, null, "'antes' menor que o preço não conta");

  const offer = amazonQueueOffer({ external_id: "B09WXVH7WK", title: "Echo Pop", price_cents: 29900, original_price_cents: 39900, image_url: null }, "sidneyhog-20");
  assert.equal(offer.url, "https://www.amazon.com.br/dp/B09WXVH7WK?tag=sidneyhog-20");
  assert.equal(offer.discountPercent, 25);
  assert.equal(offer.marketplace, "amazon");
  const outra = amazonQueueOffer({ external_id: "B09WXVH7WK", title: "Echo Pop", price_cents: 29900, original_price_cents: null, image_url: null }, "joao-20");
  assert.equal(outra.url, "https://www.amazon.com.br/dp/B09WXVH7WK?tag=joao-20", "cada empresa com a própria tag");
  assert.equal(outra.discountPercent, undefined);
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

test("publicações: Status no formato curto, grupos no formato de sempre e prévia do link", async () => {
  const { groupCaption, statusCaption, shortTitle, previewText, jpegCandidates, isJpeg } = await import("../src/deals/messages");
  const offer = {
    externalId: "MLB1", marketplace: "ml", url: "https://x", title: "Air Fryer Philco Pfr2200p 6,5l 1500w Preto 127v",
    priceCents: 34990, originalPriceCents: 59990, freeShipping: true
  } as any;
  assert.equal(shortTitle(offer.title), "AIR FRYER PHILCO 6,5L 1500W");
  const status = statusCaption(offer, "https://meli.la/abc").replace(/ /g, " ");
  assert.equal(status, [
    "🔥 AIR FRYER PHILCO 6,5L 1500W 🔥", "",
    "💰 De R$ 599,90 por R$ 349,90",
    "📉 42% OFF + FRETE GRÁTIS 🚚", "",
    "🛒 Garanta a sua aqui 👇", "https://meli.la/abc", "",
    "⏳ Oferta sujeita a alteração."
  ].join("\n"));
  const semDe = statusCaption({ ...offer, originalPriceCents: undefined, freeShipping: false, couponLabel: "10OFF" }, "u").replace(/ /g, " ");
  assert.match(semDe, /💰 Por apenas R\$ 349,90/);
  assert.match(semDe, /🎟️ Cupom: 10OFF/);
  assert.doesNotMatch(semDe, /📉/);
  const group = groupCaption(offer, "https://meli.la/abc");
  assert.ok(group.startsWith("🔥 OFERTA ENCONTRADA\n\n📦 Air Fryer Philco"));
  assert.match(group, /🛒 Comprar:\nhttps:\/\/meli\.la\/abc/);
  assert.equal(previewText(offer).description.replace(/ /g, " "), "Por R$ 349,90 · 42% OFF · Frete grátis");
  assert.deepEqual(jpegCandidates("https://http2.mlstatic.com/D_Q_NP_1-O.webp"), ["https://http2.mlstatic.com/D_Q_NP_1-O.webp", "https://http2.mlstatic.com/D_Q_NP_1-O.jpg"]);
  assert.ok(isJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])));
  assert.ok(!isJpeg(new Uint8Array([0x52, 0x49, 0x46, 0x46])));
});

test("Status: nunca passa de 10 linhas nem de 700 caracteres", async () => {
  const { statusCaption, STATUS_MAX_CHARS } = await import("../src/deals/messages");
  const offer = {
    externalId: "X", marketplace: "amazon", url: "u", title: "Produto ".repeat(30),
    priceCents: 10000, originalPriceCents: 20000, freeShipping: true, couponLabel: "CUPOM".repeat(30)
  } as any;
  const normal = statusCaption(offer, "https://amzn.to/abc");
  assert.ok(normal.split("\n").length <= 10);
  assert.ok(normal.length <= STATUS_MAX_CHARS);
  const longo = statusCaption(offer, `https://www.awin1.com/cread.php?p=${"x".repeat(520)}`);
  assert.ok(longo.length <= STATUS_MAX_CHARS, `ficou com ${longo.length}`);
  assert.match(longo, /🛒 Garanta a sua aqui 👇/);
});

test("Status: título curto não termina em palavra solta", async () => {
  const { shortTitle } = await import("../src/deals/messages");
  assert.equal(shortTitle("Mochila Para Notebook Impermeável com Porta USB e Senha Para Homem"), "MOCHILA PARA NOTEBOOK IMPERMEÁVEL");
  assert.equal(shortTitle("Colchão Antiescara Pneumático De Ar Com Compressor"), "COLCHÃO ANTIESCARA PNEUMÁTICO DE AR");
});

test("Mercado Livre: rodízio passa por todas as páginas e o acervo guarda o que foi lido", async () => {
  const { ML_SOURCES, ML_ROTATING_PER_LOAD, sourcesFor, mergeIntoPool } = await import("../src/deals/searchMercadoLivre");
  const seen = new Set<string>();
  let cursor = 0;
  for (let load = 0; load < Math.ceil(ML_SOURCES.length / ML_ROTATING_PER_LOAD); load += 1) {
    const sources = sourcesFor(cursor);
    assert.deepEqual(sources[0], {}, "a página 1 entra em toda leitura");
    sources.slice(1).forEach(source => seen.add(JSON.stringify(source)));
    cursor = (cursor + ML_ROTATING_PER_LOAD) % ML_SOURCES.length;
  }
  assert.equal(seen.size, ML_SOURCES.length, "em uma volta do rodízio todas as fontes são lidas");

  const offer = (id: string) => ({ externalId: id, title: id, priceCents: 100, url: `https://x/${id}`, marketplace: "ml" }) as never;
  const pool = new Map();
  mergeIntoPool(pool, [offer("a"), offer("b")], 0);
  const later = mergeIntoPool(pool, [offer("c")], 60_000);
  assert.deepEqual(later.map(item => (item as { externalId: string }).externalId).sort(), ["a", "b", "c"]);
  const old = mergeIntoPool(pool, [offer("d")], 7 * 3600_000);
  assert.deepEqual(old.map(item => (item as { externalId: string }).externalId), ["d"], "o que passou de 6 horas sai do acervo");
  assert.equal(mergeIntoPool(new Map(), [offer("1"), offer("2"), offer("3")], 0, 3600_000, 2).length, 2, "acervo respeita o teto");
});

test("variações do mesmo anúncio contam como repetição", async () => {
  const { titleKey } = await import("../src/deals/repeatPolicy");
  assert.equal(
    titleKey("Lava E Seca Samsung Wd11m Com Digital Inverter Bra"),
    titleKey("Lava  E Seca Samsung Wd11m Com Digital Inverter Ino")
  );
  assert.notEqual(titleKey("Tênis Kappa Park 2.0 Original Unissex"), titleKey("Tênis Casual Kappa Zenit Masculino"));
});

test("Status: agenda do celular entra antes dos grupos e a lista para no teto", async () => {
  const { orderAudience } = await import("../src/deals/statusPolicy");
  const agenda = ["10@lid", "11:2@lid"];
  const grupos = ["20@lid", "10@lid", "99@lid", "5519999990000@s.whatsapp.net"];
  assert.deepEqual(orderAudience([agenda, grupos], "99@lid", 10), ["10@lid", "11@lid", "20@lid"], "sem repetir, sem o próprio número e só LID");
  assert.deepEqual(orderAudience([agenda, grupos], "", 2), ["10@lid", "11@lid"], "com o teto cheio, a agenda fica e os grupos saem");
});

test("rodada em paralelo: só começa empresas paradas e respeita as vagas", async () => {
  const { pickStartable } = await import("../src/engine/runDeals");
  const companies = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
  assert.deepEqual(pickStartable(companies, new Set(), 6).map(c => c.id), [1, 2, 3, 4]);
  assert.deepEqual(pickStartable(companies, new Set([2]), 3).map(c => c.id), [1, 3], "a 2 ainda está rodando e sobram 2 vagas");
  assert.deepEqual(pickStartable(companies, new Set([1, 2, 3]), 3), [], "sem vaga, ninguém começa");
});

test("lista do Status guardada vale por algumas horas e lista vazia não fica guardada", async () => {
  const { audienceFresh, STATUS_AUDIENCE_TTL_MS } = await import("../src/engine/runDeals");
  const now = 10 * STATUS_AUDIENCE_TTL_MS;
  assert.equal(audienceFresh({ at: now - 60_000, list: ["1@lid"] }, now), true);
  assert.equal(audienceFresh({ at: now - STATUS_AUDIENCE_TTL_MS - 1, list: ["1@lid"] }, now), false);
  assert.equal(audienceFresh({ at: now, list: [] }, now), false);
  assert.equal(audienceFresh(undefined, now), false);
});

test("Mercado Livre: uma leitura do catálogo serve todas as empresas", async (t) => {
  const axios = (await import("axios")).default;
  const { searchMercadoLivre } = await import("../src/deals/searchMercadoLivre");
  const card = (id: string) => ({
    metadata: { id, url: `produto.mercadolivre.com.br/${id}-x` },
    components: [{ type: "title", title: { text: `Produto ${id}` } }, { type: "price", price: { current_price: { value: 10 } } }]
  });
  let pages = 0;
  const cookies: string[] = [];
  t.mock.method(axios, "get", async (url: string, config: { headers?: Record<string, string> }) => {
    if (url.includes("api.mercadolibre.com")) throw Object.assign(new Error("forbidden"), { response: { status: 403 } });
    pages += 1;
    cookies.push(String(config?.headers?.Cookie || ""));
    const ctx = { appProps: { pageProps: { data: { items: [{ card: card(`MLB${pages}`) }] } } } };
    return { status: 200, data: `<script>__NORDIC_RENDERING_CTX__ = ${JSON.stringify(ctx)};</script>`, request: {} };
  });
  const tracking = { params: [["matt_tool", "1"]], code: "" } as never;
  const [a, b] = await Promise.all([searchMercadoLivre("", tracking, "ssid=empresaA"), searchMercadoLivre("", tracking, "ssid=empresaB")]);
  assert.equal(pages, 4, "as duas empresas juntas fizeram uma leitura só (página 1 + 3 do rodízio)");
  assert.ok(cookies.every(cookie => cookie === "ssid=empresaA"), "a leitura usou o cookie de quem pediu primeiro");
  assert.equal(a.length, 4);
  assert.equal(b.length, 4);
  await searchMercadoLivre("", tracking, "ssid=empresaC");
  assert.equal(pages, 4, "dentro de 3 minutos o catálogo guardado é reaproveitado");
});

test("variedade: sorteio ponderado favorece a melhor oferta sem repetir sempre a mesma ordem", async () => {
  const { varietyOrder } = await import("../src/deals/variety");
  const items = [{ id: "boa", score: 70 }, { id: "media", score: 20 }, { id: "fraca", score: 0 }];
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const firsts: Record<string, number> = { boa: 0, media: 0, fraca: 0 };
  const orders = new Set<string>();
  for (let round = 0; round < 2000; round += 1) {
    const order = varietyOrder(items, item => item.score, rand);
    assert.equal(order.length, 3, "não perde nem duplica oferta");
    firsts[order[0].id] += 1;
    orders.add(order.map(item => item.id).join(","));
  }
  assert.ok(firsts.boa > firsts.media && firsts.media > firsts.fraca, `a melhor sai primeiro mais vezes (${JSON.stringify(firsts)})`);
  assert.ok(firsts.fraca > 0, "a mais fraca também tem chance de sair primeiro");
  assert.ok(orders.size >= 4, "a ordem muda entre as rodadas");
});
