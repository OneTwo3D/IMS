/**
 * One-time server-side token store for secure auth flows (passkey, TOTP).
 * Tokens are consumed on first use and expire after a short TTL.
 * For multi-instance deployments, replace with Redis.
 */
const store = new Map<string, { value: string; expires: number }>()

// Periodic cleanup of expired tokens (every 5 minutes)
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of store) {
    if (now > entry.expires) store.delete(key)
  }
}, 5 * 60 * 1000)

export function setAuthToken(key: string, value: string, ttlMs = 60_000): void {
  store.set(key, { value, expires: Date.now() + ttlMs })
}

export function consumeAuthToken(key: string): string | null {
  const entry = store.get(key)
  if (!entry) return null
  store.delete(key)
  if (Date.now() > entry.expires) return null
  return entry.value
}
