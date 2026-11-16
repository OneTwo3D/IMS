-- Additive: COGS on shipment, paid or not. Marks a shipment whose cost the daily batch relieved straight out of Inventory (DR COGS / CR Inventory) because Group A2 had not run for its order, so Group A2, Group B and the refund service skip or reverse its units accordingly. Three nullable columns, no default, no backfill: every existing row reads NULL (costed the ordinary way through Allocated Inventory).
ALTER TABLE "shipments" ADD COLUMN "accounting_cogs_relieved_from_inventory_at" TIMESTAMP(3);
ALTER TABLE "shipments" ADD COLUMN "accounting_cogs_relieved_from_inventory_amount" DECIMAL(18,4);
ALTER TABLE "shipments" ADD COLUMN "accounting_cogs_relieved_from_inventory_sync_log_id" TEXT;
