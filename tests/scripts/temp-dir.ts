/**
 * A THROWAWAY DIRECTORY WHOSE REMOVAL IS REGISTERED AT THE MOMENT IT IS CREATED (o3d-tmpleak).
 *
 * WHY THIS EXISTS. `tests/scripts/` accumulated ~18,000 directories under /tmp over six days,
 * because a harness that forgot to clean up produced no signal at all. Most harnesses here do
 * clean up, in a `finally` or on a `t.after`; this is for the ones that CANNOT, because the
 * directory has to outlive the scope that made it — `layoutInvocation` in deploy-order.test.ts
 * builds a staging directory and returns a COMMAND STRING that will later run out of it, so there
 * is no `finally` to put an `rmSync` in. That was the one site in this directory that still
 * leaked, and it is the shape this exists for.
 *
 * IT IS NOT THE GUARD. An earlier attempt made it one, by banning `mkdtemp` everywhere in this
 * directory but here. Measured against the tree, that rule would have failed the build on 151
 * call sites that already clean up correctly in order to reach the 1 that did not. The guard is
 * now `tests/temp-dir-sentinel.ts`, which measures what actually survives a test process instead
 * of reading source, and this file is a convenience that makes the awkward case easy to get right
 * — so use it where a scope exists too, but a plain `mkdtemp` with a `finally` is not a defect.
 *
 * CLEANUP RUNS ON FAILURE TOO, which is the case that matters — a harness that only removes on the
 * happy path leaks exactly when something went wrong and kept going wrong. Two idempotent
 * mechanisms, so neither is load-bearing alone:
 *
 *   • `t.after(...)`, when a TestContext is passed. Node's test runner runs `after` hooks whether
 *     the test passed or threw, and it runs them as soon as that test ends, so a file of 40 tests
 *     holds one directory at a time rather than 40. PASS `t` WHEREVER THERE IS ONE.
 *   • `process.on('exit')`, always. It fires on a passing run, on a failing run (the runner still
 *     exits normally, with status 1) and on an explicit `process.exit`. It is the whole mechanism
 *     for callers with no TestContext to give. The sentinel deliberately looks AFTER every exit
 *     listener has run, so directories drained here are not reported as leaks — an ordinary
 *     `process.on('exit')` in the sentinel saw all 18 of them mid-removal and reported them.
 *
 * Neither survives SIGKILL. Nothing in a test process does, and that is not the leak that happened.
 *
 * NOTHING HERE IS KEPT ON FAILURE. Keeping the fixture of a failing test is a real debugging aid
 * and a real unbounded leak, and the leak is what this file is about; a harness that wants the
 * evidence should print it, not abandon it in /tmp.
 */import { mkdtempSync, rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'

/** Directories created and not yet removed. Drained by the exit hook. */
const pending = new Set<string>()

let exitHookInstalled = false

/**
 * Remove one directory, at most once, and never fail a test on its own cleanup: a harness that
 * threw has already reported something more useful than an EBUSY from the tidy-up.
 */
function remove(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Already gone, or held by something outside this process. The next run's exit hook cannot
    // retry it, but a directory that resists `rm -rf` is not the failure mode this guards.
  }
  pending.delete(dir)
}

function track(dir: string, t: TestContext | undefined): string {
  pending.add(dir)
  if (!exitHookInstalled) {
    exitHookInstalled = true
    // Synchronous by necessity: nothing asynchronous is awaited during 'exit'.
    process.on('exit', () => {
      for (const leftover of [...pending]) remove(leftover)
    })
  }
  t?.after(() => remove(dir))
  return dir
}

/**
 * A throwaway directory whose removal is already registered.
 *
 * Pass `t` wherever the test has one — the directory then goes at the end of THAT test instead of
 * at the end of the file. Omit it in a module-level helper that has no TestContext to thread; the
 * exit hook still removes it.
 */
export function createTempDirSync(prefix: string, t?: TestContext): string {
  return track(mkdtempSync(join(tmpdir(), prefix)), t)
}

/** The `node:fs/promises` form of {@link createTempDirSync}, with the same guarantees. */
export async function createTempDir(prefix: string, t?: TestContext): Promise<string> {
  return track(await mkdtemp(join(tmpdir(), prefix)), t)
}

/**
 * The scoped form, for a helper that wants the directory gone the moment its own work is done
 * rather than at the end of the test or the run. The `finally` and the exit hook agree, because
 * `remove` is idempotent.
 */
export async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await createTempDir(prefix)
  try {
    return await fn(dir)
  } finally {
    remove(dir)
  }
}
