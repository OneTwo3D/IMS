-- Additive: a configurable list of return reasons and one optional link per refund. Nothing existing is changed; the free-text sales_order_refunds.reason stays as it is.
CREATE TABLE "return_reasons" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "return_reasons_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "sales_order_refunds" ADD COLUMN "return_reason_id" TEXT;

CREATE INDEX "sales_order_refunds_return_reason_id_idx" ON "sales_order_refunds"("return_reason_id");

ALTER TABLE "sales_order_refunds" ADD CONSTRAINT "sales_order_refunds_return_reason_id_fkey" FOREIGN KEY ("return_reason_id") REFERENCES "return_reasons"("id") ON DELETE SET NULL ON UPDATE CASCADE;
