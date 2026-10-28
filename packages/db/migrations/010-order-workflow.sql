-- W2 order workflow core: sender mappings, searchable/sortable order list, export state machine.
-- Idempotent: safe to apply more than once (the server also applies it as a fallback when no runner has).
CREATE TABLE IF NOT EXISTS sender_mappings (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK(kind IN ('email','domain')),
  value text NOT NULL CHECK(value = lower(value)),
  customer_id text NOT NULL REFERENCES customers(id),
  trusted boolean NOT NULL DEFAULT false,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(kind,value)
);
CREATE INDEX IF NOT EXISTS sender_mappings_customer ON sender_mappings(customer_id);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS sender text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS subject text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS search_text text NOT NULL DEFAULT '';
UPDATE orders o SET sender=lower(m.data->>'sender'), subject=m.data->>'subject' FROM messages m WHERE m.id=o.message_id AND o.sender IS NULL AND o.subject IS NULL;
UPDATE orders SET search_text=left(lower(concat_ws(' ',id,po_number,customer_id,sender,subject,data->>'customerName',
  (SELECT string_agg(concat_ws(' ',l->>'selectedSku',l->>'sku',l->>'manufacturerReference',l->>'customerAlias',l->>'description'),' ') FROM jsonb_array_elements(data->'lines') l))),20000)
  WHERE search_text='';
-- Newest-first listing with a (created_at,id) keyset cursor.
CREATE INDEX IF NOT EXISTS orders_created ON orders(created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS orders_status_created ON orders(status,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS orders_customer_created ON orders(customer_id,created_at DESC,id DESC);

-- A voided export frees (order,version) for a fresh export; the idempotency key stays unique forever.
ALTER TABLE exports DROP CONSTRAINT IF EXISTS exports_order_id_version_key;
CREATE UNIQUE INDEX IF NOT EXISTS exports_live_order_version ON exports(order_id,version) WHERE (data->>'state') <> 'voided';
