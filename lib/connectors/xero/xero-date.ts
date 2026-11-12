/**
 * Xero date parsing, in one place.
 *
 * Xero serialises dates two ways and a caller cannot know which it will get:
 *   - the .NET form `/Date(1750000000000+0000)/` (milliseconds since the epoch, optional offset)
 *   - ISO 8601, usually WITHOUT a zone (`2026-07-01T00:00:00`) — Xero's `...UTC` fields and
 *     `FullyPaidOnDate` are UTC, so a zone-less value is read as UTC, never as the host's local time.
 *
 * `new Date(value)` reads the first form as an Invalid Date and the second in the host's zone, so
 * nothing that parses a Xero date may call it directly.
 */

const DOT_NET = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/
// A date-time with a time part and no zone designator (Z or +hh:mm / +hhmm / -hh:mm).
const ISO_NO_ZONE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/

/** Epoch milliseconds, or NaN for anything absent or unparseable — callers fail closed on NaN. */
export function parseXeroDate(value: string | undefined | null): number {
  if (typeof value !== 'string') return NaN
  const trimmed = value.trim()
  if (!trimmed) return NaN
  const dotNet = DOT_NET.exec(trimmed)
  if (dotNet) return Number(dotNet[1])
  if (ISO_NO_ZONE.test(trimmed)) return Date.parse(`${trimmed.replace(' ', 'T')}Z`)
  return Date.parse(trimmed)
}

/** A valid Date, or null if the value is absent/unparseable. NEVER falls back to "now". */
export function parseXeroDateOrNull(value: string | undefined | null): Date | null {
  const ms = parseXeroDate(value)
  if (!Number.isFinite(ms)) return null
  const d = new Date(ms)
  return Number.isFinite(d.getTime()) ? d : null
}
