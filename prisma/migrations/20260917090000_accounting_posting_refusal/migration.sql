-- o3d-j625 r4 — refused accounting postings become durable, queryable outstanding work.
--
-- The enqueues can refuse (retired chart, unattributable document id, a payment account belonging to
-- another connector). Until now every refusal was an Activity-log line, which nobody is watching — the
-- WooCommerce held-invoice release refuses days after the import and nothing retries it. Recorded here,
-- a refusal reads as OUTSTANDING in the exception inbox, with both connectors and a remedy.
--
-- One OPEN row per posting: the unique key is the posting itself, so a sweep that refuses the same work
-- repeatedly updates one row. Cleared only by the posting actually being queued.
CREATE TABLE "accounting_posting_refusals" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "referenceType" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,
    "chartConnector" TEXT,
    "activeConnector" TEXT,
    "reason" TEXT NOT NULL,
    "committed" TEXT NOT NULL,
    "remedy" TEXT NOT NULL,
    "detail" JSONB,
    "refusedCount" INTEGER NOT NULL DEFAULT 1,
    "firstRefusedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastRefusedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "accounting_posting_refusals_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "accounting_posting_refusals_type_referenceType_referenceId_key"
    ON "accounting_posting_refusals"("type", "referenceType", "referenceId");
CREATE INDEX "accounting_posting_refusals_resolvedAt_lastRefusedAt_idx"
    ON "accounting_posting_refusals"("resolvedAt", "lastRefusedAt");
