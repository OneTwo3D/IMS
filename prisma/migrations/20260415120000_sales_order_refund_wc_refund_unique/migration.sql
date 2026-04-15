CREATE UNIQUE INDEX "sales_order_refunds_externalRefundId_key"
ON "sales_order_refunds" ("externalRefundId")
WHERE "externalRefundId" IS NOT NULL;
