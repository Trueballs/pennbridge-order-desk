// Test-only mock identity provider + desk intake for scripts/test_mailbox_oauth.sh. Synthetic; never deploy.
//  https :8443  token endpoint (client-credentials w/ secret or certificate assertion, Google JWT-bearer, refresh-token)
//  http  :8080  /introspect (Dovecot oauth2 passdb) and /api/intake (stands in for the desk, 202 on valid bearer)
//  http  :9000  /_ctl/* test control (state, set, revoke)
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { createHash, createPublicKey, createVerify, randomBytes, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';

const cfg = JSON.parse(readFileSync('/fixtures/clients.json', 'utf8'));
const INTAKE_TOKEN = readFileSync('/fixtures/intake-token', 'utf8').trim();
const MAILBOX = cfg.mailbox;
const ctl = { expiresIn: 3600, denyMailbox: false, tokenError: null, rotateRefresh: false };
const grants = { microsoft_secret: 0, microsoft_certificate: 0, google: 0, refresh: 0, rejected: 0 };
const tokens = new Map(); // token -> {email, exp, revoked}
const intake = [];
let refreshToken = cfg.refresh.refreshToken;
const log = event => console.log(JSON.stringify({ t: new Date().toISOString(), ...event }));
const body = req => new Promise(r => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => r(Buffer.concat(c).toString())); });
const send = (res, status, json) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
const b64u = s => Buffer.from(s, 'base64url');

function verifyJwt(jwt, publicKey, wantAud) {
  const [h, c, s] = String(jwt).split('.');
  if (!s) return null;
  if (!createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, b64u(s))) return null;
  const header = JSON.parse(b64u(h).toString()), claims = JSON.parse(b64u(c).toString());
  const now = Date.now() / 1000;
  if (header.alg !== 'RS256' || claims.aud !== wantAud || claims.exp < now || (claims.nbf ?? claims.iat ?? 0) > now + 60) return null;
  return { header, claims };
}
function issue(email, kind) {
  const token = `${kind}.${randomBytes(24).toString('base64url')}`;
  tokens.set(token, { email, exp: Date.now() + ctl.expiresIn * 1000, revoked: false });
  return token;
}
const fail = (res, status, error, error_description) => { grants.rejected++; log({ event: 'token_rejected', error }); send(res, status, { error, error_description }); };

const tokenServer = httpsServer({ key: readFileSync('/tls/server.key'), cert: readFileSync('/tls/server.crt') }, async (req, res) => {
  const form = new URLSearchParams(await body(req));
  const url = new URL(req.url, 'https://login.pb-test:8443');
  const endpoint = `https://login.pb-test:8443${url.pathname}`;
  if (req.method !== 'POST') return send(res, 405, { error: 'invalid_request' });
  if (ctl.tokenError === 'invalid_client') return fail(res, 401, 'invalid_client', 'AADSTS7000215: Invalid client secret provided.');
  if (ctl.tokenError === 'consent') return fail(res, 400, 'invalid_grant', 'AADSTS65001: The user or administrator has not consented.');
  const grant = form.get('grant_type');
  const reply = (email, kind, extra = {}) => send(res, 200, { token_type: 'Bearer', expires_in: ctl.expiresIn, access_token: issue(email, kind), ...extra });
  if (url.pathname === `/${cfg.microsoft.tenant}/oauth2/v2.0/token` && grant === 'client_credentials') {
    if (form.get('client_id') !== cfg.microsoft.clientId || form.get('scope') !== 'https://outlook.office365.com/.default') return fail(res, 400, 'invalid_request', 'wrong client or scope');
    if (form.get('client_secret')) {
      if (form.get('client_secret') !== cfg.microsoft.secret) return fail(res, 401, 'invalid_client', 'bad secret');
      grants.microsoft_secret++; log({ event: 'grant', kind: 'microsoft_secret' }); return reply(MAILBOX, 'ms');
    }
    if (form.get('client_assertion_type') === 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer') {
      const cert = new X509Certificate(cfg.microsoft.certPem);
      const ok = verifyJwt(form.get('client_assertion'), cert.publicKey, endpoint);
      const thumb = createHash('sha256').update(cert.raw).digest('base64url');
      if (!ok || ok.header['x5t#S256'] !== thumb || ok.claims.iss !== cfg.microsoft.clientId || ok.claims.sub !== cfg.microsoft.clientId) return fail(res, 401, 'invalid_client', 'bad assertion');
      grants.microsoft_certificate++; log({ event: 'grant', kind: 'microsoft_certificate' }); return reply(MAILBOX, 'ms');
    }
    return fail(res, 400, 'invalid_request', 'no client authentication');
  }
  if (url.pathname === '/google/token' && grant === 'urn:ietf:params:oauth:grant-type:jwt-bearer') {
    const ok = verifyJwt(form.get('assertion'), createPublicKey(cfg.google.publicKeyPem), endpoint);
    if (!ok || ok.claims.iss !== cfg.google.email || ok.header.kid !== cfg.google.keyId || ok.claims.scope !== 'https://mail.google.com/' || ok.claims.exp - ok.claims.iat > 3600) return fail(res, 400, 'invalid_grant', 'Invalid JWT');
    if (ok.claims.sub !== MAILBOX) return fail(res, 400, 'unauthorized_client', 'Client is unauthorized to retrieve access tokens using this method');
    grants.google++; log({ event: 'grant', kind: 'google' }); return reply(ok.claims.sub, 'gg');
  }
  if (url.pathname === '/idp/token' && grant === 'refresh_token') {
    if (form.get('client_id') !== cfg.refresh.clientId || form.get('client_secret') !== cfg.refresh.clientSecret) return fail(res, 401, 'invalid_client', 'bad client');
    if (form.get('refresh_token') !== refreshToken) return fail(res, 400, 'invalid_grant', 'Token has been expired or revoked.');
    grants.refresh++; log({ event: 'grant', kind: 'refresh' });
    if (ctl.rotateRefresh) { refreshToken = `rt.${randomBytes(12).toString('hex')}`; return reply(MAILBOX, 'rt', { refresh_token: refreshToken }); }
    return reply(MAILBOX, 'rt');
  }
  return fail(res, 400, 'unsupported_grant_type', 'unknown endpoint or grant');
});

const apiServer = httpServer(async (req, res) => {
  const raw = await body(req);
  if (req.url === '/introspect') {
    const token = new URLSearchParams(raw).get('token');
    const entry = tokens.get(token);
    const active = !!entry && !entry.revoked && entry.exp > Date.now() && !ctl.denyMailbox;
    log({ event: 'introspect', active });
    return send(res, 200, active ? { active: true, email: entry.email, exp: Math.floor(entry.exp / 1000), scope: 'imap' } : { active: false });
  }
  if (req.url === '/api/intake') {
    if (req.headers.authorization !== `Bearer ${INTAKE_TOKEN}`) return send(res, 401, { error: 'unauthorized' });
    const input = JSON.parse(raw); const mime = Buffer.from(input.contentBase64, 'base64').toString('utf8');
    intake.push({ filename: input.filename, channel: input.channel, externalMessageId: input.externalMessageId, subject: mime.match(/^Subject: (.*)$/m)?.[1] ?? null, bodyHasMarker: mime.includes('SYNTHETIC-OAUTH-TEST') });
    log({ event: 'intake', filename: input.filename });
    return send(res, 202, { ok: true });
  }
  send(res, 404, {});
});

const controlServer = httpServer(async (req, res) => {
  const raw = await body(req);
  if (req.url === '/_ctl/state') return send(res, 200, { grants, intake, ctl, activeTokens: [...tokens.values()].filter(t => !t.revoked && t.exp > Date.now()).length });
  if (req.url === '/_ctl/set') { Object.assign(ctl, JSON.parse(raw || '{}')); return send(res, 200, ctl); }
  if (req.url === '/_ctl/revoke') { for (const t of tokens.values()) t.revoked = true; return send(res, 200, { revoked: tokens.size }); }
  if (req.url === '/_ctl/reset') { for (const k of Object.keys(grants)) grants[k] = 0; intake.length = 0; Object.assign(ctl, { expiresIn: 3600, denyMailbox: false, tokenError: null, rotateRefresh: false }); refreshToken = cfg.refresh.refreshToken; tokens.clear(); return send(res, 200, {}); }
  send(res, 404, {});
});
tokenServer.listen(8443); apiServer.listen(8080); controlServer.listen(9000);
log({ event: 'mock_ready' });
