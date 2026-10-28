-- Operations: service heartbeats (readiness), budget release/allowances, session purge index.
CREATE TABLE IF NOT EXISTS service_heartbeats (name text PRIMARY KEY, beat_at timestamptz NOT NULL DEFAULT now(), detail jsonb NOT NULL DEFAULT '{}'::jsonb);
ALTER TABLE budget_reservations ADD COLUMN IF NOT EXISTS released_at timestamptz;
ALTER TABLE budget_reservations DROP CONSTRAINT IF EXISTS budget_reservations_state_check;
ALTER TABLE budget_reservations ADD CONSTRAINT budget_reservations_state_check CHECK(state IN ('reserved','settled','released'));
CREATE INDEX IF NOT EXISTS budget_reservations_open ON budget_reservations(state,created_at);
-- Admin-granted extra attempts for one order after it exhausted its per-order reservation limit.
CREATE TABLE IF NOT EXISTS budget_allowances (order_id text PRIMARY KEY, extra integer NOT NULL CHECK(extra>=0), granted_by text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
