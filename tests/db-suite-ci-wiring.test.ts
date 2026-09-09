import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  asMap, asSeq, asString, invokes, leadingAssignments, parseWorkflowYaml, scriptInvokes, shellCommands,
  stripShellComments, stripTsComments, type YamlMap, type YamlNode,
} from './helpers/live-source'

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
 *   4. `npm run test:db` must be invoked BY A JOB THAT CAN SERVE IT — the same job has to stand up
 *      a `postgres` service and run `prisma migrate deploy`. Naming the script from a job with no
 *      database would satisfy a weaker check while proving nothing.
 *
 * NOT VACUOUS, and it is written to be provable: the walk's own results are asserted (a walk that
 * reached nothing would otherwise pass every "for every gated file" loop trivially), and the two
 * files known to be gated today are named so that a walk which silently stops finding them fails.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * o3d-11rf r15 (Codex r15, HIGH) — AND EVERY ONE OF THOSE QUESTIONS IS ASKED OF LIVE CODE.
 *
 * WHAT WAS FOUND. Check 4 above searched a job's RAW TEXT for `npm run test:db`. Putting a `#` in
 * front of the workflow's `run: npm run test:db` left that search satisfied — and left the postgres,
 * migrate and DATABASE_URL searches satisfied too, since they read the same raw text. GitHub would
 * run no suite at all, `test:unit` would collect the gated tests and skip them, and this guard would
 * stay green over exactly the state it exists to report.
 *
 * WHY IT IS WORTH A LONGER NOTE THAN THE FIX. Round 14 had already fixed this rule once, in the
 * PATH FILTER reader: prose and commented-out list entries no longer supply coverage. It did not
 * carry the rule one field across to the STEP reader. One rule, two readers, one fixed — and the
 * guard shipped containing the defect it exists to catch.
 *
 * SO THE RULE IS NOW HELD IN ONE PLACE, NOT RE-STATED PER CHECK. `tests/helpers/live-source.ts`
 * parses a workflow into a STRUCTURE (a comment is not a node, so a commented-out step, job or list
 * entry does not exist in the result — there is nothing left to match), and strips comments from
 * TypeScript and from shell commands for the checks that read those. Every assertion below reads one
 * of those three, and the fixtures at the bottom perform the comment-out mutations themselves and
 * require the readers to go blind. What is asserted is not "the text appears" but "it executes".
 */

const REPO_ROOT = process.cwd()
const GATE = 'RUN_DB_MIGRATION_TESTS'
/** Written as a template so that THIS file does not itself contain the literal the walk looks for. */
const GATE_READ = `process.env.${GATE}`
const TRIPWIRE = 'REQUIRE_DB_MIGRATION_TESTS'
const WORKFLOW = '.github/workflows/schema-guardrails.yml'
/**
 * The invocations this guard asks about, as WORDS. A regular expression over the job's text answers
 * yes to a commented-out line (r15) and to `echo "npm run test:db"` — text in an argument executes
 * no more than text in a comment. A word sequence in command position is the question that was
 * meant.
 */
const DB_SUITE_INVOCATION = ['npm', 'run', 'test:db']
const MIGRATE_INVOCATION = ['prisma', 'migrate', 'deploy']

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

/** One test file's source with its comments blanked out: what the file actually executes. */
function liveSourceOf(file: string): string {
  return stripTsComments(readFileSync(path.join(REPO_ROOT, file), 'utf8'))
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

const gatedFiles = testFilesUnder('tests')
  .filter((file) => liveSourceOf(file).includes(GATE_READ))
  .sort()

test(`the walk finds the files gated on ${GATE} — the precondition for everything below`, () => {
  // If this ever passes with an empty list, every "for every gated file" assertion below becomes a
  // loop over nothing and the guard silently stops guarding. So the walk is asserted first.
  assert.ok(gatedFiles.length > 0, `no test file READS ${GATE}; the walk reached nothing`)
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

  // POSITION IS THE WHOLE QUESTION, not presence. `# RUN_DB_MIGRATION_TESTS=1 tsx --test ...` is a
  // script that runs nothing and exits 0, and `echo RUN_DB_MIGRATION_TESTS=1` sets no variable —
  // both would satisfy a search of the script's text. So the command is read as a command: comments
  // removed, then the assignments that actually precede it.
  const { assignments, rest } = leadingAssignments(script)
  assert.ok(rest.trim() !== '',
    `test:db runs no command once its shell comments are removed (${JSON.stringify(script)}); it `
    + 'would exit 0 having executed nothing, which is a green CI job over an unrun suite')
  assert.equal(assignments.get(GATE), '1',
    `test:db must set ${GATE}=1 as a leading assignment on the command it runs, not mention it: `
    + `${JSON.stringify(script)}`)
  assert.equal(assignments.get(TRIPWIRE), '1',
    `test:db must set ${TRIPWIRE}=1 so a half-wired invocation fails instead of skipping: `
    + `${JSON.stringify(script)}`)

  const globs = shellCommands(script).flatMap((words) => words)
    .filter((word) => word.includes('*') && !word.startsWith('-'))
  assert.ok(globs.length > 0, `test:db names no test glob: ${rest}`)
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
  // sentence about it in the file's doc comment passed it. The second version asked for
  // `process.env.<name>` — in the RAW file, where a `//`-commented-out tripwire reads the same as a
  // live one. Both are now answered at once by reading the file with its comments blanked out.
  const read = `process.env.${TRIPWIRE}`
  for (const file of gatedFiles) {
    const source = liveSourceOf(file)
    const at = source.indexOf(read)
    assert.ok(at >= 0,
      `${file} gates on ${GATE} but never READS ${TRIPWIRE} in live code (a doc-comment mention and `
      + 'a commented-out statement are both prose): an invocation that sets one variable and not the '
      + 'other would skip the whole file silently, which is the o3d-11rf r13 finding')
    assert.ok(source.slice(at, at + 200).includes('throw new Error('),
      `${file} reads ${TRIPWIRE} but does not THROW on it — reporting a silent skip is what the `
      + 'tripwire exists to stop, so it has to be fatal')
  }
})

/**
 * The `jobs:` mapping of one workflow, as a structure.
 *
 * WHY NOT THE INDENTATION SPLITTER THIS REPLACED. The previous version cut the file into per-job
 * text blocks on a two-space-indented header regex. Commenting a job out does not remove its header
 * from the file, it makes it stop being a header — so the whole commented-out job's body was
 * appended to the PRECEDING job's text, and every question asked of that text ("does it run the
 * suite?", "does it have postgres?") was answered yes by lines GitHub would never execute.
 */
function jobsOf(workflow: string, source: string): Map<string, YamlMap> {
  const tree = asMap(parseWorkflowYaml(source, workflow))
  assert.ok(tree, `${workflow} did not parse to a mapping`)
  const jobs = asMap((tree as YamlMap).jobs)
  assert.ok(jobs, `${workflow} declares no jobs: mapping`)
  const found = new Map<string, YamlMap>()
  for (const [name, body] of Object.entries(jobs as YamlMap)) {
    const map = asMap(body)
    assert.ok(map, `${workflow} job "${name}" did not parse to a mapping`)
    found.set(name, map as YamlMap)
  }
  return found
}

/** The steps of one job, each as a mapping. */
function stepsOf(job: YamlMap): YamlMap[] {
  const steps = asSeq(job.steps) ?? []
  return steps.map(asMap).filter((step): step is YamlMap => step !== null)
}

/** What one step actually executes: its `run:` scalar with the shell's own comments removed. */
function liveRunOf(step: YamlMap): string {
  const run = asString(step.run)
  return run === null ? '' : stripShellComments(run)
}

/**
 * A value that can only ever be false. GitHub expressions are not evaluated here — only the literal
 * forms are recognised, which is enough to catch a step or job switched off in place.
 */
function neverRuns(node: YamlNode | undefined): boolean {
  const value = asString(node ?? null)
  return value !== null && /^(false|\$\{\{\s*false\s*\}\})$/.test(value.trim())
}

/** Every step of `job` that really invokes `command`. */
function stepsInvoking(job: YamlMap, command: string[]): YamlMap[] {
  return stepsOf(job).filter((step) => scriptInvokes(liveRunOf(step), command) && !neverRuns(step.if))
}

/** Every job of one workflow that really invokes `command`, by name. */
function jobsInvoking(jobs: Map<string, YamlMap>, command: string[]): Map<string, YamlMap> {
  const found = new Map<string, YamlMap>()
  for (const [name, job] of jobs) {
    if (neverRuns(job.if)) continue
    if (stepsInvoking(job, command).length > 0) found.set(name, job)
  }
  return found
}

/**
 * Every reason `job` could not actually serve the database suites. Empty means it can.
 *
 * Each reason is read off the parsed structure — the service's `image`, a step's live `run`, the
 * `DATABASE_URL` the job or the step sets — and not off the job's text, where a `#` in front of any
 * of those three lines left all three questions answered yes.
 */
function whyJobCannotServeTheSuite(job: YamlMap, command: string[]): string[] {
  const reasons: string[] = []
  const services = asMap(job.services) ?? {}
  const images = Object.values(services)
    .map((service) => asString(asMap(service)?.image ?? null))
    .filter((image): image is string => image !== null)
  if (!images.some((image) => /^postgres:\d/.test(image))) {
    reasons.push(`it stands up no postgres service (images: ${JSON.stringify(images)})`)
  }
  if (stepsInvoking(job, MIGRATE_INVOCATION).length === 0) {
    reasons.push('no step it runs migrates the database (prisma migrate deploy)')
  }
  const urls = [
    asString(asMap(job.env)?.DATABASE_URL ?? null),
    ...stepsInvoking(job, command).map((step) => asString(asMap(step.env)?.DATABASE_URL ?? null)),
  ].filter((url): url is string => url !== null)
  if (!urls.some((url) => url.startsWith('postgres'))) {
    reasons.push(`it points DATABASE_URL at no postgres service (${JSON.stringify(urls)})`)
  }
  return reasons
}

test('a CI job runs npm run test:db against a migrated postgres service', () => {
  const source = readFileSync(path.join(REPO_ROOT, WORKFLOW), 'utf8')
  const jobs = jobsOf(WORKFLOW, source)
  assert.ok(jobs.size > 0, `${WORKFLOW} parsed to no jobs`)

  // ANTI-UNDER-READ, and this is the one place raw text is still consulted ON PURPOSE. Its failure
  // direction is the safe one: it catches the PARSER reading LESS than the document declares, which
  // would turn every assertion below into a question asked of nothing. A parser reading more than
  // the document is not a risk it can create.
  const declared = [...source.matchAll(/^ {2}([A-Za-z0-9_-]+):[ \t]*$/gm)].map((match) => match[1])
    .filter((name) => new RegExp(`^jobs:$[\\s\\S]*^ {2}${name}:`, 'm').test(source))
  for (const name of declared) {
    assert.ok(jobs.has(name),
      `${WORKFLOW} declares a job "${name}" that the workflow parser did not read; every check below `
      + `would be asked of a shorter document than the file. Parsed: ${JSON.stringify([...jobs.keys()])}`)
  }

  const runners = jobsInvoking(jobs, DB_SUITE_INVOCATION)
  assert.ok(runners.size > 0,
    `no job in ${WORKFLOW} RUNS "npm run test:db" — a commented-out or switched-off step does not `
    + `count — so ${gatedFiles.length} gated files run nowhere. `
    + `Jobs present: ${JSON.stringify([...jobs.keys()])}`)

  for (const [name, job] of runners) {
    assert.deepEqual(whyJobCannotServeTheSuite(job, DB_SUITE_INVOCATION), [],
      `${WORKFLOW} job "${name}" runs the DB suites but cannot serve them`)
  }
})

/**
 * THE REGRESSION FIXTURE FOR THE r15 FINDING, and it performs the mutation itself.
 *
 * A guard that says "a commented-out command does not count" has to be provable without editing a
 * checked-in workflow. So the fixture below IS a workflow, the test comments parts of it out line by
 * line, and each mutation must make the readers go blind. The text stays in the document every time
 * — that is the whole point: the same characters, no longer executed.
 */
const RUNNER_FIXTURE = [
  'name: Fixture',
  '# Prose about npm run test:db, at length, in a job-shaped comment.',
  'on:',
  '  pull_request:',
  '    paths:',
  '      - "tests/db/**"',
  'jobs:',
  '  decoy:',
  '    runs-on: ubuntu-latest',
  '    services:',
  '      postgres:',
  '        image: postgres:16',
  '    env:',
  '      DATABASE_URL: postgresql://postgres:postgres@127.0.0.1:5432/ims_ci',
  '    steps:',
  '      - name: npm run test:db',
  '        run: echo this step is named after the command it does not run',
  '      - run: |',
  '          # npm run test:db',
  '          echo a shell comment inside a run block executes nothing',
  '      - run: echo "npm run test:db"',
  '      - run: echo npm run test:db > /dev/null',
  '  db:',
  '    runs-on: ubuntu-latest',
  '    services:',
  '      postgres:',
  '        image: postgres:16',
  '    env:',
  '      DATABASE_URL: postgresql://postgres:postgres@127.0.0.1:5432/ims_ci',
  '    steps:',
  '      - run: npx prisma migrate deploy --schema prisma/schema.prisma',
  '      - name: Run the DB-backed regression suites',
  '        run: npm run test:db',
  '',
]

/** The fixture with every line matching `pattern` commented out — text kept, execution removed. */
function commentedOut(pattern: RegExp): string {
  return RUNNER_FIXTURE.map((line) => (pattern.test(line) ? `#${line}` : line)).join('\n')
}

function fixtureRunners(source: string): string[] {
  return [...jobsInvoking(jobsOf('fixture.yml', source), DB_SUITE_INVOCATION).keys()]
}

test('the workflow reader counts a step that RUNS the DB suites, and nothing that merely says so', () => {
  const intact = RUNNER_FIXTURE.join('\n')
  // Green first: the reader finds the job that runs it, and does NOT find the job that names the
  // command in a step title and buries it in a shell comment inside a run block.
  assert.deepEqual(fixtureRunners(intact), ['db'],
    'the reader must find the job whose step runs the command, and only that job')

  // r15's mutation, verbatim: one `#` in front of the run line. Every character of the command is
  // still in the document.
  const commandCommentedOut = commentedOut(/^ {8}run: npm run test:db$/)
  assert.ok(commandCommentedOut.includes('npm run test:db'), 'the mutation keeps the text')
  assert.deepEqual(fixtureRunners(commandCommentedOut), [],
    'a commented-out run: line is not a step GitHub executes, and must not be read as one')

  // The whole job commented out. The indentation splitter this replaced folded these lines into the
  // preceding job and answered every question about them yes.
  const jobCommentedOut = RUNNER_FIXTURE.map((line, index) => (index >= RUNNER_FIXTURE.indexOf('  db:') ? `#${line}` : line))
    .join('\n')
  assert.deepEqual(fixtureRunners(jobCommentedOut), [],
    'a commented-out job does not exist, and its lines belong to no other job either')

  // Switched off in place rather than commented out.
  const switchedOff = RUNNER_FIXTURE.flatMap((line) => (line === '  db:' ? [line, '    if: false'] : [line])).join('\n')
  assert.deepEqual(fixtureRunners(switchedOff), [], 'a job that can never run does not run the suites')
  const stepSwitchedOff = RUNNER_FIXTURE
    .flatMap((line) => (line === '        run: npm run test:db' ? ['        if: false', line] : [line])).join('\n')
  assert.deepEqual(fixtureRunners(stepSwitchedOff), [], 'a step that can never run does not run the suites')
})

test('the workflow reader checks the database off the structure, not off the job text', () => {
  const jobOf = (source: string): YamlMap => {
    const job = jobsOf('fixture.yml', source).get('db')
    assert.ok(job, 'the fixture must still declare the db job')
    return job as YamlMap
  }
  assert.deepEqual(whyJobCannotServeTheSuite(jobOf(RUNNER_FIXTURE.join('\n')), DB_SUITE_INVOCATION), [],
    'the intact fixture job can serve the suites')

  // One comment-out per property the job has to carry. Each leaves the text in the file.
  const cases: Array<[string, RegExp, RegExp]> = [
    ['the postgres service', /^ {8}image: postgres:16$/, /stands up no postgres service/],
    ['the migration step', /^ {6}- run: npx prisma migrate deploy/, /migrates the database/],
    ['the database URL', /^ {6}DATABASE_URL: /, /DATABASE_URL at no postgres service/],
  ]
  for (const [what, line, expected] of cases) {
    const mutated = commentedOut(line)
    const reasons = whyJobCannotServeTheSuite(jobOf(mutated), DB_SUITE_INVOCATION)
    assert.ok(reasons.some((reason) => expected.test(reason)),
      `commenting out ${what} must be reported, and was not: ${JSON.stringify(reasons)}`)
  }
})

test('the TypeScript reader reads statements, not sentences', () => {
  const gate = `process.env.${GATE}`
  const live = [
    'const url = "http://example.test/#not-a-comment"',
    'const pattern = /a\\/\\/b/',
    `if (${gate} !== '1') throw new Error('x')`,
  ].join('\n')
  const stripped = stripTsComments(live)
  assert.ok(stripped.includes(gate), 'a live read survives')
  assert.ok(stripped.includes('http://example.test/#not-a-comment'), 'a URL inside a string is not a comment')
  assert.ok(stripped.includes('a\\/\\/b'), 'a regular expression containing // is not a comment')

  const prose = [
    `/** This file gates on ${gate} and throws when ${'process.env.' + TRIPWIRE} is set. */`,
    `// if (${gate} !== '1') throw new Error('x')`,
    `/* if (${'process.env.' + TRIPWIRE}) throw new Error('x') */`,
    'const nothing = 1',
  ].join('\n')
  const strippedProse = stripTsComments(prose)
  assert.ok(!strippedProse.includes(gate), 'a commented-out read is not a read')
  assert.ok(!strippedProse.includes(`process.env.${TRIPWIRE}`), 'a commented-out tripwire is not a tripwire')
  assert.ok(!strippedProse.includes('throw new Error('), 'a commented-out throw is not a throw')
  assert.equal(strippedProse.split('\n').length, prose.split('\n').length,
    'stripping preserves line structure, so offsets still name the right place')
})

test('the shell reader reads the command, not the string', () => {
  const live = leadingAssignments(`${GATE}=1 ${TRIPWIRE}=1 tsx --test "tests/db/**/*.test.ts"`)
  assert.equal(live.assignments.get(GATE), '1')
  assert.equal(live.assignments.get(TRIPWIRE), '1')
  assert.match(live.rest, /^tsx --test/)

  const wholeCommandCommentedOut = leadingAssignments(`# ${GATE}=1 ${TRIPWIRE}=1 tsx --test "tests/db/*.test.ts"`)
  assert.equal(wholeCommandCommentedOut.assignments.size, 0, 'a commented-out script sets nothing')
  assert.equal(wholeCommandCommentedOut.rest, '', 'a commented-out script runs nothing')

  const mentioned = leadingAssignments(`echo ${GATE}=1 && tsx --test "tests/db/*.test.ts"`)
  assert.equal(mentioned.assignments.size, 0, 'an assignment after the command name sets nothing')

  const trailing = leadingAssignments(`${GATE}=1 tsx --test "tests/db/*.test.ts" # ${TRIPWIRE}=1`)
  assert.equal(trailing.assignments.get(GATE), '1')
  assert.equal(trailing.assignments.has(TRIPWIRE), false, 'a trailing comment sets nothing')
  assert.ok(!trailing.rest.includes('#'), 'the comment is gone from the command')

  // AN ARGUMENT IS NOT AN INVOCATION, which is the same rule as "a comment is not code" reached from
  // the other side. Removing comments alone still accepted `echo "npm run test:db"`; this test
  // exists because the mutation harness for r15 found exactly that and it went green.
  assert.equal(scriptInvokes('npm run test:db', DB_SUITE_INVOCATION), true, 'the command invokes it')
  assert.equal(scriptInvokes('npx prisma migrate deploy --schema prisma/schema.prisma', MIGRATE_INVOCATION),
    true, 'a known wrapper in front of the command still invokes it')
  assert.equal(scriptInvokes('echo "npm run test:db"', DB_SUITE_INVOCATION), false,
    'a quoted argument is one word and invokes nothing')
  assert.equal(scriptInvokes('echo npm run test:db > /dev/null', DB_SUITE_INVOCATION), false,
    'an unquoted argument is still an argument: echo is not a wrapper')
  assert.equal(scriptInvokes('# npm run test:db\necho x', DB_SUITE_INVOCATION), false,
    'a shell comment inside a run: block invokes nothing')
  assert.equal(scriptInvokes('echo start && npm run test:db', DB_SUITE_INVOCATION), true,
    'the second command of a chain is still a command')
  assert.deepEqual(shellCommands('A=1 npm run test:db && echo "done now"'),
    [['A=1', 'npm', 'run', 'test:db'], ['echo', 'done now']],
    'the splitter reads words, keeps a quoted argument whole, and ends a command at &&')
  assert.equal(invokes(['echo', 'npm', 'run', 'test:db'], DB_SUITE_INVOCATION), false,
    'position, not presence')
})

/**
 * o3d-11rf r14 (Codex r14, HIGH) — A PATH FILTER THAT NAMES A PATH THAT DOES NOT EXIST.
 *
 * WHAT WAS FOUND. The job added above was gated on `lib/db.ts`, and there is no `lib/db.ts`. The
 * database client both suites import is `lib/db/index.ts`, reached as `../../lib/db`. A pull request
 * touching only that client therefore did not start the job that runs the evidence about it:
 * `test:unit` collected the two suites and skipped them, exactly as it did before the job existed.
 * A filter naming nothing looks identical — in the file, and in the Actions UI — to a filter that
 * works. It never errors. It just silently declines to match.
 *
 * WHY THE CHECKS BELOW ARE ABOUT THE CLASS AND NOT ABOUT `lib/db/**`. Asserting that this workflow
 * lists `lib/db/**` would correct the sentence and leave the grammar: the next filter to name a
 * moved, renamed or mistyped path would be just as dead and just as invisible. What is wrong with
 * `lib/db.ts` is checkable without knowing anything about `lib/db` at all — A GLOB THAT MATCHES
 * ZERO FILES IN THE REPOSITORY IS A FILTER DOING NOTHING — so the assertion is universal: every
 * path filter, in every workflow, under `paths:` and under `paths-ignore:`, must match at least one
 * tracked file. The list it is stated over is PARSED from the workflows, never maintained here.
 *
 * AND SEPARATELY, THE PROPERTY THE DEAD FILTER WAS SUPPOSED TO CARRY. "Matches something" is not
 * "matches the right thing": `lib/db.ts` could have been a live-but-irrelevant path and the class
 * check would be satisfied while the job still never ran on a client change. That half is checkable
 * generically too. The gated suites' own relative imports are resolved to repository files, and
 * every one of them must be covered by EVERY event's `paths:` list. Nothing below names `lib/db`;
 * the walk finds it because the suites import it.
 *
 * PER EVENT, NOT PER FILE. `pull_request:` and `push:` carry SEPARATE `paths:` lists here, and the
 * earlier version of the last check below flattened both into one — a path present in only one of
 * them read as covered. Every coverage assertion is now made against one event's list at a time.
 */

const WORKFLOW_DIR = '.github/workflows'

/**
 * Every file the repository tracks. This is the universe a GitHub path filter is compared against:
 * the filter is matched against the paths of the files a push or pull request CHANGED, and only a
 * tracked file can appear in that set. Read from git rather than by walking the filesystem, so that
 * build output, node_modules and untracked scratch files cannot make a dead filter look alive.
 */
function trackedFiles(): string[] {
  return execSync('git ls-files', { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    .split('\n')
    .filter(Boolean)
}

type PathFilter = { workflow: string; event: string; key: 'paths' | 'paths-ignore'; value: string; line: number }

/**
 * The `paths:` / `paths-ignore:` entries of a workflow's `on:` block, each tagged with the EVENT and
 * the KEY it was found under.
 *
 * A COMMENT IS NOT A FILTER — and since r15 that is not a rule this function implements, it is a
 * property of reading the document as a structure at all: a commented-out list entry is not a node,
 * so there is nothing here to exclude. Nor can an entry under `paths-ignore:` stand in for one under
 * `paths:`: the key is carried on every entry so that a coverage question can be asked of `paths`
 * alone. (Both are still subject to the dead-glob check: a `paths-ignore:` entry matching nothing is
 * equally a no-op.)
 */
function parseTriggerPathFilters(source: string, workflow: string): PathFilter[] {
  const tree = asMap(parseWorkflowYaml(source, workflow))
  const on = tree === null ? null : asMap(tree.on)
  if (on === null) return []
  const found: PathFilter[] = []
  for (const [event, config] of Object.entries(on)) {
    const settings = asMap(config)
    if (settings === null) continue
    for (const key of ['paths', 'paths-ignore'] as const) {
      const declared = settings[key]
      if (declared === undefined || declared === null) continue
      // A single-entry list may be written as a scalar; reading it as "no filter" would under-read.
      const entries = asSeq(declared) ?? [declared]
      for (const entry of entries) {
        const value = asString(entry)
        assert.ok(value !== null,
          `${workflow} ${event}.${key} contains an entry that is not a string: ${JSON.stringify(entry)}`)
        found.push({ workflow, event, key, value: value as string, line: lineOf(source, value as string) })
      }
    }
  }
  return found
}

/** Where a filter entry sits in the file — for the error message only, never for a decision. */
function lineOf(source: string, value: string): number {
  const lines = source.split('\n')
  const at = lines.findIndex((line) => !line.trimStart().startsWith('#')
    && new RegExp(`^\\s*-\\s+["']?${value.replace(/[.*+^${}()|[\]\\?]/g, '\\$&')}["']?\\s*$`).test(line))
  return at + 1
}

/**
 * One event's trigger filters, split by key, for every event that declares at least one.
 *
 * The two keys are OPPOSITES and are kept apart deliberately. Under `paths:` a glob is the reason a
 * workflow runs; under `paths-ignore:` the same glob is the reason it does NOT. Asking "is this file
 * covered?" of a flattened list would report a file that is explicitly EXCLUDED as included, so a
 * `paths:` list renamed to `paths-ignore:` — one character short of invisible in a diff — would read
 * as still covering everything it names. Each caller states both halves: what `paths:` must match,
 * and what `paths-ignore:` must not.
 */
function triggerFiltersByEvent(workflow: string): Map<string, { paths: string[]; ignore: string[] }> {
  const source = readFileSync(path.join(REPO_ROOT, workflow), 'utf8')
  const byEvent = new Map<string, { paths: string[]; ignore: string[] }>()
  for (const filter of parseTriggerPathFilters(source, workflow)) {
    const entry = byEvent.get(filter.event) ?? { paths: [], ignore: [] }
    if (filter.key === 'paths') entry.paths.push(filter.value)
    else entry.ignore.push(filter.value)
    byEvent.set(filter.event, entry)
  }
  return byEvent
}

/**
 * Every reason `${WORKFLOW}` would decline to run on a change to `file`, for one event. Empty means
 * the event does start the workflow for that file.
 */
function reasonsNotTriggered(file: string, event: string, filters: { paths: string[]; ignore: string[] }): string[] {
  const reasons: string[] = []
  if (filters.paths.length > 0 && !filters.paths.some((glob) => globToRegExp(glob).test(file))) {
    reasons.push(`no ${event} paths: entry matches it`)
  }
  const excludedBy = filters.ignore.filter((glob) => globToRegExp(glob).test(file))
  if (excludedBy.length > 0) reasons.push(`${event} paths-ignore: excludes it via ${JSON.stringify(excludedBy)}`)
  return reasons
}

/** A relative import specifier resolved to the repository file it actually loads, or null. */
function resolveRelativeImport(fromFile: string, specifier: string, tracked: Set<string>): string | null {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier))
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.mts`, `${base}.cts`, `${base}.js`,
    `${base}.mjs`, `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`, `${base}/index.mjs`]
  return candidates.find((candidate) => tracked.has(candidate)) ?? null
}

/**
 * The relative import specifiers of one module, both static `from '...'` and dynamic `import('...')`.
 * Read from the file's live source: a commented-out import loads nothing, and a workflow does not
 * have to be triggered by changes to a module no longer imported.
 */
function relativeImportsOf(source: string): string[] {
  return [...new Set([
    ...[...source.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g)].map((match) => match[1]),
    ...[...source.matchAll(/\b(?:import|require)\s*\(\s*['"](\.[^'"]+)['"]/g)].map((match) => match[1]),
  ])]
}

test('the trigger parser reads filters, not prose: comments and paths-ignore supply no coverage', () => {
  // The parser is the thing every assertion below stands on, so it is pinned against a document
  // built to defeat it: a prose mention of a path, a commented-out list entry at the list's own
  // indentation, a commented-out entry indented as a key, an entry under paths-ignore, and a
  // list item outside the on: block entirely.
  const fixture = [
    'name: Fixture',
    '# Prose about "lib/db/**" and lib/db/index.ts, at length, naming paths it does not filter on.',
    'on:',
    '  pull_request:',
    '    # - "lib/commented-out-as-a-key.ts"',
    '    paths:',
    '      - "lib/real.ts"',
    '#      - "lib/commented-out-as-an-entry.ts"',
    '      - lib/unquoted.ts',
    '  push:',
    '    branches:',
    '      - development',
    '    paths-ignore:',
    '      - "lib/ignored.ts"',
    '',
    'jobs:',
    '  a:',
    '    steps:',
    '      - "not a path filter at all"',
    '',
  ].join('\n')
  const parsed = parseTriggerPathFilters(fixture, 'fixture.yml')
  assert.deepEqual(parsed.map((filter) => `${filter.event}.${filter.key}=${filter.value}`), [
    'pull_request.paths=lib/real.ts',
    'pull_request.paths=lib/unquoted.ts',
    'push.paths-ignore=lib/ignored.ts',
  ], 'the parser must read exactly the live list entries: no prose, no commented-out lines, and '
    + 'nothing from outside the on: block')
  assert.deepEqual(parsed.filter((filter) => filter.key === 'paths').map((filter) => filter.value),
    ['lib/real.ts', 'lib/unquoted.ts'],
    'an entry under paths-ignore: must never be counted as coverage under paths:')
  // And the branches list, which sits at the same indentation as a paths list, is not a path filter.
  assert.ok(!parsed.some((filter) => filter.value === 'development'), 'branches: is not paths:')
})

test('every path filter in every workflow matches at least one file that exists in the repository', () => {
  const tracked = trackedFiles()
  // The universe has to be real: if `git ls-files` returned nothing, EVERY glob would match nothing
  // and this check would report the whole repository as dead rather than pass vacuously — but it
  // would report it for the wrong reason, so the list is anchored before it is used.
  assert.ok(tracked.length > 100 && tracked.includes('package.json'),
    `the tracked-file list is not a repository listing (${tracked.length} entries)`)

  const workflows = readdirSync(path.join(REPO_ROOT, WORKFLOW_DIR)).filter((name) => /\.ya?ml$/.test(name))
  assert.ok(workflows.length > 0, `${WORKFLOW_DIR} contains no workflow files; the walk reached nothing`)

  const filters: PathFilter[] = []
  for (const name of workflows) {
    const relative = `${WORKFLOW_DIR}/${name}`
    const source = readFileSync(path.join(REPO_ROOT, relative), 'utf8')
    // A parser that silently stopped reading would turn this check green over any number of dead
    // filters, so a file that DECLARES a list must yield entries from it. Raw text on purpose, and
    // in the safe direction: it can only ever complain that the parse read TOO LITTLE.
    if (/^ {4}paths(-ignore)?:\s*$/m.test(source)) {
      assert.ok(parseTriggerPathFilters(source, relative).length > 0,
        `${relative} declares a paths: list and the trigger parser read none of it`)
    }
    filters.push(...parseTriggerPathFilters(source, relative))
  }
  assert.ok(filters.length > 0, 'no workflow declares a path filter; the walk reached nothing')

  // The matcher must be able to say NO, and specifically it must not read a FILE path as covering
  // the DIRECTORY that replaced it. That is the r14 defect exactly, and if this line ever passes in
  // the other direction every dead filter below reads as live.
  assert.equal(globToRegExp('lib/db.ts').test('lib/db/index.ts'), false,
    'a filter naming a file must not be treated as matching a path inside a directory of that name')
  assert.equal(globToRegExp('lib/db/**').test('lib/db/index.ts'), true,
    'the matcher must accept a directory glob over a file directly inside it')

  const dead = filters
    .filter((filter) => !tracked.some((file) => globToRegExp(filter.value).test(file)))
    .map((filter) => `${filter.workflow}:${filter.line} (${filter.event}.${filter.key}) ${filter.value}`)
  assert.deepEqual(dead, [],
    'these path filters match no file in the repository, so they contribute nothing to the trigger '
    + 'and a change they were written to catch starts no job. A filter naming a moved, renamed or '
    + 'mistyped path never errors — it silently declines to match, and reads as working')
})

test(`${WORKFLOW} is triggered by changes to the gated files themselves, on every event that filters`, () => {
  // A path-filtered workflow that does not list tests/db/** would not run on a pull request that
  // only changed one of these suites — the job would exist and still never execute.
  const byEvent = triggerFiltersByEvent(WORKFLOW)
  assert.ok(byEvent.size > 0, `${WORKFLOW} declares no path filters to check`)
  for (const [event, filters] of byEvent) {
    for (const file of gatedFiles) {
      const reasons = reasonsNotTriggered(file, event, filters)
      assert.deepEqual(reasons, [],
        `a ${event} changing only ${file} would not trigger ${WORKFLOW}, so the job added for it `
        + 'would never run')
    }
  }
})

test(`${WORKFLOW} is also triggered by the modules the gated files import`, () => {
  // THE r14 FINDING AS A RULE. A suite that runs only when its own text changes is half-wired: the
  // regressions it exists to catch arrive in the code it CALLS. The dependencies are resolved from
  // the suites' own import statements, so nothing here has to be kept in step by hand.
  const tracked = new Set(trackedFiles())
  const dependencies = new Map<string, string[]>()
  for (const file of gatedFiles) {
    const specifiers = relativeImportsOf(liveSourceOf(file))
    assert.ok(specifiers.length > 0,
      `no relative import was read out of ${file}; the import extractor reached nothing, which `
      + 'would make every assertion below a loop over an empty list')
    dependencies.set(file, specifiers.map((specifier) => {
      const target = resolveRelativeImport(file, specifier, tracked)
      assert.ok(target, `${file} imports ${specifier}, which resolves to no tracked file`)
      return target as string
    }))
  }

  const byEvent = triggerFiltersByEvent(WORKFLOW)
  assert.ok(byEvent.size > 0, `${WORKFLOW} declares no path filters to check`)
  for (const [event, filters] of byEvent) {
    for (const [file, targets] of dependencies) {
      for (const target of targets) {
        assert.deepEqual(reasonsNotTriggered(target, event, filters), [],
          `${WORKFLOW} would not run on a ${event} changing only ${target}, which ${file} imports `
          + 'directly. The job that runs that suite would not start, and test:unit would collect it '
          + `and skip it — which is the r13 finding all over again, reached through the trigger `
          + 'instead of through the environment')
      }
    }
  }
})

test('all checked-in workflows parse, so no assertion above is asked of a document it could not read', () => {
  // Every workflow, not only the one this guard is about: the readers are shared, and a workflow the
  // parser cannot read is a workflow whose filters and steps go unchecked.
  const workflows = readdirSync(path.join(REPO_ROOT, WORKFLOW_DIR)).filter((name) => /\.ya?ml$/.test(name))
  assert.ok(workflows.length > 0, `${WORKFLOW_DIR} contains no workflow files`)
  for (const name of workflows) {
    const relative = `${WORKFLOW_DIR}/${name}`
    const source = readFileSync(path.join(REPO_ROOT, relative), 'utf8')
    const tree = asMap(parseWorkflowYaml(source, relative))
    assert.ok(tree, `${relative} did not parse to a mapping`)
    assert.ok(asMap((tree as YamlMap).jobs), `${relative} parsed without a jobs: mapping`)
  }
})
