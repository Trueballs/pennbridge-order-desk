"""Run with Odoo shell: real base_import CSV Test/Import, synthetic records only."""
import csv
import io
import json
from pathlib import Path

def upsert(xmlid, model, values):
    record = env.ref(xmlid, raise_if_not_found=False)
    if record:
        record.write(values)
    else:
        record = env[model].create(values)
        module, name = xmlid.split('.', 1)
        env['ir.model.data'].create({'module': module, 'name': name, 'model': model, 'res_id': record.id, 'noupdate': True})
    return record

company = env.company
company.write({'name': 'Pennbridge Industrial Supplies (Synthetic)', 'currency_id': env.ref('base.GBP').id})
admin = env.ref('base.user_admin')
admin.write({'login': 'pennbridge-admin', 'password': 'pennbridge-local-admin-only'})
customer = upsert('pennbridge.customer_proof', 'res.partner', {'name': 'Northbank Engineering (Synthetic)', 'is_company': True, 'customer_rank': 1, 'ref': 'PB-TEST-001'})
unit = env.ref('uom.product_uom_unit')
products = []
for suffix, code, name, price in [('bolt', 'PB-BOLT-M8', 'M8 bolt synthetic unit', 1.25), ('bearing', 'PB-BEAR-6204', '6204 bearing synthetic unit', 8.50)]:
    products.append(upsert('pennbridge.product_' + suffix, 'product.product', {'name': name, 'default_code': code, 'list_price': price, 'uom_id': unit.id, 'sale_ok': True, 'type': 'consu', 'taxes_id': [(6, 0, [])]}))
env.cr.commit()
fields = ['id', 'partner_id/id', 'client_order_ref', 'currency_id/id', 'order_line/id', 'order_line/product_id/id', 'order_line/name', 'order_line/product_uom_qty', 'order_line/product_uom_id/id', 'order_line/price_unit']
rows = [
 ['pennbridge.quote_proof', 'pennbridge.customer_proof', 'PO-PROOF-001', 'base.GBP', 'pennbridge.quote_proof_line_1', 'pennbridge.product_bolt', 'M8 bolt synthetic unit', '10', 'uom.product_uom_unit', '1.25'],
 ['', '', '', '', 'pennbridge.quote_proof_line_2', 'pennbridge.product_bearing', '6204 bearing synthetic unit', '2', 'uom.product_uom_unit', '8.50'],
]

def csv_bytes(data):
    output = io.StringIO(newline='')
    writer = csv.writer(output)
    writer.writerow(fields)
    writer.writerows(data)
    return output.getvalue().encode()

def run(data, dryrun=False):
    importer = env['base_import.import'].create({'res_model': 'sale.order', 'file': csv_bytes(data), 'file_name': 'quotation-proof.csv', 'file_type': 'text/csv'})
    return importer.execute_import(fields, fields, {'has_headers': True, 'encoding': 'utf-8', 'separator': ',', 'quoting': '"', 'date_format': '%Y-%m-%d', 'datetime_format': '%Y-%m-%d %H:%M:%S', 'float_thousand_separator': ',', 'float_decimal_separator': '.', 'skip': 0}, dryrun=dryrun)

def assert_success(result):
    assert not [m for m in result.get('messages', []) if m.get('type') == 'error'], result
    assert result.get('ids'), result

test = run(rows, True)
assert_success(test)
first = run(rows)
assert_success(first)
quote = env.ref('pennbridge.quote_proof')
assert quote.partner_id == customer and quote.currency_id == env.ref('base.GBP')
assert quote.client_order_ref == 'PO-PROOF-001' and quote.state == 'draft'
assert len(quote.order_line) == 2
line_ids = quote.order_line.ids
assert [(l.product_id.id, l.product_uom_qty, l.product_uom_id.id, l.price_unit) for l in quote.order_line] == [(products[0].id, 10.0, unit.id, 1.25), (products[1].id, 2.0, unit.id, 8.5)]
repeat = run(rows)
assert_success(repeat)
assert quote.order_line.ids == line_ids and len(quote.order_line) == 2
assert env['ir.model.data'].search_count([('module', '=', 'pennbridge'), ('name', '=', 'quote_proof')]) == 1
invalid_rows = [row[:] for row in rows]
invalid_rows[0][0] = 'pennbridge.quote_invalid'
invalid_rows[0][4] = 'pennbridge.quote_invalid_line_1'
invalid_rows[1][4] = 'pennbridge.quote_invalid_line_2'
invalid_rows[0][5] = 'pennbridge.product_does_not_exist'
invalid = run(invalid_rows)
assert any(m.get('type') == 'error' for m in invalid.get('messages', [])), invalid
assert not env.ref('pennbridge.quote_invalid', raise_if_not_found=False)
assert quote.state == 'draft' and quote.order_line.ids == line_ids
export = quote.export_data(fields)['datas']
print('PENNBRIDGE_PROOF=' + json.dumps({'version': __import__('odoo.release', fromlist=['version']).version, 'fields': fields, 'test': test, 'import': first, 'repeat': repeat, 'invalid': invalid, 'quote': {'id': quote.id, 'name': quote.name, 'state': quote.state, 'customer': quote.partner_id.name, 'currency': quote.currency_id.name, 'po': quote.client_order_ref, 'line_ids': line_ids, 'lines': [{'product': l.product_id.default_code, 'quantity': l.product_uom_qty, 'unit': l.product_uom_id.name, 'price': l.price_unit} for l in quote.order_line]}, 'export_template': export}, default=str))
env.cr.commit()
