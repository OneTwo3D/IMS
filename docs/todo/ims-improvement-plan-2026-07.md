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
| B1 | Transit (`STOCK_IN_TRANSIT`) GL account has **no** reconciliation sweep — only INVENTORY + COGS are tied out. This is epic `khdw`'s remaining deliverable; design spec + open finance question (expected-transit-balance basis) live there | `account-gl-reconciliation.ts:20`; `daily-sync.ts:1325,1364`; no transit module | **6oyu.4 (P2)** → epic khdw |
| B2 | Refund COGS reversal uses **current** layer cost, not originally-posted COGS — landed-cost revaluation after dispatch leaves a residual. Needs a finance decision (carrying-value vs posted-COGS reversal) | `refund-service.ts:962-968` (explicit trade-off comment) | **6oyu.5 (P2)** |
| B3 | Xero payment-reversal/chargeback detection **covered MANUAL orders only** — WC-paid orders were excluded — **FIXED** (PR #480): the **reversal** pass (paid→reversed) now covers ALL sales orders incl. WC-linked, clearing `paidAt` + unwinding revenue on a chargeback regardless of channel; only the **forward** pass still (correctly) skips WC, as those arrive already paid. Policy is detect+notify with **no** status auto-revert by design, and the WC refund webhook stays authoritative via a per-order dedup guard | `payment-poller.ts:6,121-175` | **6oyu.6 (P2)** ✅ |
| B4 | Retrospective-COGS exclusion lists are hand-maintained per movement type — a future non-customer movement type silently corrupts revaluation COGS | `cost-layers.ts:865-906` | **6oyu.7 (P3)** |
| B5 | FIFO sub-tolerance shortfall absorbed with only `console.warn` — invisible to finance | `cost-layers.ts:342-350` | **6oyu.8 (P3)** |
| B6 | Xero follow-up plan correctness items still open: VAT liability posting, request idempotency, failed-sync completeness hardening | `docs/todo/xero-followup-plan.md` Item 7 | **6oyu.9 (P3)** |
| B7 | QBO parity: document-update sync unsupported (edits silently diverge the QBO GL); reverse-charge swap unwired — parked until QBO is an active connector | `quickbooks/sync-processor.ts:411`; `docs/todo/quickbooks-tax-parity-plan.md` | **6oyu.10 (P4)** |
| B8 | **Landed-cost revaluation double-counted TRANSFER_OUT units.** `consumedQty` is layer-derived but every exclusion was a `cogsEntry` query, and TRANSFER_OUT writes none (it stores a `costLayerSnapshot`) — so transferred units posted spurious COGS on the source *while* `propagateLandedCostToOutputs` also (correctly) revalued the destination layer via the `costLayerSourceLine` link. Transit drained twice; a permanent balance was stranded. Real misstatement — **FIXED** via `getTransferConsumedQtyForCostLayer` (snapshot-sourced) | `transfers.ts:494,536,707-718`; `landed-cost-service.ts:214,1037`; `cost-layers.ts:920-933` | **6oyu.19 (P1)** ✅ |
| B9 | Landed-cost revaluation posts generic reason-coded `ADJUSTMENT` deltas to COGS, though the original write-off posted DR reason-account / CR inventory. Magnitude right, account imprecise — **ACCEPTED, no action** (see below) | `stock-adjustment-apply.ts:237,278,291,312`; `app/actions/stock.ts:639-652` | **6oyu.20 (P3)** ✅ |

> B8/B9 were found on 2026-07-15 while building B4's registry — which is exactly the point of B4. Both were invisible to the `cogsEntry`-based audit queries that surfaced every earlier exclusion (audit-jz9i, scjz.14, scjz.10), because those queries cannot see a movement type that consumes layers without writing `cogs_entries`. The registry now records that blind spot explicitly (`LAYER_CONSUMING_MOVEMENT_TYPES_WITHOUT_COGS_ENTRIES`), and each exclusion declares its `exclusionSource` (`COGS_ENTRY` vs `TRANSFER_SNAPSHOT`) so "just query cogs_entries" can never silently subtract nothing again.
>
> **B9 decision (2026-07-15) — accepted, not deferred.** Two independent reasons. (1) *Not implementable as scoped:* `StockMovement` persists no `reasonId`/`accountCode` — `applyStockAdjustment` resolves the reason only to build the journal and stores `note = "<reason.name>[: <note>]"` as free text — so the reason account is unrecoverable at revaluation time, and historical rows never stored it at all. Routing would need a schema change, a migration, a multi-account revaluation journal (it aggregates into one `settings.cogsAccount` line today), Xero/QBO payload changes, and a fallback policy for unattributable rows. (2) *Excluding without routing would be worse:* the delta would drain nothing from transit, stranding a permanent balance and understating expense — trading a reclassification for a completeness error. Including keeps transit draining fully and the P&L total correct, consistent with scjz.10 letting supplier returns ride the same COGS-adjustment journal. The registry records this as `ACCEPTED_TRADEOFF` (distinct from both `INCLUDE_IN_COGS` and `KNOWN_GAP`) so it reads as a decision, not unfinished work. Revisit only if reason attribution is ever persisted on the movement.
>
> **B8 residual — in-transit transfers.** Excluding TRANSFER_OUT is correct in both states, but the two settle differently. For a **received** transfer, propagation posts DR Inventory / CR transit on the destination, so transit drains fully. For a transfer still **IN_TRANSIT** at revaluation time, no destination layer exists yet, so nothing drains transit; `updateSnapshotsForCostLayerChange` rewrites the transfer-line snapshot so the eventual receipt creates the destination layer at the new cost — but transfers post no GL journal, so the transit balance clears only when the layer is created. This is strictly better than the old behaviour (a silent P&L misstatement) because the balance is now **visible**: 6oyu.4's `STOCK_IN_TRANSIT` subledger reconciliation sweep flags exactly this. Worth confirming during the 6oyu.4 sandbox validation.

**Accepted trade-offs (documented, no action):** tax report-type fallback to standard OUTPUT/INPUT for unknown categories (`tax-rate-report-type.ts:138`, operator corrects per-rate); £1 default GL sweep limit; accounting-event-mirror failure downgraded to WARNING (scjz.40); tax-rate drift detection alert-only by design; chargeback keeps COGS as loss without restock (scjz.71); landed-cost BOM cascade depth-20 cap; **late landed cost on reason-coded write-offs lands in COGS rather than the reason account** (6oyu.20, decided 2026-07-15 — see B9).

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
3. **6oyu.4 / .5** — GL tie-out (transit sweep, refund-COGS basis decision with finance). *(6oyu.6 WC payment reversals — done, PR #480.)*
4. **6oyu.11 / .12 / q66in.4.1** — operator visibility + bulk actions.
5. Phase C/D P3-P4 as capacity allows.

Source audits (full evidence): recovered from session 24373b8e subagent transcripts, 2026-07-11 — accounting/COGS, stock/WMS/WC sync, operator usability.
