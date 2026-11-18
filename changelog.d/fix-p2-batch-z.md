### Refund accounting: remainder shares and cancel with a posted invoice (sales / accounting)

- **Fixed: a refund that reaches 99.9% (classed full) left the uncovered unearned revenue in the Unearned account for ever.** A full refund's unearned-revenue reversal now takes whatever is still deferred, not only the value of the refunded lines (a full refund is excluded from every later daily batch, so nothing else would release it).
- **Fixed: refunding the unshipped remainder of a part-shipped order left the shipping/discount share in Unearned.** Once a refund leaves no line with units still to ship, its unearned-revenue reversal releases the rest of the deferral. No posting key changes; only the amount on the existing reversal journal.
- **Changed: cancelling by hand an order whose invoice is posted to the accounting system is refused** until the order has been refunded in full (the credit note is the reversal). A cancellation driven by the store still goes through and writes a `cancelled_with_posted_invoice` warning to the order's activity log. Nothing is posted to the accounting system by the cancellation.
- Manual refund totals were already derived server-side from the stored order (sale-line nets cut under the order lock, shipping base derived from its foreign amount, foreign ceiling checked): no change needed.
- Help documents: Sales.
