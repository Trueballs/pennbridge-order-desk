# Local system checks — 28 October 2026

The recreated `pennbridge-dev` stack passed the bounded checks below on 28 October 2026, 19:55:51–19:56:06 UTC, with storage restore verification added at 19:59:47–19:59:53 UTC. These checks used synthetic local accounts and mock processing. No paid model API or real account was used, and no existing order was changed.

Reproduce with `python3 -u scripts/system_checks.py` from the project root while the local stack is running. The script requires Docker access and the default synthetic demo passwords. Keep the app free of mutations during the short backup/fingerprint phase; concurrent writes cause that check to fail instead of reporting a false match. Each run creates a uniquely named test database and a timestamped result directory. It does not overwrite, drop, or stop the live database or worker.

The measured artifact is `results/system-checks/20261028_195551/result.json`; the synthetic database archive is alongside it as `pennbridge.dump`, and document storage as `document-storage.tar`. Generated results are ignored by Git. To extend an existing successful database check without repeating load checks, run `python3 -u scripts/system_checks.py --storage-only results/system-checks/20261028_195551`.

| Check | Observed result |
|---|---|
| Stack | App, worker, PostgreSQL, Mailpit, and proxy running; PostgreSQL and Mailpit healthy. Health endpoint returned HTTP 200 and `mode: mock`. |
| Host bindings | Only proxy ports 3087 and 8027 published, both on `127.0.0.1`. No database port published. App and worker attached only to the private network. |
| Catalogue | PostgreSQL contained 10,000 products, including 8,000 active products. |
| Viewer permissions | Authenticated viewer intake, edit, approve, export, and job retry requests all returned HTTP 403 / `FORBIDDEN`. Nonexistent resource IDs confirmed authorization runs before lookup; no mutation was committed. |
| Catalogue HTTP load | 100 successful authenticated exact-SKU lookups at concurrency 10; one preceding warm-up excluded. Ten known SKUs repeated through the seeded 10,000-product catalogue. |
| Lookup timing | Total measured wall time 0.487 s; 205.19 requests/s; minimum 15.16 ms, median 24.22 ms, p95 257.36 ms, maximum 277.29 ms. These include local proxy, application, and database response time. |
| Backup and restore | A 2,547,978-byte custom-format `pg_dump` restored without error into new database `pennbridge_system_test_20261028_195551`. Row counts and sorted row-content MD5 fingerprints matched for all 22 public tables. Source fingerprints remained unchanged throughout comparison. |
| Document storage restore | Read-only archive of `pennbridge-dev_desk-storage` restored into new volume `pennbridge-system-storage-test-20261028_195947-1900a4cb`. All four files matched by SHA-256, size, mode, UID, and GID; source stayed unchanged. Files totalled 11,015 bytes; archive size was 20,480 bytes. All three original database document references resolved with matching content hashes. The fourth file is the retained original intake copy. |
| Worker recovery | In the isolated restored database, a short-lived Node processing process claimed a synthetic CSV job with a one-second durable lease, then was killed with `SIGKILL` (exit 137). A replacement process reclaimed the same job at attempt 2 and completed the real CSV ingestion/validation pipeline. Exactly one order and zero exports existed for that job. |
| Stale owner | After reclaim, the old owner could not heartbeat; replayed processing under that owner failed with `STALE_VERSION`. Job remained `succeeded`. |
| Worker network | From the actual running worker container, internal app health returned HTTP 200. External TCP to `1.1.1.1:443` failed with `ENETUNREACH`; HTTPS to `https://example.com` failed with `EAI_AGAIN`. |

Database archive SHA-256: `646b1dbf0c90a4100e87ca1becba0c6c414b912a246e4ec366186fc08ff69aa0`.

Storage archive SHA-256: `92e11c22e5fb8e3306739985f5d44963c1ef138fb6ec2eafbd88bbd55e357773`.

The restore database remains available for inspection. Recovery intentionally added one new synthetic order only in that isolated copy. Its temporary document files are under `/tmp/pennbridge_system_test_20261028_195551_storage` in the app container; live document storage was not used by the recovery test.

## Restore recipe

The automated script performs and verifies both restore steps, retaining the new database and volume. For a manual restore from the recorded archives, use fresh names and run from the project root:

```sh
set -eu
task_restore_db="pennbridge_restore_test_$(date -u +%Y%m%d_%H%M%S)"
task_restore_volume="pennbridge-restore-storage-test-$(date -u +%Y%m%d_%H%M%S)"
task_backup_dir="results/system-checks/20261028_195551"
docker compose -f infra/compose.yaml exec -T db createdb -U pennbridge "$task_restore_db"
docker compose -f infra/compose.yaml exec -T db pg_restore \
  -U pennbridge -d "$task_restore_db" --exit-on-error --no-owner \
  < "$task_backup_dir/pennbridge.dump"
if docker volume inspect "$task_restore_volume" >/dev/null 2>&1; then
  echo "Choose an unused restore volume name." >&2
  exit 1
fi
docker volume create "$task_restore_volume"
docker run --rm -i --network none --user 0:0 --entrypoint tar \
  -v "$task_restore_volume:/restore" pennbridge-app:local \
  -C /restore -xf - < "$task_backup_dir/document-storage.tar"
```

When starting a separately configured restored app, point its database URL at that new database and mount the new volume at `/app/runtime/storage`, matching the stored document paths. Keep live AI disabled and give any restored web service a separate localhost port. The archive restores node-owned files with mode 0600. Never replace the original volume or point the running app at the restored database during this check.

## Practical limits

Database and document volume restore were both checked. They were captured at separate times, with unchanged source fingerprints during each capture. Every original database document reference was checked against the later restored volume; this succeeds here because document files are immutable. A deployment with deletion or in-place changes needs a coordinated quiescent database/storage snapshot. A separately booted restored web application was not tested. Mailpit, Odoo, Docker configuration, and runtime secrets are not part of these archives. The isolated recovery test's extra temporary document is outside the source snapshot and is not included in the storage archive.

The crash test killed a short-lived processing process against the isolated database. It exercised durable lease reclaim, normal structured processing, stale-owner rejection, and order uniqueness. It did not stop the shared live worker container or kill a process during an external API request or export transaction. Separate lifecycle tests cover approval/export idempotency.

The timing result is one short localhost sample of exact indexed lookups over ten repeated SKUs. It does not measure fuzzy search, distinct-query cold-cache performance, PDF throughput, sustained load, live AI, or production capacity. The two outbound probes show those attempted destinations failed in the current worker network; they are not an exhaustive firewall audit. Restore tables with no rows at snapshot time, including approvals and exports, matched as empty tables.
