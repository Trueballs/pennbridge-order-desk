#!/usr/bin/env python3
"""Interactive local-only setup. Never supply mailbox passwords in command arguments."""
import getpass,json,os,pathlib,re,secrets,sys
ROOT=pathlib.Path(__file__).resolve().parent.parent
DEST=ROOT/'runtime'/'mailbox'
def main():
    if not sys.stdin.isatty():
        raise SystemExit('Run this interactively in Terminal. Do not paste passwords into chat.')
    if (DEST/'config.json').exists():
        raise SystemExit('Mailbox configuration already exists. Keep it, or move runtime/mailbox to a private backup before configuring a different account. The receiver checkpoint must also be explicitly reset for a different mailbox.')
    print('Pennbridge dedicated TEST inbox setup. Use only synthetic test orders.')
    email=input('Dedicated test email address: ').strip()
    if '@' not in email or any(c.isspace() for c in email): raise SystemExit('Enter a valid email address.')
    host=input('IMAP host [imap.gmail.com]: ').strip() or 'imap.gmail.com'
    if any(c.isspace() for c in host) or '/' in host: raise SystemExit('Enter a hostname only.')
    mailbox=input('Mailbox folder [INBOX]: ').strip() or 'INBOX'
    prefix=input('Only ingest subjects starting with (blank = ingest ALL mail; use a prefix only for a shared/test inbox): ').strip()
    if len(prefix)>200: raise SystemExit('Prefix is too long.')
    since=input('First run only: also import mail received since YYYY-MM-DD (blank = only new mail): ').strip()
    if since and not re.fullmatch(r'\d{4}-\d{2}-\d{2}',since): raise SystemExit('Use the format YYYY-MM-DD.')
    password=getpass.getpass('Mailbox app password (hidden; stored only in ignored local runtime files): ')
    if host=='imap.gmail.com': password=password.replace(' ','')
    if not password: raise SystemExit('No password provided; nothing saved.')
    os.umask(0o077); DEST.mkdir(parents=True,exist_ok=True); DEST.chmod(0o700)
    config={'host':host,'port':993,'user':email,'mailbox':mailbox,'subjectPrefix':prefix,'pollIntervalSeconds':60,'startPolicy':'new-only','maxAttemptsPerMessage':5,'senderRateLimitPerHour':30}
    if since: config['ingestSince']=since
    for name,value in [('config.json',json.dumps(config,indent=2)+'\n'),('password',password),('token',secrets.token_hex(32))]:
        fd=os.open(DEST/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,'w') as f: f.write(value)
        # Docker bind-mounted secrets retain host modes. The 0700 parent folder
        # prevents other host users reading these files; containers get individual read-only mounts.
        (DEST/name).chmod(0o644)
    print('Saved locally. No connection attempted. Start the receiver with: bash scripts/start_mailbox.sh')
    print('Wait for mailbox.ready before sending a new message. Existing mail is not imported.')
if __name__=='__main__': main()
