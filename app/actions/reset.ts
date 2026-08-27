'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { lockIntegrationPluginSelection } from '@/lib/integration-plugin-selection-lock'
import { freshAuthFailureResult, requireFreshAdmin } from '@/lib/auth/server'
import { issueDestructiveActionCode, consumeDestructiveActionCode } from '@/lib/destructive-action-confirm'
import {
  countUnrecordedIncidents,
  describePreservedUnrecordedIncidents,
  UNRECORDED_POSTED_DOCUMENT_ACTIONS,
} from '@/lib/domain/accounting/unrecorded-posted-document'

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

  // A RESET CLEARS IMS. IT CANNOT CLEAR XERO — OR QUICKBOOKS (o3d-550x; Codex r3 medium, Codex HIGH).
  //
  // Everything else on this list describes something that lives in this database, so deleting it is the
  // whole point of a reset. The unrecorded-posted-document records do not: each one says AN EFFECT
  // LANDED OUTSIDE IMS and its sync row can never name it, and nothing in IMS can re-derive it. That is
  // the same sentence that earned them the retention exemption, and a factory reset is not a weaker
  // eraser than a 90-day sweep; it is a stronger one.
  //
  // "AN EFFECT", NOT "A DOCUMENT" — round 3, Codex MEDIUM. Folding the pair into one exemption made
  // the breadcrumb speak for both action names at once, and it kept the Xero sentence: every preserved
  // row was described as a document still standing in a ledger. The QuickBooks action does not mean
  // only that. The same name covers the four no-identifier operations in
  // lib/domain/accounting/unrecorded-posted-document.ts — a bill attachment, a stored invoice PDF, an
  // invoice email QUEUED to a customer, a WooCommerce note — none of which is a ledger document and
  // one of which is not even finished.
  //
  // AND ROUND 3'S ANSWER TO THAT WAS A HEDGE, NOT A FIX (round 6, Codex MEDIUM). It replaced the one
  // false sentence with "THEY ARE NOT ALL LEDGER DOCUMENTS. Some name a document … The rest name an
  // effect …" over a SINGLE count. That is true of the set and useless about any member of it: an
  // install whose only preserved incident is a queued INVOICE_EMAIL still got a paragraph asserting
  // that some of them are documents standing in a ledger, when none of them is — and this breadcrumb
  // is exempt from retention and from the reset, so it is permanent evidence for a document that
  // never existed. The record's own `metadata.type` is what settles it, and BOTH connectors write
  // that field, so the counts below are classified rather than aggregated: a kind with nothing in it
  // now emits no sentence at all. A row whose type cannot be read is counted as UNCLASSIFIED and
  // never guessed into either bucket.
  //
  // BOTH ACTIONS, FROM THE ONE PLACE THE PAIR IS NAMED. This exemption originally spelled out a single
  // constant — the Xero one — and read as complete: it compiled, its test passed, and the sentence
  // above was true of it. It was simply blind to the QuickBooks twin, whose incidents carry their own
  // action name, so every `quickbooks_posted_document_unrecorded` row was deleted by the `not` on the
  // other string. That record is the ONLY thing naming a document QuickBooks accepted and IMS could
  // not write down, so the reset was destroying evidence of live remote money while reporting that it
  // had preserved it. The fix is not "add the other string here" — it is to import the pair, so the
  // next connector to grow one of these is protected by an edit in a single module rather than by
  // somebody remembering this line exists.
  //
  // An earlier answer was that the reset "deletes the sync rows too", so the record has nothing left to
  // point at. Read the other way round, that is the argument FOR keeping it: after the reset there is no
  // sync row, no accounting event and no external id anywhere in IMS, so this row is not one of several
  // traces of the document — it is the only one that ever existed, and the wording is self-contained
  // (both ids, the reference it was for, and what to do about it), so it still means exactly what it
  // meant before the rest of the row's world was deleted.
  //
  // The direct-create marker, the exemption's other half, is deliberately NOT kept: it is an open
  // obligation about a sales order that this reset is deleting, so the thing it asks for cannot be done
  // and nothing is lost by discharging it.
  //
  // WHERE AN OPERATOR SEES IT AFTERWARDS: /activity — filter level ERROR or tag `sync`, or search for
  // either action name or any of the ledger ids; the description is the full incident and its remedy.
  // The breadcrumb below puts the count in the same list so nobody has to know to look, and it names
  // BOTH actions because a breadcrumb that names one is the same defect as an exemption that does.
  await db.activityLog.deleteMany({ where: { action: { notIn: [...UNRECORDED_POSTED_DOCUMENT_ACTIONS] } } })
  // findMany, not count: the breadcrumb can no longer be written from an integer, because which
  // sentence each row earns is decided by its own metadata. The population is bounded by what
  // survived the delete above — incidents this rare are units, not pages.
  const preservedRows = await db.activityLog.findMany({
    where: { action: { in: [...UNRECORDED_POSTED_DOCUMENT_ACTIONS] } },
    select: { metadata: true },
  })
  if (preservedRows.length > 0) {
    const counts = countUnrecordedIncidents(preservedRows)
    await logActivity({
      entityType: 'SYSTEM',
      tag: 'sync',
      action: 'database_reset_preserved_unrecorded_documents',
      level: 'WARNING',
      description: describePreservedUnrecordedIncidents(counts),
      metadata: {
        preserved: preservedRows.length,
        ledgerDocuments: counts.LEDGER_DOCUMENT,
        ledgerNonDocuments: counts.LEDGER_NON_DOCUMENT,
        noIdentifierSideEffects: counts.NO_IDENTIFIER_SIDE_EFFECT,
        unclassified: counts.UNCLASSIFIED,
        actions: [...UNRECORDED_POSTED_DOCUMENT_ACTIONS],
      },
    })
  }

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
