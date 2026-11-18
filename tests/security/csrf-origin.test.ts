import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'

import { handleProxy } from '../../proxy.ts'
import { apiRouteAuthPolicy } from '../../lib/security/route-auth-policy.ts'
import { csrfOriginCheckApplies, evaluateCsrfOrigin, resolveApiRouteAccess } from '../../lib/security/csrf-origin.ts'

const hdr = (h: Record<string, string>) => new Headers(h)
const validUser = async () => ({ user: { sessionInvalidReason: null, totpEnabled: false, totpVerified: false } })

const send = (path: string, method: string, headers: Record<string, string>) =>
  handleProxy(new NextRequest(`https://ims.example.com${path}`, { method, headers }), validUser)

test('a cross-site POST to a cookie-authenticated route is refused with 403', async () => {
  for (const path of ['/api/backup/create', '/api/backup/upload-remote', '/api/shopping/manual-sync', '/api/import/historical-orders', '/api/upload/invoice', '/api/admin/accounting/backfill']) {
    const bySite = await send(path, 'POST', { 'sec-fetch-site': 'cross-site' })
    assert.equal(bySite.status, 403, `${path} Sec-Fetch-Site cross-site`)
    const byOrigin = await send(path, 'POST', { origin: 'https://evil.example' })
    assert.equal(byOrigin.status, 403, `${path} foreign Origin`)
    const sameSite = await send(path, 'POST', { 'sec-fetch-site': 'same-site' })
    assert.equal(sameSite.status, 403, `${path} same-site (sibling subdomain)`)
  }
})

test('same-origin browser requests and header-less script clients pass through', async () => {
  const a = await send('/api/backup/create', 'POST', { 'sec-fetch-site': 'same-origin' })
  assert.equal(a.headers.get('x-middleware-next'), '1')
  const b = await send('/api/backup/create', 'POST', { origin: 'https://ims.example.com', host: 'ims.example.com' })
  assert.equal(b.headers.get('x-middleware-next'), '1')
  const c = await send('/api/backup/create', 'POST', {})
  assert.equal(c.headers.get('x-middleware-next'), '1')
  const d = await send('/api/backup/create', 'POST', { origin: 'https://ims.example.com', host: 'localhost:3000', 'x-forwarded-host': 'ims.example.com' })
  assert.equal(d.headers.get('x-middleware-next'), '1')
})

test('reads are never origin-checked', async () => {
  const res = await send('/api/export/analytics', 'GET', { 'sec-fetch-site': 'cross-site' })
  assert.equal(res.headers.get('x-middleware-next'), '1')
})

test('signed webhook, cron, shop HMAC and OAuth routes are exempt', async () => {
  for (const path of [
    '/api/webhooks/mintsoft/asn-booked-in',
    '/api/webhooks/shopping/woocommerce/orders',
    '/api/shopping/woocommerce/invoice-pdf',
    '/api/shopping/woocommerce/credit-note-pdf',
    '/api/cron/accounting-sync',
    '/api/auth/callback/credentials',
    '/api/accounting/callback',
  ]) {
    const res = await send(path, 'POST', { origin: 'https://wp.shop.example', 'sec-fetch-site': 'cross-site' })
    assert.equal(res.status, 200, `${path} must not be origin-checked`)
  }
})

test('every policy route that is not cookie-authenticated is exempt and every other one is checked', () => {
  for (const [pattern, entry] of Object.entries(apiRouteAuthPolicy)) {
    const concrete = pattern.replace(/\[\.\.\.[^\]]+\]/g, 'a/b').replace(/\[[^\]]+\]/g, 'x')
    assert.ok(resolveApiRouteAccess(concrete), `${pattern} resolves`)
    const exempt = ['public-webhook', 'cron-secret', 'xero-oauth', 'internal-dev-only'].includes(entry.access)
    assert.equal(csrfOriginCheckApplies('POST', concrete), !exempt, `${pattern} (${entry.access})`)
  }
})

test('a route the policy does not list is checked, not exempted', () => {
  assert.equal(evaluateCsrfOrigin({ method: 'POST', pathname: '/api/new-unlisted', headers: hdr({ 'sec-fetch-site': 'cross-site' }) }).allowed, false)
})
