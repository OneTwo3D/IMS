/**
 * A tiny single-flight TTL cache. The dashboard and the bell both poll; without this each page load
 * (and each 30 s bell poll) would run the heavy count queries itself. A failed load is never cached
 * and never poisons the next call.
 */
export function createTtlCache<T>(load: () => Promise<T>, ttlMs: number, now: () => number = Date.now) {
  let value: { at: number; data: T } | null = null
  let inFlight: Promise<T> | null = null
  return {
    async get(): Promise<T> {
      if (value && now() - value.at < ttlMs) return value.data
      if (inFlight) return inFlight
      inFlight = load()
        .then((data) => {
          value = { at: now(), data }
          return data
        })
        .finally(() => {
          inFlight = null
        })
      return inFlight
    },
    clear() {
      value = null
    },
  }
}
