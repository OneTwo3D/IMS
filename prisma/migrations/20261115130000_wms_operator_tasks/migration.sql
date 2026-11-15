-- Additive: IMS operator tasks that replace the order comments IMS used to write to the warehouse ("raise a query for order X saying Y"). New enums and a new table only; no existing row is touched.
CREATE TYPE "WmsOperatorTaskReason" AS ENUM ('MERGED_LINES_REMOVED', 'PARTIAL_REMOVAL_CHECK', 'COURIER_FALLBACK', 'PUSH_CONFLICT', 'CANCEL_NOTICE', 'REFUND_NOTE');

CREATE TYPE "WmsOperatorTaskStatus" AS ENUM ('OPEN', 'DONE');

CREATE TABLE "wms_operator_tasks" (
    "id" TEXT NOT NULL,
    "connector" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "external_order_id" TEXT NOT NULL,
    "reason" "WmsOperatorTaskReason" NOT NULL,
    "query_text" TEXT NOT NULL,
    "payload" JSONB,
    "content_hash" TEXT NOT NULL,
    "status" "WmsOperatorTaskStatus" NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "done_at" TIMESTAMP(3),
    "done_by" TEXT,

    CONSTRAINT "wms_operator_tasks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "wms_operator_tasks_dedupe_key" ON "wms_operator_tasks"("connector", "order_id", "external_order_id", "reason", "content_hash");

CREATE INDEX "wms_operator_tasks_status_created_idx" ON "wms_operator_tasks"("status", "created_at", "id");

CREATE INDEX "wms_operator_tasks_order_idx" ON "wms_operator_tasks"("order_id");

ALTER TABLE "wms_operator_tasks" ADD CONSTRAINT "wms_operator_tasks_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "sales_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A courier-fallback operator task that is DUE and not yet recorded: the shipping service the fallback happened for. Set with the link write that detects the
-- fallback (so a failed task insert is retried by a later sweep whether or not the order is amended), cleared once the task is recorded. Nullable column: additive.
ALTER TABLE "wms_order_push_links" ADD COLUMN "courier_task_service" TEXT;

-- Backfill (idempotent: it only sets a marker, and a task is deduplicated): every live link still flagged courierPending is an outstanding courier
-- fallback whose old warehouse note was never read. The first sweep turns each into one task.
UPDATE "wms_order_push_links" AS l
SET "courier_task_service" = COALESCE(o."shippingService", '—')
FROM "sales_orders" AS o
WHERE o."id" = l."orderId" AND l."state" = 'SYNCED' AND l."courierPending" = true AND l."courier_task_service" IS NULL;

-- Backfill: an OUTSTANDING hold or cancel notice is one on a live link (SYNCED or MERGED) that is still set (the sweep clears a notice once the order leaves
-- the held or cancelled state, and only still-applicable notices are selected). Its "comment delivered" stamp recorded an old comment the warehouse never read,
-- so it is reset to "no task yet": the first sweep records one task per outstanding notice (deduplicated on the notice's episode, so running it again changes nothing).
UPDATE "wms_order_push_links" SET "hold_notice_comment_at" = NULL WHERE "state" IN ('SYNCED', 'MERGED') AND "hold_notice_at" IS NOT NULL AND "hold_notice_comment_at" IS NOT NULL;
UPDATE "wms_order_push_links" SET "cancel_notice_comment_at" = NULL WHERE "state" IN ('SYNCED', 'MERGED') AND "cancel_notice_at" IS NOT NULL AND "cancel_notice_comment_at" IS NOT NULL;
