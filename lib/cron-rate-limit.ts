import { NextResponse } from 'next/server'

import '@/lib/cron-jobs'
import { getAllCronJobs } from '@/lib/cron-registry'
import { checkRateLimit, type RateLimitResult } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/request-ip'

/** Fallback limit for a job that is not in the cron registry: two runs per hour, never exactly the cadence. */
export const CRON_RATE_LIMIT_MAX = 2
export const CRON_RATE_LIMIT_WINDOW_MS = 60 * 60_000
export const CRON_RATE_LIMIT_FIFTEEN_MINUTE_MAX = 6

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

export type CronRateLimit = { max: number; windowMs: number }

type CronFieldSpec = { min: number; max: number }
const MINUTE_FIELD: CronFieldSpec = { min: 0, max: 59 }
const HOUR_FIELD: CronFieldSpec = { min: 0, max: 23 }
const DOM_FIELD: CronFieldSpec = { min: 1, max: 31 }
const MONTH_FIELD: CronFieldSpec = { min: 1, max: 12 }
const DOW_FIELD: CronFieldSpec = { min: 0, max: 7 }

/** Expand one cron field (`*`, `a`, `a-b`, lists, optional `/step`) to its values, or null when unreadable. */
function expandCronField(field: string, spec: CronFieldSpec): Set<number> | null {
  const out = new Set<number>()
  for (const part of field.split(',')) {
    const [range, stepRaw, extra] = part.split('/')
    if (extra !== undefined) return null
    const step = stepRaw === undefined ? 1 : Number(stepRaw)
    if (!Number.isInteger(step) || step < 1) return null
    let lo: number
    let hi: number
    if (range === '*') {
      lo = spec.min
      hi = spec.max
    } else if (/^\d+$/.test(range)) {
      lo = Number(range)
      hi = stepRaw === undefined ? lo : spec.max
    } else if (/^\d+-\d+$/.test(range)) {
      ;[lo, hi] = range.split('-').map(Number)
    } else {
      return null
    }
    if (lo < spec.min || hi > spec.max || lo > hi) return null
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out.size > 0 ? out : null
}

type ParsedCron = {
  minutes: number[]
  hours: number[]
  doms: Set<number>
  months: Set<number>
  dows: Set<number>
  domRestricted: boolean
  dowRestricted: boolean
}

function parseCron(expression: string): ParsedCron | null {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const minutes = expandCronField(fields[0], MINUTE_FIELD)
  const hours = expandCronField(fields[1], HOUR_FIELD)
  const doms = expandCronField(fields[2], DOM_FIELD)
  const months = expandCronField(fields[3], MONTH_FIELD)
  const dowRaw = expandCronField(fields[4], DOW_FIELD)
  if (!minutes || !hours || !doms || !months || !dowRaw) return null
  const dows = new Set([...dowRaw].map((d) => d % 7))
  return {
    minutes: [...minutes].sort((a, b) => a - b),
    hours: [...hours].sort((a, b) => a - b),
    doms,
    months,
    dows,
    domRestricted: !fields[2].startsWith('*'),
    dowRestricted: !fields[4].startsWith('*'),
  }
}

/** Standard cron day matching: when both day-of-month and day-of-week are restricted, either one suffices. */
function dayMatches(c: ParsedCron, date: Date): boolean {
  if (!c.months.has(date.getUTCMonth() + 1)) return false
  const domOk = c.doms.has(date.getUTCDate())
  const dowOk = c.dows.has(date.getUTCDay())
  if (c.domRestricted && c.dowRestricted) return domOk || dowOk
  return domOk && dowOk
}

/** Firing times (epoch ms, UTC, ascending) of a cron expression over the leap year 2028, or null when unreadable. */
export function* cronFiringTimes(expression: string): Generator<number> {
  const c = parseCron(expression)
  if (!c) return
  const start = Date.UTC(2028, 0, 1)
  for (let day = 0; day < 366; day += 1) {
    const dayStart = start + day * DAY_MS
    if (!dayMatches(c, new Date(dayStart))) continue
    for (const h of c.hours) for (const m of c.minutes) yield dayStart + h * HOUR_MS + m * MINUTE_MS
  }
}

export type CronScheduleProfile = {
  /** Shortest gap between two consecutive firings (a year when it fires fewer than twice). */
  cadenceMs: number
  /** Most firings in any one UTC day. */
  maxPerDay: number
}

const profileCache = new Map<string, CronScheduleProfile | null>()

/** Shortest real gap between firings and busiest day for a 5-field cron expression, or null when unreadable. */
export function cronScheduleProfile(expression: string): CronScheduleProfile | null {
  const cached = profileCache.get(expression)
  if (cached !== undefined) return cached
  let profile: CronScheduleProfile | null = null
  if (parseCron(expression)) {
    let last: number | null = null
    let gap = Infinity
    let perDay = 0
    let maxPerDay = 0
    let currentDay = -1
    let any = false
    for (const t of cronFiringTimes(expression)) {
      any = true
      if (last !== null) gap = Math.min(gap, t - last)
      last = t
      const day = Math.floor(t / DAY_MS)
      if (day !== currentDay) {
        currentDay = day
        perDay = 0
      }
      perDay += 1
      maxPerDay = Math.max(maxPerDay, perDay)
    }
    if (any) profile = { cadenceMs: Number.isFinite(gap) ? gap : 366 * DAY_MS, maxPerDay }
  }
  profileCache.set(expression, profile)
  return profile
}

/** Shortest interval between two firings of a 5-field cron expression, in ms, or null when it cannot be read. */
export function cronCadenceMs(expression: string): number | null {
  return cronScheduleProfile(expression)?.cadenceMs ?? null
}

/**
 * The rate limit that leaves headroom above a cadence, so a scheduled run is never refused for arriving a
 * little early (cron jitter, a burst of jobs at :00, retries):
 * - cadence of an hour or more: the window IS the cadence and two runs fit in it, so a run landing
 *   milliseconds before the previous one's anniversary is still admitted and only a third is refused;
 * - sub-hourly: the usual hour window with the scheduled runs plus a quarter (at least two) spare.
 */
export function cronRateLimitForCadence(cadenceMs: number): CronRateLimit {
  if (cadenceMs >= HOUR_MS) return { max: 2, windowMs: cadenceMs }
  const runs = Math.ceil(HOUR_MS / cadenceMs)
  return { max: runs + Math.max(2, Math.ceil(runs / 4)), windowMs: HOUR_MS }
}

/**
 * Default limit for a job. `schedule` is the EFFECTIVE schedule (the saved `cron_<job>_schedule`, else the registry default);
 * an unreadable schedule falls back to the registry default, and a job that is not in the registry to the generic limit.
 */
export function cronRateLimitFor(jobName: string, schedule?: string | null): CronRateLimit {
  const job = getAllCronJobs().find((j) => j.slug === jobName)
  const cadence = (schedule ? cronCadenceMs(schedule) : null) ?? (job ? cronCadenceMs(job.defaultSchedule) : null)
  if (cadence == null) return { max: CRON_RATE_LIMIT_MAX, windowMs: CRON_RATE_LIMIT_WINDOW_MS }
  return cronRateLimitForCadence(cadence)
}

/**
 * Cron jobs that make LIVE Xero API calls on a run (census of the registry's accounting module). Every one of them is held
 * to an IP-independent rolling daily RUN budget in production (see cronXeroDailyBudget), so a leaked CRON_SECRET used from
 * many addresses cannot multiply cron runs (abuse and retry control). This bounds RUNS, not Xero calls: a run can make
 * several calls, and the actual calls are bounded per process by the Xero transport's own daily counter.
 * accounting-fx-revaluation is deliberately absent: Xero does not post FX journals, so a run makes no Xero call.
 */
export const XERO_LIVE_CRON_JOBS: ReadonlySet<string> = new Set([
  'accounting-sync',
  'accounting-daily-batch',
  'accounting-payment-reconcile',
  'accounting-payment-poll',
  'xero-tax-rate-drift',
  'account-balance-snapshot',
])

/** Hard ceiling on one job's daily run budget, however fast its schedule is set. */
export const XERO_DAILY_BUDGET_CEILING = 500

/**
 * Daily run budget for a Xero-live job: its scheduled runs per day plus a quarter (and two spare), never above the ceiling.
 * xero-tax-rate-drift (hourly) gets 32/day against 24 scheduled; accounting-sync (every 5 min) 362/day against 288; the daily
 * jobs 4/day. A run budget, not a call budget: it limits how many cron runs a leaked secret can trigger, not how many Xero
 * HTTP calls those runs make.
 */
export function cronXeroDailyBudget(schedule: string): number {
  const perDay = cronScheduleProfile(schedule)?.maxPerDay ?? 24
  return Math.min(XERO_DAILY_BUDGET_CEILING, perDay + Math.ceil(perDay / 4) + 2)
}

/** Reads the saved `cron_<settingKey>_schedule` row (one primary-key read); null when absent or unreadable. */
export type CronScheduleReader = (settingKey: string) => Promise<string | null>

const SCHEDULE_READ_TIMEOUT_MS = 2_000

const readSavedCronSchedule: CronScheduleReader = async (settingKey) => {
  // No database configured (unit tests, tooling): nothing to read, use the registry default.
  if (!process.env.DATABASE_URL) return null
  try {
    const { db } = await import('@/lib/db')
    const read = db.setting.findUnique({ where: { key: `cron_${settingKey}_schedule` } }).then((row) => row?.value ?? null)
    // A slow or unreachable database must not stall the cron request: fall back to the registry default.
    return await Promise.race([
      read,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), SCHEDULE_READ_TIMEOUT_MS).unref()),
    ])
  } catch {
    return null
  }
}

export type CronRateLimitChecker = (
  key: string,
  max: number,
  windowMs: number,
) => Promise<RateLimitResult>

export type CronRateLimitOptions = {
  max?: number
  /** Effective-schedule reader (tests); defaults to the saved `cron_<job>_schedule` row. */
  scheduleReader?: CronScheduleReader
  windowMs?: number
  request?: Request
  checker?: CronRateLimitChecker
}

/**
 * Cron rate limits use the application's configured rate-limit backend.
 *
 * Deployment contract:
 * - Single-process installs can use the default memory backend.
 * - Multi-replica installs must set `RATE_LIMIT_BACKEND=redis` and `REDIS_URL`
 *   so all replicas share one quota window.
 * - Keys include the verified source IP when available. This scopes leaked
 *   CRON_SECRET quota exhaustion to the caller's IP slice; rotating the secret
 *   should still be paired with clearing/restarting the rate-limit backend if
 *   an incident consumed the legitimate caller's quota.
 * - Every job's limit is derived from its registry schedule (cronRateLimitFor) and always leaves
 *   headroom above exact cadence: sub-hourly jobs get their runs per hour plus spare, hourly and
 *   N-hourly/daily jobs get two runs per cadence window. Do not pass a per-route `max`/`windowMs`
 *   equal to the cadence (a 5-minute cron at exactly 12/hour, an hourly cron at exactly 1/hour);
 *   jitter, retries, and boundary timing will deny legitimate scheduled runs. Routes should not
 *   override at all; the census test in tests/security/cron-rate-limit.test.ts enforces that.
 * - Fail-open on backend error is DELIBERATE here (checkRateLimit is called
 *   without `failClosed`): cron routes are already gated by CRON_SECRET, so a
 *   rate-limit backend outage must not block legitimate scheduled jobs. This is
 *   the opposite trade-off from the auth endpoints (login/reset/TOTP/step-up),
 *   which fail closed because they are the primary brute-force barrier.
 * - `E2E_CRON_RATE_LIMIT_MAX` is a test/CI-only override for the full-chain
 *   e2e rig, where one suite run legitimately triggers a batch cron many times
 *   (e.g. OC-08 and X-01 both drive accounting-daily-batch). It is guarded
 *   THREE ways so it cannot silently weaken production (see applyE2eMaxOverride):
 *     1. requires `E2E_TEST_MODE=1` — the repo's existing e2e-only flag, unset
 *        in production (we cannot gate on NODE_ENV: the rig serves a PRODUCTION
 *        build, so NODE_ENV=production there);
 *     2. applies ONLY to an allowlisted job (accounting-daily-batch) — a leaked
 *        value can never widen backup/archival/accounting-sync/etc.;
 *     3. RAISE-only (`Math.max`) — can never tighten a configured max into a
 *        production denial.
 *   The allowlisted job is still CRON_SECRET-gated; this limit is defence-in-
 *   depth. Production leaves both E2E vars unset.
 */
export function cronRateLimitKey(jobName: string, sourceIp?: string | null): string {
  if (sourceIp?.trim()) return `cron:${jobName}:${sourceIp.trim()}`
  return `cron:${jobName}`
}

/**
 * IP-INDEPENDENT companion key for a job whose E2E override is capped (see E2E_OVERRIDE_JOBS).
 *
 * The per-job ceiling alone bounds each IP's bucket, not the tenant: `cron:<job>:<ip>` gives EVERY source IP
 * its own allowance, so a caller holding the CRON_SECRET could rotate source addresses and multiply the
 * allowance until it exhausted the shared external quota the ceiling exists to protect (Codex). This key is
 * scoped to the job only, so all callers share ONE bucket at the ceiling regardless of source address.
 *
 * The sentinel can never collide with a real source IP: getClientIp() returns only a normalized, verified
 * address (lib/request-ip.ts normalizeIp → isIP) or null, and `e2e-global` is neither.
 */
export function cronRateLimitDailyBudgetKey(jobName: string): string {
  return `cron:${jobName}:xero-daily-budget`
}

export function cronRateLimitGlobalKey(jobName: string): string {
  return `cron:${jobName}:e2e-global`
}

/**
 * The tenant-wide ceiling is a DAILY budget, not an hourly one — deliberately decoupled from the job's own
 * window. The quota it protects is a daily one (Xero allows ~1000 calls/day per tenant), so an hourly
 * ceiling would not bound it: 20/hour sustained is ~480/day, roughly half the shared allowance, which is
 * exactly the exhaustion the ceiling exists to prevent (Codex). Applied over 24h, the ceiling IS the daily
 * budget — 20 live sweeps a day, tenant-wide, whatever the caller does.
 *
 * Consequence for the rig, which is the intended trade: X-04 spends 3 of the 20 per run, so ~6 runs a day
 * before it 429s. The backend is memory-backed, so restarting ims-e2e-dev.service clears it (the same
 * restart that clears the login limiter).
 */
export const E2E_GLOBAL_CAP_WINDOW_MS = 24 * 60 * 60_000

/**
 * The only cron jobs whose 1/hour limit an e2e run legitimately needs widened, each mapped to an OPTIONAL
 * per-job ceiling on how far `E2E_CRON_RATE_LIMIT_MAX` may raise it. Keep this list minimal — every entry
 * is a job a leaked E2E_CRON_RATE_LIMIT_MAX could widen (only if E2E_TEST_MODE=1 is ALSO set), so it is the
 * blast radius.
 *
 * - `accounting-daily-batch` → null (no per-job cap): a purely internal batch with no per-run external
 *   dependency to exhaust, so it honours E2E_CRON_RATE_LIMIT_MAX in full (OC-08 and X-01/X-02 each drive it;
 *   o3d-lgo.13).
 * - `xero-tax-rate-drift` → 20 (hard per-job cap): the X-04 test runs it three times in ONE test — baseline,
 *   after injecting IMS-side drift, and after reconciling — so the default 1/hour bucket would 429 the
 *   second run (o3d-lgo.7 / X-04). But EACH sweep with a component-backed IMS rate makes a LIVE Xero
 *   /TaxRates call, and the rig shares a quota-limited Xero tenant with stage (~1000 calls/day), so this is
 *   capped WELL below that quota regardless of how large E2E_CRON_RATE_LIMIT_MAX is set — a leaked secret or
 *   runaway retry loop can never turn the e2e allowance into shared-tenant quota exhaustion (Codex). 20
 *   comfortably covers X-04's three sweeps with retry headroom. A ceiling here is a TENANT-WIDE DAILY budget,
 *   not a per-IP hourly one — see e2eGlobalCapFor / cronRateLimitGlobalKey / E2E_GLOBAL_CAP_WINDOW_MS.
 */
const E2E_OVERRIDE_JOBS = new Map<string, number | null>([
  ['accounting-daily-batch', null],
  ['xero-tax-rate-drift', 20],
])

/**
 * Test/CI-only per-job max override. Returns `max` unchanged unless ALL hold:
 *   1. `E2E_TEST_MODE === '1'` (the repo's e2e flag; unset in production — and
 *      NODE_ENV can't be the guard because the rig serves a production build);
 *   2. `jobName` is in E2E_OVERRIDE_JOBS (scopes the blast radius to one job);
 *   3. `E2E_CRON_RATE_LIMIT_MAX` parses to a positive integer.
 * Even then it only RAISES the max (`Math.max`), never lowers it — so a stray value can never tighten a
 * limit into a production denial — and it is bounded ABOVE by the job's per-job ceiling when one is set, so
 * a job with a live external dependency (e.g. xero-tax-rate-drift's Xero /TaxRates call) can never inherit
 * the full E2E_CRON_RATE_LIMIT_MAX and exhaust a shared quota.
 */
export function applyE2eMaxOverride(jobName: string, max: number): number {
  if (process.env.E2E_TEST_MODE !== '1') return max
  if (!E2E_OVERRIDE_JOBS.has(jobName)) return max
  const raw = process.env.E2E_CRON_RATE_LIMIT_MAX
  if (!raw) return max
  const override = Number(raw)
  if (!Number.isFinite(override) || override <= 0) return max
  const perJobCap = E2E_OVERRIDE_JOBS.get(jobName) ?? null
  const capped = perJobCap == null ? Math.floor(override) : Math.min(Math.floor(override), perJobCap)
  return Math.max(max, capped)
}

/**
 * The tenant-wide ceiling to ALSO enforce (on cronRateLimitGlobalKey) for this request, or null for none.
 *
 * Returns a number ONLY when the E2E override actually RAISED this job's max AND the job has a per-job
 * ceiling. Two consequences, both deliberate:
 *   - Production is untouched. With E2E_TEST_MODE unset the override never applies, so this returns null and
 *     the request takes exactly the same single IP-scoped check it always did — no new denial path.
 *   - The ceiling becomes a real tenant-wide bound, not a per-IP one: under the E2E override, every caller
 *     shares one bucket at the ceiling, so rotating source IPs cannot multiply the live external calls the
 *     ceiling exists to cap.
 */
export function e2eGlobalCapFor(jobName: string, baseMax: number): number | null {
  const perJobCap = E2E_OVERRIDE_JOBS.get(jobName)
  if (perJobCap == null) return null
  return applyE2eMaxOverride(jobName, baseMax) > baseMax ? perJobCap : null
}

export async function enforceCronRateLimit(
  jobName: string,
  optionsOrChecker: CronRateLimitOptions | CronRateLimitChecker = {},
): Promise<Response | null> {
  const options = typeof optionsOrChecker === 'function'
    ? { checker: optionsOrChecker }
    : optionsOrChecker
  // The EFFECTIVE schedule, as the crontab generator sees it: the saved row, else the registry default.
  const job = getAllCronJobs().find((j) => j.slug === jobName)
  const saved = job ? await (options.scheduleReader ?? readSavedCronSchedule)(job.settingKey) : null
  const effectiveSchedule = saved && cronScheduleProfile(saved) ? saved : (job?.defaultSchedule ?? null)
  const derived = cronRateLimitFor(jobName, effectiveSchedule)
  const baseMax = options.max ?? derived.max
  const max = applyE2eMaxOverride(jobName, baseMax)
  const windowMs = options.windowMs ?? derived.windowMs
  const checker = options.checker ?? checkRateLimit
  const sourceIp = options.request ? getClientIp(options.request.headers) : null
  let result = await checker(
    cronRateLimitKey(jobName, sourceIp),
    max,
    windowMs,
  )

  // Under a CAPPED E2E override, the IP-scoped bucket above is per-caller; this second, IP-independent
  // bucket makes the ceiling tenant-wide (see e2eGlobalCapFor). Checked only AFTER the IP bucket allows, so
  // a caller already denied on its own slice does not also burn the shared allowance. Null in production.
  const globalCap = e2eGlobalCapFor(jobName, baseMax)
  if (result.allowed && globalCap != null) {
    // E2E_GLOBAL_CAP_WINDOW_MS, NOT the job's own window: the quota being protected is daily, so an hourly
    // ceiling would allow ~480 live calls a day and bound nothing that matters.
    result = await checker(cronRateLimitGlobalKey(jobName), globalCap, E2E_GLOBAL_CAP_WINDOW_MS)
  } else if (result.allowed && XERO_LIVE_CRON_JOBS.has(jobName) && max === baseMax && effectiveSchedule) {
    // PRODUCTION (no E2E raise in effect): a live-Xero job also spends an IP-independent rolling daily run budget, so
    // rotating source addresses with a leaked secret cannot multiply cron runs (a run budget, not a Xero call budget).
    result = await checker(
      cronRateLimitDailyBudgetKey(jobName),
      cronXeroDailyBudget(effectiveSchedule),
      E2E_GLOBAL_CAP_WINDOW_MS,
    )
  }

  if (result.allowed) return null

  return NextResponse.json(
    {
      error: 'Cron job rate limited',
      jobName,
      retryAfterSec: result.retryAfterSec,
    },
    {
      status: 429,
      headers: {
        'Retry-After': String(result.retryAfterSec),
      },
    },
  )
}
