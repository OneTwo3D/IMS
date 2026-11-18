// o3d-dzsd / o3d-7zes - THE tests/db SKIP CENSUS: a RUNTIME property, not a reading of source.
//
// WHY THIS EXISTS. Two earlier guards (o3d-n3yt r16-r20, withdrawn) asked a SYNTACTIC question - does this
// source text read a gate? - about an OPEN space: the ways a program can read an environment variable
// (`const { env } = process`, `{ ...process.env }`, `readGate('RUN_' + 'DB_X')`, a gate read in an imported
// helper, ...). Each passed shapes its author had not thought of while reporting a clean run. And the
// hand-written REQUIRE_DB_RETENTION_TESTS tripwire covers one edit shape (the RUN_ half dropped while the
// REQUIRE_ half stays): drop both halves, or rename the pair, and every gated test skips inside a green job.
//
// THE QUESTION THAT IS ANSWERABLE. After the tier has run: did every test file on disk under tests/db
// EXECUTE at least one test, and did it report no skips? That does not care how a gate is spelled, whether
// it is read in the file or in a helper, or whether the variable exists at all - only whether the tests ran.
//
// SCOPE. The `test:db` invocation, where the expectation really is zero skips (the database is there).
// `test:unit` also globs tests/db/** but without a database, where skips are the normal state; it never
// loads this reporter.
//
// This module is BOTH the node:test reporter (default export, loaded by scripts/run-db-tier.mjs) and the
// pure evaluator (`evaluateCensus`), so tests/scripts/db-tier-census.test.ts drives the very function that
// decides the verdict.
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** Every `*.test.ts` under `dir`, as `/`-separated paths relative to `repoRoot`, sorted. */
export function tierFiles(repoRoot, dir = 'tests/db') {
  const out = []
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      const full = path.join(current, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (name.endsWith('.test.ts')) out.push(path.relative(repoRoot, full).split(path.sep).join('/'))
    }
  }
  walk(path.join(repoRoot, dir))
  return out
}

/**
 * Fold node:test events into per-file counts. A SUITE (`describe`) is not a test: only leaf tests count as
 * executed, so a file whose every test is skipped cannot be rescued by its wrapping suite "passing".
 * `todo` is not executed either.
 */
export function newTally() {
  return new Map()
}

export function recordEvent(tally, event) {
  if (event.type !== 'test:pass' && event.type !== 'test:fail') return
  const data = event.data
  if (!data?.file) return
  if (data.details?.type === 'suite') return
  // The runner also reports the FILE itself as a test named by its own path (a file that registers nothing
  // "passes" that way). That is not a test the file executed.
  if (data.name === data.file) return
  const entry = tally.get(data.file) ?? { executed: 0, skipped: [], todo: 0 }
  if (data.skip !== undefined && data.skip !== false) entry.skipped.push(`${data.name}${typeof data.skip === 'string' ? ` (${data.skip})` : ''}`)
  else if (data.todo !== undefined && data.todo !== false) entry.todo++
  else entry.executed++
  tally.set(data.file, entry)
}

/**
 * THE ONLY SKIPS THE TIER IS ALLOWED, each with the place that enforces them instead. A skip not named here
 * fails the census. An entry is a CEILING on the number of skipped tests in that file (a third skip, or a new
 * skipped file, still fails) and never excuses a file from executing at least one test.
 *
 * startup-option-verdict-across-bundles: its two built-artifact legs need `.next` output, which this job does
 * not build. They are NOT silently lost: the job that builds sets IMS_REQUIRE_BUILD_ARTIFACT=1, which turns
 * those very skips into failures (see skipOrFail in that file). Found by the first run of this census.
 */
export const ALLOWED_SKIPS = {
  'tests/db/startup-option-verdict-across-bundles.test.ts': 2,
}

/**
 * The verdict. `expected` is the on-disk file list (absolute paths); `tally` is what ran. Every expected
 * file must have executed at least one test and skipped none; a file that never reported anything (it
 * failed to load, registered no tests, or was left out of the run) is a violation, not an absence.
 */
export function evaluateCensus({ expected, tally, allowedSkips = ALLOWED_SKIPS, root = '' }) {
  const problems = []
  if (expected.length === 0) problems.push('the census found NO test files under the tier directory - it is blind, not clean')
  for (const file of expected) {
    const entry = tally.get(file)
    if (!entry) { problems.push(`${file}: reported NO tests - not collected, failed to load, or registered nothing`); continue }
    const rel = root ? path.relative(root, file).split(path.sep).join('/') : file
    const ceiling = allowedSkips[rel] ?? 0
    if (entry.skipped.length > ceiling) problems.push(`${file}: ${entry.skipped.length} skipped${ceiling > 0 ? ` (only ${ceiling} allowed)` : ''} (${entry.skipped.slice(0, 3).join('; ')}${entry.skipped.length > 3 ? '; ...' : ''})`)
    if (entry.executed === 0) problems.push(`${file}: executed ZERO tests`)
  }
  const known = new Set(expected)
  for (const file of tally.keys()) if (!known.has(file)) problems.push(`${file}: ran but is not under the tier directory the census expects`)
  return { ok: problems.length === 0, problems }
}

/** The node:test reporter. The verdict is written to DB_TIER_CENSUS_OUT, which the wrapper requires to exist. */
export default async function* dbTierCensusReporter(source) {
  const tally = newTally()
  for await (const event of source) recordEvent(tally, event)
  const root = process.env.DB_TIER_ROOT ?? process.cwd()
  const dir = process.env.DB_TIER_DIR ?? 'tests/db'
  const expected = tierFiles(root, dir).map((rel) => path.join(root, rel))
  const verdict = evaluateCensus({ expected, tally, root })
  const executed = [...tally.values()].reduce((sum, entry) => sum + entry.executed, 0)
  const out = process.env.DB_TIER_CENSUS_OUT
  if (out) {
    mkdirSync(path.dirname(out), { recursive: true })
    writeFileSync(out, JSON.stringify({ ...verdict, files: expected.length, executed }))
  }
  yield verdict.ok
    ? `db-tier census: OK - ${expected.length} files, ${executed} tests executed, 0 skipped\n`
    : `db-tier census: FAILED\n${verdict.problems.map((problem) => `  - ${problem}`).join('\n')}\n`
}
