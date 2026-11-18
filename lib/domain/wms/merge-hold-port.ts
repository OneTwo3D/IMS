import { db } from '@/lib/db'
import type { Prisma } from '@/app/generated/prisma/client'
import { lockSalesOrder } from '@/lib/domain/sales/allocation-service'
import { logActivity, logActivityInTransaction } from '@/lib/activity-log'
import { notify } from '@/lib/notifications'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { resolveEnabledWmsConnector, wmsResolutionSkipReason } from '@/lib/connectors/wms/enabled-connector'
import { getWmsConnector, getWmsConnectorDef } from '@/lib/connectors/wms/registry'
import { wmsProducerSeam } from '@/lib/connectors/wms/producer-seam'
import { isWmsConnectorId } from '@/lib/connectors/wms/types'
import { REFUSED_ACTION_ENTITY_SALES_ORDER, recordRefusedAction, resolveRefusedActions } from '@/lib/domain/refused-actions'
import { raiseWmsOperatorTask } from './operator-tasks'
import { scrubWmsError } from './error-scrub'
import {
  MERGE_HOLD_MAX_ATTEMPTS,
  MERGE_HOLD_OVERDUE_TASK_REASON,
  MERGE_HOLD_TASK_REASON,
  MERGE_HOLD_WITHDRAWAL_TASK_REASON,
  isMergeHoldEnabled,
  mergeHoldActInWarehouse,
  mergeHoldOverdueBasis,
  mergeHoldOverdueQuery,
  mergeHoldQuery,
  mergeHoldTaskBasis,
  mergeHoldWithdrawalBasis,
  mergeHoldWithdrawalQuery,
  runMergeHoldMaintenance,
  type MergeHoldEnvironment,
  type MergeHoldMaintenance,
  type MergeHoldMember,
  type MergeHoldObservation,
  type MergeHoldPort,
  type MergeHoldRow,
} from './merge-hold'

/**
 * The database and warehouse side of the merge holds (see merge-hold.ts for what they are and why). Every write here is to IMS's own tables, except
 * `requestHold`, which asks the connector's `holdOrder` (a GET MarkAwaitingConfirmation) after the producer-side hold has cleared it. There is no
 * release call in this file or anywhere else.
 */

const ACTIVE = ['HOLDING', 'HELD'] as const

const orderLabel = (number: string | null, id: string) => number ?? id

function toRow(row: { id: string; connector: string; orderId: string; externalOrderId: string; groupBasis: string; state: string; episode: number; attempts: number; refused: boolean; lastError: string | null; heldAt: Date | null; remindedAt: Date | null; updatedAt: Date }): MergeHoldRow {
  return { ...row, state: row.state as MergeHoldRow['state'] }
}

/** The warehouse connector this build uses for the holds, or why there is none. */
export async function mergeHoldEnvironment(): Promise<MergeHoldEnvironment | { skipped: string }> {
  const resolution = resolveEnabledWmsConnector(await getIntegrationPluginState())
  if (resolution.kind !== 'one') return { skipped: wmsResolutionSkipReason(resolution) }
  return { connectorId: resolution.id, connectorLabel: getWmsConnectorDef(resolution.id).label }
}

export const prismaMergeHoldPort: MergeHoldPort = {
  now: () => new Date(),
  isEnabled: () => isMergeHoldEnabled(),

  async beginHold(env, member, groupBasis) {
    return db.$transaction(async (tx) => {
      await lockSalesOrder(tx, member.orderId)
      const existing = await tx.wmsMergeHold.findUnique({ where: { connector_orderId: { connector: env.connectorId, orderId: member.orderId } } })
      if (!existing) {
        const created = await tx.wmsMergeHold.create({
          data: { connector: env.connectorId, orderId: member.orderId, externalOrderId: member.externalOrderId, groupBasis, state: 'HOLDING', attempts: 1 },
        })
        return toRow(created)
      }
      if ((ACTIVE as readonly string[]).includes(existing.state)) return null
      if (existing.state === 'NOT_HELD' && existing.externalOrderId === member.externalOrderId) {
        // The same warehouse order: a definite refusal stands, and the attempts are bounded.
        if (existing.refused || existing.attempts >= MERGE_HOLD_MAX_ATTEMPTS) return null
        const next = await tx.wmsMergeHold.update({ where: { id: existing.id }, data: { state: 'HOLDING', attempts: { increment: 1 }, groupBasis } })
        return toRow(next)
      }
      // CLEARED, or NOT_HELD for another warehouse order: a NEW episode on the same row.
      const next = await tx.wmsMergeHold.update({
        where: { id: existing.id },
        data: {
          state: 'HOLDING', episode: { increment: 1 }, attempts: 1, refused: false, lastError: null, heldAt: null, remindedAt: null,
          clearedAt: null, clearReason: null, blockedNoticeAt: null, externalOrderId: member.externalOrderId, groupBasis,
        },
      })
      return toRow(next)
    }, { maxWait: 5_000, timeout: 20_000 })
  },

  async requestHold(env, member) {
    // THE PRODUCER-SIDE HOLD, asked immediately before the request: a shadowed operation sends nothing.
    const seam = await wmsProducerSeam(env.connectorId, {
      operation: 'order.hold',
      subjectType: 'SalesOrder',
      subjectId: member.orderId,
      payload: { externalOrderId: member.externalOrderId, action: 'merge-hold' },
    })
    if (!seam.proceed) return { shadowed: true as const }
    if (!isWmsConnectorId(env.connectorId)) throw new Error('Unknown warehouse connector')
    const connector = getWmsConnector(env.connectorId)
    if (!connector.holdOrder) throw new Error('The active warehouse connector cannot hold an order')
    // The number IMS pushed for the order, from its own link (the identity the warehouse order must still carry).
    const link = await db.wmsOrderPushLink.findUnique({ where: { orderId: member.orderId }, select: { connector: true, state: true, externalOrderId: true, externalOrderNumber: true } })
    if (!link || link.connector !== env.connectorId || link.state !== 'SYNCED' || link.externalOrderId !== member.externalOrderId) {
      throw new Error('The order link changed since the group was detected; the hold was not sent')
    }
    return connector.holdOrder(member.externalOrderId, { orderNumber: link.externalOrderNumber ?? null }, seam.clearance)
  },

  async abandonHold(row) {
    // Nothing was sent: the attempt is taken back (never a refusal, never a hold). The row is left NOT_HELD so no stale HOLDING row blocks a later attempt.
    await db.wmsMergeHold.updateMany({ where: { id: row.id, state: 'HOLDING' }, data: { state: 'NOT_HELD', refused: false, attempts: Math.max(0, row.attempts - 1), lastError: 'Not sent: the warehouse write is held by the producer-side hold' } })
  },

  async recordHeld(row, at) {
    await db.$transaction(async (tx) => {
      const moved = await tx.wmsMergeHold.updateMany({ where: { id: row.id, state: 'HOLDING' }, data: { state: 'HELD', heldAt: at, lastError: null, refused: false } })
      if (moved.count === 0) return
      await logActivityInTransaction(tx, {
        userId: null, entityType: 'SALES_ORDER', entityId: row.orderId, action: 'wms_merge_hold_placed', tag: 'sync', level: 'INFO',
        description: `Merge hold placed: warehouse order ${row.externalOrderId} is held (awaiting confirmation) so a person can merge it with the customer's other order(s). IMS will not release it; confirm it in the warehouse after merging.`,
        metadata: { connector: row.connector, externalOrderId: row.externalOrderId, groupBasis: row.groupBasis, episode: row.episode },
      })
    }, { maxWait: 5_000, timeout: 20_000 })
  },

  async recordNotHeld(row, outcome) {
    await db.wmsMergeHold.updateMany({ where: { id: row.id, state: 'HOLDING' }, data: { state: 'NOT_HELD', refused: outcome.refused, lastError: outcome.error } })
  },

  async retryableMembers(env) {
    const rows = await db.wmsMergeHold.findMany({
      where: { connector: env.connectorId, state: 'NOT_HELD', refused: false, attempts: { lt: MERGE_HOLD_MAX_ATTEMPTS } },
      select: {
        groupBasis: true, externalOrderId: true,
        order: { select: { id: true, orderNumber: true, wmsOrderPush: { select: { state: true, externalOrderId: true, externalOrderNumber: true } } } },
      },
    })
    if (rows.length === 0) return []
    const bases = [...new Set(rows.map((row) => row.groupBasis))]
    const active = await db.wmsMergeHold.findMany({ where: { connector: env.connectorId, groupBasis: { in: bases }, state: { in: [...ACTIVE] } }, select: { groupBasis: true } })
    const live = new Set(active.map((row) => row.groupBasis))
    return rows
      .filter((row) => live.has(row.groupBasis) && row.order.wmsOrderPush?.state === 'SYNCED' && row.order.wmsOrderPush.externalOrderId === row.externalOrderId)
      .map((row) => ({
        groupBasis: row.groupBasis,
        member: { orderId: row.order.id, orderNumber: row.order.orderNumber, externalOrderId: row.externalOrderId, externalOrderNumber: row.order.wmsOrderPush?.externalOrderNumber ?? '' },
      }))
  },

  async raiseGroupTask(env, group, heldFlags, episodes) {
    const anchor = group.members[0]
    const queryText = mergeHoldQuery(group.members.map((m) => ({ ...m, held: heldFlags.get(m.orderId) === true })), group.warnings, env.connectorLabel)
    await db.$transaction(async (tx) => {
      const created = await raiseWmsOperatorTask(tx, {
        connector: env.connectorId, orderId: anchor.orderId, externalOrderId: anchor.externalOrderId, reason: MERGE_HOLD_TASK_REASON, queryText,
        payload: { orderNumber: anchor.orderNumber, externalOrderNumber: anchor.externalOrderNumber, members: group.members },
        dedupeBasis: mergeHoldTaskBasis(group, episodes),
      })
      if (!created) return
      for (const member of group.members) {
        await logActivityInTransaction(tx, {
          userId: null, entityType: 'SALES_ORDER', entityId: member.orderId, action: 'wms_merge_hold_task_raised', tag: 'sync', level: 'INFO',
          description: `An operator task asks a person to merge order ${orderLabel(member.orderNumber, member.orderId)} with the group's other orders in the warehouse and confirm it there.${heldFlags.get(member.orderId) === true ? '' : ' This order is NOT held.'}`,
          metadata: { connector: env.connectorId, orderIds: group.members.map((m) => m.orderId), warnings: group.warnings },
        })
      }
    }, { maxWait: 5_000, timeout: 20_000 })
  },

  async logNotHeld(row, member, refused, error) {
    await logActivity({
      userId: null, entityType: 'SALES_ORDER', entityId: row.orderId, action: 'wms_merge_hold_failed', tag: 'sync', level: 'WARNING',
      description: `Not held: IMS could not put order ${orderLabel(member.orderNumber, member.orderId)} on merge hold in the warehouse (${refused ? 'the warehouse refused it' : 'the request failed and the outcome is unknown'}). ${refused ? 'IMS will not retry.' : 'IMS retries.'} Check the order in the warehouse before it is picked.`,
      metadata: { connector: row.connector, externalOrderId: row.externalOrderId, refused, reason: scrubWmsError(error, 'unknown') },
      resolveUser: false,
    })
  },

  async activeRows(connector) {
    const rows = await db.wmsMergeHold.findMany({
      where: { connector, state: { in: [...ACTIVE] } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true, connector: true, orderId: true, externalOrderId: true, groupBasis: true, state: true, episode: true, attempts: true, refused: true, lastError: true, heldAt: true, remindedAt: true, updatedAt: true,
        order: {
          select: {
            orderNumber: true, status: true, refundStatus: true, shippedAt: true, withdrawalHoldAt: true, withdrawalApprovedAt: true, updatedAt: true,
            wmsOrderPush: { select: { state: true, externalOrderId: true, pushedAt: true } },
            wmsOrderStatus: { select: { status: true, externalOrderId: true, fetchedAt: true, lastError: true } },
          },
        },
      },
    })
    return rows.map(({ order, ...row }): MergeHoldObservation => ({
      row: toRow(row),
      orderNumber: order.orderNumber,
      orderStatus: order.status,
      refundStatus: order.refundStatus,
      shippedAt: order.shippedAt,
      withdrawalHoldAt: order.withdrawalHoldAt,
      withdrawalApprovedAt: order.withdrawalApprovedAt,
      editPending: Boolean(order.wmsOrderPush?.pushedAt && order.updatedAt > order.wmsOrderPush.pushedAt),
      link: order.wmsOrderPush ? { state: order.wmsOrderPush.state, externalOrderId: order.wmsOrderPush.externalOrderId } : null,
      snapshot: order.wmsOrderStatus,
    }))
  },

  async clear(row, reason, at) {
    return db.$transaction(async (tx) => {
      const moved = await tx.wmsMergeHold.updateMany({ where: { id: row.id, state: { in: [...ACTIVE] } }, data: { state: 'CLEARED', clearedAt: at, clearReason: reason } })
      if (moved.count === 0) return false
      await logActivityInTransaction(tx, {
        userId: null, entityType: 'SALES_ORDER', entityId: row.orderId, action: 'wms_merge_hold_cleared', tag: 'sync', level: 'INFO',
        description: `Merge hold cleared for warehouse order ${row.externalOrderId}: ${reason}. IMS did not release it.`,
        metadata: { connector: row.connector, externalOrderId: row.externalOrderId, episode: row.episode, reason },
      })
      return true
    }, { maxWait: 5_000, timeout: 20_000 })
  },

  async promoteToHeld(row, at) {
    const moved = await db.wmsMergeHold.updateMany({ where: { id: row.id, state: 'HOLDING' }, data: { state: 'HELD', heldAt: at, lastError: null } })
    return moved.count > 0
  },

  async demoteToNotHeld(row, error) {
    const moved = await db.wmsMergeHold.updateMany({ where: { id: row.id, state: 'HOLDING' }, data: { state: 'NOT_HELD', refused: false, lastError: error } })
    return moved.count > 0
  },

  async remind(env, obs, hours, at) {
    const { row } = obs
    const label = orderLabel(obs.orderNumber, row.orderId)
    const fired = await db.$transaction(async (tx) => {
      // Compare-and-set: the reminder fires once per episode, whichever pass gets here first.
      const moved = await tx.wmsMergeHold.updateMany({ where: { id: row.id, state: 'HELD', remindedAt: null }, data: { remindedAt: at } })
      if (moved.count === 0) return false
      await raiseWmsOperatorTask(tx, {
        connector: env.connectorId, orderId: row.orderId, externalOrderId: row.externalOrderId, reason: MERGE_HOLD_OVERDUE_TASK_REASON,
        queryText: mergeHoldOverdueQuery(row.externalOrderId, label, hours, env.connectorLabel),
        payload: { orderNumber: obs.orderNumber },
        dedupeBasis: mergeHoldOverdueBasis(row),
      })
      await logActivityInTransaction(tx, {
        userId: null, entityType: 'SALES_ORDER', entityId: row.orderId, action: 'wms_merge_hold_overdue', tag: 'sync', level: 'WARNING',
        description: `Merge hold overdue: order ${label} has been on hold in the warehouse for more than ${hours} hour(s). Merge and confirm it in the warehouse; IMS will not release it.`,
        metadata: { connector: row.connector, externalOrderId: row.externalOrderId, episode: row.episode, hours },
      })
      return true
    }, { maxWait: 5_000, timeout: 20_000 })
    if (fired) {
      await notify({
        type: 'warning',
        title: 'Merge hold overdue',
        message: `Order ${label} has been on merge hold in ${env.connectorLabel} for more than ${hours} hour(s). Merge and confirm it there; IMS will not release it.`,
        actionUrl: `/sales/${row.orderId}`,
      })
    }
    return fired
  },

  async showEditBlocked(env, obs) {
    await recordRefusedAction(db, {
      entityType: REFUSED_ACTION_ENTITY_SALES_ORDER,
      entityId: obs.row.orderId,
      action: 'WMS_ORDER_AMEND',
      gate: 'WMS_MERGE_HELD',
      permanence: 'RETRYABLE',
      severity: 'MEDIUM',
      intent: { orderNumber: obs.orderNumber } as Prisma.InputJsonValue,
      detail: mergeHoldActInWarehouse(env.connectorLabel),
    })
  },

  async closeEditBlocked(orderId) {
    await resolveRefusedActions(db, { entityType: REFUSED_ACTION_ENTITY_SALES_ORDER, entityId: orderId, action: 'WMS_ORDER_AMEND', gate: 'WMS_MERGE_HELD' }, 'NO_LONGER_NEEDED')
  },

  async escalate(env, obs, kind) {
    const { row } = obs
    const label = orderLabel(obs.orderNumber, row.orderId)
    await db.$transaction(async (tx) => {
      const created = await raiseWmsOperatorTask(tx, {
        connector: env.connectorId, orderId: row.orderId, externalOrderId: row.externalOrderId, reason: MERGE_HOLD_WITHDRAWAL_TASK_REASON,
        queryText: mergeHoldWithdrawalQuery(row.externalOrderId, label, kind, env.connectorLabel),
        payload: { orderNumber: obs.orderNumber },
        dedupeBasis: mergeHoldWithdrawalBasis(row, kind),
      })
      if (!created) return
      await logActivityInTransaction(tx, {
        userId: null, entityType: 'SALES_ORDER', entityId: row.orderId, action: 'wms_merge_hold_escalated', tag: 'sync', level: 'WARNING',
        description: `${kind === 'WITHDRAWAL' ? 'A customer withdrawal' : 'A cancel or full refund'} reached order ${label}, which is on merge hold in the warehouse. IMS did not cancel or release it; an operator task asks a person to act in the warehouse.`,
        metadata: { connector: row.connector, externalOrderId: row.externalOrderId, episode: row.episode, kind },
      })
    }, { maxWait: 5_000, timeout: 20_000 })
  },
}

/** One cheap read: is there any active hold? (With the setting off and none, the maintenance writes and calls nothing.) */
async function anyActiveHold(): Promise<boolean> {
  return (await db.wmsMergeHold.findFirst({ where: { state: { in: [...ACTIVE] } }, select: { id: true } })) !== null
}

/** For the sweeps: never throws; null when there is nothing to do. */
export async function runMergeHoldMaintenanceSafe(trigger: string, port: MergeHoldPort = prismaMergeHoldPort): Promise<MergeHoldMaintenance | { error: string } | null> {
  try {
    if (!(await anyActiveHold())) return null
    const env = await mergeHoldEnvironment()
    if ('skipped' in env) return null
    return await runMergeHoldMaintenance(port, env)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[wms-merge-hold] maintenance after ${trigger} failed: ${message}`)
    return { error: message }
  }
}

export type { MergeHoldMember }
