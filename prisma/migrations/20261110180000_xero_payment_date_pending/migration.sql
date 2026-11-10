-- PAID Xero documents the payment poll skipped because their payment date was missing or unreadable, remembered so a later poll re-reads them by id.
-- Ids only: no personal data.
--
-- ADDITIVE ONLY: one new table, nothing altered, nothing backfilled.

-- CreateTable
CREATE TABLE "xero_payment_date_pending" (
    "kind" TEXT NOT NULL,
    "xeroInvoiceId" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastCheckedAt" TIMESTAMP(3),

    CONSTRAINT "xero_payment_date_pending_pkey" PRIMARY KEY ("kind","xeroInvoiceId")
);

-- CreateIndex
CREATE INDEX "xero_payment_date_pending_lastCheckedAt_idx" ON "xero_payment_date_pending"("lastCheckedAt");
