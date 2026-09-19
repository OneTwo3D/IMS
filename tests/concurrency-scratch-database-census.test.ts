import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * THE CONCURRENCY TIER CANNOT REACH A DATABASE THE SCRATCH GUARD HAS NOT VERIFIED (o3d-yvn8).
 *
 * The barrier is two pieces, and this census fails if either stops covering every file:
 *   · tests/concurrency/scratch-database-preload.mts, loaded by `npm run test:concurrency` with
 *     `--import`, verifies the database (the scratch guard) before any test file is loaded;
 *   · tests/concurrency/scratch-database-setup.ts, every file's FIRST import, throws at import when
 *     the tier is on but nothing was verified in this process — so a run that bypasses the preload
 *     loads no file at all.
 *
 * No database is needed: every check here is on the source, the npm script, or a child process
 * whose DATABASE_URL is deliberately not a URL, so the guard refuses before it connects anywhere.
 */

const REPO = fileURLToPath(new URL('..', import.meta.url))
const TIER = join(REPO, 'tests', 'concurrency')
const SETUP_IMPORT = "import './scratch-database-setup'"

function tierFiles(): string[] {
  return readdirSync(TIER).filter((name) => name.endsWith('.test.ts')).sort()
}

/** The first `import` statement in a file, ignoring comments that precede it. */
function firstImport(source: string): string | undefined {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((line) => !line.trim().startsWith('//'))
  return code.find((line) => /^\s*import\b/.test(line))?.trim()
}

test('every test file in tests/concurrency imports the scratch-database setup FIRST', () => {
  const files = tierFiles()
  // Precondition, so this cannot pass by examining nothing: the tier is not empty.
  assert.ok(files.length >= 30, `precondition: found ${files.length} tier files`)
  const missing: string[] = []
  for (const name of files) {
    const first = firstImport(readFileSync(join(TIER, name), 'utf8'))
    if (!first?.startsWith(SETUP_IMPORT)) missing.push(`${name}: first import is ${JSON.stringify(first)}`)
  }
  assert.deepEqual(missing, [], `these tier files can load (and write) before the scratch database is verified:\n${missing.join('\n')}`)
})

test('npm run test:concurrency preloads the scratch-database barrier for the whole tier', () => {
  const script = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).scripts['test:concurrency'] as string
  assert.match(script, /RUN_DB_CONCURRENCY_TESTS=1/, 'the tier must be switched on by the script')
  assert.match(script, /--import \.\/tests\/concurrency\/scratch-database-preload\.mts/, `the preload is missing: ${script}`)
  assert.match(script, /tests\/concurrency\/\*\*\/\*\.test\.ts/, 'the preload must cover the whole tier glob')
})

test('the preload and the setup share one marker key', () => {
  const preload = readFileSync(join(TIER, 'scratch-database-preload.mts'), 'utf8')
  const setup = readFileSync(join(TIER, 'scratch-database-setup.ts'), 'utf8')
  const key = /Symbol\.for\('([^']+)'\)/
  assert.equal(preload.match(key)?.[1], 'o3d.scratchDatabaseVerified')
  assert.equal(setup.match(key)?.[1], 'o3d.scratchDatabaseVerified')
})

/** Run `tsx` in a child with a controlled environment (no DATABASE_URL that reaches a server). */
function tsx(args: string[], env: Record<string, string | undefined>) {
  const clean: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(DATABASE_URL|IMS_CONCURRENCY_SCRATCH_DB|RUN_DB_CONCURRENCY_TESTS|DATABASE_SESSION_LOCK_URL)$/.test(key)) {
      clean[key] = value
    }
  }
  for (const [key, value] of Object.entries(env)) if (value !== undefined) clean[key] = value
  return spawnSync(join(REPO, 'node_modules', '.bin', 'tsx'), args, { cwd: REPO, env: clean as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 60_000 })
}

test('with the tier on, importing the setup WITHOUT the preload throws — a direct run loads no file', () => {
  const run = tsx(['-e', "require('./tests/concurrency/scratch-database-setup.ts'); console.log('LOADED')"], {
    RUN_DB_CONCURRENCY_TESTS: '1',
  })
  assert.notEqual(run.status, 0, `the import must fail: ${run.stdout}${run.stderr}`)
  assert.doesNotMatch(run.stdout, /LOADED/)
  assert.match(run.stderr, /REFUSING to load a concurrency test/)
  // Control: with the tier off (every test:unit run), the same import is a no-op.
  const off = tsx(['-e', "require('./tests/concurrency/scratch-database-setup.ts'); console.log('LOADED')"], {})
  assert.equal(off.status, 0, off.stderr)
  assert.match(off.stdout, /LOADED/)
})

test('the preload refuses — and nothing after it loads — when the guard refuses', () => {
  // DATABASE_URL is not a URL, so the guard refuses before opening any connection.
  const run = tsx(['--import', './tests/concurrency/scratch-database-preload.mts', '-e', "console.log('LOADED')"], {
    RUN_DB_CONCURRENCY_TESTS: '1',
    DATABASE_URL: 'not-a-url',
  })
  assert.notEqual(run.status, 0, `the preload must fail: ${run.stdout}${run.stderr}`)
  assert.doesNotMatch(run.stdout, /LOADED/)
  assert.match(run.stderr, /NotAScratchDatabaseError|REFUSING before any write/)
})
