### Per-event FX rates for purchasing: a held journal of a bill posted outside IMS is visible and catches up
- Still behind `purchase_event_fx_rates_enabled` (off) and its interlock (still off); with the switch off nothing changes.
- While no Xero organisation is connected, a confirmed bill's journal is held: this is now logged once (`purchase_fx_non_ims_bill_held`), shown by `purchase-fx:reconcile` ("held: no Xero connection") and by the non-IMS bills list (not re-confirmable), and the journal catches up once the same organisation is connected again. A different organisation, even briefly, makes the confirmation stale (documented).
- A confirmation goes stale, and is warned about, exactly once; an empty frozen basis counts as none. Documented that a credit note against such a bill uses the IMS bill's rate, coded to transit.
- Migration `20261129150000_purchase_fx_non_ims_bill_held` (additive: a nullable column and an index; no backfill).
