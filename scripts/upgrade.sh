#!/usr/bin/env bash
# Upgrade to the code in this checkout: back up, rebuild the image, recreate services (migrations run on start), wait for readiness.
# Roll back: scripts/upgrade.sh --rollback  (re-tags the previous image; restore the pre-upgrade backup too if the database changed).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
if [[ "${1:-}" == --rollback ]]; then
  docker image inspect pennbridge-app:prod-previous >/dev/null 2>&1 || pb_die "no previous image to roll back to"
  docker tag pennbridge-app:prod-previous pennbridge-app:prod
  pb_compose up -d --no-build; exit
fi
echo "1/4 backup"; "$PB_ROOT/scripts/backup.sh"
echo "2/4 build"
docker image inspect pennbridge-app:prod >/dev/null 2>&1 && docker tag pennbridge-app:prod pennbridge-app:prod-previous || true
pb_compose build app
echo "3/4 recreate"; pb_compose up -d --remove-orphans
echo "4/4 wait for readiness"
for _ in $(seq 1 60); do pb_ready_json >/dev/null 2>&1 && { pb_ready_json; echo; echo "Upgrade complete."; exit 0; }; sleep 3; done
pb_ready_json || true
pb_die "not ready after 3 minutes; see: scripts/pbctl.sh logs --tail 100 app worker"
