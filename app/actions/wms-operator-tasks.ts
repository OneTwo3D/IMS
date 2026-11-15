'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { freshAuthFailureResult, requireFreshPermission, requirePermission } from '@/lib/auth/server'
import type { FreshAuthFailureResult } from '@/lib/auth/session-gates'
import { completeWmsOperatorTask } from '@/lib/domain/wms/operator-task-done'
import { WMS_OPERATOR_TASK_REASON_LABELS, type WmsOperatorTaskPayload } from '@/lib/domain/wms/operator-tasks'

/**
 * SYNC > EXCEPTIONS: RAISE A MINTSOFT QUERY.
 *
 * IMS writes no comment to the warehouse (its staff do not read them; only a query raised in their own system reaches them, and the API cannot
 * raise one). Each open task here is a query a person raises by hand from the copy-ready text, then marks Done. Done needs the sync permission and
 * a fresh sign-in, and records who and when. The tasks hold no personal data: order numbers, SKUs and quantities.
 */

/** Tasks per page of the section. */
const OPERATOR_TASK_PAGE_SIZE = 50

export type WmsOperatorTaskRow = {
  id: string
  orderId: string
  /** The IMS order number. */
  orderNumber: string
  connector: string
  /** The warehouse's own order number when recorded, else its id. */
  warehouseOrder: string
  reason: string
  reasonLabel: string
  queryText: string
  createdAt: string
}
export type WmsOperatorTaskPage = { rows: WmsOperatorTaskRow[]; total: number; page: number; pageSize: number }

/** The open tasks, oldest first. The filter is in the database and the page is cut after it, so every open task is reachable by paging. */
export async function listWmsOperatorTasks(pageInput = 0): Promise<WmsOperatorTaskPage> {
  await requirePermission('sync')
  const page = Number.isInteger(pageInput) && pageInput > 0 ? pageInput : 0
  const where = { status: 'OPEN' as const }
  const [total, tasks] = await Promise.all([
    db.wmsOperatorTask.count({ where }),
    db.wmsOperatorTask.findMany({
      where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], skip: page * OPERATOR_TASK_PAGE_SIZE, take: OPERATOR_TASK_PAGE_SIZE,
      select: { id: true, orderId: true, connector: true, externalOrderId: true, reason: true, queryText: true, payload: true, createdAt: true, order: { select: { orderNumber: true } } },
    }),
  ])
  const rows = tasks.map((task): WmsOperatorTaskRow => {
    const payload = (task.payload && typeof task.payload === 'object' && !Array.isArray(task.payload) ? task.payload : {}) as WmsOperatorTaskPayload
    return {
      id: task.id,
      orderId: task.orderId,
      orderNumber: task.order.orderNumber ?? task.orderId,
      connector: task.connector,
      warehouseOrder: payload.externalOrderNumber && payload.externalOrderNumber !== '' ? payload.externalOrderNumber : task.externalOrderId,
      reason: task.reason,
      reasonLabel: WMS_OPERATOR_TASK_REASON_LABELS[task.reason],
      queryText: task.queryText,
      createdAt: task.createdAt.toISOString(),
    }
  })
  return { rows, total, page, pageSize: OPERATOR_TASK_PAGE_SIZE }
}

export type MarkWmsOperatorTaskDoneResult = { success: boolean; error?: string; notice?: string } | FreshAuthFailureResult

/**
 * Mark one task done: the query was raised in the warehouse's system. A partial-removal check is refused unless every recorded line is gone from
 * the warehouse order (one read-only look), and then closes the link in the same transaction.
 */
export async function markWmsOperatorTaskDoneAction(taskId: string): Promise<MarkWmsOperatorTaskDoneResult> {
  try {
    const session = await requireFreshPermission('sync')
    if (typeof taskId !== 'string' || taskId === '') return { success: false, error: 'No task was named.' }
    const outcome = await completeWmsOperatorTask({ taskId, userId: session.user.id })
    revalidatePath('/sync/exceptions')
    return outcome.ok ? { success: true, notice: outcome.notice } : { success: false, error: outcome.error }
  } catch (error) {
    const freshAuthFailure = freshAuthFailureResult(error)
    if (freshAuthFailure) return freshAuthFailure
    throw error
  }
}
