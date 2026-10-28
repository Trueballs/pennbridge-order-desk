import Decimal from "decimal.js";
import { createHash } from "node:crypto";
import type { Address, CandidateMatch, Customer, DraftLine, ExtractedOrder, ExtractedLine, PriceAgreement, Product, Reason, ReasonCode, StockSnapshot, ValidatedDraft } from "@pennbridge/contracts";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export class ServiceError extends Error {
  constructor(public code: ReasonCode, message: string, public status = 422) { super(message); this.name = "ServiceError"; }
}
export const money = (value: Decimal.Value) => new Decimal(value).toFixed(2);
export const quantity = (value: Decimal.Value) => new Decimal(value).toFixed();
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([key,v]) => `${JSON.stringify(key)}:${canonicalJson(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function contentHash(draft: Pick<ValidatedDraft,"customerId"|"intent"|"poNumber"|"relatedOrderId"|"revision"|"requestedDeliveryDate"|"shippingAddressId"|"currency"|"catalogueVersion"|"lines"|"reasons"|"total">): string {
  const lines = draft.lines.map(l => ({ id:l.id,position:l.position,rawText:l.rawText,sku:l.sku,manufacturerReference:l.manufacturerReference,customerAlias:l.customerAlias,description:l.description,attributes:l.attributes,
    quantity:l.quantity === null ? null : quantity(l.quantity),unit:l.unit,originalUnit:l.originalUnit,quotedUnitPrice:l.quotedUnitPrice,
    productId:l.productId,selectedSku:l.selectedSku,matchMethod:l.matchMethod,normalizedQuantity:l.normalizedQuantity === null ? null : quantity(l.normalizedQuantity),normalizedUnit:l.normalizedUnit,
    unitPrice:l.unitPrice,lineTotal:l.lineTotal,priceAgreementVersion:l.priceAgreementVersion,reasons:l.reasons,evidenceIds:l.evidenceIds }));
  return createHash("sha256").update(canonicalJson({customerId:draft.customerId,intent:draft.intent,poNumber:draft.poNumber,relatedOrderId:draft.relatedOrderId,revision:draft.revision,
    requestedDeliveryDate:draft.requestedDeliveryDate,shippingAddressId:draft.shippingAddressId,currency:draft.currency,catalogueVersion:draft.catalogueVersion,lines,reasons:draft.reasons,total:draft.total})).digest("hex");
}
export function reason(code: ReasonCode, message: string, lineId: string | null = null, severity: Reason["severity"] = "blocking", evidenceIds: string[] = []): Reason {
  return { code,message,lineId,severity,evidenceIds,resolved:false,resolution:null };
}
export interface ValidationRepository {
  exactSku(sku: string): Promise<Product[]>;
  manufacturer(reference: string): Promise<Product[]>;
  aliases(customerId: string, alias: string): Promise<Product[]>;
  search(query: string, limit: number, family?: string, attributes?: ExtractedLine["attributes"]): Promise<Product[]>;
  prices(customerId: string, productId: string): Promise<PriceAgreement[]>;
  stock(productId: string): Promise<StockSnapshot | null>;
}
export interface ValidationContext {
  customer: Customer | null; addresses: Address[]; catalogueVersion: string; at: string; repository: ValidationRepository;
  shippingAddressId?: string | null; selectedProducts?: Map<string,Product>; resolutions?: Array<{code:ReasonCode;lineId:string|null;resolution:string}>;
}
const comparable = (value: unknown) => String(value).toLowerCase().replace(/[^a-z0-9.]+/g," ").trim();
function familyHint(line: ExtractedLine): {family:string;anchor:string} | null {
  const text=`${line.description} ${line.rawText}`;
  if (/\b(?:bolts?|blots?)\b/i.test(text)) return {family:"hex_bolt",anchor:"hex bolt"};
  if (/\bbearings?\b/i.test(text)) return {family:"bearing",anchor:"bearing"};
  if (/\bo[- ]?rings?\b/i.test(text)) return {family:"o_ring",anchor:"O-ring"};
  if (/\bfittings?\b/i.test(text)) return {family:"fitting",anchor:"fitting"};
  if (/\bgloves?\b/i.test(text)) return {family:/work/i.test(text)?"work_glove":"glove",anchor:"glove"};
  if (/\bwashers?\b/i.test(text)) return {family:"washer",anchor:"washer"};
  if (/\bnuts?\b/i.test(text)) return {family:"hex_nut",anchor:"nut"};
  if (/\bhose\b/i.test(text)) return {family:"hose",anchor:"hose"};
  if (/\btape\b/i.test(text)) return {family:"tape",anchor:"tape"};
  return null;
}
function missingCritical(line:ExtractedLine,hint:ReturnType<typeof familyHint>):Reason[] {
  if(!hint)return [];
  const raw=`${line.description} ${line.rawText}`, missing:Reason[]=[];
  if(hint.family==="hex_bolt") {
    if(line.attributes.length_mm===undefined && !/\bM\d+\s*[x×]\s*\d/i.test(raw)) missing.push(reason("MISSING_LENGTH","Specify the bolt length",line.id));
    if(!/\b(?:A[24]|zinc|8\.8|10\.9)\b/i.test(raw)) missing.push(reason("MISSING_MATERIAL","Specify the material and grade; generic stainless is ambiguous",line.id));
  }
  if(hint.family==="bearing"&&!/\b(?:2RS|ZZ|C3)\b/i.test(raw)) missing.push(reason("MISSING_BEARING_SUFFIX","Specify bearing seals/shields and clearance suffix",line.id));
  if(hint.family==="o_ring"&&!/\b(?:NBR|FKM|EPDM|silicone)\b/i.test(raw)) missing.push(reason("MISSING_SEAL_MATERIAL","Specify the seal material",line.id));
  if(hint.family==="fitting"&&!/\b(?:BSP|NPT|JIC)\b/i.test(raw)) missing.push(reason("MISSING_THREAD_STANDARD","Specify the fitting thread standard",line.id));
  if(["pack","box"].includes(line.unit??"")&&line.attributes.units_per_pack===undefined&&!/(?:packs?|box(?:es)?)\s+(?:of\s+)?\d+/i.test(raw)) missing.push(reason("AMBIGUOUS_PACK_SIZE","Specify the number of pieces per ordered package",line.id));
  return missing;
}

function conflicts(line: ExtractedLine, product: Product): string[] {
  const incompatible: string[] = [];
  if (line.attributes.units_per_pack !== undefined && comparable(line.attributes.units_per_pack) !== comparable(product.unitsPerPack)) incompatible.push("units_per_pack");
  for (const [attribute,value] of Object.entries(line.attributes)) {
    if (product.attributes[attribute] !== undefined && comparable(product.attributes[attribute]) !== comparable(value)) incompatible.push(attribute);
  }
  // Explicit engineering identifiers are hard constraints even in otherwise exact-SKU text.
  const description = `${line.description} ${line.rawText}`.toUpperCase();
  const catalogue = `${product.sku} ${product.description}`.toUpperCase();
  for (const token of description.match(/\b(?:A[24]|2RS|ZZ|EPDM|NBR|FKM|BSP|NPT|C3)\b/g) ?? []) {
    if (!new RegExp(`\\b${token}\\b`).test(catalogue)) incompatible.push(token);
  }
  const metric = description.match(/\bM(\d+(?:\.\d+)?)\s*[X×]\s*(\d+(?:\.\d+)?)/);
  if (metric && product.attributes.diameter_mm !== undefined && (new Decimal(metric[1]).eq(String(product.attributes.diameter_mm)) === false || (product.attributes.length_mm !== undefined && !new Decimal(metric[2]).eq(String(product.attributes.length_mm))))) incompatible.push("metric_dimensions");
  return [...new Set(incompatible)];
}
function candidate(product: Product, method: CandidateMatch["method"], context: ValidationContext, line: ExtractedLine): CandidateMatch {
  return {productId:product.id,sku:product.sku,description:product.description,sellingUnit:product.sellingUnit,unitsPerPack:product.unitsPerPack,method,
    score:method === "lexical" ? null : 1,catalogueVersion:product.catalogueVersion,customerId:method === "customer_alias" ? context.customer!.id : null,attributeConflicts:conflicts(line,product),evidenceIds:line.evidenceIds};
}
const acknowledgeable = new Set<ReasonCode>(["PRICE_MISMATCH","EXPIRED_PRICE_AGREEMENT","TOTAL_MISMATCH","INSUFFICIENT_STOCK","STALE_STOCK","DELIVERY_COMMITMENT_REQUIRED","AMBIGUOUS_DELIVERY_DATE","HISTORY_REQUIRES_CONFIRMATION","UNTRUSTED_INSTRUCTION","CONFLICTING_DOCUMENT_VERSIONS"]);
export function applyResolutions(reasons: Reason[], resolutions: ValidationContext["resolutions"]): Reason[] {
  return reasons.map(r => {
    const resolution = resolutions?.find(v => v.code === r.code && v.lineId === r.lineId);
    return resolution && acknowledgeable.has(r.code) ? {...r,resolved:true,resolution:resolution.resolution} : r;
  });
}
export function hasUnresolved(reasons: Reason[]): boolean { return reasons.some(r => !acknowledgeable.has(r.code) || !r.resolved); }
export function canApprove(draft: ValidatedDraft): void {
  if (!["draft_ready","needs_review"].includes(draft.status) || draft.intent !== "new_order") throw new ServiceError("VALIDATION_FAILED","Only a reviewed new order can be approved");
  if (!draft.customerId || !draft.poNumber || !draft.shippingAddressId || !draft.lines.length) throw new ServiceError("VALIDATION_FAILED","Customer, PO, address and lines are required");
  if (hasUnresolved(draft.reasons) || draft.lines.some(l => hasUnresolved(l.reasons))) throw new ServiceError("VALIDATION_FAILED","Resolve every order and line exception before approval");
  for (const line of draft.lines) {
    if (!line.productId || !line.selectedSku || !line.quantity || !new Decimal(line.quantity).gt(0) || !line.normalizedQuantity || !line.unit || !line.unitPrice || !line.lineTotal) throw new ServiceError("VALIDATION_FAILED","Every line must have a verified product, quantity, unit and price");
  }
}
export async function validate(extracted: ExtractedOrder, context: ValidationContext): Promise<{lines:DraftLine[];reasons:Reason[];total:string;shippingAddressId:string|null;status:ValidatedDraft["status"]}> {
  // Provider/parser reasons are evidence, never reviewer authorization.
  const reasons:Reason[] = extracted.reasons.map(r=>({...r,severity:"blocking" as const,resolved:false,resolution:null}));
  const customer = context.customer;
  if (!customer) reasons.push(reason("UNVERIFIED_SENDER","Select a verified customer before account-specific matching"));
  if (customer?.onHold) reasons.push(reason("ACCOUNT_ON_HOLD","Customer account is on credit hold"));
  if (!extracted.poNumber) reasons.push(reason("MISSING_PO_REFERENCE","A purchase-order reference is required"));
  if (extracted.currency && extracted.currency.toUpperCase() !== "GBP") reasons.push(reason("CURRENCY_MISMATCH",`Only GBP orders are supported; source says ${extracted.currency}`));
  let addressId = context.shippingAddressId ?? null;
  if (addressId && !context.addresses.some(a => a.id === addressId && a.customerId === customer?.id && a.approved)) { addressId = null; reasons.push(reason("NEW_SHIPPING_ADDRESS","Selected address is not approved for this customer")); }
  if (!addressId && extracted.requestedAddress && customer) {
    const raw = comparable(extracted.requestedAddress);
    const addressMatches = context.addresses.filter(a => a.customerId === customer.id && a.approved && (raw === comparable(a.label) || raw === comparable(a.formatted) || new RegExp(`\\b${comparable(a.label)}\\b`).test(raw)));
    if (addressMatches.length === 1) addressId = addressMatches[0].id;
    else if (!addressMatches.length) reasons.push(reason("NEW_SHIPPING_ADDRESS","Source delivery address does not identify an approved address"));
  }
  if (!addressId) reasons.push(reason("SHIPPING_ADDRESS_AMBIGUOUS","Explicitly select an approved delivery address"));
  if (!extracted.lines.length) reasons.push(reason("NO_ORDER_LINES","No order lines were extracted"));
  if(!extracted.lines.length && extracted.reasons.some(r=>r.code==="AMBIGUOUS_ORDER_HISTORY")) reasons.push(reason("MISSING_QUANTITY","A repeat request needs explicit quantities or a confirmed historical order"));
  if (extracted.intent === "quote_request") reasons.push(reason("QUOTE_REQUEST","Quotation request requires separate handling"));
  if (extracted.intent === "amendment") reasons.push(reason("ORDER_AMENDMENT","Amendment must be linked to its existing order"));
  if (extracted.intent === "cancellation") reasons.push(reason("CANCELLATION_REQUEST","Cancellation request must be reviewed against the existing order"));
  const lines: DraftLine[] = [];
  for (const source of extracted.lines) {
    const warnings: Reason[] = [];
    let matches: Product[] = []; let method: CandidateMatch["method"] = "lexical";
    const hint=familyHint(source);
    const manual = context.selectedProducts?.get(source.id);
    if (manual) { matches=[manual]; method="manual"; }
    else if (source.sku) { matches = await context.repository.exactSku(source.sku); method="exact_sku"; }
    if (!matches.length && source.manufacturerReference) { matches=await context.repository.manufacturer(source.manufacturerReference); method="manufacturer_reference"; }
    if (!matches.length && customer && (source.customerAlias || source.sku)) { matches=await context.repository.aliases(customer.id,source.customerAlias ?? source.sku!); method="customer_alias"; }
    if (!matches.length && !source.sku && !source.manufacturerReference && !source.customerAlias && source.description.trim()) {
      matches = (await context.repository.search(source.description,20,hint?.family,source.attributes)).slice(0,20);
      // Search remains bounded; a second query may broaden words but never relax explicit attributes.
      if (!matches.length) matches = (await context.repository.search(hint?.anchor ?? source.description.split(/\s+/).filter(x=>x.length>3).slice(0,6).join(" "),20,hint?.family,source.attributes)).slice(0,20);
      method="lexical";
    }
    const candidates = matches.slice(0,20).map(p => candidate(p,method,context,source));
    const compatible = matches.filter(p => !conflicts(source,p).length);
    let selected: Product | null = matches.length === 1 ? matches[0] : compatible.length === 1 ? compatible[0] : null;
    if(method==="lexical") {
      if(matches.length>=20) {warnings.push(reason("SEARCH_BUDGET_EXHAUSTED","Candidate search reached its limit; review the variant instead of assuming uniqueness",source.id));selected=null;}
      warnings.push(...missingCritical(source,hint));
      // Descriptive matching requires explicit critical fields; typo normalization cannot invent variants.
      if(warnings.length) selected=null;
      else if(selected && !hint) {
        const words=comparable(source.description).split(" ").filter(w=>w.length>1);
        if(!words.length||!words.every(w=>comparable(selected!.description).split(" ").includes(w))) selected=null;
      }
    }
    if (!selected) warnings.push(reason(matches.length ? "AMBIGUOUS_MATCH" : "NO_CATALOGUE_MATCH", matches.length ? "Choose a product after checking the explicit variant attributes" : "No compatible catalogue product found",source.id));
    if (selected && conflicts(source,selected).length) {warnings.push(reason("IDENTIFIER_ATTRIBUTE_CONFLICT","The product identifier conflicts with explicit source attributes",source.id));selected=null;}
    if (selected && !selected.active) warnings.push(reason("DISCONTINUED_PRODUCT","Product is discontinued; no substitution has been made",source.id));
    let normalizedQuantity: string | null = null, unitPrice: string | null = null, lineTotal: string | null = null, agreementVersion: string | null = null;
    if (source.quantity === null) warnings.push(reason("MISSING_QUANTITY","Quantity was not specified",source.id));
    else if (!new Decimal(source.quantity).gt(0)) warnings.push(reason("INVALID_QUANTITY","Quantity must be greater than zero",source.id));
    if (!source.unit) warnings.push(reason("MISSING_UNIT","Specify the ordered selling unit",source.id));
    if (selected && source.quantity !== null && new Decimal(source.quantity).gt(0)) {
      if (!selected.allowsFractionalQuantity && !new Decimal(source.quantity).isInteger()) warnings.push(reason("INVALID_SELLING_QUANTITY","This product requires a whole selling quantity",source.id));
      if (source.unit && source.unit !== selected.sellingUnit) warnings.push(reason("AMBIGUOUS_PACK_SIZE",`Source unit ${source.unit} differs from selling unit ${selected.sellingUnit}; explicitly correct before approval`,source.id));
      else if (source.unit) normalizedQuantity = quantity(new Decimal(source.quantity).mul(selected.unitsPerPack));
      const agreements = customer ? await context.repository.prices(customer.id,selected.id) : [];
      const day = context.at.slice(0,10);
      const valid = agreements.filter(a => a.validFrom <= day && (!a.validTo || a.validTo >= day) && new Decimal(source.quantity!).gte(a.minimumQuantity)).sort((a,b)=>new Decimal(b.minimumQuantity).cmp(a.minimumQuantity));
      if (agreements.length && !valid.length && source.quotedUnitPrice!==null) warnings.push(reason("EXPIRED_PRICE_AGREEMENT","No agreement applies at this date and quantity (expired, not yet valid or below tier minimum); list price is shown for explicit review",source.id));
      unitPrice = valid[0]?.unitPrice ?? selected.listPrice; agreementVersion = valid[0]?.version ?? `list:${selected.catalogueVersion}`;
      lineTotal = money(new Decimal(source.quantity).mul(unitPrice));
      if (source.quotedUnitPrice !== null && new Decimal(source.quotedUnitPrice).sub(unitPrice).abs().gt("0.01")) warnings.push(reason("PRICE_MISMATCH",`Source price £${source.quotedUnitPrice}; current master price £${unitPrice}`,source.id));
      const stock = await context.repository.stock(selected.id);
      if (stock) {
        if (new Date(context.at).getTime()-new Date(stock.observedAt).getTime()>86400000) warnings.push(reason("STALE_STOCK","Stock information is more than 24 hours old",source.id));
        else if (new Decimal(stock.availableQuantity).lt(source.quantity)) warnings.push(reason("INSUFFICIENT_STOCK","Current selling quantity exceeds observed available stock",source.id));
      }
    }
    lines.push({...source,productId:selected?.id ?? null,selectedSku:selected?.sku ?? null,matchMethod:selected ? method : null,candidates,
      normalizedQuantity,normalizedUnit:selected?.physicalUnit ?? null,unitPrice,lineTotal,priceAgreementVersion:agreementVersion,reasons:applyResolutions(warnings,context.resolutions)});
  }
  const total = money(lines.reduce((sum,line)=>sum.add(line.lineTotal ?? "0"),new Decimal(0)));
  if (extracted.quotedTotal && new Decimal(extracted.quotedTotal).sub(total).abs().gt("0.01")) reasons.push(reason("TOTAL_MISMATCH",`Source total £${extracted.quotedTotal}; calculated net total £${total}`));
  const resolved = applyResolutions(reasons,context.resolutions);
  const status: ValidatedDraft["status"] = extracted.intent === "cancellation" ? "cancellation_review" : extracted.intent === "amendment" ? "amendment_review" : ["non_order","enquiry","quote_request"].includes(extracted.intent) ? "not_order" : hasUnresolved(resolved) || lines.some(l=>hasUnresolved(l.reasons)) || extracted.intent !== "new_order" ? "needs_review" : "draft_ready";
  return {lines,reasons:resolved,total,shippingAddressId:addressId,status};
}
