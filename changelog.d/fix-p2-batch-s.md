### Invoice PDF VAT detail and London-day document dates

- The IMS-rendered invoice (download and email attachment) now shows each line's VAT rate, and prints reverse-charge wording under the totals when a line's tax rate is flagged reverse charge. The seller VAT number was already printed.
- The date sent to the accounting system on sales invoices (manual and WooCommerce import), credit notes, the refund COGS and allocation reversal journals and the realised FX journal is now the Europe/London calendar day of the moment, not the UTC day, so an order at 00:30 BST on 1 July is dated 1 July (not 30 June, the previous VAT quarter). Documents already posted keep the date they were posted with; only the date derivation changed.
