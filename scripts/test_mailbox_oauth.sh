#!/usr/bin/env bash
# Protocol-level verification of the mailbox receiver's auth modes WITHOUT a cloud tenant.
# Runs the real receiver code (apps/mailbox + packages/mailbox, mounted into the pennbridge-app image) against:
#   * a pinned Dovecot (IMAPS, test CA, passwd-file + oauth2 passdb accepting XOAUTH2 / OAUTHBEARER)
#   * a local mock OAuth server (token endpoints for client-credentials secret+certificate, Google JWT-bearer, refresh token;
#     Dovecot introspection; a stand-in for the desk's /api/intake).
# Synthetic data only. Touches no Compose project, volume or container other than its own pb-oauth-test-* resources.
set -uo pipefail
cd "$(dirname "$0")/.."
REPO=$PWD
IMAGE=${PB_TEST_IMAGE:-pennbridge-app:local}
DOVECOT=${PB_TEST_DOVECOT_IMAGE:-dovecot/dovecot:2.4.5@sha256:43c14def08a57f25107593cbcf64a0a6fbae84a7b9de7aa038513c9b21e91914}
RUN=$$
P=pb-oauth-test
NET=$P-$RUN
WORK=$(mktemp -d "${TMPDIR:-/tmp}/pb-oauth-test.XXXXXX"); chmod 755 "$WORK"
MAILBOX=orders@pb-test.example
PASS=0; FAIL=0
RECEIVERS=()

cleanup() {
  docker ps -aq --filter "label=$P=$RUN" | xargs -r docker rm -f >/dev/null 2>&1
  docker volume ls -q --filter "label=$P=$RUN" | xargs -r docker volume rm >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT
say() { printf '%s\n' "$*"; }
ok() { PASS=$((PASS+1)); say "  PASS  $1"; }
bad() { FAIL=$((FAIL+1)); say "  FAIL  $1"; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
docker image inspect "$IMAGE" >/dev/null 2>&1 || { say "Missing image $IMAGE (build it, or set PB_TEST_IMAGE)."; exit 2; }

# ---------- fixtures: test CA, server cert, client keys ----------
cd "$WORK"
openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -subj "/CN=pennbridge oauth test CA" -days 2 2>/dev/null
openssl req -newkey rsa:2048 -nodes -keyout server.key -out s.csr -subj "/CN=imap.pb-test" 2>/dev/null
printf 'subjectAltName=DNS:imap.pb-test,DNS:imap-bearer.pb-test,DNS:login.pb-test,DNS:mock.pb-test\n' > ext
openssl x509 -req -in s.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 2 -extfile ext 2>/dev/null
openssl req -x509 -newkey rsa:2048 -nodes -keyout ms.key -out ms.crt -subj "/CN=pb-test-app" -days 2 2>/dev/null
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out g.key 2>/dev/null
openssl pkey -in g.key -pubout -out g.pub 2>/dev/null
INTAKE_TOKEN=$(openssl rand -hex 32)
MS_SECRET=ms-secret-$(openssl rand -hex 8)
python3 -I - <<PY
import json
r=lambda f: open(f).read()
json.dump({'mailbox':'$MAILBOX',
 'microsoft':{'tenant':'tenant-1','clientId':'ms-app-id','secret':'$MS_SECRET','certPem':r('ms.crt')},
 'google':{'email':'svc@pb-test.iam.gserviceaccount.com','keyId':'kid-1','publicKeyPem':r('g.pub')},
 'refresh':{'clientId':'rt-client','clientSecret':'rt-secret','refreshToken':'rt.initial-refresh-token'}},open('clients.json','w'))
json.dump({'type':'service_account','client_email':'svc@pb-test.iam.gserviceaccount.com','private_key_id':'kid-1','private_key':r('g.key')},open('google-sa.json','w'))
json.dump({'clientSecret':'rt-secret','refreshToken':'rt.initial-refresh-token'},open('refresh.json','w'))
PY
printf '%s' "$INTAKE_TOKEN" > intake-token
cat ms.key ms.crt > ms-combined.pem
printf '%s' "$MS_SECRET" > ms-secret
printf 'app-password-123' > app-password
sed 's/^auth_mechanisms = .*/auth_mechanisms = plain login oauthbearer/' "$REPO/infra/test-oauth/dovecot.conf" > dovecot-bearer.conf
chmod 644 ./*
cd "$REPO"

# ---------- infrastructure ----------
docker network create --label "$P=$RUN" "$NET" >/dev/null
start_dovecot() { # name alias conf
  docker run -d --name "$P-$RUN-$1" --label "$P=$RUN" --network "$NET" --network-alias "$2" \
    -v "$WORK:/tls:ro" -v "$3:/etc/dovecot/dovecot.conf:ro" -v "$REPO/infra/test-oauth/users:/etc/dovecot/users:ro" "$DOVECOT" >/dev/null
}
start_dovecot dovecot imap.pb-test "$REPO/infra/test-oauth/dovecot.conf"
start_dovecot dovecot-bearer imap-bearer.pb-test "$WORK/dovecot-bearer.conf"
docker run -d --name "$P-$RUN-mock" --label "$P=$RUN" --network "$NET" --network-alias mock.pb-test --network-alias login.pb-test \
  -p 127.0.0.1::9000 -v "$WORK:/tls:ro" -v "$WORK:/fixtures:ro" -v "$REPO/infra/test-oauth/mock-oauth.mjs:/mock.mjs:ro" \
  --read-only --entrypoint node "$IMAGE" /mock.mjs >/dev/null
CTL="http://127.0.0.1:$(docker port "$P-$RUN-mock" 9000/tcp | head -1 | sed 's/.*://')"
for _ in $(seq 40); do curl -sf "$CTL/_ctl/state" >/dev/null 2>&1 && break; sleep 0.5; done
curl -sf "$CTL/_ctl/state" >/dev/null || { say "mock did not start"; docker logs "$P-$RUN-mock"; exit 2; }
for _ in $(seq 40); do docker logs "$P-$RUN-dovecot" 2>&1 | grep -q 'starting up' && break; sleep 0.5; done

ctl_get() { curl -s "$CTL/_ctl/state"; }
ctl_post() { curl -s -X POST -d "${2:-{\}}" "$CTL/_ctl/$1" >/dev/null; }
jget() { python3 -I -c "import json,sys;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1"; } # e.g. d['grants']['google']
intake_count() { ctl_get | jget "len([i for i in d['intake'] if i['bodyHasMarker']])"; }
grants() { ctl_get | jget "d['grants']['$1']"; }
deliver() { # container subject
  printf 'From: Buyer <buyer@customer.test>\r\nTo: %s\r\nSubject: %s\r\nMessage-ID: <%s@pb-test>\r\nDate: %s\r\n\r\nSYNTHETIC-OAUTH-TEST 2 packs FB-0830-A2-100\r\n' "$MAILBOX" "$2" "$(openssl rand -hex 6)" "$(date -u '+%a, %d %b %Y %H:%M:%S +0000')" |
    docker exec -i "$P-$RUN-$1" /dovecot/bin/doveadm save -u "$MAILBOX" -m INBOX
}
wait_for() { # seconds, command...
  local limit=$1; shift; local end=$((SECONDS+limit)); while (( SECONDS < end )); do if "$@" >/dev/null 2>&1; then return 0; fi; sleep 1; done; return 1
}

# receiver NAME MODE-JSON-FRAGMENT CREDENTIAL-FILE [IMAP-ALIAS] [extra docker args...]
receiver() {
  local name=$1 cfg=$2 cred=$3 host=${4:-imap.pb-test}; local dir="$WORK/r-$name"; mkdir -p "$dir"
  printf '{"host":"%s","port":993,"user":"%s","mailbox":"INBOX","pollIntervalSeconds":10,"tlsCaFile":"/run/mailbox/ca.pem"%s}\n' "$host" "$MAILBOX" "${cfg:+,$cfg}" > "$dir/config.json"
  cp "$cred" "$dir/credential"; cp "$WORK/intake-token" "$dir/token"; cp "$WORK/ca.crt" "$dir/ca.pem"; chmod 644 "$dir"/*
  docker volume create --label "$P=$RUN" "$P-$RUN-state-$name" >/dev/null
  docker run -d --name "$P-$RUN-rx-$name" --label "$P=$RUN" --network "$NET" --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
    -e MAILBOX_CONFIG_FILE=/run/mailbox/config.json -e MAILBOX_PASSWORD_FILE=/run/secrets/mailbox_password -e MAILBOX_TOKEN_FILE=/run/secrets/mailbox_token \
    -e MAILBOX_STATE_FILE=/app/runtime/mailbox-state/checkpoint.json -e MAILBOX_INTAKE_URL=http://mock.pb-test:8080/api/intake \
    -v "$dir/config.json:/run/mailbox/config.json:ro" -v "$dir/ca.pem:/run/mailbox/ca.pem:ro" \
    -v "$dir/credential:/run/secrets/mailbox_password:ro" -v "$dir/token:/run/secrets/mailbox_token:ro" \
    -v "$P-$RUN-state-$name:/app/runtime/mailbox-state" \
    -v "$REPO/packages/mailbox:/app/packages/mailbox:ro" -v "$REPO/apps/mailbox:/app/apps/mailbox:ro" \
    -w /app --entrypoint node_modules/.bin/tsx "$IMAGE" apps/mailbox/index.ts >/dev/null
}
rx_logs() { docker logs "$P-$RUN-rx-$1" 2>&1; }
rx_state() { docker exec "$P-$RUN-rx-$1" cat "/app/runtime/mailbox-state/$2" 2>/dev/null; }
rx_stop() { docker rm -f "$P-$RUN-rx-$1" >/dev/null 2>&1; }
logs_have() { local l; l=$(rx_logs "$1"); grep -q -e "$2" <<<"$l"; }
ready() { logs_have "$1" '"event":"mailbox.ready"'; }
alert_code() { rx_state "$1" alert.json | jget "d['code']"; }
has_alert() { [[ "$(alert_code "$1" 2>/dev/null)" == "$2" ]]; }
no_alert() { ! docker exec "$P-$RUN-rx-$1" test -e /app/runtime/mailbox-state/alert.json; }
got_intake() { [[ "$(intake_count)" -ge "$1" ]]; }
no_secrets_in_logs() { local l; l=$(rx_logs "$1"); ! grep -q -e "$MS_SECRET" -e 'rt.initial-refresh-token' -e 'app-password-123' -e 'BEGIN PRIVATE KEY' -e "$INTAKE_TOKEN" <<<"$l"; }

login_methods() { docker logs "$P-$RUN-$1" 2>&1 | grep -o 'method=[A-Za-z0-9]*' | sort | uniq -c | tr -s ' ' | tr '\n' ';'; }
scenario() { say; say "== $*"; ctl_post reset; }
roundtrip() { # name container subject -> baseline, deliver, expect arrival at the intake
  local name=$1 container=$2 subject=$3 before; before=$(intake_count)
  check "$name: receiver authenticated and baselined (mailbox.ready)" "wait_for 90 ready $name"
  deliver "$container" "$subject" || bad "$name: delivery into Dovecot failed"
  check "$name: test message reached the desk intake" "wait_for 60 got_intake $((before+1))"
}

say "Dovecot: $(docker logs "$P-$RUN-dovecot" 2>&1 | grep -o 'Dovecot v[0-9.]* ([0-9a-f]*)' | head -1)   image: $DOVECOT"

scenario "password mode (original config format, no authMode key) against the same Dovecot"
receiver pw "" "$WORK/app-password"
roundtrip pw dovecot "[PW] order 1"
check "pw: no OAuth token was requested" '[[ "$(ctl_get | jget "sum(v for k,v in d[\"grants\"].items() if k!=\"rejected\")")" == 0 ]]'
check "pw: no secrets in logs" 'no_secrets_in_logs pw'
rx_stop pw

scenario "oauth2-microsoft, client secret: token cache, revocation, expiry refresh, withdrawn access"
receiver ms '"authMode":"oauth2-microsoft","tenantId":"tenant-1","clientId":"ms-app-id","tokenEndpoint":"https://login.pb-test:8443/tenant-1/oauth2/v2.0/token"' "$WORK/ms-secret"
roundtrip ms dovecot "[MS] order 1"
sleep 22
check "ms: token cached across polls (exactly 1 grant while several polls ran)" '[[ "$(grants microsoft_secret)" == 1 && "$(rx_logs ms | grep -c mailbox.poll_complete)" -ge 2 ]]'
say "        evidence: $(rx_logs ms | grep -c 'mailbox.poll_complete') polls, $(grants microsoft_secret) client-credentials grant(s)"
say "        dovecot login methods so far: $(login_methods dovecot)"
G0=$(grants microsoft_secret)
ctl_post set '{"expiresIn":12}'; ctl_post revoke
n=$(intake_count); deliver dovecot "[MS] order 2 after revoke"
check "ms: revoked cached token -> transparent re-issue, message still delivered" 'wait_for 60 got_intake $((n+1))'
check "ms: no alert after transparent re-issue" 'no_alert ms'
check "ms: a new grant was made" '[[ "$(grants microsoft_secret)" -gt "$G0" ]]'
G1=$(grants microsoft_secret); sleep 24
check "ms: short-lived token (12 s) refreshed before expiry on later polls (>= 2 more grants)" '[[ "$(grants microsoft_secret)" -ge $((G1+2)) ]]'
n=$(intake_count); deliver dovecot "[MS] order 3 after expiry refresh"
check "ms: message delivered with a refreshed token" 'wait_for 60 got_intake $((n+1))'
ctl_post set '{"expiresIn":3600,"denyMailbox":true}'; ctl_post revoke
check "ms: access withdrawn -> alert.json imap_auth_failed" 'wait_for 90 has_alert ms imap_auth_failed'
say "        evidence: alert.json=$(rx_state ms alert.json)  status.json=$(rx_state ms status.json)"
ctl_post set '{"denyMailbox":false}'; n=$(intake_count); deliver dovecot "[MS] order 4 after access restored"
check "ms: access restored -> alert cleared and message delivered" 'wait_for 120 got_intake $((n+1)) && wait_for 30 no_alert ms'
check "ms: no secrets in logs" 'no_secrets_in_logs ms'
rx_stop ms

scenario "oauth2-microsoft, certificate assertion (private_key_jwt)"
receiver mscert '"authMode":"oauth2-microsoft","clientAuth":"certificate","tenantId":"tenant-1","clientId":"ms-app-id","tokenEndpoint":"https://login.pb-test:8443/tenant-1/oauth2/v2.0/token"' "$WORK/ms-combined.pem"
roundtrip mscert dovecot "[MSCERT] order 1"
check "mscert: certificate-signed grant accepted by the token server" '[[ "$(grants microsoft_certificate)" -ge 1 ]]'
check "mscert: no secrets in logs" 'no_secrets_in_logs mscert'
rx_stop mscert

scenario "oauth2-microsoft, wrong client secret -> token_failed"
printf 'wrong-secret' > "$WORK/wrong-secret"; chmod 644 "$WORK/wrong-secret"
receiver mswrong '"authMode":"oauth2-microsoft","tenantId":"tenant-1","clientId":"ms-app-id","tokenEndpoint":"https://login.pb-test:8443/tenant-1/oauth2/v2.0/token"' "$WORK/wrong-secret"
check "mswrong: alert.json token_failed" 'wait_for 60 has_alert mswrong token_failed'
check "mswrong: log carries only the safe OAuth error code" 'logs_have mswrong mailbox.token_request_failed && ! logs_have mswrong wrong-secret'
rx_stop mswrong

scenario "oauth2-microsoft against an OAUTHBEARER-only server (second mechanism)"
receiver msbear '"authMode":"oauth2-microsoft","tenantId":"tenant-1","clientId":"ms-app-id","tokenEndpoint":"https://login.pb-test:8443/tenant-1/oauth2/v2.0/token"' "$WORK/ms-secret" imap-bearer.pb-test
roundtrip msbear dovecot-bearer "[BEARER] order 1"
rx_stop msbear

scenario "oauth2-google: service-account JWT bearer, delegated subject"
receiver gg '"authMode":"oauth2-google","tokenEndpoint":"https://login.pb-test:8443/google/token"' "$WORK/google-sa.json"
roundtrip gg dovecot "[GOOGLE] order 1"
check "gg: signed JWT-bearer grant accepted (signature, iss, sub, scope, aud, exp)" '[[ "$(grants google)" -ge 1 ]]'
check "gg: no secrets in logs" 'no_secrets_in_logs gg'
rx_stop gg
receiver ggbad '"authMode":"oauth2-google","impersonateUser":"someone-else@pb-test.example","tokenEndpoint":"https://login.pb-test:8443/google/token"' "$WORK/google-sa.json"
check "ggbad: delegation not granted for that user -> alert consent_required" 'wait_for 60 has_alert ggbad consent_required'
rx_stop ggbad

scenario "oauth2-refresh-token (generic): refresh grant, rotation persisted, revoked consent"
receiver rt '"authMode":"oauth2-refresh-token","clientId":"rt-client","tokenEndpoint":"https://login.pb-test:8443/idp/token"' "$WORK/refresh.json"
ctl_post set '{"rotateRefresh":true,"expiresIn":12}'
roundtrip rt dovecot "[REFRESH] order 1"
sleep 25
check "rt: repeated refreshes keep working with rotated refresh tokens (>= 3 grants)" '[[ "$(grants refresh)" -ge 3 ]]'
check "rt: rotated refresh token stored in the state volume (0600)" '[[ "$(docker exec "$P-$RUN-rx-rt" stat -c %a /app/runtime/mailbox-state/oauth-refresh-token)" == 600 ]]'
n=$(intake_count); deliver dovecot "[REFRESH] order 2"
check "rt: message delivered after rotation" 'wait_for 60 got_intake $((n+1))'
ctl_post set '{"tokenError":"consent"}'
check "rt: consent withdrawn -> alert consent_required" 'wait_for 120 has_alert rt consent_required'
check "rt: no secrets in logs" 'no_secrets_in_logs rt'
rx_stop rt

say; say "Dovecot (XOAUTH2 only server) login methods: $(login_methods dovecot)"
say "Dovecot (OAUTHBEARER only server) login methods: $(login_methods dovecot-bearer)"
say "RESULT: $PASS passed, $FAIL failed"
(( FAIL == 0 ))
