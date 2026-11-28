### Per-event FX rates for purchasing: staleness of confirmed bills posted outside IMS
- Still behind `purchase_event_fx_rates_enabled` (off) and its interlock (still off); with the switch off nothing changes.
- Turning the switch on now requires `--env-file` (the env file the application's service runs with, its single source of environment), and the file must set `PRODUCER_HOLD_ENFORCED_DESTINATIONS`; the shell is no longer consulted.
- A confirmation also goes stale when the connected Xero organisation is not the one the bill was read from, when it recorded no organisation, or when it was made before the basis was frozen; with no Xero connection its journal is only held. The dry run judges staleness itself; a confirmation going stale is logged once (`purchase_fx_non_ims_bill_stale`); a re-confirmation keeps the confirmation it replaces in a history table.
- Documented what a bill delete, a credit note, a return and a receipt removal do to a confirmed bill.
- Migration `20261129090000_purchase_fx_non_ims_bill_approval_history` (additive: a new table; no backfill).
