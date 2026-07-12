# Workflow Audit Remediation Plan

Date: 2026-06-12
Branch baseline: `development` (post v2.0.0)
bd epic: `onetwo3d-ims-r3xh`

## Context

A six-domain business-workflow audit (order-to-cash, procure-to-pay, manufacturing, stock control, accounting sync, cross-cutting guards) on 2026-06-12 surfaced 5 critical, 9 high, and ~12 medium findings. No spec-vs-code drift was found — every documented state machine in `docs/workflows.md` matches the code. The gaps are in **side effects, cross-entity consistency, and edge paths**, not in the core transition graphs.

This plan sequences the fixes. Each finding is a child bd issue under epic `r3xh`. Several findings overlap existing planned work (`xero-tax-rate-drift-detection-plan.md`); those cross-references are noted.

## Severity → bd issue map

| Sev | bd | Title |
|-----|-----|-------|
| C1 | `32tm` | Three-way match: bills can be raised for unreceived goods |
| C2 | `erl0` | TrackShip delivery poll writes order status raw, skipping guards + side effects |
| C3 | `9hj3` | Cancelling a freight PO doesn't revert landed-cost uplift on linked primary POs |
| C4 | `pbu4` | PO returns don't create a credit memo or flag the open bill |
| C5 | `iuye` | Transfer dispatch/receive not atomic; stranded in-transit stock undetectable |
| H1 | `ezhj` | Credit notes skip the reverse-charge tax-type swap |
| H2 | `j91q` | Payment recorded without invoice when trigger is manual |
| H3 | `jpgs` | Sync success + back-reference failure orphans the external ID |
| H4 | `nmc1` | Switching accounting connector strands queued sync rows |
| H5 | `yuzg` | `*_INVOICE_UPDATE` can process before its CREATE |
| H6 | `7q5n` | BOM edits mid-production create ghost reservations |
| H7 | `0699` | Receiving allows divergence from PO destination warehouse with no warning |
| H8 | `j5ic` | PO cancellation leaves sold-unit COGS standing with no finance flag |
| H9 | `w4io` | Editing an adjustment whose layers were consumed deletes old COGS then fails |
| M | `47fa` | Order-to-cash medium cluster |
| M | `rcjf` | Manufacturing medium cluster |
| M | `gn6d` | Accounting sync medium cluster |
| M | `bkhk` | Stock/concurrency medium cluster |

## Execution sequence

The audit found that most gaps are "the system silently does the wrong thing" rather than "the system crashes." The remediation philosophy is therefore **make the gap loud before automating the fix** — a WARNING activity log + UI alert is a one-PR safety net that buys time for the deeper structural fix. Several issues below are explicitly phased this way.

### Wave 1 — Financial controls (do first)

These are the findings where money or stock can silently diverge with no signal.

1. **C1 `32tm` — three-way match.** Pass `qtyReceived` into the bill-line validator; reject billing beyond received. Highest-value single fix; closes a fundamental procure-to-pay control. ~half a day with tests.
2. **H1 `ezhj` — credit-note reverse charge.** One-function fix reusing the existing swap helper; closes an inconsistency we introduced ourselves in PR #183. ~1-2 hours.
3. **C2 `erl0` — TrackShip raw writes.** Route through `applySalesOrderStatusTransition` with the internal bypass; restores guards + side effects for cron-detected delivery. Touches the guard architecture so worth doing carefully.
4. **H8 `j5ic` + C4 `pbu4` — purchasing reversals (phase 1, alerts only).** Both are "operator can't see the financial consequence." Ship the WARNING + amber-alert layer for both (sold-unit COGS on cancellation; open bill on return) as one PR. The deeper credit-memo model (C4 phase 2) and COGS-correction journal (C3) come in Wave 3.

### Wave 2 — Data-integrity races + orphans

5. **H9 `w4io` — adjustment edit feasibility.** Dry-run FIFO before deleting old COGS; reject infeasible edits atomically. Self-contained, high-value.
6. **H6 `7q5n` — BOM snapshot on production order.** Snapshot component requirements at IN_PROGRESS; consume/release from the snapshot. Schema change (JSON column or child rows) + migration.
7. **H3 `jpgs` — sync back-reference repair.** Persist external id before back-reference; add a repair sweep. Prevents the worst accounting orphan.
8. **H5 `yuzg` — UPDATE-before-CREATE ordering.** Mirror the existing payment-ordering guard for invoice CREATE→UPDATE. Small, contained.

### Wave 3 — Structural / multi-PR

9. **C3 `9hj3` — freight-PO landed-cost reversal.** Re-run `recalculateLandedCosts` excluding the cancelled freight PO + queue COGS corrections. Reuses the retro-recalc machinery; needs careful testing on partial consumption.
10. **C5 `iuye` — transfer atomicity.** In-transit invariant check + idempotent retryable receive + cancel-dispatch compensation. Three sub-deliverables; can land incrementally (invariant detection first as the safety net).
11. **H4 `nmc1` — connector-switch orphans.** Blocking confirmation on switch + dashboard orphan tile.
12. **H2 `j91q` — paid-without-invoice alert.** Amber chip + one-click generate (don't auto-generate; manual trigger means operator control).
13. **H7 `0699` — receive-to-wrong-warehouse confirm.** Amber flag + confirm checkbox in the receive dialog.

### Wave 4 — Medium clusters (batch each as one PR)

14. **`47fa` order-to-cash cluster** — cumulative refund tolerance, payment-deletion status, archived-order guard, payload-hash idempotency, shipment-from-deleted-allocation guard.
15. **`rcjf` manufacturing cluster** — actual-produced quantity at completion, reorder generator idempotency, silent no-BOM-skip surfacing, disassembly fallback visibility, **circular-BOM detection** (the one with infinite-loop blast radius — could be pulled forward if BOM nesting is used in production).
16. **`gn6d` accounting cluster** — daily-batch continuation hardening, TaxRate-rename orphan (overlaps `xero-tax-rate-drift-detection-plan.md` — coordinate), payment-poll reversal detection, failed-row dashboard alerting (overlaps existing rejected-update alert work), UNEARNED_REV_REVERSAL dead-type decision.
17. **`bkhk` stock cluster** — transfer-of-allocated-stock guard, WMS+manual double-layer window, opening-stock unique constraint, transfer FIFO ordering (cosmetic), verify the `stock_levels.quantity >= 0` DB CHECK exists.

## Cross-references to existing plans

- `gn6d` item 2 (TaxRate rename orphan) and item 4 (failed-row alerting) overlap `docs/todo/xero-tax-rate-drift-detection-plan.md`. Build the drift plan's per-id TaxType storage first; the rename-orphan fix falls out of it.
- The "make it loud" alert layer reuses the rejected-sync-warnings pattern shipped in PR #177 and the multi-component-warning pattern from PR #185 — same `logActivity` + amber-alert shape.

## Process notes

- Every fix gets a domain-layer test asserting the *negative* case (the gap, before) fails and the positive case passes. Audit findings are exactly the regressions a test would have caught.
- Run the standard adversarial Codex pass after each wave's PRs per the repo convention.
- Update `docs/workflows.md` if any fix changes observable transition behaviour (e.g. C2 may add a documented note that cron-driven DELIVERED runs the same side effects as manual).

## Acceptance for the epic

`onetwo3d-ims-r3xh` closes when all 18 children are closed (or explicitly deferred with a recorded decision — e.g. the cosmetic transfer-FIFO-ordering item may be accepted-as-is).
