/**
 * o3d-alnk r4 — THE LANE REFUSES A DATABASE IT DID NOT CREATE, AND SAYS WHICH RULE FIRED.
 *
 * NOT SKIPPED, AND TOUCHES NO DATABASE. This is the property that replaces three rounds of
 * client-scoping on the email-outbox concurrency lane, so it has to hold on every
 * `npm run test:unit`, not only on the runs that have a Postgres to talk to.
 *
 * WHY A NAME AND NOT A PREDICATE. Rounds 2 and 3 asserted "which ROWS may this sweep touch",
 * which is a claim over an open space: `now`, `prepareQueuedEmail`, a one-character prefix and a
 * cast past the option union were four different ways to widen it and there was no reason to
 * think they were the last four. A database NAME is a closed space. There is exactly one string
 * to check, it is checked before any statement is issued, and every way of getting it wrong is
 * enumerated below.
 *
 * The fourth refusal — a name that already exists on the server — needs a server and is proved by
 * the concurrency lane itself (tests/concurrency/email-outbox-claim-fence.concurrent.test.ts).
 *
 * r10 ADDED THE OTHER HALF: not only which databases this module refuses to CREATE, but the one
 * circumstance in which it will DROP one. See the block above the fake server below.
 */

import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import {
  PROTECTED_DATABASE_NAMES,
  THROWAWAY_DATABASE_NAME_RE,
  type ThrowawayDatabase,
  ThrowawayDatabaseError,
  assertThrowawayDatabaseName,
  provisionThrowawayDatabase,
} from '@/tests/helpers/throwaway-database'

/** A name of the exact shape the module mints, used as the accepted control throughout. */
const MINTED = 'ims_throwaway_alnkfence_0123456789abcdef'
const CONFIGURED = 'onetwo3d_ims_dev'

function refusal(pattern: RegExp) {
  return (error: unknown): boolean =>
    error instanceof ThrowawayDatabaseError && pattern.test((error as Error).message)
}

test('the minted control is ACCEPTED, so the refusals below are not refusing everything', () => {
  assert.match(MINTED, THROWAWAY_DATABASE_NAME_RE)
  assert.doesNotThrow(() => assertThrowawayDatabaseName(MINTED, 'some_other_database'))
})

test('the LIVE-SERVED dev database is refused BY NAME (o3d-alnk r4)', () => {
  // `onetwo3d_ims_dev` is what ims-stage-dev.service serves on :3000 out of the main working
  // tree. It is the database three rounds of scoping were trying to make safe to sweep.
  assert.ok(PROTECTED_DATABASE_NAMES.includes('onetwo3d_ims_dev'))
  assert.throws(
    () => assertThrowawayDatabaseName('onetwo3d_ims_dev', 'something_else'),
    refusal(/refused onetwo3d_ims_dev: it is a PROTECTED database/),
  )
})

test('every protected name is refused as protected, not merely as unminted', () => {
  for (const name of PROTECTED_DATABASE_NAMES) {
    assert.throws(
      () => assertThrowawayDatabaseName(name, 'something_else'),
      refusal(new RegExp(`refused ${name}: it is a PROTECTED database`)),
      `${name} is on the protected list but is not refused as protected`,
    )
  }
})

test('the database the configured DATABASE_URL names is refused, whatever it is called', () => {
  // Separate from the protected list on purpose: a developer whose own database is called
  // something this file has never heard of is protected by this rule and by nothing else.
  assert.throws(
    () => assertThrowawayDatabaseName('someones_own_database', 'someones_own_database'),
    refusal(/refused someones_own_database: it is the database named by the configured DATABASE_URL/),
  )
  // And it bites even when the name would otherwise be a legal minted one.
  assert.throws(
    () => assertThrowawayDatabaseName(MINTED, MINTED),
    refusal(/it is the database named by the configured DATABASE_URL/),
  )
})

test('a name this module did not mint is refused as one the lane did not create', () => {
  for (const name of [
    'ims_ci_repro',                                  // a real leftover on this host
    'ims_throwaway_alnkfence',                       // no random suffix
    'ims_throwaway_alnkfence_0123456789abcde',       // fifteen hex digits
    'ims_throwaway_alnkfence_0123456789abcdefa',     // seventeen
    'IMS_THROWAWAY_ALNKFENCE_0123456789ABCDEF',      // wrong case
    'ims_throwaway__0123456789abcdef',               // empty label
    'x' + MINTED,                                    // prefixed
    MINTED + '_extra',                               // suffixed
  ]) {
    assert.throws(
      () => assertThrowawayDatabaseName(name, CONFIGURED),
      refusal(/it is not a name this module minted/),
      `${name} was accepted as a minted throwaway database name`,
    )
  }
})

test('a blank name is refused before anything else looks at it', () => {
  assert.throws(() => assertThrowawayDatabaseName('', CONFIGURED), refusal(/refused a blank database name/))
  assert.throws(() => assertThrowawayDatabaseName('   ', CONFIGURED), refusal(/refused a blank database name/))
})

test('provisioning refuses LOUDLY rather than falling back when there is no DATABASE_URL', async () => {
  // THE FAILURE MODE THAT WOULD UNDO ALL OF THE ABOVE is a lane that cannot provision and quietly
  // carries on against whatever it can reach. There is no degraded mode: it throws by name.
  const previous = process.env.DATABASE_URL
  delete process.env.DATABASE_URL
  try {
    await assert.rejects(
      () => provisionThrowawayDatabase({ label: 'alnkfence' }),
      refusal(/DATABASE_URL is not set/),
    )
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous
  }
})

test('provisioning refuses a DATABASE_URL it cannot parse, and one that is not Postgres', async () => {
  const previous = process.env.DATABASE_URL
  try {
    process.env.DATABASE_URL = 'not a url'
    await assert.rejects(
      () => provisionThrowawayDatabase({ label: 'alnkfence' }),
      refusal(/could not be parsed as a URL/),
    )
    process.env.DATABASE_URL = 'mysql://user:pw@127.0.0.1:3306/whatever'
    await assert.rejects(
      () => provisionThrowawayDatabase({ label: 'alnkfence' }),
      refusal(/is not a Postgres URL/),
    )
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous
  }
})

test('a lane label that could smuggle a name past the pattern is refused', async () => {
  // The label is interpolated into the database name, so it is the one caller-supplied part of
  // it. Anything but lowercase alphanumerics is refused before a name is built at all — and
  // therefore before a maintenance connection is opened, which is why this needs no server.
  const previous = process.env.DATABASE_URL
  process.env.DATABASE_URL = `postgresql://u:p@127.0.0.1:5432/${CONFIGURED}`
  try {
    for (const label of ['', 'has_underscore', 'UPPER', 'with-dash', 'x'.repeat(33), 'quote"name']) {
      await assert.rejects(
        () => provisionThrowawayDatabase({ label }),
        refusal(/refused the lane label/),
        `label ${JSON.stringify(label)} was accepted`,
      )
    }
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous
  }
})

// ===========================================================================================
// ROUND 10 — THE CLEANUP RULE, AND WHY THERE IS ONLY ONE.
//
// `CREATE DATABASE` is issued over a socket. If PostgreSQL EXECUTES it and the connection then
// fails before the completion response arrives, `client.query` REJECTS: the database exists and
// this process never learned so.
//
// FOUR ROUNDS TRIED TO CLEAN THAT UP AND EACH ONE WAS UNSOUND IN A NEW WAY. r7 reclaimed it with
// `DROP DATABASE IF EXISTS`. r8 found the missed answer might have been a `42P04`, so the reclaim
// could drop the WINNER's database. r9 closed that with a session advisory lock plus a
// `CONNECTION LIMIT 4242` ownership stamp. r10 found the stamp is a CONVENTION any caller may set
// — not provenance — and that reading it and dropping it are two statements with a window in
// between that a COOPERATIVE lock does not close against a non-participant.
//
// SO r10 DELETED THE RECLAIM. The rule is now: DROP only a name this process minted and whose own
// `CREATE DATABASE` it saw COMPLETE. Everything else is LEFT and NAMED. The lock, the stamp and
// the re-probe went with it, and so did the entire class of finding they attracted — nothing here
// infers ownership from anything a third party can also produce.
//
// WHAT THESE TESTS THEREFORE PROVE, in the order the finding demands:
//   1. a lost CREATE response LEAVES the database, issues NO DROP, and says so by name;
//   2. a database this process did not create is never dropped by ANY path;
//   3. the `created` path still drops, and leaves nothing behind;
//   4. no lock, no stamp and no ownership probe survive — asserted on the wire, not by reading
//      the source.
//
// NO REAL SERVER, ON PURPOSE. `npm run test:unit` has no database, and a proof that only runs in
// the concurrency lane is a proof that mostly does not run. `pg` is module-mocked to a fake that
// models the ONE thing that matters here: a server on which databases exist or do not.
// ===========================================================================================


/**
 * THE FAKE SERVER — a set of database NAMES, and nothing else about them.
 *
 * IT MODELS NO DATABASE ATTRIBUTES, AND THAT IS THE r10 FIX EXPRESSED IN THE FIXTURE. r9's wire
 * carried a `datconnlimit` per database because the module read one back to decide ownership.
 * Nothing reads one now, so a fake that still served them would be modelling withdrawn behaviour
 * — and a reader would reasonably conclude the stamp still meant something.
 *
 * IT ALSO HAS NO ADVISORY LOCKS, and their absence is load-bearing rather than tidiness: the
 * `query` method THROWS on any statement it does not model, so a future round that reintroduces a
 * lock, a `set_config` or a `SELECT datconnlimit` makes every test in this file fail loudly
 * instead of quietly passing. That is the regression guard for "the machinery stayed deleted".
 */
const wire = {
  /** The names the server holds. A Set, because a name is all this module can ask about. */
  databases: new Set<string>(),
  connections: 0,
  statements: [] as string[],
  /** Backends the server still has. A killed one answers nothing. */
  liveSessions: new Set<number>(),
  /**
   * THE DEFECT: the server executes the CREATE and the client never hears the answer.
   *
   * Applies to WHICHEVER answer it was — the completion OR the `42P04` — so the combined race
   * below (somebody else won AND we never heard) is expressible.
   */
  loseCreateResponse: false,
  /** The variant where the statement never reached the server at all. */
  loseCreateBeforeExecuting: false,
  /**
   * A `DROP DATABASE` NEVER REACHES THE SERVER. Nothing is deleted and the client is told. This is
   * the DROP-side twin of `loseCreateBeforeExecuting`, and until r11 it was the ONLY drop failure
   * the wire could express — which is why the r11 finding could not be written down here: the fake
   * threw BEFORE deleting the name, so "the server did the work and the answer was lost" was not
   * a state this server had.
   */
  failDrop: false,
  /**
   * THE r11 DEFECT: the server EXECUTES the `DROP DATABASE` and the client never hears the answer.
   *
   * The same generalisation `loseCreateResponse` got in r9 — the work happens either way, and the
   * only thing that varies is whether the client survives long enough to be told. It is the case
   * the finding is about, so the wire has to be able to say it.
   */
  loseDropResponse: false,
  /** `client.end()` fails on the session that issued the CREATE, AFTER the CREATE succeeded. */
  failEndAfterCreate: false,
  /**
   * `client.end()` fails on the session that issued the DROP, AFTER the server ANSWERED it. The
   * DROP is DONE; the teardown is what failed. A handle must stay `dropped` through this, or a
   * failing socket close would silently turn a completed DROP back into an unanswered one.
   */
  failEndAfterDrop: false,
  /**
   * ANOTHER PROVISIONER, ARRIVING BETWEEN THE PROBE AND THE CREATE.
   *
   * When set to a name, the fake server answers the existence probe TRUTHFULLY — absent, because
   * at that instant it is — and then records that name as created by somebody else before the
   * CREATE arrives. It is a NON-PARTICIPANT: it takes no lock and carries no marker, because
   * after r10 there is no lock to take and no marker to carry, and it must be droppable by
   * nothing this module does.
   */
  createdByAnotherProvisionerAfterProbe: null as string | null,
}

function resetWire(): void {
  wire.databases.clear()
  wire.connections = 0
  wire.statements = []
  wire.liveSessions.clear()
  wire.loseCreateResponse = false
  wire.loseCreateBeforeExecuting = false
  wire.failDrop = false
  wire.loseDropResponse = false
  wire.failEndAfterCreate = false
  wire.failEndAfterDrop = false
  wire.createdByAnotherProvisionerAfterProbe = null
}

/** `CREATE DATABASE "x"` / `DROP DATABASE IF EXISTS "x" ...` -> `x`. */
function quotedName(statement: string): string {
  const match = /"((?:[^"]|"")*)"/.exec(statement)
  if (!match) throw new Error(`the fake server could not find a quoted name in: ${statement}`)
  return match[1].replace(/""/g, '"')
}

let nextBackendPid = 1000

class FakeMaintenanceClient {
  readonly backendPid = (nextBackendPid += 1)
  private issuedCreate = false
  private issuedDrop = false
  private readonly errorListeners: ((error: Error) => void)[] = []

  constructor(_config: { connectionString: string }) { void _config }

  /** `pg` emits `error` on an idle client whose socket fails. Kept so a listener cannot crash it. */
  on(event: string, listener: (error: Error) => void): this {
    if (event === 'error') this.errorListeners.push(listener)
    return this
  }

  async connect(): Promise<void> {
    wire.connections += 1
    wire.liveSessions.add(this.backendPid)
  }

  /** The server terminating this backend, and telling the client the only way it can. */
  kill(): void {
    wire.liveSessions.delete(this.backendPid)
    for (const listener of this.errorListeners) listener(new Error('Connection terminated unexpectedly'))
  }

  async query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    wire.statements.push(text)
    if (!wire.liveSessions.has(this.backendPid)) {
      throw new Error('Client has encountered a connection error and is not queryable')
    }

    if (text.startsWith('SELECT 1 FROM pg_database')) {
      const name = String((values ?? [])[0])
      const answer = { rows: wire.databases.has(name) ? [{ exists: 1 }] : [] }
      // AFTER the answer is computed, so the probe reports what was true when it ran and the race
      // lands in the gap that the finding is about.
      if (wire.createdByAnotherProvisionerAfterProbe !== null) {
        wire.databases.add(wire.createdByAnotherProvisionerAfterProbe)
      }
      return answer
    }

    if (text.startsWith('CREATE DATABASE')) {
      this.issuedCreate = true
      const name = quotedName(text)
      const dying = wire.loseCreateResponse || wire.loseCreateBeforeExecuting
      const die = () => {
        this.kill()
        throw new Error('Connection terminated unexpectedly')
      }
      // The statement never reached the server: nothing happens on it, and the client still dies.
      if (wire.loseCreateBeforeExecuting) die()
      if (wire.databases.has(name)) {
        // WHAT POSTGRESQL ACTUALLY DOES, with the SQLSTATE it actually sets. The existing database
        // is left ALONE — this branch must not touch `wire.databases`, or the assertion that the
        // winner's database survived would be measuring the fake instead of the fix.
        //
        // The response can be LOST HERE TOO, and that is the combined race. The server has still
        // refused; the client simply never finds out which answer it was owed.
        if (dying) die()
        throw Object.assign(new Error(`database "${name}" already exists`), {
          code: '42P04',
          severity: 'ERROR',
          routine: 'createdb',
        })
      }
      // THE SERVER DOES THE WORK EITHER WAY. That is the r7 finding, and it is still true: the
      // database exists whether or not the client survives long enough to be told. What changed in
      // r10 is what this module does about it — nothing, on purpose.
      wire.databases.add(name)
      if (dying) die()
      return { rows: [] }
    }

    if (text.startsWith('DROP DATABASE')) {
      this.issuedDrop = true
      // THE STATEMENT NEVER ARRIVED. Nothing is deleted — the database is still there.
      if (wire.failDrop) throw new Error('Connection terminated unexpectedly')
      // THE SERVER DOES THE WORK EITHER WAY (r11). Exactly as with the CREATE: the deletion happens
      // whether or not the client lives long enough to be told, so the deletion comes FIRST and the
      // dying comes after it. A fake that died first could not express the case the finding is
      // about — "the DROP ran and the answer was lost" — and a proof that cannot express its own
      // failure mode is not a proof of anything.
      wire.databases.delete(quotedName(text))
      if (wire.loseDropResponse) {
        this.kill()
        throw new Error('Connection terminated unexpectedly')
      }
      return { rows: [] }
    }

    // THE STRUCTURAL GUARD. Every withdrawn mechanism — `SELECT pg_advisory_lock`, `SELECT
    // set_config`, `SELECT datconnlimit FROM pg_database` — lands here and fails the test that
    // reached it, so the r10 removal cannot be quietly undone.
    throw new Error(`the fake server was asked for an unmodelled statement: ${text}`)
  }

  async end(): Promise<void> {
    if (this.issuedDrop && wire.failEndAfterDrop) {
      // The DROP was ANSWERED; only the socket close failed. A completed DROP must survive this.
      wire.liveSessions.delete(this.backendPid)
      throw new Error('Connection terminated unexpectedly')
    }
    if (this.issuedCreate && wire.failEndAfterCreate) {
      // The session is gone as far as the server is concerned; the CLIENT is what failed to be
      // told cleanly. A CREATE that SUCCEEDED and a teardown that did not.
      wire.liveSessions.delete(this.backendPid)
      throw new Error('Connection terminated unexpectedly')
    }
    wire.liveSessions.delete(this.backendPid)
  }
}

mock.module('pg', { defaultExport: { Client: FakeMaintenanceClient } })

/** A DATABASE_URL the fake wire answers for. Nothing ever opens a real socket to it. */
const WIRED_URL = `postgresql://u:p@127.0.0.1:5432/${CONFIGURED}`

async function withWiredUrl<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.DATABASE_URL
  process.env.DATABASE_URL = WIRED_URL
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous
  }
}

/** Run a provision and hand back whatever came out, refusal included. Never short-circuits. */
async function capture(options: Parameters<typeof provisionThrowawayDatabase>[0]): Promise<unknown> {
  return withWiredUrl(async () =>
    provisionThrowawayDatabase(options).then(() => null, (reason: unknown) => reason),
  )
}

const drops = () => wire.statements.filter((statement) => statement.startsWith('DROP DATABASE'))
const creates = () => wire.statements.filter((statement) => statement.startsWith('CREATE DATABASE'))

/**
 * Anything that would let this module DECIDE ownership from what is on the server rather than
 * from what the server answered its own CREATE.
 *
 * `datconnlimit` was r9's ownership stamp; `pg_advisory_lock`/`pg_locks`/`set_config` were r9's
 * exclusion window and its `lock_timeout`. `datdba`, `datacl` and `pg_shdescription` are the
 * neighbouring attributes a fifth round would reach for next. None of them is provenance — every
 * one is a value some other caller can also produce — which is why the rule is now "the server
 * told me my own CREATE completed" and nothing else.
 */
const OWNERSHIP_INFERENCE = /datconnlimit|pg_advisory|pg_locks|set_config|datdba|datacl|pg_shdescription/i
const inferenceStatements = () => wire.statements.filter((statement) => OWNERSHIP_INFERENCE.test(statement))

test('CONTROL: the fake wire really provisions, so the refusals below are not refusing everything', async () => {
  resetWire()
  await withWiredUrl(async () => {
    // `migrateTimeoutMs: 1` makes `prisma migrate deploy` fail immediately — which is the r6
    // cleanup path, and it proves the fake server records a DROP when one is issued. Without this
    // arm, a missing DROP in the tests below could mean the wire never worked at all.
    await assert.rejects(
      () => provisionThrowawayDatabase({ label: 'alnkfence', mintName: () => MINTED, migrateTimeoutMs: 1 }),
      refusal(/could not migrate ims_throwaway_alnkfence_0123456789abcdef/),
    )
  })
  assert.deepEqual(creates(), [`CREATE DATABASE "${MINTED}"`])
  assert.ok(drops().length > 0, 'the migration-failure cleanup issued no DROP')
  assert.equal(wire.databases.size, 0, `the migration-failure cleanup left ${[...wire.databases].join(', ')} behind`)
})

// -------------------------------------------------------------------------------------------
// PROOF 4 — WHAT NO LONGER EXISTS. Asserted on the wire so it cannot be undone by a source edit.
// -------------------------------------------------------------------------------------------

test('r10: a provision issues NO lock, NO stamp and NO ownership probe — the whole statement list', async () => {
  resetWire()
  await capture({ label: 'alnkfence', mintName: () => MINTED, migrateTimeoutMs: 1 })

  // THE EXACT WIRE, in order. A stronger assertion than "does not contain X": anything ADDED here
  // has to be argued for, which is the property four rounds of added machinery needed and lacked.
  assert.deepEqual(wire.statements, [
    'SELECT 1 FROM pg_database WHERE datname = $1',
    `CREATE DATABASE "${MINTED}"`,
    `DROP DATABASE IF EXISTS "${MINTED}" WITH (FORCE)`,
  ])

  // Named individually so a failure says WHICH mechanism came back.
  assert.deepEqual(inferenceStatements(), [], 'an ownership-inference statement was issued')
  assert.ok(
    creates().every((statement) => !/CONNECTION LIMIT/i.test(statement)),
    'the CREATE carries a CONNECTION LIMIT again — r9 stamped 4242 there and r10 removed it, '
    + 'because an ordinary caller-settable attribute is not provenance',
  )

  // AND THE CONNECTION BUDGET, which is the same fact counted a different way. r9 opened four on
  // the lost-response path (lock session, create session, re-probe, drop); a provision that
  // creates and drops now opens two, and the failing paths below open ONE.
  assert.equal(wire.connections, 2, `a provision opened ${wire.connections} connections`)
})

test('r10: the module exports no lock id and no ownership stamp', async () => {
  // The r9 API surface, gone. `provisionLockId` mapped an unbounded name space into 31 bits and
  // claimed on its way past that "two lanes with different names never contend" — which was FALSE
  // (`..._0000000000004f42` and `..._00000000000091c8` both hash to 75924636, so two unrelated
  // lanes could block or time each other out). The false claim is fixed by there being no lock:
  // nothing hashes a name, so nothing can collide on one.
  const helper = await import('@/tests/helpers/throwaway-database') as unknown as Record<string, unknown>
  for (const removed of ['provisionLockId', 'THROWAWAY_DATABASE_CONNECTION_LIMIT']) {
    assert.equal(helper[removed], undefined, `${removed} is back; the r10 removal was undone`)
  }
  const registry = await import('@/lib/db/advisory-locks') as unknown as Record<string, unknown>
  assert.equal(
    registry['THROWAWAY_DATABASE_PROVISION_LOCK_NAMESPACE'],
    undefined,
    'the provisioning lock namespace is back in the registry',
  )
})

// -------------------------------------------------------------------------------------------
// PROOF 1 — A LOST CREATE RESPONSE LEAVES THE DATABASE AND NAMES IT.
//
// This is the r7 test INVERTED, deliberately and with the reason recorded. r7 asserted the
// database was GONE afterwards; r10 asserts it is STILL THERE and that no DROP was issued, on the
// grounds that "it might be mine" is not a licence to destroy it. The leak is the accepted cost.
// -------------------------------------------------------------------------------------------

test('r10 HIGH: a CREATE whose response is LOST is LEFT ON THE SERVER, and no DROP is issued', async () => {
  resetWire()
  wire.loseCreateResponse = true

  const outcome = await capture({ label: 'alnkfence', mintName: () => MINTED })

  // PRECONDITION: the server really did execute the CREATE, so there IS something to leak.
  assert.deepEqual(creates(), [`CREATE DATABASE "${MINTED}"`], 'the CREATE never ran, so this proves nothing')
  assert.deepEqual([...wire.databases], [MINTED], 'the fake did not create the database this test is about')

  // THE FINDING, ON THE WIRE. `DROP DATABASE IF EXISTS` against a database that is there SUCCEEDS
  // and destroys it silently, so "it did not throw" measures nothing — the assertion is that no
  // DROP went down the wire at all.
  assert.deepEqual(drops(), [], 'the lost-response path issued a DROP for a CREATE it never saw complete')
  assert.deepEqual(inferenceStatements(), [], 'the cleanup went looking for evidence of ownership again')

  // ONE connection: the probe-and-create session. r9 opened four here. Nothing re-probes and
  // nothing drops, so nothing else is opened.
  assert.equal(wire.connections, 1, `the lost-response path opened ${wire.connections} connections`)

  // AND THE LEAK IS SURFACED. An operator has to be able to find it, so the refusal names it.
  assert.ok(outcome instanceof ThrowawayDatabaseError, `expected a named refusal, got ${String(outcome)}`)
  assert.match(outcome.message, /NO ANSWER CAME BACK/)
  assert.match(outcome.message, new RegExp(`${MINTED} MAY BE LEFT ON THE SERVER`))
  assert.match(outcome.message, /dropped by hand/)
  assert.match(outcome.message, /NOTHING WAS DROPPED/)
  assert.doesNotMatch(outcome.message, /nothing was left behind/)
})

test('r10: a CREATE that never reached the server is reported the SAME way — nothing is claimed', async () => {
  resetWire()
  wire.loseCreateBeforeExecuting = true

  const outcome = await capture({ label: 'alnkfence', mintName: () => MINTED })

  assert.deepEqual(creates(), [`CREATE DATABASE "${MINTED}"`])
  assert.equal(wire.databases.size, 0, 'the fake executed a statement it was told never arrived')
  assert.deepEqual(drops(), [], 'a name that was never created was still dropped')

  // r9 DISTINGUISHED this from the case above by re-probing under its lock, and said so in the
  // message. r10 does not: telling them apart requires exactly the ownership inference that was
  // removed, and the honest report is that this process does not know. The two messages are
  // identical BY DESIGN, and this assertion is what says that is deliberate rather than a bug.
  assert.ok(outcome instanceof ThrowawayDatabaseError, `expected a named refusal, got ${String(outcome)}`)
  assert.match(outcome.message, /NO ANSWER CAME BACK/)
  assert.match(outcome.message, new RegExp(`${MINTED} MAY BE LEFT ON THE SERVER`))
  assert.deepEqual(inferenceStatements(), [], 'the cleanup re-probed to tell the two cases apart')
})

// -------------------------------------------------------------------------------------------
// PROOF 2 — A DATABASE THIS PROCESS DID NOT CREATE IS NEVER DROPPED, BY ANY PATH.
// -------------------------------------------------------------------------------------------

test('r7 LOW: the ALREADY EXISTS refusal must NOT drop — it protects a database this lane did not create', async () => {
  resetWire()
  // Somebody else's database, sitting under a name this lane happened to mint.
  wire.databases.add(MINTED)

  await withWiredUrl(async () => {
    await assert.rejects(
      () => provisionThrowawayDatabase({ label: 'alnkfence', mintName: () => MINTED }),
      refusal(/ALREADY EXISTS, so this lane did not create it/),
    )
  })

  assert.deepEqual([...wire.databases], [MINTED], "the already-exists refusal dropped somebody else's database")
  assert.deepEqual(drops(), [])
  assert.deepEqual(creates(), [])
})

test('r8 HIGH: a CREATE rejected with 42P04 must issue NO DROP — the winner keeps its database', async () => {
  resetWire()
  // A non-participant takes the name in the gap between our probe and our CREATE.
  wire.createdByAnotherProvisionerAfterProbe = MINTED

  // CAPTURED, NOT `assert.rejects`. Both the fix and the defect reject; what separates them is
  // what went down the wire on the way out, so the rejection must not be allowed to short-circuit
  // the assertions that are actually the finding.
  const outcome = await capture({ label: 'alnkfence', mintName: () => MINTED })

  // THE PRECONDITION, ASSERTED so this cannot pass vacuously: the race really was reached — the
  // probe found nothing, and the CREATE was issued anyway and hit the winner.
  assert.deepEqual(creates(), [`CREATE DATABASE "${MINTED}"`], 'the CREATE never ran, so this test proves nothing about what happens when it is rejected')

  // THE FINDING, ON THE WIRE.
  assert.deepEqual(drops(), [], 'the 42P04 refusal issued a DROP against the database another provisioner had just created')
  assert.deepEqual([...wire.databases], [MINTED], "the winning provisioner's database did not survive the loser's refusal")

  assert.ok(outcome instanceof ThrowawayDatabaseError, `expected a named refusal, got ${String(outcome)}`)
  assert.match(outcome.message, /REJECTED with SQLSTATE 42P04[\s\S]*NOTHING WAS DROPPED/)
})

test('r8 HIGH: the 42P04 refusal is reported as a race, not as a failed create', async () => {
  resetWire()
  wire.createdByAnotherProvisionerAfterProbe = MINTED

  const error = await capture({ label: 'alnkfence', mintName: () => MINTED })

  assert.ok(error instanceof ThrowawayDatabaseError, `expected a named refusal, got ${String(error)}`)
  // A REFUSAL, in the same family as the probe's — not the answer-unknown path's "could not create
  // ... the CREATE had already been ISSUED", which is the wording that names a possible leak.
  // Asserting the absence of that phrase is what keeps the two paths from drifting together.
  assert.match(error.message, new RegExp(`^throwaway database: refused ${MINTED}: `))
  assert.doesNotMatch(error.message, /had already been ISSUED/)
  assert.doesNotMatch(error.message, /MAY BE LEFT ON THE SERVER/)
  assert.match(error.message, /positive proof another provisioner created that database/)
})

test('r10 HIGH: THE COMBINED RACE — another provisioner won AND the 42P04 was lost: no DROP', async () => {
  // r9 needed a lock AND a stamp to survive this one, and r10 found both unsound. It now needs
  // NEITHER: the module never saw its own CREATE complete, so it does not drop. That is the whole
  // argument, and there is nothing in it a third party can satisfy.
  resetWire()
  wire.createdByAnotherProvisionerAfterProbe = MINTED
  wire.loseCreateResponse = true

  const outcome = await capture({ label: 'alnkfence', mintName: () => MINTED })

  // PRECONDITIONS, so this cannot pass by never reaching the race.
  assert.deepEqual(creates(), [`CREATE DATABASE "${MINTED}"`], 'the CREATE never ran, so the lost 42P04 was never reached')

  // THE FINDING. The winner's database is untouched, and no DROP went down the wire at all.
  assert.deepEqual(drops(), [], 'the LOST 42P04 issued a DROP against the database another provisioner had just created')
  assert.deepEqual([...wire.databases], [MINTED])
  assert.deepEqual(inferenceStatements(), [], 'the cleanup inspected the winner\'s database to decide whether to drop it')

  assert.ok(outcome instanceof ThrowawayDatabaseError, `expected a named refusal, got ${String(outcome)}`)
  assert.match(outcome.message, /NO ANSWER CAME BACK/)
  assert.match(outcome.message, /NOTHING WAS DROPPED/)
  assert.doesNotMatch(outcome.message, /nothing was left behind/)
})

test('r10 HIGH: a NON-PARTICIPANT holding the name survives EVERY failure mode, whatever it looks like', async () => {
  // THE r10 FINDING IN ITS GENERAL FORM. Codex's example was a foreign database carrying
  // `CONNECTION LIMIT 4242` — the stamp r9 read as provenance — and the point generalises: any
  // marker this module can write, an unrelated caller can write too, and there is a window
  // between reading one and acting on it.
  //
  // THE PROOF IS THEREFORE NOT "a 4242 database survives". It is that NOTHING IS ASKED. The fake
  // server has no attributes to give and THROWS on any statement that asks for one, so a database
  // carrying a matching limit — or any other marker a future round might reach for — cannot be
  // distinguished from one that does not, and every path below leaves it alone.
  for (const [arm, setup] of [
    ['it was already there', () => { wire.databases.add(MINTED) }],
    ['it arrived after our probe', () => { wire.createdByAnotherProvisionerAfterProbe = MINTED }],
    ['it arrived after our probe and the 42P04 was lost', () => {
      wire.createdByAnotherProvisionerAfterProbe = MINTED
      wire.loseCreateResponse = true
    }],
    ['it arrived after our probe and our CREATE never reached the server at all', () => {
      wire.createdByAnotherProvisionerAfterProbe = MINTED
      wire.loseCreateBeforeExecuting = true
    }],
  ] as const) {
    resetWire()
    setup()

    const outcome = await capture({ label: 'alnkfence', mintName: () => MINTED, migrateTimeoutMs: 1 })

    assert.ok(outcome instanceof ThrowawayDatabaseError, `${arm}: expected a named refusal, got ${String(outcome)}`)
    assert.deepEqual(drops(), [], `${arm}: a database this process never created was dropped`)
    assert.deepEqual([...wire.databases], [MINTED], `${arm}: the foreign database did not survive`)
    assert.deepEqual(inferenceStatements(), [], `${arm}: the module asked the server what the database looks like`)
  }
})

// -------------------------------------------------------------------------------------------
// PROOF 3 — THE `created` PATH STILL DROPS, AND LEAVES NOTHING BEHIND.
//
// The counterweight to everything above: it would be easy to make all of Proof 2 pass by never
// dropping at all, which would turn every lane into a leak.
// -------------------------------------------------------------------------------------------

test('r9 LOW: a CREATE that SUCCEEDED and a teardown that failed still drops the database', async () => {
  // THE MUTATION THIS EXISTS FOR: `outcome = 'created'` after the CREATE completes had no
  // regression proof before r9. Changing it to `'not-created'` leaks the newly created database
  // and the rest of the suite still passes, because nothing else makes `client.end()` fail after
  // a successful CREATE.
  resetWire()
  wire.failEndAfterCreate = true

  const outcome = await capture({ label: 'alnkfence', mintName: () => MINTED })

  // PRECONDITION: the CREATE really did succeed, so the failure under test is the teardown.
  assert.deepEqual(creates(), [`CREATE DATABASE "${MINTED}"`])

  // THE FINDING: it is dropped, and the wire says so. No probe was needed to license it — the
  // server had already answered this process's own CREATE.
  assert.deepEqual(drops(), [`DROP DATABASE IF EXISTS "${MINTED}" WITH (FORCE)`], 'a CREATE that succeeded and then failed to tear down leaked its database')
  assert.equal(wire.databases.size, 0, `the created database was left behind: ${[...wire.databases].join(', ')}`)
  assert.deepEqual(inferenceStatements(), [], 'a COMPLETED create should not need corroborating: the server already answered')

  assert.ok(outcome instanceof ThrowawayDatabaseError, `expected a named refusal, got ${String(outcome)}`)
  assert.match(outcome.message, /had already been ISSUED and had SUCCEEDED[\s\S]*nothing was left behind/)
})

test('r10: the two outcomes stayed DISTINGUISHABLE — a completed CREATE drops, a lost one does not', async () => {
  // The regression guard for the rule itself, run as one test so the two arms cannot drift apart.
  // Same fake server, same name, same code path up to the answer the server gives; the ONLY
  // difference is whether this process saw its own CREATE complete.
  resetWire()
  wire.failEndAfterCreate = true
  await capture({ label: 'alnkfence', mintName: () => MINTED })
  assert.deepEqual(drops(), [`DROP DATABASE IF EXISTS "${MINTED}" WITH (FORCE)`], 'the completed-CREATE path stopped dropping, so every lane now leaks')
  assert.equal(wire.databases.size, 0)

  resetWire()
  wire.loseCreateResponse = true
  await capture({ label: 'alnkfence', mintName: () => MINTED })
  assert.deepEqual(drops(), [], 'the lost-response path started dropping again')
  assert.deepEqual([...wire.databases], [MINTED])
})

// -------------------------------------------------------------------------------------------
// AND WHEN THE ONE LICENSED DROP FAILS, THE LEAK IS NAMED TOO.
// -------------------------------------------------------------------------------------------

test('r10: a licensed DROP that ALSO fails says the database is left, and names it', async () => {
  for (const [arm, options, expected] of [
    [
      'the teardown after a successful CREATE',
      { migrateTimeoutMs: undefined },
      /could not create [\s\S]*DROP that would have cleaned it up ALSO FAILED/,
    ],
    [
      'the migration failure',
      { migrateTimeoutMs: 1 },
      /could not migrate [\s\S]*DROP that would have cleaned it up ALSO FAILED/,
    ],
  ] as const) {
    resetWire()
    wire.failDrop = true
    // The first arm needs the provision itself to fail after a successful CREATE; the second needs
    // it to succeed so `prisma migrate deploy` is reached and times out.
    if (arm === 'the teardown after a successful CREATE') wire.failEndAfterCreate = true

    const outcome = await capture({ label: 'alnkfence', mintName: () => MINTED, ...options })

    assert.ok(outcome instanceof ThrowawayDatabaseError, `${arm}: expected a named refusal, got ${String(outcome)}`)
    assert.match(outcome.message, expected, `${arm}: the failed DROP was not reported`)
    assert.match(outcome.message, new RegExp(`${MINTED} IS LEFT ON THE SERVER`), `${arm}: the leak was not named`)
    assert.match(outcome.message, /dropped by hand/)
    // PRECONDITION: a DROP really was attempted, so this is a failed cleanup and not a skipped one.
    assert.ok(drops().length > 0, `${arm}: no DROP was attempted, so nothing failed`)
    // And it IS still there — the honest outcome, rather than a clean failure over a database
    // nobody will ever look for.
    assert.deepEqual([...wire.databases], [MINTED], `${arm}: the fixture did not leave the database behind`)
  }
})

// -------------------------------------------------------------------------------------------
// ROUND 11 — THE RULE THE OTHER FOUR ROUNDS WERE INSTANCES OF: A FACT IS RECORDED BEFORE THE
// OPERATION IT DESCRIBES, NEVER AFTER.
//
// Codex r11 HIGH, verbatim: "`dropped` is set only after `dropDatabase()` returns. If PostgreSQL
// executes the DROP but its response is lost, the handle remains retryable; two concurrent calls
// can likewise both pass the initial check. Another provisioner can recreate the visible name
// before the later DROP executes, causing that later call to destroy a database this process did
// not create."
//
// IT IS THE r9/r10 CREATE FINDING MIRRORED ONTO THE DROP. There, a lost answer read as "nothing
// was created" and licensed a reclaim. Here, a lost answer read as "not dropped yet" and licensed
// a retry. The fix is the same sentence applied to the other statement: A HANDLE ISSUES AT MOST
// ONE `DROP DATABASE`, EVER, and it is marked issued BEFORE the await.
//
// THESE PROOFS RUN AGAINST THE MODULE'S OWN HANDLE, not a re-implementation of its state machine.
// `runMigrations` is the only thing that makes that possible without a Postgres — and the arm
// below proves that seam cannot reach the r10 rule, because the migrator never runs unless the
// server already answered this process's own CREATE.
// -------------------------------------------------------------------------------------------

const DROP_STATEMENT = `DROP DATABASE IF EXISTS "${MINTED}" WITH (FORCE)`
const PROBE_STATEMENT = 'SELECT 1 FROM pg_database WHERE datname = $1'
const CREATE_STATEMENT = `CREATE DATABASE "${MINTED}"`

/**
 * A provision that REACHES ITS RETURN, so the handle's own `drop()` is what the proofs below
 * drive. Every other test in this file stops at a refusal, which is why the drop path had only
 * ever been exercised from inside `provisionThrowawayDatabase` — and why a defect that needs TWO
 * calls on one handle could sit here for eleven rounds without a test that could see it.
 */
async function provisionHandle(): Promise<ThrowawayDatabase> {
  return withWiredUrl(() =>
    provisionThrowawayDatabase({
      label: 'alnkfence',
      mintName: () => MINTED,
      runMigrations: async () => undefined,
    }),
  )
}

/** Settle a promise without letting a rejection short-circuit the wire assertions that follow. */
const settle = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(() => null, (reason: unknown) => reason)

test('r11 HIGH: a DROP whose response is LOST SPENDS the handle — no second DROP is ever issued', async () => {
  resetWire()
  const handle = await provisionHandle()
  assert.deepEqual([...wire.databases], [MINTED], 'the provision never created the database, so there is nothing to drop')

  wire.loseDropResponse = true
  const first = await settle(handle.drop())

  // PRECONDITIONS, so this cannot pass by never reaching the case. The DROP has to have been
  // ISSUED, the server has to have EXECUTED it, and the client has to have been left not knowing.
  assert.deepEqual(drops(), [DROP_STATEMENT], 'no DROP was issued, so no response could be lost')
  assert.equal(wire.databases.size, 0, 'the fake threw before executing the DROP — the case under test was never reached')
  assert.ok(first instanceof Error, `the lost DROP response did not surface as a rejection: ${String(first)}`)

  // ANOTHER PROVISIONER MINTS AND CREATES THE SAME NAME. This is the finding's second half: the
  // name is visible on the server again, and it is NOT this handle's database.
  wire.loseDropResponse = false
  wire.databases.add(MINTED)

  const second = await settle(handle.drop())

  // THE FINDING, ON THE WIRE. `DROP DATABASE IF EXISTS` against a database that IS there succeeds
  // silently, so "it rejected" measures nothing — the assertion is that no second DROP went down
  // the wire at all, and that the other provisioner's database is still there.
  assert.deepEqual(drops(), [DROP_STATEMENT], 'the spent handle issued a SECOND DROP, against a database another provisioner had just created')
  assert.deepEqual([...wire.databases], [MINTED], "the other provisioner's database did not survive this handle's retry")
  assert.deepEqual(inferenceStatements(), [], 'the retry path went looking for evidence of ownership')

  // AND THE REFUSAL NAMES THE DATABASE, because the operator has to be able to find the leak.
  assert.ok(second instanceof ThrowawayDatabaseError, `expected a named refusal, got ${String(second)}`)
  assert.match(second.message, new RegExp(`refused to issue a SECOND DROP DATABASE for ${MINTED}`))
  assert.match(second.message, new RegExp(`${MINTED} MAY STILL BE PRESENT ON THE SERVER`))
  assert.match(second.message, /dropped by hand/)
  assert.match(second.message, /AT MOST ONE DROP/)

  // SPENT MEANS SPENT. A third call is refused the same way rather than quietly becoming a no-op,
  // which would be the same defect with the report removed.
  const third = await settle(handle.drop())
  assert.ok(third instanceof ThrowawayDatabaseError, `expected a named refusal, got ${String(third)}`)
  assert.deepEqual(drops(), [DROP_STATEMENT])
  assert.deepEqual([...wire.databases], [MINTED])
})

test('r11 HIGH: two CONCURRENT drop() calls issue exactly ONE DROP between them', async () => {
  resetWire()
  const handle = await provisionHandle()
  const connectionsBefore = wire.connections

  // NOT AWAITED IN SEQUENCE. All three are started in the same tick, which is the arrangement the
  // finding describes: with the flag set after the await, every one of them reads it as false.
  const settled = await Promise.allSettled([handle.drop(), handle.drop(), handle.drop()])

  assert.deepEqual(
    drops(),
    [DROP_STATEMENT],
    `concurrent callers issued ${drops().length} DROP statements; a handle issues at most one`,
  )
  // THE SAME FACT COUNTED A DIFFERENT WAY: one maintenance connection, not three.
  assert.equal(wire.connections - connectionsBefore, 1, 'a concurrent caller opened its own maintenance connection')
  assert.equal(wire.databases.size, 0, 'the database was not dropped at all, so this proves nothing')

  const fulfilled = settled.filter((result) => result.status === 'fulfilled')
  assert.equal(fulfilled.length, 1, `${fulfilled.length} callers believed they had dropped the database`)
  for (const result of settled) {
    if (result.status === 'fulfilled') continue
    assert.ok(result.reason instanceof ThrowawayDatabaseError, `expected a named refusal, got ${String(result.reason)}`)
    assert.match(result.reason.message, new RegExp(`refused to issue a SECOND DROP DATABASE for ${MINTED}`))
  }
})

test('r11: the ordinary path drops EXACTLY ONCE, leaves nothing behind, and a finally may still call it', async () => {
  // THE COUNTERWEIGHT. Everything above would pass if the handle simply never dropped anything,
  // which would turn every lane into a leak — so the ordinary path is asserted in the same file.
  resetWire()
  const handle = await provisionHandle()

  await handle.drop()
  assert.deepEqual(drops(), [DROP_STATEMENT])
  assert.equal(wire.databases.size, 0, `the drop left ${[...wire.databases].join(', ')} behind`)

  // A DROP THE SERVER ANSWERED IS A NO-OP AFTERWARDS, not a refusal: `finally { lane.close() }` is
  // allowed to run twice. The distinction from the spent handle above is the whole design — one
  // knows the database is gone, the other knows only that it asked.
  await handle.drop()
  await handle.drop()
  assert.deepEqual(drops(), [DROP_STATEMENT], 'a repeated drop() on an ANSWERED handle issued another DROP')

  // THE EXACT WIRE, in order, for a provision that runs to completion and then drops.
  assert.deepEqual(wire.statements, [PROBE_STATEMENT, CREATE_STATEMENT, DROP_STATEMENT])
  assert.deepEqual(inferenceStatements(), [], 'an ownership-inference statement was issued')
})

test('r11: a DROP the server ANSWERED stays answered even when the teardown fails', async () => {
  // THE MUTATION THIS EXISTS FOR: recording `'dropped'` after `withMaintenanceClient` RETURNS
  // instead of the moment the server answers. A failing `client.end()` would then un-record a
  // completed DROP, and the handle would come back SPENT — reporting a possible leak over a
  // database that is provably gone. Same shape, one level out.
  resetWire()
  const handle = await provisionHandle()
  wire.failEndAfterDrop = true

  const first = await settle(handle.drop())

  // PRECONDITIONS: the DROP ran, the database is gone, and the failure under test is the teardown.
  assert.deepEqual(drops(), [DROP_STATEMENT])
  assert.equal(wire.databases.size, 0, 'the fake did not execute the DROP, so the teardown is not what failed')
  assert.ok(first instanceof Error, 'the failing teardown did not surface at all')

  // THE FINDING: the handle is DROPPED, not SPENT. A second call is a silent no-op.
  wire.failEndAfterDrop = false
  await handle.drop()
  assert.deepEqual(drops(), [DROP_STATEMENT], 'a completed DROP was un-recorded by a failing teardown')
})

test('r11: the migrator seam cannot reach the r10 rule — it never runs unless the CREATE completed', async () => {
  // THE GUARD ON THE NEW OPTION. `runMigrations` exists so the handle is reachable from a proof;
  // if it could run — or matter — before the create outcome is decided, it would be a new way to
  // license a DROP, which is exactly the class of seam this branch has spent four rounds closing.
  for (const [arm, setup] of [
    ['the CREATE response was lost', () => { wire.loseCreateResponse = true }],
    ['the CREATE never reached the server', () => { wire.loseCreateBeforeExecuting = true }],
    ['another provisioner won the name', () => { wire.createdByAnotherProvisionerAfterProbe = MINTED }],
    ['another provisioner won AND the 42P04 was lost', () => {
      wire.createdByAnotherProvisionerAfterProbe = MINTED
      wire.loseCreateResponse = true
    }],
    ['the name was already taken', () => { wire.databases.add(MINTED) }],
  ] as const) {
    resetWire()
    setup()

    let migratorRan = false
    const outcome = await withWiredUrl(() =>
      settle(provisionThrowawayDatabase({
        label: 'alnkfence',
        mintName: () => MINTED,
        runMigrations: async () => { migratorRan = true },
      })),
    )

    assert.ok(outcome instanceof ThrowawayDatabaseError, `${arm}: expected a named refusal, got ${String(outcome)}`)
    assert.equal(migratorRan, false, `${arm}: the migrator ran for a CREATE this process never saw complete`)
    assert.deepEqual(drops(), [], `${arm}: a database this process never created was dropped`)
    assert.deepEqual(inferenceStatements(), [], `${arm}: the module asked the server what the database looks like`)
  }

  // NON-VACUITY: the migrator DOES run once the server has answered the CREATE — otherwise every
  // arm above would pass for the wrong reason.
  resetWire()
  let ran = false
  const handle = await withWiredUrl(() =>
    provisionThrowawayDatabase({
      label: 'alnkfence',
      mintName: () => MINTED,
      runMigrations: async () => { ran = true },
    }),
  )
  assert.equal(ran, true, 'the migrator never runs, so the arms above prove nothing')
  await handle.drop()
})

// -------------------------------------------------------------------------------------------
// ROUND 12 — A COMPLETED CREATE PROVES OWNERSHIP OF A GENERATION, NOT OF A NAME.
//
// Codex r12 HIGH, verbatim: "`dropOutcome` is private to each provisioning call, while `mintName`
// permits the same name to be provisioned again. If handle A's database is removed by a
// non-participant and handle B then successfully provisions that name, A remains `not-issued`;
// calling `A.drop()` deletes B's database, and `B.drop()` issues a second DROP. A completed CREATE
// proves ownership only of the historical database instance, not whatever later occupies that
// name."
//
// IT IS NOT r10 OR r11 AGAIN. r10 is about never INFERRING ownership; r11 is about recording a
// fact BEFORE the operation rather than after. Both are about the fact. This one is about WHAT THE
// FACT IDENTIFIES: `outcome === 'created'` is a true statement about a DATABASE, and every later
// check reads it as a statement about a NAME. A non-participant dropping that database is all it
// takes for the two to come apart.
//
// THE FIX PROVED BELOW IS A PROCESS-LEVEL CLAIM ON THE NAME, taken at the mint and given back only
// when this process can no longer issue a DROP for it. No statement, no round trip, no probe: the
// second live handle the finding needs is refused before anything reaches the server.
// -------------------------------------------------------------------------------------------

test('r12 HIGH: a name a live handle can still drop is NOT provisioned again', async () => {
  resetWire()
  const first = await provisionHandle()
  assert.deepEqual([...wire.databases], [MINTED], 'the first provision created nothing, so there is no handle to protect')

  // A NON-PARTICIPANT REMOVES IT — no lock, no marker, nothing this module can see. This is the
  // one event that makes the name and the database come apart, and it is outside this process.
  wire.databases.delete(MINTED)

  const second = await withWiredUrl(() => settle(provisionThrowawayDatabase({
    label: 'alnkfence',
    mintName: () => MINTED,
    runMigrations: async () => undefined,
  })))

  // THE FINDING, CLOSED AT THE MINT: handle B never obtains the name, so the two live handles the
  // finding needs never both exist and there is no database of B's for `first.drop()` to destroy.
  assert.ok(second instanceof ThrowawayDatabaseError, `expected a named refusal, got ${String(second)}`)
  assert.match(second.message, new RegExp(`refused ${MINTED}: THIS PROCESS ALREADY HOLDS`))
  assert.match(second.message, /ownership of the DATABASE THAT WAS CREATED and not of the name/)

  // AND IT IS REFUSED BEFORE THE CREATE. The second provision issues ONE statement — the existence
  // probe that decides whether this is the contended case or the already-exists one (r13) — and
  // then stops: no second CREATE, and above all no DROP.
  assert.deepEqual(
    wire.statements,
    [PROBE_STATEMENT, CREATE_STATEMENT, PROBE_STATEMENT],
    'the refused provision issued something other than the one probe that chooses the refusal',
  )
  assert.deepEqual(drops(), [], 'a DROP was issued for a database this process did not create')
  assert.equal(wire.databases.size, 0, 'the fixture never removed the database, so nothing was ever at risk')
  assert.deepEqual(inferenceStatements(), [], 'the claim was decided by asking the server about the database')

  // THE FIRST HANDLE IS UNHARMED, and its one DROP can only ever have named its own database.
  await first.drop()
  assert.deepEqual(drops(), [DROP_STATEMENT])

  // NON-VACUITY: with the claim given back, THE SAME PROVISION NOW SUCCEEDS. Without this arm the
  // refusal above would also pass if provisioning had simply stopped working.
  const third = await provisionHandle()
  assert.deepEqual(creates(), [CREATE_STATEMENT, CREATE_STATEMENT], 'the released name did not provision again')
  assert.deepEqual([...wire.databases], [MINTED])
  await third.drop()
})

test('r12: a released name provisions again, and the new lane drops its OWN database exactly once', async () => {
  resetWire()
  const a = await provisionHandle()
  await a.drop()
  assert.deepEqual(drops(), [DROP_STATEMENT], 'the first lane did not drop, so nothing was released')
  assert.equal(wire.databases.size, 0)

  // A SECOND LANE, SAME PROCESS, SAME NAME — the legitimate case the claim must not break.
  const b = await provisionHandle()
  assert.deepEqual([...wire.databases], [MINTED], "the second lane's database was never created")

  await b.drop()
  await b.drop()
  assert.deepEqual(drops(), [DROP_STATEMENT, DROP_STATEMENT], `the second lane issued ${drops().length - 1} DROPs, not one`)
  assert.equal(wire.databases.size, 0, `the second lane's drop left ${[...wire.databases].join(', ')} behind`)

  // AND THE FIRST HANDLE STILL CANNOT REACH THE SECOND LANE'S GENERATION: it is `dropped`, so it
  // is a no-op forever. This is the other half of the finding — `B.drop()` issuing a second DROP —
  // read from A's side.
  await a.drop()
  assert.deepEqual(drops(), [DROP_STATEMENT, DROP_STATEMENT], 'a spent handle issued a DROP against a later lane\'s database')
})

test('r12: every provision that returns NO handle gives the name back', async () => {
  // THE COUNTERWEIGHT. A claim that is taken and never released would make one contended name
  // permanently unusable — and would make the proof above pass for a reason that has nothing to do
  // with live handles. Every failure path that returns no handle is walked here.
  for (const [arm, setup, extra] of [
    ['the CREATE response was lost', () => { wire.loseCreateResponse = true }, {}],
    ['the CREATE never reached the server', () => { wire.loseCreateBeforeExecuting = true }, {}],
    ['another provisioner won the name', () => { wire.createdByAnotherProvisionerAfterProbe = MINTED }, {}],
    ['the name was already taken', () => { wire.databases.add(MINTED) }, {}],
    ['the teardown after a successful CREATE failed', () => { wire.failEndAfterCreate = true }, {}],
    ['the migration failed', () => {}, { runMigrations: async () => { throw new Error('migrate refused') } }],
  ] as const) {
    resetWire()
    setup()

    const outcome = await capture({ label: 'alnkfence', mintName: () => MINTED, runMigrations: async () => undefined, ...extra })
    assert.ok(outcome instanceof ThrowawayDatabaseError, `${arm}: expected a named refusal, got ${String(outcome)}`)
    assert.doesNotMatch(outcome.message, /ALREADY HOLDS/, `${arm}: the claim from a PREVIOUS arm was never given back`)

    // THE NAME IS FREE AGAIN: same process, same name, and it provisions and drops normally.
    resetWire()
    const handle = await provisionHandle()
    assert.deepEqual([...wire.databases], [MINTED], `${arm}: the follow-up provision created nothing`)
    await handle.drop()
    assert.equal(wire.databases.size, 0, `${arm}: the follow-up lane leaked its database`)
  }

  // AND THE ORDER OF THE TWO CHECKS. The claim is taken AFTER the name guard, so a name the guard
  // refuses never takes one and the SECOND attempt is still reported as PROTECTED rather than as
  // contended. "Which rule fired" is a property this file asserts everywhere else, and a claim
  // taken too early would blur it into "you already hold that".
  for (const attempt of [1, 2]) {
    resetWire()
    const outcome = await capture({ label: 'alnkfence', mintName: () => CONFIGURED })
    assert.ok(outcome instanceof ThrowawayDatabaseError, `attempt ${attempt}: expected a named refusal, got ${String(outcome)}`)
    assert.match(outcome.message, /it is a PROTECTED database/, `attempt ${attempt}: the guard refusal was replaced by a claim refusal`)
    assert.deepEqual(wire.statements, [], `attempt ${attempt}: a protected name reached the server`)
  }
})

// -------------------------------------------------------------------------------------------
// ROUND 13 — A NEW GUARD THAT REFUSES EARLIER TAKES THE OLD GUARD'S CASES AWAY.
//
// THE REGRESSION THIS FILE DID NOT CATCH, WRITTEN DOWN SO IT CANNOT RECUR. r12's claim was taken
// AT THE MINT, before the existence probe. Every arm above still passed, because every arm above
// that exercises a HELD name deletes the database first — that is the r12 finding's premise. The
// case nobody wrote is the ordinary one: a name that is held by a live handle AND still present on
// the server, which is what a lane has when it points a provision at its own database to prove the
// already-exists refusal. That provision was refused as CONTENDED, rule (4) became unreachable
// through the only seam that can reach it, and the concurrency lane went red on the first run.
//
// SO THE PROPERTY UNDER TEST IS NOT "IS IT REFUSED" — every arm here was already refused — BUT
// WHICH RULE SAYS SO. The four refusals are ordered, several can be true of one name at once, and
// the earliest one wins.
// -------------------------------------------------------------------------------------------

test('r13: a held name whose database is STILL THERE is refused as ALREADY EXISTS, not as contended', async () => {
  resetWire()
  const incumbent = await provisionHandle()
  assert.deepEqual([...wire.databases], [MINTED], 'the incumbent never created its database, so nothing is held OR present')

  // BOTH RULES ARE TRUE OF THIS NAME. It is on the server, and a live handle in this process can
  // still drop it. This is the state a lane is in, and the state no arm above modelled.
  const second = await withWiredUrl(() => settle(provisionThrowawayDatabase({
    label: 'alnkfence',
    mintName: () => MINTED,
    runMigrations: async () => undefined,
  })))

  assert.ok(second instanceof ThrowawayDatabaseError, `expected a named refusal, got ${String(second)}`)
  assert.match(second.message, new RegExp(`refused ${MINTED}: a database of that name ALREADY EXISTS`))
  assert.doesNotMatch(
    second.message,
    /ALREADY HOLDS/,
    'the claim shadowed the already-exists refusal — this is the r12 regression the concurrency lane caught',
  )

  // IT IS STILL REFUSED BEFORE THE CREATE, and nothing was dropped: the reordering buys a better
  // sentence, not a weaker guard.
  assert.deepEqual(wire.statements, [PROBE_STATEMENT, CREATE_STATEMENT, PROBE_STATEMENT])
  assert.deepEqual(creates(), [CREATE_STATEMENT], 'the refused provision issued a CREATE')
  assert.deepEqual(drops(), [], "the refused provision dropped the incumbent's database")
  assert.deepEqual([...wire.databases], [MINTED], "the incumbent's database did not survive the refusal")
  assert.deepEqual(inferenceStatements(), [], 'the refusal was decided by inferring ownership')

  // AND THE INCUMBENT'S CLAIM SURVIVED IT (r13 corollary). The refusal above ran through the same
  // failure path that gives a claim back, while the name belonged to somebody else's handle. If it
  // had given THAT name back, the r12 defect would be open again — so drive the r12 case now: a
  // non-participant removes the database, and the next provision must STILL be refused.
  wire.databases.delete(MINTED)
  const third = await withWiredUrl(() => settle(provisionThrowawayDatabase({
    label: 'alnkfence',
    mintName: () => MINTED,
    runMigrations: async () => undefined,
  })))
  assert.ok(third instanceof ThrowawayDatabaseError, `the incumbent's claim was given away: got ${String(third)}`)
  assert.match(third.message, new RegExp(`refused ${MINTED}: THIS PROCESS ALREADY HOLDS`))
  assert.deepEqual(creates(), [CREATE_STATEMENT], 'a second database was created for a name a live handle can still drop')

  // THE INCUMBENT IS UNHARMED THROUGHOUT, and its one DROP is its own.
  await incumbent.drop()
  assert.deepEqual(drops(), [DROP_STATEMENT])

  // NON-VACUITY: with the claim released, the same name provisions again.
  resetWire()
  const next = await provisionHandle()
  assert.deepEqual([...wire.databases], [MINTED], 'the released name did not provision again')
  await next.drop()
})

test('r13: each of the four refusals reports ITSELF, on the name only it applies to', async () => {
  // THE ORDER, READ OFF THE MESSAGES. One arm per rule, each on a name the earlier rules do not
  // fire for, plus the ordinary held-and-present case above which is where the order matters.
  // A guard added in a future round has to leave this table alone.
  resetWire()
  const held = await provisionHandle()
  wire.databases.delete(MINTED)          // held, absent -> the claim is the only rule left
  const statementsBefore = wire.statements.length

  const arms: [string, string, RegExp, number][] = [
    // name, why, expected refusal, statements this arm is allowed to issue
    [CONFIGURED, 'the configured/protected database', /it is a PROTECTED database/, 0],
    ['some_other_database', 'a name this module never minted', /it is not a name this module minted/, 0],
    [MINTED, 'held by a live handle, absent from the server', /THIS PROCESS ALREADY HOLDS/, 1],
  ]
  for (const [name, why, expected, allowed] of arms) {
    const before = wire.statements.length
    const outcome = await capture({ label: 'alnkfence', mintName: () => name, runMigrations: async () => undefined })
    assert.ok(outcome instanceof ThrowawayDatabaseError, `${why}: expected a named refusal, got ${String(outcome)}`)
    assert.match(outcome.message, expected, `${why}: the wrong rule reported`)
    assert.equal(wire.statements.length - before, allowed, `${why}: issued the wrong number of statements`)
  }

  // The fourth rule, on a name NOTHING in this process holds: present on the server, and reported
  // as present. This is the refusal the concurrency lane proves against a real Postgres.
  const other = 'ims_throwaway_alnkother_00112233445566ff'
  wire.databases.add(other)
  const present = await capture({ label: 'alnkother', mintName: () => other, runMigrations: async () => undefined })
  assert.ok(present instanceof ThrowawayDatabaseError, `expected a named refusal, got ${String(present)}`)
  assert.match(present.message, new RegExp(`refused ${other}: a database of that name ALREADY EXISTS`))

  assert.deepEqual(drops(), [], 'one of the refusals issued a DROP')
  assert.ok(wire.statements.length > statementsBefore, 'no arm reached the server, so the statement counts prove nothing')

  await held.drop()
  assert.deepEqual(drops(), [DROP_STATEMENT], "the incumbent's own drop did not run")
})
