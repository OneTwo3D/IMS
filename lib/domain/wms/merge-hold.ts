import { getSettingValue } from '@/lib/settings-store'
import type { WmsOrderHoldResult } from '@/lib/connectors/wms/types'
import type { MergeGroup } from './merge-candidate-match'
import { warehouseOrderRef, wmsOperatorTaskHash, type WmsOperatorTaskInput } from './operator-tasks'

/**
 * MERGE HOLDS (o3d-zvec.12 / o3d-zvec.13). OFF BY DEFAULT: setting `wms_merge_hold_enabled`, only an explicit `true` turns it on.
 *
 * WHAT IT DOES (only when the setting is on AND merge-candidate detection is in `flag` mode, because the groups come from the detection):
 * every order of a same-customer group that is still NEW in the warehouse is HELD there (awaiting confirmation, the order stays alive), so a person
 * can merge them in the warehouse's own screens. IMS never merges.
 *
 * WHERE THE HOLD LIVES. In IMS, in `wms_merge_holds`, one row per order and episode. NOT in warehouse text: a warehouse comment is immutable and an
 * operator's own confirm writes no tombstone, so a marker in warehouse text cannot say whether the hold is still the current one (the stale-marker hazard
 * of o3d-3a0t). A hold is current only while its row is HOLDING / HELD for the warehouse order the row names, and it clears on an OBSERVED status read
 * taken after the hold: the stored status snapshot no longer says awaiting confirmation, or the order was merged.
 *
 * THE WAREHOUSE-FACING PART IS AN OPERATOR TASK ("Raise a warehouse query"), never a warehouse or storefront order note (owner ruling, 2026-11-16).
 * The EU and FedEx warnings ride on that task.
 *
 * NEVER AUTO-RELEASE. There is no release verb on the connector and no code path in IMS that confirms a held order: a person confirms it in the warehouse
 * after merging. tests/wms-merge-holds.test.ts reads the sources and is red if a release call appears.
 *
 * WHILE HELD: an edit or a cancel is not pushed (the push sweep's queries leave the order out), a pending edit shows as "act in" the warehouse system, and a
 * withdrawal or cancel escalates to a person by an operator task. The hold itself is never cancelled or released by IMS.
 *
 * FAILURES ARE NON-FATAL. A hold that did not land leaves the order "not held" (row NOT_HELD, shown in the badge); one order's failure never stops the
 * others, the detection or the sweep. A transport failure (unknown outcome) is retried a bounded number of times; a definite refusal is not.
 */

export const WMS_MERGE_HOLD_ENABLED_SETTING = 'wms_merge_hold_enabled'

/** Only an explicit `true` is on. An unreadable setting is off. */
export async function isMergeHoldEnabled(): Promise<boolean> {
  try {
    return (await getSettingValue(WMS_MERGE_HOLD_ENABLED_SETTING)) === 'true'
  } catch {
    return false
  }
}

export const MERGE_HOLD_REMIND_HOURS_DEFAULT = 4
/** Environment variable that tunes the reminder age, in hours. A non-positive or unreadable value is the default. */
export const MERGE_HOLD_REMIND_HOURS_ENV = 'MERGE_HOLD_REMIND_HOURS'

export function mergeHoldRemindHours(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env[MERGE_HOLD_REMIND_HOURS_ENV])
  return Number.isFinite(raw) && raw > 0 ? raw : MERGE_HOLD_REMIND_HOURS_DEFAULT
}

/** Transport failures are retried this many times in all; then the order stays "not held" for a person. */
export const MERGE_HOLD_MAX_ATTEMPTS = 5

/**
 * The warehouse status name that means "held awaiting confirmation" on a stored snapshot (case, spaces, underscores and hyphens ignored).
 * UNVERIFIED AGAINST THE LIVE WAREHOUSE (no call may be made to it from here): confirming this name is step 3 of the controlled run in docs/mintsoft.md.
 */
export const MERGE_HOLD_WAREHOUSE_STATUS = 'AWAITINGCONFIRMATION'

export function isMergeHeldWarehouseStatus(status: string | null | undefined): boolean {
  return (status ?? '').toUpperCase().replace(/[^A-Z]/g, '') === MERGE_HOLD_WAREHOUSE_STATUS
}

export const mergeHoldActInWarehouse = (warehouseLabel: string): string => `This order is on merge hold in the warehouse, so IMS did not send the change. Act in ${warehouseLabel}.`

export const MERGE_HOLD_TASK_REASON = 'MERGE_HOLD' as const
export const MERGE_HOLD_OVERDUE_TASK_REASON = 'MERGE_HOLD_OVERDUE' as const
export const MERGE_HOLD_WITHDRAWAL_TASK_REASON = 'MERGE_HOLD_WITHDRAWAL' as const
/** `clearReason` of a hold row. */
export const MERGE_HOLD_CLEAR_LEFT_STATUS = 'left awaiting confirmation'
export const MERGE_HOLD_CLEAR_MERGED = 'merge detected'
export const MERGE_HOLD_CLEAR_SHIPPED = 'order despatched'
export const MERGE_HOLD_CLEAR_NOT_LANDED = 'hold did not land'

export type MergeHoldState = 'HOLDING' | 'HELD' | 'NOT_HELD' | 'CLEARED'

export type MergeHoldMember = { orderId: string; orderNumber: string | null; externalOrderId: string; externalOrderNumber: string }

export type MergeHoldRow = {
  id: string
  connector: string
  orderId: string
  externalOrderId: string
  groupBasis: string
  state: MergeHoldState
  episode: number
  attempts: number
  refused: boolean
  lastError: string | null
  heldAt: Date | null
  remindedAt: Date | null
  updatedAt: Date
}

/** What a hold request ended as, for the pass's result. */
export type MergeHoldOutcome = 'held' | 'refused' | 'failed' | 'shadowed' | 'skipped'

// ---------------------------------------------------------------------------------------------------------------------------------------
// The operator-task text. Order numbers only; one place.
// ---------------------------------------------------------------------------------------------------------------------------------------

type TaskMember = { orderNumber: string | null; externalOrderId: string; externalOrderNumber: string; held: boolean }

export function mergeHoldQuery(members: ReadonlyArray<TaskMember>, warnings: ReadonlyArray<string>, warehouseLabel: string): string {
  const ref = (m: TaskMember) => `${warehouseOrderRef(m.externalOrderNumber, m.externalOrderId)} (IMS order ${m.orderNumber ?? '—'})`
  const held = members.filter((m) => m.held).map(ref)
  const notHeld = members.filter((m) => !m.held).map(ref)
  const extra = warnings.length > 0 ? ` Warning: ${warnings.join(' ')}` : ''
  const missed = notHeld.length > 0 ? ` NOT held (IMS could not hold it; check it in ${warehouseLabel} before it is picked): ${notHeld.join(', ')}.` : ''
  return `These orders are for the same customer and delivery address. IMS has put them on HOLD in ${warehouseLabel} (awaiting confirmation) so they can be merged: ${held.join(', ')}.${missed} `
    + `Please merge them in ${warehouseLabel}, then confirm the merged order there yourself. IMS does not merge orders and will NOT release the hold: until you confirm it, the order is not picked. IMS sends no change to a held order.${extra}`
}

export function mergeHoldOverdueQuery(wmsOrder: string, imsOrder: string, hours: number, warehouseLabel: string): string {
  return `${warehouseLabel} order ${wmsOrder} (IMS order ${imsOrder}) has been on merge hold for more than ${hours} hour(s). Please merge it with the customer's other order(s) and confirm it in ${warehouseLabel}, or confirm it as it is if it should not be merged. IMS will not release the hold: nothing ships until a person confirms it.`
}

export function mergeHoldWithdrawalQuery(wmsOrder: string, imsOrder: string, kind: 'WITHDRAWAL' | 'CANCEL', warehouseLabel: string): string {
  const what = kind === 'WITHDRAWAL' ? 'has a customer withdrawal' : 'was cancelled or fully refunded in IMS'
  return `IMS order ${imsOrder} ${what}, but ${warehouseLabel} order ${wmsOrder} is on merge hold. IMS did NOT cancel or release it (it may be merged with another customer order). `
    + `Act in ${warehouseLabel}: decide whether to cancel it, take this order's lines out of the merged order, or confirm it; IMS changes nothing there.`
}

export const mergeHoldTaskBasis = (group: Pick<MergeGroup, 'basis'>, episodes: ReadonlyArray<number>): string => `merge-hold:${group.basis}:${[...episodes].join('.')}`
export const mergeHoldOverdueBasis = (row: Pick<MergeHoldRow, 'orderId' | 'episode'>): string => `merge-hold-overdue:${row.orderId}:${row.episode}`
export const mergeHoldWithdrawalBasis = (row: Pick<MergeHoldRow, 'orderId' | 'episode'>, kind: string): string => `merge-hold-withdrawal:${row.orderId}:${row.episode}:${kind}`

/** The dedupe hash a task of this reason and basis carries (exposed for tests and the clear-by-system lookups). */
export const mergeHoldTaskHash = (reason: WmsOperatorTaskInput['reason'], dedupeBasis: string): string => wmsOperatorTaskHash({ reason, queryText: '', dedupeBasis })

// ---------------------------------------------------------------------------------------------------------------------------------------
// The port: everything the passes read and write, so they are testable without a database or a warehouse.
// ---------------------------------------------------------------------------------------------------------------------------------------

export type MergeHoldEnvironment = { connectorId: string; connectorLabel: string }

/** What a clear / remind / blocked pass reads about one active hold row. */
export type MergeHoldObservation = {
  row: MergeHoldRow
  orderNumber: string | null
  orderStatus: string
  refundStatus: string
  shippedAt: Date | null
  withdrawalHoldAt: Date | null
  withdrawalApprovedAt: Date | null
  /** The order was changed after its last warehouse push (an edit IMS has not sent and will not send while held). */
  editPending: boolean
  link: { state: string; externalOrderId: string | null } | null
  snapshot: { status: string; externalOrderId: string; fetchedAt: Date; lastError: string | null } | null
}

export type MergeHoldPort = {
  now(): Date
  isEnabled(): Promise<boolean>
  /**
   * Begin an attempt for this order: write (or re-arm) its row as HOLDING BEFORE any request leaves, and return it. Null when no attempt is due: an active
   * (HOLDING / HELD) row exists, a refusal for the same warehouse order stands, or the attempts are spent.
   */
  beginHold(env: MergeHoldEnvironment, member: MergeHoldMember, groupBasis: string): Promise<MergeHoldRow | null>
  /**
   * THE request. It asks the producer-side hold FIRST and sends nothing when that shadows the operation (`{ shadowed: true }`). Throws when the outcome is
   * unknown (transport).
   */
  requestHold(env: MergeHoldEnvironment, member: MergeHoldMember): Promise<WmsOrderHoldResult | { shadowed: true }>
  /** The producer-side hold shadowed the request: nothing was sent, so the attempt is taken back (the row does not stay active and no attempt is spent). */
  abandonHold(row: MergeHoldRow): Promise<void>
  recordHeld(row: MergeHoldRow, at: Date): Promise<void>
  recordNotHeld(row: MergeHoldRow, outcome: { refused: boolean; error: string }): Promise<void>
  /** Transport-failed rows that may be retried: NOT_HELD, not refused, attempts left, with a sibling of the same group still active. */
  retryableMembers(env: MergeHoldEnvironment): Promise<Array<{ member: MergeHoldMember; groupBasis: string }>>
  /** The group's operator task (once) and an activity entry per member. `heldFlags` says which members are held. */
  raiseGroupTask(env: MergeHoldEnvironment, group: { basis: string; members: MergeHoldMember[]; warnings: string[] }, heldFlags: ReadonlyMap<string, boolean>, episodes: number[]): Promise<void>
  /** Activity entry for an order whose hold did not land. */
  logNotHeld(row: MergeHoldRow, member: MergeHoldMember, refused: boolean, error: string): Promise<void>
  activeRows(connector: string): Promise<MergeHoldObservation[]>
  /** Move a row to CLEARED (compare-and-set on its active state), with an activity entry. False when another writer already moved it. */
  clear(row: MergeHoldRow, reason: string, at: Date): Promise<boolean>
  /** A HOLDING row whose status read proves the hold landed: HELD. */
  promoteToHeld(row: MergeHoldRow, at: Date): Promise<boolean>
  /** A HOLDING row whose status read proves the hold did NOT land: NOT_HELD (retryable). */
  demoteToNotHeld(row: MergeHoldRow, error: string): Promise<boolean>
  /** The overdue reminder, ONCE: compare-and-set `remindedAt` and raise the task, the warning entry and the notification in the same step. True when this call fired it. */
  remind(env: MergeHoldEnvironment, obs: MergeHoldObservation, hours: number, at: Date): Promise<boolean>
  /** An edit IMS did not push: shown as "act in" the warehouse system while the hold stands. */
  showEditBlocked(env: MergeHoldEnvironment, obs: MergeHoldObservation): Promise<void>
  /** Close the "act in Mintsoft" row of a hold that has cleared. */
  closeEditBlocked(orderId: string): Promise<void>
  /** A withdrawal or cancel reached a held order: one task for a person (once per episode and kind). */
  escalate(env: MergeHoldEnvironment, obs: MergeHoldObservation, kind: 'WITHDRAWAL' | 'CANCEL'): Promise<void>
}

export type MergeHoldPlacement = { held: number; refused: number; failed: number; shadowed: number; skipped: number }

const scrub = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 300)

/** One hold attempt on one order. Never throws. */
async function attemptHold(port: MergeHoldPort, env: MergeHoldEnvironment, member: MergeHoldMember, groupBasis: string): Promise<{ outcome: MergeHoldOutcome; row: MergeHoldRow | null }> {
  const row = await port.beginHold(env, member, groupBasis)
  if (!row) return { outcome: 'skipped', row: null }
  try {
    const answer = await port.requestHold(env, member)
    if ('shadowed' in answer) {
      await port.abandonHold(row)
      return { outcome: 'shadowed', row }
    }
    if (answer.held) {
      await port.recordHeld(row, port.now())
      return { outcome: 'held', row }
    }
    const reason = `${answer.status}${answer.message ? `: ${answer.message}` : ''}`
    await port.recordNotHeld(row, { refused: true, error: reason })
    await port.logNotHeld(row, member, true, reason)
    return { outcome: 'refused', row }
  } catch (error) {
    // The outcome is UNKNOWN: it is not a refusal and not a hold. The row says "not held, retryable"; a later status read can still prove the hold landed.
    const message = scrub(error)
    try {
      await port.recordNotHeld(row, { refused: false, error: message })
      await port.logNotHeld(row, member, false, message)
    } catch (writeError) {
      console.error('[wms-merge-hold] could not record a failed hold', scrub(writeError))
    }
    return { outcome: 'failed', row }
  }
}

/**
 * Hold every order of each group (and retry the orders of a group whose earlier attempt failed in transport). Non-fatal: a failing order is recorded and
 * the others go on. Raises ONE operator task per group once at least one order is held. A no-op unless the setting is on.
 */
export async function placeMergeHolds(port: MergeHoldPort, env: MergeHoldEnvironment, groups: ReadonlyArray<MergeGroup>): Promise<MergeHoldPlacement> {
  const total: MergeHoldPlacement = { held: 0, refused: 0, failed: 0, shadowed: 0, skipped: 0 }
  if (!(await port.isEnabled())) return total
  const attempted = new Set<string>()
  const count = (outcome: MergeHoldOutcome) => { total[outcome === 'held' ? 'held' : outcome === 'refused' ? 'refused' : outcome === 'failed' ? 'failed' : outcome === 'shadowed' ? 'shadowed' : 'skipped'] += 1 }

  for (const group of groups) {
    const heldFlags = new Map<string, boolean>()
    const episodes: number[] = []
    let heldHere = 0
    for (const member of group.members) {
      attempted.add(member.orderId)
      const { outcome, row } = await attemptHold(port, env, member, group.basis)
      count(outcome)
      heldFlags.set(member.orderId, outcome === 'held')
      if (outcome === 'held' && row) {
        heldHere += 1
        episodes.push(row.episode)
      }
    }
    if (heldHere === 0) continue
    try {
      await port.raiseGroupTask(env, { basis: group.basis, members: group.members, warnings: group.warnings }, heldFlags, episodes)
    } catch (error) {
      console.error('[wms-merge-hold] could not raise the merge-hold task', scrub(error))
    }
  }

  // An order whose hold failed in transport while a sibling got held no longer sits in a detected group (the held one left NEW), so it is retried here.
  const retry = await port.retryableMembers(env)
  const byGroup = new Map<string, MergeHoldMember[]>()
  // (An order already tried in THIS pass waits for the next one: one pass spends one attempt per order.)
  for (const { member, groupBasis } of retry.filter((entry) => !attempted.has(entry.member.orderId))) byGroup.set(groupBasis, [...(byGroup.get(groupBasis) ?? []), member])
  for (const [basis, members] of byGroup) {
    for (const member of members) {
      const { outcome } = await attemptHold(port, env, member, basis)
      count(outcome)
    }
  }
  return total
}

export type MergeHoldMaintenance = { cleared: number; confirmedHeld: number; reminded: number; editsBlocked: number; escalated: number }

/**
 * The upkeep of the holds that stand: CLEAR a hold on an observed status change or a merge, fire the overdue REMINDER once, show a pending edit as
 * "act in Mintsoft" and ESCALATE a withdrawal or cancel. Reads IMS state only (the stored status snapshot): no warehouse call. Runs whether or not the
 * setting is on, so a hold placed before it was turned off still clears and is still reminded; with no active row it writes nothing.
 */
export async function runMergeHoldMaintenance(port: MergeHoldPort, env: MergeHoldEnvironment, options?: { hours?: number }): Promise<MergeHoldMaintenance> {
  const result: MergeHoldMaintenance = { cleared: 0, confirmedHeld: 0, reminded: 0, editsBlocked: 0, escalated: 0 }
  const hours = options?.hours ?? mergeHoldRemindHours()
  const now = port.now()
  for (const obs of await port.activeRows(env.connectorId)) {
    const { row } = obs
    // 1. CLEAR on evidence. The hold is the one this row names: a link re-pointed to another warehouse order (a merge IMS detected) is not it any more.
    const mergedAway = obs.link !== null && (obs.link.state === 'MERGED' || obs.link.externalOrderId !== row.externalOrderId)
    if (mergedAway) {
      if (await port.clear(row, MERGE_HOLD_CLEAR_MERGED, now)) result.cleared += 1
      await port.closeEditBlocked(row.orderId).catch(() => {})
      continue
    }
    if (obs.shippedAt || ['SHIPPED', 'COMPLETED', 'DELIVERED'].includes(obs.orderStatus)) {
      if (await port.clear(row, MERGE_HOLD_CLEAR_SHIPPED, now)) result.cleared += 1
      await port.closeEditBlocked(row.orderId).catch(() => {})
      continue
    }
    // A snapshot proves anything only if it is for THIS warehouse order, was read AFTER the hold was recorded, and carries no lookup error.
    const since = row.heldAt ?? row.updatedAt
    const observed = obs.snapshot && obs.snapshot.externalOrderId === row.externalOrderId && !obs.snapshot.lastError && obs.snapshot.fetchedAt.getTime() > since.getTime() ? obs.snapshot : null
    if (observed) {
      const heldNow = isMergeHeldWarehouseStatus(observed.status)
      if (row.state === 'HOLDING') {
        if (heldNow) {
          if (await port.promoteToHeld(row, now)) result.confirmedHeld += 1
        } else if (await port.demoteToNotHeld(row, `${MERGE_HOLD_CLEAR_NOT_LANDED}: the warehouse still shows ${observed.status}`)) {
          // The request's answer was lost and the warehouse shows the order as it was: not held, and retryable.
        }
        continue
      }
      if (!heldNow) {
        if (await port.clear(row, `${MERGE_HOLD_CLEAR_LEFT_STATUS} (now ${observed.status || 'unknown'})`, now)) result.cleared += 1
        await port.closeEditBlocked(row.orderId).catch(() => {})
        continue
      }
    }
    if (row.state !== 'HELD') continue
    // 2. REMIND, once.
    if (row.heldAt && row.remindedAt === null && now.getTime() - row.heldAt.getTime() >= hours * 3_600_000) {
      try {
        if (await port.remind(env, obs, hours, now)) result.reminded += 1
      } catch (error) {
        console.error('[wms-merge-hold] could not raise the overdue reminder', scrub(error))
      }
    }
    // 3. WHILE HELD: nothing is pushed. Say so, and send a withdrawal or cancel to a person.
    try {
      if (obs.withdrawalHoldAt || obs.withdrawalApprovedAt) {
        await port.escalate(env, obs, 'WITHDRAWAL')
        result.escalated += 1
      } else if (obs.orderStatus === 'CANCELLED' || obs.refundStatus === 'FULL') {
        await port.escalate(env, obs, 'CANCEL')
        result.escalated += 1
      } else if (obs.editPending) {
        await port.showEditBlocked(env, obs)
        result.editsBlocked += 1
      }
    } catch (error) {
      console.error('[wms-merge-hold] could not record a blocked change', scrub(error))
    }
  }
  return result
}
