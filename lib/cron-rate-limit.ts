import { NextResponse } from 'next/server'

import { checkRateLimit, type RateLimitResult } from '@/lib/rate-limit'

export const CRON_RATE_LIMIT_MAX = 1
export const CRON_RATE_LIMIT_WINDOW_MS = 60 * 60_000

export type CronRateLimitChecker = (
  key: string,
  max: number,
  windowMs: number,
) => Promise<RateLimitResult>

export type CronRateLimitOptions = {
  max?: number
  windowMs?: number
  checker?: CronRateLimitChecker
}

export function cronRateLimitKey(jobName: string): string {
  return `cron:${jobName}`
}

export async function enforceCronRateLimit(
  jobName: string,
  optionsOrChecker: CronRateLimitOptions | CronRateLimitChecker = {},
): Promise<Response | null> {
  const options = typeof optionsOrChecker === 'function'
    ? { checker: optionsOrChecker }
    : optionsOrChecker
  const max = options.max ?? CRON_RATE_LIMIT_MAX
  const windowMs = options.windowMs ?? CRON_RATE_LIMIT_WINDOW_MS
  const checker = options.checker ?? checkRateLimit
  const result = await checker(
    cronRateLimitKey(jobName),
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
