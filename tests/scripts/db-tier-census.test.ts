import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { ALLOWED_SKIPS, evaluateCensus } from '../../scripts/db-tier-census.mjs'

/**
 * o3d-dzsd / o3d-7zes - the tests/db RUNTIME SKIP CENSUS, driven the way it runs: a real node:test run over
 * fixture files, judged by scripts/db-tier-census.mjs as a reporter.
 *
 * The census asks one question after the tier ran - did every file on disk execute at least one test and
 * skip none? - so the fixtures below are the edit shapes that used to hide a gate and that no source reading
 * could enumerate: a gate on a variable nobody sets (the pair renamed), a gate read through a helper, an
 * `env` alias, a file that registers no tests, a file that fails to load. Not one of them is recognised by
 * its text; each is caught because its tests did not execute.
 */
const repoRoot = process.cwd()
const reporter = path.join(repoRoot, 'scripts', 'db-tier-census.mjs')

type Fixture = Record<string, string>

function runCensus(fixture: Fixture): { ok: boolean; problems: string[]; executed: number; stdout: string; status: number | null } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'db-tier-census-'))
  try {
    for (const [name, body] of Object.entries(fixture)) {
      mkdirSync(path.dirname(path.join(root, 'tier', name)), { recursive: true })
      writeFileSync(path.join(root, 'tier', name), body)
    }
    const verdictFile = path.join(root, 'verdict.json')
    const env: NodeJS.ProcessEnv = { ...process.env, DB_TIER_ROOT: root, DB_TIER_DIR: 'tier', DB_TIER_CENSUS_OUT: verdictFile, NODE_OPTIONS: '' }
    delete env.NODE_TEST_CONTEXT
    const files = Object.keys(fixture).filter((name) => name.endsWith('.test.ts')).map((name) => path.join(root, 'tier', name))
    const run = spawnSync(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', '--test', '--test-reporter', reporter, '--test-reporter-destination', 'stdout', ...files],
      {
        cwd: root,
        encoding: 'utf8',
        // NODE_TEST_CONTEXT (deleted above) is what makes a child `node --test` believe it is a SUBTEST of this run and stay silent.
        env,
      },
    )
    let verdict: { ok: boolean; problems: string[]; executed: number }
    try {
      verdict = JSON.parse(readFileSync(verdictFile, 'utf8'))
    } catch {
      assert.fail(`the reporter wrote no verdict.\nstdout: ${run.stdout}\nstderr: ${run.stderr}`)
    }
    return { ...verdict, stdout: run.stdout, status: run.status }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const EXECUTES = `import test from 'node:test'\ntest('runs', () => {})\n`

test('a tier whose every file executes its tests is clean', () => {
  const result = runCensus({ 'a.test.ts': EXECUTES, 'nested/b.test.ts': EXECUTES })
  assert.deepEqual(result.problems, [])
  assert.equal(result.ok, true)
  assert.equal(result.executed, 2)
})

test('a file gated on a variable NOBODY SETS reports its tests skipped - the renamed pair, and the dropped pair', () => {
  const result = runCensus({
    'ok.test.ts': EXECUTES,
    'gated.test.ts': `import test from 'node:test'\nconst RUN = process.env.RUN_DB_SUITE_TESTS === '1'\ntest('needs db', { skip: !RUN && 'set RUN_DB_SUITE_TESTS=1' }, () => {})\ntest('needs db too', { skip: !RUN }, () => {})\n`,
  })
  assert.equal(result.ok, false)
  assert.match(result.problems.join('\n'), /gated\.test\.ts: 2 skipped/)
  assert.match(result.problems.join('\n'), /gated\.test\.ts: executed ZERO tests/)
  assert.ok(!result.problems.some((problem) => problem.includes('ok.test.ts')), 'and the clean file is not blamed')
})

test('the gate is invisible to the census, so every way of reading it is caught the same', () => {
  const shapes: Record<string, string> = {
    'aliased-env.test.ts': `import test from 'node:test'\nconst { env } = process\ntest('t', { skip: env.UNSET_GATE !== '1' }, () => {})\n`,
    'copied-env.test.ts': `import test from 'node:test'\nconst e = { ...process.env }\ntest('t', { skip: e.UNSET_GATE !== '1' }, () => {})\n`,
    'assembled-name.test.ts': `import test from 'node:test'\nconst name = 'UNSET_' + 'GATE'\ntest('t', { skip: process.env[name] !== '1' }, () => {})\n`,
    'via-helper.test.ts': `import test from 'node:test'\nimport { skipUnlessGated } from './gate-helper.ts'\ntest('t', { skip: skipUnlessGated() }, () => {})\n`,
    'gate-helper.ts': `export const skipUnlessGated = () => process.env.UNSET_GATE !== '1'\n`,
  }
  const result = runCensus(shapes)
  assert.equal(result.ok, false)
  for (const file of ['aliased-env', 'copied-env', 'assembled-name', 'via-helper']) {
    assert.match(result.problems.join('\n'), new RegExp(`${file}\\.test\\.ts: 1 skipped`), file)
  }
})

test('a file that registers no tests is a violation and not an absence', () => {
  const result = runCensus({ 'ok.test.ts': EXECUTES, 'empty.test.ts': `export {}\n` })
  assert.equal(result.ok, false)
  assert.match(result.problems.join('\n'), /empty\.test\.ts: reported NO tests/)
})

test('a file that fails to load fails the run itself (the runner reports it as a failed test, which counts as executed)', () => {
  const result = runCensus({ 'ok.test.ts': EXECUTES, 'broken.test.ts': `import './does-not-exist.ts'\n` })
  assert.notEqual(result.status, 0, 'the runner exits non-zero for it; the wrapper propagates that status')
})

test('one skip among executed tests still fails: the tier is expected to run in full', () => {
  const result = runCensus({
    'mixed.test.ts': `import test from 'node:test'\ntest('a', () => {})\ntest('b', { skip: 'because' }, () => {})\n`,
  })
  assert.equal(result.ok, false)
  assert.match(result.problems.join('\n'), /mixed\.test\.ts: 1 skipped \(b \(because\)\)/)
})

test('a failing test counts as executed - the runner fails the run for it, the census does not double-report', () => {
  const result = runCensus({ 'red.test.ts': `import test from 'node:test'\ntest('red', () => { throw new Error('x') })\n` })
  assert.equal(result.ok, true)
  assert.equal(result.executed, 1)
})

test('an empty tier is blind, not clean', () => {
  const result = runCensus({ 'README.md': 'nothing here\n' })
  assert.equal(result.ok, false)
  assert.match(result.problems.join('\n'), /NO test files/)
})

test('package.json test:db runs the census wrapper and nothing else', () => {
  // Equality over ONE fixed string, not a reading of an open space: a spelling the wrapper does not own
  // (`tsx --test tests/db/**`, with or without the gate pair) is exactly the edit that would bypass the census.
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
  assert.equal(pkg.scripts['test:db'], 'node scripts/run-db-tier.mjs')
})

test('the allowlist is a CEILING on one named file: it excuses neither a further skip nor a file that executes nothing', () => {
  const file = '/r/tests/db/startup-option-verdict-across-bundles.test.ts'
  const verdict = (entry: { executed: number; skipped: string[]; todo: number }) =>
    evaluateCensus({ expected: [file], tally: new Map([[file, entry]]), allowedSkips: ALLOWED_SKIPS, root: '/r' })
  assert.deepEqual(ALLOWED_SKIPS, { 'tests/db/startup-option-verdict-across-bundles.test.ts': 2 })
  assert.equal(verdict({ executed: 3, skipped: ['a', 'b'], todo: 0 }).ok, true, 'the two documented skips pass')
  assert.equal(verdict({ executed: 3, skipped: ['a', 'b', 'c'], todo: 0 }).ok, false, 'a third is a new hidden skip')
  assert.equal(verdict({ executed: 0, skipped: ['a', 'b'], todo: 0 }).ok, false, 'and a file that ran nothing is never excused')
  const other = '/r/tests/db/other.test.ts'
  assert.equal(
    evaluateCensus({ expected: [other], tally: new Map([[other, { executed: 1, skipped: ['x'], todo: 0 }]]), allowedSkips: ALLOWED_SKIPS, root: '/r' }).ok,
    false,
    'the allowance names one file; any other skipping file fails',
  )
})
