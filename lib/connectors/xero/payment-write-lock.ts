import { db } from '@/lib/db'

/**
 * Serializes the two jobs that write `paidAt` from Xero — the 15-minute payment poll and the daily
 * backlog reconcile — so neither can act on a Xero read the other has already invalidated (o3d-2s8,
 * Codex review of #496).
 *
 * The race it closes: reconcile reads an invoice PAID; Xero reverses it; the poll fetches that
 * reversal but, finding `paidAt` still null, its reversal pass does nothing and advances its cursor;
 * reconcile then writes `paidAt` on the now-reversed invoice, permanently. Holding this lock across
 * each job's whole read→write means they cannot interleave: while one runs, the other skips its cycle
 * and retries later, and the poll that runs AFTER a reconcile write sees `paidAt` set and can reverse
 * it through its normal reversal pass.
 *
 * Session-scoped advisory lock, matching the daily-batch pattern already in this codebase
 * (daily-sync.ts). A DISTINCT key so it does not contend with that batch.
 */
export const PAYMENT_WRITE_LOCK_KEY = 4_112_208_032

export type LockSkipped = { lockSkipped: true }
export const LOCK_SKIPPED: LockSkipped = { lockSkipped: true }

/**
 * Run `fn` holding the payment-write lock. If another payment-writing job holds it, DO NOT wait —
 * return LOCK_SKIPPED so the caller can defer to its next cycle. Always releases on the way out.
 */
export async function withPaymentWriteLockOrSkip<T>(fn: () => Promise<T>): Promise<T | LockSkipped> {
  const rows = await db.$queryRaw<Array<{ locked: boolean }>>`
    SELECT pg_try_advisory_lock(${PAYMENT_WRITE_LOCK_KEY}) AS locked
  `
  if (!rows[0]?.locked) return LOCK_SKIPPED
  try {
    return await fn()
  } finally {
    await db.$executeRaw`SELECT pg_advisory_unlock(${PAYMENT_WRITE_LOCK_KEY})`
  }
}

export function isLockSkipped(v: unknown): v is LockSkipped {
  return typeof v === 'object' && v !== null && (v as LockSkipped).lockSkipped === true
}
