"""Read back a quotation created by the direct push (caller prepends `ORIGIN = 'pennbridge:quote_...'`). Version-agnostic."""
import json
import odoo.release as release
UOM = 'product_uom_id' if 'product_uom_id' in env['sale.order.line']._fields else 'product_uom'
orders = env['sale.order'].search([('origin', '=', ORIGIN)])
assert len(orders) == 1, ('expected exactly one quotation with this origin', orders.ids)
q = orders
xml = env['ir.model.data'].search([('model', '=', 'sale.order'), ('res_id', '=', q.id), ('module', '=', 'pennbridge')])
print('PENNBRIDGE_VERSION_PUSH=' + json.dumps({'version': release.version, 'quotation': q.name, 'id': q.id, 'state': q.state, 'customer': q.partner_id.name, 'shipping': q.partner_shipping_id.street, 'reference': q.client_order_ref,
  'currency': q.currency_id.name, 'untaxed': q.amount_untaxed, 'total': q.amount_total, 'external_ids': xml.mapped('name'), 'count_with_origin': len(orders),
  'lines': [{'sku': l.product_id.default_code, 'qty': l.product_uom_qty, 'unit': l[UOM].name, 'price': l.price_unit} for l in q.order_line]}, default=str))
