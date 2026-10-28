#!/usr/bin/env python3
"""Interactive local-only setup for live Gemini extraction. Never pass the key as an argument."""
import getpass,os,pathlib,sys
ROOT=pathlib.Path(__file__).resolve().parent.parent
DEST=ROOT/'runtime'/'ai'
def main():
    if not sys.stdin.isatty():
        raise SystemExit('Run this interactively in Terminal. Do not paste keys into chat.')
    if (DEST/'gemini_key').exists():
        raise SystemExit('runtime/ai/gemini_key already exists. Keep it, or move/delete that file yourself to replace the key.')
    key=getpass.getpass('Gemini API key (hidden; stored only in ignored runtime/ai/gemini_key): ').strip()
    if not key or any(c.isspace() for c in key): raise SystemExit('No valid key provided; nothing saved.')
    os.umask(0o077); DEST.mkdir(parents=True,exist_ok=True); DEST.chmod(0o700)
    fd=os.open(DEST/'gemini_key',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as f: f.write(key)
    # Same trade-off as runtime/mailbox: the container user must read the bind-mounted secret;
    # the 0700 parent folder keeps other host users out.
    (DEST/'gemini_key').chmod(0o644)
    print('Saved locally. No connection attempted. Start live extraction with: bash scripts/start_live_ai.sh')
    print('Return to mock mode with: bash scripts/stop_live_ai.sh')
if __name__=='__main__': main()
