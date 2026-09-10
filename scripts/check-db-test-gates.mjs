#!/usr/bin/env node

/**
 * o3d-n3yt — EVERY `RUN_DB_*` GATE IN `tests/db/` MUST BE SET IN THE PROCESS THAT ACTUALLY RUNS THAT
 * FILE, WITH A `REQUIRE_` COUNTERPART SOMETHING ACTUALLY READS.
 *
 * WHAT WENT WRONG (Codex r18, HIGH). `tests/db/shopping-webhook-retention-evidence.test.ts` gates its
 * one test on `RUN_DB_RETENTION_TESTS`, and nothing set it — not a workflow, not an npm script. That
 * test is the only executable evidence that the WooCommerce order-payload hold actually holds, and it
 * reported `# SKIP` inside a green `npm run test:unit` run, with no message, for as long as it
 * existed. A gate invented by one file and wired up by nobody is invisible by construction.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THIS FILE WAS REWRITTEN IN r20 (Codex r19: FOUR HIGHs, ONE LESSON).
 *
 * The r19 census enumerated the shapes its author had thought of and PASSED everything else, and its
 * one non-vacuity check — "at least one gate was found somewhere" — was satisfied by the single gate
 * that was already known, so the counter stayed nonzero precisely while the scan was blind. Four
 * separate ways in were found in one round:
 *
 *   1. `const gate = 'RUN_DB_NEW'; process.env[gate]` — a computed key contributed no gate;
 *   2. `readGate('RUN_DB_NEW')` — a delegated read contributed no gate;
 *   3. a gated file in `tests/db/<subdir>/` — collected by the test command's `**` glob, invisible to
 *      a `readdirSync` that only listed direct children;
 *   4. `RUN_DB_RETENTION_TESTS=1 REQUIRE_DB_RETENTION_TESTS=1 true tests/db` — a script that passed
 *      every check by MENTIONING the directory, then exited 0 having collected no tests at all.
 *
 * The answer is not a fifth round of shape-matching. It is to INVERT THE DEFAULT and to stop asking
 * questions whose answers can be faked by text:
 *
 *   A. AN INPUT THIS CENSUS CANNOT MODEL IS A FAILURE, NAMED BY FILE AND LINE. Every syntactic use of
 *      `process.env` is classified, and anything outside the handful of shapes below is reported,
 *      with its position, as a shape the census refuses to guess at. So is any string literal whose
 *      WHOLE text is a `RUN_DB_*` name and which is not itself the key of a `process.env[...]` read —
 *      which is what a delegated `readGate('RUN_DB_NEW')` looks like.
 *   B. THE FILE LIST IS NOT ASSUMED. It is the recursive set of `*.test.ts` under the suite directory,
 *      AND it must equal, exactly, the set of files the npm script's own runner collects.
 *   C. THE COMMAND IS JUDGED BY WHAT IT DOES. `command.includes('tests/db')` is gone. The script is
 *      RUN, with `scripts/db-test-gate-collection-probe.mjs` on `NODE_OPTIONS`, which records each
 *      collected file and exits that child before the test file is loaded. Nothing in the suite
 *      executes; what comes back is the runner's own collection, and an empty collection is a
 *      failure. `true tests/db` records nothing and fails here.
 *   D. THE GATE VERDICTS COME FROM THE PROCESS THAT WOULD HAVE RUN THE FILE. The probe also records
 *      the `RUN_DB_*`/`REQUIRE_DB_*` values present in each collected file's own child process. That
 *      replaces the r19 shell model — which had to refuse `;`, `&&` and pipes because it could not
 *      tell which command an assignment prefix reached — with the observed answer. The census strips
 *      every `RUN_DB_*`/`REQUIRE_DB_*` from the environment it hands the spawn, so an operator who
 *      happens to have a gate exported cannot make the script look wired when it is not.
 *   E. NON-VACUITY IS PER FILE. Not "some gate was found" but "every file in the list was read and
 *      parsed with no syntax errors". One file that fails to parse fails the census even while
 *      another file yields a known gate.
 *
 * WHAT IT STILL DOES NOT COVER, PLAINLY, because a guard that reports enforcement it does not have is
 * worse than none (rounds 13-16 of o3d-11rf were withdrawn for exactly that):
 *
 *   * A gate read by a MODULE THE TEST IMPORTS, where the gate's name never appears in the test file
 *     itself. The literal rule in (A) catches the delegated call `readGate('RUN_DB_NEW')`; it cannot
 *     catch `runIfGated()` where the name lives only in the helper. Only the collected test files are
 *     scanned. Recorded in docs/development.md as NOT ENFORCED.
 *   * A gate name that appears only inside a LONGER string ("set RUN_DB_X to run these"). That is
 *     prose, not a read, and treating it as one would make every helpful error message a build
 *     failure.
 *   * WHETHER CI STILL INVOKES `npm run test:db`. This census reads package.json and the suite, never
 *     the workflow. The reader that tried to prove that is the one o3d-11rf withdrew.
 *   * A test-file child that node's runner does NOT spawn (`--test-isolation=none`). The probe is
 *     inert there, the collection comes back empty, and the census FAILS rather than passing blind.
 * ---------------------------------------------------------------------------------------------
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

// import.meta.dirname is undefined when this module is loaded through tsx.
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, '..')

/** The module the collection probe injects into each test-file child. Always beside this script. */
const PROBE_MODULE = path.join(SCRIPT_DIR, 'db-test-gate-collection-probe.mjs')

/**
 * Each entry pairs a directory of gated test files with the npm script that is supposed to run them.
 * The pairing is the whole subject: a gate discovered in `dir` must be set in the process `script`
 * starts for the file that reads it.
 */
export const SUITES = [{ dir: 'tests/db', script: 'test:db' }]

/** The gate names this guard is about. `REQUIRE_` names are derived from these, never scanned for. */
export const GATE_RE = /^RUN_DB_[A-Z0-9_]+$/

/** Both halves of a pair, for the environment the probe is handed and for what it records. */
const GATE_ENV_RE = /^(RUN|REQUIRE)_DB_[A-Z0-9_]*$/

/** `RUN_DB_X` -> `REQUIRE_DB_X`. */
export function counterpartOf(gate) {
  return gate.replace(/^RUN_/, 'REQUIRE_')
}

export const ALLOWLIST_FILE = 'scripts/db-test-gate-allowlist.json'

// ---------------------------------------------------------------------------------------------
// The test files: syntax tree, never text — and every shape outside the list is an error.
// ---------------------------------------------------------------------------------------------

function isProcessEnv(node) {
  return (
    ts.isPropertyAccessExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === 'process'
    && node.name.text === 'env'
  )
}

function positionOf(sourceFile, node) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  return `${line + 1}:${character + 1}`
}

const MODEL_OR_FAIL =
  'Write the read as process.env.NAME, process.env["NAME"] or const { NAME } = process.env, or teach '
  + 'scripts/check-db-test-gates.mjs the new shape. It will not guess: a shape it cannot resolve to a '
  + 'name is how a gated test skips inside a green run without anything saying so.'

/**
 * Every environment-variable name this source READS, and every place it touches the environment in a
 * way this census cannot resolve to a name. The second list is the point: it is what makes an
 * unrecognised shape a failure instead of a silent zero.
 *
 * @returns {{ names: Set<string>, problems: string[], parsed: boolean }}
 */
export function scanSource(sourceText, fileName) {
  const problems = []
  const names = new Set()
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

  // A file the parser could not read is a file whose gates are unknown. It is not an empty file.
  const diagnostics = sourceFile.parseDiagnostics ?? []
  if (diagnostics.length > 0) {
    const first = diagnostics[0]
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(first.start ?? 0)
    problems.push(
      `${fileName}:${line + 1}:${character + 1} does not parse `
      + `(${ts.flattenDiagnosticMessageText(first.messageText, ' ')}), so this census cannot tell which `
      + 'gates it reads. An unreadable file is not an ungated one.',
    )
    return { names, problems, parsed: false }
  }

  /** String-literal nodes that ARE a `process.env["NAME"]` key, so the literal rule may skip them. */
  const claimedLiterals = new Set()
  const unmodelled = (node, what) => problems.push(`${fileName}:${positionOf(sourceFile, node)} ${what}`)

  const classifyEnvUse = (envNode) => {
    const parent = envNode.parent

    // process.env.NAME — including `process.env.NAME = x` and `delete process.env.NAME`.
    if (parent && ts.isPropertyAccessExpression(parent) && parent.expression === envNode) {
      if (ts.isIdentifier(parent.name)) names.add(parent.name.text)
      else unmodelled(parent, `reads process.env under ${parent.name.getText(sourceFile)}. ${MODEL_OR_FAIL}`)
      return
    }

    // process.env['NAME'] — a STRING LITERAL key only. Anything else is the r19 blind spot.
    if (parent && ts.isElementAccessExpression(parent) && parent.expression === envNode) {
      const arg = parent.argumentExpression
      if (arg && ts.isStringLiteralLike(arg)) {
        names.add(arg.text)
        claimedLiterals.add(arg)
        return
      }
      unmodelled(
        parent,
        `reads process.env under the COMPUTED key ${arg ? JSON.stringify(arg.getText(sourceFile).slice(0, 60)) : '(nothing)'}, `
        + `which this census cannot resolve to a variable name. ${MODEL_OR_FAIL}`,
      )
      return
    }

    // const { NAME, OTHER } = process.env
    if (parent && ts.isVariableDeclaration(parent) && parent.initializer === envNode) {
      if (!ts.isObjectBindingPattern(parent.name)) {
        unmodelled(
          parent,
          `binds the whole of process.env to ${parent.name.getText(sourceFile)}, so every later read `
          + `through that name is invisible here. ${MODEL_OR_FAIL}`,
        )
        return
      }
      for (const element of parent.name.elements) {
        if (element.dotDotDotToken) {
          unmodelled(element, `destructures the REST of process.env, which names nothing. ${MODEL_OR_FAIL}`)
          continue
        }
        const source = element.propertyName ?? element.name
        if (ts.isIdentifier(source)) names.add(source.text)
        else if (ts.isStringLiteralLike(source)) { names.add(source.text); claimedLiterals.add(source) }
        else unmodelled(element, `destructures process.env under a computed key. ${MODEL_OR_FAIL}`)
      }
      return
    }

    // { ...process.env, DATABASE_URL: url } — FORWARDING the environment to a child process, which
    // tests/db/startup-option-verdict-across-bundles.test.ts does when it spawns a built server. It
    // reads no name here, and it cannot make a test in THIS directory skip: the reader of anything it
    // carries is the spawned program, not a file in the census. Modelled, and modelled narrowly —
    // only as a spread inside an object literal.
    if (parent && ts.isSpreadAssignment(parent) && parent.expression === envNode) return

    unmodelled(
      parent ?? envNode,
      `uses process.env in a shape this census cannot model (${ts.SyntaxKind[(parent ?? envNode).kind]}). `
      + MODEL_OR_FAIL,
    )
  }

  const visit = (node) => {
    if (isProcessEnv(node)) classifyEnvUse(node)
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  // A gate NAME standing alone as a string is the delegated read: `readGate('RUN_DB_NEW')`,
  // `const gate = 'RUN_DB_NEW'`. The census cannot follow where it goes, so it refuses to pass it.
  const visitLiterals = (node) => {
    if (ts.isStringLiteralLike(node) && GATE_RE.test(node.text) && !claimedLiterals.has(node)) {
      unmodelled(
        node,
        `names the gate ${node.text} as a bare string literal rather than reading it from process.env. `
        + 'A gate reached through a helper or a variable cannot be traced to the process that sets it, '
        + `so this census refuses it. ${MODEL_OR_FAIL}`,
      )
    }
    ts.forEachChild(node, visitLiterals)
  }
  visitLiterals(sourceFile)

  return { names, problems, parsed: true }
}

// ---------------------------------------------------------------------------------------------
// The command: run it, and see what it collects.
// ---------------------------------------------------------------------------------------------

/**
 * Runs `npm run <script>` with the collection probe injected, and returns what the runner collected
 * together with the gate values each collected file's own process was started with.
 *
 * NOTHING IN THE SUITE EXECUTES. The probe records and exits each child before the test file loads,
 * so this costs a process spawn per file and touches no database.
 */
export function collectFromScript({ repoRoot, script }) {
  const problems = []
  const observed = new Map()
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'db-test-gate-census-'))
  const logFile = path.join(scratch, 'collected.jsonl')
  let result
  let raw = ''
  try {
    writeFileSync(logFile, '')
    // THE ENVIRONMENT THE SPAWN STARTS FROM, with three things deliberately removed:
    //   * every RUN_DB_*/REQUIRE_DB_* — a gate the operator happens to have exported must not be able
    //     to make an unwired script look wired;
    //   * NODE_TEST_CONTEXT — node's test runner sets it in ITS children, and it is then inherited by
    //     everything they spawn. Left in place when this census is itself run from inside a test, the
    //     probe would fire in npm's own process and exit it before the runner started;
    //   * DB_TEST_GATE_COLLECTION_LOG — this call's log file is the only one that may be written.
    const env = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (GATE_ENV_RE.test(key)) continue
      if (key === 'NODE_TEST_CONTEXT' || key === 'DB_TEST_GATE_COLLECTION_LOG') continue
      env[key] = value
    }
    env.DB_TEST_GATE_COLLECTION_LOG = logFile
    env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --import ${pathToFileURL(PROBE_MODULE).href}`.trim()
    result = spawnSync('npm', ['run', '--silent', script], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      timeout: 300_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    raw = readFileSync(logFile, 'utf8')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }

  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      problems.push(`the collection probe wrote a line "${script}" cannot be judged from: ${line.slice(0, 200)}`)
      continue
    }
    const absolute = String(record.file ?? '')
    const rel = path.relative(repoRoot, absolute).split(path.sep).join('/')
    if (rel === '' || rel.startsWith('..')) {
      problems.push(`"${script}" collected ${absolute}, which is outside the repository.`)
      continue
    }
    const gates = record.gates && typeof record.gates === 'object' ? record.gates : {}
    const previous = observed.get(rel)
    if (previous && JSON.stringify(previous) !== JSON.stringify(gates)) {
      problems.push(`"${script}" started ${rel} more than once with different gate values, so no verdict about it is stable.`)
    }
    observed.set(rel, gates)
  }

  return {
    problems,
    observed,
    detail:
      `exit ${result?.status === null ? `killed by ${result?.signal}` : result?.status}`
      + `${result?.error ? `, error ${result.error.message}` : ''}`
      + `${result?.stderr ? `, stderr: ${String(result.stderr).trim().split('\n').slice(-3).join(' | ').slice(0, 400)}` : ''}`,
  }
}

/** Every `*.test.ts` under `dir`, at ANY depth — the test command's glob is `**`, so this must be. */
export function testFilesUnder(repoRoot, dir) {
  const found = []
  const walk = (rel) => {
    for (const entry of readdirSync(path.join(repoRoot, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const childRel = `${rel}/${entry.name}`
      if (entry.isDirectory()) walk(childRel)
      else if (entry.isFile() && entry.name.endsWith('.test.ts')) found.push(childRel)
    }
  }
  walk(dir)
  return found.sort()
}

// ---------------------------------------------------------------------------------------------

export function readAllowlist(repoRoot) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path.join(repoRoot, ALLOWLIST_FILE), 'utf8'))
  } catch (error) {
    throw new Error(`${ALLOWLIST_FILE} is missing or not valid JSON: ${error.message}`)
  }
  const entries = new Map()
  for (const [gate, entry] of Object.entries(parsed)) {
    const reason = entry && typeof entry === 'object' ? entry.reason : undefined
    if (typeof reason !== 'string' || reason.trim().length < 20) {
      throw new Error(
        `${ALLOWLIST_FILE} entry "${gate}" needs a "reason" of at least 20 characters saying why this `
        + 'gate is deliberately not run in CI. A suppression without one is indistinguishable from '
        + 'the defect.',
      )
    }
    entries.set(gate, reason)
  }
  return entries
}

export function auditSuite(suite, { repoRoot, scripts, allowlist }) {
  const problems = []
  const empty = { problems, files: [], parsedFiles: [], gates: new Map() }

  if (!Object.prototype.hasOwnProperty.call(scripts, suite.script)) {
    problems.push(`package.json has no "${suite.script}" script, so nothing runs ${suite.dir}.`)
    return empty
  }

  let files
  try {
    files = testFilesUnder(repoRoot, suite.dir)
  } catch (error) {
    problems.push(`${suite.dir} could not be walked (${error.message}), so this census scanned nothing.`)
    return empty
  }
  if (files.length === 0) {
    problems.push(`${suite.dir} contains no *.test.ts files — this census scanned nothing.`)
    return { ...empty, files }
  }

  // WHAT THE COMMAND ACTUALLY COLLECTS, not what its text mentions.
  const collection = collectFromScript({ repoRoot, script: suite.script })
  problems.push(...collection.problems)
  const collected = collection.observed
  if (collected.size === 0) {
    problems.push(
      `"${suite.script}" (${JSON.stringify(scripts[suite.script])}) collected NO test files at all: no Node `
      + `test-runner child process started for any of the ${files.length} file(s) in ${suite.dir} `
      + `(${collection.detail}). Naming the directory in the command is not running it.`,
    )
  }
  const notCollected = files.filter((file) => !collected.has(file))
  if (collected.size > 0 && notCollected.length > 0) {
    problems.push(
      `"${suite.script}" does not collect ${notCollected.join(', ')}, which ${notCollected.length === 1 ? 'is a' : 'are'} `
      + `*.test.ts file(s) under ${suite.dir}. A file the command's glob misses never runs and never says so.`,
    )
  }
  const unexpected = [...collected.keys()].filter((file) => !files.includes(file)).sort()
  if (unexpected.length > 0) {
    problems.push(
      `"${suite.script}" collects ${unexpected.join(', ')}, which this census did not scan. The set it runs `
      + `and the set ${suite.dir} holds must be the same set.`,
    )
  }

  /** gate -> the files that read it, and whether each also reads the REQUIRE_ counterpart. */
  const gates = new Map()
  const parsedFiles = []
  for (const rel of files) {
    let text
    try {
      text = readFileSync(path.join(repoRoot, rel), 'utf8')
    } catch (error) {
      problems.push(`${rel} could not be read (${error.message}), so its gates are unknown.`)
      continue
    }
    const scan = scanSource(text, rel)
    problems.push(...scan.problems)
    if (!scan.parsed) continue
    parsedFiles.push(rel)
    for (const name of scan.names) {
      if (!GATE_RE.test(name)) continue
      const entry = gates.get(name) ?? { readers: [], tripwireReaders: [] }
      entry.readers.push(rel)
      if (scan.names.has(counterpartOf(name))) entry.tripwireReaders.push(rel)
      gates.set(name, entry)
    }
  }

  // NON-VACUITY, PER FILE. Not "some gate turned up somewhere" — that count stays nonzero on the
  // strength of one already-known gate while the rest of the scan is blind, which is Codex r19's
  // finding. Every file in the list must have been read AND parsed.
  const unparsed = files.filter((file) => !parsedFiles.includes(file))
  if (unparsed.length > 0) {
    problems.push(
      `this census reached no verdict about ${unparsed.join(', ')} — ${unparsed.length === 1 ? 'that file' : 'those files'} `
      + 'could not be read or could not be parsed. A census that skipped a file has not censused it.',
    )
  }

  for (const [gate, entry] of [...gates].sort()) {
    const require = counterpartOf(gate)
    if (allowlist.has(gate)) continue
    // THE OBSERVED ENVIRONMENT of the process the runner started for that very file.
    for (const rel of entry.readers) {
      const seen = collected.get(rel)
      if (!seen) continue // already reported above as not collected at all
      if (seen[gate] !== '1') {
        problems.push(
          `${gate} gates ${rel}, but the process "${suite.script}" started for that file had `
          + `${gate}=${JSON.stringify(seen[gate] ?? null)}, so the test SKIPs inside a green run. Set it in `
          + `the script, or add it to ${ALLOWLIST_FILE} with a reason.`,
        )
      }
      if (seen[require] !== '1') {
        problems.push(
          `the process "${suite.script}" started for ${rel} had ${require}=${JSON.stringify(seen[require] ?? null)}. `
          + `That is the fail-closed counterpart of ${gate}: without it, an edit that drops the gate goes `
          + 'back to skipping silently.',
        )
      }
    }
    if (entry.tripwireReaders.length === 0) {
      problems.push(
        `nothing in ${entry.readers.join(', ')} reads ${require}, so setting it would change nothing. `
        + `A file gated on ${gate} must throw on load when ${require} is 1 and ${gate} is not.`,
      )
    }
  }

  for (const gate of allowlist.keys()) {
    if (!gates.has(gate)) {
      problems.push(
        `${ALLOWLIST_FILE} suppresses ${gate}, but nothing in ${suite.dir} reads it. Remove the stale entry.`,
      )
    }
  }

  return { problems, files, parsedFiles, gates }
}

/**
 * Proves the reader above still reads, still ignores prose, and still REFUSES what it cannot model,
 * before any verdict is issued. A census whose scanner has quietly stopped matching reports a clean
 * run over nothing; a census whose refusals have quietly stopped refusing reports a clean run over
 * the four shapes Codex r19 walked in through.
 */
export function selfTest() {
  const fail = (what) => {
    throw new Error(
      `scripts/check-db-test-gates.mjs self-test FAILED: ${what} Every verdict this census issues `
      + 'depends on that reader, so it refuses to issue one.',
    )
  }

  const recognised = scanSource([
    '// RUN_DB_DECOY_ONE is named in a comment and must not count as a read.',
    'const message = "set RUN_DB_DECOY_TWO to run these"',
    'const a = process.env.RUN_DB_FIXTURE_ALPHA',
    "const b = process.env['RUN_DB_FIXTURE_BETA']",
    'const { RUN_DB_FIXTURE_GAMMA } = process.env',
    'const forwarded = { ...process.env, PORT: "1" }',
    'export { message, a, b, RUN_DB_FIXTURE_GAMMA, forwarded }',
  ].join('\n'), 'self-test-recognised.ts')
  const found = [...recognised.names].filter((name) => GATE_RE.test(name)).sort()
  const expected = ['RUN_DB_FIXTURE_ALPHA', 'RUN_DB_FIXTURE_BETA', 'RUN_DB_FIXTURE_GAMMA']
  if (found.join(',') !== expected.join(',')) {
    fail(`its process.env reader returned ${JSON.stringify(found)} on a fixture whose only real reads are ${JSON.stringify(expected)}.`)
  }
  if (recognised.problems.length > 0) {
    fail(`it refused a fixture built only of shapes it models: ${JSON.stringify(recognised.problems)}.`)
  }

  // The four r19 blind spots, each of which MUST now be reported rather than counted as zero.
  const mustRefuse = [
    ['a computed process.env key', "const gate = 'RUN_DB_FIXTURE_DELTA'\nexport const v = process.env[gate]"],
    ['a delegated gate read', "declare function readGate(n: string): string\nexport const v = readGate('RUN_DB_FIXTURE_EPSILON')"],
    ['the whole environment bound to a name', 'const env = process.env\nexport const v = env.RUN_DB_FIXTURE_ZETA'],
    ['process.env handed to a function', 'declare function take(e: unknown): void\nexport const v = take(process.env)'],
  ]
  for (const [what, source] of mustRefuse) {
    const scan = scanSource(source, 'self-test-refused.ts')
    if (scan.problems.length === 0) fail(`it accepted ${what}, which is how a gated test hides.`)
  }

  const broken = scanSource('const a = (((;', 'self-test-unparseable.ts')
  if (broken.parsed || broken.problems.length === 0) fail('it reported a clean scan of a file that does not parse.')
}

// ---------------------------------------------------------------------------------------------

export function runCensus({ repoRoot, suites = SUITES }) {
  selfTest()
  const scripts = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).scripts ?? {}
  const allowlist = readAllowlist(repoRoot)

  const problems = []
  let scannedFiles = 0
  let scannedGates = 0
  for (const suite of suites) {
    const result = auditSuite(suite, { repoRoot, scripts, allowlist })
    problems.push(...result.problems)
    scannedFiles += result.parsedFiles.length
    scannedGates += result.gates.size
  }

  if (scannedFiles === 0) problems.push('no test file was parsed at all.')
  return { problems, scannedFiles, scannedGates, suites }
}

function main(argv) {
  const rootFlag = argv.indexOf('--root')
  const repoRoot = rootFlag === -1 ? DEFAULT_REPO_ROOT : path.resolve(argv[rootFlag + 1] ?? '')
  const { problems, scannedFiles, scannedGates, suites } = runCensus({ repoRoot })

  if (problems.length > 0) {
    console.error('DB test-gate census FAILED:\n')
    for (const problem of problems) console.error(`  - ${problem}`)
    console.error('')
    process.exit(1)
  }
  console.log(
    `DB test-gate census OK: ${scannedGates} gate(s) across ${scannedFiles} parsed file(s) in `
    + `${suites.map((s) => s.dir).join(', ')}, each collected by its script and set, with its REQUIRE_ `
    + 'counterpart, in the process that would have run it.',
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    // A census that cannot complete has not passed. Everything above throws only where it would
    // otherwise have to guess, so this path is a failure and is reported as one.
    console.error(`DB test-gate census FAILED: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
