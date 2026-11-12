-- Scope the remembered PAID-document ids to the Xero organisation they belong to, so a poll only reads and changes the rows of the organisation it is connected to.
--
-- ADDITIVE: one new column with a default ('' = a row written before the column existed, read as the connected organisation's), and the primary key widened to
-- include it. Nothing dropped, nothing backfilled, no existing migration touched.
ALTER TABLE "xero_payment_date_pending" ADD COLUMN "tenantId" TEXT NOT NULL DEFAULT '';

ALTER TABLE "xero_payment_date_pending" DROP CONSTRAINT "xero_payment_date_pending_pkey";
ALTER TABLE "xero_payment_date_pending" ADD CONSTRAINT "xero_payment_date_pending_pkey" PRIMARY KEY ("tenantId","kind","xeroInvoiceId");
