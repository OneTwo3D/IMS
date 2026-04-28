import type { RateLimitBackend, RateLimitResult } from './rate-limit'

export class MemoryRateLimitBackend implements RateLimitBackend {
  private readonly buckets = new Map<string, number[]>()

  constructor(private readonly now: () => number = () => Date.now()) {}

  async check(key: string, max = 5, windowMs = 5 * 60_000): Promise<RateLimitResult> {
    const now = this.now()
    const cutoff = now - windowMs
    const arr = this.buckets.get(key) ?? []

    let start = 0
    while (start < arr.length && arr[start] < cutoff) start += 1
    const live = start === 0 ? arr : arr.slice(start)

    if (live.length >= max) {
      const oldest = live[0] ?? now
      const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000))
      this.buckets.set(key, live)
      return { allowed: false, retryAfterSec, remaining: 0 }
    }

    live.push(now)
    this.buckets.set(key, live)
    return { allowed: true, retryAfterSec: 0, remaining: Math.max(0, max - live.length) }
  }

  async clear(key: string): Promise<void> {
    this.buckets.delete(key)
  }
}

export const memoryRateLimitBackend = new MemoryRateLimitBackend()
