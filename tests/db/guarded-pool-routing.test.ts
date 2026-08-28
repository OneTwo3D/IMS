import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import test, { type TestContext } from 'node:test'

import { parse as parseDotenv } from 'dotenv'
import pg from 'pg'

import {
  DatabaseUrlSchemaConflictError,
  establishStartupOptionByteSafety,
  resetStartupOptionByteSafety,
} from '../../lib/db/database-url-schema.mjs'

/**
 * o3d-2k5r r23, Codex HIGH #2 — EVERY POOL IN THE PROCESS, THROUGH THE SAME GUARDED CONFIG.
 *
 * `withMoneyPostLock` is this branch's exclusion for an EXTERNAL MONEY POST: while it is held, one
 * worker reads the ledger, decides no settlement exists, and pays. It is built on
 * `acquirePinnedAdvisoryLockOrNull`, which built its own `new Pool({ connectionString:
 * DATABASE_URL })` — a second route into the database inside a process whose Prisma pool is
 * guarded, carrying no `search_path` pin and none of the per-connection backend checks. On a
 * deployment whose schema name needs a non-ASCII startup option, that pool could be served by a
 * backend the deployment probe never measured, so the lock could be taken somewhere other than
 * where the money is posted — and two workers could each hold "the" lock and each pay.
 *
 * The same shape existed in `lib/connectors/xero/payment-write-lock.ts`,
 * `lib/domain/wms/dispatch-sweep-lock.ts` and the restore route's selection-lock holder. All four
 * now compose their config with `pgConnectionConfig()`. The last test in this file is what stops a
 * fifth appearing — the several-readers-one-fixed shape, closed by making the repository itself the
 * reader.
 *
 * NOTE ON SCOPE, so this is not read as more than it is: routing the lock pool through the guarded
 * config makes every connection it opens inherit the pin and the backend check. It does NOT settle
 * whether a session advisory lock on ANY separate connection can be the authority for a money post
 * — that is a design question, raised as its own P1 with Codex's alternative (durable lock/lease
 * state in the authoritative database) rather than answered inside this branch.
 */

const NO_SERVER = 'postgresql://app:pw@127.0.0.1:1/ims'
const NON_ASCII_SCHEMA_URL = `${NO_SERVER}?schema=${encodeURIComponent('ténant')}`

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

test('o3d-2k5r r23: the money-post lock refuses a schema this deployment has no licence for', async () => {
  resetStartupOptionByteSafety()
  const { withMoneyPostLock } = await import('@/lib/domain/accounting/money-post-lock')
  await withDatabaseUrl(NON_ASCII_SCHEMA_URL, async () => {
    // ROUTE: withMoneyPostLock() -> acquirePinnedAdvisoryLockOrNull() -> getLockPool() ->
    // pgConnectionConfig(DATABASE_URL) -> the unlicensed non-ASCII byte -> refusal.
    //
    // The port is 1, so under the mutation route below NOTHING can hang: an unguarded pool gets
    // ECONNREFUSED instead, which is a different error and fails the assertion for the right reason.
    //
    // MUTATION ROUTE: put `new Pool({ connectionString, max: 4 })` back in getLockPool()
    // (lib/db/pinned-advisory-lock.ts). The lock pool stops consulting the deployment verdict
    // altogether and the rejection becomes a connection error — an unguarded second route into the
    // database, opened by the one mechanism that decides whether money moves twice.
    let ran = false
    await assert.rejects(
      () => withMoneyPostLock(
        { connectorId: 'c', documentKind: 'INVOICE', documentId: 'd' } as never,
        async () => { ran = true },
      ),
      (error: unknown) => {
        assert.ok(error instanceof DatabaseUrlSchemaConflictError, `expected a schema refusal, got ${String(error)}`)
        return true
      },
      'the money-post lock is composed from the guarded configuration, so it inherits its refusals',
    )
    assert.equal(ran, false, 'and nothing ran under a lock that was never taken')
  })
})

test('o3d-2k5r r23: the payment-write and dispatch-sweep locks are routed the same way', async () => {
  resetStartupOptionByteSafety()
  const { withPaymentWriteLockOrSkip } = await import('@/lib/connectors/xero/payment-write-lock')
  const { withDispatchSweepLockOrSkip } = await import('@/lib/domain/wms/dispatch-sweep-lock')
  await withDatabaseUrl(NON_ASCII_SCHEMA_URL, async () => {
    // MUTATION ROUTE: revert either `getLockPool()` to `new Pool({ connectionString, max: N })`.
    // Cross-checked deliberately: three copies of one mechanism is three chances to fix one and
    // leave two, which is the shape this whole finding is about.
    await assert.rejects(() => withPaymentWriteLockOrSkip(async () => undefined), DatabaseUrlSchemaConflictError)
    await assert.rejects(() => withDispatchSweepLockOrSkip('wms', async () => undefined), DatabaseUrlSchemaConflictError)
  })
})

// ---------------------------------------------------------------------------
// The repository as the reader: no runtime pool built straight from DATABASE_URL.
// ---------------------------------------------------------------------------

const REPO_ROOT = new URL('../../', import.meta.url).pathname

/**
 * The ONE runtime construction allowed to take a bare connection string, and why.
 *
 * Keyed by file and by the exact text, so a stale entry is a FAILURE rather than a silent
 * exemption: if the line moves or changes, this list stops matching and the test says so.
 */
const ALLOWED: ReadonlyArray<{ file: string; contains: string; because: string }> = [
  {
    file: 'lib/ops/production-preflight.ts',
    contains: "new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 })",
    because:
      'the connectivity check asks one question — can a connection be opened — and its only statement is ' +
      'SELECT 1, which resolves no object. Routing it through pgConnectionConfig() would report an ' +
      'unsupported schema as "database connectivity failed", which is the wrong check failing; the schema ' +
      'is checkWmsPushStateSchema(), and that one IS guarded.',
  },
]

/** Every runtime source file — `lib/` and `app/`, the code that runs in the server process. */
function runtimeSources(): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'generated') continue
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(ts|tsx|mjs|js)$/.test(entry)) found.push(path.relative(REPO_ROOT, full))
    }
  }
  for (const root of ['lib', 'app']) walk(path.join(REPO_ROOT, root))
  return found
}

test('o3d-2k5r r23: no runtime pool or client is built straight from DATABASE_URL', () => {
  // MUTATION ROUTE: put `new Pool({ connectionString, max: 4 })` back in ANY of the three lock
  // pools, or `new pg.Client({ connectionString: process.env.DATABASE_URL, ... })` back in the
  // restore route's lock holder. Each reappears in `offenders` below by name.
  //
  // The rule is about the GRAMMAR of the construction, not about what happens to be written near
  // it: a `connectionString` or a `DATABASE_URL` inside the constructor's own argument list, with
  // no `pgConnectionConfig`/`dbPoolConfig` in that same argument list. A "…unless the guarded
  // helper appears within N lines" rule would pass vacuously here, because every one of these sites
  // now carries a comment naming `pgConnectionConfig()` a line or two above it.
  const files = runtimeSources()
  assert.ok(files.length > 400, `the walk must actually reach the runtime tree; it found ${files.length} files`)
  for (const witness of ['lib/db/pinned-advisory-lock.ts', 'lib/connectors/xero/payment-write-lock.ts',
    'lib/domain/wms/dispatch-sweep-lock.ts', 'app/api/backup/restore/route.ts', 'lib/ops/production-preflight.ts']) {
    assert.ok(files.includes(witness), `PRECONDITION: the walk reached ${witness}`)
  }

  const CONSTRUCTOR = /new\s+(?:pg\s*\.\s*)?(Pool|Client|PrismaPg)\s*\(/g

  /**
   * The config a constructor is actually given.
   *
   * `new pg.Client(clientConfig)` is the same defect as `new pg.Client({ connectionString: ... })`
   * with a name in front of it, and the first version of this rule read only the literal — so
   * reverting app/api/backup/restore/route.ts to a bare connection string passed the guard. A bare
   * identifier is therefore followed to its `const <name> = { … }` in the same file.
   */
  const resolved = (source: string, args: string): string => {
    const identifier = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(args)?.[1]
    if (!identifier) return args
    const declaration = source.indexOf(`const ${identifier} = {`)
    if (declaration < 0) return args
    let depth = 0
    let cursor = source.indexOf('{', declaration)
    for (let i = cursor; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1
      else if (source[i] === '}') { depth -= 1; if (depth === 0) { cursor = i; break } }
    }
    return source.slice(declaration, cursor + 1)
  }
  const offenders: string[] = []
  const allowedHits = new Set<string>()

  for (const file of files) {
    const raw = readFileSync(path.join(REPO_ROOT, file), 'utf8')
    // COMMENTS ARE NOT CODE, and here that is load-bearing rather than tidy: every one of these
    // call sites now carries a WHY block that QUOTES the construction it replaced. Scanning the raw
    // text reported all three fixed files as offenders — which is how this rule was shown not to be
    // vacuous, and why it reads the code and not the prose. Whole-line `//` only, so the `//` in a
    // `postgresql://` literal survives.
    const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
    for (const match of source.matchAll(CONSTRUCTOR)) {
      // The constructor's own argument list, by balanced-paren scan from the opening bracket.
      let depth = 0
      let end = match.index + match[0].length - 1
      for (; end < source.length; end += 1) {
        if (source[end] === '(') depth += 1
        else if (source[end] === ')') { depth -= 1; if (depth === 0) break }
      }
      const args = resolved(source, source.slice(match.index + match[0].length, end))
      const takesRawUrl = /connectionString|DATABASE_URL/.test(args)
      const isGuarded = /pgConnectionConfig|dbPoolConfig/.test(args)
      if (!takesRawUrl || isGuarded) continue
      const site = `${file}: new ${match[1]}(${args.replace(/\s+/g, ' ').trim().slice(0, 90)})`
      const exemption = ALLOWED.find((entry) => entry.file === file && raw.includes(entry.contains))
      if (exemption) { allowedHits.add(`${exemption.file}::${exemption.contains}`); continue }
      offenders.push(site)
    }
  }

  assert.deepEqual(offenders, [], `these runtime pools/clients bypass the guarded configuration:\n${offenders.join('\n')}`)
  // A stale exemption is a failure, not a free pass: every entry must still describe real code.
  for (const entry of ALLOWED) {
    assert.ok(
      allowedHits.has(`${entry.file}::${entry.contains}`),
      `the exemption for ${entry.file} no longer matches anything — delete it or fix it. Reason on file: ${entry.because}`,
    )
  }
})

// ---------------------------------------------------------------------------
// o3d-2k5r r25 / o3d-a5zz: and every SESSION-LOCK connection goes through the lock factory.
// ---------------------------------------------------------------------------

/**
 * THE TEST ABOVE IS NOT ENOUGH SINCE r25, AND THIS IS WHY.
 *
 * `pgConnectionConfig()` satisfies the rule above and still attaches NO per-connection check for an
 * ASCII schema, because the check it carries is the licence for a non-ASCII startup option. That is
 * correct for the data path — it is why the exemption exists, and an ordinary pool must not pay a
 * round trip per connection for a permission it is not spending. It is NOT correct for a connection
 * that is about to take a SESSION advisory lock, which behind a transaction pooler is held by
 * nobody: measured against Odyssey 1.5.3-rc1, two clients each got `true` from the same
 * `pg_try_advisory_lock` and the first's own `pg_locks` showed nothing.
 *
 * So a lock holder that writes `new Pool({ ...pgConnectionConfig(url) })` passes the rule above and
 * is still unprotected. The requirement therefore belongs to `lib/db/session-lock-pool.ts`, and
 * this is the reader that stops a fifth holder appearing without it — the several-readers-one-fixed
 * shape again, closed the same way.
 *
 * TRANSACTION-SCOPED LOCKS ARE DELIBERATELY OUT OF SCOPE. `pg_advisory_xact_lock` lives and dies
 * with its transaction, and a transaction pooler holds one backend for the whole transaction by
 * construction, so multiplexing cannot take that lock away mid-flight. It is the SESSION form, held
 * across a callback, that needs the connection to be the connection.
 */
/**
 * HOW POSTGRESQL SPELLS "TAKE A SESSION ADVISORY LOCK" (o3d-2k5r r27, Codex MEDIUM).
 *
 * Until r27 this was two case-SENSITIVE alternatives requiring an unquoted, unqualified, lowercase
 * function name. PostgreSQL accepts `SELECT PG_TRY_ADVISORY_LOCK(...)` (it folds an unquoted
 * identifier), `pg_catalog.PG_ADVISORY_LOCK(...)` (schema-qualified, which is what a
 * `search_path`-paranoid author writes) and `"pg_try_advisory_lock"(...)` (quoted, which is what a
 * generator emits) — and all three produced ZERO matches. A fifth raw session-lock holder written
 * in any of them, or an unrelated session lock added inside the classified factory file, walked
 * past this whole test while carrying exactly the pooler-induced split-lock risk it exists to
 * report.
 *
 * `_shared` is included because `pg_advisory_lock_shared` is a SESSION lock too — same lifetime,
 * same problem behind a transaction pooler. The `xact` forms are still deliberately out of scope
 * (see above), and `pg_advisory_unlock` is not a taking.
 *
 * ONE pattern, two regexes, so the detector and the key extractor cannot drift apart — a bypass in
 * one would otherwise be a bypass the other still reported, which is how a guard ends up half
 * true. The spellings are pinned in their own test below.
 */
const SESSION_LOCK_PATTERN = String.raw`(?:"?pg_catalog"?\s*\.\s*)?"?pg_(?:try_)?advisory_lock(?:_shared)?"?\s*\(`
const TAKES_A_SESSION_ADVISORY_LOCK = new RegExp(SESSION_LOCK_PATTERN, 'i')

/** A construction that opens its own connection, rather than asking the lock factory for one. */
const BUILDS_ITS_OWN_CONNECTION = /new\s+(?:pg\s*\.\s*)?(?:Pool|Client)\s*\(/

/**
 * THE FACTORY IS NOT ONE OF ITS OWN CALLERS (o3d-2k5r r26).
 *
 * `pgSessionLockConnectionConfig()` gained a leg that TAKES a session advisory lock: when
 * `DATABASE_SESSION_LOCK_URL` is set, it holds one on a connection made from the override and
 * requires a `DATABASE_URL` connection to be blocked by the same key, because matching database and
 * schema names do not prove the two URLs reach the same PostgreSQL. That holder cannot be built by
 * asking the lock factory — the factory's own `onConnect` is what runs the probe, so it would
 * recurse — and it does not need to be: the probe runs only AFTER the affinity leg has proved
 * directness on a connection to that same endpoint, which
 * `tests/db/session-lock-affinity.test.ts` pins ("an interposed lock connection is refused BEFORE
 * the probe is paid for"). And if the override WERE interposed, the holder's session lock would be
 * discarded between statements, the witness would not be blocked, and the override would be
 * refused — the failure is closed either way.
 *
 * So the factory file is classified rather than exempted, and the classification is checked two
 * ways below: exactly ONE file may claim it, and every session advisory lock IN that file must be
 * taken in the probe's own registered namespace. A future session lock added there for some other
 * purpose uses a different key and is reported.
 */
const DEFINES_THE_LOCK_FACTORY = /export function pgSessionLockConnectionConfig\(/
const SESSION_LOCK_CALL = new RegExp(`${SESSION_LOCK_PATTERN}\\s*([^,)]*)`, 'gi')

test('o3d-2k5r r25 / o3d-a5zz: every SESSION advisory lock is taken on a connection the lock factory built', () => {
  // MUTATION ROUTE: in any of `lib/db/pinned-advisory-lock.ts`,
  // `lib/connectors/xero/payment-write-lock.ts`, `lib/domain/wms/dispatch-sweep-lock.ts` or the
  // restore route, replace the factory call with `new Pool({ ...pgConnectionConfig(connectionString),
  // max: 4 })` — the r23 shape, which the test above still passes. That file reappears in
  // `offenders` here, and on an ASCII deployment behind a pooler its lock would silently stop
  // excluding anything.
  const files = runtimeSources()
  assert.ok(files.length > 400, `the walk must actually reach the runtime tree; it found ${files.length} files`)

  const holders: string[] = []
  const factories: string[] = []
  const offenders: string[] = []
  for (const file of files) {
    // Comments are not code — every one of these call sites now carries a WHY block that QUOTES the
    // construction it replaced and names `pg_try_advisory_lock`, so a raw-text rule would report the
    // fixed files as holders AND as offenders. Whole-line `//` only, so the `//` of a
    // `postgresql://` literal survives.
    const source = readFileSync(path.join(REPO_ROOT, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '')
    if (!TAKES_A_SESSION_ADVISORY_LOCK.test(source)) continue
    holders.push(file)
    if (DEFINES_THE_LOCK_FACTORY.test(source)) {
      factories.push(file)
      // The factory's own locks must all be the probe's, in the namespace the registry knows.
      const keys = [...source.matchAll(SESSION_LOCK_CALL)].map((match) => match[1]?.trim() ?? '')
      if (keys.length === 0) offenders.push(`${file} (claims to be the factory but takes no lock the scan can read)`)
      for (const key of keys) {
        if (key !== '${namespace}') offenders.push(`${file} takes a SESSION advisory lock on ${JSON.stringify(key)}, which is not the shared-lock-space probe's namespace`)
      }
      continue
    }
    const asksTheFactory = /createSessionAdvisoryLock(Pool|Client)/.test(source)
    if (!asksTheFactory || BUILDS_ITS_OWN_CONNECTION.test(source)) {
      offenders.push(`${file}${asksTheFactory ? ' (opens its own connection as well)' : ' (never asks the lock factory)'}`)
    }
  }
  // The classification may not spread: one file defines the factory, and it is the one that gets
  // to build its own lock connection.
  assert.deepEqual(factories, ['lib/db/database-url-schema.mjs'], `exactly one file defines the session-lock config factory; found ${factories.join(', ') || 'none'}`)

  // PRECONDITION, so this cannot pass by finding nothing: the four known holders are all present,
  // and the detector really did classify them.
  for (const holder of [
    'lib/db/pinned-advisory-lock.ts',
    'lib/connectors/xero/payment-write-lock.ts',
    'lib/domain/wms/dispatch-sweep-lock.ts',
    'app/api/backup/restore/route.ts',
  ]) {
    assert.ok(holders.includes(holder), `PRECONDITION: ${holder} takes a session advisory lock and the scan must see it; it saw ${holders.join(', ')}`)
  }

  assert.deepEqual(
    offenders,
    [],
    'these take a SESSION advisory lock on a connection the lock factory did not build, so nothing proves the ' +
      `connection reaches the backend directly and behind a transaction pooler the lock excludes nobody:\n${offenders.join('\n')}`,
  )
})

test('o3d-2k5r r25 / o3d-a5zz: the escape hatch is read in ONE place, so it reaches every lock or none', () => {
  // MUTATION ROUTE: read `process.env.DATABASE_SESSION_LOCK_URL` in one lock file instead of in the
  // factory. An operator setting it would then move some locks past the pooler and leave the others
  // refusing — a half-applied remedy, which is worse than none because it looks like it worked.
  const readers = runtimeSources().filter((file) => {
    const source = readFileSync(path.join(REPO_ROOT, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '')
    return /process\.env\[?\s*(SESSION_LOCK_DATABASE_URL_ENV|['"`]DATABASE_SESSION_LOCK_URL['"`])/.test(source)
  })
  assert.deepEqual(readers, ['lib/db/session-lock-pool.ts'], 'DATABASE_SESSION_LOCK_URL is read by the lock factory and by nothing else')
})

// ---------------------------------------------------------------------------
// Live: the lock pool's PHYSICAL connections go through the per-connection guard.
// ---------------------------------------------------------------------------

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

test('o3d-2k5r r23 (live): the money-post lock refuses a backend the deployment verdict is not about', async (t) => {
  const base = configuredDatabaseUrl()
  if (!base) { t.skip('no DATABASE_URL configured'); return }
  const name = `ims_lock_route_${randomBytes(6).toString('hex')}`
  const bootstrap = new pg.Client({ connectionString: base, connectionTimeoutMillis: 3_000 })
  try {
    await bootstrap.connect()
  } catch {
    await bootstrap.end().catch(() => undefined)
    t.skip('no reachable PostgreSQL')
    return
  }
  await bootstrap.query(`CREATE DATABASE ${name}`)
  await bootstrap.end().catch(() => undefined)
  const scratch = new URL(base)
  scratch.search = ''
  scratch.pathname = `/${name}`

  resetStartupOptionByteSafety()
  try {
    const schema = 'ten ant'
    const admin = new pg.Client({ connectionString: scratch.toString(), connectionTimeoutMillis: 3_000 })
    await admin.connect()
    await admin.query(`CREATE SCHEMA ${'"' + schema + '"'}`)
    await admin.end().catch(() => undefined)

    const url = `${scratch.toString()}?schema=${encodeURIComponent(schema)}`
    const carried = await establishStartupOptionByteSafety(url)
    if (!carried.carries) { t.skip('this server does not carry the byte, so there is no permission to hold to a backend'); return }

    // The endpoint now hands out a backend nothing measured — a failover, or a re-pointed pooler.
    // The verdict is re-established against a stand-in that answers as another server; the URL, the
    // config and the real server on the other end are unchanged.
    await establishStartupOptionByteSafety(url, {
      // It reports a DIRECT connection (its own socket, and a backend row naming that same
      // socket). Without those halves it would be refused since o3d-2k5r r24 for reporting NO
      // PEER, and the rejection below would stop being about the backend the verdict names.
      createClient: async () => ({
        connection: { stream: { localAddress: '10.9.9.9', localPort: 41000 } },
        async connect() { return undefined },
        async query(text: string) {
          if (text.startsWith('select pg_encoding_to_char')) {
            return { rows: [{ server_encoding: 'UTF8', lc_ctype: 'C.UTF-8', backend_address: '10.0.0.11', backend_port: '5432', server_version: '17.11', client_address: '10.9.9.9', client_port: '41000' }] }
          }
          return { rows: [{ startup_option_probe: 'a z' }] }
        },
        async end() { return undefined },
      }),
    })

    // ROUTE: withMoneyPostLock() -> acquirePinnedAdvisoryLockOrNull() -> the lock pool -> pg-pool's
    // onConnect -> the r22/r23 guard -> refusal, on a REAL connection to a REAL server.
    //
    // MUTATION ROUTE: put `new Pool({ connectionString, max: 4 })` back in getLockPool(). The pool
    // opens its connection, the lock IS taken, `ran` becomes true, and the money post proceeds on
    // an exclusion held by a pool that answers to nothing this deployment measured.
    const { withMoneyPostLock } = await import('@/lib/domain/accounting/money-post-lock')
    await withDatabaseUrl(url, async () => {
      let ran = false
      await assert.rejects(
        () => withMoneyPostLock({ connectorId: 'c', documentKind: 'INVOICE', documentId: 'd' } as never, async () => { ran = true }),
        (error: unknown) => {
          assert.ok(error instanceof DatabaseUrlSchemaConflictError)
          // Named, so this cannot pass on some OTHER refusal — the r24 absent-peer one, say.
          assert.match((error as Error).message, /handed the application a different backend/)
          assert.match((error as Error).message, /10\.0\.0\.11:5432/)
          return true
        },
        'the lock pool\'s physical connections are checked against the deployment verdict, like every other pool',
      )
      assert.equal(ran, false, 'and no money post ran under a lock that was refused')
    })
  } finally {
    resetStartupOptionByteSafety()
    const cleanup = new pg.Client({ connectionString: base, connectionTimeoutMillis: 3_000 })
    try {
      await cleanup.connect()
      await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    } finally {
      await cleanup.end().catch(() => undefined)
    }
  }
})

// ---------------------------------------------------------------------------
// o3d-2k5r r27, Codex MEDIUM: the detector above must read the spellings the SERVER accepts.
// ---------------------------------------------------------------------------

test('o3d-2k5r r27: the session-lock detector judges every spelling PostgreSQL accepts, not one lowercase one', () => {
  // MUTATION ROUTE: drop the `i` flag from `TAKES_A_SESSION_ADVISORY_LOCK`/`SESSION_LOCK_CALL`, or
  // remove the `"?` / `pg_catalog` alternatives from `SESSION_LOCK_PATTERN` — i.e. restore the r26
  // regexes. The uppercase, quoted and qualified cases below stop being judged, and with them a
  // fifth raw session-lock holder written that way walks past the scan above while carrying exactly
  // the split-lock risk it exists to report. VERIFIED: with the r26 regexes back AND one real
  // holder (`lib/domain/wms/dispatch-sweep-lock.ts`) rewritten in the uppercase spelling, the scan
  // above stops seeing it as a holder at all and its PRECONDITION fails.
  for (const spelling of [
    'const rows = await client.query(`SELECT PG_TRY_ADVISORY_LOCK(${params})`)',
    'await client.query("select pg_catalog.PG_ADVISORY_LOCK(1, 2)")',
    'await client.query(`select "pg_try_advisory_lock"(1, 2)`)',
    'await client.query(`select pg_catalog . pg_advisory_lock(1, 2)`)',
    'await client.query(`select "PG_CATALOG"."pg_try_advisory_lock"(1, 2)`)',
    'await client.query(`select pg_advisory_lock_shared(1, 2)`)',
    'await client.query(`select pg_try_advisory_lock(ns, key) as locked`)',
  ]) {
    assert.ok(TAKES_A_SESSION_ADVISORY_LOCK.test(spelling), `this takes a SESSION advisory lock and must be judged: ${spelling}`)
  }

  // AND IT STAYS OFF WHAT IS DELIBERATELY OUT OF SCOPE, or "judged" would mean nothing: a rule that
  // matches everything reports the whole repository and gets exempted into uselessness.
  for (const spelling of [
    'await client.query(`select pg_try_advisory_xact_lock(${namespace}, ${key}) as acquired`)',
    'await client.query(`select PG_ADVISORY_XACT_LOCK(1, 2)`)',
    'await client.query(`select pg_advisory_unlock(${params}) as unlocked`)',
    'await client.query("select pg_advisory_unlock_all()")',
  ]) {
    assert.ok(!TAKES_A_SESSION_ADVISORY_LOCK.test(spelling), `this is not a session lock being taken and must NOT be judged: ${spelling}`)
  }

  // The key extractor reads the FIRST argument through the same spellings — it is what decides
  // whether the factory file's own locks are the probe's, so a spelling it cannot parse is a
  // classified file whose locks are never checked.
  const keys = [...'select PG_CATALOG."PG_TRY_ADVISORY_LOCK"(4242, 7); select pg_advisory_lock_shared( 99 , 1)'.matchAll(SESSION_LOCK_CALL)]
    .map((match) => match[1]?.trim())
  assert.deepEqual(keys, ['4242', '99'], 'both calls are found and both first arguments are read')
})

// ---------------------------------------------------------------------------
// o3d-2k5r r27, Codex HIGH: and the acquisition gate is a property of the FACTORY.
// ---------------------------------------------------------------------------

/**
 * The exported lock factories in the factory file, and whether each routes through the gate.
 *
 * The call is matched with its OPTIONAL TYPE ARGUMENT — `gateOnFreshLockSpace<PoolClient>(` is the
 * real spelling in both factories, and a plain `includes('gateOnFreshLockSpace(')` reported both of
 * them as ungated while the gate was right there. Same class of defect as the SQL-spelling bypass
 * above: a reader that only knows one way of writing the thing it looks for.
 */
const ROUTES_THROUGH_THE_GATE = /gateOnFreshLockSpace\s*(?:<[^>]*>)?\s*\(/
function factoriesWithoutTheGate(source: string): string[] {
  const bodies = [...source.matchAll(/export function (createSessionAdvisoryLock\w+)[\s\S]*?\n}/g)]
  return bodies.filter((body) => !ROUTES_THROUGH_THE_GATE.test(body[0])).map((body) => body[1] ?? '?')
}

test('o3d-2k5r r27: every session-lock factory re-establishes the shared lock space for the ACQUISITION', () => {
  // WHY A READER RATHER THAN A NOTE. The probe used to be memoised for the life of the process, so
  // a verdict measured at boot went on authorising money movement after a failover re-pointed one
  // of the two endpoints (Codex HIGH). The fix is per-acquisition re-measurement, and it belongs to
  // the factory for the same reason the affinity proof does: a factory that forgets it is silent,
  // and the lock still returns `true`.
  //
  // IT DOES NOT CLAIM THE FINDING IS CLOSED. Per-acquisition re-measurement narrows the window from
  // the process's lifetime to milliseconds; it does not make a session advisory lock a sufficient
  // exclusion for money movement. That is o3d-ic9a (P0) and is not written in this branch.
  //
  // MUTATION ROUTE: replace `gateOnFreshLockSpace<PoolClient>(` in `createSessionAdvisoryLockPool`
  // with any other call. That factory's name appears below and this fails.
  const source = readFileSync(path.join(REPO_ROOT, 'lib/db/session-lock-pool.ts'), 'utf8')
  const named = [...source.matchAll(/export function (createSessionAdvisoryLock\w+)/g)].map((match) => match[1])
  assert.deepEqual(
    named.sort(),
    ['createSessionAdvisoryLockClient', 'createSessionAdvisoryLockPool'],
    `PRECONDITION: the scan must find both factories; it found ${named.join(', ') || 'none'}`,
  )
  assert.deepEqual(factoriesWithoutTheGate(source), [], 'these build a session-lock connection without re-establishing the shared lock space for the acquisition')

  // NOT VACUOUS: the same reader really does report a factory that drops the gate.
  assert.deepEqual(
    factoriesWithoutTheGate(
      'export function createSessionAdvisoryLockPool(purpose: string, max: number): Pool {\n  return new Pool({ ...sessionLockRoute(purpose).config, max })\n}',
    ),
    ['createSessionAdvisoryLockPool'],
  )
})
