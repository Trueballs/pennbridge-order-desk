import { readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { fileState, httpIntake, imapMailbox, MailboxConfigSchema, pollMailbox, retryDelaySeconds, safeErrorCode } from '../../packages/mailbox';

async function main() {
  const config=MailboxConfigSchema.parse(JSON.parse(await readFile(process.env.MAILBOX_CONFIG_FILE||'/run/mailbox/config.json','utf8')));
  const password=(await readFile(process.env.MAILBOX_PASSWORD_FILE||'/run/secrets/mailbox_password','utf8')).trimEnd();
  const token=(await readFile(process.env.MAILBOX_TOKEN_FILE||'/run/secrets/mailbox_token','utf8')).trim();
  if (!password||!token) throw new Error('missing_secret');
  const state=fileState(process.env.MAILBOX_STATE_FILE||'/app/runtime/mailbox-state/checkpoint.json');
  const submit=httpIntake(token,process.env.MAILBOX_INTAKE_URL);
  const once=process.argv.includes('--once');
  let failures=0;
  for (;;) {
    try {
      const result=await pollMailbox(config,imapMailbox(config,password),state,submit);
      console.log(JSON.stringify({event:result.ready?'mailbox.ready':'mailbox.poll_complete',processed:result.processed}));
      failures=0;
    } catch(error) {
      console.error(JSON.stringify({event:'mailbox_poll_failed',code:safeErrorCode(error)}));
      if (once) {process.exitCode=1;return;}
      failures++;
    }
    if (once) return;
    await setTimeout(retryDelaySeconds(config.pollIntervalSeconds,failures)*1000);
  }
}
main().catch(()=>{console.error(JSON.stringify({event:'mailbox_start_failed',code:'invalid_configuration_or_secret'}));process.exitCode=1;});
