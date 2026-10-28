"""Create synthetic machine-generated PDF order fixtures; requires project .venv reportlab."""
from pathlib import Path
from email.message import EmailMessage
from email.policy import SMTP
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
import json, hashlib

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'fixtures'/'pdf'
OUT.mkdir(parents=True,exist_ok=True)
reference=json.loads((ROOT/'fixtures/context.json').read_text())
lookup={p['sku']:p for p in reference['products']}
styles=getSampleStyleSheet()
styles.add(ParagraphStyle(name='SmallNote',fontSize=8,leading=11,textColor=colors.HexColor('#64748b')))
styles['Title'].fontName='Helvetica-Bold';styles['Title'].fontSize=23;styles['Title'].textColor=colors.HexColor('#102d38')
cases=[]
for n in range(1,21):
    case=f'PDF-{n:03}';layout=(n-1)%4
    specs=[('FB-0830-A2-100',2,'pack','10.00'),('BR-6204-2RS',6,'each','6.00'),('TAPE-PTFE-12',4,'roll','1.50')]
    if n%5==0:specs=[('BR-6204-2RS',i%5+1,'each','6.00') for i in range(60)]
    if n in (7,11):specs=[('FB-0835-A2-100',2,'pack','13.00'),('OR-20X3-FKM',10,'each','1.10')]
    shipping='NORTH' if n==13 else 'MAIN'
    story=[Paragraph(['ALDERWICK ENGINEERING','ALDERWICK | PROCUREMENT','PURCHASE ORDER','Alderwick Engineering Ltd'][layout],styles['Title']),Spacer(1,16),
           Paragraph(f'Purchase order {case}',styles['Heading2']),
           Paragraph('Supplier: Pennbridge Industrial Supplies',styles['Normal']),
           Paragraph(f'Delivery address: {shipping}',styles['Normal']),
           Paragraph('Issued: 2 November 2026 | Currency: GBP | Prices exclude VAT',styles['Normal']),Spacer(1,18)]
    rows=[['Product code','Quantity','Unit','Unit price GBP']]
    for sku,q,u,price in specs:rows.append([sku,str(q),u,price])
    table=Table(rows,colWidths=[235,65,65,120],repeatRows=1,hAlign='LEFT')
    table.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),colors.HexColor(['#173a49','#0c766f','#334155','#224a33'][layout])),
        ('TEXTCOLOR',(0,0),(-1,0),colors.white),('FONTNAME',(0,0),(-1,0),'Helvetica-Bold'),('FONTSIZE',(0,0),(-1,-1),9),
        ('TOPPADDING',(0,0),(-1,-1),9),('BOTTOMPADDING',(0,0),(-1,-1),9),('LINEBELOW',(0,0),(-1,0),.5,colors.HexColor('#173a49')),
        ('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.HexColor('#f2f6f6'),colors.white]),('ALIGN',(1,1),(1,-1),'RIGHT'),('ALIGN',(3,1),(3,-1),'RIGHT')]))
    story += [table,Spacer(1,18),Paragraph('Please acknowledge receipt. Do not substitute products without our written agreement.',styles['Normal']),Spacer(1,16),Paragraph('SYNTHETIC TEST DOCUMENT - fictional company and order. Not for purchasing or payment.',styles['SmallNote'])]
    path=OUT/f'{case}.pdf'
    def footer(canvas,doc):
        canvas.setFont('Helvetica',8);canvas.setFillColor(colors.HexColor('#64748b'))
        canvas.drawString(42,27,f'{case} | Synthetic portfolio fixture');canvas.drawRightString(A4[0]-42,27,f'Page {doc.page}')
    SimpleDocTemplate(str(path),pagesize=A4,leftMargin=42,rightMargin=42,topMargin=36,bottomMargin=42,title=f'Synthetic purchase order {case}',author='Pennbridge test harness',invariant=1).build(story,onFirstPage=footer,onLaterPages=footer)
    msg=EmailMessage(policy=SMTP);msg['From']='mia@alderwick.example';msg['To']='orders@pennbridge.example';msg['Subject']=f'Purchase order {case}';msg['Message-ID']=f'<{case.lower()}@synthetic.pennbridge.example>';msg['Date']='Mon, 02 Nov 2026 09:00:00 +0000';msg['X-Pennbridge-Synthetic']='true'
    msg.set_content(f'Hi team,\nPlease process purchase order {case} attached. Deliver to {shipping}.\nThanks, Mia\nSynthetic demonstration only.')
    blob=path.read_bytes();msg.add_attachment(blob,maintype='application',subtype='pdf',filename=path.name);msg.set_boundary('pennbridge-'+case)
    (OUT/f'{case}.eml').write_bytes(msg.as_bytes())
    cases.append({'id':case,'synthetic':True,'layout':layout+1,'customer_id':'C001','shipping_address':shipping,'pdf':str(path.relative_to(ROOT)),'email':f'fixtures/pdf/{case}.eml','sha256':hashlib.sha256(blob).hexdigest(),'expected_lines':[{'sku':s,'quantity':str(q),'unit':u,'quoted_unit_price_gbp':p}for s,q,u,p in specs]})
(OUT/'cases.json').write_text(json.dumps(cases,indent=2)+'\n')
print(f'Created {len(cases)} synthetic PDF orders and MIME attachments, four layouts, four multipage orders.')
