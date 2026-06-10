import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildIntegrationConnectionFingerprint,
  evaluateIntegrationConnectionTestGate,
  getIntegrationConnectionTestState,
  integrationConnectionFingerprintSecret,
  recordIntegrationConnectionTest,
} from '../../../lib/integration-connection-test-gate.ts'

test('integration connection fingerprints are stable for object key order', () => {
  const left = buildIntegrationConnectionFingerprint({
    url: 'https://store.example.test',
    credentials: { key: 'ck_test', secret: 'cs_test' },
  })
  const right = buildIntegrationConnectionFingerprint({
    credentials: { secret: 'cs_test', key: 'ck_test' },
    url: 'https://store.example.test',
  })

  assert.equal(left, right)
})

test('integration connection fingerprints normalize absent values consistently', () => {
  assert.equal(
    buildIntegrationConnectionFingerprint({ host: undefined, port: null, user: '' }),
    buildIntegrationConnectionFingerprint({}),
  )
})

test('integration connection secrets are HMACed with the server key before fingerprinting', () => {
  const previousKey = process.env.INTEGRATION_CONNECTION_FINGERPRINT_KEY
  try {
    process.env.INTEGRATION_CONNECTION_FINGERPRINT_KEY = 'fingerprint-key-one'
    const first = buildIntegrationConnectionFingerprint({
      host: 'smtp.example.test',
      pass: integrationConnectionFingerprintSecret('human-password'),
    })
    process.env.INTEGRATION_CONNECTION_FINGERPRINT_KEY = 'fingerprint-key-two'
    const second = buildIntegrationConnectionFingerprint({
      host: 'smtp.example.test',
      pass: integrationConnectionFingerprintSecret('human-password'),
    })
    const rawSecretHash = buildIntegrationConnectionFingerprint({
      host: 'smtp.example.test',
      pass: 'human-password',
    })

    assert.notEqual(first, second)
    assert.notEqual(first, rawSecretHash)
  } finally {
    if (previousKey === undefined) {
      delete process.env.INTEGRATION_CONNECTION_FINGERPRINT_KEY
    } else {
      process.env.INTEGRATION_CONNECTION_FINGERPRINT_KEY = previousKey
    }
  }
})

test('connection test gate rejects missing, failed, and stale test results', () => {
  const expectedFingerprint = buildIntegrationConnectionFingerprint({ url: 'https://store.example.test' })
  const staleFingerprint = buildIntegrationConnectionFingerprint({ url: 'https://old.example.test' })

  assert.deepEqual(
    evaluateIntegrationConnectionTestGate({
      label: 'WooCommerce',
      expectedFingerprint,
      state: { status: 'never', testedAt: null, message: '', fingerprint: null },
    }),
    { ok: false, error: 'Test the WooCommerce connection successfully before enabling it.' },
  )

  assert.deepEqual(
    evaluateIntegrationConnectionTestGate({
      label: 'WooCommerce',
      expectedFingerprint,
      state: { status: 'failed', testedAt: '2026-06-10T00:00:00.000Z', message: 'bad credentials', fingerprint: expectedFingerprint },
    }),
    { ok: false, error: 'Test the WooCommerce connection successfully before enabling it.' },
  )

  assert.deepEqual(
    evaluateIntegrationConnectionTestGate({
      label: 'WooCommerce',
      expectedFingerprint,
      state: { status: 'success', testedAt: '2026-06-10T00:00:00.000Z', message: 'ok', fingerprint: staleFingerprint },
    }),
    { ok: false, error: 'Retest the WooCommerce connection because the saved connection settings changed.' },
  )
})

test('connection test gate accepts a successful result for the current fingerprint', () => {
  const expectedFingerprint = buildIntegrationConnectionFingerprint({ tenantId: 'tenant-1' })

  assert.deepEqual(
    evaluateIntegrationConnectionTestGate({
      label: 'Xero',
      expectedFingerprint,
      state: { status: 'success', testedAt: '2026-06-10T00:00:00.000Z', message: 'ok', fingerprint: expectedFingerprint },
    }),
    { ok: true },
  )
})

test('connection test records persist through the settings repository contract', async () => {
  const rows = new Map<string, string>()
  const repository = {
    async findMany(args: { where: { key: { in: string[] } } }) {
      return args.where.key.in
        .filter((key) => rows.has(key))
        .map((key) => ({ key, value: rows.get(key)! }))
    },
    async upsert(args: { where: { key: string }; create: { key: string; value: string }; update: { value: string } }) {
      rows.set(args.where.key, rows.has(args.where.key) ? args.update.value : args.create.value)
      return null
    },
  }

  const fingerprint = buildIntegrationConnectionFingerprint({ host: 'smtp.example.test', user: 'mailer' })
  await recordIntegrationConnectionTest('smtp', {
    success: true,
    fingerprint,
    message: 'SMTP test email sent.',
    testedAt: new Date('2026-06-10T12:00:00.000Z'),
  }, repository)

  assert.deepEqual(await getIntegrationConnectionTestState('smtp', repository), {
    status: 'success',
    testedAt: '2026-06-10T12:00:00.000Z',
    message: 'SMTP test email sent.',
    fingerprint,
  })
})

test('connection test records roll back when one setting write fails inside a transaction', async () => {
  let rows = new Map<string, string>([
    ['woocommerce_connection_test_status', 'failed'],
    ['woocommerce_connection_test_tested_at', '2026-06-10T11:00:00.000Z'],
    ['woocommerce_connection_test_message', 'old failure'],
    ['woocommerce_connection_test_fingerprint', 'old-fingerprint'],
  ])
  const repository = {
    async upsert(args: { where: { key: string }; create: { key: string; value: string }; update: { value: string } }) {
      if (args.where.key === 'woocommerce_connection_test_message') {
        throw new Error('simulated write failure')
      }
      rows.set(args.where.key, rows.has(args.where.key) ? args.update.value : args.create.value)
      return null
    },
    async transaction(operations: Array<() => Promise<unknown>>) {
      const snapshot = new Map(rows)
      try {
        for (const operation of operations) await operation()
      } catch (error) {
        rows = snapshot
        throw error
      }
    },
  }

  await assert.rejects(
    () => recordIntegrationConnectionTest('woocommerce', {
      success: true,
      fingerprint: 'new-fingerprint',
      message: 'new success',
      testedAt: new Date('2026-06-10T12:00:00.000Z'),
    }, repository),
    /simulated write failure/,
  )

  assert.deepEqual(Object.fromEntries(rows), {
    woocommerce_connection_test_status: 'failed',
    woocommerce_connection_test_tested_at: '2026-06-10T11:00:00.000Z',
    woocommerce_connection_test_message: 'old failure',
    woocommerce_connection_test_fingerprint: 'old-fingerprint',
  })
})
