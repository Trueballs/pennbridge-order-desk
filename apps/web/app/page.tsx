"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity, AlertCircle, ArrowDownToLine, ArrowLeft, ArrowRight, Boxes, Check, CheckCircle2,
  ChevronDown, CircleHelp, Clock3, FileText, Filter, History, Inbox, LoaderCircle, LogOut,
  PackageSearch, Plus, RefreshCw, Search, ShieldCheck, Sparkles, Upload, UserRound, X,
} from "lucide-react";
import type { Address, AuditEvent, CandidateMatch, Customer, DraftLine, Job, OrderDetail, Product, Session, ValidatedDraft } from "@pennbridge/contracts";

type Area = "Inbox" | "Catalogue" | "Activity";
type ApiProblem = { error?: { code?: string; message?: string; issues?: Array<{ path: string; message: string }> } };
type DeskStats = { counts: Record<string, number>; totalOrders: number; catalogueCount: number; pendingJobs: number; mode: string; provider?: string; model?: string | null; modelCalls: number; modelUsage: number };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, credentials: "same-origin", headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers } });
  if (!response.ok) {
    const data = await response.json().catch(() => null) as ApiProblem | null;
    throw new Error(data?.error?.message ?? `${response.status} ${response.statusText}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function money(value: string | null | undefined) { return value ? `£${value}` : "—"; }
function date(value: string | null | undefined) { return value ? new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(value)) : "Not set"; }
function statusLabel(status: string) { return status.replaceAll("_", " "); }
function message(error: unknown) { return error instanceof Error ? error.message : "Something went wrong. Please try again."; }

export default function Home() {
  const [session, setSession] = useState<Session | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [loginError, setLoginError] = useState("");
  const [area, setArea] = useState<Area>("Inbox");
  const [orders, setOrders] = useState<ValidatedDraft[]>([]);
  const [listBusy, setListBusy] = useState(false);
  const [listError, setListError] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [query, setQuery] = useState("");
  const [toast, setToast] = useState("");
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [stats, setStats] = useState<DeskStats | null>(null);
  const [catalogue, setCatalogue] = useState<Product[]>([]);
  const [catalogueQuery, setCatalogueQuery] = useState("");
  const [activityError, setActivityError] = useState("");
  const [catalogueError, setCatalogueError] = useState("");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [uploadCustomer, setUploadCustomer] = useState("");
  const [sampleBusy, setSampleBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [workingLines, setWorkingLines] = useState<DraftLine[]>([]);
  const [workingCustomer, setWorkingCustomer] = useState("");
  const [workingAddress, setWorkingAddress] = useState("");
  const [workingPo, setWorkingPo] = useState("");
  const [resolutions, setResolutions] = useState<Record<string, string>>({});
  const [searchingLine, setSearchingLine] = useState("");
  const [lineProducts, setLineProducts] = useState<Record<string, Product[]>>({});
  const [exportBusy, setExportBusy] = useState(false);

  const refreshOrders = useCallback(async (status = statusFilter) => {
    setListBusy(true); setListError("");
    try {
      const params = new URLSearchParams({ limit: "100" }); if (status) params.set("status", status);
      const data = await request<{ orders: ValidatedDraft[]; nextCursor: string | null }>(`/api/orders?${params}`);
      setOrders(data.orders);
      if (!selectedId && data.orders[0]) setSelectedId(data.orders[0].id);
      if (selectedId && !data.orders.some(order => order.id === selectedId)) setSelectedId(data.orders[0]?.id ?? "");
    } catch (error) { setListError(message(error)); }
    finally { setListBusy(false); }
  }, [statusFilter, selectedId]);

  const refreshDetail = useCallback(async (id: string) => {
    if (!id) { setDetail(null); return; }
    setDetailBusy(true); setDetailError("");
    try { setDetail(await request<OrderDetail>(`/api/orders/${encodeURIComponent(id)}`)); }
    catch (error) { setDetail(null); setDetailError(message(error)); }
    finally { setDetailBusy(false); }
  }, []);

  useEffect(() => {
    request<Session>("/api/session").then(setSession).catch(() => setSession(null)).finally(() => setCheckingSession(false));
  }, []);
  useEffect(() => { if (session) { void refreshOrders(); request<DeskStats>("/api/stats").then(setStats).catch(error => setToast(`Could not load workspace stats: ${message(error)}`)); request<{ customers: Customer[]; addresses: Address[] }>("/api/customers").then(data => { setCustomers(data.customers); setAddresses(data.addresses); }).catch(error => setToast(`Could not load customers: ${message(error)}`)); } }, [session, refreshOrders]);
  useEffect(() => { if (selectedId && session) void refreshDetail(selectedId); }, [selectedId, session, refreshDetail]);
  useEffect(() => {
    if (!session) return;
    const poll = () => request<{ jobs: Job[] }>("/api/jobs").then(data => setJobs(data.jobs)).catch(error => setActivityError(message(error)));
    void poll(); const timer = window.setInterval(() => { void poll(); }, 8000); return () => window.clearInterval(timer);
  }, [session]);
  useEffect(() => {
    if (detail) { setWorkingLines(detail.order.lines); setWorkingCustomer(detail.order.customerId ?? ""); setWorkingAddress(detail.order.shippingAddressId ?? ""); setWorkingPo(detail.order.poNumber ?? ""); setResolutions(Object.fromEntries([...detail.order.reasons, ...detail.order.lines.flatMap(line => line.reasons)].filter(reason => reason.resolved).map(reason => [`${reason.code}\u001f${reason.lineId ?? ""}`, reason.resolution ?? ""]))); }
  }, [detail]);
  useEffect(() => {
    if (!session || area !== "Catalogue") return;
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ q: catalogueQuery }); if (workingCustomer) params.set("customerId", workingCustomer);
      request<{ products: Product[] }>(`/api/catalogue?${params}`).then(data => { setCatalogue(data.products); setCatalogueError(""); }).catch(error => { setCatalogue([]); setCatalogueError(message(error)); });
    }, 250); return () => window.clearTimeout(timer);
  }, [session, area, catalogueQuery, workingCustomer]);

  const filteredOrders = useMemo(() => orders.filter(order => `${order.customerName ?? ""} ${order.poNumber ?? ""} ${order.id}`.toLowerCase().includes(query.toLowerCase())), [orders, query]);
  const pendingCount = stats ? (stats.counts.needs_review ?? 0) + (stats.counts.draft_ready ?? 0) + (stats.counts.amendment_review ?? 0) + (stats.counts.cancellation_review ?? 0) : orders.filter(order => ["needs_review", "draft_ready", "amendment_review", "cancellation_review"].includes(order.status)).length;
  const activeJobs = Math.max(stats?.pendingJobs ?? 0, jobs.filter(job => ["queued", "running", "retry_wait"].includes(job.status)).length);
  useEffect(() => {
    if (!session || !selectedId || !detail || !["received", "parsing", "extracted", "validating"].includes(detail.order.status)) return;
    const timer=window.setInterval(() => { void refreshDetail(selectedId); void refreshOrders(); request<DeskStats>("/api/stats").then(setStats).catch(()=>{}); },2000);
    return () => window.clearInterval(timer);
  }, [session,selectedId,detail?.order.status,refreshDetail,refreshOrders]);
  const appMode = (stats?.mode ?? detail?.order.processingMode ?? "unknown").toUpperCase();
  const extractionBadge = stats?.mode === "live" ? `Extraction: ${stats.provider === "gemini" ? "Gemini" : "Claude"} live${stats.model ? ` (${stats.model})` : ""}` : stats?.mode === "mock" ? "Extraction: Mock" : `${appMode} MODE`;
  useEffect(() => {
    if (!session) return;
    const timer = window.setInterval(() => {
      void refreshOrders();
      request<DeskStats>("/api/stats").then(setStats).catch(error => setToast(`Could not refresh workspace stats: ${message(error)}`));
    }, activeJobs > 0 ? 6000 : 15000);
    return () => window.clearInterval(timer);
  }, [session, activeJobs, refreshOrders]);
  const isReviewer = session?.role === "reviewer" || session?.role === "admin";
  const visibleAddresses = addresses.filter(address => address.customerId === workingCustomer);
  const unresolvedBlocking = (detail ? [...detail.order.reasons, ...detail.order.lines.flatMap(line => line.reasons)] : []).some(reason => reason.severity === "blocking" && !reason.resolved) ?? false;
  const hasEdits = !!detail && (workingPo !== (detail.order.poNumber ?? "") || workingCustomer !== (detail.order.customerId ?? "") || workingAddress !== (detail.order.shippingAddressId ?? "") || JSON.stringify(workingLines) !== JSON.stringify(detail.order.lines) || Object.entries(resolutions).some(([key, value]) => { const [code, lineId] = key.split("\u001f"); const old = [...detail.order.reasons, ...detail.order.lines.flatMap(line => line.reasons)].find(reason => reason.code === code && (reason.lineId ?? "") === lineId); return value.trim() && (!old?.resolved || old.resolution !== value); }));

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setLoginError(""); const form = new FormData(event.currentTarget);
    try { const user = await request<Session>("/api/auth/login", { method: "POST", body: JSON.stringify({ email: form.get("email"), password: form.get("password") }) }); setSession(user); }
    catch (error) { setLoginError(message(error)); }
  }
  async function logout() { try { await request("/api/auth/logout", { method: "POST" }); } finally { setSession(null); setOrders([]); setSelectedId(""); setDetail(null); } }
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setUploadError(""); const form = event.currentTarget; const data = new FormData(form); const file = data.get("file");
    if (!(file instanceof File) || !file.size) { setUploadError("Choose an order document to continue."); return; }
    setUploadBusy(true);
    try {
      const contentBase64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1] ?? ""); reader.onerror = () => reject(new Error("The selected file could not be read.")); reader.readAsDataURL(file); });
      const result = await request<{ messageId: string; orderId: string | null; jobId: string | null; duplicate: boolean }>("/api/intake", { method: "POST", body: JSON.stringify({ filename: file.name, mediaType: file.type || "application/octet-stream", contentBase64, channel: "upload", trustedCustomerId: uploadCustomer || null }) });
      setUploadOpen(false); form.reset(); setToast(result.duplicate ? "This document was already received. Showing its existing order." : "Order received. Processing has started.");
      await refreshOrders(""); if (result.orderId) setSelectedId(result.orderId); setArea("Inbox");
    } catch (error) { setUploadError(message(error)); } finally { setUploadBusy(false); }
  }
  async function trySample() {
    setSampleBusy(true); setToast("");
    try { const result = await request<{ orderId?: string | null; jobId?: string | null; messageId?: string }>("/api/demo", { method: "POST", body: "{}" }); setToast("Synthetic sample order submitted. Processing mode is shown on the order."); await refreshOrders(""); if (result.orderId) setSelectedId(result.orderId); }
    catch (error) { setToast(`Sample could not be created: ${message(error)}`); }
    finally { setSampleBusy(false); }
  }
  async function lookupLine(line: DraftLine) {
    setSearchingLine(line.id);
    try { const params = new URLSearchParams({ q: line.description }); if (workingCustomer) params.set("customerId", workingCustomer); const result = await request<{ products: Product[] }>(`/api/catalogue?${params}`); setLineProducts(prev => ({ ...prev, [line.id]: result.products })); }
    catch (error) { setToast(`Catalogue search failed: ${message(error)}`); }
    finally { setSearchingLine(""); }
  }
  function applyProduct(lineId: string, product: Product) {
    setWorkingLines(lines => lines.map(line => line.id === lineId ? { ...line, productId: product.id, selectedSku: product.sku, description: product.description, unit: product.sellingUnit, normalizedUnit: product.sellingUnit } : line));
    setLineProducts(prev => ({ ...prev, [lineId]: [] }));
  }
  async function saveDraft() {
    if (!detail) return; setSaving(true); setToast("");
    try {
      const reasonResolutions = Object.entries(resolutions).flatMap(([key, resolution]) => { const [code, lineId] = key.split("\u001f"); return resolution.trim() ? [{ code, lineId: lineId || null, resolution: resolution.trim() }] : []; });
      const updated = await request<OrderDetail>(`/api/orders/${encodeURIComponent(detail.order.id)}`, { method: "PATCH", body: JSON.stringify({ expectedVersion: detail.order.version, patch: { customerId: workingCustomer || null, poNumber: workingPo || null, shippingAddressId: workingAddress || null, lines: workingLines.map(line => ({ id: line.id, productId: line.productId, quantity: line.quantity, unit: line.unit, quotedUnitPrice: line.quotedUnitPrice, description: line.description })), reasonResolutions } }) });
      setDetail(updated); setToast("Draft saved. Review any updated validation warnings before approval."); await refreshOrders("");
    } catch (error) { setToast(`Draft was not saved: ${message(error)}`); } finally { setSaving(false); }
  }
  async function approve() {
    if (!detail) return; setSaving(true); setToast("");
    try { const updated = await request<OrderDetail>(`/api/orders/${encodeURIComponent(detail.order.id)}/approve`, { method: "POST", body: JSON.stringify({ expectedVersion: detail.order.version, contentHash: detail.order.contentHash }) }); setDetail(updated); setToast("Order approved and recorded in the audit trail."); await refreshOrders(""); }
    catch (error) { setToast(`Approval failed: ${message(error)}`); }
    finally { setSaving(false); }
  }
  async function exportOrder() {
    if (!detail) return; setExportBusy(true); setToast("");
    try {
      const snapshot = await request<{ id: string; idempotencyKey: string }>(`/api/orders/${encodeURIComponent(detail.order.id)}/export`, { method: "POST", body: JSON.stringify({ expectedVersion: detail.order.version, idempotencyKey: `desk-${detail.order.id}-v${detail.order.version}` }) });
      const response = await fetch(`/api/orders/${encodeURIComponent(detail.order.id)}/exports/${encodeURIComponent(snapshot.id)}/download`, { credentials: "same-origin" });
      if (!response.ok) { const data = await response.json().catch(() => null) as ApiProblem | null; throw new Error(data?.error?.message ?? `Download failed (${response.status})`); }
      const blob = await response.blob(); const href = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = href; anchor.download = snapshot.id; anchor.click(); URL.revokeObjectURL(href);
      setToast("Approved export downloaded. Import it in the destination system and verify it there separately."); await refreshDetail(detail.order.id); await refreshOrders("");
    } catch (error) { setToast(`Export failed: ${message(error)}`); }
    finally { setExportBusy(false); }
  }
  async function retry(job: Job) {
    try { await request(`/api/jobs/${encodeURIComponent(job.id)}/retry`, { method: "POST" }); setToast("Retry queued."); const data = await request<{ jobs: Job[] }>("/api/jobs"); setJobs(data.jobs); }
    catch (error) { setToast(`Retry failed: ${message(error)}`); }
  }

  if (checkingSession) return <div className="boot"><LoaderCircle className="spin" size={20} /> Connecting to Pennbridge Order Desk…</div>;
  if (!session) return <main className="login-shell"><section className="login-art"><div className="brand-lockup"><div className="brand-mark"><Boxes size={21} /></div><span>Pennbridge</span><span className="brand-light">Order Desk</span></div><div className="login-copy"><span className="eyebrow light">OPERATIONS WORKSPACE</span><h1>Orders, checked<br />before they move.</h1><p>Turn purchase orders into clear, reviewable sales drafts with every source and decision close at hand.</p></div><div className="login-foot"><ShieldCheck size={15} /> Private local workspace <span>·</span> Synthetic data only</div><div className="art-grid" /></section><section className="login-panel"><div className="login-card"><span className="eyebrow">WELCOME BACK</span><h2>Sign in to your desk</h2><p className="muted">Use the seeded synthetic reviewer account.</p><form onSubmit={login} className="login-form"><label>Email address<input name="email" type="email" autoComplete="username" placeholder="reviewer@pennbridge.example" required /></label><label>Password<input name="password" type="password" autoComplete="current-password" placeholder="Enter your password" required /></label>{loginError && <div className="inline-error"><AlertCircle size={16} />{loginError}</div>}<button className="button primary full" type="submit">Sign in <ArrowRight size={16} /></button></form><div className="login-note"><CircleHelp size={16} /><span>Demo reviewer: <strong>reviewer@pennbridge.example</strong> · password <strong>reviewer-demo</strong></span></div></div><span className="login-copyright">Pennbridge Industrial Supplies · Internal use</span></section></main>;

  return <main className="app-shell">
    <aside className="sidebar">
      <div className="brand-lockup"><div className="brand-mark"><Boxes size={20} /></div><span>Pennbridge</span><span className="brand-light">Desk</span></div>
      <div className="workspace-label">WORKSPACE</div>
      <nav className="main-nav" aria-label="Main navigation">
        {(["Inbox", "Catalogue", "Activity"] as Area[]).map((item) => { const Icon = item === "Inbox" ? Inbox : item === "Catalogue" ? PackageSearch : Activity; return <button key={item} className={`nav-link ${area === item ? "active" : ""}`} onClick={() => setArea(item)}><Icon size={17} /><span>{item}</span>{item === "Inbox" && pendingCount > 0 && <small>{pendingCount}</small>}</button>; })}
      </nav>
      <div className="sidebar-spacer" />
      <div className="sidebar-status"><span className="live-dot" /> Local workspace <span className="status-ok">Ready</span></div>
      <div className="profile"><div className="avatar">{session.name.split(" ").map(part => part[0]).join("").slice(0, 2)}</div><div className="profile-text"><strong>{session.name}</strong><span>{session.role}</span></div><button className="icon-button subtle" aria-label="Sign out" onClick={logout}><LogOut size={16} /></button></div>
    </aside>
    <section className="main-area">
      <header className="topbar"><div className="breadcrumbs"><span>Operations</span><span className="crumb-slash">/</span><strong>{area}</strong></div><div className="top-actions"><span className="mode-pill"><span className="mode-dot" /> {extractionBadge}</span><span className="top-divider" /><span className="top-date">{new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" }).format(new Date())}</span><div className="top-avatar">{session.name.slice(0, 1).toUpperCase()}</div></div></header>
      {toast && <div className="toast" role="status"><CheckCircle2 size={17} /><span>{toast}</span><button aria-label="Dismiss" onClick={() => setToast("")}><X size={15} /></button></div>}

      {area === "Inbox" && <div className="page-content">
        <div className="page-heading"><div><span className="eyebrow">ORDER MANAGEMENT</span><h1>Inbox</h1><p>Review incoming orders and resolve anything that needs attention.</p></div><div className="heading-actions"><button className="button secondary" onClick={trySample} disabled={sampleBusy}>{sampleBusy ? <LoaderCircle size={16} className="spin" /> : <Sparkles size={16} />} Try sample order</button><button className="button primary" onClick={() => { setUploadError(""); setUploadOpen(true); }}><Upload size={16} /> Upload order</button></div></div>
        <div className="metric-grid"><Metric title="Orders in queue" value={stats?.totalOrders ?? orders.length} note={stats ? `${stats.counts.received ?? 0} recently received` : "Latest 100 orders"} icon={<Inbox size={18} />} /><Metric title="Needs review" value={pendingCount} note="Requires a human decision" icon={<AlertCircle size={18} />} accent /><Metric title="Processing" value={activeJobs} note="Active background jobs" icon={<Clock3 size={18} />} /><Metric title="Catalogue products" value={stats?.catalogueCount ?? 0} note={`${stats?.modelCalls ?? 0} model calls recorded`} icon={<Boxes size={18} />} /></div>
        <section className="panel inbox-panel"><div className="panel-head"><div><h2>Order queue</h2><p>Source, account and current review state</p></div><div className="queue-controls"><div className="searchbox"><Search size={15} /><input aria-label="Search orders" placeholder="Search orders…" value={query} onChange={event => setQuery(event.target.value)} /></div><div className="select-wrap"><Filter size={14} /><select aria-label="Filter by status" value={statusFilter} onChange={event => { setStatusFilter(event.target.value); void refreshOrders(event.target.value); }}><option value="">All statuses</option>{["needs_review", "draft_ready", "parsing", "approved", "exported", "quarantined", "failed", "duplicate"].map(status => <option key={status} value={status}>{statusLabel(status)}</option>)}</select><ChevronDown size={13} /></div><button className="icon-button" aria-label="Refresh orders" onClick={() => void refreshOrders()}><RefreshCw size={16} className={listBusy ? "spin" : ""} /></button></div></div>
          {listError ? <InlineError text={listError} onRetry={() => void refreshOrders()} /> : listBusy && !orders.length ? <EmptyState loading title="Loading order queue" text="Fetching the latest orders from the local service." /> : filteredOrders.length === 0 ? <EmptyState title="No orders to show" text={query ? "Try a different search term or status filter." : "Upload a purchase order or submit a synthetic sample to get started."} action={<button className="button secondary small" onClick={() => setUploadOpen(true)}><Plus size={15} /> Add an order</button>} /> : <div className="table-scroll"><table className="order-table"><thead><tr><th>ORDER / PO</th><th>CUSTOMER</th><th>LINES</th><th>UPDATED</th><th>STATUS</th><th /></tr></thead><tbody>{filteredOrders.map(order => <tr key={order.id} className={selectedId === order.id ? "selected-row" : ""} onClick={() => setSelectedId(order.id)}><td><div className="order-primary">{order.poNumber || "PO not identified"}</div><div className="order-secondary">{order.id}</div></td><td><div className="customer-cell"><span className="customer-icon"><UserRound size={15} /></span><span>{order.customerName ?? "Customer unresolved"}</span></div></td><td>{order.lines.length} <span className="muted">line{order.lines.length === 1 ? "" : "s"}</span></td><td>{date(order.updatedAt)}</td><td><StatusPill status={order.status} /></td><td><ArrowRight size={16} className="row-chevron" /></td></tr>)}</tbody></table></div>}
          <div className="panel-foot"><span>Showing {filteredOrders.length} of {orders.length} orders</span><span className="pagination-note">Refresh to check for new work <ArrowRight size={13} /></span></div>
        </section>
        <div className="workspace-grid"><OrderReview detail={detail} busy={detailBusy} error={detailError} lines={workingLines} setLines={setWorkingLines} customer={workingCustomer} setCustomer={value => { setWorkingCustomer(value); setWorkingAddress(""); }} address={workingAddress} setAddress={setWorkingAddress} po={workingPo} setPo={setWorkingPo} customers={customers} addresses={visibleAddresses} resolutions={resolutions} setResolutions={setResolutions} lineProducts={lineProducts} searchingLine={searchingLine} onLookup={lookupLine} onApplyProduct={applyProduct} onSelectCandidate={(lineId, candidate) => setWorkingLines(lines => lines.map(line => line.id === lineId ? { ...line, productId: candidate.productId, selectedSku: candidate.sku, description: candidate.description, matchMethod: "manual" } : line))} isReviewer={!!isReviewer} hasEdits={hasEdits} save={saveDraft} saving={saving} approve={approve} exportOrder={exportOrder} exportBusy={exportBusy} blocking={unresolvedBlocking} onRetry={() => selectedId && void refreshDetail(selectedId)} onOpenCatalogue={() => setArea("Catalogue")} /></div>
      </div>}

      {area === "Catalogue" && <div className="page-content"><div className="page-heading"><div><span className="eyebrow">MASTER DATA</span><h1>Catalogue</h1><p>Find an active product to resolve an order line.</p></div><span className="catalogue-scope"><ShieldCheck size={15} /> Account-scoped search</span></div><div className="catalogue-toolbar"><div className="searchbox large"><Search size={17} /><input autoFocus placeholder="Search by SKU, manufacturer reference or description…" value={catalogueQuery} onChange={event => setCatalogueQuery(event.target.value)} /></div><div className="select-wrap"><UserRound size={15} /><select value={workingCustomer} onChange={event => setWorkingCustomer(event.target.value)}><option value="">All catalogue access</option>{customers.map(customer => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select><ChevronDown size={14} /></div></div>{catalogueError ? <InlineError text={catalogueError} onRetry={() => setCatalogueQuery(value => `${value} `)} /> : catalogue.length === 0 ? <EmptyState loading={!catalogueError} title={catalogueQuery ? "No matching products" : "Search the catalogue"} text={catalogueQuery ? "Try a SKU, reference or a shorter description." : "Enter a product identifier or description above."} /> : <div className="catalogue-grid">{catalogue.map(product => <article className="product-card" key={product.id}><div className="product-card-top"><span className="product-category">{product.category}</span><span className="product-active"><span /> Active</span></div><strong>{product.sku}</strong><p>{product.description}</p><div className="product-specs"><span>{product.sellingUnit}{product.unitsPerPack !== "1" ? ` · ${product.unitsPerPack} / pack` : ""}</span><span>{money(product.listPrice)} / {product.sellingUnit}</span></div><div className="product-card-foot"><span>{product.manufacturerReference || "No manufacturer ref"}</span><button className="text-button" onClick={() => { if (detail?.order.lines[0]) applyProduct(detail.order.lines[0].id, product); setArea("Inbox"); }}>Use in selected order <ArrowRight size={14} /></button></div></article>)}</div>}</div>}

      {area === "Activity" && <div className="page-content"><div className="page-heading"><div><span className="eyebrow">SYSTEM ACTIVITY</span><h1>Activity</h1><p>Track background processing and retry eligible jobs.</p></div><button className="button secondary" onClick={() => { request<{ jobs: Job[] }>("/api/jobs").then(data => setJobs(data.jobs)).catch(error => setActivityError(message(error))); }}><RefreshCw size={15} /> Refresh activity</button></div>{activityError && <InlineError text={activityError} onRetry={() => { setActivityError(""); request<{ jobs: Job[] }>("/api/jobs").then(data => setJobs(data.jobs)).catch(error => setActivityError(message(error))); }} />}<section className="panel activity-panel"><div className="panel-head"><div><h2>Background jobs</h2><p>Auto-refreshes every 8 seconds</p></div><span className="activity-total">{jobs.length} total</span></div>{jobs.length === 0 ? <EmptyState title="No processing activity yet" text="Jobs will appear here when an order is submitted." /> : <div className="job-list">{jobs.map(job => <div className="job-row" key={job.id}><div className={`job-icon ${job.status}`}><Activity size={17} /></div><div className="job-info"><strong>{statusLabel(job.type).replaceAll(" ", " ")}</strong><span>{job.orderId ? `Order ${job.orderId}` : job.messageId ? `Message ${job.messageId}` : job.id} · {job.attempts} of {job.maxAttempts} attempts</span>{job.errorMessage && <span className="job-error">{job.errorCode ? `${job.errorCode}: ` : ""}{job.errorMessage}</span>}</div><StatusPill status={job.status} />{job.status === "dead_letter" && session.role === "admin" && <button className="button secondary small" onClick={() => void retry(job)}><RefreshCw size={14} /> Retry</button>}<span className="job-date">{date(job.updatedAt)}</span></div>)}</div>}</section><div className="activity-footnote"><ShieldCheck size={15} /> Every approval, edit and export is recorded in the order audit history.</div></div>}
    </section>
    {uploadOpen && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !uploadBusy) setUploadOpen(false); }}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="upload-title"><div className="modal-head"><div><span className="eyebrow">NEW INTAKE</span><h2 id="upload-title">Upload purchase order</h2><p>Choose a document and explicitly confirm its customer account.</p></div><button className="icon-button" aria-label="Close" onClick={() => setUploadOpen(false)}><X size={18} /></button></div><form className="upload-form" onSubmit={upload}><label>Customer account<select value={uploadCustomer} onChange={event => setUploadCustomer(event.target.value)} required><option value="">Select the trusted account…</option>{customers.map(customer => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select><small>Account scope comes from your selection, not from the document sender.</small></label><label className="file-drop"><Upload size={22} /><strong>Choose an order file</strong><span>PDF, email or structured document</span><input type="file" name="file" accept=".pdf,.eml,.txt,.csv,.html,.htm,application/pdf,message/rfc822,text/plain,text/csv" required /></label>{uploadError && <div className="inline-error"><AlertCircle size={16} />{uploadError}</div>}<div className="modal-actions"><button type="button" className="button secondary" onClick={() => setUploadOpen(false)} disabled={uploadBusy}>Cancel</button><button type="submit" className="button primary" disabled={uploadBusy || !uploadCustomer}>{uploadBusy ? <><LoaderCircle size={16} className="spin" /> Uploading…</> : <><Upload size={16} /> Submit order</>}</button></div></form></section></div>}
  </main>;
}

function Metric({ title, value, note, icon, accent = false }: { title: string; value: number; note: string; icon: React.ReactNode; accent?: boolean }) { return <div className={`metric-card ${accent ? "metric-accent" : ""}`}><div className="metric-top"><span>{title}</span><span className="metric-icon">{icon}</span></div><div className="metric-value">{value}</div><div className="metric-note">{note}</div></div>; }
function InlineError({ text, onRetry }: { text: string; onRetry: () => void }) { return <div className="error-state"><AlertCircle size={20} /><div><strong>Could not load this information</strong><span>{text}</span></div><button className="button secondary small" onClick={onRetry}>Try again</button></div>; }
function EmptyState({ title, text, action, loading = false }: { title: string; text: string; action?: React.ReactNode; loading?: boolean }) { return <div className="empty-state">{loading ? <LoaderCircle className="empty-icon spin" size={24} /> : <FileText className="empty-icon" size={24} />}<strong>{title}</strong><span>{text}</span>{action}</div>; }
function StatusPill({ status }: { status: string }) { const style = ["approved", "exported", "succeeded"].includes(status) ? "green" : ["needs_review", "draft_ready", "retry_wait"].includes(status) ? "amber" : ["failed", "dead_letter", "quarantined"].includes(status) ? "red" : "slate"; return <span className={`status-pill ${style}`}><span className="status-dot" />{statusLabel(status)}</span>; }

function ExportVerification({ orderId, exportId, onDone }: {orderId:string; exportId:string; onDone:()=>void}) {
  const [reference,setReference]=useState(""); const [error,setError]=useState(""); const [busy,setBusy]=useState(false);
  return <form className="order-fields" onSubmit={async event => {event.preventDefault();setBusy(true);setError("");try {await request(`/api/orders/${encodeURIComponent(orderId)}/exports/${encodeURIComponent(exportId)}/verify`,{method:"POST",body:JSON.stringify({quotationReference:reference.trim()})});onDone();} catch(e) {setError(message(e));} finally {setBusy(false);}}}><label>Odoo quotation checked<input value={reference} onChange={event=>setReference(event.target.value)} placeholder="e.g. S00006" required maxLength={200}/></label><button className="button secondary small" disabled={busy || !reference.trim()}>Record manual verification</button><small>First check the customer, delivery address, products, quantities and prices in Odoo. This records your check; it does not contact Odoo.</small>{error && <p role="alert">{error}</p>}</form>;
}

function OrderReview(props: { detail: OrderDetail | null; busy: boolean; error: string; lines: DraftLine[]; setLines: React.Dispatch<React.SetStateAction<DraftLine[]>>; customer: string; setCustomer: (value: string) => void; address: string; setAddress: (value: string) => void; po: string; setPo: (value: string) => void; customers: Customer[]; addresses: Address[]; resolutions: Record<string, string>; setResolutions: React.Dispatch<React.SetStateAction<Record<string, string>>>; lineProducts: Record<string, Product[]>; searchingLine: string; onLookup: (line: DraftLine) => void; onApplyProduct: (lineId: string, product: Product) => void; onSelectCandidate: (lineId: string, candidate: CandidateMatch) => void; isReviewer: boolean; hasEdits: boolean; save: () => void; saving: boolean; approve: () => void; exportOrder: () => void; exportBusy: boolean; blocking: boolean; onRetry: () => void; onOpenCatalogue: () => void }) {
  const { detail, busy, error } = props;
  if (busy) return <section className="panel review-panel review-empty"><LoaderCircle className="spin" size={23} /><span>Loading order review…</span></section>;
  if (error) return <section className="panel review-panel"><InlineError text={error} onRetry={props.onRetry} /></section>;
  if (!detail) return <section className="panel review-panel review-empty"><FileText size={22} /><strong>Select an order to review</strong><span>Choose an order from the queue above to inspect its source, draft and history.</span></section>;
  const { order, source, documents, evidence, audit, exports } = detail;
  const allReasons = [...order.reasons, ...order.lines.flatMap(line => line.reasons)];
  const approved = order.approval?.invalidatedAt === null;
  return <section className="panel review-panel"><div className="review-head"><div><span className="eyebrow">ORDER REVIEW</span><h2>{order.poNumber || "Purchase order"}</h2><p>{order.customerName ?? "Customer unresolved"} <span>·</span> {order.id} <span>·</span> v{order.version}</p></div><div className="review-head-actions"><StatusPill status={order.status} />{order.processingMode === "mock" && <span className="tiny-mode"><Sparkles size={12} /> MOCK</span>}</div></div><div className="review-columns"><div className="source-column"><div className="column-title"><div><span className="eyebrow">SOURCE DOCUMENT</span><strong>{source.subject || documents[0]?.filename || "Order source"}</strong></div><span className={`source-channel ${source.channel}`}>{source.channel.replaceAll("_", " ")}</span></div><div className="source-meta"><span>From <strong>{source.sender ?? "Manual upload"}</strong></span><span>Received <strong>{date(source.receivedAt)}</strong></span></div><div className="source-paper">{documents.find(doc => doc.text)?.text ? <pre>{documents.find(doc => doc.text)?.text}</pre> : <div className="document-empty"><FileText size={21} /><strong>{documents[0]?.filename ?? "No source document"}</strong><span>Text preview is not available for this file type.</span>{documents[0] && <a href={`/api/documents/${encodeURIComponent(documents[0].id)}`} target="_blank" rel="noreferrer">Open protected source <ArrowRight size={13} /></a>}</div>}</div>{documents.filter(doc => doc.mediaType === "application/pdf").map(doc => <details key={doc.id} className="source-paper" open><summary>{doc.filename}</summary><a href={`/api/documents/${encodeURIComponent(doc.id)}`} target="_blank" rel="noreferrer">Open original PDF</a><pre>{doc.text || "No extractable text. Review the original."}</pre></details>)}{detail.modelUsage?.[0] && (u => <div className="evidence-note"><Sparkles size={15} /><span>Extraction: {u.provider} {u.model} · {(u.inputTokens + u.outputTokens).toLocaleString("en-GB")} tokens ({u.inputTokens.toLocaleString("en-GB")} in / {u.outputTokens.toLocaleString("en-GB")} out) · ${u.costUsd ?? "n/a"} · {(u.latencyMs / 1000).toFixed(1)}s</span></div>)(detail.modelUsage[detail.modelUsage.length - 1])}<div className="evidence-note"><ShieldCheck size={15} /><span>{evidence.length} evidence reference{evidence.length === 1 ? "" : "s"} attached to this draft</span></div><div className="audit-mini"><div className="column-title"><strong><History size={15} /> Recent decisions</strong><button className="text-button" onClick={() => document.getElementById("audit-section")?.scrollIntoView({ behavior: "smooth" })}>View history <ArrowRight size={13} /></button></div>{audit.slice(-3).reverse().map((event: AuditEvent) => <div className="audit-row" key={event.id}><span className="audit-marker" /><span><strong>{event.action.replaceAll("_", " ")}</strong><small>{date(event.at)} · v{event.version ?? "—"}</small></span></div>)}</div></div>
    <div className="draft-column"><div className="draft-toolbar"><div><span className="eyebrow">SALES ORDER DRAFT</span><strong>Review extracted details</strong></div><button className="text-button" onClick={props.onOpenCatalogue}><PackageSearch size={14} /> Browse catalogue</button></div><div className="order-fields"><label>Customer<select value={props.customer} onChange={event => props.setCustomer(event.target.value)} disabled={!props.isReviewer}><option value="">Select customer…</option>{props.customers.map(customer => <option key={customer.id} value={customer.id}>{customer.name}{customer.onHold ? " · ON HOLD" : ""}</option>)}</select></label><label>Purchase order<input value={props.po} onChange={event => props.setPo(event.target.value)} disabled={!props.isReviewer} placeholder="PO reference" /></label><label className="address-field">Delivery address<select value={props.address} onChange={event => props.setAddress(event.target.value)} disabled={!props.isReviewer || !props.customer}><option value="">Select approved address…</option>{props.addresses.map(address => <option key={address.id} value={address.id}>{address.label} — {address.formatted}</option>)}</select></label><label>Requested delivery<input type="date" value={order.requestedDeliveryDate ?? ""} disabled title="Delivery dates are part of the validated draft." readOnly /></label></div>
      {allReasons.filter(reason => !reason.resolved || reason.severity !== "info").length > 0 && <div className="warning-stack">{allReasons.filter(reason => !reason.resolved || reason.severity !== "info").map((reason, index) => <div className={`warning-card ${reason.severity}`} key={`${reason.code}-${reason.lineId ?? "order"}-${index}`}><div className="warning-icon">{reason.severity === "blocking" ? <AlertCircle size={16} /> : <AlertCircle size={16} />}</div><div className="warning-body"><div className="warning-heading"><strong>{statusLabel(reason.code)}</strong><span>{reason.resolved ? "ACKNOWLEDGED" : reason.severity === "blocking" ? "BLOCKING" : "REVIEW"}</span></div><p>{reason.message}</p>{reason.evidenceIds.length > 0 && <small>{reason.evidenceIds.length} linked source reference{reason.evidenceIds.length === 1 ? "" : "s"}</small>}{props.isReviewer && <label className="resolution-field">Reviewer note<textarea value={props.resolutions[`${reason.code}\u001f${reason.lineId ?? ""}`] ?? ""} onChange={event => props.setResolutions(previous => ({ ...previous, [`${reason.code}\u001f${reason.lineId ?? ""}`]: event.target.value }))} placeholder="Record what you checked or decided…" rows={2} /></label>}</div></div>)}</div>}
      <div className="lines-heading"><div><strong>Order lines</strong><span>{props.lines.length} lines</span></div><button className="button ghost small" onClick={() => props.setLines(lines => [...lines, { id: `new-${Date.now()}`, position: lines.length + 1, rawText: "", sku: null, manufacturerReference: null, customerAlias: null, description: "", quantity: null, unit: null, originalUnit: null, quotedUnitPrice: null, attributes: {}, evidenceIds: [], productId: null, selectedSku: null, matchMethod: null, candidates: [], normalizedQuantity: null, normalizedUnit: null, unitPrice: null, lineTotal: null, priceAgreementVersion: null, reasons: [] }])} disabled={!props.isReviewer}><Plus size={14} /> Add line</button></div>
      <div className="line-list">{props.lines.map((line, index) => <article className="line-card" key={line.id}><div className="line-card-head"><span className="line-number">{String(index + 1).padStart(2, "0")}</span><span className="line-source">{line.rawText || "Manually added line"}</span>{line.reasons.some(reason => !reason.resolved && reason.severity !== "info") && <span className="line-flag"><AlertCircle size={12} /> Review</span>}<button className="icon-button danger-subtle" aria-label={`Remove line ${index + 1}`} disabled={!props.isReviewer || props.lines.length <= 1} onClick={() => props.setLines(lines => lines.filter(item => item.id !== line.id))}><X size={15} /></button></div><div className="line-edit-grid"><label className="sku-field">Catalogue product<div className="sku-input-row"><input value={line.selectedSku ?? ""} placeholder="Choose a product" readOnly /><button className="button secondary small" onClick={() => props.onLookup(line)} disabled={!props.isReviewer || props.searchingLine === line.id}>{props.searchingLine === line.id ? <LoaderCircle size={14} className="spin" /> : <Search size={14} />} Find</button></div>{line.candidates.length > 0 && <div className="recorded-candidates"><span>Recorded matches</span>{line.candidates.map(candidate => <button key={candidate.productId} type="button" className={line.productId === candidate.productId ? "chosen" : ""} onClick={() => props.onSelectCandidate(line.id, candidate)} disabled={!props.isReviewer}><strong>{candidate.sku}</strong><span>{candidate.description}</span><small>{statusLabel(candidate.method)}{candidate.score === null ? "" : ` · ${Math.round(candidate.score * 100)}%`}</small></button>)}</div>}{props.lineProducts[line.id]?.length > 0 && <div className="candidate-list">{props.lineProducts[line.id].map(product => <button key={product.id} onClick={() => props.onApplyProduct(line.id, product)}><strong>{product.sku}</strong><span>{product.description}</span><small>{money(product.listPrice)} · {product.sellingUnit}</small></button>)}</div>}<small>{line.matchMethod ? `${statusLabel(line.matchMethod)} · ${line.candidates.length} recorded candidate${line.candidates.length === 1 ? "" : "s"}` : line.productId ? "Manually selected catalogue product" : "No catalogue product selected"}</small></label><label>Quantity<input type="number" min="0" step="0.000001" value={line.quantity ?? ""} disabled={!props.isReviewer} onChange={event => props.setLines(lines => lines.map(item => item.id === line.id ? { ...item, normalizedQuantity: event.target.value || null, quantity: event.target.value || null } : item))} /></label><label>Unit<select value={line.unit ?? ""} disabled={!props.isReviewer} onChange={event => props.setLines(lines => lines.map(item => item.id === line.id ? { ...item, normalizedUnit: (event.target.value || null) as DraftLine["normalizedUnit"], unit: (event.target.value || null) as DraftLine["unit"] } : item))}><option value="">Select</option>{["each", "pack", "box", "pair", "roll", "metre", "litre", "kg"].map(unit => <option key={unit} value={unit}>{unit}</option>)}</select></label><label>Unit price<input value={line.unitPrice ?? line.quotedUnitPrice ?? ""} disabled placeholder="Validated by account price" /></label></div><div className="line-card-foot"><span>{line.evidenceIds.length ? `${line.evidenceIds.length} evidence link${line.evidenceIds.length === 1 ? "" : "s"}` : "No evidence linked"}</span><strong>Line total&nbsp; {money(line.lineTotal)}</strong></div></article>)}</div>
      <div className="draft-total"><span>Order total <small>GBP · net</small></span><strong>{money(order.total)}</strong></div>
      {detail.historySuggestions && detail.historySuggestions.length > 0 && <section className="audit-section"><h3>Previous orders — confirm before using</h3><p>These are synthetic historical records for this customer. Quantities need confirmation; current prices are checked separately.</p>{detail.historySuggestions.map(item => <details key={item.historyId}><summary>{item.poNumber} · {item.orderedAt} · {item.historyId}</summary>{item.lines.map((line, index) => <p key={index}>{line.sku} — {line.quantity} {line.unit}</p>)}</details>)}</section>}<section className="audit-section" id="audit-section"><div className="column-title"><strong><History size={15} /> Version history & audit</strong><span>{audit.length} event{audit.length === 1 ? "" : "s"}</span></div>{audit.length === 0 ? <span className="muted">No audit events recorded yet.</span> : audit.slice().reverse().map(event => <div className="full-audit-row" key={event.id}><div className="audit-event-mark" /><div><strong>{event.action.replaceAll("_", " ")}</strong><span>{event.actorId} · {date(event.at)} · Version {event.version ?? "—"}</span></div><small>{event.detail && Object.entries(event.detail).slice(0, 2).map(([key, value]) => `${key}: ${String(value)}`).join(" · ")}</small></div>)}</section>
      {exports.length > 0 && <section className="export-history"><div className="column-title"><strong><ArrowDownToLine size={15} /> Export history</strong><span>{exports.length} file{exports.length === 1 ? "" : "s"}</span></div>{exports.map(item => <div className="export-row" key={item.id}><span>{item.filename}</span><StatusPill status={item.state} /><a className="text-button" href={`/api/orders/${encodeURIComponent(order.id)}/exports/${encodeURIComponent(item.id)}/download`}>Download <ArrowDownToLine size={13} /></a>{props.isReviewer && ["prepared", "downloaded"].includes(item.state) && <ExportVerification orderId={order.id} exportId={item.id} onDone={props.onRetry} />}</div>)}</section>}
      <div className="review-actions"><div className="approval-state">{approved ? <><CheckCircle2 size={17} /><span>Approved by {order.approval?.approvedBy} · {date(order.approval?.approvedAt)}</span></> : <><CircleHelp size={17} /><span>{order.approval ? "Approval is no longer current." : "Not yet approved"}</span></>}</div><div className="action-buttons">{props.isReviewer && <button className="button secondary" onClick={props.save} disabled={!props.hasEdits || props.saving}>{props.saving ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />} Save changes</button>}{props.isReviewer && !approved && <button className="button primary" onClick={props.approve} disabled={props.saving || props.hasEdits || props.blocking || order.status !== "draft_ready"}>{props.saving ? <LoaderCircle size={15} className="spin" /> : <ShieldCheck size={15} />} Approve order</button>}{props.isReviewer && approved && <button className="button primary" onClick={props.exportOrder} disabled={props.exportBusy || order.status === "exported"}>{props.exportBusy ? <LoaderCircle size={15} className="spin" /> : <ArrowDownToLine size={15} />} Prepare export</button>}</div></div><p className="action-hint">{props.hasEdits ? "Save your edits and review server validation before approving." : props.blocking ? "Resolve blocking issues and save your changes before approval." : approved ? "Approved snapshots can be exported once. Import and verify the file in the destination system." : "Approval is checked by the server against your role, order version and content."}</p>
    </div></div></section>;
}
