'use server'

import { db } from '@/lib/db'
import { requireInternalUser, requirePermission } from '@/lib/auth/server'
import { SHOP_REFUND_CONNECTOR } from '@/lib/domain/sales/shop-refund-tasks'
import type { WmsOperatorTaskPayload } from '@/lib/domain/wms/operator-tasks'

/**
 * "REFUND IN WOOCOMMERCE": what the Sales order badge and the Sync > Exceptions list read. IMS reads its own tables here and writes nothing,
 * to IMS or to WooCommerce. Marking a task done goes through markWmsOperatorTaskDoneAction (the shared Done action).
 */

export type ShopRefundTaskRow = {
  id: string
  orderId: string
  orderNumber: string
  creditNoteNumber: string | null
  /** What the customer is to be paid back, with the currency; the net when the tax-inclusive figure could not be worked out. */
  amountText: string
  queryText: string
  createdAt: string
}
export type ShopRefundTaskPage = { rows: ShopRefundTaskRow[]; total: number; page: number; pageSize: number }

const PAGE_SIZE = 50

function describe(task: { id: string; orderId: string; queryText: string; payload: unknown; createdAt: Date; order: { orderNumber: string | null } }): ShopRefundTaskRow {
  const payload = (task.payload && typeof task.payload === 'object' && !Array.isArray(task.payload) ? task.payload : {}) as WmsOperatorTaskPayload
  const refund = payload.shopRefund
  return {
    id: task.id,
    orderId: task.orderId,
    orderNumber: task.order.orderNumber ?? task.orderId,
    creditNoteNumber: refund?.creditNoteNumber ?? null,
    amountText: refund ? (refund.grossForeign !== null ? `${refund.grossForeign} ${refund.currency}` : `${refund.netForeign} ${refund.currency} before tax`) : '',
    queryText: task.queryText,
    createdAt: task.createdAt.toISOString(),
  }
}

const SELECT = { id: true, orderId: true, queryText: true, payload: true, createdAt: true, order: { select: { orderNumber: true } } } as const

/** The open refunds to make in WooCommerce, oldest first. */
export async function listShopRefundTasks(pageInput = 0): Promise<ShopRefundTaskPage> {
  await requirePermission('sync')
  const page = Number.isInteger(pageInput) && pageInput > 0 ? pageInput : 0
  const where = { status: 'OPEN' as const, reason: 'SHOP_REFUND_DUE' as const, connector: SHOP_REFUND_CONNECTOR }
  const [total, tasks] = await Promise.all([
    db.wmsOperatorTask.count({ where }),
    db.wmsOperatorTask.findMany({ where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], skip: page * PAGE_SIZE, take: PAGE_SIZE, select: SELECT }),
  ])
  return { rows: tasks.map(describe), total, page, pageSize: PAGE_SIZE }
}

export type ShopRefundBadgeView = { count: number; amounts: string[] }

/** The badge for one sales order, or null when no refund is waiting to be made in WooCommerce (or the read failed: the order page must still render). */
export async function getShopRefundDueForSalesOrder(salesOrderId: string): Promise<ShopRefundBadgeView | null> {
  await requireInternalUser()
  try {
    const tasks = await db.wmsOperatorTask.findMany({
      where: { orderId: salesOrderId, status: 'OPEN', reason: 'SHOP_REFUND_DUE', connector: SHOP_REFUND_CONNECTOR },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: SELECT,
    })
    if (tasks.length === 0) return null
    return { count: tasks.length, amounts: tasks.map((task) => describe(task).amountText).filter((text) => text !== '') }
  } catch (error) {
    console.error('[shop-refund-tasks] badge read failed', error instanceof Error ? error.message : String(error))
    return null
  }
}
