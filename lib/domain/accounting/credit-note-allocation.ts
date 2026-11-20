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
 * THE CASH EVIDENCE. IMS records a refund's cash-out in two ways: an operator-recorded `Payment` whose `refundId` names the refund (method, amount, date),
 * or a shop refund (WooCommerce: `externalRefundId`), which the shop's gateway paid back and which IMS never records as a Payment. A manual refund of a
 * paid invoice with neither is NOT posted: nothing says cash left the bank, so the row is retired (nothing sent) and the sweep raises it again once
 * the operator records the refund payment.
 *
 * A PART-PAID INVOICE counts as paid: its credit note is refunded, never split. The unpaid remainder stays open in Xero for the operator (the decision is
 * logged with both figures); splitting one credit note across an allocation and a payment is the over-settlement shape #1039 R2 described.
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
  /** ANOTHER CREDIT_NOTE_ALLOCATION row for this refund is SYNCED, or carries post evidence. */
  siblingSettled: boolean
}

export type CreditNoteSettlementPlan =
  | { kind: 'ALLOCATE' }
  | { kind: 'REFUND_PAYMENT'; cashEvidence: 'RECORDED' | 'SHOP_REFUND'; recordedAmount: Decimal | null }
  | { kind: 'NOT_NOW'; reason: CreditNoteNotNowReason; message: string }

export type CreditNoteNotNowReason =
  | 'REFUND_DELETED'
  | 'CREDIT_NOTE_NOT_POSTED'
  | 'INVOICE_NOT_POSTED'
  | 'DOCUMENT_NOT_XEROS'
  | 'ALREADY_SETTLED'
  | 'CASH_REFUND_NOT_RECORDED'

/** Whether the order shows ANY receipt: a Payment, a registration of one, or the paid flag. One definition, used by the plan only. */
export function invoiceHasReceiptEvidence(facts: Pick<CreditNoteSettlementFacts, 'receiptCount' | 'receiptTotal' | 'invoicePaymentRows'> & { order: Pick<CreditNoteSettlementFacts['order'], 'paidAt'> }): boolean {
  return facts.order.paidAt !== null || facts.receiptCount > 0 || facts.receiptTotal.gt(0) || facts.invoicePaymentRows > 0
}

export function planCreditNoteSettlement(facts: CreditNoteSettlementFacts): CreditNoteSettlementPlan {
  const notNow = (reason: CreditNoteNotNowReason, message: string): CreditNoteSettlementPlan => ({ kind: 'NOT_NOW', reason, message })
  if (facts.refund.deleted) return notNow('REFUND_DELETED', 'the refund was deleted in IMS, so its credit note is being voided, not settled')
  if (facts.siblingSettled) return notNow('ALREADY_SETTLED', 'another settlement row for this refund has already posted')
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
  if (facts.recordedRefundCash.gt(0)) return { kind: 'REFUND_PAYMENT', cashEvidence: 'RECORDED', recordedAmount: facts.recordedRefundCash }
  if (facts.refund.shopRefund) return { kind: 'REFUND_PAYMENT', cashEvidence: 'SHOP_REFUND', recordedAmount: null }
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
      externalRefundId: true, createdAt: true,
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

  const [payments, invoicePaymentRows, creditNoteRows, invoiceRows, siblings] = await Promise.all([
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
  ])

  const receipts = payments.filter((p) => p.refundId === null && p.currency === order.currency)
  const refundPayments = payments.filter((p) => p.refundId === refund.id && p.currency === order.currency)
  const abs = (value: Decimal) => (value.lt(0) ? value.neg() : value)
  return {
    refund: {
      id: refund.id,
      orderId: refund.orderId,
      deleted: refund.deletedAt !== null,
      creditNoteId: refund.accountingCreditNoteId,
      creditNoteConnector: refund.accountingCreditNoteConnector,
      shopRefund: refund.externalRefundId !== null,
      createdAt: refund.createdAt,
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
    siblingSettled: siblings.length > 0,
  }
}
