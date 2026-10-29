"use client";
import { useEffect, useMemo, useState } from "react";
import { AlertCircle, ArrowDownToLine, ArrowRight, Check, CheckCircle2, CircleHelp, FileText, History, LoaderCircle, PackageSearch, Plus, RefreshCw, Search, ShieldCheck, Sparkles, UserCheck, X } from "lucide-react";
import type { Address, AuditEvent, CandidateMatch, Customer, DraftLine, OrderDetail, Product, Session } from "@pennbridge/contracts";
import { date, message, money, post, request, statusLabel } from "./api";
import { InlineError, StatusPill } from "./ui";
import { AddLineDialog, ReprocessDialog, RemoveLineDialog } from "./OrderDialogs";
import { ExportPanel } from "./ExportPanel";

const REPROCESSABLE = ["failed", "needs_review", "draft_ready", "not_order", "amendment_review", "cancellation_review"];
const IN_PROGRESS = ["received", "parsing", "extracted", "validating"];
const key = (reason: { code: string; lineId: string | null }) => `${reason.code}\u001f${reason.lineId ?? ""}`;
const matchedOn = { email: "this exact sender address", domain: "the sender's email domain", approved_sender: "the customer's approved sender list" } as const;

export function OrderReview({ detail, busy, error, session, customers, addresses, pendingProduct, onPendingUsed, onDetail, onRefresh, onOpenCatalogue, toast }: {
  detail: OrderDetail | null; busy: boolean; error: string; session: Session; customers: Customer[]; addresses: Address[];
  pendingProduct: Product | null; onPendingUsed: () => void; onDetail: (detail: OrderDetail, note?: string) => void; onRefresh: () => void; onOpenCatalogue: () => void; toast: (text: string) => void;
}) {
  const isReviewer = session.role === "reviewer" || session.role === "admin";
  const [lines, setLines] = useState<DraftLine[]>([]); const [customer, setCustomer] = useState(""); const [address, setAddress] = useState(""); const [po, setPo] = useState("");
  const [resolutions, setResolutions] = useState<Record<string, string>>({});
  const [lineProducts, setLineProducts] = useState<Record<string, Product[]>>({}); const [searchingLine, setSearchingLine] = useState("");
  const [saving, setSaving] = useState(false); const [exportBusy, setExportBusy] = useState(false); const [confirming, setConfirming] = useState(false);
  const [dialog, setDialog] = useState<null | { kind: "add" } | { kind: "reprocess" } | { kind: "remove"; lineId: string; label: string }>(null);
  const [actionError, setActionError] = useState("");

  const reset = (d: OrderDetail) => {
    setLines(d.order.lines); setCustomer(d.order.customerId ?? ""); setAddress(d.order.shippingAddressId ?? ""); setPo(d.order.poNumber ?? ""); setActionError("");
    setResolutions(Object.fromEntries([...d.order.reasons, ...d.order.lines.flatMap(line => line.reasons)].filter(reason => reason.resolved).map(reason => [key(reason), reason.resolution ?? ""])));
  };
  useEffect(() => { if (detail) reset(detail); }, [detail]);
  useEffect(() => {
    if (!pendingProduct || !lines[0]) return;
    const p = pendingProduct; setLines(list => list.map((line, i) => i === 0 ? { ...line, productId: p.id, selectedSku: p.sku, description: p.description, unit: p.sellingUnit, normalizedUnit: p.sellingUnit } : line)); onPendingUsed();
  }, [pendingProduct]); // eslint-disable-line react-hooks/exhaustive-deps

  const allReasons = useMemo(() => detail ? [...detail.order.reasons, ...detail.order.lines.flatMap(line => line.reasons)] : [], [detail]);
  const blocking = allReasons.some(reason => reason.severity === "blocking" && !reason.resolved);
  const hasEdits = !!detail && (po !== (detail.order.poNumber ?? "") || customer !== (detail.order.customerId ?? "") || address !== (detail.order.shippingAddressId ?? "") || JSON.stringify(lines) !== JSON.stringify(detail.order.lines) || Object.entries(resolutions).some(([k, value]) => { const [code, lineId] = k.split("\u001f"); const old = allReasons.find(reason => reason.code === code && (reason.lineId ?? "") === lineId); return value.trim() && (!old?.resolved || old.resolution !== value); }));
  const visibleAddresses = addresses.filter(item => item.customerId === customer);

  if (busy && !detail) return <section className="panel review-panel review-empty"><LoaderCircle className="spin" size={23} /><span>Loading order review…</span></section>;
  if (error) return <section className="panel review-panel"><InlineError text={error} onRetry={onRefresh} /></section>;
  if (!detail) return <section className="panel review-panel review-empty"><FileText size={22} /><strong>Select an order to review</strong><span>Choose an order from the queue above to inspect its source, draft and history.</span></section>;

  const { order, source, documents, evidence, audit, exports } = detail;
  const approved = order.approval?.invalidatedAt === null;
  const suggestion = !order.customerId ? order.suggestedCustomer : null;
  const reprocessRuns = audit.filter(event => event.action === "order.reprocess_requested").length;
  const canReprocess = isReviewer && REPROCESSABLE.includes(order.status);
  const processing = IN_PROGRESS.includes(order.status);
  const failureText = [...order.reasons.filter(r => !r.resolved && r.severity === "blocking").map(r => r.message), ...detail.jobs.filter(j => j.errorMessage).slice(-1).map(j => j.errorMessage!)][0];
  const finished = (next: OrderDetail, note: string) => { setDialog(null); onDetail(next, note); };
  const guard = hasEdits ? "Save or discard your changes first" : undefined;

  async function run(label: string, fn: () => Promise<void>, set: (v: boolean) => void) { set(true); setActionError(""); try { await fn(); } catch (e) { setActionError(`${label}: ${message(e)}`); } finally { set(false); } }
  const confirmSuggestion = () => run("Customer was not confirmed", async () => onDetail(await post<OrderDetail>(`/api/orders/${encodeURIComponent(order.id)}/customer`, { expectedVersion: order.version, customerId: suggestion!.customerId }), `Customer confirmed: ${suggestion!.customerName}. Prices and addresses were re-checked.`), setConfirming);
  const save = () => run("Draft was not saved", async () => {
    const reasonResolutions = Object.entries(resolutions).flatMap(([k, resolution]) => { const [code, lineId] = k.split("\u001f"); return resolution.trim() ? [{ code, lineId: lineId || null, resolution: resolution.trim() }] : []; });
    onDetail(await request<OrderDetail>(`/api/orders/${encodeURIComponent(order.id)}`, { method: "PATCH", body: JSON.stringify({ expectedVersion: order.version, patch: { customerId: customer || null, poNumber: po || null, shippingAddressId: address || null, lines: lines.map(line => ({ id: line.id, productId: line.productId, quantity: line.quantity, unit: line.unit, quotedUnitPrice: line.quotedUnitPrice, description: line.description })), reasonResolutions } }) }), "Draft saved. Review any updated validation warnings before approval.");
  }, setSaving);
  const approve = () => run("Approval failed", async () => onDetail(await post<OrderDetail>(`/api/orders/${encodeURIComponent(order.id)}/approve`, { expectedVersion: order.version, contentHash: order.contentHash }), "Order approved and recorded in the audit trail."), setSaving);
  const prepareExport = () => run("Export failed", async () => {
    const snapshot = await post<{ id: string; filename: string }>(`/api/orders/${encodeURIComponent(order.id)}/export`, { expectedVersion: order.version, idempotencyKey: `desk-${order.id}-v${order.version}` });
    const response = await fetch(`/api/orders/${encodeURIComponent(order.id)}/exports/${encodeURIComponent(snapshot.id)}/download`, { credentials: "same-origin" });
    if (!response.ok) { const data = await response.json().catch(() => null) as { error?: { message?: string } } | null; throw new Error(data?.error?.message ?? `Download failed (${response.status})`); }
    const href = URL.createObjectURL(await response.blob()); const anchor = document.createElement("a"); anchor.href = href; anchor.download = snapshot.filename ?? snapshot.id; anchor.click(); URL.revokeObjectURL(href);
    toast("Export prepared and downloaded. Import it in Odoo, then record your check below."); onRefresh();
  }, setExportBusy);
  async function lookup(line: DraftLine) {
    setSearchingLine(line.id);
    try { const params = new URLSearchParams({ q: line.description }); if (customer) params.set("customerId", customer); setLineProducts(prev => ({ ...prev, [line.id]: [] })); const result = await request<{ products: Product[] }>(`/api/catalogue?${params}`); setLineProducts(prev => ({ ...prev, [line.id]: result.products })); if (!result.products.length) toast("No catalogue products matched that description."); }
    catch (e) { toast(`Catalogue search failed: ${message(e)}`); } finally { setSearchingLine(""); }
  }
  function applyProduct(lineId: string, product: Product) { setLines(list => list.map(line => line.id === lineId ? { ...line, productId: product.id, selectedSku: product.sku, description: product.description, unit: product.sellingUnit, normalizedUnit: product.sellingUnit } : line)); setLineProducts(prev => ({ ...prev, [lineId]: [] })); }
  function selectCandidate(line: DraftLine, candidate: CandidateMatch) { setLines(list => list.map(item => item.id === line.id ? { ...item, productId: candidate.productId, selectedSku: candidate.sku, description: candidate.description, matchMethod: candidate.productId === line.productId ? line.matchMethod : "manual" } : item)); }
  const textDoc = documents.find(doc => doc.text);

  return <section className="panel review-panel" aria-label="Order review">
    <div className="review-head"><div><span className="eyebrow">ORDER REVIEW</span><h2>{order.poNumber || "Purchase order"}</h2><p>{order.customerName ?? "Customer unresolved"} <span>·</span> {order.id} <span>·</span> v{order.version}</p></div><div className="review-head-actions"><StatusPill status={order.status} />{order.processingMode === "mock" && <span className="tiny-mode"><Sparkles size={12} /> MOCK</span>}{order.processingMode === "manual" && <span className="tiny-mode">MANUAL</span>}{canReprocess && <button className="button secondary small" onClick={() => setDialog({ kind: "reprocess" })}><RefreshCw size={13} /> Reprocess</button>}</div></div>
    <div className="review-columns">
      <div className="source-column">
        <div className="column-title"><div><span className="eyebrow">SOURCE DOCUMENT</span><strong>{source.subject || documents[0]?.filename || "Order source"}</strong></div><span className={`source-channel ${source.channel}`}>{statusLabel(source.channel)}</span></div>
        <div className="source-meta"><span>From <strong>{source.sender ?? "Manual upload"}</strong></span><span>Received <strong>{date(source.receivedAt)}</strong></span></div>
        <div className="source-paper">{textDoc?.text ? <pre>{textDoc.text}</pre> : <div className="document-empty"><FileText size={21} /><strong>{documents[0]?.filename ?? "No source document"}</strong><span>Text preview is not available for this file type.</span>{documents[0] && <a href={`/api/documents/${encodeURIComponent(documents[0].id)}`} target="_blank" rel="noreferrer">Open protected source <ArrowRight size={13} /></a>}</div>}</div>
        {documents.filter(doc => doc.mediaType === "application/pdf").map(doc => <details key={doc.id} className="source-paper" open><summary>{doc.filename}</summary><a href={`/api/documents/${encodeURIComponent(doc.id)}`} target="_blank" rel="noreferrer">Open original PDF</a><pre>{doc.text || "No extractable text. Review the original."}</pre></details>)}
        {detail.modelUsage?.[0] && (u => <div className="evidence-note"><Sparkles size={15} /><span>Extraction: {u.provider} {u.model} · {(u.inputTokens + u.outputTokens).toLocaleString("en-GB")} tokens · ${u.costUsd ?? "n/a"} · {(u.latencyMs / 1000).toFixed(1)}s</span></div>)(detail.modelUsage[detail.modelUsage.length - 1])}
        <div className="evidence-note"><ShieldCheck size={15} /><span>{evidence.length} evidence reference{evidence.length === 1 ? "" : "s"} attached to this draft</span></div>
        <div className="audit-mini"><div className="column-title"><strong><History size={15} /> Recent decisions</strong><button className="text-button" onClick={() => document.getElementById("audit-section")?.scrollIntoView({ behavior: "smooth" })}>View history <ArrowRight size={13} /></button></div>{audit.slice(-3).reverse().map((event: AuditEvent) => <div className="audit-row" key={event.id}><span className="audit-marker" /><span><strong>{statusLabel(event.action)}</strong><small>{date(event.at)} · v{event.version ?? "—"}</small></span></div>)}</div>
      </div>
      <div className="draft-column">
        <div className="draft-toolbar"><div><span className="eyebrow">SALES ORDER DRAFT</span><strong>Review extracted details</strong></div><button className="text-button" onClick={onOpenCatalogue}><PackageSearch size={14} /> Browse catalogue</button></div>
        {processing && <div className="notice info" role="status"><LoaderCircle size={15} className="spin" /><div><strong>Extraction in progress</strong><p>This draft will refresh by itself when processing finishes.</p></div></div>}
        {suggestion && <div className="notice suggest" role="region" aria-label="Suggested customer"><UserCheck size={17} /><div><strong>Suggested: {suggestion.customerName}</strong><p>Matched on {matchedOn[suggestion.matchedOn]} ({suggestion.sender}). A sender address can be forged, so confirm this is the right customer before prices and addresses are applied.</p>{suggestion.note && <p className="notice-warn"><AlertCircle size={12} /> {suggestion.note}</p>}</div>{isReviewer && <button className="button primary small" onClick={() => void confirmSuggestion()} disabled={confirming || hasEdits} title={guard}>{confirming ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />} Confirm customer</button>}</div>}
        {actionError && <div className="inline-error" role="alert"><AlertCircle size={16} />{actionError}</div>}
        <div className="order-fields">
          <label>Customer<select value={customer} onChange={event => { setCustomer(event.target.value); setAddress(""); }} disabled={!isReviewer}><option value="">Select customer…</option>{customers.map(c => <option key={c.id} value={c.id}>{c.name}{c.onHold ? " · ON HOLD" : ""}</option>)}</select></label>
          <label>Purchase order<input value={po} onChange={event => setPo(event.target.value)} disabled={!isReviewer} placeholder="PO reference" /></label>
          <label className="address-field">Delivery address<select value={address} onChange={event => setAddress(event.target.value)} disabled={!isReviewer || !customer}><option value="">Select approved address…</option>{visibleAddresses.map(a => <option key={a.id} value={a.id}>{a.label} — {a.formatted}</option>)}</select></label>
          <label>Requested delivery<input type="date" value={order.requestedDeliveryDate ?? ""} disabled title="Delivery dates are part of the validated draft." readOnly /></label>
        </div>
        {allReasons.filter(reason => !reason.resolved || reason.severity !== "info").length > 0 && <div className="warning-stack">{allReasons.filter(reason => !reason.resolved || reason.severity !== "info").map((reason, index) => <div className={`warning-card ${reason.severity}`} key={`${reason.code}-${reason.lineId ?? "order"}-${index}`}><div className="warning-icon"><AlertCircle size={16} /></div><div className="warning-body"><div className="warning-heading"><strong>{statusLabel(reason.code)}</strong><span>{reason.resolved ? "ACKNOWLEDGED" : reason.severity === "blocking" ? "BLOCKING" : "REVIEW"}</span></div><p>{reason.message}</p>{reason.evidenceIds.length > 0 && <small>{reason.evidenceIds.length} linked source reference{reason.evidenceIds.length === 1 ? "" : "s"}</small>}{isReviewer && <label className="resolution-field">Reviewer note<textarea value={resolutions[key(reason)] ?? ""} onChange={event => setResolutions(prev => ({ ...prev, [key(reason)]: event.target.value }))} placeholder="Record what you checked or decided…" rows={2} /></label>}</div></div>)}</div>}
        <div className="lines-heading"><div><strong>Order lines</strong><span>{lines.length} line{lines.length === 1 ? "" : "s"}</span></div><button className="button ghost small" onClick={() => setDialog({ kind: "add" })} disabled={!isReviewer || hasEdits || processing} title={guard}><Plus size={14} /> Add line</button></div>
        {lines.length === 0 && !processing && <div className="manual-entry"><FileText size={22} /><strong>{order.status === "failed" ? "Automatic processing could not read this order" : "No order lines were found"}</strong>{failureText && <p className="manual-reason">{failureText}</p>}<p>You can still complete this order by hand:</p><ol><li>Read the source document on the left.</li><li>Choose the customer above and save.</li><li>Add each line with <em>Add line</em>, searching the catalogue so prices and units are checked.</li></ol><p>{canReprocess ? "Or reprocess to run extraction again on the original message." : "Only reviewers can enter lines."}</p>{isReviewer && <div className="manual-actions"><button className="button primary small" onClick={() => setDialog({ kind: "add" })} disabled={hasEdits}><Plus size={14} /> Enter first line</button>{canReprocess && <button className="button secondary small" onClick={() => setDialog({ kind: "reprocess" })}><RefreshCw size={14} /> Reprocess</button>}</div>}</div>}
        <div className="line-list">{lines.map((line, index) => <article className="line-card" key={line.id} aria-label={`Line ${index + 1}`}>
          <div className="line-card-head"><span className="line-number">{String(index + 1).padStart(2, "0")}</span><span className="line-source">{line.rawText || "Manually added line"}</span>{line.reasons.some(reason => !reason.resolved && reason.severity !== "info") && <span className="line-flag"><AlertCircle size={12} /> Review</span>}<button className="icon-button danger-subtle" aria-label={`Remove line ${index + 1}`} title={guard ?? "Remove this line"} disabled={!isReviewer || hasEdits || processing} onClick={() => setDialog({ kind: "remove", lineId: line.id, label: `line ${index + 1} (${line.selectedSku ?? line.sku ?? line.description.slice(0, 40)})` })}><X size={15} /></button></div>
          <div className="line-edit-grid"><div className="sku-field field"><span className="field-label">Catalogue product</span><div className="sku-input-row"><input aria-label={`Catalogue product for line ${index + 1}`} value={line.selectedSku ?? ""} placeholder="Choose a product" readOnly /><button className="button secondary small" onClick={() => void lookup(line)} disabled={!isReviewer || searchingLine === line.id}>{searchingLine === line.id ? <LoaderCircle size={14} className="spin" /> : <Search size={14} />} Find</button></div>
            {line.candidates.length > 0 && <div className="recorded-candidates"><span>Recorded matches</span>{line.candidates.map(candidate => <button key={candidate.productId} type="button" className={line.productId === candidate.productId ? "chosen" : ""} onClick={() => selectCandidate(line, candidate)} disabled={!isReviewer}><strong>{candidate.sku}</strong><span>{candidate.description}</span><small>{statusLabel(candidate.method)}{candidate.score === null ? "" : ` · ${Math.round(candidate.score * 100)}%`}</small></button>)}</div>}
            {(lineProducts[line.id]?.length ?? 0) > 0 && <div className="candidate-list">{lineProducts[line.id].map(product => <button key={product.id} onClick={() => applyProduct(line.id, product)}><strong>{product.sku}</strong><span>{product.description}</span><small>{money(product.listPrice)} · {product.sellingUnit}</small></button>)}</div>}
            <small>{line.matchMethod ? `${statusLabel(line.matchMethod)} · ${line.candidates.length} recorded candidate${line.candidates.length === 1 ? "" : "s"}` : line.productId ? "Manually selected catalogue product" : "No catalogue product selected"}</small></div>
            <label>Quantity<input type="number" min="0" step="0.000001" value={line.quantity ?? ""} disabled={!isReviewer} onChange={event => setLines(list => list.map(item => item.id === line.id ? { ...item, normalizedQuantity: event.target.value || null, quantity: event.target.value || null } : item))} /></label>
            <label>Unit<select value={line.unit ?? ""} disabled={!isReviewer} onChange={event => setLines(list => list.map(item => item.id === line.id ? { ...item, normalizedUnit: (event.target.value || null) as DraftLine["normalizedUnit"], unit: (event.target.value || null) as DraftLine["unit"] } : item))}><option value="">Select</option>{["each", "pack", "box", "pair", "roll", "metre", "litre", "kg"].map(unit => <option key={unit} value={unit}>{unit}</option>)}</select></label>
            <label>Unit price<input value={line.unitPrice ?? line.quotedUnitPrice ?? ""} disabled placeholder="Validated by account price" /></label></div>
          <div className="line-card-foot"><span>{line.evidenceIds.length ? `${line.evidenceIds.length} evidence link${line.evidenceIds.length === 1 ? "" : "s"}` : "No evidence linked"}</span><strong>Line total&nbsp; {money(line.lineTotal)}</strong></div></article>)}</div>
        {(order.removedLines?.length ?? 0) > 0 && <details className="removed-lines"><summary>{order.removedLines!.length} removed line{order.removedLines!.length === 1 ? "" : "s"}</summary>{order.removedLines!.map(item => <p key={item.id}><strong>{item.sku ?? item.description}</strong> {item.quantity ?? ""} {item.unit ?? ""} — removed {date(item.removedAt)}: {item.reason}</p>)}</details>}
        <div className="draft-total"><span>Order total <small>GBP · net</small></span><strong>{money(order.total)}</strong></div>
        {detail.historySuggestions && detail.historySuggestions.length > 0 && <section className="audit-section"><h3>Previous orders — confirm before using</h3><p>These are synthetic historical records for this customer. Quantities need confirmation; current prices are checked separately.</p>{detail.historySuggestions.map(item => <details key={item.historyId}><summary>{item.poNumber} · {item.orderedAt} · {item.historyId}</summary>{item.lines.map((line, index) => <p key={index}>{line.sku} — {line.quantity} {line.unit}</p>)}</details>)}</section>}
        <section className="audit-section" id="audit-section"><div className="column-title"><strong><History size={15} /> Version history &amp; audit</strong><span>{audit.length} event{audit.length === 1 ? "" : "s"}</span></div>{audit.length === 0 ? <span className="muted">No audit events recorded yet.</span> : audit.slice().reverse().map(event => <div className="full-audit-row" key={event.id}><div className="audit-event-mark" /><div><strong>{statusLabel(event.action)}</strong><span>{event.actorId} · {date(event.at)} · Version {event.version ?? "—"}</span></div><small>{event.detail && Object.entries(event.detail).slice(0, 2).map(([k, value]) => `${k}: ${String(value)}`).join(" · ")}</small></div>)}</section>
        <ExportPanel orderId={order.id} exports={exports} isReviewer={isReviewer} onChanged={onRefresh} toast={toast} />
        <div className="review-actions"><div className="approval-state">{approved ? <><CheckCircle2 size={17} /><span>Approved by {order.approval?.approvedBy} · {date(order.approval?.approvedAt)}</span></> : <><CircleHelp size={17} /><span>{order.approval ? "Approval is no longer current." : "Not yet approved"}</span></>}</div>
          <div className="action-buttons">{isReviewer && hasEdits && <button className="button ghost" onClick={() => reset(detail)} disabled={saving}>Discard</button>}{isReviewer && <button className="button secondary" onClick={() => void save()} disabled={!hasEdits || saving}>{saving ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />} Save changes</button>}{isReviewer && !approved && <button className="button primary" onClick={() => void approve()} disabled={saving || hasEdits || blocking || order.status !== "draft_ready"}>{saving ? <LoaderCircle size={15} className="spin" /> : <ShieldCheck size={15} />} Approve order</button>}{isReviewer && approved && <button className="button primary" onClick={() => void prepareExport()} disabled={exportBusy || order.status === "exported"}>{exportBusy ? <LoaderCircle size={15} className="spin" /> : <ArrowDownToLine size={15} />} Prepare export</button>}</div></div>
        <p className="action-hint">{hasEdits ? "Save your edits and review server validation before approving." : blocking ? "Resolve blocking issues and save your changes before approval." : approved ? "Approved snapshots can be exported once. Import and verify the file in the destination system." : "Approval is checked by the server against your role, order version and content."}</p>
      </div>
    </div>
    {dialog?.kind === "add" && <AddLineDialog order={order} onClose={() => setDialog(null)} onDone={finished} />}
    {dialog?.kind === "remove" && <RemoveLineDialog order={order} lineId={dialog.lineId} label={dialog.label} onClose={() => setDialog(null)} onDone={finished} />}
    {dialog?.kind === "reprocess" && <ReprocessDialog order={order} used={reprocessRuns} onClose={() => setDialog(null)} onDone={finished} />}
  </section>;
}
