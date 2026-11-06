-- Erased-order free-text guard: no free-text error / note / reason column of a row that belongs to an ERASED order or customer can hold anything but the fixed erasure marker.
--
-- WHY IN THE DATABASE. The erasure clears these columns once; but many writers (warehouse and storefront sweeps, operator actions, outer catch blocks that run
-- without the order lock) keep writing exception text and notes into them afterwards, and that text can echo the person's name or address. One guard on the column
-- closes every present and future writer at once. A write for an order that is not erased is untouched.
--
-- ADDITIVE ONLY: functions and triggers, no table or column change, no backfill (the erasure and its reconcile pass clear existing rows).
--
-- A row INSERTED while an erasure is still uncommitted is the one case a trigger cannot see (the marker is not yet committed); the reconcile pass in the
-- email cron clears it on its next run.

CREATE OR REPLACE FUNCTION erased_order_free_text_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  marker CONSTANT text := 'Text removed by GDPR erasure';
  v jsonb;
  col text;
  erased boolean;
  oid text;
  changed boolean := false;
  i integer;
BEGIN
  -- TG_ARGV[0] names the column holding the order id; the rest name the guarded columns ('json:<name>' for a JSON column, cleared to {}).
  oid := to_jsonb(NEW) ->> TG_ARGV[0];
  IF oid IS NULL THEN RETURN NEW; END IF;
  SELECT (o."erasedAt" IS NOT NULL OR c."gdprAnonymisedAt" IS NOT NULL) INTO erased
    FROM "sales_orders" o LEFT JOIN "customers" c ON c."id" = o."customerId"
   WHERE o."id" = oid;
  IF NOT COALESCE(erased, false) THEN RETURN NEW; END IF;
  v := to_jsonb(NEW);
  FOR i IN 1 .. COALESCE(array_length(TG_ARGV, 1), 1) - 1 LOOP
    col := TG_ARGV[i];
    IF left(col, 5) = 'json:' THEN
      col := substr(col, 6);
      IF v -> col IS NOT NULL AND v -> col <> 'null'::jsonb AND v -> col <> '{}'::jsonb THEN
        v := jsonb_set(v, ARRAY[col], '{}'::jsonb);
        changed := true;
      END IF;
    ELSIF (v ->> col) IS NOT NULL AND (v ->> col) <> marker THEN
      v := jsonb_set(v, ARRAY[col], to_jsonb(marker));
      changed := true;
    END IF;
  END LOOP;
  IF changed THEN NEW := jsonb_populate_record(NEW, v); END IF;
  RETURN NEW;
END
$$;

-- The payment note guard keeps the importer's three exact receipt sentences (the importer recognises its receipts by them) and clears every other note.
CREATE OR REPLACE FUNCTION erased_order_payment_note_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  erased boolean;
BEGIN
  IF NEW."notes" IS NULL THEN RETURN NEW; END IF;
  IF NEW."notes" IN (
    'Recorded from WooCommerce (paid later than the import): the part of the order total not already covered by earlier receipts',
    'Recorded from WooCommerce (the order was imported unpaid and paid later)',
    'Imported from WooCommerce (paid when the order was imported)'
  ) THEN RETURN NEW; END IF;
  SELECT (o."erasedAt" IS NOT NULL OR c."gdprAnonymisedAt" IS NOT NULL) INTO erased
    FROM "sales_orders" o LEFT JOIN "customers" c ON c."id" = o."customerId"
   WHERE o."id" = NEW."orderId";
  IF COALESCE(erased, false) THEN NEW."notes" := NULL; END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER wms_order_status_snapshots_erased_free_text BEFORE INSERT OR UPDATE OF "lastError" ON "wms_order_status_snapshots"
  FOR EACH ROW EXECUTE FUNCTION erased_order_free_text_guard('orderId', 'lastError');
CREATE TRIGGER wms_order_push_links_erased_free_text BEFORE INSERT OR UPDATE OF "lastError", "dispatchLastError", "dispatchUnresolvedError" ON "wms_order_push_links"
  FOR EACH ROW EXECUTE FUNCTION erased_order_free_text_guard('orderId', 'lastError', 'dispatchLastError', 'dispatchUnresolvedError');
CREATE TRIGGER wms_order_discrepancies_erased_free_text BEFORE INSERT OR UPDATE OF "detail" ON "wms_order_discrepancies"
  FOR EACH ROW EXECUTE FUNCTION erased_order_free_text_guard('orderId', 'detail');
CREATE TRIGGER wms_returns_inbox_erased_free_text BEFORE INSERT OR UPDATE OF "reason", "resolutionNote", "rawPayload" ON "wms_returns_inbox"
  FOR EACH ROW EXECUTE FUNCTION erased_order_free_text_guard('orderId', 'reason', 'resolutionNote', 'json:rawPayload');
CREATE TRIGGER sales_order_refunds_erased_free_text BEFORE INSERT OR UPDATE OF "accounting_warning" ON "sales_order_refunds"
  FOR EACH ROW EXECUTE FUNCTION erased_order_free_text_guard('orderId', 'accounting_warning');
CREATE TRIGGER payments_erased_note BEFORE INSERT OR UPDATE OF "notes" ON "payments"
  FOR EACH ROW EXECUTE FUNCTION erased_order_payment_note_guard();
