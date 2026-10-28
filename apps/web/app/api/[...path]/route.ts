import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleParser } from 'mailparser';
import * as services from '@pennbridge/server';
import { LoginRequestSchema, IntakeRequestSchema, EditOrderRequestSchema, ApproveRequestSchema, ExportRequestSchema, CancelRequestSchema, VerifyExportRequestSchema } from '@pennbridge/contracts';
import { ZodError } from 'zod';

export const runtime='nodejs';
export const dynamic='force-dynamic';
let ready:Promise<void>|undefined;
function initialise(){return ready??=(services.initialiseDatabase().catch(e=>{ready=undefined;throw e;}));}
const json=(data:unknown,status=200)=>NextResponse.json(data,{status,headers:{'Cache-Control':'no-store'}});
async function handle(req:NextRequest,ctx:{params:Promise<{path:string[]}>}){
  try{
    await initialise();
    const parts=(await ctx.params).path;const route=parts.join('/');const method=req.method;
    if(method!=='GET'){
      const origin=req.headers.get('origin');const host=req.headers.get('x-forwarded-host')||req.headers.get('host');
      if(origin&&new URL(origin).host!==host)return json({error:{code:'FORBIDDEN',message:'Request origin does not match this local app.'}},403);
      if(!req.headers.get('content-type')?.includes('application/json'))return json({error:{code:'VALIDATION_FAILED',message:'Use application/json.'}},415);
      if(Number(req.headers.get('content-length')||0)>15_000_000)return json({error:{code:'FILE_TOO_LARGE',message:'Request exceeds 15 MB.'}},413);
    }
    if(route==='health')return json({ok:true,mode:process.env.LIVE_AI_ENABLED==='true'?'live':'mock'});
    if(route==='auth/login'&&method==='POST'){
      const b=LoginRequestSchema.parse(await req.json());const {session,token}=await services.login(b.email,b.password);
      const res=json(session);res.cookies.set('pennbridge_session',token,{httpOnly:true,sameSite:'strict',secure:process.env.SESSION_COOKIE_SECURE==='true',path:'/',maxAge:8*3600});return res;
    }
    const token=req.cookies.get('pennbridge_session')?.value||'';
    const bearer=req.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
    const user=(route==='intake'&&method==='POST'&&bearer?services.ingestionSession(bearer):null)||await services.session(token);
    if(route==='session'&&method==='GET')return user?json(user):json({error:{code:'FORBIDDEN',message:'Not signed in.'}},401);
    if(!user)return json({error:{code:'FORBIDDEN',message:'Sign in to the local order desk.'}},401);
    if(route==='auth/logout'&&method==='POST'){await services.logout(token);const res=json({ok:true});res.cookies.delete('pennbridge_session');return res;}
    if(route==='stats'&&method==='GET')return json(await services.stats(user));
    if(route==='customers'&&method==='GET')return json(await services.listCustomers(user));
    if(route==='catalogue'&&method==='GET')return json({products:await services.listCatalogue(user,{q:req.nextUrl.searchParams.get('q')||undefined,customerId:req.nextUrl.searchParams.get('customerId')||undefined})});
    if(route==='jobs'&&method==='GET')return json({jobs:await services.listJobs(user)});
    if(parts[0]==='jobs'&&parts[2]==='retry'&&method==='POST')return json(await services.retryJob(user,parts[1]));
    if(route==='orders'&&method==='GET')return json(await services.listOrders(user,Object.fromEntries(req.nextUrl.searchParams)));
    if(route==='intake'&&method==='POST')return json(await services.intake(user,IntakeRequestSchema.parse(await req.json())),202);
    if(route==='demo'&&method==='POST'){
      const body=await req.json();const sample=typeof body.sample==='string'&&/^PB-\d{3}$/.test(body.sample)?body.sample:null;
      const filename=sample?`${sample}.eml`:'PDF-001.eml';
      const content=await readFile(path.join(process.env.PROJECT_ROOT||process.cwd(),'fixtures',sample?'emails':'pdf',filename));
      // Capture and retrieve the demo through the private mail catcher. Never relay externally.
      const mailbox=process.env.MAILPIT_URL;
      if(!mailbox)throw new Error('Local Mailpit is not configured.');
      const mail=await simpleParser(content);
      const sent=await fetch(`${mailbox}/api/v1/send`,{method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(10000),body:JSON.stringify({From:{Email:'demo@pennbridge.example',Name:'Synthetic Pennbridge demo'},To:[{Email:'orders@pennbridge.example'}],Subject:mail.subject,Text:mail.text,HTML:mail.html||undefined,Headers:mail.messageId?{'Message-ID':mail.messageId}:undefined,Attachments:mail.attachments.map(a=>({Filename:a.filename||'attachment',ContentType:a.contentType,Content:a.content.toString('base64')}))})});
      if(!sent.ok)throw new Error('Local mail capture failed.');
      const captured=await sent.json() as {ID:string};
      const received=await fetch(`${mailbox}/api/v1/message/${encodeURIComponent(captured.ID)}/raw`,{signal:AbortSignal.timeout(10000)});
      if(!received.ok)throw new Error('Local mail retrieval failed.');
      const receivedContent=Buffer.from(await received.arrayBuffer());
      return json(await services.intake(user,{filename,mediaType:'message/rfc822',contentBase64:receivedContent.toString('base64'),channel:'upload',trustedCustomerId:body.customerId||'C001'}),202);
    }
    if(parts[0]==='documents'&&method==='GET'){
      const {document,content}=await services.getDocument(user,parts[1]);
      const type=document.mediaType==='application/pdf'?'application/pdf':'text/plain; charset=utf-8';
      return new NextResponse(new Uint8Array(content||Buffer.from(document.text||'')),{headers:{'Content-Type':type,'Content-Disposition':`${type==='application/pdf'?'inline':'attachment'}; filename="${document.filename.replace(/[^a-zA-Z0-9._-]/g,'_')}"`,'Content-Security-Policy':"sandbox; default-src 'none'",'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'}});
    }
    if(parts[0]==='orders'&&parts[1]){
      const id=parts[1];
      if(parts.length===2&&method==='GET')return json(await services.getOrder(user,id));
      if(parts.length===2&&method==='PATCH')return json(await services.editOrder(user,id,EditOrderRequestSchema.parse(await req.json())));
      if(parts[2]==='approve'&&method==='POST')return json(await services.approveOrder(user,id,ApproveRequestSchema.parse(await req.json())));
      if(parts[2]==='export'&&method==='POST')return json(await services.exportOrder(user,id,ExportRequestSchema.parse(await req.json())));
      if(parts[2]==='cancel'&&method==='POST')return json(await services.cancelOrder(user,id,CancelRequestSchema.parse(await req.json())));
      if(parts[2]==='exports'&&parts[4]==='verify'&&method==='POST')return json(await services.verifyExport(user,id,parts[3],VerifyExportRequestSchema.parse(await req.json())));
      if(parts[2]==='exports'&&parts[4]==='download'&&method==='GET'){
        const data=await services.downloadExport(user,id,parts[3]);return new NextResponse(new Uint8Array(data.content),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${data.filename}"`,'Cache-Control':'no-store'}});
      }
    }
    return json({error:{code:'NOT_FOUND',message:'Endpoint not found.'}},404);
  }catch(e){
    if(e instanceof ZodError)return json({error:{code:'VALIDATION_FAILED',message:'Check the submitted fields.',issues:e.issues.map(i=>({path:i.path.join('.'),message:i.message}))}},400);
    const err=e as Error&{code?:string;status?:number};
    console.error(JSON.stringify({event:'api.error',code:err.code||'INTERNAL',message:err.message}));
    return json({error:{code:err.code||'VALIDATION_FAILED',message:err.status&&err.status<500?err.message:'The request could not be completed. Check the local service logs.'}},err.status||500);
  }
}
export const GET=handle;export const POST=handle;export const PATCH=handle;
