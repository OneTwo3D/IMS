import { db } from '@/lib/db'

export type InvoiceDocumentHealth = {
  /** Documents that need a person (ambiguous in the ledger, or a number the ledger filter cannot express). */
  needsAttention: number
  /** Documents still being waited for (not issued in the ledger yet, or a retryable failure). */
  pending: number
  /** Age in minutes of the longest-waiting pending document, or null when none is waiting. */
  oldestPendingMinutes: number | null
}

export async function getInvoiceDocumentHealth(now: Date = new Date()): Promise<InvoiceDocumentHealth> {
  const [needsAttention, pending, oldest] = await Promise.all([
    db.invoiceDocumentFetchState.count({ where: { status: 'NEEDS_ATTENTION' } }),
    db.invoiceDocumentFetchState.count({ where: { status: 'PENDING' } }),
    db.invoiceDocumentFetchState.findFirst({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
  ])
  return {
    needsAttention,
    pending,
    oldestPendingMinutes: oldest ? Math.max(0, Math.floor((now.getTime() - oldest.createdAt.getTime()) / 60_000)) : null,
  }
}
