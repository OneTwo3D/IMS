/**
 * THE DEFAULT INBOUND-DELTA SCOPE LOCK, ON A REAL POSTGRES (o3d-j8yq).
 *
 * WHAT HAD NO COVERAGE. `defaultWmsDeltaScopeLock` (lib/domain/wms/delta-scope-lock.ts) is what a
 * connector gets when it declares no `hooks.deltaScopeLock` of its own, and its docstring makes a
 * CONCURRENCY claim: a connector whose scope lock covers OTHER rows (Mintsoft's five dispatch
 * settings) and this default, which covers the CURSOR rows themselves, "both establish the same
 * happens-before". Before this file the function was referenced only by its own module and by
 * lib/domain/wms/dispatch-sweep.ts, no test imported it, and the Mintsoft path was tested against a
 * hand-written stand-in rather than the real lock. The claim is about what two concurrent
 * transactions can do to each other, so it is not decidable against a double at all: an in-memory
 * `$queryRaw` that returns rows has no notion of `FOR UPDATE` and will happily let both sides
 * proceed.
 *
 * SO THIS RACES THE REAL FUNCTION on genuinely separate connections. Gated behind
 * RUN_DB_CONCURRENCY_TESTS=1 like every other file here. It never touches a production settings key:
 * every key is `j8yq_scope_lock_test_<uuid>_*`, and they are deleted afterwards.
 *
 * WHAT IS PROVED, AND WHAT IS NOT.
 *   - PROVED: the default lock serializes a read-then-write pair against a concurrent one over the
 *     same rows, and does NOT serialize it against one over a different connector's rows.
 *   - PROVED THE RIG CAN FAIL: the same interleaving run WITHOUT the lock loses an update, and the
 *     assertion that detects it is the same one.
 *   - NOT PROVED, and deliberately stated rather than implied: that the generation chain ALONE is a
 *     sufficient fence for a connector with no scope binding. The default's scope token is the
 *     constant `unbound`, so the save-time compare-and-swap over it is unconditional — asserted
 *     below as the fact it is. Whether the generation chain suffices on its own is a design
 *     question about `saveWmsDeltaCursors`, not something this lock can answer.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

import {
  WMS_DELTA_SCOPE_UNBOUND,
  defaultWmsDeltaScopeLock,
  type WmsDeltaScopeLockTx,
} from '../../lib/domain/wms/delta-scope-lock.ts'

const SKIP = process.env.RUN_DB_CONCURRENCY_TESTS !== '1'

/**
 * A `WmsDeltaScopeLockTx` backed by ONE raw pg connection.
 *
 * Prisma's tagged-template raw API hands the callee the string parts and the interpolated values
 * separately, which is exactly a parameterized query — so this is a translation, not a
 * reimplementation. The SQL the lock issues is unchanged, and `FOR UPDATE` is enforced by Postgres.
 */
function pgScopeLockTx(client: import('pg').Client): WmsDeltaScopeLockTx & { statements: string[] } {
  const statements: string[] = []
  const toSql = (parts: TemplateStringsArray, values: unknown[]) =>
    parts.reduce((acc, part, i) => acc + part + (i < values.length ? `$${i + 1}` : ''), '')
  return {
    statements,
    async $executeRaw(parts: TemplateStringsArray, ...values: unknown[]) {
      const sql = toSql(parts, values)
      statements.push(sql)
      const result = await client.query(sql, values as never[])
      return result.rowCount ?? 0
    },
    async $queryRaw<T = unknown>(parts: TemplateStringsArray, ...values: unknown[]): Promise<T> {
      const sql = toSql(parts, values)
      statements.push(sql)
      const result = await client.query(sql, values as never[])
      return result.rows as T
    },
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Whether this backend is parked on a lock right now — positive evidence, not a bare timeout. */
async function isWaitingOnLock(probe: import('pg').Client, pid: number): Promise<boolean> {
  const { rows } = await probe.query<{ waiting: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_stat_activity
        WHERE pid = $1 AND wait_event_type = 'Lock'
     ) AS waiting`,
    [pid],
  )
  return rows[0]?.waiting === true
}

async function waitUntilBlocked(probe: import('pg').Client, pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await isWaitingOnLock(probe, pid)) return true
    await wait(50)
  }
  return false
}

test('default WMS delta scope lock: a concurrent read-then-write pair over the SAME cursor rows is serialized', { skip: SKIP }, async () => {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const url = process.env.DATABASE_URL
  assert.ok(url, 'DATABASE_URL must be set for the concurrency tests')

  const { Client } = await import('pg')
  const run = randomUUID()
  // Throwaway keys shaped like a connector's three delta state rows. The default lock takes whatever
  // keys it is given, so the SHAPE is what matters and no production row is involved.
  const keys = [`j8yq_${run}_order_delta_since`, `j8yq_${run}_order_reconcile_at`, `j8yq_${run}_order_delta_generation`]
  const watermarkKey = keys[0]

  const a = new Client({ connectionString: url })
  const b = new Client({ connectionString: url })
  const probe = new Client({ connectionString: url })
  await Promise.all([a.connect(), b.connect(), probe.connect()])

  try {
    const lock = defaultWmsDeltaScopeLock(keys)
    const txA = pgScopeLockTx(a)
    const txB = pgScopeLockTx(b)
    const bPid = (await b.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid

    // --- A takes the lock and reads its watermark --------------------------------------------
    await a.query('BEGIN')
    const tokenA = await lock(txA)
    assert.equal(tokenA, WMS_DELTA_SCOPE_UNBOUND, 'the default reports the unbound scope token')
    const readA = (await a.query<{ value: string | null }>('SELECT value FROM settings WHERE key = $1', [watermarkKey])).rows[0]?.value
    // The materialise step inserts `''`, which every reader of a settings key treats as absent.
    assert.equal(readA, '', 'precondition: A read the pre-image under its own lock')

    // --- B tries to take the SAME lock, and must park on it -----------------------------------
    await b.query('BEGIN')
    let bLockResolved = false
    const bLock = lock(txB).then((token) => { bLockResolved = true; return token })

    const blocked = await waitUntilBlocked(probe, bPid)
    assert.ok(blocked, 'B must be parked on a lock — without FOR UPDATE it would sail straight through')
    assert.equal(bLockResolved, false, 'and its scope lock has therefore not returned')

    // --- A writes and commits -----------------------------------------------------------------
    await a.query(
      `INSERT INTO settings (key, value, "updatedAt") VALUES ($1, 'A', now())
         ON CONFLICT (key) DO UPDATE SET value = 'A', "updatedAt" = now()`,
      [watermarkKey],
    )
    await a.query('COMMIT')

    // --- B now proceeds, and MUST see A's write ----------------------------------------------
    const tokenB = await bLock
    assert.equal(tokenB, WMS_DELTA_SCOPE_UNBOUND)
    const readB = (await b.query<{ value: string | null }>('SELECT value FROM settings WHERE key = $1', [watermarkKey])).rows[0]?.value
    assert.equal(
      readB, 'A',
      'B read AFTER A committed, which is the whole of the happens-before: a B that saw the pre-image'
      + ' here would go on to write a watermark computed from a state that no longer exists',
    )
    await b.query(
      `UPDATE settings SET value = 'B', "updatedAt" = now() WHERE key = $1`,
      [watermarkKey],
    )
    await b.query('COMMIT')

    const final = (await probe.query<{ value: string | null }>('SELECT value FROM settings WHERE key = $1', [watermarkKey])).rows[0]?.value
    assert.equal(final, 'B', 'the two passes applied in order, neither lost')

    // The lock really did take a row lock over the keys it was given, in canonical (sorted) order.
    const forUpdate = txA.statements.filter((s) => /FOR UPDATE/.test(s))
    assert.equal(forUpdate.length, 1, `the lock issued exactly one FOR UPDATE (got ${forUpdate.length})`)
  } finally {
    await probe.query('DELETE FROM settings WHERE key = ANY($1::text[])', [keys]).catch(() => {})
    await Promise.all([a.end(), b.end(), probe.end()])
  }
})

test('default WMS delta scope lock: the SAME interleaving without the lock loses an update — the rig can fail', { skip: SKIP }, async () => {
  // PROVE THE RIG CAN FIND SOMETHING WITH THE SUBJECT REMOVED. The test above would pass just as
  // happily if `FOR UPDATE` did nothing but the timing happened to be favourable, so the identical
  // interleaving is run with the lock replaced by a plain unlocked read. The assertion that catches
  // it is the same one: B's read must see A's write.
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const url = process.env.DATABASE_URL
  assert.ok(url, 'DATABASE_URL must be set for the concurrency tests')

  const { Client } = await import('pg')
  const run = randomUUID()
  const key = `j8yq_${run}_unlocked_order_delta_since`

  const a = new Client({ connectionString: url })
  const b = new Client({ connectionString: url })
  const probe = new Client({ connectionString: url })
  await Promise.all([a.connect(), b.connect(), probe.connect()])

  try {
    await probe.query(`INSERT INTO settings (key, value, "updatedAt") VALUES ($1, '', now())`, [key])

    await a.query('BEGIN')
    await b.query('BEGIN')
    // NO lock: exactly the read both transactions would do if the scope lock were a no-op.
    const readA = (await a.query<{ value: string | null }>('SELECT value FROM settings WHERE key = $1', [key])).rows[0]?.value
    const readB = (await b.query<{ value: string | null }>('SELECT value FROM settings WHERE key = $1', [key])).rows[0]?.value
    assert.equal(readA, '', 'precondition: A read the pre-image')

    await a.query(`UPDATE settings SET value = 'A', "updatedAt" = now() WHERE key = $1`, [key])
    await a.query('COMMIT')

    // THE DETECTION, stated as the negation of the guarantee the locked test asserts.
    assert.notEqual(
      readB, 'A',
      'the unlocked rig must observe the STALE read — if it cannot, the locked test above proves'
      + ' nothing, because the interleaving it claims to prevent never happens here either',
    )
    assert.equal(readB, '', 'B is holding a watermark A has already superseded')

    // And the consequence: B writes over a state it never saw. READ COMMITTED lets this commit.
    await b.query(`UPDATE settings SET value = 'B-from-stale-read', "updatedAt" = now() WHERE key = $1`, [key])
    await b.query('COMMIT')
    const final = (await probe.query<{ value: string | null }>('SELECT value FROM settings WHERE key = $1', [key])).rows[0]?.value
    assert.equal(final, 'B-from-stale-read', 'A’s advance was lost, which is what the lock exists to stop')
  } finally {
    await probe.query('DELETE FROM settings WHERE key = $1', [key]).catch(() => {})
    await Promise.all([a.end(), b.end(), probe.end()])
  }
})

test('default WMS delta scope lock: it locks THIS connector’s rows and NOT another connector’s', { skip: SKIP }, async () => {
  // The other half of the docstring's claim — "lock the connector's OWN cursor rows, never another
  // connector's". Without it, a default lock that widened its key set would serialize every
  // connector's sweep against every other one, which is a liveness bug nothing else here would see.
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const url = process.env.DATABASE_URL
  assert.ok(url, 'DATABASE_URL must be set for the concurrency tests')

  const { Client } = await import('pg')
  const run = randomUUID()
  const mine = [`j8yq_${run}_alpha_order_delta_since`, `j8yq_${run}_alpha_order_delta_generation`]
  const theirs = [`j8yq_${run}_beta_order_delta_since`, `j8yq_${run}_beta_order_delta_generation`]

  const a = new Client({ connectionString: url })
  const b = new Client({ connectionString: url })
  const probe = new Client({ connectionString: url })
  await Promise.all([a.connect(), b.connect(), probe.connect()])

  try {
    await a.query('BEGIN')
    await defaultWmsDeltaScopeLock(mine)(pgScopeLockTx(a))

    await b.query('BEGIN')
    // Must NOT block: a different connector's delta state is a different set of rows.
    const token = await Promise.race([
      defaultWmsDeltaScopeLock(theirs)(pgScopeLockTx(b)),
      wait(4000).then(() => 'TIMED-OUT' as const),
    ])
    assert.equal(
      token, WMS_DELTA_SCOPE_UNBOUND,
      'a second connector’s sweep must not be serialized behind the first one’s scope lock',
    )
    await b.query('COMMIT')
    await a.query('COMMIT')
  } finally {
    await probe.query('DELETE FROM settings WHERE key = ANY($1::text[])', [[...mine, ...theirs]]).catch(() => {})
    await Promise.all([a.end(), b.end(), probe.end()])
  }
})

test('default WMS delta scope lock: its token is a CONSTANT, so a save-time scope comparison is unconditional', { skip: SKIP }, async () => {
  // Documented and deliberate (lib/domain/wms/delta-scope-lock.ts), and written down as an
  // executable fact because it is the load-bearing consequence: for a connector with no scope
  // binding, `scope` cannot carry information, so the generation chain is the ONLY fence on the
  // cursor write. This test asserts the premise; it does not assert that the fence suffices.
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const url = process.env.DATABASE_URL
  assert.ok(url, 'DATABASE_URL must be set for the concurrency tests')

  const { Client } = await import('pg')
  const run = randomUUID()
  const keys = [`j8yq_${run}_token_order_delta_since`]
  const client = new Client({ connectionString: url })
  await client.connect()

  try {
    const lock = defaultWmsDeltaScopeLock(keys)
    await client.query('BEGIN')
    const first = await lock(pgScopeLockTx(client))
    // Change the row under the SAME transaction's nose, then re-read the scope.
    await client.query(`UPDATE settings SET value = 'moved', "updatedAt" = now() WHERE key = $1`, [keys[0]])
    const second = await lock(pgScopeLockTx(client))
    await client.query('COMMIT')

    assert.equal(first, WMS_DELTA_SCOPE_UNBOUND)
    assert.equal(
      second, first,
      'the default token does not move when the rows move — which is why `scope` is not a fence here',
    )
  } finally {
    await client.query('DELETE FROM settings WHERE key = ANY($1::text[])', [keys]).catch(() => {})
    await client.end()
  }
})
