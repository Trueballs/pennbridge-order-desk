#!/usr/bin/env bash
# Return to mock mode: recreate app/worker from the base file (plus mailbox if configured), without the key or egress.
set -euo pipefail
cd "$(dirname "$0")/.."
files=(-f infra/compose.yaml)
services=(app worker proxy)
if [[ -s runtime/mailbox/config.json && -s runtime/mailbox/password && -s runtime/mailbox/token ]]; then
  files+=(-f infra/mailbox.compose.yaml); services+=(mailbox)
fi
docker compose "${files[@]}" up -d --build "${services[@]}"
docker compose "${files[@]}" restart proxy
printf 'Mock mode restored. The key file in runtime/ai/ is kept; delete it to remove the key.\n'
