import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
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
 * Read by indentation rather than with a YAML library because this repository declares no YAML
 * dependency — `tests/production-readiness-workflow.test.ts` and `jobBlocks()` above read these
 * files as text for the same reason.
 *
 * A COMMENT IS NOT A FILTER, and that distinction is the one this guard has already been caught on
 * once: the tripwire check further up originally accepted a doc-comment mention as satisfying a
 * rule. So lines whose first non-space character is `#` are dropped before anything else looks at
 * them — a commented-out list entry supplies no coverage, and prose naming a path supplies none
 * either. Nor can an entry under `paths-ignore:` stand in for one under `paths:`: the key is carried
 * on every entry so that a coverage question can be asked of `paths` alone. (Both are still subject
 * to the dead-glob check: a `paths-ignore:` entry matching nothing is equally a no-op.)
 */
function parseTriggerPathFilters(source: string, workflow: string): PathFilter[] {
  const lines = source.split('\n')
  const start = lines.findIndex((line) => /^on:\s*$/.test(line))
  if (start < 0) return []
  const found: PathFilter[] = []
  let event: string | null = null
  let key: string | null = null
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') continue
    if (line.trimStart().startsWith('#')) continue
    if (!/^\s/.test(line)) break // back to column 0: the on: block has ended
    const eventHeader = /^ {2}([A-Za-z_][\w-]*):\s*$/.exec(line)
    if (eventHeader) {
      event = eventHeader[1]
      key = null
      continue
    }
    const keyHeader = /^ {4}([A-Za-z_][\w-]*):\s*$/.exec(line)
    if (keyHeader) {
      key = keyHeader[1]
      continue
    }
    const item = /^ {6}- (.+?)\s*$/.exec(line)
    if (!item || !event || (key !== 'paths' && key !== 'paths-ignore')) continue
    const raw = item[1]
    const quoted = /^"(.*)"$/.exec(raw) ?? /^'(.*)'$/.exec(raw)
    found.push({ workflow, event, key, value: quoted ? quoted[1] : raw, line: index + 1 })
  }
  return found
}

/** One event's `paths:` globs, keyed by event name. `paths-ignore:` is deliberately not included. */
function pathsByEvent(workflow: string): Map<string, string[]> {
  const source = readFileSync(path.join(REPO_ROOT, workflow), 'utf8')
  const byEvent = new Map<string, string[]>()
  for (const filter of parseTriggerPathFilters(source, workflow)) {
    if (filter.key !== 'paths') continue
    byEvent.set(filter.event, [...(byEvent.get(filter.event) ?? []), filter.value])
  }
  return byEvent
}

/** A relative import specifier resolved to the repository file it actually loads, or null. */
function resolveRelativeImport(fromFile: string, specifier: string, tracked: Set<string>): string | null {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier))
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.mts`, `${base}.cts`, `${base}.js`,
    `${base}.mjs`, `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`, `${base}/index.mjs`]
  return candidates.find((candidate) => tracked.has(candidate)) ?? null
}

/** The relative import specifiers of one module, both static `from '...'` and dynamic `import('...')`. */
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
    // filters, so a file that DECLARES a list must yield entries from it.
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
  const byEvent = pathsByEvent(WORKFLOW)
  assert.ok(byEvent.size > 0, `${WORKFLOW} declares no path filters to check`)
  for (const [event, globs] of byEvent) {
    const matchers = globs.map(globToRegExp)
    for (const file of gatedFiles) {
      assert.ok(matchers.some((matcher) => matcher.test(file)),
        `a ${event} changing only ${file} would not trigger ${WORKFLOW}: that event's paths filter `
        + 'does not cover the file, so the job added for it would never run')
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
    const specifiers = relativeImportsOf(readFileSync(path.join(REPO_ROOT, file), 'utf8'))
    assert.ok(specifiers.length > 0,
      `no relative import was read out of ${file}; the import extractor reached nothing, which `
      + 'would make every assertion below a loop over an empty list')
    dependencies.set(file, specifiers.map((specifier) => {
      const target = resolveRelativeImport(file, specifier, tracked)
      assert.ok(target, `${file} imports ${specifier}, which resolves to no tracked file`)
      return target as string
    }))
  }

  const byEvent = pathsByEvent(WORKFLOW)
  assert.ok(byEvent.size > 0, `${WORKFLOW} declares no path filters to check`)
  for (const [event, globs] of byEvent) {
    const matchers = globs.map(globToRegExp)
    for (const [file, targets] of dependencies) {
      for (const target of targets) {
        assert.ok(matchers.some((matcher) => matcher.test(target)),
          `${WORKFLOW}'s ${event} paths filter does not cover ${target}, which ${file} imports `
          + 'directly. A pull request changing only that module would not start the job that runs '
          + `${file}, and test:unit would collect it and skip it — which is the r13 finding all `
          + 'over again, reached through the trigger instead of through the environment')
      }
    }
  }
})
