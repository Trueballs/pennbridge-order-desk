# Evaluation and local runbook

## Start the demo

From the project root, with Docker Desktop running:

```sh
npm ci
docker compose -f infra/compose.yaml up --build -d
docker compose -f infra/compose.yaml ps
```

The first build downloads pinned images and dependencies. Open <http://127.0.0.1:3087> and sign in with `reviewer@pennbridge.example` / `reviewer-demo`. The app also seeds `admin@pennbridge.example` / `admin-demo` and `viewer@pennbridge.example` / `viewer-demo`. These are synthetic local demo credentials; an existing initialized database retains its original seeded passwords.

Choose **Try sample order** to send the included synthetic PDF email to the local Mailpit catcher and then process the captured message. In the inbox, open the resulting order, inspect document evidence and flagged lines, correct or acknowledge the review items, save, approve, and export. The export must still be imported and verified in Odoo separately. Mailpit is available at <http://127.0.0.1:8027>.

The Compose stack contains the web app, worker, Postgres, Mailpit, and a loopback-bound nginx proxy. Postgres and the worker are private to the Compose network. `LIVE_AI_ENABLED=false` is set by Compose, so this workflow makes no paid model calls. Stop the stack and keep its volumes with:

```sh
docker compose -f infra/compose.yaml stop
```

## Reproduce offline checks

```sh
npm run typecheck
npm test
npm run fixtures:check
npm run seed:check
npx tsx scripts/evaluate.ts
npx tsx scripts/evaluate_pdfs.ts
```

The two evaluators write ignored artifacts under `results/acceptance/`. The default `npm test` run currently passes 19 offline tests and skips 16 PostgreSQL-backed tests. The passing tests cover 12 domain checks, 2 harness-boundary checks, 3 PDF checks, and 2 ingestion-boundary checks. The skipped tests are 8 lifecycle checks in `tests/core-db.test.ts` and 8 stateful fixture checks in `tests/stateful-acceptance.test.ts`. Run the database suites against fresh isolated databases on the existing private Docker network:

```sh
bash scripts/test_db.sh
```

The verified runner creates unique test databases, mounts current source/tests read-only into the app image, runs eight lifecycle and eight stateful checks (16/16 passed, no skips), and retains the databases for inspection. It publishes no database port and never resets an existing database. Logs are saved under `results/acceptance/`.

The tests check their database name before initialization. The lifecycle suite passes eight PostgreSQL-backed checks for authorization, editing and approval invalidation, concurrent version checks, export idempotency, intake dedupe, duplicate-PO routing, job leases, and model-budget reservations. The stateful fixture suite passes eight original cases, with mock extraction and the real intake, job, order, and history services; it writes `results/acceptance/stateful.json`. It verifies duplicate-message replay, duplicate POs, customer-scoped duplicate handling, amendments, cancellation review, and history suggestion provenance. Historical orders are shown as bounded, customer-scoped suggestions in the order detail UI; they are not sent to the extraction provider and current prices are not copied from history. These suites use synthetic records and no paid model calls.

## Original email cases: measured result

The 50 `.eml` inputs and their manifest hashes are frozen. The harness reads expected labels only to score results after processing. Each case passes production `parseInput`, the deterministic offline `MockProvider`, and production domain `validate`, using fresh in-memory account/catalogue context built from `fixtures/context.json`.

Latest recorded stateless run:

- 42 of 42 cases passed intent, route, required-flag, line-field, and customer checks.
- There were no evaluator errors. The run reported median/p95 case latency of 0.82/3.48 ms on the machine used for that run; this is local harness timing, not a service performance claim.

The eight stateful cases are now separately scored through actual services and real PostgreSQL rather than excluded. The latest `results/acceptance/stateful.json` run passed 8/8 (PB-031–036, PB-038–039). It uses mock extraction with real persistence and service behavior, not AI. Taken together, all 50 original email fixtures have been checked across these two runs. They are not a single homogeneous end-to-end evaluation: the 42-case suite uses fresh in-memory domain context; the 8-case suite sets up database records and verifies replay/lifecycle outcomes.

Run `npx tsx scripts/evaluate.ts` to refresh `results/acceptance/run.json` and `run.md`. It stops if an input hash differs from `fixtures/manifest.json`. Outputs include actual intent, route, flags, customer, line IDs, raw and selected SKUs, quantities, units, per-check numerators/denominators, and latency.

## PDF cases: measured result

The separate 20-case suite uses the synthetic machine-generated PDFs and the production MIME/PDF text parser. Each parsed result then goes through the same offline `MockProvider`. Latest recorded run:

- 20 of 20 cases passed exact-line matching.
- 286 of 286 expected SKU, quantity, unit, and quoted-price fields matched.
- 286 of 286 expected line values appeared together in page-backed source evidence, and all 286 extracted line references were page-backed by their parsed PDF.
- There were no evaluator errors. The run reported median/p95 case latency of 7.85/68.14 ms on the machine used for that run.

Run `npx tsx scripts/evaluate_pdfs.ts` to refresh `results/acceptance/pdf-run.json` and `pdf-run.md`. It verifies the PDF content hash declared in `fixtures/pdf/cases.json`. Missing quoted prices count as misses; labels are not supplied to the parser. Page evidence is checked separately from line-field correctness.

## Live AI benchmark

`scripts/evaluate_live.ts` runs a real model over the same 50 email and 20 PDF fixtures, using the same parsing, domain validation and scoring code as the offline evaluators (it imports their `runCase`). It is the only path that makes paid calls, and its output is labelled live-model results. The fixtures are visible synthetic data, not a holdout.

```sh
npm run eval:live -- --dry-run                       # no network; case count and cost range
export GEMINI_API_KEY=...                             # in the shell only; never in a file
npm run eval:live -- --provider gemini --limit 3      # smoke test: 3 email + 3 PDF cases
npm run eval:live -- --provider gemini                # full run
# Anthropic instead: export ANTHROPIC_API_KEY=...; npm run eval:live (default) or -- --model claude-sonnet-5-5
```

Options: `--provider anthropic|gemini` (or `AI_PROVIDER`), `--model`, `--limit N` (per suite), `--dry-run` (also the default when the provider's key is unset). `AI_RUN_BUDGET_USD` (default 2.00) is a hard cap: before each call the worst-case cost (conservative byte-based reservation) is checked and the run stops when it would exceed the cap. The run also stops on the first HTTP 4xx other than 429 (bad key, model or schema), since every later case would fail the same way. Concurrency is 2. Keys are read from the environment only and error text is redacted.

Output goes to `results/live/run-<timestamp>.json` (per-case pass/fail per field, API latency, tokens, cost) and `.md` (accuracy by field, failure list, p50/p95 latency, total and per-order cost). Model errors (refusal, truncation, invalid JSON, schema failure) count as failures, not exclusions. Cases that need unmodelled order-history state are shown as diagnostic and excluded from the email denominator, as in the offline run.

Models and prices (USD per 1M tokens, standard tier, text; override with `AI_INPUT_USD_PER_MILLION` / `AI_OUTPUT_USD_PER_MILLION`):

| Provider / model | Input | Output | Source |
|---|---|---|---|
| anthropic / `claude-haiku-5-5` (default) | 0.10 | 0.50 | claude-api skill model table, cached 2026-10-06 (prompts up to 100K tokens) |
| anthropic / `claude-sonnet-5-5` | 2.00 | 10.00 | same |
| gemini / `gemini-3.5-flash-lite` (default) | 0.30 | 2.50 | https://ai.google.dev/gemini-api/docs/pricing, fetched 2026-10-28; output includes thinking tokens |
| gemini / `gemini-3.1-flash-lite` | 0.25 | 1.50 | same |
| gemini / `gemini-3.8-flash` | 0.75 | 3.75 | same; promotional through 2026-12-31, then 1.50 / 7.50 |

Dry-run estimate (70 cases, heuristic from byte counts, no network): Haiku 5.5 about $0.04-$0.17 in total ($0.0006-$0.0024 per order); Gemini 3.5 Flash-Lite about $0.16-$0.77 ($0.0023-$0.011 per order); about 196k-313k input and 40k-272k output tokens. The high end assumes thinking tokens. These are estimates only; the live run records measured tokens and cost.

The Gemini request uses `generationConfig.responseJsonSchema` with `responseMimeType: application/json`. Both full Gemini runs completed all 70 cases with no HTTP error on this field. The one HTTP 400 seen was an invalid API key. Anthropic structured output uses `output_config.format` with a schema normalized by the SDK's `zodOutputFormat`; no Anthropic live run is recorded in `results/live/`.

## Held-out set

Because the prompt was tuned on the 70 dev fixtures, `fixtures/holdout/` adds an untouched benchmark: 30 email cases (H-001..H-030) and 6 PDF cases (HP-001..HP-006, 133 labelled lines, three of them 26-38 lines over two pages). It is generated by `python3 scripts/generate_holdout.py` (deterministic; frozen hashes in `fixtures/holdout/manifest.json` and `fixtures/holdout/pdf/cases.json`) and uses only the customers, addresses and 22 products in `fixtures/context.json`. The cases are stateless and use the same label schema as the dev set. Styles differ from the dev set: other senders and signatures, HTML-only and forwarded bodies, a quoted older order, an out-of-office reply, a quote request, a cancellation and an amendment, and a text attachment with the quantity before the code. Failure modes include a zero quantity, unknown and discontinued SKUs, price and total mismatches, a missing unit, a bearing without suffix and a loose count against a pack-only product. The PDFs add two-column headers, line-number, quantity-first and price-before-quantity columns, and totals rows.

Independence rule: the cases and labels were written from `fixtures/SCENARIOS.md`, the contracts and the domain validation rules, without reading `prompts/order-interpreter.md`, the AI provider code or any live results, and labels were not copied from MockProvider output. The prompt must not be tuned against this set; if it is, build a new one. Stateless amendment and cancellation cases are labelled route `needs_review` because `statusRoute` in `scripts/evaluate.ts` folds `amendment_review` and `cancellation_review` into it; intent and the required flag carry the distinction. Run it with `npm run eval:live -- --suite holdout` (`--suite dev|holdout|all`, default `dev`; `--dry-run` works for every suite). Result files for non-dev suites are named `run-<suite>-<timestamp>` and the summary records the suite. The offline MockProvider is tuned to the dev set and is expected to score poorly here (12/30 email cases, 1/6 PDF cases); that figure is only a sanity check of the harness and labels, not model accuracy.

## Live AI results (Gemini)

Two full live runs used `gemini-3.5-flash-lite` through `GeminiProvider` with `prompts/order-interpreter.md`, on the same 70 visible synthetic cases: 42 email, 8 stateful and 20 PDF. The 8 stateful cases are diagnostic only in these runs; they are covered by the PostgreSQL suite. Both runs were made on 2026-10-28. Raw results are git-ignored in `results/live/`: run 1 is `run-2026-10-28T20-56-40-421Z` and run 2 is `run-2026-10-28T21-00-55-842Z` (`.json` and `.md`).

| Measure | Run 1 | Run 2 |
|---|---|---|
| Setup | Baseline prompt with identifier-field fix (after a 6-case smoke test); output limit 8,192 tokens | Prompt fixes listed below; output limit 32,768 tokens |
| Email overall (42 cases) | 32/42 (76.2%) | 37/42 (88.1%) |
| Email intent / route / required flags / lines / customer | 40 / 36 / 39 / 34 / 41 | 41 / 39 / 41 / 41 / 42 |
| PDF cases with all lines exact (20) | 16/20 | 18/20 |
| PDF lines exact (286) | 46/286 (16.1%) | 167/286 (58.4%) |
| Model or schema errors | 5: four MAX_TOKENS truncations (PDF-005, 010, 015, 020) and one schema-invalid reply (PB-047, intent outside the enum; rejected by zod) | 0 |
| API latency p50 / p95 | 1.7 s / 14.1 s | 1.6 s / 3.1 s |
| Tokens in / out | 95,955 / 71,054 | 107,295 / 63,000 |
| Cost, 70 cases | $0.21 | $0.19 |
| Cost per order | $0.0030 | $0.0027 |

The PDF line figure is lower than the case count suggests because the two failing PDFs in run 2 are the 60-line documents. Together they hold 120 of the 286 labelled lines.

Failure patterns found in run 1, and what changed:

- Product codes were put into `manufacturerReference` or `customerAlias` instead of `sku`, causing catalogue misses. The prompt now places them in `sku`.
- Descriptions were put into `sku`, which blocked description search.
- The model changed a quantity of `-2` to `2` (PB-049). That would have hidden an invalid quantity. The prompt now requires the exact sign.
- Lines were returned for a quote request and for conflicting attachments.
- Four large multi-page PDFs were truncated at 8,192 output tokens (MAX_TOKENS). The output limit was raised to 32,768 tokens.

Remaining failures in run 2:

- **Silent line omission on long PDFs (most important open risk).** PDF-005 and PDF-015 are 60-line multi-page PDFs. The model returned 1 and 0 lines respectively, with no error. Schema validation cannot catch this, because the reply is valid. **Mitigated after run 2:** `lineCoverage` in `packages/domain/index.ts` counts tabular order rows (`CODE  qty  unit …`) in the source text independently of the model and adds a blocking `INCOMPLETE_EXTRACTION` reason when fewer lines were extracted. Replayed against the run 2 outputs it fires on PDF-005 and PDF-015, with 0 false positives across all 70 fixtures (`tests/line-coverage.test.ts`). It only covers tabular rows; omissions from prose orders are still left to the reviewer.
- PB-015: the email said "6204 bearings" and the model added a suffix, `6204-2RS`, to `sku`. The catalogue lookup found no match, so no wrong product was selected, but the flag differed from the expected one.
- PB-029: classified as an amendment rather than a new order (new shipping address).
- PB-004, PB-006 and PB-007: routing and flag differences on address and description-only lines.

Caveats:

- The 70 fixtures are synthetic and visible, and the prompt was tuned on them. These are development scores, not held-out accuracy.
- Human approval is still required for every order.
- Measured spend across the five live runs in `results/live/` is about $0.42. That is two 6-case smoke runs, one of which stopped with HTTP 400 (invalid API key) on both attempted cases, plus runs 1 and 2.
- Only the Gemini path has been run live.

## What these results establish

These are visible synthetic development cases, not an untouched holdout. The 42-case email run is a parser/domain acceptance diagnostic; the separate 8-case run measures stateful service behavior with mock extraction and PostgreSQL; the PDF run measures machine-generated PDF text extraction plus deterministic mock parsing and source evidence references. None is AI accuracy, a production accuracy estimate, or a real-customer outcome. Scanned PDFs/OCR are not evaluated. The Gemini runs in the section above are the only live-model results. They are paid, use visible development fixtures, and are reported separately from the offline figures.

## Local system checks

The separate [system-check report](SYSTEM-CHECKS.md) records authenticated catalogue requests against the 10,000-product database, viewer write-permission rejection, backup/restore fingerprint checks for all 22 database tables and document storage, and an isolated worker crash/lease-recovery run. It also records network probes from the worker container. The 100-query catalogue sample reported a 257.36 ms p95; this was a brief localhost sample over ten repeated SKUs, not a performance target or capacity claim. The recovery check used a restored copy and did not interrupt the running demo worker. Full methods, artifacts, and limits are in that report.

## Optional local Odoo proof

The app and Odoo use separate Compose projects and databases. To start the optional Odoo 19 proof stack and rerun its minimal real CSV import proof:

```sh
bash scripts/odoo_start.sh
```

The local Odoo UI is at <http://127.0.0.1:8067>. The proof imports and reimports a synthetic quotation through Odoo's `base_import.import` machinery. The shipping-aware proof and verified mapping are documented in [ODOO-IMPORT.md](ODOO-IMPORT.md); run `bash scripts/odoo_shipping_proof.sh` for its separate alternate-address check. This proves the documented synthetic CSV mapping against the pinned local Odoo version. It is not automatic posting from the desk, a customer ERP integration, or evidence that stock is reserved or orders are fulfilled.

## Browser and destination smoke check

The final local build was exercised in Chrome: reviewer sign-in, Mailpit sample injection, PDF/source preview, visible line-level price exceptions, reviewer notes, save, approval, CSV export, and manual destination verification. Selling quantities remained 2 packs / 6 each / 4 rolls through save and export. Odoo's real import service accepted that CSV in Test/Import/reimport, preserving record and line IDs; its resulting draft quotation S00007 was inspected in the browser at GBP61.40. The app's export history now records manual verification against S00007. Screenshots are in `results/screenshots/`.

The Chrome extension file chooser could not upload because file-URL permission was disabled. That browser upload path remains unverified; the actual Odoo import service was tested instead. No browser permission was changed. Build/typecheck pass; Next's dynamic-filesystem tracing warnings remain and should be addressed before optimizing a hosted image.
