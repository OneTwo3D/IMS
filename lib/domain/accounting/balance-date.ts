/**
 * The date-only helpers of the account balance snapshots, in a module that imports NOTHING (no database client).
 * lib/domain/accounting/account-balance-snapshots.ts re-exports them. The reconciliation pack imports them from here so that
 * loading its as-of basis does not load lib/db: the invariant run of the same command binds the application's client to one
 * snapshot transaction and needs lib/db to be first imported inside it.
 */

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/

export function normalizeBalanceDate(value: Date | string): Date {
  if (typeof value === 'string') {
    if (!DATE_ONLY_RE.test(value)) throw new Error(`balanceDate must be YYYY-MM-DD: ${value}`)
    const [year, month, day] = value.split('-').map(Number)
    const parsed = new Date(Date.UTC(year!, month! - 1, day!))
    if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month! - 1 || parsed.getUTCDate() !== day) {
      throw new Error(`balanceDate must be a real calendar date: ${value}`)
    }
    return parsed
  }
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()))
}

export function balanceDateString(value: Date | string): string {
  return normalizeBalanceDate(value).toISOString().slice(0, 10)
}
