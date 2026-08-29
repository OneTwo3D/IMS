import { spawn } from 'child_process'
import { closeSync, fstatSync, mkdirSync, openSync, statSync } from 'fs'
import path from 'path'

/**
 * ONE CRONTAB RECONCILIATION AT A TIME, ACROSS PROCESSES *AND ACROSS LANGUAGES*
 * (Codex r21 HIGH x2, r22 HIGH x2).
 *
 * WHAT WENT WRONG WITHOUT ANY EXCLUSION. `reconcileCrontab` snapshots the `cron_*` settings and
 * then, separately, reads and rewrites the OS crontab. Six server actions call it, every one of
 * them AFTER its own commit. Two overlapping saves therefore interleaved like this:
 *
 *   A (Backup screen)          B (Scheduled Jobs screen)
 *   commit: backups OFF
 *   snapshot -> OFF
 *                              commit: backups ON
 *                              snapshot -> ON
 *                              write crontab: line INSTALLED
 *   write crontab: line REMOVED     <- from a snapshot taken before B committed
 *
 * Both actions return `saved`. The database, the route and the page all say backups are enabled,
 * and no scheduled invocation exists. Nothing detects it, because a crontab carries no version to
 * compare against, and the inverse interleaving leaves a line nothing will honour.
 *
 * WHY THE LOCK MUST COVER THE SNAPSHOT. Serializing only the crontab write is not enough: A would
 * still hold a reading taken before B committed, still write last, and still win. The lock is held
 * across snapshot -> read crontab -> write crontab, which makes the reconciliation a
 * read-modify-write of one shared artefact and gives the two orders the same answer:
 *
 *   • B waits for A. A's write is stale, B then re-reads the committed state and writes ON. Correct.
 *   • A waits for B. B writes ON, A then re-reads — and reads B's committed ON, not its own stale
 *     snapshot — and writes ON. Correct, because the snapshot is inside the lock.
 *
 * ============================================================================================
 * WHY THIS IS A FILE LOCK AND NOT A POSTGRESQL ADVISORY LOCK (r22).
 *
 * Round 21 built this exclusion out of a session advisory lock. The mechanism was wrong for the
 * resource, and the wrongness produced two separate defects rather than one:
 *
 *   1. A session advisory lock is released the instant its CONNECTION dies — and the write is not
 *      done by this process, it is done by a spawned `crontab -`. Round 21 could only read a
 *      `lost` flag BEFORE the spawn, so a connection that died after that check left the child
 *      still writing with no exclusion at all. A second reconciliation could take the lock, read
 *      newer settings, write, and be overtaken by the first child finishing LAST with its stale
 *      snapshot — the exact end state the lock exists to prevent, reached through the lock.
 *
 *   2. `scripts/install.sh` writes the same crontab. It is shell, it runs as root, and it reaches
 *      that code long before the app is usable — there is no database connection for it to take a
 *      PostgreSQL lock ON. Any exclusion the installer cannot join is an exclusion the crontab
 *      does not have, and the installer is a full read-modify-write of the managed block.
 *
 * Both are the same mismatch: the protected thing is a HOST-LOCAL OS RESOURCE — one user's crontab
 * on one machine — and the exclusion lived in a database that neither the writing process nor the
 * other writer is tied to. `flock(2)` on a file next to the app fits the resource:
 *
 *   • It is held by an OPEN FILE DESCRIPTION, not by a connection, and duplicates of that
 *     description created by fork/exec keep it alive: the kernel releases an flock only when EVERY
 *     duplicate descriptor is closed. So handing the lock fd to the spawned `crontab -` makes the
 *     child's write covered BY CONSTRUCTION — the lock cannot be released while that child lives,
 *     even if this process is killed mid-write. Defect 1 has no window left to re-verify.
 *   • It is takeable from shell with no database at all (`flock -x -w 30 9`), so the installer
 *     joins the SAME protocol on the SAME file rather than getting a second mechanism of its own.
 *     Defect 2 closes with the same lever, not a parallel one.
 *   • It is released by the kernel however the holder dies — crash, OOM kill, SIGKILL — so there
 *     is no stale-lock recovery to get wrong, which is why this is not a hand-rolled pid file.
 *
 * WHAT IS LOST BY THE CHANGE, stated plainly:
 *
 *   • VISIBILITY. A session advisory lock shows up in `pg_locks` with its backend pid; an flock
 *     does not, and no SQL will ever show it. Diagnosing a wedged reconciliation now means
 *     `fuser -v <lock path>` or `grep <inode> /proc/locks` on the host instead of a query. The
 *     path is fixed and derived below so it can be printed; `crontabReconcileLockPath()` is
 *     exported for exactly that.
 *   • DEATH WITH THE CONNECTION. A PostgreSQL lock is freed when the database connection drops
 *     even while the holding process hangs on forever. An flock is freed when the PROCESS dies, so
 *     a wedged app process keeps the crontab lock until it exits. That is the right trade for this
 *     resource — a hung process mid-rewrite is precisely when a second writer must not start — and
 *     the wait below is bounded, so a queued reconciliation reports "the scheduler may be behind"
 *     rather than hanging with it.
 *   • CROSS-HOST REACH. A lock in a shared database would serialize app instances on different
 *     machines. That reach was never useful here and was quietly wrong: each host has its OWN
 *     crontab, so a database lock over-serializes (two hosts editing two different files block each
 *     other) while still under-protecting (the installer). A host-local lock has exactly the scope
 *     of the thing it protects.
 *   • A LOCAL FILESYSTEM ASSUMPTION. `flock` is not reliable over NFS on older kernels; the lock
 *     file lives under the service's systemd `StateDirectory`, which is `/var/lib/...` and local on
 *     every supported install, and this is written down here rather than discovered later.
 *
 * ============================================================================================
 * WHERE THE LOCK FILE LIVES, AND WHY IT IS NOT THE APP DIRECTORY (r23 HIGH).
 *
 * Round 22 put the lock at `path.join(process.cwd(), …)` — the app directory — and proved that
 * choice against a scratch directory in `/tmp`, which is writable. The SHIPPED unit is not:
 * `deploy/systemd/ims-stage.service` sets `ProtectSystem=strict`, which remounts the entire
 * filesystem read-only for the service except for what it names, and it names only
 * `.next`, `uploads` and `public/uploads` under the app tree. `openSync(<appdir>/.lock, 'a')`
 * therefore fails with EROFS on a real hardened install — at the FIRST reconciliation, not at
 * deploy time. And the documented `OTI_CRONTAB_LOCK_PATH` escape hatch made it worse rather than
 * better: `scripts/install.sh` did not read it, so an operator who set it gave the two writers two
 * different locks — the exact "looks locked, excludes nothing" state this protocol exists to remove.
 *
 * The lock now lives under the service's systemd **StateDirectory**, and both writers derive it
 * from that ONE source:
 *
 *   • the application reads `$STATE_DIRECTORY`, which systemd itself sets in the service's
 *     environment from the unit's `StateDirectory=`. Nothing has to be configured for the app and
 *     the unit to agree — systemd is the one telling it.
 *   • `scripts/install.sh` writes `StateDirectory=${APP_NAME}` into the unit it generates and locks
 *     `${DATA_DIR}/locks/.crontab-reconcile.lock`, where `DATA_DIR=/var/lib/${APP_NAME}` is exactly
 *     the path systemd will hand the app in `$STATE_DIRECTORY` (the `locks` component is r24's, and
 *     is explained below).
 *   • `deploy/systemd/ims-stage.service` already declared `StateDirectory=onetwoinventory` for its
 *     backups, so the hardened unit needs no new directory and no new `ReadWritePaths=` entry:
 *     systemd creates a StateDirectory, owns it to the service user at `StateDirectoryMode=`, and
 *     implicitly adds it to `ReadWritePaths=`, so it survives `ProtectSystem=strict` by construction.
 *     `ProtectHome=` does not reach `/var/lib`, and `PrivateTmp=` does not either.
 *
 * The resolved-path agreement between the two writers is asserted — by RESOLVING both, not by
 * comparing basenames — in tests/settings/crontab-reconcile-serialization.test.ts.
 *
 * ============================================================================================
 * AND WHY IT IS IN A SUBDIRECTORY OF IT THAT ROOT OWNS (r24 CRITICAL).
 *
 * Round 23 put the lock file directly in the state directory and had `scripts/install.sh` `touch`,
 * `chown` and `chmod` it as root on every install and upgrade. The state directory is writable by
 * the service user — it has to be, that is the whole reason the lock moved there — so those three
 * root-side operations, all of which follow symlinks, were a privilege-escalation primitive: the
 * unprivileged application account could replace the lock with a symlink to any path on the system
 * and have the next installer run hand it over as `imsapp:imsapp` 0664.
 *
 * The fix rests on a property this module already had. `flock(2)` locks the open file DESCRIPTION
 * regardless of its access mode, which is why `openLockFile` below falls back to a READ-ONLY
 * descriptor. So the service user never needs to write the lock file, and the installer now:
 *
 *   • creates `$STATE_DIRECTORY/locks` as a ROOT-OWNED 0755 directory. The service user cannot
 *     create, replace or remove any entry inside it, so the lock file cannot be swapped for a
 *     symlink at all — the directory, not the file's mode, is what closes the finding;
 *   • creates `$STATE_DIRECTORY/locks/.crontab-reconcile.lock` as a ROOT-OWNED 0644 file, and never
 *     chowns it to the service user;
 *   • performs no root-side operation on either path that follows a symlink (`mkdir` without -p,
 *     an O_CREAT|O_EXCL redirection, lstat checks, `chown -h`, and no `chmod` at all).
 *
 * So on an installed host the application opens the lock file READ-ONLY, via the fallback below,
 * and locks it exactly as before. Outside an install — `next dev`, or a unit deployed by hand —
 * there is no root writer to be protected from and nothing has created the directory, so
 * `openLockFile` creates it and the lock file itself as the service user. Both cases resolve the
 * SAME path, which is the property that makes this one exclusion rather than two.
 *
 * IF THE PATH IS UNWRITABLE ANYWAY, THE RECONCILIATION REFUSES. `acquireCrontabFileLock` returns a
 * failure, `reconcileCrontab` returns `{ success: false, error }` WITHOUT running the
 * read-modify-write, and the caller renders "the scheduler may be behind". A reconciliation that
 * proceeded unserialised would be the defect itself; one that refuses is safe, and the message
 * names the path and the unit directive so the operator is not left guessing.
 */

/**
 * The lock file's name, inside the state directory both writers resolve. That agreement is asserted
 * by tests/settings/crontab-reconcile-serialization.test.ts, because an exclusion whose two
 * participants silently pick different paths is not an exclusion.
 */
export const CRONTAB_RECONCILE_LOCK_FILENAME = '.crontab-reconcile.lock'

/**
 * The directory the lock file sits in, inside the state directory.
 *
 * It exists so that it can be ROOT-OWNED while the state directory around it stays writable by the
 * service user (r24 CRITICAL): an entry in a directory the service user cannot write cannot be
 * replaced by that user, which is what stops the installer's root-side operations from being
 * aimable at another path. `scripts/install.sh` creates both, and asserts both, in section 8.
 */
export const CRONTAB_RECONCILE_LOCK_DIRNAME = 'locks'

/**
 * How long a queued reconciliation waits before giving up.
 *
 * Sized from the critical section it queues behind, not picked round: the holder runs two child
 * processes with a 5s timeout each (`crontab -l`, `crontab -`) plus a handful of local queries, so
 * a legitimate queue clears in well under this and a wait that expires means the holder is wedged
 * rather than busy.
 */
export const CRONTAB_RECONCILE_LOCK_WAIT_MS = 20_000

/**
 * The wait, with an operator override.
 *
 * `OTI_CRONTAB_LOCK_WAIT_MS` exists because the bound above is a claim about how long a `crontab`
 * rewrite takes on this host, and that is an operational property — a box where `crontab` is slow
 * needs a longer one, and the tests that prove an installer holding the lock REFUSES an application
 * reconciliation need a shorter one than a passing test should ever spend. Anything unparseable or
 * non-positive falls back to the constant rather than to no bound at all.
 */
export function crontabReconcileLockWaitMs(): number {
  const raw = process.env.OTI_CRONTAB_LOCK_WAIT_MS?.trim()
  if (!raw) return CRONTAB_RECONCILE_LOCK_WAIT_MS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : CRONTAB_RECONCILE_LOCK_WAIT_MS
}

/** `flock --conflict-exit-code`: this exact status means "could not take it", nothing else. */
const FLOCK_CONFLICT_EXIT_CODE = 75

/** The child fd the lock file is inherited on. `flock <fd>` and nothing else uses it. */
const LOCK_FD_IN_CHILD = 3

/**
 * The service's state directory, as systemd itself reports it.
 *
 * `$STATE_DIRECTORY` is set by systemd from the unit's `StateDirectory=`; it is absolute, and it is
 * COLON-SEPARATED when a unit declares more than one, so the first entry is taken (that is the one
 * the unit names first, and it is the one the installer writes). A value that is not absolute is
 * not systemd's — it is something in the environment wearing the name — and is ignored.
 */
function systemdStateDirectory(): string | null {
  const first = process.env.STATE_DIRECTORY?.split(':')[0]?.trim()
  return first && path.isAbsolute(first) ? first : null
}

/**
 * Where the lock file is.
 *
 * ONE source, in this order:
 *
 *   1. `$STATE_DIRECTORY` — systemd's own answer, and the only one a supported deployment uses. It
 *      is the same directory `scripts/install.sh` locks, because the installer writes the
 *      `StateDirectory=` that produces it. Nothing can be configured to make those two disagree.
 *   2. `OTI_CRONTAB_LOCK_PATH` — TESTS ONLY, and scoped so it cannot become a second protocol on a
 *      real install: systemd's answer above always wins over it, and it is REFUSED outright when
 *      `NODE_ENV=production`. An override that can split the exclusion is worse than no override,
 *      which is the same argument this module already makes about the lock file's inode. A
 *      production process that sets it is told, on stderr, that it was ignored — rather than
 *      quietly locking a file no other writer will ever open.
 *   3. the working directory — a developer running `next dev` outside systemd, where there is no
 *      installer and no second writer to agree with. On a hardened unit this is unwritable, and the
 *      reconciliation then REFUSES rather than proceeding unserialised (see `openLockFile`).
 */
export function crontabReconcileLockPath(): string {
  const stateDir = systemdStateDirectory()
  if (stateDir) {
    return path.join(stateDir, CRONTAB_RECONCILE_LOCK_DIRNAME, CRONTAB_RECONCILE_LOCK_FILENAME)
  }

  const override = process.env.OTI_CRONTAB_LOCK_PATH?.trim()
  if (override) {
    if (process.env.NODE_ENV !== 'production') return override
    console.warn(
      `OTI_CRONTAB_LOCK_PATH=${override} was IGNORED: it is a test-only override, and honouring it in `
      + 'production would give the application and scripts/install.sh two different crontab locks. '
      + 'Set StateDirectory= in the systemd unit instead.',
    )
  }
  return path.join(process.cwd(), CRONTAB_RECONCILE_LOCK_DIRNAME, CRONTAB_RECONCILE_LOCK_FILENAME)
}

/**
 * What the reconciliation may ask the lock while it holds it.
 *
 * `fd` is the whole point: the critical section must hand this descriptor to the `crontab -` child
 * so the exclusion outlives this process. It replaces round 21's `lost` flag, which existed only
 * because that mechanism could lose the lock under a running write.
 */
export type HeldCrontabReconcileLock = {
  /** The open lock file descriptor. Pass it into any child that writes the crontab. */
  readonly fd: number
}

export type CrontabReconcileLockOutcome<T> =
  | { locked: true; result: T }
  | { locked: false; error: string }

/**
 * Open the lock file, creating it — and its directory — if they are not there.
 *
 * THE READ-ONLY FALLBACK IS THE NORMAL PATH ON AN INSTALLED HOST, not a degraded one. `flock(2)`
 * takes an exclusive lock on any descriptor regardless of its access mode, and `scripts/install.sh`
 * relies on exactly that: it creates the lock file root-owned 0644 inside a root-owned directory,
 * so that no root-side operation of its own ever lands on a path this service user could replace
 * with a symlink (r24 CRITICAL). The write open therefore fails with EACCES here, every time, and
 * the read-only open that follows takes the same lock. The fallback also covers a lock file on a
 * read-only bind mount (EROFS — what `ProtectSystem=strict` produces for every path the unit does
 * not open up), which degrades to "still serialized" rather than "silently unserialized".
 *
 * The `mkdir` is best-effort and its failure is deliberately ignored: on an installed host the
 * directory is already there and root-owned, and the open below is the only real answer about
 * whether this process can lock anything. It matters where there was never an installer — `next
 * dev`, or a unit deployed by hand — because there the service user IS the only writer and has to
 * be able to bootstrap the same path the installer would have made.
 *
 * When even the read-only open fails — the usual case being a directory that could not be created
 * and does not exist, so the open is ENOENT — the error PROPAGATES. It is turned into a returned
 * refusal by `acquireCrontabFileLock`, and the crontab is left alone. Proceeding without the lock is
 * the defect this module exists to prevent, so there is deliberately no path here that ends in
 * "carry on without one".
 */
function openLockFile(lockPath: string): number {
  try {
    mkdirSync(path.dirname(lockPath), { recursive: true })
  } catch {
    // Already there (the installed case), or unwritable. The open below is the real answer.
  }
  try {
    return openSync(lockPath, 'a')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (code !== 'EACCES' && code !== 'EROFS') throw error
    return openSync(lockPath, 'r')
  }
}

type FlockOutcome = { ok: true } | { ok: false; conflict: boolean; error: string }

/**
 * Take the exclusive lock on an ALREADY OPEN descriptor, waiting up to `timeoutMs`.
 *
 * `flock(1)` is used in its fd form: the descriptor is inherited by the helper, the helper locks it
 * and exits, and the lock stays held because THIS process still has the same open file description
 * open. That is the same idiom as `exec 9>file; flock 9` in the installer's shell — deliberately,
 * so both writers are doing literally the same thing to the same file.
 *
 * There is no Node core flock, and a native addon for one lock is not worth a build dependency;
 * `flock(1)` is util-linux and is present on every platform this app installs on.
 */
function flockFd(fd: number, timeoutMs: number): Promise<FlockOutcome> {
  const seconds = Math.max(0.001, timeoutMs / 1000)
  return new Promise<FlockOutcome>((resolve) => {
    const proc = spawn(
      'flock',
      ['--exclusive', '--timeout', String(seconds), '--conflict-exit-code', String(FLOCK_CONFLICT_EXIT_CODE), String(LOCK_FD_IN_CHILD)],
      { stdio: ['ignore', 'ignore', 'pipe', fd] },
    )
    let stderr = ''
    proc.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    proc.on('error', (error) => {
      resolve({ ok: false, conflict: false, error: `could not run flock: ${error.message}` })
    })
    proc.on('close', (code) => {
      if (code === 0) return resolve({ ok: true })
      if (code === FLOCK_CONFLICT_EXIT_CODE) return resolve({ ok: false, conflict: true, error: 'timed out' })
      resolve({ ok: false, conflict: false, error: stderr.trim() || `flock exited ${code}` })
    })
  })
}

/**
 * Is the descriptor we locked still the file at that PATH?
 *
 * The one genuine hazard of a file lock: if the lock file is deleted and recreated, a later opener
 * locks a DIFFERENT inode and both writers believe they hold the exclusion. Nothing in this
 * codebase removes it — the installer `touch`es it precisely so the inode survives a re-run — but
 * "nothing does" is the assumption every one of these findings has been about, so it is checked
 * rather than assumed. A mismatch is retried once against the new inode, then reported.
 */
function fdStillMatchesPath(fd: number, lockPath: string): boolean {
  try {
    const byFd = fstatSync(fd)
    const byPath = statSync(lockPath)
    return byFd.ino === byPath.ino && byFd.dev === byPath.dev
  } catch {
    return false
  }
}

type AcquireOutcome = { ok: true; fd: number } | { ok: false; error: string }

async function acquireCrontabFileLock(timeoutMs: number): Promise<AcquireOutcome> {
  const lockPath = crontabReconcileLockPath()
  const deadline = Date.now() + timeoutMs
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd: number
    try {
      fd = openLockFile(lockPath)
    } catch (error) {
      return {
        ok: false,
        error: `Could not open the crontab reconciliation lock file ${lockPath}: `
          + `${error instanceof Error ? error.message : String(error)}. `
          + 'The crontab was NOT changed, because a reconciliation that cannot be serialized can '
          + 'silently discard another writer\'s block. This path is the service\'s systemd '
          + 'StateDirectory plus the lock directory scripts/install.sh creates inside it: check the '
          + `unit declares StateDirectory=, and that ${path.dirname(lockPath)} exists and is `
          + 'readable by the service user (the installer makes it root-owned on purpose, so the '
          + 'file is opened read-only — flock does not need write access).',
      }
    }
    const remaining = Math.max(1, deadline - Date.now())
    const held = await flockFd(fd, remaining)
    if (!held.ok) {
      closeSync(fd)
      return {
        ok: false,
        error: held.conflict
          ? 'Another crontab reconciliation is still running, so this one was not applied. '
            + 'Re-apply from Settings -> System -> Scheduler once it has finished.'
          : `Could not serialize the crontab reconciliation: ${held.error}`,
      }
    }
    if (fdStillMatchesPath(fd, lockPath)) return { ok: true, fd }
    // The lock file was replaced under us; the lock we hold guards an inode nobody else will open.
    closeSync(fd)
  }
  return {
    ok: false,
    error: `The crontab reconciliation lock file ${lockPath} is being replaced repeatedly, so the `
      + 'reconciliation could not be serialized and the crontab was not changed.',
  }
}

/**
 * Run `run` holding the crontab reconciliation lock.
 *
 * A failure to take the lock is RETURNED, not thrown: every caller of the reconciliation is a
 * post-commit step whose contract is an outcome, and "the crontab may now be behind" is one of the
 * outcomes it already renders. A throw from `run` itself propagates untouched — a framework signal
 * raised inside the critical section must not be turned into a scheduler warning.
 *
 * The descriptor is closed in a `finally`, which is the release. If this process dies before that,
 * the kernel closes it; if a `crontab -` child still holds the inherited duplicate, the lock
 * survives until that child exits, which is the property defect 1 needed and could not have.
 */
export async function withCrontabReconcileLock<T>(
  run: (lock: HeldCrontabReconcileLock) => Promise<T>,
): Promise<CrontabReconcileLockOutcome<T>> {
  const acquired = await acquireCrontabFileLock(crontabReconcileLockWaitMs())
  if (!acquired.ok) return { locked: false, error: acquired.error }
  try {
    return { locked: true, result: await run({ fd: acquired.fd }) }
  } finally {
    try {
      closeSync(acquired.fd)
    } catch {
      // Already closed by a dying process; the kernel has released the lock either way.
    }
  }
}
