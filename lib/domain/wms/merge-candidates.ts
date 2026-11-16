import { db } from '@/lib/db'
import { logActivityInTransaction } from '@/lib/activity-log'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { resolveEnabledWmsConnector, wmsResolutionSkipReason } from '@/lib/connectors/wms/enabled-connector'
import { getWmsConnectorDef, getWmsConnectorHooks } from '@/lib/connectors/wms/registry'
import { getSalesOrderBackorderReport } from '@/lib/domain/inventory/backorder-report'
import { readWmsMergeCandidateMode, type WmsMergeCandidateMode } from './merge-candidate-mode'
import {
  MERGE_OPEN_STATUSES,
  findMergeCandidateGroups,
  type MergeCandidateContext,
  type MergeCandidateOrder,
  type MergeGroup,
} from './merge-candidate-match'
import { mergeCandidateQuery, raiseWmsOperatorTask, wmsOperatorTaskHash, type WmsOperatorTaskPayload } from './operator-tasks'

/**
 * MERGE CANDIDATES, FLAG MODE (o3d-zvec.11).
 *
 * Finds groups of the customer's open orders that are all still NEW in the warehouse (see merge-candidate-match.ts for the rules) and tells a
 * PERSON: a Mergeable badge on each order, an activity entry, a list on the Mintsoft screen, and ONE operator task per group ("check these
 * orders in Mintsoft and merge them there if appropriate"). Warehouse staff do not read order notes, so there is no warehouse or storefront
 * note. IMS never merges (the warehouse has no merge API), and THIS MODULE MAKES NO WAREHOUSE OR STOREFRONT CALL AND WRITES NOTHING TO EITHER:
 * the status it reads is the stored snapshot the status sweep keeps current.
 *
 * WHEN IT RUNS (only in `flag` mode; `off`, the default, computes and writes nothing):
 *   - at the end of an order push sweep that created at least one warehouse order (the bead's "after IMS pushes an order"), and
 *   - at the end of every order-status sweep. A snapshot is what proves "still NEW", and a freshly pushed order has none until the status
 *     sweep has read it, so the push-time pass alone would nearly always see nothing; the status pass is what makes candidates appear, and
 *     what resolves a group when an order leaves NEW. Both passes are database reads and writes only.
 * A failure here is caught by the caller and never reaches the push or the status sweep.
 *
 * THE TASK. One per group, keyed on the set of orders (so a chain that grows is a new task and the old one is resolved). A group that stops
 * qualifying (an order left NEW, shipped, was cancelled, the address changed) has its OPEN task resolved by the system (Done, by
 * MERGE_TASK_SYSTEM_ACTOR). If the group qualifies again, a task the system resolved is re-opened; one a person marked Done is left done.
 */

export const MERGE_TASK_REASON = 'MERGE_CANDIDATE' as const
/** `doneBy` of a task the system resolved because its group stopped qualifying (never a user id). */
export const MERGE_TASK_SYSTEM_ACTOR = 'system:merge-candidate-cleared'

export type MergeCandidateEnvironment = { connectorId: string; /** The connector's display name, for the task text. */ connectorLabel: string; tenantScoped: boolean }
export type MergeTaskOutcome = 'created' | 'reopened' | 'unchanged'

export type MergeCandidatePort = {
  readMode(): Promise<WmsMergeCandidateMode>
  /** The active connector and whether it is client-scoped, or why detection cannot run. */
  environment(): Promise<MergeCandidateEnvironment | { skipped: string }>
  loadOrders(): Promise<MergeCandidateOrder[]>
  /** Which of these orders have a line the stock does not cover. */
  backorderedAmong(orderIds: readonly string[]): Promise<Set<string>>
  /** Record the group's task (and, for a new or re-opened one, an activity entry per member), atomically. */
  raiseGroupTask(connector: string, group: MergeGroup, queryText: string): Promise<MergeTaskOutcome>
  /** Resolve this connector's OPEN merge-candidate tasks whose group is not in `keepBases`. Returns how many. */
  resolveTasksNotIn(connector: string, keepBases: readonly string[]): Promise<number>
  now(): Date
}

export type MergeCandidateRun =
  | { mode: 'off'; groups: [] }
  | { mode: 'flag'; skipped: string; groups: [] }
  | { mode: 'flag'; groups: MergeGroup[]; created: number; reopened: number; resolved: number }

/** The groups, computed from the port's data. Writes nothing. */
async function computeGroups(port: MergeCandidatePort, env: MergeCandidateEnvironment): Promise<MergeGroup[]> {
  const orders = await port.loadOrders()
  const ctx: MergeCandidateContext = { connectorId: env.connectorId, tenantScoped: env.tenantScoped, now: port.now() }
  const first = findMergeCandidateGroups(orders, ctx)
  if (first.length === 0) return first
  // Backorder state is read only for orders that already sit in a group: the allocation report is one query set per order.
  const backordered = await port.backorderedAmong(first.flatMap((group) => group.members.map((member) => member.orderId)))
  if (backordered.size === 0) return first
  return findMergeCandidateGroups(orders, { ...ctx, excludedOrderIds: backordered })
}

/** READ ONLY: the current groups and the mode (the badge and the Mintsoft list). `off` computes nothing. */
export async function listMergeCandidateGroups(port: MergeCandidatePort = prismaMergeCandidatePort): Promise<{ mode: WmsMergeCandidateMode; groups: MergeGroup[] }> {
  const mode = await port.readMode()
  if (mode === 'off') return { mode, groups: [] }
  const env = await port.environment()
  if ('skipped' in env) return { mode, groups: [] }
  return { mode, groups: await computeGroups(port, env) }
}

export function mergeGroupTaskText(group: MergeGroup, warehouseLabel: string): string {
  return mergeCandidateQuery(group.members, group.warnings, warehouseLabel)
}

export async function runMergeCandidateDetection(port: MergeCandidatePort = prismaMergeCandidatePort): Promise<MergeCandidateRun> {
  const mode = await port.readMode()
  if (mode === 'off') return { mode: 'off', groups: [] }
  const env = await port.environment()
  if ('skipped' in env) return { mode, skipped: env.skipped, groups: [] }
  const groups = await computeGroups(port, env)
  let created = 0
  let reopened = 0
  for (const group of groups) {
    const outcome = await port.raiseGroupTask(env.connectorId, group, mergeGroupTaskText(group, env.connectorLabel))
    if (outcome === 'created') created += 1
    else if (outcome === 'reopened') reopened += 1
  }
  const resolved = await port.resolveTasksNotIn(env.connectorId, groups.map((group) => group.basis))
  return { mode, groups, created, reopened, resolved }
}

/** For the sweeps: never throws. A failed detection is logged and must not affect the push or the status sweep. */
export async function runMergeCandidateDetectionSafe(trigger: string, port?: MergeCandidatePort): Promise<MergeCandidateRun | { error: string }> {
  try {
    return await runMergeCandidateDetection(port)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[wms-merge-candidates] detection after ${trigger} failed: ${message}`)
    return { error: message }
  }
}

function taskHash(group: MergeGroup, queryText: string): string {
  return wmsOperatorTaskHash({ reason: MERGE_TASK_REASON, queryText, dedupeBasis: group.basis })
}

const memberLabel = (member: { orderNumber: string | null; orderId: string }) => member.orderNumber ?? member.orderId

export const prismaMergeCandidatePort: MergeCandidatePort = {
  now: () => new Date(),
  readMode: () => readWmsMergeCandidateMode(),

  async environment() {
    const state = await getIntegrationPluginState()
    const resolution = resolveEnabledWmsConnector(state)
    if (resolution.kind !== 'one') return { skipped: wmsResolutionSkipReason(resolution) }
    // The warehouse is a shared 3PL tenant. Every stored status was read through a lookup scoped to our client, and a row of another client is
    // refused there, so a snapshot is ours only while the connector says it is client-scoped: the same precondition the dispatch sweep runs
    // under (a connector that declares none is not trusted). No warehouse call is made.
    const precondition = getWmsConnectorHooks(resolution.id).dispatchPrecondition
    const scoped = precondition ? (await precondition()).ok : false
    return { connectorId: resolution.id, connectorLabel: getWmsConnectorDef(resolution.id).label, tenantScoped: scoped }
  },

  async loadOrders() {
    const rows = await db.salesOrder.findMany({
      where: {
        status: { in: [...MERGE_OPEN_STATUSES] as never },
        shippedAt: null,
        erasedAt: null,
        wmsOrderStatus: { is: { status: { equals: 'NEW', mode: 'insensitive' } } },
        wmsOrderPush: { is: { state: { in: ['SYNCED', 'MERGED'] } } },
      },
      select: {
        id: true, orderNumber: true, createdAt: true, status: true, shippedAt: true, refundStatus: true, withdrawalHoldAt: true, withdrawalApprovedAt: true,
        erasedAt: true, archived: true, customerName: true, customerEmail: true, billingAddress: true, shippingAddress: true,
        shippingService: true, courierKey: true, shippingMethodId: true,
        wmsOrderPush: { select: { connector: true, state: true, externalOrderId: true, externalOrderNumber: true } },
        wmsOrderStatus: { select: { connector: true, status: true, externalOrderId: true, externalOrderNumber: true, isSplit: true, fetchedAt: true, lastError: true } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    return rows.map((row): MergeCandidateOrder => ({
      orderId: row.id,
      orderNumber: row.orderNumber,
      createdAt: row.createdAt,
      status: row.status,
      shippedAt: row.shippedAt,
      refundStatus: row.refundStatus,
      withdrawalHoldAt: row.withdrawalHoldAt,
      withdrawalApprovedAt: row.withdrawalApprovedAt,
      erasedAt: row.erasedAt,
      archived: row.archived,
      customerName: row.customerName,
      customerEmail: row.customerEmail,
      billingAddress: row.billingAddress,
      shippingAddress: row.shippingAddress,
      courierText: [row.shippingService, row.courierKey, row.shippingMethodId],
      link: row.wmsOrderPush,
      snapshot: row.wmsOrderStatus,
    }))
  },

  async backorderedAmong(orderIds) {
    const out = new Set<string>()
    for (const id of new Set(orderIds)) {
      const report = await getSalesOrderBackorderReport(id)
      if (report.lines.some((line) => line.unallocatedQty > 0)) out.add(id)
    }
    return out
  },

  async raiseGroupTask(connector, group, queryText) {
    const anchor = group.members[0]
    const payload: WmsOperatorTaskPayload = {
      orderNumber: anchor.orderNumber,
      externalOrderNumber: anchor.externalOrderNumber,
      members: group.members.map((member) => ({ orderId: member.orderId, orderNumber: member.orderNumber, externalOrderNumber: member.externalOrderNumber })),
    }
    const hash = taskHash(group, queryText)
    return db.$transaction(async (tx) => {
      const created = await raiseWmsOperatorTask(tx, {
        connector, orderId: anchor.orderId, externalOrderId: anchor.externalOrderId, reason: MERGE_TASK_REASON, queryText, payload, dedupeBasis: group.basis,
      })
      let outcome: MergeTaskOutcome = created ? 'created' : 'unchanged'
      if (!created) {
        const existing = await tx.wmsOperatorTask.findFirst({
          where: { connector, orderId: anchor.orderId, externalOrderId: anchor.externalOrderId, reason: MERGE_TASK_REASON, contentHash: hash },
          select: { id: true, status: true, doneBy: true, queryText: true },
        })
        if (existing?.status === 'DONE' && existing.doneBy === MERGE_TASK_SYSTEM_ACTOR) {
          const reopened = await tx.wmsOperatorTask.updateMany({
            where: { id: existing.id, status: 'DONE', doneBy: MERGE_TASK_SYSTEM_ACTOR },
            data: { status: 'OPEN', doneAt: null, doneBy: null, queryText, payload: payload as never },
          })
          if (reopened.count > 0) outcome = 'reopened'
        } else if (existing?.status === 'OPEN' && existing.queryText !== queryText) {
          await tx.wmsOperatorTask.updateMany({ where: { id: existing.id, status: 'OPEN' }, data: { queryText, payload: payload as never } })
        }
      }
      if (outcome !== 'unchanged') {
        const numbers = group.members.map(memberLabel).join(', ')
        for (const member of group.members) {
          await logActivityInTransaction(tx, {
            userId: null,
            entityType: 'SALES_ORDER',
            entityId: member.orderId,
            action: 'wms_merge_candidate_flagged',
            tag: 'sync',
            level: 'INFO',
            description: `Mergeable: order ${memberLabel(member)} is for the same customer and address as ${group.members.length - 1} other open order(s) that are all still NEW in the warehouse (${numbers}). An operator task asks a person to check them in the warehouse system and merge them there if appropriate. IMS changed nothing in the warehouse.`,
            metadata: { connector, orderIds: group.members.map((m) => m.orderId), warnings: group.warnings, outcome },
          })
        }
      }
      return outcome
    }, { maxWait: 5_000, timeout: 20_000 })
  },

  async resolveTasksNotIn(connector, keepBases) {
    const keep = new Set(keepBases.map((basis) => wmsOperatorTaskHash({ reason: MERGE_TASK_REASON, queryText: '', dedupeBasis: basis })))
    const open = await db.wmsOperatorTask.findMany({
      where: { connector, reason: MERGE_TASK_REASON, status: 'OPEN' },
      select: { id: true, orderId: true, contentHash: true, order: { select: { orderNumber: true } } },
    })
    const stale = open.filter((task) => !keep.has(task.contentHash))
    let resolved = 0
    for (const task of stale) {
      await db.$transaction(async (tx) => {
        const at = new Date()
        const flipped = await tx.wmsOperatorTask.updateMany({ where: { id: task.id, status: 'OPEN' }, data: { status: 'DONE', doneAt: at, doneBy: MERGE_TASK_SYSTEM_ACTOR } })
        if (flipped.count === 0) return
        resolved += 1
        await logActivityInTransaction(tx, {
          userId: null,
          entityType: 'SALES_ORDER',
          entityId: task.orderId,
          action: 'wms_merge_candidate_cleared',
          tag: 'sync',
          level: 'INFO',
          description: `Merge candidate cleared for order ${task.order.orderNumber ?? task.orderId}: the group no longer qualifies (an order left NEW in the warehouse, shipped, was cancelled or changed), so its operator task was resolved.`,
          metadata: { connector, taskId: task.id },
        })
      }, { maxWait: 5_000, timeout: 20_000 })
    }
    return resolved
  },
}
