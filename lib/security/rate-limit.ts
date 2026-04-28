export type RateLimitResult = {
  allowed: boolean
  retryAfterSec: number
  remaining: number
}

export type RateLimitBackend = {
  check(key: string, max?: number, windowMs?: number): Promise<RateLimitResult>
  clear(key: string): Promise<void>
}

export type RateLimitBackendName = 'memory' | 'redis'

let backendPromise: Promise<RateLimitBackend> | null = null
let backendSignature: string | null = null

export function getConfiguredRateLimitBackendName(
  env?: { RATE_LIMIT_BACKEND?: string },
): RateLimitBackendName {
  const source = env ?? (process.env as { RATE_LIMIT_BACKEND?: string })
  const value = (source.RATE_LIMIT_BACKEND ?? 'memory').trim().toLowerCase()
  if (value === '' || value === 'memory') return 'memory'
  if (value === 'redis') return 'redis'
  throw new Error(`Unsupported RATE_LIMIT_BACKEND "${source.RATE_LIMIT_BACKEND}"`)
}

function getBackendSignature(): string {
  return [
    getConfiguredRateLimitBackendName(),
    process.env.REDIS_URL ?? '',
  ].join(':')
}

async function createRateLimitBackend(): Promise<RateLimitBackend> {
  const name = getConfiguredRateLimitBackendName()
  if (name === 'memory') {
    const { memoryRateLimitBackend } = await import('./rate-limit-memory')
    return memoryRateLimitBackend
  }

  const redisUrl = process.env.REDIS_URL
  if (!redisUrl) throw new Error('RATE_LIMIT_BACKEND=redis requires REDIS_URL')

  const { RedisRateLimitBackend } = await import('./rate-limit-redis')
  return new RedisRateLimitBackend(redisUrl)
}

export async function getRateLimitBackend(): Promise<RateLimitBackend> {
  const signature = getBackendSignature()
  if (!backendPromise || backendSignature !== signature) {
    backendSignature = signature
    backendPromise = createRateLimitBackend()
  }
  return backendPromise
}

export async function checkRateLimit(
  key: string,
  max = 5,
  windowMs = 5 * 60_000,
): Promise<RateLimitResult> {
  const backend = await getRateLimitBackend()
  return backend.check(key, max, windowMs)
}

export async function clearRateLimit(key: string): Promise<void> {
  const backend = await getRateLimitBackend()
  await backend.clear(key)
}

export function resetRateLimitBackendForTests(): void {
  backendPromise = null
  backendSignature = null
}
