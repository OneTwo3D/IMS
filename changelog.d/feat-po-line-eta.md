### Per-line estimated delivery on purchase orders (purchasing)

- **Added: each purchase order line can carry its own expected delivery date.** The column `PurchaseOrderLine.expectedDelivery` is nullable and additive (migration `20261116230000_po_line_expected_delivery`); a blank line follows the order's date, so every existing order behaves as before. One pure helper, `effectiveLineEta` (line date, else the order's), is used everywhere.
- **PO form and detail:** an optional Expected date per line (the order's date shows as the placeholder) and an Expected column on the PO page showing each line's effective date. Receiving, in full or in part, never touches a line's date.
- **Reports and exports:** the reorder report's inbound arrival date uses the line's effective date; the Open purchase orders report shows the earliest effective date of the lines still to come; the purchase order CSV export gains an export-only `lineExpectedDelivery` column.
- **Supplier PO PDF (and the emailed copy):** a Delivery column appears when any line's date differs from the order's.
- Help document: Purchasing.
