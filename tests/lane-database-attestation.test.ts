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
 *
 * =========================================================================================
 * ROUND 24 (Codex HIGH x2) — THE CAPABILITY NOW NAMES WHAT IT AUTHORISES.
 *
 * Round 22 was right that a lane database must be proved POSITIVELY. What it did not do is BIND
 * either proof to the thing it permitted, and Codex found both halves of that:
 *
 *   HIGH 1 — AN ATTESTATION WAS REPLAYABLE ACROSS UNRELATED CLIENTS. The mint checked that the
 *   attestation object was one this run produced and NOTHING ELSE. The `emailOutbox` and
 *   `emailSuppression` delegates arrived as separate arguments, so a throwaway-lane attestation
 *   paired with PRODUCTION delegates passed every check: a fake sender then drained the real queue
 *   and stamped real rows SENT, while the marker check was satisfied by a database nobody was
 *   talking to.
 *
 *   HIGH 2 — THE MARKER WRITER TOOK THE CALLER'S WORD FOR WHICH DATABASE. `createdDatabaseName` was
 *   a STRING, and its equality with `current_database()` proved the DESTINATION'S NAME — not that
 *   the caller had created the destination. `markLaneDatabase({ url: productionUrl,
 *   createdDatabaseName: 'onetwo3d_ims_dev' })` therefore wrote this run's secret INTO production
 *   and `attestLaneDatabase` minted a valid capability over it afterwards. The protected-name list
 *   lived one level up, in the throwaway helper, so the EXPORTED minting authority had none.
 *
 * BOTH ARE FIXED BY REMOVING THE PAIRING, NOT BY CHECKING IT. `createLaneDatabase` issues the
 * `CREATE DATABASE` itself and mints the only object `markLaneDatabase` accepts — and PostgreSQL
 * answers a CREATE on a name that exists with `42P04`, so no argument to it names an EXISTING
 * database and comes back with authority over one. `createEmailOutboxLaneClient` attests a
 * connection string and builds the delegates FROM THAT SAME STRING, so there is no second object to
 * swap. The `database` arm of the synchronous mint is gone.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { mock } from 'node:test'
import { fileURLToPath } from 'node:url'

// ===========================================================================================
// THE FAKE SERVER.
// ===========================================================================================

/** The database this whole guard exists to keep a harness off. */
const LIVE = 'onetwo3d_ims_dev'
const LANE = 'ims_throwaway_alnkfence_0123456789abcdef'
const url = (database: string, cluster = '127.0.0.1:5432') => `postgresql://ims:secret@${cluster}/${database}`
const maintenanceUrl = (cluster = '127.0.0.1:5432') => url('postgres', cluster)

const server = {
  /**
   * Backend database name -> the marker it carries.
   *   absent      — no `ims_lane_run_marker` table at all. THIS IS WHAT PRODUCTION LOOKS LIKE.
   *   `null`      — the table exists and holds no row.
   *   a string    — the table holds one row carrying that secret.
   */
  markers: new Map<string, string | null>(),
  /**
   * WHAT EXISTS ON EACH CLUSTER, keyed by `host:port`. `CREATE DATABASE` is answered against this
   * and nothing else, which is the whole reason r24's authority cannot be aimed at production: a
   * name that is here already comes back `42P04`, and a rejected CREATE mints nothing.
   */
  databases: new Map<string, Set<string>>(),
  /** `host:port` -> the instant that cluster booted, as `pg_postmaster_start_time()` renders it. */
  clusters: new Map<string, string>(),
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

/** The cluster every URL in these tests points at unless it says otherwise. */
const HOME = '127.0.0.1:5432'
/** A SECOND reachable Postgres. Only the cross-cluster proof uses it. */
const ELSEWHERE = '127.0.0.1:5433'

function resetServer(): void {
  server.markers.clear()
  server.databases.clear()
  server.clusters.clear()
  server.routes.clear()
  server.statements = []
  server.failConnect = false
  // PRODUCTION EXISTS. Every refusal below that turns on "that name is taken" is vacuous without
  // this line, so it is part of the reset rather than part of a test.
  server.databases.set(HOME, new Set([LIVE, 'postgres']))
  server.clusters.set(HOME, '2026-01-01 00:00:00.000001+00')
  server.databases.set(ELSEWHERE, new Set(['postgres']))
  server.clusters.set(ELSEWHERE, '2026-02-02 00:00:00.000002+00')
}

function databasesOn(cluster: string): Set<string> {
  const existing = server.databases.get(cluster)
  if (existing) return existing
  const fresh = new Set<string>()
  server.databases.set(cluster, fresh)
  return fresh
}

class FakePgClient {
  private readonly asked: string
  private readonly reached: string
  private readonly cluster: string

  constructor(config: { connectionString: string }) {
    const parsed = new URL(config.connectionString)
    this.asked = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
    this.reached = server.routes.get(this.asked) ?? this.asked
    this.cluster = `${parsed.hostname}:${parsed.port}`
  }

  async connect(): Promise<void> {
    if (server.failConnect) throw new Error('ECONNREFUSED 127.0.0.1:5432')
  }

  async query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    server.statements.push({ database: this.reached, text })
    const startedAt = server.clusters.get(this.cluster) ?? 'unknown cluster'

    // THE FACT HIGH B IS ABOUT: the SERVER answers with the backend it routed to, not with the
    // name the client asked for. And, since r24, WHICH SERVER answered.
    if (text.startsWith('SELECT current_database()')) {
      return { rows: [{ database: this.reached, cluster_started_at: startedAt }] }
    }
    if (text.startsWith('SELECT pg_postmaster_start_time()')) {
      return { rows: [{ cluster_started_at: startedAt }] }
    }

    if (text.startsWith('CREATE DATABASE')) {
      const name = /"((?:[^"]|"")*)"/.exec(text)?.[1].replace(/""/g, '"')
      if (name === undefined) throw new Error(`the fake server could not read a name out of: ${text}`)
      const here = databasesOn(this.cluster)
      // WHAT POSTGRESQL ACTUALLY DOES, with the SQLSTATE it actually sets. This one line is what
      // makes r24's authority unaimable at anything that already exists.
      if (here.has(name)) {
        throw Object.assign(new Error(`database "${name}" already exists`), { code: '42P04' })
      }
      here.add(name)
      return { rows: [] }
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

/**
 * MINT A LANE THE WAY THE SHIPPED PATH DOES: the module issues its own `CREATE DATABASE` and hands
 * back the creation that is the sole authority to mark. No test can build one by hand, which is the
 * property r24 is about.
 */
async function createLane(name: string = LANE, cluster: string = HOME) {
  const { createLaneDatabase } = await load()
  const result = await createLaneDatabase({ maintenanceUrl: maintenanceUrl(cluster), name })
  assert.equal(result.outcome, 'created', `the fixture could not create ${name}: ${JSON.stringify(result)}`)
  assert.ok(result.outcome === 'created')
  return result.creation
}

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

test('CONTROL: a database this run CREATED can be marked and attested', async () => {
  resetServer()
  const { markLaneDatabase, attestLaneDatabase, isLaneDatabaseAttestation } = await load()

  // The server has BOTH databases. Only one of them is this run's lane, and the difference is not
  // its name: it is that this process watched itself create it a statement ago.
  const creation = await createLane()
  await markLaneDatabase(creation, url(LANE))
  const attestation = await attestLaneDatabase(url(LANE))

  assert.equal(attestation.database, LANE)
  assert.ok(isLaneDatabaseAttestation(attestation))
  assert.ok(typeof server.markers.get(LANE) === 'string', 'the CONTROL never wrote a marker, so every refusal below is vacuous')
  assert.equal(server.markers.has(LIVE), false, 'the CONTROL marked the live database, which is the thing this file forbids')
})

test('CONTROL: attesting is READ-ONLY, so pointing it somewhere cannot MAKE that place attestable', async () => {
  // This is not tidiness. If the attestation wrote anything, aiming it at production would create
  // the very property it is checking for, and the guard would manufacture its own answer.
  resetServer()
  const { markLaneDatabase, attestLaneDatabase } = await load()
  await markLaneDatabase(await createLane(), url(LANE))
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
// r24 HIGH 2 — THE MINTING AUTHORITY CANNOT BE AIMED AT PRODUCTION, AND NOT BECAUSE IT KNOWS ITS
// NAME.
// ===========================================================================================

test('r24 HIGH 2: markLaneDatabase refuses the configured production database, correctly named', async () => {
  // THE FINDING, EXACTLY. Round 22's writer took `createdDatabaseName` — a STRING — and wrote the
  // marker if `current_database()` equalled it. A caller who named production CORRECTLY therefore
  // got this run's secret written INTO production, and `attestLaneDatabase` minted a valid
  // capability over it on the next line. The protected-name list lived in the throwaway helper, one
  // level above, so the EXPORTED function had none.
  //
  // MUTATION ROUTE: in lib/lane-database-attestation.ts, drop the `isLaneDatabaseCreation(creation)`
  // guard at the top of `markLaneDatabase` (or make it `if (false)`). The first arm below then walks
  // straight through and production is marked.
  resetServer()
  const { markLaneDatabase, createLaneDatabase, attestLaneDatabase } = await load()

  // 1. A hand-built creation naming production. This is round 22's call, written in r24's shape.
  await assert.rejects(
    () => markLaneDatabase({ database: LIVE } as never, url(LIVE)),
    /not a creation this run minted/,
    'a plain object naming production was accepted as authority over it',
  )

  // 2. ASKING FOR THE AUTHORITY DIRECTLY. This is the route a caller would take now, and the refusal
  //    is PostgreSQL's, not a list of ours: production EXISTS, so its CREATE is rejected `42P04`.
  const aimed = await createLaneDatabase({ maintenanceUrl: maintenanceUrl(), name: LIVE })
  assert.notEqual(aimed.outcome, 'created', 'CREATE DATABASE on an existing database minted authority over it')
  assert.ok(aimed.outcome !== 'created' && aimed.outcome !== 'created-but-failed')
  assert.equal((aimed.error as { code?: string }).code, '42P04', `expected duplicate_database, got ${String(aimed.error)}`)

  // 3. A REAL creation, re-pointed. The one thing a caller genuinely holds cannot be spent
  //    elsewhere, because the mark asks the destination who it is.
  const lane = await createLane()
  await assert.rejects(
    () => markLaneDatabase(lane, url(LIVE)),
    new RegExp(`this connection reaches ${LIVE}, not ${LANE}`),
    'a lane creation was spent on production',
  )

  // 4. And copies of a real creation are not creations.
  for (const [why, forgery] of [
    ['a spread', { ...(lane as unknown as object) }],
    ['a frozen copy', Object.freeze({ database: LANE })],
    ['a Proxy', new Proxy(lane as unknown as object, {})],
    ['nothing at all', undefined],
    ['null', null],
  ] as [string, unknown][]) {
    await assert.rejects(
      () => markLaneDatabase(forgery as never, url(LANE)),
      /not a creation this run minted/,
      `the marker writer accepted ${why}`,
    )
  }

  // THE POINT OF ALL FOUR: production carries no marker, so nothing can attest it.
  assert.equal(server.markers.has(LIVE), false, 'this run wrote its secret into the live database')
  await assert.rejects(() => attestLaneDatabase(url(LIVE)), /does not carry a readable ims_lane_run_marker/)
})

test('r24 HIGH 2: a creation is pinned to the CLUSTER it was made on, not to the name it carries', async () => {
  // A database NAME is unique within one cluster and nowhere else. Without the cluster pin, a
  // creation of `onetwo3d_ims_dev` on a SECOND reachable Postgres — where that name is free —
  // would license marking the live database of that name on THIS one.
  //
  // MUTATION ROUTE: delete the `reached.clusterStartedAt !== createdOnCluster` branch in
  // `markLaneDatabase`. The mark below then lands on the live database.
  resetServer()
  const { markLaneDatabase } = await load()

  const elsewhere = await createLane(LIVE, ELSEWHERE)
  assert.ok(server.databases.get(ELSEWHERE)?.has(LIVE), 'PRECONDITION: the second cluster really took that name')

  await assert.rejects(
    () => markLaneDatabase(elsewhere, url(LIVE)),
    /is on a DIFFERENT server from the one this run created/,
    'a creation made on another cluster licensed a mark on this one',
  )
  assert.equal(server.markers.has(LIVE), false, 'the live database was marked through a same-named database elsewhere')
})

// ===========================================================================================
// r24 HIGH 1 — THE CAPABILITY AND ITS SUBJECT ARE MADE TOGETHER, SO THEY CANNOT BE RECOMBINED.
// ===========================================================================================

test('r24 HIGH 1: a lane attestation cannot be paired with production delegates', async () => {
  // THE FINDING, EXACTLY. `createEmailOutboxHarnessClient` checked that `writesTo.attestation` was
  // one this run minted and NOTHING about the delegates beside it. So a throwaway-lane attestation
  // and PRODUCTION delegates passed together, and the drain — a SWEEP over the globally oldest
  // queued customer emails — claimed real rows, delivered nothing through the harness's fake sender,
  // and stamped them SENT. The marker check was satisfied by a database nobody was talking to.
  //
  // MUTATION ROUTE: restore the `database` arm in `createEmailOutboxHarnessClient` (accept
  // `writesTo: { kind: 'database', attestation }` when `isLaneDatabaseAttestation(attestation)`).
  // The first assertion below then mints a client over production delegates.
  resetServer()
  const { markLaneDatabase, attestLaneDatabase } = await load()
  const { createEmailOutboxHarnessClient, createEmailOutboxLaneClient } = await loadOutbox()

  await markLaneDatabase(await createLane(), url(LANE))
  const attestation = await attestLaneDatabase(url(LANE))
  assert.equal(attestation.database, LANE, 'PRECONDITION: the lane really did attest')

  // 1. THE PAIRING IS NOT A CALL ANYONE CAN WRITE ANY MORE. `delegates()` stands in for
  //    `db.emailOutbox`/`db.emailSuppression`: production's, reaching the real queue.
  assert.throws(
    () => createEmailOutboxHarnessClient({
      ...delegates(),
      writesTo: { kind: 'database', attestation } as unknown as { kind: 'in-memory' },
    }),
    /`writesTo` says `database`, and this function no longer mints that/,
    'a lane attestation minted a client over production delegates',
  )

  // 2. AND THE ROUTE THAT REPLACED IT CANNOT BE POINTED AT PRODUCTION EITHER — even here, where a
  //    lane attestation demonstrably exists in this very process.
  await assert.rejects(
    () => createEmailOutboxLaneClient({ url: url(LIVE) }),
    /does not carry a readable ims_lane_run_marker/,
    'the lane client was built over the live database',
  )

  // 3. NON-VACUITY. The same call against the LANE gets PAST the attestation — it fails later, at
  //    the Prisma adapter, because `pg` is a fake here and there is no `Pool` on it. If it were
  //    refused for the same reason as (2), (2) would be proving nothing.
  await assert.rejects(
    () => createEmailOutboxLaneClient({ url: url(LANE) }),
    (error: Error) => {
      assert.doesNotMatch(
        error.message,
        /does not carry a readable ims_lane_run_marker|is not an attestation/,
        'the LANE was refused by the attestation too, so the refusal above is not about the destination',
      )
      return true
    },
  )
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
    await markLaneDatabase(await createLane(), url(LANE))
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
  // whose URL is routed to production would put this run's secret INTO production and everything
  // afterwards would be correct about a database that is not a lane.
  resetServer()
  const { markLaneDatabase } = await load()
  const creation = await createLane()
  // The route is set AFTER the CREATE, so this is a genuine lane whose connection string later
  // lands somewhere else — which is exactly what a pooler reconfiguration does.
  server.routes.set(LANE, LIVE)

  await assert.rejects(
    () => markLaneDatabase(creation, url(LANE)),
    new RegExp(`this connection reaches ${LIVE}, not ${LANE}`),
  )
  assert.equal(server.markers.has(LIVE), false, 'the refused mark still wrote a marker into the live database')
})

test('r22 HIGH B: two unequal startup names reaching ONE marked backend give ONE backend identity', async () => {
  // The other side of the pooler: a lane reached under two names is still one database, and the
  // attestation says so — because the name it records is the one the SERVER gave, not the one the
  // URL asked for. A name comparison had no way to notice this at all.
  resetServer()
  const { markLaneDatabase, attestLaneDatabase } = await load()
  await markLaneDatabase(await createLane(), url(LANE))
  server.routes.set('lane_alias', LANE)

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
  const creation = await createLane()
  await markLaneDatabase(creation, url(LANE))
  await assert.rejects(
    () => markLaneDatabase(creation, url(LANE)),
    /could not create ims_lane_run_marker/,
  )
})

test('r24: a CREATE that the server never answered mints nothing', async () => {
  // The third outcome, and the one that must not mint: an issued statement whose answer was lost is
  // not a database this process knows it created.
  resetServer()
  const { createLaneDatabase, markLaneDatabase } = await load()
  server.failConnect = true
  const lost = await createLaneDatabase({ maintenanceUrl: maintenanceUrl(), name: LANE })
  server.failConnect = false

  assert.equal(lost.outcome, 'not-created')
  await assert.rejects(
    () => markLaneDatabase({ database: LANE } as never, url(LANE)),
    /not a creation this run minted/,
  )
})

// ===========================================================================================
// THE MINT — a `database` destination is not a shape this function has any more.
// ===========================================================================================

test('r24: the synchronous mint refuses every `database` destination, attested or not', async () => {
  resetServer()
  const { markLaneDatabase, attestLaneDatabase } = await load()
  const { createEmailOutboxHarnessClient } = await loadOutbox()

  await markLaneDatabase(await createLane(), url(LANE))
  const real = await attestLaneDatabase(url(LANE))

  const mint = (attestation: unknown) => createEmailOutboxHarnessClient({
    ...delegates(),
    writesTo: { kind: 'database', attestation } as unknown as { kind: 'in-memory' },
  })

  // The REAL one first, because that is the r24 finding: a genuine capability over a lane, spent on
  // delegates nobody checked. If this line ever mints again, the replay is back.
  for (const [why, attestation] of [
    ['a genuine attestation over a real lane — the r24 HIGH itself', real],
    ['a hand-built object with the same shape', { database: LANE }],
    ['a SPREAD of a real attestation', { ...real }],
    ['a Proxy wrapping a real attestation', new Proxy(real, {})],
    ['a URL, which is what this arm used to take', url(LANE)],
    ['nothing at all', undefined],
    ['null', null],
  ] as [string, unknown][]) {
    assert.throws(
      () => mint(attestation),
      /`writesTo` says `database`, and this function no longer mints that/,
      `the mint accepted ${why}`,
    )
  }

  // AND IN-MEMORY STILL MINTS, so the refusals above are about the arm and not about the function.
  assert.ok(createEmailOutboxHarnessClient({ ...delegates(), writesTo: { kind: 'in-memory' } }))
})
