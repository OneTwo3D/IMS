import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

import { backendPid, waitUntilParkedBehind } from '../helpers/lock-wait-observer.ts'

/**
 * TWO PRODUCERS OF THE SAME SHADOWED WORK MAKE ONE SYNC ROW AND ONE SHADOW THAT COUNTS TWO.
 *
 * The shadow store dedupes with `INSERT ... ON CONFLICT DO UPDATE` and the Xero primitive serialises same-key work
 * under the posting key's advisory lock. Both are PostgreSQL properties; no double can exhibit them, so each is raced
 * for real. Nothing sleeps: the first producer keeps its transaction OPEN until the second is OBSERVED parked behind it
 * (tests/helpers/lock-wait-observer.ts), and the test fails loudly if the park is never seen.
 *
 * Arm 1 races the primitive (createAccountingSyncLogRow). The second producer parks on the posting-key advisory lock,
 * and after the first commits it must find the first's shadow row and write nothing.
 * Arm 2 races the shadow store alone (recordOutboundShadow) on the same unique key, which is the backstop for two
 * producers whose posting keys differ but whose work digests the same: the second parks on the first's uncommitted
 * unique-key entry and then counts a repeat.
 *
 * Named mutations (shown red in the PR, restored from a copy, md5-verified):
 *  a  plain-insert        the shadow upsert becomes an INSERT with no ON CONFLICT: arm 2 fails with a unique violation
 *  b  skip-the-key-lock   createAccountingSyncLogRow stops taking the posting-key lock: arm 1 goes red as "never parked"
 *  c  always-new-row      the repeat is not recognised and a second sync row is written: arm 1 goes red (two rows)
 */
const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const TX = { timeout: 30_000, maxWait: 20_000 }
const ENV_KEYS = ['PRODUCER_HOLD_ENFORCED_DESTINATIONS']

async function loadDeps() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
  const [{ db }, { createAccountingSyncLogRow }, { recordOutboundShadow }] = await Promise.all([
    import('../../lib/db/index.ts'),
    import('../../lib/domain/accounting/sync-log-row.ts'),
    import('../../lib/domain/outbound-shadow/record.ts'),
  ])
  return { db, createAccountingSyncLogRow, recordOutboundShadow }
}

type Db = Awaited<ReturnType<typeof loadDeps>>['db']

async function cleanup(db: Db, referenceId: string): Promise<void> {
  await db.outboundShadowWrite.deleteMany({ where: { subjectId: referenceId } })
  await db.accountingSyncLog.deleteMany({ where: { referenceId } })
}

test('[producer hold] two producers of the same shadowed posting: one CANCELLED shadow row, one shadow record with occurrences 2', { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' }, async (t) => {
  const { db, createAccountingSyncLogRow } = await loadDeps()
  const referenceId = `PSHADOW-race-${randomUUID()}`
  t.after(() => cleanup(db, referenceId))
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const)
  process.env.PRODUCER_HOLD_ENFORCED_DESTINATIONS = 'xero'
  t.after(() => { for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })

  const data = {
    connector: 'xero', type: 'PURCHASE_INVOICE', status: 'PENDING', referenceType: 'PurchaseOrder', referenceId,
    payload: { date: '2026-06-01', _idempotencyKey: `race-${referenceId}`, amount: 12.5 },
  } as const
  let firstDone!: (pid: number) => void
  const firstHasWritten = new Promise<number>((resolve) => { firstDone = resolve })
  let parkedSeen: { pid: number; observedAfterMs: number } | null = null
  let firstReleasedAt = 0
  let secondDoneAt = 0
  let secondResult: Awaited<ReturnType<typeof createAccountingSyncLogRow>> | null = null
  let firstResult: Awaited<ReturnType<typeof createAccountingSyncLogRow>> | null = null

  const first = db.$transaction(async (tx) => {
    const pid = await backendPid(tx)
    firstResult = await createAccountingSyncLogRow(tx as never, data as never)
    firstDone(pid)
    parkedSeen = await waitUntilParkedBehind(db, { holderPid: pid, waitingOn: /pg_advisory_xact_lock/i, describe: 'second producer behind the first (posting-key lock)' })
    firstReleasedAt = Date.now()
  }, TX)
  const second = (async () => {
    await firstHasWritten
    return db.$transaction(async (tx) => {
      secondResult = await createAccountingSyncLogRow(tx as never, data as never)
    }, TX).then(() => { secondDoneAt = Date.now() })
  })()
  const [a, b] = await Promise.allSettled([first, second])
  if (a.status === 'rejected') throw a.reason
  if (b.status === 'rejected') throw b.reason

  const rows = await db.accountingSyncLog.findMany({ where: { referenceId }, select: { id: true, status: true, settlementBasis: true } })
  const shadows = await db.outboundShadowWrite.findMany({ where: { subjectId: referenceId }, select: { occurrences: true, accountingSyncLogId: true } })
  console.log(`# race 1: second parked after ${parkedSeen!.observedAfterMs}ms, finished ${secondDoneAt - firstReleasedAt}ms after the first released; rows=${JSON.stringify(rows.map((r) => [r.status, r.settlementBasis]))} shadows=${JSON.stringify(shadows)}`)
  assert.ok(parkedSeen && parkedSeen.pid > 0, 'PRECONDITION: the second producer was observed parked behind the first')
  assert.ok(secondDoneAt >= firstReleasedAt, 'the second could not have finished before the first released the lock')
  assert.ok(firstResult!.shadowed && !firstResult!.row, 'PRECONDITION: the first producer wrote the shadow')
  assert.ok(secondResult!.shadowed && !secondResult!.row, 'the second saw a shadow too')
  assert.equal(rows.length, 1, 'one sync-log row')
  assert.deepEqual([rows[0]!.status, rows[0]!.settlementBasis], ['CANCELLED', 'HELD_SHADOW'])
  assert.deepEqual(shadows.map((s) => s.occurrences), [2])
  assert.equal(shadows[0]!.accountingSyncLogId, rows[0]!.id)
  assert.equal(secondResult!.shadowed!.id, rows[0]!.id, 'the second was handed the first\'s row')
})

test('[producer hold] two producers of the same work digest on the shadow store alone: the second parks on the first\'s unique key and counts a repeat', { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' }, async (t) => {
  const { db, recordOutboundShadow } = await loadDeps()
  const referenceId = `PSHADOW-store-${randomUUID()}`
  t.after(() => cleanup(db, referenceId))
  const decision = { disposition: 'SHADOW', reason: 'no_grant', owner: 'qoblex-native', phase: 'P1', cutoff: null, grant: 'absent' } as const
  const input = { destination: 'xero', operation: 'purchase.bill', subjectType: 'ProbeDocument', subjectId: referenceId, payload: { amount: 5 }, decision } as const

  let firstDone!: (pid: number) => void
  const firstHasInserted = new Promise<number>((resolve) => { firstDone = resolve })
  let parkedSeen: { pid: number; observedAfterMs: number } | null = null
  let firstResult: Awaited<ReturnType<typeof recordOutboundShadow>> | null = null
  let secondResult: Awaited<ReturnType<typeof recordOutboundShadow>> | null = null

  const first = db.$transaction(async (tx) => {
    const pid = await backendPid(tx)
    firstResult = await recordOutboundShadow(tx, input)
    firstDone(pid)
    parkedSeen = await waitUntilParkedBehind(db, { holderPid: pid, waitingOn: /outbound_shadow_writes/i, describe: 'second shadow record behind the first (unique key)' })
  }, TX)
  const second = (async () => {
    await firstHasInserted
    await db.$transaction(async (tx) => { secondResult = await recordOutboundShadow(tx, input) }, TX)
  })()
  const [a, b] = await Promise.allSettled([first, second])
  if (a.status === 'rejected') throw a.reason
  if (b.status === 'rejected') throw b.reason
  const stored = await db.outboundShadowWrite.findMany({ where: { subjectId: referenceId }, select: { occurrences: true } })
  console.log(`# race 2: parked after ${parkedSeen!.observedAfterMs}ms; first inserted=${firstResult!.inserted}, second inserted=${secondResult!.inserted} occurrences=${secondResult!.occurrences}; stored=${JSON.stringify(stored)}`)
  assert.ok(parkedSeen && parkedSeen.pid > 0, 'PRECONDITION: the second record was observed parked on the unique key')
  assert.equal(firstResult!.inserted, true)
  assert.equal(secondResult!.inserted, false)
  assert.deepEqual(stored.map((s) => s.occurrences), [2])
})
