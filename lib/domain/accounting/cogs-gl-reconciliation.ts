import { db } from '@/lib/db'
import { getBaseCurrencyCode } from '@/lib/base-currency'
import { getXeroSettings } from '@/lib/connectors/xero/settings'
import { toDecimal } from '@/lib/domain/math/decimal'
import {
  balanceDateString,
  getAccountBalancePeriodMovement,
  MissingAccountBalanceSnapshotError,
  findLatestAccountBalanceSnapshot,
} from './account-balance-snapshots'
import {
  buildAccountReconciliationSweepJournal,
  evaluateAccountGlReconciliation,
  type AccountGlReconciliationResult,
  type AccountReconciliationSweepJournal,
} from './account-gl-reconciliation'

/**
 * Reconcile the GL Cost-of-Goods-Sold account against its IMS subledger over a
 * batch window (cogs-audit khdw — extends the inventory rounding sweep scjz.60.4
 * to COGS).
 *
 * Unlike inventory (a balance-sheet asset reconciled at an absolute point in
 * time), COGS is a P&L account, so this reconciles the PERIOD MOVEMENT between
 * two GL balance snapshots — period-neutral, finance-neutral, and immune to the
 * financial-year reset that would break an absolute-balance compare.
 *
 * The GL COGS account receives exactly two posting streams (verified by
 * enumerating posting sites):
 *   - dispatch COGS: daily-batch Group B posts `round2(Σ Shipment.cogsBatchAmount)`
 *     for shipments journaled that day (xero/daily-sync.ts).
 *   - refund reversals: `COGS_REVERSAL` credits COGS at 2dp on a refund.
 * (Manufacturing/stock-adjustment movements write cogs_entries but post to OTHER
 * accounts, so raw cogs_entries is NOT the COGS subledger.)
 *
 * The independent 6dp subledger MOVEMENT over the same window is therefore:
 *
 *   Σ Shipment.cogsBatchAmount  (shipmentJournalDate in window)
 * − Σ SalesOrderRefund.cogsReversalBase  (cogsReversalJournalDate in window)
 *
 * Both are first-class IMS fields keyed by the SAME GL date dimension the journal
 * posts on, so the subledger and GL windows line up by construction; the residue
 * is purely the per-batch 2dp rounding the sweep exists to absorb. Material gaps
 * (a genuinely missing/double posting) exceed the sweep limit and FLAG — never
 * swept (the scjz.13 trap).
 */
export type CogsGlReconciliationUnavailableReason =
  | 'no_account_configured'
  | 'no_gl_snapshot'
  | 'no_opening_snapshot'

export type CogsGlReconciliationResult = AccountGlReconciliationResult<CogsGlReconciliationUnavailableReason>

/**
 * Sum the IMS COGS subledger movement (base currency, full precision) over the
 * half-open window `(windowStartExclusive, windowEndInclusive]` keyed by the GL
 * posting date: dispatch COGS recognised minus refund COGS reversed.
 */
export async function sumCogsSubledgerMovement(
  windowStartExclusive: Date,
  windowEndInclusive: Date,
  client: Pick<typeof db, 'shipment' | 'salesOrderRefund'> = db,
): Promise<number> {
  const dispatch = await client.shipment.aggregate({
    _sum: { cogsBatchAmount: true },
    where: { shipmentJournalDate: { gt: windowStartExclusive, lte: windowEndInclusive } },
  })
  const refunds = await client.salesOrderRefund.aggregate({
    _sum: { cogsReversalBase: true },
    where: { cogsReversalJournalDate: { gt: windowStartExclusive, lte: windowEndInclusive } },
  })
  return toDecimal(dispatch._sum.cogsBatchAmount ?? 0)
    .sub(toDecimal(refunds._sum.cogsReversalBase ?? 0))
    .toNumber()
}

/**
 * Load the COGS GL reconciliation as of the latest synced COGS balance snapshot.
 * Degrades gracefully (callers never block sync) when the account is unmapped, no
 * snapshot exists, or no usable opening snapshot exists to bound the period.
 */
export async function loadCogsGlReconciliation(options?: {
  now?: Date
  sweepLimit?: number
}): Promise<CogsGlReconciliationResult> {
  const settings = await getXeroSettings()
  const cogsAccount = settings.xero_cogs_account?.trim()
  if (!cogsAccount) return { available: false, reason: 'no_account_configured' }

  const currency = await getBaseCurrencyCode()
  const closing = await findLatestAccountBalanceSnapshot({
    connector: 'xero',
    accountCode: cogsAccount,
    balanceDate: options?.now ?? new Date(),
    currency,
  })
  if (!closing) return { available: false, reason: 'no_gl_snapshot' }
  const closingDate = closing.balanceDate

  let movement
  try {
    movement = await getAccountBalancePeriodMovement({
      connector: 'xero',
      accountCode: cogsAccount,
      currency,
      dateFrom: closingDate,
      dateTo: closingDate,
    })
  } catch (error) {
    if (error instanceof MissingAccountBalanceSnapshotError) {
      return { available: false, reason: 'no_opening_snapshot' }
    }
    throw error
  }

  const subledgerValue = await sumCogsSubledgerMovement(movement.opening.balanceDate, movement.closing.balanceDate)
  const glBalance = movement.movementBase.toNumber()

  return {
    available: true,
    balanceDate: balanceDateString(closingDate),
    ...evaluateAccountGlReconciliation({
      subledgerValue,
      glBalance,
      sweepLimit: options?.sweepLimit,
    }),
  }
}

/**
 * Build the balanced rounding-difference sweep ManualJournal for a COGS
 * reconciliation result, or null when nothing should be swept. Delegates to the
 * account-agnostic builder; `delta = subledger − GL`, so subledger > GL → DR COGS
 * / CR Rounding (COGS understated), else the reverse.
 */
export function buildCogsReconciliationSweepJournal(
  reconciliation: CogsGlReconciliationResult,
  opts: { cogsAccount: string; roundingAccount: string; currency: string },
): AccountReconciliationSweepJournal | null {
  return buildAccountReconciliationSweepJournal(reconciliation, {
    account: opts.cogsAccount,
    roundingAccount: opts.roundingAccount,
    currency: opts.currency,
    descriptionLabel: 'COGS subledger reconciliation',
    accountLabel: 'COGS',
  })
}
