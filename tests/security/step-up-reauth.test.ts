import assert from 'node:assert/strict'
import test from 'node:test'

import { isFreshAuthFailure } from '@/lib/auth/fresh-auth-result'
import {
  FreshAuthRequiredError,
  freshAuthFailureResult,
  requireFreshAuthSession,
  type AuthSession,
} from '@/lib/auth/session-gates'

// audit-ohou: the step-up contract has two ends —
// (1) gated server actions catch FreshAuthRequiredError and RETURN
//     freshAuthFailureResult(e) instead of throwing an opaque 500;
// (2) the client detects that structured failure via isFreshAuthFailure and
//     prompts re-auth + retries. These tests pin both ends.

function staleSession(): AuthSession {
  // Authenticated 1 hour ago — well past the 15-min freshness window.
  return {
    user: {
      id: 'user-1',
      email: 'a@b.com',
      name: 'A',
      role: 'ADMIN',
      supplierId: null,
      totpEnabled: false,
      totpVerified: false,
      sessionAuthTime: Math.floor(Date.now() / 1000) - 60 * 60,
    },
  }
}

test('requireFreshAuthSession throws FreshAuthRequiredError when the session is stale', () => {
  assert.throws(
    () => requireFreshAuthSession(staleSession()),
    (error) => error instanceof FreshAuthRequiredError && error.code === 'fresh_auth_required',
  )
})

test('requireFreshAuthSession returns the session when freshly authenticated', () => {
  const fresh = staleSession()
  fresh.user.sessionAuthTime = Math.floor(Date.now() / 1000) - 30 // 30s ago
  assert.equal(requireFreshAuthSession(fresh), fresh)
})

test('freshAuthFailureResult converts a FreshAuthRequiredError into the structured failure', () => {
  let caught: unknown
  try {
    requireFreshAuthSession(staleSession())
  } catch (e) {
    caught = e
  }
  const result = freshAuthFailureResult(caught)
  assert.ok(result)
  assert.equal(result?.success, false)
  assert.equal(result?.code, 'fresh_auth_required')
  assert.equal(result?.reason, 'stale-auth')
})

test('freshAuthFailureResult returns null for unrelated errors (so they rethrow)', () => {
  assert.equal(freshAuthFailureResult(new Error('Forbidden: missing permission')), null)
  assert.equal(freshAuthFailureResult('boom'), null)
  assert.equal(freshAuthFailureResult(null), null)
})

test('isFreshAuthFailure detects only the structured fresh-auth failure', () => {
  // The exact shape a gated action returns after conversion.
  assert.equal(isFreshAuthFailure({ success: false, error: 'Re-authentication required', code: 'fresh_auth_required', reason: 'stale-auth' }), true)
  // A genuine business failure must NOT trigger a step-up prompt.
  assert.equal(isFreshAuthFailure({ success: false, error: 'Store domain is required' }), false)
  // A success result must not trigger a prompt.
  assert.equal(isFreshAuthFailure({ success: true }), false)
  // Wrong code is ignored.
  assert.equal(isFreshAuthFailure({ success: false, code: 'something_else' }), false)
  assert.equal(isFreshAuthFailure(null), false)
  assert.equal(isFreshAuthFailure(undefined), false)
})

test('round-trip: a converted failure is detected by the client predicate', () => {
  let caught: unknown
  try {
    requireFreshAuthSession(staleSession())
  } catch (e) {
    caught = e
  }
  const result = freshAuthFailureResult(caught)
  assert.equal(isFreshAuthFailure(result), true)
})
