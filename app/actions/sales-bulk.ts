'use server'

import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth/server'
import { isAuthorizationDenial } from '@/lib/auth/session-gates'
import { autoAllocateOrder } from '@/app/actions/allocation'
import { applySalesOrderStatusTransition } from '@/app/actions/sales'
import {
  advancePlan,
  allocateSkipReason,
  bulkCounts,
  normaliseBulkOrderIds,
  operatorMessage,
  type BulkRowResult,
  type BulkRunResult,
} from '@/lib/domain/sales/bulk-actions'

/**
 * Bulk actions for the sales-order list (one action per order, never all-or-nothing).
 *
 * Every row goes through the SAME per-order service the order page's button calls
 * (`autoAllocateOrder`, `updateSalesOrderStatus`), so the permission check, state machine, locks,
 * withdrawal/archive refusals and outbox hand-offs are those services' and not re-implemented here.
 * Rows run strictly one after another (capped at 100): no burst on the database, and connector work is only what each service already queues.
 * One order failing is reported on its own row and the run carries on.
 */

const STATUS_CHANGED_MESSAGE = 'Status changed since the list was loaded, so nothing was done. Open the order to check it.'

type OrderRow = { id: string; orderNumber: string | null; externalOrderNumber: string | null; status: string; archived: boolean }

const ORDER_SELECT = { id: true, orderNumber: true, externalOrderNumber: true, status: true, archived: true } as const

/** The gate every bulk action starts with. A denial is an answer for the operator, not an error page. */
async function gate(): Promise<{ error: string } | null> {
  try {
    await requirePermission('sales.process')
    return null
  } catch (error) {
    if (isAuthorizationDenial(error)) return { error: 'You do not have permission to process sales orders, so bulk actions are not available to you.' }
    throw error
  }
}

async function loadOrders(ids: string[]): Promise<Map<string, OrderRow>> {
  const rows = await db.salesOrder.findMany({ where: { id: { in: ids } }, select: ORDER_SELECT })
  return new Map(rows.map((r) => [r.id, r]))
}

const labelOf = (id: string, o: OrderRow | undefined) => o?.orderNumber ?? o?.externalOrderNumber ?? id.slice(0, 8)

/** One row's service call, with the run-must-continue guarantee: nothing thrown escapes. */
async function runRow(id: string, order: OrderRow | undefined, work: (o: OrderRow) => Promise<Omit<BulkRowResult, 'id' | 'orderNumber'>>): Promise<BulkRowResult> {
  const orderNumber = labelOf(id, order)
  if (!order) return { id, orderNumber, outcome: 'failed', message: 'Order not found. It may have been deleted; refresh the list.' }
  try {
    return { id, orderNumber, ...(await work(order)) }
  } catch (error) {
    return { id, orderNumber, outcome: 'failed', message: operatorMessage(error) }
  }
}

type AllocationAnswer = Awaited<ReturnType<typeof autoAllocateOrder>>

/** The order page's allocation, called exactly as its button calls it (its own stock-sync enqueue included: no new producer here). */
async function allocateOne(id: string): Promise<Omit<BulkRowResult, 'id' | 'orderNumber'>> {
  // The status was read when the run began: re-checked under the order lock, so an order put on hold meanwhile is left alone.
  const result: AllocationAnswer = await autoAllocateOrder(id, { requireStatusUnderLock: ['PROCESSING'] })
  if (result.success) {
    const short = result.unallocatedQty ?? 0
    return {
      outcome: 'done',
      message: short > 0 ? `Allocated, but ${short} unit(s) are short and wait on backorder.` : 'Allocated.',
    }
  }
  if (result.skipped) return { outcome: 'skipped', message: STATUS_CHANGED_MESSAGE }
  const partial = (result.allocationCount ?? 0) > 0 ? 'Partly allocated. ' : ''
  return { outcome: 'failed', message: `${partial}${operatorMessage(result.error, 'Stock could not be allocated.')}` }
}

export async function bulkAllocateSalesOrders(orderIds: string[]): Promise<BulkRunResult> {
  const denied = await gate()
  if (denied) return { ok: false, ...denied }
  const parsed = normaliseBulkOrderIds(orderIds)
  if ('error' in parsed) return { ok: false, error: parsed.error }

  const orders = await loadOrders(parsed.ids)
  const results: BulkRowResult[] = []
  for (const id of parsed.ids) {
    results.push(await runRow(id, orders.get(id), async (o) => {
      const skip = allocateSkipReason(o.status)
      if (skip) return { outcome: 'skipped', message: skip }
      return allocateOne(id)
    }))
  }
  return { ok: true, results, counts: bulkCounts(results) }
}

export async function bulkAdvanceSalesOrders(orderIds: string[]): Promise<BulkRunResult> {
  const denied = await gate()
  if (denied) return { ok: false, ...denied }
  const parsed = normaliseBulkOrderIds(orderIds)
  if ('error' in parsed) return { ok: false, error: parsed.error }

  const orders = await loadOrders(parsed.ids)
  const trackingSetting = await db.setting.findUnique({ where: { key: 'delivery_tracking_enabled' }, select: { value: true } })
  const deliveryTrackingEnabled = trackingSetting?.value === 'true'
  const results: BulkRowResult[] = []
  for (const id of parsed.ids) {
    results.push(await runRow(id, orders.get(id), async (o) => {
      const plan = advancePlan(o.status, o.archived, deliveryTrackingEnabled)
      if ('skip' in plan) return { outcome: 'skipped', message: plan.skip }
      // Exactly the order page's workflow button: Allocate is the allocator, every other step is the status service.
      if (plan.action.target === 'ALLOCATED') return allocateOne(id)
      // updateSalesOrderStatus's own call, plus a guard that REFUSES (never widens) unless the status under the order lock is still the one planned from.
      const expected = o.status
      const result = await applySalesOrderStatusTransition(id, plan.action.target, undefined, {
        pushStatusToWooCommerce: true,
        guardUnderLock: (current) => (current === expected ? null : STATUS_CHANGED_MESSAGE),
      })
      if (!result.success && result.error?.includes(STATUS_CHANGED_MESSAGE)) return { outcome: 'skipped', message: STATUS_CHANGED_MESSAGE }
      if (result.success) return { outcome: 'done', message: `Moved to ${plan.action.target.toLowerCase().replace('_', ' ')}.` }
      return { outcome: 'failed', message: operatorMessage(result.error, 'The status could not be changed.') }
    }))
  }
  return { ok: true, results, counts: bulkCounts(results) }
}
