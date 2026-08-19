-- o3d-9tbz Codex r7: a RELEASE RECEIPT that cannot outlive the state it was written for.
--
-- Round 6 closed the deleted-pin bypass and gave the documented Demo-reset recovery a legitimate
-- escape: `provision-xero-demo.ts --clear-tenant-pin` deletes the pin and stamps `pinReleasedAt` in
-- one transaction, and a token row carrying that stamp is exempt from the halt.
--
-- WHAT WAS STILL WRONG. `pinReleasedAt` is a bare timestamp. It records THAT a release happened,
-- never WHAT was released, so it is exempt-by-presence and nothing about a later change to the row
-- can invalidate it. Two consequences, both of them the r6 scenario re-entering through the door r6
-- built:
--
--   1. A dump of accounting_tokens taken while a release was outstanding, restored later over an
--      instance that has since been re-bound, carries the exemption onto a binding it knows nothing
--      about — and the pin, living in a different table, is not restored with it.
--   2. Running the recovery flag on an instance whose pin is ALREADY missing stamped a receipt for a
--      pin it did not delete, converting a halted (tamper-evident) row into an exempt one. The flag
--      now stamps only when it is the thing that removes the pin; these columns are what let the
--      halt tell the two apart even if a future writer forgets.
--
-- WHAT THE RECEIPT IS BOUND TO. The connection generation the token row carried at the moment of the
-- release, and the organisation the DELETED pin named. Both are compared against the row the receipt
-- is sitting on, every time the question is asked, so the release counts only while it still
-- describes that row: a rebinding mints a new generation (and clears the receipt anyway), a restored
-- or replaced token row brings a different generation or a different tenant, and either makes the
-- receipt STALE — which is refused, with its own message, rather than honoured.
--
-- NO TIMER, deliberately. The state a release describes is "this exact connection is waiting to be
-- told which organisation it belongs to", and it ends when that happens; the re-consent it waits for
-- is interactive and can legitimately take days (a ~28-day Demo reset noticed on a Friday). An expiry
-- would convert a correct, unfinished recovery into a halt aimed at somebody who did the right thing,
-- while doing nothing at all about a restored dump — which arrives with a fresh timestamp only if it
-- was fresh when it was taken. Binding the receipt to the state removes the exemption exactly when
-- the state stops being true, which is what a timer was standing in for.
--
-- BACKFILL. Every release outstanding when this deploys is stamped with the values it would have
-- recorded had these columns existed: this row's own generation and tenant. So a rig that is mid-
-- recovery today stays exempt today, and becomes stale the moment anything else moves it.
--
-- NULLABLE, because "never released" is what every other row means, and what every QuickBooks row
-- keeps meaning (its equivalents are tracked in o3d-8prh).
ALTER TABLE "accounting_tokens" ADD COLUMN "pinReleasedGeneration" TEXT;
ALTER TABLE "accounting_tokens" ADD COLUMN "pinReleasedTenantId" TEXT;

UPDATE "accounting_tokens"
   SET "pinReleasedGeneration" = "connectionGeneration",
       "pinReleasedTenantId" = "tenantId"
 WHERE "pinReleasedAt" IS NOT NULL;
