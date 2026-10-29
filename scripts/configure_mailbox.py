#!/usr/bin/env python3
"""Interactive local-only mailbox setup. Never supply secrets in command arguments.

  python3 scripts/configure_mailbox.py                  new setup (password or an OAuth mode)
  python3 scripts/configure_mailbox.py --activate-oauth   swap in config.oauth.json + credential.oauth made by google_oauth_setup.py
  python3 scripts/configure_mailbox.py --rollback-password  swap the previous password-mode files back
Add `--restart dev` to also rebuild/recreate the receiver of the local pennbridge-dev Compose project.
"""
import getpass,json,os,pathlib,re,secrets,subprocess,sys
ROOT=pathlib.Path(__file__).resolve().parent.parent
DEST=pathlib.Path(os.environ.get('PB_MAILBOX_DIR') or ROOT/'runtime'/'mailbox')
MODES={'1':'password','2':'oauth2-microsoft','3':'oauth2-google','4':'oauth2-refresh-token'}
URL=re.compile(r'https://[^\s/]+(/\S*)?')

def write_new(name,value):
    fd=os.open(DEST/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as f: f.write(value)
    # Docker bind-mounted secrets retain host modes. The 0700 parent folder
    # prevents other host users reading these files; containers get individual read-only mounts.
    (DEST/name).chmod(0o644)

def read_file_arg(prompt):
    path=pathlib.Path(input(prompt).strip().strip("'\"")).expanduser()
    try: return path.read_text()
    except OSError: raise SystemExit('Cannot read that file.')

def swap(pairs,backup_suffix):
    """pairs: [(live, replacement)]; the live file moves to live+backup_suffix, the replacement becomes live."""
    for live,new in pairs:
        if not (DEST/new).exists(): raise SystemExit(f'Missing {DEST/new}.')
        if (DEST/(live+backup_suffix)).exists(): raise SystemExit(f'{live+backup_suffix} already exists in {DEST}; move it away first (nothing was changed).')
    for live,new in pairs:
        if (DEST/live).exists(): os.replace(DEST/live,DEST/(live+backup_suffix))
        os.replace(DEST/new,DEST/live)

def restart_dev():
    infra=ROOT/'infra'; files=[]
    for f in ('compose.yaml','mailbox.compose.yaml','live-ai.compose.yaml','odoo-push.compose.yaml'):
        if (infra/f).exists(): files+=['-f',str(infra/f)]
    base=['docker','compose','-p','pennbridge-dev']+files
    # The receiver code is baked into the app image, so rebuild it first; only the mailbox container is recreated.
    subprocess.run(base+['build','app'],check=True)
    subprocess.run(base+['up','-d','--no-deps','--force-recreate','mailbox'],check=True)

def activate(direction):
    if direction=='oauth':
        swap([('config.json','config.oauth.json'),('password','credential.oauth')],'.password-mode')
        print('Switched to OAuth. Previous password-mode files kept as config.json.password-mode and password.password-mode.')
    else:
        # roll back: current OAuth files go to *.oauth, saved password files return
        for a,b in (('config.json','config.json.password-mode'),('password','password.password-mode')):
            if not (DEST/b).exists(): raise SystemExit(f'No {b} to roll back to.')
        for live,old,store in (('config.json','config.json.password-mode','config.oauth.json'),('password','password.password-mode','credential.oauth')):
            if (DEST/store).exists(): raise SystemExit(f'{store} already exists; move it away first (nothing was changed).')
        for live,old,store in (('config.json','config.json.password-mode','config.oauth.json'),('password','password.password-mode','credential.oauth')):
            os.replace(DEST/live,DEST/store); os.replace(DEST/old,DEST/live)
        print('Switched back to the app password.')
    print('The checkpoint is kept, so no mail is re-imported or duplicated.')

def setup():
    if not sys.stdin.isatty():
        raise SystemExit('Run this interactively in Terminal. Do not paste passwords into chat.')
    if (DEST/'config.json').exists():
        raise SystemExit('Mailbox configuration already exists. Keep it, or move runtime/mailbox to a private backup before configuring a different account. The receiver checkpoint must also be explicitly reset for a different mailbox. To change only the sign-in method use --activate-oauth / --rollback-password.')
    print('Pennbridge mailbox setup. Use a dedicated mailbox; synthetic test orders for a test inbox.')
    print('Sign-in method:\n  1) app password (IMAP, default)\n  2) Microsoft 365 / Exchange Online OAuth (app-only client credentials)\n  3) Google Workspace OAuth (service account, domain-wide delegation)\n  4) Generic OAuth refresh token (other providers; Gmail: use scripts/google_oauth_setup.py)')
    mode=MODES.get(input('Choose [1]: ').strip() or '1')
    if not mode: raise SystemExit('Choose 1-4.')
    email=input('Mailbox email address: ').strip()
    if '@' not in email or any(c.isspace() for c in email): raise SystemExit('Enter a valid email address.')
    default_host={'oauth2-microsoft':'outlook.office365.com','oauth2-google':'imap.gmail.com'}.get(mode,'imap.gmail.com')
    host=input(f'IMAP host [{default_host}]: ').strip() or default_host
    if any(c.isspace() for c in host) or '/' in host: raise SystemExit('Enter a hostname only.')
    mailbox=input('Mailbox folder [INBOX]: ').strip() or 'INBOX'
    prefix=input('Only ingest subjects starting with (blank = ingest ALL mail; use a prefix only for a shared/test inbox): ').strip()
    if len(prefix)>200: raise SystemExit('Prefix is too long.')
    since=input('First run only: also import mail received since YYYY-MM-DD (blank = only new mail): ').strip()
    if since and not re.fullmatch(r'\d{4}-\d{2}-\d{2}',since): raise SystemExit('Use the format YYYY-MM-DD.')
    config={'host':host,'port':993,'user':email,'mailbox':mailbox,'subjectPrefix':prefix,'pollIntervalSeconds':60,'startPolicy':'new-only','maxAttemptsPerMessage':5,'senderRateLimitPerHour':30}
    if mode!='password': config['authMode']=mode
    if mode=='password':
        credential=getpass.getpass('Mailbox app password (hidden; stored only in ignored local runtime files): ')
        if host=='imap.gmail.com': credential=credential.replace(' ','')
    elif mode=='oauth2-microsoft':
        config['tenantId']=input('Directory (tenant) ID or domain: ').strip()
        config['clientId']=input('Application (client) ID: ').strip()
        if not config['tenantId'] or not config['clientId']: raise SystemExit('Tenant and client ID are required.')
        if input('Authenticate with a [s]ecret or a [c]ertificate? [s]: ').strip().lower().startswith('c'):
            config['clientAuth']='certificate'
            key=read_file_arg('Path to the private key PEM (stays on this computer): ').strip(); cert=read_file_arg('Path to the certificate PEM: ').strip()
            if 'PRIVATE KEY' not in key or 'BEGIN CERTIFICATE' not in cert: raise SystemExit('Expected a PEM private key and a PEM certificate.')
            credential=key+'\n'+cert+'\n'
        else:
            credential=getpass.getpass('Client secret VALUE (hidden): ')
    elif mode=='oauth2-google':
        raw=read_file_arg('Path to the service-account JSON key file: ')
        try: sa=json.loads(raw); assert sa['client_email'] and 'PRIVATE KEY' in sa['private_key']
        except Exception: raise SystemExit('That is not a service-account JSON key.')
        credential=json.dumps(sa)+'\n'
        imp=input(f'Impersonate which mailbox via domain-wide delegation [{email}]: ').strip()
        if imp and imp!=email: config['impersonateUser']=imp
    else:
        config['clientId']=input('OAuth client ID: ').strip()
        config['tokenEndpoint']=input('Token endpoint (https URL): ').strip()
        if not URL.fullmatch(config['tokenEndpoint']) or not config['clientId']: raise SystemExit('Client ID and an https token endpoint are required.')
        scope=input('Scope (blank = none; Gmail refresh tokens keep the scope they were granted): ').strip()
        if scope: config['scope']=scope
        sec=getpass.getpass('Client secret (hidden, blank for none): '); refresh=getpass.getpass('Refresh token (hidden): ')
        if not refresh: raise SystemExit('No refresh token provided; nothing saved.')
        credential=json.dumps({'refreshToken':refresh,**({'clientSecret':sec} if sec else {})})+'\n'
    if not credential.strip(): raise SystemExit('No secret provided; nothing saved.')
    if since: config['ingestSince']=since
    os.umask(0o077); DEST.mkdir(parents=True,exist_ok=True); DEST.chmod(0o700)
    # The credential file keeps its historic name "password": app password, client secret, PEM key+certificate, service-account JSON or refresh-token JSON depending on authMode.
    for name,value in [('config.json',json.dumps(config,indent=2)+'\n'),('password',credential),('token',secrets.token_hex(32))]: write_new(name,value)
    print('Saved locally. No connection attempted. Start the receiver with: bash scripts/start_mailbox.sh')
    print('Wait for mailbox.ready before sending a new message. Existing mail is not imported.')

def main():
    args=sys.argv[1:]; restart='--restart' in args
    if restart:
        i=args.index('--restart'); target=args[i+1] if i+1<len(args) else ''
        if target!='dev': raise SystemExit('--restart supports only "dev" (the local pennbridge-dev project). For production use scripts/pbctl.sh up -d mailbox.')
        args=args[:i]+args[i+2:]
    if args==['--activate-oauth']: activate('oauth')
    elif args==['--rollback-password']: activate('password')
    elif args: raise SystemExit(__doc__)
    else:
        if restart: raise SystemExit('--restart only goes with --activate-oauth or --rollback-password.')
        setup(); return
    if restart: restart_dev()
    else: print('Now restart the receiver so it reads the new files, e.g. add: --restart dev (local pennbridge-dev stack), or scripts/pbctl.sh up -d --force-recreate mailbox (production).')
if __name__=='__main__': main()
