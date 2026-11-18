import assert from 'node:assert/strict'
import test from 'node:test'

import { getClientIp, isTrustedProxyConfigured } from '../../lib/request-ip.ts'
import { withEnvPatch } from '../helpers/env.ts'

const NONE = { TRUSTED_PROXY_IPS: undefined, TRUSTED_PROXY_CIDRS: undefined, LEGACY_UNTRUSTED_FORWARDED_FOR: undefined }

function headers(init: Record<string, string>): Headers {
  return new Headers(init)
}

test('without trusted-proxy config a client-supplied X-Forwarded-For / X-Real-IP is ignored', async () => {
  await withEnvPatch(NONE, () => {
    assert.equal(isTrustedProxyConfigured(), false)
    assert.equal(getClientIp(headers({ 'x-forwarded-for': '203.0.113.9' })), null)
    assert.equal(getClientIp(headers({ 'x-real-ip': '203.0.113.9' })), null)
  })
})

test('with trusted proxies the right-most untrusted entry is the client (spoofed left entries ignored)', async () => {
  await withEnvPatch({ ...NONE, TRUSTED_PROXY_IPS: '10.0.3.12' }, () => {
    assert.equal(isTrustedProxyConfigured(), true)
    assert.equal(getClientIp(headers({ 'x-forwarded-for': '1.1.1.1, 198.51.100.7, 10.0.3.12' })), '198.51.100.7')
  })
})

test('CIDR config is honoured and re-read when the env changes', async () => {
  await withEnvPatch({ ...NONE, TRUSTED_PROXY_CIDRS: '10.0.0.0/8' }, () => {
    assert.equal(getClientIp(headers({ 'x-forwarded-for': '198.51.100.7, 10.1.2.3' })), '198.51.100.7')
  })
  await withEnvPatch(NONE, () => {
    assert.equal(getClientIp(headers({ 'x-forwarded-for': '198.51.100.7, 10.1.2.3' })), null)
  })
})

test('LEGACY_UNTRUSTED_FORWARDED_FOR=true restores the old right-most behaviour for unconfigured proxies', async () => {
  await withEnvPatch({ ...NONE, LEGACY_UNTRUSTED_FORWARDED_FOR: 'true' }, () => {
    assert.equal(getClientIp(headers({ 'x-forwarded-for': '203.0.113.9' })), '203.0.113.9')
  })
})
