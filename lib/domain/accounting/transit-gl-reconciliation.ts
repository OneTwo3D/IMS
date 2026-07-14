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
 * Reconcile the GL STOCK_IN_TRANSIT clearing account against its IMS subledger over
 * a batch window (epic khdw / 6oyu.4 — extends the inventory + COGS rounding sweeps
 * to the transit account, the last of the three with no reconciliation at all).
 *
 * Transit is a balance-sheet clearing account, but — like COGS — this reconciles the
 * PERIOD MOVEMENT between two GL balance snapshots, NOT an absolute point-in-time
 * balance. The subledger (transit_subledger_movements) is append-only with no
 * pre-deploy history, so an absolute compare would always flag by the pre-watermark
 * opening balance; a period-movement compare over a window that opened on/after the
 * coverage watermark is period-neutral and ties out by construction. This is the
 * basis account-gl-reconciliation.ts already names for "COGS/transit".
 *
 * The GL transit account is moved by exactly these posting streams (verified by
 * enumerating every journal line coded to settings.transitAccount):
 *   - PURCHASE_BILL              (+ net subtotal; bill posts EXCLUSIVE)
 *   - PURCHASE_BILL_UPDATE       (± net delta on a bill edit)
 *   - SUPPLIER_CREDIT_NOTE       (− net; credit posts INCLUSIVE, Xero splits VAT)
 *   - STOCK_RECEIPT              (− receipt value; DR inventory / CR transit)
 *   - LANDED_COST_RECLASS        (± on-hand landed-cost reclass)
 *   - LANDED_COST_CONSUMED_OFFSET(± consumed-qty COGS adjustment offset)
 *   - PURCHASE_ORDER_CANCEL      (+ reversal DR transit / CR inventory)
 *   - SUPPLIER_RETURN            (+ reversal DR transit / CR inventory)
 * Each records a signed row at post time, so Σ subledger movement over the window
 * equals ΔGL transit up to per-posting 2dp rounding — the residue the guarded sweep
 * absorbs. Material gaps (a missing/double posting, or a new uninstrumented transit
 * flow) exceed the sweep limit and FLAG — never swept (the scjz.13 trap).
 */
export type TransitGlReconciliationUnavailableReason =
  | 'no_account_configured'
  | 'no_gl_snapshot'
  | 'no_opening_snapshot'
  | 'ledger_not_covering_window'

export type TransitGlReconciliationResult = AccountGlReconciliationResult<TransitGlReconciliationUnavailableReason>

/**
 * Sum the IMS transit subledger movement (base currency, full precision) over the
 * half-open window `(windowStartExclusive, windowEndInclusive]` keyed by the GL
 * posting date: the signed total of every transit-account movement recorded in the
 * transit_subledger_movements ledger (bill debits positive, receipt/reclass/
 * credit-note credits negative).
 */
export async function sumTransitSubledgerMovement(
  windowStartExclusive: Date,
  windowEndInclusive: Date,
  client: Pick<typeof db, 'transitSubledgerMovement'> = db,
): Promise<number> {
  const ledger = await client.transitSubledgerMovement.aggregate({
    _sum: { baseDelta: true },
    where: { journalDate: { gt: windowStartExclusive, lte: windowEndInclusive } },
  })
  return toDecimal(ledger._sum.baseDelta ?? 0).toNumber()
}

/**
 * Coverage gate (pure, testable): a reconciliation window may only run when the
 * ledger fully covers it. A window (opening, closing] counts only postings dated
 * strictly after `opening`, so `opening >= watermark` guarantees full coverage.
 * Fails CLOSED on a missing/malformed watermark — a bad watermark must NEVER let
 * reconciliation run against an incompletely-covered ledger (which would false-flag).
 * ISO YYYY-MM-DD strings compare correctly by lexicographic order.
 */
export function isTransitLedgerCoverageSatisfied(
  coverageStart: string | undefined | null,
  openingBalanceDate: Date,
): boolean {
  const trimmed = coverageStart?.trim()
  if (!trimmed || !/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return false
  return balanceDateString(openingBalanceDate) >= trimmed
}

/**
 * Load the transit GL reconciliation as of the latest synced transit balance
 * snapshot. Degrades gracefully (callers never block sync) when the account is
 * unmapped, no snapshot exists, no usable opening snapshot exists to bound the
 * period, or the ledger does not yet cover the window.
 */
export async function loadTransitGlReconciliation(options?: {
  now?: Date
  sweepLimit?: number
}): Promise<TransitGlReconciliationResult> {
  // Connector-agnostic: follow whichever accounting connector is active rather than
  // reading Xero directly (degrades to unavailable when none is active, or when the
  // active connector has no GL balance snapshots yet).
  const connectorInfo = await getActiveAccountingConnectorInfo()
  if (!connectorInfo) return { available: false, reason: 'no_account_configured' }
  const connector = connectorInfo.id
  const settings = await getAccountingSettings()
  const transitAccount = settings.transitAccount?.trim()
  if (!transitAccount) return { available: false, reason: 'no_account_configured' }

  const currency = await getBaseCurrencyCode()
  const closing = await findLatestAccountBalanceSnapshot({
    connector,
    accountCode: transitAccount,
    balanceDate: options?.now ?? new Date(),
    currency,
  })
  if (!closing) return { available: false, reason: 'no_gl_snapshot' }
  const closingDate = closing.balanceDate

  let movement
  try {
    movement = await getAccountBalancePeriodMovement({
      connector,
      accountCode: transitAccount,
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

  // Coverage watermark (khdw / 6oyu.4): the ledger is append-only with NO pre-deploy
  // history, so reconcile only windows whose GL-date range the ledger fully covers.
  // The watermark (transit_ledger_coverage_start_date) is set once, durably, to the
  // deploy date the ledger write-sites went live. Windows that opened before the
  // watermark are genuinely unreconcilable (no subledger data ever existed), so
  // degrading to unavailable hides nothing and never flags. We compare the GL DATE
  // dimension (not the row insert time, which can lag a backdated posting).
  const coverageRow = await db.setting.findUnique({
    where: { key: 'transit_ledger_coverage_start_date' },
    select: { value: true },
  })
  if (!isTransitLedgerCoverageSatisfied(coverageRow?.value, movement.opening.balanceDate)) {
    return { available: false, reason: 'ledger_not_covering_window' }
  }

  const subledgerValue = await sumTransitSubledgerMovement(movement.opening.balanceDate, movement.closing.balanceDate)
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
 * Build the balanced rounding-difference sweep ManualJournal for a transit
 * reconciliation result, or null when nothing should be swept. Delegates to the
 * account-agnostic builder; `delta = subledger − GL`, so subledger > GL → DR Transit
 * / CR Rounding (transit understated), else the reverse. GUARDED: only an
 * immaterial `sweep`-action rounding residue is posted; a material `flag` gap is
 * surfaced by the reconciliation invariant for human review and NEVER swept.
 */
export function buildTransitReconciliationSweepJournal(
  reconciliation: TransitGlReconciliationResult,
  opts: { transitAccount: string; roundingAccount: string; currency: string },
): AccountReconciliationSweepJournal | null {
  return buildAccountReconciliationSweepJournal(reconciliation, {
    account: opts.transitAccount,
    roundingAccount: opts.roundingAccount,
    currency: opts.currency,
    descriptionLabel: 'Transit subledger reconciliation',
    accountLabel: 'Transit',
  })
}
