import type { Prisma } from '@/app/generated/prisma/client'
import { compareDecimal, toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'
import {
  planReturnExpectationLines,
  type ReturnExpectationRowInput,
} from '@/lib/domain/sales/return-expectation-plan'

/**
 * Return expectations: the document a refund leaves behind when its returned units are IN TRANSIT instead of
 * restocked.
 *
 * WHAT ROUTES A REFUND HERE. The setting below reads exactly 'true' (like the storefront stock switch, anything
 * else - absent, empty, 'True' - is off), AND the refund returns stock (it has a return warehouse and is not a
 * chargeback). The decision is taken ONCE, inside the refund transaction under the order lock, and persisted on
 * the refund (`returnInTransit`): an accounting retry days later reads the refund, not the setting, so a switch
 * flipped in between cannot make the same refund's COGS reversal debit Inventory on one attempt and Stock in
 * Transit on the next.
 *
 * WHAT IT DOES NOT DO. It creates no stock movement, no stock level change and no cost layer, so nothing returned
 * is on hand, allocatable or pushed to a storefront until it arrives. Arrival (clearing the document against the
 * returns inbox, and writing off units that never come back) is a later slice; until then the switch stays off.
 */
export const REFUND_RETURNS_IN_TRANSIT_SETTING = 'refund_returns_in_transit_enabled'

export const RETURN_EXPECTATION_REFERENCE_PREFIX = 'RX-'

type SettingReader = Pick<Prisma.TransactionClient, 'setting'>

/**
 * Whether new refunds are routed in transit. A read that fails THROWS (the refund transaction aborts): "could not
 * read the switch" is neither on nor off, and silently answering off would restock goods the operator asked to
 * hold in transit.
 */
export async function readReturnsInTransitEnabled(tx: SettingReader): Promise<boolean> {
  const row = await tx.setting.findUnique({
    where: { key: REFUND_RETURNS_IN_TRANSIT_SETTING },
    select: { value: true },
  })
  return row?.value === 'true'
}

export class ReturnExpectationError extends Error {
  constructor(readonly code:
    | 'refund_line_not_on_refund'
    | 'transit_link_conflict'
    | 'transit_value_not_positive'
    | 'unvalued_document_has_accounted_quantity') {
    super(`return_expectation:${code}`)
    this.name = 'ReturnExpectationError'
  }
}

/** The ledger side of an expectation: the COGS reversal journal that debited Stock in Transit for it. */
export type ReturnExpectationTransitLink = {
  journalKey: string
  /** What that journal debited, at 6dp. */
  debitBase: DecimalInput
}

export type CreateReturnExpectationResult = {
  /**
   * 'created'  a new document was written.
   * 'valued'   an unvalued document was settled (lines re-stated from the staged rows, link recorded).
   * 'existing' a settled document was already there; only its ledger link may be learned.
   * 'none'     the rows named no returnable quantity: no document is created for an empty return.
   */
  outcome: 'created' | 'valued' | 'existing' | 'none'
  expectationId: string | null
}

type ExpectationParams = {
  refundId: string
  orderId: string
  creditNoteNumber?: string | null
  expectedWarehouseId?: string | null
  rows: readonly ReturnExpectationRowInput[]
  transit?: ReturnExpectationTransitLink | null
}

/**
 * Write the refund's return expectation, once. Called in TWO places, both inside a transaction that also commits the
 * thing the document depends on, so there is no committed state with one and not the other:
 *
 *  1. `valued: false|true` from the refund's OWN transaction (under the order lock), from the refund's quantities. A
 *     refund that routes its goods in transit therefore cannot commit without its document. `valued: true` when no
 *     accounting staging will follow (nothing will ever price it); `valued: false` when staging follows, whose
 *     transaction then calls `settleReturnExpectationTx`.
 *  2. `settleReturnExpectationTx`, from the staging transaction (and every accounting retry), which values the
 *     document with the staged cost snapshot and records the journal that debited Stock in Transit for it, in the
 *     SAME commit that persists the staged syncs.
 *
 * Safe to call again for the same refund (first attempt, retry, replay): the document is keyed on the refund. A
 * per-refund transaction lock serialises two callers; the unique keys behind it make a missed lock a loud error and
 * not a duplicate.
 */
export async function createReturnExpectationTx(
  tx: Prisma.TransactionClient,
  params: ExpectationParams & { valued: boolean },
): Promise<CreateReturnExpectationResult> {
  return writeExpectation(tx, params, params.valued)
}

/** Value the document (creating it if the refund transaction wrote none) from the staged rows and the staged journal. */
export async function settleReturnExpectationTx(
  tx: Prisma.TransactionClient,
  params: ExpectationParams,
): Promise<CreateReturnExpectationResult> {
  return writeExpectation(tx, params, true)
}

async function writeExpectation(
  tx: Prisma.TransactionClient,
  params: ExpectationParams,
  valued: boolean,
): Promise<CreateReturnExpectationResult> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`return_expectation:${params.refundId}`}))`

  const transitDebit = params.transit ? toDecimal(params.transit.debitBase) : null
  if (params.transit && transitDebit && compareDecimal(transitDebit, 0) <= 0) {
    throw new ReturnExpectationError('transit_value_not_positive')
  }

  const existing = await tx.returnExpectation.findUnique({
    where: { refundId: params.refundId },
    select: {
      id: true,
      valuedAt: true,
      transitJournalKey: true,
      transitDebitBase: true,
      lines: { select: { id: true, refundLineId: true, productId: true, qtyReceived: true, qtyWrittenOff: true } },
    },
  })
  // A settled document keeps its lines (first write wins). An unvalued one is only ever written by the refund
  // transaction that created it and the staging that values it, so a repeat of the creating step is a no-op too.
  if (existing && (existing.valuedAt != null || !valued)) {
    await reconcileTransitLink(tx, existing, params.transit ?? null, transitDebit)
    return { outcome: 'existing', expectationId: existing.id }
  }

  const productIds = [...new Set(params.rows.map((row) => row.productId).filter(Boolean))]
  const products = productIds.length === 0
    ? []
    : await tx.product.findMany({ where: { id: { in: productIds } }, select: { id: true, sku: true } })
  const plan = planReturnExpectationLines(params.rows, new Map(products.map((product) => [product.id, product.sku])))
  if (plan.lines.length === 0 && !existing) return { outcome: 'none', expectationId: null }

  // Every line must belong to THIS refund. The foreign key only proves the refund line exists somewhere.
  const refundLineIds = [...new Set(plan.lines.map((line) => line.refundLineId))]
  if (refundLineIds.length > 0) {
    const ownLines = await tx.salesOrderRefundLine.findMany({
      where: { refundId: params.refundId, id: { in: refundLineIds } },
      select: { id: true },
    })
    if (ownLines.length !== refundLineIds.length) throw new ReturnExpectationError('refund_line_not_on_refund')
  }

  const lineData = (line: (typeof plan.lines)[number]) => ({
    qty: line.qty.toFixed(6),
    costSnapshot: line.costSnapshot as unknown as Prisma.InputJsonValue,
    transitValueBase: line.transitValueBase.toFixed(6),
  })
  const link = {
    transitJournalKey: params.transit?.journalKey ?? null,
    transitDebitBase: transitDebit ? transitDebit.toFixed(6) : null,
  }

  let expectationId: string
  let outcome: 'created' | 'valued'
  if (!existing) {
    const created = await tx.returnExpectation.create({
      data: {
        reference: `${RETURN_EXPECTATION_REFERENCE_PREFIX}${params.creditNoteNumber ?? params.refundId}`,
        orderId: params.orderId,
        refundId: params.refundId,
        expectedWarehouseId: params.expectedWarehouseId ?? null,
        ...link,
        valuedAt: valued ? new Date() : null,
        lines: {
          create: plan.lines.map((line) => ({
            refundLineId: line.refundLineId,
            productId: line.productId,
            sku: line.sku,
            ...lineData(line),
          })),
        },
      },
      select: { id: true },
    })
    expectationId = created.id
    outcome = 'created'
  } else {
    // Valuing an unvalued document. Nothing can have been received or written off against it (both refuse an
    // unvalued document), so its lines may be re-stated to the staged rows; a line carrying any accounted quantity
    // is a corrupt state and is refused rather than rewritten.
    if (existing.lines.some((line) => compareDecimal(line.qtyReceived, 0) !== 0 || compareDecimal(line.qtyWrittenOff, 0) !== 0)) {
      throw new ReturnExpectationError('unvalued_document_has_accounted_quantity')
    }
    const planKey = (line: { refundLineId: string; productId: string }) => `${line.refundLineId}\u0000${line.productId}`
    const have = new Map(existing.lines.map((line) => [planKey(line), line.id]))
    const wanted = new Set(plan.lines.map(planKey))
    for (const line of plan.lines) {
      const id = have.get(planKey(line))
      if (id) await tx.returnExpectationLine.update({ where: { id }, data: lineData(line) })
      else await tx.returnExpectationLine.create({ data: { expectationId: existing.id, refundLineId: line.refundLineId, productId: line.productId, sku: line.sku, ...lineData(line) } })
    }
    // Staging is authoritative where it has rows; with none, the refund transaction's lines stand.
    if (plan.lines.length > 0) {
      const stale = existing.lines.filter((line) => !wanted.has(planKey(line))).map((line) => line.id)
      if (stale.length > 0) await tx.returnExpectationLine.deleteMany({ where: { id: { in: stale } } })
    }
    await tx.returnExpectation.update({ where: { id: existing.id }, data: { ...link, valuedAt: new Date() } })
    expectationId = existing.id
    outcome = 'valued'
  }

  // The document's value and the journal's debit must be the same number. They are computed from the same rows, so
  // a difference means a row was dropped between the two; it is recorded for an operator, never silently absorbed.
  // Closed code and counts only: no amounts, ids or SKUs in the text.
  if (valued && transitDebit && compareDecimal(plan.totalValueBase, transitDebit) !== 0) {
    await tx.activityLog.create({
      data: {
        entityType: 'SALES_ORDER',
        entityId: params.orderId,
        action: 'return_expectation_value_mismatch',
        tag: 'accounting',
        level: 'WARNING',
        description: 'A return expectation was created whose value differs from its Stock in Transit debit.',
        metadata: { lines: plan.lines.length, unpricedEntries: plan.unpricedEntryCount },
      },
    })
  }
  return { outcome, expectationId }
}

/**
 * An existing document keeps its lines (first write wins), but its ledger link is repaired in one direction only:
 * a document that recorded no journal may learn the journal that was staged for it later. A recorded link is never
 * changed, and a different one is refused.
 */
async function reconcileTransitLink(
  tx: Prisma.TransactionClient,
  existing: { id: string; transitJournalKey: string | null; transitDebitBase: Prisma.Decimal | null },
  transit: ReturnExpectationTransitLink | null,
  transitDebit: ReturnType<typeof toDecimal> | null,
): Promise<void> {
  if (!transit || !transitDebit) return
  if (existing.transitJournalKey == null) {
    // Conditional on the link still being empty: two callers cannot both write it.
    await tx.returnExpectation.updateMany({
      where: { id: existing.id, transitJournalKey: null },
      data: { transitJournalKey: transit.journalKey, transitDebitBase: transitDebit.toFixed(6) },
    })
    return
  }
  const sameKey = existing.transitJournalKey === transit.journalKey
  const sameAmount = existing.transitDebitBase != null && compareDecimal(existing.transitDebitBase, transitDebit) === 0
  if (!sameKey || !sameAmount) throw new ReturnExpectationError('transit_link_conflict')
}
