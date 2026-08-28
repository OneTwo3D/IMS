import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import net from 'node:net'
import test, { type TestContext } from 'node:test'

import { parse as parseDotenv } from 'dotenv'
import pg from 'pg'

import {
  DatabaseUrlSchemaConflictError,
  SESSION_LOCK_DATABASE_URL_ENV,
  establishStartupOptionByteSafety,
  pgConnectionConfig,
  pgSessionLockConnectionConfig,
  resetStartupOptionByteSafety,
} from '../../lib/db/database-url-schema.mjs'

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
