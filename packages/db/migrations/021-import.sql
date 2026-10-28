-- W3: versioned catalogue and CSV import history.
CREATE TABLE IF NOT EXISTS catalogue_versions (version text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(), batch_id text, note text);
CREATE TABLE IF NOT EXISTS import_batches (id text PRIMARY KEY, kind text NOT NULL, filename text, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), total_rows integer NOT NULL, created_count integer NOT NULL, updated_count integer NOT NULL, unchanged_count integer NOT NULL, deleted_count integer NOT NULL DEFAULT 0, catalogue_version text, content_hash text NOT NULL);
CREATE INDEX IF NOT EXISTS import_batches_created ON import_batches(created_at DESC);
