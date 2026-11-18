### Purchase-order billing guards (purchasing)
- A line (or cost line) repeated inside one bill request now counts cumulatively against the three-way-match cap, so it can no longer bill past what was received.
- Bills can only be created against placed, non-cancelled orders. Draft, RFQ Sent, Quote Received and Cancelled orders are refused by the server; Closed stays billable (late supplier invoice for goods received before the close). The Create Bill button no longer shows on RFQ Sent orders and now shows on Closed ones.
- A bill is refused when the supplier already has a bill with the same supplier invoice number, unless the operator confirms the override. Application-level check only; no migration or unique index.
- An emailed purchase order PDF is now checked against the approval using the totals it was rendered from, so a concurrent downward edit cannot send a dearer, unapproved document.
