import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { automatedReason, Checkpoint, fileState, httpIntake, MailboxConfigSchema, MailboxPort, parseHeaderBlock, pollMailbox, ReceiverError, SenderRateLimiter, StatePort } from '../packages/mailbox';

const base={host:'imap.example.test',user:'orders@example.test'};
const identity={host:base.host,user:base.user,path:'INBOX'};
const cfg=(extra:Record<string,unknown>={})=>MailboxConfigSchema.parse({...base,...extra});
function harness(config=cfg(),lastUid:number|null=10) {
  let checkpoint:Checkpoint|null=lastUid===null?null:{identity,uidValidity:'42',lastUid};
  const state:StatePort={load:async()=>checkpoint,save:vi.fn(async v=>{checkpoint=structuredClone(v);}),quarantine:vi.fn(async()=>undefined),skip:vi.fn(async()=>undefined),alert:vi.fn(async()=>undefined)};
  const mailbox:MailboxPort={open:vi.fn(async()=>({uidValidity:'42',uidNext:30})),list:vi.fn(async()=>[]),raw:vi.fn(async()=>Buffer.from('Subject: x\r\n\r\nbody')),close:vi.fn(async()=>undefined)};
  const submit=vi.fn(async()=>undefined);
  return {config,state,mailbox,submit,checkpoint:()=>checkpoint};
}
const meta=(uid:number,extra:Record<string,unknown>={})=>({uid,size:100,subject:'Order PO-1',from:'buyer@customer.test',...extra});

describe('subject prefix is optional',()=>{
  it('defaults to ingesting everything',async()=>{
    expect(cfg().subjectPrefix).toBe('');
    const h=harness();vi.mocked(h.mailbox.list).mockResolvedValue([meta(11,{subject:'anything at all'}),meta(12,{subject:'[X] other',from:'b@c.test'})]);
    await pollMailbox(h.config,h.mailbox,h.state,h.submit);expect(h.submit).toHaveBeenCalledTimes(2);
  });
  it('still filters when a prefix is configured',async()=>{
    const h=harness(cfg({subjectPrefix:'[PO]'}));vi.mocked(h.mailbox.list).mockResolvedValue([meta(11,{subject:'hello'}),meta(12,{subject:'[PO] 1'})]);
    await pollMailbox(h.config,h.mailbox,h.state,h.submit);expect(h.submit).toHaveBeenCalledTimes(1);expect(h.checkpoint()?.lastUid).toBe(12);
  });
});

describe('auto-reply and bulk pre-filter',()=>{
  it('parses folded headers',()=>{
    expect(parseHeaderBlock('Auto-Submitted: auto-replied\r\nList-Id: <a.b>\r\nContent-Type: multipart/report;\r\n report-type=delivery-status\r\n\r\n')).toEqual({'auto-submitted':'auto-replied','list-id':'<a.b>','content-type':'multipart/report; report-type=delivery-status'});
  });
  it.each([
    [{'auto-submitted':'auto-generated'},'auto_submitted'],[{precedence:'bulk'},'precedence_bulk'],[{'list-unsubscribe':'<mailto:x>'},'bulk_list'],
    [{'x-auto-response-suppress':'All'},'auto_reply_header'],[{'return-path':'<>'},'null_return_path'],[{'content-type':'multipart/report; report-type=delivery-status'},'delivery_report'],
  ])('flags %j',(headers,reason)=>{expect(automatedReason({subject:'s',from:'a@b.test',headers})).toBe(reason);});
  it('flags system senders and auto-reply subjects but not normal or noreply ERP mail',()=>{
    expect(automatedReason({subject:'x',from:'mailer-daemon@mx.test'})).toBe('system_sender');
    expect(automatedReason({subject:'Automatic reply: PO 5',from:'a@b.test'})).toBe('auto_reply_subject');
    expect(automatedReason({subject:'Purchase order 5',from:'noreply@erp.customer.test',headers:{'auto-submitted':'no'}})).toBeNull();
  });
  it('skips with a log record, never fetches the body and still advances the checkpoint',async()=>{
    const h=harness();vi.mocked(h.mailbox.list).mockResolvedValue([meta(11,{headers:{'auto-submitted':'auto-replied'}}),meta(12,{from:'orders@example.test'}),meta(13)]);
    await pollMailbox(h.config,h.mailbox,h.state,h.submit);
    expect(vi.mocked(h.mailbox.raw).mock.calls.map(c=>c[0])).toEqual([13]);expect(h.checkpoint()?.lastUid).toBe(13);
    expect(vi.mocked(h.state.skip!).mock.calls.map(c=>c[0].reason)).toEqual(['auto_submitted','own_mailbox_message']);
  });
});

describe('per-sender rate limit',()=>{
  it('lets the sliding window refill',()=>{
    let now=0;const l=new SenderRateLimiter(2,1000,()=>now);
    expect([l.allow('a@x.test'),l.allow('A@x.test'),l.allow('a@x.test'),l.allow('b@x.test')]).toEqual([true,true,false,true]);
    now=1500;expect(l.allow('a@x.test')).toBe(true);expect(new SenderRateLimiter(0).allow('a')).toBe(true);
  });
  it('skips (and logs) messages beyond the limit, ingesting other senders',async()=>{
    const h=harness(cfg({senderRateLimitPerHour:2}));const events:any[]=[];
    vi.mocked(h.mailbox.list).mockResolvedValue([meta(11),meta(12),meta(13),meta(14,{from:'other@customer.test'})]);
    await pollMailbox(h.config,h.mailbox,h.state,h.submit,{log:e=>events.push(e)});
    expect(h.submit).toHaveBeenCalledTimes(3);expect(vi.mocked(h.state.skip!).mock.calls[0][0]).toMatchObject({uid:13,reason:'sender_rate_limited'});
    expect(events.some(e=>e.event==='mailbox.alert'&&e.code==='sender_rate_limited')).toBe(true);expect(h.checkpoint()?.lastUid).toBe(14);
  });
});

describe('poison quarantine and credential alerts',()=>{
  const memoryFailures=(h:ReturnType<typeof harness>)=>{const counts=new Map<string,number>();h.state.recordFailure=async k=>{counts.set(k,(counts.get(k)??0)+1);return counts.get(k)!;};h.state.clearFailure=async k=>{counts.delete(k);};return counts;};
  it('quarantines a message-specific failure after N attempts and then continues the queue',async()=>{
    const h=harness(cfg({maxAttemptsPerMessage:3}));memoryFailures(h);const events:any[]=[];
    vi.mocked(h.mailbox.list).mockResolvedValue([meta(11),meta(12)]);
    const submit=vi.fn(async(i:{filename:string})=>{if(i.filename==='imap-11.eml') throw new ReceiverError('intake_rejected');});
    for(let i=0;i<2;i++){await expect(pollMailbox(h.config,h.mailbox,h.state,submit,{log:e=>events.push(e)})).rejects.toThrow('intake_rejected');expect(h.checkpoint()?.lastUid).toBe(10);}
    await pollMailbox(h.config,h.mailbox,h.state,submit,{log:e=>events.push(e)});
    expect(h.checkpoint()?.lastUid).toBe(12);expect(h.state.quarantine).toHaveBeenCalledWith(expect.objectContaining({uid:11,reason:'poison_message',code:'intake_rejected',attempts:3}));
    expect(events.some(e=>e.code==='poison_message_quarantined')).toBe(true);
  });
  it('never counts outages, 5xx or generic errors as poison',async()=>{
    const h=harness(cfg({maxAttemptsPerMessage:1}));const counts=memoryFailures(h);vi.mocked(h.mailbox.list).mockResolvedValue([meta(11)]);
    for(const error of [new ReceiverError('intake_not_accepted'),new Error('ECONNRESET'),new ReceiverError('intake_unauthorized')]) await expect(pollMailbox(h.config,h.mailbox,h.state,async()=>{throw error;})).rejects.toThrow();
    expect(counts.size).toBe(0);expect(h.state.quarantine).not.toHaveBeenCalled();expect(h.checkpoint()?.lastUid).toBe(10);
  });
  it('maps HTTP statuses to alert / poison / transient codes',async()=>{
    const call=(status:number)=>httpIntake('t',undefined,vi.fn<typeof fetch>().mockResolvedValue(new Response('',{status})))({filename:'a',mediaType:'message/rfc822',contentBase64:'YQ==',channel:'email',externalMessageId:'k'});
    await expect(call(401)).rejects.toThrow('intake_unauthorized');await expect(call(403)).rejects.toThrow('intake_unauthorized');
    await expect(call(400)).rejects.toThrow('intake_rejected');await expect(call(415)).rejects.toThrow('intake_rejected');
    await expect(call(429)).rejects.toThrow('intake_not_accepted');await expect(call(503)).rejects.toThrow('intake_not_accepted');await expect(call(500)).rejects.toThrow('intake_not_accepted');
  });
  it('raises a persistent alert on 401/403 and clears it after a good poll',async()=>{
    const h=harness();const events:any[]=[];vi.mocked(h.mailbox.list).mockResolvedValue([meta(11)]);
    await expect(pollMailbox(h.config,h.mailbox,h.state,async()=>{throw new ReceiverError('intake_unauthorized');},{log:e=>events.push(e)})).rejects.toThrow('intake_unauthorized');
    expect(h.state.alert).toHaveBeenCalledWith({code:'intake_unauthorized',at:expect.any(String)});expect(events.find(e=>e.event==='mailbox.alert')).toMatchObject({level:'error',code:'intake_unauthorized'});expect(h.checkpoint()?.lastUid).toBe(10);
    await pollMailbox(h.config,h.mailbox,h.state,h.submit);expect(h.state.alert).toHaveBeenLastCalledWith(null);
  });
});

const directories:string[]=[];
afterEach(async()=>{await Promise.all(directories.splice(0).map(d=>rm(d,{recursive:true,force:true})));});
const tmp=async()=>{const d=await mkdtemp(path.join(os.tmpdir(),'pennbridge-mbx-'));directories.push(d);return d;};
describe('durable state',()=>{
  it('baseline is loud and honours ingestSince',async()=>{
    const h=harness(cfg({ingestSince:'2026-10-01'}),null);const events:any[]=[];h.mailbox.firstUidSince=vi.fn(async()=>5);
    expect(await pollMailbox(h.config,h.mailbox,h.state,h.submit,{log:e=>events.push(e)})).toEqual({ready:true,processed:0});
    expect(h.checkpoint()?.lastUid).toBe(4);expect(events[0]).toMatchObject({event:'mailbox.baseline_created',level:'warn',ingestSince:'2026-10-01'});
    const plain=harness(cfg(),null);const e2:any[]=[];await pollMailbox(plain.config,plain.mailbox,plain.state,plain.submit,{log:e=>e2.push(e)});
    expect(plain.checkpoint()?.lastUid).toBe(29);expect(e2[0].message).toMatch(/NOT imported/);
  });
  it('recovers the previous checkpoint if the main file is torn and refuses to restart silently if both are bad',async()=>{
    const d=await tmp();const file=path.join(d,'checkpoint.json');const state=fileState(file);
    await state.save({identity,uidValidity:'42',lastUid:11});await state.save({identity,uidValidity:'42',lastUid:12});
    await writeFile(file,'{"torn');expect((await fileState(file).load())?.lastUid).toBe(11);
    await writeFile(`${file}.prev`,'garbage');await expect(fileState(file).load()).rejects.toThrow('invalid_checkpoint');
  });
  it('persists failure counters, skip log, alert and status across restarts',async()=>{
    const d=await tmp();const file=path.join(d,'checkpoint.json');let s=fileState(file);
    expect(await s.recordFailure!('imap:a','intake_rejected')).toBe(1);s=fileState(file);expect(await s.recordFailure!('imap:a','intake_rejected')).toBe(2);await s.clearFailure!('imap:a');expect(await fileState(file).recordFailure!('imap:a','x')).toBe(1);
    await s.skip!({transportKey:'imap:a',uid:1,from:'a@b.test',subject:'s',reason:'bulk_list',at:'2026-01-01T00:00:00Z'});
    expect(JSON.parse((await readFile(path.join(d,'skipped.jsonl'),'utf8')).trim()).reason).toBe('bulk_list');
    await s.alert!({code:'intake_unauthorized',at:'t'});expect(await readdir(d)).toContain('alert.json');await s.alert!(null);expect(await readdir(d)).not.toContain('alert.json');
    await s.status!({at:'t',ok:true,ready:false,processed:0,consecutiveFailures:0,errorCode:null});expect(JSON.parse(await readFile(path.join(d,'status.json'),'utf8')).ok).toBe(true);
  });
});
