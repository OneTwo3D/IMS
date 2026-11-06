import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import {
  applyE2eMaxOverride,
  CRON_RATE_LIMIT_MAX,
  CRON_RATE_LIMIT_WINDOW_MS,
  E2E_GLOBAL_CAP_WINDOW_MS,
  cronRateLimitGlobalKey,
  cronCadenceMs,
  cronFiringTimes,
  cronRateLimitDailyBudgetKey,
  cronScheduleHash,
  cronScheduleProfile,
  cronXeroDailyBudget,
  XERO_DAILY_BUDGET_CEILING,
  XERO_LIVE_CRON_JOBS,
  cronRateLimitFor,
  cronRateLimitKey,
  enforceCronRateLimit,
} from '@/lib/cron-rate-limit'
import { getAllCronJobs } from '@/lib/cron-registry'
import { PACK_SCHEDULE_SLUG } from '@/lib/reconciliation-pack/schedule-constants'
import { MemoryRateLimitBackend } from '@/lib/security/rate-limit-memory'

function defaultScheduleOf(job: string): string {
  return getAllCronJobs().find((j) => j.slug === job)!.defaultSchedule
}

test('cron rate-limit helper uses per-job keys and the limit derived from the registry schedule', async () => {
  const calls: Array<{ key: string; max: number; windowMs: number }> = []
  const response = await enforceCronRateLimit('inventory-snapshot', async (key, max, windowMs) => {
    calls.push({ key, max, windowMs })
    return { allowed: true, retryAfterSec: 0, remaining: 0 }
  })

  assert.equal(response, null)
  assert.deepEqual(calls, [{
    key: cronRateLimitKey('inventory-snapshot', null, defaultScheduleOf('inventory-snapshot')),
    ...cronRateLimitFor('inventory-snapshot'),
  }])
  assert.deepEqual(cronRateLimitFor('inventory-snapshot'), { max: 3, windowMs: 24 * 60 * 60_000 })
  assert.deepEqual(cronRateLimitFor('not-a-registered-job'), { max: CRON_RATE_LIMIT_MAX, windowMs: CRON_RATE_LIMIT_WINDOW_MS })
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
  assert.equal(calls[0]?.key, cronRateLimitKey('backup', '203.0.113.9', defaultScheduleOf('backup')))
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

test('only a CAPPED job takes the second tenant-wide bucket check', async () => {
  const keysFor = async (jobName: string): Promise<string[]> => {
    const keys: string[] = []
    await enforceCronRateLimit(jobName, {
      request: new Request('https://ims.example.com/api/cron/job', {
        headers: { 'x-real-ip': '203.0.113.9' },
      }),
      checker: async (key) => {
        keys.push(key)
        return { allowed: true, retryAfterSec: 0, remaining: 0 }
      },
    })
    return keys
  }

  await withEnvAsync({ E2E_TEST_MODE: '1', E2E_CRON_RATE_LIMIT_MAX: '10000' }, async () => {
    assert.deepEqual(
      await keysFor('xero-tax-rate-drift'),
      [cronRateLimitKey('xero-tax-rate-drift', '203.0.113.9', defaultScheduleOf('xero-tax-rate-drift')), cronRateLimitGlobalKey('xero-tax-rate-drift')],
      'capped job: IP bucket first, then the shared ceiling',
    )
    // accounting-daily-batch is internal (no external quota to exhaust) and X-01/X-02 drive it repeatedly in
    // one run — it has no ceiling, so it must keep exactly ONE bucket check.
    assert.deepEqual(
      await keysFor('accounting-daily-batch'),
      [cronRateLimitKey('accounting-daily-batch', '203.0.113.9', defaultScheduleOf('accounting-daily-batch'))],
      'uncapped job: single IP-scoped check, unchanged',
    )
  })

  await withEnvAsync({ E2E_TEST_MODE: undefined, E2E_CRON_RATE_LIMIT_MAX: '10000' }, async () => {
    assert.deepEqual(
      await keysFor('xero-tax-rate-drift'),
      [cronRateLimitKey('xero-tax-rate-drift', '203.0.113.9', defaultScheduleOf('xero-tax-rate-drift')), cronRateLimitDailyBudgetKey('xero-tax-rate-drift', defaultScheduleOf('xero-tax-rate-drift'))],
      'override disarmed: no E2E bucket, but the production daily run budget is always checked after the IP slice',
    )
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

test('a capped E2E job cannot exceed its ceiling by rotating source IPs (tenant-wide bucket)', async () => {
  // The per-job ceiling exists to protect a SHARED external quota (xero-tax-rate-drift makes a live Xero
  // /TaxRates call per sweep). A ceiling applied only to `cron:<job>:<ip>` would hand every source address
  // its own 20, so a caller holding the CRON_SECRET could rotate IPs and multiply it (Codex). Prove the
  // ceiling binds across ALL callers, not per caller.
  const DRIFT = 'xero-tax-rate-drift'
  const CAP = 20
  const ATTEMPTS_PER_IP = 3
  const SOURCE_IPS = Array.from({ length: 50 }, (_, i) => `203.0.113.${i + 1}`)

  // Spread the traffic across simulated HOURS, not one instant: an hourly ceiling would silently refill
  // between rounds, so a same-instant burst would pass while sustained abuse still drained the daily quota.
  const HOURS = 6
  const drive = async (): Promise<number> => {
    let now = Date.UTC(2026, 5, 9, 12, 0, 0)
    const backend = new MemoryRateLimitBackend(() => now)
    const checker = (key: string, max: number, windowMs: number) => backend.check(key, max, windowMs)
    let allowed = 0
    for (let hour = 0; hour < HOURS; hour += 1) {
      for (const ip of SOURCE_IPS) {
        for (let attempt = 0; attempt < ATTEMPTS_PER_IP; attempt += 1) {
          const request = new Request('https://ims.example.com/api/cron/xero-tax-rate-drift', {
            headers: { 'x-real-ip': ip },
          })
          const denial = await enforceCronRateLimit(DRIFT, { request, checker })
          if (denial === null) allowed += 1
          else assert.equal(denial.status, 429)
        }
      }
      // Next hour: every IP-scoped bucket has refilled, the daily one has not. The +1ms matters — the
      // backend's window is SLIDING and drops entries strictly older than `now - windowMs`, so an advance of
      // exactly windowMs leaves the previous entry live and the IP would only refill every other hour.
      now += 60 * 60_000 + 1
    }
    return allowed
  }

  await withEnvAsync({ E2E_TEST_MODE: '1', E2E_CRON_RATE_LIMIT_MAX: '10000' }, async () => {
    const allowed = await drive()
    assert.equal(
      allowed,
      CAP,
      `${HOURS * SOURCE_IPS.length * ATTEMPTS_PER_IP} requests from ${SOURCE_IPS.length} IPs over ${HOURS} ` +
        `hours must yield exactly ${CAP} live sweeps — the ceiling is a tenant-wide DAILY budget, so it is ` +
        `neither multiplied by the caller count nor refilled hourly`,
    )
  })

  // Production (override disarmed): the per-IP slice (3/hour, the cadence-derived headroom) plus the always-on
  // IP-independent daily run budget for a live-Xero job. The budget is above the 24 scheduled runs, so no
  // legitimate scheduled caller gains a denial path.
  await withEnvAsync({ E2E_TEST_MODE: undefined, E2E_CRON_RATE_LIMIT_MAX: '10000' }, async () => {
    const allowed = await drive()
    assert.equal(
      allowed,
      cronXeroDailyBudget('0 * * * *'),
      'production: the IP slices admit 3/IP/hour, but the IP-independent daily run budget for a live-Xero job still bounds the day',
    )
  })
})

test('the tenant-wide ceiling is applied over 24h, not the job window (daily quota is what it protects)', async () => {
  // Pins the WINDOW, which the counting test alone cannot: with the job's 1h window the budget would refill
  // every hour (~480 live Xero calls a day against a ~1000/day shared tenant quota) and bound nothing.
  const seen: Array<{ key: string; max: number; windowMs: number }> = []
  await withEnvAsync({ E2E_TEST_MODE: '1', E2E_CRON_RATE_LIMIT_MAX: '10000' }, async () => {
    await enforceCronRateLimit('xero-tax-rate-drift', {
      request: new Request('https://ims.example.com/api/cron/xero-tax-rate-drift', {
        headers: { 'x-real-ip': '203.0.113.9' },
      }),
      checker: async (key, max, windowMs) => {
        seen.push({ key, max, windowMs })
        return { allowed: true, retryAfterSec: 0, remaining: 0 }
      },
    })
  })

  assert.deepEqual(seen, [
    {
      key: cronRateLimitKey('xero-tax-rate-drift', '203.0.113.9', defaultScheduleOf('xero-tax-rate-drift')),
      max: 20,
      windowMs: CRON_RATE_LIMIT_WINDOW_MS,
    },
    {
      key: cronRateLimitGlobalKey('xero-tax-rate-drift'),
      max: 20,
      windowMs: E2E_GLOBAL_CAP_WINDOW_MS,
    },
  ])
  assert.equal(E2E_GLOBAL_CAP_WINDOW_MS, 24 * 60 * 60_000, 'the tenant-wide budget window is a full day')
})

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const START = Date.UTC(2026, 10, 6, 12, 0, 0)
const IP = '203.0.113.10'

async function admitAt(backend: MemoryRateLimitBackend, setNow: (t: number) => void, job: string, t: number) {
  setNow(t)
  const { max, windowMs } = cronRateLimitFor(job)
  return (await backend.check(cronRateLimitKey(job, IP), max, windowMs)).allowed
}

function makeBackend() {
  let now = START
  return { backend: new MemoryRateLimitBackend(() => now), setNow: (t: number) => { now = t } }
}

test('hourly job: a failed run, an operator retry, then the next scheduled run arriving early are all admitted', async () => {
  for (const job of ['wms-watchdog', 'mintsoft-stock-sync', 'xero-tax-rate-drift']) {
    const { backend, setNow } = makeBackend()
    assert.equal(await admitAt(backend, setNow, job, START), true, `${job}: scheduled run (fails downstream)`)
    assert.equal(await admitAt(backend, setNow, job, START + 5 * MINUTE), true, `${job}: operator retry`)
    assert.equal(await admitAt(backend, setNow, job, START + HOUR - 500), true, `${job}: next scheduled run arriving early must not 429`)
    assert.equal(await admitAt(backend, setNow, job, START + HOUR - 400), false, `${job}: a fourth run in the window is refused`)
  }
})

test('hourly job: a run 500 ms early is admitted, a burst inside the window is refused', async () => {
  for (const job of ['mintsoft-stock-sync', 'xero-tax-rate-drift']) {
    const { backend, setNow } = makeBackend()
    assert.equal(await admitAt(backend, setNow, job, START), true)
    assert.equal(await admitAt(backend, setNow, job, START + HOUR - 500), true, `${job}: early next-hour run must be admitted`)
    assert.equal(await admitAt(backend, setNow, job, START + HOUR - 400), true)
    assert.equal(await admitAt(backend, setNow, job, START + HOUR - 300), false, `${job}: fourth run inside the window must be refused`)
  }
})

test('sub-hourly job: every jittered scheduled run in a day is admitted, an excess burst is refused', async () => {
  const { backend, setNow } = makeBackend()
  const cadence = 15 * MINUTE
  for (let i = 0; i < 96; i += 1) {
    const jitter = i % 2 === 0 ? 0 : -500
    assert.equal(await admitAt(backend, setNow, 'delivery-status', START + i * cadence + jitter), true, `run ${i}`)
  }
  const last = START + 95 * cadence
  const { max } = cronRateLimitFor('delivery-status')
  let refused = false
  for (let i = 0; i < max + 1; i += 1) refused = !(await admitAt(backend, setNow, 'delivery-status', last + 1_000 + i))
  assert.equal(refused, true, 'a burst well past the cadence is still refused')
})

test('daily job: a retry and a run 500 ms early are admitted, a fourth run inside the window is refused', async () => {
  const { backend, setNow } = makeBackend()
  const DAY = 24 * HOUR
  assert.equal(await admitAt(backend, setNow, 'backup', START), true)
  assert.equal(await admitAt(backend, setNow, 'backup', START + 5 * MINUTE), true, 'operator retry')
  assert.equal(await admitAt(backend, setNow, 'backup', START + DAY - 500), true)
  assert.equal(await admitAt(backend, setNow, 'backup', START + DAY - 400), false)
})

test('cadence is the shortest real gap between firings, including restricted days, lists and steps', () => {
  assert.equal(cronCadenceMs('*/5 * * * *'), 5 * MINUTE)
  assert.equal(cronCadenceMs('15 * * * *'), HOUR)
  assert.equal(cronCadenceMs('0 */6 * * *'), 6 * HOUR)
  assert.equal(cronCadenceMs('30 3 * * *'), 24 * HOUR)
  assert.equal(cronCadenceMs('0,30 * * * *'), 30 * MINUTE)
  // Restricted days must not floor the cadence at a day: this fires four times on each Monday.
  assert.equal(cronCadenceMs('0 */6 * * 1'), 6 * HOUR)
  assert.equal(cronScheduleProfile('0 */6 * * 1')?.maxPerDay, 4)
  assert.equal(cronCadenceMs('*/15 9-17 * * 1-5'), 15 * MINUTE)
  assert.equal(cronCadenceMs('0 9-17/2 * * 1,3'), 2 * HOUR)
  assert.equal(cronCadenceMs('0,10 8 * * 0'), 10 * MINUTE)
  assert.equal(cronCadenceMs('0 3 * * 1'), 7 * 24 * HOUR)
  assert.equal(cronCadenceMs('0 3 * * 7'), 7 * 24 * HOUR, 'day-of-week 7 is Sunday')
  assert.equal(cronCadenceMs('0 0 1,15 * *'), 14 * 24 * HOUR, 'shortest gap: Jan 1 to Jan 15')
  // Both day fields restricted: cron fires on EITHER (Mondays plus the 1st).
  assert.equal(cronCadenceMs('0 0 1 * 1'), 24 * HOUR)
  // OR-matching of day-of-month and day-of-week shifts with the year: Feb 1 and a Monday on Feb 2 happen in 2026.
  assert.equal(cronCadenceMs('0 0 1 2 1'), 24 * HOUR)
  assert.equal(cronCadenceMs('nonsense'), null)
  assert.equal(cronCadenceMs('61 * * * *'), null)
})

test('the effective (saved) schedule drives the limit, not the registry default', async () => {
  const seen: Array<{ max: number; windowMs: number }> = []
  const checker = async (_key: string, max: number, windowMs: number) => {
    seen.push({ max, windowMs })
    return { allowed: true, retryAfterSec: 0, remaining: 0 }
  }
  const defaultLimit = cronRateLimitFor('read-sync-liveness')
  assert.deepEqual(defaultLimit, { max: 3, windowMs: HOUR })
  // Operator saved "every minute" for an hourly-by-default job: 60 scheduled runs an hour must fit.
  await enforceCronRateLimit('read-sync-liveness', { checker, scheduleReader: async () => '* * * * *' })
  assert.deepEqual(seen.pop(), { max: 75, windowMs: HOUR })
  // Slower saved schedule widens the window instead.
  await enforceCronRateLimit('read-sync-liveness', { checker, scheduleReader: async () => '0 */6 * * *' })
  assert.deepEqual(seen.pop(), { max: 3, windowMs: 6 * HOUR })
  // No saved row, or an unreadable one, falls back to the registry default.
  await enforceCronRateLimit('read-sync-liveness', { checker, scheduleReader: async () => null })
  assert.deepEqual(seen.pop(), defaultLimit)
  await enforceCronRateLimit('read-sync-liveness', { checker, scheduleReader: async () => 'garbage' })
  assert.deepEqual(seen.pop(), defaultLimit)
  // A run per minute for an hour is never refused once the saved schedule is honoured.
  const { backend, setNow } = makeBackend()
  const reader = async () => '* * * * *'
  for (let i = 0; i < 60; i += 1) {
    setNow(START + i * MINUTE - (i % 2 === 0 ? 0 : 500))
    const res = await enforceCronRateLimit('read-sync-liveness', {
      scheduleReader: reader,
      checker: (k, m, w) => backend.check(k, m, w),
    })
    assert.equal(res, null, `minute ${i}`)
  }
})

test('a saved schedule edit starts fresh buckets: */5 to daily admits the first daily run', async () => {
  const { backend, setNow } = makeBackend()
  const check = (k: string, m: number, w: number) => backend.check(k, m, w)
  const request = new Request('https://ims.example.com/x', { headers: { 'x-real-ip': '198.51.100.7' } })
  // A day of 5-minute runs under the old schedule fills the old bucket (and the Xero budget).
  for (let i = 0; i < 12; i += 1) {
    setNow(START + i * 5 * MINUTE)
    assert.equal(await enforceCronRateLimit('accounting-sync', { request, checker: check, scheduleReader: async () => '*/5 * * * *' }), null)
  }
  // Operator moves it to 02:00 daily; its first daily run, minutes later, must not inherit the old counts.
  setNow(START + 61 * MINUTE)
  const first = await enforceCronRateLimit('accounting-sync', { request, checker: check, scheduleReader: async () => '0 2 * * *' })
  assert.equal(first, null, 'first run under the new schedule is admitted')
  assert.notEqual(cronRateLimitKey('accounting-sync', '1.2.3.4', '*/5 * * * *'), cronRateLimitKey('accounting-sync', '1.2.3.4', '0 2 * * *'))
  assert.notEqual(cronRateLimitDailyBudgetKey('accounting-sync', '*/5 * * * *'), cronRateLimitDailyBudgetKey('accounting-sync', '0 2 * * *'))
  assert.equal(cronScheduleHash('0  2 * * *'), cronScheduleHash(' 0 2 * * * '), 'whitespace-normalised')
})

test('production: a live-Xero job has an IP-independent rolling daily budget; the census names every accounting-module job', async () => {
  const budget = cronXeroDailyBudget('0 * * * *')
  assert.equal(budget, 32)
  assert.ok(budget < 1000 && budget > 24, 'above the 24 scheduled runs, far below the tenant allowance')
  assert.equal(cronXeroDailyBudget('* * * * *'), XERO_DAILY_BUDGET_CEILING, 'a fast saved schedule is capped')
  const { backend, setNow } = makeBackend()
  let allowed = 0
  await withEnvAsync({ E2E_TEST_MODE: undefined, E2E_CRON_RATE_LIMIT_MAX: '10000' }, async () => {
    for (let hour = 0; hour < 24; hour += 1) {
      setNow(START + hour * HOUR + hour)
      for (let ip = 1; ip <= 50; ip += 1) {
        const request = new Request('https://ims.example.com/x', { headers: { 'x-real-ip': `198.51.100.${ip}` } })
        const denial = await enforceCronRateLimit('xero-tax-rate-drift', {
          request,
          scheduleReader: async () => null,
          checker: (k, m, w) => backend.check(k, m, w),
        })
        if (denial === null) allowed += 1
      }
    }
  })
  assert.equal(allowed, budget, 'many source IPs over a day spend one shared budget')
  assert.equal(cronRateLimitDailyBudgetKey('xero-tax-rate-drift', '0 * * * *'), `cron:xero-tax-rate-drift:${cronScheduleHash('0 * * * *')}:xero-daily-budget`)

  // Census: every registry job in the xero module is in the live-Xero set, every member is a real job, and each
  // job's budget exceeds its busiest day.
  const registry = getAllCronJobs()
  const accountingJobs = registry.filter((j) => j.module === 'accounting')
  assert.equal(accountingJobs.length, 6, 'the accounting module registers the six Xero-calling jobs; a new one needs a census decision')
  for (const job of accountingJobs) {
    assert.ok(XERO_LIVE_CRON_JOBS.has(job.slug), `${job.slug} is an accounting-module job missing from XERO_LIVE_CRON_JOBS`)
  }
  assert.deepEqual([...XERO_LIVE_CRON_JOBS].sort(), accountingJobs.map((j) => j.slug).sort())
  for (const slug of XERO_LIVE_CRON_JOBS) {
    const job = registry.find((j) => j.slug === slug)
    assert.ok(job, `${slug} is not a registered job`)
    const perDay = cronScheduleProfile(job.defaultSchedule)!.maxPerDay
    assert.ok(cronXeroDailyBudget(job.defaultSchedule) > perDay, `${slug}: budget must exceed its scheduled runs per day`)
  }
})

test('the daily budget does not apply to non-Xero jobs or when the E2E raise is in effect', async () => {
  const seen: string[] = []
  const checker = async (key: string) => {
    seen.push(key)
    return { allowed: true, retryAfterSec: 0, remaining: 0 }
  }
  await withEnvAsync({ E2E_TEST_MODE: undefined }, async () => {
    await enforceCronRateLimit('backup', { checker, scheduleReader: async () => null })
    assert.deepEqual(seen.splice(0), [cronRateLimitKey('backup', null, defaultScheduleOf('backup'))])
    await enforceCronRateLimit('xero-tax-rate-drift', { checker, scheduleReader: async () => null })
    assert.deepEqual(seen.splice(0), [cronRateLimitKey('xero-tax-rate-drift', null, defaultScheduleOf('xero-tax-rate-drift')), cronRateLimitDailyBudgetKey('xero-tax-rate-drift', defaultScheduleOf('xero-tax-rate-drift'))])
  })
  await withEnvAsync({ E2E_TEST_MODE: '1', E2E_CRON_RATE_LIMIT_MAX: '10000' }, async () => {
    await enforceCronRateLimit('accounting-daily-batch', { checker, scheduleReader: async () => null })
    assert.deepEqual(seen.splice(0), [cronRateLimitKey('accounting-daily-batch', null, defaultScheduleOf('accounting-daily-batch'))])
  })
})

/** Most firings already inside the window when a run arrives (the backend counts entries newer than now - window). */
function maxPriorFirings(expression: string, windowMs: number): number {
  const times: number[] = []
  for (const t of cronFiringTimes(expression)) times.push(t)
  let lo = 0
  let worst = 0
  for (let i = 0; i < times.length; i += 1) {
    while (times[i] - times[lo] > windowMs) lo += 1
    worst = Math.max(worst, i - lo)
  }
  return worst
}

test('census: every registry job limit leaves headroom above its scheduled firings, and no cron route overrides it', () => {
  const jobs = getAllCronJobs()
  assert.ok(jobs.length >= 30, `expected the full registry, got ${jobs.length}`)
  const schedules = [...jobs.map((j) => [j.slug, j.defaultSchedule] as const), ['(restricted days)', '0 */6 * * 1'], ['(business hours)', '*/15 9-17 * * 1-5'], ['(two days)', '0 0 1,15 * *']]
  for (const [slug, schedule] of schedules) {
    assert.ok(cronCadenceMs(schedule) != null, `${slug}: unreadable schedule ${schedule}`)
    const { max, windowMs } = cronRateLimitFor(slug, schedule)
    // On schedule, `prior` runs are already in the window; one more slot must remain for an early arrival.
    const prior = maxPriorFirings(schedule, windowMs)
    assert.ok(prior + 2 <= max, `${slug} (${schedule}): ${prior} prior scheduled runs in a ${windowMs}ms window, max ${max} leaves less than 2 spare for a retry plus jitter`)
  }
  // The census itself must reject an allowance that is exactly the cadence.
  const hourlyPrior = maxPriorFirings('0 * * * *', HOUR)
  assert.equal(hourlyPrior, 1, 'an hourly job always has its previous run inside an hour window')
  assert.ok(!(hourlyPrior + 2 <= 2), 'a max of 2 for an hourly job fails the census predicate')
  assert.ok(!(maxPriorFirings('0 */6 * * 1', 24 * HOUR) + 2 <= 4), 'a daily allowance of 3 would refuse the 4th Monday run of a 6-hourly Monday job')

  // A route that passes its own max/windowMs bypasses the derivation; only unregistered routes may.
  // EVERY cron route must enforce the limiter under its own job name, and a registered one must not override it.
  const routesDir = join(process.cwd(), 'app/api/cron')
  const registered = new Map(jobs.map((j) => [j.slug === PACK_SCHEDULE_SLUG ? 'reconciliation-pack' : j.slug, j.slug]))
  const dirs = readdirSync(routesDir).filter((dir) => existsSync(join(routesDir, dir, 'route.ts')))
  for (const slug of registered.keys()) assert.ok(dirs.includes(slug), `${slug}: registered job has no app/api/cron/${slug}/route.ts`)
  for (const dir of dirs) {
    const source = readFileSync(join(routesDir, dir, 'route.ts'), 'utf8')
    const call = /enforceCronRateLimit\(\s*([^,)]+?)\s*(?:,\s*\{([^}]*)\})?\s*\)/.exec(source)
    assert.ok(call, `${dir}: cron route does not call enforceCronRateLimit`)
    const jobArg = call[1].trim()
    const jobName = jobArg === 'PACK_SCHEDULE_SLUG' ? PACK_SCHEDULE_SLUG : jobArg.replace(/^'|'$/g, '')
    if (!registered.has(dir)) continue // unregistered route (no schedule to derive from): may carry its own max
    assert.equal(jobName, registered.get(dir), `${dir}: enforces the limiter under the wrong job name`)
    assert.ok(!/\b(max|windowMs)\s*:/.test(call[2] ?? ''), `${dir}: registered cron job passes its own max/windowMs; let the registry schedule derive it`)
  }
})
