import { Prisma, type PurchaseOrderStatus } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { getAccountingSettings, queueAccountingSyncTx } from '@/lib/accounting'
import { accountingPayloadKey } from '@/lib/accounting/payload-key'
import { enqueueStockSync } from '@/lib/shopping'
import { roundQuantity } from '@/lib/domain/math/decimal'
import {
  assertPurchaseOrderCancellationHasNoInvoices,
  isPurchaseOrderCancellationNoop,
  readPurchaseOrderConsumedCostForCancellation,
  reversePurchaseOrderCostLayersForCancellation,
  type PurchaseOrderConsumedCostSummary,
  type PurchaseOrderCostLayerReversal,
} from '@/lib/domain/purchasing/po-cancellation'
import {
  recalculateLandedCosts,
  queueLandedCostAdjustmentJournals,
  type LandedCostRecalcResult,
} from '@/lib/domain/purchasing/landed-cost-service'
import { validatePurchaseOrderStatusTransition } from '@/lib/domain/workflows/action-guards'

const PURCHASE_ORDER_CANCELLATION_TX_OPTIONS = { maxWait: 5000, timeout: 20000 }

export type CancelPurchaseOrderResult = {
  success: boolean
  error?: string
  notice?: string
  reversedCostLayers?: PurchaseOrderCostLayerReversal[]
  /**
   * Cost of units already consumed (sold/used) from this PO before cancellation.
   * Their COGS stays booked against the cancelled receipt — surfaced so finance
   * can decide whether a correction is needed (audit-H8).
   */
  consumedCost?: PurchaseOrderConsumedCostSummary
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
  enqueueStockSync: typeof enqueueStockSync
  getAccountingSettings: typeof getAccountingSettings
  queueAccountingSyncTx: typeof queueAccountingSyncTx
  reversePurchaseOrderCostLayersForCancellation: typeof reversePurchaseOrderCostLayersForCancellation
  readPurchaseOrderConsumedCostForCancellation: typeof readPurchaseOrderConsumedCostForCancellation
  recalculateLandedCosts: typeof recalculateLandedCosts
  queueLandedCostAdjustmentJournals: typeof queueLandedCostAdjustmentJournals
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
  enqueueStockSync,
  getAccountingSettings,
  queueAccountingSyncTx,
  reversePurchaseOrderCostLayersForCancellation,
  readPurchaseOrderConsumedCostForCancellation,
  recalculateLandedCosts,
  queueLandedCostAdjustmentJournals,
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

export async function cancelPurchaseOrderService(
  id: string,
  deps: CancelPurchaseOrderServiceDeps = defaultCancelPurchaseOrderServiceDeps,
): Promise<CancelPurchaseOrderResult> {
  try {
    const cancellationDate = new Date().toISOString().slice(0, 10)

    const fastExisting = await deps.findPurchaseOrderFast(id)
    if (!fastExisting) throw new Error('PO not found')
    if (isPurchaseOrderCancellationNoop(fastExisting.status)) {
      await logPurchaseOrderCancellationNoop(deps, id, fastExisting.reference)
      return { success: true }
    }

    const cancellation = await deps.transaction(async (tx) => {
      const existing = await tx.purchaseOrder.findUnique({
        where: { id },
        select: {
          status: true,
          reference: true,
          type: true,
          lines: { select: { id: true } },
          _count: { select: { invoices: true } },
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
      assertPurchaseOrderCancellationHasNoInvoices(existing._count.invoices)

      const poLineIds = existing.lines.map((line) => line.id)

      // Read consumed cost BEFORE the reversal, otherwise the remaining quantity
      // it is about to zero out would be miscounted as already-consumed.
      const consumedCost = await deps.readPurchaseOrderConsumedCostForCancellation(tx, poLineIds)

      const reversal = await deps.reversePurchaseOrderCostLayersForCancellation(tx, {
        poId: id,
        poReference: existing.reference,
        poLineIds,
      })

      await tx.purchaseOrder.update({ where: { id }, data: { status: 'CANCELLED' } })

      // audit-C3: cancelling a FREIGHT PO must revert the landed-cost uplift it
      // applied to its linked primary POs. The status is now CANCELLED, so the
      // recalc (which excludes cancelled freight POs) re-derives each linked
      // primary's landedUnitCostBase + cost layers WITHOUT this freight, and
      // returns COGS deltas for already-consumed quantities. It throws if a
      // linked primary is in a locked (CLOSED) status — blocking the cancel.
      let landedCostRecalc: LandedCostRecalcResult | null = null
      if (existing.type === 'FREIGHT') {
        landedCostRecalc = await deps.recalculateLandedCosts(tx, id, undefined, {
          triggeredById: null,
          reason: 'freight_purchase_order_cancelled',
        })
      }

      if (reversal.totalReversalValueBase.gt(0.000001)) {
        const accountingSettings = await deps.getAccountingSettings()
        const amount = roundQuantity(reversal.totalReversalValueBase, 2).toNumber()
        if (accountingSettings.syncEnabled) {
          const payload = {
            date: cancellationDate,
            reference: `Cancel: ${existing.reference}`,
            narration: `Reverse received inventory for cancelled PO ${existing.reference}`,
            lines: [
              {
                accountCode: accountingSettings.transitAccount,
                description: `Reverse cancelled PO receipt ${existing.reference}`,
                debit: amount,
              },
              {
                accountCode: accountingSettings.inventoryAccount,
                description: `Reverse cancelled PO inventory ${existing.reference}`,
                credit: amount,
              },
            ],
          }
          await deps.queueAccountingSyncTx(tx, {
            type: 'INVENTORY_ADJUSTMENT',
            referenceType: 'PurchaseOrder',
            referenceId: id,
            payload,
            idempotencyKey: accountingPayloadKey(`purchase-order-cancel:${id}:cost-layer-reversal`, payload),
          })
        }
      }

      return { alreadyCancelled: false as const, existing, reversal, consumedCost, landedCostRecalc }
    }, PURCHASE_ORDER_CANCELLATION_TX_OPTIONS)

    if (cancellation.alreadyCancelled) {
      await logPurchaseOrderCancellationNoop(deps, id, cancellation.reference)
      return { success: true }
    }

    await deps.logActivity({
      entityType: 'PURCHASE_ORDER',
      entityId: id,
      action: 'cancelled',
      tag: 'purchase',
      level: 'INFO',
      description: cancellation.reversal.reversedLayers.length > 0
        ? `Cancelled PO ${cancellation.existing.reference} and reversed ${cancellation.reversal.reversedLayers.length} remaining cost layer(s)`
        : `Cancelled PO ${cancellation.existing.reference}`,
      metadata: {
        reference: cancellation.existing.reference,
        reversedCostLayers: cancellation.reversal.reversedLayers,
        totalReversalValueBase: roundQuantity(cancellation.reversal.totalReversalValueBase, 6).toString(),
      },
    })

    const consumedCost = cancellation.consumedCost
    if (Number(consumedCost.consumedQty) > 0) {
      // Isolate from the success path: the PO is already cancelled and committed,
      // so a log failure must not turn a successful cancellation into an error.
      try {
        await deps.logActivity({
          entityType: 'PURCHASE_ORDER',
          entityId: id,
          action: 'cancelled_consumed_cogs_standing',
          tag: 'purchase',
          level: 'WARNING',
          description: `Cancelled PO ${cancellation.existing.reference} with ${consumedCost.consumedQty} unit(s) already sold/used — ${consumedCost.consumedValueBase} of COGS (base currency) remains booked against the cancelled receipt. Review with finance.`,
          metadata: {
            reference: cancellation.existing.reference,
            consumedQty: consumedCost.consumedQty,
            consumedValueBase: consumedCost.consumedValueBase,
            consumedLayers: consumedCost.layers,
          },
        })
      } catch (consumedLogError) {
        console.error('Failed to log consumed-COGS warning:', consumedLogError)
      }
    }

    // audit-C3: queue the COGS-correction journals + log the per-primary
    // adjustments produced by reverting the freight PO's landed-cost uplift.
    // Isolated from the success path — the cancellation already committed.
    const landedCostRecalc = cancellation.landedCostRecalc
    if (landedCostRecalc) {
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

    if (cancellation.reversal.productIds.length > 0) {
      try {
        await deps.enqueueStockSync(cancellation.reversal.productIds, 'IMS_CHANGE')
      } catch (syncError) {
        const syncMessage = syncError instanceof Error ? syncError.message : String(syncError)
        console.error(syncError)
        await deps.logActivity({
          entityType: 'PURCHASE_ORDER',
          entityId: id,
          action: 'stock_sync_enqueue_failed',
          tag: 'sync',
          level: 'WARNING',
          description: `Cancelled PO ${cancellation.existing.reference}, but stock sync enqueue failed: ${syncMessage}`,
          metadata: {
            reference: cancellation.existing.reference,
            productIds: cancellation.reversal.productIds,
            error: syncMessage,
          },
        })
      }
    }

    const landedNotice = landedCostRecalc && landedCostRecalc.cogsAdjustments.length > 0
      ? `Reverted landed-cost uplift on ${landedCostRecalc.cogsAdjustments.length} linked PO(s) and queued COGS corrections.`
      : landedCostRecalc
        ? 'Reverted landed-cost uplift on linked PO(s).'
        : undefined
    return {
      success: true,
      reversedCostLayers: cancellation.reversal.reversedLayers,
      consumedCost,
      ...(landedCostRecalc ? { landedCostRecalc } : {}),
      notice: cancellation.reversal.reversedLayers.length > 0
        ? `Cancelled PO and reversed ${cancellation.reversal.reversedLayers.length} remaining receipt cost layer(s).`
        : landedNotice,
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
