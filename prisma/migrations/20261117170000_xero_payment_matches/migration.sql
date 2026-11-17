-- Additive: one table holding the result of the Xero customer-payment matching pass, one row per receipt (payment_id is unique and is the claim).
-- Nothing existing is touched.
CREATE TYPE "XeroPaymentMatchStatus" AS ENUM ('WOULD_POST', 'UNMATCHED', 'BLOCKED', 'CLAIMED', 'REGISTERED', 'FAILED');

CREATE TABLE "xero_payment_matches" (
    "id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "status" "XeroPaymentMatchStatus" NOT NULL,
    "mode" TEXT NOT NULL,
    "reason" TEXT,
    "detail" TEXT,
    "bank_account_id" TEXT,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL,
    "amount_due" DECIMAL(18,4),
    "accounting_invoice_id" TEXT,
    "payment_date" TIMESTAMP(3),
    "claim_token" TEXT,
    "claimed_at" TIMESTAMP(3),
    "registered_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_evaluated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "xero_payment_matches_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "xero_payment_matches_payment_id_key" ON "xero_payment_matches"("payment_id");
CREATE INDEX "xero_payment_matches_status_idx" ON "xero_payment_matches"("status", "last_evaluated_at");
CREATE INDEX "xero_payment_matches_order_idx" ON "xero_payment_matches"("order_id");
