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
      createClient: async () => ({
        async connect() { return undefined },
        async query(text: string) {
          if (text.startsWith('select pg_encoding_to_char')) {
            return { rows: [{ server_encoding: 'UTF8', lc_ctype: 'C.UTF-8', backend_address: '10.0.0.11', backend_port: '5432', server_version: '17.11' }] }
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
        DatabaseUrlSchemaConflictError,
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
