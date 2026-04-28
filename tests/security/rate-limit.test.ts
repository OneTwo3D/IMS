import assert from 'node:assert/strict'
import test from 'node:test'

import { MemoryRateLimitBackend } from '@/lib/security/rate-limit-memory'
import {
  checkRateLimit,
  clearRateLimit,
  getConfiguredRateLimitBackendName,
  resetRateLimitBackendForTests,
} from '@/lib/security/rate-limit'

test('memory rate limiter locks out, reports retry, and resets after clear', async () => {
  let now = 1_000
  const backend = new MemoryRateLimitBackend(() => now)

  assert.deepEqual(await backend.check('login:test', 2, 10_000), {
    allowed: true,
    retryAfterSec: 0,
    remaining: 1,
  })
  assert.deepEqual(await backend.check('login:test', 2, 10_000), {
    allowed: true,
    retryAfterSec: 0,
    remaining: 0,
  })

  const locked = await backend.check('login:test', 2, 10_000)
  assert.equal(locked.allowed, false)
  assert.equal(locked.remaining, 0)
  assert.equal(locked.retryAfterSec, 10)

  await backend.clear('login:test')
  assert.equal((await backend.check('login:test', 2, 10_000)).allowed, true)

  now += 10_001
  assert.equal((await backend.check('login:test', 2, 10_000)).allowed, true)
})

test('rate-limit backend selection defaults to memory and accepts redis', () => {
  assert.equal(getConfiguredRateLimitBackendName({}), 'memory')
  assert.equal(getConfiguredRateLimitBackendName({ RATE_LIMIT_BACKEND: '' }), 'memory')
  assert.equal(getConfiguredRateLimitBackendName({ RATE_LIMIT_BACKEND: 'memory' }), 'memory')
  assert.equal(getConfiguredRateLimitBackendName({ RATE_LIMIT_BACKEND: ' redis ' }), 'redis')
  assert.throws(
    () => getConfiguredRateLimitBackendName({ RATE_LIMIT_BACKEND: 'postgres' }),
    /Unsupported RATE_LIMIT_BACKEND/,
  )
})

test('shared rate-limit wrapper uses memory backend by default', async () => {
  const previousBackend = process.env.RATE_LIMIT_BACKEND
  const previousRedisUrl = process.env.REDIS_URL
  delete process.env.RATE_LIMIT_BACKEND
  delete process.env.REDIS_URL
  resetRateLimitBackendForTests()

  try {
    const key = `test:${Date.now()}:default-memory`
    assert.equal((await checkRateLimit(key, 1, 60_000)).allowed, true)
    assert.equal((await checkRateLimit(key, 1, 60_000)).allowed, false)
    await clearRateLimit(key)
    assert.equal((await checkRateLimit(key, 1, 60_000)).allowed, true)
  } finally {
    if (previousBackend === undefined) delete process.env.RATE_LIMIT_BACKEND
    else process.env.RATE_LIMIT_BACKEND = previousBackend
    if (previousRedisUrl === undefined) delete process.env.REDIS_URL
    else process.env.REDIS_URL = previousRedisUrl
    resetRateLimitBackendForTests()
  }
})
