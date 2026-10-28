import { afterAll,beforeAll,describe,expect,it } from "vitest";
import { randomUUID } from "node:crypto";
import type { ExtractedOrder,ExtractionProvider,Session } from "../packages/contracts";
import { addLine,approveOrder,assignCustomer,cancelOrder,deleteSenderMapping,downloadExport,editOrder,exportOrder,getOrder,initialiseDatabase,intake,listCatalogue,listCustomers,listOrders,listSenderMappings,login,processMessage,processingFailed,removeLine,reprocessOrder,setOdooUnitMapping,upsertSenderMapping,verifyExport,voidExport } from "../packages/server";
import { claimJob,pool } from "../packages/db";
import { parseInput } from "../packages/ingestion";

const enabled=process.env.WORKFLOW_DB_TEST==="true";
const run=randomUUID(),tag=run.slice(0,8);
const owner=`wf-${tag}`;
let admin:Session,reviewer:Session,viewer:Session,mainAddress:string,seq=0;

const fixed=(po:string,over:{qty?:string;quoted?:string|null;address?:string|null;sku?:string}={}):ExtractionProvider=>({mode:"mock",extract:async()=>({usage:null,extracted:{schemaVersion:1,intent:"new_order",poNumber:po,relatedPoNumber:null,revision:null,requestedDeliveryDate:null,requestedAddress:over.address===undefined?"MAIN":over.address,currency:"GBP",quotedTotal:null,evidence:[],reasons:[],
  lines:[{id:"L1",position:1,rawText:`${over.qty??"2"} packs ${over.sku??"FB-0830-A2-100"}`,sku:over.sku??"FB-0830-A2-100",manufacturerReference:null,customerAlias:null,description:over.sku??"FB-0830-A2-100",quantity:over.qty??"2",unit:"pack",originalUnit:"packs",quotedUnitPrice:over.quoted===undefined?null:over.quoted,attributes:{},evidenceIds:[]}]} as ExtractedOrder})});
const failing=(error:unknown):ExtractionProvider=>({mode:"mock",extract:async()=>{throw error;}});
function eml(from:string,po:string,extraHeaders:string[]=[]){
  return Buffer.from(["From: Buyer <"+from+">","To: orders@pennbridge.example",`Subject: Order ${po}`,`Message-ID: <${run}-${++seq}@test.example>`,...extraHeaders,"",`Please supply 2 packs FB-0830-A2-100 for ${po}. Deliver MAIN.`,""].join("\r\n"));
}
async function receive(o:{po:string;from?:string;trusted?:string;headers?:string[];provider?:ExtractionProvider;fail?:unknown}) {
  const content=eml(o.from??`nobody-${tag}@unmapped.example`,o.po,o.headers);
  const receipt=await intake(admin,{filename:"order.eml",mediaType:"message/rfc822",contentBase64:content.toString("base64"),channel:o.trusted?"upload":"email",externalMessageId:`${run}-${++seq}`,trustedCustomerId:o.trusted});
  return {receipt,...await runJob(receipt.jobId!,o.provider??fixed(o.po),o.fail)};
}
async function runJob(jobId:string,provider:ExtractionProvider,fail?:unknown) {
  const job=await claimJob(owner);expect(job?.id).toBe(jobId);
  if(fail!==undefined) await processingFailed(job!,owner,fail); else await processMessage(job!,owner,{parse:parseInput,provider});
  return {job:job!};
}
const orderOf=async(receipt:{orderId:string|null})=>(await getOrder(admin,receipt.orderId!));
const reasonCodes=(d:Awaited<ReturnType<typeof getOrder>>)=>[...d.order.reasons,...d.order.lines.flatMap(l=>l.reasons)].map(r=>r.code);

describe.skipIf(!enabled)("W2 order workflow on real PostgreSQL",()=>{
  beforeAll(async()=>{
    if(!/test/i.test(new URL(process.env.DATABASE_URL!).pathname))throw new Error("WORKFLOW_DB_TEST requires an isolated database whose name contains test");
    process.env.DEMO_MODE="true"; // demo users are seeded only in demo mode
    await initialiseDatabase();
    admin=(await login("admin@pennbridge.example","admin-demo")).session;reviewer=(await login("reviewer@pennbridge.example","reviewer-demo")).session;viewer=(await login("viewer@pennbridge.example","viewer-demo")).session;
    mainAddress=(await listCustomers(admin)).addresses.find(a=>a.customerId==="C001"&&a.label==="MAIN")!.id;
    setOdooUnitMapping({pack:"pennbridge.uom_pack"});
  });
  afterAll(async()=>{await pool.end();});

  describe("sender mapping",()=>{
    it("an untrusted mapping is only a suggestion; confirming it reprices to the agreement price",async()=>{
      const from=`suggest-${tag}@alderwick-buyers.example`;
      await expect(upsertSenderMapping(reviewer,{kind:"email",value:from,customerId:"C001",trusted:false})).rejects.toMatchObject({status:403});
      const mapping=await upsertSenderMapping(admin,{kind:"email",value:from.toUpperCase(),customerId:"C001",trusted:false});
      expect(mapping).toMatchObject({value:from,trusted:false,customerName:"Alderwick Engineering Ltd"});
      const { receipt }=await receive({po:`SUG-${tag}`,from,provider:fixed(`SUG-${tag}`,{quoted:"10.00"})});
      let d=await orderOf(receipt);
      expect(d.order.customerId).toBeNull();
      expect(d.order.suggestedCustomer).toMatchObject({customerId:"C001",matchedOn:"email",mappingId:mapping.id});
      expect(d.source.identitySource).not.toBe("sender_mapping");
      expect(d.order.senderEmail).toBe(from);
      expect(d.order.lines[0].unitPrice).toBe("12.00"); // list price: no account yet
      expect(d.order.reasons.find(r=>r.code==="UNVERIFIED_SENDER")?.message).toContain("Alderwick");
      expect(reasonCodes(d)).toContain("SHIPPING_ADDRESS_AMBIGUOUS");
      expect(reasonCodes(d)).toContain("PRICE_MISMATCH"); // source says 10.00, list says 12.00
      // Revalidation on assignment: agreement price, address resolved from the source text, mismatch gone.
      await expect(assignCustomer(viewer,d.order.id,{expectedVersion:d.order.version,customerId:"C001"})).rejects.toMatchObject({status:403});
      await expect(assignCustomer(reviewer,d.order.id,{expectedVersion:d.order.version,customerId:"NOPE"})).rejects.toMatchObject({status:400});
      d=await assignCustomer(reviewer,d.order.id,{expectedVersion:d.order.version,customerId:"C001"});
      expect(d.order.customerId).toBe("C001");expect(d.order.suggestedCustomer).toBeNull();
      expect(d.order.lines[0].unitPrice).toBe("10.00");expect(d.order.lines[0].priceAgreementVersion).not.toMatch(/^list:/);
      expect(d.order.total).toBe("20.00");
      expect(reasonCodes(d)).not.toContain("PRICE_MISMATCH");expect(reasonCodes(d)).not.toContain("UNVERIFIED_SENDER");expect(reasonCodes(d)).not.toContain("SHIPPING_ADDRESS_AMBIGUOUS");
      expect(d.order.shippingAddressId).toBe(mainAddress);expect(d.order.status).toBe("draft_ready");
      expect(d.audit.find(a=>a.action==="order.customer_assigned")?.detail).toMatchObject({customerId:"C001",viaSuggestion:true,repriced:true});
      await deleteSenderMapping(admin,mapping.id);
      await expect(deleteSenderMapping(admin,mapping.id)).rejects.toMatchObject({status:404});
    });
    it("a trusted mapping assigns the customer, unless the sender fails SPF/DKIM/DMARC",async()=>{
      const from=`trusted-${tag}@alderwick-buyers.example`;
      await upsertSenderMapping(admin,{kind:"email",value:from,customerId:"C001",trusted:true});
      const ok=await orderOf((await receive({po:`TRU-${tag}`,from,headers:["Authentication-Results: mx.example; dkim=pass; spf=pass; dmarc=pass"]})).receipt);
      expect(ok.order.customerId).toBe("C001");expect(ok.source.identitySource).toBe("sender_mapping");expect(ok.order.lines[0].unitPrice).toBe("10.00");
      expect(reasonCodes(ok)).not.toContain("UNVERIFIED_SENDER");expect(ok.order.status).toBe("draft_ready");
      // Spoofed From: the receiving server saw dkim=fail, so the trusted mapping must not apply.
      const spoof=await orderOf((await receive({po:`SPF-${tag}`,from,headers:["Authentication-Results: mx.example; dkim=fail header.d=alderwick-buyers.example; spf=pass"]})).receipt);
      expect(spoof.order.customerId).toBeNull();expect(reasonCodes(spoof)).toContain("UNVERIFIED_SENDER");
      expect(spoof.order.suggestedCustomer).toMatchObject({customerId:"C001",note:expect.stringMatching(/forged/)});
      // By default a positive result is required: no header means suggestion only.
      const none=await orderOf((await receive({po:`NOA-${tag}`,from})).receipt);expect(none.order.customerId).toBeNull();
      // Only the topmost (receiving server's) header counts; a forged lower "pass" header must not help.
      const forged=await orderOf((await receive({po:`FRG-${tag}`,from,headers:["Authentication-Results: mx.example; spf=none; dmarc=none","Authentication-Results: attacker.example; dkim=pass; spf=pass; dmarc=pass"]})).receipt);
      expect(forged.order.customerId).toBeNull();expect(forged.order.suggestedCustomer).toMatchObject({customerId:"C001"});
      // REQUIRE_SENDER_AUTH=false relaxes to "did not fail".
      process.env.REQUIRE_SENDER_AUTH="false";
      try{
        const relaxed=await orderOf((await receive({po:`RLX-${tag}`,from})).receipt);expect(relaxed.order.customerId).toBe("C001");
      } finally {delete process.env.REQUIRE_SENDER_AUTH;}
    });
    it("domain mappings, approvedSenders fallback, free-mail guard and unknown senders",async()=>{
      await expect(upsertSenderMapping(admin,{kind:"domain",value:"gmail.com",customerId:"C001",trusted:true})).rejects.toMatchObject({status:400});
      await expect(upsertSenderMapping(admin,{kind:"domain",value:"not a domain",customerId:"C001",trusted:false})).rejects.toMatchObject({status:400});
      await expect(upsertSenderMapping(admin,{kind:"email",value:"a@b.example",customerId:"NOPE",trusted:false})).rejects.toMatchObject({status:400});
      const domain=`dom-${tag}.example`;
      await upsertSenderMapping(admin,{kind:"domain",value:domain,customerId:"C002",trusted:true});
      // An exact (untrusted) address mapping outranks the trusted domain mapping.
      await upsertSenderMapping(admin,{kind:"email",value:`special@${domain}`,customerId:"C001",trusted:false});
      const viaDomain=await orderOf((await receive({po:`DOM-${tag}`,from:`anyone@${domain}`,headers:["Authentication-Results: mx.example; dkim=pass; spf=pass; dmarc=pass"]})).receipt);
      expect(viaDomain.order.customerId).toBe("C002");
      const viaEmail=await orderOf((await receive({po:`EML-${tag}`,from:`special@${domain}`})).receipt);
      expect(viaEmail.order.customerId).toBeNull();expect(viaEmail.order.suggestedCustomer).toMatchObject({customerId:"C001",matchedOn:"email"});
      // customers.approvedSenders only ever suggests.
      const approved=await orderOf((await receive({po:`APP-${tag}`,from:"mia@alderwick.example"})).receipt);
      expect(approved.order.customerId).toBeNull();expect(approved.order.suggestedCustomer).toMatchObject({customerId:"C001",matchedOn:"approved_sender",mappingId:null});
      const stranger=await orderOf((await receive({po:`STR-${tag}`})).receipt);
      expect(stranger.order.suggestedCustomer).toBeNull();
      expect((await listSenderMappings(reviewer)).some(m=>m.value===domain&&m.trusted)).toBe(true);
      await expect(listSenderMappings(viewer)).rejects.toMatchObject({status:403});
    });
  });

  describe("manual path",()=>{
    it("add/remove line are audited, need a reason, invalidate approval and keep resolutions",async()=>{
      const po=`LIN-${tag}`;
      const { receipt }=await receive({po,trusted:"C001"});
      let d=await orderOf(receipt);expect(d.order.status).toBe("draft_ready");
      d=await approveOrder(reviewer,d.order.id,{expectedVersion:d.order.version,contentHash:d.order.contentHash});expect(d.order.approval).not.toBeNull();
      const product=(await listCatalogue(admin,{q:"BR-6204-ZZ"}))[0];expect(product).toBeTruthy();
      const base={expectedVersion:d.order.version,reason:"Customer phoned to add bearings",line:{productId:product.id,description:"Phoned-in bearings",quantity:"3",unit:product.sellingUnit}};
      await expect(addLine(viewer,d.order.id,base)).rejects.toMatchObject({status:403});
      await expect(addLine(reviewer,d.order.id,{...base,reason:"  "})).rejects.toThrow();
      await expect(addLine(reviewer,d.order.id,{...base,expectedVersion:d.order.version+5})).rejects.toMatchObject({code:"STALE_VERSION"});
      const before=d.order;
      d=await addLine(reviewer,d.order.id,base);
      expect(d.order.version).toBe(before.version+1);expect(d.order.approval).toBeNull();expect(d.order.status).not.toBe("approved");
      expect(d.order.lines).toHaveLength(2);const added=d.order.lines[1];
      expect(added.id).toMatch(/^manual-/);expect(added.productId).toBe(product.id);expect(added.matchMethod).toBe("manual");expect(added.lineTotal).not.toBeNull();
      expect(d.order.total).not.toBe(before.total);
      expect(d.audit.find(a=>a.action==="line.added")?.detail).toMatchObject({lineId:added.id,reason:"Customer phoned to add bearings",approvalInvalidated:true});
      expect((await pool.query("SELECT data->>'invalidatedAt' AS at FROM approvals WHERE id=$1",[before.approval!.id])).rows[0].at).not.toBeNull();
      await expect(removeLine(reviewer,d.order.id,"nope",{expectedVersion:d.order.version,reason:"x"})).rejects.toMatchObject({status:404});
      d=await removeLine(reviewer,d.order.id,added.id,{expectedVersion:d.order.version,reason:"Customer changed their mind"});
      expect(d.order.lines).toHaveLength(1);expect(d.order.total).toBe(before.total);
      expect(d.order.removedLines).toEqual([expect.objectContaining({id:added.id,reason:"Customer changed their mind",removedBy:reviewer.userId})]);
      expect(d.audit.find(a=>a.action==="line.removed")?.detail).toMatchObject({lineId:added.id,reason:"Customer changed their mind"});
      expect(d.order.status).toBe("draft_ready");
      // Removing a source line is allowed (reasoned) and must not leave a dangling completeness flag.
      d=await removeLine(reviewer,d.order.id,"L1",{expectedVersion:d.order.version,reason:"Duplicate of another PO line"});
      expect(d.order.lines).toHaveLength(0);expect(reasonCodes(d)).toContain("NO_ORDER_LINES");expect(d.order.removedLines).toHaveLength(2);
      await expect(approveOrder(reviewer,d.order.id,{expectedVersion:d.order.version,contentHash:d.order.contentHash})).rejects.toMatchObject({code:"VALIDATION_FAILED"});
    });
    it("adds a line by SKU and reports unknown SKUs instead of guessing",async()=>{
      const { receipt }=await receive({po:`SKU-${tag}`,trusted:"C001"});
      let d=await orderOf(receipt);
      d=await addLine(reviewer,d.order.id,{expectedVersion:d.order.version,reason:"By SKU",line:{sku:"fb-0830-a2-100",description:"more bolts",quantity:"1",unit:"pack"}});
      expect(d.order.lines[1]).toMatchObject({selectedSku:"FB-0830-A2-100",matchMethod:"exact_sku",unitPrice:"10.00"});
      d=await addLine(reviewer,d.order.id,{expectedVersion:d.order.version,reason:"Typo",line:{sku:"NOPE-999",description:"mystery",quantity:"1",unit:"pack"}});
      expect(d.order.lines[2].productId).toBeNull();expect(d.order.lines[2].reasons.map(r=>r.code)).toContain("NO_CATALOGUE_MATCH");expect(d.order.status).toBe("needs_review");
    });
    it("manual entry on a failed order: safe reason, then customer, PO, address and lines by hand",async()=>{
      const secret="sk-live-SECRET-123 at /app/packages/ai/index.ts";
      const { receipt,job }=await receive({po:`MAN-${tag}`,trusted:"C001",fail:Object.assign(new Error(`Gemini HTTP 400: ${secret}`),{code:"MODEL_UNAVAILABLE",status:400})});
      let d=await orderOf(receipt);
      expect(d.order.status).toBe("failed");expect(d.order.lines).toHaveLength(0);
      expect(JSON.stringify(d.order.reasons)).not.toMatch(/SECRET|\/app\//);
      const row=(await pool.query("SELECT status,attempts,error_message FROM jobs WHERE id=$1",[job.id])).rows[0];
      expect(row.status).toBe("dead_letter");expect(row.attempts).toBe(1);expect(row.error_message).not.toMatch(/SECRET|\/app\//);
      d=await editOrder(reviewer,d.order.id,{expectedVersion:d.order.version,patch:{poNumber:`MAN-${tag}`,shippingAddressId:mainAddress}});
      d=await addLine(reviewer,d.order.id,{expectedVersion:d.order.version,reason:"Entered from the PDF by hand",line:{sku:"FB-0830-A2-100",description:"Hex bolts",quantity:"2",unit:"pack"}});
      expect(d.order.intent).toBe("new_order");expect(d.order.processingMode).toBe("manual");expect(d.order.status).toBe("draft_ready");expect(d.order.total).toBe("20.00");
      expect(reasonCodes(d)).not.toContain("PARSING_FAILED");expect(reasonCodes(d)).not.toContain("MODEL_UNAVAILABLE");
      d=await approveOrder(reviewer,d.order.id,{expectedVersion:d.order.version,contentHash:d.order.contentHash});expect(d.order.status).toBe("approved");
    });
    it("manual-entry provider output (no lines, MODEL_UNAVAILABLE) becomes approvable after hand entry",async()=>{
      const provider:ExtractionProvider={mode:"manual",extract:async()=>({usage:null,extracted:{schemaVersion:1,intent:"unclear",poNumber:null,relatedPoNumber:null,revision:null,requestedDeliveryDate:null,requestedAddress:null,currency:null,quotedTotal:null,lines:[],evidence:[],reasons:[{code:"MODEL_UNAVAILABLE",message:"Automatic extraction is not configured.",severity:"blocking",lineId:null,evidenceIds:[],resolved:false,resolution:null}]}})};
      const { receipt }=await receive({po:`MEP-${tag}`,trusted:"C001",provider});
      let d=await orderOf(receipt);expect(d.order.processingMode).toBe("manual");expect(reasonCodes(d)).toContain("MODEL_UNAVAILABLE");
      d=await editOrder(reviewer,d.order.id,{expectedVersion:d.order.version,patch:{poNumber:`MEP-${tag}`,shippingAddressId:mainAddress}});
      d=await addLine(reviewer,d.order.id,{expectedVersion:d.order.version,reason:"Manual entry",line:{sku:"FB-0830-A2-100",description:"bolts",quantity:"1",unit:"pack"}});
      expect(d.order.status).toBe("draft_ready");expect(reasonCodes(d)).not.toContain("MODEL_UNAVAILABLE");
    });
    it("reprocess re-runs extraction, replaces edits, respects the per-order allowance and the active-job guard",async()=>{
      const po=`REP-${tag}`;
      const { receipt }=await receive({po,trusted:"C001",provider:fixed(po,{qty:"1"})});
      let d=await orderOf(receipt);expect(d.order.total).toBe("10.00");
      await expect(reprocessOrder(viewer,d.order.id,{expectedVersion:d.order.version})).rejects.toMatchObject({status:403});
      d=await reprocessOrder(reviewer,d.order.id,{expectedVersion:d.order.version});
      expect(d.order.status).toBe("parsing");expect(d.order.approval).toBeNull();
      expect(d.audit.find(a=>a.action==="order.reprocess_requested")?.detail).toMatchObject({run:1});
      const queued=d.jobs.filter(j=>j.status==="queued");expect(queued).toHaveLength(1);
      await expect(reprocessOrder(reviewer,d.order.id,{expectedVersion:d.order.version})).rejects.toMatchObject({status:409}); // already in progress
      await expect(editOrder(reviewer,d.order.id,{expectedVersion:d.order.version,patch:{poNumber:"X"}})).rejects.toMatchObject({code:"VALIDATION_FAILED"});
      await runJob(queued[0].id,fixed(po,{qty:"3"}));
      d=await getOrder(admin,d.order.id);expect(d.order.status).toBe("draft_ready");expect(d.order.total).toBe("30.00");expect(d.order.customerId).toBe("C001");
      for(const run of [2,3]){
        d=await reprocessOrder(reviewer,d.order.id,{expectedVersion:d.order.version});
        await runJob(d.jobs.find(j=>j.status==="queued")!.id,fixed(po,{qty:String(run+2)}));d=await getOrder(admin,d.order.id);
      }
      await expect(reprocessOrder(reviewer,d.order.id,{expectedVersion:d.order.version})).rejects.toMatchObject({code:"BUDGET_EXCEEDED"});
      d=await reprocessOrder(admin,d.order.id,{expectedVersion:d.order.version});expect(d.audit.filter(a=>a.action==="order.reprocess_requested")).toHaveLength(4);
      await runJob(d.jobs.find(j=>j.status==="queued")!.id,fixed(po));
      d=await getOrder(admin,d.order.id);
      d=await approveOrder(reviewer,d.order.id,{expectedVersion:d.order.version,contentHash:d.order.contentHash});
      await expect(reprocessOrder(admin,d.order.id,{expectedVersion:d.order.version})).rejects.toMatchObject({status:409}); // approved orders must be edited first
    });
  });

  describe("failure classification",()=>{
    it("permanent errors dead-letter immediately; transient ones back off and retry",async()=>{
      const permanent=await receive({po:`PERM-${tag}`,trusted:"C001",fail:Object.assign(new Error("Maximum document size is 10 MB."),{code:"FILE_TOO_LARGE",status:413})});
      let row=(await pool.query("SELECT status,attempts,error_code,error_message FROM jobs WHERE id=$1",[permanent.job.id])).rows[0];
      expect(row).toMatchObject({status:"dead_letter",attempts:1,error_code:"FILE_TOO_LARGE"});expect(row.error_message).toContain("10 MB");
      expect((await orderOf(permanent.receipt)).order.status).toBe("failed");
      const transient=await receive({po:`TRANS-${tag}`,trusted:"C001",fail:Object.assign(new Error("Gemini HTTP 503: <html>upstream</html>"),{code:"MODEL_UNAVAILABLE",status:503})});
      row=(await pool.query("SELECT status,attempts,error_code,error_message FROM jobs WHERE id=$1",[transient.job.id])).rows[0];
      expect(row).toMatchObject({status:"retry_wait",attempts:1,error_code:"MODEL_UNAVAILABLE"});expect(row.error_message).not.toContain("html");
      expect((await orderOf(transient.receipt)).order.status).toBe("received"); // still waiting, not failed
      await pool.query("UPDATE jobs SET status='dead_letter' WHERE id=$1",[transient.job.id]); // keep the queue clear for later tests
      const auth=await receive({po:`AUTH-${tag}`,trusted:"C001",fail:Object.assign(new Error("Gemini HTTP 401"),{code:"MODEL_UNAVAILABLE",status:401})});
      expect((await pool.query("SELECT status FROM jobs WHERE id=$1",[auth.job.id])).rows[0].status).toBe("dead_letter");
    });
  });

  describe("order list",()=>{
    it("sorts newest first with a stable composite cursor, including identical timestamps",async()=>{
      const made:string[]=[];
      for(let i=0;i<7;i++) made.push((await receive({po:`LST-${tag}-${i}`,trusted:i%2?"C001":"C002"})).receipt.orderId!);
      // Three rows share one timestamp; paging must neither repeat nor skip them.
      await pool.query("UPDATE orders SET created_at='2031-05-05T10:00:00.000Z' WHERE id=ANY($1)",[made.slice(0,3)]);
      await pool.query("UPDATE orders SET created_at='2031-05-05T11:00:00.000Z' WHERE id=$1",[made[3]]);
      const seen:string[]=[];let cursor:string|undefined;let pages=0;
      do { const page=await listOrders(viewer,{q:tag.toUpperCase()+" lst",limit:2,cursor});seen.push(...page.orders.map(o=>o.id));cursor=page.nextCursor??undefined;pages++; } while(cursor&&pages<10);
      expect(seen).toHaveLength(7);expect(new Set(seen).size).toBe(7);expect(new Set(seen)).toEqual(new Set(made));
      const dates=(await pool.query("SELECT id,created_at FROM orders WHERE id=ANY($1) ORDER BY created_at DESC,id DESC",[made])).rows;
      expect(seen).toEqual(dates.map(r=>r.id));
      expect(seen[0]).toBe(made[3]);
      await expect(listOrders(viewer,{cursor:"%%%"})).rejects.toMatchObject({status:400});
      await expect(listOrders(viewer,{cursor:Buffer.from("not-a-date|x").toString("base64url")})).rejects.toMatchObject({status:400});
      await expect(listOrders(viewer,{limit:500})).rejects.toThrow();
    });
    it("searches PO, customer, sender, SKU and subject; escapes wildcards; filters status, customer and London dates",async()=>{
      const from=`search-${tag}@findme.example`;
      const a=await receive({po:`SRCH-${tag}-A`,from});            // unverified
      const b=await receive({po:`SRCH-${tag}-B`,trusted:"C001"});  // Alderwick
      const q=(extra:string,more:Record<string,unknown>={})=>listOrders(viewer,{q:`srch-${tag} ${extra}`,...more}).then(r=>r.orders.map(o=>o.id));
      expect(await q("srch-"+tag+"-a")).toEqual([a.receipt.orderId]);               // PO
      expect(await q("ALDERWICK")).toEqual([b.receipt.orderId]);                    // customer name, case-insensitive
      expect(await q(from)).toEqual([a.receipt.orderId]);                           // sender
      expect((await q("fb-0830-a2-100")).sort()).toEqual([a.receipt.orderId!,b.receipt.orderId!].sort()); // SKU
      expect(await q("Order SRCH-"+tag+"-b")).toEqual([b.receipt.orderId]);         // subject (AND of terms)
      expect(await q("zzz-no-such-thing")).toEqual([]);
      expect(await listOrders(viewer,{q:"%"}).then(r=>r.orders)).toEqual([]);      // wildcards are literals
      expect(await listOrders(viewer,{q:"o_der"}).then(r=>r.orders.length)).toBe(0); // "_" must not match any character
      expect(await listOrders(viewer,{q:"o%der"}).then(r=>r.orders.length)).toBe(0);
      expect(await listOrders(viewer,{q:`srch-${tag}-a`}).then(r=>r.orders.length)).toBe(1); // "-" and digits are literal
      expect(await q("",{customerId:"C001"})).toEqual([b.receipt.orderId]);
      expect(await q("",{status:"draft_ready"})).toEqual([b.receipt.orderId]);
      // Dates are Europe/London days: 23:30Z in July is already the next London day.
      await pool.query("UPDATE orders SET created_at='2031-07-01T23:30:00.000Z' WHERE id=$1",[a.receipt.orderId]);
      expect(await q("",{dateFrom:"2031-07-02",dateTo:"2031-07-02"})).toEqual([a.receipt.orderId]);
      expect(await q("",{dateFrom:"2031-07-01",dateTo:"2031-07-01"})).toEqual([]);
      expect((await q("",{dateTo:"2031-07-02"})).sort()).toEqual([a.receipt.orderId!,b.receipt.orderId!].sort()); // inclusive upper bound; b was created today
      expect(await q("",{dateFrom:"2031-07-03"})).toEqual([]);
      await expect(listOrders(viewer,{dateFrom:"2031-02-30"})).rejects.toThrow();
      expect(await listOrders(viewer,{q:"",limit:"3"}).then(r=>r.orders.length)).toBe(3); // empty strings from a query string are ignored
    });
  });

  describe("export state machine",()=>{
    async function approved(po:string,description?:string) {
      let d=await orderOf((await receive({po,trusted:"C001"})).receipt);
      if(description) d=await editOrder(reviewer,d.order.id,{expectedVersion:d.order.version,patch:{lines:[{id:"L1",productId:d.order.lines[0].productId,quantity:"2",unit:"pack",quotedUnitPrice:null,description}]}});
      return approveOrder(reviewer,d.order.id,{expectedVersion:d.order.version,contentHash:d.order.contentHash});
    }
    it("allows prepared -> downloaded -> import_verified only in order, and replays verification idempotently",async()=>{
      const d=await approved(`EXP-${tag}`);
      const snap=await exportOrder(reviewer,d.order.id,{expectedVersion:d.order.version,idempotencyKey:`k1-${run}`});expect(snap.state).toBe("prepared");
      await expect(verifyExport(reviewer,d.order.id,snap.id,{quotationReference:"S00001"})).rejects.toMatchObject({status:409});
      const csv=(await downloadExport(reviewer,d.order.id,snap.id)).content.toString();expect(csv).toContain('"base.GBP"');
      let detail=await getOrder(admin,d.order.id);expect(detail.exports[0].state).toBe("downloaded");
      await downloadExport(reviewer,d.order.id,snap.id); // re-download is fine and stays downloaded
      await expect(verifyExport(viewer,d.order.id,snap.id,{quotationReference:"S00001"})).rejects.toMatchObject({status:403});
      const v=await verifyExport(reviewer,d.order.id,snap.id,{quotationReference:" S00001 "});expect(v).toMatchObject({state:"import_verified",quotationReference:"S00001",verifiedBy:reviewer.userId});
      expect(await verifyExport(admin,d.order.id,snap.id,{quotationReference:"S00001"})).toMatchObject({verifiedBy:reviewer.userId}); // idempotent: original verifier kept
      await expect(verifyExport(reviewer,d.order.id,snap.id,{quotationReference:"S99999"})).rejects.toMatchObject({status:409});
      await expect(voidExport(reviewer,d.order.id,snap.id,{reason:"oops"})).rejects.toMatchObject({status:409});
      detail=await getOrder(admin,d.order.id);expect(detail.audit.filter(a=>a.action==="export.import_verified")).toHaveLength(1);
    });
    it("void frees the version for a fresh export under a new key",async()=>{
      const d=await approved(`VOID-${tag}`);
      const snap=await exportOrder(reviewer,d.order.id,{expectedVersion:d.order.version,idempotencyKey:`k2-${run}`});
      await expect(voidExport(viewer,d.order.id,snap.id,{reason:"wrong file"})).rejects.toMatchObject({status:403});
      await expect(voidExport(reviewer,d.order.id,snap.id,{reason:""})).rejects.toThrow();
      const voided=await voidExport(reviewer,d.order.id,snap.id,{reason:"Wrong file"});expect(voided).toMatchObject({state:"voided",voidReason:"Wrong file",voidedBy:reviewer.userId});
      expect((await voidExport(reviewer,d.order.id,snap.id,{reason:"again"})).state).toBe("voided");
      await expect(downloadExport(reviewer,d.order.id,snap.id)).rejects.toMatchObject({status:409});
      await expect(verifyExport(reviewer,d.order.id,snap.id,{quotationReference:"S1"})).rejects.toMatchObject({status:409});
      expect((await getOrder(admin,d.order.id)).order.status).toBe("approved");
      await expect(exportOrder(reviewer,d.order.id,{expectedVersion:d.order.version,idempotencyKey:`k2-${run}`})).rejects.toMatchObject({status:409}); // voided key cannot be replayed
      const again=await exportOrder(reviewer,d.order.id,{expectedVersion:d.order.version,idempotencyKey:`k3-${run}`});
      expect(again.id).not.toBe(snap.id);expect(again.state).toBe("prepared");
      expect(await exportOrder(reviewer,d.order.id,{expectedVersion:d.order.version,idempotencyKey:`k3-${run}`})).toMatchObject({id:again.id}); // idempotent replay
      expect((await getOrder(admin,d.order.id)).order.status).toBe("exported");
      await expect(cancelOrder(reviewer,d.order.id,{expectedVersion:d.order.version,reason:"x"})).rejects.toMatchObject({code:"ALREADY_EXPORTED"});
    });
    it("guards spreadsheet formulas in the exported file",async()=>{
      const d=await approved(`CSV-${tag}`,"=HYPERLINK(\"http://evil.example\",\"x\")");
      const snap=await exportOrder(reviewer,d.order.id,{expectedVersion:d.order.version,idempotencyKey:`k4-${run}`});
      const csv=(await downloadExport(reviewer,d.order.id,snap.id)).content.toString();
      expect(csv).toContain(`"'=HYPERLINK(""http://evil.example"",""x"")"`);
      expect(csv).not.toMatch(/(^|,)"=/m);
    });
  });

  describe("catalogue version",()=>{
    it("validates against the current catalogue version, so a later import does not break export",async()=>{
      const { currentCatalogueVersion }=await import("../packages/db/seed");
      const current=await currentCatalogueVersion(pool);
      const d=await orderOf((await receive({po:`CAT-${tag}`,trusted:"C001"})).receipt);
      expect(d.order.catalogueVersion).toBe(current);
    });
  });
  describe("stored pricing date",()=>{
    it("keeps the receipt's London day on the order through edits",async()=>{
      const d=await orderOf((await receive({po:`PRD-${tag}`,trusted:"C001"})).receipt);
      expect(d.order.pricingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const edited=await editOrder(reviewer,d.order.id,{expectedVersion:d.order.version,patch:{poNumber:`PRD2-${tag}`}});
      expect(edited.order.pricingDate).toBe(d.order.pricingDate);
    });
  });
});
