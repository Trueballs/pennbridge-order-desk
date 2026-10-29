import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The proxy entrypoint turns PB_ACME_* into Caddy global options. /tmp/acme-options.conf is its fixed output path (a tmpfs in the container).
const entry = path.resolve(__dirname, "../infra/caddy/entrypoint.sh");
const run = (env: Record<string, string>) => {
  const bin = mkdtempSync(path.join(tmpdir(), "pb-caddy-"));
  writeFileSync(path.join(bin, "caddy"), "#!/bin/sh\necho caddy-started \"$@\"\n"); chmodSync(path.join(bin, "caddy"), 0o755);
  const r = spawnSync("sh", [entry], { env: { PATH: `${bin}:/usr/bin:/bin`, ...env } as unknown as NodeJS.ProcessEnv, encoding: "utf8" });
  return { ...r, conf: existsSync("/tmp/acme-options.conf") ? readFileSync("/tmp/acme-options.conf", "utf8") : "" };
};
describe("proxy ACME options", () => {
  it("writes nothing by default, so Caddy keeps Let's Encrypt production", () => {
    const r = run({});
    expect(r.status).toBe(0); expect(r.stdout).toContain("caddy-started run --config /etc/caddy/Caddyfile"); expect(r.conf).toBe("");
  });
  it("maps email, the staging alias and a private CA root", () => {
    const r = run({ PB_ACME_EMAIL: "ops@example.org", PB_ACME_CA: "staging", PB_ACME_CA_ROOT: "/certs/acme-ca-root.pem" });
    expect(r.conf).toBe("email ops@example.org\nacme_ca https://acme-staging-v02.api.letsencrypt.org/directory\nacme_ca_root /certs/acme-ca-root.pem\n");
  });
  it("passes a full directory URL through", () => expect(run({ PB_ACME_CA: "https://pebble:14000/dir" }).conf).toBe("acme_ca https://pebble:14000/dir\n"));
  it("refuses values that could inject Caddyfile syntax", () => {
    for (const bad of ["a b", "x}\nhandle", 'q"q', "br{ace"]) {
      const r = run({ PB_ACME_CA: bad }); expect(r.status).toBe(64); expect(r.stderr).toContain("PB_ACME_CA");
    }
  });
  it("keeps the config and compose wiring in place", () => {
    const root = path.resolve(__dirname, "..");
    expect(readFileSync(path.join(root, "infra/caddy/Caddyfile"), "utf8")).toContain("import /tmp/acme-options.conf");
    const compose = readFileSync(path.join(root, "infra/compose.prod.yaml"), "utf8");
    for (const k of ["PB_ACME_EMAIL", "PB_ACME_CA:", "PB_ACME_CA_ROOT", "entrypoint.sh:/entrypoint.sh:ro"]) expect(compose).toContain(k);
  });
});
