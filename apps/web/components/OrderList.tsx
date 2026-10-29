"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, ChevronDown, Filter, LoaderCircle, Plus, RefreshCw, Search, UserRound, X } from "lucide-react";
import type { Customer, ValidatedDraft } from "@pennbridge/contracts";
import { date, message, request, statusLabel } from "./api";
import { EmptyState, InlineError, StatusPill } from "./ui";

type Page = { orders: ValidatedDraft[]; nextCursor: string | null };
const STATUSES = ["needs_review", "draft_ready", "parsing", "approved", "exported", "quarantined", "failed", "duplicate", "cancelled", "not_order"];
const PAGE = 25;

export function OrderList({ selectedId, onSelect, reloadKey, pollMs, customers, onAdd }: { selectedId: string; onSelect: (id: string) => void; reloadKey: number; pollMs: number; customers: Customer[]; onAdd: () => void }) {
  const [text, setText] = useState(""); const [q, setQ] = useState(""); const [status, setStatus] = useState(""); const [customerId, setCustomerId] = useState(""); const [dateFrom, setDateFrom] = useState(""); const [dateTo, setDateTo] = useState("");
  const [orders, setOrders] = useState<ValidatedDraft[]>([]); const [cursor, setCursor] = useState<string | null>(null); const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false); const [more, setMore] = useState(false); const [error, setError] = useState("");
  const pages = useRef(1); const seq = useRef(0); const selectedRef = useRef(selectedId); selectedRef.current = selectedId;
  useEffect(() => { const timer = window.setTimeout(() => setQ(text.trim()), 300); return () => window.clearTimeout(timer); }, [text]);
  const params = useCallback((after?: string | null) => { const p = new URLSearchParams({ limit: String(PAGE) }); if (q) p.set("q", q); if (status) p.set("status", status); if (customerId) p.set("customerId", customerId); if (dateFrom) p.set("dateFrom", dateFrom); if (dateTo) p.set("dateTo", dateTo); if (after) p.set("cursor", after); return p; }, [q, status, customerId, dateFrom, dateTo]);
  const filtered = !!(q || status || customerId || dateFrom || dateTo);

  const load = useCallback(async (mode: "reset" | "poll") => {
    const mine = ++seq.current; if (mode === "reset") { setBusy(true); setError(""); }
    try {
      const data = await request<Page>(`/api/orders?${params()}`); if (mine !== seq.current) return;
      if (mode === "reset" || pages.current === 1) { pages.current = 1; setOrders(data.orders); setCursor(data.nextCursor); }
      else setOrders(old => { const fresh = new Map(data.orders.map(o => [o.id, o])); const top = old[0]?.createdAt ?? ""; return [...data.orders.filter(o => !old.some(x => x.id === o.id) && o.createdAt > top), ...old.map(o => fresh.get(o.id) ?? o)]; });
      setLoaded(true); setError("");
      if (!selectedRef.current && data.orders[0]) onSelect(data.orders[0].id);
    } catch (e) { if (mine === seq.current && mode === "reset") setError(message(e)); }
    finally { if (mine === seq.current) setBusy(false); }
  }, [params, onSelect]);
  useEffect(() => { pages.current = 1; void load("reset"); }, [load, reloadKey]);
  useEffect(() => { const timer = window.setInterval(() => { void load("poll"); }, pollMs); return () => window.clearInterval(timer); }, [load, pollMs]);

  async function loadMore() {
    if (!cursor) return; setMore(true);
    try { const data = await request<Page>(`/api/orders?${params(cursor)}`); pages.current += 1; setOrders(old => [...old, ...data.orders.filter(o => !old.some(x => x.id === o.id))]); setCursor(data.nextCursor); }
    catch (e) { setError(message(e)); } finally { setMore(false); }
  }
  function clear() { setText(""); setQ(""); setStatus(""); setCustomerId(""); setDateFrom(""); setDateTo(""); }

  return <section className="panel inbox-panel" aria-label="Order queue">
    <div className="panel-head"><div><h2>Order queue</h2><p>Newest first · source, account and review state</p></div><div className="queue-controls">
      <div className="searchbox"><Search size={15} /><input aria-label="Search orders" placeholder="PO, customer, sender, SKU…" value={text} onChange={e => setText(e.target.value)} /></div>
      <div className="select-wrap"><Filter size={14} /><select aria-label="Filter by status" value={status} onChange={e => setStatus(e.target.value)}><option value="">All statuses</option>{STATUSES.map(s => <option key={s} value={s}>{statusLabel(s)}</option>)}</select><ChevronDown size={13} /></div>
      <div className="select-wrap"><UserRound size={14} /><select aria-label="Filter by customer" value={customerId} onChange={e => setCustomerId(e.target.value)}><option value="">All customers</option>{customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select><ChevronDown size={13} /></div>
      <button className="icon-button" aria-label="Refresh orders" onClick={() => void load("reset")}><RefreshCw size={16} className={busy ? "spin" : ""} /></button></div></div>
    <div className="filter-row"><label>From<input type="date" value={dateFrom} max={dateTo || undefined} onChange={e => setDateFrom(e.target.value)} /></label><label>To<input type="date" value={dateTo} min={dateFrom || undefined} onChange={e => setDateTo(e.target.value)} /></label>{filtered && <button className="text-button" onClick={clear}><X size={13} /> Clear filters</button>}</div>
    {error ? <InlineError text={error} onRetry={() => void load("reset")} /> : busy && !loaded ? <EmptyState loading title="Loading order queue" text="Fetching the latest orders from the local service." /> : orders.length === 0 ? <EmptyState title={filtered ? "No orders match" : "No orders to show"} text={filtered ? "Try a different search term, status, customer or date range." : "Upload a purchase order or wait for mail to arrive."} action={filtered ? <button className="button secondary small" onClick={clear}>Clear filters</button> : <button className="button secondary small" onClick={onAdd}><Plus size={15} /> Add an order</button>} /> :
      <div className="table-scroll"><table className="order-table"><thead><tr><th>ORDER / PO</th><th>CUSTOMER</th><th>LINES</th><th>RECEIVED</th><th>STATUS</th><th><span className="sr-only">Open</span></th></tr></thead><tbody>{orders.map(order => <tr key={order.id} className={selectedId === order.id ? "selected-row" : ""} onClick={() => onSelect(order.id)}><td><button className="row-link" onClick={e => { e.stopPropagation(); onSelect(order.id); }} aria-current={selectedId === order.id}><span className="order-primary">{order.poNumber || order.subject || "PO not identified"}</span><span className="order-secondary">{order.id}</span></button></td><td><div className="customer-cell"><span className="customer-icon"><UserRound size={15} /></span><span>{order.customerName ?? (order.suggestedCustomer ? `Suggested: ${order.suggestedCustomer.customerName}` : "Customer unresolved")}</span></div></td><td>{order.lines.length} <span className="muted">line{order.lines.length === 1 ? "" : "s"}</span></td><td>{date(order.createdAt)}</td><td><StatusPill status={order.status} /></td><td><ArrowRight size={16} className="row-chevron" /></td></tr>)}</tbody></table></div>}
    <div className="panel-foot"><span>{orders.length} order{orders.length === 1 ? "" : "s"} shown{cursor ? " · more available" : ""}</span>{cursor ? <button className="button secondary small" onClick={() => void loadMore()} disabled={more}>{more ? <LoaderCircle size={13} className="spin" /> : null} Load more</button> : <span className="pagination-note">{orders.length ? "End of list" : ""}</span>}</div>
  </section>;
}
