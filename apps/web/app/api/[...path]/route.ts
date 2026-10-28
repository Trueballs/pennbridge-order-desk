import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleParser } from 'mailparser';
import * as services from '@pennbridge/server';
import { LoginRequestSchema, IntakeRequestSchema, EditOrderRequestSchema, ApproveRequestSchema, ExportRequestSchema, CancelRequestSchema, VerifyExportRequestSchema, VoidExportRequestSchema, AddLineRequestSchema, RemoveLineRequestSchema, ReprocessRequestSchema, AssignCustomerRequestSchema, SenderMappingInputSchema } from '@pennbridge/contracts';
import { ZodError } from 'zod';
// W3: accounts + CSV import
import * as admin from '@pennbridge/server/admin';
import * as dataImport from '@pennbridge/server/import';
const clientIp=(req:NextRequest)=>{const f=req.headers.get('x-forwarded-for');return ((f?f.split(',').pop()!.trim():req.headers.get('x-real-ip'))||'unknown').slice(0,64);};
import { cookieSecure, isDemo, readiness } from '@pennbridge/db';

export const runtime='nodejs';
export const dynamic='force-dynamic';
let ready:Promise<void>|undefined;
function initialise(){return ready??=(services.initialiseDatabase().catch(e=>{ready=undefined;throw e;}));}
const json=(data:unknown,status=200)=>NextResponse.json(data,{status,headers:{'Cache-Control':'no-store'}});
async function handle(req:NextRequest,ctx:{params:Promise<{path:string[]}>}){
  try{
    const parts=(await ctx.params).path;const route=parts.join('/');const method=req.method;
    // Liveness (no database) and readiness (database, queue, worker, mailbox) answer before initialisation and sign-in.
    if(route==='health'&&method==='GET')return json({ok:true,mode:process.env.LIVE_AI_ENABLED==='true'?'live':'mock'});
    if(route==='ready'&&method==='GET'){
      const r=await readiness();const viewer=r.status==='down'?null:await services.session(req.cookies.get('pennbridge_session')?.value||'');
      return json(viewer?r:{status:r.status,problems:r.problems},r.status==='down'?503:200);
    }
    await initialise();
    if(method!=='GET'){
      const origin=req.headers.get('origin');const host=req.headers.get('x-forwarded-host')||req.headers.get('host');
      if(origin&&new URL(origin).host!==host)return json({error:{code:'FORBIDDEN',message:'Request origin does not match this local app.'}},403);
      if(!req.headers.get('content-type')?.includes('application/json'))return json({error:{code:'VALIDATION_FAILED',message:'Use application/json.'}},415);
      if(Number(req.headers.get('content-length')||0)>15_000_000)return json({error:{code:'FILE_TOO_LARGE',message:'Request exceeds 15 MB.'}},413);
    }
    if(route==='auth/login'&&method==='POST'){
      const b=LoginRequestSchema.parse(await req.json());const {session,token}=await services.login(b.email,b.password,{ip:clientIp(req)});
      const res=json(session);res.cookies.set('pennbridge_session',token,{httpOnly:true,sameSite:'strict',secure:cookieSecure(),path:'/',maxAge:8*3600});return res;
    }
    const token=req.cookies.get('pennbridge_session')?.value||'';
    const bearer=req.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
    const user=(route==='intake'&&method==='POST'&&bearer?services.ingestionSession(bearer):null)||await services.session(token);
    if(route==='session'&&method==='GET')return user?json(user):json({error:{code:'FORBIDDEN',message:'Not signed in.'}},401);
    if(!user)return json({error:{code:'FORBIDDEN',message:'Sign in to the local order desk.'}},401);
    if(route==='auth/logout'&&method==='POST'){await services.logout(token);const res=json({ok:true});res.cookies.delete('pennbridge_session');return res;}
    // W3: account + import routes (admin-only except /auth/password). Request/response types: packages/server/admin.ts and import.ts; CSV columns: docs/import-templates/README.md.
    if(route==='auth/password'&&method==='POST'){const b=admin.ChangePasswordRequestSchema.parse(await req.json());return json(await admin.changeOwnPassword(user,b.currentPassword,b.newPassword,token));}
    if(parts[0]==='admin'){
      if(route==='admin/users'&&method==='GET')return json({users:await admin.listUsers(user)});
      if(route==='admin/users'&&method==='POST')return json(await admin.createUser(user,admin.CreateUserRequestSchema.parse(await req.json())),201);
      if(parts[1]==='users'&&parts[2]){
        if(parts.length===3&&method==='GET')return json(await admin.getUser(user,parts[2]));
        if(parts.length===3&&method==='PATCH')return json(await admin.updateUser(user,parts[2],admin.UpdateUserRequestSchema.parse(await req.json())));
        if(parts[3]==='password'&&method==='POST')return json(await admin.setUserPassword(user,parts[2],admin.SetPasswordRequestSchema.parse(await req.json()).password));
        if(parts[3]==='revoke-sessions'&&method==='POST')return json(await admin.revokeSessionsFor(user,parts[2]));
      }
      if(parts[1]==='import'){
        if(parts[2]==='preview'&&method==='POST')return json(await dataImport.previewImport(user,dataImport.ImportRequestSchema.parse(await req.json())));
        if(parts[2]==='apply'&&method==='POST'){const result=await dataImport.applyImport(user,dataImport.ImportRequestSchema.parse(await req.json()));return json(result,result.applied?200:422);}
        if(parts[2]==='batches'&&method==='GET'){admin.requireAdmin(user);return json({batches:await dataImport.listImportBatches(user)});}
        if(parts[2]==='templates'&&method==='GET'){
          admin.requireAdmin(user);const kind=dataImport.ImportRequestSchema.shape.kind.safeParse(parts[3]);
          if(!parts[3])return json({kinds:dataImport.IMPORT_KINDS.map(k=>({kind:k,...dataImport.IMPORT_TEMPLATES[k]}))});
          if(!kind.success)return json({error:{code:'NOT_FOUND',message:'Unknown import kind.'}},404);
          return new NextResponse(dataImport.templateCsv(kind.data),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${kind.data}-template.csv"`,'Cache-Control':'no-store'}});
        }
      }
    }
    if(route==='stats'&&method==='GET')return json(await services.stats(user));
    if(route==='customers'&&method==='GET')return json(await services.listCustomers(user));
    if(route==='catalogue'&&method==='GET')return json({products:await services.listCatalogue(user,{q:req.nextUrl.searchParams.get('q')||undefined,customerId:req.nextUrl.searchParams.get('customerId')||undefined})});
    // W2: sender -> customer mappings (admin writes, reviewers read)
    if(route==='sender-mappings'&&method==='GET')return json({mappings:await services.listSenderMappings(user)});
    if(route==='sender-mappings'&&method==='POST')return json(await services.upsertSenderMapping(user,SenderMappingInputSchema.parse(await req.json())));
    if(parts[0]==='sender-mappings'&&parts.length===2&&method==='DELETE')return json(await services.deleteSenderMapping(user,parts[1]));
    if(route==='jobs'&&method==='GET')return json({jobs:await services.listJobs(user)});
    if(parts[0]==='jobs'&&parts[2]==='retry'&&method==='POST')return json(await services.retryJob(user,parts[1]));
    if(route==='orders'&&method==='GET')return json(await services.listOrders(user,Object.fromEntries(req.nextUrl.searchParams)));
    if(route==='intake'&&method==='POST')return json(await services.intake(user,IntakeRequestSchema.parse(await req.json())),202);
    if(route==='demo'&&!isDemo())return json({error:{code:'NOT_FOUND',message:'Endpoint not found.'}},404);
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
      // W2: manual path
      if(parts[2]==='customer'&&method==='POST')return json(await services.assignCustomer(user,id,AssignCustomerRequestSchema.parse(await req.json())));
      if(parts[2]==='reprocess'&&method==='POST')return json(await services.reprocessOrder(user,id,ReprocessRequestSchema.parse(await req.json())));
      if(parts[2]==='lines'&&parts.length===3&&method==='POST')return json(await services.addLine(user,id,AddLineRequestSchema.parse(await req.json())));
      if(parts[2]==='lines'&&parts[4]==='remove'&&method==='POST')return json(await services.removeLine(user,id,parts[3],RemoveLineRequestSchema.parse(await req.json())));
      if(parts[2]==='exports'&&parts[4]==='void'&&method==='POST')return json(await services.voidExport(user,id,parts[3],VoidExportRequestSchema.parse(await req.json())));
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
    const safe=services.publicError(e);// W2: only authored 4xx messages reach the client; SQL/provider/stack text stays in the log
    console.error(JSON.stringify({event:'api.error',code:safe.code,status:safe.status,message:String(err?.message??'').slice(0,300)}));
    return json({error:{code:safe.code,message:safe.message}},safe.status);
  }
}
export const GET=handle;export const POST=handle;export const PATCH=handle;export const DELETE=handle;
