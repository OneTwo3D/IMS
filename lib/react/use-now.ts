import { useSyncExternalStore } from 'react'

const TICK_MS = 60_000

/** The wall clock rounded down to the minute: stable between two reads inside the same minute, as useSyncExternalStore requires. */
export function minuteFloor(ms: number): number {
  return Math.floor(ms / TICK_MS) * TICK_MS
}

function subscribe(onChange: () => void): () => void {
  const timer = setInterval(onChange, TICK_MS)
  return () => clearInterval(timer)
}

const getSnapshot = () => minuteFloor(Date.now())

/** The current time (minute resolution) for render-time "x minutes ago" / "within 24h" maths; re-renders the caller each minute. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Whole minutes elapsed between an ISO timestamp and `now`. */
export function minutesSince(iso: string, now: number): number {
  return Math.floor((now - new Date(iso).getTime()) / 60000)
}

/** True when `iso` parses and lies at most `windowMs` before `now`. */
export function receivedWithin(iso: string | null | undefined, now: number, windowMs: number): boolean {
  if (!iso) return false
  const receivedAt = Date.parse(iso)
  return Number.isFinite(receivedAt) && now - receivedAt <= windowMs
}
