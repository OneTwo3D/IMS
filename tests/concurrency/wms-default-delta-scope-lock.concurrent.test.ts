/**
 * THE DEFAULT INBOUND-DELTA SCOPE LOCK, ON A REAL POSTGRES (o3d-j8yq).
 *
 * WHAT HAD NO COVERAGE. `defaultWmsDeltaScopeLock` (lib/domain/wms/delta-scope-lock.ts) is what a
 * connector gets when it declares no `hooks.deltaScopeLock` of its own, and its docstring makes a
 * CONCURRENCY claim: a connector whose scope lock covers OTHER rows (Mintsoft's five dispatch
 * settings) and this default, which covers the CURSOR rows themselves, "both establish the same
 * happens-before". The claim is about what two concurrent transactions can do to each other, so it is
 * not decidable against a double at all: an in-memory `$queryRaw` that returns rows has no notion of
 * `FOR UPDATE` and will happily let both sides proceed. So this races the real function on genuinely
 * separate connections, gated behind RUN_DB_CONCURRENCY_TESTS=1 like every other file here, on
 * throwaway `j8yq_<uuid>_*` keys that are deleted afterwards.
 *
 * ROUND 2 — WHY THE FIRST FIXTURE PROVED SOMETHING ELSE (Codex r1 HIGH). The first version raced two
 * transactions over keys that DID NOT YET EXIST. `lockWmsSettingRows` materialises its rows with
 * `INSERT ... ON CONFLICT DO NOTHING`, and Postgres makes an `ON CONFLICT` insert WAIT for a
 * conflicting speculative insertion from an uncommitted transaction (`CEOUC_WAIT_FOR_VALIDATION`).
 * So B parked on A's INSERT, not on A's row lock. Measured on a scratch database, with `FOR UPDATE`
 * deleted from the lock: B still blocked, `pg_blocking_pids` still named A, and B still read A's
 * committed value — i.e. the test passed IDENTICALLY with the subject removed, and the only thing
 * that detected the deletion was a `/FOR UPDATE/` match against the SQL string, which an inert SQL
 * comment satisfies. The observed serialization was real. The attribution was wrong.
 *
 * THE FIXTURE THAT TESTS THE LOCK IS PRE-EXISTING, COMMITTED CURSOR ROWS — the normal state of any
 * connector that has swept even once, and the only state in which the unique index CANNOT do the
 * serializing: the materialisation is inert (asserted below: the lock reports zero rows written, and
 * a third connection can be shown to have committed the rows before either pass began), so
 * `SELECT ... FOR UPDATE` is the one remaining statement that can make B wait.
 *
 * THE THREE CELLS BELOW ARE ONE HARNESS, `raceTwoCursorPasses`, and each differs from the subject in
 * EXACTLY ONE ARGUMENT:
 *
 *   | cell                 | preExisting | lock                          | B waits?              |
 *   | -------------------- | ----------- | ----------------------------- | --------------------- |
 *   | SUBJECT              | true        | defaultWmsDeltaScopeLock      | yes, on `FOR UPDATE`  |
 *   | NEGATIVE CONTROL     | true        | the same SQL minus FOR UPDATE | no — stale read       |
 *   | COLD START (labelled)| false       | defaultWmsDeltaScopeLock      | yes, on the INSERT    |
 *
 * The detection is the same measurement in all three: the value B's pass read after taking its scope
 * lock, and the watermark B then derived from it. The negative control is not a different scenario
 * written to fail; it is the subject with one argument changed, and it loses A's advance.
 *
 * WHAT IS PROVED, AND WHAT IS NOT.
 *   - PROVED: over PRE-EXISTING cursor rows, the default lock serializes a read-then-write pair
 *     against a concurrent one, and the lock is the only thing that can be doing it: nothing was
 *     inserted, a third connection is refused a `FOR UPDATE NOWAIT` on those rows while A holds them,
 *     and B is parked on a lock held by A's backend and NOT on the materialisation insert.
 *   - PROVED: the same harness with the lock absent and everything else identical loses A's update.
 *   - PROVED: it locks this connector's own rows and not another connector's, measured directly with
 *     `FOR UPDATE NOWAIT` from a third connection rather than inferred from timing.
 *   - NAMED, NOT CLAIMED AS THE LOCK'S DOING: on a cold start the first-ever cursor write is
 *     serialized by the UNIQUE INDEX, lock or no lock. That cell asserts the mechanism it actually
 *     observes, so it stays green when the row lock is deleted — deliberately, because it is not
 *     evidence about the row lock.
 *   - NOT PROVED, and deliberately stated rather than implied: that the generation chain ALONE is a
 *     sufficient fence for a connector with no scope binding (o3d-x343). The default's scope token is
 *     the constant `unbound`, so the save-time compare-and-swap over it is unconditional — asserted
 *     below as the fact it is. Whether the generation chain suffices is a design question about
 *     `saveWmsDeltaCursors`, not something this lock can answer.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

import {
  WMS_DELTA_SCOPE_UNBOUND,
  type WmsDeltaScopeLock,
  type WmsDeltaScopeLockTx,
  defaultWmsDeltaScopeLock,
} from '../../lib/domain/wms/delta-scope-lock.ts'

const SKIP = process.env.RUN_DB_CONCURRENCY_TESTS !== '1'

function databaseUrl(): string {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const url = process.env.DATABASE_URL
  assert.ok(url, 'DATABASE_URL must be set for the concurrency tests')
  return url
}

/**
 * A `WmsDeltaScopeLockTx` backed by ONE raw pg connection.
 *
 * Prisma's tagged-template raw API hands the callee the string parts and the interpolated values
 * separately, which is exactly a parameterized query — so this is a translation, not a
 * reimplementation. The SQL the lock issues is unchanged, and `FOR UPDATE` is enforced by Postgres.
 * `rowsWritten` is the total the lock's own `$executeRaw` calls reported: for the pre-existing
 * fixture it must be ZERO, which is how "no speculative insert exists for B to conflict with" is
 * established as a measurement rather than an argument.
 */
function pgScopeLockTx(client: import('pg').Client): WmsDeltaScopeLockTx & {
  statements: string[]
  rowsWritten: () => number
} {
  const statements: string[] = []
  const written: number[] = []
  const toSql = (parts: TemplateStringsArray, values: unknown[]) =>
    parts.reduce((acc, part, i) => acc + part + (i < values.length ? `$${i + 1}` : ''), '')
  return {
    statements,
    rowsWritten: () => written.reduce((sum, n) => sum + n, 0),
    async $executeRaw(parts: TemplateStringsArray, ...values: unknown[]) {
      const sql = toSql(parts, values)
      statements.push(sql)
      const result = await client.query(sql, values as never[])
      written.push(result.rowCount ?? 0)
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

/**
 * THE NEGATIVE CONTROL'S LOCK: `lockWmsSettingRows` with `FOR UPDATE` deleted and NOTHING else
 * changed — same materialisation, same key sorting, same read, same returned token. It is spelled out
 * here rather than achieved by mocking so that the single difference between the two cells is visible
 * on one line.
 */
function scopeLockWithoutTheRowLock(keys: readonly string[]): WmsDeltaScopeLock {
  return async (tx) => {
    const sorted = [...keys].sort()
    await tx.$executeRaw`
      INSERT INTO settings (key, value, "updatedAt")
      SELECT k, '', now() FROM unnest(${sorted}::text[]) AS k
      ON CONFLICT (key) DO NOTHING`
    await tx.$queryRaw<Array<{ key: string; value: string | null }>>`
      SELECT key, value FROM settings WHERE key = ANY(${sorted}::text[]) ORDER BY key`
    return WMS_DELTA_SCOPE_UNBOUND
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Does SOMEONE ELSE hold a row lock on these rows right now? Positive, direct evidence: a third
 * connection asks for the same rows `FOR UPDATE NOWAIT` and Postgres answers 55P03 (lock_not_available)
 * if they are held. `false` covers both "held by nobody" and "not visible to this connection", which
 * is why the cold-start cell reports false — an uncommitted insert is nothing a third party can lock.
 */
async function rowsAreLockedByAnotherBackend(
  probe: import('pg').Client,
  keys: string[],
): Promise<boolean> {
  try {
    await probe.query('SELECT 1 FROM settings WHERE key = ANY($1::text[]) FOR UPDATE NOWAIT', [keys])
    return false
  } catch (error) {
    if (typeof error === 'object' && error !== null && (error as { code?: string }).code === '55P03') {
      return true
    }
    throw error
  }
}

type CursorRaceOutcome = {
  /** How many of the keys a THIRD connection had already committed before either pass began. */
  rowsCommittedBeforeRace: number
  tokenA: string
  tokenB: string | null
  /** Rows the lock's own INSERT reported writing — 0 means the materialisation was inert. */
  aLockWrote: number
  bLockWrote: number
  readA: string | null
  /** Measured from a third connection while A holds its lock and before A writes. */
  rowsLockedWhileAHoldsThem: boolean
  bBlockedBy: number[]
  bBlockedByA: boolean
  /** The statement B was parked on, whitespace-collapsed; '' if B never parked at all. */
  bParkedOn: string
  /** True if B's whole lock-then-read finished before A wrote — i.e. nothing serialized it. */
  bFinishedBeforeAWrote: boolean
  readB: string | null
  final: string | null
  aStatements: string[]
}

/**
 * ONE read-then-write pass racing another over the same cursor rows, in the shape
 * `readWmsDeltaCursors` uses: take the scope lock, THEN read the cursor rows, then write a watermark
 * derived from what was read (`readWmsDeltaCursors` in lib/domain/wms/dispatch-sweep.ts).
 *
 * The harness never asserts. It runs the interleaving to completion, tidies up, and returns what it
 * observed, so a failing expectation cannot strand an open transaction holding row locks.
 */
async function raceTwoCursorPasses(options: {
  keys: string[]
  watermarkKey: string
  lock: WmsDeltaScopeLock
  preExisting: boolean
}): Promise<CursorRaceOutcome> {
  const { keys, watermarkKey, lock, preExisting } = options
  const url = databaseUrl()
  const { Client } = await import('pg')
  const a = new Client({ connectionString: url })
  const b = new Client({ connectionString: url })
  const probe = new Client({ connectionString: url })
  await Promise.all([a.connect(), b.connect(), probe.connect()])

  const outcome: CursorRaceOutcome = {
    rowsCommittedBeforeRace: -1,
    tokenA: '',
    tokenB: null,
    aLockWrote: -1,
    bLockWrote: -1,
    readA: null,
    rowsLockedWhileAHoldsThem: false,
    bBlockedBy: [],
    bBlockedByA: false,
    bParkedOn: '',
    bFinishedBeforeAWrote: false,
    readB: null,
    final: null,
    aStatements: [],
  }
  let bPid = -1
  try {
    // A backstop so a wedged lock fails the run instead of hanging it.
    await probe.query("SET statement_timeout = '30s'")

    if (preExisting) {
      // THE FIXTURE. A third connection, in autocommit, so these rows are COMMITTED and visible to
      // both passes before either starts. `''` is what the lock's own materialisation would have
      // written, and every reader of a settings key treats it exactly as an absent row.
      await probe.query(
        `INSERT INTO settings (key, value, "updatedAt") SELECT k, '', now() FROM unnest($1::text[]) AS k`,
        [keys],
      )
    }
    outcome.rowsCommittedBeforeRace = Number(
      (await probe.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM settings WHERE key = ANY($1::text[])',
        [keys],
      )).rows[0].n,
    )

    const aPid = (await a.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
    bPid = (await b.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid

    // --- A takes the scope lock and reads its watermark, exactly as readWmsDeltaCursors does ----
    await a.query('BEGIN')
    const txA = pgScopeLockTx(a)
    outcome.tokenA = await lock(txA)
    outcome.aLockWrote = txA.rowsWritten()
    outcome.aStatements = [...txA.statements]
    outcome.readA = (await a.query<{ value: string | null }>(
      'SELECT value FROM settings WHERE key = $1', [watermarkKey],
    )).rows[0]?.value ?? null
    outcome.rowsLockedWhileAHoldsThem = await rowsAreLockedByAnotherBackend(probe, keys)

    // --- B runs the SAME pass concurrently: lock, then read ------------------------------------
    await b.query('BEGIN')
    const txB = pgScopeLockTx(b)
    let bFinished = false
    const bPass = (async () => {
      const token = await lock(txB)
      const value = (await b.query<{ value: string | null }>(
        'SELECT value FROM settings WHERE key = $1', [watermarkKey],
      )).rows[0]?.value ?? null
      return { token, value }
    })()
    const bSettled = bPass.then(
      () => { bFinished = true },
      () => { bFinished = true },
    )

    // Wait until B has got as far as it CAN get: either it finished, or it is parked behind someone.
    // One condition for both cells — the cells differ in which branch it takes, not in the wait.
    for (let attempt = 0; attempt < 200 && !bFinished; attempt += 1) {
      const { rows } = await probe.query<{ pids: number[] | null; query: string | null }>(
        'SELECT pg_blocking_pids(pid) AS pids, query FROM pg_stat_activity WHERE pid = $1',
        [bPid],
      )
      const pids = rows[0]?.pids ?? []
      if (pids.length > 0) {
        outcome.bBlockedBy = pids
        outcome.bBlockedByA = pids.includes(aPid)
        outcome.bParkedOn = (rows[0]?.query ?? '').replace(/\s+/g, ' ').trim()
        break
      }
      await wait(50)
    }
    outcome.bFinishedBeforeAWrote = bFinished

    // --- A writes its advance and commits -----------------------------------------------------
    await a.query(
      `INSERT INTO settings (key, value, "updatedAt") VALUES ($1, 'A', now())
         ON CONFLICT (key) DO UPDATE SET value = 'A', "updatedAt" = now()`,
      [watermarkKey],
    )
    await a.query('COMMIT')

    // --- B's pass completes, and writes a watermark DERIVED from what it read ------------------
    const bResult = await bPass
    await bSettled
    outcome.tokenB = bResult.token
    outcome.readB = bResult.value
    outcome.bLockWrote = txB.rowsWritten()
    const derived = `B-after-${bResult.value === '' || bResult.value === null ? 'NOTHING' : bResult.value}`
    await b.query(`UPDATE settings SET value = $2, "updatedAt" = now() WHERE key = $1`, [watermarkKey, derived])
    await b.query('COMMIT')

    outcome.final = (await probe.query<{ value: string | null }>(
      'SELECT value FROM settings WHERE key = $1', [watermarkKey],
    )).rows[0]?.value ?? null
  } finally {
    // Release in an order that cannot deadlock the cleanup: unpark B, end both transactions, and
    // only then delete the rows (a DELETE would otherwise queue behind A's own row locks).
    if (bPid > 0) await probe.query('SELECT pg_cancel_backend($1)', [bPid]).catch(() => {})
    await a.query('ROLLBACK').catch(() => {})
    await b.query('ROLLBACK').catch(() => {})
    await probe.query('DELETE FROM settings WHERE key = ANY($1::text[])', [keys]).catch(() => {})
    await Promise.allSettled([a.end(), b.end(), probe.end()])
  }
  return outcome
}

function cursorKeys(prefix: string): { keys: string[]; watermarkKey: string } {
  const run = randomUUID()
  // Shaped like a connector's three delta state rows. The default lock takes whatever keys it is
  // given, so the SHAPE is what matters and no production row is involved.
  const keys = [
    `j8yq_${run}_${prefix}_order_delta_since`,
    `j8yq_${run}_${prefix}_order_reconcile_at`,
    `j8yq_${run}_${prefix}_order_delta_generation`,
  ]
  return { keys, watermarkKey: keys[0] }
}

test('default WMS delta scope lock: over PRE-EXISTING cursor rows, the lock is the only thing that can serialize a second pass — and it does', { skip: SKIP }, async () => {
  const { keys, watermarkKey } = cursorKeys('locked')
  const outcome = await raceTwoCursorPasses({
    keys,
    watermarkKey,
    lock: defaultWmsDeltaScopeLock(keys),
    preExisting: true,
  })

  // THE FIXTURE, ASSERTED — this is what rules out the unique index as the cause.
  assert.equal(
    outcome.rowsCommittedBeforeRace, keys.length,
    'fixture: all three cursor rows were committed by a third connection BEFORE either pass began',
  )
  assert.equal(
    outcome.aLockWrote, 0,
    'fixture: the lock wrote NOTHING — its ON CONFLICT DO NOTHING materialisation was inert, so there'
    + ' is no speculative insertion for B to conflict with and a unique-index conflict cannot be what'
    + ' serializes it',
  )
  assert.equal(outcome.bLockWrote, 0, 'and the same is true of B')
  assert.equal(outcome.tokenA, WMS_DELTA_SCOPE_UNBOUND, 'the default reports the unbound scope token')
  assert.equal(outcome.readA, '', 'precondition: A read the pre-image under its own lock')

  // THE MECHANISM, MEASURED — A holds a row lock, and B is parked on it rather than on an INSERT.
  assert.equal(
    outcome.rowsLockedWhileAHoldsThem, true,
    'a third connection must be refused FOR UPDATE NOWAIT on these rows while A holds its scope lock',
  )
  assert.equal(
    outcome.bBlockedByA, true,
    `B must be parked on a lock held by A's backend (blocked by ${JSON.stringify(outcome.bBlockedBy)},`
    + ` parked on: ${outcome.bParkedOn || 'nothing — it never waited'})`,
  )
  assert.ok(
    !/INSERT INTO settings/i.test(outcome.bParkedOn),
    'and NOT on the materialisation insert: an ON CONFLICT insert waits for a conflicting speculative'
    + ' insertion, which would serialize B with or without the lock. That is what the pre-existing'
    + ` fixture removes (parked on: ${outcome.bParkedOn})`,
  )
  assert.equal(outcome.bFinishedBeforeAWrote, false, 'so B had not finished its read when A wrote')

  // THE DETECTION — the same measurement the negative control makes.
  assert.equal(
    outcome.readB, 'A',
    'B read AFTER A committed, which is the whole of the happens-before: a B that saw the pre-image'
    + ' here would go on to write a watermark computed from a state that no longer exists',
  )
  assert.equal(outcome.tokenB, WMS_DELTA_SCOPE_UNBOUND)
  assert.equal(
    outcome.final, 'B-after-A',
    'and the watermark B derived is derived from A\'s value: the two passes applied in order, neither lost',
  )

  // BELT, AND IT DOES NOT CARRY THE PROOF. Everything above is behaviour; this only records that the
  // lock takes exactly ONE row lock, in one canonical pass. An inert SQL comment containing the
  // phrase would satisfy this line and still fail every assertion above it.
  const forUpdate = outcome.aStatements.filter((s) => /FOR UPDATE/.test(s))
  assert.equal(forUpdate.length, 1, `the lock issued exactly one FOR UPDATE (got ${forUpdate.length})`)
})

test('default WMS delta scope lock: the SAME fixture and interleaving with ONLY the row lock removed loses A\'s advance', { skip: SKIP }, async () => {
  // THE NEGATIVE CONTROL. It differs from the test above in exactly one argument: `lock`. Same keys,
  // same pre-existing committed rows, same wait condition, same measurement. If this cell did not
  // lose the update, the cell above would prove nothing, because the interleaving it claims to
  // prevent would not be possible here either.
  const { keys, watermarkKey } = cursorKeys('unlocked')
  const outcome = await raceTwoCursorPasses({
    keys,
    watermarkKey,
    lock: scopeLockWithoutTheRowLock(keys),
    preExisting: true,
  })

  // IDENTICAL FIXTURE, asserted again so a drift between the two cells cannot hide here.
  assert.equal(outcome.rowsCommittedBeforeRace, keys.length, 'fixture: the same three committed rows')
  assert.equal(outcome.aLockWrote, 0, 'fixture: the same inert materialisation')
  assert.equal(outcome.bLockWrote, 0, 'fixture: and for B')
  assert.equal(outcome.tokenA, WMS_DELTA_SCOPE_UNBOUND, 'the same token, so nothing else changed')
  assert.equal(outcome.readA, '', 'precondition: A read the pre-image')

  // THE ONE DIFFERENCE, MEASURED FROM OUTSIDE: no row lock is held, so nothing makes B wait.
  assert.equal(
    outcome.rowsLockedWhileAHoldsThem, false,
    'with FOR UPDATE gone a third connection takes these rows NOWAIT — there is no row lock at all',
  )
  assert.equal(outcome.bBlockedByA, false, `and B parked on nobody (blocked by ${JSON.stringify(outcome.bBlockedBy)})`)
  assert.equal(
    outcome.bFinishedBeforeAWrote, true,
    'B completed its whole lock-then-read before A wrote, which is the race',
  )

  // THE DETECTION, the negation of the guarantee the locked cell asserts.
  assert.notEqual(
    outcome.readB, 'A',
    'the unlocked cell must observe the STALE read — if it cannot, the locked cell proves nothing',
  )
  assert.equal(outcome.readB, '', 'B is holding a watermark A has already superseded')
  assert.equal(
    outcome.final, 'B-after-NOTHING',
    'and the consequence: B wrote a watermark derived from a pre-image, so A\'s advance was lost —'
    + ' exactly what the row lock exists to stop, under READ COMMITTED, with both commits succeeding',
  )
})

test('default WMS delta scope lock: on a COLD START it is the UNIQUE INDEX, not the lock, that serializes the second pass', { skip: SKIP }, async () => {
  // NOT EVIDENCE ABOUT THE ROW LOCK, and here to say so in executable form. This cell differs from
  // the subject in exactly one argument — `preExisting: false` — and it is the fixture the first
  // version of this file used. B does block and does read A's value, but it is parked on the
  // materialisation INSERT: Postgres makes an ON CONFLICT insert wait for a conflicting speculative
  // insertion. Deleting FOR UPDATE leaves this cell green, which is correct and is the point.
  const { keys, watermarkKey } = cursorKeys('coldstart')
  const outcome = await raceTwoCursorPasses({
    keys,
    watermarkKey,
    lock: defaultWmsDeltaScopeLock(keys),
    preExisting: false,
  })

  assert.equal(outcome.rowsCommittedBeforeRace, 0, 'fixture: a cold start — no cursor row exists yet')
  assert.equal(
    outcome.aLockWrote, keys.length,
    'so the lock materialised the rows itself, and A\'s inserts are uncommitted while B runs',
  )
  assert.equal(
    outcome.rowsLockedWhileAHoldsThem, false,
    'and a third connection sees nothing to lock: the rows are not committed, so no row lock is even'
    + ' observable from outside — a cold start cannot demonstrate one',
  )
  assert.equal(outcome.bBlockedByA, true, 'B does block...')
  assert.match(
    outcome.bParkedOn, /INSERT INTO settings/i,
    '...but on the MATERIALISATION INSERT, not on a row lock — which is why a fixture with absent keys'
    + ' passes identically when FOR UPDATE is deleted, and why the serializing cell above pre-commits'
    + ' its rows',
  )
  assert.equal(outcome.readB, 'A', 'the serialization is genuine; only its cause is not the lock')
  assert.equal(outcome.final, 'B-after-A')
})

test('default WMS delta scope lock: it locks THIS connector\'s rows and NOT another connector\'s', { skip: SKIP }, async () => {
  // The other half of the docstring's claim — "lock the connector's OWN cursor rows, never another
  // connector's". Without it, a default lock that widened its key set would serialize every
  // connector's sweep against every other one, which is a liveness bug nothing else here would see.
  // Both key sets pre-exist and are committed, so what is measured is a ROW LOCK's extent and not a
  // materialisation conflict, and the extent is read directly with FOR UPDATE NOWAIT from a third
  // connection rather than inferred from how long something took.
  const url = databaseUrl()
  const { Client } = await import('pg')
  const run = randomUUID()
  const mine = [`j8yq_${run}_alpha_order_delta_since`, `j8yq_${run}_alpha_order_delta_generation`]
  const theirs = [`j8yq_${run}_beta_order_delta_since`, `j8yq_${run}_beta_order_delta_generation`]

  const a = new Client({ connectionString: url })
  const b = new Client({ connectionString: url })
  const probe = new Client({ connectionString: url })
  await Promise.all([a.connect(), b.connect(), probe.connect()])
  let bPid = -1

  try {
    await probe.query("SET statement_timeout = '30s'")
    await probe.query(
      `INSERT INTO settings (key, value, "updatedAt") SELECT k, '', now() FROM unnest($1::text[]) AS k`,
      [[...mine, ...theirs]],
    )
    bPid = (await b.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid

    await a.query('BEGIN')
    await defaultWmsDeltaScopeLock(mine)(pgScopeLockTx(a))

    // THE EXTENT OF THE LOCK, MEASURED. Both halves matter: the first makes the test non-vacuous (a
    // lock that did nothing would pass the second half trivially), the second is the claim.
    assert.equal(
      await rowsAreLockedByAnotherBackend(probe, mine), true,
      'precondition: A really holds ITS OWN cursor rows — otherwise "it did not lock theirs" is vacuous',
    )
    assert.equal(
      await rowsAreLockedByAnotherBackend(probe, theirs), false,
      'and it holds NO row of the other connector\'s delta state',
    )

    // The liveness consequence: a second connector's sweep runs straight through.
    await b.query('BEGIN')
    const bLock = defaultWmsDeltaScopeLock(theirs)(pgScopeLockTx(b))
    bLock.catch(() => {})
    const token = await Promise.race([bLock, wait(4000).then(() => 'TIMED-OUT' as const)])
    assert.equal(
      token, WMS_DELTA_SCOPE_UNBOUND,
      'a second connector\'s sweep must not be serialized behind the first one\'s scope lock',
    )
    await b.query('COMMIT')
    await a.query('COMMIT')
  } finally {
    if (bPid > 0) await probe.query('SELECT pg_cancel_backend($1)', [bPid]).catch(() => {})
    await a.query('ROLLBACK').catch(() => {})
    await b.query('ROLLBACK').catch(() => {})
    await probe.query('DELETE FROM settings WHERE key = ANY($1::text[])', [[...mine, ...theirs]]).catch(() => {})
    await Promise.allSettled([a.end(), b.end(), probe.end()])
  }
})

test('default WMS delta scope lock: its token is a CONSTANT, so a save-time scope comparison is unconditional', { skip: SKIP }, async () => {
  // Documented and deliberate (lib/domain/wms/delta-scope-lock.ts), and written down as an
  // executable fact because it is the load-bearing consequence: for a connector with no scope
  // binding, `scope` cannot carry information, so the generation chain is the ONLY fence on the
  // cursor write. This test asserts the premise; it does not assert that the fence suffices (o3d-x343).
  const url = databaseUrl()
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
    await client.query('ROLLBACK').catch(() => {})
    await client.query('DELETE FROM settings WHERE key = ANY($1::text[])', [keys]).catch(() => {})
    await client.end()
  }
})
