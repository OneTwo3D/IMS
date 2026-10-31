/**
 * THE REGISTRATION OBLIGATION OF A STORED RECEIPT, FOR EVERY RECEIPT SOURCE (manual `addPayment`, a WooCommerce paid transition, an imported paid order).
 *
 * `registerInvoicePaymentWithLedger` decides and writes a receipt's INVOICE_PAYMENT row in its own transaction and SWALLOWS a failure (it logs `invoice_payment_not_queued` and returns). The
 * receipt itself is committed before that call, so on an invoice that has ALREADY posted nothing would ever retry it: the deferred re-drive runs only when the SALES_INVOICE posts. This module
 * is the durable answer, shared by every producer:
 *
 *   - `receiptObligationIsOnRecord`: the evidence that a receipt's registration is on record. (a) nothing is owed yet (no invoice posted, whose post registers the receipts then; or no
 *     connector posts INVOICE_PAYMENT), (b) an INVOICE_PAYMENT sync row for THIS receipt, in any status (a refusal is recorded as an outstanding row), or (c) a decided-refusal notice
 *     (`invoice_payment_not_registered`). The swallowed-failure case (`invoice_payment_not_queued`) is none of these.
 *   - `registerReceiptAndProveObligation`: register, then prove; a failure of either throws `ReceiptRegistrationNotRecorded` carrying the payment id (WooCommerce keeps a pending-FX row for it).
 *   - `sweepUnregisteredReceipts`: the scheduled sweep (run by the fx-rates cron every run) over every non-refund Payment on an order whose invoice has posted that has NO INVOICE_PAYMENT
 *     row and NO refusal notice. The filter is in the query, BEFORE the limit (registered receipts can never take a slot); the batch is oldest first with recently failed receipts
 *     behind; it returns at once when no connector posts INVOICE_PAYMENT; a receipt younger than 5 minutes is left to its inline registration; and an order whose CURRENT SALES_INVOICE
 *     still owes its follow-ups (`backReferenceFollowUpsPendingAt` on the current invoice's row; a marker on a superseded invoice excludes nothing) is left to that pass. Registration is idempotent per receipt and document (`invoicePaymentEnqueueKey`), so an inline call
 *     and a sweep that race register it once.
 */
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { toDecimal } from '@/lib/domain/math/decimal'
import { getSalesOrderReference } from '@/lib/sales-order-display'

export class ReceiptRegistrationNotRecorded extends Error {
  constructor(readonly orderId: string, readonly paymentId: string | null, readonly currency: string, readonly causeText?: string) {
    super(`the receipt ${paymentId ?? '(not yet known)'} of order ${orderId} is stored but its ledger registration is not on record yet; it is retried${causeText ? ` (${causeText})` : ''}`)
    this.name = 'ReceiptRegistrationNotRecorded'
  }
}

export async function receiptObligationIsOnRecord(orderId: string, paymentId: string): Promise<boolean> {
  const order = await db.salesOrder.findUnique({ where: { id: orderId }, select: { accountingInvoiceId: true, currency: true } })
  if (!order || !order.accountingInvoiceId) return true
  const { getActiveAccountingConnectorInfo, isAccountingSyncTypeEnabledFor } = await import('@/lib/accounting')
  const connector = await getActiveAccountingConnectorInfo().catch(() => null)
  if (!connector) return true
  if (!(await isAccountingSyncTypeEnabledFor(connector.id, 'INVOICE_PAYMENT').catch(() => true))) return true
  const { loadInvoicePaymentSyncRows } = await import('@/lib/domain/accounting/invoice-payment-enqueue')
  if ((await loadInvoicePaymentSyncRows(orderId, connector.id, order.currency)).some((row) => row.paymentId === paymentId)) return true
  return (await db.activityLog.count({ where: { entityType: 'SALES_ORDER', entityId: orderId, action: 'invoice_payment_not_registered', metadata: { path: ['paymentId'], equals: paymentId } } })) > 0
}

async function defaultRegistrationsAreOwed(): Promise<boolean> {
  const { getActiveAccountingConnectorInfo, isAccountingSyncTypeEnabledFor } = await import('@/lib/accounting')
  const connector = await getActiveAccountingConnectorInfo().catch(() => null)
  return connector !== null && (await isAccountingSyncTypeEnabledFor(connector.id, 'INVOICE_PAYMENT').catch(() => false))
}

/** Seams so a test can state "the registration did not reach the record" or hold a step without a live accounting connector. The last three are the WooCommerce paid transition's hooks. */
export const receiptRegistrationSeams: {
  obligationIsOnRecord: (orderId: string, paymentId: string) => Promise<boolean>
  registrationsAreOwed?: () => Promise<boolean>
  /** Runs after the sweep selected a receipt and before it registers it (a race test holds the inline call here). */
  beforeSweepRegisters?: (paymentId: string) => Promise<void>
  afterPlan?: (orderId: string) => Promise<void>
  afterReceiptCommit?: (orderId: string) => Promise<void>
  insideReceiptTransaction?: () => Promise<void>
} = { obligationIsOnRecord: receiptObligationIsOnRecord }

export type StoredReceipt = { id: string; amount: unknown; currency: string; method: string | null; reference: string | null; paidAt: Date; settlementRateToBase: unknown }

/** Register one stored receipt and prove the obligation is on record. Whatever fails, once the Payment is committed, becomes a retryable `ReceiptRegistrationNotRecorded`. */
export async function registerReceiptAndProveObligation(orderId: string, reference: string, receipt: StoredReceipt): Promise<void> {
  try {
    const { registerInvoicePaymentWithLedger } = await import('@/lib/domain/accounting/invoice-payment-enqueue')
    await registerInvoicePaymentWithLedger({
      orderId,
      orderReference: reference,
      paymentId: receipt.id,
      amount: toDecimal(receipt.amount as never),
      currency: receipt.currency,
      method: receipt.method,
      reference: receipt.reference,
      paidAt: receipt.paidAt,
      settlementRateToBase: receipt.settlementRateToBase === null || receipt.settlementRateToBase === undefined ? null : Number(receipt.settlementRateToBase),
    })
    if (!(await receiptRegistrationSeams.obligationIsOnRecord(orderId, receipt.id))) throw new ReceiptRegistrationNotRecorded(orderId, receipt.id, receipt.currency)
  } catch (error) {
    if (error instanceof ReceiptRegistrationNotRecorded) throw error
    throw new ReceiptRegistrationNotRecorded(orderId, receipt.id, receipt.currency, error instanceof Error ? error.message : String(error))
  }
}

/** A receipt younger than this is left to its inline registration. A function so the clock read is not spelt in the statement that also names the follow-up marker (that marker is never compared to a clock). */
function receiptAgeFloor(): Date {
  return new Date(Date.now() - 5 * 60_000)
}

/**
 * The orders whose CURRENT invoice still owes its SALES_INVOICE follow-ups: they are left to that pass and, being excluded in the query below, never take a slot. The marker is tested for presence only (never compared; this
 * statement holds no comparison operator on purpose, and is kept apart from the clock-reading query for the same reason). A marker row is the CURRENT invoice's in exactly these cases: it names the order's
 * `accounting_invoice_id`; or it is the order's latest SALES_INVOICE row by (createdAt, id) (a re-post whose back-reference is not written yet, or a post whose document id is not recorded yet). A row with no document id is NOT
 * current merely for being unrecorded: an older one behind a newer row is superseded. "Latest" ignores FAILED and CANCELLED rows, which never became the invoice (a later failed attempt must not demote the real pending row); when
 * EVERY row failed there is no viable row to supersede anything, so a marker row stays current. A marker left on a SUPERSEDED invoice excludes nothing, or it would hide every later receipt of the order for ever.
 */
async function ordersOwingCurrentInvoiceFollowUps(): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT DISTINCT m."referenceId" AS id FROM "accounting_sync_logs" m
    JOIN "sales_orders" o ON o.id = m."referenceId"
    WHERE m.type = 'SALES_INVOICE' AND m."referenceType" = 'SalesOrder' AND m."backReferenceFollowUpsPendingAt" IS NOT NULL
      AND (m."externalTransactionId" = o.accounting_invoice_id
           OR m.id = (SELECT n.id FROM "accounting_sync_logs" n WHERE n.type = 'SALES_INVOICE' AND n."referenceType" = 'SalesOrder' AND n."referenceId" = m."referenceId" AND n.status NOT IN ('FAILED', 'CANCELLED') ORDER BY n."createdAt" DESC, n.id DESC LIMIT 1)
           OR NOT EXISTS (SELECT 1 FROM "accounting_sync_logs" v WHERE v.type = 'SALES_INVOICE' AND v."referenceType" = 'SalesOrder' AND v."referenceId" = m."referenceId" AND v.status NOT IN ('FAILED', 'CANCELLED')))`
  return rows.map((r) => r.id)
}

/** The unresolved-receipt query. Its inputs arrive as parameters so the statement is self-contained: the filter is in the query, BEFORE the limit. */
async function selectUnresolvedReceiptIds(floor: Date, excluded: string[], take: number): Promise<Array<{ id: string }>> {
  return db.$queryRaw<Array<{ id: string }>>`
    SELECT p.id FROM "payments" p
    JOIN "sales_orders" o ON o.id = p."orderId"
    WHERE p."refundId" IS NULL AND p.amount > 0 AND p."createdAt" < ${floor} AND o.accounting_invoice_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "accounting_sync_logs" l WHERE l.type = 'INVOICE_PAYMENT' AND l."referenceType" = 'SalesOrder' AND l."referenceId" = p."orderId" AND l.payload->>'paymentId' = p.id)
      AND NOT EXISTS (SELECT 1 FROM "activity_logs" a WHERE a.action = 'invoice_payment_not_registered' AND a."entityType" = 'SALES_ORDER' AND a."entityId" = p."orderId" AND a.metadata->>'paymentId' = p.id)
      AND o.id <> ALL(${excluded}::text[])
    ORDER BY coalesce((SELECT max(f."createdAt") FROM "activity_logs" f WHERE f.action IN ('invoice_payment_not_queued', 'wc_receipt_sweep_attempt_failed', 'receipt_sweep_attempt_failed') AND f."entityType" = 'SALES_ORDER' AND f."entityId" = p."orderId" AND f.metadata->>'paymentId' = p.id), 'epoch'::timestamp) ASC, p."createdAt" ASC
    LIMIT ${take}`
}

export async function sweepUnregisteredReceipts(limit = 50): Promise<{ examined: number; registered: number; failed: number }> {
  const result = { examined: 0, registered: 0, failed: 0 }
  // Nothing is owed when no accounting connector posts payments: asked ONCE, so such receipts never fill the batch.
  if (!(await (receiptRegistrationSeams.registrationsAreOwed ?? defaultRegistrationsAreOwed)())) return result
  const take = Math.min(Math.max(limit, 1), 250)
  const candidates = await selectUnresolvedReceiptIds(receiptAgeFloor(), await ordersOwingCurrentInvoiceFollowUps(), take)
  const rows = await db.payment.findMany({
    where: { id: { in: candidates.map((c) => c.id) } },
    select: { id: true, orderId: true, amount: true, currency: true, method: true, reference: true, paidAt: true, settlementRateToBase: true, order: { select: { id: true, orderNumber: true, externalOrderNumber: true } } },
  })
  const byId = new Map(rows.map((r) => [r.id, r]))
  result.examined = candidates.length
  for (const c of candidates) {
    const r = byId.get(c.id)
    if (!r) continue
    try {
      await receiptRegistrationSeams.beforeSweepRegisters?.(r.id)
      // the up-front query is the filter; the probe is the final word for what the query cannot see (a connector moved, or an inline call that landed since)
      if (await receiptRegistrationSeams.obligationIsOnRecord(r.orderId, r.id)) continue
      await registerReceiptAndProveObligation(r.orderId, getSalesOrderReference(r.order), r)
      result.registered++
    } catch {
      result.failed++
      await logActivity({ entityType: 'SALES_ORDER', entityId: r.orderId, action: 'receipt_sweep_attempt_failed', tag: 'sync', level: 'WARNING', description: 'The scheduled sweep could not register a stored receipt; it is retried behind the others.', metadata: { paymentId: r.id } }).catch(() => undefined)
    }
  }
  return result
}
