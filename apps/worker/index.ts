import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { budgetRunId, claimJob, heartbeatJob, pool, recordHeartbeat, runMaintenance, validateEnv } from "@pennbridge/db";
import { purgeExpired } from "@pennbridge/server/auth";
import { initialiseDatabase, odooPushFailed, processMessage, processingFailed, runOdooPush } from "@pennbridge/server";
import { parseInput } from "@pennbridge/ingestion";
import { createProvider } from "@pennbridge/ai";

process.env.PB_ROLE = "worker";
const owner=`worker-${randomUUID()}`;
const aliveFile=process.env.WORKER_ALIVE_FILE??"/tmp/worker.alive";
const log=(event:string,extra:Record<string,unknown>={})=>console.log(JSON.stringify({event,...extra}));
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
let stopping=false;
process.on("SIGTERM",()=>{stopping=true;});process.on("SIGINT",()=>{stopping=true;});
// Anything unexpected: log and exit non-zero so the container restart policy brings a clean process back.
process.on("uncaughtException",(error)=>{console.error(JSON.stringify({event:"worker.fatal",message:error.message}));process.exit(1);});
process.on("unhandledRejection",(error)=>{console.error(JSON.stringify({event:"worker.fatal",message:String((error as Error)?.message??error)}));process.exit(1);});

// The app holds no model key, so the worker reports which extractor it really runs (shown in the desk header).
const extraction=(()=>{const mode=createProvider({runId:"probe",orderId:"probe"}).mode;const live=mode==="live";return {mode,provider:live?(process.env.AI_PROVIDER==="gemini"?"gemini":"anthropic"):mode,model:live?process.env.EXTRACTION_MODEL||null:null};})();
try{validateEnv();}catch(error){console.error(JSON.stringify({event:"worker.config_invalid",message:(error as Error).message}));process.exit(78);}
for(let attempt=1;!stopping;attempt++){
  try{await initialiseDatabase();break;}
  catch(error){console.error(JSON.stringify({event:"worker.init_failed",attempt,message:(error as Error).message}));await sleep(Math.min(30000,1000*2**Math.min(attempt,5)));}
}
log("worker.started",{owner,mode:process.env.LIVE_AI_ENABLED==="true"?"live":"mock",provider:process.env.LIVE_AI_ENABLED==="true"?process.env.AI_PROVIDER:undefined,model:process.env.LIVE_AI_ENABLED==="true"?process.env.EXTRACTION_MODEL:undefined});

// The container healthcheck reads the file's age; the database heartbeat feeds /api/ready. Both survive a long model call.
let beatFailing=false;
const beat=async()=>{
  await writeFile(aliveFile,String(Date.now())).catch(()=>{});
  try{await recordHeartbeat("worker",{owner,extraction});beatFailing=false;}catch(error){if(!beatFailing)console.error(JSON.stringify({event:"worker.heartbeat_failed",message:(error as Error).message}));beatFailing=true;}
};
// The mailbox container writes status.json/alert.json into its state volume (mounted read-only here); relay them into readiness.
const mailboxDir=process.env.MAILBOX_STATE_DIR;
const relayMailbox=async()=>{
  if(!mailboxDir)return;
  const read=async(name:string)=>JSON.parse(await readFile(`${mailboxDir}/${name}`,"utf8").catch(()=>"null"));
  const status=await read("status.json");if(!status?.at)return;
  const alert=await read("alert.json");
  await recordHeartbeat("mailbox_poll",{intervalSeconds:Number(process.env.MAILBOX_POLL_SECONDS??60),error:alert?.code??(status.ok?undefined:status.errorCode??"poll_failed")},new Date(status.at)).catch(()=>{});
};
const beatTimer=setInterval(()=>{void beat();void relayMailbox();},15000);void beat();
let lastMaintenance=0;
const maintain=async()=>{
  if(Date.now()-lastMaintenance<300000)return;lastMaintenance=Date.now();
  try{const result=await runMaintenance();const auth=await purgeExpired();if(result.sessionsPurged||result.reservationsReleased||auth.sessions||auth.throttles)log("worker.maintenance",{...result,auth});}
  catch(error){console.error(JSON.stringify({event:"worker.maintenance_failed",message:(error as Error).message}));}
};

let idleFailures=0;
while(!stopping) {
  let job;
  try{job=await claimJob(owner);idleFailures=0;}
  catch(error){
    // Database restarting or briefly unreachable: back off instead of dying.
    idleFailures++;console.error(JSON.stringify({event:"worker.claim_failed",failures:idleFailures,message:(error as Error).message}));
    await sleep(Math.min(30000,500*2**Math.min(idleFailures,6)));continue;
  }
  if(!job) { await maintain();await sleep(500);continue; }
  const heartbeat=setInterval(()=>{void heartbeatJob(job.id,owner).catch(()=>{/* commit checks lease */});},30000);
  try {
    if(job.type==="odoo_push"){await runOdooPush(job,owner);log("job.completed",{jobId:job.id,type:job.type});continue;}
    if(job.type!=="process_message")throw new Error(`Unsupported job type: ${job.type}`);
    // The model budget is a calendar-month cap (Europe/London) unless a benchmark run id is forced.
    const provider=createProvider({runId:process.env.BENCHMARK_RUN_ID??budgetRunId(),orderId:job.orderId!});
    await processMessage(job,owner,{parse:parseInput,provider});
    log("job.completed",{jobId:job.id});
  } catch(error) {
    try{await (job.type==="odoo_push"?odooPushFailed:processingFailed)(job,owner,error);}
    catch(inner){console.error(JSON.stringify({event:"job.fail_record_failed",jobId:job.id,message:(inner as Error).message}));}
    console.error(JSON.stringify({event:"job.failed",jobId:job.id,code:(error as {code?:string}).code??"PARSING_FAILED"}));
  } finally {clearInterval(heartbeat);}
}
clearInterval(beatTimer);
await pool.end();
