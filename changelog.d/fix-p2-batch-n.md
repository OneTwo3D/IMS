### Sales order server validation

- An order can no longer be moved back to Draft from Pending Payment or On Hold (that re-finalised an invoiced, allocated order at today's rate). Drafts and confirmed orders stay editable.
- Marking an order paid by hand is refused on draft and cancelled orders, and un-marking is refused while the order has payments ; an order flagged paid before the marker existed (no payments) can still be un-marked.
- The server refuses negative shipping, fees, order discount, line discounts and tax rate; these were stored in IMS but dropped from the invoice.
- If the tax rate value sent with an order disagrees with the named rate's live value, the save is refused ("the tax rate changed, reload") instead of being silently re-priced; a name that no longer resolves keeps the sent value.
- Manual refunds are refused on draft orders and on pending-payment orders with no recorded payment, receipt or invoice (a pending-payment order holding a receipt stays refundable), and any refund line naming an order line of another order is refused.
