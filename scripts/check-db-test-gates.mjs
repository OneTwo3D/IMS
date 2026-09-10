#!/usr/bin/env node

/**
 * o3d-n3yt — EVERY `RUN_DB_*` GATE IN `tests/db/` MUST BE SET BY THE SCRIPT CI RUNS, WITH A
 * `REQUIRE_` COUNTERPART SOMETHING ACTUALLY READS.
 *
 * WHAT WENT WRONG (Codex r18, HIGH). `tests/db/shopping-webhook-retention-evidence.test.ts` gates its
 * one test on `RUN_DB_RETENTION_TESTS`, and nothing set it — not a workflow, not an npm script. That
 * test is the only executable evidence that the WooCommerce order-payload hold actually holds, and it
 * reported `# SKIP` inside a green `npm run test:unit` run, with no message, for as long as it
 * existed. A gate invented by one file and wired up by nobody is invisible by construction.
 *
 * That is the defect class, not the defect: ONE RULE, SEVERAL READERS, ONE FIXED. This guard removes
 * the possibility rather than the instance. A new gated file in `tests/db/` that invents
 * `RUN_DB_SOMETHING_NEW` fails this check until it is either wired into `test:db` or written down in
 * the allowlist with a reason.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY IT PARSES THE WAY IT DOES. Rounds 14-16 of o3d-11rf shipped, and then withdrew, a guard over
 * this same workflow that produced five HIGH findings in one round: it parsed shell with regexes it
 * could not justify, it stripped TypeScript comments by hand, and its central rule was "the right
 * text appears within N lines of the wrong text" — which a stale line sitting next to the line that
 * corrects it satisfies forever. So:
 *
 *   1. IT REFUSES TO PARSE SHELL IT CANNOT MODEL. The only script shape accepted is a run of
 *      `NAME=bareword` assignments followed by ONE simple command. Anything else — a `;`, a `&&`, a
 *      pipe, a substitution, a quoted or expanded assignment value — and the guard FAILS, saying it
 *      cannot model the script. It never guesses which command an assignment reaches.
 *   2. IT READS THE SYNTAX TREE, NOT THE TEXT. Gates are collected from `process.env.X`,
 *      `process.env['X']` and `const { X } = process.env` in the TypeScript AST. A comment or a
 *      string that merely names a variable is not a read and cannot reach the tree, so no
 *      comment-stripping is involved and no proximity rule exists.
 *   3. IT PROVES ITS OWN READER ON EVERY RUN. `selfTest()` below parses a fixture that mentions a
 *      decoy gate ONLY in a comment and in a string literal, and requires the walker to return the
 *      real one and not the decoy. A walker that silently stopped finding anything — which is how a
 *      census turns vacuous — fails here before it can report success over an empty scan.
 *
 * WHAT IT DOES NOT COVER, PLAINLY. Only the directories in `SUITES`. `tests/concurrency/**` gates on
 * `RUN_DB_CONCURRENCY_TESTS`, which `npm run test:concurrency` sets and which has NO `REQUIRE_`
 * counterpart in any file, so adding it here would fail immediately rather than describe anything;
 * that is o3d-n3yt's follow-up, not this change. And nothing here proves the WORKFLOW still invokes
 * `npm run test:db` — the reader that tried to prove that is the one that was withdrawn, and its
 * absence is stated in docs/development.md.
 * ---------------------------------------------------------------------------------------------
 */

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

// import.meta.dirname is undefined when this module is loaded through tsx.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Each entry pairs a directory of gated test files with the npm script that is supposed to run them.
 * The pairing is the whole subject: a gate discovered in `dir` must be set by `script`.
 */
export const SUITES = [{ dir: 'tests/db', script: 'test:db' }]

/** The gate names this guard is about. `REQUIRE_` names are derived from these, never scanned for. */
export const GATE_RE = /^RUN_DB_[A-Z0-9_]+$/

/** `RUN_DB_X` -> `REQUIRE_DB_X`. */
export function counterpartOf(gate) {
  return gate.replace(/^RUN_/, 'REQUIRE_')
}

const ALLOWLIST_FILE = 'scripts/db-test-gate-allowlist.json'

// ---------------------------------------------------------------------------------------------
// The npm script: env-assignment prefix only, or refuse.
// ---------------------------------------------------------------------------------------------

/**
 * Characters that would let the remainder of a script be more than one simple command. A shell
 * applies an assignment prefix to the FIRST command only, so `A=1 one && two` leaves `two` without
 * it — and a guard that read the prefix and reported on `two` would be lying. None of these can be
 * modelled here, so their presence is a failure of this guard, reported as one.
 */
const UNMODELLABLE = [';', '&', '|', '`', '$', '\n', '<', '>']

/**
 * Splits `A=1 B=2 cmd args` into its assignments and its command. Throws rather than guessing.
 */
export function parseScript(name, raw) {
  let rest = String(raw)
  const env = new Map()
  const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=([A-Za-z0-9_.:\/-]*)(\s+)/
  for (;;) {
    const m = assignment.exec(rest)
    if (!m) break
    env.set(m[1], m[2])
    rest = rest.slice(m[0].length)
  }
  const bad = UNMODELLABLE.filter((c) => rest.includes(c))
  if (bad.length > 0) {
    throw new Error(
      `the npm script "${name}" contains ${JSON.stringify(bad.join(''))}, so this guard cannot tell `
      + 'which command its environment prefix reaches. Keep the script a single simple '
      + 'command with a plain assignment prefix, or extend scripts/check-db-test-gates.mjs to model '
      + 'the new shape. It will not guess.',
    )
  }
  if (rest.trim() === '') {
    throw new Error(`the npm script "${name}" is an assignment prefix with no command.`)
  }
  return { env, command: rest.trim() }
}

// ---------------------------------------------------------------------------------------------
// The test files: syntax tree, never text.
// ---------------------------------------------------------------------------------------------

function isProcessEnv(node) {
  return (
    ts.isPropertyAccessExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === 'process'
    && node.name.text === 'env'
  )
}

/** Every environment-variable name this source actually READS, from the AST alone. */
export function envNamesRead(sourceText, fileName) {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const names = new Set()
  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node) && isProcessEnv(node.expression)) {
      names.add(node.name.text)
    } else if (
      ts.isElementAccessExpression(node)
      && isProcessEnv(node.expression)
      && node.argumentExpression
      && ts.isStringLiteralLike(node.argumentExpression)
    ) {
      names.add(node.argumentExpression.text)
    } else if (
      ts.isVariableDeclaration(node)
      && node.initializer
      && isProcessEnv(node.initializer)
      && ts.isObjectBindingPattern(node.name)
    ) {
      for (const element of node.name.elements) {
        const source = element.propertyName ?? element.name
        if (ts.isIdentifier(source)) names.add(source.text)
        else if (ts.isStringLiteralLike(source)) names.add(source.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return names
}

/**
 * Proves the reader above still reads, and still ignores prose, before any verdict is issued.
 * A census whose scanner has quietly stopped matching reports a clean run over nothing; this is what
 * stops that from being indistinguishable from a clean repository.
 */
export function selfTest() {
  const fixture = [
    '// RUN_DB_DECOY_ONE is named in a comment and must not count as a read.',
    'const message = "set RUN_DB_DECOY_TWO to run these"',
    "const a = process.env.RUN_DB_FIXTURE_ALPHA",
    "const b = process.env['RUN_DB_FIXTURE_BETA']",
    'const { RUN_DB_FIXTURE_GAMMA } = process.env',
    'export { message, a, b, RUN_DB_FIXTURE_GAMMA }',
  ].join('\n')
  const found = [...envNamesRead(fixture, 'self-test.ts')].sort()
  const expected = ['RUN_DB_FIXTURE_ALPHA', 'RUN_DB_FIXTURE_BETA', 'RUN_DB_FIXTURE_GAMMA']
  if (found.join(',') !== expected.join(',')) {
    throw new Error(
      'scripts/check-db-test-gates.mjs self-test FAILED: its process.env reader returned '
      + `${JSON.stringify(found)} on a fixture whose only real reads are ${JSON.stringify(expected)}. `
      + 'Every verdict this guard issues depends on that reader, so it refuses to issue one.',
    )
  }
}

// ---------------------------------------------------------------------------------------------

function readAllowlist() {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path.join(REPO_ROOT, ALLOWLIST_FILE), 'utf8'))
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

export function auditSuite(suite, scripts, allowlist) {
  const problems = []
  const dir = path.join(REPO_ROOT, suite.dir)
  const files = readdirSync(dir).filter((f) => f.endsWith('.test.ts')).sort()
  if (files.length === 0) {
    problems.push(`${suite.dir} contains no *.test.ts files — this guard scanned nothing.`)
    return { problems, files, gates: new Map() }
  }

  /** gate -> the files that read it, and whether each also reads the REQUIRE_ counterpart. */
  const gates = new Map()
  for (const file of files) {
    const rel = path.join(suite.dir, file)
    const names = envNamesRead(readFileSync(path.join(dir, file), 'utf8'), rel)
    for (const name of names) {
      if (!GATE_RE.test(name)) continue
      const entry = gates.get(name) ?? { readers: [], tripwireReaders: [] }
      entry.readers.push(rel)
      if (names.has(counterpartOf(name))) entry.tripwireReaders.push(rel)
      gates.set(name, entry)
    }
  }

  if (!Object.prototype.hasOwnProperty.call(scripts, suite.script)) {
    problems.push(`package.json has no "${suite.script}" script, so nothing runs ${suite.dir}.`)
    return { problems, files, gates }
  }
  const { env, command } = parseScript(suite.script, scripts[suite.script])
  if (!command.includes(suite.dir)) {
    problems.push(
      `the npm script "${suite.script}" no longer names ${suite.dir} (it runs: ${command}), so the `
      + 'gates below are set for a run that collects different files.',
    )
  }

  for (const [gate, entry] of [...gates].sort()) {
    const require = counterpartOf(gate)
    if (allowlist.has(gate)) continue
    if (env.get(gate) !== '1') {
      problems.push(
        `${gate} gates ${entry.readers.join(', ')} but "${suite.script}" does not set it to 1, so those `
        + 'tests SKIP inside a green run. Add it to the script, or add it to '
        + `${ALLOWLIST_FILE} with a reason.`,
      )
    }
    if (env.get(require) !== '1') {
      problems.push(
        `"${suite.script}" does not set ${require}=1. That is the fail-closed counterpart of ${gate}: `
        + 'without it, an edit that drops the gate goes back to skipping silently.',
      )
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

  return { problems, files, gates }
}

function main() {
  selfTest()
  const scripts = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).scripts ?? {}
  const allowlist = readAllowlist()

  const problems = []
  let scannedFiles = 0
  let scannedGates = 0
  for (const suite of SUITES) {
    const result = auditSuite(suite, scripts, allowlist)
    problems.push(...result.problems)
    scannedFiles += result.files.length
    scannedGates += result.gates.size
  }

  // The walk must have REACHED something. A guard that scanned no file, or found no gate at all in a
  // directory whose whole point is gated files, is reporting on nothing.
  if (scannedFiles === 0) problems.push('no test files were scanned at all.')
  if (scannedGates === 0) {
    problems.push(
      'no RUN_DB_* gate was found in any scanned directory. Either every gated suite was deleted, or '
      + 'this guard has stopped finding them.',
    )
  }

  if (problems.length > 0) {
    console.error('DB test-gate census FAILED:\n')
    for (const problem of problems) console.error(`  - ${problem}`)
    console.error('')
    process.exit(1)
  }
  console.log(
    `DB test-gate census OK: ${scannedGates} gate(s) across ${scannedFiles} file(s) in `
    + `${SUITES.map((s) => s.dir).join(', ')}, each set with its REQUIRE_ counterpart by its script.`,
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    // A guard that cannot complete has not passed. Everything above throws only where it would
    // otherwise have to guess, so this path is a failure and is reported as one.
    console.error(`DB test-gate census FAILED: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
