/**
 * THE UPDATE / FENCE FINDINGS OF THE D4 REHEARSAL (second batch), PINNED.
 *
 *   dry run   a failing late step of `update.sh --dry-run` / `deploy.sh --dry-run` printed the
 *             post-stop banner (service STOPPED, cron FENCED) for a host nothing had touched
 *   marker    the cutover marker said `db_connect_fence=released` while the fence was standing
 *   release   a record-less release through an operator wrapper reported "answers disagree /
 *             DATABASE_URL cannot connect" about a connection it never attempted
 *   symlink   fence-db-connections.mjs invoked through the documented `app` symlink was a silent no-op
 *   runuser   an unprivileged `update.sh --dry-run` died at `runuser` on its first git probe
 *
 * Nothing runs update.sh/deploy.sh for real. Arms lift the SHIPPED function text into a `bash`, or
 * run the shipped Node helpers, and each prints the precondition it reached.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { EXIT_ERROR, assessUnrecordedRelease, STATE_ABSENT } from '@/scripts/fence-db-connections.mjs'

import { shippedFunction } from './real-postgres-cluster.ts'
import { withTempDir } from './temp-dir.ts'

const REPO = process.cwd()
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')
const UPDATE = read('scripts/update.sh')
const DEPLOY = read('scripts/deploy.sh')
const INSTALL = read('scripts/install.sh')
const FENCE_LIB = read('scripts/lib/db-fence-protected.sh')

function bash(program: string): { status: number; out: string } {
  const r = spawnSync('bash', ['-c', program], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C' } as unknown as NodeJS.ProcessEnv,
  })
  return { status: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

// ---------------------------------------------------------------------------
// dry run -- the exit trap
// ---------------------------------------------------------------------------

/** The shipped on_exit() with every unknown command recorded instead of run. */
function trapProgram(source: string, dryRun: 'true' | 'false', cutBranch = false): string {
  let fn = shippedFunction(source, 'on_exit')
  if (cutBranch) {
    const start = fn.indexOf('  if $DRY_RUN; then\n    echo ""\n    echo -e "${RED}${BOLD}====')
    const end = fn.indexOf('\n  fi\n', start)
    assert.ok(start > 0 && end > start, 'precondition: the dry-run branch was found to cut out')
    fn = fn.slice(0, start) + fn.slice(end + '\n  fi\n'.length)
  }
  return [
    'exec 2>&1',
    'RED=""; BOLD=""; RESET=""; YELLOW=""; GREEN=""',
    'command_not_found_handle() { echo "STUB:$*"; return 0; }',
    'systemctl() { echo "SYSTEMCTL:$*"; }',
    'crontab() { echo "CRONTAB:$*"; }',
    `DRY_RUN=${dryRun}; DEPLOY_OK=false; PAST_POINT_OF_NO_RETURN=false; CUTOVER_ARMING=true`,
    'FENCE_ARMED=true; SCHEMA_TOUCHED=false; CRON_FENCED=false; CURRENT_STEP="start"',
    'REBOOT_FENCE_INSTALLED=false; DB_FENCE_UP=false; DB_FENCE_RAISED=false; CRON_BACKUP=/x; FENCE_FILE=/x/f',
    'SERVICE_UNIT=svc; SERVICE_UNITS=(svc); APP_USER=app; APP_NAME=app',
    fn,
    '( trap on_exit EXIT; exit 7 ); echo "TRAP_RC=$?"',
  ].join('\n')
}

for (const [name, source] of [['update.sh', UPDATE], ['deploy.sh', DEPLOY]] as const) {
  test(`dry run: ${name}'s exit trap says nothing was changed, and describes no stop`, () => {
    // CONTROL: with the dry-run branch cut out, the very same state prints the post-stop banner --
    // the rig can see the defect.
    const trunk = bash(trapProgram(source, 'true', true))
    console.log(`  dry-run control (branch cut): ${JSON.stringify(trunk.out.split('\n').filter((l) => /AFTER THE STOP|BEFORE THE STOP|FAILED/.test(l)).slice(0, 2))}`)
    assert.match(trunk.out, /FAILED (AFTER|BEFORE) THE STOP/, 'precondition: without the branch a dry run prints a stop banner')

    const r = bash(trapProgram(source, 'true'))
    console.log(`  dry-run shipped: ${JSON.stringify(r.out.split('\n').filter((l) => /DRY RUN|host|TRAP_RC|SYSTEMCTL|CRONTAB/.test(l)))}`)
    assert.match(r.out, /DRY RUN FAILED — NOTHING WAS CHANGED/)
    assert.match(r.out, /failed step : start/)
    assert.doesNotMatch(r.out, /AFTER THE STOP|BEFORE THE STOP|STOPPED|FENCED|NOT BEING RESTARTED/, 'and claims no stop, no fence')
    assert.doesNotMatch(r.out, /SYSTEMCTL|CRONTAB|STUB:/, 'and runs nothing (no systemctl, no crontab)')
    assert.match(r.out, /TRAP_RC=7/, 'and preserves the failing status')
  })

  test(`dry run: ${name} does not run the loaded-unit check against a snapshot a dry run never published`, () => {
    const lines = source.split('\n')
    const call = lines.findIndex((l) => /^\s*require_start_identity_bound \|\| die \\$/.test(l))
    assert.ok(call > 0, 'precondition: the check exists')
    // The nearest preceding column-0 `if`/`else`/`fi` structure must be `else` of `if $DRY_RUN`.
    let k = call - 1
    while (k > 0 && !/^(else|fi|if .*; then)$/.test(lines[k])) k--
    const owner = lines.slice(0, k).reverse().find((l) => /^if .*; then$/.test(l))
    console.log(`  dry-run guard: check at line ${call + 1}, preceded by ${JSON.stringify(lines[k])} of ${JSON.stringify(owner)}`)
    assert.equal(lines[k], 'else')
    assert.equal(owner, 'if $DRY_RUN; then')
  })
}

// ---------------------------------------------------------------------------
// marker -- what it may claim about the connection fence
// ---------------------------------------------------------------------------

const CLAIM_FN = shippedFunction(FENCE_LIB, 'db_connect_fence_claim')

test('marker: db_connect_fence_claim never says "released" for a fence it has not seen lowered', () => {
  const ask = (vars: string): string => bash(`${CLAIM_FN}\n${vars}\ndb_connect_fence_claim`).out.trim()
  const table: Array<[string, string, string]> = [
    ['standing', 'DB_FENCE_UP=true; DB_FENCE_RAISED=true; FENCE_ARMED=true', 'held'],
    ['raised then lowered', 'DB_FENCE_UP=false; DB_FENCE_RAISED=true; FENCE_ARMED=true', 'released'],
    // THE D4 STATE: phase=stopping written, the fence not yet raised, then SIGKILL.
    ['stop requested, fence not yet raised', 'DB_FENCE_UP=false; DB_FENCE_RAISED=false; FENCE_ARMED=true', 'unknown'],
    ['before the stop', 'DB_FENCE_UP=false; DB_FENCE_RAISED=false; FENCE_ARMED=false', 'not-raised'],
    ['first install (no fence by policy)', 'DB_FENCE_UP=false; DB_FENCE_RAISED=false; FENCE_ARMED=true; FIRST_INSTALL_NO_CREDENTIALED_FENCE=true', 'not-raised'],
  ]
  for (const [label, vars, want] of table) {
    const got = ask(vars)
    console.log(`  marker claim: ${label} -> ${got}`)
    assert.equal(got, want, label)
  }
  // Under `set -u` with none of the variables defined it still answers (the install path defines
  // only some of them at the moment it writes).
  assert.equal(bash(`set -u\n${CLAIM_FN}\ndb_connect_fence_claim`).out.trim(), 'not-raised')
})

test('marker: all three writers use the one claim, and the old boolean is gone', () => {
  const OLD = /db_connect_fence=\$\(\$\{?DB_FENCE_UP\}? && echo held \|\| echo released\)/
  for (const [name, source] of [['install.sh', INSTALL], ['update.sh', UPDATE], ['deploy.sh', DEPLOY]] as const) {
    const uses = source.split('\n').filter((l) => /echo "db_connect_fence=\$\(db_connect_fence_claim\)"/.test(l))
    console.log(`  marker writer ${name}: ${uses.length} line(s) use db_connect_fence_claim`)
    assert.equal(uses.length, 1, `${name}: the marker's connection-fence line comes from db_connect_fence_claim`)
    assert.doesNotMatch(source, OLD, `${name}: the held-or-released boolean is gone`)
  }
})

// ---------------------------------------------------------------------------
// release -- a record-less release through a wrapper has no application connection to test
// ---------------------------------------------------------------------------

const unrecorded = (appConnection: unknown) =>
  assessUnrecordedRelease({
    status: STATE_ABSENT,
    appRole: 'imsuser',
    appStillConnects: true,
    appConnection: appConnection as never,
    connectedDatabase: 'one_two_inventory',
  })

test('release: a connection that was never attempted is not reported as answers that disagree', () => {
  const notAsked = unrecorded({ attempted: false, connected: false, database: '', error: 'DATABASE_URL is not set, so there is no application connection to test.' })
  const text = notAsked.lines.join('\n')
  console.log(`  record-less, probe not attempted: exit ${notAsked.exitCode}; ${JSON.stringify(notAsked.lines[2])}`)
  assert.equal(notAsked.exitCode, EXIT_ERROR, 'still a refusal: nothing here can certify the application can connect')
  assert.equal(notAsked.fenceProvenAbsent, false)
  assert.doesNotMatch(text, /DISAGREE|CANNOT CONNECT|either a fence is still/, 'no verdict about a connection nobody opened')
  assert.match(text, /the second question was not asked/)
  assert.match(text, /not evidence that a fence is standing/)
  assert.match(text, /datacl/, 'and the next step is still the ACL audit')
  // ISOLATING ARM: a probe that WAS attempted and refused is still the disagreement it always was.
  const refused = unrecorded({ attempted: true, connected: false, database: '', error: 'FATAL: permission denied for database' })
  console.log(`  record-less, probe refused: ${JSON.stringify(refused.lines[0])}`)
  assert.match(refused.lines.join('\n'), /AND THE TWO ANSWERS DISAGREE/)
  assert.match(refused.lines.join('\n'), /DATABASE_URL itself CANNOT CONNECT/)
  // And a missing probe object (older callers) is the same not-asked case.
  assert.doesNotMatch(unrecorded(null).lines.join('\n'), /DISAGREE/)
})

// ---------------------------------------------------------------------------
// symlink -- the documented `app` path
// ---------------------------------------------------------------------------

test('symlink: the fence helper runs main() when invoked through a symlink to its directory', async () => {
  await withTempDir('ims-f12-', async (root) => {
    const link = join(root, 'app')
    symlinkSync(join(REPO, 'scripts'), link)
    mkdirSync(join(root, 'unused'))
    const run = (script: string) => {
      const r = spawnSync(process.execPath, [script, '--preflight'], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' } as unknown as NodeJS.ProcessEnv,
      })
      return { status: r.status, out: `${r.stdout}${r.stderr}` }
    }
    const direct = run(join(REPO, 'scripts/fence-db-connections.mjs'))
    const viaLink = run(join(link, 'fence-db-connections.mjs'))
    console.log(`  direct: rc=${direct.status} ${JSON.stringify(direct.out.slice(0, 70))}`)
    console.log(`  symlink: rc=${viaLink.status} ${JSON.stringify(viaLink.out.slice(0, 70))}`)
    assert.ok(direct.out.length > 0 && direct.status !== 0, 'precondition: run directly, the helper speaks and refuses (no identity supplied)')
    assert.equal(viaLink.status, direct.status, 'through the symlink it must behave identically (it used to exit 0 silently)')
    assert.equal(viaLink.out, direct.out)
    for (const other of ['check-app-db-object-access.mjs', 'run-migration-verifications.mjs']) {
      const a = run(join(REPO, 'scripts', other))
      const b = run(join(link, other))
      console.log(`  ${other}: direct rc=${a.status}, symlink rc=${b.status}`)
      assert.ok(a.out.length > 0, `precondition: ${other} speaks when run directly`)
      assert.deepEqual([b.status, b.out], [a.status, a.out], `${other} through the symlink`)
    }
  })
})

// ---------------------------------------------------------------------------
// runuser -- an unprivileged caller
// ---------------------------------------------------------------------------

test('runuser: update.sh run_as_user does not call runuser for a caller that cannot use it', () => {
  const uid = process.getuid?.() ?? 0
  console.log(`  runner uid: ${uid}`)
  if (uid === 0) {
    console.log('  SKIPPED: this arm needs a non-root runner (root may use runuser)')
    return
  }
  const fn = shippedFunction(UPDATE, 'run_as_user')
  const program = (user: string) => [
    'exec 2>&1',
    // runuser as the real one answers a non-root caller.
    'runuser() { echo "runuser: may not be used by non-root users"; return 1; }',
    fn,
    `run_as_user ${user} echo RAN_AS_CALLER`,
    'echo "RC=$?"',
  ].join('\n')
  const self = execFileSync('id', ['-un'], { encoding: 'utf8' }).trim()
  const sameUser = bash(program(self))
  const otherUser = bash(program('imsapp'))
  console.log(`  caller is the target: ${JSON.stringify(sameUser.out.trim())}; caller is another account: ${JSON.stringify(otherUser.out.trim())}`)
  assert.match(sameUser.out, /RAN_AS_CALLER[\s\S]*RC=0/)
  assert.match(otherUser.out, /RAN_AS_CALLER[\s\S]*RC=0/, 'a non-root caller cannot switch account, so a dry run runs its read probes as itself')
  assert.doesNotMatch(otherUser.out, /may not be used/)
  // CONTROL: the rig can see the defect when the guard is removed.
  const trunkFn = fn.replace(/  if \[\[ "\$\(id -un\)" == "\$\{user\}" \|\| \$EUID -ne 0 \]\]; then\n    "\$@"\n  elif /, '  if ')
  assert.notEqual(trunkFn, fn, 'precondition: the guard was found to cut out')
  const control = bash(['exec 2>&1', 'runuser() { echo "runuser: may not be used by non-root users"; return 1; }', trunkFn, 'run_as_user imsapp echo RAN_AS_CALLER; echo "RC=$?"'].join('\n'))
  assert.match(control.out, /may not be used by non-root users/, 'without the guard the unprivileged caller is refused')
})
