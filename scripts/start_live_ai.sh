#!/usr/bin/env bash
# Opt-in live Gemini extraction in the Docker desk. Only the worker gets egress and the key.
# Optional: EXTRACTION_MODEL=gemini-3.8-flash bash scripts/start_live_ai.sh
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ ! -s runtime/ai/gemini_key ]]; then
  printf 'Missing local Gemini key. First run: python3 scripts/configure_ai.py\n' >&2
  exit 1
fi
export EXTRACTION_MODEL="${EXTRACTION_MODEL:-gemini-3.5-flash-lite}"
# Per-million-token USD; mirrors PRICES in scripts/evaluate_live.ts. Explicit env values win.
case "$EXTRACTION_MODEL" in
  gemini-3.5-flash-lite) in=0.30; out=2.50 ;;
  gemini-3.1-flash-lite) in=0.25; out=1.50 ;;
  gemini-3.8-flash) if [[ "$(date +%F)" < "2027-01-01" ]]; then in=0.75; out=3.75; else in=1.50; out=7.50; fi ;;
  *) printf 'Unsupported EXTRACTION_MODEL: %s\n' "$EXTRACTION_MODEL" >&2; exit 1 ;;
esac
export AI_INPUT_USD_PER_MILLION="${AI_INPUT_USD_PER_MILLION:-$in}"
export AI_OUTPUT_USD_PER_MILLION="${AI_OUTPUT_USD_PER_MILLION:-$out}"
export AI_PRICING_VERSION="${AI_PRICING_VERSION:-$EXTRACTION_MODEL-$(date +%F)}"
files=(-f infra/compose.yaml)
services=(app worker proxy)
if [[ -s runtime/mailbox/config.json && -s runtime/mailbox/password && -s runtime/mailbox/token ]]; then
  files+=(-f infra/mailbox.compose.yaml); services+=(mailbox)
fi
files+=(-f infra/live-ai.compose.yaml)
# Optional direct Odoo push (docs/ODOO-IMPORT.md "Direct push"): enabled when the local key file and the Odoo proof network exist.
if [[ -s runtime/odoo/odoo_api_key ]] && docker network inspect "${ODOO_NETWORK:-pennbridge-odoo-proof_odoo-ingress}" >/dev/null 2>&1; then
  export ODOO_USER="${ODOO_USER:-pennbridge-admin}"; files+=(-f infra/odoo-push.compose.yaml)
fi
docker compose "${files[@]}" up -d --build "${services[@]}"
# nginx caches the old app address after recreation and would return 502.
docker compose "${files[@]}" restart proxy
printf 'Live Gemini extraction on (%s). Header badge should read "Extraction: Gemini live". Return to mock: bash scripts/stop_live_ai.sh\n' "$EXTRACTION_MODEL"
