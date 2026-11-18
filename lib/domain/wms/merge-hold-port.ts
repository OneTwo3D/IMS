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
  decideBeginHold,
  isMergeHoldEnabled,
  isMergeHeldWarehouseStatus,
  mergeHoldUnsettledBasis,
  mergeHoldUnsettledQuery,
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
  type MergeHoldTaskState,
} from './merge-hold'

/**
 * The database and warehouse side of the merge holds (see merge-hold.ts for what they are and why). Every write here is to IMS's own tables, except
 * `requestHold`, which asks the connector's `holdOrder` (a GET MarkAwaitingConfirmation) after the producer-side hold has cleared it. There is no
 * release call in this file or anywhere else.
 */

const ACTIVE = ['HOLDING', 'HELD', 'UNKNOWN'] as const

const orderLabel = (number: string | null, id: string) => number ?? id

function toRow(row: { id: string; connector: string; orderId: string; externalOrderId: string; groupBasis: string; state: string; episode: number; attempts: number; refused: boolean; lastError: string | null; heldAt: Date | null; remindedAt: Date | null; clearReason: string | null; updatedAt: Date }): MergeHoldRow {
  return { ...row, state: row.state as MergeHoldRow['state'] }
}

/** The warehouse connector this build uses for the holds, or why there is none. */
export async function mergeHoldEnvironment(): Promise<MergeHoldEnvironment | { skipped: string }> {
  const resolution = resolveEnabledWmsConnector(await getIntegrationPluginState())
  if (resolution.kind !== 'one') return { skipped: wmsResolutionSkipReason(resolution) }
  return { connectorId: resolution.id, connectorLabel: getWmsConnectorDef(resolution.id).label }
}

/** One state transition: compare-and-set on the current state (and the attempt, when given), with its audit entry in the same transaction. False when another writer moved the row. */
async function moveRow(
  row: MergeHoldRow,
  from: readonly string[],
  data: Prisma.WmsMergeHoldUncheckedUpdateManyInput,
  action: string,
  level: 'INFO' | 'WARNING',
  description: string,
  attempt?: number,
): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const moved = await tx.wmsMergeHold.updateMany({ where: { id: row.id, state: { in: from as never }, ...(attempt !== undefined ? { attempts: attempt } : {}) }, data })
    if (moved.count === 0) {
      console.warn(`[wms-merge-hold] ${action} did not apply: row ${row.id} is no longer ${from.join('/')}`)
      return false
    }
    await logActivityInTransaction(tx, {
      userId: null, entityType: 'SALES_ORDER', entityId: row.orderId, action, tag: 'sync', level, description,
      metadata: { connector: row.connector, externalOrderId: row.externalOrderId, groupBasis: row.groupBasis, episode: row.episode },
    })
    return true
  }, { maxWait: 5_000, timeout: 20_000 })
}

export const prismaMergeHoldPort: MergeHoldPort = {
  now: () => new Date(),
  isEnabled: () => isMergeHoldEnabled(),

  async beginHold(env, member, groupBasis) {
    return db.$transaction(async (tx) => {
      await lockSalesOrder(tx, member.orderId)
      const existing = await tx.wmsMergeHold.findUnique({ where: { connector_orderId: { connector: env.connectorId, orderId: member.orderId } } })
      const decision = decideBeginHold(existing ? toRow(existing) : null, member.externalOrderId, groupBasis)
      if (decision === 'skip') return null
      let next
      if (decision === 'create' || !existing) {
        next = await tx.wmsMergeHold.create({
          data: { connector: env.connectorId, orderId: member.orderId, externalOrderId: member.externalOrderId, groupBasis, state: 'HOLDING', attempts: 1 },
        })
      } else if (decision === 'retry') {
        next = await tx.wmsMergeHold.update({ where: { id: existing.id }, data: { state: 'HOLDING', attempts: { increment: 1 }, groupBasis } })
      } else {
        // CLEARED (and not decided by a person), or NOT_HELD for another warehouse order: a NEW episode on the same row.
        next = await tx.wmsMergeHold.update({
          where: { id: existing.id },
          data: {
            state: 'HOLDING', episode: { increment: 1 }, attempts: 1, refused: false, lastError: null, heldAt: null, remindedAt: null,
            clearedAt: null, clearReason: null, blockedNoticeAt: null, externalOrderId: member.externalOrderId, groupBasis,
          },
        })
      }
      await logActivityInTransaction(tx, {
        userId: null, entityType: 'SALES_ORDER', entityId: member.orderId, action: 'wms_merge_hold_attempted', tag: 'sync', level: 'INFO',
        description: `Merge hold attempt ${next.attempts} (episode ${next.episode}) started for warehouse order ${member.externalOrderId}.`,
        metadata: { connector: env.connectorId, externalOrderId: member.externalOrderId, groupBasis, episode: next.episode, attempt: next.attempts, decision },
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
    await moveRow(row, ['HOLDING'], { state: 'NOT_HELD', refused: false, attempts: Math.max(0, row.attempts - 1), lastError: 'Not sent: the warehouse write is held by the producer-side hold' }, 'wms_merge_hold_abandoned', 'INFO',
      `Merge hold attempt for warehouse order ${row.externalOrderId} was not sent: the warehouse write is held by the producer-side hold.`)
  },

  async recordHeld(row, at) {
    // This attempt's own answer wins over the upkeep's view: HOLDING, or UNKNOWN when the upkeep gave up on a slow attempt (same attempt number only).
    await moveRow(row, ['HOLDING', 'UNKNOWN'], { state: 'HELD', heldAt: at, lastError: null, refused: false }, 'wms_merge_hold_placed', 'INFO',
      `Merge hold placed: warehouse order ${row.externalOrderId} is held (awaiting confirmation) so a person can merge it with the customer's other order(s). IMS will not release it; confirm it in the warehouse after merging.`, row.attempts)
  },

  async recordNotHeld(row, outcome) {
    await moveRow(row, ['HOLDING'], { state: 'NOT_HELD', refused: outcome.refused, lastError: outcome.error }, 'wms_merge_hold_not_held', 'WARNING',
      `Merge hold refused for warehouse order ${row.externalOrderId}: the order is not held.`)
  },

  async recordUnknown(row, error) {
    await moveRow(row, ['HOLDING'], { state: 'UNKNOWN', refused: false, lastError: error }, 'wms_merge_hold_unknown', 'WARNING',
      `Merge hold outcome unknown for warehouse order ${row.externalOrderId}: the request failed or its answer was lost, so the order may be held. IMS reads its status to settle it.`)
  },

  async snapshotShowsHeld(row) {
    const snapshot = await db.wmsOrderStatusSnapshot.findFirst({ where: { orderId: row.orderId }, select: { status: true, externalOrderId: true, lastError: true } })
    return snapshot !== null && snapshot.externalOrderId === row.externalOrderId && !snapshot.lastError && isMergeHeldWarehouseStatus(snapshot.status)
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

  async raiseGroupTask(env, group, states, episodes) {
    const anchor = group.members[0]
    const queryText = mergeHoldQuery(group.members.map((m) => ({ ...m, state: states.get(m.orderId) ?? 'not-held' })), group.warnings, env.connectorLabel)
    await db.$transaction(async (tx) => {
      const created = await raiseWmsOperatorTask(tx, {
        connector: env.connectorId, orderId: anchor.orderId, externalOrderId: anchor.externalOrderId, reason: MERGE_HOLD_TASK_REASON, queryText,
        payload: { orderNumber: anchor.orderNumber, externalOrderNumber: anchor.externalOrderNumber, members: group.members, groupBasis: group.basis, warnings: group.warnings },
        dedupeBasis: mergeHoldTaskBasis(group, episodes),
      })
      if (!created) return
      for (const member of group.members) {
        await logActivityInTransaction(tx, {
          userId: null, entityType: 'SALES_ORDER', entityId: member.orderId, action: 'wms_merge_hold_task_raised', tag: 'sync', level: 'INFO',
          description: `An operator task asks a person to merge order ${orderLabel(member.orderNumber, member.orderId)} with the group's other orders in the warehouse and confirm it there.${states.get(member.orderId) === 'held' ? '' : states.get(member.orderId) === 'unknown' ? ' Whether this order is held is UNKNOWN: check it in the warehouse.' : ' This order is NOT held.'}`,
          metadata: { connector: env.connectorId, orderIds: group.members.map((m) => m.orderId), warnings: group.warnings },
        })
      }
    }, { maxWait: 5_000, timeout: 20_000 })
  },

  async reviseGroupTask(env, groupBasis) {
    await db.$transaction(async (tx) => {
      const open = await tx.wmsOperatorTask.findMany({ where: { connector: env.connectorId, reason: MERGE_HOLD_TASK_REASON, status: 'OPEN' }, select: { id: true, queryText: true, payload: true } })
      const task = open.find((t) => (t.payload as { groupBasis?: string } | null)?.groupBasis === groupBasis)
      if (!task) return
      const payload = task.payload as { members?: MergeHoldMember[]; warnings?: string[] }
      const members = payload.members ?? []
      const rows = await tx.wmsMergeHold.findMany({ where: { connector: env.connectorId, groupBasis, orderId: { in: members.map((m) => m.orderId) } }, select: { orderId: true, state: true } })
      const stateOf = new Map(rows.map((r) => [r.orderId, r.state === 'HELD' ? 'held' : r.state === 'HOLDING' || r.state === 'UNKNOWN' ? 'unknown' : 'not-held'] as [string, MergeHoldTaskState]))
      const queryText = mergeHoldQuery(members.map((m) => ({ ...m, state: stateOf.get(m.orderId) ?? 'not-held' })), payload.warnings ?? [], env.connectorLabel)
      if (queryText === task.queryText) return
      const updated = await tx.wmsOperatorTask.updateMany({ where: { id: task.id, status: 'OPEN' }, data: { queryText } })
      if (updated.count === 0) return
      for (const member of members) {
        await logActivityInTransaction(tx, {
          userId: null, entityType: 'SALES_ORDER', entityId: member.orderId, action: 'wms_merge_hold_task_updated', tag: 'sync', level: 'INFO',
          description: `The merge-hold task for this group was updated: order ${orderLabel(member.orderNumber, member.orderId)} is now ${stateOf.get(member.orderId) === 'held' ? 'held' : stateOf.get(member.orderId) === 'unknown' ? 'of unknown hold state' : 'NOT held'}.`,
          metadata: { connector: env.connectorId, groupBasis, taskId: task.id },
        })
      }
    }, { maxWait: 5_000, timeout: 20_000 })
  },

  async logNotHeld(row, member, refused, error) {
    await logActivity({
      userId: null, entityType: 'SALES_ORDER', entityId: row.orderId, action: 'wms_merge_hold_failed', tag: 'sync', level: 'WARNING',
      description: `Not held: IMS could not put order ${orderLabel(member.orderNumber, member.orderId)} on merge hold in the warehouse (${refused ? 'the warehouse refused it' : 'the request failed and the outcome is unknown'}). ${refused ? 'IMS will not retry.' : 'IMS reads the warehouse status to settle it, then retries if it is still NEW.'} Check the order in the warehouse before it is picked.`,
      metadata: { connector: row.connector, externalOrderId: row.externalOrderId, refused, reason: scrubWmsError(error, 'unknown') },
      resolveUser: false,
    })
  },

  async activeRows(connector) {
    const rows = await db.wmsMergeHold.findMany({
      where: { connector, state: { in: [...ACTIVE] } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true, connector: true, orderId: true, externalOrderId: true, groupBasis: true, state: true, episode: true, attempts: true, refused: true, lastError: true, heldAt: true, remindedAt: true, clearReason: true, updatedAt: true,
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
    return moveRow(row, ['HOLDING', 'UNKNOWN'], { state: 'HELD', heldAt: at, lastError: null, refused: false }, 'wms_merge_hold_placed', 'INFO',
      `Merge hold confirmed by a status read: warehouse order ${row.externalOrderId} is held (awaiting confirmation) so a person can merge it with the customer's other order(s). IMS will not release it; confirm it in the warehouse after merging.`)
  },

  async settleNotHeld(row, error) {
    return moveRow(row, ['HOLDING', 'UNKNOWN'], { state: 'NOT_HELD', refused: false, lastError: error }, 'wms_merge_hold_settled', 'INFO',
      `Merge hold settled as not held: warehouse order ${row.externalOrderId} is still NEW after the attempt, so IMS may retry.`)
  },

  async raiseUnsettledTask(env, obs, kind) {
    const { row } = obs
    const label = orderLabel(obs.orderNumber, row.orderId)
    const status = obs.snapshot?.status ?? ''
    return db.$transaction(async (tx) => {
      const created = await raiseWmsOperatorTask(tx, {
        connector: env.connectorId, orderId: row.orderId, externalOrderId: row.externalOrderId, reason: MERGE_HOLD_TASK_REASON,
        queryText: mergeHoldUnsettledQuery(row.externalOrderId, label, status, kind, env.connectorLabel),
        payload: { orderNumber: obs.orderNumber, kind },
        dedupeBasis: mergeHoldUnsettledBasis(row, status, kind),
      })
      if (!created) return false
      await logActivityInTransaction(tx, {
        userId: null, entityType: 'SALES_ORDER', entityId: row.orderId, action: 'wms_merge_hold_unsettled', tag: 'sync', level: 'WARNING',
        description: kind === 'UNKNOWN_OUTCOME'
          ? `Merge hold outcome still unknown for order ${label}: the warehouse status (${status || 'unreadable'}) is neither held nor NEW. An operator task asks a person to check it.`
          : `The warehouse status '${status || 'unreadable'}' of held order ${label} is not recognised, so IMS kept the hold on record. An operator task asks a person to check it.`,
        metadata: { connector: row.connector, externalOrderId: row.externalOrderId, episode: row.episode, status, kind },
      })
      return true
    }, { maxWait: 5_000, timeout: 20_000 })
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

/** The group bases that still have a member that MAY be held and whose outcome is not settled (HOLDING / UNKNOWN): their candidate task must stay open. */
export async function mergeGroupBasesWithUnsettledHolds(connector: string): Promise<string[]> {
  const rows = await db.wmsMergeHold.findMany({ where: { connector, state: { in: ['HOLDING', 'UNKNOWN'] } }, select: { groupBasis: true } })
  return [...new Set(rows.map((row) => row.groupBasis))]
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
