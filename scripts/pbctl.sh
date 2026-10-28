#!/usr/bin/env bash
# Thin wrapper: scripts/pbctl.sh ps | logs -f worker | up -d | restart app | exec app sh ...
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
pb_compose "$@"
