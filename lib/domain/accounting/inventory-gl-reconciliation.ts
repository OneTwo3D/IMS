import { db } from '@/lib/db'
import { startOfNextBusinessDay } from '@/lib/domain/inventory/inventory-snapshot'
import { loadInTransitTransferValues, sumInTransitValue } from '@/lib/domain/inventory/transfer-in-transit-value'
import { getBaseCurrencyCode } from '@/lib/base-currency'
import { getAccountingSettings, getActiveAccountingConnectorInfo, getAccountingSettingsFor } from '@/lib/accounting'
import { AccountBalanceMovementWithheldError, balanceDateString, findLatestConfiguredAccountBalanceSnapshot, glLegProvenance } from './account-balance-snapshots'
import {
  DEFAULT_GL_SWEEP_LIMIT,
  DEFAULT_RECURRING_SWEEP_CAP,
  buildAccountReconciliationSweepJournal,
  guardRecurringSweep,
  evaluateAccountGlReconciliation,
  type AccountGlReconciliation,
  type AccountGlReconciliationAction,
  type GlLegProvenance,
  type AccountReconciliationSweepJournal,
} from './account-gl-reconciliation'

/**
 * Reconcile the 2dp GL inventory balance against the 6dp cost-layer subledger
 * (cogs-audit scjz.60c / scjz.74).
 *
 * The cost-layer subledger carries inventory value at 6dp; the GL inventory
 * account can only hold 2dp, so a sub-penny residue is expected and harmless.
 * This evaluator classifies the gap:
 *
 *   - `balanced` — the rounded subledger equals the GL balance to the penny.
 *   - `sweep`    — the gap is within the rounding-scale sweep limit, i.e. pure
 *                  accumulated rounding. scjz.60c-2 posts a rounding-difference
 *                  line for exactly this case so the subledger ties to the GL.
 *   - `flag`     — the gap exceeds the sweep limit, so it is NOT pure rounding.
 *                  This is a real reconciliation discrepancy and must be
 *                  surfaced, never swept into the rounding-difference account
 *                  (sweeping it would mask a genuine misstatement — the same
 *                  class of trap that made the scjz.13 "fix" actively harmful).
 *
 * `delta` is `subledger - GL`: the amount the GL inventory balance must move by
 * (positive = GL is understated vs the subledger) to tie out.
 */
// Inventory reconciliation is now a thin specialisation of the account-agnostic
// core (cogs-audit khdw). These aliases/wrappers preserve the original public API
// and output strings (exercised by inventory-gl-reconciliation.test.ts) while the
// money logic lives once in account-gl-reconciliation.ts.
export type InventoryGlReconciliationAction = AccountGlReconciliationAction

export type InventoryGlReconciliation = AccountGlReconciliation

/**
 * Default ceiling for treating an inventory GL gap as pure accumulated rounding.
 * The reconciliation runs per batch and sweeps each period, so the genuine
 * rounding residue stays well under one currency unit; a £1 ceiling absorbs that
 * while still flagging any material inventory misstatement (which is orders of
 * magnitude larger). Tunable per call.
 */
export const DEFAULT_INVENTORY_GL_SWEEP_LIMIT = DEFAULT_GL_SWEEP_LIMIT

export function evaluateInventoryGlReconciliation(input: {
  subledgerValue: number
  glBalance: number
  sweepLimit?: number
}): InventoryGlReconciliation {
  return evaluateAccountGlReconciliation(input)
}

export type InventoryGlReconciliationUnavailableReason =
  | 'no_account_configured'
  | 'no_gl_snapshot'
  | 'account_identity_unproven'
  | 'gl_balance_unproven'
  | 'no_subledger_snapshot'
  | 'unreliable_subledger_snapshot'

export type InventoryGlReconciliationResult =
  | { available: false; reason: InventoryGlReconciliationUnavailableReason }
  | ({ available: true; balanceDate: string; /** The snapshot's on-hand value (cost layers in warehouses) and, as its own line, the stock in transit on dispatched transfers; subledgerValue is their sum. */ onHandValue?: number; inTransitValue?: number; /** Transfers whose in-transit value could not be measured (a dispatch or receipt movement carries no value): left out of the sub-ledger, listed here. */ unvaluedTransitTransfers?: string[]; /** Set when the date's comparison must not be swept to the ledger: an unvalued transfer is outside it. */ sweepWithheld?: 'unvalued_transit_transfers'; /** Where each of the two stored balances came from; `proven-absent` is a zero Xero never reported (an omitted account of a Trial Balance that proved itself complete), compared as the real zero it is. */ glProvenance?: Record<string, GlLegProvenance> } & InventoryGlReconciliation)

/**
 * Load the inventory GL reconciliation as of the latest synced GL balance date:
 * the cost-layer subledger value vs the GL on-hand value (scjz.60c / scjz.74).
 *
 * Two subtleties make a naive comparison wrong (both surfaced by Codex on the
 * first cut), so this measures BOTH sides at the same instant and scope:
 *
 *  - GL on-hand value = Inventory account + Allocated Inventory account. Once an
 *    order passes Group A2 (allocation) the daily batch has moved value from
 *    Inventory into the Allocated-Inventory contra, but the cost layers still
 *    carry that stock until dispatch — so the subledger must be compared against
 *    BOTH GL accounts, not Inventory alone.
 *  - Point-in-time: the GL balance is a daily trial-balance snapshot (e.g. EOD
 *    yesterday), so the subledger is valued AS OF that same date from
 *    inventory_snapshots, never from the live cost layers (which include
 *    movements made after the snapshot).
 *
 * Returns `available: false` (callers degrade gracefully, never block sync) when
 * either GL account is unmapped, no trial-balance snapshot exists for either
 * account on a common date, no inventory snapshot exists for that date, or any
 * inventory snapshot for that date is flagged not point-in-time reliable
 * (scjz.43) — in which case the as-of value can't be trusted and a mismatch
 * would be spurious.
 */
export async function loadInventoryGlReconciliation(options?: {
  now?: Date
  sweepLimit?: number
  /** Ceiling on the sweeps of the trailing 30 days, above which a further sweep is surfaced as a gap. */
  recurringSweepCap?: number
}): Promise<InventoryGlReconciliationResult> {
  // Connector-agnostic: follow whichever accounting connector is active rather than
  // reading Xero directly (degrades to unavailable when none is active, or when the
  // active connector has no GL balance snapshots yet).
  const connectorInfo = await getActiveAccountingConnectorInfo()
  if (!connectorInfo) return { available: false, reason: 'no_account_configured' }
  const connector = connectorInfo.id
  // o3d-j625 r5 (review L-10): ONE resolution. The connector above and the chart below were two independent
  // reads, so a switch between them paired one connector's account codes with the other's snapshots — and
  // this report's verdict feeds the accounting invariant run. Read FOR the connector already resolved.
  const settings = await getAccountingSettingsFor(connectorInfo?.id ?? null)
  const inventoryAccount = settings.inventoryAccount?.trim()
  const allocatedAccount = settings.allocatedInventoryAccount?.trim()
  if (!inventoryAccount || !allocatedAccount) return { available: false, reason: 'no_account_configured' }

  const currency = await getBaseCurrencyCode()
  // Each configured code is resolved to its one active chart account and read BY ACCOUNT ID under the connected organisation;
  // an older account that once held the code is never compared with the current sub-ledger. Identity not proven: withheld.
  let inventorySnapshot
  let allocatedSnapshot
  try {
    inventorySnapshot = await findLatestConfiguredAccountBalanceSnapshot({
      connector,
      accountCode: inventoryAccount,
      balanceDate: options?.now ?? new Date(),
      currency,
    })
    if (!inventorySnapshot) return { available: false, reason: 'no_gl_snapshot' }
    // The Allocated-Inventory balance must be for the SAME date to be comparable.
    allocatedSnapshot = await findLatestConfiguredAccountBalanceSnapshot({
      connector,
      accountCode: allocatedAccount,
      balanceDate: inventorySnapshot.balanceDate,
      currency,
    })
  } catch (error) {
    if (error instanceof AccountBalanceMovementWithheldError) return { available: false, reason: error.reason === 'balance_provenance_unproven' ? 'gl_balance_unproven' : 'account_identity_unproven' }
    throw error
  }
  const balanceDate = inventorySnapshot.balanceDate
  if (!allocatedSnapshot || balanceDateString(allocatedSnapshot.balanceDate) !== balanceDateString(balanceDate)) {
    return { available: false, reason: 'no_gl_snapshot' }
  }

  // Subledger value AS OF balanceDate from inventory_snapshots (not live layers).
  // inventory_snapshots is SPARSE — only non-zero (product, warehouse) pairs are
  // stored — so an empty result for balanceDate is ambiguous on its own: zero
  // on-hand stock OR the snapshot job never covered the date. The InventorySnapshotRun
  // coverage marker disambiguates (scjz.60.5): a run row for the exact date proves
  // the job covered it, so empty snapshot rows mean a genuine zero subledger value
  // and the GL must still reconcile against it (catching a stale non-zero GL on a
  // zero-stock date). With no run marker we conservatively return unavailable rather
  // than risk a false critical against a stale GL on an uncovered date.
  const snapshotRows = await db.inventorySnapshot.findMany({
    where: { snapshotDate: balanceDate },
    select: { valueBase: true, valueReplayReliable: true },
  })
  const run = await db.inventorySnapshotRun.findUnique({
    where: { snapshotDate: balanceDate },
    select: { id: true, inTransitCovered: true, cutoffAt: true, source: true },
  })
  if (snapshotRows.length === 0 && !run) return { available: false, reason: 'no_subledger_snapshot' }
  // (Covered zero-stock date: the on-hand value is genuinely 0; fall through to reconcile.)
  if (snapshotRows.some((row) => !row.valueReplayReliable)) {
    return { available: false, reason: 'unreliable_subledger_snapshot' }
  }
  const onHandValue = snapshotRows.reduce((sum, row) => sum + Number(row.valueBase), 0)

  // STOCK IN TRANSIT (ACC-M12): units on a dispatched, not fully received transfer are in no warehouse row, but a transfer posts
  // nothing, so the GL still carries them. They are the snapshot's own "in transit" line and part of the sub-ledger value.
  //  - A run that captured the line (inTransitCovered) is read back.
  //  - A BACKFILL run that predates the line has ledger-derived on-hand at its cutoff, so transit is valued from the movement ledger
  //    at that same cutoff, which is exact.
  //  - A CRON run that predates the line took its on-hand from current state at some unrecorded instant after the cutoff, so no
  //    transit instant matches it: transit is NOT MEASURABLE for that date and the comparison is the on-hand one it always was.
  //    Estimating it at midnight would double count a transfer received between midnight and the capture and could sweep a false
  //    gap to the ledger.
  // Neither "absent rows" nor a failed measure is read as zero for the covered and backfill routes.
  let inTransitValue: number | undefined
  let unvalued: string[] = []
  if (run?.inTransitCovered) {
    const transitRows = await db.inventoryTransitSnapshot.findMany({
      where: { snapshotDate: balanceDate },
      select: { transferId: true, valueBase: true, valueReplayReliable: true },
    })
    unvalued = transitRows.filter((row) => !row.valueReplayReliable).map((row) => row.transferId)
    inTransitValue = transitRows.filter((row) => row.valueReplayReliable).reduce((sum, row) => sum + Number(row.valueBase), 0)
  } else if (run?.source === 'backfill') {
    const measured = await loadInTransitTransferValues(db, run.cutoffAt ?? startOfNextBusinessDay(balanceDate))
    if (!measured) return { available: false, reason: 'no_subledger_snapshot' }
    unvalued = measured.filter((row) => !row.reliable).map((row) => row.transferId)
    inTransitValue = sumInTransitValue(measured.filter((row) => row.reliable)).toNumber()
  }
  const subledgerValue = onHandValue + (inTransitValue ?? 0)
  const glBalance = Number(inventorySnapshot.amountBase) + Number(allocatedSnapshot.amountBase)

  const evaluated = evaluateInventoryGlReconciliation({
    subledgerValue,
    glBalance,
    sweepLimit: options?.sweepLimit,
  })
  // A residue that is within the per-day limit EVERY day is not rounding, it is a recurring error the per-day limit hides: a sweep that
  // would take the trailing total past the cap is surfaced as a gap instead of being posted.
  const priorSwept = evaluated.action === 'sweep' ? await trailingInventorySweptNet(balanceDateString(balanceDate)) : 0
  const guarded = guardRecurringSweep(evaluated, { priorSweptNet: priorSwept, cap: options?.recurringSweepCap ?? DEFAULT_RECURRING_SWEEP_CAP })

  return {
    available: true,
    balanceDate: balanceDateString(balanceDate),
    onHandValue,
    ...(inTransitValue !== undefined ? { inTransitValue } : {}),
    ...(unvalued.length > 0 ? { unvaluedTransitTransfers: unvalued, sweepWithheld: 'unvalued_transit_transfers' as const } : {}),
    // Both legs passed the provenance check in the reader: each is a balance Xero reported or a proven-absent zero, and says which.
    glProvenance: { inventory: glLegProvenance(inventorySnapshot), allocated: glLegProvenance(allocatedSnapshot) },
    ...guarded,
  }
}

/**
 * The NET inventory rounding sweep already raised in the 30 days before `balanceDate`: a debit to Inventory is positive, a credit
 * negative, read from the sweep journals' own inventory line, so residue that alternates in sign nets out. FAILED and CANCELLED
 * journals never posted and are left out; queued and running ones may still post, so they count.
 */
export async function trailingInventorySweptNet(balanceDate: string): Promise<number> {
  const since = new Date(new Date(`${balanceDate}T00:00:00.000Z`).getTime() - 30 * 86_400_000)
  const rows = await db.accountingSyncLog.findMany({
    where: {
      type: 'DAILY_BATCH_INVENTORY_RECONCILIATION',
      status: { in: ['PENDING', 'PROCESSING', 'SYNCED'] },
      createdAt: { gte: since },
      // This as-of date's own sweep (a re-run) is not "prior".
      NOT: { referenceId: `INVRECON-${balanceDate}` },
    },
    select: { payload: true },
  })
  let total = 0
  for (const row of rows) {
    const lines = (row.payload as { lines?: Array<{ debit?: number; credit?: number }> } | null)?.lines
    const first = Array.isArray(lines) ? lines[0] : null
    if (first) total += Number(first.debit ?? 0) - Number(first.credit ?? 0)
  }
  return Math.round(total * 100) / 100
}

export type InventoryReconciliationSweepJournal = AccountReconciliationSweepJournal

/**
 * Build the balanced rounding-difference sweep ManualJournal for an inventory
 * reconciliation result, or return null when nothing should be swept. Delegates
 * to the account-agnostic builder (cogs-audit scjz.60.4 / khdw); the labels
 * reproduce the original Inventory line/narration strings.
 */
export function buildInventoryReconciliationSweepJournal(
  reconciliation: InventoryGlReconciliationResult,
  opts: { inventoryAccount: string; roundingAccount: string; currency: string },
): InventoryReconciliationSweepJournal | null {
  // A date with a transfer outside the comparison is not swept: the residue may be that transfer, not rounding.
  if (reconciliation.available && reconciliation.sweepWithheld) return null
  return buildAccountReconciliationSweepJournal(reconciliation, {
    account: opts.inventoryAccount,
    roundingAccount: opts.roundingAccount,
    currency: opts.currency,
    descriptionLabel: 'Inventory subledger reconciliation',
    accountLabel: 'Inventory',
  })
}
