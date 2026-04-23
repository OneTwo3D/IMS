'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requireAdmin } from '@/lib/auth/server'
import { issueDestructiveActionCode, consumeDestructiveActionCode } from '@/lib/destructive-action-confirm'

export type ResetLevel = 'transactions' | 'products' | 'full'

// IMPORTANT:
// Keep this reset coverage in sync with prisma/schema.prisma. When models are
// added, removed, or relationships change, update the relevant reset scope
// below so the three UI options continue to match their labels.

async function clearTransactionScope() {
  // Email / notifications / transient operational state
  await db.emailOutbox.deleteMany({})
  await db.notificationReadReceipt.deleteMany({})
  await db.notification.deleteMany({})

  // WMS operational state and history
  await db.wmsReturnsInbox.deleteMany({})
  await db.wmsInboundReceiptEvent.deleteMany({})
  await db.wmsStockDiscrepancy.deleteMany({})
  await db.wmsStockSnapshot.deleteMany({})
  await db.wmsSyncLog.deleteMany({})
  await db.wmsSyncJob.deleteMany({})
  await db.wmsAsnLineMap.deleteMany({})
  await db.wmsAsnMap.deleteMany({})

  // Generic stock sync operational state
  await db.stockSyncJob.deleteMany({})
  await db.stockSyncState.deleteMany({})

  // Stock valuation / ledger
  await db.payment.deleteMany({})
  await db.cogsEntry.deleteMany({})
  await db.costLayerSourceLine.deleteMany({})
  await db.costLayer.deleteMany({})
  await db.stockMovement.deleteMany({})

  // Sales
  await db.shipmentLine.deleteMany({})
  await db.shipment.deleteMany({})
  await db.orderAllocation.deleteMany({})
  await db.salesOrderRefundLine.deleteMany({})
  await db.salesOrderRefund.deleteMany({})
  await db.salesOrderLine.deleteMany({})
  await db.salesOrder.deleteMany({})

  // Purchasing
  await db.purchaseReturnLine.deleteMany({})
  await db.purchaseReturn.deleteMany({})
  await db.purchaseInvoiceLine.deleteMany({})
  await db.purchaseInvoice.deleteMany({})
  await db.purchaseReceiptLine.deleteMany({})
  await db.purchaseReceipt.deleteMany({})
  await db.freightCostLine.deleteMany({})
  await db.landedCostLink.deleteMany({})
  await db.purchaseOrderLine.deleteMany({})
  await db.purchaseOrder.deleteMany({})

  // Manufacturing / warehouse ops
  await db.productionOrder.deleteMany({})
  await db.stockLevel.deleteMany({})
  await db.stockTransferLine.deleteMany({})
  await db.stockTransfer.deleteMany({})
  await db.stockCountLine.deleteMany({})
  await db.stockCount.deleteMany({})

  // Sync / audit history
  await db.shoppingSyncLog.deleteMany({})
  await db.accountingSyncLog.deleteMany({})
  await db.activityLog.deleteMany({})
}

async function clearProductScope() {
  // Product-connected integration mappings
  await db.wmsProductLink.deleteMany({})
  await db.wmsBundleLink.deleteMany({})
  await db.shoppingProductLink.deleteMany({})
  await db.shoppingCustomerLink.deleteMany({})

  // Product master data
  await db.supplierProduct.deleteMany({})
  await db.productComponent.deleteMany({})
  await db.productOption.deleteMany({})
  await db.bomItem.deleteMany({})
  await db.kitItem.deleteMany({})

  // Delete variants first, then parents
  await db.product.deleteMany({ where: { type: 'VARIANT' } })
  await db.product.deleteMany({})

  await db.bom.deleteMany({})
  await db.kit.deleteMany({})

  // Preserve user accounts by detaching any supplier-portal users before
  // deleting supplier records.
  await db.user.updateMany({
    where: { supplierId: { not: null } },
    data: { supplierId: null },
  })

  await db.supplier.deleteMany({})
  await db.customer.deleteMany({})

  // Customer/supplier email hygiene should not survive once those master
  // records have been cleared.
  await db.emailSuppression.deleteMany({})
}

async function clearFullScope() {
  // Auth/session state not part of the user account record itself
  await db.oneTimeToken.deleteMany({})
  await db.session.deleteMany({})

  // Connector / integration configuration and mappings
  await db.shoppingStatusMapping.deleteMany({})
  await db.shoppingTaxRateMapping.deleteMany({})
  await db.externalWmsBinding.deleteMany({})
  await db.wmsConnection.deleteMany({})
  await db.accountingAccount.deleteMany({})
  await db.accountingToken.deleteMany({})

  // Core company configuration / reference data
  await db.purchaseUnit.deleteMany({})
  await db.fxRate.deleteMany({})
  await db.currency.deleteMany({})
  await db.taxRate.deleteMany({})
  await db.adjustmentReason.deleteMany({})
  await db.documentTemplate.deleteMany({})
  await db.setting.deleteMany({})
  await db.warehouse.deleteMany({})
  await db.organisation.deleteMany({})
}

export async function sendDatabaseResetCode(): Promise<{ success: boolean; email?: string; expiresInSec?: number; error?: string }> {
  try {
    const session = await requireAdmin()
    const email = session.user.email
    const issued = await issueDestructiveActionCode({
      purpose: 'database_reset',
      userId: session.user.id,
      email,
      subject: 'Database reset confirmation code',
      intro: 'A database reset was requested from the onetwoInventory Settings page.',
    })
    if (!issued.success) return { success: false, error: issued.error }
    return { success: true, email: issued.email, expiresInSec: issued.expiresInSec }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

export async function resetDatabase(level: ResetLevel, confirmationCode: string): Promise<{ success: boolean; error?: string }> {
  try {
    const session = await requireAdmin()
    if (!confirmationCode || confirmationCode.trim().length < 6) {
      return { success: false, error: 'Email confirmation code is required.' }
    }
    const confirmed = await consumeDestructiveActionCode({
      purpose: 'database_reset',
      token: confirmationCode,
      userId: session.user.id,
    })
    if (!confirmed) {
      return { success: false, error: 'Email confirmation code is invalid or expired.' }
    }

    if (level === 'transactions' || level === 'products' || level === 'full') {
      await clearTransactionScope()
    }

    if (level === 'products' || level === 'full') {
      await clearProductScope()
    }

    if (level === 'full') {
      await clearFullScope()
    }

    revalidatePath('/')
    if (level !== 'full') {
      await logActivity({ entityType: 'SYSTEM', tag: 'system', action: 'database_reset', level: 'WARNING', description: `Database reset: ${level} (transactions/products/full)` })
    }
    return { success: true }
  } catch (e) {
    await logActivity({ entityType: 'SYSTEM', tag: 'system', action: 'database_reset', level: 'ERROR', description: `Failed to reset database: ${String(e)}` })
    return { success: false, error: String(e) }
  }
}
