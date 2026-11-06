import { NextResponse } from 'next/server'

import '@/lib/cron-jobs'
import { getAllCronJobs } from '@/lib/cron-registry'
import { checkRateLimit, type RateLimitResult } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/request-ip'

/** Fallback limit for a job that is not in the cron registry: two runs per hour, never exactly the cadence. */
export const CRON_RATE_LIMIT_MAX = 2
export const CRON_RATE_LIMIT_WINDOW_MS = 60 * 60_000
export const CRON_RATE_LIMIT_FIFTEEN_MINUTE_MAX = 6

const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS

export type CronRateLimit = { max: number; windowMs: number }

/** Expand one cron field (`*`, `a`, `a-b`, lists, optional `/step`) to its sorted values, or null. */
function expandCronField(field: string, min: number, max: number): number[] | null {
  const out = new Set<number>()
  for (const part of field.split(',')) {
    const [range, stepRaw, extra] = part.split('/')
    if (extra !== undefined) return null
    const step = stepRaw === undefined ? 1 : Number(stepRaw)
    if (!Number.isInteger(step) || step < 1) return null
    let lo: number
    let hi: number
    if (range === '*') {
      lo = min
      hi = max
    } else if (/^\d+$/.test(range)) {
      lo = Number(range)
      hi = stepRaw === undefined ? lo : max
    } else if (/^\d+-\d+$/.test(range)) {
      ;[lo, hi] = range.split('-').map(Number)
    } else {
      return null
    }
    if (lo < min || hi > max || lo > hi) return null
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out.size > 0 ? [...out].sort((a, b) => a - b) : null
}

/** Smallest cyclic gap between consecutive values in a period (a single value gaps a whole period). */
function minCyclicGap(values: number[], period: number): number {
  let gap = period
  for (let i = 1; i < values.length; i += 1) gap = Math.min(gap, values[i] - values[i - 1])
  if (values.length > 1) gap = Math.min(gap, values[0] + period - values[values.length - 1])
  return gap
}

/**
 * Shortest interval between two firings of a 5-field cron expression, in ms, or null when it cannot be read.
 * Day-of-month / month / day-of-week restrictions only ever lengthen the interval, so they floor it at a day.
 */
export function cronCadenceMs(expression: string): number | null {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const minutes = expandCronField(fields[0], 0, 59)
  const hours = expandCronField(fields[1], 0, 23)
  if (!minutes || !hours) return null
  let cadence: number
  if (minutes.length > 1) cadence = minCyclicGap(minutes, 60) * 60_000
  else if (hours.length === 24) cadence = HOUR_MS
  else cadence = minCyclicGap(hours, 24) * HOUR_MS
  if (fields[2] !== '*' || fields[3] !== '*' || fields[4] !== '*') cadence = Math.max(cadence, DAY_MS)
  return cadence
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

/** Default limit for a job: derived from its registry schedule, or the generic fallback when unknown. */
export function cronRateLimitFor(jobName: string): CronRateLimit {
  const job = getAllCronJobs().find((j) => j.slug === jobName)
  const cadence = job ? cronCadenceMs(job.defaultSchedule) : null
  if (cadence == null) return { max: CRON_RATE_LIMIT_MAX, windowMs: CRON_RATE_LIMIT_WINDOW_MS }
  return cronRateLimitForCadence(cadence)
}

export type CronRateLimitChecker = (
  key: string,
  max: number,
  windowMs: number,
) => Promise<RateLimitResult>

export type CronRateLimitOptions = {
  max?: number
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
  const derived = cronRateLimitFor(jobName)
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
