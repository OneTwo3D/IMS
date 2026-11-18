### Costing and landed cost fixes (batch AF) (purchasing, accounting)

- Editing a freight order's costs from a dialog that was opened before another operator changed the cost lines is now refused with a "reload and re-apply" message instead of silently reversing their edit.
- The landed-cost revaluation, freight-order create/edit, PO close-short and freight cancellation now read the accounting chart before their transaction opens, not over a second pooled connection inside it.
- The orphaned-allocation reversal is now capped by the open Allocated Inventory balance after Group B shipment relief and prior refund relief as well as earlier reversals. If a journaled shipment records no relief the reversal is withheld and reported for a manual post, rather than risking an over-credit.
- A freight-order edit now also refuses when the order's VAT rate changed since the dialog opened, and the dialog stays open until the refreshed order has landed so it cannot resubmit stale lines.
- An unreadable accounting chart now refuses the freight create/edit, PO close and cancellation before any write, instead of continuing without a chart.
- The orphaned-allocation reversal nets Group B and refund relief only where its journal is proved. A withheld reversal is recorded in the exception inbox, and while it is open further automatic reversals on that order are withheld.
