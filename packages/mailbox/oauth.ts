import { createHash, createPrivateKey, createSign, randomUUID, X509Certificate } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import https from 'node:https';
import { rootCertificates } from 'node:tls';
import path from 'node:path';
import { z } from 'zod';

/**
 * OAuth2 access tokens for IMAP (SASL XOAUTH2 / OAUTHBEARER) without any interactive consent step:
 *  - oauth2-microsoft: Entra client-credentials grant (client secret or certificate assertion), scope https://outlook.office365.com/.default
 *  - oauth2-google: service account with domain-wide delegation, JWT-bearer grant impersonating the mailbox
 *  - oauth2-refresh-token: generic refresh-token grant for any other provider
 * Secrets arrive as file contents and are never logged or placed in error messages; only the codes below leave this module.
 */
export const AUTH_MODES = ['password', 'oauth2-microsoft', 'oauth2-google', 'oauth2-refresh-token'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];
export type OAuthMode = Exclude<AuthMode, 'password'>;

export const MICROSOFT_IMAP_SCOPE = 'https://outlook.office365.com/.default';
export const GOOGLE_MAIL_SCOPE = 'https://mail.google.com/';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const microsoftTokenEndpoint = (tenantId: string) => `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;

/** Failures that are the operator's to fix; the receiver turns them into alert.json entries. */
export class TokenError extends Error {
  constructor(public readonly code: 'token_failed' | 'consent_required') { super(code); }
}
export interface TokenProvider {
  /** A currently valid access token; refreshes it first when it is expired or about to expire. */
  getToken(): Promise<string>;
  /** Forget the cached token (the server rejected it, e.g. it was revoked). */
  invalidate(): void;
}
export type TokenConfig = {
  authMode: OAuthMode; user: string; clientId?: string; tenantId?: string; clientAuth?: 'secret' | 'certificate';
  tokenEndpoint?: string; scope?: string; impersonateUser?: string;
};
export type FormPost = (url: string, form: Record<string, string>, timeoutMs: number) => Promise<{ status: number; body: unknown }>;
export type RefreshTokenStore = { load(): Promise<string | null>; save(token: string): Promise<void> };
export type TokenOptions = { request?: FormPost; now?: () => number; log?: (event: Record<string, unknown>) => void; refreshStore?: RefreshTokenStore; timeoutMs?: number };

const b64url = (input: Buffer | string) => Buffer.from(input).toString('base64url');

/** HTTPS only. `extraCa` is added to the system roots (certificate verification stays on). */
export function httpsFormPost(extraCa: string[] = []): FormPost {
  const ca = extraCa.length ? [...rootCertificates, ...extraCa] : undefined;
  return (url, form, timeoutMs) => new Promise((resolve, reject) => {
    let target: URL;
    try { target = new URL(url); } catch { reject(new TokenError('token_failed')); return; }
    if (target.protocol !== 'https:' || target.username || target.password) { reject(new TokenError('token_failed')); return; }
    const payload = Buffer.from(new URLSearchParams(form).toString());
    const req = https.request(target, { method: 'POST', ca, rejectUnauthorized: true, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': payload.length, Accept: 'application/json' } }, res => {
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 65536) { req.destroy(); reject(new TokenError('token_failed')); return; } chunks.push(chunk); });
      res.on('end', () => { let body: unknown = null; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* non-JSON error page */ } resolve({ status: res.statusCode ?? 0, body }); });
      res.on('error', () => reject(new TokenError('token_failed')));
    });
    req.setTimeout(timeoutMs, () => req.destroy());
    req.on('error', () => reject(new TokenError('token_failed')));
    req.end(payload);
  });
}

function signJwt(header: Record<string, unknown>, claims: Record<string, unknown>, privateKeyPem: string): string {
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  let signature: Buffer;
  try {
    const key = createPrivateKey(privateKeyPem);
    if (key.asymmetricKeyType !== 'rsa') throw new Error('not rsa');
    signature = createSign('RSA-SHA256').update(signingInput).sign(key);
  } catch { throw new TokenError('token_failed'); }
  return `${signingInput}.${b64url(signature)}`;
}

const pemBlock = (text: string, label: string) => text.match(new RegExp(`-----BEGIN ${label}-----[\\s\\S]*?-----END ${label}-----`))?.[0];
const ServiceAccountSchema = z.object({ client_email: z.string().min(3), private_key: z.string().min(50), private_key_id: z.string().optional() }).loose();
const RefreshSecretSchema = z.object({ refreshToken: z.string().min(1), clientSecret: z.string().optional() }).strict();

/** Safe, bounded detail for logs: only the OAuth `error` token and Microsoft AADSTS number, never free text. */
function errorDetail(body: unknown): { error?: string; aadsts?: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const error = typeof b.error === 'string' && /^[a-z_]{1,40}$/.test(b.error) ? b.error : undefined;
  const aadsts = typeof b.error_description === 'string' ? b.error_description.match(/AADSTS\d{4,7}/)?.[0] : undefined;
  return { error, aadsts };
}
const CONSENT_ERRORS = new Set(['consent_required', 'interaction_required', 'unauthorized_client', 'access_denied']);
const CONSENT_AADSTS = new Set(['AADSTS65001', 'AADSTS65004', 'AADSTS500011', 'AADSTS700016', 'AADSTS50105']);
export function classifyTokenFailure(grant: 'client' | 'refresh', body: unknown): 'token_failed' | 'consent_required' {
  const { error, aadsts } = errorDetail(body);
  if (error && CONSENT_ERRORS.has(error)) return 'consent_required';
  if (aadsts && CONSENT_AADSTS.has(aadsts)) return 'consent_required';
  // A revoked/expired refresh token can only be fixed by a person signing in again.
  if (grant === 'refresh' && error === 'invalid_grant') return 'consent_required';
  return 'token_failed';
}

export function createTokenProvider(config: TokenConfig, credential: string, options: TokenOptions = {}): TokenProvider {
  const request = options.request ?? httpsFormPost();
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);
  const timeoutMs = options.timeoutMs ?? 20000;
  const scope = config.scope ?? (config.authMode === 'oauth2-google' ? GOOGLE_MAIL_SCOPE : config.authMode === 'oauth2-microsoft' ? MICROSOFT_IMAP_SCOPE : undefined);
  const endpoint = config.tokenEndpoint ?? (config.authMode === 'oauth2-google' ? GOOGLE_TOKEN_ENDPOINT : config.authMode === 'oauth2-microsoft' && config.tenantId ? microsoftTokenEndpoint(config.tenantId) : undefined);
  if (!endpoint || !credential.trim()) throw new TokenError('token_failed');
  let cached: { token: string; expiresAt: number; lifetimeMs: number } | null = null;
  let inflight: Promise<string> | null = null;
  let refreshToken: string | null = null;
  let refreshSecret: string | undefined;
  let refreshBase = '';

  const buildGrant = async (): Promise<{ form: Record<string, string>; kind: 'client' | 'refresh' }> => {
    const epochSeconds = Math.floor(now() / 1000);
    if (config.authMode === 'oauth2-microsoft') {
      if (!config.clientId) throw new TokenError('token_failed');
      const form: Record<string, string> = { grant_type: 'client_credentials', client_id: config.clientId, scope: scope! };
      if (config.clientAuth === 'certificate') {
        const keyPem = pemBlock(credential, 'PRIVATE KEY') ?? pemBlock(credential, 'RSA PRIVATE KEY'); const certPem = pemBlock(credential, 'CERTIFICATE');
        if (!keyPem || !certPem) throw new TokenError('token_failed');
        let digest: Buffer;
        try { digest = createHash('sha256').update(new X509Certificate(certPem).raw).digest(); } catch { throw new TokenError('token_failed'); }
        const sha1 = createHash('sha1').update(new X509Certificate(certPem).raw).digest();
        form.client_assertion_type = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
        form.client_assertion = signJwt({ alg: 'RS256', typ: 'JWT', 'x5t#S256': b64url(digest), x5t: b64url(sha1) },
          { aud: endpoint, iss: config.clientId, sub: config.clientId, jti: randomUUID(), nbf: epochSeconds - 30, exp: epochSeconds + 540 }, keyPem);
      } else form.client_secret = credential.trim();
      return { form, kind: 'client' };
    }
    if (config.authMode === 'oauth2-google') {
      let account: z.infer<typeof ServiceAccountSchema>;
      try { account = ServiceAccountSchema.parse(JSON.parse(credential)); } catch { throw new TokenError('token_failed'); }
      const assertion = signJwt({ alg: 'RS256', typ: 'JWT', ...(account.private_key_id ? { kid: account.private_key_id } : {}) },
        { iss: account.client_email, sub: config.impersonateUser ?? config.user, scope, aud: endpoint, iat: epochSeconds, exp: epochSeconds + 3000 }, account.private_key);
      return { form: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }, kind: 'client' };
    }
    // oauth2-refresh-token
    if (refreshToken === null) {
      let secret: z.infer<typeof RefreshSecretSchema>;
      try { secret = RefreshSecretSchema.parse(JSON.parse(credential)); } catch { throw new TokenError('token_failed'); }
      refreshSecret = secret.clientSecret;
      // A rotated token saved by an earlier run supersedes the one in the credential file.
      // Only if it descends from the token currently in the credential file: a freshly installed refresh token must win over a stale rotated one.
      refreshBase = createHash('sha256').update(secret.refreshToken).digest('hex').slice(0, 16);
      let stored: { base?: string; token?: string } = {};
      try { stored = JSON.parse((await options.refreshStore?.load()) ?? '{}'); } catch { /* unreadable: ignore */ }
      refreshToken = stored.base === refreshBase && stored.token ? stored.token : secret.refreshToken;
    }
    const form: Record<string, string> = { grant_type: 'refresh_token', refresh_token: refreshToken };
    if (config.clientId) form.client_id = config.clientId;
    if (refreshSecret) form.client_secret = refreshSecret;
    if (scope) form.scope = scope;
    return { form, kind: 'refresh' };
  };

  const fetchToken = async (): Promise<string> => {
    const { form, kind } = await buildGrant();
    let response: { status: number; body: unknown };
    try { response = await request(endpoint, form, timeoutMs); }
    catch (error) { log({ event: 'mailbox.token_request_failed', level: 'error', mode: config.authMode }); throw error instanceof TokenError ? error : new TokenError('token_failed'); }
    const body = (response.body && typeof response.body === 'object' ? response.body : {}) as Record<string, unknown>;
    const lifetime = typeof body.expires_in === 'number' ? body.expires_in : Number(body.expires_in ?? 3600);
    if (response.status !== 200 || typeof body.access_token !== 'string' || !body.access_token || /[\s\x00-\x1f]/.test(body.access_token) || (typeof body.token_type === 'string' && body.token_type.toLowerCase() !== 'bearer') || !(lifetime > 0)) {
      const code = response.status === 200 ? 'token_failed' : classifyTokenFailure(kind, response.body);
      log({ event: 'mailbox.token_request_failed', level: 'error', mode: config.authMode, httpStatus: response.status, ...errorDetail(response.body) });
      throw new TokenError(code);
    }
    if (kind === 'refresh' && typeof body.refresh_token === 'string' && body.refresh_token && body.refresh_token !== refreshToken) {
      refreshToken = body.refresh_token;
      await options.refreshStore?.save(JSON.stringify({ base: refreshBase, token: refreshToken })).catch(() => log({ event: 'mailbox.refresh_token_not_saved', level: 'warn' }));
    }
    cached = { token: body.access_token, expiresAt: now() + lifetime * 1000, lifetimeMs: lifetime * 1000 };
    log({ event: 'mailbox.token_acquired', mode: config.authMode, expiresInSeconds: Math.round(lifetime) });
    return cached.token;
  };

  return {
    async getToken() {
      // Refresh early: 60 s before expiry, or halfway through very short lifetimes.
      if (cached && now() < cached.expiresAt - Math.min(60000, cached.lifetimeMs / 2)) return cached.token;
      inflight ??= fetchToken().finally(() => { inflight = null; });
      return inflight;
    },
    invalidate() { cached = null; },
  };
}

/** Rotated refresh tokens live in the (writable) state volume, 0600, replaced atomically. */
export function fileRefreshStore(filename: string): RefreshTokenStore {
  return {
    async load() { try { const value = (await readFile(filename, 'utf8')).trim(); return value || null; } catch { return null; } },
    async save(token) {
      await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      const temporary = `${filename}.${randomUUID()}.tmp`;
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(token); await file.sync(); } finally { await file.close(); }
      await rename(temporary, filename);
    },
  };
}
