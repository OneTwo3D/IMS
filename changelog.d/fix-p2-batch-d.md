### Xero sync fixes

- The Xero posting drain now claims each queued job only when its attempt is about to start, and stops claiming new jobs once half the claim lease has passed in one run. Before, a whole batch was claimed at once, so a job at the back of a slow batch could look abandoned before it was tried. Anything not reached stays queued for the next run.
- When a first customer-payment post to Xero is refused because the invoice already holds a hand-entered payment IMS cannot read, the refusal now says what lifts it: open the payment in Xero and, if it is not this receipt, record "Checked the ledger" on the Accounting Sync page for that entry.
- No migration.
