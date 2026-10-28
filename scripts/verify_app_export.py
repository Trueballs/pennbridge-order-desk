"""Build an Odoo shell proof from an existing synthetic app CSV; no network calls."""
import base64,pathlib,sys
p=pathlib.Path(sys.argv[1]);payload=base64.b64encode(p.read_bytes()).decode()
print("import base64,csv,io,json")
print("data=base64.b64decode("+repr(payload)+")")
print('''rows=list(csv.reader(io.StringIO(data.decode())))
fields=rows[0]
def run(dry):
    imp=env['base_import.import'].create({'res_model':'sale.order','file':data,'file_name':'app-export.csv','file_type':'text/csv'})
    result=imp.execute_import(fields,fields,{'has_headers':True,'encoding':'utf-8','separator':',','quoting':'"','float_thousand_separator':',','float_decimal_separator':'.','skip':0},dryrun=dry)
    assert result.get('ids') and not result['messages'],result
    return result
preview=run(True); imported=run(False)
quote=env.ref(rows[1][0]);ids=quote.order_line.ids
repeated=run(False)
assert quote.order_line.ids==ids
assert quote.state=='draft'
assert quote.partner_id==env.ref(rows[1][1])
assert quote.partner_shipping_id==env.ref(rows[1][2])
assert quote.client_order_ref==rows[1][3]
assert quote.currency_id==env.ref(rows[1][4])
expected=[row for row in rows[1:] if row]
assert len(quote.order_line)==len(expected)
for row in expected:
    line=env.ref(row[5])
    assert line.order_id==quote
    assert line.product_id==env.ref(row[6])
    assert line.product_uom_qty==float(row[8])
    assert line.product_uom_id==env.ref(row[9])
    assert line.price_unit==float(row[10])
print('PENNBRIDGE_APP_EXPORT='+json.dumps({'quotation':quote.name,'id':quote.id,'state':quote.state,'customer':quote.partner_id.name,'shipping':quote.partner_shipping_id.street,'reference':quote.client_order_ref,'currency':quote.currency_id.name,'untaxed_total':quote.amount_untaxed,'line_ids':ids,'lines':[{'sku':line.product_id.default_code,'quantity':line.product_uom_qty,'unit':line.product_uom_id.name,'unit_price':line.price_unit} for line in quote.order_line],'dryrun':preview,'import':imported,'reimport':repeated}))
env.cr.commit()
''')
