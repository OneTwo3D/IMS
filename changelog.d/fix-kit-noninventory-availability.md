### Fixed: kits with a non-inventory component no longer push 0 to WooCommerce
- A non-inventory component (service, leaflet, gift wrap, fee) imposes no limit on a kit's stock, in the WooCommerce push, the kit stock panel, allocation and dispatch alike. Previously it counted as zero stock and pinned the kit at 0.
- A kit can no longer be saved (editor or CSV import) with a variable product as a component, or with only non-inventory components; the message says what to do. Existing such kits fail closed at 0.
