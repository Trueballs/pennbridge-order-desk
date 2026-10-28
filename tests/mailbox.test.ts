import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Checkpoint, fileState, httpIntake, imapMailbox, MailboxConfigSchema, MailboxPort, MAX_MESSAGE_BYTES, pollMailbox, retryDelaySeconds, safeErrorCode, StatePort, transportKey } from '../packages/mailbox';

const imap=vi.hoisted(()=>({options:{} as Record<string,unknown>,connect:vi.fn(),mailboxOpen:vi.fn(),search:vi.fn(),fetchAll:vi.fn(),fetchOne:vi.fn(),logout:vi.fn(),close:vi.fn(),on:vi.fn()}));
vi.mock('imapflow',()=>({ImapFlow:class {
  constructor(options:Record<string,unknown>) {imap.options=options;}
  connect=imap.connect;mailboxOpen=imap.mailboxOpen;search=imap.search;fetchAll=imap.fetchAll;fetchOne=imap.fetchOne;logout=imap.logout;close=imap.close;on=imap.on;
}}));

const config=MailboxConfigSchema.parse({host:'imap.example.test',user:'orders@example.test'});
const identity={host:config.host,user:config.user,path:'INBOX'};
function harness(lastUid:number|null=10) {
  let checkpoint:Checkpoint|null=lastUid===null?null:{identity,uidValidity:'42',lastUid};
  const quarantine=vi.fn(async()=>undefined);
  const state:StatePort={load:async()=>checkpoint,save:vi.fn(async value=>{checkpoint=structuredClone(value);}),quarantine};
  const mailbox:MailboxPort={open:vi.fn(async()=>({uidValidity:'42',uidNext:30})),list:vi.fn(async()=>[]),raw:vi.fn(async()=>Buffer.from('Subject: [PENNBRIDGE TEST] test\r\n\r\nSynthetic order')),close:vi.fn(async()=>undefined)};
  const submit=vi.fn(async()=>undefined);
  return {state,mailbox,submit,quarantine,checkpoint:()=>checkpoint};
}
const metadata=(uid:number,size=100,subject='[PENNBRIDGE TEST] order')=>({uid,size,subject});
describe('read-only mailbox receiver',()=>{
  it('baselines at UIDNEXT minus one and does not ingest existing mail',async()=>{
    const h=harness(null);
    expect(await pollMailbox(config,h.mailbox,h.state,h.submit)).toEqual({ready:true,processed:0});
    expect(h.checkpoint()?.lastUid).toBe(29);expect(h.mailbox.list).not.toHaveBeenCalled();expect(h.submit).not.toHaveBeenCalled();expect(h.mailbox.close).toHaveBeenCalledOnce();
  });
  it('processes UIDs ascending and resumes after a restart without unseen flags',async()=>{
    const h=harness();vi.mocked(h.mailbox.list).mockResolvedValue([metadata(13),metadata(11),metadata(12)]);
    await pollMailbox(config,h.mailbox,h.state,h.submit);
    expect(vi.mocked(h.mailbox.raw).mock.calls.map(call=>call[0])).toEqual([11,12,13]);
    expect(h.checkpoint()?.lastUid).toBe(13);
  });
  it('submits full MIME with stable transport identity and no trusted customer',async()=>{
    const h=harness();vi.mocked(h.mailbox.list).mockResolvedValue([metadata(11)]);
    const inputs:unknown[]=[];
    await pollMailbox(config,h.mailbox,h.state,async input=>{inputs.push(input);});
    expect(inputs).toEqual([{filename:'imap-11.eml',mediaType:'message/rfc822',contentBase64:Buffer.from('Subject: [PENNBRIDGE TEST] test\r\n\r\nSynthetic order').toString('base64'),channel:'email',externalMessageId:transportKey({identity,uidValidity:'42',lastUid:10},11)}]);
    vi.mocked(h.mailbox.list).mockResolvedValue([]);
    await pollMailbox(config,h.mailbox,h.state,h.submit);
    expect(h.mailbox.list).toHaveBeenLastCalledWith(11,20,30);
  });
  it('holds failed UID and retries the same key, without touching later UIDs',async()=>{
    const h=harness();vi.mocked(h.mailbox.list).mockResolvedValue([metadata(11),metadata(12),metadata(13)]);
    const keys:string[]=[];let fail=true;
    const submit=vi.fn(async input=>{keys.push(input.externalMessageId);if (input.filename==='imap-12.eml'&&fail) throw new Error('private provider text');});
    await expect(pollMailbox(config,h.mailbox,h.state,submit)).rejects.toThrow();
    expect(h.checkpoint()?.lastUid).toBe(11);expect(h.mailbox.raw).toHaveBeenCalledTimes(2);
    vi.mocked(h.mailbox.list).mockResolvedValue([metadata(12),metadata(13)]);fail=false;
    await pollMailbox(config,h.mailbox,h.state,submit);expect(keys[1]).toBe(keys[2]);expect(h.checkpoint()?.lastUid).toBe(13);
  });
  it('replays the same key if submission succeeds but checkpoint persistence fails',async()=>{
    const h=harness();vi.mocked(h.mailbox.list).mockResolvedValue([metadata(11)]);
    vi.mocked(h.state.save).mockRejectedValueOnce(new Error('disk unavailable'));
    const keys:string[]=[];const submit=async(input:{externalMessageId:string})=>{keys.push(input.externalMessageId);};
    await expect(pollMailbox(config,h.mailbox,h.state,submit)).rejects.toThrow();
    await pollMailbox(config,h.mailbox,h.state,submit);expect(keys).toHaveLength(2);expect(keys[0]).toBe(keys[1]);
  });
  it('filters subject before loading raw MIME',async()=>{
    const h=harness();vi.mocked(h.mailbox.list).mockResolvedValue([metadata(11,100,'unrelated'),metadata(12)]);
    await pollMailbox(config,h.mailbox,h.state,h.submit);expect(h.mailbox.raw).toHaveBeenCalledExactlyOnceWith(12);expect(h.checkpoint()?.lastUid).toBe(12);
  });
  it('durably quarantines only safe oversize metadata without loading its body',async()=>{
    const h=harness();vi.mocked(h.mailbox.list).mockResolvedValue([metadata(11,MAX_MESSAGE_BYTES+1)]);
    await pollMailbox(config,h.mailbox,h.state,h.submit);
    expect(h.mailbox.raw).not.toHaveBeenCalled();expect(h.submit).not.toHaveBeenCalled();expect(h.checkpoint()?.lastUid).toBe(11);
    expect(h.quarantine).toHaveBeenCalledWith({transportKey:expect.stringMatching(/^imap:[a-f0-9]{64}$/),uid:11,size:MAX_MESSAGE_BYTES+1,reason:'message_too_large'});
  });
  it('does not advance if quarantine fails',async()=>{
    const h=harness();vi.mocked(h.mailbox.list).mockResolvedValue([metadata(11,MAX_MESSAGE_BYTES+1)]);h.quarantine.mockRejectedValueOnce(new Error('disk'));
    await expect(pollMailbox(config,h.mailbox,h.state,h.submit)).rejects.toThrow();expect(h.checkpoint()?.lastUid).toBe(10);
  });
  it('fails closed on UIDVALIDITY or identity changes',async()=>{
    const h=harness();vi.mocked(h.mailbox.open).mockResolvedValue({uidValidity:'43',uidNext:30});
    await expect(pollMailbox(config,h.mailbox,h.state,h.submit)).rejects.toThrow('uidvalidity_changed_reset_required');
    expect(h.mailbox.list).not.toHaveBeenCalled();expect(h.state.save).not.toHaveBeenCalled();
    await expect(pollMailbox({...config,user:'other@example.test'},h.mailbox,h.state,h.submit)).rejects.toThrow('mailbox_identity_changed_reset_required');
  });
  it('rejects oversized bodies if metadata was inaccurate',async()=>{
    const h=harness();vi.mocked(h.mailbox.list).mockResolvedValue([metadata(11)]);vi.mocked(h.mailbox.raw).mockResolvedValue(Buffer.alloc(MAX_MESSAGE_BYTES+1));
    await expect(pollMailbox(config,h.mailbox,h.state,h.submit)).rejects.toThrow('message_size_changed');expect(h.checkpoint()?.lastUid).toBe(10);
  });
  it('rejects batches over 20 and malformed/duplicate UIDs before any body read',async()=>{
    for(const messages of [Array.from({length:21},(_,i)=>metadata(i+11)),[metadata(11),metadata(11)],[metadata(10)]]) {
      const h=harness();vi.mocked(h.mailbox.list).mockResolvedValue(messages);
      await expect(pollMailbox(config,h.mailbox,h.state,h.submit)).rejects.toThrow('invalid_message_metadata');expect(h.mailbox.raw).not.toHaveBeenCalled();
    }
  });
  it('sanitizes arbitrary errors and bounds retry backoff',()=>{
    expect(safeErrorCode(new Error('password secret@example.test'))).toBe('mailbox_poll_failed');
    expect([0,1,2,10].map(n=>retryDelaySeconds(60,n))).toEqual([60,120,240,900]);
  });
  it('accepts only HTTP 202 and sends bearer authentication',async()=>{
    const request=vi.fn<typeof fetch>().mockResolvedValue(new Response('{}',{status:202}));
    const payload={filename:'a.eml',mediaType:'message/rfc822' as const,contentBase64:'YQ==',channel:'email' as const,externalMessageId:'imap:key'};
    await httpIntake('test-token',undefined,request)(payload);
    expect(request).toHaveBeenCalledWith('http://app:3087/api/intake',expect.objectContaining({headers:{'Content-Type':'application/json',Authorization:'Bearer test-token'},body:JSON.stringify(payload)}));
    request.mockResolvedValue(new Response('sensitive response',{status:500}));
    await expect(httpIntake('test-token',undefined,request)(payload)).rejects.toThrow('intake_not_accepted');
  });
  it('uses TLS/read-only IMAP and bounds new arrivals to the poll snapshot',async()=>{
    imap.connect.mockResolvedValue(undefined);imap.mailboxOpen.mockResolvedValue({uidValidity:42n,uidNext:30});
    imap.search.mockResolvedValue([31,11,14,12]);imap.fetchAll.mockResolvedValue([metadata(11),metadata(12),metadata(14)]);
    imap.fetchOne.mockResolvedValue({source:Buffer.from('raw MIME')});imap.logout.mockResolvedValue(undefined);
    const mailbox=imapMailbox(config,'synthetic-test-password');
    expect(imap.options).toMatchObject({secure:true,port:993,logger:false,logRaw:false,maxLiteralSize:MAX_MESSAGE_BYTES,tls:{rejectUnauthorized:true}});
    expect(await mailbox.open()).toEqual({uidValidity:'42',uidNext:30});
    expect(imap.mailboxOpen).toHaveBeenCalledWith('INBOX',{readOnly:true});
    await mailbox.list(10,20,30);
    expect(imap.search).toHaveBeenCalledWith({uid:'11:29'},{uid:true});
    expect(imap.fetchAll).toHaveBeenCalledWith('11,12,14',{uid:true,size:true,envelope:true},{uid:true});
    expect(await mailbox.raw(11)).toEqual(Buffer.from('raw MIME'));
    expect(imap.fetchOne).toHaveBeenCalledWith('11',{source:true},{uid:true});
    await mailbox.close();expect(imap.logout).toHaveBeenCalled();expect(imap.close).toHaveBeenCalled();
  });
});
const directories:string[]=[];
afterEach(async()=>{await Promise.all(directories.splice(0).map(directory=>rm(directory,{recursive:true,force:true})));});
it('persists checkpoint and quarantine safely across adapter restarts',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'pennbridge-mailbox-'));directories.push(directory);
  const filename=path.join(directory,'checkpoint.json');const state=fileState(filename);
  expect(await state.load()).toBeNull();const checkpoint={identity,uidValidity:'42',lastUid:11};await state.save(checkpoint);
  expect(await fileState(filename).load()).toEqual(checkpoint);
  const record={transportKey:transportKey(checkpoint,12),uid:12,size:MAX_MESSAGE_BYTES+1,reason:'message_too_large' as const};await state.quarantine(record);
  expect(JSON.parse(await readFile(path.join(directory,'quarantine',record.transportKey.replace(':','-')+'.json'),'utf8'))).toEqual(record);
});
