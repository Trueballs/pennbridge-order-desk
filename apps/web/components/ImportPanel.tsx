"use client";
import { ChangeEvent, useCallback, useEffect, useState } from "react";
import { ArrowDownToLine, Check, Eye, LoaderCircle } from "lucide-react";
import { dateTime, message, request } from "./api";
import { EmptyState, FormError, InlineError } from "./ui";

type Issue = { row: number; column: string | null; message: string };
type Result = { kind: string; dryRun: boolean; applied: boolean; batchId: string | null; totalRows: number; validRows: number; errorRows: number; errors: Issue[]; warnings: Issue[]; errorsTruncated: boolean; counts: Record<string, number>; bumpsCatalogueVersion: boolean; newCatalogueVersion: string | null; sample: { row: number; key: string; action: string; changedFields?: string[] }[] };
type Template = { kind: string; required: string[]; optional: string[] };
type Batch = { id: string; kind: string; filename: string | null; createdBy: string; createdAt: string; totalRows: number; created: number; updated: number; unchanged: number; deleted: number };
const LABELS: Record<string, string> = { products: "Products", customers: "Customers", addresses: "Delivery addresses", price_agreements: "Price agreements", aliases: "Customer product aliases", stock: "Stock levels", sender_mappings: "Sender mappings" };

export function ImportPanel({ toast, onApplied }: { toast: (text: string) => void; onApplied: () => void }) {
  const [templates, setTemplates] = useState<Template[]>([]); const [kind, setKind] = useState("products"); const [csv, setCsv] = useState(""); const [filename, setFilename] = useState("");
  const [result, setResult] = useState<Result | null>(null); const [busy, setBusy] = useState(""); const [error, setError] = useState("");
  const [batches, setBatches] = useState<Batch[] | null>(null); const [batchError, setBatchError] = useState("");
  const loadBatches = useCallback(() => request<{ batches: Batch[] }>("/api/admin/import/batches").then(d => { setBatches(d.batches); setBatchError(""); }).catch(e => setBatchError(message(e))), []);
  useEffect(() => { void loadBatches(); request<{ kinds: Template[] }>("/api/admin/import/templates").then(d => setTemplates(d.kinds)).catch(() => setTemplates([])); }, [loadBatches]);
  const template = templates.find(t => t.kind === kind);
  async function pick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; setResult(null); setError("");
    if (!file) { setCsv(""); setFilename(""); return; }
    if (file.size > 12_000_000) { setError("This file is larger than 12 MB. Split it into smaller files."); return; }
    setCsv(await file.text()); setFilename(file.name);
  }
  async function run(mode: "preview" | "apply") {
    setBusy(mode); setError("");
    try {
      const response = await fetch(`/api/admin/import/${mode}`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, csv, filename }) });
      const data = await response.json().catch(() => null);
      if (!response.ok && !data?.errors) throw new Error(data?.error?.message ?? `${response.status} ${response.statusText}`);
      setResult(data as Result);
      if (mode === "apply" && data.applied) { toast(`Import applied: ${data.counts.create} created, ${data.counts.update} updated.`); void loadBatches(); onApplied(); }
      if (mode === "apply" && !data.applied) setError("Nothing was imported because some rows have errors. Fix the file and run the preview again.");
    } catch (e) { setError(message(e)); } finally { setBusy(""); }
  }
  const canApply = !!result && result.dryRun && result.errorRows === 0 && result.totalRows > 0;
  return <div className="settings-stack">
    <section className="panel settings-panel" aria-label="Data import">
      <div className="panel-head"><div><h2>Data import</h2><p>Load products, customers, prices and more from CSV. Always preview first; nothing changes until you apply.</p></div></div>
      <div className="import-form">
        <label>What are you importing?<select value={kind} onChange={e => { setKind(e.target.value); setResult(null); setError(""); }}>{Object.entries(LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <label>CSV file<input type="file" accept=".csv,text/csv" onChange={e => void pick(e)} /></label>
        <a className="button secondary small" href={`/api/admin/import/templates/${kind}`} download><ArrowDownToLine size={14} /> Download template</a>
      </div>
      {template && <p className="template-cols"><strong>Required columns:</strong> {template.required.join(", ")}. <strong>Optional:</strong> {template.optional.length ? template.optional.join(", ") : "none"}. Import in this order: products, customers, addresses, price agreements, aliases, stock, sender mappings.</p>}
      <div className="settings-pad"><FormError text={error} /></div>
      <div className="import-actions"><button className="button secondary" disabled={!csv || busy !== ""} onClick={() => void run("preview")}>{busy === "preview" ? <LoaderCircle size={15} className="spin" /> : <Eye size={15} />} Preview (dry run)</button><button className="button primary" disabled={!canApply || busy !== ""} onClick={() => void run("apply")}>{busy === "apply" ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />} Apply import</button>{filename && <span className="muted">{filename}</span>}</div>
      {result && <div className="import-result" aria-live="polite">
        <h3>{result.applied ? "Import applied" : result.dryRun ? "Preview — nothing has been changed" : "Import not applied"}</h3>
        <div className="count-row">{[["Rows", result.totalRows], ["Valid", result.validRows], ["With errors", result.errorRows], ["To create", result.counts.create], ["To update", result.counts.update], ["Unchanged", result.counts.unchanged], ["To delete", result.counts.delete]].map(([l, v]) => <div key={l as string} className={`count ${l === "With errors" && Number(v) > 0 ? "bad" : ""}`}><strong>{v}</strong><span>{l}</span></div>)}</div>
        {result.errorRows > 0 && <p className="import-hint">An import with any error writes nothing. Fix the rows below (row 1 is the header) and choose the file again.</p>}
        {result.bumpsCatalogueVersion && <p className="import-hint">This changes the catalogue, so approved orders that are not yet exported will need revalidating.</p>}
        {result.errors.length > 0 && <div className="table-scroll"><table className="order-table settings-table errors-table"><caption>Errors{result.errorsTruncated ? " (first 500 shown)" : ""}</caption><thead><tr><th>ROW</th><th>COLUMN</th><th>PROBLEM</th></tr></thead><tbody>{result.errors.map((e, i) => <tr key={i}><td>{e.row}</td><td>{e.column ?? "—"}</td><td>{e.message}</td></tr>)}</tbody></table></div>}
        {result.warnings.length > 0 && <div className="table-scroll"><table className="order-table settings-table"><caption>Warnings</caption><thead><tr><th>ROW</th><th>COLUMN</th><th>NOTE</th></tr></thead><tbody>{result.warnings.map((e, i) => <tr key={i}><td>{e.row}</td><td>{e.column ?? "—"}</td><td>{e.message}</td></tr>)}</tbody></table></div>}
        {result.sample.length > 0 && <div className="table-scroll"><table className="order-table settings-table"><caption>Sample of changes</caption><thead><tr><th>ROW</th><th>RECORD</th><th>ACTION</th><th>CHANGED</th></tr></thead><tbody>{result.sample.map(s => <tr key={s.row}><td>{s.row}</td><td>{s.key}</td><td className="cap">{s.action}</td><td>{s.changedFields?.join(", ") ?? ""}</td></tr>)}</tbody></table></div>}
      </div>}
    </section>
    <section className="panel settings-panel" aria-label="Import history">
      <div className="panel-head"><div><h2>Import history</h2><p>Every applied import, newest first</p></div></div>
      {batchError ? <InlineError text={batchError} onRetry={() => void loadBatches()} /> : !batches ? <EmptyState loading title="Loading history" text="Fetching import batches…" /> : batches.length === 0 ? <EmptyState title="No imports yet" text="Applied imports will be listed here." /> :
        <div className="table-scroll"><table className="order-table settings-table"><thead><tr><th>WHEN</th><th>FILE</th><th>TYPE</th><th>ROWS</th><th>CREATED</th><th>UPDATED</th><th>BY</th></tr></thead><tbody>{batches.map(b => <tr key={b.id}><td>{dateTime(b.createdAt)}</td><td>{b.filename ?? "—"}</td><td>{LABELS[b.kind] ?? b.kind}</td><td>{b.totalRows}</td><td>{b.created}</td><td>{b.updated}</td><td>{b.createdBy}</td></tr>)}</tbody></table></div>}
    </section>
  </div>;
}
