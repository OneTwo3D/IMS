### Per-event FX rates for purchasing: a prepayment that does not match the order's total is reported
- Still behind `purchase_event_fx_rates_enabled` (off) and its interlock (still off); with the switch off nothing changes.
- When a Xero supplier prepayment is stored as an order's exchange-rate lock, IMS compares its total with the order's foreign total. A difference of more than 0.01 writes one WARNING activity entry (`xero_prepayment_total_mismatch`, with both totals and the difference) and a console warning. A re-read of the same prepayment does not warn again.
- Advisory only: the lock, the rate and every receipt are unchanged. A deposit or part payment is reported too.
