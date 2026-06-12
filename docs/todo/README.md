# Open implementation plans (`docs/todo/`)

Plans in this directory still have outstanding work. Each plan owns a phased breakdown, acceptance criteria, and open questions so it can be picked up directly by an agent or contributor.

For plans that have shipped end-to-end, see `docs/completed/`.

## Plans

### Released v2.0.0 follow-ups

- [`xero-tax-rate-drift-detection-plan.md`](xero-tax-rate-drift-detection-plan.md) — daily cron that compares IMS `TaxRate` profiles to live Xero `TaxComponents` and alerts on drift without writeback. Completes the residual scope from PR #186.
- [`quickbooks-tax-parity-plan.md`](quickbooks-tax-parity-plan.md) — brings QBO to feature parity with Xero for sales/purchase invoice updates and the reverse-charge tax-type swap; documents the gap on `TaxComponents` (no QBO API).
- [`reorder-row-selection-plan.md`](reorder-row-selection-plan.md) — per-row checkboxes on the Reorder Planning report so the operator can scope the Generate button to a subset of rows. Deferred from PR #190.

### Connector boundary + new connectors

- [`connector-groundwork-plan.md`](connector-groundwork-plan.md) — preparing the codebase for multiple shopping connectors running in parallel.
- [`shopify-connector-followup-plan.md`](shopify-connector-followup-plan.md) — shared work after the connector-owned Shopify implementation.
- [`mintsoft-wms-connector-plan.md`](mintsoft-wms-connector-plan.md) — architectural design for the Mintsoft warehouse connector.
- [`mintsoft-wms-connector-implementation-plan.md`](mintsoft-wms-connector-implementation-plan.md) — concrete file-by-file build plan for the Mintsoft connector.
- [`WC-followup-plan.md`](WC-followup-plan.md) — WooCommerce work remaining after the webhook-first shift.
- [`xero-followup-plan.md`](xero-followup-plan.md) — Xero connector boundary work needed before a clean swap to a different accounting connector.

### Unified FX rates

- [`unified-fx-rates-plan.md`](unified-fx-rates-plan.md) — make IMS the single source of truth for FX rates across WooCommerce and Xero.
- [`unified-fx-rates-cutover.md`](unified-fx-rates-cutover.md) — Phase 5 production cutover runbook.

### Future modules

- [`voucher-credit-system-plan.md`](voucher-credit-system-plan.md) — unified gift card / store credit / loyalty module with external ledger sync.
