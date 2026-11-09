-- The durable record that a migration's own post-migration checks (its verify.sql) all returned zero.
--
-- WHY IT EXISTS. The data-retention sweep keeps every shopping_sync_logs row a refund-park recovery names, so
-- check 7 of the 20260822120000 verification has both sides of its join at cutover time. That exemption had no
-- end: nothing recorded that check 7 had passed, so nothing could say the rows were no longer needed. The
-- verification runner now writes a row here when every check of a migration returned zero (first pass wins) and
-- deletes it when a later run fails, and the retention sweep stops protecting the witnessed rows while a row
-- exists.
--
-- NO BACKFILL. A database that passed before this table existed records the pass on its next deploy, when the
-- runner executes the checks again; until then the exemption stays in force, which is the safe side.
CREATE TABLE "migration_verification_passes" (
    "migration_name" TEXT NOT NULL,
    "passed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checks_passed" INTEGER NOT NULL,

    CONSTRAINT "migration_verification_passes_pkey" PRIMARY KEY ("migration_name")
);
