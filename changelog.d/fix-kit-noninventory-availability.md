### Fixed: kits with a non-inventory component no longer push 0 to WooCommerce
- A non-inventory component (service, leaflet, gift wrap, fee) imposes no limit on a kit's stock in the WooCommerce push, the kit stock panel, allocation and dispatch. Previously it counted as zero stock and pinned the kit at 0. The packing slip lists those parts under "Also pack (not stock-tracked)", naming the kit.
- While a warehouse connector (Mintsoft) is enabled such kits stay at 0 in the shop, because the warehouse bundle cannot include a part with no warehouse product link.
- A kit can no longer be saved (editor, CSV import and its preview) or converted from a BOM with a variable product as a component, or with only non-inventory components. Existing such kits fail closed at 0 and cannot be allocated.
