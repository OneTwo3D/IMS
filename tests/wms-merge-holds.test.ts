import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import type { WmsOrderHoldResult } from '../lib/connectors/wms/types.ts'
import type { MergeGroup } from '../lib/domain/wms/merge-candidate-match.ts'
import { MERGE_WARNING_EU, MERGE_WARNING_FEDEX } from '../lib/domain/wms/merge-candidate-match.ts'
import { mergeCandidateNote, runMergeCandidateDetection, type MergeCandidatePort } from '../lib/domain/wms/merge-candidates.ts'
import { mergeHoldMaintenanceNote } from '../lib/domain/wms/merge-hold-port.ts'
import { cronOutcome } from '../lib/ops/cron-outcomes.ts'
import {
  mergeHoldActInWarehouse,
  MERGE_HOLD_MAX_ATTEMPTS,
  MERGE_HOLD_REMIND_HOURS_DEFAULT,
  classifyWarehouseStatus,
  decideBeginHold,
  isMergeHeldWarehouseStatus,
  MERGE_HOLD_ATTEMPT_LEASE_MS,
  MERGE_HOLD_NEW_GRACE_MS,
  MERGE_HOLD_REQUEST_DEADLINE_MS,
  mergeHoldUnsettledBasis,
  mergeHoldIneligibleReason,
  mergeHoldWithdrawalBasis,
  withDeadline,
  type MergeHoldTaskState,
  mergeHoldQuery,
  mergeHoldRemindHours,
  mergeHoldTaskBasis,
  placeMergeHolds,
  runMergeHoldMaintenance,
  type MergeHoldEnvironment,
  type MergeHoldMember,
  type MergeHoldObservation,
  type MergeHoldPort,
  type MergeHoldRow,
} from '../lib/domain/wms/merge-hold.ts'

/**
 * MERGE HOLDS (o3d-zvec.12 / .13). In-memory port: no database, no warehouse, no network. The port records every write and every request, so "flag OFF
 * writes nothing" and "no release path" are assertions on the record. (The connector verb itself is tested in mintsoft-merge-hold-verb.test.ts.)
 */

const ENV: MergeHoldEnvironment = { connectorId: 'mintsoft', connectorLabel: 'Mintsoft' }
const T0 = new Date('2026-11-18T10:00:00Z')

const member = (n: number): MergeHoldMember => ({ orderId: `o${n}`, orderNumber: `T-${n}`, externalOrderId: `w${n}`, externalOrderNumber: `W${n}` })
const group = (members: MergeHoldMember[], warnings: string[] = []): MergeGroup => ({ basis: `merge-candidate:${members.map((m) => m.orderId).join(',')}`, members, warnings })

type Task = { reason: string; basis: string; queryText: string; orderId: string; warnings?: string[] }

function fakePort(opts: { enabled?: boolean; shadowed?: boolean; answers?: Record<string, WmsOrderHoldResult | 'throw'>; now?: () => Date; snapshotHeld?: Set<string>; hang?: Set<string> } = {}) {
  const rows = new Map<string, MergeHoldRow>()
  const requests: string[] = []
  const writes: string[] = []
  const tasks: Task[] = []
  const blocked: string[] = []
  const escalated: string[] = []
  const reminders: string[] = []
  const cleared: Array<{ orderId: string; reason: string }> = []
  const revised: string[] = []
  let clock = opts.now ?? (() => T0)
  const dedupe = new Set<string>()
  const orders = new Map<string, { status: string; refundStatus: string; withdrawalHoldAt: Date | null; withdrawalApprovedAt: Date | null }>()
  const answers = opts.answers ?? {}
  const port: MergeHoldPort = {
    now: () => clock(),
    isEnabled: async () => opts.enabled ?? true,
    async beginHold(env, m, basis) {
      const existing = rows.get(m.orderId)
      const decision = decideBeginHold(existing ?? null, m.externalOrderId, basis)
      if (decision === 'skip') return null
      // Mirrors the database port: an order IMS cancelled / withdrew / fully refunded is never held; a retryable row is settled refused.
      const ineligible = mergeHoldIneligibleReason(orders.get(m.orderId) ?? { status: 'PROCESSING', refundStatus: 'NONE', withdrawalHoldAt: null, withdrawalApprovedAt: null })
      if (ineligible) {
        if (existing && existing.state === 'NOT_HELD' && !existing.refused) { rows.set(m.orderId, { ...existing, refused: true, lastError: `Not held: ${ineligible}` }); writes.push(`ineligible:${m.orderId}`) }
        return null
      }
      const row: MergeHoldRow = decision === 'create' || !existing
        ? { id: `r-${m.orderId}`, connector: env.connectorId, orderId: m.orderId, externalOrderId: m.externalOrderId, groupBasis: basis, state: 'HOLDING', episode: 1, attempts: 1, refused: false, lastError: null, heldAt: null, remindedAt: null, clearReason: null, updatedAt: clock() }
        : decision === 'retry'
          ? { ...existing, state: 'HOLDING', attempts: existing.attempts + 1, groupBasis: basis, updatedAt: clock() }
          : { ...existing, state: 'HOLDING', episode: existing.episode + 1, attempts: 1, refused: false, heldAt: null, remindedAt: null, clearReason: null, externalOrderId: m.externalOrderId, groupBasis: basis, updatedAt: clock() }
      rows.set(m.orderId, row)
      writes.push(`begin:${m.orderId}`)
      return row
    },
    async requestHold(_env, m) {
      if (opts.shadowed) return { shadowed: true as const }
      requests.push(m.orderId)
      if (opts.hang?.has(m.orderId)) return new Promise<never>(() => {})
      const answer = answers[m.orderId] ?? { held: true, status: 'HELD' }
      if (answer === 'throw') throw new Error('Mintsoft 500')
      return answer
    },
    async abandonHold(row) { rows.set(row.orderId, { ...rows.get(row.orderId)!, state: 'NOT_HELD', attempts: row.attempts - 1 }); writes.push(`abandon:${row.orderId}`) },
    async recordHeld(row, at) { rows.set(row.orderId, { ...rows.get(row.orderId)!, state: 'HELD', heldAt: at, updatedAt: at }); writes.push(`held:${row.orderId}`) },
    async recordNotHeld(row, o) { rows.set(row.orderId, { ...rows.get(row.orderId)!, state: 'NOT_HELD', refused: o.refused, lastError: o.error }); writes.push(`notheld:${row.orderId}`) },
    async recordUnknown(row, error) { rows.set(row.orderId, { ...rows.get(row.orderId)!, state: 'UNKNOWN', refused: false, lastError: error, updatedAt: clock() }); writes.push(`unknown:${row.orderId}`) },
    async snapshotShowsHeld(row) { return opts.snapshotHeld?.has(row.orderId) ?? false },
    async retryableMembers() {
      const out: Array<{ member: MergeHoldMember; groupBasis: string }> = []
      for (const row of rows.values()) {
        if (row.state !== 'NOT_HELD' || row.refused || row.attempts >= MERGE_HOLD_MAX_ATTEMPTS) continue
        if (![...rows.values()].some((o) => o.groupBasis === row.groupBasis && (o.state === 'HELD' || o.state === 'HOLDING' || o.state === 'UNKNOWN'))) continue
        out.push({ groupBasis: row.groupBasis, member: member(Number(row.orderId.slice(1))) })
      }
      return out
    },
    async reviseGroupTask(env, basis) {
      revised.push(basis)
      const task = tasks.find((t) => t.reason === 'MERGE_HOLD' && t.basis.startsWith(`merge-hold:${basis}:`))
      if (!task) return
      const ms = [...rows.values()].filter((r) => r.groupBasis === basis)
      task.queryText = mergeHoldQuery(ms.map((r) => ({ ...member(Number(r.orderId.slice(1))), state: (r.state === 'HELD' ? 'held' : r.state === 'UNKNOWN' || r.state === 'HOLDING' ? 'unknown' : 'not-held') as MergeHoldTaskState })), task.warnings ?? [], env.connectorLabel)
    },
    async raiseGroupTask(env, g, states, episodes) {
      const queryText = mergeHoldQuery(g.members.map((m) => ({ ...m, state: states.get(m.orderId) ?? 'not-held' })), g.warnings, env.connectorLabel)
      const basis = mergeHoldTaskBasis(g, episodes)
      if (!tasks.some((t) => t.basis === basis)) tasks.push({ reason: 'MERGE_HOLD', basis, queryText, orderId: g.members[0].orderId, warnings: g.warnings })
    },
    async logNotHeld(row) { writes.push(`log-notheld:${row.orderId}`) },
    async activeRows() {
      return observations.filter((o) => ['HELD', 'HOLDING', 'UNKNOWN'].includes(rows.get(o.row.orderId)?.state ?? '')).map((o) => {
        const row = rows.get(o.row.orderId)!
        // Mirrors the database port: a sibling of the same group CLEARED by a person's confirm (or a merge).
        const decided = [...rows.values()].some((r) => r.orderId !== row.orderId && r.groupBasis === row.groupBasis && r.state === 'CLEARED' && (r.clearReason?.startsWith('left awaiting confirmation') || r.clearReason === 'merge detected'))
        return { ...o, row, groupDecidedByPerson: decided }
      })
    },
    async clear(row, reason) {
      const current = rows.get(row.orderId)!
      if (!['HELD', 'HOLDING', 'UNKNOWN'].includes(current.state)) return false
      rows.set(row.orderId, { ...current, state: 'CLEARED', clearReason: reason })
      cleared.push({ orderId: row.orderId, reason })
      return true
    },
    async promoteToHeld(row, at) { rows.set(row.orderId, { ...rows.get(row.orderId)!, state: 'HELD', heldAt: at }); return true },
    async settleNotHeld(row, error, o) { rows.set(row.orderId, { ...rows.get(row.orderId)!, state: 'NOT_HELD', refused: o?.refused === true, lastError: error }); writes.push(`settled:${row.orderId}`); return true },
    async raiseUnsettledTask(_env, obs, kind) {
      const basis = mergeHoldUnsettledBasis(obs.row, kind)
      const text = `${kind}:${obs.snapshot?.status ?? ''}`
      const existing = tasks.find((t) => t.basis === basis)
      if (existing) { existing.queryText = text; return false }
      tasks.push({ reason: 'MERGE_HOLD', basis, queryText: text, orderId: obs.row.orderId })
      return true
    },
    async remind(_env, obs, hours) {
      const current = rows.get(obs.row.orderId)!
      if (current.remindedAt) return false
      rows.set(obs.row.orderId, { ...current, remindedAt: clock() })
      reminders.push(`${obs.row.orderId}:${hours}`)
      tasks.push({ reason: 'MERGE_HOLD_OVERDUE', basis: `overdue:${obs.row.orderId}`, queryText: '', orderId: obs.row.orderId })
      return true
    },
    async showEditBlocked(_env, obs) { blocked.push(obs.row.orderId) },
    async closeEditBlocked() {},
    async escalate(_env, obs, kind) {
      // Mirrors the database dedupe: open AND closed tasks of the same basis dedupe.
      const key = mergeHoldWithdrawalBasis(obs.row, kind)
      if (dedupe.has(key)) return false
      dedupe.add(key)
      escalated.push(`${obs.row.orderId}:${kind}`)
      return true
    },
  }
  const observations: MergeHoldObservation[] = []
  /** Register what the maintenance will read for an order (its row is read back from `rows`). */
  const observe = (orderId: string, over: Partial<Omit<MergeHoldObservation, 'row'>> = {}) => {
    const n = Number(orderId.slice(1))
    observations.push({
      row: rows.get(orderId)!, orderNumber: `T-${n}`, orderStatus: 'PROCESSING', refundStatus: 'NONE', shippedAt: null, withdrawalHoldAt: null, withdrawalApprovedAt: null, editPending: false,
      link: { state: 'SYNCED', externalOrderId: `w${n}` },
      groupDecidedByPerson: false,
      snapshot: { status: 'AWAITINGCONFIRMATION', externalOrderId: `w${n}`, fetchedAt: new Date(T0.getTime() + 60_000), lastError: null },
      ...over,
    })
  }
  return { port, rows, orders, requests, writes, tasks, blocked, escalated, reminders, cleared, revised, observe, resetObservations: () => { observations.length = 0 }, setClock: (fn: () => Date) => { clock = fn } }
}

test('flag OFF: nothing is requested and nothing is written', async () => {
  const f = fakePort({ enabled: false })
  const result = await placeMergeHolds(f.port, ENV, [group([member(1), member(2)])])
  assert.deepEqual(result, { held: 0, refused: 0, failed: 0, shadowed: 0, skipped: 0 })
  assert.deepEqual(f.requests, [])
  assert.deepEqual(f.writes, [])
  assert.deepEqual(f.tasks, [])
})

test('both orders of the group are held, each with a row, and ONE operator task carries the EU and FedEx warnings', async () => {
  const f = fakePort()
  const result = await placeMergeHolds(f.port, ENV, [group([member(1), member(2)], [MERGE_WARNING_EU, MERGE_WARNING_FEDEX])])
  assert.equal(result.held, 2)
  assert.deepEqual(f.requests, ['o1', 'o2'])
  assert.deepEqual([...f.rows.values()].map((r) => [r.orderId, r.state]), [['o1', 'HELD'], ['o2', 'HELD']])
  assert.equal(f.tasks.length, 1)
  assert.equal(f.tasks[0].reason, 'MERGE_HOLD')
  assert.ok(f.tasks[0].queryText.includes(MERGE_WARNING_EU) && f.tasks[0].queryText.includes(MERGE_WARNING_FEDEX), 'warnings ride on the task')
  assert.ok(f.tasks[0].queryText.includes('will NOT release'), 'the task says IMS never releases')
})

test('a second pass over the same group sends no second request and raises no second task', async () => {
  const f = fakePort()
  const g = group([member(1), member(2)])
  await placeMergeHolds(f.port, ENV, [g])
  await placeMergeHolds(f.port, ENV, [g])
  assert.deepEqual(f.requests, ['o1', 'o2'])
  assert.equal(f.tasks.length, 1)
})

const settleAsNew = async (f: ReturnType<typeof fakePort>, ...ids: string[]) => {
  f.resetObservations()
  for (const id of ids) f.observe(id, { snapshot: { status: 'NEW', externalOrderId: `w${id.slice(1)}`, fetchedAt: new Date(T0.getTime() + MERGE_HOLD_NEW_GRACE_MS + 60_000), lastError: null } })
  await runMergeHoldMaintenance(f.port, ENV, { hours: 4 })
}

test('a transport failure is NOT a refusal and NOT "not held": the order is UNKNOWN (may be held), named in the task, and not blindly re-sent', async () => {
  const f = fakePort({ answers: { o2: 'throw' } })
  const g = group([member(1), member(2)])
  const first = await placeMergeHolds(f.port, ENV, [g])
  assert.deepEqual([first.held, first.failed, first.refused], [1, 1, 0])
  assert.equal(f.rows.get('o2')!.state, 'UNKNOWN')
  assert.equal(f.rows.get('o2')!.refused, false)
  assert.ok(f.tasks[0].queryText.includes('OUTCOME UNKNOWN'), 'the task names the order whose outcome is unknown')
  await placeMergeHolds(f.port, ENV, [])
  assert.equal(f.requests.filter((id) => id === 'o2').length, 1, 'an UNKNOWN order is not re-sent until a status read says it is still NEW')
  // Settled as still NEW: now it is retried.
  await settleAsNew(f, 'o2')
  assert.equal(f.rows.get('o2')!.state, 'NOT_HELD')
  const again = await placeMergeHolds(f.port, ENV, [])
  assert.equal(again.failed, 1, 'retried (and failed again with the same fake)')
  assert.equal(f.requests.filter((id) => id === 'o2').length, 2)
})

test('LOST ANSWER on EVERY member: rows are UNKNOWN, the MERGE_HOLD task exists, the candidate task stays open (group not dropped)', async () => {
  const f = fakePort({ answers: { o1: 'throw', o2: 'throw' } })
  const result = await placeMergeHolds(f.port, ENV, [group([member(1), member(2)])])
  assert.deepEqual([result.held, result.failed], [0, 2])
  assert.deepEqual([...f.rows.values()].map((r) => r.state), ['UNKNOWN', 'UNKNOWN'])
  assert.equal(f.tasks.filter((t) => t.reason === 'MERGE_HOLD').length, 1, 'a task although every attempt failed')
  assert.ok(f.tasks[0].queryText.includes('OUTCOME UNKNOWN') && !f.tasks[0].queryText.includes('IMS has put these on HOLD'))
})

test('LOST ANSWER is settled by the status: AWAITINGCONFIRMATION = HELD, NEW (after the lease) = safe to retry, past NEW = not held for good, an unrecognised name stays UNKNOWN and raises a task', async () => {
  const f = fakePort({ answers: { o1: 'throw', o2: 'throw', o3: 'throw', o4: 'throw' } })
  await placeMergeHolds(f.port, ENV, [group([member(1), member(2), member(3), member(4)])])
  const at = new Date(T0.getTime() + MERGE_HOLD_NEW_GRACE_MS + 60_000)
  f.observe('o1', { snapshot: { status: 'AWAITINGCONFIRMATION', externalOrderId: 'w1', fetchedAt: at, lastError: null } })
  f.observe('o2', { snapshot: { status: 'NEW', externalOrderId: 'w2', fetchedAt: at, lastError: null } })
  f.observe('o3', { snapshot: { status: 'PICKING', externalOrderId: 'w3', fetchedAt: at, lastError: null } })
  f.observe('o4', { snapshot: { status: 'ON_HOLD', externalOrderId: 'w4', fetchedAt: at, lastError: null } })
  const before = f.tasks.length
  const r = await runMergeHoldMaintenance(f.port, ENV, { hours: 4 })
  assert.deepEqual([r.confirmedHeld, r.settledNotHeld, r.unsettled], [1, 2, 1])
  assert.deepEqual([1, 2, 3, 4].map((n) => f.rows.get(`o${n}`)!.state), ['HELD', 'NOT_HELD', 'NOT_HELD', 'UNKNOWN'])
  assert.equal(f.rows.get('o2')!.refused, false, 'still NEW: retryable')
  assert.equal(f.rows.get('o3')!.refused, true, 'past NEW: never held again')
  assert.equal(f.tasks.length, before + 1, 'one operator task for the order whose status IMS does not recognise')
  // an unreadable status ('') is no evidence either
  const g = fakePort({ answers: { o1: 'throw' } })
  await placeMergeHolds(g.port, ENV, [group([member(1), member(2)])])
  g.observe('o1', { snapshot: { status: '', externalOrderId: 'w1', fetchedAt: at, lastError: null } })
  await runMergeHoldMaintenance(g.port, ENV, { hours: 4 })
  assert.equal(g.rows.get('o1')!.state, 'UNKNOWN')
})

test('RETRY hits NOT_HOLDABLE on an order that IS held: recorded HELD (not a refusal), and the group task lists it as held', async () => {
  const answers: Record<string, WmsOrderHoldResult | 'throw'> = { o2: 'throw' }
  const f = fakePort({ answers, snapshotHeld: new Set(['o2']) })
  await placeMergeHolds(f.port, ENV, [group([member(1), member(2)])])
  assert.ok(f.tasks[0].queryText.includes('OUTCOME UNKNOWN'))
  await settleAsNew(f, 'o2') // a stale NEW read; the retry then meets the gate
  answers.o2 = { held: false, status: 'NOT_HOLDABLE' }
  const r = await placeMergeHolds(f.port, ENV, [])
  assert.equal(r.held, 1)
  assert.equal(f.rows.get('o2')!.state, 'HELD')
  assert.equal(f.rows.get('o2')!.refused, false)
  assert.ok(f.revised.length >= 1, 'the group task is re-worded')
  assert.ok(!f.tasks[0].queryText.includes('OUTCOME UNKNOWN') && !f.tasks[0].queryText.includes('NOT held'), f.tasks[0].queryText)
})

test('RETRY hits NOT_HOLDABLE and no snapshot shows it held: still UNKNOWN (never a refusal)', async () => {
  const answers: Record<string, WmsOrderHoldResult | 'throw'> = { o2: 'throw' }
  const f = fakePort({ answers })
  await placeMergeHolds(f.port, ENV, [group([member(1), member(2)])])
  await settleAsNew(f, 'o2')
  answers.o2 = { held: false, status: 'NOT_HOLDABLE' }
  await placeMergeHolds(f.port, ENV, [])
  assert.equal(f.rows.get('o2')!.state, 'UNKNOWN')
  assert.equal(f.rows.get('o2')!.refused, false)
})

test('a transport failure that later succeeds ends HELD', async () => {
  const answers: Record<string, WmsOrderHoldResult | 'throw'> = { o2: 'throw' }
  const f = fakePort({ answers })
  await placeMergeHolds(f.port, ENV, [group([member(1), member(2)])])
  await settleAsNew(f, 'o2')
  delete answers.o2
  const again = await placeMergeHolds(f.port, ENV, [])
  assert.equal(again.held, 1)
  assert.equal(f.rows.get('o2')!.state, 'HELD')
})

test('a transport failure is retried only up to the bound', async () => {
  const f = fakePort({ answers: { o2: 'throw' } })
  await placeMergeHolds(f.port, ENV, [group([member(1), member(2)])])
  for (let i = 0; i < 10; i += 1) {
    await settleAsNew(f, 'o2')
    await placeMergeHolds(f.port, ENV, [])
  }
  assert.equal(f.requests.filter((id) => id === 'o2').length, MERGE_HOLD_MAX_ATTEMPTS)
})

test('CONFIRM WITHOUT MERGING: after the person confirms the orders as they are, the same group is not held again; a changed group is', async () => {
  const f = fakePort()
  const g = group([member(1), member(2)])
  await placeMergeHolds(f.port, ENV, [g])
  assert.deepEqual(f.requests, ['o1', 'o2'])
  // The person confirms both orders in the warehouse without merging: they are NEW again, the hold clears.
  await settleAsNew(f, 'o1', 'o2')
  assert.deepEqual([...f.rows.values()].map((r) => r.state), ['CLEARED', 'CLEARED'])
  // The next detection pass finds the same group (all NEW): nothing is re-held, no new task.
  for (let i = 0; i < 3; i += 1) {
    const again = await placeMergeHolds(f.port, ENV, [g])
    assert.equal(again.skipped, 2)
  }
  assert.deepEqual(f.requests, ['o1', 'o2'], 'no second MarkAwaitingConfirmation')
  assert.equal(f.tasks.length, 1)
  // A new order joins: a different group (different basis), a new decision.
  const bigger = group([member(1), member(2), member(3)])
  await placeMergeHolds(f.port, ENV, [bigger])
  assert.deepEqual(f.requests, ['o1', 'o2', 'o1', 'o2', 'o3'])
  assert.equal(f.rows.get('o1')!.episode, 2)
})

test('decideBeginHold: only a person-decided clear of the SAME group (and warehouse order) is skipped', () => {
  const cleared = { state: 'CLEARED' as const, externalOrderId: 'w1', groupBasis: 'g', refused: false, attempts: 1, clearReason: 'left awaiting confirmation (now NEW)' }
  assert.equal(decideBeginHold(cleared, 'w1', 'g'), 'skip')
  assert.equal(decideBeginHold({ ...cleared, clearReason: 'merge detected' }, 'w1', 'g'), 'skip')
  assert.equal(decideBeginHold(cleared, 'w1', 'other-group'), 'new-episode')
  assert.equal(decideBeginHold(cleared, 'w9', 'g'), 'new-episode')
  assert.equal(decideBeginHold({ ...cleared, clearReason: 'order despatched' }, 'w1', 'g'), 'new-episode')
  assert.equal(decideBeginHold({ ...cleared, state: 'UNKNOWN' as never }, 'w1', 'g'), 'skip')
})

test('UPKEEP vs IN-FLIGHT: a HOLDING row inside its attempt lease is not demoted or settled by a NEW snapshot; after the lease it is', async () => {
  const f = fakePort()
  f.rows.set('o1', { id: 'r1', connector: 'mintsoft', orderId: 'o1', externalOrderId: 'w1', groupBasis: 'g', state: 'HOLDING', episode: 1, attempts: 1, refused: false, lastError: null, heldAt: null, remindedAt: null, clearReason: null, updatedAt: T0 })
  f.observe('o1', { snapshot: { status: 'NEW', externalOrderId: 'w1', fetchedAt: new Date(T0.getTime() + MERGE_HOLD_NEW_GRACE_MS + 1000), lastError: null } })
  f.setClock(() => new Date(T0.getTime() + MERGE_HOLD_ATTEMPT_LEASE_MS - 1000))
  const r = await runMergeHoldMaintenance(f.port, ENV, { hours: 4 })
  assert.equal(f.rows.get('o1')!.state, 'HOLDING')
  assert.deepEqual([r.settledNotHeld, r.confirmedHeld, r.unsettled], [0, 0, 0])
  f.setClock(() => new Date(T0.getTime() + MERGE_HOLD_ATTEMPT_LEASE_MS + 1000))
  await runMergeHoldMaintenance(f.port, ENV, { hours: 4 })
  assert.equal(f.rows.get('o1')!.state, 'NOT_HELD')
})

test('UNKNOWN STATUS NAME: an unrecognised or empty status never clears a HELD row; a task is raised once', async () => {
  for (const status of ['', 'ON_HOLD', 'AWAITING_CUSTOMER_CONFIRMATION']) {
    const f = await heldPair()
    f.observe('o1', { snapshot: { status, externalOrderId: 'w1', fetchedAt: new Date(T0.getTime() + 60_000), lastError: null } })
    const before = f.tasks.length
    const r = await runMergeHoldMaintenance(f.port, ENV, { hours: 4 })
    await runMergeHoldMaintenance(f.port, ENV, { hours: 4 })
    assert.equal(r.cleared, 0, status)
    assert.equal(f.rows.get('o1')!.state, 'HELD', status)
    assert.equal(f.tasks.length, before + 1, `${status}: one task, not one per pass`)
  }
})

test('classifyWarehouseStatus: held / new / left only on recognised names', () => {
  assert.equal(classifyWarehouseStatus('Awaiting Confirmation'), 'held')
  assert.equal(classifyWarehouseStatus('new'), 'new')
  assert.equal(classifyWarehouseStatus('Despatched'), 'left')
  for (const status of ['', null, undefined, 'ON_HOLD']) assert.equal(classifyWarehouseStatus(status), 'unrecognised', String(status))
})

test('a retry-held order is listed as held in the group task text', () => {
  const text = mergeHoldQuery([{ ...member(1), state: 'held' }, { ...member(2), state: 'held' }], [], 'Mintsoft')
  assert.ok(text.includes('W2') && !text.includes('NOT held') && !text.includes('UNKNOWN'))
  const mixed = mergeHoldQuery([{ ...member(1), state: 'held' }, { ...member(2), state: 'unknown' }], [], 'Mintsoft')
  assert.ok(mixed.includes('OUTCOME UNKNOWN'))
})

test('a definite refusal is recorded as refused and is never retried', async () => {
  const f = fakePort({ answers: { o2: { held: false, status: 'REFUSED', message: 'no' } } })
  const result = await placeMergeHolds(f.port, ENV, [group([member(1), member(2)])])
  assert.equal(result.refused, 1)
  assert.equal(f.rows.get('o2')!.refused, true)
  await placeMergeHolds(f.port, ENV, [])
  assert.equal(f.requests.filter((id) => id === 'o2').length, 1)
})

test('a producer-side shadow sends nothing, spends no attempt and leaves no active row', async () => {
  const f = fakePort({ shadowed: true })
  const result = await placeMergeHolds(f.port, ENV, [group([member(1), member(2)])])
  assert.equal(result.shadowed, 2)
  assert.deepEqual(f.requests, [])
  assert.deepEqual([...f.rows.values()].map((r) => [r.state, r.attempts]), [['NOT_HELD', 0], ['NOT_HELD', 0]])
  assert.deepEqual(f.tasks, [])
})

test('no task is raised when nothing was held', async () => {
  const f = fakePort({ answers: { o1: { held: false, status: 'NOT_HOLDABLE' }, o2: { held: false, status: 'NOT_HOLDABLE' } } })
  await placeMergeHolds(f.port, ENV, [group([member(1), member(2)])])
  assert.deepEqual(f.tasks, [])
})

async function heldPair(over: Parameters<typeof fakePort>[0] = {}) {
  const f = fakePort(over)
  await placeMergeHolds(f.port, ENV, [group([member(1), member(2)])])
  return f
}

test('REMINDER: fires once, only after MERGE_HOLD_REMIND_HOURS (default 4)', async () => {
  assert.equal(MERGE_HOLD_REMIND_HOURS_DEFAULT, 4)
  assert.equal(mergeHoldRemindHours({}), 4)
  assert.equal(mergeHoldRemindHours({ MERGE_HOLD_REMIND_HOURS: '2' }), 2)
  assert.equal(mergeHoldRemindHours({ MERGE_HOLD_REMIND_HOURS: 'junk' }), 4)
  assert.equal(mergeHoldRemindHours({ MERGE_HOLD_REMIND_HOURS: '-1' }), 4)
  const f = await heldPair()
  f.observe('o1'); f.observe('o2')
  f.setClock(() => new Date(T0.getTime() + 4 * 3_600_000 - 1000))
  assert.equal((await runMergeHoldMaintenance(f.port, ENV, { hours: 4 })).reminded, 0, 'not yet due')
  f.setClock(() => new Date(T0.getTime() + 4 * 3_600_000))
  assert.equal((await runMergeHoldMaintenance(f.port, ENV, { hours: 4 })).reminded, 2)
  f.setClock(() => new Date(T0.getTime() + 9 * 3_600_000))
  assert.equal((await runMergeHoldMaintenance(f.port, ENV, { hours: 4 })).reminded, 0, 'once only')
  assert.equal(f.tasks.filter((t) => t.reason === 'MERGE_HOLD_OVERDUE').length, 2)
})

test('CLEARING: the hold clears when a snapshot read AFTER the hold shows the order left awaiting confirmation', async () => {
  const f = await heldPair()
  f.observe('o1', { snapshot: { status: 'NEW', externalOrderId: 'w1', fetchedAt: new Date(T0.getTime() + 60_000), lastError: null } })
  f.observe('o2')
  const result = await runMergeHoldMaintenance(f.port, ENV, { hours: 4 })
  assert.equal(result.cleared, 1)
  assert.equal(f.rows.get('o1')!.state, 'CLEARED')
  assert.equal(f.rows.get('o2')!.state, 'HELD')
})

test('STALE MARKER (o3d-3a0t): an old snapshot, one for another warehouse order, or an unreadable one proves nothing and clears nothing', async () => {
  const f = await heldPair()
  f.observe('o1', { snapshot: { status: 'NEW', externalOrderId: 'w1', fetchedAt: new Date(T0.getTime() - 60_000), lastError: null } }) // read BEFORE the hold
  f.observe('o2', { snapshot: { status: 'NEW', externalOrderId: 'w-other', fetchedAt: new Date(T0.getTime() + 60_000), lastError: null } }) // another warehouse order
  const r = await runMergeHoldMaintenance(f.port, ENV, { hours: 4 })
  assert.equal(r.cleared, 0)
  const g = await heldPair()
  g.observe('o1', { snapshot: { status: 'NEW', externalOrderId: 'w1', fetchedAt: new Date(T0.getTime() + 60_000), lastError: 'lookup failed' } })
  assert.equal((await runMergeHoldMaintenance(g.port, ENV, { hours: 4 })).cleared, 0)
})

test('CLEARING: a merge IMS detected (the link points at another warehouse order, or is MERGED) clears the hold; a despatch clears it too', async () => {
  const f = await heldPair()
  f.observe('o1', { link: { state: 'MERGED', externalOrderId: 'w1' } })
  f.observe('o2', { link: { state: 'SYNCED', externalOrderId: 'w-survivor' } })
  assert.equal((await runMergeHoldMaintenance(f.port, ENV, { hours: 4 })).cleared, 2)
  const g = await heldPair()
  g.observe('o1', { orderStatus: 'SHIPPED' })
  assert.equal((await runMergeHoldMaintenance(g.port, ENV, { hours: 4 })).cleared, 1)
})

test('an unrecorded hold answer (HOLDING) is settled by the next fresh status read: held, or not held', async () => {
  const f = fakePort()
  f.rows.set('o1', { id: 'r1', connector: 'mintsoft', orderId: 'o1', externalOrderId: 'w1', groupBasis: 'g', state: 'HOLDING', episode: 1, attempts: 1, refused: false, lastError: null, heldAt: null, remindedAt: null, clearReason: null, updatedAt: T0 })
  f.rows.set('o2', { id: 'r2', connector: 'mintsoft', orderId: 'o2', externalOrderId: 'w2', groupBasis: 'g', state: 'HOLDING', episode: 1, attempts: 1, refused: false, lastError: null, heldAt: null, remindedAt: null, clearReason: null, updatedAt: T0 })
  f.observe('o1')
  f.observe('o2', { snapshot: { status: 'NEW', externalOrderId: 'w2', fetchedAt: new Date(T0.getTime() + MERGE_HOLD_NEW_GRACE_MS + 500), lastError: null } })
  f.setClock(() => new Date(T0.getTime() + MERGE_HOLD_ATTEMPT_LEASE_MS + 1000))
  const result = await runMergeHoldMaintenance(f.port, ENV, { hours: 4 })
  assert.equal(result.confirmedHeld, 1)
  assert.equal(f.rows.get('o1')!.state, 'HELD')
  assert.equal(f.rows.get('o2')!.state, 'NOT_HELD')
})

test('WHILE HELD: a pending edit shows "act in Mintsoft"; a withdrawal and a cancel escalate to a person; nothing is released or cancelled', async () => {
  const f = await heldPair()
  f.observe('o1', { editPending: true })
  f.observe('o2', { withdrawalHoldAt: new Date(T0.getTime() + 1000), orderStatus: 'ON_HOLD' })
  const result = await runMergeHoldMaintenance(f.port, ENV, { hours: 4 })
  assert.deepEqual(f.blocked, ['o1'])
  assert.deepEqual(f.escalated, ['o2:WITHDRAWAL'])
  assert.deepEqual([result.editsBlocked, result.escalated], [1, 1])
  const g = await heldPair()
  g.observe('o1', { orderStatus: 'CANCELLED' })
  g.observe('o2', { refundStatus: 'FULL' })
  await runMergeHoldMaintenance(g.port, ENV, { hours: 4 })
  assert.deepEqual(g.escalated, ['o1:CANCEL', 'o2:CANCEL'])
  assert.ok(mergeHoldActInWarehouse('Mintsoft').includes('Act in Mintsoft'))
  // The port has no release, confirm or cancel operation at all: the only requests ever sent are the two hold requests.
  assert.deepEqual(g.requests, ['o1', 'o2'])
})

test('with no active hold the maintenance reads nothing and writes nothing', async () => {
  const f = fakePort()
  assert.deepEqual(await runMergeHoldMaintenance(f.port, ENV, { hours: 4 }), { cleared: 0, confirmedHeld: 0, settledNotHeld: 0, unsettled: 0, reminded: 0, editsBlocked: 0, escalated: 0 })
  assert.deepEqual(f.writes, [])
})

test('the awaiting-confirmation status is matched leniently', () => {
  for (const status of ['AWAITINGCONFIRMATION', 'Awaiting Confirmation', 'awaiting_confirmation']) assert.equal(isMergeHeldWarehouseStatus(status), true, status)
  for (const status of ['NEW', '', null, undefined, 'CANCELLED']) assert.equal(isMergeHeldWarehouseStatus(status), false, String(status))
})

// ---- the detection pass --------------------------------------------------------------------------------------------------------------------

function detectionPort(placeHolds?: MergeCandidatePort['placeHolds'], extra: Partial<MergeCandidatePort> = {}): MergeCandidatePort {
  const g = group([member(1), member(2)])
  return {
    now: () => T0,
    readMode: async () => 'flag',
    environment: async () => ({ connectorId: 'mintsoft', connectorLabel: 'Mintsoft', tenantScoped: true }),
    loadOrders: async () => [],
    backorderedAmong: async () => new Set(),
    raiseGroupTask: async () => 'created',
    markOwed: async () => {}, clearOwed: async () => {}, isOwed: async () => false,
    resolveTasksNotIn: async () => 0,
    withLock: async (_c, fn) => fn(),
    ...(placeHolds ? { placeHolds } : {}),
    ...extra,
    // The group the fake "detects":
    ...({ __group: g } as object),
  } as MergeCandidatePort
}

test('detection: without placeHolds (or with the setting off) the run has no `holds` key, exactly as before', async () => {
  assert.equal('holds' in (await runMergeCandidateDetection(detectionPort())), false)
  assert.equal('holds' in (await runMergeCandidateDetection(detectionPort(async () => null))), false)
})

test('detection: a failing hold pass never fails the detection, but it is REPORTED (counted failed, a note, a failed cron outcome)', async () => {
  const result = await runMergeCandidateDetection(detectionPort(async () => { throw new Error('boom') }))
  assert.equal(result.mode, 'flag')
  assert.ok(((result as { holds?: { failed: number } }).holds?.failed ?? 0) >= 1)
  const note = mergeCandidateNote(result)
  assert.equal(note?.detection, 'holds-failed')
  assert.equal(cronOutcome('wms-order-status', { scanned: 0, updated: 0, failed: 0, mergeCandidateDetection: note } as never), 'failed')
  assert.equal(cronOutcome('wms-order-status', { scanned: 0, updated: 0, failed: 0, ...mergeHoldMaintenanceNoteFixture() } as never), 'failed')
  assert.equal(cronOutcome('wms-order-status', { scanned: 0, updated: 0, failed: 0 } as never), 'ok')
})

function mergeHoldMaintenanceNoteFixture() {
  return { mergeHoldMaintenance: mergeHoldMaintenanceNote({ error: 'db down' }) }
}

test('detection: the hold pass result is reported when holds ran', async () => {
  const result = await runMergeCandidateDetection(detectionPort(async () => ({ held: 2, refused: 0, failed: 0, shadowed: 0, skipped: 0 })))
  assert.deepEqual((result as { holds?: unknown }).holds, { held: 2, refused: 0, failed: 0, shadowed: 0, skipped: 0 })
})

test('detection: a candidate task whose group has a member that MAY be held is not resolved, even though the group no longer qualifies', async () => {
  let keep: readonly string[] = []
  await runMergeCandidateDetection(detectionPort(undefined, { unsettledHoldBases: async () => ['basis-unknown'], resolveTasksNotIn: async (_c, bases) => { keep = bases; return 0 } }))
  assert.ok(keep.includes('basis-unknown'))
  keep = ['untouched']
  await runMergeCandidateDetection(detectionPort(undefined, { unsettledHoldBases: async () => { throw new Error('db down') }, resolveTasksNotIn: async (_c, bases) => { keep = bases; return 0 } }))
  assert.deepEqual(keep, ['untouched'], 'nothing is resolved when the unsettled holds cannot be read')
})


// ---- round 3: UNKNOWN rows past NEW / cancelled orders, late-landing holds, person decisions, deadline ----------------------------------------

const AFTER_GRACE = new Date(T0.getTime() + MERGE_HOLD_NEW_GRACE_MS + 60_000)
const snap = (n: number, status: string, fetchedAt: Date = AFTER_GRACE) => ({ status, externalOrderId: `w${n}`, fetchedAt, lastError: null })
const MAY_BE_HELD = ['HOLDING', 'HELD', 'UNKNOWN']

test('TIMEOUT, then the warehouse allocates, then the customer cancels: the row settles (the push resumes) from a fresh snapshot', async () => {
  const f = fakePort({ answers: { o2: 'throw' } })
  await placeMergeHolds(f.port, ENV, [group([member(1), member(2)])])
  assert.equal(f.rows.get('o2')!.state, 'UNKNOWN')
  f.observe('o2', { orderStatus: 'CANCELLED', snapshot: snap(2, 'ALLOCATED') })
  const r = await runMergeHoldMaintenance(f.port, ENV, { hours: 4 })
  assert.equal(r.settledNotHeld, 1)
  const row = f.rows.get('o2')!
  assert.equal(MAY_BE_HELD.includes(row.state), false, 'no longer withholds the push sweep: the cancel is pushed')
  assert.equal(row.refused, true)
  assert.ok(row.lastError?.includes('ALLOCATED'), 'the reason is recorded')
  assert.deepEqual(f.escalated, [])
})

test('TIMEOUT, warehouse allocates, customer cancels, but no fresh snapshot: the cancel escalates AT ONCE (never withheld silently), once', async () => {
  const f = fakePort({ answers: { o2: 'throw' } })
  await placeMergeHolds(f.port, ENV, [group([member(1), member(2)])])
  f.observe('o2', { orderStatus: 'CANCELLED', snapshot: null })
  const first = await runMergeHoldMaintenance(f.port, ENV, { hours: 4 })
  const second = await runMergeHoldMaintenance(f.port, ENV, { hours: 4 })
  assert.deepEqual(f.escalated, ['o2:CANCEL'])
  assert.deepEqual([first.escalated, second.escalated], [1, 0], 'result.escalated counts only newly created tasks')
  assert.equal(f.rows.get('o2')!.state, 'UNKNOWN')
})

test('a withdrawal and a pending edit on an UNKNOWN row escalate / show "act in" like a HELD row', async () => {
  const f = fakePort({ answers: { o1: 'throw', o2: 'throw' } })
  await placeMergeHolds(f.port, ENV, [group([member(1), member(2)])])
  f.observe('o1', { editPending: true, snapshot: null })
  f.observe('o2', { withdrawalApprovedAt: AFTER_GRACE, snapshot: null })
  const r = await runMergeHoldMaintenance(f.port, ENV, { hours: 4 })
  assert.deepEqual(f.blocked, ['o1'])
  assert.deepEqual(f.escalated, ['o2:WITHDRAWAL'])
  assert.deepEqual([r.editsBlocked, r.escalated], [1, 1])
})

test('a TERMINAL (cancelled) IMS order with an UNKNOWN row and an unrecognised status: escalated at once, one unsettled task however often the status moves', async () => {
  const f = fakePort({ answers: { o2: 'throw' } })
  await placeMergeHolds(f.port, ENV, [group([member(1), member(2)])])
  const before = f.tasks.length
  for (const status of ['ON_HOLD', 'WEIRD', 'ON_HOLD']) {
    f.resetObservations()
    f.observe('o2', { orderStatus: 'CANCELLED', snapshot: snap(2, status) })
    await runMergeHoldMaintenance(f.port, ENV, { hours: 4 })
  }
  assert.deepEqual(f.escalated, ['o2:CANCEL'])
  assert.equal(f.tasks.length, before + 1, 'one task per order and episode, not per status')
  assert.ok(f.tasks[f.tasks.length - 1].queryText.includes('ON_HOLD'), 'the open task is re-worded with the current status')
  assert.equal(f.rows.get('o2')!.state, 'UNKNOWN')
})

test('the unsettled-task basis has no status in it', () => {
  assert.equal(mergeHoldUnsettledBasis({ orderId: 'o1', episode: 2 }, 'UNKNOWN_OUTCOME'), 'merge-hold-unsettled:o1:2:UNKNOWN_OUTCOME')
})

test('PAST NEW settles the row: ALLOCATED, PICKING, PACKED and a warehouse CANCELLED are NOT_HELD (refused, never re-held, no request)', async () => {
  for (const status of ['ALLOCATED', 'PICKING', 'PACKED', 'CANCELLED']) {
    const f = fakePort({ answers: { o1: 'throw', o2: 'throw' } })
    await placeMergeHolds(f.port, ENV, [group([member(1), member(2)])])
    const sent = f.requests.length
    f.observe('o1', { snapshot: snap(1, status) })
    f.observe('o2', { snapshot: snap(2, 'AWAITINGCONFIRMATION') })
    const r = await runMergeHoldMaintenance(f.port, ENV, { hours: 4 })
    assert.equal(r.settledNotHeld, 1, status)
    assert.equal(f.rows.get('o1')!.state, 'NOT_HELD', status)
    assert.equal(f.rows.get('o1')!.refused, true, status)
    assert.equal(f.rows.get('o2')!.state, 'HELD', status)
    await placeMergeHolds(f.port, ENV, [group([member(1), member(2)])])
    await placeMergeHolds(f.port, ENV, [])
    assert.equal(f.requests.length, sent, `${status}: no second hold request`)
  }
})

test('LATE-LANDING hold: a NEW read inside the grace period (the lease) does not settle an UNKNOWN row; one after it does', async () => {
  const f = fakePort({ answers: { o1: 'throw', o2: 'throw' } })
  await placeMergeHolds(f.port, ENV, [group([member(1), member(2)])])
  f.observe('o1', { snapshot: snap(1, 'NEW', new Date(T0.getTime() + MERGE_HOLD_NEW_GRACE_MS - 1000)) })
  f.observe('o2', { snapshot: snap(2, 'NEW', new Date(T0.getTime() + 5000)) })
  const early = await runMergeHoldMaintenance(f.port, ENV, { hours: 4 })
  assert.deepEqual([early.settledNotHeld, early.unsettled], [0, 2])
  assert.deepEqual([f.rows.get('o1')!.state, f.rows.get('o2')!.state], ['UNKNOWN', 'UNKNOWN'])
  assert.equal(f.tasks.filter((t) => t.reason === 'MERGE_HOLD').length, 1, 'the group task stays; a premature NEW raises no new one')
  f.resetObservations()
  f.observe('o1', { snapshot: snap(1, 'NEW') })
  f.observe('o2', { snapshot: snap(2, 'NEW') })
  const late = await runMergeHoldMaintenance(f.port, ENV, { hours: 4 })
  assert.equal(late.settledNotHeld, 2)
})

test('every member UNKNOWN: the group task stays and the overdue reminder covers UNKNOWN rows (once)', async () => {
  const f = fakePort({ answers: { o1: 'throw', o2: 'throw' } })
  await placeMergeHolds(f.port, ENV, [group([member(1), member(2)])])
  f.observe('o1', { snapshot: null })
  f.observe('o2', { snapshot: null })
  f.setClock(() => new Date(T0.getTime() + 4 * 3_600_000))
  assert.equal((await runMergeHoldMaintenance(f.port, ENV, { hours: 4 })).reminded, 2)
  assert.equal((await runMergeHoldMaintenance(f.port, ENV, { hours: 4 })).reminded, 0, 'once only')
  assert.equal(f.tasks.filter((t) => t.reason === 'MERGE_HOLD_OVERDUE').length, 2)
  assert.deepEqual([...f.rows.values()].map((r) => r.state), ['UNKNOWN', 'UNKNOWN'])
})

test('CONFIRM WITHOUT MERGING with an UNKNOWN-but-held member: the person decision covers it, the next detection pass does not hold it again', async () => {
  const f = fakePort({ answers: { o2: 'throw' } })
  const g = group([member(1), member(2)])
  await placeMergeHolds(f.port, ENV, [g])
  assert.deepEqual(f.requests, ['o1', 'o2'])
  // The person confirms both as they are: o1 (HELD) reads NEW, o2 (UNKNOWN, really held) reads NEW after the lease.
  f.observe('o1', { snapshot: snap(1, 'NEW') })
  f.observe('o2', { snapshot: snap(2, 'NEW') })
  await runMergeHoldMaintenance(f.port, ENV, { hours: 4 })
  assert.equal(f.rows.get('o1')!.state, 'CLEARED')
  assert.equal(f.rows.get('o2')!.state, 'CLEARED', 'not retryable NOT_HELD')
  assert.ok(f.rows.get('o2')!.clearReason?.startsWith('left awaiting confirmation'))
  const tasks = f.tasks.length
  for (let i = 0; i < 3; i += 1) assert.equal((await placeMergeHolds(f.port, ENV, [g])).skipped, 2)
  assert.deepEqual(f.requests, ['o1', 'o2'], 'no second MarkAwaitingConfirmation')
  assert.equal(f.tasks.length, tasks, 'no new group task')
})

test('REVISE on the re-detection path: all members UNKNOWN, settled NOT_HELD, re-held by detection: the open group task is re-worded', async () => {
  const answers: Record<string, WmsOrderHoldResult | 'throw'> = { o1: 'throw', o2: 'throw' }
  const f = fakePort({ answers })
  const g = group([member(1), member(2)])
  await placeMergeHolds(f.port, ENV, [g])
  assert.ok(f.tasks[0].queryText.includes('OUTCOME UNKNOWN'))
  await settleAsNew(f, 'o1', 'o2')
  delete answers.o1
  delete answers.o2
  const revisedBefore = f.revised.length
  const again = await placeMergeHolds(f.port, ENV, [g])
  assert.equal(again.held, 2)
  assert.ok(f.revised.length > revisedBefore, 'reviseGroupTask is called on the detection path')
  assert.equal(f.tasks.filter((t) => t.reason === 'MERGE_HOLD').length, 1)
  assert.ok(!f.tasks[0].queryText.includes('OUTCOME UNKNOWN'), f.tasks[0].queryText)
})

test('the hold request has an overall deadline shorter than the lease: a request that never answers is an UNKNOWN outcome, not a stuck attempt', async () => {
  assert.ok(MERGE_HOLD_REQUEST_DEADLINE_MS < MERGE_HOLD_ATTEMPT_LEASE_MS, 'deadline < lease')
  assert.ok(MERGE_HOLD_NEW_GRACE_MS >= MERGE_HOLD_ATTEMPT_LEASE_MS)
  const f = fakePort({ hang: new Set(['o2']) })
  const result = await placeMergeHolds(f.port, ENV, [group([member(1), member(2)])], { requestDeadlineMs: 20 })
  assert.deepEqual([result.held, result.failed], [1, 1])
  assert.equal(f.rows.get('o2')!.state, 'UNKNOWN')
  assert.ok(f.rows.get('o2')!.lastError?.includes('did not finish'))
  // The deadline cannot be set past the lease.
  const g = fakePort({ hang: new Set(['o1']) })
  const started = Date.now()
  await assert.rejects(withDeadline(new Promise(() => {}), 10, 'x'), /did not finish/)
  assert.ok(Date.now() - started < 5000)
  assert.equal((await withDeadline(Promise.resolve(7), 1000, 'x')), 7)
  void g
})

// ---- structural: no release path, and the blocked queries -----------------------------------------------------------------------------------

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return entry === 'generated' ? [] : sources(full)
    return /\.(ts|tsx)$/.test(full) ? [full] : []
  })
}

test('NEVER AUTO-RELEASE: the merge-hold modules call nothing that releases, confirms or cancels, and the port type has no such operation', () => {
  for (const file of ['lib/domain/wms/merge-hold.ts', 'lib/domain/wms/merge-hold-port.ts']) {
    const text = readFileSync(join(process.cwd(), file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    assert.equal(/\.cancelOrder\s*\(|\.releaseOrder\s*\(|\.confirmOrder\s*\(|MarkConfirmed|\.cancelMergedOrder\s*\(/.test(text), false, file)
  }
  const portKeys = ['release', 'confirm', 'cancel'].filter((word) => readFileSync(join(process.cwd(), 'lib/domain/wms/merge-hold.ts'), 'utf8').match(new RegExp(`^\\s+${word}\\w*\\(`, 'm')))
  assert.deepEqual(portKeys, [])
  for (const file of sources(join(process.cwd(), 'lib'))) {
    const text = readFileSync(file, 'utf8')
    if (file.includes('/merge-hold')) continue
    assert.equal(/holdOrder\s*\(/.test(text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')) && !file.includes('connectors'), false, `${file} calls holdOrder outside the merge-hold port`)
  }
})

test('the status sweep keeps polling an order with an active hold row after IMS cancels it', () => {
  const text = readFileSync(join(process.cwd(), 'lib/domain/wms/order-status-sweep.ts'), 'utf8')
  assert.match(text, /wmsMergeHolds: \{ some: \{ state: \{ in: \['HOLDING', 'HELD', 'UNKNOWN'/)
  const push = readFileSync(join(process.cwd(), 'lib/domain/wms/order-push-sweep.ts'), 'utf8')
  assert.match(push, /runMergeHoldMaintenanceSafe\('the order push'\)/, 'the push sweep settles or escalates what it withholds')
})

test('WHILE HELD: the push sweep queries leave a merge-held order out (edits, holds and cancels are not pushed)', () => {
  const text = readFileSync(join(process.cwd(), 'lib/domain/wms/order-push-sweep.ts'), 'utf8')
  assert.equal((text.match(/wms_merge_holds/g) ?? []).length >= 1, true, 'the amend query excludes held orders')
  assert.equal((text.match(/wmsMergeHolds: \{ none/g) ?? []).length, 2, 'the hold and cancel queries exclude held orders')
})

// ---- round 4: an order IMS cancelled / withdrew is never (re-)held ------------------------------------------------------------------------

const reviewerPath = async (variant: 'CANCEL' | 'WITHDRAWAL') => {
  const f = fakePort({ answers: { o2: 'throw' } })
  await placeMergeHolds(f.port, ENV, [group([member(1), member(2)])])
  assert.equal(f.rows.get('o2')!.state, 'UNKNOWN')
  // B is cancelled (or withdrawn) in IMS: maintenance escalates the UNKNOWN row; a person closes the task (the escalation key stays recorded, as a DONE task dedupes).
  f.orders.set('o2', variant === 'CANCEL'
    ? { status: 'CANCELLED', refundStatus: 'NONE', withdrawalHoldAt: null, withdrawalApprovedAt: null }
    : { status: 'PROCESSING', refundStatus: 'NONE', withdrawalHoldAt: T0, withdrawalApprovedAt: null })
  const tooSoon = { status: 'NEW', externalOrderId: 'w2', fetchedAt: new Date(T0.getTime() + 60_000), lastError: null }
  f.observe('o2', variant === 'CANCEL' ? { orderStatus: 'CANCELLED', snapshot: tooSoon } : { withdrawalHoldAt: T0, snapshot: tooSoon })
  const first = await runMergeHoldMaintenance(f.port, ENV, { hours: 4 })
  assert.equal(first.escalated, 1, 'the maybe-held order is escalated while it is UNKNOWN')
  // B then reads NEW after the grace period: settled retryable, and detection / the retry pass runs.
  f.resetObservations()
  const at = new Date(T0.getTime() + MERGE_HOLD_NEW_GRACE_MS + 60_000)
  f.observe('o2', { orderStatus: variant === 'CANCEL' ? 'CANCELLED' : 'PROCESSING', withdrawalHoldAt: variant === 'WITHDRAWAL' ? T0 : null, snapshot: { status: 'NEW', externalOrderId: 'w2', fetchedAt: at, lastError: null } })
  await runMergeHoldMaintenance(f.port, ENV, { hours: 4 })
  assert.equal(f.rows.get('o2')!.state, 'NOT_HELD')
  const before = f.requests.filter((id) => id === 'o2').length
  const pass = await placeMergeHolds(f.port, ENV, [])
  assert.equal(f.requests.filter((id) => id === 'o2').length, before, 'B is NOT re-held')
  assert.equal(pass.held, 0)
  assert.equal(f.rows.get('o2')!.state, 'NOT_HELD')
  assert.equal(f.rows.get('o2')!.refused, true, 'settled refused with a recorded reason, so the withheld push resumes')
  assert.match(f.rows.get('o2')!.lastError ?? '', /Not held: /)
  // Nothing sits held-and-withheld: the row is not active, so the cancel / withdrawal push is not withheld.
  assert.ok(!['HOLDING', 'HELD', 'UNKNOWN'].includes(f.rows.get('o2')!.state))
}

test('REVIEWER PATH (cancel): UNKNOWN B cancelled in IMS, cancel task closed, B reads NEW: B is not re-held and its row stops withholding the cancel', async () => { await reviewerPath('CANCEL') })
test('REVIEWER PATH (withdrawal): the same for a withdrawn order', async () => { await reviewerPath('WITHDRAWAL') })

test('first-attempt detection never holds an order IMS has cancelled, withdrawn or fully refunded', async () => {
  for (const order of [
    { status: 'CANCELLED', refundStatus: 'NONE', withdrawalHoldAt: null, withdrawalApprovedAt: null },
    { status: 'PROCESSING', refundStatus: 'FULL', withdrawalHoldAt: null, withdrawalApprovedAt: null },
    { status: 'PROCESSING', refundStatus: 'NONE', withdrawalHoldAt: T0, withdrawalApprovedAt: null },
    { status: 'PROCESSING', refundStatus: 'NONE', withdrawalHoldAt: null, withdrawalApprovedAt: T0 },
  ]) {
    const f = fakePort()
    f.orders.set('o2', order)
    await placeMergeHolds(f.port, ENV, [group([member(1), member(2)])])
    assert.deepEqual(f.requests, ['o1'], JSON.stringify(order))
    assert.equal(f.rows.has('o2'), false)
  }
})

test('a re-held order escalates again: the attempt number is part of the cancel / withdrawal dedupe key', () => {
  const row = { orderId: 'o2', episode: 1, attempts: 1 }
  assert.notEqual(mergeHoldWithdrawalBasis(row, 'CANCEL'), mergeHoldWithdrawalBasis({ ...row, attempts: 2 }, 'CANCEL'))
  assert.equal(mergeHoldIneligibleReason({ status: 'PROCESSING', refundStatus: 'NONE', withdrawalHoldAt: null, withdrawalApprovedAt: null }), null)
})
