-- Raw storefront payload projection for erased orders.
--
-- The raw WooCommerce order body (webhook inbox, pending-FX queue snapshot), the raw refund (refund park) and the tracking items
-- (outbound tracking log) carry the customer's name, address, phone, email, notes, IP and plugin meta. An erasure REPLACES such a payload
-- with an ALLOWLIST PROJECTION: only the keys named below survive (ids, currency, totals, tax lines, line items' product / quantity / price,
-- statuses, dates, refund reason text, money and invoice meta). Everything else, including every key this file has never heard of, is dropped.
-- There is deliberately ONE implementation, here: the erasure UPDATE and the guard triggers below both call these functions.
--
-- The projection output carries `_erasure_projected: true`. It is never `{}`, so it cannot collide with the inbox compaction's
-- `payloadJson <> '{}'` predicate, and the functions are idempotent (projecting a projection returns it unchanged), which is what lets
-- "payload IS DISTINCT FROM projection(payload)" serve as the "still carries identity" test.
--
-- ADDITIVE ONLY: functions and triggers; no table or column changes, no backfill (the erasure and its reconcile pass project existing rows).
-- A row INSERTED while an erasure is still uncommitted is the one case a trigger cannot see; the reconcile pass clears it on its next run.

-- An object restricted to the named keys; any non-object input yields {}.
CREATE OR REPLACE FUNCTION gdpr_keep_keys(src jsonb, keys text[]) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN src IS NULL OR jsonb_typeof(src) <> 'object' THEN '{}'::jsonb
    ELSE COALESCE((SELECT jsonb_object_agg(e.key, e.value) FROM jsonb_each(src) e WHERE e.key = ANY(keys)), '{}'::jsonb) END
$$;

-- Of the neutral replacements (an object), those whose key is present in src: a removed field keeps its TYPE so a replay does not trip over a missing key.
CREATE OR REPLACE FUNCTION gdpr_neutral_for_present(src jsonb, neutral jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE((SELECT jsonb_object_agg(e.key, e.value) FROM jsonb_each(neutral) e WHERE src ? e.key), '{}'::jsonb)
$$;

-- The order meta keys that survive: money, FX, cost and invoice references. Anything else is dropped.
CREATE OR REPLACE FUNCTION gdpr_wc_meta_key_allowed(k text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT k IS NOT NULL AND (
    k LIKE '%\_base\_currency' ESCAPE '\' OR
    k = ANY(ARRAY['_base_currency_exchange_rate', '_cogs_total_value_order_currency', '_cogs_value_order_currency', 'vat_compliance_vat_paid',
      '_wcpdf_invoice_number', '_wcpdf_invoice_number_data', '_wcpdf_invoice_date', '_wcpdf_invoice_date_formatted', '_wcpdf_invoice_display_date',
      'xeroom_invoice_no_sent', 'xeroom_invoice_reference_sent', 'xeroom_order_sent', '_reduced_stock', '_restock_refunded_items',
      '_refunded_item_id', 'coupon_info']))
$$;

-- A meta_data array reduced to the allowed keys (each entry keeps id, key, value). Not an array -> [].
CREATE OR REPLACE FUNCTION gdpr_project_meta(meta jsonb, only_keys text[]) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN meta IS NULL OR jsonb_typeof(meta) <> 'array' THEN '[]'::jsonb ELSE COALESCE((
    SELECT jsonb_agg(gdpr_keep_keys(m, ARRAY['id', 'key', 'value']) ORDER BY ord)
      FROM jsonb_array_elements(meta) WITH ORDINALITY AS t(m, ord)
     WHERE jsonb_typeof(m) = 'object' AND ((only_keys IS NULL AND gdpr_wc_meta_key_allowed(m->>'key')) OR (only_keys IS NOT NULL AND (m->>'key') = ANY(only_keys)))
  ), '[]'::jsonb) END
$$;

-- Each element of an array reduced to `keys`, plus a projected meta_data when with_meta; `only_keys` limits that meta (NULL = the allowlist). Not an array -> [].
CREATE OR REPLACE FUNCTION gdpr_project_lines(arr jsonb, keys text[], with_meta boolean, only_keys text[]) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN arr IS NULL OR jsonb_typeof(arr) <> 'array' THEN '[]'::jsonb ELSE COALESCE((
    SELECT jsonb_agg(gdpr_keep_keys(l, keys) || CASE WHEN with_meta AND l ? 'meta_data' THEN jsonb_build_object('meta_data', gdpr_project_meta(l->'meta_data', only_keys)) ELSE '{}'::jsonb END ORDER BY ord)
      FROM jsonb_array_elements(arr) WITH ORDINALITY AS t(l, ord)
     WHERE jsonb_typeof(l) = 'object'
  ), '[]'::jsonb) END
$$;

-- A billing / shipping block of the same SHAPE, every field empty except the 2-letter country (VAT place-of-supply evidence, owner ruling).
CREATE OR REPLACE FUNCTION gdpr_empty_address(a jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('first_name', '', 'last_name', '', 'company', '', 'address_1', '', 'address_2', '', 'city', '', 'state', '', 'postcode', '',
    'country', CASE WHEN a IS NOT NULL AND jsonb_typeof(a) = 'object' AND jsonb_typeof(a->'country') = 'string' AND (a->>'country') ~ '^[A-Za-z]{2}$' THEN a->'country' ELSE to_jsonb(''::text) END,
    'email', '', 'phone', '')
$$;

CREATE OR REPLACE FUNCTION gdpr_project_wc_order(o jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN o IS NULL OR jsonb_typeof(o) <> 'object' THEN o ELSE
    gdpr_keep_keys(o, ARRAY['id', 'parent_id', 'number', 'status', 'currency', 'currency_symbol', 'version', 'created_via',
      'date_created', 'date_created_gmt', 'date_modified', 'date_modified_gmt', 'date_paid', 'date_paid_gmt', 'date_completed', 'date_completed_gmt',
      'prices_include_tax', 'discount_total', 'discount_tax', 'shipping_total', 'shipping_tax', 'cart_tax', 'total', 'total_tax',
      'payment_method', 'payment_method_title', 'needs_payment', 'needs_processing', 'is_editable', 'wpo_wcpdf_invoice_number', 'cost_of_goods_sold', 'store_credit_used'])
    || gdpr_neutral_for_present(o, jsonb_build_object('customer_id', 0, 'customer_note', '', 'customer_ip_address', '', 'customer_user_agent', '', 'order_key', '', 'payment_url', '', 'cart_hash', '', 'transaction_id', '0'))
    || jsonb_build_object('billing', gdpr_empty_address(o->'billing'), 'shipping', gdpr_empty_address(o->'shipping'))
    || jsonb_build_object('meta_data', gdpr_project_meta(o->'meta_data', NULL))
    || jsonb_build_object('line_items', gdpr_project_lines(o->'line_items',
         ARRAY['id', 'name', 'parent_name', 'product_id', 'variation_id', 'sku', 'global_unique_id', 'quantity', 'price', 'subtotal', 'subtotal_tax', 'total', 'total_tax', 'tax_class', 'taxes', 'cogs_value', 'cost_of_goods_sold'], true, NULL))
    || jsonb_build_object('shipping_lines', gdpr_project_lines(o->'shipping_lines',
         ARRAY['id', 'method_id', 'method_title', 'instance_id', 'total', 'total_tax', 'taxes', 'tax_status'], true, NULL))
    || jsonb_build_object('fee_lines', gdpr_project_lines(o->'fee_lines', ARRAY['id', 'name', 'tax_class', 'tax_status', 'total', 'total_tax', 'taxes'], true, NULL))
    || jsonb_build_object('coupon_lines', gdpr_project_lines(o->'coupon_lines', ARRAY['id', 'code', 'discount', 'discount_tax'], true, ARRAY['coupon_info']))
    || jsonb_build_object('tax_lines', gdpr_project_lines(o->'tax_lines', ARRAY['id', 'rate_code', 'rate_id', 'label', 'compound', 'tax_total', 'shipping_tax_total', 'rate_percent'], false, NULL))
    || jsonb_build_object('refunds', gdpr_project_lines(o->'refunds', ARRAY['id', 'total', 'reason'], false, NULL))
    || jsonb_build_object('_erasure_projected', true)
  END
$$;

CREATE OR REPLACE FUNCTION gdpr_project_wc_refund(r jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN r IS NULL OR jsonb_typeof(r) <> 'object' THEN r ELSE
    gdpr_keep_keys(r, ARRAY['id', 'parent_id', 'order_id', 'date_created', 'date_created_gmt', 'amount', 'reason', 'refunded_payment'])
    || gdpr_neutral_for_present(r, jsonb_build_object('refunded_by', 0))
    || jsonb_build_object('meta_data', '[]'::jsonb)
    || jsonb_build_object('line_items', gdpr_project_lines(r->'line_items',
         ARRAY['id', 'name', 'product_id', 'variation_id', 'quantity', 'tax_class', 'subtotal', 'subtotal_tax', 'total', 'total_tax', 'taxes', 'sku', 'refund_total'], true, ARRAY['_refunded_item_id']))
    || CASE WHEN r ? 'shipping_lines' THEN jsonb_build_object('shipping_lines', gdpr_project_lines(r->'shipping_lines', ARRAY['id', 'method_id', 'method_title', 'total', 'total_tax', 'taxes'], false, NULL)) ELSE '{}'::jsonb END
    || jsonb_build_object('_erasure_projected', true)
  END
$$;

-- A sync-log payload, projected by its SHAPE. Shape and not the row's family column: the family rule lives in one place (the shared TypeScript
-- module) and the database does not restate it. A payload that holds no raw storefront data comes back UNCHANGED, so "payload IS DISTINCT FROM
-- projection" is false for it: the held-invoice park (its `accountingPayload` is scrubbed by the erasure's own contact-block step), a status push, an
-- admission refusal (ids only).
CREATE OR REPLACE FUNCTION gdpr_project_sync_log_payload(p jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p IS NULL OR jsonb_typeof(p) <> 'object' THEN p
    WHEN p ? 'accountingPayload' THEN p
    WHEN p->>'meta_key' = '_wc_shipment_tracking_items' THEN
      (CASE WHEN p ? 'items' THEN jsonb_set(p, '{items}', '[]'::jsonb) ELSE p END) || jsonb_build_object('_erasure_projected', true)
    WHEN p ? 'order' AND p ? 'externalOrderId' THEN
      jsonb_set(p, '{order}', gdpr_project_wc_order(p->'order')) || jsonb_build_object('_erasure_projected', true)
    WHEN p ? 'amount' AND NOT (p ? 'queue') THEN gdpr_project_wc_refund(p)
    ELSE p
  END
$$;

-- The webhook inbox payload, by resource. Anything else, or a payload with no order id, comes back unchanged.
CREATE OR REPLACE FUNCTION gdpr_project_webhook_payload(p jsonb, resource text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p IS NULL OR jsonb_typeof(p) <> 'object' THEN p
    WHEN resource = 'orders' AND p ? 'id' THEN gdpr_project_wc_order(p)
    WHEN resource = 'refunds' AND (p ? 'id') THEN gdpr_project_wc_refund(p)
    ELSE p
  END
$$;

-- The storefront order id a webhook delivery is about: the order's own id, or the refund's parent. NULL when it names none.
CREATE OR REPLACE FUNCTION gdpr_webhook_order_key(p jsonb, resource text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p IS NULL OR jsonb_typeof(p) <> 'object' THEN NULL
    WHEN resource = 'orders' THEN p->>'id'
    WHEN resource = 'refunds' THEN COALESCE(p->>'order_id', p->>'parent_id')
    ELSE NULL END
$$;

-- Whether the IMS order is erased (the order, or its customer), by id.
CREATE OR REPLACE FUNCTION gdpr_order_id_erased(order_id text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT (o."erasedAt" IS NOT NULL OR c."gdprAnonymisedAt" IS NOT NULL)
                     FROM "sales_orders" o LEFT JOIN "customers" c ON c."id" = o."customerId" WHERE o."id" = order_id), false)
$$;

-- Whether a STOREFRONT order is erased: the linked IMS order is, or an open erasure obligation names it (an order IMS does not hold yet).
CREATE OR REPLACE FUNCTION gdpr_storefront_order_erased(external_order_id text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT external_order_id IS NOT NULL AND (
    EXISTS (SELECT 1 FROM "shopping_order_links" l JOIN "sales_orders" o ON o."id" = l."orderId" LEFT JOIN "customers" c ON c."id" = o."customerId"
             WHERE l."connector" = 'woocommerce' AND l."externalOrderId" = external_order_id AND (o."erasedAt" IS NOT NULL OR c."gdprAnonymisedAt" IS NOT NULL))
    OR EXISTS (SELECT 1 FROM "storefront_order_erasure_obligations" b WHERE b."connector" = 'woocommerce' AND b."externalOrderId" = external_order_id AND b."retiredAt" IS NULL))
$$;

CREATE OR REPLACE FUNCTION erased_wc_webhook_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  marker CONSTANT text := 'Text removed by GDPR erasure';
  k text;
BEGIN
  IF NEW."connector" <> 'woocommerce' OR NEW."resource" NOT IN ('orders', 'refunds') THEN RETURN NEW; END IF;
  k := gdpr_webhook_order_key(NEW."payloadJson", NEW."resource");
  IF k IS NULL OR NOT gdpr_storefront_order_erased(k) THEN RETURN NEW; END IF;
  NEW."payloadJson" := gdpr_project_webhook_payload(NEW."payloadJson", NEW."resource");
  IF NEW."lastError" IS NOT NULL AND NEW."lastError" <> marker THEN NEW."lastError" := marker; END IF;
  RETURN NEW;
END
$$;

-- Whether a sync-log row belongs to an ERASED order: an imported order by its id, or, with no entityId (the pending-FX queue, an admission refusal, a failed import: all keyed by the storefront order id alone), by that id. A row WITH an entityId is never matched by externalId, which is one number space with refund ids.
CREATE OR REPLACE FUNCTION gdpr_sync_log_row_erased(l "shopping_sync_logs") RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT l."connector" = 'woocommerce' AND l."entityType" IN ('SalesOrder', 'ORDER') AND (
    (l."entityId" IS NOT NULL AND gdpr_order_id_erased(l."entityId"))
    OR (l."entityId" IS NULL AND l."entityType" = 'SalesOrder' AND gdpr_storefront_order_erased(l."externalId")))
$$;

-- The error text the erasure leaves: the marker, except on a held-invoice park, whose text is a fixed IMS sentence naming an order number.
CREATE OR REPLACE FUNCTION gdpr_sync_log_row_message(l "shopping_sync_logs") RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN l."errorMessage" IS NULL OR COALESCE(l."payload" ? 'accountingPayload', false) THEN l."errorMessage" ELSE 'Text removed by GDPR erasure' END
$$;

-- Whether the row still carries raw identity (a payload the projection would change, or error text that is not yet the marker).
CREATE OR REPLACE FUNCTION gdpr_sync_log_row_dirty(l "shopping_sync_logs") RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT (l."payload" IS DISTINCT FROM gdpr_project_sync_log_payload(l."payload")) OR (l."errorMessage" IS DISTINCT FROM gdpr_sync_log_row_message(l))
$$;

CREATE OR REPLACE FUNCTION erased_wc_sync_log_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."connector" <> 'woocommerce' OR NOT gdpr_sync_log_row_erased(NEW) THEN RETURN NEW; END IF;
  NEW."errorMessage" := gdpr_sync_log_row_message(NEW);
  NEW."payload" := gdpr_project_sync_log_payload(NEW."payload");
  RETURN NEW;
END
$$;

CREATE TRIGGER shopping_webhook_events_erased_projection BEFORE INSERT OR UPDATE OF "payloadJson", "lastError" ON "shopping_webhook_events"
  FOR EACH ROW EXECUTE FUNCTION erased_wc_webhook_event_guard();
CREATE TRIGGER shopping_sync_logs_erased_projection BEFORE INSERT OR UPDATE OF "payload", "errorMessage" ON "shopping_sync_logs"
  FOR EACH ROW EXECUTE FUNCTION erased_wc_sync_log_guard();
