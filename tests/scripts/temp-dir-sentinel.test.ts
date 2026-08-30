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
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
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
function runFixture(fixture: string): Run {
  // NODE_TEST_CONTEXT is set in every process the test runner spawns, and a runner that sees it
  // refuses to run files ("run() is being called recursively") — which would leave the child
  // silent and every assertion below measuring an empty string. Dropping it is what makes the
  // child a real, independent run.
  const env = { ...process.env }
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
test('an unremovable leftover is repaired and removed, not swallowed', { skip: AS_ROOT ? MODES_ARE_INERT : false }, () => {
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
test('an unreadable root fails the run rather than reporting it clean', { skip: AS_ROOT ? MODES_ARE_INERT : false }, () => {
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
