import { db } from '@/lib/db'
import { getAccountingSettings, queueAccountingSync, type AccountingSettings } from '@/lib/accounting'
import { postingIsOwed } from '@/lib/domain/accounting/enqueue-outcome'
import {
  buildRealisedFxJournal,
  computeRealisedFx,
  reverseJournalLines,
  getUnrealisedFxAccounts,
  resolveSettlementFxRateToBase,
  roundAccountingMoney,
  type FxSettlementSide,
} from '@/lib/accounting-fx'
import { getBaseCurrencyCode } from '@/lib/base-currency'
import { addMoney, multiplyMoney, subtractMoney, toDecimal } from '@/lib/domain/math/decimal'

const ACTIVE_SYNC_STATUSES = ['PENDING', 'PROCESSING', 'SYNCED'] as const

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
      status: { in: [...ACTIVE_SYNC_STATUSES] },
    },
    orderBy: { createdAt: 'asc' },
    // o3d-j625 r2 (Codex MEDIUM 1): `connector` is SELECTED. Without it the reversal had no way to say
    // whose chart of accounts its lines were, and attributed them to the current settings object.
    select: { id: true, connector: true, payload: true },
  })
  return selectPriorRevaluationsToReverse(logs, valuationDate)
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
async function hasRevaluationForDate(
  valuationDate: string,
  connector: AccountingSettings['connector'],
): Promise<boolean> {
  if (connector === null) return false
  const logs = await db.accountingSyncLog.findMany({
    where: {
      type: 'UNREALISED_FX_JOURNAL',
      status: { in: [...ACTIVE_SYNC_STATUSES] },
      // o3d-j625 r3 (Codex HIGH 4): the whole point — another connector's revaluation for this date
      // does not relieve this connector of writing its own.
      connector,
    },
    select: { payload: true },
  })
  return logs.some((log) => {
    const payload = log.payload
    return isActivePayload(payload) &&
      payload.kind === 'revaluation' &&
      payload.valuationDate === valuationDate
  })
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
}): Promise<{ lines: JournalLine[]; documents: number }> {
  const valuationDate = new Date(params.valuationDate)
  const lines: JournalLine[] = []
  let documents = 0

  for (const balance of params.balances) {
    const settlementRateToBase = await db.$transaction((tx) => resolveSettlementFxRateToBase(tx, {
      currency: balance.currency,
      baseCurrency: params.baseCurrency,
      asOf: valuationDate,
      fallbackRateToBase: balance.bookedRateToBase,
      referenceType: params.side === 'receivable' ? 'SalesOrder' : 'PurchaseInvoice',
      referenceId: balance.id,
    }))
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

  return { lines, documents }
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
    return { success: true, skipped: true, reason: 'Accounting sync disabled', valuationDate, reversed: 0, revalued: 0, documents: 0, refused: 0 }
  }
  if (!settings.unrealisedFxGainLossAccount) {
    return { success: false, error: 'Configure an unrealised FX gain/loss account before running revaluation.', valuationDate, reversed: 0, revalued: 0, documents: 0, refused: 0 }
  }
  const receivableAccounts = getUnrealisedFxAccounts(settings, 'receivable')
  const payableAccounts = getUnrealisedFxAccounts(settings, 'payable')
  if (!receivableAccounts || !payableAccounts) {
    return { success: false, error: 'Configure AR, AP, and unrealised FX accounts before running revaluation.', valuationDate, reversed: 0, revalued: 0, documents: 0, refused: 0 }
  }

  // Don't bail the whole run when today's revaluation already exists: the
  // reversal-retry loop below must still run so a prior reversal that failed (or
  // never queued) gets retried instead of being stranded (scjz.39). Only the
  // fresh revaluation step is skipped when it has already been queued today.
  const alreadyRevaluedForDate = await hasRevaluationForDate(valuationDate, settings.connector)

  let reversed = 0
  // o3d-j625 r3 (Codex MEDIUM): enqueues that declined and left the posting owed. Counted apart from
  // `reversed`/`revalued`, which now count only what was actually queued.
  let refused = 0
  const priorRevaluations = await getPriorRevaluations(valuationDate)
  for (const prior of priorRevaluations) {
    const lines = reverseJournalLines(prior.lines, `(reversal for ${prior.valuationDate})`)
    if (lines.length === 0) continue
    // o3d-j625 r2 (Codex MEDIUM 1) — A CONNECTOR THIS BUILD CANNOT ROUTE IS REFUSED, NOT GUESSED AT.
    //
    // `prior.connector` is a raw column value. Every row this build writes carries 'xero' or
    // 'quickbooks', but a row written by another build (or a connector since removed — see the
    // ShipHero removal in #680) can carry something else, and there is no safe substitute for it:
    // naming this run's connector is the mis-attribution being fixed, and `null` would answer
    // `not-configured`, which is the one no-op an obligation ledger is allowed to settle with. So the
    // reversal is left OUTSTANDING and said to be outstanding.
    const chartConnector = prior.connector === 'xero' || prior.connector === 'quickbooks'
      ? prior.connector
      : null
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
    const reversalEnqueued = await queueAccountingSync({
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
      // o3d-j625 r2 (Codex MEDIUM 1) — THE SOURCE ROW'S CONNECTOR, NOT THIS RUN'S SETTINGS OBJECT.
      //
      // `lines` is `reverseJournalLines(prior.lines, …)`: every account code on this journal was read
      // out of a HISTORIC `AccountingSyncLog.payload`, not off the `settings` read at the top of this
      // function. r1 wrote `settings.connector` here and argued that "every account code reachable from
      // here came from the single getAccountingSettings()" — which is true of the REVALUATION enqueue
      // below and false of this one. Attributing a QuickBooks-era journal's codes to a now-active Xero
      // chart is the mis-routing of an existing cross-connector row, so it is routed by the row.
      //
      // A prior whose connector is no longer the active one is therefore REFUSED by the facade (and
      // recorded as owed) instead of being reversed into the wrong books — which is the correct answer:
      // you cannot reverse a QuickBooks journal by posting to Xero.
      chartConnector,
    })
    // o3d-j625 r3 (Codex MEDIUM) — THE ANSWER IS READ, AND A REFUSAL IS NOT A REVERSAL.
    //
    // `reversed += 1` ran unconditionally. A prior written under a connector that is KNOWN but no
    // longer active reaches the facade, is refused there (the chart cannot be honoured), and this loop
    // counted it anyway — reporting a reversal with no reversal row, which makes the unrealised FX from
    // that date look backed out when it is still carried. The facade writes its own
    // `accounting_enqueue_refused_retired_chart` WARNING naming both connectors, so the report here is
    // the count: what the run owes.
    //
    // `not-configured` is not counted as owed either way — it means this connector does not post FX
    // journals at all (Xero, by design: see isFxGainLossJournalSuppressed), so there is no reversal
    // outstanding to chase.
    if (reversalEnqueued.queued) reversed += 1
    else if (postingIsOwed(reversalEnqueued)) refused += 1
  }

  let revalued = 0
  let documents = 0
  // Skip only the fresh revaluation when one is already queued for today; the
  // reversal retries above always run regardless (scjz.39).
  if (!alreadyRevaluedForDate) {
    const [receivables, payables] = await Promise.all([
      getOpenReceivables(baseCurrency),
      getOpenPayables(baseCurrency),
    ])

    for (const [side, balances, accounts] of [
      ['receivable', receivables, receivableAccounts],
      ['payable', payables, payableAccounts],
    ] as const) {
      const built = await buildRevaluationLines({
        balances,
        side,
        valuationDate,
        baseCurrency,
        controlAccount: accounts.controlAccount,
        fxGainLossAccount: accounts.fxGainLossAccount,
      })
      documents += built.documents
      if (built.lines.length === 0) continue

      const revaluationEnqueued = await queueAccountingSync({
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
          lines: built.lines,
          documentCount: built.documents,
        },
        idempotencyKey: `unrealised-fx:revaluation:${valuationDate}:${side}`,
        // o3d-j625: `accounts.controlAccount` / `accounts.fxGainLossAccount` are this run's chart.
        chartConnector: settings.connector,
      })
      // o3d-j625 r3 (Codex MEDIUM): the same defect on the same function's other enqueue. The reviewer
      // named the reversal; this one is identical and is fixed with it — a revaluation counted as done
      // is worse here, because `hasRevaluationForDate` would then read a row that does not exist... or,
      // the case that actually bit, read ANOTHER connector's row (Codex HIGH 4) and skip the run.
      if (revaluationEnqueued.queued) revalued += 1
      else if (postingIsOwed(revaluationEnqueued)) refused += 1
    }
  }

  // Report skipped only when nothing happened this run (revaluation already
  // existed and no reversal needed retrying), preserving the prior signal.
  //
  // o3d-j625 r3 (Codex MEDIUM): AND A REFUSAL IS NOT NOTHING HAPPENING. `reversed === 0 && revalued === 0`
  // used to be reachable with several refused enqueues behind it, and the run then announced itself as
  // a no-op — the most reassuring message available for the state where postings are owed.
  const noop = alreadyRevaluedForDate && reversed === 0 && revalued === 0 && refused === 0
  return {
    success: true,
    valuationDate,
    reversed,
    revalued,
    documents,
    refused,
    ...(noop ? { skipped: true, reason: 'Revaluation already queued for this date' } : {}),
    // Surfaced in the cron route's JSON body, beside the per-refusal WARNING the facade writes to the
    // activity log. Not `success: false`: the run did everything it could, and failing it would make the
    // cron retry a refusal that a retry cannot fix.
    ...(refused > 0
      ? {
          reason:
            `${refused} unrealised-FX journal${refused === 1 ? '' : 's'} could not be queued and `
            + 'remain OUTSTANDING — see the accounting activity log for which, and why.',
        }
      : {}),
  }
}
