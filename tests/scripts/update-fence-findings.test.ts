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
import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { EXIT_ERROR, assessUnrecordedRelease, STATE_ABSENT } from '@/scripts/fence-db-connections.mjs'

import { shippedFunction } from './real-postgres-cluster.ts'
import { createTempDirSync, withTempDir } from './temp-dir.ts'

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

test('marker: db_connect_fence_claim says "released" only for a release the database confirmed (every combination)', () => {
  const ask = (vars: string): string => bash(`${CLAIM_FN}\n${vars}\ndb_connect_fence_claim`).out.trim()
  // The oracle is written independently of the function, as a precedence table.
  const oracle = (up: boolean, verified: boolean, raised: boolean, armed: boolean, first: boolean): string =>
    up ? 'held' : verified ? 'released' : raised ? 'unknown' : first ? 'not-raised' : armed ? 'unknown' : 'not-raised'
  let checked = 0
  const seen = new Map<string, number>()
  for (let bits = 0; bits < 32; bits++) {
    const [up, verified, raised, armed, first] = [0, 1, 2, 3, 4].map((i) => Boolean(bits & (1 << i)))
    const vars = `DB_FENCE_UP=${up}; DB_FENCE_RELEASE_VERIFIED=${verified}; DB_FENCE_RAISED=${raised}; FENCE_ARMED=${armed}; FIRST_INSTALL_NO_CREDENTIALED_FENCE=${first}`
    const got = ask(vars)
    assert.equal(got, oracle(up, verified, raised, armed, first), vars)
    seen.set(got, (seen.get(got) ?? 0) + 1)
    checked++
  }
  console.log(`  claim: ${checked} combinations of up/verified/raised/armed/first-install checked; outcomes ${JSON.stringify([...seen])}`)
  assert.equal(checked, 32)
  assert.ok(['held', 'released', 'unknown', 'not-raised'].every((k) => seen.has(k)), 'precondition: every outcome is reachable')
  // The D4 state, and the two the review named: a lost record and a failed re-fence are NOT "released".
  assert.equal(ask('DB_FENCE_UP=false; DB_FENCE_RELEASE_VERIFIED=false; DB_FENCE_RAISED=false; FENCE_ARMED=true'), 'unknown')
  assert.equal(ask('DB_FENCE_UP=false; DB_FENCE_RELEASE_VERIFIED=false; DB_FENCE_RAISED=true; FENCE_ARMED=true'), 'unknown')
  // Under `set -u` with none of the variables defined it still answers.
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

// ---------------------------------------------------------------------------
// dry run -- the no-.git pull branch writes nothing
// ---------------------------------------------------------------------------

/** The shipped pull step of update.sh, from `if ! $NO_GIT; then` to its closing `fi`. */
function pullStep(source: string): string {
  const lines = source.split('\n')
  const start = lines.findIndex((l, i) => l === 'if ! $NO_GIT; then' && /Pulling latest code from git/.test(lines[i + 1] ?? ''))
  const synced = lines.findIndex((l) => l.includes('success "Repository synced into existing app directory."'))
  assert.ok(start > 0 && synced > start, `precondition: the pull step was found (${start}..${synced})`)
  const end = lines.findIndex((l, i) => i > synced && l === 'fi')
  return lines.slice(start, end + 1).join('\n')
}

const MUTATING = ['mktemp', 'chown', 'rsync', 'rm', 'mv', 'cp', 'mkdir', 'chmod', 'copy_tree_into_new_dir', 'git-clone', 'git-fetch', 'git-reset', 'ln', 'tee']

function pullRig(source: string, dry: 'true' | 'false', opts: { cutGuard?: boolean } = {}): { calls: string[]; status: number; out: string } {
  const callsDir = createTempDirSync('ims-pull-rig-')
  let step = pullStep(source)
  if (opts.cutGuard) {
    assert.ok(step.includes('  elif $DRY_RUN; then\n'), 'precondition: the dry-run guard exists to cut')
    step = step.replace('  elif $DRY_RUN; then\n', '  elif false; then\n')
  }
  const stubs = MUTATING.filter((n) => !n.startsWith('git-') && n !== 'copy_tree_into_new_dir')
    .map((n) => `${n}() { echo "CALL:${n} $*" >> "$CALLS"; }`)
  const program = [
    'exec 2>&1',
    `CALLS='${join(callsDir, 'calls.log')}'; : > "$CALLS"`,
    // The recorder for mktemp must still hand back a path to the code under test.
    'mktemp() { echo "CALL:mktemp $*" >> "$CALLS"; echo /tmp/fake-clone-dir; }',
    ...stubs.filter((s) => !s.startsWith('mktemp()')),
    'copy_tree_into_new_dir() { echo "CALL:copy_tree_into_new_dir $*" >> "$CALLS"; }',
    // git is run through run_git_as_user: record the verb; rev-parse is a read and answers.
    'run_git_as_user() { shift; if [[ "$*" == *clone* ]]; then echo "CALL:git-clone $*" >> "$CALLS"; elif [[ "$*" == *fetch* ]]; then echo "CALL:git-fetch $*" >> "$CALLS"; elif [[ "$*" == *reset* ]]; then echo "CALL:git-reset $*" >> "$CALLS"; elif [[ "$*" == *rev-parse* ]]; then echo abc12345; fi; }',
    'privileged_spare_running_tree() { return 0; }',
    'header() { echo "H: $*"; }; info() { echo "I: $*"; }; warn() { echo "W: $*"; }; success() { echo "S: $*"; }; die() { echo "DIE: $*"; exit 9; }',
    'YELLOW=""; RESET=""',
    `DRY_RUN=${dry}; NO_GIT=false; APP_USER=app; APP_DIR=/nonexistent-app-dir; GIT_REPO_URL=file:///repo.git; GIT_BRANCH=main`,
    'APP_PORT=3000; APP_PORT_SOURCE=x; DEPLOY_META_SOURCE=x; IMS_DRIVER_DEPLOY_META=x; DEPLOY_META_FILE=x',
    shippedFunction(source, 'run'),
    step,
    'echo "DONE commit=${NEW_COMMIT:-unset}"',
    'cat "$CALLS"',
  ].join('\n')
  const r = bash(program)
  rmSync(callsDir, { recursive: true, force: true })
  const calls = r.out.split('\n').filter((l) => l.startsWith('CALL:'))
  return { calls, status: r.status, out: r.out }
}

test('dry run: the pull step of a checkout WITHOUT .git performs no write of any kind', () => {
  const real = pullRig(UPDATE, 'false')
  const verbs = (c: string[]) => c.map((l) => l.slice(5).split(' ')[0])
  console.log(`  control (real run, no .git): ${JSON.stringify(verbs(real.calls))}`)
  assert.ok(verbs(real.calls).includes('rsync') && verbs(real.calls).includes('git-clone') && verbs(real.calls).includes('chown'),
    'precondition: the rig sees the clone, the rsync --delete and the chown when the run is real')
  assert.ok(real.calls.some((c) => c.includes('rsync -a --delete')), 'and the rsync is the destructive one')

  const dry = pullRig(UPDATE, 'true')
  console.log(`  dry run: calls=${JSON.stringify(dry.calls)}; ${JSON.stringify(dry.out.split('\n').filter((l) => /DRY|DONE|DIE/.test(l)).map((l) => l.slice(0, 80)))}`)
  assert.equal(dry.status, 0, dry.out)
  assert.deepEqual(dry.calls, [], 'a dry run touches nothing: no mktemp, clone, rsync, copy, chown or rm')
  assert.match(dry.out, /\[DRY\]|would clone/)
  assert.match(dry.out, /DONE commit=not-fetched-in-a-dry-run/)
  // Isolating arm / named mutation: the same step with the guard disabled DOES write.
  const cut = pullRig(UPDATE, 'true', { cutGuard: true })
  console.log(`  dry run with the guard cut: ${JSON.stringify(verbs(cut.calls))}`)
  assert.ok(cut.calls.length > 0, 'without the guard the dry run writes (this is the defect)')
})

// ---------------------------------------------------------------------------
// marker -- the verified-release state is set only by a release the database confirmed
// ---------------------------------------------------------------------------

function releaseRig(source: string, helperRc: number, fenceState: string, afterRelease = ''): string {
  return [
    'set -uo pipefail',
    'exec 2>&1',
    'RED=""; BOLD=""; RESET=""; YELLOW=""; GREEN=""',
    'info() { :; }; warn() { :; }; error() { echo "ERR: $*"; }; success() { :; }; die() { echo "DIE: $*"; exit 9; }',
    'APP_USER=app; FIRST_INSTALL_NO_CREDENTIALED_FENCE=false; DRY_RUN=false; DB_FENCE_UP=true; DB_FENCE_RAISED=true; DB_FENCE_RELEASE_VERIFIED=false; FENCE_ARMED=true',
    'DB_FENCE_STATE=/nonexistent/state; DB_FENCE_RELEASE_CMD=rel; DB_FENCE_KEEP_RECORD=0; DB_FENCE_IDENTITY_ARGS=(); DATABASE_URL=u; MIGRATION_DATABASE_URL=m',
    'resolve_fence_script() { echo /fake/helper; }',
    'db_fence_witness_nonce() { return 1; }; db_fence_witness_challenge() { return 1; }; db_fence_witness_stop() { :; }',
    `db_fence_helper() { echo "FAKE_MACHINE_LINE"; return ${helperRc}; }`,
    `db_fence_state_after_release() { echo ${fenceState}; }`,
    'db_fence_machine_verdict() { echo ""; }; db_fence_clear_authority() { return 0; }',
    shippedFunction(source, 'release_db_connections'),
    shippedFunction(FENCE_LIB, 'db_connect_fence_claim'),
    'release_db_connections; echo "RELEASE_RC=$?"',
    afterRelease,
    'echo "CLAIM=$(db_connect_fence_claim) UP=${DB_FENCE_UP} VERIFIED=${DB_FENCE_RELEASE_VERIFIED}"',
  ].join('\n')
}

const claimOf = (out: string): string => out.match(/CLAIM=\S+ UP=\S+ VERIFIED=\S+/)?.[0] ?? `NO CLAIM LINE: ${out.slice(-400)}`

for (const [name, source] of [['install.sh', INSTALL], ['update.sh', UPDATE], ['deploy.sh', DEPLOY]] as const) {
  test(`marker: ${name} reaches "released" only through a release the helper confirmed (exit 0)`, () => {
    const results = {
      confirmed: claimOf(bash(releaseRig(source, 0, 'restored')).out),
      lostRecord: claimOf(bash(releaseRig(source, 4, 'restored')).out),
      failedNotHeld: claimOf(bash(releaseRig(source, 1, 'restored')).out),
      failedStillHeld: claimOf(bash(releaseRig(source, 1, 'held')).out),
    }
    console.log(`  ${name}: ${JSON.stringify(results)}`)
    assert.equal(results.confirmed, 'CLAIM=released UP=false VERIFIED=true', 'precondition: a confirmed release is "released"')
    assert.equal(results.lostRecord, 'CLAIM=unknown UP=false VERIFIED=false', 'a lost record (exit 4) lowers the fence flag but proves nothing about the grants')
    assert.equal(results.failedNotHeld, 'CLAIM=unknown UP=false VERIFIED=false', 'a failed release whose ACL does not show the fence is not a verified release either')
    assert.equal(results.failedStillHeld, 'CLAIM=held UP=true VERIFIED=false')
  })

  test(`marker: ${name} clears the verified state whenever it starts to raise a fence again`, () => {
    const lines = source.split('\n')
    const raises = lines.map((l, i) => [l, i] as const).filter(([l]) => /^\s*db_fence_raise "/.test(l))
    assert.ok(raises.length >= 2, 'precondition: both the first raise and the re-fence are present')
    for (const [, i] of raises) {
      const window = lines.slice(Math.max(0, i - 4), i).join('\n')
      console.log(`  ${name}: db_fence_raise at line ${i + 1} preceded by ${JSON.stringify(lines[i - 1].trim())}`)
      assert.match(window, /DB_FENCE_RELEASE_VERIFIED=false/, `${name}: line ${i + 1}`)
    }
    const trues = lines.filter((l) => /DB_FENCE_RELEASE_VERIFIED=true/.test(l) && !/^\s*#/.test(l))
    assert.equal(trues.length, 1, `${name}: exactly one statement can set the verified state`)
  })
}

// ---------------------------------------------------------------------------
// entry guard -- a program that cannot tell it is the entry point must FAIL, never exit 0 having done nothing
// ---------------------------------------------------------------------------

const GUARD_HELPERS = ['fence-db-connections.mjs', 'check-app-db-object-access.mjs', 'run-migration-verifications.mjs'] as const

type Guard = (o: { entry?: string; resolve?: (p: string) => string; url?: string; exit?: (c: number) => never; say?: (m: string) => void }) => boolean

async function guardOf(helper: string): Promise<Guard> {
  const mod = (await import(`../../scripts/${helper}`)) as { isMainModule: Guard }
  assert.equal(typeof mod.isMainModule, 'function', `${helper} must export isMainModule`)
  return mod.isMainModule
}

for (const helper of GUARD_HELPERS) {
  test(`entry guard: ${helper} fails closed when it cannot establish whether it is the entry point`, async () => {
    const isMainModule = await guardOf(helper)
    const url = pathToFileURL(join(REPO, 'scripts', helper)).href
    class Exited extends Error {
      constructor(readonly code: number) { super(`exit ${code}`) }
    }
    const exit = (code: number): never => { throw new Exited(code) }
    const said: string[] = []
    const run = (o: Parameters<Guard>[0]): string => {
      try { return String(isMainModule({ url, exit, say: (m) => said.push(m), ...o })) } catch (e) { return e instanceof Exited ? `EXIT ${e.code}` : `THROW ${e}` }
    }
    const missing = (): string => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }
    const table: Array<[string, Parameters<Guard>[0], string]> = [
      ['no entry script (node -e, REPL)', { entry: '' }, 'false'],
      ['entry resolves to this file', { entry: `/x/${helper}`, resolve: () => join(REPO, 'scripts', helper) }, 'true'],
      ['entry path cannot be resolved (removed after start)', { entry: `/x/${helper}`, resolve: missing }, 'EXIT 70'],
      ['entry named like this file now resolves elsewhere (swapped)', { entry: `/x/${helper}`, resolve: () => '/tmp/some-other-file.mjs' }, 'EXIT 70'],
      ['a different program that imports this module', { entry: '/x/a-test.test.ts', resolve: () => '/x/a-test.test.ts' }, 'false'],
      ['a different program whose own path cannot be resolved', { entry: '/x/a-test.test.ts', resolve: missing }, 'EXIT 70'],
    ]
    for (const [label, o, want] of table) {
      const got = run(o)
      console.log(`  ${helper}: ${label} -> ${got}`)
      assert.equal(got, want, label)
    }
    assert.ok(said.some((m) => /cannot resolve the path it was started with/.test(m) && /Exit 70/.test(m)), 'the unresolved case names the problem and the status')
    assert.ok(said.some((m) => /resolves to/.test(m) && /not to this file/.test(m)), 'the swapped case names the problem')
  })

  test(`entry guard: ${helper} started with --require-entry runs when it is the entry and fails when it is not`, async () => {
    await withTempDir('ims-entry-guard-', async (root) => {
      const importer = join(root, 'importer.mjs')
      writeFileSync(importer, `import { isMainModule } from ${JSON.stringify(pathToFileURL(join(REPO, 'scripts', helper)).href)}\nconsole.log('GUARD=' + isMainModule())\n`)
      const run = (file: string, args: string[]) => {
        const r = spawnSync(process.execPath, [file, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } as unknown as NodeJS.ProcessEnv })
        return { status: r.status, out: `${r.stdout}${r.stderr}` }
      }
      const plain = run(importer, [])
      const required = run(importer, ['--require-entry'])
      console.log(`  ${helper}: imported without the flag -> ${JSON.stringify(plain.out.trim())}; with the flag -> rc=${required.status} ${JSON.stringify(required.out.trim().slice(0, 90))}`)
      assert.match(plain.out, /GUARD=false/, 'precondition: an importer is not the entry')
      assert.equal(required.status, 70, 'but a caller that said --require-entry gets a failure, not a silent skip')
      assert.match(required.out, /not to this file/)
      // And as the real entry, the flag is accepted and removed before the option parser sees it.
      const direct = run(join(REPO, 'scripts', helper), ['--require-entry'])
      console.log(`  ${helper}: run as the entry with the flag -> rc=${direct.status} ${JSON.stringify(direct.out.trim().slice(0, 80))}`)
      assert.ok(direct.out.length > 0, 'the helper ran (it speaks)')
      assert.doesNotMatch(direct.out, /require-entry/, 'and its argument parser never saw the flag')
    })
  })
}

const HELPER_NAMES = /(check-app-db-object-access|run-migration-verifications|fence-db-connections)\.mjs/
const HELPER_VARS = /\bnode\s+"?\$\{?(DB_OBJECT_ACCESS_SCRIPT|DB_FENCE_SCRIPT|DB_FENCE_SCRIPT_COPY)\}?"?/
const HELPER_EXEC = /\bexec node "\$\{(fence_script|script)\}"/

/** Callers of the FENCE helper that intentionally do not say --require-entry, each with its reason. */
const FLAG_ALLOWLIST: Array<{ file: string; match: RegExp; why: string }> = [
  { file: 'scripts/lib/db-fence-protected.sh', match: /exec node "\$\{fence_script\}"/, why: 'fence helper started by the library with the verb\'s own arguments; it relies on the guard\'s unresolved/swapped-path exits (70). Adding the flag here needs every stand-in helper fixture to be changed in step; tracked as a follow-up' },
  { file: 'scripts/lib/db-fence-protected.sh', match: /exec node "\$\{script\}"/, why: 'the same, for the operator wrappers\' helper run' },
  { file: 'docs/installation.md', match: /node \$\{DB_FENCE_SCRIPT\} --fence/, why: 'prose describing a RETIRED banner that used to print this command; nothing runs it' },
  { file: 'docs/installation.md', match: /fence-db-connections\.mjs --ensure-migration-role/, why: 'an operator-typed command in the runbook for the fence helper; same reasoning, and an operator can see a silent no-op' },
]

function scanHelperInvocations(): Array<{ file: string; line: number; text: string; flag: boolean }> {
  const out: Array<{ file: string; line: number; text: string; flag: boolean }> = []
  const seen = new Set<string>()
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(join(REPO, dir))) {
      const rel = `${dir}/${name}`
      let st
      try { st = statSync(join(REPO, rel)) } catch { continue }
      if (st.isDirectory()) { if (!['node_modules', '.git', '.next'].includes(name)) walk(rel) } else files.push(rel)
    }
  }
  for (const d of ['scripts', '.github/workflows', 'docs', 'help-docs']) walk(d)
  files.push('package.json', 'CHANGELOG.md', 'CLAUDE.md')
  for (const rel of files) {
    if (!/\.(sh|yml|yaml|md|json)$/.test(rel)) continue
    let real
    try { real = realpathSync(join(REPO, rel)) } catch { continue }
    if (seen.has(real)) continue
    seen.add(real)
    const isShell = rel.endsWith('.sh')
    readFileSync(join(REPO, rel), 'utf8').split('\n').forEach((text, i) => {
      const t = text.trim()
      if (isShell && t.startsWith('#')) return
      if (isShell && /\[DRY\]|\becho\b|\bwarn\b|\binfo\b|\berror\b|\bprintf\b/.test(text)) return
      const prose = rel.endsWith('.md')
      // In prose a command is a backticked `node <helper path or variable> ...`; a sentence that merely has the words node and the
      // file name in it is not an invocation.
      const invokes = prose
        ? /`node\s+("?\$\{?[A-Za-z_]+\}?"?|\S*(check-app-db-object-access|run-migration-verifications|fence-db-connections)\.mjs)[^`]*`/.test(text)
        : /\bnode\b[^|;&)]*/.test(text) && (HELPER_NAMES.test(text) || HELPER_VARS.test(text)) || (isShell && HELPER_EXEC.test(text))
      const inManifest = (rel.endsWith('.yml') || rel === 'package.json') && HELPER_NAMES.test(text) && /node /.test(text)
      if (invokes || inManifest) out.push({ file: rel, line: i + 1, text: t, flag: text.includes('--require-entry') })
    })
  }
  return out
}

test('entry guard: the three copies are byte-identical, and every shell caller of the two simple helpers says --require-entry', () => {
  const copy = (helper: string): string => {
    const s = read(`scripts/${helper}`)
    const start = s.indexOf('// Exit status when this file cannot establish')
    const end = s.indexOf('\nif (isMainModule())', start)
    assert.ok(start > 0 && end > start, `precondition: guard found in ${helper}`)
    return s.slice(start, end)
  }
  const [a, b, c] = GUARD_HELPERS.map(copy)
  console.log(`  guard source: ${a.split('\n').length} lines in each of ${GUARD_HELPERS.length} helpers`)
  assert.equal(b, a)
  assert.equal(c, a)
  // EVERY invocation in the repository, found by a scan and not by a fixed pattern list.
  const found = scanHelperInvocations()
  console.log(`  repo-wide scan: ${found.length} invocation(s) of the three helpers`)
  for (const f of found) console.log(`    ${f.file}:${f.line} ${f.flag ? '[--require-entry]' : '[no flag]'} ${f.text.slice(0, 90)}`)
  assert.ok(found.length >= 10, 'precondition: the scan reached the shell entrypoints, the library, the workflow and the docs')
  assert.ok(found.some((f) => f.file === 'scripts/deploy.sh' && /check-app-db-object-access/.test(f.text)), 'precondition: the deploy.sh object-access call (the one a review caught) is among them')
  const unflagged = found.filter((f) => !f.flag)
  const stale = FLAG_ALLOWLIST.filter((a) => !unflagged.some((f) => f.file === a.file && a.match.test(f.text)))
  const unexplained = unflagged.filter((f) => !FLAG_ALLOWLIST.some((a) => a.file === f.file && a.match.test(f.text)))
  console.log(`  without the flag: ${unflagged.length}, all on the justified allowlist: ${unexplained.length === 0}`)
  assert.deepEqual(unexplained.map((f) => `${f.file}:${f.line} ${f.text}`), [], 'every invocation either says --require-entry or is on the allowlist with a reason')
  assert.deepEqual(stale.map((a) => a.file + ' ' + a.match), [], 'and no allowlist entry is stale')
})
