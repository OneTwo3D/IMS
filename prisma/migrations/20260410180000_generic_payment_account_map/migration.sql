-- Rename the Xero-specific payment account map setting to a connector-agnostic key.
-- The value format is unchanged: JSON object mapping "method:currency" (or "method:*")
-- to an accounting account code. The active accounting connector (Xero today,
-- QuickBooks tomorrow) is responsible for interpreting the code in its own chart.
UPDATE "settings"
SET "key" = 'accounting_payment_account_map'
WHERE "key" = 'xero_payment_account_map';
