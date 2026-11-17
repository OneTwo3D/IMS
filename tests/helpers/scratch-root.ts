import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * Environment variable the unit-tier temp-dir sentinel (tests/temp-dir-sentinel.ts) sets to the TMPDIR the process
 * started with, before it swaps TMPDIR for its own private per-process directory. That private directory is not a
 * trustworthy ancestor for the report-directory checks (it is group/other-writable and owned by the test account), so
 * scratch material is anchored on the original TMPDIR instead.
 */
export const ORIGINAL_TMPDIR_VAR = 'IMS_TEST_ORIGINAL_TMPDIR'

/**
 * The longest scratch root a throwaway cluster can sit under. A Postgres unix-socket path is limited to about 107
 * bytes, and the longest cluster below a root is `<prefix, up to ~30 bytes>/pg/sock/.s.PGSQL.<port>` (about 55 bytes).
 */
export const MAX_SCRATCH_ROOT_LENGTH = 48

/** The SSD-backed directory that scratch must never use (write-heavy throwaway clusters wore it out). */
const FORBIDDEN = '/var/tmp'

function realOrSelf(dir: string): string {
  try {
    return realpathSync(dir)
  } catch {
    return path.resolve(dir)
  }
}

/** /var/tmp itself or anything under it, by path (and by real path, so a symlink into it counts). Not by device: CI's /tmp may share a filesystem. */
function underForbidden(dir: string): boolean {
  const forbidden = new Set([FORBIDDEN, realOrSelf(FORBIDDEN)])
  return [path.resolve(dir), realOrSelf(dir)].some((candidate) => [...forbidden].some((f) => candidate === f || candidate.startsWith(`${f}${path.sep}`)))
}

function usable(dir: string | undefined): dir is string {
  if (!dir) return false
  if (underForbidden(dir)) return false
  try {
    if (!statSync(dir).isDirectory()) return false
    accessSync(dir, constants.W_OK | constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The parent directory for test scratch material (throwaway Postgres clusters, report directories, temp trees):
 * the first of these that names an existing directory this account can write to:
 *   1. IMS_SCRATCH_ROOT (a RAM disk on the build host);
 *   2. the TMPDIR the process started with (see ORIGINAL_TMPDIR_VAR: the unit-tier sentinel replaces TMPDIR);
 *   3. os.tmpdir().
 * /var/tmp, or anything under it (by path or through a symlink), is never a candidate (it is on the SSD): a candidate
 * there is skipped, and if nothing else is usable the call throws. Real operator report directories that must survive a
 * reboot keep /var/tmp, but they are operator defaults and not scratch.
 *
 * Leak detection: tests/temp-dir-sentinel.ts records every directory this process creates with mkdtemp outside its own
 * private TMPDIR (which is where everything made under this root lands) and, at exit, reports, removes and fails on any
 * that survived. Nothing extra is nested here: the cluster's unix-socket path is already close to its limit.
 *
 * The directory must be root-owned and sticky (1777) like /tmp: the report-directory trust checks refuse any other
 * writable ancestor. Its path must be short (MAX_SCRATCH_ROOT_LENGTH) because the cluster's unix-socket path lives below it;
 * a longer one is refused with a message that names the fix, rather than failing later inside Postgres.
 */
export function scratchRoot(): string {
  const root = [process.env.IMS_SCRATCH_ROOT, process.env[ORIGINAL_TMPDIR_VAR], tmpdir()].find(usable)
  if (root === undefined) throw new Error('no usable scratch root (the SSD-backed temp directory is refused): set IMS_SCRATCH_ROOT to a short, writable, root-owned sticky directory')
  if (root.length > MAX_SCRATCH_ROOT_LENGTH) {
    throw new Error(`scratch root ${root} is ${root.length} bytes; a Postgres unix-socket path under it would exceed the ~107 byte limit. Set IMS_SCRATCH_ROOT to a shorter directory (at most ${MAX_SCRATCH_ROOT_LENGTH} bytes, e.g. /scratch/ram/tmp).`)
  }
  return root
}
