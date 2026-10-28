import { z } from "zod";
import type { Session } from "@pennbridge/contracts";
import { audit, id, pool, transaction } from "@pennbridge/db";
import { ServiceError } from "@pennbridge/domain";
import { assertPasswordPolicy, hashPassword, revokeUserSessions, throttlePasswordChange } from "./auth";
import { compare } from "bcryptjs";

/** Request schemas for the user-admin API (defined here, not in contracts, to keep contracts single-owner). */
export const ManagedRoleSchema = z.enum(["viewer", "reviewer", "admin"]);
export const CreateUserRequestSchema = z.object({ email: z.string().trim().toLowerCase().email().max(320), name: z.string().trim().min(1).max(200), role: ManagedRoleSchema, password: z.string().min(1).max(256) }).strict();
export const UpdateUserRequestSchema = z.object({ name: z.string().trim().min(1).max(200).optional(), role: ManagedRoleSchema.optional(), active: z.boolean().optional() }).strict().refine((v) => Object.keys(v).length > 0, "Nothing to update");
export const SetPasswordRequestSchema = z.object({ password: z.string().min(1).max(256) }).strict();
export const ChangePasswordRequestSchema = z.object({ currentPassword: z.string().min(1).max(256), newPassword: z.string().min(1).max(256) }).strict();
export type CreateUserRequest = z.infer<typeof CreateUserRequestSchema>;
export type UpdateUserRequest = z.infer<typeof UpdateUserRequestSchema>;

export type ManagedUser = { id: string; email: string; name: string; role: Session["role"]; active: boolean; createdAt: string; lastLoginAt: string | null; passwordChangedAt: string | null; activeSessions: number };
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
const userFromRow = (r: any): ManagedUser => ({ id: r.id, email: r.email, name: r.name, role: r.role, active: r.active, createdAt: iso(r.created_at)!, lastLoginAt: iso(r.last_login_at), passwordChangedAt: iso(r.password_changed_at), activeSessions: Number(r.active_sessions ?? 0) });
const USER_SELECT = "SELECT u.*,(SELECT count(*) FROM sessions s WHERE s.user_id=u.id AND s.expires_at>now()) AS active_sessions FROM users u";

export function requireAdmin(actor: Session | null): Session {
  if (!actor) throw new ServiceError("FORBIDDEN", "Login required", 401);
  if (actor.role !== "admin") throw new ServiceError("FORBIDDEN", "Administrator access required", 403);
  return actor;
}

export async function listUsers(actor: Session): Promise<ManagedUser[]> {
  requireAdmin(actor);
  return (await pool.query(`${USER_SELECT} WHERE u.role<>'ingestion' ORDER BY u.active DESC,lower(u.name),u.email`)).rows.map(userFromRow);
}
export async function getUser(actor: Session, userId: string): Promise<ManagedUser> {
  requireAdmin(actor);
  const row = (await pool.query(`${USER_SELECT} WHERE u.id=$1`, [userId])).rows[0];
  if (!row) throw new ServiceError("NOT_FOUND", "User not found", 404);
  return userFromRow(row);
}
/** Shared by the admin API and the bootstrap CLI. `actorId` is recorded in the audit trail. */
export async function insertUser(input: CreateUserRequest, actorId: string): Promise<ManagedUser> {
  assertPasswordPolicy(input.password, { email: input.email, name: input.name });
  const passwordHash = await hashPassword(input.password); const userId = id("usr");
  try {
    await transaction(async (client) => {
      await client.query("INSERT INTO users(id,email,name,role,password_hash,password_changed_at) VALUES($1,$2,$3,$4,$5,now())", [userId, input.email, input.name, input.role, passwordHash]);
      await audit(client, null, actorId, "user.created", null, { userId, email: input.email, role: input.role });
    });
  } catch (e: any) {
    if (e.code === "23505") throw new ServiceError("VALIDATION_FAILED", "A user with this email already exists", 409);
    throw e;
  }
  return userFromRow((await pool.query(`${USER_SELECT} WHERE u.id=$1`, [userId])).rows[0]);
}
export async function createUser(actor: Session, input: CreateUserRequest): Promise<ManagedUser> {
  requireAdmin(actor); return insertUser(CreateUserRequestSchema.parse(input), actor.userId);
}

/** Update name/role/active. The last active administrator can be neither demoted nor deactivated. */
export async function updateUser(actor: Session, userId: string, input: UpdateUserRequest): Promise<ManagedUser> {
  requireAdmin(actor); input = UpdateUserRequestSchema.parse(input);
  await transaction(async (client) => {
    // Lock all admin rows so two concurrent demotions cannot both pass the last-admin check.
    await client.query("SELECT id FROM users WHERE role='admin' FOR UPDATE");
    const current = (await client.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [userId])).rows[0];
    if (!current || current.role === "ingestion") throw new ServiceError("NOT_FOUND", "User not found", 404);
    const role = input.role ?? current.role; const active = input.active ?? current.active;
    if (current.role === "admin" && current.active && (role !== "admin" || !active)) {
      const others = Number((await client.query("SELECT count(*) FROM users WHERE role='admin' AND active AND id<>$1", [userId])).rows[0].count);
      if (!others) throw new ServiceError("VALIDATION_FAILED", "At least one active administrator must remain", 409);
    }
    await client.query("UPDATE users SET name=$2,role=$3,active=$4,updated_at=now() WHERE id=$1", [userId, input.name ?? current.name, role, active]);
    // Role/status change takes effect immediately: existing sessions are revoked.
    if (role !== current.role || (!active && current.active)) await revokeUserSessions(userId, null, client);
    const detail: Record<string, string | boolean> = {};
    if (input.name !== undefined && input.name !== current.name) detail.name = input.name;
    if (role !== current.role) { detail.role = role; detail.previousRole = current.role; }
    if (active !== current.active) detail.active = active;
    await audit(client, null, actor, active !== current.active ? (active ? "user.reactivated" : "user.deactivated") : "user.updated", null, { userId, ...detail });
  });
  return getUser(actor, userId);
}
export const deactivateUser = (actor: Session, userId: string) => updateUser(actor, userId, { active: false });

/** Administrator reset: sets a new password and signs the user out everywhere. */
export async function setUserPassword(actor: Session, userId: string, password: string): Promise<{ revokedSessions: number }> {
  requireAdmin(actor); password = SetPasswordRequestSchema.parse({ password }).password;
  const user = (await pool.query("SELECT email,name,role FROM users WHERE id=$1", [userId])).rows[0];
  if (!user || user.role === "ingestion") throw new ServiceError("NOT_FOUND", "User not found", 404);
  assertPasswordPolicy(password, user);
  const passwordHash = await hashPassword(password);
  return transaction(async (client) => {
    await client.query("UPDATE users SET password_hash=$2,password_changed_at=now(),updated_at=now() WHERE id=$1", [userId, passwordHash]);
    const revokedSessions = await revokeUserSessions(userId, null, client);
    await audit(client, null, actor, "user.password_reset", null, { userId });
    return { revokedSessions };
  });
}
export async function revokeSessionsFor(actor: Session, userId: string): Promise<{ revokedSessions: number }> {
  requireAdmin(actor); return { revokedSessions: await revokeUserSessions(userId) };
}

/** A user may always change their own password. Other sessions are revoked; the current token (if given) survives. */
export async function changeOwnPassword(actor: Session | null, currentPassword: string, newPassword: string, currentToken?: string | null): Promise<{ revokedSessions: number }> {
  if (!actor) throw new ServiceError("FORBIDDEN", "Login required", 401);
  const user = (await pool.query("SELECT * FROM users WHERE id=$1 AND active", [actor.userId])).rows[0];
  if (!user || user.role === "ingestion") throw new ServiceError("FORBIDDEN", "Password change is not available for this account", 403);
  await throttlePasswordChange(user.id, () => compare(currentPassword, user.password_hash));
  if (currentPassword === newPassword) throw new ServiceError("VALIDATION_FAILED", "New password must differ from the current password", 400);
  assertPasswordPolicy(newPassword, user);
  const passwordHash = await hashPassword(newPassword);
  return transaction(async (client) => {
    await client.query("UPDATE users SET password_hash=$2,password_changed_at=now(),updated_at=now() WHERE id=$1", [user.id, passwordHash]);
    const revokedSessions = await revokeUserSessions(user.id, currentToken ?? null, client);
    await audit(client, null, actor, "user.password_changed", null, { userId: user.id });
    return { revokedSessions };
  });
}

export async function activeAdminCount(): Promise<number> {
  return Number((await pool.query("SELECT count(*) FROM users WHERE role='admin' AND active")).rows[0].count);
}
