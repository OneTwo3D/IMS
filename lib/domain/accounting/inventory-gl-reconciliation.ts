import { db } from '@/lib/db'
import { getBaseCurrencyCode } from '@/lib/base-currency'
import { getXeroSettings } from '@/lib/connectors/xero/settings'
import { roundToGlPrecisionNumber } from '@/lib/domain/math/precision-policy'
import { balanceDateString, findLatestAccountBalanceSnapshot } from './account-balance-snapshots'

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
export type InventoryGlReconciliationAction = 'balanced' | 'sweep' | 'flag'

export type InventoryGlReconciliation = {
  subledgerValue: number
  glBalance: number
  delta: number
  sweepLimit: number
  action: InventoryGlReconciliationAction
}

/**
 * Default ceiling for treating an inventory GL gap as pure accumulated rounding.
 * The reconciliation runs per batch and sweeps each period, so the genuine
 * rounding residue stays well under one currency unit; a £1 ceiling absorbs that
 * while still flagging any material inventory misstatement (which is orders of
 * magnitude larger). Tunable per call.
 */
export const DEFAULT_INVENTORY_GL_SWEEP_LIMIT = 1

export function evaluateInventoryGlReconciliation(input: {
  subledgerValue: number
  glBalance: number
  sweepLimit?: number
}): InventoryGlReconciliation {
  const subledgerValue = roundToGlPrecisionNumber(input.subledgerValue)
  const glBalance = roundToGlPrecisionNumber(input.glBalance)
  const delta = roundToGlPrecisionNumber(subledgerValue - glBalance)
  const sweepLimit = input.sweepLimit ?? DEFAULT_INVENTORY_GL_SWEEP_LIMIT

  let action: InventoryGlReconciliationAction
  if (delta === 0) {
    action = 'balanced'
  } else if (Math.abs(delta) <= sweepLimit) {
    action = 'sweep'
  } else {
    action = 'flag'
  }

  return { subledgerValue, glBalance, delta, sweepLimit, action }
}

export type InventoryGlReconciliationUnavailableReason =
  | 'no_account_configured'
  | 'no_gl_snapshot'
  | 'no_subledger_snapshot'
  | 'unreliable_subledger_snapshot'

export type InventoryGlReconciliationResult =
  | { available: false; reason: InventoryGlReconciliationUnavailableReason }
  | ({ available: true; balanceDate: string } & InventoryGlReconciliation)

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
}): Promise<InventoryGlReconciliationResult> {
  const settings = await getXeroSettings()
  const inventoryAccount = settings.xero_inventory_account?.trim()
  const allocatedAccount = settings.xero_allocated_inventory_account?.trim()
  if (!inventoryAccount || !allocatedAccount) return { available: false, reason: 'no_account_configured' }

  const currency = await getBaseCurrencyCode()
  const inventorySnapshot = await findLatestAccountBalanceSnapshot({
    connector: 'xero',
    accountCode: inventoryAccount,
    balanceDate: options?.now ?? new Date(),
    currency,
  })
  if (!inventorySnapshot) return { available: false, reason: 'no_gl_snapshot' }
  const balanceDate = inventorySnapshot.balanceDate

  // The Allocated-Inventory balance must be for the SAME date to be comparable.
  const allocatedSnapshot = await findLatestAccountBalanceSnapshot({
    connector: 'xero',
    accountCode: allocatedAccount,
    balanceDate,
    currency,
  })
  if (!allocatedSnapshot || balanceDateString(allocatedSnapshot.balanceDate) !== balanceDateString(balanceDate)) {
    return { available: false, reason: 'no_gl_snapshot' }
  }

  // Subledger value AS OF balanceDate from inventory_snapshots (not live layers).
  const snapshotRows = await db.inventorySnapshot.findMany({
    where: { snapshotDate: balanceDate },
    select: { valueBase: true, valueReplayReliable: true },
  })
  if (snapshotRows.length === 0) return { available: false, reason: 'no_subledger_snapshot' }
  if (snapshotRows.some((row) => !row.valueReplayReliable)) {
    return { available: false, reason: 'unreliable_subledger_snapshot' }
  }
  const subledgerValue = snapshotRows.reduce((sum, row) => sum + Number(row.valueBase), 0)
  const glBalance = Number(inventorySnapshot.amountBase) + Number(allocatedSnapshot.amountBase)

  return {
    available: true,
    balanceDate: balanceDateString(balanceDate),
    ...evaluateInventoryGlReconciliation({
      subledgerValue,
      glBalance,
      sweepLimit: options?.sweepLimit,
    }),
  }
}
