#!/usr/bin/env bash
# One-shot health summary for cron/monitoring. Exit 0 = ok, 1 = degraded (something needs attention), 2 = down.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
code=0
bad() { echo "PROBLEM: $*"; [[ ${code} -lt ${2:-1} ]] && code=${2:-1}; }
echo "== containers"; pb_compose ps
for svc in db app worker proxy backup; do
  st="$(pb_compose ps --format '{{.State}}/{{.Health}}' "$svc" 2>/dev/null | head -n1)"
  [[ "$st" == running/healthy || "$st" == running/ ]] || bad "$svc is $st" 2
done
echo "== readiness"; out="$(pb_ready_json)"; rc=$?; echo "$out"
[[ $rc -eq 0 ]] || bad "readiness endpoint says not ok" 2
echo "$out" | grep -q '"problems":\[\]' || bad "readiness reports problems (see above)" 1
echo "== backups"
dir="$(pb_env PB_BACKUP_DIR "$PB_ROOT/backups")"
if [[ -f "$dir/LATEST" ]]; then
  latest="$(ls -1t "$dir"/pennbridge-*.dump 2>/dev/null | head -n1)"
  age=$(( ( $(date +%s) - $(stat -c %Y "$latest" 2>/dev/null || stat -f %m "$latest") ) / 3600 ))
  echo "latest: $(cat "$dir/LATEST"), ${age}h old"; [[ $age -le 30 ]] || bad "newest backup is ${age}h old" 1
else bad "no backup has been taken yet" 1; fi
echo "== disk"; df -h "$dir" | tail -n1; used=$(df -P "$dir" | awk 'NR==2{gsub("%","",$5);print $5}'); [[ $used -lt 85 ]] || bad "disk ${used}% full" 1
exit $code
