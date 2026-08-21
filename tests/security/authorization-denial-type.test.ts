import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// ---------------------------------------------------------------------------
// Authorization DENIAL is a type, not a message.
//
// Callers that load several independent reads in parallel (the Integrations page loads 22) must
// tell "this dependency is unavailable" apart from "you were never entitled to this". Degrading
// the second into the first renders a partial page to a role that should have got nothing — which
// is exactly what happened once app/(dashboard)/sync/page.tsx started classifying every non-Next
// rejection as an availability failure.
//
// The distinction therefore has to be carried by the error itself. This file pins that contract at
// its source: the gates in lib/auth/server.ts and lib/auth/session-gates.ts must throw the typed
// error, and isAuthorizationDenial must recognise it WITHOUT matching on message text — a message
// interpolates a permission name and any read is free to reject with an arbitrary string.
// ---------------------------------------------------------------------------

const state = {
  session: null as unknown,
  redirects: [] as string[],
}

class RedirectError extends Error {
  digest: string
  constructor(url: string) {
    super('NEXT_REDIRECT')
    this.digest = `NEXT_REDIRECT;replace;${url};307;`
  }
}

mock.module('next/navigation', {
  namedExports: {
    redirect: (url: string) => { state.redirects.push(url); throw new RedirectError(url) },
  },
})

mock.module('@/lib/auth', { namedExports: { auth: async () => state.session } })

function sessionFor(role: string) {
  return { user: { id: 'u1', email: 'u@example.com', name: 'U', role, supplierId: null, totpEnabled: false, totpVerified: false, sessionAuthTime: Math.floor(Date.now() / 1000) } }
}

test.beforeEach(() => {
  state.session = sessionFor('ADMIN')
  state.redirects = []
})

test('requirePermission throws a typed denial carrying the missing permission', async () => {
  const { requirePermission } = await import('@/lib/auth/server')
  const { PermissionDeniedError, isAuthorizationDenial } = await import('@/lib/auth/session-gates')
  // WAREHOUSE holds `inventory` but not `sync` (lib/permissions.ts ROLE_PERMISSIONS).
  state.session = sessionFor('WAREHOUSE')

  await assert.rejects(() => requirePermission('sync'), (error: unknown) => {
    assert.ok(error instanceof PermissionDeniedError, 'a bare Error would be indistinguishable from an outage')
    assert.equal(error.permission, 'sync')
    assert.equal(error.code, 'permission_denied')
    assert.ok(isAuthorizationDenial(error))
    return true
  })
  assert.deepEqual(state.redirects, [], 'an entitled-but-refused caller is not redirected')
})

test('requireFreshPermission throws the same typed denial for a missing permission', async () => {
  const { requireFreshPermission } = await import('@/lib/auth/server')
  const { PermissionDeniedError } = await import('@/lib/auth/session-gates')
  state.session = sessionFor('READONLY')

  await assert.rejects(
    () => requireFreshPermission('sync'),
    (error: unknown) => error instanceof PermissionDeniedError && error.permission === 'sync',
  )
})

test('requireRole/requireRoleSession denial is the same type', async () => {
  const { requireRole } = await import('@/lib/auth/server')
  const { requireRoleSession, PermissionDeniedError, isAuthorizationDenial } = await import('@/lib/auth/session-gates')
  state.session = sessionFor('FINANCE')

  await assert.rejects(() => requireRole('ADMIN'), PermissionDeniedError)
  assert.throws(
    () => requireRoleSession(sessionFor('FINANCE') as never, ['ADMIN']),
    (error: unknown) => error instanceof PermissionDeniedError && isAuthorizationDenial(error) && error.permission === null,
  )
})

test('a permitted role is not denied', async () => {
  const { requirePermission } = await import('@/lib/auth/server')
  state.session = sessionFor('MANAGER')
  const session = await requirePermission('sync')
  assert.equal(session.user.role, 'MANAGER')
})

test('isAuthorizationDenial separates denial from outage and from control flow', async () => {
  const { isAuthorizationDenial, PermissionDeniedError, FreshAuthRequiredError } = await import('@/lib/auth/session-gates')

  assert.equal(isAuthorizationDenial(new PermissionDeniedError('Forbidden: missing permission sync', 'sync')), true)
  // A stale session on a step-up gate is a refusal too, not a dependency being down.
  assert.equal(isAuthorizationDenial(new FreshAuthRequiredError({ valid: false, reason: 'stale' } as never)), true)

  // An ordinary outage must stay degradable — even one whose text happens to mention Forbidden,
  // which is why this predicate must never read the message.
  assert.equal(isAuthorizationDenial(new Error('database is unreachable')), false)
  assert.equal(isAuthorizationDenial(new Error('Forbidden: upstream returned 403')), false)
  assert.equal(isAuthorizationDenial(new RedirectError('/login')), false, 'a redirect is control flow, handled separately')
  assert.equal(isAuthorizationDenial(null), false)
  assert.equal(isAuthorizationDenial(undefined), false)
  assert.equal(isAuthorizationDenial('Forbidden'), false)
})

test('an unauthenticated or unverified session redirects instead of being denied', async () => {
  const { requirePermission } = await import('@/lib/auth/server')
  const { isAuthorizationDenial } = await import('@/lib/auth/session-gates')

  state.session = null
  await assert.rejects(() => requirePermission('sync'), (error: unknown) => {
    assert.equal(isAuthorizationDenial(error), false, 'authentication is control flow, not a denial')
    return error instanceof RedirectError
  })
  assert.deepEqual(state.redirects, ['/login'])

  state.redirects = []
  state.session = { ...sessionFor('ADMIN'), user: { ...sessionFor('ADMIN').user, totpEnabled: true, totpVerified: false } }
  await assert.rejects(() => requirePermission('sync'), RedirectError)
  assert.deepEqual(state.redirects, ['/2fa'])
})
