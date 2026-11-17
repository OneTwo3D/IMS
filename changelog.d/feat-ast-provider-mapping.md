### Courier to AST tracking provider mapping (WooCommerce tracking sync)

- IMS can now write the Advanced Shipment Tracking provider slug (`royal-mail`, `ups`, `evri`, ...) into the tracking it pushes to WooCommerce, using the warehouse courier table ported exactly from the woo-mintsoft plugin, so the customer's tracking link and branding resolve. FedEx-labelled orders are written as FedEx and Click & Drop orders as Royal Mail. A courier not in the table is written as before and counted in the activity log (`wc_tracking_provider_unmapped`); IMS never guesses.
- Off by default. Tick **Map couriers to tracking providers** under Sync > WooCommerce > Order Sync (`wc_ast_provider_mapping_enabled`) to turn it on. With it off the tracking payload is byte-identical to before. No migration.
- Not part of this change: confirming on stage that AST's customer despatch email fires (parity gap G5 stays open for that).
