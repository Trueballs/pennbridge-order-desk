-- Direct push of an approved export into Odoo as a draft quotation (job type 'odoo_push').
-- jobs.export_id binds the job to one export; at most one active push job per export.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS export_id text;
CREATE UNIQUE INDEX IF NOT EXISTS jobs_odoo_push_active ON jobs(export_id) WHERE type='odoo_push' AND status IN ('queued','running','retry_wait');
