### Per-event FX rates for purchasing: one-off journal for bills posted outside IMS; return-credit fixes before the flip
- Still behind `purchase_event_fx_rates_enabled` (off) and its interlock (still off); with the switch off nothing changes.
- Bills that reached Xero outside IMS before switch-on (Qoblex, first load, by hand, bill sync off) get the owner's one-off exchange-rate journal, but only after an admin confirms: `npm run purchase-fx:non-ims-bills` lists them with the journal proposed (dry run by default); `-- --yes --confirm-admin --by <name> --reason "<text>"` records and audits the confirmation and posts the journal once through the normal accounting queue (a re-run posts nothing).
- A return credit now clears only the lines of the return that raised it (credits posted in any order, or a draft deleted, no longer strand transit or miss the price variance).
- A reverse-charge return credit never sends a negative line: each returned line's price variance is capped at its share of the credit and the rest goes on the other goods lines (a residue no line can take stays on transit with a warning); the "gives nothing to the returned line" refusal is gone.
- Posting a credit compares, under the lock, the bill's totals, rate and per-line tax treatment, the other credits on it and the credit's own amount; any change leaves it a draft to post again.
- The demo-tenant probe step now says when (before the interlock release) and how to run it.
- Migration `20261127200000_purchase_fx_non_ims_bill_approvals` (additive: a new table; no backfill).
