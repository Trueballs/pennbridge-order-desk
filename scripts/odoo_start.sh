#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose -f infra/odoo.compose.yaml up -d odoo-db
docker compose -f infra/odoo.compose.yaml run --rm -T odoo odoo --database=pennbridge --init=sale_management --without-demo --stop-after-init
bash scripts/odoo_proof.sh
docker compose -f infra/odoo.compose.yaml up -d odoo-web
