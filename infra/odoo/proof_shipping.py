"""Second real import proof: shared catalogue product plus explicit delivery address."""
import csv, io, json
fields = ['id','partner_id/id','partner_shipping_id/id','client_order_ref','currency_id/id','order_line/id','order_line/product_id/id','order_line/name','order_line/product_uom_qty','order_line/product_uom_id/id','order_line/price_unit']
rows = [['pennbridge.quote_shipping_proof','pennbridge.partner_C001','pennbridge.address_C001_NORTH','PO-SHIPPING-PROOF','base.GBP','pennbridge.quote_shipping_line_1','pennbridge.product_FB-0830-A2-100','M8 x 30 mm A2 stainless hex bolt, pack 100','2','pennbridge.uom_pack','10.00'],['','','','','','pennbridge.quote_shipping_line_2','pennbridge.product_BR-6204-2RS','6204 bearing synthetic catalogue','3','uom.product_uom_unit','7.50']]
output = io.StringIO(newline='');w=csv.writer(output);w.writerow(fields);w.writerows(rows)
def run(dry=False):
 imp=env['base_import.import'].create({'res_model':'sale.order','file':output.getvalue().encode(),'file_name':'shipping-proof.csv','file_type':'text/csv'})
 result=imp.execute_import(fields,fields,{'has_headers':True,'encoding':'utf-8','separator':',','quoting':'"','float_thousand_separator':',','float_decimal_separator':'.','skip':0},dryrun=dry)
 assert result.get('ids') and not result['messages'],result
 return result
result_test=run(True); result_import=run();q=env.ref('pennbridge.quote_shipping_proof'); line_ids=q.order_line.ids
result_repeat=run()
assert q.state=='draft' and q.partner_id==env.ref('pennbridge.partner_C001')
assert q.partner_shipping_id==env.ref('pennbridge.address_C001_NORTH')
assert q.partner_shipping_id.street=='Unit 8, North Test Works, Reading, TEST RG2'
assert q.order_line.ids==line_ids and len(line_ids)==2
assert q.order_line[0].product_id==env.ref('pennbridge.product_FB-0830-A2-100')
assert q.order_line[0].product_uom_id==env.ref('pennbridge.uom_pack') and q.order_line[0].product_uom_qty==2 and q.order_line[0].price_unit==10
print('PENNBRIDGE_SHIPPING='+json.dumps({'mapping_version':'odoo19-quotation-v2','fields':fields,'test':result_test,'import':result_import,'repeat':result_repeat,'quote':{'id':q.id,'name':q.name,'state':q.state,'partner_external_id':'pennbridge.partner_C001','shipping_external_id':'pennbridge.address_C001_NORTH','shipping_street':q.partner_shipping_id.street,'line_ids':line_ids,'first_line':{'product_external_id':'pennbridge.product_FB-0830-A2-100','sku':q.order_line[0].product_id.default_code,'quantity':q.order_line[0].product_uom_qty,'unit':q.order_line[0].product_uom_id.name,'price':q.order_line[0].price_unit}},'export_template':q.export_data(fields)['datas']}))
env.cr.commit()
