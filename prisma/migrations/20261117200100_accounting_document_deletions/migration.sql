-- Additive: the record of a synced invoice or bill deleted in IMS and Xero together. One new table; nothing is
-- backfilled, no existing table is touched.
CREATE TABLE "accounting_document_deletions" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "connector" TEXT NOT NULL DEFAULT 'xero',
    "reference_type" TEXT NOT NULL,
    "reference_id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "external_document_id" TEXT NOT NULL,
    "original_number" TEXT NOT NULL,
    "released_number" TEXT NOT NULL,
    "target_status" TEXT,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "requested_by_id" TEXT,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "snapshot" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "accounting_document_deletions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "accounting_document_deletions_external_document_id_key" ON "accounting_document_deletions"("external_document_id");
CREATE INDEX "accounting_document_deletions_reference_type_reference_id_idx" ON "accounting_document_deletions"("reference_type", "reference_id");
CREATE INDEX "accounting_document_deletions_state_idx" ON "accounting_document_deletions"("state");
