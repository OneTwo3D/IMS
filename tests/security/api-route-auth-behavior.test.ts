import assert from 'node:assert/strict'
import test from 'node:test'

import { GET as publicHealthGet } from '../../app/api/health/route.ts'
import { handleInvoicePdfRoute } from '../../app/api/invoices/[id]/route.ts'
import { POST as e2eNotificationsPost } from '../../app/api/e2e/notifications/route.ts'
import { verifyCron } from '../../lib/cron-auth.ts'
import {
  requireApiAdminSession,
  requireApiAuthSession,
  requireRoleSession,
  type AuthSession,
} from '../../lib/auth/session-gates.ts'
import {
  apiRouteRequest,
  assertRouteAccess,
  expectStatus,
  nextApiRouteRequest,
  withRouteEnv,
} from '../../lib/testing/api-route-test-harness.ts'

function session(role: string, overrides: Partial<AuthSession['user']> = {}): AuthSession {
  return {
    user: {
      id: `${role.toLowerCase()}-user`,
      email: `${role.toLowerCase()}@example.com`,
      name: role,
      role,
      supplierId: null,
      totpEnabled: false,
      totpVerified: true,
      ...overrides,
    },
  }
}

test('cron-secret policy route rejects missing and invalid bearer tokens', async () => {
  assertRouteAccess('/api/cron/invariant-check', 'cron-secret')

  await withRouteEnv({ CRON_SECRET: 'cron-secret', NODE_ENV: 'production' }, async () => {
    const missing = await verifyCron(apiRouteRequest('/api/cron/invariant-check'))
    assert.equal(missing?.status, 401)

    const invalid = await verifyCron(apiRouteRequest('/api/cron/invariant-check', {
      headers: { authorization: 'Bearer wrong-secret' },
    }))
    assert.equal(invalid?.status, 401)
  })
})

test('cron-secret policy route accepts the configured bearer token before cron work runs', async () => {
  assertRouteAccess('/api/cron/invariant-check', 'cron-secret')

  await withRouteEnv({ CRON_SECRET: 'cron-secret', NODE_ENV: 'production' }, async () => {
    const accepted = await verifyCron(apiRouteRequest('/api/cron/invariant-check', {
      headers: { authorization: 'Bearer cron-secret' },
    }))
    assert.equal(accepted, null)
  })
})

test('admin policy route rejects unauthenticated and non-admin sessions', async () => {
  assertRouteAccess('/api/admin/health', 'admin')

  await expectStatus('anonymous admin route', requireApiAdminSession(null) as Response, 401)

  for (const role of ['MANAGER', 'WAREHOUSE', 'FINANCE', 'READONLY', 'SUPPLIER']) {
    await expectStatus(`non-admin ${role} admin route`, requireApiAdminSession(session(role)) as Response, 403)
  }
})

test('admin policy route accepts admin sessions', async () => {
  assertRouteAccess('/api/admin/health', 'admin')

  const result = requireApiAdminSession(session('ADMIN'))
  assert.equal(result instanceof Response, false)
  assert.equal((result as AuthSession).user.role, 'ADMIN')
})

test('authenticated policy route rejects anonymous sessions and accepts verified users', async () => {
  assertRouteAccess('/api/export/products', 'authenticated')

  await expectStatus('anonymous authenticated route', requireApiAuthSession(null) as Response, 401)

  const result = requireApiAuthSession(session('USER'))
  assert.equal(result instanceof Response, false)
  assert.equal((result as AuthSession).user.email, 'user@example.com')
})

test('authenticated policy route rejects sessions still pending TOTP verification', async () => {
  assertRouteAccess('/api/export/products', 'authenticated')

  await expectStatus('totp-pending authenticated route', requireApiAuthSession(session('USER', {
    totpEnabled: true,
    totpVerified: false,
  })) as Response, 401)
})

test('multi-role helper accepts only explicitly allowed RBAC roles', () => {
  const allowedRoles = ['ADMIN', 'FINANCE', 'MANAGER']
  for (const role of allowedRoles) {
    assert.equal(requireRoleSession(session(role), allowedRoles).user.role, role)
  }

  for (const role of ['WAREHOUSE', 'READONLY', 'SUPPLIER']) {
    assert.throws(() => requireRoleSession(session(role), allowedRoles), /Forbidden/)
  }
})

test('internal-dev-only route returns 404 outside development E2E mode', async () => {
  assertRouteAccess('/api/e2e/notifications', 'internal-dev-only')

  await withRouteEnv({
    NODE_ENV: 'production',
    E2E_TEST_MODE: undefined,
    E2E_ROUTE_SECRET: 'e2e-secret',
  }, async () => {
    await expectStatus(
      'production e2e notification route',
      e2eNotificationsPost(nextApiRouteRequest('/api/e2e/notifications', {
        method: 'POST',
        body: JSON.stringify({ notifications: [] }),
      })),
      404,
    )
  })
})

test('public health route stays reachable without authentication and exposes minimal liveness', async () => {
  assertRouteAccess('/api/health', 'public-webhook')

  const response = await expectStatus('public health route', publicHealthGet(), 200)
  const body = await response.json() as { status?: unknown; checks?: unknown; database?: unknown }

  assert.equal(body.status, 'ok')
  assert.equal('checks' in body, false)
  assert.equal('database' in body, false)
})

test('public signed invoice route rejects missing signed token before loading PDF storage', async () => {
  assertRouteAccess('/api/invoices/[id]', 'public-webhook')

  await expectStatus(
    'signed invoice without token',
    handleInvoicePdfRoute(
      nextApiRouteRequest('/api/invoices/inv_123'),
      { id: 'inv_123' },
      {
        async loadInvoicePdf() {
          throw new Error('PDF storage should not be reached without a token')
        },
        verifyPdfToken(_orderId, token) {
          assert.equal(token, null)
          return { valid: false, reason: 'missing' }
        },
        async auditTokenAttempt() {},
      },
    ),
    403,
  )
})

test('public webhook shopping route is registered with public-webhook classification', () => {
  assertRouteAccess('/api/webhooks/shopping/[connector]/[resource]', 'public-webhook')
})

test('public Mintsoft webhook route requires plugin and shared-secret fixtures', {
  todo: 'Add a Mintsoft fixture that enables the plugin, configures a webhook secret, and asserts missing/stale signatures are rejected.',
}, () => {
  assertRouteAccess('/api/webhooks/mintsoft/asn-booked-in', 'public-webhook')
})

test('supplier RFQ route needs a supplier-owned purchase order fixture for ownership behavior', {
  todo: 'Seed one supplier-owned and one foreign RFQ, then assert supplier sessions can only fetch their own PDF.',
}, () => {
  assertRouteAccess('/api/rfq/[id]', 'supplier')
})
