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

-- A customer-keyed erasure tombstone (hash of connector + storefront customer id, and the erasure time; no raw identifier). See the schema comment.
CREATE TABLE "storefront_customer_erasure_tombstones" (
    "connector" TEXT NOT NULL,
    "customerKeyHash" TEXT NOT NULL,
    "erasedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "storefront_customer_erasure_tombstones_pkey" PRIMARY KEY ("connector","customerKeyHash")
);

CREATE OR REPLACE FUNCTION gdpr_customer_key_hash(connector text, customer_id text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(connector || ':' || customer_id, 'UTF8')), 'hex')
$$;

-- An object restricted to the named keys and to SCALAR values (a key that arrives holding an object or array is dropped, so a nested field added upstream
-- cannot ride along); any non-object input yields {}. Structured fields are rebuilt by their own functions below.
CREATE OR REPLACE FUNCTION gdpr_keep_keys(src jsonb, keys text[]) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN src IS NULL OR jsonb_typeof(src) <> 'object' THEN '{}'::jsonb
    ELSE COALESCE((SELECT jsonb_object_agg(e.key, e.value) FROM jsonb_each(src) e WHERE e.key = ANY(keys) AND jsonb_typeof(e.value) NOT IN ('object', 'array')), '{}'::jsonb) END
$$;

-- Of the neutral replacements (an object), those whose key is present in src: a removed field keeps its TYPE so a replay does not trip over a missing key.
CREATE OR REPLACE FUNCTION gdpr_neutral_for_present(src jsonb, neutral jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE((SELECT jsonb_object_agg(e.key, e.value) FROM jsonb_each(neutral) e WHERE src ? e.key), '{}'::jsonb)
$$;

-- A scalar REBUILT from its own text: the value a validator accepted is returned as a NEW JSON value, never as the input node. (The projection SQL has no
-- pass-through of an input object, sub-object or remainder; tests/erasure-projection-no-passthrough.test.ts reads this file to keep it that way.)
CREATE OR REPLACE FUNCTION gdpr_rebuild_scalar(v jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE jsonb_typeof(v)
    WHEN 'number' THEN to_jsonb((v#>>'{}')::numeric)
    WHEN 'string' THEN to_jsonb(v#>>'{}')
    WHEN 'boolean' THEN to_jsonb((v#>>'{}')::boolean)
    ELSE 'null'::jsonb END
$$;

-- A single-token string (no whitespace, no '@', at most 60 characters) rebuilt, else ''.
CREATE OR REPLACE FUNCTION gdpr_token(v jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN v IS NOT NULL AND jsonb_typeof(v) = 'string' AND (v#>>'{}') ~ '^[^[:space:]@]{0,60}$' THEN to_jsonb(v#>>'{}') ELSE to_jsonb(''::text) END
$$;

-- A plain code string rebuilt, else the fallback text.
CREATE OR REPLACE FUNCTION gdpr_code_or(v jsonb, fallback text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN v IS NOT NULL AND jsonb_typeof(v) = 'string' AND (v#>>'{}') ~ '^[A-Za-z0-9_./-]{1,60}$' THEN to_jsonb(v#>>'{}') ELSE to_jsonb(fallback) END
$$;

-- A currency: three letters rebuilt; the empty string is a legitimate stated value (a missing currency is refused with that word); anything else 'unreadable'.
CREATE OR REPLACE FUNCTION gdpr_currency(v jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN v IS NOT NULL AND jsonb_typeof(v) = 'string' AND (v#>>'{}') ~ '^([A-Za-z]{3})?$' THEN to_jsonb(v#>>'{}') ELSE to_jsonb('unreadable'::text) END
$$;

-- A fixed label per credit kind (what the coupon classifier reads), else 'Fee'; never the original text.
CREATE OR REPLACE FUNCTION gdpr_credit_label(v jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT to_jsonb(CASE
    WHEN (v#>>'{}') ~* 'smart[_ -]?coupon' THEN 'Smart coupon'
    WHEN (v#>>'{}') ~* 'store[_ -]?credit' THEN 'Store credit'
    WHEN (v#>>'{}') ~* 'gift[_ -]?(card|cert)|giftcard' THEN 'Gift card'
    WHEN (v#>>'{}') ~* 'wallet' THEN 'Wallet'
    ELSE 'Fee' END)
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
    WHEN jsonb_typeof(v) = 'number' AND (v#>>'{}')::numeric >= 0 THEN gdpr_rebuild_scalar(v)
    WHEN jsonb_typeof(v) = 'string' AND (v#>>'{}') ~ '^\s*[0-9]+(\.[0-9]+)?\s*$' THEN gdpr_rebuild_scalar(v)
    WHEN jsonb_typeof(v) = 'string' AND allow_empty AND (v#>>'{}') = '' THEN gdpr_rebuild_scalar(v)
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
    WHEN 'number' THEN CASE WHEN v IS NOT NULL AND jsonb_typeof(v) = 'number' THEN gdpr_rebuild_scalar(v)
                            WHEN v IS NOT NULL AND jsonb_typeof(v) = 'string' AND (v#>>'{}') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' THEN gdpr_rebuild_scalar(v)
                            ELSE to_jsonb('unreadable'::text) END
    WHEN 'decimal' THEN CASE WHEN v IS NOT NULL AND jsonb_typeof(v) = 'number' AND (v#>>'{}')::numeric >= 0 THEN gdpr_rebuild_scalar(v)
                             WHEN v IS NOT NULL AND jsonb_typeof(v) = 'string' AND (v#>>'{}') ~ '^[0-9]+(\.[0-9]+)?$' THEN gdpr_rebuild_scalar(v)
                             ELSE to_jsonb('unreadable'::text) END
    WHEN 'flag' THEN CASE WHEN v IS NOT NULL AND jsonb_typeof(v) = 'boolean' THEN gdpr_rebuild_scalar(v)
                          WHEN v IS NOT NULL AND jsonb_typeof(v) = 'number' AND (v#>>'{}') IN ('0', '1') THEN gdpr_rebuild_scalar(v)
                          WHEN v IS NOT NULL AND jsonb_typeof(v) = 'string' AND lower(btrim(v#>>'{}')) IN ('1', '0', 'true', 'false', 'yes', 'no') THEN to_jsonb(lower(btrim(v#>>'{}')))
                          ELSE to_jsonb('other'::text) END
    WHEN 'wclc_kind' THEN to_jsonb(CASE WHEN v IS NOT NULL AND jsonb_typeof(v) = 'string' AND btrim(v#>>'{}') IN ('duty_flat', 'uhf', 'duty_fee') THEN btrim(v#>>'{}') ELSE 'other' END)
    WHEN 'invoice_number' THEN CASE WHEN v IS NOT NULL AND jsonb_typeof(v) IN ('string', 'number') AND (v#>>'{}') ~ '^(?=.*[0-9])[A-Za-z0-9_./#-]{1,40}$' THEN gdpr_rebuild_scalar(v) ELSE NULL END
    WHEN 'int' THEN CASE WHEN v IS NOT NULL AND jsonb_typeof(v) = 'number' AND (v#>>'{}') ~ '^[1-9][0-9]*$' THEN gdpr_rebuild_scalar(v)
                         WHEN v IS NOT NULL AND jsonb_typeof(v) = 'string' AND (v#>>'{}') ~ '^[1-9][0-9]*$' THEN gdpr_rebuild_scalar(v)
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

-- A readable (signed) number or numeric string stays; anything else is the fixed word 'unreadable'.
CREATE OR REPLACE FUNCTION gdpr_number_or_unreadable(v jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN v IS NOT NULL AND jsonb_typeof(v) = 'number' THEN gdpr_rebuild_scalar(v)
              WHEN v IS NOT NULL AND jsonb_typeof(v) = 'string' AND (v#>>'{}') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' THEN gdpr_rebuild_scalar(v)
              ELSE to_jsonb('unreadable'::text) END
$$;

-- Of `keys`, those present in src, each reduced to a number or 'unreadable'.
CREATE OR REPLACE FUNCTION gdpr_numeric_for_present(src jsonb, keys text[]) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE((SELECT jsonb_object_agg(k, gdpr_number_or_unreadable(src->k)) FROM unnest(keys) AS k WHERE src ? k), '{}'::jsonb)
$$;

-- TEXT SCALARS: a kept text field is a single token (no whitespace, no '@', at most 60 characters), else the empty string. A human label (the payment method
-- title, a shipping method title, a tax label) is replaced by the token its machine counterpart carries, never kept as free text.
CREATE OR REPLACE FUNCTION gdpr_token_for_present(src jsonb, keys text[]) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE((SELECT jsonb_object_agg(k, CASE WHEN jsonb_typeof(src->k) = 'string' AND (src->>k) ~ '^[^[:space:]@]{0,60}$' THEN gdpr_rebuild_scalar(src->k) ELSE to_jsonb(''::text) END)
                     FROM unnest(keys) AS k WHERE src ? k), '{}'::jsonb)
$$;

-- Dates: a plain date or date-time, else JSON null.
CREATE OR REPLACE FUNCTION gdpr_date_for_present(src jsonb, keys text[]) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE((SELECT jsonb_object_agg(k, CASE WHEN jsonb_typeof(src->k) = 'string' AND (src->>k) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9:.]{1,15})?(Z|[+-][0-9:]{2,5})?$' THEN gdpr_rebuild_scalar(src->k) ELSE 'null'::jsonb END)
                     FROM unnest(keys) AS k WHERE src ? k), '{}'::jsonb)
$$;

-- Flags: a JSON boolean, else false.
CREATE OR REPLACE FUNCTION gdpr_bool_for_present(src jsonb, keys text[]) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE((SELECT jsonb_object_agg(k, CASE WHEN jsonb_typeof(src->k) = 'boolean' THEN gdpr_rebuild_scalar(src->k) ELSE 'false'::jsonb END) FROM unnest(keys) AS k WHERE src ? k), '{}'::jsonb)
$$;

-- Free text KEPT by owner ruling (the refund reason): a string rebuilt, anything else (an object, an array, a number) is the empty string.
CREATE OR REPLACE FUNCTION gdpr_text_or_empty(v jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN v IS NOT NULL AND jsonb_typeof(v) = 'string' THEN to_jsonb(v#>>'{}') ELSE to_jsonb(''::text) END
$$;

-- A line's `taxes`: [{id, total, subtotal}] and nothing else (the importer reads taxes[].id as the storefront rate id). Not an array -> [].
CREATE OR REPLACE FUNCTION gdpr_project_taxes(arr jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN arr IS NULL OR jsonb_typeof(arr) <> 'array' THEN '[]'::jsonb ELSE COALESCE((
    SELECT jsonb_agg(
             CASE WHEN jsonb_typeof(t->'id') = 'number' THEN jsonb_build_object('id', t->'id') ELSE '{}'::jsonb END
             || gdpr_numeric_for_present(t, ARRAY['total', 'subtotal'])
             ORDER BY ord)
      FROM jsonb_array_elements(arr) WITH ORDINALITY AS x(t, ord)
     WHERE jsonb_typeof(t) = 'object'
  ), '[]'::jsonb) END
$$;

-- Each element of an array reduced to `keys`, plus a projected meta_data when with_meta; `only_keys` limits that meta (NULL = the allowlist).
-- name_mode says what becomes of the element's free-text `name` (a personalised item can carry a recipient's name): 'sku' = the SKU when it is a plain code
-- string (else 'Item'); the `sku` itself is kept only when it is a plain code string, else emptied,
-- 'fee' = a FIXED label per credit kind the coupon classifier reads (Smart coupon / Store credit / Gift card / Wallet; never the original text), else 'Fee'; anything else = no name.
-- parent_name is always dropped. Not an array -> [].
CREATE OR REPLACE FUNCTION gdpr_project_lines(arr jsonb, keys text[], with_meta boolean, only_keys text[], name_mode text DEFAULT 'none') RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN arr IS NULL OR jsonb_typeof(arr) <> 'array' THEN '[]'::jsonb ELSE COALESCE((
    SELECT jsonb_agg(gdpr_keep_keys(l, keys)
        || CASE WHEN l ? 'taxes' THEN jsonb_build_object('taxes', gdpr_project_taxes(l->'taxes')) ELSE '{}'::jsonb END
        || CASE WHEN l ? 'sku' THEN jsonb_build_object('sku', gdpr_code_or(l->'sku', '')) ELSE '{}'::jsonb END
        || gdpr_numeric_for_present(l, ARRAY['cogs_value', 'id', 'product_id', 'variation_id', 'quantity', 'price', 'subtotal', 'subtotal_tax', 'total', 'total_tax', 'refund_total', 'instance_id', 'tax_total', 'shipping_tax_total', 'discount', 'discount_tax', 'rate_id', 'rate_percent'])
        || gdpr_token_for_present(l, ARRAY['tax_class', 'tax_status', 'method_id', 'rate_code', 'global_unique_id'])
        || CASE WHEN l ? 'method_title' THEN jsonb_build_object('method_title', gdpr_token(l->'method_id')) ELSE '{}'::jsonb END
        || CASE WHEN l ? 'label' THEN jsonb_build_object('label', gdpr_token(l->'rate_code')) ELSE '{}'::jsonb END
        || gdpr_bool_for_present(l, ARRAY['compound'])
        || CASE WHEN l ? 'reason' THEN jsonb_build_object('reason', gdpr_text_or_empty(l->'reason')) ELSE '{}'::jsonb END
        || CASE WHEN with_meta AND l ? 'meta_data' THEN jsonb_build_object('meta_data', gdpr_project_meta(l->'meta_data', only_keys)) ELSE '{}'::jsonb END
        || CASE name_mode
             WHEN 'sku' THEN jsonb_build_object('name', gdpr_code_or(l->'sku', 'Item'))
             WHEN 'fee' THEN jsonb_build_object('name', gdpr_credit_label(l->'name'))
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
      || gdpr_token_for_present(l, ARRAY['code'])
      || gdpr_numeric_for_present(l, ARRAY['id', 'discount', 'discount_tax'])
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
    'country', CASE WHEN a IS NOT NULL AND jsonb_typeof(a) = 'object' AND jsonb_typeof(a->'country') = 'string' AND (a->>'country') ~ '^[A-Za-z]{2}$' THEN to_jsonb(a->>'country') ELSE to_jsonb(''::text) END,
    'email', '', 'phone', '')
$$;

CREATE OR REPLACE FUNCTION gdpr_project_wc_order(o jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN o IS NULL THEN NULL WHEN jsonb_typeof(o) <> 'object' THEN jsonb_build_object('_erasure_projected', true) ELSE
    gdpr_keep_keys(o, ARRAY['id', 'parent_id', 'number', 'status', 'currency', 'currency_symbol', 'version', 'created_via',
      'date_created', 'date_created_gmt', 'date_modified', 'date_modified_gmt', 'date_paid', 'date_paid_gmt', 'date_completed', 'date_completed_gmt',
      'prices_include_tax', 'discount_total', 'discount_tax', 'shipping_total', 'shipping_tax', 'cart_tax', 'total', 'total_tax',
      'payment_method', 'payment_method_title', 'needs_payment', 'needs_processing', 'is_editable'])
    || CASE WHEN o ? 'wpo_wcpdf_invoice_number' AND gdpr_project_meta_value('_wcpdf_invoice_number', o->'wpo_wcpdf_invoice_number') IS NOT NULL
            THEN jsonb_build_object('wpo_wcpdf_invoice_number', gdpr_project_meta_value('_wcpdf_invoice_number', o->'wpo_wcpdf_invoice_number')) ELSE '{}'::jsonb END
    || gdpr_numeric_for_present(o, ARRAY['store_credit_used', 'id', 'parent_id', 'discount_total', 'discount_tax', 'shipping_total', 'shipping_tax', 'cart_tax', 'total', 'total_tax'])
    || gdpr_token_for_present(o, ARRAY['number', 'status', 'version', 'created_via', 'payment_method', 'currency_symbol'])
    || CASE WHEN o ? 'payment_method_title' THEN jsonb_build_object('payment_method_title', gdpr_token(o->'payment_method')) ELSE '{}'::jsonb END
    || gdpr_date_for_present(o, ARRAY['date_created', 'date_created_gmt', 'date_modified', 'date_modified_gmt', 'date_paid', 'date_paid_gmt', 'date_completed', 'date_completed_gmt'])
    || gdpr_bool_for_present(o, ARRAY['prices_include_tax', 'needs_payment', 'needs_processing', 'is_editable'])
    || CASE WHEN o ? 'currency' THEN jsonb_build_object('currency', gdpr_currency(o->'currency')) ELSE '{}'::jsonb END
    || gdpr_neutral_for_present(o, jsonb_build_object('customer_id', 0, 'customer_note', '', 'customer_ip_address', '', 'customer_user_agent', '', 'order_key', '', 'payment_url', '', 'cart_hash', '', 'transaction_id', '0'))
    || jsonb_build_object('billing', gdpr_empty_address(o->'billing'), 'shipping', gdpr_empty_address(o->'shipping'))
    || jsonb_build_object('meta_data', gdpr_project_meta(o->'meta_data', NULL))
    || jsonb_build_object('line_items', gdpr_project_lines(o->'line_items',
         ARRAY['id', 'product_id', 'variation_id', 'sku', 'global_unique_id', 'quantity', 'price', 'subtotal', 'subtotal_tax', 'total', 'total_tax', 'tax_class', 'taxes', 'cogs_value'], true, NULL, 'sku'))
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
  SELECT CASE WHEN r IS NULL THEN NULL WHEN jsonb_typeof(r) <> 'object' THEN jsonb_build_object('_erasure_projected', true) ELSE
    gdpr_keep_keys(r, ARRAY['id', 'parent_id', 'order_id', 'date_created', 'date_created_gmt', 'amount', 'reason', 'refunded_payment'])
    || gdpr_neutral_for_present(r, jsonb_build_object('refunded_by', 0))
    || gdpr_numeric_for_present(r, ARRAY['id', 'parent_id', 'order_id', 'amount'])
    || gdpr_date_for_present(r, ARRAY['date_created', 'date_created_gmt'])
    || gdpr_bool_for_present(r, ARRAY['refunded_payment'])
    || CASE WHEN r ? 'reason' THEN jsonb_build_object('reason', gdpr_text_or_empty(r->'reason')) ELSE '{}'::jsonb END
    || jsonb_build_object('meta_data', '[]'::jsonb)
    || jsonb_build_object('line_items', gdpr_project_lines(r->'line_items',
         ARRAY['id', 'product_id', 'variation_id', 'quantity', 'tax_class', 'subtotal', 'subtotal_tax', 'total', 'total_tax', 'taxes', 'sku', 'refund_total'], true, ARRAY['_refunded_item_id'], 'sku'))
    || CASE WHEN r ? 'shipping_lines' THEN jsonb_build_object('shipping_lines', gdpr_project_lines(r->'shipping_lines', ARRAY['id', 'method_id', 'method_title', 'total', 'total_tax', 'taxes'], false, NULL)) ELSE '{}'::jsonb END
    || jsonb_build_object('_erasure_projected', true)
  END
$$;

-- THE FAMILY OF A SYNC-LOG ROW, from the columns the writers stamp (recordKind, direction); the one declared mapping, pinned by a test against
-- lib/domain/sales/wc-sync-row-families.ts. The payload's own shape is never trusted to say which writer wrote it (a refund body can carry any field).
CREATE OR REPLACE FUNCTION gdpr_sync_log_family(l "shopping_sync_logs") RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN l."recordKind" = 'WC_HELD_SALES_INVOICE' THEN 'held_invoice'
    WHEN l."recordKind" = 'WC_REFUND_PARK' THEN 'refund_park'
    WHEN l."recordKind" IS NULL AND l."direction"::text = 'TO_CONNECTOR' THEN 'outbound'
    WHEN l."recordKind" IS NULL THEN 'inbound'
    ELSE 'unknown' END
$$;

-- A sync-log payload, projected by its FAMILY. FAIL CLOSED: a payload the family does not recognise is replaced by an identity-free stub, so "payload IS
-- DISTINCT FROM projection" is TRUE for it until it has been stubbed (the recheck cannot call an unrecognised row clean).
--   held_invoice  unchanged (the erasure's contact-block step owns it)
--   refund_park   the refund projection, whatever fields the body carries
--   outbound      a tracking log (items emptied) or a status push (status and push time only); anything else is stubbed
--   inbound       the queue envelope (its order projected) or an admission refusal (IMS-written ids and counters only); anything else is stubbed
-- A NULL payload stays NULL.
CREATE OR REPLACE FUNCTION gdpr_project_sync_log_payload(p jsonb, family text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p IS NULL THEN NULL
    WHEN jsonb_typeof(p) <> 'object' THEN jsonb_build_object('_erasure_projected', true)
    -- the ONE deliberate pass-through, pinned by tests/erasure-projection-no-passthrough.test.ts: the erasure's contact-block step owns this family
    WHEN family = 'held_invoice' THEN p
    WHEN family = 'refund_park' THEN gdpr_project_wc_refund(p)
    -- outbound: a tracking log, or a status push; each REBUILT from its typed fields
    WHEN family = 'outbound' AND p->>'meta_key' = '_wc_shipment_tracking_items' THEN
      jsonb_build_object('meta_key', '_wc_shipment_tracking_items', 'items', '[]'::jsonb, '_erasure_projected', true) || gdpr_date_for_present(p, ARRAY['pushedDateModifiedGmt'])
    WHEN family = 'outbound' AND p ? 'status' THEN
      gdpr_token_for_present(p, ARRAY['status']) || gdpr_date_for_present(p, ARRAY['pushedDateModifiedGmt']) || jsonb_build_object('_erasure_projected', true)
    -- inbound: the pending-FX queue envelope, or an admission refusal; each REBUILT from its typed fields
    WHEN family = 'inbound' AND p ? 'order' AND p ? 'externalOrderId' THEN
      gdpr_token_for_present(p, ARRAY['reason', 'connector', 'externalOrderId', 'externalOrderNumber', 'receiptPaymentId'])
      || jsonb_build_object('currency', gdpr_currency(p->'currency'))
      || gdpr_date_for_present(p, ARRAY['asOf'])
      || jsonb_build_object('order', gdpr_project_wc_order(p->'order'))
      || CASE WHEN jsonb_typeof(p->'paidBlock') = 'object' THEN jsonb_build_object('paidBlock',
           gdpr_token_for_present(p->'paidBlock', ARRAY['kind']) || gdpr_numeric_for_present(p->'paidBlock', ARRAY['attempts']) || gdpr_date_for_present(p->'paidBlock', ARRAY['firstAt'])) ELSE '{}'::jsonb END
      || jsonb_build_object('_erasure_projected', true)
    WHEN family = 'inbound' AND p ? 'queue' THEN
      gdpr_token_for_present(p, ARRAY['queue', 'reason', 'connector', 'externalOrderId', 'externalOrderNumber', 'status'])
      || jsonb_build_object('currency', gdpr_currency(p->'currency'))
      || gdpr_date_for_present(p, ARRAY['refusedAt'])
      || gdpr_numeric_for_present(p, ARRAY['attempts'])
      || jsonb_build_object('configured', CASE WHEN jsonb_typeof(p->'configured') = 'array' THEN COALESCE((SELECT jsonb_agg(gdpr_token(c.v) ORDER BY c.ord) FROM jsonb_array_elements(p->'configured') WITH ORDINALITY AS c(v, ord)), '[]'::jsonb) ELSE '[]'::jsonb END)
      || jsonb_build_object('_erasure_projected', true)
    ELSE jsonb_build_object('_erasure_projected', true)
  END
$$;

-- The projected payload of a row: the family comes from the row's own columns.
CREATE OR REPLACE FUNCTION gdpr_sync_log_row_projection(l "shopping_sync_logs") RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT gdpr_project_sync_log_payload(l."payload", gdpr_sync_log_family(l))
$$;

-- The webhook inbox payload, by resource. Anything else, or a payload with no order id, comes back unchanged.
CREATE OR REPLACE FUNCTION gdpr_project_webhook_payload(p jsonb, resource text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p IS NULL THEN NULL
    WHEN jsonb_typeof(p) = 'object' AND p = '{}'::jsonb THEN '{}'::jsonb
    WHEN jsonb_typeof(p) = 'object' AND resource = 'orders' AND p ? 'id' THEN gdpr_project_wc_order(p)
    WHEN jsonb_typeof(p) = 'object' AND resource = 'refunds' AND p ? 'id' THEN gdpr_project_wc_refund(p)
    ELSE jsonb_build_object('_erasure_projected', true)
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

-- A timestamp from the storefront's GMT date string, or NULL when it does not read as one.
CREATE OR REPLACE FUNCTION gdpr_safe_timestamp(t text) RETURNS timestamp LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF t IS NULL OR t !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}' THEN RETURN NULL; END IF;
  RETURN substr(t, 1, 19)::timestamp;
EXCEPTION WHEN others THEN
  RETURN NULL;
END
$$;

-- Whether a delivery's order belongs to an ERASED storefront account: its customer id hashes to a tombstone AND the order was created at or before the
-- erasure (a missing or unreadable date counts as before: the safe side). An order created AFTER the erasure is new data from a still-existing account.
CREATE OR REPLACE FUNCTION gdpr_payload_customer_tombstoned(p jsonb) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE(p IS NOT NULL AND jsonb_typeof(p) = 'object' AND (p->>'customer_id') ~ '^[1-9][0-9]*$' AND EXISTS (
    SELECT 1 FROM "storefront_customer_erasure_tombstones" t
     WHERE t."connector" = 'woocommerce' AND t."customerKeyHash" = gdpr_customer_key_hash('woocommerce', p->>'customer_id')
       AND (gdpr_safe_timestamp(p->>'date_created_gmt') IS NULL OR gdpr_safe_timestamp(p->>'date_created_gmt') <= t."erasedAt")), false)
$$;

-- Records an open erasure obligation for a storefront order IMS does not hold (idempotent; re-opens a retired one). A held order, or an id that is not
-- a number, records nothing. Returns whether one is now open.
CREATE OR REPLACE FUNCTION gdpr_record_order_obligation(external_order_id text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  IF external_order_id IS NULL OR external_order_id !~ '^[0-9]+$' THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM "shopping_order_links" l WHERE l."connector" = 'woocommerce' AND l."externalOrderId" = external_order_id) THEN RETURN false; END IF;
  INSERT INTO "storefront_order_erasure_obligations" ("connector", "externalOrderId") VALUES ('woocommerce', external_order_id)
    ON CONFLICT ("connector", "externalOrderId") DO UPDATE SET "retiredAt" = NULL;
  RETURN true;
END
$$;

CREATE OR REPLACE FUNCTION erased_wc_webhook_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  marker CONSTANT text := 'Text removed by GDPR erasure';
  k text;
BEGIN
  IF NEW."connector" <> 'woocommerce' OR NEW."resource" NOT IN ('orders', 'refunds') THEN RETURN NEW; END IF;
  k := gdpr_webhook_order_key(NEW."payloadJson", NEW."resource");
  IF k IS NULL THEN RETURN NEW; END IF;
  IF NOT gdpr_storefront_order_erased(k) THEN
    -- an order of an erased storefront ACCOUNT that IMS does not hold: project it and open an order obligation, so a later import creates it erased
    IF NEW."resource" = 'orders' AND gdpr_payload_customer_tombstoned(NEW."payloadJson") THEN
      PERFORM gdpr_record_order_obligation(k);
    ELSE
      RETURN NEW;
    END IF;
  END IF;
  NEW."payloadJson" := gdpr_project_webhook_payload(NEW."payloadJson", NEW."resource");
  IF NEW."lastError" IS NOT NULL AND NEW."lastError" <> marker THEN NEW."lastError" := marker; END IF;
  RETURN NEW;
END
$$;

-- Whether a sync-log row belongs to an ERASED order: an imported order by its id, or, with no entityId (the pending-FX queue, an admission refusal, a failed import: all keyed by the storefront order id alone), by that id. A row WITH an entityId is never matched by externalId, which is one number space with refund ids.
CREATE OR REPLACE FUNCTION gdpr_sync_log_row_erased(l "shopping_sync_logs") RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT l."connector" = 'woocommerce' AND l."entityType" IN ('SalesOrder', 'ORDER') AND (
    (l."entityId" IS NOT NULL AND gdpr_order_id_erased(l."entityId"))
    OR (l."entityId" IS NULL AND l."entityType" = 'SalesOrder' AND gdpr_storefront_order_erased(l."externalId"))
    OR (l."entityId" IS NULL AND l."entityType" = 'SalesOrder' AND l."payload" IS NOT NULL AND jsonb_typeof(l."payload") = 'object' AND gdpr_payload_customer_tombstoned(l."payload"->'order')))
$$;

-- The error text the erasure leaves: the marker, except on a held-invoice park, whose text is a fixed IMS sentence naming an order number.
CREATE OR REPLACE FUNCTION gdpr_sync_log_row_message(l "shopping_sync_logs") RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN l."errorMessage" IS NULL OR gdpr_sync_log_family(l) = 'held_invoice' THEN l."errorMessage" ELSE 'Text removed by GDPR erasure' END
$$;

-- Whether the row still carries raw identity (a payload the projection would change, or error text that is not yet the marker).
CREATE OR REPLACE FUNCTION gdpr_sync_log_row_dirty(l "shopping_sync_logs") RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT (l."payload" IS DISTINCT FROM gdpr_sync_log_row_projection(l)) OR (l."errorMessage" IS DISTINCT FROM gdpr_sync_log_row_message(l))
$$;

CREATE OR REPLACE FUNCTION erased_wc_sync_log_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."connector" <> 'woocommerce' OR NOT gdpr_sync_log_row_erased(NEW) THEN RETURN NEW; END IF;
  IF NEW."entityId" IS NULL AND NEW."payload" IS NOT NULL AND jsonb_typeof(NEW."payload") = 'object' AND gdpr_payload_customer_tombstoned(NEW."payload"->'order') THEN
    PERFORM gdpr_record_order_obligation(NEW."externalId");
  END IF;
  NEW."errorMessage" := gdpr_sync_log_row_message(NEW);
  NEW."payload" := gdpr_sync_log_row_projection(NEW);
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
-- A return_inbox event's before / after JSON REBUILT from its typed fields: the free-text values become the marker (or null where they were null), the
-- structured ones (sku, reference, status, warehouse id as tokens; quantity as a number; the two match flags as booleans) are typed, and every other key is dropped.
CREATE OR REPLACE FUNCTION gdpr_project_return_event(j jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN j IS NULL THEN NULL
    WHEN jsonb_typeof(j) <> 'object' THEN jsonb_build_object('_erasure_projected', true)
    ELSE gdpr_token_for_present(j, ARRAY['sku', 'reference', 'status', 'warehouseId'])
      || gdpr_numeric_for_present(j, ARRAY['qty'])
      || gdpr_bool_for_present(j, ARRAY['orderMatched', 'productMatched'])
      || COALESCE((SELECT jsonb_object_agg(k, CASE WHEN jsonb_typeof(j->k) = 'null' THEN 'null'::jsonb ELSE to_jsonb('Text removed by GDPR erasure'::text) END)
                     FROM unnest(ARRAY['reason', 'resolutionNote']) AS k WHERE j ? k), '{}'::jsonb)
  END
$$;

CREATE OR REPLACE FUNCTION erased_return_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."entityType" <> 'RETURN' OR NEW."action" <> 'return_inbox' THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM "wms_returns_inbox" r WHERE r."id" = NEW."entityId" AND r."erasedAt" IS NOT NULL) THEN RETURN NEW; END IF;
  NEW."before" := gdpr_project_return_event(NEW."before");
  NEW."after" := gdpr_project_return_event(NEW."after");
  RETURN NEW;
END
$$;

CREATE TRIGGER wms_mutation_events_erased_return BEFORE INSERT OR UPDATE OF "before", "after" ON "wms_mutation_events"
  FOR EACH ROW EXECUTE FUNCTION erased_return_event_guard();
