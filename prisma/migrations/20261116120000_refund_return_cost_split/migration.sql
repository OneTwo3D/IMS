-- Additive: which source shipments the units a refund returned to stock came from, and their issued cost
-- ([{ "shipmentId": ..., "valueBase": "45.000000" }]). Read by the daily batch (Group B) to book, shipment by
-- shipment, the COGS reversal for stock that came back before its shipment was journaled. NULL for every row
-- written before the column existed and for refunds that returned nothing.
ALTER TABLE "sales_order_refunds" ADD COLUMN "return_cost_split" JSONB;
