import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CRON_RATE_LIMIT_MAX,
  CRON_RATE_LIMIT_WINDOW_MS,
  cronRateLimitKey,
  enforceCronRateLimit,
} from '@/lib/cron-rate-limit'

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
