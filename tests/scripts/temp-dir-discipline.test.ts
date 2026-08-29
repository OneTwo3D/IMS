/**
 * NO HARNESS IN `tests/scripts/` MAY MAKE ITS OWN THROWAWAY DIRECTORY (o3d-tmpleak).
 *
 * The leak this closes was not a bug in any one harness. It was that each harness got to decide
 * for itself whether to clean up, and nothing failed when one decided not to — so the answer
 * drifted, three files ended up with no cleanup at all, and ~18,000 directories accumulated under
 * /tmp over six days. Fixing the three files does not fix that; the NEXT harness gets the same
 * free choice. This is what removes the choice.
 *
 * The rule is deliberately about the CALL, not about whether a `rm` appears somewhere nearby: a
 * proximity rule ("an rmSync within N lines") passes vacuously the moment the cleanup is moved to
 * a `finally` further down, or registered on a variable the check cannot follow. `mkdtemp` may
 * appear in exactly one file, and that file registers the removal itself.
 *
 * WHY IT IS NOT VACUOUS, asserted rather than asserted-about:
 *   • the walk is required to reach a plausible number of files, and to have reached the seven
 *     harnesses that historically made directories — a walk that silently found nothing (wrong
 *     cwd, renamed directory, changed extension) fails instead of passing;
 *   • the pattern is required to still match the helper's own `mkdtemp` calls, so a regex that has
 *     stopped matching anything cannot report a clean sweep;
 *   • the routing is required to be visible — several files must import the helper — so gutting
 *     `temp-dir.ts` and reverting every caller to inline `fs.mkdtemp` fails here too.
 *
 * MUTATION ROUTES (each measured by making the change and re-running):
 *   1. put `const d = mkdtempSync(join(tmpdir(), 'x-'))` back into any harness here: the
 *      "comes from the shared helper" test fails and names the file.
 *   2. delete the helper's exclusion (scan it like any other file): the same test fails on
 *      temp-dir.ts, proving the exclusion is what carries it and not an empty match.
 *   3. break the pattern (match `mkdtempNever`): the "pattern still matches" test fails.
 *   4. point the walk at a directory that does not exist, or empty the required-file list: the
 *      "reaches every harness" test fails.
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

/** Relative to the repository root, which is where the test runner is invoked. */
const SCRIPTS_DIR = 'tests/scripts'

/** The one file allowed to call mkdtemp, because it is the one that registers the removal. */
const HELPER = 'temp-dir.ts'

/**
 * This file, which necessarily contains the token it looks for. The exemption is not a loophole a
 * harness can use — it names the guard and the helper and nothing else, and both are the mechanism
 * rather than users of it. What keeps it honest is the "pattern still matches" test below: if this
 * file's pattern ever stops matching a real call, that fails rather than reporting a clean sweep.
 */
const SELF = 'temp-dir-discipline.test.ts'

/** Read by the sweep only; every other file in the directory is scanned. */
const MECHANISM = new Set([HELPER, SELF])

/**
 * Any `mkdtemp` / `mkdtempSync` call or import. Written as a word match so that the import line
 * counts too: a file that imports it and has not called it yet is a file about to.
 */
const MKDTEMP = /\bmkdtemp(?:Sync)?\b/

/**
 * The harnesses that have historically made throwaway directories. Naming them, rather than
 * counting, is what makes a walk that reached the wrong directory fail loudly: a renamed or moved
 * file must be dealt with here deliberately.
 */
const KNOWN_HARNESSES = [
  'connector-fetch-boundaries.test.ts',
  'documented-env-vars.test.ts',
  'domain-decimal-boundaries.test.ts',
  'install-redis-url.test.ts',
  'install-rerun-preserves-credentials.test.ts',
  'preflight-production.test.ts',
  'prisma-schema-scope.test.ts',
]

interface Source {
  readonly name: string
  readonly text: string
}

function sources(dir = SCRIPTS_DIR, prefix = ''): Source[] {
  const found: Source[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      found.push(...sources(join(dir, entry.name), name))
    } else if (entry.name.endsWith('.ts')) {
      found.push({ name, text: readFileSync(join(dir, entry.name), 'utf8') })
    }
  }
  return found
}

test('the scan reaches every harness in tests/scripts/', () => {
  const found = sources()

  // A count, so that a walk which found one file and called it a clean sweep fails. The directory
  // held 15 .ts files when this was written; the floor is well below that so ordinary deletions do
  // not trip it, and well above zero so a mislocated walk does.
  assert.ok(
    found.length >= 10,
    `expected the walk to reach at least 10 TypeScript files under ${SCRIPTS_DIR}, saw ${found.length}`,
  )

  const names = new Set(found.map((source) => source.name))
  const missing = KNOWN_HARNESSES.filter((name) => !names.has(name))
  assert.deepEqual(
    missing,
    [],
    'these harnesses were not reached by the walk — if one was renamed or removed, update ' +
      'KNOWN_HARNESSES deliberately rather than letting the guard quietly stop covering it',
  )

  for (const name of MECHANISM) {
    assert.ok(names.has(name), `${name} must be present for its exclusion to mean anything`)
  }
})

test('the pattern still matches a real mkdtemp call', () => {
  // If this fails, every other assertion in this file is measuring nothing.
  const helper = sources().find((source) => source.name === HELPER)
  assert.ok(helper !== undefined, `${HELPER} is missing`)
  assert.match(
    helper.text,
    MKDTEMP,
    `${HELPER} no longer calls mkdtemp — either the pattern is broken or the helper has been ` +
      'gutted, and in both cases the sweep below would report clean for the wrong reason',
  )
})

test('the harnesses are visibly routed through the helper', () => {
  // The sweep below is satisfied by a directory with no temporary directories in it at all. This
  // is what says the harnesses still make them, and get them from the one place that cleans up.
  const routed = sources()
    .filter((source) => !MECHANISM.has(source.name))
    .filter((source) => /\bcreateTempDir(?:Sync)?\b|\bwithTempDir\b/.test(source.text))
    .map((source) => source.name)
    .sort()

  assert.ok(
    routed.length >= 6,
    `expected at least 6 harnesses to obtain directories from ${HELPER}, saw ${routed.length}: ${routed.join(', ')}`,
  )

  const unrouted = KNOWN_HARNESSES.filter((name) => !routed.includes(name))
  assert.deepEqual(unrouted, [], 'these harnesses no longer get their throwaway directories from the helper')
})

test('every throwaway directory in tests/scripts/ comes from the shared helper', () => {
  const offenders = sources()
    .filter((source) => !MECHANISM.has(source.name))
    .filter((source) => MKDTEMP.test(source.text))
    .map((source) => source.name)
    .sort()

  assert.deepEqual(
    offenders,
    [],
    `these files call mkdtemp directly instead of ${SCRIPTS_DIR}/${HELPER}. Creation and removal ` +
      'are one call there on purpose: use createTempDir / createTempDirSync (pass the TestContext ' +
      'where there is one) or withTempDir, so the directory cannot outlive the run.',
  )
})
