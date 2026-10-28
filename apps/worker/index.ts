import { randomUUID } from "node:crypto";
import { claimJob, heartbeatJob, pool } from "@pennbridge/db";
import { initialiseDatabase, processMessage, processingFailed } from "@pennbridge/server";
import { parseInput } from "@pennbridge/ingestion";
import { createProvider } from "@pennbridge/ai";

const owner=`worker-${randomUUID()}`;
let stopping=false;
process.on("SIGTERM",()=>{stopping=true;});process.on("SIGINT",()=>{stopping=true;});
await initialiseDatabase();
console.log(JSON.stringify({event:"worker.started",owner,mode:process.env.LIVE_AI_ENABLED==="true"?"live":"mock",provider:process.env.LIVE_AI_ENABLED==="true"?process.env.AI_PROVIDER:undefined,model:process.env.LIVE_AI_ENABLED==="true"?process.env.EXTRACTION_MODEL:undefined}));
while(!stopping) {
  const job=await claimJob(owner);
  if(!job) { await new Promise(resolve=>setTimeout(resolve,500));continue; }
  const heartbeat=setInterval(()=>{void heartbeatJob(job.id,owner).catch(()=>{/* commit checks lease */});},30000);
  try {
    if(job.type!=="process_message")throw new Error(`Unsupported job type: ${job.type}`);
    const provider=createProvider({runId:process.env.BENCHMARK_RUN_ID??"local-demo",orderId:job.orderId!});
    await processMessage(job,owner,{parse:parseInput,provider});
    console.log(JSON.stringify({event:"job.completed",jobId:job.id}));
  } catch(error) {
    await processingFailed(job,owner,error);
    console.error(JSON.stringify({event:"job.failed",jobId:job.id,code:(error as {code?:string}).code??"PARSING_FAILED"}));
  } finally {clearInterval(heartbeat);}
}
await pool.end();
