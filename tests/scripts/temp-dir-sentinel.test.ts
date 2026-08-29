/**
 * THE SENTINEL IS INSTALLED, IT FAILS A LEAK, AND IT DOES NOT FAIL A CLEAN RUN (o3d-tmpleak).
 *
 * This replaces a static rule that banned `mkdtemp` outside one helper. That rule was measured
 * against the tree it was meant to police and would have failed the build on 151 call sites that
 * already clean up in order to reach the 1 that did not — see `tests/temp-dir-sentinel.ts` for
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
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { LEAKED_PREFIX } from './fixtures/leaks-a-temp-dir.fixture.ts'

const SENTINEL = './tests/temp-dir-sentinel.ts'
const FIXTURES = 'tests/scripts/fixtures'

interface Run {
  readonly status: number | null
  readonly output: string
}

/** The real runner, the real sentinel, one fixture, from the repository root. */
function runFixture(fixture: string): Run {
  const result = spawnSync(
    join(process.cwd(), 'node_modules/.bin/tsx'),
    ['--test', '--import', SENTINEL, join(FIXTURES, fixture)],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 120_000 },
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
  const before = new Set(readdirSync(tmpdir()))
  const run = runFixture('leaks-a-temp-dir.fixture.ts')

  // The fixture's own assertion passed. Establishing this FIRST is what makes the failure below
  // attributable: a fixture that failed on its own would fail the run with or without a sentinel.
  assert.match(run.output, /^# fail 0$/m, `the fixture's own assertions must pass:\n${run.output}`)

  assert.notEqual(run.status, 0, `an abandoned directory must fail the run:\n${run.output}`)
  assert.match(run.output, /temp-dir leak: 1 entry survived/, `and say so:\n${run.output}`)
  assert.match(
    run.output,
    new RegExp(`\\b${LEAKED_PREFIX}`),
    `and name the directory, so the creating call can be found from the report alone:\n${run.output}`,
  )

  // The half that actually stops the accumulation: the run was failed AND the directory is gone,
  // both from the outer /tmp (nothing escaped the private one) and from anywhere the report named.
  const escaped = [...readdirSync(tmpdir())].filter(
    (entry) => !before.has(entry) && entry.startsWith(LEAKED_PREFIX),
  )
  assert.deepEqual(escaped, [], "the leak escaped the sentinel's private TMPDIR")
  for (const named of run.output.matchAll(new RegExp(`^\\s+(${LEAKED_PREFIX}\\S+)$`, 'gm'))) {
    assert.ok(!existsSync(join(tmpdir(), named[1])), `${named[1]} was reported but not removed`)
  }
})

test('a clean run is not failed', () => {
  const run = runFixture('cleans-up-its-temp-dir.fixture.ts')
  assert.equal(
    run.status,
    0,
    'a harness that removes what it makes must pass — a sentinel that fails everything is not a ' +
      `guard, it is an outage:\n${run.output}`,
  )
  assert.ok(!/temp-dir leak/.test(run.output), `and nothing to report:\n${run.output}`)
})
