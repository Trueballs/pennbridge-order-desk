# Pennbridge Order Desk — canonical pre-build specification

Version 0.2 · 2026-10-28 · Owner: Oscar · All companies, contacts and commercial numbers are fictional.

Execution authority: [BUILD-PLAN.md](BUILD-PLAN.md) defines the current build order and scope, agent/model assignments, Odoo quotation import target and post-build evaluation. It supersedes older milestone ordering and deferred-format assumptions below. Implementation is awaiting Oscar's “go.”

## Research correction — 2026-10-28

This correction takes precedence over the original roadmap below. [Supplier and alternatives research](<../reports/Email order automation viability.md>) confirms that websites and emailed POs coexist, but does not validate demand for our implementation. **Proceed as a narrower portfolio prototype; commercial demand remains unproven.** Pennbridge's volumes, staff numbers and handling-time baseline remain fictional assumptions.

The primary workflow is **exact-SKU PDF/email order transfer into a checked sales-order draft**, reducing rekeying between business systems. Customers can already know the precise products. Fuzzy description matching is exception handling, not a prerequisite for every order.

Bring genuine machine-generated PDF fixtures and extraction into the first end-to-end prototype, before sophisticated catalogue matching. Treat scans/OCR as a later supported-format tier. Supported structured XML/CSV/API inputs should bypass AI extraction. Before claiming end-to-end business value, select and verify one concrete destination sales-order import contract in a test system; a generic CSV download is only an intermediate demonstration. Source catalogue, units and pricing from that destination/master system rather than independently maintaining duplicate business data.

The current **50 cases are an exception-heavy acceptance suite**, not a representative workload or evidence of a real exception rate or ROI. Use a separate representative sample to measure full handling time, including review and failed imports. Keep 10,000 SKUs as an engineering scale test. Compare native imports, portals/EDI and established products before proposing a commercial custom build. Paid-pilot discovery requires a named process owner, permissioned examples, demonstrated recurring manual work and a feasible integration.

## Purpose and scope

Build a portfolio-quality application that converts emailed purchase orders into validated, human-approved sales-order drafts. First prove a narrow, reproducible workflow, then evaluate a customer pilot. No promise of production readiness, customer adoption or accuracy has been made.

Pennbridge Industrial Supplies is a UK wholesaler with 18 staff, three order administrators, 250 customer accounts and 1,200 monthly emailed orders. Its catalogue has 10,000 SKUs (8,000 active; 2,000 discontinued), roughly 200 product families, and categories covering fasteners, bearings, seals, fittings, consumables and PPE. Typical orders have 3–15 lines; stress orders have 50–100. An assumed eight minutes of manual handling per order implies 160 hours/month, but savings must be measured including review, corrections and failures.

Buyer: operations manager. Daily user: sales administrator. Customer pain: rekeying, wrong variants/units, exceptions scattered across email, and uncertain order status. Existing inventory software remains the system of record. Import format is a mock CSV contract until a real customer's system is identified.

## Company-side review

| What could go wrong | Improved requirement |
|---|---|
| Review takes longer than manual entry | Time complete tasks with realistic mixed orders, including corrections. Show source and draft side by side; highlight only exceptions. |
| Customer receives the wrong part | Preserve dimensions, material, grades, suffixes and packaging. Never silently substitute. Wrong confident matches are more costly than abstention. |
| 'Two boxes' becomes two items | Store ordered quantity/unit separately from normalized quantity and catalogue pack size. Block ambiguous conversion. |
| A drafted confirmation becomes a delivery promise | Separate requested date from confirmed date. Staff approval and current availability are prerequisites for a promise. |
| Prices or addresses are copied from stale history | Revalidate current effective agreements and approved addresses. New addresses require review. |
| Same PO is entered twice, or an amendment is ignored | Separate transport-event dedupe, content dedupe and business duplicate detection. Revisions go to an amendment workflow. |
| Partial stock or one bad line holds up everything invisibly | Explicit whole-order review state; reviewer chooses partial fulfillment. Never silently omit lines. |
| Staff can't see what's stuck | Job status, reason codes, owner and manual retry. Manual processing remains available during outages. |
| Automation duplicates existing ERP features | Before selling, observe the existing system, import format and available native automation. Measure incremental value. |
| Customer expects unlimited support | Define supported document formats, volumes, support hours, incident contacts, data retention and change scope before a paid pilot. |

Commercial success means less total work and fewer costly mistakes at an acceptable running/support cost. Validate with an operations user before making pricing or ROI claims.

## Builder-side review and architecture

Use Next.js/TypeScript for dashboard and server endpoints. Use a separate TypeScript worker for parsing/AI/background work; do not rely on a long browser request or a hosting function remaining alive. A Postgres-backed jobs table with claimed leases, retry limits and durable states is sufficient initially. Avoid Redis and an agent framework until evidence justifies them.

Use local PostgreSQL and private file storage for the Docker first slice; retain storage/database adapters for later Supabase adoption. Authentication and Supabase RLS must be explicitly implemented and tested before exposing a hosted app. The local private demo is not an authenticated production service. Claude is an interchangeable extraction/matching adapter. n8n later handles mailbox triggers and integration steps, not the authoritative matching/business rules. App/worker owns idempotency and order state even if n8n retries.

Durable states: received → parsing → extracted → validating → draft_ready or needs_review → approved → exported. Quarantined, duplicate, cancelled and failed are explicit outcomes. Approval binds to a content/version hash. Any subsequent edit invalidates approval. Export uses a unique idempotency key and immutable snapshot. Concurrent reviewers use version checks. An approved draft is not a reserved or shipped order.

Persist original message/attachments, extraction version, catalogue version, price agreement version, candidate evidence, corrections, reviewer, timestamps and export ID. Never log secrets or entire customer documents in general application logs. Keep model output untrusted until schema/business checks pass.

Sender identity is not established by an email's From header. The fixture harness supplies explicit trusted identity context for known-account cases. A real connector must use trusted provider metadata, sender-authentication checks and the customer's approved-contact process; suspicious/unknown identity stays in review. Authenticate the ingestion endpoint independently of the email content. No arbitrary document may choose a customer scope or request account history.

## Taxonomy and data contracts

Hierarchy: category → family → structured variant attributes → sellable SKU. Example: Fasteners → metric hex bolt → M8 × 30 mm, A2 stainless, thread/grade → pack of 100. Do not encode all semantics solely in the SKU or free-text description.

Family-specific required attributes:
- Fasteners: thread standard/diameter/pitch, length, material/grade, head type, finish, selling unit/pack size.
- Bearings: series, bore/outer diameter/width, seal/shield suffix, clearance and manufacturer constraints.
- Seals: inner diameter, cross-section, material and hardness where relevant.
- Fittings: thread standard, nominal size, gender, material and pressure rating where relevant.
- PPE: size, rating, material, certification and selling unit.
- Consumables: dimensions, grade, volume/length, material and selling unit.

Normalize display synonyms with explicit dictionaries; preserve originals. Decimal quantities only where the product permits them. Currency uses decimal/minor-unit arithmetic, never binary floating point. Never infer GBP solely from a currency symbol when context is contradictory. Tax calculation is outside the first slice; quoted VAT/totals may be flagged against explicit fixture rules rather than treated as legal tax advice.

Tables: customers, approved_senders, addresses, products, product_attributes, customer_product_aliases, price_agreements with validity dates/quantity tiers, stock_snapshots with timestamp, messages, attachments, jobs, orders, order_versions, order_lines, match_candidates, approvals, exports and audit_events. Distinguish account identity from sender-domain inference. Give each incoming channel its own external message ID and store hashes separately.

Large seed target (not generated yet): 10,000 SKUs, 250 customers, 500 addresses, 5,000 scoped aliases, 15,000 effective-dated price agreements and 12,000 historical orders with approximately 100,000 lines. Generate meaningful neighbouring variants, not just padded random names. Validate family-specific combinations and distribution; products from 200 families are not 200 interchangeable templates. The 50-case starter context is deliberately small and inspectable. Later embed those reference products unchanged within the scale dataset.

## Efficient retrieval: prompt plus enforced search policy

A system prompt is useful for interpretation, but it cannot guarantee cost, access restrictions or correctness. The backend owns search order, available tools, candidate limits, tenant/account filters, deadlines and total spend.

1. Parse MIME safely and normalize text once. Retain evidence references. If a supported structured import already has validated fields, bypass AI extraction.
2. Extract all order lines in one bounded structured request where size permits. Split oversized orders deterministically without losing line IDs.
3. Resolve exact SKU using an index. Validate conflicts with the stated description rather than blindly accepting the ID.
4. Resolve exact manufacturer reference and customer-scoped alias; ambiguous manufacturer matches require review. Never use another customer's aliases.
5. For unresolved descriptions, determine family and critical attributes. Use indexed category/family/attribute filters, then lexical/full-text/trigram search. A guessed family is a soft hint until supported by evidence.
6. Allow one controlled broader search if the first category guess returns no useful candidates. Do not relax explicit critical attributes. Limit retrieval to 20 internal candidates and at most 5 compact candidates passed to the model per line.
7. Batch unresolved lines into at most one matching request for a normal-sized order. Model returns candidate IDs plus evidence/uncertainties. Code rejects unknown IDs or incompatible attributes.
8. Abstain when multiple variants remain plausible, the search budget is exhausted, or critical information is missing. Human review is a valid output.

Default budget targets: maximum two retrieval rounds per unresolved line; no autonomous agent loop; normally one extraction call plus zero or one matching call per order. Large-order batches and retry calls have separate configured ceilings and are logged. A larger model fallback is opt-in per benchmark, not an unlimited automatic escalation. Use database results first; add embeddings only if measured retrieval misses justify their cost/complexity.

Cache document parsing by content hash, not whole-order decisions. Catalogue search caches include catalogue version, normalized query and account scope where applicable. Prices include agreement version/effective time; stock is separately refreshed. A re-sent order still needs business lifecycle checks. Never replay a previous approval from a cache.

Postgres supports indexed exact lookup and trigram similarity indexes. Category organization helps retrieval, but 10,000 products alone is a modest indexed-database workload; the difficult work is reliably resolving variants and units.

## Model and cost experiments

Compare the same frozen dataset under: A) exact/alias/lexical rules baseline, B) baseline plus structured extraction, C) B plus bounded AI candidate matching. Optionally compare two model sizes after B works. Hold rules/catalogue constant, report ambiguous cases separately, and review disagreements manually. Do not compare strategies on different inputs.

Record model/version, prompt hash, catalogue version, case IDs, request count, retrieved candidate count, input/output/cache tokens, retries, elapsed time and costs using a dated pricing configuration. Record expected vs actual route and line fields. API cost per order is not total service cost: separately include hosting, monitoring, human review and support.

Provisional benchmark cap: at most $5 for the initial 50-case live run and $0.10 estimated maximum per normal order. These are spending ceilings, not claimed prices. Preflight worst-case input/output tokens before each call; reserve budget transactionally across workers and reconcile actual usage. Stop before a call if the reservation would exceed either ceiling. Store no API key in fixture files. Run mocks first; live API use must be explicitly enabled, never triggered by merely opening the demo.

## Evaluation design

The 50 provided cases are authored synthetic development/acceptance cases, with real MIME email files, declared fixture context and expected business outcomes. They are realistic examples, **not real customer communications**. They do not yet cover actual PDF OCR, handwriting, corrupt binary files or commercial ERP integration. HTML/text attachments are included; PDF/scanned-document fixtures are a separate pre-pilot tranche.

Every case records input, setup, expected route, minimum reason codes, expected line matches/quantities where definite, and forbidden actions. An ambiguous line has a null expected SKU rather than a conveniently forced answer. Cases are isolated unless explicit setup seeds a prior order/event. Unknown senders do not obtain account data through a model guess.

Proposed measured gates (targets, not results):
- All 50 business routing/required-flag assertions pass after human review of labels.
- Zero silent substitutions or unapproved exports in acceptance tests. Zero observed errors on 50 examples does not establish a zero real-world error rate.
- 100% exact-SKU and scoped-alias reference cases resolve correctly; conflicting descriptions still flag.
- At least 98% critical-field accuracy on independently labelled, clean supported-format cases; report numerator/denominator and full-order exact correctness too.
- Report false confident matches, abstention rate, candidate recall@5 and ambiguity detection separately. Do not increase match rate by suppressing review flags.
- Every retry/crash/replay test yields at most one committed order/export for the same event; PO revisions remain distinct.
- Provisional performance target: p95 indexed catalogue lookup under 200 ms on the 10k seed; p95 complete normal-order processing under 60 seconds at five concurrent jobs on the declared Mac configuration. Report actual resources and model latency; do not claim an SLA from local results.
- Run 50-message burst, 50–100-line order, provider outage, malformed output, process termination, expired job lease and simultaneous reviewer tests separately from email business cases.
- Measure complete manual vs assisted review on the same task mix with realistic reviewer familiarity. Target 50% less median handling time without higher critical errors; this is a hypothesis to test.

All 50 are visible development cases. Expand to 500 before larger claims: 300 development, 100 validation, 100 untouched final evaluation cases with withheld layouts/families, deduplicated inputs and independently checked labels. Do not tune against the final set. A real pilot additionally needs a permissioned sample, verified account/inventory integration, role/access tests, retention agreement, restore drill, incident handling and business sign-off. Run in shadow mode before writing into the customer's system.

## Build milestones

1. Review this spec and the 50 labels; implement typed schema, reference seed and deterministic validators.
2. Build Docker mock mode and manual-input review/export vertical slice. Test state transitions and permissions.
3. Add indexed catalogue retrieval and the 10k scale seed. Benchmark retrieval before adding AI matching.
4. Add structured extraction, bounded matching, instrumentation and live benchmark mode.
5. Add original PDF and scan fixtures, attachment-parser limits and evidence mapping. Test before claiming PDF support.
6. Add isolated n8n/test inbox ingestion; test OAuth, message threading, replay and amendments.
7. Complete resilience/security/user evaluation, publish a synthetic demo and measured report, then seek a controlled customer pilot.

## Sources checked 2026-10-28

- PostgreSQL indexed trigram matching: https://www.postgresql.org/docs/17/pgtrgm.html
- Docker Compose networking and internal-network limitations: https://docs.docker.com/compose/how-tos/networking/
- Docker secrets: https://docs.docker.com/compose/how-tos/use-secrets/
- Supabase local Docker workflow: https://supabase.com/docs/guides/local-development
- Mailpit Docker support: https://mailpit.axllent.org/docs/install/docker/
- Claude structured output capability (format guarantees do not establish factual accuracy): https://platform.claude.com/docs/en/build-with-claude/structured-outputs

These sources establish technical capabilities, not demand, ROI or tested performance of this project.
