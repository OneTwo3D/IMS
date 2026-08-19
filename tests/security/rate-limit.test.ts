import assert from 'node:assert/strict'
import test from 'node:test'

import { RedisRateLimitBackend, redisConnectionOptions, redisRateLimitKey } from '@/lib/security/rate-limit-redis'
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

test('checkRateLimit fails open by default but denies when failClosed is set', async () => {
  const previousBackend = process.env.RATE_LIMIT_BACKEND
  const previousRedisUrl = process.env.REDIS_URL
  // redis backend without REDIS_URL makes backend creation throw, exercising
  // the catch path in checkRateLimit.
  process.env.RATE_LIMIT_BACKEND = 'redis'
  delete process.env.REDIS_URL
  resetRateLimitBackendForTests()

  try {
    const key = `test:${Date.now()}:fail-mode`

    const open = await checkRateLimit(key, 5, 60_000)
    assert.equal(open.allowed, true)

    const closed = await checkRateLimit(key, 5, 60_000, { failClosed: true })
    assert.equal(closed.allowed, false)
    assert.equal(closed.remaining, 0)
    assert.ok(closed.retryAfterSec > 0)
  } finally {
    if (previousBackend === undefined) delete process.env.RATE_LIMIT_BACKEND
    else process.env.RATE_LIMIT_BACKEND = previousBackend
    if (previousRedisUrl === undefined) delete process.env.REDIS_URL
    else process.env.REDIS_URL = previousRedisUrl
    resetRateLimitBackendForTests()
  }
})

function makeFakeAtomicRedisRunner() {
  const buckets = new Map<string, Array<{ score: number; member: string }>>()
  const evalCommands: string[][] = []
  const allCommands: string[][] = []

  return {
    evalCommands,
    allCommands,
    async runner(commands: string[][]) {
      return commands.map((command) => {
        allCommands.push(command)
        if (command[0] === 'DEL') {
          buckets.delete(command[1] ?? '')
          return 1
        }

        if (command[0] !== 'EVAL') throw new Error(`Unexpected Redis command ${command[0]}`)
        evalCommands.push(command)

        const key = command[3] ?? ''
        const cutoff = Number(command[4])
        const max = Number(command[5])
        const now = Number(command[6])
        const member = command[7] ?? ''
        const windowMs = Number(command[8])
        const live = (buckets.get(key) ?? []).filter((entry) => entry.score > cutoff)

        if (live.length >= max) {
          const oldest = live[0]?.score ?? now
          buckets.set(key, live)
          return [0, live.length, Math.max(1, oldest + windowMs - now)]
        }

        live.push({ score: now, member })
        live.sort((a, b) => a.score - b.score || a.member.localeCompare(b.member))
        buckets.set(key, live)
        return [1, live.length, 0]
      })
    },
  }
}

test('redis rate limiter uses one atomic script for check and record', async () => {
  const { runner, evalCommands } = makeFakeAtomicRedisRunner()
  const backend = new RedisRateLimitBackend('redis://example.test:6379/0', runner)

  assert.deepEqual(await backend.check('login:redis', 2, 10_000), {
    allowed: true,
    retryAfterSec: 0,
    remaining: 1,
  })
  assert.deepEqual(await backend.check('login:redis', 2, 10_000), {
    allowed: true,
    retryAfterSec: 0,
    remaining: 0,
  })
  const locked = await backend.check('login:redis', 2, 10_000)
  assert.equal(locked.allowed, false)
  assert.equal(locked.remaining, 0)
  assert.ok(locked.retryAfterSec >= 1)
  assert.equal(evalCommands.length, 3)
  assert.ok(evalCommands.every((command) => command[0] === 'EVAL'))
})

test('redis rate limiter preserves atomic limit under concurrent calls and supports clear', async () => {
  const { runner } = makeFakeAtomicRedisRunner()
  const backend = new RedisRateLimitBackend('redis://example.test:6379/0', runner)

  const results = await Promise.all(
    Array.from({ length: 8 }, () => backend.check('totp:redis', 3, 10_000)),
  )
  assert.equal(results.filter((result) => result.allowed).length, 3)
  assert.equal(results.filter((result) => !result.allowed).length, 5)

  await backend.clear('totp:redis')
  assert.equal((await backend.check('totp:redis', 3, 10_000)).allowed, true)
})

// o3d-esha item 5: REDIS_KEY_PREFIX was prompted for by install.sh, defaulted to
// the tenant slug by provision-ims-tenant.sh and printed in its summary, while
// every Redis key was hardcoded to `rate-limit:`. Two tenants on one Redis
// therefore shared rate-limit buckets under a namespace that did not exist.
test('redis rate limiter namespaces keys with the configured key prefix', async () => {
  const { runner, evalCommands, allCommands } = makeFakeAtomicRedisRunner()
  const backend = new RedisRateLimitBackend('redis://example.test:6379/0', runner, {
    keyPrefix: 'tenant-acme',
  })

  await backend.check('login:redis', 2, 10_000)
  await backend.clear('login:redis')

  assert.equal(evalCommands[0]?.[3], 'tenant-acme:rate-limit:login:redis')
  // clear() must namespace too, or a reset wipes another tenant's bucket.
  assert.deepEqual(allCommands.at(-1), ['DEL', 'tenant-acme:rate-limit:login:redis'])
  assert.equal(redisRateLimitKey('login:redis', 'tenant-acme'), 'tenant-acme:rate-limit:login:redis')
  // Unprefixed installs must keep the existing keyspace, or an upgrade silently
  // resets every in-flight lockout.
  assert.equal(redisRateLimitKey('login:redis'), 'rate-limit:login:redis')
  assert.equal(redisRateLimitKey('login:redis', '   '), 'rate-limit:login:redis')
})

test('two key prefixes produce disjoint buckets for the same logical key', async () => {
  const { runner, evalCommands } = makeFakeAtomicRedisRunner()
  const acme = new RedisRateLimitBackend('redis://example.test:6379/0', runner, { keyPrefix: 'acme' })
  const beta = new RedisRateLimitBackend('redis://example.test:6379/0', runner, { keyPrefix: 'beta' })

  // max 1: without namespacing the second tenant's first attempt would be
  // rejected by the first tenant's bucket.
  assert.equal((await acme.check('login:shared', 1, 10_000)).allowed, true)
  assert.equal((await beta.check('login:shared', 1, 10_000)).allowed, true)
  assert.equal(evalCommands[0]?.[3], 'acme:rate-limit:login:shared')
  assert.equal(evalCommands[1]?.[3], 'beta:rate-limit:login:shared')
})

// o3d-esha item 6: install.sh:445 writes `requirepass` into redis.conf but
// install.sh:277 builds REDIS_URL with no credentials, so the prompted password
// never reached AUTH and a redis-backed install would fail NOAUTH.
test('redis connection falls back to the standalone password, and an inline URL password still wins', () => {
  assert.equal(
    redisConnectionOptions('redis://example.test:6379/0', 'from-redis-password').password,
    'from-redis-password',
  )
  assert.equal(
    redisConnectionOptions('redis://:from-url@example.test:6379/0', 'from-redis-password').password,
    'from-url',
  )
  assert.equal(redisConnectionOptions('redis://example.test:6379/0').password, '')
})
