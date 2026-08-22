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
-- (the signed body's `_links.self`/`permalink`, or `X-WC-Webhook-Source`). A version number
-- computed on our side records when WE saw the delivery, not which store sent it, so a delivery
-- in flight across the rebind gets stamped with the new version and passes; the store's own
-- identity does not move.
--
-- It cannot live in payloadJson: idempotency is the sha256 of the exact signed body, and stamping
-- anything into the payload would break redelivery dedupe.
--
-- NOT NULL, with the pre-existing rows BACKFILLED to an explicit 'unproven:pre-attestation'
-- marker. A nullable column would leave one value meaning both "written before this column
-- existed" and "written by current code, which found nothing" — the o3d-t74p leniency, where a
-- NULL that was never examined reads as "fine".
ALTER TABLE "shopping_webhook_events"
  ADD COLUMN "originAttestation" TEXT NOT NULL DEFAULT 'unproven:pre-attestation';

-- THE DEFAULT STAYS. Dropping it was the whole of finding 1, and the reason is the deploy
-- window rather than anything about the column's meaning.
--
-- Migrations run against the live database BEFORE the new build replaces the old one, and the
-- old build is still accepting webhooks throughout. Its INSERT names no `originAttestation` —
-- it cannot, the column did not exist when it was compiled — so with no default that INSERT
-- fails the NOT NULL constraint. Every WooCommerce delivery during the deploy would 500;
-- WooCommerce retries a handful of times and then DISABLES the webhook at the store end, which
-- an operator has to notice and re-enable by hand. A column added to make a rebind safe would
-- have cost the store its webhooks on every ordinary release.
--
-- What the default must NOT do is make such a row indistinguishable from a row current code
-- wrote. So the value it defaults to from here on is a DIFFERENT marker from the backfill:
--
--   'unproven:pre-attestation'  the row predates the column entirely (backfilled above)
--   'unproven:legacy-writer'    the column existed and the INSERT named nothing — only the
--                               pre-deploy build can produce this, and only during the window
--
-- Every current writer states a value explicitly (createEvent supplies one on every path), so
-- the default is never what a modern INSERT lands on. It is a trap for exactly one writer, and
-- a row that springs it says so. Both markers are `unproven:*`, so neither is ever mistaken for
-- a proven origin by lib/connectors/webhook-origin.ts.
ALTER TABLE "shopping_webhook_events"
  ALTER COLUMN "originAttestation" SET DEFAULT 'unproven:legacy-writer';
