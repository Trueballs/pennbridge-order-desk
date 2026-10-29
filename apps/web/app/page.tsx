"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  Activity, AlertCircle, AlertTriangle, ArrowRight, Boxes, CheckCircle2, ChevronDown, CircleHelp, Clock3, Inbox, LoaderCircle,
  LogOut, PackageSearch, RefreshCw, Search, Settings as SettingsIcon, ShieldCheck, Sparkles, Upload, UserRound, X,
} from "lucide-react";
import type { Address, Customer, Job, OrderDetail, Product, Session } from "@pennbridge/contracts";
import { DeskStats, Readiness, date, message, money, problemText, request, statusLabel } from "../components/api";
import { Dialog, EmptyState, FormError, InlineError, Metric, StatusPill } from "../components/ui";
import { OrderList } from "../components/OrderList";
import { OrderReview } from "../components/OrderReview";
import { AccountMenu } from "../components/AccountMenu";
import { UsersPanel } from "../components/UsersPanel";
import { SenderMappingsPanel } from "../components/SenderMappingsPanel";
import { ImportPanel } from "../components/ImportPanel";

type Area = "Inbox" | "Catalogue" | "Activity" | "Settings";
type SettingsTab = "Users" | "Sender mappings" | "Data import";

export default function Home() {
  const [session, setSession] = useState<Session | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [loginError, setLoginError] = useState("");
  const [area, setArea] = useState<Area>("Inbox");
  const [tab, setTab] = useState<SettingsTab>("Users");
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [toast, setToast] = useState("");
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [stats, setStats] = useState<DeskStats | null>(null);
  const [ready, setReady] = useState<Readiness | null>(null);
  const [catalogue, setCatalogue] = useState<Product[]>([]);
  const [catalogueQuery, setCatalogueQuery] = useState("");
  const [catalogueCustomer, setCatalogueCustomer] = useState("");
  const [activityError, setActivityError] = useState("");
  const [catalogueError, setCatalogueError] = useState("");
  const [pendingProduct, setPendingProduct] = useState<Product | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [sampleBusy, setSampleBusy] = useState(false);

  const refreshDetail = useCallback(async (id: string) => {
    if (!id) { setDetail(null); return; }
    setDetailBusy(true); setDetailError("");
    try { setDetail(await request<OrderDetail>(`/api/orders/${encodeURIComponent(id)}`)); }
    catch (error) { setDetail(null); setDetailError(message(error)); }
    finally { setDetailBusy(false); }
  }, []);
  const refreshStats = useCallback(() => { request<DeskStats>("/api/stats").then(setStats).catch(() => {}); }, []);
  const refreshReady = useCallback(() => { request<Readiness>("/api/ready").then(setReady).catch(() => setReady({ status: "down", problems: ["DATABASE_UNREACHABLE"] })); }, []);
  const reloadList = () => setReloadKey(key => key + 1);
  const isAdmin = session?.role === "admin";

  useEffect(() => { request<Session>("/api/session").then(setSession).catch(() => setSession(null)).finally(() => setCheckingSession(false)); }, []);
  useEffect(() => {
    if (!session) return;
    refreshStats(); refreshReady();
    request<{ customers: Customer[]; addresses: Address[] }>("/api/customers").then(data => { setCustomers(data.customers); setAddresses(data.addresses); }).catch(error => setToast(`Could not load customers: ${message(error)}`));
  }, [session, refreshStats, refreshReady]);
  useEffect(() => { if (selectedId && session) void refreshDetail(selectedId); }, [selectedId, session, refreshDetail]);
  useEffect(() => {
    if (!session) return;
    const poll = () => request<{ jobs: Job[] }>("/api/jobs").then(data => setJobs(data.jobs)).catch(error => setActivityError(message(error)));
    void poll(); const timer = window.setInterval(() => { void poll(); }, 8000); return () => window.clearInterval(timer);
  }, [session]);
  useEffect(() => {
    if (!session || area !== "Catalogue") return;
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ q: catalogueQuery }); if (catalogueCustomer) params.set("customerId", catalogueCustomer);
      request<{ products: Product[] }>(`/api/catalogue?${params}`).then(data => { setCatalogue(data.products); setCatalogueError(""); }).catch(error => { setCatalogue([]); setCatalogueError(message(error)); });
    }, 250); return () => window.clearTimeout(timer);
  }, [session, area, catalogueQuery, catalogueCustomer]);
  const activeJobs = Math.max(stats?.pendingJobs ?? 0, jobs.filter(job => ["queued", "running", "retry_wait"].includes(job.status)).length);
  const processing = !!detail && ["received", "parsing", "extracted", "validating"].includes(detail.order.status);
  useEffect(() => {
    if (!session || !selectedId || !processing) return;
    const timer = window.setInterval(() => { void request<OrderDetail>(`/api/orders/${encodeURIComponent(selectedId)}`).then(setDetail).catch(() => {}); reloadList(); refreshStats(); }, 2000);
    return () => window.clearInterval(timer);
  }, [session, selectedId, processing, refreshStats]);
  useEffect(() => {
    if (!session) return;
    const timer = window.setInterval(() => { refreshStats(); refreshReady(); }, activeJobs > 0 ? 6000 : 15000);
    return () => window.clearInterval(timer);
  }, [session, activeJobs, refreshStats, refreshReady]);

  const pendingCount = stats ? (stats.counts.needs_review ?? 0) + (stats.counts.draft_ready ?? 0) + (stats.counts.amendment_review ?? 0) + (stats.counts.cancellation_review ?? 0) : 0;
  const appMode = (stats?.mode ?? detail?.order.processingMode ?? "unknown").toUpperCase();
  const extractionBadge = stats?.mode === "live" ? `Extraction: ${stats.provider === "gemini" ? "Gemini" : "Claude"} live${stats.model ? ` (${stats.model})` : ""}` : stats?.mode === "mock" ? "Extraction: Mock" : stats?.mode === "manual" ? "Extraction: manual entry" : `${appMode} MODE`;

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setLoginError(""); const form = new FormData(event.currentTarget);
    try { setSession(await request<Session>("/api/auth/login", { method: "POST", body: JSON.stringify({ email: form.get("email"), password: form.get("password") }) })); }
    catch (error) { setLoginError(message(error)); }
  }
  async function logout() { try { await request("/api/auth/logout", { method: "POST" }); } finally { setSession(null); setSelectedId(""); setDetail(null); setArea("Inbox"); setStats(null); setReady(null); } }
  async function trySample() {
    setSampleBusy(true); setToast("");
    try { const result = await request<{ orderId?: string | null }>("/api/demo", { method: "POST", body: "{}" }); setToast("Synthetic sample order submitted. Processing mode is shown on the order."); reloadList(); if (result.orderId) setSelectedId(result.orderId); }
    catch (error) { setToast(`Sample could not be created: ${message(error)}`); }
    finally { setSampleBusy(false); }
  }
  async function retry(job: Job) {
    try { await request(`/api/jobs/${encodeURIComponent(job.id)}/retry`, { method: "POST" }); setToast("Retry queued."); const data = await request<{ jobs: Job[] }>("/api/jobs"); setJobs(data.jobs); refreshReady(); }
    catch (error) { setToast(`Retry failed: ${message(error)}`); }
  }
  function orderChanged(next: OrderDetail, note?: string) { setDetail(next); if (note) setToast(note); reloadList(); refreshStats(); refreshReady(); }

  if (checkingSession) return <div className="boot"><LoaderCircle className="spin" size={20} /> Connecting to Pennbridge Order Desk…</div>;
  if (!session) return <main className="login-shell"><section className="login-art"><div className="brand-lockup"><div className="brand-mark"><Boxes size={21} /></div><span>Pennbridge</span><span className="brand-light">Order Desk</span></div><div className="login-copy"><span className="eyebrow light">OPERATIONS WORKSPACE</span><h1>Orders, checked<br />before they move.</h1><p>Turn purchase orders into clear, reviewable sales drafts with every source and decision close at hand.</p></div><div className="login-foot"><ShieldCheck size={15} /> Private workspace <span>·</span> Every change is audited</div><div className="art-grid" /></section><section className="login-panel"><div className="login-card"><span className="eyebrow">WELCOME BACK</span><h2>Sign in to your desk</h2><p className="muted">Use the account your administrator created for you.</p><form onSubmit={login} className="login-form"><label>Email address<input name="email" type="email" autoComplete="username" placeholder="you@company.com" required /></label><label>Password<input name="password" type="password" autoComplete="current-password" placeholder="Enter your password" required /></label><FormError text={loginError} /><button className="button primary full" type="submit">Sign in <ArrowRight size={16} /></button></form><div className="login-note"><CircleHelp size={16} /><span>Demo installs only: <strong>reviewer@pennbridge.example</strong> · password <strong>reviewer-demo</strong></span></div></div><span className="login-copyright">Pennbridge Industrial Supplies · Internal use</span></section></main>;

  const areas: Area[] = isAdmin ? ["Inbox", "Catalogue", "Activity", "Settings"] : ["Inbox", "Catalogue", "Activity"];
  const icons = { Inbox, Catalogue: PackageSearch, Activity, Settings: SettingsIcon } as const;
  const readyProblems = ready && ready.status !== "ok" ? ready.problems : [];

  return <main className="app-shell">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <aside className="sidebar">
      <div className="brand-lockup"><div className="brand-mark"><Boxes size={20} /></div><span>Pennbridge</span><span className="brand-light">Desk</span></div>
      <div className="workspace-label">WORKSPACE</div>
      <nav className="main-nav" aria-label="Main navigation">
        {areas.map(item => { const Icon = icons[item]; return <button key={item} className={`nav-link ${area === item ? "active" : ""}`} aria-label={item} aria-current={area === item ? "page" : undefined} onClick={() => setArea(item)}><Icon size={17} /><span>{item}</span>{item === "Inbox" && pendingCount > 0 && <small aria-label={`${pendingCount} need review`}>{pendingCount}</small>}</button>; })}
      </nav>
      <div className="sidebar-spacer" />
      <div className="sidebar-status"><span className={`live-dot ${readyProblems.length ? "warn" : ""}`} /> Service <span className={readyProblems.length ? "status-warn" : "status-ok"}>{ready?.status === "down" ? "Down" : readyProblems.length ? "Attention" : "Ready"}</span></div>
      <div className="profile"><div className="avatar">{session.name.split(" ").map(part => part[0]).join("").slice(0, 2)}</div><div className="profile-text"><strong>{session.name}</strong><span>{session.role}</span></div><button className="icon-button subtle" aria-label="Sign out" onClick={logout}><LogOut size={16} /></button></div>
    </aside>
    <section className="main-area" id="main-content">
      <header className="topbar"><div className="breadcrumbs"><span>Operations</span><span className="crumb-slash">/</span><strong>{area}</strong></div><div className="top-actions"><span className="mode-pill"><span className="mode-dot" /> {extractionBadge}</span><span className="top-divider" /><span className="top-date">{new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" }).format(new Date())}</span><AccountMenu session={session} onSignOut={logout} toast={setToast} /></div></header>
      {readyProblems.length > 0 && <div className={`ready-banner ${ready?.status === "down" ? "down" : ""}`} role="alert"><AlertTriangle size={17} /><div><strong>{ready?.status === "down" ? "The service is not working" : "Something needs attention"}</strong><ul>{readyProblems.map(code => <li key={code}>{problemText(code, ready!)}</li>)}</ul></div></div>}
      {toast && <div className="toast" role="status"><CheckCircle2 size={17} /><span>{toast}</span><button aria-label="Dismiss" onClick={() => setToast("")}><X size={15} /></button></div>}

      {area === "Inbox" && <div className="page-content">
        <div className="page-heading"><div><span className="eyebrow">ORDER MANAGEMENT</span><h1>Inbox</h1><p>Review incoming orders and resolve anything that needs attention.</p></div><div className="heading-actions">{stats?.mode === "mock" && <button className="button secondary" onClick={trySample} disabled={sampleBusy}>{sampleBusy ? <LoaderCircle size={16} className="spin" /> : <Sparkles size={16} />} Try sample order</button>}<button className="button primary" onClick={() => setUploadOpen(true)}><Upload size={16} /> Upload order</button></div></div>
        <div className="metric-grid"><Metric title="Orders in queue" value={stats?.totalOrders ?? 0} note={stats ? `${stats.counts.received ?? 0} recently received` : "Loading…"} icon={<Inbox size={18} />} /><Metric title="Needs review" value={pendingCount} note="Requires a human decision" icon={<AlertCircle size={18} />} accent /><Metric title="Processing" value={activeJobs} note="Active background jobs" icon={<Clock3 size={18} />} /><Metric title="Catalogue products" value={stats?.catalogueCount ?? 0} note={`${stats?.modelCalls ?? 0} model calls recorded`} icon={<Boxes size={18} />} /></div>
        <OrderList selectedId={selectedId} onSelect={setSelectedId} reloadKey={reloadKey} pollMs={activeJobs > 0 ? 6000 : 15000} customers={customers} onAdd={() => setUploadOpen(true)} />
        <div className="workspace-grid"><OrderReview detail={detail} busy={detailBusy} error={detailError} session={session} customers={customers} addresses={addresses} pendingProduct={pendingProduct} onPendingUsed={() => setPendingProduct(null)} onDetail={orderChanged} onRefresh={() => { if (selectedId) void refreshDetail(selectedId); reloadList(); refreshReady(); }} onOpenCatalogue={() => setArea("Catalogue")} toast={setToast} /></div>
      </div>}

      {area === "Catalogue" && <div className="page-content"><div className="page-heading"><div><span className="eyebrow">MASTER DATA</span><h1>Catalogue</h1><p>Find an active product to resolve an order line.</p></div><span className="catalogue-scope"><ShieldCheck size={15} /> Account-scoped search</span></div><div className="catalogue-toolbar"><div className="searchbox large"><Search size={17} /><input aria-label="Search catalogue" autoFocus placeholder="Search by SKU, manufacturer reference or description…" value={catalogueQuery} onChange={event => setCatalogueQuery(event.target.value)} /></div><div className="select-wrap"><UserRound size={15} /><select aria-label="Catalogue customer" value={catalogueCustomer} onChange={event => setCatalogueCustomer(event.target.value)}><option value="">All catalogue access</option>{customers.map(customer => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select><ChevronDown size={14} /></div></div>{catalogueError ? <InlineError text={catalogueError} onRetry={() => setCatalogueQuery(value => `${value} `)} /> : catalogue.length === 0 ? <EmptyState loading={!catalogueQuery} title={catalogueQuery ? "No matching products" : "Search the catalogue"} text={catalogueQuery ? "Try a SKU, reference or a shorter description." : "Enter a product identifier or description above."} /> : <div className="catalogue-grid">{catalogue.map(product => <article className="product-card" key={product.id}><div className="product-card-top"><span className="product-category">{product.category}</span><span className="product-active"><span /> Active</span></div><strong>{product.sku}</strong><p>{product.description}</p><div className="product-specs"><span>{product.sellingUnit}{product.unitsPerPack !== "1" ? ` · ${product.unitsPerPack} / pack` : ""}</span><span>{money(product.listPrice)} / {product.sellingUnit}</span></div><div className="product-card-foot"><span>{product.manufacturerReference || "No manufacturer ref"}</span>{detail?.order.lines[0] && <button className="text-button" onClick={() => { setPendingProduct(product); setArea("Inbox"); }}>Use on first line of selected order <ArrowRight size={14} /></button>}</div></article>)}</div>}</div>}

      {area === "Activity" && <div className="page-content"><div className="page-heading"><div><span className="eyebrow">SYSTEM ACTIVITY</span><h1>Activity</h1><p>Track background processing and retry eligible jobs.</p></div><button className="button secondary" onClick={() => { request<{ jobs: Job[] }>("/api/jobs").then(data => setJobs(data.jobs)).catch(error => setActivityError(message(error))); refreshReady(); }}><RefreshCw size={15} /> Refresh activity</button></div>{activityError && <InlineError text={activityError} onRetry={() => { setActivityError(""); request<{ jobs: Job[] }>("/api/jobs").then(data => setJobs(data.jobs)).catch(error => setActivityError(message(error))); }} />}<section className="panel activity-panel"><div className="panel-head"><div><h2>Background jobs</h2><p>Auto-refreshes every 8 seconds</p></div><span className="activity-total">{jobs.length} total</span></div>{jobs.length === 0 ? <EmptyState title="No processing activity yet" text="Jobs will appear here when an order is submitted." /> : <div className="job-list">{jobs.map(job => <div className="job-row" key={job.id}><div className={`job-icon ${job.status}`}><Activity size={17} /></div><div className="job-info"><strong>{statusLabel(job.type)}</strong><span>{job.orderId ? <button className="text-button inline" onClick={() => { setSelectedId(job.orderId!); setArea("Inbox"); }}>Order {job.orderId}</button> : job.messageId ? `Message ${job.messageId}` : job.id} · {job.attempts} of {job.maxAttempts} attempts</span>{job.errorMessage && <span className="job-error">{job.errorCode ? `${job.errorCode}: ` : ""}{job.errorMessage}</span>}</div><StatusPill status={job.status} />{job.status === "dead_letter" && session.role === "admin" && <button className="button secondary small" onClick={() => void retry(job)}><RefreshCw size={14} /> Retry</button>}<span className="job-date">{date(job.updatedAt)}</span></div>)}</div>}</section><div className="activity-footnote"><ShieldCheck size={15} /> Every approval, edit and export is recorded in the order audit history.</div></div>}

      {area === "Settings" && isAdmin && <div className="page-content"><div className="page-heading"><div><span className="eyebrow">ADMINISTRATION</span><h1>Settings</h1><p>People, sender recognition and master data imports.</p></div></div>
        <div className="tabs" role="tablist" aria-label="Settings sections">{(["Users", "Sender mappings", "Data import"] as SettingsTab[]).map(item => <button key={item} role="tab" aria-selected={tab === item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item}</button>)}</div>
        {tab === "Users" && <UsersPanel session={session} toast={setToast} />}
        {tab === "Sender mappings" && <SenderMappingsPanel customers={customers} toast={setToast} />}
        {tab === "Data import" && <ImportPanel toast={setToast} onApplied={() => { request<{ customers: Customer[]; addresses: Address[] }>("/api/customers").then(data => { setCustomers(data.customers); setAddresses(data.addresses); }).catch(() => {}); refreshStats(); }} />}
      </div>}
    </section>
    {uploadOpen && <UploadDialog customers={customers} onClose={() => setUploadOpen(false)} onDone={(orderId, duplicate) => { setUploadOpen(false); setToast(duplicate ? "This document was already received. Showing its existing order." : "Order received. Processing has started."); reloadList(); if (orderId) setSelectedId(orderId); setArea("Inbox"); }} />}
  </main>;
}

function UploadDialog({ customers, onClose, onDone }: { customers: Customer[]; onClose: () => void; onDone: (orderId: string | null, duplicate: boolean) => void }) {
  const [customer, setCustomer] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); const file = new FormData(event.currentTarget).get("file");
    if (!(file instanceof File) || !file.size) { setError("Choose an order document to continue."); return; }
    setBusy(true);
    try {
      const contentBase64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1] ?? ""); reader.onerror = () => reject(new Error("The selected file could not be read.")); reader.readAsDataURL(file); });
      const result = await request<{ orderId: string | null; duplicate: boolean }>("/api/intake", { method: "POST", body: JSON.stringify({ filename: file.name, mediaType: file.type || "application/octet-stream", contentBase64, channel: "upload", trustedCustomerId: customer || null }) });
      onDone(result.orderId, result.duplicate);
    } catch (e) { setError(message(e)); setBusy(false); }
  }
  return <Dialog title="Upload purchase order" eyebrow="NEW INTAKE" intro="Choose a document and explicitly confirm its customer account." onClose={onClose} busy={busy}>
    <form className="upload-form" onSubmit={upload}><label>Customer account<select value={customer} onChange={event => setCustomer(event.target.value)} required><option value="">Select the trusted account…</option>{customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select><small>Account scope comes from your selection, not from the document sender.</small></label><label className="file-drop"><Upload size={22} /><strong>Choose an order file</strong><span>PDF, email or structured document</span><input type="file" name="file" accept=".pdf,.eml,.txt,.csv,.html,.htm,application/pdf,message/rfc822,text/plain,text/csv" required /></label><FormError text={error} /><div className="modal-actions"><button type="button" className="button secondary" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="button primary" disabled={busy || !customer}>{busy ? <><LoaderCircle size={16} className="spin" /> Uploading…</> : <><Upload size={16} /> Submit order</>}</button></div></form></Dialog>;
}
