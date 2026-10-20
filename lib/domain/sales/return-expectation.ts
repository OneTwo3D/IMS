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
    | 'transit_value_not_positive') {
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
  /** 'none' when the rows named no returnable quantity: no document is created for an empty return. */
  outcome: 'created' | 'existing' | 'none'
  expectationId: string | null
}

/**
 * Create the expectation for a refund, once. Safe to call again for the same refund (the initial attempt, an
 * accounting retry, a replay): the document is keyed on the refund, the first write wins, and a second call
 * returns the existing one without touching its lines.
 *
 * A per-refund transaction lock serialises two concurrent callers, so the check for an existing document and the
 * insert cannot interleave; the unique keys behind it are what make a missed lock a loud error and not a duplicate.
 */
export async function createReturnExpectationTx(
  tx: Prisma.TransactionClient,
  params: {
    refundId: string
    orderId: string
    creditNoteNumber?: string | null
    expectedWarehouseId?: string | null
    rows: readonly ReturnExpectationRowInput[]
    transit?: ReturnExpectationTransitLink | null
  },
): Promise<CreateReturnExpectationResult> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`return_expectation:${params.refundId}`}))`

  const transitDebit = params.transit ? toDecimal(params.transit.debitBase) : null
  if (params.transit && transitDebit && compareDecimal(transitDebit, 0) <= 0) {
    throw new ReturnExpectationError('transit_value_not_positive')
  }

  const existing = await tx.returnExpectation.findUnique({
    where: { refundId: params.refundId },
    select: { id: true, transitJournalKey: true, transitDebitBase: true },
  })
  if (existing) {
    await reconcileTransitLink(tx, existing, params.transit ?? null, transitDebit)
    return { outcome: 'existing', expectationId: existing.id }
  }

  const productIds = [...new Set(params.rows.map((row) => row.productId).filter(Boolean))]
  const products = productIds.length === 0
    ? []
    : await tx.product.findMany({ where: { id: { in: productIds } }, select: { id: true, sku: true } })
  const plan = planReturnExpectationLines(params.rows, new Map(products.map((product) => [product.id, product.sku])))
  if (plan.lines.length === 0) return { outcome: 'none', expectationId: null }

  // Every line must belong to THIS refund. The foreign key only proves the refund line exists somewhere.
  const refundLineIds = [...new Set(plan.lines.map((line) => line.refundLineId))]
  const ownLines = await tx.salesOrderRefundLine.findMany({
    where: { refundId: params.refundId, id: { in: refundLineIds } },
    select: { id: true },
  })
  if (ownLines.length !== refundLineIds.length) throw new ReturnExpectationError('refund_line_not_on_refund')

  const created = await tx.returnExpectation.create({
    data: {
      reference: `${RETURN_EXPECTATION_REFERENCE_PREFIX}${params.creditNoteNumber ?? params.refundId}`,
      orderId: params.orderId,
      refundId: params.refundId,
      expectedWarehouseId: params.expectedWarehouseId ?? null,
      transitJournalKey: params.transit?.journalKey ?? null,
      transitDebitBase: transitDebit ? transitDebit.toFixed(6) : null,
      lines: {
        create: plan.lines.map((line) => ({
          refundLineId: line.refundLineId,
          productId: line.productId,
          sku: line.sku,
          qty: line.qty.toFixed(6),
          costSnapshot: line.costSnapshot as unknown as Prisma.InputJsonValue,
          transitValueBase: line.transitValueBase.toFixed(6),
        })),
      },
    },
    select: { id: true },
  })

  // The document's value and the journal's debit must be the same number. They are computed from the same rows, so
  // a difference means a row was dropped between the two; it is recorded for an operator, never silently absorbed.
  // Closed code and counts only: no amounts, ids or SKUs in the text.
  if (transitDebit && compareDecimal(plan.totalValueBase, transitDebit) !== 0) {
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
  return { outcome: 'created', expectationId: created.id }
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
