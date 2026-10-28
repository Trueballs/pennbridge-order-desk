#!/usr/bin/env bash
# Operations tests against real PostgreSQL (migration runner, budgets, readiness). Creates a fresh uniquely named database.
set -euo pipefail
PB_PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PB_TEST_IMAGE="${PB_TEST_IMAGE:-pennbridge-app:local}"
PB_TEST_NETWORK="${PB_TEST_NETWORK:-pennbridge-dev_private}"
PB_TEST_DB_CONTAINER="${PB_TEST_DB_CONTAINER:-pennbridge-dev-db-1}"
PB_TEST_DB_USER="${PB_TEST_DB_USER:-pennbridge}"
PB_TEST_DB_PASSWORD="${PB_TEST_DB_PASSWORD:-pennbridge-local}"
PB_DB="pb_$(date -u +%Y%m%d%H%M%S)_$$_ops_test"
[[ "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$PB_TEST_DB_CONTAINER")" == pennbridge-dev ]] || { echo "Refusing non-Pennbridge database container" >&2; exit 1; }
docker exec "$PB_TEST_DB_CONTAINER" createdb --username="$PB_TEST_DB_USER" "$PB_DB"
docker run --rm --user "$(id -u):$(id -g)" --network "$PB_TEST_NETWORK" -e XDG_DATA_HOME=/tmp/vitest-user-data -e OPS_DB_TEST=true \
  -e "DATABASE_URL=postgresql://${PB_TEST_DB_USER}:${PB_TEST_DB_PASSWORD}@db:5432/${PB_DB}" -e PROJECT_ROOT=/app \
  --mount "type=bind,source=${PB_PROJECT_ROOT}/packages,target=/app/packages,readonly" \
  --mount "type=bind,source=${PB_PROJECT_ROOT}/tests,target=/app/tests,readonly" \
  --mount "type=bind,source=${PB_PROJECT_ROOT}/vitest.config.ts,target=/app/vitest.config.ts,readonly" \
  "$PB_TEST_IMAGE" node node_modules/vitest/vitest.mjs run tests/ops-config.test.ts tests/ops-db.test.ts \
  --configLoader native --fsModuleCachePath /tmp/vitest-cache --no-cache
docker exec "$PB_TEST_DB_CONTAINER" dropdb --username="$PB_TEST_DB_USER" "$PB_DB"
