import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import multer from "multer";
import crypto from "node:crypto";
import * as XLSX from "xlsx";
import { audit, one, q, withTransaction } from "./db";
import { decrypt, encrypt } from "./secrets";
import { createBoleto, createCard, createPix, efiConfigured, testEfiConnection } from "./efi";
import { createPagbankPix, getPagbankOrder, loadPagbank, pagbankError, testPagbank } from "./pagbank";
import { loadEfiRuntime, loadPlatform } from "./platform";
import { stopSession } from "./zapo/session";
import { askWorker } from "./zapo/bridge";
import { AUDIENCE_LIMITS, saveContacts, tickAudience } from "./engine/audience";
import { createOfficialMlLink, mercadoLivreCookieExpiry, reportMlLink, stripMlTracking } from "./deals/mlAffiliate";
import { marketplaceLabel } from "./deals/types";
import { clockMinutes } from "./deals/schedule";
import { audienceRowsFromTable, brasiliaDayStart, clampJobPace, normalizeAudiencePhone } from "./deals/audiencePolicy";
import { clampStatusPace } from "./deals/statusPolicy";
import { hashExtensionKey, isMlSessionCookie, looksLikeExtensionKey, newExtensionKey } from "./deals/extensionKey";

export type AuthUser = {
  id: number;
  companyId: number | null;
  role: string;
  name: string;
  email: string;
};

/** Sem JWT_SECRET não há fallback: um valor fixo no código permitiria forjar login de qualquer usuário. */
const secret = () => {
  const value = process.env.JWT_SECRET || "";
  if (!value) throw Object.assign(new Error("JWT_SECRET não configurado"), { status: 500 });
  return value;
};
const JWT_ALGORITHMS: jwt.Algorithm[] = ["HS256"];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

const sign = (user: AuthUser) =>
  jwt.sign({ uid: user.id, companyId: user.companyId, role: user.role }, secret(), { expiresIn: "7d", algorithm: "HS256" });

const loadUser = async (id: number): Promise<(AuthUser & { tenantId: string | null; companyStatus: string | null }) | null> => {
  const row = await one<{
    id: number;
    company_id: number | null;
    role: string;
    name: string;
    email: string;
    tenant_id: string | null;
    status: string | null;
  }>(
    `SELECT u.id, u.company_id, u.role, u.name, u.email, c.tenant_id, c.status
     FROM users u LEFT JOIN companies c ON c.id = u.company_id WHERE u.id = $1`,
    [id]
  );
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.company_id,
    role: row.role,
    name: row.name,
    email: row.email,
    tenantId: row.tenant_id,
    companyStatus: row.status
  };
};

const auth = async (req: Request, res: Response, next: NextFunction) => {
  const header = req.header("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Faça login" });
  try {
    const payload = jwt.verify(token, secret(), { algorithms: JWT_ALGORITHMS }) as { uid: number };
    const user = await loadUser(payload.uid);
    if (!user) return res.status(401).json({ error: "Sessão inválida" });
    if (user.companyStatus === "blocked") return res.status(403).json({ error: "Empresa bloqueada" });
    (req as Request & { auth: typeof user }).auth = user;
    if (user.role === "member" && !["GET", "HEAD"].includes(req.method) && !req.path.startsWith("/api/notices") && req.path !== "/api/auth/logout") {
      return res.status(403).json({ error: "Sua conta é só de leitura" });
    }
    return next();
  } catch {
    return res.status(401).json({ error: "Sessão inválida" });
  }
};

const admin = (req: Request, res: Response, next: NextFunction) => {
  const user = (req as Request & { auth: { role: string } }).auth;
  if (user.role !== "superadmin") return res.status(403).json({ error: "Apenas o super admin" });
  return next();
};

/**
 * O Nginx do container grava X-Real-IP depois de resolver X-Forwarded-For só a partir de proxies internos
 * (nginx/default.conf). O primeiro item de X-Forwarded-For vem do cliente e não serve para auditoria nem limite.
 * A porta 4000 da API não é publicada no Compose; fora dele, coloque um proxy na frente que sobrescreva X-Real-IP.
 */
const ipOf = (req: Request) => String(req.headers["x-real-ip"] || req.socket.remoteAddress || "").split(",")[0].trim();

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;
const validEmail = (email: string) => email.length <= 254 && EMAIL_RE.test(email);

/** Janela deslizante simples em memória. A API roda em um processo só (docker-compose.yml). */
const hits = new Map<string, number[]>();
const limited = (key: string, max: number, windowMs: number) => {
  const now = Date.now();
  const recent = (hits.get(key) || []).filter(at => now - at < windowMs);
  hits.set(key, recent);
  return recent.length >= max;
};
const hit = (key: string) => {
  const list = hits.get(key) || [];
  list.push(Date.now());
  hits.set(key, list);
};
setInterval(() => {
  const now = Date.now();
  for (const [key, list] of hits) if (!list.some(at => now - at < 60 * 60 * 1000)) hits.delete(key);
}, 10 * 60 * 1000).unref();
const LOGIN_FAILS_PER_ACCOUNT = 10;
const LOGIN_FAILS_PER_IP = 50;
const REGISTER_PER_IP = 30;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const REGISTER_WINDOW_MS = 60 * 60 * 1000;

const companyIdOf = (req: Request) => {
  const user = (req as Request & { auth: { companyId: number | null } }).auth;
  if (!user.companyId) {
    const error = new Error("Esta conta não pertence a uma empresa");
    (error as Error & { status: number }).status = 400;
    throw error;
  }
  return user.companyId;
};

const planOf = async (companyId: number) => {
  const row = await one<{
    max_connections: number | null;
    max_groups: number | null;
    max_stores: number | null;
    max_posts_per_day: number | null;
    max_users: number | null;
    status: string;
    company_status: string;
    trial_ends_at: string | null;
  }>(
    `SELECT p.max_connections, p.max_groups, p.max_stores, p.max_posts_per_day, p.max_users,
            s.status, c.status AS company_status, s.trial_ends_at
     FROM subscriptions s JOIN plans p ON p.id = s.plan_id JOIN companies c ON c.id = s.company_id
     WHERE s.company_id = $1`,
    [companyId]
  );
  if (!row) throw Object.assign(new Error("Sem assinatura"), { status: 402 });
  if (row.company_status !== "active") throw Object.assign(new Error("Empresa suspensa ou bloqueada"), { status: 403 });
  return row;
};

const assertRoom = async (companyId: number, kind: "connections" | "groups" | "stores" | "users") => {
  const plan = await planOf(companyId);
  const cap = plan[`max_${kind}` as const];
  if (cap == null) return;
  const table = kind === "connections" ? "whatsapp_sessions" : kind === "groups" ? "groups" : kind === "stores" ? "stores" : "users";
  const extra = kind === "stores" || kind === "groups" ? " AND enabled = true" : "";
  const [{ count }] = await q<{ count: string }>(`SELECT count(*)::text AS count FROM ${table} WHERE company_id = $1${extra}`, [companyId]);
  const labels = { connections: "conexões", groups: "grupos", stores: "lojas", users: "usuários" };
  if (Number(count) < cap) return;
  if (kind === "groups") {
    // O limite vale para a empresa toda, mas o painel mostra os grupos de uma conexão por vez:
    // sem dizer onde estão os outros, parecia que o plano bloqueava antes da hora.
    const rows = await q<{ name: string; count: string }>(
      `SELECT coalesce(w.name, 'sem conexão') AS name, count(*)::text AS count
       FROM groups g LEFT JOIN whatsapp_sessions w ON w.id = g.whatsapp_id
       WHERE g.company_id = $1 AND g.enabled = true GROUP BY w.name ORDER BY count(*) DESC`,
      [companyId]
    );
    const where = rows.map(row => `${row.count} em ${row.name}`).join(", ");
    throw Object.assign(
      new Error(`O plano permite até ${cap} grupos ativos somando todas as conexões, e já há ${count} (${where}). Desative um grupo para ativar outro.`),
      { status: 402 }
    );
  }
  throw Object.assign(new Error(`O plano permite até ${cap} ${labels[kind]}`), { status: 402 });
};

const STORES = ["ml", "amazon", "shopee", "aliexpress", "magalu", "rakuten", "awin", "shein", "samsung", "casasbahia", "natura", "paguemenos", "epoca", "terabyte"];

const secretsOf = (packed: string) => {
  const raw = decrypt(packed);
  if (!raw) return {} as Record<string, string>;
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => String(value || "").trim()).map(([key, value]) => [key, String(value)])
    );
  } catch {
    return {};
  }
};

/** Conta "leitura" (member) não altera lojas, então não recebe o valor das credenciais, só quais existem. */
const canSeeSecrets = (req: Request) => (req as Request & { auth: { role: string } }).auth.role !== "member";

const publicStore = (row: { marketplace: string; enabled: boolean; public_config: Record<string, string>; secrets_enc: string }, reveal = true) => {
  const secrets = secretsOf(row.secrets_enc);
  return {
    marketplace: row.marketplace,
    label: marketplaceLabel(row.marketplace),
    enabled: row.enabled,
    config: row.public_config || {},
    secrets: reveal ? secrets : {},
    hasSecrets: Object.keys(secrets).length > 0,
    secretKeys: Object.keys(secrets),
    publishes: !["magalu", "shein", "terabyte"].includes(row.marketplace)
  };
};

export const app = express();

/**
 * Express 4 não trata promessas rejeitadas: o erro vira unhandledRejection e o Node 22 encerra o processo.
 * Um único GET /vitrine/<texto> derrubava a API. Aqui toda rota registrada encaminha a rejeição para o
 * tratador de erro do fim do arquivo, sem mudar a assinatura de nenhuma rota.
 */
type Handler = (req: Request, res: Response, next: NextFunction) => unknown;
const forwardRejections = (handler: unknown) => {
  if (typeof handler !== "function" || handler.length >= 4) return handler;
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = (handler as Handler)(req, res, next);
      if (result && typeof (result as Promise<unknown>).then === "function") (result as Promise<unknown>).catch(next);
      return result;
    } catch (err) {
      return next(err);
    }
  };
};
for (const method of ["get", "post", "put", "patch", "delete"] as const) {
  const original = app[method].bind(app) as (...args: unknown[]) => unknown;
  (app as unknown as Record<string, unknown>)[method] = (...args: unknown[]) =>
    args.length <= 1 ? original(...args) : original(args[0], ...args.slice(1).map(forwardRejections));
}

app.disable("x-powered-by");
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.get("/api/plans", async (_req, res) => {
  const plans = await q("SELECT id, name, slug, description, benefits, monthly_cents, yearly_cents, trial_days, max_connections, max_groups FROM plans WHERE active = true ORDER BY sort_order, monthly_cents");
  res.json({ plans });
});

app.get("/api/testimonials", async (_req, res) => {
  const rows = await q("SELECT id, author, company, quote FROM testimonials WHERE active = true ORDER BY sort_order, id");
  res.json({ testimonials: rows });
});

app.post("/api/auth/register", async (req, res, next) => {
  try {
    const name = String(req.body?.name || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const companyName = String(req.body?.companyName || "").trim();
    const phone = String(req.body?.phone || "").replace(/\D/g, "").slice(0, 16);
    const city = String(req.body?.city || "").trim().slice(0, 80);
    const state = String(req.body?.state || "").trim().toUpperCase();
    const planSlug = String(req.body?.planSlug || "starter");
    const refCode = String(req.body?.ref || "").trim().toUpperCase().slice(0, 32);
    const ipKey = `register:${ipOf(req)}`;
    if (limited(ipKey, REGISTER_PER_IP, REGISTER_WINDOW_MS)) {
      return res.status(429).json({ error: "Muitos cadastros a partir deste endereço. Tente de novo mais tarde." });
    }
    hit(ipKey);
    if (!name || !email || password.length < 6 || !companyName || !city || !/^[A-Z]{2}$/.test(state)) {
      return res.status(400).json({ error: "Informe nome, empresa, cidade, estado, e-mail e senha com 6 caracteres" });
    }
    if (!validEmail(email) || name.length > 120 || companyName.length > 120 || password.length > 200) {
      return res.status(400).json({ error: "Confira o e-mail e o tamanho dos campos" });
    }
    const plan = await one<{ id: number; trial_days: number }>("SELECT id, trial_days FROM plans WHERE slug = $1 AND active = true", [planSlug]);
    if (!plan) return res.status(400).json({ error: "Plano inválido" });
    // Código de indicação: liga a empresa ao parceiro, que ganha comissão de cada pagamento enquanto ela pagar.
    const partner = refCode ? await one<{ id: number }>("SELECT id FROM partners WHERE upper(code) = $1 AND active = true", [refCode]) : null;
    const hash = await bcrypt.hash(password, 10);
    // Empresa, dono, assinatura e configurações nascem juntos. Antes, um e-mail repetido deixava a empresa órfã no banco.
    const { company, user } = await withTransaction(async tx => {
      const company = await tx.one<{ id: number; tenant_id: string }>(
        "INSERT INTO companies (name, city, state, partner_id, partner_since) VALUES ($1,$2,$3,$4, CASE WHEN $4::int IS NULL THEN NULL ELSE now() END) RETURNING id, tenant_id",
        [companyName, city, state, partner?.id ?? null]
      );
      if (!company) throw new Error("Falha ao criar empresa");
      const user = await tx.one<{ id: number }>(
        "INSERT INTO users (company_id, name, email, password_hash, role, phone) VALUES ($1,$2,$3,$4,'owner',$5) RETURNING id",
        [company.id, name, email, hash, phone]
      );
      await tx.q(
        "INSERT INTO subscriptions (company_id, plan_id, status, trial_ends_at) VALUES ($1,$2,'trialing', now() + ($3 || ' days')::interval)",
        [company.id, plan.id, String(plan.trial_days)]
      );
      await tx.q("INSERT INTO settings (company_id) VALUES ($1)", [company.id]);
      return { company, user };
    });
    await audit(company.id, user!.id, "register", `Conta criada no plano ${planSlug}`, ipOf(req));
    const full = await loadUser(user!.id);
    res.status(201).json({ token: sign(full!), user: full });
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return res.status(409).json({ error: "Este e-mail já tem conta" });
    next(err);
  }
});

app.post("/api/auth/login", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase().slice(0, 254);
  const password = String(req.body?.password || "").slice(0, 200);
  const ip = ipOf(req);
  const accountKey = `login:${ip}:${email}`;
  const ipKey = `login:${ip}`;
  if (limited(accountKey, LOGIN_FAILS_PER_ACCOUNT, LOGIN_WINDOW_MS) || limited(ipKey, LOGIN_FAILS_PER_IP, LOGIN_WINDOW_MS)) {
    return res.status(429).json({ error: "Muitas tentativas. Espere alguns minutos e tente de novo." });
  }
  const row = await one<{ id: number; password_hash: string }>("SELECT id, password_hash FROM users WHERE email = $1", [email]);
  if (!row || !(await bcrypt.compare(password, row.password_hash))) {
    hit(accountKey);
    hit(ipKey);
    return res.status(401).json({ error: "E-mail ou senha incorretos" });
  }
  hits.delete(accountKey);
  const user = await loadUser(row.id);
  if (!user) return res.status(401).json({ error: "Conta inválida" });
  if (user.companyStatus === "blocked") return res.status(403).json({ error: "Empresa bloqueada" });
  await q("UPDATE users SET last_login_at = now() WHERE id = $1", [user.id]);
  await audit(user.companyId, user.id, "login", "Login", ipOf(req));
  res.json({ token: sign(user), user });
});

app.post("/api/auth/logout", auth, async (req, res) => {
  const user = (req as Request & { auth: AuthUser }).auth;
  await audit(user.companyId, user.id, "logout", "Logout", ipOf(req));
  res.json({ ok: true });
});

app.get("/api/me", auth, async (req, res) => {
  const user = (req as Request & { auth: Awaited<ReturnType<typeof loadUser>> }).auth!;
  let subscription = null;
  if (user.companyId) {
    subscription = await one(
      `SELECT s.status, s.trial_ends_at, s.current_period_end, s.cycle, p.name AS plan_name, p.slug,
              p.max_connections, p.max_groups, p.max_stores, p.max_posts_per_day, p.max_posts_per_month, p.max_users, p.features, c.status AS company_status, c.name AS company_name, c.city, c.state, c.tenant_id
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id JOIN companies c ON c.id = s.company_id WHERE s.company_id = $1`,
      [user.companyId]
    );
  }
  res.json({ user, subscription, efi: await efiConfigured() });
});

app.get("/api/admin/overview", auth, admin, async (_req, res) => {
  const companies = await q(
    `SELECT c.id, c.tenant_id, c.name, c.status, c.created_at, p.name AS plan_name, s.status AS sub_status, s.trial_ends_at, s.current_period_end,
            (SELECT count(*) FROM whatsapp_sessions w WHERE w.company_id = c.id AND w.status = 'connected') AS whatsapps,
            (SELECT count(*) FROM posts po WHERE po.company_id = c.id AND po.status = 'sent') AS posts,
            (SELECT coalesce(sum(click_count),0) FROM posts po WHERE po.company_id = c.id) AS clicks
     FROM companies c
     LEFT JOIN subscriptions s ON s.company_id = c.id
     LEFT JOIN plans p ON p.id = s.plan_id
     ORDER BY c.id DESC`
  );
  const plans = await q("SELECT * FROM plans ORDER BY monthly_cents");
  res.json({ companies, plans });
});

app.post("/api/admin/companies", auth, admin, async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const planSlug = String(req.body?.planSlug || "");
  const ownerName = String(req.body?.ownerName || "").trim();
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  if (!name) return res.status(400).json({ error: "Informe o nome" });
  if (email && !validEmail(email)) return res.status(400).json({ error: "E-mail inválido" });
  if ((email || password || ownerName) && (!ownerName || !email || password.length < 6)) {
    return res.status(400).json({ error: "Para criar o acesso, informe nome, e-mail e senha com 6 caracteres" });
  }
  const plan = await one<{ id: number; trial_days: number }>("SELECT id, trial_days FROM plans WHERE slug = $1 AND active = true", [planSlug]);
  if (!plan) return res.status(400).json({ error: "Escolha um plano ativo" });
  if (email) {
    const taken = await one("SELECT id FROM users WHERE lower(email) = $1", [email]);
    if (taken) return res.status(409).json({ error: "Este e-mail já tem conta" });
  }
  const company = await one<{ id: number }>("INSERT INTO companies (name) VALUES ($1) RETURNING id", [name]);
  if (!company) return res.status(500).json({ error: "Falha ao criar empresa" });
  await q(
    "INSERT INTO subscriptions (company_id, plan_id, status, trial_ends_at) VALUES ($1,$2,'trialing', now() + ($3 || ' days')::interval)",
    [company.id, plan.id, String(plan.trial_days)]
  );
  await q("INSERT INTO settings (company_id) VALUES ($1)", [company.id]);
  if (email) {
    const hash = await bcrypt.hash(password, 10);
    await q(
      "INSERT INTO users (company_id, name, email, password_hash, role) VALUES ($1,$2,$3,$4,'owner')",
      [company.id, ownerName, email, hash]
    );
  }
  await audit(company.id, (req as Request & { auth: AuthUser }).auth.id, "admin", `Empresa ${name} criada`, ipOf(req));
  res.status(201).json({ company });
});

app.patch("/api/admin/companies/:id", auth, admin, async (req, res) => {
  const id = Number(req.params.id);
  const status = String(req.body?.status || "");
  const subStatus = String(req.body?.subStatus || "");
  const validUntil = String(req.body?.validUntil || "");
  const hasStatus = ["active", "suspended", "blocked"].includes(status);
  const hasSub = ["trialing", "active", "canceled"].includes(subStatus);
  if (!hasStatus && !hasSub && !validUntil && !req.body?.planSlug && !req.body?.name) {
    return res.status(400).json({ error: "Nada para atualizar" });
  }
  if (req.body?.name) await q("UPDATE companies SET name = $2, updated_at = now() WHERE id = $1", [id, String(req.body.name).trim()]);
  if (hasStatus) await q("UPDATE companies SET status = $2, updated_at = now() WHERE id = $1", [id, status]);
  if (req.body?.planSlug) {
    const plan = await one<{ id: number }>("SELECT id FROM plans WHERE slug = $1", [String(req.body.planSlug)]);
    if (!plan) return res.status(400).json({ error: "Plano inválido" });
    await q("UPDATE subscriptions SET plan_id = $2, updated_at = now() WHERE company_id = $1", [id, plan.id]);
  }
  if (hasSub || validUntil) {
    const current = await one<{ status: string }>("SELECT status FROM subscriptions WHERE company_id = $1", [id]);
    const next = hasSub ? subStatus : current?.status || "trialing";
    const until = /^\d{4}-\d{2}-\d{2}$/.test(validUntil) ? `${validUntil}T23:59:59` : null;
    if (next === "canceled") {
      await q("UPDATE subscriptions SET status = 'canceled', updated_at = now() WHERE company_id = $1", [id]);
      if (!hasStatus) await q("UPDATE companies SET status = 'suspended', updated_at = now() WHERE id = $1 AND status <> 'blocked'", [id]);
    } else if (next === "trialing") {
      await q("UPDATE subscriptions SET status = 'trialing', trial_ends_at = COALESCE($2::timestamptz, trial_ends_at), updated_at = now() WHERE company_id = $1", [id, until]);
    } else {
      await q("UPDATE subscriptions SET status = 'active', current_period_end = COALESCE($2::timestamptz, current_period_end), updated_at = now() WHERE company_id = $1", [id, until]);
      if (!hasStatus) await q("UPDATE companies SET status = 'active', updated_at = now() WHERE id = $1 AND status <> 'blocked'", [id]);
    }
  }
  await audit(id, (req as Request & { auth: AuthUser }).auth.id, "admin", `Empresa ${id} atualizada`, ipOf(req));
  res.json({ ok: true });
});

app.delete("/api/admin/companies/:id", auth, admin, async (req, res) => {
  const id = Number(req.params.id);
  const company = await one<{ name: string }>("SELECT name FROM companies WHERE id = $1", [id]);
  await audit(null, (req as Request & { auth: AuthUser }).auth.id, "delete", `Empresa ${company?.name || id} excluída`, ipOf(req));
  await q("DELETE FROM companies WHERE id = $1", [id]);
  res.json({ ok: true });
});

const slugify = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

const planValues = (body: Record<string, unknown>) => ({
  name: String(body.name || "").trim(),
  slug: slugify(String(body.slug || body.name || "")),
  description: String(body.description || ""),
  benefits: String(body.benefits || ""),
  monthly: Math.round(Number(body.monthlyCents) || 0),
  quarterly: body.quarterlyCents == null || body.quarterlyCents === "" ? null : Math.round(Number(body.quarterlyCents)),
  semiannual: body.semiannualCents == null || body.semiannualCents === "" ? null : Math.round(Number(body.semiannualCents)),
  yearly: Math.round(Number(body.yearlyCents) || 0),
  trial: Number(body.trialDays ?? 7),
  connections: body.maxConnections == null || body.maxConnections === "" ? null : Number(body.maxConnections),
  groups: body.maxGroups == null || body.maxGroups === "" ? null : Number(body.maxGroups),
  stores: body.maxStores == null || body.maxStores === "" ? null : Number(body.maxStores),
  posts: body.maxPostsPerDay == null || body.maxPostsPerDay === "" ? null : Number(body.maxPostsPerDay),
  postsMonth: body.maxPostsPerMonth == null || body.maxPostsPerMonth === "" ? null : Number(body.maxPostsPerMonth),
  users: body.maxUsers == null || body.maxUsers === "" ? null : Number(body.maxUsers),
  sort: Number(body.sortOrder || 0),
  features: JSON.stringify({ api: Boolean(body.api), prioritySupport: Boolean(body.prioritySupport) }),
  active: body.active !== false
});

app.post("/api/admin/plans", auth, admin, async (req, res) => {
  const plan = planValues(req.body || {});
  if (!plan.name || !plan.slug) return res.status(400).json({ error: "Informe o nome do plano" });
  const row = await one(
    `INSERT INTO plans (name, slug, description, benefits, monthly_cents, quarterly_cents, semiannual_cents, yearly_cents, trial_days, max_connections, max_groups, max_stores, max_posts_per_day, max_posts_per_month, max_users, sort_order, features, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18) RETURNING *`,
    [plan.name, plan.slug, plan.description, plan.benefits, plan.monthly, plan.quarterly, plan.semiannual, plan.yearly, plan.trial, plan.connections, plan.groups, plan.stores, plan.posts, plan.postsMonth, plan.users, plan.sort, plan.features, plan.active]
  );
  await audit(null, (req as Request & { auth: AuthUser }).auth.id, "plan", `Plano ${plan.name} criado`, ipOf(req));
  res.status(201).json({ plan: row });
});

app.patch("/api/admin/plans/:id", auth, admin, async (req, res) => {
  const plan = planValues(req.body || {});
  await q(
    `UPDATE plans SET name = $2, description = $3, benefits = $4, monthly_cents = $5, quarterly_cents = $6, semiannual_cents = $7, yearly_cents = $8,
      trial_days = $9, max_connections = $10, max_groups = $11, max_stores = $12, max_posts_per_day = $13, max_posts_per_month = $14, max_users = $15,
      sort_order = $16, features = $17::jsonb, active = $18
     WHERE id = $1`,
    [Number(req.params.id), plan.name, plan.description, plan.benefits, plan.monthly, plan.quarterly, plan.semiannual, plan.yearly, plan.trial, plan.connections, plan.groups, plan.stores, plan.posts, plan.postsMonth, plan.users, plan.sort, plan.features, plan.active]
  );
  await audit(null, (req as Request & { auth: AuthUser }).auth.id, "plan", `Plano ${plan.name} atualizado`, ipOf(req));
  res.json({ ok: true });
});

app.delete("/api/admin/plans/:id", auth, admin, async (req, res) => {
  const id = Number(req.params.id);
  const plan = await one<{ name: string }>("SELECT name FROM plans WHERE id = $1", [id]);
  if (!plan) return res.status(404).json({ error: "Plano não encontrado" });
  const used = await one<{ companies: number }>(
    "SELECT count(*)::int AS companies FROM subscriptions WHERE plan_id = $1",
    [id]
  );
  if ((used?.companies || 0) > 0) {
    return res.status(409).json({ error: `${plan.name} está em ${used?.companies} empresa(s). Mude o plano delas antes de excluir.` });
  }
  await q("UPDATE invoices SET plan_id = NULL WHERE plan_id = $1", [id]);
  await q("DELETE FROM plans WHERE id = $1", [id]);
  await audit(null, (req as Request & { auth: AuthUser }).auth.id, "plan", `Plano ${plan.name} excluído`, ipOf(req));
  res.json({ ok: true });
});

app.get("/api/admin/console", auth, admin, async (_req, res, next) => {
  try {
    const [metrics] = await q(
      `SELECT
         count(*) FILTER (WHERE c.status = 'active' AND coalesce(s.status, '') = 'active')::int AS active_paid,
         count(*) FILTER (WHERE coalesce(s.status, '') = 'trialing' AND c.status <> 'blocked')::int AS trialing,
         count(*) FILTER (WHERE c.status = 'blocked')::int AS blocked,
         count(*) FILTER (WHERE c.status = 'suspended' AND coalesce(s.status, '') <> 'canceled')::int AS suspended,
         count(*) FILTER (WHERE coalesce(s.status, '') = 'canceled')::int AS canceled,
         count(*) FILTER (WHERE coalesce(s.status, '') = 'trialing' AND s.trial_ends_at < now())::int AS trial_expired,
         count(*) FILTER (WHERE coalesce(s.status, '') = 'active' AND s.current_period_end IS NOT NULL AND s.current_period_end < now())::int AS period_expired,
         (SELECT count(*)::int FROM whatsapp_sessions WHERE status = 'connected') AS whatsapps,
         (SELECT count(*)::int FROM groups) AS groups,
         (SELECT count(*)::int FROM posts WHERE status = 'sent' AND created_at >= date_trunc('day', now())) AS posts_today,
         (SELECT coalesce(sum(click_count), 0)::int FROM posts WHERE created_at >= date_trunc('day', now())) AS clicks_today,
         (SELECT coalesce(sum(amount_cents), 0)::int FROM invoices WHERE status = 'paid' AND paid_at >= date_trunc('month', now())) AS revenue_month,
         (SELECT coalesce(sum(amount_cents), 0)::int FROM invoices WHERE status = 'paid' AND paid_at >= date_trunc('year', now())) AS revenue_year,
         (SELECT coalesce(sum(p.monthly_cents), 0)::int FROM subscriptions s2 JOIN plans p ON p.id = s2.plan_id JOIN companies c2 ON c2.id = s2.company_id WHERE c2.status = 'active' AND s2.status = 'active') AS revenue_forecast,
         (SELECT count(DISTINCT company_id)::int FROM invoices WHERE status = 'paid') AS paid_companies,
         (SELECT count(*)::int FROM companies) AS companies
       FROM companies c LEFT JOIN subscriptions s ON s.company_id = c.id`
    );
    const days = await q(
      `SELECT to_char(d::date, 'DD/MM') AS label,
              (SELECT count(*)::int FROM posts p WHERE p.status = 'sent' AND p.created_at::date = d::date) AS posts,
              (SELECT coalesce(sum(click_count), 0)::int FROM posts p WHERE p.status = 'sent' AND p.created_at::date = d::date) AS clicks
       FROM generate_series(current_date - 13, current_date, interval '1 day') d`
    );
    const months = await q(
      `SELECT to_char(m, 'MM/YY') AS label,
              coalesce((SELECT sum(amount_cents)::int FROM invoices i WHERE i.status = 'paid' AND date_trunc('month', i.paid_at) = m), 0) AS revenue,
              (SELECT count(*)::int FROM companies c WHERE date_trunc('month', c.created_at) = m) AS clients,
              (SELECT count(*)::int FROM subscriptions s WHERE s.status = 'canceled' AND date_trunc('month', s.updated_at) = m) AS canceled
       FROM generate_series(date_trunc('month', now()) - interval '11 months', date_trunc('month', now()), interval '1 month') m`
    );
    const due = await q(
      `SELECT c.id, c.name, s.status, coalesce(s.current_period_end, s.trial_ends_at) AS ends_at
       FROM subscriptions s JOIN companies c ON c.id = s.company_id
       WHERE c.status <> 'blocked' AND coalesce(s.current_period_end, s.trial_ends_at) BETWEEN now() AND now() + interval '7 days'
       ORDER BY 4`
    );
    const companies = await q(
      `SELECT c.id, c.tenant_id, c.name, c.city, c.state, c.status, c.created_at,
              u.name AS owner_name, u.email AS owner_email, u.phone AS owner_phone, u.last_login_at,
              p.name AS plan_name, p.slug AS plan_slug, s.status AS sub_status, s.cycle, s.trial_ends_at, s.current_period_end,
              (SELECT count(*)::int FROM whatsapp_sessions w WHERE w.company_id = c.id AND w.status = 'connected') AS whatsapps,
              (SELECT count(*)::int FROM groups g WHERE g.company_id = c.id) AS groups,
              (SELECT count(*)::int FROM stores st WHERE st.company_id = c.id AND st.enabled = true) AS stores,
              (SELECT count(*)::int FROM posts po WHERE po.company_id = c.id AND po.status = 'sent') AS posts,
              (SELECT coalesce(sum(click_count), 0)::int FROM posts po WHERE po.company_id = c.id) AS clicks,
              (SELECT coalesce(sum(amount_cents), 0)::int FROM invoices i WHERE i.company_id = c.id AND i.status = 'paid') AS revenue_cents,
              pa.name AS partner_name, pa.code AS partner_code, c.partner_since
       FROM companies c
       LEFT JOIN partners pa ON pa.id = c.partner_id
       LEFT JOIN subscriptions s ON s.company_id = c.id
       LEFT JOIN plans p ON p.id = s.plan_id
       LEFT JOIN LATERAL (SELECT name, email, phone, last_login_at FROM users WHERE company_id = c.id AND role = 'owner' ORDER BY id LIMIT 1) u ON true
       ORDER BY c.id DESC`
    );
    const plans = await q("SELECT * FROM plans ORDER BY sort_order, monthly_cents");
    const partners = await q(
      `SELECT p.*,
              (SELECT count(*)::int FROM companies c WHERE c.partner_id = p.id) AS companies,
              (SELECT count(*)::int FROM companies c JOIN subscriptions s ON s.company_id = c.id WHERE c.partner_id = p.id AND c.status = 'active' AND s.status = 'active') AS active_companies,
              (SELECT coalesce(sum(partner_cents), 0)::int FROM invoices i WHERE i.partner_id = p.id AND i.status = 'paid') AS earned_cents,
              (SELECT coalesce(sum(partner_cents), 0)::int FROM invoices i WHERE i.partner_id = p.id AND i.status = 'paid' AND i.paid_at >= date_trunc('month', now())) AS earned_month_cents,
              (SELECT coalesce(sum(amount_cents), 0)::int FROM partner_payouts po WHERE po.partner_id = p.id) AS paid_cents
       FROM partners p ORDER BY p.active DESC, p.name`
    );
    const subscriptions = await q(
      `SELECT s.id, c.name AS company, p.name AS plan, s.status, s.cycle, s.created_at, s.trial_ends_at, s.current_period_end,
              CASE s.cycle WHEN 'yearly' THEN p.yearly_cents WHEN 'semiannual' THEN p.semiannual_cents WHEN 'quarterly' THEN p.quarterly_cents ELSE p.monthly_cents END AS amount_cents
       FROM subscriptions s JOIN companies c ON c.id = s.company_id JOIN plans p ON p.id = s.plan_id ORDER BY s.id DESC`
    );
    const invoices = await q(
      `SELECT i.id, c.name AS company, i.amount_cents, i.method, i.cycle, i.status, i.created_at, i.paid_at
       FROM invoices i JOIN companies c ON c.id = i.company_id ORDER BY i.id DESC LIMIT 200`
    );
    const whatsapp = await q(
      `SELECT w.id, w.name, w.status, w.phone, w.last_error, w.created_at, (w.qr <> '') AS has_qr, c.name AS company,
              (SELECT count(*)::int FROM posts p WHERE p.company_id = w.company_id AND p.status = 'sent') AS posts
       FROM whatsapp_sessions w JOIN companies c ON c.id = w.company_id ORDER BY w.id DESC`
    );
    const stores = await q(
      `SELECT marketplace, count(*) FILTER (WHERE enabled)::int AS enabled, count(*)::int AS total
       FROM stores GROUP BY marketplace ORDER BY enabled DESC, marketplace`
    );
    const coupons = await q("SELECT * FROM coupons ORDER BY id DESC");
    const logs = await q(
      `SELECT * FROM (
         SELECT 'publicação' AS kind, c.name AS company, s.last_error AS message, s.last_run_at AS at
         FROM settings s JOIN companies c ON c.id = s.company_id
         WHERE coalesce(s.last_error, '') <> ''
         UNION ALL
         SELECT 'pagamento', c.name, pe.kind, pe.created_at
         FROM payment_events pe LEFT JOIN companies c ON c.id = pe.company_id
       ) rows ORDER BY at DESC NULLS LAST LIMIT 120`
    );
    const auditLogs = await q(
      `SELECT a.id, a.action, a.summary, a.ip, a.created_at, c.name AS company, u.name AS actor, u.email AS actor_email
       FROM audit_logs a
       LEFT JOIN companies c ON c.id = a.company_id
       LEFT JOIN users u ON u.id = a.user_id
       ORDER BY a.id DESC LIMIT 200`
    );
    const platform = await loadPlatform();
    const efi = await loadEfiRuntime();
    res.json({
      metrics, days, months, due, companies, plans, partners, subscriptions, invoices, whatsapp, stores, coupons, logs, audit: auditLogs,
      platform: {
        clientId: platform.efi_client_id || process.env.EFI_CLIENT_ID || "",
        pixKey: platform.efi_pix_key || process.env.EFI_PIX_KEY || "",
        sandbox: efi.sandbox,
        webhookUrl: platform.efi_webhook_url || "",
        secretSet: efi.secretSet,
        certReady: efi.certReady,
        trialDays: platform.trial_days_default,
        warnDays: platform.warn_days,
        blockAfterDays: platform.block_after_days,
        fromEnv: !platform.efi_client_id && Boolean(process.env.EFI_CLIENT_ID),
        smtpHost: platform.smtp_host || "",
        smtpPort: platform.smtp_port || 587,
        smtpUser: platform.smtp_user || "",
        smtpFrom: platform.smtp_from || "",
        smtpSet: Boolean(platform.smtp_pass_enc || platform.smtp_host),
        paymentProvider: platform.payment_provider || "",
        pagbankSet: Boolean(platform.pagbank_token_enc),
        pagbankSandbox: platform.pagbank_sandbox !== false,
        publicUrl: platform.public_url || ""
      },
      reminders: await q("SELECT n.id, c.name AS company, n.title, n.status, n.channel, n.detail, n.created_at FROM notices n JOIN companies c ON c.id = n.company_id ORDER BY n.id DESC LIMIT 40"),
      testimonials: await q("SELECT * FROM testimonials ORDER BY sort_order, id")
    });
  } catch (err) {
    next(err);
  }
});

app.post("/api/admin/companies/:id/enter", auth, admin, async (req, res) => {
  const id = Number(req.params.id);
  const owner = await one<{ id: number }>("SELECT id FROM users WHERE company_id = $1 AND role = 'owner' ORDER BY id LIMIT 1", [id]);
  if (!owner) return res.status(404).json({ error: "Essa empresa não tem um usuário dono" });
  const user = await loadUser(owner.id);
  if (!user) return res.status(404).json({ error: "Usuário não encontrado" });
  await audit(id, (req as Request & { auth: AuthUser }).auth.id, "impersonate", `Super admin entrou como ${user.email}`, ipOf(req));
  res.json({ token: sign(user) });
});

app.post("/api/admin/companies/:id/renew", auth, admin, async (req, res) => {
  const id = Number(req.params.id);
  const days = Math.min(365, Math.max(1, Number(req.body?.days) || 30));
  await q("UPDATE subscriptions SET status = 'active', current_period_end = now() + ($2 || ' days')::interval, updated_at = now() WHERE company_id = $1", [id, String(days)]);
  await q("UPDATE companies SET status = 'active', updated_at = now() WHERE id = $1 AND status <> 'blocked'", [id]);
  await audit(id, (req as Request & { auth: AuthUser }).auth.id, "renew", `Renovação manual de ${days} dias`, ipOf(req));
  res.json({ ok: true });
});

app.post("/api/admin/companies/:id/cancel", auth, admin, async (req, res) => {
  const id = Number(req.params.id);
  await q("UPDATE subscriptions SET status = 'canceled', updated_at = now() WHERE company_id = $1", [id]);
  await q("UPDATE companies SET status = 'suspended', updated_at = now() WHERE id = $1", [id]);
  await audit(id, (req as Request & { auth: AuthUser }).auth.id, "cancel", "Assinatura cancelada", ipOf(req));
  res.json({ ok: true });
});

app.get("/api/admin/whatsapp/:id", auth, admin, async (req, res) => {
  const row = await one<{ qr: string; status: string; name: string }>("SELECT qr, status, name FROM whatsapp_sessions WHERE id = $1", [Number(req.params.id)]);
  if (!row) return res.status(404).json({ error: "Conexão não encontrada" });
  res.json({ qr: row.status === "qrcode" ? row.qr : "", status: row.status, name: row.name });
});

app.put("/api/admin/platform", auth, admin, async (req, res) => {
  const current = await loadPlatform();
  const clientId = String(req.body?.clientId ?? current.efi_client_id).trim();
  const pixKey = String(req.body?.pixKey ?? current.efi_pix_key).trim();
  const webhookUrl = String(req.body?.webhookUrl ?? current.efi_webhook_url).trim();
  const sandbox = req.body?.sandbox == null ? current.efi_sandbox : Boolean(req.body.sandbox);
  const incomingSecret = String(req.body?.clientSecret || "").trim();
  const secret = incomingSecret ? encrypt(incomingSecret) : current.efi_client_secret_enc;
  const trialDays = Math.min(60, Math.max(0, Number(req.body?.trialDays ?? current.trial_days_default)));
  const blockAfterDays = Math.min(60, Math.max(0, Number(req.body?.blockAfterDays ?? current.block_after_days)));
  const warnDays = String(req.body?.warnDays ?? current.warn_days).replace(/[^\d,]/g, "") || "7,3,1";
  const smtpHost = req.body?.smtpHost == null ? current.smtp_host : String(req.body.smtpHost).trim();
  const smtpPort = Math.min(65535, Math.max(1, Number(req.body?.smtpPort ?? current.smtp_port) || 587));
  const smtpUser = req.body?.smtpUser == null ? current.smtp_user : String(req.body.smtpUser).trim();
  const smtpFrom = req.body?.smtpFrom == null ? current.smtp_from : String(req.body.smtpFrom).trim();
  const smtpPass = String(req.body?.smtpPass || "").trim();
  const smtpPassEnc = smtpPass ? encrypt(smtpPass) : current.smtp_pass_enc;
  // PagBank: token cifrado (em branco mantém o atual), ambiente, qual cobrança está ativa e o endereço público do site.
  const pagbankToken = String(req.body?.pagbankToken || "").trim();
  const paymentProvider = req.body?.paymentProvider == null ? current.payment_provider : (["pagbank", "efi"].includes(String(req.body.paymentProvider)) ? String(req.body.paymentProvider) : "");
  const publicUrl = req.body?.publicUrl == null ? current.public_url : String(req.body.publicUrl).trim().replace(/\/+$/, "");
  if (publicUrl && !/^https:\/\/[^\s/]+$/i.test(publicUrl)) return res.status(400).json({ error: "O endereço do site precisa ser https://dominio, sem barra no fim" });
  await q(
    "UPDATE platform_settings SET payment_provider = $1, pagbank_token_enc = $2, pagbank_sandbox = $3, public_url = $4 WHERE id = 1",
    [paymentProvider, pagbankToken ? encrypt(pagbankToken) : current.pagbank_token_enc, req.body?.pagbankSandbox == null ? current.pagbank_sandbox : Boolean(req.body.pagbankSandbox), publicUrl]
  );
  await q(
    `UPDATE platform_settings SET efi_client_id = $1, efi_client_secret_enc = $2, efi_pix_key = $3, efi_sandbox = $4, efi_webhook_url = $5,
      trial_days_default = $6, warn_days = $7, block_after_days = $8, smtp_host = $9, smtp_port = $10, smtp_user = $11, smtp_pass_enc = $12, smtp_from = $13, updated_at = now() WHERE id = 1`,
    [clientId, secret, pixKey, sandbox, webhookUrl, trialDays, warnDays, blockAfterDays, smtpHost, smtpPort, smtpUser, smtpPassEnc, smtpFrom]
  );
  await audit(null, (req as Request & { auth: AuthUser }).auth.id, "platform", "Configuração da plataforma atualizada", ipOf(req));
  res.json({ ok: true });
});

app.post("/api/admin/pagbank/test", auth, admin, async (req, res) => {
  try {
    const result = await testPagbank();
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.post("/api/admin/efi/test", auth, admin, async (req, res) => {
  try {
    const result = await testEfiConnection();
    await audit(null, (req as Request & { auth: AuthUser }).auth.id, "efi", "Teste de conexão EFI ok", ipOf(req));
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "A EFI não respondeu";
    res.status(502).json({ error: message.slice(0, 220) });
  }
});

const PARTNER_CODE = /^[A-Z0-9_-]{3,24}$/;

app.post("/api/admin/partners", auth, admin, async (req, res) => {
  const name = String(req.body?.name || "").trim().slice(0, 120);
  const code = String(req.body?.code || "").trim().toUpperCase();
  const percent = Math.round(Number(req.body?.percent));
  if (!name) return res.status(400).json({ error: "Informe o nome do parceiro" });
  if (!PARTNER_CODE.test(code)) return res.status(400).json({ error: "O código precisa ter de 3 a 24 letras ou números" });
  if (!Number.isFinite(percent) || percent < 1 || percent > 90) return res.status(400).json({ error: "A comissão precisa ficar entre 1% e 90%" });
  try {
    const row = await one(
      "INSERT INTO partners (name, phone, code, percent, notes) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [name, String(req.body?.phone || "").replace(/\D/g, "").slice(0, 16), code, percent, String(req.body?.notes || "").slice(0, 500)]
    );
    await audit(null, (req as Request & { auth: AuthUser }).auth.id, "partner", `Parceiro ${name} (${code}) criado com ${percent}%`, ipOf(req));
    res.status(201).json({ partner: row });
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return res.status(409).json({ error: "Esse código já existe" });
    throw err;
  }
});

app.patch("/api/admin/partners/:id", auth, admin, async (req, res) => {
  const id = Number(req.params.id);
  const percent = req.body?.percent == null ? null : Math.round(Number(req.body.percent));
  if (percent != null && (!Number.isFinite(percent) || percent < 1 || percent > 90)) return res.status(400).json({ error: "A comissão precisa ficar entre 1% e 90%" });
  await q(
    `UPDATE partners SET name = COALESCE($2, name), phone = COALESCE($3, phone), percent = COALESCE($4, percent),
       active = COALESCE($5, active), notes = COALESCE($6, notes) WHERE id = $1`,
    [id, req.body?.name ? String(req.body.name).trim().slice(0, 120) : null, req.body?.phone == null ? null : String(req.body.phone).replace(/\D/g, "").slice(0, 16),
     percent, typeof req.body?.active === "boolean" ? req.body.active : null, req.body?.notes == null ? null : String(req.body.notes).slice(0, 500)]
  );
  await audit(null, (req as Request & { auth: AuthUser }).auth.id, "partner", `Parceiro ${id} atualizado`, ipOf(req));
  res.json({ ok: true });
});

app.get("/api/admin/partners/:id", auth, admin, async (req, res) => {
  const id = Number(req.params.id);
  const companies = await q(
    `SELECT c.id, c.name, c.status, c.partner_since, s.status AS sub_status, coalesce(s.current_period_end, s.trial_ends_at) AS ends_at,
            (SELECT coalesce(sum(partner_cents), 0)::int FROM invoices i WHERE i.company_id = c.id AND i.partner_id = $1 AND i.status = 'paid') AS earned_cents
     FROM companies c LEFT JOIN subscriptions s ON s.company_id = c.id WHERE c.partner_id = $1 ORDER BY c.id DESC`,
    [id]
  );
  const commissions = await q(
    `SELECT i.id, c.name AS company, i.amount_cents, i.partner_cents, i.method, i.paid_at
     FROM invoices i JOIN companies c ON c.id = i.company_id WHERE i.partner_id = $1 AND i.status = 'paid' ORDER BY i.paid_at DESC LIMIT 200`,
    [id]
  );
  const payouts = await q("SELECT id, amount_cents, note, paid_at FROM partner_payouts WHERE partner_id = $1 ORDER BY paid_at DESC", [id]);
  res.json({ companies, commissions, payouts });
});

app.post("/api/admin/partners/:id/payouts", auth, admin, async (req, res) => {
  const id = Number(req.params.id);
  const amount = Math.round(Number(req.body?.amountCents));
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: "Informe o valor pago" });
  const partner = await one<{ name: string }>("SELECT name FROM partners WHERE id = $1", [id]);
  if (!partner) return res.status(404).json({ error: "Parceiro não encontrado" });
  await q("INSERT INTO partner_payouts (partner_id, amount_cents, note) VALUES ($1,$2,$3)", [id, amount, String(req.body?.note || "").slice(0, 200)]);
  await audit(null, (req as Request & { auth: AuthUser }).auth.id, "partner", `Pagamento de comissão a ${partner.name}: ${(amount / 100).toFixed(2)}`, ipOf(req));
  res.status(201).json({ ok: true });
});

app.post("/api/admin/companies/:id/partner", auth, admin, async (req, res) => {
  const id = Number(req.params.id);
  const code = String(req.body?.code || "").trim().toUpperCase();
  if (!code) {
    await q("UPDATE companies SET partner_id = NULL, partner_since = NULL WHERE id = $1", [id]);
    await audit(id, (req as Request & { auth: AuthUser }).auth.id, "partner", "Indicação removida", ipOf(req));
    return res.json({ ok: true });
  }
  const partner = await one<{ id: number; name: string }>("SELECT id, name FROM partners WHERE upper(code) = $1", [code]);
  if (!partner) return res.status(404).json({ error: "Código de parceiro não encontrado" });
  await q("UPDATE companies SET partner_id = $2, partner_since = COALESCE(CASE WHEN partner_id = $2 THEN partner_since END, now()) WHERE id = $1", [id, partner.id]);
  await audit(id, (req as Request & { auth: AuthUser }).auth.id, "partner", `Empresa ligada ao parceiro ${partner.name}`, ipOf(req));
  res.json({ ok: true });
});

// Pagamento recebido por fora (Pix direto, dinheiro): renova e gera a fatura paga, que conta comissão de parceiro.
app.post("/api/admin/companies/:id/payment", auth, admin, async (req, res) => {
  const id = Number(req.params.id);
  const amount = Math.round(Number(req.body?.amountCents));
  const days = Math.min(365, Math.max(1, Math.round(Number(req.body?.days) || 30)));
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: "Informe o valor recebido" });
  const sub = await one<{ plan_id: number }>("SELECT plan_id FROM subscriptions WHERE company_id = $1", [id]);
  if (!sub) return res.status(404).json({ error: "Empresa sem assinatura" });
  const cycle = days >= 365 ? "yearly" : days >= 180 ? "semiannual" : days >= 90 ? "quarterly" : "monthly";
  await withTransaction(async tx => {
    const invoice = await tx.one<{ id: number }>(
      "INSERT INTO invoices (company_id, plan_id, amount_cents, method, cycle, status, paid_at, external_id) VALUES ($1,$2,$3,'manual',$4,'paid',now(),$5) RETURNING id",
      [id, sub.plan_id, amount, cycle, `manual-${crypto.randomBytes(8).toString("hex")}`]
    );
    await tx.q(
      "UPDATE subscriptions SET status = 'active', current_period_end = GREATEST(now(), coalesce(current_period_end, now())) + ($2 || ' days')::interval, updated_at = now() WHERE company_id = $1",
      [id, String(days)]
    );
    await tx.q("UPDATE companies SET status = 'active', updated_at = now() WHERE id = $1 AND status <> 'blocked'", [id]);
    await tx.q(PARTNER_COMMISSION_SQL, [invoice!.id]);
  });
  await audit(id, (req as Request & { auth: AuthUser }).auth.id, "payment", `Pagamento manual de ${(amount / 100).toFixed(2)} (${days} dias)`, ipOf(req));
  res.json({ ok: true });
});

app.post("/api/admin/coupons", auth, admin, async (req, res) => {
  const code = String(req.body?.code || "").trim().toUpperCase();
  const kind = req.body?.kind === "amount" ? "amount" : "percent";
  if (!/^[A-Z0-9_-]{3,24}$/.test(code)) return res.status(400).json({ error: "O código precisa ter de 3 a 24 letras ou números" });
  const percent = kind === "percent" ? Math.min(100, Math.max(1, Number(req.body?.percent) || 0)) : null;
  const amount = kind === "amount" ? Math.max(1, Math.round(Number(req.body?.amountCents) || 0)) : null;
  if (kind === "percent" && !percent) return res.status(400).json({ error: "Informe o percentual" });
  if (kind === "amount" && !amount) return res.status(400).json({ error: "Informe o valor" });
  const row = await one(
    `INSERT INTO coupons (code, kind, percent, amount_cents, plan_slug, max_uses, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [code, kind, percent, amount, String(req.body?.planSlug || ""), req.body?.maxUses === "" || req.body?.maxUses == null ? null : Number(req.body.maxUses), req.body?.expiresAt || null]
  );
  await audit(null, (req as Request & { auth: AuthUser }).auth.id, "coupon", `Cupom ${code} criado`, ipOf(req));
  res.status(201).json({ coupon: row });
});

app.delete("/api/admin/coupons/:id", auth, admin, async (req, res) => {
  await q("DELETE FROM coupons WHERE id = $1", [Number(req.params.id)]);
  await audit(null, (req as Request & { auth: AuthUser }).auth.id, "coupon", `Cupom ${req.params.id} removido`, ipOf(req));
  res.json({ ok: true });
});

app.patch("/api/admin/profile", auth, admin, async (req, res) => {
  const user = (req as Request & { auth: AuthUser }).auth;
  const name = String(req.body?.name || "").trim();
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  if (!name || !validEmail(email)) return res.status(400).json({ error: "Informe nome e e-mail" });
  if (password && password.length < 6) return res.status(400).json({ error: "A senha precisa ter 6 caracteres" });
  const taken = await one<{ id: number }>("SELECT id FROM users WHERE email = $1 AND id <> $2", [email, user.id]);
  if (taken) return res.status(409).json({ error: "Este e-mail já tem conta" });
  await q("UPDATE users SET name = $2, email = $3 WHERE id = $1", [user.id, name, email]);
  if (password) await q("UPDATE users SET password_hash = $2 WHERE id = $1", [user.id, await bcrypt.hash(password, 10)]);
  await audit(null, user.id, "profile", "Perfil do super admin atualizado", ipOf(req));
  const fresh = await loadUser(user.id);
  res.json({ user: fresh });
});

app.post("/api/admin/password", auth, admin, async (req, res) => {
  const password = String(req.body?.password || "");
  if (password.length < 6) return res.status(400).json({ error: "A senha precisa ter 6 caracteres" });
  const user = (req as Request & { auth: AuthUser }).auth;
  await q("UPDATE users SET password_hash = $2 WHERE id = $1", [user.id, await bcrypt.hash(password, 10)]);
  await audit(null, user.id, "password", "Senha do super admin alterada", ipOf(req));
  res.json({ ok: true });
});

app.get("/api/dashboard", auth, async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    const [today] = await q<{ posts: string; clicks: string }>(
      `SELECT count(*)::text AS posts, coalesce(sum(click_count),0)::text AS clicks FROM posts WHERE company_id = $1 AND status = 'sent' AND created_at >= date_trunc('day', now())`,
      [companyId]
    );
    const bestStore = await one<{ marketplace: string; total: string }>(
      "SELECT marketplace, count(*)::text AS total FROM posts WHERE company_id = $1 AND status = 'sent' GROUP BY marketplace ORDER BY count(*) DESC LIMIT 1",
      [companyId]
    );
    const bestGroup = await one<{ group_name: string; total: string }>(
      "SELECT group_name, count(*)::text AS total FROM posts WHERE company_id = $1 AND status = 'sent' AND group_name <> '' GROUP BY group_name ORDER BY count(*) DESC LIMIT 1",
      [companyId]
    );
    const bestCampaign = await one<{ query: string; marketplace: string }>(
      "SELECT query, marketplace FROM campaigns WHERE company_id = $1 AND enabled = true ORDER BY priority DESC, id ASC LIMIT 1",
      [companyId]
    );
    const setting = await one("SELECT enabled, last_run_at, last_error, posts_per_cycle, interval_seconds FROM settings WHERE company_id = $1", [companyId]);
    const recent = await q("SELECT id, title, marketplace, price_cents, status, created_at, click_count FROM posts WHERE company_id = $1 ORDER BY id DESC LIMIT 8", [companyId]);
    const company = await one<{ tenant_id: string }>("SELECT tenant_id FROM companies WHERE id = $1", [companyId]);
    res.json({ today, bestStore, bestGroup, bestCampaign, setting, recent, tenantId: company?.tenant_id });
  } catch (err) {
    next(err);
  }
});

// Gera (ou troca) a chave da extensão. A chave aparece uma vez; o banco guarda só o hash.
app.post("/api/extension-key", auth, async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    if (!canSeeSecrets(req)) return res.status(403).json({ error: "Só o dono ou um administrador gera a chave da extensão" });
    const { key, hash } = newExtensionKey();
    await q("UPDATE settings SET ext_key_hash = $2 WHERE company_id = $1", [companyId, hash]);
    await audit(companyId, null, "extension_key", "Nova chave da extensão do Mercado Livre", ipOf(req));
    res.json({ key });
  } catch (err) {
    next(err);
  }
});

// A extensão manda o cookie do Mercado Livre sozinha, com a chave gerada no painel.
app.post("/api/extension/ml-cookie", async (req, res, next) => {
  try {
    const ipKey = `ext-cookie:${ipOf(req)}`;
    if (limited(ipKey, 30, 10 * 60_000)) return res.status(429).json({ error: "Muitos envios. Tente de novo em alguns minutos." });
    hit(ipKey);
    const key = String(req.headers["x-achadinhos-key"] || "");
    if (!looksLikeExtensionKey(key)) return res.status(401).json({ error: "Chave da extensão inválida. Gere outra no painel." });
    const row = await one<{ company_id: number }>("SELECT company_id FROM settings WHERE ext_key_hash = $1", [hashExtensionKey(key)]);
    if (!row) return res.status(401).json({ error: "Chave da extensão inválida. Gere outra no painel." });
    const cookie = String(req.body?.cookie || "").trim();
    if (!isMlSessionCookie(cookie)) return res.status(400).json({ error: "Sem login no Mercado Livre neste navegador." });
    const expiresAt = mercadoLivreCookieExpiry(cookie);
    await q(
      "UPDATE settings SET ml_cookie_enc = $2, ml_cookie_expires_at = $3, ml_official = true, ml_cookie_synced_at = now() WHERE company_id = $1",
      [row.company_id, encrypt(cookie), expiresAt]
    );
    res.json({ ok: true, expiresAt });
  } catch (err) {
    next(err);
  }
});

app.get("/api/settings", auth, async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    const setting = await one("SELECT * FROM settings WHERE company_id = $1", [companyId]);
    const cookie = decrypt(String((setting as { ml_cookie_enc?: string })?.ml_cookie_enc || ""));
    res.json({
      setting: setting
        ? { ...setting, ml_cookie_enc: undefined, ext_key_hash: undefined, extKeySet: Boolean((setting as { ext_key_hash?: string }).ext_key_hash), mlCookie: canSeeSecrets(req) ? cookie : "", mlCookieSet: Boolean(cookie), mlCookieExpiresAt: cookie ? mercadoLivreCookieExpiry(cookie) : (setting as { ml_cookie_expires_at?: string }).ml_cookie_expires_at }
        : null
    });
  } catch (err) {
    next(err);
  }
});

app.put("/api/settings", auth, async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    const body = req.body || {};
    const asInt = (value: unknown) => {
      if (value === "" || value == null) return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const sets = ["updated_at = now()"];
    const params: unknown[] = [companyId];
    const set = (column: string, value: unknown, cast = "") => {
      params.push(value);
      sets.push(`${column} = $${params.length}${cast}`);
    };
    if ("enabled" in body) set("enabled", Boolean(body.enabled));
    if ("hourStart" in body) set("hour_start", clockMinutes(body.hourStart));
    if ("hourEnd" in body) set("hour_end", clockMinutes(body.hourEnd));
    if ("allowedDays" in body) set("allowed_days", body.allowedDays == null ? "" : String(body.allowedDays));
    if ("minDiscount" in body) set("min_discount", asInt(body.minDiscount));
    if ("minPriceCents" in body) set("min_price_cents", asInt(body.minPriceCents));
    if ("maxPriceCents" in body) set("max_price_cents", asInt(body.maxPriceCents));
    if ("allowedCategories" in body) set("allowed_categories", body.allowedCategories == null ? "" : String(body.allowedCategories));
    if ("bannedWords" in body) set("banned_words", body.bannedWords == null ? "" : String(body.bannedWords));
    if ("blockedCategories" in body) set("blocked_categories", body.blockedCategories == null ? "" : String(body.blockedCategories));
    if ("sendAllGroups" in body) set("send_all_groups", Boolean(body.sendAllGroups));
    if ("randomCatalog" in body) set("random_catalog", Boolean(body.randomCatalog));
    if ("postsPerCycle" in body) set("posts_per_cycle", asInt(body.postsPerCycle) ?? 1);
    if ("intervalSeconds" in body) set("interval_seconds", asInt(body.intervalSeconds) ?? 20);
    if ("sendCadence" in body) set("send_cadence", JSON.stringify(body.sendCadence || {}), "::jsonb");
    if ("mlTag" in body) set("ml_tag", body.mlTag == null ? "" : String(body.mlTag));
    if ("mlMattTool" in body) set("ml_matt_tool", body.mlMattTool == null ? "" : String(body.mlMattTool));
    if ("mlMattWord" in body) set("ml_matt_word", body.mlMattWord == null ? "" : String(body.mlMattWord));
    if ("mlOfficial" in body) set("ml_official", Boolean(body.mlOfficial));
    await q(`UPDATE settings SET ${sets.join(", ")} WHERE company_id = $1`, params);
    if (typeof body.mlCookie === "string" && body.mlCookie.trim()) {
      const cookie = body.mlCookie.trim();
      await q("UPDATE settings SET ml_cookie_enc = $2, ml_cookie_expires_at = $3, ml_official = true WHERE company_id = $1", [companyId, encrypt(cookie), mercadoLivreCookieExpiry(cookie)]);
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.get("/api/stores", auth, async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    const rows = await q<{ marketplace: string; enabled: boolean; public_config: Record<string, string>; secrets_enc: string }>(
      "SELECT marketplace, enabled, public_config, secrets_enc FROM stores WHERE company_id = $1",
      [companyId]
    );
    const byId = new Map(rows.map(row => [row.marketplace, row]));
    res.json({
      stores: STORES.map(id => publicStore(byId.get(id) || { marketplace: id, enabled: false, public_config: {}, secrets_enc: "" }, canSeeSecrets(req)))
    });
  } catch (err) {
    next(err);
  }
});

app.post("/api/stores/ml/test", auth, async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    const setting = await one<{ ml_cookie_enc: string; ml_tag: string; ml_matt_word: string; ml_matt_tool: string }>(
      "SELECT ml_cookie_enc, ml_tag, ml_matt_word, ml_matt_tool FROM settings WHERE company_id = $1",
      [companyId]
    );
    const cookie = decrypt(setting?.ml_cookie_enc || "");
    if (!cookie) return res.status(400).json({ error: "Cole o Cookie do gerador antes de testar o link oficial." });
    const last = await one<{ url: string }>("SELECT url FROM posts WHERE company_id = $1 AND marketplace = 'ml' AND url <> '' ORDER BY id DESC LIMIT 1", [companyId]);
    const source = String(req.body?.url || last?.url || "").trim();
    if (!source) return res.status(400).json({ error: "Não há produto do Mercado Livre para testar. Publique uma oferta ou cole um link de produto." });
    const url = await createOfficialMlLink({
      cookie,
      tag: setting?.ml_tag || setting?.ml_matt_word || "",
      productUrl: stripMlTracking(source)
    });
    const report = reportMlLink(url, { mattTool: setting?.ml_matt_tool, mattWord: setting?.ml_matt_word });
    res.json({ ok: String(report.verdict || "").startsWith("COMISSÃO GARANTIDA"), url, ...report });
  } catch (err) {
    const error = err as Error & { status?: number };
    error.status = error.status || 400;
    error.message = String(error.message || err).slice(0, 300);
    next(error);
  }
});

app.put("/api/stores/:marketplace", auth, async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    const marketplace = String(req.params.marketplace);
    if (!STORES.includes(marketplace)) return res.status(400).json({ error: "Loja desconhecida" });
    const existing = await one<{ enabled: boolean; secrets_enc: string }>("SELECT enabled, secrets_enc FROM stores WHERE company_id = $1 AND marketplace = $2", [companyId, marketplace]);
    const enabling = req.body?.enabled === true && !existing?.enabled;
    if (enabling) await assertRoom(companyId, "stores");
    const prev = existing ? decrypt(existing.secrets_enc) : "";
    const prevJson = prev ? JSON.parse(prev) as Record<string, string> : {};
    const incoming = (req.body?.secrets || {}) as Record<string, string>;
    const nextSecrets = { ...prevJson };
    for (const [key, value] of Object.entries(incoming)) {
      if (String(value || "").trim()) nextSecrets[key] = String(value).trim();
    }
    await q(
      `INSERT INTO stores (company_id, marketplace, enabled, public_config, secrets_enc)
       VALUES ($1,$2,$3,$4::jsonb,$5)
       ON CONFLICT (company_id, marketplace) DO UPDATE SET enabled = EXCLUDED.enabled, public_config = EXCLUDED.public_config, secrets_enc = EXCLUDED.secrets_enc, updated_at = now()`,
      [companyId, marketplace, Boolean(req.body?.enabled), JSON.stringify(req.body?.config || {}), encrypt(JSON.stringify(nextSecrets))]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.get("/api/campaigns", auth, async (req, res, next) => {
  try {
    res.json({ campaigns: await q("SELECT * FROM campaigns WHERE company_id = $1 ORDER BY id DESC", [companyIdOf(req)]) });
  } catch (err) {
    next(err);
  }
});

app.post("/api/campaigns", auth, async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    const row = await one(
      "INSERT INTO campaigns (company_id, marketplace, query, min_discount, max_price_cents) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [companyId, String(req.body?.marketplace || "ml"), String(req.body?.query || "").trim(), req.body?.minDiscount ?? null, req.body?.maxPriceCents ?? null]
    );
    res.status(201).json({ campaign: row });
  } catch (err) {
    next(err);
  }
});

app.delete("/api/campaigns/:id", auth, async (req, res, next) => {
  try {
    await q("DELETE FROM campaigns WHERE id = $1 AND company_id = $2", [Number(req.params.id), companyIdOf(req)]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.get("/api/offers", auth, async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    const marketplace = String(req.query.marketplace || "");
    const search = String(req.query.search || "").trim();
    const rows = await q(
      `SELECT * FROM offers WHERE company_id = $1
       AND ($2 = '' OR marketplace = $2)
       AND ($3 = '' OR title ILIKE '%' || $3 || '%')
       ORDER BY score DESC, found_at DESC LIMIT 80`,
      [companyId, marketplace, search]
    );
    res.json({ offers: rows });
  } catch (err) {
    next(err);
  }
});

app.get("/api/posts", auth, async (req, res, next) => {
  try {
    const status = String(req.query.status || "");
    const rows = await q(
      `SELECT * FROM posts WHERE company_id = $1 AND ($2 = '' OR status = $2) ORDER BY id DESC LIMIT 100`,
      [companyIdOf(req), status]
    );
    res.json({ posts: rows });
  } catch (err) {
    next(err);
  }
});

app.get("/api/analytics", auth, async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
    const rows = await q(
      `SELECT date_trunc('day', created_at) AS day, count(*)::int AS posts, coalesce(sum(click_count),0)::int AS clicks
       FROM posts WHERE company_id = $1 AND status = 'sent' AND created_at >= now() - ($2 || ' days')::interval
       GROUP BY 1 ORDER BY 1`,
      [companyId, String(days)]
    );
    res.json({ rows });
  } catch (err) {
    next(err);
  }
});

app.post("/api/deals/run", auth, async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    await planOf(companyId);
    // As sessões do WhatsApp vivem só no worker. Rodar aqui na API não publicava no WhatsApp e ainda gravava
    // "Ative um grupo na conexão..." como erro. Agora o pedido vai para o worker, que roda a rodada com a mesma trava.
    const reply = await askWorker({ op: "run-deals", companyId }, 10);
    if (!reply.ok) return res.status(502).json({ error: reply.error });
    res.json({ sent: 0, queued: true });
  } catch (err) {
    next(err);
  }
});

app.get("/api/connections", auth, async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    const sessions = await q(
      `SELECT id, name, status, phone, qr, enabled, stores, selected, last_error, created_at, connected_at, qr_at,
              send_cadence, interval_seconds, posts_per_cycle, status_enabled, status_per_day, status_gap_minutes, status_cadence, status_per_cycle, status_stores,
              (SELECT count(*)::int FROM groups g WHERE g.whatsapp_id = whatsapp_sessions.id AND g.enabled = true) AS active_groups,
              (SELECT count(*)::int FROM posts p WHERE p.whatsapp_id = whatsapp_sessions.id AND p.group_jid = 'status@broadcast' AND p.status = 'sent'
                 AND p.created_at >= (date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')) AS status_today,
              (SELECT max(p.created_at) FROM posts p WHERE p.whatsapp_id = whatsapp_sessions.id AND p.group_jid = 'status@broadcast' AND p.status = 'sent') AS status_last_at,
              (SELECT count(*)::int FROM wa_address_book b WHERE b.whatsapp_id = whatsapp_sessions.id) AS address_book
       FROM whatsapp_sessions WHERE company_id = $1 ORDER BY id`,
      [companyId]
    );
    const bots = await q<{ id: number; name: string; enabled: boolean; stores: string[]; chats: unknown; token_enc: string }>(
      "SELECT id, name, enabled, stores, chats, token_enc FROM telegram_bots WHERE company_id = $1 ORDER BY id",
      [companyId]
    );
    res.json({
      sessions,
      bots: bots.map(bot => ({ ...bot, token_enc: undefined, hasToken: Boolean(decrypt(bot.token_enc)) }))
    });
  } catch (err) {
    next(err);
  }
});

app.post("/api/connections", auth, async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    await assertRoom(companyId, "connections");
    const name = String(req.body?.name || "WhatsApp").trim();
    const row = await one(
      "INSERT INTO whatsapp_sessions (company_id, name, selected) VALUES ($1,$2, NOT EXISTS (SELECT 1 FROM whatsapp_sessions WHERE company_id = $1)) RETURNING *",
      [companyId, name]
    );
    res.status(201).json({ session: row });
  } catch (err) {
    next(err);
  }
});

app.post("/api/connections/:id/select", auth, async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    const id = Number(req.params.id);
    await q("UPDATE whatsapp_sessions SET selected = false WHERE company_id = $1", [companyId]);
    await q("UPDATE whatsapp_sessions SET selected = true WHERE id = $1 AND company_id = $2", [id, companyId]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.patch("/api/connections/:id", auth, async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    const stores = Array.isArray(req.body?.stores) ? req.body.stores.map(String) : undefined;
    const cadence = req.body?.sendCadence && typeof req.body.sendCadence === "object" ? JSON.stringify(req.body.sendCadence) : null;
    const interval = req.body?.intervalSeconds == null ? null : Math.min(180, Math.max(5, Number(req.body.intervalSeconds) || 20));
    const posts = req.body?.postsPerCycle == null ? null : Math.min(5, Math.max(1, Math.round(Number(req.body.postsPerCycle) || 1)));
    const statusOn = typeof req.body?.statusEnabled === "boolean" ? req.body.statusEnabled : null;
    const statusPace = clampStatusPace({ perDay: req.body?.statusPerDay, gapMinutes: req.body?.statusGapMinutes });
    // Status com os mesmos controles dos grupos: lojas, intervalo por loja (mín. 15 s) e ofertas por vez.
    const statusStores = Array.isArray(req.body?.statusStores) ? JSON.stringify(req.body.statusStores.map(String).slice(0, 30)) : null;
    let statusCadence: string | null = null;
    if (req.body?.statusCadence && typeof req.body.statusCadence === "object") {
      const clean: Record<string, number> = {};
      for (const [store, value] of Object.entries(req.body.statusCadence as Record<string, unknown>).slice(0, 30)) {
        const seconds = Math.round(Number(value));
        if (Number.isFinite(seconds)) clean[String(store)] = Math.min(86400, Math.max(15, seconds));
      }
      statusCadence = JSON.stringify(clean);
    }
    const statusPer = req.body?.statusPerCycle == null ? null : Math.min(5, Math.max(1, Math.round(Number(req.body.statusPerCycle) || 1)));
    await q(
      `UPDATE whatsapp_sessions SET
         enabled = COALESCE($3, enabled),
         stores = COALESCE($4::jsonb, stores),
         name = COALESCE($5, name),
         send_cadence = COALESCE($6::jsonb, send_cadence),
         interval_seconds = COALESCE($7, interval_seconds),
         posts_per_cycle = COALESCE($8, posts_per_cycle),
         status_enabled = COALESCE($9, status_enabled),
         status_per_day = COALESCE($10, status_per_day),
         status_gap_minutes = COALESCE($11, status_gap_minutes),
         status_stores = COALESCE($12::jsonb, status_stores),
         status_cadence = COALESCE($13::jsonb, status_cadence),
         status_per_cycle = COALESCE($14, status_per_cycle)
       WHERE id = $1 AND company_id = $2`,
      [
        Number(req.params.id),
        companyId,
        req.body?.enabled ?? null,
        stores ? JSON.stringify(stores) : null,
        req.body?.name ?? null,
        cadence,
        interval,
        posts,
        statusOn,
        req.body?.statusPerDay == null ? null : statusPace.perDay,
        req.body?.statusGapMinutes == null ? null : statusPace.gapMinutes,
        statusStores,
        statusCadence,
        statusPer
      ]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.post("/api/connections/:id/address-book", auth, async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    const id = Number(req.params.id);
    const own = await one("SELECT id FROM whatsapp_sessions WHERE id = $1 AND company_id = $2", [id, companyId]);
    if (!own) return res.status(404).json({ error: "Conexão não encontrada" });
    const reply = await askWorker({ op: "import-address-book", sessionId: id }, 30);
    if (!reply.ok) return res.status(400).json({ error: reply.error || "Não foi possível importar a agenda" });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.post("/api/connections/:id/status-test", auth, async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    const id = Number(req.params.id);
    const own = await one("SELECT id FROM whatsapp_sessions WHERE id = $1 AND company_id = $2", [id, companyId]);
    if (!own) return res.status(404).json({ error: "Conexão não encontrada" });
    const reply = await askWorker({ op: "status-test", companyId, sessionId: id, phone: String(req.body?.phone || "") }, 60);
    if (!reply.ok) return res.status(400).json({ error: reply.error || "Não foi possível enviar o teste" });
    res.json(reply);
  } catch (err) {
    next(err);
  }
});

app.post("/api/connections/:id/start", auth, async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    const row = await one<{ id: number; company_id: number; name: string }>(
      "SELECT id, company_id, name FROM whatsapp_sessions WHERE id = $1 AND company_id = $2",
      [Number(req.params.id), companyId]
    );
    if (!row) return res.status(404).json({ error: "Conexão não encontrada" });
    await q(
      "UPDATE whatsapp_sessions SET status = 'opening', qr = '', qr_at = NULL, last_error = NULL WHERE id = $1 AND company_id = $2",
      [row.id, companyId]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.delete("/api/connections/:id", auth, async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    const id = Number(req.params.id);
    const row = await one("SELECT id FROM whatsapp_sessions WHERE id = $1 AND company_id = $2", [id, companyId]);
    if (!row) return res.status(404).json({ error: "Conexão não encontrada" });
    await q("DELETE FROM whatsapp_sessions WHERE id = $1 AND company_id = $2", [id, companyId]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.post("/api/connections/:id/stop", auth, async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    const id = Number(req.params.id);
    const row = await one("SELECT id FROM whatsapp_sessions WHERE id = $1 AND company_id = $2", [id, companyId]);
    if (!row) return res.status(404).json({ error: "Conexão não encontrada" });
    await stopSession(id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.get("/api/connections/:id/groups", auth, async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    const id = Number(req.params.id);
    const session = await one<{ id: number; status: string; name: string }>(
      "SELECT id, status, name FROM whatsapp_sessions WHERE id = $1 AND company_id = $2",
      [id, companyId]
    );
    if (!session) return res.status(404).json({ error: "Conexão não encontrada" });
    const saved = await q<{ id: number; group_jid: string; name: string; categories: string; enabled: boolean; member_count: number; whatsapp_id: number | null }>(
      "SELECT id, group_jid, name, categories, enabled, member_count, whatsapp_id FROM groups WHERE company_id = $1 AND (whatsapp_id = $2 OR whatsapp_id IS NULL) ORDER BY name",
      [companyId, id]
    );
    const savedByJid = new Map(saved.map(row => [row.group_jid, row]));
    let message = "";
    const live = new Map<string, { name: string; members: number; admin: boolean; admins: number }>();
    if (session.status === "connected") {
      const reply = await askWorker({ op: "groups", sessionId: id }, 45);
      if (reply.ok && "groups" in reply) {
        for (const group of reply.groups) {
          if (!group.jid?.endsWith("@g.us")) continue;
          live.set(group.jid, { name: group.name || group.jid, members: Number(group.members) || 0, admin: Boolean(group.admin), admins: Number(group.admins) || 0 });
          const known = savedByJid.get(group.jid);
          if (known) {
            await q("UPDATE groups SET member_count = $3, name = $4 WHERE id = $1 AND company_id = $2", [known.id, companyId, Number(group.members) || 0, group.name || known.name]);
          }
        }
        if (!live.size && !saved.length) message = "Este número não participa de nenhum grupo no WhatsApp.";
      } else {
        message = reply.ok ? "A lista ao vivo não respondeu." : reply.error;
      }
    } else if (!saved.length) {
      message = "Gere o QR, leia no WhatsApp e volte nesta aba.";
    } else {
      message = "A conexão está desconectada. Os grupos já salvos continuam na lista.";
    }
    const jids = new Set<string>([...live.keys(), ...saved.map(row => row.group_jid)]);
    const groups = [...jids].map(jid => {
      const row = savedByJid.get(jid);
      const fresh = live.get(jid);
      return {
        id: row?.id || null,
        group_jid: jid,
        name: fresh?.name || row?.name || jid,
        member_count: fresh?.members || row?.member_count || 0,
        admin: Boolean(fresh?.admin),
        admins: Number(fresh?.admins) || 0,
        enabled: Boolean(row?.enabled),
        categories: row?.categories || ""
      };
    }).sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
    res.json({ groups, message });
  } catch (err) {
    next(err);
  }
});

app.post("/api/groups", auth, async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    const jid = String(req.body?.groupJid || "").trim();
    if (!jid.endsWith("@g.us")) return res.status(400).json({ error: "Grupo inválido" });
    const whatsappId = Number(req.body?.whatsappId) || null;
    if (whatsappId && !(await one("SELECT id FROM whatsapp_sessions WHERE id = $1 AND company_id = $2", [whatsappId, companyId]))) {
      return res.status(404).json({ error: "Conexão não encontrada" });
    }
    const exists = await one(
      "SELECT id FROM groups WHERE company_id = $1 AND group_jid = $2 AND whatsapp_id IS NOT DISTINCT FROM $3",
      [companyId, jid, whatsappId]
    );
    if (!exists) await assertRoom(companyId, "groups");
    const row = await one(
      `INSERT INTO groups (company_id, whatsapp_id, group_jid, name, categories, enabled)
       VALUES ($1,$2,$3,$4,$5,true)
       ON CONFLICT (company_id, whatsapp_id, group_jid) DO UPDATE SET name = EXCLUDED.name, categories = EXCLUDED.categories, enabled = true
       RETURNING *`,
      [companyId, whatsappId, jid, String(req.body?.name || jid), String(req.body?.categories || "")]
    );
    res.status(201).json({ group: row });
  } catch (err) {
    next(err);
  }
});

app.patch("/api/groups/:id", auth, async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    if (req.body?.enabled === true) {
      const current = await one<{ enabled: boolean }>("SELECT enabled FROM groups WHERE id = $1 AND company_id = $2", [Number(req.params.id), companyId]);
      if (current && !current.enabled) await assertRoom(companyId, "groups");
    }
    const row = await one(
      `UPDATE groups SET
         enabled = COALESCE($3, enabled),
         name = COALESCE($4, name),
         categories = COALESCE($5, categories)
       WHERE id = $1 AND company_id = $2
       RETURNING *`,
      [Number(req.params.id), companyId, req.body?.enabled ?? null, req.body?.name ?? null, req.body?.categories ?? null]
    );
    if (!row) return res.status(404).json({ error: "Grupo não encontrado" });
    res.json({ group: row });
  } catch (err) {
    next(err);
  }
});

app.delete("/api/groups/:id", auth, async (req, res, next) => {
  try {
    await q("DELETE FROM groups WHERE id = $1 AND company_id = $2", [Number(req.params.id), companyIdOf(req)]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.post("/api/telegram", auth, async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    const token = String(req.body?.token || "").trim();
    const row = await one(
      "INSERT INTO telegram_bots (company_id, name, token_enc, stores, chats) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb) RETURNING id, name, enabled, stores, chats",
      [companyId, String(req.body?.name || "Bot"), token ? encrypt(token) : "", JSON.stringify(req.body?.stores || []), JSON.stringify(req.body?.chats || [])]
    );
    res.status(201).json({ bot: row });
  } catch (err) {
    next(err);
  }
});

app.patch("/api/telegram/:id", auth, async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    const token = req.body?.token != null ? String(req.body.token).trim() : null;
    await q(
      `UPDATE telegram_bots SET
         name = COALESCE($3, name),
         enabled = COALESCE($4, enabled),
         stores = COALESCE($5::jsonb, stores),
         chats = COALESCE($6::jsonb, chats),
         token_enc = CASE WHEN $7::text IS NULL THEN token_enc ELSE $7 END
       WHERE id = $1 AND company_id = $2`,
      [
        Number(req.params.id),
        companyId,
        req.body?.name ?? null,
        req.body?.enabled ?? null,
        Array.isArray(req.body?.stores) ? JSON.stringify(req.body.stores) : null,
        Array.isArray(req.body?.chats) ? JSON.stringify(req.body.chats) : null,
        token ? encrypt(token) : null
      ]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.delete("/api/telegram/:id", auth, async (req, res, next) => {
  try {
    await q("DELETE FROM telegram_bots WHERE id = $1 AND company_id = $2", [Number(req.params.id), companyIdOf(req)]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.get("/api/contacts", auth, async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    const search = String(req.query.search || "").trim();
    const tag = String(req.query.tag || "");
    const rows = await q(
      `SELECT id, phone, name, names, tags, source, blocked, anonymized_at, created_at FROM contacts
       WHERE company_id = $1 AND anonymized_at IS NULL
       AND ($2 = '' OR phone ILIKE '%' || $2 || '%' OR name ILIKE '%' || $2 || '%')
       AND ($3 = '' OR tags::text ILIKE '%' || $3 || '%')
       ORDER BY updated_at DESC LIMIT 400`,
      [companyId, search.replace(/\D/g, "") || search, tag]
    );
    res.json({ contacts: rows, tags: ["Cliente", "Afiliado", "Grupo Achadinhos", "Mercado Livre", "Shopee", "Amazon", "Importado", "Manual"] });
  } catch (err) {
    next(err);
  }
});

app.post("/api/contacts/manual", auth, async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    const phone = normalizeAudiencePhone(req.body?.phone);
    if (!phone) return res.status(400).json({ error: "Número inválido" });
    const result = await saveContacts(companyId, [{ phone, name: req.body?.name, tags: req.body?.tags || ["Manual"], source: "manual" }]);
    await audit(companyId, (req as Request & { auth: AuthUser }).auth.id, "import", "Contato manual");
    res.json(result);
  } catch (err) {
    next(err);
  }
});

app.post("/api/contacts/import", auth, upload.single("file"), async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    const file = req.file;
    if (!file) return res.status(400).json({ error: "Envie um arquivo" });
    let table: string[][] = [];
    const name = file.originalname.toLowerCase();
    if (name.endsWith(".txt") || file.mimetype.startsWith("text/")) {
      table = file.buffer.toString("utf8").split(/\r?\n/).map(line => line.split(/[,;\t]/).map(cell => cell.trim())).filter(row => row.some(Boolean));
    } else {
      const book = XLSX.read(file.buffer, { type: "buffer" });
      const sheet = book.Sheets[book.SheetNames[0]];
      table = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false }) as string[][];
    }
    const result = await saveContacts(companyId, audienceRowsFromTable(table).map(row => ({ ...row, tags: ["Importado"] })));
    await audit(companyId, (req as Request & { auth: AuthUser }).auth.id, "import", `Arquivo ${file.originalname}`);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

app.post("/api/contacts/extract", auth, async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    const whatsappId = Number(req.body?.whatsappId);
    const groupJids = (Array.isArray(req.body?.groupJids) ? req.body.groupJids.map(String) : [])
      .filter((jid: string) => jid.endsWith("@g.us"))
      .slice(0, 8);
    if (!groupJids.length) return res.status(400).json({ error: "Selecione ao menos um grupo" });
    const session = await one<{ status: string }>("SELECT status FROM whatsapp_sessions WHERE id = $1 AND company_id = $2", [whatsappId, companyId]);
    if (!session || session.status !== "connected") return res.status(400).json({ error: "WhatsApp desconectado" });
    const reply = await askWorker({ op: "extract", sessionId: whatsappId, groupJids }, 40);
    if (!reply.ok || !("rows" in reply)) return res.status(502).json({ error: reply.ok ? "A sessão não leu os participantes." : reply.error });
    const rows = reply.rows.map(row => ({ phone: row.phone, lid: row.lid, name: row.name || "", tags: ["Grupo"], source: "grupo" }));
    const result = await saveContacts(companyId, rows);
    await audit(companyId, (req as Request & { auth: AuthUser }).auth.id, "extract", `${groupJids.length} grupo(s)`);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

app.post("/api/contacts/:id/block", auth, async (req, res, next) => {
  try {
    await q("UPDATE contacts SET blocked = $3, updated_at = now() WHERE id = $1 AND company_id = $2", [Number(req.params.id), companyIdOf(req), Boolean(req.body?.blocked)]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.post("/api/contacts/:id/anonymize", auth, async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    const id = Number(req.params.id);
    await q(
      "UPDATE contacts SET phone = $3, name = '', names = '[]'::jsonb, anonymized_at = now() WHERE id = $1 AND company_id = $2",
      [id, companyId, `anon-${id}`]
    );
    await audit(companyId, (req as Request & { auth: AuthUser }).auth.id, "anonymize", `Contato ${id}`);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.delete("/api/contacts/:id", auth, async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    await q("DELETE FROM contacts WHERE id = $1 AND company_id = $2", [Number(req.params.id), companyId]);
    await audit(companyId, (req as Request & { auth: AuthUser }).auth.id, "delete", "Contato excluído");
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.get("/api/contacts/export", auth, async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    const rows = await q<{ name: string; phone: string; tags: string[] }>(
      "SELECT name, phone, tags FROM contacts WHERE company_id = $1 AND anonymized_at IS NULL ORDER BY id",
      [companyId]
    );
    const format = String(req.query.format || "csv");
    await audit(companyId, (req as Request & { auth: AuthUser }).auth.id, "export", format);
    if (format === "xlsx") {
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows), "Contatos");
      const body = XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", "attachment; filename=contatos-achadinhos.xlsx");
      return res.send(body);
    }
    if (format === "vcf") {
      const line = (value: string) => String(value || "").replace(/[\r\n]+/g, " ");
      const body = rows.map(row => `BEGIN:VCARD\nVERSION:3.0\nFN:${line(row.name)}\nTEL:${line(row.phone)}\nEND:VCARD`).join("\n");
      res.setHeader("Content-Type", "text/vcard");
      return res.send(body);
    }
    // Nomes vêm de participantes de grupo (texto de terceiros). Sem escape, "=HYPERLINK(...)" vira fórmula no Excel.
    const lines = ["nome,telefone,tags", ...rows.map(row => [row.name, row.phone, (row.tags || []).join(" ")].map(value => csvCell(String(value ?? ""))).join(","))];
    res.setHeader("Content-Type", "text/plain");
    res.send(format === "txt" ? rows.map(row => row.phone).join("\n") : lines.join("\n"));
  } catch (err) {
    next(err);
  }
});

/** Célula CSV entre aspas e sem início de fórmula (=, +, -, @, tab, CR). */
const csvCell = (value: string) => {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
};

const audienceCounts = `
  (SELECT count(*)::int FROM audience_items i WHERE i.job_id = j.id) AS total,
  (SELECT count(*)::int FROM audience_items i WHERE i.job_id = j.id AND i.status = 'pending') AS pending,
  (SELECT count(*)::int FROM audience_items i WHERE i.job_id = j.id AND i.status <> 'pending') AS processed,
  (SELECT count(*)::int FROM audience_items i WHERE i.job_id = j.id AND i.status = 'added' AND i.reason = 'convite enviado') AS invites,
  (SELECT count(*)::int FROM audience_items i WHERE i.job_id = j.id AND i.status = 'added' AND coalesce(i.reason, '') <> 'convite enviado') AS added,
  (SELECT count(*)::int FROM audience_items i WHERE i.job_id = j.id AND i.status = 'failed') AS failed,
  (SELECT count(*)::int FROM audience_items i WHERE i.job_id = j.id AND i.status = 'skipped' AND i.reason = 'já está no grupo') AS already
`;

const audienceEvents = async (companyId: number, jobId: number) => q(
  `SELECT i.id, i.job_id, i.status, i.reason, i.processed_at, i.phone,
          coalesce(nullif(c.name, ''), 'Sem nome') AS name
   FROM audience_items i
   LEFT JOIN contacts c ON c.id = i.contact_id AND c.company_id = i.company_id
   WHERE i.company_id = $1 AND i.job_id = $2 AND i.status <> 'pending'
   ORDER BY i.processed_at DESC NULLS LAST, i.id DESC
   LIMIT 50`,
  [companyId, jobId]
);

app.get("/api/audience/jobs", auth, async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    const jobs = await q(
      `SELECT j.*, ${audienceCounts}
       FROM audience_jobs j WHERE j.company_id = $1 ORDER BY j.id DESC LIMIT 20`,
      [companyId]
    );
    const focus = (jobs as Array<{ id: number; status: string }>).find(job => job.status === "running" || job.status === "paused") || (jobs as Array<{ id: number }>)[0] || null;
    const events = focus ? await audienceEvents(companyId, focus.id) : [];
    const growth = await q<{ group_jid: string; added: number }>(
      `SELECT j.group_jid, count(*)::int AS added
       FROM audience_items i
       JOIN audience_jobs j ON j.id = i.job_id
       WHERE j.company_id = $1 AND i.status = 'added' AND coalesce(i.reason, '') <> 'convite enviado' AND i.processed_at >= $2
       GROUP BY j.group_jid`,
      [companyId, brasiliaDayStart(new Date())]
    );
    res.json({ jobs, events, focusId: focus?.id || null, growth, limits: AUDIENCE_LIMITS });
  } catch (err) {
    next(err);
  }
});

app.post("/api/audience/queue", auth, async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    const whatsappId = Number(req.body?.whatsappId);
    const groupJid = String(req.body?.groupJid || "");
    const mode = req.body?.mode === "message" ? "message" : "add";
    if (!groupJid.endsWith("@g.us")) return res.status(400).json({ error: "Grupo inválido" });
    const session = await one<{ status: string; phone: string }>("SELECT status, phone FROM whatsapp_sessions WHERE id = $1 AND company_id = $2", [whatsappId, companyId]);
    if (!session || session.status !== "connected") return res.status(400).json({ error: "WhatsApp desconectado" });
    const meta = await askWorker({ op: "group-meta", sessionId: whatsappId, groupJid }, 40);
    if (!meta.ok || !("admin" in meta)) return res.status(502).json({ error: meta.ok ? "Não foi possível ler o grupo." : meta.error });
    if (!meta.admin) return res.status(400).json({ error: "Para incluir pessoas, esta conexão precisa ser administradora do grupo." });
    const sourceJid = String(req.body?.sourceGroupJid || "");
    const sourceWhatsappId = Number(req.body?.sourceWhatsappId || 0);
    let sourcePhones: string[] | null = null;
    if (sourceJid) {
      if (!sourceJid.endsWith("@g.us") || !sourceWhatsappId) return res.status(400).json({ error: "Grupo de origem inválido" });
      if (sourceJid === groupJid) return res.status(400).json({ error: "O grupo de origem precisa ser diferente do grupo das ofertas." });
      const sourceSession = await one<{ status: string }>("SELECT status FROM whatsapp_sessions WHERE id = $1 AND company_id = $2", [sourceWhatsappId, companyId]);
      if (!sourceSession || sourceSession.status !== "connected") return res.status(400).json({ error: "A conexão do grupo de origem está desconectada." });
      const extracted = await askWorker({ op: "extract", sessionId: sourceWhatsappId, groupJids: [sourceJid] }, 40);
      if (!extracted.ok || !("rows" in extracted)) return res.status(502).json({ error: extracted.ok ? "Não foi possível ler os contatos desse grupo." : extracted.error });
      const saved = await saveContacts(companyId, extracted.rows.map(row => ({ phone: row.phone, lid: row.lid, name: row.name || "", tags: ["Grupo"], source: "grupo" })));
      const mine = String(session.phone || "").replace(/\D/g, "");
      sourcePhones = saved.unique.map(row => row.phone).filter(phone => phone.replace(/\D/g, "") !== mine);
      if (!sourcePhones.length) return res.status(400).json({ error: "Esse grupo não tem números com telefone para incluir." });
    }
    const pace = clampJobPace({
      intervalSeconds: req.body?.intervalSeconds,
      perHour: req.body?.perHour,
      perDay: req.body?.perDay,
      batchSize: req.body?.batchSize
    });
    const job = await one<{ id: number }>(
      `INSERT INTO audience_jobs (company_id, user_id, whatsapp_id, group_jid, group_name, mode, interval_seconds, per_hour, per_day, per_week, batch_size, source_group_jid, source_group_name, source_members, source_admins)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [
        companyId,
        (req as Request & { auth: AuthUser }).auth.id,
        whatsappId,
        groupJid,
        meta.subject || "",
        mode,
        pace.intervalSeconds,
        pace.perHour,
        pace.perDay,
        Number(req.body?.perWeek) || 400,
        pace.batchSize,
        sourceJid,
        String(req.body?.sourceName || "").slice(0, 120),
        Math.max(0, Number(req.body?.sourceMembers) || 0),
        Math.max(0, Number(req.body?.sourceAdmins) || 0)
      ]
    );
    const queued = await q<{ id: number }>(
      `INSERT INTO audience_items (company_id, job_id, contact_id, phone, group_jid, mode)
       SELECT company_id, $2, id, phone, $3, $4 FROM contacts
       WHERE company_id = $1 AND blocked = false AND anonymized_at IS NULL AND phone <> $5
         AND ($6::text[] IS NULL OR phone = ANY($6::text[]))
       LIMIT 5000 RETURNING id`,
      [companyId, job!.id, groupJid, mode, session.phone || "", sourcePhones]
    );
    if (!queued.length) {
      await q("DELETE FROM audience_jobs WHERE id = $1 AND company_id = $2", [job!.id, companyId]);
      return res.status(400).json({ error: sourcePhones ? "Esse grupo não tem números para incluir." : "A Base não tem números para incluir. Extraia os contatos antes." });
    }
    await audit(companyId, (req as Request & { auth: AuthUser }).auth.id, "queue", `Fila ${job!.id} com ${queued.length} contatos`);
    res.status(201).json({ jobId: job!.id, queued: queued.length, pace });
  } catch (err) {
    next(err);
  }
});

app.get("/api/audience/jobs/:id/export", auth, async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    const id = Number(req.params.id);
    const job = await one("SELECT id FROM audience_jobs WHERE id = $1 AND company_id = $2", [id, companyId]);
    if (!job) return res.status(404).json({ error: "Fila não encontrada" });
    const rows = await q<{ name: string; phone: string; status: string; reason: string | null; processed_at: string | null }>(
      `SELECT coalesce(nullif(c.name, ''), 'Sem nome') AS name, i.phone, i.status, i.reason, i.processed_at
       FROM audience_items i
       LEFT JOIN contacts c ON c.id = i.contact_id AND c.company_id = i.company_id
       WHERE i.company_id = $1 AND i.job_id = $2
       ORDER BY i.id ASC`,
      [companyId, id]
    );
    const cell = csvCell;
    const resultOf = (status: string, reason: string) => status === "pending" ? "Na fila" : status === "added" && reason === "convite enviado" ? "Convite" : status === "added" ? "Adicionado" : reason === "já está no grupo" ? "Já estava" : status === "failed" ? "Falhou" : reason || status;
    const lines = ["nome,telefone,resultado,motivo,horario", ...rows.map(row => [row.name, row.phone, resultOf(row.status, row.reason || ""), row.reason || "", row.processed_at ? new Date(row.processed_at).toISOString() : ""].map(value => cell(String(value))).join(","))];
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=fila-${id}.csv`);
    res.send(`\uFEFF${lines.join("\n")}`);
  } catch (err) {
    next(err);
  }
});

app.post("/api/audience/jobs/:id/pause", auth, async (req, res, next) => {
  try {
    await q("UPDATE audience_jobs SET status = 'paused' WHERE id = $1 AND company_id = $2 AND status = 'running'", [Number(req.params.id), companyIdOf(req)]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.post("/api/audience/jobs/:id/resume", auth, async (req, res, next) => {
  try {
    await q("UPDATE audience_jobs SET status = 'running', last_error = NULL WHERE id = $1 AND company_id = $2 AND status = 'paused'", [Number(req.params.id), companyIdOf(req)]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.post("/api/audience/jobs/:id/stop", auth, async (req, res, next) => {
  try {
    await q("UPDATE audience_jobs SET status = 'canceled' WHERE id = $1 AND company_id = $2 AND status IN ('running', 'paused')", [Number(req.params.id), companyIdOf(req)]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

const CYCLE_DAYS: Record<string, number> = { monthly: 30, quarterly: 90, semiannual: 180, yearly: 365 };
const PIX_MINUTES = 30;

type CheckoutSub = { plan_id: number; slug: string; monthly_cents: number; quarterly_cents: number | null; semiannual_cents: number | null; yearly_cents: number; name: string; plan_name: string; tax_id: string };

const loadCheckoutSub = (companyId: number) => one<CheckoutSub>(
  `SELECT s.plan_id, p.slug, p.monthly_cents, p.quarterly_cents, p.semiannual_cents, p.yearly_cents, c.name, p.name AS plan_name, c.tax_id
   FROM subscriptions s JOIN plans p ON p.id = s.plan_id JOIN companies c ON c.id = s.company_id WHERE s.company_id = $1`,
  [companyId]
);

const cyclePrice = (sub: CheckoutSub, cycle: string) =>
  ({ monthly: sub.monthly_cents, quarterly: sub.quarterly_cents, semiannual: sub.semiannual_cents, yearly: sub.yearly_cents } as Record<string, number | null>)[cycle] ?? null;

/** Valida o cupom e devolve o valor com desconto. Não reserva o uso (isso só acontece quando a cobrança é criada). */
const priceWithCoupon = async (sub: CheckoutSub, amount: number, rawCode: unknown) => {
  const code = String(rawCode || "").trim().toUpperCase();
  if (!code) return { amount, couponId: null as number | null };
  const coupon = await one<{ id: number; kind: string; percent: number | null; amount_cents: number | null; plan_slug: string; max_uses: number | null; used_count: number }>(
    "SELECT id, kind, percent, amount_cents, plan_slug, max_uses, used_count FROM coupons WHERE upper(code) = $1 AND active = true AND (expires_at IS NULL OR expires_at > now())",
    [code]
  );
  if (!coupon) throw Object.assign(new Error("Cupom inválido ou vencido"), { status: 400 });
  if (coupon.plan_slug && coupon.plan_slug !== sub.slug) throw Object.assign(new Error("Este cupom não vale para o plano atual"), { status: 400 });
  if (coupon.max_uses != null && coupon.used_count >= coupon.max_uses) throw Object.assign(new Error("Este cupom esgotou"), { status: 400 });
  const discounted = coupon.kind === "amount"
    ? Math.max(0, amount - Number(coupon.amount_cents || 0))
    : Math.max(0, Math.round(amount * (100 - Number(coupon.percent || 0)) / 100));
  return { amount: discounted, couponId: coupon.id };
};

// Reserva o uso numa única instrução: duas compras simultâneas não passam do limite do cupom.
const reserveCoupon = async (couponId: number | null) => {
  if (!couponId) return;
  const reserved = await one("UPDATE coupons SET used_count = used_count + 1 WHERE id = $1 AND (max_uses IS NULL OR used_count < max_uses) RETURNING id", [couponId]);
  if (!reserved) throw Object.assign(new Error("Este cupom esgotou"), { status: 400 });
};

const publicOrigin = (req: Request, saved: string) => {
  if (/^https:\/\//i.test(saved)) return saved;
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  return proto === "https" && host && !host.includes(":") ? `https://${host}` : "";
};

/** O que a tela do cliente precisa de uma cobrança. */
const invoiceView = (row: { id: number; amount_cents: number; cycle: string; status: string; provider: string; payload: unknown; expires_at: string | null; paid_at: string | null; created_at?: string }) => {
  const payload = (row.payload || {}) as { qrText?: string; qrImage?: string; qrcode?: string };
  return {
    id: row.id,
    amountCents: row.amount_cents,
    cycle: row.cycle,
    status: row.status,
    provider: row.provider,
    qrText: payload.qrText || payload.qrcode || "",
    qrImage: payload.qrImage || "",
    expiresAt: row.expires_at,
    paidAt: row.paid_at,
    createdAt: row.created_at || null
  };
};

const INVOICE_COLUMNS = "id, company_id, amount_cents, cycle, status, provider, payload, external_id, expires_at, paid_at, checked_at, created_at";

/** Consulta a cobrança no PagBank e, se paga com o valor certo, libera a assinatura. */
const refreshPagbankInvoice = async (inv: { id: number; company_id: number; external_id: string | null; amount_cents: number; status: string; expires_at: string | null }) => {
  if (inv.status !== "pending" || !inv.external_id) return inv.status;
  const order = await getPagbankOrder(inv.external_id);
  await q("UPDATE invoices SET checked_at = now() WHERE id = $1", [inv.id]);
  if (order.paid) {
    if (order.paidCents && order.paidCents !== Number(inv.amount_cents)) {
      await q("INSERT INTO payment_events (company_id, invoice_id, kind, payload) VALUES ($1,$2,'amount_mismatch',$3::jsonb)", [inv.company_id, inv.id, JSON.stringify({ provider: "pagbank", order: inv.external_id, paidCents: order.paidCents })]);
      await audit(inv.company_id, null, "payment", `PagBank: valor pago ${order.paidCents} diferente da fatura ${inv.id}`);
      return "mismatch";
    }
    await settleInvoice(inv.id, { provider: "pagbank", order: inv.external_id, paidCents: order.paidCents });
    return "paid";
  }
  if (inv.expires_at && new Date(inv.expires_at).getTime() < Date.now() - 60_000) {
    await q("UPDATE invoices SET status = 'expired' WHERE id = $1 AND status = 'pending'", [inv.id]);
    return "expired";
  }
  return "pending";
};

app.get("/api/billing", auth, async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    const pag = await loadPagbank();
    const provider = pag.active && pag.token ? "pagbank" : (await efiConfigured()) ? "efi" : null;
    const sub = await one<{ status: string; cycle: string | null; trial_ends_at: string | null; current_period_end: string | null; company_status: string; tax_id: string; plan_name: string; monthly_cents: number; quarterly_cents: number | null; semiannual_cents: number | null; yearly_cents: number }>(
      `SELECT s.status, s.cycle, s.trial_ends_at, s.current_period_end, c.status AS company_status, c.tax_id, p.name AS plan_name,
              p.monthly_cents, p.quarterly_cents, p.semiannual_cents, p.yearly_cents
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id JOIN companies c ON c.id = s.company_id WHERE s.company_id = $1`,
      [companyId]
    );
    if (!sub) return res.status(404).json({ error: "Sem assinatura" });
    const open = await one<Parameters<typeof invoiceView>[0]>(
      `SELECT ${INVOICE_COLUMNS} FROM invoices WHERE company_id = $1 AND status = 'pending' AND provider = 'pagbank' AND expires_at > now() ORDER BY id DESC LIMIT 1`,
      [companyId]
    );
    const history = await q<Parameters<typeof invoiceView>[0]>(
      `SELECT ${INVOICE_COLUMNS} FROM invoices WHERE company_id = $1 AND status = 'paid' ORDER BY paid_at DESC LIMIT 12`,
      [companyId]
    );
    const digits = String(sub.tax_id || "");
    res.json({
      provider,
      plan: {
        name: sub.plan_name,
        prices: { monthly: sub.monthly_cents, quarterly: sub.quarterly_cents, semiannual: sub.semiannual_cents, yearly: sub.yearly_cents }
      },
      subscription: { status: sub.status, cycle: sub.cycle, trialEndsAt: sub.trial_ends_at, currentPeriodEnd: sub.current_period_end, companyStatus: sub.company_status },
      taxIdHint: digits ? `${"•".repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}` : "",
      open: open ? invoiceView(open) : null,
      history: history.map(invoiceView)
    });
  } catch (err) {
    next(err);
  }
});

app.get("/api/billing/invoices/:id", auth, async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    let inv = await one<Parameters<typeof invoiceView>[0] & { company_id: number; external_id: string | null; checked_at: string | null }>(
      `SELECT ${INVOICE_COLUMNS} FROM invoices WHERE id = $1 AND company_id = $2`,
      [Number(req.params.id), companyId]
    );
    if (!inv) return res.status(404).json({ error: "Cobrança não encontrada" });
    // A tela pergunta a cada poucos segundos; o PagBank só é consultado de 8 em 8 s (ou na hora, no "Já paguei").
    const force = req.query.check === "1";
    const stale = !inv.checked_at || Date.now() - new Date(inv.checked_at).getTime() > 8000;
    if (inv.provider === "pagbank" && inv.status === "pending" && (force || stale)) {
      try {
        await refreshPagbankInvoice(inv);
      } catch (err) {
        if (force) return res.status(502).json({ error: pagbankError(err) });
      }
      inv = (await one<typeof inv>(`SELECT ${INVOICE_COLUMNS} FROM invoices WHERE id = $1`, [inv.id]))!;
    }
    const sub = await one<{ current_period_end: string | null }>("SELECT current_period_end FROM subscriptions WHERE company_id = $1", [companyId]);
    res.json({ invoice: invoiceView(inv), currentPeriodEnd: sub?.current_period_end || null });
  } catch (err) {
    next(err);
  }
});

app.post("/api/billing/checkout", auth, async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    const user = (req as Request & { auth: AuthUser & { name?: string; email?: string } }).auth;
    const pag = await loadPagbank();
    const usePagbank = pag.active && Boolean(pag.token);
    if (!usePagbank && !(await efiConfigured())) {
      return res.json({ configured: false, message: "O pagamento online ainda não está ativo. Fale com o suporte para pagar." });
    }
    const method = usePagbank ? "pix" : String(req.body?.method || "pix");
    if (!["pix", "card", "boleto"].includes(method)) return res.status(400).json({ error: "Método inválido" });
    const cycle = CYCLE_DAYS[String(req.body?.cycle)] ? String(req.body.cycle) : "monthly";
    const sub = await loadCheckoutSub(companyId);
    if (!sub) return res.status(404).json({ error: "Sem assinatura" });
    const price = cyclePrice(sub, cycle);
    if (price == null) return res.status(400).json({ error: "Esse ciclo não tem preço neste plano" });
    let quote;
    try {
      quote = await priceWithCoupon(sub, price, req.body?.coupon);
    } catch (err) {
      return res.status(400).json({ error: (err as Error).message });
    }
    if (quote.amount < 100) return res.status(400).json({ error: "O valor mínimo para pagar com Pix é R$ 1,00" });

    if (usePagbank) {
      const taxId = String(req.body?.taxId || "").replace(/\D/g, "") || String(sub.tax_id || "");
      if (taxId.length !== 11 && taxId.length !== 14) return res.status(400).json({ error: "Informe o CPF ou CNPJ de quem paga" });
      // Mesmo plano, ciclo e valor com um Pix ainda válido: reaproveita, em vez de criar outro pedido.
      const open = await one<Parameters<typeof invoiceView>[0]>(
        `SELECT ${INVOICE_COLUMNS} FROM invoices WHERE company_id = $1 AND provider = 'pagbank' AND status = 'pending' AND cycle = $2 AND amount_cents = $3 AND expires_at > now() + interval '3 minutes' ORDER BY id DESC LIMIT 1`,
        [companyId, cycle, quote.amount]
      );
      if (open) return res.json({ configured: true, provider: "pagbank", invoice: invoiceView(open) });
      try {
        await reserveCoupon(quote.couponId);
      } catch (err) {
        return res.status(400).json({ error: (err as Error).message });
      }
      const expiresAt = new Date(Date.now() + PIX_MINUTES * 60_000);
      const invoice = await one<{ id: number }>(
        "INSERT INTO invoices (company_id, plan_id, amount_cents, method, cycle, provider, expires_at) VALUES ($1,$2,$3,'pix',$4,'pagbank',$5) RETURNING id",
        [companyId, sub.plan_id, quote.amount, cycle, expiresAt]
      );
      const origin = publicOrigin(req, pag.publicUrl);
      try {
        const order = await createPagbankPix({
          referenceId: `achadinhos-${invoice!.id}`,
          amountCents: quote.amount,
          itemName: `Achadinhos ${sub.plan_name} (${cycle})`,
          customer: { name: String(user.name || sub.name), email: String(user.email || ""), taxId },
          expiresAt,
          notificationUrl: origin ? `${origin}/api/billing/pagbank/webhook` : undefined
        });
        if (!order.orderId || !order.qrText) throw new Error("O PagBank não devolveu o QR Code");
        // A imagem do QR sai daqui (mesmo texto do copia e cola), sem depender do link de imagem do PagBank.
        const qrcode = await import("qrcode");
        const toDataURL = qrcode.toDataURL || (qrcode as unknown as { default: typeof qrcode }).default.toDataURL;
        const qrData = await toDataURL(order.qrText, { margin: 1, width: 300 });
        const row = await one<Parameters<typeof invoiceView>[0]>(
          `UPDATE invoices SET external_id = $2, payload = $3::jsonb WHERE id = $1 RETURNING ${INVOICE_COLUMNS}`,
          [invoice!.id, order.orderId, JSON.stringify({ qrText: order.qrText, qrImage: qrData, qrLink: order.qrImage })]
        );
        await q("UPDATE companies SET tax_id = $2 WHERE id = $1", [companyId, taxId]);
        return res.json({ configured: true, provider: "pagbank", invoice: invoiceView(row!) });
      } catch (err) {
        await q("UPDATE invoices SET status = 'failed' WHERE id = $1", [invoice!.id]);
        if (quote.couponId) await q("UPDATE coupons SET used_count = greatest(0, used_count - 1) WHERE id = $1", [quote.couponId]);
        return res.status(502).json({ error: pagbankError(err) });
      }
    }

    try {
      await reserveCoupon(quote.couponId);
    } catch (err) {
      return res.status(400).json({ error: (err as Error).message });
    }
    const amount = quote.amount;
    const txid = crypto.randomBytes(16).toString("hex").slice(0, 26);
    const invoice = await one<{ id: number }>(
      "INSERT INTO invoices (company_id, plan_id, amount_cents, method, cycle, external_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
      [companyId, sub.plan_id, amount, method, cycle, txid]
    );
    let payload: unknown = {};
    if (method === "pix") payload = await createPix({ amountCents: amount, name: sub.name, txid });
    else if (method === "card") {
      payload = await createCard({
        amountCents: amount,
        name: String(req.body?.name || sub.name),
        email: String(req.body?.email || ""),
        document: String(req.body?.document || ""),
        paymentToken: String(req.body?.paymentToken || "")
      });
    } else {
      payload = await createBoleto({
        amountCents: amount,
        name: String(req.body?.name || sub.name),
        email: String(req.body?.email || ""),
        document: String(req.body?.document || ""),
        expireAt: String(req.body?.expireAt || new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10))
      });
    }
    await q("UPDATE invoices SET payload = $2::jsonb WHERE id = $1", [invoice!.id, JSON.stringify(payload)]);
    res.json({ configured: true, provider: "efi", invoiceId: invoice!.id, payload });
  } catch (err) {
    next(err);
  }
});

/** Aviso do PagBank. O corpo não é confiável: só serve para achar a cobrança, que é conferida direto no PagBank. */
app.post("/api/billing/pagbank/webhook", async (req, res) => {
  const orderId = String(req.body?.id || "").slice(0, 80);
  const reference = String(req.body?.reference_id || "");
  try {
    const inv = await one<{ id: number; company_id: number; external_id: string | null; amount_cents: number; status: string; expires_at: string | null }>(
      "SELECT id, company_id, external_id, amount_cents, status, expires_at FROM invoices WHERE provider = 'pagbank' AND (external_id = $1 OR $2 = 'achadinhos-' || id::text) LIMIT 1",
      [orderId, reference]
    );
    if (inv) await refreshPagbankInvoice(inv);
  } catch (err) {
    console.error("[billing] aviso do PagBank", pagbankError(err));
  }
  res.json({ ok: true });
});

/**
 * Webhook Pix da EFI.
 * Antes não havia autenticação: qualquer cliente pegava o txid devolvido no próprio checkout, chamava esta rota
 * e ativava a assinatura (até 365 dias) sem pagar.
 *
 * Agora:
 * - exige EFI_WEBHOOK_SECRET, comparado com ?hmac= (forma que a EFI documenta para webhook sem mTLS). Sem a variável, recusa;
 * - confere o valor pago contra o valor da fatura;
 * - marca a fatura como paga numa transação condicional (status <> 'paid'), então reenvio do mesmo evento não repete efeitos;
 * - aceita /api/billing/webhook/pix, porque a EFI acrescenta /pix à URL cadastrada.
 * Cadastre na EFI: https://SEU-DOMINIO/api/billing/webhook?hmac=SEGREDO&ignorar=
 */
const webhookAllowed = (req: Request) => {
  const expected = process.env.EFI_WEBHOOK_SECRET || "";
  if (!expected) return false;
  const given = Buffer.from(String(req.query.hmac || req.header("x-webhook-secret") || ""));
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && crypto.timingSafeEqual(given, wanted);
};

/** Comissão do parceiro que indicou a empresa, gravada na própria fatura paga (vale o percentual do dia do pagamento). */
const PARTNER_COMMISSION_SQL = `
  UPDATE invoices i SET partner_id = p.id, partner_cents = round(i.amount_cents * p.percent / 100.0)::int
  FROM companies c JOIN partners p ON p.id = c.partner_id
  WHERE i.id = $1 AND c.id = i.company_id AND p.active = true AND i.status = 'paid'`;

/**
 * Libera uma fatura paga (EFI, PagBank): renova sem perder os dias que ainda faltavam (inclusive do teste),
 * reativa a empresa suspensa e grava a comissão do parceiro. Chamar de novo não repete nada.
 */
const settleInvoice = async (invoiceId: number, payload: unknown) => {
  const applied = await withTransaction(async tx => {
    const inv = await tx.one<{ id: number; company_id: number; cycle: string }>(
      "UPDATE invoices SET status = 'paid', paid_at = now() WHERE id = $1 AND status <> 'paid' RETURNING id, company_id, cycle",
      [invoiceId]
    );
    if (!inv) return null;
    const days = CYCLE_DAYS[inv.cycle] || 30;
    await tx.q(
      `UPDATE subscriptions SET status = 'active', cycle = $3,
         current_period_end = GREATEST(now(), coalesce(current_period_end, now()), CASE WHEN status = 'trialing' THEN coalesce(trial_ends_at, now()) ELSE now() END) + ($2 || ' days')::interval,
         updated_at = now()
       WHERE company_id = $1`,
      [inv.company_id, String(days), inv.cycle]
    );
    await tx.q("UPDATE companies SET status = 'active', updated_at = now() WHERE id = $1 AND status = 'suspended'", [inv.company_id]);
    await tx.q("INSERT INTO payment_events (company_id, invoice_id, kind, payload) VALUES ($1,$2,'paid',$3::jsonb)", [inv.company_id, inv.id, JSON.stringify(payload ?? {})]);
    await tx.q(PARTNER_COMMISSION_SQL, [inv.id]);
    return inv;
  });
  if (applied) await audit(applied.company_id, null, "payment", "Pagamento confirmado");
  return Boolean(applied);
};

const billingWebhook = async (req: Request, res: Response) => {
  if (!webhookAllowed(req)) {
    const configured = Boolean(process.env.EFI_WEBHOOK_SECRET);
    if (!configured) console.error("[billing] webhook recusado: EFI_WEBHOOK_SECRET não configurado");
    return res.status(configured ? 401 : 503).json({ error: configured ? "Não autorizado" : "Webhook não configurado" });
  }
  const items: Array<{ txid?: unknown; valor?: unknown }> = Array.isArray(req.body?.pix) ? req.body.pix : req.body?.txid ? [req.body] : [];
  for (const item of items.slice(0, 50)) {
    const txid = String(item?.txid || "");
    if (!txid) continue;
    const invoice = await one<{ id: number; company_id: number; cycle: string; status: string; amount_cents: number }>(
      "SELECT id, company_id, cycle, status, amount_cents FROM invoices WHERE external_id = $1",
      [txid]
    );
    if (!invoice || invoice.status === "paid") continue;
    const paidCents = Math.round(Number(String(item.valor ?? "").replace(",", ".")) * 100);
    if (!Number.isFinite(paidCents) || paidCents !== Number(invoice.amount_cents)) {
      await q("INSERT INTO payment_events (company_id, invoice_id, kind, payload) VALUES ($1,$2,'amount_mismatch',$3::jsonb)", [invoice.company_id, invoice.id, JSON.stringify(item)]);
      await audit(invoice.company_id, null, "payment", `Pagamento recusado: valor ${String(item.valor ?? "")} diferente da fatura ${invoice.id}`);
      continue;
    }
    await settleInvoice(invoice.id, item);
  }
  res.json({ ok: true });
};

app.post("/api/billing/webhook", billingWebhook);
app.post("/api/billing/webhook/pix", billingWebhook);

app.get("/api/audit", auth, async (req, res, next) => {
  try {
    const user = (req as Request & { auth: AuthUser }).auth;
    const rows = user.role === "superadmin" && !user.companyId
      ? await q("SELECT * FROM audit_logs ORDER BY id DESC LIMIT 80")
      : await q("SELECT * FROM audit_logs WHERE company_id = $1 ORDER BY id DESC LIMIT 80", [user.companyId]);
    res.json({ logs: rows });
  } catch (err) {
    next(err);
  }
});

const escapeHtml = (value: unknown) =>
  String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

app.get("/vitrine/:tenantId", async (req, res) => {
  if (!UUID_RE.test(String(req.params.tenantId))) return res.status(404).type("html").send("<p>Vitrine indisponível.</p>");
  const company = await one<{ id: number; name: string }>(
    "SELECT c.id, c.name FROM companies c JOIN settings s ON s.company_id = c.id WHERE c.tenant_id = $1 AND s.enabled = true",
    [req.params.tenantId]
  );
  if (!company) return res.status(404).type("html").send("<p>Vitrine indisponível.</p>");
  const posts = await q<{ title: string; price_cents: number; marketplace: string; image_url: string | null; click_token: string | null; url: string }>(
    "SELECT DISTINCT ON (marketplace, external_id) title, price_cents, marketplace, image_url, click_token, url FROM posts WHERE company_id = $1 AND status = 'sent' ORDER BY marketplace, external_id, id DESC LIMIT 24",
    [company.id]
  );
  const cards = posts.map(post => {
    const href = post.click_token ? `/go/${post.click_token}` : post.url;
    const price = (post.price_cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
    return `<a class="card" href="${escapeHtml(href)}"><strong>${escapeHtml(post.title)}</strong><span>${escapeHtml(marketplaceLabel(post.marketplace))}</span><b>${escapeHtml(price)}</b><em>Ver oferta</em></a>`;
  }).join("");
  res.type("html").send(`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(company.name)}</title>
  <style>body{margin:0;font-family:system-ui;background:#f4f6fb;color:#0f172a}header{background:#0f172a;color:#fff;padding:28px 20px}main{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));padding:20px}.card{background:#fff;border-radius:16px;padding:14px;text-decoration:none;color:inherit;display:flex;flex-direction:column;gap:8px}em{margin-top:auto;font-style:normal;background:#0f172a;color:#fff;border-radius:10px;text-align:center;padding:8px}</style>
  <header><p>Ofertas do dia</p><h1>${escapeHtml(company.name)}</h1></header><main>${cards || "<p>Nenhuma oferta publicada ainda.</p>"}</main></html>`);
});

app.get("/go/:token", async (req, res) => {
  const row = await one<{ url: string }>("UPDATE posts SET click_count = click_count + 1 WHERE click_token = $1 AND status = 'sent' RETURNING url", [req.params.token]);
  if (!row?.url) return res.status(404).send("Oferta não encontrada");
  res.redirect(302, row.url);
});

app.get("/api/notices", auth, async (req, res) => {
  const companyId = companyIdOf(req);
  const rows = await q("SELECT id, title, body, status, channel, detail, created_at FROM notices WHERE company_id = $1 AND read_at IS NULL ORDER BY id DESC LIMIT 10", [companyId]);
  res.json({ notices: rows });
});

app.post("/api/notices/:id/read", auth, async (req, res) => {
  await q("UPDATE notices SET read_at = now(), status = CASE WHEN status = 'open' THEN 'read' ELSE status END WHERE id = $1 AND company_id = $2", [Number(req.params.id), companyIdOf(req)]);
  res.json({ ok: true });
});

app.get("/api/team", auth, async (req, res) => {
  const companyId = companyIdOf(req);
  const users = await q("SELECT id, name, email, phone, role, last_login_at, created_at FROM users WHERE company_id = $1 ORDER BY id", [companyId]);
  const keys = await q("SELECT id, name, token_prefix, created_at, last_used_at FROM api_keys WHERE company_id = $1 ORDER BY id", [companyId]);
  res.json({ users, keys });
});

app.post("/api/team", auth, async (req, res, next) => {
  try {
    const actor = (req as Request & { auth: AuthUser }).auth;
    if (actor.role !== "owner") return res.status(403).json({ error: "Só o dono da empresa cria usuários" });
    const companyId = companyIdOf(req);
    await assertRoom(companyId, "users");
    const name = String(req.body?.name || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const role = req.body?.role === "manager" ? "manager" : "member";
    if (!name || !email || password.length < 6) return res.status(400).json({ error: "Informe nome, e-mail e senha com 6 caracteres" });
    if (!validEmail(email)) return res.status(400).json({ error: "E-mail inválido" });
    const hash = await bcrypt.hash(password, 10);
    const user = await one(
      "INSERT INTO users (company_id, name, email, password_hash, role, phone) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, email, role",
      [companyId, name, email, hash, role, String(req.body?.phone || "").replace(/\D/g, "").slice(0, 16)]
    );
    await audit(companyId, actor.id, "team", `Usuário ${email} criado como ${role}`, ipOf(req));
    res.status(201).json({ user });
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return res.status(409).json({ error: "Este e-mail já tem conta" });
    next(err);
  }
});

app.patch("/api/team/:id", auth, async (req, res) => {
  const actor = (req as Request & { auth: AuthUser }).auth;
  if (actor.role !== "owner") return res.status(403).json({ error: "Só o dono da empresa altera papéis" });
  const companyId = companyIdOf(req);
  const role = req.body?.role === "manager" ? "manager" : req.body?.role === "member" ? "member" : "";
  if (!role) return res.status(400).json({ error: "Papel inválido" });
  const target = await one<{ id: number; role: string }>("SELECT id, role FROM users WHERE id = $1 AND company_id = $2", [Number(req.params.id), companyId]);
  if (!target) return res.status(404).json({ error: "Usuário não encontrado" });
  if (target.role === "owner") return res.status(400).json({ error: "O dono não muda de papel por aqui" });
  await q("UPDATE users SET role = $3 WHERE id = $1 AND company_id = $2", [target.id, companyId, role]);
  await audit(companyId, actor.id, "team", `Papel do usuário ${target.id} virou ${role}`, ipOf(req));
  res.json({ ok: true });
});

app.delete("/api/team/:id", auth, async (req, res) => {
  const actor = (req as Request & { auth: AuthUser }).auth;
  if (actor.role !== "owner") return res.status(403).json({ error: "Só o dono da empresa remove usuários" });
  const companyId = companyIdOf(req);
  const target = await one<{ id: number; role: string; email: string }>("SELECT id, role, email FROM users WHERE id = $1 AND company_id = $2", [Number(req.params.id), companyId]);
  if (!target) return res.status(404).json({ error: "Usuário não encontrado" });
  if (target.role === "owner") return res.status(400).json({ error: "O dono não pode ser removido" });
  await q("DELETE FROM users WHERE id = $1 AND company_id = $2", [target.id, companyId]);
  await audit(companyId, actor.id, "team", `Usuário ${target.email} removido`, ipOf(req));
  res.json({ ok: true });
});

app.post("/api/keys", auth, async (req, res) => {
  const actor = (req as Request & { auth: AuthUser }).auth;
  if (actor.role !== "owner") return res.status(403).json({ error: "Só o dono da empresa cria chave de API" });
  const companyId = companyIdOf(req);
  const plan = await one<{ features: { api?: boolean } }>("SELECT p.features FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.company_id = $1", [companyId]);
  if (!plan?.features?.api) return res.status(402).json({ error: "Este plano não libera a API" });
  const token = `ak_${crypto.randomBytes(24).toString("hex")}`;
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  const row = await one(
    "INSERT INTO api_keys (company_id, name, token_hash, token_prefix) VALUES ($1,$2,$3,$4) RETURNING id, name, token_prefix, created_at",
    [companyId, String(req.body?.name || "Principal").slice(0, 40), hash, token.slice(0, 10)]
  );
  await audit(companyId, actor.id, "api", "Chave de API criada", ipOf(req));
  res.status(201).json({ key: row, token });
});

app.delete("/api/keys/:id", auth, async (req, res) => {
  const actor = (req as Request & { auth: AuthUser }).auth;
  if (actor.role !== "owner") return res.status(403).json({ error: "Só o dono da empresa remove a chave" });
  await q("DELETE FROM api_keys WHERE id = $1 AND company_id = $2", [Number(req.params.id), companyIdOf(req)]);
  res.json({ ok: true });
});

app.get("/api/v1/offers", async (req, res) => {
  const raw = String(req.header("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!raw.startsWith("ak_")) return res.status(401).json({ error: "Informe a chave da API" });
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  const key = await one<{ id: number; company_id: number }>("SELECT id, company_id FROM api_keys WHERE token_hash = $1", [hash]);
  if (!key) return res.status(401).json({ error: "Chave inválida" });
  const plan = await one<{ features: { api?: boolean }; status: string }>(
    "SELECT p.features, c.status FROM subscriptions s JOIN plans p ON p.id = s.plan_id JOIN companies c ON c.id = s.company_id WHERE s.company_id = $1",
    [key.company_id]
  );
  if (plan?.status === "blocked") return res.status(403).json({ error: "Empresa bloqueada" });
  if (!plan?.features?.api) return res.status(402).json({ error: "Este plano não libera a API" });
  await q("UPDATE api_keys SET last_used_at = now() WHERE id = $1", [key.id]);
  const offers = await q("SELECT id, marketplace, title, price_cents, url, found_at FROM offers WHERE company_id = $1 ORDER BY found_at DESC LIMIT 50", [key.company_id]);
  res.json({ offers });
});

app.post("/api/admin/testimonials", auth, admin, async (req, res) => {
  const author = String(req.body?.author || "").trim();
  const quote = String(req.body?.quote || "").trim();
  if (!author || quote.length < 8) return res.status(400).json({ error: "Informe o autor e um depoimento" });
  const row = await one(
    "INSERT INTO testimonials (author, company, quote, sort_order) VALUES ($1,$2,$3,$4) RETURNING *",
    [author, String(req.body?.company || "").trim(), quote, Number(req.body?.sortOrder || 0)]
  );
  await audit(null, (req as Request & { auth: AuthUser }).auth.id, "testimonial", `Depoimento de ${author}`, ipOf(req));
  res.status(201).json({ testimonial: row });
});

app.delete("/api/admin/testimonials/:id", auth, admin, async (req, res) => {
  await q("DELETE FROM testimonials WHERE id = $1", [Number(req.params.id)]);
  res.json({ ok: true });
});

app.post("/api/admin/smtp/test", auth, admin, async (req, res) => {
  const to = String(req.body?.to || (req as Request & { auth: AuthUser }).auth.email || "").trim();
  if (!to.includes("@")) return res.status(400).json({ error: "Informe um e-mail" });
  try {
    const { sendMail } = await import("./mail");
    const result = await sendMail({ to, subject: "Teste Achadinhos", text: "Este é o teste de e-mail do super admin." });
    if (!result.sent) return res.status(400).json({ error: result.reason });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: String((err as Error).message || err).slice(0, 220) });
  }
});

app.use((err: Error & { status?: number; code?: string; isAxiosError?: boolean }, req: Request, res: Response, _next: NextFunction) => {
  // 22P02/22003: parâmetro que não converte para o tipo da coluna (ex.: /api/team/abc). É erro do pedido, não do servidor.
  if (err.code === "22P02" || err.code === "22003") return res.status(400).json({ error: "Parâmetro inválido" });
  // AxiosError traz o status da resposta do serviço externo (ex.: 401 da EFI); repassá-lo faria o painel tratar como sessão inválida.
  const status = err.isAxiosError ? 502 : err.status || 500;
  if (status >= 500) console.error(`[api] ${req.method} ${req.path}`, err.isAxiosError ? err.message : err);
  // Mensagens de 5xx podem trazer detalhes do banco ou de serviços externos; o detalhe fica no log.
  const message = err.isAxiosError ? "O serviço externo não respondeu. Tente de novo." : status >= 500 && !err.status ? "Erro interno" : err.message || "Erro interno";
  res.status(status).json({ error: message });
});

export { tickAudience };
