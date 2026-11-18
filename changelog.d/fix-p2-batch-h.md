### Authorization fixes: stock adjustment edits, product prices, forecast settings (security)

- **Fixed: editing a stock adjustment could re-quantify any movement.** `updateAdjustmentMovement` now refuses anything that is not an ADJUSTMENT movement (dispatch, receipt, transfer and so on), so a Warehouse user can no longer change those quantities.
- **Fixed: the `inventory.prices` permission is now enforced.** The product list and detail hide regular price, sale price and price range from roles without it; the product form ignores submitted prices, price-includes-tax and tax category for them (existing values are kept, new products start unpriced); a product CSV import with price values is refused for them. Admin, Manager and Finance are unchanged.
- **Fixed: a read-only user could save forecast settings and shared analytics views.** Saving forecast settings (its retention value drives the demand-history purge), and saving or deleting a shared sales-stats view, now needs the purchasing-create permission on top of analytics (Admin, Manager, Finance).
- The supplier-portal DRAFT exposure was already closed by #871; no change here.
