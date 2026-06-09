import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CRON_RATE_LIMIT_FIVE_MINUTE_MAX,
  CRON_RATE_LIMIT_MAX,
  CRON_RATE_LIMIT_WINDOW_MS,
  cronRateLimitKey,
  enforceCronRateLimit,
} from '@/lib/cron-rate-limit'
import { MemoryRateLimitBackend } from '@/lib/security/rate-limit-memory'

test('cron rate-limit helper uses per-job hourly keys', async () => {
  const calls: Array<{ key: string; max: number; windowMs: number }> = []
  const response = await enforceCronRateLimit('inventory-snapshot', async (key, max, windowMs) => {
    calls.push({ key, max, windowMs })
    return { allowed: true, retryAfterSec: 0, remaining: 0 }
  })

  assert.equal(response, null)
  assert.deepEqual(calls, [{
    key: cronRateLimitKey('inventory-snapshot'),
    max: CRON_RATE_LIMIT_MAX,
    windowMs: CRON_RATE_LIMIT_WINDOW_MS,
  }])
})

test('cron rate-limit helper scopes quotas by verified source IP when available', async () => {
  const calls: Array<{ key: string; max: number; windowMs: number }> = []
  const request = new Request('https://ims.example.com/api/cron/backup', {
    headers: { 'x-real-ip': '203.0.113.9' },
  })
  const response = await enforceCronRateLimit('backup', {
    request,
    checker: async (key, max, windowMs) => {
      calls.push({ key, max, windowMs })
      return { allowed: true, retryAfterSec: 0, remaining: 0 }
    },
  })

  assert.equal(response, null)
  assert.equal(calls[0]?.key, cronRateLimitKey('backup', '203.0.113.9'))
})

test('cron rate-limit helper returns 429 with retry metadata when quota is consumed', async () => {
  const response = await enforceCronRateLimit('backup', async () => ({
    allowed: false,
    retryAfterSec: 123,
    remaining: 0,
  }))

  assert.ok(response)
  assert.equal(response.status, 429)
  assert.equal(response.headers.get('Retry-After'), '123')
  assert.deepEqual(await response.json(), {
    error: 'Cron job rate limited',
    jobName: 'backup',
    retryAfterSec: 123,
  })
})

test('five-minute cron quota keeps jitter headroom beyond exact twelve-per-hour cadence', async () => {
  let now = Date.UTC(2026, 5, 9, 12, 0, 0)
  const backend = new MemoryRateLimitBackend(() => now)

  for (let index = 0; index < 12; index += 1) {
    const result = await backend.check(
      cronRateLimitKey('shopping-webhook-inbox', '203.0.113.10'),
      CRON_RATE_LIMIT_FIVE_MINUTE_MAX,
      CRON_RATE_LIMIT_WINDOW_MS,
    )
    assert.equal(result.allowed, true, `expected scheduled run ${index + 1} to be allowed`)
    now += 5_000
  }

  const jitteredFollowUp = await backend.check(
    cronRateLimitKey('shopping-webhook-inbox', '203.0.113.10'),
    CRON_RATE_LIMIT_FIVE_MINUTE_MAX,
    CRON_RATE_LIMIT_WINDOW_MS,
  )
  assert.equal(jitteredFollowUp.allowed, true)
})
