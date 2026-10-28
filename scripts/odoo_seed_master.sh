#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p results/odoo
docker compose -f infra/odoo.compose.yaml run --rm -T odoo odoo shell --database=pennbridge --no-http < infra/odoo/seed_master.py > results/odoo/master-seed.log 2>&1
python3 - <<'PY'
import json
from pathlib import Path
for line in Path('results/odoo/master-seed.log').read_text().splitlines():
    if line.startswith('PENNBRIDGE_MASTER='):
        data = json.loads(line.partition('=')[2])
        Path('results/odoo/master-snapshot.json').write_text(json.dumps(data,indent=2)+'\n')
        metadata = {k:v for k,v in data.items() if k not in ['catalogue','accounts']}
        Path('infra/odoo/master-metadata.json').write_text(json.dumps(metadata,indent=2)+'\n')
        print(json.dumps(metadata,indent=2))
        break
else:
    raise SystemExit('Master seed did not emit snapshot; inspect results/odoo/master-seed.log')
PY
