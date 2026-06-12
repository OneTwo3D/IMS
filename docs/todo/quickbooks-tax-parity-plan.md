# QuickBooks Tax Parity Plan

Date: 2026-06-12
Branch baseline: `development` (post v2.0.0)

## Goal

v2.0.0 added three Xero-only behaviours that have no QBO equivalent today:

1. `SALES_INVOICE_UPDATE` and `PURCHASE_INVOICE_UPDATE` sync on document edits (PRs #176, #178).
2. `TAX_RATE_SYNC` to push IMS tax components into Xero `TaxComponents` (PR #186).
3. Reverse-charge tax-type swap on lines whose `TaxRate.reverseCharge` is true (PR #183).

For each, QBO currently logs `..._skipped_unsupported_connector` activity entries instead of attempting the call. This plan brings QBO to feature parity where the QBO API supports it, and documents the gaps where it doesn't.

## Scope

### 1. Invoice + bill updates

QBO Online API supports `Invoice.Update` and `Bill.Update` with sparse updates (only changed fields are sent). The plan:

- New `lib/connectors/quickbooks/invoices.ts:updateQboInvoice(accountingInvoiceId, data, opts?)` mirroring the Xero shape.
- New `lib/connectors/quickbooks/bills.ts:updateQboBill(accountingInvoiceId, data, opts?)`.
- Sync processor `lib/connectors/quickbooks/sync-processor.ts` adds `SALES_INVOICE_UPDATE` and `PURCHASE_INVOICE_UPDATE` cases.
- Reuse the existing `accountingPayloadKey`-based idempotency. QBO's API supports `RequestId` for at-least-once safety; use the SHA256 prefix as the request id.
- Stop logging the "unsupported connector" warning for QBO once parity ships.

### 2. Tax component breakdown

QBO does not expose a direct "create tax rate with components" API on the public side. It has an Automated Sales Tax (AST) model that the merchant configures inside QBO. **This means we cannot auto-sync component shapes**.

Plan instead:

- Replace the "skip" log with an actionable warning describing the manual configuration the operator must do in QBO Automated Sales Tax (link to QBO docs).
- Surface the multi-component status on the **Sync Dashboard** as "needs manual configuration in QBO" for each affected `TaxRate`.
- Optionally write an attachment to the QBO ledger entry documenting the IMS-side component breakdown for audit reconciliation.

### 3. Reverse-charge tax-type swap

QBO does support reverse-charge through specific tax codes per jurisdiction (`REVERSECHARGE` family in QBO UK, similar in QBO France/Spain). The same settings keys IMS uses for Xero (`accounting_reverse_charge_sales_tax_type`, `accounting_reverse_charge_purchase_tax_type`) already provide the per-connector mapping. Plan:

- Wire the swap in `lib/connectors/quickbooks/invoices.ts` and `bills.ts` payload builders to consult the same setting and substitute the QBO-side tax code.
- Cost lines remain unaffected (consistent with the Xero behavior).
- Documentation: add a "Reverse charge on QBO" section to `docs/xero-sync.md` (it already covers Xero — extend the page to cover both connectors and rename it to `docs/accounting-sync.md` if useful).

## Acceptance

- Editing a sales invoice that previously pushed to QBO queues `SALES_INVOICE_UPDATE`, the processor calls QBO Invoice.Update with the right shape, and the operator sees the update in QBO.
- Same for bills.
- A reverse-charge line posts to QBO with the configured `REVERSECHARGES` tax code instead of the parent `accountingTaxType`.
- Multi-component IMS `TaxRate` rows emit a `quickbooks_tax_components_manual_configuration_required` WARNING with a docs link, and the Sync Dashboard surfaces it.

## Implementation phases

### Phase 1 — QBO invoice + bill updates (1 PR)

- `updateQboInvoice` + `updateQboBill` modules.
- Sync processor cases.
- Stop logging "unsupported connector" for the update path.
- Tests cover the request body shape against captured QBO API examples.

### Phase 2 — Reverse-charge swap on QBO (1 PR)

- Read `accounting_reverse_charge_{sales,purchase}_tax_type` in the QBO payload builders.
- Cover with a snapshot test asserting the swapped line carries the configured code.

### Phase 3 — Multi-component documentation + dashboard (1 PR)

- Replace the QBO `tax_rate_sync_skipped_unsupported_connector` WARNING with a clearer `quickbooks_tax_components_manual_configuration_required` shape including a setup link.
- Sync Dashboard tile listing affected rates.

## Risks

- QBO's automated sales tax in some regions overrides the tax code the operator sends — needs verification in the QBO Sandbox before committing to the swap behavior.
- QBO sparse-update may silently drop fields IMS expects to be present. The PR's tests need to assert full-shape parity, not just success.
