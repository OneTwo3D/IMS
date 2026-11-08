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

-- META VALUES: EVERY allowlisted key has a declared value projection, and a value is rebuilt from typed fields only; nothing is passed through.
--   number          a readable (signed) number, else the fixed word 'unreadable'
--   decimal         a non-negative plain decimal, else 'unreadable' (the importer's own wclc amount reader)
--   flag            a boolean, 0 / 1, or one of 1 0 true false yes no, else 'other'
--   wclc_kind       one of the three wclc fee kinds, else 'other'
--   (coupon types)  a closed vocabulary, else a fixed credit label, else 'other'
--   invoice_number  a plain document number (one token of letters, digits and . _ / # -, with at least one digit, no spaces), else the ENTRY IS DROPPED (an unreadable number must read as "not numbered yet")
--   int             a positive whole number, else 'unreadable'
--   contribution    {coupon code: readable amount | 'unreadable'}
--   credit_amount   a readable non-negative amount (or the empty string), else 'unreadable'
--   coupon_info     [null, null, <discount type>, null]: the type is the only position the classifier reads
--   coupon_data     {discount_type: <discount type>}
-- gdpr_wc_meta_exact_keys() lists the allowlisted keys and gdpr_wc_meta_value_kind() their projections; a key with no kind is DROPPED, and the census test fails
-- if the two disagree. Keys that end in _base_currency are numbers.
CREATE OR REPLACE FUNCTION gdpr_wc_meta_exact_keys() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['_base_currency_exchange_rate', '_cogs_total_value_order_currency', '_cogs_value_order_currency', '_wcpdf_invoice_number',
    'smart_coupons_contribution', '_wc_store_credit_used', '_store_credit_used', '_store_credit_applied', '_used_wallet_amount', '_woo_wallet_used',
    '_partial_pay_through_wallet_amount', '_ywgc_applied_gift_cards_total', '_gift_card_amount', '_giftcard_amount', 'wc_gift_cards_total', '_smart_coupon_credit_used',
    '_wclc_fee', '_wclc_fee_kind', '_wclc_duty_component', '_wclc_tax_component', '_wclc_handling_component']
$$;

CREATE OR REPLACE FUNCTION gdpr_wc_meta_value_kind(k text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN k LIKE '%\_base\_currency' ESCAPE '\' THEN 'number'
    WHEN k IN ('_base_currency_exchange_rate', '_cogs_total_value_order_currency', '_cogs_value_order_currency') THEN 'number'
    WHEN k = '_wcpdf_invoice_number' THEN 'invoice_number'
    WHEN k = 'smart_coupons_contribution' THEN 'contribution'
    WHEN k IN ('_wc_store_credit_used', '_store_credit_used', '_store_credit_applied', '_used_wallet_amount', '_woo_wallet_used', '_partial_pay_through_wallet_amount',
               '_ywgc_applied_gift_cards_total', '_gift_card_amount', '_giftcard_amount', 'wc_gift_cards_total', '_smart_coupon_credit_used') THEN 'credit_amount'
    WHEN k = '_wclc_fee' THEN 'flag'
    WHEN k = '_wclc_fee_kind' THEN 'wclc_kind'
    WHEN k IN ('_wclc_duty_component', '_wclc_tax_component', '_wclc_handling_component') THEN 'decimal'
    WHEN k = 'coupon_info' THEN 'coupon_info'
    WHEN k = 'coupon_data' THEN 'coupon_data'
    WHEN k = '_refunded_item_id' THEN 'int'
    ELSE NULL END
$$;

-- The order / line meta keys that survive: money, FX, cost, the invoice number and the credit evidence the importer reads. Anything else is dropped.
CREATE OR REPLACE FUNCTION gdpr_wc_meta_key_allowed(k text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT k IS NOT NULL AND (k LIKE '%\_base\_currency' ESCAPE '\' OR k = ANY(gdpr_wc_meta_exact_keys()))
$$;

CREATE OR REPLACE FUNCTION gdpr_jsonb_maybe(v jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF v IS NULL THEN RETURN NULL; END IF;
  IF jsonb_typeof(v) = 'string' THEN
    IF btrim(v#>>'{}') = '' THEN RETURN NULL; END IF;
    RETURN (v#>>'{}')::jsonb;
  END IF;
  RETURN v;
EXCEPTION WHEN others THEN
  RETURN to_jsonb('unparseable'::text);
END
$$;

-- A value that IS a non-negative money amount stays; anything else becomes 'unreadable'. allow_empty: '' is a readable zero for the wallet meta keys.
CREATE OR REPLACE FUNCTION gdpr_money_or_unreadable(v jsonb, allow_empty boolean) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN v IS NULL THEN to_jsonb('unreadable'::text)
    WHEN jsonb_typeof(v) = 'number' AND (v#>>'{}')::numeric >= 0 THEN v
    WHEN jsonb_typeof(v) = 'string' AND (v#>>'{}') ~ '^\s*[0-9]+(\.[0-9]+)?\s*$' THEN v
    WHEN jsonb_typeof(v) = 'string' AND allow_empty AND (v#>>'{}') = '' THEN v
    ELSE to_jsonb('unreadable'::text) END
$$;

-- A coupon discount type from a CLOSED vocabulary: the types the importer knows; anything that reads as credit becomes a fixed label for that kind (so the
-- classifier's credit-words check still fires); anything else is 'other'. Never the original text.
CREATE OR REPLACE FUNCTION gdpr_discount_type(v jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT to_jsonb(CASE
    WHEN v IS NULL OR jsonb_typeof(v) <> 'string' THEN 'other'
    WHEN lower(btrim(v#>>'{}')) IN ('fixed_cart', 'percent', 'fixed_product', 'percent_product', 'acfw_bogo', 'smart_coupon') THEN lower(btrim(v#>>'{}'))
    WHEN (v#>>'{}') ~* 'smart[_ -]?coupon' THEN 'smart_coupon_other'
    WHEN (v#>>'{}') ~* 'store[_ -]?credit' THEN 'store_credit'
    WHEN (v#>>'{}') ~* 'gift[_ -]?(card|cert)|giftcard' THEN 'gift_card'
    WHEN (v#>>'{}') ~* 'wallet' THEN 'wallet'
    ELSE 'other' END)
$$;

-- `smart_coupons_contribution`: {coupon code: amount}. Codes are kept (discount evidence); every amount is a readable amount or 'unreadable'; a non-map is 'unreadable'.
CREATE OR REPLACE FUNCTION gdpr_project_contribution(v jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p IS NULL OR jsonb_typeof(p) <> 'object' THEN to_jsonb('unreadable'::text)
    ELSE COALESCE((SELECT jsonb_object_agg(e.key, gdpr_money_or_unreadable(e.value, false)) FROM jsonb_each(p) e), '{}'::jsonb) END
  FROM (SELECT gdpr_jsonb_maybe(v) AS p) x
$$;

-- legacy `coupon_data`: only `discount_type`.
CREATE OR REPLACE FUNCTION gdpr_project_coupon_data(v jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p IS NOT NULL AND jsonb_typeof(p) = 'object' AND jsonb_typeof(p->'discount_type') = 'string'
    THEN jsonb_build_object('discount_type', gdpr_discount_type(p->'discount_type'))
    ELSE '{}'::jsonb END
  FROM (SELECT gdpr_jsonb_maybe(v) AS p) x
$$;

-- `coupon_info` (8.7+): [id, code, discount_type, amount]; only position 2, typed. Not an array -> 'unreadable' (read as no type, as before).
CREATE OR REPLACE FUNCTION gdpr_project_coupon_info(v jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p IS NULL OR jsonb_typeof(p) <> 'array' THEN to_jsonb('unreadable'::text)
    WHEN jsonb_typeof(p->2) = 'string' AND btrim(p->>2) <> '' THEN jsonb_build_array(NULL::text, NULL::text, gdpr_discount_type(to_jsonb(btrim(p->>2))), NULL::text)
    ELSE jsonb_build_array(NULL::text, NULL::text, NULL::text, NULL::text) END
  FROM (SELECT gdpr_jsonb_maybe(v) AS p) x
$$;

-- The projection of ONE meta value by its declared kind; SQL NULL means "drop the entry".
CREATE OR REPLACE FUNCTION gdpr_project_meta_value(k text, v jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE gdpr_wc_meta_value_kind(k)
    WHEN 'number' THEN CASE WHEN v IS NOT NULL AND jsonb_typeof(v) = 'number' THEN v
                            WHEN v IS NOT NULL AND jsonb_typeof(v) = 'string' AND (v#>>'{}') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' THEN v
                            ELSE to_jsonb('unreadable'::text) END
    WHEN 'decimal' THEN CASE WHEN v IS NOT NULL AND jsonb_typeof(v) = 'number' AND (v#>>'{}')::numeric >= 0 THEN v
                             WHEN v IS NOT NULL AND jsonb_typeof(v) = 'string' AND (v#>>'{}') ~ '^[0-9]+(\.[0-9]+)?$' THEN v
                             ELSE to_jsonb('unreadable'::text) END
    WHEN 'flag' THEN CASE WHEN v IS NOT NULL AND jsonb_typeof(v) = 'boolean' THEN v
                          WHEN v IS NOT NULL AND jsonb_typeof(v) = 'number' AND (v#>>'{}') IN ('0', '1') THEN v
                          WHEN v IS NOT NULL AND jsonb_typeof(v) = 'string' AND lower(btrim(v#>>'{}')) IN ('1', '0', 'true', 'false', 'yes', 'no') THEN to_jsonb(lower(btrim(v#>>'{}')))
                          ELSE to_jsonb('other'::text) END
    WHEN 'wclc_kind' THEN to_jsonb(CASE WHEN v IS NOT NULL AND jsonb_typeof(v) = 'string' AND btrim(v#>>'{}') IN ('duty_flat', 'uhf', 'duty_fee') THEN btrim(v#>>'{}') ELSE 'other' END)
    WHEN 'invoice_number' THEN CASE WHEN v IS NOT NULL AND jsonb_typeof(v) IN ('string', 'number') AND (v#>>'{}') ~ '^(?=.*[0-9])[A-Za-z0-9_./#-]{1,40}$' THEN v ELSE NULL END
    WHEN 'int' THEN CASE WHEN v IS NOT NULL AND jsonb_typeof(v) = 'number' AND (v#>>'{}') ~ '^[1-9][0-9]*$' THEN v
                         WHEN v IS NOT NULL AND jsonb_typeof(v) = 'string' AND (v#>>'{}') ~ '^[1-9][0-9]*$' THEN v
                         ELSE to_jsonb('unreadable'::text) END
    WHEN 'contribution' THEN gdpr_project_contribution(v)
    WHEN 'credit_amount' THEN gdpr_money_or_unreadable(v, true)
    WHEN 'coupon_info' THEN gdpr_project_coupon_info(v)
    WHEN 'coupon_data' THEN gdpr_project_coupon_data(v)
    ELSE NULL END
$$;

-- A meta_data array reduced to the allowed keys; each entry is rebuilt from `key`, a numeric `id` and the PROJECTED value (an entry whose value has no
-- projection is dropped). only_keys limits the keys (NULL = the allowlist). Not an array -> [].
CREATE OR REPLACE FUNCTION gdpr_project_meta(meta jsonb, only_keys text[]) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN meta IS NULL OR jsonb_typeof(meta) <> 'array' THEN '[]'::jsonb ELSE COALESCE((
    SELECT jsonb_agg(
             jsonb_build_object('key', m->'key')
             || CASE WHEN jsonb_typeof(m->'id') = 'number' THEN jsonb_build_object('id', m->'id') ELSE '{}'::jsonb END
             || jsonb_build_object('value', pv.v)
             ORDER BY ord)
      FROM jsonb_array_elements(meta) WITH ORDINALITY AS t(m, ord), LATERAL (SELECT gdpr_project_meta_value(m->>'key', m->'value') AS v) pv
     WHERE jsonb_typeof(m) = 'object' AND jsonb_typeof(m->'key') = 'string' AND pv.v IS NOT NULL
       AND ((only_keys IS NULL AND gdpr_wc_meta_key_allowed(m->>'key')) OR (only_keys IS NOT NULL AND (m->>'key') = ANY(only_keys)))
  ), '[]'::jsonb) END
$$;

-- Each element of an array reduced to `keys`, plus a projected meta_data when with_meta; `only_keys` limits that meta (NULL = the allowlist).
-- name_mode says what becomes of the element's free-text `name` (a personalised item can carry a recipient's name): 'sku' = the SKU (else 'Item'),
-- 'fee' = a FIXED label per credit kind the coupon classifier reads (Smart coupon / Store credit / Gift card / Wallet; never the original text), else 'Fee'; anything else = no name.
-- parent_name is always dropped. Not an array -> [].
CREATE OR REPLACE FUNCTION gdpr_project_lines(arr jsonb, keys text[], with_meta boolean, only_keys text[], name_mode text DEFAULT 'none') RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN arr IS NULL OR jsonb_typeof(arr) <> 'array' THEN '[]'::jsonb ELSE COALESCE((
    SELECT jsonb_agg(gdpr_keep_keys(l, keys)
        || CASE WHEN with_meta AND l ? 'meta_data' THEN jsonb_build_object('meta_data', gdpr_project_meta(l->'meta_data', only_keys)) ELSE '{}'::jsonb END
        || CASE name_mode
             WHEN 'sku' THEN jsonb_build_object('name', COALESCE(NULLIF(l->>'sku', ''), 'Item'))
             WHEN 'fee' THEN jsonb_build_object('name', to_jsonb(CASE
               WHEN (l->>'name') ~* 'smart[_ -]?coupon' THEN 'Smart coupon'
               WHEN (l->>'name') ~* 'store[_ -]?credit' THEN 'Store credit'
               WHEN (l->>'name') ~* 'gift[_ -]?(card|cert)|giftcard' THEN 'Gift card'
               WHEN (l->>'name') ~* 'wallet' THEN 'Wallet'
               ELSE 'Fee' END))
             ELSE '{}'::jsonb END
        ORDER BY ord)
      FROM jsonb_array_elements(arr) WITH ORDINALITY AS t(l, ord)
     WHERE jsonb_typeof(l) = 'object'
  ), '[]'::jsonb) END
$$;

-- Coupon lines: id, code and amounts; meta limited to the two type records the classifier reads (coupon_info, and legacy coupon_data reduced to its type).
-- The classifier also looks for credit WORDS anywhere in a line's meta: when a dropped entry held one, a fixed evidence entry stands in for it.
CREATE OR REPLACE FUNCTION gdpr_project_coupon_lines(arr jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN arr IS NULL OR jsonb_typeof(arr) <> 'array' THEN '[]'::jsonb ELSE COALESCE((
    SELECT jsonb_agg(
      gdpr_keep_keys(l, ARRAY['id', 'code', 'discount', 'discount_tax'])
      || jsonb_build_object('meta_data',
           gdpr_project_meta(l->'meta_data', ARRAY['coupon_info', 'coupon_data'])
           || CASE WHEN (l->'meta_data')::text ~* 'smart[_ -]?coupon|store[_ -]?credit|gift[_ -]?(card|cert)|giftcard|wallet'
                    AND (gdpr_project_meta(l->'meta_data', ARRAY['coupon_info', 'coupon_data']))::text !~* 'smart[_ -]?coupon|store[_ -]?credit|gift[_ -]?(card|cert)|giftcard|wallet'
                   THEN jsonb_build_array(jsonb_build_object('key', '_erasure_credit_evidence', 'value', 'store credit')) ELSE '[]'::jsonb END)
      ORDER BY ord)
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
         ARRAY['id', 'product_id', 'variation_id', 'sku', 'global_unique_id', 'quantity', 'price', 'subtotal', 'subtotal_tax', 'total', 'total_tax', 'tax_class', 'taxes', 'cogs_value', 'cost_of_goods_sold'], true, NULL, 'sku'))
    || jsonb_build_object('shipping_lines', gdpr_project_lines(o->'shipping_lines',
         ARRAY['id', 'method_id', 'method_title', 'instance_id', 'total', 'total_tax', 'taxes', 'tax_status'], true, NULL))
    || jsonb_build_object('fee_lines', gdpr_project_lines(o->'fee_lines', ARRAY['id', 'tax_class', 'tax_status', 'total', 'total_tax', 'taxes'], true, NULL, 'fee'))
    || jsonb_build_object('coupon_lines', gdpr_project_coupon_lines(o->'coupon_lines'))
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
         ARRAY['id', 'product_id', 'variation_id', 'quantity', 'tax_class', 'subtotal', 'subtotal_tax', 'total', 'total_tax', 'taxes', 'sku', 'refund_total'], true, ARRAY['_refunded_item_id'], 'sku'))
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

-- A returns-inbox row the erasure cleared: the instant, kept on the row. The warehouse reports a return against an order reference that IMS cannot always
-- resolve again afterwards (the link, the number it matches on), so a later poll would otherwise treat the row as live and write the raw record back. The
-- returns writer reads this marker under the order lock, and the trigger below honours it for every writer. Additive; NULL for every existing row.
ALTER TABLE "wms_returns_inbox" ADD COLUMN "erasedAt" TIMESTAMP(3);

CREATE OR REPLACE FUNCTION erased_returns_inbox_marker_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."erasedAt" IS NULL THEN RETURN NEW; END IF;
  IF NEW."reason" IS NOT NULL AND NEW."reason" <> 'Text removed by GDPR erasure' THEN NEW."reason" := 'Text removed by GDPR erasure'; END IF;
  IF NEW."resolutionNote" IS NOT NULL AND NEW."resolutionNote" <> 'Text removed by GDPR erasure' THEN NEW."resolutionNote" := 'Text removed by GDPR erasure'; END IF;
  IF NEW."rawPayload" IS NOT NULL AND NEW."rawPayload" <> '{}'::jsonb THEN NEW."rawPayload" := '{}'::jsonb; END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER wms_returns_inbox_erased_marker BEFORE INSERT OR UPDATE OF "reason", "resolutionNote", "rawPayload", "erasedAt" ON "wms_returns_inbox"
  FOR EACH ROW EXECUTE FUNCTION erased_returns_inbox_marker_guard();

-- The audit event of a return the erasure marked: the event copies the free-text reason and note into its before / after JSON, so an event written (or
-- rewritten) for a marked inbox row gets the marker, whoever writes it. Keyed on the inbox row id the event names.
CREATE OR REPLACE FUNCTION erased_return_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  marker CONSTANT text := 'Text removed by GDPR erasure';
BEGIN
  IF NEW."entityType" <> 'RETURN' OR NEW."action" <> 'return_inbox' THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM "wms_returns_inbox" r WHERE r."id" = NEW."entityId" AND r."erasedAt" IS NOT NULL) THEN RETURN NEW; END IF;
  IF NEW."before" IS NOT NULL AND jsonb_typeof(NEW."before") = 'object' THEN
    NEW."before" := NEW."before"
      || (CASE WHEN (NEW."before"->>'reason') IS NOT NULL THEN jsonb_build_object('reason', marker) ELSE '{}'::jsonb END)
      || (CASE WHEN (NEW."before"->>'resolutionNote') IS NOT NULL THEN jsonb_build_object('resolutionNote', marker) ELSE '{}'::jsonb END);
  END IF;
  IF NEW."after" IS NOT NULL AND jsonb_typeof(NEW."after") = 'object' THEN
    NEW."after" := NEW."after"
      || (CASE WHEN (NEW."after"->>'reason') IS NOT NULL THEN jsonb_build_object('reason', marker) ELSE '{}'::jsonb END)
      || (CASE WHEN (NEW."after"->>'resolutionNote') IS NOT NULL THEN jsonb_build_object('resolutionNote', marker) ELSE '{}'::jsonb END);
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER wms_mutation_events_erased_return BEFORE INSERT OR UPDATE OF "before", "after" ON "wms_mutation_events"
  FOR EACH ROW EXECUTE FUNCTION erased_return_event_guard();
