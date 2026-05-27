import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_FRESH_AUTH_MAX_AGE_SECONDS,
  evaluateSessionState,
  evaluateFreshAuth,
  freshAuthMaxAgeSeconds,
  loginPathForSessionInvalidReason,
  sessionAuthTimeSeconds,
  sessionInvalidLoginMessage,
  sessionInvalidLoginReason,
  type SessionUserState,
} from '@/lib/auth/session-state'

function user(overrides: Partial<SessionUserState> = {}): SessionUserState {
  return {
    id: 'user-1',
    active: true,
    sessionVersion: 3,
    forceLogoutAt: null,
    ...overrides,
  }
}

test('session state accepts active users with matching session version', () => {
  assert.deepEqual(
    evaluateSessionState({ sessionVersion: 3, sessionAuthTime: 1_700_000_000 }, user()),
    { valid: true },
  )
})

test('session state rejects deleted or inactive users', () => {
  assert.deepEqual(
    evaluateSessionState({ sessionVersion: 3, sessionAuthTime: 1_700_000_000 }, null),
    { valid: false, reason: 'missing-user' },
  )
  assert.deepEqual(
    evaluateSessionState({ sessionVersion: 3, sessionAuthTime: 1_700_000_000 }, user({ active: false })),
    { valid: false, reason: 'inactive-user' },
  )
})

test('session state rejects stale tokens after role, TOTP, password, or supplier changes', () => {
  assert.deepEqual(
    evaluateSessionState({ sessionVersion: 2, sessionAuthTime: 1_700_000_000 }, user({ sessionVersion: 3 })),
    { valid: false, reason: 'session-version-mismatch' },
  )
})

test('session state rejects corrupt stored session versions before token comparison', () => {
  assert.deepEqual(
    evaluateSessionState({ sessionVersion: 0, sessionAuthTime: 1_700_000_000 }, user({ sessionVersion: 0 })),
    { valid: false, reason: 'invalid-version' },
  )
  assert.deepEqual(
    evaluateSessionState({ sessionVersion: -1, sessionAuthTime: 1_700_000_000 }, user({ sessionVersion: -1 })),
    { valid: false, reason: 'invalid-version' },
  )
})

test('session state reason priority is stable for overlapping denial causes', () => {
  assert.deepEqual(
    evaluateSessionState(
      { sessionVersion: 2, sessionAuthTime: 1_700_000_000 },
      user({ active: false, sessionVersion: 3 }),
    ),
    { valid: false, reason: 'inactive-user' },
  )
  assert.deepEqual(
    evaluateSessionState(
      { sessionVersion: 3, sessionAuthTime: 1_700_000_000 },
      user({ sessionVersion: 0, forceLogoutAt: new Date(1_700_000_001_000) }),
    ),
    { valid: false, reason: 'invalid-version' },
  )
})

test('session state rejects sessions issued before forceLogoutAt', () => {
  assert.deepEqual(
    evaluateSessionState(
      { sessionVersion: 3, sessionAuthTime: 1_700_000_000 },
      user({ forceLogoutAt: new Date(1_700_000_000_000) }),
    ),
    { valid: false, reason: 'force-logout' },
  )
  assert.deepEqual(
    evaluateSessionState(
      { sessionVersion: 3, sessionAuthTime: 1_700_000_001 },
      user({ forceLogoutAt: new Date(1_700_000_000_000) }),
    ),
    { valid: true },
  )
  assert.deepEqual(
    evaluateSessionState(
      { sessionVersion: 3, sessionAuthTime: 1_700_000_000 },
      user({ forceLogoutAt: new Date(1_700_000_000_000) }),
    ),
    { valid: false, reason: 'force-logout' },
  )
})

test('session state requires auth time when force logout is set', () => {
  assert.equal(sessionAuthTimeSeconds(1_700_000_000), 1_700_000_000)
  assert.equal(sessionAuthTimeSeconds('1700000000'), null)
  assert.equal(sessionAuthTimeSeconds(1_700_000_000.5), null)
  assert.equal(sessionAuthTimeSeconds(-1), null)
  assert.equal(sessionAuthTimeSeconds(0), null)
  assert.equal(sessionAuthTimeSeconds(Number.MAX_SAFE_INTEGER + 1), null)
  assert.deepEqual(
    evaluateSessionState(
      { sessionVersion: 3 },
      user({ forceLogoutAt: new Date(1_700_000_000_000) }),
    ),
    { valid: false, reason: 'missing-auth-time' },
  )
  assert.deepEqual(
    evaluateSessionState(
      { sessionVersion: 3 },
      user({ forceLogoutAt: null }),
    ),
    { valid: true },
  )
})

test('session state treats string token versions as stale', () => {
  assert.deepEqual(
    evaluateSessionState({ sessionVersion: '3', sessionAuthTime: 1_700_000_000 }, user()),
    { valid: false, reason: 'session-version-mismatch' },
  )
})

test('fresh auth accepts recent auth_time and rejects missing or stale auth_time', () => {
  assert.deepEqual(
    evaluateFreshAuth(1_700_000_000, { nowSeconds: 1_700_000_600, maxAgeSeconds: 900 }),
    { valid: true, ageSeconds: 600, maxAgeSeconds: 900 },
  )
  assert.deepEqual(
    evaluateFreshAuth(1_700_000_000, { nowSeconds: 1_700_000_901, maxAgeSeconds: 900 }),
    { valid: false, reason: 'stale-auth', ageSeconds: 901, maxAgeSeconds: 900 },
  )
  assert.deepEqual(
    evaluateFreshAuth(undefined, { nowSeconds: 1_700_000_000, maxAgeSeconds: 900 }),
    { valid: false, reason: 'missing-auth-time', ageSeconds: null, maxAgeSeconds: 900 },
  )
})

test('fresh auth max age falls back to the default for invalid configuration', () => {
  assert.equal(freshAuthMaxAgeSeconds('1200'), 1200)
  assert.equal(freshAuthMaxAgeSeconds(300), 300)
  assert.equal(freshAuthMaxAgeSeconds('0'), DEFAULT_FRESH_AUTH_MAX_AGE_SECONDS)
  assert.equal(freshAuthMaxAgeSeconds('abc'), DEFAULT_FRESH_AUTH_MAX_AGE_SECONDS)
})

test('session invalidation reasons map to login UX reasons', () => {
  assert.equal(sessionInvalidLoginReason('inactive-user'), 'account-deactivated')
  assert.equal(sessionInvalidLoginReason('missing-user'), 'account-deactivated')
  assert.equal(sessionInvalidLoginReason('session-version-mismatch'), 'session-expired')
  assert.equal(sessionInvalidLoginReason('invalid-version'), 'session-expired')
  assert.equal(sessionInvalidLoginReason('force-logout'), 'signed-out')
  assert.equal(sessionInvalidLoginReason('missing-auth-time'), 'signed-out')
  assert.equal(loginPathForSessionInvalidReason('session-version-mismatch'), '/login?reason=session-expired')
  assert.match(sessionInvalidLoginMessage('account-deactivated') ?? '', /no longer active/)
})
