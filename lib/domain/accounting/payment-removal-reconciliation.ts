import { db } from '@/lib/db'
import { compareDecimal, toDecimal, type Decimal, type DecimalInput } from '@/lib/domain/math/decimal'
import { shortfallAfter, type PartialRemovalMeasurement } from '@/lib/domain/accounting/partial-payment-removal'

// ---------------------------------------------------------------------------
// RECORD A MEASURED REMOVAL (o3d-cdhl) - THE ORDER'S FIGURE AND ITS HISTORY MOVE TOGETHER
// ---------------------------------------------------------------------------
//
// `SalesOrder.paymentRemovedForeign` is the order's current shortfall and `PaymentRemovalReconciliation` is the
// record of each change to it. They are written in ONE transaction, and the order write is a compare-and-set on the
// shortfall the measurement started from: a concurrent writer that moved it first makes this one a no-op, so a
// measurement is applied at most once and a recheck that meets the already-recorded figure measures zero.
//
// Nothing here posts to an accounting ledger, raises a credit note or touches revenue.

export type RecordRemovalOutcome =
  | { outcome: 'recorded'; recordId: string; shortfall: Decimal }
  | { outcome: 'raced' }
  | { outcome: 'not-applicable'; reason: 'order-not-paid' | 'document-moved' | 'order-missing' }

export async function recordPaymentRemoval(params: {
  orderId: string
  connector: string
  accountingInvoiceId: string
  /** The shortfall on the order when the measurement was taken (null/0 for none). */
  shortfallBefore: DecimalInput
  measurement: Extract<PartialRemovalMeasurement, { kind: 'REMOVED' | 'RESTORED' }>
  matchedPaymentIds: string[]
  now?: Date
}): Promise<RecordRemovalOutcome> {
  const before = params.shortfallBefore == null ? toDecimal(0) : toDecimal(params.shortfallBefore)
  const m = params.measurement
  const after = shortfallAfter(before, m.kind === 'REMOVED' ? { kind: 'REMOVED', removed: m.removed } : { kind: 'RESTORED', restored: m.restored })
  const amount = m.kind === 'REMOVED' ? m.removed : m.restored
  const now = params.now ?? new Date()

  return await db.$transaction(async (tx) => {
    const order = await tx.salesOrder.findUnique({
      where: { id: params.orderId },
      select: { paidAt: true, accountingInvoiceId: true, paymentRemovedForeign: true },
    })
    if (!order) return { outcome: 'not-applicable', reason: 'order-missing' } as const
    if (order.paidAt === null) return { outcome: 'not-applicable', reason: 'order-not-paid' } as const
    if (order.accountingInvoiceId !== params.accountingInvoiceId) return { outcome: 'not-applicable', reason: 'document-moved' } as const

    const current = order.paymentRemovedForeign == null ? toDecimal(0) : toDecimal(order.paymentRemovedForeign)
    if (compareDecimal(current, before) !== 0) return { outcome: 'raced' } as const

    const updated = await tx.salesOrder.updateMany({
      where: {
        id: params.orderId,
        paidAt: { not: null },
        accountingInvoiceId: params.accountingInvoiceId,
        // NULL and 0 are the same "nothing recorded"; a column is never written as 0, so NULL is the only spelling to match.
        paymentRemovedForeign: compareDecimal(before, 0) === 0 ? null : before.toString(),
      },
      data: {
        paymentRemovedForeign: compareDecimal(after, 0) === 0 ? null : after.toString(),
        paymentRemovedAt: compareDecimal(after, 0) === 0 ? null : now,
      },
    })
    if (updated.count !== 1) return { outcome: 'raced' } as const

    const row = await tx.paymentRemovalReconciliation.create({
      data: {
        orderId: params.orderId,
        connector: params.connector,
        accountingInvoiceId: params.accountingInvoiceId,
        kind: m.kind,
        amountForeign: amount.toString(),
        recordedPaidForeign: m.recordedPaid.toString(),
        ledgerPaidForeign: m.ledgerPaid.toString(),
        documentTotalForeign: m.documentTotal.toString(),
        shortfallBeforeForeign: before.toString(),
        shortfallAfterForeign: after.toString(),
        currency: m.currency,
        matchedPaymentIds: params.matchedPaymentIds,
        ledgerAction: m.kind === 'REMOVED' ? 'OPERATOR_DECISION' : 'NONE',
        createdAt: now,
      },
      select: { id: true },
    })
    return { outcome: 'recorded', recordId: row.id, shortfall: after } as const
  })
}
