import { accessSync, chmodSync, constants, mkdtempSync, realpathSync, rmdirSync, statSync } from 'node:fs'
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

/** Where tests/temp-dir-sentinel.ts looks for per-process scratch directories that were not cleaned up. */
export const SCRATCH_DIRS_KEY = Symbol.for('ims.test.scratchDirs')

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

const perProcess = new Map<string, string>()
let exitHookInstalled = false

/** A private (0700) directory of this process under `base`, created once. The sentinel reports and removes what survives in it. */
function processDirUnder(base: string): string {
  const known = perProcess.get(base)
  if (known !== undefined) return known
  const dir = mkdtempSync(path.join(base, 'ims-s-'))
  chmodSync(dir, 0o700)
  perProcess.set(base, dir)
  const g = globalThis as Record<symbol, unknown>
  const tracked = (g[SCRATCH_DIRS_KEY] ??= new Set<string>()) as Set<string>
  tracked.add(dir)
  if (!exitHookInstalled) {
    exitHookInstalled = true
    // Without the sentinel (an ad hoc run) an empty directory still must not pile up; a non-empty one stays for the sentinel / the owner to see.
    process.on('exit', () => {
      for (const d of perProcess.values()) {
        try { rmdirSync(d) } catch { /* not empty or gone */ }
      }
    })
  }
  return dir
}

/**
 * The parent directory for test scratch material (throwaway Postgres clusters, report directories, temp trees):
 * a private per-process directory (`ims-s-XXXXXX`, mode 0700) under the first of these that names an existing directory
 * this account can write to:
 *   1. IMS_SCRATCH_ROOT (a RAM disk on the build host);
 *   2. the TMPDIR the process started with (see ORIGINAL_TMPDIR_VAR: the unit-tier sentinel replaces TMPDIR);
 *   3. os.tmpdir().
 * /var/tmp, or anything under it, is never a candidate (it is on the SSD): a candidate there is skipped, and if nothing
 * else is usable the call throws. Real operator report directories that must survive a reboot keep /var/tmp, but they
 * are operator defaults and not scratch.
 *
 * The per-process directory lets tests/temp-dir-sentinel.ts see a test that forgot to clean up: whatever is still in it
 * at exit is reported, the process fails, and the directory is removed.
 *
 * The base must be root-owned and sticky (1777) like /tmp: the report-directory trust checks refuse any other
 * writable ancestor (the per-process directory is owned by this account and not writable by others, which they accept).
 * The path must be short (MAX_SCRATCH_ROOT_LENGTH) because the cluster's unix-socket path lives below it; a longer one is
 * refused with a message that names the fix, rather than failing later inside Postgres.
 */
export function scratchRoot(): string {
  const base = [process.env.IMS_SCRATCH_ROOT, process.env[ORIGINAL_TMPDIR_VAR], tmpdir()].find(usable)
  if (base === undefined) throw new Error('no usable scratch root (the SSD-backed temp directory is refused): set IMS_SCRATCH_ROOT to a short, writable, root-owned sticky directory')
  const known = perProcess.get(base)
  const projected = known ?? path.join(base, 'ims-s-XXXXXX')
  if (projected.length > MAX_SCRATCH_ROOT_LENGTH) {
    throw new Error(`scratch root ${projected} is ${projected.length} bytes; a Postgres unix-socket path under it would exceed the ~107 byte limit. Set IMS_SCRATCH_ROOT to a shorter directory (at most ${MAX_SCRATCH_ROOT_LENGTH - 'ims-s-XXXXXX/'.length} bytes, e.g. /scratch/ram/tmp).`)
  }
  return known ?? processDirUnder(base)
}
