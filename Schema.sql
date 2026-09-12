-- DollarTube schema
-- Design rule: nobody's balance is a stored number that a client can push up.
-- Balance = SUM(ledger.amount_usd) for confirmed rows. Every credit traces back
-- to a verifiable event (ad token, survey provider postback, daily-claim rule
-- enforced server-side). Every debit traces to a withdrawal request.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,          -- uuid
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT 'Runner',
  currency      TEXT NOT NULL DEFAULT 'USD',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_daily_claim TEXT,                   -- date of last daily-reward claim
  daily_streak  INTEGER NOT NULL DEFAULT 0
);

-- Append-only. Rows are never UPDATEd for amount; a correction is a new
-- offsetting row. This is what makes the balance auditable.
CREATE TABLE IF NOT EXISTS ledger (
  id          TEXT PRIMARY KEY,            -- uuid
  user_id     TEXT NOT NULL REFERENCES users(id),
  type        TEXT NOT NULL CHECK (type IN (
                'ad_reward','survey_reward','daily_bonus',
                'game_bonus','withdrawal_hold','withdrawal_refund','adjustment')),
  amount_usd  REAL NOT NULL,               -- positive = credit, negative = debit
  status      TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','reversed')),
  ref_table   TEXT,                        -- e.g. 'ad_sessions', 'survey_completions', 'withdrawals'
  ref_id      TEXT,                        -- id in that table, for audit trail
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_id);

-- Server issues a token BEFORE the ad plays; the ad SDK / mediation network's
-- server-side reward callback (or, in this sample, a manual /complete call
-- standing in for it) must confirm it before any credit happens. Prevents a
-- client from just calling "credit me $0.25" directly.
CREATE TABLE IF NOT EXISTS ad_sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  amount_usd  REAL NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','expired')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL
);

-- One row per survey-provider postback. The (provider, external_id) unique
-- constraint stops the same completion being replayed for a second credit.
CREATE TABLE IF NOT EXISTS survey_completions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  provider      TEXT NOT NULL,             -- 'pollfish' | 'bitlabs' | 'cpx' | ...
  external_id   TEXT NOT NULL,             -- the provider's transaction/click id
  amount_usd    REAL NOT NULL,
  raw_payload   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(provider, external_id)
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  amount_usd  REAL NOT NULL,
  method      TEXT NOT NULL CHECK (method IN ('paypal','bank','upi','wise','payoneer')),
  account     TEXT NOT NULL,               -- payout destination (email/IBAN/UPI id)
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','paid','rejected')),
  provider_ref TEXT,                       -- id returned by PayPal Payouts etc.
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(user_id);
