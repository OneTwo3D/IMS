import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { mock } from 'node:test'

// ---------------------------------------------------------------------------
// Codex r21 HIGH + r22 HIGH x2 — THE CRONTAB HAS EXACTLY ONE EXCLUSION PROTOCOL,
// AND EVERY WRITER JOINS IT.
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
// The end state is an enablement row committed ON, no cron line, and every caller reporting
// `saved`.
//
// Round 21 closed that with a PostgreSQL SESSION ADVISORY LOCK, and round 22 found two ways the
// mechanism did not fit the resource:
//
//   • the lock could be released while the spawned `crontab -` was STILL WRITING (the session dies
//     after the pre-write check), so a second reconciliation could acquire, read newer settings,
//     write — and be overtaken by the first child finishing LAST with its stale snapshot;
//   • `scripts/install.sh` writes the same crontab and cannot take a PostgreSQL lock at all.
//
// The exclusion is now a host-local `flock` on ONE file, whose descriptor is inherited by the
// `crontab -` child and which the installer's shell takes with the same two lines.
//
// WHAT THESE TESTS PIN, and the route each takes:
//   1. LOAD-BEARING. A crontab write still in flight while a second reconciliation is queued: the
//      final crontab is the LATER COMMIT's, and the queued reconciliation re-read the settings
//      only after the in-flight write finished
//                       (backup-schedule.tsx -> saveBackupScheduleSettings, and
//                        cron-jobs-settings.tsx -> saveCronJobSettings, both -> reconcileCrontab)
//   2. LOAD-BEARING. The lock outlives the holding PROCESS's release, because the `crontab -` child
//      holds a duplicate of the descriptor  (lib/crontab-reconcile-lock.ts + lib/crontab-reconcile.ts)
//   3. LOAD-BEARING. An installer reconciliation and an application one cannot interleave, in both
//      directions, using the installer's OWN lock lines lifted out of scripts/install.sh
//   4. the SNAPSHOT is inside the lock, not just the write   (same route as 1, observed at the read)
//   5. an ordinary single save still reconciles                (backup-schedule.tsx -> saveBackup…)
//   6. a wait that expires does not write the crontab and is reported as a failure
//   7. the lock is released when the reconciliation throws, and an acquisition failure is an
//      OUTCOME rather than a throw                                    (lib/crontab-reconcile-lock.ts)
//   8. EVERY writer of this crontab in the whole repository — TypeScript and shell — participates
//                                                                             (repository walk)
//   9. LOAD-BEARING. the app and the installer RESOLVE one file — bash evaluates the installer's own
//      definitions, and the shipped function is asked with the $STATE_DIRECTORY the installer's unit
//      produces                                          (scripts/install.sh + the generated unit)
//  10. LOAD-BEARING. that path survives every write-constraining directive in the SHIPPED hardened
//      unit, which is what round 22 was never checked against  (deploy/systemd/ims-stage.service)
//  11. LOAD-BEARING. an unwritable lock path REFUSES: no crontab read, no crontab write, and a
//      message naming the path and the directive        (backup-schedule.tsx -> saveBackupSchedule…)
//  12. the test-only path override cannot be used by a production process to diverge from the
//      installer                                                       (lib/crontab-reconcile-lock.ts)
//  13. LOAD-BEARING. the lock path REPLACED BY A SYMLINK before an installer re-run: the shipped
//      `prepare_crontab_lock` refuses, and the target keeps its contents, mode, owner and inode
//                                                     (scripts/install.sh, run by a real bash)
//  14. LOAD-BEARING. a DANGLING plant is not created either — no root-side create at a chosen path
//  15. LOAD-BEARING. the same, at the lock DIRECTORY: nothing appears inside the target
//  16. LOAD-BEARING. the prepared lock cannot be replaced from a directory the service user cannot
//      write — with a CONTROL showing round 23's placement can be
//
// DETERMINISM. There is no sleep and no timer used to sequence anything. The interleaving comes
// from two injected barriers — one inside the settings snapshot, one inside a real `crontab`
// executable that parks mid-write — and every wait below is on a FIFO or a process exit, never on
// wall-clock time. The two flock waits that DO carry a timeout are asked for `--timeout 0` (an
// immediate, deterministic answer about a lock that is definitely held) or are asserted to expire.
//
// WHAT IS REAL HERE. The lock is a real `flock(2)` on a real file. The crontab is a real executable
// on PATH writing a real file. The installer's lock lines are EXTRACTED FROM scripts/install.sh and
// executed by a real `bash`, so a change there breaks these tests rather than passing quietly.
// Only the database and the auth gate are doubled.
// ---------------------------------------------------------------------------

const REPO_ROOT = process.cwd()
const HARNESS = mkdtempSync(join(tmpdir(), 'crontab-lock-'))
const CRONTAB_FILE = join(HARNESS, 'crontab.txt')
const JOURNAL = join(HARNESS, 'journal.txt')
const WRITE_GATE = join(HARNESS, 'gate-armed')
const READY_FIFO = join(HARNESS, 'ready.fifo')
const GO_FIFO = join(HARNESS, 'go.fifo')
const LOCK_FILE = join(HARNESS, 'crontab-reconcile.lock')

// `$STATE_DIRECTORY` is systemd's answer and outranks the test-only override, so it must be absent
// here — otherwise every test below would silently lock a file in a real state directory.
delete process.env.STATE_DIRECTORY
// …and the override is refused outright in production, so a runner that set NODE_ENV=production
// would send every lock below to the repository root instead of the harness.
assert.notEqual(process.env.NODE_ENV, 'production',
  'these tests drive the lock through OTI_CRONTAB_LOCK_PATH, which production refuses')
process.env.OTI_CRONTAB_LOCK_PATH = LOCK_FILE
process.env.CRON_SECRET = 'a1b2c3d4e5f6'
// The installer creates the lock file before anything can lock it, and its own lock lines — which
// several tests below lift out of scripts/install.sh and run for real — now open it READ-ONLY and
// so cannot create it. Mirror that here rather than relying on a writer to bring it into being.
writeFileSync(LOCK_FILE, '')

// A real `crontab` on PATH. `spawn('crontab', ...)` resolves it at call time, so the whole
// read-splice-write path runs for real — and this shim is where the write is OBSERVED from the
// inside: while it is running it records whether the exclusion is still held by anybody, and
// whether it was itself handed the lock descriptor as fd 3.
writeFileSync(join(HARNESS, 'crontab'), `#!/bin/sh
if [ "$1" = "-l" ]; then
  if [ -f '${CRONTAB_FILE}' ]; then cat '${CRONTAB_FILE}'; fi
  exit 0
fi
echo "write-start" >> '${JOURNAL}'
if flock --exclusive --timeout 0 '${LOCK_FILE}' true 2>/dev/null; then
  echo "exclusion-absent" >> '${JOURNAL}'
else
  echo "exclusion-held" >> '${JOURNAL}'
fi
if [ -e /proc/self/fd/3 ]; then
  echo "lock-fd=$(readlink /proc/self/fd/3)" >> '${JOURNAL}'
else
  echo "lock-fd=absent" >> '${JOURNAL}'
fi
if [ -f '${WRITE_GATE}' ]; then
  rm -f '${WRITE_GATE}'
  echo parked > '${READY_FIFO}'
  head -n 1 '${GO_FIFO}' > /dev/null
fi
cat > '${CRONTAB_FILE}'
echo "write-end" >> '${JOURNAL}'
`)
chmodSync(join(HARNESS, 'crontab'), 0o755)
process.env.PATH = `${HARNESS}:${process.env.PATH ?? ''}`

function sh(script: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn('bash', ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (c) => { stdout += String(c) })
    proc.stderr.on('data', (c) => { stderr += String(c) })
    proc.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

/** Block until the parked child announces itself. A FIFO read, never a poll. */
function awaitFifo(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(path)
    let data = ''
    stream.on('data', (chunk) => {
      data += String(chunk)
      stream.close()
      resolve(data)
    })
    stream.on('error', reject)
  })
}

function crontabText(): string {
  return existsSync(CRONTAB_FILE) ? readFileSync(CRONTAB_FILE, 'utf8') : ''
}
/** Is the backup job actually scheduled? The only question the defect got wrong. */
function backupLineInstalled(): boolean {
  return /\$BASE_URL\/backup"/.test(crontabText())
}
function journal(): string[] {
  return existsSync(JOURNAL) ? readFileSync(JOURNAL, 'utf8').split('\n').filter(Boolean) : []
}

/**
 * Can an INDEPENDENT process take the crontab lock right now? Asked with `--timeout 0`, so the
 * answer is immediate and carries no timing assumption at all.
 */
async function lockIsFree(): Promise<boolean> {
  const { code } = await sh(`flock --exclusive --timeout 0 '${LOCK_FILE}' true`)
  return code === 0
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
let snapshots: Array<{ lockHeldDuringRead: boolean; journalAtRead: string[] }> = []
/** Resolved when the Scheduled Jobs save has COMMITTED backups ON. */
let committedOn: Promise<void>
let announceCommittedOn: () => void

function isCronSnapshot(keys: string[]): boolean {
  return keys.includes('cron_backup_enabled')
}

const settingDelegate = {
  findMany: async ({ where }: { where: { key: { in: string[] } } }) => {
    const keys = where.key.in
    const rows = keys.filter((k) => store.has(k)).map((k) => ({ key: k, value: store.get(k)! }))
    if (!isCronSnapshot(keys)) return rows
    snapshots.push({ lockHeldDuringRead: !(await lockIsFree()), journalAtRead: journal() })
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
    if (where.key === 'cron_backup_enabled' && create.value === 'true') announceCommittedOn?.()
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

function armSnapshotBarrier() {
  barrier = new Promise<void>((resolve) => { releaseBarrier = resolve })
  snapshotTaken = new Promise<void>((resolve) => { announceSnapshot = resolve })
  barrierArmed = true
}

test.before(async () => {
  await sh(`mkfifo '${READY_FIFO}' '${GO_FIFO}'`)
})

test.beforeEach(() => {
  store.clear()
  store.set('public_app_url', 'https://ims.test')
  writeFileSync(CRONTAB_FILE, '# an operator line the app must preserve\n')
  writeFileSync(JOURNAL, '')
  rmSync(WRITE_GATE, { force: true })
  snapshots = []
  barrierArmed = false
  committedOn = new Promise<void>((resolve) => { announceCommittedOn = resolve })
  delete process.env.OTI_CRONTAB_LOCK_WAIT_MS
})

test.after(() => {
  rmSync(HARNESS, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 1 + 4 — LOAD-BEARING: a write still in flight, and a second reconciliation queued behind it
// ---------------------------------------------------------------------------

test('[o3d-batch-ret] a crontab write STILL IN FLIGHT keeps the exclusion, and the final crontab is the LATER COMMIT', async () => {
  // A is the Backup screen switching backups OFF. It reaches the settings snapshot first and parks.
  armSnapshotBarrier()
  const a = saveBackup(false)
  await snapshotTaken
  assert.equal(snapshots.length, 1, 'A has taken its snapshot and has not written yet')

  // B is the Scheduled Jobs screen switching backups ON. Its commit lands AFTER A's snapshot —
  // which is the whole hazard: A is now holding a reading that is out of date.
  const b = saveScheduledJobs(true)
  await committedOn
  assert.equal(store.get('cron_backup_enabled'), 'true', 'B has COMMITTED backups ON')
  assert.equal(snapshots.length, 1, 'and B cannot have re-read the settings: A holds the lock')

  // A's `crontab -` will now park MID-WRITE, which is the state round 21 could not survive: the
  // holder had finished its own checks and the write was in another process.
  writeFileSync(WRITE_GATE, '')
  releaseBarrier()
  await awaitFifo(READY_FIFO)

  // THE ASSERTION ROUND 21 COULD NOT MAKE. The write is in flight right now, and the exclusion is
  // still there — an independent taker is refused, immediately.
  assert.equal(await lockIsFree(), false, 'the crontab lock must still be held while the child writes')
  assert.equal(snapshots.length, 1, 'so B still has not re-read the settings')

  await writeFile(GO_FIFO, 'go\n')
  const [aResult, bResult] = await Promise.all([a, b])

  // THE ASSERTION THE DEFECT FAILS. The last committed state says backups are ON, so a scheduled
  // invocation must exist. Unserialized, A's stale snapshot writes last and removes the line while
  // both screens say Saved.
  assert.equal(store.get('cron_backup_enabled'), 'true', 'the last commit is backups ON')
  assert.ok(backupLineInstalled(), 'the crontab must schedule the backup the committed rows enable')
  assert.match(crontabText(), /an operator line the app must preserve/, 'and unmanaged lines survive')

  assert.deepEqual(aResult, { status: 'saved' })
  assert.deepEqual(bResult, { status: 'saved' })

  // The two writes did not overlap, and the shim saw the exclusion from inside both of them.
  const lines = journal()
  assert.deepEqual(
    lines.filter((l) => l === 'write-start' || l === 'write-end'),
    ['write-start', 'write-end', 'write-start', 'write-end'],
    'the two crontab writes must not interleave',
  )
  assert.equal(lines.filter((l) => l === 'exclusion-held').length, 2)
  assert.equal(lines.filter((l) => l === 'exclusion-absent').length, 0)

  // 4 — and B's SNAPSHOT is what makes the outcome right: it was taken inside the lock, AFTER A's
  // write had completed, so it read the committed ON rather than anything staler.
  assert.equal(snapshots.length, 2)
  assert.deepEqual(snapshots.map((s) => s.lockHeldDuringRead), [true, true],
    'every settings snapshot must be read while the reconciliation lock is held')
  assert.ok(snapshots[1].journalAtRead.includes('write-end'),
    "B re-read the settings only after A's crontab write had finished — a lock covering only the "
    + 'write would have let B read before A wrote and still lose to it')
})

// ---------------------------------------------------------------------------
// 2 — LOAD-BEARING: the lock outlives the holding process's release
// ---------------------------------------------------------------------------

test('[o3d-batch-ret] the crontab child inherits the lock descriptor, so the exclusion survives the holder releasing it', async () => {
  // The write records what it can see of the lock from inside itself. This is the property that
  // replaces round 21's "re-verify after the write": there is nothing to re-verify, because the
  // kernel will not release an flock while a duplicate of its descriptor is open in the child.
  await saveBackup(true)

  const lines = journal()
  assert.ok(lines.includes('exclusion-held'), 'the write ran while the exclusion was held')
  assert.ok(
    lines.some((l) => l === `lock-fd=${LOCK_FILE}`),
    `the crontab child must be handed the lock file as fd 3 (saw: ${lines.filter((l) => l.startsWith('lock-fd=')).join(', ')})`,
  )

  // And the same thing proved directly: hold the lock, hand the descriptor to a child, let the
  // HOLDER release — the lock is still not takeable until the child exits.
  const { withCrontabReconcileLock } = await import('@/lib/crontab-reconcile-lock')
  let child: ReturnType<typeof spawn> | null = null
  const outcome = await withCrontabReconcileLock(async (lock) => {
    child = spawn('bash', ['-c', `head -n 1 '${GO_FIFO}' > /dev/null`], {
      stdio: ['ignore', 'ignore', 'ignore', lock.fd],
    })
    return 'spawned'
  })
  assert.deepEqual(outcome, { locked: true, result: 'spawned' })
  // withCrontabReconcileLock has returned, so this process has closed its descriptor.
  assert.equal(await lockIsFree(), false,
    'the lock must still be held by the child that inherited the descriptor')

  await writeFile(GO_FIFO, 'go\n')
  await new Promise((resolve) => child!.on('exit', resolve))
  assert.equal(await lockIsFree(), true, 'and it is released once that child exits')
})

// ---------------------------------------------------------------------------
// 3 — LOAD-BEARING: the installer is in the same protocol, in both directions
// ---------------------------------------------------------------------------

const INSTALL_SH = readFileSync(join(REPO_ROOT, 'scripts/install.sh'), 'utf8')

/**
 * The installer's OWN lock lines, lifted out of the script rather than retyped here. If someone
 * removes or renames them, these tests stop finding them and fail — which is the point: this is
 * the only coverage that the shell writer is inside the exclusion.
 */
function installerLockLines() {
  const openFd = INSTALL_SH.match(/^exec 9<"\$\{CRONTAB_LOCK_FILE\}"$/m)
  const acquire = INSTALL_SH.match(/^if ! (flock --exclusive --timeout \d+ 9); then$/m)
  const closeFd = INSTALL_SH.match(/^exec 9>&-/m)
  assert.ok(openFd, 'scripts/install.sh must open the crontab lock file READ-ONLY on fd 9 '
    + '(flock(2) ignores the access mode, and the file is root-owned — r24)')
  assert.ok(acquire, 'scripts/install.sh must take an exclusive flock on fd 9 before writing the crontab')
  assert.ok(closeFd, 'scripts/install.sh must close fd 9 to release the crontab lock')
  return { openFd: openFd![0], acquire: acquire![1] }
}

test('[o3d-batch-ret] the INSTALLER cannot take the crontab lock while the application holds it', async () => {
  const { openFd, acquire } = installerLockLines()
  // `--timeout 0`: an immediate, deterministic answer about a lock that is definitely held.
  const probe = `set -u
CRONTAB_LOCK_FILE='${LOCK_FILE}'
${openFd}
if ! ${acquire.replace(/--timeout \d+/, '--timeout 0')}; then echo CONFLICT; exit 9; fi
echo ACQUIRED
exec 9>&-`

  const { withCrontabReconcileLock } = await import('@/lib/crontab-reconcile-lock')
  const outcome = await withCrontabReconcileLock(async () => sh(probe))
  assert.equal(outcome.locked, true)
  const result = outcome.locked === true ? outcome.result : null
  assert.equal(result!.stdout.trim(), 'CONFLICT',
    "the installer's own lock lines must be refused while a reconciliation holds the lock")
  assert.equal(result!.code, 9)

  // …and granted the moment it is free, so this is exclusion and not a broken command.
  const after = await sh(probe)
  assert.equal(after.stdout.trim(), 'ACQUIRED')
})

test('[o3d-batch-ret] an APPLICATION reconciliation is refused while the installer holds the crontab lock', async () => {
  const { openFd, acquire } = installerLockLines()
  const holder = spawn('bash', ['-c', `set -u
CRONTAB_LOCK_FILE='${LOCK_FILE}'
${openFd}
${acquire} || exit 9
echo held > '${READY_FIFO}'
head -n 1 '${GO_FIFO}' > /dev/null
exec 9>&-`], { stdio: ['ignore', 'ignore', 'pipe'] })
  await awaitFifo(READY_FIFO)
  assert.equal(await lockIsFree(), false, 'the installer holds the lock')

  // The wait is bounded, and here it is deliberately short: the assertion is that it EXPIRES.
  process.env.OTI_CRONTAB_LOCK_WAIT_MS = '50'
  const before = crontabText()
  const result = await saveBackup(true)

  assert.equal(crontabText(), before,
    'no application reconciliation may rewrite the crontab while the installer is inside its own read-modify-write')
  assert.equal(snapshots.length, 0, 'and it must not even snapshot the settings')
  assert.equal(result.status, 'post-commit-failed')
  assert.equal(result.status === 'post-commit-failed' && result.step, 'scheduler')
  assert.match(result.status === 'post-commit-failed' ? result.error : '', /Another crontab reconciliation is still running/)

  await writeFile(GO_FIFO, 'go\n')
  await new Promise((resolve) => holder.on('exit', resolve))

  // Once the installer is out, the application reconciles normally — the refusal was the exclusion,
  // not a broken path.
  delete process.env.OTI_CRONTAB_LOCK_WAIT_MS
  assert.deepEqual(await saveBackup(true), { status: 'saved' })
  assert.ok(backupLineInstalled())
})

// ---------------------------------------------------------------------------
// 5 - 7 — the ordinary case, and the lock module's own contract
// ---------------------------------------------------------------------------

test('[o3d-batch-ret] an ordinary single save still reconciles, and the lock does not leak', async () => {
  const result = await saveBackup(true)

  assert.deepEqual(result, { status: 'saved' })
  assert.ok(backupLineInstalled(), 'the switch still reaches the crontab')
  assert.equal(await lockIsFree(), true, 'released, so the next save is not queued behind a leak')

  // Switching back off removes the line again — the exclusion did not freeze the artefact.
  await saveBackup(false)
  assert.equal(backupLineInstalled(), false)
  assert.equal(await lockIsFree(), true)
})

test('[o3d-batch-ret] the reconciliation wait is bounded and outlasts the crontab execs it queues behind', async () => {
  const { CRONTAB_RECONCILE_LOCK_WAIT_MS, crontabReconcileLockWaitMs } =
    await import('@/lib/crontab-reconcile-lock')

  assert.ok(CRONTAB_RECONCILE_LOCK_WAIT_MS > 10_000,
    'the wait must outlast the two 5s crontab execs it queues behind, or a legitimate queue expires')
  assert.equal(crontabReconcileLockWaitMs(), CRONTAB_RECONCILE_LOCK_WAIT_MS)
  for (const bad of ['', '  ', 'soon', '0', '-5', 'NaN']) {
    process.env.OTI_CRONTAB_LOCK_WAIT_MS = bad
    assert.equal(crontabReconcileLockWaitMs(), CRONTAB_RECONCILE_LOCK_WAIT_MS,
      `an unusable override (${JSON.stringify(bad)}) must fall back to the bound, never to no bound`)
  }
  process.env.OTI_CRONTAB_LOCK_WAIT_MS = '250'
  assert.equal(crontabReconcileLockWaitMs(), 250)
  delete process.env.OTI_CRONTAB_LOCK_WAIT_MS
})

test('[o3d-batch-ret] the lock is released when the reconciliation throws', async () => {
  const { withCrontabReconcileLock } = await import('@/lib/crontab-reconcile-lock')
  const boom = new Error('the crontab work exploded')

  await assert.rejects(
    withCrontabReconcileLock(async () => { throw boom }),
    (error: unknown) => error === boom,
    'a throw from the critical section propagates — it is not classified as "could not lock"',
  )
  assert.equal(await lockIsFree(), true, 'and the lock is released, or every later reconciliation wedges')
})

test('[o3d-batch-ret] an acquisition FAILURE is returned as an outcome, not thrown at a post-commit caller', async () => {
  const { withCrontabReconcileLock } = await import('@/lib/crontab-reconcile-lock')
  // A path whose DIRECTORY cannot be created either: `openLockFile` bootstraps a missing lock
  // directory (that is how a host with no installer gets one), so "unopenable" has to mean a place
  // this process can neither create nor open — a sealed parent, which is what an unwritable state
  // directory looks like.
  const sealed = join(HARNESS, 'sealed-parent')
  await sh(`mkdir -p '${sealed}' && chmod 0555 '${sealed}'`)
  const unopenable = join(sealed, 'locks', 'lock')
  process.env.OTI_CRONTAB_LOCK_PATH = unopenable
  try {
    const outcome = await withCrontabReconcileLock(async () => 'ran')
    assert.equal(outcome.locked, false)
    assert.match(outcome.locked === false ? outcome.error : '', /Could not open the crontab reconciliation lock file/)
  } finally {
    process.env.OTI_CRONTAB_LOCK_PATH = LOCK_FILE
    await sh(`chmod 0755 '${sealed}'`)
  }
})

test('[o3d-batch-ret] a lock file REPLACED mid-wait does not leave the reconciliation holding an orphaned inode', async () => {
  // The one genuine hazard of a file lock: the exclusion lives on the INODE, so a lock file
  // replaced while a waiter is queued leaves that waiter holding a lock nobody else will ever open
  // — and believing it is alone. Nothing in this repository removes the file (the installer
  // `touch`es it precisely so the inode survives a re-run), but "nothing does" is what every one of
  // these findings has been about.
  const { openFd, acquire } = installerLockLines()
  const holder = spawn('bash', ['-c', `set -u
CRONTAB_LOCK_FILE='${LOCK_FILE}'
${openFd}
${acquire} || exit 9
echo held > '${READY_FIFO}'
head -n 1 '${GO_FIFO}' > /dev/null
exec 9>&-`], { stdio: ['ignore', 'ignore', 'pipe'] })
  await awaitFifo(READY_FIFO)

  const { withCrontabReconcileLock } = await import('@/lib/crontab-reconcile-lock')
  // NOT awaited: the acquisition opens the lock file and spawns its `flock` waiter synchronously,
  // before its first suspension point, so by the time this statement returns the waiter is queued
  // on the ORIGINAL inode. That is what makes the replacement below deterministic rather than a race.
  let insideProbe: boolean | null = null
  const pending = withCrontabReconcileLock(async () => {
    // THE ASSERTION. While this callback runs, an independent taker of the lock FILE must be
    // refused. If the acquisition kept the descriptor it opened before the replacement, it is
    // holding an inode with no name and this probe succeeds — two writers, one crontab.
    insideProbe = await lockIsFree()
    return 'held'
  })

  await sh(`mv '${LOCK_FILE}' '${LOCK_FILE}.replaced' && touch '${LOCK_FILE}'`)
  await writeFile(GO_FIFO, 'go\n')
  await new Promise((resolve) => holder.on('exit', resolve))
  await pending

  assert.equal(insideProbe, false,
    'the reconciliation must hold the lock on the file at the configured path, not on a replaced inode')
  rmSync(`${LOCK_FILE}.replaced`, { force: true })
})

// ---------------------------------------------------------------------------
// 8 — EVERY writer of this crontab, in every language, participates
// ---------------------------------------------------------------------------

test('[o3d-batch-ret] every crontab writer in the repository is inside the one exclusion protocol', () => {
  // A repository WALK, not a list: a seventh writer added anywhere under these roots shows up here
  // as a failure rather than as a quiet second protocol. Round 21's version of this test scanned
  // only TypeScript, which is exactly how the shell installer stayed outside the exclusion.
  const roots = ['lib', 'app', 'scripts', 'e2e']
  const codeWrites: string[] = []
  const codeReads: string[] = []
  const shellCrontab: Array<{ file: string; line: number; text: string }> = []
  let filesWalked = 0

  const walk = (dir: string) => {
    for (const entry of readdirSync(join(REPO_ROOT, dir))) {
      const rel = join(dir, entry)
      if (statSync(join(REPO_ROOT, rel)).isDirectory()) {
        if (entry === 'node_modules' || entry === 'generated' || entry.startsWith('.')) continue
        walk(rel)
        continue
      }
      const isCode = /\.(ts|tsx|mjs|js)$/.test(entry)
      const isShell = /\.(sh|bash)$/.test(entry)
      if (!isCode && !isShell) continue
      filesWalked += 1
      const src = readFileSync(join(REPO_ROOT, rel), 'utf8')
      src.split('\n').forEach((line, index) => {
        if (isCode) {
          // Any child-process invocation of `crontab`, whatever the spawning function.
          const call = line.match(/\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync)\(\s*'crontab'/)
          if (!call) return
          if (/'-l'/.test(line)) codeReads.push(rel)
          else codeWrites.push(rel)
        } else if (/(^|[|;&({]\s*)crontab\b/.test(line) && !line.trimStart().startsWith('#')) {
          shellCrontab.push({ file: rel, line: index + 1, text: line })
        }
      })
    }
  }
  roots.forEach(walk)

  // The walk must actually have reached the files, or every assertion below is vacuous.
  assert.ok(filesWalked > 200, `the walk must reach the source tree (walked ${filesWalked} files)`)
  assert.ok(shellCrontab.length > 0, 'the walk must reach the shell writer')

  // --- writer 1: the application, in TypeScript ---
  assert.deepEqual([...new Set(codeWrites)], ['lib/crontab-reconcile.ts'],
    'the only code that WRITES the crontab is the reconciliation; a new one must join the lock and be listed here')
  assert.deepEqual([...new Set(codeReads)], ['lib/crontab-reconcile.ts'])

  const reconcile = readFileSync(join(REPO_ROOT, 'lib/crontab-reconcile.ts'), 'utf8')
  assert.match(reconcile, /withCrontabReconcileLock\(applyCrontabFromSettings\)/,
    'reconcileCrontab must run the snapshot-and-write under the lock')
  assert.match(reconcile, /spawn\('crontab', \['-'\], \{ stdio: \['pipe', 'ignore', 'pipe', lockFd\] \}\)/,
    'the crontab child must inherit the lock descriptor — execFile drops stdio and would end the exclusion at this process')
  assert.doesNotMatch(reconcile, /export (async )?function applyCrontabFromSettings/,
    'the unlocked read-modify-write must not be reachable from outside this module')

  // The six server actions need no wrapper each precisely because the lock is inside the
  // reconciliation. Listed so that a caller added elsewhere shows up as a miss.
  const CALLERS: Array<[string, string[]]> = [
    ['app/actions/settings.ts', ['savePublicAppUrl', 'saveBackupScheduleSettings', 'saveIntegrationPluginState']],
    ['app/actions/cron.ts', ['syncCrontab', 'saveCronJobSettings']],
    ['app/actions/onboarding.ts', ['saveOnboardingPluginState']],
  ]
  let callSites = 0
  for (const [file, actions] of CALLERS) {
    const src = readFileSync(join(REPO_ROOT, file), 'utf8')
    for (const action of actions) {
      assert.match(src, new RegExp(`function ${action}\\b`), `${file}: ${action} has moved or been renamed`)
    }
    assert.doesNotMatch(src, /applyCrontabFromSettings/, `${file} must go through reconcileCrontab`)
    callSites += (src.match(/reconcileCrontab\(\)/g) ?? []).length
  }
  assert.equal(callSites, 6, 'six call sites — if this changed, the new caller must be listed above')

  // --- writer 2: the installer, in shell ---
  assert.deepEqual([...new Set(shellCrontab.map((c) => c.file))], ['scripts/install.sh'],
    'only the installer touches the crontab from shell; a new script must take the same lock and be listed here')

  const installLines = INSTALL_SH.split('\n')
  const lineOf = (re: RegExp) => {
    const index = installLines.findIndex((l) => re.test(l))
    assert.notEqual(index, -1, `scripts/install.sh is missing: ${re}`)
    return index + 1
  }
  const opened = lineOf(/^exec 9<"\$\{CRONTAB_LOCK_FILE\}"$/)
  const acquired = lineOf(/^if ! flock --exclusive --timeout \d+ 9; then$/)
  const released = lineOf(/^exec 9>&-/)
  assert.ok(opened < acquired && acquired < released, 'open, lock, release, in that order')

  for (const { line, text } of shellCrontab) {
    assert.ok(line > acquired && line < released,
      `scripts/install.sh:${line} touches the crontab outside the flock region (lines ${acquired}-${released}): ${text.trim()}`)
  }

  // The installer is a BOOTSTRAP: it must not overwrite a managed block the application owns,
  // because its schedules are defaults rather than the committed settings.
  assert.match(INSTALL_SH, /grep -qE '\^# --- OTI CRON START ---\[ \\t\\r\]\*\$'/,
    'the installer must skip its bootstrap block when the application already manages one')

  // And it must never replace the lock file, because the lock lives on the inode.
  assert.doesNotMatch(INSTALL_SH, /rm -f "\$\{CRONTAB_LOCK_FILE\}"/)

  // The lock file is prepared ONCE, in section 8, and the crontab region only opens it (r24). No
  // `touch`/`chown`/`chmod` may sit on either lock path anywhere in the script: those three follow
  // symlinks, and both paths live under a directory the service user owns.
  const lockPathOperations = installLines
    .map((l, index) => ({ line: index + 1, text: l.trim() }))
    .filter(({ text }) => !text.startsWith('#')
      && /\$\{CRONTAB_LOCK_(?:DIR|FILE)\}/.test(text)
      && /^(touch|chmod|chown|install|ln|cp|mv|rm)\b/.test(text))
  assert.deepEqual(
    lockPathOperations.filter(({ text }) => !text.startsWith('chown -h root:root ')),
    [],
    'every root-side operation on the crontab lock paths must be symlink-proof: only `chown -h` '
    + '(which never dereferences) is allowed, and touch/chmod are not',
  )
  assert.equal(lockPathOperations.length, 2,
    'the two `chown -h root:root` calls in prepare_crontab_lock — the directory and the file')
  assert.doesNotMatch(INSTALL_SH, /chown[^\n]*\$\{APP_USER\}[^\n]*\$\{CRONTAB_LOCK_/,
    'the lock must never be handed to the service user: that is what made an installer re-run a '
    + 'privilege-escalation primitive (r24 CRITICAL)')
  assert.match(INSTALL_SH, /^prepare_crontab_lock$/m,
    'prepare_crontab_lock must actually be CALLED, not merely defined')
  assert.ok(
    installLines.findIndex((l) => l === 'prepare_crontab_lock') < opened,
    'the lock must be prepared before the crontab region opens it — the installer no longer '
    + 'creates it there, and by then the service is already running',
  )
})

// ---------------------------------------------------------------------------
// 9 — the two writers RESOLVE the same file, from the systemd StateDirectory
// ---------------------------------------------------------------------------

/**
 * Evaluate the installer's OWN variable definitions in a real bash, and print what they resolve to.
 *
 * Not a re-typed copy of the paths: the four `NAME="…"` lines are lifted out of scripts/install.sh
 * by name, so renaming APP_NAME or repointing DATA_DIR moves what these tests compare against and a
 * divergence shows up here instead of on an operator's box.
 */
async function installerResolves(names: string[]): Promise<Record<string, string>> {
  const defs = names.map((name) => {
    const line = INSTALL_SH.match(new RegExp(`^${name}="[^"]*"$`, 'm'))
    assert.ok(line, `scripts/install.sh must define ${name} on one line`)
    return line![0]
  })
  const prints = names.map((name) => `printf '%s=%s\\n' '${name}' "\${${name}}"`)
  const { code, stdout, stderr } = await sh(`set -eu\n${defs.join('\n')}\n${prints.join('\n')}`)
  assert.equal(code, 0, `the installer's own definitions must evaluate: ${stderr}`)
  const resolved: Record<string, string> = {}
  for (const line of stdout.split('\n').filter(Boolean)) {
    const eq = line.indexOf('=')
    resolved[line.slice(0, eq)] = line.slice(eq + 1)
  }
  assert.deepEqual(Object.keys(resolved).sort(), [...names].sort())
  return resolved
}

test('[o3d-batch-ret] the application and the installer RESOLVE the same lock path, from the unit StateDirectory', async () => {
  const { CRONTAB_RECONCILE_LOCK_DIRNAME, CRONTAB_RECONCILE_LOCK_FILENAME, crontabReconcileLockPath } =
    await import('@/lib/crontab-reconcile-lock')

  // --- what the INSTALLER locks, resolved by bash from the installer's own definitions ---
  const resolved = await installerResolves(
    ['APP_NAME', 'APP_DIR', 'DATA_DIR', 'CRONTAB_LOCK_DIR', 'CRONTAB_LOCK_FILE'])
  const installerLock = resolved.CRONTAB_LOCK_FILE
  assert.ok(installerLock.startsWith('/'), `the installer's lock must be absolute: ${installerLock}`)

  // --- what SYSTEMD will hand the application, from the unit the installer writes ---
  // StateDirectory= is a NAME relative to /var/lib; systemd exports the absolute path as
  // $STATE_DIRECTORY. Both halves are read out of the generated unit rather than assumed.
  const stateDirName = INSTALL_SH.match(/^StateDirectory=(\S+)$/m)
  assert.ok(stateDirName, 'the unit written by scripts/install.sh must declare StateDirectory=')
  const { stdout: expandedName } = await sh(
    `set -eu\nAPP_NAME='${resolved.APP_NAME}'\nprintf '%s' "${stateDirName![1]}"`,
  )
  const stateDirectory = `/var/lib/${expandedName}`
  assert.equal(stateDirectory, resolved.DATA_DIR,
    'StateDirectory= must name the same directory the installer already creates as DATA_DIR, '
    + 'or systemd hands the app a directory the installer never locks')

  // --- and the APPLICATION, resolved by the shipped function with that exact value ---
  const savedState = process.env.STATE_DIRECTORY
  const savedOverride = process.env.OTI_CRONTAB_LOCK_PATH
  try {
    process.env.STATE_DIRECTORY = stateDirectory
    assert.equal(crontabReconcileLockPath(), installerLock,
      'THE assertion: the two writers must resolve one FILE, not share a basename under two roots')

    // systemd's answer outranks the test-only override — that is what stops a configured path from
    // splitting the exclusion the way OTI_CRONTAB_LOCK_PATH did before the installer could see it.
    process.env.OTI_CRONTAB_LOCK_PATH = join(HARNESS, 'somewhere-else.lock')
    assert.equal(crontabReconcileLockPath(), installerLock,
      'STATE_DIRECTORY must win over the override, or the two writers can be configured apart again')

    // A colon-separated list (a unit with several StateDirectory= entries) takes the first.
    process.env.STATE_DIRECTORY = `${stateDirectory}:/var/lib/something-else`
    assert.equal(crontabReconcileLockPath(), installerLock)

    // A value that is not an absolute path is not systemd's, and is ignored rather than joined.
    process.env.STATE_DIRECTORY = 'onetwoinventory'
    assert.equal(crontabReconcileLockPath(), join(HARNESS, 'somewhere-else.lock'))
  } finally {
    if (savedState === undefined) delete process.env.STATE_DIRECTORY
    else process.env.STATE_DIRECTORY = savedState
    process.env.OTI_CRONTAB_LOCK_PATH = savedOverride
  }

  // The lock file is no longer in the app tree, and the installer must not put it back there.
  assert.equal(installerLock,
    join(resolved.DATA_DIR, CRONTAB_RECONCILE_LOCK_DIRNAME, CRONTAB_RECONCILE_LOCK_FILENAME))
  assert.equal(resolved.CRONTAB_LOCK_DIR, join(resolved.DATA_DIR, CRONTAB_RECONCILE_LOCK_DIRNAME),
    'the root-owned lock DIRECTORY is part of the agreement too: the application joins the same '
    + 'component onto $STATE_DIRECTORY, so a rename on either side splits the exclusion (r24)')
  assert.ok(!installerLock.startsWith(`${resolved.APP_DIR}/`),
    'a lock under APP_DIR cannot be opened under ProtectSystem=strict (Codex r23)')
  // And it is NOT directly in the state directory, which the service user owns and can write —
  // that placement is what made the installer's root-side `touch`/`chown`/`chmod` aimable.
  assert.notEqual(installerLock, join(resolved.DATA_DIR, CRONTAB_RECONCILE_LOCK_FILENAME))
})

// ---------------------------------------------------------------------------
// 10 — the chosen path survives the SHIPPED hardened unit's sandboxing
// ---------------------------------------------------------------------------

test('[o3d-batch-ret] the lock path is writable under every sandboxing directive in the shipped hardened unit', async () => {
  const { CRONTAB_RECONCILE_LOCK_DIRNAME, CRONTAB_RECONCILE_LOCK_FILENAME, crontabReconcileLockPath } =
    await import('@/lib/crontab-reconcile-lock')

  // The unit that the previous round was NOT checked against. Read it, do not describe it.
  const UNIT = readFileSync(join(REPO_ROOT, 'deploy/systemd/ims-stage.service'), 'utf8')
  const directive = (name: string) =>
    UNIT.split('\n').filter((l) => l.startsWith(`${name}=`)).map((l) => l.slice(name.length + 1).trim())

  // The constraint that broke the old path: everything is read-only except what is named.
  assert.deepEqual(directive('ProtectSystem'), ['strict'],
    'if this unit stops being strict the reasoning below changes — re-derive it, do not relax it')
  const readWrite = directive('ReadWritePaths')
  assert.ok(readWrite.length > 0)

  const workingDirectory = directive('WorkingDirectory')[0]
  assert.ok(workingDirectory, 'the unit must set WorkingDirectory')
  assert.ok(!readWrite.includes(workingDirectory),
    'the app directory itself is NOT read-write here — which is exactly why cwd was the wrong home '
    + `for the lock (ReadWritePaths: ${readWrite.join(', ')})`)

  // The path that IS writable: systemd creates a StateDirectory, owns it to User=, and implicitly
  // adds it to ReadWritePaths, so it needs no entry of its own.
  const stateNames = directive('StateDirectory')
  assert.deepEqual(stateNames.length, 1, 'exactly one StateDirectory, or $STATE_DIRECTORY is ambiguous')
  const stateDirectory = `/var/lib/${stateNames[0]}`

  const savedState = process.env.STATE_DIRECTORY
  try {
    process.env.STATE_DIRECTORY = stateDirectory
    assert.equal(crontabReconcileLockPath(),
      join(stateDirectory, CRONTAB_RECONCILE_LOCK_DIRNAME, CRONTAB_RECONCILE_LOCK_FILENAME),
      'under this unit the lock resolves inside the StateDirectory systemd guarantees is writable')
  } finally {
    if (savedState === undefined) delete process.env.STATE_DIRECTORY
    else process.env.STATE_DIRECTORY = savedState
  }

  // ------------------------------------------------------------------------
  // THE CENSUS. Every ACTIVE directive in the unit's [Service] section must be classified, by name,
  // as either reasoned-about-against-the-lock-path or explicitly neutral (Codex r24 MEDIUM).
  //
  // The previous version of this check filtered the unit's directives through a hand-picked prefix
  // regex (/^(Protect|Restrict|Private|Lock|…)/) and then asserted that what came through was
  // accounted for. That is a denylist wearing a census's clothes: `BindReadOnlyPaths=`,
  // `TemporaryFileSystem=`, `RootDirectory=`, `DynamicUser=` and `UMask=` all match none of those
  // prefixes, and every one of them can make the state directory unreachable, read-only, or resolve
  // somewhere else — the exact silent regression this test claims to prevent.
  //
  // So the direction is inverted: the unit is PARSED, and a directive nobody has classified fails,
  // whatever it is called.
  //
  // WHAT THIS CENSUS DOES NOT CATCH, said plainly: it is over directive NAMES. A directive that is
  // already classified but whose VALUE changes is caught only where a test reads that value — which
  // the four that decide the lock path do, above: ProtectSystem=, ReadWritePaths=, StateDirectory=
  // and WorkingDirectory= are each read out of the unit and asserted, not merely counted here.
  // ------------------------------------------------------------------------

  /** Every directive NAME active in the [Service] section, in order, duplicates included. */
  const serviceDirectiveNames = (unitText: string): string[] => {
    const names: string[] = []
    let inService = false
    let continuing = false
    for (const raw of unitText.split('\n')) {
      const line = raw.trim()
      if (continuing) {
        // A continued VALUE is not a directive, however much it looks like one.
        continuing = line.endsWith('\\')
        continue
      }
      if (/^\[.+\]$/.test(line)) { inService = line === '[Service]'; continue }
      if (!line || line.startsWith('#') || line.startsWith(';')) continue
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      if (inService) names.push(line.slice(0, eq).trim())
      continuing = line.endsWith('\\')
    }
    return names
  }

  // Directives that bear on WHERE the service may write, or on what the lock path resolves to.
  // Each carries the reason /var/lib/<state>/locks survives it.
  const REASONED = new Map<string, string>([
    ['ProtectSystem', 'strict — StateDirectory= is implicitly read-write, unlike WorkingDirectory'],
    ['ProtectHome', 'true — makes /home,/root,/run/user inaccessible; /var/lib is none of those'],
    ['PrivateTmp', 'true — private /tmp,/var/tmp only; /var/lib is untouched'],
    ['ProtectKernelTunables', 'true — /proc/sys and /sys only'],
    ['ProtectKernelModules', 'true — module (un)loading only'],
    ['ProtectKernelLogs', 'true — kmsg/dmesg only'],
    ['ProtectControlGroups', 'true — /sys/fs/cgroup only'],
    ['ProtectClock', 'true — system clock only'],
    ['ProtectHostname', 'true — hostname only'],
    ['NoNewPrivileges', 'true — no privilege gain; nothing here needs setuid, and the lock file is opened read-only'],
    ['RestrictSUIDSGID', 'true — forbids CREATING suid/sgid files; the lock file is 0644'],
    ['RestrictRealtime', 'true — scheduling only'],
    ['RestrictNamespaces', 'true — namespace creation only'],
    ['RestrictAddressFamilies', 'AF_INET AF_INET6 AF_UNIX — sockets only; flock(1) opens no socket'],
    ['LockPersonality', 'true — personality(2) only'],
    ['StateDirectory', 'onetwoinventory — the directory the lock path is derived from, and the value systemd exports as $STATE_DIRECTORY'],
    ['StateDirectoryMode', '0750 — owned by User=, which is what lets the service traverse it and, where there was no installer, create locks/ itself'],
    ['ReadWritePaths', 'the app-tree exceptions to ProtectSystem=strict; the state directory needs no entry because systemd adds it implicitly'],
    ['User', 'ims — the identity systemd gives the StateDirectory to, and the identity that opens the root-owned lock file read-only'],
    ['Group', 'ims — likewise; the lock file is world-readable, so group membership is not load-bearing'],
    ['WorkingDirectory', 'the app tree — the cwd fallback in crontabReconcileLockPath(), which $STATE_DIRECTORY outranks under this unit'],
    ['Environment', 'NODE_ENV=production is what makes OTI_CRONTAB_LOCK_PATH refuse to split the exclusion; no lock variable is set here'],
    ['EnvironmentFile', 'the .env may set OTI_CRONTAB_LOCK_WAIT_MS (bounded, validated); a lock PATH set there is refused in production'],
  ])
  // Directives that place no constraint on filesystem access at all. Listed, not matched by shape.
  const NEUTRAL = new Map<string, string>([
    ['Type', 'simple — start-up notification only'],
    ['ExecStart', 'the command; it does not constrain what that command may open'],
    ['ExecStartPre', 'a `test -d` on the build output; same'],
    ['Restart', 'restart policy — the lock is released by the kernel on exit either way'],
    ['RestartSec', 'restart delay'],
  ])

  const classified = (name: string) => REASONED.has(name) || NEUTRAL.has(name)
  assert.deepEqual([...REASONED.keys()].filter((n) => NEUTRAL.has(n)), [],
    'a directive cannot be both reasoned-about and neutral')

  const present = serviceDirectiveNames(UNIT)
  assert.ok(present.length > 20, `the [Service] section must have been parsed (found ${present.length})`)
  assert.ok(present.includes('ProtectSystem') && present.includes('StateDirectory'),
    'the parse must reach the sandboxing block, or every assertion below is vacuous')
  assert.deepEqual([...new Set(present)].filter((name) => !classified(name)), [],
    'a directive in the shipped unit\'s [Service] section has not been classified. Work out what it '
    + 'does to the lock path and add it to REASONED, or state why it is irrelevant and add it to '
    + 'NEUTRAL — do not widen a pattern to make it disappear')

  // The classification is about THIS unit: a name reasoned about but no longer set is a stale claim.
  for (const name of REASONED.keys()) {
    assert.ok(directive(name).length > 0, `the unit no longer sets ${name} — re-check the reasoning`)
  }

  // --- the census PROVEN, by mutation, against the directives the prefix regex could not see ---
  const withServiceDirective = (line: string) => UNIT.replace('[Service]\n', `[Service]\n${line}\n`)
  const UNSEEN_BEFORE = [
    'BindReadOnlyPaths=/var/lib/onetwoinventory',
    'TemporaryFileSystem=/var/lib',
    'RootDirectory=/srv/empty',
    'DynamicUser=true',
    'UMask=0077',
    'BindPaths=/tmp/elsewhere:/var/lib/onetwoinventory',
    'PrivateUsers=true',
    'ProcSubset=pid',
    'RootImage=/srv/image.raw',
    'ExtensionDirectories=/srv/ext',
    'MountAPIVFS=false',
    'Vorpal=blade',
  ]
  for (const added of UNSEEN_BEFORE) {
    const name = added.slice(0, added.indexOf('='))
    const mutated = serviceDirectiveNames(withServiceDirective(added))
    assert.ok(mutated.includes(name), `the parse must see ${name}`)
    assert.deepEqual(mutated.filter((n) => !classified(n)), [name],
      `${name} must FAIL this census: it changes what /var/lib/<state>/locks is, or whether it `
      + 'exists at all, and nothing here has reasoned about it')
  }

  // …and the scope is the [Service] section only: a directive added to [Unit] or [Install] is not
  // a sandboxing claim and must not be dragged in.
  for (const outside of ['[Unit]\nDocumentation=man:systemd.exec(5)', '[Install]\nAlso=other.service']) {
    const [section, line] = outside.split('\n')
    const mutated = serviceDirectiveNames(UNIT.replace(`${section}\n`, `${section}\n${line}\n`))
    assert.deepEqual(mutated.filter((n) => !classified(n)), [],
      `${line} is outside [Service] and must not be censused`)
  }

  // Exercised, not only read: a lock file inside a directory this process CANNOT WRITE — which is
  // what the installer's root-owned locks/ is to the service user — is still lockable, because the
  // descriptor is opened read-only and flock(2) ignores the access mode. That property is the whole
  // reason the lock file can be root-owned.
  const stateLike = join(HARNESS, 'state-like')
  await sh(`rm -rf '${stateLike}' && mkdir -p '${stateLike}/${CRONTAB_RECONCILE_LOCK_DIRNAME}' && chmod 0750 '${stateLike}'`)
  const { code, stderr } = await sh(
    `set -eu\nLOCKDIR='${stateLike}/${CRONTAB_RECONCILE_LOCK_DIRNAME}'\n`
    + `( umask 022; set -C; : > "$LOCKDIR/${CRONTAB_RECONCILE_LOCK_FILENAME}" )\n`
    + 'chmod 0444 "$LOCKDIR"/* && chmod 0555 "$LOCKDIR"\n'
    + `exec 9<'${stateLike}/${CRONTAB_RECONCILE_LOCK_DIRNAME}/${CRONTAB_RECONCILE_LOCK_FILENAME}'\n`
    + 'flock --exclusive --timeout 0 9\nexec 9>&-',
  )
  assert.equal(code, 0,
    'a read-only descriptor on a read-only file in an unwritable directory must still take the '
    + `exclusive lock — if it cannot, the lock cannot be root-owned: ${stderr}`)
})

// ---------------------------------------------------------------------------
// 11 — an UNWRITABLE lock path refuses; it never reconciles unserialised
// ---------------------------------------------------------------------------

test('[o3d-batch-ret] a lock path the service cannot write REFUSES the reconciliation and leaves the crontab alone', async () => {
  // The failure mode the previous round would actually have shipped: a state directory that is not
  // writable (no StateDirectory= in the unit, a mis-owned directory, a read-only bind mount). The
  // only two possible behaviours are "reconcile without the lock" — the defect — and "refuse".
  const readOnlyDir = join(HARNESS, 'unwritable-state')
  await sh(`mkdir -p '${readOnlyDir}' && chmod 0555 '${readOnlyDir}'`)

  const before = crontabText()
  writeFileSync(JOURNAL, '')

  const savedState = process.env.STATE_DIRECTORY
  try {
    process.env.STATE_DIRECTORY = readOnlyDir
    const result = await saveBackup(true)

    // The crontab was NOT touched: the shim journals a line the moment it is invoked at all.
    assert.deepEqual(journal(), [],
      'the crontab must not be read or written when the reconciliation could not be serialized')
    assert.equal(crontabText(), before, 'and the crontab file itself is byte-for-byte unchanged')

    // And the refusal SAYS WHY, naming the path and the directive that produces it.
    const reported = JSON.stringify(result)
    assert.match(reported, /Could not open the crontab reconciliation lock file/)
    assert.ok(reported.includes(readOnlyDir), `the refusal must name the path it tried: ${reported}`)
    assert.match(reported, /StateDirectory/,
      'and must name the unit directive an operator has to fix, not just fail')
  } finally {
    if (savedState === undefined) delete process.env.STATE_DIRECTORY
    else process.env.STATE_DIRECTORY = savedState
    await sh(`chmod 0755 '${readOnlyDir}'`)
  }
})

test('[o3d-batch-ret] a lock file that exists but cannot be opened for writing still serializes', async () => {
  // NOT a degraded case — this is the INSTALLED shape (r24). The installer creates the lock file
  // root-owned inside a root-owned directory precisely so that no root-side operation of its own
  // can be aimed by the service user, which means the service user's write open always fails and
  // the READ-ONLY fallback always carries the lock. flock(2) does not care about the access mode.
  // A read-only mount (EROFS under ProtectSystem=strict) reaches the same fallback.
  const dir = join(HARNESS, 'readonly-lockfile')
  const lockDir = join(dir, 'locks')
  const lock = join(lockDir, '.crontab-reconcile.lock')
  await sh(`rm -rf '${dir}' && mkdir -p '${lockDir}' && : > '${lock}'`
    + ` && chmod 0444 '${lock}' && chmod 0555 '${lockDir}' && chmod 0555 '${dir}'`)

  const { withCrontabReconcileLock } = await import('@/lib/crontab-reconcile-lock')
  const savedState = process.env.STATE_DIRECTORY
  try {
    process.env.STATE_DIRECTORY = dir
    let heldDuringRun: boolean | null = null
    const outcome = await withCrontabReconcileLock(async () => {
      const { code } = await sh(`flock --exclusive --timeout 0 '${lock}' true`)
      heldDuringRun = code !== 0
      return 'ran'
    })
    assert.equal(outcome.locked, true, 'an unwritable-but-present lock file must still lock')
    assert.equal(heldDuringRun, true,
      'and the exclusion must be real: an independent taker is refused while the section runs')
  } finally {
    if (savedState === undefined) delete process.env.STATE_DIRECTORY
    else process.env.STATE_DIRECTORY = savedState
    await sh(`chmod 0755 '${dir}' '${lockDir}' && chmod 0644 '${lock}'`)
  }
})

// ---------------------------------------------------------------------------
// 12 — the override cannot split the exclusion on a production install
// ---------------------------------------------------------------------------

test('[o3d-batch-ret] OTI_CRONTAB_LOCK_PATH is refused in production, so it cannot diverge from the installer', async () => {
  const { CRONTAB_RECONCILE_LOCK_DIRNAME, CRONTAB_RECONCILE_LOCK_FILENAME, crontabReconcileLockPath } =
    await import('@/lib/crontab-reconcile-lock')

  const env = process.env as Record<string, string | undefined>
  const savedNodeEnv = env.NODE_ENV
  const savedState = env.STATE_DIRECTORY
  const savedOverride = env.OTI_CRONTAB_LOCK_PATH
  const warnings: string[] = []
  const realWarn = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }

  try {
    delete env.STATE_DIRECTORY

    // Outside production it is honoured — this whole test file depends on that.
    env.NODE_ENV = 'test'
    env.OTI_CRONTAB_LOCK_PATH = '  /var/lib/oti/crontab.lock  '
    assert.equal(crontabReconcileLockPath(), '/var/lib/oti/crontab.lock')
    assert.deepEqual(warnings, [], 'and it warns about nothing when it is being used as intended')

    // In production it is IGNORED, and said so out loud. Silently honouring it is what gave the
    // installer and the app two different locks; silently dropping it would be no better.
    env.NODE_ENV = 'production'
    assert.equal(crontabReconcileLockPath(),
      join(process.cwd(), CRONTAB_RECONCILE_LOCK_DIRNAME, CRONTAB_RECONCILE_LOCK_FILENAME),
      'production must fall through to the working directory, never to the operator override')
    assert.equal(warnings.length, 1, 'the ignored override must be reported, not dropped in silence')
    assert.match(warnings[0], /OTI_CRONTAB_LOCK_PATH/)
    assert.match(warnings[0], /IGNORED/)
    assert.match(warnings[0], /StateDirectory/, 'and must point at what to set instead')

    // And with systemd present, production resolves to the state directory regardless.
    env.STATE_DIRECTORY = '/var/lib/one-two-inventory'
    assert.equal(crontabReconcileLockPath(),
      `/var/lib/one-two-inventory/${CRONTAB_RECONCILE_LOCK_DIRNAME}/${CRONTAB_RECONCILE_LOCK_FILENAME}`)
    assert.equal(warnings.length, 1, 'no warning is needed when systemd has already answered')
  } finally {
    console.warn = realWarn
    if (savedNodeEnv === undefined) delete env.NODE_ENV
    else env.NODE_ENV = savedNodeEnv
    if (savedState === undefined) delete env.STATE_DIRECTORY
    else env.STATE_DIRECTORY = savedState
    env.OTI_CRONTAB_LOCK_PATH = savedOverride
  }
})

// ---------------------------------------------------------------------------
// 13 - 16 — THE INSTALLER'S ROOT-SIDE PREPARATION OF THE LOCK CANNOT BE AIMED
//           (Codex r24 CRITICAL)
//
// Round 23's installer ran `touch`, `chown` and `chmod` as root on a path inside a directory the
// unprivileged service user owns. All three follow symlinks, so that user could replace the lock
// file with a link to any path on the system and have the next install or upgrade hand it over.
//
// These four tests drive the SHIPPED `prepare_crontab_lock`, lifted out of scripts/install.sh and
// executed by a real bash against real files. `chown` is the only step this harness cannot perform
// (it is not root); it is recorded and asserted instead, which is how these tests observe that
// every root-side ownership change is `--no-dereference`.
// ---------------------------------------------------------------------------

/**
 * The installer's OWN preparation function, lifted out of the script rather than retyped here — so
 * a change to it changes what these tests execute, instead of quietly leaving them testing a copy.
 */
function installerPreparer(): string {
  const lines = INSTALL_SH.split('\n')
  const start = lines.indexOf('prepare_crontab_lock() {')
  assert.notEqual(start, -1, 'scripts/install.sh must define prepare_crontab_lock()')
  const end = lines.indexOf('}', start)
  assert.ok(end > start, 'prepare_crontab_lock() must be closed by a `}` on its own line')
  return lines.slice(start, end + 1).join('\n')
}

/**
 * The same function with its comments and its operator-facing `die` messages removed, so that a
 * claim about what it RUNS is not satisfied by what it says.
 */
function installerPreparerCode(): string {
  return installerPreparer().split('\n')
    .filter((l) => !l.trim().startsWith('#')) // comments
    .filter((l) => !l.trim().startsWith('"')) // the `die \` operator messages
    .join('\n')
}

type PreparerRun = { code: number | null; stdout: string; stderr: string; chowns: string[] }

async function runInstallerPreparer(root: string): Promise<PreparerRun> {
  const chownLog = join(root, 'chown.log')
  writeFileSync(chownLog, '')
  const script = [
    'set -euo pipefail',
    "APP_USER='svcuser'",
    `CRONTAB_LOCK_DIR='${join(root, 'state', 'locks')}'`,
    `CRONTAB_LOCK_FILE='${join(root, 'state', 'locks', '.crontab-reconcile.lock')}'`,
    'die() { printf \'DIE: %s\\n\' "$*" >&2; exit 1; }',
    `chown() { printf '%s\\n' "$*" >> '${chownLog}'; }`,
    installerPreparer(),
    'prepare_crontab_lock',
  ].join('\n')
  const { code, stdout, stderr } = await sh(script)
  return { code, stdout, stderr, chowns: readFileSync(chownLog, 'utf8').split('\n').filter(Boolean) }
}

/** Every recorded ownership change must be `--no-dereference`, and must be to root. */
function assertChownsNeverDereference(run: PreparerRun): void {
  assert.deepEqual(run.chowns.filter((c) => !c.startsWith('-h root:root ')), [],
    'a root-side chown without -h dereferences a planted symlink — that IS the escalation, and it '
    + 'is also how the service user came to own the lock file in the first place')
}

test('[o3d-batch-ret] the installer prepares the lock with symlink-proof primitives only', () => {
  // The three behavioural tests that follow prove the OUTCOME. This one names the mechanism, so
  // that a future edit which reaches the same outcome by a dereferencing route — the natural,
  // obvious route, and the one round 23 took — is refused here rather than only when someone
  // happens to plant a symlink.
  const code = installerPreparerCode()

  assert.match(code, /mkdir "\$\{CRONTAB_LOCK_DIR\}"/,
    'plain `mkdir` (never -p) is what refuses to follow a symlink at the directory path: -p '
    + 'accepts a symlink to a directory and then everything after it runs inside the target')
  assert.match(code, /set -C/,
    'a noclobber redirection (O_CREAT|O_EXCL) is what refuses to follow one at the file path')
  assert.doesNotMatch(code, /\b(chmod|touch|install)\b/,
    'chmod has no --no-dereference on Linux and touch follows symlinks, so neither may be RUN on '
    + 'these paths — the modes come from umask at creation instead')
  assert.doesNotMatch(code, /stat -L/, 'stat -L would dereference; the checks must be lstat')
  assert.doesNotMatch(code, /chown(?! -h )/,
    'every chown must be --no-dereference')

  // And the guard is not vacuous: each of those patterns is asked of a body that violates it.
  const dereferencing = code
    .replace('mkdir "${CRONTAB_LOCK_DIR}"', 'mkdir -p "${CRONTAB_LOCK_DIR}"')
    .replace('set -C; : >', 'touch')
  assert.doesNotMatch(dereferencing, /mkdir "\$\{CRONTAB_LOCK_DIR\}"/)
  assert.match(dereferencing, /\btouch\b/)
})

test('[o3d-batch-ret] the installer REFUSES a lock file replaced by a symlink, and never touches the target', async () => {
  const root = join(HARNESS, 'plant-file')
  const victim = join(root, 'victim-secret')
  const lockPath = join(root, 'state', 'locks', '.crontab-reconcile.lock')
  await sh(`set -eu
rm -rf '${root}'
mkdir -p '${root}/state/locks'
printf 'root-only-secret\\n' > '${victim}'
chmod 0600 '${victim}'
ln -s '${victim}' '${lockPath}'`)
  const before = statSync(victim)

  const run = await runInstallerPreparer(root)

  // THE ASSERTION, first: nothing reached the target. Not its contents, not its mode, not its
  // ownership, and it was not replaced. Round 23's `touch` + `chown ${APP_USER}` + `chmod 0664`
  // changed all three, which is the whole of the finding.
  const after = statSync(victim)
  assert.equal(readFileSync(victim, 'utf8'), 'root-only-secret\n')
  assert.equal(after.mode, before.mode, 'the target keeps its mode — no chmod followed the link')
  assert.equal(after.uid, before.uid, 'and its owner — no chown followed the link')
  assert.equal(after.ino, before.ino, 'and its inode — it was not replaced')
  assertChownsNeverDereference(run)
  assert.ok(lstatSync(lockPath).isSymbolicLink(),
    'the plant is still a symlink: nothing was written through it, and nothing overwrote it')

  // …and the install stops, rather than carrying on with a lock it could not establish.
  assert.equal(run.code, 1, `the installer must refuse this path: ${run.stdout}${run.stderr}`)
  assert.match(run.stderr, /is not a regular file/)
  assert.ok(run.stderr.includes(lockPath), 'and must name the path it refused')
})

test('[o3d-batch-ret] the installer never CREATES the file a planted lock symlink points at', async () => {
  const root = join(HARNESS, 'plant-dangling')
  const target = join(root, 'would-be-created')
  await sh(`set -eu
rm -rf '${root}'
mkdir -p '${root}/state/locks'
ln -s '${target}' '${root}/state/locks/.crontab-reconcile.lock'`)

  const run = await runInstallerPreparer(root)

  // A DANGLING plant is the case a `[ -e ]` guard reads as "missing" and creates. The creation is
  // O_CREAT|O_EXCL, which fails with EEXIST on the symlink itself rather than creating the target.
  assert.equal(run.code, 1, `the installer must refuse: ${run.stdout}${run.stderr}`)
  assert.equal(existsSync(target), false,
    'a dangling lock symlink must not be turned into a root-owned file wherever it points — that '
    + 'is a root-side create at an attacker-chosen path')
  assertChownsNeverDereference(run)
})

test('[o3d-batch-ret] the installer REFUSES a lock DIRECTORY replaced by a symlink, and writes nothing inside it', async () => {
  const root = join(HARNESS, 'plant-dir')
  const victimDir = join(root, 'victim-dir')
  await sh(`set -eu
rm -rf '${root}'
mkdir -p '${root}/state' '${victimDir}'
: > '${victimDir}/only-file'
chmod 0700 '${victimDir}'
ln -s '${victimDir}' '${root}/state/locks'`)
  const before = statSync(victimDir)

  const run = await runInstallerPreparer(root)

  // THE ASSERTION, first. `mkdir -p` would have SUCCEEDED here — a symlink to a directory satisfies
  // it — and everything after it would then have run INSIDE the target. Plain `mkdir` fails with
  // EEXIST, so the target gains no entry at all.
  assert.deepEqual(readdirSync(victimDir), ['only-file'],
    'no lock file may appear inside the directory a planted symlink points at')
  assert.equal(statSync(victimDir).mode, before.mode, 'and its mode is untouched')
  assertChownsNeverDereference(run)

  assert.equal(run.code, 1, `the installer must refuse: ${run.stdout}${run.stderr}`)
  assert.match(run.stderr, /is not a directory/)
})

test('[o3d-batch-ret] the prepared lock cannot be replaced from a directory the service user cannot write', async () => {
  assert.notEqual(process.getuid?.(), 0,
    'this test models the service user with the ordinary DAC write check, which does not apply to '
    + 'root — run the unit tests as an unprivileged user')

  const root = join(HARNESS, 'ownership')
  await sh(`rm -rf '${root}' && mkdir -p '${root}/state'`)
  const lockDir = join(root, 'state', 'locks')
  const lockFile = join(lockDir, '.crontab-reconcile.lock')

  const run = await runInstallerPreparer(root)
  assert.equal(run.code, 0, `preparation must succeed on a clean state directory: ${run.stderr}`)
  assert.ok(statSync(lockFile).isFile(), 'the lock file is a plain file the installer created')
  assert.equal(statSync(lockDir).mode & 0o022, 0,
    'the lock directory is not group- or other-writable — that mode IS the protection')
  assert.deepEqual(run.chowns, [`-h root:root ${lockDir}`, `-h root:root ${lockFile}`],
    'both paths are taken by ROOT, with --no-dereference, and neither is ever chowned to the '
    + 'service user — which is what round 23 did on every re-run')

  // The service user's position, modelled by the same permission check a root-owned 0755 directory
  // produces for it: a directory this process may not write.
  const inode = statSync(lockFile).ino
  await sh(`: > '${root}/state/decoy' && chmod 0555 '${lockDir}'`)
  try {
    for (const attempt of [
      `rm -f '${lockFile}'`,
      `ln -sfn /etc/passwd '${lockFile}'`,
      `mv '${root}/state/decoy' '${lockFile}'`,
      `touch '${lockDir}/some-other-entry'`,
    ]) {
      const { code } = await sh(attempt)
      assert.notEqual(code, 0, `the service user must be refused: ${attempt}`)
    }
    assert.equal(statSync(lockFile).ino, inode,
      'the lock is still the same inode, so the exclusion still names the same object')
    assert.ok(statSync(lockFile).isFile(), 'and it is still a regular file, not a link to one')

    // CONTROL — the SAME four attempts against round 23's placement, the lock file directly in the
    // state directory this user owns. They succeed. Without this the refusals above could be four
    // broken commands rather than a permission boundary, and the placement above could be doing
    // nothing at all.
    const beside = join(root, 'state', '.crontab-reconcile.lock')
    await sh(`: > '${beside}'`)
    const { code: replaced } = await sh(`rm -f '${beside}' && ln -sfn /etc/passwd '${beside}'`)
    assert.equal(replaced, 0,
      'the old placement IS replaceable by this user — which is the finding, and why the lock '
      + 'moved into a directory the user cannot write')
    assert.ok(lstatSync(beside).isSymbolicLink())
  } finally {
    await sh(`chmod 0755 '${lockDir}'`)
  }
})
