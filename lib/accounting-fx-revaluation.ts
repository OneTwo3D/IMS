import { isRegisteredAccountingConnector } from '@/lib/connectors/accounting-registry'
import { db } from '@/lib/db'
import { getAccountingSettings, queueAccountingSyncTxWithOutcome, type AccountingSettings, type AccountingEnqueueOutcome } from '@/lib/accounting'
import { postingIsOwed } from '@/lib/domain/accounting/enqueue-outcome'
import {
  LEDGER_STANDING_SELECT,
  WORK_SLOT_OCCUPIED_WHERE,
  ledgerStanding,
  type LedgerStandingRow,
} from '@/lib/domain/accounting/ledger-standing'
import {
  buildRealisedFxJournal,
  computeRealisedFx,
  reverseJournalLines,
  getUnrealisedFxAccounts,
  describeFxRefusal,
  resolveSettlementFxRateToBase,
  roundAccountingMoney,
  type FxSettlementSide,
} from '@/lib/accounting-fx'
import { getBaseCurrencyCode } from '@/lib/base-currency'
import { endOfBusinessDateUtc, isMissingFxRateError, type FxMissingReason } from '@/lib/currencies/fx-lookup'
import { addMoney, multiplyMoney, subtractMoney, toDecimal } from '@/lib/domain/math/decimal'

type JournalLine = {
  accountCode: string
  description: string
  debit?: number
  credit?: number
  taxType?: string
}

type OpenBalance = {
  id: string
  reference: string
  side: FxSettlementSide
  currency: string
  outstandingForeign: number
  bookedRateToBase: number
  // Stored base value of the outstanding portion (document totalBase prorated by
  // outstandingForeign/totalForeign) — the actual AR/AP carrying value to revalue
  // against, rather than recomputing outstandingForeign/rate (cogs-audit scjz.55).
  bookedBase: number
}

type PriorRevaluation = {
  id: string
  /**
   * o3d-j625 r2 (Codex MEDIUM 1) — THE CONNECTOR THE SOURCE ROW WAS WRITTEN UNDER.
   *
   * The reversal below is built from `prior.lines`, which are the ACCOUNT CODES OF A HISTORIC JOURNAL
   * read back out of `AccountingSyncLog.payload`. r1 attributed that reversal to `settings.connector`
   * — this run's chart — which is a statement about a different read entirely: `getPriorRevaluations`
   * neither selected nor filtered the source row's connector, so a revaluation posted under
   * QuickBooks before a switch to Xero would have had its reversal routed to XERO carrying
   * QuickBooks's AR/AP control and unrealised-FX codes. That is the very mis-attribution o3d-j625 is
   * about, arrived at through the one site whose codes do not come from the settings object beside it.
   *
   * Carried off the row, therefore, and used as the reversal's `chartConnector`. Kept as a raw
   * `string` because the column is a plain string with a default and a build that does not know the
   * value must NOT guess: an unroutable connector is refused (see the reversal loop), never narrowed
   * to whatever this build happens to support.
   */
  connector: string
  valuationDate: string
  side: FxSettlementSide
  lines: JournalLine[]
}

type RevaluationPayload = {
  kind?: string
  side?: string
  valuationDate?: string
  sourceEntryId?: string
  lines?: JournalLine[]
}

export type FxRevaluationResult = {
  success: boolean
  valuationDate: string
  skipped?: boolean
  reason?: string
  error?: string
  reversed: number
  revalued: number
  documents: number
  /**
   * o3d-j625 r3 (Codex MEDIUM) — ENQUEUES THIS RUN OWES AND DID NOT MAKE.
   *
   * `reversed` and `revalued` were incremented unconditionally after a `queueAccountingSync` whose
   * result was discarded, so a refusal — a source row written under a connector that is no longer
   * active — was counted and reported as a completed reversal. Worse than a wrong number: the next
   * run's `alreadyRevaluedForDate` read agreed with it, so nothing ever went back for it. The counts
   * now only count rows that were queued, and what was NOT is stated here instead of vanishing.
   */
  refused: number
  /**
   * o3d-q0x56.4 - OPEN DOCUMENTS THIS RUN DID NOT REVALUE BECAUSE NO USABLE RATE EXISTS FOR THEM.
   *
   * Each is excluded from the journal (never revalued at 1, never at its booked rate) and named here with the
   * reason; the same list is written to the activity log as one WARNING per document. Empty when every open
   * foreign document had a rate. The run is still `success: true`: the documents that did have a rate posted,
   * and failing the run would make the cron retry something only a rate can fix.
   *
   * A skipped document stays unrevalued for THIS valuation date even if the rate is added later the same day:
   * the journal for a side is keyed by date and side, and a second run sees it as already queued.
   */
  skippedNoRate: SkippedRevaluation[]
  /** Sides (AR / AP) left entirely alone this run because a document on them had no rate: no reversal, no new journal. */
  withheldSides: WithheldSide[]
}

export type WithheldSide = {
  side: FxSettlementSide
  /** `side_withheld_missing_rate`: a document had no rate. `side_blocked_enqueue_refused`: the queue refused a reversal or the replacement, so the unit was rolled back. */
  reason: 'side_withheld_missing_rate' | 'side_blocked_enqueue_refused'
  skipped: SkippedRevaluation[]
  detail?: string
}

class SideEnqueueRefused extends Error {
  constructor(readonly what: string, readonly outcome: AccountingEnqueueOutcome) {
    super(`${what} was refused by the accounting queue`)
    this.name = 'SideEnqueueRefused'
  }
}

export type SkippedRevaluation = {
  side: FxSettlementSide
  documentId: string
  reference: string
  currency: string
  reason: FxMissingReason
  message: string
}

function asDateOnly(input?: Date | string): string {
  const date = input ? new Date(input) : new Date()
  if (Number.isNaN(date.getTime())) throw new Error('Invalid valuation date')
  return date.toISOString().slice(0, 10)
}

function isActivePayload(value: unknown): value is RevaluationPayload {
  return value != null && typeof value === 'object'
}

function parseJournalLines(value: unknown): JournalLine[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((line) => {
    if (!line || typeof line !== 'object') return []
    const entry = line as Record<string, unknown>
    if (typeof entry.accountCode !== 'string' || typeof entry.description !== 'string') return []
    return [{
      accountCode: entry.accountCode,
      description: entry.description,
      debit: typeof entry.debit === 'number' ? entry.debit : Number(entry.debit ?? 0),
      credit: typeof entry.credit === 'number' ? entry.credit : Number(entry.credit ?? 0),
      taxType: typeof entry.taxType === 'string' ? entry.taxType : undefined,
    }]
  })
}

/**
 * Pure selection of strictly-earlier revaluations that still need reversing.
 *
 * `logs` must already be filtered to ACTIVE statuses (PENDING/PROCESSING/SYNCED),
 * so a prior whose reversal FAILED is absent from `reversalSources` and is
 * therefore returned for retry. We deliberately do NOT bail out when a same-date
 * revaluation already exists: that earlier blanket short-circuit stranded
 * failed/missing reversals permanently, compounding unrealised FX each period
 * (scjz.39). A prior with an active reversal is already covered and excluded; a
 * fresh PENDING reversal for a failed one is allowed because the idempotency
 * unique index is partial on active statuses.
 */
export function selectPriorRevaluationsToReverse(
  logs: Array<{ id: string; connector: string; payload: unknown }>,
  valuationDate: string,
): PriorRevaluation[] {
  const reversalSources = new Set<string>()
  const prior: PriorRevaluation[] = []

  for (const log of logs) {
    const payload = log.payload
    if (!isActivePayload(payload)) continue
    if (payload.kind === 'reversal' && typeof payload.sourceEntryId === 'string') {
      reversalSources.add(payload.sourceEntryId)
      continue
    }
    if (payload.kind !== 'revaluation') continue
    // Only strictly-earlier revaluations need reversing; >= valuationDate (same
    // day or future) is excluded here.
    if (typeof payload.valuationDate !== 'string' || payload.valuationDate >= valuationDate) continue
    if (payload.side !== 'receivable' && payload.side !== 'payable') continue
    prior.push({
      id: log.id,
      // o3d-j625 r2: off the ROW, so the reversal is attributed to the books its codes came out of
      // rather than to whichever connector is active when the reversal is raised.
      connector: log.connector,
      valuationDate: payload.valuationDate,
      side: payload.side,
      lines: parseJournalLines(payload.lines),
    })
  }

  return prior.filter((entry) => !reversalSources.has(entry.id) && entry.lines.length > 0)
}

async function getPriorRevaluations(valuationDate: string): Promise<PriorRevaluation[]> {
  const logs = await db.accountingSyncLog.findMany({
    where: {
      type: 'UNREALISED_FX_JOURNAL',
      // o3d-3la07 (M10): the work slot's own statuses (PENDING / PROCESSING / SYNCED), stated once in
      // the ledger-standing module rather than re-spelled here.
      ...WORK_SLOT_OCCUPIED_WHERE,
    },
    orderBy: { createdAt: 'asc' },
    // o3d-j625 r2 (Codex MEDIUM 1): `connector` is SELECTED. Without it the reversal had no way to say
    // whose chart of accounts its lines were, and attributed them to the current settings object.
    select: { id: true, connector: true, payload: true, ...LEDGER_STANDING_SELECT },
  })
  // o3d-3la07 (M10, D2): an operator-typed document id still COUNTS here (the journal is claimed to
  // exist, so it is reversed / counted as reversed and never posted a second time) but the run says so:
  // the figures being reversed are the queued payload's, which is intent for an asserted row.
  await reportAssertedRevaluationRows(
    logs.filter((log) => isRevaluationOrReversal(log.payload)),
    'prior-revaluation-read',
    valuationDate,
  )
  return selectPriorRevaluationsToReverse(logs, valuationDate)
}

function isRevaluationOrReversal(payload: unknown): boolean {
  return isActivePayload(payload) && (payload.kind === 'revaluation' || payload.kind === 'reversal')
}

/**
 * o3d-3la07 (M10, D2) - AN UNREALISED-FX ROW THE RUN RELIED ON RESTS ON A PERSON'S WORD.
 *
 * "Has this journal been posted?" is an EXISTENCE question, so a SYNCED row with an operator-typed id
 * (ASSERTED_POSTED) still answers it (the alternative posts the journal twice), but never silently: one
 * WARNING per such row per run. Rows that are CONFIRMED_POSTED or live work are not reported.
 */
export async function reportAssertedRevaluationRows(
  rows: Array<LedgerStandingRow & { id: string }>,
  read: 'prior-revaluation-read' | 'same-date-check',
  valuationDate: string,
): Promise<number> {
  const asserted = rows.filter((row) => ledgerStanding(row) === 'ASSERTED_POSTED')
  if (asserted.length === 0) return 0
  const { logActivity } = await import('@/lib/activity-log')
  for (const row of asserted) {
    await logActivity({
      entityType: 'SYSTEM',
      action: 'unrealised_fx_relied_on_operator_assertion',
      tag: 'accounting',
      level: 'WARNING',
      description:
        `The unrealised FX run for ${valuationDate} relied on sync log ${row.id}, which an OPERATOR settled `
        + `as posted under the document id '${row.externalTransactionId ?? ''}'. IMS did not verify that document: `
        + 'the run counted it as existing (so no second journal is raised) but the figures it reverses are '
        + 'the queued payload, not what the ledger holds. Check the journal in the accounting system.',
      metadata: { syncLogId: row.id, read, valuationDate, settlementBasis: row.settlementBasis },
    }).catch(() => { /* a report that cannot be written must not abort the rest of the run */ })
  }
  return asserted.length
}

/**
 * o3d-j625 r3 (Codex HIGH 4) — "ALREADY REVALUED TODAY" IS A QUESTION ABOUT ONE CONNECTOR'S BOOKS,
 * AND IT WAS BEING ASKED OF EVERY CONNECTOR'S AT ONCE.
 *
 * This decides whether to SKIP the fresh revaluation. r2 declared that out of scope and unproven on the
 * grounds that it "only decides whether to skip work" — which is the defect, not the defence: the work
 * it skips is the writing of a journal, so a wrong `true` here is a journal silently not written. Xero
 * revalues on the 9th; the operator switches to QuickBooks that afternoon; the run reads Xero's row,
 * answers `true`, and QuickBooks' revaluation — whose lines come from QuickBooks' own AR/AP control and
 * unrealised-FX accounts, and which no Xero row can stand in for — never happens. Nothing reports it,
 * because skipping is the designed behaviour when the answer is `true`.
 *
 * Scoped to the connector whose chart this run is about, therefore. The idempotency keys the
 * revaluation enqueue uses (`unrealised-fx:revaluation:<date>:<side>`) are NOT connector-scoped either,
 * but they do not need to be for this: `queueAccountingSync` routes by `chartConnector` and each
 * connector queue applies its own already-present check, so the enqueue is per-connector even though
 * the key string is shared. This read is what had to learn the same scoping.
 *
 * DELIBERATELY NOT applied to `getPriorRevaluations`: that loop must see EVERY connector's live rows,
 * because a revaluation posted under a connector that has since been retired still has to be reversed,
 * and the reversal is routed by the SOURCE row's connector (see the loop). Narrowing that read to the
 * active connector would strand exactly the rows the r2 work exists to reverse.
 *
 * `null` — no connector switched on — answers `false`. Unreachable from `runArApFxRevaluation`, whose
 * `settings.syncEnabled` gate is `false` whenever the connector is `null`, and answered rather than
 * asserted because `false` is the safe direction: it means "do not skip", and the revaluation enqueue
 * then refuses on its own `chartConnector: null` and writes nothing.
 */
async function revaluedSidesForDate(
  valuationDate: string,
  connector: AccountingSettings['connector'],
): Promise<Set<FxSettlementSide>> {
  const sides = new Set<FxSettlementSide>()
  if (connector === null) return sides
  const logs = await db.accountingSyncLog.findMany({
    where: {
      type: 'UNREALISED_FX_JOURNAL',
      ...WORK_SLOT_OCCUPIED_WHERE,
      // o3d-j625 r3 (Codex HIGH 4): the whole point — another connector's revaluation for this date
      // does not relieve this connector of writing its own.
      connector,
    },
    select: { id: true, payload: true, ...LEDGER_STANDING_SELECT },
  })
  const matching = logs.filter((log) => {
    const payload = log.payload
    return isActivePayload(payload) &&
      payload.kind === 'revaluation' &&
      payload.valuationDate === valuationDate
  })
  // o3d-3la07 (M10, D2): existence question - an asserted row still counts, and is reported.
  await reportAssertedRevaluationRows(matching, 'same-date-check', valuationDate)
  // PER SIDE (o3d-q0x56.4): a side that was withheld for a missing rate queued nothing, so it is not in this set and
  // a same-day rerun does it once the rate exists. A row with no readable side counts for both (the safe direction:
  // it can only skip work that a row claims was done).
  for (const log of matching) {
    const side = (log.payload as RevaluationPayload).side
    if (side === 'receivable' || side === 'payable') sides.add(side)
    else { sides.add('receivable'); sides.add('payable') }
  }
  return sides
}

async function getOpenReceivables(baseCurrency: string): Promise<OpenBalance[]> {
  const orders = await db.salesOrder.findMany({
    where: {
      currency: { not: baseCurrency },
      status: { not: 'CANCELLED' },
      refundStatus: { not: 'FULL' },
      totalForeign: { gt: 0 },
    },
    select: {
      id: true,
      orderNumber: true,
      externalOrderNumber: true,
      invoiceNumber: true,
      currency: true,
      totalForeign: true,
      totalBase: true,
      fxRateToBase: true,
      payments: {
        where: { refundId: null },
        select: { amount: true, currency: true },
      },
    },
  })

  return orders.flatMap((order) => {
    const paid = order.payments.reduce((sum, payment) => (
      payment.currency === order.currency ? addMoney(sum, payment.amount) : sum
    ), toDecimal(0))
    const outstandingForeign = roundAccountingMoney(subtractMoney(order.totalForeign, paid))
    if (outstandingForeign < 0.01) return []
    // Prorate the stored base by the outstanding share (one fxRate per order).
    const totalForeign = toDecimal(order.totalForeign)
    const bookedBase = totalForeign.gt(0)
      ? multiplyMoney(order.totalBase, outstandingForeign).div(totalForeign).toNumber()
      : 0
    return [{
      id: order.id,
      reference: order.invoiceNumber ?? order.externalOrderNumber ?? order.orderNumber ?? order.id,
      side: 'receivable' as const,
      currency: order.currency,
      outstandingForeign,
      bookedRateToBase: Number(order.fxRateToBase),
      bookedBase,
    }]
  })
}

async function getOpenPayables(baseCurrency: string): Promise<OpenBalance[]> {
  const invoices = await db.purchaseInvoice.findMany({
    where: {
      paidAt: null,
      totalForeign: { gt: 0 },
      po: { currency: { not: baseCurrency } },
    },
    select: {
      id: true,
      invoiceNumber: true,
      totalForeign: true,
      totalBase: true,
      fxRateToBase: true,
      po: { select: { reference: true, currency: true } },
    },
  })

  return invoices.map((invoice) => ({
    id: invoice.id,
    reference: invoice.invoiceNumber ?? invoice.po.reference,
    side: 'payable' as const,
    currency: invoice.po.currency,
    // Preserve the stored bill precision (totalForeign is Decimal(18,4)); do NOT
    // 2dp-round here or 3-decimal currencies / 4dp bill totals would be revalued
    // against an amount that disagrees with the stored payable. computeRealisedFx
    // still rounds the resulting gain/loss to 2dp for the journal (cogs-audit scjz.57).
    outstandingForeign: toDecimal(invoice.totalForeign).toNumber(),
    bookedRateToBase: Number(invoice.fxRateToBase),
    // Open payables are fully unpaid here (paidAt: null), so the outstanding base is
    // the full stored totalBase — the real AP carrying value (cogs-audit scjz.55).
    bookedBase: toDecimal(invoice.totalBase).toNumber(),
  }))
}

async function buildRevaluationLines(params: {
  balances: OpenBalance[]
  side: FxSettlementSide
  valuationDate: string
  baseCurrency: string
  controlAccount: string
  fxGainLossAccount: string
}): Promise<{ lines: JournalLine[]; documents: number; skipped: SkippedRevaluation[] }> {
  // A valuation date is a BUSINESS DAY ('YYYY-MM-DD'): the rate is the latest one on or before the END of that day
  // (o3d-q0x56.16). `new Date('2026-06-30')` is midnight and would miss every rate fetched during the 30th.
  const valuationInstant = endOfBusinessDateUtc(params.valuationDate)
  const lines: JournalLine[] = []
  const skipped: SkippedRevaluation[] = []
  let documents = 0

  for (const balance of params.balances) {
    let settlementRateToBase: number
    try {
      settlementRateToBase = await db.$transaction((tx) => resolveSettlementFxRateToBase(tx, {
        currency: balance.currency,
        baseCurrency: params.baseCurrency,
        asOf: valuationInstant,
      }))
    } catch (error) {
      // A document with no usable rate is NOT revalued: no line is built for it, so nothing is posted at 1 or at
      // its booked rate. Any other failure is a fault, not a data gap, and still aborts the run.
      if (!isMissingFxRateError(error)) throw error
      skipped.push({
        side: params.side,
        documentId: balance.id,
        reference: balance.reference,
        currency: balance.currency,
        reason: error.reason,
        message: describeFxRefusal(error),
      })
      continue
    }
    const revaluation = computeRealisedFx({
      side: params.side,
      amountForeign: balance.outstandingForeign,
      bookedRateToBase: balance.bookedRateToBase,
      settlementRateToBase,
      bookedBase: balance.bookedBase,
    })
    const journalLines = buildRealisedFxJournal({
      side: params.side,
      gainLossBase: revaluation.gainLossBase,
      controlAccount: params.controlAccount,
      fxGainLossAccount: params.fxGainLossAccount,
      description: `Unrealised FX ${revaluation.outcome} on ${balance.reference}`,
    })
    if (journalLines.length === 0) continue
    lines.push(...journalLines)
    documents += 1
  }

  return { lines, documents, skipped }
}

async function reportWithheldSide(valuationDate: string, side: FxSettlementSide, skipped: SkippedRevaluation[]): Promise<void> {
  const { logActivity } = await import('@/lib/activity-log')
  await logActivity({
    entityType: 'SYSTEM',
    action: 'unrealised_fx_side_withheld_missing_rate',
    tag: 'accounting',
    level: 'WARNING',
    description:
      `The unrealised FX revaluation for ${valuationDate} WITHHELD the whole ${side === 'receivable' ? 'receivables (AR)' : 'payables (AP)'} side: `
      + `${skipped.length} open document${skipped.length === 1 ? ' has' : 's have'} no usable FX rate (${skipped.map((item) => `${item.reference} ${item.currency}: ${item.reason}`).join('; ')}). `
      + 'Nothing was reversed or posted for this side, so its previous valuation stays in force. Add the rate in Settings -> Currencies and rerun the revaluation.',
    metadata: { side, reason: 'side_withheld_missing_rate', valuationDate, skipped },
  }).catch(() => { /* a report that cannot be written must not abort the rest of the run */ })
}

async function reportSkippedRevaluations(valuationDate: string, skipped: SkippedRevaluation[]): Promise<void> {
  if (skipped.length === 0) return
  const { logActivity } = await import('@/lib/activity-log')
  for (const item of skipped) {
    await logActivity({
      entityType: 'SYSTEM',
      entityId: item.documentId,
      action: 'unrealised_fx_document_skipped_no_rate',
      tag: 'accounting',
      level: 'WARNING',
      description:
        `The unrealised FX revaluation for ${valuationDate} SKIPPED ${item.side === 'receivable' ? 'order' : 'bill'} `
        + `${item.reference} (${item.currency}): ${item.message} It is not in this period's revaluation journal, `
        + 'and nothing was posted for it at a default or booked rate.',
      metadata: { ...item, valuationDate },
    }).catch(() => { /* a report that cannot be written must not abort the rest of the run */ })
  }
}

export async function runArApFxRevaluation(input?: {
  valuationDate?: Date | string
}): Promise<FxRevaluationResult> {
  const valuationDate = asDateOnly(input?.valuationDate)
  const [settings, baseCurrency] = await Promise.all([
    getAccountingSettings(),
    getBaseCurrencyCode(),
  ])

  if (!settings.syncEnabled) {
    return { success: true, skipped: true, reason: 'Accounting sync disabled', valuationDate, reversed: 0, revalued: 0, documents: 0, refused: 0, skippedNoRate: [], withheldSides: [] }
  }
  if (!settings.unrealisedFxGainLossAccount) {
    return { success: false, error: 'Configure an unrealised FX gain/loss account before running revaluation.', valuationDate, reversed: 0, revalued: 0, documents: 0, refused: 0, skippedNoRate: [], withheldSides: [] }
  }
  const receivableAccounts = getUnrealisedFxAccounts(settings, 'receivable')
  const payableAccounts = getUnrealisedFxAccounts(settings, 'payable')
  if (!receivableAccounts || !payableAccounts) {
    return { success: false, error: 'Configure AR, AP, and unrealised FX accounts before running revaluation.', valuationDate, reversed: 0, revalued: 0, documents: 0, refused: 0, skippedNoRate: [], withheldSides: [] }
  }

  // Don't bail the whole run when today's revaluation already exists: the
  // reversal-retry loop below must still run so a prior reversal that failed (or
  // never queued) gets retried instead of being stranded (scjz.39). Only the
  // fresh revaluation step is skipped when it has already been queued today.
  const revaluedSides = await revaluedSidesForDate(valuationDate, settings.connector)

  // o3d-q0x56.4 (Codex R1 HIGH) - RESOLVE EVERY OPEN DOCUMENT'S RATE BEFORE ANYTHING IS REVERSED OR POSTED.
  //
  // A side is journalled as a whole: its prior journal is one entry covering all of its documents. If any open
  // document on a side has no usable rate, reversing that prior journal would back out a valuation we cannot
  // replace (and a mixed journal would be reversed in full for one missing document), and posting a new journal
  // without the document would misstate the side. So such a side is WITHHELD AS A WHOLE: no reversal, no new
  // journal, the prior valuation stays in force (the last correct statement), and the withholding is reported with
  // the skipped documents. The other side is unaffected. Nothing is queued for a withheld side, so it does not look
  // "revalued for this date" and a rerun after the rate is added does the side.
  type SidePlan = { done: boolean; built: Awaited<ReturnType<typeof buildRevaluationLines>> | null; withheld: boolean }
  const sidePlans = new Map<FxSettlementSide, SidePlan>()
  const skippedNoRate: SkippedRevaluation[] = []
  const withheldSides: WithheldSide[] = []
  for (const [side, load, accounts] of [
    ['receivable', getOpenReceivables, receivableAccounts],
    ['payable', getOpenPayables, payableAccounts],
  ] as const) {
    if (revaluedSides.has(side)) {
      sidePlans.set(side, { done: true, built: null, withheld: false })
      continue
    }
    const built = await buildRevaluationLines({
      balances: await load(baseCurrency),
      side,
      valuationDate,
      baseCurrency,
      controlAccount: accounts.controlAccount,
      fxGainLossAccount: accounts.fxGainLossAccount,
    })
    const withheld = built.skipped.length > 0
    sidePlans.set(side, { done: false, built, withheld })
    if (withheld) {
      skippedNoRate.push(...built.skipped)
      withheldSides.push({ side, reason: 'side_withheld_missing_rate', skipped: built.skipped })
      await reportSkippedRevaluations(valuationDate, built.skipped)
      await reportWithheldSide(valuationDate, side, built.skipped)
    }
  }

  let reversed = 0
  // o3d-j625 r3 (Codex MEDIUM): enqueues that declined and left the posting owed. Counted apart from
  // `reversed`/`revalued`, which now count only what was actually queued.
  let refused = 0
  const priorRevaluations = await getPriorRevaluations(valuationDate)
  let revalued = 0
  let documents = 0

  // o3d-q0x56.4 (Codex R2 HIGH) - A SIDE'S REVERSALS AND ITS REPLACEMENT ARE ONE ATOMIC UNIT.
  //
  // They used to be queued as separate enqueues (all reversals first, then each side's replacement), each in its own
  // transaction. If the replacement was then refused - an earlier FAILED attempt for today with an unresolved
  // outcome, a retired chart, anything - the reversal had already committed: the ledger lost the prior valuation with
  // no replacement, and a rerun could not take the reversal back. (That ordering, and so the defect, was already on
  // development: the reversal loop ran before the revaluation enqueue there too.)
  //
  // Now each side's reversal(s) and replacement go through the TRANSACTIONAL enqueue inside one `db.$transaction`.
  // Any enqueue that comes back refused-and-owed throws `SideEnqueueRefused`, which rolls back EVERYTHING queued for
  // that side in this unit (the refusal is evaluated by the same enqueue that would write the row, in the same
  // transaction, so nothing is written before the replacement is known to be admissible). The side is then reported
  // as blocked, with the enqueue's own reason, and counted as refused; the other side is unaffected. `not-configured`
  // (a connector that does not post FX journals, Xero by design) is not a refusal and does not block. Any other
  // failure is a fault: it rolls the unit back and propagates, as before.
  for (const side of ['receivable', 'payable'] as const) {
    const plan = sidePlans.get(side)
    if (!plan || plan.withheld) continue

    const reversals: Array<{ prior: PriorRevaluation; lines: JournalLine[]; chartConnector: NonNullable<AccountingSettings['connector']> }> = []
    for (const prior of priorRevaluations.filter((entry) => entry.side === side)) {
      const lines = reverseJournalLines(prior.lines, `(reversal for ${prior.valuationDate})`)
      if (lines.length === 0) continue
      const chartConnector = isRegisteredAccountingConnector(prior.connector) ? prior.connector : null
      if (chartConnector === null) {
        const { logActivity } = await import('@/lib/activity-log')
        await logActivity({
          entityType: 'SYSTEM',
          action: 'unrealised_fx_reversal_unroutable_source_connector',
          tag: 'accounting',
          level: 'WARNING',
          description:
            `NOTHING WAS QUEUED. The unrealised FX revaluation of ${prior.valuationDate} (sync log `
            + `${prior.id}) was posted under accounting connector '${prior.connector}', which this build `
            + 'cannot route, so its reversal cannot be raised in the books its account codes belong to. '
            + 'This reversal is still OUTSTANDING and the unrealised FX from that date is still carried: '
            + 'reverse it by hand in that connector, or cancel the source row if it never posted.',
          metadata: {
            sourceEntryId: prior.id,
            sourceConnector: prior.connector,
            sourceValuationDate: prior.valuationDate,
            valuationDate,
          },
        }).catch(() => { /* a report that cannot be written must not abort the rest of the run */ })
        continue
      }
      reversals.push({ prior, lines, chartConnector })
    }
    const built = plan.done ? null : plan.built
    const replacementLines = built && built.lines.length > 0 ? built.lines : null
    if (reversals.length === 0 && !replacementLines) {
      if (built) documents += built.documents
      continue
    }

    const counted = { reversed: 0, revalued: 0 }
    try {
      await db.$transaction(async (tx) => {
        for (const { prior, lines, chartConnector } of reversals) {
          const outcome = await queueAccountingSyncTxWithOutcome(tx, {
            type: 'UNREALISED_FX_JOURNAL',
            referenceType: 'FxRevaluation',
            referenceId: valuationDate,
            payload: {
              kind: 'reversal',
              valuationDate,
              sourceEntryId: prior.id,
              sourceValuationDate: prior.valuationDate,
              side: prior.side,
              date: valuationDate,
              reference: `FXREV-${valuationDate}`,
              narration: `Reverse unrealised FX revaluation from ${prior.valuationDate}`,
              lines,
            },
            idempotencyKey: `unrealised-fx:reversal:${valuationDate}:${prior.id}`,
            // The SOURCE row's connector (o3d-j625 r2): its codes are that chart's.
            chartConnector,
          })
          if (outcome.queued) counted.reversed += 1
          else if (postingIsOwed(outcome)) throw new SideEnqueueRefused(`the reversal of the ${prior.valuationDate} valuation (sync log ${prior.id})`, outcome)
        }
        if (replacementLines && built) {
          const outcome = await queueAccountingSyncTxWithOutcome(tx, {
            type: 'UNREALISED_FX_JOURNAL',
            referenceType: 'FxRevaluation',
            referenceId: valuationDate,
            payload: {
              kind: 'revaluation',
              valuationDate,
              side,
              date: valuationDate,
              reference: `FXREV-${valuationDate}`,
              narration: `Unrealised ${side === 'receivable' ? 'AR' : 'AP'} FX revaluation at ${valuationDate}`,
              lines: replacementLines,
              documentCount: built.documents,
            },
            idempotencyKey: `unrealised-fx:revaluation:${valuationDate}:${side}`,
            // o3d-j625: `accounts.controlAccount` / `accounts.fxGainLossAccount` are this run's chart.
            chartConnector: settings.connector,
          })
          if (outcome.queued) counted.revalued += 1
          else if (postingIsOwed(outcome)) throw new SideEnqueueRefused(`the ${side === 'receivable' ? 'AR' : 'AP'} revaluation for ${valuationDate}`, outcome)
        }
      })
    } catch (error) {
      if (!(error instanceof SideEnqueueRefused)) throw error
      refused += 1
      const detail = `${error.what} was refused by the accounting queue (${error.outcome.reason ?? 'refused'}), so NOTHING was queued for the ${side === 'receivable' ? 'receivables (AR)' : 'payables (AP)'} side: its reversal(s) and replacement are one unit and were rolled back together. The previous valuation stays in force. Resolve the cause shown in the accounting activity log (for example a FAILED attempt for this date), then rerun.`
      withheldSides.push({ side, reason: 'side_blocked_enqueue_refused', skipped: [], detail })
      const { logActivity } = await import('@/lib/activity-log')
      await logActivity({
        entityType: 'SYSTEM',
        action: 'unrealised_fx_side_blocked_enqueue_refused',
        tag: 'accounting',
        level: 'WARNING',
        description: `The unrealised FX revaluation for ${valuationDate}: ${detail}`,
        metadata: { side, reason: 'side_blocked_enqueue_refused', valuationDate, enqueueReason: error.outcome.reason ?? null, enqueueConnector: error.outcome.connector ?? null },
      }).catch(() => { /* a report that cannot be written must not abort the rest of the run */ })
      continue
    }
    reversed += counted.reversed
    revalued += counted.revalued
    if (built) documents += built.documents
  }

  const noop = revaluedSides.size > 0 && reversed === 0 && revalued === 0 && refused === 0 && withheldSides.length === 0
  return {
    success: true,
    valuationDate,
    reversed,
    revalued,
    documents,
    refused,
    skippedNoRate,
    withheldSides,
    ...(noop ? { skipped: true, reason: 'Revaluation already queued for this date' } : {}),
    // Surfaced in the cron route's JSON body, beside the per-refusal WARNING the facade writes to the
    // activity log. Not `success: false`: the run did everything it could, and failing it would make the
    // cron retry a refusal that a retry cannot fix.
    ...(refused > 0 || skippedNoRate.length > 0
      ? {
          reason: [
            refused > 0
              ? `${refused} unrealised-FX journal${refused === 1 ? '' : 's'} could not be queued and `
                + 'remain OUTSTANDING — see the accounting activity log for which, and why.'
              : null,
            skippedNoRate.length > 0
              ? `${skippedNoRate.length} open document${skippedNoRate.length === 1 ? ' has' : 's have'} no usable FX rate `
                + `(${skippedNoRate.map((item) => `${item.reference} ${item.currency}: ${item.reason}`).join('; ')}). `
                + `Add the rate in Settings -> Currencies and rerun. WITHHELD as a whole (nothing reversed or posted; the previous valuation stays in force): ${withheldSides.map((w) => (w.side === 'receivable' ? 'AR' : 'AP')).join(', ')}.`
              : null,
          ].filter(Boolean).join(' '),
        }
      : {}),
  }
}
