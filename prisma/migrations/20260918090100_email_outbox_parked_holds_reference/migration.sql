-- o3d-hpeg — A PARKED ROW STILL HOLDS ITS (kind, referenceType, referenceId) SLOT.
--
-- `email_outbox_undelivered_reference_uq` (migration 20260910120000_email_outbox_claim_fence) refuses a
-- second row for one logical email while the first is undelivered, and `queueEmail` answers that
-- refusal with `already_queued`. A row parked at the send cap has ALREADY entered the sender twice and
-- nothing in the table says whether either copy reached the customer; if parking took it out of the
-- index, the next enqueue for the same reference - an accounting sync retry re-running the invoice-email
-- effect, say - would insert a fresh row and send the email AGAIN, which is the very repetition the cap
-- exists to stop. So PARKED_SEND_CAP joins the index's predicate: while a row is parked, a new row for
-- the same reference is refused exactly as it is while the first is PENDING or PROCESSING, and only an
-- operator's release or cancel lets the reference move on.
--
-- Same name, same columns, same NULL exclusions; only the status list grows. No row can be PARKED yet
-- (the value was added by the previous migration and nothing has written it), so rebuilding the index
-- cannot meet a duplicate the old predicate had not already refused.
BEGIN;

LOCK TABLE "email_outbox" IN ACCESS EXCLUSIVE MODE;

DROP INDEX IF EXISTS "email_outbox_undelivered_reference_uq";

CREATE UNIQUE INDEX "email_outbox_undelivered_reference_uq"
ON "email_outbox" (kind, "referenceType", "referenceId")
WHERE status IN ('PENDING', 'PROCESSING', 'PARKED_SEND_CAP')
  AND "referenceType" IS NOT NULL
  AND "referenceId" IS NOT NULL;

COMMIT;
