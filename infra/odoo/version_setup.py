"""Odoo 17/18 version proof: company currency (activates GBP) and the disposable local integration login. Idempotent."""
env.company.write({'name': 'Pennbridge Industrial Supplies (Synthetic)', 'currency_id': env.ref('base.GBP').id})
env.ref('base.user_admin').write({'login': 'pennbridge-admin', 'password': 'pennbridge-local-admin-only'})
env.cr.commit()
print('PENNBRIDGE_SETUP=ok')
