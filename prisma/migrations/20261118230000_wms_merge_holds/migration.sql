-- Merge holds (setting wms_merge_hold_enabled, off by default). ADDITIVE ONLY: three new operator-task reasons, one new enum and one new table.
-- No existing table, column or row is touched; no backfill. Nothing writes the table while the setting is off.
ALTER TYPE "WmsOperatorTaskReason" ADD VALUE 'MERGE_HOLD';
ALTER TYPE "WmsOperatorTaskReason" ADD VALUE 'MERGE_HOLD_OVERDUE';
ALTER TYPE "WmsOperatorTaskReason" ADD VALUE 'MERGE_HOLD_WITHDRAWAL';

CREATE TYPE "WmsMergeHoldState" AS ENUM ('HOLDING', 'HELD', 'NOT_HELD', 'CLEARED');

CREATE TABLE "wms_merge_holds" (
    "id" TEXT NOT NULL,
    "connector" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "external_order_id" TEXT NOT NULL,
    "group_basis" TEXT NOT NULL,
    "state" "WmsMergeHoldState" NOT NULL,
    "episode" INTEGER NOT NULL DEFAULT 1,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "refused" BOOLEAN NOT NULL DEFAULT false,
    "last_error" TEXT,
    "held_at" TIMESTAMP(3),
    "reminded_at" TIMESTAMP(3),
    "cleared_at" TIMESTAMP(3),
    "clear_reason" TEXT,
    "blocked_notice_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wms_merge_holds_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "wms_merge_holds_order_key" ON "wms_merge_holds"("connector", "order_id");
CREATE INDEX "wms_merge_holds_state_idx" ON "wms_merge_holds"("state", "held_at");

ALTER TABLE "wms_merge_holds" ADD CONSTRAINT "wms_merge_holds_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "sales_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
