import assert from 'node:assert/strict'
import test from 'node:test'

import { checkBuildFreshness, evaluateBuildFreshness, type BuildFacts } from '@/e2e/full-chain/harness/build-freshness'

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

test('build freshness: undeterminable facts FAIL — the guard must not fail open', () => {
  // Both blind spots are exactly the states in which a stale build sails through, so warning
  // and carrying on would make this a guard that fails open (Codex review, #489). The caller
  // has already established the server IS this box's unit, so unreadable facts are anomalous.
  const r = evaluateBuildFreshness(facts({ serverStartMs: null, newestSourceMs: null, newestSourcePath: null }))
  assert.equal(r.problems.length, 2, 'each blind spot must block on its own')
  assert.ok(r.problems.every((p) => /could NOT be checked|NOT be checked/i.test(p)))
  assert.ok(r.problems.some((p) => /FULL_CHAIN_SKIP_FRESHNESS/.test(p)), 'and must name the deliberate override')
})


test('build freshness: skips (loudly) when the tests point at a server this box does not run', async (t) => {
  // Everything the check reads is local — the filesystem and the local systemd unit — while
  // Playwright aims at E2E_BASE_URL. Pointed elsewhere it would vouch for a server it has
  // never seen, so it must decline and SAY so rather than quietly pass (Codex review, #489).
  const prev = process.env.E2E_BASE_URL
  process.env.E2E_BASE_URL = 'https://someone-elses-box.example'
  t.after(() => { if (prev === undefined) delete process.env.E2E_BASE_URL; else process.env.E2E_BASE_URL = prev })

  const r = checkBuildFreshness('/nonexistent-tree')
  assert.deepEqual(r.problems, [], 'must not block a run it cannot judge')
  assert.equal(r.warnings.length, 1)
  assert.match(r.warnings[0], /NOT run/, 'the warning must admit the check did not run')
  assert.match(r.warnings[0], /someone-elses-box/, 'and name the server it declined to judge')
})
