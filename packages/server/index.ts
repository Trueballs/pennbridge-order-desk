import { randomBytes } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { readFileSync } from "node:fs";
import { compare } from "bcryptjs";
import type { PoolClient } from "pg";
import { authenticate, revokeToken, sessionFromToken } from "./auth"; // W3
import { AddLineRequestSchema, AddressSchema, AssignCustomerRequestSchema, ExtractedOrderSchema, IntakeRequestSchema, OrderListQuerySchema, ReasonCodeSchema, RemoveLineRequestSchema, ReprocessRequestSchema, SenderMappingInputSchema, VerifyExportRequestSchema, VoidExportRequestSchema, type AddLineRequest, type Address, type AmendmentRequest, type AssignCustomerRequest, type DraftLine, type ExtractedLine, type ReasonCode, type RemoveLineRequest, type RemovedLine, type ReprocessRequest, type SenderMapping, type SenderMappingInput, type SuggestedCustomer, type VoidExportRequest, type ApproveRequest, type CancelRequest, type Customer, type Document, type DocumentEvidence, type EditOrderRequest, type ExportRequest, type ExportSnapshot, type ExtractedOrder, type ExtractionProvider, type IntakeRequest, type IntakeResponse, type Job, type HistoricalSuggestion, type OrderDetail, type OrderListQuery, type OrderListResponse, type Product, type Session, type SourceMessage, type Unit, type ValidatedDraft, type VerifyExportRequest } from "@pennbridge/contracts";
import { audit, failJob, id, jobFromRow, migrate, pool, sha256, transaction, type DbClient } from "@pennbridge/db";
import { CATALOGUE_VERSION, currentCatalogueVersion, seedDatabase } from "@pennbridge/db/seed";
import { authVerdict, canApprove, canonicalJson, classifyFailure, contentHash, anchorEvidence, hasUnresolved, isFreemailDomain, lineCoverage, londonDate, publicError as toPublicError, quantity, reason, senderParts, ServiceError, validate, type ValidationRepository } from "@pennbridge/domain";
export { ServiceError } from "@pennbridge/domain";
/** HTTP-safe error for any thrown value: SQL/stack/provider text never reaches clients. */
export const publicError=(error:unknown)=>toPublicError(error,ReasonCodeSchema.options);

const storageRoot = path.resolve(process.env.STORAGE_ROOT ?? "runtime/storage");
let initialising: Promise<void> | null = null;
export function initialiseDatabase(): Promise<void> {
  if (!initialising) initialising = (async()=>{ await migrate(); await seedDatabase(); await mkdir(storageRoot,{recursive:true}); })().catch(e=>{initialising=null;throw e;});
  return initialising;
}
function allow(session: Session | null, roles: Session["role"][] = ["viewer","reviewer","admin"]) { if (!session) throw new ServiceError("FORBIDDEN","Login required",401); if (!roles.includes(session.role)) throw new ServiceError("FORBIDDEN","This action is not permitted for your role",403); return session; }
function mutate(session: Session | null) { return allow(session,["reviewer","admin"]); }
// W3 (auth.ts): login/session/logout bodies delegate to ./auth (throttling, dummy compare, expiry, revocation). Keep signatures.
export async function login(email: string, password: string, context: {ip?: string} = {}): Promise<{session:Session;token:string}> {
  await initialiseDatabase();
  return authenticate(email,password,context);
}
export async function session(token: string | null | undefined): Promise<Session | null> {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  await initialiseDatabase();
  return sessionFromToken(token);
}
export async function logout(token: string | null | undefined): Promise<void> { await revokeToken(token); }
export function ingestionSession(token: string | null): Session | null {
  const mailboxTokenFile=process.env.MAILBOX_INGESTION_TOKEN_FILE;
  if(mailboxTokenFile && token){
    const expectedMailboxToken=readFileSync(mailboxTokenFile,"utf8").trim();
    if(expectedMailboxToken.length>=32 && sha256(token)===sha256(expectedMailboxToken)) return {userId:"mailbox-ingestion",email:"mailbox@pennbridge.example",name:"Dedicated test mailbox",role:"ingestion",expiresAt:new Date(Date.now()+3600000).toISOString()};
  }
  const expected=process.env.INGESTION_TOKEN;
  if (!expected || !token || sha256(token)!==sha256(expected)) return null;
  return {userId:"synthetic-ingestion",email:"ingestion@pennbridge.example",name:"Synthetic ingestion",role:"ingestion",expiresAt:new Date(Date.now()+3600000).toISOString()};
}
const encodeCursor=(createdAt:Date,id:string)=>Buffer.from(`${createdAt.toISOString()}|${id}`).toString("base64url");
function decodeCursor(cursor:string):{at:string;id:string} {
  const [at,...rest]=Buffer.from(cursor,"base64url").toString("utf8").split("|"),id=rest.join("|");
  if (!at || !id || Number.isNaN(Date.parse(at))) throw new ServiceError("VALIDATION_FAILED","Invalid page cursor",400);
  return {at,id};
}
const likeTerm=(term:string)=>`%${term.replace(/[\\%_]/g,m=>`\\${m}`)}%`;
/** Newest first by (created_at,id) with a keyset cursor; optional status/customer/date/text filters. Dates are Europe/London days. */
export async function listOrders(actor: Session, query: Record<string,unknown> = {}): Promise<OrderListResponse> {
  allow(actor); await initialiseDatabase();
  const q=OrderListQuerySchema.parse(Object.fromEntries(Object.entries(query).filter(([,v])=>v!==undefined&&v!==null&&v!=="")));
  const terms=(q.q?.toLowerCase().split(/\s+/).filter(Boolean).slice(0,8)??[]).map(likeTerm);
  const cursor=q.cursor?decodeCursor(q.cursor):null;
  const rows=(await pool.query(`SELECT data,created_at,id FROM orders WHERE ($1::text IS NULL OR status=$1) AND ($2::text IS NULL OR customer_id=$2)
    AND ($3::text[] IS NULL OR search_text LIKE ALL($3))
    AND ($4::date IS NULL OR created_at>=($4::date)::timestamp AT TIME ZONE 'Europe/London')
    AND ($5::date IS NULL OR created_at<(($5::date)+1)::timestamp AT TIME ZONE 'Europe/London')
    AND ($6::timestamptz IS NULL OR (created_at,id)<($6::timestamptz,$7::text))
    ORDER BY created_at DESC,id DESC LIMIT $8`,[q.status??null,q.customerId??null,terms.length?terms:null,q.dateFrom??null,q.dateTo??null,cursor?.at??null,cursor?.id??null,q.limit+1])).rows;
  const page=rows.slice(0,q.limit),last=page[page.length-1];
  return {orders:page.map(r=>r.data),nextCursor:rows.length>q.limit?encodeCursor(last.created_at,last.id):null};
}
async function detail(client: DbClient, orderId: string): Promise<OrderDetail> {
  const row=(await client.query("SELECT data FROM orders WHERE id=$1",[orderId])).rows[0];
  if (!row) throw new ServiceError("NOT_FOUND","Order not found",404);
  const order: ValidatedDraft=row.data;
  const source=(await client.query("SELECT data FROM messages WHERE id=$1",[order.sourceMessageId])).rows[0].data;
  const fetch=async(table:string,column:string,value:string)=> (await client.query(`SELECT data FROM ${table} WHERE ${column}=$1`,[value])).rows.map(r=>r.data);
  // PoolClient queries run sequentially inside a transaction (pg9 disallows queued parallel queries).
  const documents=await fetch("documents","message_id",order.sourceMessageId);
  const evidence=await fetch("evidence","message_id",order.sourceMessageId);
  const auditEvents=await fetch("audit_events","order_id",orderId);
  const exports=await fetch("exports","order_id",orderId);
  const jobs=(await client.query("SELECT * FROM jobs WHERE order_id=$1 ORDER BY created_at",[orderId])).rows.map(jobFromRow);
  const modelUsage=await fetch("model_usage","order_id",orderId);
  const historySuggestions:HistoricalSuggestion[]=[];
  if(order.customerId && order.reasons.some(r=>["HISTORY_REQUIRES_CONFIRMATION","AMBIGUOUS_ORDER_HISTORY"].includes(r.code))) {
    const references=[...new Set(documents.flatMap(d=>d.text?.match(/\bHIST-[A-Z0-9-]+\b/gi)??[]))].slice(0,5);
    const history=(await client.query("SELECT data FROM synthetic_history WHERE customer_id=$1 AND ($2::text[] IS NULL OR id=ANY($2) OR data->>'po_reference'=ANY($2)) ORDER BY ordered_at DESC,id LIMIT 5",[order.customerId,references.length?references:null])).rows;
    for(const {data} of history) historySuggestions.push({historyId:data.id,customerId:order.customerId,poNumber:data.po_reference,orderedAt:data.ordered_at,source:"synthetic_history",lines:data.lines.map((line:any)=>({sku:line.sku,quantity:line.quantity,unit:line.unit}))});
  }
  return {order,source,documents,evidence,audit:auditEvents.sort((a,b)=>a.at.localeCompare(b.at)),exports,jobs,modelUsage,historySuggestions};
}
export async function getOrder(actor: Session, orderId: string): Promise<OrderDetail> { allow(actor); await initialiseDatabase(); return detail(pool,orderId); }
async function lockedOrder(client: DbClient, orderId: string, expectedVersion: number): Promise<ValidatedDraft> {
  const row=(await client.query("SELECT data FROM orders WHERE id=$1 FOR UPDATE",[orderId])).rows[0];
  if (!row) throw new ServiceError("NOT_FOUND","Order not found",404);
  if (row.data.version!==expectedVersion) throw new ServiceError("STALE_VERSION","This order changed. Refresh before trying again",409);
  return row.data;
}
async function saveOrder(client: DbClient, order: ValidatedDraft, snapshot=true): Promise<void> {
  const search=[order.id,order.poNumber,order.customerId,order.customerName,order.senderEmail,order.subject,...order.lines.flatMap(l=>[l.selectedSku,l.sku,l.manufacturerReference,l.customerAlias,l.description])].filter(Boolean).join(" ").toLowerCase().slice(0,20000);
  await client.query(`INSERT INTO orders(id,message_id,customer_id,po_number,status,version,content_hash,data,created_at,updated_at,sender,subject,search_text) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT(id) DO UPDATE SET customer_id=excluded.customer_id,po_number=excluded.po_number,status=excluded.status,version=excluded.version,content_hash=excluded.content_hash,data=excluded.data,updated_at=excluded.updated_at,sender=excluded.sender,subject=excluded.subject,search_text=excluded.search_text`,
    [order.id,order.sourceMessageId,order.customerId,order.poNumber,order.status,order.version,order.contentHash,order,order.createdAt,order.updatedAt,order.senderEmail?.toLowerCase()??null,order.subject??null,search]);
  if(snapshot) await client.query("INSERT INTO order_versions(order_id,version,content_hash,data) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",[order.id,order.version,order.contentHash,order]);
}
async function duplicatePrior(client:DbClient,order:ValidatedDraft):Promise<ValidatedDraft|null> {
  if(!order.customerId || !order.poNumber)return null;
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,1))",[`${order.customerId}:${order.poNumber}`]);
  return (await client.query("SELECT data FROM orders WHERE customer_id=$1 AND po_number=$2 AND id<>$3 AND status NOT IN ('received','failed','duplicate') AND data->>'relatedOrderId' IS DISTINCT FROM $3 ORDER BY created_at LIMIT 1",[order.customerId,order.poNumber,order.id])).rows[0]?.data??null;
}
function sameBusinessContent(a:ValidatedDraft,b:ValidatedDraft):boolean {
  if(a.lines.length===0 || b.lines.length===0 || a.lines.some(l=>!l.productId||!l.quantity) || b.lines.some(l=>!l.productId||!l.quantity))return false;
  const signature=(order:ValidatedDraft)=>({customerId:order.customerId,poNumber:order.poNumber,shippingAddressId:order.shippingAddressId,currency:order.currency,requestedDeliveryDate:order.requestedDeliveryDate,revision:order.revision,
    lines:order.lines.map(l=>({productId:l.productId,quantity:quantity(l.quantity!),unit:l.unit,unitPrice:l.unitPrice,quotedUnitPrice:l.quotedUnitPrice})).sort((x,y)=>canonicalJson(x)<canonicalJson(y)?-1:canonicalJson(x)>canonicalJson(y)?1:0)});
  return !hasUnresolved(a.reasons) && !a.lines.some(l=>hasUnresolved(l.reasons)) && canonicalJson(signature(a))===canonicalJson(signature(b));
}
async function applyBusinessDuplicate(client:DbClient,order:ValidatedDraft):Promise<void> {
  const prior=await duplicatePrior(client,order);
  if(prior) {
    order.relatedOrderId=prior.id;
    if(order.intent==="new_order") {const identical=sameBusinessContent(order,prior);order.status=identical?"duplicate":"amendment_review";order.reasons.push(reason("DUPLICATE_PO",identical?"This customer PO and normalized order content already exist; preserve this source as duplicate evidence":"This customer PO already exists; compare it as an amendment before taking action"));}
    if(prior.status==="exported" && ["amendment","cancellation"].includes(order.intent)) order.reasons.push(reason("ALREADY_EXPORTED","The related quotation has already been exported; coordinate changes in the destination system"));
  } else if(order.intent==="new_order") order.relatedOrderId=null;
}
async function rejectBusinessDuplicate(client:DbClient,order:ValidatedDraft):Promise<void> {
  if(await duplicatePrior(client,order))throw new ServiceError("DUPLICATE_PO","Another order already uses this customer PO; review it as an amendment");
}
function repository(client: DbClient): ValidationRepository {
  const products=async(sql:string,params:unknown[]) => (await client.query(sql,params)).rows.map(r=>r.data as Product);
  return {
    exactSku:sku=>products("SELECT data FROM products WHERE sku=$1 LIMIT 2",[sku.toUpperCase()]),
    manufacturer:reference=>products("SELECT data FROM products WHERE manufacturer_reference=$1 LIMIT 20",[reference]),
    aliases:(customerId,alias)=>products("SELECT p.data FROM customer_aliases a JOIN products p ON p.id=a.product_id WHERE a.customer_id=$1 AND a.alias=$2 LIMIT 20",[customerId,alias.toUpperCase()]),
    search:async(query,limit,family,attributes)=>{
      if (!query.trim()) return [];
      const terms=query.toLowerCase().match(/[a-z0-9]+/g)?.filter(t=>!['the','of','please','supply','a','and','packs','pack','box','boxes','each'].includes(t)).slice(0,20) ?? [];
      if (!terms.length) return [];
      const attrs={...(attributes??{})};const pack=attrs.units_per_pack??null;delete attrs.units_per_pack;
      // Explicit variant filters run before LIMIT, and domain rechecks all candidates.
      return products("SELECT data FROM products WHERE to_tsvector('simple',description) @@ to_tsquery('simple',$1) AND ($2::text IS NULL OR family=$2) AND data->'attributes' @> $4::jsonb AND ($5::numeric IS NULL OR (data->>'unitsPerPack')::numeric=$5) ORDER BY ts_rank(to_tsvector('simple',description),to_tsquery('simple',$1)) DESC,sku LIMIT $3",[terms.join(" | "),family??null,Math.min(20,limit),JSON.stringify(attrs),pack]);
    },
    prices:async(customerId,productId)=>(await client.query("SELECT data FROM price_agreements WHERE customer_id=$1 AND product_id=$2",[customerId,productId])).rows.map(r=>r.data),
    stock:async productId=>(await client.query("SELECT data FROM stock_snapshots WHERE product_id=$1",[productId])).rows[0]?.data??null,
  };
}
async function validationContext(client:DbClient, customerId:string|null, at:string, pricingDate?:string, suggestedCustomerName?:string|null) {
  const customer: Customer|null=customerId ? (await client.query("SELECT data FROM customers WHERE id=$1",[customerId])).rows[0]?.data??null : null;
  const addresses:Address[]=customer ? (await client.query("SELECT data FROM addresses WHERE customer_id=$1",[customer.id])).rows.map(r=>r.data) : [];
  return {customer,addresses,catalogueVersion:await currentCatalogueVersion(client),at,pricingDate:pricingDate??londonDate(at),suggestedCustomerName,repository:repository(client)};
}
const KEEP_REASONS=["UNTRUSTED_INSTRUCTION","CONFLICTING_DOCUMENT_VERSIONS","MIXED_ORDER_AND_RETURN","AMBIGUOUS_DELIVERY_DATE","CURRENCY_MISMATCH","TOTAL_MISMATCH","MISSING_ATTACHMENT"];
// Extraction-failure reasons stop mattering once a reviewer has entered lines by hand.
const EXTRACTION_FAILURE=new Set<ReasonCode>(["MODEL_UNAVAILABLE","MODEL_TIMEOUT","MODEL_OUTPUT_INVALID","PARSING_FAILED","BUDGET_EXCEEDED","NO_ORDER_LINES"]);
function assertEditable(order:ValidatedDraft){
  if (["exported","cancelled","duplicate","parsing","received"].includes(order.status)) throw new ServiceError("VALIDATION_FAILED","This order cannot be edited; create an amendment for an exported order");
}
const isManualEntry=(order:ValidatedDraft)=>order.status==="failed"||["unknown","unclear"].includes(order.intent);
const toExtractedLine=({id,position,rawText,sku,manufacturerReference,customerAlias,description,quantity,unit,originalUnit,quotedUnitPrice,attributes,evidenceIds}:ExtractedLine):ExtractedLine=>({id,position,rawText,sku,manufacturerReference,customerAlias,description,quantity,unit,originalUnit,quotedUnitPrice,attributes,evidenceIds});
async function selectedProductsFor(client:DbClient,lines:DraftLine[],picked:Set<string>):Promise<Map<string,Product>> {
  const selected=new Map<string,Product>();
  for (const line of lines) if (line.productId && (picked.has(line.id) || line.matchMethod==="manual")) {
    const product=(await client.query("SELECT data FROM products WHERE id=$1",[line.productId])).rows[0]?.data;
    if (!product) throw new ServiceError("VALIDATION_FAILED","Selected product does not exist");
    selected.set(line.id,product);
  }
  return selected;
}
interface Rebuild { lines:ExtractedLine[];customerId:string|null;poNumber:string|null;requestedDeliveryDate:string|null;shippingAddressId:string|null;selectedProducts:Map<string,Product>;
  resolutions?:Array<{code:ReasonCode;lineId:string|null;resolution:string}>;carryLineIds?:Set<string>;removedLines?:RemovedLine[]; }
/** Single revalidation path for every manual change: edit, add line, remove line, customer assignment. Bumps the version and withdraws approval. */
async function rebuild(client:DbClient,order:ValidatedDraft,spec:Rebuild):Promise<ValidatedDraft> {
  const manual=isManualEntry(order),removedLines=spec.removedLines??order.removedLines??[];
  const originalExtracted:ExtractedOrder|null=(await client.query("SELECT extracted FROM messages WHERE id=$1",[order.sourceMessageId])).rows[0]?.extracted??null;
  const sourceText=(await client.query("SELECT data->>'text' AS text FROM documents WHERE message_id=$1",[order.sourceMessageId])).rows.map(r=>r.text).filter(Boolean).join("\n");
  const reasons=(originalExtracted?.reasons??order.reasons.filter(r=>KEEP_REASONS.includes(r.code))).filter(r=>r.code!=="INCOMPLETE_EXTRACTION"&&!(r.code==="NEW_SHIPPING_ADDRESS"&&spec.shippingAddressId)&&!(manual&&spec.lines.length&&EXTRACTION_FAILURE.has(r.code)));
  // Rows the reviewer deliberately removed still exist in the source text, so they must not re-trigger the completeness check.
  const coverage=lineCoverage(sourceText,spec.lines.length+removedLines.filter(r=>!r.id.startsWith("manual-")).length);if(coverage)reasons.push(coverage);
  const intent=manual&&spec.lines.length&&["unknown","unclear"].includes(order.intent)?"new_order":order.intent;
  const extracted:ExtractedOrder={schemaVersion:1,intent,poNumber:spec.poNumber,relatedPoNumber:null,revision:order.revision,requestedDeliveryDate:spec.requestedDeliveryDate,requestedAddress:originalExtracted?.requestedAddress??null,
    currency:originalExtracted?.currency??order.currency,quotedTotal:originalExtracted?.quotedTotal??null,lines:spec.lines,evidence:[],reasons};
  const context=await validationContext(client,spec.customerId,new Date().toISOString(),order.pricingDate??londonDate(order.createdAt),order.suggestedCustomer?.customerName);
  const carried=spec.carryLineIds?[...order.reasons.filter(r=>r.resolved&&r.code!=="TOTAL_MISMATCH"),...order.lines.filter(l=>spec.carryLineIds!.has(l.id)).flatMap(l=>l.reasons.filter(r=>r.resolved))].map(r=>({code:r.code,lineId:r.lineId,resolution:r.resolution!})):[];
  const validation=await validate(extracted,{...context,shippingAddressId:spec.shippingAddressId,selectedProducts:spec.selectedProducts,resolutions:[...carried,...(spec.resolutions??[])]});
  const updated:ValidatedDraft={...order,...validation,catalogueVersion:context.catalogueVersion,intent,customerId:context.customer?.id??null,customerName:context.customer?.name??null,poNumber:spec.poNumber,requestedDeliveryDate:spec.requestedDeliveryDate,approval:null,version:order.version+1,updatedAt:new Date().toISOString(),
    suggestedCustomer:context.customer?null:order.suggestedCustomer??null,removedLines,processingMode:manual&&spec.lines.length?"manual":order.processingMode};
  await applyBusinessDuplicate(client,updated);
  updated.contentHash=contentHash(updated);
  if (order.approval) await client.query("UPDATE approvals SET data=jsonb_set(data,'{invalidatedAt}',to_jsonb($2::text)) WHERE id=$1",[order.approval.id,updated.updatedAt]);
  await saveOrder(client,updated);
  return updated;
}
export async function editOrder(actor:Session,orderId:string,input:EditOrderRequest):Promise<OrderDetail> {
  mutate(actor); await initialiseDatabase();
  return transaction(async client=>{
    const order=await lockedOrder(client,orderId,input.expectedVersion);
    assertEditable(order);
    const patch=input.patch;
    const oldIds=new Set(order.lines.map(l=>l.id));
    if (patch.lines && (patch.lines.length!==order.lines.length || patch.lines.some(l=>!oldIds.has(l.id)))) throw new ServiceError("VALIDATION_FAILED","Every source line must remain represented; lines cannot be silently omitted");
    const lines=order.lines.map(old=>{
      const edited=patch.lines?.find(l=>l.id===old.id);
      if (!edited) return old;
      return {...old,quantity:edited.quantity,unit:edited.unit,quotedUnitPrice:edited.quotedUnitPrice,description:edited.description,productId:edited.productId};
    });
    const selectedProducts=await selectedProductsFor(client,lines,new Set((patch.lines??[]).filter(l=>l.productId).map(l=>l.id)));
    const customerId=patch.customerId===undefined?order.customerId:patch.customerId;
    if (customerId && !(await client.query("SELECT 1 FROM customers WHERE id=$1",[customerId])).rowCount) throw new ServiceError("VALIDATION_FAILED","Unknown customer",400);
    const customerChanged=customerId!==order.customerId;
    const updated=await rebuild(client,order,{lines:lines.map(toExtractedLine),customerId,poNumber:patch.poNumber===undefined?order.poNumber:patch.poNumber,
      requestedDeliveryDate:patch.requestedDeliveryDate===undefined?order.requestedDeliveryDate:patch.requestedDeliveryDate,
      // An address approved for the previous customer cannot carry over to a different customer.
      shippingAddressId:patch.shippingAddressId!==undefined?patch.shippingAddressId:customerChanged?null:order.shippingAddressId,selectedProducts,resolutions:patch.reasonResolutions});
    await audit(client,orderId,actor,"order.edited",updated.version,{approvalInvalidated:!!order.approval});
    if (customerChanged) await audit(client,orderId,actor,"order.customer_assigned",updated.version,{customerId,previousCustomerId:order.customerId,viaSuggestion:!!customerId&&order.suggestedCustomer?.customerId===customerId,repriced:true});
    return detail(client,orderId);
  });
}
/** Confirm (or change) the customer; revalidates so agreement prices and approved addresses apply. */
export function assignCustomer(actor:Session,orderId:string,input:AssignCustomerRequest):Promise<OrderDetail> {
  const parsed=AssignCustomerRequestSchema.parse(input);
  return editOrder(actor,orderId,{expectedVersion:parsed.expectedVersion,patch:{customerId:parsed.customerId}});
}
export async function addLine(actor:Session,orderId:string,input:AddLineRequest):Promise<OrderDetail> {
  mutate(actor); input=AddLineRequestSchema.parse(input); await initialiseDatabase();
  return transaction(async client=>{
    const order=await lockedOrder(client,orderId,input.expectedVersion);
    assertEditable(order);
    if (order.lines.length>=100) throw new ServiceError("VALIDATION_FAILED","An order can have at most 100 lines");
    const spec=input.line;
    const product:Product|null=spec.productId?(await client.query("SELECT data FROM products WHERE id=$1",[spec.productId])).rows[0]?.data??null:null;
    if (spec.productId && !product) throw new ServiceError("VALIDATION_FAILED","Selected product does not exist",400);
    const lineId=`manual-${randomBytes(4).toString("hex")}`;
    const added:ExtractedLine={id:lineId,position:order.lines.length+1,rawText:`[manual entry by ${actor.email}] ${spec.quantity} ${spec.unit} ${spec.sku??product?.sku??spec.description}`.slice(0,8000),sku:product?null:spec.sku?.toUpperCase()||null,manufacturerReference:null,customerAlias:null,
      description:spec.description,quantity:spec.quantity,unit:spec.unit,originalUnit:spec.unit,quotedUnitPrice:spec.quotedUnitPrice??null,attributes:{},evidenceIds:[]};
    const selectedProducts=await selectedProductsFor(client,order.lines,new Set());if (product) selectedProducts.set(lineId,product);
    const updated=await rebuild(client,order,{lines:[...order.lines.map(toExtractedLine),added],customerId:order.customerId,poNumber:order.poNumber,requestedDeliveryDate:order.requestedDeliveryDate,
      shippingAddressId:order.shippingAddressId,selectedProducts,carryLineIds:new Set(order.lines.map(l=>l.id))});
    await audit(client,orderId,actor,"line.added",updated.version,{lineId,sku:product?.sku??added.sku,quantity:spec.quantity,unit:spec.unit,reason:input.reason,approvalInvalidated:!!order.approval,manualEntry:isManualEntry(order)});
    return detail(client,orderId);
  });
}
export async function removeLine(actor:Session,orderId:string,lineId:string,input:RemoveLineRequest):Promise<OrderDetail> {
  mutate(actor); input=RemoveLineRequestSchema.parse(input); await initialiseDatabase();
  return transaction(async client=>{
    const order=await lockedOrder(client,orderId,input.expectedVersion);
    assertEditable(order);
    const gone=order.lines.find(l=>l.id===lineId);
    if (!gone) throw new ServiceError("NOT_FOUND","Line not found on this order",404);
    const remaining=order.lines.filter(l=>l.id!==lineId);
    const at=new Date().toISOString();
    const removedLines:RemovedLine[]=[...(order.removedLines??[]),{id:gone.id,position:gone.position,sku:gone.selectedSku??gone.sku,description:gone.description.slice(0,500),quantity:gone.quantity,unit:gone.unit,reason:input.reason,removedBy:actor.userId,removedAt:at}];
    const selectedProducts=await selectedProductsFor(client,remaining,new Set());
    const updated=await rebuild(client,order,{lines:remaining.map((l,i)=>({...toExtractedLine(l),position:i+1})),customerId:order.customerId,poNumber:order.poNumber,requestedDeliveryDate:order.requestedDeliveryDate,
      shippingAddressId:order.shippingAddressId,selectedProducts,carryLineIds:new Set(remaining.map(l=>l.id)),removedLines});
    await audit(client,orderId,actor,"line.removed",updated.version,{lineId,sku:gone.selectedSku??gone.sku,quantity:gone.quantity,unit:gone.unit,reason:input.reason,approvalInvalidated:!!order.approval});
    return detail(client,orderId);
  });
}
const REPROCESSABLE=["failed","needs_review","draft_ready","not_order","amendment_review","cancellation_review"];
const REPROCESS_LIMIT=Number(process.env.REPROCESS_LIMIT_PER_ORDER??3);
/** Re-run extraction on the original message. Manual edits are replaced (version history keeps them); each run reserves model budget like the first. Reviewers get a few runs per order, administrators more. */
export async function reprocessOrder(actor:Session,orderId:string,input:ReprocessRequest):Promise<OrderDetail> {
  mutate(actor); input=ReprocessRequestSchema.parse(input); await initialiseDatabase();
  return transaction(async client=>{
    const order=await lockedOrder(client,orderId,input.expectedVersion);
    if (!REPROCESSABLE.includes(order.status)) throw new ServiceError("VALIDATION_FAILED","This order cannot be reprocessed in its current state; withdraw approval or wait for the running job",409);
    if ((await client.query("SELECT 1 FROM jobs WHERE message_id=$1 AND status IN ('queued','running','retry_wait')",[order.sourceMessageId])).rowCount) throw new ServiceError("VALIDATION_FAILED","Processing is already in progress for this order",409);
    const runs=Number((await client.query("SELECT count(*)::int AS n FROM audit_events WHERE order_id=$1 AND data->>'action'='order.reprocess_requested'",[orderId])).rows[0].n);
    if (runs>=REPROCESS_LIMIT && actor.role!=="admin") throw new ServiceError("BUDGET_EXCEEDED","Reprocess limit reached for this order; an administrator can run it again",422);
    const jobId=id("job"),at=new Date().toISOString();
    const updated:ValidatedDraft={...order,status:"parsing",version:order.version+1,approval:null,updatedAt:at};updated.contentHash=contentHash(updated);
    await saveOrder(client,updated);
    await client.query("INSERT INTO jobs(id,type,message_id,order_id,status) VALUES($1,'process_message',$2,$3,'queued')",[jobId,order.sourceMessageId,orderId]);
    await audit(client,orderId,actor,"order.reprocess_requested",updated.version,{jobId,previousVersion:order.version,previousStatus:order.status,run:runs+1});
    return detail(client,orderId);
  });
}
export async function approveOrder(actor:Session,orderId:string,input:ApproveRequest):Promise<OrderDetail> {
  mutate(actor); await initialiseDatabase();
  return transaction(async client=>{
    const order=await lockedOrder(client,orderId,input.expectedVersion);
    if(order.contentHash!==input.contentHash || order.contentHash!==contentHash(order)) throw new ServiceError("STALE_VERSION","Content hash changed; refresh the order",409);
    await rejectBusinessDuplicate(client,order);
    canApprove(order);
    // Recheck mutable master account state inside the same transaction.
    const customer=(await client.query("SELECT data FROM customers WHERE id=$1 FOR SHARE",[order.customerId])).rows[0]?.data;
    if (!customer || customer.onHold) throw new ServiceError("ACCOUNT_ON_HOLD","Account cannot currently be approved");
    const approval={id:id("approval"),orderId,version:order.version,contentHash:order.contentHash,approvedBy:actor.userId,approvedAt:new Date().toISOString(),invalidatedAt:null};
    await client.query("INSERT INTO approvals(id,order_id,version,content_hash,data) VALUES($1,$2,$3,$4,$5)",[approval.id,orderId,order.version,order.contentHash,approval]);
    await saveOrder(client,{...order,status:"approved",approval,updatedAt:approval.approvedAt},false);
    await audit(client,orderId,actor,"order.approved",order.version,{contentHash:order.contentHash});
    return detail(client,orderId);
  });
}
const unitMapping: Partial<Record<Unit,string>> = {each:"uom.product_uom_unit",pack:"pennbridge.uom_pack",box:"pennbridge.uom_box",pair:"pennbridge.uom_pair",roll:"pennbridge.uom_roll",metre:"uom.product_uom_meter",litre:"uom.product_uom_litre",kg:"uom.product_uom_kgm",...(process.env.ODOO_UNIT_EXTERNAL_IDS?JSON.parse(process.env.ODOO_UNIT_EXTERNAL_IDS):{})};
export function setOdooUnitMapping(mapping: Partial<Record<Unit,string>>) { Object.assign(unitMapping,mapping); }
// Spreadsheet formula injection guard: text that starts with = + - @ (or tab/CR) is neutralised with a leading apostrophe.
// Quantities and prices are validated decimals and bypass the guard so they stay numeric.
const csvCell=(value:string,numeric=false)=>{
  const safe=value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,"");
  return `"${(!numeric&&/^[=+\-@\t\r]/.test(safe)?`'${safe}`:safe).replaceAll('"','""')}"`;
};
export function renderOdooCsv(snapshot:Pick<ExportSnapshot,"externalId"|"customerExternalId"|"shippingAddressExternalId"|"poNumber"|"lines"> & {currency?:string}):string {
  const currency=snapshot.currency??"GBP";
  if(!/^[A-Z]{3}$/.test(currency)) throw new ServiceError("VALIDATION_FAILED","Invalid order currency");
  const headers=["id","partner_id/id","partner_shipping_id/id","client_order_ref","currency_id/id","order_line/id","order_line/product_id/id","order_line/name","order_line/product_uom_qty","order_line/product_uom_id/id","order_line/price_unit"];
  const rows=snapshot.lines.map((line,index)=>{
    const unitId=unitMapping[line.unit];
    if(!unitId) throw new ServiceError("VALIDATION_FAILED",`No verified Odoo unit mapping configured for ${line.unit}`);
    return [index===0?snapshot.externalId:"",index===0?snapshot.customerExternalId:"",index===0?snapshot.shippingAddressExternalId:"",index===0?snapshot.poNumber:"",index===0?`base.${currency}`:"",`${snapshot.externalId}_line_${index+1}`,line.productExternalId,line.description,line.quantity,unitId,line.unitPrice].map((cell,column)=>csvCell(cell,column===8||column===10)).join(",");
  });
  return `${headers.join(",")}\n${rows.join("\n")}\n`;
}
export async function exportOrder(actor:Session,orderId:string,input:ExportRequest):Promise<ExportSnapshot> {
  mutate(actor); await initialiseDatabase();
  return transaction(async client=>{
    const order=await lockedOrder(client,orderId,input.expectedVersion);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,2))",[input.idempotencyKey]);
    const existing=(await client.query("SELECT data FROM exports WHERE idempotency_key=$1 OR (order_id=$2 AND version=$3 AND data->>'state'<>'voided') ORDER BY (idempotency_key=$1) DESC LIMIT 1",[input.idempotencyKey,orderId,order.version])).rows[0]?.data as ExportSnapshot|undefined;
    if(existing?.state==="voided") throw new ServiceError("VALIDATION_FAILED","That export was voided; use a new idempotency key to prepare another",409);
    if(existing) { if(existing.orderId!==orderId || existing.orderVersion!==order.version) throw new ServiceError("STALE_VERSION","Idempotency key belongs to a different order/version",409); return existing; }
    if(order.status!=="approved" || !order.approval || order.approval.invalidatedAt || order.approval.version!==order.version || order.approval.contentHash!==order.contentHash || contentHash(order)!==order.contentHash) throw new ServiceError("APPROVAL_REQUIRED","A current version-bound approval is required",409);
    await rejectBusinessDuplicate(client,order);
    // Reuse the invariant check with a reviewable state; approval does not bypass validation.
    canApprove({...order,status:"draft_ready"});
    const customer=(await client.query("SELECT data FROM customers WHERE id=$1 FOR SHARE",[order.customerId])).rows[0]?.data as Customer|undefined;
    const address=(await client.query("SELECT data FROM addresses WHERE id=$1 AND customer_id=$2",[order.shippingAddressId,order.customerId])).rows[0]?.data as Address|undefined;
    if(!customer || customer.onHold || !address?.approved) throw new ServiceError("VALIDATION_FAILED","Customer and delivery address must remain approved");
    const lines=[];
    for(const line of order.lines) {
      const product=(await client.query("SELECT data FROM products WHERE id=$1 FOR SHARE",[line.productId])).rows[0]?.data as Product|undefined;
      if(!product?.active || product.catalogueVersion!==order.catalogueVersion || product.sellingUnit!==line.unit) throw new ServiceError("STALE_CATALOGUE","Master product changed; revalidate before export",409);
      lines.push({lineId:line.id,productExternalId:product.externalId,sku:product.sku,description:line.description||product.description,quantity:line.quantity!,unit:product.sellingUnit,unitPrice:line.unitPrice!});
    }
    const now=new Date().toISOString();
    const snapshot:ExportSnapshot={id:id("export"),orderId,orderVersion:order.version,approvalId:order.approval.id,contentHash:order.contentHash,idempotencyKey:input.idempotencyKey,externalId:`pennbridge.quote_${orderId.replace(/[^a-zA-Z0-9_]/g,"_")}`,
      customerExternalId:customer.externalId,shippingAddressExternalId:address.externalId,poNumber:order.poNumber!,currency:order.currency,lines,total:order.total,mappingVersion:"odoo19-quotation-v2",artifactHash:"",filename:`${orderId}-v${order.version}.csv`,
      state:"prepared",preparedBy:actor.userId,preparedAt:now,downloadedAt:null,verifiedAt:null,verifiedBy:null,quotationReference:null};
    const artifact=Buffer.from(renderOdooCsv(snapshot)); snapshot.artifactHash=sha256(artifact);
    await client.query("INSERT INTO exports(id,order_id,version,idempotency_key,data,artifact) VALUES($1,$2,$3,$4,$5,$6)",[snapshot.id,orderId,order.version,input.idempotencyKey,snapshot,artifact]);
    await saveOrder(client,{...order,status:"exported",updatedAt:now},false); await audit(client,orderId,actor,"export.prepared",order.version,{exportId:snapshot.id});
    return snapshot;
  });
}
/** Export states: prepared -> downloaded -> import_verified; prepared|downloaded -> voided (frees the version for a fresh export). */
export async function downloadExport(actor:Session,orderId:string,exportId:string):Promise<{filename:string;content:Buffer}> {
  mutate(actor);
  return transaction(async client=>{
    const row=(await client.query("SELECT data,artifact FROM exports WHERE id=$1 AND order_id=$2 FOR UPDATE",[exportId,orderId])).rows[0];
    if(!row) throw new ServiceError("NOT_FOUND","Export not found",404);
    const snapshot:ExportSnapshot=row.data;
    if(snapshot.state==="voided") throw new ServiceError("VALIDATION_FAILED","This export was voided and can no longer be downloaded",409);
    if(snapshot.state==="prepared") {snapshot.state="downloaded";snapshot.downloadedAt=new Date().toISOString();await client.query("UPDATE exports SET data=$2 WHERE id=$1",[exportId,snapshot]);}
    await audit(client,orderId,actor,"export.downloaded",snapshot.orderVersion,{exportId});
    return {filename:snapshot.filename,content:row.artifact};
  });
}
export async function verifyExport(actor:Session,orderId:string,exportId:string,input:VerifyExportRequest):Promise<ExportSnapshot> {
  mutate(actor);input=VerifyExportRequestSchema.parse(input);
  return transaction(async client=>{
    const row=(await client.query("SELECT data FROM exports WHERE id=$1 AND order_id=$2 FOR UPDATE",[exportId,orderId])).rows[0];
    if(!row) throw new ServiceError("NOT_FOUND","Export not found",404);
    const current:ExportSnapshot=row.data,reference=input.quotationReference.trim();
    if(current.state==="import_verified") {
      if(current.quotationReference===reference) return current; // idempotent replay
      throw new ServiceError("VALIDATION_FAILED","This export was already verified with a different quotation reference",409);
    }
    if(current.state==="voided") throw new ServiceError("VALIDATION_FAILED","This export was voided",409);
    if(current.state!=="downloaded") throw new ServiceError("VALIDATION_FAILED","Download the file and import it before verifying",409);
    const snapshot:ExportSnapshot={...current,state:"import_verified",verifiedAt:new Date().toISOString(),verifiedBy:actor.userId,quotationReference:reference};
    await client.query("UPDATE exports SET data=$2 WHERE id=$1",[exportId,snapshot]);await audit(client,orderId,actor,"export.import_verified",snapshot.orderVersion,{exportId,quotationReference:reference});return snapshot;
  });
}
/** Withdraw an export that was never imported (wrong file, import failed). The order returns to approved so it can be exported again with a new idempotency key. */
export async function voidExport(actor:Session,orderId:string,exportId:string,input:VoidExportRequest):Promise<ExportSnapshot> {
  mutate(actor);input=VoidExportRequestSchema.parse(input);
  return transaction(async client=>{
    const row=(await client.query("SELECT data FROM exports WHERE id=$1 AND order_id=$2 FOR UPDATE",[exportId,orderId])).rows[0];
    if(!row) throw new ServiceError("NOT_FOUND","Export not found",404);
    const current:ExportSnapshot=row.data;
    if(current.state==="voided") return current;
    if(current.state==="import_verified") throw new ServiceError("VALIDATION_FAILED","A verified import cannot be voided here; reverse it in the destination system",409);
    const now=new Date().toISOString(),snapshot:ExportSnapshot={...current,state:"voided",voidedAt:now,voidedBy:actor.userId,voidReason:input.reason.trim()};
    await client.query("UPDATE exports SET data=$2 WHERE id=$1",[exportId,snapshot]);
    const order:ValidatedDraft|undefined=(await client.query("SELECT data FROM orders WHERE id=$1 FOR UPDATE",[orderId])).rows[0]?.data;
    if(order&&order.status==="exported"&&order.version===current.orderVersion) await saveOrder(client,{...order,status:"approved",updatedAt:now},false);
    await audit(client,orderId,actor,"export.voided",snapshot.orderVersion,{exportId,reason:snapshot.voidReason!});return snapshot;
  });
}
export async function cancelOrder(actor:Session,orderId:string,input:CancelRequest):Promise<OrderDetail> {
  mutate(actor);
  return transaction(async client=>{
    const order=await lockedOrder(client,orderId,input.expectedVersion);
    if(order.status==="exported") throw new ServiceError("ALREADY_EXPORTED","Exported quotations require a reviewed cancellation in Odoo; desk cancellation cannot undo an import");
    const updated={...order,status:"cancelled" as const,version:order.version+1,approval:null,updatedAt:new Date().toISOString()};
    updated.contentHash=contentHash(updated);
    if(order.approval) await client.query("UPDATE approvals SET data=jsonb_set(data,'{invalidatedAt}',to_jsonb($2::text)) WHERE id=$1",[order.approval.id,updated.updatedAt]);
    await saveOrder(client,updated); await audit(client,orderId,actor,"order.cancelled",updated.version,{reason:input.reason}); return detail(client,orderId);
  });
}
export async function createAmendment(actor:Session,orderId:string,input:AmendmentRequest):Promise<OrderDetail> {
  mutate(actor);
  return transaction(async client=>{
    const original=await lockedOrder(client,orderId,input.expectedVersion);
    const amendmentRow=(await client.query("SELECT data FROM orders WHERE message_id=$1 FOR UPDATE",[input.sourceMessageId])).rows[0];
    if(!amendmentRow) throw new ServiceError("NOT_FOUND","Amendment source has not been processed",404);
    const amendment:ValidatedDraft=amendmentRow.data;
    if(amendment.id===original.id || amendment.customerId!==original.customerId || amendment.intent!=="amendment") throw new ServiceError("VALIDATION_FAILED","Source must be a separate amendment for the same verified customer");
    amendment.relatedOrderId=original.id;amendment.status="amendment_review";amendment.version++;amendment.approval=null;amendment.updatedAt=new Date().toISOString();amendment.contentHash=contentHash(amendment);
    await saveOrder(client,amendment);await audit(client,amendment.id,actor,"amendment.linked",amendment.version,{relatedOrderId:original.id});return detail(client,amendment.id);
  });
}
export async function listCatalogue(actor:Session,query:{q?:string;customerId?:string}={}):Promise<Product[]> {
  allow(actor);await initialiseDatabase();
  if(query.q) {
    const exact=await repository(pool).exactSku(query.q);
    if(exact.length)return exact;
    if(query.customerId) {const aliases=await repository(pool).aliases(query.customerId,query.q);if(aliases.length)return aliases;}
    return repository(pool).search(query.q,20);
  }
  return (await pool.query("SELECT data FROM products ORDER BY sku LIMIT 50")).rows.map(r=>r.data);
}
export async function listCustomers(actor:Session):Promise<{customers:Customer[];addresses:Address[]}> {
  allow(actor);await initialiseDatabase(); const [customers,addresses]=await Promise.all([pool.query("SELECT data FROM customers ORDER BY id"),pool.query("SELECT data FROM addresses ORDER BY id")]);return {customers:customers.rows.map(r=>r.data),addresses:addresses.rows.map(r=>r.data)};
}
export async function listJobs(actor:Session):Promise<Job[]> { allow(actor);await initialiseDatabase();return (await pool.query("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 100")).rows.map(jobFromRow); }
export async function retryJob(actor:Session,jobId:string):Promise<Job> {
  allow(actor,["admin"]);
  return transaction(async client=>{
    const row=(await client.query("SELECT * FROM jobs WHERE id=$1 FOR UPDATE",[jobId])).rows[0];if(!row)throw new ServiceError("NOT_FOUND","Job not found",404);
    if(!["dead_letter","retry_wait"].includes(row.status))throw new ServiceError("VALIDATION_FAILED","Only failed/retrying jobs can be manually retried");
    const updated=(await client.query("UPDATE jobs SET status='queued',attempts=0,available_at=now(),lease_owner=NULL,lease_expires_at=NULL,error_code=NULL,error_message=NULL,updated_at=now() WHERE id=$1 RETURNING *",[jobId])).rows[0];
    await audit(client,row.order_id,actor,"job.retried",null,{jobId});return jobFromRow(updated);
  });
}
export async function stats(actor:Session) {
  allow(actor);await initialiseDatabase();
  const [statuses,catalogue,jobs,usage]=await Promise.all([pool.query("SELECT status,count(*)::int AS count FROM orders GROUP BY status"),pool.query("SELECT count(*)::int AS count FROM products"),pool.query("SELECT count(*)::int AS count FROM jobs WHERE status IN ('queued','running','retry_wait')"),pool.query("SELECT data FROM model_usage")]);
  // live if configured; mock only in DEMO_MODE; otherwise reviewers enter orders manually.
  const live=process.env.LIVE_AI_ENABLED==="true"&&(process.env.AI_PROVIDER==="gemini"?!!(process.env.GEMINI_API_KEY||process.env.GEMINI_API_KEY_FILE):!!process.env.ANTHROPIC_API_KEY);
  const mode:"live"|"mock"|"manual"=live?"live":process.env.DEMO_MODE==="true"?"mock":"manual";
  const counts=Object.fromEntries(statuses.rows.map(r=>[r.status,r.count]));
  return {counts,totalOrders:statuses.rows.reduce((n,r)=>n+r.count,0),catalogueCount:catalogue.rows[0].count,pendingJobs:jobs.rows[0].count,mode,provider:mode==="live"?(process.env.AI_PROVIDER==="gemini"?"gemini":"anthropic"):mode,model:mode==="live"?process.env.EXTRACTION_MODEL||null:null,modelCalls:usage.rowCount??0,modelUsage:usage.rows.map(r=>r.data)};
}
export async function intake(actor:Session,input:IntakeRequest):Promise<IntakeResponse> {
  allow(actor,["reviewer","admin","ingestion"]);input=IntakeRequestSchema.parse(input);
  if(actor.userId==="mailbox-ingestion" && (input.channel!=="email" || input.trustedCustomerId)) throw new ServiceError("FORBIDDEN","Mailbox intake cannot assert customer identity or use another source channel",403);
  await initialiseDatabase();
  if(input.trustedCustomerId && actor.role!=="admin" && actor.role!=="ingestion" && input.channel!=="upload" && input.channel!=="manual")throw new ServiceError("FORBIDDEN","Only the authorized harness can supply trusted synthetic customer identity",403);
  if(!/^[A-Za-z0-9+/]*={0,2}$/.test(input.contentBase64))throw new ServiceError("VALIDATION_FAILED","Invalid base64 content",400);
  const content=Buffer.from(input.contentBase64,"base64");if(content.length>10*1024*1024)throw new ServiceError("FILE_TOO_LARGE","Upload exceeds 10 MB",413);if(!content.length)throw new ServiceError("EMPTY_DOCUMENT","Empty upload",400);
  const hash=sha256(content);const transportKey=`${input.channel}:${input.externalMessageId??`${input.trustedCustomerId??"unverified"}:${hash}`}`;
  return transaction(async client=>{
    // Serialize equal transport/content values even when no row exists yet.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,3))",[transportKey]);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[hash]);
    const existing=(await client.query("SELECT m.id,m.transport_key,m.content_hash,m.data,o.id AS order_id,j.id AS job_id FROM messages m LEFT JOIN orders o ON o.message_id=m.id LEFT JOIN jobs j ON j.message_id=m.id WHERE m.transport_key=$1 OR (m.content_hash=$2 AND (m.data->>'trustedCustomerId') IS NOT DISTINCT FROM $3::text) ORDER BY (m.transport_key=$1) DESC,m.created_at LIMIT 1",[transportKey,hash,input.trustedCustomerId??null])).rows[0];
    if(existing && existing.transport_key===transportKey && (existing.content_hash!==hash || existing.data.trustedCustomerId!==(input.trustedCustomerId??null))) throw new ServiceError("DUPLICATE_MESSAGE","Transport identity is already associated with different content or customer context",409);
    if(existing) {await audit(client,existing.order_id,actor,"intake.duplicate",null,{transportKey});return {messageId:existing.id,orderId:existing.order_id??null,jobId:existing.job_id??null,duplicate:true};}
    if(input.trustedCustomerId && !(await client.query("SELECT id FROM customers WHERE id=$1",[input.trustedCustomerId])).rowCount)throw new ServiceError("VALIDATION_FAILED","Unknown customer selection");
    const messageId=id("message"),orderId=id("order"),jobId=id("job"),docId=`${messageId}_doc_0`,now=new Date().toISOString();
    const source:SourceMessage={id:messageId,channel:input.channel,externalMessageId:input.externalMessageId??null,transportKey,contentHash:hash,receivedAt:now,sender:null,subject:input.filename,
      trustedCustomerId:input.trustedCustomerId??null,identitySource:input.trustedCustomerId ? actor.role==="ingestion"||actor.role==="admin"&&input.channel==="synthetic_email"?"synthetic_harness":"local_reviewer":"unverified",documentIds:[docId],duplicateOfMessageId:null};
    const storedInput={filename:input.filename,mediaType:input.mediaType,documentId:docId};
    await client.query("INSERT INTO messages(id,transport_key,content_hash,data,intake) VALUES($1,$2,$3,$4,$5)",[messageId,transportKey,hash,source,storedInput]);
    const storagePath=path.join(storageRoot,docId);await writeFile(storagePath,content,{mode:0o600});
    const document:Document={id:docId,messageId,filename:input.filename,mediaType:input.mediaType,sizeBytes:content.length,contentHash:hash,kind:["synthetic_email","email","mailpit"].includes(input.channel)?"email":"upload",parser:null,pageCount:null,text:null,createdAt:now};
    await client.query("INSERT INTO documents(id,message_id,data,storage_path) VALUES($1,$2,$3,$4)",[docId,messageId,document,storagePath]);
    const order:ValidatedDraft={id:orderId,version:1,contentHash:"",sourceMessageId:messageId,customerId:source.trustedCustomerId,customerName:null,intent:"unknown",status:"received",poNumber:null,relatedOrderId:null,revision:null,requestedDeliveryDate:null,shippingAddressId:null,currency:"GBP",catalogueVersion:CATALOGUE_VERSION,lines:[],reasons:[],total:"0.00",approval:null,createdAt:now,updatedAt:now,processingMode:"mock",senderEmail:null,subject:input.filename,pricingDate:londonDate(now),suggestedCustomer:null,removedLines:[]};order.contentHash=contentHash(order);
    await saveOrder(client,order);await client.query("INSERT INTO jobs(id,type,message_id,order_id,status) VALUES($1,'process_message',$2,$3,'queued')",[jobId,messageId,orderId]);await audit(client,orderId,actor,"intake.received",1,{messageId,channel:input.channel});
    return {messageId,orderId,jobId,duplicate:false};
  });
}
export async function getDocument(actor:Session,documentId:string):Promise<{document:Document;content:Buffer|null}> {
  allow(actor);const row=(await pool.query("SELECT data,storage_path FROM documents WHERE id=$1",[documentId])).rows[0];if(!row)throw new ServiceError("NOT_FOUND","Document not found",404);return {document:row.data,content:row.storage_path?await readFile(row.storage_path):null};
}

export interface ParsedInput {
  documents:Document[];evidence:DocumentEvidence[];text:string;structured?:ExtractedOrder;reasons?:ExtractedOrder["reasons"];
  files?:Array<{documentId:string;content:Buffer}>;sender?:string;subject?:string;externalMessageId?:string;authResults?:string;
}
export interface ProcessingDependencies { parse:(input:{filename:string;mediaType:string;content:Buffer;messageId:string;documentId:string})=>Promise<ParsedInput>;provider:ExtractionProvider; }
export async function processMessage(job:Job,owner:string,dependencies:ProcessingDependencies):Promise<void> {
  if(!job.messageId || !job.orderId)throw new ServiceError("PARSING_FAILED","Processing job has no message/order");
  const raw=(await pool.query("SELECT m.data,m.intake,d.storage_path FROM messages m JOIN documents d ON d.id=m.intake->>'documentId' WHERE m.id=$1",[job.messageId])).rows[0];
  if(!raw)throw new ServiceError("NOT_FOUND","Source message is missing",404);
  const parsed=await dependencies.parse({...raw.intake,content:await readFile(raw.storage_path),messageId:job.messageId});
  const result=parsed.structured?{extracted:parsed.structured,usage:null}:await dependencies.provider.extract({text:parsed.text,documents:parsed.documents,evidence:parsed.evidence});
  const extracted=ExtractedOrderSchema.parse(result.extracted);extracted.reasons.push(...(parsed.reasons??[]));
  const coverage=lineCoverage(parsed.text,extracted.lines.length);if(coverage)extracted.reasons.push(coverage);
  const documentsById=new Map(parsed.documents.map(d=>[d.id,d]));
  const evidenceById=new Map([...parsed.evidence,...extracted.evidence].map(e=>[e.id,e]));
  anchorEvidence(extracted.evidence,new Map(parsed.documents.map(d=>[d.id,d.text])));
  for(const evidence of extracted.evidence) {
    const document=documentsById.get(evidence.documentId);
    if(!document || document.text===null || !document.text.includes(evidence.quote) || (evidence.startOffset!==null && evidence.endOffset!==null && (evidence.endOffset>document.text.length || !document.text.slice(evidence.startOffset,evidence.endOffset).includes(evidence.quote))))
      throw new ServiceError("MODEL_OUTPUT_INVALID","Extraction evidence does not match the source document");
  }
  for(const line of extracted.lines) if(line.evidenceIds.some(e=>!evidenceById.has(e))) throw new ServiceError("MODEL_OUTPUT_INVALID","An extracted line refers to nonexistent source evidence");
  const source:SourceMessage={...raw.data,sender:parsed.sender??raw.data.sender,subject:parsed.subject??raw.data.subject,externalMessageId:parsed.externalMessageId??raw.data.externalMessageId,documentIds:parsed.documents.map(d=>d.id)};
  // Write content-addressed attachment files before the transaction; no public routes expose paths.
  const paths=new Map<string,string>();for(const file of parsed.files??[]) {if(!parsed.documents.some(d=>d.id===file.documentId))throw new ServiceError("PARSING_FAILED","Parser file does not belong to a document");const storagePath=path.join(storageRoot,sha256(file.documentId));await writeFile(storagePath,file.content,{mode:0o600});paths.set(file.documentId,storagePath);}
  await transaction(async client=>{
    const lease=(await client.query("SELECT * FROM jobs WHERE id=$1 FOR UPDATE",[job.id])).rows[0];
    if(!lease || lease.status!=="running" || lease.lease_owner!==owner || new Date(lease.lease_expires_at).getTime()<=Date.now())throw new ServiceError("STALE_VERSION","Worker lease expired before commit",409);
    const row=(await client.query("SELECT data FROM orders WHERE id=$1 FOR UPDATE",[job.orderId])).rows[0];const existing:ValidatedDraft=row.data;
    if(!["received","parsing","failed"].includes(existing.status)) {await client.query("UPDATE jobs SET status='succeeded',lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1",[job.id]);return;}
    // Customer precedence: reviewer/harness assignment already on the order, then a TRUSTED sender mapping. An untrusted mapping is only a suggestion.
    let customerId=existing.customerId??source.trustedCustomerId,suggested:SuggestedCustomer|null=null;
    if(!customerId){
      const hit=await resolveSender(client,source.sender,parsed.authResults);
      if(hit?.trusted){customerId=hit.suggestion.customerId;source.identitySource="sender_mapping";}
      else if(hit)suggested=hit.suggestion;
    }
    const pricingDate=existing.pricingDate??londonDate(source.receivedAt);
    const context=await validationContext(client,customerId,source.receivedAt,pricingDate,suggested?.customerName);
    const validation=await validate(extracted,context);
    const order:ValidatedDraft={...existing,...validation,catalogueVersion:context.catalogueVersion,customerId:context.customer?.id??null,customerName:context.customer?.name??null,intent:extracted.intent,poNumber:extracted.poNumber,revision:extracted.revision,requestedDeliveryDate:extracted.requestedDeliveryDate,version:existing.version+1,updatedAt:new Date().toISOString(),processingMode:parsed.structured?"structured":dependencies.provider.mode,
      senderEmail:senderParts(source.sender)?.email??null,subject:source.subject,pricingDate,suggestedCustomer:context.customer?null:suggested,removedLines:[]};
    await applyBusinessDuplicate(client,order);
    order.contentHash=contentHash(order);
    await client.query("UPDATE messages SET data=$2,extracted=$3 WHERE id=$1",[source.id,source,extracted]);
    for(const document of parsed.documents) await client.query("INSERT INTO documents(id,message_id,data,storage_path) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET data=excluded.data,storage_path=COALESCE(excluded.storage_path,documents.storage_path)",[document.id,source.id,document,paths.get(document.id)??null]);
    for(const evidence of [...parsed.evidence,...extracted.evidence]) await client.query("INSERT INTO evidence(id,message_id,data) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET data=excluded.data",[evidence.id,source.id,evidence]);
    await saveOrder(client,order);if(result.usage)await client.query("INSERT INTO model_usage(id,order_id,run_id,data) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",[result.usage.id,order.id,result.usage.runId,{...result.usage,orderId:order.id}]);
    await client.query("UPDATE jobs SET status='succeeded',lease_owner=NULL,lease_expires_at=NULL,error_code=NULL,error_message=NULL,updated_at=now() WHERE id=$1",[job.id]);await audit(client,order.id,owner,"order.processed",order.version,{mode:order.processingMode});
  });
}
/** Permanent failures (bad file, budget, config) dead-letter at once; transient ones (timeout, 429/5xx, network, DB) back off and retry. Users only ever see the safe message; raw detail goes to the log. */
export async function processingFailed(job:Job,owner:string,error:unknown):Promise<void> {
  const {code,retryable,message}=classifyFailure(error,ReasonCodeSchema.options);
  console.error(JSON.stringify({event:"processing.error",jobId:job.id,code,retryable,detail:(error instanceof Error?error.message:String(error)).slice(0,300)}));
  if(!retryable) await pool.query("UPDATE jobs SET max_attempts=attempts WHERE id=$1 AND lease_owner=$2 AND status='running'",[job.id,owner]);
  await failJob(job.id,owner,code,message);
  await transaction(async client=>{
    const row=(await client.query("SELECT status FROM jobs WHERE id=$1 FOR UPDATE",[job.id])).rows[0];if(row?.status!=="dead_letter" || !job.orderId)return;
    const current=(await client.query("SELECT data FROM orders WHERE id=$1 FOR UPDATE",[job.orderId])).rows[0]?.data as ValidatedDraft|undefined;
    if(current && ["received","parsing","failed"].includes(current.status)) {current.status="failed";current.version++;current.reasons=[reason(code,message)];current.updatedAt=new Date().toISOString();current.contentHash=contentHash(current);await saveOrder(client,current);await audit(client,current.id,owner,"processing.failed",current.version,{code,retryable});}
  });
}

// ---- Sender -> customer mapping -------------------------------------------------------------------------------------------
// The From header is attacker-controlled. A mapping therefore only becomes the order's customer when an admin marked it trusted
// AND the receiving server's SPF/DKIM/DMARC result passed (REQUIRE_SENDER_AUTH=false relaxes this to 'did not fail').
// Everything else is shown as a suggestion the reviewer must confirm. Precedence: exact address, domain, customer approvedSenders.
async function resolveSender(client:DbClient,sender:string|null|undefined,authResults?:string):Promise<{trusted:boolean;suggestion:SuggestedCustomer}|null> {
  const parts=senderParts(sender);if(!parts)return null;
  const mapped=async(kind:"email"|"domain",value:string)=>(await client.query("SELECT m.id,m.customer_id,m.trusted,c.data->>'name' AS name FROM sender_mappings m JOIN customers c ON c.id=m.customer_id WHERE m.kind=$1 AND m.value=$2",[kind,value])).rows[0];
  let matchedOn:SuggestedCustomer["matchedOn"]="email",row=await mapped("email",parts.email);
  if(!row){matchedOn="domain";row=await mapped("domain",parts.domain);}
  if(!row){
    const approved=(await client.query("SELECT id,data->>'name' AS name FROM customers WHERE EXISTS(SELECT 1 FROM jsonb_array_elements_text(data->'approvedSenders') s WHERE lower(s)=$1) LIMIT 2",[parts.email])).rows;
    if(approved.length!==1)return null;
    row={id:null,customer_id:approved[0].id,trusted:false,name:approved[0].name};matchedOn="approved_sender";
  }
  let trusted=!!row.trusted,note:string|null=null;
  const verdict=authVerdict(authResults);
  if(trusted&&(verdict==="fail"||(process.env.REQUIRE_SENDER_AUTH!=="false"&&verdict!=="pass"))){trusted=false;note="Trusted mapping not applied: the sender's SPF/DKIM/DMARC check did not pass, so the From address may be forged.";}
  if(trusted&&matchedOn==="domain"&&isFreemailDomain(parts.domain)){trusted=false;note="Domain mappings on public mail providers are never trusted.";}
  return {trusted,suggestion:{customerId:row.customer_id,customerName:row.name,mappingId:row.id,matchedOn,sender:parts.email,note}};
}
const mappingFromRow=(r:Record<string,any>):SenderMapping=>({id:r.id,kind:r.kind,value:r.value,customerId:r.customer_id,customerName:r.name??null,trusted:r.trusted,createdBy:r.created_by,createdAt:new Date(r.created_at).toISOString()});
export async function listSenderMappings(actor:Session):Promise<SenderMapping[]> {
  allow(actor,["reviewer","admin"]);await initialiseDatabase();
  return (await pool.query("SELECT m.*,c.data->>'name' AS name FROM sender_mappings m JOIN customers c ON c.id=m.customer_id ORDER BY m.kind,m.value")).rows.map(mappingFromRow);
}
/** Create or update (by kind+value) a mapping. Admin only; trusting a public mail-provider domain is refused. */
export async function upsertSenderMapping(actor:Session,input:SenderMappingInput):Promise<SenderMapping> {
  allow(actor,["admin"]);input=SenderMappingInputSchema.parse(input);await initialiseDatabase();
  const value=input.value.trim().toLowerCase();
  if(input.kind==="email"?!senderParts(value)||senderParts(value)!.email!==value:!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(value)) throw new ServiceError("VALIDATION_FAILED",`Enter a valid ${input.kind==="email"?"email address":"domain such as example.com"}`,400);
  if(input.kind==="domain"&&input.trusted&&isFreemailDomain(value)) throw new ServiceError("VALIDATION_FAILED","A public mail provider domain cannot be trusted; map individual addresses instead",400);
  return transaction(async client=>{
    if(!(await client.query("SELECT 1 FROM customers WHERE id=$1",[input.customerId])).rowCount) throw new ServiceError("VALIDATION_FAILED","Unknown customer",400);
    const row=(await client.query(`INSERT INTO sender_mappings(id,kind,value,customer_id,trusted,created_by) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(kind,value) DO UPDATE SET customer_id=excluded.customer_id,trusted=excluded.trusted,created_by=excluded.created_by RETURNING *`,[id("sender"),input.kind,value,input.customerId,input.trusted,actor.userId])).rows[0];
    await audit(client,null,actor,"sender_mapping.saved",null,{mappingId:row.id,kind:input.kind,value,customerId:input.customerId,trusted:input.trusted});
    row.name=(await client.query("SELECT data->>'name' AS name FROM customers WHERE id=$1",[input.customerId])).rows[0]?.name;
    return mappingFromRow(row);
  });
}
export async function deleteSenderMapping(actor:Session,mappingId:string):Promise<{ok:true}> {
  allow(actor,["admin"]);await initialiseDatabase();
  return transaction(async client=>{
    const row=(await client.query("DELETE FROM sender_mappings WHERE id=$1 RETURNING kind,value",[mappingId])).rows[0];
    if(!row)throw new ServiceError("NOT_FOUND","Sender mapping not found",404);
    await audit(client,null,actor,"sender_mapping.deleted",null,{mappingId,kind:row.kind,value:row.value});return {ok:true};
  });
}
