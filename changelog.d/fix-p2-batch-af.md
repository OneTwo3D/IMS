### Costing and landed cost fixes (batch AF) (purchasing, accounting)

- Editing a freight order's costs from a dialog that was opened before another operator changed the cost lines is now refused with a "reload and re-apply" message instead of silently reversing their edit.
- The landed-cost revaluation, freight-order create/edit, PO close-short and freight cancellation now read the accounting chart before their transaction opens, not over a second pooled connection inside it.
- A freight-order edit now also refuses when the order's VAT rate changed since the dialog opened, and the dialog closes when the refreshed order lands (or after a short timeout) so it cannot resubmit stale lines.
- An unreadable accounting chart now refuses a freight create/edit, a freight cancellation, and a close or cancel that revalues freight, before any write; a close or cancel that revalues nothing proceeds as before.
