import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DocumentEvidence, ExtractedLine } from '../packages/contracts/index';
import { MockProvider } from '../packages/ai/index';
import { parseInput } from '../packages/ingestion/index';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
type ExpectedLine={sku:string;quantity:string;unit:string;quoted_unit_price_gbp:string};
type PdfCase={id:string;layout:number;pdf:string;email:string;sha256:string;expected_lines:ExpectedLine[]};
type MeasuredLine={id:string;sku:string|null;quantity:string|null;unit:string|null;quotedUnitPrice:string|null;rawText:string;evidenceIds:string[];evidencePages:Array<number|null>;evidenceQuotes:string[]};
export type PdfCaseResult={id:string;layout:number;inputSha256:string;emailSha256:string;latencyMs:number;status:'evaluated'|'error';
  pageCount:number|null;expectedLineCount:number;actualLineCount:number;expectedLines:ExpectedLine[];actualLines:MeasuredLine[];
  counts:{sku:{passed:number;denominator:number};quantity:{passed:number;denominator:number};unit:{passed:number;denominator:number};quotedUnitPrice:{passed:number;denominator:number};
    exactLines:{passed:number;denominator:number};sourcePageEvidence:{passed:number;denominator:number};actualLineEvidence:{passed:number;denominator:number}};
  error?:string};

const sha=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const normalized=(v:unknown)=>String(v??'').toLowerCase().replace(/[^a-z0-9.]+/g,'').replace(/\.00$/,'');
function multisetMatches<T>(expected:T[],actual:T[],key:(v:T)=>string):number{
  const remaining=actual.map(key);let matched=0;
  for(const item of expected){const k=key(item),index=remaining.indexOf(k);if(index>=0){matched++;remaining.splice(index,1);}}
  return matched;
}
function pageContainsExpectedLine(e:ExpectedLine,evidence:DocumentEvidence[]):boolean{
  const byPage=new Map<number,string>();
  for(const x of evidence){if(x.page===null)continue;byPage.set(x.page,`${byPage.get(x.page)||''}\n${x.quote}`);}
  const required=[e.sku,e.quantity,e.unit,e.quoted_unit_price_gbp].map(normalized);
  return [...byPage.values()].some(page=>required.every(value=>normalized(page).includes(value)));
}
function actualEvidenceIsSourcePage(line:MeasuredLine, evidence:DocumentEvidence[], pdfDocumentId:string):boolean{
  if(!line.evidenceIds.length)return false;
  const pages=new Map<number,string>();
  for(const x of evidence){if(x.documentId===pdfDocumentId&&x.page!==null)pages.set(x.page,`${pages.get(x.page)||''}\n${x.quote}`);}
  return line.evidenceIds.every(id=>{
    const ref=evidence.find(x=>x.id===id);
    return !!ref&&ref.documentId===pdfDocumentId&&ref.page!==null&&ref.page>0&&
      normalized(pages.get(ref.page)||'').includes(normalized(ref.quote));
  });
}
export function scorePdfCase(expected:ExpectedLine[],actual:MeasuredLine[],pageEvidence:DocumentEvidence[],pdfDocumentId:string){
  const columns=['sku','quantity','unit','quotedUnitPrice'] as const;
  const counts:any={};
  for(const column of columns){
    const expectedValues=expected.map(x=>column==='quotedUnitPrice'?x.quoted_unit_price_gbp:x[column]);
    const actualValues=actual.map(x=>x[column]);
    counts[column]={passed:multisetMatches(expectedValues,actualValues,normalized),denominator:expected.length};
  }
  const actualExact:ExpectedLine[]=actual.map(x=>({sku:x.sku??'',quantity:x.quantity??'',unit:x.unit??'',quoted_unit_price_gbp:x.quotedUnitPrice??''}));
  counts.exactLines={passed:multisetMatches(expected,actualExact,x=>[normalized(x.sku),normalized(x.quantity),normalized(x.unit),normalized(x.quoted_unit_price_gbp)].join('|')),
    denominator:expected.length};
  counts.sourcePageEvidence={passed:expected.filter(line=>pageContainsExpectedLine(line,pageEvidence)).length,denominator:expected.length};
  counts.actualLineEvidence={passed:actual.filter(line=>actualEvidenceIsSourcePage(line,pageEvidence,pdfDocumentId)).length,denominator:expected.length};
  return counts;
}

async function runCase(c:PdfCase,provider:MockProvider):Promise<PdfCaseResult>{
  const start=performance.now(),email=await readFile(path.join(ROOT,c.email)),expectedPdfHash=c.sha256;
  const result:PdfCaseResult={id:c.id,layout:c.layout,inputSha256:expectedPdfHash,emailSha256:sha(email),latencyMs:0,status:'error',pageCount:null,
    expectedLineCount:c.expected_lines.length,actualLineCount:0,expectedLines:c.expected_lines,actualLines:[],counts:{
      sku:{passed:0,denominator:c.expected_lines.length},quantity:{passed:0,denominator:c.expected_lines.length},unit:{passed:0,denominator:c.expected_lines.length},
      quotedUnitPrice:{passed:0,denominator:c.expected_lines.length},exactLines:{passed:0,denominator:c.expected_lines.length},
      sourcePageEvidence:{passed:0,denominator:c.expected_lines.length},actualLineEvidence:{passed:0,denominator:c.expected_lines.length}}};
  try{
    const parsed=await parseInput({filename:path.basename(c.email),mediaType:'message/rfc822',content:email,messageId:c.id,documentId:`doc-${c.id}`});
    const pdf=parsed.documents.find(d=>d.filename.toLowerCase().endsWith('.pdf'));
    if(!pdf)throw new Error('Email did not produce a parsed PDF attachment.');
    if(pdf.contentHash!==expectedPdfHash)throw new Error(`Frozen PDF hash mismatch: expected ${expectedPdfHash}, received ${pdf.contentHash}.`);
    result.pageCount=pdf.pageCount;
    const {extracted}=await provider.extract({text:parsed.text,documents:parsed.documents,evidence:parsed.evidence});
    result.actualLines=extracted.lines.map(line=>{
      const refs=line.evidenceIds.map(id=>extracted.evidence.find(e=>e.id===id)).filter((e):e is DocumentEvidence=>!!e);
      return {id:line.id,sku:line.sku,quantity:line.quantity,unit:line.unit,quotedUnitPrice:line.quotedUnitPrice,rawText:line.rawText,
        evidenceIds:line.evidenceIds,evidencePages:refs.map(e=>e.page),evidenceQuotes:refs.map(e=>e.quote)};
    });
    result.actualLineCount=result.actualLines.length;
    const pdfEvidence=extracted.evidence.filter(e=>e.documentId===pdf.id&&e.page!==null);
    result.counts=scorePdfCase(c.expected_lines,result.actualLines,pdfEvidence,pdf.id);
    result.status='evaluated';
  }catch(error){result.error=error instanceof Error?error.message:String(error);}
  result.latencyMs=Math.round((performance.now()-start)*100)/100;
  return result;
}

export async function evaluatePdfs(){
  const cases=JSON.parse(await readFile(path.join(ROOT,'fixtures/pdf/cases.json'),'utf8')) as PdfCase[];
  if(cases.length!==20)throw new Error(`Expected the fixed 20-case PDF suite; found ${cases.length}.`);
  const provider=new MockProvider(),results:PdfCaseResult[]=[];
  for(const c of cases)results.push(await runCase(c,provider));
  const evaluated=results.filter(r=>r.status==='evaluated');
  const keys=['sku','quantity','unit','quotedUnitPrice','exactLines','sourcePageEvidence','actualLineEvidence'] as const;
  const fieldCounts=Object.fromEntries(keys.map(k=>[k,{passed:evaluated.reduce((n,r)=>n+r.counts[k].passed,0),denominator:evaluated.reduce((n,r)=>n+r.counts[k].denominator,0)}]));
  const exactCaseCount=evaluated.filter(r=>r.counts.exactLines.passed===r.counts.exactLines.denominator&&r.counts.sourcePageEvidence.passed===r.counts.sourcePageEvidence.denominator).length;
  const latency=results.map(r=>r.latencyMs).sort((a,b)=>a-b);
  const summary={caseCount:cases.length,evaluated:evaluated.length,errors:cases.length-evaluated.length,exactCases:exactCaseCount,fieldCounts,
    latencyMs:{median:latency[Math.floor((latency.length-1)/2)]??null,p95:latency[Math.ceil(latency.length*.95)-1]??null},
    mode:'offline deterministic MockProvider; not AI accuracy',pdfExtractor:'production parseInput / pdfjs text extraction',referenceDate:'2026-11-02'};
  const bundle={schemaVersion:1,createdAt:new Date().toISOString(),summary,results};
  const out=path.join(ROOT,'results/acceptance');await mkdir(out,{recursive:true});
  await writeFile(path.join(out,'pdf-run.json'),JSON.stringify(bundle,null,2)+'\n');
  const md=['# PDF acceptance run','',`Run: ${bundle.createdAt}`,`Mode: ${summary.mode}`,`PDF extraction: ${summary.pdfExtractor}`,'',
    `- Cases: ${summary.caseCount}; evaluated: ${summary.evaluated}; errors: ${summary.errors}; exact lines + source-page evidence: ${summary.exactCases}/${summary.evaluated}`,
    ...keys.map(k=>`- ${k}: ${summary.fieldCounts[k].passed}/${summary.fieldCounts[k].denominator}`),
    `- Latency median / p95: ${summary.latencyMs.median} / ${summary.latencyMs.p95} ms`,'',
    '| Case | Layout | Pages | Lines expected / actual | Exact lines | Source evidence | Line evidence | ms |','|---|---:|---:|---:|---:|---:|---:|---:|',
    ...results.map(r=>`| ${r.id} | ${r.layout} | ${r.pageCount??'—'} | ${r.expectedLineCount} / ${r.actualLineCount} | ${r.counts.exactLines.passed}/${r.counts.exactLines.denominator} | ${r.counts.sourcePageEvidence.passed}/${r.counts.sourcePageEvidence.denominator} | ${r.counts.actualLineEvidence.passed}/${r.counts.actualLineEvidence.denominator} | ${r.latencyMs} |`),
    '', 'Source-page evidence checks that all expected SKU, quantity, unit and price tokens occur together on at least one page. Actual line evidence checks that each mock line reference points to a page-backed quote from the parsed PDF. Missing extracted prices are counted as misses; the evaluator does not fill them from expected labels.',
    'These are 20 synthetic machine-generated PDFs evaluated through a rule-based mock provider. Results are not AI accuracy and do not establish scanned-PDF/OCR support, production accuracy or end-to-end order acceptance.'];
  await writeFile(path.join(out,'pdf-run.md'),md.join('\n')+'\n');
  return bundle;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  evaluatePdfs().then(({summary})=>console.log(JSON.stringify(summary,null,2))).catch(error=>{console.error(error);process.exitCode=1;});
}
