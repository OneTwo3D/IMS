import assert from 'node:assert/strict'
import test from 'node:test'

import {
  handleAccountingCallback,
  resolveAppOrigin,
  type AccountingCallbackDeps,
} from '@/app/api/accounting/callback/route'
import { buildAccountingCallbackUri } from '@/lib/accounting/callback-url'
import type { IntegrationPluginId } from '@/lib/integration-plugins'

// onetwo3d-ims-qye3 (CWE-601): the accounting OAuth callback must build its
// redirect Location ONLY from the trusted, server-configured app URL — never
// from the attacker-controlled Host / X-Forwarded-Host headers. These drive the
// REAL handler (handleAccountingCallback) so a future revert to header-derived
// origin logic is caught, and assert the emitted 307 Location.

const CONFIGURED = 'https://ims.example.com'

/** A callback request whose forwarded-host headers claim an attacker origin. */
const hostileRequest = (query: string) =>
  new Request(`${CONFIGURED}/api/accounting/callback?${query}`, {
    headers: {
      host: 'attacker.example',
      'x-forwarded-host': 'attacker.example',
      'x-forwarded-proto': 'https',
    },
  })

const deps = (opts: { appUrl: string | null; enabled?: (p: IntegrationPluginId) => boolean }): AccountingCallbackDeps => ({
  getPublicAppUrl: async () => opts.appUrl,
  isPluginEnabled: async (p) => (opts.enabled ? opts.enabled(p) : true),
})

const location = (res: Response) => res.headers.get('location') ?? ''

// --- resolveAppOrigin: never derives from request/headers -----------------

test('resolveAppOrigin returns the configured origin, or null — never a request/header value', () => {
  assert.equal(resolveAppOrigin(CONFIGURED), CONFIGURED)
  assert.equal(resolveAppOrigin(`${CONFIGURED}/sync?x=1`), CONFIGURED)
  assert.equal(resolveAppOrigin(null), null)
  assert.equal(resolveAppOrigin('not a url'), null)
})

// --- handleAccountingCallback: the emitted Location is never the attacker --

test('END-TO-END: a hostile forwarded host cannot change the redirect origin (configured URL wins)', async () => {
  const res = await handleAccountingCallback(hostileRequest('error=cancelled'), deps({ appUrl: CONFIGURED }))
  assert.equal(res.status, 307)
  const url = new URL(location(res))
  assert.equal(url.origin, CONFIGURED)
  assert.doesNotMatch(location(res), /attacker/)
  assert.equal(url.searchParams.get('accounting_error'), 'cancelled')
})

test('END-TO-END: with NO configured app URL, the redirect is RELATIVE — never the forwarded host', async () => {
  const res = await handleAccountingCallback(hostileRequest('error=cancelled'), deps({ appUrl: null }))
  assert.equal(res.status, 307)
  // A relative Location the browser resolves against the real request URL —
  // immune to forwarded-host spoofing regardless of Next's host-trust mode.
  assert.match(location(res), /^\/sync/)
  assert.doesNotMatch(location(res), /attacker/)
  assert.doesNotMatch(location(res), /^https?:\/\//)
})

test('END-TO-END: a malformed configured app URL also degrades to a safe relative redirect', async () => {
  const res = await handleAccountingCallback(hostileRequest('error=cancelled'), deps({ appUrl: 'not a url' }))
  assert.equal(res.status, 307)
  assert.match(location(res), /^\/sync/)
  assert.doesNotMatch(location(res), /attacker/)
})

// --- connector selection + gating (valid Xero/QBO shapes) -----------------

test('END-TO-END: a QuickBooks callback (realmId present) selects the quickbooks connector', async () => {
  const res = await handleAccountingCallback(
    hostileRequest('error=cancelled&realmId=123'),
    deps({ appUrl: CONFIGURED, enabled: (p) => p === 'quickbooks' }),
  )
  assert.equal(new URL(location(res)).origin, CONFIGURED)
  assert.match(location(res), /connector=quickbooks/)
})

test('END-TO-END: a Xero callback (no realmId) selects the xero connector', async () => {
  const res = await handleAccountingCallback(
    hostileRequest('error=cancelled'),
    deps({ appUrl: CONFIGURED, enabled: (p) => p === 'xero' }),
  )
  assert.equal(new URL(location(res)).origin, CONFIGURED)
  assert.match(location(res), /connector=xero/)
})

test('END-TO-END: a disabled plugin redirects with the disabled error, still on the configured origin', async () => {
  const res = await handleAccountingCallback(
    hostileRequest('code=abc&state=xyz'),
    deps({ appUrl: CONFIGURED, enabled: () => false }),
  )
  assert.equal(new URL(location(res)).origin, CONFIGURED)
  assert.match(new URL(location(res)).searchParams.get('accounting_error') ?? '', /disabled/)
})

// (The real-GET wiring test lives in accounting-callback-get.test.ts, which
// mocks the DB-backed deps BEFORE importing the route — impossible here where
// the route is statically imported for the handler tests above.)

test('END-TO-END: a real exchange (code+state) with NO configured URL errors BEFORE consuming state (F4)', async () => {
  // No token-exchange import should run; the guard fires first and emits a safe
  // relative error redirect, leaving the single-use OAuth state intact for retry.
  const res = await handleAccountingCallback(
    hostileRequest('code=abc&state=xyz'),
    deps({ appUrl: null, enabled: () => true }),
  )
  assert.equal(res.status, 307)
  assert.match(location(res), /^\/sync/)
  assert.doesNotMatch(location(res), /attacker|^https?:\/\//)
  assert.match(new URL(location(res), 'http://x.invalid').searchParams.get('accounting_error') ?? '', /not configured/i)
})

test('resolveAppOrigin returns the NORMALIZED origin for WHATWG-parseable junk (F4 — redirect_uri is built from this, never the raw string)', () => {
  // These parse to a valid origin, so the exchange proceeds — but redirectUri
  // is built from this normalized origin, so backslashes/query/fragment in the
  // configured value can never produce a malformed redirect_uri.
  assert.equal(resolveAppOrigin('https:\\\\ims.example.com'), CONFIGURED)
  assert.equal(resolveAppOrigin('https://ims.example.com?junk=1'), CONFIGURED)
  assert.equal(resolveAppOrigin('https://ims.example.com#junk'), CONFIGURED)
  assert.equal(resolveAppOrigin('https://ims.example.com/base/path'), CONFIGURED)
})

test('buildAccountingCallbackUri normalizes every settings-accepted config to the same redirect_uri (Codex r5/r6: exact-match on BOTH sides)', () => {
  // Authorize (xero-sync/quickbooks-sync) and the callback token exchange both
  // call this ONE builder, so the redirect_uri is identical for every valid
  // config — including user-info, which the origin form strips consistently
  // (Codex r6: the previous mismatch was user-info preserved on one side only).
  const EXPECTED = `${CONFIGURED}/api/accounting/callback`
  for (const cfg of [
    'https://ims.example.com',
    'https://IMS.EXAMPLE.COM',
    'https://ims.example.com:443',
    'https://ims.example.com/base',
    'https://ims.example.com/',
    'https://user:pass@ims.example.com',
    'https://user:pass@ims.example.com/base?q=1#f',
    'https:\\\\ims.example.com',
  ]) {
    assert.equal(buildAccountingCallbackUri(cfg), EXPECTED, `redirect_uri mismatch for ${cfg}`)
  }
  // No valid origin → null, so callers reject before consuming OAuth state.
  assert.equal(buildAccountingCallbackUri(null), null)
  assert.equal(buildAccountingCallbackUri('not a url'), null)
  assert.equal(buildAccountingCallbackUri('data:text/html,x'), null)
})

test('resolveAppOrigin rejects non-web schemes that parse but have origin "null" (F5)', () => {
  for (const bad of ['data:text/html,x', 'file:///etc/passwd', 'mailto:a@b.c', 'javascript:alert(1)']) {
    assert.equal(resolveAppOrigin(bad), null, `${bad} must not be a usable origin`)
  }
  // and such a value degrades to a safe relative redirect, never a throw
  const res = handleAccountingCallback(hostileRequest('error=cancelled'), deps({ appUrl: 'data:text/html,x' }))
  return res.then((r) => {
    assert.equal(r.status, 307)
    assert.match(location(r), /^\/sync/)
  })
})
