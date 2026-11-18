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
