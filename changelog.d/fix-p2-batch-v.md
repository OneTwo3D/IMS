### Accounting fixes: unmapped stock adjustments, reverse-charge swap, manual journals

- A valued stock adjustment with no reason, a reason with no account, or no inventory account mapped used to change the cost layers and post nothing. It now still commits, and an outstanding-posting row appears in the exception inbox (kind: stock adjustment journal) so the journal can be posted by hand. Nothing is reported when no accounting connector is active.
- A reverse-charge sales line with the reverse-charge sales tax type left empty no longer posts on its taxable code: a native sales invoice is refused with a message naming the setting, and a WooCommerce invoice is held as not reconciling with the order.
- Manual journal lines to Xero now carry an explicit no-VAT `TaxType` where none was set, so Xero no longer applies the account's default tax. A line that names a tax type keeps it.
- A journal whose lines, rounded to the penny as sent, differ by a penny is refused before it is queued (shown as an owed posting) instead of failing at Xero.
