-- Additive: the source shipments (and quantities per product) of the units a refund actually returned to stock,
-- staged and fallback rows alike ([{ "shipmentId": ..., "productId": ..., "qty": 1 }]). A later refund replays it so the
-- units still owed are priced from the shipment that really has them left. NULL for every earlier refund.
ALTER TABLE "sales_order_refunds" ADD COLUMN "return_shipment_qty" JSONB;
