import {it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {parseInput} from '../packages/ingestion';
import {MockProvider} from '../packages/ai';
it('never silently selects the last of multiple emailed CSV attachments',async()=>{
 const csv='po_number,sku,quantity,unit,shipping_address\nSAFE-101,BR-6204-2RS,2,each,MAIN\n';
 const body=['From: synthetic@example.test','To: orders@example.test','Subject: attachments','MIME-Version: 1.0','Content-Type: multipart/mixed; boundary="test-boundary"','','--test-boundary','Content-Type: text/plain','','Please review both files.',...['one.csv','two.csv'].flatMap(name=>['--test-boundary','Content-Type: text/csv',`Content-Disposition: attachment; filename="${name}"`,'Content-Transfer-Encoding: base64','',Buffer.from(csv).toString('base64')]),'--test-boundary--',''].join('\r\n');
 const result=await parseInput({filename:'multi.eml',mediaType:'message/rfc822',content:Buffer.from(body),messageId:'mail',documentId:'doc'});
 expect(result.structured).toBeUndefined();expect(result.reasons?.some(r=>r.code==='CONFLICTING_DOCUMENT_VERSIONS')).toBe(true);
});
it('links repeated identical PDF lines to distinct source offsets across pages',async()=>{
 const result=await parseInput({filename:'PDF-005.eml',mediaType:'message/rfc822',content:await readFile('fixtures/pdf/PDF-005.eml'),messageId:'mail',documentId:'doc'});
 const {extracted}=await new MockProvider().extract(result);
 const refs=extracted.lines.map(line=>extracted.evidence.find(e=>e.id===line.evidenceIds[0])!);
 expect(extracted.lines).toHaveLength(60);expect(new Set(refs.map(e=>`${e.documentId}:${e.startOffset}`)).size).toBe(60);expect(new Set(refs.map(e=>e.page)).size).toBeGreaterThan(1);
});
