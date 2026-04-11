/**
 * Lightweight single-process sliding-window rate limiter.
 *
 * Single-instance only: state lives in a Map and is lost on process restart.
 * That is acceptable for the cases we use it in (TOTP verify, auth challenges)
 * because a restart cannot be user-triggered without extra access. Do NOT rely
 * on this for cluster-wide rate limiting.
 */

const buckets = new Map<string, number[]>()

export type RateLimitResult = {
  allowed: boolean
  retryAfterSec: number
  remaining: number
}

/**
 * Check (and record) an attempt for the given key.
 * Returns `allowed=false` if the caller has exceeded `max` attempts in
 * `windowMs`, with a `retryAfterSec` hint.
 */
export function checkRateLimit(
  key: string,
  max = 5,
  windowMs = 5 * 60_000,
): RateLimitResult {
  const now = Date.now()
  const cutoff = now - windowMs

  const arr = buckets.get(key) ?? []
  // Drop timestamps that have aged out of the window.
  let start = 0
  while (start < arr.length && arr[start] < cutoff) start += 1
  const live = start === 0 ? arr : arr.slice(start)

  if (live.length >= max) {
    const oldest = live[0]
    const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000))
    buckets.set(key, live)
    return { allowed: false, retryAfterSec, remaining: 0 }
  }

  live.push(now)
  buckets.set(key, live)
  return { allowed: true, retryAfterSec: 0, remaining: Math.max(0, max - live.length) }
}

/**
 * Manually clear a bucket (e.g. on successful authentication).
 */
export function clearRateLimit(key: string): void {
  buckets.delete(key)
}
