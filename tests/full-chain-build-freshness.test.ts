import assert from 'node:assert/strict'
import test from 'node:test'

import { evaluateBuildFreshness, type BuildFacts } from '@/e2e/full-chain/harness/build-freshness'

/**
 * The full-chain rig serves a PRODUCTION build, so a run can test code that is not in the
 * working tree — and pass, convincingly (o3d-0qk). These pin the two ways that happens and,
 * just as importantly, the cases that must NOT be flagged: a guard that cries wolf gets
 * skipped, and then it is not a guard.
 */

const T = Date.parse('2026-07-16T12:00:00Z')
const s = (n: number) => n * 1000

function facts(over: Partial<BuildFacts> = {}): BuildFacts {
  return {
    newestSourceMs: T - s(60), // source last touched a minute before the build
    newestSourcePath: 'lib/connectors/xero/api.ts',
    buildMs: T,
    serverStartMs: T + s(5), // restarted just after the build
    ...over,
  }
}

test('build freshness: a built-then-restarted server is accepted', () => {
  assert.deepEqual(evaluateBuildFreshness(facts()), { problems: [], warnings: [] })
})

test('build freshness: source newer than the build is a STALE BUILD', () => {
  // The reported case: branch changes, nobody rebuilds, the suite tests the old bundle.
  const r = evaluateBuildFreshness(facts({ newestSourceMs: T + s(90) }))
  assert.equal(r.problems.length, 1)
  assert.match(r.problems[0], /STALE BUILD/)
  assert.match(r.problems[0], /lib\/connectors\/xero\/api\.ts/, 'name the file, so the report is actionable')
  assert.match(r.problems[0], /npm run build/)
})

test('build freshness: a server started before the build must be restarted', () => {
  // `npm run start` serves what it loaded at boot, so a rebuild alone changes nothing.
  const r = evaluateBuildFreshness(facts({ serverStartMs: T - s(30) }))
  assert.equal(r.problems.length, 1)
  assert.match(r.problems[0], /SERVER PREDATES THE BUILD/)
  assert.match(r.problems[0], /systemctl restart/)
})

test('build freshness: catches both at once, and says so separately', () => {
  const r = evaluateBuildFreshness(facts({ newestSourceMs: T + s(90), serverStartMs: T - s(30) }))
  assert.equal(r.problems.length, 2, 'two independent faults must not mask each other')
})

test('build freshness: a missing build is a problem, and short-circuits', () => {
  const r = evaluateBuildFreshness(facts({ buildMs: null }))
  assert.equal(r.problems.length, 1)
  assert.match(r.problems[0], /No production build/)
  // With no build there is nothing to compare against; further complaints would be noise.
})

test('build freshness: sub-second restart after a build is NOT flagged', () => {
  // systemd reports whole seconds while stat gives sub-second precision, so an honest
  // "build finished 12:00:00.850, restarted 12:00:00.900" arrives as 850ms vs 000ms and
  // would read as the server predating its own build. That false positive would fire on
  // every fast restart.
  const buildMs = Date.parse('2026-07-16T12:00:00.850Z')
  const serverStartMs = Date.parse('2026-07-16T12:00:00.000Z') // systemd truncated
  const r = evaluateBuildFreshness(facts({ buildMs, serverStartMs, newestSourceMs: buildMs - s(60) }))
  assert.deepEqual(r.problems, [], 'same-second restart is legitimate')
})

test('build freshness: undeterminable facts WARN rather than pass silently', () => {
  // No systemd (or no git) means the check could not RUN. That is not the same as passing,
  // and must not be reported as if it were.
  const r = evaluateBuildFreshness(facts({ serverStartMs: null, newestSourceMs: null, newestSourcePath: null }))
  assert.deepEqual(r.problems, [], 'inability to check is not proof of staleness — do not fail the run')
  assert.equal(r.warnings.length, 2)
  assert.ok(r.warnings.every((w) => /NOT checked/.test(w)), 'the warning must say the check did not run')
})
