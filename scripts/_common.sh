#!/usr/bin/env bash
# Shared helpers for the production scripts. Source this; do not run it.
PB_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PB_PROJECT="${PB_PROJECT:-pennbridge}"
PB_ENV_FILE="${PB_ENV_FILE:-$PB_ROOT/.env}"

pb_die() { printf 'error: %s\n' "$*" >&2; exit 1; }
pb_env() { # pb_env NAME [default]: read a value from the env file
  local v; v="$(grep -E "^$1=" "$PB_ENV_FILE" 2>/dev/null | tail -n1 | cut -d= -f2-)"; printf '%s' "${v:-${2:-}}"
}
# Runs `docker compose` against the production files plus the overlays the current .env calls for.
pb_compose() {
  [[ -f "$PB_ENV_FILE" ]] || pb_die "no $PB_ENV_FILE; run scripts/install.sh first"
  local files=(-f "$PB_ROOT/infra/compose.prod.yaml")
  [[ "$(pb_env LIVE_AI_ENABLED false)" == true ]] && files+=(-f "$PB_ROOT/infra/compose.prod.live-ai.yaml")
  [[ -f "$(pb_env PB_MAILBOX_DIR "$PB_ROOT/runtime/mailbox")/config.json" ]] && files+=(-f "$PB_ROOT/infra/compose.prod.mailbox.yaml")
  docker compose -p "$PB_PROJECT" --env-file "$PB_ENV_FILE" "${files[@]}" "$@"
}
# Prints /api/ready from inside the app container (the only way in that needs no DNS, certificate or open port).
pb_ready_json() {
  pb_compose exec -T app node -e "fetch('http://127.0.0.1:3087/api/ready',{signal:AbortSignal.timeout(5000)}).then(async r=>{console.log(await r.text());process.exit(r.status===200?0:2)},e=>{console.log(JSON.stringify({status:'down',problems:['APP_UNREACHABLE']}));process.exit(2)})"
}
