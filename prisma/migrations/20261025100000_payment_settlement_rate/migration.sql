-- The settlement rate IMS resolved for a customer receipt WHEN it was recorded (1 base = X receipt currency). It is carried on the queued
-- INVOICE_PAYMENT so Xero books the realised FX at IMS's rate, and every later enqueue of the same receipt (the deferred re-drive, the operator
-- re-drive, the ledger-check action) reads THIS value instead of looking the table up again: a rate that lands later the same day must not change
-- what an existing receipt is booked at.
--
-- NULL = a base-currency receipt (nothing to convert), a refund payment, or a receipt recorded before this column existed. A foreign receipt with
-- NULL is refused when queued (foreign_payment_missing_rate); nothing is guessed. ADDITIVE ONLY, nullable, no default, no backfill: safe to apply
-- while the previous build is serving.
ALTER TABLE "payments" ADD COLUMN "settlement_rate_to_base" DECIMAL(18,8);
