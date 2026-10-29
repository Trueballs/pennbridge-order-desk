"""Version-agnostic CSV proof via odoo shell. The caller prepends `CSV_B64 = '<base64 of the desk CSV>'`.
Test (dry run, rolled back) -> Import -> re-import, then reads the quotation back. Works on Odoo 17/18/19 (line unit field detected)."""
import base64, csv, io, json
import odoo.release as release
data = base64.b64decode(CSV_B64)
rows = list(csv.reader(io.StringIO(data.decode())))
fields = rows[0]
UOM = 'product_uom_id' if 'product_uom_id' in env['sale.order.line']._fields else 'product_uom'
assert ('order_line/%s/id' % UOM) in fields, ('CSV header does not match this server', UOM, fields)
options = {'has_headers': True, 'encoding': 'utf-8', 'separator': ',', 'quoting': '"', 'date_format': '%Y-%m-%d', 'datetime_format': '%Y-%m-%d %H:%M:%S', 'float_thousand_separator': ',', 'float_decimal_separator': '.', 'skip': 0}
def run(dry):
    imp = env['base_import.import'].create({'res_model': 'sale.order', 'file': data, 'file_name': 'desk-export.csv', 'file_type': 'text/csv'})
    result = imp.execute_import(fields, fields, options, dryrun=dry)
    assert result.get('ids') and not result.get('messages'), result
    return result
test = run(True)
assert not env.ref(rows[1][0], raise_if_not_found=False), 'dry run must roll back'
imported = run(False)
quote = env.ref(rows[1][0])
line_ids = quote.order_line.ids
repeat = run(False)
quote = env.ref(rows[1][0])
assert quote.order_line.ids == line_ids and len(line_ids) == len(rows) - 1, (quote.order_line.ids, line_ids)
assert env['sale.order'].search_count([('client_order_ref', '=', rows[1][3])]) == 1
assert quote.state == 'draft'
assert quote.partner_id == env.ref(rows[1][1]) and quote.partner_shipping_id == env.ref(rows[1][2])
assert quote.client_order_ref == rows[1][3] and quote.currency_id == env.ref(rows[1][4])
expected_total = 0.0
for row, line in zip(rows[1:], quote.order_line):
    assert line.id == env.ref(row[5]).id
    assert line.product_id == env.ref(row[6]) and line.product_uom_qty == float(row[8])
    assert line[UOM] == env.ref(row[9]), (row[9], line[UOM].name)
    assert line.price_unit == float(row[10]), (line.price_unit, row[10])
    expected_total += float(row[8]) * float(row[10])
assert abs(quote.amount_untaxed - expected_total) < 0.005 and abs(quote.amount_total - expected_total) < 0.005, (quote.amount_untaxed, expected_total)
print('PENNBRIDGE_VERSION_CSV=' + json.dumps({'version': release.version, 'uom_field': UOM, 'quotation': quote.name, 'id': quote.id, 'state': quote.state, 'customer': quote.partner_id.name, 'shipping': quote.partner_shipping_id.street,
  'reference': quote.client_order_ref, 'currency': quote.currency_id.name, 'untaxed': quote.amount_untaxed, 'total': quote.amount_total, 'line_ids': line_ids, 'reimport_same_lines': True,
  'lines': [{'sku': l.product_id.default_code, 'qty': l.product_uom_qty, 'unit': l[UOM].name, 'price': l.price_unit} for l in quote.order_line], 'test_ids': test['ids'], 'import_ids': imported['ids'], 'repeat_ids': repeat['ids']}, default=str))
env.cr.commit()
