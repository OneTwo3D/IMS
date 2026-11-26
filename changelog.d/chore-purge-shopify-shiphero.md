### Remove the retired Shopify and ShipHero connectors' residue
- Live code, types, settings keys, UI, tests, comments and current docs no longer name Shopify or ShipHero. WooCommerce is the one registered shopping connector and Mintsoft the one registered WMS; the generic multi-connector and WMS-agnostic design (registries, ids unions, unrecognised-id refusals, the second-connector seam tests) is unchanged. `archive/connectors/` and the `docs/archive/` removal notes are kept.
- New migration `20261126120000_purge_retired_storefront_wms_settings` deletes the `plugin_shopify_enabled`, `plugin_shiphero_enabled`, `shopify_*` and `shiphero_*` rows from `settings`. Nothing in the build reads them; with the rows gone, the retired credential keys leave the sensitive-key list (and the list itself goes). Historical rows in other tables that name a retired connector (for example `WmsConnection.orderLookupConnector`) are left alone and still refuse by name through the generic unrecognised-connector paths.
- The first-install rehearsal guard keeps refusing the retired connectors' `SHOPIFY*` / `SHIPHERO*` environment prefixes.
- Code tags of the form `o3d-remove-shiphero round N` in comments now read `wms-neutral-refactor round N`; no behaviour change.

Docs: current docs and plans are updated in the same PR (small enough to review together).
