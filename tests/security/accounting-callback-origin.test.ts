import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveAppOrigin } from '@/app/api/accounting/callback/route'

// onetwo3d-ims-qye3 (CWE-601): the accounting OAuth callback must build its
// redirect origin ONLY from the trusted, server-configured app URL — never from
// the attacker-controlled Host / X-Forwarded-Host headers. Regression coverage
// for the externally-confirmed open redirect (X-Forwarded-Host: attacker →
// 307 to https://attacker).

const CONFIGURED = 'https://ims.example.com'

/** A callback request whose forwarded-host headers claim an attacker origin. */
const hostileRequest = () =>
  new Request(`${CONFIGURED}/api/accounting/callback?error=cancelled`, {
    headers: {
      host: 'attacker.example',
      'x-forwarded-host': 'attacker.example',
      'x-forwarded-proto': 'https',
    },
  })

test('configured app URL wins — a hostile forwarded host cannot change the origin', () => {
  assert.equal(resolveAppOrigin(hostileRequest(), CONFIGURED), CONFIGURED)
  // even if the configured URL carries a path/query, only its origin is used
  assert.equal(resolveAppOrigin(hostileRequest(), `${CONFIGURED}/sync?x=1`), CONFIGURED)
})

test('with NO configured app URL, the origin is the request URL — still NOT the forwarded host', () => {
  // Falls back to the request's own URL origin; the x-forwarded-host header is
  // never consulted, so the attacker host still cannot appear.
  const origin = resolveAppOrigin(hostileRequest(), null)
  assert.equal(origin, CONFIGURED)
  assert.doesNotMatch(origin, /attacker/)
})

test('a malformed configured app URL falls back safely to the request origin (not the forwarded host)', () => {
  const origin = resolveAppOrigin(hostileRequest(), 'not a url')
  assert.equal(origin, CONFIGURED)
  assert.doesNotMatch(origin, /attacker/)
})

test('a legitimate callback on the configured origin resolves to that origin (valid Xero/QBO flow)', () => {
  const req = new Request(`${CONFIGURED}/api/accounting/callback?code=abc&state=xyz&realmId=123`)
  assert.equal(resolveAppOrigin(req, CONFIGURED), CONFIGURED)
})
