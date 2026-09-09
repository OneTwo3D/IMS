/**
 * THE ROOT-SIDE WRITES THAT MAY NOT FOLLOW A SYMLINK (o3d-czpy)
 *
 * scripts/install.sh runs as root and writes into ${DATA_DIR} and ${APP_DIR}, both of which it
 * hands to ${APP_USER} with a recursive chown. Whoever holds that account can therefore replace an
 * entry with a symlink between installer runs, and a root-side `mkdir -p`, `cat >`, `chmod`,
 * `chown` or `cp -a` on that name then acts on the target instead. The lock file that started this
 * (Codex r24 CRITICAL) was fixed in place; these are the general class.
 *
 * WHAT EVERY TEST BELOW DOES. It PLANTS A REAL SYMLINK on a real filesystem, runs the SHIPPED
 * function under a real bash, and asserts that the victim is untouched — not that the source
 * contains a particular primitive. The functions are lifted out of scripts/install.sh rather than
 * re-typed, for the reason the rest of tests/scripts states: a harness that re-implements the
 * writer proves that its author can write the writer.
 *
 * WHAT AN UNPRIVILEGED HARNESS CANNOT SHOW, STATED RATHER THAN GLOSSED. Half of the shipped
 * guarantee is "the service account cannot manufacture a root-owned 0700 directory, because it
 * cannot chown anything to root". In this harness the attacker and the privileged party are the
 * SAME uid, so that half is unmeasurable here: `cd`-then-lstat-`.` is asserted for its OTHER
 * property — that the check is made of the inode this process is inside rather than of a name that
 * can still move — and the ownership half rests on the argument, which is the same argument
 * prepare_crontab_lock's own regressions rest on. Everything else below is measured.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test, { type TestContext } from 'node:test'

import { maskShellSource, shellAssignments, shellConstant, shellConstantAssignments, shellConstantOptional, shellFunction, shellFunctionBodyCount, shellFunctionDefinitions, shellWordLiteral } from './shell-symbol.ts'
import { createTempDirSync } from './temp-dir.ts'

const REPO = process.cwd()
const INSTALL_SH = readFileSync(join(REPO, 'scripts/install.sh'), 'utf8')

/**
 * THE CUTOVER NAMESPACE LIBRARY (o3d-secops r22, Codex CRITICAL x2). The symlink-proof walk this
 * file has always measured — enter_service_subdir()/mkdir_service_subdir() — lives here now, with
 * the two paths that most needed it and never had it: the shared cutover lock and the app-writable
 * connection-fence directory, both of which deploy.sh and update.sh created inside a directory
 * ${APP_USER} owns. A harness lifts a function out of the file that DEFINES it; nothing else about
 * these tests changes, because the walk itself came across byte for byte.
 */
const CUTOVER_NS_LIB = readFileSync(join(REPO, 'scripts/lib/cutover-namespace.sh'), 'utf8')
const CUTOVER_NS_FUNCTIONS = new Set([
  // o3d-ov60: and the tree copier, which had one definition in install.sh and two of the three
  // clone paths that perform it. It moved here so update.sh's could reach it; the regressions
  // below are unchanged except for where they lift it from.
  'copy_tree_into_new_dir',
  'enter_service_subdir',
  'mkdir_service_subdir',
  'own_service_subdir',
  'ensure_cutover_root_dir',
  'ensure_cutover_state_dirs',
  'verify_held_lock',
  'narrow_held_lock',
  'held_lock_mode',
  'lock_mode_is_private',
  'rotate_cutover_lock_inode',
  'dir_is_private_to_this_run',
  'prepare_cutover_lock_file',
  'acquire_cutover_lock',
  'acquire_legacy_namespace_lock',
  'state_pre_r22_cutovers_are_not_excluded',
  'warn_pre_r22_db_fence_state',
  'warn_legacy_namespace_db_fence_state',
])
/** Lift `name` from whichever shipped file defines it. */
function shippedFrom(name: string): { source: string; where: string } {
  return CUTOVER_NS_FUNCTIONS.has(name)
    ? { source: CUTOVER_NS_LIB, where: 'scripts/lib/cutover-namespace.sh' }
    : { source: INSTALL_SH, where: 'scripts/install.sh' }
}


/**
 * The rig. `die` is a STUB and not the subject: install.sh's own is `die() { error "$*"; exit 1; }`
 * on one line, and what these tests measure is whether the run refuses, not how the refusal is
 * printed. Everything that IS the subject is shipped text.
 */
function rig(functions: string[], body: string, extra = ''): string {
  return [
    'set -uo pipefail',
    'APP_USER="svcuser"',
    // o3d-secops r7: the gate records what it approved here and holds a descriptor on it there,
    // and enter_service_root() is held to both. Lifted for every rig because an undeclared name
    // does not fail — bash would create an INDEXED array and quietly fold every string key onto
    // index 0 — so a rig without these measures something other than the shipped script.
    shellConstant(INSTALL_SH, 'SERVICE_ROOT_APPROVED', 'scripts/install.sh'),
    shellConstant(INSTALL_SH, 'SERVICE_ROOT_FD', 'scripts/install.sh'),
    'error() { printf "ERROR: %s\\n" "$*" >&2; }',
    'die() { error "$*"; exit 1; }',
    'info() { printf "INFO: %s\\n" "$*"; }',
    shellConstant(INSTALL_SH, 'PUBLISH_STAGE_DIRNAME'),
    ...functions.map((name) => { const { source, where } = shippedFrom(name); return shellFunction(source, name, where) }),
    extra,
    body,
  ].join('\n')
}

/**
 * THE PUBLISHER AND EVERYTHING IT RESOLVES ITS DESTINATION WITH (o3d-rn10).
 *
 * publish_durable_file() no longer pins `$dir` by stat-ing that pathname; it asks
 * publish_trust_root() which trusted ancestor the destination lies under and walks down from
 * there with pin_dir_beneath_root(). All four are SHIPPED TEXT, lifted rather than re-typed —
 * including the trust-root TABLE, which names installer variables. A test therefore states where
 * the roots are the way the installer does, by defining ${APP_DIR} and ${DATA_DIR}, and never by
 * re-typing the table itself.
 */
const PUBLISHER = ['fsync_path', 'publish_trust_root_candidates', 'pin_publish_root_parent', 'publish_root_anchored', 'publish_trust_root', 'refuse_symlinked_root', 'pin_dir_beneath_root', 'publish_durable_file']

/** The anchor and the walk it is made of (o3d-rn10 r4): publish_root_anchored() is now a subshell
 *  around pin_publish_root_parent(), so a rig that lifts one without the other fails with
 *  "command not found" and every "the publication must refuse" test passes for the wrong reason. */
const ANCHOR = ['pin_publish_root_parent', 'publish_root_anchored'] as const

/** The ROOT ENTRY: the anchor walk, the walk that enters the root, and — since o3d-secops r7 — the
 *  shared refusal it prints a symlinked root through. A rig that lifts the walk without the refusal
 *  turns the refusal into a `command not found` on stderr, and every test that greps stderr for it
 *  then fails for a reason that has nothing to do with the code under test. */
const ROOT_ENTRY = [...ANCHOR, 'refuse_symlinked_root', 'pin_dir_beneath_root'] as const

/** The five variables publish_trust_root_candidates() reads. Anything unnamed stays EMPTY, which
 *  the table skips — so a destination outside the roots a test declares is refused, as it is in
 *  the installer. */
function roots(where: { app?: string, data?: string, cutover?: string, snapshot?: string, ca?: string }): string {
  return [
    `APP_DIR=${q(where.app ?? '')}`,
    `DATA_DIR=${q(where.data ?? '')}`,
    `CUTOVER_STATE_DIR=${q(where.cutover ?? '')}`,
    `DB_ENV_SNAPSHOT_DIR=${q(where.snapshot ?? '')}`,
    `DB_CA_PUBLISH_DIR=${q(where.ca ?? '')}`,
  ].join('\n')
}

type Run = { status: number, stdout: string, stderr: string }

/**
 * THE WALL CLOCK, WHICH IS THE ONLY BRAKE THAT DOES NOT NEED THE SHIM'S COOPERATION (o3d-rn10).
 *
 * The two guards inside every shim stop a shim that RE-ENTERS ITSELF and a shim that RECORDS
 * without bound. Neither of them is consulted by a shim that simply blocks — one that spins, waits
 * on a lock, or reads a pipe nobody writes — and that is the same failure class: the eleven-hour
 * runaway this file already carries a note about occupied a worker until a human noticed it.
 *
 * So every execution here is bounded from OUTSIDE the script, by `timeout`, and NOT by
 * `execFileSync`'s own `timeout` option: Node kills the process it spawned, and a shell leaves
 * children. GNU `timeout` without `--foreground` runs the managed command in its OWN PROCESS GROUP
 * and signals the GROUP, so a background descendant a shim left behind dies with it. `-k` follows
 * the TERM with a KILL for anything that ignores the first.
 *
 * A DEADLINE THAT PASSES IS A THROWN ERROR AND NEVER A `Run`. A harness that returned
 * `{ status: 124 }` would let a test that expects a refusal (`status === 1`) fail with a confusing
 * diff, or — worse — let one that only greps stderr pass. The failure has to name itself.
 */
const RUN_BASH_DEADLINE_MS = 60_000
/** `timeout`'s own exit codes: 124 when the TERM did it, 137 when the follow-up KILL did. */
const TIMEOUT_EXPIRED = 124
const TIMEOUT_KILLED = 137
/** Output past this is a runaway too, and is not read into this process's memory. */
const RUN_BASH_MAX_OUTPUT_BYTES = 4 * 1024 * 1024

class HarnessRunaway extends Error {}

/**
 * THE SCRIPT TRAVELS AS A FILE, NOT AS AN ARGUMENT (o3d-secops r25).
 *
 * `bash -c "${script}"` puts the whole script in ONE argv entry, and Linux caps a single argument at
 * MAX_ARG_STRLEN — 128 KiB — regardless of how large ARG_MAX is. Several tests here splice an
 * entire shell library into the script they run; db-fence-protected.sh alone reached 127 KiB, so
 * the next few hundred bytes of anything turned every one of those into `spawnSync ... E2BIG`, a
 * harness error with nothing to say about the code under test. An environment variable would hit
 * the same cap. A file has no such limit, and `$0` and `BASH_SOURCE` are unused by every script
 * this harness runs, so the two invocations are otherwise indistinguishable.
 *
 * `t.after` is NOT available here — runBash takes no TestContext and 109 call sites pass none — so
 * the file is removed on the way out of this function, including when the deadline throws.
 */
function runBash(script: string, opts: { cwd?: string, env?: Record<string, string>, deadlineMs?: number } = {}): Run {
  const deadlineMs = opts.deadlineMs ?? RUN_BASH_DEADLINE_MS
  const seconds = Math.max(1, Math.ceil(deadlineMs / 1000))
  const scriptFile = join(mkdtempSync(join(tmpdir(), 'ims-runbash-')), 'script.sh')
  let result: { error?: Error, status: number | null, signal: NodeJS.Signals | null, stdout: string, stderr: string }
  try {
    writeFileSync(scriptFile, script)
    result = spawnSync(REAL.timeout, ['-k', '2', String(seconds), 'bash', scriptFile], {
      cwd: opts.cwd ?? REPO,
      encoding: 'utf8',
      env: { ...process.env, ...(opts.env ?? {}) },
      // An EMPTY stdin rather than this process's: a shim that reads stdin then gets EOF instead of
      // blocking on a terminal that will never answer.
      input: '',
      maxBuffer: RUN_BASH_MAX_OUTPUT_BYTES,
    })
  } finally {
    rmSync(dirname(scriptFile), { recursive: true, force: true })
  }
  if (result.error) {
    throw new HarnessRunaway(`the harness could not bound this execution: ${result.error.message}`)
  }
  if (result.status === TIMEOUT_EXPIRED || result.status === TIMEOUT_KILLED || result.signal) {
    throw new HarnessRunaway(
      `harness deadline of ${seconds}s exceeded — the script under test did not finish and its process GROUP was terminated. `
      + `stderr: ${(result.stderr ?? '').slice(0, 2000)}`,
    )
  }
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** A synchronous pause, for the one assertion that has to watch a killed descendant stay dead. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * THE ABSOLUTE PATH OF A COMMAND A SHIM SHADOWS, resolved ONCE and here, where the shimmed PATH
 * does not exist yet.
 *
 * A SHIM THAT DELEGATES BY BARE NAME IS AN INFINITE LOOP, and it is not a theoretical one: an
 * earlier run of this file left a `mktemp` shim spinning for eleven hours, writing 37 million
 * identical lines and 2.69 GB into /tmp — which is a tmpfs, so 2.69 GB of RAM — and the builds it
 * starved were blamed on a different worktree. The shim directory is FIRST on PATH precisely so
 * that the shipped code reaches the shim; the shim is therefore the one caller that must never
 * resolve the name through PATH.
 */
const REAL_BIN_DIRS = ['/usr/bin', '/bin', '/usr/local/bin']
function realBin(name: string): string {
  for (const dir of REAL_BIN_DIRS) {
    const path = join(dir, name)
    if (existsSync(path)) return path
  }
  throw new Error(`${name} is not in any of ${REAL_BIN_DIRS.join(', ')}, so no shim can delegate to it`)
}
const REAL = {
  mktemp: realBin('mktemp'),
  chmod: realBin('chmod'),
  stat: realBin('stat'),
  rm: realBin('rm'),
  mkdir: realBin('mkdir'),
  mkfifo: realBin('mkfifo'),
  mv: realBin('mv'),
  ln: realBin('ln'),
  id: realBin('id'),
  wc: realBin('wc'),
  timeout: realBin('timeout'),
  sleep: realBin('sleep'),
  sync: realBin('sync'),
} as const

/** A shell literal. Every path a shim names goes through this. */
function q(value: string): string {
  return JSON.stringify(value)
}

/**
 * How many lines any one shim may record. A recording that can grow without bound is a runaway and
 * not a test artefact; every assertion in this file counts single-figure numbers of lines.
 */
const SHIM_LOG_MAX_LINES = 256
/** The shim exit codes for the two failures that must be LOUD rather than silent. */
const SHIM_REENTERED = 97
const SHIM_LOG_FULL = 98

/**
 * A PATH shim directory whose entries delegate to the real tool after recording what they saw.
 *
 * Every shim carries two guards ahead of its body, so that the failure modes above end the test
 * instead of running until somebody notices:
 *
 *   - A RE-ENTRY MARKER, exported, so it survives the `exec` a delegating shim ends with. A shim
 *     that reaches itself a second time — which is what delegating by bare name does — exits 97
 *     saying so, on the FIRST recursion rather than the millionth.
 *   - A BOUNDED APPEND. `ims_shim_append` refuses a log that has already reached
 *     SHIM_LOG_MAX_LINES lines and exits 98. Shims record through it and never with a raw `>>`.
 */
function shimDir(t: TestContext, shims: Record<string, string>): string {
  const dir = createTempDirSync('ims-czpy-shim-', t)
  for (const [name, body] of Object.entries(shims)) {
    const marker = `IMS_SHIM_ENTERED_${name.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`
    const path = join(dir, name)
    writeFileSync(path, [
      '#!/usr/bin/env bash',
      `if [[ -n "\${${marker}:-}" ]]; then`,
      `  printf 'ims-shim: %s re-entered itself — it is delegating to the command it shadows by BARE NAME, and PATH resolves that back to this shim. Failing fast.\\n' ${q(name)} >&2`,
      `  exit ${SHIM_REENTERED}`,
      'fi',
      `export ${marker}=1`,
      'ims_shim_append() {',
      '  local file="$1"; shift',
      '  local lines',
      `  lines="$(${REAL.wc} -l < "\${file}" 2>/dev/null || printf '0')"`,
      `  if (( lines >= ${SHIM_LOG_MAX_LINES} )); then`,
      `    printf 'ims-shim: %s already holds %s lines — a recording that can reach gigabytes is a runaway, not a test artefact. Failing fast.\\n' "\${file}" "\${lines}" >&2`,
      `    exit ${SHIM_LOG_FULL}`,
      '  fi',
      '  printf \'%s\\n\' "$*" >> "${file}"',
      '}',
      body,
      '',
    ].join('\n'))
    chmodSync(path, 0o755)
  }
  return dir
}

test('[o3d-czpy] a shim that delegates to the command it shadows by bare name fails fast instead of looping', (t) => {
  const root = createTempDirSync('ims-czpy-shimguard-', t)
  const log = join(root, 'entered.log')
  writeFileSync(log, '')
  // DELIBERATELY BARE. This is the exact shape that ran for eleven hours; the guard is what makes
  // it a failed test in milliseconds instead.
  const bin = shimDir(t, { mktemp: `ims_shim_append ${q(log)} "entered"\nexec mktemp "$@"` })

  const run = runBash('mktemp -d', { cwd: root, env: { PATH: `${bin}:${process.env.PATH ?? ''}` } })

  assert.equal(run.status, SHIM_REENTERED, `the second entry must exit ${SHIM_REENTERED}: ${run.stderr}`)
  assert.match(run.stderr, /re-entered itself/)
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 1,
    'and it must have recorded exactly once — the guard fires BEFORE the second recording')

  // And the other half: a recording that has already run away is refused rather than extended.
  const full = join(root, 'full.log')
  writeFileSync(full, `x\n`.repeat(SHIM_LOG_MAX_LINES))
  const capped = shimDir(t, { mktemp: `ims_shim_append ${q(full)} "one more"\nexec ${REAL.mktemp} "$@"` })
  const run2 = runBash('mktemp -d', { cwd: root, env: { PATH: `${capped}:${process.env.PATH ?? ''}` } })
  assert.equal(run2.status, SHIM_LOG_FULL, `a full log must exit ${SHIM_LOG_FULL}: ${run2.stderr}`)
  assert.equal(readFileSync(full, 'utf8').trim().split('\n').length, SHIM_LOG_MAX_LINES,
    'and nothing may be appended to it')
})

test('[o3d-rn10] a shim that blocks without delegating or recording is failed by the harness deadline, and its descendants die with it', (t) => {
  const root = createTempDirSync('ims-rn10-deadline-', t)
  const tick = join(root, 'tick')
  writeFileSync(tick, '')

  // NEITHER OF THE TWO EXISTING BRAKES CAN SEE THIS ONE, which is the finding. It never delegates,
  // so the re-entry marker is never reached a second time; it never calls ims_shim_append, so the
  // line cap is never consulted. It just blocks — the shape of a shim that waits on a lock, or
  // reads a pipe nobody writes, or spins.
  //
  // The background descendant ticks a file so that "the process GROUP was terminated" is something
  // this test can OBSERVE rather than assume. It records with a raw `>>` and deliberately, outside
  // the bounded append: this recording is the proof that the bound worked, and it is bounded by
  // the deadline itself. Its output goes to /dev/null so that it cannot hold the harness's own
  // pipes open — a survivor must show up as a still-growing file, never as a second hang.
  const bin = shimDir(t, {
    mktemp: [
      `( while :; do printf 'x' >> ${q(tick)}; ${REAL.sleep} 0.05; done ) >/dev/null 2>&1 &`,
      'while :; do :; done',
    ].join('\n'),
  })

  const started = Date.now()
  assert.throws(
    () => runBash('mktemp -d', { cwd: root, env: { PATH: `${bin}:${process.env.PATH ?? ''}` }, deadlineMs: 3000 }),
    /harness deadline of 3s exceeded/,
    'a shim that simply blocks must FAIL the harness rather than occupy it',
  )
  const elapsed = Date.now() - started
  assert.ok(elapsed >= 2_500, `the deadline must be what ended it, not an earlier error (${elapsed}ms)`)
  assert.ok(elapsed < 30_000, `and it must end AT the deadline rather than run on (${elapsed}ms)`)

  // NOT VACUOUS: the blocking shim really was reached, and it really did leave a descendant running.
  const atDeadline = statSync(tick).size
  assert.ok(atDeadline > 5, `the blocking shim must have been reached and left a descendant ticking: ${atDeadline} ticks`)

  // AND THE DESCENDANT DIED WITH THE SHELL. This is why the bound is `timeout` and not
  // execFileSync's own `timeout` option: Node kills the process it spawned, and a shell leaves
  // children behind. `timeout` without --foreground puts the command in its own process group and
  // signals the GROUP.
  sleepSync(700)
  assert.equal(statSync(tick).size, atDeadline,
    'a descendant of the killed shell must not still be running after the deadline')
})

// ---------------------------------------------------------------------------
// SITE 1 and 2 — publish_durable_file(), the publisher ${APP_DIR}/.env,
// ${APP_DIR}/.deploy-meta, the cutover marker and the cron backup all go through.
// ---------------------------------------------------------------------------

test('[o3d-czpy] publish_durable_file refuses a symlink planted at its staging directory, and writes nothing into the target', (t) => {
  const root = createTempDirSync('ims-czpy-stage-', t)
  const appDir = join(root, 'app')
  const victim = join(root, 'victim')
  mkdirSync(appDir)
  mkdirSync(victim)
  writeFileSync(join(victim, 'keep'), 'UNTOUCHED\n')
  // 0700 DELIBERATELY, AND IT IS WHAT MAKES THIS TEST DISCRIMINATE. The `cd`-then-lstat pin asks
  // for uid ${self} and mode 0700; an attacker directory left at 0755 would be refused by the MODE
  // even if the mkdir had followed the link, and the test would then pass while proving nothing
  // about the mkdir. At 0700 — and, in this same-uid harness, at the harness's own uid — the pin
  // is satisfied, so the ONLY thing standing between this publication and the victim directory is
  // that `mkdir` is plain and not `mkdir -p`.
  chmodSync(victim, 0o700)

  // The plant: the service account owns ${APP_DIR}, so it can create this name before the
  // installer does. `mkdir -p` would work happily inside it; a plain `mkdir` fails with EEXIST.
  symlinkSync(victim, join(appDir, '.ims-publish'))

  const script = rig(PUBLISHER, [
    `printf 'SECRET=abc\\n' | publish_durable_file "${appDir}/.env" "" 600`,
    'echo "rc=$?"',
  ].join('\n'), roots({ app: appDir }))
  const run = runBash(script)

  assert.match(run.stdout, /^rc=1$/m, 'the publication must REFUSE rather than stage inside a directory it did not create')
  assert.deepEqual(readdirSync(victim), ['keep'], 'and nothing may be created inside the symlink target')
  assert.equal(readFileSync(join(victim, 'keep'), 'utf8'), 'UNTOUCHED\n')
  assert.ok(!existsSync(join(appDir, '.env')), 'and no .env may be published off the back of a refused staging directory')
})

test('[o3d-czpy] publish_durable_file replaces a symlink planted at its target instead of writing through it', (t) => {
  const root = createTempDirSync('ims-czpy-target-', t)
  const appDir = join(root, 'app')
  const victim = join(root, 'victim.txt')
  mkdirSync(appDir)
  writeFileSync(victim, 'UNTOUCHED\n')
  chmodSync(victim, 0o600)
  symlinkSync(victim, join(appDir, '.env'))

  const script = rig(PUBLISHER, [
    `printf 'SECRET=abc\\n' | publish_durable_file "${appDir}/.env" "" 600`,
    'echo "rc=$?"',
  ].join('\n'), roots({ app: appDir }))
  const run = runBash(script)

  assert.match(run.stdout, /^rc=0$/m, run.stderr)
  assert.equal(readFileSync(victim, 'utf8'), 'UNTOUCHED\n', 'rename(2) replaces the symlink ENTRY; it must never open its target')
  assert.equal(lstatSync(join(appDir, '.env')).isSymbolicLink(), false, 'and the published name must be a regular file afterwards')
  assert.equal(readFileSync(join(appDir, '.env'), 'utf8'), 'SECRET=abc\n')
  assert.equal(statSync(join(appDir, '.env')).mode & 0o777, 0o600)
})

test('[o3d-czpy] publish_durable_file refuses a DIRECTORY planted at its target instead of filling it', (t) => {
  const root = createTempDirSync('ims-czpy-dirtarget-', t)
  const appDir = join(root, 'app')
  mkdirSync(appDir)
  // The other thing the service account can leave at a name this installer is about to publish.
  // A plain `mv` moves the temporary INTO a destination that is a directory, which would leave
  // ${APP_DIR}/.env a directory holding one stray `publish.XXXXXX` while the run reported success
  // and the service failed to start. `mv -T` refuses, and the caller dies with the reason.
  mkdirSync(join(appDir, '.env'))

  const script = rig(PUBLISHER, [
    `printf 'SECRET=abc\\n' | publish_durable_file "${appDir}/.env" "" 600`,
    'echo "rc=$?"',
  ].join('\n'), roots({ app: appDir }))
  const run = runBash(script)

  assert.match(run.stdout, /^rc=1$/m, 'the publication must refuse a directory at the target name')
  assert.deepEqual(readdirSync(join(appDir, '.env')), [],
    'and must not leave a stray temporary inside it')
})

test('[o3d-czpy] publish_durable_file creates its temporary INSIDE the staging directory, not beside the target', (t) => {
  const root = createTempDirSync('ims-czpy-mktemp-', t)
  const appDir = join(root, 'app')
  mkdirSync(appDir)
  const log = join(root, 'mktemp.log')

  // A shim that records the argv and the cwd it was called from, then delegates. The finding is
  // that everything done to the temporary is done BY PATH inside a directory the service account
  // owns; a temporary made beside the target is the state that has that exposure.
  const bin = shimDir(t, {
    // Absolute paths inside every shim: the shim directory is FIRST on PATH, so a bare `mktemp`
    // here would re-enter this file forever — see the guard in shimDir(), and the test above it.
    mktemp: `ims_shim_append ${q(log)} "$(printf '%s\\t%s' "$PWD" "$*")"\nexec ${REAL.mktemp} "$@"`,
  })

  const script = rig(PUBLISHER, [
    `printf 'SECRET=abc\\n' | publish_durable_file "${appDir}/.env" "" 600`,
    'echo "rc=$?"',
  ].join('\n'), roots({ app: appDir }))
  const run = runBash(script, { env: { PATH: `${bin}:${process.env.PATH ?? ''}` } })

  assert.match(run.stdout, /^rc=0$/m, run.stderr)
  const lines = readFileSync(log, 'utf8').trim().split('\n')
  assert.equal(lines.length, 1, `mktemp must be called exactly once: ${lines.join(' | ')}`)
  const [cwd, argv] = lines[0].split('\t')
  assert.equal(cwd, join(appDir, '.ims-publish'), 'the temporary is made from inside the staging directory')
  assert.equal(argv, './publish.XXXXXX', 'and by a RELATIVE name, so no path resolution can move it')
  assert.ok(!argv.includes(appDir), 'never as an absolute path inside the directory the service account owns')
})

test('[o3d-czpy] publish_durable_file applies the mode before the content, so a secret never exists at the wrong one', (t) => {
  const root = createTempDirSync('ims-czpy-mode-', t)
  const appDir = join(root, 'app')
  mkdirSync(appDir)
  const log = join(root, 'chmod.log')

  // The measurement is the SIZE OF THE FILE at the instant chmod runs. Mode applied first means an
  // empty file; mode applied after `cat` means the secrets are already in it.
  const bin = shimDir(t, {
    chmod: `last="\${@: -1}"\nsz=$(${REAL.stat} -c '%s' "$last" 2>/dev/null || echo -1)\nims_shim_append ${q(log)} "$(printf '%s\\t%s' "$sz" "$*")"\nexec ${REAL.chmod} "$@"`,
  })

  const script = rig(PUBLISHER, [
    `printf 'SECRET=abcdefghij\\n' | publish_durable_file "${appDir}/.env" "" 600`,
    'echo "rc=$?"',
  ].join('\n'), roots({ app: appDir }))
  const run = runBash(script, { env: { PATH: `${bin}:${process.env.PATH ?? ''}` } })

  assert.match(run.stdout, /^rc=0$/m, run.stderr)
  const entries = readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split('\t'))
  const onTheTemp = entries.filter(([, argv]) => argv.includes('publish.'))
  assert.equal(onTheTemp.length, 1, `chmod must be called once on the temporary: ${JSON.stringify(entries)}`)
  assert.equal(onTheTemp[0][0], '0', 'the temporary must still be EMPTY when its mode is set — mode before content, never a chmod after it')
})

test('[o3d-czpy] publish_durable_file publishes into the directory it staged in, even after that directory\'s NAME is swapped for a symlink', (t) => {
  const root = createTempDirSync('ims-czpy-parentswap-', t)
  const dataDir = join(root, 'data')
  const gitSsh = join(dataDir, 'git-ssh')
  const moved = join(dataDir, 'git-ssh.moved')
  // The privileged directory the swap aims at. In the shipped case this is /root/.ssh and the file
  // that lands in it is a known_hosts owned by the service account — which is a root login.
  const victim = join(root, 'root-dot-ssh')
  mkdirSync(gitSsh, { recursive: true })
  mkdirSync(victim)
  writeFileSync(join(victim, 'known_hosts'), 'UNTOUCHED\n')

  // THE SWAP, FIRED FROM INSIDE THE PUBLICATION. `mktemp` runs after the staging directory has been
  // created, chowned and ENTERED and before the rename: every pin this function takes is already
  // taken, and the destination is still nothing but a pathname. ${DATA_DIR} belongs to ${APP_USER}
  // on an upgrade, so renaming `git-ssh` aside and leaving a link at the name is theirs to do.
  const log = join(root, 'mktemp.log')
  const bin = shimDir(t, {
    mktemp: [
      `ims_shim_append ${q(log)} "$PWD"`,
      `${REAL.mv} -T ${q(gitSsh)} ${q(moved)}`,
      `${REAL.ln} -s ${q(victim)} ${q(gitSsh)}`,
      `exec ${REAL.mktemp} "$@"`,
    ].join('\n'),
  })

  const script = rig(PUBLISHER, [
    `printf 'github.com ssh-ed25519 AAAA\\n' | publish_durable_file "${join(gitSsh, 'known_hosts')}" "" 600`,
    'echo "rc=$?"',
  ].join('\n'), roots({ data: dataDir }))
  const run = runBash(script, { env: { PATH: `${bin}:${process.env.PATH ?? ''}` } })

  // NOT VACUOUS: the swap really happened, and it happened while the publication was in flight.
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 1, 'the staging directory must have been entered once')
  assert.equal(lstatSync(gitSsh).isSymbolicLink(), true, 'and the destination NAME must now be the planted link')

  assert.match(run.stdout, /^rc=0$/m, run.stderr)
  assert.equal(readFileSync(join(victim, 'known_hosts'), 'utf8'), 'UNTOUCHED\n',
    'the publication must not follow the link the destination NAME acquired after the pin')
  assert.deepEqual(readdirSync(victim), ['known_hosts'], 'and must leave nothing else in it')
  assert.equal(readFileSync(join(moved, 'known_hosts'), 'utf8'), 'github.com ssh-ed25519 AAAA\n',
    'it lands in the directory the staging directory is IN, which is the one whose device was checked')
})

test('[o3d-secops] a staging directory MOVED WHOLESALE between the checks and the rename cannot redirect the publication', (t) => {
  /**
   * THE r19 CRITICAL ON THE PUBLISHER SIDE. Until this round the publication was
   * `mv -T "$tmp" "../${base}"` and the last barrier was `fsync_path ..`. `..` is the kernel's own
   * parent link, so no rename of any NAME above the staging directory can redirect it — but it is
   * a property of WHERE THE STAGING DIRECTORY IS, re-read at every syscall, and a staging directory
   * moved WHOLESALE into another parent takes `../${base}` with it. The `..` check happens before
   * the temporary is created; the rename happens after it is filled and fsynced.
   *
   * WHAT ACTUALLY STOPPED THAT MOVE IN PRODUCTION WAS NEVER WRITTEN DOWN: renaming a directory into
   * a DIFFERENT parent requires write permission on the directory being moved, and the staging
   * directory is root-owned 0700, so the service account gets EACCES. The publication's safety
   * rested on the staging directory's MODE, one inference away from the code, in a function whose
   * whole subject is not resting on properties of the staging directory. It now rests on a
   * descriptor opened on the destination before the staging directory exists.
   *
   * ROUTE: a `sync` shim. fsync_path()'s first barrier is `sync ./publish.XXXXXX`, which runs after
   * every pin and every check and immediately before the rename — the exact window. The shim moves
   * the staging directory into a parent of the attacker's choosing and then delegates. THIS HARNESS
   * RUNS AS ONE UID, so the move SUCCEEDS here where a service account would get EACCES: that is
   * deliberate, and it is what lets the descriptor be measured on its own rather than through the
   * permission check that happens to stand in front of it.
   */
  const root = createTempDirSync('ims-secops-stagemove-', t)
  const dataDir = join(root, 'data')
  const gitSsh = join(dataDir, 'git-ssh')
  // WHERE THE STAGING DIRECTORY IS MOVED TO, and therefore where `../known_hosts` would land: a
  // directory of the attacker's choosing, inside ${DATA_DIR} so it is theirs to write.
  const attacker = join(dataDir, 'attacker')
  mkdirSync(gitSsh, { recursive: true })
  mkdirSync(attacker)

  const log = join(root, 'sync.log')
  const shims = (moveTo: string) => shimDir(t, {
    sync: [
      // ONLY THE FIRST BARRIER, and only once: the second `sync` is of the destination itself, and
      // firing on it would move the staging directory after the publication had already happened.
      `if [[ "${'${1:-}'}" == ./publish.* && ! -e ${q(log)} ]]; then`,
      `  ims_shim_append ${q(log)} "$PWD"`,
      `  ${REAL.mv} -T "$PWD" ${q(moveTo)}`,
      'fi',
      `exec ${REAL.sync} "$@"`,
    ].join('\n'),
  })

  const body = [
    `printf 'github.com ssh-ed25519 AAAA\\n' | publish_durable_file "${join(gitSsh, 'known_hosts')}" "" 600`,
    'echo "rc=$?"',
  ].join('\n')
  const bin = shims(join(attacker, 'stolen'))
  const run = runBash(rig(PUBLISHER, body, roots({ data: dataDir })), { env: { PATH: `${bin}:${process.env.PATH ?? ''}` } })

  // NOT VACUOUS: the shim fired, in the window, and the move really happened.
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 1,
    'the first barrier must have been reached exactly once')
  assert.equal(existsSync(join(attacker, 'stolen')), true,
    'and the staging directory must really have been moved into the attacker’s parent')
  assert.equal(existsSync(join(gitSsh, '.ims-publish')), false, 'so it is no longer where it was staged')

  assert.match(run.stdout, /^rc=0$/m, `the publication must still complete: ${run.stderr}`)
  assert.equal(readFileSync(join(gitSsh, 'known_hosts'), 'utf8'), 'github.com ssh-ed25519 AAAA\n',
    'and it must land in the directory the descriptor was opened on')
  assert.deepEqual(readdirSync(join(attacker, 'stolen')), [],
    'nothing may be published into the parent the staging directory was moved to')
  assert.deepEqual(readdirSync(attacker).sort(), ['stolen'], 'nor beside it')

  // MEASURED BY MUTATION, ROUTE STATED: the shipped publisher with the two lines this round changed
  // put back to what they were — the rename through `../${base}` and the barrier through `..`. The
  // same shim, the same move, and the publication then lands in the attacker's directory. That is
  // the finding, and it is what makes the descriptor load-bearing rather than decorative.
  const shipped = shellFunction(INSTALL_SH, 'publish_durable_file')
  const renameLine = 'if ! mv -f -T "$tmp" "/proc/self/fd/${dest}/${base}" 2>/dev/null; then rm -f "$tmp"; exit 1; fi'
  const barrierLine = 'fsync_path "/proc/self/fd/${dest}" || exit 1'
  assert.ok(shipped.includes(renameLine), `precondition: the shipped rename must go through the descriptor:\n${shipped}`)
  assert.ok(shipped.includes(barrierLine), `precondition: the shipped barrier must go through it too:\n${shipped}`)
  const preR19 = shipped
    .replace(renameLine, 'if ! mv -f -T "$tmp" "../${base}" 2>/dev/null; then rm -f "$tmp"; exit 1; fi')
    .replace(barrierLine, 'fsync_path .. || exit 1')
  assert.notEqual(preR19, shipped, 'the mutation must change the shipped publisher')

  const mutRoot = createTempDirSync('ims-secops-stagemove-mut-', t)
  const mutData = join(mutRoot, 'data')
  const mutGitSsh = join(mutData, 'git-ssh')
  const mutAttacker = join(mutData, 'attacker')
  mkdirSync(mutGitSsh, { recursive: true })
  mkdirSync(mutAttacker)
  const mutLog = join(mutRoot, 'sync.log')
  const mutBin = shimDir(t, {
    sync: [
      `if [[ "${'${1:-}'}" == ./publish.* && ! -e ${q(mutLog)} ]]; then`,
      `  ims_shim_append ${q(mutLog)} "$PWD"`,
      `  ${REAL.mv} -T "$PWD" ${q(join(mutAttacker, 'stolen'))}`,
      'fi',
      `exec ${REAL.sync} "$@"`,
    ].join('\n'),
  })
  const mutBody = [
    `printf 'github.com ssh-ed25519 AAAA\\n' | publish_durable_file "${join(mutGitSsh, 'known_hosts')}" "" 600`,
    'echo "rc=$?"',
  ].join('\n')
  // `extra` is emitted AFTER the lifted functions and before the body, so this definition wins.
  const mutated = runBash(rig(PUBLISHER, mutBody, [roots({ data: mutData }), preR19].join('\n')),
    { env: { PATH: `${mutBin}:${process.env.PATH ?? ''}` } })

  assert.equal(readFileSync(mutLog, 'utf8').trim().split('\n').length, 1, 'the mutation must meet the same shim')
  assert.match(mutated.stdout, /^rc=0$/m, `and it must report SUCCESS while doing the wrong thing: ${mutated.stderr}`)
  // `..` OF THE MOVED STAGING DIRECTORY IS ITS NEW PARENT — `${mutAttacker}`, the directory the
  // move put it in — so that is where `../${base}` resolves to and where the root-written
  // known_hosts lands.
  assert.equal(readFileSync(join(mutAttacker, 'known_hosts'), 'utf8'), 'github.com ssh-ed25519 AAAA\n',
    `through \`../\${base}\` the publication follows the moved staging directory into the attacker's parent — that is the finding this test exists to fail on: ${mutated.stderr}`)
  assert.equal(existsSync(join(mutGitSsh, 'known_hosts')), false,
    'and nothing reaches the destination it was walked to')
})

// ---------------------------------------------------------------------------
// THE INITIAL PIN (o3d-rn10). Round 2 proved the destination did not MOVE after it was pinned;
// it proved nothing about WHICH directory got pinned, because the pin was a stat of ${dir}. The
// destination is now walked down from a trusted ancestor, and these are the walk's own cases.
// ---------------------------------------------------------------------------

test('[o3d-rn10] publish_durable_file refuses a destination directory replaced by a symlink BEFORE the pin, and leaves the victim untouched', (t) => {
  const root = createTempDirSync('ims-rn10-prepin-', t)
  const dataDir = join(root, 'data')
  const gitSsh = join(dataDir, 'git-ssh')
  // /root/.ssh, in the shipped case. A service-owned known_hosts published into it is a root login.
  const victim = join(root, 'root-dot-ssh')
  mkdirSync(gitSsh, { recursive: true })
  mkdirSync(victim)
  writeFileSync(join(victim, 'known_hosts'), 'UNTOUCHED\n')

  // THE PLANT, AND IT HAPPENS BEFORE THE INSTALLER RUNS AT ALL — which is what makes this case
  // different from the parent-swap regression above. ${DATA_DIR} belongs to ${APP_USER} on every
  // upgrade, so replacing the `git-ssh` the previous run created costs them one rename and one
  // symlink, with no race to win.
  renameSync(gitSsh, join(dataDir, 'git-ssh.real'))
  symlinkSync(victim, gitSsh)

  // 0700 AND OWNED BY THIS UID, DELIBERATELY: those are exactly the properties the post-pin checks
  // ask of the staging directory, so if the walk followed this link every later check would PASS.
  // The only thing that can refuse this publication is the walk itself.
  chmodSync(victim, 0o700)
  assert.equal(statSync(victim).uid, process.getuid?.(), 'the victim must be owned by the uid the publisher runs as, or this test states nothing')

  const script = rig(PUBLISHER, [
    `printf 'PWNED\\n' | publish_durable_file "${join(gitSsh, 'known_hosts')}" "" 600`,
    'echo "rc=$?"',
  ].join('\n'), roots({ data: dataDir }))
  const run = runBash(script)

  assert.match(run.stdout, /^rc=1$/m, 'a destination that is a symlink when the walk reaches it must be REFUSED, not pinned')
  assert.equal(readFileSync(join(victim, 'known_hosts'), 'utf8'), 'UNTOUCHED\n',
    'the publication must not land in the directory the planted link chose')
  assert.deepEqual(readdirSync(victim).sort(), ['known_hosts'],
    'and nothing may be created inside it — no staging directory, no temporary')
  assert.equal(lstatSync(gitSsh).isSymbolicLink(), true, 'the plant must still be there: nothing followed it and nothing replaced it')
})

test('[o3d-rn10] publish_durable_file refuses a destination component swapped between the check that accepted it and the step into it', (t) => {
  const root = createTempDirSync('ims-rn10-walkswap-', t)
  const dataDir = join(root, 'data')
  const gitSsh = join(dataDir, 'git-ssh')
  const victim = join(root, 'root-dot-ssh')
  mkdirSync(gitSsh, { recursive: true })
  mkdirSync(victim)
  writeFileSync(join(victim, 'known_hosts'), 'UNTOUCHED\n')
  chmodSync(victim, 0o700)
  const fired = join(root, 'swapped')

  // The walk's check on an EXISTING component is `stat -c '%F' git-ssh`, made from inside
  // ${DATA_DIR}. The shim answers TRUTHFULLY — it IS a directory at the instant it is asked — and
  // only then swaps it, which is the window the finding describes made deterministic.
  const bin = shimDir(t, {
    stat: [
      `${REAL.stat} "$@"`,
      'status=$?',
      `if [[ "$*" == *git-ssh* && ! -e ${q(fired)} ]]; then`,
      `  : > ${q(fired)}`,
      `  ${REAL.mv} -T ${q(gitSsh)} ${q(join(dataDir, 'git-ssh.moved'))}`,
      `  ${REAL.ln} -s ${q(victim)} ${q(gitSsh)}`,
      'fi',
      'exit $status',
    ].join('\n'),
  })

  const script = rig(PUBLISHER, [
    `printf 'PWNED\\n' | publish_durable_file "${join(gitSsh, 'known_hosts')}" "" 600`,
    'echo "rc=$?"',
  ].join('\n'), roots({ data: dataDir }))
  const run = runBash(script, { env: { PATH: `${bin}:${process.env.PATH ?? ''}` } })

  // NOT VACUOUS: the check really was made, and the swap really happened after it.
  assert.ok(existsSync(fired), 'the walk must actually have lstat-ed the existing component')
  assert.equal(lstatSync(gitSsh).isSymbolicLink(), true, 'and the component must have been swapped for a link')

  assert.match(run.stdout, /^rc=1$/m, 'a component swapped after its check must refuse the publication')
  assert.equal(readFileSync(join(victim, 'known_hosts'), 'utf8'), 'UNTOUCHED\n')
  assert.deepEqual(readdirSync(victim).sort(), ['known_hosts'], 'and nothing may be created inside the directory the link chose')
})

test('[o3d-rn10] publish_durable_file stages inside the directory it PINNED, even when the destination NAME is swapped for a symlink after the walk', (t) => {
  const root = createTempDirSync('ims-rn10-postwalk-', t)
  const dataDir = join(root, 'data')
  const gitSsh = join(dataDir, 'git-ssh')
  const moved = join(dataDir, 'git-ssh.moved')
  const victim = join(root, 'root-dot-ssh')
  mkdirSync(gitSsh, { recursive: true })
  mkdirSync(victim)
  writeFileSync(join(victim, 'known_hosts'), 'UNTOUCHED\n')
  chmodSync(victim, 0o700)

  // THE HALF A WALK ALONE DOES NOT BUY. Walking down to the destination pins it as a descriptor —
  // and then RE-DERIVING `${dir}/${PUBLISH_STAGE_DIRNAME}` from the pathname hands that pin
  // straight back, because `mkdir`, `stat` and `chown` would each resolve ${dir} again. This shim
  // fires in exactly that window: the walk has finished, the destination is pinned, and the NAME
  // is swapped for a link the instant the staging directory is created.
  const bin = shimDir(t, {
    mkdir: [
      'for a in "$@"; do',
      '  case "$a" in',
      `    *${'.ims-publish'}) ${REAL.mv} -T ${q(gitSsh)} ${q(moved)}; ${REAL.ln} -s ${q(victim)} ${q(gitSsh)} ;;`,
      '  esac',
      'done',
      `exec ${REAL.mkdir} "$@"`,
    ].join('\n'),
  })

  const script = rig(PUBLISHER, [
    `printf 'github.com ssh-ed25519 AAAA\\n' | publish_durable_file "${join(gitSsh, 'known_hosts')}" "" 600`,
    'echo "rc=$?"',
  ].join('\n'), roots({ data: dataDir }))
  const run = runBash(script, { env: { PATH: `${bin}:${process.env.PATH ?? ''}` } })

  // NOT VACUOUS: the swap fired, and it fired while the publication was in flight.
  assert.equal(lstatSync(gitSsh).isSymbolicLink(), true, 'the destination NAME must have been swapped for the planted link')

  assert.match(run.stdout, /^rc=0$/m, `the publication must complete in the directory it pinned: ${run.stderr}`)
  assert.deepEqual(readdirSync(victim).sort(), ['known_hosts'],
    'and NOTHING may be created inside the directory the link chose — not even the staging directory')
  assert.equal(readFileSync(join(victim, 'known_hosts'), 'utf8'), 'UNTOUCHED\n')
  assert.equal(readFileSync(join(moved, 'known_hosts'), 'utf8'), 'github.com ssh-ed25519 AAAA\n',
    'it lands in the directory the walk pinned, which is the one the rename was proved against')
})

test('[o3d-rn10] publish_durable_file refuses a component swapped for a symlink to a SIBLING under the same parent', (t) => {
  const root = createTempDirSync('ims-rn10-sibling-', t)
  const dataDir = join(root, 'data')
  const gitSsh = join(dataDir, 'git-ssh')
  // A DIRECTORY UNDER THE SAME PARENT — in the shipped tree, ${DATA_DIR}/locks, which is root-owned
  // and holds the crontab reconciliation lock. `..` alone CANNOT tell it apart from the real
  // destination, because its parent IS ${DATA_DIR}: that is the residual o3d-rn10 was filed with,
  // and the one case that looked as though it needed openat2. The lstat'ed inode tells them apart.
  const sibling = join(dataDir, 'locks')
  mkdirSync(gitSsh, { recursive: true })
  mkdirSync(sibling)
  writeFileSync(join(sibling, '.crontab-reconcile.lock'), '')
  const fired = join(root, 'swapped')

  const bin = shimDir(t, {
    stat: [
      `${REAL.stat} "$@"`,
      'status=$?',
      `if [[ "$*" == *git-ssh* && ! -e ${q(fired)} ]]; then`,
      `  : > ${q(fired)}`,
      `  ${REAL.mv} -T ${q(gitSsh)} ${q(join(dataDir, 'git-ssh.moved'))}`,
      `  ${REAL.ln} -s ${q(sibling)} ${q(gitSsh)}`,
      'fi',
      'exit $status',
    ].join('\n'),
  })

  const script = rig(PUBLISHER, [
    `printf 'PWNED\\n' | publish_durable_file "${join(gitSsh, 'known_hosts')}" "" 600`,
    'echo "rc=$?"',
  ].join('\n'), roots({ data: dataDir }))
  const run = runBash(script, { env: { PATH: `${bin}:${process.env.PATH ?? ''}` } })

  // NOT VACUOUS: the swap fired, and the link really does point at a sibling whose parent is the
  // same directory the walk came from — so the `..` check alone would have accepted it.
  assert.ok(existsSync(fired), 'the walk must actually have lstat-ed the component')
  assert.equal(lstatSync(gitSsh).isSymbolicLink(), true)
  assert.equal(statSync(join(sibling, '..')).ino, statSync(dataDir).ino,
    'the sibling must share the destination\'s parent, or this test is the same case as the one above')

  assert.match(run.stdout, /^rc=1$/m, 'the walk must land in the inode it lstat-ed, not merely under the parent it expected')
  assert.deepEqual(readdirSync(sibling).sort(), ['.crontab-reconcile.lock'],
    'and nothing may be created inside the sibling the link chose')
})

test('[o3d-rn10] publish_durable_file refuses a destination MOVED WHOLESALE into another parent, though its inode never changed', (t) => {
  const root = createTempDirSync('ims-rn10-reparent-', t)
  const dataDir = join(root, 'data')
  const gitSsh = join(dataDir, 'git-ssh')
  // A parent the service account controls entirely. Moving the destination there and leaving a
  // symlink behind keeps the INODE the walk lstat-ed, so the identity check alone accepts it —
  // this is the case `..` is for, and the reason both checks are kept.
  const elsewhere = join(root, 'attacker')
  mkdirSync(gitSsh, { recursive: true })
  mkdirSync(elsewhere)
  const before = statSync(gitSsh).ino
  const fired = join(root, 'moved')

  const bin = shimDir(t, {
    stat: [
      `${REAL.stat} "$@"`,
      'status=$?',
      `if [[ "$*" == *git-ssh* && ! -e ${q(fired)} ]]; then`,
      `  : > ${q(fired)}`,
      `  ${REAL.mv} -T ${q(gitSsh)} ${q(join(elsewhere, 'git-ssh'))}`,
      `  ${REAL.ln} -s ${q(join(elsewhere, 'git-ssh'))} ${q(gitSsh)}`,
      'fi',
      'exit $status',
    ].join('\n'),
  })

  const script = rig(PUBLISHER, [
    `printf 'PWNED\\n' | publish_durable_file "${join(gitSsh, 'known_hosts')}" "" 600`,
    'echo "rc=$?"',
  ].join('\n'), roots({ data: dataDir }))
  const run = runBash(script, { env: { PATH: `${bin}:${process.env.PATH ?? ''}` } })

  // NOT VACUOUS: the move happened, and it is the SAME directory — same inode — under a new parent.
  assert.ok(existsSync(fired), 'the walk must actually have lstat-ed the component')
  assert.equal(statSync(join(elsewhere, 'git-ssh')).ino, before,
    'the destination must have kept its inode, or this test is the sibling case again')

  assert.match(run.stdout, /^rc=1$/m, 'a destination whose PARENT changed must be refused, inode or no inode')
  assert.deepEqual(readdirSync(join(elsewhere, 'git-ssh')), [],
    'and nothing may be published into it under the parent the attacker chose')
})

test('[o3d-rn10] publish_durable_file refuses a destination that lies under no trusted ancestor', (t) => {
  const root = createTempDirSync('ims-rn10-noroot-', t)
  const appDir = join(root, 'app')
  const elsewhere = join(root, 'elsewhere')
  mkdirSync(appDir)
  mkdirSync(elsewhere)

  // The roots declared are ${APP_DIR} and nothing else, so ${elsewhere} is outside every one of
  // them. A publisher that resolved its own destination would happily write here.
  const script = rig(PUBLISHER, [
    `printf 'x\\n' | publish_durable_file "${join(elsewhere, 'f')}" "" 600`,
    'echo "rc=$?"',
  ].join('\n'), roots({ app: appDir }))
  const run = runBash(script)

  assert.match(run.stdout, /^rc=1$/m, 'a destination under no trusted ancestor must be refused, not resolved')
  assert.deepEqual(readdirSync(elsewhere), [], 'and nothing may be written there')
})

test('[o3d-rn10] publish_durable_file still creates a destination directory that does not exist yet, beneath the trusted root', (t) => {
  const root = createTempDirSync('ims-rn10-create-', t)
  const dataDir = join(root, 'data')
  mkdirSync(dataDir)

  // NOT VACUOUS in the other direction: a walk that refused everything would pass all three tests
  // above and fail this one. `mkdir -p "$dir"` is what this replaces, and a first install reaches
  // publish_durable_file with ${DATA_DIR}/git-ssh not yet created.
  const script = rig(PUBLISHER, [
    `printf 'github.com ssh-ed25519 AAAA\\n' | publish_durable_file "${join(dataDir, 'git-ssh/known_hosts')}" "" 600`,
    'echo "rc=$?"',
  ].join('\n'), roots({ data: dataDir }))
  const run = runBash(script)

  assert.match(run.stdout, /^rc=0$/m, run.stderr)
  assert.equal(readFileSync(join(dataDir, 'git-ssh/known_hosts'), 'utf8'), 'github.com ssh-ed25519 AAAA\n')
  assert.equal(statSync(join(dataDir, 'git-ssh/known_hosts')).mode & 0o777, 0o600)
})

// ---------------------------------------------------------------------------
// THE ANCHOR (o3d-rn10 r2). Round 1 admitted a candidate by its SPELLING and preferred the
// deepest match, and wrote the reason each shipped root is trustworthy — "its own parent is
// root-owned and not writable by ${APP_USER}" — in a comment beside the table. Three of the six
// are operator-settable, so that sentence is a claim about a particular VALUE and the table holds
// only NAMES. publish_root_anchored() now proves it, per candidate, at the moment of publication.
//
// WHAT AN UNPRIVILEGED HARNESS CAN AND CANNOT PLANT, STATED RATHER THAN GLOSSED. In production the
// unanchored parent is unanchored because ${APP_USER} OWNS it — and a harness running as an
// ordinary user cannot make a directory owned by somebody else. So the tests below plant the OTHER
// half of the same predicate, the one a mode can express: a parent that is group- or
// other-writable, which is a parent the service account can rename inside just as surely. The
// ownership half is measured on its own, directly, by stubbing `id -u` — see the two
// publish_root_anchored tests at the end of this block.
// ---------------------------------------------------------------------------

test('[o3d-rn10] publish_durable_file refuses a nested CUTOVER_STATE_DIR replaced by a symlink, and demotes the walk to the anchored root above it', (t) => {
  const root = createTempDirSync('ims-rn10-nested-', t)
  const dataDir = join(root, 'data')
  // ${IMS_CUTOVER_STATE_DIR}=${DATA_DIR}/cutover — the layout docs/installation.md tells operators
  // they may set, and the case the finding is written about.
  const cutover = join(dataDir, 'cutover')
  // Another instance's state namespace, or /root/.ssh. A DEPLOY-FENCED published in here is a
  // root-side write into a directory the service account chose.
  const victim = join(root, 'victim')
  mkdirSync(dataDir)
  mkdirSync(victim)
  writeFileSync(join(victim, 'DEPLOY-FENCED'), 'UNTOUCHED\n')

  // THE PLANT COSTS ONE RENAME AND ONE SYMLINK, with no race to win: ${DATA_DIR} belongs to
  // ${APP_USER} after every upgrade's recursive chown, so `cutover` is theirs to replace between
  // runs. Here the same thing is expressed with a mode: 0777 is a directory anybody can rename
  // inside, which is exactly the standing ${APP_USER} has on the real ${DATA_DIR}.
  chmodSync(dataDir, 0o777)
  symlinkSync(victim, cutover)

  // 0700 and owned by the publishing uid, deliberately — every check made AFTER the walk would
  // pass on this directory, so only the anchor can refuse it.
  chmodSync(victim, 0o700)

  const script = rig(PUBLISHER, [
    `printf 'PWNED\\n' | publish_durable_file "${join(cutover, 'DEPLOY-FENCED')}" "" 600`,
    'echo "rc=$?"',
  ].join('\n'), roots({ data: dataDir, cutover }))
  const run = runBash(script)

  // NOT VACUOUS: the destination really does still MATCH the candidate text — the string table
  // would have admitted it — and the name really is a symlink at the moment of the publication.
  assert.equal(lstatSync(cutover).isSymbolicLink(), true, 'the nested root must be a planted symlink, or this test states nothing')
  assert.equal(statSync(cutover).ino, statSync(victim).ino, 'and it must resolve to the victim')

  assert.match(run.stdout, /^rc=1$/m, 'a nested root the service account can replace must not be a starting point')
  assert.equal(readFileSync(join(victim, 'DEPLOY-FENCED'), 'utf8'), 'UNTOUCHED\n',
    'the publication must not land in the directory the planted link chose')
  assert.deepEqual(readdirSync(victim).sort(), ['DEPLOY-FENCED'],
    'and nothing may be created inside it — no staging directory, no temporary')
})

test('[o3d-rn10] publish_durable_file still publishes into a nested unanchored root that is a real directory, by walking to it from the anchored one', (t) => {
  const root = createTempDirSync('ims-rn10-nested-ok-', t)
  const dataDir = join(root, 'data')
  const cutover = join(dataDir, 'cutover')
  mkdirSync(cutover, { recursive: true })
  // Unanchored for the same reason as above, and this time NOT under attack. Demotion has to be a
  // demotion: a walk from ${DATA_DIR} through `cutover`, not a refusal. A publisher that refused
  // every unanchored candidate outright would pass the test above and fail this one.
  chmodSync(dataDir, 0o777)

  const script = rig(PUBLISHER, [
    `printf 'phase=stopping\\n' | publish_durable_file "${join(cutover, 'DEPLOY-FENCED')}" "" 600`,
    'echo "rc=$?"',
  ].join('\n'), roots({ data: dataDir, cutover }))
  const run = runBash(script)

  assert.match(run.stdout, /^rc=0$/m, run.stderr)
  assert.equal(readFileSync(join(cutover, 'DEPLOY-FENCED'), 'utf8'), 'phase=stopping\n',
    'the supported nested layout must keep working')
  assert.equal(statSync(join(cutover, 'DEPLOY-FENCED')).mode & 0o777, 0o600)
})

test('[o3d-rn10] publish_durable_file walks a nested root from the OUTER anchor even when the nested one is anchored too, so a symlink at it is refused', (t) => {
  const root = createTempDirSync('ims-rn10-nested-anchored-', t)
  const dataDir = join(root, 'data')
  // An intermediate directory the service account CANNOT rename inside: 0755, owned by the
  // publishing uid. So `${state}/inner` has an anchor of its own, and round 1's deepest-match rule
  // would start the walk AT it — following the symlink with `cd -P`, which is what a root gets.
  const state = join(dataDir, 'state')
  const inner = join(state, 'inner')
  const victim = join(root, 'victim')
  mkdirSync(state, { recursive: true })
  mkdirSync(victim)
  writeFileSync(join(victim, 'DEPLOY-FENCED'), 'UNTOUCHED\n')
  chmodSync(victim, 0o700)
  chmodSync(state, 0o755)
  symlinkSync(victim, inner)

  const script = rig(PUBLISHER, [
    `printf 'PWNED\\n' | publish_durable_file "${join(inner, 'DEPLOY-FENCED')}" "" 600`,
    'echo "rc=$?"',
  ].join('\n'), roots({ data: dataDir, cutover: inner }))
  const run = runBash(script)

  // NOT VACUOUS: the nested candidate really would have passed the anchor check on its own, so
  // what refuses this publication is the SELECTION and not the anchor.
  const anchored = runBash(rig([...ANCHOR], `publish_root_anchored "${inner}"; echo "rc=$?"`))
  assert.match(anchored.stdout, /^rc=0$/m, 'the nested candidate must itself be anchored, or this test is the previous one again')

  assert.match(run.stdout, /^rc=1$/m, 'the walk must start at the outer anchor, which resolves the nested name as an ordinary component')
  assert.equal(readFileSync(join(victim, 'DEPLOY-FENCED'), 'utf8'), 'UNTOUCHED\n')
  assert.deepEqual(readdirSync(victim).sort(), ['DEPLOY-FENCED'], 'and nothing may be created inside the directory the link chose')
})

test('[o3d-rn10] an unanchored operator override with no anchored root above it is refused outright, and nothing is created at it', (t) => {
  const root = createTempDirSync('ims-rn10-override-', t)
  // `IMS_CUTOVER_STATE_DIR=/home/svc/state`: an override pointing at a directory whose parent the
  // service account controls, and which lies under no other root. There is nothing to demote it
  // to, so the answer is a refusal at the write rather than a publication into it.
  const home = join(root, 'svc-home')
  const state = join(home, 'state')
  mkdirSync(state, { recursive: true })
  chmodSync(home, 0o777)

  const script = rig(PUBLISHER, [
    `printf 'PWNED\\n' | publish_durable_file "${join(state, 'DEPLOY-FENCED')}" "" 600`,
    'echo "rc=$?"',
  ].join('\n'), roots({ cutover: state }))
  const run = runBash(script)

  assert.match(run.stdout, /^rc=1$/m, 'an unanchored override must not become a trusted root by being spelled in the table')
  assert.deepEqual(readdirSync(state), [], 'and nothing may be written into it — not the file, not a staging directory')
})

test('[o3d-rn10] pin_dir_beneath_root refuses an unanchored root of its own accord, whoever handed it one', (t) => {
  const root = createTempDirSync('ims-rn10-pin-anchor-', t)
  // The root the walk is TOLD to start from, with a parent anybody can rename inside. In the
  // shipped path publish_trust_root() would never name it — this asks the function that acts on
  // the answer, because it is the one that runs `mkdir -p` and `cd -P` on the root's own name.
  const home = join(root, 'svc-home')
  const state = join(home, 'state')
  mkdirSync(state, { recursive: true })
  chmodSync(home, 0o777)

  const run = runBash(rig([...ROOT_ENTRY],
    `pin_dir_beneath_root "${state}" "${join(state, 'deploy')}"; echo "rc=$?"`))

  assert.match(run.stdout, /^rc=1$/m, 'the walk must not start from a root it was handed without an anchor')
  assert.deepEqual(readdirSync(state), [], 'and it must create nothing under it — not even the first component')

  // NOT VACUOUS: the same call, with the same directories, succeeds once the parent is one only
  // its owner can rename inside. So what refused it was the anchor and not the walk.
  chmodSync(home, 0o755)
  const ok = runBash(rig([...ROOT_ENTRY],
    `pin_dir_beneath_root "${state}" "${join(state, 'deploy')}"; echo "rc=$?"`))
  assert.match(ok.stdout, /^rc=0$/m, `an anchored root must still be walked: ${ok.stderr}`)
  assert.deepEqual(readdirSync(state), ['deploy'], 'and the component created')
})

/**
 * WHETHER THIS MACHINE'S OWN ANCESTRY CAN STAND BEHIND A SHIPPED ROOT (o3d-secops).
 *
 * WHY ANY TEST HERE NAMES AN ABSOLUTE PATH AT ALL. Every hierarchy these harnesses build is built
 * by the account running them, so every walk over one answers through the `owner == $self` half of
 * the container question. The OTHER half — "the parent belongs to root" — is the one an
 * unprivileged harness cannot plant, because it cannot chown a directory to root: the only
 * root-owned parents it will ever see are the machine's own. `/opt`, `/var/lib` and `/etc` are
 * therefore named for that branch and for nothing else, and this is the whole of what a real path
 * is used for below.
 *
 * AND WHY THE ANSWER IS CONDITIONAL. Those directories are root-owned and 0755 on a deployment
 * host and NEED NOT BE ON A BUILD RUNNER — where `/opt` is group-writable, and where this file
 * therefore failed one assertion while the function it tests was entirely correct. A unit test may
 * not require the permissions of the box it runs on. So the ancestry is CHECKED first, with node's
 * own lstat, and the assertion is made only where the check holds; where it does not, the case is
 * reported by name and not asserted, which is a stated skip and not a silent pass.
 *
 * IT RESTATES THE WALK'S RULE RATHER THAN ASKING THE SHIPPED FUNCTION, deliberately. A gate that
 * asked the subject its own question would step aside in exactly the case where the subject was
 * wrong. It is a GATE AND NEVER AN EXPECTATION: every expected rc below is written out literally,
 * and this function's only output is a reason to say nothing.
 *
 * THE RULE IT RESTATES is the one pin_publish_root_parent() applies, at its STRICTEST reading — the
 * shipped roots' parents are claimed to be ROOT-owned, not merely owned by whoever runs this, so a
 * host that satisfies this gate satisfies the uid-0 branch specifically. Each directory from `/`
 * down must be a real directory owned by root; an ANCESTOR may be writable by others only with the
 * sticky bit; the root's own PARENT may not be writable by others at all, sticky or not.
 */
function rootOwnedAncestryDefect(candidate: string): string | undefined {
  const parent = dirname(candidate)
  const chain: string[] = ['/']
  for (const part of parent.split('/')) if (part !== '') chain.push(join(chain[chain.length - 1], part))
  for (const dir of chain) {
    let entry
    try {
      entry = lstatSync(dir)
    } catch {
      return `${dir} does not exist or cannot be read`
    }
    if (entry.isSymbolicLink()) return `${dir} is a symbolic link`
    if (!entry.isDirectory()) return `${dir} is not a directory`
    if (entry.uid !== 0) return `${dir} is owned by uid ${entry.uid} and not by root`
    const mode = entry.mode & 0o7777
    if ((mode & 0o022) === 0) continue
    if (dir === parent) return `${dir} is mode 0${mode.toString(8)}, and a root's own parent gets no sticky credit`
    if ((mode & 0o1000) === 0) return `${dir} is mode 0${mode.toString(8)}, which others can write and which is not sticky`
  }
  return undefined
}

/** The roots the shipped table names whose parents the paragraph above claims are root-owned.
 *  Spelled here rather than taken from SHIPPED_ROOTS, which is a check on the TABLE's contents and
 *  would silently change what these assertions ask if the table grew an entry. */
const SHIPPED_ROOTS_WITH_ROOT_OWNED_PARENTS = ['/opt/one-two-inventory', '/var/lib/one-two-inventory', '/etc/ims-cutover'] as const

test('[o3d-rn10] publish_root_anchored decides on the PARENT mode, and does not credit the sticky bit', (t) => {
  const root = createTempDirSync('ims-rn10-anchor-mode-', t)
  const parent = join(root, 'parent')
  const candidate = join(parent, 'candidate')
  mkdirSync(candidate, { recursive: true })

  // The candidate's own mode is deliberately wide open throughout: what is being measured is who
  // can replace the NAME, which is a property of the directory the name lives in.
  chmodSync(candidate, 0o777)

  const cases: ReadonlyArray<readonly [number, boolean]> = [
    [0o700, true],
    [0o755, true],
    [0o750, true],
    [0o775, false],
    [0o757, false],
    [0o707, false],
    // /tmp's mode. The sticky bit stops a non-owner REPLACING an entry that already exists and
    // says nothing about the first install, where the root does not exist yet.
    [0o1777, false],
  ]
  for (const [mode, expected] of cases) {
    chmodSync(parent, mode)
    const run = runBash(rig([...ANCHOR], `publish_root_anchored "${candidate}"; echo "rc=$?"`))
    assert.match(run.stdout, new RegExp(`^rc=${expected ? 0 : 1}$`, 'm'),
      `a parent at mode 0${mode.toString(8)} must be ${expected ? 'anchored' : 'refused'}: ${run.stdout}${run.stderr}`)
  }

  // AND THE SHIPPED ROOTS' REAL PARENTS, which is the one part of this test that needs an absolute
  // path — see rootOwnedAncestryDefect() for why, and for why the machine is asked whether it can
  // stand behind the claim before the claim is made of it. A host whose `/opt` anybody can write
  // into says nothing whatever about publish_root_anchored(), so on such a host this states the
  // defect and asks nothing.
  for (const dir of SHIPPED_ROOTS_WITH_ROOT_OWNED_PARENTS) {
    const defect = rootOwnedAncestryDefect(dir)
    if (defect !== undefined) {
      t.diagnostic(`not asked of ${dir}: this host cannot stand behind a shipped root — ${defect}`)
      continue
    }
    const run = runBash(rig([...ANCHOR], `publish_root_anchored "${dir}"; echo "rc=$?"`))
    assert.match(run.stdout, /^rc=0$/m, `${dir} must be anchored: ${run.stdout}${run.stderr}`)

    // AND THROUGH THE uid-0 BRANCH, which is the only reason a real path is here: with an `id` that
    // answers a uid owning none of these directories, `owner == $self` cannot be what admitted
    // them, so what did is the branch no harness-built hierarchy can reach.
    const foreign = runBash(rig([...ANCHOR], `publish_root_anchored "${dir}"; echo "rc=$?"`,
      'id() { printf "%s\\n" 424242; }'))
    assert.match(foreign.stdout, /^rc=0$/m,
      `${dir} must be anchored through the uid-0 branch: ${foreign.stdout}${foreign.stderr}`)
  }

  // AND THE SAME QUESTION AT A REAL PATH, THE OTHER WAY ROUND. `/tmp/ims-state` is refused because
  // its parent is one anybody may create an entry in — sticky bit and all, which is the table's
  // last row planted where an operator would really try it. A `/tmp` nobody else could write into
  // would make the EXPECTATION wrong rather than the function, so that too is checked; the mode
  // itself is not asserted, because this test is not about how a machine ships its /tmp.
  const tmpMode = statSync('/tmp').mode & 0o7777
  if ((tmpMode & 0o022) === 0) {
    t.diagnostic(`not asked of /tmp/ims-state: /tmp is mode 0${tmpMode.toString(8)}, which no other account can write into`)
  } else {
    const run = runBash(rig([...ANCHOR], 'publish_root_anchored "/tmp/ims-state"; echo "rc=$?"'))
    assert.match(run.stdout, /^rc=1$/m, `/tmp/ims-state must be refused: ${run.stdout}${run.stderr}`)
  }
})

test('[o3d-rn10] publish_root_anchored refuses a parent that belongs to neither root nor the account running the publication', (t) => {
  const root = createTempDirSync('ims-rn10-anchor-owner-', t)
  const parent = join(root, 'parent')
  const candidate = join(parent, 'candidate')
  mkdirSync(candidate, { recursive: true })
  chmodSync(parent, 0o755)

  // THE OWNERSHIP HALF, WHICH IS THE ONE PRODUCTION ACTUALLY TRIPS ON and which no unprivileged
  // harness can plant: the finding's ${DATA_DIR} is unanchored because ${APP_USER} OWNS it, not
  // because of its mode. It is measured from the other side instead — the shipped function asks
  // `id -u` for the account it must belong to, so a run that answers a DIFFERENT uid is a run
  // whose privileged account does not own this parent. `stat` stays real throughout.
  const foreign = runBash(rig([...ANCHOR],
    `publish_root_anchored "${candidate}"; echo "rc=$?"`,
    'id() { printf "%s\\n" 424242; }'))
  assert.match(foreign.stdout, /^rc=1$/m,
    `a parent owned by neither uid 0 nor the running account must be refused: ${foreign.stdout}${foreign.stderr}`)

  // NOT VACUOUS: the same directory, at the same mode, with the real `id`, is anchored — so what
  // the line above measured is the ownership comparison and not some other refusal.
  const own = runBash(rig([...ANCHOR], `publish_root_anchored "${candidate}"; echo "rc=$?"`))
  assert.match(own.stdout, /^rc=0$/m, `and it must be anchored for the account that owns it: ${own.stdout}${own.stderr}`)

  // And the uid-0 branch is reachable with that same foreign `id`: /etc belongs to root, and root
  // is the privileged account by definition however this process was started. THE ONE ABSOLUTE PATH
  // IN THIS TEST, for the reason rootOwnedAncestryDefect() gives — no harness can chown a directory
  // to root — and gated for the same reason: a machine whose /etc ancestry does not qualify would
  // fail this line while the function was right, which is a fact about the machine.
  const etcDefect = rootOwnedAncestryDefect('/etc/ims-cutover')
  if (etcDefect !== undefined) {
    t.diagnostic(`the uid-0 branch is not asked of /etc/ims-cutover: ${etcDefect}`)
  } else {
    const rootOwned = runBash(rig([...ANCHOR],
      `publish_root_anchored "/etc/ims-cutover"; echo "rc=$?"`,
      'id() { printf "%s\\n" 424242; }'))
    assert.match(rootOwned.stdout, /^rc=0$/m, `a root-owned parent must be anchored regardless of who runs this: ${rootOwned.stdout}${rootOwned.stderr}`)
  }
})

// ---------------------------------------------------------------------------
// THE ANCHOR'S OWN ANCESTRY (o3d-rn10 r4). Round 3 asked one question of the candidate's PARENT
// and asked it of a pathname. A parent nobody else can write into is worth nothing if somebody
// else can rename the parent — the question recurses, and `/` is the only place it stops.
// ---------------------------------------------------------------------------

test('[o3d-rn10] the anchor refuses a candidate whose GRANDPARENT can be written by somebody else, though its parent cannot', (t) => {
  const root = createTempDirSync('ims-rn10-ancestry-', t)
  // `/home/app/guard/state` — the finding's own example. `guard` is beyond reproach and `/home/app`
  // is the service account's, so `guard` can be renamed aside wholesale and a tree of the
  // attacker's left at that name with `state` a symlink inside it.
  const outer = join(root, 'outer')
  const parent = join(outer, 'parent')
  const state = join(parent, 'state')
  mkdirSync(state, { recursive: true })
  chmodSync(outer, 0o755)
  chmodSync(parent, 0o755)

  const publish = (): Run => runBash(rig(PUBLISHER, [
    `printf 'phase=stopping\\n' | publish_durable_file "${join(state, 'DEPLOY-FENCED')}" "" 600`,
    'echo "rc=$?"',
  ].join('\n'), roots({ data: state })))

  // The layout as an operator would leave it: every directory on the way owned by the publishing
  // account and closed to everyone else. This must keep working, or the anchor is just a refusal.
  assert.match(publish().stdout, /^rc=0$/m, 'a candidate with a clean ancestry must still publish')
  assert.equal(readFileSync(join(state, 'DEPLOY-FENCED'), 'utf8'), 'phase=stopping\n')

  // And now the one change: the GRANDPARENT becomes a directory somebody else can rename inside.
  // Expressed with a mode, because an unprivileged harness cannot make a directory owned by
  // another account — it is the same standing ${APP_USER} has on /home/app.
  chmodSync(outer, 0o775)

  // NOT VACUOUS: the parent itself is still exactly what round 3 admitted — owned by the account
  // running the publication, with no group or other write bit. A check that stopped at the parent
  // would have to say yes.
  const parentStat = statSync(parent)
  assert.equal(parentStat.mode & 0o777, 0o755, 'the parent must still be 0755')
  assert.equal(parentStat.uid, process.getuid?.(), 'and still owned by the publishing account')
  const anchored = runBash(rig([...ANCHOR], `publish_root_anchored "${state}"; echo "rc=$?"`))
  assert.match(anchored.stdout, /^rc=1$/m, 'a candidate whose grandparent is writable must not be a root')

  // The state the first, LEGITIMATE publication left — `.ims-publish` included, which that run
  // created and does not remove. Snapshotted rather than spelled out, so what the next lines
  // measure is what the REFUSED run added, and not the difference between two shapes of success.
  const before = readdirSync(state).sort()
  assert.deepEqual(before, ['.ims-publish', 'DEPLOY-FENCED'], 'the first publication must have staged and landed')

  const refused = publish()
  assert.match(refused.stdout, /^rc=1$/m, 'and the publication must be refused rather than resolved')
  assert.deepEqual(readdirSync(state).sort(), before,
    'nothing new may be created under it — no staging directory, no temporary')
  assert.deepEqual(readdirSync(join(state, '.ims-publish')), [],
    'and nothing may be left inside the staging directory the earlier run made')
  assert.equal(readFileSync(join(state, 'DEPLOY-FENCED'), 'utf8'), 'phase=stopping\n',
    'and the marker the first publication left must be untouched')

  // AND BACK: the grandparent is the discriminator, and nothing else changed.
  chmodSync(outer, 0o755)
  assert.match(publish().stdout, /^rc=0$/m, 'closing the grandparent again must restore the publication')
})

test('[o3d-rn10] the anchor refuses a candidate reached through a SYMLINKED ancestor, and publishes into the same directory named directly', (t) => {
  const root = createTempDirSync('ims-rn10-linkancestor-', t)
  const real = join(root, 'real')
  const state = join(real, 'parent', 'state')
  mkdirSync(state, { recursive: true })
  // An ancestor that is a name for somewhere else. `cd -P` on the way down would follow it and the
  // walk would then be proving things about a path nobody stated; the root is the ONE component
  // this publisher follows a link through, and it earns that by having a proven parent.
  const link = join(root, 'link')
  symlinkSync(real, link)
  const viaLink = join(link, 'parent', 'state')

  const refused = runBash(rig(PUBLISHER, [
    `printf 'PWNED\\n' | publish_durable_file "${join(viaLink, 'DEPLOY-FENCED')}" "" 600`,
    'echo "rc=$?"',
  ].join('\n'), roots({ data: viaLink })))

  // NOT VACUOUS: the link is real, and it resolves to the very directory the next assertion
  // publishes into successfully — so the refusal is about the SPELLING and not about the target.
  assert.equal(lstatSync(link).isSymbolicLink(), true)
  assert.equal(statSync(viaLink).ino, statSync(state).ino)

  assert.match(refused.stdout, /^rc=1$/m, 'an ancestor resolved by following a link is an ancestor taken on trust')
  assert.deepEqual(readdirSync(state), [], 'and nothing may be written through it')

  const allowed = runBash(rig(PUBLISHER, [
    `printf 'phase=stopping\\n' | publish_durable_file "${join(state, 'DEPLOY-FENCED')}" "" 600`,
    'echo "rc=$?"',
  ].join('\n'), roots({ data: state })))
  assert.match(allowed.stdout, /^rc=0$/m, allowed.stderr)
  assert.equal(readFileSync(join(state, 'DEPLOY-FENCED'), 'utf8'), 'phase=stopping\n')
})

test('[o3d-rn10] the anchor credits the sticky bit on an ANCESTOR and never on the parent', (t) => {
  const root = createTempDirSync('ims-rn10-sticky-', t)
  const mid = join(root, 'mid')
  const parent = join(mid, 'parent')
  const candidate = join(parent, 'candidate')
  mkdirSync(candidate, { recursive: true })
  chmodSync(parent, 0o755)

  const ask = (dir: string, extra = ''): Run =>
    runBash(rig([...ANCHOR], `publish_root_anchored "${dir}"; echo "rc=$?"`, extra))

  // An ancestor anybody may write into is an ancestor anybody may rename `parent` inside.
  chmodSync(mid, 0o777)
  assert.match(ask(candidate).stdout, /^rc=1$/m, 'a world-writable ancestor must refuse the candidate')

  // The SAME directory with the sticky bit set is /tmp's own mode, and it is the reason every
  // harness in this file can build an anchored root at all: sticky lets anybody create entries and
  // lets only the entry's owner move one, so `parent` — which exists, and belongs to the account
  // running this — cannot be swapped out from under the walk.
  chmodSync(mid, 0o1777)
  assert.match(ask(candidate).stdout, /^rc=0$/m, 'sticky must be credited for an ancestor whose entry we own')

  // AND THIS IS THE LIVE INSTANCE OF THE RULE, not a hypothetical: every harness in this file
  // builds under /tmp, which is root-owned and world-writable, so the sticky credit is what lets a
  // mkdtemp directory anchor anything at all. Remove the credit and twenty tests here fail, which
  // is the honest account of why it is there.
  //
  // THE MODE IS READ AND THE IMPLICATION IS ASSERTED, rather than the mode itself (o3d-secops). How
  // a machine ships its /tmp is a fact about the machine, and this test is not about that: a /tmp
  // no other account could write into would make the credit UNNECESSARY here, not wrong, and a
  // unit test may not go red over it. What must hold, and what is asserted, is the pairing — a
  // /tmp that is world-writable and NOT sticky is a machine on which the paragraph above is empty.
  const tmpMode = statSync('/tmp').mode & 0o7777
  if ((tmpMode & 0o022) === 0) {
    t.diagnostic(`/tmp is mode 0${tmpMode.toString(8)}: no other account can write into it, so the sticky credit is not what carries these harnesses on this machine`)
  } else {
    assert.equal(tmpMode & 0o1000, 0o1000,
      `/tmp is mode 0${tmpMode.toString(8)} — world-writable and not sticky — so the line above states nothing`)
  }
  assert.equal(statSync(root).uid, process.getuid?.(), 'and the mkdtemp directory must belong to this account')

  // WHAT THIS HARNESS CANNOT PLANT, STATED RATHER THAN GLOSSED. The credit is against the WRITE
  // BITS alone and never against the ownership requirement — but showing that needs a sticky
  // directory owned by neither uid the walk accepts, and every sticky directory on a machine
  // (/tmp, /var/tmp, /dev/shm) belongs to root, which the walk accepts unconditionally. An
  // unprivileged harness cannot make one. What IS measured, directly, is that the ownership
  // requirement applies to every directory on the walk — see the foreign-`id` test above.

  // AND NEVER FOR THE PARENT, because on a first install the root does not exist yet and sticky
  // says nothing about who gets to CREATE an entry. This is the /tmp/ims-state case, one level in.
  chmodSync(mid, 0o755)
  chmodSync(parent, 0o1777)
  assert.match(ask(candidate).stdout, /^rc=1$/m, 'a sticky PARENT must still refuse the candidate')
})

/**
 * THE WINDOW THE ANCHOR USED TO LEAVE OPEN, BUILT RATHER THAN ARGUED (o3d-rn10 r4, Codex HIGH).
 *
 * Round 3's shape was: publish_root_anchored() stats the parent BY PATHNAME and says yes;
 * pin_dir_beneath_root() then runs `mkdir -p "$root"` and `cd -P "$root"` — two more resolutions of
 * the same pathname, after the check and independent of it. Everything between the two is a window,
 * and the entry into the root is the one step this publisher takes on a name rather than on an
 * inode, so anything landing in that window aims it.
 *
 * THE SWAP IS INJECTED BY A SHIM ON `mkdir`, WHICH IS THE FIRST THING THE ACTING PATH DOES AND THE
 * ONLY `mkdir` EITHER SHAPE REACHES BEFORE IT ENTERS THE ROOT. Selecting the root does not run
 * `mkdir` at all — publish_trust_root() only ever stats — so the shim cannot fire during the
 * lexical pass, and it fires at the same instant for the fixed publisher and for the round-3 one:
 * after the parent has been accepted, before the root has been entered. That is what makes this a
 * race and not two different tests.
 *
 * WHAT THE FIXED PUBLISHER DOES WITH IT: nothing, because by then it is not holding a pathname. The
 * walk ended INSIDE the parent, `mkdir` and `cd -P` are given one relative component, and the
 * kernel resolves them from the directory this process is standing in — which the rename moved a
 * name away from and could not move the process out of. The publication lands in the operator's
 * real directory under its new name, and the attacker's tree is never entered.
 *
 * MEASURED BY MUTATION, ROUTE STATED. Restoring round 3's two lines in scripts/install.sh —
 * `publish_root_anchored "$root"` followed by `mkdir -p "$root"` and `cd -P "$root"` — makes this
 * test fail with PWNED in the victim directory, because the absolute `cd -P` resolves the
 * attacker's `parent` and follows the `state` symlink they left in it.
 */
test('[o3d-rn10] a parent replaced AFTER the anchor accepted it does not redirect the publication', (t) => {
  const root = createTempDirSync('ims-rn10-swap-', t)
  const anchor = join(root, 'anchor')
  const parent = join(anchor, 'parent')
  const state = join(parent, 'state')
  const victim = join(root, 'victim')
  mkdirSync(state, { recursive: true })
  mkdirSync(victim)
  writeFileSync(join(victim, 'DEPLOY-FENCED'), 'UNTOUCHED\n')
  // 0700 and owned by the publishing uid, so that every check made AFTER the entry would pass on
  // it: the only thing that can keep this publication out of here is where the entry went.
  chmodSync(victim, 0o700)

  const log = join(root, 'swapped.log')
  const bin = shimDir(t, {
    // FIRES ONCE, on the first `mkdir` of the run, and does what ${APP_USER} can do to a parent
    // whose own parent they own: rename it aside, put a directory of their own at the name, and
    // leave a symlink inside it at the name the publisher is about to enter.
    mkdir: [
      `if [[ ! -e ${q(log)} ]]; then`,
      `  ims_shim_append ${q(log)} "swapped"`,
      `  ${REAL.mv} ${q(parent)} ${q(`${parent}.real`)}`,
      `  ${REAL.mkdir} ${q(parent)}`,
      `  ${REAL.ln} -s ${q(victim)} ${q(join(parent, 'state'))}`,
      'fi',
      `exec ${REAL.mkdir} "$@"`,
    ].join('\n'),
  })

  const run = runBash(rig(PUBLISHER, [
    `printf 'phase=stopping\\n' | publish_durable_file "${join(state, 'DEPLOY-FENCED')}" "" 600`,
    'echo "rc=$?"',
  ].join('\n'), roots({ data: state })), { env: { PATH: `${bin}:${process.env.PATH ?? ''}` } })

  // NOT VACUOUS: the swap really happened, in this run, and the plant is still standing at the
  // moment the assertions look at it. A shim that never fired would leave every line below true
  // for the boring reason.
  assert.equal(readFileSync(log, 'utf8').trim(), 'swapped', 'the swap must have been injected exactly once')
  assert.equal(lstatSync(join(parent, 'state')).isSymbolicLink(), true,
    'the attacker directory must still hold a symlink at the name the publisher was entering')
  assert.equal(statSync(join(parent, 'state')).ino, statSync(victim).ino, 'and it must resolve to the victim')

  // THE SECURITY CLAIM FIRST, so a regression names itself: the swap must not have aimed anything.
  assert.equal(readFileSync(join(victim, 'DEPLOY-FENCED'), 'utf8'), 'UNTOUCHED\n',
    'the directory the planted link chose must not be written into')
  assert.deepEqual(readdirSync(victim).sort(), ['DEPLOY-FENCED'],
    'and nothing may be created inside it — no staging directory, no temporary')

  assert.match(run.stdout, /^rc=0$/m, `the publication must go through, into the directory it pinned: ${run.stderr}`)
  assert.equal(readFileSync(join(`${parent}.real`, 'state', 'DEPLOY-FENCED'), 'utf8'), 'phase=stopping\n',
    'and it must land in the operator\'s own directory, which the rename moved but did not replace')
})

/**
 * THE ONE HOP THE WALK DID NOT PROVE (o3d-rn10 r5, Codex HIGH).
 *
 * Until r5 the ROOT, and only the root, was entered with a bare `cd -P` that followed a symlink
 * DELIBERATELY: a ${DATA_DIR} pointing at a second disk was a supported operator layout, and the
 * link's own name sits in a parent the anchor walk proves only the privileged account can write.
 * That argument covers the ENTRY and nothing else. `/var/lib/ims -> /srv/disk2/ims` is resolved
 * through `/srv/disk2`, which no walk here touches and which the service account may own — so they
 * rename `ims` aside on the second disk and leave a link to a victim at that name. The root entry
 * in /var/lib never changes, every anchor check passes on it, and the publication creates its
 * staging directory and writes the fixed destination basename, as root, where they chose.
 *
 * WHAT WAS CHOSEN, AND WHAT IT COSTS. The root is now created, lstat-ed, entered and inode/`..`
 * checked exactly like every component below it, and a SYMLINK AT IT IS REFUSED. The alternate
 * disk becomes a bind mount: `mount --bind DISK /var/lib/ims` plus the matching fstab line, which
 * is the same indirection resolved ONCE, at mount time, out of a table only root can write. The
 * refusal prints those two commands, because an operator whose state root is a symlink today will
 * meet it at their next deploy. Pinning the target instead would have kept the symlink working, at
 * the cost of a second path proved from `/` on every publication, a link chain to bound, and a
 * third copy of both to hold byte-identical across the three entrypoints.
 */

/** scripts/install.sh's pin_dir_beneath_root() with the root entry restored to what it was before
 *  r5 — a plain `mkdir` and a bare `cd -P`, with no lstat between them. THE MUTATION for the test
 *  below, lifted and edited rather than re-typed so it cannot drift into a different function. */
function preR5RootEntry(): string {
  const body = shellFunction(INSTALL_SH, 'pin_dir_beneath_root')
  const from = '  mkdir "$base" 2>/dev/null || true\n'
  const to = '  here="${entry#*|}"\n'
  const start = body.indexOf(from)
  const end = body.indexOf(to)
  assert.notEqual(start, -1, 'the shipped root entry must still begin with a plain mkdir of $base')
  assert.ok(end > start, 'and must end by carrying the root component inode into $here')
  const mutated = body.slice(0, start)
    + from
    + '  cd -P "$base" 2>/dev/null || return 1\n'
    + '  here="$(stat -c \'%d:%i\' . 2>/dev/null || true)"\n'
    + '  [[ -n "$here" ]] || return 1\n'
    + body.slice(end + to.length)
  assert.notEqual(mutated, body, 'the mutation must change the shipped function')
  // AND IT MUST REMOVE EXACTLY WHAT IS BEING MEASURED: the root's own lstat, and the refusal it
  // feeds. The loop below keeps its own lstat and its own "symbolic link" comment, which is why
  // this is asserted on the root's line and on the message rather than on the phrase.
  assert.ok(!mutated.includes(`entry="$(stat -c '%F|%d:%i' "$base"`), 'the root lstat must be gone')
  // o3d-secops r7: the four printf lines moved into refuse_symlinked_root(), so `mount --bind` is
  // no longer IN this body and asserting its absence became vacuous — it would have passed over a
  // mutation that removed nothing. The precondition is asserted on the shipped body first, so the
  // absence below can only be the mutation's doing.
  assert.ok(body.includes('refuse_symlinked_root "$root"'),
    'precondition: the shipped root entry must refuse a symlink through the shared refusal')
  assert.ok(!mutated.includes('refuse_symlinked_root'), 'and the mutation must remove that refusal')
  return mutated
}

/** The layout the finding is about, planted on a real filesystem: an anchored parent (`/var/lib`)
 *  holding a SYMLINKED state root, whose target lives on a second disk in a directory the service
 *  account can write — and which they have already rebound to a victim. The root ENTRY is
 *  untouched throughout, which is the point: nothing about it can be refused. */
function plantSymlinkedRoot(t: TestContext, prefix: string) {
  const base = createTempDirSync(prefix, t)
  const varlib = join(base, 'var-lib')
  const stateRoot = join(varlib, 'ims')
  const disk = join(base, 'srv-disk2')
  const target = join(disk, 'ims')
  const victim = join(base, 'victim')
  mkdirSync(target, { recursive: true })
  mkdirSync(varlib)
  mkdirSync(victim)
  writeFileSync(join(victim, 'DEPLOY-FENCED'), 'UNTOUCHED\n')
  // 0700 and owned by the publishing uid, so every check made AFTER the entry passes on it: only
  // the entry itself can keep this publication out.
  chmodSync(victim, 0o700)
  // Root-owned-and-0755 in production; here, the property a harness can plant is the same one —
  // nobody but the owner may rename inside it, so the link at `ims` is not forgeable.
  chmodSync(varlib, 0o755)
  symlinkSync(target, stateRoot)
  // AND THE HALF THE ANCHOR NEVER SAW: the target's parent, which the service account owns. One
  // rename and one symlink, with no race to win.
  chmodSync(disk, 0o777)
  renameSync(target, `${target}.real`)
  symlinkSync(victim, target)
  return { base, varlib, stateRoot, disk, target, victim }
}

test('[o3d-rn10] a symlinked root does not redirect the publication into the directory its target\'s parent lets the service account choose', (t) => {
  const plant = plantSymlinkedRoot(t, 'ims-rn10-symlink-root-')

  const run = runBash(rig(PUBLISHER, [
    `printf 'PWNED\\n' | publish_durable_file "${join(plant.stateRoot, 'DEPLOY-FENCED')}" "" 600`,
    'echo "rc=$?"',
  ].join('\n'), roots({ data: plant.stateRoot })))

  // NOT VACUOUS: the plant is standing at the moment the assertions look at it, and the root entry
  // really is the operator's own symlink — nothing about IT is what gets refused.
  assert.equal(lstatSync(plant.stateRoot).isSymbolicLink(), true, 'the root must be a symlink, or this test states nothing')
  assert.equal(lstatSync(plant.target).isSymbolicLink(), true, 'and its target name must be rebound to the victim')
  assert.equal(statSync(plant.stateRoot).ino, statSync(plant.victim).ino, 'so the root resolves to the victim')

  // THE SECURITY CLAIM FIRST.
  assert.equal(readFileSync(join(plant.victim, 'DEPLOY-FENCED'), 'utf8'), 'UNTOUCHED\n',
    'the directory the rebound target chose must not be written into')
  assert.deepEqual(readdirSync(plant.victim).sort(), ['DEPLOY-FENCED'],
    'and nothing may be created inside it — no staging directory, no temporary')
  assert.match(run.stdout, /^rc=1$/m, 'and the publication must refuse rather than land somewhere else')

  // MEASURED BY MUTATION, ROUTE STATED: the same rig, the same plant, with the root entry restored
  // to the pre-r5 `cd -P`. The publication then goes through INTO THE VICTIM — which is the finding
  // itself, executed. Everything else in the rig is shipped text, so the redirect can only come
  // from the four lines preR5RootEntry() puts back.
  const attacked = plantSymlinkedRoot(t, 'ims-rn10-symlink-root-mutated-')
  const mutated = runBash(rig(PUBLISHER.filter((n) => n !== 'pin_dir_beneath_root'), [
    `printf 'PWNED\\n' | publish_durable_file "${join(attacked.stateRoot, 'DEPLOY-FENCED')}" "" 600`,
    'echo "rc=$?"',
  ].join('\n'), [roots({ data: attacked.stateRoot }), preR5RootEntry()].join('\n')))

  assert.match(mutated.stdout, /^rc=0$/m, `the pre-r5 root entry must publish, or the mutation proves nothing: ${mutated.stderr}`)
  assert.equal(readFileSync(join(attacked.victim, 'DEPLOY-FENCED'), 'utf8'), 'PWNED\n',
    'and it must land in the victim — that redirect is the finding, and this test exists because the shipped code no longer allows it')
})

test('[o3d-rn10] the refusal of a symlinked root names the bind mount an operator must use instead', (t) => {
  const base = createTempDirSync('ims-rn10-symlink-refusal-', t)
  const varlib = join(base, 'var-lib')
  const stateRoot = join(varlib, 'ims')
  const disk = join(base, 'srv-disk2')
  const target = join(disk, 'ims')
  mkdirSync(target, { recursive: true })
  mkdirSync(varlib)
  chmodSync(varlib, 0o755)
  // BENIGN: nobody has touched the target. This is the operator layout that used to be supported,
  // with no attack on it at all — the refusal has to be legible to the person who built it.
  symlinkSync(target, stateRoot)

  const script = (dest: string) => rig(PUBLISHER, [
    `printf 'phase=stopping\\n' | publish_durable_file "${dest}" "" 600`,
    'echo "rc=$?"',
  ].join('\n'), roots({ data: stateRoot }))

  const refused = runBash(script(join(stateRoot, 'DEPLOY-FENCED')))
  assert.match(refused.stdout, /^rc=1$/m, 'a symlinked root must be refused')
  assert.deepEqual(readdirSync(target), [], 'and nothing may be written through the link')
  assert.ok(refused.stderr.includes(`${stateRoot} is a symbolic link`),
    `the refusal must name the root it refused: ${refused.stderr}`)
  assert.match(refused.stderr, /bind-mount the disk onto it/,
    'and say what to do instead')
  assert.match(refused.stderr, /rsyncs into this root with --delete and chowns it RECURSIVELY/,
    'and WHY an aliased root is unsafe, which is the half an operator has to weigh')
  assert.match(refused.stderr, /no data has to move/,
    'and the fact that answers the question an operator asks first')
  assert.ok(refused.stderr.includes(`This run resolved that link to: ${realpathSync(stateRoot)}`), refused.stderr)
  // AND NOTHING THAT CAN BE PASTED (o3d-secops r8, Codex HIGH). The refusal used to print a
  // five-step `rm && mkdir -p && mount --bind` procedure behind an apparatus that decided whether
  // it was safe to print — and that apparatus produced a finding in every review it survived, the
  // last being the procedure itself: `rm ROOT && mkdir -p ROOT && mount --bind …` is raceable in a
  // parent somebody else can write, and `/var/log` — LOG_DIR's parent — is exactly that on Ubuntu,
  // as this same script says elsewhere. It points at the documentation now.
  assert.match(refused.stderr, /docs\/installation\.md, "Putting a state root on another disk"/, refused.stderr)
  for (const command of NO_PASTEABLE_COMMAND) {
    assert.ok(!command.test(refused.stderr),
      `the refusal must print no command to paste, and ${command} matched: ${refused.stderr}`)
  }

  // NOT VACUOUS: the SAME layout with a real directory at the root name publishes. What is refused
  // is the LINK, not the location — an alternate disk is still supported, as a mount rather than a
  // symlink, and the test below enters a real mount point to show that walk works.
  unlinkSync(stateRoot)
  renameSync(target, stateRoot)
  const ok = runBash(script(join(stateRoot, 'DEPLOY-FENCED')))
  assert.match(ok.stdout, /^rc=0$/m, `a real directory at the same root name must still publish: ${ok.stderr}`)
  assert.equal(readFileSync(join(stateRoot, 'DEPLOY-FENCED'), 'utf8'), 'phase=stopping\n')
})

/** A directory that is a MOUNT POINT, whose parent is one only its owner can rename inside — which
 *  is structurally what `mount --bind DISK /var/lib/ims` produces. An unprivileged harness cannot
 *  create one, so one already on the machine is used; the candidates are ordered by how universal
 *  they are, and the predicate is checked rather than assumed. */
function existingMountPoint(): string | undefined {
  const self = process.getuid?.() ?? 0
  return ['/dev/shm', '/run', '/proc', '/sys', '/dev'].find((path) => {
    try {
      if (!lstatSync(path).isDirectory()) return false
      const parent = statSync(dirname(path))
      if (parent.uid !== 0 && parent.uid !== self) return false
      if ((parent.mode & 0o022) !== 0) return false
      return statSync(path).dev !== parent.dev
    } catch {
      return false
    }
  })
}

test('[o3d-rn10] the walk enters a real MOUNT POINT at the root, which is what an alternate disk must now be', (t) => {
  const mount = existingMountPoint()
  // STATED RATHER THAN GLOSSED: `mount --bind` needs CAP_SYS_ADMIN, which this harness does not
  // have, so the mechanism r5 mandates is measured against a mount that is already there. To path
  // resolution a bind mount and a filesystem mount are the same object, and what is being measured
  // is precisely a path-resolution property: that the new lstat, the inode comparison and the `..`
  // comparison all agree across a mount boundary, where the entry in the parent and the directory
  // the walk lands in belong to different filesystems.
  assert.ok(mount, 'no mount point with a non-writable root-owned parent was found; this test cannot state anything without one')

  const entered = runBash(rig([...ROOT_ENTRY], `pin_dir_beneath_root "${mount}" "${mount}"; echo "rc=$?"`))
  assert.match(entered.stdout, /^rc=0$/m, `a mounted root must be walked into: ${entered.stderr}`)

  // AND A SYMLINK TO THE VERY SAME DIRECTORY IS NOT. Same target, same contents, same everything
  // the walk could measure about where it lands — only the entry differs, which is the distinction
  // this round draws and the reason the refusal is not simply "that directory is unusable".
  const base = createTempDirSync('ims-rn10-mountpoint-', t)
  const varlib = join(base, 'var-lib')
  const link = join(varlib, 'mounted')
  mkdirSync(varlib)
  chmodSync(varlib, 0o755)
  symlinkSync(mount, link)
  const viaLink = runBash(rig([...ROOT_ENTRY], `pin_dir_beneath_root "${link}" "${link}"; echo "rc=$?"`))
  assert.match(viaLink.stdout, /^rc=1$/m, 'a symlink to the same mounted directory must be refused')
  assert.ok(viaLink.stderr.includes(`${link} is a symbolic link`), viaLink.stderr)
})

/**
 * EVERY SHIPPED PUBLICATION, AND THE DIRECTORY IT LANDS IN (o3d-rn10).
 *
 * publish_durable_file() now REFUSES a destination it cannot relate to a trusted ancestor, so the
 * table and the call sites have to agree or an install fails at the write. All three entrypoints
 * carry the publisher byte for byte, so all three are measured. `$canonical` is broken out into the
 * three values import_legacy_cutover_state() passes it, because a shell expression is not a path.
 */
const ENTRYPOINTS = ['scripts/install.sh', 'scripts/deploy.sh', 'scripts/update.sh'] as const

/** Destination expressions per entrypoint, and how many `publish_durable_file "` call sites each
 *  has — so a NEW publication fails this test until its destination is stated and shown to have a
 *  root. */
const SHIPPED_PUBLICATIONS: Readonly<Record<string, { readonly callSites: number, readonly targets: readonly string[] }>> = {
  'scripts/install.sh': {
    callSites: 9,
    targets: [
      '$(db_ca_generation_file abc123)',
      '${DB_ROLE_ROTATION_JOURNAL}',
      '${FENCE_FILE}',
      '${DB_ENV_SNAPSHOT_FILE}',
      '${DEPLOY_SSH_KNOWN_HOSTS}',
      '${DEPLOY_META_FILE}',
      '${APP_DIR}/.env',
      // `$canonical`
      '${DB_FENCE_STATE}', '${CRON_BACKUP}', '${FENCE_FILE}',
    ],
  },
  'scripts/deploy.sh': {
    callSites: 4,
    targets: ['${FENCE_FILE}', '${DB_ENV_SNAPSHOT_FILE}', '${DB_FENCE_STATE}', '${CRON_BACKUP}'],
  },
  'scripts/update.sh': {
    callSites: 5,
    targets: ['${FENCE_FILE}', '${DB_ENV_SNAPSHOT_FILE}', '${DB_FENCE_IDENTITY_FILE}', '${DB_FENCE_STATE}', '${CRON_BACKUP}'],
  },
}

/** Every constant those targets are composed from, across the three scripts and the shared fence
 *  library. A script that does not define one simply does not contribute it. */
const PUBLICATION_CONSTANTS = [
  'APP_NAME', 'APP_DIR', 'DATA_DIR', 'DEPLOY_SSH_DIR', 'DEPLOY_SSH_KNOWN_HOSTS',
  'CUTOVER_STATE_DIR',
  // o3d-secops r22: the root-owned parent the shared lock and the connection-fence directory moved
  // under. BEFORE ${DB_FENCE_DIR}, which is composed from it, for the same ordering reason as the
  // marker's directory below.
  'CUTOVER_ROOT_DIR',
  // o3d-secops r20: the marker's own root-owned directory, and the path it was moved out of. Both
  // are read by the privileged mechanism without being re-derived, so both are held to the same
  // rule as everything beside them. AFTER ${CUTOVER_STATE_DIR}, because these declarations are
  // evaluated in this order and the second of them is composed from it.
  'FENCE_MARKER_DIR', 'LEGACY_STATE_DIR_FENCE_FILE',
  'FENCE_FILE', 'CRON_BACKUP', 'DB_FENCE_DIR', 'DB_FENCE_STATE', 'LEGACY_STATE_DIR_DB_FENCE_STATE',
  'DB_ENV_SNAPSHOT_DIR', 'DB_ENV_SNAPSHOT_FILE', 'DB_CA_PUBLISH_DIR',
  'DB_CA_GENERATION_PREFIX', 'DB_CA_GENERATION_SUFFIX', 'DB_ROLE_ROTATION_JOURNAL',
  'DEPLOY_META_FILE', 'DB_FENCE_RECOVERY_DIR', 'DB_FENCE_IDENTITY_FILE',
]

/** The same set plus the staging directory every publication is written through. */
const PROTECTED_CONSTANTS = [...PUBLICATION_CONSTANTS, 'PUBLISH_STAGE_DIRNAME']

/** The roots publish_trust_root_candidates() can name, at their shipped values. A resolution to
 *  anything else means the table has grown a directory nobody argued for.
 *
 *  /etc/ims-cutover-state joined them in o3d-secops r22: the connection-fence record is IMPORTED
 *  into it by publish_durable_file(), so a table that did not name it would refuse that import —
 *  which is the failure mode this list exists to catch, arriving from the other direction. */
const SHIPPED_ROOTS = new Set([
  '/opt/one-two-inventory', '/var/lib/one-two-inventory', '/root/ims/onetwo3d-ims',
  '/etc/ims-cutover', '/etc/ims-cutover-state', '/etc/ims-db-ca', '/etc/ims-cutover-recovery',
])

const FENCE_LIBRARY = 'scripts/lib/db-fence-protected.sh'
const FENCE_LIB = readFileSync(join(REPO, FENCE_LIBRARY), 'utf8')

/**
 * THE SHARED LIBRARY'S OWN PROTECTED SET (o3d-secops r2, Codex HIGH).
 *
 * The previous round put `readonly` on the entrypoints' publication constants and stopped at the
 * file boundary — one rule, several files, one protected, which is this branch's recurring defect.
 * These are the names scripts/lib/db-fence-protected.sh declares that the PRIVILEGED mechanism
 * trusts without re-deriving, and every one of them is declared once and reassigned nowhere.
 *
 * HOW THE SET WAS DECIDED — by reading what the library declares, not by copying the finding's
 * list of seven kinds. Every script-scope declaration in the file was enumerated (the census below
 * does exactly that, from bash's own reading) and each was asked one question: does the mechanism
 * ACT on this value without checking it again?
 *
 *   eleven PATHS   it reads, writes, seals, renames through or EXECUTES every one of them. Re-aim
 *                  ${DB_FENCE_SCRIPT_COPY} and root runs a file of the application account's
 *                  choosing with DEPLOY_ADMIN_DATABASE_URL beside it; re-aim
 *                  ${DB_FENCE_ARTEFACT_FILE} and the digest is compared against a record somebody
 *                  else wrote. ${DB_FENCE_RETIRED_APP_DIR} is on the list though the finding's
 *                  seven kinds do not name it: it is the destination a publication renames the
 *                  STANDING artefact to, so it is a write, and it was found by enumerating rather
 *                  than by transcribing. ${DB_FENCE_RESOLVE_WRAPPER} joined them in o3d-secops
 *                  r26: it is a root-owned 0700 file this library WRITES, and the path the
 *                  validator's refusal sends an operator to — re-aim it and the one command
 *                  offered for resolving an ambiguous authority is a file of somebody else's
 *                  choosing, run as root with the admin credential beside it.
 *   two DIGESTS    ${DB_FENCE_EXPECTED_SHA256} and ${DB_FENCE_EXPECTED_ARTEFACT_SHA256} are what
 *                  AUTHENTICATES a rotation. A write to either is a forged authentication, which
 *                  is the same hole as a re-aimed path and not a smaller one.
 *   two VENDOR     ${DB_FENCE_VENDOR_ROOTS} decides which packages are copied into the tree that is
 *   POLICY names   executed; ${DB_FENCE_VENDOR_MAX_FILES} bounds what a manifest in the checkout
 *                  can talk root into copying under /etc.
 *   two STRINGS    ${DB_FENCE_ARTEFACT_RECIPE} is the recorded definition of the digest and
 *                  ${DB_FENCE_ARTEFACT_SOURCE_TEXT} is the answer every refusal gives to "where do
 *                  I get that digest". Both are read by an operator deciding whether to trust a
 *                  tree.
 */
const PROTECTED_LIBRARY_CONSTANTS = [
  'DB_FENCE_RECOVERY_DIR', 'DB_FENCE_IDENTITY_FILE', 'DB_FENCE_PROTECTED_APP_DIR',
  'DB_FENCE_SCRIPT_COPY', 'DB_FENCE_STAGED_APP_DIR', 'DB_FENCE_RETIRED_APP_DIR',
  'DB_FENCE_ARTEFACT_FILE', 'DB_FENCE_MANIFEST_FILE', 'DB_FENCE_RELEASE_WRAPPER',
  'DB_FENCE_REFENCE_WRAPPER', 'DB_FENCE_RESOLVE_WRAPPER',
  'DB_FENCE_VENDOR_ROOTS', 'DB_FENCE_VENDOR_MAX_FILES',
  'DB_FENCE_ARTEFACT_RECIPE', 'DB_FENCE_ARTEFACT_SOURCE_TEXT', 'DB_FENCE_EXPECTED_SHA256',
  'DB_FENCE_EXPECTED_ARTEFACT_SHA256',
] as const

/**
 * AND THE OTHER HALF OF THE CENSUS: what the library declares that is deliberately NOT `readonly`,
 * each with the reason, because "it is not in the protected list" is not a reason.
 *
 * A name in neither list fails the census — which is what makes a path added to this library later
 * covered by the rule rather than silently outside it.
 */
const MUTABLE_LIBRARY_NAMES: Readonly<Record<string, string>> = {
  DB_FENCE_ROTATION_NOTE: 'a report: the library sets it to say why a divergence was not promoted',
  DB_FENCE_SEAL_REASON: 'a report: _fence_tree_is_sealed() names the offending path in it',
  DB_FENCE_PROBE_ARTEFACT_SHA256: 'a report: what the tree this checkout would publish hashes to',
  DB_FENCE_PROBE_STANDING_SHA256: 'a report: what the artefact already standing hashes to',
  DB_FENCE_PROBE_REASON: 'a report: why there is nothing to preflight with, and after '
    + 'db_fence_preflight() the fact that nothing was executed',
  DB_FENCE_SUDO_PREFIX:
    'not a path and not a decision: a display prefix resolved from PATH, and the one name here bash '
    + 'assigns twice by construction (a default, then a conditional)',
  // o3d-secops r31. The connection witness leaves exactly ONE name behind. The two nonces are minted
  // as `local`s in the frames that spend them and passed as arguments -- this file's own stated
  // remedy -- and the co-process's pid is not named at all, because a pid is the operand of `kill`
  // and closing the pipe ends the witness without one.
  DB_FENCE_WITNESS_BOUND:
    'a report: 0 or 1, set from what `--fence` said on its OWN connection about seeing the witness. '
    + 'It can only ever WITHHOLD the automatic removal of the fence record -- the removal itself is '
    + 'licensed by what `--release` reports out of the database, never by this flag',
  // o3d-secops r33, Codex MEDIUM. The SECOND name the witness leaves behind, and it exists because
  // the first was being made to carry two facts. "Keep the record" and "there is no witness" were
  // the same bit, so a sampling miss took the release's own challenge away with it and a
  // purportedly non-refusing status refused two steps later.
  DB_FENCE_KEEP_RECORD:
    'a report: 0 or 1, set by the closing gate when the witness never saw a backend wearing this '
    + 'run\'s migration stamp. Read with `==` in one `[[ ]]`, which is neither a command position '
    + 'nor an arithmetic context -- this census refused its first draft, which was `if ${NAME}`. It '
    + 'can only ever WITHHOLD the automatic removal of the fence record: setting it cannot cause a '
    + 'deletion, only prevent one, and it reaches no path and no digest',
}

/**
 * AND WHAT LEFT THE LIST BY CEASING TO BE A SCRIPT-SCOPE NAME AT ALL (o3d-secops r3, Codex HIGH).
 *
 * Six names that used to sit in MUTABLE_LIBRARY_NAMES are gone from the library's script scope.
 * They were not reports. Asked at the SINK rather than at the declaration:
 *
 *   DB_FENCE_PROBE_SCRIPT           EXECUTED — `node "$…" --preflight` as the application user
 *                                   with DEPLOY_ADMIN_DATABASE_URL in the environment.
 *   DB_FENCE_PROBE_TEMP             DELETION — the operand of an `rm -rf`, and the directory the
 *                                   executed path was composed from.
 *   DB_FENCE_PROBE_ARTEFACT_SHA256  AUTHENTICATION — one side of the equality against
 *                                   ${DB_FENCE_EXPECTED_ARTEFACT_SHA256} that licenses running
 *                                   checkout-derived bytes.
 *   DB_FENCE_SOURCE_UNTRUSTED_PATH  PUBLICATION — `-n` on it is the gate that refuses to publish a
 *                                   tree nothing authenticated into ${DB_FENCE_RECOVERY_DIR}.
 *   _FENCE_SRC_STRICT/PACKAGES/     the ARGV of the find that computes that gate. Empty them and
 *   _FENCE_SRC_PARENTS              the find examines nothing and reports no offender — a vacuous
 *                                   check that reads exactly like a clean one.
 *
 * None of them can carry `readonly`: every one is computed per run. So the answer was one step
 * further on — each is now a `local` of the function that derives and consumes it, and there is no
 * script-scope name for any path to write. The census below enforces that they stay gone, and
 * LIBRARY_SINK_RULES enforces the general form: a name still on the mutable list that reaches one
 * of those four sinks fails.
 *
 * DB_FENCE_PROBE_ARTEFACT_SHA256 is the one that stayed, because the NAME stayed and the ROLE did
 * not: what it holds now is the digest a dry run PRINTS, while the digest that authenticates a
 * candidate is derived inside db_fence_preflight() and never leaves it. Overwrite the survivor and
 * an operator is told a wrong value, pins with it, and the publication gate refuses — fail-closed,
 * which is what makes "report" true of it rather than merely said about it.
 */
const NO_LONGER_SCRIPT_SCOPE = [
  'DB_FENCE_PROBE_SCRIPT', 'DB_FENCE_PROBE_TEMP', 'DB_FENCE_SOURCE_UNTRUSTED_PATH',
  '_FENCE_SRC_STRICT', '_FENCE_SRC_PACKAGES', '_FENCE_SRC_PARENTS',
] as const

for (const script of ENTRYPOINTS) {
  test(`[o3d-rn10] every destination ${script} publishes to lies under a trusted ancestor`, () => {
    const source = readFileSync(join(REPO, script), 'utf8')
    const spec = SHIPPED_PUBLICATIONS[script]
    // The enumeration is COMPLETE, or this test measures a subset of the entrypoint. Comment lines
    // are dropped first: the prose names the function dozens of times.
    const callSites = source.split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .filter((line) => line.includes('publish_durable_file "'))
    assert.equal(callSites.length, spec.callSites,
      `${script} has ${callSites.length} publication call sites; this test accounts for ${spec.callSites}. Add the new one and prove its destination has a root:\n${callSites.join('\n')}`)

    // ONE ASSIGNMENT PER FILE, ASSERTED (o3d-rn10 r4). This used to take the first line starting
    // with `NAME=`, which is the same vacuity the parity test below carried: a second top-level
    // assignment appended to an entrypoint would have been the one bash used, and the one this rig
    // ignored. shellConstantOptional() refuses a file that assigns the name twice, and still lets a
    // file that does not assign it at all fall through to the shared fence library.
    const constants = PUBLICATION_CONSTANTS
      .map((name) => [[source, script], [FENCE_LIB, 'scripts/lib/db-fence-protected.sh']] as const)
      .map((pairs, index) => pairs.map(([text, where]) => shellConstantOptional(text, PUBLICATION_CONSTANTS[index], where)).find(Boolean))
      .filter((line): line is string => Boolean(line))

    // THE ANCHOR IS STUBBED HERE, AND ONLY HERE (o3d-rn10 r2). The question this test asks is
    // LEXICAL — does every shipped destination lie under some directory the table names — and the
    // shipped roots are /opt, /var/lib, /etc and /root paths whose REAL anchoring is a fact about
    // the machine the suite happens to run on (a checkout on a laptop has no /opt/one-two-inventory
    // and no /root/ims). Stubbing publish_root_anchored keeps the lexical question answerable
    // anywhere; the anchor itself is measured against real directories, by real modes and a real
    // `id`, in the block above.
    const rigFor = (anchored: boolean): string => {
      const lines = [
        'set -uo pipefail',
        // deploy.sh derives APP_USER by stat-ing the checkout, which a rig has no business running;
        // ${CRON_BACKUP} only needs the value to exist, and its DIRECTORY is what is measured.
        'APP_USER=appuser',
        ...constants,
        shellFunction(source, 'publish_trust_root_candidates'),
        `publish_root_anchored() { return ${anchored ? 0 : 1}; }`,
        shellFunction(source, 'publish_trust_root'),
      ]
      if (source.includes('\ndb_ca_generation_file() {\n')) lines.push(shellFunction(source, 'db_ca_generation_file'))
      lines.push(...spec.targets.map((target) =>
        `t="${target}"; if r="$(publish_trust_root "$(dirname "$t")")"; then printf 'OK\\t%s\\t%s\\n' "$t" "$r"; else printf 'NOROOT\\t%s\\n' "$t"; fi`))
      return lines.join('\n')
    }

    const run = runBash(rigFor(true))
    assert.equal(run.status, 0, run.stderr)
    const lines = run.stdout.trim().split('\n')
    assert.equal(lines.length, spec.targets.length, run.stdout)
    assert.deepEqual(lines.filter((l) => l.startsWith('NOROOT')), [],
      `every publication must resolve to a trusted ancestor:\n${run.stdout}`)
    // NOT VACUOUS: a publish_trust_root() that answered `/` to everything would satisfy the line
    // above, so what it actually named is checked against the shipped roots.
    for (const line of lines) {
      const [, target, root] = line.split('\t')
      assert.ok(SHIPPED_ROOTS.has(root), `${script}: ${target} resolved to ${root}, which is not one of the shipped roots`)
    }

    // AND THE STUB CANNOT HIDE A SELECTOR THAT STOPPED ASKING. The same rig with the gate SHUT must
    // return NOROOT for every destination: a publish_trust_root() that admitted a candidate without
    // consulting publish_root_anchored() would go on resolving them all, and pass the half above.
    const closed = runBash(rigFor(false))
    assert.equal(closed.status, 0, closed.stderr)
    const closedLines = closed.stdout.trim().split('\n')
    assert.equal(closedLines.length, spec.targets.length, closed.stdout)
    assert.deepEqual(closedLines.filter((l) => !l.startsWith('NOROOT')), [],
      `${script}: publish_trust_root must admit a candidate only through publish_root_anchored:\n${closed.stdout}`)
  })
}

/**
 * AND THE OTHER TWO ENTRYPOINTS ARE THE SAME PUBLISHER, WHICH UNTIL NOW WAS ONLY ASSERTED IN PROSE
 * (o3d-rn10 r3).
 *
 * Every behavioural test in this file — the anchor, the demotion, the nested symlink, the
 * unanchored override — lifts its functions out of scripts/install.sh and out of nothing else. The
 * loop above is the only thing that reads deploy.sh and update.sh at all, and it STUBS
 * publish_root_anchored() out, because the question it asks is lexical. So the whole guarantee for
 * two of the three entrypoints rested on the sentence "all three carry the publisher byte for
 * byte" — a claim about the files, made in a comment, checked by nothing. A deploy.sh whose
 * publish_root_anchored() had been reduced to `return 0` would have passed every test above: the
 * stub replaces it in the only test that opens the file.
 *
 * It was not even true. Carrying the walk to the other two entrypoints (2a9adace) pasted
 * publish_durable_file()'s comment header into each of them twice and dropped a blank line, and
 * nothing noticed for four commits. Comments, that time. The next divergence need not be.
 *
 * SO THE PREMISE IS THE TEST. Each shipped publisher function is compared BYTE FOR BYTE against
 * install.sh's, which is what makes the behavioural tests above load-bearing for deploy.sh and
 * update.sh instead of merely suggestive of them. Function bodies and not whole file regions: a
 * region diff would fail on unrelated prose that happens to sit between two functions, and prose
 * is not what the service account attacks.
 */
test('[o3d-rn10] deploy.sh and update.sh carry the SAME publisher as install.sh, function by function', () => {
  // The same six the behavioural tests lift, plus the constant they all resolve the staging
  // directory through. Sourced from PUBLISHER so a seventh function added to the publisher is
  // compared here without anyone remembering to add it.
  const shared = [...PUBLISHER]
  assert.deepEqual(shared, ['fsync_path', 'publish_trust_root_candidates', 'pin_publish_root_parent',
    'publish_root_anchored', 'publish_trust_root', 'refuse_symlinked_root', 'pin_dir_beneath_root', 'publish_durable_file'],
  'PUBLISHER is what the behavioural tests above run; this test exists to carry them to the other two entrypoints')

  for (const script of ['scripts/deploy.sh', 'scripts/update.sh'] as const) {
    const source = readFileSync(join(REPO, script), 'utf8')
    // NOT VACUOUS IN THE DIRECTION THAT MATTERS: a copy that simply does not DEFINE the function
    // would make an equality over "whatever we found" trivially true. shellFunction() asserts the
    // definition exists before there is anything to compare, and the constant is asserted the same
    // way, so a deleted publisher fails here rather than passing quietly.
    assert.equal(shellConstant(source, 'PUBLISH_STAGE_DIRNAME'), shellConstant(INSTALL_SH, 'PUBLISH_STAGE_DIRNAME'),
      `${script}: the staging directory name must be the one install.sh's publisher was measured with`)
    for (const name of shared) {
      assert.equal(shellFunction(source, name), shellFunction(INSTALL_SH, name),
        `${script}: ${name}() has drifted from scripts/install.sh. Every regression for the anchor, the demotion and the nested override in this file runs install.sh's copy; a divergent one here is untested code on a root-side write. Re-sync it, or give this entrypoint its own regressions.`)
    }
  }
})

/**
 * AND THE PARITY TEST READS THE DEFINITION BASH WOULD RUN, WHICH IT DID NOT (o3d-rn10 r4, Codex).
 *
 * shellFunction() used `indexOf` and shellConstant() used `find`, so both returned the FIRST
 * textual definition in the file. Bash does not: a later definition REPLACES an earlier one, and a
 * later assignment replaces an earlier one. So appending
 *
 *     publish_root_anchored() { return 0; }
 *
 * to scripts/deploy.sh left the test above comparing install.sh's canonical body against deploy.sh's
 * canonical body — equal, passing — while deploy.sh itself ran the stub and every root became a
 * trusted root. The vacuity was in the check built LAST ROUND to close a vacuity: the byte-identity
 * claim had been prose, it was made a check, and the check read the wrong copy.
 *
 * THE ORDER IS THE FIX. Uniqueness is asserted BEFORE the comparison, because a comparison over a
 * symbol defined twice is meaningless whichever copy it picks — it is not a weaker guarantee, it is
 * not a guarantee. The assertion lives in tests/scripts/shell-symbol.ts, so it holds for the
 * behavioural rigs too, which lifted the first definition the same way.
 *
 * ROUTE: this is the extractor the test above calls, on the file that test reads, given the bypass
 * Codex demonstrated. The mutation is the pre-fix reading, reproduced here as firstDefinition() and
 * firstAssignment() so the vacuity is MEASURED rather than described — both are shown returning
 * install.sh's text, byte for byte, out of a file carrying a second definition.
 */
/**
 * THE ONE-LINE OVERRIDE SET (o3d-rn10 r5).
 *
 * Every one of these is a SECOND definition bash makes effective, written on a single line — the
 * shape the r4 detector was blind to. They are kept in one place so a future narrowing of the
 * extractor has to delete a case rather than quietly stop matching it, and each is executed under
 * a real bash in the test below before it is required to be caught.
 */
const ONE_LINE_OVERRIDES = [
  'publish_root_anchored() { return 0; }',
  'function publish_root_anchored { return 0; }',
  'function publish_root_anchored() { return 0; }',
  '  publish_root_anchored() { return 0; }',
  'true; publish_root_anchored() { return 0; }',
  '{ publish_root_anchored() { return 0; }; }',
  'if true; then publish_root_anchored() { return 0; }; fi',
  'if false; then :; else publish_root_anchored() { return 0; }; fi',
  'for _ in 1; do publish_root_anchored() { return 0; }; done',
] as const

test('[o3d-rn10] a publisher symbol defined twice fails the parity extractor instead of being compared on its first copy', () => {
  const DEPLOY = readFileSync(join(REPO, 'scripts/deploy.sh'), 'utf8')

  /** The pre-fix reading of a function: the first `\nname() {\n` and the next `}` in column 0. */
  const firstDefinition = (source: string, name: string): string => {
    const start = source.indexOf(`\n${name}() {\n`)
    const rest = source.slice(start + 1)
    return rest.slice(0, rest.indexOf('\n}\n') + 2)
  }
  /** The pre-fix reading of a constant: the first line that starts with `NAME=`. */
  const firstAssignment = (source: string, name: string): string =>
    source.split('\n').find((l) => l.startsWith(`${name}=`)) ?? ''

  // NOT VACUOUS: the shipped files extract cleanly and agree, so what fails below is the duplicate
  // and not some unrelated strictness the extractor grew.
  for (const name of PUBLISHER) {
    assert.equal(shellFunction(DEPLOY, name), shellFunction(INSTALL_SH, name), `${name}() must be shared to begin with`)
  }
  assert.equal(shellConstant(DEPLOY, 'PUBLISH_STAGE_DIRNAME'), shellConstant(INSTALL_SH, 'PUBLISH_STAGE_DIRNAME'))

  // THE BYPASS. A second top-level definition, appended where nobody reads, of the one function the
  // whole trust-root mechanism rests on. Under bash this is the publisher deploy.sh executes.
  const bypassed = `${DEPLOY}\npublish_root_anchored() {\n  return 0\n}\n`

  // THE VACUITY, MEASURED: the old reading hands back install.sh's body byte for byte, so the
  // comparison it feeds passes on a file whose effective publisher is `return 0`.
  assert.equal(firstDefinition(bypassed, 'publish_root_anchored'), shellFunction(INSTALL_SH, 'publish_root_anchored'),
    'the first-definition reading must still agree with install.sh — that agreement IS the finding')

  assert.throws(() => shellFunction(bypassed, 'publish_root_anchored'), /defines publish_root_anchored\(\) 2 times/,
    'the extractor must refuse a file that carries two definitions, rather than pick one')

  // Every form bash accepts, not just the one Codex typed: a `function` keyword and an indentation
  // are not a different bug. An appended definition inside another function is effective the moment
  // that function runs, so it counts too.
  for (const bypass of [
    '\nfunction publish_root_anchored() {\n  return 0\n}\n',
    '\nfunction publish_root_anchored {\n  return 0\n}\n',
    '\nlate_wiring() {\n  publish_root_anchored() {\n    return 0\n  }\n}\n',
  ]) {
    assert.throws(() => shellFunction(`${DEPLOY}${bypass}`, 'publish_root_anchored'), /2 times/,
      `a second definition written as ${JSON.stringify(bypass.trim().split('\n')[0])} must be refused too`)
  }

  // AND THE ONE-LINE FORMS, WHICH THE GUARD ABOVE COULD NOT SEE (o3d-rn10 r5, Codex MEDIUM). The
  // first detector anchored the header to the END of the line right after the optional `{`, so
  // `publish_root_anchored() { return 0; }` — the cheapest duplicate there is, and the exact shape
  // an appended override takes — left the count at one. shellFunction() went on slicing the
  // canonical body, the parity comparison it feeds went on passing, and bash went on running the
  // stub. That is the third time on this branch a check has missed its own subject, so the forms
  // are enumerated here and each one is PROVED to be an override before it is required to be
  // caught: a form the extractor rejects but bash ignores would make this loop a spelling test.
  for (const bypass of ONE_LINE_OVERRIDES) {
    const proof = runBash([
      'set -uo pipefail',
      shellFunction(INSTALL_SH, 'pin_publish_root_parent'),
      shellFunction(INSTALL_SH, 'publish_root_anchored'),
      bypass,
      'publish_root_anchored /ims-rn10-no-such-root/state; echo "rc=$?"',
    ].join('\n'))
    assert.match(proof.stdout, /^rc=0$/m,
      `bash must actually take ${JSON.stringify(bypass)} as the effective definition: ${proof.stderr}`)

    assert.throws(() => shellFunction(`${DEPLOY}\n${bypass}\n`, 'publish_root_anchored'), /2 times/,
      `and the extractor must refuse it: ${JSON.stringify(bypass)}`)
  }

  // NOT VACUOUS: without a bypass the same rig REFUSES that root, so `rc=0` above is the override
  // talking and not a walk that says yes to everything.
  const unbypassed = runBash([
    'set -uo pipefail',
    shellFunction(INSTALL_SH, 'pin_publish_root_parent'),
    shellFunction(INSTALL_SH, 'publish_root_anchored'),
    'publish_root_anchored /ims-rn10-no-such-root/state; echo "rc=$?"',
  ].join('\n'))
  assert.match(unbypassed.stdout, /^rc=1$/m, 'the canonical anchor must refuse a root that does not exist')

  // AND THE CONSTANT, which aims the staging directory every publication passes through.
  //
  // SHOWN ON THE BARE DECLARATION (o3d-secops). The pre-fix reading looked for a line STARTING with
  // the name, and the shipped declaration starts with `readonly` — so on the shipped text that
  // reading is blind a SECOND, different way: it walks straight past the canonical line and returns
  // the attacker's. The vacuity this test indicts is the first one, so it is measured on the line
  // as it stood, which is also the line deleting `readonly` restores.
  const bare = bareDeclaration(DEPLOY, 'PUBLISH_STAGE_DIRNAME', 'scripts/deploy.sh')
  assert.equal(bare, bareDeclaration(INSTALL_SH, 'PUBLISH_STAGE_DIRNAME', 'scripts/install.sh'),
    'the two entrypoints must agree on the staging directory to begin with')
  const reassigned = `${DEPLOY.replace(shellConstant(DEPLOY, 'PUBLISH_STAGE_DIRNAME'), () => bare)}\nPUBLISH_STAGE_DIRNAME="../../attacker"\n`
  assert.equal(firstAssignment(reassigned, 'PUBLISH_STAGE_DIRNAME'), bare,
    'the first-assignment reading must still agree with install.sh')
  assert.throws(() => shellConstant(reassigned, 'PUBLISH_STAGE_DIRNAME'), /assigns PUBLISH_STAGE_DIRNAME 2 times/,
    'a second top-level assignment must be refused, not skipped')
  for (const prefix of ['export ', 'readonly ', 'declare -r ']) {
    assert.throws(() => shellConstant(`${DEPLOY}\n${prefix}PUBLISH_STAGE_DIRNAME="../../attacker"\n`, 'PUBLISH_STAGE_DIRNAME'),
      /2 times/, `a second assignment written as \`${prefix}NAME=\` must be refused too`)
  }

  // A DELETED SYMBOL IS STILL THE OTHER FAILURE, and still fails: uniqueness means exactly one, and
  // "none" is not one. This is the direction the previous round already had, kept here so a rewrite
  // of the extractor cannot trade one for the other.
  assert.throws(() => shellFunction(DEPLOY.replace('\npublish_root_anchored() {\n', '\nremoved_publisher() {\n'), 'publish_root_anchored'),
    /must define publish_root_anchored\(\)/)
})

/**
 * THE LATE-ASSIGNMENT SET (o3d-1dk9).
 *
 * Every one of these is a SECOND assignment of the publisher constant that bash makes effective,
 * and NOT ONE OF THEM starts its line with the name — which is all the old extractor looked at.
 * They are kept in one place so a future narrowing has to delete a case rather than quietly stop
 * matching it, and each is executed under a real bash in the test below before it is required to be
 * caught: a form the extractor rejects but bash ignores would make the loop a spelling test.
 */
const LATE_ASSIGNMENTS = [
  'true; PUBLISH_STAGE_DIRNAME="../../attacker"',
  '  PUBLISH_STAGE_DIRNAME="../../attacker"',
  'if true; then PUBLISH_STAGE_DIRNAME="../../attacker"; fi',
  'while :; do PUBLISH_STAGE_DIRNAME="../../attacker"; break; done',
  'for _ in 1; do PUBLISH_STAGE_DIRNAME="../../attacker"; done',
  '{ PUBLISH_STAGE_DIRNAME="../../attacker"; }',
  'case x in x) PUBLISH_STAGE_DIRNAME="../../attacker";; esac',
  'export PUBLISH_STAGE_DIRNAME="../../attacker"',
  'readonly PUBLISH_STAGE_DIRNAME="../../attacker"',
  'declare -r PUBLISH_STAGE_DIRNAME="../../attacker"',
  'PUBLISH_STAGE_DIRNAME+="/../../attacker"',
  'PUBLISH_STAGE_DIRNAME\\\n="../../attacker"',
] as const

/**
 * And the other direction: assignments of the SAME NAME that bash does NOT take at script scope,
 * every one of which the extractor must keep ignoring. Without these the fix would be a rule that
 * says yes to everything, and `local NAME=` — ordinary shell in a repository with 373 function
 * bodies — would be a permanent red.
 */
const SCOPED_ASSIGNMENTS = [
  'shadow() {\n  local PUBLISH_STAGE_DIRNAME="../../attacker"\n  :\n}\nshadow',
  'shadow() {\n        local PUBLISH_STAGE_DIRNAME="../../attacker"\n}\nshadow',
  'function shadow {\n  local PUBLISH_STAGE_DIRNAME="../../attacker"\n}\nshadow',
  'shadow() { local PUBLISH_STAGE_DIRNAME="../../attacker"; }; shadow',
  '# PUBLISH_STAGE_DIRNAME="../../attacker"',
  'echo \'PUBLISH_STAGE_DIRNAME="../../attacker"\' > /dev/null',
  'cat > /dev/null <<\'NOTE\'\nPUBLISH_STAGE_DIRNAME="../../attacker"\nNOTE',
] as const

/**
 * THE DECLARATION WITHOUT ITS `readonly` (o3d-secops) — the line these entrypoints carried before
 * that word was added, and exactly the line deleting it restores.
 *
 * Three demonstrations in this file are about WHAT BASH DOES with a second assignment of the
 * publisher constant: bash takes it, the old reading did not see it, and that gap is what makes the
 * scanner's uniqueness rule load-bearing rather than decorative. `readonly` makes bash refuse the
 * second assignment outright, so run against the shipped line those demonstrations would measure
 * the REFUSAL — passing, while proving nothing about the reading they exist to indict. They are
 * therefore run against the bare line; that bash refuses the same forms on the shipped one is the
 * separate, opposite claim made by the o3d-secops test below.
 *
 * AND THIS IS WHERE THE WORD IS REQUIRED. Strip `readonly` from an entrypoint's declaration and
 * every test that reaches this fails, naming the constant and the file.
 */
function bareDeclaration(source: string, name: string, where = 'the script'): string {
  const line = shellConstant(source, name, where)
  const bare = line.replace(/^readonly /, '')
  assert.notEqual(bare, line,
    `${where}: ${name} must be declared \`readonly\` at its canonical declaration. That word is what makes bash `
    + 'itself refuse `printf -v`, `read`, a nameref and `(( ))` — none of which is an assignment word, all of '
    + `which re-aim this constant, and none of which any scanner here can see. Found: ${JSON.stringify(line)}`)
  return bare
}

/** The rig both sets are proved in: install.sh's own assignment, then the form, then the value. */
function publishStageAfter(form: string): string {
  return runBash([
    'set -u',
    // WITHOUT the `readonly` — see bareDeclaration(): with it, every form below is refused and
    // this rig would report the shipped value for all of them, which is the opposite measurement.
    bareDeclaration(INSTALL_SH, 'PUBLISH_STAGE_DIRNAME', 'scripts/install.sh'),
    form,
    'printf "%s\\n" "$PUBLISH_STAGE_DIRNAME"',
  ].join('\n')).stdout.trim()
}

/**
 * THE CONSTANT HALF OF THE PARITY CLAIM WAS STILL A LINE ANCHOR (o3d-1dk9).
 *
 * shellFunctionDefinitions() was rewritten three times until it stopped enumerating command
 * positions and started reading a lexer plus bash's own parse. shellConstantAssignments() was left
 * exactly as it had always been — `^(?:export|readonly|declare|typeset\s+…)?NAME=`, tested line by
 * line — so the whole of the argument against line rules applied, unanswered, to the other half of
 * the same claim, and to the constant that aims EVERY publication's staging directory.
 *
 * THE BYPASS: appending `true; PUBLISH_STAGE_DIRNAME="../../attacker"` to scripts/deploy.sh. The
 * line does not start with the name, so the old rule saw one assignment, shellConstant() returned
 * install.sh's value, and the parity comparison passed — while bash published through the
 * attacker's directory. Both halves are proved rather than described: the value bash ends up with
 * is READ OUT OF A REAL BASH first, and the old reading is reproduced as lineAnchored() and shown
 * returning install.sh's line out of the mutated file.
 *
 * ROUTE: shellConstant() -> shellConstantOptional() -> constantAssignmentOffsets() in
 * tests/scripts/shell-symbol.ts, which is the extractor the parity test above and the
 * publication-target tests call, on the file they read.
 *
 * MUTATION, run two ways. Put the WHOLE pre-o3d-1dk9 reading back — the per-line regex, no mask,
 * no scope, no cross-check — and 9 of the 12 forms below stop being refused at all (every one
 * except the three written `export`/`readonly`/`declare -r` at column 0), so the loop fails at its
 * first. Re-apply the anchor to the RAW reading only, leaving the cross-check in place, and the
 * guard still goes red on all 12 — but as a disagreement with bash's parse rather than as a count,
 * which is why the assertion below pins the message and not merely that something threw. Both
 * edits were made and this test was run under each.
 */
test('[o3d-1dk9] a second script-scope assignment of a publisher constant is refused wherever it stands', () => {
  const DEPLOY = readFileSync(join(REPO, 'scripts/deploy.sh'), 'utf8')

  /** The pre-fix reading: the lines that START with the name, optionally behind a declaration. */
  const lineAnchored = (source: string, name: string): string[] => {
    const shape = new RegExp(`^(?:(?:export|readonly|declare|typeset)\\s+(?:-\\w+\\s+)*)?${name}=`)
    return source.split('\n').filter((line) => shape.test(line))
  }

  // NOT VACUOUS: the shipped file extracts cleanly and agrees with install.sh, so what fails below
  // is the appended assignment and not some strictness the extractor grew.
  assert.equal(shellConstant(DEPLOY, 'PUBLISH_STAGE_DIRNAME'), shellConstant(INSTALL_SH, 'PUBLISH_STAGE_DIRNAME'))

  // THE BASELINE the proofs are read against: the value with no second assignment at all.
  const baseline = publishStageAfter(':')
  assert.ok(baseline.length > 0, "the rig must produce install.sh's staging directory name to compare against")

  // THE VACUITY, MEASURED. The old reading finds ONE assignment in a file carrying two, and hands
  // back install.sh's line byte for byte — which is the agreement the parity test was reporting.
  const bypassed = `${DEPLOY}\ntrue; PUBLISH_STAGE_DIRNAME="../../attacker"\n`
  assert.deepEqual(lineAnchored(bypassed, 'PUBLISH_STAGE_DIRNAME'), [shellConstant(INSTALL_SH, 'PUBLISH_STAGE_DIRNAME')],
    "the line-anchored reading must still see exactly one assignment, and it must still be install.sh's — that blindness IS the finding")
  assert.equal(publishStageAfter('true; PUBLISH_STAGE_DIRNAME="../../attacker"'), '../../attacker',
    'and bash must take the appended one, or the finding is about a line nobody executes')

  for (const form of LATE_ASSIGNMENTS) {
    assert.notEqual(publishStageAfter(form), baseline,
      `bash must actually take ${JSON.stringify(form)} as the effective value of PUBLISH_STAGE_DIRNAME`)

    assert.throws(() => shellConstant(`${DEPLOY}\n${form}\n`, 'PUBLISH_STAGE_DIRNAME', 'scripts/deploy.sh'),
      /assigns PUBLISH_STAGE_DIRNAME 2 times at script scope/,
      `and the extractor must refuse it: ${JSON.stringify(form)}`)
  }

  // A DELETED ASSIGNMENT IS THE OTHER FAILURE, and still fails: uniqueness means exactly one, and
  // "none" is not one.
  assert.throws(() => shellConstant(DEPLOY.replace(`\n${shellConstant(DEPLOY, 'PUBLISH_STAGE_DIRNAME')}`, '\nREMOVED_STAGE_DIRNAME=".ims-publish"'), 'PUBLISH_STAGE_DIRNAME'),
    /must define PUBLISH_STAGE_DIRNAME on one line/)
})

/**
 * AND "TOP LEVEL" MEANS SCOPE, NOT INDENTATION (o3d-1dk9).
 *
 * The old rule excluded `local NAME=` because such a line is INDENTED. That is a fact about layout,
 * and the test above is the bill for it: `true; NAME=` is at column 0's mercy in exactly the same
 * way, and it is a bypass. The replacement excludes an assignment because it is inside a FUNCTION
 * BODY — so an indented assignment at script scope is now caught, and an indented `local` inside a
 * function is still not.
 *
 * Every form below is read out of a real bash before it is required of the extractor: each leaves
 * the script's value UNCHANGED, so an extractor that counted them would be red on ordinary shell,
 * and a guard that is red on ordinary shell gets an exemption, then a bypass, then deleted.
 *
 * ROUTE: shellConstant() on scripts/deploy.sh with each form appended.
 *
 * MUTATION: drop the scope filter in constantAssignmentOffsets() — count every assignment the mask
 * carries — and all four `local`-in-a-body spellings start throwing `2 script-scope assignments`,
 * so the loop fails at its first. Widen it the other way instead (read the raw source rather than
 * the mask) and two more do: the comment and the here-document. And the pre-o3d-1dk9 reading in the
 * test above makes the LAST assertion here fail, the indented assignment outside a body. All three
 * edits were made and this test was run under each.
 */
test('[o3d-1dk9] an assignment inside a function body is not a script-scope assignment', () => {
  const DEPLOY = readFileSync(join(REPO, 'scripts/deploy.sh'), 'utf8')
  const canonical = shellConstant(INSTALL_SH, 'PUBLISH_STAGE_DIRNAME')
  const baseline = publishStageAfter(':')

  for (const form of SCOPED_ASSIGNMENTS) {
    assert.equal(publishStageAfter(form), baseline,
      `bash must NOT take ${JSON.stringify(form)} — a form the extractor is asked to ignore has to be one bash ignores`)

    assert.equal(shellConstant(`${DEPLOY}\n${form}\n`, 'PUBLISH_STAGE_DIRNAME', 'scripts/deploy.sh'), canonical,
      `and the extractor must still resolve the one script-scope assignment: ${JSON.stringify(form)}`)
  }

  // THE PAIR THAT MAKES THE RULE SCOPE RATHER THAN INDENTATION: the same assignment, at the same
  // eight spaces of indentation, once inside a function body and once outside one.
  assert.equal(shellConstant(`${DEPLOY}\nshadow() {\n        PUBLISH_STAGE_DIRNAME="../../attacker"\n}\n`, 'PUBLISH_STAGE_DIRNAME'),
    canonical, 'an indented assignment INSIDE a body is not at script scope')
  assert.throws(() => shellConstant(`${DEPLOY}\n        PUBLISH_STAGE_DIRNAME="../../attacker"\n`, 'PUBLISH_STAGE_DIRNAME'),
    /2 times at script scope/, 'the identically indented assignment OUTSIDE one is')
})

/**
 * A SCOPE THAT CANNOT BE DETERMINED REFUSES, NAMED (o3d-1dk9).
 *
 * A function body may be ANY compound command. `f() ( … )`, `f() if …; fi` and `f() for …; done`
 * all parse — asserted below under a real `bash -n`, so the refusal is about a construct and not a
 * typo — and none of them is delimited by the brace rule the scanner uses. A subshell body is not
 * delimited by counting parentheses either: a `case` pattern's `)` inside one would close the count
 * early and move an assignment OUT of function scope without saying so.
 *
 * So the extent is refused rather than guessed, which is the answer the definition scanner already
 * gives to the same question. `eval` is refused for the reason it already was: `eval 'NAME=/x'`
 * assigns — verified here — and is a string to the lexer, to any line rule, and to bash's own parse.
 *
 * ROUTE: shellConstantAssignments() on scripts/deploy.sh with each construct appended.
 *
 * MUTATION: make braceGroupExtent() return an EMPTY extent for a body it does not recognise
 * instead of throwing — the "assume it is empty" reading — and all three body forms stop refusing,
 * so the loop fails at its first. Replace the `eval` scan in constantAssignmentOffsets() with an
 * empty list and the eval case below fails too. Both edits were made and this test was run under
 * each.
 */
test('[o3d-1dk9] a function body whose extent cannot be determined refuses instead of returning a count', () => {
  const DEPLOY = readFileSync(join(REPO, 'scripts/deploy.sh'), 'utf8')

  for (const form of [
    'shadow() ( PUBLISH_STAGE_DIRNAME="../../attacker" )',
    'shadow() if true; then PUBLISH_STAGE_DIRNAME="../../attacker"; fi',
    'shadow() for _ in 1; do PUBLISH_STAGE_DIRNAME="../../attacker"; done',
  ]) {
    const parsed = spawnSync('bash', ['-n'], { encoding: 'utf8', input: `${form}\n` })
    assert.equal(parsed.status, 0,
      `bash must accept ${JSON.stringify(form)} — a refusal aimed at something bash rejects is about a typo: ${parsed.stderr}`)

    assert.throws(() => shellConstantAssignments(`${DEPLOY}\n${form}\n`, 'PUBLISH_STAGE_DIRNAME', 'scripts/deploy.sh'),
      /a function body this scanner cannot delimit/,
      `a body whose extent is not a brace group must be refused, not measured: ${JSON.stringify(form)}`)
  }

  // AND `eval`, which no lexical reading answers: bash installs the assignment, and every reading
  // in this file sees a string.
  assert.equal(publishStageAfter("eval 'PUBLISH_STAGE_DIRNAME=\"../../attacker\"'"), '../../attacker',
    'eval must actually install the assignment, or refusing it is theatre')
  assert.throws(() => shellConstantAssignments(`${DEPLOY}\neval 'PUBLISH_STAGE_DIRNAME="../../attacker"'\n`, 'PUBLISH_STAGE_DIRNAME', 'scripts/deploy.sh'),
    /runs `eval`/)

  // AND A FILE THIS SCANNER CANNOT LEX AT ALL, for the reason the definitions refuse one.
  assert.throws(() => shellConstantAssignments(`${DEPLOY}\necho 'never closed\n`, 'PUBLISH_STAGE_DIRNAME', 'scripts/deploy.sh'),
    /unterminated single quote/)

  // NOT VACUOUS: the unmodified file returns exactly one. The refusals above are the constructs
  // talking, not a scanner that has stopped answering.
  assert.equal(shellConstantAssignments(DEPLOY, 'PUBLISH_STAGE_DIRNAME', 'scripts/deploy.sh').length, 1)
})

/**
 * AND THE SAME WORD RULE, ASKED THE OTHER WAY ROUND: WHICH NAMES DOES THIS COMMAND ASSIGN?
 * (o3d-secops r5, Codex HIGH.)
 *
 * shellConstantAssignments() has always answered "is NAME assigned here" by the word rule — a name
 * is assigned where it STARTS A WORD, and a word starts after a metacharacter and nowhere else — so
 * `export`, `readonly`, `declare -r`, `typeset` and `local` are covered without one of them being
 * written down. That reading was only reachable PER NAME, and the sink census below needed the
 * other direction: given a command, which names does it assign? Having nowhere to ask, it grew its
 * own regex, `(?:local |export |readonly |declare [^ ]+ )*NAME=`, and that regex was wrong in the
 * two ways an enumeration is always wrong:
 *
 *   `declare ref=X`             no option word, so `declare [^ ]+ ` had nothing to eat
 *   `local scratch=x ref=X`     a SECOND operand, past the `$` the regex anchored on
 *
 * Both are ordinary bash and both really assign — asserted below under a real bash before anything
 * is required of the scanner, because a rule aimed at a form bash does not accept is about a typo.
 *
 * ROUTE: shellAssignments() on each form, against bash's own answer for the same bytes.
 *
 * MUTATION: restore the enumerating regex as the reader (`(?:local |export |readonly |declare
 * [^ ]+ )*([A-Za-z_][A-Za-z0-9_]*)\+?=(\S*)\s*$` over each form) and the `declare`, `typeset`,
 * `readonly -g` and both multi-operand rows go red; drop the `start !== 0 ||
 * METACHARACTERS.includes(...)` word-start test from maskAssignmentOperands() and the `$NAME=`,
 * `x_NAME=` and `arr[0]=` rows go red instead. Both edits were made and this test run under each.
 */
test('[o3d-secops] the assignment reader names every operand of a declaration, with or without options', (t) => {
  const seen = (text: string): string[] =>
    shellAssignments(text, 'a fixture').map(({ name, value }) => `${name}=${value}`)

  // WHAT BASH DOES WITH THE SAME BYTES, first. Each form is run inside a function (which is where a
  // `local` is legal) and the variable it is claimed to set is printed back.
  const bashAssigns = (form: string, name: string): string => {
    const dir = createTempDirSync('ims-secops-assign-', t)
    const file = join(dir, 'subject.sh')
    writeFileSync(file, `f() {\n  ${form}\n  printf '%s' "\${${name}}"\n}\nf\n`)
    const run = spawnSync('bash', [file], { encoding: 'utf8' })
    assert.equal(run.status, 0, `bash must accept ${JSON.stringify(form)}: ${run.stderr}`)
    return run.stdout
  }

  const forms: ReadonlyArray<readonly [string, readonly string[], readonly [string, string]]> = [
    // THE TWO THE ENUMERATING REGEX MISSED.
    ['declare ref=DB_FENCE_PROBE_REASON', ['ref=DB_FENCE_PROBE_REASON'], ['ref', 'DB_FENCE_PROBE_REASON']],
    ['local scratch=x ref=DB_FENCE_PROBE_REASON', ['scratch=x', 'ref=DB_FENCE_PROBE_REASON'], ['ref', 'DB_FENCE_PROBE_REASON']],
    // AND THE REST OF THE SHAPE, none of which is enumerated anywhere.
    ['typeset ref=DB_FENCE_PROBE_REASON', ['ref=DB_FENCE_PROBE_REASON'], ['ref', 'DB_FENCE_PROBE_REASON']],
    ['declare -r a=1 ref=DB_FENCE_PROBE_REASON', ['a=1', 'ref=DB_FENCE_PROBE_REASON'], ['ref', 'DB_FENCE_PROBE_REASON']],
    ['local -a first=1 ref=DB_FENCE_PROBE_REASON', ['first=1', 'ref=DB_FENCE_PROBE_REASON'], ['ref', 'DB_FENCE_PROBE_REASON']],
    ['export A=1 ref="DB_FENCE_PROBE_REASON"', ['A=1', 'ref="DB_FENCE_PROBE_REASON"'], ['ref', 'DB_FENCE_PROBE_REASON']],
    ["readonly ref='DB_FENCE_PROBE_REASON'", ["ref='DB_FENCE_PROBE_REASON'"], ['ref', 'DB_FENCE_PROBE_REASON']],
    ['ref=DB_FENCE_PROBE_REASON', ['ref=DB_FENCE_PROBE_REASON'], ['ref', 'DB_FENCE_PROBE_REASON']],
    ['true; ref=DB_FENCE_PROBE_REASON', ['ref=DB_FENCE_PROBE_REASON'], ['ref', 'DB_FENCE_PROBE_REASON']],
  ]
  for (const [form, expected, [name, value]] of forms) {
    assert.equal(bashAssigns(form, name), value,
      `bash must really set ${name} from ${JSON.stringify(form)}, or the scanner is being asked about a typo`)
    assert.deepEqual(seen(form), [...expected], `shellAssignments() on ${JSON.stringify(form)}`)
  }

  // AND WHAT IS NOT AN ASSIGNMENT STAYS OUT, which is what the word-start test buys. Each of these
  // was checked to contain an `=` the reader has to walk past rather than report.
  for (const notAnAssignment of [
    '[[ "$a" == "$b" ]]',
    '[[ "$a" != "$b" ]]',
    '$ref=DB_FENCE_PROBE_REASON',
    'x_ref=DB_FENCE_PROBE_REASON',
    'arr[0]=DB_FENCE_PROBE_REASON',
    '# ref=DB_FENCE_PROBE_REASON',
    'echo x  # ref=DB_FENCE_PROBE_REASON',
    "echo 'ref=DB_FENCE_PROBE_REASON'",
    'cat <<EOF\nref=DB_FENCE_PROBE_REASON\nEOF',
  ]) {
    assert.ok(!seen(notAnAssignment).includes('ref=DB_FENCE_PROBE_REASON'),
      `${JSON.stringify(notAnAssignment)} assigns no \`ref\`; the reader saw ${seen(notAnAssignment).join(', ')}`)
  }
  // `x_ref` and `arr[0]` are not silence-by-accident: the first IS reported, under its own name.
  assert.deepEqual(seen('x_ref=DB_FENCE_PROBE_REASON'), ['x_ref=DB_FENCE_PROBE_REASON'])

  // A LINE CONTINUATION JOINS THE WORD rather than starting one, which is the case the forward
  // regex could not read at all: bash assigns `xref`, and so does the reader.
  assert.equal(bashAssigns('x\\\nref=DB_FENCE_PROBE_REASON', 'xref'), 'DB_FENCE_PROBE_REASON')
  assert.deepEqual(seen('x\\\nref=DB_FENCE_PROBE_REASON'), ['xref=DB_FENCE_PROBE_REASON'])
})

/**
 * AND THE SCOPE RULE HAS NOT MADE THE SCANNER UNUSABLE EITHER (o3d-1dk9).
 *
 * The function census below this one exists because a guard that trips on ordinary code gets
 * deleted; the constant scanner now refuses far more than it used to — a body it cannot delimit, a
 * disagreement with bash over how many bodies there are — so the same thing has to be measured for
 * it, and it has already gone wrong once on this branch (a here-STRING swallowed the whole of
 * deploy.sh into a here-document body). So every shell script under version control is walked,
 * every publication constant is looked up in it, and each one that is assigned at all must resolve
 * to EXACTLY ONE script-scope assignment, with no refusal anywhere.
 *
 * ROUTE: shellConstantOptional() and shellFunctionBodyCount() over `git ls-files '*.sh'` — the same
 * extractor the parity test and the publication-target tests go through.
 *
 * MUTATION, on the SUBJECT rather than the scanner, because a census that cannot go red on the code
 * it walks is a walk and not a census. Appending `true; APP_DIR="/tmp/attacker"` to
 * scripts/backup.sh — which still passes `bash -n` — turns this red on a second script-scope
 * assignment; appending `census_probe() ( : )` turns it red on a body that is not a brace group.
 * Neither is visible to the function census below, which stayed green under both. Both edits were
 * made against the real file and reverted.
 */
test('[o3d-1dk9] every publication constant the tracked shell scripts assign still resolves to exactly one', () => {
  const listed = spawnSync('git', ['ls-files', '*.sh'], { cwd: REPO, encoding: 'utf8' })
  assert.equal(listed.status, 0, listed.stderr)
  const files = listed.stdout.trim().split('\n').filter(Boolean)
  assert.ok(files.length >= 13, `the census must reach the tracked scripts; git listed ${files.length}`)

  const names = PROTECTED_CONSTANTS
  let bodies = 0
  let resolved = 0
  for (const file of files) {
    const source = readFileSync(join(REPO, file), 'utf8')
    // Scope is decided by these, so the number of them is part of what has to hold: this throws if
    // any body is not a brace group, or if bash's own parse of the file disagrees about how many
    // there are.
    bodies += shellFunctionBodyCount(source, file)
    for (const name of names) {
      // shellConstantOptional() IS the "exactly one" assertion — it refuses a second script-scope
      // assignment — so a name this file simply does not assign returns undefined and is not
      // counted, and one it assigns twice fails here.
      if (shellConstantOptional(source, name, file) !== undefined) resolved += 1
    }
  }

  // THE WALK REACHED THE FILES, stated as numbers so a census that silently stopped visiting them
  // cannot pass as one that visited them and found nothing wrong. Floors rather than equalities,
  // because a new function or a new constant is not a regression.
  assert.ok(bodies >= 373,
    `the tracked scripts carried 373 function bodies when this was written, every one of them a brace group; the census saw ${bodies}`)
  assert.ok(resolved >= 45,
    `the tracked scripts resolved 45 (file, constant) pairs when this was written; the census saw ${resolved}`)
})

/**
 * A SCANNER SEES ASSIGNMENT WORDS; BASH MUTATES VARIABLES FOUR OTHER WAYS (o3d-secops, Codex HIGH).
 *
 * The two tests above made the constant reader airtight about SYNTAX — every position a `NAME=`
 * word can stand in, read with a lexer and cross-checked against bash's own parse. That is a claim
 * about assignment words, and bash does not need one to change a variable. Appending any of
 *
 *     printf -v PUBLISH_STAGE_DIRNAME %s ../../attacker
 *     read PUBLISH_STAGE_DIRNAME <<<'../../attacker'
 *     declare -n ref=PUBLISH_STAGE_DIRNAME; ref='../../attacker'
 *     (( PUBLISH_STAGE_DIRNAME = 4919 ))
 *
 * to an entrypoint re-aims the staging directory every publication passes through — or, for the
 * other names here, the trust root a destination is checked against and the path it is published
 * to — while the scanner, both readings and the census all stay green, because not one of those
 * lines contains a `NAME=` word.
 *
 * THE ANSWER IS NOT A FIFTH ROUND OF ENUMERATION. It is the move the three rounds before it made:
 * stop listing and let something authoritative decide. `readonly` at the canonical declaration
 * makes BASH refuse every mutation path, including the ones nobody has written down; the scanner
 * keeps the job it can do, which is proving there is exactly one declaration.
 *
 * WHAT THIS TEST MEASURES, per entrypoint and per constant, under a real bash:
 *
 *   ROUTE — the shipped declarations of that script are executed in source order, then the mutation
 *   runs in a subshell that prints the value it left behind. With `readonly` STRIPPED — the line
 *   this branch inherited, and the line deleting the word restores — every one of the four changes
 *   the value. That is the precondition: a mutation bash ignores anyway would make the refusal
 *   below theatre.
 *
 *   THE CLAIM — with the shipped declarations, every one of the four leaves the value untouched
 *   and bash says `readonly variable` in doing so.
 *
 * MUTATION: delete `readonly` from any one declaration in any one entrypoint and this fails naming
 * that script and that constant, on the four values that then change. (Verified by stripping the
 * word from PUBLISH_STAGE_DIRNAME in scripts/deploy.sh and from FENCE_FILE in scripts/update.sh.)
 *
 * WHY THE SCANNER ITSELF DOES NOT REQUIRE THE WORD. shellConstant() is the generic reader for every
 * lifted shell constant in this directory — CAPTURE_TERMINATOR, DB_CA_ACCEPTED_PEM_LABELS and the
 * rest, none of which is a publication constant and none of which is readonly. The requirement is
 * a property of THIS SET, so it is asserted where the set is written down: here, and in the
 * structural test below.
 */
const NON_ASSIGNMENT_MUTATIONS = [
  { label: 'printf-v', form: (name: string) => `printf -v ${name} %s ../../ims-secops-attacker` },
  { label: 'read', form: (name: string) => `read ${name} <<<'../../ims-secops-attacker'` },
  {
    label: 'nameref',
    form: (name: string) => `declare -n ims_secops_ref=${name}; ims_secops_ref='../../ims-secops-attacker'`,
  },
  { label: 'arithmetic', form: (name: string) => `(( ${name} = 4919 ))` },
] as const

/**
 * The protected constants THIS script declares, in the order it declares them — which matters,
 * because several are composed from the ones above them (${FENCE_FILE} from ${CUTOVER_STATE_DIR},
 * ${DEPLOY_META_FILE} from ${APP_DIR}).
 */
function protectedDeclarations(
  source: string,
  where: string,
  names: readonly string[] = PROTECTED_CONSTANTS,
): Array<{ name: string, line: string }> {
  const found = names
    .map((name) => ({ name, line: shellConstantOptional(source, name, where) }))
    .filter((entry): entry is { name: string, line: string } => entry.line !== undefined)
  return found.sort((a, b) => source.indexOf(a.line) - source.indexOf(b.line))
}

/**
 * The script's own declarations, in its own order, with or without the word under test.
 *
 * `environment` is what the declarations READ and this rig does not declare: ${CRON_BACKUP} is
 * composed from the service account, and the library's two expected digests are derived from
 * IMS_FENCE_SCRIPT_SHA256 / IMS_FENCE_ARTEFACT_SHA256 — which have to resolve to something, or
 * there would be no value for a mutation to fail to change.
 */
function declarationPreamble(
  declarations: Array<{ name: string, line: string }>,
  strip: boolean,
  environment: readonly string[] = ['APP_USER=svcuser'],
): string[] {
  return [
    'set -u',
    ...environment,
    ...declarations.map(({ line }) => (strip ? line.replace(/^readonly /, '') : line)),
  ]
}

/**
 * ONE MUTATION PER SHELL, and the value printed after it.
 *
 * Not four subshells in one script, which is where this started: `declare -n ref=NAME` against a
 * readonly NAME does not merely fail, it TERMINATES the shell it runs in, so the nameref subshell
 * printed nothing at all and a rig that read its line got `undefined` instead of a refusal. A
 * process each keeps every outcome legible — the value survived, or the shell died refusing.
 */
function mutationRig(
  declarations: Array<{ name: string, line: string }>,
  target: string,
  form: string,
  strip: boolean,
  environment?: readonly string[],
): string {
  return [
    ...declarationPreamble(declarations, strip, environment),
    form,
    `printf 'AFTER\\t%s\\n' "\${${target}}"`,
  ].join('\n')
}

/** The value the rig printed, or undefined when the shell never got that far. */
function mutationValue(run: Run): string | undefined {
  const line = `${run.stdout}\n${run.stderr}`.split('\n').find((candidate) => candidate.startsWith('AFTER\t'))
  return line === undefined ? undefined : line.slice('AFTER\t'.length)
}

/** The sentinel every mutation writes, so "it did not arrive" can be asserted directly. */
const MUTATION_SENTINEL = '../../ims-secops-attacker'

/**
 * THE SUBJECTS: the three entrypoints, AND THE LIBRARY THEY ALL SOURCE (o3d-secops r2).
 *
 * Leaving the library out was the finding. It is the file that names the recovery root, the
 * protected tree and the executable helper, so the same measurement runs over it — with its own
 * protected set and the environment its two digest declarations read.
 */
const MUTATION_SUBJECTS = [
  ...ENTRYPOINTS.map((script) => ({
    file: script,
    what: "publication constants",
    names: PROTECTED_CONSTANTS as readonly string[],
    minimum: 9,
    environment: ['APP_USER=svcuser'] as readonly string[],
  })),
  {
    file: FENCE_LIBRARY,
    what: 'protected constants',
    names: PROTECTED_LIBRARY_CONSTANTS as readonly string[],
    minimum: PROTECTED_LIBRARY_CONSTANTS.length,
    environment: [
      `IMS_FENCE_SCRIPT_SHA256=${'1'.repeat(64)}`,
      `IMS_FENCE_ARTEFACT_SHA256=${'2'.repeat(64)}`,
    ] as readonly string[],
  },
] as const

for (const { file: script, what, names, minimum, environment } of MUTATION_SUBJECTS) {
  test(`[o3d-secops] bash refuses every non-assignment mutation of ${script}'s ${what}`, () => {
    const source = readFileSync(join(REPO, script), 'utf8')
    const declarations = protectedDeclarations(source, script, names)
    assert.ok(declarations.length >= minimum,
      `${script} declared at least ${minimum} protected constants when this was written; this test found ${declarations.length}`)

    for (const { name } of declarations) {
      // The value the script actually gives it, from the script's own declarations and no mutation.
      const baseline = runBash([...declarationPreamble(declarations, false, environment), `printf '%s' "\${${name}}"`].join('\n'))
      assert.equal(baseline.status, 0, `${script}: the shipped declarations must evaluate: ${baseline.stderr}`)
      const value = baseline.stdout
      assert.ok(value.length > 0, `${script}: ${name} must resolve to something to compare against`)

      for (const { label, form } of NON_ASSIGNMENT_MUTATIONS) {
        // ROUTE / PRECONDITION: without the word, bash takes this mutation. A mutation bash ignores
        // anyway would make the refusal below theatre.
        const unprotected = runBash(mutationRig(declarations, name, form(name), true, environment))
        assert.equal(unprotected.status, 0,
          `${script}: with \`readonly\` stripped, ${label} must run cleanly against ${name}: ${unprotected.stderr}`)
        assert.notEqual(mutationValue(unprotected), value,
          `${script}: with \`readonly\` stripped, ${label} must actually change ${name}`)

        // THE CLAIM: with it, bash refuses, says so, and the constant is untouched.
        const run = runBash(mutationRig(declarations, name, form(name), false, environment))
        const output = `${run.stdout}\n${run.stderr}`
        assert.ok(output.includes(`${name}: readonly variable`),
          `${script}: bash must REFUSE ${label} on ${name} and say so, not silently ignore it:\n${output}`)
        assert.ok(!output.includes(MUTATION_SENTINEL),
          `${script}: ${label} reached ${name} — the sentinel came back out of the shell:\n${output}`)
        const after = mutationValue(run)
        // `declare -n` against a readonly name kills the shell outright, so there is legitimately
        // nothing after it; anything that DID print must be the shipped value.
        if (after !== undefined) {
          assert.equal(after, value,
            `${script}: ${label} changed ${name} — \`readonly\` is missing from its declaration, or bash no longer `
            + `refuses that path:\n${output}`)
        }
      }
    }
  })
}

/**
 * THE STRUCTURAL HALF: THE WORD IS THERE, ON EVERY ONE OF THEM (o3d-secops).
 *
 * The test above proves bash's behaviour on each declaration it finds. This one pins the SET: how
 * many declarations there are across the three entrypoints, and that each carries the word. A
 * declaration that is deleted outright — a constant the entrypoints stop having, which the
 * behavioural test would simply stop iterating over — fails here on the count.
 *
 * MUTATION: drop `readonly` from any declaration and this names the script and the constant; delete
 * a declaration and the count moves.
 *
 * AND THE LIBRARY IS IN IT NOW (o3d-secops r2, Codex HIGH). The previous round excluded
 * scripts/lib/db-fence-protected.sh on the grounds that every fence harness sources it and then
 * points its /etc literals at a scratch directory, so `readonly` there "would make the library
 * untestable rather than safer". That was a property of WHERE THE HARNESS SUBSTITUTED, not of the
 * library: the harnesses now redirect the one trust-root literal in the shipped TEXT before running
 * it (tests/scripts/fence-artefact-harness.ts) and the nine paths composed from it are composed by
 * the library itself, `readonly` and all. The exclusion was the finding — the file that names the
 * recovery root, the protected tree and the executable helper was the one file left mutable.
 */
test('[o3d-secops] every protected constant an entrypoint or the shared library declares is declared `readonly`', () => {
  const missing: string[] = []
  const counted = new Map<string, number>()
  for (const [where, names] of [
    ...ENTRYPOINTS.map((script) => [script, PROTECTED_CONSTANTS as readonly string[]] as const),
    [FENCE_LIBRARY, PROTECTED_LIBRARY_CONSTANTS as readonly string[]] as const,
  ]) {
    const source = readFileSync(join(REPO, where), 'utf8')
    for (const name of names) {
      const line = shellConstantOptional(source, name, where)
      if (line === undefined) continue
      counted.set(where, (counted.get(where) ?? 0) + 1)
      if (!line.startsWith('readonly ')) missing.push(`${where}: ${line}`)
    }
  }
  assert.deepEqual(missing, [],
    'these constants are mutable, and `printf -v`, `read`, a nameref and `(( ))` all change them '
    + `without writing an assignment word any scanner here can see:\n${missing.join('\n')}`)

  const declared = [...counted.values()].reduce((total, one) => total + one, 0)
  assert.equal(counted.get(FENCE_LIBRARY), PROTECTED_LIBRARY_CONSTANTS.length,
    `the shared fence library declares ${PROTECTED_LIBRARY_CONSTANTS.length} protected constants; this walk found `
    + `${counted.get(FENCE_LIBRARY)}. A declaration that disappears takes its regression above with it.`)
  // 41 before o3d-secops r20, plus ${FENCE_MARKER_DIR} and ${LEGACY_STATE_DIR_FENCE_FILE} in each
  // of the three: the marker's root-owned directory, and the path inside the application's own data
  // directory it was moved out of. r22 adds two more per entrypoint for the same reason —
  // ${CUTOVER_ROOT_DIR}, the root-owned parent the lock and the connection-fence directory moved
  // under, and ${LEGACY_STATE_DIR_DB_FENCE_STATE}, the path they moved out of, whose NAME a
  // privileged run reads to decide whether to warn.
  assert.equal(declared, 53 + PROTECTED_LIBRARY_CONSTANTS.length,
    `the three entrypoints declared 53 protected publication constants between them when this was written, and the `
    + `shared library ${PROTECTED_LIBRARY_CONSTANTS.length} of its own; this walk found ${declared}. `
    + 'A declaration that disappears takes its regression above with it, so the count is asserted rather than the floor.')
})

/**
 * THE EXACT CENSUS OF THE LIBRARY'S OWN DECLARATIONS (o3d-secops r2).
 *
 * The two tests above measure the names this file WRITES DOWN. That is the shape that let the
 * library out of the last round: a set stated as a list covers what somebody remembered to add to
 * it, and a new path declared next to ${DB_FENCE_SCRIPT_COPY} tomorrow would be outside every one
 * of them, silently.
 *
 * So the direction is reversed here. The library's script-scope declarations are ENUMERATED — from
 * the same masked-and-bash-checked reading the rest of this file uses, so a declaration in a
 * comment or inside a function body is not one — and every name found must be in exactly one of two
 * lists: PROTECTED_LIBRARY_CONSTANTS, which the tests above then require `readonly` on and prove
 * bash refuses four mutations of, or MUTABLE_LIBRARY_NAMES, which states the reason. A name in
 * neither fails HERE, naming it, and the failure is the question rather than the answer: is this a
 * value the privileged mechanism acts on?
 *
 * IT IS AN EQUALITY, NOT A SUBSET. A name that disappears from the library fails too, because a
 * list that still claims a declaration nobody has is a list nobody has read.
 *
 * MUTATION / ROUTE: the test below appends one new path declaration to the library TEXT and
 * requires this same census to reject it — the check is proved able to go red on the change it
 * exists to catch, rather than asserted to be correct.
 */
function libraryDeclaredNames(source: string, where: string): string[] {
  // Over the MASK, so prose and strings cannot contribute a name: this file's own header spells
  // out four mutation forms and several ${NAME} references.
  const mask = maskShellSource(source, where)
  const candidates = new Set<string>()
  for (const match of mask.matchAll(/[A-Z_][A-Z0-9_]*\+?=/g)) candidates.add(match[0].replace(/\+?=$/, ''))
  // shellConstantAssignments() is the authority on SCOPE — it excludes every assignment inside a
  // function body, and it cross-checks its own lexing against bash's parse — so a candidate with no
  // script-scope assignment is a local, a here-document line, or a name this regex over-generated.
  return [...candidates].filter((name) => shellConstantAssignments(source, name, where).length > 0).sort()
}

/** The census, as the message a failure would print — empty when the library is fully classified. */
function unclassifiedLibraryNames(source: string, where: string): string[] {
  const complaints: string[] = []
  const found = libraryDeclaredNames(source, where)
  const classified = new Set<string>([...PROTECTED_LIBRARY_CONSTANTS, ...Object.keys(MUTABLE_LIBRARY_NAMES)])
  for (const name of found) {
    if (classified.has(name)) continue
    complaints.push(
      `${where} declares ${name} and nothing here says what it is. If the privileged mechanism ACTS on this value `
      + '— a path it reads, writes, seals, renames through or executes, a digest that authenticates, a decision '
      + 'about what is copied under /etc — declare it `readonly` at its declaration and add it to '
      + 'PROTECTED_LIBRARY_CONSTANTS. If the library sets it itself, add it to MUTABLE_LIBRARY_NAMES with the reason.')
  }
  for (const name of classified) {
    if (found.includes(name)) continue
    complaints.push(`${where} no longer declares ${name}, which is still listed here. Remove it from the list.`)
  }
  return complaints
}

test('[o3d-secops] every script-scope declaration the shared fence library makes is classified', () => {
  const complaints = unclassifiedLibraryNames(FENCE_LIB, FENCE_LIBRARY)
  assert.deepEqual(complaints, [], complaints.join('\n'))

  // THE WALK REACHED THE FILE, stated as a number: a census that silently enumerated nothing would
  // otherwise pass as one that enumerated everything and found it all classified.
  const found = libraryDeclaredNames(FENCE_LIB, FENCE_LIBRARY)
  assert.equal(found.length, PROTECTED_LIBRARY_CONSTANTS.length + Object.keys(MUTABLE_LIBRARY_NAMES).length,
    `the census found ${found.length} script-scope declarations in ${FENCE_LIBRARY}: ${found.join(', ')}`)

  // AND THE SIX THAT LEFT ARE GONE, not merely unlisted. Each was a value the privileged mechanism
  // ACTS on, and re-declaring any of them at script scope puts it back in a slot every later line
  // of every entrypoint can write.
  for (const name of NO_LONGER_SCRIPT_SCOPE) {
    assert.ok(!found.includes(name),
      `${FENCE_LIBRARY} declares ${name} at script scope again. It steers execution, authentication, `
      + 'publication or deletion, and it cannot carry `readonly` — so it belongs to the function that '
      + 'derives and consumes it, as a `local`.')
  }
})

/**
 * THE CENSUS AT THE SINK, NOT AT THE DECLARATION (o3d-secops r3, Codex HIGH — its second next-step).
 *
 * The census above is a census of NAMES: every script-scope declaration is in one of two lists. It
 * is exactly what let four values through last round, because the question it makes a reviewer ask
 * is asked WHERE THE NAME IS WRITTEN DOWN, and at the declaration ${DB_FENCE_PROBE_SCRIPT} and
 * ${DB_FENCE_PROBE_REASON} are the same thing: an empty string with a comment over it. What
 * separates them is sixty lines away, in `node "${DB_FENCE_PROBE_SCRIPT}" --preflight`.
 *
 * So this walks the other end. For every name still classified as a report, every place its value
 * is EXPANDED — in the library and in all three entrypoints — must be a place that only prints it,
 * tests it for emptiness, compares it against another report, or copies it into another name that
 * is itself only used that way (which is followed, so ${DB_FENCE_SUDO_PREFIX} pulls
 * ${DB_FENCE_RELEASE_CMD} into the question and answers it too). Anything else — a command
 * position, an argument to `node`/`rm`/`mv`/`cp`, an equality against something that authenticates
 * — is a SINK, and a mutable name that reaches one fails here, naming the file, the line and which
 * of the four it reached.
 *
 * WHY THE RULE IS ABOUT GRAMMAR AND NOT ABOUT A LIST OF DANGEROUS COMMANDS. A deny-list of `rm`,
 * `node` and friends is a list somebody has to remember to extend, which is the failure this test
 * exists to stop repeating. The rule here is the inverse: a report may appear in a printing
 * position, an emptiness test, a report-to-report comparison, or an assignment — and NOTHING ELSE
 * is allowed, whether or not anybody thought of it.
 *
 * MEASURED AGAINST THE TREE THAT HAD THE DEFECT, which is the only way to know this is a check and
 * not a decoration — and no longer only in this comment: the measurement is now the standing test
 * `the sink census still names exactly the seven values b128f47f got wrong`, which reads that
 * commit's four shell files out of git and runs this same rule over them with that commit's
 * classification (twelve mutable names, seven of them wrong). It examines 90 expansions and
 * produces 9 complaints naming exactly seven names — DB_FENCE_PROBE_SCRIPT (EXECUTION in both
 * entrypoints, AUTHORIZATION in both), DB_FENCE_PROBE_TEMP (DELETION), DB_FENCE_PROBE_ARTEFACT_SHA256
 * (AUTHORIZATION), DB_FENCE_SOURCE_UNTRUSTED_PATH (the publication gate) and the three _FENCE_SRC_*
 * arrays (the find that computes it) — and nothing else. On the tree as it stands, 63 expansions
 * and no complaints.
 *
 * (82 was the r3 figure, taken before the rule stopped ignoring lowercase names. The eight extra
 * expansions are the ones reached through `offender`, a lowercase `local` this rule now follows and
 * did not before — which is the r4 finding, visible as a number.)
 *
 * AND TWO HOLES THE R3 RULE HAD, both closed below and both about names it could not see rather
 * than sinks it did not list: it followed an assignment only into an UPPERCASE target, so a report
 * routed through a `local` escaped; and it read only direct `$NAME`/`${NAME}` expansions, so bash
 * indirection — `${!c}`, `declare -n`, `printf -v "$t"` — escaped entirely. See nameExpansions()
 * and indirections().
 */
const REPORT_PRINTERS = new Set([
  'echo', 'printf', 'warn', 'info', 'ok', 'success', 'error', 'die', 'note', 'log', 'step',
])
const SHELL_KEYWORDS = new Set(['if', 'elif', 'while', 'until', 'then', 'else', 'do', 'done', 'fi', '{', '}', '!'])
const SINK_KIND: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(rm|rmdir|shred|unlink|truncate)$/, 'DELETION'],
  [/^(node|bash|sh|eval|exec|source|\.|runuser|env|su|sudo|python3?)$/, 'EXECUTION'],
  [/^(cp|mv|install|ln|chown|chmod|mkdir|tee|dd|rsync|find|cat)$/, 'PUBLICATION or a destructive filesystem operation'],
]

/**
 * The segments of one shell line, split on `;`, `&&` and `||` OUTSIDE quotes AND OUTSIDE `[[ … ]]`.
 *
 * The bracket depth is load-bearing, not tidiness. Splitting inside a conditional pulls
 * `[[ -z "${A}" && -n "${B}" ]]` apart into two one-name tests, and the rule below decides what a
 * conditional is FROM THE COMPANY IT KEEPS — so a split there hands it a report standing alone and
 * it says fine. That is the exact shape of the publication gate this round was about.
 */
function shellSegments(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  let depth = 0
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]
    if (quote !== null) {
      cur += c
      if (c === quote && line[i - 1] !== '\\') quote = null
      continue
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue }
    if (c === '[' && line[i + 1] === '[') { depth += 1; cur += '[['; i += 1; continue }
    if (c === ']' && line[i + 1] === ']') { depth = Math.max(0, depth - 1); cur += ']]'; i += 1; continue }
    if (depth === 0 && c === ';') { out.push(cur); cur = ''; continue }
    if (depth === 0 && (c === '&' || c === '|') && line[i + 1] === c) { out.push(cur); cur = ''; i += 1; continue }
    cur += c
  }
  out.push(cur)
  return out.map((segment) => segment.trim()).filter((segment) => segment.length > 0)
}

/** The command word of a segment, with the shell keywords in front of it stepped over. */
function segmentHead(segment: string): string {
  let words = segment.split(/\s+/).filter((word) => word.length > 0)
  while (words.length > 0 && SHELL_KEYWORDS.has(words[0])) words = words.slice(1)
  return words[0] ?? ''
}

/**
 * Whether a segment is the continued ARGUMENT of a multi-line printer — a quoted string and nothing
 * else. `"${DB_FENCE_SUDO_PREFIX}${DB_FENCE_RELEASE_WRAPPER}" --release` opens with a quote as well
 * and is a COMMAND WORD; treating every leading quote as prose was this rule's second false
 * negative, caught by the mutation fixture below rather than by reading it again.
 */
function isContinuedString(segment: string): boolean {
  const quote = segment[0]
  if (quote !== '"' && quote !== "'") return false
  let i = 1
  while (i < segment.length && !(segment[i] === quote && segment[i - 1] !== '\\')) i += 1
  const rest = segment.slice(i + 1).trim()
  return rest === '' || rest === '\\'
}

/**
 * EVERY EXPANSION OF A NAME, WHATEVER ITS CASE (o3d-secops r4, Codex HIGH).
 *
 * This used to match `[A-Z_][A-Z0-9_]*` only, and the assignment-follow below used to add a target
 * only when the target was all-uppercase too. Between them that made a `local` a laundry:
 *
 *     local probe="${DB_FENCE_PROBE_REASON}"   # target is lowercase, so nothing was followed
 *     node "${probe}" --preflight              # and `probe` was not a name this rule could see
 *
 * Uppercase-for-globals is a CONVENTION in these scripts, not a rule bash enforces, and a rename on
 * the way to a sink is precisely what a `local` is for. So the pattern is now every identifier bash
 * accepts, and the follow has no casing test at all.
 *
 * `${#NAME}` is included (a length is still a read of the value). `${!c}` is deliberately NOT
 * matched here: an indirect expansion names a variable this rule cannot know, and it is handled by
 * indirections() below, which REFUSES rather than returning a name.
 *
 * THE PRICE, STATED. Following lowercase names makes the census's name space FLAT: a `local x` in
 * one function and a `local x` in another are the same name to this rule. That direction is
 * fail-closed — a collision produces a complaint naming a file and a line, never a silence — and
 * the shipped tree is measured clean below, so it is not happening today. It does mean that a
 * future edit which routes a report through a name as common as `probe` will be told to rename it.
 */
const nameExpansions = (text: string): string[] =>
  [...text.matchAll(/\$\{?#?([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1])

/**
 * WHAT THE CENSUS CANNOT READ LEXICALLY, AND SO REFUSES (o3d-secops r4, Codex HIGH).
 *
 * Bash can name a variable at RUNTIME. `${!c}` reads the variable whose name is the VALUE of `c`;
 * `declare -n r=X` makes `$r` an alias of `$X`; `printf -v "$t"`, `read "$t"` and `mapfile "$t"`
 * WRITE a variable whose name is a value. None of those put the name in the text, so a rule that
 * reads text cannot follow them — and the previous version of this census did not even try: it
 * matched direct `$NAME`/`${NAME}` forms and skipped the rest, which is the silent pass the
 * function-body scanner on this branch already refused to give for `eval` and for `$( ( … ) … )`.
 *
 * So the same answer is given here. Each shape below is either RESOLVED or REFUSED:
 *
 *   RESOLVED  a nameref with a literal pointee IS that name — `declare -n r=DB_FENCE_PROBE_REASON`
 *             puts `r` into the report set, so `rm -rf "$r"` fails as DELETION like any other
 *             report at a sink. `printf -v NAME`, `read NAME`, `mapfile NAME` and `(( NAME = … ))`
 *             with a literal NAME are ASSIGNMENTS written without a `=` word, so the TARGET is
 *             followed exactly as `NAME=` is. Resolved means followed, not waved through: only
 *             `printf` is a printer, so `read -r NAME <<<"${A_REPORT}"` is followed AND still
 *             named at a command position. That is deliberate — this rule does not model
 *             redirections, and `read -r x < <(node "${A_REPORT}")` would otherwise be a sink
 *             hiding behind an allowed head.
 *   REFUSED   anything whose name is an expansion — `${!c}`, `declare -n r="$1"`, `printf -v "$t"`,
 *             `read "$t"` — and `eval`, which re-parses text this rule will never see. The refusal
 *             is a complaint naming the file, the line and the shape.
 *
 * WHERE THE REFUSAL APPLIES, AND WHY IT IS NOT THE WHOLE ESTATE. The fence library is the file that
 * DECLARES the names this census classifies, and it is entirely under this branch's control: any
 * unresolvable shape there is refused unconditionally, and there are none today (measured — the
 * only `read` in it is `while IFS= read -r relative`, a literal target). In the three entrypoints
 * the refusal is triggered by the STATEMENT: an unresolvable shape in a segment that also mentions
 * a report, or whose controller is itself a report, is refused. That is a rule about the grammar of
 * one command, not a proximity window.
 *
 * WHAT THAT DOES NOT SETTLE, SAID PLAINLY. scripts/install.sh legitimately uses `${!name}` and
 * `local -n` in generic helpers — prompt(), capture(), libpq_env_unset_args() — where the name comes
 * from `$1` or from a `read` of a computed list. Those are not refused, because no report is on
 * those statements. An attacker who wrote `ref=SOMETHING_UNTRACKED` in an entrypoint and later
 * `node "${!ref}"` in a different statement would not be caught. Resolving that needs call-site
 * dataflow this rule does not do; what closes it instead is that the library — the only file that
 * derives these values — refuses every such shape outright.
 *
 * AND ONE RESOLUTION THAT WAS TRIED AND REJECTED, with the measurement. Treating a report's NAME
 * appearing anywhere in an assignment's right-hand side as an alias looked right and is unusable:
 * a report name is also an ordinary English word (${DB_FENCE_SEAL_REASON}'s offender variable is
 * literally `offender`), so message strings matched it. Measured against b128f47f that put 435
 * names into the report set and produced 786 complaints. The rule below therefore requires the name
 * to be the WHOLE right-hand side — `ref=DB_FENCE_PROBE_REASON` and nothing else.
 */
type Indirection = { readonly kind: string, readonly ref: string, readonly target: string, readonly literal: boolean }

const LITERAL_NAME = /^["']?([A-Za-z_][A-Za-z0-9_]*)["']?$/
const literalName = (word: string): string | null => LITERAL_NAME.exec(word)?.[1] ?? null

/**
 * WHAT NAME, IF ANY, AN ASSIGNED WORD HOLDS — ANSWERED, OR REFUSED (o3d-secops r6, Codex HIGH).
 *
 * This used to be a regex: a bare identifier, or one wrapped in a single matching pair of quotes.
 * It was wrong in the direction that matters, because bash concatenates adjacent literal fragments
 * and removes quotes, so `ref=DB_FENC"E_PROBE_REASON"` really does assign `DB_FENCE_PROBE_REASON`
 * and the regex read it as "not a name at all". A real alias, in ordinary shell syntax, invisible —
 * and then `node "${!ref}"` in an entrypoint had no report on the statement, so the indirection was
 * skipped rather than refused. shellWordLiteral() evaluates the word instead, so every spelling of
 * one literal value gives one answer.
 *
 * THERE ARE THREE ANSWERS, AND THE THIRD IS THE POINT.
 *
 *   `name`     the word is written out in full and IS an identifier. Follow it.
 *   `settled`  the census knows there is nothing to follow. Either the word is written out in full
 *              and is not an identifier (`ref=/tmp/x`), or it is a runtime value whose determined
 *              fragments ALREADY rule an identifier out — `"${dir}/file"` carries a literal `/`,
 *              and `"${a} b"` carries a literal space (see shellWordLiteral() on how a truncation
 *              yields that fact). No identifier contains either.
 *   `refuse`   the word mixes literal NAME text with something decided at runtime —
 *              `ref="DB_FENCE_PROBE_${which}"`, `ref=DB_FENCE_$(pick)`. It is a name being
 *              ASSEMBLED out of source text, the assembly cannot be finished lexically, and the
 *              answer decides whether `${!ref}` reads a report. So it is refused by name and line.
 *
 * AND THE BOUNDARY OF `settled`, STATED RATHER THAN LEFT TO BE FOUND. A word with NO literal text
 * at all — `ref="$1"`, `ref="${x}"`, `ref="$(pick)"` — is not refused. It COPIES a value from
 * somewhere else, and a copy is what the census already models: the walk's own assignment rule
 * follows `ref="${x}"` into `ref` whenever `x` is a report, so alias-ness travels through a copy on
 * that path rather than this one. What it does not model is where the copied value came from if it
 * was never a report — the call-site dataflow this census has refused to invent since r4, and which
 * the library closes instead by refusing EVERY indirection in it unconditionally. Measured over the
 * shipped four files, across the 2222 words that REPLACE a name: 837 are read out in full, 712 are
 * ruled out by a character no identifier may carry, 673 are copies, and NONE is refused.
 */
type AliasAnswer =
  | { readonly kind: 'name'; readonly name: string }
  | { readonly kind: 'settled' }
  | { readonly kind: 'refuse'; readonly why: string }

const NAME_TEXT = /^[A-Za-z0-9_]*$/
const aliasedName = (word: string): AliasAnswer => {
  const value = shellWordLiteral(word)
  if (value.kind === 'literal') {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value.value) ? { kind: 'name', name: value.value } : { kind: 'settled' }
  }
  if (!NAME_TEXT.test(value.literal) || value.literal === '') return { kind: 'settled' }
  return { kind: 'refuse', why: value.why }
}

function indirections(segment: string): Indirection[] {
  const out: Indirection[] = []
  // `${!c}`, `${!c[@]}`, `${!c*}`, `${!c-default}` — the controller is `c`, never the name read.
  for (const match of segment.matchAll(/\$\{\s*!\s*([A-Za-z_][A-Za-z0-9_]*)?/g)) {
    out.push({ kind: 'an indirect expansion `${!…}`', ref: '', target: match[1] ?? '', literal: false })
  }
  // `declare -n r=X`, `local -n r=X`, `typeset -rn r=X`, and the same with no `=` at all.
  for (const match of segment.matchAll(/(?:^|[\s;&|(){}])(?:declare|local|typeset)((?:\s+-[A-Za-z]+)+)\s+([A-Za-z_][A-Za-z0-9_]*)(=(\S*))?/g)) {
    if (!/n/.test(match[1])) continue
    const pointee = match[3] === undefined ? '' : (match[4] ?? '')
    const literal = literalName(pointee)
    out.push({ kind: 'a nameref declaration', ref: match[2], target: literal ?? pointee, literal: literal !== null })
  }
  for (const match of segment.matchAll(/(?:^|[\s;&|(){}])printf(?:\s+-[A-Za-z]+)*\s+-v\s+(\S+)/g)) {
    const literal = literalName(match[1])
    out.push({ kind: '`printf -v`', ref: literal ?? match[1], target: '', literal: literal !== null })
  }
  // Every non-option word of a `read`/`mapfile` is treated as a target. `-p "$(…)"` therefore reads
  // as a non-literal target and refuses — the fail-closed direction, and it costs nothing here
  // because a refusal only fires where a report is on the statement or the file is the library.
  for (const match of segment.matchAll(/(?:^|[\s;&|(){}])(read|mapfile|readarray)\s+([^<>|]*)/g)) {
    for (const word of match[2].split(/\s+/).filter(Boolean)) {
      if (word.startsWith('-')) continue
      const literal = literalName(word)
      out.push({ kind: `a \`${match[1]}\` target`, ref: literal ?? word, target: '', literal: literal !== null })
    }
  }
  for (const match of segment.matchAll(/\(\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*[-+*/%^|&]?=[^=]/g)) {
    out.push({ kind: 'an arithmetic assignment', ref: match[1], target: '', literal: true })
  }
  if (/(?:^|[\s;&|(){}])eval(\s|$)/.test(segment)) {
    out.push({ kind: '`eval`', ref: '', target: '', literal: false })
  }
  return out
}

/**
 * Every sink a report-classified name reaches, across the library and the entrypoints. Also returns
 * how many expansions were examined, because a walk that inspected nothing would otherwise report
 * a clean estate.
 */
function reportSinkComplaints(sources: ReadonlyArray<readonly [string, string]>, seeds: readonly string[], libraryFile: string = FENCE_LIBRARY):
{ complaints: string[]; examined: number; followed: string[] } {
  const reports = new Set<string>(seeds)
  const followed: string[] = []
  let complaints: string[] = []
  let examined = 0
  // A NAME THAT IS EVER APPENDED TO IS NEVER AN ALIAS. `ref+=X` keeps whatever `ref` held and adds
  // to it, so neither the append nor any replacement elsewhere leaves the census able to say the
  // name still holds exactly one report's name. Estate-wide rather than per-file, because the
  // census's name space is flat (see nameExpansions()). Measured: no name in the shipped four
  // files, and none at b128f47f, is both appended to and otherwise followable as an alias.
  const appendedTo = new Set(sources.flatMap(([file, source]) =>
    shellAssignments(source, file).filter(({ append }) => append).map(({ name }) => name)))
  // The set GROWS as assignments are followed, so a report copied into another name drags that name
  // into the question. Re-walked until it stops growing; the estate is small and this terminates.
  for (let round = 0; round < 8; round += 1) {
    complaints = []
    examined = 0
    const before = reports.size
    for (const [file, source] of sources) {
      source.split('\n').forEach((raw, index) => {
        const line = raw.trim()
        if (line.length === 0 || line.startsWith('#')) return
        for (const segment of shellSegments(line)) {
          const where = `${file}:${index + 1}`
          const owned = file === libraryFile
          const names = nameExpansions(segment).filter((name) => reports.has(name))

          // RUNTIME-NAMED VARIABLES FIRST: resolved into the walk, or refused outright.
          for (const shape of indirections(segment)) {
            if (shape.literal) {
              if (shape.target !== '' && reports.has(shape.target) && !reports.has(shape.ref)) {
                reports.add(shape.ref)
                followed.push(`${shape.ref} (nameref to ${shape.target}, from ${where})`)
              }
              if (shape.target === '' && names.length > 0 && !reports.has(shape.ref)) {
                reports.add(shape.ref)
                followed.push(`${shape.ref} (from ${where})`)
              }
              continue
            }
            const onAReport = names.length > 0
              || (shape.ref !== '' && reports.has(shape.ref))
              || (shape.target !== '' && reports.has(shape.target))
            if (!owned && !onAReport) continue
            complaints.push(
              `${where} uses ${shape.kind}, and the variable it names is a RUNTIME value this census `
              + `cannot resolve: ${segment}\n`
              + '  Bash indirection cannot be followed lexically, so the census refuses rather than '
              + 'passes. Name the variable outright, or derive and consume the value inside one '
              + 'function so no script-scope name is in play.')
          }

          if (names.length === 0) continue
          examined += names.length
          // A continued argument — the next line of a multi-line `die "…"` — prints like the first.
          // It is a CONTINUATION only when the quote is the whole segment: `"${X}" --release` opens
          // with a quote too, and is a command word.
          if (isContinuedString(segment)) continue
          const head = segmentHead(segment)
          if (REPORT_PRINTERS.has(head)) continue
          const assignment = /^(?:local |export |readonly |declare [^ ]+ )*([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?\+?=/.exec(head === '' ? segment : segment.slice(segment.indexOf(head)))
          if (assignment !== null) {
            // The value flows into another name; that name now has to answer the same question.
            // NO CASING TEST: a `local probe=` is exactly where a report gets renamed on its way to
            // a sink, and requiring the target to be uppercase let that through.
            if (!reports.has(assignment[1])) {
              reports.add(assignment[1])
              followed.push(`${assignment[1]} (from ${where})`)
            }
            continue
          }
          // A conditional, INCLUDING a continuation of one: splitting `[[ -n "$A" || -n "$B" ]]` on
          // the `||` leaves a second segment that starts at the operator and ends at the `]]`.
          // Treating that as a command position was this rule's own first false positive.
          const conditional = head === '[[' || head === '[' || /\]\]?$/.test(segment) || /^!?\s*-[a-z]\s/.test(segment)
          if (conditional) {
            // A conditional over REPORTS ONLY decides which sentence gets printed — `-n` on a note
            // to see whether there is anything to say, or one digest against another to choose
            // between two report lines. The instant a NON-report expansion joins it, the test is
            // deciding something about a value the mechanism acts on.
            //
            // AND THAT IS WHY THE OPERATOR IS NOT THE TEST. The rule read `-n`/`-z` as harmless at
            // first, and that alone let ${DB_FENCE_SOURCE_UNTRUSTED_PATH} through when this was
            // measured against the pre-fix tree: its sink is
            // `[[ -z "${DB_FENCE_EXPECTED_ARTEFACT_SHA256}" && -n "${DB_FENCE_SOURCE_UNTRUSTED_PATH}" ]]`,
            // an emptiness test that is the whole publication gate. What makes a conditional a
            // report is its COMPANY, not its operator.
            if (nameExpansions(segment).every((name) => reports.has(name))) continue
            complaints.push(
              `${where} tests ${names.join(', ')} alongside something that is not another report — `
              + `that is AUTHORIZATION, not a report: ${segment}`)
            continue
          }
          const kind = SINK_KIND.find(([pattern]) => pattern.test(head))?.[1]
            ?? 'a command position — the mechanism ACTS on this value'
          complaints.push(
            `${where} reaches ${kind} with ${names.join(', ')}: ${segment}\n`
            + '  A value that reaches execution, authorization, publication or deletion is not a report. '
            + 'Make it a `local` of the function that derives and consumes it, or `readonly` if it must be global.')
        }
      })
    }
    // A report's NAME held as the WHOLE of an assignment's right-hand side is an alias: after
    // `ref=DB_FENCE_PROBE_REASON`, `${!ref}` reads the report. Whole-RHS only — see the note above
    // indirections() for the 786-complaint measurement that rejected the looser form.
    //
    // WHICH ASSIGNMENTS THOSE ARE IS NOT THIS RULE'S QUESTION TO ANSWER (o3d-secops r5, Codex HIGH).
    // It used to answer it anyway, with `(?:local |export |readonly |declare [^ ]+ )*NAME=`, and
    // that regex was wrong twice over: `declare ref=NAME` has no option word for `declare [^ ]+ `
    // to eat, and `local scratch=x ref=NAME` has a SECOND operand the regex's `$` anchor could
    // never reach. shellAssignments() answers it by the word rule this branch has used for
    // definitions and for script-scope constants all along — a name is assigned where it starts a
    // word — so `declare`, `local`, `export`, `readonly`, `typeset`, their option forms, their
    // no-option forms and every operand of each are covered without one of them being enumerated.
    // It reads the MASKED source too, so a `ref=DB_FENCE_PROBE_REASON` in a trailing comment or a
    // here-document body is data rather than an alias, which the line rule could not tell.
    //
    // AND WHICH OF THOSE ACTUALLY ASSIGN IS A SECOND QUESTION, WHICH THIS ALSO USED TO SKIP
    // (o3d-secops r6, Codex HIGH). Everything shellAssignments() returned was taken for a
    // persistent replacement, and three of the shapes it returns are not one — `ref+=NAME` keeps
    // the old value, `ref=NAME true` is `true`'s environment, `echo ref=NAME` assigns nothing at
    // all. Each nevertheless promoted `ref` into the report set, and a report in that set is a name
    // the CONDITIONAL rule may see beside another report and stay silent about. So an invented
    // alias BUYS A CONDITIONAL'S SILENCE, which is the same currency the quote-balance requirement
    // was added for in r5, spent three other ways. `held.replaces` is now the gate, and
    // shellAssignments() derives it from where the word sits in its command.
    for (const [file, source] of sources) {
      for (const held of shellAssignments(source, file)) {
        // AND ONE POSITION THAT IS NOT A THIRD ANSWER BUT NO ANSWER AT ALL. `ref=NAME $(pick)` is
        // a command prefix when `pick` prints a word and a BARE ASSIGNMENT when it prints nothing,
        // and both were measured under a real bash. Where that decides whether a report's name is
        // held, the census says so rather than picking one.
        if (held.position === 'undecidable' && !held.append) {
          const undecided = aliasedName(held.value)
          if (undecided.kind === 'refuse' || (undecided.kind === 'name' && reports.has(undecided.name))) {
            complaints.push(
              `${file}:${held.line} puts ${held.name} in front of a command word that is nothing but `
              + `an expansion, so whether this is a command prefix or the whole command is decided at `
              + `RUNTIME — and it is the assignment of a report's name: ${held.name}=${held.value}\n`
              + '  If the expansion comes back empty the word vanishes and the assignment stands, '
              + 'which would make this an alias; if it does not, the assignment is only that '
              + "command's environment. Name the command outright, or split the assignment onto its "
              + 'own line.')
          }
          continue
        }
        // ONLY A PERSISTENT REPLACEMENT ANSWERS THE QUESTION. `held.replaces` is false for the
        // three shapes above, and each was measured under a real bash before this line was written.
        if (!held.replaces) continue
        const answer = aliasedName(held.value)
        if (answer.kind === 'refuse') {
          complaints.push(
            `${file}:${held.line} assembles a NAME out of source text and ${answer.why}, so this `
            + `census cannot say what ${held.name} holds: ${held.name}=${held.value}\n`
            + '  A name held in a variable is read back with `${!…}`, and whether that reads a report '
            + 'is decided by this value. Write the name outright, or derive and consume the value '
            + 'inside one function so no script-scope name is in play.')
          continue
        }
        if (answer.kind !== 'name' || !reports.has(answer.name)) continue
        if (reports.has(held.name) || appendedTo.has(held.name)) continue
        reports.add(held.name)
        followed.push(`${held.name} (holds the NAME ${answer.name}, from ${file}:${held.line})`)
      }
    }
    if (reports.size === before) break
  }
  return { complaints, examined, followed }
}

const SINK_CENSUS_SOURCES: ReadonlyArray<readonly [string, string]> = [
  [FENCE_LIBRARY, FENCE_LIB],
  ...ENTRYPOINTS.map((script) => [script, readFileSync(join(REPO, script), 'utf8')] as const),
]

test('[o3d-secops] no name classified as a report reaches execution, authorization, publication or deletion', () => {
  const { complaints, examined, followed } = reportSinkComplaints(
    SINK_CENSUS_SOURCES, Object.keys(MUTABLE_LIBRARY_NAMES))
  assert.deepEqual(complaints, [], complaints.join('\n'))

  // THE WALK REACHED THE SINKS, stated as numbers. A rule that examined nothing would pass exactly
  // like a rule that examined everything and found it clean — which is the shape of the defect this
  // whole round is about.
  assert.ok(examined >= 60,
    `the sink census must reach the places these names are used; it examined ${examined} expansions`)
  assert.ok(followed.length >= 1,
    `and it must FOLLOW a report into the names it is copied into; it followed: ${followed.join(', ')}`)
})

test('[o3d-secops] a report that reaches one of the four sinks fails the sink census', () => {
  // NOT VACUOUS: the unmodified estate passes (the test above), so each failure below is the
  // appended line talking. One fixture per sink, each a line bash would really execute.
  const cases: ReadonlyArray<readonly [string, RegExp]> = [
    ['rm -rf "${DB_FENCE_PROBE_REASON}"', /reaches DELETION with DB_FENCE_PROBE_REASON/],
    ['node "${DB_FENCE_ROTATION_NOTE}" --preflight', /reaches EXECUTION with DB_FENCE_ROTATION_NOTE/],
    ['cp -R "${DB_FENCE_SEAL_REASON}" /etc/ims-cutover-recovery/app', /reaches PUBLICATION or a destructive filesystem operation with DB_FENCE_SEAL_REASON/],
    ['[[ "${DB_FENCE_PROBE_STANDING_SHA256}" == "${DB_FENCE_EXPECTED_ARTEFACT_SHA256}" ]] || exit 1',
      /tests DB_FENCE_PROBE_STANDING_SHA256 alongside something that is not another report/],
    // THE SHAPE THE FIRST DRAFT OF THIS RULE MISSED, and the one the finding was actually about:
    // an EMPTINESS test that is a gate. Measured against the pre-fix tree, an operator-based rule
    // reported six of the seven sinks and stayed silent on this one.
    ['[[ -z "${DB_FENCE_EXPECTED_ARTEFACT_SHA256}" && -n "${DB_FENCE_PROBE_REASON}" ]] && exit 1',
      /tests DB_FENCE_PROBE_REASON alongside something that is not another report/],
    ['"${DB_FENCE_SUDO_PREFIX}${DB_FENCE_RELEASE_WRAPPER}" --release', /reaches .* with DB_FENCE_SUDO_PREFIX/],
    // THE SHAPE THE R3 RULE MISSED, and the one this round's finding was about: a report renamed
    // into a LOWERCASE `local` on its way to the sink. r3 followed an assignment only when the
    // target was all-uppercase, so this passed. `laundered_reason` rather than `probe` because the
    // census's name space is flat and `probe` is an ordinary local elsewhere in the estate — the
    // collision would make this fixture prove six complaints instead of the one it is about.
    ['local laundered_reason="${DB_FENCE_PROBE_REASON}"\nnode "${laundered_reason}" --preflight',
      /reaches EXECUTION with laundered_reason/],
    // AND THE SAME LAUNDERING WITHOUT AN `=` WORD. `printf -v NAME` is an assignment bash performs
    // and no `NAME=` scanner sees; with a literal target it is RESOLVED and followed, not refused.
    ['printf -v LAUNDERED \'%s\' "${DB_FENCE_PROBE_REASON}"\nnode "${LAUNDERED}" --preflight',
      /reaches EXECUTION with LAUNDERED/],
    // A NAMEREF WITH A LITERAL POINTEE IS RESOLVED TOO: `$ref` IS ${DB_FENCE_PROBE_REASON}, so the
    // `rm` is DELETION of a report and is named as such rather than refused.
    ['local -n ref=DB_FENCE_PROBE_REASON\nrm -rf "${ref}"', /reaches DELETION with ref/],
    // THE TWO SHAPES THE R4 ALIAS REGEX MISSED, and the ones this round's finding was about. Both
    // are the ordinary alias — a report's NAME as the WHOLE right-hand side — written in a form the
    // enumeration `(?:local |export |readonly |declare [^ ]+ )*` could not reach: a `declare` with
    // no option word for it to eat, and a SECOND operand past the `$` it anchored on. Neither line
    // expands anything, so under that regex the census saw no report on either statement and the
    // `rm` that follows was a delete of a name it had never heard of.
    ['declare declared_alias=DB_FENCE_PROBE_REASON\nrm -rf "${declared_alias}"',
      /reaches DELETION with declared_alias/],
    ['local scratch=/tmp/keep operand_alias=DB_FENCE_PROBE_REASON\nrm -rf "${operand_alias}"',
      /reaches DELETION with operand_alias/],
    // AND WHAT CANNOT BE RESOLVED IS REFUSED RATHER THAN SKIPPED — four shapes, none of which puts
    // the variable's name in the text.
    ['node "${!DB_FENCE_PROBE_REASON}"', /uses an indirect expansion/],
    ['ref=DB_FENCE_PROBE_REASON\nnode "${!ref}"', /uses an indirect expansion/],
    ['declare -n ref="$1"', /uses a nameref declaration/],
    ['printf -v "$target" \'%s\' "${DB_FENCE_PROBE_REASON}"', /uses `printf -v`/],
  ]
  for (const [addition, expected] of cases) {
    const { complaints } = reportSinkComplaints(
      [[FENCE_LIBRARY, `${FENCE_LIB}\n${addition}\n`], ...SINK_CENSUS_SOURCES.slice(1)],
      Object.keys(MUTABLE_LIBRARY_NAMES))
    assert.equal(complaints.length, 1, `exactly the appended line must fail, for: ${addition}\n${complaints.join('\n')}`)
    assert.match(complaints[0], expected, complaints[0])
  }

  // AND THE ALLOWED SHAPES REALLY ARE ALLOWED, or the rule above is "nothing may mention a report"
  // wearing a costume — which would be red on the shipped tree and is not.
  for (const addition of [
    'warn "${DB_FENCE_PROBE_REASON}"',
    'if [[ -n "${DB_FENCE_ROTATION_NOTE}" ]]; then echo "${DB_FENCE_ROTATION_NOTE}" >&2; fi',
    'DB_FENCE_ROTATION_NOTE="${DB_FENCE_SEAL_REASON}"',
    '[[ "${DB_FENCE_PROBE_STANDING_SHA256}" == "${DB_FENCE_PROBE_ARTEFACT_SHA256}" ]] || printf ok',
    // A LOWERCASE `local` THAT ONLY PRINTS is still allowed. Following lowercase targets must not
    // turn the rule into "no report may be copied", or the shipped tree would be red and it is not.
    'local note="${DB_FENCE_ROTATION_NOTE}"\nwarn "${note}"',
  ]) {
    const { complaints } = reportSinkComplaints(
      [[FENCE_LIBRARY, `${FENCE_LIB}\n${addition}\n`], ...SINK_CENSUS_SOURCES.slice(1)],
      Object.keys(MUTABLE_LIBRARY_NAMES))
    assert.deepEqual(complaints, [], `a printing/emptiness/report-comparison use must pass: ${addition}\n${complaints.join('\n')}`)
  }

  // AND A WORD THAT MERELY STARTS WITH A REPORT'S NAME IS NOT AN ALIAS (o3d-secops r5).
  //
  // shellAssignments() ends a word at the first byte the mask and the source agree is a
  // metacharacter, and a QUOTED space is the one byte those two readings cannot tell from an
  // unquoted one — so `ref="DB_FENCE_PROBE_REASON extra"` comes back as the fragment
  // `"DB_FENCE_PROBE_REASON`. literalName()'s optional quotes would read that as the name and put
  // `ref` in the report set, and a spare name in that set is NOT a harmless over-approximation:
  // the conditional rule stays silent exactly when every expansion beside a report is also a
  // report, so an invented report is a way to buy a conditional's silence. aliasedName() requires
  // the quoting to balance, so the fragment is not a name and `ref` is not followed.
  const fragment = reportSinkComplaints(
    [[FENCE_LIBRARY, `${FENCE_LIB}\nref="DB_FENCE_PROBE_REASON extra"\n`], ...SINK_CENSUS_SOURCES.slice(1)],
    Object.keys(MUTABLE_LIBRARY_NAMES))
  assert.deepEqual(fragment.complaints, [], fragment.complaints.join('\n'))
  assert.ok(!fragment.followed.some((entry) => entry.startsWith('ref ')),
    `a word that is not exactly a report's name must not be followed as an alias; it followed: ${fragment.followed.join(', ')}`)

  // NOT VACUOUS: the same line with the same name as the WHOLE word IS followed, so the assertion
  // above is the balance rule talking and not an alias rule that has stopped working.
  const whole = reportSinkComplaints(
    [[FENCE_LIBRARY, `${FENCE_LIB}\nref="DB_FENCE_PROBE_REASON"\n`], ...SINK_CENSUS_SOURCES.slice(1)],
    Object.keys(MUTABLE_LIBRARY_NAMES))
  assert.ok(whole.followed.some((entry) => entry.startsWith('ref (holds the NAME DB_FENCE_PROBE_REASON')),
    `a quoted whole-word alias must be followed; it followed: ${whole.followed.join(', ')}`)
})

/**
 * WHICH ASSIGNMENT-SHAPED WORDS ACTUALLY ASSIGN (o3d-secops r6, Codex HIGH).
 *
 * The alias closure took every word shellAssignments() returned for a persistent replacement of a
 * shell variable. Three of the shapes it returns are not one, and bash is unambiguous about all
 * three — so each is RUN HERE FIRST, with `ref` given a non-report value beforehand, and what bash
 * prints back is asserted before anything is asked of the scanner:
 *
 *   ref+=NAME          `ref` keeps SOMETHING_UNTRACKED and gains the text: an APPEND, not a
 *                      replacement, so after it `ref` holds neither value on its own.
 *   ref=NAME true      `ref` is still SOMETHING_UNTRACKED. The assignment went into `true`'s
 *                      ENVIRONMENT and the shell's own variable was never touched.
 *   echo ref=NAME      `ref` is still SOMETHING_UNTRACKED. `echo` printed the text; nothing was
 *                      assigned by anything.
 *
 * WHY AN OVER-COUNT HERE IS NOT HARMLESS. A name in the report set is a name the CONDITIONAL rule
 * is allowed to see beside another report and stay silent about, so an invented alias is a way to
 * buy an authorization conditional's silence — exactly what r5's quote-balance requirement was
 * added to stop, spent three other ways. Measured over the shipped four files: 2386 words are
 * assignment-shaped, and 164 of them (46 appends, 21 command prefixes, 97 arguments) are not
 * replacements. The old rule read all 164 as replacements. Every one of the 21 prefixes is real —
 * `IFS= read`, `IFS='|' read`, `LC_ALL=C sort` — and every one of the 97 arguments is an operand of
 * `env`, of `psql -v` or of `chmod`, none of which assigns a shell variable.
 *
 * ROUTE: shellAssignments().position and .replaces on each form, against bash's own answer.
 *
 * MUTATION, one per row, each edit made and this test run under it:
 *   `replaces: !append`                    — the position ignored; the PREFIX row goes red.
 *   `operand.position = 'operand'` for a    — a post-command argument taken for a declaration
 *   word after a non-declaration command      operand; the ARGUMENT row goes red.
 *   `replaces: position === 'assignment'    — the append ignored; the APPEND row goes red.
 *     || position === 'operand'`
 *   `mayVanish = false`                    — the UNDECIDABLE rows go red: each reads as a prefix.
 *   `mayVanish = pending.length > 0`       — the four rows below them go red instead: a quoted or
 *                                            part-literal command word reads as one that may not
 *                                            be there.
 * The last one leaves the census test below still green on its own, because appendedTo bars an
 * appended name there as well; dropping BOTH guards is what turns that row red, and that was run
 * too. Belt and braces, said out loud rather than left to look like one guard.
 */
test('[o3d-secops] the assignment reader says which words REPLACE a name and which only look like it', (t) => {
  const bashLeaves = (form: string): string => {
    const dir = createTempDirSync('ims-secops-replaces-', t)
    const file = join(dir, 'subject.sh')
    writeFileSync(file, `f() {\n  local ref=SOMETHING_UNTRACKED\n  ${form}\n  printf '%s' "\${ref}"\n}\nf\n`)
    const run = spawnSync('bash', [file], { encoding: 'utf8' })
    assert.equal(run.status, 0, `bash must accept ${JSON.stringify(form)}: ${run.stderr}`)
    return run.stdout
  }
  const read = (form: string, name = 'ref'): { position: string; replaces: boolean } => {
    const found = shellAssignments(`${form}\n`, 'a fixture').filter((entry) => entry.name === name)
    assert.equal(found.length, 1, `exactly one \`${name}\` word in ${JSON.stringify(form)}`)
    return { position: found[0].position, replaces: found[0].replaces }
  }

  // THE THREE THAT DO NOT REPLACE. `ref` must come back as the value it already had.
  const NOT_REPLACED: ReadonlyArray<readonly [string, string, string]> = [
    ['ref+=DB_FENCE_PROBE_REASON', 'SOMETHING_UNTRACKEDDB_FENCE_PROBE_REASON', 'assignment'],
    ['ref=DB_FENCE_PROBE_REASON true', 'SOMETHING_UNTRACKED', 'prefix'],
    ['echo ref=DB_FENCE_PROBE_REASON >/dev/null', 'SOMETHING_UNTRACKED', 'argument'],
  ]
  for (const [form, leaves, position] of NOT_REPLACED) {
    assert.equal(bashLeaves(form), leaves,
      `bash must leave ref as ${leaves} after ${JSON.stringify(form)}, or this test is about a typo`)
    assert.deepEqual(read(form), { position, replaces: false }, `shellAssignments() on ${JSON.stringify(form)}`)
  }

  // AND THE ONES THAT DO, or the rule above is "nothing assigns" wearing a costume.
  const REPLACED: ReadonlyArray<readonly [string, string]> = [
    ['ref=DB_FENCE_PROBE_REASON', 'assignment'],
    ['ref=DB_FENCE_PROBE_REASON; true', 'assignment'],
    ['local ref=DB_FENCE_PROBE_REASON', 'operand'],
    ['declare ref=DB_FENCE_PROBE_REASON', 'operand'],
    ['export ref=DB_FENCE_PROBE_REASON', 'operand'],
    ['readonly ref=DB_FENCE_PROBE_REASON', 'operand'],
    ['typeset -r ref=DB_FENCE_PROBE_REASON', 'operand'],
    ['declare -- ref=DB_FENC"E_PROBE_REASON"', 'operand'],
    ['local scratch=/tmp/keep ref=DB_FENCE_PROBE_REASON', 'operand'],
    ['ref=DB_FENCE_PROBE_REASON >/dev/null', 'assignment'],
  ]
  for (const [form, position] of REPLACED) {
    assert.equal(bashLeaves(form), 'DB_FENCE_PROBE_REASON',
      `bash must really replace ref from ${JSON.stringify(form)}`)
    assert.deepEqual(read(form), { position, replaces: true }, `shellAssignments() on ${JSON.stringify(form)}`)
  }

  // AND THE SHAPE THAT HAS NO STATIC ANSWER: a prefix run whose command word is nothing but an
  // unquoted expansion. Bash decides AFTER expanding, so the same spelling gives both answers, and
  // both are run here — an empty substitution makes the word vanish and the assignment stands; a
  // non-empty one makes it a prefix. A reader that picked either would be wrong half the time, so
  // this one reports `undecidable` and the census refuses on it.
  const decided = createTempDirSync('ims-secops-vanish-', t)
  const both = join(decided, 'subject.sh')
  writeFileSync(both,
    'pick_empty() { :; }\npick_word() { printf true; }\n'
    + 'f() { local ref=SOMETHING_UNTRACKED; ref=DB_FENCE_PROBE_REASON $(pick_empty); printf \'%s|\' "${ref}"; }\n'
    + 'g() { local ref=SOMETHING_UNTRACKED; ref=DB_FENCE_PROBE_REASON $(pick_word); printf \'%s\' "${ref}"; }\nf; g\n')
  const decidedRun = spawnSync('bash', [both], { encoding: 'utf8' })
  assert.equal(decidedRun.status, 0, decidedRun.stderr)
  assert.equal(decidedRun.stdout, 'DB_FENCE_PROBE_REASON|SOMETHING_UNTRACKED',
    'one spelling, two answers: an empty command word vanishes and the assignment stands; a real one makes it a prefix')
  for (const form of [
    'ref=DB_FENCE_PROBE_REASON $(pick)',
    'ref=DB_FENCE_PROBE_REASON $(pick a)',
    'ref=DB_FENCE_PROBE_REASON `pick`',
    'ref=DB_FENCE_PROBE_REASON ${cmd}',
    'ref=DB_FENCE_PROBE_REASON $cmd',
  ]) assert.deepEqual(read(form), { position: 'undecidable', replaces: false }, `shellAssignments() on ${JSON.stringify(form)}`)

  // AND ONE LITERAL BYTE, OR ANY QUOTING AT ALL, SETTLES IT: `""` is a word however empty, so the
  // command word is there whatever it expands to and the assignment really is only its environment.
  for (const form of [
    'ref=DB_FENCE_PROBE_REASON "$(pick)"',
    'ref=DB_FENCE_PROBE_REASON "${cmd}"',
    'ref=DB_FENCE_PROBE_REASON ${cmd}x',
    'ref=DB_FENCE_PROBE_REASON $(pick)/x',
  ]) assert.deepEqual(read(form), { position: 'prefix', replaces: false }, `shellAssignments() on ${JSON.stringify(form)}`)

  // AND A SUBSTITUTION IN THE VALUE IS NOT A COMMAND WORD, or the rule above would read every
  // `x="$(…)"` in the estate as a prefix. Measured: it reads none of them that way.
  for (const form of ['x="$(f a)"', 'x=`f a`', 'x=$(f a)']) {
    assert.deepEqual(read(form, 'x'), { position: 'assignment', replaces: true }, `shellAssignments() on ${JSON.stringify(form)}`)
  }

  // THE COMMAND PREFIX ON A FUNCTION, WHICH IS THE ONE THING THIS DOES NOT MODEL, ASSERTED RATHER
  // THAN LEFT IN A COMMENT. Inside the called function the prefix IS visible; after it returns the
  // name is unset. It is still not a replacement of a shell variable, so it is still `prefix` —
  // a caller that needs a function's view of its caller's prefix has to model the call.
  const dir = createTempDirSync('ims-secops-prefix-', t)
  const file = join(dir, 'subject.sh')
  writeFileSync(file, 'g() { printf \'%s|\' "${refA-<unset>}"; }\nrefA=DB_FENCE_PROBE_REASON g\nprintf \'%s\' "${refA-<unset>}"\n')
  const run = spawnSync('bash', [file], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stdout, 'DB_FENCE_PROBE_REASON|<unset>',
    'a command prefix is visible inside the called function and gone after it')
  assert.deepEqual(read('refA=DB_FENCE_PROBE_REASON g', 'refA'), { position: 'prefix', replaces: false },
    'and it is reported as the prefix it is')
})

/**
 * WHAT VALUE A WORD GIVES A NAME, READ WHOLE OR REFUSED (o3d-secops r6, Codex HIGH).
 *
 * The alias reader accepted a bare identifier, or one wrapped in a single matching pair of quotes.
 * Bash does not read words that way: it removes quotes and CONCATENATES adjacent fragments, so
 * `DB_FENCE_PROBE_"REASON"` is one word whose value is `DB_FENCE_PROBE_REASON`. Every spelling
 * below is run under a real bash first and its value asserted, because a rule aimed at a form bash
 * does not accept is a rule about a typo — and then shellWordLiteral() is required to give the same
 * answer.
 *
 * AND WHAT IT WILL NOT GUESS. A parameter expansion or a command substitution makes the value a
 * RUNTIME value; the reader returns `unstatic` with only the fragments that ARE determined, so the
 * caller can still rule out what those already make impossible — a `/` or a space is in no
 * identifier. That is what keeps `"${dir}/file"` from being refused while
 * `"DB_FENCE_PROBE_${which}"` is.
 *
 * ROUTE: shellWordLiteral() on each word, against bash's own value for the same bytes.
 *
 * MUTATION: delete the double-quote branch so a `"` is an ordinary literal byte and every
 * concatenated row goes red; make the `$` branch append `'$'` instead of recording `why` and every
 * `unstatic` row goes red. Both edits were made and this test run under each.
 */
test('[o3d-secops] a shell word is evaluated whole, and what cannot be evaluated is refused', (t) => {
  const bashValue = (word: string): string => {
    const dir = createTempDirSync('ims-secops-word-', t)
    const file = join(dir, 'subject.sh')
    writeFileSync(file, `ref=${word}\nprintf '%s' "\${ref}"\n`)
    const run = spawnSync('bash', [file], { encoding: 'utf8' })
    assert.equal(run.status, 0, `bash must accept ref=${word}: ${run.stderr}`)
    return run.stdout
  }

  // ONE VALUE, MANY SPELLINGS. bash says so, then the reader must.
  for (const word of [
    'DB_FENCE_PROBE_REASON',
    '"DB_FENCE_PROBE_REASON"',
    "'DB_FENCE_PROBE_REASON'",
    'DB_FENCE_PROBE_"REASON"',
    'DB_FENC"E_PROBE_REASON"',
    '"DB_FENCE"_PROBE\'_REASON\'',
    'DB_FENCE_PROBE_REASO\\N',
    '""DB_FENCE_PROBE_REASON""',
    "$'DB_FENCE_PROBE_REASON'",
  ]) {
    assert.equal(bashValue(word), 'DB_FENCE_PROBE_REASON',
      `bash must really assign DB_FENCE_PROBE_REASON from ${JSON.stringify(word)}`)
    assert.deepEqual(shellWordLiteral(word), { kind: 'literal', value: 'DB_FENCE_PROBE_REASON' },
      `shellWordLiteral() on ${JSON.stringify(word)}`)
  }

  // AND VALUES THAT ARE READ WHOLE AND ARE SIMPLY NOT NAMES.
  for (const [word, value] of [['/tmp/x', '/tmp/x'], ['a\\ b', 'a b'], ["'a b'", 'a b']] as const) {
    assert.equal(bashValue(word), value, `bash on ${JSON.stringify(word)}`)
    assert.deepEqual(shellWordLiteral(word), { kind: 'literal', value }, `shellWordLiteral() on ${JSON.stringify(word)}`)
  }

  // WHAT IS NOT DETERMINED BY THE SOURCE. Each is asserted on `kind` AND on the fragments it did
  // determine, because the fragments are what the caller rules a name out with.
  const unstatic: ReadonlyArray<readonly [string, string]> = [
    ['"${x}"', ''],
    ['$1', ''],
    ['"$(pick)"', ''],
    ['`pick`', ''],
    ['"DB_FENCE_PROBE_${which}"', 'DB_FENCE_PROBE_'],
    ['DB_FENCE_$(pick)', 'DB_FENCE_'],
    ['"${dir}/file"', '/file'],
    // A WORD SHELLASSIGNMENTS() CUT SHORT AT A QUOTED SPACE. The space is recovered into the
    // fragments, where it says the one thing that matters: this is not one bare identifier.
    ['"DB_FENCE_PROBE_REASON', 'DB_FENCE_PROBE_REASON '],
    // A TRUNCATION INSIDE A SUBSTITUTION CARRIES NO SUCH FACT: that space never reaches the value.
    ['"$(pick', ''],
  ]
  for (const [word, literal] of unstatic) {
    const read = shellWordLiteral(word)
    assert.equal(read.kind, 'unstatic', `${JSON.stringify(word)} is not determined by the source: ${JSON.stringify(read)}`)
    assert.equal(read.kind === 'unstatic' ? read.literal : '', literal, `the determined fragments of ${JSON.stringify(word)}`)
  }
})

/**
 * AND THE SAME TWO FACTS AT THE CENSUS, WHERE THEY DECIDE WHETHER A FINDING IS PRODUCED
 * (o3d-secops r6, Codex HIGH x2).
 *
 * The two halves are one question — what NAME does this assignment give? — and getting it wrong in
 * either direction is a SILENCE:
 *
 *   A FALSE ALIAS suppresses. `ref` promoted into the report set on the strength of an append, a
 *   command prefix or an argument makes `[[ -n "${ref}" && -n "${A_REPORT}" ]]` a test of reports
 *   only, and the conditional rule stays silent about what is an authorization gate.
 *
 *   A MISSED ALIAS evades. `ref=DB_FENC"E_PROBE_REASON"` is a real alias in ordinary shell syntax;
 *   unfollowed, the `${!ref}` two lines later carries no report on its statement and is skipped
 *   rather than refused.
 *
 * ROUTE: reportSinkComplaints() with each plant appended to scripts/deploy.sh — an entrypoint,
 * which is where the indirection refusal is SCOPED by the statement rather than unconditional, so a
 * missed alias really does produce nothing there.
 *
 * MUTATION, each edit made and this test run under it:
 *   drop `if (!held.replaces) continue`     — the PREFIX row goes red: `ref` is promoted and the
 *                                             gate falls silent. With the append filter and
 *                                             appendedTo both dropped the APPEND row goes red the
 *                                             same way, and with a post-command argument
 *                                             classified as a declaration operand, the ARGUMENT
 *                                             row does.
 *   restore the r5 reader                   — the CONCATENATED row goes red: the alias is not
 *     `/^(?:(N)|"(N)"|'(N)')$/`               followed, so the `${!ref}` it feeds is skipped.
 *   drop the quoting veto in                — the same row goes red for the other half of the
 *     classifyAssignmentPositions()           reason: `"DB_FENCE"_PROBE'_REASON'` reads as two
 *                                             words and the assignment is demoted to a prefix.
 *   make aliasedName() return `settled`     — the ASSEMBLED-NAME row goes red: nothing is refused.
 *     where it returns `refuse`
 *   `mayVanish = false`, and separately    — the UNDECIDABLE rows go red: the first reads the
 *     dropping the undecidable refusal        position as a settled prefix, the second reads it
 *                                             right and then says nothing about it.
 */
test('[o3d-secops] a false alias does not silence a conditional, and a concatenated one is still followed', () => {
  const DEPLOY_INDEX = 1 + ENTRYPOINTS.indexOf('scripts/deploy.sh')
  const plantedInDeploy = (text: string): ReturnType<typeof reportSinkComplaints> => reportSinkComplaints(
    SINK_CENSUS_SOURCES.map((entry, index) =>
      (index === DEPLOY_INDEX ? [entry[0], `${entry[1]}\n${text}\n`] as const : entry)),
    Object.keys(MUTABLE_LIBRARY_NAMES))

  // THE GATE THE FALSE ALIAS WOULD HAVE BOUGHT SILENCE ON. `ref` is given a value that is not a
  // report first, so each shape below is asked to change an answer that is already settled.
  const GATE = '[[ -n "${ref}" && -n "${DB_FENCE_PROBE_REASON}" ]] && exit 1'
  const NOT_A_REPORT = 'ref=SOMETHING_UNTRACKED'

  for (const [shape, form] of [
    ['an append', 'ref+=DB_FENCE_PROBE_REASON'],
    ['a command prefix', 'ref=DB_FENCE_PROBE_REASON true'],
    ['an argument after an ordinary command', 'echo ref=DB_FENCE_PROBE_REASON'],
  ] as ReadonlyArray<readonly [string, string]>) {
    const planted = plantedInDeploy(`${NOT_A_REPORT}\n${form}\n${GATE}`)
    assert.ok(!planted.followed.some((entry) => entry.startsWith('ref ')),
      `${shape} must not make \`ref\` an alias; it followed: ${planted.followed.join(', ')}`)
    assert.equal(planted.complaints.length, 1,
      `${shape} must leave the gate complained about and add nothing else:\n${planted.complaints.join('\n')}`)
    assert.match(planted.complaints[0], /tests DB_FENCE_PROBE_REASON alongside something that is not another report/,
      planted.complaints[0])
  }

  // NOT VACUOUS: the SAME gate, after a real replacement, IS silenced. Without this the three
  // assertions above would pass just as well against a census that had stopped following aliases —
  // which is the other half of this round's finding.
  const silenced = plantedInDeploy(`${NOT_A_REPORT}\nref=DB_FENCE_PROBE_REASON\n${GATE}`)
  assert.deepEqual(silenced.complaints, [],
    `a real alias must still make the gate a test of reports only:\n${silenced.complaints.join('\n')}`)
  assert.ok(silenced.followed.some((entry) => entry.startsWith('ref (holds the NAME DB_FENCE_PROBE_REASON')),
    `and it must be followed to do that; it followed: ${silenced.followed.join(', ')}`)

  // THE REAL ALIAS THAT EVADED: one literal value, spelt across a quote boundary, then read back
  // through an indirect expansion in an entrypoint. The refusal there is scoped by the statement,
  // so this is only refused BECAUSE the alias was followed.
  for (const spelling of ['DB_FENC"E_PROBE_REASON"', 'DB_FENCE_PROBE_"REASON"', '"DB_FENCE"_PROBE\'_REASON\'', 'DB_FENCE_PROBE_REASO\\N']) {
    const concatenated = plantedInDeploy(`ref=${spelling}\nnode "\${!ref}"`)
    assert.ok(concatenated.followed.some((entry) => entry.startsWith('ref (holds the NAME DB_FENCE_PROBE_REASON')),
      `${spelling} is one word whose value is DB_FENCE_PROBE_REASON and must be followed; it followed: ${concatenated.followed.join(', ')}`)
    assert.equal(concatenated.complaints.length, 1,
      `and the indirection it feeds must be the one complaint:\n${concatenated.complaints.join('\n')}`)
    assert.match(concatenated.complaints[0], /uses an indirect expansion/, concatenated.complaints[0])
  }

  // AND A NAME BEING ASSEMBLED OUT OF SOURCE TEXT IS REFUSED, not skipped. This is the shape the
  // canonicalisation above cannot finish: literal NAME text plus a value decided at runtime.
  for (const word of ['"DB_FENCE_PROBE_${which}"', 'DB_FENCE_PROBE_$(pick)', 'DB_FENCE_PROBE_$suffix']) {
    const assembled = plantedInDeploy(`ref=${word}\nnode "\${!ref}"`)
    assert.equal(assembled.complaints.length, 1, `${word}:\n${assembled.complaints.join('\n')}`)
    assert.match(assembled.complaints[0], /assembles a NAME out of source text/, assembled.complaints[0])
  }

  // AND THE FOURTH SHAPE, WHICH IS NOT A FALSE ALIAS BUT NO ANSWER AT ALL. `$(pick)` decides at
  // runtime whether there is a command word here, and so whether `ref` keeps the report's name.
  for (const word of ['$(pick)', '`pick`', '${cmd}', '$cmd']) {
    const undecided = plantedInDeploy(`ref=DB_FENCE_PROBE_REASON ${word}\nnode "\${!ref}"`)
    assert.ok(!undecided.followed.some((entry) => entry.startsWith('ref ')),
      `${word} must not be followed as an alias; it followed: ${undecided.followed.join(', ')}`)
    assert.equal(undecided.complaints.length, 1, `${word}:\n${undecided.complaints.join('\n')}`)
    assert.match(undecided.complaints[0], /decided at RUNTIME/, undecided.complaints[0])
  }

  // AND THE SAME POSITION WITH A VALUE THAT IS NOT A REPORT'S NAME IS NOT REFUSED, or the rule
  // above is "no assignment may precede an expansion" — which would be red on the shipped tree and
  // is not: the estate has 1821 bare assignments, 447 declaration operands, 21 command prefixes,
  // 97 arguments and NOT ONE undecidable position.
  const harmless = plantedInDeploy('ref=/tmp/keep $(pick)')
  assert.deepEqual(harmless.complaints, [], harmless.complaints.join('\n'))

  // AND A RUNTIME VALUE WITH NO LITERAL NAME TEXT IS NOT REFUSED, or the rule above is "no
  // assignment may expand anything" — which would be red on the shipped tree and is not. These are
  // COPIES, and a copy is carried by the walk's own assignment rule rather than this one.
  for (const word of ['"$1"', '"${x}"', '"$(pick)"', '"${dir}/file"', '"DB_FENCE_PROBE_REASON extra"']) {
    const copy = plantedInDeploy(`ref=${word}`)
    assert.deepEqual(copy.complaints, [], `a copy must not be refused: ref=${word}\n${copy.complaints.join('\n')}`)
  }
})

test('[o3d-secops] `eval` and an indirect `read` are BOTH refused and named at a sink', () => {
  // These two get their own case because each produces TWO complaints and both are the point: the
  // shape is refused (the census cannot read what `eval` re-parses, nor which variable a `read`
  // into an expansion writes) AND the report is separately named where it stands — `eval` is in
  // SINK_KIND's EXECUTION list, and `read` is in no list at all, so it falls through to "a command
  // position", which is the grammar rule doing its job on a word nobody wrote down. A
  // single-complaint fixture would have had to pick one and would have hidden the other.
  const cases: ReadonlyArray<readonly [string, RegExp, RegExp]> = [
    ['eval "node \${DB_FENCE_PROBE_REASON}"', /uses `eval`/, /reaches EXECUTION with DB_FENCE_PROBE_REASON/],
    ['read "$target" <<<"\${DB_FENCE_SEAL_REASON}"', /uses a `read` target/, /reaches a command position .* with DB_FENCE_SEAL_REASON/],
  ]
  for (const [addition, refusal, sink] of cases) {
    const { complaints } = reportSinkComplaints(
      [[FENCE_LIBRARY, `${FENCE_LIB}\n${addition}\n`], ...SINK_CENSUS_SOURCES.slice(1)],
      Object.keys(MUTABLE_LIBRARY_NAMES))
    assert.equal(complaints.length, 2, `${addition}\n${complaints.join('\n')}`)
    assert.ok(complaints.some((complaint) => refusal.test(complaint)),
      `the refusal must be one of them, for ${addition}:\n${complaints.join('\n')}`)
    assert.ok(complaints.some((complaint) => sink.test(complaint)),
      `and the sink the other, for ${addition}:\n${complaints.join('\n')}`)
  }
})

/**
 * AND THE SAME RULE OVER BASH'S OWN PARSE (o3d-secops r4).
 *
 * Codex's third next-step: an earlier round on this branch established that `bash --pretty-print`
 * parses and deparses a script without executing it, and used it to cross-check the function
 * scanner. It can carry some of this too, and this test says exactly how much.
 *
 * WHAT IT SETTLES. The census reads LINE BY LINE, and a line is not a command. `bash --pretty-print`
 * hands back one command per line: a backslash-continued header is joined, `if …; then X; fi` is
 * split across lines, and comments are gone. That closes a real blind spot, measured rather than
 * asserted — the fixture below is
 *
 *     node --preflight \
 *       "${DB_FENCE_PROBE_REASON}"
 *
 * on which the line-by-line reading is SILENT (the second line is a quoted string and nothing else,
 * which is the shape of a continued `die "…"` argument, so isContinuedString() lets it past) and
 * the deparsed reading names it as EXECUTION. Nobody listed that shape; it fell out of running the
 * rule over a second reading of the same file.
 *
 * WHAT IT DOES NOT SETTLE, AND WHY REFUSAL IS STILL THE ANSWER FOR INDIRECTION. The deparse renders
 * `${!c}`, `declare -n r="$1"` and `printf -v "$t"` back out VERBATIM — bash's parser records that
 * a name is computed, it does not compute it, because the value only exists at run time. Asserted
 * below on a fixture, because "the parser cannot help here" is exactly the sort of claim that turns
 * out to be false and takes a guard down with it. `eval` is the same, and the r6 test above already
 * measures that the deparse hands an eval'd definition back as the string it went in as.
 *
 * ROUTE: reportSinkComplaints() over `bash --pretty-print` output for the library and all three
 * entrypoints, with the same seeds as the primary census.
 */
function deparseShell(text: string, t: TestContext): string {
  const dir = createTempDirSync('ims-secops-deparse-', t)
  const file = join(dir, 'subject.sh')
  writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`)
  const run = spawnSync('bash', ['--pretty-print', file], { encoding: 'utf8' })
  assert.equal(run.status, 0, `bash must parse the subject before it can be deparsed: ${run.stderr}`)
  return run.stdout
}

test("[o3d-secops] the sink census is clean under bash's own parse too, and catches what line-by-line misses", (t) => {
  const deparsed = (extra = ''): ReadonlyArray<readonly [string, string]> => SINK_CENSUS_SOURCES.map(
    ([file, source]) => [`${file} (deparsed)`, deparseShell(file === FENCE_LIBRARY && extra ? `${source}\n${extra}\n` : source, t)] as const)
  const library = `${FENCE_LIBRARY} (deparsed)`

  // THE CLAIM: the second reading agrees with the first. It examines the same 63 expansions, so
  // this is a genuine second reading of the same estate and not a deparse that lost the file.
  const clean = reportSinkComplaints(deparsed(), Object.keys(MUTABLE_LIBRARY_NAMES), library)
  assert.deepEqual(clean.complaints, [], clean.complaints.join('\n'))
  assert.ok(clean.examined >= 60,
    `the deparsed reading must reach the same sinks; it examined ${clean.examined} expansions`)

  // AND WHAT THE FIRST READING MISSES, BOTH HALVES MEASURED. If the raw reading ever starts
  // catching this, this test stops proving that the deparse adds anything and must be re-argued.
  const continued = 'node --preflight \\\n  "${DB_FENCE_PROBE_REASON}"'
  const raw = reportSinkComplaints(
    [[FENCE_LIBRARY, `${FENCE_LIB}\n${continued}\n`], ...SINK_CENSUS_SOURCES.slice(1)],
    Object.keys(MUTABLE_LIBRARY_NAMES))
  assert.deepEqual(raw.complaints, [],
    'precondition: the line-by-line reading is silent on a backslash-continued command word')
  const joined = reportSinkComplaints(deparsed(continued), Object.keys(MUTABLE_LIBRARY_NAMES), library)
  assert.equal(joined.complaints.length, 1, joined.complaints.join('\n'))
  assert.match(joined.complaints[0], /reaches EXECUTION with DB_FENCE_PROBE_REASON/, joined.complaints[0])

  // AND THE PARSER DOES NOT RESOLVE INDIRECTION, so refusing it is the honest answer and not a
  // shortcut. The deparse carries the construct back out unchanged, and the census refuses on both
  // readings rather than one of them quietly answering.
  const indirect = 'node "${!DB_FENCE_PROBE_REASON}"'
  assert.match(deparseShell(indirect, t), /node "\$\{!DB_FENCE_PROBE_REASON\}"/,
    "bash's parse must hand the indirect expansion back verbatim — if it ever resolves one, this "
    + 'refusal can become a resolution')
  const refusedTwice = [
    reportSinkComplaints([[FENCE_LIBRARY, `${FENCE_LIB}\n${indirect}\n`], ...SINK_CENSUS_SOURCES.slice(1)],
      Object.keys(MUTABLE_LIBRARY_NAMES)),
    reportSinkComplaints(deparsed(indirect), Object.keys(MUTABLE_LIBRARY_NAMES), library),
  ]
  for (const { complaints } of refusedTwice) {
    assert.equal(complaints.length, 1, complaints.join('\n'))
    assert.match(complaints[0], /uses an indirect expansion/, complaints[0])
  }
})

/**
 * AND THE SAME REFUSAL IN AN ENTRYPOINT, WHERE IT IS THE STATEMENT THAT TRIGGERS IT (o3d-secops r4).
 *
 * The fence library is refused unconditionally because it is the file that DECLARES these names.
 * The three entrypoints cannot be: scripts/install.sh legitimately uses `local -n` and `${!name}`
 * in prompt(), capture() and libpq_env_unset_args(), where the name comes from `$1` or from a
 * `read` of a computed list, and refusing those would make this census red on the shipped tree and
 * therefore worthless. So there the refusal is a rule about ONE COMMAND: an unresolvable shape in a
 * segment that mentions a report, or whose controller IS a report.
 *
 * WHICH MAKES THE ALIAS RULE LOAD-BEARING HERE AND NOWHERE ELSE. `ref=DB_FENCE_PROBE_REASON` puts a
 * report's NAME into `ref`; `node "${!ref}"` is a different statement, mentions no report, and is
 * in a file where refusal is not unconditional. Without the whole-right-hand-side alias rule it
 * passes. (Verified by disabling that rule: every other test in this file still passed.)
 *
 * AND THE LIMIT IS ASSERTED, NOT ASSUMED. The third case below is an indirection in an entrypoint
 * with no report anywhere near it, and it is NOT refused. That is the honest edge of this rule: an
 * indirection whose controller is built from argv, the environment or a command substitution is
 * outside what a lexical census can answer, and what closes it instead is that the library — the
 * only file that derives these values — refuses every such shape outright.
 *
 * ROUTE: reportSinkComplaints() with the addition appended to scripts/deploy.sh, which is where an
 * operator or a compromised checkout would put one.
 */
test('[o3d-secops] a report renamed into a VARIABLE NAME inside an entrypoint is refused too', () => {
  const DEPLOY_INDEX = SINK_CENSUS_SOURCES.findIndex(([file]) => file === 'scripts/deploy.sh')
  assert.ok(DEPLOY_INDEX > 0, 'precondition: the census must be walking scripts/deploy.sh')
  const withAddition = (addition: string): ReadonlyArray<readonly [string, string]> =>
    SINK_CENSUS_SOURCES.map((pair, index) => index === DEPLOY_INDEX ? [pair[0], `${pair[1]}\n${addition}\n`] as const : pair)

  for (const [addition, expected] of [
    // The alias: the report's NAME is the whole right-hand side, so `ref` IS the report as far as
    // `${!ref}` is concerned — in a statement that mentions no report at all.
    ['ref=DB_FENCE_PROBE_REASON\nnode "${!ref}"', /uses an indirect expansion/],
    // And an unresolvable WRITE on a statement that does mention one.
    ['printf -v "$t" \'%s\' "${DB_FENCE_SEAL_REASON}"', /uses `printf -v`/],
    ['declare -n alias_ref="${DB_FENCE_SEAL_REASON}"', /uses a nameref declaration/],
  ] as ReadonlyArray<readonly [string, RegExp]>) {
    const { complaints } = reportSinkComplaints(withAddition(addition), Object.keys(MUTABLE_LIBRARY_NAMES))
    assert.ok(complaints.some((complaint) => expected.test(complaint)),
      `the entrypoint refusal must fire for: ${addition}\n${complaints.join('\n')}`)
  }

  // THE STATED LIMIT, MEASURED. No report on the statement, no report in the controller, not the
  // library: not refused. If this ever starts failing, the rule has become stricter than the
  // paragraph above claims and install.sh's own helpers are about to go red.
  const { complaints } = reportSinkComplaints(
    withAddition('node "${!some_unrelated_controller}"'), Object.keys(MUTABLE_LIBRARY_NAMES))
  assert.deepEqual(complaints, [], complaints.join('\n'))
})

/**
 * THE HISTORICAL MEASUREMENT, AS A TEST RATHER THAN A SENTENCE (o3d-secops r4).
 *
 * Every round of this rule has been justified by "it was run over b128f47f and named exactly the
 * seven" — a claim in a comment, which is worth nothing once the rule changes. This round changed
 * the rule twice (casing, indirection), so the measurement is made standing: the four shell files
 * are read out of git at b128f47f, seeded with b128f47f's own twelve-name classification, and the
 * verdict is asserted.
 *
 * IT MUST STILL NAME EXACTLY THOSE SEVEN — a broadened rule that also started naming an eighth
 * would be a rule that has drifted from the defect it was measured against.
 *
 * AND IT MUST NOW CATCH ONE MORE THING THAN IT DID: a report laundered through a lowercase `local`,
 * PLANTED in that same tree. Under the r3 rule that plant produced nothing; under this one it is
 * the tenth complaint.
 *
 * R5 ADDS TWO MORE PLANTS FOR THE SAME REASON — `declare ref=NAME` and a second operand of one
 * `local` — because the alias rule stopped being a regex over enumerated prefixes this round and
 * became the same word rule shellConstantAssignments() uses. A rule change that is not re-measured
 * against b128f47f is a rule that has quietly stopped being the one that was measured; the count is
 * still exactly nine there, and each plant is still exactly the tenth.
 */
const B128F47F = 'b128f47f'

/** b128f47f's own MUTABLE_LIBRARY_NAMES — twelve names, seven of which were not reports. */
const B128F47F_MUTABLE = [
  'DB_FENCE_ROTATION_NOTE', 'DB_FENCE_SEAL_REASON', 'DB_FENCE_PROBE_SCRIPT', 'DB_FENCE_PROBE_TEMP',
  'DB_FENCE_PROBE_ARTEFACT_SHA256', 'DB_FENCE_PROBE_STANDING_SHA256', 'DB_FENCE_PROBE_REASON',
  'DB_FENCE_SOURCE_UNTRUSTED_PATH', 'DB_FENCE_SUDO_PREFIX',
  '_FENCE_SRC_STRICT', '_FENCE_SRC_PACKAGES', '_FENCE_SRC_PARENTS',
] as const

/** The seven that were wrong, and which of the four sinks each reached. */
const B128F47F_MISCLASSIFIED = [
  'DB_FENCE_PROBE_SCRIPT', 'DB_FENCE_PROBE_TEMP', 'DB_FENCE_PROBE_ARTEFACT_SHA256',
  'DB_FENCE_SOURCE_UNTRUSTED_PATH', '_FENCE_SRC_STRICT', '_FENCE_SRC_PACKAGES', '_FENCE_SRC_PARENTS',
] as const

test('[o3d-secops] the sink census still names exactly the seven values b128f47f got wrong', () => {
  const historical = [FENCE_LIBRARY, ...ENTRYPOINTS].map((file) => {
    const show = spawnSync('git', ['show', `${B128F47F}:${file}`], { cwd: REPO, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    assert.equal(show.status, 0, `the historical tree must be readable: ${show.stderr}`)
    assert.ok(show.stdout.length > 1000, `${file} at ${B128F47F} came back empty`)
    return [file, show.stdout] as const
  })

  const { complaints, examined, followed } = reportSinkComplaints(historical, B128F47F_MUTABLE)

  // THE WALK REACHED THAT TREE, stated as a number, so a git-show that returned nothing cannot look
  // like a clean estate.
  assert.ok(examined >= 80, `the historical walk examined ${examined} expansions`)

  // EXACTLY THE SEVEN. Both directions: every one is named, and nothing else is.
  const named = new Set(complaints.flatMap((complaint) =>
    [...complaint.matchAll(/\b(DB_FENCE_[A-Z0-9_]+|_FENCE_SRC_[A-Z0-9_]+)\b/g)].map((match) => match[1]))
    .filter((name) => (B128F47F_MUTABLE as readonly string[]).includes(name)))
  assert.deepEqual([...named].sort(), [...B128F47F_MISCLASSIFIED].sort(),
    `the census must name exactly b128f47f's seven:\n${complaints.join('\n')}`)
  assert.equal(complaints.length, 9,
    `and produce the nine complaints that were measured:\n${complaints.join('\n')}`)

  // AND THE CASING FIX IS LIVE ON A REAL TREE, not only on a fixture: `offender` is a lowercase
  // `local` that b128f47f copies a report into, and the r3 rule refused to follow it because it was
  // not uppercase. It is followed here.
  assert.ok(followed.includes('offender (from scripts/lib/db-fence-protected.sh:705)'),
    `a lowercase local must be followed; it followed: ${followed.join(', ')}`)

  // THE PLANTED LAUNDER: the same tree, plus one report routed through a lowercase `local` into
  // `node`. Under the r3 rule this produced nothing at all.
  const plantedInLibrary = (text: string): ReturnType<typeof reportSinkComplaints> => reportSinkComplaints(
    [[FENCE_LIBRARY, `${historical[0][1]}\n${text}\n`], ...historical.slice(1)], B128F47F_MUTABLE)
  const withPlant = plantedInLibrary('local laundered_reason="${DB_FENCE_PROBE_REASON}"\nnode "${laundered_reason}" --preflight')
  assert.equal(withPlant.complaints.length, 10,
    `the plant must be the tenth complaint and nothing else:\n${withPlant.complaints.join('\n')}`)
  assert.ok(withPlant.complaints.some((complaint) => /reaches EXECUTION with laundered_reason/.test(complaint)),
    withPlant.complaints.join('\n'))

  // AND THE TWO ALIAS FORMS THE R4 REGEX COULD NOT READ, PLANTED IN THAT SAME TREE (r5).
  //
  // Each is the ordinary alias — a report's NAME as the WHOLE right-hand side — written in a form
  // `(?:local |export |readonly |declare [^ ]+ )*NAME=(\S*)\s*$` could not reach: a `declare` with
  // no option word for `declare [^ ]+ ` to eat, and a SECOND operand past the `$` the regex
  // anchored on. NEITHER LINE EXPANDS ANYTHING, so nothing else in the census could have followed
  // them either — under r4 both of these trees came back at nine complaints and the `rm -rf` two
  // lines later was a delete of a name the census had never heard of. The FOLLOW is asserted as
  // well as the complaint, because it is the follow that is the fix.
  for (const [shape, text, sink, alias] of [
    ['a `declare` with no option word',
      'declare declared_alias=DB_FENCE_PROBE_REASON\nrm -rf "${declared_alias}"',
      /reaches DELETION with declared_alias/,
      'declared_alias (holds the NAME DB_FENCE_PROBE_REASON'],
    ['a second operand of one `local`',
      'local scratch=/tmp/keep operand_alias=DB_FENCE_PROBE_REASON\nrm -rf "${operand_alias}"',
      /reaches DELETION with operand_alias/,
      'operand_alias (holds the NAME DB_FENCE_PROBE_REASON'],
  ] as ReadonlyArray<readonly [string, string, RegExp, string]>) {
    const aliased = plantedInLibrary(text)
    assert.equal(aliased.complaints.length, 10,
      `${shape} must be the tenth complaint and nothing else:\n${aliased.complaints.join('\n')}`)
    assert.ok(aliased.complaints.some((complaint) => sink.test(complaint)),
      `${shape}:\n${aliased.complaints.join('\n')}`)
    assert.ok(aliased.followed.some((entry) => entry.startsWith(alias)),
      `${shape} must be FOLLOWED as an alias, which is what makes the sink visible; it followed: ${aliased.followed.join(', ')}`)
  }

  // AND AN INDIRECT EXPANSION IN THAT TREE IS REFUSED, not passed over.
  const indirect = plantedInLibrary('node "\${!DB_FENCE_PROBE_SCRIPT}"')
  assert.equal(indirect.complaints.length, 10, indirect.complaints.join('\n'))
  assert.ok(indirect.complaints.some((complaint) => /uses an indirect expansion/.test(complaint)),
    indirect.complaints.join('\n'))

  // R6 PLANTS THE ALIAS THE R5 READER COULD NOT SEE, IN THAT SAME TREE. One literal value spelt
  // across a quote boundary is one word to bash, and `declare` puts it in the report set; the `rm`
  // that follows is then a DELETION of a report. Under r5 this tree came back at nine and the
  // delete was of a name the census had never heard of.
  const concatenated = plantedInLibrary('declare concat_alias=DB_FENC"E_PROBE_REASON"\nrm -rf "${concat_alias}"')
  assert.equal(concatenated.complaints.length, 10,
    `a concatenated alias must be the tenth complaint and nothing else:\n${concatenated.complaints.join('\n')}`)
  assert.ok(concatenated.complaints.some((complaint) => /reaches DELETION with concat_alias/.test(complaint)),
    concatenated.complaints.join('\n'))
  assert.ok(concatenated.followed.some((entry) => entry.startsWith('concat_alias (holds the NAME DB_FENCE_PROBE_REASON')),
    `and it is the FOLLOW that makes the sink visible; it followed: ${concatenated.followed.join(', ')}`)

  // AND THE THREE THAT MUST NOT PROPAGATE, IN THAT SAME TREE, AGAINST A GATE THEY WOULD HAVE
  // SILENCED. `probe_alias` is given a value that is not a report first, so each shape below is
  // asked to change an answer that is already settled; the gate then tests it beside a real report.
  // Under r5 every one of these trees came back at NINE — the gate silenced by an invented alias.
  const GATE = '[[ -n "${probe_alias}" && -n "${DB_FENCE_PROBE_REASON}" ]] && exit 1'
  for (const [shape, form] of [
    ['an append', 'probe_alias+=DB_FENCE_PROBE_REASON'],
    ['a command prefix', 'probe_alias=DB_FENCE_PROBE_REASON true'],
    ['an argument after an ordinary command', 'echo probe_alias=DB_FENCE_PROBE_REASON'],
  ] as ReadonlyArray<readonly [string, string]>) {
    const planted = plantedInLibrary(`probe_alias=SOMETHING_UNTRACKED\n${form}\n${GATE}`)
    assert.ok(!planted.followed.some((entry) => entry.startsWith('probe_alias ')),
      `${shape} must not make probe_alias an alias; it followed: ${planted.followed.join(', ')}`)
    assert.equal(planted.complaints.length, 10,
      `${shape} must leave the gate as the tenth complaint:\n${planted.complaints.join('\n')}`)
    assert.ok(planted.complaints.some((complaint) =>
      /tests DB_FENCE_PROBE_REASON alongside something that is not another report/.test(complaint)),
    `${shape}:\n${planted.complaints.join('\n')}`)
  }

  // NOT VACUOUS: the SAME gate after a real replacement is back to nine, silenced — so the three
  // assertions above are the position rule talking and not a census that has stopped following.
  const silenced = plantedInLibrary(`probe_alias=SOMETHING_UNTRACKED\nprobe_alias=DB_FENCE_PROBE_REASON\n${GATE}`)
  assert.equal(silenced.complaints.length, 9,
    `a real alias must still silence the gate:\n${silenced.complaints.join('\n')}`)
  assert.ok(silenced.followed.some((entry) => entry.startsWith('probe_alias (holds the NAME DB_FENCE_PROBE_REASON')),
    `and it must be followed to do that; it followed: ${silenced.followed.join(', ')}`)
})

/**
 * AND THE ONE THING `readonly` IN A LIBRARY BREAKS: SOURCING IT TWICE (o3d-secops r2).
 *
 * A second `readonly NAME=` against a name that already has the word is an ERROR, not a no-op —
 * bash refuses the assignment and says `NAME: readonly variable`, and under `set -e` (which all
 * three entrypoints run with) that aborts the run. Before this round a second source was harmless,
 * so nothing measured it; it is now a way to break a cutover, and it is a one-line edit away.
 *
 * WHY THE ANSWER IS NOT A SOURCE GUARD. `[[ -n "${_DB_FENCE_LIB_SOURCED:-}" ]] && return 0` at the
 * top of the library would make a second source a no-op — and would also make setting one variable
 * in the environment skip the ENTIRE library, trust root and all, for the first source too. That is
 * a worse hole than the one it closes, in the file this round exists to protect. So the library
 * keeps refusing, and what is asserted is that nothing sources it twice.
 *
 * BOTH HALVES ARE MEASURED, because the static count alone would be a rule about text:
 *   PRECONDITION — one source of the shipped library runs clean and defines the constants.
 *   THE HAZARD    — a second source in the same shell fails, naming a protected constant. This is
 *                   the fact that makes the count below load-bearing rather than tidiness.
 *   THE CLAIM     — each entrypoint carries exactly one `source` of it.
 *
 * MUTATION: append a second `source "${IMS_SCRIPT_LIB_DIR}/db-fence-protected.sh"` to any
 * entrypoint and the count fails, naming the script. (Verified by making that edit to
 * scripts/update.sh and re-running.) Strip `readonly` from EVERY declaration in the library and the
 * HAZARD half fails instead — the second source stops complaining and exits 0. (Also verified; one
 * stripped declaration is not enough, because the other fifteen still refuse.)
 */
test('[o3d-secops] nothing sources the shared fence library twice, because a second source now refuses', () => {
  const library = join(REPO, FENCE_LIBRARY)

  // PRECONDITION: one source is clean, and the library really did declare something.
  const once = runBash([
    'set -euo pipefail',
    `source ${JSON.stringify(library)}`,
    'printf \'COPY=%s\\n\' "${DB_FENCE_SCRIPT_COPY}"',
  ].join('\n'))
  assert.equal(once.status, 0, `one source must run clean: ${once.stderr}`)
  assert.match(once.stdout, /^COPY=\/etc\/ims-cutover-recovery\/app\/scripts\//m, once.stdout)

  // THE HAZARD, DEMONSTRATED: the second source refuses, and says which name it refused.
  const twice = runBash([
    'set -euo pipefail',
    `source ${JSON.stringify(library)}`,
    `source ${JSON.stringify(library)}`,
    'echo REACHED',
  ].join('\n'))
  assert.notEqual(twice.status, 0, `a second source must not pass silently:\n${twice.stdout}${twice.stderr}`)
  assert.match(`${twice.stdout}${twice.stderr}`, /DB_FENCE_[A-Z_]+: readonly variable/,
    `and it must name a protected constant:\n${twice.stdout}${twice.stderr}`)
  assert.doesNotMatch(twice.stdout, /^REACHED$/m, 'and the shell must not carry on past it')

  // THE CLAIM: one source each, counted over code lines only — the prose names the file often.
  for (const script of ENTRYPOINTS) {
    const sourced = readFileSync(join(REPO, script), 'utf8').split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .filter((line) => /(^|[\s;&|(){}])(source|\.)\s+\S*db-fence-protected\.sh/.test(line))
    assert.equal(sourced.length, 1,
      `${script} must source ${FENCE_LIBRARY} exactly once — a second source aborts the run on a `
      + `\`readonly\` refusal, as demonstrated above:\n${sourced.join('\n')}`)
  }
})

test('[o3d-secops] a new library path declared next to the protected ones fails the census', () => {
  // NOT VACUOUS, AND IN BOTH DIRECTIONS. The unmodified library passes the census (the test above),
  // so the failures below are the appended declarations talking.
  //
  // ROUTE: each addition is a line bash really does execute as a script-scope declaration — proved
  // here by running it — of exactly the kind this round was about: a path under the recovery root,
  // an executable inside the protected tree, and a second digest record.
  const additions = [
    'readonly DB_FENCE_QUARANTINE_DIR="${DB_FENCE_RECOVERY_DIR}/.quarantine"',
    'DB_FENCE_SECOND_HELPER="${DB_FENCE_PROTECTED_APP_DIR}/scripts/also-run-this.mjs"',
    'readonly DB_FENCE_ARTEFACT_BACKUP="${DB_FENCE_RECOVERY_DIR}/db-fence-artefact.sha256.bak"',
  ]
  for (const addition of additions) {
    const name = /^(?:readonly )?([A-Z_][A-Z0-9_]*)=/.exec(addition)?.[1] ?? ''
    assert.match(name, /^DB_FENCE_/, `precondition: the fixture must declare a name: ${addition}`)

    // PRECONDITION — bash takes it as a declaration, so what the census must catch is a real one.
    const ran = runBash(['set -u', FENCE_LIB, addition, `printf 'VALUE=%s\\n' "\${${name}}"`].join('\n'))
    assert.equal(ran.status, 0, `precondition: the appended declaration must run: ${ran.stderr}`)
    assert.match(ran.stdout, /^VALUE=\/etc\/ims-cutover-recovery\//m,
      `precondition: it must resolve to a real path under the recovery root: ${ran.stdout}`)

    // THE CLAIM — the census names it, and says which decision has to be made about it.
    const complaints = unclassifiedLibraryNames(`${FENCE_LIB}\n${addition}\n`, FENCE_LIBRARY)
    assert.equal(complaints.length, 1, `the census must name exactly the new declaration:\n${complaints.join('\n')}`)
    assert.match(complaints[0], new RegExp(`declares ${name} and nothing here says what it is`), complaints[0])
    assert.match(complaints[0], /PROTECTED_LIBRARY_CONSTANTS/, 'and say what to do about it')
  }

  // AND A DECLARATION THAT DISAPPEARS FAILS TOO, so the census is an equality and not a subset: a
  // list that still claims a name the library has stopped declaring is a list nobody has read.
  const removed = FENCE_LIB.replace(/^readonly DB_FENCE_RETIRED_APP_DIR=.*$/m, '')
  assert.notEqual(removed, FENCE_LIB, 'precondition: the declaration this deletes must exist')
  const orphaned = unclassifiedLibraryNames(removed, FENCE_LIBRARY)
  assert.equal(orphaned.length, 1, orphaned.join('\n'))
  assert.match(orphaned[0], /no longer declares DB_FENCE_RETIRED_APP_DIR/, orphaned[0])
})

/**
 * AND THE COMMAND POSITIONS THE LIST DID NOT HAVE (o3d-rn10 r6, Codex MEDIUM — the THIRD round on
 * this one guard).
 *
 * r5 replaced an end-of-line anchor with a list of things a definition may follow — `;`, `&`, `|`,
 * `(`, `)`, `{`, `}`, `then`, `else`, `do` — and Codex came back with five it did not have:
 *
 *     if publish_root_anchored() { return 0; }; then :; fi
 *
 * counts as ONE definition under that list, and runs as TWO under bash. `while`, `until`, `!` and
 * `time` are the same. Writing those five down would have been r6, and `elif` and `time -p` — both
 * verified below to parse and to take effect, neither listed by any round or any reviewer — would
 * have been r7. Worse, every one of those rounds read the file LINE BY LINE, and
 *
 *     publish_root_anchored\
 *     () { return 0; }
 *
 * is an effective override that no line-based rule can see however long its list of keywords gets.
 *
 * SO THE SCANNER STOPPED HAVING A LIST. tests/scripts/shell-symbol.ts now lexes the whole file,
 * looks for a WORD followed by `()` (or `function` followed by the word), consults nothing about
 * what precedes it beyond bash's own closed metacharacter set, and cross-checks its count against
 * `bash --pretty-print` — bash's own parser, which deparses every form to the same canonical shape
 * without executing anything. The forms below are not the rule's inputs; they are its witnesses.
 *
 * ROUTE: shellFunction() — the extractor the parity test above calls — on scripts/deploy.sh with
 * each form appended, which is where an operator or a compromised checkout would put one.
 *
 * EACH IS PROVED TO BE AN OVERRIDE BEFORE IT IS REQUIRED TO BE CAUGHT, under a real bash running
 * the SHIPPED anchor: a form the extractor rejects but bash ignores would make this a spelling test.
 */
const COMMAND_POSITION_OVERRIDES = [
  // The five Codex named.
  'if publish_root_anchored() { return 0; }; then :; fi',
  'while publish_root_anchored() { return 0; }; do break; done',
  'until publish_root_anchored() { return 0; }; do break; done',
  '! publish_root_anchored() { return 0; }',
  'time publish_root_anchored() { return 0; }',
  // And the ones nobody named. `elif` and `time -p` are command positions no round listed; the
  // `case` arm is one more; and the last is not a command position at all but a header split by a
  // backslash-newline, which is the form that ends the line-by-line approach rather than extending
  // its list.
  'if false; then :; elif publish_root_anchored() { return 0; }; then :; fi',
  'time -p publish_root_anchored() { return 0; }',
  'case anything in *) publish_root_anchored() { return 0; };; esac',
  'publish_root_anchored\\\n() { return 0; }',
] as const

test('[o3d-rn10] every command position bash accepts is caught, including the ones nobody listed', () => {
  const DEPLOY = readFileSync(join(REPO, 'scripts/deploy.sh'), 'utf8')

  // NOT VACUOUS: the shipped file resolves to exactly one, so what fails below is the appended
  // definition and not a scanner that refuses everything it is shown.
  assert.equal(shellFunctionDefinitions(DEPLOY, 'publish_root_anchored', 'scripts/deploy.sh').length, 1,
    'scripts/deploy.sh must carry exactly one publisher before anything is appended to it')

  for (const bypass of COMMAND_POSITION_OVERRIDES) {
    const proof = runBash([
      'set -uo pipefail',
      shellFunction(INSTALL_SH, 'pin_publish_root_parent'),
      shellFunction(INSTALL_SH, 'publish_root_anchored'),
      bypass,
      'publish_root_anchored /ims-rn10-no-such-root/state; echo "rc=$?"',
    ].join('\n'))
    assert.match(proof.stdout, /^rc=0$/m,
      `bash must actually take ${JSON.stringify(bypass)} as the effective definition: ${proof.stderr}`)

    assert.throws(() => shellFunction(`${DEPLOY}\n${bypass}\n`, 'publish_root_anchored'), /2 times/,
      `and the extractor must refuse it: ${JSON.stringify(bypass)}`)
  }

  // AND THE ANCHOR REFUSES THAT ROOT WITHOUT A BYPASS, so `rc=0` above is the override talking.
  const unbypassed = runBash([
    'set -uo pipefail',
    shellFunction(INSTALL_SH, 'pin_publish_root_parent'),
    shellFunction(INSTALL_SH, 'publish_root_anchored'),
    'publish_root_anchored /ims-rn10-no-such-root/state; echo "rc=$?"',
  ].join('\n'))
  assert.match(unbypassed.stdout, /^rc=1$/m, 'the canonical anchor must refuse a root that does not exist')
})

/**
 * AND WHAT THE SCANNER CANNOT READ IS REFUSED, NOT COUNTED (o3d-rn10 r6).
 *
 * This is the half that makes the rewrite worth more than a sixth list. The previous detectors
 * answered every question: shown a construct they did not model, they returned a number, and the
 * number was the one an override hides behind. This one refuses.
 *
 * THE FORM THAT PROVES IT is `eval`. `eval 'publish_root_anchored() { return 0; }'` installs the
 * override — asserted below under a real bash — and is invisible to the lexer, which sees a quoted
 * string; invisible to any command-position rule, however many keywords it lists; and invisible to
 * BASH'S OWN PARSER, which deparses it straight back out as the string it is. Nobody listed it,
 * Codex did not name it, and no reading of the file's text can catch it. So the scanner does not
 * report a count for a file containing one.
 *
 * `$( ( … ) … )` is the second: bash reads `$((` as arithmetic, fails, and re-reads it as a
 * substitution around a subshell. The lexer cannot backtrack like that, so it commits, finds no
 * `))`, and says so with a line number instead of masking the rest of the file away in silence.
 *
 * ROUTE: shellFunctionDefinitions() on scripts/deploy.sh with each construct appended.
 */
test('[o3d-rn10] a construct the scanner cannot read makes it refuse, not return a count', (t) => {
  const DEPLOY = readFileSync(join(REPO, 'scripts/deploy.sh'), 'utf8')
  const scratch = createTempDirSync('ims-rn10-lex-', t)

  // AN EVAL'D OVERRIDE IS A REAL OVERRIDE. Proved first, for the same reason as above.
  const evald = "eval 'publish_root_anchored() { return 0; }'"
  const proof = runBash([
    'set -uo pipefail',
    shellFunction(INSTALL_SH, 'pin_publish_root_parent'),
    shellFunction(INSTALL_SH, 'publish_root_anchored'),
    evald,
    'publish_root_anchored /ims-rn10-no-such-root/state; echo "rc=$?"',
  ].join('\n'))
  assert.match(proof.stdout, /^rc=0$/m, `bash must take the eval'd definition as effective: ${proof.stderr}`)

  // AND BASH'S OWN PARSER CANNOT SEE IT EITHER, which is what makes refusal the honest answer here
  // rather than a lazy one: the deparse hands the definition back as the string it went in as, so
  // the third reading has nothing to add. MEASURED, because "no parser can see it" is exactly the
  // kind of claim that turns out to be false and takes a guard down with it.
  const subject = join(scratch, 'evald.sh')
  writeFileSync(subject, `${evald}\n`)
  const deparse = spawnSync('bash', ['--pretty-print', subject], { encoding: 'utf8' })
  assert.equal(deparse.status, 0, deparse.stderr)
  assert.match(deparse.stdout, /eval 'publish_root_anchored\(\) \{ return 0; \}'/,
    "bash's own parse must still carry the definition as a STRING — if it ever unpacks it, this "
    + 'refusal can become a count')
  assert.doesNotMatch(deparse.stdout.replace(/eval '[^']*'/g, ''), /publish_root_anchored \(\)/,
    'and it must not render it as a definition anywhere else in the deparse')

  assert.throws(() => shellFunctionDefinitions(`${DEPLOY}\n${evald}\n`, 'publish_root_anchored', 'scripts/deploy.sh'),
    /runs `eval`/,
    'a file that builds a definition at runtime must be refused, not reported as carrying one')

  // THE $(( AMBIGUITY. bash parses this; the lexer does not, and says so.
  const ambiguous = 'x="$(( echo a ) ; publish_root_anchored() { return 0; })"'
  const accepted = runBash(`${ambiguous}\necho "parsed=yes"`)
  assert.match(accepted.stdout, /^parsed=yes$/m,
    `bash must accept the construct this scanner refuses — otherwise the refusal is about a typo: ${accepted.stderr}`)
  assert.throws(() => shellFunctionDefinitions(`${DEPLOY}\n${ambiguous}\n`, 'publish_root_anchored', 'scripts/deploy.sh'),
    /arithmetic expansion that does not close/,
    'a construct the lexer cannot resolve must name its line, not mask the rest of the file away')

  // AN UNTERMINATED QUOTE swallows every definition after it. It is refused for the same reason.
  assert.throws(() => shellFunctionDefinitions(`${DEPLOY}\necho 'never closed\n`, 'publish_root_anchored', 'scripts/deploy.sh'),
    /unterminated single quote/)
  assert.throws(() => shellFunctionDefinitions(`${DEPLOY}\ncat <<NEVER\nbody\n`, 'publish_root_anchored', 'scripts/deploy.sh'),
    /unterminated here-document/)

  // AND A FILE BASH ITSELF WILL NOT PARSE gets no count either: the second reading is not optional.
  assert.throws(() => shellFunctionDefinitions(`${DEPLOY}\nif publish_root_anchored() { return 0; }\n`, 'publish_root_anchored', 'scripts/deploy.sh'),
    /bash refuses to parse/)

  // NOT VACUOUS: the same call on the unmodified file returns one. The refusals above are the
  // constructs talking, not a scanner that has stopped answering.
  assert.equal(shellFunctionDefinitions(DEPLOY, 'publish_root_anchored', 'scripts/deploy.sh').length, 1)
})

/**
 * AND FAILING CLOSED HAS NOT MADE THE SCANNER UNUSABLE (o3d-rn10 r6).
 *
 * This is the risk the rewrite carries, and it is the reason to measure rather than assert it. A
 * scanner that refuses a file it cannot read is only worth having if it can read the files this
 * repository actually ships; one that trips on ordinary code gets an exemption, then a bypass, then
 * deleted. So every shell script under version control is walked, every function symbol each one
 * defines is looked up, and each must resolve to EXACTLY ONE under all three readings — the lexer,
 * the word rule, and bash's own parse — with no refusal anywhere.
 *
 * ROUTE: shellFunctionDefinitions() over `git ls-files '*.sh'`, which is the same extractor the
 * parity test and every behavioural rig in this file go through.
 */
test('[o3d-rn10] every function the tracked shell scripts define still resolves to exactly one', () => {
  const listed = spawnSync('git', ['ls-files', '*.sh'], { cwd: REPO, encoding: 'utf8' })
  assert.equal(listed.status, 0, listed.stderr)
  const files = listed.stdout.trim().split('\n').filter(Boolean)
  assert.ok(files.length >= 13, `the census must reach the tracked scripts; git listed ${files.length}`)

  let canonicalDefinitions = 0
  let symbolsResolved = 0
  for (const file of files) {
    const source = readFileSync(join(REPO, file), 'utf8')
    canonicalDefinitions += source.split('\n').filter((line) => /^[A-Za-z_][A-Za-z0-9_]*\(\) \{$/.test(line)).length
    // Names taken from the MASK, so a definition quoted inside a comment or written in an embedded
    // awk program is not looked up as if it were shell.
    const names = new Set<string>()
    for (const match of maskShellSource(source, file).matchAll(/(?:^|\n)([A-Za-z_][A-Za-z0-9_]*)[ \t]*\([ \t]*\)/g)) names.add(match[1])
    for (const name of names) {
      assert.equal(shellFunctionDefinitions(source, name, file).length, 1,
        `${file}: ${name}() must resolve to exactly one definition. A scanner that fails closed is `
        + 'only usable while it can read the code this repository ships; if this is a legitimate '
        + 'second definition, the script is what needs changing, and if it is not, the scanner is.')
      symbolsResolved += 1
    }
  }

  // THE WALK REACHED THE FILES, stated as numbers so a census that silently stopped visiting them
  // cannot pass as one that visited them and found nothing wrong. Floors rather than equalities,
  // because a new function is not a regression.
  assert.ok(canonicalDefinitions >= 351,
    `the tracked scripts carried 351 canonical \`name() {\` definitions when this was written; the census saw ${canonicalDefinitions}`)
  assert.ok(symbolsResolved >= 373,
    `the census resolved 373 (file, symbol) pairs when this was written; it saw ${symbolsResolved}`)
})

// ---------------------------------------------------------------------------
// SITES 4, 5 and 7 — every directory created below a root the service account owns.
// ---------------------------------------------------------------------------

test('[o3d-czpy] mkdir_service_subdir refuses a planted symlink and creates nothing inside its target', (t) => {
  const root = createTempDirSync('ims-czpy-mkdir-', t)
  const dataDir = join(root, 'data')
  const victim = join(root, 'victim')
  mkdirSync(dataDir)
  mkdirSync(victim)
  symlinkSync(victim, join(dataDir, 'uploads'))

  const script = rig(['enter_service_subdir', 'mkdir_service_subdir'],
    `mkdir_service_subdir "${dataDir}" 022 "${dataDir}/uploads/invoices"\necho "reached=yes"`)
  const run = runBash(script)

  assert.equal(run.status, 1, 'a symlink at a component must END the run')
  assert.ok(!run.stdout.includes('reached=yes'), 'and nothing after it may execute')
  assert.match(run.stderr, /uploads exists and is a symbolic link/, run.stderr)
  assert.deepEqual(readdirSync(victim), [], 'the symlink target must be untouched')
})

test('[o3d-czpy] mkdir_service_subdir still creates the directories it is meant to', (t) => {
  const root = createTempDirSync('ims-czpy-mkdir-ok-', t)
  const dataDir = join(root, 'data')

  const script = rig(['enter_service_subdir', 'mkdir_service_subdir'],
    `mkdir_service_subdir "${dataDir}" 022 "${dataDir}/uploads/quarantine/invoices" "${dataDir}/xero"\necho "reached=yes"`)
  const run = runBash(script)

  assert.match(run.stdout, /reached=yes/, run.stderr)
  assert.ok(statSync(join(dataDir, 'uploads/quarantine/invoices')).isDirectory())
  assert.ok(statSync(join(dataDir, 'xero')).isDirectory())
  // NOT VACUOUS: a helper that refused everything would pass the test above and fail this one.
  const run2 = runBash(rig(['enter_service_subdir', 'mkdir_service_subdir'],
    `mkdir_service_subdir "${dataDir}" 022 "${dataDir}/uploads/quarantine/invoices"\necho "reached=yes"`))
  assert.match(run2.stdout, /reached=yes/, 'and it must be idempotent across installer runs')
})

test('[o3d-czpy] mkdir_service_subdir creates the deploy-key directory at 0700 without a chmod', (t) => {
  const root = createTempDirSync('ims-czpy-sshdir-', t)
  const dataDir = join(root, 'data')

  const script = rig(['enter_service_subdir', 'mkdir_service_subdir'], `mkdir_service_subdir "${dataDir}" 077 "${dataDir}/git-ssh"`)
  const run = runBash(script)

  assert.equal(run.status, 0, run.stderr)
  assert.equal(statSync(join(dataDir, 'git-ssh')).mode & 0o777, 0o700,
    'the mode comes from the umask at creation; chmod has no --no-dereference on Linux, so there must be nothing to correct afterwards')
})

test('[o3d-czpy] migrate_uploads refuses a planted destination and moves nothing into it', (t) => {
  const root = createTempDirSync('ims-czpy-migrate-', t)
  const dataDir = join(root, 'data')
  const victim = join(root, 'victim')
  const src = join(root, 'legacy')
  mkdirSync(dataDir)
  mkdirSync(victim)
  mkdirSync(src)
  writeFileSync(join(src, 'invoice-1.pdf'), 'PDF\n')
  mkdirSync(join(dataDir, 'uploads'))
  symlinkSync(victim, join(dataDir, 'uploads/invoices'))

  const script = rig(['enter_service_subdir', 'mkdir_service_subdir', 'migrate_uploads'],
    `migrate_uploads "${src}" "${dataDir}/uploads/invoices"\necho "reached=yes"`,
    `DATA_DIR="${dataDir}"`)
  const run = runBash(script)

  assert.equal(run.status, 1, 'a symlinked destination must end the run')
  assert.ok(!run.stdout.includes('reached=yes'))
  assert.deepEqual(readdirSync(victim), [], 'no legacy upload may be moved into the symlink target')
  assert.deepEqual(readdirSync(src), ['invoice-1.pdf'], 'and the source must be left where it was')
})

test('[o3d-czpy] migrate_uploads migrates a rerun whose destination is already owned by the SERVICE account', (t) => {
  const root = createTempDirSync('ims-czpy-migrate-rerun-', t)
  const dataDir = join(root, 'data')
  const src = join(root, 'legacy')
  const dest = join(dataDir, 'uploads/invoices')
  // THE ORDINARY UPGRADE. The previous install created these destinations and then chowned them,
  // with everything else under ${DATA_DIR}, to ${APP_USER}; legacy uploads then reappear (a
  // restored backup, a rolled-back deploy) and this run has to finish moving them.
  mkdirSync(dest, { recursive: true })
  writeFileSync(join(dest, 'invoice-0.pdf'), 'ALREADY THERE\n')
  mkdirSync(src)
  writeFileSync(join(src, 'invoice-1.pdf'), 'PDF\n')

  // THE MULTI-ACCOUNT CONDITION, BUILT AND NOT ARGUED. An unprivileged harness cannot chown the
  // destination to a second uid, so the mismatch is made at the other end: `id -u` answers a uid
  // that is NOT the destination's owner, which is the state every rerun reaches. The pin the
  // installer now uses is an inode identity and asks nothing about ownership, so it never consults
  // this shim; the check it REPLACED did, and refused the migration on exactly this state.
  const bin = shimDir(t, {
    id: `if [[ "$*" == "-u" ]]; then printf '%s\\n' 4242; exit 0; fi\nexec ${REAL.id} "$@"`,
  })
  assert.notEqual(statSync(dest).uid, 4242,
    'the destination must NOT be owned by the uid the installer reports, or this test states nothing')

  const script = rig(['enter_service_subdir', 'mkdir_service_subdir', 'migrate_uploads'],
    `migrate_uploads "${src}" "${dest}"\necho "reached=yes"`,
    `DATA_DIR="${dataDir}"`)
  const run = runBash(script, { env: { PATH: `${bin}:${process.env.PATH ?? ''}` } })

  assert.match(run.stdout, /reached=yes/, `a normal upgrade must not be refused: ${run.stderr}`)
  assert.equal(readFileSync(join(dest, 'invoice-1.pdf'), 'utf8'), 'PDF\n', 'the legacy upload must be migrated')
  assert.equal(readFileSync(join(dest, 'invoice-0.pdf'), 'utf8'), 'ALREADY THERE\n',
    'and what the previous run migrated must be left alone')
  assert.ok(!existsSync(src), 'and the emptied legacy directory is removed')
})

test('[o3d-czpy] migrate_uploads still migrates a real legacy directory', (t) => {
  const root = createTempDirSync('ims-czpy-migrate-ok-', t)
  const dataDir = join(root, 'data')
  const src = join(root, 'legacy')
  mkdirSync(dataDir)
  mkdirSync(src)
  writeFileSync(join(src, 'invoice-1.pdf'), 'PDF\n')

  const script = rig(['enter_service_subdir', 'mkdir_service_subdir', 'migrate_uploads'],
    `migrate_uploads "${src}" "${dataDir}/uploads/invoices"\necho "reached=yes"`,
    `DATA_DIR="${dataDir}"`)
  const run = runBash(script)

  assert.match(run.stdout, /reached=yes/, run.stderr)
  assert.equal(readFileSync(join(dataDir, 'uploads/invoices/invoice-1.pdf'), 'utf8'), 'PDF\n')
  assert.ok(!existsSync(src), 'and the emptied legacy directory is removed')
})

test('[o3d-czpy] mkdir_service_subdir refuses an existing component swapped for a symlink between its check and the step into it', (t) => {
  const root = createTempDirSync('ims-czpy-walkswap-', t)
  const dataDir = join(root, 'data')
  const uploads = join(dataDir, 'uploads')
  const victim = join(root, 'victim')
  // THE UPGRADE, WHICH IS THE RUN THAT MATTERS: `uploads` is already there, and by this point in a
  // real install it belongs to ${APP_USER}, who can rename it.
  mkdirSync(uploads, { recursive: true })
  mkdirSync(victim)
  const fired = join(root, 'swapped')

  // `stat` is the walk's check on an existing component, and the shim answers TRUTHFULLY — the
  // component IS a directory at the instant it is asked — before swapping it. That is exactly the
  // sequence the finding describes, made deterministic; a real attacker just has to win the race.
  const bin = shimDir(t, {
    stat: [
      `${REAL.stat} "$@"`,
      'status=$?',
      `if [[ "$*" == *uploads* && ! -e ${q(fired)} ]]; then`,
      `  : > ${q(fired)}`,
      `  ${REAL.mv} -T ${q(uploads)} ${q(join(dataDir, 'uploads.moved'))}`,
      `  ${REAL.ln} -s ${q(victim)} ${q(uploads)}`,
      'fi',
      'exit $status',
    ].join('\n'),
  })

  const script = rig(['enter_service_subdir', 'mkdir_service_subdir'],
    `mkdir_service_subdir "${dataDir}" 022 "${join(dataDir, 'uploads/invoices')}"\necho "reached=yes"`)
  const run = runBash(script, { env: { PATH: `${bin}:${process.env.PATH ?? ''}` } })

  // NOT VACUOUS: the shim was reached and the swap was made.
  assert.ok(existsSync(fired), 'the walk must actually have stat()ed the existing component')
  assert.equal(lstatSync(uploads).isSymbolicLink(), true, 'and the component must have been swapped for a link')

  assert.equal(run.status, 1, 'a component swapped after its check must END the run')
  assert.ok(!run.stdout.includes('reached=yes'), 'and nothing after it may execute')
  assert.match(run.stderr, /was replaced between the check and the step into it/, run.stderr)
  assert.deepEqual(readdirSync(victim), [],
    'and no directory may be created inside the directory the link chose')
})

// ---------------------------------------------------------------------------
// SITE 8 — cp -a "${clone}/.git" "${APP_DIR}/.git"
// ---------------------------------------------------------------------------

test('[o3d-czpy] copy_tree_into_new_dir refuses a destination re-planted between the rm and the create', (t) => {
  const root = createTempDirSync('ims-czpy-git-', t)
  const appDir = join(root, 'app')
  const clone = join(root, 'clone')
  const victim = join(root, 'victim')
  mkdirSync(appDir)
  mkdirSync(victim)
  mkdirSync(join(clone, '.git'), { recursive: true })
  writeFileSync(join(clone, '.git/HEAD'), 'ref: refs/heads/main\n')

  // THE RACE, MADE DETERMINISTIC. `rm -rf` removes a symlink without following it, which is
  // correct — and leaves the NAME free. This shim re-plants it the instant the rm returns, which
  // is exactly the window the service account has, and is the only way to exhibit it from outside
  // the process.
  const bin = shimDir(t, {
    rm: `${REAL.rm} "$@"\nfor a in "$@"; do case "$a" in */.git) ${REAL.ln} -s ${q(victim)} "$a" ;; esac; done\nexit 0`,
  })

  const script = rig(['copy_tree_into_new_dir'],
    `copy_tree_into_new_dir "${clone}/.git" "${appDir}/.git"\necho "reached=yes"`)
  const run = runBash(script, { env: { PATH: `${bin}:${process.env.PATH ?? ''}` } })

  assert.equal(run.status, 1, 'a name taken between the rm and the create must end the run')
  assert.ok(!run.stdout.includes('reached=yes'))
  assert.deepEqual(readdirSync(victim), [], 'and no git metadata may be copied into the symlink target')
})

test('[o3d-czpy] copy_tree_into_new_dir still installs the git metadata, dotfiles included', (t) => {
  const root = createTempDirSync('ims-czpy-git-ok-', t)
  const appDir = join(root, 'app')
  const clone = join(root, 'clone')
  mkdirSync(appDir)
  mkdirSync(join(clone, '.git/refs/heads'), { recursive: true })
  writeFileSync(join(clone, '.git/HEAD'), 'ref: refs/heads/main\n')
  writeFileSync(join(clone, '.git/.hidden'), 'x\n')

  const script = rig(['copy_tree_into_new_dir'],
    `copy_tree_into_new_dir "${clone}/.git" "${appDir}/.git"\necho "reached=yes"`)
  const run = runBash(script)

  assert.match(run.stdout, /reached=yes/, run.stderr)
  assert.equal(readFileSync(join(appDir, '.git/HEAD'), 'utf8'), 'ref: refs/heads/main\n')
  assert.equal(readFileSync(join(appDir, '.git/.hidden'), 'utf8'), 'x\n', '`cp -a src/. .` must carry dotfiles too')
  assert.ok(statSync(join(appDir, '.git/refs/heads')).isDirectory())
})

test('[o3d-czpy] copy_tree_into_new_dir refuses a name replaced, AFTER it was created, by a symlink to another directory owned by the privileged uid', (t) => {
  const root = createTempDirSync('ims-czpy-gitswap-', t)
  const appDir = join(root, 'app')
  const clone = join(root, 'clone')
  const dest = join(appDir, '.git')
  // ANOTHER DIRECTORY OWNED BY THE PRIVILEGED ACCOUNT, which is the whole point: root ownership is
  // a property a great many directories have. In the shipped case this is /root or another
  // install's .git, and `cp -a` overwrites the entries whose names match — `config` among them.
  const victim = join(root, 'other-root-owned')
  mkdirSync(appDir)
  mkdirSync(victim)
  writeFileSync(join(victim, 'config'), 'UNTOUCHED\n')
  mkdirSync(join(clone, '.git'), { recursive: true })
  writeFileSync(join(clone, '.git/HEAD'), 'ref: refs/heads/main\n')
  writeFileSync(join(clone, '.git/config'), '[remote "origin"]\n')

  // THE PRECONDITION THE OLD CHECK ACCEPTED, ASSERTED RATHER THAN ASSUMED. `stat -c '%F|%u' .`
  // after the chdir asked for "a directory owned by ${self}", and this victim is one — so the old
  // code passed that check and copied into it. If this assertion ever stopped holding, the test
  // below would be proving something else.
  assert.equal(statSync(victim).uid, process.getuid?.(), 'the victim must be owned by the uid the installer runs as')
  assert.ok(statSync(victim).isDirectory())

  // The window: between the `mkdir` that creates ${dest} and the `cd` that pins it. The existing
  // replant regression covers only the window BEFORE the mkdir, which a plain mkdir already closes.
  const bin = shimDir(t, {
    mkdir: [
      `${REAL.mkdir} "$@"`,
      'status=$?',
      `if [[ $status -eq 0 && "$*" == *.git* ]]; then`,
      `  ${REAL.mv} -T ${q(dest)} ${q(join(root, 'git.moved'))}`,
      `  ${REAL.ln} -s ${q(victim)} ${q(dest)}`,
      'fi',
      'exit $status',
    ].join('\n'),
  })

  const script = rig(['copy_tree_into_new_dir'],
    `copy_tree_into_new_dir "${join(clone, '.git')}" "${dest}"\necho "reached=yes"`)
  const run = runBash(script, { env: { PATH: `${bin}:${process.env.PATH ?? ''}` } })

  // NOT VACUOUS: the directory really was created and really was replaced by the link.
  assert.equal(lstatSync(dest).isSymbolicLink(), true, 'the created directory must have been swapped for the link')
  assert.ok(statSync(join(root, 'git.moved')).isDirectory(), 'and the one this run created must still exist, renamed aside')

  assert.equal(run.status, 1, 'ownership is not identity: a link to ANOTHER directory owned by the same uid must end the run')
  assert.ok(!run.stdout.includes('reached=yes'))
  assert.equal(readFileSync(join(victim, 'config'), 'utf8'), 'UNTOUCHED\n',
    'and the git metadata must not be copied over the entries of the directory the link chose')
  assert.deepEqual(readdirSync(victim), ['config'], 'nor anything else be left in it')
})

// ---------------------------------------------------------------------------
// SITE 8 AND SITE 5, IN THE OTHER ENTRYPOINT THAT PERFORMS THEM (o3d-ov60)
//
// o3d-czpy wrote copy_tree_into_new_dir() and gave it install.sh's two clone paths. update.sh has
// a third, doing the identical thing to the identical name, and it kept the raw
// `rm -rf` + `cp -a` pair; and its pre-migration backup directory was still created with a bare
// `mkdir -p`, which accepts a symlink at its final component and returns 0. Both are measured
// here the way every other site in this file is: the SHIPPED statement, lifted out of
// scripts/update.sh by its own text, run by a real bash against a real planted symlink, with the
// retired statement as the stated mutation.
// ---------------------------------------------------------------------------

const UPDATE_SH = readFileSync(join(REPO, 'scripts/update.sh'), 'utf8')

/**
 * A SHIPPED, CONTIGUOUS RUN OF TOP-LEVEL LINES OF scripts/update.sh, lifted by its own first and
 * last line rather than retyped — the same rule shippedStatement() states for install.sh. A
 * statement this file lifts by its text is not one it may find twice or not at all.
 */
function shippedUpdateBlock(firstLine: string, lastLine: string): string {
  const lines = UPDATE_SH.split('\n')
  const start = lines.indexOf(firstLine)
  assert.notEqual(start, -1, `scripts/update.sh must contain the line ${JSON.stringify(firstLine)}`)
  assert.equal(lines.lastIndexOf(firstLine), start,
    `scripts/update.sh must contain exactly one line ${JSON.stringify(firstLine)}`)
  const end = lines.indexOf(lastLine, start)
  assert.notEqual(end, -1, `scripts/update.sh must close that block with ${JSON.stringify(lastLine)}`)
  assert.equal(lines.lastIndexOf(lastLine), end,
    `scripts/update.sh must contain exactly one line ${JSON.stringify(lastLine)}`)
  return lines.slice(start, end + 1).join('\n')
}

const UPDATE_GIT_COPY = shippedUpdateBlock(
  '    copy_tree_into_new_dir "${TMP_CLONE_WORKTREE}/.git" "${APP_DIR}/.git"',
  '    copy_tree_into_new_dir "${TMP_CLONE_WORKTREE}/.git" "${APP_DIR}/.git"',
)

/** The two lines it replaced, which are the mutation. */
const UPDATE_GIT_COPY_RETIRED = [
  '    rm -rf "${APP_DIR}/.git"',
  '    cp -a "${TMP_CLONE_WORKTREE}/.git" "${APP_DIR}/.git"',
].join('\n')

test('[o3d-ov60] update.sh copies the git metadata into a directory it created and pinned, never into a name', (t) => {
  // The name update.sh removes and re-creates belongs to ${APP_USER}: `rm -rf` unlinks a symlink
  // without following it, which is correct, and leaves the entry free to be re-created between the
  // removal and the copy. This shim IS that window, made deterministic — it is the one the
  // existing o3d-czpy regression above uses, because it is the only way to exhibit the race from
  // outside the process.
  const plant = (prefix: string) => {
    const root = createTempDirSync(prefix, t)
    const appDir = join(root, 'app')
    const clone = join(root, 'clone')
    const victim = join(root, 'victim')
    mkdirSync(appDir)
    mkdirSync(victim)
    mkdirSync(join(clone, '.git'), { recursive: true })
    writeFileSync(join(clone, '.git/HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(join(clone, '.git/config'), '[remote "origin"]\n')
    const bin = shimDir(t, {
      rm: `${REAL.rm} "$@"\nfor a in "$@"; do case "$a" in */.git) ${REAL.ln} -s ${q(victim)} "$a" ;; esac; done\nexit 0`,
    })
    return { appDir, clone, victim, bin }
  }

  const script = (site: string, p: ReturnType<typeof plant>) => rig(['copy_tree_into_new_dir'], [
    `TMP_CLONE_WORKTREE=${q(p.clone)}`,
    `APP_DIR=${q(p.appDir)}`,
    site,
    `echo ${REACHED}`,
  ].join('\n'))

  const shipped = plant('ims-ov60-git-')
  const run = runBash(script(UPDATE_GIT_COPY, shipped), { env: { PATH: `${shipped.bin}:${process.env.PATH ?? ''}` } })

  // NOT VACUOUS: the shim really did re-plant the link, so the shipped run met the finding.
  assert.equal(lstatSync(join(shipped.appDir, '.git')).isSymbolicLink(), true,
    'the destination name must have been re-taken by a link after the removal')
  assert.equal(run.status, 1, `a name taken between the removal and the create must end the run: ${run.stdout} ${run.stderr}`)
  assert.ok(!run.stdout.includes(REACHED), 'and nothing after it may execute')
  assert.deepEqual(readdirSync(shipped.victim), [],
    'and no git metadata may be copied into the directory the link chose')

  // MEASURED BY MUTATION, ROUTE STATED: the two lines update.sh carried until this change, in
  // place of the shipped call. `cp -a src dest` with `dest` a symlink-to-directory copies INTO the
  // target, as root — which is the finding, executed.
  const mutant = plant('ims-ov60-git-mutant-')
  const mutated = runBash(script(UPDATE_GIT_COPY_RETIRED, mutant), { env: { PATH: `${mutant.bin}:${process.env.PATH ?? ''}` } })
  assert.ok(mutated.stdout.includes(REACHED),
    `the retired pair must run to completion: ${mutated.stdout} ${mutated.stderr}`)
  assert.notDeepEqual(readdirSync(mutant.victim), [],
    'and it must land the clone metadata inside the directory the link chose')
})

// ---------------------------------------------------------------------------
// SITE 5 IS WITHDRAWN, AND THIS IS THE RECORD OF WHY (o3d-ov60 r4)
//
// Three rounds tried to make a root-side `pg_dump`, `mv` and `rm --` safe INSIDE a directory
// ${APP_USER} may own, because `IMS_BACKUP_DIR` puts them there and nothing validates it. Each
// round closed its finding by opening a worse one, and the third opened ARBITRARY CODE EXECUTION
// AS ROOT. What ships now is the `mkdir -p` and the plain redirection that were here before the
// branch — the status quo ante, which is a denial of service that has always been reachable
// through that override and is not a regression.
//
//   r1  the symlink-proof walk, through the twin that RESTORES the working directory, after which
//       the dump, the publication and the prune each re-resolved ${BACKUP_DIR} by name. The guard
//       was not wrong, it was SPENT.
//   r2  the walk's result kept and pinned as a descriptor, with `set -C` creating the partial.
//       `set -C` is open(O_CREAT|O_EXCL) only until that open FAILS: bash re-opens WITHOUT O_EXCL
//       for anything that is not a regular file, so a planted named pipe was OPENED, and an open
//       of a FIFO with no reader BLOCKS — with the service stopped, cron stopped and the database
//       connections fenced.
//   r3  a node helper, scripts/lib/write-new-file.mjs, to name `O_EXCL|O_NONBLOCK` where a shell
//       cannot. That is what the two tests below are about.
//
// AND THE WALK'S ANCHOR WAS NEVER SOUND EITHER. enter_service_subdir() treats its FIRST argument
// as a trusted root — `mkdir -p`, `cd -P`, no checks — and its own refusal text says the walk
// "only means anything for components below the directory the service account owns". r1 handed it
// `${BACKUP_DIR%/*}`, which is a prefix of the untrusted override, so everything above the final
// component was entered unvalidated. Constraining the override instead is o3d-noka; the
// repository-wide helper-provenance design is o3d-kyqa.
// ---------------------------------------------------------------------------

test('[o3d-ov60 r4] the withdrawn backup helper is gone, and update.sh executes no program at its dump', () => {
  /**
   * THE SHAPE OF THIS GUARD IS scripts/lib/pin-source-file.mjs's, and for the same reason: an
   * unused apparatus whose premise this round rejects is the clearest possible invitation to wire
   * it back up. A COMMENT MAY NAME THE HELPER — the block carries the paragraph that says why it
   * went, and a rule that forbade the word would delete the reasoning with the code. What may not
   * survive is an executable reference: a resolution, or an invocation.
   */
  assert.equal(existsSync(join(REPO, 'scripts/lib/write-new-file.mjs')), false,
    'scripts/lib/write-new-file.mjs made root execute bytes out of an ${APP_USER}-owned checkout '
    + 'in the middle of a cutover; it is withdrawn, and an unused copy is an invitation to re-wire it')

  const block = shippedUpdateBlock('  mkdir -p "${BACKUP_DIR}"', '  ls -t "${BACKUP_DIR}"/pre-update-*.sql.gz 2>/dev/null | tail -n +11 | xargs -r rm --')
  const code = block.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n')
  assert.ok(!/\bnode\b/.test(code),
    `update.sh's backup block must run no program resolved out of the checkout:\n${code}`)
  assert.ok(!/BACKUP_WRITER|IMS_BACKUP_WRITER_HELPER/.test(UPDATE_SH),
    'update.sh must not carry the resolution — or the override — for a helper that is gone')

  // AND THE REASONING SURVIVES WITH THE CODE. Three rounds of findings are worth nothing if the
  // next reader meets a bare `mkdir -p` and closes it again the same way. Lifted as its own
  // contiguous region, so a paragraph moved away from the statement it explains fails this too.
  const record = shippedUpdateBlock(
    '  # THIS IS BACK TO `mkdir -p` AND A PLAIN REDIRECTION, AND THAT IS THE RESULT OF THE ROUND',
    '  mkdir -p "${BACKUP_DIR}"',
  )
  for (const owed of ['o3d-noka', 'o3d-kyqa', 'ARBITRARY CODE EXECUTION AS ROOT']) {
    assert.ok(record.includes(owed),
      `the withdrawal must say ${owed} at the site, or it is a silent revert:\n${record}`)
  }
})

test('[o3d-ov60 r4] THE WITHDRAWN SHAPE, EXERCISED: a helper replaced mid-cutover is EXECUTED, and the shipped block executes nothing', (t) => {
  /**
   * WHY THIS TEST EXISTS AT ALL, GIVEN THAT THE CODE IT INDICTS IS GONE.
   *
   * The finding is not "write-new-file.mjs was written badly" — it was not. It is that the
   * documented update is `cd /opt/one-two-inventory && bash scripts/update.sh`, that install.sh
   * and update.sh both `chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"`, and that a program
   * resolved out of that checkout AT THE MIGRATION STEP is bytes the service account may replace
   * AFTER the operator started a run they had reason to believe was clean. Any future round that
   * reaches for a helper here re-opens it, so the mechanism is exhibited rather than described.
   *
   * WHAT IS PLANTED IS NOT A MUTATED HELPER. It is the file the ATTACKER writes: the shipped
   * helper's bytes are irrelevant, because they are not the bytes that get executed.
   *
   * AND IT IS PLANTED THROUGH THE WINDOW THE SHIPPED SEQUENCE ITSELF MAKES. `info` is called
   * between the directory's preparation and the dump in every version of this block, so the
   * replacement happens at a point the code chose, not at a line this file spliced in. Nothing
   * about the exhibition depends on the replacement PRECEDING the run.
   */
  const rig = (statement: string, extra: string[]) => {
    const root = createTempDirSync('ims-ov60-r4-', t)
    const backupDir = join(root, 'one-two-inventory')
    mkdirSync(backupDir)
    const lib = join(root, 'lib')
    mkdirSync(lib)
    // What the release shipped: a helper that does its job and nothing else.
    const helper = join(lib, 'write-new-file.mjs')
    writeFileSync(helper, 'process.stdin.pipe(process.stdout)\n')
    // What ${APP_USER} replaces it with once the cutover is under way.
    const owned = join(root, 'ROOT-CODE-EXECUTION')
    const planted = `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(owned)}, String(process.getuid?.() ?? ''))\n`
    return {
      backupDir,
      helper,
      owned,
      script: [
        'set -uo pipefail',
        'error() { printf "ERROR: %s\\n" "$*" >&2; }',
        'die() { error "$*"; exit 1; }',
        'MIGRATION_DATABASE_URL="postgresql://example/db"',
        'pg_dump() { printf %s "DUMP-OF-$1"; }',
        'gzip() { cat; }',
        'success() { printf "SUCCESS: %s\\n" "$*"; }',
        'pin_migration_window() { :; }',
        // THE WINDOW, opened at the call site the shipped block already makes.
        `info() { printf "INFO: %s\\n" "$*"; cat > ${q(helper)} <<'PLANTED'\n${planted}PLANTED\n}`,
        `BACKUP_DIR=${q(backupDir)}`,
        `BACKUP_TARGET="\${BACKUP_DIR}/${'pre-update-00000000-000000.sql.gz'}"`,
        ...extra,
        statement,
        'echo REACHED_THE_WRITES',
      ].join('\n'),
    }
  }

  /**
   * THE r3 STATEMENT, TYPED HERE BECAUSE IT IS IN NO SHIPPED FILE — which is what makes it a
   * mutation and not a second reading of the subject. `${BACKUP_AT}` was `/proc/self/fd/N` on the
   * proved directory; the directory itself is used here, because the finding is about WHICH
   * PROGRAM RUNS and not about which directory it writes into.
   */
  const RETIRED_R3 = [
    '  info "Backing up database to ${BACKUP_TARGET}..."',
    '  backup_rc=0',
    '  pg_dump "${MIGRATION_DATABASE_URL}" | gzip \\',
    '    | node "${BACKUP_WRITER}" "${BACKUP_AT}" "${BACKUP_PARTIAL_BASE}" \\',
    '    || { backup_rc=$?; rm -f -- "${BACKUP_AT}/${BACKUP_PARTIAL_BASE}"; }',
  ].join('\n')

  const mutant = rig(RETIRED_R3, [
    'BACKUP_WRITER="${BACKUP_DIR}/../lib/write-new-file.mjs"',
    'BACKUP_AT="${BACKUP_DIR}"',
    'BACKUP_PARTIAL_BASE="pre-update-00000000-000000.sql.gz.part"',
  ])
  // NOT VACUOUS, ESTABLISHED BEFORE THE CLAIM: the marker is absent, and the helper on disk is the
  // benign one, at the instant the run starts.
  assert.equal(existsSync(mutant.owned), false, 'precondition: nothing has been executed yet')
  assert.equal(readFileSync(mutant.helper, 'utf8').includes('ROOT-CODE-EXECUTION'), false,
    'precondition: the release\'s own helper must be what is on disk when the run begins')
  const ran = runBash(mutant.script)
  assert.match(ran.stdout, /^INFO: /m, `precondition: the window must have been reached: ${ran.stdout} ${ran.stderr}`)
  assert.equal(existsSync(mutant.owned), true,
    'THE FINDING: the bytes ${APP_USER} put at the helper\'s path AFTER the run started were '
    + `executed by the account running the cutover: ${ran.stdout} ${ran.stderr}`)
  assert.equal(readFileSync(mutant.owned, 'utf8'), String(process.getuid?.() ?? ''),
    'and they ran as that account — root, on a host, where this harness is unprivileged')

  // THE SHIPPED BLOCK, through the same rig and the same window. It resolves no program, so the
  // same plant reaches nothing: the redirection is performed by the bash that is already running.
  const shipped = rig(
    shippedUpdateBlock('  mkdir -p "${BACKUP_DIR}"', '  ls -t "${BACKUP_DIR}"/pre-update-*.sql.gz 2>/dev/null | tail -n +11 | xargs -r rm --'),
    [],
  )
  assert.equal(existsSync(shipped.owned), false, 'precondition: nothing has been executed yet')
  const clean = runBash(shipped.script)
  assert.match(clean.stdout, /^INFO: /m, `precondition: the same window must have been reached: ${clean.stdout} ${clean.stderr}`)
  assert.ok(clean.stdout.includes('REACHED_THE_WRITES'),
    `and the shipped block must still take its backup: ${clean.stdout} ${clean.stderr}`)
  assert.equal(readFileSync(shipped.helper, 'utf8').includes('ROOT-CODE-EXECUTION'), true,
    'the plant must still have happened, or the comparison is between two different runs')
  assert.equal(existsSync(shipped.owned), false,
    'and the shipped block must execute nothing that was planted: it names no program to run')
})

// ---------------------------------------------------------------------------
// THE RECURSIVE OWNERSHIP CHANGE OVER ${DATA_DIR}, WHICH MAY NOT GO THROUGH PATHNAMES
// (o3d-n8xx, Codex CRITICAL)
//
// It was `find "${DATA_DIR}" \( -path "${CRONTAB_LOCK_DIR}" -o -name .ims-publish \) -prune
// -o -exec chown -h "${APP_USER}:${APP_USER}" {} +`. `find -exec` ENUMERATES pathnames and hands
// them to a chown that resolves them AGAIN afterwards, and `-h` protects only the FINAL component.
// On an upgrade the service account owns this tree AND IS STILL RUNNING — section 8 precedes the
// `systemctl stop` in section 10c — so a descendant directory renamed aside and replaced by a
// symlink in that gap redirects a root-side ownership change through it.
//
// WHAT IS MEASURED BELOW is the REAL EFFECT, on a real filesystem, by a real chown: `chown(2)`
// updates a file's ctime even when the owner it sets is the owner it already had, so an
// unprivileged harness that chowns to its OWN uid still leaves a record of exactly which inodes the
// walk reached. Nothing is stubbed, and no dry-run mode exists to diverge from the shipped path.
// ---------------------------------------------------------------------------

/** The walker itself, as it ships. */
const CHOWN_TREE = join(REPO, 'scripts/lib/chown-tree.mjs')

/** A shell constant's VALUE, lifted rather than retyped: a fixture that spelled `.ims-publish`
 *  itself would keep passing after the script stopped using that name. */
function constantValue(source: string, name: string, where: string): string {
  const declaration = shellConstant(source, name, where)
  const value = shellWordLiteral(declaration.slice(declaration.indexOf('=') + 1))
  assert.equal(value.kind, 'literal', `${name} in ${where} must be a literal: ${declaration}`)
  return value.kind === 'literal' ? value.value : ''
}
const CRONTAB_LOCK_SH = readFileSync(join(REPO, 'scripts/lib/crontab-lock.sh'), 'utf8')
const LOCK_DIRNAME = constantValue(CRONTAB_LOCK_SH, 'CRONTAB_LOCK_DIRNAME', 'scripts/lib/crontab-lock.sh')
const LOCK_FILENAME = constantValue(CRONTAB_LOCK_SH, 'CRONTAB_LOCK_FILENAME', 'scripts/lib/crontab-lock.sh')
const STAGE_DIRNAME = constantValue(INSTALL_SH, 'PUBLISH_STAGE_DIRNAME', 'scripts/install.sh')

/** ctime, in nanoseconds, of every entry at or below `root`, keyed by its path relative to it.
 *  Symlinks are `lstat`ed: the LINK's own ctime is the record of an `lchown` on it. */
function ctimes(root: string): Map<string, bigint> {
  const seen = new Map<string, bigint>()
  const visit = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      const stats = lstatSync(path, { bigint: true })
      seen.set(prefix + name, stats.ctimeNs)
      if (stats.isDirectory()) visit(path, `${prefix}${name}/`)
    }
  }
  seen.set('.', lstatSync(root, { bigint: true }).ctimeNs)
  visit(root, '')
  return seen
}

/** Which of them the run touched. */
function touched(before: Map<string, bigint>, after: Map<string, bigint>): string[] {
  return [...after].filter(([path, when]) => before.get(path) !== when).map(([path]) => path).sort()
}

/** Linux sets ctime from a clock whose granularity is coarser than a nanosecond, so a snapshot
 *  taken in the same tick as the chown that follows it would compare equal and the measurement
 *  would silently see nothing. Every test below asserts something DID change, which is what makes
 *  that a failure rather than a pass, and this makes it not happen in the first place. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** The layout section 8 walks: an ordinary subtree, the root-owned crontab lock directory, a
 *  staging directory at the root AND one further down, and — outside the root entirely — the victim
 *  a redirected chown would land in. */
function plantStateRoot(t: TestContext, prefix: string): { base: string, data: string, outside: string } {
  const base = createTempDirSync(prefix, t)
  const data = join(base, 'data')
  mkdirSync(join(data, 'uploads/invoices'), { recursive: true })
  writeFileSync(join(data, 'uploads/invoices/a.pdf'), 'an invoice\n')
  // THE LOCK DIRECTORY AT 0755 ON PURPOSE. prepare_crontab_lock() makes it 0700, which the walk's
  // privileged-and-private prune would ALSO withhold — and the mutation below, which empties the
  // identity prune and asserts the lock directory is then handed over, would become vacuous. At
  // 0755 the identity prune is the only thing protecting it, so that mutation still bites.
  mkdirSync(join(data, LOCK_DIRNAME), 0o755)
  writeFileSync(join(data, LOCK_DIRNAME, LOCK_FILENAME), '')
  // THE STAGING DIRECTORIES AT THE SHAPE THE PUBLISHER GIVES THEM: `(umask 077; mkdir)` then
  // `chown -h` to the uid running the publication, which in this same-uid harness is this process's
  // own. Anything else would not be a staging directory, and publish_durable_file() refuses to use
  // one whose `%u|%a` is not `${self}|700`.
  mkdirSync(join(data, STAGE_DIRNAME), 0o700)
  writeFileSync(join(data, STAGE_DIRNAME, 'publish.abc'), 'staged\n')
  mkdirSync(join(data, 'deploy'))
  mkdirSync(join(data, 'deploy', STAGE_DIRNAME), 0o700)
  const outside = join(base, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'f'), 'the victim\n')
  return { base, data, outside }
}

/** The shipped walker, run over `data` as the shell runs it: from INSIDE the root, which is where
 *  enter_service_root() leaves the process, and therefore with `.` as its only pathname. */
function runWalk(data: string, pruneAtRoot: string, opts: { helper?: string, env?: Record<string, string> } = {}): Run {
  return runBash([
    'set -uo pipefail',
    `node ${q(opts.helper ?? CHOWN_TREE)} . "$(${REAL.id} -u)" "$(${REAL.id} -g)" ${q(pruneAtRoot)}`,
    'echo "rc=$?"',
  ].join('\n'), { cwd: data, env: opts.env })
}

/** THE SHIPPED WALKER WITH ITS STAGING PRUNE REMOVED, and nothing else changed — the mutation every
 *  assertion about that prune is measured against. The route is the predicate itself: made to
 *  answer `false`, which is what pruning by a NAME the service account can rename amounts to once
 *  the rename has happened. */
function walkerWithoutShapePrune(t: TestContext): string {
  const shipped = readFileSync(CHOWN_TREE, 'utf8')
  const predicate = 'const privilegedAndPrivate = (stats) => stats.uid === SELF_UID && (stats.mode & 0o777) === 0o700'
  assert.ok(shipped.includes(predicate),
    `precondition: the shipped walker must prune by the shape of a privileged private directory:\n${shipped}`)
  const helper = join(createTempDirSync('ims-secops-noshape-', t), 'chown-tree-noshape.mjs')
  writeFileSync(helper, shipped.replace(predicate, 'const privilegedAndPrivate = () => false'))
  return helper
}

test('[o3d-n8xx] the ownership walk reaches the ordinary tree and hands neither the lock directory nor any staging directory to the service account', (t) => {
  const plant = plantStateRoot(t, 'ims-n8xx-prune-')

  const before = ctimes(plant.data)
  pause(30)
  const run = runWalk(plant.data, LOCK_DIRNAME)
  assert.match(run.stdout, /^rc=0$/m, `the ordinary walk must succeed: ${run.stderr}`)
  const reached = touched(before, ctimes(plant.data))

  // NOT VACUOUS: the walk really did reach the root itself and the ordinary tree below it, so the
  // absences below are a prune and not a walk that did nothing.
  assert.ok(reached.includes('.'), `the root itself must be handed over: ${reached.join(' ')}`)
  assert.ok(reached.includes('uploads'), reached.join(' '))
  assert.ok(reached.includes('uploads/invoices'), reached.join(' '))
  assert.ok(reached.includes('uploads/invoices/a.pdf'), reached.join(' '))
  // AND `deploy` IS REACHED THOUGH THE STAGING DIRECTORY INSIDE IT IS NOT: the prune is the entry,
  // not the subtree it sits in.
  assert.ok(reached.includes('deploy'), reached.join(' '))

  assert.ok(!reached.some((path) => path === LOCK_DIRNAME || path.startsWith(`${LOCK_DIRNAME}/`)),
    `the crontab lock directory may not be handed to the service account: ${reached.join(' ')}`)
  assert.ok(!reached.some((path) => path.split('/').includes(STAGE_DIRNAME)),
    `nor any publication staging directory, at any depth: ${reached.join(' ')}`)

  // MEASURED BY MUTATION, ROUTE STATED (the lock half): the same shipped walker over the same tree
  // with the identity prune's name empty — which is what a caller that forgot it would produce, and
  // what `chown -R` would do if it were used here. The lock directory is then handed over.
  const second = plantStateRoot(t, 'ims-n8xx-noprune-')
  const beforeMutated = ctimes(second.data)
  pause(30)
  const mutated = runWalk(second.data, '')
  assert.match(mutated.stdout, /^rc=0$/m, mutated.stderr)
  const reachedMutated = touched(beforeMutated, ctimes(second.data))
  assert.ok(reachedMutated.includes(LOCK_DIRNAME),
    `without the prune the lock directory is handed over — that is the finding this test exists to fail on: ${reachedMutated.join(' ')}`)
  assert.ok(reachedMutated.includes(`${LOCK_DIRNAME}/${LOCK_FILENAME}`), reachedMutated.join(' '))
  // AND THE STAGING HALF, whose prune is not an argument at all: the shipped walker with its
  // privileged-and-private predicate made to answer `false`. Both staging directories are then
  // handed over, at both depths.
  const third = plantStateRoot(t, 'ims-n8xx-noshape-')
  const beforeShape = ctimes(third.data)
  pause(30)
  const noShape = runWalk(third.data, LOCK_DIRNAME, { helper: walkerWithoutShapePrune(t) })
  assert.match(noShape.stdout, /^rc=0$/m, noShape.stderr)
  const reachedShape = touched(beforeShape, ctimes(third.data))
  assert.ok(reachedShape.includes(STAGE_DIRNAME), reachedShape.join(' '))
  assert.ok(reachedShape.includes(`${STAGE_DIRNAME}/publish.abc`),
    `without the shape prune the contents of an interrupted publication are handed over too: ${reachedShape.join(' ')}`)
  assert.ok(reachedShape.includes(`deploy/${STAGE_DIRNAME}`), reachedShape.join(' '))
})

test('[o3d-secops] a staging directory RENAMED to an ordinary name before the walk is still not handed to the service account', (t) => {
  /**
   * THE r19 CRITICAL, EXHIBITED. The walk used to skip an entry currently NAMED `.ims-publish`, and
   * the justification recorded for that reasoned about which directory the publisher would USE
   * next. The question is what the debris CONTAINS: publish_durable_file() applies the owner and
   * the mode to its temporary and then fills it, and a SIGKILL between the fill and the rename
   * cannot run a failure path — so the staging directory is left holding a complete, root-owned
   * copy of whatever was being published. ${APP_USER} owns the containing directory, so renaming
   * `.ims-publish` to an ordinary name costs them nothing: a rename WITHIN one parent needs no
   * permission on the directory being moved. Under the old rule the walk then met an ordinary name
   * and handed the interrupted publication to the account that renamed it.
   *
   * ROUTE: the shipped walker over the shipped fixture, with the staging directory renamed exactly
   * as the service account would rename it, BEFORE the walk starts.
   */
  const plant = plantStateRoot(t, 'ims-secops-renamed-stage-')
  const debris = 'ordinary-looking'
  // WHAT AN INTERRUPTED PUBLICATION LEAVES. The temporary is `chmod`ed and `chown`ed and then
  // filled; only the rename and the removal are still to come.
  writeFileSync(join(plant.data, STAGE_DIRNAME, 'publish.xyz'), 'DATABASE_URL=secret\n')
  chmodSync(join(plant.data, STAGE_DIRNAME, 'publish.xyz'), 0o600)
  renameSync(join(plant.data, STAGE_DIRNAME), join(plant.data, debris))

  // PRECONDITION: the walk is really being asked about a name it has never heard of.
  assert.equal(existsSync(join(plant.data, STAGE_DIRNAME)), false, 'the staging NAME must be gone')
  assert.equal(lstatSync(join(plant.data, debris)).mode & 0o777, 0o700, 'and the SHAPE must survive the rename')

  const before = ctimes(plant.data)
  pause(30)
  const run = runWalk(plant.data, LOCK_DIRNAME)
  assert.match(run.stdout, /^rc=0$/m, `the walk must still complete: ${run.stderr}`)
  const reached = touched(before, ctimes(plant.data))

  // NOT VACUOUS: the walk reached the ordinary tree, so the absence below is a prune.
  assert.ok(reached.includes('uploads/invoices/a.pdf'), `the ordinary tree must be handed over: ${reached.join(' ')}`)
  assert.ok(!reached.some((path) => path === debris || path.startsWith(`${debris}/`)),
    `a staging directory under any name may not be handed over, nor anything inside it: ${reached.join(' ')}`)

  // MEASURED BY MUTATION, ROUTE STATED: the same fixture in the same state under the shipped walker
  // with its privileged-and-private predicate made to answer `false` — which is precisely what
  // pruning by the NAME `.ims-publish` amounts to once the rename has happened. The interrupted
  // publication is then handed to the account that renamed it, which is the finding.
  const mutant = plantStateRoot(t, 'ims-secops-renamed-stage-mut-')
  writeFileSync(join(mutant.data, STAGE_DIRNAME, 'publish.xyz'), 'DATABASE_URL=secret\n')
  renameSync(join(mutant.data, STAGE_DIRNAME), join(mutant.data, debris))
  const beforeMut = ctimes(mutant.data)
  pause(30)
  const mutated = runWalk(mutant.data, LOCK_DIRNAME, { helper: walkerWithoutShapePrune(t) })
  assert.match(mutated.stdout, /^rc=0$/m, mutated.stderr)
  const reachedMut = touched(beforeMut, ctimes(mutant.data))
  assert.ok(reachedMut.includes(debris), `without the shape prune the renamed staging directory is handed over: ${reachedMut.join(' ')}`)
  assert.ok(reachedMut.includes(`${debris}/publish.xyz`),
    `and with it the contents of the interrupted publication: ${reachedMut.join(' ')}`)
})

test('[o3d-n8xx] a symlinked descendant has its OWN ownership changed and cannot redirect the change outside the root', (t) => {
  const plant = plantStateRoot(t, 'ims-n8xx-nofollow-')
  // THE STATE A RENAME LEAVES BEHIND: at a name that was a directory a moment ago there is now a
  // symlink out of the tree. This is what `find`'s enumeration could not see, and what the walker
  // meets on its way past.
  mkdirSync(join(plant.data, 'd'))
  writeFileSync(join(plant.data, 'd/f'), 'inside\n')
  symlinkSync(plant.outside, join(plant.data, 'link-out'))
  // AND A LINK AT A NAME WHOSE TARGET THIS HARNESS CANNOT CHOWN AT ALL, so a `chown` that FOLLOWED
  // it would fail with EPERM and the run would die — a second, independent witness that it does not.
  symlinkSync('/etc/passwd', join(plant.data, 'link-passwd'))

  const beforeOutside = ctimes(plant.outside)
  const before = ctimes(plant.data)
  pause(30)
  const run = runWalk(plant.data, LOCK_DIRNAME)
  assert.match(run.stdout, /^rc=0$/m, `a symlink in the tree must not end the run: ${run.stderr}`)

  const reached = touched(before, ctimes(plant.data))
  // THE LINKS THEMSELVES ARE RE-OWNED, which is what `chown -h` promised and what `lchown` does.
  assert.ok(reached.includes('link-out'), `the link's own ownership must change: ${reached.join(' ')}`)
  assert.ok(reached.includes('link-passwd'), reached.join(' '))
  assert.ok(reached.includes('d/f'), 'and the ordinary tree beside them is still walked')
  // AND NOTHING THEY POINT AT IS TOUCHED.
  assert.deepEqual(touched(beforeOutside, ctimes(plant.outside)), [],
    'nothing outside the root may be reached through a link inside it')
  assert.equal(statSync('/etc/passwd').uid, 0, 'and the system file the second link names is untouched')
})

test('[o3d-n8xx] a descendant renamed between the enumeration and the chown cannot redirect the ownership change, and the construct this replaced could', (t) => {
  /**
   * THE FINDING, EXECUTED. `find -exec chown -h {} +` prints `data/d/f` while `d` is a directory and
   * runs `chown -h data/d/f` afterwards; `-h` protects `f` and NOT `d`, so a `d` that has become a
   * symlink in between sends the ownership change to `outside/f`.
   *
   * ROUTE. The mutation is the retired construct, run under a real `find` with a `chown` SHIM that
   * performs the rename on its first invocation and then `exec`s the real chown — which is exactly
   * the gap `-exec … +` leaves, since find batches the paths and runs the command after the walk.
   * Nothing about the race is simulated: the enumeration is real, the rename is real, and the chown
   * that follows is the real one, resolving the pathname it was handed.
   *
   * THE SHIPPED WALKER IS THEN GIVEN THE SAME TREE IN THE SAME POST-RENAME STATE. It has no
   * enumeration to be stale, so there is no gap to plant anything in — which is the claim — and the
   * measurement is that `outside/f` is untouched while the link at `d` is re-owned in place.
   */
  const attacked = plantStateRoot(t, 'ims-n8xx-race-')
  mkdirSync(join(attacked.data, 'd'))
  writeFileSync(join(attacked.data, 'd/f'), 'inside\n')

  const raced = join(attacked.base, 'raced')
  const bin = shimDir(t, {
    chown: [
      `if [[ ! -e ${q(raced)} ]]; then`,
      `  : > ${q(raced)}`,
      // THE RENAME THE FINDING IS ABOUT, in the gap find leaves between printing a path and
      // running the command on it.
      `  ${REAL.mv} -T ${q(join(attacked.data, 'd'))} ${q(join(attacked.data, 'd.moved'))}`,
      `  ${REAL.ln} -s ${q(attacked.outside)} ${q(join(attacked.data, 'd'))}`,
      'fi',
      `exec ${realBin('chown')} "$@"`,
    ].join('\n'),
  })

  const beforeOutside = ctimes(attacked.outside)
  pause(30)
  const mutated = runBash([
    'set -uo pipefail',
    // THE RETIRED CONSTRUCT, byte for byte what scripts/install.sh carried before o3d-n8xx.
    `find "${attacked.data}" \\( -path "${join(attacked.data, LOCK_DIRNAME)}" -o -name ${q(STAGE_DIRNAME)} \\) -prune \\`,
    `  -o -exec chown -h "$(${REAL.id} -u):$(${REAL.id} -g)" {} +`,
    'echo "rc=$?"',
  ].join('\n'), { env: { PATH: `${bin}:${process.env.PATH ?? ''}` } })

  // NOT VACUOUS: the shim really fired, and the plant really became a symlink out of the tree.
  assert.ok(existsSync(raced), `the shim must have run: ${mutated.stderr}`)
  assert.equal(lstatSync(join(attacked.data, 'd')).isSymbolicLink(), true,
    'and the directory find enumerated must have been replaced by a link')
  assert.deepEqual(touched(beforeOutside, ctimes(attacked.outside)), ['f'],
    `the enumerating construct must reach the victim through the renamed component — that is the finding: ${mutated.stderr}`)

  // AND THE SHIPPED WALKER, ON THE SAME TREE IN THE SAME STATE.
  const shipped = plantStateRoot(t, 'ims-n8xx-race-shipped-')
  mkdirSync(join(shipped.data, 'd.moved'))
  writeFileSync(join(shipped.data, 'd.moved/f'), 'inside\n')
  symlinkSync(shipped.outside, join(shipped.data, 'd'))
  const beforeShippedOutside = ctimes(shipped.outside)
  const beforeShipped = ctimes(shipped.data)
  pause(30)
  const run = runWalk(shipped.data, LOCK_DIRNAME)
  assert.match(run.stdout, /^rc=0$/m, run.stderr)
  const reached = touched(beforeShipped, ctimes(shipped.data))
  assert.ok(reached.includes('d'), `the link at the renamed name must be re-owned in place: ${reached.join(' ')}`)
  assert.ok(reached.includes('d.moved/f'), 'and the directory that was renamed aside is still walked')
  assert.deepEqual(touched(beforeShippedOutside, ctimes(shipped.outside)), [],
    'and NOTHING outside the root may be reached, which is the whole of o3d-n8xx')
})

test('[o3d-n8xx] the walker refuses rather than changing ownership by pathname when it cannot address a directory by descriptor', (t) => {
  /**
   * The mechanism is `/proc/self/fd/N/child`, which the kernel resolves from the OPEN FILE. A
   * walker that fell back to composing a pathname when it could not do that would be the defect
   * with an extra step, so the absence of /proc is a refusal — the same decision the pre-flight
   * gate makes, in the program that depends on it.
   *
   * ROUTE: the shipped file with its `/proc/self/fd` availability check pointed at a path that does
   * not exist, which is what a host with no /proc presents.
   */
  const base = createTempDirSync('ims-n8xx-noproc-', t)
  const shipped = readFileSync(CHOWN_TREE, 'utf8')
  assert.ok(shipped.includes("statSync('/proc/self/fd')"),
    'precondition: the shipped walker must check that /proc is there')
  const helper = join(base, 'chown-tree-noproc.mjs')
  writeFileSync(helper, shipped.replace("statSync('/proc/self/fd')", "statSync('/proc/self/fd-absent')"))

  const plant = plantStateRoot(t, 'ims-n8xx-noproc-tree-')
  const before = ctimes(plant.data)
  pause(30)
  const run = runWalk(plant.data, LOCK_DIRNAME, { helper })
  assert.match(run.stdout, /^rc=1$/m, `a walker that cannot hold a descriptor must refuse: ${run.stderr}`)
  assert.match(run.stderr, /is not available/, run.stderr)
  assert.deepEqual(touched(before, ctimes(plant.data)), [],
    'and it must refuse before it changes anything, not part of the way through')

  // NOT VACUOUS: the identical fixture under the SHIPPED file walks the tree.
  const ok = runWalk(plant.data, LOCK_DIRNAME)
  assert.match(ok.stdout, /^rc=0$/m, ok.stderr)
})

test('[o3d-n8xx] the shipped call site walks by descriptor, prunes by single component, and holds the lock PATH and the lock NAME to each other', () => {
  // WHAT MAY NO LONGER BE THERE. The construct is named by its shape rather than by one spelling:
  // any `find` over ${DATA_DIR} that hands paths to a `chown` is the finding, however it is written.
  const code = INSTALL_SH.split('\n').filter((line) => !line.trimStart().startsWith('#'))
  const enumerating = code.filter((line) => /^find\s/.test(line.trimStart()) && line.includes('DATA_DIR'))
  assert.deepEqual(enumerating, [],
    `no line may enumerate ${'${DATA_DIR}'} with find and chown what it prints:\n${enumerating.join('\n')}`)
  assert.ok(!code.some((line) => /-exec\s+chown/.test(line)),
    'and no `find -exec chown` may survive anywhere in the installer')

  // AND WHAT MUST BE. The call names the identity prune as a SINGLE COMPONENT, from the constant
  // that defines it, so a rename of that constant cannot leave the prune pointing at nothing.
  const call = code.find((line) => line.startsWith('chown_state_tree "${DATA_DIR}"'))
  assert.ok(call, `scripts/install.sh must hand ${'${DATA_DIR}'} to the descriptor walk:\n${code.slice(-1)}`)
  assert.ok(call.includes('"${CRONTAB_LOCK_DIRNAME}"'), call)
  // AND WHAT MAY NOT BE (o3d-secops r19, Codex CRITICAL): the staging directories are NOT named
  // here. They were, and a name the service account can rename is not a security boundary — see
  // the renamed-staging-directory regression above. A call site that reintroduced the argument
  // would be reintroducing the finding, so it is refused here rather than left to a comment.
  assert.ok(!call.includes('PUBLISH_STAGE_DIRNAME'),
    `the staging prune is a SHAPE and not a name; the call site may not pass one:\n${call}`)

  // AND THE ONE FACT THAT COULD SILENTLY UNDO THE PRUNE is checked in the script rather than
  // assumed: the lock directory's PATH and its NAME have to compose.
  const guard = code.find((line) => line.includes('"${CRONTAB_LOCK_DIR}" == "${DATA_DIR%/}/${CRONTAB_LOCK_DIRNAME}"'))
  assert.ok(guard, `the composition of ${'${CRONTAB_LOCK_DIR}'} must be asserted before it is relied on:\n${code.join('\n').slice(-2000)}`)

  // AND THE WALK IT CALLS IS DESCRIPTOR-RELATIVE, which is the property the whole finding is about.
  const walker = readFileSync(CHOWN_TREE, 'utf8')
  assert.match(walker, /constants\.O_NOFOLLOW/, 'nothing is opened by a name that may be followed')
  assert.match(walker, /const OPEN_ENTRY = O_PATH \| constants\.O_NOFOLLOW/,
    'every entry, of every type, is opened once from its parent descriptor')
  assert.match(walker, /chownSync\(held\(fd\), uid, gid\)/,
    'and the ownership change is aimed at the descriptor that open returned')

  // AND NO OWNERSHIP CHANGE MAY NAME AN ENTRY (o3d-secops r20, Codex HIGH). This is the whole of
  // the finding as a property of the text: `lchown`/`chown` of `at(dirFd, name)` is a SECOND
  // resolution of a name the walk has already looked up, and the owner of the parent is live in
  // between. It is asserted by shape rather than by one spelling, so a reintroduction under another
  // name is caught too.
  const namedChown = walker.split('\n')
    .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
    .filter((line) => /\b(l?chownSync|fchownatSync)\s*\(\s*at\(/.test(line))
  assert.deepEqual(namedChown, [],
    `no ownership change in the walker may resolve an entry's NAME; that is the r20 finding:\n${namedChown.join('\n')}`)
  assert.ok(!/\blchownSync\b/.test(walker),
    'and the by-name primitive is not imported at all, so it cannot come back by accident')
})

// ---------------------------------------------------------------------------
// THE TYPE-SWAP RACE THE PRUNE COULD NOT SEE (o3d-secops r20, Codex HIGH)
//
// Both prunes are consulted only once the walk has decided an entry is a DIRECTORY, and that
// decision used to come from an `lstat()` OF THE NAME while the ownership change that followed was
// an `lchown()` OF THE SAME NAME. Two lookups, with ${APP_USER} — who owns the parent and is still
// running, because section 8 precedes the stop — live in between. A sacrificial regular file at a
// name, and a `rename(2)` within that one parent (which needs no permission on what is moved), puts
// the staging directory at the name after `lstat` has answered "not a directory": the prune is
// never reached, `lchown` on a directory is exactly `chown`, and the debris of an interrupted
// publication is handed to the account that planted the swap.
//
// HOW THE RACE IS MADE DETERMINISTIC. It is planted, not waited for. The walker under test is
// written out with ONE statement inserted at the instant the attacker's rename would land — after
// that version's single lookup of the name and before it acts on it — which is the same technique
// the o3d-n8xx race above uses with its `chown` shim: the enumeration, the rename and the ownership
// change are all real, and only WHEN the rename happens is decided by the harness.
//
// HOW THE EFFECT IS MEASURED. Not by ctime taken before the run: `rename(2)` updates the ctime of
// the inode it moves, so the swap itself would show as a change and every assertion would be
// vacuous. The shim records the staging directory's ctime AT THE MOMENT OF THE SWAP, and the test
// compares that witness with the ctime after the walk has finished. Only an ownership change made
// after the swap can move it.
// ---------------------------------------------------------------------------

/** The attacker, as a module prelude the shimmed walker carries. `__swap` fires once, on the entry
 *  the test names, and leaves the witness behind. */
const SWAP_SHIM = `
import { renameSync as __renameSync, lstatSync as __lstatSync, writeFileSync as __writeFileSync } from 'node:fs'
const __base = process.env.SWAP_BASE
let __stage = 0
const __witness = (path) => __writeFileSync(process.env.SWAP_WITNESS, String(__lstatSync(path, { bigint: true }).ctimeNs))
/** A regular file is renamed aside and the staging directory takes its name. */
const __swapInStaging = (name) => {
  if (__stage !== 0 || name !== process.env.SWAP_NAME) return
  __stage = 1
  __renameSync(\`\${__base}/\${name}\`, \`\${__base}/\${name}.moved\`)
  __renameSync(\`\${__base}/\${process.env.SWAP_STAGING}\`, \`\${__base}/\${name}\`)
  __witness(\`\${__base}/\${name}\`)
}
/** The directory at the name is renamed aside and a plain file takes its place, so an O_DIRECTORY
 *  open of that name is answered ENOTDIR. */
const __swapOutDirectory = (name) => {
  if (__stage !== 0 || name !== process.env.SWAP_NAME) return
  __stage = 1
  __renameSync(\`\${__base}/\${name}\`, \`\${__base}/\${name}.moved\`)
  __renameSync(\`\${__base}/plainfile\`, \`\${__base}/\${name}\`)
}
/** And then the staging directory takes it, which is what the by-name fallback then chowns. */
const __swapInStagingAfterFailedOpen = (name) => {
  if (__stage !== 1 || name !== process.env.SWAP_NAME) return
  __stage = 2
  __renameSync(\`\${__base}/\${name}\`, \`\${__base}/plain.moved\`)
  __renameSync(\`\${__base}/\${process.env.SWAP_STAGING}\`, \`\${__base}/\${name}\`)
  __witness(\`\${__base}/\${name}\`)
}
`

/** Writes a copy of `source` carrying the shim, with `inserted` placed at `anchor`. */
function shimmedWalker(t: TestContext, prefix: string, source: string, anchor: string, inserted: string): string {
  assert.equal(source.split(anchor).length - 1, 1, `precondition: the insertion point must be unique:\n${anchor}`)
  assert.equal(source.split('const MAX_DEPTH = 512').length - 1, 1, 'precondition: the shim needs somewhere to go')
  const shimmed = source
    .replace('const MAX_DEPTH = 512', `${SWAP_SHIM}\nconst MAX_DEPTH = 512`)
    .replace(anchor, `${anchor}\n${inserted}`)
  const helper = join(createTempDirSync(prefix, t), 'chown-tree-shimmed.mjs')
  writeFileSync(helper, shimmed)
  return helper
}

/** WHERE THE SHIPPED WALKER LOOKS THE NAME UP, AND THE ONLY PLACE IT DOES. Everything after this
 *  line is a question about the descriptor, which is the claim under test. */
const SHIPPED_LOOKUP = `    const entryFd = openEntry(dirFd, name)
    if (entryFd === null) continue`

/**
 * THE PRE-r20 PER-ENTRY HANDLING, RETYPED — as the retired `find -exec chown` construct above is
 * retyped, and for the same reason: a mutation has to be the defect itself, and the defect is no
 * longer in the file to lift. `lstat` decides, `lchown` acts, and both name the entry. The two
 * `__swap*` calls mark the two instants at which the account that owns the parent gets to move.
 */
const PRE_R20_BLOCK = `    let entry
    try {
      entry = lstatSync(at(dirFd, name))
    } catch (error) {
      if (RACED.has(error.code)) continue
      die(\`\${name} below \${root} could not be examined: \${error.code ?? error.message}.\`)
    }
    if (!entry.isDirectory()) {
      __swapInStaging(name)
      chownEntryByName(dirFd, name)
      continue
    }
    __swapOutDirectory(name)
    const childFd = openChildDir(dirFd, name)
    if (childFd === null) {
      __swapInStagingAfterFailedOpen(name)
      chownEntryByName(dirFd, name)
      continue
    }
    try {
      const stats = fstatSync(childFd)
      if (protectedIds.has(identity(stats))) continue
      if (privilegedAndPrivate(stats)) continue
      chownSync(held(childFd), uid, gid)
      walk(childFd, depth + 1)
    } finally {
      closeSync(childFd)
    }`

/** What that block needs and the shipped file no longer imports or defines. */
const PRE_R20_PRELUDE = `
import { lchownSync as __lchownSync, lstatSync } from 'node:fs'
const chownEntryByName = (dirFd, name) => {
  try {
    __lchownSync(at(dirFd, name), uid, gid)
  } catch (error) {
    if (error.code === 'ENOENT') return
    die(\`the ownership of \${name} below \${root} could not be changed: \${error.code ?? error.message}.\`)
  }
}
`

/** The shipped walker with its per-entry handling replaced by the pre-r20 one, and NOTHING else
 *  changed — the prunes, the identity record, the descriptor descent and the refusals are the
 *  shipped ones. The route every assertion below states. */
function walkerBeforeR20(t: TestContext): string {
  const shipped = readFileSync(CHOWN_TREE, 'utf8')
  const open = shipped.indexOf(SHIPPED_LOOKUP)
  assert.ok(open >= 0, `precondition: the shipped walker must look each entry up exactly once:\n${SHIPPED_LOOKUP}`)
  const closer = '      closeSync(entryFd)\n    }'
  const end = shipped.indexOf(closer, open)
  assert.ok(end > open, 'precondition: and close the descriptor it opened')
  const body = shipped.slice(open, end + closer.length)
  assert.ok(body.includes('chownPinned(entryFd, name)'), `precondition: through the descriptor:\n${body}`)
  const mutated = shipped
    .replace('const MAX_DEPTH = 512', `${SWAP_SHIM}${PRE_R20_PRELUDE}\nconst MAX_DEPTH = 512`)
    .replace(body, PRE_R20_BLOCK)
  const helper = join(createTempDirSync('ims-secops-r20-pre-', t), 'chown-tree-pre-r20.mjs')
  writeFileSync(helper, mutated)
  return helper
}

/** ctime of one path, as the shim records it. */
function ctimeOf(path: string): string {
  return String(lstatSync(path, { bigint: true }).ctimeNs)
}

test('[o3d-secops r20] a file swapped for the staging directory between the walk\'s lookup and its ownership change is NOT handed over, and the two-lookup construct handed it over', (t) => {
  /**
   * ROUTE. The shipped walker, with the attacker's rename planted immediately after its ONE lookup
   * of the name — `openEntry()` — which is the latest instant at which it could possibly matter.
   * The staging directory carries the shape publish_durable_file() gives it, so it is exactly the
   * debris an interrupted publication leaves.
   */
  const plant = plantStateRoot(t, 'ims-secops-r20-shipped-')
  writeFileSync(join(plant.data, 'decoy'), 'sacrificial\n')
  writeFileSync(join(plant.data, STAGE_DIRNAME, 'publish.xyz'), 'DATABASE_URL=secret\n')
  const witness = join(plant.base, 'witness')
  const env = { SWAP_BASE: plant.data, SWAP_NAME: 'decoy', SWAP_STAGING: STAGE_DIRNAME, SWAP_WITNESS: witness }

  const helper = shimmedWalker(t, 'ims-secops-r20-shim-', readFileSync(CHOWN_TREE, 'utf8'), SHIPPED_LOOKUP, '    __swapInStaging(name)')
  const before = ctimes(plant.data)
  pause(30)
  const run = runWalk(plant.data, LOCK_DIRNAME, { helper, env })
  assert.match(run.stdout, /^rc=0$/m, `the walk must complete across the swap: ${run.stderr}`)

  // NOT VACUOUS, AND THE PRECONDITION IS ASSERTED RATHER THAN ASSUMED: the swap really happened,
  // and the staging directory really is what now sits at the name the walk was about to act on.
  assert.equal(existsSync(witness), true, `the shim must have fired: ${run.stderr}${run.stdout}`)
  assert.equal(lstatSync(join(plant.data, 'decoy')).isDirectory(), true, 'and a DIRECTORY must now be at the name')
  assert.equal(lstatSync(join(plant.data, 'decoy')).mode & 0o777, 0o700, 'wearing the staging shape')
  assert.equal(existsSync(join(plant.data, 'decoy.moved')), true, 'with the sacrificial file renamed aside')

  // THE CLAIM: nothing touched the staging directory after the swap put it there.
  assert.equal(ctimeOf(join(plant.data, 'decoy')), readFileSync(witness, 'utf8'),
    'the staging directory may not be handed over by a name the walk had already looked up')
  // AND THE WALK REALLY RAN: the ordinary tree was handed over, and so was the inode the walk had
  // pinned before the swap — which is now called `decoy.moved`, and is the sacrificial file.
  const reached = touched(before, ctimes(plant.data))
  assert.ok(reached.includes('uploads/invoices/a.pdf'), `the ordinary tree must be handed over: ${reached.join(' ')}`)
  assert.ok(reached.includes('decoy.moved'),
    `and the entry the walk pinned before the swap is the one it chowned: ${reached.join(' ')}`)

  // MEASURED BY MUTATION, ROUTE STATED: the same fixture, the same swap at the same instant, under
  // the shipped walker whose per-entry handling is the pre-r20 one — `lstat` the name, `lchown` the
  // name. The staging directory is then handed over, which is the finding.
  const mutant = plantStateRoot(t, 'ims-secops-r20-mutant-')
  writeFileSync(join(mutant.data, 'decoy'), 'sacrificial\n')
  writeFileSync(join(mutant.data, STAGE_DIRNAME, 'publish.xyz'), 'DATABASE_URL=secret\n')
  const mutantWitness = join(mutant.base, 'witness')
  const mutated = runWalk(mutant.data, LOCK_DIRNAME, {
    helper: walkerBeforeR20(t),
    env: { SWAP_BASE: mutant.data, SWAP_NAME: 'decoy', SWAP_STAGING: STAGE_DIRNAME, SWAP_WITNESS: mutantWitness },
  })
  assert.match(mutated.stdout, /^rc=0$/m, mutated.stderr)
  assert.equal(existsSync(mutantWitness), true, `the shim must have fired under the mutant too: ${mutated.stderr}`)
  assert.notEqual(ctimeOf(join(mutant.data, 'decoy')), readFileSync(mutantWitness, 'utf8'),
    'the two-lookup construct hands the interrupted publication to the account that swapped it in — that is the finding this test exists to fail on')
})

test('[o3d-secops r20] the directory recursion had the SAME second lookup, and an entry that stops being a directory before the open no longer falls back to it', (t) => {
  /**
   * THE OTHER HALF OF THE FINDING. The directory branch opened the name with `O_DIRECTORY |
   * O_NOFOLLOW` — which is safe — but when that open was answered ENOTDIR or ELOOP it fell back to
   * `chownEntry(dirFd, name)`: the identical second lookup. So the swap in the other direction
   * worked too. A directory is renamed aside and a plain file put at its name (the open fails), and
   * then the staging directory is renamed onto that name (the fallback chowns it).
   *
   * ROUTE. Two planted renames at the two instants the account that owns the parent would use them:
   * one after `lstat` has called the entry a directory, one after the `O_DIRECTORY` open has
   * refused it. Under the shipped walker both are planted after its single `openEntry()`, because
   * that is the only lookup it makes and there is no second one to aim at.
   */
  const plant = plantStateRoot(t, 'ims-secops-r20-recursion-')
  mkdirSync(join(plant.data, 'd'))
  writeFileSync(join(plant.data, 'd/f'), 'inside\n')
  writeFileSync(join(plant.data, 'plainfile'), 'plain\n')
  writeFileSync(join(plant.data, STAGE_DIRNAME, 'publish.xyz'), 'DATABASE_URL=secret\n')
  const witness = join(plant.base, 'witness')
  const env = { SWAP_BASE: plant.data, SWAP_NAME: 'd', SWAP_STAGING: STAGE_DIRNAME, SWAP_WITNESS: witness }

  const helper = shimmedWalker(t, 'ims-secops-r20-recursion-shim-', readFileSync(CHOWN_TREE, 'utf8'),
    SHIPPED_LOOKUP, '    __swapOutDirectory(name)\n    __swapInStagingAfterFailedOpen(name)')
  const before = ctimes(plant.data)
  pause(30)
  const run = runWalk(plant.data, LOCK_DIRNAME, { helper, env })
  assert.match(run.stdout, /^rc=0$/m, `the walk must complete across both renames: ${run.stderr}`)

  // NOT VACUOUS: both renames landed, and the staging directory is at the name.
  assert.equal(existsSync(witness), true, `both stages of the shim must have fired: ${run.stderr}${run.stdout}`)
  assert.equal(lstatSync(join(plant.data, 'd')).mode & 0o777, 0o700, 'the staging directory must be at the name')
  assert.equal(existsSync(join(plant.data, 'd.moved/f')), true, 'and the real directory renamed aside')

  assert.equal(ctimeOf(join(plant.data, 'd')), readFileSync(witness, 'utf8'),
    'a directory swapped in after the open may not be handed over by a name resolved a second time')
  // AND THE PINNED DIRECTORY WAS STILL WALKED, under whatever name it now wears: the descriptor is
  // the subject, so the recursion followed the inode the walk opened and not the name it came by.
  const reached = touched(before, ctimes(plant.data))
  assert.ok(reached.includes('d.moved'), `the directory the walk pinned must be handed over: ${reached.join(' ')}`)
  assert.ok(reached.includes('d.moved/f'), `and descended into: ${reached.join(' ')}`)

  // MEASURED BY MUTATION, ROUTE STATED: the pre-r20 per-entry handling, whose failed `O_DIRECTORY`
  // open falls back to `lchown` of the name.
  const mutant = plantStateRoot(t, 'ims-secops-r20-recursion-mutant-')
  mkdirSync(join(mutant.data, 'd'))
  writeFileSync(join(mutant.data, 'd/f'), 'inside\n')
  writeFileSync(join(mutant.data, 'plainfile'), 'plain\n')
  writeFileSync(join(mutant.data, STAGE_DIRNAME, 'publish.xyz'), 'DATABASE_URL=secret\n')
  const mutantWitness = join(mutant.base, 'witness')
  const mutated = runWalk(mutant.data, LOCK_DIRNAME, {
    helper: walkerBeforeR20(t),
    env: { SWAP_BASE: mutant.data, SWAP_NAME: 'd', SWAP_STAGING: STAGE_DIRNAME, SWAP_WITNESS: mutantWitness },
  })
  assert.match(mutated.stdout, /^rc=0$/m, mutated.stderr)
  assert.equal(existsSync(mutantWitness), true, `both stages must have fired under the mutant: ${mutated.stderr}`)
  assert.notEqual(ctimeOf(join(mutant.data, 'd')), readFileSync(mutantWitness, 'utf8'),
    'the fallback after a failed O_DIRECTORY open hands the staging directory over — the same gap, one branch further along')
})

test('[o3d-secops r20] the walker proves it has O_PATH rather than assuming it, and refuses when the flag is ignored', (t) => {
  /**
   * `open(2)` IGNORES flag bits it does not know. A kernel without O_PATH would therefore hand this
   * walk ORDINARY read descriptors and say nothing — and the walk would then block forever on the
   * first fifo in ${DATA_DIR} and refuse the first symlink. The proof is one `fchown()` on the root
   * descriptor: EBADF means O_PATH, anything else means it was ignored.
   *
   * ROUTE: the shipped file with O_PATH set to zero, which is exactly what a kernel that ignored
   * the flag would produce.
   */
  const shipped = readFileSync(CHOWN_TREE, 'utf8')
  const declaration = 'const O_PATH = 0o010000000'
  assert.ok(shipped.includes(declaration), `precondition: the walker must spell O_PATH itself:\n${shipped}`)
  const helper = join(createTempDirSync('ims-secops-r20-nopath-', t), 'chown-tree-nopath.mjs')
  writeFileSync(helper, shipped.replace(declaration, 'const O_PATH = 0'))

  const plant = plantStateRoot(t, 'ims-secops-r20-nopath-tree-')
  const before = ctimes(plant.data)
  pause(30)
  const run = runWalk(plant.data, LOCK_DIRNAME, { helper })
  assert.match(run.stdout, /^rc=1$/m, `a walk without O_PATH must refuse: ${run.stderr}`)
  assert.match(run.stderr, /O_PATH/, run.stderr)
  assert.deepEqual(touched(before, ctimes(plant.data)).filter((path) => path !== '.'), [],
    'and refuse before it walks anything, not part of the way through')

  // NOT VACUOUS: the identical fixture under the SHIPPED file walks the tree.
  const ok = runWalk(plant.data, LOCK_DIRNAME)
  assert.match(ok.stdout, /^rc=0$/m, ok.stderr)
})

test('[o3d-secops r20] a fifo in the state directory is re-owned without the walk opening it for reading', (t) => {
  /**
   * The r20 fix opens EVERY entry, where the retired construct opened only directories. That is
   * only safe because O_PATH does not open the file: an ordinary `open()` of a fifo with no writer
   * blocks until one arrives, which in ${DATA_DIR} would hang the installer for ever. The fixture
   * is a fifo nothing will ever write to.
   *
   * ROUTE: the shipped walker, under the harness deadline, over a tree containing one.
   */
  const plant = plantStateRoot(t, 'ims-secops-r20-fifo-')
  const made = runBash(`mkfifo ${q(join(plant.data, 'pipe'))}`)
  assert.equal(made.status, 0, `precondition: the fixture needs a fifo: ${made.stderr}`)
  assert.equal(lstatSync(join(plant.data, 'pipe')).isFIFO(), true, 'and it must really be one')

  const before = ctimes(plant.data)
  pause(30)
  const run = runWalk(plant.data, LOCK_DIRNAME)
  assert.match(run.stdout, /^rc=0$/m, `the walk must not block on a fifo: ${run.stderr}`)
  const reached = touched(before, ctimes(plant.data))
  assert.ok(reached.includes('pipe'), `and the fifo is handed over like any other entry: ${reached.join(' ')}`)
})

// ---------------------------------------------------------------------------
// The two sites whose surrounding block cannot be run here (it calls the GitHub API and
// ssh-keygen), asserted on the shipped text: what they must NO LONGER contain.
// ---------------------------------------------------------------------------

test('[o3d-czpy] no root-side write into a service-writable directory is left un-published', () => {
  // Site 2. `cat >` truncates and fills the name; the chmod and chown after it aim two more
  // root-side operations at whatever that name resolves to.
  assert.ok(!/cat > "\$\{DEPLOY_META_FILE\}"/.test(INSTALL_SH),
    '${APP_DIR}/.deploy-meta must be published, not truncated and filled in place')
  assert.ok(!/chmod 600 "\$\{DEPLOY_META_FILE\}"/.test(INSTALL_SH),
    'and its mode must travel with the publication, not follow it')
  assert.match(INSTALL_SH, /\| publish_durable_file "\$\{DEPLOY_META_FILE\}" "\$\{APP_USER\}:\$\{APP_USER\}" 600/)

  // Site 3. The redirection into ${DEPLOY_SSH_DIR} is what wrote through the planted link; the
  // rename after it was the only safe step of the four and it happened last.
  assert.ok(!/> "\$\{DEPLOY_SSH_KNOWN_HOSTS\}\.tmp"/.test(INSTALL_SH),
    'ssh-keyscan must not redirect into a name inside a directory ${APP_USER} owns')
  assert.ok(!/chmod 600 "\$\{DEPLOY_SSH_KNOWN_HOSTS\}"/.test(INSTALL_SH))
  assert.match(INSTALL_SH, /\| publish_durable_file "\$\{DEPLOY_SSH_KNOWN_HOSTS\}" "\$\{APP_USER\}:\$\{APP_USER\}" 600/)

  // Site 4. chmod has no --no-dereference on Linux, so a raced one is the same escalation with
  // another verb; the mode comes from the umask and a wrong one is refused.
  assert.ok(!/chmod 700 "\$\{DEPLOY_SSH_DIR\}"/.test(INSTALL_SH),
    'the deploy-key directory must be created at 0700, not chmod\'ed to it afterwards')
  assert.ok(!/chown -R "\$\{APP_USER\}:\$\{APP_USER\}" "\$\{DEPLOY_SSH_DIR\}"/.test(INSTALL_SH),
    'and chown -R dereferences its OPERAND, so the directory takes chown -h')

  // Site 6. /tmp is 1777, so this one was reachable by any local user and not only by ${APP_USER}.
  // Nothing in the application opens /tmp/${APP_NAME}: it uses os.tmpdir()/onetwoinventory.
  assert.ok(!/\/tmp\/\$\{APP_NAME\}\/(pdf|uploads)/.test(INSTALL_SH.replace(/^#.*$/gm, '')),
    'scripts/install.sh must not create directories under /tmp/${APP_NAME}: nothing reads them')

  // Site 8, both occurrences.
  assert.ok(!/cp -a "\$\{TMP_CLONE_WORKTREE\}\/\.git" "\$\{APP_DIR\}\/\.git"/.test(INSTALL_SH),
    'the git metadata must be copied into a directory this run created and pinned')
  assert.equal(INSTALL_SH.match(/copy_tree_into_new_dir "\$\{TMP_CLONE_WORKTREE\}\/\.git" "\$\{APP_DIR\}\/\.git"/g)?.length, 2,
    'both clone paths go through it')
})

/**
 * THE THREE ROOTS THEMSELVES, GATED BEFORE ANY ROOT-SIDE WRITE FOLLOWS ONE (o3d-secops r7)
 *
 * THE FINDING. Round 6 (o3d-rn10 r5) hardened the PUBLISHER to refuse a symlinked root and told
 * the operator to bind-mount instead. The INSTALLER kept the old behaviour at the same three
 * names: enter_service_subdir() opens with `mkdir -p "${root}"` and `cd -P "${root}"`, and section
 * 8 opens with a bare `mkdir -p "${DATA_DIR}" "${LOG_DIR}"`. Both FOLLOW a link at the root, and
 * both run long before any publication reaches the refusal — so `useradd --create-home`, the
 * upload migration, the crontab-lock preparation, the cron backup, `rsync`, `git clone` and every
 * `chown -R` acted through a planted root, and the rule that forbids it arrived afterwards. The
 * same decision applied in one place and not the other; a gate that runs after the writes it
 * guards is not a gate.
 *
 * WHAT THESE TESTS MEASURE. Each plants a REAL symlink on a real filesystem, runs the SHIPPED gate
 * followed by the SHIPPED section-8 statements under a real bash, and asserts the directory the
 * link resolves to is untouched — and then runs the identical rig WITHOUT the gate line and shows
 * the writes landing in it. The mutation is one deleted line of shipped text, which is the finding
 * itself, executed.
 *
 * WHAT AN UNPRIVILEGED HARNESS STILL CANNOT SHOW is unchanged from the note at the top of this
 * file: the attacker and the privileged party are one uid here. `chown -R` is therefore stubbed
 * where it appears — what is measured about it is that it is never REACHED, which is precisely the
 * ordering claim — while every `mkdir` is real and its effect on the victim is real.
 */

/** The gate, the walk it asks through, and the refusal it shares with the publisher. A rig missing
 *  any of them fails with "command not found" and every "the run must refuse" assertion passes for
 *  the wrong reason, so they travel together. */
/** WHAT THE REFUSAL MAY NO LONGER CONTAIN (o3d-secops r8, Codex HIGH). Not a spelling check on one
 *  command: the finding is that a copy-pasteable SEQUENCE was printed at all, so what is asserted
 *  is the absence of every verb such a sequence needs. A future author who re-adds one step of it
 *  fails these two tests rather than only the one that named that step. */
const NO_PASTEABLE_COMMAND = [/mount --bind/, /\bmkdir\b/, /\brm\b/, /\/etc\/fstab/, /\bumount\b/, /\bfindmnt\b/, /\bln -s\b/] as const

const ROOT_GATE = ['publish_trust_root_candidates', 'refuse_symlinked_root', 'pin_publish_root_parent', 'pin_service_root_parent', 'service_root_entry_kind', 'require_real_service_root'] as const

/** The declaration the gate records what it approved into, lifted rather than retyped: under
 *  `set -u` a rig without it dies on the first `${SERVICE_ROOT_APPROVED[…]-}`, and every "the run
 *  must refuse" assertion would pass for the wrong reason. */

/** The gate's ACTING twin (o3d-secops r7 second pass): it creates or accepts the root, proves it,
 *  and leaves the process inside it, so section 8's ownership change is aimed at an inode. */
const ROOT_ENTER = [...ROOT_GATE, 'enter_service_root'] as const

/**
 * A SHIPPED TOP-LEVEL STATEMENT, LIFTED WHOLE — line continuations included — rather than retyped.
 *
 * Every statement these tests run after the gate is one scripts/install.sh actually executes. A
 * retyped `mkdir -p` would measure the harness author's idea of section 8, and the finding is
 * exactly that section 8 says something the author of the round-6 fix did not expect it to.
 */
function shippedStatement(firstLine: string): string {
  const lines = INSTALL_SH.split('\n')
  const at: number[] = []
  lines.forEach((line, index) => { if (line === firstLine) at.push(index) })
  assert.equal(at.length, 1,
    `scripts/install.sh must contain exactly one line ${JSON.stringify(firstLine)} — found ${at.length}. `
    + 'A statement this file lifts by its text is not a statement it may find twice or not at all.')
  const out = [lines[at[0]]]
  let index = at[0]
  while (out[out.length - 1].endsWith('\\')) {
    index += 1
    assert.ok(index < lines.length, 'a lifted statement ran off the end of the file')
    out.push(lines[index])
  }
  return out.join('\n')
}

/**
 * A SHIPPED `if ! ( … ); then … fi` BLOCK, lifted from its unique opening line to the `fi` that
 * closes it. Section 8 guards its two root operations that way rather than with `( … ) || die`,
 * because a compound command on the left of `||` runs with `set -e` ignored — so the block, and
 * not just its first line, is what these tests must run.
 */
function shippedIfBlock(firstLine: string): string {
  const lines = INSTALL_SH.split('\n')
  const at: number[] = []
  lines.forEach((line, index) => { if (line === firstLine) at.push(index) })
  assert.equal(at.length, 1,
    `scripts/install.sh must contain exactly one line ${JSON.stringify(firstLine)} — found ${at.length}.`)
  const out: string[] = []
  for (let index = at[0]; index < lines.length; index += 1) {
    out.push(lines[index])
    if (lines[index] === 'fi') return out.join('\n')
  }
  throw new assert.AssertionError({ message: `the block opened at ${JSON.stringify(firstLine)} is not closed by a top-level fi` })
}

/** The three calls, as the shipped script spells them. */
const GATE_APP = shippedStatement('require_real_service_root "${APP_DIR}"  "the application directory"')
const GATE_DATA = shippedStatement('require_real_service_root "${DATA_DIR}" "the state directory"')
const GATE_LOG = shippedStatement('require_real_service_root "${LOG_DIR}"  "the log directory"')

/** Section 8's own writes, in the order it makes them. */
const SECTION8_ROOT_MKDIR = [
  shippedStatement('SERVICE_ROOT_CWD="$(pwd -P)" || die "this run cannot establish its own working directory, so it will not walk into its state roots and back. Nothing has been changed."'),
  shippedStatement('enter_service_root "${DATA_DIR}" 022 "the state directory"'),
  shippedStatement('cd "${SERVICE_ROOT_CWD}" || die "this run could not return to ${SERVICE_ROOT_CWD} after creating ${DATA_DIR}. Nothing further has been changed."'),
  shippedStatement('enter_service_root "${LOG_DIR}" 022 "the log directory"'),
  shippedStatement('cd "${SERVICE_ROOT_CWD}" || die "this run could not return to ${SERVICE_ROOT_CWD} after creating ${LOG_DIR}. Nothing further has been changed."'),
].join('\n')
const SECTION8_DATA_SUBDIRS = shippedStatement('mkdir_service_subdir "${DATA_DIR}" 022 \\')
const SECTION8_APP_SUBDIRS = shippedStatement('mkdir_service_subdir "${APP_DIR}" 022 "${APP_DIR}/backups"')
const SECTION8_LOG_CHOWN = shippedIfBlock('if ! (')

/**
 * SECTION 8 AS IT STOOD AT 8d8019ef — the two statements this round replaced, retyped HERE and
 * nowhere else.
 *
 * The mutations below need the PRE-ROUND installer, not the shipped one: the shipped
 * enter_service_root() refuses a symlinked root of its own accord, so a mutation that only removed
 * the pre-flight gate would be caught by the second line of defence and would prove nothing about
 * the first. Running the old text is running the finding.
 *
 * Both are asserted ABSENT from the shipped script, so this block cannot quietly become a copy of
 * what is already there.
 */
const PRE_ROUND_ROOT_MKDIR = 'mkdir -p "${DATA_DIR}" "${LOG_DIR}"'
const PRE_ROUND_LOG_CHOWN = 'chown -R "${APP_USER}:${APP_USER}" "${LOG_DIR}"'

test('[o3d-secops] the statements the mutations run are the ones the installer no longer contains', () => {
  for (const statement of [PRE_ROUND_ROOT_MKDIR, PRE_ROUND_LOG_CHOWN]) {
    assert.ok(!INSTALL_SH.split('\n').some((line) => line.trim() === statement),
      `scripts/install.sh still contains ${JSON.stringify(statement)}. The mutations below run that text `
      + 'to reproduce the finding; if the shipped script contains it too, they are measuring the shipped '
      + 'script and every "the fix holds" assertion beside them is measuring nothing.')
  }
  // AND THE STATEMENTS THAT REPLACED THEM ARE REALLY THERE, so this test cannot pass on a script
  // that simply dropped both operations.
  assert.match(SECTION8_ROOT_MKDIR, /enter_service_root "\$\{DATA_DIR\}" 022/)
  assert.match(SECTION8_ROOT_MKDIR, /enter_service_root "\$\{LOG_DIR\}" 022/)
  assert.match(SECTION8_LOG_CHOWN, /enter_service_root "\$\{LOG_DIR\}"[\s\S]*chown -Rh "\$\{APP_USER\}:\$\{APP_USER\}" \./)
  // AND NOT THROUGH `find -exec`, which enumerates pathnames and lets a descendant be swapped
  // between the enumeration and the chown that resolves it again.
  assert.ok(!/find \. -exec chown/.test(SECTION8_LOG_CHOWN), SECTION8_LOG_CHOWN)
  // AND THE CREATING CALLS ARE NOT IN A SUBSHELL. enter_service_root() RECORDS the identity of a
  // root it creates, and the ownership change is held to that record; a subshell would discard it
  // and the second call would refuse the very directory the first one made. Measured on the shipped
  // text, because it is the kind of thing a later tidy-up would "simplify" back.
  assert.ok(!/\(\s*enter_service_root "\$\{(DATA|LOG)_DIR\}"/.test(SECTION8_ROOT_MKDIR),
    `the creating calls must not run in a subshell: ${SECTION8_ROOT_MKDIR}`)
  // …while the ownership change IS in one, because it must not move the installer's own cwd.
  assert.match(SECTION8_LOG_CHOWN, /^if ! \(/, SECTION8_LOG_CHOWN)
})

/** The three storage paths section 8's ${DATA_DIR} block names, lifted rather than re-derived. */
const STORAGE_DIRS = ['BACKUP_DIR', 'UPLOAD_STORAGE_DIR', 'PUBLIC_UPLOAD_STORAGE_DIR']
  .map((name) => shellConstant(INSTALL_SH, name, 'scripts/install.sh'))
  .join('\n')

/** The walk that section 8 does its ${DATA_DIR} and ${APP_DIR} work through. */
const SUBDIR_WALK = ['enter_service_subdir', 'mkdir_service_subdir'] as const

/** A marker printed only if control reaches the end of the shipped writes. `die` exits, so a run
 *  that refuses can never print it — which is the ordering claim, stated as an observation. */
const REACHED = 'REACHED_THE_WRITES'

test('[o3d-secops] a symlinked DATA_DIR is refused before section 8 creates anything through it', (t) => {
  const plant = plantSymlinkedRoot(t, 'ims-secops-data-root-')
  const app = join(plant.base, 'opt-app')
  const log = join(plant.base, 'var-log')
  mkdirSync(app)
  mkdirSync(log)

  const vars = [`APP_DIR=${q(app)}`, `DATA_DIR=${q(plant.stateRoot)}`, `LOG_DIR=${q(log)}`, STORAGE_DIRS].join('\n')
  const writes = [SECTION8_ROOT_MKDIR, SECTION8_DATA_SUBDIRS, `echo ${REACHED}`].join('\n')

  const run = runBash(rig([...ROOT_ENTER, ...SUBDIR_WALK], [GATE_DATA, writes].join('\n'), vars))

  // NOT VACUOUS: the plant is standing at the moment the assertions look at it, and the root entry
  // is the operator's own symlink resolving to a directory the service account chose.
  assert.equal(lstatSync(plant.stateRoot).isSymbolicLink(), true, 'the root must be a symlink, or this test states nothing')
  assert.equal(statSync(plant.stateRoot).ino, statSync(plant.victim).ino, 'and it must resolve to the victim')

  // THE SECURITY CLAIM FIRST.
  assert.deepEqual(readdirSync(plant.victim).sort(), ['DEPLOY-FENCED'],
    'nothing may be created inside the directory the link resolves to — no backups, no uploads, no xero')
  assert.equal(readFileSync(join(plant.victim, 'DEPLOY-FENCED'), 'utf8'), 'UNTOUCHED\n')
  assert.equal(run.status, 1, `the run must refuse: ${run.stderr}`)
  assert.ok(!run.stdout.includes(REACHED), 'and it must refuse BEFORE the writes, not after them')
  assert.ok(run.stderr.includes(`${plant.stateRoot} is a symbolic link`), run.stderr)

  // MEASURED BY MUTATION, ROUTE STATED: the identical rig with the ONE shipped gate line removed —
  // which is scripts/install.sh as it stood before this round. Everything else is shipped text, so
  // what lands in the victim can only be section 8 following the link.
  const attacked = plantSymlinkedRoot(t, 'ims-secops-data-root-mutated-')
  const attackedApp = join(attacked.base, 'opt-app')
  const attackedLog = join(attacked.base, 'var-log')
  mkdirSync(attackedApp)
  mkdirSync(attackedLog)
  const mutated = runBash(rig([...ROOT_ENTER, ...SUBDIR_WALK],
    [PRE_ROUND_ROOT_MKDIR, SECTION8_DATA_SUBDIRS, `echo ${REACHED}`].join('\n'),
    [`APP_DIR=${q(attackedApp)}`, `DATA_DIR=${q(attacked.stateRoot)}`, `LOG_DIR=${q(attackedLog)}`, STORAGE_DIRS].join('\n')))

  assert.equal(mutated.status, 0, `without the gate the writes must go through, or the mutation proves nothing: ${mutated.stderr}`)
  assert.ok(mutated.stdout.includes(REACHED), 'and reach the end of section 8')
  assert.deepEqual(readdirSync(attacked.victim).sort(), ['DEPLOY-FENCED', 'backups', 'public-uploads', 'uploads', 'xero'],
    'and root-side mkdirs must land in the victim — that is the finding, executed')
})

test('[o3d-secops] a symlinked LOG_DIR is refused before `mkdir -p` creates its target and `chown -R` follows it', (t) => {
  /** ${LOG_DIR} is the root with no publication under it: `mkdir -p` and a `chown -R` whose OPERAND
   *  IS DEREFERENCED are the whole of what touches it, and both were unguarded. `chown -R` at
   *  /var/log/<app> therefore hands the whole of whatever the link resolves to to ${APP_USER},
   *  recursively.
   *
   *  MEASURED HONESTLY. A harness with one uid cannot perform that chown, so it is recorded rather
   *  than performed and what is measured about it is that IT IS NEVER REACHED — which is exactly
   *  the ordering claim this round is about, and not a claim about what chown does. The victim is a
   *  real directory holding a sentinel, so "untouched" is asserted against its contents too.
   *
   *  A DANGLING link would be the more vivid plant and is the wrong one: `mkdir -p` does NOT follow
   *  a symlink whose target does not exist — mkdir(2) returns EEXIST and GNU `mkdir -p` then fails
   *  on the stat — so the layout the finding is actually about is a link to a directory that IS
   *  there. That was measured, not assumed: with a dangling target the mutation created nothing. */
  function plantLogRoot(prefix: string) {
    const base = createTempDirSync(prefix, t)
    const varlog = join(base, 'var-log')
    const data = join(base, 'var-lib-ims')
    const app = join(base, 'opt-app')
    mkdirSync(varlog)
    mkdirSync(data)
    mkdirSync(app)
    chmodSync(varlog, 0o755)
    const logRoot = join(varlog, 'ims')
    const victim = join(base, 'attacker-chosen')
    mkdirSync(victim)
    writeFileSync(join(victim, 'SENTINEL'), 'UNTOUCHED\n')
    symlinkSync(victim, logRoot)
    return { base, app, data, logRoot, victim }
  }

  const plant = plantLogRoot('ims-secops-log-root-')
  const chownLog = join(plant.base, 'chown.log')
  writeFileSync(chownLog, '')
  // `chown -R` cannot be performed by a harness with one uid, so it is a RECORDER. What is measured
  // about it is that it is never reached at all — which is the ordering claim, not a claim about
  // what chown does.
  const chownStub = `chown() { printf '%s\\n' "$*" >> ${q(chownLog)}; }`

  const vars = (p: ReturnType<typeof plantLogRoot>) =>
    [`APP_DIR=${q(p.app)}`, `DATA_DIR=${q(p.data)}`, `LOG_DIR=${q(p.logRoot)}`, chownStub].join('\n')
  const writes = [SECTION8_ROOT_MKDIR, SECTION8_LOG_CHOWN, `echo ${REACHED}`].join('\n')

  const run = runBash(rig([...ROOT_ENTER], [GATE_LOG, writes].join('\n'), vars(plant)))

  assert.equal(lstatSync(plant.logRoot).isSymbolicLink(), true, 'the log root must be a symlink, or this test states nothing')
  assert.equal(statSync(plant.logRoot).ino, statSync(plant.victim).ino, 'and it must resolve to the victim')
  assert.equal(readFileSync(chownLog, 'utf8'), '',
    'the recursive chown whose operand is dereferenced must never be issued at all')
  assert.deepEqual(readdirSync(plant.victim).sort(), ['SENTINEL'], 'and nothing may be created in what it resolves to')
  assert.equal(readFileSync(join(plant.victim, 'SENTINEL'), 'utf8'), 'UNTOUCHED\n')
  assert.equal(run.status, 1, `the run must refuse: ${run.stderr}`)
  assert.ok(!run.stdout.includes(REACHED))
  assert.ok(run.stderr.includes(`${plant.logRoot} is a symbolic link`), run.stderr)

  // MUTATION, ROUTE STATED: the same rig without the one gate line.
  const attacked = plantLogRoot('ims-secops-log-root-mutated-')
  const attackedChownLog = join(attacked.base, 'chown.log')
  writeFileSync(attackedChownLog, '')
  const mutated = runBash(rig([...ROOT_ENTER],
    [PRE_ROUND_ROOT_MKDIR, PRE_ROUND_LOG_CHOWN, `echo ${REACHED}`].join('\n'),
    [`APP_DIR=${q(attacked.app)}`, `DATA_DIR=${q(attacked.data)}`, `LOG_DIR=${q(attacked.logRoot)}`,
      `chown() { printf '%s\\n' "$*" >> ${q(attackedChownLog)}; }`].join('\n')))

  assert.equal(mutated.status, 0, `without the gate the writes must go through: ${mutated.stderr}`)
  assert.ok(mutated.stdout.includes(REACHED), 'and reach the end of the shipped statements')
  assert.equal(readFileSync(attackedChownLog, 'utf8').trim(), `-R svcuser:svcuser ${attacked.logRoot}`,
    'and the recursive chown must be issued at the link — that is the finding: a root-side `chown -R` '
    + 'whose operand is a symlink nothing has proved')
  assert.equal(realpathSync(attacked.logRoot), realpathSync(attacked.victim),
    'and that operand resolves to the directory the plant chose, which is what makes it a chown of somebody else\'s tree')
})

test('[o3d-secops] a symlinked APP_DIR is refused before section 8 walks into it', (t) => {
  const plant = plantSymlinkedRoot(t, 'ims-secops-app-root-')
  const data = join(plant.base, 'var-lib-ims')
  const log = join(plant.base, 'var-log-ims')
  mkdirSync(data)
  mkdirSync(log)

  const vars = [`APP_DIR=${q(plant.stateRoot)}`, `DATA_DIR=${q(data)}`, `LOG_DIR=${q(log)}`, STORAGE_DIRS].join('\n')
  const writes = [SECTION8_APP_SUBDIRS, `echo ${REACHED}`].join('\n')

  const run = runBash(rig([...ROOT_ENTER, ...SUBDIR_WALK], [GATE_APP, writes].join('\n'), vars))

  assert.equal(lstatSync(plant.stateRoot).isSymbolicLink(), true, 'the app root must be a symlink, or this test states nothing')
  assert.deepEqual(readdirSync(plant.victim).sort(), ['DEPLOY-FENCED'],
    'nothing may be created inside the directory the link resolves to')
  assert.equal(run.status, 1, `the run must refuse: ${run.stderr}`)
  assert.ok(!run.stdout.includes(REACHED))
  assert.ok(run.stderr.includes(`${plant.stateRoot} is a symbolic link`), run.stderr)

  // MUTATION, ROUTE STATED: the same rig without the one gate line.
  const attacked = plantSymlinkedRoot(t, 'ims-secops-app-root-mutated-')
  const attackedData = join(attacked.base, 'var-lib-ims')
  const attackedLog = join(attacked.base, 'var-log-ims')
  mkdirSync(attackedData)
  mkdirSync(attackedLog)
  const mutated = runBash(rig([...ROOT_ENTER, ...SUBDIR_WALK], writes,
    [`APP_DIR=${q(attacked.stateRoot)}`, `DATA_DIR=${q(attackedData)}`, `LOG_DIR=${q(attackedLog)}`, STORAGE_DIRS].join('\n')))

  assert.equal(mutated.status, 0, `without the gate the writes must go through: ${mutated.stderr}`)
  assert.deepEqual(readdirSync(attacked.victim).sort(), ['DEPLOY-FENCED', 'backups'],
    'and the walk must create ${APP_DIR}/backups inside the victim — that is the finding')
})

test('[o3d-secops] an ordinary install still runs: real roots pass, and a first install\'s absent root is not a refusal', (t) => {
  const base = createTempDirSync('ims-secops-ordinary-', t)
  const opt = join(base, 'opt')
  const varlib = join(base, 'var-lib')
  const varlog = join(base, 'var-log')
  for (const dir of [opt, varlib, varlog]) mkdirSync(dir)
  // ${DATA_DIR} and ${LOG_DIR} already exist — the upgrade. ${APP_DIR} does not, which is the first
  // install: `useradd --create-home` makes it a few hundred lines below the gate, so the gate must
  // accept the name being free and must NOT create it.
  const app = join(opt, 'one-two-inventory')
  const data = join(varlib, 'one-two-inventory')
  const log = join(varlog, 'one-two-inventory')
  mkdirSync(data)
  mkdirSync(log)

  const vars = [`APP_DIR=${q(app)}`, `DATA_DIR=${q(data)}`, `LOG_DIR=${q(log)}`, STORAGE_DIRS].join('\n')
  const gate = [GATE_APP, GATE_DATA, GATE_LOG].join('\n')
  const writes = [SECTION8_ROOT_MKDIR, SECTION8_DATA_SUBDIRS, SECTION8_APP_SUBDIRS, `echo ${REACHED}`].join('\n')

  // THE GATE CREATES NOTHING, asserted between the two halves rather than described.
  const gateOnly = runBash(rig([...ROOT_ENTER, ...SUBDIR_WALK], gate, vars))
  assert.equal(gateOnly.status, 0, `three real-or-absent roots must pass: ${gateOnly.stderr}`)
  assert.equal(existsSync(app), false, 'and an absent ${APP_DIR} must still be absent afterwards')

  const run = runBash(rig([...ROOT_ENTER, ...SUBDIR_WALK], [gate, writes].join('\n'), vars))
  assert.equal(run.status, 0, `and the install must then run: ${run.stderr}`)
  assert.ok(run.stdout.includes(REACHED))
  assert.deepEqual(readdirSync(data).sort(), ['backups', 'public-uploads', 'uploads', 'xero'])
  assert.deepEqual(readdirSync(join(data, 'uploads')).sort(), ['invoices', 'quarantine'])
  assert.deepEqual(readdirSync(app).sort(), ['backups'], 'and ${APP_DIR} must have been created by the walk, not by the gate')

  // MEASURED BY MUTATION, ROUTE STATED: the `directory|absent` arm of require_real_service_root()'s
  // case, with `absent` dropped — the plausible stricter gate. A FIRST INSTALL is then refused,
  // which is what makes the arm load-bearing rather than decoration.
  const shippedGate = shellFunction(INSTALL_SH, 'require_real_service_root')
  const absentArm = shippedGate.split('\n').find((line) => line.trimStart().startsWith('absent)'))
  assert.ok(absentArm, `precondition: the shipped gate must have an \`absent\` arm: ${shippedGate}`)
  const strict = shippedGate.replace(`${absentArm}\n`, '')
  assert.notEqual(strict, shippedGate, 'the mutation must change the shipped case arm')
  assert.ok(!/\babsent\)/.test(strict), 'and remove the arm that accepts a first install')
  // A FRESH LAYOUT: the run above CREATED ${APP_DIR}, so re-using it here would ask the mutated
  // gate about a directory that exists and the mutation would prove nothing.
  const firstInstall = createTempDirSync('ims-secops-first-install-', t)
  const freshApp = join(firstInstall, 'one-two-inventory')
  const freshData = join(firstInstall, 'state')
  const freshLog = join(firstInstall, 'log')
  mkdirSync(freshData)
  mkdirSync(freshLog)
  assert.equal(existsSync(freshApp), false, 'precondition: the mutation must be asked about an ABSENT root')
  const freshVars = [`APP_DIR=${q(freshApp)}`, `DATA_DIR=${q(freshData)}`, `LOG_DIR=${q(freshLog)}`, STORAGE_DIRS].join('\n')

  // The shipped gate accepts it — the half that would make the mutation vacuous if it did not.
  const shipped = runBash(rig([...ROOT_ENTER], gate, freshVars))
  assert.equal(shipped.status, 0, `the shipped gate must accept a first install: ${shipped.stderr}`)

  const refused = runBash(rig(['refuse_symlinked_root', 'pin_service_root_parent', 'service_root_entry_kind'], gate, [freshVars, strict].join('\n')))
  assert.equal(refused.status, 1, 'a gate that does not accept an absent root refuses a first install')
  assert.ok(refused.stderr.includes(`${freshApp} — the application directory — is a`), refused.stderr)
})

/** Section 8's ${DATA_DIR} ownership change, lifted whole: the guard that holds the lock PATH to the
 *  lock NAME, and the descriptor walk it protects. */
const SECTION8_DATA_CHOWN = [
  shippedStatement('[[ "${CRONTAB_LOCK_DIR}" == "${DATA_DIR%/}/${CRONTAB_LOCK_DIRNAME}" ]] || die \\'),
  shippedStatement('chown_state_tree "${DATA_DIR}" "${APP_USER}" "${CRONTAB_LOCK_DIRNAME}" "the state directory"'),
].join('\n')

/** What the lock subsystem contributes to a rig that runs section 8's chown: the two names, and the
 *  function that composes the PATH from one of them — lifted, because the guard above exists
 *  precisely to catch the two disagreeing and a rig that retyped either could not. */
const CRONTAB_LOCK_RIG = [
  shellConstant(CRONTAB_LOCK_SH, 'CRONTAB_LOCK_DIRNAME', 'scripts/lib/crontab-lock.sh'),
  shellConstant(CRONTAB_LOCK_SH, 'CRONTAB_LOCK_FILENAME', 'scripts/lib/crontab-lock.sh'),
  shellFunction(CRONTAB_LOCK_SH, 'crontab_lock_paths', 'scripts/lib/crontab-lock.sh'),
].join('\n')

test('[o3d-n8xx] an ordinary install and the upgrade after it both complete through the shipped ownership walk', (t) => {
  /**
   * THE OTHER HALF OF THE CRITICAL. A walk that refuses everything would satisfy every test above,
   * so this one runs the SHIPPED section-8 statements — the gate, the root entry, the subdirectory
   * walk and the ownership change — twice over one tree: once with ${DATA_DIR} absent, which is a
   * first install, and once with it populated the way the first run left it plus the lock directory
   * and a staging directory that prepare_crontab_lock() and publish_durable_file() add, which is
   * every upgrade afterwards. Both must reach the end.
   */
  const base = createTempDirSync('ims-n8xx-section8-', t)
  const varlib = join(base, 'var-lib')
  const varlog = join(base, 'var-log')
  mkdirSync(varlib)
  mkdirSync(varlog)
  const data = join(varlib, 'one-two-inventory')
  const log = join(varlog, 'one-two-inventory')

  const vars = [
    `APP_DIR=${q(join(base, 'opt-app'))}`,
    `DATA_DIR=${q(data)}`,
    `LOG_DIR=${q(log)}`,
    STORAGE_DIRS,
    CRONTAB_LOCK_RIG,
    // THE ACCOUNT THIS HARNESS CAN ACTUALLY CHOWN TO. `chown_state_tree` resolves it to a uid and a
    // gid with `id`, which is the shipped behaviour; only the name differs from a real install.
    'APP_USER="$(id -un)"',
    `IMS_CHOWN_TREE_HELPER=${q(CHOWN_TREE)}`,
    'crontab_lock_paths "${DATA_DIR}"',
  ].join('\n')
  const section8 = [
    GATE_DATA, GATE_LOG,
    SECTION8_ROOT_MKDIR,
    SECTION8_DATA_SUBDIRS,
    SECTION8_DATA_CHOWN,
    `echo ${REACHED}`,
  ].join('\n')
  const script = rig([...ROOT_ENTER, ...SUBDIR_WALK, 'chown_state_tree'], section8, vars)

  // THE FIRST INSTALL.
  assert.equal(existsSync(data), false, 'precondition: a first install has no state root yet')
  const install = runBash(script)
  assert.equal(install.status, 0, `an ordinary first install must complete: ${install.stderr}`)
  assert.ok(install.stdout.includes(REACHED))
  assert.deepEqual(readdirSync(data).sort(), ['backups', 'public-uploads', 'uploads', 'xero'])

  // THE UPGRADE, over what the first run left plus what the rest of the installer adds to it.
  mkdirSync(join(data, LOCK_DIRNAME), 0o700)
  writeFileSync(join(data, LOCK_DIRNAME, LOCK_FILENAME), '')
  // AT THE SHAPE publish_durable_file() LEAVES THEM — `(umask 077; mkdir)` plus `chown -h` — and
  // one of them RENAMED, which is what the service account does with a name they own and what the
  // walk must be indifferent to. The upgrade has to complete over both.
  mkdirSync(join(data, STAGE_DIRNAME), 0o700)
  writeFileSync(join(data, STAGE_DIRNAME, 'publish.abc'), 'staged\n')
  mkdirSync(join(data, 'uploads', STAGE_DIRNAME), 0o700)
  renameSync(join(data, 'uploads', STAGE_DIRNAME), join(data, 'uploads', 'renamed-aside'))
  writeFileSync(join(data, 'uploads/invoices/a.pdf'), 'an invoice\n')

  const before = ctimes(data)
  pause(30)
  const upgrade = runBash(script)
  assert.equal(upgrade.status, 0, `and the upgrade after it must complete too: ${upgrade.stderr}`)
  assert.ok(upgrade.stdout.includes(REACHED))

  const reached = touched(before, ctimes(data))
  assert.ok(reached.includes('.') && reached.includes('uploads/invoices/a.pdf'),
    `the upgrade must hand the ordinary tree over: ${reached.join(' ')}`)
  assert.ok(!reached.some((path) => path.split('/').includes(LOCK_DIRNAME) || path.split('/').includes(STAGE_DIRNAME)),
    `and neither protected subtree, at either depth: ${reached.join(' ')}`)
  assert.ok(!reached.includes('uploads/renamed-aside'),
    `nor a staging directory the service account renamed out of the way first: ${reached.join(' ')}`)
  // AND THE TWO STORAGE ROOTS COME WITH IT (o3d-n8xx). There was a second
  // `chown -R … "${UPLOAD_STORAGE_DIR}" "${PUBLIC_UPLOAD_STORAGE_DIR}"` after this walk. Both are
  // INSIDE ${DATA_DIR} and neither is pruned, so it did nothing the walk had not done — with a
  // `chown -R` that dereferences its operand, at two names the service account owns. It is gone,
  // and this is the assertion that says the walk really did cover what it was doing.
  assert.ok(reached.includes('uploads') && reached.includes('public-uploads'),
    `the storage roots must be handed over by the walk itself: ${reached.join(' ')}`)
  // THE CODE, NOT THE COMMENT that explains why the line went: a check over the whole file would
  // match its own explanation and pass whatever the script did.
  const installCode = INSTALL_SH.split('\n').filter((line) => !line.trimStart().startsWith('#'))
  assert.ok(!installCode.some((line) => /^chown -R\b/.test(line) && line.includes('UPLOAD_STORAGE_DIR')),
    `and the redundant second chown of them must not come back:\n${installCode.filter((l) => l.includes('UPLOAD_STORAGE_DIR')).join('\n')}`)

  // MEASURED BY MUTATION, ROUTE STATED: the guard that holds ${CRONTAB_LOCK_DIR} to
  // ${DATA_DIR}/${CRONTAB_LOCK_DIRNAME} removed, and the lock path composed from a name the walk is
  // not told to prune — which is what a rename of one constant without the other produces. The lock
  // directory is then handed to the service account, and with the guard it is a refused run instead.
  const composed = 'crontab_lock_paths "${DATA_DIR}"'
  assert.ok(vars.includes(composed), 'precondition: the rig must compose the lock path the way the entrypoints do')
  const drifted = vars.replace(composed, `${composed}\nCRONTAB_LOCK_DIR="\${DATA_DIR}/locks-renamed"`)
  assert.notEqual(drifted, vars, 'the mutation must move the lock PATH without moving the lock NAME')
  const mutated = runBash(rig([...ROOT_ENTER, ...SUBDIR_WALK, 'chown_state_tree'], section8, drifted))
  assert.equal(mutated.status, 1, `a lock path that no longer composes must end the run: ${mutated.stderr}`)
  assert.match(mutated.stderr, /prunes it by its single name component/, mutated.stderr)
})

test('[o3d-secops] a missing /proc ends the run at the pre-flight gate, rather than downgrading it to a walk by name', (t) => {
  /**
   * THE FIFTH FAIL-OPEN IN THIS ROUND'S OWN HARDENING. A missing `/proc/self/fd` was a `warn`, and
   * the run then carried on with no descriptor on the root — which enter_service_root() had a
   * by-name branch to accommodate. Every OTHER way of not getting a descriptor was already fatal,
   * and the code's own comment explains why a name is not an identity. There is no way to name an
   * open directory without /proc, so there is no weaker mode worth keeping.
   *
   * ROUTE: the shipped gate with the ONE path it asks about pointed at a name that does not exist,
   * which is what a container built without /proc presents. Everything else is shipped text.
   */
  const base = createTempDirSync('ims-secops-noproc-', t)
  const varlib = join(base, 'var-lib')
  mkdirSync(varlib)
  const data = join(varlib, 'one-two-inventory')
  mkdirSync(data)
  writeFileSync(join(data, 'MARKER'), 'untouched\n')
  const vars = [
    `APP_DIR=${q(join(base, 'opt-app'))}`,
    `DATA_DIR=${q(data)}`,
    `LOG_DIR=${q(join(base, 'var-log'))}`,
    STORAGE_DIRS,
  ].join('\n')

  const shippedGate = shellFunction(INSTALL_SH, 'require_real_service_root')
  const guard = '      [[ -d /proc/self/fd ]] || die \\'
  assert.ok(shippedGate.includes(guard), `precondition: the shipped gate must require /proc: ${shippedGate}`)
  const withoutProc = shippedGate.replace(guard, '      [[ -d /proc/self/fd-absent ]] || die \\')
  assert.notEqual(withoutProc, shippedGate, 'the simulated host must differ from the shipped one')

  const others = ROOT_GATE.filter((name) => name !== 'require_real_service_root')
  const refused = runBash(rig([...others], [GATE_DATA, `echo ${REACHED}`].join('\n'), [vars, withoutProc].join('\n')))
  assert.equal(refused.status, 1, `a host with no /proc must be refused: ${refused.stderr}`)
  assert.ok(!refused.stdout.includes(REACHED), 'and nothing after the gate may run')
  assert.match(refused.stderr, /\/proc is not mounted/, refused.stderr)
  assert.match(refused.stderr, /NOTHING has been created, nothing has been migrated and nothing has been started/,
    'and the refusal must carry the guarantee the pre-flight gate can make')

  // NOT VACUOUS: on this host, which HAS /proc, the SHIPPED gate approves the same root and records
  // a descriptor for it — so what refuses above is the absence and not the fixture.
  const ok = runBash(rig([...ROOT_GATE], [GATE_DATA, 'echo "fds=${#SERVICE_ROOT_FD[@]}"', `echo ${REACHED}`].join('\n'), vars))
  assert.equal(ok.status, 0, `the shipped gate must approve a real root: ${ok.stderr}`)
  assert.match(ok.stdout, /^fds=1$/m, 'and hold a descriptor on it')
  assert.ok(ok.stdout.includes(REACHED))

  // MEASURED BY MUTATION, ROUTE STATED: the r7 shape, which is what stood here — a `warn` and a
  // fall-through instead of a `die`. The gate then APPROVES the root with no descriptor at all, and
  // the run carries on into section 8 in the weaker mode that an account able to write the parent
  // can switch on at will by renaming the entry for the instant of the open.
  const lines = withoutProc.split('\n')
  const at = lines.findIndex((line) => line.includes('[[ -d /proc/self/fd-absent ]] || die'))
  assert.notEqual(at, -1, 'precondition: the mutation must find the guard it is replacing')
  lines.splice(at, 2, '      [[ -d /proc/self/fd-absent ]] || { printf \'WARN: /proc is not mounted\\n\' >&2; return 0; }')
  const warned = lines.join('\n')
  assert.ok(!warned.includes('/proc/self/fd-absent ]] || die'),
    'the mutation must remove the refusal, and only it — the gate\'s other refusals stay')

  const mutated = runBash(rig([...others], [GATE_DATA, 'echo "fds=${#SERVICE_ROOT_FD[@]}"', `echo ${REACHED}`].join('\n'), [vars, warned].join('\n')))
  assert.equal(mutated.status, 0, `without the refusal the run carries on: ${mutated.stderr}`)
  assert.ok(mutated.stdout.includes(REACHED), 'which is the fail-open this test exists to fail on')
  assert.match(mutated.stdout, /^fds=0$/m,
    'and it carries on with NO descriptor on the root, which is the state the whole round exists to remove')
})

test('[o3d-secops] the installer and the publisher refuse a symlinked root with the SAME bytes, naming the bind mount', (t) => {
  const plant = plantSymlinkedRoot(t, 'ims-secops-one-rule-')

  /** The ERROR lines about the root that refuse_symlinked_root() itself printed.
   *
   *  The gate follows them with a `die`, which the rig also prints as an `ERROR: ` line and which is
   *  LEGITIMATELY different from the publisher's — one is a pre-flight refusal that has changed
   *  nothing, the other a publication that returns a status to its caller. `die` exits, so its line
   *  is always the LAST one; dropping the last line of a run that died is what separates the shared
   *  refusal from the caller's own sentence, and the caller's sentence is asserted separately below
   *  rather than ignored. */
  const refusalLines = (stderr: string, died: boolean) => {
    const errors = stderr.split('\n').filter((line) => line.startsWith('ERROR: '))
    return died ? errors.slice(0, -1) : errors
  }

  const viaGate = runBash(rig([...ROOT_GATE], GATE_DATA, `DATA_DIR=${q(plant.stateRoot)}`))
  const viaPublisher = runBash(rig(PUBLISHER, [
    `printf 'phase=stopping\\n' | publish_durable_file "${join(plant.stateRoot, 'DEPLOY-FENCED')}" "" 600`,
    'echo "rc=$?"',
  ].join('\n'), roots({ data: plant.stateRoot })))

  const gateLines = refusalLines(viaGate.stderr, true)
  const publisherLines = refusalLines(viaPublisher.stderr, false)

  // NOT VACUOUS: both really refused, and both really printed the whole refusal.
  assert.equal(viaGate.status, 1, viaGate.stderr)
  assert.match(viaPublisher.stdout, /^rc=1$/m, viaPublisher.stderr)
  assert.ok(gateLines.length >= 4, `the gate must print the whole refusal: ${viaGate.stderr}`)
  assert.equal(publisherLines.length, gateLines.length, `and so must the publisher: ${viaPublisher.stderr}`)
  // AND THE LINE THAT WAS DROPPED IS THE GATE'S OWN, so the slice above removed a sentence rather
  // than a fourth line of the shared refusal.
  const gateDie = viaGate.stderr.split('\n').filter((line) => line.startsWith('ERROR: ')).at(-1) ?? ''
  assert.ok(gateDie.includes('NOTHING has been created'), `the dropped line must be the gate's own die: ${gateDie}`)

  assert.deepEqual(gateLines, publisherLines,
    'the pre-flight gate and the publisher must state one rule in one wording — an operator who meets '
    + 'two spellings of the same refusal at two depths has met two rules')

  // AND WHAT IT SAYS IS THE REFUSAL, THE REASON, THE RESOLVED TARGET AND WHERE THE PROCEDURE IS
  // (o3d-secops r8, Codex HIGH). It used to be a five-step paste; the r8 note on the r10 refusal
  // test above says why five reviews' worth of findings came out of that and it was deleted rather
  // than hardened a sixth time. Asserted by content, not by line number.
  const block = gateLines.join('\n')
  assert.ok(gateLines[0].includes('is a symbolic link'), gateLines[0])
  assert.ok(block.includes('no data has to move'), 'the question an operator asks first')
  assert.match(block, /rsyncs into this root with --delete and chowns it RECURSIVELY/,
    'the reason, which is the half that lets an operator judge their own host')
  // THE TARGET IS RESOLVED AND PRINTED AS A LITERAL PATH. There is no `TARGET` for anybody to
  // retype, and no shell variable anywhere in the text — the run read the link itself.
  const resolved = realpathSync(plant.stateRoot)
  assert.ok(block.includes(`This run resolved that link to: ${resolved}`),
    `the refusal must print where the link actually goes: ${block}`)
  assert.ok(!/\$[A-Za-z_{(]/.test(block), `no line may contain a shell variable or substitution: ${block}`)
  assert.match(block, /docs\/installation\.md, "Putting a state root on another disk"/,
    'and the procedure must be pointed at rather than printed')
  for (const command of NO_PASTEABLE_COMMAND) {
    assert.ok(!command.test(block), `no command may be printed for pasting, and ${command} matched: ${block}`)
  }

  // AND A LINK THAT RESOLVES TO NOTHING GETS A DIFFERENT ANSWER, because there is no bind mount to
  // make. Measured rather than described: the same refusal, over a dangling link.
  const dangling = createTempDirSync('ims-secops-dangling-', t)
  const varlib = join(dangling, 'var-lib')
  mkdirSync(varlib)
  const danglingRoot = join(varlib, 'ims')
  symlinkSync(join(dangling, 'gone'), danglingRoot)
  const viaDangling = runBash(rig([...ROOT_GATE], GATE_DATA, `DATA_DIR=${q(danglingRoot)}`))
  assert.equal(viaDangling.status, 1, viaDangling.stderr)
  assert.match(viaDangling.stderr, /does not resolve to a directory/, viaDangling.stderr)
  assert.ok(!viaDangling.stderr.includes('Putting a state root on another disk'),
    'a dangling link is not sent to a bind-mount procedure whose target does not exist')

  // AND IT IS ONE RULE BECAUSE IT IS ONE FUNCTION, not two texts that happen to agree today.
  assert.ok(shellFunction(INSTALL_SH, 'require_real_service_root').includes('refuse_symlinked_root "${root}"'),
    'the gate must print through the shared refusal')
  assert.ok(shellFunction(INSTALL_SH, 'pin_dir_beneath_root').includes('refuse_symlinked_root "$root"'),
    'and so must the publisher')

  // MEASURED BY MUTATION, ROUTE STATED: a gate carrying its OWN wording — the publisher's pre-r7
  // sentence, which is the one a second author would most plausibly copy — instead of calling the
  // shared refusal. The two blocks then disagree, and this test fails.
  const forked = shellFunction(INSTALL_SH, 'require_real_service_root')
    .replace('      refuse_symlinked_root "${root}"\n',
      '      printf \'ERROR: %s is a symbolic link, and a publication root may not be one: nothing here proves the path its target resolves through.\\n\' "${root}" >&2\n')
  assert.ok(!forked.includes('refuse_symlinked_root "${root}"'), 'the mutation must remove the shared call')
  const mutated = runBash(rig(['refuse_symlinked_root', 'pin_service_root_parent', 'service_root_entry_kind'], GATE_DATA,
    [`DATA_DIR=${q(plant.stateRoot)}`, forked].join('\n')))
  assert.equal(mutated.status, 1, mutated.stderr)
  assert.notDeepEqual(refusalLines(mutated.stderr, true), publisherLines,
    'a forked wording must be visible to this test, or the comparison above is decoration')
})

test('[o3d-secops] the gate is the first line of the run that names any of the three roots', () => {
  const lines = INSTALL_SH.split('\n')
  const names = /\$\{(APP_DIR|DATA_DIR|LOG_DIR)\}/
  const privilegeCheck = lines.findIndex((line) => line.startsWith('[[ $EUID -ne 0 ]]'))
  assert.notEqual(privilegeCheck, -1, 'precondition: scripts/install.sh must still refuse a non-root run')

  /** Every line after the privilege check that names one of the three, comments aside. Source order
   *  is run order here: the whole of scripts/install.sh below the function definitions is
   *  straight-line top-level statements. */
  const mentions = (source: readonly string[]) => source
    .map((line, index) => ({ line, index }))
    .filter(({ line, index }) => index > privilegeCheck && names.test(line) && !line.trimStart().startsWith('#'))

  const found = mentions(lines)
  // NOT VACUOUS, AND THE WALK IS SHOWN TO HAVE REACHED THEM: this is a whole installer's worth of
  // uses, not the three the gate itself makes.
  assert.ok(found.length >= 40, `precondition: the walk must reach the installer's uses of the three roots; it found ${found.length}`)
  assert.deepEqual(found.slice(0, 3).map(({ line }) => line), [GATE_APP, GATE_DATA, GATE_LOG],
    'the three gate calls must be the first three lines after the privilege check that name a root — '
    + 'a gate that stands after any use of these names is the defect this round fixed')

  // AND NOTHING ABOVE THE PRIVILEGE CHECK ACTS ON THEM. The top-level lines up there compose paths
  // and nothing else; crontab_lock_paths() assigns two variables and validates that its argument is
  // absolute. Stated as an exact set, so a filesystem operation added above the gate fails here.
  const before = lines
    .slice(0, privilegeCheck)
    .filter((line) => names.test(line) && /^[A-Za-z_]/.test(line))
  assert.deepEqual(before, [
    'BACKUP_DIR="${DATA_DIR}/backups"',
    'UPLOAD_STORAGE_DIR="${DATA_DIR}/uploads"',
    'PUBLIC_UPLOAD_STORAGE_DIR="${DATA_DIR}/public-uploads"',
    'readonly DEPLOY_SSH_DIR="${DATA_DIR}/git-ssh"',
    'DB_FENCE_SCRIPT="${APP_DIR}/scripts/fence-db-connections.mjs"',
    'crontab_lock_paths "${DATA_DIR}"',
    'DB_OBJECT_ACCESS_SCRIPT="${APP_DIR}/scripts/check-app-db-object-access.mjs"',
  ], 'every top-level statement above the gate that names a root must be a string composition')

  // MEASURED BY MUTATION, ROUTE STATED: the three gate lines deleted, which is scripts/install.sh
  // as it stood before this round. The first mention is then the run's first READ of ${APP_DIR}.
  const withoutGate = lines.filter((line) => line !== GATE_APP && line !== GATE_DATA && line !== GATE_LOG)
  assert.equal(withoutGate.length, lines.length - 3, 'the mutation must remove exactly the three gate calls')
  assert.equal(mentions(withoutGate)[0].line, 'load_existing_env "${APP_DIR}/.env"',
    'without the gate the run reaches a root before anything has proved it — which is what this test exists to fail on')
})

/**
 * THE ROOT THAT IS RENAMED AFTER THE GATE HAS PASSED ON IT (o3d-secops r7 second pass, Codex HIGH)
 *
 * THE FINDING. require_real_service_root() is a SNAPSHOT: it proves what is at the name and then
 * releases the cwd it walked to. For ${APP_DIR} and ${DATA_DIR} that is the whole answer, because
 * /opt and /var/lib are root-owned and 0755 — nobody else can put anything at those names
 * afterwards. For ${LOG_DIR} it is not: on Ubuntu /var/log is `drwxrwxr-x root:syslog` and NOT
 * sticky, so the `syslog` account may RENAME any entry in it, root-owned ones included. NO SYMLINK
 * IS INVOLVED, so refusing symlinks does not touch it. Between the gate and section 8 that account
 * could move the real log root aside and rename another /var/log subtree into its name, and a
 * `chown -R "${LOG_DIR}"` would then transfer that subtree to ${APP_USER}, recursively.
 *
 * THE ANSWER IS A PIN THE OPERATION ITSELF USES. enter_service_root() walks, creates or accepts the
 * root, steps INTO it, proves the inode and the `..`, and leaves the process there; section 8 then
 * acts on `.`. A rename of the NAME after that cannot move a descriptor.
 *
 * WHAT THIS TEST SUBSTITUTES, AND WHY. The shipped operation is `chown -h`, which a harness with one
 * uid cannot perform. `chmod` is the same shape — a root-side metadata change over the tree, aimed
 * either at `.` or at a pathname — and it IS performable here, so the effect is real and measured on
 * both trees rather than recorded by a stub. The rename is performed by the test, deterministically,
 * at exactly the point the finding says it can happen.
 */
test('[o3d-secops] a root renamed AFTER the gate does not redirect the ownership change, because the change is aimed at `.`', (t) => {
  function plantRenameRace(prefix: string) {
    const base = createTempDirSync(prefix, t)
    // /var/log's own shape on Ubuntu: writable by an account that is not root, so entries in it can
    // be renamed by somebody other than their owner.
    const varlog = join(base, 'var-log')
    mkdirSync(varlog)
    chmodSync(varlog, 0o777)
    const logRoot = join(varlog, 'ims')
    mkdirSync(logRoot)
    writeFileSync(join(logRoot, 'REAL'), 'the real log root\n')
    chmodSync(join(logRoot, 'REAL'), 0o644)
    // The subtree the attacker renames into the log root's name. Another real directory, in the
    // same writable parent — nothing about it is a symlink.
    const decoy = join(varlog, 'somebody-elses-logs')
    mkdirSync(decoy)
    writeFileSync(join(decoy, 'VICTIM'), 'not this run\'s to touch\n')
    chmodSync(join(decoy, 'VICTIM'), 0o644)
    chmodSync(decoy, 0o755)
    return { base, varlog, logRoot, decoy, moved: `${logRoot}.moved` }
  }

  /** The rename, and then the shipped shape of the operation: `enter_service_root` has already left
   *  this shell inside the root, so the walk over `.` cannot be redirected by it. */
  const race = (p: ReturnType<typeof plantRenameRace>, operation: string) => [
    // THE SHIPPED ORDER: pre-flight approves the root by identity, section 8 enters it and is held
    // to that identity. Both halves are shipped text.
    `require_real_service_root ${q(p.logRoot)} "the log directory"`,
    `enter_service_root ${q(p.logRoot)} 022 "the log directory"`,
    // THE ATTACK, executed between the entry and the operation — which is precisely the window the
    // finding names, made deterministic.
    `mv ${q(p.logRoot)} ${q(p.moved)}`,
    `mv ${q(p.decoy)} ${q(p.logRoot)}`,
    operation,
    `echo ${REACHED}`,
  ].join('\n')

  const plant = plantRenameRace('ims-secops-rename-')
  const run = runBash(rig([...ROOT_ENTER], race(plant, 'find . -exec chmod 0770 {} +')))

  // NOT VACUOUS: the rename really happened, and the name really points at the decoy now.
  assert.equal(run.status, 0, `the shipped shape must complete: ${run.stderr}`)
  assert.ok(run.stdout.includes(REACHED))
  assert.deepEqual(readdirSync(plant.logRoot).sort(), ['VICTIM'], 'the log root NAME must now hold the decoy')
  assert.deepEqual(readdirSync(plant.moved).sort(), ['REAL'], 'and the directory this run entered must be the one moved aside')

  // THE SECURITY CLAIM: the change landed on the tree this run pinned, and on nothing else.
  assert.equal(statSync(plant.moved).mode & 0o777, 0o770, 'the pinned directory must have been changed')
  assert.equal(statSync(join(plant.moved, 'REAL')).mode & 0o777, 0o770, 'and everything under it')
  assert.equal(statSync(plant.logRoot).mode & 0o777, 0o755, 'and the subtree renamed into its place must be untouched')
  assert.equal(statSync(join(plant.logRoot, 'VICTIM')).mode & 0o777, 0o644, 'contents included')

  // MEASURED BY MUTATION, ROUTE STATED: the identical race with the operation aimed at the PATHNAME
  // — which is what `chown -R … "${LOG_DIR}"` was before this round. It follows the rename into the
  // subtree that was moved in, and leaves the real one alone. That is the finding, executed.
  const attacked = plantRenameRace('ims-secops-rename-mutated-')
  const mutated = runBash(rig([...ROOT_ENTER], race(attacked, `chmod -R 0770 ${q(attacked.logRoot)}`)))

  assert.equal(mutated.status, 0, `the pre-round shape must complete, or the mutation proves nothing: ${mutated.stderr}`)
  assert.equal(statSync(attacked.logRoot).mode & 0o777, 0o770,
    'a pathname operation must follow the rename into the renamed-in subtree')
  assert.equal(statSync(join(attacked.logRoot, 'VICTIM')).mode & 0o777, 0o770,
    'and recurse into it — a root-side `chown -R` here transfers a tree this run never proved')
  assert.equal(statSync(attacked.moved).mode & 0o777, 0o755,
    'while the directory the gate actually approved is left alone')
})

/**
 * scripts/install.sh's enter_service_root() with named checks disabled, and nothing else changed.
 *
 * Each comparison is neutered by replacing the `[[ … ]]` TEST with `[[ 1 == 1 ]]`, so the `die` and
 * its message stay exactly where they were and the only thing that changes is whether the condition
 * can fire. Every replacement asserts its precondition on the shipped text first: a mutation that
 * silently matched nothing is a test that measures nothing, which is the failure mode this whole
 * file is built against.
 */
function entryWithout(disable: { identity?: boolean, landing?: boolean, descriptor?: boolean }): string {
  let body = shellFunction(INSTALL_SH, 'enter_service_root')
  const neuter = (test: string) => {
    assert.ok(body.includes(test), `precondition: the shipped entry must contain ${test}`)
    body = body.replace(test, '[[ 1 == 1 ]]')
  }
  if (disable.identity) {
    // BOTH comparisons against what pre-flight approved: one made of the ENTRY, before this process
    // goes anywhere — that is the one that says the NAME still leads to the approved directory —
    // and one of the directory it landed in.
    neuter('[[ "${entry#*|}" == "${approved}" ]]')
    neuter('[[ "${landed}" == "${approved}" ]]')
  }
  if (disable.landing) {
    neuter('[[ -n "${landed}" && "${landed}" == "${entry#*|}" ]]')
  }
  if (disable.descriptor) {
    // THE ENTRY BY DESCRIPTOR, REPLACED BY THE ENTRY BY NAME. There is no `[[ -d /proc/self/fd ]]`
    // branch to switch off any more (o3d-secops r8): the gate refuses a host with no /proc, so the
    // by-name fallback that used to sit behind that test was unreachable in a real run and
    // reachable in a mutated one. The mutation is therefore the fallback itself, written back in —
    // which is exactly what an author "simplifying" this would do.
    const entered = '    cd "/proc/self/fd/${fd}" 2>/dev/null || die'
    assert.ok(body.includes(entered), `precondition: the shipped entry must enter through the descriptor: ${body}`)
    body = body.replace(entered, '    cd -P "${base}" 2>/dev/null || die')
    assert.ok(!body.includes('cd "/proc/self/fd/'), 'and the descriptor entry must be gone after the mutation')
    assert.ok(body.includes('cd -P "${base}" 2>/dev/null || die'), 'replaced by the by-name entry it removed')
  }
  return body
}

test('[o3d-secops] a root SWAPPED between the gate and the entry is refused, though everything but its identity checks out', (t) => {
  /**
   * THE WINDOW THE GATE CANNOT CLOSE ON ITS OWN. The gate approves an entry and releases the cwd it
   * walked to. On a parent another account can write — /var/log is `drwxrwxr-x root:syslog` and not
   * sticky on Ubuntu — that account can RENAME the approved root aside and rename a DIFFERENT real
   * directory into its name. No symlink is involved, so nothing about symlinks touches it; the
   * replacement is a real directory, in the right parent, with the right `..`, and (planted here as
   * it would be there) not distinguishable by ownership either. Only its IDENTITY differs, and that
   * is what enter_service_root() is now held to.
   */
  function plantSwap(prefix: string) {
    const base = createTempDirSync(prefix, t)
    const varlog = join(base, 'var-log')
    mkdirSync(varlog)
    chmodSync(varlog, 0o777)
    const logRoot = join(varlog, 'ims')
    mkdirSync(logRoot)
    writeFileSync(join(logRoot, 'REAL'), 'the approved root\n')
    const decoy = join(varlog, 'somebody-elses-logs')
    mkdirSync(decoy)
    writeFileSync(join(decoy, 'VICTIM'), 'not this run\'s to touch\n')
    chmodSync(decoy, 0o755)
    return { base, varlog, logRoot, decoy, moved: `${logRoot}.moved` }
  }

  const swap = (p: ReturnType<typeof plantSwap>) => [
    `require_real_service_root ${q(p.logRoot)} "the log directory"`,
    // THE SWAP, between the gate and the entry — the window, made deterministic.
    `mv ${q(p.logRoot)} ${q(p.moved)}`,
    `mv ${q(p.decoy)} ${q(p.logRoot)}`,
    `enter_service_root ${q(p.logRoot)} 022 "the log directory"`,
    'find . -exec chmod 0770 {} +',
    `echo ${REACHED}`,
  ].join('\n')

  const plant = plantSwap('ims-secops-swap-')
  const run = runBash(rig([...ROOT_ENTER], swap(plant)))

  // NOT VACUOUS: the swap really happened, and what stands at the name is a real directory.
  assert.equal(lstatSync(plant.logRoot).isDirectory(), true, 'the replacement must be a real directory, not a link')
  assert.deepEqual(readdirSync(plant.logRoot).sort(), ['VICTIM'])
  assert.deepEqual(readdirSync(plant.moved).sort(), ['REAL'])

  assert.equal(run.status, 1, `the entry must refuse a root that is not the one the gate approved: ${run.stderr}`)
  assert.ok(!run.stdout.includes(REACHED))
  assert.match(run.stderr, /is not the directory this run approved at pre-flight/, run.stderr)
  assert.equal(statSync(join(plant.logRoot, 'VICTIM')).mode & 0o777, 0o644,
    'and nothing in the swapped-in subtree may be touched')

  // MEASURED BY MUTATION, ROUTE STATED: the identity comparison removed from the shipped function,
  // and nothing else. Everything the walk checks still passes on the replacement — which is the
  // whole point of the finding — so the run goes through and changes somebody else's tree.
  // scripts/install.sh as it stood before this pass, reproduced from the shipped function: no
  // continuity with the gate, no landing check, and the root entered BY NAME. Every one of the
  // three has to go, because each on its own would refuse this swap — which is the point, and is
  // why the mutation names all three rather than one.
  const blind = entryWithout({ identity: true, landing: true, descriptor: true })

  const attacked = plantSwap('ims-secops-swap-mutated-')
  const mutated = runBash(rig(ROOT_ENTER.filter((n) => n !== 'enter_service_root'), swap(attacked), blind))

  assert.equal(mutated.status, 0, `without the identity check the run must go through: ${mutated.stderr}`)
  assert.ok(mutated.stdout.includes(REACHED))
  assert.equal(statSync(join(attacked.logRoot, 'VICTIM')).mode & 0o777, 0o770,
    'and change the subtree somebody else renamed in — that is the finding, executed')
  assert.equal(statSync(join(attacked.moved, 'REAL')).mode & 0o777, 0o644,
    'while the directory the gate actually approved is left alone')
})

test('[o3d-secops] enter_service_root refuses a root no gate has approved, and refuses one that appeared after the gate said it was absent', (t) => {
  const base = createTempDirSync('ims-secops-unapproved-', t)
  const varlib = join(base, 'var-lib')
  mkdirSync(varlib)
  const root = join(varlib, 'ims')
  mkdirSync(root)

  // NO GATE AT ALL. Acting on a root nothing has approved is the defect this round is about, one
  // call site over, so it fails closed rather than falling back to "well, it is a directory".
  const unapproved = runBash(rig([...ROOT_ENTER], [
    `enter_service_root ${q(root)} 022 "the state directory"`,
    `echo ${REACHED}`,
  ].join('\n')))
  assert.equal(unapproved.status, 1, `an unapproved root must be refused: ${unapproved.stderr}`)
  assert.ok(!unapproved.stdout.includes(REACHED))
  assert.match(unapproved.stderr, /has not approved in this run/, unapproved.stderr)

  // AND THE OTHER HALF OF THE CONTINUITY RULE: the gate saw NOTHING at the name, so this run must
  // be the one that creates it. A directory that appears in between belongs to whoever made it.
  const fresh = join(varlib, 'ims-first-install')
  const appeared = runBash(rig([...ROOT_ENTER], [
    `require_real_service_root ${q(fresh)} "the state directory"`,
    `mkdir ${q(fresh)}`,
    `enter_service_root ${q(fresh)} 022 "the state directory"`,
    `echo ${REACHED}`,
  ].join('\n')))
  assert.equal(appeared.status, 1, `a root created between the gate and the entry must be refused: ${appeared.stderr}`)
  assert.ok(!appeared.stdout.includes(REACHED))
  assert.match(appeared.stderr, /did not exist when this run checked it at pre-flight/, appeared.stderr)

  // NOT VACUOUS: the ordinary first install — gate sees nothing, entry creates it — goes through,
  // and leaves the process inside what it made.
  const ordinary = join(varlib, 'ims-ordinary')
  const ok = runBash(rig([...ROOT_ENTER], [
    `require_real_service_root ${q(ordinary)} "the state directory"`,
    `enter_service_root ${q(ordinary)} 022 "the state directory"`,
    'pwd -P',
  ].join('\n')))
  assert.equal(ok.status, 0, `a first install must be accepted: ${ok.stderr}`)
  assert.equal(ok.stdout.trim(), realpathSync(ordinary))

  // AND SO DOES THE UPGRADE WHOSE ROOTS THE PREVIOUS RUN HANDED TO THE SERVICE ACCOUNT. This is
  // the shape an ownership predicate got wrong: `find "${DATA_DIR}" … -exec chown -h` and the log
  // root's own `find .` chown the ROOTS THEMSELVES to ${APP_USER}, so on every run after the first
  // they are NOT root-owned. A gate that demanded root ownership refused every upgrade.
  const upgrade = runBash(rig([...ROOT_ENTER], [
    `require_real_service_root ${q(ordinary)} "the state directory"`,
    `enter_service_root ${q(ordinary)} 022 "the state directory"`,
    'pwd -P',
  ].join('\n')))
  assert.equal(upgrade.status, 0, `an existing root must be accepted on the next run: ${upgrade.stderr}`)
  assert.equal(upgrade.stdout.trim(), realpathSync(ordinary))
  // AND THE CLAIM ABOUT OWNERSHIP IS MADE OF THE CODE, because a harness with one uid cannot plant
  // a root owned by the service account: `chown` needs privilege this process does not have. So
  // what is asserted is that the shipped entry does not ASK the question at all — no `stat -c %u`,
  // no `id -u "${APP_USER}"` — which is the property that makes an upgrade whose roots the previous
  // run handed to ${APP_USER} indistinguishable, to this function, from a first install's.
  const entry = shellFunction(INSTALL_SH, 'enter_service_root')
  const code = entry.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n')
  assert.ok(!/stat -c '%u'/.test(code) && !/\bid -u\b/.test(code),
    'the shipped entry must not decide identity by OWNERSHIP: `find "${DATA_DIR}" … -exec chown -h` '
    + 'and the log root\'s own `find .` hand the ROOTS THEMSELVES to ${APP_USER}, so from the second '
    + `run onward they are not root-owned and an ownership test refuses exactly the upgrades it is meant to protect:\n${code}`)
})

test('[o3d-secops] enter_service_root enters a real MOUNT POINT at the root, which is what the documented remedy produces', (t) => {
  const mount = existingMountPoint()
  // STATED RATHER THAN GLOSSED, as it is for the publisher's own version of this test: `mount
  // --bind` needs CAP_SYS_ADMIN, which this harness does not have, so the layout the refusal sends
  // the operator to the documentation FOR is measured against a mount that is already on the
  // machine. To path resolution a
  // bind mount and a filesystem mount are the same object, and what is measured is a
  // path-resolution property: that the lstat, the inode comparison and the `..` comparison all
  // agree across a mount boundary, where the entry in the parent and the directory the walk lands
  // in belong to different filesystems. An installer that refused the layout its own refusal tells
  // operators to adopt would be worse than the defect.
  assert.ok(mount, 'no mount point with a non-writable root-owned parent was found; this test cannot state anything without one')

  const entered = runBash(rig([...ROOT_ENTER], [
    `require_real_service_root ${q(mount)} "the state directory"`,
    `enter_service_root ${q(mount)} 022 "the state directory"`,
    'pwd -P',
  ].join('\n')))
  assert.equal(entered.status, 0, `a mounted root must be entered: ${entered.stderr}`)
  assert.equal(entered.stdout.trim(), realpathSync(mount), 'and the process left inside it')

  // AND A SYMLINK TO THE VERY SAME DIRECTORY IS NOT. Same target, same contents, same everything
  // the walk could measure about where it lands — only the entry differs.
  const base = createTempDirSync('ims-secops-mountpoint-', t)
  const varlib = join(base, 'var-lib')
  const link = join(varlib, 'mounted')
  mkdirSync(varlib)
  chmodSync(varlib, 0o755)
  symlinkSync(mount, link)
  const viaLink = runBash(rig([...ROOT_ENTER], `require_real_service_root ${q(link)} "the state directory"`))
  assert.equal(viaLink.status, 1, 'a symlink to the same mounted directory must be refused')
  assert.ok(viaLink.stderr.includes(`${link} is a symbolic link`), viaLink.stderr)
})

test('[o3d-secops] the root is entered through the descriptor pre-flight opened, so a recycled inode cannot impersonate it', (t) => {
  /**
   * A `dev:ino` IS NOT A DURABLE IDENTITY. Inode numbers are reused, and an account that can write
   * the root's parent can remove an empty approved root and create its own directory at the name;
   * if the filesystem hands back the inode it has just freed, every comparison against a recorded
   * `dev:ino` succeeds on the impostor. The descriptor the gate opens is the answer: the kernel
   * resolves `/proc/self/fd/N` to the open file, not to a pathname.
   *
   * INODE REUSE CANNOT BE COMMANDED FROM A TEST, so this measures the PROPERTY that makes the
   * attack impossible rather than staging the attack: with the approved root renamed aside and a
   * different directory at its name, the entry reaches the ORIGINAL directory — the one the
   * descriptor is on — and not the one the name now leads to. An implementation that re-entered by
   * name would land on the impostor whether or not its inode matched, and the mutation shows it.
   */
  /** A FRESH LAYOUT PER RUN: each script below MOVES the impostor onto the root's name, so two
   *  runs over one fixture would leave the second with nothing to move and refusing for a reason
   *  that has nothing to do with what is being measured. */
  function plantImpostor(prefix: string) {
    const base = createTempDirSync(prefix, t)
    const varlog = join(base, 'var-log')
    mkdirSync(varlog)
    chmodSync(varlog, 0o777)
    const root = join(varlog, 'ims')
    mkdirSync(root)
    writeFileSync(join(root, 'APPROVED'), 'the directory the gate opened\n')
    const impostor = join(varlog, 'impostor')
    mkdirSync(impostor)
    writeFileSync(join(impostor, 'IMPOSTOR'), 'a different directory at the same name\n')
    return { base, root, impostor }
  }

  /** The gate, then the swap, then the entry — with the identity comparisons removed, so that what
   *  is left to observe is WHICH DIRECTORY the entry reaches rather than whether it refused. */
  // The continuity comparisons and the landing check removed — so that what is left to observe is
  // WHICH DIRECTORY the entry reaches, rather than whether it refused. The descriptor branch stays,
  // because it is the subject.
  const blind = entryWithout({ identity: true, landing: true })

  const script = (p: ReturnType<typeof plantImpostor>, extra: string) => rig(
    ROOT_ENTER.filter((n) => n !== 'enter_service_root'),
    [
      `require_real_service_root ${q(p.root)} "the log directory"`,
      `mv ${q(p.root)} ${q(`${p.root}.moved`)}`,
      `mv ${q(p.impostor)} ${q(p.root)}`,
      `enter_service_root ${q(p.root)} 022 "the log directory"`,
      'ls',
    ].join('\n'),
    extra,
  )

  const viaFd = runBash(script(plantImpostor('ims-secops-fdpin-'), blind))
  assert.equal(viaFd.status, 0, `the entry must complete: ${viaFd.stderr}`)
  assert.equal(viaFd.stdout.trim(), 'APPROVED',
    'the entry must reach the directory the descriptor is open on, whatever the name now leads to')

  // MEASURED BY MUTATION, ROUTE STATED: the same function with the descriptor branch removed, so it
  // enters by NAME — which is where it stood before this pass, and where a recycled inode would win.
  const byName = entryWithout({ identity: true, landing: true, descriptor: true })
  assert.notEqual(byName, blind, 'the two must differ only in how the root is entered')

  const viaName = runBash(script(plantImpostor('ims-secops-fdpin-byname-'), byName))
  assert.equal(viaName.status, 0, `the by-name entry must complete: ${viaName.stderr}`)
  assert.equal(viaName.stdout.trim(), 'IMPOSTOR',
    'entering by name reaches whatever now stands at it — which is what the descriptor exists to prevent')
})

test('[o3d-secops] the gate does not depend on the language the machine speaks', () => {
  /**
   * GNU coreutils TRANSLATES the file-type descriptions `stat -c %F` prints — "répertoire",
   * "Verzeichnis", "lien symbolique" — and every walk in these scripts compares them against the
   * English words. Unforced, the parent walk would reject `/opt` on its first component and the
   * installer would refuse to run at all on a French or German host; and the `== "symbolic link"`
   * comparisons would fail to RECOGNISE a link, which is worse than refusing.
   *
   * MEASURED AS A PROPERTY OF THE SOURCE, because a locale that is not generated on the machine
   * running the tests cannot be exercised — `locale -a` here lists only C, C.utf8 and POSIX, so a
   * behavioural test would silently measure C twice. What is asserted is the grammar: every `%F`
   * query in the tracked shell scripts is run with LC_ALL=C.
   */
  const files = ['scripts/install.sh', 'scripts/deploy.sh', 'scripts/update.sh', 'scripts/lib/crontab-lock.sh']
  const unforced: string[] = []
  let total = 0
  for (const file of files) {
    const source = readFileSync(join(REPO, file), 'utf8')
    for (const line of source.split('\n')) {
      if (line.trimStart().startsWith('#')) continue
      // Every INVOCATION: `%F` is only ever read through a command substitution in these scripts.
      const invocations = line.split("stat -c '%F").length - 1
      if (invocations === 0) continue
      total += invocations
      if (invocations !== line.split("LC_ALL=C stat -c '%F").length - 1) unforced.push(`${file}» ${line.trim()}`)
    }
  }
  // NOT VACUOUS: the walk found the queries. A rule that matched nothing would report none unforced.
  assert.ok(total >= 20, `the walk must reach the %F queries; it found ${total}`)
  assert.deepEqual(unforced, [],
    'every `stat -c %F` whose answer is compared against an English file-type description must be '
    + 'run with LC_ALL=C, or the comparison is a statement about the operator\'s language')
})

test('[o3d-secops] a descriptor the gate cannot take ends the run, rather than downgrading it silently', (t) => {
  /**
   * THE FAIL-OPEN THIS CLOSES. The gate used to fall through every way of not getting a descriptor
   * — a second walk that failed, an open that failed, a verification that did not match — and
   * enter_service_root() then entered by name, which is the state the descriptor was introduced to
   * leave. And it was REACHABLE: an account that can write `/var/log` can rename the entry aside
   * for the instant of the open and put it back, so the weaker mode was something an attacker could
   * switch on. A guarantee that can be switched off is not a guarantee.
   *
   * FORCED WITHOUT RELYING ON WHO IS RUNNING THE TESTS. The obvious lever — `chmod 000` on the root
   * — is a DAC restriction, and uid 0 walks through it; a harness that used it would prove nothing
   * under a root CI and would fail its own precondition there. `ulimit -n 10` is uid-independent:
   * bash allocates a `{var}` descriptor at 10 or above, so with the limit AT 10 the allocation
   * itself fails, on every uid, every time. Measured on this bash before it was relied on.
   *
   * AND IT MEASURES THE EXPLICIT REFUSAL, not an ambient one. The shipped code takes the `exec`
   * status with `|| die` precisely because a bare redirection failure ends the shell only while
   * `set -e` happens to be on — the rig deliberately runs without it, so a test that passed here on
   * bash's own exit would be measuring the harness rather than the guard.
   */
  const base = createTempDirSync('ims-secops-fdfail-', t)
  const varlog = join(base, 'var-log')
  mkdirSync(varlog)
  const root = join(varlog, 'ims')
  mkdirSync(root)
  writeFileSync(join(root, 'MARKER'), 'untouched\n')

  const script = (limit: string) => rig([...ROOT_ENTER], [
    `ulimit -n ${limit}`,
    `require_real_service_root ${q(root)} "the log directory"`,
    `enter_service_root ${q(root)} 022 "the log directory"`,
    'chmod 0770 .',
    `echo ${REACHED}`,
  ].join('\n'))

  const starved = runBash(script('10'))
  assert.equal(starved.status, 1, `a descriptor the gate cannot take must end the run: ${starved.stdout} ${starved.stderr}`)
  assert.ok(!starved.stdout.includes(REACHED),
    'and it must not go on to the rest of the run — a run that continued here would enter the root by name')
  assert.match(starved.stderr, /could not be opened to hold a descriptor on it/,
    `and the refusal must be the shipped one, not bash's own redirection message: ${starved.stderr}`)
  assert.equal(statSync(root).mode & 0o777, 0o755, 'and nothing may be changed on the way to refusing')

  // NOT VACUOUS: the identical script with descriptors to spare takes one, enters, and does the
  // work. So what the run above refused on is the descriptor and nothing else about the layout.
  const ok = runBash(script('64'))
  assert.equal(ok.status, 0, `a root the gate can open must pass: ${ok.stderr}`)
  assert.ok(ok.stdout.includes(REACHED))
  assert.equal(statSync(root).mode & 0o777, 0o770, 'and reach the operation the starved run refused')

  // MEASURED BY MUTATION, ROUTE STATED: the shipped `|| die` removed from the open, which is where
  // this stood before this pass. The rig runs without `set -e` — as a caller that had not set it
  // would — so bash prints its own message and CARRIES ON, and the run reaches the ownership change
  // having never held a descriptor. That is the fail-open, executed.
  const shipped = shellFunction(INSTALL_SH, 'require_real_service_root')
  const lines = shipped.split('\n')
  const at = lines.findIndex((line) => line.includes('exec {fd}< "${base}"'))
  assert.notEqual(at, -1, `precondition: the gate must open the descriptor: ${shipped}`)
  assert.match(lines[at], /\|\| die \\$/, `and must take the status of that open explicitly: ${lines[at]}`)
  assert.match(lines[at + 1], /could not be opened to hold a descriptor/,
    `and the refusal must be the line that follows it: ${lines[at + 1]}`)
  // THE WHOLE STATEMENT, both lines of it, replaced by the bare `exec` this stood as before the
  // pass. Removing only the first would leave the message as a command of its own, which fails for
  // a reason that has nothing to do with the finding.
  const failOpen = [
    ...lines.slice(0, at),
    '        exec {fd}< "${base}"',
    // ${fd} is left UNSET by a failed open — `local fd` does not create it — so `set -u` alone
    // would stop the run and the mutation would prove the harness rather than the code. The
    // pre-pass gate reached its verification with an empty value; this reproduces that.
    '        fd="${fd:-}"',
    ...lines.slice(at + 2),
  ].join('\n')
    // …and the identity check, which would otherwise catch the missing descriptor for it.
    .replace('[[ "$(stat -L -c \'%d:%i\' "/proc/self/fd/${fd}" 2>/dev/null || true)" == "${answer#*|}" ]]', '[[ 1 == 1 ]]')
  assert.ok(!failOpen.includes('could not be opened to hold a descriptor'),
    'the mutation must remove the explicit refusal')
  assert.ok(!failOpen.includes('stat -L'), 'and the verification that would stand in for it')

  const mutated = runBash(rig(ROOT_ENTER.filter((n) => n !== 'require_real_service_root'), [
    'ulimit -n 10',
    `require_real_service_root ${q(root)} "the log directory"`,
    `echo ${REACHED}`,
  ].join('\n'), failOpen))
  assert.ok(mutated.stdout.includes(REACHED),
    `without the explicit status the gate returns having taken no descriptor: ${mutated.stdout} ${mutated.stderr}`)
})

test('[o3d-secops] an approved root with no descriptor is refused at the entry, not entered by name', (t) => {
  /**
   * The other half of the same rule, and the one that makes a downgrade anywhere else in the run
   * harmless: enter_service_root() treats a missing descriptor on a /proc host as a refusal. The
   * downgrade is staged directly — the gate runs, and its record is then cleared — because what is
   * being measured is the entry's response to it, not how it might come about.
   */
  const base = createTempDirSync('ims-secops-nofd-', t)
  const varlog = join(base, 'var-log')
  mkdirSync(varlog)
  const root = join(varlog, 'ims')
  mkdirSync(root)
  writeFileSync(join(root, 'MARKER'), 'untouched\n')

  const script = (clear: boolean) => rig([...ROOT_ENTER], [
    `require_real_service_root ${q(root)} "the log directory"`,
    ...(clear ? [`unset 'SERVICE_ROOT_FD[${root}]'`] : []),
    `enter_service_root ${q(root)} 022 "the log directory"`,
    'chmod 0770 .',
    `echo ${REACHED}`,
  ].join('\n'))

  const downgraded = runBash(script(true))
  assert.equal(downgraded.status, 1, `a missing descriptor must be refused: ${downgraded.stderr}`)
  assert.ok(!downgraded.stdout.includes(REACHED))
  assert.match(downgraded.stderr, /has no descriptor from this run's pre-flight check/, downgraded.stderr)
  assert.equal(statSync(root).mode & 0o777, 0o755, 'and nothing may be changed on the way to refusing')

  // NOT VACUOUS: the identical script WITHOUT the downgrade runs to the end and does the work.
  const ok = runBash(script(false))
  assert.equal(ok.status, 0, `the ordinary path must still run: ${ok.stderr}`)
  assert.ok(ok.stdout.includes(REACHED))
  assert.equal(statSync(root).mode & 0o777, 0o770, 'and reach the operation it was refusing above')
})

test('[o3d-secops] the shared refusal does not claim the run has changed nothing, because half its callers cannot say that', () => {
  /**
   * refuse_symlinked_root() is printed by TWO callers: the pre-flight gate, where nothing has
   * happened yet, and pin_dir_beneath_root(), which is reached at the FIRST PUBLICATION — by which
   * time packages are installed, section 8's directories exist, uploads have been migrated and the
   * checkout is in place. A shared helper asserting "nothing has been changed" told half its
   * operators something false, and told them not to look.
   *
   * The claim belongs to whoever can make it: the gate's own `die` carries it, and the shared text
   * states only what is true wherever it is printed.
   */
  const helper = shellFunction(INSTALL_SH, 'refuse_symlinked_root')
  // THE CODE, NOT THE PROSE. The comment above the guard explains the finding and quotes the
  // sentence it removed; a check over the whole body would match its own explanation and fail
  // whatever the code did — which is a test that measures the comment.
  const printed = helper.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n')
  assert.ok(printed.includes('printf'), 'precondition: the shared refusal must still print something')
  assert.ok(!/NOTHING HAS BEEN CHANGED/i.test(printed),
    `the shared refusal must not claim the run has changed nothing:\n${printed}`)
  assert.ok(!/nothing has been (created|migrated|started)/i.test(printed),
    `nor any of its variants:\n${printed}`)

  // NOT VACUOUS: the gate, which CAN make that claim, still does — so the guarantee has not simply
  // been deleted, it has been moved to the caller that owns it.
  const gate = shellFunction(INSTALL_SH, 'require_real_service_root')
  assert.match(gate, /NOTHING has been created, nothing has been migrated and nothing has been started/,
    `the pre-flight refusal must still carry the no-change guarantee:\n${gate}`)

  // AND THE OTHER CALLER SAYS NOTHING IT CANNOT SUPPORT. pin_dir_beneath_root() returns a status to
  // callers that each decide for themselves; it must not make a claim about the run on their behalf.
  const publisher = shellFunction(INSTALL_SH, 'pin_dir_beneath_root')
  assert.match(publisher, /refuse_symlinked_root "\$root"/, 'the publisher prints through the shared refusal')
  const publisherCode = publisher.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n')
  assert.ok(!/NOTHING HAS BEEN CHANGED/i.test(publisherCode),
    `and must not add a no-change claim of its own:\n${publisherCode}`)

  // ALL THREE ENTRYPOINTS, because the text is carried byte for byte and a claim that is false in
  // one of them is false in all of them.
  for (const script of ['scripts/deploy.sh', 'scripts/update.sh'] as const) {
    const source = readFileSync(join(REPO, script), 'utf8')
    assert.equal(shellFunction(source, 'refuse_symlinked_root'), helper, `${script} has drifted`)
  }
})
