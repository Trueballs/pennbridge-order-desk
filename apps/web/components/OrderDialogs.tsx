"use client";
import { FormEvent, useEffect, useState } from "react";
import { LoaderCircle, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import type { OrderDetail, Product, ValidatedDraft } from "@pennbridge/contracts";
import { message, money, post, request } from "./api";
import { Dialog, FormError } from "./ui";

const UNITS = ["each", "pack", "box", "pair", "roll", "metre", "litre", "kg"] as const;
type Done = (detail: OrderDetail, note: string) => void;

export function AddLineDialog({ order, onClose, onDone }: { order: ValidatedDraft; onClose: () => void; onDone: Done }) {
  const [q, setQ] = useState(""); const [results, setResults] = useState<Product[]>([]); const [product, setProduct] = useState<Product | null>(null);
  const [sku, setSku] = useState(""); const [description, setDescription] = useState(""); const [quantity, setQuantity] = useState("1"); const [unit, setUnit] = useState<string>("each");
  const [price, setPrice] = useState(""); const [reason, setReason] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return; }
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ q }); if (order.customerId) params.set("customerId", order.customerId);
      request<{ products: Product[] }>(`/api/catalogue?${params}`).then(data => setResults(data.products.slice(0, 6))).catch(() => setResults([]));
    }, 250); return () => window.clearTimeout(timer);
  }, [q, order.customerId]);
  function pick(item: Product) { setProduct(item); setResults([]); setQ(""); setDescription(item.description); setUnit(item.sellingUnit); setSku(item.sku); }
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const line = { productId: product?.id ?? null, sku: product ? null : sku.trim() || null, description: description.trim(), quantity: quantity.trim(), unit, quotedUnitPrice: price.trim() || null };
      onDone(await post<OrderDetail>(`/api/orders/${encodeURIComponent(order.id)}/lines`, { expectedVersion: order.version, line, reason: reason.trim() }), "Line added and the order revalidated. Approval, if any, was withdrawn.");
    } catch (e) { setError(message(e)); setBusy(false); }
  }
  return <Dialog title="Add order line" eyebrow="MANUAL ENTRY" intro="Add a line that is missing from the extracted draft. The reason is kept in the audit trail." onClose={onClose} busy={busy}>
    <form className="form-grid" onSubmit={submit}>
      <label className="span-2">Find in catalogue<div className="searchbox wide"><Search size={14} /><input value={q} onChange={e => setQ(e.target.value)} placeholder="SKU, reference or description…" /></div></label>
      {results.length > 0 && <div className="candidate-list span-2" role="listbox" aria-label="Catalogue results">{results.map(item => <button type="button" key={item.id} onClick={() => pick(item)}><strong>{item.sku}</strong><span>{item.description}</span><small>{money(item.listPrice)} · {item.sellingUnit}</small></button>)}</div>}
      {product && <div className="chosen-product span-2"><strong>{product.sku}</strong> selected from the catalogue <button type="button" className="text-button" onClick={() => { setProduct(null); setSku(""); }}>Clear</button></div>}
      {!product && <label>SKU (if not in the catalogue search)<input value={sku} onChange={e => setSku(e.target.value)} maxLength={200} /></label>}
      <label className={product ? "span-2" : ""}>Description<input value={description} onChange={e => setDescription(e.target.value)} required maxLength={4000} /></label>
      <label>Quantity<input value={quantity} onChange={e => setQuantity(e.target.value)} inputMode="decimal" pattern="(0|[1-9][0-9]*)(\.[0-9]{1,6})?" title="A positive number" required /></label>
      <label>Unit<select value={unit} onChange={e => setUnit(e.target.value)}>{UNITS.map(u => <option key={u}>{u}</option>)}</select></label>
      <label>Quoted unit price (optional)<input value={price} onChange={e => setPrice(e.target.value)} placeholder="0.00" pattern="(0|[1-9][0-9]*)\.[0-9]{2}" title="Price with two decimals, e.g. 12.50" /></label>
      <label className="span-2">Reason for adding this line<textarea value={reason} onChange={e => setReason(e.target.value)} rows={2} required maxLength={2000} placeholder="e.g. Customer confirmed this extra item by phone" /></label>
      <div className="span-2"><FormError text={error} /></div>
      <div className="modal-actions span-2"><button type="button" className="button secondary" onClick={onClose} disabled={busy}>Cancel</button><button className="button primary" disabled={busy || !reason.trim() || !description.trim() || !quantity.trim()}>{busy ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />} Add line</button></div>
    </form></Dialog>;
}

export function RemoveLineDialog({ order, lineId, label, onClose, onDone }: { order: ValidatedDraft; lineId: string; label: string; onClose: () => void; onDone: Done }) {
  const [reason, setReason] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try { onDone(await post<OrderDetail>(`/api/orders/${encodeURIComponent(order.id)}/lines/${encodeURIComponent(lineId)}/remove`, { expectedVersion: order.version, reason: reason.trim() }), "Line removed. It stays visible under removed lines with your reason."); }
    catch (e) { setError(message(e)); setBusy(false); }
  }
  return <Dialog title="Remove order line" eyebrow="AUDITED CHANGE" intro={`Remove ${label} from this order. This withdraws any approval and is recorded with your reason.`} onClose={onClose} busy={busy}>
    <form className="form-grid" onSubmit={submit}><label className="span-2">Reason for removal<textarea value={reason} onChange={e => setReason(e.target.value)} rows={3} required maxLength={2000} placeholder="e.g. Duplicate of line 2 in the customer's attachment" /></label>
      <div className="span-2"><FormError text={error} /></div>
      <div className="modal-actions span-2"><button type="button" className="button secondary" onClick={onClose} disabled={busy}>Cancel</button><button className="button danger" disabled={busy || !reason.trim()}>{busy ? <LoaderCircle size={15} className="spin" /> : <Trash2 size={15} />} Remove line</button></div></form></Dialog>;
}

export function ReprocessDialog({ order, used, onClose, onDone }: { order: ValidatedDraft; used: number; onClose: () => void; onDone: Done }) {
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true); setError("");
    try { onDone(await post<OrderDetail>(`/api/orders/${encodeURIComponent(order.id)}/reprocess`, { expectedVersion: order.version }), "Reprocessing started. The draft will refresh when extraction finishes."); }
    catch (e) { setError(message(e)); setBusy(false); }
  }
  return <Dialog title="Reprocess this order?" eyebrow="RE-RUN EXTRACTION" intro="The original email and attachments are read again and a new draft is built." onClose={onClose} busy={busy}>
    <div className="dialog-body"><ul className="plain-list"><li>Edits you made by hand, including added and removed lines, are replaced. They remain in the version history.</li><li>Any approval is withdrawn.</li><li>Each run uses extraction budget. Reviewers get a small number of runs per order; if the limit is reached an administrator can run it again.</li></ul><p className="muted-note">{used === 0 ? "This order has not been reprocessed before." : `This order has been reprocessed ${used} time${used === 1 ? "" : "s"}.`}</p><FormError text={error} /></div>
    <div className="modal-actions"><button className="button secondary" onClick={onClose} disabled={busy}>Cancel</button><button className="button primary" onClick={run} disabled={busy}>{busy ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />} Reprocess order</button></div></Dialog>;
}

export function VoidDialog({ orderId, exportId, filename, onClose, onDone }: { orderId: string; exportId: string; filename: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try { await post(`/api/orders/${encodeURIComponent(orderId)}/exports/${encodeURIComponent(exportId)}/void`, { reason: reason.trim() }); onDone(); }
    catch (e) { setError(message(e)); setBusy(false); }
  }
  return <Dialog title="Void this export?" eyebrow="EXPORT" intro={`${filename} will no longer be downloadable and the order returns to approved so it can be exported again. Use this only if the file was never imported.`} onClose={onClose} busy={busy}>
    <form className="form-grid" onSubmit={submit}><label className="span-2">Reason<textarea value={reason} onChange={e => setReason(e.target.value)} rows={3} required maxLength={2000} placeholder="e.g. Wrong file downloaded; import failed in Odoo" /></label><div className="span-2"><FormError text={error} /></div>
      <div className="modal-actions span-2"><button type="button" className="button secondary" onClick={onClose} disabled={busy}>Cancel</button><button className="button danger" disabled={busy || !reason.trim()}>{busy ? <LoaderCircle size={15} className="spin" /> : <Trash2 size={15} />} Void export</button></div></form></Dialog>;
}
