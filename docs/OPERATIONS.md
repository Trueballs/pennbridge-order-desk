# Operations guide

For the person who installs and runs the desk on one Linux server. Exercised on 28-29 October 2026: a throwaway production Compose project (worker crash recovery, app recreation, backup and restore), a full walkthrough of this guide on a simulated fresh Ubuntu 24.04 server (`scripts/test_install_ubuntu.sh`: Docker installation by `install.sh`, first administrator, HTTPS, CSV import, backup, restore, upgrade, reboot) and certificate issuance and renewal against Let's Encrypt's test CA Pebble (`scripts/test_acme.sh`). Items marked *not tested here* were not.

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
sudo git clone <repository> /opt/pennbridge && cd /opt/pennbridge
sudo scripts/install.sh --domain orders.example.co.uk --acme-email you@example.co.uk
```

Run every script in this guide with `sudo` (or from a root shell): `.env` is mode 600 and controlling Docker is root-equivalent, so a plain user gets "run this script with sudo". Add `--acme-staging` to the install to rehearse the certificate first (see Domain and TLS).

The script installs Docker (`docker.io` and `docker-compose-v2` from the Ubuntu repositories, started and enabled at boot) if missing, generates `.env` (database password from `openssl rand`, mode 600), creates `backups/`, `certs/`, `secrets/`, builds the image, starts the stack and waits for readiness. It never overwrites an existing `.env`. Then create the first administrator (the password is read from a hidden prompt or `ADMIN_PASSWORD`, never an argument):

```sh
sudo scripts/pbctl.sh exec app npx tsx scripts/create_admin.ts --email you@example.co.uk --name "Your Name"
```

(For a script, use `exec -T -e ADMIN_PASSWORD app ...` with the variable set: `sudo ADMIN_PASSWORD=... scripts/pbctl.sh exec -T -e ADMIN_PASSWORD app ...`; it keeps the password out of the arguments.) Sign in at `https://orders.example.co.uk`, then load master data (Administration, import templates in `docs/import-templates/`).

`scripts/pbctl.sh` is `docker compose` with the right files and `.env`: `sudo scripts/pbctl.sh ps`, `logs -f worker`, `restart app`. Use it instead of calling Compose directly.

## Domain and TLS

Set at install time with `--tls`, or edit `PB_TLS_MODE` in `.env` and run `scripts/pbctl.sh up -d`.

- `auto` (default): Caddy gets and renews Let's Encrypt certificates itself (HTTP-01 on port 80 or TLS-ALPN-01 on port 443, whichever the CA reaches first). Needs a public DNS name and ports 80/443. Settings in `.env`: `PB_ACME_EMAIL` (expiry notices) and `PB_ACME_CA` (empty = Let's Encrypt production; `staging` = Let's Encrypt staging; or a full ACME directory URL).
- `custom`: put your certificate chain in `certs/fullchain.pem` and key in `certs/privkey.pem`. Restart `proxy` after renewal: `scripts/pbctl.sh restart proxy`.
- `internal`: Caddy's private CA. Only for testing or an internal-only name; browsers warn until the CA (`/data/caddy/pki/authorities/local/root.crt` in the proxy container) is trusted.

**Rehearse with Let's Encrypt staging first, then go live.** Production allows only 5 failed validations per host per hour and 5 duplicate certificates per week, and a typo in DNS burns them quickly. Staging has generous limits and issues certificates browsers do not trust (the browser warning is expected):

```sh
sudo scripts/install.sh --domain orders.example.co.uk --acme-email you@example.co.uk --acme-staging   # or set PB_ACME_CA=staging in .env
sudo scripts/pbctl.sh logs proxy | grep -i 'certificate obtained'                                     # wait for it
# when that works, switch to production:
sudo sed -i 's/^PB_ACME_CA=.*/PB_ACME_CA=/' .env && sudo scripts/pbctl.sh up -d
```

Caddy keeps certificates per CA, so the production certificate is requested fresh when the CA setting changes; nothing needs deleting. `PB_ACME_CA_ROOT` (a PEM path inside the proxy container, for example `/certs/acme-ca-root.pem` with the file in `certs/`) is only for a private ACME server; Let's Encrypt needs none. Renewal is automatic (Caddy renews when a third of the lifetime remains and re-checks at every start); `scripts/test_acme.sh` proves issuance (both challenge types), chain validation and renewal against Pebble.

`internal` mode: to trust the CA on a test machine, `sudo scripts/pbctl.sh cp proxy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt` and import it.

Session cookies are `Secure` by default, so the desk only works over HTTPS (or `localhost`). The proxy overwrites `X-Forwarded-For` and `X-Real-IP` with the real client address, which the login throttle relies on. If you put another proxy or load balancer in front, that breaks the assumption; talk to whoever maintains the code before doing so.

## Mailbox

Use one dedicated shared mailbox (for example `orders@`) with IMAP and an app password. As the installing user, from the checkout:

```sh
python3 scripts/configure_mailbox.py      # writes runtime/mailbox/{config.json,password,token}
scripts/pbctl.sh up -d                    # the mailbox overlay is added automatically when config.json exists
scripts/pbctl.sh logs -f mailbox
```

The receiver only reads (it never marks mail read or deletes). The `subjectPrefix` in `config.json` can be empty to ingest all mail, subject to the receiver's auto-reply and rate filters. Credential rejection raises an alert that shows in readiness and makes the mailbox container unhealthy. See `docs/TEST-INBOX.md` for mailbox details. *Not tested here: a live IMAP connection on the production compose (the dev stack was verified against a real Gmail mailbox on 2026-10-29: docs/evidence/2026-10-29-live-email.md).*

OAuth / Microsoft 365 / Google Workspace: see docs/MAILBOX-SETUP.md

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
| `PB_ACME_EMAIL`, `PB_ACME_CA`, `PB_ACME_CA_ROOT` | Let's Encrypt contact address; CA (`staging`, a directory URL, or empty for production); trusted root of a private ACME server |
| `POSTGRES_PASSWORD` | Generated; only hex characters (it is embedded in a URL). Changing it later means changing it inside PostgreSQL too |
| `PB_BACKUP_DIR`, `PB_CERT_DIR`, `PB_SECRETS_DIR`, `PB_MAILBOX_DIR` | Host folders |
| `BACKUP_RETAIN_DAYS`, `BACKUP_HOUR_UTC`, `BACKUP_MINUTE_UTC` | Backup schedule (default 02:30 UTC, 14 days, never fewer than 3 sets) |
| `LIVE_AI_ENABLED`, `AI_*`, `EXTRACTION_MODEL` | Live extraction and budgets |
| `PB_BIND`, `PB_HTTP_PORT`, `PB_HTTPS_PORT` | Published address and ports (test setups) |

The app validates its configuration at start and refuses to run with a missing, default or short (under 16 characters) database password, or incomplete live-AI settings. The message lists every problem.

## Backups and restore

The `backup` service writes to `backups/` every night: a PostgreSQL custom-format dump, a tar of the documents volume and a SHA-256 file, and checks the dump is readable. Run one now with `sudo scripts/backup.sh` (`--list` to see them). **Copy `backups/` and `.env` off the server** (a second machine or object storage); backups on the same disk do not survive losing the server. *Offsite copying is not provided here.*

Prove a backup restores, without touching live data (do this monthly):

```sh
sudo scripts/restore.sh --verify latest      # restores into a scratch database, compares row counts, drops it
```

Restore for real (replaces the live database and documents):

```sh
sudo scripts/restore.sh --yes pennbridge-20261028T223000Z   # or: latest
```

It stops app and worker, takes a safety backup of the current state first (that safety set then becomes `latest`), restores, and starts everything. Restoring on a new server: run `install.sh --no-start`, replace the generated `.env` with your saved one, `sudo scripts/pbctl.sh up -d db`, copy the backup files into `backups/`, then `sudo scripts/restore.sh --yes <set>`. The database and documents are captured moments apart; documents are never edited in place, so this is consistent for normal use.

## Upgrade

```sh
cd /opt/pennbridge && sudo git pull
sudo scripts/upgrade.sh
```

Backs up, builds the new image (keeping the old one as `pennbridge-app:prod-previous`), recreates the services, applies pending database migrations on start, and waits for readiness. Roll back the code with `sudo scripts/upgrade.sh --rollback`; if the new version changed the database, also restore the pre-upgrade backup. Migrations are numbered files in `packages/db/migrations`, each applied once in its own transaction under a lock, so concurrent starts are safe; a failing migration is rolled back and stops the start.

## Monitoring: what to poll

| Check | How | Alert when |
|---|---|---|
| Is the site up | `GET https://<domain>/api/health` (no database) | not HTTP 200 |
| Is it working | `GET https://<domain>/api/ready` | HTTP 503 (`down`), or `status` not `ok` |
| Everything at once | `sudo scripts/status.sh` from root's cron | exit 1 (needs attention) or 2 (down) |

`/api/ready` returns `status` (`ok`, `degraded`, `down`) and `problems` to anyone; signed-in users also get database latency, schema version, queue size, oldest queued job age, dead-letter count, worker last seen and mailbox last poll. Problem codes: `DATABASE_UNREACHABLE`, `WORKER_NO_HEARTBEAT`, `WORKER_STALE` (no heartbeat for 2 minutes), `QUEUE_BACKLOG` (oldest job waiting over 5 minutes), `DEAD_LETTER_JOBS`, `MAILBOX_STALE`, `MAILBOX_ERROR` (credentials rejected or polls failing). `scripts/status.sh` also reports container health, backup age (over 30 hours is a problem) and disk use (over 85%). Logs are JSON, rotated at 5 x 10 MB per container.

## Troubleshooting

- **Site down, `scripts/pbctl.sh ps` shows a service restarting:** `scripts/pbctl.sh logs --tail 100 <service>`. A configuration error prints `Invalid configuration:` followed by each problem.
- **Browser loops back to the login page:** the cookie is `Secure` and you are using plain HTTP, or the clock is wrong.
- **502 right after an upgrade:** wait for `app` to become healthy (about 10 seconds); the proxy retries for 15 seconds on its own.
- **Orders stay queued:** `/api/ready` for `WORKER_*`. `scripts/pbctl.sh logs worker`. The worker survives database restarts by backing off; it exits and is restarted automatically on a crash.
- **Orders arrive with no lines:** live AI is off or not configured, so they need manual entry; or `BUDGET_EXCEEDED` (cap reached, see above).
- **Mailbox shows `MAILBOX_ERROR`:** the app password was rejected or revoked; run `configure_mailbox.py` again after moving the old `runtime/mailbox` away.
- **Certificate not issued:** DNS must resolve to this server and ports 80/443 be reachable from the internet (also from IPv6 if you publish an AAAA record); `sudo scripts/pbctl.sh logs proxy`. Caddy retries with growing delays; rehearse with `--acme-staging` to avoid Let's Encrypt's failure limits.
- **Locked out of the only administrator:** `scripts/pbctl.sh exec app npx tsx scripts/create_admin.ts --email <address> --reset`.
- **Disk filling:** old backups are pruned after 14 days; `docker system df`; logs are capped.
- **`docker kill` does not restart a container:** Docker treats it as a manual stop. A real crash does restart (verified by killing the worker process).

## After a reboot

Docker is enabled at boot and every service has `restart: unless-stopped`, so the desk comes back by itself in about a minute (verified by restarting a simulated Ubuntu server). Check with `sudo scripts/status.sh`. A service you stopped on purpose with `pbctl.sh stop` stays stopped.

## Limits of this setup

One server, no high availability. The default model, Odoo hand-off and data handling are as described in the README; this guide covers running the software, not its suitability for your data. Not tested here: issuance from the real Let's Encrypt (Pebble, its official test server, was used; DNS and the internet path to your server are yours to check, hence the staging rehearsal), a real Microsoft 365 tenant or Google Workspace delegation (Gmail IMAP with an app password and with OAuth2 refresh token were verified live), a physical or cloud Ubuntu host (the simulated server is a privileged container with systemd, arm64), offsite backup, and sustained load.
