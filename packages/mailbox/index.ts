import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ImapFlow } from 'imapflow';

export const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;
export const MailboxConfigSchema = z.object({
  host: z.string().min(1).max(253), port: z.literal(993).default(993),
  user: z.string().min(1).max(320), mailbox: z.string().min(1).max(500).default('INBOX'),
  subjectPrefix: z.string().min(1).max(200).default('[PENNBRIDGE TEST]'),
  pollIntervalSeconds: z.number().int().min(10).max(3600).default(60),
  startPolicy: z.literal('new-only').default('new-only'),
}).strict();
export type MailboxConfig = z.infer<typeof MailboxConfigSchema>;
const IdentitySchema = z.object({host:z.string(), user:z.string(), path:z.string()}).strict();
const CheckpointSchema = z.object({identity:IdentitySchema, uidValidity:z.string().regex(/^\d+$/), lastUid:z.number().int().min(0).max(4294967295)}).strict();
export type Checkpoint = z.infer<typeof CheckpointSchema>;
export type MailMetadata = {uid:number; size:number; subject:string};
export interface MailboxPort {
  open():Promise<{uidValidity:string; uidNext:number}>;
  list(afterUid:number, limit:number, beforeUid:number):Promise<MailMetadata[]>;
  raw(uid:number):Promise<Buffer>;
  close():Promise<void>;
}
export interface StatePort {
  load():Promise<Checkpoint|null>;
  save(checkpoint:Checkpoint):Promise<void>;
  quarantine(record:{transportKey:string;uid:number;size:number;reason:'message_too_large'}):Promise<void>;
}
export type IntakeEmail = {filename:string;mediaType:'message/rfc822';contentBase64:string;channel:'email';externalMessageId:string};
export class ReceiverError extends Error {
  constructor(public readonly code:string) { super(code); }
}
export function mailboxIdentity(config:MailboxConfig) { return {host:config.host.toLowerCase(),user:config.user,path:config.mailbox}; }
export function transportKey(checkpoint:Checkpoint, uid:number) {
  return 'imap:'+createHash('sha256').update(JSON.stringify([checkpoint.identity,checkpoint.uidValidity,uid])).digest('hex');
}

/** One poll is sequential: a failed UID can never be skipped by a later success. */
export async function pollMailbox(config:MailboxConfig, mailbox:MailboxPort, state:StatePort, submit:(input:IntakeEmail)=>Promise<void>) {
  try {
    const current = await mailbox.open();
    if (!/^\d+$/.test(current.uidValidity) || !Number.isSafeInteger(current.uidNext) || current.uidNext < 1 || current.uidNext > 4294967296) throw new ReceiverError('invalid_mailbox_state');
    let checkpoint = await state.load();
    const identity = mailboxIdentity(config);
    if (!checkpoint) {
      checkpoint = {identity,uidValidity:current.uidValidity,lastUid:current.uidNext-1};
      await state.save(checkpoint);
      return {ready:true,processed:0};
    }
    if (JSON.stringify(checkpoint.identity)!==JSON.stringify(identity)) throw new ReceiverError('mailbox_identity_changed_reset_required');
    if (checkpoint.uidValidity!==current.uidValidity) throw new ReceiverError('uidvalidity_changed_reset_required');
    const messages = (await mailbox.list(checkpoint.lastUid,20,current.uidNext)).sort((a,b)=>a.uid-b.uid);
    if (messages.length>20 || new Set(messages.map(m=>m.uid)).size!==messages.length || messages.some(m=>!Number.isSafeInteger(m.uid)||m.uid<=checkpoint!.lastUid||m.uid>=current.uidNext||!Number.isSafeInteger(m.size)||m.size<0)) throw new ReceiverError('invalid_message_metadata');
    let processed=0;
    for (const message of messages) {
      const key=transportKey(checkpoint,message.uid);
      if (message.size>MAX_MESSAGE_BYTES) {
        await state.quarantine({transportKey:key,uid:message.uid,size:message.size,reason:'message_too_large'});
      } else if (message.subject.startsWith(config.subjectPrefix)) {
        const content=await mailbox.raw(message.uid);
        if (content.length>MAX_MESSAGE_BYTES) throw new ReceiverError('message_size_changed');
        await submit({filename:`imap-${message.uid}.eml`,mediaType:'message/rfc822',contentBase64:content.toString('base64'),channel:'email',externalMessageId:key});
      }
      checkpoint={...checkpoint,lastUid:message.uid};
      await state.save(checkpoint);
      processed++;
    }
    return {ready:false,processed};
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
  return {
    async load() {try {return CheckpointSchema.parse(JSON.parse(await readFile(filename,'utf8')));} catch(error) {if ((error as NodeJS.ErrnoException).code==='ENOENT') return null; throw new ReceiverError('invalid_checkpoint');}},
    save:checkpoint=>atomicJson(filename,CheckpointSchema.parse(checkpoint)),
    quarantine:record=>atomicJson(path.join(path.dirname(filename),'quarantine',`${record.transportKey.replace(':','-')}.json`),record),
  };
}

/** TLS + EXAMINE + PEEK fetching; never writes flags or mailbox contents. */
export function imapMailbox(config:MailboxConfig,password:string):MailboxPort {
  const client=new ImapFlow({host:config.host,port:config.port,secure:true,auth:{user:config.user,pass:password},
    logger:false,logRaw:false,disableAutoIdle:true,disableCompression:true,
    connectionTimeout:30000,greetingTimeout:15000,socketTimeout:60000,
    maxLiteralSize:MAX_MESSAGE_BYTES,maxResponseSize:MAX_MESSAGE_BYTES+1024*1024,tls:{rejectUnauthorized:true}});
  // Socket errors must never print provider strings (which may contain addresses).
  client.on('error',()=>undefined);
  return {
    async open() {await client.connect(); const box=await client.mailboxOpen(config.mailbox,{readOnly:true});return {uidValidity:String(box.uidValidity),uidNext:box.uidNext};},
    async list(afterUid,limit,beforeUid) {
      if (afterUid>=beforeUid-1) return [];
      const found=await client.search({uid:`${afterUid+1}:${beforeUid-1}`},{uid:true});
      const uids=(found||[]).filter(uid=>uid>afterUid&&uid<beforeUid).sort((a,b)=>a-b).slice(0,limit);
      if (!uids.length) return [];
      const messages=await client.fetchAll(uids.join(','),{uid:true,size:true,envelope:true},{uid:true});
      return messages.map(message=>({uid:message.uid,size:message.size ?? -1,subject:message.envelope?.subject||''}));
    },
    async raw(uid) {const message=await client.fetchOne(String(uid),{source:true},{uid:true}); if (!message||!message.source) throw new ReceiverError('message_unavailable');return message.source;},
    async close() {try {await client.logout();} finally {client.close();}},
  };
}

export function httpIntake(token:string, endpoint='http://app:3087/api/intake', request:typeof fetch=fetch) {
  return async (input:IntakeEmail) => {
    const response=await request(endpoint,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify(input),signal:AbortSignal.timeout(30000)});
    await response.body?.cancel();
    if (response.status!==202) throw new ReceiverError('intake_not_accepted');
  };
}
export function safeErrorCode(error:unknown) {return error instanceof ReceiverError?error.code:'mailbox_poll_failed';}
export function retryDelaySeconds(interval:number, failures:number) {return Math.min(900,interval*2**Math.min(failures,10));}
