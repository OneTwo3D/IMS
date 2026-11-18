### Accounting reconciliations and sub-ledgers (accounting)
- The inventory reconciliation no longer compares across mismatched days: the Trial Balance is a London business day and the stock snapshot a UTC day, so during BST a comparison is withheld when stock moved in the hour between them. Stock on a dispatched, not yet received transfer is added to the IMS side, since it has left the snapshot but is still in the Inventory account.
- A rounding sweep is no longer posted when the sweeps of the trailing 30 days would pass £5: a residue that recurs daily is reported as a gap.
- The Inventory Valuation GL variance now compares with Inventory plus Allocated Inventory (and in-transit transfer stock), and is blank when the Allocated Inventory balance for the date is missing.
- A retrospective manufacturing-cost reclass records its COGS leg in the COGS sub-ledger.
- COGS and Transit sub-ledger rows given a timestamp are dated on the London business day, matching their journals.
- The accounting invariant report adds a warning that compares the COGS and Transit sub-ledgers with the journals as queued, independently of the Xero balances.
