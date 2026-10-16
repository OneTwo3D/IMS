import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * THE XERO PRODUCER SEAM AGAINST A REAL DATABASE: THE DIFFERENTIAL, THE SHADOW STORE AND ITS UNIQUE KEY.
 *
 * Drives the REAL queue entry points (the in-transaction enqueue, the facade and the primitive) over fixtures that
 * the other tiers only model: the same enqueue is run with the switch OFF, with the switch ON and no grant (the
 * P0/P1 posture), and with the switch ON and every condition for LIVE, and the rows, outbox jobs, accounting events
 * and shadow records each run leaves are read back.
 *
 * Fixtures are unique per run (reference ids carry a uuid) and removed afterwards; the settings the enqueue reads are
 * put back as they were. GATED on RUN_DB_RETENTION_TESTS (npm run test:db).
 *
 * Named mutations (shown red in the PR, restored from a copy, md5-verified):
 *  a  shadow-queues-an-outbox-job   a caller schedules the outbox job for a shadow: the "no outbox job" arm goes red
 *  b  live-without-grant            the seam answers live with no grant: the ungranted arm goes red
 *  c  drop-the-unique-key           the shadow upsert becomes a plain insert: the repeat arm goes red
 *  d  mirror-a-shadow               a shadow is mirrored to an accounting event: the "no event" arm goes red
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'

if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1: tests/db/xero-producer-seam.test.ts would have been skipped.')
}

const TENANT = '4f7f0c6e-1111-4222-8333-944455556666'
const ENV_KEYS = ['PRODUCER_HOLD_ENFORCED_DESTINATIONS', 'XERO_WRITE_ALLOWED_TENANT', 'XERO_WRITES_LIVE_FROM']
const LIVE_ENV = { PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'xero', XERO_WRITE_ALLOWED_TENANT: TENANT, XERO_WRITES_LIVE_FROM: '2020-01-01T00:00:00Z' }
const SETTINGS = [['plugin_xero_enabled', 'true'], ['xero_sync_enabled', 'true']] as const

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any

async function deps() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const [{ db }, accounting, { createAccountingSyncLogRow }, { AccountingSyncType }] = await Promise.all([
    import('../../lib/db/index.ts'),
    import('../../lib/accounting.ts'),
    import('../../lib/domain/accounting/sync-log-row.ts'),
    import('../../app/generated/prisma/client.ts'),
  ])
  return { db, accounting, createAccountingSyncLogRow, AccountingSyncType }
}

async function withEnv<T>(values: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const)
  for (const key of ENV_KEYS) delete process.env[key]
  Object.assign(process.env, values)
  try { return await fn() } finally {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
}

async function withSettings<T>(db: Awaited<ReturnType<typeof deps>>['db'], fn: () => Promise<T>): Promise<T> {
  const before = await db.setting.findMany({ where: { key: { in: SETTINGS.map(([key]) => key) } } })
  for (const [key, value] of SETTINGS) await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
  try { return await fn() } finally {
    for (const [key] of SETTINGS) {
      const prior = before.find((row: { key: string }) => row.key === key)
      if (prior) await db.setting.update({ where: { key }, data: { value: prior.value } })
      else await db.setting.deleteMany({ where: { key } })
    }
  }
}

async function readBack(db: Awaited<ReturnType<typeof deps>>['db'], referenceId: string) {
  const rows = await db.accountingSyncLog.findMany({
    where: { referenceId },
    select: { id: true, status: true, settlementBasis: true, abandonedBeforeRemoteCall: true, externalTransactionId: true, errorMessage: true, type: true },
    orderBy: { createdAt: 'asc' },
  })
  const outbox = []
  for (const row of rows) outbox.push(...await db.integrationOutbox.findMany({ where: { idempotencyKey: { contains: row.id } }, select: { id: true, status: true } }))
  const events = await db.accountingEvent.count({ where: { sourceEntityId: referenceId } })
  const shadows = await db.outboundShadowWrite.findMany({ where: { subjectId: referenceId }, select: { id: true, destination: true, operation: true, occurrences: true, accountingSyncLogId: true, reason: true, owner: true, phase: true, grantState: true, payloadDigest: true } })
  return { rows, outbox, events, shadows }
}

async function cleanup(db: Awaited<ReturnType<typeof deps>>['db'], referenceIds: string[]): Promise<void> {
  for (const referenceId of referenceIds) {
    const rows = await db.accountingSyncLog.findMany({ where: { referenceId: { startsWith: referenceId } }, select: { id: true } })
    for (const row of rows) await db.integrationOutbox.deleteMany({ where: { idempotencyKey: { contains: row.id } } }).catch(() => undefined)
    await db.accountingEvent.deleteMany({ where: { sourceEntityId: { startsWith: referenceId } } }).catch(() => undefined)
    await db.outboundShadowWrite.deleteMany({ where: { subjectId: { startsWith: referenceId } } })
    await db.accountingSyncLog.deleteMany({ where: { referenceId: { startsWith: referenceId } } })
  }
}

const payload = (referenceId: string, date = '2026-06-01') => ({
  date,
  narration: `producer seam probe ${referenceId}`,
  lines: [
    { description: 'Inventory', accountCode: '630', debit: 16 },
    { description: 'Allocated Inventory', accountCode: '631', credit: 16 },
  ],
})

async function enqueueTx(d: Awaited<ReturnType<typeof deps>>, referenceId: string, date?: string) {
  let outcome: Awaited<ReturnType<typeof d.accounting.queueAccountingSyncTxWithOutcome>> | null = null
  await d.db.$transaction(async (tx: Tx) => {
    outcome = await d.accounting.queueAccountingSyncTxWithOutcome(tx, {
      type: 'UNEARNED_REV_REVERSAL', connector: 'xero', referenceType: 'CogsEntry', referenceId, payload: payload(referenceId, date), chartConnector: 'xero',
    })
  }, { timeout: 60_000, maxWait: 30_000 })
  return outcome!
}

test('DIFFERENTIAL through the in-transaction enqueue: OFF queues a PENDING row and its outbox job; ON with no grant queues nothing and records a shadow; ON fully granted is identical to OFF', { skip }, async (t) => {
  const d = await deps()
  const ids = { off: `PSEAM-off-${randomUUID()}`, ungranted: `PSEAM-ung-${randomUUID()}`, live: `PSEAM-live-${randomUUID()}` }
  t.after(() => cleanup(d.db, Object.values(ids)))
  await withSettings(d.db, async () => {
    const off = await withEnv({}, () => enqueueTx(d, ids.off))
    const ungranted = await withEnv({ PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'xero' }, () => enqueueTx(d, ids.ungranted))
    const live = await withEnv(LIVE_ENV, () => enqueueTx(d, ids.live))
    const [a, b, c] = [await readBack(d.db, ids.off), await readBack(d.db, ids.ungranted), await readBack(d.db, ids.live)]
    console.log(`# switch OFF      : outcome=${JSON.stringify(off)} rows=${JSON.stringify(a.rows.map((r) => [r.status, r.settlementBasis]))} outbox=${a.outbox.length} events=${a.events} shadows=${a.shadows.length}`)
    console.log(`# ON, no grant    : outcome=${JSON.stringify(ungranted)} rows=${JSON.stringify(b.rows.map((r) => [r.status, r.settlementBasis]))} outbox=${b.outbox.length} events=${b.events} shadows=${b.shadows.length}`)
    console.log(`# ON, fully granted: outcome=${JSON.stringify(live)} rows=${JSON.stringify(c.rows.map((r) => [r.status, r.settlementBasis]))} outbox=${c.outbox.length} events=${c.events} shadows=${c.shadows.length}`)

    // PRECONDITION: the OFF run reached the thing the other two are compared against.
    assert.equal(off.queued, true)
    assert.equal(off.reason, undefined)
    assert.deepEqual(a.rows.map((r) => r.status), ['PENDING'])
    assert.equal(a.outbox.length, 1, 'PRECONDITION: the queued row got its outbox job, so "no outbox job" below is not vacuous')
    assert.ok(a.events >= 1, 'PRECONDITION: the queued row was mirrored to an accounting event')

    // THE P0/P1 POSTURE: nothing is queued, nothing is mirrored, one shadow is recorded.
    assert.equal(ungranted.queued, true)
    assert.equal(ungranted.reason, 'shadowed')
    assert.deepEqual(b.rows.map((r) => [r.status, r.settlementBasis, r.abandonedBeforeRemoteCall, r.externalTransactionId]), [['CANCELLED', 'HELD_SHADOW', true, null]])
    assert.match(String(b.rows[0]!.errorMessage), /^Not sent by IMS: writes to Xero are held on this installation/)
    assert.equal(b.rows.filter((r) => r.status === 'PENDING' || r.status === 'PROCESSING').length, 0, 'no claimable row')
    assert.equal(b.outbox.length, 0, 'no outbox job for a shadow')
    assert.equal(b.events, 0, 'a shadow is not an accounting event')
    assert.equal(b.shadows.length, 1)
    assert.deepEqual([b.shadows[0]!.destination, b.shadows[0]!.operation, b.shadows[0]!.occurrences, b.shadows[0]!.reason, b.shadows[0]!.grantState, b.shadows[0]!.phase], ['xero', 'inventory.journals', 1, 'no_grant', 'absent', 'P1'])
    assert.equal(b.shadows[0]!.accountingSyncLogId, b.rows[0]!.id)

    // FULLY GRANTED + IMS-OWNED + DATED AFTER THE CUT-OFF: identical to the switch-off run.
    const answer = (o: { queued: boolean; reason?: string; connector: string | null }) => ({ queued: o.queued, reason: o.reason, connector: o.connector })
    assert.deepEqual(answer(live), answer(off), 'the same answer to the caller')
    assert.deepEqual(c.rows.map((r) => [r.status, r.settlementBasis, r.abandonedBeforeRemoteCall]), a.rows.map((r) => [r.status, r.settlementBasis, r.abandonedBeforeRemoteCall]))
    assert.equal(c.outbox.length, a.outbox.length)
    assert.equal(c.events, a.events)
    assert.equal(c.shadows.length, 0)
  })
})

test('the same shadowed work repeated (the recreate sweeps and retries do this every tick) makes ONE sync row and ONE shadow that counts the repeats', { skip }, async (t) => {
  const d = await deps()
  const referenceId = `PSEAM-rep-${randomUUID()}`
  t.after(() => cleanup(d.db, [referenceId]))
  await withSettings(d.db, async () => {
    await withEnv({ PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'xero' }, async () => {
      const first = await enqueueTx(d, referenceId)
      const second = await enqueueTx(d, referenceId)
      const third = await enqueueTx(d, referenceId)
      const back = await readBack(d.db, referenceId)
      console.log(`# repeats: outcomes=${[first, second, third].map((o) => o.reason).join(',')} rows=${back.rows.length} shadows=${JSON.stringify(back.shadows.map((s) => s.occurrences))}`)
      assert.deepEqual([first.reason, second.reason, third.reason], ['shadowed', 'shadowed', 'shadowed'])
      assert.equal(back.rows.length, 1, 'one CANCELLED shadow row, however many times the work is produced')
      assert.equal(back.shadows.length, 1)
      assert.equal(back.shadows[0]!.occurrences, 3)
      // CHANGED work is different work: a new digest, a new shadow.
      let changed: Awaited<ReturnType<typeof enqueueTx>> | null = null
      await d.db.$transaction(async (tx: Tx) => {
        changed = await d.accounting.queueAccountingSyncTxWithOutcome(tx, {
          type: 'UNEARNED_REV_REVERSAL', connector: 'xero', referenceType: 'CogsEntry', referenceId,
          payload: { ...payload(referenceId), narration: 'a different posting for the same document' }, chartConnector: 'xero',
        })
      })
      const after = await readBack(d.db, referenceId)
      assert.equal(changed!.reason, 'shadowed')
      assert.equal(after.rows.length, 2)
      assert.deepEqual(after.shadows.map((s) => s.occurrences).sort(), [1, 3])
    })
  })
})

test('the FACADE (queueAccountingSync -> the Xero queue) obeys the seam too: OFF queues, ON ungranted records a shadow and queues nothing', { skip }, async (t) => {
  const d = await deps()
  const ids = { off: `PSEAM-fo-${randomUUID()}`, on: `PSEAM-fn-${randomUUID()}` }
  t.after(() => cleanup(d.db, Object.values(ids)))
  await withSettings(d.db, async () => {
    const call = (referenceId: string) => d.accounting.queueAccountingSync({
      type: 'UNEARNED_REV_REVERSAL', referenceType: 'CogsEntry', referenceId, payload: payload(referenceId), chartConnector: 'xero',
    })
    const off = await withEnv({}, () => call(ids.off))
    const on = await withEnv({ PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'xero' }, () => call(ids.on))
    const [a, b] = [await readBack(d.db, ids.off), await readBack(d.db, ids.on)]
    console.log(`# facade OFF: ${JSON.stringify(off)} rows=${a.rows.map((r) => r.status)} outbox=${a.outbox.length}; ON ungranted: ${JSON.stringify(on)} rows=${b.rows.map((r) => r.status)} outbox=${b.outbox.length} shadows=${b.shadows.length}`)
    assert.equal(off.queued, true)
    assert.deepEqual(a.rows.map((r) => r.status), ['PENDING'])
    assert.equal(a.outbox.length, 1, 'PRECONDITION: the OFF run produced an outbox job')
    assert.equal(on.queued, true)
    assert.equal(on.reason, 'shadowed')
    assert.deepEqual(b.rows.map((r) => [r.status, r.settlementBasis]), [['CANCELLED', 'HELD_SHADOW']])
    assert.equal(b.outbox.length, 0)
    assert.equal(b.events, 0)
    assert.equal(b.shadows.length, 1)
  })
})

test('EVERY AccountingSyncType through the primitive in the P0/P1 posture (switch ON, nothing granted): no row is claimable, no job is queued; the rows that are shadows are the writing types', { skip }, async (t) => {
  const d = await deps()
  const referenceId = `PSEAM-all-${randomUUID()}`
  t.after(() => cleanup(d.db, [referenceId]))
  const types = Object.values(d.AccountingSyncType) as string[]
  await withEnv({ PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'xero' }, async () => {
    await d.db.$transaction(async (tx: Tx) => {
      for (const type of types) {
        await d.createAccountingSyncLogRow(tx, {
          connector: 'xero', type: type as never, status: 'PENDING', referenceType: 'ProbeDocument', referenceId: `${referenceId}:${type}`, payload: { date: '2026-06-01', probe: type },
        })
      }
    })
  })
  const rows = await d.db.accountingSyncLog.findMany({ where: { referenceId: { startsWith: `${referenceId}:` } }, select: { type: true, status: true, settlementBasis: true } })
  const shadowRows = await d.db.outboundShadowWrite.findMany({ where: { subjectId: { startsWith: `${referenceId}:` } }, select: { operation: true, destination: true } })
  const claimable = rows.filter((r) => r.status === 'PENDING' || r.status === 'PROCESSING')
  console.log(`# every type, ungranted: ${types.length} types -> ${rows.length} rows, ${rows.filter((r) => r.settlementBasis === 'HELD_SHADOW').length} shadows, ${claimable.length} claimable (${claimable.map((r) => r.type).join(',')}); shadow records ${shadowRows.length}`)
  assert.equal(rows.length, types.length)
  // The two non-writes (a PDF fetch, an e-mail) and the WooCommerce invoice note (WooCommerce is not enforced) are untouched; every other type is a shadow.
  assert.deepEqual(claimable.map((r) => r.type).sort(), ['INVOICE_EMAIL', 'INVOICE_PDF', 'WC_INVOICE_NOTE'])
  assert.equal(rows.filter((r) => r.settlementBasis === 'HELD_SHADOW').length, types.length - 3)
  assert.equal(shadowRows.length, types.length - 3)
  for (const row of rows) if (row.settlementBasis === 'HELD_SHADOW') assert.equal(row.status, 'CANCELLED')
})

test('the shadow store: the unique key is real (a duplicate insert is refused), and a stale pointer (the sync row deleted by retention) is not trusted', { skip }, async (t) => {
  const d = await deps()
  const referenceId = `PSEAM-key-${randomUUID()}`
  t.after(() => cleanup(d.db, [referenceId]))
  const { recordOutboundShadow } = await import('../../lib/domain/outbound-shadow/record.ts')
  const decision = { disposition: 'SHADOW', reason: 'no_grant', owner: 'qoblex-native', phase: 'P1', cutoff: null, grant: 'absent' } as const
  const input = { destination: 'xero', operation: 'purchase.bill', subjectType: 'ProbeDocument', subjectId: referenceId, payload: { a: 1, _stamp: 'x' }, decision } as const
  const first = await recordOutboundShadow(d.db, input)
  const repeat = await recordOutboundShadow(d.db, { ...input, payload: { _stamp: 'different bookkeeping', a: 1 } })
  assert.equal(first.inserted, true)
  assert.equal(repeat.inserted, false)
  assert.equal(repeat.occurrences, 2)
  assert.equal(first.digest, repeat.digest, 'bookkeeping stamps (leading underscore) and key order do not change the digest')
  // A raw duplicate of the unique key is refused by the database itself.
  await assert.rejects(
    () => d.db.outboundShadowWrite.create({ data: { destination: 'xero', operation: 'purchase.bill', subjectType: 'ProbeDocument', subjectId: referenceId, payloadDigest: first.digest, reason: 'no_grant', owner: 'qoblex-native', phase: 'P1', grantState: 'absent' } }),
    /Unique constraint|unique|duplicate/i,
  )
  // A pointer to a sync row that no longer exists (retention) is reported as no row, so the caller writes a new one.
  await d.db.outboundShadowWrite.update({ where: { id: first.id }, data: { accountingSyncLogId: 'gone-' + randomUUID() } })
  const stale = await recordOutboundShadow(d.db, input)
  assert.equal(stale.accountingSyncLogId, null)
  assert.equal(stale.occurrences, 3)
})

test('the migration made what the code assumes: nothing but a record (no foreign keys, no triggers), the digest column is 64 characters, the repeat index exists', { skip }, async () => {
  const d = await deps()
  const columns = await d.db.$queryRaw<Array<{ column_name: string; data_type: string; character_maximum_length: number | null }>>`
    SELECT column_name, data_type, character_maximum_length FROM information_schema.columns WHERE table_name = 'outbound_shadow_writes' ORDER BY ordinal_position`
  const fks = await d.db.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM information_schema.table_constraints WHERE table_name = 'outbound_shadow_writes' AND constraint_type = 'FOREIGN KEY'`
  const triggers = await d.db.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM information_schema.triggers WHERE event_object_table = 'outbound_shadow_writes'`
  const unique = await d.db.$queryRaw<Array<{ indexname: string }>>`SELECT indexname FROM pg_indexes WHERE tablename = 'outbound_shadow_writes' ORDER BY indexname`
  console.log(`# outbound_shadow_writes: ${columns.length} columns, ${fks[0]!.n} foreign keys, ${triggers[0]!.n} triggers, indexes ${unique.map((u) => u.indexname).join(',')}`)
  assert.equal(columns.length, 16)
  assert.equal(columns.find((c) => c.column_name === 'payload_digest')!.character_maximum_length, 64)
  assert.equal(fks[0]!.n, 0)
  assert.equal(triggers[0]!.n, 0)
  assert.ok(unique.some((u) => u.indexname === 'outbound_shadow_writes_work_key'))
})
