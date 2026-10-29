"use client";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { KeyRound, LoaderCircle, LogOut, Pencil, UserPlus } from "lucide-react";
import type { Session } from "@pennbridge/contracts";
import { dateTime, message, post, request } from "./api";
import { Dialog, EmptyState, FormError, InlineError } from "./ui";

export type ManagedUser = { id: string; email: string; name: string; role: string; active: boolean; createdAt: string; lastLoginAt: string | null; activeSessions: number };
export const PASSWORD_HINTS = ["At least 12 characters (72 bytes at most)", "Not a common password and not made of a few repeated characters", "Must not contain the part of the email before the @"];
export function PasswordHints() { return <ul className="hint-list" aria-label="Password requirements">{PASSWORD_HINTS.map(h => <li key={h}>{h}</li>)}</ul>; }
const ROLES = [["viewer", "Viewer — read only"], ["reviewer", "Reviewer — edit, approve and export orders"], ["admin", "Admin — also manages users, mappings and imports"]];

function UserDialog({ user, onClose, onDone }: { user: ManagedUser | null; onClose: () => void; onDone: (text: string) => void }) {
  const [email, setEmail] = useState(user?.email ?? ""); const [name, setName] = useState(user?.name ?? ""); const [role, setRole] = useState(user?.role ?? "reviewer"); const [active, setActive] = useState(user?.active ?? true); const [password, setPassword] = useState("");
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      if (user) { await request(`/api/admin/users/${encodeURIComponent(user.id)}`, { method: "PATCH", body: JSON.stringify({ name: name.trim(), role, active }) }); onDone(`${name.trim()} updated.${role !== user.role || (!active && user.active) ? " Their sessions were ended." : ""}`); }
      else { await post("/api/admin/users", { email: email.trim(), name: name.trim(), role, password }); onDone(`${name.trim()} can now sign in.`); }
    } catch (e) { setError(message(e)); setBusy(false); }
  }
  return <Dialog title={user ? `Edit ${user.name}` : "Add user"} eyebrow="USERS" intro={user ? user.email : "Create a sign-in for a colleague. They can change the password after signing in."} onClose={onClose} busy={busy}>
    <form className="form-grid" onSubmit={submit}>
      {!user && <label className="span-2">Email address<input type="email" value={email} onChange={e => setEmail(e.target.value)} required autoComplete="off" /></label>}
      <label className="span-2">Full name<input value={name} onChange={e => setName(e.target.value)} required maxLength={200} /></label>
      <label className="span-2">Role<select value={role} onChange={e => setRole(e.target.value)}>{ROLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
      {user && <label className="check span-2"><input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} /> Account is active <small>Deactivating signs the person out immediately. The last active admin cannot be deactivated.</small></label>}
      {!user && <><label className="span-2">Temporary password<input type="password" value={password} onChange={e => setPassword(e.target.value)} required autoComplete="new-password" /></label><div className="span-2"><PasswordHints /></div></>}
      <div className="span-2"><FormError text={error} /></div>
      <div className="modal-actions span-2"><button type="button" className="button secondary" onClick={onClose} disabled={busy}>Cancel</button><button className="button primary" disabled={busy || !name.trim()}>{busy && <LoaderCircle size={15} className="spin" />} {user ? "Save changes" : "Create user"}</button></div>
    </form></Dialog>;
}
function ResetDialog({ user, onClose, onDone }: { user: ManagedUser; onClose: () => void; onDone: (text: string) => void }) {
  const [password, setPassword] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try { await post(`/api/admin/users/${encodeURIComponent(user.id)}/password`, { password }); onDone(`Password reset for ${user.name}. They were signed out everywhere.`); } catch (e) { setError(message(e)); setBusy(false); }
  }
  return <Dialog title={`Reset password for ${user.name}`} eyebrow="USERS" intro="Set a new password and sign this person out on every device. Share it with them securely." onClose={onClose} busy={busy}>
    <form className="form-grid" onSubmit={submit}><label className="span-2">New password<input type="password" value={password} onChange={e => setPassword(e.target.value)} required autoComplete="new-password" /></label><div className="span-2"><PasswordHints /></div><div className="span-2"><FormError text={error} /></div>
      <div className="modal-actions span-2"><button type="button" className="button secondary" onClick={onClose} disabled={busy}>Cancel</button><button className="button primary" disabled={busy || !password}>{busy ? <LoaderCircle size={15} className="spin" /> : <KeyRound size={15} />} Reset password</button></div></form></Dialog>;
}

export function UsersPanel({ session, toast }: { session: Session; toast: (text: string) => void }) {
  const [users, setUsers] = useState<ManagedUser[] | null>(null); const [error, setError] = useState("");
  const [dialog, setDialog] = useState<null | { kind: "edit" | "reset"; user: ManagedUser | null }>(null);
  const load = useCallback(() => request<{ users: ManagedUser[] }>("/api/admin/users").then(d => { setUsers(d.users); setError(""); }).catch(e => setError(message(e))), []);
  useEffect(() => { void load(); }, [load]);
  async function revoke(user: ManagedUser) {
    try { const r = await post<{ revokedSessions: number }>(`/api/admin/users/${encodeURIComponent(user.id)}/revoke-sessions`); toast(`${r.revokedSessions} session${r.revokedSessions === 1 ? "" : "s"} ended for ${user.name}.`); void load(); } catch (e) { toast(`Could not revoke sessions: ${message(e)}`); }
  }
  const done = (text: string) => { setDialog(null); toast(text); void load(); };
  return <section className="panel settings-panel" aria-label="Users">
    <div className="panel-head"><div><h2>Users</h2><p>Who can sign in and what they can do</p></div><button className="button primary small" onClick={() => setDialog({ kind: "edit", user: null })}><UserPlus size={14} /> Add user</button></div>
    {error ? <InlineError text={error} onRetry={() => void load()} /> : !users ? <EmptyState loading title="Loading users" text="Fetching accounts…" /> : users.length === 0 ? <EmptyState title="No users" text="Add the first user." /> :
      <div className="table-scroll"><table className="order-table settings-table"><thead><tr><th>NAME</th><th>ROLE</th><th>STATUS</th><th>LAST SIGN-IN</th><th>SESSIONS</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{users.map(u => <tr key={u.id}><td><div className="order-primary">{u.name}{u.id === session.userId ? " (you)" : ""}</div><div className="order-secondary">{u.email}</div></td><td className="cap">{u.role}</td><td><span className={`status-pill ${u.active ? "green" : "slate"}`}><span className="status-dot" />{u.active ? "active" : "inactive"}</span></td><td>{dateTime(u.lastLoginAt)}</td><td>{u.activeSessions}</td>
        <td><div className="row-actions"><button className="icon-button" aria-label={`Edit ${u.name}`} title="Edit" onClick={() => setDialog({ kind: "edit", user: u })}><Pencil size={14} /></button><button className="icon-button" aria-label={`Reset password for ${u.name}`} title="Reset password" onClick={() => setDialog({ kind: "reset", user: u })}><KeyRound size={14} /></button><button className="icon-button" aria-label={`Sign ${u.name} out everywhere`} title="Revoke sessions" disabled={u.activeSessions === 0} onClick={() => void revoke(u)}><LogOut size={14} /></button></div></td></tr>)}</tbody></table></div>}
    {dialog?.kind === "edit" && <UserDialog user={dialog.user} onClose={() => setDialog(null)} onDone={done} />}
    {dialog?.kind === "reset" && dialog.user && <ResetDialog user={dialog.user} onClose={() => setDialog(null)} onDone={done} />}
  </section>;
}
