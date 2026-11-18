### Costing and landed cost fixes (batch AF) (purchasing, accounting)

- Editing a freight order's costs from a dialog that was opened before another operator changed the cost lines is now refused with a "reload and re-apply" message instead of silently reversing their edit.
- The landed-cost revaluation, freight-order create/edit, PO close-short and freight cancellation now read the accounting chart before their transaction opens, not over a second pooled connection inside it.
- The orphaned-allocation reversal is now capped by the open Allocated Inventory balance after Group B shipment relief and prior refund relief as well as earlier reversals. If a journaled shipment records no relief the reversal is withheld and reported for a manual post, rather than risking an over-credit.
