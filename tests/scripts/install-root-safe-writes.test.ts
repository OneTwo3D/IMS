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

import { shellConstant, shellConstantOptional, shellFunction } from './shell-symbol.ts'
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

/** The five roots publish_trust_root_candidates() can name, at their shipped values. A resolution
 *  to anything else means the table has grown a directory nobody argued for. */
const SHIPPED_ROOTS = new Set([
  '/opt/one-two-inventory', '/var/lib/one-two-inventory', '/root/ims/onetwo3d-ims',
  '/etc/ims-cutover', '/etc/ims-db-ca', '/etc/ims-cutover-recovery',
])

const FENCE_LIB = readFileSync(join(REPO, 'scripts/lib/db-fence-protected.sh'), 'utf8')

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
  const reassigned = `${DEPLOY}\nPUBLISH_STAGE_DIRNAME="../../attacker"\n`
  assert.equal(firstAssignment(reassigned, 'PUBLISH_STAGE_DIRNAME'), shellConstant(INSTALL_SH, 'PUBLISH_STAGE_DIRNAME'),
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
