'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'

export type ResetLevel = 'transactions' | 'products' | 'full'

export async function resetDatabase(level: ResetLevel): Promise<{ success: boolean; error?: string }> {
  try {
    // Level 1: Transactions only (orders, POs, stock movements, invoices, payments)
    // Keeps products, warehouses, suppliers, customers, settings
    if (level === 'transactions' || level === 'products' || level === 'full') {
      // Delete in dependency order (children first)
      await db.payment.deleteMany({})
      await db.cogsEntry.deleteMany({})
      await db.costLayer.deleteMany({})
      await db.stockMovement.deleteMany({})

      // Sales
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

      // Stock
      await db.stockLevel.deleteMany({})
      await db.stockTransferLine.deleteMany({})
      await db.stockTransfer.deleteMany({})

      // Sync logs
      await db.wcSyncLog.deleteMany({})
      await db.xeroSyncLog.deleteMany({})
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
      await db.setting.deleteMany({})
      await db.warehouse.deleteMany({})
      await db.organisation.deleteMany({})
      // Keep users — don't lock yourself out
    }

    revalidatePath('/')
    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}
