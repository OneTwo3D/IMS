import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import test, { mock } from 'node:test'

// ---------------------------------------------------------------------------
// Codex r20 HIGH (second finding) — SCHEDULER STATE IS NOT AN ORDINARY PREFERENCE.
//
// The Backup and FX schedule panels saved through the generic key/value writer, and the r20
// allowlist listed their keys as ordinary preferences on the strength of "a screen offers them".
// Both were duplicating enablement the cron registry owns, and both controls were broken:
//
//   • BACKUP. Two rows answer "are scheduled backups on?" and they are not the same row. The crontab
//     is built from `cron_backup_enabled`, falling back to the registry's legacyEnabledKey
//     (`backup_schedule_enabled`) only while the canonical row is absent; `/api/cron/backup` gates
//     its own execution on `backup_schedule_enabled`. The generic save wrote only the legacy row and
//     never reconciled the crontab — so switching backups on stored 'true' and installed no cron
//     line, and once anyone had touched the Scheduled Jobs editor the switch reached the crontab not
//     at all.
//   • FX. `fx_schedule_enabled` / `fx_schedule_interval_hours` had NO reader anywhere. The panel
//     reported "Saved" over a switch that changed nothing; /api/cron/fx-rates runs whenever invoked.
//
// WHAT THESE TESTS PIN, and the route each takes:
//   1. saveBackupScheduleSettings writes BOTH enablement rows plus the preferences in ONE
//      transaction, and reconciles the crontab AFTER the commit
//                                            (backup-schedule.tsx → saveBackupScheduleSettings)
//   2. a crontab failure is reported as committed-but-scheduler-behind, never as a failed save
//                                            (same route, post-commit guard)
//   3. an invalid retention/count/target is refused BEFORE the write   (same route, validation gate)
//   4. every key that screen used to send is now refused by BOTH generic writers
//                                            (setSetting / setSettings → assertWritableSettingKeys)
//   5. saveCronJobSettings mirrors the legacy enablement row, driven from the registry
//                                            (cron-jobs-settings.tsx → saveCronJobSettings)
//   6. the dead FX schedule keys are gone from the application entirely   (repository scan)
// ---------------------------------------------------------------------------

const REPO = process.cwd()

const state = {
  /** Settings rows written, in commit order. */
  writes: [] as string[],
  transactions: 0,
  openTransactions: 0,
  /** How many rows had been written when the crontab reconciliation ran. */
  cronCalledAfterWrites: null as number | null,
  /** Whether a transaction was still open when it ran — it must not be. */
  openTransactionsWhenCronRan: null as number | null,
  cronResult: { success: true } as { success: boolean; error?: string },
  cronThrows: null as Error | null,
  logActivityThrows: null as Error | null,
  revalidated: [] as string[],
  permissions: [] as string[],
}

function reset() {
  state.writes = []
  state.transactions = 0
  state.openTransactions = 0
  state.cronCalledAfterWrites = null
  state.openTransactionsWhenCronRan = null
  state.cronResult = { success: true }
  state.cronThrows = null
  state.logActivityThrows = null
  state.revalidated = []
  state.permissions = []
}

const txClient = {
  setting: {
    upsert: async ({ where, create }: { where: { key: string }; create: { key: string; value: string } }) => {
      state.writes.push(`${where.key}=${create.value}`)
      return { key: where.key, value: create.value }
    },
  },
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: txClient.setting,
      $transaction: async (arg: unknown) => {
        if (typeof arg !== 'function') return Promise.all(arg as unknown[])
        state.transactions += 1
        state.openTransactions += 1
        try {
          return await (arg as (tx: typeof txClient) => Promise<unknown>)(txClient)
        } finally {
          state.openTransactions -= 1
        }
      },
    },
  },
})

mock.module('@/lib/auth/server', {
  namedExports: {
    requireAuth: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
    requirePermission: async (permission: string) => {
      state.permissions.push(permission)
      return { user: { id: 'u1', role: 'ADMIN' } }
    },
    requireInternalUser: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
    requireAdmin: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
    requireFreshAdmin: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
    freshAuthFailureResult: () => null,
  },
})

mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async () => { if (state.logActivityThrows) throw state.logActivityThrows } },
})
mock.module('next/cache', { namedExports: { revalidatePath: (path: string) => { state.revalidated.push(path) } } })

/**
 * INJECTABLE, and doubling `@/lib/crontab-reconcile` rather than `@/app/actions/cron` — the same
 * reasoning as tests/accounting/plugin-selection-lock.test.ts. The assertions below observe calls
 * through this double, so a stale mock target fails loudly rather than letting the real crontab work
 * run inside the test.
 */
mock.module('@/lib/crontab-reconcile', {
  namedExports: {
    reconcileCrontab: async () => {
      state.cronCalledAfterWrites = state.writes.length
      state.openTransactionsWhenCronRan = state.openTransactions
      if (state.cronThrows) throw state.cronThrows
      return state.cronResult
    },
    readOwnCrontab: async () => '',
  },
})

const VALID = { enabled: true, retentionDays: '30', maxCount: '10', autoUpload: 's3' }

async function saveBackup(input: typeof VALID) {
  const { saveBackupScheduleSettings } = await import('@/app/actions/settings')
  return saveBackupScheduleSettings(input)
}

test.beforeEach(reset)

test('the backup schedule save writes BOTH enablement rows in one transaction, then reconciles', async () => {
  const result = await saveBackup(VALID)

  assert.deepEqual(result, { status: 'saved' })
  assert.deepEqual(state.permissions, ['settings.company'])
  assert.deepEqual(state.writes, [
    // The row the CRONTAB reads. Its absence was the whole defect: without it the switch reached the
    // crontab only on instances where the legacy fallback was still live.
    'cron_backup_enabled=true',
    // The row /api/cron/backup reads. Equal to the canonical one, so the two gates cannot disagree.
    'backup_schedule_enabled=true',
    'backup_retention_days=30',
    'backup_max_count=10',
    'backup_auto_upload=s3',
  ])
  assert.equal(state.transactions, 1, 'one transaction — a partial commit is a half-configured schedule')
  assert.equal(state.cronCalledAfterWrites, 5, 'the crontab is reconciled AFTER every row is written')
  assert.equal(state.openTransactionsWhenCronRan, 0, 'and outside the transaction, not holding it open')
  assert.deepEqual(state.revalidated, ['/settings'])
})

test('switching backups OFF writes false to both rows', async () => {
  // The asymmetric half of the defect: with only the legacy row written, a disable could leave the
  // cron line installed and the route silently skipping — a backup job that runs and does nothing.
  await saveBackup({ ...VALID, enabled: false })
  assert.ok(state.writes.includes('cron_backup_enabled=false'))
  assert.ok(state.writes.includes('backup_schedule_enabled=false'))
})

test('a crontab failure is committed-but-scheduler-behind, never a failed save', async () => {
  state.cronResult = { success: false, error: 'crontab write failed: no crontab for ims' }

  const result = await saveBackup(VALID)

  assert.equal(result.status, 'post-commit-failed')
  assert.equal(result.status === 'post-commit-failed' ? result.step : null, 'scheduler')
  assert.match(result.status === 'post-commit-failed' ? result.error : '', /crontab write failed/)
  assert.ok(state.writes.length > 0, 'and the values really are stored — the screen must not say otherwise')
})

test('an invalid schedule is refused BEFORE anything is written', async () => {
  // Refused, not stored-then-corrected: the purge reads these as `parseInt(x) || default`, so a
  // blank or a zero silently became 30 days / 10 files — a schedule the operator never chose.
  const invalid: Array<[string, typeof VALID]> = [
    ['retention 0', { ...VALID, retentionDays: '0' }],
    ['retention blank', { ...VALID, retentionDays: '' }],
    ['retention fractional', { ...VALID, retentionDays: '1.5' }],
    ['max count blank', { ...VALID, maxCount: '' }],
    ['unknown upload target', { ...VALID, autoUpload: 'ftp' }],
  ]

  for (const [why, input] of invalid) {
    reset()
    const result = await saveBackup(input)
    assert.equal(result.status, 'refused', `${why} must be refused`)
    assert.deepEqual(state.writes, [], `${why}: nothing may be written`)
    assert.equal(state.transactions, 0, `${why}: no transaction may open`)
    assert.equal(state.cronCalledAfterWrites, null, `${why}: the crontab is untouched`)
  }

  // Non-vacuity: '' IS a legitimate upload target (it means "do not upload"), so the check is not
  // "refuse every empty string".
  reset()
  assert.deepEqual(await saveBackup({ ...VALID, autoUpload: '' }), { status: 'saved' })
})

test('every key this screen used to send is now refused by BOTH generic writers', async () => {
  // The panel is the only writer of these rows, and it no longer goes through setSetting/setSettings.
  // The FX pair is here too: nothing writes it any more, so a generic write would resurrect a row
  // with no reader.
  const { setSetting, setSettings } = await import('@/app/actions/settings')
  const retired = [
    'backup_schedule_enabled',
    'backup_retention_days',
    'backup_max_count',
    'backup_auto_upload',
    'fx_schedule_enabled',
    'fx_schedule_interval_hours',
    'cron_backup_enabled',
  ]

  for (const key of retired) {
    reset()
    await assert.rejects(() => setSettings({ [key]: '1' }), `setSettings must refuse ${key}`)
    assert.deepEqual(state.writes, [], `${key}: setSettings committed nothing`)
    reset()
    await assert.rejects(() => setSetting(key, '1'), `setSetting must refuse ${key}`)
    assert.deepEqual(state.permissions, [], `${key}: setSetting refused on its OWN line`)
  }
})

test('saveCronJobSettings mirrors the legacy enablement row, driven from the registry', async () => {
  // The other direction of the same disagreement: the Scheduled Jobs editor writing only
  // `cron_backup_enabled` left `backup_schedule_enabled` stale, so the cron line ran a route that
  // skipped. The mirror is registry-driven, so a job that gains a legacyEnabledKey is covered
  // without this test changing — via the BARREL, because registration is an import side effect and
  // the bare registry module is empty.
  const { getAllCronJobs } = await import('@/lib/cron-jobs')
  const legacyJobs = getAllCronJobs().filter((job) => job.legacyEnabledKey)
  assert.ok(legacyJobs.length > 0, 'no job declares a legacy enablement row — this test asserts nothing')

  const { saveCronJobSettings } = await import('@/app/actions/cron')

  for (const job of legacyJobs) {
    reset()
    const result = await saveCronJobSettings([{ settingKey: job.settingKey, enabled: true, schedule: '0 1 * * *' }])
    assert.deepEqual(result, { status: 'saved' })
    assert.ok(
      state.writes.includes(`${job.legacyEnabledKey}=true`),
      `${job.settingKey}: the legacy row ${job.legacyEnabledKey} must be written too`,
    )
    assert.ok(state.writes.includes(`cron_${job.settingKey}_enabled=true`), 'and the canonical row')
    assert.equal(state.transactions, 1, 'in the SAME transaction — a mirror that can half-apply is not one')
  }

  // THE REGISTRY MUST BE READ THROUGH THE BARREL, and no behavioural assertion here can show it:
  // registration is a module-load side effect on a process-global array, and this test file has
  // already imported the barrel, so `@/lib/cron-registry` would answer identically. It is asserted
  // as source instead, honestly labelled. Today app/actions/cron.ts also reaches the barrel
  // transitively (via @/lib/crontab-reconcile), so the bare spelling happens to work; the import
  // below is what keeps it working if that transitive path ever changes, and a mutation to the bare
  // module fails HERE rather than silently mirroring nothing.
  const cronSource = readFileSync(join(REPO, 'app/actions/cron.ts'), 'utf8')
  assert.match(
    cronSource,
    /import \{[^}]*getAllCronJobs[^}]*\} from '@\/lib\/cron-jobs'/,
    'the registry is read through the barrel that registers the jobs, not the bare registry module',
  )

  // A job WITHOUT a legacy key gets exactly its two canonical rows and nothing invented.
  const plain = getAllCronJobs().find((job) => !job.legacyEnabledKey)
  assert.ok(plain, 'every job has a legacy key — the negative case cannot be exercised')
  reset()
  await saveCronJobSettings([{ settingKey: plain!.settingKey, enabled: false, schedule: '0 2 * * *' }])
  assert.deepEqual(state.writes, [`cron_${plain!.settingKey}_enabled=false`, `cron_${plain!.settingKey}_schedule=0 2 * * *`])
})

/** Source with `//` and block comments removed, so a key NAMED in a comment is not read as a use. */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1 ')
}

test('a failed LOCAL post-commit step does not skip the crontab reconciliation', async () => {
  // The enable switch IS a crontab line, so skipping the reconciliation on a transient activity-log
  // failure meant the operator switched backups on, the row committed, and no scheduled invocation
  // was ever installed — under a warning that said only the audit entry or a cache might lag.
  state.logActivityThrows = new Error('activity log unavailable')

  const result = await saveBackup(VALID)

  assert.equal(state.cronCalledAfterWrites, 5, 'the crontab was still reconciled')
  // The local failure is what is reported, because the scheduler step succeeded.
  assert.deepEqual(result, { status: 'post-commit-failed', step: 'local', error: 'activity log unavailable' })
})

test('when BOTH post-commit steps fail, the SCHEDULER is the one reported', async () => {
  // It is the one with a named operator recovery, and the one whose artefact decides whether
  // anything runs. Reporting the audit row instead is how the false sentence got written.
  state.logActivityThrows = new Error('activity log unavailable')
  state.cronResult = { success: false, error: 'crontab write failed: no crontab for ims' }

  const result = await saveBackup(VALID)

  assert.equal(result.status, 'post-commit-failed')
  assert.equal(result.status === 'post-commit-failed' ? result.step : null, 'scheduler')
  assert.match(result.status === 'post-commit-failed' ? result.error : '', /crontab write failed/)
})

test('the scheduled-jobs editor also reconciles after a failed local step', async () => {
  // Cross-ported: same shape, on the screen whose entire purpose is to change the crontab.
  const { saveCronJobSettings } = await import('@/app/actions/cron')
  state.logActivityThrows = new Error('activity log unavailable')

  const result = await saveCronJobSettings([{ settingKey: 'backup', enabled: true, schedule: '0 1 * * *' }])

  assert.notEqual(state.cronCalledAfterWrites, null, 'the crontab was still reconciled')
  assert.deepEqual(result, { status: 'post-commit-failed', step: 'local', error: 'activity log unavailable' })
})

test('a diverged enablement pair resolves the same way for the crontab, the route and the screen', async () => {
  // No migration is applied on this branch, so an installation whose two rows already disagree is
  // fixed at READ time or not at all. All three readers now go through one resolver, in the
  // crontab's order — canonical, then legacy, then the registry default.
  const { resolveCronEnablement } = await import('@/lib/domain/settings/cron-enablement')
  const { isBackupScheduleEnabled } = await import('@/lib/domain/settings/backup-schedule-enabled')
  const { buildOtiCrontabBlock } = await import('@/lib/crontab-sync')
  const { getAllCronJobs } = await import('@/lib/cron-jobs')

  const backup = getAllCronJobs().find((job) => job.slug === 'backup')
  assert.ok(backup, 'the backup job is still registered')
  assert.equal(backup!.legacyEnabledKey, 'backup_schedule_enabled', 'and still declares the legacy row')

  // The two directions the divergence can take, plus the two agreeing cases and the absent case.
  const cases: Array<{ canonical: string | null; legacy: string | null; expected: boolean; why: string }> = [
    { canonical: 'true', legacy: 'false', expected: true, why: 'canonical wins: the cron line exists, so the route must not skip' },
    { canonical: 'false', legacy: 'true', expected: false, why: 'canonical wins: there is no cron line, so the screen must not say ON' },
    { canonical: 'true', legacy: 'true', expected: true, why: 'agreeing, on' },
    { canonical: 'false', legacy: 'false', expected: false, why: 'agreeing, off' },
    { canonical: null, legacy: 'true', expected: true, why: 'never migrated: the legacy row is all there is' },
    { canonical: null, legacy: null, expected: backup!.defaultEnabled, why: 'neither row: the registry default' },
  ]

  for (const { canonical, legacy, expected, why } of cases) {
    const read = async (key: string) =>
      key === `cron_${backup!.settingKey}_enabled` ? canonical : key === backup!.legacyEnabledKey ? legacy : null

    // 1. THE ROUTE / THE SCREEN — both call this.
    assert.equal(await isBackupScheduleEnabled(read), expected, `route+screen: ${why}`)

    // 2. THE CRONTAB — asserted through the real builder, not through the resolver again, so this
    //    compares two independent readers rather than one reader with itself.
    const settings = new Map<string, string>()
    if (canonical !== null) settings.set(`cron_${backup!.settingKey}_enabled`, canonical)
    if (legacy !== null) settings.set(backup!.legacyEnabledKey!, legacy)
    const block = buildOtiCrontabBlock({
      jobs: [backup!],
      settings,
      secretRef: { kind: 'literal', secret: 'x'.repeat(32) },
      baseUrl: 'https://ims.example.com',
    })
    assert.ok(block.ok, 'the crontab block built')
    const hasLine = block.ok && block.lines.some((line: string) => line.includes('/backup'))
    assert.equal(hasLine, expected, `crontab: ${why}`)
  }

  // AND THE TWO READERS ACTUALLY GO THROUGH IT. Asserted as source because neither the route
  // handler nor a server-component loader can be invoked here, and without this the whole case table
  // above proves only that the resolver agrees with the crontab — which it would still do while the
  // route quietly read one row on its own, exactly as it did before this round.
  for (const file of ['app/api/cron/backup/route.ts', 'app/(dashboard)/settings/backup/page.tsx']) {
    const source = readFileSync(join(REPO, file), 'utf8')
    assert.match(source, /isBackupScheduleEnabled\(/, `${file} must resolve enablement through the shared reader`)
    assert.doesNotMatch(
      source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1 '),
      /getSetting\('backup_schedule_enabled'\)/,
      `${file} must not read the legacy row on its own`,
    )
  }

  // Non-vacuity of the resolver's own contract: a job with NO legacy key ignores a stray legacy value.
  assert.equal(
    resolveCronEnablement({ canonical: null, legacy: 'true', hasLegacyKey: false, defaultEnabled: false }),
    false,
    'a legacy value only counts for a job that declares a legacy key',
  )
})

test('the purge READER is safe over rows written before the gate existed', async () => {
  // Validating the writer does not fix a row already in the database, and the destructive values are
  // exactly the ones the old ungated writer could store. `parseInt(x || 'default')` caught only an
  // EMPTY row: '0' put the purge cutoff at `now` and made `i >= maxBackups` true for every file — the
  // whole backup set deleted moments after one was taken — and a non-numeric row read as NaN, so both
  // comparisons went false and nothing was ever purged.
  const { resolveBackupPurgeLimit, BACKUP_RETENTION_FALLBACK_DAYS, BACKUP_MAX_COUNT_FALLBACK } =
    await import('@/lib/domain/settings/backup-schedule-input')

  for (const destructive of ['0', '-1', '0.5']) {
    assert.equal(resolveBackupPurgeLimit(destructive, 30), 30, `${destructive} must not reach the purge`)
  }
  for (const never of ['abc', '', null, undefined]) {
    assert.equal(resolveBackupPurgeLimit(never, 10), 10, `${String(never)} must not disable the purge`)
  }
  // Non-vacuity: a real stored value is used, not replaced by the fallback.
  assert.equal(resolveBackupPurgeLimit('7', 30), 7)
  assert.equal(BACKUP_RETENTION_FALLBACK_DAYS, 30)
  assert.equal(BACKUP_MAX_COUNT_FALLBACK, 10)

  // And the route reads through it, rather than re-deriving the numbers with the old expression.
  const route = readFileSync(join(REPO, 'app/api/cron/backup/route.ts'), 'utf8')
  assert.match(route, /resolveBackupPurgeLimit\(\s*await getSetting\('backup_retention_days'\)/)
  assert.match(route, /resolveBackupPurgeLimit\(\s*await getSetting\('backup_max_count'\)/)
  assert.doesNotMatch(route, /parseInt\(await getSetting\('backup_(retention_days|max_count)'\)/)
})

test('the dead FX schedule keys are gone from the application', () => {
  // They were stored and never read. Leaving a LIVE reference anywhere invites the panel being
  // "restored" by someone who finds one and assumes it means something. The three surviving mentions
  // are prose explaining why the keys are dead, which is the opposite problem, so comments are
  // stripped before the scan.
  const dead = ['fx_schedule_enabled', 'fx_schedule_interval_hours']
  const roots = ['app', 'components', 'lib', 'scripts']
  let scanned = 0
  const hits: string[] = []

  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
        walk(full)
        continue
      }
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue
      scanned += 1
      const source = codeOf(full)
      for (const key of dead) if (source.includes(key)) hits.push(`${relative(REPO, full)}: ${key}`)
    }
  }
  for (const root of roots) walk(join(REPO, root))

  assert.ok(scanned > 200, `the walk reached only ${scanned} files`)
  assert.deepEqual(hits, [], 'a key with no reader must have no writer and no screen either')

  // The stripper is not a way of passing: it must still see a key that IS used in code. Fed the
  // exact shape the panel had before this round.
  const probe = "// fx_schedule_enabled is dead\nconst x = { fx_schedule_enabled: 'true' }\n"
  assert.ok(probe.includes('fx_schedule_enabled'))
  assert.equal(
    (probe.replace(/(^|[^:'\"`])\/\/[^\n]*/g, '$1 ').match(/fx_schedule_enabled/g) ?? []).length,
    1,
    'the comment is stripped and the code use survives',
  )
})
