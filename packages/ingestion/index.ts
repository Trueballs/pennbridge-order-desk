import { createHash } from 'node:crypto';
import { simpleParser } from 'mailparser';
import sanitizeHtml from 'sanitize-html';
import { parse as parseCsv } from 'csv-parse/sync';
import type { Document, DocumentEvidence, ExtractedOrder, Reason, Unit } from '../contracts/index';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_TEXT = 150_000;
const MAX_PAGES = 20;
export interface ParsedInput {
  documents: Document[]; evidence: DocumentEvidence[]; text: string;
  files: {documentId: string; content: Buffer}[];
  structured?: ExtractedOrder; reasons: Reason[];
  sender?: string; subject?: string; externalMessageId?: string;
}
export function parserReason(code: Reason['code'], message: string): Reason {
  return {code,message,severity:'blocking',lineId:null,evidenceIds:[],resolved:false,resolution:null};
}
export function plainHtml(html: string): string {
  return sanitizeHtml(html.replace(/<\/(?:tr|p|div|h[1-6]|li)>/gi,'\n').replace(/<br\s*\/?>/gi,'\n').replace(/<\/(?:td|th)>/gi,' | '),
    {allowedTags:[],allowedAttributes:{},nonTextTags:['script','style','textarea','option','noscript']});
}

export async function parseInput(input: {filename:string;mediaType:string;content:Buffer;messageId:string;documentId:string}): Promise<ParsedInput> {
  const output:ParsedInput={documents:[],evidence:[],text:'',files:[],reasons:[]};
  if(input.content.length>MAX_BYTES) throw Object.assign(new Error('Maximum document size is 10 MB.'),{code:'FILE_TOO_LARGE',status:413});
  const createdAt=new Date().toISOString();
  let totalBytes=input.content.length;
  const add=async(content:Buffer, filename:string, mediaType:string, kind:Document['kind'], id:string)=>{
    const d:Document={id,messageId:input.messageId,filename:filename.slice(0,250),mediaType,sizeBytes:content.length,
      contentHash:createHash('sha256').update(content).digest('hex'),kind,parser:null,pageCount:null,text:null,createdAt};
    output.documents.push(d);output.files.push({documentId:id,content});
    const pages:string[]=[];
    if(mediaType==='application/pdf'||/\.pdf$/i.test(filename)) {
      d.parser='pdf';
      if(content.subarray(0,5).toString()!=='%PDF-') {output.reasons.push(parserReason('PARSING_FAILED','The file does not contain a valid PDF header.'));return;}
      const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
      const task=pdfjs.getDocument({data:new Uint8Array(content),useSystemFonts:true,disableFontFace:true});
      let timer:ReturnType<typeof setTimeout>|undefined;
      try {
        await Promise.race([(async()=>{
          const pdf=await task.promise;d.pageCount=pdf.numPages;
          if(pdf.numPages>MAX_PAGES) throw new Error('PDF exceeds 20-page limit.');
          for(let n=1;n<=pdf.numPages;n++){
            const p=await pdf.getPage(n);const data=await p.getTextContent();
            const rows=new Map<number,{x:number;text:string}[]>();
            for(const item of data.items){if('str' in item){const y=Math.round(item.transform[5]/3)*3;
              const row=rows.get(y)||[];row.push({x:item.transform[4],text:item.str});rows.set(y,row);}}
            pages.push([...rows].sort((a,b)=>b[0]-a[0]).map(([,r])=>r.sort((a,b)=>a.x-b.x).map(x=>x.text).join(' ')).join('\n'));
          }
        })(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('PDF parsing timed out.')),15000);})]);
      }catch(e){output.reasons.push(parserReason('PARSING_FAILED',e instanceof Error?e.message:'Unable to parse PDF.'));}
      finally {if(timer)clearTimeout(timer);await task.destroy();}
    }else if(mediaType==='text/html'||/\.html?$/i.test(filename)){d.parser='html';pages.push(plainHtml(content.toString('utf8')));}
    else if(mediaType==='text/plain'||/\.txt$/i.test(filename)){d.parser='text';pages.push(content.toString('utf8'));}
    else if(mediaType==='text/csv'||/\.csv$/i.test(filename)){
      d.parser='csv';pages.push(content.toString('utf8'));
      try{output.structured=structuredCsv(content.toString('utf8'),id);}catch(e){output.reasons.push(parserReason('INVALID_STRUCTURED_INPUT',e instanceof Error?e.message:'Invalid CSV.'));}
    }else {d.parser='unsupported';output.reasons.push(parserReason('UNSUPPORTED_FORMAT',`Unsupported attachment: ${filename}. Use text, HTML, CSV or machine-generated PDF.`));return;}
    d.text=pages.join('\n\n');
    if(d.text.length>MAX_TEXT){d.text=d.text.slice(0,MAX_TEXT);output.reasons.push(parserReason('DOCUMENT_TOO_LONG','Document text exceeds 150,000 characters; review manually.'));}
    if(!d.text.trim())output.reasons.push(parserReason('EMPTY_DOCUMENT',`${filename} has no extractable text; scans/OCR are not supported.`));
    let offset=0;
    pages.forEach((page,i)=>{output.evidence.push({id:`${id}_page_${i+1}`,documentId:id,page:d.parser==='pdf'?i+1:null,startOffset:offset,endOffset:offset+page.length,quote:page.slice(0,4000),field:null,lineId:null});offset+=page.length+2;});
  };
  const isEmail=input.mediaType==='message/rfc822'||/\.eml$/i.test(input.filename);
  if(isEmail){
    const mail=await simpleParser(input.content,{skipHtmlToText:true,skipTextToHtml:true,skipImageLinks:true});
    const raw:Document={id:input.documentId,messageId:input.messageId,filename:input.filename,mediaType:'message/rfc822',sizeBytes:input.content.length,contentHash:createHash('sha256').update(input.content).digest('hex'),kind:'email',parser:'mime',pageCount:null,text:null,createdAt};
    output.documents.push(raw);output.files.push({documentId:raw.id,content:input.content});
    output.sender=mail.from?.value[0]?.address;output.subject=mail.subject;output.externalMessageId=mail.messageId;
    await add(Buffer.from(mail.text || (mail.html?plainHtml(mail.html):'')), 'Email body.txt','text/plain','body',`${input.documentId}_body`);
    if(mail.attachments.length>10)output.reasons.push(parserReason('DOCUMENT_TOO_LONG','Email exceeds ten-attachment limit.'));
    for(const [i,a]of mail.attachments.slice(0,10).entries()){
      totalBytes+=a.size;if(totalBytes>MAX_BYTES*2){output.reasons.push(parserReason('FILE_TOO_LARGE','Expanded attachments exceed 20 MB.'));break;}
      await add(a.content,a.filename||`attachment-${i+1}`,a.contentType,'attachment',`${input.documentId}_att_${i+1}`);
    }
    if(/\battach(?:ed|ment)\b/i.test(mail.text||'')&&!mail.attachments.length)output.reasons.push(parserReason('MISSING_ATTACHMENT','The email refers to an attachment but none was received.'));
    if(output.structured){
      // The standalone CSV contract has one source of truth. An email can add
      // conflicting body text or other attachments, so never select the last CSV.
      output.structured=undefined;
      output.reasons.push(parserReason(mail.attachments.length>1?'CONFLICTING_DOCUMENT_VERSIONS':'INVALID_STRUCTURED_INPUT','CSV email attachments require review. Upload a single CSV directly to use the structured import contract.'));
    }
  }else await add(input.content,input.filename,input.mediaType,'upload',input.documentId);
  output.text=output.documents.filter(d=>d.text!==null).map(d=>`[Document: ${d.filename}]\n${d.text}`).join('\n\n');
  if(output.text.length>MAX_TEXT){output.text=output.text.slice(0,MAX_TEXT);output.reasons.push(parserReason('DOCUMENT_TOO_LONG','Combined document text exceeds the extraction limit.'));}
  return output;
}

function structuredCsv(text:string,documentId:string):ExtractedOrder {
  const records=parseCsv(text,{columns:true,skip_empty_lines:true,bom:true,max_record_size:10000}) as Record<string,string>[];
  if(!records.length||records.length>100)throw new Error('CSV needs 1–100 lines.');
  const required=['po_number','sku','quantity','unit','shipping_address'];
  const units=['each','pack','box','pair','roll','metre','litre','kg'];
  for(const r of records){if(required.some(k=>!r[k]))throw new Error(`Required CSV columns: ${required.join(', ')}.`);
    if(!/^-?\d+(\.\d{1,6})?$/.test(r.quantity)||!units.includes(r.unit))throw new Error('Invalid CSV quantity or selling unit.');
    if(r.po_number!==records[0].po_number||r.shipping_address!==records[0].shipping_address)throw new Error('One purchase order/address per CSV.');}
  return {schemaVersion:1,intent:'new_order',poNumber:records[0].po_number,relatedPoNumber:null,revision:null,requestedDeliveryDate:null,
    requestedAddress:records[0].shipping_address,currency:'GBP',quotedTotal:null,
    lines:records.map((r,i)=>({id:`line-${i+1}`,position:i+1,rawText:Object.values(r).join(' | '),sku:r.sku,manufacturerReference:null,customerAlias:null,description:r.description||r.sku,quantity:r.quantity,unit:r.unit as Unit,originalUnit:r.unit,quotedUnitPrice:r.unit_price?Number(r.unit_price).toFixed(2):null,attributes:{},evidenceIds:[`${documentId}_page_1`]})),evidence:[],reasons:[]};
}
