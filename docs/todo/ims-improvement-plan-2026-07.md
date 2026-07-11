# IMS Improvement Plan — July 2026 (PM / developer / user review)

**Date:** 2026-07-11 · **Tracking epic:** `onetwo3d-ims-6oyu`

Outcome of a product-review exercise: a senior product manager, the senior developer, and a senior daily user walked through the IMS as shipped, against the target of running onetwo3d's inventory with WooCommerce + Xero + Mintsoft — accurate, user-friendly, and error-free on accounting, COGS, and stock levels. Method: three parallel evidence-backed audits (accounting/COGS, stock/WMS/WC sync loop, operator usability); every item below carries code/doc evidence — nothing speculative. Findings already tracked in bd were re-prioritized rather than duplicated.

Headline: the quantity/costing core is in good shape after the COGS audit season (epics scjz, zex3, blq0 all closed). The remaining exposure is concentrated in **one-way auto-correction, invisible failure states, and GL tie-out edges** — plus daily-operator click cost.

---

## Phase A — Stop silent stock drift (do first)

The through-line: when the 3PL holds **less** than IMS believes (shrinkage, already-shipped, oversell), nothing auto-heals and nothing alerts. A1+A2 together close the oversell loop.

| # | Item | Evidence | bd |
|---|------|----------|----|
| A1 | Mintsoft ALIGN_TO_WMS never corrects **downward** deltas — the actual shrinkage/oversell case only logs a `QTY_MISMATCH` and waits for a human; IMS keeps overstated availability and keeps accepting WC orders | `lib/connectors/mintsoft/sync/stock-sync.ts:626` (delta ≤ 0 early-return: "align-down remains manual") | **6oyu.1 (P1)** |
| A2 | Dead-letter / exception inbox — dead-lettered WMS order pushes are visible only via the per-order chip; an order nobody opens never fulfils, silently. Scope extended to refund-sync parked rows and penny-mismatch flags | `lib/domain/wms/order-push-sweep.ts:347+`; `refund-sync.ts:146-224`; no dashboard consumer of the admin replay routes | **q66in.4.2 (P3→P1)** |
| A3 | Despatched-but-unreconcilable orders re-error on every sweep forever — no dead-letter, no alert (the oversell aftermath) | `lib/domain/wms/dispatch-sweep.ts:321-324` (documented known limitation) | **6oyu.2 (P2)** |
| A4 | No scheduled full order-level reconciliation (IMS intent vs WMS truth); drift outside the push-link happy path is undetected | audit stock #5 | **q66in.4.4 (P3→P2)** |
| A5 | Stocktake posting is WMS-unaware — a manual count against a Mintsoft-mirrored warehouse fights the next stock sync (oscillation) | `lib/domain/inventory/stock-count.ts` (`computeStockCountPostings` has no WMS awareness) | **6oyu.3 (P2)** |
| A6 | ASN/booked-in silent-failure alerting: a dropped booked-in webhook leaves stale alignment credits that suppress real PO receipts — silent stock loss | `stock-sync.ts:1489-1541`; "open ASN with no callback after ETA" SLO unbuilt | **q66in.4.6 (P3→P2)** |

## Phase B — Accounting / COGS tie-out

| # | Item | Evidence | bd |
|---|------|----------|----|
| B1 | Transit (`STOCK_IN_TRANSIT`) GL account has **no** reconciliation sweep — khdw intent unmet; only INVENTORY + COGS are tied out | `account-gl-reconciliation.ts:20`; `daily-sync.ts:1325,1364`; no transit module | **6oyu.4 (P2)** |
| B2 | Refund COGS reversal uses **current** layer cost, not originally-posted COGS — landed-cost revaluation after dispatch leaves a residual. Needs a finance decision (carrying-value vs posted-COGS reversal) | `refund-service.ts:962-968` (explicit trade-off comment) | **6oyu.5 (P2)** |
| B3 | Xero payment-reversal/chargeback detection covers MANUAL orders only — WC-paid orders (most of onetwo3d's volume) are excluded; order status never auto-reverts on reversal | `payment-poller.ts:130` (`shoppingLinks:{none:{}}`), `:121-175` | **6oyu.6 (P2)** |
| B4 | Retrospective-COGS exclusion lists are hand-maintained per movement type — a future non-customer movement type silently corrupts revaluation COGS | `cost-layers.ts:865-906` | **6oyu.7 (P3)** |
| B5 | FIFO sub-tolerance shortfall absorbed with only `console.warn` — invisible to finance | `cost-layers.ts:342-350` | **6oyu.8 (P3)** |
| B6 | Xero follow-up plan correctness items still open: VAT liability posting, request idempotency, failed-sync completeness hardening | `docs/todo/xero-followup-plan.md` Item 7 | **6oyu.9 (P3)** |
| B7 | QBO parity: document-update sync unsupported (edits silently diverge the QBO GL); reverse-charge swap unwired — parked until QBO is an active connector | `quickbooks/sync-processor.ts:411`; `docs/todo/quickbooks-tax-parity-plan.md` | **6oyu.10 (P4)** |

**Accepted trade-offs (documented, no action):** tax report-type fallback to standard OUTPUT/INPUT for unknown categories (`tax-rate-report-type.ts:138`, operator corrects per-rate); £1 default GL sweep limit; accounting-event-mirror failure downgraded to WARNING (scjz.40); tax-rate drift detection alert-only by design; chargeback keeps COGS as loss without restock (scjz.71); landed-cost BOM cascade depth-20 cap.

## Phase C — Operator efficiency & visibility

| # | Item | Evidence | bd |
|---|------|----------|----|
| C1 | Unified **"Needs attention"** surface — today failures scatter across the bell (8 `notify()` sites; none for dead-letters or failed batch rows), `/sync` banners, and the reactive activity log | usability audit 1a/1b/1c | **6oyu.11 (P2)**, depends on q66in.4.2 |
| C2 | Sales-order list **bulk actions** (select rows → allocate / advance status / batch-print) — currently every order is opened individually; the single biggest daily click cost | `so-list-client.tsx` (no row selection) | **6oyu.12 (P2)** |
| C3 | Stock-accuracy / sync-health dashboard — ~45 analytics pages, none for sync health or IMS-vs-WMS accuracy trends | usability audit 5a | **q66in.4.1 (P3→P2)** |
| C4 | Help docs for Mintsoft/WMS operations + integrations dashboard — the most operationally complex screen has no doc (18 help-docs exist, none cover it) | `help-docs/` | **6oyu.13 (P3)** |
| C5 | Settings consolidation: outbound-email config split across Company/Sales; integrations vs plugin toggles split; notification-preferences UI claimed in docs but absent | usability audit 2a/2b/2c | **6oyu.14 (P3)** |
| C6 | Barcode scan for IMS-native stock counts (Mintsoft owns pick/pack, so scoped to counts/adjustments) | usability audit 6a | **6oyu.15 (P4)** |

## Phase D — Cutover & platform notes

- **Plugin-retirement coexistence hazard:** while IMS and the legacy woo-mintsoft bridge are both live, only ONE may write back to WC or customers get double partial-shipment rows / double despatch emails. Cutover rule + AST Pro despatch-email confirmation (G5 ◐) in `docs/todo/woo-mintsoft-plugin-parity-gap.md`. Operational checklist, not code.
- KIT/bundle SKUs are pushed to the WMS verbatim; fulfilment silently depends on bundle-sync lockstep → **6oyu.16 (P3)**.
- `MISSING_IN_IMS` discrepancy category defined but never emitted → **6oyu.17 (P4)**.
- ShipHero items stay parked behind a live tenant: outbound-push verification (h02x.11), ALIGN auto-correction (ku89), product/kit/returns/ASN sync (h02x.5–.8).

---

## Recommended order

1. **6oyu.1** (align-down) + **q66in.4.2** (exception inbox) — closes the "IMS oversells and nobody notices" loop end to end.
2. **6oyu.2 / q66in.4.4 / 6oyu.3 / q66in.4.6** — the remaining Phase A drift-and-silence items.
3. **6oyu.4 / .5 / .6** — GL tie-out (transit sweep, refund-COGS basis decision with finance, WC payment reversals).
4. **6oyu.11 / .12 / q66in.4.1** — operator visibility + bulk actions.
5. Phase C/D P3-P4 as capacity allows.

Source audits (full evidence): recovered from session 24373b8e subagent transcripts, 2026-07-11 — accounting/COGS, stock/WMS/WC sync, operator usability.
