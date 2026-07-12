import { GL_BASE_PRECISION, roundToGlPrecisionNumber } from '@/lib/domain/math/precision-policy'

/**
 * Account-agnostic GL reconciliation core (cogs-audit khdw).
 *
 * Generalises the inventory subledger-vs-GL rounding sweep (scjz.60.4) so the
 * same guarded mechanism can tie out ANY account whose IMS subledger carries
 * value at 6dp while the GL account can only hold 2dp. The sub-penny residue
 * accumulates each batch; this evaluator classifies the gap so a pure-rounding
 * residue is swept to a rounding-difference account and a material gap is
 * flagged (never swept — sweeping a real misstatement is the scjz.13 trap).
 *
 *   - `balanced` — the rounded subledger equals the GL balance to the penny.
 *   - `sweep`    — |gap| ≤ sweepLimit, i.e. pure accumulated rounding.
 *   - `flag`     — |gap| > sweepLimit, a real discrepancy; surfaced, never swept.
 *
 * `delta` is `subledger - GL`: the amount the GL account must move by (positive
 * = GL is understated vs the subledger) to tie out. Callers may reconcile either
 * absolute point-in-time balances (inventory) or PERIOD MOVEMENT between two
 * snapshot dates (COGS/transit) — the evaluator is basis-agnostic; it only sees
 * two comparable numbers.
 */
export type AccountGlReconciliationAction = 'balanced' | 'sweep' | 'flag'

export type AccountGlReconciliation = {
  subledgerValue: number
  glBalance: number
  delta: number
  sweepLimit: number
  action: AccountGlReconciliationAction
}

/**
 * Default ceiling for treating a GL gap as pure accumulated rounding. The
 * reconciliation runs per batch and sweeps each period, so the genuine rounding
 * residue stays well under one currency unit; a £1 ceiling absorbs that while
 * still flagging any material misstatement (orders of magnitude larger). Tunable
 * per call.
 */
export const DEFAULT_GL_SWEEP_LIMIT = 1

export function evaluateAccountGlReconciliation(input: {
  subledgerValue: number
  glBalance: number
  sweepLimit?: number
}): AccountGlReconciliation {
  const subledgerValue = roundToGlPrecisionNumber(input.subledgerValue)
  const glBalance = roundToGlPrecisionNumber(input.glBalance)
  const delta = roundToGlPrecisionNumber(subledgerValue - glBalance)
  const sweepLimit = input.sweepLimit ?? DEFAULT_GL_SWEEP_LIMIT

  let action: AccountGlReconciliationAction
  if (delta === 0) {
    action = 'balanced'
  } else if (Math.abs(delta) <= sweepLimit) {
    action = 'sweep'
  } else {
    action = 'flag'
  }

  return { subledgerValue, glBalance, delta, sweepLimit, action }
}

export type AccountGlReconciliationResult<Reason extends string = string> =
  | { available: false; reason: Reason }
  | ({ available: true; balanceDate: string } & AccountGlReconciliation)

export type AccountReconciliationSweepJournal = {
  date: string
  amount: number
  subledgerHigher: boolean
  narration: string
  lines: Array<{ accountCode: string; description: string; debit?: number; credit?: number }>
}

/**
 * Build the balanced rounding-difference sweep ManualJournal for a reconciliation
 * result, or return null when nothing should be swept. Pure (no IO) so the money
 * logic — guard, sign, and the balanced DR/CR pair — is unit-testable in isolation.
 *
 * Only sweeps a `sweep`-action gap (pure accumulated rounding within tolerance);
 * `flag` gaps are material and surfaced by the reconciliation invariant, never
 * swept. Both accounts must be configured (a blank rounding account is the opt-out
 * — the residue is accepted within tolerance). The gap direction sets the side:
 * `delta = subledger - GL`, so delta > 0 means the GL account is understated vs
 * the subledger → DR the account / CR Rounding Difference; delta < 0 → the reverse.
 * This sign rule is correct for both asset (inventory) and expense (COGS) accounts:
 * DR increases the account's natural-debit balance in both cases.
 */
export function buildAccountReconciliationSweepJournal(
  reconciliation: AccountGlReconciliationResult,
  opts: {
    account: string
    roundingAccount: string
    currency: string
    /** Line description prefix, e.g. "Inventory subledger reconciliation". */
    descriptionLabel: string
    /** Account noun used in the narration, e.g. "Inventory" / "COGS". */
    accountLabel: string
  },
): AccountReconciliationSweepJournal | null {
  if (!reconciliation.available || reconciliation.action !== 'sweep') return null
  const account = opts.account.trim()
  const roundingAccount = opts.roundingAccount.trim()
  if (!account || !roundingAccount) return null
  const amount = roundToGlPrecisionNumber(Math.abs(reconciliation.delta))
  if (amount === 0) return null
  const subledgerHigher = reconciliation.delta > 0
  const description = `${opts.descriptionLabel} ${reconciliation.balanceDate}`
  const lines = [
    { accountCode: account, description, ...(subledgerHigher ? { debit: amount } : { credit: amount }) },
    { accountCode: roundingAccount, description, ...(subledgerHigher ? { credit: amount } : { debit: amount }) },
  ]
  const narration =
    `${opts.accountLabel} subledger-vs-GL rounding sweep: ${subledgerHigher ? 'DR' : 'CR'} ${opts.accountLabel} ` +
    `${opts.currency} ${amount.toFixed(GL_BASE_PRECISION)} ` +
    `(subledger ${reconciliation.subledgerValue.toFixed(GL_BASE_PRECISION)} vs GL ${reconciliation.glBalance.toFixed(GL_BASE_PRECISION)})`
  return { date: reconciliation.balanceDate, amount, subledgerHigher, narration, lines }
}
