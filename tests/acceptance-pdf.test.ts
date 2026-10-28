import { describe, expect, it } from 'vitest';
import type { DocumentEvidence } from '../packages/contracts/index';
import { scorePdfCase } from '../scripts/evaluate_pdfs';

const expected=[{sku:'BR-6204-2RS',quantity:'2',unit:'each',quoted_unit_price_gbp:'6.00'}];
const page=(id:string,quote:string,page:number|null):DocumentEvidence=>({id,documentId:'pdf-doc',page,startOffset:0,endOffset:quote.length,quote,field:null,lineId:null});
const actual=(price:string|null)=>[{id:'line-1',sku:'BR-6204-2RS',quantity:'2',unit:'each',quotedUnitPrice:price,rawText:`BR-6204-2RS 2 each £${price??''}`,
  evidenceIds:['line-evidence'],evidencePages:[1],evidenceQuotes:[`BR-6204-2RS 2 each £${price??''}`]}];

describe('PDF acceptance measurements',()=>{
  it('counts SKU, quantity, unit, price, exact line, and page-backed evidence independently',()=>{
    const refs=[page('line-evidence','BR-6204-2RS 2 each £6.00',1)];
    const score=scorePdfCase(expected,actual('6.00'),refs,'pdf-doc');
    expect(score).toMatchObject({
      sku:{passed:1,denominator:1},quantity:{passed:1,denominator:1},unit:{passed:1,denominator:1},quotedUnitPrice:{passed:1,denominator:1},
      exactLines:{passed:1,denominator:1},sourcePageEvidence:{passed:1,denominator:1},actualLineEvidence:{passed:1,denominator:1},
    });
  });
  it('does not infer a missing extracted price from the label',()=>{
    const refs=[page('line-evidence','BR-6204-2RS 2 each £6.00',1)];
    const score=scorePdfCase(expected,actual(null),refs,'pdf-doc');
    expect(score.quotedUnitPrice).toEqual({passed:0,denominator:1});
    expect(score.exactLines).toEqual({passed:0,denominator:1});
  });
  it('does not count evidence without a PDF page number as page evidence',()=>{
    const refs=[page('line-evidence','BR-6204-2RS 2 each £6.00',null)];
    const score=scorePdfCase(expected,actual('6.00'),refs,'pdf-doc');
    expect(score.sourcePageEvidence).toEqual({passed:0,denominator:1});
    expect(score.actualLineEvidence).toEqual({passed:0,denominator:1});
  });
});
