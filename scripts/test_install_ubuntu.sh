#!/usr/bin/env bash
# Walks docs/OPERATIONS.md on a simulated fresh Ubuntu 24.04 server: a privileged container running systemd and (after install.sh installs it) its own dockerd.
#   scripts/test_install_ubuntu.sh [--keep] [--skip-reboot]
# Steps: git clone -> install.sh (installs Docker from Ubuntu's repositories, builds, starts) -> create_admin -> HTTPS health/ready/login -> CSV import ->
#        backup -> restore --verify -> real restore -> git pull + upgrade.sh -> status.sh -> "reboot" (restart the container; systemd and Docker must bring the stack back alone).
# Needs ~8 GB of Docker disk and 10-20 minutes (the image is built inside the "server"). Everything is named pb-ubuntu-*; --keep leaves it for inspection.
# Harness-only workaround: Docker Desktop cannot unpack image layers with Ubuntu's default containerd image store when nested, so daemon.json selects overlay2 before install.sh runs.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
C=pb-ubuntu-test; BASE=pb-ubuntu-server-base; VOL=pb-ubuntu-docker; DOMAIN=orders.pennbridge.test; PW='Correct-horse-battery-9'; ADMIN=admin@orders.test
keep=0; reboot=1
for a in "$@"; do case "$a" in --keep) keep=1;; --skip-reboot) reboot=0;; -h|--help) sed -n 2,7p "$0"; exit 0;; *) echo "unknown option $a" >&2; exit 1;; esac; done
fails=0; WORK="$(mktemp -d)"
log() { printf '\n== %s\n' "$*"; }
ok() { printf '  ok   %s\n' "$*"; }
bad() { printf '  FAIL %s\n' "$*"; fails=$((fails+1)); }
checkx() { local what="$1"; if ( set +o pipefail; eval "$2" ); then ok "$what"; else bad "$what"; fi; }
check() { local what="$1"; shift; if "$@"; then ok "$what"; else bad "$what"; fi; }
S() { docker exec -u ubuntu -w /opt/pennbridge "$C" bash -c "$1"; }        # run as the ordinary 'ubuntu' admin user inside the server
cleanup() {
  [[ $keep -eq 1 ]] && { echo "kept container $C (volume $VOL, image $BASE)"; rm -rf "$WORK"; return; }
  docker rm -f -v "$C" >/dev/null 2>&1 || true; docker volume rm -f "$VOL" >/dev/null 2>&1 || true; docker rmi -f "$BASE" >/dev/null 2>&1 || true; rm -rf "$WORK"
}
trap cleanup EXIT
https() { local path="$1"; shift; S "curl -sS --cacert /var/tmp/caddy-root.crt --resolve $DOMAIN:443:127.0.0.1 $* https://$DOMAIN$path"; }
rows() { S "sudo scripts/pbctl.sh exec -T db psql -U pennbridge -d pennbridge -tAc \"select count(*) from $1\""; }
wait_https() { for _ in $(seq 1 $((${1:-60}))); do [[ "$(https /api/health "-o /dev/null -w %{http_code}" 2>/dev/null || true)" == 200 ]] && return 0; sleep 3; done; return 1; }
wait_systemd() { for _ in $(seq 1 60); do docker exec "$C" systemctl is-system-running 2>/dev/null | grep -qE 'running|degraded' && return 0; sleep 2; done; return 1; }

log "build and boot the simulated server (Ubuntu 24.04 + systemd, no Docker yet)"
docker rm -f -v "$C" >/dev/null 2>&1 || true; docker volume rm -f "$VOL" >/dev/null 2>&1 || true
mkdir -p "$WORK/img"; cat > "$WORK/img/Dockerfile" <<'DOCKER'
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends systemd systemd-sysv dbus sudo ca-certificates curl git jq iproute2 iptables kmod procps && rm -rf /var/lib/apt/lists/* \
 && echo 'ubuntu ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/ubuntu
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
DOCKER
docker build -q -t "$BASE" "$WORK/img" >/dev/null
docker run -d --name "$C" --hostname pbserver --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw -v "$VOL:/var/lib/docker" --tmpfs /run --tmpfs /run/lock "$BASE" >/dev/null
check "systemd is up" wait_systemd
docker exec "$C" bash -c 'mkdir -p /etc/docker && echo "{\"features\":{\"containerd-snapshotter\":false}}" > /etc/docker/daemon.json'
checkx "Docker is not installed yet" "! docker exec $C bash -c 'command -v docker' >/dev/null"

log "git clone of the repository (docs: git clone <repository> /opt/pennbridge)"
( cd "$ROOT" && git ls-files -co --exclude-standard -z | tar --null -T - -cf "$WORK/src.tar" )
docker cp "$WORK/src.tar" "$C:/tmp/src.tar"
docker exec -u ubuntu "$C" bash -c 'mkdir -p ~/src && tar -C ~/src -xf /tmp/src.tar && cd ~/src && git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm "release 1"'
docker exec -u ubuntu -w /opt "$C" sudo git clone -q /home/ubuntu/src /opt/pennbridge
docker exec "$C" bash -c 'git config --system --add safe.directory "*"'
ok "cloned to /opt/pennbridge"

log "sudo scripts/install.sh --domain $DOMAIN --tls internal"
S "sudo scripts/install.sh --domain $DOMAIN --tls internal --acme-email ops@example.org" > "$WORK/install.log" 2>&1 || { tail -30 "$WORK/install.log"; bad "install.sh failed"; }
tail -8 "$WORK/install.log" | cut -c1-200
check "install.sh installed Docker from the Ubuntu repositories" docker exec "$C" bash -c 'docker --version && docker compose version'
check ".env is mode 600 and has the ACME settings" S 'sudo test "$(sudo stat -c %a .env)" = 600 && sudo grep -q "^PB_ACME_EMAIL=ops@example.org" .env'
checkx "re-running install.sh keeps .env" "S 'sudo md5sum .env' > $WORK/m1; S 'sudo scripts/install.sh --domain $DOMAIN --tls internal >/dev/null 2>&1; sudo md5sum .env' > $WORK/m2; cmp -s $WORK/m1 $WORK/m2"
checkx "plain user gets a clear 'use sudo' message from status.sh" "S 'scripts/status.sh 2>&1 | head -n1' | grep -q 'run this script with sudo'"

log "first administrator (password via ADMIN_PASSWORD; no terminal)"
checkx "create_admin without --email fails clearly" "S 'sudo scripts/pbctl.sh exec -T app npx tsx scripts/create_admin.ts 2>&1' | grep -q -- '--email is required'"
S "sudo ADMIN_PASSWORD='$PW' scripts/pbctl.sh exec -T -e ADMIN_PASSWORD app npx tsx scripts/create_admin.ts --email $ADMIN --name 'Test Admin'" | tail -n1
S "sudo scripts/pbctl.sh cp proxy:/data/caddy/pki/authorities/local/root.crt /var/tmp/caddy-root.crt >/dev/null 2>&1; sudo chmod 644 /var/tmp/caddy-root.crt"

log "HTTPS from inside the server"
printf '{"email":"%s","password":"%s"}' "$ADMIN" "$PW" | docker exec -i "$C" tee /var/tmp/login.json >/dev/null
printf '{"email":"%s","password":"wrong-password-123"}' "$ADMIN" | docker exec -i "$C" tee /var/tmp/bad.json >/dev/null; docker exec "$C" chmod 644 /var/tmp/login.json /var/tmp/bad.json
checkx "plain HTTP redirects to HTTPS" "S 'curl -s -o /dev/null -w \"%{http_code} %{redirect_url}\" -H \"Host: $DOMAIN\" http://127.0.0.1/api/health' | grep -q '^308 https://$DOMAIN/api/health'"
echo "  health: $(https /api/health)"; echo "  ready : $(https /api/ready)"
checkx "/api/health is ok" "https /api/health | grep -q '\"ok\":true'"
checkx "/api/ready is ok" "https /api/ready | grep -q '\"status\":\"ok\"'"
echo "  cert  : $(S "echo | openssl s_client -connect 127.0.0.1:443 -servername $DOMAIN 2>/dev/null | openssl x509 -noout -issuer -enddate | tr '\n' ' '")"
[[ "$(https /api/auth/login "-c /var/tmp/jar -H content-type:application/json -d @/var/tmp/login.json -o /dev/null -w %{http_code}")" == 200 ]] && ok "login returns 200" || bad "login failed"
checkx "wrong password is rejected (401)" "[[ \"\$(https /api/auth/login '-H content-type:application/json -d @/var/tmp/bad.json -o /dev/null -w %{http_code}')\" == 401 ]]"

log "CSV import (docs/import-templates/products.csv, as an administrator)"
S "jq -n --rawfile csv docs/import-templates/products.csv '{kind:\"products\",csv:\$csv,filename:\"products.csv\"}' > /var/tmp/imp.json"
r="$(https /api/admin/import/apply "-b /var/tmp/jar -H 'content-type: application/json' -d @/var/tmp/imp.json" || true)"; echo "  apply: $(echo "$r" | cut -c1-200)"
n1="$(rows products | tr -d '[:space:]')"; check "products imported ($n1 row)" test "$n1" = 1
S "sudo scripts/pbctl.sh exec -T app sh -c 'echo canary > /app/runtime/storage/restore-canary.txt'"

log "backup, restore --verify"
S "sudo scripts/backup.sh" 2>&1 | tail -n2
S "sudo scripts/backup.sh --list" 2>&1 | tail -n4
S "sudo scripts/restore.sh --verify latest" 2>&1 | tail -n4 | cut -c1-300
checkx "restore --verify reports matching row counts" "S 'sudo scripts/restore.sh --verify latest 2>&1' | grep -q 'Row counts match'"

log "real restore: change data after the backup, restore, expect the backup state"
printf 'sku,description,selling_unit,list_price\nNUT-M8,M8 nut,pack,3.50\n' | docker exec -i "$C" tee /var/tmp/p2.csv >/dev/null
S "jq -n --rawfile csv /var/tmp/p2.csv '{kind:\"products\",csv:\$csv,filename:\"p2.csv\"}' > /var/tmp/imp2.json"
https /api/admin/import/apply "-b /var/tmp/jar -H 'content-type: application/json' -d @/var/tmp/imp2.json -o /dev/null -w %{http_code}" | grep -q 200 && ok "second import applied" || bad "second import failed"
n2="$(rows products | tr -d '[:space:]')"; check "rows after extra import: $n2" test "$n2" = 2
S "sudo scripts/pbctl.sh exec -T app rm /app/runtime/storage/restore-canary.txt"
S "sudo scripts/restore.sh --yes latest" 2>&1 | tail -n4 | cut -c1-200
wait_https 40 && ok "site back after restore" || bad "site not back after restore"
n3="$(rows products | tr -d '[:space:]')"; check "products back to $n1 after restore (got $n3)" test "$n3" = "$n1"
check "documents volume restored (canary file back)" S "sudo scripts/pbctl.sh exec -T app cat /app/runtime/storage/restore-canary.txt | grep -q canary"
checkx "login still works after restore" "[[ \"\$(https /api/auth/login '-H content-type:application/json -d @/var/tmp/login.json -o /dev/null -w %{http_code}')\" == 200 ]]"

log "upgrade: new commit upstream, git pull, scripts/upgrade.sh"
img_before="$(S 'sudo docker image inspect -f "{{.Id}}" pennbridge-app:prod')"
docker exec -u ubuntu -w /home/ubuntu/src "$C" bash -c 'echo "// release 2 marker" >> scripts/create_admin.ts && git -c user.email=t@t -c user.name=t commit -qam "release 2"'
S "sudo git pull -q" && ok "git pull"
S "sudo scripts/upgrade.sh" > "$WORK/upgrade.log" 2>&1 || { tail -20 "$WORK/upgrade.log"; bad "upgrade.sh failed"; }
tail -n3 "$WORK/upgrade.log" | cut -c1-200
img_after="$(S 'sudo docker image inspect -f "{{.Id}}" pennbridge-app:prod')"
check "new image built" test "$img_before" != "$img_after"
check "previous image kept as prod-previous" test "$(S 'sudo docker image inspect -f "{{.Id}}" pennbridge-app:prod-previous')" = "$img_before"
check "data survived the upgrade" test "$(rows products | tr -d '[:space:]')" = "$n1"

log "status.sh"
S "sudo scripts/status.sh" > "$WORK/status.log" 2>&1; rc=$?; tail -n 12 "$WORK/status.log" | cut -c1-200
check "status.sh exits 0" test "$rc" = 0

if [[ $reboot -eq 1 ]]; then
  log "reboot: restart the whole server container; systemd + Docker must bring everything back with no commands"
  started_before="$(S 'sudo docker inspect -f "{{.State.StartedAt}}" pennbridge-db-1')"
  docker restart "$C" >/dev/null
  check "systemd up again" wait_systemd
  if wait_https 80; then ok "HTTPS answers after reboot with nothing started by hand"; else bad "stack did not come back after reboot"; S 'sudo docker ps -a --format "{{.Names}} {{.Status}}"' || true; fi
  started_after="$(S 'sudo docker inspect -f "{{.State.StartedAt}}" pennbridge-db-1')"
  check "containers were really restarted by Docker (db StartedAt $started_before -> $started_after)" test "$started_before" != "$started_after"
  S "sudo scripts/status.sh" > "$WORK/status2.log" 2>&1; rc=$?; tail -n 8 "$WORK/status2.log" | cut -c1-200
  check "status.sh exits 0 after reboot" test "$rc" = 0
  check "data intact after reboot" test "$(rows products | tr -d '[:space:]')" = "$n1"
checkx "login works after reboot" "[[ \"\$(https /api/auth/login '-H content-type:application/json -d @/var/tmp/login.json -o /dev/null -w %{http_code}')\" == 200 ]]"
fi

log "result"
[[ $fails -eq 0 ]] && echo "Ubuntu install test passed." || { echo "$fails check(s) failed."; exit 1; }
