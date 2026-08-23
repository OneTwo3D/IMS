-- =================================================================================================
-- POST-MIGRATION VERIFICATION — 20260822090000_refund_reversal_staging_state
--
-- prisma/migrations/verification-required.txt names this migration, and until now it declared
-- nothing: the coverage assertion was red in CI by design and this is the file that closes it.
-- scripts/run-migration-verifications.mjs executes every prisma/migrations/<name>/verify.sql after
-- the schema has moved and BEFORE the new build is started, and refuses to start it if any check
-- returns a non-zero count. Prisma reads only migration.sql from a migration directory, so this file
-- is invisible to `prisma migrate deploy` and carries no checksum risk.
--
-- THE CONTRACT: every statement returns EXACTLY ONE ROW of (check_name, violations), and every
-- violations must be 0. The checks are read-only and they run on every later deploy too, so each one
-- is written so that the only thing that can make it non-zero is a binary that does not know this
-- column writing `sales_order_refunds` after the column existed.
--
-- WHAT THIS MIGRATION SAID WAS DANGEROUS, which is where these checks come from. Its own prose names
-- two states and no others:
--
--   (a) "A row written by any binary that does not set this column lands NULL and reads as
--       `undecidable`." Legacy rows are legitimately NULL — the column is deliberately NOT
--       backfilled — so NULL alone cannot be the check or it would be non-zero for ever from the
--       first deploy. What is NOT legitimate is a NULL row that came into existence AFTER the column
--       did: nothing but a predecessor serving across the cutover can produce one, because the two
--       writers in the new binary (the INSERT in createSalesOrderRefund and the staging UPDATE in
--       stageRefundAccountingReversals) both always set it. That is check 1.
--
--   (b) "A PREDECESSOR'S OWN RETRY CAN STILL CLEAR `accounting_retry_required` ON SUCH A ROW, and
--       after that the row is outside the invariant's only bound and is UNRECOVERABLE." That is the
--       half of check 1 that no later sweep can find again, and check 2 counts it on its own so a red
--       deploy says plainly which rows an operator can still act on and which are already lost.
--       Check 2 is deliberately a SUBSET of check 1: both must be zero, and separating them is about
--       what the failure report tells the person reading it.
--
-- THE CUTOVER BOUND IS A DISCRIMINATOR, NOT A CLOCK (o3d-2sm1.4, Codex r3 HIGH). The first revision
-- of this file bounded both checks with
-- `r."createdAt" >= (SELECT max(started_at) FROM "_prisma_migrations" WHERE migration_name = ...)`,
-- and that comparison is unsound in exactly the direction that matters:
--
--   * `createdAt` defaults to CURRENT_TIMESTAMP, and Postgres fixes CURRENT_TIMESTAMP AT
--     TRANSACTION START. It is `now()`, not `clock_timestamp()` — a distinction this repo has
--     already been bitten by and written down. A predecessor transaction that BEGAN before the
--     migration and COMMITTED after it stamps its row with a pre-migration timestamp, so the row
--     LOOKS LEGACY AND IS NOT. It is the exact row these checks exist to find, and the clock is what
--     hides it. Prisma's client-side `@default(now())` is no better: that clock belongs to the
--     predecessor.
--   * and the ledger read had to carry a "when the row is missing, report ONE violation" case,
--     because a check that cannot answer must not report clean.
--
-- Both problems go away with a bound the MIGRATION ITSELF draws. migration.sql adds
-- `reversal_staging_state_predates_column` NOT NULL DEFAULT true under the ACCESS EXCLUSIVE lock of
-- its own ALTER TABLE — marking exactly the rows that exist at that instant, with no row insertable
-- in the middle of it — and then flips the default to false so every later insert carries false. The
-- populations are separated by what is physically stored in the row, not by comparing two clocks:
--
--   predates = true   the row was there when the column was added. Legacy; NULL is expected.
--   predates = false  the row was inserted after this migration committed. A NULL state on it was
--                     written by a binary that does not set the column.
--
-- A long-running transaction cannot fool it in either direction: one that inserted before the ALTER
-- held a RowExclusiveLock the ALTER had to wait for, so its row is marked true; one that inserts
-- after the migration commits gets the new default, false, whenever it happens to have started. The
-- column is NOT NULL, so there is no third answer and no "cannot answer" case to encode.
--
-- WHAT THESE CHECKS CANNOT DO, for the same reason the runner's own header gives: they catch a
-- predecessor that CREATED rows. They cannot catch one that cleared the flag on a LEGACY row during
-- the window — nothing on the row records when it was cleared. Stopping the writer before the
-- migration is the only defence against that, and that is scripts/deploy.sh's job.
-- =================================================================================================

-- 1. NO REFUND BORN AFTER THE COLUMN WITHOUT A WITNESS. Every refund inserted once this migration
--    committed is written by code that sets the column at INSERT. A NULL on a row the migration did
--    NOT mark as pre-existing is a row minted by the predecessor — the exact window the
--    stop-before-migrate order exists to close.
SELECT 'sales_order_refunds written after the cutover began with no staging witness' AS check_name,
       count(*)                                                                      AS violations
  FROM "sales_order_refunds" r
 WHERE r."reversal_staging_state" IS NULL
   AND r."reversal_staging_state_predates_column" = false;

-- 2. AND NONE OF THEM ALREADY OUTSIDE THE INVARIANT'S ONLY BOUND. `accounting_retry_required` is the
--    single thing that keeps a refund owing accounting visible to the accounting invariant. A row
--    from the window that is undecidable AND has that flag already cleared AND carries no recorded
--    sync list is one the predecessor's own retry reported success on: `reversalRecordVerdict` reads
--    it as `nothing-lost` (see lib/domain/sales/refund-reversal-record.ts), no sweep will ever look
--    at it again, and what it staged — if it staged anything — cannot be reconstructed.
SELECT 'sales_order_refunds from the cutover window left unrecoverable by a cleared retry flag' AS check_name,
       count(*)                                                                                 AS violations
  FROM "sales_order_refunds" r
 WHERE r."reversal_staging_state" IS NULL
   AND r."reversal_staging_state_predates_column" = false
   AND r."accounting_retry_required" = false
   AND r."accounting_retry_syncs" IS NULL;

-- 3. NOTHING BUT THE TWO VALUES THE APPLICATION WRITES. migration.sql ships no trigger, no default
--    and no backfill for the state column, and states that a write from anywhere else "simply lands
--    whatever it carries". The tri-state is only readable while it holds one of the two constants in
--    lib/domain/sales/refund-reversal-record.ts: `reversalRecordVerdict` falls through any third
--    value to `undecidable`, so a repair script or a partial restore that invented one would silence
--    itself rather than fail. Zero for ever, and the day it is not, something other than the two
--    application statements wrote this column.
SELECT 'sales_order_refunds.reversal_staging_state holding a value no writer mints' AS check_name,
       count(*)                                                                     AS violations
  FROM "sales_order_refunds"
 WHERE "reversal_staging_state" IS NOT NULL
   AND "reversal_staging_state" NOT IN ('NOT_STAGED', 'STAGED');
