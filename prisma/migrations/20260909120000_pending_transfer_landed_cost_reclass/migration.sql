-- 6oyu.19 (Codex round-2 HIGH-2): persist a landed-cost reclass that has no cost
-- layer to land on yet, because the units it revalued are still IN TRANSIT.
-- Settled (DR inventory / CR transit) by the transfer receipt or dispatch
-- cancellation that creates the destination/replacement layer, in that same
-- transaction. New table only: nothing existing changes, so no backfill and no
-- migration-convention markers are needed.
CREATE TABLE "pending_transfer_landed_cost_reclasses" (
    "id" TEXT NOT NULL,
    "source_cost_layer_id" TEXT NOT NULL,
    "transfer_line_id" TEXT NOT NULL,
    "qty" DECIMAL(14,6) NOT NULL,
    "qty_consumed" DECIMAL(14,6) NOT NULL DEFAULT 0,
    "unit_cost_delta" DECIMAL(18,6) NOT NULL,
    "primary_po_id" TEXT NOT NULL,
    "primary_po_ref" TEXT NOT NULL,
    "freight_po_id" TEXT,
    "recalc_run_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "revalued_at" TIMESTAMP(3) NOT NULL,
    "settled_at" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_transfer_landed_cost_reclasses_pkey" PRIMARY KEY ("id")
);

-- Quantity invariants: an obligation can never be over-settled, and a negative
-- obligation is meaningless. Enforced in the DB so a partial-receipt arithmetic
-- bug cannot silently over- or under-post the reclass.
ALTER TABLE "pending_transfer_landed_cost_reclasses"
    ADD CONSTRAINT "pending_transfer_landed_cost_reclasses_qty_positive" CHECK ("qty" > 0),
    ADD CONSTRAINT "pending_transfer_landed_cost_reclasses_qty_consumed_bounded" CHECK ("qty_consumed" >= 0 AND "qty_consumed" <= "qty");

CREATE UNIQUE INDEX "pending_transfer_landed_cost_reclasses_idempotency_key_key"
    ON "pending_transfer_landed_cost_reclasses"("idempotency_key");

CREATE INDEX "pending_transfer_landed_cost_reclasses_source_line_settled_idx"
    ON "pending_transfer_landed_cost_reclasses"("source_cost_layer_id", "transfer_line_id", "settled_at");

CREATE INDEX "pending_transfer_landed_cost_reclasses_settled_revalued_idx"
    ON "pending_transfer_landed_cost_reclasses"("settled_at", "revalued_at");
