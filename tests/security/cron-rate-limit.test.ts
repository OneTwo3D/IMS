import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyE2eMaxOverride,
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

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(vars)) prev[k] = process.env[k]
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    fn()
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

test('E2E override raises the allowlisted job max, but only when E2E_TEST_MODE=1', () => {
  const ALLOWED = 'accounting-daily-batch'
  // Guard off: no override applies even with a value set (production posture).
  withEnv({ E2E_TEST_MODE: undefined, E2E_CRON_RATE_LIMIT_MAX: '10000' }, () => {
    assert.equal(applyE2eMaxOverride(ALLOWED, 1), 1, 'E2E_TEST_MODE unset: never applies')
  })
  withEnv({ E2E_TEST_MODE: '0', E2E_CRON_RATE_LIMIT_MAX: '10000' }, () => {
    assert.equal(applyE2eMaxOverride(ALLOWED, 1), 1, 'E2E_TEST_MODE!=1: never applies')
  })
  // Guard on: raises the allowlisted job, raise-only, rejects junk.
  withEnv({ E2E_TEST_MODE: '1', E2E_CRON_RATE_LIMIT_MAX: '10000' }, () => {
    assert.equal(applyE2eMaxOverride(ALLOWED, 1), 10000, 'raises the default max')
  })
  withEnv({ E2E_TEST_MODE: '1', E2E_CRON_RATE_LIMIT_MAX: '3' }, () => {
    assert.equal(applyE2eMaxOverride(ALLOWED, 15), 15, 'below base: never lowers (raise-only)')
  })
  withEnv({ E2E_TEST_MODE: '1', E2E_CRON_RATE_LIMIT_MAX: undefined }, () => {
    assert.equal(applyE2eMaxOverride(ALLOWED, 1), 1, 'value unset: unchanged')
  })
  for (const bad of ['0', '-5', 'nope', '', '1.5e3nope']) {
    withEnv({ E2E_TEST_MODE: '1', E2E_CRON_RATE_LIMIT_MAX: bad }, () => {
      assert.equal(applyE2eMaxOverride(ALLOWED, 1), 1, `invalid/zero (${JSON.stringify(bad)}): unchanged`)
    })
  }
})

test('E2E override NEVER applies to a non-allowlisted job (blast-radius guard)', () => {
  // Even fully "armed", the override must not touch backup/archival/etc.
  withEnv({ E2E_TEST_MODE: '1', E2E_CRON_RATE_LIMIT_MAX: '10000' }, () => {
    for (const job of ['backup', 'accounting-sync', 'product-lifecycle-archive', 'email-outbox']) {
      assert.equal(applyE2eMaxOverride(job, 1), 1, `${job} must ignore the override`)
    }
  })
})

test('xero-tax-rate-drift is capped at its per-job ceiling — never inherits the full E2E max (shared Xero tenant quota)', () => {
  const DRIFT = 'xero-tax-rate-drift'
  const CAP = 20
  withEnv({ E2E_TEST_MODE: '1', E2E_CRON_RATE_LIMIT_MAX: '10000' }, () => {
    // A large E2E_CRON_RATE_LIMIT_MAX must NOT flow through to a job that hits a quota-limited external
    // dependency each run — it is bounded above by the per-job cap, so a leak/runaway can't exhaust the
    // shared Xero tenant.
    assert.equal(applyE2eMaxOverride(DRIFT, 1), CAP, 'capped at the per-job ceiling, not the 10000 global')
  })
  withEnv({ E2E_TEST_MODE: '1', E2E_CRON_RATE_LIMIT_MAX: '5' }, () => {
    // Below the cap, the override value itself wins (it is the min of the two).
    assert.equal(applyE2eMaxOverride(DRIFT, 1), 5, 'a value below the cap is honoured as-is')
  })
  withEnv({ E2E_TEST_MODE: '1', E2E_CRON_RATE_LIMIT_MAX: '10000' }, () => {
    // Raise-only still holds: a base max already above the cap is never lowered.
    assert.equal(applyE2eMaxOverride(DRIFT, 50), 50, 'a base max above the cap is never lowered (raise-only)')
  })
  withEnv({ E2E_TEST_MODE: undefined, E2E_CRON_RATE_LIMIT_MAX: '10000' }, () => {
    assert.equal(applyE2eMaxOverride(DRIFT, 1), 1, 'guard off: never applies')
  })
})

test('accounting-daily-batch has no per-job cap — honours the full E2E max', () => {
  withEnv({ E2E_TEST_MODE: '1', E2E_CRON_RATE_LIMIT_MAX: '10000' }, () => {
    assert.equal(applyE2eMaxOverride('accounting-daily-batch', 1), 10000, 'uncapped internal job uses the full value')
  })
})

test('enforceCronRateLimit passes the E2E-overridden max only for the allowlisted job', async () => {
  await withEnvAsync({ E2E_TEST_MODE: '1', E2E_CRON_RATE_LIMIT_MAX: '5000' }, async () => {
    const seen: Record<string, number> = {}
    const checker = (job: string) => async (_key: string, max: number) => {
      seen[job] = max
      return { allowed: true as const, retryAfterSec: 0, remaining: 0 }
    }
    await enforceCronRateLimit('accounting-daily-batch', checker('accounting-daily-batch'))
    await enforceCronRateLimit('backup', checker('backup'))
    assert.equal(seen['accounting-daily-batch'], 5000, 'allowlisted job widened')
    assert.equal(seen['backup'], CRON_RATE_LIMIT_MAX, 'non-allowlisted job untouched')
  })
})

async function withEnvAsync(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(vars)) prev[k] = process.env[k]
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await fn()
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

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
