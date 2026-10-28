#!/usr/bin/env python3
"""Bounded checks of the synthetic local stack; never overwrite a database.

Creates a timestamped backup and a NEW isolated restore database. Recovery checks
mutate only that database and a unique /tmp directory in the app container.
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http.cookies import SimpleCookie
from pathlib import Path
import argparse
import hashlib
import json
import statistics
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
COMPOSE = ["docker", "compose", "-f", str(ROOT / "infra/compose.yaml")]
BASE = "http://127.0.0.1:3087/api"
STAMP = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
RESTORE_DB = f"pennbridge_system_test_{STAMP}"
OUT = ROOT / "results/system-checks" / STAMP


def command(args, *, data=None, timeout=60, check=True):
    return subprocess.run(args, input=data, capture_output=True, cwd=ROOT,
                          timeout=timeout, check=check)


def sql(database, query):
    return command(COMPOSE + ["exec", "-T", "db", "psql", "-X", "-U", "pennbridge",
                              "-d", database, "-v", "ON_ERROR_STOP=1", "-At", "-c", query]).stdout.decode().strip()


def http(method, route, body=None, cookie=None):
    headers = {"Content-Type": "application/json"}
    if cookie:
        headers["Cookie"] = cookie
    request = urllib.request.Request(BASE + route,
        data=json.dumps(body).encode() if body is not None else None,
        headers=headers, method=method)
    try:
        response = urllib.request.urlopen(request, timeout=20)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return response.status, {key.lower():value for key,value in response.headers.items()}, json.loads(response.read())


def login(role):
    code, headers, _ = http("POST", "/auth/login", {
        "email": f"{role}@pennbridge.example", "password": f"{role}-demo"})
    assert code == 200, f"{role} login failed: {code}"
    parsed = SimpleCookie(headers["set-cookie"])
    return "; ".join(f"{key}={value.value}" for key, value in parsed.items())


def fingerprint(database):
    tables = sql(database, "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename").splitlines()
    # Table names originate in PostgreSQL metadata, then are quoted as identifiers.
    statements = []
    for table in tables:
        quoted = '"' + table.replace('"', '""') + '"'
        statements.append("SELECT json_build_object('table', '" + table.replace("'", "''") +
            "', 'count', count(*), 'digest', md5(COALESCE(string_agg(digest, '' ORDER BY digest), ''))) " +
            f"FROM (SELECT md5(row_to_json(t)::text) AS digest FROM {quoted} t) hashed")
    return {row["table"]: {"count": row["count"], "digest": row["digest"]}
            for row in map(json.loads, sql(database, ";\n".join(statements)).splitlines())}


def node(source, *, database=None, storage=None, check=True):
    args = COMPOSE + ["exec", "-T"]
    if database:
        args += ["-e", f"DATABASE_URL=postgresql://pennbridge:pennbridge-local@db:5432/{database}"]
    if storage:
        args += ["-e", f"STORAGE_ROOT={storage}"]
    return command(args + ["app", "node", "--import", "tsx", "--input-type=module", "-e", source], check=check)


def storage_backup_restore(output_dir, database):
    started = datetime.now(timezone.utc).isoformat()
    app_id = command(COMPOSE + ["ps", "-q", "app"]).stdout.decode().strip()
    mounts = json.loads(command(["docker","inspect","-f","{{json .Mounts}}",app_id]).stdout)
    mount = next(item for item in mounts if item["Destination"] == "/app/runtime/storage")
    assert mount["Type"] == "volume" and mount["Name"].startswith("pennbridge-dev_")
    source_volume = mount["Name"]
    restore_volume = f"pennbridge-system-storage-test-{STAMP}-{uuid.uuid4().hex[:8]}"
    assert command(["docker","volume","inspect",restore_volume], check=False).returncode != 0
    image = "pennbridge-app:local"

    def files(volume):
        source = """
import {readdir,readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const files={};
async function walk(relative=''){
 for(const entry of await readdir('/source/'+relative,{withFileTypes:true})){
  const name=relative+entry.name;
  if(entry.isDirectory())await walk(name+'/');
  else if(entry.isFile()){const bytes=await readFile('/source/'+name);const meta=await stat('/source/'+name);files[name]={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),mode:meta.mode&0o777,uid:meta.uid,gid:meta.gid};}
  else throw Error('Unexpected non-regular storage entry: '+name);
 }
}
await walk();console.log(JSON.stringify(files));
"""
        return json.loads(command(["docker","run","--rm","--network","none","--entrypoint","node",
            "-v",f"{volume}:/source:ro",image,"--input-type=module","-e",source]).stdout)

    before = files(source_volume)
    archive = command(["docker","run","--rm","--network","none","--entrypoint","tar",
        "-v",f"{source_volume}:/source:ro",image,"-C","/source","-cf","-","."]).stdout
    archive_path = output_dir / "document-storage.tar"
    archive_path.write_bytes(archive)
    command(["docker","volume","create",restore_volume])
    command(["docker","run","--rm","-i","--network","none","--user","0:0","--entrypoint","tar",
        "-v",f"{restore_volume}:/restore",image,"-C","/restore","-xf","-"], data=archive)
    restored, after = files(restore_volume), files(source_volume)
    assert before == after == restored, "Storage source changed or restore did not match"
    references = json.loads(sql(database, "SELECT COALESCE(json_agg(json_build_object('id',id,'path',storage_path,'hash',data->>'contentHash')),'[]'::json) FROM documents WHERE storage_path LIKE '/app/runtime/storage/%'"))
    missing, mismatched = [], []
    for reference in references:
        name = str(Path(reference["path"]).relative_to("/app/runtime/storage"))
        if name not in restored:
            missing.append(reference["id"])
        elif restored[name]["sha256"] != reference["hash"]:
            mismatched.append(reference["id"])
    assert not missing and not mismatched, (missing,mismatched)
    result = {"startedAt":started,"finishedAt":datetime.now(timezone.utc).isoformat(),
        "sourceVolume":source_volume,"restoreVolume":restore_volume,
        "archivePath":str(archive_path.relative_to(ROOT)),"archiveBytes":len(archive),
        "archiveSha256":hashlib.sha256(archive).hexdigest(),"fileCount":len(restored),
        "fileBytes":sum(item["bytes"] for item in restored.values()),"sourceStableDuringCheck":before==after,
        "allFileHashesAndMetadataMatch":before==restored,"databaseDocumentReferencesChecked":len(references),
        "missingDatabaseDocuments":missing,"mismatchedDatabaseDocuments":mismatched,"files":restored}
    return result


def main():
    OUT.mkdir(parents=True, exist_ok=False)
    result = {"startedAt": datetime.now(timezone.utc).isoformat(), "restoreDatabase": RESTORE_DB,
              "liveAiUsed": False, "queryCount": 100, "concurrency": 10}
    services = [json.loads(line) for line in command(COMPOSE + ["ps", "--format", "json"]).stdout.decode().splitlines()]
    result["composePs"] = [{key:service.get(key) for key in ["Service","State","Health","Networks","Ports","Publishers"]} for service in services]
    assert {service["Service"] for service in services} == {"app","db","worker","mailpit","proxy"}
    assert all(service["State"] == "running" for service in services)
    published = [port for service in services for port in service.get("Publishers",[]) if port.get("PublishedPort")]
    assert {port["PublishedPort"] for port in published} == {3087,8027}
    assert all(port["URL"] == "127.0.0.1" for port in published)
    result["privateNetworkInternal"] = json.loads(command(["docker","network","inspect","-f","{{json .Internal}}","pennbridge-dev_private"]).stdout)
    assert result["privateNetworkInternal"] is True
    assert next(service for service in services if service["Service"] == "worker")["Networks"] == "pennbridge-dev_private"
    health = http("GET", "/health")
    assert health[0] == 200 and health[2]["mode"] == "mock", health
    result["health"] = health[2]
    result["catalogueCounts"] = json.loads(sql("pennbridge", "SELECT json_build_object('products',count(*),'active',count(*) FILTER (WHERE active)) FROM products"))
    assert result["catalogueCounts"] == {"products": 10000, "active": 8000}
    reviewer, viewer = login("reviewer"), login("viewer")
    checks = {}
    for label, route, body in [
        ("intake", "/intake", {"filename":"forbidden.txt","mediaType":"text/plain","contentBase64":"dGVzdA==","channel":"upload"}),
        ("edit", "/orders/system-check-nonexistent", {"expectedVersion":1,"patch":{}}),
        ("approve", "/orders/system-check-nonexistent/approve", {"expectedVersion":1,"contentHash":"0"*64}),
        ("export", "/orders/system-check-nonexistent/export", {"expectedVersion":1,"idempotencyKey":"system-check-forbidden"}),
        ("retry", "/jobs/system-check-nonexistent/retry", {}),
    ]:
        status, _, payload = http("PATCH" if label == "edit" else "POST", route, body, viewer)
        checks[label] = {"httpStatus":status,"code":payload.get("error",{}).get("code")}
        assert status == 403, (label, status, payload)
    result["viewerMutationChecks"] = checks
    skus = json.loads((ROOT / "fixtures/context.json").read_text())["products"][:10]
    skus = [product["sku"] for product in skus]

    def lookup(index):
        sku = skus[index % len(skus)]
        start = time.perf_counter()
        status, _, payload = http("GET", "/catalogue?q=" + urllib.parse.quote(sku), cookie=reviewer)
        elapsed = (time.perf_counter() - start) * 1000
        assert status == 200 and any(p["sku"] == sku for p in payload["products"]), (status, sku)
        return elapsed

    lookup(0)  # One warm-up is excluded from the measured 100 requests.
    start = time.perf_counter()
    with ThreadPoolExecutor(max_workers=10) as executor:
        timings = sorted(executor.map(lookup, range(100)))
    wall = time.perf_counter() - start
    result["catalogueHttp"] = {"successfulQueries":100,"warmupQueriesExcluded":1,"wallSeconds":round(wall,3),
        "requestsPerSecond":round(100/wall,2),"latencyMs":{"min":round(timings[0],2),
        "p50":round(statistics.median(timings),2),"p95":round(timings[94],2),"max":round(timings[-1],2)}}

    print("Snapshot beginning: fingerprints, backup, new-database restore.", flush=True)
    before = fingerprint("pennbridge")
    backup = command(COMPOSE + ["exec", "-T", "db", "pg_dump", "-U", "pennbridge", "-d", "pennbridge", "-Fc"], timeout=120).stdout
    backup_path = OUT / "pennbridge.dump"
    backup_path.write_bytes(backup)
    # Deliberately no IF NOT EXISTS: collision fails instead of reusing a database.
    command(COMPOSE + ["exec", "-T", "db", "createdb", "-U", "pennbridge", RESTORE_DB])
    command(COMPOSE + ["exec", "-T", "db", "pg_restore", "-U", "pennbridge", "-d", RESTORE_DB,
                       "--exit-on-error", "--no-owner"], data=backup, timeout=120)
    restored, after = fingerprint(RESTORE_DB), fingerprint("pennbridge")
    stable = before == after
    differences = [table for table in before if restored.get(table) != before[table]]
    result["backupRestore"] = {"backupPath":str(backup_path.relative_to(ROOT)),"backupBytes":len(backup),
        "backupSha256":hashlib.sha256(backup).hexdigest(),"tableCount":len(restored),"sourceStableDuringCheck":stable,
        "allTableFingerprintsMatch":not differences,"differentTables":differences,"tables":restored}
    assert stable and not differences, result["backupRestore"]
    result["storageBackupRestore"] = storage_backup_restore(OUT, RESTORE_DB)
    print("Backup restore matched; recovery test now uses only the isolated restore.", flush=True)

    storage = f"/tmp/{RESTORE_DB}_storage"
    first = node("""
import {initialiseDatabase,intake} from './packages/server/index.ts';
import {claimJob,pool} from './packages/db/index.ts';
await initialiseDatabase();
const actor={userId:'system-check',email:'system-check@example.test',name:'System check',role:'reviewer',expiresAt:'2099-01-01T00:00:00Z'};
const csv='po_number,sku,quantity,unit,shipping_address\\nSYSTEM-RECOVERY,FB-0830-A2-100,2,pack,MAIN\\n';
const received=await intake(actor,{filename:'system-recovery.csv',mediaType:'text/csv',contentBase64:Buffer.from(csv).toString('base64'),channel:'upload',trustedCustomerId:'C001'});
await pool.query("UPDATE jobs SET available_at='1900-01-01' WHERE id=$1",[received.jobId]);
const job=await claimJob('system-crashed-owner',1);
if(job?.id!==received.jobId)throw Error('Unexpected job selected');
process.stdout.write(JSON.stringify({received,job})+'\\n',()=>process.kill(process.pid,'SIGKILL'));
""", database=RESTORE_DB, storage=storage, check=False)
    assert first.returncode in (137, -9), (first.returncode, first.stderr.decode())
    claimed = json.loads(first.stdout.decode().strip().splitlines()[-1])
    time.sleep(2)
    second = node("""
import {processMessage} from './packages/server/index.ts';
import {claimJob,heartbeatJob,pool} from './packages/db/index.ts';
import {parseInput} from './packages/ingestion/index.ts';
import {MockProvider} from './packages/ai/index.ts';
const job=await claimJob('system-recovered-owner',30);
if(!job)throw Error('No recovered job');
const staleHeartbeat=await heartbeatJob(job.id,'system-crashed-owner');
await processMessage(job,'system-recovered-owner',{parse:parseInput,provider:new MockProvider()});
let staleCommitCode=null;
try{await processMessage(job,'system-crashed-owner',{parse:parseInput,provider:new MockProvider()});}catch(e){staleCommitCode=e.code;}
const rows=(await pool.query("SELECT j.status,j.attempts,(SELECT count(*)::int FROM orders WHERE message_id=j.message_id) AS order_count,(SELECT count(*)::int FROM exports WHERE order_id=j.order_id) AS export_count FROM jobs j WHERE j.id=$1",[job.id])).rows[0];
console.log(JSON.stringify({jobId:job.id,staleHeartbeat,staleCommitCode,...rows}));
await pool.end();
""", database=RESTORE_DB, storage=storage)
    recovery = json.loads(second.stdout.decode().strip().splitlines()[-1])
    assert recovery == {"jobId":claimed["job"]["id"],"staleHeartbeat":False,"staleCommitCode":"STALE_VERSION",
                        "status":"succeeded","attempts":2,"order_count":1,"export_count":0}, recovery
    result["workerRecovery"] = {"crashedProcessExit":first.returncode,**recovery,
        "method":"SIGKILL after committed one-second lease, reclaim, real structured processing, stale-owner replay"}
    probe = command(COMPOSE + ["exec", "-T", "worker", "node", "--input-type=module", "-e", """
import net from 'node:net';
const internal=await fetch('http://app:3087/api/health',{signal:AbortSignal.timeout(5000)}).then(r=>r.status);
const tcp=await new Promise(resolve=>{const s=net.connect({host:'1.1.1.1',port:443});s.setTimeout(3000);s.once('connect',()=>{s.destroy();resolve('connected');});s.once('timeout',()=>{s.destroy();resolve('timeout');});s.once('error',e=>resolve(e.code));});
const https=await fetch('https://example.com',{signal:AbortSignal.timeout(3000)}).then(()=> 'connected').catch(e=>e.cause?.code||e.name);
console.log(JSON.stringify({internalHealthStatus:internal,externalTcp:tcp,externalHttps:https}));
"""])
    result["workerEgress"] = json.loads(probe.stdout.decode().strip())
    assert result["workerEgress"]["internalHealthStatus"] == 200
    assert result["workerEgress"]["externalTcp"] != "connected" and result["workerEgress"]["externalHttps"] != "connected"
    result["finishedAt"] = datetime.now(timezone.utc).isoformat()
    (OUT / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"resultPath":str((OUT / "result.json").relative_to(ROOT)),
        "catalogueHttp":result["catalogueHttp"],"restoreDatabase":RESTORE_DB,
        "allTableFingerprintsMatch":not differences,"workerRecovery":result["workerRecovery"],
        "workerEgress":result["workerEgress"]}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--storage-only", metavar="RESULT_DIRECTORY", help="Extend an existing successful run with storage backup/restore, without repeating HTTP checks")
    args = parser.parse_args()
    if args.storage_only:
        output_dir = (ROOT / args.storage_only).resolve()
        assert output_dir.is_relative_to(ROOT / "results/system-checks")
        result_path = output_dir / "result.json"
        result = json.loads(result_path.read_text())
        result["storageBackupRestore"] = storage_backup_restore(output_dir, result["restoreDatabase"])
        result_path.write_text(json.dumps(result,indent=2)+"\n")
        print(json.dumps(result["storageBackupRestore"],indent=2))
    else:
        main()
