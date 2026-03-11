-- =============================================================
-- scripts/migrate.sql
-- Full Postgres schema for Shitter Bob
-- Run: psql $DATABASE_URL -f migrate.sql
-- =============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- -----------------------------------------------------------
-- tokens: every token Bob has ever seen or evaluated
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS tokens (
  mint                    TEXT PRIMARY KEY,
  name                    TEXT NOT NULL,
  symbol                  TEXT NOT NULL,
  uri                     TEXT,
  dev_wallet              TEXT,
  safety_score            JSONB,          -- full SafetyResult JSON
  meme_score              INTEGER,
  rugcheck_risk           TEXT,
  mint_authority_revoked  BOOLEAN,
  freeze_authority_revoked BOOLEAN,
  lp_burned               BOOLEAN,
  holder_concentration    NUMERIC(5,4),
  bonding_curve_pct       NUMERIC(5,2),
  first_seen              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_updated            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tokens_meme_score ON tokens(meme_score DESC);
CREATE INDEX IF NOT EXISTS idx_tokens_first_seen  ON tokens(first_seen DESC);

-- -----------------------------------------------------------
-- positions: each trade Bob opens
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS positions (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  mint                  TEXT NOT NULL REFERENCES tokens(mint),
  symbol                TEXT NOT NULL,
  entry_price           NUMERIC(20,10) NOT NULL,
  entry_amount_sol      NUMERIC(20,9)  NOT NULL,
  token_amount          NUMERIC(30,0)  NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('open','partial','closed','moonbag')),
  quick_exit_target     NUMERIC(20,10) NOT NULL,
  quick_exit_done       BOOLEAN NOT NULL DEFAULT FALSE,
  trailing_stop_pct     NUMERIC(5,4)   NOT NULL DEFAULT 0.20,
  moon_bag_amount       NUMERIC(30,0)  NOT NULL DEFAULT 0,
  opened_at             TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  closed_at             TIMESTAMPTZ,
  source                TEXT NOT NULL CHECK (source IN ('scan','audience')),
  tipper                TEXT           -- @handle if audience tip
);

CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
CREATE INDEX IF NOT EXISTS idx_positions_mint   ON positions(mint);

-- -----------------------------------------------------------
-- trades: individual buy/sell txns
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS trades (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  position_id   UUID NOT NULL REFERENCES positions(id),
  type          TEXT NOT NULL CHECK (type IN ('buy','sell')),
  price         NUMERIC(20,10) NOT NULL,
  amount_sol    NUMERIC(20,9)  NOT NULL,
  token_amount  NUMERIC(30,0)  NOT NULL,
  pnl           NUMERIC(20,9),          -- NULL for buys
  tx_hash       TEXT NOT NULL UNIQUE,
  timestamp     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trades_position ON trades(position_id);
CREATE INDEX IF NOT EXISTS idx_trades_ts       ON trades(timestamp DESC);

-- -----------------------------------------------------------
-- fees_ledger: every lamport earned, tracked by bucket
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS fees_ledger (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  trade_id         TEXT NOT NULL,        -- UUID or 'burn-cycle'
  amount_lamports  NUMERIC(30,0) NOT NULL,
  bucket           TEXT NOT NULL CHECK (bucket IN ('burn_queue','dev_fund','trading_balance')),
  processed        BOOLEAN NOT NULL DEFAULT FALSE,
  timestamp        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fees_bucket     ON fees_ledger(bucket, processed);
CREATE INDEX IF NOT EXISTS idx_fees_ts         ON fees_ledger(timestamp DESC);

-- -----------------------------------------------------------
-- burn_events: each 30-min burn cycle record
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS burn_events (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  amount_lamports  NUMERIC(30,0) NOT NULL,
  burn_pct         INTEGER NOT NULL,
  tx_hash          TEXT NOT NULL,
  timestamp        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_burns_ts ON burn_events(timestamp DESC);

-- -----------------------------------------------------------
-- audience_tips: track every token tip from chat
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS audience_tips (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source       TEXT NOT NULL CHECK (source IN ('telegram','x')),
  user_handle  TEXT NOT NULL,
  mint         TEXT NOT NULL,
  tip_time     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  result       TEXT NOT NULL CHECK (result IN ('pending','rejected','queued','traded','win','loss'))
                 DEFAULT 'pending',
  position_id  UUID REFERENCES positions(id)
);

CREATE INDEX IF NOT EXISTS idx_tips_handle ON audience_tips(user_handle);
CREATE INDEX IF NOT EXISTS idx_tips_result ON audience_tips(result);

-- -----------------------------------------------------------
-- pending_sweeps: dev wallet sweeps (processed by separate secure script)
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS pending_sweeps (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  amount_lamports  NUMERIC(30,0) NOT NULL,
  destination      TEXT NOT NULL,
  processed        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------
-- Supabase RLS: public read-only access for dashboard
-- (Run these after enabling RLS in Supabase dashboard)
-- -----------------------------------------------------------
-- ALTER TABLE tokens         ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE positions      ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE trades         ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE burn_events    ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE audience_tips  ENABLE ROW LEVEL SECURITY;
--
-- CREATE POLICY "public read" ON tokens         FOR SELECT USING (true);
-- CREATE POLICY "public read" ON positions      FOR SELECT USING (true);
-- CREATE POLICY "public read" ON trades         FOR SELECT USING (true);
-- CREATE POLICY "public read" ON burn_events    FOR SELECT USING (true);
-- CREATE POLICY "public read" ON audience_tips  FOR SELECT USING (true);
--
-- NOTE: fees_ledger and pending_sweeps are NOT exposed publicly.