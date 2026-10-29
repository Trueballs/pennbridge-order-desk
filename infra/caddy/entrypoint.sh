#!/bin/sh
# Proxy entrypoint: turns the optional ACME settings from .env into Caddy global options, then runs Caddy.
#   PB_ACME_EMAIL    contact address for Let's Encrypt expiry notices (recommended)
#   PB_ACME_CA       'staging' (Let's Encrypt staging), or a full ACME directory URL. Empty = Caddy's default (Let's Encrypt production)
#   PB_ACME_CA_ROOT  path (inside the container, e.g. /certs/acme-ca-root.pem) of a PEM root to trust for that ACME server's own HTTPS (private CAs, Pebble)
set -eu
conf=/tmp/acme-options.conf
: > "$conf"
bad() { echo "proxy: $1 must not contain spaces, quotes or braces" >&2; exit 64; }
chk() { case "$2" in *[[:space:]\"\'{}]*) bad "$1";; esac; }
email="${PB_ACME_EMAIL:-}"; ca="${PB_ACME_CA:-}"; root="${PB_ACME_CA_ROOT:-}"
chk PB_ACME_EMAIL "$email"; chk PB_ACME_CA "$ca"; chk PB_ACME_CA_ROOT "$root"
[ "$ca" = staging ] && ca=https://acme-staging-v02.api.letsencrypt.org/directory
[ -z "$email" ] || echo "email $email" >> "$conf"
[ -z "$ca" ] || echo "acme_ca $ca" >> "$conf"
[ -z "$root" ] || echo "acme_ca_root $root" >> "$conf"
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
