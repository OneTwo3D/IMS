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
 * `npm run` composite (`check:server-action-guards`, `check:all`) counts as ITSELF ONLY: its members are
 * not credited (a leading member failing short-circuits the rest), so each leaf needs its own direct job
 * or an allowlist reason.
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
  'check:server-action-guards': 'Aggregate (&&-chained) of the three server-action halves, kept for local use. CI runs each half '
    + 'in its own independent job (server-action-auth-guard.yml) so a failing half cannot hide the others.',
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

/**
 * AUDITABLE DIRECT INVOCATIONS ONLY. A line counts only if the WHOLE line is `npm run <script>` (no flags,
 * no `-- args`) and it is the ONLY line of its `run:` block. Composites do NOT expand: a script
 * counts as itself only, so every leaf needs its own direct invocation or an allowlist reason. So `echo 'npm run x'`, a `# comment`, quoted text, `npm run x || true`,
 * `npm run x; y`, `a && npm run x`, `if cond; then npm run x` and a line continued with a backslash are NOT
 * invocations. A block that turns errexit off (`set +e`, `set +o errexit`) or traps cannot be trusted to
 * propagate failure, so none of its lines count.
 */
const DIRECT_RE = /^npm run (check:[A-Za-z0-9:_-]+)$/
const MASKING_RE = /(^|[\s;&|])(set\s+\+e|set\s+\+o\s+errexit|trap\s)/
export function directInvocations(body: string): string[] {
  // EXACTLY ONE LINE, nothing else in the block: an `exit 0` or any other line before it can never hide it.
  const trimmed = body.trim()
  if (trimmed.includes('\n') || MASKING_RE.test(trimmed)) return []
  const m = DIRECT_RE.exec(trimmed)
  return m ? [m[1]] : []
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
  const dflt = (doc.defaults as Json | undefined)?.run
  if (dflt !== undefined) return 'workflow sets defaults.run'
  const pr = (on as Json).pull_request as Json | null
  if (pr && typeof pr === 'object') {
    if ('branches-ignore' in pr) return 'pull_request has branches-ignore'
    if ('branches' in pr) {
      const b = pr.branches as string[]
      if (!Array.isArray(b) || b.some((x) => typeof x !== 'string' || x.startsWith('!'))
        || !b.some((x) => x === 'development' || x === '**' || x === '*')) {
        return 'pull_request branches do not include development'
      }
    }
    if ('types' in pr) {
      const t = pr.types as string[]
      if (!Array.isArray(t) || !['opened', 'synchronize', 'reopened'].every((x) => t.includes(x))) {
        return 'pull_request types exclude opened/synchronize/reopened'
      }
    }
  }
  return null
}
export function ungatedInvocations(doc: Json, scripts: Record<string, string>): Set<string> {
  const out = new Set<string>()
  if (skippability(doc)) return out
  for (const job of Object.values((doc.jobs ?? {}) as Record<string, Json>)) {
    if (job.if !== undefined || job.needs !== undefined || job['continue-on-error'] !== undefined) continue
    if ((job.defaults as Json | undefined)?.run !== undefined || job.strategy !== undefined) continue
    for (const step of (job.steps ?? []) as Json[]) {
      if (step.if !== undefined || step['continue-on-error'] !== undefined) continue
      if (typeof step.run !== 'string') continue
      if (step.shell !== undefined || step['working-directory'] !== undefined) continue
      for (const n of directInvocations(step.run)) out.add(n)
    }
  }
  return out
}
export function localInvocations(sh: string, _scripts: Record<string, string> = {}): Set<string> {
  const out = new Set<string>()
  for (const line of sh.split('\n')) {
    const m = /^run_step\s+'[^']*'\s+npm run (?:-s )?(check:[A-Za-z0-9:_-]+)$/.exec(line)
    if (m) out.add(m[1])
  }
  return out
}

/** Ungated jobs that run more than one check:* script DIRECTLY: a failing one would hide the rest. */
export function jobsHidingFailures(doc: Json): string[] {
  const bad: string[] = []
  if (skippability(doc)) return bad
  for (const [id, job] of Object.entries((doc.jobs ?? {}) as Record<string, Json>)) {
    const n = ((job.steps ?? []) as Json[])
      .flatMap((st) => (typeof st.run === 'string' ? directInvocations(st.run) : []))
      .filter((x) => x.startsWith('check:')).length
    if (n > 1) bad.push(`${id} runs ${n} check:* scripts in one job`)
  }
  return bad
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
  for (const leaf of ['check:server-action-auth-bypass', 'check:server-action-guard-coverage', 'check:server-action-authorization']) {
    assert.ok(ci.has(leaf), `${leaf} must have its own direct ungated job`)
  }
  assert.ok(!ci.has('check:server-action-guards'), 'the && composite is no longer run in CI (it would hide later halves)')
  assert.ok(!ci.has('check:all'), 'check:all is named only in comments, and must not count as invoked')
  console.log(`# ci-guard-coverage examined ${CHECKS.length} check:* scripts across ${workflowFiles.length} workflows; `
    + `${ci.size} npm scripts run ungated in CI, ${local.size} by validate-local.sh`)
})

test('every check:* script runs in an ungated workflow and in validate-local.sh, or is allowlisted with a reason', () => {
  const { ci, local } = coverage()
  assert.deepEqual(findings(CHECKS, ci, local), [])
})

test('no ungated job runs two check:* guards: GitHub skips later steps after a failure, so one red guard would hide the rest', () => {
  const { docs } = coverage()
  const all = docs.flatMap((d) => jobsHidingFailures(d))
  const guardJobs = docs.flatMap((d) => (skippability(d) ? [] : Object.keys((d.jobs ?? {}) as Json)))
  console.log(`# job-independence examined ${guardJobs.length} jobs in ungated workflows`)
  assert.ok(guardJobs.length >= 9, `expected at least 9 jobs in ungated workflows, found ${guardJobs.length}`)
  assert.deepEqual(all, [])
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

test('detector: an ungated workflow counts; a composite counts as ITSELF only (short-circuit safe)', () => {
  assert.deepEqual([...ungatedInvocations(wf(), S)], ['check:foo'])
  assert.deepEqual([...ungatedInvocations(wf({}, {}, {}, 'npm run check:comp'), S)], ['check:comp'])
})
test('detector: exit-before, custom shell, defaults.run and negated branch patterns do not count', () => {
  assert.equal(ungatedInvocations(wf({}, {}, {}, 'exit 0\nnpm run check:foo'), S).size, 0)
  assert.equal(ungatedInvocations(wf({}, {}, { shell: 'bash {0}' }), S).size, 0)
  assert.equal(ungatedInvocations(wf({ defaults: { run: { shell: 'bash {0}' } } }), S).size, 0)
  assert.equal(ungatedInvocations(wf({}, { defaults: { run: { shell: 'sh' } } }), S).size, 0)
  assert.equal(ungatedInvocations(wf({}, { strategy: { matrix: {} } }), S).size, 0, 'a job with a strategy/matrix does not count')
  const neg = wf({ on: { pull_request: { branches: ['development', '!development'] } } })
  assert.match(String(skippability(neg)), /branches/)
  assert.equal(ungatedInvocations(neg, S).size, 0)
  assert.equal(skippability(wf({ on: { pull_request: { branches: ['**', '!release/*'] } } })) === null, false)
  assert.equal(skippability(wf({ on: { pull_request: { branches: ['**'] } } })), null)
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

test('detector: only whole-line direct invocations count (echo, comment, quoted, conditional, masked, continued)', () => {
  assert.deepEqual(directInvocations('npm run check:foo'), ['check:foo'])
  assert.deepEqual(directInvocations('npm run -s check:foo'), [], 'flags are not credited')
  assert.deepEqual(directInvocations('npm run check:foo -- --x'), [], 'args are not credited')
  assert.deepEqual(directInvocations('npm ci\nnpm run check:foo'), [], 'a multi-line block counts nothing')
  assert.deepEqual(directInvocations('exit 0\nnpm run check:foo'), [])
  assert.deepEqual(directInvocations('npm run build'), [], 'only check:* scripts')
  for (const bad of [
    "echo 'npm run check:foo'", '# npm run check:foo', 'echo "x" # npm run check:foo', "'npm run check:foo'",
    'npm run check:foo || true', 'npm run check:foo; true', 'npm run check:foo | tee x', 'npm run check:foo &',
    'true && npm run check:foo', 'if [ -n "$X" ]; then npm run check:foo; fi', '[ -n "$X" ] && npm run check:foo',
    'npm run check:foo \\\n|| true', 'set +e\nnpm run check:foo',
    'set +o errexit\nnpm run check:foo', 'trap true ERR\nnpm run check:foo',
  ]) {
    const got = directInvocations(bad)
    assert.deepEqual(got, [], `must not count: ${JSON.stringify(bad)}`)
  }
  assert.equal(localInvocations("run_step 'x' npm run check:foo || true\n", S).size, 0)
  assert.equal(localInvocations("run_step 'x' echo npm run check:foo\n", S).size, 0)
})
test('detector: a pull_request trigger that excludes development PRs is skippable', () => {
  const t = (pr: Json) => skippability(wf({ on: { pull_request: pr } }))
  assert.equal(t({ branches: ['development'] }), null)
  assert.equal(t({}), null)
  assert.match(String(t({ branches: ['main'] })), /branches do not include development/)
  assert.match(String(t({ 'branches-ignore': ['development'] })), /branches-ignore/)
  assert.match(String(t({ types: ['closed'] })), /types exclude/)
  assert.equal(t({ types: ['opened', 'synchronize', 'reopened', 'labeled'] }), null)
})
test('detector: two guards in one job are flagged, two in separate jobs are not', () => {
  const two = wf({}, {}, {}, 'npm run check:foo\nnpm run check:bar')
  assert.equal(jobsHidingFailures(two).length, 0, 'a multi-line block counts nothing, so it cannot be coverage either')
  assert.equal(ungatedInvocations(two, S).size, 0)
  const sep = wf()
  ;(sep.jobs as Json).k = { steps: [{ run: 'npm run check:bar' }] }
  assert.deepEqual(jobsHidingFailures(sep), [])
  const twoSteps = wf()
  ;((twoSteps.jobs as Json).j as Json).steps = [{ run: 'npm run check:foo' }, { run: 'npm run check:bar' }]
  assert.equal(jobsHidingFailures(twoSteps).length, 1)
})
