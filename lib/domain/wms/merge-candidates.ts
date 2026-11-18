import { db } from '@/lib/db'
import type { Prisma } from '@/app/generated/prisma/client'
import { lockSalesOrder } from '@/lib/domain/sales/allocation-service'
import { logActivityInTransaction } from '@/lib/activity-log'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { resolveEnabledWmsConnector, wmsResolutionSkipReason } from '@/lib/connectors/wms/enabled-connector'
import { getWmsConnectorDef, getWmsConnectorHooks } from '@/lib/connectors/wms/registry'
import { getSalesOrderBackorderReport } from '@/lib/domain/inventory/backorder-report'
import { withMergeCandidateLockOrSkip } from './dispatch-sweep-lock'
import { readWmsMergeCandidateMode, type WmsMergeCandidateMode } from './merge-candidate-mode'
import {
  MERGE_OPEN_STATUSES,
  findMergeCandidateGroups,
  type MergeCandidateContext,
  type MergeCandidateOrder,
  type MergeGroup,
} from './merge-candidate-match'
import { isMergeHoldEnabled, placeMergeHolds, type MergeHoldPlacement } from './merge-hold'
import { prismaMergeHoldPort } from './merge-hold-port'
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
/** `stale`: the group no longer qualifies on the CURRENT snapshots, so nothing was raised. */
export type MergeTaskOutcome = 'created' | 'reopened' | 'unchanged' | 'stale'

export type MergeCandidatePort = {
  readMode(): Promise<WmsMergeCandidateMode>
  /** The active connector and whether it is client-scoped, or why detection cannot run. */
  environment(): Promise<MergeCandidateEnvironment | { skipped: string }>
  loadOrders(orderIds?: readonly string[]): Promise<MergeCandidateOrder[]>
  /** Which of these orders have a line the stock does not cover. */
  backorderedAmong(orderIds: readonly string[]): Promise<Set<string>>
  /**
   * Record the group's task (and, for a new or re-opened one, an activity entry per member), atomically, ONLY IF the group still qualifies:
   * the members' CURRENT state is re-read under their order locks (the same locks the status sweep takes to write a snapshot), so a snapshot
   * refreshed after the group was computed cannot be followed by a task that says every order is NEW. Returns `stale` when it does not.
   */
  raiseGroupTask(env: MergeCandidateEnvironment, group: MergeGroup, queryText: string): Promise<MergeTaskOutcome>
  /** A pass that skipped because the lock was busy records that detection is owed; the lock holder reconciles it. */
  markOwed(connector: string): Promise<void>
  /** Clear the owed marker (a pass clears it as it starts: it reads current data, so it satisfies every request made before). */
  clearOwed(connector: string): Promise<void>
  isOwed(connector: string): Promise<boolean>
  /** Resolve this connector's OPEN merge-candidate tasks whose group is not in `keepBases`. Returns how many. */
  resolveTasksNotIn(connector: string, keepBases: readonly string[]): Promise<number>
  /**
   * OPTIONAL (merge holds, setting `wms_merge_hold_enabled`, off by default): hold the orders of these groups in the warehouse. Absent, or the setting off,
   * it does nothing and the pass is exactly the flag-mode pass. A failure is caught by the pass and never fails the detection.
   */
  placeHolds?(env: MergeCandidateEnvironment, groups: readonly MergeGroup[]): Promise<MergeHoldPlacement | null>
  /** Run the whole compute, raise, resolve pass holding the connector's detection lock; `null` when another pass holds it. */
  withLock<T>(connector: string, fn: () => Promise<T>): Promise<T | null>
  now(): Date
}

export type MergeCandidateRun =
  | { mode: 'off'; groups: [] }
  | { mode: 'flag'; skipped: string; groups: [] }
  | { mode: 'flag'; groups: MergeGroup[]; created: number; reopened: number; resolved: number; /** Present only when merge holds are on. */ holds?: MergeHoldPlacement }

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
  // ONE pass at a time per connector: a pass resolves every open task its own groups do not include, so two overlapping passes that saw
  // different groups would each resolve the task the other had just raised. A pass that cannot get the lock skips; the next sweep runs it again.
  // (The alternative, re-checking membership per task under a lock, still needs a lock and still reads the groups twice.)
  //
  // A SKIPPED PASS IS NEVER JUST DROPPED. The status sweep refreshes the snapshots and then runs detection; if it cannot get the lock, the holder
  // is working from older snapshots. So the skipper leaves an "owed" marker, and the holder, when it finishes, runs ONE more pass if the marker
  // is set (it clears the marker as that pass starts). A marker set during that rerun is left for the next sweep: at most one rerun, bounded.
  // Independently of the marker, each group's task is raised only after the members are re-read under their order locks (raiseGroupTask).
  const onePass = async (): Promise<Extract<MergeCandidateRun, { created: number }>> => {
    await port.clearOwed(env.connectorId)
    const groups = await computeGroups(port, env)
    let created = 0
    let reopened = 0
    const kept: string[] = []
    for (const group of groups) {
      const outcome = await port.raiseGroupTask(env, group, mergeGroupTaskText(group, env.connectorLabel))
      if (outcome === 'stale') continue
      kept.push(group.basis)
      if (outcome === 'created') created += 1
      else if (outcome === 'reopened') reopened += 1
    }
    // A stale group is not kept: an open task it already had is resolved like any group that stopped qualifying.
    const resolved = await port.resolveTasksNotIn(env.connectorId, kept)
    const keptGroups = groups.filter((group) => kept.includes(group.basis))
    // MERGE HOLDS (off by default): only groups that still qualified under their order locks just now are held. Non-fatal.
    let holds: MergeHoldPlacement | null = null
    if (port.placeHolds) {
      try {
        holds = await port.placeHolds(env, keptGroups)
      } catch (error) {
        console.warn(`[wms-merge-candidates] merge holds failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { mode: 'flag', groups: keptGroups, created, reopened, resolved, ...(holds ? { holds } : {}) }
  }
  const pass = await port.withLock(env.connectorId, async () => {
    let result = await onePass()
    if (await port.isOwed(env.connectorId)) {
      const again = await onePass()
      const holds = result.holds || again.holds
        ? { held: (result.holds?.held ?? 0) + (again.holds?.held ?? 0), refused: (result.holds?.refused ?? 0) + (again.holds?.refused ?? 0), failed: (result.holds?.failed ?? 0) + (again.holds?.failed ?? 0), shadowed: (result.holds?.shadowed ?? 0) + (again.holds?.shadowed ?? 0), skipped: (result.holds?.skipped ?? 0) + (again.holds?.skipped ?? 0) }
        : undefined
      result = { mode: 'flag', groups: again.groups, created: result.created + again.created, reopened: result.reopened + again.reopened, resolved: result.resolved + again.resolved, ...(holds ? { holds } : {}) }
    }
    return result
  })
  if (pass === null) {
    await port.markOwed(env.connectorId)
    return { mode, skipped: 'Another merge-candidate pass is running; detection is owed and the holder will reconcile it', groups: [] }
  }
  return pass
}

/** What a sweep records of a detection pass: only a failure or a skip is worth a field. Off, or a pass that ran, is nothing. */
export type MergeCandidateNote = { detection: 'did-not-complete' | 'skipped'; reason: string }

export function mergeCandidateNote(run: MergeCandidateRun | { error: string }): MergeCandidateNote | undefined {
  if ('error' in run) return { detection: 'did-not-complete', reason: run.error }
  if ('skipped' in run) return { detection: 'skipped', reason: run.skipped }
  return undefined
}

/** For the sweeps: never throws. A failed detection is logged and must not affect the push or the status sweep. */
export async function runMergeCandidateDetectionSafe(trigger: string, port?: MergeCandidatePort): Promise<MergeCandidateRun | { error: string }> {
  try {
    return await runMergeCandidateDetection(port)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[wms-merge-candidates] detection after ${trigger} failed: ${message}`)
    return { error: message }
  }
}

function taskHash(group: MergeGroup, queryText: string): string {
  return wmsOperatorTaskHash({ reason: MERGE_TASK_REASON, queryText, dedupeBasis: group.basis })
}

/** The open orders that are NEW in the warehouse by their stored snapshot (all of them, or only these). Takes a client so a caller can read inside its own transaction. */
async function loadOrderRows(client: Pick<Prisma.TransactionClient, 'salesOrder'>, orderIds?: readonly string[]): Promise<MergeCandidateOrder[]> {
  const rows = await client.salesOrder.findMany({
    where: {
      ...(orderIds ? { id: { in: [...orderIds] } } : {}),
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
}

const owedKey = (connector: string) => `wms_merge_candidate_owed:${connector}`

const memberLabel = (member: { orderNumber: string | null; orderId: string }) => member.orderNumber ?? member.orderId

export const prismaMergeCandidatePort: MergeCandidatePort = {
  now: () => new Date(),
  async withLock(connector, fn) {
    const outcome = await withMergeCandidateLockOrSkip(connector, fn)
    return outcome !== null && typeof outcome === 'object' && 'lockSkipped' in outcome ? null : outcome as Awaited<ReturnType<typeof fn>>
  },
  readMode: () => readWmsMergeCandidateMode(),
  async placeHolds(env, groups) {
    if (!(await isMergeHoldEnabled())) return null
    return placeMergeHolds(prismaMergeHoldPort, { connectorId: env.connectorId, connectorLabel: env.connectorLabel }, groups)
  },

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

  loadOrders: (orderIds?: readonly string[]) => loadOrderRows(db, orderIds),
  async markOwed(connector) {
    const key = owedKey(connector)
    const value = new Date().toISOString()
    await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
  },
  async clearOwed(connector) {
    await db.setting.deleteMany({ where: { key: owedKey(connector) } })
  },
  async isOwed(connector) {
    return (await db.setting.findUnique({ where: { key: owedKey(connector) }, select: { key: true } })) !== null
  },
  async backorderedAmong(orderIds) {
    const out = new Set<string>()
    for (const id of new Set(orderIds)) {
      const report = await getSalesOrderBackorderReport(id)
      if (report.lines.some((line) => line.unallocatedQty > 0)) out.add(id)
    }
    return out
  },

  async raiseGroupTask(env, group, queryText) {
    const connector = env.connectorId
    const anchor = group.members[0]
    const memberIds = group.members.map((member) => member.orderId)
    const backordered = await prismaMergeCandidatePort.backorderedAmong(memberIds)
    const payload: WmsOperatorTaskPayload = {
      orderNumber: anchor.orderNumber,
      externalOrderNumber: anchor.externalOrderNumber,
      members: group.members.map((member) => ({ orderId: member.orderId, orderNumber: member.orderNumber, externalOrderNumber: member.externalOrderNumber })),
    }
    const hash = taskHash(group, queryText)
    return db.$transaction(async (tx): Promise<MergeTaskOutcome> => {
      // Under the members' order locks (the status sweep takes the same lock to write a snapshot) read their CURRENT state and raise only if
      // the group still qualifies exactly as computed.
      for (const id of [...memberIds].sort()) await lockSalesOrder(tx, id)
      const fresh = findMergeCandidateGroups(await loadOrderRows(tx, memberIds), { connectorId: env.connectorId, tenantScoped: env.tenantScoped, now: new Date(), excludedOrderIds: backordered })
      if (!fresh.some((candidate) => candidate.basis === group.basis)) return 'stale'
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
