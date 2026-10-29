export type ApiProblem = { error?: { code?: string; message?: string; issues?: Array<{ path: string; message: string }> } };
export class ApiError extends Error { constructor(message: string, readonly status: number, readonly code?: string) { super(message); } }

export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, credentials: "same-origin", headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers } });
  if (!response.ok) {
    const data = await response.json().catch(() => null) as ApiProblem | null;
    const issue = data?.error?.issues?.[0];
    throw new ApiError(data?.error?.message ? `${data.error.message}${issue ? ` (${issue.path}: ${issue.message})` : ""}` : `${response.status} ${response.statusText}`, response.status, data?.error?.code);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
export const post = <T,>(url: string, body: unknown = {}) => request<T>(url, { method: "POST", body: JSON.stringify(body) });

export function money(value: string | null | undefined) { return value ? `£${value}` : "—"; }
export function date(value: string | null | undefined) { return value ? new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(value)) : "Not set"; }
export function dateTime(value: string | null | undefined) { return value ? new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "Never"; }
export function statusLabel(status: string) { return status.replaceAll("_", " "); }
export function message(error: unknown) { return error instanceof Error ? error.message : "Something went wrong. Please try again."; }

export type DeskStats = { counts: Record<string, number>; totalOrders: number; catalogueCount: number; pendingJobs: number; mode: string; provider?: string; model?: string | null; modelCalls: number; modelUsage: number };
export type Readiness = { status: "ok" | "degraded" | "down"; problems: string[]; jobs?: { deadLetter: number; queued: number }; mailbox?: { lastError: string | null } };

/** Plain-language text for each readiness problem code. */
export function problemText(code: string, r: Readiness): string {
  switch (code) {
    case "DEAD_LETTER_JOBS": { const n = r.jobs?.deadLetter ?? 1; return `${n} order${n === 1 ? "" : "s"} failed processing — open ${n === 1 ? "it" : "them"} to retry or enter manually.`; }
    case "WORKER_NO_HEARTBEAT": return "The background worker has not reported in, so new orders will not be processed until it is running.";
    case "WORKER_STALE": return "The background worker has stopped responding. New orders may be delayed.";
    case "QUEUE_BACKLOG": return "Orders are waiting longer than usual to be processed.";
    case "MAILBOX_STALE": return "The shared orders mailbox has not been checked recently, so new emails may be delayed.";
    case "MAILBOX_ERROR": return `The orders mailbox could not be read${r.mailbox?.lastError ? ` (${r.mailbox.lastError})` : ""}. Ask an administrator to check the mailbox settings.`;
    case "DATABASE_UNREACHABLE": return "The database cannot be reached. Orders cannot be loaded or saved until it is back.";
    default: return `Service issue: ${code.toLowerCase().replaceAll("_", " ")}.`;
  }
}
