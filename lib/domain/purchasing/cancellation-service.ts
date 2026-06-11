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
  reversePurchaseOrderCostLayersForCancellation,
  type PurchaseOrderCostLayerReversal,
} from '@/lib/domain/purchasing/po-cancellation'
import { validatePurchaseOrderStatusTransition } from '@/lib/domain/workflows/action-guards'

const PURCHASE_ORDER_CANCELLATION_TX_OPTIONS = { maxWait: 5000, timeout: 20000 }

export type CancelPurchaseOrderResult = {
  success: boolean
  error?: string
  notice?: string
  reversedCostLayers?: PurchaseOrderCostLayerReversal[]
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

      const reversal = await deps.reversePurchaseOrderCostLayersForCancellation(tx, {
        poId: id,
        poReference: existing.reference,
        poLineIds: existing.lines.map((line) => line.id),
      })

      await tx.purchaseOrder.update({ where: { id }, data: { status: 'CANCELLED' } })

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

      return { alreadyCancelled: false as const, existing, reversal }
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

    return {
      success: true,
      reversedCostLayers: cancellation.reversal.reversedLayers,
      notice: cancellation.reversal.reversedLayers.length > 0
        ? `Cancelled PO and reversed ${cancellation.reversal.reversedLayers.length} remaining receipt cost layer(s).`
        : undefined,
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
