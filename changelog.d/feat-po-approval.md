### Purchase order approval before sending (purchasing / settings)

- **New: purchase orders above a threshold need approval before they are sent.** Set **Purchase order approval threshold** under Settings > Company > Documents (an amount in base currency, blank by default). A goods order whose total, ex VAT, is at or above it cannot be confirmed, moved to PO sent or emailed to the supplier until a user with the new `purchasing.approve` permission approves it. ADMIN and MANAGER hold it by default; FINANCE, WAREHOUSE, READONLY and SUPPLIER do not.
- The user who created the order cannot approve it. The order shows an **Awaiting approval** badge (list and detail), approvers see an **Approve** button, and who approved and when is shown on the order and recorded in the activity log. Every send path refuses an unapproved order with a clear message, checked under the order's row lock.
- Editing an approved order so that its total rises, or changing its supplier or currency, clears the approval; a supplier's new quote does too.
- With the setting blank or 0 (the default) nothing changes. Additive migration: six nullable columns on `purchase_orders`. Help documents: Purchasing, Settings.
