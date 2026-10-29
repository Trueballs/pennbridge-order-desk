"""Bootstrap synthetic Odoo masters from the shared scale seed; emit verified mirror."""
import hashlib
import json
from pathlib import Path
from decimal import Decimal
source = Path('/mnt/fixtures-scale')
def read(name): return json.loads((source / (name + '.json')).read_text())
def upsert_batch(model, records):
    """One XML ID per record, batch creation, include archived records on replay."""
    existing = env['ir.model.data'].search([('module', '=', 'pennbridge'), ('model', '=', model)])
    by_name = {r.name: r.res_id for r in existing}
    results, new = {}, []
    for xmlid, vals in records:
        module, name = xmlid.split('.', 1)
        assert module == 'pennbridge'
        if name in by_name:
            record = env[model].with_context(active_test=False).browse(by_name[name]).exists()
            assert record, (xmlid, 'dangling external ID')
            record.write(vals)
            results[xmlid] = record
        else: new.append((xmlid, vals))
    for offset in range(0, len(new), 500):
        chunk = new[offset:offset+500]
        created = env[model].with_context(tracking_disable=True, mail_create_nolog=True).create([v for _,v in chunk])
        env['ir.model.data'].create([{'module':'pennbridge','name':x.split('.',1)[1], 'model':model, 'res_id':r.id, 'noupdate':True} for (x,_),r in zip(chunk,created)])
        results.update({x:r for (x,_),r in zip(chunk,created)})
    return results

unit_map = {'each':'uom.product_uom_unit','pack':'pennbridge.uom_pack','box':'pennbridge.uom_box','pair':'pennbridge.uom_pair','roll':'pennbridge.uom_roll','metre':'uom.product_uom_meter','litre':'uom.product_uom_litre','kg':'uom.product_uom_kgm'}
# Packaging is the product's independent selling unit, never a generic conversion
# to each: packs of 10 and packs of 100 cannot share a conversion factor.
# Odoo 19 has no UoM categories (relative_factor/relative_uom_id). Odoo 17/18 require a category and a reference unit,
# and a line unit must share the product unit's category, so each independent selling unit gets its own one-unit category.
if 'relative_factor' in env['uom.uom']._fields:
    upsert_batch('uom.uom', [(unit_map[u], {'name':u.title() + ' (selling unit)', 'relative_factor':1, 'relative_uom_id':False}) for u in ['pack','box','pair','roll']])
else:
    cats = upsert_batch('uom.category', [('pennbridge.uomcat_' + u, {'name':'Pennbridge ' + u + ' (selling unit)'}) for u in ['pack','box','pair','roll']])
    upsert_batch('uom.uom', [(unit_map[u], {'name':u.title() + ' (selling unit)', 'category_id':cats['pennbridge.uomcat_' + u].id, 'uom_type':'reference', 'factor':1.0}) for u in ['pack','box','pair','roll']])
units = {u:env.ref(x) for u,x in unit_map.items()}
for unit in units.values(): unit.active = True
catalogue, accounts, addresses, agreements = [read(n) for n in ['catalogue','accounts','addresses','price_agreements']]
products = upsert_batch('product.product', [(p['external_id'], {'name':p['description'], 'default_code':p['sku'], 'list_price':float(Decimal(p['price_gbp'])), 'uom_id':units[p['selling_unit']].id, 'active':p['active'], 'sale_ok':True, 'type':'consu', 'taxes_id':[(6,0,[])], 'description_sale':p['description']}) for p in catalogue])
partners = upsert_batch('res.partner', [(a['external_id'], {'name':a['name'] + ' (Synthetic)', 'is_company':True, 'customer_rank':1, 'ref':a['id'], 'email':a['approved_senders'][0] if a['approved_senders'] else False}) for a in accounts])
account_map = {a['id']:partners[a['external_id']] for a in accounts}
upsert_batch('res.partner', [(a['external_id'], {'name':a['code'], 'parent_id':account_map[a['customer_id']].id, 'type':'delivery', 'street':a['address']}) for a in addresses])
pricelists = upsert_batch('product.pricelist', [('pennbridge.pricelist_' + a['id'], {'name':'Synthetic ' + a['id'] + ' GBP', 'currency_id':env.ref('base.GBP').id}) for a in accounts])
for a in accounts: account_map[a['id']].property_product_pricelist = pricelists['pennbridge.pricelist_' + a['id']]
product_by_sku = {p['sku']:products[p['external_id']] for p in catalogue}
upsert_batch('product.pricelist.item', [('pennbridge.agreement_' + str(i+1), {'pricelist_id':pricelists['pennbridge.pricelist_' + a['customer_id']].id, 'applied_on':'0_product_variant', 'product_id':product_by_sku[a['sku']].id, 'compute_price':'fixed', 'fixed_price':float(Decimal(a['unit_price_gbp'])), 'min_quantity':a['minimum_quantity'], 'date_start':a['valid_from'] + ' 00:00:00', 'date_end':a['valid_to'] + ' 23:59:59'}) for i,a in enumerate(agreements)])
# Read back fields from destination, independently check each against source.
verified = []
for p in catalogue:
    r = products[p['external_id']]
    assert r.default_code == p['sku'] and r.active == p['active'] and r.uom_id == units[p['selling_unit']]
    assert abs(Decimal(str(r.list_price)) - Decimal(p['price_gbp'])) < Decimal('0.000001')
    verified.append({**p, 'price_gbp':format(Decimal(str(r.list_price)), '.2f'), 'active':r.active, 'odoo_id':r.id, 'odoo_unit_external_id':unit_map[p['selling_unit']]})
snapshot = {'synthetic':True, 'source':'local-odoo-master-readback', 'odoo_version':__import__('odoo.release',fromlist=['version']).version, 'unit_external_ids':unit_map, 'seed_sha256':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in source.glob('*.json')}, 'counts':{'products':len(verified), 'active_products':sum(p['active'] for p in verified), 'accounts':len(accounts), 'addresses':len(addresses),'price_agreements':len(agreements)}, 'catalogue':verified, 'accounts':accounts}
env.cr.commit()
print('PENNBRIDGE_MASTER=' + json.dumps(snapshot,separators=(',',':')))
