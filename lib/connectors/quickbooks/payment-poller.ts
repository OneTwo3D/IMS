/**
 * QuickBooks Online payment detection polling.
 * Polls QBO for recently paid invoices and bills, updating IMS records.
 * Mirrors lib/connectors/xero/payment-poller.ts.
 */

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { INTERNAL_ACTION_BYPASS } from '@/lib/internal-action-bypass'
import {
  detectPaymentReversals,
  readDatabaseLedgerFence,
  readPaidProvenanceVerdicts,
} from '@/lib/domain/accounting/payment-reversal'
import {
  zeroPaidIsProvenReversal,
  type LedgerReadFence,
  type RegisteredPaymentVerdict,
} from '@/lib/connectors/xero/invoice-delta'
import { qboQuery } from './api'
import { getSettingValue } from '@/lib/settings-store'

const LAST_POLL_KEY = 'quickbooks_last_payment_poll'

/** A QuickBooks reversal can only ever speak about rows QuickBooks itself issued. */
const QUICKBOOKS_CONNECTOR = 'quickbooks'

type QboInvoice = {
  Id: string
  Balance: number
  MetaData?: { LastUpdatedTime?: string }
}

type QboBill = {
  Id: string
  Balance: number
  MetaData?: { LastUpdatedTime?: string }
}

type QboQueryResponse<T> = {
  QueryResponse: Record<string, T[] | undefined>
}

type QboEntityId = { Id: string }

/**
 * Split the QBO transactions that regressed out of the fully-paid state into the
 * full reversed set and the subset that was VOIDED. Mirrors the Xero poller's
 * {all, voided} contract (audit-M-acct #3 / scjz.71):
 *  - balanceDueEntities: invoices/bills whose Balance returned to > 0 (the payment
 *    was deleted/un-applied but the document is still live) — eligible for a
 *    revenue chargeback on the sales side.
 *  - voidedEntities: invoices/bills QBO zeroed out (TotalAmt = 0). QBO has already
 *    reversed their AR/revenue, so paidAt is cleared but NO chargeback is raised
 *    (a separate credit note would double-reverse).
 * Pure set union so it can be unit-tested without the QBO API.
 */
export function classifyQboReversals(
  balanceDueEntities: QboEntityId[],
  voidedEntities: QboEntityId[],
): { all: Set<string>; voided: Set<string> } {
  const all = new Set<string>()
  const voided = new Set<string>()
  for (const e of balanceDueEntities) all.add(e.Id)
  for (const e of voidedEntities) {
    all.add(e.Id)
    voided.add(e.Id)
  }
  return { all, voided }
}

// QBO equivalent of Xero's fetchReversedInvoiceIds. An IMS-paid document (Balance
// was 0) is "reversed" if, modified since the last poll, its QBO transaction now
// has Balance > 0 (payment removed) or TotalAmt = 0 (voided/zeroed). Returns null
// if either query failed so the caller can hold the poll watermark and retry.
async function fetchReversedEntityIds(
  entity: 'Invoice' | 'Bill',
  since: string,
): Promise<{ all: Set<string>; voided: Set<string>; ledgerObservedBefore: LedgerReadFence | null } | null> {
  // o3d-psrx r3 — THE FENCE IS MINTED HERE, AND HERE IS BEFORE THE LEDGER IS ASKED.
  //
  // It is read inside this function rather than by the caller for one reason: the ordering that makes
  // the fence sound is PROGRAM ORDER — this statement running before `qboQuery` — and a fence passed
  // in from elsewhere is a fence whose ordering nobody in this file can see. Null is a legitimate
  // answer (the database clock could not be read) and it decides NOTHING, which withholds every
  // reversal that has a registration to weigh.
  const ledgerObservedBefore = await readDatabaseLedgerFence()
  const [balanceRes, voidedRes] = await Promise.all([
    qboQuery<QboQueryResponse<QboEntityId>>(entity, `Balance > '0' AND MetaData.LastUpdatedTime > '${since}'`),
    qboQuery<QboQueryResponse<QboEntityId>>(entity, `TotalAmt = '0' AND MetaData.LastUpdatedTime > '${since}'`),
  ])
  if (!balanceRes.ok || !voidedRes.ok) return null
  const balanceDue = balanceRes.data?.QueryResponse?.[entity] ?? []
  const voided = voidedRes.data?.QueryResponse?.[entity] ?? []
  return { ...classifyQboReversals(balanceDue, voided), ledgerObservedBefore }
}

/**
 * o3d-psrx r3 (Codex HIGH) — THE PROVENANCE GATE, APPLIED TO WHATEVER QUICKBOOKS SAYS REGRESSED.
 *
 * THE DEFECT. r2 established that a paid sale IMS never told the ledger about must not be reversed,
 * and wired it into the Xero poller. This poller's reversal candidate query selected neither
 * `unregisteredPaidAt` nor any receipt/registration evidence, so every recently modified balance-due
 * invoice walked straight into reversal handling. A native order marked paid through
 * `markSalesOrderPaid` has no shopping link, sets the marker, and by design creates no ledger
 * payment — it satisfied that query exactly, and IMS's deliberate non-registration read as a removed
 * payment: chargeback credit note raised, `paidAt` cleared, against a customer who paid.
 *
 * ONE DECISION, NOT A SECOND ONE WORDED LIKE IT. `readPaidProvenanceVerdicts` and
 * `zeroPaidIsProvenReversal` are the SAME functions the Xero poller reaches its verdict with. The
 * only connector-shaped argument is `ledgerListedPaymentIds`, and QuickBooks' answer to that is
 * always NULL: the reversal read asks which invoice ids regressed and nothing else, so this poller
 * cannot enumerate the payments a document carries. Null means "absence cannot be established from
 * this payload", NOT "no payments" — so GONE and STILL_HELD are unreachable here and a document with
 * a posted registration lands on LEDGER_DID_NOT_LIST_PAYMENTS.
 *
 * WHICH DIRECTION THIS MOVES. Every verdict `zeroPaidIsProvenReversal` admits was already reversed
 * before this gate existed, so no reversal this poller used to make is lost. What it adds is
 * withholding for the three states that used to reverse wrongly: the paid flag with no ledger
 * receipt behind it (PAID_WITHOUT_LEDGER_RECEIPT), a local receipt not yet registered
 * (RECEIPT_NOT_REGISTERED), and a registration this read cannot speak for (REGISTRATION_UNDECIDED).
 *
 * A RESIDUAL THIS DOES NOT CLOSE, stated so nobody reads it as closed: `Balance > 0` covers a PART
 * payment as well as a removed one, and this poller does not read the amounts to tell them apart.
 * Xero's poller does (`partitionPaymentReversals`). That is a different defect from the one Codex
 * found and it is filed separately; nothing here makes it worse.
 */
export type QboReversalGate<T> = {
  /** Reversal may proceed: the evidence proves the payment is gone, or there was never one of ours. */
  admitted: T[]
  /** Reversal WITHHELD — `paidAt` is left set and reported, never cleared on unproven evidence. */
  withheld: Array<{ doc: T; verdict: RegisteredPaymentVerdict }>
}

export async function gateQboReversalsOnProvenance<T extends { id: string; accountingInvoiceId: string | null; unregisteredPaidAt?: Date | null }>(
  candidates: T[],
  params: {
    registrationType: 'BILL_PAYMENT' | 'INVOICE_PAYMENT'
    referenceType: 'PurchaseInvoice' | 'SalesOrder'
    ledgerObservedBefore: LedgerReadFence | null
  },
): Promise<QboReversalGate<T>> {
  const gate: QboReversalGate<T> = { admitted: [], withheld: [] }
  if (candidates.length === 0) return gate
  const verdicts = await readPaidProvenanceVerdicts(candidates, {
    connector: QUICKBOOKS_CONNECTOR,
    registrationType: params.registrationType,
    referenceType: params.referenceType,
    ledgerObservedBefore: params.ledgerObservedBefore,
    // QuickBooks' reversal read enumerates no payments. See the header — null is not emptiness.
    ledgerListedPaymentIds: () => null,
  })
  for (const doc of candidates) {
    const verdict = verdicts.get(doc.id)
    // NO VERDICT IS NOT A PASS. An absence means nothing was decided about this document, and the
    // fail-closed reading of "nothing was decided" is the same one a null fence gets: withhold.
    if (verdict == null) {
      gate.withheld.push({ doc, verdict: { verdict: 'REGISTRATION_UNDECIDED', entryIds: [] } })
      continue
    }
    if (zeroPaidIsProvenReversal(verdict)) gate.admitted.push(doc)
    else gate.withheld.push({ doc, verdict })
  }
  return gate
}

/** Why a withheld reversal was withheld, in words an operator can act on. */
export function qboWithheldReversalReason(verdict: RegisteredPaymentVerdict): string {
  switch (verdict.verdict) {
    case 'PAID_WITHOUT_LEDGER_RECEIPT':
      return 'IMS holds this as paid from a channel or an operator, and no payment was ever registered '
        + 'with QuickBooks for it. QuickBooks showing a balance due is IMS\'s own silence, not a removed '
        + 'payment, so paidAt was LEFT SET and no chargeback credit note was raised. If the payment '
        + 'really was reversed, unwind it by hand.'
    case 'RECEIPT_NOT_REGISTERED':
      return `IMS has recorded a receipt (${verdict.paymentIds.join(', ')}) that has not been registered `
        + 'with QuickBooks yet, so the balance due is a payment of OURS that has not landed rather than '
        + 'one taken away. paidAt was LEFT SET; IMS will decide this itself once the registration posts.'
    case 'REGISTRATION_UNDECIDED':
      return `IMS holds a payment registration (${verdict.entryIds.join(', ') || 'clock unreadable'}) that `
        + 'this QuickBooks read cannot speak for, so the balance due may be a payment of ours still in '
        + 'flight. paidAt was LEFT SET rather than guessed.'
    case 'STILL_HELD':
      return `QuickBooks still lists the payment IMS registered (${verdict.paymentIds.join(', ')}) on a `
        + 'document it reports as unpaid. That contradiction is not proof of a reversal, so paidAt was '
        + 'LEFT SET. Reconcile the document in QuickBooks.'
    case 'GONE':
    case 'NOTHING_REGISTERED':
    case 'LEDGER_DID_NOT_LIST_PAYMENTS':
      // Not reachable — these are the admitted verdicts. Stated rather than defaulted so a new
      // verdict added to the union is a type error here instead of a silent generic sentence.
      return 'Reversal was admitted; no reason to report.'
  }
}

/**
 * Poll QuickBooks for paid invoices and bills.
 * Updates paidAt on matching IMS records and advances order status.
 */
export async function pollQuickBooksPayments(): Promise<{ salesPaid: number; billsPaid: number; salesReversed: number; billsReversed: number; salesReversalsWithheld: number; billsReversalsWithheld: number; errors: string[] }> {
  const errors: string[] = []
  let salesPaid = 0
  let billsPaid = 0
  let salesReversed = 0
  let billsReversed = 0
  // o3d-psrx r3: reversals the provenance gate refused. Reported, never silently dropped.
  let salesReversalsWithheld = 0
  let billsReversalsWithheld = 0
  let allQueriesSucceeded = true

  const lastPoll = await getSettingValue(LAST_POLL_KEY)
  const since = lastPoll || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const now = new Date().toISOString()

  // --- Sales invoices (customer payments) ---
  const unpaidOrders = await db.salesOrder.findMany({
    where: {
      accountingInvoiceId: { not: null },
      paidAt: null,
      refundStatus: { not: 'FULL' }, // a fully refunded order must not be revived as paid
      shoppingLinks: { none: {} }, // manual orders only; shopping orders get channel payment status
    },
    select: { id: true, accountingInvoiceId: true, status: true },
  })

  if (unpaidOrders.length > 0) {
    // Query QBO for invoices with zero balance (fully paid)
    const res = await qboQuery<QboQueryResponse<QboInvoice>>(
      'Invoice',
      `Balance = '0' AND MetaData.LastUpdatedTime > '${since}'`,
    )

    if (!res.ok) {
      allQueriesSucceeded = false
      errors.push(`Failed to query QuickBooks invoices: ${res.error ?? 'Unknown error'}`)
    } else {
      const paidInvoices = res.data?.QueryResponse?.Invoice ?? []
      const paidInvoiceIds = new Set(paidInvoices.map((i) => i.Id))

      for (const order of unpaidOrders) {
        if (!order.accountingInvoiceId || !paidInvoiceIds.has(order.accountingInvoiceId)) continue

        try {
          // o3d-psrx r2: `unregisteredPaidAt: null` — a LEDGER-sourced paid flag (QuickBooks reported
          // the invoice paid). See SalesOrder.unregisteredPaidAt. Written here rather than left off
          // the object so this writer cannot inherit a marker an earlier non-ledger write left behind,
          // and so the paid-provenance guard can see it: an untyped `Record<string, unknown>` is
          // exactly the shape in which a missing column is not a type error.
          const updateData: Record<string, unknown> = { paidAt: new Date(), unregisteredPaidAt: null }
          // Advance status from PENDING_PAYMENT to PROCESSING
          if (order.status === 'PENDING_PAYMENT') {
            updateData.status = 'PROCESSING'
          }
          await db.salesOrder.update({
            where: { id: order.id },
            data: updateData,
          })

          // Trigger auto-allocation if status advanced.
          // o3d-67y: this runs in the sessionless cron, so it MUST pass INTERNAL_ACTION_BYPASS (as the Xero
          // poller does) — otherwise requirePermission('sales.process') fails, autoAllocateOrder returns
          // success:false, and since the poller only re-selects paidAt:null orders the paid order is never
          // retried and silently stays unallocated.
          if (order.status === 'PENDING_PAYMENT') {
            try {
              const { autoAllocateOrder } = await import('@/app/actions/allocation')
              await autoAllocateOrder(order.id, { internalBypassToken: INTERNAL_ACTION_BYPASS })
            } catch {
              // Non-critical — allocation can be done manually
            }
          }

          salesPaid++
        } catch (e) {
          errors.push(`Sales order ${order.id}: ${String(e)}`)
        }
      }
    }
  }

  // --- Sales payment reversals (audit-M-acct #3 / scjz.70/.71) ---
  // Forward poll only marks unpaid→paid. If an invoice IMS thinks is paid no longer
  // has a zero balance in QBO — payment deleted/un-applied (Balance > 0) or the
  // invoice voided (TotalAmt = 0) — clear paidAt so IMS stops showing it paid.
  // Status is NOT auto-reverted (the order may already be picking/shipped); a
  // WARNING carrying the current status flags it. Must run AFTER the forward pass
  // so a pay-then-reverse within one window nets to the correct (unpaid) state.
  const paidOrders = await db.salesOrder.findMany({
    where: {
      accountingInvoiceId: { not: null },
      paidAt: { not: null },
      shoppingLinks: { none: {} },
    },
    select: {
      id: true,
      accountingInvoiceId: true,
      orderNumber: true,
      externalOrderNumber: true,
      status: true,
      revenueDeferredDate: true,
      // o3d-psrx r3 (Codex HIGH): WHERE this order's paid flag came from. Selected with `paidAt`'s own
      // candidates because the reversal verdict turns on it — see gateQboReversalsOnProvenance.
      // Leaving it out is the defect itself: every verdict then reads as NOTHING_REGISTERED and a sale
      // an operator marked paid by hand is reversed with a chargeback credit note against it.
      unregisteredPaidAt: true,
    },
  })

  if (paidOrders.length > 0) {
    const reversedIds = await fetchReversedEntityIds('Invoice', since)
    if (!reversedIds) {
      allQueriesSucceeded = false
      errors.push('Failed to query QuickBooks invoices for payment reversals')
    } else {
      // o3d-psrx r3 (Codex HIGH) — THE SAME EVIDENCE XERO NOW REQUIRES, REQUIRED HERE.
      const gate = await gateQboReversalsOnProvenance(
        detectPaymentReversals(paidOrders, reversedIds.all),
        {
          registrationType: 'INVOICE_PAYMENT',
          referenceType: 'SalesOrder',
          ledgerObservedBefore: reversedIds.ledgerObservedBefore,
        },
      )

      // WITHHELD IS REPORTED, NEVER SILENT. The watermark is deliberately NOT held for it: a paid flag
      // that was never going to be registered stays unregistered for ever, so holding the cursor on it
      // would freeze every later QuickBooks payment and reversal behind it indefinitely — the same
      // trap o3d-w00 (Codex r8 #3) records a few lines below for a refused chargeback. The audit
      // entry is therefore the durable record, and it says what a human has to do.
      for (const { doc: order, verdict } of gate.withheld) {
        salesReversalsWithheld++
        await logActivity({
          entityType: 'SALES_ORDER',
          entityId: order.id,
          action: 'payment_reversal_withheld',
          tag: 'sync',
          level: 'WARNING',
          description: `QuickBooks reports a balance due on order ${order.orderNumber ?? order.externalOrderNumber} `
            + `(status: ${order.status}), but the payment reversal was WITHHELD. ${qboWithheldReversalReason(verdict)}`,
          resolveUser: false,
        })
      }

      for (const order of gate.admitted) {
        // scjz.71: a reversed payment on a revenue-POSTED order (revenue recognised +
        // invoiced) is a chargeback — raise a revenue-only credit note that reverses
        // recognised revenue against AR. Idempotent (one chargeback per order).
        // A VOIDED invoice has already had its AR/revenue reversed by QBO, so a
        // separate credit note would double-reverse — only auto-chargeback an
        // un-applied payment where the invoice is still live.
        // CRITICAL: clear paidAt ONLY after the chargeback is recorded — otherwise a
        // failed chargeback would drop the order out of the next poll's paidOrders
        // (paidAt: not null) and the recognised revenue would never be reversed.
        const invoiceVoided = order.accountingInvoiceId != null && reversedIds.voided.has(order.accountingInvoiceId)
        let chargebackFailed = false
        // o3d-w00 (Codex r8 #3): the refusal the posted-VAT fence raises stands until an admin changes
        // the tax configuration, so holding paidAt AND the poll watermark for it would freeze the whole
        // QuickBooks cursor indefinitely — every later payment and reversal behind it, not just this
        // order. Payment truth is reconciled and the order flagged instead.
        let chargebackManualReason: string | undefined
        if (order.revenueDeferredDate && !invoiceVoided) {
          try {
            const { raiseChargebackForReversedOrder } = await import('@/app/actions/sales')
            const chargeback = await raiseChargebackForReversedOrder(order.id, { internalBypassToken: INTERNAL_ACTION_BYPASS })
            if (chargeback.error && chargeback.manualResolutionRequired) {
              chargebackManualReason = chargeback.error
              errors.push(`Chargeback for order ${order.orderNumber ?? order.id} needs manual handling: ${chargeback.error}`)
            } else if (chargeback.error) {
              chargebackFailed = true
              errors.push(`Chargeback for order ${order.orderNumber ?? order.id} failed: ${chargeback.error}`)
            }
          } catch (chargebackError) {
            chargebackFailed = true
            errors.push(`Chargeback for order ${order.orderNumber ?? order.id} failed: ${String(chargebackError)}`)
          }
        }
        // Leave paidAt set on a failed chargeback so the reversal is re-attempted and
        // the order is not silently shown unpaid-and-unreversed. Also hold the poll
        // watermark: unlike Xero (whose cursor gate is errors.length===0), the QBO
        // cursor advances on allQueriesSucceeded, so without this the window moves past
        // the reversed invoice and the LastUpdatedTime>since reversal query never
        // re-returns it — the chargeback would never actually retry.
        if (chargebackFailed) {
          allQueriesSucceeded = false
          continue
        }
        // o3d-psrx r2: the provenance is cleared with the flag it describes.
        await db.salesOrder.update({
          where: { id: order.id },
          data: { paidAt: null, unregisteredPaidAt: null },
        })
        salesReversed++
        await logActivity({
          entityType: 'SALES_ORDER',
          entityId: order.id,
          action: 'payment_reversal_detected',
          tag: 'sync',
          level: 'WARNING',
          description: chargebackManualReason
            ? `Payment no longer present in QuickBooks for order ${order.orderNumber ?? order.externalOrderNumber} (status: ${order.status}) — cleared paidAt, but the revenue unwind was REFUSED and no credit note has been raised: ${chargebackManualReason} Raise the credit note manually, or fix the tax mapping and re-run the poller.`
            : `Payment no longer present in QuickBooks for order ${order.orderNumber ?? order.externalOrderNumber} (status: ${order.status}) — cleared paidAt. Review whether the order status should revert.`,
          resolveUser: false,
        })
      }
    }
  }

  // --- Purchase bills (vendor payments) ---
  const unpaidBills = await db.purchaseInvoice.findMany({
    where: {
      accountingInvoiceId: { not: null },
      paidAt: null,
    },
    select: { id: true, accountingInvoiceId: true },
  })

  if (unpaidBills.length > 0) {
    const res = await qboQuery<QboQueryResponse<QboBill>>(
      'Bill',
      `Balance = '0' AND MetaData.LastUpdatedTime > '${since}'`,
    )

    if (!res.ok) {
      allQueriesSucceeded = false
      errors.push(`Failed to query QuickBooks bills: ${res.error ?? 'Unknown error'}`)
    } else {
      const paidBills = res.data?.QueryResponse?.Bill ?? []
      const paidBillIds = new Set(paidBills.map((b) => b.Id))

      for (const bill of unpaidBills) {
        if (!bill.accountingInvoiceId || !paidBillIds.has(bill.accountingInvoiceId)) continue

        try {
          await db.purchaseInvoice.update({
            where: { id: bill.id },
            data: { paidAt: new Date() },
          })
          billsPaid++
        } catch (e) {
          errors.push(`Purchase invoice ${bill.id}: ${String(e)}`)
        }
      }
    }
  }

  // --- Purchase bill payment reversals (audit-M-acct #3) ---
  // A bill IMS thinks paid whose QBO transaction regressed (Balance > 0, payment
  // un-applied; or TotalAmt = 0, voided) gets paidAt cleared with a WARNING. No
  // chargeback equivalent on the purchase side.
  const paidBills = await db.purchaseInvoice.findMany({
    where: { accountingInvoiceId: { not: null }, paidAt: { not: null } },
    select: { id: true, accountingInvoiceId: true, poId: true, po: { select: { reference: true, status: true } } },
  })

  if (paidBills.length > 0) {
    const reversedIds = await fetchReversedEntityIds('Bill', since)
    if (!reversedIds) {
      allQueriesSucceeded = false
      errors.push('Failed to query QuickBooks bills for payment reversals')
    } else {
      // o3d-psrx r3: the SAME gate, at the sibling reader in this same file. A bill has no
      // `unregisteredPaidAt` column (markBillPaid queues its BILL_PAYMENT registration inside the paid
      // transaction — o3d-a3wx), so what this adds on the purchase side is the REGISTRATION fence: a
      // bill whose payment IMS has queued but not yet posted no longer has `paidAt` cleared on the
      // strength of a balance QuickBooks reports while that payment is still on its way. Clearing it
      // re-arms Mark Paid over money already leaving the bank, and pressing it pays the supplier twice.
      const gate = await gateQboReversalsOnProvenance(detectPaymentReversals(paidBills, reversedIds.all), {
        registrationType: 'BILL_PAYMENT',
        referenceType: 'PurchaseInvoice',
        ledgerObservedBefore: reversedIds.ledgerObservedBefore,
      })

      for (const { doc: bill, verdict } of gate.withheld) {
        billsReversalsWithheld++
        await logActivity({
          entityType: 'PURCHASE_ORDER',
          entityId: bill.poId,
          action: 'bill_payment_reversal_withheld',
          tag: 'sync',
          level: 'WARNING',
          description: `QuickBooks reports a balance due on the bill for PO ${bill.po.reference} `
            + `(PO status: ${bill.po.status}), but the payment reversal was WITHHELD. ${qboWithheldReversalReason(verdict)}`,
          resolveUser: false,
        })
      }

      for (const bill of gate.admitted) {
        await db.purchaseInvoice.update({ where: { id: bill.id }, data: { paidAt: null } })
        billsReversed++
        await logActivity({
          entityType: 'PURCHASE_ORDER',
          entityId: bill.poId,
          action: 'bill_payment_reversal_detected',
          tag: 'sync',
          level: 'WARNING',
          description: `Bill payment no longer present in QuickBooks for PO ${bill.po.reference} (PO status: ${bill.po.status}) — cleared paidAt.`,
          resolveUser: false,
        })
      }
    }
  }

  // Only advance the poll watermark if all QBO queries succeeded.
  // If a query failed, keep the previous checkpoint so the next run
  // replays the missed window instead of permanently skipping payments.
  if (allQueriesSucceeded) {
    await db.setting.upsert({
      where: { key: LAST_POLL_KEY },
      create: { key: LAST_POLL_KEY, value: now },
      update: { value: now },
    })
  }

  if (salesPaid > 0 || billsPaid > 0 || salesReversed > 0 || billsReversed > 0
    || salesReversalsWithheld > 0 || billsReversalsWithheld > 0) {
    await logActivity({
      entityType: 'SYSTEM',
      action: 'quickbooks_payment_poll',
      tag: 'sync',
      description: `QuickBooks payment poll: ${salesPaid} sales paid, ${billsPaid} bills paid, ${salesReversed} sales reversed, ${billsReversed} bills reversed`
        + `, ${salesReversalsWithheld} sales + ${billsReversalsWithheld} bill reversals withheld`,
      metadata: { salesPaid, billsPaid, salesReversed, billsReversed, salesReversalsWithheld, billsReversalsWithheld },
    })
  }

  return { salesPaid, billsPaid, salesReversed, billsReversed, salesReversalsWithheld, billsReversalsWithheld, errors }
}
