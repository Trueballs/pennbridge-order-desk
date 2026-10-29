# Connecting the shared orders mailbox

The receiver (`apps/mailbox`) reads one shared mailbox (for example `orders@`) over IMAPS. It only reads: it never sends, moves, deletes or marks mail. Pick the sign-in method your mail system allows. The choice lives in `runtime/mailbox/config.json` as `authMode`; all secrets live in files next to it, never in config, logs, images or command lines.

| `authMode` | For | Secret file content (`runtime/mailbox/password`) |
| --- | --- | --- |
| `password` (default, unchanged) | Gmail/Workspace app password, any IMAP server that allows passwords | the app password |
| `oauth2-microsoft` | Microsoft 365 / Exchange Online with basic auth disabled | client secret, or (certificate) a PEM holding the private key and certificate |
| `oauth2-google` | Google Workspace (service account with domain-wide delegation) | the service-account JSON key |
| `oauth2-refresh-token` | Any other provider, and consumer Gmail (see below) | JSON `{"clientSecret": "...", "refreshToken": "..."}` |

`python3 scripts/configure_mailbox.py` asks which method you want and writes the files (secrets via hidden prompts or file paths; the files get mode 0644 inside the 0700 folder, like before). An existing password config keeps working with no change. Switching method later keeps the checkpoint, so nothing is re-imported or duplicated.

The receiver gets an access token, caches it, and refreshes it about 60 seconds before it expires (or halfway through a very short lifetime) before each poll. If the server rejects a cached token (for instance it was revoked) it fetches a fresh one and retries once before raising an alert.

## Alerts

All failures reach `alert.json` in the mailbox state volume (the desk shows `MAILBOX_ERROR`, the container goes unhealthy) and clear on the next successful poll. Codes contain no provider text.

| Code | Meaning | Typical fix |
| --- | --- | --- |
| `imap_auth_failed` (the "auth failed" alert) | The mail server rejected the login or the token | Microsoft: service principal not registered in Exchange or no mailbox permission; Google: delegation missing; app password revoked |
| `token_failed` | No token could be obtained | Wrong tenant/client id, expired or wrong client secret, bad key file, unreachable token endpoint |
| `consent_required` | A person or admin must approve again | Admin consent missing, delegation not authorised, refresh token revoked/expired (Google "Testing" apps: after 7 days) |

The log line `mailbox.token_request_failed` carries only the HTTP status, the OAuth `error` code and, for Microsoft, the `AADSTSnnnnn` number.

## Microsoft 365 (Exchange Online) - client credentials

Source: [Authenticate an IMAP, POP or SMTP connection using OAuth](https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth) (read 2026-10-29). The receiver signs in as an application, not as a person, so no password, MFA prompt or refresh token is involved.

1. **Register the app.** Entra admin center -> App registrations -> New registration, "Accounts in this organizational directory only". Note the **Application (client) ID** and **Directory (tenant) ID**.
2. **Credential.** Certificates & secrets -> New client secret (copy the *Value* once), or upload a certificate (public part) and keep the private key. A certificate is preferred for production.
3. **Permission.** API permissions -> Add a permission -> *APIs my organization uses* -> **Office 365 Exchange Online** -> **Application permissions** -> **IMAP.AccessAsApp** -> Add. Then **Grant admin consent** for the tenant.
4. **Register the service principal in Exchange.** In Entra, open *Enterprise applications* -> your app and copy its **Object ID** (this is not the Object ID shown under App registrations). Then in Exchange Online PowerShell:

   ```powershell
   Install-Module ExchangeOnlineManagement
   Connect-ExchangeOnline -Organization <tenantId>
   New-ServicePrincipal -AppId <APPLICATION_ID> -ObjectId <ENTERPRISE_APP_OBJECT_ID>
   Add-MailboxPermission -Identity "orders@yourcompany.com" -User <SERVICE_PRINCIPAL_ID> -AccessRights FullAccess
   ```

   `<SERVICE_PRINCIPAL_ID>` is the identity returned by `Get-ServicePrincipal` (the "Identity"/ObjectId of the Exchange service principal). Repeat `Add-MailboxPermission` for each mailbox the app may open. This is the access boundary: the app can read only the mailboxes you list.
5. **Scoping with RBAC for Applications - not available for IMAP.** Microsoft's [RBAC for Applications](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac) page (read 2026-10-29) lists the supported protocols as **Microsoft Graph and EWS only**. It scopes roles such as `Application Mail.Read` with `New-ManagementScope` + `New-ManagementRoleAssignment`, but it does not scope `IMAP.AccessAsApp`. For this receiver, per-mailbox `Add-MailboxPermission` (step 4) is the scoping mechanism. Do not grant the app Graph `Mail.*` permissions it does not need. If Microsoft later adds IMAP to RBAC for Applications, prefer it.
6. **Configure.** `python3 scripts/configure_mailbox.py`, choose 2, host `outlook.office365.com`, mailbox address = the shared mailbox (it is used as the XOAUTH2 user name), tenant id, client id, secret or certificate. Resulting config:

   ```json
   {"host": "outlook.office365.com", "port": 993, "user": "orders@yourcompany.com", "mailbox": "INBOX",
    "authMode": "oauth2-microsoft", "tenantId": "<tenant>", "clientId": "<client id>", "clientAuth": "secret"}
   ```

   The token comes from `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token` with scope `https://outlook.office365.com/.default`. For a sovereign cloud set `tokenEndpoint` to the full https URL. Permission changes can take up to ~30 minutes to take effect on the Exchange side.
7. **Check.** Start the receiver and wait for `mailbox.ready`. `token_failed` -> check ids/secret; `imap_auth_failed` right after a good token -> steps 3-4 are incomplete (most often the wrong Object ID in step 4).

## Google Workspace - service account with domain-wide delegation

Sources: [Gmail IMAP XOAUTH2](https://developers.google.com/workspace/gmail/imap/xoauth2-protocol), [service-account OAuth](https://developers.google.com/identity/protocols/oauth2/service-account) (read 2026-10-29). Only for Workspace domains: delegation does not work for consumer `@gmail.com` accounts (use the next section for those).

1. Google Cloud console -> IAM & Admin -> Service accounts -> create a service account in a project of your organisation. Create a **JSON key** and keep the file private.
2. Open the service account and copy its numeric **Client ID** (Unique ID).
3. A Workspace **super admin**: Admin console -> Security -> Access and data control -> API controls -> **Manage Domain Wide Delegation** -> Add new. Enter the Client ID and the scope `https://mail.google.com/`. Authorize. Propagation usually takes minutes, occasionally up to 24 hours.
4. Make sure IMAP is enabled for the mailbox's organisational unit (Admin console -> Apps -> Google Workspace -> Gmail -> End user access).
5. `python3 scripts/configure_mailbox.py`, choose 3, host `imap.gmail.com`, give the path to the JSON key. The config is `{"authMode": "oauth2-google", "user": "orders@yourcompany.com", ...}`; the service account impersonates `user` (override with `impersonateUser`). The receiver signs a JWT (RS256, claims `iss`, `sub`, `scope`, `aud`, `iat`, `exp`) and exchanges it at `https://oauth2.googleapis.com/token` using the JWT-bearer grant.
6. Google's IMAP page also mentions the scope `https://www.googleapis.com/auth/gmail.imap_admin` as an alternative for delegation. The default here is `https://mail.google.com/`; override with `scope` if your admin policy requires the narrower one. Neither was tested against a live Workspace tenant.

`consent_required` here almost always means step 3 is missing or has not propagated, or the impersonated user does not exist.

## Gmail with OAuth (instead of an app password)

Use this for the consumer test inbox (`pennbridgeorderstest@gmail.com`) or any @gmail.com mailbox. Consumer accounts cannot use service-account delegation, so you sign in once as yourself and the receiver keeps a refresh token (`oauth2-refresh-token`). Takes about 15 minutes; no payment details are needed.

1. Go to <https://console.cloud.google.com/> signed in as the Gmail account. **Create a project** (top bar -> New project, any name, e.g. "Pennbridge test").
2. **Gmail API:** Google's documentation for IMAP XOAUTH2 names only the scope `https://mail.google.com/`; it does not say the Gmail API has to be enabled for IMAP. You can skip it. If sign-in or IMAP later complains about an API not being enabled, open *APIs & Services -> Library -> Gmail API -> Enable*.
3. **Consent screen:** *APIs & Services -> OAuth consent screen* (or "Google Auth platform -> Branding/Audience"). Choose **External**, fill in an app name and your email, then keep the publishing status **Testing**. Under *Audience / Test users* **add the Gmail address** (it must be listed, or Google refuses the sign-in). Under *Data access / Scopes* adding `https://mail.google.com/` is optional; the script asks for it anyway.
4. **Create the client:** *Credentials -> Create credentials -> OAuth client ID -> Application type **Desktop app*** -> Create -> **Download JSON**. Keep the file out of the project folder, for example in `~/Downloads`.
5. **Sign in once:**

   ```sh
   cd '/Users/oscarwoldskaarderud/Pennbridge Order Desk'
   python3 scripts/google_oauth_setup.py runtime/mailbox-oauth/google_client.json --email pennbridgeorderstest@gmail.com   # or the path of your downloaded client JSON
   ```

   A browser page opens (or open the printed link). Sign in, and when Google says "hasn't verified this app" choose **Advanced -> Go to ... (unsafe)**: it is your own test app. Tick the mail permission and Continue. The terminal says "Saved (no secrets shown)". This writes `runtime/mailbox/config.oauth.json` and `credential.oauth` and does not touch the live files. Technically it is the installed-app flow: authorization code + PKCE (S256) with a loopback redirect to `http://127.0.0.1:<random port>`, offline access, scope `https://mail.google.com/`.
6. **Switch the running receiver to OAuth with one command** (local dev stack: rebuilds the image that contains the new receiver code and recreates only the mailbox container):

   ```sh
   python3 scripts/configure_mailbox.py --activate-oauth --restart dev
   ```

   Then watch `docker logs -f pennbridge-dev-mailbox-1`: expect `mailbox.token_acquired` and normal `mailbox.poll_complete` lines (no `mailbox.alert`). The checkpoint is kept, so existing mail is neither re-imported nor duplicated. To go back: `python3 scripts/configure_mailbox.py --rollback-password --restart dev` (the old app password files are kept as `*.password-mode`). For production use `--activate-oauth` without `--restart`, rebuild/upgrade the image, then `scripts/pbctl.sh up -d --force-recreate mailbox`.
7. **Know the limits.** While the Google Cloud app is in **Testing**, Google expires refresh tokens after **7 days** (source: [Google OAuth 2.0 token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)); the receiver then raises `consent_required`. Renew by re-running step 5 with `--force` (it replaces the live refresh token in place) and recreating the mailbox container. A refresh token also stops working after 6 months unused, after revocation at <https://myaccount.google.com/permissions>, or after a password change on an account with Gmail scopes. Moving the app to "In production" removes the 7-day limit but `https://mail.google.com/` is a restricted scope that needs Google verification for public apps; for a single-owner test inbox the 7-day re-sign-in is the practical route.

## Private certificate authority

If the IMAP server or token endpoint uses a private CA, set `tlsCaFile` to a PEM bundle path inside the container and mount the file read-only (a Compose override). The bundle is trusted *in addition to* the system roots; certificate verification is never disabled. Token endpoints must be `https://`.

## What was verified, and what was not

Verified locally by `scripts/test_mailbox_oauth.sh` (details and results in the section below) and unit tests in `tests/mailbox-oauth.test.ts`: the real receiver code, in the real app image, authenticating over certificate-verified TLS to a pinned Dovecot using XOAUTH2 (and once OAUTHBEARER), tokens obtained from a local mock identity provider through the client-credentials (secret and certificate assertion), Google JWT-bearer and refresh-token grants, token caching, expiry refresh, revoked token recovery, withdrawn access alert, `token_failed` / `consent_required` alerts, rotated refresh tokens, no secrets in logs, and the unchanged password mode against the same server.

**Needs a real tenant (not verified):** Entra app registration, admin consent and `IMAP.AccessAsApp`, Exchange `New-ServicePrincipal` / `Add-MailboxPermission` and their propagation delay, Exchange Online's exact XOAUTH2 behaviour and error replies; Google Workspace domain-wide delegation and the `https://mail.google.com/` (or `gmail.imap_admin`) scope with a real service account; Google's consent screen, the real consumer Gmail refresh-token grant against `accounts.google.com` / `oauth2.googleapis.com` (the loopback and PKCE mechanics of `google_oauth_setup.py` were tested only against a local fake token endpoint), and Gmail IMAP accepting the resulting token. The mock server mirrors the documented request and response shapes, not Microsoft's or Google's undocumented behaviour.

## Local OAuth protocol test

```sh
bash scripts/test_mailbox_oauth.sh        # about 6-8 minutes; needs Docker and the pennbridge-app:local image
```

It creates its own network, containers and volumes (all labelled `pb-oauth-test`), mounts the working-tree `packages/mailbox` and `apps/mailbox` into the app image, and removes everything on exit. Fixtures live in `infra/test-oauth/`: `dovecot.conf` (IMAPS, passwd-file passdb and oauth2 passdb with introspection), `users`, and `mock-oauth.mjs` (token endpoints, introspection, a stand-in for the desk's `/api/intake`, and a control API). Override the image with `PB_TEST_IMAGE`. It never touches the dev or production Compose projects.
