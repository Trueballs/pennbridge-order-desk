import { randomBytes } from "node:crypto";
import { compare, getRounds, hash } from "bcryptjs";
import type { Session } from "@pennbridge/contracts";
import { pool, sha256, type DbClient } from "@pennbridge/db";
import { ServiceError } from "@pennbridge/domain";

/** Production cost is fixed at 12; only test runs may lower it (NODE_ENV=test / VITEST) to keep suites fast. */
export function bcryptCost(): number {
  const override = Number(process.env.BCRYPT_COST);
  if ((process.env.NODE_ENV === "test" || process.env.VITEST) && Number.isInteger(override) && override >= 4 && override <= 14) return override;
  return 12;
}
export const hashPassword = (password: string) => hash(password, bcryptCost());

export const PASSWORD_MIN_LENGTH = 12;
const COMMON = new Set(["password1234", "passwordpassword", "123456789012", "qwertyuiopas", "administrator", "letmein123456", "welcome12345", "changeme1234"]);
/** Returns human-readable problems; empty means acceptable. Max 72 bytes because bcrypt silently truncates beyond that. */
export function passwordProblems(password: string, context: { email?: string; name?: string } = {}): string[] {
  const problems: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) problems.push(`Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  if (Buffer.byteLength(password) > 72) problems.push("Password must be at most 72 bytes.");
  if (new Set(password).size < 5) problems.push("Password must not be made of a few repeated characters.");
  const lowered = password.toLowerCase();
  if (COMMON.has(lowered)) problems.push("Password is too common.");
  const local = context.email?.split("@")[0]?.toLowerCase();
  if (local && local.length >= 4 && lowered.includes(local)) problems.push("Password must not contain the email name.");
  return problems;
}
export function assertPasswordPolicy(password: string, context: { email?: string; name?: string } = {}) {
  const [first] = passwordProblems(password, context);
  if (first) throw new ServiceError("VALIDATION_FAILED", first, 400);
}

const THROTTLE_WINDOW_MINUTES = 15;
const THROTTLE_LOCK_MINUTES = 15;
/** Per IP+account is the tight limit; account-only and IP-only bound distributed and spraying attacks. */
const THROTTLE_LIMITS = { ipacct: 5, acct: 20, ip: 60 } as const;
const tkey = (scope: string, value: string) => sha256(`${scope}|${value}`);
export function throttleKeys(email: string, ip: string) {
  return [["ipacct", `${ip}|${email}`], ["acct", email], ["ip", ip]].map(([scope, value]) => ({ scope: scope as keyof typeof THROTTLE_LIMITS, key: tkey(scope, value) }));
}
async function assertNotLocked(keys: { key: string }[]) {
  const locked = await pool.query("SELECT 1 FROM login_throttle WHERE key=ANY($1) AND locked_until>now() LIMIT 1", [keys.map((k) => k.key)]);
  if (locked.rowCount) throw new ServiceError("FORBIDDEN", "Too many failed attempts. Try again in a few minutes.", 429);
}
async function recordFailure(keys: { scope: keyof typeof THROTTLE_LIMITS | string; key: string }[], limits: Record<string, number> = THROTTLE_LIMITS) {
  for (const { scope, key } of keys) {
    const expired = "login_throttle.window_started_at<now()-($3*interval '1 minute')";
    await pool.query(`INSERT INTO login_throttle(key,scope,failures,window_started_at) VALUES($1,$5,1,now())
      ON CONFLICT(key) DO UPDATE SET
        failures=CASE WHEN ${expired} THEN 1 ELSE login_throttle.failures+1 END,
        window_started_at=CASE WHEN ${expired} THEN now() ELSE login_throttle.window_started_at END,
        locked_until=CASE WHEN (CASE WHEN ${expired} THEN 1 ELSE login_throttle.failures+1 END)>=$2 THEN now()+($4*interval '1 minute') ELSE CASE WHEN ${expired} THEN NULL ELSE login_throttle.locked_until END END`,
      [key, limits[scope], THROTTLE_WINDOW_MINUTES, THROTTLE_LOCK_MINUTES, scope]);
  }
}
async function clearFailures(keys: { key: string }[]) { await pool.query("DELETE FROM login_throttle WHERE key=ANY($1)", [keys.map((k) => k.key)]); }

let dummy: Promise<string> | undefined;
/** Compared when the account is unknown/inactive so response time does not reveal which emails exist. */
const dummyHash = () => (dummy ??= hash("dummy-password-for-timing", bcryptCost()));

export const sessionTtlHours = () => Math.min(72, Math.max(1, Number(process.env.SESSION_TTL_HOURS) || 8));
export const sessionIdleMinutes = () => Math.min(1440, Math.max(5, Number(process.env.SESSION_IDLE_MINUTES) || 120));
const rowSession = (row: any, expiresAt: Date | string): Session => ({ userId: row.id, email: row.email, name: row.name, role: row.role, expiresAt: new Date(expiresAt).toISOString() });

export async function authenticate(email: string, password: string, context: { ip?: string } = {}): Promise<{ session: Session; token: string }> {
  const normalized = email.trim().toLowerCase(); const ip = (context.ip || "unknown").slice(0, 64);
  const keys = throttleKeys(normalized, ip);
  await assertNotLocked(keys);
  const user = (await pool.query("SELECT * FROM users WHERE email=$1", [normalized])).rows[0];
  const usable = !!user && user.active !== false;
  const matches = await compare(password, usable ? user.password_hash : await dummyHash());
  if (!usable || !matches) { await recordFailure(keys); throw new ServiceError("FORBIDDEN", "Invalid email or password", 401); }
  await clearFailures(keys.filter((k) => k.scope !== "ip"));
  const token = randomBytes(32).toString("hex"); const expiresAt = new Date(Date.now() + sessionTtlHours() * 3600000);
  await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at,ip) VALUES($1,$2,$3,$4)", [sha256(token), user.id, expiresAt.toISOString(), ip]);
  await pool.query("UPDATE users SET last_login_at=now() WHERE id=$1", [user.id]);
  // Upgrade older/cheaper hashes transparently now that we hold the plaintext.
  if (getRounds(user.password_hash) < bcryptCost()) await pool.query("UPDATE users SET password_hash=$2 WHERE id=$1", [user.id, await hashPassword(password)]).catch(() => undefined);
  await purgeExpired().catch(() => undefined);
  return { token, session: rowSession(user, expiresAt) };
}

/** Valid only while: not past absolute expiry, not idle too long, user still active. Deactivation/password change deletes rows. */
export async function sessionFromToken(token: string | null | undefined): Promise<Session | null> {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const hashed = sha256(token);
  const row = (await pool.query(`SELECT u.*,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active AND s.last_seen_at>now()-($2*interval '1 minute')`, [hashed, sessionIdleMinutes()])).rows[0];
  if (!row) return null;
  await pool.query("UPDATE sessions SET last_seen_at=now() WHERE token_hash=$1 AND last_seen_at<now()-interval '1 minute'", [hashed]);
  return rowSession(row, row.expires_at);
}
export async function revokeToken(token: string | null | undefined) { if (token) await pool.query("DELETE FROM sessions WHERE token_hash=$1", [sha256(token)]); }
/** Revoke every session of a user, optionally keeping the one making the request. Returns number revoked. */
export async function revokeUserSessions(userId: string, keepToken?: string | null, client: DbClient = pool): Promise<number> {
  const result = await client.query("DELETE FROM sessions WHERE user_id=$1 AND ($2::text IS NULL OR token_hash<>$2)", [userId, keepToken ? sha256(keepToken) : null]);
  return result.rowCount ?? 0;
}
/** Deletes expired/idle sessions and stale throttle rows. Workers or login call it; safe to run any time. */
export async function purgeExpired(): Promise<{ sessions: number; throttles: number }> {
  const sessions = await pool.query("DELETE FROM sessions WHERE expires_at<now() OR last_seen_at<now()-($1*interval '1 minute')", [sessionIdleMinutes()]);
  const throttles = await pool.query("DELETE FROM login_throttle WHERE window_started_at<now()-($1*interval '1 minute') AND (locked_until IS NULL OR locked_until<now())", [THROTTLE_WINDOW_MINUTES * 4]);
  return { sessions: sessions.rowCount ?? 0, throttles: throttles.rowCount ?? 0 };
}
/** Throttle for the current-password check on change-password (same table, own scope). */
export async function throttlePasswordChange(userId: string, verify: () => Promise<boolean>): Promise<void> {
  const keys = [{ scope: "pwchange", key: tkey("pwchange", userId) }];
  await assertNotLocked(keys);
  if (!await verify()) { await recordFailure(keys, { pwchange: 5 }); throw new ServiceError("FORBIDDEN", "Current password is incorrect", 403); }
  await clearFailures(keys);
}
