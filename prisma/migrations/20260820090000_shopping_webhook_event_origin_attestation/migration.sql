-- o3d-wgl6: a WooCommerce webhook RETRIED after a credential rebind still carries the previous
-- store's payload.
--
-- o3d-mlc7 fenced the product import against a rebind by snapshotting the credentials and
-- `wc_settings_version` together before any remote read and re-checking the version inside the
-- write transaction. That fence cannot see this case. A delivery from store A sits in the
-- shopping_webhook_events inbox; the operator rebinds to store B; the inbox retries. The payload
-- is store-A data, but every version the import observes is a consistent store-B, so the fence
-- sees nothing wrong and writes store-A ids under store-B credentials.
--
-- What is recorded here is the store's OWN statement of its identity, taken from the delivery
-- (`X-WC-Webhook-Source`, or the payload's self URL). A version number computed on our side
-- records when WE saw the delivery, not which store sent it, so a delivery in flight across the
-- rebind gets stamped with the new version and passes; the store's own identity does not move.
--
-- It cannot live in payloadJson: idempotency is the sha256 of the exact signed body, and stamping
-- anything into the payload would break redelivery dedupe.
--
-- NOT NULL, with the pre-existing rows BACKFILLED to an explicit 'unproven:pre-attestation'
-- marker and the default then dropped. A nullable column would leave one value meaning both
-- "written before this column existed" and "written by current code, which found nothing" — the
-- o3d-t74p leniency, where a NULL that was never examined reads as "fine". Dropping the default
-- means every row inserted from now on has to state positively what its era found.
ALTER TABLE "shopping_webhook_events"
  ADD COLUMN "originAttestation" TEXT NOT NULL DEFAULT 'unproven:pre-attestation';

ALTER TABLE "shopping_webhook_events"
  ALTER COLUMN "originAttestation" DROP DEFAULT;
