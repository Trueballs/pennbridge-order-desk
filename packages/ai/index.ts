import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import Decimal from 'decimal.js';
import { z } from 'zod';
import { ExtractedOrderSchema, type ExtractionProvider, type ExtractionInput, type ExtractedOrder, type ExtractedLine, type Reason, type Unit } from '../contracts/index';
import { reserveModelBudget, settleModelBudget } from '../db/index';

const reason=(code:Reason['code'],message:string):Reason=>({code,message,severity:'blocking',lineId:null,evidenceIds:[],resolved:false,resolution:null});
const money=(s:string|undefined)=>s&&/^\d[\d,]*(?:\.\d+)?$/.test(s)?new Decimal(s.replace(/,/g,'')).toFixed(2):null;
const normalUnit=(s:string|undefined):Unit|null=>{
  if(!s)return null;const u=s.toLowerCase();
  if(/^(each|individual|units?|pieces?|pcs?)$/.test(u))return 'each';
  if(/^box/.test(u))return 'box';if(/^pack/.test(u))return 'pack';if(/^pair/.test(u))return 'pair';if(/^roll/.test(u))return 'roll';if(/^(met|m$)/.test(u))return 'metre';if(/^litr/.test(u))return 'litre';if(u==='kg')return 'kg';return null;
};
function attributes(text:string):Record<string,string|number|boolean>{
  const a:Record<string,string|number|boolean>={};
  const dim=text.match(/\bM(\d+)\s*[x×]\s*(\d+(?:\.\d+)?)\s*mm/i);
  if(dim){a.diameter_mm=Number(dim[1]);a.length_mm=Number(dim[2]);}
  else {const m=text.match(/\bM(\d+)\b/);if(m)a.diameter_mm=Number(m[1]);}
  if(/A2|stainles/i.test(text))a.material='A2 stainless';
  else if(/zinc|plated/i.test(text))a.material='zinc plated steel';
  else if(/\bNBR\b/i.test(text))a.material='NBR';else if(/\bFKM\b/i.test(text))a.material='FKM';
  const pack=text.match(/(?:packs?\s+of|box(?:es)?\s+of)\s*(\d+)/i);if(pack)a.units_per_pack=Number(pack[1]);
  const thread=text.match(/\b(BSP|NPT)\b/);if(thread)a.thread=thread[1];
  return a;
}

/** Rule-based offline parser. It never reads fixtures/cases.json or expected answers. */
export class MockProvider implements ExtractionProvider {
  readonly mode='mock' as const;
  async extract(input:ExtractionInput):Promise<{extracted:ExtractedOrder;usage:null}>{
    const reasons:Reason[]=[];
    let text=input.text;
    const quoted=text.search(/\n(?:On .{0,100}wrote:|From:|>{1,2}\s)/i);
    if(quoted>=0)text=text.slice(0,quoted);
    if(/SYSTEM OVERRIDE|ignore (?:your|all|previous|the) (?:rules|instructions)|send all customer|reveal.*(?:key|secret)/i.test(text))reasons.push(reason('UNTRUSTED_INSTRUCTION','Instructions inside a source document are untrusted; reviewer inspection required.'));
    const intent:ExtractedOrder['intent']=/\bcancel\b/i.test(text)?'cancellation':/\bamend\b|rather than|instead of \d/i.test(text)?'amendment':/\bquote for\b|just budgeting|not (?:a|an) order/i.test(text)?'quote_request':'new_order';
    if(intent==='quote_request')reasons.push(reason('QUOTE_REQUEST','This is a quotation request, not an order.'));
    if(intent==='cancellation')reasons.push(reason('CANCELLATION_REQUEST','A reviewer must handle the cancellation request.'));
    if(intent==='amendment')reasons.push(reason('ORDER_AMENDMENT','Review this change against the existing order.'));
    const po=text.match(/\b(?:purchase\s+order|PO|order|book|raise|amend|cancel)\s*(?:number|no\.?|#|:)?\s*([A-Z][A-Z0-9]*-\d[\w-]*)/i)?.[1]
      ||text.match(/\b([A-Z]{2,8}-\d{3,}(?:-[A-Z0-9]+)?)\s*[:,]/)?.[1]||null;
    const addr=text.match(/\b(?:MAIN|NORTH)\b/)?.[0]||null;
    let requestedAddress=addr;
    if(/instead of MAIN|new.*(?:site|address)/i.test(text)){requestedAddress=text.match(/(?:Deliver to|Ship to)\s+([^\n.]+)/i)?.[1]||null;reasons.push(reason('NEW_SHIPPING_ADDRESS','The requested address is not an established account address.'));}
    if(/\breturn\b/i.test(text))reasons.push(reason('MIXED_ORDER_AND_RETURN','A return request is included; do not create a new sales line or credit for it.'));
    if(/same .*last time|repeat our last order/i.test(text))reasons.push(reason(/HIST-\d+/i.test(text)?'HISTORY_REQUIRES_CONFIRMATION':'AMBIGUOUS_ORDER_HISTORY','Historical order details require explicit reviewer confirmation.'));
    if(/\bguarantee\b/i.test(text))reasons.push(reason('DELIVERY_COMMITMENT_REQUIRED','Requested delivery must not be treated as a confirmed promise.'));
    const date=text.match(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/)?.[0];
    if(date)reasons.push(reason('AMBIGUOUS_DELIVERY_DATE',`Review the literal requested date ${date}; no automatic locale assumption.`));
    const clean=text.split(/also please arrange return/i)[0].replace(/\[Document:[^\]]+\]/g,'');
    const chunks=clean.split(/\n|;|(?<=[.!?])\s+/).filter(c=>c.trim());
    const lines:ExtractedLine[]=[];
    for(const chunk of chunks){
      if(/SYSTEM OVERRIDE|^>/.test(chunk)||intent==='cancellation'||intent==='quote_request')continue;
      const tokens=[...chunk.matchAll(/\b[A-Z][A-Z0-9]{1,8}(?:-[A-Z0-9]{1,12}){1,5}\b/g)].map(x=>x[0]).filter(s=>s!==po&&!/^HIST-/.test(s));
      const manufacturer=chunk.match(/\b\d{4}-(?:2RS|ZZ)\b/)?.[0];
      const sku=tokens.find(s=>!/^(PO|PDF|PB)-\d{3,}$/.test(s))||manufacturer||null;
      const qtyBefore=chunk.match(/(-?\d+(?:\.\d+)?)\s+(individual|packs?|boxes|box|pairs?|rolls?|metres?|meters?|each|units?|pieces?|pcs|kg|litres?|O-rings?)\b/i);
      const qtyAfter=sku?chunk.slice(chunk.indexOf(sku)+sku.length).match(/^\s*(?:[|:]\s*)?(-?\d+(?:\.\d+)?)\s*(?:[|:]\s*)?(packs?|boxes|box|pairs?|rolls?|metres?|each|units?|kg|litres?)\b/i):null;
      const q=qtyBefore?.[1]||qtyAfter?.[1]||null;
      const rawUnit=qtyBefore?.[2]||qtyAfter?.[2];
      const u=/^O-rings?$/i.test(rawUnit||'')&&/\beach\b/i.test(chunk)?'each':normalUnit(rawUnit);
      const isProduct=/bolts?|blots?|bearings?|O-rings?|fittings?|gloves?|hose|washers?|nuts?|discs?|tape/i.test(chunk);
      if(!sku&&(!q||!isProduct))continue;
      if(!q&&!sku)continue;
      const id=`line-${lines.length+1}`;
      const d=input.documents.find(d=>d.text?.includes(chunk.trim()));
      const evidenceId=d?`${d.id}_line_${lines.length+1}`:null;
      const unitPrice=chunk.match(/(?:at|@)\s*(?:our (?:agreed|old) )?(?:£|GBP\s*|EUR\s*)(\d[\d,]*(?:\.\d{1,2})?)/i)?.[1]
        ||chunk.match(/(?:each|pack|box|pair|roll|metre)\s+(\d+\.\d{2})\s*$/i)?.[1];
      lines.push({id,position:lines.length+1,rawText:chunk.trim(),sku,manufacturerReference:manufacturer||null,customerAlias:null,description:chunk.trim(),quantity:q,unit:u,originalUnit:rawUnit||null,quotedUnitPrice:money(unitPrice),attributes:attributes(chunk),evidenceIds:evidenceId?[evidenceId]:[]});
    }
    if(lines.length>100)reasons.push(reason('DOCUMENT_TOO_LONG','Order exceeds 100-line limit.'));
    if(!lines.length&&intent==='new_order')reasons.push(reason('NO_ORDER_LINES','No reliably structured order lines could be read in offline mode.'));
    // Conflicting versions are an exception; filenames do not establish precedence.
    const attached=input.documents.filter(d=>d.kind==='attachment'&&d.text);
    if(attached.length>1&&new Set(attached.map(d=>d.text?.trim())).size>1){reasons.push(reason('CONFLICTING_DOCUMENT_VERSIONS','Multiple differing attachments require a reviewer to identify the intended version.'));lines.length=0;}
    const evidence=input.evidence.slice();
    const evidenceCursors=new Map<string,number>();
    for(const l of lines){const d=input.documents.find(d=>d.text?.indexOf(l.rawText,evidenceCursors.get(d.id)||0)!>=0);if(d&&l.evidenceIds[0]){
      const offset=d.text!.indexOf(l.rawText,evidenceCursors.get(d.id)||0);evidenceCursors.set(d.id,offset+l.rawText.length);const page=input.evidence.find(e=>e.documentId===d.id&&e.startOffset!==null&&e.endOffset!==null&&offset>=e.startOffset&&offset<e.endOffset)?.page??null;
      evidence.push({id:l.evidenceIds[0],documentId:d.id,page,startOffset:offset,endOffset:offset+l.rawText.length,quote:l.rawText.slice(0,4000),field:'order_line',lineId:l.id});}}
    const extracted:ExtractedOrder={schemaVersion:1,intent,poNumber:po,relatedPoNumber:intent==='amendment'||intent==='cancellation'?po:null,revision:null,requestedDeliveryDate:null,requestedAddress,currency:/\bEUR\b|€/.test(text)?'EUR':'GBP',quotedTotal:money(text.match(/(?:net\s+total|total)\s*(?:£|GBP\s*)?(\d[\d,]*(?:\.\d{1,2})?)/i)?.[1]||text.match(/£(\d[\d,]*(?:\.\d{1,2})?)\s+net(?:\s+total)?/i)?.[1]),lines:lines.slice(0,100),evidence,reasons};
    return {extracted:ExtractedOrderSchema.parse(extracted),usage:null};
  }
}

export class LiveProvider implements ExtractionProvider {
  readonly mode='live' as const;
  constructor(private opts:{runId:string;orderId:string}){}
  async extract(input:ExtractionInput){
    if(process.env.LIVE_AI_ENABLED!=='true'||!process.env.ANTHROPIC_API_KEY)throw Object.assign(new Error('Live AI is not configured. Offline parsing remains available.'),{code:'MODEL_UNAVAILABLE'});
    const model=process.env.EXTRACTION_MODEL||'claude-haiku-5-5';
    if(!['claude-haiku-5-5','claude-sonnet-5-5'].includes(model))throw new Error('Model is not on the explicitly configured allowlist.');
    const inRate=process.env.AI_INPUT_USD_PER_MILLION;const outRate=process.env.AI_OUTPUT_USD_PER_MILLION;
    if(!inRate||!outRate||!process.env.AI_PRICING_VERSION)throw Object.assign(new Error('Set verified model pricing and pricing version before enabling live AI.'),{code:'MODEL_UNAVAILABLE'});
    const system=await readFile(resolve(process.cwd(),'prompts/order-interpreter.md'),'utf8');
    const schema=z.toJSONSchema(ExtractedOrderSchema,{unrepresentable:'any'});
    const content=JSON.stringify({text:input.text,documents:input.documents.map(d=>({id:d.id,filename:d.filename})),evidence:input.evidence});
    // UTF-8 byte count is a deliberately conservative token reservation, including schema and system text.
    const maxInput=Buffer.byteLength(content+system+JSON.stringify(schema))+2048;const maxOutput=8192;
    const reserved=new Decimal(maxInput).mul(inRate).add(new Decimal(maxOutput).mul(outRate)).div(1e6).toFixed(6);
    const reservation=await reserveModelBudget(this.opts.runId,this.opts.orderId,reserved,process.env.AI_RUN_BUDGET_USD||'5.00',process.env.AI_ORDER_BUDGET_USD||'0.10');
    const start=Date.now();const api=new Anthropic({apiKey:process.env.ANTHROPIC_API_KEY,maxRetries:0,timeout:45000});
    try {
      const response=await api.messages.create({model,max_tokens:maxOutput,system,messages:[{role:'user',content}],output_config:{format:{type:'json_schema',schema}}} as any);
      if(response.stop_reason!=='end_turn')throw Object.assign(new Error(`Incomplete model output (${response.stop_reason}).`),{code:'MODEL_OUTPUT_INVALID'});
      const raw=response.content.filter(x=>x.type==='text').map(x=>x.text).join('');
      const extracted=ExtractedOrderSchema.parse(JSON.parse(raw));
      const actual=new Decimal(response.usage.input_tokens).mul(inRate).add(new Decimal(response.usage.output_tokens).mul(outRate)).div(1e6).toFixed(6);
      await settleModelBudget(reservation,actual);
      return {extracted,usage:{id:`usage_${crypto.randomUUID()}`,orderId:this.opts.orderId,runId:this.opts.runId,mode:'live' as const,provider:'anthropic',model,modelVersion:response.model,effort:null,operation:'extraction' as const,promptHash:createHash('sha256').update(system).digest('hex'),catalogueVersion:'scale-v1',inputTokens:response.usage.input_tokens,outputTokens:response.usage.output_tokens,cacheReadTokens:response.usage.cache_read_input_tokens||0,cacheWriteTokens:response.usage.cache_creation_input_tokens||0,latencyMs:Date.now()-start,costUsd:actual,reservedUsd:reserved,pricingVersion:process.env.AI_PRICING_VERSION!,requestCount:1,retries:0,retrievedCandidateCount:0,status:'succeeded' as const,createdAt:new Date().toISOString()}};
    }catch(e){await settleModelBudget(reservation,null);throw e;}
  }
}
export function createProvider(opts?:{runId?:string;orderId?:string}):ExtractionProvider {
  return process.env.LIVE_AI_ENABLED==='true'?new LiveProvider({runId:opts?.runId||'manual-run',orderId:opts?.orderId||'unassigned'}):new MockProvider();
}
