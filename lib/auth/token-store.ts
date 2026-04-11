/**
 * One-time server-side token store for secure auth flows (passkey, TOTP).
 *
 * Tokens are persisted in the `one_time_tokens` table so that they survive
 * `next start` process restarts and are consistent across concurrent requests.
 * Each token is consumed on first use and expires after a short TTL.
 */
import { db } from '@/lib/db'

let cleanupTimer: NodeJS.Timeout | null = null
if (typeof setInterval === 'function' && !cleanupTimer) {
  cleanupTimer = setInterval(() => {
    void db.oneTimeToken
      .deleteMany({ where: { expiresAt: { lt: new Date() } } })
      .catch(() => {
        // Silently ignore — cleanup will run again shortly.
      })
  }, 5 * 60 * 1000)
  // Don't keep the event loop alive just for cleanup.
  if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref()
}

export async function setAuthToken(
  key: string,
  value: string,
  ttlMs = 60_000,
): Promise<void> {
  const expiresAt = new Date(Date.now() + ttlMs)
  await db.oneTimeToken.upsert({
    where: { key },
    create: { key, value, expiresAt },
    update: { value, expiresAt },
  })
}

export async function consumeAuthToken(key: string): Promise<string | null> {
  const entry = await db.oneTimeToken.findUnique({ where: { key } })
  if (!entry) return null
  // Best-effort consume: delete first so a concurrent caller can't re-use it.
  await db.oneTimeToken.delete({ where: { key } }).catch(() => null)
  if (entry.expiresAt.getTime() < Date.now()) return null
  return entry.value
}
