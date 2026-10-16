CREATE TABLE IF NOT EXISTS plans (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  monthly_cents INTEGER NOT NULL DEFAULT 0,
  yearly_cents INTEGER NOT NULL DEFAULT 0,
  trial_days INTEGER NOT NULL DEFAULT 7,
  max_connections INTEGER,
  max_groups INTEGER,
  max_stores INTEGER,
  max_posts_per_day INTEGER,
  max_users INTEGER,
  features JSONB NOT NULL DEFAULT '{}',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS companies (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  status TEXT NOT NULL DEFAULT 'trialing',
  cycle TEXT NOT NULL DEFAULT 'monthly',
  trial_ends_at TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invoices (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  plan_id INTEGER REFERENCES plans(id),
  amount_cents INTEGER NOT NULL,
  method TEXT NOT NULL,
  cycle TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  external_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS payment_events (
  id SERIAL PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  hour_start INTEGER,
  hour_end INTEGER,
  allowed_days TEXT NOT NULL DEFAULT '',
  min_discount INTEGER,
  min_price_cents INTEGER,
  max_price_cents INTEGER,
  allowed_categories TEXT NOT NULL DEFAULT '',
  banned_words TEXT NOT NULL DEFAULT '',
  blocked_categories TEXT NOT NULL DEFAULT '',
  send_all_groups BOOLEAN NOT NULL DEFAULT FALSE,
  random_catalog BOOLEAN NOT NULL DEFAULT TRUE,
  posts_per_cycle INTEGER NOT NULL DEFAULT 1,
  interval_seconds INTEGER NOT NULL DEFAULT 20,
  send_cadence JSONB NOT NULL DEFAULT '{}',
  ml_tag TEXT NOT NULL DEFAULT '',
  ml_matt_tool TEXT NOT NULL DEFAULT '',
  ml_matt_word TEXT NOT NULL DEFAULT '',
  ml_official BOOLEAN NOT NULL DEFAULT FALSE,
  ml_cookie_enc TEXT NOT NULL DEFAULT '',
  ml_cookie_expires_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS whatsapp_sessions (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'disconnected',
  phone TEXT NOT NULL DEFAULT '',
  qr TEXT NOT NULL DEFAULT '',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  stores JSONB NOT NULL DEFAULT '[]',
  selected BOOLEAN NOT NULL DEFAULT FALSE,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS telegram_bots (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Bot',
  token_enc TEXT NOT NULL DEFAULT '',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  stores JSONB NOT NULL DEFAULT '[]',
  chats JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stores (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  marketplace TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  public_config JSONB NOT NULL DEFAULT '{}',
  secrets_enc TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, marketplace)
);

CREATE TABLE IF NOT EXISTS campaigns (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  marketplace TEXT NOT NULL,
  query TEXT NOT NULL,
  min_discount INTEGER,
  max_price_cents INTEGER,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS groups (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  whatsapp_id INTEGER REFERENCES whatsapp_sessions(id) ON DELETE CASCADE,
  group_jid TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  categories TEXT NOT NULL DEFAULT '',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  member_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS offers (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  marketplace TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  price_cents INTEGER NOT NULL DEFAULT 0,
  original_price_cents INTEGER,
  discount_percent INTEGER,
  url TEXT NOT NULL,
  image_url TEXT,
  category TEXT,
  score INTEGER NOT NULL DEFAULT 0,
  found_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, marketplace, external_id)
);

CREATE TABLE IF NOT EXISTS posts (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  marketplace TEXT NOT NULL,
  external_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  price_cents INTEGER NOT NULL DEFAULT 0,
  url TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  group_jid TEXT NOT NULL DEFAULT '',
  group_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'sent',
  click_token TEXT UNIQUE,
  click_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  whatsapp_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contacts (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  names JSONB NOT NULL DEFAULT '[]',
  tags JSONB NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'manual',
  lid TEXT NOT NULL DEFAULT '',
  blocked BOOLEAN NOT NULL DEFAULT FALSE,
  has_whatsapp BOOLEAN,
  anonymized_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, phone)
);

CREATE TABLE IF NOT EXISTS audience_jobs (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  whatsapp_id INTEGER NOT NULL REFERENCES whatsapp_sessions(id) ON DELETE CASCADE,
  group_jid TEXT NOT NULL,
  group_name TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  interval_seconds INTEGER NOT NULL DEFAULT 300,
  per_hour INTEGER NOT NULL DEFAULT 12,
  per_day INTEGER NOT NULL DEFAULT 80,
  per_week INTEGER NOT NULL DEFAULT 400,
  batch_size INTEGER NOT NULL DEFAULT 1,
  invite_url TEXT,
  last_tick_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audience_items (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  job_id INTEGER NOT NULL REFERENCES audience_jobs(id) ON DELETE CASCADE,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  phone TEXT NOT NULL,
  group_jid TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  reason TEXT,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  user_id INTEGER,
  action TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS posts_company_created ON posts (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS contacts_company ON contacts (company_id);
CREATE INDEX IF NOT EXISTS audience_items_job ON audience_items (job_id, status);
