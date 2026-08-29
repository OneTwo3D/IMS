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
import { dirname, join } from 'node:path'
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
//  17. LOAD-BEARING. an UPGRADE puts the RUNNING process on this protocol: the already-active
//      service is RESTARTED, not merely enabled/started, and the restart is a RECORDED systemctl
//      invocation rather than a word in the file        (scripts/install.sh, run by a real bash)
//  18. a restart that fails, or that leaves the unit not active, ABORTS the install rather than
//      letting the installer take a lock that excludes nothing
//  19. the ordering itself: build -> unit -> restart -> guard -> lock, and the crontab section
//      REFUSES to open the lock if the restart did not happen, with a CONTROL that it otherwise does
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
const DEPLOY_SH = readFileSync(join(REPO_ROOT, 'scripts/deploy.sh'), 'utf8')
const UPDATE_SH = readFileSync(join(REPO_ROOT, 'scripts/update.sh'), 'utf8')
const CRONTAB_LOCK_LIB = join(REPO_ROOT, 'scripts/lib/crontab-lock.sh')
const CRONTAB_LOCK_LIB_SRC = readFileSync(CRONTAB_LOCK_LIB, 'utf8')
const SHELL_ENTRYPOINTS: Array<[string, string]> = [
  ['scripts/install.sh', INSTALL_SH],
  ['scripts/deploy.sh', DEPLOY_SH],
  ['scripts/update.sh', UPDATE_SH],
]

/**
 * A probe that takes the crontab lock EXACTLY the way the shipped entrypoints take it: by sourcing
 * scripts/lib/crontab-lock.sh and calling `with_crontab_lock`. Nothing about the acquisition is
 * retyped here, so removing or weakening the helper breaks these tests rather than passing quietly.
 *
 * It replaces a probe that lifted `exec 9<…` / `flock … 9` out of scripts/install.sh by regexp.
 * Those two lines are gone — o3d-p9dq moved the acquisition into the library, partly because fd 9
 * is where all three entrypoints hold the SHARED CUTOVER lock and `exec 9<` was silently releasing
 * it.
 */
function shellLockProbe(body: string, waitSeconds: number): string {
  return `set -u
die() { echo "DIE: $*" >&2; exit 1; }
IMS_CRONTAB_LOCK_WAIT_SECONDS=${waitSeconds}
source '${CRONTAB_LOCK_LIB}'
CRONTAB_LOCK_DIR='${dirname(LOCK_FILE)}'
CRONTAB_LOCK_FILE='${LOCK_FILE}'
probe_body() {
${body}
}
rc=0
with_crontab_lock probe_body || rc=$?
exit "$rc"`
}

/** `flock --conflict-exit-code` is not used by the shell helper; it reports conflicts as 75. */
const SHELL_LOCK_CONFLICT = 75

test('[o3d-batch-ret] a SHELL ENTRYPOINT cannot take the crontab lock while the application holds it', async () => {
  // `--timeout 0`: an immediate, deterministic answer about a lock that is definitely held.
  const probe = shellLockProbe('  echo ACQUIRED', 0)

  const { withCrontabReconcileLock } = await import('@/lib/crontab-reconcile-lock')
  const outcome = await withCrontabReconcileLock(async () => sh(probe))
  assert.equal(outcome.locked, true)
  const result = outcome.locked === true ? outcome.result : null
  assert.equal(result!.code, SHELL_LOCK_CONFLICT,
    'with_crontab_lock must report a conflict, not run the body, while a reconciliation holds the lock')
  assert.doesNotMatch(result!.stdout, /ACQUIRED/,
    'and the body must not have run: a shell writer that proceeds without the lock IS the defect')

  // …and granted the moment it is free, so this is exclusion and not a broken command.
  const after = await sh(probe)
  assert.equal(after.code, 0)
  assert.match(after.stdout, /ACQUIRED/)
})

test('[o3d-batch-ret] an APPLICATION reconciliation is refused while a SHELL ENTRYPOINT holds the crontab lock', async () => {
  const holder = spawn('bash', ['-c', shellLockProbe(
    `  echo held > '${READY_FIFO}'\n  head -n 1 '${GO_FIFO}' > /dev/null`, 30)],
  { stdio: ['ignore', 'ignore', 'pipe'] })
  await awaitFifo(READY_FIFO)
  assert.equal(await lockIsFree(), false, 'the shell entrypoint holds the lock')

  // The wait is bounded, and here it is deliberately short: the assertion is that it EXPIRES.
  process.env.OTI_CRONTAB_LOCK_WAIT_MS = '50'
  const before = crontabText()
  const result = await saveBackup(true)

  assert.equal(crontabText(), before,
    'no application reconciliation may rewrite the crontab while a shell entrypoint is inside its own read-modify-write')
  assert.equal(snapshots.length, 0, 'and it must not even snapshot the settings')
  assert.equal(result.status, 'post-commit-failed')
  assert.equal(result.status === 'post-commit-failed' && result.step, 'scheduler')
  assert.match(result.status === 'post-commit-failed' ? result.error : '', /Another crontab reconciliation is still running/)

  await writeFile(GO_FIFO, 'go\n')
  await new Promise((resolve) => holder.on('exit', resolve))

  // Once the entrypoint is out, the application reconciles normally — the refusal was the
  // exclusion, not a broken path.
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
  const holder = spawn('bash', ['-c', shellLockProbe(
    `  echo held > '${READY_FIFO}'\n  head -n 1 '${GO_FIFO}' > /dev/null`, 30)],
  { stdio: ['ignore', 'ignore', 'pipe'] })
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

// ---------------------------------------------------------------------------
// THE SHELL-SIDE CLASSIFIER, shared by the census and by the mutation control below.
//
// It exists as a function rather than as code inside one test precisely so that the negative
// control can run the SAME logic over a mutated source. A guard that is only ever asked about
// sources that satisfy it has not been shown to reject anything (o3d-p9dq).
// ---------------------------------------------------------------------------
type ShellCrontabSite = { file: string; line: number; text: string }

/**
 * Every `crontab` INVOCATION in one shell source.
 *
 * `\s*` AFTER `^`, not before `crontab`: the original spelling required `crontab` to be the FIRST
 * CHARACTER of the line, so every indented bare invocation — which is what a call inside a shell
 * function looks like — was skipped by a test that calls itself a walk.
 *
 * A line beginning with a double quote is skipped, and that is not a loophole: those are the
 * continuation lines of `die`/`warn` messages, several of which QUOTE `crontab -u <user> <backup>`
 * as the by-hand recovery command an operator should run. Counting operator prose as a writer is
 * how round 25's allowlist came to carry entries for functions whose only `crontab` was in a
 * sentence. Every real invocation in these scripts is a command, and no command line in them
 * begins with a quote.
 */
function shellCrontabSitesIn(file: string, src: string): ShellCrontabSite[] {
  const sites: ShellCrontabSite[] = []
  src.split('\n').forEach((line, index) => {
    const trimmed = line.trimStart()
    if (trimmed.startsWith('#') || trimmed.startsWith('"')) return
    if (!/(^\s*|[|;&({]\s*)crontab\b/.test(line)) return
    sites.push({ file, line: index + 1, text: line })
  })
  return sites
}

/**
 * Which shell function a line is inside. Classified by ENCLOSING FUNCTION rather than by file,
 * because that is the unit that either takes the lock or does not.
 */
function enclosingFunctionInSource(src: string[], line: number): string {
  for (let i = line - 1; i >= 0; i -= 1) {
    const opened = src[i].match(/^([a-zA-Z_][a-zA-Z0-9_]*)\(\) \{/)
    if (opened) return opened[1]
    if (i < line - 1 && /^\}/.test(src[i])) break   // left the previous function's body
  }
  return '(top level)'
}

function enclosingFunctionIn(file: string, line: number): string {
  return enclosingFunctionInSource(readFileSync(join(REPO_ROOT, file), 'utf8').split('\n'), line)
}

/**
 * THE RULE, applied. A scope is reported when either half fails:
 *
 *   • the crontab invocation is not inside a `*_locked` body at all — it is at top level, or in an
 *     ordinary function, which is where every one of round 25's fourteen exceptions sat; or
 *   • it IS in such a body, but that body has a caller which is not `with_crontab_lock`. A second
 *     entry point into a locked body is an unlocked writer wearing the name of a locked one, and
 *     it is the placement a file-keyed or count-keyed allowlist cannot see.
 */
function unlockedCrontabScopesIn(
  files: Array<[string, string]>,
  sites: ShellCrontabSite[],
): string[] {
  const sources = new Map(files)
  const bad = new Set<string>()
  for (const site of sites) {
    const raw = sources.get(site.file) ?? readFileSync(join(REPO_ROOT, site.file), 'utf8')
    const src = raw.split('\n')
    const fn = enclosingFunctionInSource(src, site.line)
    const scope = `${site.file}:${fn}`
    if (!fn.endsWith('_locked')) { bad.add(scope); continue }
    const references = src.filter((l) => !l.trimStart().startsWith('#')
      && new RegExp(`(^|[^A-Za-z0-9_])${fn}([^A-Za-z0-9_]|$)`).test(l))
    const callers = references.filter((l) => !new RegExp(`^${fn}\\(\\) \\{`).test(l))
    if (callers.length === 0) { bad.add(scope); continue }
    if (!callers.every((l) => new RegExp(`^\\s*with_crontab_lock ${fn}([^A-Za-z0-9_]|$)`).test(l))) {
      bad.add(scope)
    }
  }
  return [...bad].sort()
}

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
        }
      })
      // The shell side goes through the SHARED classifier, so the census and the mutation control
      // below are asking one question rather than two that happen to agree today.
      if (isShell) shellCrontab.push(...shellCrontabSitesIn(rel, src))
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

  // --- writer 2 and beyond: the three shell entrypoints ---
  //
  // ROUND 25 LISTED FOURTEEN EXCEPTIONS HERE AND CALLED IT A CENSUS. install.sh had the flock;
  // deploy.sh and update.sh fenced, unfenced, adopted and unwound the SAME crontab with no
  // exclusion at all, and this test recorded that as an allowlist keyed by enclosing function —
  // `{'scripts/deploy.sh:fence_cron': 2, …}`, fourteen entries. An exclusion protocol with
  // fourteen declared exceptions is not an exclusion protocol, so o3d-p9dq closed them, and what
  // stands here is a RULE rather than a list:
  //
  //   every shell crontab invocation sits in a body whose name ends `_locked`,
  //   and every one of those bodies is reachable ONLY through `with_crontab_lock`.
  //
  // A list would go on passing while a fifteenth writer was added to a file already on it. The
  // rule fails on the fifteenth, wherever it is put — and that is proved by mutation in
  // '[o3d-batch-ret] the census fails on a FIFTEENTH writer', below, which feeds it a source with
  // one added.
  const unlocked = unlockedCrontabScopesIn(SHELL_ENTRYPOINTS, shellCrontab)
  assert.deepEqual(unlocked, [],
    'every shell crontab read-modify-write must sit in a `*_locked` body whose only caller is '
    + 'with_crontab_lock. These are not: ' + JSON.stringify(unlocked))

  // NOT VACUOUS: the walk found the bodies, in all three entrypoints, and each is where the
  // cutover fence and its unwind actually live.
  const scopes = new Set(shellCrontab.map((c) => `${c.file}:${enclosingFunctionIn(c.file, c.line)}`))
  for (const file of ['scripts/install.sh', 'scripts/deploy.sh', 'scripts/update.sh']) {
    for (const body of ['fence_cron_locked', 'unfence_cron_locked',
      'restore_cron_from_backup_locked', 'resume_restore_cron_locked']) {
      assert.ok(scopes.has(`${file}:${body}`),
        `${file} must still perform its crontab read-modify-write in ${body}() — if it was renamed `
        + 'or removed, this census no longer covers it')
    }
  }
  assert.ok(scopes.has('scripts/install.sh:bootstrap_managed_crontab_block_locked'),
    'the installer must still write its bootstrap block, and inside the lock')
  for (const file of ['scripts/deploy.sh', 'scripts/update.sh']) {
    assert.ok(scopes.has(`${file}:adopt_cron_fence_locked`),
      `${file} re-fences an adopted crontab and that read-modify-write is one critical section too`)
  }

  // AND EVERY ENTRYPOINT JOINS THE PROTOCOL FROM THE SAME FILE. Three copies of an exclusion are
  // three exclusions; db-fence-protected.sh made the same argument about the fence script and this
  // is the same shape (o3d-p9dq).
  for (const [name, src] of SHELL_ENTRYPOINTS) {
    assert.match(src, /^source "\$\{IMS_SCRIPT_LIB_DIR\}\/crontab-lock\.sh" \|\| \{$/m,
      `${name} must source the shared crontab lock library, not restate the protocol`)
    assert.match(src, /^crontab_lock_paths "\$\{(?:DATA_DIR|CUTOVER_STATE_DIR)\}"$/m,
      `${name} must compose its lock path through crontab_lock_paths(), so the two components live `
      + 'in one place')
    assert.match(src, /^\s*prepare_crontab_lock$/m,
      `${name} must PREPARE the root-owned lock before it touches the crontab: on a host installed `
      + 'by a release older than this protocol the lock file does not exist yet')
    assert.doesNotMatch(src, /^\s*exec 9<"\$\{CRONTAB_LOCK_FILE\}"/m,
      `${name} must not open the crontab lock on fd 9: that is the descriptor acquire_cutover_lock `
      + 'holds the SHARED CUTOVER lock on, and re-opening it releases that lock')
  }

  // THE ONE PLACE A BODY MAY RUN WITHOUT THE LOCK, and it is in the library rather than at any
  // call site: --dry-run, which is documented to work unprivileged and whose crontab bodies all
  // return before any write.
  const dryRunBypasses = CRONTAB_LOCK_LIB_SRC.split('\n')
    .filter((l) => /CRONTAB_LOCK_DRY_RUN/.test(l) && !l.trim().startsWith('#'))
  assert.deepEqual(dryRunBypasses.map((l) => l.trim()),
    ['CRONTAB_LOCK_DRY_RUN=false', 'if ${CRONTAB_LOCK_DRY_RUN}; then'],
    'the dry-run bypass must be exactly one declaration and one branch, in the library')
  for (const [name, src] of SHELL_ENTRYPOINTS) {
    const sets = src.split('\n').filter((l) => /^CRONTAB_LOCK_DRY_RUN=/.test(l))
    if (name === 'scripts/install.sh') {
      assert.deepEqual(sets, [],
        'scripts/install.sh has no --dry-run, so it must never raise the bypass')
    } else {
      assert.deepEqual(sets, ['CRONTAB_LOCK_DRY_RUN="${DRY_RUN}"'],
        `${name} must raise the bypass from its own DRY_RUN and from nothing else`)
    }
  }

  // THE INSTALLER'S BOOTSTRAP IS STILL GATED ON THE BUILD/LISTENER PROOF, and the gate is still
  // BEFORE the lock is taken rather than beside it.
  const installLines = INSTALL_SH.split('\n')
  const lineOf = (re: RegExp) => {
    const index = installLines.findIndex((l) => re.test(l))
    assert.notEqual(index, -1, `scripts/install.sh is missing: ${re}`)
    return index + 1
  }
  const guard = lineOf(/^\[\[ "\$\{APP_SERVICE_ON_NEW_BUILD:-false\}" == "true" \]\]/)
  const taken = lineOf(/^with_crontab_lock bootstrap_managed_crontab_block_locked/)
  assert.ok(guard < taken, 'the proof gate must precede the acquisition, not follow it')

  // The installer is a BOOTSTRAP: it must not overwrite a managed block the application owns,
  // because its schedules are defaults rather than the committed settings.
  assert.match(INSTALL_SH, /grep -qE '\^# --- OTI CRON START ---\[ \\t\\r\]\*\$'/,
    'the installer must skip its bootstrap block when the application already manages one')

  // And it must never replace the lock file, because the lock lives on the inode.
  assert.doesNotMatch(INSTALL_SH, /rm -f "\$\{CRONTAB_LOCK_FILE\}"/)

  // The lock file is prepared ONCE, by the library, and nothing else ever operates on either lock
  // path (r24). No `touch`/`chown`/`chmod` may sit on them ANYWHERE — in the library or in any of
  // the three entrypoints — because those three follow symlinks and both paths live under a
  // directory the service user owns. Scanned across all four files, since the preparation moved.
  const lockPathOperations = [['scripts/lib/crontab-lock.sh', CRONTAB_LOCK_LIB_SRC] as [string, string],
    ...SHELL_ENTRYPOINTS]
    .flatMap(([name, src]) => src.split('\n')
      .map((l, index) => ({ file: name, line: index + 1, text: l.trim() })))
    .filter(({ text }) => !text.startsWith('#')
      && /\$\{CRONTAB_LOCK_(?:DIR|FILE)\}/.test(text)
      && /^(touch|chmod|chown|install|ln|cp|mv|rm)\b/.test(text))
  assert.deepEqual(
    lockPathOperations.filter(({ text }) => !text.startsWith('chown -h root:root ')),
    [],
    'every root-side operation on the crontab lock paths must be symlink-proof: only `chown -h` '
    + '(which never dereferences) is allowed, and touch/chmod are not',
  )
  assert.deepEqual(lockPathOperations.map(({ file }) => file),
    ['scripts/lib/crontab-lock.sh', 'scripts/lib/crontab-lock.sh'],
    'the two `chown -h root:root` calls in prepare_crontab_lock — the directory and the file — and '
    + 'no entrypoint may have grown one of its own')
  for (const [name, src] of [['scripts/lib/crontab-lock.sh', CRONTAB_LOCK_LIB_SRC] as [string, string],
    ...SHELL_ENTRYPOINTS]) {
    assert.doesNotMatch(src, /chown[^\n]*\$\{APP_USER\}[^\n]*\$\{CRONTAB_LOCK_/,
      `${name}: the lock must never be handed to the service user — that is what made an installer `
      + 're-run a privilege-escalation primitive (r24 CRITICAL)')
  }
  assert.ok(
    installLines.findIndex((l) => l === 'prepare_crontab_lock') < taken,
    'the lock must be prepared before the installer takes it — the installer no longer creates it '
    + 'there, and by then the service is already running',
  )
})

// ---------------------------------------------------------------------------
// 8b — the census is a RULE, not a list: it fails on the fifteenth writer
// ---------------------------------------------------------------------------

test('[o3d-batch-ret] the census fails on a FIFTEENTH writer, wherever it is put', () => {
  // MUTATION, against the SAME classifier the census above runs. Round 25's version of this test
  // held a fourteen-entry allowlist keyed by file:function, which a new crontab call inside an
  // already-listed function satisfied silently. Three placements are tried, and each is the
  // natural one for a future edit to reach for.
  const placements: Array<[string, string]> = [
    // (a) a brand-new helper that does its own read-modify-write
    ['a new unlocked function',
      'sweep_cron() {\n  crontab -u "${APP_USER}" -l | grep -v foo | crontab -u "${APP_USER}" -\n}\n'],
    // (b) a line added at top level, outside every function
    ['a top-level write', '\ncrontab -u "${APP_USER}" /tmp/whatever\n'],
    // (c) a line added INSIDE a body that is already inside the protocol, but reached from a new
    //     wrapper of its own — the placement a file-keyed or count-keyed allowlist cannot see
    ['a second, unlocked caller of a locked body',
      'refence_cron() {\n  crontab -u "${APP_USER}" -l > /dev/null\n  fence_cron_locked\n}\n'],
  ]
  for (const [what, snippet] of placements) {
    const mutated = INSTALL_SH + '\n' + snippet
    const sites = shellCrontabSitesIn('scripts/install.sh', mutated)
    const unlocked = unlockedCrontabScopesIn([['scripts/install.sh', mutated]], sites)
    assert.notDeepEqual(unlocked, [],
      `the census must reject ${what}; it reported nothing unlocked`)
  }

  // CONTROL — the unmutated sources come back clean through the very same two functions, so the
  // three rejections above are the rule working and not a classifier that rejects everything.
  const clean = SHELL_ENTRYPOINTS.flatMap(([name, src]) => shellCrontabSitesIn(name, src))
  assert.ok(clean.length >= 15, `the control must reach the real sites (found ${clean.length})`)
  assert.deepEqual(unlockedCrontabScopesIn(SHELL_ENTRYPOINTS, clean), [])
})

// ---------------------------------------------------------------------------
// 9 — the two writers RESOLVE the same file, from the systemd StateDirectory
// ---------------------------------------------------------------------------

/**
 * Evaluate the installer's OWN definitions in a real bash, and print what they resolve to.
 *
 * Not a re-typed copy of the paths. The plain `NAME="…"` lines are lifted out of scripts/install.sh
 * by name; the two lock paths are no longer literals there at all — o3d-p9dq moved the two
 * components into scripts/lib/crontab-lock.sh so that three entrypoints could not each get them
 * slightly wrong — so this SOURCES that library and runs the installer's own lifted
 * `crontab_lock_paths` call. Renaming APP_NAME, repointing DATA_DIR or changing either component
 * therefore moves what these tests compare against, and a divergence shows up here instead of on an
 * operator's box.
 */
const COMPOSED_LOCK_NAMES = ['CRONTAB_LOCK_DIR', 'CRONTAB_LOCK_FILE']
async function installerResolves(names: string[]): Promise<Record<string, string>> {
  const defs = names.filter((name) => !COMPOSED_LOCK_NAMES.includes(name)).map((name) => {
    const line = INSTALL_SH.match(new RegExp(`^${name}="[^"]*"$`, 'm'))
    assert.ok(line, `scripts/install.sh must define ${name} on one line`)
    return line![0]
  })
  const compose = INSTALL_SH.match(/^crontab_lock_paths "\$\{DATA_DIR\}"$/m)
  assert.ok(compose, 'scripts/install.sh must compose its crontab lock path from ${DATA_DIR} '
    + 'through the shared library, on one line')
  assert.ok(names.includes('DATA_DIR'),
    'DATA_DIR is what the composition reads, so it has to be resolved alongside it')
  const prints = names.map((name) => `printf '%s=%s\\n' '${name}' "\${${name}}"`)
  const { code, stdout, stderr } = await sh(
    `set -eu\n${defs.join('\n')}\nsource '${CRONTAB_LOCK_LIB}'\n${compose![0]}\n${prints.join('\n')}`)
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

  /**
   * Every directive NAME active in the [Service] section, in order, duplicates included.
   *
   * CONTINUATION, AS SYSTEMD ACTUALLY DOES IT (Codex r25 MEDIUM). The previous version cleared
   * `continuing` on any physical line that did not end in a backslash — including a COMMENT line —
   * which is not what systemd does, and made the census skippable: `ExecStart=… \`, a comment, then
   * a line that merely LOOKS like `[Unit]` left this parser believing the section had changed, so
   * every directive after it went uncounted while systemd was still reading them as [Service].
   *
   * The recommendation was to ignore blank AND comment lines while continuing. Half of that is
   * wrong, and systemd is the authority, so it was measured rather than taken — `systemd-analyze
   * verify` on scratch units under systemd 257 (it loads a unit in a test manager and reports
   * `Unknown key 'X' in section [Service]`, which is exactly "did the section switch happen"):
   *
   *   ExecStart=… \ / '# c' / '[Unit]' / Documentation=  -> Unknown key in [Service]   CONTINUED
   *   ExecStart=… \ / '# c' / ';  c' / '[Unit]' / Doc…   -> Unknown key in [Service]   CONTINUED
   *   ExecStart=… \ / '# c' / Documentation=             -> no diagnostic              SWALLOWED
   *   ExecStart=… \ / '# c' / '--flag \' / '# c' / Doc…  -> no diagnostic              SWALLOWED
   *   ExecStart=… \ / ''    / '[Unit]' / Documentation=  -> no diagnostic              ENDED
   *   ExecStart=… \ / ''    / Documentation=             -> Unknown key in [Service]   ENDED
   *   ExecStart=… \ / '# c' / ''  / '[Unit]' / Doc…      -> no diagnostic              ENDED
   *   ExecStart=… \ / ''    / '# c' / '[Unit]' / Doc…    -> no diagnostic              ENDED
   *   (control) ExecStart=… / '[Unit]' / Documentation=   -> no diagnostic              no continuation
   *
   * So: a COMMENT line inside a continuation is skipped and does NOT end it — man systemd.syntax,
   * "When a comment line or lines follow a line ending with a backslash, the comment block is
   * ignored, so the continued line is concatenated with whatever follows the comment block". A
   * BLANK line is NOT a comment for this purpose: it is consumed as the continuation's next
   * physical line and, ending in no backslash, ends it — the man page never claims otherwise, and
   * the last four rows above are the measurement. This parser follows systemd, not the
   * recommendation.
   */
  const serviceDirectiveNames = (unitText: string): string[] => {
    const names: string[] = []
    let inService = false
    let continuing = false
    for (const raw of unitText.split('\n')) {
      const line = raw.trim()
      if (continuing) {
        // Comments inside a continuation are invisible to systemd and do not end it. A blank line
        // is not a comment here: it falls through and ends the continuation, as measured above.
        if (line.startsWith('#') || line.startsWith(';')) continue
        // A continued VALUE is not a directive, however much it looks like one — and that includes
        // a line shaped like a [Section] header, which systemd consumes as part of the value.
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

  // --- the CONTINUATION BYPASS, closed (Codex r25 MEDIUM) ---
  //
  // Systemd is still inside [Service] at the final directive of every fixture below: the comment
  // block does not end ExecStart's continuation, and the line that LOOKS like `[Unit]` is consumed
  // as part of ExecStart's value rather than switching section. Each shape was measured with
  // `systemd-analyze verify` on systemd 257 (it reports `Unknown key 'Documentation' in section
  // [Service]` exactly when the switch did NOT happen); see serviceDirectiveNames above.
  //
  // The parser that cleared `continuing` on the comment believed the section HAD switched, so it
  // reported a clean census over a region it had silently skipped — a green build guard with
  // `TemporaryFileSystem=/var/lib` sitting unexamined on top of the state directory the lock lives
  // in. Restore that behaviour and every assertion in this loop fails.
  const CONTINUATION_BYPASS = [
    // one comment line
    'ExecStart=/bin/true \\\n# not a directive\n[Unit]\nTemporaryFileSystem=/var/lib',
    // a comment BLOCK, using both of systemd's comment characters
    'ExecStart=/bin/true \\\n# one\n; two\n[Unit]\nTemporaryFileSystem=/var/lib',
    // a comment that itself ends in a backslash — still only a comment, and still skipped
    'ExecStart=/bin/true \\\n# trailing backslash \\\n[Unit]\nTemporaryFileSystem=/var/lib',
    // the value resumed after the comment and continued again, with a second comment inside
    'ExecStart=/bin/true \\\n# one\n--flag \\\n# two\n[Unit]\nTemporaryFileSystem=/var/lib',
  ]
  for (const attempt of CONTINUATION_BYPASS) {
    const censused = serviceDirectiveNames(withServiceDirective(attempt))
    assert.ok(censused.includes('TemporaryFileSystem'),
      'a directive systemd reads as [Service] must be censused: the comment did not end the '
      + `continuation and the [Unit] line is part of ExecStart's value.\n${attempt}`)
    assert.ok(!censused.includes('Unit') && !censused.includes('[Unit]'),
      'the swallowed section header is a VALUE, not a directive, and must not be counted as one')
    assert.deepEqual(censused.filter((name) => !classified(name)), ['TemporaryFileSystem'],
      'and it must FAIL the census — this is the exact directive that can put a tmpfs over '
      + `/var/lib and make the lock path a different, empty inode.\n${attempt}`)
  }

  // The other half of the rule, and it goes the OTHER way. A BLANK line is not a comment here:
  // systemd consumes it as the continuation's next physical line and, since it ends in no
  // backslash, the continuation ENDS. So the `[Unit]` after it is a real section switch, and
  // treating blank lines like comments — which is what the review recommended — would make this
  // census claim jurisdiction over directives that are genuinely outside [Service].
  const afterBlankThenHeader = serviceDirectiveNames(withServiceDirective(
    'ExecStart=/bin/true \\\n\n[Unit]\nVorpal=blade'))
  assert.ok(!afterBlankThenHeader.includes('Vorpal'),
    'the blank line ended the continuation, so [Unit] really switched section')
  assert.ok(!afterBlankThenHeader.includes('ProtectSystem'),
    'proof that the switch was real and not merely that Vorpal was skipped: everything after it, '
    + 'including the sandboxing block, is now outside [Service] for this mutated unit')

  // …and with no section header in the way, the directive after the blank line is an ordinary
  // [Service] directive, so it IS censused. (Measured: systemd reports it as an unknown [Service]
  // key, i.e. it parsed it as a directive rather than swallowing it into ExecStart.)
  const afterBlankThenDirective = serviceDirectiveNames(withServiceDirective(
    'ExecStart=/bin/true \\\n\nVorpal=blade'))
  assert.deepEqual(afterBlankThenDirective.filter((name) => !classified(name)), ['Vorpal'],
    'a blank line ends the continuation, so what follows is a directive and must be censused')

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
// These four tests drive the SHIPPED `prepare_crontab_lock`, lifted out of
// scripts/lib/crontab-lock.sh and executed by a real bash against real files. `chown` is the only step this harness cannot perform
// (it is not root); it is recorded and asserted instead, which is how these tests observe that
// every root-side ownership change is `--no-dereference`.
// ---------------------------------------------------------------------------

/**
 * The SHIPPED preparation function, lifted out of scripts/lib/crontab-lock.sh rather than retyped
 * here — so a change to it changes what these tests execute, instead of quietly leaving them
 * testing a copy. It lived in scripts/install.sh until o3d-p9dq; deploy.sh and update.sh now
 * prepare the same root-owned lock, from this same function, so the tests follow it.
 */
function installerPreparer(): string {
  const lines = CRONTAB_LOCK_LIB_SRC.split('\n')
  const start = lines.indexOf('prepare_crontab_lock() {')
  assert.notEqual(start, -1, 'scripts/lib/crontab-lock.sh must define prepare_crontab_lock()')
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

test('[o3d-batch-ret] the shared library prepares the lock with symlink-proof primitives only', () => {
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

// ---------------------------------------------------------------------------
// 17 — LOAD-BEARING: the process that contends for this lock is the one this run BUILT
//
// The exclusion above is one flock on one inode, and it excludes exactly one thing: an application
// process that locks the same inode. `systemctl enable --now` did not deliver that on the only run
// where it matters. `--now` is `start`, and `start` on a unit that is ALREADY RUNNING is a no-op;
// `daemon-reload` changes only what the NEXT start reads. So an upgrade left the pre-upgrade
// process alive on the previous bundle, previous environment and previous lock path — or no lock at
// all — and the installer then went on to take the NEW lock and rewrite the crontab beside it.
//
// r25 answered that with `enable` + `restart`. THE MERGE WITH o3d-2sm1.5 REMOVED THE RESTART AND
// KEPT THE FINDING, because the structure it merged into does not have the defect and a restart in
// it would be a regression:
//
//   • `upgrade_in_place` returns true merely on /etc/systemd/system/<unit> EXISTING, so any host
//     with a running service takes the cutover path;
//   • that path `systemctl stop`s the unit, stops the legacy launchers and REFUSES to continue
//     while ${APP_PORT} is still bound, all before the migration;
//   • so `systemctl start` acts on a stopped unit, which is what `restart` would have made it;
//   • and a `restart` here would bounce the process the health check is about to interrogate.
//
// What the installer must still not do is take the crontab lock without knowing WHICH process is
// on the port. That is now proved by fetching /_next/static/<BUILD_ID>/ — a route only the process
// whose own build id is that one serves — which is strictly stronger than r25's `systemctl
// is-active`, and answers precisely the case is-active could not: a predecessor still holding the
// port. `APP_SERVICE_ON_NEW_BUILD` carries that proof to section 16, and these tests are about
// the two halves of it — that the flag CANNOT be raised without the proof, and that the crontab
// section refuses to open the lock while it is down.
//
// The measurements that produced the original finding, on this host, systemd 257, against a
// scratch unit in /run/systemd/system, are kept because they are why the ordering below matters:
//   systemctl start   on an ACTIVE unit   -> MainPID UNCHANGED   (nothing was replaced)
//   systemctl restart on an ACTIVE unit   -> MainPID CHANGED     (the process is the new build)
//   systemctl restart on an INACTIVE unit -> exit 0, becomes active (so `--now` buys nothing)
// ---------------------------------------------------------------------------

/**
 * The shipped block that turns the build proof into permission to lock, lifted rather than
 * re-typed: `if $NEW_BUILD_SERVING; then` through its closing `fi`.
 */
function buildProofArmingBlock(): { block: string; from: number; to: number } {
  const lines = INSTALL_SH.split('\n')
  const from = lines.findIndex((l) => l === 'if $NEW_BUILD_SERVING && $APP_SERVICE_LISTENER_PROVED; then')
  assert.notEqual(from, -1,
    'scripts/install.sh must gate the point of no return on BOTH proofs: the build identity of the '
    + 'tree on the port, and the listener being this unit\'s own process (o3d-p9dq)')
  const to = lines.findIndex((l, i) => i > from && l === 'fi')
  assert.notEqual(to, -1, 'that block must be closed')
  return { block: lines.slice(from, to + 1).join('\n'), from, to }
}

test('[o3d-batch-ret] the crontab guard flag is armed ONLY by the proof that THIS build is serving', async () => {
  const lines = INSTALL_SH.split('\n')
  const { block, from, to } = buildProofArmingBlock()

  // (a) THERE IS EXACTLY ONE PLACE THAT RAISES IT, AND IT IS INSIDE THAT BLOCK. An assignment
  //     anywhere else — including one added later "for the non-upgrade path" — would hand the
  //     crontab section permission that no proof backs, which is the whole finding.
  const raises = lines
    .map((l, i) => [l, i] as [string, number])
    .filter(([l]) => /^\s*APP_SERVICE_ON_NEW_BUILD=true\s*$/.test(l))
  assert.equal(raises.length, 1,
    `exactly one line may set APP_SERVICE_ON_NEW_BUILD=true; found ${raises.length} at lines `
    + `${JSON.stringify(raises.map(([, i]) => i + 1))}`)
  assert.ok(raises[0][1] > from && raises[0][1] < to,
    `that line must be inside the $NEW_BUILD_SERVING block (${from + 1}..${to + 1}), and is at `
    + `${raises[0][1] + 1}`)
  assert.match(block, /APP_SERVICE_ON_NEW_BUILD=true/,
    'the lifted block must be the one under test')

  // (b) AND IT REALLY IS THE GATE — the shipped lines, run. Each proof is withheld in turn, and
  //     BOTH cases must leave the flag down. The second one is round 26's finding: a listener that
  //     serves the newly built tree without being the unit's process passes the asset fetch and
  //     has no $STATE_DIRECTORY, so it would resolve a different lock file entirely.
  const prelude = 'set -euo pipefail\nPAST_POINT_OF_NO_RETURN=false\nAPP_SERVICE_ON_NEW_BUILD=false\n'
  const report = '\necho "flag=${APP_SERVICE_ON_NEW_BUILD}"'
  const withheld: Array<[string, string]> = [
    ['neither proof', 'NEW_BUILD_SERVING=false\nAPP_SERVICE_LISTENER_PROVED=false'],
    ['no build proof', 'NEW_BUILD_SERVING=false\nAPP_SERVICE_LISTENER_PROVED=true'],
    ['no listener proof', 'NEW_BUILD_SERVING=true\nAPP_SERVICE_LISTENER_PROVED=false'],
  ]
  for (const [what, vars] of withheld) {
    const unproved = await sh(`${prelude}${vars}\n${block}${report}`)
    assert.equal(unproved.code, 0, unproved.stderr)
    assert.match(unproved.stdout, /flag=false/,
      `with ${what}, the crontab guard must NOT be armed — moving the assignment out of the if, or `
      + 'dropping either conjunct, would make this read true')
  }

  // (c) CONTROL. With both proofs, the same shipped lines raise it — so (b) is a gate and not a
  //     block that never assigns anything.
  const proved = await sh(
    `${prelude}NEW_BUILD_SERVING=true\nAPP_SERVICE_LISTENER_PROVED=true\n${block}${report}`)
  assert.equal(proved.code, 0, proved.stderr)
  assert.match(proved.stdout, /flag=true/)
})

test('[o3d-batch-ret] the predecessor is stopped, the new build is started, and only then is it proved', async () => {
  const lines = INSTALL_SH.split('\n')
  const at = (re: RegExp, what: string) => {
    const i = lines.findIndex((l) => re.test(l))
    assert.notEqual(i, -1, `scripts/install.sh no longer has the ${what} line`)
    return i
  }
  const build = at(/^\s*npm run build --prefix "\$\{APP_DIR\}"/, 'build')
  // The CUTOVER stop, not the several `systemctl stop` lines inside the adoption and trap
  // helpers — those are declared far above and would make this ordering read backwards. The
  // cutover site is the only one the installer ANNOUNCES, so the announcement is the anchor.
  const stop = at(/^\s*info "systemctl stop \$\{APP_NAME\}\.service"$/, 'cutover stop')
  assert.match(INSTALL_SH.split('\n')[stop + 1], /^\s*systemctl stop "\$\{APP_NAME\}\.service"/,
    'the announced cutover stop must be followed by the stop itself')
  const unit = at(/^cat > "\/etc\/systemd\/system\/\$\{APP_NAME\}\.service"/, 'unit heredoc')
  const start = at(/^systemctl start "\$\{APP_NAME\}\.service"$/, 'service start')
  const proof = at(/^\s*NEW_BUILD_SERVING=true$/, 'build proof')
  const listener = at(/^\s*APP_SERVICE_LISTENER_PROVED=true$/, 'listener proof')
  const arm = at(/^\s*APP_SERVICE_ON_NEW_BUILD=true$/, 'guard arming')
  const guard = at(/^\[\[ "\$\{APP_SERVICE_ON_NEW_BUILD:-false\}" == "true" \]\]/, 'crontab guard')
  const open = at(/^with_crontab_lock bootstrap_managed_crontab_block_locked/, 'lock acquisition')

  // AND THE CRON FENCE IS BELOW THE STOP, which is round 26's other half: fencing it above the
  // stop is a read-modify-write racing a browser-triggered reconciliation that the flock cannot
  // exclude on its first rollout, because the predecessor was built before the flock existed.
  const drained = at(/^\s*success "Nothing is serving \$\{APP_NAME\} any more\."$/, 'drain proof')
  // The CUTOVER fence, not the adoption path's — that one is declared far above and calls the same
  // function for a predecessor this run has just re-stopped.
  const cutoverFences = lines
    .map((l, i) => [l, i] as [string, number])
    .filter(([l, i]) => /^\s*fence_cron$/.test(l) && i > stop)
  assert.equal(cutoverFences.length, 1,
    'exactly one cutover fence_cron call, and it must be the one below the drain; found at '
    + JSON.stringify(cutoverFences.map(([, i]) => i + 1)))
  const fence = cutoverFences[0][1]

  // THE ORDER THE WHOLE PROTOCOL RESTS ON. The build is produced while the predecessor still
  // serves; the predecessor is then stopped and the port proved free; only then is the crontab
  // fenced; the unit is rewritten; the new process is started, PROVED to be this build and PROVED
  // to be this unit's; only then may the crontab lock be taken.
  const order = { build, stop, drained, fence, unit, start, proof, listener, arm, guard, open }
  assert.ok(build < stop && stop < drained && drained < fence && fence < unit
    && unit < start && start < proof && proof < listener && listener < arm
    && arm < guard && guard < open,
    'the order must be build -> stop -> drain -> fence-cron -> unit -> start -> build-proof -> '
    + 'listener-proof -> arm -> guard -> lock, and is ' + JSON.stringify(order))


  // AND `enable --now` IS STILL NOT HOW THE SERVICE COMES UP. Its `--now` is a `start`, which does
  // nothing to a running process — the original finding, and the reason enable and start are two
  // statements here. Comments may DISCUSS it; no command line may BE it.
  const enableNow = lines
    .map((l, i) => [l, i] as [string, number])
    .filter(([l]) => /(^|[;&|]\s*)systemctl\s+enable\s+--now\b/.test(l.replace(/^\s+/, ''))
      && !/^\s*#/.test(l))
  assert.deepEqual(enableNow, [],
    '`enable --now` must not be a command in this installer: its `--now` is a `start`, which does '
    + `nothing to an already-running process. Found at lines ${JSON.stringify(enableNow.map(([, i]) => i + 1))}`)

  // A RUN THAT CANNOT SAY WHICH BUILD ANSWERED DOES NOT REACH ANY OF THIS. The else branch of the
  // build proof dies, so there is no path from "something answered the port" to the crontab lock.
  const proofElse = lines.slice(build, guard).find((l) => /^\s*die "Something answered /.test(l))
  assert.ok(proofElse,
    'an unproved build must die between the health check and the crontab section, not warn')
  assert.match(proofElse!, /predecessor still holding port/,
    'and the message must name the case the proof exists for')
})

test('[o3d-batch-ret] the crontab section REFUSES to take the lock unless the build proof passed', async () => {
  const lines = INSTALL_SH.split('\n')
  const guardLine = lines.findIndex(
    (l) => /^\[\[ "\$\{APP_SERVICE_ON_NEW_BUILD:-false\}" == "true" \]\]/.test(l))
  assert.notEqual(guardLine, -1, 'scripts/install.sh no longer has the crontab ordering guard')

  // The guard is not decoration: run the SHIPPED line with the flag as an unproved run would leave
  // it, and it must refuse.
  const guard = lines[guardLine] + '\n' + lines[guardLine + 1]
  const prelude = 'set -euo pipefail\ndie() { echo "DIE: $*" >&2; exit 9; }\n'
  const refused = await sh(`${prelude}APP_SERVICE_ON_NEW_BUILD=false\n${guard}\necho REACHED-THE-LOCK`)
  assert.equal(refused.code, 9, `an unproved run must not reach the lock: ${refused.stderr}`)
  assert.doesNotMatch(refused.stdout, /REACHED-THE-LOCK/)
  assert.match(refused.stderr, /ordering bug in the installer itself/,
    'and it must say this is an installer ordering bug, not something an operator did')
  assert.match(refused.stderr, /crontab lock/,
    'the message must say what the refusal is protecting')

  // AND AN UNSET FLAG REFUSES TOO, not just a false one. Deleting the declaration is the likeliest
  // way this comes undone, and `set -u` would abort on a bare expansion — the `:-false` default is
  // what makes the refusal happen with a message instead.
  const unset = await sh(`${prelude}${guard}\necho REACHED-THE-LOCK`)
  assert.equal(unset.code, 9, unset.stderr)
  assert.match(unset.stderr, /APP_SERVICE_ON_NEW_BUILD='unset'/,
    'the refusal must report the flag as unset, so the default is doing the refusing')

  // CONTROL — with the flag raised, the same line falls through. Without this the refusal above
  // could be a broken line rather than a guard.
  const allowed = await sh(`${prelude}APP_SERVICE_ON_NEW_BUILD=true\n${guard}\necho REACHED-THE-LOCK`)
  assert.equal(allowed.code, 0, allowed.stderr)
  assert.match(allowed.stdout, /REACHED-THE-LOCK/)
})
