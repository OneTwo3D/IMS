import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

/**
 * The text of one top-level shell function, from `name() {` to the `}` in column 0.
 *
 * Used by the durability tests below to RUN the shipped code rather than to describe it:
 * a re-implementation of the marker writer would pass while the script wrote something
 * else, which is the failure mode this whole file exists to prevent.
 */
function shellFunction(source: string, name: string): string {
  const start = source.indexOf(`\n${name}() {\n`)
  assert.notEqual(start, -1, `the script must define ${name}()`)
  const rest = source.slice(start + 1)
  const end = rest.indexOf('\n}\n')
  assert.notEqual(end, -1, `${name}() must be closed by a } in column 0`)
  return rest.slice(0, end + 2)
}

/**
 * The durability primitives every marker and cron-backup writer now goes through, taken
 * from the script under test.
 *
 * A harness that stubbed these would prove the writer CALLS something; the finding was
 * about what actually reaches the medium, so the shipped implementations are what run.
 */
function durabilityFunctions(source: string): string {
  return [
    shellFunction(source, 'fsync_path'),
    shellFunction(source, 'publish_durable_file'),
    // The drop-in publisher is one of these too (o3d-2sm1.5, Codex r11): install_reboot_fence()
    // routes the systemd fragment through it, so a harness without it fails the install with
    // "command not found" and every "the install must fail" test passes for the wrong reason.
    shellFunction(source, 'publish_durable_dropin'),
  ].join('\n')
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
  const start = realCodeLine(INSTALL_LINES, /systemctl enable --now/)
  assert.notEqual(hook, -1, 'the installer must run the migrations\' own checks too')
  assert.ok(hook < start, 'and pass them before the service is started')
})

test('install.sh lifts the fences immediately before the start, and restores cron after it', () => {
  const start = realCodeLine(INSTALL_LINES, /systemctl enable --now/)
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
  const splice = realCodeLine(INSTALL_LINES, /crontab -u "\$\{APP_USER\}" -l .* \| awk/)
  assert.notEqual(splice, -1, 'the managed cron block is spliced into whatever the crontab currently holds')
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
DB_FENCE_RELEASE_CMD='node fence-db-connections.mjs --release'
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
DB_FENCE_RELEASE_CMD='node fence-db-connections.mjs --release'
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
DB_FENCE_RELEASE_CMD='node fence-db-connections.mjs --release'
success() { :; }
die() { echo "die: $*" >&2; exit 1; }
`,
  },
] as const

/** Run the script's OWN marker functions, then walk away — exactly what a SIGKILL leaves. */
function runMarkerHarness(entry: (typeof MARKER_CASES)[number], call: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ims-marker-'))
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
    rmSync(dir, { recursive: true, force: true })
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
    const rename = publish.indexOf('mv -f "$tmp" "$target"')
    const dirBarrier = publish.indexOf('fsync_path "$dir"')
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
    assert.match(refence, /--fence/, 'the trap-safe re-fence must actually re-apply the revoke')
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
DRY_RUN=false
BLUE=''; GREEN=''; YELLOW=''; RED=''; BOLD=''; RESET=''
APP_USER="$(id -un)"
STATE_DIR='${dir}'
CUTOVER_STATE_DIR='${dir}'
DB_FENCE_DIR='${dir}'
DB_FENCE_SCRIPT='${dir}/fence.mjs'
DB_FENCE_STATE='${dir}/db-connect-fence.json'
DEPLOY_ADMIN_DATABASE_URL='postgres://admin@127.0.0.1/nowhere'
MIGRATION_DATABASE_URL=''
DB_FENCE_UP=false
DB_FENCE_RELEASE_CMD='node fence-db-connections.mjs --release'
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
DRY_RUN=false
BLUE=''; GREEN=''; YELLOW=''; RED=''; BOLD=''; RESET=''
APP_USER="$(id -un)"
DB_FENCE_DIR='${dir}'
DB_FENCE_SCRIPT='${dir}/fence.mjs'
DB_FENCE_STATE='${dir}/db-connect-fence.json'
DATABASE_URL='postgres://app@127.0.0.1/nowhere'
DEPLOY_ADMIN_DATABASE_URL='postgres://admin@127.0.0.1/nowhere'
MIGRATION_DATABASE_URL=''
DB_FENCE_UP=false
DB_FENCE_RELEASE_CMD='node fence-db-connections.mjs --release'
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
BLUE=''; GREEN=''; YELLOW=''; RED=''; BOLD=''; RESET=''
APP_USER="$(id -un)"
APP_DIR='${dir}'
DB_FENCE_DIR='${dir}'
DB_FENCE_SCRIPT='${dir}/fence.mjs'
DB_FENCE_STATE='${dir}/db-connect-fence.json'
DATABASE_URL='postgres://app@127.0.0.1/nowhere'
DEPLOY_ADMIN_DATABASE_URL='postgres://admin@127.0.0.1/nowhere'
MIGRATION_DATABASE_URL=''
DB_FENCE_UP=false
DB_FENCE_RELEASE_CMD='node fence-db-connections.mjs --release'
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
      execFileSync('bash', ['-c', `printf 'process.exit(3)\\n' > "${dir}/fence.mjs"`])
      const program = [
        'set -euo pipefail',
        entry.preamble(dir),
        shellFunction(entry.source, 'ensure_cutover_state_dirs'),
        shellFunction(entry.source, 'ensure_cutover_state_dirs'),
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

  test(`${entry.name} treats a successful fence as the only way past the drain`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ims-fence0-'))
    try {
      // The stub answers --print-migration-url the way the real script does, and exits 0 for
      // --fence. Anything else the shell might do with the admin URL is then visible in
      // MIGRATION_DATABASE_URL.
      writeFileSync(
        join(dir, 'fence.mjs'),
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
        shellFunction(entry.source, 'ensure_cutover_state_dirs'),
        shellFunction(entry.source, 'ensure_cutover_state_dirs'),
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
      writeFileSync(
        join(dir, 'fence.mjs'),
        ["if (process.argv.includes('--print-migration-url')) process.exit(1)", 'process.exit(0)', ''].join('\n'),
      )
      const program = [
        'set -euo pipefail',
        entry.preamble(dir),
        shellFunction(entry.source, 'ensure_cutover_state_dirs'),
        shellFunction(entry.source, 'ensure_cutover_state_dirs'),
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
  const start = realCodeLine(INSTALL_LINES, /systemctl enable --now/)

  assert.notEqual(seed, -1, 'the installer must seed')
  assert.notEqual(bootstrap, -1, 'and bootstrap the admin/settings')
  assert.ok(migrate < seed, 'the seed writes rows that need the migrated schema')
  assert.ok(migrate < bootstrap, 'and so does the bootstrap')
  assert.ok(seed < start && bootstrap < start, 'both run with nothing serving, before the start')
})

test('install.sh health-checks the new build before it calls the cutover complete', () => {
  // The cutover had no health check at all: it started the unit and restored cron, so a new
  // build that failed on its first request was reported as a successful upgrade.
  const start = realCodeLine(INSTALL_LINES, /systemctl enable --now/)
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
DB_FENCE_RELEASE_CMD='node fence-db-connections.mjs --release'
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
DB_FENCE_RELEASE_CMD='node fence-db-connections.mjs --release'
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
DB_FENCE_RELEASE_CMD='node fence-db-connections.mjs --release'
success() { :; }
warn() { :; }
error() { :; }
die() { echo "die: $*" >&2; exit 1; }
systemctl() { [ "$1" = daemon-reload ] && return 1; return 0; }
`,
  },
] as const

function runFenceInstallHarness(entry: (typeof FENCE_INSTALL_CASES)[number], prelude: string) {
  const dir = mkdtempSync(join(tmpdir(), 'ims-fenceinstall-'))
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
    rmSync(dir, { recursive: true, force: true })
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
    const dir = mkdtempSync(join(tmpdir(), 'ims-fenceok-'))
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
      rmSync(dir, { recursive: true, force: true })
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

for (const [name, lines, startPattern] of [
  ['deploy.sh', DEPLOY_LINES, /systemctl start|npm start/],
  ['update.sh', UPDATE_LINES, /systemctl start/],
  ['install.sh', INSTALL_LINES, /systemctl enable --now/],
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
    const continuation = callContinuation(lines, call)

    assert.match(
      continuation,
      /\|\|\s*(\\\s*\n\s*)?die\b/,
      'a schema the application cannot use must `die`; `|| true` was a mutation this file passed',
    )
    assert.ok(
      !/\|\|\s*(true|:|warn|info|success|echo)\b/.test(continuation),
      'and the guard must not be satisfied by a no-op continuation',
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
  test(`${entry.name} arms the fence at the stop, so a cron-fencing failure is not a post-stop failure`, () => {
    const { lines } = entry
    // The anchor is the reboot-fence install, so start looking a little before it: the
    // arming flag has to be raised BEFORE the first thing that creates cutover state.
    const anchor = entry.anchor(lines)
    const from = Math.max(0, anchor - 40)

    const arming = requireCodeLine(lines, /^\s*CUTOVER_ARMING=true\s*$/, from, 'the reversible phase must be entered explicitly')
    const install = requireCodeLine(lines, /install_reboot_fence "/, arming, 'the reboot fence is installed inside the arming phase')
    const cron = requireCodeLine(lines, /^\s*fence_cron\s*$/, arming, 'the cron writers are fenced inside the arming phase')
    const armed = requireCodeLine(lines, /^\s*FENCE_ARMED=true\s*$/, arming, 'and the fence is armed after it')
    const stop = requireCodeLine(lines, /systemctl stop/, armed, 'the stop must follow the arming')

    assert.ok(arming < install, 'the arming phase must be entered before the reboot fence is written')
    assert.ok(
      cron < armed,
      'fence_cron must run INSIDE the reversible phase: every way it can fail used to be reported as a post-stop failure, and answered by stopping a healthy service',
    )
    assert.ok(armed < stop, 'and FENCE_ARMED must be raised before anything is actually stopped')

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
DB_FENCE_RELEASE_CMD='node fence-db-connections.mjs --release'
`,
  },
  {
    name: 'update.sh',
    source: UPDATE_LINES.join('\n'),
    trap: 'on_exit',
    marker: 'FENCED',
    preamble: (dir: string) => `
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
DB_FENCE_RELEASE_CMD='node fence-db-connections.mjs --release'
`,
  },
  {
    name: 'install.sh',
    source: INSTALL_SOURCE,
    trap: 'on_cutover_exit',
    marker: 'FENCED',
    preamble: (dir: string) => `
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
DB_FENCE_RELEASE_CMD='node fence-db-connections.mjs --release'
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
crontab(){ echo "crontab $*" >> "\${LOG}"; return 0; }
install_reboot_fence(){ echo "install_reboot_fence $*" >> "\${LOG}"; return 0; }
release_db_connections(){ echo "release_db_connections" >> "\${LOG}"; return 0; }
refence_db_connections(){ echo "refence_db_connections" >> "\${LOG}"; return 0; }
write_fence_marker(){ echo "write_fence_marker $*" >> "\${LOG}"; return 0; }
write_cutover_marker(){ echo "write_cutover_marker $*" >> "\${LOG}"; return 0; }
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

    const program = [
      'set -euo pipefail',
      entry.preamble(dir),
      TRAP_STUBS,
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
      /crontab -u appuser \S*crontab\.bak/,
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
      !/crontab -u appuser \S*crontab\.bak/.test(result.log),
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
  const dir = mkdtempSync(join(tmpdir(), 'ims-r8-marker-'))
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
    rmSync(dir, { recursive: true, force: true })
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
    shellFunction(entry.source, 'marker_is_complete'),
    shellFunction(entry.source, 'marker_phase'),
    shellFunction(entry.source, 'predecessor_is_active'),
    shellFunction(entry.source, 'remove_reboot_fence'),
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
  const dir = mkdtempSync(join(tmpdir(), 'ims-r8-adopt-'))
  try {
    const dropinDir = join(dir, 'dropin')
    execFileSync('mkdir', ['-p', dropinDir])
    // Exactly what an interrupted arming leaves on disk: the marker, the drop-in it had just
    // written, and the crontab backup it had just taken.
    writeFileSync(join(dir, 'FENCED'), marker)
    writeFileSync(join(dropinDir, 'zz-deploy-fence.conf'), '[Unit]\n')
    writeFileSync(join(dir, 'crontab.bak'), '*/5 * * * * /usr/bin/true\n')

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
    rmSync(dir, { recursive: true, force: true })
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
      /crontab -u appuser \S*crontab\.bak/,
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
DB_FENCE_STATE="\${CUTOVER_STATE_DIR}/deploy/db-connect-fence.json"
DB_FENCE_RELEASE_CMD='node fence-db-connections.mjs --release'
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
sync(){ echo "sync \$*" >> "\${BARRIERS}"; command sync "\$@"; }
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
  const dir = mkdtempSync(join(tmpdir(), 'ims-r9-'))
  try {
    const program = [
      'set -euo pipefail',
      R9_MARKER_PREAMBLE(dir),
      extra,
      ...functions.map((name) => shellFunction(entry.source, name)),
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
    rmSync(dir, { recursive: true, force: true })
  }
}

for (const entry of R9_SCRIPTS) {
  test(`${entry.name} fsyncs the marker data before the rename and the directory after it`, () => {
    // THE ORDERING IS THE PROPERTY. Data flushed after the rename can publish a name whose
    // content is not on the medium; a directory never flushed can lose the name itself,
    // however well the data was written. Observed, not asserted from the source.
    const result = runR9(entry, ['fsync_path', 'publish_durable_file', entry.writer], `${entry.writer} "under test"`, R9_BARRIER_SHIMS)
    assert.equal(result.status, 0, `the writer must succeed:\n${result.stdout}`)

    const dataBarrier = result.barriers.findIndex((line) => /^sync .*DEPLOY-FENCED\.\w+$/.test(line))
    const rename = result.barriers.findIndex((line) => /^mv -f .*DEPLOY-FENCED\.\w+ .*DEPLOY-FENCED$/.test(line))
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
    assert.deepEqual(
      result.files.filter((name) => name.startsWith('DEPLOY-FENCED.')),
      [],
      `and no temporary may be left behind: ${result.files.join(', ')}`,
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
      ['fsync_path', 'publish_cron_backup', 'fence_cron'],
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

/** The right-hand side of one top-level assignment, as the script actually writes it. */
function assignment(source: string, name: string): string {
  const match = new RegExp(`^${name}=(.*)$`, 'm').exec(source)
  assert.notEqual(match, null, `the script must define ${name}`)
  return (match as RegExpExecArray)[1]
}

test('all three entrypoints resolve the cutover namespace from the same expression', () => {
  const resolved = R9_SCRIPTS.map((entry) => assignment(entry.source, 'CUTOVER_STATE_DIR'))
  assert.equal(
    new Set(resolved).size,
    1,
    `a namespace resolved differently per entrypoint is the defect itself:\n${R9_SCRIPTS.map((e, i) => `${e.name}: ${resolved[i]}`).join('\n')}`,
  )

  // And every path that decides recovery hangs off it, in the same shape everywhere.
  for (const key of ['FENCE_FILE', 'CRON_BACKUP', 'DB_FENCE_DIR', 'LOCK_FILE'] as const) {
    const values = R9_SCRIPTS.map((entry) => assignment(entry.source, key))
    assert.equal(
      new Set(values).size,
      1,
      `${key} must be the same path in all three:\n${R9_SCRIPTS.map((e, i) => `${e.name}: ${values[i]}`).join('\n')}`,
    )
    assert.match(values[0], /\$\{CUTOVER_STATE_DIR\}/, `${key} must derive from the shared namespace, not a private directory`)
  }

  // The connection-fence state is one level down, and also shared.
  const fenceStates = R9_SCRIPTS.map((entry) => assignment(entry.source, 'DB_FENCE_STATE'))
  assert.equal(new Set(fenceStates).size, 1, `DB_FENCE_STATE must be the same path in all three: ${fenceStates.join(' | ')}`)

  // No entrypoint may quietly keep its own.
  for (const entry of R9_SCRIPTS) {
    const privatePaths = entry.source
      .split(/\r?\n/)
      .filter((line) => /^(FENCE_FILE|CRON_BACKUP|DB_FENCE_STATE|DB_FENCE_DIR|LOCK_FILE)=/.test(line))
      .filter((line) => !line.includes('${CUTOVER_STATE_DIR}') && !line.includes('${DB_FENCE_DIR}'))
    assert.deepEqual(privatePaths, [], `${entry.name} still resolves cutover state outside the shared namespace: ${privatePaths}`)
  }
})

test('all three entrypoints carry the same durability and namespace primitives, byte for byte', () => {
  // A fix applied to one script and not the others is how both the AND-OR harness defect and
  // this namespace split survived a round. Shared text cannot drift silently.
  for (const name of [
    'fsync_path',
    'publish_durable_file',
    'publish_durable_dropin',
    'ensure_cutover_state_dirs',
    'acquire_cutover_lock',
    'marker_is_complete',
    'import_legacy_file',
    'import_legacy_cutover_state',
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
DB_FENCE_DIR="\${CUTOVER_STATE_DIR}/deploy"
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
      ].join('\n'),
      R9_LEGACY_STATE,
    )

    assert.equal(result.status, 0, `the import must succeed:\n${result.stdout}`)
    assert.match(result.stdout, /MARKER=phase=stopping;/, `the marker must arrive at the shared path:\n${result.stdout}`)
    assert.match(result.stdout, /CRON=\*\/5 \* \* \* \* \/usr\/bin\/true/, 'and the crontab backup with it')
    assert.match(result.stdout, /DBSTATE=\{"grants":\[\]\}/, 'and the recorded grants, or the fence can never be released')
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
        'DB_FENCE_DIR="${CUTOVER_STATE_DIR}/deploy"',
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
        'DB_FENCE_DIR="${CUTOVER_STATE_DIR}/deploy"',
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
  if [[ $# -eq 0 || "\${1}" == "\${CUTOVER_STATE_DIR}" ]]; then return 1; fi
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
sync(){ echo "sync \$*" >> "\${BARRIERS}"; command sync "\$@"; }
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
