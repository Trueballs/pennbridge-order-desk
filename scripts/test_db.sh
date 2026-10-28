#!/usr/bin/env bash
# Real PostgreSQL acceptance checks. Only creates fresh databases; never drops one.
set -euo pipefail

PB_PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PB_TEST_IMAGE="${PB_TEST_IMAGE:-pennbridge-app:local}"
PB_TEST_NETWORK="${PB_TEST_NETWORK:-pennbridge-dev_private}"
PB_TEST_DB_CONTAINER="${PB_TEST_DB_CONTAINER:-pennbridge-dev-db-1}"
PB_TEST_DB_USER="${PB_TEST_DB_USER:-pennbridge}"
PB_TEST_DB_PASSWORD="${PB_TEST_DB_PASSWORD:-pennbridge-local}"
PB_TEST_RUN="$(date -u +%Y%m%d%H%M%S)_$$"
PB_CORE_DB="pb_${PB_TEST_RUN}_core_test"
PB_STATEFUL_DB="pb_${PB_TEST_RUN}_pennbridge_stateful_test"
PB_WORKFLOW_DB="pb_${PB_TEST_RUN}_workflow_test"
PB_ACCOUNTS_DB="pb_${PB_TEST_RUN}_accounts_test"
PB_OPS_DB="pb_${PB_TEST_RUN}_ops_test"
PB_REPORTS="${PB_PROJECT_ROOT}/results/acceptance"
PB_TEST_UID="$(id -u)"
PB_TEST_GID="$(id -g)"

# Fail before touching a database if the selected resources are not this project.
PB_CONTAINER_PROJECT="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$PB_TEST_DB_CONTAINER")"
PB_NETWORK_PROJECT="$(docker network inspect --format '{{index .Labels "com.docker.compose.project"}}' "$PB_TEST_NETWORK")"
if [[ "$PB_CONTAINER_PROJECT" != "pennbridge-dev" || "$PB_NETWORK_PROJECT" != "pennbridge-dev" ]]; then
  printf 'Refusing non-Pennbridge Docker resources. Expected compose project pennbridge-dev.\n' >&2
  exit 1
fi
docker image inspect "$PB_TEST_IMAGE" >/dev/null
mkdir -p "$PB_REPORTS"

# CREATE DATABASE fails on a name collision. No pre-existing database is reset/deleted.
for PB_DATABASE in "$PB_CORE_DB" "$PB_STATEFUL_DB" "$PB_WORKFLOW_DB" "$PB_ACCOUNTS_DB" "$PB_OPS_DB"; do
  docker exec "$PB_TEST_DB_CONTAINER" createdb --username="$PB_TEST_DB_USER" "$PB_DATABASE"
done
printf 'Created isolated test databases: %s, %s, %s\n' "$PB_CORE_DB" "$PB_STATEFUL_DB" "$PB_WORKFLOW_DB"
printf 'Databases are retained for inspection; no host database port is published.\n'

pb_run_suite() {
  local pb_database="$1" pb_toggle="$2" pb_test_file="$3" pb_demo="${4:-true}"  # accounts/import needs a non-demo, unseeded database
  docker run --rm --user "${PB_TEST_UID}:${PB_TEST_GID}" --network "$PB_TEST_NETWORK" \
    -e XDG_DATA_HOME=/tmp/vitest-user-data \
    -e "${pb_toggle}=true" \
    -e "DATABASE_URL=postgresql://${PB_TEST_DB_USER}:${PB_TEST_DB_PASSWORD}@db:5432/${pb_database}" \
    -e PROJECT_ROOT=/app -e STORAGE_ROOT=/tmp/pennbridge-test-storage -e LIVE_AI_ENABLED=false -e "DEMO_MODE=${pb_demo}" \
    --mount "type=bind,source=${PB_PROJECT_ROOT}/packages,target=/app/packages,readonly" \
    --mount "type=bind,source=${PB_PROJECT_ROOT}/tests,target=/app/tests,readonly" \
    --mount "type=bind,source=${PB_PROJECT_ROOT}/fixtures,target=/app/fixtures,readonly" \
    --mount "type=bind,source=${PB_PROJECT_ROOT}/apps,target=/app/apps,readonly" \
    --mount "type=bind,source=${PB_PROJECT_ROOT}/docs,target=/app/docs,readonly" \
    --mount "type=bind,source=${PB_PROJECT_ROOT}/scripts,target=/app/scripts,readonly" \
    --mount "type=bind,source=${PB_PROJECT_ROOT}/results,target=/app/results" \
    --mount "type=bind,source=${PB_PROJECT_ROOT}/vitest.config.ts,target=/app/vitest.config.ts,readonly" \
    "$PB_TEST_IMAGE" node node_modules/vitest/vitest.mjs run "$pb_test_file" \
    --configLoader native --fsModuleCachePath /tmp/vitest-cache --no-cache
}

pb_run_suite "$PB_CORE_DB" CORE_DB_TEST tests/core-db.test.ts 2>&1 | tee "${PB_REPORTS}/db-lifecycle.log"
pb_run_suite "$PB_STATEFUL_DB" STATEFUL_ACCEPTANCE_TEST tests/stateful-acceptance.test.ts 2>&1 | tee "${PB_REPORTS}/stateful.log"
pb_run_suite "$PB_WORKFLOW_DB" WORKFLOW_DB_TEST tests/workflow-db.test.ts 2>&1 | tee "${PB_REPORTS}/workflow.log"
pb_run_suite "$PB_ACCOUNTS_DB" W3_DB_TEST tests/accounts-import.test.ts false 2>&1 | tee "${PB_REPORTS}/accounts-import.log"
pb_run_suite "$PB_OPS_DB" OPS_DB_TEST tests/ops-db.test.ts false 2>&1 | tee "${PB_REPORTS}/ops.log"
printf 'Passed: lifecycle, stateful acceptance, workflow, accounts/import and operations suites.\n'
printf 'Reports: results/acceptance/db-lifecycle.log, stateful.log, stateful.json\n'
