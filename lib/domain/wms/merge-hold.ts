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

const normaliseStatus = (status: string | null | undefined): string => (status ?? '').toUpperCase().replace(/[^A-Z]/g, '')

export function isMergeHeldWarehouseStatus(status: string | null | undefined): boolean {
  return normaliseStatus(status) === MERGE_HOLD_WAREHOUSE_STATUS
}

/** Statuses (normalised) that positively say the order is NOT held any more: new, being worked, despatched or cancelled. */
const RECOGNISED_NOT_HELD_STATUSES: ReadonlySet<string> = new Set(['NEW', 'PROCESSING', 'ALLOCATED', 'PICKING', 'PICKED', 'PACKING', 'PACKED', 'DESPATCHED', 'SHIPPED', 'COMPLETED', 'DELIVERED', 'CANCELLED', 'CANCELED'])

/**
 * What a stored snapshot status says about a hold. Only a RECOGNISED status is evidence: '' (the status id missed the map) or a name this code
 * does not know (ON_HOLD, AWAITING_CUSTOMER_CONFIRMATION, ...) proves nothing, so it never clears a hold and never settles an unknown one.
 */
export type WarehouseStatusClass = 'held' | 'new' | 'left' | 'unrecognised'
export function classifyWarehouseStatus(status: string | null | undefined): WarehouseStatusClass {
  const name = normaliseStatus(status)
  if (name === MERGE_HOLD_WAREHOUSE_STATUS) return 'held'
  if (name === 'NEW') return 'new'
  return RECOGNISED_NOT_HELD_STATUSES.has(name) ? 'left' : 'unrecognised'
}

/** A HOLDING row younger than this is an attempt in flight: the upkeep leaves it alone (the attempt records its own answer). Older: the answer was lost. */
export const MERGE_HOLD_ATTEMPT_LEASE_MS = 10 * 60_000

/**
 * The request to the warehouse has its own overall deadline, SHORTER than the lease: the lease assumes an attempt is over (answered, failed or given up on)
 * well inside it, and this is what enforces that. (A request abandoned at the deadline may still land late: a NEW read is therefore only trusted once the
 * lease has passed, see MERGE_HOLD_NEW_GRACE_MS.)
 */
export const MERGE_HOLD_REQUEST_DEADLINE_MS = 3 * 60_000
/** An UNKNOWN / unrecorded row settles as "still NEW, not held" only on a snapshot read at least this long after the row was last written (the lease). */
export const MERGE_HOLD_NEW_GRACE_MS = MERGE_HOLD_ATTEMPT_LEASE_MS

/** Reject when `work` has not settled within `ms` (the work itself is not cancelled: it may still finish, which the caller treats as an unknown outcome). */
export async function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${Math.round(ms / 1000)}s`)), ms)
  })
  try {
    return await Promise.race([work, deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export const mergeHoldActInWarehouse = (warehouseLabel: string, maybe = false): string => `This order ${maybe ? 'may be' : 'is'} on merge hold in the warehouse, so IMS did not send the change. Act in ${warehouseLabel}.`

export const MERGE_HOLD_TASK_REASON = 'MERGE_HOLD' as const
export const MERGE_HOLD_OVERDUE_TASK_REASON = 'MERGE_HOLD_OVERDUE' as const
export const MERGE_HOLD_WITHDRAWAL_TASK_REASON = 'MERGE_HOLD_WITHDRAWAL' as const
/** `clearReason` of a hold row. */
export const MERGE_HOLD_CLEAR_LEFT_STATUS = 'left awaiting confirmation'
export const MERGE_HOLD_CLEAR_MERGED = 'merge detected'
export const MERGE_HOLD_CLEAR_SHIPPED = 'order despatched'
export const MERGE_HOLD_CLEAR_NOT_LANDED = 'hold did not land'
export const MERGE_HOLD_CLEAR_NOT_HELD_PAST_NEW = 'not held: the order moved past NEW in the warehouse'

export type MergeHoldState = 'HOLDING' | 'HELD' | 'UNKNOWN' | 'NOT_HELD' | 'CLEARED'

/** A row in one of these states may be holding the warehouse order: nothing is pushed to it, and its group is not dropped. */
export const MERGE_HOLD_MAY_BE_HELD_STATES: readonly MergeHoldState[] = ['HOLDING', 'HELD', 'UNKNOWN']

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
  clearReason: string | null
  updatedAt: Date
}

export type BeginHoldDecision = 'create' | 'retry' | 'new-episode' | 'skip'

/**
 * What beginning an attempt does with the existing row (one place, used by the database port and the tests).
 * - an active (HOLDING / HELD / UNKNOWN) row: no attempt.
 * - NOT_HELD for the same warehouse order: a refusal stands and the attempts are bounded; otherwise a retry.
 * - CLEARED because a person confirmed the order as it is (or it was merged) while the SAME group stands (same basis = same member set, same warehouse
 *   order): the person DECIDED, so the group is not held again. A changed group (a member joined or left) is a new decision: a new episode.
 */
export function decideBeginHold(existing: Pick<MergeHoldRow, 'state' | 'externalOrderId' | 'groupBasis' | 'refused' | 'attempts' | 'clearReason'> | null, externalOrderId: string, groupBasis: string): BeginHoldDecision {
  if (!existing) return 'create'
  if ((MERGE_HOLD_MAY_BE_HELD_STATES as readonly string[]).includes(existing.state)) return 'skip'
  if (existing.state === 'NOT_HELD' && existing.externalOrderId === externalOrderId) {
    return existing.refused || existing.attempts >= MERGE_HOLD_MAX_ATTEMPTS ? 'skip' : 'retry'
  }
  if (existing.state === 'CLEARED' && existing.externalOrderId === externalOrderId && existing.groupBasis === groupBasis
    && (existing.clearReason?.startsWith(MERGE_HOLD_CLEAR_LEFT_STATUS) || existing.clearReason === MERGE_HOLD_CLEAR_MERGED)) return 'skip'
  return 'new-episode'
}

/** What a hold request ended as, for the pass's result. */
export type MergeHoldOutcome = 'held' | 'refused' | 'failed' | 'shadowed' | 'skipped'

// ---------------------------------------------------------------------------------------------------------------------------------------
// The operator-task text. Order numbers only; one place.
// ---------------------------------------------------------------------------------------------------------------------------------------

/** held: on hold. unknown: the request's answer was lost, so it MAY be held (check it). not-held: IMS could not hold it. */
export type MergeHoldTaskState = 'held' | 'unknown' | 'not-held'
type TaskMember = { orderNumber: string | null; externalOrderId: string; externalOrderNumber: string; state: MergeHoldTaskState }

export function mergeHoldQuery(members: ReadonlyArray<TaskMember>, warnings: ReadonlyArray<string>, warehouseLabel: string): string {
  const ref = (m: TaskMember) => `${warehouseOrderRef(m.externalOrderNumber, m.externalOrderId)} (IMS order ${m.orderNumber ?? '—'})`
  const held = members.filter((m) => m.state === 'held').map(ref)
  const unknown = members.filter((m) => m.state === 'unknown').map(ref)
  const notHeld = members.filter((m) => m.state === 'not-held').map(ref)
  const extra = warnings.length > 0 ? ` Warning: ${warnings.join(' ')}` : ''
  const maybe = unknown.length > 0 ? ` HOLD OUTCOME UNKNOWN (the request failed or its answer was lost, so it may be held; check its status in ${warehouseLabel}, IMS re-reads it): ${unknown.join(', ')}.` : ''
  const missed = notHeld.length > 0 ? ` NOT held (IMS could not hold it; check it in ${warehouseLabel} before it is picked): ${notHeld.join(', ')}.` : ''
  const heldPart = held.length > 0 ? ` IMS has put these on HOLD in ${warehouseLabel} (awaiting confirmation) so they can be merged: ${held.join(', ')}.` : ''
  return `These orders are for the same customer and delivery address.${heldPart}${maybe}${missed} `
    + `Please merge them in ${warehouseLabel}, then confirm the merged order there yourself. IMS does not merge orders and will NOT release the hold: until you confirm it, the order is not picked. IMS sends no change to a held order.${extra}`
}

export function mergeHoldOverdueQuery(wmsOrder: string, imsOrder: string, hours: number, warehouseLabel: string, maybe = false): string {
  return `${warehouseLabel} order ${wmsOrder} (IMS order ${imsOrder}) ${maybe ? 'may be on merge hold (IMS asked for one and never got an answer) and has not been settled' : 'has been on merge hold'} for more than ${hours} hour(s). Please merge it with the customer's other order(s) and confirm it in ${warehouseLabel}, or confirm it as it is if it should not be merged. IMS will not release the hold: nothing ships until a person confirms it.`
}

export function mergeHoldWithdrawalQuery(wmsOrder: string, imsOrder: string, kind: 'WITHDRAWAL' | 'CANCEL', warehouseLabel: string, maybe = false): string {
  const what = kind === 'WITHDRAWAL' ? 'has a customer withdrawal' : 'was cancelled or fully refunded in IMS'
  return `IMS order ${imsOrder} ${what}, but ${warehouseLabel} order ${wmsOrder} ${maybe ? 'MAY be on merge hold (IMS asked for a hold and never got an answer)' : 'is on merge hold'}. IMS did NOT cancel or release it (it may be merged with another customer order). `
    + `Act in ${warehouseLabel}: decide whether to cancel it, take this order's lines out of the merged order, or confirm it; IMS changes nothing there.`
}

export function mergeHoldUnsettledQuery(wmsOrder: string, imsOrder: string, status: string, kind: 'UNKNOWN_OUTCOME' | 'UNRECOGNISED_STATUS', warehouseLabel: string): string {
  return kind === 'UNKNOWN_OUTCOME'
    ? `${warehouseLabel} order ${wmsOrder} (IMS order ${imsOrder}): IMS asked for a merge hold but never got an answer, and the order's status is now '${status || 'unreadable'}', which does not show whether it is held. Please check it in ${warehouseLabel}. If it is on hold, merge it with the customer's other order(s) and confirm it there; IMS will not release it.`
    : `${warehouseLabel} order ${wmsOrder} (IMS order ${imsOrder}) is on merge hold in IMS, but its ${warehouseLabel} status is now '${status || 'unreadable'}', which IMS does not recognise, so IMS kept the hold on record and changed nothing. Please check the order in ${warehouseLabel}.`
}

/** One task per order, episode and kind. The status is NOT part of it (a status moving on would raise a task per step): the open task's text is re-worded instead. */
export const mergeHoldUnsettledBasis = (row: Pick<MergeHoldRow, 'orderId' | 'episode'>, kind: string): string => `merge-hold-unsettled:${row.orderId}:${row.episode}:${kind}`
export const mergeHoldTaskBasis = (group: Pick<MergeGroup, 'basis'>, episodes: ReadonlyArray<number>): string => `merge-hold:${group.basis}:${[...episodes].join('.')}`
export const mergeHoldOverdueBasis = (row: Pick<MergeHoldRow, 'orderId' | 'episode'>): string => `merge-hold-overdue:${row.orderId}:${row.episode}`
/** The attempt number is part of the key: an order that becomes HELD again after a person closed the task raised while it was UNKNOWN gets a fresh task. */
export const mergeHoldWithdrawalBasis = (row: Pick<MergeHoldRow, 'orderId' | 'episode' | 'attempts'>, kind: string): string => `merge-hold-withdrawal:${row.orderId}:${row.episode}:${row.attempts}:${kind}`

/** IMS state that says an order must NEVER be held: it is cancelled / finished, fully refunded, or has a withdrawal (pending or approved). Null when it may be held. */
export function mergeHoldIneligibleReason(order: { status: string; refundStatus: string; withdrawalHoldAt: Date | null; withdrawalApprovedAt: Date | null }): string | null {
  if (order.status === 'CANCELLED') return 'the order is cancelled in IMS'
  if (['SHIPPED', 'COMPLETED', 'DELIVERED'].includes(order.status)) return `the order is ${order.status.toLowerCase()} in IMS`
  if (order.refundStatus === 'FULL') return 'the order is fully refunded in IMS'
  if (order.withdrawalHoldAt || order.withdrawalApprovedAt) return 'the order has a customer withdrawal in IMS'
  return null
}

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
  /**
   * A person already decided this group: another member of the same group (same basis) is CLEARED because a person confirmed it in the warehouse
   * ("left awaiting confirmation") or it was merged. An UNKNOWN member that then reads NEW is part of that decision and is not held again.
   */
  groupDecidedByPerson: boolean
}

export type MergeHoldPort = {
  now(): Date
  isEnabled(): Promise<boolean>
  /**
   * Begin an attempt for this order: write (or re-arm) its row as HOLDING BEFORE any request leaves, and return it (decideBeginHold says when). Null when no
   * attempt is due: a may-be-held row exists, a refusal stands, the attempts are spent, or a person already decided this same group.
   */
  beginHold(env: MergeHoldEnvironment, member: MergeHoldMember, groupBasis: string): Promise<MergeHoldRow | null>
  /**
   * THE request. It asks the producer-side hold FIRST and sends nothing when that shadows the operation (`{ shadowed: true }`). Throws when the outcome is
   * unknown (transport).
   */
  requestHold(env: MergeHoldEnvironment, member: MergeHoldMember): Promise<WmsOrderHoldResult | { shadowed: true }>
  /** The producer-side hold shadowed the request: nothing was sent, so the attempt is taken back (the row does not stay active and no attempt is spent). */
  abandonHold(row: MergeHoldRow): Promise<void>
  /** HOLDING (or UNKNOWN, when the upkeep gave up on a slow attempt) to HELD, for THIS attempt. Writes an audit entry. */
  recordHeld(row: MergeHoldRow, at: Date): Promise<void>
  /** A definite refusal: NOT_HELD, refused. Not retried. */
  recordNotHeld(row: MergeHoldRow, outcome: { refused: boolean; error: string }): Promise<void>
  /** The request threw or its answer was lost: the order MAY be held. HOLDING to UNKNOWN, with an audit entry. */
  recordUnknown(row: MergeHoldRow, error: string): Promise<void>
  /** Does the stored status snapshot of this warehouse order show it awaiting confirmation? (Read only.) */
  snapshotShowsHeld(row: MergeHoldRow): Promise<boolean>
  /** Transport-failed rows that may be retried: NOT_HELD, not refused, attempts left, with a sibling of the same group still active. */
  retryableMembers(env: MergeHoldEnvironment): Promise<Array<{ member: MergeHoldMember; groupBasis: string }>>
  /** The group's operator task (once) and an activity entry per member. `heldFlags` says which members are held. */
  raiseGroupTask(env: MergeHoldEnvironment, group: { basis: string; members: MergeHoldMember[]; warnings: string[] }, states: ReadonlyMap<string, MergeHoldTaskState>, episodes: number[]): Promise<void>
  /** Re-word the group's OPEN task from the members' CURRENT hold rows (an order held on a retry is then listed as held). Logs an activity entry when the text changed. */
  reviseGroupTask(env: MergeHoldEnvironment, groupBasis: string): Promise<void>
  /** Activity entry for an order whose hold did not land. */
  logNotHeld(row: MergeHoldRow, member: MergeHoldMember, refused: boolean, error: string): Promise<void>
  activeRows(connector: string): Promise<MergeHoldObservation[]>
  /** Move a row to CLEARED (compare-and-set on its active state), with an activity entry. False when another writer already moved it. */
  clear(row: MergeHoldRow, reason: string, at: Date): Promise<boolean>
  /** A HOLDING / UNKNOWN row whose status read proves the hold landed: HELD. Audit entry. */
  promoteToHeld(row: MergeHoldRow, at: Date): Promise<boolean>
  /**
   * A HOLDING / UNKNOWN row whose status read proves it is not held: NOT_HELD with a recorded reason. Retryable (it is still NEW), or `refused` when the
   * order has moved past NEW (never held again). Audit entry.
   */
  settleNotHeld(row: MergeHoldRow, error: string, options?: { refused?: boolean }): Promise<boolean>
  /**
   * A row whose outcome cannot be settled from the status (a name IMS does not recognise): ONE operator task per order, episode and kind (the status is not
   * part of the key); a later status re-words the open task. True when a task was newly raised.
   */
  raiseUnsettledTask(env: MergeHoldEnvironment, obs: MergeHoldObservation, kind: 'UNKNOWN_OUTCOME' | 'UNRECOGNISED_STATUS'): Promise<boolean>
  /** The overdue reminder, ONCE: compare-and-set `remindedAt` and raise the task, the warning entry and the notification in the same step. True when this call fired it. */
  remind(env: MergeHoldEnvironment, obs: MergeHoldObservation, hours: number, at: Date): Promise<boolean>
  /** An edit IMS did not push: shown as "act in" the warehouse system while the hold stands (or may stand: `obs.row.state` UNKNOWN). */
  showEditBlocked(env: MergeHoldEnvironment, obs: MergeHoldObservation): Promise<void>
  /** Close the "act in Mintsoft" row of a hold that has cleared. */
  closeEditBlocked(orderId: string): Promise<void>
  /** A withdrawal or cancel reached a held (or maybe held) order: one task for a person (once per episode and kind). True only when this call CREATED the task. */
  escalate(env: MergeHoldEnvironment, obs: MergeHoldObservation, kind: 'WITHDRAWAL' | 'CANCEL'): Promise<boolean>
}

export type MergeHoldPlacement = { held: number; refused: number; failed: number; shadowed: number; skipped: number }

const scrub = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 300)

async function reviseSafe(port: MergeHoldPort, env: MergeHoldEnvironment, basis: string): Promise<void> {
  try {
    await port.reviseGroupTask(env, basis)
  } catch (error) {
    console.error('[wms-merge-hold] could not update the merge-hold task', scrub(error))
  }
}

/** One hold attempt on one order. Never throws. */
async function attemptHold(port: MergeHoldPort, env: MergeHoldEnvironment, member: MergeHoldMember, groupBasis: string, deadlineMs: number): Promise<{ outcome: MergeHoldOutcome; row: MergeHoldRow | null; state: MergeHoldTaskState }> {
  const row = await port.beginHold(env, member, groupBasis)
  if (!row) return { outcome: 'skipped', row: null, state: 'not-held' }
  const unknown = async (message: string): Promise<{ outcome: MergeHoldOutcome; row: MergeHoldRow; state: MergeHoldTaskState }> => {
    // The outcome is UNKNOWN: not a refusal and not a hold. The row says "may be held"; the upkeep settles it from the warehouse status.
    try {
      await port.recordUnknown(row, message)
      await port.logNotHeld(row, member, false, message)
    } catch (writeError) {
      console.error('[wms-merge-hold] could not record a failed hold', scrub(writeError))
    }
    return { outcome: 'failed', row, state: 'unknown' }
  }
  try {
    // An overall deadline well inside the lease: an attempt that outlives it is an UNKNOWN outcome now, not a row the upkeep later settles from under it.
    const answer = await withDeadline(port.requestHold(env, member), deadlineMs, 'The hold request')
    if ('shadowed' in answer) {
      await port.abandonHold(row)
      return { outcome: 'shadowed', row, state: 'not-held' }
    }
    if (answer.held) {
      await port.recordHeld(row, port.now())
      return { outcome: 'held', row, state: 'held' }
    }
    if (answer.status === 'NOT_HOLDABLE' && row.attempts > 1) {
      // A RETRY of an order whose earlier answer was lost: "past NEW" may well be OUR hold. Held by the snapshot: record it held; otherwise it is still unknown.
      if (await port.snapshotShowsHeld(row)) {
        await port.recordHeld(row, port.now())
        return { outcome: 'held', row, state: 'held' }
      }
      return unknown('The order is past NEW in the warehouse after an earlier hold attempt whose answer was lost; its status is not read as held yet')
    }
    const reason = `${answer.status}${answer.message ? `: ${answer.message}` : ''}`
    await port.recordNotHeld(row, { refused: true, error: reason })
    await port.logNotHeld(row, member, true, reason)
    return { outcome: 'refused', row, state: 'not-held' }
  } catch (error) {
    return unknown(scrub(error))
  }
}

/**
 * Hold every order of each group (and retry the orders of a group whose earlier attempt failed in transport). Non-fatal: a failing order is recorded and
 * the others go on. Raises ONE operator task per group once at least one order is held. A no-op unless the setting is on.
 */
export async function placeMergeHolds(port: MergeHoldPort, env: MergeHoldEnvironment, groups: ReadonlyArray<MergeGroup>, options?: { requestDeadlineMs?: number }): Promise<MergeHoldPlacement> {
  const deadlineMs = Math.min(options?.requestDeadlineMs ?? MERGE_HOLD_REQUEST_DEADLINE_MS, MERGE_HOLD_ATTEMPT_LEASE_MS - 1)
  const total: MergeHoldPlacement = { held: 0, refused: 0, failed: 0, shadowed: 0, skipped: 0 }
  if (!(await port.isEnabled())) return total
  const attempted = new Set<string>()
  const count = (outcome: MergeHoldOutcome) => { total[outcome === 'held' ? 'held' : outcome === 'refused' ? 'refused' : outcome === 'failed' ? 'failed' : outcome === 'shadowed' ? 'shadowed' : 'skipped'] += 1 }

  for (const group of groups) {
    const states = new Map<string, MergeHoldTaskState>()
    const episodes: number[] = []
    let mayBeHeld = 0
    let anyAttempted = false
    for (const member of group.members) {
      attempted.add(member.orderId)
      const { outcome, row, state } = await attemptHold(port, env, member, group.basis, deadlineMs)
      count(outcome)
      if (row) anyAttempted = true
      states.set(member.orderId, state)
      // A member whose answer was lost MAY be held, so it counts like a held one: the group gets its task even when every attempt failed.
      if (row && (state === 'held' || state === 'unknown')) {
        mayBeHeld += 1
        episodes.push(row.episode)
      }
    }
    if (mayBeHeld === 0) continue
    try {
      await port.raiseGroupTask(env, { basis: group.basis, members: group.members, warnings: group.warnings }, states, episodes)
    } catch (error) {
      console.error('[wms-merge-hold] could not raise the merge-hold task', scrub(error))
    }
    // A re-attempt through re-detection dedupes to the SAME open task (same group, same episodes): re-word it from the members' current rows.
    if (anyAttempted) await reviseSafe(port, env, group.basis)
  }

  // An order whose hold failed in transport while a sibling got held no longer sits in a detected group (the held one left NEW), so it is retried here.
  const retry = await port.retryableMembers(env)
  const byGroup = new Map<string, MergeHoldMember[]>()
  // (An order already tried in THIS pass waits for the next one: one pass spends one attempt per order.)
  for (const { member, groupBasis } of retry.filter((entry) => !attempted.has(entry.member.orderId))) byGroup.set(groupBasis, [...(byGroup.get(groupBasis) ?? []), member])
  for (const [basis, members] of byGroup) {
    let changed = false
    for (const member of members) {
      const { outcome } = await attemptHold(port, env, member, basis, deadlineMs)
      count(outcome)
      if (outcome !== 'skipped') changed = true
    }
    // An order held (or failed again) on a retry must be listed as such in the group's task.
    if (changed) await reviseSafe(port, env, basis)
  }
  return total
}

export type MergeHoldMaintenance = { cleared: number; confirmedHeld: number; settledNotHeld: number; unsettled: number; reminded: number; editsBlocked: number; escalated: number }

/**
 * The upkeep of the holds that stand: CLEAR a hold on an observed status change or a merge, fire the overdue REMINDER once, show a pending edit as
 * "act in Mintsoft" and ESCALATE a withdrawal or cancel. Reads IMS state only (the stored status snapshot): no warehouse call. Runs whether or not the
 * setting is on, so a hold placed before it was turned off still clears and is still reminded; with no active row it writes nothing.
 *
 * A row that MAY be held (UNKNOWN) is treated like a held one for everything a person must hear about: the reminder, the "act in" notice of a change IMS
 * withheld, and the escalation of a cancel / withdrawal. The push sweep withholds a change while a row is HOLDING / HELD / UNKNOWN, so each pass here
 * either settles the row (the push then resumes) or raises the task: a customer's cancel is never withheld silently.
 */
export async function runMergeHoldMaintenance(port: MergeHoldPort, env: MergeHoldEnvironment, options?: { hours?: number }): Promise<MergeHoldMaintenance> {
  const result: MergeHoldMaintenance = { cleared: 0, confirmedHeld: 0, settledNotHeld: 0, unsettled: 0, reminded: 0, editsBlocked: 0, escalated: 0 }
  const hours = options?.hours ?? mergeHoldRemindHours()
  const now = port.now()
  // Settled rows (HELD) first: a person's confirm of one member decides the whole group in this same pass, before an UNKNOWN sibling is read.
  const rank = (state: MergeHoldState) => (state === 'HELD' ? 0 : 1)
  const rows = [...(await port.activeRows(env.connectorId))].sort((a, b) => rank(a.row.state) - rank(b.row.state))
  const decidedBases = new Set<string>()
  for (const obs of rows) {
    try {
      await maintainRow(port, env, { ...obs, groupDecidedByPerson: obs.groupDecidedByPerson || decidedBases.has(obs.row.groupBasis) }, hours, now, result, decidedBases)
    } catch (error) {
      // One row never stops the others.
      console.error('[wms-merge-hold] maintenance of one hold failed', scrub(error))
    }
  }
  return result
}

async function maintainRow(port: MergeHoldPort, env: MergeHoldEnvironment, obs: MergeHoldObservation, hours: number, now: Date, result: MergeHoldMaintenance, decidedBases: Set<string>): Promise<void> {
  const { row } = obs
  // 1. CLEAR on evidence. The hold is the one this row names: a link re-pointed to another warehouse order (a merge IMS detected) is not it any more.
  const mergedAway = obs.link !== null && (obs.link.state === 'MERGED' || obs.link.externalOrderId !== row.externalOrderId)
  if (mergedAway) {
    if (await port.clear(row, MERGE_HOLD_CLEAR_MERGED, now)) { result.cleared += 1; decidedBases.add(row.groupBasis) }
    await port.closeEditBlocked(row.orderId).catch(() => {})
    return
  }
  if (obs.shippedAt || ['SHIPPED', 'COMPLETED', 'DELIVERED'].includes(obs.orderStatus)) {
    if (await port.clear(row, MERGE_HOLD_CLEAR_SHIPPED, now)) result.cleared += 1
    await port.closeEditBlocked(row.orderId).catch(() => {})
    return
  }
  // A snapshot proves anything only if it is for THIS warehouse order, was read AFTER the hold was recorded, and carries no lookup error.
  const since = row.heldAt ?? row.updatedAt
  const observed = obs.snapshot && obs.snapshot.externalOrderId === row.externalOrderId && !obs.snapshot.lastError && obs.snapshot.fetchedAt.getTime() > since.getTime() ? obs.snapshot : null
  const status = observed ? classifyWarehouseStatus(observed.status) : null
  // The age of the hold for the reminder: from when it was placed, or (an unsettled row) from when it was last written.
  const ageFrom = row.heldAt ?? row.updatedAt
  let state: MergeHoldState = row.state

  // 1b. A row whose answer was lost (UNKNOWN) or never recorded (HOLDING left behind): settle it from the status, never guess.
  //     A HOLDING row inside its lease is an attempt in flight: it records its own answer, so it is left alone (no demotion under a running request).
  if (row.state === 'HOLDING' || row.state === 'UNKNOWN') {
    if (row.state === 'HOLDING' && now.getTime() - row.updatedAt.getTime() < MERGE_HOLD_ATTEMPT_LEASE_MS) return
    if (status === 'held') {
      if (await port.promoteToHeld(row, now)) {
        result.confirmedHeld += 1
        state = 'HELD'
        await reviseSafe(port, env, row.groupBasis)
      } else return
    } else if (status === 'left') {
      // Past NEW and not awaiting confirmation (being worked, despatched, cancelled in the warehouse): it is NOT held now. Settle it, never held again, so the
      // pushes the hold withheld resume. (If a person confirmed a hold that did land, this is the same answer.)
      if (await port.settleNotHeld(row, `${MERGE_HOLD_CLEAR_NOT_HELD_PAST_NEW}: the warehouse status is ${observed?.status}`, { refused: true })) {
        result.settledNotHeld += 1
        await port.closeEditBlocked(row.orderId).catch(() => {})
        await reviseSafe(port, env, row.groupBasis)
      }
      return
    } else if (status === 'new' && observed && observed.fetchedAt.getTime() - row.updatedAt.getTime() >= MERGE_HOLD_NEW_GRACE_MS) {
      // Still NEW on a read taken after the lease: a request that finished late has landed by now, so it did not land. A read before that proves nothing
      // (the warehouse may still be processing a request IMS gave up on).
      if (obs.groupDecidedByPerson) {
        // A person already confirmed this group's other order(s) as they are: the decision covers this one too. Not held again.
        if (await port.clear(row, `${MERGE_HOLD_CLEAR_LEFT_STATUS} (now ${observed.status}; the group was decided by a person)`, now)) result.cleared += 1
        await port.closeEditBlocked(row.orderId).catch(() => {})
        await reviseSafe(port, env, row.groupBasis)
        return
      }
      if (await port.settleNotHeld(row, `${MERGE_HOLD_CLEAR_NOT_LANDED}: the warehouse still shows ${observed.status}`)) {
        result.settledNotHeld += 1
        await port.closeEditBlocked(row.orderId).catch(() => {})
        await reviseSafe(port, env, row.groupBasis)
      }
      return
    } else {
      // No evidence yet (no fresh read, a NEW read too soon after the attempt, or a name IMS does not recognise): it stays "may be held".
      if (row.state === 'HOLDING') {
        await port.recordUnknown(row, 'The attempt never recorded an answer')
        state = 'UNKNOWN'
      }
      if (status === 'unrecognised') {
        try {
          await port.raiseUnsettledTask(env, obs, 'UNKNOWN_OUTCOME')
        } catch (error) {
          console.error('[wms-merge-hold] could not raise the unknown-outcome task', scrub(error))
        }
      }
      result.unsettled += 1
    }
  } else if (status === 'unrecognised') {
    // '' or a name this code does not know is NO evidence the hold ended: the row stays HELD and a person is told once.
    try {
      await port.raiseUnsettledTask(env, obs, 'UNRECOGNISED_STATUS')
    } catch (error) {
      console.error('[wms-merge-hold] could not raise the unrecognised-status task', scrub(error))
    }
  } else if (status === 'new' || status === 'left') {
    if (await port.clear(row, `${MERGE_HOLD_CLEAR_LEFT_STATUS} (now ${observed?.status || 'unknown'})`, now)) { result.cleared += 1; decidedBases.add(row.groupBasis) }
    await port.closeEditBlocked(row.orderId).catch(() => {})
    return
  }

  // From here the row is HELD or UNKNOWN: the order is (or may be) held, and the push sweep is withholding its changes.
  const live: MergeHoldObservation = { ...obs, row: { ...row, state } }
  // 2. REMIND, once (an UNKNOWN row too: nobody may have looked).
  if (row.remindedAt === null && now.getTime() - ageFrom.getTime() >= hours * 3_600_000) {
    try {
      if (await port.remind(env, live, hours, now)) result.reminded += 1
    } catch (error) {
      console.error('[wms-merge-hold] could not raise the overdue reminder', scrub(error))
    }
  }
  // 3. WHILE HELD (or maybe held): nothing is pushed. Say so, and send a withdrawal or cancel to a person (a task, so it is never withheld silently).
  try {
    if (obs.withdrawalHoldAt || obs.withdrawalApprovedAt) {
      if (await port.escalate(env, live, 'WITHDRAWAL')) result.escalated += 1
    } else if (obs.orderStatus === 'CANCELLED' || obs.refundStatus === 'FULL') {
      if (await port.escalate(env, live, 'CANCEL')) result.escalated += 1
    } else if (obs.editPending) {
      await port.showEditBlocked(env, live)
      result.editsBlocked += 1
    }
  } catch (error) {
    console.error('[wms-merge-hold] could not record a blocked change', scrub(error))
  }
}
