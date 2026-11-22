# khdw design — extend GL reconciliation sweep to COGS + transit accounts

## Goal
Extend the existing inventory subledger-vs-GL rounding sweep (scjz.60.4) to the
COGS account and the transit/clearing account, so the sub-penny 6dp-subledger-vs-
2dp-GL residue ties out each batch instead of accumulating.

## Existing mechanism to mirror (lib/domain/accounting/inventory-gl-reconciliation.ts)
- `evaluateInventoryGlReconciliation({subledgerValue, glBalance, sweepLimit})` →
  balanced | sweep | flag (delta = subledger − GL; |delta|≤limit ⇒ sweep else flag).
- `loadInventoryGlReconciliation()` → subledger = inventory_snapshots as-of GL date;
  GL = inventory + allocated account-balance snapshots (same date).
- `buildInventoryReconciliationSweepJournal()` → pure balanced DR/CR sweep journal.
- Wired in xero/daily-sync.ts:1286-1315 (+ qbo) behind hasLiveDailyBatchLog idempotency,
  type DAILY_BATCH_INVENTORY_RECONCILIATION. SAFETY: only sub-penny sweeps; material→flag.

## Plan: generic account reconciliation
Refactor the inventory evaluator/sweep-builder into an account-agnostic core
(`evaluateAccountGlReconciliation`, `buildAccountReconciliationSweepJournal(account,
roundingAccount, recon, label)`), then add two subledger providers.

### COGS subledger — CORRECTED 2026-06-23 (investigation under khdw resume)
- ⚠️ ORIGINAL BASIS WAS UNSOUND. "Σ all cogs_entries.totalCostBase" does NOT tie to the
  GL COGS account. Verified by enumerating posting sites:
  - GL COGS account is posted ONLY by: (a) daily-batch Group B dispatch COGS
    (xero/daily-sync.ts:471/1201, qbo:407/1097 — round2(summary.cogs) debit from
    SALE_DISPATCH shipment movements); MINUS (b) refund COGS reversals
    (refund-service.ts:1319 — credit COGS at 2dp = roundQuantity(sumCostLayerSnapshot,2)).
  - cogs_entries is written from 7 sites (shipment-service:414 SALE_DISPATCH,
    po-cancellation:247, manufacturing:668/776, purchase-orders:2223, stock:251/855) —
    most post to OTHER GL accounts (WIP, inventory-adjustment, transit), NOT COGS.
  - Refund COGS reversals credit GL COGS but write NO cogs_entry.
  → CORRECT 6dp COGS subledger MOVEMENT over (prevSnapshotDate, snapshotDate]:
      Σ cogs_entries.totalCostBase WHERE movement.type = SALE_DISPATCH   (6dp dispatch COGS)
    − Σ refund cost-layer-snapshot base value for COGS_REVERSALs in window (6dp reversal)
    Compared against the COGS account GL period movement (getAccountBalancePeriodMovement).
    The residue is then purely 2dp-vs-6dp rounding on each posting — exactly what to sweep.
  - SAFETY still holds regardless: any basis imperfection that is material FLAGS (never
    sweeps), because |delta|>sweepLimit ⇒ flag. The corrected basis is about USEFULNESS
    (per-batch tie-out vs permanent flag), not safety.
- (Legacy period-alignment notes retained below for context.)
- SUBTLETY (period alignment): COGS is a P&L account that resets each financial year;
  cogs_entries are cumulative since inception. Options:
  (a) compare the COGS account's LIFETIME cumulative movement (sum of all COGS journal
      debits) — but the GL snapshot is a point-in-time balance (FY-to-date), not lifetime.
  (b) scope cogs_entries to the GL balance's period (FY-to-date by the snapshot's FY start).
  (c) reconcile the PERIOD MOVEMENT: Δsubledger vs ΔGL between two snapshot dates
      (account-balance-snapshots already stores period movement) — avoids absolute-period
      alignment entirely and directly targets per-batch rounding accumulation.
  → RECOMMEND (c): reconcile the cogs_entries created in (prevSnapshotDate, snapshotDate]
    against the COGS account's GL movement over the same window. Period-neutral, finance-neutral.

### Transit subledger (no subledger table)
- Transit is a clearing account written from 5 lifecycle sites (purchase-invoice-edit,
  landed-cost-service, supplier-credit-note, cancellation-service, stock receipt).
- Subledger truth options: (a) Σ IMS-emitted transit journal LINES across synced sync-log
  (pure GL tie-out — finance-neutral, targets the 6dp-line-vs-2dp-GL residue directly);
  (b) "open freight" (finance-policy heavy). → RECOMMEND (a), and likewise reconcile the
  PERIOD MOVEMENT (transit lines emitted in the window vs GL transit movement) to avoid
  absolute-balance alignment.

## SAFETY (same as inventory)
- Sweep ONLY when |delta| ≤ sweepLimit (pure rounding); material gaps FLAG, never post.
- So any imperfection in the subledger basis is bounded to ≤ sweepLimit per batch and
  material misclassification flags rather than posts. New journal types
  DAILY_BATCH_COGS_RECONCILIATION / DAILY_BATCH_TRANSIT_RECONCILIATION, idempotent.

## Validation
- Unit-test the pure evaluator + sweep builder + each subledger provider.
- Demo-validate the POSTING PLUMBING on the live Xero Demo company (controlled data):
  construct a scenario with a known sub-penny residue, run the daily batch, confirm a
  balanced DAILY_BATCH_*_RECONCILIATION manual journal posts (status SYNCED).

## Open questions for adversarial review
- Is period-MOVEMENT reconciliation (option c) sound vs absolute-balance? Does
  account-balance-snapshots actually expose a reliable period movement for an arbitrary
  account, and is the COGS/transit GL movement comparable to the IMS subledger movement?
- Σ IMS-emitted transit journal lines: is the sync-log payload reliably queryable for
  per-account line sums, and does it correctly net DR/CR? Are there transit postings that
  bypass the sync log?
- Could reconciling COGS (a P&L account) ever sweep a real misstatement into the rounding
  account? Confirm the flag-vs-sweep boundary holds for P&L accounts.
- Risk of double-counting if a reconciliation journal itself posts to COGS/transit.
