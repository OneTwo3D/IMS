# Open implementation plans (`docs/todo/`)

Plans in this directory still have outstanding work. Each plan owns a phased breakdown, acceptance criteria, and open questions so it can be picked up directly by an agent or contributor.

For plans that have shipped end-to-end, see `docs/completed/`.

## Plans

### Released v2.0.0 follow-ups

- [`xero-tax-rate-drift-detection-plan.md`](xero-tax-rate-drift-detection-plan.md) — daily cron that compares IMS `TaxRate` profiles to live Xero `TaxComponents` and alerts on drift without writeback. Completes the residual scope from PR #186. **Not yet started.**
- [`quickbooks-tax-parity-plan.md`](quickbooks-tax-parity-plan.md) — brings QBO to feature parity with Xero for sales/purchase invoice updates and the reverse-charge tax-type swap; documents the gap on `TaxComponents` (no QBO API). **Partial: reverse-charge swap shipped; `SALES/PURCHASE_INVOICE_UPDATE` still unimplemented.**
- [`reorder-row-selection-plan.md`](reorder-row-selection-plan.md) — per-row checkboxes on the Reorder Planning report so the operator can scope the Generate button to a subset of rows. Deferred from PR #190. **Not yet started.**

### Connector boundary + new connectors

- [`shopify-connector-followup-plan.md`](shopify-connector-followup-plan.md) — shared work after the connector-owned Shopify implementation. **Open: sync-job cron entrypoints, fulfillment creation, location mapping.**
- [`mintsoft-wms-connector-plan.md`](mintsoft-wms-connector-plan.md) — architectural design for the Mintsoft warehouse connector. **Partial: Phases 1–4 shipped; 2b/5/6/7 outstanding.**
- [`mintsoft-wms-connector-implementation-plan.md`](mintsoft-wms-connector-implementation-plan.md) — concrete file-by-file build plan for the Mintsoft connector. **Partial: Phases 1–3 in prod; ALIGN_TO_WMS, ASN/booked-in, returns inbox outstanding.**
- [`WC-followup-plan.md`](WC-followup-plan.md) — WooCommerce work remaining after the webhook-first shift. **Phases 1–4 closed; Phase 5 (sweep `wc_*` bindings behind generic selectors) open.**
- [`xero-followup-plan.md`](xero-followup-plan.md) — Xero connector boundary work needed before a clean swap to a different accounting connector. **Items 1–3 in progress, 5–7 open.**

### Future modules

- [`voucher-credit-system-plan.md`](voucher-credit-system-plan.md) — unified gift card / store credit / loyalty module with external ledger sync. **Design baseline only; no code yet.**

For plans that have shipped end-to-end, see [`../completed/`](../completed/) — including the workflow-audit remediation (epic `r3xh`), connector groundwork (epic `b8i6`), and the unified FX-rates plan + cutover runbook.
