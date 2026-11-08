-- Erasure of the DERIVED accounting copies and notification text, in the database.
--
-- The ledger contact block is copied into accounting_events.linesJson (the whole document payload) and, when a payload changes, the superseded body is
-- kept in accounting_event_logs.metadata.enqueuedLinesJson. An accounting sync row's errorMessage can echo a contact name read back out of the ledger
-- (a THIRD PARTY's name) or the order's own. A notification's text can name the person.
--
-- There is ONE implementation of each rule, here: the erasure UPDATEs (lib/domain/erasure/derived-copies.ts) and the guard triggers below call the same
-- functions. The contact rule matches the sync-log payload rule (erase-personal-data.ts scrubAccountingPayloadContacts): the email is always removed; the
-- NAME is kept only where the copy describes a document that may be in the ledger (a posted document is a retained record) and is replaced by the
-- placeholder otherwise. An event is judged on its OWN posting evidence: status POSTED (mirroredPostStanding is not NOT_POSTED), or a document id, a revision stamp or a post basis.
-- The contact block is rebuilt as { name } only, so no other key rides along.
--
-- ADDITIVE ONLY: functions and triggers, no table or column change, no backfill (the erasure and its reconcile pass clear existing rows).
-- A row INSERTED while an erasure is still uncommitted is the one case a trigger cannot see; the reconcile pass in the email cron clears it.

-- Whether the sales order or refund an accounting row is about is erased (the order, or its customer).
CREATE OR REPLACE FUNCTION gdpr_accounting_ref_erased(ref_type text, ref_id text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT CASE ref_type
    WHEN 'SalesOrder' THEN gdpr_order_id_erased(ref_id)
    WHEN 'SalesOrderRefund' THEN COALESCE((SELECT gdpr_order_id_erased(r."orderId") FROM "sales_order_refunds" r WHERE r."id" = ref_id), false)
    ELSE false
  END
$$;

-- The contact block of an accounting document payload with the email removed and the name kept or replaced. Anything that is not an object with a contact object is returned unchanged.
CREATE OR REPLACE FUNCTION gdpr_scrub_contact(doc jsonb, keep_name boolean) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN doc IS NULL OR jsonb_typeof(doc) <> 'object' OR jsonb_typeof(doc -> 'contact') <> 'object' THEN doc
    WHEN keep_name AND jsonb_typeof(doc #> '{contact,name}') = 'string' THEN jsonb_set(doc, '{contact}', jsonb_build_object('name', doc #> '{contact,name}'))
    ELSE jsonb_set(doc, '{contact}', jsonb_build_object('name', to_jsonb('GDPR Anonymised'::text)))
  END
$$;

-- Whether the contact block of an accounting document payload still carries identity the rule would remove or replace.
CREATE OR REPLACE FUNCTION gdpr_contact_dirty(doc jsonb, keep_name boolean) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT doc IS DISTINCT FROM gdpr_scrub_contact(doc, keep_name)
$$;

-- Whether an accounting event may describe a document that reached the ledger (its own evidence; see the header). SUPERSEDED ALONE IS NOT EVIDENCE: the mirror records
-- SUPERSEDED for a replay that made no connector write and took no claim. A superseded event that really posted keeps its document id or revision stamp.
-- Pinned to lib/domain/erasure/derived-copies.ts eventKeepsContactName (and so to mirroredPostStanding) by tests/concurrency/erasure-derived-copies.
CREATE OR REPLACE FUNCTION gdpr_event_keeps_contact_name(e "accounting_events") RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT e."status" = 'POSTED' OR e."externalId" IS NOT NULL OR e."externalRevisionAt" IS NOT NULL OR e."postBasis" IS NOT NULL
      -- Every revisionOrderBasis the mirror writes for a connector write that happened: a live write that returned no stamp, and a backfill repair of a write the sync log recorded complete.
      -- A later revision taking the document id leaves such an event SUPERSEDED with externalId and postBasis cleared; the basis is what still says it posted.
      OR COALESCE(e."revisionOrderBasis" IN ('live_write_unstamped', 'historical_backfill_repair'), false)
$$;

CREATE OR REPLACE FUNCTION erased_accounting_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  keep boolean;
BEGIN
  IF jsonb_typeof(NEW."linesJson" -> 'contact') = 'object'
     AND gdpr_accounting_ref_erased(NEW."sourceEntityType", NEW."sourceEntityId") THEN
    keep := gdpr_event_keeps_contact_name(NEW);
    -- A name that was replaced by the placeholder never comes back: a later write (the event turning POSTED, a rebuilt payload) cannot restore it.
    IF TG_OP = 'UPDATE' AND (OLD."linesJson" #>> '{contact,name}') = 'GDPR Anonymised' THEN keep := false; END IF;
    NEW."linesJson" := gdpr_scrub_contact(NEW."linesJson", keep);
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER accounting_events_erased_contact BEFORE INSERT OR UPDATE ON "accounting_events"
  FOR EACH ROW EXECUTE FUNCTION erased_accounting_event_guard();

-- The superseded body kept on an event log is a copy of an earlier linesJson of the SAME event: it follows the event's rule. The log's MESSAGE is free text (a final
-- failure writes the raw connector error into it, which can echo the customer's or a third party's name): for an erased order it is the fixed marker.
CREATE OR REPLACE FUNCTION erased_accounting_event_log_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ev "accounting_events";
  has_body boolean := NEW."metadata" IS NOT NULL AND jsonb_typeof(NEW."metadata" -> 'enqueuedLinesJson') = 'object';
  has_message boolean := NEW."message" IS NOT NULL AND NEW."message" <> 'Text removed by GDPR erasure';
BEGIN
  IF NOT has_body AND NOT has_message THEN RETURN NEW; END IF;
  SELECT * INTO ev FROM "accounting_events" WHERE "id" = NEW."accountingEventId";
  IF FOUND AND gdpr_accounting_ref_erased(ev."sourceEntityType", ev."sourceEntityId") THEN
    IF has_body THEN
      NEW."metadata" := jsonb_set(NEW."metadata", '{enqueuedLinesJson}', gdpr_scrub_contact(NEW."metadata" -> 'enqueuedLinesJson', gdpr_event_keeps_contact_name(ev)));
    END IF;
    IF has_message THEN NEW."message" := 'Text removed by GDPR erasure'; END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER accounting_event_logs_erased_contact BEFORE INSERT OR UPDATE OF "message", "metadata" ON "accounting_event_logs"
  FOR EACH ROW EXECUTE FUNCTION erased_accounting_event_log_guard();

-- An accounting sync row's error text for an erased order or refund is the fixed erasure marker. No reader branches on the text (it carries no provenance).
CREATE OR REPLACE FUNCTION erased_accounting_sync_log_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."errorMessage" IS NOT NULL AND NEW."errorMessage" <> 'Text removed by GDPR erasure'
     AND gdpr_accounting_ref_erased(NEW."referenceType", NEW."referenceId") THEN
    NEW."errorMessage" := 'Text removed by GDPR erasure';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER accounting_sync_logs_erased_error BEFORE INSERT OR UPDATE OF "errorMessage" ON "accounting_sync_logs"
  FOR EACH ROW EXECUTE FUNCTION erased_accounting_sync_log_guard();

-- A notification that points at an erased order carries the fixed text, whoever writes it (the erasure uses the same words for the rows that already exist).
CREATE OR REPLACE FUNCTION erased_notification_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  oid text;
BEGIN
  IF NEW."actionUrl" IS NULL THEN RETURN NEW; END IF;
  oid := substring(NEW."actionUrl" from '^/sales/([^/?#]+)');
  IF oid IS NOT NULL AND gdpr_order_id_erased(oid) THEN
    NEW."title" := 'Notification redacted';
    NEW."message" := 'The text of this notification was removed by a personal-data erasure.';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER notifications_erased_order_text BEFORE INSERT OR UPDATE OF "title", "message", "actionUrl" ON "notifications"
  FOR EACH ROW EXECUTE FUNCTION erased_notification_guard();
