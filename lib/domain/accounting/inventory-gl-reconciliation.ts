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

export type InventoryGlReconciliationResult =
  | { available: false; reason: 'no_account_configured' | 'no_gl_snapshot' }
  | ({ available: true; accountCode: string; balanceDate: string } & InventoryGlReconciliation)

/**
 * Load the live inventory GL reconciliation: the 6dp cost-layer subledger value
 * vs the latest synced GL inventory account balance (scjz.60c / scjz.74).
 *
 * Returns `available: false` (so callers degrade gracefully, never block sync)
 * when the inventory account is unmapped or no trial-balance snapshot has been
 * synced yet — the GL balance is only known once `syncXeroAccountBalanceSnapshots`
 * has run. The subledger value is summed in SQL and rounded to GL precision; the
 * sub-6dp difference vs a Decimal sum is immaterial once rounded to 2dp.
 */
export async function loadInventoryGlReconciliation(options?: {
  now?: Date
  sweepLimit?: number
}): Promise<InventoryGlReconciliationResult> {
  const settings = await getXeroSettings()
  const accountCode = settings.xero_inventory_account?.trim()
  if (!accountCode) return { available: false, reason: 'no_account_configured' }

  const currency = await getBaseCurrencyCode()
  const snapshot = await findLatestAccountBalanceSnapshot({
    connector: 'xero',
    accountCode,
    balanceDate: options?.now ?? new Date(),
    currency,
  })
  if (!snapshot) return { available: false, reason: 'no_gl_snapshot' }

  // decimal-boundary-ok: report-only reconciliation. The SQL aggregate's 6dp
  // precision (cf. scjz.65) is immaterial here because the result is rounded to
  // GL precision (2dp) before comparison, and a sub-penny difference can never
  // cross the rounding-scale sweep limit.
  const rows = await db.$queryRaw<Array<{ valueBase: number | string }>>`
    SELECT COALESCE(SUM(cl."remainingQty" * cl."unitCostBase"), 0) AS "valueBase"
    FROM cost_layers cl
    WHERE cl."remainingQty" > 0
  `
  const subledgerValue = Number(rows[0]?.valueBase ?? 0)

  return {
    available: true,
    accountCode,
    balanceDate: balanceDateString(snapshot.balanceDate),
    ...evaluateInventoryGlReconciliation({
      subledgerValue,
      glBalance: Number(snapshot.amountBase),
      sweepLimit: options?.sweepLimit,
    }),
  }
}
