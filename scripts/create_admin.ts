#!/usr/bin/env tsx
/**
 * First-run administrator bootstrap (and lost-admin recovery). Run on the server with DATABASE_URL set:
 *   npx tsx scripts/create_admin.ts --email you@company.com --name "Your Name"
 * The password is never accepted as an argument. Provide it via an interactive prompt, --password-file <path>, or ADMIN_PASSWORD.
 *   --reset              set a new password for an existing user (and sign them out everywhere)
 *   --allow-additional   create another admin although one already exists
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { migrate, pool, transaction, audit } from "../packages/db/index";
import { activeAdminCount, insertUser } from "../packages/server/admin";
import { assertPasswordPolicy, hashPassword, revokeUserSessions } from "../packages/server/auth";

function promptHidden(label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) return reject(new Error("No terminal available: use --password-file or ADMIN_PASSWORD"));
    process.stdout.write(label); process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding("utf8");
    let value = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off("data", onData); process.stdout.write("\n"); return resolve(value); }
        if (ch === "\u0003") { process.stdin.setRawMode(false); return reject(new Error("Cancelled")); }
        if (ch === "\u007f") value = value.slice(0, -1); else value += ch;
      }
    };
    process.stdin.on("data", onData);
  });
}
async function readPassword(file?: string): Promise<string> {
  if (file) return (await readFile(file, "utf8")).replace(/\r?\n$/, "");
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  const first = await promptHidden("New password (min 12 characters): ");
  if (first !== await promptHidden("Repeat password: ")) throw new Error("Passwords do not match");
  return first;
}

async function main() {
  const { values } = parseArgs({ options: { email: { type: "string" }, name: { type: "string" }, "password-file": { type: "string" }, reset: { type: "boolean" }, "allow-additional": { type: "boolean" } } });
  const email = values.email?.trim().toLowerCase();
  if (!email) throw new Error("--email is required");
  await migrate();
  const password = await readPassword(values["password-file"]);
  if (values.reset) {
    const user = (await pool.query("SELECT id,name FROM users WHERE email=$1", [email])).rows[0];
    if (!user) throw new Error(`No user ${email}`);
    assertPasswordPolicy(password, { email, name: user.name });
    const passwordHash = await hashPassword(password);
    await transaction(async (client) => {
      await client.query("UPDATE users SET password_hash=$2,password_changed_at=now(),updated_at=now(),active=true WHERE id=$1", [user.id, passwordHash]);
      await revokeUserSessions(user.id, null, client);
      await audit(client, null, "cli:create_admin", "user.password_reset", null, { userId: user.id, via: "cli" });
    });
    console.log(`Password reset for ${email}; all sessions revoked.`);
    return;
  }
  if (!values.name?.trim()) throw new Error("--name is required");
  if (await activeAdminCount() > 0 && !values["allow-additional"]) throw new Error("An administrator already exists. Use the Users page, --reset, or --allow-additional.");
  const user = await insertUser({ email, name: values.name.trim(), role: "admin", password }, "cli:create_admin");
  console.log(`Created administrator ${user.email} (${user.id}).`);
}
main().then(() => pool.end(), (e) => { console.error(`create_admin: ${e.message}`); process.exitCode = 1; return pool.end(); });
