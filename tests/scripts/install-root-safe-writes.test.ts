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
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test, { type TestContext } from 'node:test'

import { maskShellSource, shellAssignments, shellConstant, shellConstantAssignments, shellConstantOptional, shellFunction, shellFunctionBodyCount, shellFunctionDefinitions } from './shell-symbol.ts'
import { createTempDirSync } from './temp-dir.ts'

const REPO = process.cwd()
const INSTALL_SH = readFileSync(join(REPO, 'scripts/install.sh'), 'utf8')


/**
 * The rig. `die` is a STUB and not the subject: install.sh's own is `die() { error "$*"; exit 1; }`
 * on one line, and what these tests measure is whether the run refuses, not how the refusal is
 * printed. Everything that IS the subject is shipped text.
 */
function rig(functions: string[], body: string, extra = ''): string {
  return [
    'set -uo pipefail',
    'APP_USER="svcuser"',
    'error() { printf "ERROR: %s\\n" "$*" >&2; }',
    'die() { error "$*"; exit 1; }',
    'info() { printf "INFO: %s\\n" "$*"; }',
    shellConstant(INSTALL_SH, 'PUBLISH_STAGE_DIRNAME'),
    ...functions.map((name) => shellFunction(INSTALL_SH, name)),
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
const PUBLISHER = ['fsync_path', 'publish_trust_root_candidates', 'pin_publish_root_parent', 'publish_root_anchored', 'publish_trust_root', 'pin_dir_beneath_root', 'publish_durable_file']

/** The anchor and the walk it is made of (o3d-rn10 r4): publish_root_anchored() is now a subshell
 *  around pin_publish_root_parent(), so a rig that lifts one without the other fails with
 *  "command not found" and every "the publication must refuse" test passes for the wrong reason. */
const ANCHOR = ['pin_publish_root_parent', 'publish_root_anchored'] as const

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

function runBash(script: string, opts: { cwd?: string, env?: Record<string, string>, deadlineMs?: number } = {}): Run {
  const deadlineMs = opts.deadlineMs ?? RUN_BASH_DEADLINE_MS
  const seconds = Math.max(1, Math.ceil(deadlineMs / 1000))
  const result = spawnSync(REAL.timeout, ['-k', '2', String(seconds), 'bash', '-c', script], {
    cwd: opts.cwd ?? REPO,
    encoding: 'utf8',
    env: { ...process.env, ...(opts.env ?? {}) },
    // An EMPTY stdin rather than this process's: a shim that reads stdin then gets EOF instead of
    // blocking on a terminal that will never answer.
    input: '',
    maxBuffer: RUN_BASH_MAX_OUTPUT_BYTES,
  })
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
  mv: realBin('mv'),
  ln: realBin('ln'),
  id: realBin('id'),
  wc: realBin('wc'),
  timeout: realBin('timeout'),
  sleep: realBin('sleep'),
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

  const run = runBash(rig([...ANCHOR, 'pin_dir_beneath_root'],
    `pin_dir_beneath_root "${state}" "${join(state, 'deploy')}"; echo "rc=$?"`))

  assert.match(run.stdout, /^rc=1$/m, 'the walk must not start from a root it was handed without an anchor')
  assert.deepEqual(readdirSync(state), [], 'and it must create nothing under it — not even the first component')

  // NOT VACUOUS: the same call, with the same directories, succeeds once the parent is one only
  // its owner can rename inside. So what refused it was the anchor and not the walk.
  chmodSync(home, 0o755)
  const ok = runBash(rig([...ANCHOR, 'pin_dir_beneath_root'],
    `pin_dir_beneath_root "${state}" "${join(state, 'deploy')}"; echo "rc=$?"`))
  assert.match(ok.stdout, /^rc=0$/m, `an anchored root must still be walked: ${ok.stderr}`)
  assert.deepEqual(readdirSync(state), ['deploy'], 'and the component created')
})

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

  // And the shipped roots' real parents, on this machine, answer the way the table's paragraph
  // always claimed they would — through the uid-0 branch, which is why an unprivileged harness can
  // ask at all.
  for (const [dir, expected] of [['/opt/one-two-inventory', true], ['/var/lib/one-two-inventory', true],
    ['/etc/ims-cutover', true], ['/tmp/ims-state', false]] as const) {
    const run = runBash(rig([...ANCHOR], `publish_root_anchored "${dir}"; echo "rc=$?"`))
    assert.match(run.stdout, new RegExp(`^rc=${expected ? 0 : 1}$`, 'm'),
      `${dir} must be ${expected ? 'anchored' : 'refused'}: ${run.stdout}${run.stderr}`)
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
  // is the privileged account by definition however this process was started.
  const rootOwned = runBash(rig([...ANCHOR],
    `publish_root_anchored "/etc/ims-cutover"; echo "rc=$?"`,
    'id() { printf "%s\\n" 424242; }'))
  assert.match(rootOwned.stdout, /^rc=0$/m, `a root-owned parent must be anchored regardless of who runs this: ${rootOwned.stdout}${rootOwned.stderr}`)
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

  // AND THIS IS THE LIVE INSTANCE OF THE RULE, not a hypothetical: /tmp itself is root-owned and
  // 1777, so the sticky credit is what lets every harness in this file build an anchored root under
  // a mkdtemp directory at all. Remove the credit and twenty tests here fail, which is the honest
  // account of why it is there.
  assert.equal(statSync('/tmp').mode & 0o7777, 0o1777, '/tmp must be sticky and world-writable, or the line above states nothing')
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
  assert.ok(!mutated.includes('mount --bind'), 'and with it the refusal that names the bind mount')
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
  assert.match(refused.stderr, /mount --bind/,
    'and say what to do instead, in a form that can be run')
  assert.match(refused.stderr, /fstab/,
    'including the half that survives a reboot')
  assert.match(refused.stderr, /no data has to move/,
    'and the fact that answers the question an operator asks first')

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

  const entered = runBash(rig([...ANCHOR, 'pin_dir_beneath_root'], `pin_dir_beneath_root "${mount}" "${mount}"; echo "rc=$?"`))
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
  const viaLink = runBash(rig([...ANCHOR, 'pin_dir_beneath_root'], `pin_dir_beneath_root "${link}" "${link}"; echo "rc=$?"`))
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
    callSites: 8,
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
    callSites: 3,
    targets: ['${FENCE_FILE}', '${DB_ENV_SNAPSHOT_FILE}', '${DB_FENCE_STATE}', '${CRON_BACKUP}'],
  },
  'scripts/update.sh': {
    callSites: 4,
    targets: ['${FENCE_FILE}', '${DB_ENV_SNAPSHOT_FILE}', '${DB_FENCE_IDENTITY_FILE}', '${DB_FENCE_STATE}', '${CRON_BACKUP}'],
  },
}

/** Every constant those targets are composed from, across the three scripts and the shared fence
 *  library. A script that does not define one simply does not contribute it. */
const PUBLICATION_CONSTANTS = [
  'APP_NAME', 'APP_DIR', 'DATA_DIR', 'DEPLOY_SSH_DIR', 'DEPLOY_SSH_KNOWN_HOSTS',
  'CUTOVER_STATE_DIR', 'FENCE_FILE', 'CRON_BACKUP', 'DB_FENCE_DIR', 'DB_FENCE_STATE',
  'DB_ENV_SNAPSHOT_DIR', 'DB_ENV_SNAPSHOT_FILE', 'DB_CA_PUBLISH_DIR',
  'DB_CA_GENERATION_PREFIX', 'DB_CA_GENERATION_SUFFIX', 'DB_ROLE_ROTATION_JOURNAL',
  'DEPLOY_META_FILE', 'DB_FENCE_RECOVERY_DIR', 'DB_FENCE_IDENTITY_FILE',
]

/** The same set plus the staging directory every publication is written through. */
const PROTECTED_CONSTANTS = [...PUBLICATION_CONSTANTS, 'PUBLISH_STAGE_DIRNAME']

/** The five roots publish_trust_root_candidates() can name, at their shipped values. A resolution
 *  to anything else means the table has grown a directory nobody argued for. */
const SHIPPED_ROOTS = new Set([
  '/opt/one-two-inventory', '/var/lib/one-two-inventory', '/root/ims/onetwo3d-ims',
  '/etc/ims-cutover', '/etc/ims-db-ca', '/etc/ims-cutover-recovery',
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
 *   ten PATHS      it reads, writes, seals, renames through or EXECUTES every one of them. Re-aim
 *                  ${DB_FENCE_SCRIPT_COPY} and root runs a file of the application account's
 *                  choosing with DEPLOY_ADMIN_DATABASE_URL beside it; re-aim
 *                  ${DB_FENCE_ARTEFACT_FILE} and the digest is compared against a record somebody
 *                  else wrote. ${DB_FENCE_RETIRED_APP_DIR} is on the list though the finding's
 *                  seven kinds do not name it: it is the destination a publication renames the
 *                  STANDING artefact to, so it is a write, and it was found by enumerating rather
 *                  than by transcribing.
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
  'DB_FENCE_REFENCE_WRAPPER', 'DB_FENCE_VENDOR_ROOTS', 'DB_FENCE_VENDOR_MAX_FILES',
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
    'publish_root_anchored', 'publish_trust_root', 'pin_dir_beneath_root', 'publish_durable_file'],
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
  assert.equal(declared, 41 + PROTECTED_LIBRARY_CONSTANTS.length,
    `the three entrypoints declared 41 protected publication constants between them when this was written, and the `
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
 * The name an assignment's WHOLE right-hand side is, or `null` when the word is anything else.
 *
 * Stricter than {@link literalName} in one way that matters here: the quoting has to BALANCE.
 * shellAssignments() ends a word at the first byte the mask and the source agree is a
 * metacharacter, so a quoted space ends it early and `ref="DB_FENCE_PROBE_REASON extra"` comes back
 * as the fragment `"DB_FENCE_PROBE_REASON`. literalName() would read that as the name, and the
 * report set would gain a name that is not an alias — which is not a harmless over-approximation
 * here, because a report in the set is a name the CONDITIONAL rule is allowed to see beside another
 * report and stay silent about. An unbalanced fragment is therefore not a name.
 */
const ALIASED_NAME = /^(?:([A-Za-z_][A-Za-z0-9_]*)|"([A-Za-z_][A-Za-z0-9_]*)"|'([A-Za-z_][A-Za-z0-9_]*)')$/
const aliasedName = (word: string): string | null => {
  const match = ALIASED_NAME.exec(word)
  return match === null ? null : (match[1] ?? match[2] ?? match[3])
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
    for (const [file, source] of sources) {
      for (const held of shellAssignments(source, file)) {
        if (reports.has(held.name)) continue
        const pointee = aliasedName(held.value)
        if (pointee === null || !reports.has(pointee)) continue
        reports.add(held.name)
        followed.push(`${held.name} (holds the NAME ${pointee}, from ${file}:${held.line})`)
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
// The recursive chown, which must not hand a staging directory back to the service account.
// ---------------------------------------------------------------------------

test('[o3d-czpy] the recursive chown over DATA_DIR skips the lock directory AND every staging directory', (t) => {
  const root = createTempDirSync('ims-czpy-chown-', t)
  const dataDir = join(root, 'data')
  mkdirSync(join(dataDir, 'uploads/invoices'), { recursive: true })
  mkdirSync(join(dataDir, 'locks'))
  writeFileSync(join(dataDir, 'locks/.crontab-reconcile.lock'), '')
  mkdirSync(join(dataDir, '.ims-publish'))
  writeFileSync(join(dataDir, '.ims-publish/publish.abc'), 'staged\n')
  mkdirSync(join(dataDir, 'deploy/.ims-publish'), { recursive: true })

  // The SHIPPED line, lifted whole. A test that retyped the find expression would be testing the
  // test. `chown` is shimmed because this harness is not root and the question is which PATHS the
  // line reaches, not what it does to them.
  const line = INSTALL_SH.split('\n')
  const at = line.findIndex((l) => l.startsWith('find "${DATA_DIR}"') && l.includes('-prune'))
  assert.notEqual(at, -1, 'scripts/install.sh must still chown ${DATA_DIR} with a pruned find')
  const shipped = `${line[at]}\n${line[at + 1]}`
  assert.match(shipped, /chown -h/, 'and it must still be the chown line')

  const log = join(root, 'chown.log')
  const bin = shimDir(t, { chown: `for a in "$@"; do ims_shim_append ${q(log)} "$a"; done\nexit 0` })
  const run = runBash([
    'set -uo pipefail',
    `DATA_DIR="${dataDir}"`,
    `CRONTAB_LOCK_DIR="${join(dataDir, 'locks')}"`,
    'APP_USER=svcuser',
    shellConstant(INSTALL_SH, 'PUBLISH_STAGE_DIRNAME'),
    shipped,
  ].join('\n'), { env: { PATH: `${bin}:${process.env.PATH ?? ''}` } })
  assert.equal(run.status, 0, run.stderr)

  const touched = readFileSync(log, 'utf8').split('\n').filter(Boolean)
  // NOT VACUOUS: the walk did reach the directory and did chown the ordinary contents.
  assert.ok(touched.includes(join(dataDir, 'uploads/invoices')), `the walk must reach the ordinary tree: ${touched.join(' ')}`)
  assert.ok(!touched.some((p) => p.includes('.ims-publish')),
    `no staging directory may be handed to the service account: ${touched.join(' ')}`)
  assert.ok(!touched.some((p) => p.includes('/locks')),
    `nor the crontab lock directory: ${touched.join(' ')}`)
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
