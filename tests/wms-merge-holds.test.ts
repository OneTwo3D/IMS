import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import type { WmsOrderHoldResult } from '../lib/connectors/wms/types.ts'
import type { MergeGroup } from '../lib/domain/wms/merge-candidate-match.ts'
import { MERGE_WARNING_EU, MERGE_WARNING_FEDEX } from '../lib/domain/wms/merge-candidate-match.ts'
import { runMergeCandidateDetection, type MergeCandidatePort } from '../lib/domain/wms/merge-candidates.ts'
import {
  mergeHoldActInWarehouse,
  MERGE_HOLD_MAX_ATTEMPTS,
  MERGE_HOLD_REMIND_HOURS_DEFAULT,
  isMergeHeldWarehouseStatus,
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

type Task = { reason: string; basis: string; queryText: string; orderId: string }

function fakePort(opts: { enabled?: boolean; shadowed?: boolean; answers?: Record<string, WmsOrderHoldResult | 'throw'>; now?: () => Date } = {}) {
  const rows = new Map<string, MergeHoldRow>()
  const requests: string[] = []
  const writes: string[] = []
  const tasks: Task[] = []
  const blocked: string[] = []
  const escalated: string[] = []
  const reminders: string[] = []
  const cleared: Array<{ orderId: string; reason: string }> = []
  let clock = opts.now ?? (() => T0)
  const answers = opts.answers ?? {}
  const port: MergeHoldPort = {
    now: () => clock(),
    isEnabled: async () => opts.enabled ?? true,
    async beginHold(env, m, basis) {
      const existing = rows.get(m.orderId)
      if (existing && (existing.state === 'HOLDING' || existing.state === 'HELD')) return null
      if (existing?.state === 'NOT_HELD' && existing.externalOrderId === m.externalOrderId && (existing.refused || existing.attempts >= MERGE_HOLD_MAX_ATTEMPTS)) return null
      const row: MergeHoldRow = existing
        ? { ...existing, state: 'HOLDING', attempts: existing.state === 'NOT_HELD' && existing.externalOrderId === m.externalOrderId ? existing.attempts + 1 : 1, episode: existing.state === 'CLEARED' ? existing.episode + 1 : existing.episode, heldAt: null, remindedAt: null, refused: false, groupBasis: basis }
        : { id: `r-${m.orderId}`, connector: env.connectorId, orderId: m.orderId, externalOrderId: m.externalOrderId, groupBasis: basis, state: 'HOLDING', episode: 1, attempts: 1, refused: false, lastError: null, heldAt: null, remindedAt: null, updatedAt: T0 }
      rows.set(m.orderId, row)
      writes.push(`begin:${m.orderId}`)
      return row
    },
    async requestHold(_env, m) {
      if (opts.shadowed) return { shadowed: true as const }
      requests.push(m.orderId)
      const answer = answers[m.orderId] ?? { held: true, status: 'HELD' }
      if (answer === 'throw') throw new Error('Mintsoft 500')
      return answer
    },
    async abandonHold(row) { rows.set(row.orderId, { ...rows.get(row.orderId)!, state: 'NOT_HELD', attempts: row.attempts - 1 }); writes.push(`abandon:${row.orderId}`) },
    async recordHeld(row, at) { rows.set(row.orderId, { ...rows.get(row.orderId)!, state: 'HELD', heldAt: at, updatedAt: at }); writes.push(`held:${row.orderId}`) },
    async recordNotHeld(row, o) { rows.set(row.orderId, { ...rows.get(row.orderId)!, state: 'NOT_HELD', refused: o.refused, lastError: o.error }); writes.push(`notheld:${row.orderId}`) },
    async retryableMembers() {
      const out: Array<{ member: MergeHoldMember; groupBasis: string }> = []
      for (const row of rows.values()) {
        if (row.state !== 'NOT_HELD' || row.refused || row.attempts >= MERGE_HOLD_MAX_ATTEMPTS) continue
        if (![...rows.values()].some((o) => o.groupBasis === row.groupBasis && (o.state === 'HELD' || o.state === 'HOLDING'))) continue
        out.push({ groupBasis: row.groupBasis, member: member(Number(row.orderId.slice(1))) })
      }
      return out
    },
    async raiseGroupTask(env, g, heldFlags, episodes) {
      const queryText = mergeHoldQuery(g.members.map((m) => ({ ...m, held: heldFlags.get(m.orderId) === true })), g.warnings, env.connectorLabel)
      const basis = mergeHoldTaskBasis(g, episodes)
      if (!tasks.some((t) => t.basis === basis)) tasks.push({ reason: 'MERGE_HOLD', basis, queryText, orderId: g.members[0].orderId })
    },
    async logNotHeld(row) { writes.push(`log-notheld:${row.orderId}`) },
    async activeRows() { return observations.filter((o) => rows.get(o.row.orderId)?.state === 'HELD' || rows.get(o.row.orderId)?.state === 'HOLDING').map((o) => ({ ...o, row: rows.get(o.row.orderId)! })) },
    async clear(row, reason) {
      const current = rows.get(row.orderId)!
      if (current.state !== 'HELD' && current.state !== 'HOLDING') return false
      rows.set(row.orderId, { ...current, state: 'CLEARED' })
      cleared.push({ orderId: row.orderId, reason })
      return true
    },
    async promoteToHeld(row, at) { rows.set(row.orderId, { ...rows.get(row.orderId)!, state: 'HELD', heldAt: at }); return true },
    async demoteToNotHeld(row, error) { rows.set(row.orderId, { ...rows.get(row.orderId)!, state: 'NOT_HELD', lastError: error }); return true },
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
    async escalate(_env, obs, kind) { escalated.push(`${obs.row.orderId}:${kind}`) },
  }
  const observations: MergeHoldObservation[] = []
  /** Register what the maintenance will read for an order (its row is read back from `rows`). */
  const observe = (orderId: string, over: Partial<Omit<MergeHoldObservation, 'row'>> = {}) => {
    const n = Number(orderId.slice(1))
    observations.push({
      row: rows.get(orderId)!, orderNumber: `T-${n}`, orderStatus: 'PROCESSING', refundStatus: 'NONE', shippedAt: null, withdrawalHoldAt: null, withdrawalApprovedAt: null, editPending: false,
      link: { state: 'SYNCED', externalOrderId: `w${n}` },
      snapshot: { status: 'AWAITINGCONFIRMATION', externalOrderId: `w${n}`, fetchedAt: new Date(T0.getTime() + 60_000), lastError: null },
      ...over,
    })
  }
  return { port, rows, requests, writes, tasks, blocked, escalated, reminders, cleared, observe, setClock: (fn: () => Date) => { clock = fn } }
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

test('a transport failure is NOT a refusal: the order is "not held", retried, and the other order is still held', async () => {
  const f = fakePort({ answers: { o2: 'throw' } })
  const g = group([member(1), member(2)])
  const first = await placeMergeHolds(f.port, ENV, [g])
  assert.deepEqual([first.held, first.failed, first.refused], [1, 1, 0])
  assert.equal(f.rows.get('o2')!.state, 'NOT_HELD')
  assert.equal(f.rows.get('o2')!.refused, false, 'retryable')
  assert.ok(f.tasks[0].queryText.includes('NOT held'), 'the task names the order that is not held')
  // The held order left NEW, so the group is no longer detected: the retry pass picks the failed order up on its own.
  const again = await placeMergeHolds(f.port, ENV, [])
  assert.equal(again.failed, 1, 'retried (and failed again with the same fake)')
  assert.equal(f.requests.filter((id) => id === 'o2').length, 2)
})

test('a transport failure that later succeeds ends HELD', async () => {
  const answers: Record<string, WmsOrderHoldResult | 'throw'> = { o2: 'throw' }
  const f = fakePort({ answers })
  await placeMergeHolds(f.port, ENV, [group([member(1), member(2)])])
  delete answers.o2
  const again = await placeMergeHolds(f.port, ENV, [])
  assert.equal(again.held, 1)
  assert.equal(f.rows.get('o2')!.state, 'HELD')
})

test('a transport failure is retried only up to the bound', async () => {
  const f = fakePort({ answers: { o2: 'throw' } })
  await placeMergeHolds(f.port, ENV, [group([member(1), member(2)])])
  for (let i = 0; i < 10; i += 1) await placeMergeHolds(f.port, ENV, [])
  assert.equal(f.requests.filter((id) => id === 'o2').length, MERGE_HOLD_MAX_ATTEMPTS)
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
  f.rows.set('o1', { id: 'r1', connector: 'mintsoft', orderId: 'o1', externalOrderId: 'w1', groupBasis: 'g', state: 'HOLDING', episode: 1, attempts: 1, refused: false, lastError: null, heldAt: null, remindedAt: null, updatedAt: T0 })
  f.rows.set('o2', { id: 'r2', connector: 'mintsoft', orderId: 'o2', externalOrderId: 'w2', groupBasis: 'g', state: 'HOLDING', episode: 1, attempts: 1, refused: false, lastError: null, heldAt: null, remindedAt: null, updatedAt: T0 })
  f.observe('o1')
  f.observe('o2', { snapshot: { status: 'NEW', externalOrderId: 'w2', fetchedAt: new Date(T0.getTime() + 60_000), lastError: null } })
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
  assert.deepEqual(await runMergeHoldMaintenance(f.port, ENV, { hours: 4 }), { cleared: 0, confirmedHeld: 0, reminded: 0, editsBlocked: 0, escalated: 0 })
  assert.deepEqual(f.writes, [])
})

test('the awaiting-confirmation status is matched leniently', () => {
  for (const status of ['AWAITINGCONFIRMATION', 'Awaiting Confirmation', 'awaiting_confirmation']) assert.equal(isMergeHeldWarehouseStatus(status), true, status)
  for (const status of ['NEW', '', null, undefined, 'CANCELLED']) assert.equal(isMergeHeldWarehouseStatus(status), false, String(status))
})

// ---- the detection pass --------------------------------------------------------------------------------------------------------------------

function detectionPort(placeHolds?: MergeCandidatePort['placeHolds']): MergeCandidatePort {
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
    // The group the fake "detects":
    ...({ __group: g } as object),
  } as MergeCandidatePort
}

test('detection: without placeHolds (or with the setting off) the run has no `holds` key, exactly as before', async () => {
  assert.equal('holds' in (await runMergeCandidateDetection(detectionPort())), false)
  assert.equal('holds' in (await runMergeCandidateDetection(detectionPort(async () => null))), false)
})

test('detection: a failing hold pass never fails the detection', async () => {
  const result = await runMergeCandidateDetection(detectionPort(async () => { throw new Error('boom') }))
  assert.equal(result.mode, 'flag')
  assert.equal('holds' in result, false)
})

test('detection: the hold pass result is reported when holds ran', async () => {
  const result = await runMergeCandidateDetection(detectionPort(async () => ({ held: 2, refused: 0, failed: 0, shadowed: 0, skipped: 0 })))
  assert.deepEqual((result as { holds?: unknown }).holds, { held: 2, refused: 0, failed: 0, shadowed: 0, skipped: 0 })
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

test('WHILE HELD: the push sweep queries leave a merge-held order out (edits, holds and cancels are not pushed)', () => {
  const text = readFileSync(join(process.cwd(), 'lib/domain/wms/order-push-sweep.ts'), 'utf8')
  assert.equal((text.match(/wms_merge_holds/g) ?? []).length >= 1, true, 'the amend query excludes held orders')
  assert.equal((text.match(/wmsMergeHolds: \{ none/g) ?? []).length, 2, 'the hold and cancel queries exclude held orders')
})
