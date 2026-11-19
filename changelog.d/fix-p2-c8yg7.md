### #1061 follow-ups: held-create evidence, content refusal back-off, lease and shipping-VAT lows (warehouse, first-load)
- The warehouse reconcile's held-create read now answers once per order (`DISTINCT ON`), so orders edited while held (several shadow rows each) no longer starve the other orders of a batch and their NOT_PUSHED findings close with the hold as intended.
- A Mintsoft content update answered `Success: false` is recorded against the value, retried with a growing wait (30 min, 2 h, 8 h, 24 h) and, after five refusals, no longer sent; one open `PRODUCT_CONTENT_REFUSED` discrepancy names the field. A changed value or a later accepted send clears it. Unanswered requests are not counted.
- The content state's compare-and-swap fallback keeps the other run's hash when both runs sent the same value, and writes conditionally.
- First-load apply: a run lease lost at the very end reports the step results, verification and the persisted record the run produced (still not a success), instead of an empty STEP_FAILED with the stale record.
- The shared advisory-lock pool is back to 4 connections per process (6 was not needed: a competing runner is a separate process).
- Mintsoft shipping VAT (`mintsoft_send_shipping_vat`, default off): never derived or sent when the order has no shipping charge, and with the setting on the push total guard and the audit intent now carry the same shipping VAT that goes on the wire.
- Docs: the extra shadow row per held order is documented in docs/mintsoft.md; help-docs/warehouse.md describes the content refusal discrepancy.
- Migration: adds the `PRODUCT_CONTENT_REFUSED` value to the `WmsDiscrepancyCategory` enum (additive).
