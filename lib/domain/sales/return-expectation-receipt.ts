import { Prisma } from '@/app/generated/prisma/client'
import { accountingPayloadKey } from '@/lib/accounting/payload-key'
import {
  lockAccountingMappingSelection,
} from '@/lib/integration-plugin-selection-lock'
import {
  getAccountingSettingsFor,
  getActiveAccountingConnectorId,
  queueAccountingSyncTxWithOutcome,
  readStockReceiptAccountsTx,
} from '@/lib/accounting'
import { LEDGER_STANDING_SELECT, ledgerStanding } from '@/lib/domain/accounting/ledger-standing'
import { postingIsOwed, isShadowedOutcome } from '@/lib/domain/accounting/enqueue-outcome'
import { recordTransitSubledgerMovement } from '@/lib/domain/accounting/transit-subledger-movement'
import { compareDecimal, roundQuantity, subtractMoney, toDecimal, type Decimal, type DecimalInput } from '@/lib/domain/math/decimal'
import { deriveReturnExpectationStatus } from '@/lib/domain/workflows/return-expectation-state'
import type { ReturnExpectationCostEntry } from '@/lib/domain/sales/return-expectation-plan'
import { ReturnExpectationError } from '@/lib/domain/sales/return-expectation'

/**
 * ARRIVAL: a returned parcel reaches the warehouse and clears the return expectation its refund left behind.
 *
 * A refund routed in transit (see return-expectation.ts) restocked nothing. The units come back into stock HERE, and
 * only here, when the warehouse returns inbox sees them arrive. This module is the pure-ish planning half (which
 * lines the arrival clears, how much, at what cost) and the in-transaction writer; the stock movement itself is
 * booked by the caller through the existing return-inbound writer so it is one code path.
 *
 * MATCHING. By order and product, oldest refund first, line by line. An arrival that exceeds what is outstanding
 * leaves a remainder that the caller books as a plain restock (the operator's decision, as before); an arrival with
 * nothing outstanding matches nothing. Only a VALUED document is usable: an unvalued one is still waiting for its
 * accounting staging, and receiving against it would book stock at a cost nobody has fixed yet.
 *
 * COST. The units come back at the refund's own dispatch-cost snapshot. A line's snapshot is consumed in entry order,
 * so a part-arrival takes the first units' cost and the next arrival the next. The value released is the DIFFERENCE
 * of cumulative values, each rounded once at 6dp, so the pieces of a line add up to exactly the line's value.
 *
 * LEDGER. Only a document whose refund really debited Stock in Transit (it recorded a journal key) is cleared in the
 * ledger: DR Inventory / CR Stock in Transit, with the matching negative CUSTOMER_RETURN_IN_TRANSIT sub-ledger row
 * in the same transaction, on the queue's own answer and never for a shadowed journal.
 */

export type ReceiptLineCandidate = {
  lineId: string
  expectationId: string
  qty: DecimalInput
  qtyReceived: DecimalInput
  qtyWrittenOff: DecimalInput
  costSnapshot: unknown
  /** False while the refund's accounting staging has not valued the document yet. */
  valued: boolean
}

export type ReceiptChunk = {
  lineId: string
  expectationId: string
  /** Units of this line cleared by the arrival. */
  qty: Decimal
  /** The cost entries of those units, in order. */
  entries: ReturnExpectationCostEntry[]
  /** Value of those units at the snapshot cost, 6dp. */
  valueBase: Decimal
}

export type ReceiptPlan = {
  chunks: ReceiptChunk[]
  remainder: Decimal
  /**
   * The oldest open expectation that would absorb a unit of this arrival is not valued yet. Nothing may be received
   * until it is: the arrival is held whole, and no quantity falls through to the plain restock.
   */
  awaitingValuation: boolean
}

function parseEntries(snapshot: unknown): ReturnExpectationCostEntry[] {
  if (!Array.isArray(snapshot)) throw new ReturnExpectationError('snapshot_unreadable')
  return snapshot.map((raw) => {
    const entry = raw as Record<string, unknown>
    if (typeof entry?.qty !== 'string') throw new ReturnExpectationError('snapshot_unreadable')
    return {
      qty: entry.qty,
      unitCostBase: typeof entry.unitCostBase === 'string' ? entry.unitCostBase : null,
      poLineId: typeof entry.poLineId === 'string' ? entry.poLineId : null,
      sourceCostLayerId: typeof entry.sourceCostLayerId === 'string' ? entry.sourceCostLayerId : null,
    }
  })
}

/** The entries covering units [from, from + take) of a snapshot, splitting the entry the window cuts through. */
export function sliceSnapshot(
  entries: readonly ReturnExpectationCostEntry[],
  from: DecimalInput,
  take: DecimalInput,
): ReturnExpectationCostEntry[] {
  const start = toDecimal(from)
  const end = start.add(toDecimal(take))
  const out: ReturnExpectationCostEntry[] = []
  let cursor = toDecimal(0)
  for (const entry of entries) {
    const entryQty = toDecimal(entry.qty)
    const entryStart = cursor
    const entryEnd = cursor.add(entryQty)
    cursor = entryEnd
    const lo = entryStart.gt(start) ? entryStart : start
    const hi = entryEnd.lt(end) ? entryEnd : end
    if (hi.lte(lo)) continue
    out.push({ ...entry, qty: roundQuantity(hi.sub(lo), 6).toFixed(6) })
  }
  return out
}

/** Value of the first `units` units of a snapshot, summed unrounded and rounded once at 6dp. */
export function cumulativeSnapshotValue(entries: readonly ReturnExpectationCostEntry[], units: DecimalInput): Decimal {
  let total = toDecimal(0)
  for (const entry of sliceSnapshot(entries, 0, units)) {
    if (entry.unitCostBase == null) continue
    total = total.add(toDecimal(entry.qty).mul(toDecimal(entry.unitCostBase)))
  }
  return roundQuantity(total, 6)
}

/**
 * Plan how an arrival of `qty` units clears the candidate lines (already ordered oldest refund first). Pure.
 */
export function planReturnReceipt(qty: DecimalInput, candidates: readonly ReceiptLineCandidate[]): ReceiptPlan {
  let remaining = toDecimal(qty)
  const chunks: ReceiptChunk[] = []
  for (const candidate of candidates) {
    if (compareDecimal(remaining, 0) <= 0) break
    const outstanding = subtractMoney(subtractMoney(candidate.qty, candidate.qtyReceived), candidate.qtyWrittenOff)
    if (compareDecimal(outstanding, 0) <= 0) continue
    // Oldest first, valued or not: an unvalued document that would take units holds the whole arrival.
    if (!candidate.valued) return { chunks: [], remainder: roundQuantity(qty, 6), awaitingValuation: true }
    const take = outstanding.lt(remaining) ? outstanding : remaining
    const entries = parseEntries(candidate.costSnapshot)
    const received = toDecimal(candidate.qtyReceived)
    const sliced = sliceSnapshot(entries, received, take)
    const valueBase = subtractMoney(
      cumulativeSnapshotValue(entries, received.add(take)),
      cumulativeSnapshotValue(entries, received),
    )
    chunks.push({ lineId: candidate.lineId, expectationId: candidate.expectationId, qty: roundQuantity(take, 6), entries: sliced, valueBase })
    remaining = remaining.sub(take)
  }
  return { chunks, remainder: roundQuantity(remaining, 6), awaitingValuation: false }
}

export type ReceiptAccounting = {
  /** The active accounting connector when sync is on, else null: nothing is journalled. */
  connector: Parameters<typeof lockAccountingMappingSelection>[1] | null
  syncEnabled: boolean
}

/**
 * Read BEFORE the transaction opens (a pool read): which ledger an arrival would post to and whether sync is on. The
 * account codes are NOT taken from here; they are read inside the transaction under the mapping lock.
 */
export async function readReceiptAccounting(): Promise<ReceiptAccounting> {
  const connector = await getActiveAccountingConnectorId()
  const settings = await getAccountingSettingsFor(connector)
  return { connector, syncEnabled: settings.syncEnabled }
}

export type ReceiptRow = {
  productId: string
  qty: number
  /**
   * Groups the rows of one cleared line so the return-inbound writer books one movement per line at that line's own
   * cost (it aggregates by product AND this key). It is the expectation line's id, not a refund line's: the writer
   * only uses it as a grouping key for a non-refund reference. Absent on the cost-less remainder row.
   */
  refundLineId?: string
  unitCostBase?: string | null
  poLineId?: string | null
  sourceCostLayerId?: string | null
}

export type ReceiveAgainstExpectationsResult = {
  /** Rows for the return-inbound writer: cost-bearing rows for matched units, a cost-less row for the remainder. */
  rows: ReceiptRow[]
  matchedQty: Decimal
  remainder: Decimal
  expectationIds: string[]
}

type Candidate = {
  line_id: string
  expectation_id: string
  qty: Prisma.Decimal
  qty_received: Prisma.Decimal
  qty_written_off: Prisma.Decimal
  cost_snapshot: unknown
  valued: boolean
}

/**
 * Clear the order's open return expectations for one product with an arrival. Runs inside the caller's transaction,
 * which must already hold the order lock. Does NOT book the stock: it returns the rows to book.
 */
export async function receiveReturnAgainstExpectationsTx(
  tx: Prisma.TransactionClient,
  params: {
    inboxId: string
    orderId: string
    productId: string
    qty: number
    /** The arrival's business date (the journal date). */
    arrivedAt: Date
    accounting: ReceiptAccounting
  },
): Promise<ReceiveAgainstExpectationsResult> {
  const candidates = await tx.$queryRaw<Candidate[]>(Prisma.sql`
    SELECT l.id AS line_id, l.expectation_id, l.qty, l.qty_received, l.qty_written_off, l.cost_snapshot, (e.valued_at IS NOT NULL) AS valued
      FROM return_expectation_lines l
      JOIN return_expectations e ON e.id = l.expectation_id
     WHERE e.order_id = ${params.orderId}
       AND l.product_id = ${params.productId}
       AND e.status IN ('IN_TRANSIT', 'PARTIALLY_RECEIVED', 'PARTIALLY_WRITTEN_OFF')
       AND l.qty > l.qty_received + l.qty_written_off
     ORDER BY e.created_at ASC, e.id ASC, l.created_at ASC, l.id ASC
       FOR UPDATE OF l`)
  const plan = planReturnReceipt(params.qty, candidates.map((row) => ({
    lineId: row.line_id,
    expectationId: row.expectation_id,
    qty: row.qty,
    qtyReceived: row.qty_received,
    qtyWrittenOff: row.qty_written_off,
    costSnapshot: row.cost_snapshot,
    valued: row.valued,
  })))
  // HELD, not restocked: an operator re-runs the restock from the returns inbox once the refund is valued (nothing
  // retries it by itself). Throwing rolls back the caller's transaction; nothing has been written yet.
  if (plan.awaitingValuation) throw new ReturnExpectationError('awaiting_refund_valuation')

  // The ledger side is decided BEFORE anything is written, so a hold leaves nothing behind. An arrival clears transit
  // only against a refund transit debit that is proven queued, in that debit's own ledger.
  const modes = new Map<string, ClearingMode>()
  for (const expectationId of new Set(plan.chunks.map((chunk) => chunk.expectationId))) {
    modes.set(expectationId, await resolveClearingMode(tx, expectationId, params.accounting))
  }

  const rows: ReceiptRow[] = []
  for (const chunk of plan.chunks) {
    for (const entry of chunk.entries) {
      rows.push({
        productId: params.productId,
        refundLineId: chunk.lineId,
        qty: Number(entry.qty),
        unitCostBase: entry.unitCostBase,
        poLineId: entry.poLineId,
        sourceCostLayerId: entry.sourceCostLayerId,
      })
    }
    await tx.returnExpectationLine.update({
      where: { id: chunk.lineId },
      data: { qtyReceived: { increment: chunk.qty.toFixed(6) } },
    })
  }
  if (compareDecimal(plan.remainder, 0) > 0) rows.push({ productId: params.productId, qty: plan.remainder.toNumber() })

  const expectationIds = [...new Set(plan.chunks.map((chunk) => chunk.expectationId))]
  for (const expectationId of expectationIds) {
    const expectation = await tx.returnExpectation.findUniqueOrThrow({
      where: { id: expectationId },
      select: {
        id: true, reference: true, refundId: true, transitJournalKey: true, transitDebitBase: true, transitClearedAmount: true,
        lines: { select: { id: true, qty: true, qtyReceived: true, qtyWrittenOff: true, costSnapshot: true } },
      },
    })
    const status = deriveReturnExpectationStatus(expectation.lines)
    await tx.returnExpectation.update({
      where: { id: expectationId },
      data: { status, closedAt: status === 'RECEIVED' || status === 'WRITTEN_OFF' ? new Date() : null },
    })
    const mode = modes.get(expectationId)!
    if (mode.kind === 'none') {
      if (mode.record) {
        await tx.activityLog.create({
          data: {
            entityType: 'SALES_ORDER',
            entityId: expectation.refundId,
            action: 'return_expectation_arrival_debit_not_posted',
            tag: 'accounting',
            level: 'WARNING',
            description: 'A returned parcel arrived for a refund whose Stock in Transit debit was never posted (cancelled or shadowed), so no clearing journal was queued.',
            metadata: { expectationId: expectation.id, inboxId: params.inboxId },
          },
        })
      }
      continue
    }
    if (expectation.transitJournalKey == null || expectation.transitDebitBase == null) continue

    // CUMULATIVE, not per arrival: the amount an arrival clears is round(value of everything received after it) minus
    // round(value of everything received before it), so cents are never lost to per-arrival rounding (3 x 0.333333
    // clears 1.00, not 0.99) and an arrival too small to move a cent carries its value forward. The arrival that closes
    // the document clears exactly what the refund posted, whatever the snapshot arithmetic says.
    let after = toDecimal(0)
    for (const line of expectation.lines) {
      const entries = parseEntries(line.costSnapshot)
      const receivedAfter = toDecimal(line.qtyReceived)
      after = after.add(cumulativeSnapshotValue(entries, receivedAfter))
    }
    const closes = status === 'RECEIVED' || status === 'WRITTEN_OFF'
    const postedCents = roundQuantity(expectation.transitDebitBase, 2)
    // Target for everything received so far, less what has actually been journalled (not what an earlier arrival
    // meant to journal), so a skipped or shadowed clearing is made up by the next one.
    const cents = subtractMoney(closes ? postedCents : roundQuantity(after, 2), expectation.transitClearedAmount)
    if (compareDecimal(cents, 0) <= 0 && !closes) continue
    // The sub-ledger equals the journal, except that the closing arrival also clears the sub-penny residue the refund's
    // 6dp row holds, so the document's rows net to exactly zero.
    let subledgerBase = cents
    if (closes) {
      const prior = await tx.transitSubledgerMovement.aggregate({
        where: {
          sourceType: 'CUSTOMER_RETURN_IN_TRANSIT',
          sourceRef: expectation.refundId,
          idempotencyKey: { startsWith: `return-expectation-receipt:${expectation.id}:` },
        },
        _sum: { baseDelta: true },
      })
      subledgerBase = subtractMoney(expectation.transitDebitBase, subtractMoney(0, prior._sum.baseDelta ?? 0))
    }
    if (compareDecimal(cents, 0) <= 0) {
      // The closing arrival has no cent left to journal (earlier arrivals already cleared the posted amount): no
      // zero-value journal, but the residue row is still written so a closed document's rows net to exactly zero.
      // Keyed like the other clearing rows, so a replay is a no-op.
      if (compareDecimal(subledgerBase, 0) !== 0) {
        await recordTransitSubledgerMovement(tx, {
          sourceType: 'CUSTOMER_RETURN_IN_TRANSIT',
          sourceRef: expectation.refundId,
          idempotencyKey: `return-expectation-receipt:${expectation.id}:${params.inboxId}:residue`,
          baseDelta: subledgerBase.neg(),
          journalDate: params.arrivedAt.toISOString().slice(0, 10),
        })
      }
      continue
    }
    await clearTransitInLedger(tx, {
      expectation: { id: expectation.id, reference: expectation.reference, refundId: expectation.refundId },
      inboxId: params.inboxId,
      amount: cents.toNumber(),
      subledgerBase,
      arrivedAt: params.arrivedAt,
      accounting: params.accounting,
      connector: mode.connector,
    })
  }

  return {
    rows,
    matchedQty: plan.chunks.reduce((sum, chunk) => sum.add(chunk.qty), toDecimal(0)),
    remainder: plan.remainder,
    expectationIds,
  }
}

type ClearingMode = { kind: 'none'; record: boolean } | { kind: 'journal'; connector: NonNullable<ReceiptAccounting['connector']> }

/**
 * May this arrival clear transit in the ledger, and against which ledger? Decided under the order lock, before any write.
 *
 *  - The refund recorded no transit journal key and owes no accounting retry: transit never held this value (accounting
 *    was off at the refund). Nothing to clear: stock only.
 *  - No key but the refund still owes its accounting, or a key with no sync row yet: the debit is not queued. HOLD
 *    (`awaiting_refund_journal`): clearing it first would credit a transit the ledger has not debited.
 *  - The sync row's standing says the debit never reached the ledger (a producer-hold shadow, or an orphan proven not
 *    posted): it will not be. DEFINED OUTCOME: the same as the refund side's shadow, which writes no transit
 *    sub-ledger row. The goods are restocked with no clearing journal and the arrival says so in the activity log.
 *  - The row's standing is unproven (UNKNOWN, an operator's not-posted): HOLD (`awaiting_refund_journal`), a person decides.
 *  - The row is queued or posted (live work or confirmed): the clearing must go to THAT ledger. If
 *    accounting is off or the active connector is another one, HOLD (`awaiting_accounting`): stock must not be booked
 *    without the journal that moves its value out of transit.
 */
async function resolveClearingMode(
  tx: Prisma.TransactionClient,
  expectationId: string,
  accounting: ReceiptAccounting,
): Promise<ClearingMode> {
  const expectation = await tx.returnExpectation.findUniqueOrThrow({
    where: { id: expectationId },
    select: { refundId: true, transitJournalKey: true, refund: { select: { accountingRetryRequired: true } } },
  })
  if (!expectation.transitJournalKey) {
    if (expectation.refund.accountingRetryRequired) throw new ReturnExpectationError('awaiting_refund_journal')
    return { kind: 'none', record: false }
  }
  const row = await tx.accountingSyncLog.findFirst({
    where: {
      type: 'COGS_REVERSAL',
      referenceType: 'SalesOrderRefund',
      referenceId: expectation.refundId,
      payload: { path: ['_idempotencyKey'], equals: expectation.transitJournalKey },
    },
    select: { connector: true, ...LEDGER_STANDING_SELECT },
  })
  if (!row) throw new ReturnExpectationError('awaiting_refund_journal')
  // What the row says about the ledger is decided by the one reader of that rule.
  const standing = ledgerStanding(row)
  if (standing === 'SHADOW_NOT_SENT_BY_IMS' || standing === 'PROVEN_NOT_POSTED') return { kind: 'none', record: true }
  // Unproven either way (an operator said not-posted, a failed or cancelled row nothing can read): a person decides.
  if (standing === 'UNKNOWN' || standing === 'ASSERTED_NOT_POSTED') throw new ReturnExpectationError('awaiting_refund_journal')
  if (!accounting.connector || !accounting.syncEnabled || accounting.connector !== row.connector) {
    throw new ReturnExpectationError('awaiting_accounting')
  }
  return { kind: 'journal', connector: accounting.connector }
}

async function clearTransitInLedger(
  tx: Prisma.TransactionClient,
  params: {
    expectation: { id: string; reference: string; refundId: string }
    inboxId: string
    /** Cents to journal (2dp). */
    amount: number
    /** The sub-ledger movement magnitude (6dp). */
    subledgerBase: Decimal
    arrivedAt: Date
    accounting: ReceiptAccounting
    connector: NonNullable<ReceiptAccounting['connector']>
  },
): Promise<void> {
  const { syncEnabled } = params.accounting
  const connector = params.connector
  if (!syncEnabled) {
    // The refund debited transit, the ledger is now off: the clearing cannot be posted. Say so, loudly and closed-code.
    await tx.activityLog.create({
      data: {
        entityType: 'SALES_ORDER',
        entityId: params.expectation.refundId,
        action: 'return_expectation_arrival_not_journalled',
        tag: 'accounting',
        level: 'WARNING',
        description: 'A returned parcel arrived but accounting is off, so its Stock in Transit clearing journal was not queued.',
        metadata: { expectationId: params.expectation.id, inboxId: params.inboxId },
      },
    })
    return
  }
  await lockAccountingMappingSelection(tx, connector)
  const accounts = await readStockReceiptAccountsTx(tx, connector)
  // Fail closed: the throw rolls back the restock with it, leaving the inbox row unrestocked for a retry once the
  // accounts are mapped. Posting to a guessed account would put value in the wrong place.
  if (!accounts.inventoryAccount || !accounts.transitAccount) throw new ReturnExpectationError('arrival_accounts_not_configured')

  const amount = params.amount
  if (amount <= 0) return
  const payload = {
    date: params.arrivedAt.toISOString().slice(0, 10),
    reference: `Return received: ${params.expectation.reference}`,
    narration: `Stock in Transit cleared on arrival of returned goods (${params.expectation.reference})`,
    lines: [
      { accountCode: accounts.inventoryAccount, description: `Return received: ${params.expectation.reference}`, debit: amount },
      { accountCode: accounts.transitAccount, description: `Return received: ${params.expectation.reference}`, credit: amount },
    ],
  }
  const idempotencyKey = accountingPayloadKey(`return-expectation-receipt:${params.expectation.id}:${params.inboxId}`, payload)
  const outcome = await queueAccountingSyncTxWithOutcome(tx, {
    type: 'STOCK_RECEIPT',
    referenceType: 'ReturnExpectation',
    referenceId: params.expectation.id,
    payload,
    idempotencyKey,
    connector,
    chartConnector: connector,
  })
  if (outcome.queued && !isShadowedOutcome(outcome)) {
    await tx.returnExpectation.update({
      where: { id: params.expectation.id },
      data: { transitClearedAmount: { increment: amount.toFixed(2) } },
    })
    await recordTransitSubledgerMovement(tx, {
      sourceType: 'CUSTOMER_RETURN_IN_TRANSIT',
      sourceRef: params.expectation.refundId,
      idempotencyKey,
      baseDelta: params.subledgerBase.neg(),
      journalDate: payload.date,
    })
    return
  }
  // A refusal is a debt: the stock must not commit without its journal, so the whole arrival rolls back.
  if (postingIsOwed(outcome)) throw new ReturnExpectationError('arrival_journal_refused')
}
