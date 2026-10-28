#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
for file in config.json password token; do
  if [[ ! -s "runtime/mailbox/$file" ]]; then
    printf 'Missing local mailbox configuration. First run: python3 scripts/configure_mailbox.py\n' >&2
    exit 1
  fi
done
docker compose -f infra/compose.yaml -f infra/mailbox.compose.yaml up -d --build app worker proxy mailbox
printf 'Receiver started. Check readiness with:\n'
printf 'docker compose -f infra/compose.yaml -f infra/mailbox.compose.yaml logs --tail 20 mailbox\n'
