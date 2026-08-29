/**
 * EVERY UNIT TEST PROCESS GETS ITS OWN THROWAWAY /tmp, AND MUST LEAVE IT EMPTY (o3d-tmpleak).
 *
 * WHAT WENT WRONG. `tests/scripts/` accumulated ~18,000 directories under /tmp over six days,
 * because a harness that forgot to clean up produced no signal at all — the directories simply
 * piled up until somebody noticed the disk.
 *
 * WHAT THIS IS NOT. The first attempt at this was a static rule: `mkdtemp` may appear in one
 * helper and nowhere else in `tests/scripts/`. Measured against the tree as it now stands, that
 * rule fails the build on 151 call sites that already clean up correctly in order to reach the
 * one that does not. A rule whose output is 99% false alarm is a rule somebody deletes the first
 * week, and it is also the wrong shape: `mkdtemp` is not the defect. A SURVIVING DIRECTORY is the
 * defect, and a static reader cannot see one — the cleanup may be in a `finally` twelve lines
 * down, on an `after` hook, on a parent directory, or (the real leak) absent because the value
 * escapes the function that made it. Any static approximation of "is this one paired with a
 * removal?" is a proximity rule, and a proximity rule in a file with 82 `rmSync` calls passes
 * vacuously for all 69 of its creations.
 *
 * SO THIS MEASURES INSTEAD OF READING. Loaded with `--import` from `npm run test:unit`, it runs
 * once in every test process — Node's test runner passes `--import` down to the child it spawns
 * per test file, so each file is observed separately and cannot be blamed for its neighbour.
 *
 *   • On import, before any test code runs: create a private directory and point `TMPDIR` at it.
 *     `os.tmpdir()` re-reads the environment on every call, so from here on EVERY temporary path
 *     this process computes — `mkdtemp`, `mkdtempSync`, a bare `mkdirSync(join(tmpdir(), …))`, a
 *     library's own scratch file, a child process that inherits the environment — lands inside it.
 *     That is strictly more than the static rule covered, which only ever saw `mkdtemp`.
 *   • On exit, strictly after every other 'exit' listener has run: whatever is still in there did
 *     not get cleaned up. Report it, remove it, and fail the process. Node's test runner reports a
 *     file whose child exits non-zero as a failure and names the file, so the report arrives
 *     attached to the harness that produced it. "After every other listener" is load-bearing and
 *     is why `process.emit` is wrapped rather than a listener added — see `settle` below.
 *
 * IT REMOVES WHAT IT FINDS, which matters more than the exit code: even a run whose failure is
 * ignored cannot leave a second directory behind, so the accumulation that started this is not
 * reachable again regardless of whether anyone acts on the signal.
 *
 * WHAT IT DOES NOT COVER, stated plainly: a process killed with SIGKILL (nothing in userland
 * survives that, and it is not what happened); a harness that writes to a hard-coded `/tmp/...`
 * rather than to `tmpdir()`; and any invocation of the tests that does not go through
 * `npm run test:unit`. `tests/scripts/temp-dir-sentinel.test.ts` asserts that wiring is present
 * in package.json, and proves against a real child process that a leak fails and a clean run does
 * not.
 */
import { chmodSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Created by the toolchain rather than by a harness, and therefore not a leak to report. Kept as
 * exact names rather than a pattern so that it cannot quietly grow into a way to hide one: tsx
 * writes `tsx-<uid>` for its transpile output and Node writes `node-compile-cache`, both lazily,
 * so both can appear after TMPDIR has been redirected. Anything else is the harness's.
 */
const TOOLCHAIN = /^(?:tsx-\d+|node-compile-cache)$/

const own = mkdtempSync(join(tmpdir(), 'ims-unit-'))

/**
 * `/tmp` IS 1777, AND HARNESSES DEPEND ON THAT. `mkdtemp` creates 0700, which silently changes
 * what the tests can observe: install-password-probe-discrimination asserts that a published CA
 * is "readable by every uid on this host", and under a 0700 ancestor that is false for a reason
 * that has nothing to do with the code under test. Five of its assertions failed the first time
 * this ran. Mirroring /tmp's mode exactly is what keeps the sentinel an observer.
 */
chmodSync(own, 0o1777)

process.env.TMPDIR = own

/**
 * Whatever is left when the process is genuinely finished.
 */
const settle = (): void => {
  let leftovers: string[]
  try {
    leftovers = readdirSync(own).filter((entry) => !TOOLCHAIN.test(entry))
  } catch {
    // The directory is already gone — a harness removed `tmpdir()` itself, which is its own
    // problem but not a leak, and there is nothing left to measure.
    return
  }

  // Remove first, and unconditionally: the exit code is advisory, the removal is the part that
  // stops the accumulation. Failing to remove must not mask the report below.
  try {
    rmSync(own, { recursive: true, force: true })
  } catch {
    // Held open by something outside this process. Reported below if it had contents.
  }

  if (leftovers.length === 0) return

  // A test file that already failed keeps its own exit code; this only speaks when nothing else did.
  if (process.exitCode === undefined || process.exitCode === 0) process.exitCode = 1

  const subject = process.argv[1] ?? '<unknown entry point>'
  const listed = leftovers.sort().map((entry) => `  ${entry}`)
  process.stderr.write(
    `temp-dir leak: ${leftovers.length} ` +
      `entr${leftovers.length === 1 ? 'y' : 'ies'} survived ${subject}:\n${listed.join('\n')}\n` +
      'Each name begins with the prefix its creating call passed, so grep the file above for that ' +
      'prefix. Remove it where it is made — or, where the directory outlives the scope that made ' +
      'it, obtain it from tests/scripts/temp-dir.ts, whose creation and removal are one call.\n',
  )
}

/**
 * STRICTLY AFTER EVERY OTHER 'exit' LISTENER, which a plain `process.on('exit')` cannot be.
 *
 * Listeners run in registration order and this module is loaded by `--import`, i.e. before any
 * test file — so an ordinary listener here runs FIRST and sees the directories that exit-time
 * cleanup is about to remove. That is not a hypothetical: `tests/scripts/temp-dir.ts` drains its
 * own set from an `exit` hook, and the first version of this file reported all 18 of the
 * directories it was in the middle of removing as leaks.
 *
 * Wrapping `emit` is what makes "still there at exit" mean it, rather than meaning "still there
 * at the moment the earliest-registered listener happened to look". It also holds for cleanup
 * this file knows nothing about — a library's own exit handler, a future harness's.
 */
const emit = process.emit.bind(process)
process.emit = function sentinelEmit(this: unknown, name: string | symbol, ...args: unknown[]) {
  const delivered = emit(name as never, ...(args as never[]))
  if (name === 'exit') settle()
  return delivered
} as typeof process.emit
