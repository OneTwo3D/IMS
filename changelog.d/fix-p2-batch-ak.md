### Accounting follow-ups (P2 batch AK)
- The daily Group B deferred-revenue true-up (and its preview) now also nets what earlier refunds recorded durably in `unearnedReversedAmount`, so compacted sync rows can no longer make it recognise revenue a refund already took.
- A manual purchase-order receipt (and a supplier return) now reads the inventory and transit account codes inside its transaction, under the accounting mapping lock, so a remap in the window can no longer commit a journal on the old codes.
- A refund (and the true-up) now recognises an earlier unearned-revenue reversal by its line label, so a reversal posted under a since re-mapped account is still netted and the refund no longer over-debits.
- The supplier credit-note "duplicate credit notes in the ledger" refusal no longer opens with "act only if it is absent"; it tells the operator to check, then void the extras, and voided or deleted copies no longer count as duplicates, so the survivor is linked on retry.
- The GR/IR opening balance counts a return credit the sub-ledger already tracks, so it no longer opens a false negative.
- Unrealised-FX receivables net a NET-basis credit at its VAT-inclusive equivalent.
