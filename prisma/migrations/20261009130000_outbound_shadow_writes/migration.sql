-- Producer-side hold: the record of what IMS would have written while it was held.
--
-- A new table only: no existing row, reader or writer is affected, and nothing deployed before this migration
-- reads or writes it. One row per distinct unit of work (the unique key); a repeat of the same work adds to
-- "occurrences". It is a record and never a queue: nothing delivers from it.
CREATE TABLE "outbound_shadow_writes" (
    "id" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "payload_digest" CHAR(64) NOT NULL,
    "summary" JSONB NOT NULL DEFAULT '{}',
    "reason" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "cutoff" TIMESTAMP(3),
    "grant_state" TEXT NOT NULL,
    "accounting_sync_log_id" TEXT,
    "first_produced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_produced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "occurrences" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "outbound_shadow_writes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "outbound_shadow_writes_work_key" ON "outbound_shadow_writes"("destination", "operation", "subject_type", "subject_id", "payload_digest");

CREATE INDEX "outbound_shadow_writes_destination_last_idx" ON "outbound_shadow_writes"("destination", "last_produced_at");
