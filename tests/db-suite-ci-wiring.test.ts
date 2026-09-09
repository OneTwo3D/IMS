import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

/**
 * o3d-11rf r13 (Codex r13, HIGH) — THE SUITE THAT WAS SKIPPED BY EVERY ENVIRONMENT THAT EXISTS.
 *
 * WHAT WAS FOUND. `tests/db/reconciliation-void-mirror-contradictions.test.ts` gates all fifteen of
 * its tests on `RUN_DB_MIGRATION_TESTS === '1'`, and no checked-in workflow — and no npm script —
 * set that variable anywhere in the repository. `npm run test:unit`'s glob is `tests/**` +
 * `*.test.ts`, so CI COLLECTED the file on every run and reported fifteen skips inside a green
 * suite. A whole branch's central evidence was checked in in a form that never executed, and
 * nothing in any log said so. The same was true of
 * `tests/db/accounting-event-void-basis-backfill.test.ts`.
 *
 * WHY THE FIX NEEDS A GUARD OF ITS OWN. The fix is a CI job, and a CI job is one edit away from
 * being renamed, path-filtered out, or dropped — after which the suites go back to skipping
 * silently and look exactly as green as they did before. A skipped test cannot police its own
 * invocation, so the check has to live somewhere that RUNS WITHOUT A DATABASE. That is here:
 * this file has no gate, opens no connection, and runs in `npm run test:unit` on every PR.
 *
 * WHAT IT ASSERTS, and it is a closed loop rather than a spot check:
 *
 *   1. WHICH FILES ARE GATED is discovered by walking `tests/`, not listed. A new database-backed
 *      test gated the same way is picked up the day it is written.
 *   2. EVERY gated file must be reachable from `npm run test:db`'s glob.
 *   3. EVERY gated file must also carry the `REQUIRE_DB_MIGRATION_TESTS` tripwire, so that a job
 *      which sets only half the pair fails loudly instead of skipping.
 *   4. `npm run test:db` must be invoked BY A JOB THAT CAN SERVE IT — the same job block has to
 *      stand up a `postgres` service and run `prisma migrate deploy`. Naming the script from a job
 *      with no database would satisfy a weaker check while proving nothing.
 *
 * NOT VACUOUS, and it is written to be provable: the walk's own results are asserted (a walk that
 * reached nothing would otherwise pass every "for every gated file" loop trivially), and the two
 * files known to be gated today are named so that a walk which silently stops finding them fails.
 */

const REPO_ROOT = process.cwd()
const GATE = 'RUN_DB_MIGRATION_TESTS'
/** Written as a template so that THIS file does not itself contain the literal the walk looks for. */
const GATE_READ = `process.env.${GATE}`
const TRIPWIRE = 'REQUIRE_DB_MIGRATION_TESTS'
const WORKFLOW = '.github/workflows/schema-guardrails.yml'

/** The files that were gated on the day this guard was written. The walk must keep finding them. */
const KNOWN_GATED = [
  'tests/db/accounting-event-void-basis-backfill.test.ts',
  'tests/db/reconciliation-void-mirror-contradictions.test.ts',
]

function testFilesUnder(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(path.join(REPO_ROOT, dir))) {
    const relative = `${dir}/${entry}`
    if (statSync(path.join(REPO_ROOT, relative)).isDirectory()) found.push(...testFilesUnder(relative))
    else if (entry.endsWith('.test.ts')) found.push(relative)
  }
  return found
}

/**
 * A shell-glob matcher for the forms npm scripts and workflow path filters use here.
 *
 * `**\/` MATCHES ZERO DIRECTORIES, which is the whole reason this is hand-written rather than a
 * naive `**` -> `.*`. `tests/concurrency/**\/*.test.ts` is this repository's existing, working
 * invocation and every file it runs sits DIRECTLY in `tests/concurrency` — so a matcher that
 * required an intermediate directory would report the repository's own passing glob as covering
 * nothing, and this guard would fail on a correct workflow.
 */
function globToRegExp(glob: string): RegExp {
  const pattern = glob.replace(/\*\*\/|\*\*|\*|[^*]+/g, (token) => {
    if (token === '**/') return '(?:.*/)?'
    if (token === '**') return '.*'
    if (token === '*') return '[^/]*'
    return token.replace(/[.+^${}()|[\]\\?]/g, '\\$&')
  })
  return new RegExp(`^${pattern}$`)
}

/**
 * The block of `.github/workflows/*.yml` belonging to one job, by two-space-indented key. Parsed by
 * indentation rather than by a YAML library because this repository declares no YAML dependency —
 * `tests/production-readiness-workflow.test.ts` reads these files as text for the same reason.
 */
function jobBlocks(workflow: string): Map<string, string> {
  const lines = workflow.split('\n')
  const start = lines.findIndex((line) => line === 'jobs:')
  assert.ok(start >= 0, `${WORKFLOW} has a top-level jobs: key`)
  const blocks = new Map<string, string>()
  let name: string | null = null
  let body: string[] = []
  for (const line of lines.slice(start + 1)) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)
    if (header) {
      if (name) blocks.set(name, body.join('\n'))
      name = header[1]
      body = []
    } else if (name) {
      body.push(line)
    }
  }
  if (name) blocks.set(name, body.join('\n'))
  return blocks
}

const gatedFiles = testFilesUnder('tests')
  .filter((file) => readFileSync(path.join(REPO_ROOT, file), 'utf8').includes(GATE_READ))
  .sort()

test(`the walk finds the files gated on ${GATE} — the precondition for everything below`, () => {
  // If this ever passes with an empty list, every "for every gated file" assertion below becomes a
  // loop over nothing and the guard silently stops guarding. So the walk is asserted first.
  assert.ok(gatedFiles.length > 0, `no test file mentions ${GATE}; the walk reached nothing`)
  for (const known of KNOWN_GATED) {
    assert.ok(gatedFiles.includes(known),
      `${known} is gated on ${GATE} and the walk must still find it — it found ${JSON.stringify(gatedFiles)}`)
  }
})

test(`npm run test:db sets ${GATE} and ${TRIPWIRE} and reaches every gated file`, () => {
  const scripts = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).scripts as Record<string, string>
  const script = scripts['test:db']
  assert.ok(script,
    `package.json has no "test:db" script, so nothing sets ${GATE} and every gated file skips whole`)
  assert.match(script, new RegExp(`\\b${GATE}=1\\b`), `test:db must set ${GATE}=1`)
  assert.match(script, new RegExp(`\\b${TRIPWIRE}=1\\b`),
    `test:db must set ${TRIPWIRE}=1 so a half-wired invocation fails instead of skipping`)

  const globs = [...script.matchAll(/"([^"]*\*[^"]*)"/g)].map((match) => match[1])
  assert.ok(globs.length > 0, `test:db names no test glob: ${script}`)
  const matchers = globs.map(globToRegExp)
  // The matcher itself must be able to say no, or "covered" means nothing.
  assert.ok(!matchers.some((matcher) => matcher.test('tests/unit/not-a-db-test.spec.ts')),
    'the glob matcher rejects a path outside the globs')
  // And it accepts a file sitting DIRECTLY in the globbed directory, which is where every file this
  // guard is about actually lives.
  assert.ok(matchers.some((matcher) => matcher.test('tests/db/example.test.ts')),
    `test:db's globs must reach tests/db/*.test.ts itself, not only subdirectories: ${JSON.stringify(globs)}`)
  for (const file of gatedFiles) {
    assert.ok(matchers.some((matcher) => matcher.test(file)),
      `${file} is gated on ${GATE} but no test:db glob (${JSON.stringify(globs)}) reaches it, so it `
      + 'would still be collected only by test:unit — and skipped there')
  }
})

test(`every file gated on ${GATE} refuses to skip when ${TRIPWIRE} promised a database`, () => {
  // A MENTION IS NOT A READ, and the distinction is not academic: the first version of this check
  // accepted `source.includes(TRIPWIRE)`, and deleting the tripwire STATEMENT while leaving the
  // sentence about it in the file's doc comment passed it. So the check asks for the read
  // (`process.env.<name>`) and for a `throw` inside the statement that read it.
  const read = `process.env.${TRIPWIRE}`
  for (const file of gatedFiles) {
    const source = readFileSync(path.join(REPO_ROOT, file), 'utf8')
    const at = source.indexOf(read)
    assert.ok(at >= 0,
      `${file} gates on ${GATE} but never READS ${TRIPWIRE} (a doc-comment mention is not a `
      + 'tripwire): an invocation that sets one variable and not the other would skip the whole file '
      + 'silently, which is the o3d-11rf r13 finding')
    assert.ok(source.slice(at, at + 200).includes('throw new Error('),
      `${file} reads ${TRIPWIRE} but does not THROW on it — reporting a silent skip is what the `
      + 'tripwire exists to stop, so it has to be fatal')
  }
})

test('a CI job runs npm run test:db against a migrated postgres service', () => {
  const workflow = readFileSync(path.join(REPO_ROOT, WORKFLOW), 'utf8')
  const blocks = jobBlocks(workflow)
  assert.ok(blocks.size > 0, `${WORKFLOW} parsed to no jobs; the block splitter is broken`)

  const runners = [...blocks].filter(([, body]) => /\bnpm run test:db\b/.test(body))
  assert.equal(runners.length > 0, true,
    `no job in ${WORKFLOW} runs "npm run test:db", so ${gatedFiles.length} gated files run nowhere. `
    + `Jobs present: ${JSON.stringify([...blocks.keys()])}`)

  for (const [job, body] of runners) {
    assert.match(body, /image: postgres:\d+/,
      `${WORKFLOW} job "${job}" runs the DB suites but stands up no postgres service`)
    assert.match(body, /prisma migrate deploy/,
      `${WORKFLOW} job "${job}" runs the DB suites against a database it never migrated`)
    assert.match(body, /DATABASE_URL: postgres/,
      `${WORKFLOW} job "${job}" runs the DB suites without pointing DATABASE_URL at that service`)
  }
})

test(`${WORKFLOW} is triggered by changes to the gated files themselves`, () => {
  // A path-filtered workflow that does not list tests/db/** would not run on a pull request that
  // only changed one of these suites — the job would exist and still never execute.
  const workflow = readFileSync(path.join(REPO_ROOT, WORKFLOW), 'utf8')
  const triggers = workflow.slice(0, workflow.indexOf('\njobs:'))
  const pathFilters = [...triggers.matchAll(/^ {6}- "([^"]+)"$/gm)].map((match) => match[1])
  assert.ok(pathFilters.length > 0, `${WORKFLOW} declares no path filters to check`)
  const matchers = pathFilters.map(globToRegExp)
  for (const file of gatedFiles) {
    assert.ok(matchers.some((matcher) => matcher.test(file)),
      `a pull request changing only ${file} would not trigger ${WORKFLOW}: its paths filter `
      + 'does not cover the file, so the job added for it would never run')
  }
})
