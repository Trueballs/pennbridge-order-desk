#!/usr/bin/env bash
# Real ACME issuance test for the production Caddy configuration, against Let's Encrypt's own test CA (Pebble) with pebble-challtestsrv as DNS.
# Runs the production proxy image, Caddyfile, tls-*.conf and entrypoint.sh (everything Compose mounts) with a stub app, on a throwaway Docker network.
#   scripts/test_acme.sh [--no-renewal] [--keep]
# Scenarios (each starts with an empty Caddy data volume): http-01 only, tls-alpn-01 only, both open (then renewal of a short-lived certificate).
# Touches only containers/networks named pb-acme-*; never the pennbridge-dev or odoo projects.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PEBBLE_IMAGE="${PEBBLE_IMAGE:-ghcr.io/letsencrypt/pebble:2.10.1@sha256:ddf230642b1a584f519f32e347de1b05a6e4c1f6c35c1863b33effeab5f78199}"
CHALL_IMAGE="${CHALL_IMAGE:-ghcr.io/letsencrypt/pebble-challtestsrv:2.10.1@sha256:12ce21884def456bcf9786542113949e1f19dc7738d2c70e156c2d0c38a1405b}"
CURL_IMAGE="${CURL_IMAGE:-curlimages/curl:8.11.1}"
STUB_IMAGE="${STUB_IMAGE:-busybox:latest}"
CADDY_IMAGE="$(sed -n 's/^ *image: *\(caddy:[^ ]*\).*/\1/p' "$ROOT/infra/compose.prod.yaml" | head -n1)"
[[ -n "$CADDY_IMAGE" ]] || { echo "cannot find the caddy image in infra/compose.prod.yaml" >&2; exit 1; }
DOMAIN=orders.pennbridge.test; NET=pb-acme-net; SUBNET=10.77.55.0/24
IP_CHALL=10.77.55.2; IP_PEBBLE=10.77.55.3; IP_CADDY=10.77.55.4; IP_APP=10.77.55.5
renewal=1; keep=0
for a in "$@"; do case "$a" in --no-renewal) renewal=0;; --keep) keep=1;; -h|--help) sed -n 2,6p "$0"; exit 0;; *) echo "unknown option $a" >&2; exit 1;; esac; done
WORK="$(mktemp -d)"; fails=0
log() { printf '\n== %s\n' "$*"; }
ok() { printf '  ok   %s\n' "$*"; }
bad() { printf '  FAIL %s\n' "$*"; fails=$((fails+1)); }
cleanup() {
  [[ $keep -eq 1 ]] && { echo "kept: containers pb-acme-*, network $NET, files $WORK"; return; }
  docker rm -f pb-acme-caddy pb-acme-pebble pb-acme-chall pb-acme-app >/dev/null 2>&1 || true
  docker volume rm -f pb-acme-caddy-data >/dev/null 2>&1 || true
  docker network rm $NET >/dev/null 2>&1 || true; rm -rf "$WORK"
}
trap cleanup EXIT
docker rm -f pb-acme-caddy pb-acme-pebble pb-acme-chall pb-acme-app >/dev/null 2>&1 || true
docker network rm $NET >/dev/null 2>&1 || true

# Pebble's own test CA (signs only Pebble's HTTPS listener) is what Caddy must trust via PB_ACME_CA_ROOT.
cid="$(docker create "$PEBBLE_IMAGE")"; docker cp "$cid:/test/certs/pebble.minica.pem" "$WORK/pebble.minica.pem"; docker rm "$cid" >/dev/null
mkdir -p "$WORK/certs" && cp "$WORK/pebble.minica.pem" "$WORK/certs/acme-ca-root.pem"
docker network create --subnet $SUBNET $NET >/dev/null

pebble_conf() { # http_port tls_port validity_seconds
  cat > "$WORK/pebble.json" <<JSON
{"pebble":{"listenAddress":"0.0.0.0:14000","managementListenAddress":"0.0.0.0:15000","certificate":"test/certs/localhost/cert.pem","privateKey":"test/certs/localhost/key.pem",
"httpPort":$1,"tlsPort":$2,"ocspResponderURL":"","externalAccountBindingRequired":false,"domainBlocklist":["blocked-domain.example"],"retryAfter":{"authz":3,"order":5},"keyAlgorithm":"ecdsa",
"profiles":{"default":{"description":"test","validityPeriod":$3}}}}
JSON
}
tools_curl() { docker run --rm --network $NET -v "$WORK/pebble.minica.pem:/minica.pem:ro" "$CURL_IMAGE" "$@"; }

log "start challtestsrv (DNS only), stub app"
docker run -d --name pb-acme-chall --network $NET --ip $IP_CHALL "$CHALL_IMAGE" -http01 "" -https01 "" -tlsalpn01 "" -doh "" -defaultIPv4 "$IP_CADDY" -defaultIPv6 "" >/dev/null
docker run -d --name pb-acme-app --network $NET --ip $IP_APP --network-alias app "$STUB_IMAGE" sh -c 'mkdir -p /www/api && echo "{\"ok\":true,\"stub\":true}" > /www/api/health && echo "stub app" > /www/index.html && exec httpd -f -p 3087 -h /www' >/dev/null
sleep 2
tools_curl -s -X POST -d "{\"host\":\"$DOMAIN.\",\"addresses\":[\"$IP_CADDY\"]}" http://$IP_CHALL:8055/add-a >/dev/null && ok "challtestsrv resolves $DOMAIN -> $IP_CADDY (Caddy)"

start_pebble() { # http_port tls_port validity
  docker rm -f pb-acme-pebble >/dev/null 2>&1 || true
  pebble_conf "$1" "$2" "$3"
  docker run -d --name pb-acme-pebble --network $NET --ip $IP_PEBBLE --network-alias pebble -e PEBBLE_VA_NOSLEEP=1 -e PEBBLE_WFE_NONCEREJECT=0 \
    -v "$WORK/pebble.json:/pebble.json:ro" "$PEBBLE_IMAGE" -config /pebble.json -dnsserver "$IP_CHALL:8053" >/dev/null
  for _ in $(seq 1 30); do tools_curl -sf --cacert /minica.pem https://pebble:14000/dir >/dev/null 2>&1 && return 0; sleep 1; done
  docker logs pb-acme-pebble 2>&1 | tail -8 | cut -c1-300; return 1
}
start_caddy() {
  docker rm -f pb-acme-caddy >/dev/null 2>&1 || true
  docker run -d --name pb-acme-caddy --network $NET --ip $IP_CADDY --cap-drop ALL --cap-add NET_BIND_SERVICE --security-opt no-new-privileges:true --read-only --tmpfs /tmp \
    --entrypoint /bin/sh -e PB_DOMAIN=$DOMAIN -e PB_TLS_MODE=auto -e PB_ACME_EMAIL=ops@example.org -e PB_ACME_CA=https://pebble:14000/dir -e PB_ACME_CA_ROOT=/certs/acme-ca-root.pem \
    -v "$ROOT/infra/caddy/entrypoint.sh:/entrypoint.sh:ro" -v "$ROOT/infra/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" \
    -v "$ROOT/infra/caddy/tls-auto.conf:/etc/caddy/tls-auto.conf:ro" -v "$ROOT/infra/caddy/tls-internal.conf:/etc/caddy/tls-internal.conf:ro" -v "$ROOT/infra/caddy/tls-custom.conf:/etc/caddy/tls-custom.conf:ro" \
    -v "$WORK/certs:/certs:ro" -v pb-acme-caddy-data:/data --tmpfs /config "$CADDY_IMAGE" /entrypoint.sh >/dev/null
}
wait_cert() { # prints the served certificate's serial once it is issued by Pebble
  for _ in $(seq 1 90); do
    local out; out="$(tools_curl -sS --cacert /minica.pem -k -v --resolve "$DOMAIN:443:$IP_CADDY" "https://$DOMAIN/api/health" 2>&1 || true)"
    if grep -q 'Pebble' <<<"$out"; then return 0; fi; sleep 2
  done; return 1
}
served() { tools_curl -sS -k -v --resolve "$DOMAIN:443:$IP_CADDY" "https://$DOMAIN/api/health" 2>&1 | grep -E '^\*  (subject|start date|expire date|issuer):' || true; }
fetch_cert() { # copies the issued leaf out of Caddy's storage and the issuing chain from Pebble's management API
  rm -rf "$WORK/issued"; mkdir -p "$WORK/issued"
  docker cp "pb-acme-caddy:/data/caddy/certificates" "$WORK/issued/store" >/dev/null
  leaf="$(find "$WORK/issued/store" -name "$DOMAIN.crt" | head -n1)"; [[ -n "$leaf" ]] || return 1
  tools_curl -sf --cacert /minica.pem https://pebble:15000/roots/0 > "$WORK/issued/root.pem"
  tools_curl -sf --cacert /minica.pem https://pebble:15000/intermediates/0 > "$WORK/issued/inter.pem"
}
verify_chain() {
  fetch_cert || { bad "could not read the issued certificate from Caddy storage"; return; }
  local leaf; leaf="$(find "$WORK/issued/store" -name "$DOMAIN.crt" | head -n1)"
  echo "  issuer : $(openssl x509 -in "$leaf" -noout -issuer)"; echo "  subject: $(openssl x509 -in "$leaf" -noout -text | grep -o 'DNS:[^,]*' | head -n1) (CN empty; Pebble issues SAN-only)"
  echo "  dates  : $(openssl x509 -in "$leaf" -noout -startdate -enddate | tr '\n' ' ')"; echo "  serial : $(openssl x509 -in "$leaf" -noout -serial)"
  openssl x509 -in "$leaf" -noout -text | grep -q "DNS:$DOMAIN" && ok "certificate names $DOMAIN" || bad "certificate does not name $DOMAIN"
  # Caddy stores the leaf followed by the chain; verify leaf against Pebble's root/intermediate (not the system roots).
  if openssl verify -CAfile "$WORK/issued/root.pem" -untrusted "$WORK/issued/inter.pem" "$leaf" >/dev/null 2>&1; then ok "chain validates against Pebble's root (openssl verify)"; else bad "chain does NOT validate against Pebble's root"; fi
  # And the live TLS handshake, using only Pebble's root as trust anchor.
  tools_curl -sS --cacert /minica.pem --version >/dev/null 2>&1 || true
  cp "$WORK/issued/root.pem" "$WORK/pebble-root.pem"
  local code; code="$(docker run --rm --network $NET -v "$WORK/pebble-root.pem:/root.pem:ro" "$CURL_IMAGE" -sS --cacert /root.pem --resolve "$DOMAIN:443:$IP_CADDY" -o /dev/null -w '%{http_code} verify=%{ssl_verify_result}' "https://$DOMAIN/api/health" 2>&1 || true)"
  [[ "$code" == "200 verify=0" ]] && ok "HTTPS handshake verified against Pebble's root; /api/health -> $code" || bad "HTTPS check against Pebble's root: $code"
  local redir; redir="$(tools_curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "http://$IP_CADDY/api/health" -H "Host: $DOMAIN")"
  [[ "$redir" == "308 https://$DOMAIN/api/health" ]] && ok "port 80 redirects to HTTPS ($redir)" || bad "port 80 redirect: $redir"
}
scenario() { # name http_port tls_port validity expected-pebble-log-regex
  log "scenario: $1"
  docker rm -f pb-acme-caddy >/dev/null 2>&1 || true; docker volume rm -f pb-acme-caddy-data >/dev/null 2>&1 || true
  start_pebble "$2" "$3" "$4" && ok "Pebble up (validation ports http=$2 tls-alpn=$3, validity ${4}s)" || { bad "Pebble did not start"; return 1; }
  start_caddy
  if wait_cert; then ok "Caddy obtained and serves a certificate"; else bad "no Pebble certificate served within 3 minutes"; docker logs pb-acme-caddy 2>&1 | tail -6 | cut -c1-400; docker logs pb-acme-pebble 2>&1 | tail -6 | cut -c1-300; return 1; fi
  served | sed 's/^/  /'
  local clog plog; clog="$(docker logs pb-acme-caddy 2>&1)"; plog="$(docker logs pb-acme-pebble 2>&1)"
  if grep -q "\"challenge_type\":\"$5\"" <<<"$clog" && grep -q "served key authentication certificate\|acme-challenge\|\"challenge\":\"$5\"\|trying to solve" <<<"$clog"; then ok "Caddy solved $5 (from its log)"; else bad "no evidence of $5 in Caddy log"; fi
  grep -q "set VALID by completed challenge" <<<"$plog" && ok "Pebble marked the authorization VALID" || bad "Pebble never validated the authorization"
  verify_chain
}

scenario "http-01 only (TLS-ALPN port closed in Pebble)" 80 5001 7776000 http-01
scenario "tls-alpn-01 only (HTTP port closed in Pebble)" 5002 443 7776000 tls-alpn-01

if [[ $renewal -eq 1 ]]; then
  scenario "both challenges open, 150 second certificate" 80 443 150 http-01 || true
  log "renewal: restart Caddy once the certificate is past two thirds of its life"
  before="$(openssl x509 -in "$(find "$WORK/issued/store" -name "$DOMAIN.crt" | head -n1)" -noout -serial)"
  sleep 110
  docker restart pb-acme-caddy >/dev/null
  renewed=0
  for _ in $(seq 1 60); do
    docker cp "pb-acme-caddy:/data/caddy/certificates" "$WORK/issued/store2" >/dev/null 2>&1 || true
    after="$(openssl x509 -in "$(find "$WORK/issued/store2" -name "$DOMAIN.crt" 2>/dev/null | head -n1)" -noout -serial 2>/dev/null || true)"
    [[ -n "$after" && "$after" != "$before" ]] && { renewed=1; break; }; rm -rf "$WORK/issued/store2"; sleep 3
  done
  [[ $renewed -eq 1 ]] && ok "certificate renewed automatically: $before -> $after" || { bad "certificate not renewed ($before)"; docker logs pb-acme-caddy 2>&1 | tail -6 | cut -c1-400; }
  docker logs pb-acme-caddy 2>&1 | grep -E 'renew' | tail -3 | cut -c1-300
fi

log "result"
[[ $fails -eq 0 ]] && echo "ACME test passed." || { echo "$fails check(s) failed."; exit 1; }
