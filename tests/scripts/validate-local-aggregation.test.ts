/**
 * A LINT ERROR MAY NOT HIDE A FAILING TEST (o3d-amy8)
 *
 * scripts/validate-local.sh ran under `set -euo pipefail` with `npm run lint` first and
 * `npm run test:unit` eighth. A lint error therefore aborted it before the type check, three
 * boundary guards, the migration-convention check, the Server Action authorization guards, the
 * unit suite, the workflow-doc check and the schema-scope check had run — and `development`
 * carried a lint error for long enough that the CI job running this script executed exactly one of
 * its steps on every pull request, silently, for days.
 *
 * THE PROPERTY, AND HOW IT IS MEASURED. Not "the script contains no `set -e`" — that is a claim
 * about the text. The script is RUN, with a `npm` on PATH that fails `lint` and fails `test:unit`
 * and records every invocation it is given, and the assertion is that `test:unit` was invoked, was
 * reported FAILED, and that the summary accounts for every step.
 *
 * AND THE SAME MEASUREMENT IS MADE OF THE DEFECT. The last test derives the pre-fix shape from the
 * shipped text — errexit back on, and the step dispatch no longer swallowing the status — and runs
 * it under the identical shims. It must NOT reach `test:unit`. Without that half, a harness whose
 * `npm` shim was never reached at all would pass every assertion above it.
 *
 * NOTHING REAL RUNS. `npm` and `npx` are the only two commands the script invokes, and both are
 * shimmed; PATH is rebuilt so no real npm is reachable from inside it.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import { createTempDirSync } from './temp-dir.ts'

const REPO = process.cwd()
const SCRIPT_PATH = join(REPO, 'scripts/validate-local.sh')
const SCRIPT = readFileSync(SCRIPT_PATH, 'utf8')

type Harness = { path: string, log: string, run: (script?: string) => { status: number, output: string } }

/**
 * A PATH holding nothing but the two commands the script calls and the system tools bash needs.
 * `failing` names the npm sub-commands that exit non-zero; everything else is recorded and passes.
 */
function harness(t: TestContext, failing: string[]): Harness {
  const dir = createTempDirSync('ims-amy8-', t)
  const log = join(dir, 'invocations.log')
  const fail = failing.map((f) => `    ${f}) exit 1 ;;`).join('\n')
  writeFileSync(join(dir, 'npm'), [
    '#!/usr/bin/env bash',
    `printf 'npm %s\\n' "$*" >> ${JSON.stringify(log)}`,
    'if [[ "$1" == "run" ]]; then',
    '  case "$2" in',
    fail,
    '  esac',
    'fi',
    'exit 0',
  ].join('\n'))
  writeFileSync(join(dir, 'npx'), [
    '#!/usr/bin/env bash',
    `printf 'npx %s\\n' "$*" >> ${JSON.stringify(log)}`,
    failing.includes('prisma') ? 'exit 1' : 'exit 0',
  ].join('\n'))
  chmodSync(join(dir, 'npm'), 0o755)
  chmodSync(join(dir, 'npx'), 0o755)

  return {
    path: dir,
    log,
    run(script = SCRIPT_PATH) {
      try {
        const output = execFileSync('bash', [script], {
          cwd: REPO,
          encoding: 'utf8',
          env: { ...process.env, PATH: `${dir}:/usr/bin:/bin` },
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        return { status: 0, output }
      } catch (error) {
        const e = error as { status?: number, stdout?: string, stderr?: string }
        return { status: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }
      }
    },
  }
}

const invocations = (h: Harness): string[] =>
  (existsSync(h.log) ? readFileSync(h.log, 'utf8') : '').split('\n').filter(Boolean)

test('[o3d-amy8] a lint error does not conceal a failing test', (t) => {
  const h = harness(t, ['lint', 'test:unit'])
  const { status, output } = h.run()

  const ran = invocations(h)
  // THE LOAD-BEARING ASSERTION. Under the old script this line is where it stops: `npm run lint`
  // is the only entry in the log.
  assert.ok(ran.includes('npm run test:unit'),
    `the unit suite must run even though lint failed; the script only reached: ${ran.join(', ')}`)
  assert.match(output, /FAIL {2}unit tests/, 'and its failure must be REPORTED, not merely reached')
  assert.match(output, /FAIL {2}lint/, 'alongside the lint failure')
  assert.equal(status, 1, 'and the script must still fail')

  // A red job must be readable as "these gates failed and the rest ran", which is the thing the
  // old output could not say.
  assert.match(output, /2 of 10 steps failed; all 10 ran\./)
})

test('[o3d-amy8] every gate downstream of a lint error still runs and is accounted for', (t) => {
  const h = harness(t, ['lint'])
  const { status, output } = h.run()
  const ran = invocations(h)

  for (const expected of [
    'npx prisma generate --schema prisma/schema.prisma',
    'npm run lint',
    'npm run type-check',
    'npm run check:decimal-boundaries',
    'npm run check:connector-fetch-boundaries',
    'npm run check:migration-conventions',
    'npm run check:server-action-guards',
    'npm run test:unit',
    'npm run docs:workflows:check',
  ]) {
    assert.ok(ran.includes(expected), `${expected} must run; the log holds: ${ran.join(', ')}`)
  }
  assert.ok(ran.some((l) => l.startsWith('npm run db:schema:scope --')),
    `the schema-scope check must run with its two refs: ${ran.join(', ')}`)

  assert.equal(status, 1, 'one failing gate still fails the run')
  assert.match(output, /1 of 10 steps failed; all 10 ran\./)
  // NOT VACUOUS: the summary distinguishes, rather than printing FAIL for everything.
  assert.match(output, /PASS {2}unit tests/)
  assert.match(output, /FAIL {2}lint/)
})

test('[o3d-amy8] a clean run passes and says so', (t) => {
  const h = harness(t, [])
  const { status, output } = h.run()

  assert.equal(status, 0, output)
  assert.match(output, /0 of 10 steps failed; all 10 ran\./)
  assert.ok(!/FAIL {2}/.test(output), output)
})

test('[o3d-amy8] prisma generate runs before the two steps that import what it writes', (t) => {
  const h = harness(t, [])
  h.run()
  const ran = invocations(h)

  const generate = ran.indexOf('npx prisma generate --schema prisma/schema.prisma')
  assert.notEqual(generate, -1)
  // It used to run SIXTH, after the type check that needs the client it produces.
  assert.ok(generate < ran.indexOf('npm run type-check'), `generate must precede type-check: ${ran.join(', ')}`)
  assert.ok(generate < ran.indexOf('npm run test:unit'), `and the unit suite: ${ran.join(', ')}`)
})

test('[o3d-amy8] a failed prisma generate is named as the likely cause of what follows it', (t) => {
  const h = harness(t, ['prisma', 'type-check', 'test:unit'])
  const { status, output } = h.run()

  assert.equal(status, 1)
  assert.match(output, /NOTE: `prisma generate` failed/,
    'the one real ordering dependency in this sequence must be called out, since fail-fast no longer implies it')
  assert.match(output, /3 of 10 steps failed; all 10 ran\./)
})

/**
 * THE MUTATION, RUN RATHER THAN ARGUED. Two anchored edits to the shipped text put back exactly the
 * shape the issue is about: errexit on, and `run_step` no longer running its command inside an `if`
 * condition (which is where bash suspends errexit). Everything else — the step list, the ordering,
 * the summary — is unchanged, so what this measures is the failure semantics and nothing else.
 */
test('[o3d-amy8] MUTATION: with the pre-fix failure semantics, the unit suite is never reached', (t) => {
  const dir = createTempDirSync('ims-amy8-mutant-', t)
  const mutantPath = join(dir, 'validate-local.mutant.sh')

  const before = 'set -uo pipefail'
  assert.ok(SCRIPT.includes(before), 'scripts/validate-local.sh must not restore errexit')
  const dispatch = '  if "$@"; then'
  assert.ok(SCRIPT.includes(dispatch), 'run_step must keep running its command in an `if` condition')

  const mutant = SCRIPT
    .replace(before, 'set -euo pipefail')
    .replace(dispatch, '  "$@"\n  if true; then')
  assert.notEqual(mutant, SCRIPT, 'the mutation must have applied')
  writeFileSync(mutantPath, mutant)
  chmodSync(mutantPath, 0o755)

  const h = harness(t, ['lint', 'test:unit'])
  const { status, output } = h.run(mutantPath)
  const ran = invocations(h)

  assert.equal(status, 1)
  assert.ok(!ran.includes('npm run test:unit'),
    `the pre-fix shape must stop at the lint error — that is the defect, and if the mutant still reached the unit suite the tests above would be measuring nothing: ${ran.join(', ')}`)
  assert.ok(!/validate-local summary/.test(output),
    'and it must never print a summary, which is why nobody was told nine gates had not run')
})
