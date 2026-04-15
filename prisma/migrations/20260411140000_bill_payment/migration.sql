-- Add BILL_PAYMENT sync type and payment account fields to purchase invoices.

ALTER TYPE "AccountingSyncType" ADD VALUE IF NOT EXISTS 'BILL_PAYMENT';

ALTER TABLE "purchase_invoices"
  ADD COLUMN "paymentAccountId" TEXT,
  ADD COLUMN "paymentAccountName" TEXT,
  ADD COLUMN "paymentReference" TEXT;
