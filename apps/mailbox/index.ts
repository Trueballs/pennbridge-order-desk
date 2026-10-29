import { readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import path from 'node:path';
import { createTokenProvider, fileRefreshStore, fileState, httpIntake, httpsFormPost, imapMailbox, MailboxConfigSchema, pollMailbox, retryDelaySeconds, safeErrorCode, SenderRateLimiter } from '../../packages/mailbox';

const log=(event:Record<string,unknown>)=>(event.level==='error'||event.level==='warn'?console.error:console.log)(JSON.stringify(event));
async function main() {
  const config=MailboxConfigSchema.parse(JSON.parse(await readFile(process.env.MAILBOX_CONFIG_FILE||'/run/mailbox/config.json','utf8')));
  // The credential file is the app password (authMode "password") or the OAuth secret for the configured mode: client secret, PEM key+certificate, service-account JSON or refresh-token JSON.
  const credential=(await readFile(process.env.MAILBOX_PASSWORD_FILE||'/run/secrets/mailbox_password','utf8')).trimEnd();
  const token=(await readFile(process.env.MAILBOX_TOKEN_FILE||'/run/secrets/mailbox_token','utf8')).trim();
  if (!credential||!token) throw new Error('missing_secret');
  const stateFile=process.env.MAILBOX_STATE_FILE||'/app/runtime/mailbox-state/checkpoint.json';
  const state=fileState(stateFile);
  const extraCa=config.tlsCaFile?[await readFile(config.tlsCaFile,'utf8')]:[];
  const auth=config.authMode==='password'?credential:createTokenProvider(config as typeof config&{authMode:Exclude<typeof config.authMode,'password'>},credential,{
    request:httpsFormPost(extraCa),log,refreshStore:fileRefreshStore(path.join(path.dirname(stateFile),'oauth-refresh-token'))});
  const submit=httpIntake(token,process.env.MAILBOX_INTAKE_URL);
  const limiter=new SenderRateLimiter(config.senderRateLimitPerHour);
  const once=process.argv.includes('--once');
  log({event:'mailbox.config',authMode:config.authMode,subjectPrefix:config.subjectPrefix||null,filtering:config.subjectPrefix?'subject-prefix':'all-messages',senderRateLimitPerHour:config.senderRateLimitPerHour,maxAttemptsPerMessage:config.maxAttemptsPerMessage});
  let failures=0;
  for (;;) {
    let status={at:new Date().toISOString(),ok:true,ready:false,processed:0,consecutiveFailures:0,errorCode:null as string|null};
    try {
      const result=await pollMailbox(config,imapMailbox(config,auth,{extraCa}),state,submit,{limiter,log});
      log({event:result.ready?'mailbox.ready':'mailbox.poll_complete',processed:result.processed});
      failures=0; status={...status,ready:result.ready,processed:result.processed};
    } catch(error) {
      const code=safeErrorCode(error);
      log({event:'mailbox_poll_failed',level:'error',code});
      failures++; status={...status,ok:false,consecutiveFailures:failures,errorCode:code};
      if (once) process.exitCode=1;
    }
    // status.json lets a container healthcheck or the operator see the last poll without database access.
    await state.status?.(status).catch(()=>log({event:'mailbox.status_write_failed',level:'warn'}));
    if (once) return;
    await setTimeout(retryDelaySeconds(config.pollIntervalSeconds,failures)*1000);
  }
}
main().catch(()=>{console.error(JSON.stringify({event:'mailbox_start_failed',code:'invalid_configuration_or_secret'}));process.exitCode=1;});
