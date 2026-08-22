/**
 * Queueing a sales receipt to the ledger (o3d-lgo.15, o3d-ekn8).
 *
 * Lifted out of app/actions/sales.ts unchanged apart from the two edits noted below, because it now has
 * a SECOND caller: the Xero connector re-drives it once a SALES_INVOICE posts, for receipts that were
 * recorded while the invoice did not yet exist (o3d-ekn8). A 'use server' file cannot provide that —
 * every export there becomes a callable server action, and "post money for this order id" is not an
 * endpoint worth exposing — so the shared logic lives here and app/actions/sales.ts imports it.
 */

import { db } from '@/lib/db'
import type { Prisma } from '@/app/generated/prisma/client'
import { logActivity } from '@/lib/activity-log'
import {
  getActiveAccountingConnectorInfo,
  getPaymentAccountMap,
  isAccountingSyncTypeEnabled,
  lookupPaymentAccount,
  queueAccountingSyncTx,
} from '@/lib/accounting'
import { lockSalesOrder } from '@/lib/domain/sales/allocation-service'
import { getSalesOrderReference } from '@/lib/sales-order-display'
import {
  decideInvoicePaymentRegistration,
  selectReceiptsAwaitingRegistration,
  unresolvedInvoicePaymentAttempts,
  type InvoicePaymentRegistrationDecision,
} from '@/lib/domain/accounting/invoice-payment-registration'
import { ledgerSalesInvoiceTotalForeign, type PaymentSyncRow } from '@/lib/domain/accounting/settlement-status'
import { lockFollowUpScope } from '@/lib/domain/accounting/followup-scope-lock'
import { attemptCouldHaveReachedTheLedger, effectiveTokenFor } from '@/lib/domain/accounting/followup-retry-guard'
import { pinnedAttemptDate, settlementMarkerFor } from '@/lib/domain/accounting/ledger-settlement-evidence'
import { probeLedgerSettlement } from '@/lib/connectors/accounting-settlement-probe'

const STOCK_TX_OPTIONS = { maxWait: 5000, timeout: 20000 }

/**
 * Every INVOICE_PAYMENT sync row for one order (o3d-lgo.15) — the ledger's own account of what it was
 * told about this order's receipts. Scoped to the ACTIVE connector: rows left by a connector that is no
 * longer in use describe a ledger nobody is reconciling against, and judging today's settlement by them
 * would report a discrepancy against a system that has been switched off.
 */
export type InvoicePaymentSyncRow = PaymentSyncRow & {
  paymentId: string | null
  /** The ledger document this row settles — null on rows queued before the payload carried it. */
  accountingInvoiceId: string | null
  /** The mark this attempt would have written into the ledger (o3d-0m56). */
  settlementMarker: string | null
  /** The date that attempt sent, so a settlement in the ledger can be matched to it (o3d-0m56). */
  paymentDate: string | null
  /** False when the stored body was too incomplete for the connector to have made the call. */
  couldHaveReachedLedger: boolean
}

export async function loadInvoicePaymentSyncRows(
  orderId: string,
  connector: string | null,
  /**
   * Read through the CALLER's transaction when one is supplied, so the capacity re-check below sees
   * rows a concurrent receipt has already written and is serialised by the order lock that
   * transaction holds. Reading outside it would re-open the check-then-act race it exists to close.
   */
  client: Pick<Prisma.TransactionClient, 'accountingSyncLog'> = db,
): Promise<InvoicePaymentSyncRow[]> {
  if (!connector) return []
  const rows = await client.accountingSyncLog.findMany({
    where: { connector, type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: orderId },
    select: {
      status: true, externalTransactionId: true, errorMessage: true, retryCount: true, payload: true,
      // o3d-0m56: the row id, because the token an attempt POSTED under is derived from it for rows
      // whose payload pinned none. Without it `effectiveTokenFor` cannot name the mark to look for.
      id: true,
      // o3d-nf9i r3: HOW the row reached its status. Without it an operator-asserted SYNCED row is
      // indistinguishable from one Xero confirmed, and settlementStatus would compare two local
      // numbers nothing verified and call the invoice SETTLED. `settlementBasis` is OPTIONAL on
      // PaymentSyncRow, so dropping it in this move would have been a silent regression rather than
      // a type error.
      settlementBasis: true,
    },
    orderBy: { createdAt: 'desc' },
  })
  return rows.map((r) => {
    const payload = (r.payload && typeof r.payload === 'object' ? r.payload : {}) as Record<string, unknown>
    return {
      status: r.status,
      externalTransactionId: r.externalTransactionId,
      errorMessage: r.errorMessage,
      retryCount: r.retryCount,
      // The amount actually SENT, so a part payment is not mistaken for full settlement.
      amount: typeof payload.amount === 'number' ? payload.amount : null,
      settlementBasis: r.settlementBasis,
      paymentId: payloadPaymentId(r.payload),
      // o3d-hbgo: WHICH ledger invoice this settled. A row against a document the order no longer has
      // (deleted and re-posted) must not be read as bearing on the replacement's settlement.
      accountingInvoiceId: typeof payload.accountingInvoiceId === 'string' ? payload.accountingInvoiceId : null,
      // o3d-0m56. The three facts the unresolved-attempt fence weighs, all derived through the SAME
      // helpers the retry guard and the processors use rather than re-spelt here — copies of these
      // rules are what let a probe go looking for a settlement on a day no post would ever create.
      //
      // ...the date it sent, because amount alone cannot tell one receipt from another:
      paymentDate: pinnedAttemptDate('INVOICE_PAYMENT', r.payload),
      // ...whether the stored body was ever complete enough to have been sent at all:
      couldHaveReachedLedger: attemptCouldHaveReachedTheLedger('INVOICE_PAYMENT', r.payload),
      // ...and the mark it would have written, which identifies the attempt even if its amount or
      // date has since been corrected in the ledger.
      settlementMarker: connector === 'xero' || connector === 'quickbooks'
        ? settlementMarkerFor(effectiveTokenFor(connector, { id: r.id, payload: r.payload }))
        : null,
    }
  })
}

/** The local Payment row an INVOICE_PAYMENT was queued for, when the payload records one. */
export function payloadPaymentId(payload: unknown): string | null {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
  return typeof p.paymentId === 'string' ? p.paymentId : null
}

/**
 * Register a manually-recorded sales receipt against the ledger invoice (o3d-lgo.15).
 *
 * An IMPORTED paid order registers its payment through the SALES_INVOICE follow-up (`_registerPayment`).
 * A receipt entered in IMS had no such path: the Payment row was created, the order went green, and the
 * ledger was never told — so it went on showing the invoice fully outstanding, for ever. This closes
 * that, on the same principle as markBillPaid: an operator recording a payment against a posted document
 * is an instruction to settle it in the ledger too.
 *
 * GUARDED, because the ledger may already know. Every refusal below leaves the payment recorded and the
 * settlement verdict visibly unsettled, which is the safe end: an operator can register it by hand, and
 * a second payment in a ledger nobody is watching cannot be undone by looking at IMS.
 *
 * Never throws — failing to register must not fail the receipt the operator just recorded.
 */
export async function registerInvoicePaymentWithLedger(params: {
  orderId: string
  orderReference: string
  paymentId: string
  amount: number
  currency: string
  method: string | null
  reference: string | null
  paidAt: Date
}): Promise<void> {
  const warn = async (action: string, description: string, metadata: Record<string, unknown>) => {
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: params.orderId,
      action,
      tag: 'accounting',
      level: 'WARNING',
      description,
      metadata: { orderNumber: params.orderReference, paymentId: params.paymentId, ...metadata },
    }).catch(() => { /* logging must never block the receipt */ })
  }

  try {
    const [paymentSyncEnabled, so, connector] = await Promise.all([
      // Not merely "is the connector on": if INVOICE_PAYMENT posting is off, queueAccountingSync would
      // drop this silently, so treat it as nothing being expected rather than as a failure to report.
      isAccountingSyncTypeEnabled('INVOICE_PAYMENT').catch(() => false),
      db.salesOrder.findUnique({
        where: { id: params.orderId },
        select: {
          accountingInvoiceId: true, currency: true, totalForeign: true, taxForeign: true, pricesIncludeVat: true,
          shoppingLinks: { select: { connector: true }, take: 1 },
        },
      }),
      getActiveAccountingConnectorInfo().catch(() => null),
    ])
    if (!so) return

    const existing = paymentSyncEnabled && so.accountingInvoiceId
      ? await loadInvoicePaymentSyncRows(params.orderId, connector?.id ?? null)
      : []

    // o3d-0m56: a FAILED or CANCELLED attempt does NOT prove the ledger is clear — the call may have
    // committed before its response was lost. Recording another receipt beside one queues a fresh row
    // under a NEW token, which posts a second payment without ever touching the retry guard. So when
    // there is such an attempt, ask the ledger what it holds; the decision refuses unless the answer
    // positively rules that attempt out.
    //
    // Conditional on purpose: this is a network read, and the ordinary receipt has no history to check.
    const probeConnector = connector?.id === 'xero' || connector?.id === 'quickbooks' ? connector.id : null
    const ledgerSettlements = so.accountingInvoiceId
      && probeConnector
      && unresolvedInvoicePaymentAttempts(existing, params.paymentId).length > 0
      ? await (async () => {
        const probe = await probeLedgerSettlement(probeConnector, {
          type: 'INVOICE_PAYMENT',
          payload: { accountingInvoiceId: so.accountingInvoiceId },
        })
        // A probe that could not answer stays null, which the decision reads as "refuse".
        return probe.ok ? probe.records : null
      })()
      : null

    // Hoisted so the re-check under the order lock re-runs the IDENTICAL decision with only `existing`
    // refreshed — anything else diverging between the two would make the second a different guard.
    //
    // `ledgerSettlements` is deliberately NOT re-read there: it is a network call, and holding the
    // order lock and the follow-up scope lock across one would let a slow remote block every payment
    // enqueue in the system. What changes fast is the local row set, which is what IS re-read.
    const decisionInput = {
      syncEnabled: paymentSyncEnabled,
      accountingInvoiceId: so.accountingInvoiceId,
      orderCurrency: so.currency,
      paymentCurrency: params.currency,
      paymentAmount: params.amount,
      paymentId: params.paymentId,
      bankAccountId: paymentSyncEnabled && so.accountingInvoiceId
        ? lookupPaymentAccount(await getPaymentAccountMap(), params.method ?? '', params.currency)
        : null,
      existing,
      ledgerSettlements,
      ledgerTotal: ledgerSalesInvoiceTotalForeign({
        totalForeign: Number(so.totalForeign),
        taxForeign: Number(so.taxForeign),
        pricesIncludeVat: so.pricesIncludeVat,
        // Both still passed, and both now deliberately unread — see ledgerSalesInvoiceTotalForeign:
        // since o3d-cyn an imported tax-inclusive invoice posts at gross like every other, so the
        // ledger total is the order total whatever these say.
        importedFromShop: so.shoppingLinks.length > 0,
      }),
    }
    const decision = decideInvoicePaymentRegistration(decisionInput)

    const reportRefusal = async (refused: InvoicePaymentRegistrationDecision & { register: false }) => {
      const amount = `${params.currency} ${params.amount.toFixed(2)}`
      const tail = `Register it in the accounting connector by hand if it is genuinely owed.`
      switch (refused.refusal) {
        // Nothing is expected to post at all, so there is nothing to report.
        case 'SYNC_DISABLED':
          return
        // Not a settlement fault — a payment cannot attach to an invoice the ledger has never seen, and
        // the DOCUMENT sync is what to chase. But nothing re-registers this receipt when the invoice
        // finally does post either, so say so once here rather than leave it to reconciliation.
        case 'DOCUMENT_NOT_POSTED':
          await warn('invoice_payment_not_registered',
            `Recorded ${amount} against ${params.orderReference}, but its invoice has not posted to the ` +
            `accounting connector yet, so the payment could not be registered there. Register it once the ` +
            `invoice syncs, or record it in the ledger by hand.`,
            { amount: params.amount, currency: params.currency, refusal: refused.refusal })
          return
        // addPayment rejects a currency mismatch, so this only fires if the order currency changed
        // underneath the receipt. Registering the wrong currency is worse than not registering.
        case 'CURRENCY_MISMATCH':
          await warn('invoice_payment_not_registered',
            `Recorded a ${params.currency} payment against ${params.orderReference}, which is in ` +
            `${so.currency}. The payment was NOT registered in the accounting connector — register it there by hand.`,
            { amount: params.amount, currency: params.currency, orderCurrency: so.currency, refusal: refused.refusal })
          return
        case 'NO_BANK_ACCOUNT':
          await warn('invoice_payment_not_registered',
            `Recorded ${amount} against ${params.orderReference}, but no bank account is mapped for method ` +
            `"${params.method ?? ''}" / currency "${params.currency}". Add a mapping in Settings → ` +
            `Accounting → Payment Account Mapping, then register the payment there.`,
            { amount: params.amount, currency: params.currency, method: params.method, refusal: refused.refusal })
          return
        // o3d-0m56: an earlier attempt on this order is FAILED or CANCELLED and the ledger could not be
        // shown NOT to hold its payment. The capacity arithmetic cannot see this — a failed row
        // consumes no capacity — so without this arm the receipt would look like it fits and a second
        // payment would post. `detail` says which of the two it was: the ledger was unreachable, or it
        // answered and the answer matched the earlier attempt.
        case 'UNRESOLVED_PAYMENT_ATTEMPT':
          await warn('invoice_payment_not_registered',
            `Recorded ${amount} against ${params.orderReference}, but an earlier payment attempt on this ` +
            `order did not resolve and could not be ruled out in the accounting connector ` +
            `(${refused.detail ?? 'no detail'}). Sending this one could pay the invoice twice, so it was ` +
            `not sent. Resolve the earlier attempt on the Accounting Sync page first. ${tail}`,
            {
              amount: params.amount, currency: params.currency, refusal: refused.refusal,
              detail: refused.detail, ledgerTotal: refused.ledgerTotal,
            })
          return
        // A registration is already on the invoice but IMS cannot read WHAT it was for, so the room
        // left on the invoice is unknown. Naming a figure here would be inventing one (o3d-cjt8).
        case 'LEDGER_AMOUNT_UNKNOWN':
          await warn('invoice_payment_not_registered',
            `Recorded ${amount} against ${params.orderReference}, but a payment already sent to the ` +
            `accounting connector for this invoice does not record its amount, so IMS cannot tell how ` +
            `much of the invoice is still outstanding. It was not sent. ${tail}`,
            {
              amount: params.amount, currency: params.currency, refusal: refused.refusal,
              alreadyRegistered: refused.alreadyRegistered, ledgerTotal: refused.ledgerTotal,
            })
          return
        // Since o3d-cjt8 this is a CAPACITY refusal, not a one-per-order one: part payments each
        // register, and only the receipt that would take the total past the invoice is refused. So the
        // message has to name what is already on it, not just the invoice total.
        case 'WOULD_OVERPAY':
          await warn('invoice_payment_not_registered',
            `Recorded ${amount} against ${params.orderReference}, but the invoice the accounting connector ` +
            `holds is for ${params.currency} ${(refused.ledgerTotal ?? 0).toFixed(2)}` +
            (refused.alreadyRegistered
              ? ` with ${params.currency} ${refused.alreadyRegistered.toFixed(2)} already registered against it`
              : '') +
            ` — it would refuse a larger payment. Check the invoice in the ledger: on a tax-inclusive ` +
            `imported order it can be posted NET of VAT. ${tail}`,
            {
              amount: params.amount, currency: params.currency, refusal: refused.refusal,
              alreadyRegistered: refused.alreadyRegistered, ledgerTotal: refused.ledgerTotal,
            })
          return
      }
    }

    if (!decision.register) {
      await reportRefusal(decision)
      return
    }

    // ENQUEUE UNDER THE ORDER LOCK, and only if the receipt is still there. The Payment row committed
    // before this runs, and deletePayment cancels a queued registration by looking for one — so a delete
    // landing in between saw nothing to cancel, and this then posted a payment to the ledger for a
    // receipt IMS had already deleted, with no warning anywhere (Codex, PR #582 round 1).
    //
    // deletePayment takes the same per-order lock, so serialising on it closes the window in both
    // directions: either we find the payment gone and do nothing, or we queue first and the delete finds
    // our row and retracts it.
    const outcome = await db.$transaction(async (tx) => {
      await lockSalesOrder(tx, params.orderId)
      // o3d-0m56: AND the follow-up scope lock, taken before the rows are re-read.
      //
      // The order lock serialises this against deletePayment, which is what it was added for. It does
      // NOT serialise it against the other writers that can put an INVOICE_PAYMENT row into this same
      // scope — the connector queues and the manual retry, neither of which touches the sales order.
      // Between the re-read below and the insert, one of those can queue a row for this document under
      // a fresh token; FAILED rows sit outside accounting_sync_logs_followup_live_unique, so nothing
      // objects, and both can post. Only a lock BOTH sides take closes that, because PostgreSQL has no
      // predicate locks and SELECT ... FOR UPDATE says nothing about a row about to be inserted.
      //
      // Order is fixed and uniform across every writer — sales-order row lock first, scope lock second
      // — so this cannot deadlock against the enqueue path. See followup-scope-lock.ts.
      if (probeConnector) {
        await lockFollowUpScope(tx, {
          connector: probeConnector,
          type: 'INVOICE_PAYMENT',
          referenceType: 'SalesOrder',
          referenceId: params.orderId,
        })
      }
      const stillRecorded = await tx.payment.findUnique({ where: { id: params.paymentId }, select: { id: true } })
      if (!stillRecorded) return 'receipt-deleted' as const
      // RE-DECIDE UNDER THE LOCK (o3d-cjt8). While one live registration per ORDER was the rule, the
      // unique index caught two receipts racing: the loser got a P2002. Now that the index is scoped to
      // the receipt, both would insert cleanly and the invoice would be over-settled — because "the
      // parts must not exceed the whole" is arithmetic, and a unique index cannot enforce arithmetic.
      // The capacity read has to happen inside the transaction that holds the order lock, against the
      // same client, or the check-then-act window is simply moved rather than closed.
      const underLock = decideInvoicePaymentRegistration({
        ...decisionInput,
        existing: await loadInvoicePaymentSyncRows(params.orderId, connector?.id ?? null, tx),
      })
      if (!underLock.register) return { refused: underLock } as const
      const queued = await queueAccountingSyncTx(tx, {
        type: 'INVOICE_PAYMENT',
        referenceType: 'SalesOrder',
        referenceId: params.orderId,
        payload: {
          accountingInvoiceId: so.accountingInvoiceId,
          bankAccountId: underLock.bankAccountId,
          amount: params.amount,
          currency: params.currency,
          paymentDate: params.paidAt.toISOString().slice(0, 10),
          method: params.method ?? '',
          reference: params.reference ?? undefined,
          // Which local receipt this is, so deletePayment can retract exactly this row rather than any
          // row that happens to share its amount.
          paymentId: params.paymentId,
        },
        // Exactly once per recorded receipt, however many times this runs.
        idempotencyKey: `invoice-payment:payment:${params.paymentId}`,
      })
      return queued ? ('queued' as const) : ('context-changed' as const)
    }, STOCK_TX_OPTIONS)

    // queueAccountingSyncTx RE-READS the posting context and returns false when it has since changed —
    // the connector switched off, or INVOICE_PAYMENT posting disabled, between the check above and the
    // write. Ignoring that boolean left the receipt accepted locally with no sync row, no warning and
    // nothing to retry: the silent loss this whole issue is about (Codex, PR #582 round 8).
    // The capacity re-check under the lock refused it. A concurrent receipt for the same order took the
    // room this one was measured against, so it is reported exactly as if it had been refused up front
    // — the operator sees one message naming the reason, not a silent no-op.
    if (typeof outcome === 'object' && 'refused' in outcome) {
      await reportRefusal(outcome.refused)
      return
    }
    if (outcome === 'context-changed') {
      await warn('invoice_payment_not_registered',
        `Recorded ${params.currency} ${params.amount.toFixed(2)} against ${params.orderReference}, but ` +
        `accounting sync for payments was switched off while it was being queued, so nothing was sent. ` +
        `Re-enable it and register the payment, or record it in the ledger by hand.`,
        { amount: params.amount, currency: params.currency, refusal: 'POSTING_CONTEXT_CHANGED' })
    }
  } catch (e) {
    // Same shape as markBillPaid's queue failure: the receipt is recorded in IMS with nothing queued to
    // tell the ledger, so nothing will ever retry and there is no FAILED row to notice — the row was
    // never written. That is the quietest way the two systems disagree, so it is recorded as an ERROR.
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: params.orderId,
      action: 'invoice_payment_not_queued',
      tag: 'accounting',
      level: 'ERROR',
      description:
        `Recorded ${params.currency} ${params.amount.toFixed(2)} against ${params.orderReference}, but the ` +
        `payment could not be queued for the accounting connector — the ledger still shows the invoice ` +
        `outstanding and nothing will retry. Re-queue it, or record the payment in the ledger by hand.`,
      metadata: {
        orderNumber: params.orderReference,
        paymentId: params.paymentId,
        amount: params.amount,
        currency: params.currency,
        error: e instanceof Error ? e.message : String(e),
      },
    }).catch(() => { /* logging must never block the receipt either */ })
  }
}
/**
 * REGISTER RECEIPTS THAT WERE RECORDED BEFORE THE INVOICE EXISTED (o3d-ekn8).
 *
 * `registerInvoicePaymentWithLedger` refuses with DOCUMENT_NOT_POSTED when the order has no
 * accountingInvoiceId — a payment cannot attach to a document the ledger has never seen. That refusal is
 * right; what was missing is that nothing re-visited the receipt once the SALES_INVOICE finally posted.
 * The receipt stayed recorded, the ledger stayed unsettled, and the only sign was the settlement verdict
 * flipping to a red NOT_SENT that somebody had to notice.
 *
 * So this is NOT a key fix. Nothing about the uniqueness of a payment was wrong — the work simply
 * arrived before the thing it depends on. The fix is a re-drive at the one moment the refusal stops
 * applying: the connector calls this straight after a SALES_INVOICE CREATE posts and updateBackReference
 * has written accountingInvoiceId (that ordering is what makes the re-read below see the new id).
 *
 * It re-runs the SAME guarded decision rather than a second, laxer copy of it — currency, bank-account
 * mapping and invoice capacity are all re-checked per receipt — and `selectReceiptsAwaitingRegistration`
 * keeps it to receipts with no sync row of their own at all, so it can never re-drive an attempt that
 * may already have posted. Sequential by design: each call re-reads the live rows, so the second receipt
 * is measured against an invoice the first has already consumed part of.
 *
 * Never throws: a follow-up enqueue must not fail the sync entry that posted the invoice.
 */
export async function registerDeferredOrderReceipts(orderId: string): Promise<void> {
  try {
    if (!(await isAccountingSyncTypeEnabled('INVOICE_PAYMENT').catch(() => false))) return
    const connector = await getActiveAccountingConnectorInfo().catch(() => null)
    const order = await db.salesOrder.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        orderNumber: true,
        externalOrderNumber: true,
        accountingInvoiceId: true,
        payments: {
          // A refund payment settles a CREDIT NOTE, not this invoice, so it is not a receipt against it.
          where: { refundId: null },
          select: { id: true, amount: true, currency: true, method: true, reference: true, paidAt: true },
          orderBy: { paidAt: 'asc' },
        },
      },
    })
    if (!order || !order.accountingInvoiceId || order.payments.length === 0) return

    const awaiting = selectReceiptsAwaitingRegistration({
      receipts: order.payments,
      existing: await loadInvoicePaymentSyncRows(order.id, connector?.id ?? null),
    })
    if (awaiting.length === 0) return

    const orderReference = getSalesOrderReference(order)
    for (const receipt of awaiting) {
      await registerInvoicePaymentWithLedger({
        orderId: order.id,
        orderReference,
        paymentId: receipt.id,
        amount: Number(receipt.amount),
        currency: receipt.currency,
        method: receipt.method,
        reference: receipt.reference,
        paidAt: receipt.paidAt,
      })
    }
  } catch (error) {
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      action: 'deferred_invoice_payment_registration_failed',
      tag: 'accounting',
      level: 'WARNING',
      description:
        `The invoice for this order posted, but the receipts recorded before it could not be registered ` +
        `with the accounting connector: ${String(error)}. Register them there by hand, or re-run the ` +
        `invoice sync.`,
      metadata: { orderId, error: error instanceof Error ? error.message : String(error) },
    }).catch(() => { /* logging must never block the follow-up either */ })
  }
}
