import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertProductionCronSecretConfigured,
  verifyCron,
} from '../../lib/cron-auth.ts'

type CronEnv = {
  CRON_SECRET?: string
  NODE_ENV?: string
}

const ENV_KEYS = ['CRON_SECRET', 'NODE_ENV'] as const

async function withCronEnv(env: CronEnv, fn: () => Promise<void>): Promise<void> {
  const mutableEnv = process.env as Record<string, string | undefined>
  const previous = Object.fromEntries(
    ENV_KEYS.map((key) => [key, mutableEnv[key]]),
  ) as Record<(typeof ENV_KEYS)[number], string | undefined>

  try {
    for (const key of ENV_KEYS) {
      if (env[key] === undefined) {
        delete mutableEnv[key]
      } else {
        mutableEnv[key] = env[key]
      }
    }

    await fn()
  } finally {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) {
        delete mutableEnv[key]
      } else {
        mutableEnv[key] = previous[key]
      }
    }
  }
}

function cronRequest(host: string, authorization?: string): Request {
  const headers = new Headers({ host })
  if (authorization) headers.set('authorization', authorization)

  return new Request(`http://${host}/api/cron/fx-rates`, { headers })
}

function cronRequestWithoutHostHeader(url: string): Request {
  return new Request(url)
}

test('production boot fails fast when cron secret is unset or blank', () => {
  assert.throws(
    () => assertProductionCronSecretConfigured({ NODE_ENV: 'production', CRON_SECRET: undefined }),
    /CRON_SECRET is required in production/,
  )
  assert.throws(
    () => assertProductionCronSecretConfigured({ NODE_ENV: 'production', CRON_SECRET: '' }),
    /CRON_SECRET is required in production/,
  )
  assert.throws(
    () => assertProductionCronSecretConfigured({ NODE_ENV: 'production', CRON_SECRET: '   ' }),
    /CRON_SECRET is required in production/,
  )
})

test('cron secret boot guard allows non-production localhost development', () => {
  assert.doesNotThrow(() => assertProductionCronSecretConfigured({ NODE_ENV: 'test', CRON_SECRET: undefined }))
  assert.doesNotThrow(() => assertProductionCronSecretConfigured({ NODE_ENV: 'development', CRON_SECRET: '' }))
})

test('cron secret boot guard accepts configured production secret', () => {
  assert.doesNotThrow(() => assertProductionCronSecretConfigured({ NODE_ENV: 'production', CRON_SECRET: 'secret-token' }))
})

test('valid cron secret is accepted', async () => {
  await withCronEnv({ CRON_SECRET: 'secret-token', NODE_ENV: 'production' }, async () => {
    const response = await verifyCron(cronRequest('ims.example.com', 'Bearer secret-token'))

    assert.equal(response, null)
  })
})

test('invalid cron secret is rejected', async () => {
  await withCronEnv({ CRON_SECRET: 'secret-token', NODE_ENV: 'production' }, async () => {
    const response = await verifyCron(cronRequest('ims.example.com', 'Bearer wrong-token'))

    assert.equal(response?.status, 401)
  })
})

test('configured cron secret is required for localhost requests outside production', async () => {
  await withCronEnv({ CRON_SECRET: 'secret-token', NODE_ENV: 'test' }, async () => {
    const response = await verifyCron(cronRequest('localhost:3000'))

    assert.equal(response?.status, 401)
  })
})

test('localhost cron request is accepted outside production', async () => {
  await withCronEnv({ NODE_ENV: 'test' }, async () => {
    const response = await verifyCron(cronRequest('localhost:3000'))

    assert.equal(response, null)
  })
})

test('localhost cron request is rejected in production by default', async () => {
  await withCronEnv({ NODE_ENV: 'production' }, async () => {
    const response = await verifyCron(cronRequest('localhost:3000'))

    assert.equal(response?.status, 401)
  })
})

test('localhost detection accepts case-insensitive hostnames with ports', async () => {
  await withCronEnv({ NODE_ENV: 'test' }, async () => {
    const response = await verifyCron(cronRequest('LOCALHOST:3000'))

    assert.equal(response, null)
  })
})

test('localhost detection accepts IPv6 loopback hosts', async () => {
  await withCronEnv({ NODE_ENV: 'test' }, async () => {
    const response = await verifyCron(cronRequest('[::1]:3000'))

    assert.equal(response, null)
  })
})

test('localhost detection falls back to request URL when host header is absent', async () => {
  await withCronEnv({ NODE_ENV: 'test' }, async () => {
    const response = await verifyCron(
      cronRequestWithoutHostHeader('http://127.0.0.1:3000/api/cron/fx-rates'),
    )

    assert.equal(response, null)
  })
})
