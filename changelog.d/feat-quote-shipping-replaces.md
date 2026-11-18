### Supplier-quoted shipping replaces the buyer's Shipping line (owner ruling)
- Purchase-order cost lines can be ticked **Shipping** (new nullable `kind` column on `freight_cost_lines`; existing lines stay untagged).
- With `supplier_quote_shipping_landed_enabled` ON (default OFF, unchanged), a supplier's quoted shipping now REPLACES the buyer's Shipping-tagged line instead of adding to it. A billed line, or one on an order whose goods have landed, is kept beside the supplier's line and a warning is logged. Untagged lines are never replaced. With the setting OFF nothing changes.
