CREATE UNIQUE INDEX "sales_order_refunds_wcRefundId_key"
ON "sales_order_refunds" ("wcRefundId")
WHERE "wcRefundId" IS NOT NULL;
