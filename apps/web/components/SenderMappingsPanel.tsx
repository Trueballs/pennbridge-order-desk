"use client";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { AlertCircle, LoaderCircle, Plus, ShieldAlert, Trash2 } from "lucide-react";
import type { Customer, SenderMapping } from "@pennbridge/contracts";
import { date, message, post, request } from "./api";
import { Dialog, EmptyState, FormError, InlineError } from "./ui";

export function SenderMappingsPanel({ customers, toast }: { customers: Customer[]; toast: (text: string) => void }) {
  const [rows, setRows] = useState<SenderMapping[] | null>(null); const [error, setError] = useState("");
  const [kind, setKind] = useState<"email" | "domain">("email"); const [value, setValue] = useState(""); const [customerId, setCustomerId] = useState(""); const [trusted, setTrusted] = useState(false);
  const [formError, setFormError] = useState(""); const [busy, setBusy] = useState(false); const [removing, setRemoving] = useState<SenderMapping | null>(null); const [removeBusy, setRemoveBusy] = useState(false);
  const load = useCallback(() => request<{ mappings: SenderMapping[] }>("/api/sender-mappings").then(d => { setRows(d.mappings); setError(""); }).catch(e => setError(message(e))), []);
  useEffect(() => { void load(); }, [load]);
  async function add(event: FormEvent) {
    event.preventDefault(); setBusy(true); setFormError("");
    try { await post("/api/sender-mappings", { kind, value: value.trim(), customerId, trusted }); setValue(""); setTrusted(false); toast("Sender mapping saved."); await load(); } catch (e) { setFormError(message(e)); } finally { setBusy(false); }
  }
  async function remove() {
    if (!removing) return; setRemoveBusy(true);
    try { await request(`/api/sender-mappings/${encodeURIComponent(removing.id)}`, { method: "DELETE", body: "{}" }); toast("Sender mapping deleted."); setRemoving(null); await load(); } catch (e) { toast(`Could not delete: ${message(e)}`); setRemoving(null); } finally { setRemoveBusy(false); }
  }
  return <section className="panel settings-panel" aria-label="Sender mappings">
    <div className="panel-head"><div><h2>Sender mappings</h2><p>Recognise which customer an incoming email belongs to</p></div></div>
    <div className="settings-note"><ShieldAlert size={16} /><div><strong>Suggested by default, trusted only on request.</strong> A mapping suggests the customer and a reviewer confirms it. Tick <em>Trusted</em> only for an address you control or know: the order is then assigned automatically, but only if the receiving mail server reports SPF/DKIM/DMARC as passed (a forged From address is otherwise treated as a suggestion). Public domains such as gmail.com cannot be trusted.</div></div>
    <form className="mapping-form" onSubmit={add}>
      <label>Match<select value={kind} onChange={e => setKind(e.target.value as "email" | "domain")}><option value="email">Email address</option><option value="domain">Whole domain</option></select></label>
      <label>{kind === "email" ? "Email address" : "Domain"}<input value={value} onChange={e => setValue(e.target.value)} placeholder={kind === "email" ? "buyer@customer.com" : "customer.com"} required /></label>
      <label>Customer<select value={customerId} onChange={e => setCustomerId(e.target.value)} required><option value="">Choose customer…</option>{customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <label className="check"><input type="checkbox" checked={trusted} onChange={e => setTrusted(e.target.checked)} /> Trusted</label>
      <button className="button primary small" disabled={busy || !value.trim() || !customerId}>{busy ? <LoaderCircle size={14} className="spin" /> : <Plus size={14} />} Add mapping</button>
    </form>
    {trusted && <div className="settings-note warn"><AlertCircle size={16} /><div>This mapping will assign the customer without review when SPF/DKIM pass. Make sure only this customer can send from this {kind === "email" ? "address" : "domain"}.</div></div>}
    {formError && <div className="settings-pad"><FormError text={formError} /></div>}
    {error ? <InlineError text={error} onRetry={() => void load()} /> : !rows ? <EmptyState loading title="Loading mappings" text="Fetching sender mappings…" /> : rows.length === 0 ? <EmptyState title="No sender mappings yet" text="Add an email address or domain above, or import a sender_mappings CSV." /> :
      <div className="table-scroll"><table className="order-table settings-table"><thead><tr><th>SENDER</th><th>CUSTOMER</th><th>MODE</th><th>ADDED</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{rows.map(m => <tr key={m.id}><td><div className="order-primary">{m.kind === "domain" ? `@${m.value}` : m.value}</div><div className="order-secondary">{m.kind}</div></td><td>{m.customerName ?? m.customerId}</td><td><span className={`status-pill ${m.trusted ? "amber" : "slate"}`}><span className="status-dot" />{m.trusted ? "trusted" : "suggest only"}</span></td><td>{date(m.createdAt)}</td><td><div className="row-actions"><button className="icon-button" aria-label={`Delete mapping ${m.value}`} onClick={() => setRemoving(m)}><Trash2 size={14} /></button></div></td></tr>)}</tbody></table></div>}
    {removing && <Dialog title="Delete this mapping?" eyebrow="SENDER MAPPINGS" intro={`${removing.kind === "domain" ? "@" : ""}${removing.value} will no longer suggest ${removing.customerName ?? "this customer"}. Orders already received are not changed.`} onClose={() => setRemoving(null)} busy={removeBusy}><div className="modal-actions"><button className="button secondary" onClick={() => setRemoving(null)} disabled={removeBusy}>Cancel</button><button className="button danger" onClick={() => void remove()} disabled={removeBusy}>{removeBusy && <LoaderCircle size={14} className="spin" />} Delete mapping</button></div></Dialog>}
  </section>;
}
