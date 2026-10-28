import { afterAll,beforeAll,describe,expect,it } from "vitest";
import { randomUUID } from "node:crypto";
import type { ExtractedOrder,ExtractionProvider,Session } from "../packages/contracts";
import { approveOrder,cancelOrder,downloadExport,editOrder,exportOrder,getOrder,initialiseDatabase,intake,login,logout,processMessage,session,setOdooUnitMapping,verifyExport } from "../packages/server";
import { claimJob,heartbeatJob,pool,reserveModelBudget,settleModelBudget } from "../packages/db";
const enabled=process.env.CORE_DB_TEST==="true";
const run=randomUUID();
let reviewer:Session,admin:Session,viewer:Session;
function orderInput(po:string):ExtractedOrder{return {schemaVersion:1,intent:"new_order",poNumber:po,relatedPoNumber:null,revision:null,requestedDeliveryDate:null,requestedAddress:"MAIN",currency:"GBP",quotedTotal:null,evidence:[],reasons:[],lines:[{id:"L1",position:1,rawText:"2 packs FB-0830-A2-100",sku:"FB-0830-A2-100",manufacturerReference:null,customerAlias:null,description:"FB-0830-A2-100",quantity:"2",unit:"pack",originalUnit:"packs",quotedUnitPrice:null,attributes:{},evidenceIds:[]}]};}
async function newOrder(po:string,content=`${run}:${po}`,quantityOverride?:string){
  const received=await intake(reviewer,{filename:"test.txt",mediaType:"text/plain",contentBase64:Buffer.from(content).toString("base64"),channel:"upload",trustedCustomerId:"C001"});
  const job=await claimJob(`test-${run}`);expect(job?.id).toBe(received.jobId);
  const sourceOrder=orderInput(po);if(quantityOverride)sourceOrder.lines[0].quantity=quantityOverride;
  const provider:ExtractionProvider={mode:"mock",extract:async()=>({extracted:sourceOrder,usage:null})};
  await processMessage(job!,`test-${run}`,{parse:async()=>({documents:[],evidence:[],text:content}),provider});
  return getOrder(reviewer,received.orderId!);
}

describe.skipIf(!enabled)("real PostgreSQL lifecycle",()=>{
  beforeAll(async()=>{
    if(!/test/i.test(new URL(process.env.DATABASE_URL!).pathname))throw new Error("CORE_DB_TEST requires an isolated database whose name contains test");
    await initialiseDatabase();
    reviewer=(await login("reviewer@pennbridge.example","reviewer-demo")).session;admin=(await login("admin@pennbridge.example","admin-demo")).session;viewer=(await login("viewer@pennbridge.example","viewer-demo")).session;
    setOdooUnitMapping({pack:"pennbridge.uom_pack"});
  });
  afterAll(async()=>{await pool.end();});
  it("hash/version approval invalidation, concurrent reviewers and idempotent exports",async()=>{
    const detail=await newOrder(`TEST-${run}`);let order=detail.order;expect(order.status).toBe("draft_ready");expect(order.total).toBe("20.00");
    await expect(approveOrder(viewer,order.id,{expectedVersion:order.version,contentHash:order.contentHash})).rejects.toMatchObject({status:403});
    order=(await approveOrder(reviewer,order.id,{expectedVersion:order.version,contentHash:order.contentHash})).order;expect(order.approval).not.toBeNull();
    order=(await editOrder(reviewer,order.id,{expectedVersion:order.version,patch:{poNumber:`EDIT-${run}`}})).order;expect(order.approval).toBeNull();expect(order.version).toBe(3);
    await expect(exportOrder(reviewer,order.id,{expectedVersion:order.version,idempotencyKey:`premature-${run}`})).rejects.toMatchObject({code:"APPROVAL_REQUIRED"});
    const races=await Promise.allSettled([editOrder(reviewer,order.id,{expectedVersion:order.version,patch:{poNumber:`RACE-A-${run}`}}),editOrder(reviewer,order.id,{expectedVersion:order.version,patch:{poNumber:`RACE-B-${run}`}})]);
    expect(races.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(races.find(r=>r.status==="rejected")).toMatchObject({reason:{code:"STALE_VERSION"}});
    order=(await getOrder(reviewer,order.id)).order;
    order=(await approveOrder(reviewer,order.id,{expectedVersion:order.version,contentHash:order.contentHash})).order;
    const exports=await Promise.all([exportOrder(reviewer,order.id,{expectedVersion:order.version,idempotencyKey:`export-${run}`}),exportOrder(reviewer,order.id,{expectedVersion:order.version,idempotencyKey:`export-${run}`})]);expect(exports[0].id).toBe(exports[1].id);
    const count=await pool.query("SELECT count(*)::int AS n FROM exports WHERE order_id=$1",[order.id]);expect(count.rows[0].n).toBe(1);
    expect(exports[0].state).toBe("prepared");const download=await downloadExport(reviewer,order.id,exports[0].id);expect(download.content.toString()).toContain("order_line/product_id/id");expect(download.content.toString()).toContain("pennbridge.product_FB-0830-A2-100");
    const verified=await verifyExport(reviewer,order.id,exports[0].id,{quotationReference:"SYNTHETIC-TEST-ONLY"});expect(verified.state).toBe("import_verified");expect(verified.verifiedBy).toBe(reviewer.userId);
    await expect(cancelOrder(reviewer,order.id,{expectedVersion:order.version,reason:"cancel"})).rejects.toMatchObject({code:"ALREADY_EXPORTED"});
  });
  it("deduplicates concurrent intake and routes changed PO content to amendment review",async()=>{
    const input={filename:"dedupe.txt",mediaType:"text/plain",contentBase64:Buffer.from(`dedupe-${run}`).toString("base64"),channel:"upload" as const,trustedCustomerId:"C001"};
    const received=await Promise.all([intake(reviewer,input),intake(reviewer,input)]);expect(received[0].messageId).toBe(received[1].messageId);expect(received.filter(r=>r.duplicate)).toHaveLength(1);
    const job=await claimJob(`test-${run}`);await processMessage(job!,`test-${run}`,{parse:async()=>({documents:[],evidence:[],text:"test"}),provider:{mode:"mock",extract:async()=>({extracted:orderInput(`DUP-${run}`),usage:null})}});
    const amended=await newOrder(`DUP-${run}`,`changed-content-${run}`,"3");expect(amended.order.status).toBe("amendment_review");expect(amended.order.relatedOrderId).toBe(received[0].orderId);
  });
  it("scopes identical content to customer identity and rejects conflicting transport reuse",async()=>{
    const contentBase64=Buffer.from(`same-content-different-account-${run}`).toString("base64");
    const first=await intake(reviewer,{filename:"scoped.csv",mediaType:"text/plain",contentBase64,channel:"upload",trustedCustomerId:"C001"});
    const second=await intake(reviewer,{filename:"scoped.csv",mediaType:"text/plain",contentBase64,channel:"upload",trustedCustomerId:"C002"});
    expect(first.messageId).not.toBe(second.messageId);expect(first.orderId).not.toBe(second.orderId);expect(second.duplicate).toBe(false);
    for(const [i,received] of [first,second].entries()) {
      const job=await claimJob(`test-${run}`);expect(job?.id).toBe(received.jobId);await processMessage(job!,`test-${run}`,{parse:async()=>({documents:[],evidence:[],text:"test"}),provider:{mode:"mock",extract:async()=>({extracted:orderInput(`SCOPE-${run}-${i}`),usage:null})}});
    }
    expect((await getOrder(reviewer,second.orderId!)).order.customerId).toBe("C002");
    const transport={filename:"transport.txt",mediaType:"text/plain",contentBase64:Buffer.from(`transport-${run}`).toString("base64"),channel:"upload" as const,externalMessageId:`event-${run}`,trustedCustomerId:"C001"};
    const received=await intake(reviewer,transport);
    await expect(intake(reviewer,{...transport,trustedCustomerId:"C002"})).rejects.toMatchObject({code:"DUPLICATE_MESSAGE",status:409});
    await expect(intake(reviewer,{...transport,contentBase64:Buffer.from(`changed-${run}`).toString("base64")})).rejects.toMatchObject({code:"DUPLICATE_MESSAGE",status:409});
    const job=await claimJob(`test-${run}`);expect(job?.id).toBe(received.jobId);await processMessage(job!,`test-${run}`,{parse:async()=>({documents:[],evidence:[],text:"test"}),provider:{mode:"mock",extract:async()=>({extracted:orderInput(`TRANSPORT-${run}`),usage:null})}});
  });
  it("editing cannot erase duplicate-PO review and original orders remain independently valid",async()=>{
    const original=await newOrder(`EDIT-DUP-${run}`);const duplicate=await newOrder(`EDIT-DUP-${run}`,`second-draft-${run}`,"3");
    expect(duplicate.order.status).toBe("amendment_review");
    const edited=await editOrder(reviewer,duplicate.order.id,{expectedVersion:duplicate.order.version,patch:{requestedDeliveryDate:"2026-11-10"}});
    expect(edited.order.status).toBe("amendment_review");expect(edited.order.reasons.map(r=>r.code)).toContain("DUPLICATE_PO");
    await expect(approveOrder(reviewer,edited.order.id,{expectedVersion:edited.order.version,contentHash:edited.order.contentHash})).rejects.toMatchObject({code:"DUPLICATE_PO"});
    expect((await approveOrder(reviewer,original.order.id,{expectedVersion:original.order.version,contentHash:original.order.contentHash})).order.status).toBe("approved");
    const corrected=await editOrder(reviewer,edited.order.id,{expectedVersion:edited.order.version,patch:{poNumber:`UNIQUE-EDIT-${run}`}});expect(corrected.order.status).toBe("draft_ready");expect(corrected.order.relatedOrderId).toBeNull();
  });
  it("unrelated edits retain original currency and total exceptions",async()=>{
    const received=await intake(reviewer,{filename:"currency.txt",mediaType:"text/plain",contentBase64:Buffer.from(`currency-${run}`).toString("base64"),channel:"upload",trustedCustomerId:"C001"});
    const job=await claimJob(`test-${run}`);const extracted=orderInput(`CURRENCY-${run}`);extracted.currency="EUR";extracted.quotedTotal="99.00";
    await processMessage(job!,`test-${run}`,{parse:async()=>({documents:[],evidence:[],text:"test"}),provider:{mode:"mock",extract:async()=>({extracted,usage:null})}});
    const before=(await getOrder(reviewer,received.orderId!)).order;
    const edited=(await editOrder(reviewer,before.id,{expectedVersion:before.version,patch:{poNumber:`CURRENCY-EDIT-${run}`}})).order;
    expect(edited.reasons.map(r=>r.code)).toEqual(expect.arrayContaining(["CURRENCY_MISMATCH","TOTAL_MISMATCH"]));expect(edited.status).toBe("needs_review");
  });
  it("expired leases can be reclaimed and stale owners cannot heartbeat",async()=>{
    const received=await intake(reviewer,{filename:"lease.txt",mediaType:"text/plain",contentBase64:Buffer.from(`lease-${run}`).toString("base64"),channel:"upload"});
    const first=await claimJob("old-owner");expect(first?.id).toBe(received.jobId);await pool.query("UPDATE jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1",[first!.id]);
    const second=await claimJob("new-owner");expect(second?.id).toBe(first!.id);expect(second?.attempts).toBe(2);expect(await heartbeatJob(first!.id,"old-owner")).toBe(false);
    await pool.query("UPDATE jobs SET status='dead_letter',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",[first!.id]);
  });
  it("budget reservations serialize concurrency and retain unknown costs",async()=>{
    const runId=`budget-${run}`;
    const results=await Promise.allSettled([reserveModelBudget(runId,"O1","0.06","0.10","0.10"),reserveModelBudget(runId,"O2","0.06","0.10","0.10")]);expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
    const reserved=results.find(r=>r.status==="fulfilled") as PromiseFulfilledResult<string>;await settleModelBudget(reserved.value,null);
    expect((await pool.query("SELECT reserved_usd FROM budget_runs WHERE id=$1",[runId])).rows[0].reserved_usd).toBe("0.060000");
    await settleModelBudget(reserved.value,"0.02");await settleModelBudget(reserved.value,"0.02");
    const budget=(await pool.query("SELECT spent_usd,reserved_usd FROM budget_runs WHERE id=$1",[runId])).rows[0];expect(budget.spent_usd).toBe("0.020000");expect(budget.reserved_usd).toBe("0.000000");
  });
  it("sessions are stored hashed and logout revokes the token",async()=>{
    const auth=await login("viewer@pennbridge.example","viewer-demo");expect((await session(auth.token))?.role).toBe("viewer");expect((await pool.query("SELECT count(*)::int AS n FROM sessions WHERE token_hash=$1",[auth.token])).rows[0].n).toBe(0);await logout(auth.token);expect(await session(auth.token)).toBeNull();
  });
});
