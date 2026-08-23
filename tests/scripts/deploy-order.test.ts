import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

// o3d-2sm1.1 — the deploy order is a safety property, not a style choice, so it is
// asserted here rather than left to the header comment that used to describe it.
//
// The old order was migrate -> build -> stop -> start, which left the PREDECESSOR
// serving the migrated schema for the whole length of a build. Two migrations
// measured what that costs: a refund-reversal witness column whose bound the old
// binary clears (unrecoverable), and a shopping-sync discriminator the old binary
// overwrites (neither repairable nor detectable). If someone reorders these phases
// back, this test fails.
//
// Everything here is line-based and skips comment lines, so a phrase quoted in a
// header comment cannot satisfy an assertion about what the script actually does.

const DEPLOY_LINES = readFileSync(join(process.cwd(), 'scripts/deploy.sh'), 'utf8').split(/\r?\n/)
const UPDATE_LINES = readFileSync(join(process.cwd(), 'scripts/update.sh'), 'utf8').split(/\r?\n/)

const DEPLOY_PHASES = [
  'preflight',
  'build',
  'validate',
  'fence-writers',
  'drain-verify',
  'migrate',
  'verify-migrations',
  'start',
  'health',
  'unfence-cron',
]

function phases(lines: string[]): string[] {
  return lines
    .map((line) => /^#\s*@deploy-phase:\s*([a-z0-9-]+)\s*$/.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => match[1])
}

function phaseLine(lines: string[], phase: string): number {
  const index = lines.findIndex((line) => line.trim() === `# @deploy-phase: ${phase}`)
  assert.notEqual(index, -1, `the script must declare the '${phase}' phase`)
  return index
}

function isCode(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.length > 0 && !trimmed.startsWith('#')
}

/** First line of actual code (not a comment) matching `pattern`, at or after `from`. */
function codeLine(lines: string[], pattern: RegExp | string, from = 0): number {
  const matches = (line: string) => (typeof pattern === 'string' ? line.includes(pattern) : pattern.test(line))
  for (let index = from; index < lines.length; index += 1) {
    if (isCode(lines[index]) && matches(lines[index])) return index
  }
  return -1
}

test('deploy.sh builds and validates before it stops anything, and migrates only once stopped', () => {
  assert.deepEqual(phases(DEPLOY_LINES), DEPLOY_PHASES)
})

test('deploy.sh keeps the migration strictly between the stop and the start', () => {
  const at = (phase: string) => phaseLine(DEPLOY_LINES, phase)

  assert.ok(at('build') < at('fence-writers'), 'the build must run while the predecessor still serves the OLD schema')
  assert.ok(at('validate') < at('fence-writers'), 'validation must reject a release before anything is stopped')
  assert.ok(at('fence-writers') < at('drain-verify'), 'writers are stopped before quiescence is proven')
  assert.ok(at('drain-verify') < at('migrate'), 'the migration may only run once quiescence is proven')
  assert.ok(at('migrate') < at('verify-migrations'), 'verification runs after the schema has moved')
  assert.ok(at('verify-migrations') < at('start'), 'the new build starts only after every declared check returned zero')
})

test('deploy.sh arms the fence before it stops anything', () => {
  const fenceWriters = phaseLine(DEPLOY_LINES, 'fence-writers')
  const arm = codeLine(DEPLOY_LINES, 'FENCE_ARMED=true', fenceWriters)
  const stop = codeLine(DEPLOY_LINES, /systemctl stop/, fenceWriters)
  const kill = codeLine(DEPLOY_LINES, /run kill /, fenceWriters)

  assert.notEqual(arm, -1, 'the fence must be armed in the stop phase')
  assert.notEqual(stop, -1, 'the stop phase must actually stop the service')
  assert.ok(arm < stop, 'the fence must be armed before the service is stopped')
  assert.ok(arm < kill, 'the fence must be armed before any process is killed')
})

test('deploy.sh never restarts the predecessor on a post-stop failure', () => {
  const trapStart = DEPLOY_LINES.findIndex((line) => line.startsWith('on_exit() {'))
  const trapEnd = DEPLOY_LINES.findIndex((line) => line.startsWith('trap on_exit EXIT'))
  assert.ok(trapStart !== -1 && trapEnd > trapStart, 'the exit trap must exist')
  const trapBody = DEPLOY_LINES.slice(trapStart, trapEnd).filter(isCode).join('\n')

  assert.ok(!/systemctl\s+start/.test(trapBody), 'the failure path must never start the service again')
  assert.ok(!/systemctl\s+unmask/.test(trapBody), 'the failure path must never lift the fence')
  assert.ok(!/npm\s+start/.test(trapBody), 'the failure path must never relaunch the predecessor')
  assert.ok(/systemctl stop/.test(trapBody), 'the failure path re-stops rather than restarts')
})

test('deploy.sh stops processes scoped to the app directory, not every next-server on the box', () => {
  // The previous script used `pgrep -f 'next-server|next start'`, which also matched
  // the full-chain e2e instance — a different tree on a different port against a
  // different database. Scope by /proc/<pid>/cwd instead.
  const cwdScope = codeLine(DEPLOY_LINES, 'readlink -f "/proc/$pid/cwd"')
  assert.notEqual(cwdScope, -1, 'stray processes must be matched by their working directory')
  assert.notEqual(
    codeLine(DEPLOY_LINES, 'APP_DIR_REAL', cwdScope),
    -1,
    'the working-directory comparison must be against the resolved app directory',
  )
})

test('deploy.sh proves quiescence with the database, not only with the process list', () => {
  const drain = phaseLine(DEPLOY_LINES, 'drain-verify')
  const migrate = phaseLine(DEPLOY_LINES, 'migrate')
  const check = codeLine(DEPLOY_LINES, 'check-db-writers.mjs', drain)

  assert.notEqual(check, -1, 'the drain step must ask Postgres who is still connected')
  assert.ok(check < migrate, 'quiescence must be proven before the schema moves')
})

test('deploy.sh fences the cron writers and restores them only after the health check', () => {
  const fenceWriters = phaseLine(DEPLOY_LINES, 'fence-writers')
  const drain = phaseLine(DEPLOY_LINES, 'drain-verify')
  const health = phaseLine(DEPLOY_LINES, 'health')

  const fenceCall = codeLine(DEPLOY_LINES, /^fence_cron$/, fenceWriters)
  assert.notEqual(fenceCall, -1, 'cron entries are writers and must be fenced')
  assert.ok(fenceCall < drain, 'cron is fenced before quiescence is asserted')

  const unfenceCall = codeLine(DEPLOY_LINES, /^unfence_cron$/, health)
  assert.notEqual(unfenceCall, -1, 'cron must be restored once the new build has answered')
})

test('deploy.sh runs the post-migration verification hook between the migration and the start', () => {
  const verifyPhase = phaseLine(DEPLOY_LINES, 'verify-migrations')
  const start = phaseLine(DEPLOY_LINES, 'start')
  const hook = codeLine(DEPLOY_LINES, 'run-migration-verifications.mjs', verifyPhase)

  assert.notEqual(hook, -1, 'the hook must be invoked')
  assert.ok(hook < start, 'the checks must pass before the new build serves')
})

test('update.sh uses the same order: build, stop, migrate, verify, start', () => {
  assert.deepEqual(
    phases(UPDATE_LINES),
    DEPLOY_PHASES.filter((phase) => phase !== 'unfence-cron'),
  )

  const at = (phase: string) => phaseLine(UPDATE_LINES, phase)
  assert.ok(at('build') < at('fence-writers'))
  assert.ok(at('fence-writers') < at('drain-verify'))
  assert.ok(at('drain-verify') < at('migrate'))
  assert.ok(at('migrate') < at('verify-migrations'))
  assert.ok(at('verify-migrations') < at('start'))
})

test('update.sh proves quiescence and verifies migrations, and never restarts the predecessor on failure', () => {
  const drain = phaseLine(UPDATE_LINES, 'drain-verify')
  assert.notEqual(codeLine(UPDATE_LINES, 'check-db-writers.mjs', drain), -1)
  assert.notEqual(
    codeLine(UPDATE_LINES, 'run-migration-verifications.mjs', phaseLine(UPDATE_LINES, 'verify-migrations')),
    -1,
  )

  const trapStart = UPDATE_LINES.findIndex((line) => line.startsWith('on_exit() {'))
  const trapEnd = UPDATE_LINES.findIndex((line) => line.startsWith('trap on_exit EXIT'))
  assert.ok(trapStart !== -1 && trapEnd > trapStart, 'update.sh must have an exit fence too')
  const trapBody = UPDATE_LINES.slice(trapStart, trapEnd).filter(isCode).join('\n')
  assert.ok(!/systemctl\s+start/.test(trapBody))
  assert.ok(!/systemctl\s+restart/.test(trapBody))
  assert.ok(!/systemctl\s+unmask/.test(trapBody))
})

test('the pre-migration backup is taken while nothing is serving', () => {
  // A dump taken before the build is minutes stale by the time the migration runs,
  // so restoring it would silently lose every write in between.
  const drain = phaseLine(UPDATE_LINES, 'drain-verify')
  const dump = codeLine(UPDATE_LINES, /pg_dump/, 0)
  assert.notEqual(dump, -1)
  assert.ok(dump > drain, 'pg_dump must run after the writers are stopped')
})
