# IMS↔Xero TaxRate Drift Detection Plan

Date: 2026-06-12
Branch baseline: `development` (post v2.0.0)

## Goal

PR #186 added IMS→Xero `TaxRate` sync via the `TaxComponents` API. The sync fires whenever an IMS `TaxRate` row with components is saved. What is missing is the **reverse direction**: when an operator edits the matching `TaxRate` directly in Xero (e.g. tweaks a component rate from 7.00% to 7.50%) IMS never notices and the next sales/purchase invoice posts with the IMS-side definition, immediately conflicting with the Xero-side numbers on the VAT return.

This plan adds a daily reconciliation cron that compares the IMS `TaxRate` profile against the live Xero `TaxRate` (by name) and surfaces drift to the operator without auto-overwriting either side.

## Non-goals

- Auto-resync from Xero to IMS. Drift detection is an alert, not a writeback. The operator decides which side is correct and triggers the existing IMS-side sync after correcting whichever shape was wrong.
- QuickBooks parity. QBO has no equivalent `TaxComponents` API; see `quickbooks-tax-parity-plan.md`.

## Scope

1. New cron endpoint `GET /api/cron/xero-tax-rate-drift` (CRON_SECRET-protected, hourly rate-limited).
2. New domain helper `lib/connectors/xero/tax-rates.ts:fetchXeroTaxRate(name)` to GET a single `TaxRate` by name (Xero supports `?where=Name=="..."`).
3. Comparison helper `lib/connectors/xero/tax-rate-drift.ts:computeTaxRateDrift(imsRate, xeroRate)`:
   - Compare `Name`, `ReportTaxType`, component list (name, rate, IsCompound).
   - Output a typed diff (`equal | mismatch`) plus a list of human-readable change lines.
4. Sweeper:
   - Load all active IMS `TaxRate` rows with at least one active component.
   - For each, fetch the live Xero rate.
   - On `mismatch`, write an `ActivityLog` row with `tag: 'accounting'`, `action: 'tax_rate_drift_detected'`, `level: 'WARNING'`, metadata listing the changes.
   - Maintain a `lastDriftCheckedAt` setting key per rate so the UI can show "checked 4 hours ago".
5. UI: surface drift on the **Settings > Accounting > VAT rates** table as a yellow chip on the affected row plus a tooltip describing the diff. Also surface in the **Sync Dashboard** as an aggregated count.
6. Test seam: helper functions accept a `fetchXeroTaxRate` dep so the comparison logic is unit-testable without hitting Xero.

## Acceptance

- Editing a tax rate's component in Xero produces a `tax_rate_drift_detected` activity log within one cron cycle (worst case 1 hour).
- The Settings > Accounting > VAT rates page shows the affected rate with the drift chip and a tooltip listing what differs (e.g. "PST component rate: IMS 7.00%, Xero 7.50%").
- Operator clicks "Push from IMS" on the row to overwrite Xero, or edits the IMS side to match Xero — either path clears the drift on next check.
- A unit test covers a 3-way drift (rate change, name change, component added) and asserts the diff shape; another test covers `equal` (no drift) does not log.

## Implementation phases

### Phase 1 — Domain + tests (1 PR)

- `lib/connectors/xero/tax-rates.ts:fetchXeroTaxRate(name)` wrapping Xero `GET /TaxRates?where=Name=="..."`.
- `lib/connectors/xero/tax-rate-drift.ts:computeTaxRateDrift` + `formatDriftLines` helpers.
- Unit tests in `tests/connectors/xero-tax-rate-drift.test.ts` covering: equal, mismatched parent, mismatched component, missing-on-xero, missing-on-ims.

### Phase 2 — Sweeper + activity log (1 PR)

- New `lib/connectors/xero/tax-rate-drift-sweeper.ts` orchestrating the per-rate check.
- Activity log emission with structured metadata so the UI can render the diff lines without re-fetching.
- Cron endpoint at `app/api/cron/xero-tax-rate-drift/route.ts` reusing existing CRON_SECRET + rate-limit middleware. Default cadence: every 60 minutes.

### Phase 3 — UI surfacing (1 PR)

- `components/settings/tax-rates-table.tsx` reads the latest `tax_rate_drift_detected` activity log per rate and renders the chip + tooltip + "Resync from IMS" action.
- Sync dashboard tile shows the count of rates with current drift.

## Open questions

- Should the cron also alert when an IMS `TaxRate` exists with components but has no matching Xero row at all? Probably yes — `mismatch: missing-on-xero` with a "Push to Xero" CTA.
- For multi-tenant deployments, scope the cron per tenant; reuse the existing tenant resolver.
