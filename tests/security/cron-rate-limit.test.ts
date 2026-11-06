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
  cronRateLimitFor,
  cronRateLimitKey,
  enforceCronRateLimit,
} from '@/lib/cron-rate-limit'
import { getAllCronJobs } from '@/lib/cron-registry'
import { MemoryRateLimitBackend } from '@/lib/security/rate-limit-memory'

test('cron rate-limit helper uses per-job keys and the limit derived from the registry schedule', async () => {
  const calls: Array<{ key: string; max: number; windowMs: number }> = []
  const response = await enforceCronRateLimit('inventory-snapshot', async (key, max, windowMs) => {
    calls.push({ key, max, windowMs })
    return { allowed: true, retryAfterSec: 0, remaining: 0 }
  })

  assert.equal(response, null)
  assert.deepEqual(calls, [{
    key: cronRateLimitKey('inventory-snapshot'),
    ...cronRateLimitFor('inventory-snapshot'),
  }])
  assert.deepEqual(cronRateLimitFor('inventory-snapshot'), { max: 2, windowMs: 24 * 60 * 60_000 })
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
      [cronRateLimitKey('xero-tax-rate-drift', '203.0.113.9'), cronRateLimitGlobalKey('xero-tax-rate-drift')],
      'capped job: IP bucket first, then the shared ceiling',
    )
    // accounting-daily-batch is internal (no external quota to exhaust) and X-01/X-02 drive it repeatedly in
    // one run — it has no ceiling, so it must keep exactly ONE bucket check.
    assert.deepEqual(
      await keysFor('accounting-daily-batch'),
      [cronRateLimitKey('accounting-daily-batch', '203.0.113.9')],
      'uncapped job: single IP-scoped check, unchanged',
    )
  })

  await withEnvAsync({ E2E_TEST_MODE: undefined, E2E_CRON_RATE_LIMIT_MAX: '10000' }, async () => {
    assert.deepEqual(
      await keysFor('xero-tax-rate-drift'),
      [cronRateLimitKey('xero-tax-rate-drift', '203.0.113.9')],
      'override disarmed: no tenant-wide bucket, production path unchanged',
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

  // Production (override disarmed) takes no second bucket: only the per-IP slice applies (now 2 per hour, the
  // cadence-derived headroom), so no legitimate scheduled caller gains a new denial path.
  await withEnvAsync({ E2E_TEST_MODE: undefined, E2E_CRON_RATE_LIMIT_MAX: '10000' }, async () => {
    const allowed = await drive()
    assert.equal(
      allowed,
      SOURCE_IPS.length * HOURS * 2,
      'production keeps only the IP-scoped slice — two per IP per hour (one run plus early-arrival headroom)',
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
      key: cronRateLimitKey('xero-tax-rate-drift', '203.0.113.9'),
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

test('hourly job: a run 500 ms early is admitted, a third run inside the window is refused', async () => {
  for (const job of ['mintsoft-stock-sync', 'xero-tax-rate-drift']) {
    const { backend, setNow } = makeBackend()
    assert.equal(await admitAt(backend, setNow, job, START), true)
    assert.equal(await admitAt(backend, setNow, job, START + HOUR - 500), true, `${job}: early next-hour run must be admitted`)
    assert.equal(await admitAt(backend, setNow, job, START + HOUR - 400), false, `${job}: third run inside the window must be refused`)
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

test('daily job: a run 500 ms early is admitted, a third run inside the window is refused', async () => {
  const { backend, setNow } = makeBackend()
  const DAY = 24 * HOUR
  assert.equal(await admitAt(backend, setNow, 'backup', START), true)
  assert.equal(await admitAt(backend, setNow, 'backup', START + DAY - 500), true)
  assert.equal(await admitAt(backend, setNow, 'backup', START + DAY - 400), false)
})

test('cadence parser reads the registry schedule shapes', () => {
  assert.equal(cronCadenceMs('*/5 * * * *'), 5 * MINUTE)
  assert.equal(cronCadenceMs('15 * * * *'), HOUR)
  assert.equal(cronCadenceMs('0 */6 * * *'), 6 * HOUR)
  assert.equal(cronCadenceMs('30 3 * * *'), 24 * HOUR)
  assert.equal(cronCadenceMs('0,30 * * * *'), 30 * MINUTE)
  assert.equal(cronCadenceMs('0 3 * * 1'), 24 * HOUR)
  assert.equal(cronCadenceMs('nonsense'), null)
})

test('census: every registry job limit leaves headroom above its cadence, and no cron route overrides it', () => {
  const jobs = getAllCronJobs()
  assert.ok(jobs.length >= 30, `expected the full registry, got ${jobs.length}`)
  for (const job of jobs) {
    const cadence = cronCadenceMs(job.defaultSchedule)
    assert.ok(cadence != null, `${job.slug}: unreadable schedule ${job.defaultSchedule}`)
    const { max, windowMs } = cronRateLimitFor(job.slug)
    // Strictly more runs per window than the schedule fires: max > windowMs / cadence.
    assert.ok(max * cadence > windowMs, `${job.slug}: ${max}/${windowMs}ms does not exceed cadence ${cadence}ms`)
    assert.ok(max >= 2, `${job.slug}: needs room for at least one early run`)
  }

  // A route that passes its own max/windowMs bypasses the derivation; only unregistered routes may.
  const registered = new Set(jobs.map((j) => j.slug))
  const routesDir = join(process.cwd(), 'app/api/cron')
  for (const dir of readdirSync(routesDir)) {
    const file = join(routesDir, dir, 'route.ts')
    if (!existsSync(file)) continue
    const source = readFileSync(file, 'utf8')
    const call = /enforceCronRateLimit\(\s*([^,]+),\s*\{([^}]*)\}/.exec(source)
    if (!call || !/\b(max|windowMs)\s*:/.test(call[2])) continue
    assert.ok(
      !registered.has(dir) && !/PACK_SCHEDULE_SLUG/.test(call[1]),
      `${dir}: registered cron job passes its own max/windowMs; let the registry schedule derive it`,
    )
  }
})
