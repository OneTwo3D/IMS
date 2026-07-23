import { NextResponse } from 'next/server'

import { checkRateLimit, type RateLimitResult } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/request-ip'

export const CRON_RATE_LIMIT_MAX = 1
export const CRON_RATE_LIMIT_WINDOW_MS = 60 * 60_000
export const CRON_RATE_LIMIT_FIVE_MINUTE_MAX = 15
export const CRON_RATE_LIMIT_FIFTEEN_MINUTE_MAX = 6

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
 * - Sub-hourly jobs intentionally use headroom above exact cadence. Do not set
 *   a 5-minute cron to exactly 12/hour or a 15-minute cron to exactly 4/hour;
 *   jitter, retries, and boundary timing will deny legitimate scheduled runs.
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
 *   comfortably covers X-04's three sweeps with retry headroom.
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

export async function enforceCronRateLimit(
  jobName: string,
  optionsOrChecker: CronRateLimitOptions | CronRateLimitChecker = {},
): Promise<Response | null> {
  const options = typeof optionsOrChecker === 'function'
    ? { checker: optionsOrChecker }
    : optionsOrChecker
  const baseMax = options.max ?? CRON_RATE_LIMIT_MAX
  const max = applyE2eMaxOverride(jobName, baseMax)
  const windowMs = options.windowMs ?? CRON_RATE_LIMIT_WINDOW_MS
  const checker = options.checker ?? checkRateLimit
  const sourceIp = options.request ? getClientIp(options.request.headers) : null
  const result = await checker(
    cronRateLimitKey(jobName, sourceIp),
    max,
    windowMs,
  )
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
