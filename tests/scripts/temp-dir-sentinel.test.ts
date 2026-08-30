/**
 * THE SENTINEL IS INSTALLED, IT FAILS A LEAK, AND IT DOES NOT FAIL A CLEAN RUN (o3d-tmpleak).
 *
 * This replaces a static rule that banned `mkdtemp` outside one helper. That rule was measured
 * against the tree it was meant to police and would have rewritten all 140 raw `mkdtemp` call
 * sites in that directory's harnesses, 139 of which already clean up, to reach the 1 that did not — see `tests/temp-dir-sentinel.ts` for
 * why a static reader cannot do better, and why the shape of the check moved from the CALL to the
 * SURVIVING DIRECTORY.
 *
 * WHY THIS IS NOT VACUOUS. It is not a walk over source text that could silently find nothing.
 * Every assertion below is a measurement of a real child process running the real sentinel:
 *
 *   • the leaking fixture is RUN, and the run must fail — and the fixture's own assertion passes,
 *     so the failure can only be the sentinel's;
 *   • the sentinel's report must name the abandoned directory, so a run that failed for some
 *     unrelated reason does not count as a pass here;
 *   • the abandoned directory must be GONE afterwards, which is the half that actually stops the
 *     accumulation and cannot be faked by an exit code;
 *   • the clean fixture is RUN, and must SUCCEED — a sentinel that had been reduced to failing
 *     unconditionally, or that had stopped looking at anything, fails this;
 *   • `package.json` must still load the sentinel, because a guard nothing imports guards nothing.
 *
 * MUTATION ROUTES (each performed and re-run while writing this):
 *   1. delete `process.exitCode = 1` from the sentinel -> 'a leak fails the run' fails.
 *   2. delete the `rmSync` from the sentinel -> 'and the leaked directory is removed' fails.
 *   3. make the sentinel fail unconditionally -> 'a clean run is not failed' fails.
 *   4. drop `--import` from test:unit -> 'the sentinel is loaded by test:unit' fails.
 *   5. add a leaking `mkdtempSync` to any harness under tests/ -> that harness's own file fails
 *      under `npm run test:unit`, which is the case this whole mechanism exists for; the fixture
 *      above is that change, made permanently and in a file the glob does not collect.
 *   6. delete the `node:child_process` redirect from the sentinel -> 'a child given a replacement
 *      environment cannot escape' fails: the grandchild's directory is created in the SYSTEM /tmp,
 *      is never reported, and is still there afterwards.
 *   7. delete `loosen(own)` from the sentinel's removal retry -> 'an unremovable leftover is
 *      repaired' fails: the 0-mode descendant defeats `rmSync` and the whole private root survives.
 *   8. restore the sentinel's blanket `catch { return }` around `readdirSync(own)` -> 'an
 *      unreadable root fails the run' fails: the run exits 0 having reported nothing.
 *   9. put the sentinel's `settle()` back after the emit call instead of in a `finally` -> 'a leak
 *      is still swept when an exit listener throws' fails: the throw carries past the sweep, so
 *      nothing is reported and the private root is still there afterwards.
 *  10. restore `if (environment.TMPDIR !== undefined && environment.TMPDIR !== '') return argument`
 *      -> 'a child given a TMPDIR outside the private root cannot escape' fails: the child's
 *      directory is made in the system /tmp, is never reported and is never removed. Make the
 *      redirect unconditional instead and the same test fails from the other side, on the
 *      contained child resolving the private root rather than the directory it was handed.
 *  11. restore the pathname repair — `if (entry.isDirectory()) chmodSync(join(path, entry.name),
 *      0o700)` -> 'the repair does not follow a symlink swapped in after the type check' fails:
 *      the victim directory outside the private root comes back 0700 (10 of 10 runs measured;
 *      the descriptor repair leaves it 0755 in 20 of 20).
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const SENTINEL = './tests/temp-dir-sentinel.ts'
const FIXTURES = 'tests/scripts/fixtures'
const LEAKY = 'leaks-a-temp-dir.fixture.ts'
const CLEAN = 'cleans-up-its-temp-dir.fixture.ts'
const ENV_LEAKY = 'leaks-from-a-replacement-environment.fixture.ts'
const LOCKED = 'leaves-an-unreadable-directory.fixture.ts'
const HIDDEN_ROOT = 'hides-its-temp-root.fixture.ts'
const EXIT_THROW = 'throws-from-an-exit-listener.fixture.ts'
const EXTERNAL = 'escapes-an-external-tmpdir.fixture.ts'
const SWAP = 'swaps-a-symlink-under-the-repair.fixture.ts'

/**
 * ROOT READS AND REMOVES REGARDLESS OF MODE, so the two mode-based fixtures below cannot be built
 * as uid 0 — a directory chmodded to 0 is still fully traversable. Skipped there, with the reason
 * said out loud, rather than passed vacuously.
 */
const AS_ROOT = process.getuid?.() === 0
const MODES_ARE_INERT =
  'running as uid 0: a 0-mode directory is still readable and removable, so the failure this ' +
  'measures cannot be produced on this host'

/**
 * The repair re-permissions through PINNED DESCRIPTORS, which is `O_PATH` plus `/proc/self/fd` and
 * therefore Linux's. Elsewhere the sentinel repairs nothing and reports the removal failure, which
 * is the fail-closed direction but not what these two measure — so they say so instead of failing.
 */
const PINS = process.platform === 'linux'
const NO_PINNING =
  'the descriptor-pinned repair needs O_PATH and /proc/self/fd, which this platform does not have'
const NEEDS_REPAIR = AS_ROOT ? MODES_ARE_INERT : PINS ? false : NO_PINNING

/** A synchronous pause, in a file whose measurements are all of synchronous child processes. */
const pause = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Duplicated from the fixture rather than imported, deliberately: importing it would REGISTER the
 * fixture's `test()` in this process, and it would then leak here instead of in the child, which
 * is neither what is being measured nor something this file could then assert about. The
 * duplication is held honest by the first assertion of the leak test, which reads the fixture and
 * requires the prefix to still be the one it passes.
 */
const LEAKED_PREFIX = 'ims-fixture-leak-'

interface Run {
  readonly status: number | null
  readonly output: string
}

/** The real runner, the real sentinel, one fixture, from the repository root. */
function runFixture(fixture: string, extra: Record<string, string> = {}): Run {
  // NODE_TEST_CONTEXT is set in every process the test runner spawns, and a runner that sees it
  // refuses to run files ("run() is being called recursively") — which would leave the child
  // silent and every assertion below measuring an empty string. Dropping it is what makes the
  // child a real, independent run.
  const env = { ...process.env, ...extra }
  delete env.NODE_TEST_CONTEXT

  const result = spawnSync(
    join(process.cwd(), 'node_modules/.bin/tsx'),
    ['--test', '--import', SENTINEL, join(FIXTURES, fixture)],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 120_000, env },
  )
  assert.equal(result.error, undefined, `could not run ${fixture}: ${result.error?.message}`)
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

test('the sentinel is loaded by test:unit', () => {
  // Enforcement lives in the invocation, so this is the assertion that says the mechanism is
  // reachable at all. Everything below proves it works; this proves it runs.
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }
  const unit = pkg.scripts['test:unit']
  assert.ok(unit !== undefined, 'package.json has no test:unit script')
  assert.match(
    unit,
    /--import\s+\.\/tests\/temp-dir-sentinel\.ts/,
    `test:unit must load the sentinel, or nothing is watching /tmp during a unit run: ${unit}`,
  )
})

test('a leak fails the run, and the fixture itself does not', () => {
  // The fixture really does abandon a directory under this prefix — so a report that names it
  // cannot be matching a prefix nothing creates any more.
  const fixture = readFileSync(join(FIXTURES, LEAKY), 'utf8')
  assert.match(fixture, new RegExp(`mkdtempSync\\([^)]*${LEAKED_PREFIX}|LEAKED_PREFIX`), `${LEAKY} no longer makes a directory`)
  assert.ok(fixture.includes(`'${LEAKED_PREFIX}'`), `${LEAKY} no longer uses ${LEAKED_PREFIX}`)
  assert.ok(!/\brmSync\b|\brm\(/.test(fixture), `${LEAKY} must not clean up — that is the defect it exists to reproduce`)

  const before = new Set(readdirSync(tmpdir()))
  const run = runFixture(LEAKY)

  // ATTRIBUTION. The fixture's own assertion passed and NOTHING in the child threw; the file is
  // marked failed purely by the process exit code the sentinel set. Establishing this first is
  // what makes the failure below the sentinel's rather than the fixture's — a fixture that failed
  // on its own would fail the run with or without a sentinel, and prove nothing.
  assert.match(
    run.output,
    /^ok \d+ - the assertion itself passes; only the directory is wrong$/m,
    `the fixture's own assertion must pass:\n${run.output}`,
  )
  assert.ok(
    !/ERR_ASSERTION/.test(run.output),
    `nothing in the fixture may throw — the only defect is the abandoned directory:\n${run.output}`,
  )
  assert.match(
    run.output,
    /^\s*exitCode: 1$/m,
    `the file must be failed by the process exit code, which is the sentinel's only lever:\n${run.output}`,
  )

  assert.notEqual(run.status, 0, `an abandoned directory must fail the run:\n${run.output}`)
  assert.match(run.output, /temp-dir leak: 1 entry survived/, `and say so:\n${run.output}`)
  assert.match(
    run.output,
    new RegExp(`\\b${LEAKED_PREFIX}`),
    `and name the directory, so the creating call can be found from the report alone:\n${run.output}`,
  )

  // THE HALF THAT ACTUALLY STOPS THE ACCUMULATION, and the one an exit code cannot fake: the run
  // that just leaked left NOTHING behind in this process's /tmp. Written as "no new entry at all"
  // rather than "no ims-fixture-leak-*" on purpose — the abandoned directory lives inside the
  // child's own private TMPDIR, so looking only for its name would pass while the private
  // directory itself, and everything in it, survived. Toolchain scratch is excluded by exact name
  // because tsx and Node create it lazily and it belongs to neither run.
  const toolchain = /^(?:tsx-\d+|node-compile-cache)$/
  const survivors = readdirSync(tmpdir())
    .filter((entry) => !before.has(entry) && !toolchain.test(entry))
    .sort()
  assert.deepEqual(
    survivors,
    [],
    `the sentinel reported the leak but did not remove it — ${survivors.join(', ')} outlived the run`,
  )
})

test('a clean run is not failed', () => {
  const run = runFixture(CLEAN)
  assert.equal(
    run.status,
    0,
    'a harness that removes what it makes must pass — a sentinel that fails everything is not a ' +
      `guard, it is an outage:\n${run.output}`,
  )
  assert.ok(!/temp-dir leak/.test(run.output), `and nothing to report:\n${run.output}`)
})

/**
 * A fixture's CODE, with its comments removed.
 *
 * The shape assertions below are about what a fixture DOES. Each of these fixtures has to explain
 * in prose the escape it reproduces — which means naming `rmSync`, or TMPDIR — and a guard that
 * read the raw file would fail on the explanation rather than on the behaviour.
 */
const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1')

/**
 * THE HOLE THE REDIRECT CLOSES, measured rather than argued (Codex MEDIUM).
 *
 * Pointing `process.env.TMPDIR` at the private root covers every child that INHERITS the
 * environment. A child launched with a REPLACEMENT one — `{ PATH: … }`, which is how these
 * harnesses run shell wrappers — inherits nothing, so its `os.tmpdir()` was the system /tmp and
 * anything it abandoned there was invisible to the sentinel: not reported, and, far worse, not
 * removed. `tests/` has 53 spawn-family call sites passing an explicit `env`; 7 reach no TMPDIR at
 * all today, and the other 46 reach it only because they happen to spread `process.env`.
 *
 * This is not a re-reading of the sentinel's source. A real grandchild, under a real replacement
 * environment, really does abandon a directory — and the assertions are that the sentinel SAW it
 * and that the directory is GONE.
 */
test('a child given a replacement environment cannot escape the private /tmp', () => {
  // The fixture must still hand its child an environment that carries no TMPDIR — otherwise this
  // whole test would be measuring the inheriting path the sibling fixture already covers.
  const fixture = withoutComments(readFileSync(join(FIXTURES, ENV_LEAKY), 'utf8'))
  assert.match(fixture, /env:\s*\{\s*PATH:/, `${ENV_LEAKY} must launch its child with a replacement environment`)
  assert.ok(
    !/env:\s*\{[^}]*process\.env/.test(fixture),
    `${ENV_LEAKY} must not spread process.env into the child — that is the covered case, not this one`,
  )
  assert.ok(!/TMPDIR/.test(fixture), `${ENV_LEAKY} must not hand the child a TMPDIR of its own`)
  assert.ok(!/\brmSync\b|\brm\(/.test(fixture), `${ENV_LEAKY} must not clean up — that is the defect it reproduces`)

  const before = new Set(readdirSync(tmpdir()))
  const run = runFixture(ENV_LEAKY)

  // ATTRIBUTION, as above: the fixture's own assertions pass, so the failure is the sentinel's.
  assert.match(
    run.output,
    /^ok \d+ - the assertion itself passes; only the grandchild's directory is wrong$/m,
    `the fixture's own assertion must pass:\n${run.output}`,
  )
  assert.ok(!/ERR_ASSERTION/.test(run.output), `nothing in the fixture may throw:\n${run.output}`)

  assert.notEqual(run.status, 0, `a directory abandoned by the grandchild must fail the run:\n${run.output}`)
  assert.match(run.output, /temp-dir leak: 1 entry survived/, `and say so:\n${run.output}`)
  assert.match(run.output, /\bims-fixture-envleak-/, `and name it:\n${run.output}`)

  // WHERE IT LANDED, which is the redirect itself and cannot be faked by an exit code: the
  // grandchild computed this path from ITS OWN environment, and it is inside the test process's
  // private root. Without the redirect it reads `/tmp/ims-fixture-envleak-…` and this fails.
  const announced = /ENVLEAK_AT=(\S+)/.exec(run.output)?.[1]
  assert.ok(announced !== undefined, `the grandchild must announce what it made:\n${run.output}`)
  assert.match(
    announced,
    /\/ims-unit-[^/]+\//,
    'the grandchild\'s temporary directory must sit inside a sentinel root, not the system /tmp',
  )

  // AND IT IS GONE. The half that stops the accumulation.
  assert.ok(!existsSync(announced), `the sentinel must have removed it, but ${announced} is still there`)

  const toolchain = /^(?:tsx-\d+|node-compile-cache)$/
  const survivors = readdirSync(tmpdir())
    .filter((entry) => !before.has(entry) && !toolchain.test(entry))
    .sort()
  assert.deepEqual(survivors, [], `and nothing outlived the run — ${survivors.join(', ')} did`)
})

/**
 * REMOVAL THAT FAILS MUST NOT FAIL SILENTLY (Codex MEDIUM).
 *
 * `rmSync` cannot recurse into a directory it may not traverse, and the first version of the
 * sentinel swallowed that error. The private root then survived — one per run, which is the
 * accumulation this file exists to make unreachable, arriving through the guard's own error
 * handling. The fixture abandons a two-level 0-mode tree; the sentinel must repair the modes it
 * owns, retry, and leave nothing.
 */
test('an unremovable leftover is repaired and removed, not swallowed', { skip: NEEDS_REPAIR }, () => {
  const fixture = withoutComments(readFileSync(join(FIXTURES, LOCKED), 'utf8'))
  assert.match(fixture, /chmodSync\([^)]*0o000\)/, `${LOCKED} must leave something untraversable`)
  assert.ok(!/\brmSync\b|\brm\(/.test(fixture), `${LOCKED} must not clean up — that is the defect it reproduces`)

  const before = new Set(readdirSync(tmpdir()))
  const run = runFixture(LOCKED)

  assert.match(
    run.output,
    /^ok \d+ - the assertion itself passes; only the abandoned directory is unreadable$/m,
    `the fixture's own assertion must pass:\n${run.output}`,
  )
  assert.ok(!/ERR_ASSERTION/.test(run.output), `nothing in the fixture may throw:\n${run.output}`)

  assert.notEqual(run.status, 0, `an abandoned directory must fail the run whatever its mode:\n${run.output}`)
  assert.match(run.output, /temp-dir leak: 1 entry survived/, `and say so:\n${run.output}`)
  assert.match(run.output, /\bims-fixture-locked-/, `and name it:\n${run.output}`)

  // THE POINT. Either the repair worked and nothing survived, or the sentinel said out loud that
  // it could not remove the root — never a clean report over a directory that is still there.
  const toolchain = /^(?:tsx-\d+|node-compile-cache)$/
  const survivors = readdirSync(tmpdir())
    .filter((entry) => !before.has(entry) && !toolchain.test(entry))
    .sort()
  assert.deepEqual(
    survivors,
    [],
    `the sentinel could not remove what it reported — ${survivors.join(', ')} outlived the run:\n${run.output}`,
  )
  assert.ok(
    !/temp-dir sentinel: could not remove/.test(run.output),
    `and it should not have needed to give up:\n${run.output}`,
  )
})

/**
 * THE FAIL-OPEN INSIDE THE GUARD (Codex MEDIUM).
 *
 * `readdirSync` throwing was treated as "the root is already gone", so a permission or ownership
 * error produced a CLEAN REPORT over a directory the sentinel could not read — the exact failure
 * it exists to catch, in its own implementation, and with the root left behind on top. Only ENOENT
 * may mean "already removed"; anything else is named and fails the run, after the modes this uid
 * owns have been repaired so the removal can still happen.
 */
test('an unreadable root fails the run rather than reporting it clean', { skip: NEEDS_REPAIR }, () => {
  const fixture = withoutComments(readFileSync(join(FIXTURES, HIDDEN_ROOT), 'utf8'))
  assert.match(fixture, /chmodSync\(root, 0o000\)/, `${HIDDEN_ROOT} must make the sentinel's own root unreadable`)
  assert.match(fixture, /process\.on\('exit'/, 'and must do it at exit, or it breaks the run instead of the guard')

  const before = new Set(readdirSync(tmpdir()))
  const run = runFixture(HIDDEN_ROOT)

  assert.match(
    run.output,
    /^ok \d+ - the assertion itself passes; only the temp root is left unreadable$/m,
    `the fixture's own assertion must pass:\n${run.output}`,
  )
  assert.ok(!/ERR_ASSERTION/.test(run.output), `nothing in the fixture may throw:\n${run.output}`)

  assert.notEqual(run.status, 0, `a root the sentinel cannot read must fail the run:\n${run.output}`)
  assert.match(
    run.output,
    /temp-dir sentinel: could not enumerate \S*ims-unit-\S*: EACCES/,
    `and name the root and the error, so it can be acted on:\n${run.output}`,
  )
  assert.ok(
    !/temp-dir leak: /.test(run.output),
    `and not silently claim a count it could not take:\n${run.output}`,
  )

  // AND THE ROOT IS STILL GONE: failing is the signal, repairing the mode is what stops the
  // accumulation, and the finding is that the first version did neither.
  const toolchain = /^(?:tsx-\d+|node-compile-cache)$/
  const survivors = readdirSync(tmpdir())
    .filter((entry) => !before.has(entry) && !toolchain.test(entry))
    .sort()
  assert.deepEqual(survivors, [], `the unreadable root outlived the run — ${survivors.join(', ')}`)
})

/**
 * A THROWING EXIT LISTENER MUST NOT SKIP THE SWEEP (Codex MEDIUM).
 *
 * The sweep runs from a wrapper around `process.emit('exit')` so that it is strictly last. Written
 * as a sequence — emit, then sweep — that only held when every listener RETURNED: EventEmitter
 * stops delivering the moment one throws, and the throw carried out of the wrapper past the sweep.
 * A process dying badly is exactly when residue is likeliest, so the guard did nothing in the case
 * that needed it most, and the accumulation came back one private root per failing run. The sweep
 * is now in a `finally`, which is what this measures: a real process, a real leak, a real throw.
 */
test('a leak is still swept when an exit listener throws', () => {
  const fixture = withoutComments(readFileSync(join(FIXTURES, EXIT_THROW), 'utf8'))
  assert.match(
    fixture,
    /process\.on\('exit',\s*\(\)\s*=>\s*\{\s*throw/,
    `${EXIT_THROW} must throw from an exit listener — that is the whole mechanism under test`,
  )
  assert.ok(!/\brmSync\b|\brm\(/.test(fixture), `${EXIT_THROW} must not clean up — that is the defect it reproduces`)

  const before = new Set(readdirSync(tmpdir()))
  const run = runFixture(EXIT_THROW)

  // THE THROW REALLY HAPPENED. Without this the test would pass just as well against a fixture
  // whose listener had quietly stopped throwing, which is the vacuous version of it.
  assert.match(
    run.output,
    /ims-fixture-exit-listener-exploded/,
    `the exit listener must actually throw:\n${run.output}`,
  )
  assert.match(
    run.output,
    /^ok \d+ - the assertion itself passes; only the directory is wrong, and the exit is loud$/m,
    `and the fixture's own assertion must pass, so the leak is the only defect:\n${run.output}`,
  )

  // AND THE SWEEP STILL RAN, both halves of it. Reported…
  assert.notEqual(run.status, 0, `an abandoned directory must fail the run:\n${run.output}`)
  assert.match(run.output, /temp-dir leak: 1 entry survived/, `and said so:\n${run.output}`)
  assert.match(run.output, /\bims-fixture-exitthrow-/, `and named it:\n${run.output}`)

  // …and REMOVED, which is the half the accumulation actually depends on.
  const announced = /EXITTHROW_AT=(\S+)/.exec(run.output)?.[1]
  assert.ok(announced !== undefined, `the fixture must announce what it abandoned:\n${run.output}`)
  assert.ok(!existsSync(announced), `the sentinel must have removed it, but ${announced} is still there`)

  const toolchain = /^(?:tsx-\d+|node-compile-cache)$/
  const survivors = readdirSync(tmpdir())
    .filter((entry) => !before.has(entry) && !toolchain.test(entry))
    .sort()
  assert.deepEqual(
    survivors,
    [],
    `a run that died on the way out left its private root behind — ${survivors.join(', ')}`,
  )
})

/**
 * AN EXPLICIT TMPDIR IS NOT A LICENCE TO LEAVE THE PRIVATE ROOT (Codex MEDIUM).
 *
 * The redirect exempted any child whose environment already named a TMPDIR, on the reasoning that
 * setting one is a deliberate act. The reasoning was about ONE harness, which points children at a
 * directory inside its own scratch root; the implementation exempted EVERY value, `/tmp` included —
 * so the escape the redirect exists to close was available to anything that wrote it down. What
 * earns the exemption is containment, not presence, and both directions are measured here in one
 * process: an external value must be replaced, and a contained value must survive untouched.
 */
test('a child given a TMPDIR outside the private root cannot escape, and a contained one is left alone', () => {
  const fixture = withoutComments(readFileSync(join(FIXTURES, EXTERNAL), 'utf8'))
  assert.match(fixture, /TMPDIR:\s*'\/tmp'/, `${EXTERNAL} must hand a child an EXTERNAL TMPDIR`)
  assert.match(fixture, /TMPDIR:\s*scratch/, `${EXTERNAL} must also hand one a CONTAINED TMPDIR`)

  const before = new Set(readdirSync(tmpdir()))
  const systemBefore = new Set(readdirSync('/tmp'))
  const run = runFixture(EXTERNAL)

  assert.match(
    run.output,
    /^ok \d+ - the assertion itself passes; only the child's directory is wrong$/m,
    `the fixture's own assertions must pass:\n${run.output}`,
  )
  assert.ok(!/ERR_ASSERTION/.test(run.output), `nothing in the fixture may throw:\n${run.output}`)

  // THE CONTAINED CASE IS UNTOUCHED. A redirect applied to everything would pass every assertion
  // below and break the one harness this exemption exists for, so it is measured first: the child
  // resolved exactly the directory it was given, not the private root.
  const asked = /CONTAINED_ASKED=(\S+)/.exec(run.output)?.[1]
  const resolved = /CONTAINED_RESOLVED=(\S+)/.exec(run.output)?.[1]
  assert.ok(asked !== undefined && resolved !== undefined, `both children must announce:\n${run.output}`)
  assert.equal(
    resolved,
    asked,
    'a TMPDIR already inside the private root is a deliberate choice with assertions resting on ' +
      'it, and must be passed through exactly as given',
  )

  // THE EXTERNAL CASE IS CONTAINED. Without the containment test this reads /tmp/ims-fixture-outside-…
  const escaped = /OUTSIDE_AT=(\S+)/.exec(run.output)?.[1]
  assert.ok(escaped !== undefined, `the escaping child must announce what it made:\n${run.output}`)
  assert.match(
    escaped,
    /\/ims-unit-[^/]+\//,
    `a child pointed at an external TMPDIR must still land inside a sentinel root, not ${escaped}`,
  )

  // SEEN, SAID, AND GONE.
  assert.notEqual(run.status, 0, `and the leak must fail the run:\n${run.output}`)
  assert.match(run.output, /temp-dir leak: 1 entry survived/, `and be reported:\n${run.output}`)
  assert.match(run.output, /\bims-fixture-outside-/, `and named:\n${run.output}`)
  assert.ok(!existsSync(escaped), `the sentinel must have removed it, but ${escaped} is still there`)

  const toolchain = /^(?:tsx-\d+|node-compile-cache)$/
  const survivors = readdirSync(tmpdir())
    .filter((entry) => !before.has(entry) && !toolchain.test(entry))
    .sort()
  assert.deepEqual(survivors, [], `and nothing outlived the run — ${survivors.join(', ')} did`)

  // AND NOTHING REACHED THE REAL /tmp, which is where the un-contained value pointed. Named by
  // prefix rather than by "no new entry", because /tmp is shared with the rest of the machine.
  const escapedToSystem = readdirSync('/tmp')
    .filter((entry) => !systemBefore.has(entry) && entry.startsWith('ims-fixture-outside-'))
    .sort()
  assert.deepEqual(
    escapedToSystem,
    [],
    `the child's directory reached the system /tmp — ${escapedToSystem.join(', ')}`,
  )
})

/**
 * THE REPAIR MUST NOT FOLLOW A LINK PUT THERE AFTER THE TYPE CHECK (Codex MEDIUM).
 *
 * The repair walk read `if (entry.isDirectory()) chmodSync(join(path, entry.name), 0o700)`, and
 * `readdirSync` snapshots every name and type in a single call while the chmods that follow are
 * separate lookups made one at a time afterwards. The header's claim that the walk never follows a
 * link was therefore true of the check and false of the operation: anything able to write in the
 * directory in between — and the sentinel deliberately makes its root 1777 — could replace a
 * reported directory with a symlink and have the repair chmod an arbitrary same-uid target to
 * 0700, as whatever uid runs the tests, which in CI is root.
 *
 * THE RACE IS BUILT, NOT ARGUED, and two things had to be true before it could be observed at all.
 * The swapper must already be in its loop when the sweep starts — a detached process boots for
 * longer than a whole sweep lasts, and the first version of this measured a swapper that was still
 * starting up and passed against the very repair it was written to catch, ten runs in a row. And
 * the walk must be the slower of the two, or it finishes an entire pass inside one
 * all-directories phase and never sees a link; the abandoned names therefore hold subtrees, which
 * is what took the hit rate from 6 runs in 10 to 10 in 10.
 *
 * MEASURED BOTH WAYS. With the pathname chmod restored the victim directory outside the private
 * root came back 0700 in 10 runs out of 10. With the descriptor repair it stayed 0755 in 20 runs
 * out of 20 — and not by winning the race but by not being in one: the walk opens every directory
 * with `O_DIRECTORY | O_NOFOLLOW`, which IS the type check, and changes the mode of the inode that
 * descriptor holds rather than of a name looked up again afterwards.
 *
 * Removal completeness is deliberately not asserted here — a process actively recreating entries
 * can defeat any removal, and that half is measured by the unremovable-leftover test above. This
 * one measures where the writes landed.
 */
test('the repair does not follow a symlink swapped in after the type check', { skip: NEEDS_REPAIR }, () => {
  const fixture = withoutComments(readFileSync(join(FIXTURES, SWAP), 'utf8'))
  assert.match(fixture, /symlinkSync\(victim, name\)/, `${SWAP} must swap symlinks in during the sweep`)
  assert.match(fixture, /chmodSync\(join\(abandoned, 'blocked'\), 0o000\)/, `${SWAP} must force the repair to run`)
  assert.ok(!/\brmSync\b/.test(fixture), `${SWAP} must not clean up — that is the defect it reproduces`)

  // OUTSIDE THE CHILD'S PRIVATE ROOT, which is what makes a chmod on it an escape: the child makes
  // its own `ims-unit-…` root under this process's tmpdir, and this arena is that root's sibling.
  const arena = mkdtempSync(join(tmpdir(), 'ims-swaprace-'))
  const victim = join(arena, 'victim')
  const ready = join(arena, 'ready')
  const done = join(arena, 'done')
  mkdirSync(victim)
  chmodSync(victim, 0o755)

  const before = new Set(readdirSync(tmpdir()))
  try {
    const run = runFixture(SWAP, { IMS_SWAP_VICTIM: victim, IMS_SWAP_READY: ready, IMS_SWAP_DONE: done })

    assert.match(
      run.output,
      /^ok \d+ - the assertion itself passes; only the abandoned tree is being rewritten$/m,
      `the fixture's own assertion must pass:\n${run.output}`,
    )
    assert.ok(!/ERR_ASSERTION/.test(run.output), `nothing in the fixture may throw:\n${run.output}`)

    // THE PRECONDITION, asserted rather than assumed: the repair only runs when a removal fails,
    // so a run that reported no leftovers never walked anything and would pass vacuously.
    assert.notEqual(run.status, 0, `the abandoned tree must fail the run:\n${run.output}`)
    assert.match(run.output, /temp-dir leak: 1 entry survived/, `and be reported:\n${run.output}`)
    assert.match(run.output, /\bims-fixture-swap-/, `and named:\n${run.output}`)

    // THE RACE REALLY WAS ONE. The fixture blocks until the swapper is in its loop, so this
    // marker existing before the run ended is the evidence that the sweep and the swapping
    // overlapped — without it the first version of this fixture measured a swapper that had not
    // finished booting, and passed against the very repair it was written to catch.
    assert.ok(existsSync(ready), 'the swapper must have reached its loop before the sweep ran')

    // Let it finish before measuring, so the mode read below is a settled one and the cleanup
    // underneath cannot race a process still putting directories back.
    for (let waited = 0; waited < 300 && !existsSync(done); waited += 1) pause(50)
    assert.ok(existsSync(done), 'the swapper must have finished, or nothing here was concurrent')

    // THE MEASUREMENT. Nothing in the sweep may write outside the root it owns.
    assert.equal(
      (statSync(victim).mode & 0o777).toString(8),
      '755',
      `the repair followed a symlink out of the private root and re-permissioned ${victim}`,
    )
  } finally {
    // Whatever the sweep could not remove while it was being rewritten is this test's to clear —
    // otherwise the sentinel watching THIS process would report it, correctly, as a leak.
    const toolchain = /^(?:tsx-\d+|node-compile-cache)$/
    for (const entry of readdirSync(tmpdir())) {
      if (before.has(entry) || toolchain.test(entry)) continue
      const path = join(tmpdir(), entry)
      spawnSync('chmod', ['-R', 'u+rwX', path])
      rmSync(path, { recursive: true, force: true })
    }
    spawnSync('chmod', ['-R', 'u+rwX', arena])
    rmSync(arena, { recursive: true, force: true })
  }
})
