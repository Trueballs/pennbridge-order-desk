import {it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {parseInput} from '../packages/ingestion';
import {MockProvider} from '../packages/ai';
import {lineCoverage} from '../packages/domain';
const parse=async(id:string)=>parseInput({filename:`${id}.eml`,mediaType:'message/rfc822',content:await readFile(`fixtures/pdf/${id}.eml`),messageId:id,documentId:`doc-${id}`});
it('blocks a 60-row PDF when the model silently drops lines (live Gemini run 2, PDF-005)',async()=>{
 const p=await parse('PDF-005');
 expect(lineCoverage(p.text,1)?.code).toBe('INCOMPLETE_EXTRACTION');
 expect(lineCoverage(p.text,0)?.message).toMatch(/60 tabular order rows/);
});
it('does not fire when every row was extracted',async()=>{
 for(const id of ['PDF-001','PDF-005','PDF-010']){
  const p=await parse(id);const {extracted}=await new MockProvider().extract({text:p.text,documents:p.documents,evidence:p.evidence});
  expect(lineCoverage(p.text,extracted.lines.length)).toBeNull();
 }
});
it('ignores prose orders without tabular rows',()=>{
 expect(lineCoverage('Please book PO PB-001: 2 packs of FB-0830-A2-100.',0)).toBeNull();
});
