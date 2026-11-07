-- An open erasure obligation for a storefront order IMS does not hold yet. A WooCommerce-anonymised delivery for such an order that is
-- acknowledged or dropped (initial import pending, a status or currency refusal, a withdrawal skip) leaves a row here; when the order is later
-- created from an older read it is created ALREADY ERASED and the row is retired in the same transaction. Ids only: no personal data.
--
-- ADDITIVE ONLY: one new table, nothing altered, nothing backfilled.

-- CreateTable
CREATE TABLE "storefront_order_erasure_obligations" (
    "connector" TEXT NOT NULL,
    "externalOrderId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "storefront_order_erasure_obligations_pkey" PRIMARY KEY ("connector","externalOrderId")
);
