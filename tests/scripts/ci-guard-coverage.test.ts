/**
 * EVERY `check:*` GUARD RUNS SOMEWHERE THAT CANNOT BE SKIPPED (o3d-ok6hk)
 *
 * A guard that never runs is the same defect as a guard that cannot fail. `check:all` was the only
 * thing that ran `check:documented-env-vars`, `check:wc-sync-row-predicates` and
 * `check:fulfillment-requirement-seam`, and nothing invoked `check:all` — the two places that name it
 * are comments, which is precisely how it LOOKED covered. This file measures the property directly:
 *
 *   1. every `check:*` script in package.json is run by at least one workflow that is UNGATED — a
 *      parsed `pull_request` trigger with no `paths`/`paths-ignore`, no `needs`, no job `if`, no step
 *      `if`, no `continue-on-error` — or is on ALLOWLIST below with a stated reason; and
 *   2. every one of them is also a step of scripts/validate-local.sh (the local mirror), or is on
 *      LOCAL_ALLOWLIST with a stated reason.
 *
 * Workflows are PARSED (js-yaml), and only `run:` bodies of real steps count, so a script named in a
 * comment is not invoked. validate-local.sh is read line by line with comment lines dropped. An
 * `npm run` composite (`check:server-action-guards`, `check:all`) expands to its members, because
 * running the composite runs them.
 *
 * Why (2) is stricter than "ungated workflow OR validate-local": validate-local.sh runs only in the
 * classifier-gated `validate` job, so counting it as coverage would let a guard regress to exactly the
 * state that was the bug. It is required in addition, as the local mirror.
 *
 * js-yaml is a transitive dev dependency (present after `npm ci`), not a declared one; the
 * PRECONDITION below fails loudly rather than silently if it goes away.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import test from 'node:test'

const REPO = process.cwd()
const require = createRequire(import.meta.url)

/** Scripts deliberately outside the "ungated workflow" rule. One reason each; an empty reason is red. */
export const ALLOWLIST: Record<string, string> = {
  'check:all': 'Aggregate convenience alias. Its members are each covered individually (asserted below); '
    + 'invoking the alias itself in CI would only duplicate them.',
  'check:bom-recipes': 'A DATABASE DATA check (reads recipe rows), not a static guard over the tree. '
    + 'There is no database in a static-guard job, and no workflow here has one wired for it.',
}
/** Scripts deliberately absent from validate-local.sh. */
export const LOCAL_ALLOWLIST: Record<string, string> = {
  'check:all': 'Aggregate alias; validate-local.sh runs its members as separate, individually reported steps.',
  'check:bom-recipes': 'A DATABASE DATA check; validate-local.sh is database-free by design.',
  'check:server-action-auth-bypass': 'Run through its composite check:server-action-guards, which is the step.',
  'check:server-action-guard-coverage': 'Run through its composite check:server-action-guards, which is the step.',
  'check:server-action-authorization': 'Run through its composite check:server-action-guards, which is the step.',
}

type Json = Record<string, unknown>
const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
const SCRIPTS = pkg.scripts
const CHECKS = Object.keys(SCRIPTS).filter((n) => n.startsWith('check:'))

/** Every `npm run X` reachable from a shell line, expanding npm composites. */
export function expandNpmRuns(line: string, scripts: Record<string, string>, seen = new Set<string>()): Set<string> {
  for (const m of line.matchAll(/\bnpm\s+run\s+(?:-s\s+)?([A-Za-z0-9:_-]+)/g)) {
    const name = m[1]
    if (seen.has(name)) continue
    seen.add(name)
    if (scripts[name]) expandNpmRuns(scripts[name], scripts, seen)
  }
  return seen
}

const yaml = require('js-yaml') as { load: (s: string) => unknown }
const WF_DIR = join(REPO, '.github/workflows')
const workflowFiles = readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f))

/** Why a workflow is skippable, or null when it is not. Pure so the mutation arms can feed it docs. */
export function skippability(doc: Json): string | null {
  const on = (doc.on ?? (doc as Json)['true']) as Json | string | string[] | undefined
  if (!on || typeof on !== 'object' || Array.isArray(on) || !('pull_request' in on)) return 'no pull_request trigger'
  for (const [event, cfg] of Object.entries(on)) {
    if (cfg && typeof cfg === 'object' && ('paths' in cfg || 'paths-ignore' in cfg)) return `${event} has a path filter`
  }
  return null
}
export function ungatedInvocations(doc: Json, scripts: Record<string, string>): Set<string> {
  const out = new Set<string>()
  if (skippability(doc)) return out
  for (const job of Object.values((doc.jobs ?? {}) as Record<string, Json>)) {
    if (job.if !== undefined || job.needs !== undefined || job['continue-on-error'] !== undefined) continue
    for (const step of (job.steps ?? []) as Json[]) {
      if (step.if !== undefined || step['continue-on-error'] !== undefined) continue
      if (typeof step.run !== 'string') continue
      for (const n of expandNpmRuns(step.run, scripts)) out.add(n)
    }
  }
  return out
}
export function localInvocations(sh: string, scripts: Record<string, string>): Set<string> {
  const out = new Set<string>()
  for (const line of sh.split('\n')) {
    if (!/^run_step\s/.test(line)) continue
    for (const n of expandNpmRuns(line, scripts)) out.add(n)
  }
  return out
}

function coverage(scripts = SCRIPTS, workflows?: Json[], sh?: string) {
  const docs = workflows ?? workflowFiles.map((f) => yaml.load(readFileSync(join(WF_DIR, f), 'utf8')) as Json)
  const ci = new Set<string>()
  for (const d of docs) for (const n of ungatedInvocations(d, scripts)) ci.add(n)
  const local = localInvocations(sh ?? readFileSync(join(REPO, 'scripts/validate-local.sh'), 'utf8'), scripts)
  return { ci, local, docs }
}

function findings(checks: string[], ci: Set<string>, local: Set<string>, allow = ALLOWLIST, lallow = LOCAL_ALLOWLIST) {
  const bad: string[] = []
  for (const n of checks) {
    if (!ci.has(n)) {
      if (!allow[n]) bad.push(`${n}: run by NO ungated workflow and not on ALLOWLIST`)
      else if (allow[n].trim().length < 20) bad.push(`${n}: ALLOWLIST reason is missing or too short`)
    }
    if (!local.has(n)) {
      if (!lallow[n]) bad.push(`${n}: not a validate-local.sh step and not on LOCAL_ALLOWLIST`)
      else if (lallow[n].trim().length < 20) bad.push(`${n}: LOCAL_ALLOWLIST reason is missing or too short`)
    }
  }
  return bad
}

test('PRECONDITION: the workflows were found and parsed, and the check:* scripts were enumerated', () => {
  assert.ok(workflowFiles.length >= 8, `found only ${workflowFiles.length} workflow files in ${WF_DIR}`)
  const { docs, ci, local } = coverage()
  assert.equal(docs.length, workflowFiles.length)
  for (const d of docs) assert.ok(d && typeof d === 'object' && d.jobs, 'a workflow parsed to no `jobs`')
  assert.ok(CHECKS.length >= 10, `expected at least 10 check:* scripts, found ${CHECKS.length}`)
  assert.ok(ci.size > 0, 'no ungated workflow invoked any npm script: the parser is examining nothing')
  assert.ok(local.size > 0, 'validate-local.sh yielded no run_step invocations')
  // Known-good anchors, so a parser that returns a plausible-sized wrong answer still fails.
  assert.ok(ci.has('check:archive-sealed'), 'archive-seal.yml must be seen as ungated')
  assert.ok(ci.has('check:server-action-auth-bypass'), 'composite expansion must reach check:server-action-auth-bypass')
  assert.ok(!ci.has('check:all'), 'check:all is named only in comments, and must not count as invoked')
  console.log(`# ci-guard-coverage examined ${CHECKS.length} check:* scripts across ${workflowFiles.length} workflows; `
    + `${ci.size} npm scripts run ungated in CI, ${local.size} by validate-local.sh`)
})

test('every check:* script runs in an ungated workflow and in validate-local.sh, or is allowlisted with a reason', () => {
  const { ci, local } = coverage()
  assert.deepEqual(findings(CHECKS, ci, local), [])
})

test('every member of check:all is covered individually, so the alias allowlist hides nothing', () => {
  const members = [...expandNpmRuns(SCRIPTS['check:all'], SCRIPTS)].filter((n) => n !== 'check:all')
  assert.ok(members.length >= 9, `check:all expanded to only ${members.length} members`)
  const { ci } = coverage()
  assert.deepEqual(members.filter((n) => !ci.has(n) && !ALLOWLIST[n]), [])
})

test('allowlists name only scripts that exist (a stale entry is a hole nobody can see)', () => {
  for (const n of Object.keys(ALLOWLIST)) assert.ok(SCRIPTS[n], `ALLOWLIST names ${n}, which is not in package.json`)
  for (const n of Object.keys(LOCAL_ALLOWLIST)) assert.ok(SCRIPTS[n], `LOCAL_ALLOWLIST names ${n}, which is not in package.json`)
})

// ---- the detector is proven able to fail, against synthetic inputs of the shipped shapes ----------
const wf = (extra: Json = {}, jobExtra: Json = {}, stepExtra: Json = {}, run = 'npm run check:foo'): Json => ({
  on: { pull_request: { branches: ['development'] }, push: { branches: ['development'] } },
  jobs: { j: { 'runs-on': 'ubuntu-latest', ...jobExtra, steps: [{ run, ...stepExtra }] } },
  ...extra,
})
const S = { 'check:foo': 'node x.mjs', 'check:comp': 'npm run check:foo && npm run check:bar', 'check:bar': 'node y.mjs' }

test('detector: an ungated workflow counts, and a composite expands to its members', () => {
  assert.deepEqual([...ungatedInvocations(wf(), S)], ['check:foo'])
  assert.deepEqual([...ungatedInvocations(wf({}, {}, {}, 'npm run check:comp'), S)].sort(), ['check:bar', 'check:comp', 'check:foo'])
})
test('detector: every way of making a workflow skippable stops it counting', () => {
  const pf = wf({ on: { pull_request: { paths: ['app/**'] } } })
  const pi = wf({ on: { pull_request: { 'paths-ignore': ['**/*.md'] } } })
  const pushOnly = wf({ on: { push: { branches: ['development'] } } })
  for (const [name, d] of Object.entries({
    paths: pf, 'paths-ignore': pi, 'push only': pushOnly,
    'job if': wf({}, { if: "needs.x.outputs.y == 'true'" }), needs: wf({}, { needs: 'classify' }),
    'step if': wf({}, {}, { if: 'always()' }), 'job continue-on-error': wf({}, { 'continue-on-error': true }),
    'step continue-on-error': wf({}, {}, { 'continue-on-error': true }),
  })) assert.equal(ungatedInvocations(d, S).size, 0, `${name} must not count as ungated`)
})
test('detector: a script named only in a comment is not invoked', () => {
  const d = yaml.load('on:\n  pull_request:\njobs:\n  j:\n    steps:\n      # - run: npm run check:foo\n      - run: echo hi # npm run check:foo\n') as Json
  // The inline `# ...` is YAML comment text, dropped by the parser: nothing is invoked.
  assert.equal(ungatedInvocations(d, S).size, 0)
  assert.equal(localInvocations("# run_step 'x' npm run check:foo\n", S).size, 0)
  assert.equal(localInvocations("run_step 'x' npm run check:foo\n", S).size, 1)
})
test('detector: findings go red for an unrun guard, a new unrun check:zz, and a stripped allowlist reason', () => {
  const checks = ['check:foo', 'check:bar']
  assert.deepEqual(findings(checks, new Set(['check:foo', 'check:bar']), new Set(['check:foo', 'check:bar']), {}, {}), [])
  assert.equal(findings(checks, new Set(['check:foo']), new Set(['check:foo', 'check:bar']), {}, {}).length, 1)
  assert.equal(findings(['check:zz'], new Set(), new Set(), {}, {}).length, 2)
  assert.equal(findings(['check:zz'], new Set(), new Set(['check:zz']), { 'check:zz': '' }, {}).length, 1)
  assert.equal(findings(['check:zz'], new Set(), new Set(['check:zz']), { 'check:zz': 'a sufficiently long reason' }, {}).length, 0)
})
