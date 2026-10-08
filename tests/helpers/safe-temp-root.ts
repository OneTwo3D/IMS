import { lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * A SCRATCH DIRECTORY WITH A DELETION BOUNDARY.
 *
 * Tests that need to write files create them in a private directory under the OS temp dir, never inside the
 * repository. A recursive delete with no boundary is how a redirected variable removes a live worktree, so
 * `dispose()` deletes ONLY the exact directory this call created, and refuses (throws, deletes nothing) unless
 * every one of these holds at the moment of deletion:
 *   - it is the very path recorded when it was created (a closure, not a mutable field);
 *   - it is an absolute, normalised path with no `..` segment;
 *   - it is NOT a symlink;
 *   - its real path lies strictly under realpath(tmpdir);
 *   - it is neither the repository root nor an ancestor of it (nor inside it).
 *
 * `options` exist so the guard can be exercised against a throwaway tree standing in for the repo; production
 * use passes none.
 */
export type ScratchRoot = { root: string; dispose: () => void }

export type ScratchRootOptions = { tmpBase?: string; repoRoot?: string }

function isSameOrInside(candidate: string, container: string): boolean {
  const rel = relative(container, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export function assertSafeToDelete(target: string, recorded: string, options: ScratchRootOptions = {}): void {
  const tmpBase = realpathSync(options.tmpBase ?? tmpdir())
  const repoRoot = realpathSync(options.repoRoot ?? process.cwd())
  const refuse = (why: string): never => {
    throw new Error(`refusing to delete ${JSON.stringify(target)}: ${why}`)
  }
  if (target !== recorded) refuse('it is not the exact path this scratch root created')
  if (!isAbsolute(target) || target.split(sep).includes('..')) refuse('it is not an absolute path free of ".." segments')
  let stat
  try { stat = lstatSync(target) } catch { return refuse('it does not exist as a directory') }
  if (stat.isSymbolicLink()) refuse('it is a symlink')
  if (!stat.isDirectory()) refuse('it is not a directory')
  const real = realpathSync(target)
  if (real === tmpBase || !isSameOrInside(real, tmpBase)) refuse('its real path is not strictly under the temp directory')
  if (isSameOrInside(repoRoot, real)) refuse('it is the repository root or an ancestor of it')
  if (isSameOrInside(real, repoRoot)) refuse('it is inside the repository')
}

export function makeScratchRoot(prefix: string, options: ScratchRootOptions = {}): ScratchRoot {
  const base = realpathSync(options.tmpBase ?? tmpdir())
  const created = mkdtempSync(join(base, prefix))
  const recorded = created
  return {
    root: created,
    dispose() {
      assertSafeToDelete(recorded, recorded, options)
      rmSync(recorded, { recursive: true, force: true })
    },
  }
}
