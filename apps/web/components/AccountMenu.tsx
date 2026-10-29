"use client";
import { FormEvent, useEffect, useRef, useState } from "react";
import { ChevronDown, KeyRound, LoaderCircle, LogOut } from "lucide-react";
import type { Session } from "@pennbridge/contracts";
import { message, post } from "./api";
import { Dialog, FormError } from "./ui";
import { PasswordHints } from "./UsersPanel";

export function PasswordDialog({ onClose, toast }: { onClose: () => void; toast: (text: string) => void }) {
  const [current, setCurrent] = useState(""); const [next, setNext] = useState(""); const [again, setAgain] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setError("");
    if (next !== again) { setError("The new passwords do not match."); return; }
    setBusy(true);
    try { await post("/api/auth/password", { currentPassword: current, newPassword: next }); toast("Password changed. Other devices were signed out."); onClose(); } catch (e) { setError(message(e)); setBusy(false); }
  }
  return <Dialog title="Change your password" eyebrow="ACCOUNT" onClose={onClose} busy={busy}>
    <form className="form-grid" onSubmit={submit}>
      <label className="span-2">Current password<input type="password" value={current} onChange={e => setCurrent(e.target.value)} required autoComplete="current-password" /></label>
      <label className="span-2">New password<input type="password" value={next} onChange={e => setNext(e.target.value)} required autoComplete="new-password" /></label>
      <label className="span-2">Repeat new password<input type="password" value={again} onChange={e => setAgain(e.target.value)} required autoComplete="new-password" /></label>
      <div className="span-2"><PasswordHints /></div><div className="span-2"><FormError text={error} /></div>
      <div className="modal-actions span-2"><button type="button" className="button secondary" onClick={onClose} disabled={busy}>Cancel</button><button className="button primary" disabled={busy || !current || !next || !again}>{busy && <LoaderCircle size={15} className="spin" />} Change password</button></div>
    </form></Dialog>;
}

/** Avatar button in the top bar: opens a small menu with change password and sign out. */
export function AccountMenu({ session, onSignOut, toast }: { session: Session; onSignOut: () => void; toast: (text: string) => void }) {
  const [open, setOpen] = useState(false); const [password, setPassword] = useState(false); const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    const esc = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away); document.addEventListener("keydown", esc); return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  return <div className="account-menu" ref={box}>
    <button className="account-trigger" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(v => !v)}><span className="top-avatar">{session.name.slice(0, 1).toUpperCase()}</span><span className="account-name">{session.name}</span><ChevronDown size={13} /></button>
    {open && <div className="account-pop" role="menu"><div className="account-who"><strong>{session.name}</strong><span>{session.email} · {session.role}</span></div><button role="menuitem" onClick={() => { setOpen(false); setPassword(true); }}><KeyRound size={14} /> Change password</button><button role="menuitem" onClick={() => { setOpen(false); onSignOut(); }}><LogOut size={14} /> Sign out</button></div>}
    {password && <PasswordDialog onClose={() => setPassword(false)} toast={toast} />}
  </div>;
}
