import { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

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
 * The repository root is derived from THIS FILE'S LOCATION (the nearest ancestor holding package.json), never from
 * the process working directory, which need not be the repo. A temp base that is inside, equal to, or an ancestor
 * of the repository is rejected BEFORE anything is created (a TMPDIR pointing into lib/ would otherwise make the
 * probe a file inside the scanned tree); there is no silent fallback.
 *
 * IDENTITY: the device and inode of the created directory are recorded, and dispose() re-reads them immediately
 * before removal, so a different directory moved into the path afterwards is refused. REMAINING WINDOW, stated
 * honestly: between that last check and the remove call a same-user process could still swap the path; this
 * guard prevents mistakes (a wrong variable, a redirected TMPDIR), not a hostile process running as the same
 * user and racing a test's cleanup, which is out of scope.
 *
 * `options` exist so the guard can be exercised against a throwaway tree standing in for the repo; production
 * use passes none.
 */
const TOP_LEVEL_DIRS = ['app', 'lib', 'tests']

/**
 * The checkout root, found by walking UP from `startDir` (default: this file) and taking the TOPMOST ancestor that
 * satisfies a marker a nested package cannot satisfy: a directory holding package.json AND a `.git` entry (a
 * directory, or a file in a worktree). A package.json nested under tests/ therefore cannot narrow the boundary.
 * With no `.git` anywhere (a source export), the topmost ancestor holding package.json together with the
 * repository's known top-level directories (app, lib, tests) is used instead.
 */
export function findRepoRoot(startDir: string = dirname(fileURLToPath(import.meta.url))): string {
  const ancestors: string[] = []
  for (let dir = realpathSync(startDir); ; ) {
    ancestors.push(dir)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const withMarker = (ok: (dir: string) => boolean) => [...ancestors].reverse().find(ok) // topmost first
  const found = withMarker((dir) => existsSync(join(dir, 'package.json')) && existsSync(join(dir, '.git')))
    ?? withMarker((dir) => existsSync(join(dir, 'package.json')) && TOP_LEVEL_DIRS.every((name) => existsSync(join(dir, name))))
  if (!found) throw new Error('safe-temp-root: cannot locate the repository root from the module location')
  return found
}

export type ScratchRoot = { root: string; dispose: () => void }

export type ScratchRootOptions = { tmpBase?: string; repoRoot?: string }

function isSameOrInside(candidate: string, container: string): boolean {
  const rel = relative(container, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export type DirIdentity = { dev: number; ino: number }

export function assertSafeToDelete(target: string, recorded: string, options: ScratchRootOptions = {}, identity?: DirIdentity): void {
  const tmpBase = realpathSync(options.tmpBase ?? tmpdir())
  const repoRoot = realpathSync(options.repoRoot ?? findRepoRoot())
  const refuse = (why: string): never => {
    throw new Error(`refusing to delete ${JSON.stringify(target)}: ${why}`)
  }
  if (target !== recorded) refuse('it is not the exact path this scratch root created')
  if (!isAbsolute(target) || target.split(sep).includes('..')) refuse('it is not an absolute path free of ".." segments')
  let stat
  try { stat = lstatSync(target) } catch { return refuse('it does not exist as a directory') }
  if (stat.isSymbolicLink()) refuse('it is a symlink')
  if (!stat.isDirectory()) refuse('it is not a directory')
  if (identity && (stat.dev !== identity.dev || stat.ino !== identity.ino)) refuse('it is not the directory this scratch root created (device/inode changed)')
  const real = realpathSync(target)
  if (real === tmpBase || !isSameOrInside(real, tmpBase)) refuse('its real path is not strictly under the temp directory')
  if (isSameOrInside(repoRoot, real)) refuse('it is the repository root or an ancestor of it')
  if (isSameOrInside(real, repoRoot)) refuse('it is inside the repository')
}

export function makeScratchRoot(prefix: string, options: ScratchRootOptions = {}): ScratchRoot {
  // The prefix is a file NAME fragment: it must not be able to steer the new directory out of the checked base.
  if (prefix === '' || /[\\/\0]/.test(prefix) || prefix.split('.').every((part) => part === '') || prefix.includes('..')) {
    throw new Error(`safe-temp-root: refusing prefix ${JSON.stringify(prefix)}: it must be a plain name fragment (no separators, dot segments or NUL)`)
  }
  const base = realpathSync(options.tmpBase ?? tmpdir())
  const repoRoot = realpathSync(options.repoRoot ?? findRepoRoot())
  // Refuse BEFORE creating anything: a temp base inside, equal to, or above the repository would put the probe
  // inside the tree other tests scan (or make it undeletable by the guard).
  if (isSameOrInside(base, repoRoot) || isSameOrInside(repoRoot, base)) {
    throw new Error(`safe-temp-root: refusing to create a scratch root: the temp directory ${JSON.stringify(base)} is inside, equal to, or an ancestor of the repository ${JSON.stringify(repoRoot)}. Point TMPDIR at a directory outside the repository.`)
  }
  const created = mkdtempSync(join(base, prefix))
  if (dirname(created) !== base) {
    rmSync(created, { recursive: true, force: true })
    throw new Error('safe-temp-root: the created directory is not directly under the checked temp base')
  }
  const recorded = created
  const first = lstatSync(created)
  const identity: DirIdentity = { dev: first.dev, ino: first.ino }
  return {
    root: created,
    dispose() {
      assertSafeToDelete(recorded, recorded, options, identity)
      // Verified a moment ago; remove by the canonical path just verified.
      rmSync(realpathSync(recorded), { recursive: true, force: true })
    },
  }
}
