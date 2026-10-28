# Pennbridge Order Desk — build and agent execution plan

Prepared and executed 28 October 2026. **Local mock-mode build implemented and evaluated.**

This is the canonical execution plan. It implements the research correction in PROJECT-SPEC.md and takes precedence over that document's older milestone order. The specification remains the source for business rules; this document defines implementation order, owners, model selection and completion gates. The original phase descriptions below record the approved plan. The status table here takes precedence over their prospective wording. No paid live AI calls were made.

## Execution status — 28 October 2026

| Area | Delivered / evidence |
|---|---|
| A — contracts and destination | Versioned contracts; actual Odoo 19 Test/Import/reimport service proof, including an app-generated CSV |
| B — isolated infrastructure and data | Local Docker app/worker/PostgreSQL/Mailpit; separate Odoo; 10k SKUs, 250 accounts, 500 addresses, 15k agreements; all master records seeded/read back in Odoo |
| C — review workflow | Login/roles, source/PDF preview, editable quantities and selling units, line exceptions, version-bound approval, stable CSV export, manual destination-verification record |
| D — ingestion and lookup | MIME, text/HTML, machine-generated PDF, strict standalone CSV; exact identifiers/account aliases then bounded lexical candidates; deterministic mock plus guarded live provider adapter |
| E — operations/review | Mailpit capture/retrieval demo; durable jobs/leases; independent targeted review and fixes; no external mail or public hosting |
| F — evaluated local release | Original50 across42 stateless +8 PostgreSQL stateful tests;20 PDF cases/286 lines;20 core regressions; lookup/roles/recovery/DB+storage restore/network checks in EVALUATION.md and SYSTEM-CHECKS.md |
| G — handover | README runbook, Odoo import guide, measured portfolio bullet, local working demo |

Implementation choices and remaining limits:
- Initial Odoo/desk master consistency is verified from a shared synthetic seed. Continuous Odoo-to-desk change synchronization is not implemented.
- SQL/domain code performs retrieval. No second LLM matching agent or vector database is needed for this release. The draft prompt describes the future bounded matching contract; the live extraction adapter is present but unbenchmarked.
- Default Docker networks deny worker outbound access. Live AI needs a deliberately configured provider connection, dedicated key, current model/pricing verification and budget; it is not enabled by simply changing the UI.
- The70 email/PDF scenarios are synthetic development fixtures, not a held-out accuracy benchmark. Neither real-customer production readiness nor commercial ROI is established.
- Odoo browser upload was blocked by Chrome extension file-URL permissions. The exact app CSV passed Odoo's real import service in dry-run, import and reimport; the resulting quotation was checked in the browser. No browser permissions were expanded.
- A narrated walkthrough recording and public portfolio publishing are not produced. The README contains a reproducible demonstration sequence.
- Luna handled bounded data/UI/harness/docs work; Sol handled contracts, lifecycle, Odoo and critical/system review. Coordinator integrated, repaired and verified the app. Agent token/cost telemetry was not available, so no measured savings claim is made.

## 1. The finished product

A local, reproducible portfolio application for fictional wholesaler Pennbridge. A customer already knows the parts and emails a purchase order. Pennbridge extracts its details, checks product codes/units/prices, shows exceptions, obtains human approval and prepares a correctly mapped quotation import for a local Odoo test instance.

Demonstration: submit a synthetic email containing a machine-generated PDF; watch the draft appear; inspect evidence alongside lines; resolve a discrepancy; approve; export; import through Odoo's Test/Import interface; verify the resulting quotation. Replay the message and show duplicate handling. Edit an approved draft and show that approval is invalidated.

“Finished build” means the local workflow operates and passes focused engineering smoke checks. “Evaluated release” additionally means the full post-build suites have been executed and results published. Live-model accuracy is unverified until the separate live benchmark runs. Neither status means production-ready or commercially validated.

## 2. Boundaries

Included:
- One fictional supplier, multiple customer accounts, GBP net prices and explicit packaging/units.
- 10,000 meaningful synthetic SKUs; exact, manufacturer-reference and customer-alias matching; bounded description search for exceptions.
- MIME `.eml`, plain text, sanitized HTML and machine-generated PDF documents. A documented CSV order schema bypasses AI.
- Manual upload, synthetic email injection, source evidence, editable drafts, human approval and audit history.
- Local Odoo Community Sales quotation import using stable external IDs. Import is deliberately human-operated initially.
- Docker development environment, Mailpit catcher, background jobs, recovery, metrics, tests and portfolio documentation.

Deferred beyond this release: live Gmail/Microsoft account setup, automatic external ERP posting, confirmed Odoo sales orders/stock reservation/invoices, real tax calculation, international pricing, scanned PDFs/handwriting, arbitrary XML dialects, custom-manufactured parts, vector search, automatic substitution, public hosting, multi-supplier SaaS and production customer data. These are explicit future additions, not hidden unfinished requirements.

The original 50 cases remain intact. Unsupported formats must return a useful review/error state instead of pretending to process them. A simple deterministic import is preferred wherever input is already structured.

## 3. Stack and service boundaries

| Layer | Choice | Responsibility |
|---|---|---|
| Web app | Next.js, React, TypeScript | Local login, intake, inbox, review, catalogue and evaluation screens |
| API/domain | TypeScript with runtime schema validation | Authoritative validation, permissions, approvals and export contracts |
| Background worker | Separate TypeScript process | MIME/PDF extraction, AI calls, lookup jobs, retry/lease handling |
| Persistence | PostgreSQL, versioned SQL migrations | Orders, jobs, catalogue mirror, audit, dedupe and budget reservations |
| Documents | Private project-scoped mounted storage | Originals, hashes, bounded previews and approved export artifacts |
| Test email | Mailpit | Capture synthetic mail; no external relay |
| AI | Claude provider adapter plus deterministic mock | Structured extraction and optional bounded matching |
| Test destination | Local Odoo Community 19 Sales | Real quotation import, using documented and instance-verified mappings |
| Tests | TypeScript unit/integration runner, browser tests, Python fixture utilities | Domain correctness, workflow checks and reproducible fixtures |
| Packaging | Docker Compose with pinned versions | Repeatable local environment and separate test profiles |

Choose exact supported Node/dependency/image versions at kickoff and record them in lockfiles and image tags/digests. Odoo 19 is the proposed pinned target, not a claim that a local instance has already been validated. If its edition/version import flow differs, resolve that before building the export adapter; do not silently replace the destination with a mock.

Keep Odoo and the order desk in separate databases. Seed business master records in Odoo, then export/synchronize a read-only catalogue/account reference into the desk. A shared seed definition may bootstrap both, but catalogue edits come from the master system; the desk must not become a second independent source of prices or products. Historical scenario records may live in the desk's test context and must be labelled as synthetic history rather than verified Odoo orders.

n8n is optional for this local release. The direct synthetic ingestion adapter demonstrates the workflow without another service. Later a dedicated n8n instance can connect a real test inbox to the same authenticated ingestion endpoint; it must not own approvals, dedupe or business rules.

## 4. Two different model budgets

**Building models** are Codex subagents writing/reviewing the project. **Runtime models** are API calls made by the application when processing an order. A subscription's coding allowance does not imply free Claude API usage. Track them separately; do not quote invented combined dollar savings.

### Build team

| Role | Model ID | Starting effort | Scope |
|---|---|---|---|
| Coordinator | Existing parent session | Existing setting | Task dispatch, decisions, integration, progress, final acceptance; do not claim to switch this session's model |
| Core engineer | `gpt-6.1-sol` | Medium; high for critical reviews | Contracts, schema, jobs, permissions, approval/export state and integration |
| Bounded implementer | `gpt-6-luna` | Medium; low for mechanical updates | Fixtures, seed generators, isolated UI components, known adapters, docs and straightforward test implementation |
| Independent reviewer | `gpt-6.1-sol` | High | Approval/version races, account scope, worker recovery, import correctness and test-label validity |
| Optional visual reviewer | `gpt-6.1-terra` | Medium | Inspect the finished review screen and demo flow; one focused pass only if useful |
| Exceptional escalation | `gpt-6-astra` | Medium | A specific unresolved architectural or correctness issue; no routine implementation or duplicate broad review |

These IDs are available in this session's delegation tools. Availability and billing may change; inspect available models at execution time. If Luna is unavailable, report the substitution rather than claiming lightweight delegation happened. Official guidance supports Luna for scoped work and Sol for complex technical work; these assignments are our project choices, not benchmark guarantees.

Use no more than four concurrent agents including the coordinator, normally parent plus two workers. A third worker is useful only when it has independent files and a settled interface. Agents do not recursively spawn more agents.

### Runtime AI

| Work | Starting choice | Policy |
|---|---|---|
| Structured CSV parsing, exact lookup, arithmetic, units, approvals | Ordinary code | No LLM call |
| PDF/text field extraction and intent | `claude-haiku-5-5` | First live benchmark candidate; schema-constrained output; bounded input/output |
| Interpret unresolved candidates | Same Haiku model | Optional second call with at most five candidates per unresolved line |
| Difficult-case comparison | `claude-sonnet-5-5` | Explicit benchmark option, disabled as automatic escalation by default |
| Development | Mock provider | Offline plumbing tests, never reported as AI accuracy |

Use the lowest supported effort that meets the quality gate and avoid unnecessary extended reasoning. Confirm account access, structured-output support, exact IDs and pricing before live runs; no silent fallback to a pricier model. If the proposed model is unavailable, finish mock-mode work and record the live benchmark blocker. Provider/version/effort/prompt hash must be saved with results.

Do not build a team of autonomous agents inside the product. It is a controlled processing pipeline, with zero to two normal-case AI calls, not a model debate. Optional retries and large-document batches count against explicit ceilings.

## 5. Cost and delegation rules

- Give workers a small task packet: objective, relevant spec excerpts, exact files, interface, acceptance check and non-goals. Use fresh scoped context (`fork_turns="none"`) when selecting the requested lighter model.
- Shared contracts are read-only once agreed. Workers request changes through the coordinator. Only the coordinator integrates shared package manifests, lockfiles, contracts and broad configuration.
- Assign one writer per file/directory. Use worktrees only after the initial baseline commit and when boundaries cannot avoid overlapping changes. Never discard pre-existing work.
- Reuse a worker for a closely related fix, not unrelated tasks with an ever-growing history. Return a short changed-files/checks/blockers handoff, not full source dumps.
- Do not run two agents to solve the same routine task. Independent review is reserved for critical code and final acceptance.
- After two unsuccessful bounded attempts or an identified architectural blocker, stop the loop and ask Sol to diagnose. Astra is only for a still-unresolved specific issue.
- Prefer deterministic generators and assertions over model-generated thousands of rows or model grading of exact fields.
- Record model/task/reason-for-escalation. Record token usage only when tooling exposes it; otherwise mark unknown. No invented savings percentage or token-total claim.
- Runtime benchmark defaults remain a proposed $5 first-run cap and $0.10 per normal-order ceiling, not a promised cost. Calculate/reserve worst-case call cost with current configuration; stop before exceeding the cap. Higher limits or a different paid service require an explicit change to the budget.

## 6. Planned repository ownership

Existing `docs/`, `prompts/`, `fixtures/` and `scripts/` stay in this project. Proposed application structure:

```text
apps/web/                 UI and server entry points
apps/worker/              background processing
packages/contracts/      schemas, reason codes and adapter interfaces
packages/domain/         pure business rules and lifecycle
packages/db/             migrations, queries, jobs and audit
packages/ingestion/      MIME, HTML, PDF and CSV handling
packages/ai/             mock/live provider and bounded calls
packages/integrations/   Odoo import mapping and Mailpit adapter
infra/                   Compose files, container configs, run/reset scripts
fixtures/                existing 50 cases plus added PDF/scale datasets
tests/                   domain, integration, browser and evaluation suites
results/                 generated run artifacts, ignored by Git
docs/                    canonical spec, this plan and eventual runbook/results
```

Core engineer owns contracts, domain, db and worker state. Luna workers can own isolated UI, seed, parser wrappers or integration formatting after interfaces are agreed. They cannot independently alter schema, authentication, approval authority, model budget policy or externally visible side effects.

## 7. Phase A — kickoff and contract proof

**A1 — Baseline and environment: coordinator + Luna.** Inspect Git state and preserve all current untracked planning files. Establish a baseline commit, `.env.example`, supported versions and start/reset commands. Check project ports and Docker resources without touching existing n8n services. Create project instructions consistent with this plan when implementation starts.

**A2 — Destination proof: Sol.** Start only the local Odoo test profile with fake credentials. Install Sales, seed one customer and two products, and export its import-compatible template. Test a multi-line quotation CSV using external IDs. Verify customer, product, quantity, unit, unit price, line count and draft quotation state. Reimport with the same external ID and verify no duplicate. Test an invalid product reference. Record the exact field mapping and version. Do not assume guessed CSV headers work.

**A3 — Contracts: Sol, reviewed by coordinator.** Define `SourceMessage`, `DocumentEvidence`, `ExtractedOrder`, `CandidateMatch`, `ValidatedDraft`, `Approval`, `ExportSnapshot`, `Job`, `ModelUsage` and structured reason codes. Specify normalized decimal/unit rules, nullable fields and customer scope. Define routes for quotes/cancellations/amendments instead of treating every email as a new order.

Exit: a verified destination import contract and frozen first-version interfaces. No broad UI/AI build before this gate. Basic proof checks here are engineering checks, not the final evaluation campaign.

## 8. Phase B — isolated foundations and data

**B1 — Infrastructure: Luna under Sol review.** Implement Compose profiles: offline app/worker/Postgres/Mailpit and an optional Odoo integration profile. Bind browser ports to localhost; do not publish database ports. Isolate runtime networking, mount only project data, keep secrets out of source, disable outgoing mail relay and avoid Docker-socket/privileged mounts. Image/dependency downloads happen during setup; offline claims apply to running services after setup. Verify actual connectivity rather than assuming `internal: true` covers every container.

**B2 — Data: Luna.** Preserve the 22 reference SKUs and existing 50 cases. Generate 10,000 SKUs with valid category/family/attribute combinations, including 8,000 active and 2,000 discontinued. Add 250 accounts, 500 addresses, 5,000 scoped aliases, 15,000 agreements and 12,000 historical orders/~100,000 lines. Check uniqueness, foreign keys, date ranges, unit consistency and reproducibility. Include deliberately close neighbours and known ambiguous descriptions. Seed/synchronize destination master records with stable external IDs.

**B3 — Persistence and jobs: Sol.** Migrations, exact/scoped indexes, decimal amounts, durable processing state, claimed leases, retries/dead-letter state, content hashes and business duplicate handling. Add an audit trail and version checks. Implement seeded local reviewer/admin accounts with server-side permission checks and protected documents. Do not rely on hidden UI buttons for authorization.

Parallelism: B1/B2 may run together after A3, while Sol owns B3. Coordinator alone resolves shared dependency changes. Exit: services boot reproducibly, data loads, and basic database/job smoke checks pass.

## 9. Phase C — human workflow before AI

**C1 — Review UI: Luna.** Build inbox queue, upload form, document/source preview, editable order grid, clear per-line warnings, candidate display, audit history and status filters against agreed contracts. Empty/loading/failed states must be understandable. Build realistic desktop layout; ensure smaller screens remain usable.

**C2 — Business workflow: Sol.** Manual input → deterministic validation → draft. Approval is bound to version and immutable content hash. Edits clear approval. Reject stale concurrent actions. Only authorized approved snapshots can export. No silent replacement, partial-order omission, current-price invention or delivery promise.

**C3 — Odoo output: Luna formats, Sol validates.** Generate the instance-verified import format from approved snapshots only. Persist external IDs and export artifacts. Record prepared/downloaded/import-verified as separate states: exporting a file is not evidence Odoo accepted it. Operator imports with Odoo Test/Import; verify the saved quotation and link its reference in the desk. Do not report automated destination posting.

Exit: a manually entered multi-line order can be reviewed, approved and imported correctly into local Odoo. This gives us a usable workflow even before models are connected.

## 10. Phase D — genuine documents and bounded matching

**D1 — Intake: Luna builds bounded parser wrappers; Sol reviews trust boundaries.** Parse MIME bodies/attachments, normalize safe HTML, hash originals and reject unsupported/oversized inputs. Extract machine-generated PDF text with page evidence. Bound file/page/line sizes and worker time. Keep external links inert and HTML previews sanitized. Structured CSV uses a documented schema and skips AI. Do not call all XML supported.

**D2 — PDF fixtures: Luna.** Add at least 20 machine-generated PDF orders across four layouts, including multi-page tables, repeated headers, near-identical product variants, conflicting revision evidence and units. Keep input documents and independently checked expected fields. Preserve original 50 `.eml` cases unchanged; add attachment variants with distinct IDs. No claimed scan/OCR accuracy.

**D3 — Retrieval: Sol owns query policy; Luna may implement bounded adapters.** Exact SKU → manufacturer reference → account alias → family/attribute-filtered lexical/trigram lookup. Conflicts with explicit attributes always flag. At most two search rounds, 20 internal candidates and five model-visible candidates per unresolved line. No critical attribute relaxation. Source catalogue version and account scope accompany evidence.

**D4 — AI adapter: Sol.** Implement versioned prompts and structured outputs, mock/live modes, provider timeouts and schema/business validation. Haiku first; Sonnet comparison configurable. Store observed token usage and latency. Enforce per-order and shared-run cost reservation across workers. Failed/unknown/truncated output yields review/failure, not a fabricated valid draft.

Exit: upload a synthetic PDF/email and obtain a source-backed reviewable draft. Mock mode verifies pipeline behavior only. If an API credential is not available, live mode remains visibly unconfigured; never label mock output as extracted by a real model.

## 11. Phase E — email demonstration and build freeze

**E1 — Synthetic inbox path: Luna.** Feed the `.eml` corpus through the ingestion API using a fixture runner. Submit sample messages to Mailpit and use its supported retrieval path to process captured mail when demonstrating inbox intake. Verify that the same ingestion code handles upload and captured messages. Mailpit is a test SMTP catcher, not a production Gmail/IMAP connector. Show ingest/job status and duplicate outcomes.

**E2 — Polish and operational tools: Luna.** Catalogue search, retry controls, version history, cost/latency display, model-mode badge, sample-order buttons and guided demo. Provide scoped reset and backup/restore utilities. No real outgoing mail; optional clarification drafts remain in-app or go to Mailpit.

**E3 — Build review/freeze: Sol.** Integrate changes; run type checks, build, focused unit/integration smoke checks and one browser walkthrough. Fix broken paths. Tag/record a candidate release and dataset/prompt hashes. Hand off a working build before the broad test campaign.

Exit: local application and Odoo demo are functional, with known limitations documented. No untested public deployment is part of this gate.

## 12. Phase F — full testing after the build

This is the separate testing phase requested by Oscar. Focused checks during implementation catch broken components; these full suites assess the assembled product.

**F1 — Deterministic acceptance: Luna execution; Sol investigates failures.** Run all 50 existing business cases against isolated contexts, plus PDF/CSV variants. Compare intent, route, minimum flags, exact line fields and forbidden side effects. Report false confident matches separately from abstentions. Verify unknown senders cannot retrieve account-specific context. Keep expected outputs hidden from the runtime application.

**F2 — Reliability and access: Sol + independent Sol review.** Replay events; resend POs; submit revisions; interrupt jobs before/after writes; expire a lease; simulate provider timeouts and malformed output; approve from two sessions; edit after approval; repeat exports/imports; test viewer/operator boundaries and document access; verify offline egress/no external mail; restore backup into an empty test database. Do not change labels simply to make a failing implementation pass.

**F3 — Scale: Luna runner, Sol analysis.** Full 10k seed; 50-message burst; 50–100-line orders; five workers/jobs as supported; observed p50/p95 timings, query plans, CPU/memory and failure/retry counts. Initial targets: p95 catalogue lookup <200 ms and normal-order completion <60 seconds under the declared local workload. Targets are provisional, not SLAs. Record hardware and mock/live mode.

**F4 — Live model benchmark: Sol configures, Luna runs bounded harness.** Once a dedicated API key and budget are available, run Haiku on frozen inputs. Compare rules-only baseline, extraction-plus-rules, and optional bounded matching. Measure critical-field correctness, whole-order correctness, candidate recall, abstention, harmful wrong matches, latency and actual usage cost. Sonnet is a controlled comparison on the same subset, not an invisible fallback. Stop when the budget is exhausted and report incomplete cases.

**F5 — Representative usability: Oscar/operator with test harness.** The 50 adversarial cases do not represent ordinary order frequency. Prepare a separate clean/mixed workload; measure complete manual versus assisted handling on comparable tasks, including correction and failed import time. Counterbalance task order where possible to reduce practice bias. Report participant, sample size and synthetic nature. The target of halving median handling time remains a hypothesis.

**F6 — Fix and confirm: assigned owner + reviewer.** Prioritize critical wrong-product/unit/customer results, unauthorized export and duplicate writes first. Fix root cause, rerun affected checks and relevant regression suites. Do not repeatedly rerun unchanged passing suites without a reason. Publish actual counts and remaining failures; no blanket “production ready” claim.

The original 50 tests are visible development acceptance cases, not a blind benchmark. For stronger accuracy claims, later expand toward 500 cases with 300 development/100 validation/100 held-out. An independent author/checker must establish labels and withhold final cases from prompt tuning. No real-world accuracy/ROI claim follows from synthetic results alone.

## 13. Phase G — portfolio finish and handover

Luna drafts a reproducible setup guide, architecture explanation, limitations, troubleshooting and a short demo script. Coordinator checks claims against results. Capture a 3–5 minute walkthrough: incoming PO, source evidence, one corrected exception, approval, Odoo quotation, replay prevention and measured results.

Final handover includes:
- Repository with reproducible seed/reset commands, dependency locks and no secrets.
- Working local app and verified Odoo quotation import.
- 10k synthetic catalogue, original 50 cases, PDF fixtures and documented test contexts.
- Actual acceptance/model/performance results, with failed/skipped tests disclosed.
- Model/cost configuration, prompt versions, architecture and runbook.
- CV bullet using only measured facts and a clear synthetic-project label.
- A list of remaining prerequisites for a real customer pilot or hosted version.

Public GitHub publishing, cloud hosting and real customer connections are separate actions, not needed to call the local portfolio deliverable finished. Share a recording or local demonstration first.

## 14. Agent execution waves

| Wave | Parallel tasks after dependencies | Models | Join/gate |
|---|---|---|---|
| 1 | A1; then A2/A3 | Luna setup, Sol contracts/import | Destination proof and contracts settled |
| 2 | B1 infra + B2 seed + B3 core | Luna + Luna + Sol | Healthy seeded stack |
| 3 | C1 UI + C2 domain; then C3 export | Luna + Sol; Luna adapter | Manual workflow imports correctly |
| 4 | D1 intake + D2 fixtures; then D3/D4 | Luna + Luna, Sol retrieval/AI | Document-to-draft workflow |
| 5 | E1 mail + E2 docs/UI + E3 review | Luna + Luna + Sol | Build candidate frozen |
| 6 | F1 acceptance + F2 core review; then F3/F4/F5 | Luna runners, Sol analysis | Results recorded, critical issues fixed |
| 7 | G docs/demo + final review | Luna; optional Terra visual; Sol review | Verified local handover |

Slots are reused; these are roles, not a permanent large team. Coordinator plus three workers is the maximum, not a target. Tasks needing the same file are serialized. No worker is launched before it has useful independent work.

## 15. Task-packet template for execution

```text
Task ID and concrete outcome:
Model / effort / why this model is sufficient:
Read only these references/contracts:
Owned paths (one writer):
Inputs and stable interface:
Required behavior and non-goals:
Acceptance command or observable check:
Allowed external effects: local fixture environment only
Stop/escalate conditions:
Return: changed files, checks and actual results, limitations, next dependency
```

The coordinator updates this plan's milestone status during execution. Do not create a new competing tracker or summary after every wave. Important decisions belong in the canonical specification or this plan.

## 16. What “go” will start

Oscar's next “go” starts Phase A and then progresses through the local build in dependency order, with lightweight agents for bounded tasks. No further confirmation is needed for routine local reversible implementation already described here. The broad test campaign follows the build; missing credentials/budget may block live AI evaluation but must not block mock-mode implementation or deterministic tests.

If account access or paid-budget confirmation is actually missing, state the exact missing input and continue independent local work. Never request secrets in chat or read unrelated credentials. Do not contact businesses, connect personal inboxes, publish publicly or incur unagreed hosting costs as part of this plan.

## 17. Sources and verification limits

Checked 28 October 2026:
- OpenAI model task/effort guidance: https://developers.openai.com/api/docs/guides/model-selection
- Codex/Work model guidance: https://learn.chatgpt.com/docs/models?surface=cli
- Claude model IDs/capabilities: https://platform.claude.com/docs/en/models/overview
- Haiku extraction positioning: https://platform.claude.com/docs/en/models/haiku-5-5/overview
- Odoo quotation import, external IDs and multi-line data: https://www.odoo.com/documentation/19.0/applications/general/export_import_data.html
- Existing project SANDBOX.md contains Docker/Mailpit sources.

Two scoped planning reviews used `gpt-6-luna` with medium effort and fresh context. No code or services were built in those reviews. Model selection is an initial engineering choice; task-specific measured quality decides whether it remains appropriate. Public model guidance does not establish account-specific availability or exact Codex savings. Odoo documentation does not replace the local import proof in A2.
