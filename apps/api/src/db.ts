import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import bcrypt from "bcryptjs";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

export const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => {
  const result = await pool.query(text, params);
  return result.rows as T[];
};

export const one = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => {
  const rows = await q<T>(text, params);
  return rows[0] ?? null;
};

export const migrate = async () => {
  const schema = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "schema.sql"), "utf8");
  await pool.query(schema);
  await pool.query(`
    ALTER TABLE plans ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
    ALTER TABLE plans ADD COLUMN IF NOT EXISTS benefits TEXT NOT NULL DEFAULT '';
    ALTER TABLE plans ADD COLUMN IF NOT EXISTS quarterly_cents INTEGER;
    ALTER TABLE plans ADD COLUMN IF NOT EXISTS semiannual_cents INTEGER;
    ALTER TABLE plans ADD COLUMN IF NOT EXISTS max_posts_per_month INTEGER;
    ALTER TABLE plans ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT '';
    ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS connected_at TIMESTAMPTZ;
    ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS qr_at TIMESTAMPTZ;
    ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS send_cadence JSONB NOT NULL DEFAULT '{}';
    ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS interval_seconds INTEGER;
    ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS posts_per_cycle INTEGER;
    ALTER TABLE posts ADD COLUMN IF NOT EXISTS whatsapp_id INTEGER;
    ALTER TABLE groups DROP CONSTRAINT IF EXISTS groups_company_id_group_jid_key;
    CREATE UNIQUE INDEX IF NOT EXISTS groups_company_whatsapp_jid ON groups (company_id, whatsapp_id, group_jid);
    UPDATE posts p
       SET whatsapp_id = g.whatsapp_id
      FROM groups g
     WHERE p.whatsapp_id IS NULL
       AND p.company_id = g.company_id
       AND p.group_jid = g.group_jid
       AND g.whatsapp_id IS NOT NULL
       AND p.group_jid NOT LIKE 'telegram:%';
    ALTER TABLE audience_jobs ADD COLUMN IF NOT EXISTS source_group_jid TEXT NOT NULL DEFAULT '';
    ALTER TABLE audience_jobs ADD COLUMN IF NOT EXISTS source_group_name TEXT NOT NULL DEFAULT '';
    ALTER TABLE audience_jobs ADD COLUMN IF NOT EXISTS source_members INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE audience_jobs ADD COLUMN IF NOT EXISTS source_admins INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
    ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS ip TEXT NOT NULL DEFAULT '';
    CREATE TABLE IF NOT EXISTS platform_settings (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      efi_client_id TEXT NOT NULL DEFAULT '',
      efi_client_secret_enc TEXT NOT NULL DEFAULT '',
      efi_pix_key TEXT NOT NULL DEFAULT '',
      efi_sandbox BOOLEAN NOT NULL DEFAULT TRUE,
      efi_webhook_url TEXT NOT NULL DEFAULT '',
      trial_days_default INTEGER NOT NULL DEFAULT 7,
      warn_days TEXT NOT NULL DEFAULT '7,3,1',
      block_after_days INTEGER NOT NULL DEFAULT 3,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE companies ADD COLUMN IF NOT EXISTS city TEXT NOT NULL DEFAULT '';
    ALTER TABLE companies ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT '';
    ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS smtp_host TEXT NOT NULL DEFAULT '';
    ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS smtp_port INTEGER NOT NULL DEFAULT 587;
    ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS smtp_user TEXT NOT NULL DEFAULT '';
    ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS smtp_pass_enc TEXT NOT NULL DEFAULT '';
    ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS smtp_from TEXT NOT NULL DEFAULT '';
    INSERT INTO platform_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
    CREATE TABLE IF NOT EXISTS notices (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'panel',
      status TEXT NOT NULL DEFAULT 'open',
      detail TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      read_at TIMESTAMPTZ,
      UNIQUE (company_id, kind)
    );
    CREATE TABLE IF NOT EXISTS testimonials (
      id SERIAL PRIMARY KEY,
      author TEXT NOT NULL,
      company TEXT NOT NULL DEFAULT '',
      quote TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS api_keys (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT 'Principal',
      token_hash TEXT NOT NULL UNIQUE,
      token_prefix TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS coupons (
      id SERIAL PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL DEFAULT 'percent',
      percent INTEGER,
      amount_cents INTEGER,
      plan_slug TEXT NOT NULL DEFAULT '',
      max_uses INTEGER,
      used_count INTEGER NOT NULL DEFAULT 0,
      expires_at TIMESTAMPTZ,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  const email = process.env.ADMIN_EMAIL || "admin@achadinhos.local";
  const password = process.env.ADMIN_PASSWORD || "admin123456";
  const exists = await one("SELECT id FROM users WHERE email = $1", [email]);
  if (!exists) {
    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      "INSERT INTO users (company_id, name, email, password_hash, role) VALUES (NULL, $1, $2, $3, 'superadmin')",
      ["Super Admin", email, hash]
    );
  }
};

export const audit = async (companyId: number | null, userId: number | null, action: string, summary: string, ip = "") => {
  await pool.query(
    "INSERT INTO audit_logs (company_id, user_id, action, summary, ip) VALUES ($1, $2, $3, $4, $5)",
    [companyId, userId, action, summary.slice(0, 500), ip.slice(0, 80)]
  );
};
