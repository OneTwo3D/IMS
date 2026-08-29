import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { mock } from 'node:test'

// ---------------------------------------------------------------------------
// Codex r21 HIGH — CONCURRENT RECONCILIATIONS COULD WRITE A STALE CRONTAB.
//
// `reconcileCrontab` snapshots the cron_* settings and then, separately, reads and rewrites the OS
// crontab. Six server actions call it, every one of them AFTER its own commit, and nothing
// serialized the two halves:
//
//   A (Backup screen)              B (Scheduled Jobs screen)
//   commit: backups OFF
//   snapshot -> OFF
//                                  commit: backups ON
//                                  snapshot -> ON
//                                  write crontab: line INSTALLED
//   write crontab: line REMOVED        <- from a snapshot taken before B committed
//
// The end state is the one the previous round removed by a different route: an enablement row
// committed ON, no cron line, and every caller reporting `saved`.
//
// WHAT THESE TESTS PIN, and the route each takes:
//   1. two concurrent saves — Backup OFF and Scheduled Jobs ON — leave the crontab agreeing with the
//      LAST COMMIT, not the last snapshot
//                       (backup-schedule.tsx -> saveBackupScheduleSettings, and
//                        cron-jobs-settings.tsx -> saveCronJobSettings, both -> reconcileCrontab)
//   2. the SNAPSHOT is inside the lock, not just the write   (same route, observed at the db read)
//   3. an ordinary single save still reconciles, and takes/releases the lock exactly once with no
//      wait                                    (backup-schedule.tsx -> saveBackupScheduleSettings)
//   4. the lock WAITS on the registered key rather than skipping     (lib/crontab-reconcile-lock.ts)
//   5. a wait that times out does not write the crontab and is reported as a failure   (same)
//   6. a lock lost mid-run refuses the write rather than writing under an exclusion it lost (same)
//   7. the lock is released when the reconciliation throws                              (same)
//   8. every reconcileCrontab caller is covered, because the lock is INSIDE the reconciliation
//                                                                             (repository scan)
//
// DETERMINISM. There is no sleep and no timer anywhere below. The interleaving is produced by an
// injected BARRIER inside the settings snapshot — the reconciliation parks there until the test
// releases it — and the test never waits on wall-clock time: it waits on `Promise.race` between
// "the second save finished" and "the second save had to queue for the lock", exactly one of which
// can happen in each of the two worlds being distinguished.
//
// WHAT SUBSTITUTES FOR POSTGRES. `@/lib/db/pinned-advisory-lock` is doubled by a FAITHFUL in-process
// FIFO mutex — mutual exclusion is `pg_advisory_lock`'s job and not ours to re-test. Everything
// above it is real: the real `withCrontabReconcileLock`, the real `reconcileCrontab`, the real
// crontab block builder and splicer, and a real `crontab` executable on PATH writing a real file.
// The double REFUSES the try-lock form, so a reconciliation that skipped on contention instead of
// queueing would fail here rather than pass quietly.
// ---------------------------------------------------------------------------

// A real `crontab` on PATH: `execFile('crontab', ...)` resolves it at call time, so the whole
// read-splice-write path runs for real against a file this test can read back.
const BIN = mkdtempSync(join(tmpdir(), 'crontab-lock-'))
const CRONTAB_FILE = join(BIN, 'crontab.txt')
writeFileSync(join(BIN, 'crontab'), `#!/bin/sh
if [ "$1" = "-l" ]; then exec cat '${CRONTAB_FILE}'; fi
exec cat > '${CRONTAB_FILE}'
`)
chmodSync(join(BIN, 'crontab'), 0o755)
process.env.PATH = `${BIN}:${process.env.PATH ?? ''}`
process.env.CRON_SECRET = 'a1b2c3d4e5f6'

function crontabText(): string {
  return existsSync(CRONTAB_FILE) ? readFileSync(CRONTAB_FILE, 'utf8') : ''
}
/** Is the backup job actually scheduled? The only question the defect got wrong. */
function backupLineInstalled(): boolean {
  return /\$BASE_URL\/backup"/.test(crontabText())
}

// --- the committed settings, shared by both saves --------------------------

const store = new Map<string, string>([['public_app_url', 'https://ims.test']])

/** Resolved once the snapshot the barrier is armed for has been READ but not yet acted on. */
let snapshotTaken: Promise<void>
let announceSnapshot: () => void
/** The reconciliation parked at the barrier resumes when the test resolves this. */
let releaseBarrier: () => void
let barrier: Promise<void>
let barrierArmed = false
/** Every findMany that asked for the cron rows, in order — i.e. every SNAPSHOT. */
let snapshots: Array<{ lockHeldDuringRead: boolean }> = []

function isCronSnapshot(keys: string[]): boolean {
  return keys.includes('cron_backup_enabled')
}

const settingDelegate = {
  findMany: async ({ where }: { where: { key: { in: string[] } } }) => {
    const keys = where.key.in
    const rows = keys.filter((k) => store.has(k)).map((k) => ({ key: k, value: store.get(k)! }))
    if (!isCronSnapshot(keys)) return rows
    snapshots.push({ lockHeldDuringRead: lockState.held })
    if (barrierArmed) {
      barrierArmed = false
      announceSnapshot()
      await barrier
    }
    return rows
  },
  findUnique: async ({ where }: { where: { key: string } }) =>
    (store.has(where.key) ? { key: where.key, value: store.get(where.key)! } : null),
  upsert: async ({ where, create }: { where: { key: string }; create: { key: string; value: string } }) => {
    store.set(where.key, create.value)
    return { key: where.key, value: create.value }
  },
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: settingDelegate,
      $transaction: async (arg: unknown) => {
        if (typeof arg !== 'function') return Promise.all(arg as unknown[])
        return (arg as (tx: { setting: typeof settingDelegate }) => Promise<unknown>)({ setting: settingDelegate })
      },
    },
  },
})

mock.module('@/lib/auth/server', {
  namedExports: {
    requireAuth: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
    requirePermission: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
    requireAdmin: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
    requireFreshAdmin: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
    freshAuthFailureResult: () => null,
  },
})

mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })

/** ONE registered job, so "is the backup line present?" is the whole of the crontab's content. */
mock.module('@/lib/cron-jobs', {
  namedExports: {
    getAllCronJobs: () => [{
      slug: 'backup',
      settingKey: 'backup',
      module: 'system',
      moduleLabel: 'System',
      label: 'Database Backup',
      description: 'Scheduled database backup.',
      defaultSchedule: '0 1 * * *',
      defaultEnabled: false,
      legacyEnabledKey: 'backup_schedule_enabled',
    }],
    getCronJobsByModule: () => new Map(),
  },
})

// --- the advisory lock double ----------------------------------------------

class FakeWaitTimeout extends Error {}

const lockState = {
  mode: 'mutex' as 'mutex' | 'timeout' | 'error' | 'lost',
  held: false,
  queue: [] as Array<() => void>,
  keys: [] as Array<number | undefined>,
  timeouts: [] as Array<number | undefined>,
  acquires: 0,
  waits: 0,
  releases: 0,
  onWait: null as (() => void) | null,
}

mock.module('@/lib/db/pinned-advisory-lock', {
  namedExports: {
    AdvisoryLockWaitTimeoutError: FakeWaitTimeout,
    AdvisoryLockLostError: class extends Error {},
    // A reconciliation that SKIPS on contention is the defect, not the fix. If the module under
    // test ever reaches for the try form, this fails loudly instead of quietly passing.
    acquirePinnedAdvisoryLockOrNull: async () => {
      throw new Error('the crontab reconciliation must WAIT for the lock, not skip its run')
    },
    acquirePinnedAdvisoryLockWaiting: async (key: number, options?: { timeoutMs?: number }) => {
      lockState.keys.push(key)
      lockState.timeouts.push(options?.timeoutMs)
      lockState.acquires += 1
      if (lockState.mode === 'timeout') throw new FakeWaitTimeout('timed out waiting')
      if (lockState.mode === 'error') throw new Error('connection refused')
      if (lockState.held) {
        lockState.waits += 1
        await new Promise<void>((resolve) => {
          lockState.queue.push(resolve)
          lockState.onWait?.()
        })
      }
      lockState.held = true
      return {
        get lost() { return lockState.mode === 'lost' },
        assertHeld() {},
        release: async () => {
          lockState.releases += 1
          const next = lockState.queue.shift()
          if (next) next()
          else lockState.held = false
        },
      }
    },
  },
})

// --- fixture ---------------------------------------------------------------

const BACKUP_INPUT = { retentionDays: '30', maxCount: '10', autoUpload: 's3' }

async function saveBackup(enabled: boolean) {
  const { saveBackupScheduleSettings } = await import('@/app/actions/settings')
  return saveBackupScheduleSettings({ ...BACKUP_INPUT, enabled })
}

async function saveScheduledJobs(enabled: boolean) {
  const { saveCronJobSettings } = await import('@/app/actions/cron')
  return saveCronJobSettings([{ settingKey: 'backup', enabled, schedule: '0 1 * * *' }])
}

function armBarrier() {
  barrier = new Promise<void>((resolve) => { releaseBarrier = resolve })
  snapshotTaken = new Promise<void>((resolve) => { announceSnapshot = resolve })
  barrierArmed = true
}

test.beforeEach(() => {
  store.clear()
  store.set('public_app_url', 'https://ims.test')
  writeFileSync(CRONTAB_FILE, '# an operator line the app must preserve\n')
  snapshots = []
  barrierArmed = false
  lockState.mode = 'mutex'
  lockState.held = false
  lockState.queue = []
  lockState.keys = []
  lockState.timeouts = []
  lockState.acquires = 0
  lockState.waits = 0
  lockState.releases = 0
  lockState.onWait = null
})

// ---------------------------------------------------------------------------
// 1 + 2 — the load-bearing case
// ---------------------------------------------------------------------------

test('[o3d-batch-ret] two concurrent saves: the crontab agrees with the LAST COMMIT, not the last snapshot', async () => {
  // A is the Backup screen switching backups OFF. It reaches the snapshot first and parks there.
  armBarrier()
  const a = saveBackup(false)
  await snapshotTaken
  assert.equal(snapshots.length, 1, 'A has taken its snapshot and is parked before the crontab write')

  // B is the Scheduled Jobs screen switching backups ON. Its commit lands AFTER A's snapshot —
  // which is the whole hazard: A is now holding a reading that is out of date.
  const bQueued = new Promise<void>((resolve) => { lockState.onWait = resolve })
  const b = saveScheduledJobs(true)
  const bFinished = b.then(() => 'finished' as const)
  // Deterministic, and it distinguishes the two worlds without a timer: WITH the lock B cannot
  // finish (it is queued behind A), and WITHOUT it B never queues (it runs straight through).
  await Promise.race([bFinished, bQueued.then(() => 'queued' as const)])

  releaseBarrier()
  const [aResult, bResult] = await Promise.all([a, b])

  // THE ASSERTION THE DEFECT FAILS. The last committed state says backups are ON, so a scheduled
  // invocation must exist. Unserialized, A's stale snapshot writes last and removes the line while
  // both screens say Saved.
  assert.equal(store.get('cron_backup_enabled'), 'true', 'the last commit is backups ON')
  assert.ok(backupLineInstalled(), 'the crontab must schedule the backup the committed rows enable')
  assert.match(crontabText(), /an operator line the app must preserve/, 'and unmanaged lines survive')

  assert.deepEqual(aResult, { status: 'saved' })
  assert.deepEqual(bResult, { status: 'saved' })
  assert.equal(lockState.waits, 1, 'B queued behind A rather than reconciling alongside it')
  assert.equal(lockState.acquires, 2)
  assert.equal(lockState.releases, 2, 'and neither reconciliation leaked the lock')
})

test('[o3d-batch-ret] the SNAPSHOT is taken inside the lock, not just the crontab write', async () => {
  // A lock that covers only the write serializes the two writers and still lets the stale reading
  // win: the later writer must re-read, and it can only do that if the read is inside the lock.
  await saveBackup(true)
  assert.ok(snapshots.length > 0, 'the reconciliation was actually reached')
  assert.deepEqual(
    snapshots.map((s) => s.lockHeldDuringRead), [true],
    'every settings snapshot must be read while the reconciliation lock is held',
  )
})

// ---------------------------------------------------------------------------
// 3 — the ordinary case still works, and pays nothing meaningful
// ---------------------------------------------------------------------------

test('[o3d-batch-ret] an ordinary single save still reconciles, taking the lock once and never waiting', async () => {
  const result = await saveBackup(true)

  assert.deepEqual(result, { status: 'saved' })
  assert.ok(backupLineInstalled(), 'the switch still reaches the crontab')
  assert.equal(lockState.acquires, 1, 'one acquisition')
  assert.equal(lockState.releases, 1, 'released, so the next save is not queued behind a leak')
  assert.equal(lockState.waits, 0, 'and an uncontended save waits for nobody')

  // Switching back off removes the line again — the exclusion did not freeze the artefact.
  await saveBackup(false)
  assert.equal(backupLineInstalled(), false)
})

// ---------------------------------------------------------------------------
// 4-7 — the lock module's own contract
// ---------------------------------------------------------------------------

test('[o3d-batch-ret] the reconciliation waits on the REGISTERED key, and never on a try-lock', async () => {
  const { CRONTAB_RECONCILE_LOCK_KEY } = await import('@/lib/db/advisory-locks')
  const { CRONTAB_RECONCILE_LOCK_WAIT_MS } = await import('@/lib/crontab-reconcile-lock')

  await saveBackup(true)

  assert.deepEqual(lockState.keys, [CRONTAB_RECONCILE_LOCK_KEY],
    'the key must come from the registry, so a future collision cannot be introduced silently')
  assert.deepEqual(lockState.timeouts, [CRONTAB_RECONCILE_LOCK_WAIT_MS])
  assert.ok(CRONTAB_RECONCILE_LOCK_WAIT_MS > 10_000,
    'the wait must outlast the two 5s crontab execs it queues behind, or a legitimate queue expires')
  // The try-lock double throws if it is ever reached; reaching this line is the assertion.
})

test('[o3d-batch-ret] a lock wait that times out writes NOTHING and is reported as a failure', async () => {
  lockState.mode = 'timeout'
  const before = crontabText()

  const result = await saveBackup(true)

  assert.equal(crontabText(), before, 'the crontab must not be rewritten by a reconciliation that never held the lock')
  assert.equal(snapshots.length, 0, 'and it must not even snapshot')
  assert.equal(result.status, 'post-commit-failed')
  assert.equal(result.status === 'post-commit-failed' && result.step, 'scheduler')
  assert.match(result.status === 'post-commit-failed' ? result.error : '', /Another crontab reconciliation is still running/)
})

test('[o3d-batch-ret] a lock LOST mid-run refuses the write instead of writing under an exclusion it no longer has', async () => {
  lockState.mode = 'lost'
  const before = crontabText()

  const result = await saveBackup(true)

  assert.equal(crontabText(), before, 'a reconciliation whose connection died must not write')
  assert.ok(snapshots.length > 0, 'it did reach the snapshot — the refusal is at the write, not before it')
  assert.equal(result.status, 'post-commit-failed')
  assert.match(result.status === 'post-commit-failed' ? result.error : '', /lock was lost/)
})

test('[o3d-batch-ret] the lock is released when the reconciliation throws', async () => {
  const { withCrontabReconcileLock } = await import('@/lib/crontab-reconcile-lock')
  const boom = new Error('the crontab work exploded')

  await assert.rejects(
    withCrontabReconcileLock(async () => { throw boom }),
    (error: unknown) => error === boom,
    'a throw from the critical section propagates — it is not classified as "could not lock"',
  )
  assert.equal(lockState.releases, 1, 'and the lock is released, or every later reconciliation wedges')
  assert.equal(lockState.held, false)
})

test('[o3d-batch-ret] an acquisition FAILURE is returned as an outcome, not thrown at a post-commit caller', async () => {
  lockState.mode = 'error'
  const { withCrontabReconcileLock } = await import('@/lib/crontab-reconcile-lock')

  const outcome = await withCrontabReconcileLock(async () => 'ran')

  assert.equal(outcome.locked, false)
  assert.match(outcome.locked === false ? outcome.error : '', /Could not serialize the crontab reconciliation/)
  assert.equal(lockState.releases, 0)
})

// ---------------------------------------------------------------------------
// 8 — coverage of every caller, by construction
// ---------------------------------------------------------------------------

test('[o3d-batch-ret] every reconcileCrontab caller is covered, because the lock is inside the reconciliation', () => {
  const { readFileSync: read } = require('node:fs') as typeof import('node:fs')

  // The five action modules that reconcile, plus the module that does it. Listed rather than
  // globbed so that a caller ADDED elsewhere shows up as a miss in the scan below.
  const CALLERS: Array<[string, string[]]> = [
    ['app/actions/settings.ts', ['savePublicAppUrl', 'saveBackupScheduleSettings', 'saveIntegrationPluginState']],
    ['app/actions/cron.ts', ['syncCrontab', 'saveCronJobSettings']],
    ['app/actions/onboarding.ts', ['saveOnboardingPluginState']],
  ]
  let callSites = 0
  for (const [file, actions] of CALLERS) {
    const src = read(file, 'utf8')
    for (const action of actions) {
      assert.match(src, new RegExp(`function ${action}\\b`), `${file}: ${action} has moved or been renamed`)
    }
    callSites += (src.match(/reconcileCrontab\(\)/g) ?? []).length
  }
  assert.equal(callSites, 6, 'six call sites — if this changed, the new caller must be listed above')

  // Nothing outside the reconciliation module may reach the unlocked read-modify-write, and the
  // reconciliation must take the lock. Together these are why the six above need no wrapper each.
  const reconcile = read('lib/crontab-reconcile.ts', 'utf8')
  assert.match(reconcile, /withCrontabReconcileLock\(applyCrontabFromSettings\)/,
    'reconcileCrontab must run the snapshot-and-write under the lock')
  assert.doesNotMatch(reconcile, /export (async )?function applyCrontabFromSettings/,
    'the unlocked read-modify-write must not be reachable from outside this module')
  for (const [file] of CALLERS) {
    assert.doesNotMatch(read(file, 'utf8'), /applyCrontabFromSettings/, `${file} must go through reconcileCrontab`)
  }
})
