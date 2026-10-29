import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { rootCertificates } from 'node:tls';
import { ImapFlow } from 'imapflow';
import { AUTH_MODES, TokenError, type TokenProvider } from './oauth';
export * from './oauth';

export const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;
export const MailboxConfigSchema = z.object({
  host: z.string().min(1).max(253), port: z.literal(993).default(993),
  user: z.string().min(1).max(320), mailbox: z.string().min(1).max(500).default('INBOX'),
  /** Empty (default) ingests every message; set it to restrict intake to subjects starting with this text. */
  subjectPrefix: z.string().max(200).default(''),
  pollIntervalSeconds: z.number().int().min(10).max(3600).default(60),
  startPolicy: z.literal('new-only').default('new-only'),
  /** First-run baseline only: also ingest messages received on/after this date (YYYY-MM-DD). Use after losing the checkpoint. */
  ingestSince: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** A message that fails this many times with a message-specific error is quarantined so it cannot block the queue. */
  maxAttemptsPerMessage: z.number().int().min(1).max(50).default(5),
  /** Accepted messages per sender per hour; the rest are logged as skipped. 0 disables. */
  senderRateLimitPerHour: z.number().int().min(0).max(100000).default(30),
  /** How the receiver authenticates. `password` keeps the original app-password behaviour; see docs/MAILBOX-SETUP.md for the OAuth modes. */
  authMode: z.enum(AUTH_MODES).default('password'),
  /** oauth2-microsoft: Entra directory (tenant) id or verified domain. */
  tenantId: z.string().regex(/^[A-Za-z0-9.-]{1,255}$/).optional(),
  /** oauth2-microsoft / oauth2-refresh-token: application (client) id. */
  clientId: z.string().min(1).max(512).regex(/^[^\s\x00-\x1f]+$/).optional(),
  /** oauth2-microsoft: client secret (default) or certificate assertion. The secret/PEM lives in the credential file, never here. */
  clientAuth: z.enum(['secret', 'certificate']).default('secret'),
  /** Full https token endpoint. Required for oauth2-refresh-token; optional override elsewhere (sovereign clouds, tests). */
  tokenEndpoint: z.string().max(1000).refine(v => { try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password; } catch { return false; } }, 'tokenEndpoint must be an https URL').optional(),
  /** Override the requested scope (defaults: Microsoft https://outlook.office365.com/.default, Google https://mail.google.com/). */
  scope: z.string().max(500).regex(/^[^\x00-\x1f]+$/).optional(),
  /** oauth2-google: mailbox to impersonate via domain-wide delegation (defaults to `user`). */
  impersonateUser: z.string().min(3).max(320).optional(),
  /** Extra PEM CA bundle (path inside the container) trusted in ADDITION to the system roots for IMAP and token endpoints. Verification stays on. */
  tlsCaFile: z.string().min(1).max(500).optional(),
}).strict().superRefine((c, ctx) => {
  const need = (ok: unknown, key: string, message: string) => { if (!ok) ctx.addIssue({ code: 'custom', path: [key], message }); };
  if (c.authMode === 'oauth2-microsoft') { need(c.tenantId || c.tokenEndpoint, 'tenantId', 'oauth2-microsoft needs tenantId'); need(c.clientId, 'clientId', 'oauth2-microsoft needs clientId'); }
  if (c.authMode === 'oauth2-refresh-token') { need(c.tokenEndpoint, 'tokenEndpoint', 'oauth2-refresh-token needs tokenEndpoint'); need(c.clientId, 'clientId', 'oauth2-refresh-token needs clientId'); }
});
export type MailboxConfig = z.infer<typeof MailboxConfigSchema>;
const IdentitySchema = z.object({host:z.string(), user:z.string(), path:z.string()}).strict();
const CheckpointSchema = z.object({identity:IdentitySchema, uidValidity:z.string().regex(/^\d+$/), lastUid:z.number().int().min(0).max(4294967295)}).strict();
export type Checkpoint = z.infer<typeof CheckpointSchema>;
export type MailMetadata = {uid:number; size:number; subject:string; from?:string; headers?:Record<string,string>};
export type QuarantineRecord = {transportKey:string;uid:number;size:number;reason:'message_too_large'|'poison_message';code?:string;attempts?:number};
export type SkipRecord = {transportKey:string;uid:number;from:string|null;subject:string;reason:string;at:string};
export type PollStatus = {at:string;ok:boolean;ready:boolean;processed:number;consecutiveFailures:number;errorCode:string|null};
export interface MailboxPort {
  open():Promise<{uidValidity:string; uidNext:number}>;
  list(afterUid:number, limit:number, beforeUid:number):Promise<MailMetadata[]>;
  raw(uid:number):Promise<Buffer>;
  close():Promise<void>;
  /** Lowest UID received on/after the date, or null; used only to baseline with ingestSince. */
  firstUidSince?(date:string):Promise<number|null>;
}
export interface StatePort {
  load():Promise<Checkpoint|null>;
  save(checkpoint:Checkpoint):Promise<void>;
  quarantine(record:QuarantineRecord):Promise<void>;
  /** Append-only log of messages deliberately not ingested (auto-replies, bulk, rate limited). */
  skip?(record:SkipRecord):Promise<void>;
  /** Persistent per-message failure counter; returns the new count. */
  recordFailure?(transportKey:string,code:string):Promise<number>;
  clearFailure?(transportKey:string):Promise<void>;
  /** Set (or clear with null) the current operator alert, e.g. rejected credentials. */
  alert?(alert:{code:string;at:string}|null):Promise<void>;
  status?(status:PollStatus):Promise<void>;
}
export type IntakeEmail = {filename:string;mediaType:'message/rfc822';contentBase64:string;channel:'email';externalMessageId:string};
export class ReceiverError extends Error {
  constructor(public readonly code:string) { super(code); }
}
/** Codes that mean "operator action needed" (credentials), never message-specific. */
/** imap_auth_failed = the mail server rejected the credentials/token ("auth_failed"); token_failed = no token could be obtained; consent_required = a person/admin must grant or re-grant access. */
export const ALERT_CODES = new Set(['intake_unauthorized','imap_auth_failed','token_failed','consent_required']);
const ALERT_MESSAGES:Record<string,string> = {
  intake_unauthorized:'The desk rejected the receiver token (401/403). Mail is NOT being ingested. Rotate/restore runtime/mailbox/token and restart the app and receiver.',
  imap_auth_failed:'The mail server rejected the mailbox credentials. Mail is NOT being ingested. Update the mailbox app password, or for OAuth check that the account/service principal still has access to the mailbox.',
  token_failed:'No OAuth access token could be obtained (bad client secret/key, wrong tenant or endpoint, or the token service is unreachable). Mail is NOT being ingested. See docs/MAILBOX-SETUP.md.',
  consent_required:'The mail provider requires consent or admin approval again (revoked refresh token, missing admin consent or domain-wide delegation). Mail is NOT being ingested. See docs/MAILBOX-SETUP.md.',
};
/** Failures caused by one message; only these count towards poison quarantine. Outages, 5xx and auth errors never do. */
const POISON_CODES = new Set(['intake_rejected','message_unavailable','message_size_changed']);

/** Parses an RFC 5322 header block (unfolds continuation lines, lower-cases names, first occurrence wins). */
export function parseHeaderBlock(block:Buffer|string|undefined):Record<string,string> {
  const out:Record<string,string>={};
  if (!block) return out;
  const lines=block.toString('utf8').replace(/\r?\n[ \t]+/g,' ').split(/\r?\n/);
  for (const line of lines) { const at=line.indexOf(':'); if (at>0) { const name=line.slice(0,at).trim().toLowerCase(); if (!(name in out)) out[name]=line.slice(at+1).trim(); } }
  return out;
}
export const AUTOMATION_HEADERS=['auto-submitted','precedence','list-unsubscribe','list-id','x-auto-response-suppress','x-autoreply','x-autorespond','return-path','content-type'];
/** Reason this message is machine-generated (auto-reply, bulk, bounce) and must not become an order, else null. */
export function automatedReason(meta:Pick<MailMetadata,'from'|'subject'|'headers'>):string|null {
  const h=meta.headers??{};
  const auto=h['auto-submitted']?.toLowerCase();
  if (auto && auto!=='no') return 'auto_submitted';
  if (/^(bulk|list|junk|auto_reply)$/i.test(h['precedence']??'')) return 'precedence_bulk';
  if ('list-unsubscribe' in h || 'list-id' in h) return 'bulk_list';
  if ('x-auto-response-suppress' in h || 'x-autoreply' in h || 'x-autorespond' in h) return 'auto_reply_header';
  if (h['return-path']?.replace(/\s/g,'')==='<>') return 'null_return_path';
  if (/multipart\/report|report-type\s*=\s*delivery-status/i.test(h['content-type']??'')) return 'delivery_report';
  if (/^(mailer-daemon|postmaster)@/i.test(meta.from??'')) return 'system_sender';
  if (/^\s*(automatic reply|auto[- ]?reply|out of office|undeliverable|delivery status notification)/i.test(meta.subject)) return 'auto_reply_subject';
  return null;
}
/** In-memory sliding window per sender. Resets on restart, which is acceptable: each poll is already capped at 20 messages. */
export class SenderRateLimiter {
  private hits=new Map<string,number[]>();
  constructor(private readonly limit:number,private readonly windowMs=3600000,private readonly now:()=>number=Date.now) {}
  allow(sender:string|undefined):boolean {
    if (this.limit<=0) return true;
    const key=(sender||'(unknown)').toLowerCase(),t=this.now();
    const recent=(this.hits.get(key)??[]).filter(x=>t-x<this.windowMs);
    if (recent.length>=this.limit) { this.hits.set(key,recent); return false; }
    recent.push(t); this.hits.set(key,recent);
    if (this.hits.size>10000) for (const [k,v] of this.hits) if (!v.some(x=>t-x<this.windowMs)) this.hits.delete(k);
    return true;
  }
}
export type PollOptions = {limiter?:SenderRateLimiter; log?:(event:Record<string,unknown>)=>void; now?:()=>Date};

export function mailboxIdentity(config:MailboxConfig) { return {host:config.host.toLowerCase(),user:config.user,path:config.mailbox}; }
export function transportKey(checkpoint:Checkpoint, uid:number) {
  return 'imap:'+createHash('sha256').update(JSON.stringify([checkpoint.identity,checkpoint.uidValidity,uid])).digest('hex');
}

/** One poll is sequential: a failed UID can never be skipped by a later success (except a quarantined poison message). */
export async function pollMailbox(config:MailboxConfig, mailbox:MailboxPort, state:StatePort, submit:(input:IntakeEmail)=>Promise<void>, options:PollOptions={}) {
  const log=options.log??(()=>undefined); const nowIso=()=>(options.now?.()??new Date()).toISOString();
  const limiter=options.limiter??new SenderRateLimiter(config.senderRateLimitPerHour);
  try {
    const current = await mailbox.open();
    if (!/^\d+$/.test(current.uidValidity) || !Number.isSafeInteger(current.uidNext) || current.uidNext < 1 || current.uidNext > 4294967296) throw new ReceiverError('invalid_mailbox_state');
    let checkpoint = await state.load();
    const identity = mailboxIdentity(config);
    if (!checkpoint) {
      let lastUid=current.uidNext-1;
      if (config.ingestSince && mailbox.firstUidSince) { const first=await mailbox.firstUidSince(config.ingestSince); if (first!==null && first>=1 && first<=current.uidNext) lastUid=first-1; }
      checkpoint = {identity,uidValidity:current.uidValidity,lastUid};
      await state.save(checkpoint);
      // Loud on purpose: a lost checkpoint silently drops everything already in the mailbox.
      log({event:'mailbox.baseline_created',level:'warn',startsAfterUid:lastUid,ingestSince:config.ingestSince??null,message:config.ingestSince?`Baseline set from ${config.ingestSince}; earlier mail is not imported.`:'Mail already in the mailbox was NOT imported. If a checkpoint was lost, set ingestSince in config.json to re-import from a date (duplicates are ignored).'});
      return {ready:true,processed:0};
    }
    if (JSON.stringify(checkpoint.identity)!==JSON.stringify(identity)) throw new ReceiverError('mailbox_identity_changed_reset_required');
    if (checkpoint.uidValidity!==current.uidValidity) throw new ReceiverError('uidvalidity_changed_reset_required');
    const messages = (await mailbox.list(checkpoint.lastUid,20,current.uidNext)).sort((a,b)=>a.uid-b.uid);
    if (messages.length>20 || new Set(messages.map(m=>m.uid)).size!==messages.length || messages.some(m=>!Number.isSafeInteger(m.uid)||m.uid<=checkpoint!.lastUid||m.uid>=current.uidNext||!Number.isSafeInteger(m.size)||m.size<0)) throw new ReceiverError('invalid_message_metadata');
    let processed=0;
    const advance=async(uid:number)=>{checkpoint={...checkpoint!,lastUid:uid};await state.save(checkpoint);};
    const skip=async(message:MailMetadata,key:string,reason:string)=>{
      await state.skip?.({transportKey:key,uid:message.uid,from:message.from??null,subject:message.subject.slice(0,200),reason,at:nowIso()});
      log({event:'mailbox.skipped',uid:message.uid,reason});
    };
    for (const message of messages) {
      const key=transportKey(checkpoint,message.uid);
      if (message.size>MAX_MESSAGE_BYTES) {
        await state.quarantine({transportKey:key,uid:message.uid,size:message.size,reason:'message_too_large'});
      } else if (message.from && message.from===config.user.toLowerCase()) {
        await skip(message,key,'own_mailbox_message');
      } else if (automatedReason(message)) {
        await skip(message,key,automatedReason(message)!);
      } else if (config.subjectPrefix && !message.subject.startsWith(config.subjectPrefix)) {
        // Not addressed to the desk; ignored by design (prefix mode).
      } else if (!limiter.allow(message.from)) {
        await skip(message,key,'sender_rate_limited');
        log({event:'mailbox.alert',level:'warn',code:'sender_rate_limited',message:`Sender exceeded ${config.senderRateLimitPerHour} messages/hour; messages are logged as skipped, not ingested.`});
      } else {
        try {
          const content=await mailbox.raw(message.uid);
          if (content.length>MAX_MESSAGE_BYTES) throw new ReceiverError('message_size_changed');
          await submit({filename:`imap-${message.uid}.eml`,mediaType:'message/rfc822',contentBase64:content.toString('base64'),channel:'email',externalMessageId:key});
          await state.clearFailure?.(key);
        } catch (error) {
          const code=safeErrorCode(error);
          if (!POISON_CODES.has(code) || !state.recordFailure) throw error;
          const attempts=await state.recordFailure(key,code);
          if (attempts<config.maxAttemptsPerMessage) throw error;
          await state.quarantine({transportKey:key,uid:message.uid,size:message.size,reason:'poison_message',code,attempts});
          await state.clearFailure?.(key);
          log({event:'mailbox.alert',level:'error',code:'poison_message_quarantined',uid:message.uid,failureCode:code,attempts,message:'Message failed repeatedly and was quarantined; the queue continues. Inspect quarantine/ in the mailbox state volume.'});
        }
      }
      await advance(message.uid);
      processed++;
    }
    await Promise.resolve(state.alert?.(null)).catch(()=>undefined);
    return {ready:false,processed};
  } catch (error) {
    const code=safeErrorCode(error);
    if (ALERT_CODES.has(code)) { log({event:'mailbox.alert',level:'error',code,message:ALERT_MESSAGES[code]}); await Promise.resolve(state.alert?.({code,at:nowIso()})).catch(()=>undefined); }
    throw error;
  } finally { await mailbox.close().catch(()=>undefined); }
}

async function atomicJson(filename:string, value:unknown) {
  await mkdir(path.dirname(filename),{recursive:true,mode:0o700});
  const temporary=`${filename}.${randomUUID()}.tmp`;
  const file=await open(temporary,'wx',0o600);
  try {await file.writeFile(JSON.stringify(value)+'\n'); await file.sync();} finally {await file.close();}
  await rename(temporary,filename);
  const directory=await open(path.dirname(filename),'r');
  try {await directory.sync();} finally {await directory.close();}
}
export function fileState(filename:string):StatePort {
  const dir=path.dirname(filename);
  const readJson=async<T>(file:string,fallback:T):Promise<T>=>{try {return JSON.parse(await readFile(file,'utf8')) as T;} catch(error) {if ((error as NodeJS.ErrnoException).code==='ENOENT') return fallback; throw new ReceiverError('invalid_state_file');}};
  return {
    // Durable: temp file + fsync + rename, previous good copy kept as .prev and used if the main file is torn/corrupt.
    async load() {
      for (const candidate of [filename,`${filename}.prev`]) {
        try {return CheckpointSchema.parse(JSON.parse(await readFile(candidate,'utf8')));} catch(error) {if ((error as NodeJS.ErrnoException).code!=='ENOENT') continue;}
      }
      const exists=await Promise.all([filename,`${filename}.prev`].map(f=>readFile(f).then(()=>true,()=>false)));
      if (exists.some(Boolean)) throw new ReceiverError('invalid_checkpoint');
      return null;
    },
    async save(checkpoint) {
      const value=CheckpointSchema.parse(checkpoint);
      await copyFile(filename,`${filename}.prev`).catch(()=>undefined);
      await atomicJson(filename,value);
    },
    quarantine:record=>atomicJson(path.join(dir,'quarantine',`${record.transportKey.replace(':','-')}.json`),record),
    async skip(record) {
      await mkdir(dir,{recursive:true,mode:0o700});
      const log=path.join(dir,'skipped.jsonl');
      // Keep the log bounded: rotate once at 5 MiB.
      const size=await readFile(log).then(b=>b.length,()=>0);
      if (size>5*1024*1024) await rename(log,`${log}.1`);
      const file=await open(log,'a',0o600);
      try {await file.appendFile(JSON.stringify(record)+'\n'); await file.sync();} finally {await file.close();}
    },
    async recordFailure(key,code) {
      const file=path.join(dir,'failures.json'); const all=await readJson<Record<string,{count:number;code:string}>>(file,{});
      all[key]={count:(all[key]?.count??0)+1,code}; await atomicJson(file,all); return all[key].count;
    },
    async clearFailure(key) {
      const file=path.join(dir,'failures.json'); const all=await readJson<Record<string,unknown>>(file,{});
      if (key in all) {delete all[key]; await atomicJson(file,all);}
    },
    async alert(alert) {
      const file=path.join(dir,'alert.json');
      if (alert) await atomicJson(file,alert); else await rm(file,{force:true});
    },
    status:status=>atomicJson(path.join(dir,'status.json'),status),
  };
}

/** Password string (original behaviour) or an OAuth token provider. `extraCa` (PEM) is trusted in addition to the system roots; verification is never disabled. */
export function imapMailbox(config:MailboxConfig,auth:string|TokenProvider,options:{extraCa?:string[]}={}):MailboxPort {
  const tlsOptions=options.extraCa?.length?{rejectUnauthorized:true,ca:[...rootCertificates,...options.extraCa]}:{rejectUnauthorized:true};
  const build=(credentials:{pass:string}|{accessToken:string})=>{
    const created=new ImapFlow({host:config.host,port:config.port,secure:true,auth:{user:config.user,...credentials},
      logger:false,logRaw:false,disableAutoIdle:true,disableCompression:true,
      connectionTimeout:30000,greetingTimeout:15000,socketTimeout:60000,
      maxLiteralSize:MAX_MESSAGE_BYTES,maxResponseSize:MAX_MESSAGE_BYTES+1024*1024,tls:tlsOptions});
    // Socket errors must never print provider strings (which may contain addresses).
    created.on('error',()=>undefined);
    return created;
  };
  let client:ImapFlow|undefined=typeof auth==='string'?build({pass:auth}):undefined;
  const connected=()=>client!;
  const isAuthFailure=(error:unknown)=>!!(error as {authenticationFailed?:boolean}).authenticationFailed;
  return {
    async open() {
      if (typeof auth!=='string') {
        // A token the server rejects (revoked, rotated key) is retried once with a freshly issued one before alerting.
        for (let attempt=0;;attempt++) {
          const token=await auth.getToken();
          client=build({accessToken:token});
          try {await client.connect();break;}
          catch(error) {
            client.close(); auth.invalidate();
            if (!isAuthFailure(error)) throw error;
            if (attempt>=1) throw new ReceiverError('imap_auth_failed');
          }
        }
      } else {
        try {await connected().connect();} catch(error) {if (isAuthFailure(error)) throw new ReceiverError('imap_auth_failed'); throw error;}
      }
      const box=await connected().mailboxOpen(config.mailbox,{readOnly:true});return {uidValidity:String(box.uidValidity),uidNext:box.uidNext};},
    async firstUidSince(date) {const found=await connected().search({since:new Date(`${date}T00:00:00Z`)},{uid:true}); return found&&found.length?Math.min(...found):null;},
    async list(afterUid,limit,beforeUid) {
      if (afterUid>=beforeUid-1) return [];
      const found=await connected().search({uid:`${afterUid+1}:${beforeUid-1}`},{uid:true});
      const uids=(found||[]).filter(uid=>uid>afterUid&&uid<beforeUid).sort((a,b)=>a-b).slice(0,limit);
      if (!uids.length) return [];
      const messages=await connected().fetchAll(uids.join(','),{uid:true,size:true,envelope:true,headers:AUTOMATION_HEADERS},{uid:true});
      return messages.map(message=>({uid:message.uid,size:message.size ?? -1,subject:message.envelope?.subject||'',from:message.envelope?.from?.[0]?.address?.toLowerCase(),headers:parseHeaderBlock(message.headers)}));
    },
    async raw(uid) {const message=await connected().fetchOne(String(uid),{source:true},{uid:true}); if (!message||!message.source) throw new ReceiverError('message_unavailable');return message.source;},
    async close() {if (!client) return; try {await client.logout();} finally {client.close();}},
  };
}

export function httpIntake(token:string, endpoint='http://app:3087/api/intake', request:typeof fetch=fetch) {
  return async (input:IntakeEmail) => {
    const response=await request(endpoint,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify(input),signal:AbortSignal.timeout(30000)});
    await response.body?.cancel();
    if (response.status===202) return;
    // 401/403 is an operator problem (token), 4xx is this message's problem, anything else is a transient desk problem.
    if (response.status===401||response.status===403) throw new ReceiverError('intake_unauthorized');
    if (response.status>=400&&response.status<500&&![408,429].includes(response.status)) throw new ReceiverError('intake_rejected');
    throw new ReceiverError('intake_not_accepted');
  };
}
export function safeErrorCode(error:unknown) {return error instanceof ReceiverError||error instanceof TokenError?error.code:'mailbox_poll_failed';}
export function retryDelaySeconds(interval:number, failures:number) {return Math.min(900,interval*2**Math.min(failures,10));}
