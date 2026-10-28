#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose -f infra/odoo.compose.yaml run --rm -T odoo odoo shell --database=pennbridge --no-http < infra/odoo/proof.py
