import type { Prisma } from '@/app/generated/prisma/client'
import { logActivityInTransaction } from '@/lib/activity-log'
import { db } from '@/lib/db'
import { getWmsConnector } from '@/lib/connectors/wms/registry'
import { isWmsConnectorId, type WmsOrderItemRef } from '@/lib/connectors/wms/types'
import { removalNoteKey } from './removal-note-obligation'
import type { WmsOperatorTaskPayload } from './operator-tasks'

/**
 * THE DONE ACTION OF AN OPERATOR QUERY TASK.
 *
 * Every task is done when a person has raised the query in the warehouse's own system. Two behave differently from "mark it done":
 *
 *   PARTIAL_REMOVAL_CHECK  IMS began taking a cancelled order's lines out of a merged warehouse order and stopped part way, so the link was
 *                          kept OPEN (still polled for despatch; the removal is not retried over it). Done RE-READS the warehouse order
 *                          (one read-only GET) and refuses unless every recorded line is gone. When they are, ONE transaction marks the
 *                          task done, settles the link CANCELLED (only while it is still the link that names that warehouse order, in
 *                          a state the removal leaves it in), drops the obligation row and writes the audit entry. If the link has
 *                          moved on (already closed, re-pointed at another warehouse order) nothing is settled and the answer says so.
 *   anything else          the task is marked done, with who and when, and an audit entry.
 *
 * The task flips OPEN -> DONE by a compare-and-set, so two people pressing Done cannot both succeed.
 */

export type WmsOperatorTaskDoneResult = { ok: true; notice: string } | { ok: false; error: string }

type LinesReader = (connector: string, externalOrderId: string) => Promise<WmsOrderItemRef[] | null>

/** The read-only lines check, through the connector. Null when it cannot be read (no such connector, no support, a failure). */
const defaultReadLines: LinesReader = async (connector, externalOrderId) => {
  if (!isWmsConnectorId(connector)) return null
  const wms = getWmsConnector(connector)
  if (!wms.fetchOrderItemRefs) return null
  try {
    return await wms.fetchOrderItemRefs(externalOrderId)
  } catch {
    return null
  }
}

function payloadOf(value: Prisma.JsonValue | null): WmsOperatorTaskPayload {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as WmsOperatorTaskPayload) : {}
}

export async function completeWmsOperatorTask(params: {
  taskId: string
  userId: string
  /** Test seam: how the warehouse order's lines are read. Defaults to the connector's read-only fetch. */
  readLines?: LinesReader
  now?: () => Date
}): Promise<WmsOperatorTaskDoneResult> {
  const { taskId, userId } = params
  const now = params.now ?? (() => new Date())
  const task = await db.wmsOperatorTask.findUnique({
    where: { id: taskId },
    select: { id: true, status: true, connector: true, orderId: true, externalOrderId: true, reason: true, payload: true, order: { select: { orderNumber: true } } },
  })
  if (!task) return { ok: false, error: 'This task no longer exists. Reload the page.' }
  if (task.status !== 'OPEN') return { ok: false, error: 'This task was already marked done. Reload the page.' }
  const payload = payloadOf(task.payload)
  const orderLabel = task.order.orderNumber ?? task.orderId

  const partial = task.reason === 'PARTIAL_REMOVAL_CHECK'
  let recorded: Array<{ externalItemId: string }> = []
  if (partial) {
    recorded = Array.isArray(payload.items) ? payload.items : []
    if (!payload.linkId || recorded.length === 0) return { ok: false, error: 'This task does not record which lines were being removed, so IMS cannot check them. Leave it open and check the warehouse order by hand.' }
    // ONE read-only GET, outside the transaction (no database lock is held across a network call).
    const lines = await (params.readLines ?? defaultReadLines)(task.connector, task.externalOrderId)
    if (lines === null) return { ok: false, error: 'IMS could not read the warehouse order to check its lines. Try again in a moment; nothing was changed.' }
    const stillThere = recorded.filter((item) => lines.some((line) => line.externalItemId === item.externalItemId))
    if (stillThere.length > 0) {
      return { ok: false, error: `${stillThere.length} of the ${recorded.length} recorded line(s) are still on the warehouse order (${stillThere.map((item) => item.externalItemId).join(', ')}). Ask the warehouse to take them out, then press Done again. Nothing was changed.` }
    }
  }

  const at = now()
  return db.$transaction(async (tx) => {
    const flipped = await tx.wmsOperatorTask.updateMany({ where: { id: taskId, status: 'OPEN' }, data: { status: 'DONE', doneAt: at, doneBy: userId } })
    if (flipped.count === 0) return { ok: false as const, error: 'This task was already marked done. Reload the page.' }
    let settled = false
    if (partial) {
      const closed = await tx.wmsOrderPushLink.updateMany({
        where: { id: payload.linkId, orderId: task.orderId, externalOrderId: task.externalOrderId, state: { in: ['MERGED', 'SYNCED'] } },
        data: { state: 'CANCELLED', cancelledAt: at, lastError: null, lastAttemptAt: at, reconcileCheckedAt: null },
      })
      settled = closed.count > 0
      // The obligation row has done its work either way: the lines are verified gone.
      await tx.setting.deleteMany({ where: { key: removalNoteKey(task.connector, payload.linkId as string, task.externalOrderId) } })
    }
    // Marking an AMENDMENT_NOT_APPLIED task done says only that the query was RAISED. The refused-action record stays OPEN (and keeps its age alert): it
    // is closed when the warehouse's lines are read back and match the intent, when the order ends, or when an amendment later succeeds
    // (order-push-sweep verifyAmendmentRefusals). Done only stops a second task for the same intent (the task dedupe).
    await logActivityInTransaction(tx, {
      userId,
      entityType: 'SALES_ORDER',
      entityId: task.orderId,
      action: 'wms_operator_task_done',
      tag: 'sync',
      level: 'INFO',
      description: partial
        ? `Operator task done for order ${orderLabel} on warehouse order ${task.externalOrderId}: every recorded line was verified gone${settled ? ' and the warehouse link was closed as cancelled' : '; the warehouse link had already moved on, so it was not changed'}.`
        : task.reason === 'SHOP_REFUND_DUE'
          ? `Operator task done for order ${orderLabel}: Refund in WooCommerce, marked done by a person. IMS wrote nothing to WooCommerce.`
          : task.reason === 'MERGE_HOLD' || task.reason === 'MERGE_HOLD_OVERDUE' || task.reason === 'MERGE_HOLD_WITHDRAWAL'
            ? `Operator task done for order ${orderLabel} on warehouse order ${task.externalOrderId}: merge hold, marked done by a person. IMS did not release or change the hold; it clears when the warehouse order leaves the held status.`
          : task.reason === 'CANCELLED_POSTED_INVOICE'
            ? `Operator task done for order ${orderLabel}: the posted invoice (${task.externalOrderId}) was credited by hand, marked done by a person. IMS did not check the ledger.`
          : `Operator task done for order ${orderLabel} on warehouse order ${task.externalOrderId}: the query was raised in the warehouse's system.`,
      metadata: { taskId, connector: task.connector, reason: task.reason, externalOrderId: task.externalOrderId, ...(partial ? { linkSettled: settled } : {}) },
    })
    return {
      ok: true as const,
      notice: partial
        ? (settled ? 'Every line is gone from the warehouse order. The link was closed as cancelled.' : 'Every line is gone from the warehouse order. The link had already moved on, so it was not changed.')
        : task.reason === 'SHOP_REFUND_DUE'
          ? 'Marked done. If the refund in WooCommerce has not been imported into IMS yet, IMS can no longer link it to this credit note.'
          : 'Marked done.',
    }
  }, { maxWait: 5_000, timeout: 20_000 })
}
