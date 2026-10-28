-- W3: accounts, session lifecycle and login throttling. Idempotent so it is safe before and after a migration runner exists.
ALTER TABLE users ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at timestamptz;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ip text;
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
-- Keys are sha256 hashes of "scope|value" so attacker-chosen emails cannot bloat or leak through this table.
CREATE TABLE IF NOT EXISTS login_throttle (key text PRIMARY KEY, scope text NOT NULL, failures integer NOT NULL DEFAULT 0, window_started_at timestamptz NOT NULL DEFAULT now(), locked_until timestamptz);
CREATE INDEX IF NOT EXISTS login_throttle_window ON login_throttle(window_started_at);
