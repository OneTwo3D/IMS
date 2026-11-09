/**
 * THE OPTIONAL `dispatchedAt` COLUMN OF THE TRANSFERS CSV IMPORT.
 *
 * A transfer that was really dispatched before the first load would otherwise show the IMPORT time as its dispatch time, and
 * the stranded-in-transit warning (which counts days from the dispatch) would start late. The column carries the incumbent
 * system's dispatch moment. It only moves the stamp: stock, FIFO consumption and journals still happen at import time.
 *
 * ACCEPTED FORMS
 *   - `YYYY-MM-DD`: the day, read as 12:00 Europe/London (the UK rule). Noon keeps the day stable under DST and under the
 *     UTC-versus-London midnight shift. A date that is TODAY in London and whose noon has not arrived yet is stamped `now`
 *     rather than refused: it is the same day.
 *   - ISO-8601 with an explicit offset (`2026-10-20T14:30:00Z`, `...+01:00`): that instant.
 * Anything else is refused by name, never guessed: a bare local date-time has no zone, and `20/10/2026` is ambiguous.
 *
 * REFUSED: a moment in the future; a moment more than MAX_DISPATCH_AGE_DAYS before now (a typo such as 2062, or a date from
 * a previous year's file). "Not before the transfer's creation" cannot be a rule here, because the transfer is created in the
 * same run, so every back-dated value precedes its creation.
 */

export const MAX_DISPATCH_AGE_DAYS = 366

const LONDON = 'Europe/London'
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/
const ISO_WITH_OFFSET = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):?(\d{2}))$/

export type DispatchDateResult = { ok: true; value: Date } | { ok: false; error: string }

function isRealCalendarDate(year: number, month: number, day: number): boolean {
  const probe = new Date(Date.UTC(year, month - 1, day))
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day
}

function londonOffsetMinutes(at: Date): number {
  const part = new Intl.DateTimeFormat('en-GB', { timeZone: LONDON, timeZoneName: 'longOffset' })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT'
  const m = /GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(part)
  if (!m || !m[1]) return 0
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
}

function londonDateString(at: Date): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: LONDON, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
  return p // en-CA is YYYY-MM-DD
}

/** 12:00 Europe/London on the given calendar day. */
export function londonNoon(year: number, month: number, day: number): Date {
  const utcNoon = Date.UTC(year, month - 1, day, 12, 0, 0)
  // The offset in force at that day: evaluated at the UTC-noon instant, which is on the same London date in every season.
  return new Date(utcNoon - londonOffsetMinutes(new Date(utcNoon)) * 60_000)
}

export function parseTransferDispatchedAt(raw: string, now: Date): DispatchDateResult {
  const text = raw.trim()
  let value: Date
  const dateOnly = DATE_ONLY.exec(text)
  if (dateOnly) {
    const [year, month, day] = [Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3])]
    if (!isRealCalendarDate(year, month, day)) return { ok: false, error: `dispatchedAt "${text}" is not a real calendar date` }
    value = londonNoon(year, month, day)
    if (text === londonDateString(now) && value.getTime() > now.getTime()) value = new Date(now.getTime())
  } else if (ISO_WITH_OFFSET.test(text)) {
    // `new Date` ROLLS an impossible component over (2026-02-30 becomes 2 March, T24:00 becomes the next day): every component of the
    // text is checked as written, not just the instant it parses to.
    const c = ISO_WITH_OFFSET.exec(text)!
    const [year, month, day, hour, minute, second] = [Number(c[1]), Number(c[2]), Number(c[3]), Number(c[4]), Number(c[5]), Number(c[6] ?? 0)]
    const offsetHours = c[7] === undefined ? 0 : Number(c[7])
    const offsetMinutes = c[8] === undefined ? 0 : Number(c[8])
    if (!isRealCalendarDate(year, month, day) || hour > 23 || minute > 59 || second > 59 || offsetHours > 23 || offsetMinutes > 59) {
      return { ok: false, error: `dispatchedAt "${text}" is not a real calendar date and time` }
    }
    value = new Date(text.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
    if (Number.isNaN(value.getTime())) return { ok: false, error: `dispatchedAt "${text}" is not a valid date-time` }
  } else {
    return { ok: false, error: `dispatchedAt "${text}" must be YYYY-MM-DD (read as 12:00 UK time) or an ISO-8601 date-time with a zone offset, e.g. 2026-10-20T14:30:00Z` }
  }
  if (value.getTime() > now.getTime()) return { ok: false, error: `dispatchedAt "${text}" is in the future` }
  if (now.getTime() - value.getTime() > MAX_DISPATCH_AGE_DAYS * 86_400_000) {
    return { ok: false, error: `dispatchedAt "${text}" is more than ${MAX_DISPATCH_AGE_DAYS} days before the import` }
  }
  return { ok: true, value }
}
