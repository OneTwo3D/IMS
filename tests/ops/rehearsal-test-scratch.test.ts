import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { type TestContext, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { TEST_SCRATCH_PARENT_ENV, testScratchParentOptIn } from '@/lib/ops/rehearsal-test-scratch'
import { REHEARSAL_EXIT } from '@/lib/ops/first-install-rehearsal'
import { runRehearsal } from '@/scripts/rehearse-first-install'
import { runWooImportRehearsal } from '@/scripts/rehearse-woo-import'
import { scratchRoot } from '../helpers/scratch-root'

const REPO = fileURLToPath(new URL('../..', import.meta.url))
const SCRATCH = 'IMS_SCRATCH_ROOT'

/**
 * THE TEST-ONLY OPT-IN FOR A RAM-BACKED REHEARSAL PARENT.
 *
 * The directories below are real ones that exist on every host: /var/tmp (root-owned, sticky), /usr (root-owned, not sticky) and /dev/shm (tmpfs, root-owned, sticky).
 * The decision function takes its environment as an argument, so no test needs to be root or to change a real variable.
 */

const ROOT_STICKY = '/var/tmp'

function privateDir(t: TestContext): string {
  const dir = mkdtempSync(join(scratchRoot(), 'ims-optin-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('opt-in unset or empty: not requested, so the production refusal applies untouched', () => {
  assert.deepEqual(testScratchParentOptIn(ROOT_STICKY, {}), { requested: false })
  assert.deepEqual(testScratchParentOptIn(ROOT_STICKY, { [TEST_SCRATCH_PARENT_ENV]: '', [SCRATCH]: ROOT_STICKY }), { requested: false })
  // A configured scratch root alone never opts in.
  assert.deepEqual(testScratchParentOptIn(ROOT_STICKY, { [SCRATCH]: ROOT_STICKY }), { requested: false })
})

test('opt-in with a valid parent (root-owned, sticky, inside IMS_SCRATCH_ROOT, rehearsal root inside it) is accepted', () => {
  assert.equal(statSync(ROOT_STICKY).uid, 0, 'precondition: /var/tmp is root-owned')
  assert.ok((statSync(ROOT_STICKY).mode & 0o1000) !== 0, 'precondition: /var/tmp is sticky')
  assert.deepEqual(testScratchParentOptIn(ROOT_STICKY, { [TEST_SCRATCH_PARENT_ENV]: ROOT_STICKY, [SCRATCH]: ROOT_STICKY }), { requested: true, accepted: true })
  // The opted-in directory may sit below the scratch root, and the rehearsal root below it.
  assert.deepEqual(testScratchParentOptIn(ROOT_STICKY, { [TEST_SCRATCH_PARENT_ENV]: ROOT_STICKY, [SCRATCH]: '/var' }), { requested: true, accepted: true })
})

test('opt-in naming a parent that is not root-owned is refused', (t) => {
  const dir = privateDir(t)
  const result = testScratchParentOptIn(dir, { [TEST_SCRATCH_PARENT_ENV]: dir, [SCRATCH]: scratchRoot() })
  assert.equal(result.requested, true)
  assert.equal(result.requested && result.accepted, false)
  assert.match(result.requested && !result.accepted ? result.reason : '', /not root/)
})

test('opt-in naming a root-owned parent that is not sticky is refused', () => {
  assert.equal(statSync('/usr').uid, 0, 'precondition: /usr is root-owned')
  assert.equal(statSync('/usr').mode & 0o1000, 0, 'precondition: /usr is not sticky')
  const result = testScratchParentOptIn('/usr', { [TEST_SCRATCH_PARENT_ENV]: '/usr', [SCRATCH]: '/' })
  assert.equal(result.requested && result.accepted, false)
  assert.match(result.requested && !result.accepted ? result.reason : '', /not sticky/)
})

test('opt-in naming a parent outside IMS_SCRATCH_ROOT is refused, and so is an unset IMS_SCRATCH_ROOT', () => {
  const outside = testScratchParentOptIn(ROOT_STICKY, { [TEST_SCRATCH_PARENT_ENV]: ROOT_STICKY, [SCRATCH]: '/usr' })
  assert.equal(outside.requested && outside.accepted, false)
  assert.match(outside.requested && !outside.accepted ? outside.reason : '', /not inside IMS_SCRATCH_ROOT/)
  const unset = testScratchParentOptIn(ROOT_STICKY, { [TEST_SCRATCH_PARENT_ENV]: ROOT_STICKY })
  assert.equal(unset.requested && unset.accepted, false)
  assert.match(unset.requested && !unset.accepted ? unset.reason : '', /IMS_SCRATCH_ROOT is not set/)
})

test('opt-in refuses a relative path, a missing path, a symlink, and a rehearsal root outside the opted-in parent', (t) => {
  const reason = (r: ReturnType<typeof testScratchParentOptIn>): string => (r.requested && !r.accepted ? r.reason : 'ACCEPTED')
  assert.match(reason(testScratchParentOptIn(ROOT_STICKY, { [TEST_SCRATCH_PARENT_ENV]: 'var/tmp', [SCRATCH]: '/' })), /not an absolute path/)
  assert.match(reason(testScratchParentOptIn(ROOT_STICKY, { [TEST_SCRATCH_PARENT_ENV]: '/var/tmp/ims-no-such-dir-xyz', [SCRATCH]: '/' })), /cannot be inspected/)
  const dir = privateDir(t)
  const link = join(dir, 'link')
  symlinkSync(ROOT_STICKY, link)
  assert.match(reason(testScratchParentOptIn(ROOT_STICKY, { [TEST_SCRATCH_PARENT_ENV]: link, [SCRATCH]: '/' })), /is a symlink/)
  assert.match(reason(testScratchParentOptIn('/usr', { [TEST_SCRATCH_PARENT_ENV]: ROOT_STICKY, [SCRATCH]: '/' })), /not inside \/var\/tmp/)
})

// ---- Through the two commands: the refusal for a RAM-backed parent is the production one unless the opt-in is valid. ----

function withEnv(t: TestContext, values: Record<string, string | undefined>): void {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]))
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })
}

const shmRuns = (): string[] => readdirSync('/dev/shm').filter((name) => name.startsWith('ims-rehearsal-'))
// A report directory that can never be created: a rehearsal that got past the RAM refusal stops here, before any cluster exists.
const IMPOSSIBLE_REPORT_DIR = '/etc/passwd/reports'

for (const [name, run] of [
  ['first-install', (parentDir: string) => runRehearsal({ parentDir, reportDir: IMPOSSIBLE_REPORT_DIR, log: () => undefined })],
  ['woo-import', (parentDir: string) => runWooImportRehearsal({ parentDir, reportDir: IMPOSSIBLE_REPORT_DIR, log: () => undefined })],
] as const) {
  test(`${name}: with the opt-in absent, a RAM-backed parent gets the production refusal even when IMS_SCRATCH_ROOT names it`, async (t) => {
    assert.equal(execFileSync('stat', ['-f', '-c', '%T', '/dev/shm'], { encoding: 'utf8' }).trim(), 'tmpfs', 'precondition: /dev/shm is tmpfs')
    withEnv(t, { [TEST_SCRATCH_PARENT_ENV]: undefined, [SCRATCH]: '/dev/shm' })
    const before = shmRuns()
    const outcome = await run('/dev/shm')
    assert.equal(outcome.exitCode, REHEARSAL_EXIT.REFUSED)
    assert.match(outcome.refusal ?? '', /is on tmpfs: a cluster there is held in RAM\. Use a disk-backed directory such as \/var\/tmp\.$/)
    assert.deepEqual(shmRuns(), before)
  })

  test(`${name}: an invalid opt-in keeps the refusal and says why`, async (t) => {
    withEnv(t, { [TEST_SCRATCH_PARENT_ENV]: '/dev/shm', [SCRATCH]: '/usr' })
    const before = shmRuns()
    const outcome = await run('/dev/shm')
    assert.equal(outcome.exitCode, REHEARSAL_EXIT.REFUSED)
    assert.match(outcome.refusal ?? '', /held in RAM\. IMS_REHEARSAL_TEST_SCRATCH_PARENT is refused: .*not inside IMS_SCRATCH_ROOT/)
    assert.deepEqual(shmRuns(), before)
  })

  test(`${name}: a valid opt-in passes the RAM refusal (and stops at the impossible report directory, before any cluster)`, async (t) => {
    withEnv(t, { [TEST_SCRATCH_PARENT_ENV]: '/dev/shm', [SCRATCH]: '/dev/shm' })
    const before = shmRuns()
    const outcome = await run('/dev/shm')
    assert.equal(outcome.exitCode, REHEARSAL_EXIT.REFUSED)
    assert.match(outcome.refusal ?? '', /--report-dir .* cannot be created or written/)
    assert.doesNotMatch(outcome.refusal ?? '', /held in RAM/)
    assert.deepEqual(shmRuns(), before)
  })
}

// ---- Production never sets or forwards it. ----

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === '.git') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

test('CENSUS: nothing in app/, lib/, scripts/ or the deploy files names the opt-in variable except its one parser', () => {
  const PARSER = 'lib/ops/rehearsal-test-scratch.ts'
  const roots = ['app', 'lib', 'scripts', 'deploy', '.github']
  const loose = ['Dockerfile', 'package.json', '.env.example', 'next.config.ts', 'instrumentation.ts', 'proxy.ts']
  const files = [...roots.flatMap((r) => sourceFiles(join(REPO, r))), ...loose.map((f) => join(REPO, f)).filter((f) => existsSync(f))]
  // Precondition, so this cannot pass by scanning nothing: the parser is among the files, and names the variable.
  const rel = files.map((f) => f.slice(REPO.length))
  assert.ok(files.length > 500, `precondition: scanned ${files.length} files`)
  assert.ok(rel.includes(PARSER), 'precondition: the parser is among the scanned files')
  assert.ok(readFileSync(join(REPO, PARSER), 'utf8').includes(TEST_SCRATCH_PARENT_ENV), 'precondition: the parser names the variable')
  const offenders = files.filter((f) => !f.endsWith(`/${PARSER}`) && readFileSync(f, 'utf8').includes(TEST_SCRATCH_PARENT_ENV)).map((f) => f.slice(REPO.length))
  assert.deepEqual(offenders, [])
  // The parser reads it from the environment only: it is never assigned there.
  const parser = readFileSync(join(REPO, PARSER), 'utf8')
  assert.equal(/process\.env\s*(\.|\[)\s*['"]?IMS_REHEARSAL_TEST_SCRATCH_PARENT/.test(parser), false)
  assert.equal(/env\[[^\]]*\]\s*=[^=]/.test(parser), false)
})

test('CENSUS: the rehearsal children get a fixed allow-list of variables, which cannot carry the opt-in', async () => {
  const { inheritedEnv } = await import('@/scripts/rehearse-first-install')
  const saved = process.env[TEST_SCRATCH_PARENT_ENV]
  process.env[TEST_SCRATCH_PARENT_ENV] = ROOT_STICKY
  try {
    assert.equal(TEST_SCRATCH_PARENT_ENV in inheritedEnv('/x'), false)
    assert.equal(Object.values(inheritedEnv('/x')).includes(ROOT_STICKY), false)
  } finally {
    if (saved === undefined) delete process.env[TEST_SCRATCH_PARENT_ENV]
    else process.env[TEST_SCRATCH_PARENT_ENV] = saved
  }
})
