import assert from 'node:assert/strict'
import test from 'node:test'
import { validateMintsoftBaseUrl } from '../../lib/connectors/mintsoft/api/auth.ts'
import { validateExternalBaseUrl } from '../../lib/security/external-url-safety.ts'

test('external URL safety requires https for public connector URLs', () => {
  assert.deepEqual(validateExternalBaseUrl('store.example.test', { connectorName: 'Connector' }), {
    ok: false,
    error: 'Connector URL is invalid.',
  })

  assert.deepEqual(validateExternalBaseUrl('http://store.example.test', { connectorName: 'Connector' }), {
    ok: false,
    error: 'Connector URL must use https.',
  })

  assert.deepEqual(validateExternalBaseUrl('https://store.example.test/', { connectorName: 'Connector' }), {
    ok: true,
    normalizedUrl: 'https://store.example.test',
  })
})

test('external URL safety blocks localhost, private, link-local, and metadata targets', () => {
  const blockedUrls = [
    ['https://localhost:8443', 'Connector URL cannot target localhost.'],
    ['https://api.localhost', 'Connector URL cannot target localhost.'],
    ['https://127.0.0.1:8443', 'Connector URL cannot target loopback, link-local, private, or metadata network addresses.'],
    ['https://2130706433', 'Connector URL cannot target loopback, link-local, private, or metadata network addresses.'],
    ['https://0x7f000001', 'Connector URL cannot target loopback, link-local, private, or metadata network addresses.'],
    ['https://017700000001', 'Connector URL cannot target loopback, link-local, private, or metadata network addresses.'],
    ['https://127.1', 'Connector URL cannot target loopback, link-local, private, or metadata network addresses.'],
    ['https://127.0.1', 'Connector URL cannot target loopback, link-local, private, or metadata network addresses.'],
    ['https://10.0.0.5', 'Connector URL cannot target loopback, link-local, private, or metadata network addresses.'],
    ['https://172.16.1.5', 'Connector URL cannot target loopback, link-local, private, or metadata network addresses.'],
    ['https://192.168.1.5', 'Connector URL cannot target loopback, link-local, private, or metadata network addresses.'],
    ['https://169.254.169.254', 'Connector URL cannot target loopback, link-local, private, or metadata network addresses.'],
    ['https://[::1]', 'Connector URL cannot target loopback, link-local, private, or metadata network addresses.'],
    ['https://[0::1]', 'Connector URL cannot target loopback, link-local, private, or metadata network addresses.'],
    ['https://[0000:0000:0000:0000:0000:0000:0000:0001]', 'Connector URL cannot target loopback, link-local, private, or metadata network addresses.'],
    ['https://[::ffff:127.0.0.1]', 'Connector URL cannot target loopback, link-local, private, or metadata network addresses.'],
    ['https://[fd00:ec2::254]', 'Connector URL cannot target loopback, link-local, private, or metadata network addresses.'],
    ['https://metadata.google.internal', 'Connector URL cannot target loopback, link-local, private, or metadata network addresses.'],
  ] as const

  for (const [url, error] of blockedUrls) {
    assert.deepEqual(validateExternalBaseUrl(url, { connectorName: 'Connector' }), {
      ok: false,
      error,
    }, url)
  }
})

test('external URL safety allows configured private IP addresses only when allowlisted', () => {
  assert.deepEqual(
    validateExternalBaseUrl('https://10.0.0.5', {
      connectorName: 'Connector',
      env: { CONNECTOR_PRIVATE_IP_ALLOWLIST: '10.0.0.5' },
    }),
    { ok: true, normalizedUrl: 'https://10.0.0.5' },
  )

  assert.deepEqual(
    validateExternalBaseUrl('https://10.0.0.6', {
      connectorName: 'Connector',
      env: { CONNECTOR_PRIVATE_IP_ALLOWLIST: '10.0.0.5' },
    }),
    {
      ok: false,
      error: 'Connector URL cannot target loopback, link-local, private, or metadata network addresses.',
    },
  )

  assert.deepEqual(
    validateExternalBaseUrl('https://192.168.10.25', {
      connectorName: 'Connector',
      env: { CONNECTOR_PRIVATE_IP_ALLOWLIST: '192.168.10.0/24' },
    }),
    { ok: true, normalizedUrl: 'https://192.168.10.25' },
  )

  assert.deepEqual(
    validateExternalBaseUrl('https://127.0.0.1', {
      connectorName: 'Connector',
      env: { CONNECTOR_PRIVATE_IP_ALLOWLIST: '127.0.0.1' },
    }),
    {
      ok: false,
      error: 'Connector URL cannot target loopback, link-local, private, or metadata network addresses.',
    },
  )
})

test('external URL safety allows loopback http only in e2e mode', () => {
  assert.deepEqual(
    validateExternalBaseUrl('http://127.0.0.1:3000/api/e2e/mintsoft', {
      connectorName: 'Connector',
      allowE2eLocalHttp: true,
      env: { E2E_TEST_MODE: undefined },
    }),
    {
      ok: false,
      error: 'Connector URL must use https.',
    },
  )

  assert.deepEqual(
    validateExternalBaseUrl('http://127.0.0.1:3000/api/e2e/mintsoft', {
      connectorName: 'Connector',
      allowE2eLocalHttp: true,
      env: { E2E_TEST_MODE: '1' },
    }),
    {
      ok: true,
      normalizedUrl: 'http://127.0.0.1:3000/api/e2e/mintsoft',
    },
  )

  assert.deepEqual(
    validateExternalBaseUrl('http://10.0.0.5:3000', {
      connectorName: 'Connector',
      allowE2eLocalHttp: true,
      env: { E2E_TEST_MODE: '1' },
    }),
    {
      ok: false,
      error: 'Connector URL must use https.',
    },
  )

  assert.deepEqual(
    validateExternalBaseUrl('http://127.0.0.1:3000', {
      connectorName: 'Connector',
      allowE2eLocalHttp: true,
      env: { E2E_TEST_MODE: '1', NODE_ENV: 'production' },
    }),
    {
      ok: false,
      error: 'Connector URL must use https.',
    },
  )
})

test('external URL safety rejects credentials, query strings, fragments, and unsupported protocols', () => {
  assert.deepEqual(validateExternalBaseUrl('https://user:pass@store.example.test', { connectorName: 'Connector' }), {
    ok: false,
    error: 'Connector URL must not include credentials, query, or fragment.',
  })
  assert.deepEqual(validateExternalBaseUrl('https://store.example.test?target=https://example.net', { connectorName: 'Connector' }), {
    ok: false,
    error: 'Connector URL must not include credentials, query, or fragment.',
  })
  assert.deepEqual(validateExternalBaseUrl('file:///etc/passwd', { connectorName: 'Connector' }), {
    ok: false,
    error: 'Connector URL must use https.',
  })
})

test('Mintsoft URL safety defaults missing protocols to https and preserves e2e path URLs', () => {
  const original = process.env.E2E_TEST_MODE
  try {
    delete process.env.E2E_TEST_MODE
    assert.deepEqual(validateMintsoftBaseUrl('api.mintsoft.example'), {
      ok: true,
      normalizedUrl: 'https://api.mintsoft.example',
    })
    assert.deepEqual(validateMintsoftBaseUrl('http://127.0.0.1:3000/api/e2e/mintsoft'), {
      ok: false,
      error: 'Mintsoft URL must use https.',
    })

    process.env.E2E_TEST_MODE = '1'
    assert.deepEqual(validateMintsoftBaseUrl('http://127.0.0.1:3000/api/e2e/mintsoft'), {
      ok: true,
      normalizedUrl: 'http://127.0.0.1:3000/api/e2e/mintsoft',
    })
  } finally {
    if (original == null) {
      delete process.env.E2E_TEST_MODE
    } else {
      process.env.E2E_TEST_MODE = original
    }
  }
})
