import { describe, expect, it, vi } from 'vitest';
import { createVerify, generateKeyPairSync, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyTokenFailure, createTokenProvider, fileRefreshStore, FormPost, GOOGLE_TOKEN_ENDPOINT, MailboxConfigSchema, microsoftTokenEndpoint, pollMailbox, safeErrorCode, StatePort, TokenConfig, TokenError, imapMailbox, MailboxPort } from '../packages/mailbox';

const imap = vi.hoisted(() => ({ instances: [] as { options: Record<string, any> }[], connect: vi.fn(), mailboxOpen: vi.fn(), logout: vi.fn(), close: vi.fn() }));
vi.mock('imapflow', () => ({ ImapFlow: class {
  options: Record<string, any>;
  constructor(options: Record<string, any>) { this.options = options; imap.instances.push(this); }
  connect = imap.connect; mailboxOpen = imap.mailboxOpen; logout = imap.logout; close = imap.close; on = vi.fn();
} }));

const ok = (token: string, extra: Record<string, unknown> = {}) => ({ status: 200, body: { access_token: token, token_type: 'Bearer', expires_in: 3600, ...extra } });
const decode = (jwt: string) => { const [h, c] = jwt.split('.'); return { header: JSON.parse(Buffer.from(h, 'base64url').toString()), claims: JSON.parse(Buffer.from(c, 'base64url').toString()) }; };
const verify = (jwt: string, publicKey: import('node:crypto').KeyObject) => { const [h, c, s] = jwt.split('.'); return createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(s, 'base64url')); };
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privatePem = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const clock = (start = 1_800_000_000_000) => { let t = start; return { now: () => t, advance: (ms: number) => { t += ms; } }; };
const ms: TokenConfig = { authMode: 'oauth2-microsoft', user: 'orders@contoso.test', clientId: 'app-id', tenantId: 'tenant-1' };

describe('oauth2-microsoft client credentials', () => {
  it('posts the client-credentials grant with the Exchange .default scope and the tenant endpoint', async () => {
    const request = vi.fn<FormPost>().mockResolvedValue(ok('AT1'));
    const provider = createTokenProvider(ms, 'the-secret\n', { request });
    expect(await provider.getToken()).toBe('AT1');
    expect(request).toHaveBeenCalledWith(microsoftTokenEndpoint('tenant-1'), { grant_type: 'client_credentials', client_id: 'app-id', scope: 'https://outlook.office365.com/.default', client_secret: 'the-secret' }, expect.any(Number));
    expect(microsoftTokenEndpoint('tenant-1')).toBe('https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token');
  });
  it('signs a certificate assertion (RS256, x5t#S256 header, aud/iss/sub) instead of sending a secret', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pb-cert-'));
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${dir}/k.pem`, '-out', `${dir}/c.pem`, '-subj', '/CN=pb-test', '-days', '2'], { stdio: 'ignore' });
      const pem = readFileSync(`${dir}/k.pem`, 'utf8') + readFileSync(`${dir}/c.pem`, 'utf8');
      const cert = new X509Certificate(readFileSync(`${dir}/c.pem`));
      const request = vi.fn<FormPost>().mockResolvedValue(ok('AT'));
      await createTokenProvider({ ...ms, clientAuth: 'certificate' }, pem, { request }).getToken();
      const form = request.mock.calls[0][1];
      expect(form.client_secret).toBeUndefined();
      expect(form.client_assertion_type).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
      const { header, claims } = decode(form.client_assertion);
      expect(header).toMatchObject({ alg: 'RS256', typ: 'JWT', 'x5t#S256': Buffer.from(cert.fingerprint256.replace(/:/g, ''), 'hex').toString('base64url') });
      expect(claims).toMatchObject({ aud: microsoftTokenEndpoint('tenant-1'), iss: 'app-id', sub: 'app-id' });
      expect(verify(form.client_assertion, cert.publicKey)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('rejects a certificate credential without key and certificate', async () => {
    await expect(createTokenProvider({ ...ms, clientAuth: 'certificate' }, 'just text', { request: vi.fn() }).getToken()).rejects.toMatchObject({ code: 'token_failed' });
  });
});

describe('oauth2-google service account (domain-wide delegation)', () => {
  const key = JSON.stringify({ type: 'service_account', client_email: 'svc@proj.iam.gserviceaccount.com', private_key: privatePem, private_key_id: 'kid1' });
  const cfg: TokenConfig = { authMode: 'oauth2-google', user: 'orders@example.test' };
  it('sends a JWT-bearer grant impersonating the mailbox with the mail scope', async () => {
    const c = clock(); const request = vi.fn<FormPost>().mockResolvedValue(ok('GT'));
    expect(await createTokenProvider(cfg, key, { request, now: c.now }).getToken()).toBe('GT');
    const [url, form] = request.mock.calls[0];
    expect(url).toBe(GOOGLE_TOKEN_ENDPOINT); expect(form.grant_type).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const { header, claims } = decode(form.assertion);
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'kid1' });
    expect(claims).toEqual({ iss: 'svc@proj.iam.gserviceaccount.com', sub: 'orders@example.test', scope: 'https://mail.google.com/', aud: GOOGLE_TOKEN_ENDPOINT, iat: 1_800_000_000, exp: 1_800_003_000 });
    expect(verify(form.assertion, rsa.publicKey)).toBe(true);
  });
  it('honours impersonateUser and rejects malformed key files without leaking them', async () => {
    const request = vi.fn<FormPost>().mockResolvedValue(ok('GT'));
    await createTokenProvider({ ...cfg, impersonateUser: 'other@example.test' }, key, { request }).getToken();
    expect(decode(request.mock.calls[0][1].assertion).claims.sub).toBe('other@example.test');
    const error = await createTokenProvider(cfg, '{"client_email":"x","private_key":"-----BEGIN PRIVATE KEY-----nope"}'.padEnd(120, ' '), { request }).getToken().catch(e => e);
    expect(error).toBeInstanceOf(TokenError); expect(String(error.message + error.stack)).not.toContain('nope');
  });
});

describe('oauth2-refresh-token', () => {
  const cfg: TokenConfig = { authMode: 'oauth2-refresh-token', user: 'orders@gmail.test', clientId: 'cid', tokenEndpoint: 'https://idp.test/token' };
  const cred = JSON.stringify({ clientSecret: 'csec', refreshToken: 'RT0' });
  it('posts the refresh grant and persists a rotated refresh token for the next start', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pb-rt-'));
    try {
      const store = fileRefreshStore(path.join(dir, 'rt'));
      const request = vi.fn<FormPost>().mockResolvedValueOnce(ok('A1', { refresh_token: 'RT1' })).mockResolvedValueOnce(ok('A2'));
      const c = clock(); const provider = createTokenProvider(cfg, cred, { request, now: c.now, refreshStore: store });
      await provider.getToken();
      expect(request.mock.calls[0][1]).toEqual({ grant_type: 'refresh_token', refresh_token: 'RT0', client_id: 'cid', client_secret: 'csec' });
      expect(JSON.parse((await store.load())!).token).toBe('RT1');
      c.advance(3600_000); await provider.getToken();
      expect(request.mock.calls[1][1].refresh_token).toBe('RT1');
      // a restarted receiver prefers the stored, newer token
      const restarted = vi.fn<FormPost>().mockResolvedValue(ok('A3'));
      await createTokenProvider(cfg, cred, { request: restarted, refreshStore: store }).getToken();
      expect(restarted.mock.calls[0][1].refresh_token).toBe('RT1');
      // ...but a new refresh token installed in the credential file supersedes the stale rotated one
      const renewed = vi.fn<FormPost>().mockResolvedValue(ok('A4'));
      await createTokenProvider(cfg, JSON.stringify({ clientSecret: 'csec', refreshToken: 'RT-NEW' }), { request: renewed, refreshStore: store }).getToken();
      expect(renewed.mock.calls[0][1].refresh_token).toBe('RT-NEW');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('token cache and expiry', () => {
  it('reuses the token until shortly before expiry, then refreshes once even for concurrent callers', async () => {
    const c = clock(); const request = vi.fn<FormPost>().mockResolvedValueOnce(ok('T1', { expires_in: 3600 })).mockResolvedValueOnce(ok('T2'));
    const provider = createTokenProvider(ms, 's', { request, now: c.now });
    expect(await provider.getToken()).toBe('T1'); c.advance(3000_000); expect(await provider.getToken()).toBe('T1');
    expect(request).toHaveBeenCalledTimes(1);
    c.advance(545_000); // 3545 s: inside the 60 s refresh window
    expect(await Promise.all([provider.getToken(), provider.getToken()])).toEqual(['T2', 'T2']);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('invalidate() forces a new token, and very short lifetimes refresh at half-life', async () => {
    const c = clock(); const request = vi.fn<FormPost>().mockResolvedValueOnce(ok('T1', { expires_in: 10 })).mockResolvedValue(ok('T2'));
    const provider = createTokenProvider(ms, 's', { request, now: c.now });
    await provider.getToken(); c.advance(4000); expect(await provider.getToken()).toBe('T1'); c.advance(1500); expect(await provider.getToken()).toBe('T2');
    provider.invalidate(); await provider.getToken(); expect(request).toHaveBeenCalledTimes(3);
  });
});

describe('safe failures', () => {
  const failing = (status: number, body: unknown) => createTokenProvider(ms, 'TOP-SECRET', { request: vi.fn<FormPost>().mockResolvedValue({ status, body }), log: logged });
  const logged = vi.fn();
  it('maps provider errors to token_failed or consent_required without leaking text', async () => {
    await expect(failing(401, { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret TOP-SECRET' }).getToken()).rejects.toMatchObject({ code: 'token_failed' });
    await expect(failing(400, { error: 'invalid_grant', error_description: 'AADSTS65001: consent not granted' }).getToken()).rejects.toMatchObject({ code: 'consent_required' });
    await expect(failing(400, { error: 'unauthorized_client' }).getToken()).rejects.toMatchObject({ code: 'consent_required' });
    await expect(failing(503, 'maintenance').getToken()).rejects.toMatchObject({ code: 'token_failed' });
    await expect(failing(200, { token_type: 'Bearer' }).getToken()).rejects.toMatchObject({ code: 'token_failed' });
    await expect(createTokenProvider(ms, 's', { request: vi.fn<FormPost>().mockRejectedValue(new Error('getaddrinfo secret.host')) }).getToken()).rejects.toMatchObject({ code: 'token_failed' });
    expect(JSON.stringify(logged.mock.calls)).not.toContain('TOP-SECRET');
    expect(JSON.stringify(logged.mock.calls)).toContain('AADSTS7000215');
    expect(classifyTokenFailure('refresh', { error: 'invalid_grant' })).toBe('consent_required');
    expect(classifyTokenFailure('client', { error: 'invalid_grant' })).toBe('token_failed');
    expect(safeErrorCode(new TokenError('consent_required'))).toBe('consent_required');
  });
});

describe('configuration', () => {
  const base = { host: 'outlook.office365.com', user: 'orders@contoso.test' };
  it('keeps the original password config valid and defaults to password mode', () => {
    expect(MailboxConfigSchema.parse(base).authMode).toBe('password');
  });
  it('requires the fields each OAuth mode needs and only https token endpoints', () => {
    expect(() => MailboxConfigSchema.parse({ ...base, authMode: 'oauth2-microsoft', clientId: 'x' })).toThrow();
    expect(MailboxConfigSchema.parse({ ...base, authMode: 'oauth2-microsoft', clientId: 'x', tenantId: 'contoso.onmicrosoft.com' }).clientAuth).toBe('secret');
    expect(() => MailboxConfigSchema.parse({ ...base, authMode: 'oauth2-refresh-token', clientId: 'x', tokenEndpoint: 'http://idp.test/token' })).toThrow();
    expect(() => MailboxConfigSchema.parse({ ...base, authMode: 'oauth2-refresh-token', clientId: 'x' })).toThrow();
    expect(MailboxConfigSchema.parse({ ...base, authMode: 'oauth2-google' }).authMode).toBe('oauth2-google');
    expect(() => MailboxConfigSchema.parse({ ...base, clientSecret: 'no' })).toThrow();
  });
});

describe('IMAP adapter with OAuth', () => {
  const cfg = MailboxConfigSchema.parse({ host: 'imap.example.test', user: 'orders@example.test', authMode: 'oauth2-google' });
  const reset = () => { imap.instances.length = 0; imap.connect.mockReset(); imap.mailboxOpen.mockReset().mockResolvedValue({ uidValidity: 1n, uidNext: 5 }); imap.close.mockReset(); imap.logout.mockReset().mockResolvedValue(undefined); };
  const provider = (tokens: string[]) => { let i = 0; return { getToken: vi.fn(async () => tokens[Math.min(i++, tokens.length - 1)]), invalidate: vi.fn() }; };
  it('authenticates with auth.accessToken (never a password), verifies TLS and trusts an extra CA in addition to system roots', async () => {
    reset(); imap.connect.mockResolvedValue(undefined);
    const p = provider(['tok-1']); const box = imapMailbox(cfg, p, { extraCa: ['-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----'] });
    await box.open();
    const options = imap.instances[0].options;
    expect(options.auth).toEqual({ user: 'orders@example.test', accessToken: 'tok-1' });
    expect(options.tls.rejectUnauthorized).toBe(true); expect(options.tls.ca.length).toBeGreaterThan(50); expect(options.tls.ca.at(-1)).toContain('TEST');
  });
  it('retries once with a fresh token when the server rejects the cached one', async () => {
    reset(); imap.connect.mockRejectedValueOnce(Object.assign(new Error('NO secret'), { authenticationFailed: true })).mockResolvedValueOnce(undefined);
    const p = provider(['revoked', 'fresh']); await imapMailbox(cfg, p).open();
    expect(p.invalidate).toHaveBeenCalledTimes(1); expect(imap.instances.map(i => i.options.auth.accessToken)).toEqual(['revoked', 'fresh']);
  });
  it('raises imap_auth_failed when a fresh token is rejected too, and passes token errors through', async () => {
    reset(); imap.connect.mockRejectedValue(Object.assign(new Error('NO'), { authenticationFailed: true }));
    await expect(imapMailbox(cfg, provider(['a', 'b'])).open()).rejects.toThrow('imap_auth_failed');
    const failing = { getToken: vi.fn().mockRejectedValue(new TokenError('consent_required')), invalidate: vi.fn() };
    await expect(imapMailbox(cfg, failing).open()).rejects.toThrow('consent_required');
    expect(imap.connect).toHaveBeenCalledTimes(2);
  });
  it('feeds token_failed / consent_required into alert.json via the poll loop', async () => {
    const alert = vi.fn(async () => undefined); const state: StatePort = { load: async () => null, save: async () => undefined, quarantine: async () => undefined, alert };
    const mailbox = (code: 'token_failed' | 'consent_required'): MailboxPort => ({ open: async () => { throw new TokenError(code); }, list: async () => [], raw: async () => Buffer.alloc(0), close: async () => undefined });
    const log = vi.fn();
    for (const code of ['token_failed', 'consent_required'] as const) {
      await expect(pollMailbox(cfg, mailbox(code), state, async () => undefined, { log, now: () => new Date('2026-10-29T00:00:00Z') })).rejects.toThrow(code);
      expect(alert).toHaveBeenLastCalledWith({ code, at: '2026-10-29T00:00:00.000Z' });
    }
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: 'mailbox.alert', code: 'consent_required' }));
  });
});
