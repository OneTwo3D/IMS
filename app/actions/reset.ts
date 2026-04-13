'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requireAdmin } from '@/lib/auth/server'

export type ResetLevel = 'transactions' | 'products' | 'full'

export async function resetDatabase(level: ResetLevel): Promise<{ success: boolean; error?: string }> {
  try {
    await requireAdmin()
    // Level 1: Transactions only (orders, POs, stock movements, invoices, payments)
    // Keeps products, warehouses, suppliers, customers, settings
    if (level === 'transactions' || level === 'products' || level === 'full') {
      // Delete in dependency order (children first)
      await db.payment.deleteMany({})
      await db.cogsEntry.deleteMany({})
      await db.costLayer.deleteMany({})
      await db.stockMovement.deleteMany({})

      // Sales — shipments and allocations before orders
      await db.shipmentLine.deleteMany({})
      await db.shipment.deleteMany({})
      await db.orderAllocation.deleteMany({})
      await db.salesOrderRefundLine.deleteMany({})
      await db.salesOrderRefund.deleteMany({})
      await db.salesOrderLine.deleteMany({})
      await db.salesOrder.deleteMany({})

      // Purchases
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

      // Manufacturing
      await db.productionOrder.deleteMany({})

      // Stock
      await db.stockLevel.deleteMany({})
      await db.stockTransferLine.deleteMany({})
      await db.stockTransfer.deleteMany({})
      await db.stockCountLine.deleteMany({})
      await db.stockCount.deleteMany({})

      // Notifications
      await db.notificationReadReceipt.deleteMany({})
      await db.notification.deleteMany({})

      // Sync logs
      await db.wcSyncLog.deleteMany({})
      await db.accountingSyncLog.deleteMany({})
      await db.activityLog.deleteMany({})
    }

    // Level 2: Products (includes BOMs, kits, variants, supplier products)
    if (level === 'products' || level === 'full') {
      await db.supplierProduct.deleteMany({})
      await db.productComponent.deleteMany({})
      await db.productOption.deleteMany({})
      await db.bomItem.deleteMany({})
      await db.kitItem.deleteMany({})
      // Delete variants first, then parents
      await db.product.deleteMany({ where: { type: 'VARIANT' } })
      await db.product.deleteMany({})

      // Also clear BOMs, kits
      await db.bom.deleteMany({})
      await db.kit.deleteMany({})

      // Suppliers and customers
      await db.supplier.deleteMany({})
      await db.customer.deleteMany({})
    }

    // Level 3: Full reset (everything including settings, users, warehouses)
    if (level === 'full') {
      await db.purchaseUnit.deleteMany({})
      await db.fxRate.deleteMany({})
      await db.currency.deleteMany({})
      await db.taxRate.deleteMany({})
      await db.adjustmentReason.deleteMany({})
      await db.wcStatusMapping.deleteMany({})
      await db.wcTaxRateMapping.deleteMany({})
      await db.xeroAccount.deleteMany({})
      await db.xeroToken.deleteMany({})
      await db.documentTemplate.deleteMany({})
      await db.setting.deleteMany({})
      await db.warehouse.deleteMany({})
      await db.organisation.deleteMany({})
      // Keep users, sessions, passkeys — don't lock yourself out
    }

    revalidatePath('/')
    await logActivity({ entityType: 'SYSTEM', tag: 'system', action: 'database_reset', level: 'WARNING', description: `Database reset: ${level} (transactions/products/full)` })
    return { success: true }
  } catch (e) {
    await logActivity({ entityType: 'SYSTEM', tag: 'system', action: 'database_reset', level: 'ERROR', description: `Failed to reset database: ${String(e)}` })
    return { success: false, error: String(e) }
  }
}
