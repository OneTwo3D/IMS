import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { NextRequest } from 'next/server'

import { handleProxy } from '../../proxy.ts'
import type { ProxySession } from '../../lib/security/proxy-authz.ts'

// onetwo3d-ims-muid: END-TO-END regression — drive the real proxy middleware
// core (handleProxy) with an injected session resolver, so a regression in the
// wiring itself (not just the pure helper) is caught. The session resolver is
// injected rather than module-mocked so this runs under the standard test
// runner with no experimental flags.

const req = (pathname: string) => new NextRequest(`https://ims.example.com${pathname}`)
const noSession = async (): Promise<ProxySession> => null
const validUser = async (): Promise<ProxySession> => ({ user: { sessionInvalidReason: null, totpEnabled: false, totpVerified: false } })

/** Assert the response is a redirect to /login (optionally pinning the callbackUrl). */
const isLoginRedirect = (res: { status: number; headers: Headers }, expectedCallback?: string) => {
  assert.equal(res.status, 307, 'expected a redirect')
  const url = new URL(res.headers.get('location') ?? '')
  assert.equal(url.pathname, '/login')
  if (expectedCallback !== undefined) assert.equal(url.searchParams.get('callbackUrl'), expectedCallback)
}

/** Assert the response is a pass-through: 200, the Next continue marker, and (on HTML) CSP + nonce. */
const isPassThrough = (res: { status: number; headers: Headers }, opts: { csp?: boolean } = {}) => {
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('x-middleware-next'), '1', 'expected the Next continue marker')
  assert.equal(res.headers.get('location'), null)
  if (opts.csp !== false) {
    assert.ok(res.headers.get('content-security-policy-report-only') || res.headers.get('content-security-policy'), 'expected a CSP header on HTML pass-through')
    assert.ok(res.headers.get('x-middleware-request-x-nonce'), 'expected the per-request nonce propagated to the page')
  }
}

test('E2E: an unauthenticated request to a protected page redirects to login', async () => {
  const res = await handleProxy(req('/settings/system'), noSession)
  isLoginRedirect(res, '/settings/system')
})

test('E2E: unauthenticated bypass-shaped transports (.rsc / segment / data) redirect to login', async () => {
  // These are exactly the alternate App-Router transports the Next advisories
  // concern — an unauthenticated request in ANY of these forms must still be
  // gated by the proxy, not slip through.
  // Some transports (e.g. /_next/data/<id>/*.json) are normalized by
  // NextRequest to their resolved page path, so pin only that it redirects to
  // /login — the security invariant — not the exact callbackUrl.
  for (const path of [
    '/dashboard.rsc',
    '/settings.rsc',
    '/dashboard.segments/__PAGE__.segment.rsc',
    '/_next/data/BUILD_ID/dashboard.json',
    '/dashboard%2e%2e/secret',
  ]) {
    const res = await handleProxy(req(path), noSession)
    isLoginRedirect(res)
  }
  // A pathname-preserving transport (.rsc) keeps the original path as callbackUrl.
  isLoginRedirect(await handleProxy(req('/dashboard.rsc'), noSession), '/dashboard.rsc')
})

test('the exported proxy() delegates to handleProxy with the real auth (wiring guard)', () => {
  // Text-guard so a future de-wiring of the composition root is caught without
  // importing next-auth's real session machinery into the unit test.
  const src = readFileSync(new URL('../../proxy.ts', import.meta.url), 'utf8')
  assert.match(src, /return handleProxy\(request,\s*auth\)/)
})

test('E2E: a valid session passes through with 200 + CSP + propagated nonce', async () => {
  const res = await handleProxy(req('/dashboard'), validUser)
  isPassThrough(res)
})

test('E2E: public auth pages pass through even with no session', async () => {
  const res = await handleProxy(req('/login'), noSession)
  isPassThrough(res)
})

test('E2E: an API route passes through (self-authenticates; no page CSP)', async () => {
  const res = await handleProxy(req('/api/cron/wms-watchdog'), noSession)
  isPassThrough(res, { csp: false })
})

test('E2E: a thrown session resolve (corrupt JWT) redirects to login', async () => {
  const throwing = async (): Promise<ProxySession> => { throw new Error('corrupt jwt') }
  const res = await handleProxy(req('/inventory'), throwing)
  isLoginRedirect(res, '/inventory')
})

test('E2E: an invalidated session redirects to login carrying the reason', async () => {
  const invalid = async (): Promise<ProxySession> => ({ user: { sessionInvalidReason: 'force-logout' } })
  const res = await handleProxy(req('/dashboard'), invalid)
  assert.equal(res.status, 307)
  const url = new URL(res.headers.get('location') ?? '')
  assert.equal(url.pathname, '/login')
  assert.equal(url.searchParams.get('reason'), 'signed-out')   // force-logout -> signed-out
})

test('E2E: a TOTP-pending session is redirected to /2fa on a protected page', async () => {
  const pending = async (): Promise<ProxySession> => ({ user: { totpEnabled: true, totpVerified: false } })
  const res = await handleProxy(req('/dashboard'), pending)
  assert.equal(res.status, 307)
  assert.equal(new URL(res.headers.get('location') ?? '').pathname, '/2fa')
})
