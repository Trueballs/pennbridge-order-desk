#!/usr/bin/env bash
# Take a backup now (database dump + documents archive + checksums) into PB_BACKUP_DIR. The nightly job in the `backup` service does the same.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
if [[ "${1:-}" == --list ]]; then pb_compose run --rm --no-deps -T --entrypoint /bin/bash backup /ops.sh list; exit; fi
pb_compose run --rm --no-deps -T --entrypoint /bin/bash backup /ops.sh once
