import { z } from "zod";

/** JSON-safe decimal strings. Compute with integer/rational arithmetic, never Number prices. */
export const DecimalSchema = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/);
export const SignedDecimalSchema = z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d{1,6})?$/);
export const PositiveDecimalSchema = DecimalSchema.refine((value) => /[1-9]/.test(value), "Must be positive");
export const MoneySchema = z.string().regex(/^(?:0|[1-9]\d*)\.\d{2}$/);
export const IdSchema = z.string().min(1).max(200);
export const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const TimestampSchema = z.string().datetime({ offset: true });
export const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "Invalid calendar date");
export const CurrencySchema = z.literal("GBP");
export const UnitSchema = z.enum(["each", "pack", "box", "pair", "roll", "metre", "litre", "kg"]);
export const AttributesSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));
export type Decimal = z.infer<typeof DecimalSchema>;
export type Money = z.infer<typeof MoneySchema>;
export type Unit = z.infer<typeof UnitSchema>;

export const ReasonCodeSchema = z.enum([
  "ACCOUNT_ON_HOLD", "ALREADY_EXPORTED", "AMBIGUOUS_DELIVERY_DATE", "AMBIGUOUS_ORDER_HISTORY",
  "AMBIGUOUS_PACK_SIZE", "CANCELLATION_REQUEST", "CONFLICTING_DOCUMENT_VERSIONS", "CURRENCY_MISMATCH",
  "DELIVERY_COMMITMENT_REQUIRED", "DISCONTINUED_PRODUCT", "DUPLICATE_MESSAGE", "DUPLICATE_CONTENT", "DUPLICATE_PO",
  "EXPIRED_PRICE_AGREEMENT", "HISTORY_REQUIRES_CONFIRMATION", "IDENTIFIER_ATTRIBUTE_CONFLICT",
  "INSUFFICIENT_STOCK", "INVALID_QUANTITY", "INVALID_SELLING_QUANTITY", "MISSING_ATTACHMENT",
  "MISSING_BEARING_SUFFIX", "MISSING_LENGTH", "MISSING_MATERIAL", "MISSING_PO_REFERENCE", "MISSING_QUANTITY",
  "MISSING_SEAL_MATERIAL", "MISSING_THREAD_STANDARD", "MIXED_ORDER_AND_RETURN", "NEW_SHIPPING_ADDRESS",
  "INCOMPLETE_EXTRACTION", "NO_CATALOGUE_MATCH", "NO_ORDER_LINES", "ORDER_AMENDMENT", "PRICE_MISMATCH", "QUOTE_REQUEST",
  "SHIPPING_ADDRESS_AMBIGUOUS", "STALE_STOCK", "TOTAL_MISMATCH", "UNTRUSTED_INSTRUCTION", "UNVERIFIED_SENDER",
  "UNSUPPORTED_FORMAT", "FILE_TOO_LARGE", "DOCUMENT_TOO_LONG", "EMPTY_DOCUMENT", "INVALID_STRUCTURED_INPUT",
  "PARSING_FAILED", "MODEL_UNAVAILABLE", "MODEL_OUTPUT_INVALID", "MODEL_TIMEOUT", "BUDGET_EXCEEDED",
  "MISSING_CUSTOMER", "MISSING_UNIT", "AMBIGUOUS_MATCH", "SEARCH_BUDGET_EXHAUSTED", "STALE_CATALOGUE",
  "STALE_VERSION", "APPROVAL_REQUIRED", "APPROVAL_INVALIDATED", "FORBIDDEN", "NOT_FOUND", "VALIDATION_FAILED",
]);
export type ReasonCode = z.infer<typeof ReasonCodeSchema>;
export const ReasonSchema = z.object({
  code: ReasonCodeSchema,
  message: z.string().min(1).max(2000),
  severity: z.enum(["info", "warning", "blocking"]),
  lineId: IdSchema.nullable(),
  evidenceIds: z.array(IdSchema),
  resolved: z.boolean().default(false),
  resolution: z.string().max(2000).nullable().default(null),
}).strict();
export type Reason = z.infer<typeof ReasonSchema>;

/** Paths/storage keys remain server-only; clients fetch protected document IDs. */
export const DocumentSchema = z.object({
  id: IdSchema, messageId: IdSchema, filename: z.string().max(250), mediaType: z.string().max(120),
  sizeBytes: z.number().int().nonnegative(), contentHash: HashSchema,
  kind: z.enum(["email", "body", "attachment", "upload"]),
  parser: z.enum(["mime", "text", "html", "pdf", "csv", "unsupported"]).nullable(),
  pageCount: z.number().int().nonnegative().nullable(), text: z.string().max(2_000_000).nullable(),
  createdAt: TimestampSchema,
}).strict();
export type Document = z.infer<typeof DocumentSchema>;
export const DocumentEvidenceSchema = z.object({
  id: IdSchema, documentId: IdSchema,
  page: z.number().int().positive().nullable(),
  startOffset: z.number().int().nonnegative().nullable(), endOffset: z.number().int().nonnegative().nullable(),
  quote: z.string().max(4000), field: z.string().max(200).nullable(), lineId: IdSchema.nullable(),
}).strict().refine((value) => value.startOffset === null || value.endOffset === null || value.endOffset >= value.startOffset,
  "Evidence end must follow start");
export type DocumentEvidence = z.infer<typeof DocumentEvidenceSchema>;
export const SourceMessageSchema = z.object({
  id: IdSchema, channel: z.enum(["manual", "upload", "synthetic_email", "mailpit", "api", "email"]),
  externalMessageId: z.string().max(500).nullable(), transportKey: IdSchema, contentHash: HashSchema,
  receivedAt: TimestampSchema, sender: z.string().max(320).nullable(), subject: z.string().max(1000),
  trustedCustomerId: IdSchema.nullable(), identitySource: z.enum(["local_reviewer", "synthetic_harness", "trusted_connector", "unverified"]),
  documentIds: z.array(IdSchema), duplicateOfMessageId: IdSchema.nullable(),
}).strict();
export type SourceMessage = z.infer<typeof SourceMessageSchema>;
export const IntentSchema = z.enum(["new_order", "quote_request", "amendment", "cancellation", "enquiry", "non_order", "unclear", "unknown"]);
export const OrderStatusSchema = z.enum(["received", "parsing", "extracted", "validating", "draft_ready", "needs_review", "approved", "exported", "quarantined", "duplicate", "cancelled", "failed", "not_order", "amendment_review", "cancellation_review"]);
export type Intent = z.infer<typeof IntentSchema>;
export type OrderStatus = z.infer<typeof OrderStatusSchema>;
export const ExtractedLineSchema = z.object({
  id: IdSchema, position: z.number().int().positive(), rawText: z.string().max(8000),
  sku: z.string().max(200).nullable(), manufacturerReference: z.string().max(200).nullable(),
  customerAlias: z.string().max(200).nullable(), description: z.string().max(4000),
  quantity: SignedDecimalSchema.nullable(), unit: UnitSchema.nullable(), originalUnit: z.string().max(100).nullable(),
  quotedUnitPrice: MoneySchema.nullable(), attributes: AttributesSchema, evidenceIds: z.array(IdSchema),
}).strict();
export type ExtractedLine = z.infer<typeof ExtractedLineSchema>;
export const ExtractedOrderSchema = z.object({
  schemaVersion: z.literal(1), intent: IntentSchema, poNumber: z.string().max(200).nullable(),
  relatedPoNumber: z.string().max(200).nullable(), revision: z.string().max(100).nullable(),
  requestedDeliveryDate: DateSchema.nullable(), requestedAddress: z.string().max(4000).nullable(),
  currency: z.string().max(10).nullable(), quotedTotal: MoneySchema.nullable(),
  lines: z.array(ExtractedLineSchema).max(100), evidence: z.array(DocumentEvidenceSchema), reasons: z.array(ReasonSchema),
}).strict();
export type ExtractedOrder = z.infer<typeof ExtractedOrderSchema>;

export const CustomerSchema = z.object({
  id: IdSchema, externalId: IdSchema, name: z.string(), onHold: z.boolean(),
  approvedSenders: z.array(z.string()), catalogueVersion: IdSchema,
}).strict();
export type Customer = z.infer<typeof CustomerSchema>;
export const AddressSchema = z.object({ id: IdSchema, customerId: IdSchema, externalId: IdSchema, label: z.string(), formatted: z.string(), approved: z.boolean() }).strict();
export type Address = z.infer<typeof AddressSchema>;
export const ProductSchema = z.object({
  id: IdSchema, externalId: IdSchema, sku: z.string(), manufacturerReference: z.string().nullable(), description: z.string(),
  category: z.string(), family: z.string(), attributes: AttributesSchema, active: z.boolean(),
  sellingUnit: UnitSchema, unitsPerPack: PositiveDecimalSchema, physicalUnit: UnitSchema,
  allowsFractionalQuantity: z.boolean(), listPrice: MoneySchema, currency: CurrencySchema, catalogueVersion: IdSchema,
}).strict();
export type Product = z.infer<typeof ProductSchema>;
export const PriceAgreementSchema = z.object({
  id: IdSchema, customerId: IdSchema, productId: IdSchema, version: IdSchema,
  validFrom: DateSchema, validTo: DateSchema.nullable(), minimumQuantity: DecimalSchema,
  unitPrice: MoneySchema, currency: CurrencySchema,
}).strict();
export type PriceAgreement = z.infer<typeof PriceAgreementSchema>;
export const CustomerAliasSchema = z.object({ id: IdSchema, customerId: IdSchema, alias: z.string(), productId: IdSchema }).strict();
export type CustomerAlias = z.infer<typeof CustomerAliasSchema>;
export const StockSnapshotSchema = z.object({ productId: IdSchema, availableQuantity: DecimalSchema, observedAt: TimestampSchema }).strict();
export type StockSnapshot = z.infer<typeof StockSnapshotSchema>;
export const CandidateMatchSchema = z.object({
  productId: IdSchema, sku: z.string(), description: z.string(), sellingUnit: UnitSchema, unitsPerPack: PositiveDecimalSchema,
  method: z.enum(["exact_sku", "manufacturer_reference", "customer_alias", "lexical", "manual"]),
  score: z.number().min(0).max(1).nullable(), catalogueVersion: IdSchema, customerId: IdSchema.nullable(),
  attributeConflicts: z.array(z.string()), evidenceIds: z.array(IdSchema),
}).strict();
export type CandidateMatch = z.infer<typeof CandidateMatchSchema>;
export const DraftLineSchema = ExtractedLineSchema.extend({
  productId: IdSchema.nullable(), selectedSku: z.string().nullable(), matchMethod: CandidateMatchSchema.shape.method.nullable(),
  candidates: z.array(CandidateMatchSchema).max(20),
  normalizedQuantity: PositiveDecimalSchema.nullable(), normalizedUnit: UnitSchema.nullable(),
  unitPrice: MoneySchema.nullable(), lineTotal: MoneySchema.nullable(), priceAgreementVersion: IdSchema.nullable(),
  reasons: z.array(ReasonSchema),
}).strict();
export type DraftLine = z.infer<typeof DraftLineSchema>;
export const ApprovalSchema = z.object({
  id: IdSchema, orderId: IdSchema, version: z.number().int().positive(), contentHash: HashSchema,
  approvedBy: IdSchema, approvedAt: TimestampSchema, invalidatedAt: TimestampSchema.nullable(),
}).strict();
export type Approval = z.infer<typeof ApprovalSchema>;
export const ValidatedDraftSchema = z.object({
  id: IdSchema, version: z.number().int().positive(), contentHash: HashSchema,
  sourceMessageId: IdSchema, customerId: IdSchema.nullable(), customerName: z.string().nullable(),
  intent: IntentSchema, status: OrderStatusSchema, poNumber: z.string().max(200).nullable(),
  relatedOrderId: IdSchema.nullable(), revision: z.string().nullable(), requestedDeliveryDate: DateSchema.nullable(),
  shippingAddressId: IdSchema.nullable(), currency: CurrencySchema, catalogueVersion: IdSchema,
  lines: z.array(DraftLineSchema).max(100), reasons: z.array(ReasonSchema), total: MoneySchema,
  approval: ApprovalSchema.nullable(), createdAt: TimestampSchema, updatedAt: TimestampSchema,
  processingMode: z.enum(["manual", "structured", "mock", "live"]),
}).strict();
export type ValidatedDraft = z.infer<typeof ValidatedDraftSchema>;
export const ExportLineSchema = z.object({
  lineId: IdSchema, productExternalId: IdSchema, sku: z.string(), description: z.string(),
  quantity: PositiveDecimalSchema, unit: UnitSchema, unitPrice: MoneySchema,
}).strict();
export const ExportSnapshotSchema = z.object({
  id: IdSchema, orderId: IdSchema, orderVersion: z.number().int().positive(), approvalId: IdSchema,
  contentHash: HashSchema, idempotencyKey: IdSchema, externalId: IdSchema,
  customerExternalId: IdSchema, shippingAddressExternalId: IdSchema, poNumber: z.string(), currency: CurrencySchema,
  lines: z.array(ExportLineSchema).min(1), total: MoneySchema,
  mappingVersion: IdSchema, artifactHash: HashSchema, filename: z.string(),
  state: z.enum(["prepared", "downloaded", "import_verified"]), preparedBy: IdSchema, preparedAt: TimestampSchema,
  downloadedAt: TimestampSchema.nullable(), verifiedAt: TimestampSchema.nullable(),
  verifiedBy: IdSchema.nullable(), quotationReference: z.string().nullable(),
}).strict();
export type ExportSnapshot = z.infer<typeof ExportSnapshotSchema>;

export const RoleSchema = z.enum(["viewer", "reviewer", "admin", "ingestion"]);
export const SessionSchema = z.object({ userId: IdSchema, email: z.string().email(), name: z.string(), role: RoleSchema, expiresAt: TimestampSchema }).strict();
export type Session = z.infer<typeof SessionSchema>;
export const AuditEventSchema = z.object({
  id: IdSchema, orderId: IdSchema.nullable(), actorId: IdSchema, action: z.string(),
  version: z.number().int().positive().nullable(), at: TimestampSchema,
  detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
}).strict();
export type AuditEvent = z.infer<typeof AuditEventSchema>;
export const JobSchema = z.object({
  id: IdSchema, type: z.enum(["process_message", "revalidate_order", "catalogue_sync"]),
  messageId: IdSchema.nullable(), orderId: IdSchema.nullable(),
  status: z.enum(["queued", "running", "retry_wait", "succeeded", "dead_letter"]),
  attempts: z.number().int().nonnegative(), maxAttempts: z.number().int().positive(),
  availableAt: TimestampSchema, leaseOwner: IdSchema.nullable(), leaseExpiresAt: TimestampSchema.nullable(),
  errorCode: ReasonCodeSchema.nullable(), errorMessage: z.string().max(2000).nullable(),
  createdAt: TimestampSchema, updatedAt: TimestampSchema,
}).strict();
export type Job = z.infer<typeof JobSchema>;
export const ModelUsageSchema = z.object({
  id: IdSchema, orderId: IdSchema.nullable(), runId: IdSchema, mode: z.enum(["mock", "live"]),
  provider: z.string(), model: z.string(), modelVersion: z.string().nullable(), effort: z.string().nullable(),
  operation: z.enum(["extraction", "matching"]), promptHash: HashSchema, catalogueVersion: IdSchema,
  inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(), cacheWriteTokens: z.number().int().nonnegative(),
  latencyMs: z.number().int().nonnegative(), costUsd: DecimalSchema.nullable(), reservedUsd: DecimalSchema,
  pricingVersion: IdSchema, requestCount: z.number().int().positive(), retries: z.number().int().nonnegative(),
  retrievedCandidateCount: z.number().int().nonnegative(), status: z.enum(["succeeded", "failed", "unknown"]), createdAt: TimestampSchema,
}).strict();
export type ModelUsage = z.infer<typeof ModelUsageSchema>;
export const HistoricalSuggestionSchema = z.object({
  historyId:IdSchema, customerId:IdSchema, poNumber:z.string(), orderedAt:DateSchema,
  source:z.literal("synthetic_history"),
  lines:z.array(z.object({sku:z.string(),quantity:PositiveDecimalSchema,unit:UnitSchema}).strict()),
}).strict();
export type HistoricalSuggestion = z.infer<typeof HistoricalSuggestionSchema>;
export const OrderDetailSchema = z.object({
  order: ValidatedDraftSchema, source: SourceMessageSchema, documents: z.array(DocumentSchema),
  evidence: z.array(DocumentEvidenceSchema), audit: z.array(AuditEventSchema), exports: z.array(ExportSnapshotSchema),
  jobs: z.array(JobSchema), modelUsage: z.array(ModelUsageSchema),
  historySuggestions:z.array(HistoricalSuggestionSchema).max(5).optional(),
}).strict();
export type OrderDetail = z.infer<typeof OrderDetailSchema>;

// Every mutation is validated server-side; the request cannot supply approval/audit fields.
export const LoginRequestSchema = z.object({ email: z.string().email(), password: z.string().min(1).max(256) }).strict();
export const IntakeRequestSchema = z.object({
  filename: z.string().min(1).max(250), mediaType: z.string().min(1).max(120), contentBase64: z.string().min(1).max(15_000_000),
  channel: SourceMessageSchema.shape.channel, externalMessageId: z.string().max(500).nullable().optional(),
  trustedCustomerId: IdSchema.nullable().optional(),
}).strict();
export type IntakeRequest = z.infer<typeof IntakeRequestSchema>;
export const IntakeResponseSchema = z.object({ messageId: IdSchema, orderId: IdSchema.nullable(), jobId: IdSchema.nullable(), duplicate: z.boolean() }).strict();
export const EditableLineSchema = z.object({
  id: IdSchema, productId: IdSchema.nullable(), quantity: PositiveDecimalSchema.nullable(), unit: UnitSchema.nullable(),
  quotedUnitPrice: MoneySchema.nullable(), description: z.string().max(4000),
});
export const EditOrderRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
  patch: z.object({ customerId: IdSchema.nullable().optional(), poNumber: z.string().max(200).nullable().optional(),
    shippingAddressId: IdSchema.nullable().optional(), requestedDeliveryDate: DateSchema.nullable().optional(),
    lines: z.array(EditableLineSchema.strict()).max(100).optional(),
    reasonResolutions: z.array(z.object({ code: ReasonCodeSchema, lineId: IdSchema.nullable(), resolution: z.string().min(1).max(2000) }).strict()).optional(),
  }).strict(),
}).strict();
export type EditOrderRequest = z.infer<typeof EditOrderRequestSchema>;
export const ApproveRequestSchema = z.object({ expectedVersion: z.number().int().positive(), contentHash: HashSchema }).strict();
export const ExportRequestSchema = z.object({ expectedVersion: z.number().int().positive(), idempotencyKey: IdSchema }).strict();
export const CancelRequestSchema = z.object({ expectedVersion: z.number().int().positive(), reason: z.string().min(1).max(2000) }).strict();
export const AmendmentRequestSchema = z.object({ expectedVersion: z.number().int().positive(), sourceMessageId: IdSchema }).strict();
export const VerifyExportRequestSchema = z.object({ quotationReference: z.string().min(1).max(200) }).strict();
export const ApiErrorSchema = z.object({ error: z.object({ code: ReasonCodeSchema, message: z.string(), issues: z.array(z.object({ path: z.string(), message: z.string() })).optional() }) });
export type ApiError = z.infer<typeof ApiErrorSchema>;
export const OrderListQuerySchema = z.object({ status: OrderStatusSchema.optional(), limit: z.coerce.number().int().min(1).max(100).default(50), cursor: IdSchema.optional() });
export const OrderListResponseSchema = z.object({ orders: z.array(ValidatedDraftSchema), nextCursor: IdSchema.nullable() }).strict();

/** Bounded provider contract: extraction never receives a customer catalogue or history. */
export interface ExtractionInput { text: string; documents: Document[]; evidence: DocumentEvidence[]; }
export interface ExtractionProvider {
  readonly mode: "mock" | "live";
  extract(input: ExtractionInput): Promise<{ extracted: ExtractedOrder; usage: ModelUsage | null }>;
}
export interface CatalogueRepository {
  getProduct(id: string): Promise<Product | null>;
  search(input: { query: string; customerId: string | null; catalogueVersion: string; limit: number }): Promise<Product[]>;
}

export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type IntakeResponse = z.infer<typeof IntakeResponseSchema>;
export type ApproveRequest = z.infer<typeof ApproveRequestSchema>;
export type ExportRequest = z.infer<typeof ExportRequestSchema>;
export type CancelRequest = z.infer<typeof CancelRequestSchema>;
export type AmendmentRequest = z.infer<typeof AmendmentRequestSchema>;
export type VerifyExportRequest = z.infer<typeof VerifyExportRequestSchema>;
export type OrderListQuery = z.infer<typeof OrderListQuerySchema>;
export type OrderListResponse = z.infer<typeof OrderListResponseSchema>;
