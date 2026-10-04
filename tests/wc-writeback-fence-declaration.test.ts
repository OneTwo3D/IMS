import assert from 'node:assert/strict'
import test from 'node:test'

import {
  WC_WRITEBACK_ALLOWED_ORIGIN_ENV,
  evaluateWcWritebackFence,
  isWcWritebackMutation,
  readWcWritebackDeclaration,
} from '@/lib/connectors/woocommerce/writeback-fence'

/**
 * o3d-zvec.3 — the DECISION, in isolation from any HTTP.
 *
 * WHAT WOULD STILL PASS THESE TESTS: an implementation that decides correctly but is never called.
 * That is covered by tests/wc-writeback-fence.test.ts (drives the real writeback paths at a real
 * listener) and tests/wc-writeback-fence-coverage.test.ts (asserts there is no way around it).
 */

const STORE = 'https://stage.example.com'

test('ABSENT declaration refuses — the default state of every install, worktree, scratch db and restored backup', () => {
  for (const env of [{}, { [WC_WRITEBACK_ALLOWED_ORIGIN_ENV]: '' }, { [WC_WRITEBACK_ALLOWED_ORIGIN_ENV]: '   ' }]) {
    const declaration = readWcWritebackDeclaration(env)
    assert.equal(declaration.ok, false)
    assert.equal(declaration.ok === false && declaration.reason, 'absent')

    const verdict = evaluateWcWritebackFence(`${STORE}/wp-json/wc/v3/orders/1`, env)
    assert.equal(verdict.allowed, false)
    assert.equal(verdict.allowed === false && verdict.code, 'undeclared')
    assert.equal(verdict.allowed === false && verdict.declaredOrigin, null)
    assert.equal(verdict.allowed === false && verdict.attemptedOrigin, STORE)
  }
})

test('an UNREADABLE declaration refuses — an unreadable state is not permission', () => {
  const unreadable: Array<[string, string]> = [
    ['stage.example.com', 'a bare hostname is not an origin'],
    ['https://stage.example.com,https://live.example.com', 'a list is not one store'],
    ['https://stage.example.com https://live.example.com', 'whitespace-separated list'],
    ['https://stage.example.com/wp-json', 'a path is not an origin'],
    ['https://stage.example.com?x=1', 'a query is not an origin'],
    ['https://stage.example.com#f', 'a fragment is not an origin'],
    ['https://user:pw@stage.example.com', 'embedded credentials'],
    ['http://live.example.com', 'plain http on a public host'],
    ['ftp://stage.example.com', 'not an http scheme'],
    ['true', 'the boolean somebody will inevitably put here'],
    ['1', 'ditto'],
    ['*', 'the wildcard somebody will inevitably put here'],
  ]

  let checked = 0
  for (const [value, why] of unreadable) {
    const env = { [WC_WRITEBACK_ALLOWED_ORIGIN_ENV]: value }
    const declaration = readWcWritebackDeclaration(env)
    assert.equal(declaration.ok, false, `${value} (${why}) must not be readable`)
    assert.equal(declaration.ok === false && declaration.reason, 'unreadable', `${value} (${why})`)

    const verdict = evaluateWcWritebackFence(`${STORE}/wp-json/wc/v3/orders/1`, env)
    assert.equal(verdict.allowed, false, `${value} (${why}) must refuse`)
    assert.equal(verdict.allowed === false && verdict.code, 'unreadable_declaration', `${value} (${why})`)
    checked += 1
  }
  assert.equal(checked, unreadable.length, `precondition reached for all ${unreadable.length} shapes`)
})

test('the declaration NAMES A STORE: it is not a boolean, so it cannot be satisfied by a different wc_url', () => {
  const env = { [WC_WRITEBACK_ALLOWED_ORIGIN_ENV]: STORE }

  const permitted = evaluateWcWritebackFence(`${STORE}/wp-json/wc/v3/orders/1`, env)
  assert.equal(permitted.allowed, true)

  // The bug a boolean flag leaves open: change wc_url to the live store and inherit the grant.
  const live = evaluateWcWritebackFence('https://live.example.com/wp-json/wc/v3/orders/1', env)
  assert.equal(live.allowed, false)
  assert.equal(live.allowed === false && live.code, 'origin_mismatch')
  assert.equal(live.allowed === false && live.declaredOrigin, STORE)
  assert.equal(live.allowed === false && live.attemptedOrigin, 'https://live.example.com')
})

test('origin comparison includes scheme, host and port — each differing by itself is a refusal', () => {
  const env = { [WC_WRITEBACK_ALLOWED_ORIGIN_ENV]: 'https://stage.example.com' }
  const mismatches = [
    'http://stage.example.com/x',          // scheme
    'https://stage.example.com:8443/x',    // port
    'https://stage.example.co/x',          // host, one character short
    'https://sub.stage.example.com/x',     // a subdomain is a different origin
  ]
  for (const target of mismatches) {
    const verdict = evaluateWcWritebackFence(target, env)
    assert.equal(verdict.allowed, false, target)
    assert.equal(verdict.allowed === false && verdict.code, 'origin_mismatch', target)
  }
  assert.equal(mismatches.length, 4)
})

test('a trailing slash and the default port are the same declaration, not a different store', () => {
  for (const value of ['https://stage.example.com', 'https://stage.example.com/', 'https://stage.example.com:443']) {
    const verdict = evaluateWcWritebackFence('https://stage.example.com/wp-json/wc/v3/orders/1', {
      [WC_WRITEBACK_ALLOWED_ORIGIN_ENV]: value,
    })
    assert.equal(verdict.allowed, true, value)
  }
})

test('an http LOOPBACK origin is declarable, so local fakes and the e2e harness can declare themselves', () => {
  const env = { [WC_WRITEBACK_ALLOWED_ORIGIN_ENV]: 'http://127.0.0.1:1234' }
  assert.equal(evaluateWcWritebackFence('http://127.0.0.1:1234/wp-json/wc/v3/orders/1', env).allowed, true)
  assert.equal(evaluateWcWritebackFence('http://127.0.0.1:1235/wp-json/wc/v3/orders/1', env).allowed, false)
})

test('an UNPARSEABLE target refuses even when a store is declared', () => {
  const verdict = evaluateWcWritebackFence('not a url', { [WC_WRITEBACK_ALLOWED_ORIGIN_ENV]: STORE })
  assert.equal(verdict.allowed, false)
  assert.equal(verdict.allowed === false && verdict.code, 'unparseable_target')
})

test('every refusal message names both origins and the remedy, so a blocked run is self-explaining', () => {
  const undeclared = evaluateWcWritebackFence(`${STORE}/x`, {})
  assert.equal(undeclared.allowed, false)
  if (undeclared.allowed) return
  assert.match(undeclared.message, /REFUSED/)
  assert.match(undeclared.message, new RegExp(WC_WRITEBACK_ALLOWED_ORIGIN_ENV))
  assert.ok(undeclared.message.includes(STORE), 'names the attempted origin')

  const mismatch = evaluateWcWritebackFence('https://live.example.com/x', { [WC_WRITEBACK_ALLOWED_ORIGIN_ENV]: STORE })
  assert.equal(mismatch.allowed, false)
  if (mismatch.allowed) return
  assert.ok(mismatch.message.includes(STORE), 'names the declared origin')
  assert.ok(mismatch.message.includes('https://live.example.com'), 'names the attempted origin')
})

test('which methods are fenced: anything not provably read-only', () => {
  for (const method of ['GET', 'get', 'HEAD', 'OPTIONS', undefined, null]) {
    assert.equal(isWcWritebackMutation(method as string | undefined), false, String(method))
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'put', 'TRACE', 'WHATEVER', '']) {
    assert.equal(isWcWritebackMutation(method), true, String(method))
  }
})
