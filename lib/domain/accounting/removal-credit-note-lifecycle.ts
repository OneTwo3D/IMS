import type { Prisma } from '@/app/generated/prisma/client'
import { compareDecimal, subtractMoney, toDecimal, type Decimal, type DecimalInput } from '@/lib/domain/math/decimal'

// ---------------------------------------------------------------------------
// THE REMOVAL CREDIT NOTE'S LIFE AFTER IT IS RAISED (o3d-hqvrp.395)
// ---------------------------------------------------------------------------
//
// A credit note raised for a partial payment removal waits behind the outbound write hold. If Xero shows the payment BACK before the credit note is released, the
// customer must not be credited for money that was received: the staged credit note is WITHDRAWN (its unsent sync row is cancelled, compare-and-set on PENDING so a
// processor that has already claimed it wins and nothing is half-done). The IMS refund row and the revenue-unwind journals staged with it are NOT deleted here: they
// stay as the record, and the operator is told (by the caller) to review them with the refund removal tools. A credit note already past that point (being sent, or sent) is only reported.

export const REMOVAL_CREDIT_NOTE_WITHDRAWN_REASON = 'Withdrawn before it was sent: the payment it credited was restored in the ledger.'

export type RemovalWithdrawalClient = Pick<Prisma.TransactionClient, 'accountingSyncLog'>

export type RemovalWithdrawal = { refundId: string; outcome: 'withdrawn' | 'not-pending' | 'nothing-staged' }

/** Cancel the credit note's UNSENT sync row, if there is one. Idempotent. */
export async function withdrawStagedRemovalCreditNote(client: RemovalWithdrawalClient, refundId: string): Promise<RemovalWithdrawal> {
  const cancelled = await client.accountingSyncLog.updateMany({
    where: { type: 'CREDIT_NOTE', referenceType: 'SalesOrderRefund', referenceId: refundId, status: 'PENDING', externalTransactionId: null },
    data: { status: 'CANCELLED', errorMessage: REMOVAL_CREDIT_NOTE_WITHDRAWN_REASON, processingStartedAt: null },
  })
  if (cancelled.count > 0) return { refundId, outcome: 'withdrawn' }
  // Not PENDING (the compare-and-set above found nothing to cancel): a row that exists is past the point of withdrawal (being sent, sent, failed or already withdrawn), so it is only reported.
  const rows = await client.accountingSyncLog.count({ where: { type: 'CREDIT_NOTE', referenceType: 'SalesOrderRefund', referenceId: refundId } })
  return { refundId, outcome: rows > 0 ? 'not-pending' : 'nothing-staged' }
}

/**
 * Which credit-noted removals does a restoration of `restored` cover? Newest removal first (the latest money lost is the first to come back); a removal is covered
 * only when the whole of its amount is restored. What is left over, and any removal only partly covered, is for a person.
 */
export function removalsCoveredByRestoration(
  removals: ReadonlyArray<{ id: string; refundId: string; amountForeign: DecimalInput; createdAt: Date }>,
  restored: DecimalInput,
): { covered: string[]; partlyCovered: string[]; leftover: Decimal } {
  let left = toDecimal(restored)
  const covered: string[] = []
  const partlyCovered: string[] = []
  for (const removal of [...removals].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())) {
    if (compareDecimal(left, 0) <= 0) break
    const amount = toDecimal(removal.amountForeign)
    if (compareDecimal(left, amount) >= 0) {
      covered.push(removal.refundId)
      left = subtractMoney(left, amount)
    } else {
      partlyCovered.push(removal.refundId)
      left = toDecimal(0)
    }
  }
  return { covered, partlyCovered, leftover: left }
}
