/**
 * Best-effort, per-process throttle for warnings a repeating job would otherwise write on every tick.
 * `shouldEmitWarning(key)` is true at most once per `windowMs` for a key. In-process on purpose: a restart or a
 * second instance may repeat a warning, which is harmless; losing the first one is not.
 */
const lastEmitted = new Map<string, number>()
const MAX_KEYS = 1000

export function shouldEmitWarning(key: string, windowMs = 60 * 60_000, now = Date.now()): boolean {
  const last = lastEmitted.get(key)
  if (last !== undefined && now - last < windowMs) return false
  if (lastEmitted.size >= MAX_KEYS) {
    for (const [k, t] of lastEmitted) if (now - t >= windowMs) lastEmitted.delete(k)
    if (lastEmitted.size >= MAX_KEYS) lastEmitted.clear()
  }
  lastEmitted.set(key, now)
  return true
}

export function resetWarningThrottleForTests(): void {
  lastEmitted.clear()
}
