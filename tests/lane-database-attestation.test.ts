/**
 * o3d-alnk r22 (Codex HIGH x2) — A LANE DATABASE IS ONE THIS RUN MARKED, AND THE SERVER IS WHAT
 * SAYS SO.
 *
 * WHAT THESE PROOFS ARE ABOUT. Rounds 18 to 21 decided whether a harness client could be minted
 * over a `database` destination by RESOLVING two URLs to database NAMES and comparing them. Round
 * 21 closed that approach with two findings:
 *
 *   HIGH A — when `DATABASE_URL` is UNSET OR EMPTY there is no name on the configured side, so the
 *   comparison was SKIPPED. The application's own pool still connects in that state (`PGDATABASE`,
 *   `PGUSER`, the OS user), so a client on the LIVE queue was mintable with no `DATABASE_URL` at all.
 *
 *   HIGH B — `PgClient.database` is the STARTUP database name the client ASKS for. A connection
 *   pooler maps a configured alias onto a backend database of a different name, so two URLs that
 *   reach THE SAME QUEUE compare UNEQUAL and the mint accepts one of them.
 *
 * Both are properties of comparing names, and neither has a last case — which is why this round
 * stops comparing and starts ASKING. The tests below are therefore mostly about what is REFUSED
 * when nothing is known, with named CONTROL arms so that "everything is refused" cannot pass for a
 * guard.
 *
 * THE POOLER IS MODELLED, AND THIS SENTENCE IS THE DISCLOSURE. There is no pooler in `npm run
 * test:unit` and there is no Postgres either: `pg` is module-mocked to a fake server that holds
 * databases, their markers, and a ROUTING TABLE from the startup name a client asks for to the
 * backend database it actually reaches. That routing table is the whole of the model. It is
 * faithful to the one property HIGH B turns on — a client's `database` field and
 * `current_database()` can disagree — and it models nothing else about a pooler, because nothing
 * else is load-bearing here.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { mock } from 'node:test'
import { fileURLToPath } from 'node:url'

// ===========================================================================================
// THE FAKE SERVER.
// ===========================================================================================

const server = {
  /**
   * Backend database name -> the marker it carries.
   *   absent      — no `ims_lane_run_marker` table at all. THIS IS WHAT PRODUCTION LOOKS LIKE.
   *   `null`      — the table exists and holds no row.
   *   a string    — the table holds one row carrying that secret.
   */
  markers: new Map<string, string | null>(),
  /**
   * THE POOLER. Startup database name (what the URL asks for) -> the backend database the
   * connection actually reaches. A name absent from here reaches itself, which is a direct
   * connection.
   */
  routes: new Map<string, string>(),
  /** Every statement, with the backend it was executed against. */
  statements: [] as { database: string; text: string }[],
  failConnect: false,
}

function resetServer(): void {
  server.markers.clear()
  server.routes.clear()
  server.statements = []
  server.failConnect = false
}

class FakePgClient {
  private readonly asked: string
  private readonly reached: string

  constructor(config: { connectionString: string }) {
    this.asked = decodeURIComponent(new URL(config.connectionString).pathname.replace(/^\//, ''))
    this.reached = server.routes.get(this.asked) ?? this.asked
  }

  async connect(): Promise<void> {
    if (server.failConnect) throw new Error('ECONNREFUSED 127.0.0.1:5432')
  }

  async query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    server.statements.push({ database: this.reached, text })

    // THE FACT HIGH B IS ABOUT: the SERVER answers with the backend it routed to, not with the
    // name the client asked for.
    if (text.startsWith('SELECT current_database()')) {
      return { rows: [{ database: this.reached }] }
    }

    if (text.startsWith('CREATE TABLE "ims_lane_run_marker"')) {
      if (server.markers.has(this.reached)) {
        throw Object.assign(new Error('relation "ims_lane_run_marker" already exists'), { code: '42P07' })
      }
      server.markers.set(this.reached, null)
      return { rows: [] }
    }

    if (text.startsWith('INSERT INTO "ims_lane_run_marker"')) {
      if (!server.markers.has(this.reached)) {
        throw Object.assign(new Error('relation "ims_lane_run_marker" does not exist'), { code: '42P01' })
      }
      server.markers.set(this.reached, String((values ?? [])[0]))
      return { rows: [] }
    }

    if (text.startsWith('SELECT secret FROM "ims_lane_run_marker"')) {
      if (!server.markers.has(this.reached)) {
        throw Object.assign(new Error('relation "ims_lane_run_marker" does not exist'), { code: '42P01' })
      }
      const secret = server.markers.get(this.reached)
      return { rows: secret === null ? [] : [{ secret }] }
    }

    throw new Error(`the fake server was asked for an unmodelled statement: ${text}`)
  }

  async end(): Promise<void> {
    // nothing to release
  }
}

mock.module('pg', { defaultExport: { Client: FakePgClient } })

const load = () => import('@/lib/lane-database-attestation')
const loadOutbox = () => import('@/lib/email-outbox')

/** The database this whole guard exists to keep a harness off. */
const LIVE = 'onetwo3d_ims_dev'
const LANE = 'ims_throwaway_alnkfence_0123456789abcdef'
const url = (database: string) => `postgresql://ims:secret@127.0.0.1:5432/${database}`

/** Run `body` with `DATABASE_URL` in a stated state, and restore it afterwards. */
async function withDatabaseUrl(value: string | undefined, body: () => Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_URL
  try {
    if (value === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = value
    await body()
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous
  }
}

/** The delegates a harness client carries. Never reached by these tests. */
function delegates(): {
  emailOutbox: import('@/lib/email-outbox').EmailOutboxClient['emailOutbox']
  emailSuppression: import('@/lib/email-outbox').EmailOutboxClient['emailSuppression']
} {
  const record = (name: string) => async (): Promise<never> => {
    throw new Error(`the guard did not fire: ${name} was issued`)
  }
  return {
    emailOutbox: {
      findMany: record('emailOutbox.findMany'),
      updateMany: record('emailOutbox.updateMany'),
      create: record('emailOutbox.create'),
    },
    emailSuppression: {
      findUnique: record('emailSuppression.findUnique'),
      upsert: record('emailSuppression.upsert'),
    },
  } as unknown as {
    emailOutbox: import('@/lib/email-outbox').EmailOutboxClient['emailOutbox']
    emailSuppression: import('@/lib/email-outbox').EmailOutboxClient['emailSuppression']
  }
}

// ===========================================================================================
// CONTROL — the happy path, first, so nothing below can pass by refusing everything.
// ===========================================================================================

test('CONTROL: a database this run marked attests, and the attestation mints a harness client', async () => {
  resetServer()
  const { markLaneDatabase, attestLaneDatabase, isLaneDatabaseAttestation } = await load()
  const { createEmailOutboxHarnessClient } = await loadOutbox()

  // The server has BOTH databases. Only one of them is this run's lane.
  server.markers.delete(LIVE)

  await markLaneDatabase({ url: url(LANE), createdDatabaseName: LANE })
  const attestation = await attestLaneDatabase(url(LANE))

  assert.equal(attestation.database, LANE)
  assert.ok(isLaneDatabaseAttestation(attestation))

  const client = createEmailOutboxHarnessClient({
    ...delegates(),
    writesTo: { kind: 'database', attestation },
  })
  assert.ok(client, 'the mint refused an attestation this run produced, so every refusal below is vacuous')
})

test('CONTROL: attesting is READ-ONLY, so pointing it somewhere cannot MAKE that place attestable', async () => {
  // This is not tidiness. If the attestation wrote anything, aiming it at production would create
  // the very property it is checking for, and the guard would manufacture its own answer.
  resetServer()
  const { markLaneDatabase, attestLaneDatabase } = await load()
  await markLaneDatabase({ url: url(LANE), createdDatabaseName: LANE })
  server.statements = []
  await attestLaneDatabase(url(LANE))

  assert.ok(server.statements.length > 0, 'the attestation issued no statements, so it asked the server nothing')
  for (const statement of server.statements) {
    assert.match(
      statement.text,
      /^SELECT /,
      `attestLaneDatabase issued a non-SELECT (${statement.text}); a guard that writes creates what it checks for`,
    )
  }
})

// ===========================================================================================
// HIGH A — `DATABASE_URL` IS NOT PART OF THE ANSWER, SO IT CANNOT SKIP ONE.
// ===========================================================================================

test('r22 HIGH A: the LIVE database is refused with DATABASE_URL unset, empty, or unparseable', async () => {
  // The round-21 finding exactly. The old check compared `writesTo.url`'s database with the one
  // `DATABASE_URL` names, and SKIPPED the comparison when there was nothing on the configured side
  // — while the app's own pool still connects through `PGDATABASE`, `PGUSER` or the OS user. Every
  // state below is one the old check passed the live queue in.
  for (const configured of [undefined, '', '   ', 'not a url at all']) {
    resetServer()
    const { attestLaneDatabase } = await load()
    // Production exists and has no marker, because nothing marked it. That is the whole reason.
    await withDatabaseUrl(configured, async () => {
      await assert.rejects(
        () => attestLaneDatabase(url(LIVE)),
        (error: Error) => {
          assert.match(error.message, /does not carry a readable ims_lane_run_marker/)
          assert.match(error.message, new RegExp(`REACHES \\(${LIVE}\\)`))
          return true
        },
        `the live database was attested with DATABASE_URL = ${JSON.stringify(configured)}`,
      )
    })
  }
})

test('r22 HIGH A: a LANE still attests with DATABASE_URL unset, so the refusal above is not the env', async () => {
  // NON-VACUITY for the table above, and the other half of the same claim: the answer does not
  // depend on `DATABASE_URL` in EITHER direction.
  resetServer()
  const { markLaneDatabase, attestLaneDatabase } = await load()
  await withDatabaseUrl(undefined, async () => {
    await markLaneDatabase({ url: url(LANE), createdDatabaseName: LANE })
    const attestation = await attestLaneDatabase(url(LANE))
    assert.equal(attestation.database, LANE)
  })
})

test('r22 HIGH A: neither the attestation nor the mint reads DATABASE_URL at all', async () => {
  // The structural half. "It happens not to matter today" is a property of the current branches;
  // "the name is not in the code" is a property of the module. Comments are stripped first, because
  // both files discuss `DATABASE_URL` at length in prose and that is not a read.
  const repoRoot = fileURLToPath(new URL('../', import.meta.url))
  const withoutComments = (relative: string) => readFileSync(`${repoRoot}${relative}`, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  for (const relative of ['lib/lane-database-attestation.ts', 'lib/email-outbox.ts']) {
    const code = withoutComments(relative)
    assert.ok(code.length > 500, `${relative}: the comment stripper ate the file, so this checks nothing`)
    assert.doesNotMatch(
      code,
      /DATABASE_URL/,
      `${relative} reads DATABASE_URL again — an unset or empty one is exactly what round 21 walked through`,
    )
  }
})

// ===========================================================================================
// HIGH B — A POOLER (MODELLED). THE STARTUP NAME IS A REQUEST; `current_database()` IS THE ANSWER.
// ===========================================================================================

test('r22 HIGH B: an alias a pooler routes to the LIVE database is refused, and the refusal names the BACKEND', async () => {
  // THE MODEL, stated: `lane_alias` is a name a client may ask for, and the routing table sends it
  // to the live database. That is the one property HIGH B rests on — a client's startup database
  // name and the backend it reaches can differ — and the fake models nothing else about a pooler.
  //
  // Under the round-21 check this passed: `lane_alias` !== `onetwo3d_ims_dev`, so a REAL client
  // over the live queue was minted. Here it is refused, because the queue it reaches carries no
  // marker — and the refusal names `onetwo3d_ims_dev`, the database that actually answered.
  resetServer()
  server.routes.set('lane_alias', LIVE)
  const { attestLaneDatabase } = await load()

  await assert.rejects(
    () => attestLaneDatabase(url('lane_alias')),
    (error: Error) => {
      assert.match(error.message, new RegExp(`REACHES \\(${LIVE}\\)`))
      assert.doesNotMatch(error.message, /REACHES \(lane_alias\)/)
      return true
    },
  )
})

test('r22 HIGH B: a pooler alias cannot be MARKED either, so the marker cannot be walked into production', async () => {
  // The write side of the same fact. If marking followed the name the caller asked for, a lane
  // whose alias routes to production would put this run's secret INTO production and everything
  // afterwards would be correct about a database that is not a lane.
  resetServer()
  server.routes.set('lane_alias', LIVE)
  const { markLaneDatabase } = await load()

  await assert.rejects(
    () => markLaneDatabase({ url: url('lane_alias'), createdDatabaseName: 'lane_alias' }),
    (error: Error) => {
      assert.match(error.message, new RegExp(`this connection reaches ${LIVE}, not lane_alias`))
      return true
    },
  )
  assert.equal(server.markers.has(LIVE), false, 'the refused mark still wrote a marker into the live database')
})

test('r22 HIGH B: two unequal startup names reaching ONE marked backend give ONE backend identity', async () => {
  // The other side of the pooler: a lane reached under two names is still one database, and the
  // attestation says so — because the name it records is the one the SERVER gave, not the one the
  // URL asked for. A name comparison had no way to notice this at all.
  resetServer()
  server.routes.set('lane_alias', LANE)
  const { markLaneDatabase, attestLaneDatabase } = await load()

  await markLaneDatabase({ url: url(LANE), createdDatabaseName: LANE })
  const direct = await attestLaneDatabase(url(LANE))
  const viaPooler = await attestLaneDatabase(url('lane_alias'))

  assert.equal(direct.database, LANE)
  assert.equal(viaPooler.database, LANE, 'the attestation recorded the name the client asked for, not the one it reached')
})

// ===========================================================================================
// WHAT ELSE IS REFUSED — each for the same single reason, not as its own case.
// ===========================================================================================

test('r22: a marker from ANOTHER run is not this run\'s evidence', async () => {
  resetServer()
  const { attestLaneDatabase } = await load()
  // A database that carries a perfectly well-formed marker — written by some other process.
  server.markers.set(LANE, 'a'.repeat(64))

  await assert.rejects(
    () => attestLaneDatabase(url(LANE)),
    /carries a lane marker THIS RUN DID NOT WRITE/,
  )
})

test('r22: an empty marker table, an unreachable server and an unusable URL are all refusals', async () => {
  resetServer()
  const { attestLaneDatabase } = await load()

  // The table is there and holds no row: nothing establishes which run created this.
  server.markers.set(LANE, null)
  await assert.rejects(() => attestLaneDatabase(url(LANE)), /carries 0 marker rows, not 1/)

  // A destination that never answered has not answered the question.
  server.markers.set(LANE, 'ignored')
  server.failConnect = true
  await assert.rejects(() => attestLaneDatabase(url(LANE)), /could not connect/)
  server.failConnect = false

  // And no string at all is not a destination.
  await assert.rejects(() => attestLaneDatabase(''), /a connection string is required/)
})

test('r22: marking refuses a database that is ALREADY marked', async () => {
  // A database carrying a marker is not one this call has just created, whoever wrote the marker.
  resetServer()
  const { markLaneDatabase } = await load()
  await markLaneDatabase({ url: url(LANE), createdDatabaseName: LANE })
  await assert.rejects(
    () => markLaneDatabase({ url: url(LANE), createdDatabaseName: LANE }),
    /could not create ims_lane_run_marker/,
  )
})

// ===========================================================================================
// THE MINT — the attestation is a CAPABILITY, not a shape.
// ===========================================================================================

test('r22: the mint accepts an attestation and nothing that merely looks like one', async () => {
  resetServer()
  const { markLaneDatabase, attestLaneDatabase } = await load()
  const { createEmailOutboxHarnessClient } = await loadOutbox()

  await markLaneDatabase({ url: url(LANE), createdDatabaseName: LANE })
  const real = await attestLaneDatabase(url(LANE))

  const mint = (attestation: unknown) => createEmailOutboxHarnessClient({
    ...delegates(),
    writesTo: { kind: 'database', attestation } as unknown as { kind: 'database'; attestation: typeof real },
  })

  // The real one, so the refusals below are about the ARGUMENT and not about the arm.
  assert.ok(mint(real))

  const forgeries: [string, unknown][] = [
    ['a hand-built object with the same shape', { database: LANE }],
    ['a SPREAD of a real attestation — a different object, so not in the register', { ...real }],
    ['a frozen copy', Object.freeze({ database: real.database })],
    ['a Proxy wrapping a real attestation', new Proxy(real, {})],
    ['a URL, which is what this arm used to take', url(LANE)],
    ['nothing at all', undefined],
    ['null', null],
  ]
  for (const [why, forgery] of forgeries) {
    assert.throws(
      () => mint(forgery),
      /`writesTo\.attestation` is not an attestation this run minted/,
      `the mint accepted ${why}`,
    )
  }
})
