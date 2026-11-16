/**
 * The Xero books lock date, IMPORTED (never typed).
 *
 * `GET /Organisation` (read-only) returns `PeriodLockDate` (the lock for advisers/standard users) and
 * `EndOfYearLockDate` (the lock for everyone). A journal dated on or before the LATER of the two is rejected by
 * Xero for the users it applies to, so the later one is the effective lock. The scope is the one the existing
 * Organisation reads already use (`accounting.settings`); no scope is added.
 *
 * The result is stored in `xero_books_lock_date` (`YYYY-MM-DD`, empty when Xero reports no lock) with
 * `xero_books_lock_date_read_at`, and the daily batch dates nothing on or before it (see daily-batch-event-date.ts).
 *
 * NEVER BLOCKS ITS CALLER. A failed read keeps the last stored value and logs a WARNING; with nothing ever stored
 * the batch simply dates by event, as it did before this setting existed. Nothing here throws.
 */

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { parseBatchDay, laterDay, utcDay } from '@/lib/domain/accounting/daily-batch-event-date'
import { xeroGet } from './api'
import { parseXeroDateOrNull } from './xero-date'

type OrganisationRecord = { PeriodLockDate?: string | null; EndOfYearLockDate?: string | null }
type OrganisationResponse = { Organisations?: OrganisationRecord[]; Organisation?: OrganisationRecord[] }

export const XERO_BOOKS_LOCK_DATE_KEY = 'xero_books_lock_date'
export const XERO_BOOKS_LOCK_DATE_READ_AT_KEY = 'xero_books_lock_date_read_at'

/** The later of the two lock dates as `YYYY-MM-DD`, or null when Xero reports none (or none readable). */
export function effectiveLockDateOf(organisation: OrganisationRecord | undefined): string | null {
  if (!organisation) return null
  return laterDay(
    utcDay(parseXeroDateOrNull(organisation.PeriodLockDate)),
    utcDay(parseXeroDateOrNull(organisation.EndOfYearLockDate)),
  )
}

export type BooksLockDateRefresh = {
  /** The lock date to use now: the fresh read, else the last stored one, else null. */
  lockDate: string | null
  /** True when this call read it from Xero. */
  refreshed: boolean
}

async function warn(description: string): Promise<void> {
  await logActivity({
    entityType: 'SYSTEM',
    action: 'xero_books_lock_date_read_failed',
    tag: 'sync',
    level: 'WARNING',
    description,
    resolveUser: false,
  }).catch(() => { /* a warning that cannot be written must not change what the caller does */ })
}

/**
 * Read the lock date from Xero and store it. `storedFallback` is the value already held (the caller has it from
 * the settings it just loaded) and is what is returned when the read fails.
 */
export async function refreshXeroBooksLockDate(storedFallback: string | null | undefined): Promise<BooksLockDateRefresh> {
  const fallback = parseBatchDay(storedFallback)
  try {
    const res = await xeroGet<OrganisationResponse>('Organisation')
    const organisations = res.data?.Organisations ?? res.data?.Organisation ?? []
    if (!res.ok || organisations.length === 0) {
      await warn(`Could not read the books lock date from Xero (${res.error ?? `status ${res.status}`}); using ${fallback ? `the last stored value ${fallback}` : 'no lock date, so journals are dated by event and Xero rejects any in a locked period'}.`)
      return { lockDate: fallback, refreshed: false }
    }
    const lockDate = effectiveLockDateOf(organisations[0])
    const readAt = new Date().toISOString()
    await db.setting.upsert({ where: { key: XERO_BOOKS_LOCK_DATE_KEY }, create: { key: XERO_BOOKS_LOCK_DATE_KEY, value: lockDate ?? '' }, update: { value: lockDate ?? '' } })
    await db.setting.upsert({ where: { key: XERO_BOOKS_LOCK_DATE_READ_AT_KEY }, create: { key: XERO_BOOKS_LOCK_DATE_READ_AT_KEY, value: readAt }, update: { value: readAt } })
    return { lockDate, refreshed: true }
  } catch (error) {
    await warn(`Could not read the books lock date from Xero (${String(error)}); using ${fallback ? `the last stored value ${fallback}` : 'no lock date'}.`)
    return { lockDate: fallback, refreshed: false }
  }
}
