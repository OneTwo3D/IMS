/**
 * SETTLING A POSTED SALES CREDIT NOTE IN XERO (o3d-hqvrp.39), behind `xero_credit_note_allocation_enabled` (default off).
 *
 * THE GAP. A sales credit note (ACCRECCREDIT) was posted and left open: never applied to the invoice it credits, and never paid out when the
 * customer was refunded in cash, so the receivable and the bank both stayed wrong in Xero and the realised FX on a foreign refund was never booked.
 *
 * THE TWO SETTLEMENTS, TOLD APART BY WHAT IMS HOLDS (decided under the claim, never at the enqueue):
 *
 *   ALLOCATE        the invoice has no receipt behind it: no `Payment`, no INVOICE_PAYMENT registration (live or posted), no `paidAt`. The credit note
 *                   reduces what the customer still owes, so it is applied to the invoice (Xero Allocations API).
 *   REFUND_PAYMENT  the invoice was paid (any receipt evidence). The credit note is NOT applied to the invoice - that would leave the paid invoice
 *                   over-credited and the receipt unmatched - it is PAID OUT: a Xero refund payment against the credit note, from the bank or clearing
 *                   account the original receipt's payment method maps to, carrying IMS's settlement rate as the payment's CurrencyRate so Xero books the
 *                   realised FX (exactly what a receipt does, lib/connectors/xero/sync-processor.ts xeroPaymentCurrencyRate).
 *
 * THE CASH EVIDENCE. Cash is counted as having left the bank ONLY when IMS holds evidence of it: an operator-recorded `Payment` whose `refundId` names the refund,
 * or a WooCommerce refund the store says went back THROUGH THE GATEWAY (`refunded_payment` true, stored on the refund as `refundedViaGateway`). A WooCommerce refund made
 * "manually" (a store-credit coupon, a payment outside the gateway: `refundedViaGateway` false) moved no money out of the account, so NO bank refund is posted; and one
 * written before that flag was kept (NULL) fails closed the same way. Neither is allocated to the paid invoice either (that would over-credit a paid invoice and leave the
 * receipt unmatched): the credit note is left open in Xero as the customer's credit, and the operator is told (a WARNING, once per refund) to apply it or record the
 * refund payment, after which the sweep raises the settlement.
 *
 * EVERY REFUND PAYMENT IS CAPPED at min(the credit left on the note in Xero, the receipts IMS has recorded for the order held to the invoice's AmountPaid in Xero, less the
 * cash paid out, in flight or possibly landed against its other refunds: `refundPaymentCap`, re-read under an order-scoped lock before the call). A 10 receipt with a 50 refund pays out at most 10. A refund of a PART-PAID invoice that is capped leaves credit on the note and an amount due on the invoice;
 * the row logs both figures in a WARNING and the operator applies the credit in Xero (IMS does not split one credit note across a payment and an allocation).
 *
 * Pure planning lives here (`planCreditNoteSettlement`) beside the one DB reader of its facts (`readCreditNoteSettlementFacts`), so the enqueue, the sweep and
 * the processor ask ONE function and cannot disagree about which settlement a refund owes.
 */
import type { Prisma } from '@/app/generated/prisma/client'
import { toDecimal, addMoney, type Decimal } from '@/lib/domain/math/decimal'
import { MAY_HAVE_REACHED_LEDGER_WHERE, PROVEN_LEDGER_FACT_WHERE } from '@/lib/domain/accounting/ledger-standing'

export const CREDIT_NOTE_ALLOCATION_SETTING_KEY = 'xero_credit_note_allocation_enabled'
export const CREDIT_NOTE_ALLOCATION_CONNECTOR = 'xero'

export type CreditNoteSettlementOperation = 'ALLOCATE' | 'REFUND_PAYMENT'

/** The reader the flag, the enqueue, the sweep and the processor share. ON only for the exact string `true`, like every system switch. */
export async function isCreditNoteAllocationEnabled(
  client: Pick<Prisma.TransactionClient, 'setting'>,
): Promise<boolean> {
  const row = await client.setting.findUnique({ where: { key: CREDIT_NOTE_ALLOCATION_SETTING_KEY }, select: { value: true } })
  return row?.value === 'true'
}

export type CreditNoteSettlementFacts = {
  refund: {
    id: string
    orderId: string
    deleted: boolean
    creditNoteId: string | null
    creditNoteConnector: string | null
    /** A refund the shop raised (and its gateway paid back): there is no Payment row to find. */
    shopRefund: boolean
    createdAt: Date
    /** o3d-k26m.17: issued as store credit (SalesOrderRefund.storeCreditRefund). Its credit note is never settled: the liability true-up nets it off 813. Absent = false. */
    storeCreditRefund?: boolean
    /** o3d-k26m.17: what the storefront refund paid out when its credit note credits more (the EAS fee gap); a gateway refund payment is held to it. Absent / null = no gap. */
    storefrontAmountForeign?: Decimal | null
  }
  order: {
    id: string
    currency: string
    invoiceId: string | null
    invoiceConnector: string | null
    paidAt: Date | null
    /** The booked rate (1 base = X order currency): the rate the credit note itself posted at. */
    fxRateToBase: Decimal
    paymentMethod: string | null
  }
  /** A SYNCED CREDIT_NOTE row names this exact credit note id. */
  creditNotePosted: boolean
  /** A SYNCED SALES_INVOICE row names this exact invoice id. */
  invoicePosted: boolean
  receiptCount: number
  receiptTotal: Decimal
  /** INVOICE_PAYMENT registrations for the order in a live or posted status. */
  invoicePaymentRows: number
  recordedRefundCash: Decimal
  refundPaymentMethod: string | null
  refundPaymentPaidAt: Date | null
  originalReceiptMethod: string | null
  /** WooCommerce `refunded_payment` as stored: true = through the gateway, false = refunded manually, null = unknown. */
  refundedViaGateway: boolean | null
  /** Cash already paid out, in flight or possibly landed against the order's OTHER refunds (recorded refund payments, or settlement rows posted / PROCESSING / attempted, whichever is larger per refund). */
  priorCashOut: Decimal
  /** ANOTHER CREDIT_NOTE_ALLOCATION row for this refund is SYNCED, or carries post evidence. */
  siblingSettled: boolean
}

export type CreditNoteSettlementPlan =
  | { kind: 'ALLOCATE' }
  | { kind: 'REFUND_PAYMENT'; cashEvidence: 'RECORDED' | 'GATEWAY'; recordedAmount: Decimal | null; /** The most that may be paid out: receipts recorded less cash already out. */ cap: Decimal }
  | { kind: 'NOT_NOW'; reason: CreditNoteNotNowReason; message: string }

export type CreditNoteNotNowReason =
  | 'REFUND_DELETED'
  | 'CREDIT_NOTE_NOT_POSTED'
  | 'INVOICE_NOT_POSTED'
  | 'DOCUMENT_NOT_XEROS'
  | 'ALREADY_SETTLED'
  | 'CASH_REFUND_NOT_RECORDED'
  | 'REFUND_NOT_PAID_BY_GATEWAY'
  | 'REFUND_CASH_UNKNOWN'
  | 'NO_RECEIPT_CAPACITY'
  | 'STORE_CREDIT_REFUND'

/** The reasons that need an OPERATOR (the sweep says so once); the others resolve themselves when IMS's reading changes. */
export const OPERATOR_ATTENTION_REASONS: ReadonlySet<CreditNoteNotNowReason> = new Set(['REFUND_NOT_PAID_BY_GATEWAY', 'REFUND_CASH_UNKNOWN', 'NO_RECEIPT_CAPACITY'])

/** Whether the order shows ANY receipt: a Payment, a registration of one, or the paid flag. One definition, used by the plan only. */
export function invoiceHasReceiptEvidence(facts: Pick<CreditNoteSettlementFacts, 'receiptCount' | 'receiptTotal' | 'invoicePaymentRows'> & { order: Pick<CreditNoteSettlementFacts['order'], 'paidAt'> }): boolean {
  return facts.order.paidAt !== null || facts.receiptCount > 0 || facts.receiptTotal.gt(0) || facts.invoicePaymentRows > 0
}

/**
 * THE MOST A REFUND PAYMENT MAY PAY OUT (o3d-0olzx): the receipts IMS recorded, held to what XERO says the invoice has received (AmountPaid), less the cash the
 * order's other refunds paid out or may have. Xero's figure is the cap's second witness: a receipt IMS recorded but Xero never booked (a PENDING, failed or
 * shadowed INVOICE_PAYMENT) makes AmountPaid smaller, and the bank refund is held to what Xero actually holds. `xeroAmountPaid` null = unreadable: the cap
 * is then ZERO (refuse), never the IMS-only figure.
 *
 * KNOWN LIMIT, stated rather than hidden: AmountPaid also counts credit applied to the invoice and does not fall when a credit note is paid out in Xero, so an
 * operator's manual Xero refund of a credit note IMS does not know about stays invisible to this figure.
 */
export function refundPaymentCap(facts: Pick<CreditNoteSettlementFacts, 'receiptTotal' | 'priorCashOut'>, xeroAmountPaid: number | null): Decimal {
  if (xeroAmountPaid === null || !Number.isFinite(xeroAmountPaid)) return toDecimal(0)
  const paid = toDecimal(xeroAmountPaid)
  const received = paid.lt(facts.receiptTotal) ? paid : facts.receiptTotal
  return received.minus(facts.priorCashOut)
}

export function planCreditNoteSettlement(facts: CreditNoteSettlementFacts): CreditNoteSettlementPlan {
  const notNow = (reason: CreditNoteNotNowReason, message: string): CreditNoteSettlementPlan => ({ kind: 'NOT_NOW', reason, message })
  if (facts.refund.deleted) return notNow('REFUND_DELETED', 'the refund was deleted in IMS, so its credit note is being voided, not settled')
  if (facts.siblingSettled) return notNow('ALREADY_SETTLED', 'another settlement row for this refund has already posted')
  // o3d-k26m.17 (rule 6): a store-credit refund's credit note stays UNALLOCATED and is never paid out. The credit is owed to the customer, and the liability
  // true-up nets exactly those open credit notes off 813 by order. Allocating it to an invoice that merely LOOKS unpaid (a card receipt reconciled from the
  // bank feed later) closed the invoice against the credit and counted it twice (172934, 173814). Nothing for an operator to do, so not an attention reason.
  if (facts.refund.storeCreditRefund === true) return notNow('STORE_CREDIT_REFUND', 'the refund was issued as store credit, so its credit note stays open in Xero (the liability true-up nets it off 813); it is neither allocated nor paid out')
  if (!facts.refund.creditNoteId || !facts.creditNotePosted) {
    return notNow('CREDIT_NOTE_NOT_POSTED', 'the credit note is not posted to Xero yet')
  }
  if (!facts.order.invoiceId || !facts.invoicePosted) {
    return notNow('INVOICE_NOT_POSTED', 'the invoice is not posted to Xero yet')
  }
  if (facts.refund.creditNoteConnector !== CREDIT_NOTE_ALLOCATION_CONNECTOR || facts.order.invoiceConnector !== CREDIT_NOTE_ALLOCATION_CONNECTOR) {
    return notNow('DOCUMENT_NOT_XEROS', 'the credit note and the invoice are not both recorded as Xero documents, so a Xero allocation or payment may not carry their ids')
  }
  if (!invoiceHasReceiptEvidence(facts)) return { kind: 'ALLOCATE' }
  const cap = facts.receiptTotal.minus(facts.priorCashOut)
  const needsCapacity = (): CreditNoteSettlementPlan | null => (cap.gt(0) ? null : notNow('NO_RECEIPT_CAPACITY', 'IMS has no receipt recorded for this order that is not already refunded, so there is nothing a refund payment could return'))
  if (facts.recordedRefundCash.gt(0)) return needsCapacity() ?? { kind: 'REFUND_PAYMENT', cashEvidence: 'RECORDED', recordedAmount: facts.recordedRefundCash, cap }
  if (facts.refund.shopRefund) {
    // o3d-k26m.17 (rule 1): the EAS fee gap. The credit note credits the fee as well, but the gateway paid back only the storefront amount, so the payment
    // is held to it; the fee's own repayment is applied to the credit note by hand.
    if (facts.refundedViaGateway === true) return needsCapacity() ?? { kind: 'REFUND_PAYMENT', cashEvidence: 'GATEWAY', recordedAmount: facts.refund.storefrontAmountForeign ?? null, cap }
    if (facts.refundedViaGateway === false) return notNow('REFUND_NOT_PAID_BY_GATEWAY', 'WooCommerce records this refund as made manually (a store-credit coupon or a payment outside the gateway), so no money left the bank account and no bank refund is posted; the credit note stays open in Xero as the customer\'s credit')
    return notNow('REFUND_CASH_UNKNOWN', 'this refund was recorded before IMS kept whether WooCommerce paid it back through the gateway, so IMS cannot tell whether cash left the bank and posts no bank refund')
  }
  return notNow('CASH_REFUND_NOT_RECORDED', 'the invoice was paid and no refund payment is recorded for this refund, so nothing says cash left the bank')
}

/** The payment method the refund goes out under: the one the operator recorded on the refund payment, else the original receipt's, else the order's own. */
export function refundPaymentMethodOf(facts: Pick<CreditNoteSettlementFacts, 'refundPaymentMethod' | 'originalReceiptMethod'> & { order: Pick<CreditNoteSettlementFacts['order'], 'paymentMethod'> }): string | null {
  // The ORIGINAL receipt first: the refund returns the money by the route it came in on, and that is the account the payment map was set up for.
  const candidates = [facts.originalReceiptMethod, facts.refundPaymentMethod, facts.order.paymentMethod]
  for (const method of candidates) {
    if (typeof method === 'string' && method.trim() !== '') return method.trim()
  }
  return null
}

/**
 * A PROCESSING settlement row of ANOTHER refund counts toward the order's cash-out when it is the OLDER of the two (createdAt, then id). Once a row's call has begun it
 * carries `remoteAttemptedAt` and counts on that alone; this is the arm for a row that is claimed and pinned but not yet at its call. Counting every such row would let two
 * refunds that are PROCESSING together each see the other's pinned amount and both refuse, over and over; ordering them makes exactly one (the older) proceed while the
 * younger is held to what is left. With no row of its own (the sweep's plan) every PROCESSING row counts: the plan only ever gets more cautious.
 */
function inFlightBefore(self: { id: string; createdAt: Date } | null): Prisma.AccountingSyncLogWhereInput {
  if (!self) return { status: 'PROCESSING' }
  return { status: 'PROCESSING', OR: [{ createdAt: { lt: self.createdAt } }, { createdAt: self.createdAt, id: { lt: self.id } }] }
}

/** The reader client: a transaction (the processor, under the order lock) or the plain client (the sweep). */
export type CreditNoteSettlementReader = Pick<
  Prisma.TransactionClient,
  'salesOrderRefund' | 'salesOrder' | 'payment' | 'accountingSyncLog'
>

/**
 * Every fact the plan reads, in one pass. THE PROCESSOR CALLS THIS INSIDE THE CLAIM'S TRANSACTION, UNDER THE ORDER LOCK (`lockSalesOrder`), so the receipt
 * evidence and the eligibility are one reading rather than a check followed, later, by an act on a different reading.
 *
 * `entryId` is the row being decided: it is excluded from the sibling test (a row is not its own sibling).
 */
export async function readCreditNoteSettlementFacts(
  client: CreditNoteSettlementReader,
  refundId: string,
  entryId: string | null,
): Promise<CreditNoteSettlementFacts | null> {
  const refund = await client.salesOrderRefund.findUnique({
    where: { id: refundId },
    select: {
      id: true, orderId: true, deletedAt: true, accountingCreditNoteId: true, accountingCreditNoteConnector: true,
      externalRefundId: true, refundedViaGateway: true, createdAt: true, storeCreditRefund: true, storefrontAmountForeign: true,
    },
  })
  if (!refund) return null
  const order = await client.salesOrder.findUnique({
    where: { id: refund.orderId },
    select: {
      id: true, currency: true, accountingInvoiceId: true, accountingInvoiceConnector: true, paidAt: true,
      fxRateToBase: true, paymentMethod: true,
    },
  })
  if (!order) return null

  const self = entryId ? await client.accountingSyncLog.findUnique({ where: { id: entryId }, select: { id: true, createdAt: true } }) : null
  const [payments, invoicePaymentRows, creditNoteRows, invoiceRows, siblings, postedSettlements] = await Promise.all([
    client.payment.findMany({
      where: { orderId: order.id },
      select: { refundId: true, amount: true, currency: true, method: true, paidAt: true },
      orderBy: { paidAt: 'asc' },
    }),
    client.accountingSyncLog.count({
      where: {
        connector: CREDIT_NOTE_ALLOCATION_CONNECTOR, type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: order.id,
        // Any registration that is live work or may have reached the ledger: a receipt IMS has told the ledger about (or may have) is a receipt.
        AND: [MAY_HAVE_REACHED_LEDGER_WHERE],
      },
    }),
    refund.accountingCreditNoteId
      ? client.accountingSyncLog.count({
          where: {
            connector: CREDIT_NOTE_ALLOCATION_CONNECTOR, type: 'CREDIT_NOTE', referenceType: 'SalesOrderRefund', referenceId: refund.id,
            externalTransactionId: refund.accountingCreditNoteId,
            // POSTED means the CONNECTOR answered with this id (a ledger fact), never an operator's typed one.
            AND: [PROVEN_LEDGER_FACT_WHERE],
          },
        })
      : Promise.resolve(0),
    order.accountingInvoiceId
      ? client.accountingSyncLog.count({
          where: {
            connector: CREDIT_NOTE_ALLOCATION_CONNECTOR, type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: order.id,
            externalTransactionId: order.accountingInvoiceId,
            AND: [PROVEN_LEDGER_FACT_WHERE],
          },
        })
      : Promise.resolve(0),
    client.accountingSyncLog.findMany({
      where: {
        connector: CREDIT_NOTE_ALLOCATION_CONNECTOR, type: 'CREDIT_NOTE_ALLOCATION', referenceType: 'SalesOrderRefund', referenceId: refund.id,
        ...(entryId ? { id: { not: entryId } } : {}),
        // Another settlement of this refund that may be in the ledger: posted, or attempted (a lost response may have landed). A twin merely QUEUED is not one,
        // or two queued rows would each retire the other.
        AND: [MAY_HAVE_REACHED_LEDGER_WHERE, { OR: [{ remoteAttemptedAt: { not: null } }, PROVEN_LEDGER_FACT_WHERE] }],
      },
      select: { id: true },
      take: 1,
    }),
    // The refund payments this order's OTHER refunds posted OR MAY HAVE POSTED (their pinned amounts), for the cap (o3d-qrm47). Cash that is out, cash that is
    // in flight (PROCESSING: the call may be leaving right now) and cash that may have landed (an attempted row, whatever its status now: a lost response) all
    // count. A row that never attempted a call and is merely queued or failed pre-call holds no cash and does not.
    client.accountingSyncLog.findMany({
      where: {
        connector: CREDIT_NOTE_ALLOCATION_CONNECTOR, type: 'CREDIT_NOTE_ALLOCATION', referenceType: 'SalesOrderRefund', referenceId: { not: refund.id },
        payload: { path: ['orderId'], equals: order.id },
        AND: [MAY_HAVE_REACHED_LEDGER_WHERE, { OR: [PROVEN_LEDGER_FACT_WHERE, { remoteAttemptedAt: { not: null } }, inFlightBefore(self)] }],
      },
      select: { referenceId: true, payload: true },
    }),
  ])

  const receipts = payments.filter((p) => p.refundId === null && p.currency === order.currency)
  const refundPayments = payments.filter((p) => p.refundId === refund.id && p.currency === order.currency)
  const abs = (value: Decimal) => (value.lt(0) ? value.neg() : value)
  // Per OTHER refund: the larger of what an operator recorded and what a settlement row posted, so one payment is never counted twice.
  const outByRefund = new Map<string, Decimal>()
  for (const p of payments) {
    if (p.refundId === null || p.refundId === refund.id || p.currency !== order.currency) continue
    outByRefund.set(p.refundId, addMoney(outByRefund.get(p.refundId) ?? toDecimal(0), abs(toDecimal(p.amount))))
  }
  for (const row of postedSettlements) {
    const body = row.payload as { operation?: unknown; amount?: unknown } | null
    if (!body || body.operation !== 'REFUND_PAYMENT' || (typeof body.amount !== 'number' && typeof body.amount !== 'string')) continue
    const posted = toDecimal(body.amount)
    const recorded = outByRefund.get(row.referenceId) ?? toDecimal(0)
    outByRefund.set(row.referenceId, posted.gt(recorded) ? posted : recorded)
  }
  const priorCashOut = [...outByRefund.values()].reduce<Decimal>((sum, v) => addMoney(sum, v), toDecimal(0))
  return {
    refund: {
      id: refund.id,
      orderId: refund.orderId,
      deleted: refund.deletedAt !== null,
      creditNoteId: refund.accountingCreditNoteId,
      creditNoteConnector: refund.accountingCreditNoteConnector,
      shopRefund: refund.externalRefundId !== null,
      createdAt: refund.createdAt,
      storeCreditRefund: refund.storeCreditRefund === true,
      storefrontAmountForeign: refund.storefrontAmountForeign == null ? null : toDecimal(refund.storefrontAmountForeign),
    },
    order: {
      id: order.id,
      currency: order.currency,
      invoiceId: order.accountingInvoiceId,
      invoiceConnector: order.accountingInvoiceConnector,
      paidAt: order.paidAt,
      fxRateToBase: toDecimal(order.fxRateToBase),
      paymentMethod: order.paymentMethod,
    },
    creditNotePosted: creditNoteRows > 0,
    invoicePosted: invoiceRows > 0,
    // A receipt in another currency is still a receipt for the PAID question; only the money total is kept to the order's currency.
    receiptCount: payments.filter((p) => p.refundId === null).length,
    receiptTotal: receipts.reduce<Decimal>((sum, p) => addMoney(sum, toDecimal(p.amount)), toDecimal(0)),
    invoicePaymentRows,
    recordedRefundCash: refundPayments.reduce<Decimal>((sum, p) => addMoney(sum, abs(toDecimal(p.amount))), toDecimal(0)),
    refundPaymentMethod: refundPayments.find((p) => p.method)?.method ?? null,
    refundPaymentPaidAt: refundPayments.length > 0 ? refundPayments[refundPayments.length - 1]!.paidAt : null,
    originalReceiptMethod: payments.find((p) => p.refundId === null && p.method)?.method ?? null,
    refundedViaGateway: refund.refundedViaGateway,
    priorCashOut,
    siblingSettled: siblings.length > 0,
  }
}
