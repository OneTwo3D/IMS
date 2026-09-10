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

import {
  PROTECTED_DATABASE_NAMES,
  THROWAWAY_DATABASE_NAME_RE,
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

/** The fake server. `databases` is the state every assertion below is about. */
const wire = {
  databases: new Set<string>(),
  connections: 0,
  statements: [] as string[],
  /** The defect: the server executes the CREATE, the client never hears about it. */
  loseCreateResponse: false,
  /** The unrecoverable variant: the reclaiming DROP cannot be delivered either. */
  failDrop: false,
}

function resetWire(): void {
  wire.databases.clear()
  wire.connections = 0
  wire.statements = []
  wire.loseCreateResponse = false
  wire.failDrop = false
}

/** `CREATE DATABASE "x"` / `DROP DATABASE IF EXISTS "x" WITH (FORCE)` -> `x`. */
function quotedName(statement: string): string {
  const match = /"((?:[^"]|"")*)"/.exec(statement)
  if (!match) throw new Error(`the fake server could not find a quoted name in: ${statement}`)
  return match[1].replace(/""/g, '"')
}

class FakeMaintenanceClient {
  constructor(_config: { connectionString: string }) { void _config }

  async connect(): Promise<void> {
    wire.connections += 1
  }

  async query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    wire.statements.push(text)
    if (text.startsWith('SELECT 1 FROM pg_database')) {
      const name = String((values ?? [])[0])
      return { rows: wire.databases.has(name) ? [{ exists: 1 }] : [] }
    }
    if (text.startsWith('CREATE DATABASE')) {
      // THE SERVER DOES THE WORK EITHER WAY. That is the entire finding: the database exists
      // whether or not the client survives long enough to be told.
      wire.databases.add(quotedName(text))
      if (wire.loseCreateResponse) throw new Error('Connection terminated unexpectedly')
      return { rows: [] }
    }
    if (text.startsWith('DROP DATABASE')) {
      if (wire.failDrop) throw new Error('Connection terminated unexpectedly')
      wire.databases.delete(quotedName(text))
      return { rows: [] }
    }
    throw new Error(`the fake server was asked for an unmodelled statement: ${text}`)
  }

  async end(): Promise<void> {}
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
  assert.ok(
    wire.statements.some((statement) => statement.startsWith('CREATE DATABASE')),
    'the fake server was never asked to create anything',
  )
  assert.ok(
    wire.statements.some((statement) => statement.startsWith('DROP DATABASE')),
    'the migration-failure cleanup issued no DROP',
  )
  assert.equal(wire.databases.size, 0, `the migration-failure cleanup left ${[...wire.databases].join(', ')} behind`)
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
    `a lost CREATE response left ${[...wire.databases].join(', ')} on the server`,
  )
  // And the reclaim used a SECOND, FRESH connection: the one that issued the CREATE is the one
  // that just died, so a cleanup routed through it would be no cleanup at all.
  assert.equal(wire.connections, 2, `the reclaim did not open its own connection (${wire.connections} in total)`)
  assert.deepEqual(
    wire.statements.filter((statement) => statement.startsWith('DROP DATABASE')),
    [`DROP DATABASE IF EXISTS "${MINTED}" WITH (FORCE)`],
  )
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
  assert.deepEqual([...wire.databases], [MINTED])
  wire.databases.clear()
})

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

  // THE CLEANUP IS KEYED ON "THE CREATE WAS ISSUED", and it was not. A cleanup keyed on the NAME
  // instead would drop exactly the database this refusal exists to protect.
  assert.deepEqual([...wire.databases], [MINTED], 'the already-exists refusal dropped somebody else\'s database')
  assert.deepEqual(wire.statements.filter((statement) => statement.startsWith('DROP DATABASE')), [])
  assert.ok(!wire.statements.some((statement) => statement.startsWith('CREATE DATABASE')))
})
