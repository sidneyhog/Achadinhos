/**
 * Testes de integração de segurança e regressão da API.
 *
 * Sobem a API real (tsx src/index.ts) contra um Postgres e um Redis DESCARTÁVEIS.
 * Nunca aponte DATABASE_URL para um banco real: os testes criam empresas, planos e faturas.
 *
 *   DATABASE_URL=postgres://.../achadinhos_test REDIS_URL=redis://127.0.0.1:6379 \
 *   JWT_SECRET=... APP_SECRET=... npm test
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import pg from "pg";
import http from "node:http";

if (!process.env.DATABASE_URL) throw new Error("Defina DATABASE_URL apontando para um banco de teste descartável");
if (process.env.ALLOW_TEST_DB !== "yes") throw new Error("Defina ALLOW_TEST_DB=yes para confirmar que o banco é descartável");

const PORT = Number(process.env.TEST_PORT || 44100);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_EMAIL = `admin-${randomBytes(3).toString("hex")}@test.local`;
const ADMIN_PASSWORD = `Adm-${randomBytes(6).toString("hex")}`;
const WEBHOOK_SECRET = `wh-${randomBytes(12).toString("hex")}`;
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// PagBank simulado: cria pedidos com QR e responde a consulta; o teste marca o pedido como pago.
const PAGBANK_PORT = PORT + 7;
const pagbankOrders = new Map<string, { amount: number; paid: boolean }>();
const pagbankMock = http.createServer((req, res) => {
  let body = "";
  req.on("data", chunk => { body += chunk; });
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization !== "Bearer token-teste") { res.statusCode = 401; return res.end("{}"); }
    if (req.method === "POST" && req.url === "/orders") {
      const input = JSON.parse(body);
      const id = `ORDE_${randomBytes(6).toString("hex")}`;
      pagbankOrders.set(id, { amount: input.qr_codes[0].amount.value, paid: false });
      return res.end(JSON.stringify({ id, qr_codes: [{ id: "QRCO_1", text: `00020101PIX-${id}`, links: [] }] }));
    }
    const order = pagbankOrders.get(String(req.url).split("/").pop() || "");
    if (req.method === "GET" && order) {
      return res.end(JSON.stringify({ charges: order.paid ? [{ status: "PAID", amount: { value: order.amount, summary: { paid: order.amount } } }] : [] }));
    }
    res.statusCode = 404;
    res.end("{}");
  });
});
process.env.PAGBANK_API_URL = `http://127.0.0.1:${PAGBANK_PORT}`;

let server: ChildProcess | null = null;
let serverLog = "";
const spawned: ChildProcess[] = [];
const killAll = () => {
  for (const child of spawned) {
    try { if (child.pid) process.kill(-child.pid, "SIGTERM"); } catch { /* já saiu */ }
  }
};
process.on("exit", killAll);

const startServer = async () => {
  server = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT), ADMIN_EMAIL, ADMIN_PASSWORD, EFI_WEBHOOK_SECRET: WEBHOOK_SECRET },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true
  });
  spawned.push(server);
  server.stdout?.on("data", chunk => { serverLog += chunk; });
  server.stderr?.on("data", chunk => { serverLog += chunk; });
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch { /* ainda subindo */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`API não subiu:\n${serverLog}`);
};

const alive = async () => {
  await new Promise(resolve => setTimeout(resolve, 700));
  try {
    return (await fetch(`${BASE}/api/health`)).ok;
  } catch {
    return false;
  }
};

/** Se um teste derrubou o processo, registra e sobe de novo para os próximos. */
const ensureServer = async () => {
  if (!(await alive())) await startServer();
};

const call = async (path: string, init: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
  const headers: Record<string, string> = { ...(init.headers || {}) };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, { method: init.method || "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { status: res.status, json, text };
};

const unique = () => randomBytes(4).toString("hex");
let adminToken = "";
let planSlug = "";

const registerOwner = async () => {
  const email = `owner-${unique()}@test.local`;
  const res = await call("/api/auth/register", {
    method: "POST",
    body: { name: "Dono", email, password: "senha-forte-123", companyName: `Empresa ${unique()}`, city: "São Paulo", state: "SP", planSlug }
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  const user = res.json.user as { companyId: number };
  return { email, token: String(res.json.token), companyId: user.companyId };
};

before(async () => {
  await new Promise<void>(resolve => pagbankMock.listen(PAGBANK_PORT, "127.0.0.1", () => resolve()));
  await startServer();
  const login = await call("/api/auth/login", { method: "POST", body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  assert.equal(login.status, 200, "login do super admin");
  adminToken = String(login.json.token);
  planSlug = `plano-${unique()}`;
  const plan = await call("/api/admin/plans", {
    method: "POST",
    token: adminToken,
    body: { name: planSlug, slug: planSlug, monthlyCents: 4990, yearlyCents: 49900, trialDays: 7, api: true }
  });
  assert.equal(plan.status, 201);
});

after(async () => {
  pagbankMock.close();
  killAll();
  await db.end();
});

describe("fluxos legítimos (regressão)", () => {
  test("cadastro, login, /api/me e lojas do dono", async () => {
    const owner = await registerOwner();
    const login = await call("/api/auth/login", { method: "POST", body: { email: owner.email, password: "senha-forte-123" } });
    assert.equal(login.status, 200);
    const me = await call("/api/me", { token: String(login.json.token) });
    assert.equal(me.status, 200);
    assert.equal((me.json.subscription as { status: string }).status, "trialing");
    const save = await call("/api/stores/shopee", { method: "PUT", token: owner.token, body: { enabled: true, config: { appId: "123" }, secrets: { appId: "123", secret: "segredo-shopee" } } });
    assert.equal(save.status, 200);
    const stores = await call("/api/stores", { token: owner.token });
    const shopee = (stores.json.stores as Array<{ marketplace: string; secrets: Record<string, string>; hasSecrets: boolean }>).find(s => s.marketplace === "shopee")!;
    assert.equal(shopee.secrets.secret, "segredo-shopee", "o dono continua vendo o segredo para editar");
    assert.equal(shopee.hasSecrets, true);
  });

  test("vitrine pública com tenant válido responde 404 quando robô desligado", async () => {
    const res = await call(`/vitrine/${"00000000-0000-0000-0000-000000000000"}`);
    assert.equal(res.status, 404);
  });

  test("webhook legítimo com segredo confirma o pagamento e é idempotente", async () => {
    const owner = await registerOwner();
    const txid = randomBytes(13).toString("hex");
    await db.query("INSERT INTO invoices (company_id, amount_cents, method, cycle, external_id) VALUES ($1, 4990, 'pix', 'monthly', $2)", [owner.companyId, txid]);
    const first = await call(`/api/billing/webhook?hmac=${WEBHOOK_SECRET}`, { method: "POST", body: { pix: [{ txid, valor: "49.90" }] } });
    assert.equal(first.status, 200);
    const second = await call(`/api/billing/webhook/pix?hmac=${WEBHOOK_SECRET}`, { method: "POST", body: { pix: [{ txid, valor: "49.90" }] } });
    assert.equal(second.status, 200, "a EFI acrescenta /pix na URL cadastrada");
    const { rows } = await db.query("SELECT status FROM subscriptions WHERE company_id = $1", [owner.companyId]);
    assert.equal(rows[0].status, "active");
    const events = await db.query("SELECT count(*)::int AS n FROM payment_events WHERE company_id = $1", [owner.companyId]);
    assert.equal(events.rows[0].n, 1, "evento repetido não duplica");
  });
});

describe("parceiros e comissão por indicação", () => {
  test("cadastro com código liga ao parceiro; webhook e pagamento manual geram comissão; pausado não gera", async () => {
    const code = `P${randomBytes(3).toString("hex").toUpperCase()}`;
    const created = await call("/api/admin/partners", { method: "POST", token: adminToken, body: { name: "ADM Teste", code, percent: 20 } });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const partnerId = (created.json.partner as { id: number }).id;
    const repeated = await call("/api/admin/partners", { method: "POST", token: adminToken, body: { name: "Outro", code, percent: 10 } });
    assert.equal(repeated.status, 409);

    const email = `ref-${unique()}@test.local`;
    const reg = await call("/api/auth/register", {
      method: "POST",
      body: { name: "Indicado", email, password: "senha-forte-123", companyName: `Indicada ${unique()}`, city: "Rio Claro", state: "SP", planSlug, ref: code.toLowerCase() }
    });
    assert.equal(reg.status, 201, JSON.stringify(reg.json));
    const companyId = (reg.json.user as { companyId: number }).companyId;
    const linked = await db.query("SELECT partner_id FROM companies WHERE id = $1", [companyId]);
    assert.equal(linked.rows[0].partner_id, partnerId, "código em minúsculas também liga");

    const txid = randomBytes(13).toString("hex");
    await db.query("INSERT INTO invoices (company_id, amount_cents, method, cycle, external_id) VALUES ($1, 4990, 'pix', 'monthly', $2)", [companyId, txid]);
    await call(`/api/billing/webhook?hmac=${WEBHOOK_SECRET}`, { method: "POST", body: { pix: [{ txid, valor: "49.90" }] } });
    const viaPix = await db.query("SELECT partner_id, partner_cents FROM invoices WHERE external_id = $1", [txid]);
    assert.equal(viaPix.rows[0].partner_id, partnerId);
    assert.equal(viaPix.rows[0].partner_cents, 998, "20% de 49,90");

    const manual = await call(`/api/admin/companies/${companyId}/payment`, { method: "POST", token: adminToken, body: { amountCents: 5000, days: 30 } });
    assert.equal(manual.status, 200, JSON.stringify(manual.json));
    await call(`/api/admin/partners/${partnerId}/payouts`, { method: "POST", token: adminToken, body: { amountCents: 998, note: "teste" } });
    const board = await call("/api/admin/console", { token: adminToken });
    const row = (board.json.partners as Array<{ id: number; earned_cents: number; paid_cents: number; active_companies: number }>).find(p => p.id === partnerId)!;
    assert.equal(row.earned_cents, 998 + 1000);
    assert.equal(row.paid_cents, 998);
    assert.equal(row.active_companies, 1);

    await call(`/api/admin/partners/${partnerId}`, { method: "PATCH", token: adminToken, body: { active: false } });
    await call(`/api/admin/companies/${companyId}/payment`, { method: "POST", token: adminToken, body: { amountCents: 5000, days: 30 } });
    const after = await db.query("SELECT coalesce(sum(partner_cents), 0)::int AS total FROM invoices WHERE partner_id = $1", [partnerId]);
    assert.equal(after.rows[0].total, 1998, "parceiro pausado não ganha comissão nova");

    const plain = await registerOwner();
    const none = await db.query("SELECT partner_id FROM companies WHERE id = $1", [plain.companyId]);
    assert.equal(none.rows[0].partner_id, null);
  });
});

describe("cobrança pelo PagBank", () => {
  test("Pix gerado na tela, reaproveitado, confirmado pelo aviso conferido no PagBank e sem repetir", async () => {
    const saved = await call("/api/admin/platform", { method: "PUT", token: adminToken, body: { pagbankToken: "token-teste", pagbankSandbox: true, paymentProvider: "pagbank" } });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    try {
      const owner = await registerOwner();
      const billing = await call("/api/billing", { token: owner.token });
      assert.equal(billing.json.provider, "pagbank");

      const noDoc = await call("/api/billing/checkout", { method: "POST", token: owner.token, body: { cycle: "monthly" } });
      assert.equal(noDoc.status, 400, "sem CPF/CNPJ não gera");
      const first = await call("/api/billing/checkout", { method: "POST", token: owner.token, body: { cycle: "monthly", taxId: "529.982.247-25" } });
      assert.equal(first.status, 200, JSON.stringify(first.json));
      const invoice = first.json.invoice as { id: number; qrText: string; qrImage: string; amountCents: number; status: string };
      assert.equal(invoice.amountCents, 4990);
      assert.match(invoice.qrText, /^00020101PIX-ORDE_/);
      assert.match(invoice.qrImage, /^data:image\/png;base64,/);
      const again = await call("/api/billing/checkout", { method: "POST", token: owner.token, body: { cycle: "monthly" } });
      assert.equal((again.json.invoice as { id: number }).id, invoice.id, "mesmo ciclo e valor reaproveita o Pix válido (e o CPF salvo)");

      const pending = await call(`/api/billing/invoices/${invoice.id}?check=1`, { token: owner.token });
      assert.equal((pending.json.invoice as { status: string }).status, "pending");

      const forged = await call("/api/billing/pagbank/webhook", { method: "POST", body: { id: [...pagbankOrders.keys()].pop(), charges: [{ status: "PAID" }] } });
      assert.equal(forged.status, 200);
      const stillTrial = await db.query("SELECT status FROM subscriptions WHERE company_id = $1", [owner.companyId]);
      assert.equal(stillTrial.rows[0].status, "trialing", "aviso falso não libera: o PagBank ainda diz que não pagou");

      const { rows: [inv] } = await db.query("SELECT external_id FROM invoices WHERE id = $1", [invoice.id]);
      pagbankOrders.get(inv.external_id)!.paid = true;
      await call("/api/billing/pagbank/webhook", { method: "POST", body: { id: inv.external_id } });
      await call("/api/billing/pagbank/webhook", { method: "POST", body: { id: inv.external_id } });
      const { rows: [sub] } = await db.query("SELECT status, current_period_end > trial_ends_at + interval '29 days' AS kept_trial FROM subscriptions WHERE company_id = $1", [owner.companyId]);
      assert.equal(sub.status, "active");
      assert.equal(sub.kept_trial, true, "os dias de teste que faltavam não se perdem");
      const events = await db.query("SELECT count(*)::int AS n FROM payment_events WHERE company_id = $1 AND kind = 'paid'", [owner.companyId]);
      assert.equal(events.rows[0].n, 1, "aviso repetido não renova duas vezes");
      const screen = await call(`/api/billing/invoices/${invoice.id}`, { token: owner.token });
      assert.equal((screen.json.invoice as { status: string }).status, "paid");
    } finally {
      await call("/api/admin/platform", { method: "PUT", token: adminToken, body: { paymentProvider: "" } });
    }
  });
});

describe("SEC-01 webhook de cobrança", () => {
  test("sem segredo, um cliente não consegue marcar a própria fatura como paga", async () => {
    const owner = await registerOwner();
    const txid = randomBytes(13).toString("hex");
    await db.query("INSERT INTO invoices (company_id, amount_cents, method, cycle, external_id) VALUES ($1, 49900, 'pix', 'yearly', $2)", [owner.companyId, txid]);
    const res = await call("/api/billing/webhook", { method: "POST", body: { txid } });
    assert.ok([401, 403].includes(res.status), `esperado 401/403, veio ${res.status}`);
    const { rows } = await db.query("SELECT i.status AS inv, s.status AS sub FROM invoices i JOIN subscriptions s ON s.company_id = i.company_id WHERE i.external_id = $1", [txid]);
    assert.equal(rows[0].inv, "pending");
    assert.equal(rows[0].sub, "trialing");
  });

  test("valor pago diferente da fatura não ativa a assinatura", async () => {
    const owner = await registerOwner();
    const txid = randomBytes(13).toString("hex");
    await db.query("INSERT INTO invoices (company_id, amount_cents, method, cycle, external_id) VALUES ($1, 49900, 'pix', 'yearly', $2)", [owner.companyId, txid]);
    await call(`/api/billing/webhook?hmac=${WEBHOOK_SECRET}`, { method: "POST", body: { pix: [{ txid, valor: "0.01" }] } });
    const { rows } = await db.query("SELECT status FROM invoices WHERE external_id = $1", [txid]);
    assert.equal(rows[0].status, "pending");
  });
});

describe("SEC-02 erros assíncronos não derrubam o processo", () => {
  test("GET /vitrine/<não-uuid> sem login", async () => {
    await ensureServer();
    const res = await call("/vitrine/nao-e-uuid").catch(() => ({ status: 0 }));
    const up = await alive();
    await ensureServer();
    assert.ok(up, "a API caiu após /vitrine/nao-e-uuid");
    assert.ok(res.status === 404 || res.status === 400, `status ${res.status}`);
  });

  test("dono com id não numérico em PATCH /api/team/:id", async () => {
    await ensureServer();
    const owner = await registerOwner();
    await call("/api/team/abc", { method: "PATCH", token: owner.token, body: { role: "member" } }).catch(() => null);
    const up = await alive();
    await ensureServer();
    assert.ok(up, "a API caiu após PATCH /api/team/abc");
  });

  test("super admin em GET /api/notices", async () => {
    await ensureServer();
    const login = await call("/api/auth/login", { method: "POST", body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
    await call("/api/notices", { token: String(login.json.token) }).catch(() => null);
    const up = await alive();
    await ensureServer();
    assert.ok(up, "a API caiu após GET /api/notices como super admin");
  });
});

describe("SEC-03 conta de leitura não lê credenciais", () => {
  test("member não recebe segredos das lojas nem o cookie do Mercado Livre", async () => {
    await ensureServer();
    const owner = await registerOwner();
    await call("/api/stores/shopee", { method: "PUT", token: owner.token, body: { enabled: true, config: { appId: "1" }, secrets: { appId: "1", secret: "segredo-que-nao-pode-vazar" } } });
    await call("/api/settings", { method: "PUT", token: owner.token, body: { mlCookie: "nsa_rotok=abc; ssid=cookie-que-nao-pode-vazar" } });
    const memberEmail = `leitura-${unique()}@test.local`;
    const created = await call("/api/team", { method: "POST", token: owner.token, body: { name: "Leitura", email: memberEmail, password: "senha-forte-123", role: "member" } });
    assert.equal(created.status, 201);
    const login = await call("/api/auth/login", { method: "POST", body: { email: memberEmail, password: "senha-forte-123" } });
    const token = String(login.json.token);
    const stores = await call("/api/stores", { token });
    assert.equal(stores.status, 200);
    assert.ok(!stores.text.includes("segredo-que-nao-pode-vazar"), "segredo da loja vazou para conta de leitura");
    const shopee = (stores.json.stores as Array<{ marketplace: string; hasSecrets: boolean }>).find(s => s.marketplace === "shopee")!;
    assert.equal(shopee.hasSecrets, true, "a tela continua sabendo que a credencial existe");
    const settings = await call("/api/settings", { token });
    assert.equal(settings.status, 200);
    assert.ok(!settings.text.includes("cookie-que-nao-pode-vazar"), "cookie do ML vazou para conta de leitura");
    assert.equal((settings.json.setting as { mlCookieSet: boolean }).mlCookieSet, true);
  });
});

describe("SEC-04 cadastro atômico", () => {
  test("e-mail repetido não deixa empresa órfã", async () => {
    await ensureServer();
    const owner = await registerOwner();
    const before = await db.query("SELECT count(*)::int AS n FROM companies");
    const dup = await call("/api/auth/register", {
      method: "POST",
      body: { name: "X", email: owner.email, password: "senha-forte-123", companyName: "Órfã", city: "Rio", state: "RJ", planSlug }
    });
    assert.equal(dup.status, 409);
    const afterCount = await db.query("SELECT count(*)::int AS n FROM companies");
    assert.equal(afterCount.rows[0].n, before.rows[0].n, "empresa órfã criada");
  });

  test("e-mail sem formato válido é recusado", async () => {
    const res = await call("/api/auth/register", {
      method: "POST",
      body: { name: "X", email: "nao-e-email", password: "senha-forte-123", companyName: "Y", city: "Rio", state: "RJ", planSlug }
    });
    assert.equal(res.status, 400);
  });
});

describe("SEC-05 limite de tentativas de login", () => {
  test("força bruta recebe 429", async () => {
    await ensureServer();
    const email = `alvo-${unique()}@test.local`;
    const statuses: number[] = [];
    for (let i = 0; i < 15; i += 1) {
      const res = await call("/api/auth/login", { method: "POST", body: { email, password: `errada-${i}` } });
      statuses.push(res.status);
    }
    assert.ok(statuses.includes(429), `sem 429 em 15 tentativas: ${statuses.join(",")}`);
  });
});

describe("SEC-15 exportação de contatos", () => {
  test("CSV neutraliza fórmula vinda de nome de contato", async () => {
    await ensureServer();
    const owner = await registerOwner();
    await call("/api/contacts/manual", { method: "POST", token: owner.token, body: { phone: "11987654321", name: "=HYPERLINK(\"http://x\",\"a\")" } });
    const res = await call("/api/contacts/export?format=csv", { token: owner.token });
    assert.equal(res.status, 200);
    assert.ok(!/(^|\n|,)"?=HYPERLINK/.test(res.text), `fórmula exportada crua:\n${res.text}`);
  });
});

describe("regressão de dependências atualizadas", () => {
  test("importação de contatos por arquivo (multer 2) continua funcionando", async () => {
    await ensureServer();
    const owner = await registerOwner();
    const form = new FormData();
    form.append("file", new Blob(["nome;telefone\nAna;11987650001\nBeto;(21) 98765-0002\n"], { type: "text/plain" }), "contatos.txt");
    const res = await fetch(`${BASE}/api/contacts/import`, { method: "POST", headers: { Authorization: `Bearer ${owner.token}` }, body: form });
    const json = await res.json() as { created?: number };
    assert.equal(res.status, 200, JSON.stringify(json));
    assert.equal(json.created, 2);
  });

  test("multipart com nome de campo vazio não derruba a API", async () => {
    await ensureServer();
    const owner = await registerOwner();
    const boundary = "----x";
    const body = `--${boundary}\r\nContent-Disposition: form-data; name=""\r\n\r\nvalor\r\n--${boundary}--\r\n`;
    await fetch(`${BASE}/api/contacts/import`, { method: "POST", headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": `multipart/form-data; boundary=${boundary}` }, body }).catch(() => null);
    const up = await alive();
    await ensureServer();
    assert.ok(up, "a API caiu com multipart malformado");
  });
});
