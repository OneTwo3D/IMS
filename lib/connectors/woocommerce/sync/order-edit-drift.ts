/**
 * AN ORDER EDITED IN WOOCOMMERCE AFTER IMPORT IS SURFACED, NOT DROPPED (o3d-hqvrp.84).
 *
 * The update path of `importWcOrder` refreshes addresses, notes and paid state and never rebuilds an order's
 * lines or total (allocation, the warehouse push and the invoice were all built from them). Re-syncing an edit
 * is a design question of its own: allocations, shipments, the posted invoice and the warehouse order all hang
 * off the lines. What was missing was any TRACE: a swapped size, an added item or a changed quantity left no
 * activity row, exception or review state, and IMS went on shipping and invoicing the original content.
 *
 * So the safe minimum: every delivery for a held order compares the payload's goods lines (WooCommerce line
 * id and quantity) and total with what IMS holds. A difference is written as ONE open row per order under
 * Sync > Exceptions (and one WARNING in the order's activity), replaced when the difference changes and
 * deleted when the order agrees again. Nothing about the order is changed: an operator decides.
 *
 * The row lives in `shopping_sync_logs` with its own `recordKind` and its own `entityType`, so none of the
 * other row families' predicates (refund park, held invoice, admission refusal) can select it.
 */

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { currencyMinorUnits, toDecimal } from '@/lib/domain/math/decimal'
import type { WcFullOrder } from './types'

export const WC_ORDER_EDIT_DRIFT_RECORD_KIND = 'wc_order_edit_drift'
export const WC_ORDER_EDIT_DRIFT_ENTITY_TYPE = 'SalesOrderEdit'
export const WC_ORDER_EDIT_DRIFT_ACTION = 'wc_order_edited_after_import'

/** Selects the open edit-drift rows. The ONLY place this family is selected. */
export function wcOrderEditDriftWhere() {
  return {
    connector: 'woocommerce',
    direction: 'FROM_CONNECTOR' as const,
    entityType: WC_ORDER_EDIT_DRIFT_ENTITY_TYPE,
    recordKind: WC_ORDER_EDIT_DRIFT_RECORD_KIND,
    status: 'QUARANTINED' as const,
  }
}

export type StoredOrderForDrift = {
  currency: string
  totalForeign: unknown
  lines: ReadonlyArray<{ externalLineItemId: number | null; qty: unknown; sku: string | null }>
}

/**
 * The differences between the payload and the stored order, as stable sentences (empty = they agree).
 * Goods lines only (a line with a WooCommerce line id); fee lines carry none and are compared through the total.
 * A payload without a readable `line_items` array or `total` states nothing, so nothing is compared for it.
 */
export function detectWcOrderEditDrift(wcOrder: Pick<WcFullOrder, 'line_items' | 'total'>, stored: StoredOrderForDrift): string[] {
  const differences: string[] = []

  if (Array.isArray(wcOrder.line_items)) {
    const wc = new Map<number, { qty: number; sku: string }>()
    for (const item of wcOrder.line_items as Array<{ id?: unknown; quantity?: unknown; sku?: unknown }>) {
      if (typeof item?.id !== 'number' || typeof item.quantity !== 'number') continue
      const prior = wc.get(item.id)
      wc.set(item.id, { qty: (prior?.qty ?? 0) + item.quantity, sku: typeof item.sku === 'string' ? item.sku : (prior?.sku ?? '') })
    }
    const ims = new Map<number, { qty: number; sku: string }>()
    for (const line of stored.lines) {
      if (line.externalLineItemId === null || line.externalLineItemId === undefined) continue
      const prior = ims.get(line.externalLineItemId)
      ims.set(line.externalLineItemId, { qty: (prior?.qty ?? 0) + Number(line.qty), sku: line.sku ?? prior?.sku ?? '' })
    }
    for (const [id, line] of [...wc].sort((a, b) => a[0] - b[0])) {
      const held = ims.get(id)
      if (!held) differences.push(`WooCommerce line ${id}${line.sku ? ` (${line.sku})` : ''} x ${line.qty} is not on the IMS order`)
      else if (held.qty !== line.qty) differences.push(`WooCommerce line ${id}${line.sku ? ` (${line.sku})` : ''} is x ${line.qty}; IMS holds x ${held.qty}`)
    }
    for (const [id, line] of [...ims].sort((a, b) => a[0] - b[0])) {
      if (!wc.has(id)) differences.push(`IMS line ${id}${line.sku ? ` (${line.sku})` : ''} x ${line.qty} is no longer on the WooCommerce order`)
    }
  }

  if (wcOrder.total !== undefined && wcOrder.total !== null && String(wcOrder.total).trim() !== '') {
    try {
      const dp = currencyMinorUnits(stored.currency)
      const wcTotal = toDecimal(wcOrder.total).toFixed(dp)
      const imsTotal = toDecimal(stored.totalForeign as never).toFixed(dp)
      if (wcTotal !== imsTotal) differences.push(`WooCommerce total is ${wcTotal}; IMS holds ${imsTotal} (${stored.currency})`)
    } catch {
      // an unreadable total is no evidence of an edit
    }
  }
  return differences
}

/**
 * Compare and record. Idempotent: the same difference seen on a redelivery refreshes the row's age (so retention does not
 * expire a live exception) and writes nothing else; a changed difference replaces the row and notes it once; agreement clears it.
 * Best effort by design: a failure here is logged and never fails the delivery whose real work already committed.
 */
export async function surfaceWcOrderEditDrift(orderId: string, wcOrder: WcFullOrder): Promise<void> {
  try {
    const stored = await db.salesOrder.findUnique({
      where: { id: orderId },
      select: { currency: true, totalForeign: true, externalOrderNumber: true, lines: { select: { externalLineItemId: true, qty: true, sku: true } } },
    })
    if (!stored) return
    const differences = detectWcOrderEditDrift(wcOrder, stored)
    const rowWhere = { ...wcOrderEditDriftWhere(), entityId: orderId }
    if (differences.length === 0) {
      await db.shoppingSyncLog.deleteMany({ where: rowWhere })
      return
    }
    const fingerprint = JSON.stringify(differences)
    const existing = await db.shoppingSyncLog.findFirst({ where: rowWhere, select: { id: true, payload: true } })
    if (existing && (existing.payload as { fingerprint?: string } | null)?.fingerprint === fingerprint) {
      await db.shoppingSyncLog.update({ where: { id: existing.id }, data: { createdAt: new Date() } })
      return
    }
    const summary = `Edited in WooCommerce after import: ${differences.join('; ')}`
    await db.$transaction(async (tx) => {
      await tx.shoppingSyncLog.deleteMany({ where: rowWhere })
      await tx.shoppingSyncLog.create({
        data: {
          connector: 'woocommerce',
          direction: 'FROM_CONNECTOR',
          status: 'QUARANTINED',
          entityType: WC_ORDER_EDIT_DRIFT_ENTITY_TYPE,
          recordKind: WC_ORDER_EDIT_DRIFT_RECORD_KIND,
          entityId: orderId,
          externalId: String(wcOrder.id),
          errorMessage: summary,
          payload: { fingerprint, differences },
        },
      })
    })
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      action: WC_ORDER_EDIT_DRIFT_ACTION,
      tag: 'sync',
      level: 'WARNING',
      description: `WooCommerce order ${wcOrder.number} no longer matches the order IMS holds. IMS does not rewrite an imported order's lines or total, so it keeps allocating, pushing and invoicing the original content until an operator decides (listed under Sync > Exceptions). ${summary}`,
      metadata: { connector: 'woocommerce', externalOrderId: String(wcOrder.id), differences },
      resolveUser: false,
    })
  } catch (e) {
    console.error('wc_order_edit_drift: could not record', e instanceof Error ? e.constructor.name : typeof e)
  }
}
