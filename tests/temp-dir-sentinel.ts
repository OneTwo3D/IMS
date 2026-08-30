/**
 * EVERY UNIT TEST PROCESS GETS ITS OWN THROWAWAY /tmp, AND MUST LEAVE IT EMPTY (o3d-tmpleak).
 *
 * WHAT WENT WRONG. `tests/scripts/` accumulated ~18,000 directories under /tmp over six days,
 * because a harness that forgot to clean up produced no signal at all — the directories simply
 * piled up until somebody noticed the disk.
 *
 * WHAT THIS IS NOT. The first attempt at this was a static rule: `mkdtemp` may appear in one
 * helper and nowhere else in `tests/scripts/`. Measured against the tree as it now stands, that
 * rule would rewrite all 140 raw `mkdtemp` call sites in this directory's harnesses — 139 of
 * which already clean up correctly — in order to reach the 1 that does not. A rule whose output is 99% false alarm is a rule somebody deletes the first
 * week, and it is also the wrong shape: `mkdtemp` is not the defect. A SURVIVING DIRECTORY is the
 * defect, and a static reader cannot see one — the cleanup may be in a `finally` twelve lines
 * down, on an `after` hook, on a parent directory, or (the real leak) absent because the value
 * escapes the function that made it. Any static approximation of "is this one paired with a
 * removal?" is a proximity rule, and a proximity rule in a file with 81 `rmSync` calls passes
 * vacuously for all 68 of its creations.
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
 *   • And every child process launched with a REPLACEMENT environment gets it too — see
 *     `redirect` below, which is what closes the largest hole in the paragraph above.
 *   • On exit, strictly after every other 'exit' listener has run: whatever is still in there did
 *     not get cleaned up. Report it, remove it, and fail the process. Node's test runner reports a
 *     file whose child exits non-zero as a failure and names the file, so the report arrives
 *     attached to the harness that produced it. "After every other listener" is load-bearing and
 *     is why `process.emit` is wrapped rather than a listener added — see `settle` below.
 *
 * IT REMOVES WHAT IT FINDS, which matters more than the exit code: even a run whose failure is
 * ignored cannot leave a second directory behind, so the accumulation that started this is not
 * reachable again regardless of whether anyone acts on the signal. That promise is only worth
 * having if it cannot quietly lapse, so NO FILESYSTEM ERROR IS SWALLOWED: only ENOENT counts as
 * "already removed", and anything else is repaired-and-retried where ownership allows, then named
 * and failed. See `settle`.
 *
 * WHAT IT DOES NOT COVER, stated plainly: a process killed with SIGKILL (nothing in userland
 * survives that, and it is not what happened); a harness that writes to a hard-coded `/tmp/...`
 * rather than to `tmpdir()`; a child handed an explicit `TMPDIR` of its own, which is a visible,
 * deliberate choice and is left alone (`tests/scripts/fence-digest-and-first-install.test.ts`
 * makes it, pointing children at a directory under its own scratch root); and any invocation of
 * the tests that does not go through `npm run test:unit`. `tests/scripts/temp-dir-sentinel.test.ts`
 * asserts that wiring is present in package.json, and proves against real child processes that a
 * leak fails, that a leak from a replacement environment fails, that an unreadable root fails, and
 * that a clean run does not.
 */
import { chmodSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
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

// ---------------------------------------------------------------------------
// A CHILD WITH A REPLACEMENT ENVIRONMENT GETS THE PRIVATE /tmp TOO
// ---------------------------------------------------------------------------

/**
 * REDIRECTING `process.env` ALONE LEAVES A HOLE THE SIZE OF THIS DIRECTORY (Codex MEDIUM).
 *
 * A child that inherits the environment inherits TMPDIR and is covered by the paragraphs above.
 * A child launched with a REPLACEMENT `env` — `{ PATH: … }` — inherits nothing, so `os.tmpdir()`
 * inside it, and `mktemp` inside a shell it runs, resolve to the SYSTEM /tmp, outside `own`.
 * Nothing that child abandons is ever seen or removed. That is not hypothetical here: these
 * harnesses construct child environments constantly, and MEASURED ACROSS `tests/` there are 53
 * spawn-family call sites passing an explicit `env`, of which 7 (all in deploy-order, all running
 * a shell wrapper under a hand-built `{ PATH: … }`) reach no TMPDIR at all today.
 *
 * SEVEN EDITS WOULD BE THE WRONG FIX, for the same reason the static `mkdtemp` ban was: it is a
 * count of today's tree, not a property of it. The other 46 sites reach TMPDIR only incidentally,
 * because they happen to spread `process.env`; any one of them becomes the eighth escape the day
 * somebody trims an environment down. So the redirect is applied where the environment is
 * ASSEMBLED — once, in the one place every child goes through.
 *
 * An `env` that already names TMPDIR is left exactly as it is. Setting one is a deliberate act
 * with a reason behind it (fence-digest-and-first-install points children at a `tmp` inside its
 * own scratch root, and asserts afterwards that nothing outside that root was touched); silently
 * overriding it would break the test that made the choice.
 */
const redirect = (argument: unknown): unknown => {
  if (argument === null || typeof argument !== 'object' || Array.isArray(argument)) return argument
  const options = argument as { env?: unknown }
  const supplied = options.env
  // No `env` at all means the child inherits ours, which already points at `own`.
  if (supplied === null || typeof supplied !== 'object') return argument
  const environment = supplied as NodeJS.ProcessEnv
  if (environment.TMPDIR !== undefined && environment.TMPDIR !== '') return argument
  // A COPY, never a mutation: the caller's object may be reused, asserted on, or frozen.
  return { ...options, env: { ...environment, TMPDIR: own } }
}

type Spawner = (...args: unknown[]) => unknown

/**
 * `util.promisify`'s opt-out, which `execFile` carries and three harnesses use. Wrapping the
 * function without carrying this forward would silently downgrade `promisify(execFile)` to the
 * generic callback contract — one resolved value instead of `{ stdout, stderr }` — so the custom
 * implementation is wrapped in its turn rather than dropped or passed through unredirected.
 */
const PROMISIFY_CUSTOM = Symbol.for('nodejs.util.promisify.custom')

/**
 * The REAL module object, not the ES namespace: under this toolchain `import * as` yields a copy,
 * and assigning to a copy patches nothing. Every consumer — a transpiled `import { spawnSync }`,
 * a true-ESM named import, `require()` — reads through the object this hands back.
 */
const childProcess = createRequire(`${process.cwd()}/`)('node:child_process') as Record<string, Spawner>

for (const name of ['exec', 'execFile', 'execFileSync', 'execSync', 'fork', 'spawn', 'spawnSync']) {
  const original = childProcess[name]
  if (typeof original !== 'function') continue

  const redirected = function redirectedSpawn(this: unknown, ...args: unknown[]) {
    return original.apply(this, args.map(redirect))
  } as Spawner & Record<symbol, unknown>

  const promisified = (original as unknown as Record<symbol, unknown>)[PROMISIFY_CUSTOM]
  if (typeof promisified === 'function') {
    redirected[PROMISIFY_CUSTOM] = function redirectedPromise(this: unknown, ...args: unknown[]) {
      return (promisified as Spawner).apply(this, args.map(redirect))
    }
  }

  childProcess[name] = redirected
}

// ---------------------------------------------------------------------------
// WHAT IS LEFT WHEN THE PROCESS IS GENUINELY FINISHED
// ---------------------------------------------------------------------------

/** How many repair-and-retry rounds a permission problem gets before it is called unrecoverable. */
const REPAIRS = 3

const isMissing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'

const describe = (error: unknown): string => {
  const failure = error as NodeJS.ErrnoException | null
  return failure?.code !== undefined ? `${failure.code} (${failure.message})` : String(error)
}

/**
 * Make the tree readable and writable again as far as this uid is allowed to.
 *
 * A harness that chmods a scratch directory — several here do, because file modes are the thing
 * under test — can leave a descendant that `readdirSync` and `rmSync` cannot traverse. Where the
 * entry is ours, restoring the mode is enough. Where it is not (a file left by a child running as
 * another uid), `chmodSync` throws EPERM, this ignores it, and the caller's next attempt fails for
 * real and reports the root — which is the point: the failure becomes visible instead of vanishing.
 */
const loosen = (path: string): void => {
  try {
    chmodSync(path, 0o700)
  } catch {
    // Not ours to repair. The retry that follows will fail and be reported.
  }
  let entries
  try {
    entries = readdirSync(path, { withFileTypes: true })
  } catch {
    return
  }
  // `isDirectory()` is false for a symlink to one, so this never follows a link out of the tree.
  for (const entry of entries) if (entry.isDirectory()) loosen(join(path, entry.name))
}

/**
 * Whatever is left when the process is genuinely finished.
 *
 * NOTHING HERE FAILS OPEN (Codex MEDIUM). The first version caught every `readdirSync` error
 * and returned as though the root were gone, and swallowed every `rmSync` error — so a permission
 * or ownership problem on the sentinel's own root produced a CLEAN REPORT over a directory it
 * could not read, and a root that could not be removed accumulated one per run: precisely the
 * fail-open shape, and precisely the accumulation, this file exists to make unreachable. Only
 * ENOENT is treated as "already removed"; every other error is repaired-and-retried where this
 * uid is allowed to, and then named and failed either way.
 */
const settle = (): void => {
  let leftovers: readonly string[] | null = null
  let unreadable: string | null = null

  for (let attempt = 0; attempt <= REPAIRS; attempt += 1) {
    try {
      leftovers = readdirSync(own).filter((entry) => !TOOLCHAIN.test(entry))
      break
    } catch (error) {
      // The ONLY error that means "already removed": a harness removed `tmpdir()` itself, which is
      // its own problem but not a leak, and there is nothing left to measure.
      if (isMissing(error)) return
      // Recorded on the FIRST failure and kept even if a later attempt succeeds. A root that went
      // unreadable mid-run is itself the defect — the count below was taken through a repair the
      // sentinel had to make, and a run that says nothing about that is the fail-open again.
      unreadable ??= describe(error)
      try {
        chmodSync(own, 0o1777)
      } catch {
        // Not ours. The next attempt fails for real and the report below says so.
      }
    }
  }

  // Remove first, and unconditionally: the exit code is advisory, the removal is the part that
  // stops the accumulation. Failing to remove must not mask the report below — but it must not be
  // silent either, so an unremovable root is carried down to the report as residue.
  let residue: string | null = null
  for (let attempt = 0; attempt <= REPAIRS; attempt += 1) {
    try {
      rmSync(own, { recursive: true, force: true })
      residue = null
      break
    } catch (error) {
      residue = describe(error)
      loosen(own)
    }
  }

  const problems: string[] = []
  if (unreadable !== null) problems.push(`could not enumerate ${own}: ${unreadable}`)
  if (residue !== null) problems.push(`could not remove ${own}: ${residue}`)

  if (problems.length === 0 && leftovers !== null && leftovers.length === 0) return

  // A test file that already failed keeps its own exit code; this only speaks when nothing else did.
  if (process.exitCode === undefined || process.exitCode === 0) process.exitCode = 1

  const subject = process.argv[1] ?? '<unknown entry point>'

  for (const problem of problems) {
    process.stderr.write(
      `temp-dir sentinel: ${problem}\n` +
        `The sentinel could not do its job over its own root during ${subject}, so a clean report ` +
        'from this run would not have meant anything. Repairing the mode and retrying is already ' +
        'attempted; what is left needs an owner who can read or remove the path named above.\n',
    )
  }

  if (leftovers === null || leftovers.length === 0) return

  const listed = leftovers.slice().sort().map((entry) => `  ${entry}`)
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
 * own set from an `exit` hook, and the first version of this file reported the directories it was
 * in the middle of removing as leaks — 16 in install-rerun-preserves-credentials, 2 in
 * deploy-order.
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
