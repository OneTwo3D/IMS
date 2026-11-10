import { Prisma, type PurchaseOrderStatus } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import {
  evaluatePurchaseOrderCancellationInvoiceGate,
  isPurchaseOrderCancellationNoop,
} from '@/lib/domain/purchasing/po-cancellation'
import {
  describeBilledAhead,
  describeRetireOutcome,
  retirePurchaseOrderLocked,
  settleCloseShortRevaluation,
  type RetireOutcome,
} from '@/lib/domain/purchasing/po-close-short'
import {
  recalculateLandedCosts,
  queueLandedCostAdjustmentJournals,
  logLandedCostCreditFloorActivities,
  type LandedCostRecalcResult,
} from '@/lib/domain/purchasing/landed-cost-service'
import { validatePurchaseOrderStatusTransition } from '@/lib/domain/workflows/action-guards'
import { lockLandedCostRevaluationScope } from '@/lib/domain/wms/transfer-asn-lock-order'
import { supplierCreditNoteAmountBase } from '@/lib/domain/purchasing/supplier-credit-note-amount'

const PURCHASE_ORDER_CANCELLATION_TX_OPTIONS = { maxWait: 5000, timeout: 20000 }

export type CancelPurchaseOrderResult = {
  success: boolean
  error?: string
  notice?: string
  /**
   * True when the order had received goods: the cancel closed it short (status CLOSED), the unreceived balance was dropped and
   * the received stock, its quantities and its cost layers were left alone.
   */
  closedShort?: boolean
  /** Non-blocking finance warnings (e.g. billed ahead of receipt). */
  warnings?: string[]
  /**
   * When a FREIGHT PO is cancelled, the landed-cost uplift it applied to linked
   * primary POs is reverted (line landedUnitCostBase + cost layers recalculated
   * excluding it) and COGS-correction journals are queued for consumed quantities
   * (audit-C3).
   */
  landedCostRecalc?: LandedCostRecalcResult
}

export type CancelPurchaseOrderServiceDeps = {
  findPurchaseOrderFast(id: string): Promise<{ status: PurchaseOrderStatus; reference: string } | null>
  transaction<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    options: typeof PURCHASE_ORDER_CANCELLATION_TX_OPTIONS,
  ): Promise<T>
  logActivity: typeof logActivity
  /** GOODS orders: drop the unreceived balance under the already-held PO lock (po-close-short.ts). */
  retirePurchaseOrderLocked: typeof retirePurchaseOrderLocked
  recalculateLandedCosts: typeof recalculateLandedCosts
  queueLandedCostAdjustmentJournals: typeof queueLandedCostAdjustmentJournals
  /** o3d-nrl4 PR A: the freight-cancellation scope lock. Optional so a fake-tx unit test need not name it. */
  lockLandedCostRevaluationScope?: typeof lockLandedCostRevaluationScope
}

// Production dependencies are captured at module load; tests that need
// alternate behavior should pass explicit deps to cancelPurchaseOrderService().
const defaultCancelPurchaseOrderServiceDeps: CancelPurchaseOrderServiceDeps = {
  findPurchaseOrderFast: (id) => db.purchaseOrder.findUnique({
    where: { id },
    select: { status: true, reference: true },
  }),
  transaction: (fn, options) => db.$transaction(fn, options),
  logActivity,
  retirePurchaseOrderLocked,
  recalculateLandedCosts,
  queueLandedCostAdjustmentJournals,
  lockLandedCostRevaluationScope,
}

async function logPurchaseOrderCancellationNoop(
  deps: Pick<CancelPurchaseOrderServiceDeps, 'logActivity'>,
  id: string,
  reference: string,
): Promise<void> {
  await deps.logActivity({
    entityType: 'PURCHASE_ORDER',
    entityId: id,
    action: 'cancelled_noop',
    tag: 'purchase',
    level: 'INFO',
    description: `Cancellation requested on already-cancelled PO ${reference}`,
    metadata: { reference },
  })
}

/**
 * A credit note's base amount for the cancellation gate. Credit notes recorded before the exchange-rate direction fix
 * stored `amountBase` MULTIPLIED by the rate (foreign x rate instead of foreign / rate) and are not corrected
 * retrospectively, so the gate does not trust the stored base: it recomputes it from the stored foreign amount and
 * rate (divide) whenever both are usable, and falls back to the stored base only when the rate is unusable.
 */
export function creditNoteBaseForGate(cn: { amountBase: unknown; amountForeign: unknown; fxRateToBase: unknown }): number {
  try {
    return supplierCreditNoteAmountBase(String(cn.amountForeign), String(cn.fxRateToBase)).toNumber()
  } catch {
    return Number(cn.amountBase)
  }
}

export async function cancelPurchaseOrderService(
  id: string,
  deps: CancelPurchaseOrderServiceDeps = defaultCancelPurchaseOrderServiceDeps,
): Promise<CancelPurchaseOrderResult> {
  try {
    const fastExisting = await deps.findPurchaseOrderFast(id)
    if (!fastExisting) throw new Error('PO not found')
    if (isPurchaseOrderCancellationNoop(fastExisting.status)) {
      await logPurchaseOrderCancellationNoop(deps, id, fastExisting.reference)
      return { success: true }
    }

    const cancellation = await deps.transaction(async (tx) => {
      // audit-g5u2.4 (Codex review): lock the PO before reading the invoice/credit
      // gate state so a concurrent bill create/credit-note post can't change the
      // predicate between the read and the status write. createInvoice takes the
      // same row lock, so the two serialise. The same lock orders this against a receipt: whichever takes the row
      // first, the other re-reads under it (a receipt after a cancel is refused by its in-transaction status check; a
      // cancel after a receipt sees the landed quantity and closes short).
      //
      // o3d-nrl4 PR A (closes o3d-t3mbr for this caller): a FREIGHT cancellation runs
      // `recalculateLandedCosts` below, which rewrites every linked primary's lines, cost layers and
      // snapshots (including in-transit transfer lines), and used to lock only this parent. It now takes
      // the whole revaluation scope in the global order (transfers, then this order and the primaries with
      // their cost rows, then the cost layers) and refuses with LandedCostScopeRacedError if the scope grew
      // while it was locking. The type is immutable, so reading it before the lock is safe; every other
      // read waits for the lock. A GOODS cancellation keeps its parent-only lock (it recalculates nothing).
      const typeProbe = await tx.purchaseOrder.findUnique({ where: { id }, select: { type: true } })
      if (typeProbe?.type === 'FREIGHT') {
        await (deps.lockLandedCostRevaluationScope ?? lockLandedCostRevaluationScope)(tx, { freightPoId: id })
      } else {
        // A GOODS order takes the whole revaluation scope too (transfers, the order with its lines and cost lines, then its cost
        // layers and everything downstream): a part-received order with freight is closed short by reallocating the unreceived
        // freight share onto the received units, which revalues those layers. The scope lock also takes the order row first.
        await (deps.lockLandedCostRevaluationScope ?? lockLandedCostRevaluationScope)(tx, { primaryPoIds: [id] })
      }
      const existing = await tx.purchaseOrder.findUnique({
        where: { id },
        select: {
          status: true,
          reference: true,
          type: true,
          // Base-currency totals are the GL predicate; per-bill credit attribution
          // prevents a credit for one bill satisfying another (Codex review).
          invoices: { select: { id: true, totalBase: true } },
          supplierCreditNotes: { where: { status: 'POSTED' }, select: { purchaseInvoiceId: true, amountBase: true, amountForeign: true, fxRateToBase: true } },
        },
      })
      if (!existing) throw new Error('PO not found')
      if (isPurchaseOrderCancellationNoop(existing.status)) {
        return {
          alreadyCancelled: true as const,
          reference: existing.reference,
        }
      }
      const transition = validatePurchaseOrderStatusTransition(existing.status, 'CANCELLED')
      if (!transition.success) throw new Error(transition.error)

      // audit-g5u2.4: allow cancelling a FREIGHT PO whose bills are EACH fully offset
      // by POSTED supplier credit notes linked to that bill; otherwise the gate blocks.
      const runInvoiceGate = () => {
        const creditedBaseByInvoice = new Map<string, number>()
        for (const cn of existing.supplierCreditNotes) {
          if (!cn.purchaseInvoiceId) continue // unattributed credits don't offset a specific bill
          creditedBaseByInvoice.set(cn.purchaseInvoiceId, (creditedBaseByInvoice.get(cn.purchaseInvoiceId) ?? 0) + creditNoteBaseForGate(cn))
        }
        const invoiceGate = evaluatePurchaseOrderCancellationInvoiceGate({
          isFreight: existing.type === 'FREIGHT',
          invoices: existing.invoices.map((inv) => ({
            totalBase: Number(inv.totalBase),
            creditedBase: creditedBaseByInvoice.get(inv.id) ?? 0,
          })),
        })
        if (!invoiceGate.allowed) throw new Error(invoiceGate.reason ?? 'Cannot cancel this purchase order.')
      }

      if (existing.type !== 'FREIGHT') {
        // GOODS. Nothing landed: a plain cancel (CANCELLED), refused while a supplier bill exists. Something landed: the
        // owner's ruling is that cancel behaves like close-short — the unreceived balance is dropped, the received stock
        // and its cost stay, the order ends CLOSED, and nothing is reversed, so no bill is orphaned and the gate does not
        // apply. A live warehouse ASN refuses either way.
        const retired = await deps.retirePurchaseOrderLocked(tx, id, 'cancel', ({ keptReceivedStock }) => {
          if (!keptReceivedStock) runInvoiceGate()
        })
        return { alreadyCancelled: false as const, existing, retired, landedCostRecalc: null as LandedCostRecalcResult | null }
      }

      // FREIGHT. Nothing to keep or drop on the order itself; the cancel reverts the landed-cost uplift it applied to its
      // linked primary orders.
      runInvoiceGate()
      await tx.purchaseOrder.update({ where: { id }, data: { status: 'CANCELLED' } })

      // audit-C3: cancelling a FREIGHT PO must revert the landed-cost uplift it
      // applied to its linked primary POs. The status is now CANCELLED, so the
      // recalc (which excludes cancelled freight POs) re-derives each linked
      // primary's landedUnitCostBase + cost layers WITHOUT this freight, and
      // returns COGS deltas for already-consumed quantities. It throws if a
      // linked primary is in a locked (CLOSED) status — blocking the cancel.
      const landedCostRecalc = await deps.recalculateLandedCosts(tx, id, undefined, {
        triggeredById: null,
        reason: 'freight_purchase_order_cancelled',
        scheduleAdjustmentJournals: true, // audit-grob durable backstop
      })
      return { alreadyCancelled: false as const, existing, retired: null as RetireOutcome | null, landedCostRecalc }
    }, PURCHASE_ORDER_CANCELLATION_TX_OPTIONS)

    if (cancellation.alreadyCancelled) {
      await logPurchaseOrderCancellationNoop(deps, id, cancellation.reference)
      return { success: true }
    }

    const retired = cancellation.retired
    const warnings: string[] = []
    if (retired) {
      const billedAheadWarning = describeBilledAhead(retired.billedAhead)
      if (billedAheadWarning) warnings.push(billedAheadWarning)
      warnings.push(...await settleCloseShortRevaluation(retired.landedCostRecalc, retired, id, {
        logActivity: deps.logActivity,
        queueLandedCostAdjustmentJournals: deps.queueLandedCostAdjustmentJournals,
      }))
      await deps.logActivity({
        entityType: 'PURCHASE_ORDER',
        entityId: id,
        action: retired.keptReceivedStock ? 'cancelled_closed_short' : 'cancelled',
        tag: 'purchase',
        level: 'INFO',
        description: describeRetireOutcome(retired, 'cancel'),
        metadata: {
          reference: retired.reference,
          previousStatus: retired.previousStatus,
          newStatus: retired.newStatus,
          keptReceivedStock: retired.keptReceivedStock,
          receivedQty: retired.landedQty,
          droppedQty: retired.droppedQty,
        },
      })
      if (billedAheadWarning) {
        try {
          await deps.logActivity({
            entityType: 'PURCHASE_ORDER',
            entityId: id,
            action: 'closed_billed_ahead_of_receipt',
            tag: 'purchase',
            level: 'WARNING',
            description: `${retired.reference}: ${billedAheadWarning}`,
            metadata: { reference: retired.reference, lines: retired.billedAhead },
          })
        } catch (logError) {
          console.error('Failed to log billed-ahead warning:', logError)
        }
      }
    } else {
      await deps.logActivity({
        entityType: 'PURCHASE_ORDER',
        entityId: id,
        action: 'cancelled',
        tag: 'purchase',
        level: 'INFO',
        description: `Cancelled PO ${cancellation.existing.reference}`,
        metadata: { reference: cancellation.existing.reference },
      })
    }

    // audit-C3: queue the COGS-correction journals + log the per-primary
    // adjustments produced by reverting the freight PO's landed-cost uplift.
    // Isolated from the success path — the cancellation already committed.
    const landedCostRecalc = cancellation.landedCostRecalc
    if (landedCostRecalc) {
      // Cancelling freight can move a floored layer too; the durable WARNING is written after the commit.
      await logLandedCostCreditFloorActivities(landedCostRecalc)
      try {
        await deps.queueLandedCostAdjustmentJournals(landedCostRecalc)
      } catch (journalError) {
        console.error('Failed to queue landed-cost reversal journals on freight cancel:', journalError)
      }
      for (const adj of landedCostRecalc.cogsAdjustments) {
        try {
          await deps.logActivity({
            entityType: 'PURCHASE_ORDER',
            entityId: adj.primaryPoId,
            action: 'cogs_adjusted',
            tag: 'purchase',
            level: 'INFO',
            description: `Retrospective COGS correction of £${adj.totalDelta.toFixed(2)} for ${adj.primaryPoRef} after cancelling freight PO ${cancellation.existing.reference}`,
            metadata: { totalDelta: adj.totalDelta, freightPoId: id, freightReference: cancellation.existing.reference },
          })
        } catch (logError) {
          console.error('Failed to log freight-cancel COGS adjustment:', logError)
        }
      }
    }

    const landedNotice = landedCostRecalc && landedCostRecalc.cogsAdjustments.length > 0
      ? `Reverted landed-cost uplift on ${landedCostRecalc.cogsAdjustments.length} linked PO(s) and queued COGS corrections.`
      : landedCostRecalc
        ? 'Reverted landed-cost uplift on linked PO(s).'
        : undefined
    const notice = [retired ? describeRetireOutcome(retired, 'cancel') : undefined, landedNotice].filter(Boolean).join(' ') || undefined
    return {
      success: true,
      ...(retired?.keptReceivedStock ? { closedShort: true } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(landedCostRecalc ? { landedCostRecalc } : {}),
      notice,
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    await deps.logActivity({
      entityType: 'PURCHASE_ORDER',
      entityId: id,
      action: 'cancelled',
      tag: 'purchase',
      level: 'ERROR',
      description: `Failed to cancel PO ${id}: ${message}`,
      metadata: null,
    })
    return { success: false, error: message }
  }
}
