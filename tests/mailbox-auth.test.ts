import {afterEach,describe,expect,it} from 'vitest';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {ingestionSession,intake} from '../packages/server';
let directory='';const previous=process.env.MAILBOX_INGESTION_TOKEN_FILE;
afterEach(async()=>{if(previous===undefined)delete process.env.MAILBOX_INGESTION_TOKEN_FILE;else process.env.MAILBOX_INGESTION_TOKEN_FILE=previous;if(directory)await rm(directory,{recursive:true,force:true});});
describe('dedicated mailbox intake authority',()=>{
 it('accepts only the separate file token and does not grant reviewer permissions',async()=>{
  directory=await mkdtemp(path.join(tmpdir(),'pennbridge-mail-auth-'));const token=randomBytes(32).toString('hex');
  process.env.MAILBOX_INGESTION_TOKEN_FILE=path.join(directory,'token');await writeFile(process.env.MAILBOX_INGESTION_TOKEN_FILE,token,{mode:0o600});
  expect(ingestionSession('wrong')).toBeNull();expect(ingestionSession(token)).toMatchObject({role:'ingestion',userId:'mailbox-ingestion'});
 });
 it('rejects asserted customer identity or another channel before database access',async()=>{
  const actor={userId:'mailbox-ingestion',email:'mailbox@pennbridge.example',name:'Test mailbox',role:'ingestion' as const,expiresAt:new Date(Date.now()+10000).toISOString()};
  const input={filename:'test.eml',mediaType:'message/rfc822',contentBase64:Buffer.from('test').toString('base64'),channel:'email' as const};
  await expect(intake(actor,{...input,trustedCustomerId:'C001'})).rejects.toMatchObject({status:403});
  await expect(intake(actor,{...input,channel:'upload'})).rejects.toMatchObject({status:403});
 });
});
