import { afterAll,beforeAll,describe,expect,it } from "vitest";
import { mkdir,readFile,writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtractedOrder,ExtractionProvider,Session } from "../packages/contracts";
import { approveOrder,cancelOrder,exportOrder,getOrder,initialiseDatabase,intake,login,processMessage } from "../packages/server";
import { claimJob,pool } from "../packages/db";
import { parseInput } from "../packages/ingestion";
import { MockProvider } from "../packages/ai";

const ids=["PB-031","PB-032","PB-033","PB-034","PB-035","PB-036","PB-038","PB-039"];
const enabled=process.env.STATEFUL_ACCEPTANCE_TEST==="true";
let actor:Session,cases:any[];
const results:any[]=[];
const root=process.env.PROJECT_ROOT??process.cwd();
const setupProvider=(setup:any):ExtractionProvider=>({mode:"mock",extract:async()=>({usage:null,extracted:{schemaVersion:1,intent:"new_order",poNumber:setup.po_reference,relatedPoNumber:null,revision:null,requestedDeliveryDate:null,requestedAddress:setup.shipping_address_id,currency:setup.currency,quotedTotal:null,reasons:[],evidence:[],lines:setup.lines.map((l:any,i:number)=>({id:`setup-${i+1}`,position:i+1,rawText:`${l.quantity} ${l.unit} ${l.sku}`,sku:l.sku,manufacturerReference:null,customerAlias:null,description:l.sku,quantity:l.quantity,unit:l.unit,originalUnit:l.unit,quotedUnitPrice:null,attributes:{},evidenceIds:[]}))} as ExtractedOrder})});
async function processReceipt(receipt:any,provider:ExtractionProvider){const job=await claimJob("stateful-acceptance");expect(job?.id).toBe(receipt.jobId);await processMessage(job!,"stateful-acceptance",{parse:parseInput,provider});return getOrder(actor,receipt.orderId);}

describe.skipIf(!enabled)("original stateful acceptance through real services",()=>{
  beforeAll(async()=>{
    if(!new URL(process.env.DATABASE_URL!).pathname.endsWith("pennbridge_stateful_test"))throw new Error("Stateful suite requires dedicated pennbridge_stateful_test database");
    await initialiseDatabase();
    // Only this explicitly named isolated test database is reset. Master seed remains intact.
    await pool.query("TRUNCATE messages CASCADE");
    cases=JSON.parse(await readFile(path.join(root,"fixtures/cases.json"),"utf8"));
    actor=(await login("admin@pennbridge.example","admin-demo")).session;
  });
  afterAll(async()=>{
    if(enabled){const folder=path.join(root,"results/acceptance");await mkdir(folder,{recursive:true});await writeFile(path.join(folder,"stateful.json"),JSON.stringify({mode:"mock extraction + real PostgreSQL/services; not AI accuracy",notes:"Duplicate businessLines are empty because no new business order is produced; sourceLines retain extracted evidence. DUPLICATE_MESSAGE derives from the service duplicate=true replay result.",createdAt:new Date().toISOString(),fixtureCount:8,passing:results.filter(r=>r.passed).length,results},null,2)+"\n");}
    await pool.end();
  });
  for(const fixtureId of ids)it(fixtureId,async()=>{
    const fixture=cases.find(c=>c.id===fixtureId);
    let prior:any=null;
    const content=await readFile(path.join(root,fixture.email_path));
    if(fixture.setup.existing_order){
      const setup=fixture.setup.existing_order;
      const replay=fixture.setup.processed_message_ids?.includes(fixture.email.message_id);
      const receipt=await intake(actor,{filename:replay?`${fixtureId}.eml`:`${fixtureId}-prior.txt`,mediaType:replay?"message/rfc822":"text/plain",contentBase64:(replay?content:Buffer.from(`Prior committed order ${fixtureId}\n${setup.lines.map((l:any)=>`${l.quantity} ${l.unit} ${l.sku}`).join("\n")}`)).toString("base64"),channel:"synthetic_email",externalMessageId:replay?fixture.email.message_id:`prior-${fixtureId}`,trustedCustomerId:setup.customer_id});
      prior=await processReceipt(receipt,setupProvider(setup));
      if(setup.state==="exported"){
        const approved=await approveOrder(actor,prior.order.id,{expectedVersion:prior.order.version,contentHash:prior.order.contentHash});
        await exportOrder(actor,prior.order.id,{expectedVersion:approved.order.version,idempotencyKey:`setup-export-${fixtureId}`});prior=await getOrder(actor,prior.order.id);
      }
    }
    for(const [i,history] of (fixture.setup.historical_orders??[]).entries()){
      const data={id:`stateful-${fixtureId}-${i}`,customer_id:history.customer_id,po_reference:history.po_reference,ordered_at:`2026-10-${20+i}`,status:"fulfilled",synthetic:true,lines:history.lines.map((l:any)=>({...l,unit_price_gbp:"99.99"}))};
      await pool.query("INSERT INTO synthetic_history(id,customer_id,ordered_at,data) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET data=excluded.data",[data.id,data.customer_id,data.ordered_at,data]);
    }
    const beforeOrders=Number((await pool.query("SELECT count(*) FROM orders")).rows[0].count);
    const receipt=await intake(actor,{filename:`${fixtureId}.eml`,mediaType:"message/rfc822",contentBase64:content.toString("base64"),channel:"synthetic_email",externalMessageId:fixture.email.message_id,trustedCustomerId:fixture.setup.trusted_ingestion_context.verified_customer_id});
    let providerCalls=0;const realProvider=new MockProvider();const provider:ExtractionProvider={mode:"mock",extract:async input=>{providerCalls++;return realProvider.extract(input);}};
    const actual=receipt.duplicate?await getOrder(actor,receipt.orderId!):await processReceipt(receipt,provider);
    const route=receipt.duplicate?"duplicate":actual.order.status;
    const flags=[...new Set([...actual.order.reasons,...actual.order.lines.flatMap(l=>l.reasons)].map(r=>r.code))];
    if(receipt.duplicate)flags.push("DUPLICATE_MESSAGE"); // Public duplicate=true is the replay outcome; no new draft or extraction occurred.
    const businessLines=route==="duplicate"?[]:actual.order.lines.map(l=>({sku:l.selectedSku,quantity:l.quantity,unit:l.unit}));
    const expected=fixture.expected;
    const checks:Record<string,boolean>={intent:actual.order.intent===expected.intent,route:route===expected.route,flags:expected.required_flags.every((f:string)=>flags.includes(f as any)),lines:JSON.stringify(businessLines)===JSON.stringify(expected.lines),customer:actual.order.customerId===expected.customer_id,noAutomaticApproval:actual.order.approval===null,noAutomaticExport:actual.exports.length===0};
    if(fixtureId==="PB-031"){checks.noNewOrder=Number((await pool.query("SELECT count(*) FROM orders")).rows[0].count)===beforeOrders;checks.noProviderCall=providerCalls===0;}
    if(prior&&!receipt.duplicate){checks.relatedToPrior=fixtureId==="PB-033"?actual.order.relatedOrderId===null:actual.order.relatedOrderId===prior.order.id;checks.priorUnchanged=(await getOrder(actor,prior.order.id)).order.contentHash===prior.order.contentHash;}
    if(fixtureId==="PB-036"){checks.exportNotReversed=(await getOrder(actor,prior.order.id)).order.status==="exported";await expect(cancelOrder(actor,prior.order.id,{expectedVersion:prior.order.version,reason:"Synthetic cancellation test"})).rejects.toMatchObject({code:"ALREADY_EXPORTED"});}
    const suggestions=(actual as any).historySuggestions??[];
    if(fixtureId==="PB-038"){checks.historyProvenance=suggestions.some((s:any)=>s.poNumber==="HIST-381"&&s.source==="synthetic_history"&&s.lines.some((l:any)=>l.sku==="BR-6204-2RS"&&l.quantity==="6"));checks.noHistoricalPriceCopy=actual.order.lines.length===0&&suggestions.every((s:any)=>s.lines.every((l:any)=>l.unitPrice===undefined&&l.unit_price_gbp===undefined));}
    if(fixtureId==="PB-039")checks.noForcedHistoricalChoice=actual.order.lines.length===0;
    const report={id:fixtureId,passed:Object.values(checks).every(Boolean),checks,actual:{intent:actual.order.intent,route,intakeDuplicate:receipt.duplicate,flags,businessLines,sourceLines:actual.order.lines.map(l=>({sku:l.selectedSku,quantity:l.quantity,unit:l.unit})),relatedOrderId:actual.order.relatedOrderId,providerCalls,historySuggestions:suggestions},expected};results.push(report);
    expect(checks,JSON.stringify(report,null,2)).toEqual(Object.fromEntries(Object.keys(checks).map(k=>[k,true])));
  });
});
