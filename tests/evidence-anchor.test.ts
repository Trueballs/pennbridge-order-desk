import {it,expect} from 'vitest';
import {anchorEvidence} from '../packages/domain';
const text='Hi,\nPlease book PO PB-001: 2 packs of FB-0830-A2-100.\nThanks';
it('re-anchors a verbatim quote whose offsets the model miscounted',()=>{
 const e=[{documentId:'d',quote:'2 packs of FB-0830-A2-100',startOffset:31,endOffset:56}];
 anchorEvidence(e,new Map([['d',text]]));
 expect(text.slice(e[0].startOffset,e[0].endOffset)).toBe('2 packs of FB-0830-A2-100');
});
it('leaves a fabricated quote untouched so the caller rejects it',()=>{
 const e=[{documentId:'d',quote:'20 packs of FB-0830-A2-100',startOffset:31,endOffset:57}];
 anchorEvidence(e,new Map([['d',text]]));
 expect(e[0].startOffset).toBe(31);
});
