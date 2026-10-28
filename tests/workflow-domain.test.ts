import { afterEach,describe,expect,it } from "vitest";
import { ReasonCodeSchema,type ExtractedOrder,type Product } from "../packages/contracts";
import { authVerdict,classifyFailure,dedupeReasons,isFreemailDomain,londonDate,publicError,reason,senderParts,validate,type ValidationContext } from "../packages/domain";
import { publicError as serverPublicError,renderOdooCsv,setOdooUnitMapping } from "../packages/server";
import { createProvider,extractionMode,ManualEntryProvider,MockProvider } from "../packages/ai";

const codes=ReasonCodeSchema.options;
const product:Product={id:"P",sku:"EXACT-100",externalId:"pennbridge.product_EXACT",manufacturerReference:null,description:"M8 x 30 mm A2 stainless hex bolt pack 100",category:"fasteners",family:"hex_bolt",attributes:{},active:true,sellingUnit:"pack",unitsPerPack:"100",physicalUnit:"each",allowsFractionalQuantity:false,listPrice:"12.00",currency:"GBP",catalogueVersion:"v1"};
const line=(over:Partial<ExtractedOrder["lines"][0]>={})=>({id:"L1",position:1,rawText:"2 packs EXACT-100",sku:"EXACT-100",manufacturerReference:null,customerAlias:null,description:"bolt",quantity:"2",unit:"pack" as const,originalUnit:"packs",quotedUnitPrice:null,attributes:{},evidenceIds:[],...over});
const extracted=(over:Partial<ExtractedOrder>={}):ExtractedOrder=>({schemaVersion:1,intent:"new_order",poNumber:"PO1",relatedPoNumber:null,revision:null,requestedDeliveryDate:null,requestedAddress:"MAIN",currency:"GBP",quotedTotal:null,evidence:[],reasons:[],lines:[line()],...over});
const customer={id:"C",externalId:"partner",name:"Customer",onHold:false,approvedSenders:[],catalogueVersion:"v1"};
const context=(over:Partial<ValidationContext>={}):ValidationContext=>({customer,addresses:[{id:"A",customerId:"C",externalId:"addr",label:"MAIN",formatted:"Synthetic address",approved:true}],catalogueVersion:"v1",at:"2026-10-28T12:00:00Z",
  repository:{exactSku:async()=>[product],manufacturer:async()=>[],aliases:async()=>[],search:async()=>[],prices:async()=>[],stock:async()=>null},...over});

describe("order-only flags and duplicate reasons",()=>{
  it("reports a provider QUOTE_REQUEST once",async()=>{
    const input=extracted({intent:"quote_request",reasons:[reason("QUOTE_REQUEST","quote")]});
    const result=await validate(input,context());
    expect(result.reasons.filter(r=>r.code==="QUOTE_REQUEST")).toHaveLength(1);
    expect(result.status).toBe("not_order");
  });
  it("does not give quote requests, enquiries or non-orders PO/address/line flags",async()=>{
    for(const intent of ["quote_request","enquiry","non_order"] as const){
      const result=await validate(extracted({intent,poNumber:null,requestedAddress:null,lines:[]}),context({customer:null}));
      const got=result.reasons.map(r=>r.code);
      for(const code of ["MISSING_PO_REFERENCE","SHIPPING_ADDRESS_AMBIGUOUS","NEW_SHIPPING_ADDRESS","NO_ORDER_LINES"])expect(got).not.toContain(code);
      expect(got).toContain("UNVERIFIED_SENDER");
    }
  });
  it("still flags a real order without PO, address or lines, and a cancellation without a PO",async()=>{
    const order=(await validate(extracted({poNumber:null,requestedAddress:null,lines:[]}),context())).reasons.map(r=>r.code);
    expect(order).toEqual(expect.arrayContaining(["MISSING_PO_REFERENCE","SHIPPING_ADDRESS_AMBIGUOUS","NO_ORDER_LINES"]));
    const cancel=(await validate(extracted({intent:"cancellation",poNumber:null,lines:[]}),context())).reasons.map(r=>r.code);
    expect(cancel).toContain("MISSING_PO_REFERENCE");expect(cancel).not.toContain("SHIPPING_ADDRESS_AMBIGUOUS");expect(cancel).not.toContain("NO_ORDER_LINES");
  });
  it("dedupes by code and line",()=>{
    expect(dedupeReasons([reason("PRICE_MISMATCH","a","L1"),reason("PRICE_MISMATCH","b","L1"),reason("PRICE_MISMATCH","c","L2")])).toHaveLength(2);
  });
  it("names the suggested customer in UNVERIFIED_SENDER",async()=>{
    const result=await validate(extracted(),context({customer:null,suggestedCustomerName:"Alderwick"}));
    expect(result.reasons.find(r=>r.code==="UNVERIFIED_SENDER")?.message).toContain("Alderwick");
  });
});

describe("pricing date (Europe/London)",()=>{
  it("uses the London calendar day, not the UTC day",()=>{
    expect(londonDate("2026-10-24T23:30:00Z")).toBe("2026-10-25"); // BST, UTC+1
    expect(londonDate("2026-10-25T23:30:00Z")).toBe("2026-10-25"); // GMT after the clocks go back
    expect(londonDate("2026-01-10T23:30:00Z")).toBe("2026-01-10");
  });
  it("applies an agreement that starts on the London day of receipt",async()=>{
    const agreement={id:"a",customerId:"C",productId:"P",version:"v1",validFrom:"2026-10-25",validTo:null,minimumQuantity:"1",unitPrice:"9.00",currency:"GBP" as const};
    const repo={...context().repository,prices:async()=>[agreement]};
    const lateUtc=await validate(extracted(),context({at:"2026-10-24T23:30:00Z",repository:repo}));
    expect(lateUtc.lines[0].unitPrice).toBe("9.00");
    const pinned=await validate(extracted(),context({at:"2026-10-28T12:00:00Z",pricingDate:"2026-10-24",repository:repo}));
    expect(pinned.lines[0].unitPrice).toBe("12.00"); // not yet valid on the stored pricing date
  });
});

describe("retry classification and safe messages",()=>{
  const raw="Gemini HTTP 500: {\"key\":\"AIza-secret\"} at /app/packages/ai/index.ts";
  it("retries transient failures",()=>{
    for(const e of [Object.assign(new Error(raw),{code:"MODEL_UNAVAILABLE",status:503}),Object.assign(new Error(raw),{code:"MODEL_UNAVAILABLE",status:429}),Object.assign(new Error("x"),{name:"TimeoutError"}),Object.assign(new Error("x"),{code:"ECONNRESET"}),Object.assign(new Error("x"),{code:"MODEL_OUTPUT_INVALID"}),new Error("something odd")])
      expect(classifyFailure(e,codes).retryable).toBe(true);
    expect(classifyFailure(Object.assign(new Error("x"),{name:"TimeoutError"}),codes).code).toBe("MODEL_TIMEOUT");
  });
  it("does not retry permanent failures",()=>{
    for(const e of [Object.assign(new Error(raw),{code:"MODEL_UNAVAILABLE",status:401}),Object.assign(new Error("no key"),{code:"MODEL_UNAVAILABLE"}),Object.assign(new Error("big"),{code:"FILE_TOO_LARGE"}),Object.assign(new Error("x"),{code:"BUDGET_EXCEEDED"}),Object.assign(new Error("x"),{code:"UNSUPPORTED_FORMAT"})])
      expect(classifyFailure(e,codes).retryable).toBe(false);
  });
  it("never puts provider text, keys or paths in the user message",()=>{
    const m=classifyFailure(Object.assign(new Error(raw),{code:"MODEL_UNAVAILABLE",status:500}),codes).message;
    expect(m).not.toMatch(/AIza|Gemini|\/app\//);
    expect(classifyFailure(Object.assign(new Error("Maximum document size is 10 MB."),{code:"FILE_TOO_LARGE"}),codes).message).toContain("10 MB");
  });
  it("publicError hides SQL, stacks and driver codes",()=>{
    const sql=Object.assign(new Error('relation "users" does not exist at /app/x.ts'),{code:"42P01"});
    expect(publicError(sql,codes)).toEqual({status:500,code:"INTERNAL_ERROR",message:expect.not.stringMatching(/users|app/)});
    expect(serverPublicError(Object.assign(new Error("dup key value violates unique constraint orders_pkey"),{code:"23505"}))).toMatchObject({status:409,message:"That record already exists."});
    expect(publicError(new Error("boom: password=hunter2"),codes)).toMatchObject({status:500,message:expect.not.stringContaining("hunter2")});
    expect(publicError(Object.assign(new Error("Order not found"),{code:"NOT_FOUND",status:404}),codes)).toEqual({status:404,code:"NOT_FOUND",message:"Order not found"});
    expect(publicError(Object.assign(new Error("db password leaked"),{code:"NOT_FOUND",status:500}),codes).message).not.toContain("leaked");
    expect(publicError(new SyntaxError("Unexpected token"),codes).status).toBe(400);
  });
});

describe("sender parsing",()=>{
  it("extracts and lower-cases addresses",()=>{
    expect(senderParts('"Mia B" <Mia@Alderwick.Example>')).toEqual({email:"mia@alderwick.example",domain:"alderwick.example"});
    expect(senderParts("a@b.co")?.domain).toBe("b.co");
    for(const bad of [null,"","not-an-address","a@b","a b@c.com","<>"])expect(senderParts(bad)).toBeNull();
  });
  it("reads Authentication-Results verdicts",()=>{
    expect(authVerdict("mx.google.com; dkim=pass header.d=x; spf=pass; dmarc=pass")).toBe("pass");
    expect(authVerdict("mx; dkim=pass; spf=fail")).toBe("fail");
    expect(authVerdict("mx; dmarc=softfail")).toBe("fail");
    expect(authVerdict(undefined)).toBe("unknown");
    expect(authVerdict("mx; none")).toBe("unknown");
  });
  it("knows public mail domains",()=>{expect(isFreemailDomain("Gmail.com")).toBe(true);expect(isFreemailDomain("alderwick.example")).toBe(false);});
});

describe("Odoo CSV",()=>{
  const snapshot={externalId:"pennbridge.quote_O1",customerExternalId:"partner",shippingAddressExternalId:"addr",poNumber:"PO-1",
    lines:[{lineId:"L1",productExternalId:"p1",sku:"S",description:"bolt",quantity:"2",unit:"pack" as const,unitPrice:"12.00"}]};
  it("neutralises spreadsheet formulas in every text cell and keeps numbers numeric",()=>{
    setOdooUnitMapping({pack:"pennbridge.uom_pack"});
    for(const bad of ["=HYPERLINK(\"http://evil\")","+1+1","-2+3","@SUM(A1)","\t=1","\r=1"]){
      const csv=renderOdooCsv({...snapshot,poNumber:bad,lines:[{...snapshot.lines[0],description:bad}]});
      const row=csv.split("\n")[1];
      expect(row).not.toMatch(/(^|,)"[=+\-@\t\r]/);
      expect(row).toContain(`"'${bad.replaceAll('"','""')}"`);
    }
    const ok=renderOdooCsv(snapshot).split("\n")[1];
    expect(ok).toContain('"2","pennbridge.uom_pack","12.00"');
  });
  it("takes the currency from the data and rejects a malformed one",()=>{
    setOdooUnitMapping({pack:"pennbridge.uom_pack"});
    expect(renderOdooCsv({...snapshot,currency:"EUR"})).toContain('"base.EUR"');
    expect(renderOdooCsv(snapshot)).toContain('"base.GBP"');
    expect(()=>renderOdooCsv({...snapshot,currency:"=GBP"})).toThrow();
  });
});

describe("production extraction mode",()=>{
  const saved={...process.env};
  afterEach(()=>{process.env=Object.assign({},saved);});
  it("is manual unless live is configured or DEMO_MODE is set",async()=>{
    delete process.env.DEMO_MODE;process.env.LIVE_AI_ENABLED="false";
    expect(extractionMode()).toBe("manual");expect(createProvider()).toBeInstanceOf(ManualEntryProvider);
    process.env.DEMO_MODE="true";expect(extractionMode()).toBe("mock");expect(createProvider()).toBeInstanceOf(MockProvider);
    process.env.LIVE_AI_ENABLED="true";delete process.env.ANTHROPIC_API_KEY;delete process.env.AI_PROVIDER;
    expect(extractionMode()).toBe("mock"); // enabled but no key: not configured
    process.env.ANTHROPIC_API_KEY="k";expect(extractionMode()).toBe("live");
    delete process.env.DEMO_MODE;expect(extractionMode()).toBe("live");
  });
  it("manual provider returns no lines and a clear reason",async()=>{
    const result=await new ManualEntryProvider().extract({text:"2 x bolts",documents:[],evidence:[]});
    expect(result.extracted.lines).toHaveLength(0);
    expect(result.extracted.reasons[0]).toMatchObject({code:"MODEL_UNAVAILABLE"});
    expect(result.extracted.reasons[0].message).toMatch(/manually/);
  });
});
