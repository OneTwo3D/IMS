### Sales order server validation

- An order can no longer be moved back to Draft from Pending Payment or On Hold (that re-finalised an invoiced, allocated order at today's rate). Drafts and confirmed orders stay editable.
- Marking an order paid by hand is refused on draft and cancelled orders, and un-marking is refused while the order has payments or when the paid state did not come from that control.
- The server refuses negative shipping, fees, order discount, line discounts and tax rate; these were stored in IMS but dropped from the invoice.
- The order's default VAT rate is taken from the named tax rate, not the value the form sent.
- Manual refunds are refused on draft and pending-payment orders, and any refund line naming an order line of another order is refused.
