"use client";
import { ReactNode, useEffect, useId, useRef } from "react";
import { AlertCircle, FileText, LoaderCircle, X } from "lucide-react";
import { statusLabel } from "./api";

export function Metric({ title, value, note, icon, accent = false }: { title: string; value: number; note: string; icon: ReactNode; accent?: boolean }) { return <div className={`metric-card ${accent ? "metric-accent" : ""}`}><div className="metric-top"><span>{title}</span><span className="metric-icon">{icon}</span></div><div className="metric-value">{value}</div><div className="metric-note">{note}</div></div>; }
export function InlineError({ text, onRetry }: { text: string; onRetry?: () => void }) { return <div className="error-state" role="alert"><AlertCircle size={20} /><div><strong>Could not load this information</strong><span>{text}</span></div>{onRetry && <button className="button secondary small" onClick={onRetry}>Try again</button>}</div>; }
export function EmptyState({ title, text, action, loading = false }: { title: string; text: string; action?: ReactNode; loading?: boolean }) { return <div className="empty-state">{loading ? <LoaderCircle className="empty-icon spin" size={24} /> : <FileText className="empty-icon" size={24} />}<strong>{title}</strong><span>{text}</span>{action}</div>; }
export function StatusPill({ status }: { status: string }) { const style = ["approved", "exported", "succeeded", "import_verified", "pushed"].includes(status) ? "green" : ["needs_review", "draft_ready", "retry_wait", "prepared", "downloaded"].includes(status) ? "amber" : ["failed", "dead_letter", "quarantined", "voided"].includes(status) ? "red" : "slate"; return <span className={`status-pill ${style}`}><span className="status-dot" />{statusLabel(status === "import_verified" ? "verified" : status)}</span>; }
export function FormError({ text }: { text: string }) { return text ? <div className="inline-error" role="alert"><AlertCircle size={16} />{text}</div> : null; }

/** Modal dialog: Escape closes, focus moves in and returns, Tab is kept inside. */
export function Dialog({ title, eyebrow, intro, onClose, busy = false, wide = false, children }: { title: string; eyebrow?: string; intro?: string; onClose: () => void; busy?: boolean; wide?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null); const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    (node?.querySelector<HTMLElement>("input:not([type=hidden]),select,textarea") ?? node?.querySelector<HTMLElement>("button"))?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) { event.stopPropagation(); onClose(); }
      if (event.key === "Tab" && node) {
        const items = [...node.querySelectorAll<HTMLElement>("a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)")];
        if (!items.length) return; const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); previous?.focus?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}><section ref={ref} className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId}><div className="modal-head"><div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h2 id={titleId}>{title}</h2>{intro && <p>{intro}</p>}</div><button className="icon-button" aria-label="Close dialog" onClick={onClose} disabled={busy}><X size={18} /></button></div>{children}</section></div>;
}
