/**
 * ONE PLACE THAT CREATES A THROWAWAY DIRECTORY IN `tests/scripts/`, AND REMOVES IT (o3d-tmpleak).
 *
 * WHY THIS EXISTS. Every harness here used to call `mkdtemp` itself and arrange its own removal —
 * some with `t.after`, some with `try`/`finally`, three with nothing at all. A per-harness
 * convention is not a convention: it is a thing each new file gets to decide again, and three of
 * them decided not to. That left ~18,000 directories under /tmp, the oldest six days old, and the
 * count only ever went up because nothing failed when a harness forgot.
 *
 * So creation and removal are the SAME call. A harness cannot obtain a directory from here without
 * its removal already being registered, and `tests/scripts/temp-dir-discipline.test.ts` fails the
 * build if a `mkdtemp` appears in this directory anywhere but this file.
 *
 * CLEANUP RUNS ON FAILURE TOO, which is the case that matters — a harness that only removes on the
 * happy path leaks exactly when something went wrong and kept going wrong. Two independent
 * mechanisms, both idempotent, so neither is load-bearing alone:
 *
 *   • `t.after(...)`, when a TestContext is passed. Node's test runner runs `after` hooks whether
 *     the test passed or threw, and it runs them as soon as that test ends, so a file of 40 tests
 *     holds one directory at a time rather than 40.
 *   • `process.on('exit')`, always. It fires on a passing run, on a failing run (the runner still
 *     exits normally, with status 1) and on an explicit `process.exit`. It is the whole mechanism
 *     for callers with no TestContext to give — which is what makes this adoptable by an existing
 *     harness as a one-line change, rather than a restructuring nobody will do.
 *
 * Neither survives SIGKILL. Nothing in a test process does, and that is not the leak that happened.
 *
 * NOTHING HERE IS KEPT ON FAILURE. Keeping the fixture of a failing test is a real debugging aid
 * and a real unbounded leak, and the leak is what this file is about; a harness that wants the
 * evidence should print it, not abandon it in /tmp.
 */
import { mkdtempSync, rmSync } from 'node:fs'
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
