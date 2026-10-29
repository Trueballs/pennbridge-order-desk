"use client";
import { useState } from "react";
import { ArrowDownToLine, Check, ExternalLink, LoaderCircle, Send } from "lucide-react";
import type { ExportSnapshot } from "@pennbridge/contracts";
import { ApiError, dateTime, message, post } from "./api";
import { StatusPill } from "./ui";
import { VoidDialog } from "./OrderDialogs";

const STEPS = ["Prepared", "Downloaded", "Verified"] as const;
function stepIndex(item: ExportSnapshot) { return ["import_verified", "pushed"].includes(item.state) ? 3 : item.state === "downloaded" || item.state === "push_queued" ? 2 : 1; }

function ExportItem({ orderId, item, isReviewer, onChanged, toast }: { orderId: string; item: ExportSnapshot; isReviewer: boolean; onChanged: () => void; toast: (text: string) => void }) {
  const [reference, setReference] = useState(""); const [busy, setBusy] = useState(""); const [error, setError] = useState(""); const [voiding, setVoiding] = useState(false); const [pushMissing, setPushMissing] = useState(false);
  const base = `/api/orders/${encodeURIComponent(orderId)}/exports/${encodeURIComponent(item.id)}`;
  const done = stepIndex(item); const voided = item.state === "voided";
  const canVerify = isReviewer && item.state === "downloaded";
  const canVoid = isReviewer && ["prepared", "downloaded"].includes(item.state);
  const canPush = isReviewer && !pushMissing && ["prepared", "downloaded"].includes(item.state);
  const quote = item.odooQuotation;
  async function verify() { setBusy("verify"); setError(""); try { await post(`${base}/verify`, { quotationReference: reference.trim() }); toast("Import check recorded."); onChanged(); } catch (e) { setError(message(e)); } finally { setBusy(""); } }
  async function push() {
    setBusy("push"); setError("");
    try { await post(`${base}/push-odoo`, {}); toast("Sent to Odoo. The quotation will appear here when it is created."); onChanged(); }
    catch (e) { if (e instanceof ApiError && e.status === 404) { setPushMissing(true); setError("Sending to Odoo is not available on this installation. Download the file and import it instead."); } else setError(message(e)); }
    finally { setBusy(""); }
  }
  return <div className="export-item">
    <div className="export-top"><strong>{item.filename}</strong><StatusPill status={item.state} /><span className="export-total">{item.lines.length} line{item.lines.length === 1 ? "" : "s"} · £{item.total}</span>{!voided && <a className="text-button" href={`${base}/download`}>Download <ArrowDownToLine size={13} /></a>}</div>
    <ol className={`stepper ${voided ? "is-voided" : ""}`} aria-label="Export progress">{STEPS.map((step, index) => <li key={step} className={!voided && index < done ? "done" : !voided && index === done ? "current" : ""}><span className="step-dot">{!voided && index < done ? <Check size={10} /> : index + 1}</span>{step}</li>)}{voided && <li className="voided-step">Voided</li>}</ol>
    <p className="export-facts">Prepared {dateTime(item.preparedAt)}{item.downloadedAt ? ` · downloaded ${dateTime(item.downloadedAt)}` : ""}{item.verifiedAt ? ` · verified ${dateTime(item.verifiedAt)}` : ""}{item.quotationReference ? ` · quotation ${item.quotationReference}` : ""}</p>
    {voided && <p className="export-facts">Voided {dateTime(item.voidedAt)}: {item.voidReason}</p>}
    {quote && <p className="odoo-quote">Odoo quotation <strong>{quote.name}</strong>{quote.url && <a className="text-button" href={quote.url} target="_blank" rel="noreferrer">Open in Odoo <ExternalLink size={12} /></a>}</p>}
    {item.pushState === "queued" || item.state === "push_queued" ? <p className="export-facts"><LoaderCircle size={11} className="spin" /> Waiting for the background worker to create the quotation in Odoo…</p> : null}
    {item.pushState === "failed" && <p className="export-problem" role="alert">Sending to Odoo failed: {item.pushError ?? "unknown error"}. You can try again or import the file by hand.</p>}
    {(canVerify || canVoid || canPush) && <div className="export-actions">
      {canVerify && <form className="verify-form" onSubmit={event => { event.preventDefault(); void verify(); }}><label>Odoo quotation you checked<input value={reference} onChange={e => setReference(e.target.value)} placeholder="e.g. S00006" required maxLength={200} /></label><button className="button secondary small" disabled={busy !== "" || !reference.trim()}>{busy === "verify" && <LoaderCircle size={13} className="spin" />} Record manual verification</button></form>}
      {canVerify && <small>Check the customer, delivery address, products, quantities and prices in Odoo first. This records your check; it does not contact Odoo.</small>}
      <div className="export-buttons">{canPush && <button className="button secondary small" onClick={() => void push()} disabled={busy !== ""}>{busy === "push" ? <LoaderCircle size={13} className="spin" /> : <Send size={13} />} Send to Odoo</button>}{canVoid && <button className="button ghost small danger-text" onClick={() => setVoiding(true)}>Void export…</button>}</div>
    </div>}
    {error && <p className="export-problem" role="alert">{error}</p>}
    {voiding && <VoidDialog orderId={orderId} exportId={item.id} filename={item.filename} onClose={() => setVoiding(false)} onDone={() => { setVoiding(false); toast("Export voided. The order can be exported again."); onChanged(); }} />}
  </div>;
}

export function ExportPanel({ orderId, exports, isReviewer, onChanged, toast }: { orderId: string; exports: ExportSnapshot[]; isReviewer: boolean; onChanged: () => void; toast: (text: string) => void }) {
  if (!exports.length) return null;
  return <section className="export-history" aria-label="Exports"><div className="column-title"><strong><ArrowDownToLine size={15} /> Exports</strong><span>{exports.length} file{exports.length === 1 ? "" : "s"}</span></div>{exports.map(item => <ExportItem key={item.id} orderId={orderId} item={item} isReviewer={isReviewer} onChanged={onChanged} toast={toast} />)}<p className="muted-note">A downloaded file is not a verified Odoo import until someone has checked the quotation in Odoo.</p></section>;
}
