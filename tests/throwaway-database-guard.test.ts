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
 */

import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { THROWAWAY_DATABASE_PROVISION_LOCK_NAMESPACE } from '@/lib/db/advisory-locks'
import {
  PROTECTED_DATABASE_NAMES,
  THROWAWAY_DATABASE_CONNECTION_LIMIT,
  THROWAWAY_DATABASE_NAME_RE,
  ThrowawayDatabaseError,
  assertThrowawayDatabaseName,
  provisionLockId,
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
// ROUND 7, Codex LOW — THE LOST-RESPONSE ORPHAN.
//
// `CREATE DATABASE` is issued over a socket. If PostgreSQL EXECUTES it and the connection then
// fails before the completion response arrives, `client.query` REJECTS: the database exists, this
// process never learned so, and `provisionThrowawayDatabase` used to throw before the `drop`
// closure had even been created. The r6 cleanup could not help — it starts once a handle exists.
//
// THIS IS NOT THE SIGKILL HOLE, and the difference is the whole reason it is fixed rather than
// documented. SIGKILL runs no further JavaScript, so nothing can clean up. THIS failure is a
// catchable rejection with a live process on the other side of it, so it is closable, and closed
// is DEMONSTRATED here rather than argued: a fake wire creates the database, loses the response,
// and the assertion is that the database is GONE from that fake server afterwards.
//
// NO REAL SERVER, ON PURPOSE. `npm run test:unit` has no database, and a proof that only runs in
// the concurrency lane is a proof that mostly does not run. `pg` is module-mocked to a fake that
// models the ONE thing that matters here: a server on which databases exist or do not.
// ===========================================================================================


/**
 * THE FAKE SERVER — now a server with SESSIONS, because the r9 finding is about what one session
 * knows while another one dies.
 *
 * r8's wire modelled a single connection at a time and a `loseCreateResponse` that only applied
 * AFTER a successful CREATE. That is the vacuity Codex found: the combined race it claimed to
 * cover — "another provisioner won AND this one lost the resulting 42P04" — could not be
 * EXPRESSED on it, because losing a response was wired to the success branch alone. It models
 * both branches now, and it models advisory locks held per session, so a session can die holding
 * one and the code has to notice.
 */
const wire = {
  /** name -> `datconnlimit`. The stamp is part of the state, because it is part of the answer. */
  databases: new Map<string, number>(),
  connections: 0,
  statements: [] as string[],
  /** Backends the server still has. A killed one answers nothing and holds nothing. */
  liveSessions: new Set<number>(),
  /** `"<namespace>/<id>"` -> the backend pid holding it. */
  advisoryLocks: new Map<string, number>(),
  /** Every client that has taken an advisory lock, so a proof can kill one. */
  lockSessions: [] as FakeMaintenanceClient[],
  /**
   * THE DEFECT: the server executes the CREATE and the client never hears the answer.
   *
   * r9: this applies to the answer, WHICHEVER answer it was — the completion OR the `42P04`. The
   * r8 version only applied after success, so the case that mattered most could not be reached.
   */
  loseCreateResponse: false,
  /** The variant where the statement never reached the server at all. */
  loseCreateBeforeExecuting: false,
  /** The unrecoverable variant: the reclaiming DROP cannot be delivered either. */
  failDrop: false,
  /** `client.end()` fails on the session that issued the CREATE, AFTER the CREATE succeeded. */
  failEndAfterCreate: false,
  /** The lock session's backend dies at the same instant the create session's does. */
  killLockSessionWithCreateSession: false,
  /**
   * ANOTHER PROVISIONER, ARRIVING BETWEEN THE PROBE AND THE CREATE.
   *
   * When set to a name, the fake server answers the existence probe TRUTHFULLY — absent, because
   * at that instant it is — and then records that name as created by somebody else before the
   * CREATE arrives.
   *
   * r9: it creates WITHOUT taking the provisioning lock and WITHOUT the ownership stamp
   * (`datconnlimit` -1, PostgreSQL's default), which is the only way this can still happen now.
   * A provisioner that takes the lock cannot be in that gap at all — that is what
   * `the provisioning lock EXCLUDES a second provisioner` below proves.
   */
  createdByAnotherProvisionerAfterProbe: null as string | null,
  /** A foreign session already holding the provisioning lock for a name, from before this run. */
  lockHeldByForeignSession: null as string | null,
}

const FOREIGN_BACKEND_PID = 999

function resetWire(): void {
  wire.databases.clear()
  wire.connections = 0
  wire.statements = []
  wire.liveSessions.clear()
  wire.advisoryLocks.clear()
  wire.lockSessions = []
  wire.loseCreateResponse = false
  wire.loseCreateBeforeExecuting = false
  wire.failDrop = false
  wire.failEndAfterCreate = false
  wire.killLockSessionWithCreateSession = false
  wire.createdByAnotherProvisionerAfterProbe = null
  wire.lockHeldByForeignSession = null
}

/** `CREATE DATABASE "x" CONNECTION LIMIT 4242` / `DROP DATABASE IF EXISTS "x" ...` -> `x`. */
function quotedName(statement: string): string {
  const match = /"((?:[^"]|"")*)"/.exec(statement)
  if (!match) throw new Error(`the fake server could not find a quoted name in: ${statement}`)
  return match[1].replace(/""/g, '"')
}

/** The `CONNECTION LIMIT` a CREATE asked for, or PostgreSQL's default when it asked for none. */
function requestedConnectionLimit(statement: string): number {
  const match = /CONNECTION LIMIT\s+(-?\d+)/.exec(statement)
  return match ? Number(match[1]) : -1
}

/** A dead backend: it answers nothing, and every session lock it held is freed at once. */
function terminateBackend(pid: number): void {
  wire.liveSessions.delete(pid)
  for (const [key, holder] of [...wire.advisoryLocks]) {
    if (holder === pid) wire.advisoryLocks.delete(key)
  }
}

let nextBackendPid = 1000

class FakeMaintenanceClient {
  readonly backendPid = (nextBackendPid += 1)
  private issuedCreate = false
  private readonly errorListeners: ((error: Error) => void)[] = []

  constructor(_config: { connectionString: string }) { void _config }

  /** `pg` emits `error` on an idle client whose socket fails; the lock holder listens for it. */
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
    terminateBackend(this.backendPid)
    for (const listener of this.errorListeners) listener(new Error('Connection terminated unexpectedly'))
  }

  async query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    wire.statements.push(text)
    if (!wire.liveSessions.has(this.backendPid)) {
      throw new Error('Client has encountered a connection error and is not queryable')
    }

    if (text.startsWith('SELECT set_config')) {
      return { rows: [{ set_config: String((values ?? [])[1]) }] }
    }

    if (text.startsWith('SELECT pg_advisory_lock')) {
      const key = `${(values ?? [])[0]}/${(values ?? [])[1]}`
      const holder = wire.advisoryLocks.get(key)
      if (holder !== undefined && holder !== this.backendPid && wire.liveSessions.has(holder)) {
        // A REAL SERVER WOULD BLOCK, then cancel at `lock_timeout`. The fake collapses the wait to
        // its outcome, which is the observable this module reacts to: SQLSTATE 55P03.
        throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' })
      }
      wire.advisoryLocks.set(key, this.backendPid)
      wire.lockSessions.push(this)
      return { rows: [{ pg_advisory_lock: null }] }
    }

    if (text.startsWith('SELECT count(*)::int AS held FROM pg_locks')) {
      const key = `${(values ?? [])[1]}/${(values ?? [])[2]}`
      return { rows: [{ held: wire.advisoryLocks.get(key) === this.backendPid ? 1 : 0 }] }
    }

    if (text.startsWith('SELECT 1 FROM pg_database')) {
      const name = String((values ?? [])[0])
      const answer = { rows: wire.databases.has(name) ? [{ exists: 1 }] : [] }
      // AFTER the answer is computed, so the probe reports what was true when it ran and the race
      // lands in the gap that the finding is about. -1 because a NON-PARTICIPANT created it: it
      // does not take the lock, and it does not carry this module's ownership stamp.
      if (wire.createdByAnotherProvisionerAfterProbe !== null) {
        wire.databases.set(wire.createdByAnotherProvisionerAfterProbe, -1)
      }
      return answer
    }

    if (text.startsWith('SELECT datconnlimit FROM pg_database')) {
      const name = String((values ?? [])[0])
      const limit = wire.databases.get(name)
      return { rows: limit === undefined ? [] : [{ datconnlimit: limit }] }
    }

    if (text.startsWith('CREATE DATABASE')) {
      this.issuedCreate = true
      const name = quotedName(text)
      const dying = wire.loseCreateResponse || wire.loseCreateBeforeExecuting
      const die = () => {
        this.kill()
        if (wire.killLockSessionWithCreateSession) for (const session of wire.lockSessions) session.kill()
        throw new Error('Connection terminated unexpectedly')
      }
      // The statement never reached the server: nothing happens on it, and the client still dies.
      if (wire.loseCreateBeforeExecuting) die()
      if (wire.databases.has(name)) {
        // WHAT POSTGRESQL ACTUALLY DOES, with the SQLSTATE it actually sets. The existing database
        // is left ALONE — this branch must not touch `wire.databases`, or the assertion that the
        // winner's database survived would be measuring the fake instead of the fix.
        //
        // r9: the response can be LOST HERE TOO, and that is the combined race. The server has
        // still refused; the client simply never finds out which answer it was owed.
        if (dying) die()
        throw Object.assign(new Error(`database "${name}" already exists`), {
          code: '42P04',
          severity: 'ERROR',
          routine: 'createdb',
        })
      }
      // THE SERVER DOES THE WORK EITHER WAY. That is the r7 finding: the database exists whether
      // or not the client survives long enough to be told, and it carries the stamp the statement
      // asked for.
      wire.databases.set(name, requestedConnectionLimit(text))
      if (dying) die()
      return { rows: [] }
    }

    if (text.startsWith('DROP DATABASE')) {
      if (wire.failDrop) throw new Error('Connection terminated unexpectedly')
      wire.databases.delete(quotedName(text))
      return { rows: [] }
    }

    throw new Error(`the fake server was asked for an unmodelled statement: ${text}`)
  }

  async end(): Promise<void> {
    if (this.issuedCreate && wire.failEndAfterCreate) {
      // The session is gone as far as the server is concerned; the CLIENT is what failed to be
      // told cleanly. That is the r9 LOW: a CREATE that SUCCEEDED and a teardown that did not.
      terminateBackend(this.backendPid)
      throw new Error('Connection terminated unexpectedly')
    }
    terminateBackend(this.backendPid)
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

/** Seed a lock held by somebody who is not us, so the acquisition below has to contend for it. */
function seedForeignLock(name: string): void {
  wire.liveSessions.add(FOREIGN_BACKEND_PID)
  wire.advisoryLocks.set(
    `${THROWAWAY_DATABASE_PROVISION_LOCK_NAMESPACE}/${provisionLockId(name)}`,
    FOREIGN_BACKEND_PID,
  )
}

/** Run a provision and hand back whatever came out, refusal included. Never short-circuits. */
async function capture(options: Parameters<typeof provisionThrowawayDatabase>[0]): Promise<unknown> {
  return withWiredUrl(async () =>
    provisionThrowawayDatabase(options).then(() => null, (reason: unknown) => reason),
  )
}

const drops = () => wire.statements.filter((statement) => statement.startsWith('DROP DATABASE'))
const creates = () => wire.statements.filter((statement) => statement.startsWith('CREATE DATABASE'))
const locks = () => wire.statements.filter((statement) => statement.startsWith('SELECT pg_advisory_lock'))

test('CONTROL: the fake wire really provisions, so the refusals below are not refusing everything', async () => {
  resetWire()
  await withWiredUrl(async () => {
    // `migrateTimeoutMs: 1` makes `prisma migrate deploy` fail immediately — which is the r6
    // cleanup path, and it proves the fake server records a DROP when one is issued. Without this
    // arm, a missing DROP in the test below could mean the wire never worked at all.
    await assert.rejects(
      () => provisionThrowawayDatabase({ label: 'alnkfence', mintName: () => MINTED, migrateTimeoutMs: 1 }),
      refusal(/could not migrate ims_throwaway_alnkfence_0123456789abcdef/),
    )
  })
  assert.deepEqual(
    creates(),
    [`CREATE DATABASE "${MINTED}" CONNECTION LIMIT ${THROWAWAY_DATABASE_CONNECTION_LIMIT}`],
    'the CREATE did not carry the ownership stamp the reclaim decides on',
  )
  assert.equal(locks().length, 1, 'the provisioning lock was never taken')
  assert.ok(drops().length > 0, 'the migration-failure cleanup issued no DROP')
  assert.equal(wire.databases.size, 0, `the migration-failure cleanup left ${[...wire.databases.keys()].join(', ')} behind`)
  // And the lock did not outlive the provisioning attempt.
  assert.equal(wire.advisoryLocks.size, 0, 'the provisioning lock was never released')
})

test('r7 LOW: a CREATE whose response is LOST leaves no orphan', async () => {
  resetWire()
  wire.loseCreateResponse = true

  await withWiredUrl(async () => {
    await assert.rejects(
      () => provisionThrowawayDatabase({ label: 'alnkfence', mintName: () => MINTED }),
      refusal(/could not create ims_throwaway_alnkfence_0123456789abcdef[\s\S]*CREATE had already been ISSUED[\s\S]*reclaimed; nothing was left behind/),
    )
  })

  // THE ASSERTION THAT IS THE FINDING. The server DID create it — the fake adds it before the
  // rejection, exactly as PostgreSQL would — and it is gone again.
  assert.equal(
    wire.databases.size,
    0,
    `a lost CREATE response left ${[...wire.databases.keys()].join(', ')} on the server`,
  )
  // And the reclaim used FRESH connections: the one that issued the CREATE is the one that just
  // died, so a cleanup routed through it would be no cleanup at all. Four in total — the lock
  // session, the create session, the re-probe that establishes ownership, and the drop.
  assert.equal(wire.connections, 4, `the reclaim did not open its own connections (${wire.connections} in total)`)
  assert.deepEqual(drops(), [`DROP DATABASE IF EXISTS "${MINTED}" WITH (FORCE)`])
  // The migration was never started: there was no database to migrate.
  assert.ok(!wire.statements.some((statement) => statement.includes('migrate')))
})

test('r7 LOW: a reclaim that ALSO fails says the orphan may remain, and names it', async () => {
  resetWire()
  wire.loseCreateResponse = true
  wire.failDrop = true

  await withWiredUrl(async () => {
    await assert.rejects(
      () => provisionThrowawayDatabase({ label: 'alnkfence', mintName: () => MINTED }),
      refusal(new RegExp(`reclaiming DROP ALSO FAILED[\\s\\S]*${MINTED} MAY still exist on the server`)),
    )
  })

  // The honest outcome: it IS still there, and the refusal said so by name rather than reporting
  // a clean failure over a database nobody will ever look for.
  assert.deepEqual([...wire.databases.keys()], [MINTED])
})

test('r7 LOW: the ALREADY EXISTS refusal must NOT drop — it protects a database this lane did not create', async () => {
  resetWire()
  // Somebody else's database, sitting under a name this lane happened to mint.
  wire.databases.set(MINTED, -1)

  await withWiredUrl(async () => {
    await assert.rejects(
      () => provisionThrowawayDatabase({ label: 'alnkfence', mintName: () => MINTED }),
      refusal(/ALREADY EXISTS, so this lane did not create it/),
    )
  })

  // THE CLEANUP IS KEYED ON "THE CREATE WAS ISSUED", and it was not. A cleanup keyed on the NAME
  // instead would drop exactly the database this refusal exists to protect.
  assert.deepEqual([...wire.databases.keys()], [MINTED], 'the already-exists refusal dropped somebody else\'s database')
  assert.deepEqual(drops(), [])
  assert.deepEqual(creates(), [])
})

// ===========================================================================================
// ROUND 8, Codex HIGH — THE PROBE IS NOT A LOCK, AND `42P04` IS PROOF OF SOMEBODY ELSE.
//
// The existence probe and the `CREATE DATABASE` are two statements. Under r8 nothing held the
// name between them, so two provisioners could both observe it absent; one won the CREATE and the
// other was REJECTED with SQLSTATE 42P04, and the loser carried that rejection into the
// lost-response cleanup and issued `DROP DATABASE IF EXISTS` — against the WINNER'S database.
//
// r9 puts a lock between them, so a PARTICIPANT can no longer be in that gap at all. What can
// still be there is something that does not take the lock, and these two tests are about it.
//
// PROVED ON THE WIRE, NOT BY THE ABSENCE OF AN EXCEPTION. `DROP DATABASE IF EXISTS` against a
// database that is there SUCCEEDS and destroys it silently, so "it did not throw" measures
// nothing at all. The assertion is over `wire.statements`: no DROP was issued.
// ===========================================================================================

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
  assert.deepEqual(
    creates(),
    [`CREATE DATABASE "${MINTED}" CONNECTION LIMIT ${THROWAWAY_DATABASE_CONNECTION_LIMIT}`],
    'the CREATE never ran, so this test proves nothing about what happens when it is rejected',
  )

  // THE FINDING, ON THE WIRE.
  assert.deepEqual(drops(), [], 'the 42P04 refusal issued a DROP against the database another provisioner had just created')

  // And the consequence of that, stated as the thing anybody actually cares about.
  assert.deepEqual([...wire.databases.keys()], [MINTED], "the winning provisioner's database did not survive the loser's refusal")

  // Only now the refusal itself — it must be a refusal, and it must say why nothing was dropped.
  assert.ok(outcome instanceof ThrowawayDatabaseError, `expected a named refusal, got ${String(outcome)}`)
  assert.match(outcome.message, /REJECTED with SQLSTATE 42P04[\s\S]*NOTHING WAS DROPPED/)
})

test('r8 HIGH: the 42P04 refusal is reported as a race, not as a failed create', async () => {
  resetWire()
  wire.createdByAnotherProvisionerAfterProbe = MINTED

  const error = await capture({ label: 'alnkfence', mintName: () => MINTED })

  assert.ok(error instanceof ThrowawayDatabaseError, `expected a named refusal, got ${String(error)}`)
  // A REFUSAL, in the same family as the probe's — not the reclaim's "could not create ... the
  // CREATE had already been ISSUED", which is the wording that would say a drop had been decided
  // on. Asserting the absence of that phrase is what keeps the two paths from drifting together.
  assert.match(error.message, new RegExp(`^throwaway database: refused ${MINTED}: `))
  assert.doesNotMatch(error.message, /had already been ISSUED/)
  assert.match(error.message, /positive proof another provisioner created that database/)
})

test('r8 HIGH: a lost response is still reclaimed — the two outcomes stayed distinguishable', async () => {
  // The regression guard for the fix itself. It would be easy to close the 42P04 hole by never
  // dropping after a CREATE at all, which would reopen r7. Both arms have to hold at once.
  resetWire()
  wire.loseCreateResponse = true
  await withWiredUrl(async () => {
    await assert.rejects(
      () => provisionThrowawayDatabase({ label: 'alnkfence', mintName: () => MINTED }),
      refusal(/CREATE had already been ISSUED[\s\S]*reclaimed; nothing was left behind/),
    )
  })
  assert.deepEqual(drops(), [`DROP DATABASE IF EXISTS "${MINTED}" WITH (FORCE)`], 'the lost-response reclaim stopped issuing its DROP')
  assert.equal(wire.databases.size, 0)

  // And the same run, one flag apart, must NOT drop. Same fake server, same name, same code path
  // up to the answer the server gives — the ONLY difference is which answer arrives.
  resetWire()
  wire.createdByAnotherProvisionerAfterProbe = MINTED
  await withWiredUrl(async () => {
    await assert.rejects(
      () => provisionThrowawayDatabase({ label: 'alnkfence', mintName: () => MINTED }),
      refusal(/NOTHING WAS DROPPED/),
    )
  })
  assert.deepEqual(drops(), [])
  assert.deepEqual([...wire.databases.keys()], [MINTED])
})

// ===========================================================================================
// ROUND 9, Codex HIGH — THE LOCK THE LAST ROUND SAID DID NOT EXIST.
//
// r8 closed the 42P04 case and documented the LOST 42P04 as unclosable: "that residue cannot be
// closed by ordering, because closing it needs a lock the server does not offer for `CREATE
// DATABASE`". THAT WAS FACTUALLY WRONG. The prohibition it was remembering is
//
//     ERROR:  25001: CREATE DATABASE cannot run inside a transaction block
//
// which is about TRANSACTIONS, not about locks. `pg_advisory_lock(ns, id)` is SESSION-scoped, is
// taken and released outside any transaction, and — verified against PostgreSQL 17.11 on this
// host — is still held after a `CREATE DATABASE` runs on that very session, while a second
// session's `pg_try_advisory_lock` on the same key returns false throughout.
//
// So the residue is closed, and it is closed by a lock held on a SEPARATE maintenance session:
// one taken on the connection that issues the CREATE would be freed by the very death that opens
// the window. What the lock cannot exclude is a creator that does not take it, and that is what
// the CONNECTION LIMIT ownership stamp answers.
//
// AND THE WIRE HAD TO CHANGE BEFORE ANY OF THIS COULD BE PROVED. r8's `loseCreateResponse`
// applied only after a SUCCESSFUL create, so "another provisioner won AND the response was lost"
// was not expressible on it — a proof that cannot state the failure it claims to cover.
// ===========================================================================================

test('r9 HIGH: the provisioning lock EXCLUDES a second provisioner — it never reaches the probe', async () => {
  resetWire()
  // Somebody else holds the lock for this exact name and has not let go.
  seedForeignLock(MINTED)

  const outcome = await capture({ label: 'alnkfence', mintName: () => MINTED, lockTimeoutMs: 5 })

  assert.ok(outcome instanceof ThrowawayDatabaseError, `expected a named refusal, got ${String(outcome)}`)
  assert.match(outcome.message, /could not take the provisioning lock/)
  assert.match(outcome.message, /NOTHING WAS CREATED/)

  // THE PRECONDITION: the lock really was attempted, so this is exclusion and not some earlier
  // refusal that happens to look the same.
  assert.equal(locks().length, 1, 'no attempt to take the provisioning lock was made')
  // THE FINDING: everything downstream of the lock is unreachable while somebody else holds it.
  // This is why a PARTICIPANT can no longer sit in the probe-to-CREATE gap.
  assert.deepEqual(wire.statements.filter((statement) => statement.startsWith('SELECT 1 FROM pg_database')), [])
  assert.deepEqual(creates(), [])
  assert.deepEqual(drops(), [])
  // And the foreign holder still holds it: a failed acquisition must not steal or clear a lock.
  assert.equal(
    wire.advisoryLocks.get(`${THROWAWAY_DATABASE_PROVISION_LOCK_NAMESPACE}/${provisionLockId(MINTED)}`),
    FOREIGN_BACKEND_PID,
  )
})

test('r9 HIGH: THE COMBINED RACE — another provisioner won AND the 42P04 was lost: no DROP', async () => {
  resetWire()
  // Both halves at once, which is the thing r8's wire could not express: a creator that does not
  // take the lock takes the name after our probe, AND the resulting 42P04 never reaches us.
  wire.createdByAnotherProvisionerAfterProbe = MINTED
  wire.loseCreateResponse = true

  const outcome = await capture({ label: 'alnkfence', mintName: () => MINTED })

  // PRECONDITIONS, so this cannot pass by never reaching the race.
  assert.equal(locks().length, 1, 'the provisioning lock was never taken, so nothing was made exclusive')
  assert.deepEqual(
    creates(),
    [`CREATE DATABASE "${MINTED}" CONNECTION LIMIT ${THROWAWAY_DATABASE_CONNECTION_LIMIT}`],
    'the CREATE never ran, so the lost 42P04 was never reached',
  )
  assert.ok(
    wire.statements.some((statement) => statement.startsWith('SELECT datconnlimit FROM pg_database')),
    'the cleanup never re-probed, so it decided without evidence',
  )

  // THE FINDING. The winner's database is untouched, and no DROP went down the wire at all.
  assert.deepEqual(drops(), [], 'the LOST 42P04 issued a DROP against the database another provisioner had just created')
  assert.deepEqual([...wire.databases.keys()], [MINTED])
  assert.equal(wire.databases.get(MINTED), -1, "the winner's database was modified by the loser")

  // And the refusal says WHY it did not drop: the stamp on the thing it found is not this
  // module's, so the thing it found was not created by this module.
  assert.ok(outcome instanceof ThrowawayDatabaseError, `expected a named refusal, got ${String(outcome)}`)
  assert.match(outcome.message, /CREATE had already been ISSUED/)
  assert.match(outcome.message, /whose CONNECTION LIMIT is -1, not the 4242/)
  assert.match(outcome.message, /SOMEBODY ELSE'S\. NOTHING WAS DROPPED/)
  assert.doesNotMatch(outcome.message, /reclaimed; nothing was left behind/)
})

test('r9 HIGH: if the LOCK SESSION itself died, nothing is dropped — the window was open', async () => {
  resetWire()
  // The lost-response case, except the lock session goes down with the create session. The
  // database that is there DOES carry this lane's stamp, so the stamp alone would say "drop it" —
  // and it must not, because between the lock dying and the cleanup running, any other
  // provisioner could have taken the name and stamped its own.
  wire.loseCreateResponse = true
  wire.killLockSessionWithCreateSession = true

  const outcome = await capture({ label: 'alnkfence', mintName: () => MINTED })

  assert.equal(locks().length, 1, 'the provisioning lock was never taken')
  assert.deepEqual(creates(), [`CREATE DATABASE "${MINTED}" CONNECTION LIMIT ${THROWAWAY_DATABASE_CONNECTION_LIMIT}`])
  // The stamp IS ours — which is exactly why this test is not vacuous: the only thing standing
  // between this database and a DROP is the lock check. Both ways of failing this line are named,
  // because they mean opposite things: still there but unstamped is a broken fixture, gone
  // altogether is the defect itself.
  assert.equal(
    wire.databases.get(MINTED),
    THROWAWAY_DATABASE_CONNECTION_LIMIT,
    wire.databases.has(MINTED)
      ? "the database left behind does not carry this lane's stamp, so this test is not about the lock"
      : 'the database was DROPPED — the cleanup decided it was this lane\'s with no held lock to say so',
  )
  assert.deepEqual(drops(), [], 'a cleanup with no lock still issued a DROP')
  assert.deepEqual([...wire.databases.keys()], [MINTED])

  assert.ok(outcome instanceof ThrowawayDatabaseError, `expected a named refusal, got ${String(outcome)}`)
  assert.match(outcome.message, /provisioning lock \d+\/\d+ was NO LONGER HELD/)
  assert.match(outcome.message, /NOTHING WAS DROPPED; if .* exists on the server it has to be/)
  assert.doesNotMatch(outcome.message, /reclaimed; nothing was left behind/)
})

test('r9: a CREATE that never reached the server leaves nothing, and the lock says so', async () => {
  resetWire()
  wire.loseCreateBeforeExecuting = true

  const outcome = await capture({ label: 'alnkfence', mintName: () => MINTED })

  assert.deepEqual(creates(), [`CREATE DATABASE "${MINTED}" CONNECTION LIMIT ${THROWAWAY_DATABASE_CONNECTION_LIMIT}`])
  assert.equal(wire.databases.size, 0, 'the fake executed a statement it was told never arrived')
  // A `DROP DATABASE IF EXISTS` here would be harmless, and it would still be a guess. Under the
  // still-held lock, absent means absent for the whole window, so there is nothing to guess at.
  assert.deepEqual(drops(), [], 'the cleanup dropped a name it had just proved was not there')
  assert.ok(outcome instanceof ThrowawayDatabaseError, `expected a named refusal, got ${String(outcome)}`)
  assert.match(outcome.message, /found no database called .* at all — the server never executed it/)
  assert.match(outcome.message, /NOTHING WAS DROPPED because there was nothing there/)
})

test('r9 LOW: a CREATE that SUCCEEDED and a teardown that failed still reclaims the database', async () => {
  // THE MUTATION THIS EXISTS FOR (Codex r9 LOW): `ownership = 'created'` after the CREATE
  // completes had no regression proof. Changing it to `'definitely-not-mine'` leaked the newly
  // created database and the whole suite still passed, because nothing made `client.end()` fail
  // after a successful CREATE — the migration-failure tests exercise the RETURNED handle's
  // separate cleanup path, which is reached only once provisioning has already succeeded.
  resetWire()
  wire.failEndAfterCreate = true

  const outcome = await capture({ label: 'alnkfence', mintName: () => MINTED })

  // PRECONDITION: the CREATE really did succeed and the database really was created, so the
  // failure under test is the teardown and nothing else.
  assert.deepEqual(creates(), [`CREATE DATABASE "${MINTED}" CONNECTION LIMIT ${THROWAWAY_DATABASE_CONNECTION_LIMIT}`])
  assert.ok(
    wire.statements.every((statement) => !statement.startsWith('SELECT datconnlimit')),
    'a COMPLETED create should not need re-probing: the server already answered',
  )

  // THE FINDING: it is reclaimed, and the wire says so.
  assert.deepEqual(drops(), [`DROP DATABASE IF EXISTS "${MINTED}" WITH (FORCE)`], 'a CREATE that succeeded and then failed to tear down leaked its database')
  assert.equal(wire.databases.size, 0, `the created database was left behind: ${[...wire.databases.keys()].join(', ')}`)

  assert.ok(outcome instanceof ThrowawayDatabaseError, `expected a named refusal, got ${String(outcome)}`)
  assert.match(outcome.message, /had already been ISSUED and had SUCCEEDED[\s\S]*reclaimed; nothing was left behind/)
})

test('r9: the provisioning lock is RELEASED on every exit, success and refusal alike', async () => {
  // A lock that outlived its provisioner would wedge the next lane on the same name for good, and
  // it is invisible until it happens. Each arm is a different exit from the function.
  for (const [arm, setup] of [
    ['migration failure', () => { /* migrateTimeoutMs does the work */ }],
    ['lost response', () => { wire.loseCreateResponse = true }],
    ['42P04', () => { wire.createdByAnotherProvisionerAfterProbe = MINTED }],
    ['already exists', () => { wire.databases.set(MINTED, -1) }],
  ] as const) {
    resetWire()
    setup()
    await capture({ label: 'alnkfence', mintName: () => MINTED, migrateTimeoutMs: 1 })
    assert.equal(locks().length, 1, `${arm}: the lock was not taken, so its release proves nothing`)
    assert.equal(wire.advisoryLocks.size, 0, `${arm}: the provisioning lock was still held on the way out`)
  }
})
