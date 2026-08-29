import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
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
  # $OTI_TEST_CRONTAB_READ puts the READ into the states a real crontab reaches, unset meaning the
  # ordinary one so every test written before this knob behaves exactly as it did. The diagnostics
  # are the ones scripts/lib/crontab-lock.sh documents from Debian's Vixie cron, and \`absent\`
  # names the CALLING user because that is the user the application's own \`crontab -l\` asks about.
  case "\${OTI_TEST_CRONTAB_READ:-ok}" in
    ok)      if [ -f '${CRONTAB_FILE}' ]; then cat '${CRONTAB_FILE}'; fi; exit 0 ;;
    absent)  echo "no crontab for $(id -un)" >&2; exit 1 ;;
    denied)  echo "must be privileged to use -u" >&2; exit 1 ;;
    silent)  exit 1 ;;
    *)       echo "unmodelled read mode" >&2; exit 1 ;;
  esac
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
  exempt: string[] = [],
): string[] {
  const sources = new Map(files)
  const bad = new Set<string>()
  for (const site of sites) {
    const raw = sources.get(site.file) ?? readFileSync(join(REPO_ROOT, site.file), 'utf8')
    const src = raw.split('\n')
    const fn = enclosingFunctionInSource(src, site.line)
    const scope = `${site.file}:${fn}`
    if (exempt.includes(scope)) continue
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
  // ONE EXEMPTION, NAMED HERE AND PAID FOR IMMEDIATELY BELOW (o3d-p9dq, Codex r28).
  // scripts/lib/crontab-lock.sh:read_crontab_for is the shared READER all three entrypoints now go
  // through instead of `crontab -u … -l 2>/dev/null || true`. It is not a read-modify-write — it
  // never writes — and the bodies that do the modify-and-write half call it from inside their own
  // hold. An exemption is a hole unless both of those are asserted, so both are.
  const SHARED_READER = 'scripts/lib/crontab-lock.sh:read_crontab_for'
  const unlocked = unlockedCrontabScopesIn(SHELL_ENTRYPOINTS, shellCrontab, [SHARED_READER])
  assert.deepEqual(unlocked, [],
    'every shell crontab read-modify-write must sit in a `*_locked` body whose only caller is '
    + 'with_crontab_lock. These are not: ' + JSON.stringify(unlocked))

  // (i) the exempted body READS and does nothing else — one `crontab` invocation, and it is `-l`.
  const readerBody = shellFunctionFrom(CRONTAB_LOCK_LIB_SRC, 'read_crontab_for', 'scripts/lib/crontab-lock.sh')
  const readerCalls = readerBody.split('\n').filter((l) => /(^\s*|[|;&({]\s*)crontab\b/.test(l))
  assert.equal(readerCalls.length, 1,
    `the shared reader must invoke crontab exactly once: ${JSON.stringify(readerCalls)}`)
  assert.match(readerCalls[0], /crontab -u "\$\{user\}" -l /,
    'and that invocation must be a READ — a write here would be an unlocked write in a shared library')
  assert.ok(shellCrontab.some((site) => site.file === 'scripts/lib/crontab-lock.sh'),
    'not vacuous: the walk really did reach the shared reader, which is why it needs the exemption')

  // (ii) and every entrypoint that calls it, except the one pure QUERY, does so under the lock.
  const readerScopes = new Set<string>()
  for (const [name, src] of SHELL_ENTRYPOINTS) {
    const lines = src.split('\n')
    lines.forEach((line, index) => {
      if (!/^\s*read_crontab_for /.test(line)) return
      readerScopes.add(`${name}:${enclosingFunctionInSource(lines, index + 1)}`)
    })
  }
  assert.ok(readerScopes.size >= 5,
    `the entrypoints must actually call the shared reader (found ${readerScopes.size} scopes)`)
  assert.deepEqual([...readerScopes].filter((scope) => !scope.endsWith('_locked')).sort(),
    ['scripts/install.sh:upgrade_in_place'],
    'the only crontab read outside a `*_locked` body is the installer asking whether there is an '
    + 'installation here at all — it modifies nothing, and it now refuses rather than guessing')

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
  // `adopt_cron_fence_locked` no longer invokes `crontab` itself: it READS through the shared
  // reader and delegates the re-fence to fence_cron (o3d-p9dq, Codex r28). So the census asks what
  // is still true of it — it is a `*_locked` body, with_crontab_lock is its only caller, and the
  // read it makes is the shared one rather than a private `2>/dev/null || true`.
  for (const file of ['scripts/deploy.sh', 'scripts/update.sh']) {
    const src = new Map(SHELL_ENTRYPOINTS).get(file)!
    const body = shellFunctionFrom(src, 'adopt_cron_fence_locked', file)
    assert.match(body, /^\s*read_crontab_for /m,
      `${file}: the adopted fence must establish what is in the crontab through the shared reader`)
    assert.doesNotMatch(body, /2>\/dev\/null \|\| true/,
      `${file}: and not by suppressing the read's own failure`)
    const references = src.split('\n').filter((l) => !l.trimStart().startsWith('#')
      && /(^|[^A-Za-z0-9_])adopt_cron_fence_locked([^A-Za-z0-9_]|$)/.test(l)
      && !/^adopt_cron_fence_locked\(\) \{/.test(l))
    assert.ok(references.length > 0, `${file}: adopt_cron_fence_locked must be called`)
    assert.ok(references.every((l) => /^\s*with_crontab_lock adopt_cron_fence_locked/.test(l)),
      `${file}: with_crontab_lock must be its only caller — ${JSON.stringify(references)}`)
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
  // Thirteen, not the fifteen of round 27: the installer's bootstrap used to read the crontab
  // TWICE with the failure suppressed, and both readings are now one call to the shared reader.
  assert.ok(clean.length >= 12, `the control must reach the real sites (found ${clean.length})`)
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

// ---------------------------------------------------------------------------
// 15 — LOAD-BEARING: a reconciliation committing between a cutover SNAPSHOT and its
//      RESTORE is not lost
//
// This is Codex r26's HIGH stated as an experiment rather than as an argument. The cutover reads
// the crontab, backs the reading up verbatim, writes a commented-out copy over it, and much later
// restores the backup. If an application reconciliation can commit ANYWHERE in that window, its
// block is inside a crontab the cutover is about to overwrite and outside the backup the cutover
// will restore: the settings rows and the UI go on saying the job is enabled and nothing is
// scheduled to run it, with no error anywhere.
//
// The window is opened FOR REAL here: a `crontab` shim parks the cutover's write between the
// snapshot and the replacement, and the application is asked to save a schedule at exactly that
// instant. Both directions are run — the shipped `fence_cron`, which must refuse the application;
// and `fence_cron_locked` invoked directly, which is the body WITHOUT the lock and is precisely
// what all fourteen of round 25's exceptions were. The second is the mutation route for the first,
// and it is executed rather than described.
// ---------------------------------------------------------------------------

/** A shell function lifted out of a shipped script by name, so the tests run what ships. */
function shellFunctionFrom(src: string, name: string, where: string): string {
  const lines = src.split('\n')
  const start = lines.indexOf(`${name}() {`)
  assert.notEqual(start, -1, `${where} must define ${name}()`)
  const end = lines.indexOf('}', start)
  assert.ok(end > start, `${name}() must be closed by a \`}\` on its own line`)
  return lines.slice(start, end + 1).join('\n')
}

const CUTOVER_DIR = join(HARNESS, 'cutover')
const CUTOVER_BIN = join(HARNESS, 'cutover-bin')
const CUTOVER_BACKUP = join(CUTOVER_DIR, 'crontab-appuser.bak')
mkdirSync(CUTOVER_DIR, { recursive: true })
mkdirSync(CUTOVER_BIN, { recursive: true })

// The entrypoints call `crontab -u <user> …`, which the application never does, so they get their
// own shim — writing the SAME crontab file, journal and gate as the application's, because the
// whole point is that the two writers are contending for one artefact.
writeFileSync(join(CUTOVER_BIN, 'crontab'), `#!/bin/sh
if [ "$1" = "-u" ]; then shift 2; fi
if [ "$1" = "-l" ]; then
  if [ -f '${CRONTAB_FILE}' ]; then cat '${CRONTAB_FILE}'; fi
  exit 0
fi
src="$1"
if [ -f '${WRITE_GATE}' ]; then
  rm -f '${WRITE_GATE}'
  echo parked > '${READY_FIFO}'
  head -n 1 '${GO_FIFO}' > /dev/null
fi
if [ "$src" = "-" ]; then cat > '${CRONTAB_FILE}'; else cat "$src" > '${CRONTAB_FILE}'; fi
`)
chmodSync(join(CUTOVER_BIN, 'crontab'), 0o755)

/**
 * A bash program built out of the SHIPPED entrypoint's own functions.
 *
 * `extraFunctions` lifts further bodies by name; `mutate` is applied to the assembled prelude, and
 * is how the tests below run a body with one line changed back to what it was before a fix — the
 * route, executed, rather than a description of it.
 */
function cutoverProgram(
  body: string,
  opts: { extraFunctions?: string[]; mutate?: (src: string) => string } = {},
): string {
  const program = [
    'set -uo pipefail',
    `PATH='${CUTOVER_BIN}':"$PATH"`,
    'IMS_CRONTAB_LOCK_WAIT_SECONDS=30',
    `source '${CRONTAB_LOCK_LIB}'`,
    `CRONTAB_LOCK_DIR='${dirname(LOCK_FILE)}'`,
    `CRONTAB_LOCK_FILE='${LOCK_FILE}'`,
    'APP_USER=appuser',
    `DATA_DIR='${CUTOVER_DIR}'`,
    `CRON_BACKUP='${CUTOVER_BACKUP}'`,
    'CRON_FENCED=false',
    'CRON_BACKUP_CREATED=false',
    'info(){ :; }; success(){ :; }; warn(){ :; }',
    'die(){ echo "DIE: $*" >&2; exit 9; }',
    shellFunctionFrom(INSTALL_SH, 'fsync_path', 'scripts/install.sh'),
    shellFunctionFrom(INSTALL_SH, 'publish_cron_backup', 'scripts/install.sh'),
    shellFunctionFrom(INSTALL_SH, 'fence_cron_locked', 'scripts/install.sh'),
    shellFunctionFrom(INSTALL_SH, 'fence_cron', 'scripts/install.sh'),
    shellFunctionFrom(INSTALL_SH, 'unfence_cron_locked', 'scripts/install.sh'),
    shellFunctionFrom(INSTALL_SH, 'unfence_cron', 'scripts/install.sh'),
    ...(opts.extraFunctions ?? []).map((name) => shellFunctionFrom(INSTALL_SH, name, 'scripts/install.sh')),
  ].join('\n')
  const prelude = opts.mutate ? opts.mutate(program) : program
  assert.notEqual(prelude, opts.mutate ? program : null,
    'a mutation that changes nothing would make the control it is a control for vacuous')
  return `${prelude}\n${body}`
}

const CUTOVER_ORIGINAL = '# an operator line the cutover must put back\n*/5 * * * * /usr/bin/true\n'

/**
 * Run the cutover's fence with its write PARKED between the snapshot and the replacement, and ask
 * the application to commit a schedule change while it is parked.
 */
async function reconcileInsideTheCutoverWindow(fenceCall: string) {
  writeFileSync(CRONTAB_FILE, CUTOVER_ORIGINAL)
  rmSync(CUTOVER_BACKUP, { force: true })
  writeFileSync(WRITE_GATE, '')

  const fence = spawn('bash', ['-c', cutoverProgram(fenceCall)], { stdio: ['ignore', 'pipe', 'pipe'] })
  let fenceErr = ''
  fence.stderr.on('data', (c) => { fenceErr += String(c) })
  fence.stdout.on('data', () => {})
  await awaitFifo(READY_FIFO)

  // THE WINDOW. The snapshot has been taken and backed up; the replacement has not landed.
  process.env.OTI_CRONTAB_LOCK_WAIT_MS = '100'
  const saved = await saveBackup(true)
  delete process.env.OTI_CRONTAB_LOCK_WAIT_MS
  const crontabDuringWindow = crontabText()

  await writeFile(GO_FIFO, 'go\n')
  const fenceCode: number | null = await new Promise((resolve) => fence.on('exit', resolve))

  const restore = await sh(cutoverProgram('CRON_FENCED=true\nunfence_cron'))
  return { saved, crontabDuringWindow, fenceCode, fenceErr, restore, final: crontabText() }
}

test('[o3d-batch-ret] a reconciliation cannot commit between a cutover SNAPSHOT and its RESTORE', async () => {
  const run = await reconcileInsideTheCutoverWindow('fence_cron')

  assert.equal(run.fenceCode, 0, `the shipped fence must complete:\n${run.fenceErr}`)

  // THE PROPERTY. The application was asked to save inside the window and was REFUSED — it did not
  // even snapshot the settings, so there is no committed schedule for the restore to discard.
  assert.equal(run.saved.status, 'post-commit-failed',
    `a save inside the cutover window must be refused, and it returned ${JSON.stringify(run.saved)}`)
  assert.equal(run.saved.status === 'post-commit-failed' && run.saved.step, 'scheduler')
  assert.match(run.saved.status === 'post-commit-failed' ? run.saved.error : '',
    /Another crontab reconciliation is still running/)
  assert.equal(snapshots.length, 0,
    'the reconciliation must not even read the settings while the cutover holds the lock')
  assert.equal(run.crontabDuringWindow, CUTOVER_ORIGINAL,
    'and nothing may have been written into the crontab inside the window')

  // The fence really did happen — this is not a run in which nothing was exercised.
  assert.equal(run.restore.code, 0, `the restore must complete:\n${run.restore.stderr}`)
  assert.equal(run.final, CUTOVER_ORIGINAL,
    'and the restore puts back exactly what the snapshot read, byte for byte')
  assert.equal(backupLineInstalled(), false,
    'the refused save left no block; the crontab and the settings agree because the save FAILED')
})

test('[o3d-batch-ret] MUTATION: without the lock, the same window loses the reconciliation silently', async () => {
  // THE ROUTE, RUN. `fence_cron_locked` is the shipped body with the acquisition removed — exactly
  // the shape every one of round 25's fourteen exceptions had, and exactly what deploy.sh and
  // update.sh did until o3d-p9dq. If this test ever starts reporting the same outcome as the one
  // above, the lock has stopped excluding anything and the test above has gone vacuous.
  const run = await reconcileInsideTheCutoverWindow('fence_cron_locked')

  assert.equal(run.fenceCode, 0, `the unlocked body must complete too:\n${run.fenceErr}`)

  // The application is NOT refused: it takes the lock nobody is holding, commits, and writes its
  // block into the crontab the cutover has already snapshotted.
  assert.deepEqual(run.saved, { status: 'saved' },
    'without the lock the save succeeds — that is the whole defect: it reports success')
  assert.match(run.crontabDuringWindow, /\$BASE_URL\/backup"/,
    'and its block really did reach the crontab inside the window')

  // …and then the cutover's replacement overwrites it, and the restore puts back a snapshot taken
  // BEFORE it. The row says enabled. Nothing is scheduled. Nothing reported an error.
  assert.equal(run.restore.code, 0, `the restore must complete:\n${run.restore.stderr}`)
  assert.equal(run.final, CUTOVER_ORIGINAL)
  assert.equal(backupLineInstalled(), false,
    'THE LOST UPDATE: the save returned `saved`, and the schedule it committed is not in the crontab')
})

// ---------------------------------------------------------------------------
// 16 — LOAD-BEARING: a listener that serves the new build but is NOT the unit's process
//      does not arm the crontab guard
//
// Codex r26's second HIGH. The asset fetch proves the tree; it cannot prove the process. A
// same-build process launched straight out of the app directory after the port was drained wins
// the bind while `systemctl start` returns for a unit that then fails to bind — and, not being the
// unit's child, it has no $STATE_DIRECTORY, so lib/crontab-reconcile-lock.ts resolves its lock
// under `process.cwd()` instead. The installer would then hold an exclusive lock on one inode
// while the application held one on another.
//
// The shipped `prove_listener_belongs_to_unit` is executed against REAL processes and REAL /proc
// entries; only `systemctl` and `ss` are doubled, because they are the two answers this host
// cannot be made to give on demand.
// ---------------------------------------------------------------------------

const PROOF_BIN = join(HARNESS, 'proof-bin')
const PROOF_STATE = join(HARNESS, 'proof-state')
mkdirSync(PROOF_BIN, { recursive: true })
mkdirSync(join(PROOF_STATE, 'locks'), { recursive: true })

writeFileSync(join(PROOF_BIN, 'systemctl'), `#!/bin/sh
if [ "$1" = "is-active" ]; then exit "\${FAKE_IS_ACTIVE:-0}"; fi
if [ "$1" = "show" ]; then
  case "$*" in
    *MainPID*) printf '%s\\n' "\${FAKE_MAIN_PID}" ;;
    *ControlGroup*) printf '%s\\n' "\${FAKE_CGROUP}" ;;
  esac
  exit 0
fi
exit 0
`)
writeFileSync(join(PROOF_BIN, 'ss'), `#!/bin/sh
if [ -n "\${FAKE_LISTENER_PID}" ]; then
  printf 'LISTEN 0 511 *:%s *:* users:(("node",pid=%s,fd=21))\\n' "\${FAKE_PORT}" "\${FAKE_LISTENER_PID}"
fi
# A second row on the same port that \`ss\` could not attribute to any pid — what a socket held by
# a process this reader cannot see looks like, and what SO_REUSEPORT makes dangerous.
if [ -n "\${FAKE_UNATTRIBUTED_ROW}" ]; then
  printf 'LISTEN 0 511 *:%s *:*\\n' "\${FAKE_PORT}"
fi
`)
chmodSync(join(PROOF_BIN, 'systemctl'), 0o755)
chmodSync(join(PROOF_BIN, 'ss'), 0o755)

function listenerProofProgram(): string {
  return [
    'set -uo pipefail',
    `PATH='${PROOF_BIN}':"$PATH"`,
    'APP_NAME=app',
    'APP_PORT="${FAKE_PORT}"',
    `DATA_DIR='${PROOF_STATE}'`,
    `CRONTAB_LOCK_FILE='${join(PROOF_STATE, 'locks', '.crontab-reconcile.lock')}'`,
    shellFunctionFrom(INSTALL_SH, 'process_is_in_cgroup', 'scripts/install.sh'),
    shellFunctionFrom(INSTALL_SH, 'effective_state_directory', 'scripts/install.sh'),
    shellFunctionFrom(INSTALL_SH, 'prove_listener_belongs_to_unit', 'scripts/install.sh'),
    'if prove_listener_belongs_to_unit; then',
    '  echo "PROVEN=${LISTENER_PIDS}"',
    'else',
    '  echo "UNPROVEN=${LISTENER_PROOF_REASON}"',
    'fi',
  ].join('\n')
}

function runListenerProof(env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const assignments = Object.entries(env)
    .map(([k, v]) => `${k}='${v}'`)
    .join('\n')
  return sh(`${assignments}\nexport ${Object.keys(env).join(' ')}\n${listenerProofProgram()}`)
}

function cgroupOf(pid: number): string {
  const line = readFileSync(`/proc/${pid}/cgroup`, 'utf8').split('\n').filter(Boolean)[0]
  return line.split(':').slice(2).join(':')
}

test('[o3d-batch-ret] a listener serving the new build that is NOT the unit\'s process is refused', async () => {
  const ownCgroup = cgroupOf(process.pid)
  const initCgroup = cgroupOf(1)
  assert.notEqual(ownCgroup, initCgroup,
    'precondition: this process and pid 1 must be in different control groups, or the impostor '
    + 'case below cannot be constructed')

  const spawnListener = (stateDirectory?: string) => {
    const env: NodeJS.ProcessEnv = { ...process.env }
    if (stateDirectory === undefined) delete env.STATE_DIRECTORY
    else env.STATE_DIRECTORY = stateDirectory
    return spawn('sleep', ['120'], { env, stdio: ['ignore', 'ignore', 'ignore'] })
  }

  const impostor = spawnListener(undefined)
  const insider = spawnListener(`${PROOF_STATE}:/var/lib/something-else`)
  const wrongState = spawnListener('/var/lib/somewhere-else')
  const noState = spawnListener(undefined)
  try {
    const base = { FAKE_PORT: '3000' }

    // (a) THE FINDING ITSELF. The unit is active with a MainPID inside its own control group, and
    //     the process on the port is a real one that is NOT in that control group.
    const outsider = await runListenerProof({
      ...base, FAKE_MAIN_PID: '1', FAKE_CGROUP: initCgroup, FAKE_LISTENER_PID: String(impostor.pid),
    })
    assert.match(outsider.stdout, /^UNPROVEN=/m,
      `a listener outside the unit's control group must not be proved:\n${outsider.stdout}`)
    assert.match(outsider.stdout, /is NOT in app\.service's control group/,
      'and the refusal must say which property failed')

    // (b) IN THE CONTROL GROUP, BUT WITH NO STATE_DIRECTORY. This is the case that decides the
    //     lock path: without it the application joins `process.cwd()/locks/…`, a different inode.
    const stateless = await runListenerProof({
      ...base, FAKE_MAIN_PID: String(noState.pid), FAKE_CGROUP: ownCgroup, FAKE_LISTENER_PID: String(noState.pid),
    })
    assert.match(stateless.stdout, /^UNPROVEN=/m, stateless.stdout)
    assert.match(stateless.stdout, /NO STATE_DIRECTORY in its environment/,
      'and it must name the reason the lock would be a different file')

    // (c) A STATE_DIRECTORY THAT IS NOT THIS ONE.
    const elsewhere = await runListenerProof({
      ...base, FAKE_MAIN_PID: String(wrongState.pid), FAKE_CGROUP: ownCgroup, FAKE_LISTENER_PID: String(wrongState.pid),
    })
    assert.match(elsewhere.stdout, /^UNPROVEN=/m, elsewhere.stdout)
    assert.match(elsewhere.stdout, /STATE_DIRECTORY='\/var\/lib\/somewhere-else'/, elsewhere.stdout)

    // (d) THE UNIT IS NOT ACTIVE, whatever is on the port.
    const inactive = await runListenerProof({
      ...base, FAKE_IS_ACTIVE: '3', FAKE_MAIN_PID: String(insider.pid), FAKE_CGROUP: ownCgroup,
      FAKE_LISTENER_PID: String(insider.pid),
    })
    assert.match(inactive.stdout, /does not report app\.service active/, inactive.stdout)

    // (e) ONE ATTRIBUTED ROW BESIDE ONE `ss` COULD NOT ATTRIBUTE. Taking the pids that were named
    //     and ignoring the rest answers a different question from "which process did the fetch
    //     reach" — with SO_REUSEPORT the kernel may hand the connection to the socket this run
    //     cannot name. update.sh's prove_service_owns_port already refuses on exactly this.
    const mixed = await runListenerProof({
      ...base, FAKE_MAIN_PID: String(insider.pid), FAKE_CGROUP: ownCgroup,
      FAKE_LISTENER_PID: String(insider.pid), FAKE_UNATTRIBUTED_ROW: '1',
    })
    assert.match(mixed.stdout, /^UNPROVEN=/m,
      `one attributed listener beside one unattributable one is not a proof:\n${mixed.stdout}`)
    assert.match(mixed.stdout, /shows 2 listening socket\(s\) on :3000 and attributes 1 of them to no pid at all/,
      'and it must count the ROWS, not the pids it happened to read')

    // (f) NOTHING HOLDS THE PORT — `systemctl start` returned but nothing bound.
    const nobody = await runListenerProof({
      ...base, FAKE_MAIN_PID: String(insider.pid), FAKE_CGROUP: ownCgroup, FAKE_LISTENER_PID: '',
    })
    assert.match(nobody.stdout, /reports no listening socket on :3000 at all/,
      `nothing listening is its own answer, distinct from a row nobody owns:\n${nobody.stdout}`)

    // (g) CONTROL. The unit's own process, in its control group, with this run's state directory
    //     first in a colon-separated $STATE_DIRECTORY — which is what systemd hands a unit with
    //     several StateDirectory= entries, and what lib/crontab-reconcile-lock.ts takes the first
    //     of. Without this the five refusals above could be a proof that refuses everything.
    const proven = await runListenerProof({
      ...base, FAKE_MAIN_PID: String(insider.pid), FAKE_CGROUP: ownCgroup, FAKE_LISTENER_PID: String(insider.pid),
    })
    assert.match(proven.stdout, new RegExp(`^PROVEN=${insider.pid}$`, 'm'),
      `the unit's own listener must be proved:\n${proven.stdout}${proven.stderr}`)
  } finally {
    for (const child of [impostor, insider, wrongState, noState]) child.kill('SIGKILL')
  }
})

test('[o3d-batch-ret] an UNREADABLE /proc/<pid>/environ is proof not established, not proof', async () => {
  // The clause that closes the loop is a read of another process's environment, so what happens
  // when it cannot be read has to be an answer rather than an omission. Constructed for real: pid 1
  // is root's, its /proc/<pid>/cgroup is world-readable and its /proc/<pid>/environ is not — so the
  // control-group half passes and the STATE_DIRECTORY half cannot be asked.
  assert.notEqual(process.getuid?.(), 0,
    'this case models a process this run cannot read the environment of, which does not apply to '
    + 'root — run the unit tests as an unprivileged user')

  const result = await runListenerProof({
    FAKE_PORT: '3000', FAKE_MAIN_PID: '1', FAKE_CGROUP: cgroupOf(1), FAKE_LISTENER_PID: '1',
  })
  assert.match(result.stdout, /^UNPROVEN=/m,
    `an environment that cannot be read must not be treated as a pass:\n${result.stdout}`)
  assert.match(result.stdout, /\/proc\/1\/environ could not be read/, result.stdout)
  assert.match(result.stdout, /hidepid/, 'and it must say what the two realistic causes are')
})

// ---------------------------------------------------------------------------
// 17 — the one documented path through with_crontab_lock that does not hold the lock
//
// `--dry-run` is the exemption, and it is in the library rather than at any call site. Two claims
// are made for it and both are run here: a dry run needs neither root nor a prepared lock file, and
// no crontab WRITE is reachable under it. The control is the same program with the bypass down —
// which refuses, naming the missing lock, and is what makes the first half a bypass and not a
// program that would have worked anyway.
// ---------------------------------------------------------------------------

test('[o3d-batch-ret] --dry-run needs no lock file and writes no crontab', async () => {
  const dryDir = join(HARNESS, 'dry-run')
  const dryBin = join(dryDir, 'bin')
  const dryLog = join(dryDir, 'calls.log')
  mkdirSync(dryBin, { recursive: true })
  rmSync(dryLog, { force: true })
  writeFileSync(join(dryBin, 'crontab'), `#!/bin/sh
echo "crontab $*" >> '${dryLog}'
for a in "$@"; do last="$a"; done
if [ "$last" = "-l" ]; then echo '*/5 * * * * /usr/bin/true'; fi
exit 0
`)
  chmodSync(join(dryBin, 'crontab'), 0o755)

  // NO crontab_lock_paths call and NO lock file anywhere: that is the point.
  const program = [
    'set -uo pipefail',
    `PATH='${dryBin}':"$PATH"`,
    `source '${CRONTAB_LOCK_LIB}'`,
    'DRY_RUN=true',
    'CRONTAB_LOCK_DRY_RUN=true',
    'APP_USER=appuser',
    `CRON_BACKUP='${join(dryDir, 'no-such-backup')}'`,
    'CRON_FENCED=false',
    'CRON_BACKUP_CREATED=false',
    "YELLOW=''; RESET=''",
    'info(){ :; }; ok(){ :; }; warn(){ :; }',
    'die(){ echo "DIE: $*" >&2; exit 9; }',
    shellFunctionFrom(DEPLOY_SH, 'fence_cron_locked', 'scripts/deploy.sh'),
    shellFunctionFrom(DEPLOY_SH, 'fence_cron', 'scripts/deploy.sh'),
    shellFunctionFrom(DEPLOY_SH, 'unfence_cron_locked', 'scripts/deploy.sh'),
    shellFunctionFrom(DEPLOY_SH, 'unfence_cron', 'scripts/deploy.sh'),
    'fence_cron',
    'unfence_cron',
    'echo "CRON_FENCED=${CRON_FENCED}"',
  ].join('\n')

  const dry = await sh(program)
  assert.equal(dry.code, 0, `a dry run must complete with no lock file at all:\n${dry.stderr}`)
  assert.match(dry.stdout, /CRON_FENCED=true/, 'and it must still report what it would have fenced')

  const calls = existsSync(dryLog) ? readFileSync(dryLog, 'utf8') : ''
  assert.match(calls, /^crontab -u appuser -l$/m,
    'precondition: the dry run really did READ the crontab, so this is not a program that ran nothing')
  assert.deepEqual(
    calls.split('\n').filter(Boolean).filter((line) => !/^crontab -u appuser -l$/.test(line)),
    [],
    'a dry run must never write the crontab — every recorded invocation must be the read',
  )

  // CONTROL. The same program with the bypass down refuses, and names what is missing. Without
  // this the run above could be a program that never needed the lock in the first place.
  const strict = await sh(program.replace('CRONTAB_LOCK_DRY_RUN=true', 'CRONTAB_LOCK_DRY_RUN=false'))
  assert.equal(strict.code, 9, `with the bypass down the same program must refuse:\n${strict.stdout}`)
  assert.match(strict.stderr, /before CRONTAB_LOCK_FILE was composed/,
    'and say that the entrypoint never composed a lock path, which is an ordering bug and not an operator error')
})

// ---------------------------------------------------------------------------
// 20 — LOAD-BEARING: a schedule saved between the service becoming REACHABLE and the
//      unfence completing SURVIVES the unfence
//
// Codex r27's first HIGH, and the reason it is NOT a repeat of section 15. There the lock was
// missing and two writers interleaved; here the lock is present and working. The new service
// accepted traffic sections ago, the operator saves a schedule, the application takes the SAME
// flock, writes the block it projected from the committed settings rows, releases and reports
// success — every one of those steps correct. The cutover then takes the lock in ITS turn and
// installs the snapshot it took before the stop. Perfectly ordered. The row says enabled, nothing
// is scheduled, and no error was raised anywhere.
//
// Exclusion establishes ORDER; it does not establish which content is TRUE. So the property under
// test is not "the two did not overlap" — they did not, and it did not help — but "the write that
// survives is the one the database backs".
//
// Route: backup-schedule.tsx -> saveBackupScheduleSettings -> reconcileCrontab, racing the shipped
// unfence_cron out of scripts/install.sh. Both writers drive REAL `crontab` executables over one
// real file, and the save is a real commit into the settings store.
// ---------------------------------------------------------------------------

/**
 * The shipped unfence with its plan replaced by "install the snapshot" — the body as it stood
 * before this round, expressed as a one-line edit to the shipped source so that a change to that
 * line breaks the mutation rather than letting it drift into testing nothing.
 */
const blindRestoreMutation = (src: string): string => {
  const before = 'plan_crontab_unfence "${backup}" "${current}" || return "${CRONTAB_UNFENCE_DIVERGED}"'
  assert.ok(src.includes(before), 'scripts/install.sh must plan the unfence on one line')
  return src.replace(before, 'CRON_UNFENCE_PLAN=snapshot; CRON_UNFENCE_TEXT="${backup}"')
}

async function saveInsideTheUnfenceWindow(mutate?: (src: string) => string) {
  writeFileSync(CRONTAB_FILE, CUTOVER_ORIGINAL)
  rmSync(CUTOVER_BACKUP, { force: true })

  // The cutover fences, post-stop, exactly as it ships. Nothing is parked: this window is not a
  // race inside one read-modify-write, it is the ordinary gap between two of them.
  const fenced = await sh(cutoverProgram('fence_cron'))
  assert.equal(fenced.code, 0, `the shipped fence must complete:\n${fenced.stderr}`)

  // THE WINDOW. Migration done, new build serving, unfence not yet reached. The lock is free, so
  // the application is NOT refused — it commits and writes, as it would on any ordinary day.
  const saved = await saveBackup(true)
  const installedInWindow = backupLineInstalled()

  const restore = await sh(cutoverProgram(
    'CRON_FENCED=true\nunfence_cron\necho "PLAN=${CRON_UNFENCE_PLAN}"', { mutate }))
  return { saved, installedInWindow, restore, final: crontabText() }
}

test('[o3d-batch-ret] a schedule saved after the service is reachable SURVIVES the unfence', async () => {
  const run = await saveInsideTheUnfenceWindow()

  // Not vacuous: the save really did commit and its block really did reach the crontab while the
  // fence was up. If either of these stopped being true the assertion below would pass for the
  // wrong reason.
  assert.deepEqual(run.saved, { status: 'saved' },
    'the lock is free in this window, so the save must succeed — that is the premise of the defect')
  assert.equal(run.installedInWindow, true,
    'and its managed block must actually be in the crontab before the unfence runs')

  assert.equal(run.restore.code, 0, `the unfence must complete:\n${run.restore.stderr}`)
  assert.match(run.restore.stdout, /PLAN=merge/,
    'the live crontab is not the fence projection of the backup, so the snapshot route must not be taken')

  // THE PROPERTY. The schedule the operator was told was saved is still scheduled.
  assert.equal(backupLineInstalled(), true,
    'THE COMMITTED SAVE SURVIVES: a snapshot taken before the cutover must not overwrite it')

  // …and the merge is not "keep the new, lose the old": the operator's own line is back, and back
  // ACTIVE. The crontab holds no other record of it, so losing it would be the same defect facing
  // the other way.
  assert.match(run.final, /^\*\/5 \* \* \* \* \/usr\/bin\/true$/m,
    'the operator line must be un-fenced, not left commented out')
  assert.match(run.final, /^# an operator line the cutover must put back$/m)
  assert.doesNotMatch(run.final, /#DEPLOY-FENCE#/,
    'no fence mark may survive the unfence')
})

test('[o3d-batch-ret] MUTATION: a blind restore of the snapshot discards that save silently', async () => {
  // THE ROUTE, RUN. One line of the shipped body reverted to "install the backup", which is what
  // it did before this round and what deploy.sh and update.sh did at the same site. If this test
  // ever reports the same outcome as the one above, the plan has stopped deciding anything.
  const run = await saveInsideTheUnfenceWindow(blindRestoreMutation)

  assert.deepEqual(run.saved, { status: 'saved' })
  assert.equal(run.installedInWindow, true)
  assert.equal(run.restore.code, 0, `the blind restore must complete:\n${run.restore.stderr}`)
  assert.match(run.restore.stdout, /PLAN=snapshot/)

  assert.equal(backupLineInstalled(), false,
    'THE LOST UPDATE: the save returned `saved`, and the schedule it committed is not in the crontab')
  assert.equal(run.final, CUTOVER_ORIGINAL,
    'the pre-cutover snapshot went back verbatim, over a later, correct write')
})

// ---------------------------------------------------------------------------
// 21 — LOAD-BEARING: a transition recovery whose crontab does not match the backup's
//      projection REFUSES rather than restoring
//
// Codex r27's second HIGH: the same defect reached through the first-rollout recovery path. There
// the predecessor is STILL SERVING and was built before this lock existed, so no exclusion of ours
// ever reached it; the interrupted run's backup can be minutes or hours stale, and every schedule
// saved since went into the live crontab and into no backup at all. No concurrent write is
// required for this one — only elapsed time.
//
// A backup is safe to install blindly only if the world still matches what it was taken from, so
// the recovery asks exactly that: is the live crontab the fence's own projection of this backup?
// Equal, and the snapshot is provably current. Different, and this path REFUSES — it does not
// merge, because unlike the unfence window the writer here need not have held the lock, need not
// be the application, and the divergence is not bounded. Nothing has been stopped and nothing
// migrated at this point, so refusing costs a re-run.
//
// Route: scripts/install.sh -> resume_from_interrupted_arming -> resume_restore_cron_locked.
// ---------------------------------------------------------------------------

/** The fence transform, asked of the SHIPPED library rather than restated here. */
async function fenceProjectionOf(text: string): Promise<string> {
  const quoted = `'${text.replace(/'/g, "'\\''")}'`
  const { code, stdout, stderr } = await sh(
    `set -uo pipefail\ndie(){ exit 1; }\nsource '${CRONTAB_LOCK_LIB}'\ncrontab_fence_projection ${quoted}`)
  assert.equal(code, 0, stderr)
  return stdout
}

/** What a reconciliation by the still-serving predecessor left behind, after the backup was taken. */
const PREDECESSOR_BLOCK = '# --- OTI CRON START ---\n'
  + '*/7 * * * * curl -H "Authorization: Bearer $CRON_SECRET" "$BASE_URL/backup"\n'
  + '# --- OTI CRON END ---'

const blindResumeMutation = (src: string): string => {
  const before = '  if ! crontab_is_unmoved_since_backup "${backup}" "${current}"; then'
  assert.ok(src.includes(before),
    'scripts/install.sh must compare the live crontab with the backup projection on one line')
  return src.replace(before, '  if false; then')
}

async function resumeAgainst(live: string, mutate?: (src: string) => string) {
  writeFileSync(CUTOVER_BACKUP, `${CUTOVER_ORIGINAL.replace(/\n$/, '')}\n`)
  writeFileSync(CRONTAB_FILE, live)
  // The SHIPPED call shape: a failure here is fatal to the run, which is what makes "refuses"
  // different from "skips". `die` is the harness's, and it exits 9.
  const run = await sh(cutoverProgram(
    'CRON_FENCED=true\n'
    + 'with_crontab_lock resume_restore_cron_locked || die "the crontab could not be restored.'
    + '${RESUME_CRON_DIVERGED:+ THE REASON IS NOT THE LOCK: }${RESUME_CRON_DIVERGED}"\n'
    + 'echo RESTORED',
    { extraFunctions: ['resume_restore_cron_locked'], mutate }))
  return { run, final: crontabText() }
}

test('[o3d-batch-ret] a transition recovery REFUSES a backup whose world has moved', async () => {
  const projection = await fenceProjectionOf(CUTOVER_ORIGINAL.replace(/\n$/, ''))

  // CONTROL FIRST, so the refusal below is a decision and not a function that refuses everything.
  // Nothing wrote since the interrupted run fenced: the live crontab IS the projection, and the
  // backup goes back.
  const untouched = await resumeAgainst(projection)
  assert.equal(untouched.run.code, 0, untouched.run.stderr)
  assert.match(untouched.run.stdout, /RESTORED/)
  assert.equal(untouched.final, CUTOVER_ORIGINAL,
    'an unmoved world restores exactly what the interrupted run had')
  assert.equal(existsSync(CUTOVER_BACKUP), false, 'and the backup it consumed is gone')

  // THE FINDING. The predecessor — still serving, never party to this lock — reconciled after the
  // backup was taken. The live crontab is no longer the projection of it.
  const moved = await resumeAgainst(`${projection}${PREDECESSOR_BLOCK}\n`)
  assert.equal(moved.run.code, 9,
    'a recovery that cannot prove the snapshot is current must FAIL, so its caller dies')
  assert.doesNotMatch(moved.run.stdout, /RESTORED/)
  assert.match(moved.run.stderr, /THE REASON IS NOT THE LOCK: the live crontab is not the fence's own projection/,
    'and the operator is told it was the crontab that moved, not a lock that was busy')
  assert.equal(moved.final, `${projection}${PREDECESSOR_BLOCK}\n`,
    'and it must leave the crontab EXACTLY as it found it — refusing means writing nothing')
  assert.equal(existsSync(CUTOVER_BACKUP), true,
    'the backup stays on disk: the operator is told to settle it, so it must still be there')

  // …and the SHIPPED caller, in all three entrypoints, distinguishes this refusal from a lock it
  // could not take — the two have different remedies and the message must not merge them.
  for (const [name, src] of SHELL_ENTRYPOINTS) {
    assert.match(src, /with_crontab_lock resume_restore_cron_locked \|\| die/,
      `${name} must die when the interrupted arming's crontab cannot be put back`)
    assert.match(src, /\$\{RESUME_CRON_DIVERGED:\+ THE REASON IS NOT THE LOCK: \}\$\{RESUME_CRON_DIVERGED\}/,
      `${name} must say WHICH refusal this is`)
  }
})

test('[o3d-batch-ret] MUTATION: without that comparison the recovery restores over the later write', async () => {
  // THE ROUTE, RUN. The comparison short-circuited to false — the shipped body before this round,
  // which installed the backup wholesale whatever the crontab had become.
  const projection = await fenceProjectionOf(CUTOVER_ORIGINAL.replace(/\n$/, ''))
  const moved = await resumeAgainst(`${projection}${PREDECESSOR_BLOCK}\n`, blindResumeMutation)

  assert.equal(moved.run.code, 0, moved.run.stderr)
  assert.match(moved.run.stdout, /RESTORED/)
  assert.equal(moved.final, CUTOVER_ORIGINAL,
    'THE SILENT LOSS: the predecessor block committed after the backup was taken is simply gone')
  assert.doesNotMatch(moved.final, /OTI CRON START/)
})

// ---------------------------------------------------------------------------
// 22 — LOAD-BEARING: a missing or failing socket tool REFUSES rather than fencing
//
// Codex r27's third HIGH, and it is about code this branch added last round. The cutover fence
// moved below the stop because the only exclusion that reaches a predecessor built before the
// shared lock is that it is NOT RUNNING — so "nothing is serving" stopped being a remark and
// became the premise the fence rests on. The proof of that premise then warned when `ss` was
// missing and fenced anyway, and its `ss … | grep -q` pipeline could not tell an `ss` that
// found nothing from an `ss` that failed: both yield no output, the grep fails to match, and an
// unanswerable question is recorded as the answer "nobody is there".
//
// Absence of evidence read as evidence of absence — the shape this branch has closed at the
// responder attribution, the listener census and the marker sentinel.
//
// Route: scripts/update.sh's post-stop drain (and the identical sites in install.sh and
// deploy.sh), through the shared require_port_drained.
// ---------------------------------------------------------------------------

const DRAIN_BIN = join(HARNESS, 'drain-bin')
const DRAIN_EMPTY_PATH = join(HARNESS, 'drain-nothing')
mkdirSync(DRAIN_BIN, { recursive: true })
mkdirSync(DRAIN_EMPTY_PATH, { recursive: true })

/** A doubled `ss`, because a real one cannot be made to fail on demand. */
function writeSs(body: string) {
  writeFileSync(join(DRAIN_BIN, 'ss'), `#!/bin/sh\n${body}\n`)
  chmodSync(join(DRAIN_BIN, 'ss'), 0o755)
}
const SS_HEADER = 'State  Recv-Q Send-Q Local Address:Port  Peer Address:Port'

function drainProgram(port: string, opts: { path?: string; legacy?: boolean } = {}): string {
  const probe = opts.legacy
    // The pipeline the shipped proof REPLACES, kept here as the mutation route rather than as a
    // description of one. Both halves of the old shape are present: the `command -v` fall-through
    // and the single grep that reads a failed query as an empty socket listing.
    ? `if command -v ss >/dev/null 2>&1; then
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -q ":${port}\\$"; then echo "REFUSED=bound"; else echo DRAINED; fi
else
  echo DRAINED
fi`
    : `if require_port_drained '${port}'; then echo DRAINED; else echo "REFUSED=\${PORT_DRAIN_REASON}"; fi`
  return [
    'set -uo pipefail',
    `PATH='${opts.path ?? `${DRAIN_BIN}:${process.env.PATH}`}'`,
    'IMS_PORT_DRAIN_WAIT_SECONDS=0',
    'die(){ echo "DIE: $*" >&2; exit 9; }',
    `source '${CRONTAB_LOCK_LIB}'`,
    probe,
  ].join('\n')
}

test('[o3d-batch-ret] a drain that could not be PROVED refuses, in every way of not knowing', async () => {
  // CONTROL FIRST. A census that ran and found the port free must say so, or every refusal below
  // is a function that refuses everything.
  writeSs(`echo '${SS_HEADER}'\nprintf 'LISTEN 0 511 0.0.0.0:5544 0.0.0.0:*\\n'`)
  const free = await sh(drainProgram('3000'))
  assert.match(free.stdout, /^DRAINED$/m,
    'a census that ran and saw nothing on the port is the one case that may proceed')

  // …and it is looking at the port it was given.
  const bound = await sh(drainProgram('5544'))
  assert.match(bound.stdout, /REFUSED=1 socket\(s\) are still listening on :5544/)

  // (a) NO `ss` AT ALL. The premise cannot be established on this host, so the run stops.
  const missing = await sh(drainProgram('3000', { path: DRAIN_EMPTY_PATH }))
  assert.match(missing.stdout, /REFUSED=`ss` is not installed/,
    'a missing tool is not a proof of absence')

  // (b) `ss` PRESENT AND FAILING. The old pipeline could not see this at all.
  writeSs('exit 2')
  const failed = await sh(drainProgram('3000'))
  assert.match(failed.stdout, /REFUSED=`ss -ltn` exited 2, so the socket census FAILED/)

  // (c) `ss` EXITING 0 WITH NOTHING. It always prints its header; silence means it did not do what
  // it was asked, whatever it exited with.
  writeSs('exit 0')
  const silent = await sh(drainProgram('3000'))
  assert.match(silent.stdout, /REFUSED=`ss -ltn` exited 0 but produced no output at all/)

  // (d) NO PORT RESOLVED. Nothing to census, so nothing is proved.
  writeSs(`echo '${SS_HEADER}'`)
  const unresolved = await sh(drainProgram(''))
  assert.match(unresolved.stdout, /REFUSED=the application port could not be resolved/)
})

test('[o3d-batch-ret] MUTATION: the pipeline this replaced calls all three of those DRAINED', async () => {
  // THE ROUTE, RUN. Same three conditions, same doubled `ss`, through the shape the shipped proof
  // replaced. Each one reports the port drained — which is what then fenced the crontab and
  // migrated.
  const missing = await sh(drainProgram('3000', { path: DRAIN_EMPTY_PATH, legacy: true }))
  assert.match(missing.stdout, /^DRAINED$/m, 'the old shape fell straight through a missing `ss`')

  writeSs('exit 2')
  const failed = await sh(drainProgram('3000', { legacy: true }))
  assert.match(failed.stdout, /^DRAINED$/m, 'and read a failed query as an empty socket listing')

  writeSs('exit 0')
  const silent = await sh(drainProgram('3000', { legacy: true }))
  assert.match(silent.stdout, /^DRAINED$/m, 'and read silence the same way')

  // CONTROL — the old shape did detect a listener it could actually see, so the three above are
  // its blind spots and not a probe that never refuses.
  writeSs(`echo '${SS_HEADER}'\nprintf 'LISTEN 0 511 0.0.0.0:5544 0.0.0.0:*\\n'`)
  const bound = await sh(drainProgram('5544', { legacy: true }))
  assert.match(bound.stdout, /REFUSED=bound/)
})

// ---------------------------------------------------------------------------
// 23 — the sweep: ALL THREE entrypoints prove the drain, fatally, before they fence
// ---------------------------------------------------------------------------

/**
 * The rule, as a function so the mutation control below can run the SAME logic over a mutated
 * source. Reports what is wrong with one entrypoint's drain proof, or an empty list.
 */
function drainProofFaultsIn(name: string, src: string): string[] {
  const faults: string[] = []
  const lines = src.split('\n')

  const calls = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^\s*require_port_drained\b/.test(line))
  if (calls.length !== 1) {
    faults.push(`${name}: expected exactly one require_port_drained call, found ${calls.length}`)
    return faults
  }
  // FATAL, not advisory. `|| die` on the same line, which is how every other refusal in these
  // scripts is spelled.
  if (!/\|\|\s*die\b/.test(calls[0].line) && !/\|\|\s*die\s*\\$/.test(calls[0].line)) {
    faults.push(`${name}: the drain proof does not die on failure: ${calls[0].line.trim()}`)
  }
  // BEFORE the fence, because the fence is what rests on it. The MAIN-FLOW fence: the other
  // `fence_cron` in each of these files is the nested re-fence inside adopt_cron_fence_locked,
  // which runs on an already-adopted fence long before this section and is not what the drain is
  // the premise for. Classified by enclosing function rather than by position, so moving either
  // one shows up here.
  const fences = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^\s*fence_cron$/.test(line))
    .filter(({ index }) => enclosingFunctionInSource(lines, index + 1) === '(top level)')
  if (fences.length !== 1) {
    faults.push(`${name}: expected exactly one main-flow fence_cron, found ${fences.length}`)
  } else if (fences[0].index < calls[0].index) {
    faults.push(`${name}: fence_cron runs before the drain is proved`)
  }

  // AND NO SURVIVING FAIL-OPEN PIPELINE. A drain expressed as `ss … | grep -q` cannot tell a query
  // that failed from a port that is free, wherever it is put.
  lines.forEach((line, index) => {
    if (line.trimStart().startsWith('#')) return
    if (/\bss\s+-ltn\b/.test(line) && /grep\s+-q/.test(line)) {
      faults.push(`${name}:${index + 1}: a fail-open \`ss -ltn | grep -q\` drain remains`)
    }
  })
  return faults
}

test('[o3d-batch-ret] install, deploy and update all PROVE the drain before fencing', () => {
  const faults = SHELL_ENTRYPOINTS.flatMap(([name, src]) => drainProofFaultsIn(name, src))
  assert.deepEqual(faults, [],
    'every entrypoint must prove the drain fatally, before its fence: ' + JSON.stringify(faults))

  // NOT VACUOUS: the walk really did find a call and a fence in each of the three.
  for (const [name, src] of SHELL_ENTRYPOINTS) {
    assert.match(src, /^\s*require_port_drained /m, `${name} must call the shared drain proof`)
    const mainFlowFences = src.split('\n')
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /^\s*fence_cron$/.test(line))
      .filter(({ index }) => enclosingFunctionInSource(src.split('\n'), index + 1) === '(top level)')
    assert.equal(mainFlowFences.length, 1, `${name} must still fence in its main flow`)
  }
  // And the proof lives in ONE place, so a fourth entrypoint cannot get it subtly wrong.
  assert.match(CRONTAB_LOCK_LIB_SRC, /^require_port_drained\(\) \{$/m)
  for (const [name, src] of SHELL_ENTRYPOINTS) {
    assert.doesNotMatch(src, /^require_port_drained\(\) \{$/m,
      `${name} must use the shared proof, not restate it`)
  }
})

test('[o3d-batch-ret] MUTATION: the sweep rejects each way of putting the fail-open back', () => {
  const base = UPDATE_SH
  const call = base.split('\n').find((l) => /^\s*require_port_drained\b/.test(l))
  assert.ok(call, 'scripts/update.sh must call require_port_drained')

  const placements: Array<[string, string]> = [
    ['a drain proof that only warns',
      base.replace(call!, call!.replace(/\|\| die \\?$/, '|| warn "could not check" \\'))],
    ['the fence moved above the proof',
      base.replace(call!, 'fence_cron\n' + call!)],
    ['an ss|grep -q pipeline put back somewhere else',
      base + '\nif ss -ltn 2>/dev/null | awk \'{print $4}\' | grep -q ":${APP_PORT}\\$"; then :; fi\n'],
    ['the call removed altogether', base.replace(call!, '  true \\')],
  ]
  for (const [what, mutated] of placements) {
    assert.notEqual(mutated, base, `the ${what} mutation must change the source`)
    assert.notDeepEqual(drainProofFaultsIn('scripts/update.sh', mutated), [],
      `the sweep must reject ${what}`)
  }

  // CONTROL — the unmutated source comes back clean through the very same function.
  assert.deepEqual(drainProofFaultsIn('scripts/update.sh', base), [])
})

// ---------------------------------------------------------------------------
// 23 — LOAD-BEARING: a crontab that could not be READ is not a crontab with nothing in it
//
// Codex r28's two HIGHs, and they are round 27's third HIGH reached through a different command.
// There the socket census read a missing `ss`, a non-zero `ss` and a silent `ss` as "nobody is
// listening". Here every `crontab -l` in all three entrypoints was written
//
//     current="$(crontab -u "$APP_USER" -l 2>/dev/null || true)"
//
// which throws away the diagnostic and converts every failure into the empty string. Two callers
// then read that empty string as a fact:
//
//   fence_cron_locked      "No crontab; nothing to fence" — and the cutover proceeds into the
//                          database fence and the migration with cron still armed.
//   unfence_cron_locked    an empty live crontab holds nothing the backup does not — so the
//                          pre-cutover snapshot goes back over a committed save.
//
// The fix is ONE reader, read_crontab_for(), and the interesting half of it is that exit status
// CANNOT do the separation: on the Vixie cron every supported platform ships, "no crontab for this
// user", "no such user" and "must be privileged" are all exit 1 with empty output. What separates
// them is the diagnostic, and only the benign one says `no crontab for <user>` and says nothing
// else. The shim below reproduces each of those states verbatim.
//
// WHAT THESE PIN, and the route each takes:
//   1. every failing read is UNRESOLVED, and a genuinely absent crontab is still RESOLVED
//                                          (scripts/lib/crontab-lock.sh -> read_crontab_for)
//   2. the fence ABORTS, before the database fence and the migration, in all three entrypoints
//                                          (fence_cron -> fence_cron_locked)
//   3. the unfence REFUSES rather than installing the snapshot
//                                          (unfence_cron -> unfence_cron_locked)
//   4. a deletion made while the fence was up is a WRITE, and is not undone
//                                          (plan_crontab_unfence)
//   5. a backup line appearing twice is not satisfied by one live occurrence, and moving an
//      environment assignment past a job is not "every line still exists"
//                                          (crontab_unmanaged_lines_missing_from)
// ---------------------------------------------------------------------------

const FAULT_DIR = join(HARNESS, 'crontab-faults')
const FAULT_BIN = join(FAULT_DIR, 'bin')
const FAULT_CRONTAB = join(FAULT_DIR, 'crontab.txt')
const FAULT_BACKUP = join(FAULT_DIR, 'crontab-appuser.bak')
mkdirSync(FAULT_BIN, { recursive: true })

/**
 * A `crontab` whose `-l` can be put into each state a real one reaches, selected by
 * $FAKE_CRONTAB_READ. The exit statuses and the diagnostics are not invented: they were taken off
 * `/usr/bin/crontab` from the Debian `cron` package (Vixie cron, setgid crontab) by running it in
 * each state — an existing user with no crontab, a user that does not exist, and `-u` as an
 * unprivileged caller. All three are exit 1 with empty stdout, which is exactly why `|| true` on
 * the exit status alone could never have told them apart.
 */
writeFileSync(join(FAULT_BIN, 'crontab'), `#!/bin/sh
user=self
if [ "$1" = "-u" ]; then user="$2"; shift 2; fi
if [ "$1" = "-l" ]; then
  case "\${FAKE_CRONTAB_READ:-ok}" in
    ok)       if [ -f '${FAULT_CRONTAB}' ]; then cat '${FAULT_CRONTAB}'; fi; exit 0 ;;
    absent)   echo "no crontab for $user" >&2; exit 1 ;;
    denied)   echo "must be privileged to use -u" >&2; exit 1 ;;
    nouser)   echo "crontab:  user '$user' unknown" >&2; exit 1 ;;
    silent)   exit 1 ;;
    partial)  if [ -f '${FAULT_CRONTAB}' ]; then cat '${FAULT_CRONTAB}'; fi
              echo "no crontab for $user" >&2; exit 1 ;;
    *)        echo "unmodelled mode" >&2; exit 1 ;;
  esac
fi
src="$1"
if [ "$src" = "-" ]; then cat > '${FAULT_CRONTAB}'; else cat "$src" > '${FAULT_CRONTAB}'; fi
`)
chmodSync(join(FAULT_BIN, 'crontab'), 0o755)

function faultCrontabText(): string {
  return existsSync(FAULT_CRONTAB) ? readFileSync(FAULT_CRONTAB, 'utf8') : ''
}

/** A copy of the SHIPPED library with named edits applied, so a mutation runs real code. */
let mutatedLibSeq = 0
function libraryWith(edits: Array<[string, string]>): string {
  let src = CRONTAB_LOCK_LIB_SRC
  for (const [from, to] of edits) {
    assert.equal(src.split(from).length - 1, 1,
      `scripts/lib/crontab-lock.sh must contain exactly one:\n${from}`)
    src = src.replace(from, to)
  }
  assert.notEqual(src, CRONTAB_LOCK_LIB_SRC, 'a library mutation that changes nothing tests nothing')
  const path = join(FAULT_DIR, `crontab-lock-mutated-${++mutatedLibSeq}.sh`)
  writeFileSync(path, src)
  return path
}

/**
 * A bash program built out of one SHIPPED entrypoint's own functions, running against the fault
 * shim. `lib` swaps in a mutated library; `mutate` edits the assembled prelude, which is how the
 * pre-fix body is RUN rather than described.
 */
function faultProgram(
  where: string,
  src: string,
  body: string,
  opts: { functions: string[]; mutate?: (s: string) => string; lib?: string } = { functions: [] },
): string {
  const program = [
    'set -uo pipefail',
    `PATH='${FAULT_BIN}':"$PATH"`,
    'IMS_CRONTAB_LOCK_WAIT_SECONDS=30',
    `source '${opts.lib ?? CRONTAB_LOCK_LIB}'`,
    `CRONTAB_LOCK_DIR='${dirname(LOCK_FILE)}'`,
    `CRONTAB_LOCK_FILE='${LOCK_FILE}'`,
    'APP_USER=appuser',
    `DATA_DIR='${FAULT_DIR}'`,
    `CRON_BACKUP='${FAULT_BACKUP}'`,
    'CRON_FENCED=false',
    'CRON_BACKUP_CREATED=false',
    'DRY_RUN=false',
    "YELLOW=''; RESET=''",
    'info(){ :; }; ok(){ :; }; success(){ :; }; warn(){ echo "WARN: $*" >&2; }',
    'die(){ echo "DIE: $*" >&2; exit 9; }',
    ...opts.functions.map((name) => shellFunctionFrom(src, name, where)),
  ].join('\n')
  const prelude = opts.mutate ? opts.mutate(program) : program
  if (opts.mutate) assert.notEqual(prelude, program, 'a mutation that changes nothing tests nothing')
  return `${prelude}\n${body}`
}

/** The three entrypoints, with the spelling each uses for the user, since the bodies are lifted verbatim. */
const FAULT_ENTRYPOINTS: Array<[string, string, string]> = [
  ['scripts/install.sh', INSTALL_SH, '"${APP_USER}"'],
  ['scripts/deploy.sh', DEPLOY_SH, '"$APP_USER"'],
  ['scripts/update.sh', UPDATE_SH, '"${APP_USER}"'],
]

const FAULT_ORIGINAL = '# an operator line the cutover must put back\n*/5 * * * * /usr/bin/true\n'

/**
 * THE PRE-FIX BODY OF THE READ, put back at whichever site the marker names. `read_crontab_for … ||
 * die \` becomes the suppressed read it replaced, with the continuation swallowed by `:` so the
 * long message below it stays a well-formed argument. Everything downstream then sees exactly what
 * it saw before this round: an empty string, and no way to know why.
 */
function failOpenReadMutation(user: string) {
  return (src: string): string => {
    const marker = `  read_crontab_for ${user} || die \\`
    assert.equal(src.split(marker).length - 1, 1, `the fence must read the crontab on one line:\n${marker}`)
    return src.replace(marker,
      `  current="$(crontab -u ${user} -l 2>/dev/null || true)"\n`
      + '  CRONTAB_READ_TEXT="$current"\n'
      + '  CRONTAB_READ_PRESENT=true\n'
      + '  : \\')
  }
}

test('[o3d-batch-ret] a crontab read that did not RESOLVE is refused, and a crontab that is genuinely ABSENT is not', async () => {
  const probe = async (mode: string, lib = CRONTAB_LOCK_LIB) => sh([
    'set -uo pipefail',
    `PATH='${FAULT_BIN}':"$PATH"`,
    'die(){ echo "DIE: $*" >&2; exit 9; }',
    `source '${lib}'`,
    `export FAKE_CRONTAB_READ='${mode}'`,
    'if read_crontab_for appuser; then',
    '  echo "RESOLVED present=${CRONTAB_READ_PRESENT} text=[${CRONTAB_READ_TEXT}]"',
    'else',
    '  echo "UNRESOLVED ${CRONTAB_READ_REASON}"',
    'fi',
  ].join('\n'))

  writeFileSync(FAULT_CRONTAB, FAULT_ORIGINAL)

  // CONTROL, FIRST. A crontab that reads normally resolves and carries its content, so the
  // refusals below are a decision and not a function that refuses everything.
  const ok = await probe('ok')
  assert.match(ok.stdout, /^RESOLVED present=true text=\[# an operator line/m,
    `a readable crontab must resolve, with its content:\n${ok.stdout}${ok.stderr}`)

  // LOAD-BEARING HALF ONE. A genuinely absent crontab is a real answer and must stay one: making
  // every non-zero exit a refusal would trade one failure for another, and every fresh box has no
  // crontab at all.
  const absent = await probe('absent')
  assert.match(absent.stdout, /^RESOLVED present=false text=\[\]$/m,
    `"no crontab for appuser" is an ANSWER, not a failure:\n${absent.stdout}${absent.stderr}`)

  // LOAD-BEARING HALF TWO. Every other way of exiting non-zero is unresolved — and each of these
  // exits 1 with empty output exactly as the benign case does, which is why the exit status alone
  // could never have done this.
  for (const [mode, expected] of [
    ['denied', /must be privileged to use -u/],
    ['nouser', /unknown/],
    ['silent', /nothing at all/],
  ] as Array<[string, RegExp]>) {
    const run = await probe(mode)
    assert.match(run.stdout, /^UNRESOLVED /m,
      `\`${mode}\` must not be read as an absent crontab:\n${run.stdout}${run.stderr}`)
    assert.match(run.stdout, expected, `and it must quote what crontab actually said:\n${run.stdout}`)
  }

  // …and the benign message is matched WHOLE. Output alongside it means something was read and
  // then something failed, which is not "there is no crontab".
  const partial = await probe('partial')
  assert.match(partial.stdout, /^UNRESOLVED /m,
    `output plus the absence message is not an absence:\n${partial.stdout}${partial.stderr}`)
})

test('[o3d-batch-ret] MUTATION: with the failure suppressed, every one of those refusals becomes "there is no crontab"', async () => {
  // THE ROUTE, RUN. The resolution rule replaced by "any non-zero exit means there is no crontab",
  // which is precisely what `2>/dev/null || true` amounted to at all thirteen call sites.
  const lib = libraryWith([[
    '  if [[ -z "${out}" ]] && crontab_read_says_no_crontab "${user}" "${err}"; then',
    '  if true; then',
  ]])
  const probe = async (mode: string) => sh([
    'set -uo pipefail',
    `PATH='${FAULT_BIN}':"$PATH"`,
    'die(){ echo "DIE: $*" >&2; exit 9; }',
    `source '${lib}'`,
    `export FAKE_CRONTAB_READ='${mode}'`,
    'if read_crontab_for appuser; then echo "RESOLVED present=${CRONTAB_READ_PRESENT}"; else echo UNRESOLVED; fi',
  ].join('\n'))

  for (const mode of ['denied', 'nouser', 'silent']) {
    const run = await probe(mode)
    assert.match(run.stdout, /^RESOLVED present=false$/m,
      `without the diagnostic rule, \`${mode}\` reports an absent crontab:\n${run.stdout}${run.stderr}`)
  }

  // AND THE OTHER WAY, because a fix that trades one failure for another is not a fix. With the
  // absence rule removed entirely — "any non-zero exit is a failure" — a fresh box, which has no
  // crontab at all and says so, becomes an unresolved read and every fence stops on it.
  const refuseEverything = libraryWith([[
    '  if [[ -z "${out}" ]] && crontab_read_says_no_crontab "${user}" "${err}"; then',
    '  if false; then',
  ]])
  const absent = await sh([
    'set -uo pipefail',
    `PATH='${FAULT_BIN}':"$PATH"`,
    'die(){ echo "DIE: $*" >&2; exit 9; }',
    `source '${refuseEverything}'`,
    "export FAKE_CRONTAB_READ='absent'",
    'if read_crontab_for appuser; then echo "RESOLVED present=${CRONTAB_READ_PRESENT}"; else echo UNRESOLVED; fi',
  ].join('\n'))
  assert.match(absent.stdout, /^UNRESOLVED$/m,
    `without the absence rule a box with no crontab cannot be read at all:\n${absent.stdout}${absent.stderr}`)
})

for (const [where, src, user] of FAULT_ENTRYPOINTS) {
  test(`[o3d-batch-ret] ${where}: the cron fence ABORTS on an unresolved read, before the database fence and the migration`, async () => {
    // The static half: this is a fence whose whole job is to be finished before those two steps.
    const lines = src.split('\n')
    const at = (re: RegExp, from = 0): number => {
      const i = lines.findIndex((line, n) => n >= from && re.test(line))
      assert.notEqual(i, -1, `${where} must contain ${re}`)
      return i
    }
    const fenceCall = at(/^\s*fence_cron$/)
    assert.ok(fenceCall < at(/prisma migrate deploy --schema prisma\/schema\.prisma/, fenceCall),
      `${where} fences cron before the schema moves, so a fence that returns 0 without fencing is a migration under live cron writers`)
    assert.ok(fenceCall < at(/fence_db_connections|check-db-writers\.mjs/, fenceCall),
      `${where} fences cron before the database fence, which is the step the cron entries would defeat`)

    // The dynamic half: the shipped fence, against a crontab whose read cannot be resolved.
    const functions = ['fsync_path', 'publish_cron_backup', 'fence_cron_locked', 'fence_cron']
    const body = 'fence_cron\necho "REACHED-THE-DATABASE-FENCE"'

    writeFileSync(FAULT_CRONTAB, FAULT_ORIGINAL)
    rmSync(FAULT_BACKUP, { force: true })
    const refused = await sh(`export FAKE_CRONTAB_READ=denied\n${faultProgram(where, src, body, { functions })}`)

    assert.equal(refused.code, 9, `an unresolved read must stop the run:\n${refused.stdout}${refused.stderr}`)
    assert.doesNotMatch(refused.stdout, /REACHED-THE-DATABASE-FENCE/,
      'and stop it HERE — nothing after the fence may run')
    assert.match(refused.stderr, /NOTHING HAS BEEN MIGRATED/,
      `and say so in the terms the operator needs:\n${refused.stderr}`)
    assert.match(refused.stderr, /must be privileged to use -u/,
      'and quote what the read actually said')
    assert.equal(faultCrontabText(), FAULT_ORIGINAL, 'refusing means writing nothing')
    assert.equal(existsSync(FAULT_BACKUP), false, 'and taking no backup it would later restore from')

    // CONTROL. The same program on a crontab that reads fine fences it and carries on, so the
    // refusal above is about the read and not about the program being broken.
    writeFileSync(FAULT_CRONTAB, FAULT_ORIGINAL)
    rmSync(FAULT_BACKUP, { force: true })
    const fenced = await sh(`export FAKE_CRONTAB_READ=ok\n${faultProgram(where, src, body, { functions })}`)
    assert.equal(fenced.code, 0, `a readable crontab must still be fenced:\n${fenced.stderr}`)
    assert.match(fenced.stdout, /REACHED-THE-DATABASE-FENCE/)
    assert.match(faultCrontabText(), /^#DEPLOY-FENCE# \*\/5 \* \* \* \* \/usr\/bin\/true$/m,
      'and the active line really must be commented out')

    // …and a crontab that is genuinely ABSENT is neither refused nor fenced. Without this the
    // refusal could be a fence that stops on every box that has no crontab, which is every box
    // the installer has not run on yet.
    rmSync(FAULT_CRONTAB, { force: true })
    rmSync(FAULT_BACKUP, { force: true })
    const none = await sh(`export FAKE_CRONTAB_READ=absent\n${faultProgram(where, src, body, { functions })}`)
    assert.equal(none.code, 0, `an absent crontab must not stop the run:\n${none.stdout}${none.stderr}`)
    assert.match(none.stdout, /REACHED-THE-DATABASE-FENCE/, 'the cutover carries on')
    assert.equal(faultCrontabText(), '', 'and nothing was written to a crontab that does not exist')
    assert.equal(existsSync(FAULT_BACKUP), false, 'and no backup was taken of nothing')
  })

  test(`[o3d-batch-ret] MUTATION: ${where}'s fence with the read suppressed calls that "no crontab" and migrates over it`, async () => {
    // THE ROUTE, RUN. The read put back the way it stood before this round, at the shipped site.
    const functions = ['fsync_path', 'publish_cron_backup', 'fence_cron_locked', 'fence_cron']
    const body = 'fence_cron\necho "REACHED-THE-DATABASE-FENCE"'
    writeFileSync(FAULT_CRONTAB, FAULT_ORIGINAL)
    rmSync(FAULT_BACKUP, { force: true })

    const run = await sh(`export FAKE_CRONTAB_READ=denied\n${faultProgram(where, src, body,
      { functions, mutate: failOpenReadMutation(user) })}`)

    assert.equal(run.code, 0, `the suppressed read completes without complaint:\n${run.stderr}`)
    assert.match(run.stdout, /REACHED-THE-DATABASE-FENCE/,
      'THE FINDING: the cutover walks on into the database fence and the migration')
    assert.equal(faultCrontabText(), FAULT_ORIGINAL,
      'and the cron entries it believes it disarmed are still active, still scheduled')
  })
}

test('[o3d-batch-ret] an unreadable crontab at the UNFENCE refuses, rather than restoring the snapshot over it', async () => {
  const functions = ['fsync_path', 'publish_cron_backup', 'fence_cron_locked', 'fence_cron',
    'unfence_cron_locked', 'unfence_cron']
  const where = 'scripts/install.sh'

  /** Fence for real, then unfence with the read in <mode>. */
  async function fenceThenUnfence(mode: string, opts: { mutate?: (s: string) => string; lib?: string } = {}) {
    writeFileSync(FAULT_CRONTAB, FAULT_ORIGINAL)
    rmSync(FAULT_BACKUP, { force: true })
    const fenced = await sh(`export FAKE_CRONTAB_READ=ok\n${faultProgram(where, INSTALL_SH, 'fence_cron',
      { functions, ...opts })}`)
    assert.equal(fenced.code, 0, `the fence must complete before the unfence is asked anything:\n${fenced.stderr}`)
    assert.equal(existsSync(FAULT_BACKUP), true, 'precondition: the fence took a backup')
    const whileFenced = faultCrontabText()
    const restore = await sh(`export FAKE_CRONTAB_READ=${mode}\n${faultProgram(where, INSTALL_SH,
      'CRON_FENCED=true\nunfence_cron\necho "PLAN=${CRON_UNFENCE_PLAN}"', { functions, ...opts })}`)
    return { whileFenced, restore, final: faultCrontabText() }
  }

  // CONTROL. A readable crontab unfences, so the refusal below is not a function that refuses
  // everything.
  const good = await fenceThenUnfence('ok')
  assert.equal(good.restore.code, 0, `a readable crontab must be put back:\n${good.restore.stderr}`)
  assert.equal(good.final, FAULT_ORIGINAL, 'verbatim, because nothing wrote while it was fenced')
  assert.equal(existsSync(FAULT_BACKUP), false, 'and the backup it consumed is gone')

  // THE PROPERTY. The read cannot be resolved, so this run does not get to decide what belongs in
  // the crontab — and above all does not install a snapshot on the strength of a reading it does
  // not have.
  const blind = await fenceThenUnfence('denied')
  assert.equal(blind.restore.code, 9,
    `an unresolved read must refuse:\n${blind.restore.stdout}${blind.restore.stderr}`)
  assert.match(blind.restore.stderr, /still FENCED/,
    'and say the crontab is still fenced, which is the state it is leaving behind')
  assert.match(blind.restore.stderr, /the live crontab could not be read/, blind.restore.stderr)
  assert.match(blind.restore.stderr, /must be privileged to use -u/, 'quoting what crontab said')
  assert.equal(blind.final, blind.whileFenced,
    'REFUSING MEANS WRITING NOTHING: the fenced crontab is exactly as the unfence found it')
  assert.equal(existsSync(FAULT_BACKUP), true,
    'and the backup stays on disk, because the operator is told to settle it by hand')
})

test('[o3d-batch-ret] MUTATION: the pre-round body reads that failure as an empty crontab and restores the stale snapshot', async () => {
  // THE ROUTE, RUN, IN BOTH ITS PARTS — because the fix has two halves and each alone is enough to
  // refuse. Part one is the suppressed read at the unfence site. Part two is round 27's lost-lines
  // branch, which sent a live crontab holding nothing the projection does not straight to the
  // snapshot. Together they are the shipped code as it stood, and it discards whatever was really
  // in the crontab.
  const lib = libraryWith([[
    '  if crontab_is_unmoved_since_backup "${backup}" "${live}"; then',
    '  if [[ -z "$(awk \'NR == FNR { have[$0] = 1; next } /^[[:space:]]*$/ { next } !($0 in have) { print }\''
    + ' <(crontab_fence_projection "${backup}") <(printf \'%s\\n\' "${live}"))" ]]; then',
  ]])
  const suppressUnfenceRead = (s: string): string => {
    const marker = '  read_crontab_for "${APP_USER}" || {\n'
      + '    CRON_UNFENCE_REASON="the live crontab could not be read, so nothing can establish what is in it'
      + ' and a snapshot installed on that reading would discard whatever is: ${CRONTAB_READ_REASON}"\n'
      + '    return "${CRONTAB_UNFENCE_DIVERGED}"\n'
      + '  }'
    assert.equal(s.split(marker).length - 1, 1, `scripts/install.sh must guard the unfence read:\n${marker}`)
    return s.replace(marker, '  :')
  }
  const mutate = (s: string): string =>
    suppressUnfenceRead(s).replace('  current="${CRONTAB_READ_TEXT}"\n  if ! backup=',
      '  current="$(crontab -u "${APP_USER}" -l 2>/dev/null || true)"\n  if ! backup=')

  const functions = ['fsync_path', 'publish_cron_backup', 'fence_cron_locked', 'fence_cron',
    'unfence_cron_locked', 'unfence_cron']
  writeFileSync(FAULT_CRONTAB, FAULT_ORIGINAL)
  rmSync(FAULT_BACKUP, { force: true })
  const fenced = await sh(`export FAKE_CRONTAB_READ=ok\n${faultProgram('scripts/install.sh', INSTALL_SH,
    'fence_cron', { functions, mutate, lib })}`)
  assert.equal(fenced.code, 0, fenced.stderr)

  const restore = await sh(`export FAKE_CRONTAB_READ=denied\n${faultProgram('scripts/install.sh', INSTALL_SH,
    'CRON_FENCED=true\nunfence_cron\necho "PLAN=${CRON_UNFENCE_PLAN}"', { functions, mutate, lib })}`)

  assert.equal(restore.code, 0, `the pre-round body completes with no complaint:\n${restore.stderr}`)
  assert.match(restore.stdout, /PLAN=snapshot/,
    'THE FINDING: a read that failed is classified as a crontab that had lost lines')
  assert.equal(faultCrontabText(), FAULT_ORIGINAL,
    'and the pre-cutover snapshot is installed on the strength of a reading nobody has')
})

test('[o3d-batch-ret] a line DELETED while the fence was up is a write, and the unfence does not put it back', async () => {
  // Codex r28 HIGH #1, second half. Round 27 read "the live crontab holds nothing the backup does
  // not" as "nothing wrote", and restored. One of the things that produces that reading is an
  // operator who ran `crontab -e` to stop a job — and was given no error, and found it scheduled
  // again after the next deploy.
  const backup = '# an operator line\nPATH=/usr/local/bin\n*/5 * * * * /usr/bin/keep\n17 3 * * * /usr/bin/retired'
  // The fenced crontab is the SHIPPED transform of that backup, not a re-typed copy of it — and
  // the deletion is one line taken out of it, which is what `crontab -e` leaves behind.
  const projection = (await fenceProjectionOf(backup)).replace(/\n$/, '')
  const deletedOne = projection.split('\n').filter((l) => !l.includes('/usr/bin/retired')).join('\n')
  assert.equal(projection.split('\n').length - deletedOne.split('\n').length, 1,
    'precondition: exactly one line was deleted while the fence was up')

  const plan = async (live: string, lib = CRONTAB_LOCK_LIB) => sh([
    'set -uo pipefail',
    'die(){ exit 1; }',
    `source '${lib}'`,
    `backup=$(cat <<'B_EOF'\n${backup}\nB_EOF\n)`,
    `live=$(cat <<'L_EOF'\n${live}\nL_EOF\n)`,
    'if plan_crontab_unfence "$backup" "$live"; then echo "PLAN=${CRON_UNFENCE_PLAN}"; else echo "REFUSED"; fi',
    'echo "REASON=${CRON_UNFENCE_REASON}"',
  ].join('\n'))

  // CONTROL. Nothing was deleted: the live crontab IS the fence's projection of the backup, and the
  // snapshot goes back. Without this the refusal below could be a plan that refuses everything.
  const untouched = await plan(projection)
  assert.match(untouched.stdout, /PLAN=snapshot/,
    `an unmoved world still restores verbatim:\n${untouched.stdout}${untouched.stderr}`)

  // THE PROPERTY. `17 3 * * * /usr/bin/retired` was removed while the fence was up. Restoring the
  // snapshot would schedule it again.
  const deleted = await plan(deletedOne)
  assert.match(deleted.stdout, /^REFUSED$/m,
    `a deletion is a write and cannot be undone by a snapshot:\n${deleted.stdout}${deleted.stderr}`)
  assert.match(deleted.stdout, /17 3 \* \* \* \/usr\/bin\/retired/,
    'and the refusal must NAME the line, because settling this is a human job')
})

test('[o3d-batch-ret] MUTATION: round 27\'s lost-lines branch schedules the deleted job again', async () => {
  // THE ROUTE, RUN. The branch as it shipped last round: live gained nothing over the projection,
  // therefore nothing wrote, therefore install the snapshot.
  const lib = libraryWith([[
    '  if crontab_is_unmoved_since_backup "${backup}" "${live}"; then',
    '  if [[ -z "$(awk \'NR == FNR { have[$0] = 1; next } /^[[:space:]]*$/ { next } !($0 in have) { print }\''
    + ' <(crontab_fence_projection "${backup}") <(printf \'%s\\n\' "${live}"))" ]]; then',
  ]])
  const backup = '# an operator line\nPATH=/usr/local/bin\n*/5 * * * * /usr/bin/keep\n17 3 * * * /usr/bin/retired'
  const live = (await fenceProjectionOf(backup)).replace(/\n$/, '')
    .split('\n').filter((l) => !l.includes('/usr/bin/retired')).join('\n')
  const run = await sh([
    'set -uo pipefail',
    'die(){ exit 1; }',
    `source '${lib}'`,
    `backup=$(cat <<'B_EOF'\n${backup}\nB_EOF\n)`,
    `live=$(cat <<'L_EOF'\n${live}\nL_EOF\n)`,
    'if plan_crontab_unfence "$backup" "$live"; then echo "PLAN=${CRON_UNFENCE_PLAN}"; else echo REFUSED; fi',
    'echo "TEXT<<"; printf "%s\\n" "${CRON_UNFENCE_TEXT}"',
  ].join('\n'))
  assert.match(run.stdout, /PLAN=snapshot/, `the lost-lines branch takes it:\n${run.stdout}${run.stderr}`)
  assert.match(run.stdout, /17 3 \* \* \* \/usr\/bin\/retired/,
    'THE RESURRECTION: the entry the operator deleted is in the text about to be installed')
})

test('[o3d-batch-ret] the preservation check counts OCCURRENCES and respects ORDER, because cron does', async () => {
  // Codex r28 MEDIUM. Two identical entries run the job TWICE, and `PATH=`/`CRON_TZ=` apply to the
  // entries BELOW them — so "every line still exists somewhere" is not the same crontab.
  const missing = async (backup: string, candidate: string, lib = CRONTAB_LOCK_LIB) => sh([
    'set -uo pipefail',
    'die(){ exit 1; }',
    `source '${lib}'`,
    `backup=$(cat <<'B_EOF'\n${backup}B_EOF\n)`,
    `candidate=$(cat <<'C_EOF'\n${candidate}C_EOF\n)`,
    'echo "MISSING<<"',
    'crontab_unmanaged_lines_missing_from "$backup" "$candidate"',
    'echo ">>END"',
  ].join('\n'))

  const twice = '0 1 * * * /usr/bin/sweep\n0 1 * * * /usr/bin/sweep\n'
  const once = '0 1 * * * /usr/bin/sweep\n'
  const block = '# --- OTI CRON START ---\n*/7 * * * * curl "$BASE_URL/backup"\n# --- OTI CRON END ---\n'

  // CONTROL. Both occurrences present: nothing is missing. Without this the check below could be
  // one that reports everything.
  const kept = await missing(twice, `${twice}${block}`)
  assert.match(kept.stdout, /MISSING<<\n>>END/, `two kept as two must pass:\n${kept.stdout}${kept.stderr}`)

  // THE PROPERTY, ONE. Two occurrences in the backup, one in the candidate: the job would run half
  // as often, and the merge must not call that lossless.
  const halved = await missing(twice, `${once}${block}`)
  assert.match(halved.stdout, /MISSING<<\n0 1 \* \* \* \/usr\/bin\/sweep\n>>END/,
    `a duplicate reduced to one occurrence is a LOSS:\n${halved.stdout}${halved.stderr}`)

  // THE PROPERTY, TWO. Every line still exists, and the crontab means something different: the job
  // has moved above the assignment that dated it.
  const reordered = await missing('CRON_TZ=Europe/London\n0 1 * * * /usr/bin/sweep\n',
    '0 1 * * * /usr/bin/sweep\nCRON_TZ=Europe/London\n')
  assert.match(reordered.stdout, /MISSING<</, reordered.stdout)
  assert.notEqual(reordered.stdout.replace(/MISSING<<\n|>>END\n?/g, '').trim(), '',
    `moving an environment assignment past a job must not pass:\n${reordered.stdout}${reordered.stderr}`)

  // …and the same two facts reach the operator through the shipped plan, which is where they
  // decide whether the backup may be deleted.
  const planned = await sh([
    'set -uo pipefail',
    'die(){ exit 1; }',
    `source '${CRONTAB_LOCK_LIB}'`,
    `backup=$(cat <<'B_EOF'\n${twice}B_EOF\n)`,
    `live=$(cat <<'L_EOF'\n#DEPLOY-FENCE# 0 1 * * * /usr/bin/sweep\n${block}L_EOF\n)`,
    'if plan_crontab_unfence "$backup" "$live"; then echo "PLAN=${CRON_UNFENCE_PLAN}"; else echo REFUSED; fi',
  ].join('\n'))
  assert.match(planned.stdout, /^REFUSED$/m,
    `the merge must refuse rather than halve the schedule and delete the backup:\n${planned.stdout}${planned.stderr}`)
})

test('[o3d-batch-ret] MUTATION: the set-based comparison passes both of those', async () => {
  // THE ROUTE, RUN. `have[$0]` — the body as it stood before this round, appended so it overrides
  // the shipped definition and everything else runs unchanged.
  const src = `${CRONTAB_LOCK_LIB_SRC}
crontab_unmanaged_lines_missing_from() {
  local backup="$1" candidate="$2"
  awk '
    NR == FNR { have[$0] = 1; next }
    /^# --- OTI CRON START ---[ \\t\\r]*$/ { in_block = 1; next }
    /^# --- OTI CRON END ---[ \\t\\r]*$/   { in_block = 0; next }
    in_block { next }
    /^[[:space:]]*$/ { next }
    !($0 in have) { print }
  ' <(printf '%s\\n' "\${candidate}") <(printf '%s\\n' "\${backup}")
}
`
  const lib = join(FAULT_DIR, 'crontab-lock-setwise.sh')
  writeFileSync(lib, src)

  const run = async (backup: string, candidate: string) => sh([
    'set -uo pipefail',
    'die(){ exit 1; }',
    `source '${lib}'`,
    `backup=$(cat <<'B_EOF'\n${backup}B_EOF\n)`,
    `candidate=$(cat <<'C_EOF'\n${candidate}C_EOF\n)`,
    'echo "MISSING<<"; crontab_unmanaged_lines_missing_from "$backup" "$candidate"; echo ">>END"',
  ].join('\n'))

  const halved = await run('0 1 * * * /usr/bin/sweep\n0 1 * * * /usr/bin/sweep\n', '0 1 * * * /usr/bin/sweep\n')
  assert.match(halved.stdout, /MISSING<<\n>>END/,
    `THE FINDING: a set says nothing is missing while the job now runs once:\n${halved.stdout}${halved.stderr}`)

  const reordered = await run('CRON_TZ=Europe/London\n0 1 * * * /usr/bin/sweep\n',
    '0 1 * * * /usr/bin/sweep\nCRON_TZ=Europe/London\n')
  assert.match(reordered.stdout, /MISSING<<\n>>END/,
    `and says nothing is missing while the job now runs in a different timezone:\n${reordered.stdout}`)
})

/** Every crontab read in <src> whose own failure is suppressed. The rule, as a function. */
function suppressedCrontabReadsIn(name: string, src: string): string[] {
  const faults: string[] = []
  src.split('\n').forEach((line, i) => {
    if (/^\s*#/.test(line)) return
    if (!/\bcrontab\b.*\s-l\b/.test(line)) return
    if (/2>\/dev\/null/.test(line)) {
      faults.push(`${name}:${i + 1} reads the crontab with its diagnostic discarded: ${line.trim()}`)
    } else if (/\|\|\s*(true|:)\b/.test(line)) {
      faults.push(`${name}:${i + 1} reads the crontab with its failure suppressed: ${line.trim()}`)
    }
  })
  return faults
}

test('[o3d-batch-ret] no entrypoint reads the crontab without going through the one reader', () => {
  const faults: string[] = []
  let reads = 0
  for (const [name, src] of SHELL_ENTRYPOINTS) {
    const calls = src.split('\n').filter((line) => /^\s*read_crontab_for /.test(line))
    reads += calls.length
    assert.ok(calls.length >= 5,
      `${name} must route its crontab reads through read_crontab_for (found ${calls.length})`)
    faults.push(...suppressedCrontabReadsIn(name, src))
  }
  assert.deepEqual(faults, [], faults.join('\n'))

  // MUTATION, against the same rule: each way of putting one back is rejected, so the clean result
  // above is the rule working rather than a regex that matches nothing.
  for (const [what, snippet] of [
    ['the fence read', '  current="$(crontab -u "${APP_USER}" -l 2>/dev/null || true)"'],
    ['a piped read', '  if crontab -u "${APP_USER}" -l 2>/dev/null | grep -q foo; then :; fi'],
    ['a read whose only suppression is `|| true`', '  current="$(crontab -u "${APP_USER}" -l || true)"'],
    ['a brace-grouped read', '  { crontab -u "${APP_USER}" -l 2>/dev/null || true; } | awk "{print}"'],
  ] as Array<[string, string]>) {
    assert.notDeepEqual(suppressedCrontabReadsIn('scripts/install.sh', `${INSTALL_SH}\n${snippet}\n`), [],
      `the sweep must reject ${what}`)
  }
  // NOT VACUOUS: the walk really did reach the reads it is a rule about.
  assert.ok(reads >= 15, `the sweep must have found the shipped reads, and found ${reads}`)
  assert.match(CRONTAB_LOCK_LIB_SRC, /^read_crontab_for\(\) \{$/m,
    'and the reader must live in the shared library, not be copied into each entrypoint')
  for (const [name, src] of SHELL_ENTRYPOINTS) {
    assert.doesNotMatch(src, /^read_crontab_for\(\) \{$/m, `${name} must not define its own copy`)
  }
})

// ---------------------------------------------------------------------------
// Codex r29 HIGH #1 — THE APPLICATION'S OWN READER FAILS CLOSED TOO
//
// The three shell entrypoints and their thirteen `crontab -l` call sites were swept last round.
// `readOwnCrontab()` in lib/crontab-reconcile.ts — the file this branch is named after — still
// resolved EVERY `execFile` error as `''`, and `applyCrontabFromSettings` spliced the managed block
// into that fabricated empty crontab and handed the result to `crontab -`. A read that failed while
// the WRITE would have succeeded therefore deleted every unmanaged operator line and reported a
// successful reconciliation.
//
// WHAT THESE PIN, and the route each takes:
//   1. LOAD-BEARING. A reconciliation whose read fails REFUSES: no write at all, and the operator's
//      crontab is byte-for-byte what it was
//                     (backup-schedule.tsx -> saveBackupScheduleSettings -> reconcileCrontab
//                      -> applyCrontabFromSettings -> readOwnCrontabResult)
//   2. LOAD-BEARING. A genuinely ABSENT crontab still reconciles, so the refusal above is a
//      decision rather than a reader that refuses everything                     (same route)
//   3. MUTATION. The pre-fix reader, run against the same failing shim, produces the crontab that
//      would have been written — and the operator's line is not in it
//                                        (the shipped spliceOtiBlock over the pre-fix read)
// ---------------------------------------------------------------------------

/** The operator's own entry: the thing a fabricated empty read deletes. */
const APP_OPERATOR_LINE = '17 3 * * * /usr/local/bin/operator-only'

// DYNAMIC, like every other import in this file: a static one is hoisted above the `mock.module`
// calls above, so the real `@/lib/db` would be pulled in before the double is registered.
const crontabSync = () => import('@/lib/crontab-sync')
const crontabReconcile = () => import('@/lib/crontab-reconcile')

async function withReadMode<T>(mode: string | null, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.OTI_TEST_CRONTAB_READ
  if (mode === null) delete process.env.OTI_TEST_CRONTAB_READ
  else process.env.OTI_TEST_CRONTAB_READ = mode
  try {
    return await fn()
  } finally {
    if (saved === undefined) delete process.env.OTI_TEST_CRONTAB_READ
    else process.env.OTI_TEST_CRONTAB_READ = saved
  }
}

test('[o3d-batch-ret] a reconciliation whose crontab READ fails writes nothing, and says so', async () => {
  // A crontab that already holds an operator entry the app does not manage. This is the whole
  // stake: it exists nowhere but here.
  writeFileSync(CRONTAB_FILE, `${APP_OPERATOR_LINE}\n`)
  rmSync(JOURNAL, { force: true })

  // CONTROL, FIRST. With the read working, this exact save reconciles and the operator line
  // SURVIVES the splice — so the refusal below is about the failed read and not about the fixture.
  const control = await withReadMode(null, () => saveBackup(true))
  assert.deepEqual(control, { status: 'saved' },
    `precondition: an ordinary save must reconcile:\n${JSON.stringify(control)}`)
  assert.ok(crontabText().includes(APP_OPERATOR_LINE),
    `precondition: a working read preserves the operator line:\n${crontabText()}`)
  assert.ok(backupLineInstalled(), 'precondition: and it installs the managed job')
  const preserved = crontabText()
  const writesBefore = journal().filter((l) => l === 'write-start').length

  // THE PROPERTY. `crontab -l` fails — not absent, FAILED — while `crontab -` would still have
  // worked perfectly. Nothing may be written.
  const refused = await withReadMode('denied', () => saveBackup(false))
  assert.equal(refused.status, 'post-commit-failed',
    `a reconciliation over an unreadable crontab must not report success:\n${JSON.stringify(refused)}`)
  assert.equal(refused.status === 'post-commit-failed' && refused.step, 'scheduler',
    'and the operator must be told it is the SCHEDULER that is behind')
  assert.match(refused.status === 'post-commit-failed' ? refused.error : '', /could not be read/,
    `and it must say WHY, naming the read:\n${JSON.stringify(refused)}`)
  assert.equal(crontabText(), preserved,
    `THE FINDING: the crontab must be untouched, operator line and all:\n${crontabText()}`)
  assert.equal(journal().filter((l) => l === 'write-start').length, writesBefore,
    'and `crontab -` must not have been invoked at all — the shim journals every invocation')

  // The same for a failure that says nothing whatsoever, which is the shape a timeout or a killed
  // child arrives in.
  const silent = await withReadMode('silent', () => saveBackup(false))
  assert.equal(silent.status, 'post-commit-failed',
    `a read that fails silently is still a failed read:\n${JSON.stringify(silent)}`)
  assert.equal(crontabText(), preserved, `and still writes nothing:\n${crontabText()}`)
})

test('[o3d-batch-ret] a crontab that is genuinely ABSENT still reconciles — the refusal is a decision', async () => {
  // The other direction, and it is not decoration: a reader that treated every non-zero exit as a
  // failure would stop the scheduler working on every fresh box, which have no crontab at all.
  rmSync(CRONTAB_FILE, { force: true })
  rmSync(JOURNAL, { force: true })

  const saved = await withReadMode('absent', () => saveBackup(true))
  assert.deepEqual(saved, { status: 'saved' },
    `"no crontab for <user>" is an ANSWER and must reconcile:\n${JSON.stringify(saved)}`)
  assert.ok(backupLineInstalled(),
    `and the managed job must actually be scheduled:\n${crontabText()}`)
  assert.ok(crontabText().includes((await crontabSync()).OTI_CRON_START_MARKER),
    `written as a managed block:\n${crontabText()}`)
  assert.equal(journal().filter((l) => l === 'write-start').length, 1,
    'exactly one write, into a crontab that provably had nothing in it')
})

test('[o3d-batch-ret] MUTATION: the pre-fix reader turns that failure into an empty crontab, and the splice deletes the operator line', async () => {
  // THE ROUTE, RUN. `readOwnCrontab`'s body as it shipped last round — `resolve(err ? '' : stdout)`
  // — against the SAME shim in the SAME failing state, feeding the SHIPPED splice. Nothing is
  // described: the text that would have been handed to `crontab -` is built here and inspected.
  const preFixRead = (): Promise<string> => new Promise<string>((resolve) => {
    execFile('crontab', ['-l'], { timeout: 5000 }, (err, stdout) => {
      resolve(err ? '' : String(stdout))
    })
  })

  writeFileSync(CRONTAB_FILE, `${APP_OPERATOR_LINE}\n`)
  const blockLines = ['# --- OTI CRON START ---', '0 1 * * * /usr/bin/managed', '# --- OTI CRON END ---']
  const { spliceOtiBlock } = await crontabSync()
  const { readOwnCrontabResult } = await crontabReconcile()

  // CONTROL. With the read working, the pre-fix reader and the shipped one agree, and the splice
  // keeps the operator line — so the loss below is caused by the FAILURE, not by the splice.
  const workingRead = await withReadMode(null, preFixRead)
  assert.ok(workingRead.includes(APP_OPERATOR_LINE), 'precondition: a working read returns the crontab')
  assert.ok(spliceOtiBlock(workingRead, blockLines).includes(APP_OPERATOR_LINE),
    'precondition: and the splice preserves it')

  // THE MUTATION. The read fails; the pre-fix body reports an empty crontab; the splice has nothing
  // to preserve, and `crontab -` would have installed exactly this.
  const wouldHaveWritten = await withReadMode('denied', async () =>
    spliceOtiBlock(await preFixRead(), blockLines))
  assert.ok(!wouldHaveWritten.includes(APP_OPERATOR_LINE),
    `THE LOSS: the operator's only copy of ${APP_OPERATOR_LINE} is not in the text that would have been installed:\n${wouldHaveWritten}`)

  // …and the SHIPPED reader, given the identical failure, produces no text to splice at all.
  const shipped = await withReadMode('denied', () => readOwnCrontabResult())
  assert.equal(shipped.resolved, false,
    `the shipped reader must refuse where the pre-fix one fabricated:\n${JSON.stringify(shipped)}`)

  // …while the benign absence still resolves, which is the boundary the whole rule turns on.
  const absent = await withReadMode('absent', () => readOwnCrontabResult())
  assert.deepEqual(absent, { resolved: true, text: '', present: false },
    `and an absent crontab resolves as an empty one:\n${JSON.stringify(absent)}`)
})

test('[o3d-batch-ret] no application code path reads the crontab without discriminating the failure', async () => {
  // The repository walk, so the next reader added is not a fourth instance of this. `execFile` /
  // `spawn` in the app are allowed; resolving one's ERROR to an empty or default value is not.
  const reconcileSrc = readFileSync(join(REPO_ROOT, 'lib/crontab-reconcile.ts'), 'utf8')
  assert.doesNotMatch(reconcileSrc, /resolve\(\s*err\s*\?\s*''/,
    'lib/crontab-reconcile.ts must not resolve a failed read to the empty string')
  assert.match(reconcileSrc, /isNoCrontabDiagnostic\(/,
    'and it must decide absence with the SAME rule the shell reader uses')

  // The refusal has to come BEFORE the splice, or it is not a refusal.
  const refusalAt = reconcileSrc.indexOf('if (!read.resolved)')
  const spliceAt = reconcileSrc.indexOf('spliceOtiBlock(read.text')
  assert.ok(refusalAt > 0 && spliceAt > refusalAt,
    'applyCrontabFromSettings must abort on an unresolved read before spliceOtiBlock')

  // And nothing anywhere still imports the fabricating reader.
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name === '.next' || e.name.startsWith('.')) return []
    const full = join(dir, e.name)
    if (e.isDirectory()) return walk(full)
    return e.name.endsWith('.ts') || e.name.endsWith('.tsx') ? [full] : []
  })
  const sources = [...walk(join(REPO_ROOT, 'lib')), ...walk(join(REPO_ROOT, 'app'))]
  assert.ok(sources.length > 200, `the walk must actually reach the source tree, saw ${sources.length}`)
  const offenders = sources.filter((f) => /\breadOwnCrontab\b(?!Result)/.test(readFileSync(f, 'utf8')))
  assert.deepEqual(offenders, [], `these still call the fabricating reader:\n${offenders.join('\n')}`)
})

// ---------------------------------------------------------------------------
// Codex r29 HIGH #2 — A MISSING `crontab` BINARY IS NOT AN ABSENT SCHEDULE
//
// `command -v crontab >/dev/null 2>&1 || return 0` opened every cutover fence, on the reasoning
// that a host with no client binary has no per-user crontabs. That reasoning is wrong, and the
// mistake is the point: `crontab(1)` is an EDITOR. The daemon reads the spool directly and keeps
// what it read in memory, so removing the client unschedules nothing — the run walked into the
// database fence and the migration with the schedule fully live.
//
// WHAT THESE PIN, and the route each takes:
//   1. LOAD-BEARING. The cutover fence ABORTS when `crontab` is unavailable and the absence of a
//      schedule cannot be proved, in all three entrypoints        (fence_cron -> require_crontab_command)
//   2. the proof is not vacuous in either direction: it can RETURN 2 (proved), and each of the
//      three things it checks can independently withhold that                (require_crontab_command)
//   3. MUTATION. With the old guard restored, the fence reports success over a live spool entry
// ---------------------------------------------------------------------------

// THE HOST BEING MODELLED IS ONE THAT LOST `crontab`, NOT ONE THAT HAS NOTHING. Everything the
// proof needs to run is here and real; only the client binary is absent. A PATH stripped of `pgrep`
// and `ls` as well would make every probe below refuse for the wrong reason, and the proof branch
// would never be reached at all.
const NO_CRONTAB_BIN = join(FAULT_DIR, 'bin-without-crontab')
mkdirSync(NO_CRONTAB_BIN, { recursive: true })
for (const tool of ['pgrep', 'ls', 'id', 'mktemp', 'cat', 'rm', 'sed', 'tr', 'awk', 'grep', 'flock']) {
  const real = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].map((d) => join(d, tool)).find((c) => existsSync(c))
  if (real) symlinkSync(real, join(NO_CRONTAB_BIN, tool))
}
assert.ok(existsSync(join(NO_CRONTAB_BIN, 'pgrep')) && existsSync(join(NO_CRONTAB_BIN, 'ls')),
  'the no-crontab host must still have the tools the absence proof is made of')
assert.ok(!existsSync(join(NO_CRONTAB_BIN, 'crontab')), 'and it must NOT have a crontab client')

/** Same shipped prelude, with `crontab` genuinely absent from PATH rather than stubbed to fail. */
function withoutCrontabOnPath(program: string): string {
  const line = `PATH='${FAULT_BIN}':"$PATH"`
  assert.equal(program.split(line).length - 1, 1, 'the harness must set PATH exactly once')
  return program.replace(line, `PATH='${NO_CRONTAB_BIN}'`)
}

for (const [where, src] of FAULT_ENTRYPOINTS.map(([w, s]) => [w, s] as [string, string])) {
  test(`[o3d-batch-ret] ${where}: an unavailable \`crontab\` ABORTS the cutover fence`, async () => {
    // PRECONDITION. `crontab` really is unreachable on the PATH this runs with — otherwise the
    // abort below would be about something else entirely.
    const gone = await sh(`PATH='${NO_CRONTAB_BIN}' command -v crontab`)
    assert.notEqual(gone.code, 0, 'the empty bin directory must not resolve a crontab')

    const run = await sh(faultProgram(where, src, 'fence_cron', {
      functions: ['fence_cron'],
      mutate: withoutCrontabOnPath,
    }))
    assert.equal(run.code, 9,
      `the fence must die rather than return success:\n${run.stdout}${run.stderr}`)
    assert.match(run.stderr, /NOTHING HAS BEEN MIGRATED/,
      `and it must say the migration did not happen:\n${run.stderr}`)
    assert.match(run.stderr, /crontab.*not installed/,
      `naming what could not be established:\n${run.stderr}`)

    // CONTROL. With `crontab` on PATH the same function does NOT die here, so the abort is caused
    // by the missing binary and not by a fence that refuses everything.
    writeFileSync(FAULT_CRONTAB, FAULT_ORIGINAL)
    const present = await sh(`export FAKE_CRONTAB_READ=ok\n${faultProgram(where, src,
      'require_crontab_command "$APP_USER"; echo "RC=$?"', { functions: [] })}`)
    assert.match(present.stdout, /^RC=0$/m,
      `with the binary present nothing is refused:\n${present.stdout}${present.stderr}`)
  })
}

/**
 * The shipped library with the ROOT gate stood down, so the spool search below actually runs.
 * `EUID` is readonly in bash and cannot be assigned, and the alternative — a test-only environment
 * hook in the shipped helper — would be a branch production can take. This edits the real source,
 * the same way every other mutation in this file does, and `libraryWith` fails if the line it is
 * asked to replace is not there exactly once.
 */
const ROOT_GATE = '  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then'
const asRootLib = () => libraryWith([[ROOT_GATE, '  if false; then']])

test('[o3d-batch-ret] MUTATION: the old guard reports "no cron writers to fence" over a live spool entry', async () => {
  // THE ROUTE, RUN. The exact line every entrypoint opened its fence with, put back.
  const spool = mkdtempSync(join(FAULT_DIR, 'spool-'))
  writeFileSync(join(spool, 'appuser'), '*/5 * * * * /usr/bin/still-scheduled\n')

  const preFix = (program: string): string =>
    withoutCrontabOnPath(program) + '\nfence_cron() { command -v crontab >/dev/null 2>&1 || return 0; echo UNREACHED; }'
  const run = await sh(faultProgram('scripts/deploy.sh', DEPLOY_SH,
    'fence_cron\necho "FENCE_RC=$?"', { functions: [], mutate: preFix }))
  assert.match(run.stdout, /^FENCE_RC=0$/m,
    `THE FINDING: the fence reports success and the cutover proceeds:\n${run.stdout}${run.stderr}`)
  assert.doesNotMatch(run.stdout, /UNREACHED/, 'and it returned at the guard, having fenced nothing')

  // …and the shipped helper, asked about the same host, refuses and NAMES the spool entry that
  // makes the absence unprovable.
  const shipped = await sh(faultProgram('scripts/deploy.sh', DEPLOY_SH,
    `CRON_SPOOL_ROOTS=('${spool}')\nCRON_DAEMON_NAMES=(no-such-daemon-xyz)\nrequire_crontab_command appuser; echo "RC=$?"\necho "WHY=${'$'}{CRONTAB_COMMAND_REASON}"`,
    { functions: [], mutate: withoutCrontabOnPath, lib: asRootLib() }))
  assert.match(shipped.stdout, /^RC=1$/m,
    `the shipped helper must refuse:\n${shipped.stdout}${shipped.stderr}`)
  assert.match(shipped.stdout, new RegExp(`WHY=.*${spool}/appuser EXISTS`),
    `naming the spooled schedule the missing client cannot reach:\n${shipped.stdout}`)
})

test('[o3d-batch-ret] the no-binary proof is not vacuous: each thing it checks can independently withhold it', async () => {
  const emptySpool = mkdtempSync(join(FAULT_DIR, 'spool-empty-'))
  const NO_DAEMON = 'CRON_DAEMON_NAMES=(no-such-daemon-xyz)'
  const probe = (body: string, lib: string) => sh(faultProgram('scripts/deploy.sh', DEPLOY_SH,
    `${body}\nrequire_crontab_command appuser; echo "RC=$?"\necho "WHY=${'$'}{CRONTAB_COMMAND_REASON}"`,
    { functions: [], mutate: withoutCrontabOnPath, lib }))

  // THE PROVED CASE, so the refusals below are decisions rather than a helper that always refuses.
  // Root, no spool entry, and a daemon name nothing is running under.
  const proved = await probe(`CRON_SPOOL_ROOTS=('${emptySpool}')\n${NO_DAEMON}`, asRootLib())
  assert.match(proved.stdout, /^RC=2$/m,
    `a genuinely cron-less host must be PROVABLE, or the fence can never run without the binary:\n${proved.stdout}${proved.stderr}`)

  // (a) NOT ROOT — the spool is mode 1730 and an unlistable directory reads as an empty one. This
  // one needs no mutation at all: the test runner is not root, and the SHIPPED library refuses.
  const unprivileged = await probe(`CRON_SPOOL_ROOTS=('${emptySpool}')\n${NO_DAEMON}`, CRONTAB_LOCK_LIB)
  assert.match(unprivileged.stdout, /^RC=1$/m, `not being root must withhold the proof:\n${unprivileged.stdout}`)
  assert.match(unprivileged.stdout, /WHY=.*not running as root/, unprivileged.stdout)

  // (b) A DAEMON IS RUNNING. `sleep` stands in for `cron` here, and it is a real running process
  // found by the real `pgrep` — the check is exercised, not simulated.
  const daemon = spawn('sleep', ['30'], { stdio: 'ignore' })
  try {
    await new Promise((r) => setTimeout(r, 200))
    const running = await probe(`CRON_SPOOL_ROOTS=('${emptySpool}')\nCRON_DAEMON_NAMES=(sleep)`, asRootLib())
    assert.match(running.stdout, /^RC=1$/m,
      `a running daemon holds the loaded schedule in memory and must withhold the proof:\n${running.stdout}${running.stderr}`)
    assert.match(running.stdout, /WHY=.*daemon IS running/, running.stdout)
  } finally {
    daemon.kill('SIGKILL')
  }

  // (c) A SPOOL DIRECTORY THAT CANNOT BE LISTED. An unreadable directory is not an empty one.
  const sealed = mkdtempSync(join(FAULT_DIR, 'spool-sealed-'))
  chmodSync(sealed, 0o000)
  try {
    const unreadable = await probe(`CRON_SPOOL_ROOTS=('${sealed}')\n${NO_DAEMON}`, asRootLib())
    assert.match(unreadable.stdout, /^RC=1$/m,
      `an unlistable spool must withhold the proof:\n${unreadable.stdout}${unreadable.stderr}`)
    assert.match(unreadable.stdout, /WHY=.*could not be listed/, unreadable.stdout)
  } finally {
    chmodSync(sealed, 0o700)
  }

  // (d) A SPOOL ROOT THAT DOES NOT EXIST contributes nothing and is not a failure — otherwise the
  // proof could never be given on any real host, since no box has all three roots.
  const absentRoot = await probe(
    `CRON_SPOOL_ROOTS=('${emptySpool}' '${join(FAULT_DIR, 'no-such-spool-root')}')\n${NO_DAEMON}`, asRootLib())
  assert.match(absentRoot.stdout, /^RC=2$/m,
    `a spool root that is not there must not be read as a failure:\n${absentRoot.stdout}${absentRoot.stderr}`)
})

test('[o3d-batch-ret] no cutover fence, adoption or restore path still skips on a missing `crontab`', async () => {
  // The repository walk, so the fourth instance is not written next week. The bare guard is allowed
  // in exactly one place — inside require_crontab_command, which is what asks the question properly.
  for (const [where, src] of FAULT_ENTRYPOINTS.map(([w, s]) => [w, s] as [string, string])) {
    const skipping = src.split('\n')
      .map((line, i) => [i + 1, line] as [number, string])
      .filter(([, line]) => /command -v crontab >\/dev\/null 2>&1 \|\| (return 0|\{)/.test(line))
    assert.deepEqual(skipping, [],
      `${where} still reads a missing crontab client as an absent schedule:\n`
      + skipping.map(([n, l]) => `  ${n}: ${l.trim()}`).join('\n'))
  }
  // …and the one legitimate holder of the bare guard is the helper itself.
  assert.match(CRONTAB_LOCK_LIB_SRC, /if ! command -v crontab >\/dev\/null 2>&1; then/,
    'require_crontab_command / read_crontab_for must still be the place the question is asked')
})
