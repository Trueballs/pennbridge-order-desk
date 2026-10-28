import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Address, Customer, ExtractedOrder, PriceAgreement, Product, StockSnapshot } from '../packages/contracts/index';
import { MockProvider } from '../packages/ai/index';
import { validate } from '../packages/domain/index';
import { parseInput } from '../packages/ingestion/index';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AS_OF = '2026-11-02T09:00:00+00:00';
type Fixture = {
  id: string; title: string; email_path: string; received_at: string;
  setup: Record<string, any>;
  expected: { intent: string; route: string; required_flags: string[]; lines: Array<{sku:string|null;quantity:string|null;unit:string|null}>; customer_id: string|null };
};
type ActualLine = { id:string; position:number; sku:string|null; quantity:string|null; unit:string|null; selectedSku:string|null; reasons:string[] };
export type CaseEvaluation = {
  id:string; title:string; inputSha256:string; latencyMs:number; mode:'mock';
  status:'evaluated'|'unsupported_setup'|'error'; unsupportedSetup:string[];
  expected:{intent:string;route:string;requiredFlags:string[];lines:Fixture['expected']['lines'];customerId:string|null};
  actual:{intent:string|null;route:string|null;flags:string[];customerId:string|null;lines:ActualLine[]}|null;
  checks:{intent:boolean|null;route:boolean|null;requiredFlags:boolean|null;lines:boolean|null;customer:boolean|null;overall:boolean|null};
  error?:string;
};

export function statusRoute(status:string):string {
  if(status==='draft_ready') return 'draft_ready';
  if(status==='not_order') return 'not_order';
  return 'needs_review';
}

function lineMatch(actual:ActualLine[], expected:Fixture['expected']['lines']):boolean {
  if(actual.length!==expected.length) return false;
  const remaining=[...actual];
  return expected.every(line=>{
    const index=remaining.findIndex(a=>a.selectedSku===line.sku && a.quantity===line.quantity && a.unit===line.unit);
    if(index<0)return false;
    remaining.splice(index,1);return true;
  });
}

export function unsupportedSetup(setup:Record<string,any>):string[] {
  return ['existing_order','historical_orders','processed_message_ids'].filter(key=>setup[key]!==undefined);
}

function sha(text:Buffer|string):string { return createHash('sha256').update(text).digest('hex'); }

async function runCase(c:Fixture, reference:any, provider:MockProvider):Promise<CaseEvaluation> {
  const start=performance.now();
  const email=await readFile(path.join(ROOT,c.email_path));
  const unsupported=unsupportedSetup(c.setup||{});
  const base:CaseEvaluation={id:c.id,title:c.title,inputSha256:sha(email),latencyMs:0,mode:'mock',status:'error',unsupportedSetup:unsupported,
    expected:{intent:c.expected.intent,route:c.expected.route,requiredFlags:c.expected.required_flags,lines:c.expected.lines,customerId:c.expected.customer_id},
    actual:null,checks:{intent:null,route:null,requiredFlags:null,lines:null,customer:null,overall:null}};
  try {
    const parsed=await parseInput({filename:path.basename(c.email_path),mediaType:'message/rfc822',content:email,messageId:c.id,documentId:`doc-${c.id}`});
    // Expected labels are deliberately not included in either parser or domain inputs.
    const {extracted}=await provider.extract({text:parsed.text,documents:parsed.documents,evidence:parsed.evidence});
    const customerId=c.setup?.trusted_ingestion_context?.verified_customer_id ?? null;
    const rawCustomer=reference.customers.find((x:any)=>x.id===customerId);
    const customer:Customer|null=rawCustomer?{id:rawCustomer.id,externalId:`pennbridge.partner_${rawCustomer.id}`,name:rawCustomer.name,
      onHold:rawCustomer.status==='credit_hold',approvedSenders:rawCustomer.approved_senders,catalogueVersion:'reference-v1'}:null;
    const addresses:Address[]=reference.customers.flatMap((a:any)=>Object.entries(a.addresses).map(([label,formatted])=>({
      id:`ADDR-${a.id}-${label}`,customerId:a.id,externalId:`pennbridge.address_${a.id}_${label}`,label,formatted:String(formatted),approved:true,
    })));
    const products:Product[]=reference.products.map((p:any)=>({id:p.sku,externalId:`pennbridge.product_${p.sku}`,sku:p.sku,
      manufacturerReference:p.attributes?.manufacturer_reference??null,description:p.description,category:p.family.split('_')[0],family:p.family,
      attributes:p.attributes,active:p.active,sellingUnit:p.selling_unit,unitsPerPack:String(p.units_per_pack),
      physicalUnit:['pack','box'].includes(p.selling_unit)?'each':p.selling_unit,
      allowsFractionalQuantity:!!p.attributes?.decimal_quantity||['metre','litre','kg'].includes(p.selling_unit),
      listPrice:p.price_gbp,currency:'GBP',catalogueVersion:'reference-v1'}));
    const aliases=reference.aliases as Array<{customer_id:string;alias:string;sku:string}>;
    const prices:PriceAgreement[]=(reference.price_agreements as any[]).map((p,i)=>({id:`PRICE-${i+1}`,customerId:p.customer_id,
      productId:p.sku,version:`reference-price-${i+1}`,validFrom:p.valid_from,validTo:p.valid_to??null,
      minimumQuantity:String(p.minimum_quantity),unitPrice:p.unit_price_gbp,currency:'GBP'}));
    const stockBySku=new Map<string,StockSnapshot>(Object.entries(reference.stock).map(([sku,v]:[string,any])=>[sku,
      {productId:sku,availableQuantity:String(v.available),observedAt:v.as_of}]));
    const repository={
      exactSku:async(sku:string)=>products.filter(p=>p.sku.toLowerCase()===sku.toLowerCase()),
      manufacturer:async(ref:string)=>products.filter(p=>p.manufacturerReference?.toLowerCase()===ref.toLowerCase()),
      aliases:async(id:string,alias:string)=>products.filter(p=>aliases.some(a=>a.customer_id===id&&a.alias.toLowerCase()===alias.toLowerCase()&&a.sku===p.sku)),
      search:async(query:string,limit:number)=>products.filter(p=>p.description.toLowerCase().includes(query.toLowerCase())).slice(0,limit),
      prices:async(id:string,sku:string)=>prices.filter(p=>p.customerId===id&&p.productId===sku),
      stock:async(sku:string)=>stockBySku.get(sku)??null,
    };
    const result=await validate(extracted,{customer,addresses,catalogueVersion:'reference-v1',at:c.received_at||AS_OF,repository});
    const allReasons=[...parsed.reasons,...extracted.reasons,...result.reasons,...result.lines.flatMap(x=>x.reasons)];
    const flags:string[]=[...new Set(allReasons.map(x=>x.code))].sort();
    const actualLines:ActualLine[]=result.lines.map((line,i)=>({id:line.id||`line-${i+1}`,position:line.position,sku:line.sku,
      quantity:line.quantity,unit:line.unit,selectedSku:line.selectedSku,reasons:line.reasons.map(r=>r.code)}));
    const route=statusRoute(result.status);
    const checks={intent:extracted.intent===c.expected.intent,route:route===c.expected.route,
      requiredFlags:c.expected.required_flags.every(f=>flags.includes(f)),lines:lineMatch(actualLines,c.expected.lines),customer:customerId===c.expected.customer_id,
      overall:false};
    checks.overall=[checks.intent,checks.route,checks.requiredFlags,checks.lines,checks.customer].every(Boolean);
    base.status=unsupported.length?'unsupported_setup':'evaluated';
    base.actual={intent:extracted.intent,route,flags,customerId,lines:actualLines};base.checks=checks;
  } catch(error) { base.error=error instanceof Error?error.message:String(error); }
  base.latencyMs=Math.round((performance.now()-start)*100)/100;
  return base;
}

export async function evaluate():Promise<any> {
  // Pin the shipped fixture set; a changed or missing .eml must not silently shift scores.
  const cases=JSON.parse(await readFile(path.join(ROOT,'fixtures/cases.json'),'utf8')) as Fixture[];
  const manifest=JSON.parse(await readFile(path.join(ROOT,'fixtures/manifest.json'),'utf8')) as Array<{path:string;sha256:string}>;
  const frozen=new Map(manifest.map(x=>[x.path,x.sha256]));
  const reference=JSON.parse(await readFile(path.join(ROOT,'fixtures/context.json'),'utf8'));
  const provider=new MockProvider();
  const results:CaseEvaluation[]=[];
  for(const c of cases){
    const expectedHash=frozen.get(c.email_path);
    if(!expectedHash)throw new Error(`Fixture ${c.email_path} is not in fixtures/manifest.json`);
    const actualHash=sha(await readFile(path.join(ROOT,c.email_path)));
    if(actualHash!==expectedHash)throw new Error(`Frozen input hash mismatch for ${c.id}: expected ${expectedHash}, got ${actualHash}`);
    results.push(await runCase(c,reference,provider));
  }
  const eligible=results.filter(r=>r.status==='evaluated');
  const evaluated=eligible.filter(r=>r.checks.overall!==null);
  const total=results.length;
  const latency=results.map(r=>r.latencyMs).sort((a,b)=>a-b);
  const summary={fixtureCount:total,evaluated:eligible.length,unsupportedSetup:results.filter(r=>r.status==='unsupported_setup').length,
    errors:results.filter(r=>r.status==='error').length,passing:evaluated.filter(r=>r.checks.overall).length,
    denominator:evaluated.length,passRate:evaluated.length?evaluated.filter(r=>r.checks.overall).length/evaluated.length:null,
    perCheck:Object.fromEntries(['intent','route','requiredFlags','lines','customer'].map(key=>[key,{passed:eligible.filter(r=>r.checks[key as keyof typeof r.checks]===true).length,
      denominator:eligible.filter(r=>r.checks[key as keyof typeof r.checks]!==null).length}])),
    latencyMs:{median:latency.length?latency[Math.floor((latency.length-1)/2)]:null,p95:latency.length?latency[Math.ceil(latency.length*.95)-1]:null,
      total:Math.round(latency.reduce((a,b)=>a+b,0)*100)/100},mode:'offline deterministic MockProvider; not AI accuracy',referenceDate:AS_OF};
  const bundle={schemaVersion:1,createdAt:new Date().toISOString(),summary,results};
  const out=path.join(ROOT,'results/acceptance');await mkdir(out,{recursive:true});
  await writeFile(path.join(out,'run.json'),JSON.stringify(bundle,null,2)+'\n');
  const md=['# Offline acceptance run','',`Run: ${bundle.createdAt}`,`Mode: ${summary.mode}`,`Reference date: ${AS_OF}`,'',
    `- Fixtures: ${total}; evaluated: ${summary.evaluated}; unsupported setup: ${summary.unsupportedSetup}; errors: ${summary.errors}`,
    `- Overall: ${summary.passing}/${summary.denominator} (${summary.passRate===null?'n/a':`${(summary.passRate*100).toFixed(1)}%`})`,
    `- Latency median / p95: ${summary.latencyMs.median} / ${summary.latencyMs.p95} ms`,`- Input hashes checked against fixtures/manifest.json.`,'',
    '| Case | Status | Expected route | Actual route | Flags | Line result | ms |','|---|---|---|---|---|---:|---:|',
    ...results.map(r=>`| ${r.id} | ${r.status}${r.checks.overall===true?' ✓':r.checks.overall===false?' ✗':''} | ${r.expected.route} | ${r.actual?.route??'—'} | ${r.actual?.flags.join(', ')||'—'} | ${r.checks.lines===null?'—':r.checks.lines?'pass':'miss'} | ${r.latencyMs} |`),
    '', 'Cases requiring existing-order, historical-order or processed-message state are diagnostic only. The harness does not emulate those state stores; their results are excluded from the pass denominator.',
    'The only parser/provider path here is the offline rule-based MockProvider. These measurements do not represent model accuracy, database/API integration, Odoo acceptance, or PDF extraction accuracy.'];
  await writeFile(path.join(out,'run.md'),md.join('\n')+'\n');
  return bundle;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  evaluate().then(({summary})=>console.log(JSON.stringify(summary,null,2))).catch(error=>{console.error(error);process.exitCode=1;});
}
