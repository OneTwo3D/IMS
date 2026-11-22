/**
 * The first-load archive command's IMS target, driven behaviourally (#1128 R2 LOW-A, LOW-D, LOW-E): the session connection
 * (lib/db/first-load-archive-target.ts) over a FAKE session client, and the env-file opener (scripts/lib/first-load-archive-open-target.ts) over a
 * synthetic env file. No database and no network: the client is a double that records what it was asked.
 */
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { ARCHIVE_TARGET_LOCK_STATEMENTS, ArchiveTargetRefused, openArchiveTargetConnection, type ArchiveSessionClient } from '../../lib/db/first-load-archive-target.ts'
import { FIRST_LOAD_WMS_ARCHIVE_LOCK_KEY } from '../../lib/db/advisory-locks.ts'
import { SESSION_LOCK_DATABASE_URL_ENV } from '../../lib/db/database-url-schema.mjs'
import { openArchiveTarget } from '../../scripts/lib/first-load-archive-open-target.ts'

const URL_A = 'postgresql://synthetic@127.0.0.1:1/ims_synthetic'

type Fake = { created: Array<{ purpose: string; extra: Record<string, unknown>; databaseUrl: string | undefined }>; queries: Array<{ sql: string; values?: unknown[] }>; connected: number; ended: number }
function fakeFactory(env: Record<string, string | undefined>, answer: (sql: string) => unknown[] = () => [{ locked: true }]) {
  const fake: Fake = { created: [], queries: [], connected: 0, ended: 0 }
  const createClient = (purpose: string, extra: Record<string, unknown>): ArchiveSessionClient => {
    fake.created.push({ purpose, extra, databaseUrl: env.DATABASE_URL })
    return {
      connect: async () => { fake.connected++ },
      query: async (sql: string, values?: unknown[]) => { fake.queries.push({ sql, values }); return { rows: answer(sql) } },
      end: async () => { fake.ended++ },
    }
  }
  return { fake, createClient }
}

// [mutation: tryLock always answers true, the key or statement changes, or the file's DATABASE_URL is not the one the factory reads] (#1128 R2 LOW-D)
test('the session connection: the factory reads the file\'s DATABASE_URL; tryLock is the registered key\'s try-lock and answers what the server said', async () => {
  for (const [rows, expected] of [[[{ locked: true }], true], [[{ locked: false }], false], [[], false], [[{ locked: 'true' }], false], [[{ locked: true }, { locked: true }], false]] as Array<[unknown[], boolean]>) {
    const env: Record<string, string | undefined> = { DATABASE_URL: 'postgresql://inherited@127.0.0.1:2/other' }
    const { fake, createClient } = fakeFactory(env, (sql) => (sql === ARCHIVE_TARGET_LOCK_STATEMENTS.lock ? rows : []))
    const connection = await openArchiveTargetConnection({ databaseUrl: URL_A }, 'synthetic-app', { createClient, processEnv: env })
    assert.equal(fake.created.length, 1)
    assert.equal(fake.created[0]!.databaseUrl, URL_A, 'the factory saw the env file\'s DATABASE_URL, not the inherited one')
    assert.equal(fake.created[0]!.purpose, 'the first-load archive run lock')
    assert.deepEqual(fake.created[0]!.extra, { connectionTimeoutMillis: 10_000, application_name: 'synthetic-app' })
    assert.equal(fake.connected, 1)
    assert.equal(await connection.tryLock(), expected, JSON.stringify(rows))
    assert.deepEqual(fake.queries.at(-1), { sql: 'select pg_try_advisory_lock($1::bigint) as locked', values: [FIRST_LOAD_WMS_ARCHIVE_LOCK_KEY] })
    await connection.unlock()
    assert.deepEqual(fake.queries.at(-1), { sql: 'select pg_advisory_unlock($1::bigint) as unlocked', values: [FIRST_LOAD_WMS_ARCHIVE_LOCK_KEY] })
    assert.deepEqual(await connection.query('select 1', [7]), { rows: [] })
    assert.deepEqual(fake.queries.at(-1), { sql: 'select 1', values: [7] })
    await connection.close()
    assert.equal(fake.ended, 1)
  }
})

// [mutation: a shell-exported DATABASE_SESSION_LOCK_URL is used silently] (#1128 R2 LOW-A)
test('a process environment that carries DATABASE_SESSION_LOCK_URL is refused before any client is built', async () => {
  for (const value of ['postgresql://direct@127.0.0.1:3/ims_synthetic', '']) {
    const env: Record<string, string | undefined> = { [SESSION_LOCK_DATABASE_URL_ENV]: value }
    const { fake, createClient } = fakeFactory(env)
    await assert.rejects(openArchiveTargetConnection({ databaseUrl: URL_A }, 'synthetic-app', { createClient, processEnv: env }), (error: unknown) => {
      assert.ok(error instanceof ArchiveTargetRefused)
      assert.match((error as Error).message, /the process environment carries DATABASE_SESSION_LOCK_URL \(exported in the shell\?\)/)
      assert.ok(!(error as Error).message.includes('postgresql://'), 'no URL in the message')
      return true
    })
    assert.equal(fake.created.length, 0)
    assert.equal(env.DATABASE_URL, undefined, 'DATABASE_URL was not touched')
  }
})

const dir = mkdtempSync(path.join(tmpdir(), 'archive-open-target-'))
after(() => rmSync(dir, { recursive: true, force: true }))
function envFile(lines: string[]): string {
  const file = path.join(dir, `ims-${Math.random().toString(16).slice(2)}.env`)
  writeFileSync(file, `${lines.join('\n')}\n`)
  chmodSync(file, 0o600)
  return file
}

// [mutation: the command is handed the operator's shell instead of the env file's environment, or the env-file / shell override refusal is dropped] (#1128 R2 LOW-E)
test('the env-file opener: the target environment is the env file\'s (built.env), the database the file\'s DATABASE_URL; an override in the file or the shell refuses', async () => {
  const shell = { PATH: '/usr/bin', HOME: '/home/synthetic', MINTSOFT_WRITES_LIVE_FROM: '2026-01-01T00:00:00Z', MINTSOFT_WRITE_ALLOWED: 'https://shell.example.test|89', DATABASE_URL: 'postgresql://shell@127.0.0.1:2/other' }
  const opened: Array<{ databaseUrl: string; app: string }> = []
  const open = async (target: { databaseUrl: string }, app: string) => {
    opened.push({ databaseUrl: target.databaseUrl, app })
    return { query: async () => ({ rows: [] }), tryLock: async () => true, unlock: async () => {}, close: async () => {} }
  }
  const file = envFile([`DATABASE_URL=${URL_A}`, 'MINTSOFT_WRITE_ALLOWED=https://target.example.test|89', 'PRODUCER_HOLD_ENFORCED_DESTINATIONS=all'])
  const target = await openArchiveTarget(file, 'synthetic-app', { open, parentEnv: shell })
  assert.deepEqual(opened, [{ databaseUrl: URL_A, app: 'synthetic-app' }])
  assert.deepEqual(target.env, { HOME: '/home/synthetic', PATH: '/usr/bin', DATABASE_URL: URL_A, MINTSOFT_WRITE_ALLOWED: 'https://target.example.test|89', PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'all' }, 'the file\'s variables and the short whitelist only: the shell\'s live-from and grant are not the target\'s')

  const inFile = envFile([`DATABASE_URL=${URL_A}`, `${SESSION_LOCK_DATABASE_URL_ENV}=postgresql://direct@127.0.0.1:3/ims_synthetic`])
  await assert.rejects(openArchiveTarget(inFile, 'synthetic-app', { open, parentEnv: shell }), /the env file sets DATABASE_SESSION_LOCK_URL; this command uses the file's DATABASE_URL as a direct session only/)
  assert.equal(opened.length, 1, 'nothing opened for the refused file')

  // The shell export is refused by the real connection, and its message reaches the operator (not the generic "could not be reached").
  const viaShell = (t: { databaseUrl: string }, app: string) => openArchiveTargetConnection(t, app, { processEnv: { [SESSION_LOCK_DATABASE_URL_ENV]: 'postgresql://direct@127.0.0.1:3/x' }, createClient: () => { throw new Error('not built') } })
  await assert.rejects(openArchiveTarget(file, 'synthetic-app', { open: viaShell, parentEnv: shell }), /the process environment carries DATABASE_SESSION_LOCK_URL/)
  // Any other failure to connect is the short generic message, never the error's own text (it may carry the URL).
  await assert.rejects(openArchiveTarget(file, 'synthetic-app', { open: async () => { throw new Error(`connect ECONNREFUSED ${URL_A}`) }, parentEnv: shell }), (error: unknown) => {
    assert.equal((error as Error).message, 'the database named by the env file could not be reached on a direct session')
    return true
  })
})

test('the script wires the env-file opener, the retirement kind and nothing of its own', () => {
  const script = readFileSync(path.join(process.cwd(), 'scripts/first-load-mintsoft-archive.ts'), 'utf8')
  assert.match(script, /openTarget: \(envFile\) => openArchiveTarget\(envFile, APPLICATION_NAME\)/)
  assert.match(script, /retirementEvidenceKind: ARCHIVE_RETIREMENT_ATTESTATION_KIND/)
  assert.doesNotMatch(script, /openArchiveTargetConnection|buildExportEnv|readEnvFile/, 'the opener is the tested module, not a copy in the script')
})
