# Operations guide

For the person who installs and runs the desk on one Linux server. Everything here was exercised against a throwaway production Compose project on 28 October 2026 (HTTPS with Caddy's internal CA, worker crash recovery, app recreation, backup and restore). Items marked *not tested here* were not.

## What runs

| Service | Role | Exposed |
|---|---|---|
| `proxy` (Caddy) | HTTPS, redirects HTTP, security headers | ports 80 and 443 |
| `app` | Next.js desk and API | private network only |
| `worker` | Processes queued emails, budget housekeeping | private network (plus internet only when live AI is on) |
| `db` (PostgreSQL 17) | All data | private network only |
| `backup` | Nightly dump and documents archive, keeps 14 days | none |
| `mailbox` | Optional IMAP receiver | outbound IMAP only |

There is no Mailpit, no demo data and no demo API in production. `infra/compose.yaml` remains the local demo and is unrelated to the production stack.

## Install on a fresh Ubuntu server

Needs Ubuntu 22.04 or 24.04, 2 CPU, 4 GB RAM, 20 GB disk, root access, and a DNS name pointing at the server with ports 80 and 443 open to the internet (Let's Encrypt needs both).

```sh
git clone <repository> /opt/pennbridge && cd /opt/pennbridge
sudo scripts/install.sh --domain orders.example.co.uk
```

The script installs Docker from the Ubuntu repositories if missing, generates `.env` (database password from `openssl rand`, mode 600), creates `backups/`, `certs/`, `secrets/`, builds the image, starts the stack and waits for readiness. It never overwrites an existing `.env`. Then create the first administrator (the password is read from a prompt, `--password-file` or `ADMIN_PASSWORD`, never an argument):

```sh
scripts/pbctl.sh exec app npx tsx scripts/create_admin.ts --email you@example.co.uk --name "Your Name"
```

Sign in at `https://orders.example.co.uk`, then load master data (Administration, import templates in `docs/import-templates/`).

`scripts/pbctl.sh` is `docker compose` with the right files and `.env`: `scripts/pbctl.sh ps`, `logs -f worker`, `restart app`. Use it instead of calling Compose directly.

## Domain and TLS

Set at install time with `--tls`, or edit `PB_TLS_MODE` in `.env` and run `scripts/pbctl.sh up -d`.

- `auto` (default): Caddy gets and renews Let's Encrypt certificates itself. Needs a public DNS name and ports 80/443.
- `custom`: put your certificate chain in `certs/fullchain.pem` and key in `certs/privkey.pem`. Restart `proxy` after renewal: `scripts/pbctl.sh restart proxy`.
- `internal`: Caddy's private CA. Only for testing or an internal-only name; browsers warn until the CA (`/data/caddy/pki/authorities/local/root.crt` in the proxy container) is trusted.

Session cookies are `Secure` by default, so the desk only works over HTTPS (or `localhost`). The proxy overwrites `X-Forwarded-For` and `X-Real-IP` with the real client address, which the login throttle relies on. If you put another proxy or load balancer in front, that breaks the assumption; talk to whoever maintains the code before doing so.

## Mailbox

Use one dedicated shared mailbox (for example `orders@`) with IMAP and an app password. As the installing user, from the checkout:

```sh
python3 scripts/configure_mailbox.py      # writes runtime/mailbox/{config.json,password,token}
scripts/pbctl.sh up -d                    # the mailbox overlay is added automatically when config.json exists
scripts/pbctl.sh logs -f mailbox
```

The receiver only reads (it never marks mail read or deletes). The `subjectPrefix` in `config.json` can be empty to ingest all mail, subject to the receiver's auto-reply and rate filters. Credential rejection raises an alert that shows in readiness and makes the mailbox container unhealthy. See `docs/TEST-INBOX.md` for mailbox details. *Not tested here: a live IMAP connection.*

## Gemini (live extraction)

Without a key the desk still works: orders arrive for manual entry. To turn on Gemini:

```sh
install -m 600 /path/to/key secrets/gemini_key
sed -i 's/^LIVE_AI_ENABLED=.*/LIVE_AI_ENABLED=true/' .env
scripts/pbctl.sh up -d
```

Only the worker gets the key and internet access. The worker refuses to start if live AI is enabled without the key file or the pricing settings. Order text is sent to Google; decide that is acceptable for your data first. Spend is capped per calendar month (`AI_RUN_BUDGET_USD`, Europe/London) and per order (`AI_ORDER_BUDGET_USD`); a changed cap applies immediately. A reservation whose call never completed (worker crash) is released after `BUDGET_RELEASE_GRACE_MINUTES` (15). A reprocess works while the order stays under its per-order cap; an administrator can allow extra attempts for an order stuck on `BUDGET_EXCEEDED` through `grantReprocessAllowance` in `packages/db`.

## Settings reference (`.env`)

| Variable | Meaning |
|---|---|
| `PB_DOMAIN`, `PB_TLS_MODE` | Host name and TLS mode |
| `POSTGRES_PASSWORD` | Generated; only hex characters (it is embedded in a URL). Changing it later means changing it inside PostgreSQL too |
| `PB_BACKUP_DIR`, `PB_CERT_DIR`, `PB_SECRETS_DIR`, `PB_MAILBOX_DIR` | Host folders |
| `BACKUP_RETAIN_DAYS`, `BACKUP_HOUR_UTC`, `BACKUP_MINUTE_UTC` | Backup schedule (default 02:30 UTC, 14 days, never fewer than 3 sets) |
| `LIVE_AI_ENABLED`, `AI_*`, `EXTRACTION_MODEL` | Live extraction and budgets |
| `PB_BIND`, `PB_HTTP_PORT`, `PB_HTTPS_PORT` | Published address and ports (test setups) |

The app validates its configuration at start and refuses to run with a missing, default or short (under 16 characters) database password, or incomplete live-AI settings. The message lists every problem.

## Backups and restore

The `backup` service writes to `backups/` every night: a PostgreSQL custom-format dump, a tar of the documents volume and a SHA-256 file, and checks the dump is readable. Run one now with `scripts/backup.sh` (`--list` to see them). **Copy `backups/` and `.env` off the server** (a second machine or object storage); backups on the same disk do not survive losing the server. *Offsite copying is not provided here.*

Prove a backup restores, without touching live data (do this monthly):

```sh
scripts/restore.sh --verify latest      # restores into a scratch database, compares row counts, drops it
```

Restore for real (replaces the live database and documents):

```sh
scripts/restore.sh --yes pennbridge-20261028T223000Z   # or: latest
```

It stops app and worker, takes a safety backup of the current state first (that safety set then becomes `latest`), restores, and starts everything. Restoring on a new server: run `install.sh --no-start`, replace the generated `.env` with your saved one, `scripts/pbctl.sh up -d db`, copy the backup files into `backups/`, then `scripts/restore.sh --yes <set>`. The database and documents are captured moments apart; documents are never edited in place, so this is consistent for normal use.

## Upgrade

```sh
cd /opt/pennbridge && git pull
scripts/upgrade.sh
```

Backs up, builds the new image (keeping the old one as `pennbridge-app:prod-previous`), recreates the services, applies pending database migrations on start, and waits for readiness. Roll back the code with `scripts/upgrade.sh --rollback`; if the new version changed the database, also restore the pre-upgrade backup. Migrations are numbered files in `packages/db/migrations`, each applied once in its own transaction under a lock, so concurrent starts are safe; a failing migration is rolled back and stops the start.

## Monitoring: what to poll

| Check | How | Alert when |
|---|---|---|
| Is the site up | `GET https://<domain>/api/health` (no database) | not HTTP 200 |
| Is it working | `GET https://<domain>/api/ready` | HTTP 503 (`down`), or `status` not `ok` |
| Everything at once | `scripts/status.sh` from cron | exit 1 (needs attention) or 2 (down) |

`/api/ready` returns `status` (`ok`, `degraded`, `down`) and `problems` to anyone; signed-in users also get database latency, schema version, queue size, oldest queued job age, dead-letter count, worker last seen and mailbox last poll. Problem codes: `DATABASE_UNREACHABLE`, `WORKER_NO_HEARTBEAT`, `WORKER_STALE` (no heartbeat for 2 minutes), `QUEUE_BACKLOG` (oldest job waiting over 5 minutes), `DEAD_LETTER_JOBS`, `MAILBOX_STALE`, `MAILBOX_ERROR` (credentials rejected or polls failing). `scripts/status.sh` also reports container health, backup age (over 30 hours is a problem) and disk use (over 85%). Logs are JSON, rotated at 5 x 10 MB per container.

## Troubleshooting

- **Site down, `scripts/pbctl.sh ps` shows a service restarting:** `scripts/pbctl.sh logs --tail 100 <service>`. A configuration error prints `Invalid configuration:` followed by each problem.
- **Browser loops back to the login page:** the cookie is `Secure` and you are using plain HTTP, or the clock is wrong.
- **502 right after an upgrade:** wait for `app` to become healthy (about 10 seconds); the proxy retries for 15 seconds on its own.
- **Orders stay queued:** `/api/ready` for `WORKER_*`. `scripts/pbctl.sh logs worker`. The worker survives database restarts by backing off; it exits and is restarted automatically on a crash.
- **Orders arrive with no lines:** live AI is off or not configured, so they need manual entry; or `BUDGET_EXCEEDED` (cap reached, see above).
- **Mailbox shows `MAILBOX_ERROR`:** the app password was rejected or revoked; run `configure_mailbox.py` again after moving the old `runtime/mailbox` away.
- **Certificate not issued:** DNS must resolve to this server and ports 80/443 be reachable; `scripts/pbctl.sh logs proxy`.
- **Locked out of the only administrator:** `scripts/pbctl.sh exec app npx tsx scripts/create_admin.ts --email <address> --reset`.
- **Disk filling:** old backups are pruned after 14 days; `docker system df`; logs are capped.
- **`docker kill` does not restart a container:** Docker treats it as a manual stop. A real crash does restart (verified by killing the worker process).

## Limits of this setup

One server, no high availability. The default model, Odoo hand-off and data handling are as described in the README; this guide covers running the software, not its suitability for your data. Not tested here: Let's Encrypt issuance (only the internal CA), a live IMAP mailbox, Ubuntu package installation of Docker (the script was run with `--no-docker-install` on macOS), offsite backup, and sustained load.
