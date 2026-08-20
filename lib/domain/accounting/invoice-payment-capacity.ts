/**
 * OVER-SETTLEMENT REFUSED WHERE IT CANNOT BE BYPASSED (o3d-cjt8, round 2).
 *
 * THE HISTORY. `accounting_sync_logs_followup_live_unique` used to permit exactly ONE live
 * INVOICE_PAYMENT row per ORDER. That key named the wrong artefact — a Xero Payment is per RECEIPT
 * against a DOCUMENT, so a deposit and a balance are two payments, not one — and the migration
 * 20260819120000 rescoped it to (…, accountingInvoiceId, paymentId). Correct, but it also stopped the
 * database preventing an ORDER from being over-settled by several receipts, because "the parts must not
 * exceed the whole" is arithmetic and no unique index can express it.
 *
 * That arithmetic moved into `decideInvoicePaymentRegistration`, re-run under the order row lock at the
 * one enqueue path that takes it. The stated assumption was that EVERY INVOICE_PAYMENT enqueue takes
 * `lockSalesOrder`. It does not, and the counter-example was already in the tree: the imported-order
 * path (`enqueueSalesInvoiceFollowUps`'s `_registerPayment` branch) enqueues a payment straight after a
 * SALES_INVOICE posts, with no order lock and no capacity arithmetic at all. So over-settlement
 * protection ended up WEAKER than the index it replaced (Codex, round 2 #2).
 *
 * THE FIX IS NOT A THIRD CALL SITE. An enqueue-time guard is only as good as the roll-call of enqueue
 * paths, and that roll-call has already been wrong once. What is not a roll-call is the POST:
 *
 *   every INVOICE_PAYMENT that reaches the ledger — from `addPayment`, from the deferred-receipt
 *   re-drive, from the imported-order follow-up, from a repair sweep, from a path written next year —
 *   must pass through its connector's INVOICE_PAYMENT case to make the remote call.
 *
 * So the capacity arithmetic is enforced THERE, immediately before `xeroPost('Payments', …)`. A new
 * enqueue path cannot skip it by forgetting anything, because it is not on the enqueue path at all.
 * The enqueue-time check in `registerInvoicePaymentWithLedger` stays, demoted to what it is actually
 * good at: giving the operator an immediate, actionable message at the moment they record the receipt,
 * rather than a silent refusal minutes later.
 *
 * WHAT COUNTS AS CAPACITY ALREADY USED, AT POST TIME. Only rows that have ACTUALLY POSTED — SYNCED.
 * This is deliberately different from the enqueue-time rule, and the difference is the point:
 *
 *   SYNCED             money moved. It consumes the invoice.
 *   PENDING/PROCESSING queued, not posted. Counting these would refuse the FIRST receipt of a deposit +
 *                      balance pair because its sibling is sitting in the queue behind it — and it is
 *                      safe not to count them, because `findInvoicePaymentsBlockedByEarlierLiveLogs`
 *                      serialises INVOICE_PAYMENT entries per reference: only the earliest live entry
 *                      for an order is ever un-deferred, so no sibling can be posting alongside us. The
 *                      later one re-runs this guard against our SYNCED row when its turn comes.
 *   FAILED/CANCELLED   did not post, or was deliberately abandoned. Counting FAILED would strand every
 *                      subsequent receipt behind a permanently failed one. The residual — a FAILED row
 *                      that did commit remotely before failing (o3d-ju8t) — is handled by the pinned
 *                      remote idempotency token (o3d-h2wx), which makes its retry return the ORIGINAL
 *                      payment instead of creating a second, not by this arithmetic.
 *
 * FAIL CLOSED. An unreadable order, an unreadable amount on a posted row, or a reference this guard
 * cannot measure at all does NOT post. A transient read outage must never become permission to move
 * money, on the same principle as `guardCancelledSalesOrderInvoice`.
 *
 * RESIDUAL, stated rather than hidden. The read is not taken under the order row lock, and it could not
 * usefully be: holding a `SELECT … FOR UPDATE` across an outbound HTTP call to Xero trades a rare race
 * for a routine hang, and `guardCancelledSalesOrderInvoice` already documents the same select-then-post
 * window for the invoice itself. What closes the ordinary race instead is the per-reference
 * serialisation in `findInvoicePaymentsBlockedByEarlierLiveLogs`: only the EARLIEST live INVOICE_PAYMENT
 * for an order is ever un-deferred, so a sibling cannot be posting alongside us. Two independent runners
 * (`processPendingSyncEntries` and the outbox worker) each compute that blocked set from their own
 * snapshot, and a claim gone stale for 15 minutes can be re-taken, so the window is narrow rather than
 * nil — the remaining protection there is the pinned remote idempotency token (o3d-h2wx), which makes a
 * re-post of the SAME entry return the original Xero payment rather than create a second.
 */

import type { Prisma } from '@/app/generated/prisma/client'

import { CAPACITY_EPSILON } from '@/lib/domain/accounting/invoice-payment-registration'
import { ledgerSalesInvoiceTotalForeign } from '@/lib/domain/accounting/settlement-status'

/** The only status that asserts the remote call happened. */
export const POSTED_INVOICE_PAYMENT_STATUSES = ['SYNCED'] as const

export type PostedInvoicePaymentRegistration = {
  id: string
  status: string
  /** What was sent, in the document currency. Null when the payload did not record it. */
  amount: number | null
  /** The ledger document it settled. Null on rows queued before the payload recorded it. */
  accountingInvoiceId: string | null
}

export type InvoicePaymentPostRefusal =
  /** A posted registration exists whose amount cannot be read, so remaining capacity is unknowable. */
  | 'LEDGER_AMOUNT_UNKNOWN'
  /** This payment does not fit in what is left of the invoice after what the ledger already holds. */
  | 'WOULD_OVERPAY'

export type InvoicePaymentPostVerdict =
  | { post: true; alreadyPosted: number; ledgerTotal: number }
  | { post: false; refusal: InvoicePaymentPostRefusal; alreadyPosted: number | null; ledgerTotal: number }

/**
 * Pure capacity arithmetic for one about-to-post registration. Kept separate from the reads so the rule
 * is testable without a database, and so the two guards (enqueue and post) can be compared side by side.
 */
export function decideInvoicePaymentPost(input: {
  /** THIS entry's sync-log id. Its own row must never count against it. */
  entryId: string
  accountingInvoiceId: string
  amount: number
  ledgerTotal: number
  /** Every INVOICE_PAYMENT sync row for this order on this connector, including this entry's own. */
  registrations: PostedInvoicePaymentRegistration[]
}): InvoicePaymentPostVerdict {
  const posted = input.registrations.filter(
    (row) =>
      row.id !== input.entryId
      && (POSTED_INVOICE_PAYMENT_STATUSES as readonly string[]).includes(row.status)
      // o3d-hbgo: a row that settled a DIFFERENT ledger document paid an invoice this order no longer
      // has (deleted and re-posted). It consumes none of the CURRENT invoice's capacity. A row that
      // names NO document stays counted: for money, unknown reads as "possibly this one".
      && (row.accountingInvoiceId == null || row.accountingInvoiceId === input.accountingInvoiceId),
  )

  if (posted.some((row) => typeof row.amount !== 'number')) {
    return { post: false, refusal: 'LEDGER_AMOUNT_UNKNOWN', alreadyPosted: null, ledgerTotal: input.ledgerTotal }
  }

  const alreadyPosted = posted.reduce((sum, row) => sum + (row.amount as number), 0)
  if (input.amount > input.ledgerTotal - alreadyPosted + CAPACITY_EPSILON) {
    return { post: false, refusal: 'WOULD_OVERPAY', alreadyPosted, ledgerTotal: input.ledgerTotal }
  }
  return { post: true, alreadyPosted, ledgerTotal: input.ledgerTotal }
}

export type InvoicePaymentPostGuardResult =
  | { post: true }
  /** Measured, and it does not fit. Terminal: nothing was sent and nothing should be. */
  | {
      post: false
      kind: 'refused'
      refusal: InvoicePaymentPostRefusal
      message: string
      alreadyPosted: number | null
      ledgerTotal: number
    }
  /** Could not be measured. Retryable, and NOT posted — fail closed. */
  | { post: false; kind: 'unmeasurable'; message: string }

type CapacityClient = Pick<Prisma.TransactionClient, 'salesOrder' | 'accountingSyncLog'>

function payloadNumber(payload: unknown, field: string): number | null {
  const record = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
  return typeof record[field] === 'number' ? (record[field] as number) : null
}

function payloadString(payload: unknown, field: string): string | null {
  const record = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
  const value = record[field]
  return typeof value === 'string' ? value : null
}

/**
 * Read the ledger's copy of the invoice and everything already registered against it, and decide
 * whether this entry may post. Called from the connector's INVOICE_PAYMENT case, which is the one
 * place no enqueue path can route around.
 */
export async function guardInvoicePaymentCapacity(
  client: CapacityClient,
  params: {
    connector: string
    entryId: string
    referenceType: string
    referenceId: string
    accountingInvoiceId: string
    amount: number
  },
): Promise<InvoicePaymentPostGuardResult> {
  // An INVOICE_PAYMENT is always order-scoped today. If one ever is not, its capacity cannot be
  // measured — and "cannot measure" must not read as "go ahead".
  if (params.referenceType !== 'SalesOrder') {
    return {
      post: false,
      kind: 'unmeasurable',
      message:
        `Refusing to register an invoice payment for ${params.referenceType} ${params.referenceId}: `
        + `invoice capacity can only be measured against a SalesOrder, so IMS cannot tell whether this `
        + `payment would over-settle the invoice.`,
    }
  }

  let order: {
    totalForeign: unknown
    taxForeign: unknown
    pricesIncludeVat: boolean
    shoppingLinks: { connector: string }[]
  } | null
  let registrations: { id: string; status: string; payload: unknown }[]
  try {
    ;[order, registrations] = await Promise.all([
      client.salesOrder.findUnique({
        where: { id: params.referenceId },
        select: {
          totalForeign: true,
          taxForeign: true,
          pricesIncludeVat: true,
          shoppingLinks: { select: { connector: true }, take: 1 },
        },
      }),
      client.accountingSyncLog.findMany({
        where: {
          connector: params.connector,
          type: 'INVOICE_PAYMENT',
          referenceType: 'SalesOrder',
          referenceId: params.referenceId,
        },
        select: { id: true, status: true, payload: true },
      }),
    ])
  } catch (error) {
    return {
      post: false,
      kind: 'unmeasurable',
      message:
        `Could not read sales order ${params.referenceId} or its payment registrations before posting `
        + `an invoice payment: ${String(error)}`,
    }
  }

  if (!order) {
    return {
      post: false,
      kind: 'unmeasurable',
      message: `Sales order ${params.referenceId} not found before posting an invoice payment.`,
    }
  }

  const ledgerTotal = ledgerSalesInvoiceTotalForeign({
    totalForeign: Number(order.totalForeign),
    taxForeign: Number(order.taxForeign),
    pricesIncludeVat: order.pricesIncludeVat,
    // Only an IMPORTED tax-inclusive invoice posts at NET (o3d-cyn); an order raised in IMS posts gross.
    importedFromShop: order.shoppingLinks.length > 0,
  })
  if (!Number.isFinite(ledgerTotal)) {
    return {
      post: false,
      kind: 'unmeasurable',
      message:
        `Sales order ${params.referenceId} has no readable invoice total, so IMS cannot tell whether `
        + `this payment would over-settle the invoice.`,
    }
  }

  const verdict = decideInvoicePaymentPost({
    entryId: params.entryId,
    accountingInvoiceId: params.accountingInvoiceId,
    amount: params.amount,
    ledgerTotal,
    registrations: registrations.map((row) => ({
      id: row.id,
      status: row.status,
      amount: payloadNumber(row.payload, 'amount'),
      accountingInvoiceId: payloadString(row.payload, 'accountingInvoiceId'),
    })),
  })
  if (verdict.post) return { post: true }

  const message = verdict.refusal === 'LEDGER_AMOUNT_UNKNOWN'
    ? `Refused to register a payment of ${params.amount.toFixed(2)} against invoice `
      + `${params.accountingInvoiceId}: a payment already posted for this invoice does not record its `
      + `amount, so IMS cannot tell how much of the invoice is still outstanding. Nothing was sent — `
      + `reconcile the invoice in the ledger and register the payment there by hand.`
    : `Refused to register a payment of ${params.amount.toFixed(2)} against invoice `
      + `${params.accountingInvoiceId}: the ledger's copy of this invoice is for `
      + `${verdict.ledgerTotal.toFixed(2)} with ${(verdict.alreadyPosted ?? 0).toFixed(2)} already `
      + `registered against it, so this payment would over-settle it. Nothing was sent — reconcile the `
      + `invoice in the ledger and register the balance there by hand if it is genuinely owed.`

  return {
    post: false,
    kind: 'refused',
    refusal: verdict.refusal,
    message,
    alreadyPosted: verdict.alreadyPosted,
    ledgerTotal: verdict.ledgerTotal,
  }
}

/**
 * Retire an entry the capacity guard refused, CLAIM-FENCED (same shape as
 * `retireSalesInvoiceForCancelledOrder`).
 *
 * CANCELLED is the honest status here and, unusually, provably so: the guard runs BEFORE the remote
 * call, so this row demonstrably never reached the ledger. That is exactly the distinction o3d-sref
 * drew — CANCELLED must only ever be asserted where "nothing was sent" is TRUE.
 *
 * Fenced on `status: 'PROCESSING'` + this worker's exact `processingStartedAt` + `externalTransactionId:
 * null`, so a stale reclaim by a newer worker is not clobbered and a row that already posted is never
 * rewritten as if it had not.
 */
export async function retireOverSettlingInvoicePayment(
  client: Pick<Prisma.TransactionClient, 'accountingSyncLog'>,
  params: { entryId: string; claimedAt: Date; reason: string },
): Promise<boolean> {
  const retired = await client.accountingSyncLog.updateMany({
    where: {
      id: params.entryId,
      status: 'PROCESSING',
      processingStartedAt: params.claimedAt,
      externalTransactionId: null,
    },
    data: { status: 'CANCELLED', errorMessage: params.reason, processingStartedAt: null },
  })
  return retired.count > 0
}
