-- Rename AdjustmentReason.xero_account_code → account_code
-- The field is connector-agnostic: it holds the account code in whichever
-- accounting system (Xero, QuickBooks, etc.) is currently active.
ALTER TABLE "adjustment_reasons" RENAME COLUMN "xero_account_code" TO "account_code";
