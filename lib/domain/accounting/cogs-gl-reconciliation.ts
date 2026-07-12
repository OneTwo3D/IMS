import { db } from '@/lib/db'
import { getBaseCurrencyCode } from '@/lib/base-currency'
import { getAccountingSettings, getActiveAccountingConnectorInfo } from '@/lib/accounting'
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
 * The independent subledger MOVEMENT over the same window is the sum of the signed
 * cogs_subledger_movements ledger over the window:
 *
 *   Σ CogsSubledgerMovement.baseDelta   (journalDate in window)
 *
 * EVERY COGS-account posting records a signed row at post time (khdw) — dispatch
 * (positive), refund reversals (negative), revaluations and landed-cost adjustments
 * (signed). Each row is immutable and keyed by the SAME GL date dimension the
 * journal posts on, so subledger and GL windows line up by construction; the residue
 * is purely the per-batch rounding the sweep exists to absorb. (Dispatch is NOT read
 * live from the mutable Shipment.cogsBatchAmount, which revaluation overwrites in
 * place — that would double-count a same-window dispatch+revaluation.) Material gaps
 * (a genuinely missing/double posting, or a new COGS-account flow not yet recording
 * to the ledger) exceed the sweep limit and FLAG — never swept (the scjz.13 trap).
 */
export type CogsGlReconciliationUnavailableReason =
  | 'no_account_configured'
  | 'no_gl_snapshot'
  | 'no_opening_snapshot'
  | 'ledger_not_covering_window'

export type CogsGlReconciliationResult = AccountGlReconciliationResult<CogsGlReconciliationUnavailableReason>

/**
 * Sum the IMS COGS subledger movement (base currency, full precision) over the
 * half-open window `(windowStartExclusive, windowEndInclusive]` keyed by the GL
 * posting date: the signed total of every COGS-account movement recorded in the
 * cogs_subledger_movements ledger (dispatch positive, refund reversals negative,
 * revaluations and landed-cost adjustments signed).
 */
export async function sumCogsSubledgerMovement(
  windowStartExclusive: Date,
  windowEndInclusive: Date,
  client: Pick<typeof db, 'cogsSubledgerMovement'> = db,
): Promise<number> {
  const ledger = await client.cogsSubledgerMovement.aggregate({
    _sum: { baseDelta: true },
    where: { journalDate: { gt: windowStartExclusive, lte: windowEndInclusive } },
  })
  return toDecimal(ledger._sum.baseDelta ?? 0).toNumber()
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
  // Connector-agnostic: resolve the active accounting connector + its account codes
  // rather than reading Xero directly, so the reconciliation follows whichever
  // connector is active (degrades to unavailable when none is, or when the active
  // connector has no GL balance snapshots yet).
  const connectorInfo = await getActiveAccountingConnectorInfo()
  if (!connectorInfo) return { available: false, reason: 'no_account_configured' }
  const connector = connectorInfo.id
  const settings = await getAccountingSettings()
  const cogsAccount = settings.cogsAccount?.trim()
  if (!cogsAccount) return { available: false, reason: 'no_account_configured' }

  const currency = await getBaseCurrencyCode()
  const closing = await findLatestAccountBalanceSnapshot({
    connector,
    accountCode: cogsAccount,
    balanceDate: options?.now ?? new Date(),
    currency,
  })
  if (!closing) return { available: false, reason: 'no_gl_snapshot' }
  const closingDate = closing.balanceDate

  let movement
  try {
    movement = await getAccountBalancePeriodMovement({
      connector,
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

  // Coverage watermark (khdw): the ledger is append-only with NO pre-deploy history,
  // so reconcile only windows whose GL-date range the ledger fully covers. The
  // watermark (cogs_ledger_coverage_start_date) is set once, durably, to the deploy
  // date the ledger write-sites went live; from that date every COGS posting records
  // a row. A window (opening, closing] counts only postings dated strictly after
  // `opening`, so opening >= watermark guarantees full coverage. Windows that opened
  // before the watermark are genuinely unreconcilable (no subledger data ever
  // existed for them), so degrading to unavailable hides nothing and never flags.
  // We compare the GL DATE dimension (not the row insert time, which can lag a
  // backdated posting's journalDate). ISO YYYY-MM-DD strings compare correctly.
  const coverageRow = await db.setting.findUnique({
    where: { key: 'cogs_ledger_coverage_start_date' },
    select: { value: true },
  })
  const coverageStart = coverageRow?.value?.trim()
  // Fail closed: a missing or malformed watermark must NEVER let reconciliation run
  // against an incompletely-covered ledger (which would false-flag). Only a strict
  // ISO YYYY-MM-DD watermark is trusted.
  if (!coverageStart || !/^\d{4}-\d{2}-\d{2}$/.test(coverageStart)) {
    return { available: false, reason: 'ledger_not_covering_window' }
  }
  if (balanceDateString(movement.opening.balanceDate) < coverageStart) {
    return { available: false, reason: 'ledger_not_covering_window' }
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
