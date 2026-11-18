### Export and import accounting fixes (inventory)

- **Fixed: the product export no longer shows prices to roles without inventory prices.** The Regular price, Sale price and Prices-include-tax columns of the Inventory export stay in the file (so existing templates and imports keep working) but are blank unless you have the inventory prices permission, matching Edit by CSV.
- **Fixed: product import counters are now row-accurate.** A KIT or BOM row whose components could not be applied (invalid component, circular reference, orders in flight, type changed) is counted as skipped once, instead of being counted as created or updated and, for circular BOMs, also skipped.
