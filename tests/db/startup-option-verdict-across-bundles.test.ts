import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import { parse as parseDotenv } from 'dotenv'
import pg from 'pg'

/**
 * o3d-2k5r r20, Codex HIGH — ONE VERDICT PER PROCESS, NOT ONE PER COPY OF THE MODULE.
 *
 * Round 19 taught `lib/db/database-url-schema.mjs` to MEASURE whether this deployment's PostgreSQL
 * carries the non-ASCII bytes of a `?schema=` name, and to lift its refusal where it does. It kept
 * the answer in a module-local `let`. Codex found the hole by reading the BUILT ARTIFACT rather
 * than the source: `next build` emits this module into several chunks — one the instrumentation
 * hook pulls in, another the application's database construction pulls in, plus SSR and edge
 * copies — and each has its own binding. The probe therefore established a verdict in an instance
 * nothing else read, and the deployment it was measuring for was still refused at boot.
 *
 * WHY NO EXISTING TEST COULD SEE IT: every one of them imports the module once. One instance and
 * two instances are indistinguishable when there is only ever one. So these tests are written
 * around that specific blindness, and each says plainly what it does and does not establish:
 *
 *   1. TWO INSTANCES, ONE PROCESS. Two distinct module instances are created deliberately (the
 *      same file, two specifiers, which is exactly what a bundler produces), the probe is run in
 *      one and the pin is asked of the other. It asserts up front that the two really are separate
 *      instances, so it cannot pass by accidentally testing one. It CAN tell a shared verdict from
 *      two copies. It does NOT establish anything about what `next build` emits.
 *   2. THE BUILT ARTIFACT. Reads the chunks `next build` actually wrote, counts the copies of this
 *      module in them, and requires every copy to reach the process-wide slot. It CANNOT tell
 *      whether the running server behaves; it can tell that no shipped copy kept a private verdict.
 *   3. THE BUILT SERVER. Starts `next start` on the build in `.next`, twice, and asks a route that
 *      imports `lib/db` — the import alone constructs the adapter, so the refusal lands as a 500
 *      before any handler runs. That is the end-to-end statement Codex asked for.
 */

const MODULE_SPECIFIER = new URL('../../lib/db/database-url-schema.mjs', import.meta.url).href

type SchemaModule = typeof import('../../lib/db/database-url-schema.mjs')

/** A `pg.Client` stand-in that returns the probed characters unchanged: the server that carries them. */
function carryingClient() {
  return async (config: { options?: string }) => ({
    async connect() {
      return undefined
    },
    async query(text: string) {
      if (text.startsWith('select pg_encoding_to_char')) {
        return { rows: [{ server_encoding: 'UTF8', lc_ctype: 'C.UTF-8' }] }
      }
      const sent = /-c ims\.startup_option_probe=(.*)$/.exec(config.options ?? '')?.[1]
      return { rows: [{ startup_option_probe: sent?.replace(/\\(.)/g, '$1') }] }
    },
    async end() {
      return undefined
    },
  })
}

test('o3d-2k5r r20: the probe in one module instance settles the refusal in a DIFFERENT instance', async () => {
  // TWO INSTANCES OF THE SAME FILE. Node keys its module cache by resolved specifier, so a query
  // string produces a second, independent evaluation — the same condition Turbopack creates when
  // it copies this module into two chunks.
  const probeCopy = (await import(`${MODULE_SPECIFIER}?bundle=instrumentation`)) as SchemaModule
  const runtimeCopy = (await import(`${MODULE_SPECIFIER}?bundle=runtime`)) as SchemaModule

  // NON-VACUITY, AND THE WHOLE POINT: these must really be two copies. If this assertion ever
  // fails the test below proves nothing at all, because it would be probing and asking the same
  // instance — which is precisely how round 19's suite passed while the artifact was broken.
  assert.notEqual(
    probeCopy.startupOptionByteSafety,
    runtimeCopy.startupOptionByteSafety,
    'precondition: the two imports are separate module instances, not one cached one',
  )
  assert.notEqual(probeCopy.pgConnectionConfig, runtimeCopy.pgConnectionConfig)

  const schema = 'ten\u00A0ant' // U+00A0, the character the whole finding is about
  const url = `postgresql://app:pw@db.internal:5432/ims?schema=${encodeURIComponent(schema)}`

  probeCopy.resetStartupOptionByteSafety()

  // PRECONDITION: unprobed, the runtime instance refuses — so what follows is a lift and not a
  // test of a gate that was never closed.
  assert.throws(
    () => runtimeCopy.pgConnectionConfig(url),
    runtimeCopy.DatabaseUrlSchemaConflictError,
    'unprobed, the runtime instance refuses the Unicode schema',
  )

  // THE PROBE RUNS IN THE OTHER INSTANCE ONLY. Nothing is called on `runtimeCopy` to establish
  // anything; instrumentation.ts is the only caller in production and it holds one copy.
  const verdict = await probeCopy.establishStartupOptionByteSafety(url, { createClient: carryingClient() })
  assert.equal(verdict.carries, true, 'precondition: the probing instance measured a server that carries the bytes')

  // MUTATION ROUTE: restore round 19's `let startupOptionByteVerdict = NO_VERDICT` and have
  // startupOptionByteSafety()/settle()/nonAsciiOptionByteIsCarried() read and write it instead of
  // the `Symbol.for('ims.db.startupOptionByteVerdict.v1')` slot on globalThis. The runtime
  // instance then still holds NO_VERDICT, every assertion below throws
  // DatabaseUrlSchemaConflictError, and that is the shipped failure: a measured, working
  // deployment refused at boot with an instruction to rename its schema.
  assert.equal(runtimeCopy.startupOptionByteSafety().carries, true, 'the other instance sees the verdict')
  assert.equal(runtimeCopy.startupOptionByteSafety().probed, '\u00A0')
  assert.equal(runtimeCopy.resolveDatabaseUrlSchema(url).schema, schema, 'and carries the name the probe measured')
  // The pin carries the measured character in the module's own emitted spelling — escaped by
  // `escapeLibpqValue()`, which is the spelling the probe round-tripped through the server.
  assert.equal(
    runtimeCopy.pgConnectionConfig(url).options,
    '-c search_path="ten\\\u00A0ant"',
    'and pins it in the spelling the probe measured',
  )

  // A THIRD INSTANCE, IMPORTED AFTER THE FACT, joins the same verdict — which is the deployment
  // ordering: instrumentation probes, and the chunk that builds the adapter is evaluated later.
  const lateCopy = (await import(`${MODULE_SPECIFIER}?bundle=late`)) as SchemaModule
  assert.notEqual(lateCopy.startupOptionByteSafety, probeCopy.startupOptionByteSafety)
  assert.equal(lateCopy.startupOptionByteSafety().carries, true, 'a copy evaluated after the probe sees it too')

  // AND THE RESET IS PROCESS-WIDE TOO, or tests would inherit one another's server through the
  // slot they now share.
  runtimeCopy.resetStartupOptionByteSafety()
  assert.equal(probeCopy.startupOptionByteSafety().established, false, 'a reset in one instance clears all of them')
  assert.throws(() => lateCopy.pgConnectionConfig(url), lateCopy.DatabaseUrlSchemaConflictError)
})

test('o3d-2k5r r20: a slot holding something this module did not write reads as NO VERDICT', async () => {
  const copy = (await import(`${MODULE_SPECIFIER}?bundle=guard`)) as SchemaModule
  const slot = Symbol.for('ims.db.startupOptionByteVerdict.v1')
  const globals = globalThis as unknown as Record<symbol, unknown>
  copy.resetStartupOptionByteSafety()
  try {
    // MUTATION ROUTE: drop the `isStartupOptionByteVerdict()` shape check from
    // heldStartupOptionByteVerdict() and return whatever is in the slot. Each of these then
    // becomes a "verdict" — the last one licenses the very refusal this module exists to make,
    // on the word of anything at all that can write a global.
    for (const planted of [
      'yes',
      42,
      null,
      {},
      { established: true, carries: true },
      { established: 'true', carries: 'true', probed: '\u00A0', target: null, serverEncoding: null, lcCtype: null, reason: 'x' },
    ]) {
      globals[slot] = planted
      const verdict = copy.startupOptionByteSafety()
      assert.equal(verdict.established, false, `a ${JSON.stringify(planted)} slot is not a verdict`)
      assert.equal(verdict.carries, false)
      assert.equal(verdict.reason, 'no deployment probe has run in this process')
      assert.throws(
        () => copy.pgConnectionConfig('postgresql://app:pw@db.internal:5432/ims?schema=' + encodeURIComponent('ténant')),
        copy.DatabaseUrlSchemaConflictError,
        'and it fails CLOSED: the refusal stands',
      )
    }
  } finally {
    delete globals[slot]
    copy.resetStartupOptionByteSafety()
  }
})

// ---------------------------------------------------------------------------
// THE BUILT ARTIFACT — the evidence that was missing, read the way Codex read it.
// ---------------------------------------------------------------------------

/** Every file under `dir` (recursively) whose name ends in `.js`. */
function jsFilesUnder(dir: string): string[] {
  const found: string[] = []
  const walk = (current: string) => {
    let entries: string[]
    try {
      entries = readdirSync(current)
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(current, entry)
      let stats
      try {
        stats = statSync(path)
      } catch {
        continue
      }
      if (stats.isDirectory()) walk(path)
      else if (entry.endsWith('.js')) found.push(path)
    }
  }
  walk(dir)
  return found
}

const NEXT_BUILD_DIR = new URL('../../.next/', import.meta.url).pathname

test('o3d-2k5r r20: every copy of this module in the built output reaches the process-wide slot', (t: TestContext) => {
  if (!existsSync(join(NEXT_BUILD_DIR, 'BUILD_ID'))) {
    t.skip('no .next build output; run `npm run build` first — this check reads what the bundler emitted')
    return
  }

  // The probe's custom GUC name appears in exactly one module, so it identifies a bundled copy of
  // it without depending on how the bundler names chunks.
  const marker = 'ims.startup_option_probe'
  const copies = jsFilesUnder(NEXT_BUILD_DIR).filter((file) => readFileSync(file, 'utf8').includes(marker))

  // NON-VACUITY: if no copy is found, the marker or the layout changed and this test is asserting
  // over an empty set — which is a failure, not a pass.
  assert.ok(copies.length > 0, `no bundled copy of database-url-schema.mjs found under ${NEXT_BUILD_DIR}`)

  // THIS IS THE FINDING, MEASURED: the module is emitted more than once. The count is reported so
  // a build that stopped duplicating it cannot quietly turn the check below into a tautology.
  t.diagnostic(`bundled copies carrying the probe: ${copies.length}`)

  // MUTATION ROUTE: restore the module-local `let`. Not one emitted copy then mentions the shared
  // slot and every one of these fails — which is the state of the artifact Codex reviewed.
  for (const file of copies) {
    const source = readFileSync(file, 'utf8')
    assert.match(
      source,
      /Symbol\.for\((["'])ims\.db\.startupOptionByteVerdict\.v1\1\)/,
      `${file.slice(NEXT_BUILD_DIR.length)} keeps a private verdict instead of the process-wide one`,
    )
  }
})

// ---------------------------------------------------------------------------
// THE BUILT SERVER — `next build` output started with `next start`, not a direct module import.
// ---------------------------------------------------------------------------

function configuredDatabaseUrl(): string | null {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  for (const file of ['../../.env.local', '../../.env']) {
    try {
      const parsed = parseDotenv(readFileSync(new URL(file, import.meta.url)))
      if (parsed.DATABASE_URL) return parsed.DATABASE_URL
    } catch {
      // absent or unreadable: try the next one
    }
  }
  return null
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

type ServerRun = { status: number | null; stderr: string; reached: boolean }

/**
 * Start the BUILT server with `databaseUrl` and ask one route that imports `lib/db`.
 *
 * `/api/notifications` is chosen because its module imports `@/lib/db`, whose adapter is
 * constructed at module scope: when the schema refusal fires it fires during module evaluation, so
 * the response is a 500 before the handler is entered. Unauthenticated it otherwise answers 401
 * (the session strategy is JWT, so nothing touches the database), which is why a non-500 here is a
 * statement about `lib/db` initialising and not about the database's contents.
 */
async function askBuiltServer(databaseUrl: string, timeoutMs = 90_000): Promise<ServerRun> {
  const port = await freePort()
  const child = spawn('node_modules/.bin/next', ['start', '--port', String(port), '--hostname', '127.0.0.1'], {
    cwd: new URL('../../', import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: 'production', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })

  const deadline = Date.now() + timeoutMs
  let reached = false
  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break
      try {
        // ANY HTTP RESPONSE MEANS IT IS LISTENING, and readiness must be judged that way rather
        // than by a 200: in the control run below `lib/db` refuses at import, so every route that
        // reaches it — `/api/health` among them — answers 500. Waiting for an OK there would time
        // the control out instead of measuring it.
        const probe = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2_000) })
        if (probe.status > 0) {
          reached = true
          break
        }
      } catch {
        // not listening yet
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    if (!reached) return { status: null, stderr, reached }

    const response = await fetch(`http://127.0.0.1:${port}/api/notifications`, { signal: AbortSignal.timeout(20_000) })
    // Give the server a moment to flush the stack trace behind a 500.
    await new Promise((resolve) => setTimeout(resolve, 500))
    return { status: response.status, stderr, reached }
  } finally {
    child.kill('SIGTERM')
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve(undefined)
      }, 5_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve(undefined)
      })
    })
  }
}

test('o3d-2k5r r20 (built server): the probe instrumentation runs lets the RUNTIME carry the schema', { timeout: 300_000 }, async (t: TestContext) => {
  if (!existsSync(join(NEXT_BUILD_DIR, 'BUILD_ID'))) {
    t.skip('no .next build output; this check starts the built server, so it needs `npm run build` first')
    return
  }
  const base = configuredDatabaseUrl()
  if (!base) {
    t.skip('no DATABASE_URL configured; the probe needs a reachable PostgreSQL to measure')
    return
  }

  // A THROWAWAY DATABASE with a Unicode schema in it. Nothing is migrated and no table is made:
  // the route under test is refused (or not) at import, before any query.
  const name = `ims_bundle_probe_${randomBytes(6).toString('hex')}`
  const schema = 'ten\u00A0ant'
  const bootstrap = new pg.Client({ connectionString: base, connectionTimeoutMillis: 3_000 })
  try {
    await bootstrap.connect()
  } catch {
    await bootstrap.end().catch(() => undefined)
    t.skip('no reachable PostgreSQL; the built-server check is skipped')
    return
  }
  try {
    await bootstrap.query(`CREATE DATABASE ${name}`)
  } catch (error) {
    await bootstrap.end().catch(() => undefined)
    t.skip(`cannot create a throwaway database (${error instanceof Error ? error.message : String(error)})`)
    return
  }
  await bootstrap.end().catch(() => undefined)

  const scratchUrl = new URL(base)
  scratchUrl.search = ''
  scratchUrl.pathname = `/${name}`
  const carried = `${scratchUrl.toString()}?schema=${encodeURIComponent(schema)}`

  const admin = new pg.Client({ connectionString: scratchUrl.toString(), connectionTimeoutMillis: 3_000 })
  await admin.connect()
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
  } finally {
    await admin.end().catch(() => undefined)
  }

  try {
    // THE CONTROL, AND IT NEEDS NO SECOND BUILD: the same artifact, the same Unicode schema, but a
    // server the probe cannot reach. Instrumentation then establishes nothing, and the refusal is
    // reached through the built runtime — proving this route really does run the code under test
    // and that a pass below is not the route being incapable of failing.
    const unreachable = `postgresql://app:pw@127.0.0.1:1/${name}?schema=${encodeURIComponent(schema)}`
    const refused = await askBuiltServer(unreachable)
    assert.equal(refused.reached, true, `the built server did not start for the control run: ${refused.stderr.slice(-2000)}`)
    assert.equal(refused.status, 500, 'unprobed, the built runtime refuses the Unicode schema')
    assert.match(
      refused.stderr,
      /DatabaseUrlSchemaConflictError|ALTER SCHEMA "<current name>" RENAME TO <ascii_name>;/,
      'and it is THIS refusal, named, that the built runtime raised',
    )

    // MUTATION ROUTE: restore the module-local `let`. Instrumentation still probes the reachable
    // server successfully and the verdict still lands — in a copy of the module that the chunk
    // building the adapter is not. This run then returns 500 with the same refusal as the control
    // above, which is exactly what the shipped artifact did.
    const measured = await askBuiltServer(carried)
    assert.equal(measured.reached, true, `the built server did not start: ${measured.stderr.slice(-2000)}`)
    t.diagnostic(`built server answered /api/notifications with ${measured.status}`)
    assert.notEqual(measured.status, 500, `the built runtime still refused a measured schema: ${measured.stderr.slice(-4000)}`)
    assert.doesNotMatch(
      measured.stderr,
      /no deployment probe has run in this process|ALTER SCHEMA "<current name>" RENAME TO <ascii_name>;/,
      'and the refusal the probe was supposed to lift is nowhere in the server log',
    )
  } finally {
    const cleanup = new pg.Client({ connectionString: base, connectionTimeoutMillis: 3_000 })
    await cleanup.connect().catch(() => undefined)
    await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined)
    await cleanup.end().catch(() => undefined)
  }
})
