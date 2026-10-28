import json
counts={}
for model,prefix,key,expected in [('product.product','product_','products',10000),('res.partner','partner_','accounts',250),('res.partner','address_','addresses',500),('product.pricelist.item','agreement_','price_agreements',15000)]:
    data=env['ir.model.data'].search([('module','=','pennbridge'),('model','=',model),('name','=like',prefix+'%')])
    # Proof-only product_bolt/product_bearing are intentionally excluded from scale count.
    if key=='products': data=data.filtered(lambda r:r.name not in ['product_bolt','product_bearing'])
    records=env[model].with_context(active_test=False).browse(data.mapped('res_id')).exists()
    assert len(records)==expected,(key,len(records))
    counts[key]=len(records)
    if key=='products':
        counts['active_products']=sum(records.mapped('active'))
        assert counts['active_products']==8000
assert env.ref('pennbridge.agreement_1').fixed_price==10
assert env.ref('pennbridge.agreement_1').product_id==env.ref('pennbridge.product_FB-0830-A2-100')
assert env.ref('pennbridge.partner_C001').property_product_pricelist==env.ref('pennbridge.pricelist_C001')
print('PENNBRIDGE_MASTER_CHECK='+json.dumps(counts))
