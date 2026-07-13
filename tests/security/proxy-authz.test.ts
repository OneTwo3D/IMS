import assert from 'node:assert/strict'
import test from 'node:test'

import {
  evaluateProxyAuthz,
  isPublicProxyPath,
  PUBLIC_PAGE_PATHS,
  type ProxySession,
} from '../../lib/security/proxy-authz.ts'

// onetwo3d-ims-muid: regression coverage for unauthenticated proxy-bypass
// request shapes (alongside the Next 16.2.10 advisory upgrade). The proxy is
// the first authz gate for HTML pages; these assert an unauthenticated request
// to a protected page is ALWAYS redirected to login and that no path shape
// slips a protected page past the public-route allowlist.

const validUser: ProxySession = { user: { sessionInvalidReason: null, totpEnabled: false, totpVerified: false } }

test('public paths: exact auth pages and their sub-paths are public', () => {
  for (const base of PUBLIC_PAGE_PATHS) {
    assert.equal(isPublicProxyPath(base), true, `${base} should be public`)
    assert.equal(isPublicProxyPath(`${base}/anything`), true, `${base}/anything should be public`)
  }
  assert.equal(isPublicProxyPath('/api/cron/wms-watchdog'), true)
  assert.equal(isPublicProxyPath('/api/anything'), true)
})

test('BYPASS: a loose-prefix path is NOT treated as a public auth page', () => {
  // The old startsWith('/login') also matched these — a future route with such
  // a name would have been silently exposed. They must now be PROTECTED.
  for (const path of ['/login-attacker', '/loginX', '/2fabypass', '/forgot-password-evil', '/reset-passwordX']) {
    assert.equal(isPublicProxyPath(path), false, `${path} must not be public`)
    const decision = evaluateProxyAuthz(path, null)
    assert.equal(decision.action, 'redirect-login', `${path} unauthenticated must redirect to login`)
  }
})

test('BYPASS: a page path resembling but not under /api/ is protected', () => {
  // `/apixyz` and `/api` (no trailing slash) are NOT API routes.
  assert.equal(isPublicProxyPath('/apixyz'), false)
  assert.equal(isPublicProxyPath('/api'), false)
  assert.equal(evaluateProxyAuthz('/apixyz', null).action, 'redirect-login')
})

test('unauthenticated request to a protected page redirects to login', () => {
  for (const path of ['/dashboard', '/settings/system', '/inventory', '/sales', '/sync', '/']) {
    assert.deepEqual(evaluateProxyAuthz(path, null), { action: 'redirect-login', invalidReason: null })
  }
})

test('a session with an invalid reason redirects to login and carries the reason', () => {
  const invalid: ProxySession = { user: { sessionInvalidReason: 'force-logout' } }
  assert.deepEqual(evaluateProxyAuthz('/dashboard', invalid), {
    action: 'redirect-login',
    invalidReason: 'force-logout',
  })
})

test('an empty / userless session redirects to login', () => {
  assert.equal(evaluateProxyAuthz('/dashboard', undefined).action, 'redirect-login')
  assert.equal(evaluateProxyAuthz('/dashboard', {}).action, 'redirect-login')
  assert.equal(evaluateProxyAuthz('/dashboard', { user: null }).action, 'redirect-login')
})

test('a valid, TOTP-cleared session is allowed through to a protected page', () => {
  assert.deepEqual(evaluateProxyAuthz('/dashboard', validUser), { action: 'allow' })
})

test('2FA gate: TOTP enabled but unverified redirects a protected page to /2fa', () => {
  const pending: ProxySession = { user: { totpEnabled: true, totpVerified: false } }
  assert.equal(evaluateProxyAuthz('/dashboard', pending).action, 'redirect-2fa')
  // but the /2fa page itself stays public so the user can complete it
  assert.equal(evaluateProxyAuthz('/2fa', pending).action, 'public')
})

test('a TOTP-verified session passes through', () => {
  const verified: ProxySession = { user: { totpEnabled: true, totpVerified: true } }
  assert.deepEqual(evaluateProxyAuthz('/dashboard', verified), { action: 'allow' })
})

test('public paths are never gated even without a session', () => {
  assert.equal(evaluateProxyAuthz('/login', null).action, 'public')
  assert.equal(evaluateProxyAuthz('/api/cron/backup', null).action, 'public')
})
