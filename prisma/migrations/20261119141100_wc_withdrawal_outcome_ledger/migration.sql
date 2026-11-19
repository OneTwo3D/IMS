-- Additive (switchover o3d-zvec.3 PR B): the durable once-only record of the withdrawal outcome IMS wrote to the storefront, and IMS's own record of the
-- storefront withdrawal request id. One row per (order, request, outcome): a repeated webhook or poll finds it and writes nothing.
ALTER TABLE "sales_orders" ADD COLUMN "withdrawalRequestId" TEXT;

CREATE TABLE "wc_withdrawal_outcomes" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "request_key" TEXT NOT NULL,
    "outcome_kind" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "written_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wc_withdrawal_outcomes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "wc_withdrawal_outcomes_once_key" ON "wc_withdrawal_outcomes"("order_id", "request_key", "outcome_kind");

ALTER TABLE "wc_withdrawal_outcomes" ADD CONSTRAINT "wc_withdrawal_outcomes_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "sales_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
