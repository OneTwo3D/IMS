import assert from 'node:assert/strict'
import test from 'node:test'

import nextConfig from '../../next.config'

// onetwo3d-ims-kgp6: the baseline security headers must be declared and applied
// to every route, the framework version must not be advertised, and the full CSP
// must NOT be a static header here (it is built per-request with a nonce in the
// middleware — see lib/security/csp.ts).

test('next.config declares the baseline security headers for all routes', async () => {
  assert.equal(typeof nextConfig.headers, 'function')
  const rules = await nextConfig.headers!()
  const catchAll = rules.find((r) => r.source === '/:path*')
  assert.ok(catchAll, 'expected a catch-all /:path* header rule')

  const byKey = new Map(catchAll.headers.map((h) => [h.key.toLowerCase(), h.value]))
  assert.equal(byKey.get('x-frame-options'), 'DENY')
  assert.equal(byKey.get('x-content-type-options'), 'nosniff')
  assert.ok(byKey.get('referrer-policy'))
  assert.ok((byKey.get('strict-transport-security') ?? '').includes('max-age='))
  assert.ok(byKey.get('permissions-policy'))
})

test('next.config disables the X-Powered-By header', () => {
  assert.equal(nextConfig.poweredByHeader, false)
})

test('next.config does NOT set a static Content-Security-Policy (nonce CSP is in middleware)', async () => {
  const rules = await nextConfig.headers!()
  for (const rule of rules) {
    for (const header of rule.headers) {
      assert.notEqual(
        header.key.toLowerCase(),
        'content-security-policy',
        'CSP must be built per-request in proxy.ts, not as a static next.config header',
      )
    }
  }
})
