import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { LiveProvider, GeminiProvider } from '../packages/ai/index';
import { parseInput } from '../packages/ingestion/index';
import type { ExtractionProvider, ExtractionInput } from '../packages/contracts/index';
import { runCase as runEmailCase, type Fixture } from './evaluate';
import { runCase as runPdfCase, type PdfCase } from './evaluate_pdfs';

/**
 * Live-model benchmark. Same fixtures, parsing, domain validation and scoring as the offline
 * evaluators (their runCase is reused); only the provider differs. Results are LIVE MODEL results.
 * Usage: npx tsx scripts/evaluate_live.ts [--dry-run] [--limit N (per suite)] [--provider anthropic|gemini] [--model ID]
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

type Provider = 'anthropic' | 'gemini';
// Per-million-token USD prices (standard tier, text). Sources are listed in docs/EVALUATION.md.
const PRICES: Record<Provider, Record<string, { in: number; out: number; source: string }>> = {
  anthropic: {
    'claude-haiku-5-5': { in: 0.10, out: 0.50, source: 'claude-api skill model table (cached 2026-10-06); prompts <=100K tokens' },
    'claude-sonnet-5-5': { in: 2.00, out: 10.00, source: 'claude-api skill model table (cached 2026-10-06)' },
  },
  gemini: {
    'gemini-3.5-flash-lite': { in: 0.30, out: 2.50, source: 'ai.google.dev/gemini-api/docs/pricing (fetched 2026-10-28); output includes thinking' },
    'gemini-3.1-flash-lite': { in: 0.25, out: 1.50, source: 'ai.google.dev/gemini-api/docs/pricing (fetched 2026-10-28)' },
    'gemini-3.8-flash': new Date() < new Date('2027-01-01')
      ? { in: 0.75, out: 3.75, source: 'ai.google.dev/gemini-api/docs/pricing (fetched 2026-10-28); promotional through 2026-12-31, then 1.50/7.50' }
      : { in: 1.50, out: 7.50, source: 'ai.google.dev/gemini-api/docs/pricing (fetched 2026-10-28)' },
  },
};
const DEFAULT_MODEL: Record<Provider, string> = { anthropic: 'claude-haiku-5-5', gemini: 'gemini-3.5-flash-lite' };
const KEY_VAR: Record<Provider, string> = { anthropic: 'ANTHROPIC_API_KEY', gemini: 'GEMINI_API_KEY' };

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const pct = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.max(0, Math.ceil(s.length * q) - 1)] : null; };
const redact = (text: string) => [process.env.ANTHROPIC_API_KEY, process.env.GEMINI_API_KEY].filter((k): k is string => !!k).reduce((t, k) => t.split(k).join('[redacted]'), text);

type Task = { suite: 'email' | 'pdf'; id: string; email: Fixture | PdfCase };
type Record_ = {
  suite: 'email' | 'pdf'; id: string; outcome: 'pass' | 'fail' | 'error' | 'diagnostic' | 'skipped';
  fields: Record<string, unknown>; apiLatencyMs: number | null; caseLatencyMs: number | null;
  inputTokens: number | null; outputTokens: number | null; costUsd: number | null; error?: string;
};

async function loadTasks(limit: number | undefined) {
  const emails = JSON.parse(await readFile(path.join(ROOT, 'fixtures/cases.json'), 'utf8')) as Fixture[];
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'fixtures/manifest.json'), 'utf8')) as Array<{ path: string; sha256: string }>;
  const frozen = new Map(manifest.map(x => [x.path, x.sha256]));
  for (const c of emails) {
    if (frozen.get(c.email_path) !== sha(await readFile(path.join(ROOT, c.email_path)))) throw new Error(`Frozen input hash mismatch for ${c.id}`);
  }
  const pdfs = JSON.parse(await readFile(path.join(ROOT, 'fixtures/pdf/cases.json'), 'utf8')) as PdfCase[];
  if (emails.length !== 50 || pdfs.length !== 20) throw new Error(`Expected 50 email and 20 PDF fixtures; found ${emails.length} and ${pdfs.length}.`);
  const reference = JSON.parse(await readFile(path.join(ROOT, 'fixtures/context.json'), 'utf8'));
  const take = <T,>(xs: T[]) => (limit === undefined ? xs : xs.slice(0, limit));
  const tasks: Task[] = [
    ...take(emails).map(c => ({ suite: 'email' as const, id: c.id, email: c })),
    ...take(pdfs).map(c => ({ suite: 'pdf' as const, id: c.id, email: c })),
  ];
  return { tasks, reference };
}

/** No-network estimate: tokens from byte counts of the exact request payload, output from expected line counts. */
async function estimate(tasks: Task[], price: { in: number; out: number }) {
  const system = await readFile(path.join(ROOT, 'prompts/order-interpreter.md'), 'utf8');
  const { zodOutputFormat } = await import('@anthropic-ai/sdk/helpers/zod');
  const { ExtractedOrderSchema } = await import('../packages/contracts/index');
  const fixedBytes = Buffer.byteLength(system + JSON.stringify(zodOutputFormat(ExtractedOrderSchema).schema));
  let inLow = 0, inHigh = 0, outLow = 0, outHigh = 0;
  for (const t of tasks) {
    const file = t.suite === 'email' ? (t.email as Fixture).email_path : (t.email as PdfCase).email;
    const raw = await readFile(path.join(ROOT, file));
    const parsed = await parseInput({ filename: path.basename(file), mediaType: 'message/rfc822', content: raw, messageId: t.id, documentId: `doc-${t.id}` });
    const input: ExtractionInput = { text: parsed.text, documents: parsed.documents, evidence: parsed.evidence };
    const bytes = fixedBytes + Buffer.byteLength(JSON.stringify({ text: input.text, documents: input.documents.map(d => ({ id: d.id, filename: d.filename })), evidence: input.evidence }));
    const lines = t.suite === 'email' ? (t.email as Fixture).expected.lines.length : (t.email as PdfCase).expected_lines.length;
    const o = 200 + 80 * lines;
    inLow += bytes / 4; inHigh += bytes / 2.5; outLow += o; outHigh += Math.min(8192, 2 * o + 3000);
  }
  const cost = (i: number, o: number) => (i * price.in + o * price.out) / 1e6;
  return { cases: tasks.length, inputTokens: [Math.round(inLow), Math.round(inHigh)], outputTokens: [Math.round(outLow), Math.round(outHigh)], costUsd: [cost(inLow, outLow), cost(inHigh, outHigh)] };
}

async function main() {
  const provider = (arg('--provider') || process.env.AI_PROVIDER || 'anthropic') as Provider;
  if (!(provider in PRICES)) throw new Error(`Unknown provider "${provider}" (anthropic|gemini).`);
  const model = arg('--model') || DEFAULT_MODEL[provider];
  const price = PRICES[provider][model];
  if (!price) throw new Error(`Model "${model}" is not on the ${provider} allowlist: ${Object.keys(PRICES[provider]).join(', ')}.`);
  const limitArg = arg('--limit');
  const limit = limitArg === undefined ? undefined : Number(limitArg);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error('--limit must be a positive integer.');
  const budget = Number(process.env.AI_RUN_BUDGET_USD || '2.00');
  if (!(budget > 0)) throw new Error('AI_RUN_BUDGET_USD must be a positive number.');
  const hasKey = !!process.env[KEY_VAR[provider]];
  const dry = process.argv.includes('--dry-run') || !hasKey;
  process.chdir(ROOT);

  const { tasks, reference } = await loadTasks(limit);
  const inRate = process.env.AI_INPUT_USD_PER_MILLION ?? String(price.in);
  const outRate = process.env.AI_OUTPUT_USD_PER_MILLION ?? String(price.out);

  if (dry) {
    const est = await estimate(tasks, { in: Number(inRate), out: Number(outRate) });
    console.log(`DRY RUN (no network, no model calls)${hasKey ? '' : ` - ${KEY_VAR[provider]} not set`}`);
    console.log(`Provider/model: ${provider} / ${model}  ($${inRate} in, $${outRate} out per 1M tokens; ${price.source})`);
    console.log(`Cases: ${est.cases} (${tasks.filter(t => t.suite === 'email').length} email + ${tasks.filter(t => t.suite === 'pdf').length} PDF)`);
    console.log(`Estimated input tokens:  ${est.inputTokens[0].toLocaleString()} - ${est.inputTokens[1].toLocaleString()}`);
    console.log(`Estimated output tokens: ${est.outputTokens[0].toLocaleString()} - ${est.outputTokens[1].toLocaleString()} (high end allows thinking tokens)`);
    console.log(`Estimated cost: $${est.costUsd[0].toFixed(4)} - $${est.costUsd[1].toFixed(4)}  (per case $${(est.costUsd[0] / est.cases).toFixed(5)} - $${(est.costUsd[1] / est.cases).toFixed(5)})`);
    console.log(`Run budget cap: $${budget.toFixed(2)} (AI_RUN_BUDGET_USD). Heuristic estimate; the live run records measured tokens and cost.`);
    return;
  }

  Object.assign(process.env, { LIVE_AI_ENABLED: 'true', EXTRACTION_MODEL: model, AI_INPUT_USD_PER_MILLION: inRate, AI_OUTPUT_USD_PER_MILLION: outRate,
    AI_PRICING_VERSION: process.env.AI_PRICING_VERSION || `${provider}-${model}-${new Date().toISOString().slice(0, 10)}` });

  // In-process budget guard: refuses any call whose worst-case cost could push cumulative spend past the cap.
  let spent = 0, outstanding = 0, stop: string | null = null, seq = 0;
  const held = new Map<string, number>();
  const guard = {
    reserve: async (usd: string) => {
      const r = Number(usd);
      if (stop) throw Object.assign(new Error(stop), { code: 'BUDGET_STOP' });
      if (spent + outstanding + r > budget) { stop = `Budget cap $${budget.toFixed(2)} reached (spent $${spent.toFixed(4)}).`; throw Object.assign(new Error(stop), { code: 'BUDGET_STOP' }); }
      const id = `r${++seq}`; held.set(id, r); outstanding += r; return id;
    },
    settle: async (id: string, usd: string | null) => { const r = held.get(id) ?? 0; held.delete(id); outstanding -= r; spent += usd === null ? r : Number(usd); },
  };
  const Live = provider === 'gemini' ? GeminiProvider : LiveProvider;
  const live = new Live({ runId: 'live-benchmark', orderId: 'benchmark', budget: guard });

  const records: Record_[] = [];
  let next = 0;
  const runTask = async (t: Task) => {
    let usage: { latencyMs: number; inputTokens: number; outputTokens: number; costUsd: string } | null = null;
    let modelLines: unknown = null;
    let failure: any = null;
    const wrapped: ExtractionProvider = {
      mode: 'live',
      extract: async input => {
        try { const r = await live.extract(input); usage = r.usage as any; modelLines = r.extracted.lines.map(l => ({ sku: l.sku, manufacturerReference: l.manufacturerReference, customerAlias: l.customerAlias, quantity: l.quantity, unit: l.unit, rawText: l.rawText.slice(0, 160) })); return r; } catch (e: any) { failure = e; throw e; }
      },
    };
    const base = { suite: t.suite, id: t.id };
    let rec: Record_;
    if (t.suite === 'email') {
      const r = await runEmailCase(t.email as Fixture, reference, wrapped);
      const overall = r.checks.overall;
      rec = { ...base, outcome: r.status === 'error' ? 'error' : r.status === 'unsupported_setup' ? 'diagnostic' : overall ? 'pass' : 'fail',
        fields: { ...r.checks, flags: r.actual?.flags ?? null, status: r.status, unsupportedSetup: r.unsupportedSetup }, apiLatencyMs: null, caseLatencyMs: r.latencyMs, inputTokens: null, outputTokens: null, costUsd: null, error: r.error };
    } else {
      const r = await runPdfCase(t.email as PdfCase, wrapped);
      const ok = r.status === 'evaluated' && r.counts.exactLines.passed === r.counts.exactLines.denominator && r.counts.sourcePageEvidence.passed === r.counts.sourcePageEvidence.denominator;
      rec = { ...base, outcome: r.status === 'error' ? 'error' : ok ? 'pass' : 'fail', fields: { counts: r.counts, expectedLines: r.expectedLineCount, actualLines: r.actualLineCount },
        apiLatencyMs: null, caseLatencyMs: r.latencyMs, inputTokens: null, outputTokens: null, costUsd: null, error: r.error };
    }
    const bill = usage ?? failure;
    if (bill && typeof bill.latencyMs === 'number') Object.assign(rec, { apiLatencyMs: bill.latencyMs, inputTokens: bill.inputTokens, outputTokens: bill.outputTokens, costUsd: Number(bill.costUsd) });
    // Raw model lines make failed cases diagnosable without another paid run.
    if (rec.outcome === 'fail') (rec as any).modelLines = modelLines;
    if (failure?.code === 'BUDGET_STOP') rec.outcome = 'skipped';
    if (rec.error) rec.error = redact(rec.error).slice(0, 500);
    // A rejected request (bad key, model or schema) will fail identically for every case: stop spending.
    if (typeof failure?.status === 'number' && failure.status >= 400 && failure.status < 500 && failure.status !== 429) stop = `Stopped after HTTP ${failure.status} from provider: ${redact(String(failure.message)).slice(0, 300)}`;
    records.push(rec);
    const mark = rec.outcome === 'pass' ? 'pass' : rec.outcome;
    console.log(`[${records.length}/${tasks.length}] ${t.suite} ${t.id}: ${mark}${rec.costUsd !== null ? ` $${rec.costUsd.toFixed(5)}` : ''} (spent $${spent.toFixed(4)})`);
  };
  const worker = async () => { while (!stop && next < tasks.length) await runTask(tasks[next++]); };
  const startedAt = new Date();
  await Promise.all([worker(), worker()]);
  for (; next < tasks.length; next++) records.push({ suite: tasks[next].suite, id: tasks[next].id, outcome: 'skipped', fields: {}, apiLatencyMs: null, caseLatencyMs: null, inputTokens: null, outputTokens: null, costUsd: null, error: stop ?? 'not run' });

  // ---- summary ----
  const email = records.filter(r => r.suite === 'email'), pdf = records.filter(r => r.suite === 'pdf');
  const scoredEmail = email.filter(r => r.outcome === 'pass' || r.outcome === 'fail' || r.outcome === 'error');
  const perCheck = Object.fromEntries(['intent', 'route', 'requiredFlags', 'lines', 'customer', 'overall'].map(k => [k, { passed: scoredEmail.filter(r => r.fields[k] === true).length, denominator: scoredEmail.length }]));
  const scoredPdf = pdf.filter(r => r.outcome !== 'skipped');
  const keys = ['sku', 'quantity', 'unit', 'quotedUnitPrice', 'exactLines', 'sourcePageEvidence', 'actualLineEvidence'];
  const pdfFields = Object.fromEntries(keys.map(k => [k, { passed: scoredPdf.reduce((n, r) => n + ((r.fields.counts as any)?.[k]?.passed ?? 0), 0), denominator: scoredPdf.reduce((n, r) => n + ((r.fields.counts as any)?.[k]?.denominator ?? 0), 0) }]));
  const billed = records.filter(r => r.costUsd !== null);
  const lat = billed.map(r => r.apiLatencyMs as number);
  const sum = (xs: (number | null)[]) => xs.reduce<number>((a, b) => a + (b ?? 0), 0);
  const summary = {
    label: 'LIVE MODEL RESULTS (real API calls). Not the offline MockProvider; fixtures are synthetic and visible, not a holdout.',
    provider, model, pricing: { inputUsdPerMillion: Number(inRate), outputUsdPerMillion: Number(outRate), source: price.source },
    budgetUsd: budget, stoppedEarly: stop, cases: tasks.length, attempted: records.filter(r => r.outcome !== 'skipped').length, skipped: records.filter(r => r.outcome === 'skipped').length,
    modelOrScoringErrors: records.filter(r => r.outcome === 'error').length,
    email: { scored: scoredEmail.length, diagnosticUnsupportedSetup: email.filter(r => r.outcome === 'diagnostic').length, perCheck },
    pdf: { scored: scoredPdf.length, exactCases: pdf.filter(r => r.outcome === 'pass').length, fieldCounts: pdfFields },
    latencyMs: { p50: pct(lat, 0.5), p95: pct(lat, 0.95) },
    tokens: { input: sum(billed.map(r => r.inputTokens)), output: sum(billed.map(r => r.outputTokens)) },
    costUsd: { totalMeasured: Math.round(sum(billed.map(r => r.costUsd)) * 1e6) / 1e6, guardSpend: Math.round(spent * 1e6) / 1e6, perCase: billed.length ? sum(billed.map(r => r.costUsd)) / billed.length : null },
  };
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(ROOT, 'results/live'); await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, `run-${stamp}.json`), JSON.stringify({ schemaVersion: 1, createdAt: startedAt.toISOString(), summary, records }, null, 2) + '\n');
  const row = (k: string, v: { passed: number; denominator: number }) => `| ${k} | ${v.passed}/${v.denominator} | ${v.denominator ? ((v.passed / v.denominator) * 100).toFixed(1) + '%' : 'n/a'} |`;
  const failures = records.filter(r => r.outcome === 'fail' || r.outcome === 'error');
  const md = [`# Live AI benchmark - ${provider} / ${model}`, '', `**${summary.label}**`, '', `Run: ${startedAt.toISOString()}`,
    `Cases: ${summary.cases}; attempted ${summary.attempted}; skipped ${summary.skipped}${stop ? ` (stopped: ${stop})` : ''}; model/scoring errors ${summary.modelOrScoringErrors} (counted as failures).`, '',
    '## Email accuracy by check (scored cases; unsupported-setup cases excluded as diagnostic)', '| Check | Passed | Rate |', '|---|---|---|', ...Object.entries(perCheck).map(([k, v]) => row(k, v)), '',
    '## PDF accuracy by field (line-level)', '| Field | Passed | Rate |', '|---|---|---|', ...Object.entries(pdfFields).map(([k, v]) => row(k, v)),
    '', `PDF cases with all lines exact and page-backed: ${summary.pdf.exactCases}/${summary.pdf.scored}.`, '',
    '## Latency and cost', `- API latency p50 / p95: ${summary.latencyMs.p50 ?? 'n/a'} / ${summary.latencyMs.p95 ?? 'n/a'} ms`,
    `- Tokens: ${summary.tokens.input.toLocaleString()} in / ${summary.tokens.output.toLocaleString()} out`,
    `- Total cost: $${summary.costUsd.totalMeasured.toFixed(4)} (budget guard counted $${summary.costUsd.guardSpend.toFixed(4)} of $${budget.toFixed(2)}); per order: $${summary.costUsd.perCase === null ? 'n/a' : summary.costUsd.perCase.toFixed(5)}`,
    `- Pricing: $${inRate} in / $${outRate} out per 1M tokens (${price.source})`, '',
    `## Failures (${failures.length})`, ...(failures.length ? failures.map(r => `- ${r.suite} ${r.id}: ${r.outcome === 'error' ? `error - ${r.error}` : r.suite === 'email' ? 'failed ' + Object.entries(r.fields).filter(([k, v]) => v === false && k !== 'overall').map(([k]) => k).join(', ') : 'lines or page evidence mismatch'}`) : ['- none']),
    '', 'Scoring is the same as scripts/evaluate.ts and scripts/evaluate_pdfs.ts (production parseInput and domain validate; expected labels are used only after extraction). Synthetic visible fixtures; not a production accuracy estimate.'];
  await writeFile(path.join(outDir, `run-${stamp}.md`), md.join('\n') + '\n');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Wrote results/live/run-${stamp}.json and .md`);
}

main().catch(e => { console.error(redact(e instanceof Error ? e.message : String(e))); process.exitCode = 1; });
