/**
 * The organisation's financial year, for reading stored ledger balances. No database client is imported here.
 *
 * A Xero Trial Balance row is a YEAR-TO-DATE figure. For a balance-sheet account (inventory, allocated inventory, stock in
 * transit, unearned revenue, bank, equity, ...) that is the lifetime balance, so closing minus opening is the period movement.
 * For a profit-and-loss account (revenue, expense, direct costs such as COGS) the YTD figure restarts from zero at the start of
 * each financial year, so closing minus opening across a financial-year start is NOT a movement. Such a window must be withheld
 * with a named reason, never turned into a number.
 */
import { normalizeBalanceDate } from '@/lib/domain/accounting/balance-date'

const DAY_MS = 24 * 60 * 60 * 1000

/** Account types that carry a lifetime balance. Anything NOT in this list (including an unknown type) is treated as periodic. */
const LIFETIME_BALANCE_ACCOUNT_TYPES = new Set([
  'ASSET', 'BANK', 'CURRENT', 'CURRLIAB', 'EQUITY', 'FIXED', 'INVENTORY', 'LIABILITY', 'NONCURRENT', 'PAYG', 'PREPAYMENT',
  'SUPERANNUATIONLIABILITY', 'TERMLIAB', 'WAGESPAYABLELIABILITY',
])

export function isLifetimeBalanceAccountType(type: string | null | undefined): boolean {
  return typeof type === 'string' && LIFETIME_BALANCE_ACCOUNT_TYPES.has(type.trim().toUpperCase())
}

export function formatFinancialYearEnd(month: unknown, day: unknown): string | null {
  if (typeof month !== 'number' || typeof day !== 'number' || !Number.isInteger(month) || !Number.isInteger(day)) return null
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const daysInMonth = new Date(Date.UTC(2024, month, 0)).getUTCDate() // leap year: 29 Feb is a valid year end
  if (day > daysInMonth) return null
  return `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function parseFinancialYearEnd(value: string | null | undefined): { month: number; day: number } | null {
  const match = typeof value === 'string' ? /^(\d{2})-(\d{2})$/.exec(value.trim()) : null
  if (!match) return null
  return formatFinancialYearEnd(Number(match[1]), Number(match[2])) ? { month: Number(match[1]), day: Number(match[2]) } : null
}

/** The first day of a financial year falls in (opening, closing]: the YTD of a P&L account restarted inside the window. */
export function windowCrossesFinancialYearStart(opening: Date | string, closing: Date | string, yearEnd: { month: number; day: number }): boolean {
  const from = normalizeBalanceDate(opening).getTime()
  const to = normalizeBalanceDate(closing).getTime()
  const firstYear = normalizeBalanceDate(opening).getUTCFullYear() - 1
  const lastYear = normalizeBalanceDate(closing).getUTCFullYear() + 1
  for (let year = firstYear; year <= lastYear; year += 1) {
    // 29 Feb in a non-leap year ends on 28 Feb.
    const lastDay = Math.min(yearEnd.day, new Date(Date.UTC(year, yearEnd.month, 0)).getUTCDate())
    const start = Date.UTC(year, yearEnd.month - 1, lastDay) + DAY_MS
    if (start > from && start <= to) return true
  }
  return false
}
