#!/usr/bin/env python3
"""One-time Google sign-in for the mailbox receiver (installed-app flow: authorization code + PKCE + loopback redirect).

Use for a consumer Gmail test inbox (service accounts cannot be delegated for @gmail.com). Needs a Google Cloud OAuth
client of type "Desktop app"; pass the downloaded client_secret_*.json. Nothing is sent anywhere except Google
(accounts.google.com, oauth2.googleapis.com). Secrets are never printed. The result is written NEXT TO the live
configuration (config.oauth.json + credential.oauth in runtime/mailbox) and never replaces it; activate with
`python3 scripts/configure_mailbox.py --activate-oauth`. Standard library only.
"""
import argparse, base64, hashlib, http.server, json, os, pathlib, re, secrets, sys, threading, urllib.error, urllib.parse, urllib.request, webbrowser

ROOT = pathlib.Path(__file__).resolve().parent.parent
AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
TOKEN_URL = 'https://oauth2.googleapis.com/token'
SCOPE = 'https://mail.google.com/'  # the only scope Gmail IMAP/SMTP XOAUTH2 needs (restricted scope; test users can still consent)

def fail(message):
    raise SystemExit(message)

def load_client(path):
    try:
        data = json.loads(pathlib.Path(path).read_text())
    except (OSError, ValueError):
        fail('Cannot read the client JSON. Pass the file downloaded from Google Cloud (OAuth client, type Desktop app).')
    if 'installed' not in data:
        fail('This client JSON is not of type "Desktop app" (expected a top-level "installed" key). In Google Cloud create a new OAuth client ID with application type "Desktop app".')
    client = data['installed']
    if not client.get('client_id') or not client.get('client_secret'):
        fail('The client JSON has no client_id/client_secret.')
    return client['client_id'], client['client_secret']

def write_secret(path, text, force):
    if path.exists() and not force:
        fail(f'{path.name} already exists in {path.parent}. Move it away, or re-run with --force to replace it.')
    tmp = path.with_name(path.name + '.tmp')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write(text)
    os.replace(tmp, path)
    path.chmod(0o644)  # same pattern as configure_mailbox.py: the 0700 parent folder protects it; Docker mounts it read-only

class Catcher(http.server.BaseHTTPRequestHandler):
    result = {}
    def do_GET(self):
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        if urllib.parse.urlparse(self.path).path != '/' or not ({'code', 'error'} & set(query)):
            self.send_response(404); self.end_headers(); return
        Catcher.result = {k: v[0] for k, v in query.items()}
        self.send_response(200); self.send_header('Content-Type', 'text/html; charset=utf-8'); self.end_headers()
        self.wfile.write(b'<html><body style="font-family:sans-serif"><h3>Done - you can close this tab and return to Terminal.</h3></body></html>')
    def log_message(self, *args):
        pass

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('client_json', help='client_secret_*.json of an OAuth client of type "Desktop app"')
    ap.add_argument('--email', help='Gmail address to sign in with (default: the user in the existing config.json)')
    ap.add_argument('--dest', default=os.environ.get('PB_MAILBOX_DIR') or str(ROOT / 'runtime' / 'mailbox'))
    ap.add_argument('--no-browser', action='store_true', help='only print the URL')
    ap.add_argument('--force', action='store_true', help='replace an existing config.oauth.json / credential.oauth')
    ap.add_argument('--timeout', type=int, default=300)
    args = ap.parse_args()
    dest = pathlib.Path(args.dest)
    if not sys.stdin.isatty():
        fail('Run this interactively in Terminal.')
    client_id, client_secret = load_client(args.client_json)
    live = {}
    if (dest / 'config.json').exists():
        try: live = json.loads((dest / 'config.json').read_text())
        except ValueError: fail('runtime/mailbox/config.json is not valid JSON.')
    email = args.email or live.get('user') or input('Gmail address to connect: ').strip()
    if '@' not in email or any(c.isspace() for c in email): fail('Enter a valid email address.')
    # Already running in OAuth mode (a renewal after the 7-day Testing expiry)? Then the live credential itself is replaced, but only with --force.
    renewing = live.get('authMode') == 'oauth2-refresh-token' and 'googleapis' in live.get('tokenEndpoint', '')
    cfg_name, cred_name = ('config.json', 'password') if renewing else ('config.oauth.json', 'credential.oauth')
    if renewing and not args.force: fail('The receiver is already in Google OAuth mode. Re-run with --force to replace the expired refresh token in place.')
    for name in (cfg_name, cred_name):
        if (dest / name).exists() and not args.force: fail(f'{name} already exists in {dest}. Move it away or use --force.')

    verifier = secrets.token_urlsafe(64)  # 86 chars, within the 43-128 limit
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
    state = secrets.token_urlsafe(24)
    server = http.server.HTTPServer(('127.0.0.1', 0), Catcher)
    redirect = f'http://127.0.0.1:{server.server_port}'
    url = AUTH_URL + '?' + urllib.parse.urlencode({
        'client_id': client_id, 'redirect_uri': redirect, 'response_type': 'code', 'scope': SCOPE, 'state': state,
        'code_challenge': challenge, 'code_challenge_method': 'S256', 'access_type': 'offline', 'prompt': 'consent', 'login_hint': email})
    print('Open this address in a browser, sign in as', email, 'and allow access:\n\n' + url + '\n')
    print('Google may say "Google hasn\'t verified this app": choose Advanced, then "Go to ... (unsafe)". That is expected for your own test app.')
    if not args.no_browser: webbrowser.open(url)
    server.timeout = 1
    stop = threading.Event()
    deadline = threading.Timer(args.timeout, stop.set); deadline.daemon = True; deadline.start()
    while not Catcher.result and not stop.is_set():
        server.handle_request()
    deadline.cancel(); server.server_close()
    got = Catcher.result
    if not got: fail('Timed out waiting for the browser sign-in. Nothing was saved.')
    if got.get('state') != state: fail('Sign-in response did not match this request (state). Nothing was saved.')
    if 'error' in got: fail('Google reported: ' + re.sub(r'[^a-z_]', '', got['error'])[:40] + '. Nothing was saved.')

    body = urllib.parse.urlencode({'client_id': client_id, 'client_secret': client_secret, 'code': got['code'], 'code_verifier': verifier,
                                   'grant_type': 'authorization_code', 'redirect_uri': redirect}).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request(TOKEN_URL, body, {'Content-Type': 'application/x-www-form-urlencoded'}), timeout=30) as r:
            token = json.load(r)
    except urllib.error.HTTPError as e:
        try: code = re.sub(r'[^a-z_]', '', json.load(e).get('error', ''))[:40]
        except Exception: code = ''
        fail(f'Google rejected the code exchange ({e.code} {code}). Nothing was saved.')
    except (urllib.error.URLError, OSError, ValueError):
        fail('Could not reach oauth2.googleapis.com. Nothing was saved.')
    if not token.get('refresh_token'):
        fail('Google returned no refresh token. Remove the app at https://myaccount.google.com/permissions and run this again.')
    if SCOPE not in token.get('scope', '').split():
        fail('The mail.google.com permission was not granted (tick every box on the consent page). Nothing was saved.')

    config = {k: v for k, v in live.items() if k not in ('authMode', 'tenantId', 'clientId', 'clientAuth', 'tokenEndpoint', 'scope', 'impersonateUser', 'tlsCaFile')}
    config.update({'host': 'imap.gmail.com', 'port': 993, 'user': email, 'mailbox': live.get('mailbox', 'INBOX'),
                   'authMode': 'oauth2-refresh-token', 'clientId': client_id, 'tokenEndpoint': TOKEN_URL})
    config.setdefault('pollIntervalSeconds', 60); config.setdefault('startPolicy', 'new-only')
    os.umask(0o077); dest.mkdir(parents=True, exist_ok=True); dest.chmod(0o700)
    write_secret(dest / cred_name, json.dumps({'clientSecret': client_secret, 'refreshToken': token['refresh_token']}) + '\n', args.force)
    write_secret(dest / cfg_name, json.dumps(config, indent=2) + '\n', args.force)
    print('Saved (no secrets shown):', dest / cfg_name, 'and', dest / cred_name)
    if renewing:
        print('The live credential was replaced. Recreate the mailbox container so it reads it (the receiver ignores any older rotated token).')
    else:
        print('Your live mailbox configuration was NOT changed. To switch the receiver to Google sign-in run:')
        print('  python3 scripts/configure_mailbox.py --activate-oauth --restart dev')
    print('Note: while the Google Cloud app is in "Testing" status, Google expires this refresh token after 7 days; re-run this script then (or publish the app).')

if __name__ == '__main__':
    main()
