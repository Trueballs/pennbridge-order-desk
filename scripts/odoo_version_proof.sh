#!/usr/bin/env bash
# Prove the Odoo integration (CSV import + direct JSON-RPC push) on one Odoo Community version.
#   bash scripts/odoo_version_proof.sh 17|18   starts an isolated stack (project pennbridge-odoo<ver>), installs sale_management,
#                                              seeds the master data, runs both paths, then removes containers, volumes and image.
#   bash scripts/odoo_version_proof.sh 19      runs both paths against the EXISTING Odoo 19 proof stack (pennbridge-odoo-proof);
#                                              it only adds test quotations and never stops or removes anything.
# Env: KEEP=1 keeps a 17/18 stack running afterwards (web on 127.0.0.1:8117 / 8118); SKIP_SEED=1 reuses an already seeded stack.
# Evidence: results/odoo/versions/odoo<ver>.json and .log. Synthetic data only; the local login/password are disposable.
set -euo pipefail
cd "$(dirname "$0")/.."
VER="${1:-}"
case "$VER" in
  17) IMAGE="odoo:17.0@sha256:8779f8157ddcc37b84014c94646073f46fd4ad776b7a5d95fc3b0dc73a24a8fa"; PORT=8117 ;;
  18) IMAGE="odoo:18.0@sha256:9668abacd894276ed009e8db7db1d1ffb8068af6982f76a3400ed0d68e40432d"; PORT=8118 ;;
  19) PORT=8067 ;;
  *) echo "usage: $0 17|18|19" >&2; exit 2 ;;
esac
OUT=results/odoo/versions; mkdir -p "$OUT"
LOG="$OUT/odoo$VER.log"; : > "$LOG"
if [ "$VER" = 19 ]; then COMPOSE=(docker compose -f infra/odoo.compose.yaml)
else export ODOO_VERSION="$VER" ODOO_IMAGE="$IMAGE" ODOO_PORT="$PORT"; COMPOSE=(docker compose -f infra/odoo-version.compose.yaml); fi
shell() { "${COMPOSE[@]}" run --rm -T odoo odoo shell --database=pennbridge --no-http; }   # reads the script on stdin
marker() { grep -h "^$1=" | tail -1 | cut -d= -f2-; }
KEYFILE="$(mktemp)"; chmod 600 "$KEYFILE"
cleanup() {
  rm -f "$KEYFILE"
  if [ "$VER" != 19 ] && [ "${KEEP:-0}" != 1 ]; then
    echo "== cleanup: removing project pennbridge-odoo$VER (containers, volumes, image)" | tee -a "$LOG"
    "${COMPOSE[@]}" down -v --remove-orphans >>"$LOG" 2>&1 || true
    docker rmi "${IMAGE%%:*}@${IMAGE##*@}" >>"$LOG" 2>&1 || true   # pulled by digest, so there is no tag to remove
  fi
}
trap cleanup EXIT

if [ "$VER" != 19 ]; then
  echo "== start Odoo $VER ($IMAGE)" | tee -a "$LOG"
  "${COMPOSE[@]}" up -d odoo-db >>"$LOG" 2>&1
  if [ "${SKIP_SEED:-0}" != 1 ]; then
    "${COMPOSE[@]}" run --rm -T odoo odoo --database=pennbridge --init=sale_management --without-demo=all --stop-after-init >>"$LOG" 2>&1
    shell < infra/odoo/version_setup.py >>"$LOG" 2>&1
    echo "== master seed" | tee -a "$LOG"
    shell < infra/odoo/seed_master.py > "$OUT/odoo$VER-master-seed.log" 2>&1
    marker PENNBRIDGE_MASTER < "$OUT/odoo$VER-master-seed.log" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps({k:v for k,v in d.items() if k not in ("catalogue","accounts")}))' > "$OUT/odoo$VER-master.json"
    shell < infra/odoo/check_master.py 2>&1 | marker PENNBRIDGE_MASTER_CHECK > "$OUT/odoo$VER-master-check.json"
    cat "$OUT/odoo$VER-master-check.json" | tee -a "$LOG"
  fi
  "${COMPOSE[@]}" up -d odoo-web >>"$LOG" 2>&1
  up=0; for _ in $(seq 1 90); do curl -fsS -o /dev/null "http://127.0.0.1:$PORT/web/login" 2>/dev/null && { up=1; break; }; sleep 2; done
  [ "$up" = 1 ] || { echo "Odoo $VER did not come up on 127.0.0.1:$PORT" >&2; exit 1; }
fi

echo "== CSV path (desk renderOdooCsv -> base_import Test, Import, re-import)" | tee -a "$LOG"
npx tsx scripts/odoo_version_tools.ts csv "$VER" "$OUT/odoo$VER-desk.csv"
{ echo "CSV_B64 = '$(base64 < "$OUT/odoo$VER-desk.csv" | tr -d '\n')'"; cat infra/odoo/version_csv_proof.py; } | shell > "$OUT/odoo$VER-csv.raw" 2>&1 || { tail -30 "$OUT/odoo$VER-csv.raw"; exit 1; }
CSV_JSON="$(marker PENNBRIDGE_VERSION_CSV < "$OUT/odoo$VER-csv.raw")"; echo "$CSV_JSON" | tee -a "$LOG"

echo "== Push path (pushQuotation from the host via 127.0.0.1:$PORT, twice)" | tee -a "$LOG"
printf '%s' 'pennbridge-local-admin-only' > "$KEYFILE"
PUSH_JSON="$(npx tsx scripts/odoo_version_tools.ts push "$VER" "http://127.0.0.1:$PORT" pennbridge pennbridge-admin "$KEYFILE")"; echo "$PUSH_JSON" | tee -a "$LOG"
{ echo "ORIGIN = 'pennbridge:quote_versionproof_push_${VER}_v1'"; cat infra/odoo/version_push_readback.py; } | shell > "$OUT/odoo$VER-push.raw" 2>&1 || { tail -30 "$OUT/odoo$VER-push.raw"; exit 1; }
READ_JSON="$(marker PENNBRIDGE_VERSION_PUSH < "$OUT/odoo$VER-push.raw")"; echo "$READ_JSON" | tee -a "$LOG"

python3 - "$VER" "$CSV_JSON" "$PUSH_JSON" "$READ_JSON" "$OUT/odoo$VER.json" <<'PY'
import json, sys
ver, csv_j, push_j, read_j, out = sys.argv[1:]
csv_r, push_r, read_r = json.loads(csv_j), json.loads(push_j), json.loads(read_j)
checks = {
  'csv_total_61_40': abs(csv_r['untaxed'] - 61.40) < 0.005 and abs(csv_r['total'] - 61.40) < 0.005,
  'csv_reimport_idempotent': csv_r['reimport_same_lines'] and csv_r['id'] == csv_r['import_ids'][0] == csv_r['repeat_ids'][0],
  'push_created_then_idempotent': push_r['first']['created'] is True and push_r['second']['created'] is False and push_r['first']['id'] == push_r['second']['id'],
  'push_total_matches': push_r['first']['totalMatches'] is True,
  'push_single_quotation_draft': read_r['count_with_origin'] == 1 and read_r['state'] == 'draft' and abs(read_r['untaxed'] - 61.40) < 0.005,
}
result = {'odoo': ver, 'csv': csv_r, 'push': push_r, 'push_readback': read_r, 'checks': checks}
open(out, 'w').write(json.dumps(result, indent=2) + '\n')
print(json.dumps(checks)); sys.exit(0 if all(checks.values()) else 1)
PY
echo "== Odoo $VER proof OK ($OUT/odoo$VER.json)" | tee -a "$LOG"
