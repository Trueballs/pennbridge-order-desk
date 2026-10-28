"""Check fixtures, never claim to evaluate an unbuilt system."""
from pathlib import Path
from email import policy
from email.parser import BytesParser
from decimal import Decimal
import hashlib
import json

ROOT=Path(__file__).resolve().parents[1]
F=ROOT/'fixtures'
cases=json.loads((F/'cases.json').read_text())
context=json.loads((F/'context.json').read_text())
manifest=json.loads((F/'manifest.json').read_text())
assert len(cases)==50 and len(manifest)==50
assert len(list((F/'emails').glob('*.eml')))==50
assert [c['id'] for c in cases]==[f'PB-{i:03}' for i in range(1,51)]
skus={p['sku'] for p in context['products']}
assert len(skus)==len(context['products'])
accounts={c['id'] for c in context['customers']}
for p in context['products']:
    assert Decimal(p['price_gbp'])>=0 and p['units_per_pack']>0
for a in context['aliases']:
    assert a['sku'] in skus and a['customer_id'] in accounts
assert len({(a['customer_id'],a['alias']) for a in context['aliases']})==len(context['aliases'])
for a in context['price_agreements']:
    assert a['sku'] in skus and a['customer_id'] in accounts
    assert Decimal(a['unit_price_gbp'])>=0 and a['valid_from']<=a['valid_to']
routes={'draft_ready','needs_review','duplicate','amendment_review','cancellation_review','not_order'}
for c,m in zip(cases,manifest):
    assert c['synthetic'] and c['expected']['route'] in routes
    assert c['email_path']==m['path']
    blob=(ROOT/m['path']).read_bytes()
    assert hashlib.sha256(blob).hexdigest()==m['sha256'] and len(blob)==m['bytes']
    msg=BytesParser(policy=policy.default).parsebytes(blob)
    assert not msg.defects
    assert str(msg['Subject'])==c['email']['subject']
    assert str(msg['Message-ID'])==c['email']['message_id']
    assert str(msg['From'])==c['email']['from']
    assert str(msg['To'])=='orders@pennbridge.example'
    assert msg.get_body(preferencelist=('plain',)).get_content().replace('\r\n','\n').rstrip()==c['email']['body'].rstrip()
    attachments=list(msg.iter_attachments())
    assert len(attachments)==len(c['email']['attachments'])
    for actual,wanted in zip(attachments,c['email']['attachments']):
        assert actual.get_filename()==wanted['filename']
        assert actual.get_content_type()==wanted['mime']
        assert actual.get_content().replace('\r\n','\n').rstrip()==wanted['content'].rstrip()
    for l in c['expected']['lines']:
        assert l['sku'] is None or l['sku'] in skus
        Decimal(l['quantity'])
    assert c['expected']['customer_id'] is None or c['expected']['customer_id'] in accounts
    assert c['setup']['trusted_ingestion_context']['verified_customer_id']==c['expected']['customer_id']
    for old in [c['setup'].get('existing_order')]+c['setup'].get('historical_orders',[]):
        if old:
            assert old['customer_id'] in accounts
            assert all(l['sku'] in skus for l in old['lines'])
    if c['expected']['route']=='draft_ready':
        assert c['expected']['lines'] and not c['expected']['required_flags']
        assert all(l['sku'] and Decimal(l['quantity'])>0 for l in c['expected']['lines'])
    else:
        assert c['expected']['required_flags']
print(f'PASS: 50 unique cases, MIME bodies/attachments, checksums, routes and catalogue/account references.')
print(f'Reference products: {len(skus)}. This validates fixture integrity only; no application/model tests ran.')
