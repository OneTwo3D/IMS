-- Coexistence check: facts about another writer seen on imported storefront orders.
--
-- A new table only: no existing row, reader or writer is affected, and nothing deployed before this migration
-- reads or writes it. One row per (order, closed kind); the values of the storefront's meta rows are never stored.
-- It is evidence for a read-only report and is never a queue: nothing delivers from it.
CREATE TABLE "incumbent_writer_evidence" (
    "id" TEXT NOT NULL,
    "connector" TEXT NOT NULL,
    "external_order_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "paid_at" TIMESTAMP(3),
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incumbent_writer_evidence_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "incumbent_writer_evidence_order_kind_key" ON "incumbent_writer_evidence"("connector", "external_order_id", "kind");

CREATE INDEX "incumbent_writer_evidence_kind_paid_idx" ON "incumbent_writer_evidence"("kind", "paid_at");
