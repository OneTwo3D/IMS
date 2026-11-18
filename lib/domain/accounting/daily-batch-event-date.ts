/**
 * Daily-batch journal dates (audit ACC-H11).
 *
 * The daily batch used to date EVERY journal it raised with the UTC day the batch ran. An order paid,
 * invoiced and shipped on 31 March was deferred, reclassified, recognised and costed on 1 April, which
 * overstates March margin and leaves the inventory/COGS reconciliations comparing a subledger dated by
 * event with a ledger dated by batch run.
 *
 * THE RULE. A journal is dated the day of the EVENT it records, on the BUSINESS (London) day (see `businessDay`):
 *
 *   Group A1 (revenue deferral)          the day the order was PAID
 *   Group A2 (inventory reclassification) the later of the day it was paid and the day its stock was allocated
 *   Group B  (revenue recognition + COGS) the later of the day the shipment shipped and the day the order was paid
 *
 * Group B waits for the deferral, so a shipment that left before payment cannot be recognised earlier
 * than the payment that created the Unearned Revenue it draws on.
 *
 * ONE JOURNAL PER DATE. A run's rows are grouped by their resolved date and each group is its own journal
 * with its own `referenceId` (`<group>-<date>-<digest>`). That keeps the persisted reference the batch's
 * identity AND its journal date (see daily-batch-reference.ts), so the recreate sweep and every other
 * consumer of the reference needs no change.
 *
 * LOCKED PERIODS. A journal dated inside a locked Xero period is rejected. The lock date is IMPORTED from Xero
 * (books-lock-date.ts) as `xero_books_lock_date` (the last LOCKED day, `YYYY-MM-DD`). An event on or before it
 * is NOT back-dated: its journal is dated the first open day (the day after the lock), the narration says so,
 * and the run raises a WARNING activity entry. If that first open day is after the run's date (the lock reaches
 * today) there is no open day at all: nothing is staged for those events, a warning says so, and they wait for
 * a later run. With no lock date known the event date is used as is.
 */

import { businessDateYmd } from '@/lib/business-date'

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/

/** The UTC calendar day (`YYYY-MM-DD`) of an instant, or null when absent or invalid. */
export function utcDay(value: Date | string | null | undefined): string | null {
  if (value == null) return null
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString().slice(0, 10)
}

/**
 * The BUSINESS (Europe/London) calendar day of an instant, or null when absent or invalid. EVERY event day of the batch (paid, shipped, allocated, refunded) is read
 * on this day, so the deferral, the reclassification, the recognition and the COGS agree with the invoice, the receipt and the refund's own legs, which are dated on it
 * too (a payment at 23:30 UTC in BST is the next London day). The run's own day is the London day as well, so no event day is ever after it.
 */
export function businessDay(value: Date | string | null | undefined): string | null {
  if (value == null) return null
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return businessDateYmd(date)
}

/** `YYYY-MM-DD` that is a real calendar date, or null. Anything else is refused rather than guessed at. */
export function parseBatchDay(raw: string | null | undefined): string | null {
  const text = (raw ?? '').trim()
  const match = DAY.exec(text)
  if (!match) return null
  const parsed = new Date(`${text}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) return null
  return text
}

/** The later of several days; nulls are ignored; null only when every input is null. */
export function laterDay(...days: Array<string | null | undefined>): string | null {
  let best: string | null = null
  for (const day of days) {
    if (day && (best === null || day > best)) best = day
  }
  return best
}

function nextDay(day: string): string {
  const next = new Date(`${day}T00:00:00.000Z`)
  next.setUTCDate(next.getUTCDate() + 1)
  return next.toISOString().slice(0, 10)
}

export type ResolvedPostingDate = {
  /** The day the journal is dated, or null when NO open day exists yet (the lock reaches today): the event waits. */
  date: string | null
  /** The event's own day, as resolved before any lock handling. */
  eventDay: string
  /** Set only when the event fell in a locked period and the journal was moved to the first open day. */
  movedFromLockedDay: string | null
}

/**
 * Resolve the journal date for an event day.
 *
 * - no event day (the row carries no usable timestamp): the run's own date, as before;
 * - an event day after the run's date (clock skew, a future-dated stamp): the run's date, never a future
 *   journal;
 * - an event day on or before `lockDate`: the first open day, `lockDate + 1`, and ONLY if that is not after the
 *   run's date. If it is (the lock reaches today or later) there is no open day to post on: `date` is null, the
 *   event is DEFERRED and nothing may be staged for it this run. A date on or before the lock is never returned.
 */
export function resolvePostingDate(
  eventDay: string | null | undefined,
  context: { today: string; lockDate: string | null },
): ResolvedPostingDate {
  const { today, lockDate } = context
  const day = eventDay && eventDay <= today ? eventDay : today
  if (lockDate && day <= lockDate) {
    const firstOpen = nextDay(lockDate)
    return { date: firstOpen <= today ? firstOpen : null, eventDay: day, movedFromLockedDay: day }
  }
  return { date: day, eventDay: day, movedFromLockedDay: null }
}

/** True when the lock reaches the run's own date, so NO journal can be dated on an open day this run. */
export function lockBlocksRun(context: { today: string; lockDate: string | null }): boolean {
  return context.lockDate !== null && context.lockDate >= context.today
}

/** The operator-facing sentence logged when a run stages nothing because the lock reaches today. */
export function lockBlocksRunMessage(group: string, lockDate: string): string {
  return `Xero books are locked up to ${lockDate}, after today; daily batch group ${group} events wait until the lock is moved or the period opens. Nothing was staged for them this run; they are picked up on a later run.`
}

export type PostingDateGroup<T> = {
  date: string
  rows: T[]
  /** Distinct locked event days whose rows were moved into this group's date. */
  movedFromLockedDays: string[]
}

/** Group rows by resolved journal date, in ascending date order; rows keep their input order within a group. Rows with no open day are returned as `deferred`, never grouped. */
export function groupByPostingDate<T>(
  rows: readonly T[],
  eventDayOf: (row: T) => string | null | undefined,
  context: { today: string; lockDate: string | null },
): { groups: Array<PostingDateGroup<T>>; deferred: T[] } {
  const groups = new Map<string, PostingDateGroup<T>>()
  const deferred: T[] = []
  for (const row of rows) {
    const resolved = resolvePostingDate(eventDayOf(row), context)
    if (resolved.date === null) {
      deferred.push(row)
      continue
    }
    let group = groups.get(resolved.date)
    if (!group) {
      group = { date: resolved.date, rows: [], movedFromLockedDays: [] }
      groups.set(resolved.date, group)
    }
    group.rows.push(row)
    if (resolved.movedFromLockedDay && !group.movedFromLockedDays.includes(resolved.movedFromLockedDay)) {
      group.movedFromLockedDays.push(resolved.movedFromLockedDay)
    }
  }
  return { groups: [...groups.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)), deferred }
}

/** The sentence appended to a journal's narration when its events were moved out of a locked period. */
export function lockedPeriodNarration(movedFromLockedDays: readonly string[], lockDate: string | null): string {
  if (movedFromLockedDays.length === 0) return ''
  return ` Event date(s) ${[...movedFromLockedDays].sort().join(', ')} fall in a locked period (locked through ${lockDate ?? 'unknown'}), so this journal is dated the first open day instead.`
}

/** True when a journal dated `day` would land on or before the lock date. An unreadable day is not judged here. */
export function isOnOrBeforeLock(day: string | null | undefined, lockDate: string | null): boolean {
  return !!lockDate && !!day && day <= lockDate
}

/** The operator-facing warning for a requeue, recreate or reconcile that was skipped because its date is locked. */
export function lockedJournalSkipMessage(what: string, day: string, lockDate: string): string {
  return `${what} is dated ${day}, on or before the Xero books lock date ${lockDate}, so it was not queued (locked period).`
}
