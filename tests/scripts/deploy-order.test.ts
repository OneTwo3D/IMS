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
    const fenceWriters = phaseLine(lines, 'fence-writers')
    const install = codeLine(lines, 'install_reboot_fence', fenceWriters)
    const guard = lines.slice(install, install + 4).join('\n')
    assert.match(guard, /\|\||die/, 'an unverifiable fence must stop the deploy, not warn')
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
    // migration is precisely the case it exists for.
    const set = realCodeLine(lines, /^\s*SCHEMA_TOUCHED=true$/, phaseLine(lines, 'migrate'))
    const migrateCmd = realCodeLine(lines, 'prisma migrate deploy', phaseLine(lines, 'migrate'))
    assert.notEqual(set, -1, 'the migrate phase must record that the schema may have moved')
    assert.ok(set < migrateCmd, 'the flag must be set before `prisma migrate deploy` is invoked, not after it returns')
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
