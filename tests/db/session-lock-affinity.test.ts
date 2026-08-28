import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import net from 'node:net'
import test, { type TestContext } from 'node:test'

import { parse as parseDotenv } from 'dotenv'
import pg from 'pg'

import {
  DatabaseUrlSchemaConflictError,
  SESSION_LOCK_DATABASE_URL_ENV,
  SESSION_LOCK_SPACE_PROBE_NAMESPACE,
  establishStartupOptionByteSafety,
  pgConnectionConfig,
  pgSessionLockConnectionConfig,
  resetSessionLockSpaceMeasurements,
  resetStartupOptionByteSafety,
  sessionLockSpaceReestablisher,
} from '../../lib/db/database-url-schema.mjs'
import { boundLockAcquisition, gateOnFreshLockSpace } from '../../lib/db/session-lock-pool'

/**
 * o3d-2k5r r25, Codex HIGH — o3d-a5zz: THE AFFINITY CHECK IS A PROPERTY OF TAKING A SESSION LOCK,
 * NOT OF THE SCHEMA'S CHARACTER SET.
 *
 * r24 measured the hazard rather than reasoning about it: Odyssey 1.5.3-rc1 in `pool "transaction"`
 * mode in front of PostgreSQL 17 let TWO clients each acquire `pg_try_advisory_lock(4242)` and
 * showed the first client ZERO advisory locks the statement after it "acquired" one. r24 then
 * refused an interposed connection — but only on the path that carries a non-ASCII startup option,
 * because that is where a deployment VERDICT is spent. Every ordinary (ASCII) deployment attached
 * no check at all, so `withMoneyPostLock` — the exclusion across a ledger read and an EXTERNAL
 * MONEY POST — could be held by nobody, silently, and two workers could each pay the same document.
 *
 * These tests are about the two halves of the fix, and each names the mutation that re-breaks it:
 *   • an ASCII-schema LOCK pool reaching an interposed connection is REFUSED, live, through a real
 *     TCP relay in front of the real PostgreSQL;
 *   • an ASCII-schema DATA pool still pays NOTHING — no hook, no round trip — through that same
 *     relay, which is why the exemption existed and why it is kept where it belongs.
 *
 * WHAT THESE DO NOT CLAIM. Proving the connection is not interposed proves the session that took
 * the lock is the session that keeps it. It does not make a session advisory lock DURABLE: the lock
 * still dies with its connection. That is o3d-ic9a, and it stands on its own merits.
 */

const ASCII_SCHEMA = 'public'

function configuredDatabaseUrl(): string | null {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  for (const file of ['../../.env.local', '../../.env']) {
    try {
      const parsed = parseDotenv(readFileSync(new URL(file, import.meta.url)))
      if (parsed.DATABASE_URL) return parsed.DATABASE_URL
    } catch { /* absent or unreadable: try the next one */ }
  }
  return null
}

/** Run `body` with DATABASE_URL set to `url`, and put the environment back afterwards. */
async function withDatabaseUrl(url: string, body: () => Promise<void>): Promise<void> {
  const before = process.env.DATABASE_URL
  process.env.DATABASE_URL = url
  try {
    await body()
  } finally {
    if (before === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = before
  }
}

/**
 * A REAL INTERPOSITION, not a description of one.
 *
 * A TCP relay is the minimum thing every protocol-terminating proxy also is: it accepts our socket
 * and opens its OWN to PostgreSQL, so the backend names the relay's port and not ours. That is
 * exactly the evidence a transaction pooler leaves, and it is the evidence the check reads — a
 * pooler additionally multiplexes, which is the harm, and which no test can conjure out of a plain
 * relay. Using a relay rather than PgBouncer keeps this test runnable anywhere `pg` is: it needs no
 * package, no daemon and no configuration file, and it produces the same reading.
 */
function startRelay(targetHost: string, targetPort: number): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>()
  const server = net.createServer((incoming) => {
    sockets.add(incoming)
    const outgoing = net.connect(targetPort, targetHost)
    sockets.add(outgoing)
    incoming.pipe(outgoing)
    outgoing.pipe(incoming)
    const drop = () => { incoming.destroy(); outgoing.destroy() }
    incoming.on('error', drop)
    outgoing.on('error', drop)
    incoming.on('close', drop)
    outgoing.on('close', drop)
  })
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') { reject(new Error('no relay port')); return }
      resolve({
        port: address.port,
        close: () => new Promise<void>((done) => {
          for (const socket of sockets) socket.destroy()
          server.close(() => done())
        }),
      })
    })
  })
}

/** The same database, reached through `port` on 127.0.0.1 instead of directly. */
function throughRelay(base: string, port: number): string {
  const url = new URL(base)
  url.hostname = '127.0.0.1'
  url.port = String(port)
  url.searchParams.set('schema', ASCII_SCHEMA)
  return url.toString()
}

async function reachablePostgres(t: TestContext): Promise<{ base: string; host: string; port: number } | null> {
  const base = configuredDatabaseUrl()
  if (!base) { t.skip('no DATABASE_URL configured'); return null }
  const url = new URL(base)
  const host = url.hostname || '127.0.0.1'
  const port = Number(url.port || '5432')
  const probe = new pg.Client({ connectionString: base, connectionTimeoutMillis: 3_000 })
  try {
    await probe.connect()
  } catch {
    await probe.end().catch(() => undefined)
    t.skip('no reachable PostgreSQL')
    return null
  }
  await probe.end().catch(() => undefined)
  return { base, host, port }
}

// ---------------------------------------------------------------------------
// LOAD-BEARING #1: an ASCII-schema LOCK pool reaching an interposed connection is refused.
// ---------------------------------------------------------------------------

test('o3d-a5zz (live): an ASCII-schema money-post lock is REFUSED through an interposed connection', async (t) => {
  const reachable = await reachablePostgres(t)
  if (!reachable) return
  resetStartupOptionByteSafety()
  const relay = await startRelay(reachable.host, reachable.port)
  try {
    const url = throughRelay(reachable.base, relay.port)
    // PRECONDITION: this URL is the ORDINARY case — an ASCII schema, so `pgConnectionConfig()`
    // attaches nothing. Without this the test could pass on the r24 non-ASCII refusal and say
    // nothing about the gap it exists for.
    assert.equal(
      pgConnectionConfig(url).onConnect,
      undefined,
      'PRECONDITION: an ASCII schema attaches no startup-option guard, so the refusal below can only come from the session-lock affinity check',
    )
    // PRECONDITION: the relay really does carry PostgreSQL — otherwise "refused" would be
    // "unreachable" and the assertion would pass for the wrong reason.
    const throughIt = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3_000 })
    await throughIt.connect()
    const seen = await throughIt.query<{ client_port: string; own: string }>(
      "select (select client_port::text from pg_stat_activity where pid = pg_backend_pid()) as client_port, '' as own",
    )
    const relayPort = seen.rows[0]?.client_port
    await throughIt.end().catch(() => undefined)
    assert.ok(relayPort && relayPort !== '-1', `PRECONDITION: the backend names a TCP peer through the relay; it said ${String(relayPort)}`)

    // ROUTE: withMoneyPostLock() -> acquirePinnedAdvisoryLockOrNull() -> getLockPool() ->
    // createSessionAdvisoryLockPool() -> pgSessionLockConnectionConfig() -> pg-pool's onConnect ->
    // the peer comparison -> refusal, BEFORE pg_try_advisory_lock is ever sent.
    //
    // MUTATION ROUTE: put `lockPool = new Pool({ ...pgConnectionConfig(connectionString), max: 4 })`
    // back in getLockPool() (lib/db/pinned-advisory-lock.ts) — the r23 shape, which is what shipped
    // before this round. The pool connects through the relay, the lock is taken, `ran` becomes true,
    // and the money post proceeds under an exclusion that a transaction pooler would have handed to
    // somebody else as well.
    const { withMoneyPostLock } = await import('@/lib/domain/accounting/money-post-lock')
    await withDatabaseUrl(url, async () => {
      let ran = false
      await assert.rejects(
        () => withMoneyPostLock(
          { connectorId: 'c', documentKind: 'INVOICE', documentId: 'd' } as never,
          async () => { ran = true },
        ),
        (error: unknown) => {
          assert.ok(error instanceof DatabaseUrlSchemaConflictError, `expected a schema/affinity refusal, got ${String(error)}`)
          const message = (error as Error).message
          assert.match(message, /SESSION advisory lock/, 'the refusal says what was being taken')
          assert.match(message, /terminated the connection and opened its own to the backend/, 'and it names the interposition, not some other refusal')
          // ACTIONABLE, not merely negative.
          assert.match(message, new RegExp(SESSION_LOCK_DATABASE_URL_ENV), 'and it names the variable to set')
          assert.match(message, /host=127\.0\.0\.1/, 'and it says the route must be TCP')
          return true
        },
        'a lock pool whose connection cannot be shown to reach the backend directly is refused',
      )
      assert.equal(ran, false, 'and nothing ran under a lock that was never taken')
    })
  } finally {
    await relay.close()
    resetStartupOptionByteSafety()
  }
})

// ---------------------------------------------------------------------------
// LOAD-BEARING #2: the ASCII DATA path pays nothing — that is why the exemption exists.
// ---------------------------------------------------------------------------

test('o3d-a5zz (live): an ASCII-schema DATA pool pays nothing and is untouched by this round', async (t) => {
  const reachable = await reachablePostgres(t)
  if (!reachable) return
  const relay = await startRelay(reachable.host, reachable.port)
  try {
    const url = throughRelay(reachable.base, relay.port)
    // NO HOOK AT ALL: zero extra round trips per connection on the data path, which is the entire
    // reason `pgConnectionConfig()` was left alone.
    //
    // MUTATION ROUTE: move `sessionLockAffinityGuard()` into `pgConnectionConfig()` instead of
    // `pgSessionLockConnectionConfig()`. `onConnect` becomes a function, this assertion fails, and
    // the live half below fails too — every ordinary query connection in the process starts paying
    // a round trip and every deployment behind a pooler stops booting.
    assert.equal(pgConnectionConfig(url).onConnect, undefined, 'the data-path config attaches no per-connection hook for an ASCII schema')

    // And it still WORKS through the very route the lock pool is refused on, which is the cost
    // statement made concrete: nothing about ordinary traffic changed.
    const pool = new pg.Pool({ ...pgConnectionConfig(url), max: 1 })
    try {
      const { rows } = await pool.query<{ one: number; schema: string }>("select 1 as one, current_schema() as schema")
      assert.equal(rows[0]?.one, 1, 'an ordinary data pool connects and queries through an interposed route exactly as before')
      assert.equal(rows[0]?.schema, ASCII_SCHEMA, 'and it is still pinned to the schema the URL names')
    } finally {
      await pool.end()
    }
  } finally {
    await relay.close()
  }
})

// ---------------------------------------------------------------------------
// What the hook costs, counted rather than asserted in prose.
// ---------------------------------------------------------------------------

/** A client that answers the peer question as a DIRECT connection would, and counts what it is asked. */
function directStandIn(): { client: { connection: unknown; query: (text: string) => Promise<{ rows: Array<Record<string, unknown>> }> }; asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    client: {
      connection: { stream: { localAddress: '127.0.0.1', localPort: 51515 } },
      async query(text: string) {
        asked.push(text)
        return {
          rows: [{
            client_address: '127.0.0.1',
            client_port: '51515',
            server_encoding: 'UTF8',
            lc_ctype: 'C.UTF-8',
            backend_address: '127.0.0.1',
            backend_port: '5432',
            server_version: '17.11',
            search_path: '"public"',
          }],
        }
      },
    },
  }
}

test('o3d-a5zz: the session-lock hook costs exactly ONE round trip per new physical connection', async () => {
  const url = 'postgresql://app:pw@127.0.0.1:5432/ims?schema=public'
  const config = pgSessionLockConnectionConfig(url, undefined, 'a test lock')
  assert.equal(typeof config.onConnect, 'function', 'a session-lock config always carries the hook')
  const { client, asked } = directStandIn()
  // MUTATION ROUTE: have `sessionLockAffinityGuard()` ask `SERVED_CONNECTION_SQL` instead of
  // `SESSION_LOCK_PEER_SQL`, or ask twice. The count below moves off 1.
  await (config.onConnect as (c: unknown) => Promise<void>)(client)
  assert.equal(asked.length, 1, `the hook asks exactly one question per connection; it asked ${asked.length}`)
  assert.match(asked[0] ?? '', /client_port/, 'and the question it asks is the peer one')
  assert.doesNotMatch(asked[0] ?? '', /pg_encoding_to_char/, 'not the fuller backend-identity question, which no ASCII connection has a verdict to compare against')
})

test('o3d-a5zz: a direct connection is ADMITTED — the check is not a flat refusal', async () => {
  // Proves the guard can PASS, so the refusals above are about the evidence and not about the hook
  // existing. MUTATION ROUTE: make `sessionLockAffinityGuard()` throw unconditionally; this fails
  // while every refusal test still passes, which is the point of asserting it.
  const config = pgSessionLockConnectionConfig('postgresql://app:pw@127.0.0.1:5432/ims?schema=public', undefined)
  const { client } = directStandIn()
  await (config.onConnect as (c: unknown) => Promise<void>)(client)
})

test('o3d-a5zz: a connection whose backend names NO peer (a Unix socket) is refused, actionably', async () => {
  const config = pgSessionLockConnectionConfig('postgresql://app:pw@127.0.0.1:5432/ims?schema=public', undefined, 'the money-post lock')
  const client = {
    connection: { stream: { localAddress: '', localPort: 0 } },
    async query() { return { rows: [{ client_address: '', client_port: '-1' }] } },
  }
  // MUTATION ROUTE: in `interposedPeerRefusal()`, return null for `client_port === '-1'` (the r23
  // "skip an absent peer" shape). This test fails; Odyssey pools transactions over Unix sockets and
  // presents exactly this evidence.
  await assert.rejects(
    () => (config.onConnect as (c: unknown) => Promise<void>)(client),
    (error: unknown) => {
      assert.ok(error instanceof DatabaseUrlSchemaConflictError)
      const message = (error as Error).message
      assert.match(message, /the money-post lock/, 'the refusal names which lock could not be taken')
      assert.match(message, /no client peer/, 'and what could not be shown')
      assert.match(message, new RegExp(SESSION_LOCK_DATABASE_URL_ENV))
      assert.match(message, /paid twice/, 'and why the operator must not simply route around it')
      return true
    },
  )
})

test('o3d-a5zz: the session-lock hook ALSO runs the startup-option verdict, it does not replace it', async () => {
  // A NON-ASCII schema whose byte this deployment has been MEASURED to carry, so
  // `pgConnectionConfig()` composes the pin instead of refusing it, and the r22 backend guard is
  // attached alongside the affinity leg. U+00A0 is the character the live tests in
  // `tests/db/connection-schema-pinning.test.ts` measure; the verdict here is established through a
  // stand-in so this test needs no server.
  const nbsp = '\u00A0'
  const url = `postgresql://app:pw@127.0.0.1:5432/ims?schema=${encodeURIComponent(`ten${nbsp}ant`)}`
  resetStartupOptionByteSafety()
  const measured = await establishStartupOptionByteSafety(url, {
    createClient: async () => ({
      connection: { stream: { localAddress: '127.0.0.1', localPort: 51515 } },
      async connect() { return undefined },
      async query(text: string) {
        if (text.startsWith('select pg_encoding_to_char')) {
          return { rows: [{ server_encoding: 'UTF8', lc_ctype: 'C.UTF-8', backend_address: '10.0.0.7', backend_port: '5432', server_version: '17.11', client_address: '127.0.0.1', client_port: '51515' }] }
        }
        return { rows: [{ startup_option_probe: `a${nbsp}z` }] }
      },
      async end() { return undefined },
    }),
  })
  try {
    assert.equal(measured.carries, true, 'PRECONDITION: a positive verdict, or pgConnectionConfig would refuse before any hook exists')
    const config = pgSessionLockConnectionConfig(url, undefined)
    // The peer leg PASSES — the stand-in below answers as a DIRECT connection — so the only refusal
    // left is the startup-option one, which is how this shows COMPOSITION rather than shadowing.
    // Its backend is not the one the verdict names.
    //
    // MUTATION ROUTE: drop `if (startupOptionGuard) await startupOptionGuard(client)` from
    // `sessionLockAffinityGuard()`. A lock pool on a non-ASCII schema would then connect to a
    // backend no deployment probe ever measured, and this resolves instead of rejecting.
    const { client } = directStandIn()
    await assert.rejects(
      () => (config.onConnect as (c: unknown) => Promise<void>)(client),
      (error: unknown) => {
        assert.ok(error instanceof DatabaseUrlSchemaConflictError)
        assert.match((error as Error).message, /handed the application a different backend/, 'the r22 verdict leg still runs after the affinity leg')
        return true
      },
    )
  } finally {
    resetStartupOptionByteSafety()
  }
})

// ---------------------------------------------------------------------------
// The escape hatch is checked, not trusted.
// ---------------------------------------------------------------------------

test('o3d-a5zz: DATABASE_SESSION_LOCK_URL is used when it names the same database and schema', () => {
  const base = 'postgresql://app:pw@pooler.internal:6432/ims?schema=public'
  const direct = 'postgresql://app:pw@10.0.0.5:5432/ims?schema=public'
  const config = pgSessionLockConnectionConfig(base, direct)
  assert.match(config.connectionString, /10\.0\.0\.5:5432/, 'the lock connections go past the pooler')
  assert.equal(typeof config.onConnect, 'function', 'and they still have to prove it')
})

test('o3d-a5zz: an override naming a DIFFERENT database is refused, not used', () => {
  // MUTATION ROUTE: delete the database-name comparison in `pgSessionLockConnectionConfig()`. An
  // operator escaping the refusal with a URL pointing at the wrong database would take every lock
  // somewhere the work never happens — the exact defect the branch is closing, re-entered through
  // its own remedy.
  assert.throws(
    () => pgSessionLockConnectionConfig('postgresql://app:pw@pooler:6432/ims?schema=public', 'postgresql://app:pw@10.0.0.5:5432/other?schema=public'),
    (error: unknown) => {
      assert.ok(error instanceof DatabaseUrlSchemaConflictError)
      assert.match((error as Error).message, /"other"[\s\S]*"ims"|"ims"[\s\S]*"other"/)
      return true
    },
  )
})

test('o3d-a5zz: an override resolving to a DIFFERENT schema is refused too', () => {
  // MUTATION ROUTE: delete the schema comparison. The lock would be pinned to one schema and the
  // work written to another, which is o3d-1izw's split reached through the lock connection.
  assert.throws(
    () => pgSessionLockConnectionConfig('postgresql://app:pw@pooler:6432/ims?schema=ims_app', 'postgresql://app:pw@10.0.0.5:5432/ims?schema=public'),
    (error: unknown) => {
      assert.ok(error instanceof DatabaseUrlSchemaConflictError)
      assert.match((error as Error).message, /schema/)
      return true
    },
  )
})

test('o3d-a5zz: an unset or blank override changes nothing', () => {
  const base = 'postgresql://app:pw@127.0.0.1:5432/ims?schema=public'
  for (const empty of [undefined, null, '', '   ']) {
    const config = pgSessionLockConnectionConfig(base, empty as string | undefined)
    assert.match(config.connectionString, /127\.0\.0\.1:5432/)
  }
})

// ---------------------------------------------------------------------------
// o3d-2k5r r26, Codex HIGH: MATCHING DATABASE AND SCHEMA NAMES ARE NOT AN INSTANCE.
//
// The override validation compared the decoded database pathname and the resolved schema and
// nothing else — host and port cannot be compared, since differing is the whole point of the
// override — so `postgres://pooler/ims?schema=public` and `postgres://somewhere-else/ims?schema=public`
// were equal on every field it looked at. The affinity leg then passes, because the unrelated
// server IS reached directly. Every session lock in the process would be taken there, every holder
// told it holds it, and `withMoneyPostLock` — which spans a ledger read and an EXTERNAL money post
// — would let two workers pay the same document.
//
// What replaces it is not a better identifier. It is the PROPERTY the lock actually needs: a
// session advisory lock taken through the override must be VISIBLE to a connection made through
// DATABASE_URL. Measured on this host (PostgreSQL 17.11) while writing r26, which is why an
// identifier is not used:
//
//   • a `pg_basebackup` clone of the live cluster reported the SAME pg_control_system() system
//     identifier as its origin (7624286827215704424), the same database name, the same schema and
//     the same database oid (16385) — and an independently initdb-ed cluster also reported oid
//     16385. A system identifier admits the restored clone; a database oid admits both.
//   • against that clone the property answers correctly: the witness ACQUIRED the key, so the
//     override is refused.
//   • and it does not falsely refuse the deployment it exists for: through PgBouncer 1.24.1 in
//     `pool_mode = transaction`, with and without the `-c search_path="public"` startup option,
//     the witness was blocked and the override admitted.
// ---------------------------------------------------------------------------

/** The database name both URLs of a wrongly-pointed override agree on. */
function sameNamesDifferentEndpoint(base: string, port: number): string {
  const url = new URL(base)
  url.hostname = '127.0.0.1'
  url.port = String(port)
  url.searchParams.set('schema', ASCII_SCHEMA)
  return url.toString()
}

/** The one property a stand-in has to have: it answers, and it records what it was asked. */
function standInConnector(answers: { taken?: unknown; acquired?: unknown }) {
  const asked: string[] = []
  const dialled: string[] = []
  const configs: Record<string, unknown>[] = []
  const createClient = async (config: object) => {
    configs.push(config as Record<string, unknown>)
    dialled.push(String((config as { connectionString?: unknown }).connectionString ?? ''))
    return {
      async connect() { return undefined },
      async query(text: string) {
        asked.push(text)
        if (text.includes('pg_try_advisory_lock')) return { rows: [{ taken: answers.taken ?? true }] }
        if (text.includes('pg_try_advisory_xact_lock')) return { rows: [{ acquired: answers.acquired }] }
        return { rows: [{}] }
      },
      async end() { return undefined },
    }
  }
  return { createClient, asked, dialled, configs }
}

test('[o3d-2k5r r26] an override on a DIFFERENT instance with the SAME database and schema names is REFUSED', async () => {
  resetSessionLockSpaceMeasurements()
  // Both URLs name the database `ims` and resolve to `public`. Every comparison the r25 check made
  // says these agree. The DATABASE_URL side then ACQUIRES the key the override side is holding,
  // which is what a second PostgreSQL looks like and what nothing but taking the lock can see.
  const base = 'postgresql://app:pw@pooler.internal:6432/ims?schema=public'
  const override = 'postgresql://app:pw@10.9.9.9:5432/ims?schema=public'
  const { createClient, asked, dialled } = standInConnector({ taken: true, acquired: true })
  const config = pgSessionLockConnectionConfig(base, override, 'the money-post lock', { createClient })

  // ROUTE: createSessionAdvisoryLockPool() -> pgSessionLockConnectionConfig() -> pg-pool's
  // onConnect -> the affinity leg (which PASSES here: the stand-in below answers as a direct
  // connection) -> the shared-lock-space probe -> refusal, before pg_try_advisory_lock is sent for
  // any real lock.
  //
  // MUTATION ROUTE: delete `if (sharedLockSpace) await sharedLockSpace()` from
  // `sessionLockAffinityGuard()`, or restore the r25 `return { ...config, onConnect:
  // sessionLockAffinityGuard(config.onConnect, purpose) }`. The pool connects to the unrelated
  // server, every lock is taken there, and this resolves instead of rejecting.
  const { client } = directStandIn()
  await assert.rejects(
    () => (config.onConnect as (c: unknown) => Promise<void>)(client),
    (error: unknown) => {
      assert.ok(error instanceof DatabaseUrlSchemaConflictError, `expected a schema/lock-space refusal, got ${String(error)}`)
      const message = (error as Error).message
      assert.match(message, new RegExp(SESSION_LOCK_DATABASE_URL_ENV), 'the refusal names the variable that is wrong')
      assert.match(message, /does NOT share an advisory-lock space/, 'and what was measured')
      // LOUD AND ACTIONABLE: an operator who did this has created a silent double-pay, and the
      // message has to say so or it reads as a connection problem.
      assert.match(message, /pay the same document twice/, 'and what it costs, in money rather than in connections')
      assert.match(message, /only symptom/, 'and that nothing else will report it')
      assert.match(message, /WHAT TO CHANGE/, 'and what to do about it')
      assert.match(message, /pg_control_system\(\) system identifier/, 'and why matching names — or a system identifier — were not enough')
      return true
    },
  )

  // NOT VACUOUS: the refusal came from a lock that was really taken and a key that was really
  // asked for, on two connections that were really dialled — one per URL.
  assert.ok(asked.some((text) => text.startsWith(`select pg_try_advisory_lock(${SESSION_LOCK_SPACE_PROBE_NAMESPACE},`)), `the holder took the probe key; it asked ${JSON.stringify(asked)}`)
  assert.ok(asked.some((text) => text.includes('pg_try_advisory_xact_lock')), 'and the DATABASE_URL side was asked for the same one')
  assert.ok(asked.some((text) => text.startsWith('select pg_advisory_unlock(')), 'and the probe released what it took')
  assert.deepEqual(
    dialled.map((url) => new URL(url).host),
    ['10.9.9.9:5432', 'pooler.internal:6432'],
    'the holder is dialled on the override and the witness on DATABASE_URL, in that order',
  )
})

test('[o3d-2k5r r26] the two advisory keys the probe uses are the SAME key', async () => {
  // The reading only means something if the witness asks for the key the holder took. A probe that
  // generated the key twice would report "not shared" for every correct deployment, and the
  // refusal would be indistinguishable from a real one.
  //
  // MUTATION ROUTE: move `const key = ...` inside either leg, or re-roll it for the witness.
  resetSessionLockSpaceMeasurements()
  const { createClient, asked } = standInConnector({ taken: true, acquired: false })
  const config = pgSessionLockConnectionConfig(
    'postgresql://app:pw@pooler:6432/ims?schema=public',
    'postgresql://app:pw@10.9.9.9:5432/ims?schema=public',
    'a test lock',
    { createClient },
  )
  await (config.onConnect as (c: unknown) => Promise<void>)(directStandIn().client)
  const keyOf = (fragment: string) => /\((\d+), (\d+)\)/.exec(asked.find((text) => text.includes(fragment)) ?? '')?.slice(1).join('/')
  const held = keyOf('pg_try_advisory_lock(')
  assert.ok(held, `the holder leg ran; asked ${JSON.stringify(asked)}`)
  assert.equal(keyOf('pg_try_advisory_xact_lock('), held, 'the witness asks for the key the holder took')
  assert.equal(keyOf('pg_advisory_unlock('), held, 'and the release names it too')
  assert.equal(held.split('/')[0], String(SESSION_LOCK_SPACE_PROBE_NAMESPACE), 'in the registered probe namespace')
})

test('[o3d-2k5r r26] the probe key is RANDOM, so two instances booting at once cannot refuse each other', async () => {
  // A fixed key would make the SECOND instance's `pg_try_advisory_lock` return false while the
  // first held it, and a deployment would be refused for somebody else's boot.
  //
  // MUTATION ROUTE: replace `1 + Math.floor(Math.random() * 0x7f_ff_ff_fe)` with a constant.
  const keys = new Set<string>()
  for (let attempt = 0; attempt < 5; attempt += 1) {
    resetSessionLockSpaceMeasurements()
    const { createClient, asked } = standInConnector({ taken: true, acquired: false })
    const config = pgSessionLockConnectionConfig(
      `postgresql://app:pw@pooler:6432/ims?schema=public`,
      `postgresql://app:pw@10.9.9.9:5432/ims?schema=public`,
      'a test lock',
      { createClient },
    )
    await (config.onConnect as (c: unknown) => Promise<void>)(directStandIn().client)
    const objid = /pg_try_advisory_lock\(\d+, (\d+)\)/.exec(asked.find((t) => t.includes('pg_try_advisory_lock(')) ?? '')?.[1]
    assert.ok(objid, 'the holder leg ran')
    assert.ok(Number(objid) > 0 && Number(objid) < 2 ** 31, `int4 positive; got ${objid}`)
    keys.add(objid)
  }
  assert.ok(keys.size > 1, `five probes produced ${keys.size} distinct keys`)
})

test('[o3d-2k5r r27] the per-connection leg REUSES a verdict, so one acquisition never pays for the probe twice', async () => {
  // The cost statement, counted rather than asserted in prose: two throwaway connections and four
  // statements for a measurement, and the `onConnect` leg does not add a second one.
  //
  // THIS IS NOT "once per process" ANY MORE (r27). The `onConnect` leg passes `notBefore = 0` and
  // so reuses whatever the memo holds — deliberately, because it is NOT the authority: the
  // acquisition gate that runs immediately after it is, and it accepts only a verdict measured for
  // itself (the test below). Passing 0 here is what stops a brand-new physical connection paying
  // for the probe twice inside one acquisition.
  //
  // MUTATION ROUTE: make the `onConnect` leg pass `Date.now()` instead of 0. `dialled.length`
  // becomes 8 across the four connections below, and every new lock connection pays twice.
  resetSessionLockSpaceMeasurements()
  const { createClient, asked, dialled } = standInConnector({ taken: true, acquired: false })
  const config = pgSessionLockConnectionConfig(
    'postgresql://app:pw@pooler:6432/ims?schema=public',
    'postgresql://app:pw@10.9.9.9:5432/ims?schema=public',
    'a test lock',
    { createClient },
  )
  for (let connection = 0; connection < 4; connection += 1) {
    // Spaced, so the reuse is a decision rather than four calls landing on one millisecond.
    if (connection > 0) await new Promise((resolve) => setTimeout(resolve, 3))
    await (config.onConnect as (c: unknown) => Promise<void>)(directStandIn().client)
  }
  assert.equal(dialled.length, 2, `the probe opened ${dialled.length} connections across four lock connections`)
  assert.deepEqual(
    asked.map((text) => text.replace(/\(\d+, \d+\)/, '(k)').replace(/^select /, '')),
    ['pg_try_advisory_lock(k) as taken', 'begin', 'pg_try_advisory_xact_lock(k) as acquired', 'rollback', 'pg_advisory_unlock(k)'],
    'and asked exactly these, once',
  )
})

test('[o3d-2k5r r26] with NO override there is no second endpoint, so no probe runs at all', async () => {
  // THE NON-OVERRIDE ANSWER, asserted rather than reasoned about. Without an override the lock
  // connections and the data path are built from ONE string by one derivation, so there is no
  // second endpoint that could name a different instance — and nothing is paid for asking a URL
  // whether it agrees with itself.
  //
  // MUTATION ROUTE: drop the `override === null ? null :` branch in
  // `pgSessionLockConnectionConfig()` and always attach the probe. `dialled` becomes 2 and every
  // ordinary deployment starts opening two connections at its first lock.
  resetSessionLockSpaceMeasurements()
  const { createClient, dialled, asked } = standInConnector({ taken: true, acquired: false })
  const config = pgSessionLockConnectionConfig('postgresql://app:pw@127.0.0.1:5432/ims?schema=public', undefined, 'a test lock', { createClient })
  const { client, asked: onTheConnection } = directStandIn()
  await (config.onConnect as (c: unknown) => Promise<void>)(client)
  assert.deepEqual(dialled, [], 'no probe connection is opened')
  assert.deepEqual(asked, [], 'and no probe statement is sent')
  assert.equal(onTheConnection.length, 1, 'the connection still pays exactly the one affinity round trip it paid before')
})

test('[o3d-2k5r r26] an interposed lock connection is refused BEFORE the probe is paid for', async () => {
  // Ordering, not decoration: the affinity leg is answered by the connection already in hand, so a
  // deployment that is refused for interposition must not first open two connections to find out
  // something it will not use.
  //
  // MUTATION ROUTE: move `if (sharedLockSpace) await sharedLockSpace()` above the peer comparison
  // in `sessionLockAffinityGuard()`. `dialled` stops being empty.
  resetSessionLockSpaceMeasurements()
  const { createClient, dialled } = standInConnector({ taken: true, acquired: true })
  const config = pgSessionLockConnectionConfig(
    'postgresql://app:pw@pooler:6432/ims?schema=public',
    'postgresql://app:pw@10.9.9.9:5432/ims?schema=public',
    'the money-post lock',
    { createClient },
  )
  const interposed = {
    connection: { stream: { localAddress: '127.0.0.1', localPort: 51515 } },
    async query() { return { rows: [{ client_address: '127.0.0.1', client_port: '40404' }] } },
  }
  await assert.rejects(
    () => (config.onConnect as (c: unknown) => Promise<void>)(interposed),
    (error: unknown) => {
      assert.match((error as Error).message, /terminated the connection and opened its own to the backend/)
      return true
    },
  )
  assert.deepEqual(dialled, [], 'the probe was never opened for a connection that was refused anyway')
})

test('[o3d-2k5r r26] every unclear answer is a REFUSAL, not a pass', async () => {
  // Fail closed, in the direction the rest of this module fails: "not shown" is not "shown". Each
  // case names the mutation that turns it into a silent admission.
  const base = 'postgresql://app:pw@pooler:6432/ims?schema=public'
  const override = 'postgresql://app:pw@10.9.9.9:5432/ims?schema=public'

  // 1. THE WITNESS COULD NOT BE REACHED. MUTATION ROUTE: `catch { return }` around the witness leg.
  resetSessionLockSpaceMeasurements()
  const refusingWitness = async (config: object) => {
    if (String((config as { connectionString?: unknown }).connectionString).includes('pooler')) throw new Error('ECONNREFUSED 10.0.0.1:6432')
    return { async connect() {}, async query() { return { rows: [{ taken: true }] } }, async end() {} }
  }
  await assert.rejects(
    () => (pgSessionLockConnectionConfig(base, override, 'a test lock', { createClient: refusingWitness }).onConnect as (c: unknown) => Promise<void>)(directStandIn().client),
    (error: unknown) => {
      assert.ok(error instanceof DatabaseUrlSchemaConflictError)
      assert.match((error as Error).message, /could not be established/, 'an unanswered question is refused')
      assert.match((error as Error).message, /ECONNREFUSED/, 'and it quotes what actually went wrong')
      assert.match((error as Error).message, /pay the same document twice/, 'and still says what is at stake')
      return true
    },
  )

  // 2. THE HOLDER COULD NOT TAKE ITS OWN FRESH KEY, so a blocked witness would mean nothing.
  // MUTATION ROUTE: drop the `if (taken !== true)` guard — the witness's `false` would then be
  // read as exclusion when it is only "nobody asked".
  resetSessionLockSpaceMeasurements()
  await assert.rejects(
    () => (pgSessionLockConnectionConfig(base, override, 'a test lock', { createClient: standInConnector({ taken: false, acquired: false }).createClient }).onConnect as (c: unknown) => Promise<void>)(directStandIn().client),
    (error: unknown) => {
      assert.match((error as Error).message, /did not take its own freshly generated probe key/)
      return true
    },
  )

  // 3. AN ANSWER THAT IS NOT LITERALLY FALSE. A NULL, an absent column, a number — none of them
  // say "blocked". MUTATION ROUTE: write `if (acquired !== true) return` instead of
  // `if (acquired === false) return`; every one of these becomes a silent pass.
  for (const acquired of [null, undefined, 1, 'yes', {}]) {
    resetSessionLockSpaceMeasurements()
    await assert.rejects(
      () => (pgSessionLockConnectionConfig(base, override, 'a test lock', { createClient: standInConnector({ taken: true, acquired }).createClient }).onConnect as (c: unknown) => Promise<void>)(directStandIn().client),
      (error: unknown) => {
        assert.ok(error instanceof DatabaseUrlSchemaConflictError, `${String(acquired)} was admitted`)
        assert.match((error as Error).message, /does NOT share an advisory-lock space/)
        return true
      },
      `an ${JSON.stringify(String(acquired))} answer must not be read as "blocked"`,
    )
  }

  // 4. AND THE ONE ANSWER THAT PASSES REALLY PASSES, or every case above would be about the probe
  // existing rather than about the evidence. MUTATION ROUTE: make the probe throw unconditionally.
  resetSessionLockSpaceMeasurements()
  await (pgSessionLockConnectionConfig(base, override, 'a test lock', { createClient: standInConnector({ taken: true, acquired: false }).createClient }).onConnect as (c: unknown) => Promise<void>)(directStandIn().client)
})

// ---------------------------------------------------------------------------
// LIVE: the same two answers, from a real PostgreSQL taking real advisory locks.
// ---------------------------------------------------------------------------

/** An arbitrary two-int key for these tests to contend on. Not an application lock. */
const LIVE_TEST_KEY = [SESSION_LOCK_SPACE_PROBE_NAMESPACE, 26_260_726] as const

test('[o3d-2k5r r26] (live): a CORRECT override is ADMITTED and the lock it takes really excludes', async (t) => {
  // THE DEPLOYMENT THE OVERRIDE EXISTS FOR, end to end: DATABASE_URL through an interposed route
  // (which is why the lock pool needed a way past it) and DATABASE_SESSION_LOCK_URL direct to the
  // same server. The probe must admit it — and then the lock the pool takes must actually exclude
  // a second holder, which is the whole point of admitting it.
  //
  // MUTATION ROUTE: make the probe refuse when `acquired === false` (invert the polarity). This
  // test fails while every refusal test above still passes, which is why it is here.
  const reachable = await reachablePostgres(t)
  if (!reachable) return
  resetSessionLockSpaceMeasurements()
  resetStartupOptionByteSafety()
  const relay = await startRelay(reachable.host, reachable.port)
  const pool = new pg.Pool({
    ...pgSessionLockConnectionConfig(
      throughRelay(reachable.base, relay.port),
      sameNamesDifferentEndpoint(reachable.base, reachable.port),
      'the money-post lock',
    ),
    max: 1,
  })
  const rival = new pg.Client({ connectionString: reachable.base, connectionTimeoutMillis: 3_000 })
  try {
    // PRECONDITION: the two URLs really are different endpoints, or "admitted" would be trivial.
    const dataHost = new URL(throughRelay(reachable.base, relay.port)).host
    const lockHost = new URL(sameNamesDifferentEndpoint(reachable.base, reachable.port)).host
    assert.notEqual(dataHost, lockHost, `PRECONDITION: DATABASE_URL (${dataHost}) and the override (${lockHost}) are different endpoints`)

    const holder = await pool.connect()
    try {
      const { rows } = await holder.query<{ taken: boolean }>(`select pg_try_advisory_lock(${LIVE_TEST_KEY[0]}, ${LIVE_TEST_KEY[1]}) as taken`)
      assert.equal(rows[0]?.taken, true, 'the pool was admitted and took the lock')
      // AND IT EXCLUDES. A second connection to the same server must not get it.
      await rival.connect()
      const contended = await rival.query<{ taken: boolean }>(`select pg_try_advisory_lock(${LIVE_TEST_KEY[0]}, ${LIVE_TEST_KEY[1]}) as taken`)
      assert.equal(contended.rows[0]?.taken, false, 'a rival on the same server is blocked, so the lock the override took is the lock the work sees')
    } finally {
      await holder.query(`select pg_advisory_unlock(${LIVE_TEST_KEY[0]}, ${LIVE_TEST_KEY[1]})`).catch(() => undefined)
      holder.release()
    }

    // THE PROBE LEFT NOTHING BEHIND. It holds a session lock on a throwaway connection and takes a
    // TRANSACTION-level one on the witness precisely so that neither outlives the measurement.
    // MUTATION ROUTE: use `pg_try_advisory_lock` on the witness leg instead of the xact form, or
    // drop the `pg_advisory_unlock` in the probe's `finally`. Through a transaction pooler that is
    // a lock left on a server connection somebody else is handed next.
    const { rows: left } = await rival.query<{ n: string }>(
      `select count(*)::text as n from pg_locks where locktype = 'advisory' and classid = ${SESSION_LOCK_SPACE_PROBE_NAMESPACE}`,
    )
    assert.equal(left[0]?.n, '0', `the probe holds nothing after it answers; pg_locks shows ${left[0]?.n}`)
  } finally {
    await rival.end().catch(() => undefined)
    await pool.end().catch(() => undefined)
    await relay.close()
    resetSessionLockSpaceMeasurements()
    resetStartupOptionByteSafety()
  }
})

test('[o3d-2k5r r26] (live): an override whose lock space is NOT the data path is refused, by a real PostgreSQL', async (t) => {
  // THE SAME REFUSAL AS THE STAND-IN ABOVE, but with PostgreSQL answering. A DIFFERENT DATABASE on
  // one server occupies a DIFFERENT advisory-lock space — measured in r26 to produce evidence
  // identical to a second cluster and to a pg_basebackup clone of the first: the witness acquires
  // the key. So the connector below dials the real server for both legs and sends the DATABASE_URL
  // leg to a second database, which is what an unrelated instance with the same names IS, from the
  // only vantage point the check has. Both URLs still name the same database and schema, so every
  // comparison r25 made passes.
  //
  // MUTATION ROUTE: the same one as the stand-in test — drop the probe from
  // `sessionLockAffinityGuard()`. Here the lock is taken on a real server that a real second
  // connection is not excluded by, and the test still catches it.
  const reachable = await reachablePostgres(t)
  if (!reachable) return
  const elsewhere = new URL(reachable.base)
  elsewhere.pathname = '/postgres'
  const reachableElsewhere = new pg.Client({ connectionString: elsewhere.toString(), connectionTimeoutMillis: 3_000 })
  try {
    await reachableElsewhere.connect()
  } catch {
    await reachableElsewhere.end().catch(() => undefined)
    t.skip('no second database on this server to occupy a different advisory-lock space')
    return
  }
  await reachableElsewhere.end().catch(() => undefined)

  resetSessionLockSpaceMeasurements()
  // DATABASE_URL through an interposed route and the override direct: the real deployment shape,
  // and two distinguishable endpoints, so the connector below can send exactly one of them
  // somewhere else.
  const relay = await startRelay(reachable.host, reachable.port)
  const base = throughRelay(reachable.base, relay.port)
  const override = sameNamesDifferentEndpoint(reachable.base, reachable.port)
  assert.equal(new URL(base).pathname, new URL(override).pathname, 'PRECONDITION: the two URLs name the SAME database, which is what r25 compared')
  assert.notEqual(new URL(base).port, new URL(override).port, 'PRECONDITION: and they are different endpoints, which r25 could not compare')

  const opened: string[] = []
  const createClient = async (config: object) => {
    const target = new URL(String((config as { connectionString?: unknown }).connectionString))
    // The DATABASE_URL leg lands somewhere with its own lock space; the override leg is honest.
    if (target.pathname !== '/postgres' && target.port === new URL(base).port) target.pathname = '/postgres'
    opened.push(target.pathname)
    return new pg.Client({ ...config, connectionString: target.toString() })
  }
  const config = pgSessionLockConnectionConfig(base, override, 'the money-post lock', { createClient })
  const pool = new pg.Pool({ ...config, max: 1 })
  try {
    await assert.rejects(
      () => pool.query('select 1'),
      (error: unknown) => {
        assert.ok(error instanceof DatabaseUrlSchemaConflictError, `expected a lock-space refusal, got ${String(error)}`)
        assert.match((error as Error).message, /does NOT share an advisory-lock space/)
        assert.match((error as Error).message, /pay the same document twice/)
        return true
      },
      'a lock pool whose override does not share a lock space with DATABASE_URL is refused',
    )
    assert.deepEqual(opened, [new URL(override).pathname, '/postgres'], 'both probe legs really connected, to two lock spaces')
  } finally {
    await pool.end().catch(() => undefined)
    await relay.close()
    resetSessionLockSpaceMeasurements()
  }
})

// ---------------------------------------------------------------------------
// o3d-2k5r r27, Codex HIGH + MEDIUM (review of r26).
//
// HIGH: "a cached success remains authoritative after the endpoints diverge". The probe sampled one
// connection from each endpoint and memoised the verdict for the life of the process. The URL
// STRINGS do not change when a pooler is restarted onto another primary, a DNS record is
// re-pointed or a managed failover promotes a replica — so a process that measured at boot goes on
// treating that sample as authorisation for an EXTERNAL MONEY POST for as long as it lives, while a
// process started after the change locks the other server. Both are told they hold the lock.
//
// WHAT THESE TESTS DO AND DO NOT CLAIM. They pin that the verdict is re-measured for every lock
// ACQUISITION, which takes the exposure from the process's lifetime to the milliseconds between the
// probe and the `pg_try_advisory_lock` it licenses. They do NOT claim the finding is closed: a
// check is a sample taken before the thing it licenses, and no number of samples becomes the
// property. The mechanism that would close it — durable, fenced state written through the
// authoritative DATABASE_URL transaction — is o3d-ic9a (P0), and is not written inside this branch.
//
// MEDIUM: "the probe has no deadline after connection establishment". Only `connectionTimeoutMillis`
// was set, so once either socket was up the holder query, `begin`, the witness query, `rollback`,
// the unlock and both shutdowns could hang forever — a boot-path hang on a money-lock path, in place
// of the fail-closed refusal this module promises.
// ---------------------------------------------------------------------------

const POOLED = 'postgresql://app:pw@pooler.internal:6432/ims?schema=public'
const DIRECT_ELSEWHERE = 'postgresql://app:pw@10.9.9.9:5432/ims?schema=public'

test('[o3d-2k5r r27] the verdict is re-measured for each ACQUISITION and never inherited from an earlier one', async () => {
  // ROUTE: createSessionAdvisoryLockPool() -> gateOnFreshLockSpace() -> sessionLockSpaceReestablisher()
  // -> sharedAdvisoryLockSpaceEstablished(notBefore = the instant this acquisition began).
  //
  // MUTATION ROUTE: restore the r26 memo — `if (held !== undefined) return held.promise`, ignoring
  // `notBefore`. The second acquisition then reuses the first acquisition's sample, `dialled.length`
  // stays 2, and the first assertion below fails. That is exactly the shape Codex named: a verdict
  // that outlives the relationship it measured.
  resetSessionLockSpaceMeasurements()
  const { createClient, dialled } = standInConnector({ taken: true, acquired: false })
  const reestablish = sessionLockSpaceReestablisher(POOLED, DIRECT_ELSEWHERE, { createClient })
  assert.ok(reestablish !== null, 'PRECONDITION: an override is set, so there is something to re-establish')

  await reestablish(Date.now())
  assert.equal(dialled.length, 2, `PRECONDITION: one acquisition measures once; it dialled ${dialled.length}`)

  // A later acquisition. `Date.now()` is millisecond-resolution, so the wait is what makes
  // "started before this acquisition began" true rather than a coin toss.
  await new Promise((resolve) => setTimeout(resolve, 5))
  await reestablish(Date.now())
  assert.equal(dialled.length, 4, `the second acquisition measured for itself; it dialled ${dialled.length} in total`)

  // And the ONE caller that is allowed to reuse still does: the per-connection `onConnect` leg,
  // which passes 0 because the acquisition gate behind it is the authority.
  await reestablish(0)
  assert.equal(dialled.length, 4, 'the per-connection leg reuses, so a new connection does not probe twice in one acquisition')
})

test('[o3d-2k5r r27] with NO override there is nothing to re-establish, so an acquisition pays nothing', () => {
  // MUTATION ROUTE: drop the `if (override === null) return null` branch from
  // `sessionLockSpaceReestablisher()`. Every ordinary deployment — one URL, one derivation, no
  // second endpoint that could disagree — starts opening two connections per lock acquisition.
  assert.equal(sessionLockSpaceReestablisher(POOLED, undefined), null)
  assert.equal(sessionLockSpaceReestablisher(POOLED, ''), null)
  assert.equal(sessionLockSpaceReestablisher(POOLED, '   '), null)
  assert.ok(sessionLockSpaceReestablisher(POOLED, DIRECT_ELSEWHERE) !== null, 'and an override really does produce one')
})

/**
 * A connector that CONNECTS SUCCESSFULLY and then never answers — the case Codex asked for.
 *
 * It records what was destroyed at the socket, which is the thing that actually frees a wedged
 * backend (and releases the probe key the holder is holding); `end()` is recorded separately
 * because on a stalled connection it is a conversation the server will not have.
 */
function stallingConnector(stallOn: RegExp) {
  const destroyed: string[] = []
  const ended: string[] = []
  const createClient = async (config: object) => {
    const url = String((config as { connectionString?: unknown }).connectionString ?? '')
    return {
      connection: { stream: { destroy() { destroyed.push(url) } } },
      async connect() { return undefined },
      async query(text: string) {
        if (stallOn.test(text)) return new Promise<{ rows: Array<Record<string, unknown>> }>(() => {})
        if (text.includes('pg_try_advisory_lock')) return { rows: [{ taken: true }] }
        if (text.includes('pg_try_advisory_xact_lock')) return { rows: [{ acquired: false }] }
        return { rows: [{}] }
      },
      async end() { ended.push(url); return undefined },
    }
  }
  return { createClient, destroyed, ended }
}

test('[o3d-2k5r r27] a connector that connects and then STALLS is given up on, destroyed, and REFUSED', { timeout: 15_000 }, async () => {
  // ROUTE: the lock connection's onConnect -> the shared-lock-space probe -> a witness that
  // connects and then never answers `begin` -> the whole-probe deadline -> both clients destroyed
  // at the socket -> DatabaseUrlSchemaConflictError, i.e. the promised fail-closed refusal.
  //
  // MUTATION ROUTE 1: delete the `Promise.race([..., deadline])` in
  // `measureSharedAdvisoryLockSpace()` and await the probe directly. Nothing ever settles and this
  // test fails on its own 15s timeout instead of passing in ~80ms — which is precisely the defect:
  // a money post, an accounting batch, a WMS sweep or a restore hangs instead of being refused.
  // MUTATION ROUTE 2: make `destroyClientSocket()` a no-op. The refusal still arrives, and the
  // `destroyed` assertions below fail — the probe would have given up while still holding both
  // sockets, and the holder's advisory lock with them.

  // (a) THE WITNESS stalls, so BOTH connections are open when the deadline fires.
  resetSessionLockSpaceMeasurements()
  const witnessStalls = stallingConnector(/^begin$/)
  const config = pgSessionLockConnectionConfig(POOLED, DIRECT_ELSEWHERE, 'the money-post lock', {
    createClient: witnessStalls.createClient,
    probeDeadlineMs: 80,
  })
  await assert.rejects(
    () => (config.onConnect as (c: unknown) => Promise<void>)(directStandIn().client),
    (error: unknown) => {
      assert.ok(error instanceof DatabaseUrlSchemaConflictError, `expected a refusal, got ${String(error)}`)
      const message = (error as Error).message
      assert.match(message, /could not be established within 80ms/, 'the refusal says it ran out of time')
      assert.match(message, /stopped answering/, 'and what that looked like')
      assert.match(message, /may only be passed by an answer/, 'and that silence is not a yes')
      assert.match(message, /pay the same document twice/, 'and what the misconfiguration would cost')
      assert.match(message, /WHAT TO CHANGE/, 'and what to do about it')
      return true
    },
  )
  assert.deepEqual(
    witnessStalls.destroyed.map((url) => new URL(url).host).sort(),
    ['10.9.9.9:5432', 'pooler.internal:6432'],
    'BOTH probe connections were destroyed at the socket, not left wedged',
  )

  // (b) THE HOLDER stalls, before the witness exists. The one connection that was opened is the one
  // that is destroyed — a deadline that only worked when both were up would leave the common case
  // (an unreachable primary behind a live pooler) holding a socket.
  resetSessionLockSpaceMeasurements()
  const holderStalls = stallingConnector(/pg_try_advisory_lock/)
  const holderConfig = pgSessionLockConnectionConfig(POOLED, DIRECT_ELSEWHERE, 'the money-post lock', {
    createClient: holderStalls.createClient,
    probeDeadlineMs: 80,
  })
  await assert.rejects(
    () => (holderConfig.onConnect as (c: unknown) => Promise<void>)(directStandIn().client),
    (error: unknown) => {
      assert.match((error as Error).message, /could not be established within 80ms/)
      return true
    },
  )
  assert.deepEqual(
    holderStalls.destroyed.map((url) => new URL(url).host),
    ['10.9.9.9:5432'],
    'the one connection that was open is destroyed, and the witness was never dialled',
  )
})

test('[o3d-2k5r r27] every probe connection carries a per-STATEMENT deadline, not only a connect timeout', async () => {
  // The deadline above is the backstop; this is the bound that makes the ordinary stall cheap.
  // CLIENT-side (`pg`'s `query_timeout`) deliberately: a server `statement_timeout` travels as a
  // startup option, and this module has already MEASURED PgBouncer accepting the connection and
  // silently discarding those (`-c statement_timeout=1234` came back `0`). The override exists
  // because DATABASE_URL goes through a pooler, so a deadline a pooler can drop is not a deadline.
  //
  // MUTATION ROUTE: remove `query_timeout` from `probeConnectionConfig()`. Both assertions fail,
  // and a stalled statement is then bounded only by the 20s whole-probe backstop.
  resetSessionLockSpaceMeasurements()
  const { createClient, configs } = standInConnector({ taken: true, acquired: false })
  const config = pgSessionLockConnectionConfig(POOLED, DIRECT_ELSEWHERE, 'a test lock', { createClient })
  await (config.onConnect as (c: unknown) => Promise<void>)(directStandIn().client)
  assert.equal(configs.length, 2, `PRECONDITION: both probe legs were configured; ${configs.length} were`)
  for (const dialledWith of configs) {
    assert.equal(dialledWith.connectionTimeoutMillis, 5_000, 'the connect is bounded')
    assert.equal(dialledWith.query_timeout, 5_000, 'and so is every statement on it')
  }
})

// ---------------------------------------------------------------------------
// The gate itself: what a lock ACQUISITION does around obtaining its connection.
// ---------------------------------------------------------------------------

test('[o3d-2k5r r27] the acquisition gate reads its instant BEFORE opening, so a verdict measured for an earlier acquisition cannot satisfy it', async () => {
  // MUTATION ROUTE: move `const notBefore = Date.now()` below `await open()` in
  // `gateOnFreshLockSpace()`. `notBefore` then lands after the connection came up — after the
  // `onConnect` probe that ran on the way up — so that probe is rejected as too old and every new
  // physical connection measures twice; the assertion below fails on the same instant.
  const seen: number[] = []
  let probedAt = 0
  const gated = gateOnFreshLockSpace<string>(
    async () => {
      // The connection comes up, its `onConnect` measures — and OPENING TAKES TIME, which is what
      // makes the ordering observable rather than a coin toss on one millisecond's resolution.
      probedAt = Date.now()
      await new Promise((resolve) => setTimeout(resolve, 15))
      return 'client'
    },
    async (notBefore) => {
      seen.push(notBefore)
      // THE SEMANTICS, not just the arithmetic: a verdict measured while this very connection was
      // coming up must satisfy this acquisition, or every new physical connection probes twice.
      if (notBefore > probedAt) throw new Error(`the probe that ran at ${probedAt} while this connection came up was rejected as older than ${notBefore}`)
    },
    () => { throw new Error('nothing was refused, so nothing may be discarded') },
  )
  assert.equal(await gated(), 'client', 'an admitted acquisition gets its connection')
  assert.equal(seen.length, 1, 'and the gate really ran')
  assert.ok(seen[0]! <= probedAt, `notBefore (${seen[0]}) was taken before the connection came up (${probedAt})`)
})

test('[o3d-2k5r r27] a refused acquisition DISCARDS its connection and rethrows, rather than handing it out', async () => {
  // A pool client released without `destroy` goes straight back into the pool, so a checkout that
  // was refused would leak a connection per refusal — and behind a broken endpoint every
  // acquisition is a refusal.
  //
  // MUTATION ROUTE: delete the `discard(client)` call in `gateOnFreshLockSpace()`'s catch.
  // `discarded` stays empty and this fails.
  const discarded: string[] = []
  const refused = gateOnFreshLockSpace<string>(
    async () => 'client',
    async () => { throw new DatabaseUrlSchemaConflictError('does NOT share an advisory-lock space') },
    (client) => { discarded.push(client) },
  )
  await assert.rejects(refused, (error: unknown) => {
    assert.ok(error instanceof DatabaseUrlSchemaConflictError, `the refusal reaches the caller unchanged, got ${String(error)}`)
    return true
  })
  assert.deepEqual(discarded, ['client'], 'the connection it obtained was destroyed')

  // AND A FAILING DISCARD DOES NOT REPLACE THE REFUSAL. MUTATION ROUTE: drop the try/catch around
  // `discard(client)`; the caller then sees "teardown exploded" instead of what is actually wrong.
  const alsoRefused = gateOnFreshLockSpace<string>(
    async () => 'client',
    async () => { throw new DatabaseUrlSchemaConflictError('does NOT share an advisory-lock space') },
    () => { throw new Error('teardown exploded') },
  )
  await assert.rejects(alsoRefused, (error: unknown) => {
    assert.match((error as Error).message, /does NOT share an advisory-lock space/)
    return true
  })
})

test('[o3d-2k5r r27] with no override the gate is the identity, so an ordinary deployment pays nothing for it', async () => {
  // MUTATION ROUTE: drop the `if (reestablish === null) return open` early return. Every
  // deployment without an override then pays a closure, a `Date.now()` and a try/catch per
  // acquisition for a check that cannot run.
  const open = async () => 'client'
  assert.equal(gateOnFreshLockSpace<string>(open, null, () => { throw new Error('unreachable') }), open)
})

// ---------------------------------------------------------------------------
// o3d-2k5r r28, Codex MEDIUM: the deadline on the connection the probe LICENSES.
//
// r27 bounded the probe -- two throwaway clients -- and left unbounded the one statement that runs
// on the ACTUAL lock socket before any probe client exists. Codex's reproduction: `probeDeadlineMs:
// 25`, still pending at 100ms, ZERO probe clients created. These tests drive that exact case.
// ---------------------------------------------------------------------------

/**
 * The ACTUAL lock client: it connects, answers the peer question as a direct connection would --
 * or, when asked to stall, never answers at all -- and records what was done to its SOCKET.
 *
 * `end()` is recorded separately from `destroy()` on purpose. On a wedged connection `end()` is a
 * conversation the server will not have, so a teardown that only called it would leave the socket
 * exactly where it was; destroying the stream is the thing that actually frees the backend.
 */
function lockClientStandIn(stall = false) {
  const destroyed: string[] = []
  const ended: string[] = []
  const asked: string[] = []
  const client = {
    connection: {
      stream: {
        localAddress: '127.0.0.1',
        localPort: 51515,
        destroy() { destroyed.push('socket') },
      },
    },
    async query(text: string) {
      asked.push(text)
      if (stall) return new Promise<{ rows: Array<Record<string, unknown>> }>(() => {})
      return {
        rows: [{
          client_address: '127.0.0.1',
          client_port: '51515',
          server_encoding: 'UTF8',
          lc_ctype: 'C.UTF-8',
          backend_address: '127.0.0.1',
          backend_port: '5432',
          server_version: '17.11',
          search_path: '"public"',
        }],
      }
    },
    async end() { ended.push('end'); return undefined },
  }
  return { client, destroyed, ended, asked }
}

test('[o3d-2k5r r28] the LOCK client connects and then STALLS: the affinity query is bounded, its socket destroyed, and the acquisition REFUSED', { timeout: 15_000 }, async () => {
  // ROUTE: createSessionAdvisoryLockPool()/createSessionAdvisoryLockClient() ->
  // pgSessionLockConnectionConfig() -> the connection's `onConnect` -> sessionLockAffinityGuard()
  // -> `select client_addr, ...` ON THE LOCK SOCKET, which never answers -> the per-statement
  // deadline in `withLockClientDeadline()` -> that client's stream is DESTROYED -> a fail-closed
  // DatabaseUrlSchemaConflictError. This is the connection every session lock in the process is
  // taken on; the probe's deadline is not reachable from here and never was.
  //
  // MUTATION ROUTE 1: in `sessionLockAffinityGuard()`, replace the inner
  // `withLockClientDeadline(client, peerQueryTimeoutMs, ...)` wrapper with a bare
  // `await client.query(SESSION_LOCK_PEER_SQL)` -- i.e. restore r27. Nothing settles, and this test
  // fails on its own 15s timeout instead of passing in ~60ms. VERIFIED by making exactly that edit.
  // MUTATION ROUTE 2: make `destroyClientSocket()` a no-op. The refusal still arrives and the
  // `destroyed` assertion below fails -- the acquisition would have given up while still holding
  // the socket, and a wedged backend is freed by nothing else.

  // (a) NO OVERRIDE AT ALL, which is the ordinary deployment: there is no probe, so there is
  //     nothing for a probe deadline to protect, and the stall is bounded anyway.
  resetSessionLockSpaceMeasurements()
  const plain = lockClientStandIn(true)
  const plainConfig = pgSessionLockConnectionConfig(POOLED, undefined, 'the money-post lock', {
    peerQueryTimeoutMs: 60,
  })
  await assert.rejects(
    () => (plainConfig.onConnect as (c: unknown) => Promise<void>)(plain.client),
    (error: unknown) => {
      assert.ok(error instanceof DatabaseUrlSchemaConflictError, `expected a refusal, got ${String(error)}`)
      const message = (error as Error).message
      assert.match(message, /SESSION advisory lock \(the money-post lock\)/, 'the refusal names the lock')
      assert.match(message, /the connection-affinity query did not finish within 60ms/, 'and which leg ran out of time')
      assert.match(message, /socket was DESTROYED/, 'and that the connection was not left pending')
      assert.match(message, /WHAT TO CHANGE/, 'and what an operator can do about it')
      return true
    },
  )
  assert.deepEqual(plain.asked.length, 1, 'PRECONDITION: the affinity query was actually reached and is what stalled')
  assert.deepEqual(plain.destroyed, ['socket'], "the LOCK client's socket was destroyed, not left wedged")

  // (b) WITH AN OVERRIDE, so a probe EXISTS -- and is never reached, which is the whole finding.
  //     The probe deadline is left at its default 20s: if this test were relying on it, it would
  //     time out rather than pass.
  resetSessionLockSpaceMeasurements()
  const stalled = lockClientStandIn(true)
  const probes = standInConnector({ taken: true, acquired: false })
  const config = pgSessionLockConnectionConfig(POOLED, DIRECT_ELSEWHERE, 'the money-post lock', {
    createClient: probes.createClient,
    peerQueryTimeoutMs: 60,
  })
  await assert.rejects(
    () => (config.onConnect as (c: unknown) => Promise<void>)(stalled.client),
    (error: unknown) => {
      assert.match((error as Error).message, /the connection-affinity query did not finish within 60ms/)
      return true
    },
  )
  assert.deepEqual(stalled.destroyed, ['socket'], "the lock client's socket is destroyed on this path too")
  assert.deepEqual(probes.dialled, [], 'and NO probe client was ever created -- exactly the reproduction, so the probe deadline cannot have been what ended this')

  // (c) NOT VACUOUS: a lock client that ANSWERS is admitted by the same code path, so the bound is
  //     not simply refusing everything.
  resetSessionLockSpaceMeasurements()
  const healthy = lockClientStandIn(false)
  const healthyConfig = pgSessionLockConnectionConfig(POOLED, undefined, 'the money-post lock', {
    peerQueryTimeoutMs: 60,
  })
  await (healthyConfig.onConnect as (c: unknown) => Promise<void>)(healthy.client)
  assert.deepEqual(healthy.destroyed, [], 'a connection that answered keeps its socket')
})

test('[o3d-2k5r r28] the whole-guard backstop ends a leg whose OWN bound is longer than the acquisition may take', { timeout: 15_000 }, async () => {
  // The affinity query answers; the stall is in the shared-lock-space probe, whose own deadline is
  // deliberately set LONGER than the acquisition deadline here. The backstop is what ends it, and
  // it destroys the LOCK client's socket -- not just the probe's -- because the lock connection is
  // what the caller is waiting on.
  //
  // MUTATION ROUTE: remove the outer `withLockClientDeadline(client, acquisitionDeadlineMs, ...)`
  // in `sessionLockAffinityGuard()` and await the three legs directly. The refusal then arrives at
  // the probe's 400ms instead of 60ms and says "could not be established within 400ms", so both the
  // timing-independent message assertions below fail. VERIFIED by making exactly that edit.
  resetSessionLockSpaceMeasurements()
  const held = lockClientStandIn(false)
  const neverConnects = {
    createClient: async () => ({
      async connect() { return new Promise<undefined>(() => {}) },
      async query() { return { rows: [{}] } },
      async end() { return undefined },
    }),
  }
  const config = pgSessionLockConnectionConfig(POOLED, DIRECT_ELSEWHERE, 'the money-post lock', {
    createClient: neverConnects.createClient,
    probeDeadlineMs: 400,
    acquisitionDeadlineMs: 60,
  })
  await assert.rejects(
    () => (config.onConnect as (c: unknown) => Promise<void>)(held.client),
    (error: unknown) => {
      assert.ok(error instanceof DatabaseUrlSchemaConflictError, `expected a refusal, got ${String(error)}`)
      const message = (error as Error).message
      assert.match(message, /the session-lock acquisition did not finish within 60ms/, 'the BACKSTOP is what ended it, at its own number')
      assert.doesNotMatch(message, /could not be established within 400ms/, 'not the probe deadline, which had not fired yet')
      return true
    },
  )
  assert.deepEqual(held.destroyed, ['socket'], "the lock client's socket is destroyed even though the stall was downstream of it")
  resetSessionLockSpaceMeasurements()
})

test('[o3d-2k5r r28] an acquisition that never completes is given up on, and a connection that arrives afterwards is DISCARDED', async () => {
  // The outer half, in `lib/db/session-lock-pool.ts`: the parts of an acquisition that happen
  // OUTSIDE the guard -- pg-pool's connect path before `onConnect` is reached, and its unbounded
  // wait for a free connection when the pool is full (these pools carry no
  // `connectionTimeoutMillis`, which is the o3d-xl63 defect on a lock pool).
  //
  // MUTATION ROUTE 1: make `boundLockAcquisition()` return `open` unchanged. (a) never settles and
  // this test fails on the runner's timeout. VERIFIED by making exactly that edit.
  // MUTATION ROUTE 2: delete the `abandon?.()` call. (a)'s `abandoned` assertion fails, and a lone
  // lock client would be left holding a socket nobody will ever close.
  // MUTATION ROUTE 3: drop the `if (expired) discard(client)` handler on `opening`. (b)'s
  // `discarded` assertion fails -- a pool client that arrives after the refusal goes back into the
  // pool and is handed straight out to the next caller.

  // (a) THE ACQUISITION NEVER COMPLETES.
  let abandoned = 0
  const hangs = boundLockAcquisition<string>(
    () => new Promise<string>(() => {}),
    () => { throw new Error('nothing arrived, so nothing may be discarded') },
    'the money-post lock',
    40,
    () => { abandoned += 1 },
  )
  await assert.rejects(hangs, (error: unknown) => {
    const message = (error as Error).message
    assert.match(message, /Acquiring the connection for the money-post lock did not finish within 40ms/)
    assert.match(message, /The lock was NOT taken/, 'and the caller is told the acquisition failed CLOSED')
    return true
  })
  assert.equal(abandoned, 1, "the client's socket was destroyed by the caller that had one to destroy")

  // (b) IT COMPLETES, LATE. The refusal has already been delivered, so the connection must be
  //     destroyed rather than returned.
  const discarded: string[] = []
  const late = boundLockAcquisition<string>(
    () => new Promise<string>((resolve) => setTimeout(() => resolve('client'), 60)),
    (client) => { discarded.push(client) },
    'the money-post lock',
    20,
  )
  await assert.rejects(late, (error: unknown) => {
    assert.match((error as Error).message, /did not finish within 20ms/)
    return true
  })
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.deepEqual(discarded, ['client'], 'the connection that arrived after the deadline was destroyed, not leaked')

  // (c) NOT VACUOUS: an acquisition that completes in time is returned untouched.
  const fine = boundLockAcquisition<string>(
    async () => 'client',
    () => { throw new Error('an admitted acquisition may not be discarded') },
    'the money-post lock',
    40,
  )
  assert.equal(await fine(), 'client')
})
