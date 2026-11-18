import { DEFAULT_TIMEZONE } from '@/lib/format-datetime'

/**
 * The BUSINESS calendar day (YYYY-MM-DD) of an instant: the day it is in the business time zone (Europe/London, so BST is
 * honoured), not the UTC day. An order placed at 00:30 BST on 1 July is dated 1 July, not 30 June, so a document never lands in
 * the previous VAT quarter. Used for the date sent on invoices, credit notes and journals. Pure and synchronous.
 */
export function businessDateYmd(instant: Date, timeZone: string = DEFAULT_TIMEZONE): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

/**
 * The business day of a WooCommerce date stamp that carries a time (`2026-06-30T23:30:00`: GMT with no suffix, or with Z / an offset), so the receipt registered
 * with an invoice is dated on the same London day the invoice is. Null for anything that is not a full timestamp (a bare day is already a day) or is unreadable.
 */
export function businessDateOfStamp(stamp: string, timeZone: string = DEFAULT_TIMEZONE): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(stamp)) return null
  const instant = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/.test(stamp) ? stamp : `${stamp}Z`)
  return Number.isNaN(instant.getTime()) ? null : businessDateYmd(instant, timeZone)
}

/**
 * The instant the business day `ymd` (YYYY-MM-DD) begins: midnight Europe/London, so 23:00 UTC the evening before during BST and
 * 00:00 UTC in winter. Used to find the hours where the UTC day and the business day disagree.
 */
export function businessDayStartInstant(ymd: string, timeZone: string = DEFAULT_TIMEZONE): Date {
  const utcMidnight = new Date(`${ymd}T00:00:00.000Z`)
  // No zone is more than 14h from UTC, and Europe/London is 0 or 1h: try each whole hour back from UTC midnight and take the first
  // that is the first millisecond of `ymd` in the zone.
  for (let hoursBack = -14; hoursBack <= 14; hoursBack += 1) {
    const candidate = new Date(utcMidnight.getTime() - hoursBack * 3_600_000)
    if (businessDateYmd(candidate, timeZone) === ymd && businessDateYmd(new Date(candidate.getTime() - 1), timeZone) !== ymd) return candidate
  }
  return utcMidnight
}
