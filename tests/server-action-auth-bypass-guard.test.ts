import assert from 'node:assert/strict'
import test from 'node:test'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import { runGuard } from '../scripts/check-server-action-auth-bypass.mjs'

/**
 * The guard is a security control, so it needs its own tests: a version that
 * silently misses a bypass is worse than not having one. The first cut was
 * regex-based and missed imported types, utility types, generics, inferred
 * defaults, long prologues and per-function directives — every one of which
 * can recreate the original forgeable `skipPermissionCheck` while CI reports
 * success. (o3d-43oz)
 */

const FIXTURES = 'tests/fixtures/server-action-auth-bypass'
const violations: string[] = runGuard({ scanRoots: [FIXTURES] })

function flagged(file: string): boolean {
  return violations.some((v) => v.includes(`${FIXTURES}/${file}`))
}

test('every bad fixture is flagged', () => {
  const bad = readdirSync(join(process.cwd(), FIXTURES, 'bad')).filter((f) => f.endsWith('.ts'))
  assert.ok(bad.length >= 8, `expected the bad fixtures to still be present, found ${bad.length}`)
  for (const f of bad) {
    assert.ok(flagged(`bad/${f}`), `guard MISSED bad/${f} — a forgeable auth bypass would ship:\n${violations.join('\n')}`)
  }
})

test('no good fixture is flagged', () => {
  const good = readdirSync(join(process.cwd(), FIXTURES, 'good')).filter((f) => f.endsWith('.ts'))
  assert.ok(good.length >= 6, `expected the good fixtures to still be present, found ${good.length}`)
  for (const f of good) {
    assert.equal(flagged(`good/${f}`), false, `guard FALSE-POSITIVED on good/${f}:\n${violations.join('\n')}`)
  }
})

test('an imported options type is resolved across module boundaries', () => {
  // The specific gap in the syntax-only version.
  assert.ok(flagged('bad/imported-type.ts'))
  assert.ok(flagged('bad/utility-type.ts'))
})

test('a private helper in a use-server module is not treated as an action', () => {
  // Only exported bindings are reachable over RPC; failing CI on a private
  // helper would just teach people to add waivers.
  assert.equal(flagged('good/private-helper.ts'), false)
})

test('a symbol capability is never flagged', () => {
  assert.equal(flagged('good/symbol-capability.ts'), false)
})

test('the production tree is clean', () => {
  assert.deepEqual(runGuard(), [])
})
