'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { lockIntegrationPluginSelection } from '@/lib/integration-plugin-selection-lock'
import { freshAuthFailureResult, requireFreshAdmin } from '@/lib/auth/server'
import { issueDestructiveActionCode, consumeDestructiveActionCode } from '@/lib/destructive-action-confirm'

export type ResetLevel = 'transactions' | 'products' | 'full'

const WC_ORDER_SYNC_STATE_KEYS = [
  'wc_initial_import_completed',
  'last_wc_order_sync_at',
  'last_wc_order_reconcile_at',
  'wc_order_webhook_last_received_at',
  'wc_webhook_last_received_at',
] as const

const WC_PRODUCT_SYNC_STATE_KEYS = [
  'last_wc_product_sync_at',
  'last_wc_product_reconcile_at',
  'wc_product_webhook_last_received_at',
  'wc_webhook_last_received_at',
] as const

async function clearSettingKeys(keys: readonly string[]) {
  await db.setting.deleteMany({
    where: {
      key: { in: [...keys] },
    },
  })
}

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
  await db.integrationOutbox.deleteMany({})
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

  // Reset WooCommerce transaction intake state so orders can be imported from
  // scratch after a transaction reset.
  await clearSettingKeys(WC_ORDER_SYNC_STATE_KEYS)
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

  // Reset WooCommerce product intake state so a fresh catalog import does not
  // reuse stale cursors from before the reset.
  await clearSettingKeys(WC_PRODUCT_SYNC_STATE_KEYS)
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

  // Core company configuration / reference data
  await db.purchaseUnit.deleteMany({})
  await db.fxRate.deleteMany({})
  await db.currency.deleteMany({})
  await db.taxRate.deleteMany({})
  await db.adjustmentReason.deleteMany({})
  await db.documentTemplate.deleteMany({})
  // THE TWO HALVES OF A CONNECTOR BINDING GO TOGETHER — ONE TRANSACTION, PIN BEFORE TOKEN (o3d-9tbz r7).
  //
  // A binding is two rows in two tables: the token in `accounting_tokens`, and the
  // `xero_expected_tenant_id` pin in `settings`. Since r6 the sync READS ONE AS EVIDENCE ABOUT THE
  // OTHER — a token row carrying a connection generation with no pin beside it means the pin was
  // removed on its own, so the binding is unverifiable and every Xero sync halts, with a message about
  // restored backups and hand-run deletes. That inference is only sound while every writer moves both
  // halves together, and this one did not: the token was deleted six statements earlier, outside the
  // transaction that deleted the settings.
  //
  // A reset cannot be told from tampering by a MARKER — a marker is a thing the tamper case can arrive
  // carrying too. What distinguishes it is that a reset removes BOTH halves, so it leaves no token row
  // for the halt to ask about. Two things make that true of every interleaving, not just the quiet one:
  //
  //   ONE TRANSACTION, so a failure between the two deletes cannot commit half of it.
  //   THE PIN FIRST, because under READ COMMITTED each statement takes its OWN snapshot, and a
  //   concurrent OAuth callback can still commit a whole binding between them. Deleting the pin first
  //   makes every outcome a safe one. If the callback committed early enough for the wipe to take its
  //   pin, it committed early enough for the delete below to take its token as well, so both go. If it
  //   commits after the wipe, its pin survives; its token then either survives with it (a row inserted
  //   after the delete's snapshot is outside it) or is deleted, leaving a PIN WITH NO TOKEN — an
  //   instance that reports "not connected" and is repaired by connecting again, not one that halts.
  //   The old order guaranteed the opposite and only the opposite: the callback's pin was always the
  //   one wiped and its token always the one left behind, which is exactly the state the halt refuses,
  //   reported to an operator who had done nothing but reset a database.
  //
  // Still under the plugin-selection lock: deleting the settings rows deletes the plugin_* rows, which
  // is a connector change (to "none") for anything reading them — the third of the three real bypasses
  // the orphan-cancel sweep's row locks had to fence (o3d-osl8 round 6, finding 2). A concurrent cancel
  // then either commits before this or waits for it, instead of deciding what to discard from a
  // selection this is deleting underneath it.
  await db.$transaction(async (tx) => {
    await lockIntegrationPluginSelection(tx)
    await tx.setting.deleteMany({})
    await tx.accountingToken.deleteMany({})
  })
  await db.warehouse.deleteMany({})
  await db.organisation.deleteMany({})
}

export async function sendDatabaseResetCode(): Promise<{ success: boolean; email?: string; expiresInSec?: number; error?: string; code?: string; reason?: string }> {
  try {
    const session = await requireFreshAdmin()
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
    const freshAuthFailure = freshAuthFailureResult(e)
    if (freshAuthFailure) return freshAuthFailure
    return { success: false, error: String(e) }
  }
}

export async function resetDatabase(level: ResetLevel, confirmationCode: string): Promise<{ success: boolean; error?: string; code?: string; reason?: string }> {
  try {
    const session = await requireFreshAdmin()
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
    const freshAuthFailure = freshAuthFailureResult(e)
    if (freshAuthFailure) return freshAuthFailure
    await logActivity({ entityType: 'SYSTEM', tag: 'system', action: 'database_reset', level: 'ERROR', description: `Failed to reset database: ${String(e)}` })
    return { success: false, error: String(e) }
  }
}
