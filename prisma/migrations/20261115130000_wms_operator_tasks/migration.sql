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
