#!/usr/bin/env bash
# Restore a backup set.
#   scripts/restore.sh --verify  [pennbridge-<stamp>|latest]   restore into a scratch database, compare row counts, drop it (safe, live data untouched)
#   scripts/restore.sh --yes     [pennbridge-<stamp>|latest]   REPLACE the live database and documents with the backup (stops app+worker first,
#                                                              takes a safety backup of the current state before replacing it)
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
mode="${1:-}"; stamp="${2:-latest}"
[[ "$mode" == --verify || "$mode" == --yes ]] || pb_die "usage: restore.sh --verify|--yes [pennbridge-<stamp>|latest]"
dir="$(pb_env PB_BACKUP_DIR "$PB_ROOT/backups")"
if [[ "$stamp" == latest ]]; then stamp="pennbridge-$(cat "$dir/LATEST" 2>/dev/null || true)"; fi
stamp="${stamp%.dump}"
[[ -f "$dir/$stamp.dump" && -f "$dir/$stamp.sha256" ]] || pb_die "backup $stamp not found in $dir (run scripts/backup.sh --list)"
run() { pb_compose run --rm --no-deps -T "$@"; }
if [[ "$mode" == --verify ]]; then
  run --entrypoint /bin/bash backup /ops.sh verify "/backups/$stamp.dump"; exit
fi
echo "Restoring $stamp over the live database and documents."
pb_compose stop app worker mailbox 2>/dev/null || pb_compose stop app worker
echo "Safety backup of the current state first..."
run --entrypoint /bin/bash backup /ops.sh once
if [[ -f "$dir/$stamp.storage.tgz" ]]; then
  run --entrypoint /bin/bash restore /ops.sh restore "/backups/$stamp.dump" "/backups/$stamp.storage.tgz"
else
  run --entrypoint /bin/bash restore /ops.sh restore "/backups/$stamp.dump"
fi
pb_compose up -d
echo "Restored. Check: scripts/status.sh"
