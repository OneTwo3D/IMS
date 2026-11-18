### Held-release loop, TrackShip re-check, coverage guard and cancelled-order mirror fixes

- A held WooCommerce sales invoice that an operator has marked handled (or posted by hand) is now closed by the sweep instead of being reported as "NOTHING will post" on every run.
- When IMS pushes changed tracking to WooCommerce, an order the TrackShip re-fire sweep had closed as covered is re-opened so the new tracking number is checked. The sweep itself is still off by default (`trackship_refire_enabled`).
- A sales order whose total cannot be read no longer lets a payment disappearing from the ledger count as a reversal when its paid flag was entered off-ledger; the reversal is withheld.
- Cancelling an order now also retires a mirrored accounting event that an earlier "not posted" settlement had left revivable.
