#!/bin/bash
# Runs inside the postgres:17 image (pg_dump, pg_restore, tar). Subcommands: loop | once | list | restore <dump> [storage-tar] | verify <dump>
set -euo pipefail
BACKUPS=/backups
RETAIN_DAYS="${BACKUP_RETAIN_DAYS:-14}"
RETAIN_MIN="${BACKUP_RETAIN_MIN:-3}"
log() { printf '{"event":"backup.%s","detail":"%s"}\n' "$1" "${2:-}"; }
export PGHOST="${PGHOST:-db}" PGUSER="${PGUSER:-pennbridge}" PGDATABASE="${PGDATABASE:-pennbridge}"

do_backup() {
  local ts base; ts="$(date -u +%Y%m%dT%H%M%SZ)"; base="$BACKUPS/pennbridge-$ts"
  umask 077
  pg_dump --format=custom --no-owner --file="$base.dump.partial"
  mv "$base.dump.partial" "$base.dump"
  # Documents are immutable files; the archive is taken right after the dump, so every database reference has its file.
  tar -C /storage -czf "$base.storage.tgz.partial" .
  mv "$base.storage.tgz.partial" "$base.storage.tgz"
  (cd "$BACKUPS" && sha256sum "pennbridge-$ts.dump" "pennbridge-$ts.storage.tgz" > "pennbridge-$ts.sha256")
  # Prove the dump is readable before trusting it.
  pg_restore --list "$base.dump" > /dev/null
  echo "$ts" > "$BACKUPS/LATEST"
  log done "$ts"
  prune
}
prune() {
  # Keep at least RETAIN_MIN backups; delete sets older than RETAIN_DAYS beyond that.
  local sets; mapfile -t sets < <(ls -1 "$BACKUPS" | grep -E '^pennbridge-.*\.dump$' | sort -r)
  local i=0 f
  for f in "${sets[@]}"; do
    i=$((i+1)); [ "$i" -le "$RETAIN_MIN" ] && continue
    if [ -n "$(find "$BACKUPS/$f" -mtime +"$RETAIN_DAYS" -print)" ]; then
      local stem="${f%.dump}"; rm -f "$BACKUPS/$stem.dump" "$BACKUPS/$stem.storage.tgz" "$BACKUPS/$stem.sha256"; log pruned "$stem"
    fi
  done
}
check_sums() { (cd "$BACKUPS" && sha256sum --check "$(basename "${1%.dump}").sha256" >/dev/null) || { echo "Checksum mismatch for $1" >&2; exit 1; }; }

case "${1:-}" in
  loop)
    hour="${BACKUP_HOUR_UTC:-02}"; minute="${BACKUP_MINUTE_UTC:-30}"
    log started "daily at ${hour}:${minute} UTC, keep ${RETAIN_DAYS} days"
    while true; do
      now=$(date -u +%s); target=$(date -u -d "today ${hour}:${minute}" +%s)
      [ "$target" -le "$now" ] && target=$(date -u -d "tomorrow ${hour}:${minute}" +%s)
      sleep $((target-now))
      until do_backup; do log failed "retrying in 15 minutes"; sleep 900; done
    done ;;
  once) do_backup ;;
  list) ls -lh "$BACKUPS" ;;
  verify)
    # Restore into a scratch database and compare per-table row counts with the live one. Never touches the live database.
    dump="$2"; check_sums "$dump"; scratch="verify_$(date -u +%Y%m%d%H%M%S)"
    createdb "$scratch"; trap 'dropdb --if-exists --force "$scratch"' EXIT
    pg_restore --dbname="$scratch" --no-owner --exit-on-error "$dump"
    q="SELECT string_agg(relname||'='||n_live, ',' ORDER BY relname) FROM (SELECT relname, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I', relname), false, true, '')))[1]::text::bigint AS n_live FROM pg_class WHERE relkind='r' AND relnamespace='public'::regnamespace) t"
    restored="$(psql -XAt -d "$scratch" -c "$q")"; live="$(psql -XAt -c "$q")"
    echo "restored: $restored"; echo "live:     $live"
    [ -n "$restored" ] || { echo "Restored database has no tables" >&2; exit 1; }
    log verified "$(basename "$dump") restored into $scratch"
    [ "$restored" = "$live" ] && echo "Row counts match the live database." || echo "Row counts differ from the live database (expected if data changed since the backup)." ;;
  restore)
    # Destructive: replaces the live database (and documents if a storage archive is given). The wrapper stops app/worker first.
    dump="$2"; storage="${3:-}"; check_sums "$dump"
    dropdb --if-exists --force "$PGDATABASE"; createdb "$PGDATABASE"
    pg_restore --dbname="$PGDATABASE" --no-owner --exit-on-error "$dump"
    if [ -n "$storage" ]; then find /storage -mindepth 1 -delete; tar -C /storage -xzf "$storage"; fi
    log restored "$(basename "$dump")" ;;
  *) echo "usage: ops.sh loop|once|list|verify <dump>|restore <dump> [storage.tgz]" >&2; exit 2 ;;
esac
