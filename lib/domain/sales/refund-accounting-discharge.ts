import { Prisma } from '@/app/generated/prisma/client'
import type { RefundAccountingSettlement } from '@/lib/domain/sales/refund-accounting-obligations'
import type { RefundServiceClient } from '@/lib/domain/sales/refund-service'

/**
 * THE ONE WRITE THAT DISCHARGES A REFUND'S ACCOUNTING OBLIGATION (o3d-fj4m).
 *
 * It takes `accountingRetryRequired` down and erases `accountingRetrySyncs`, and it does so in ONE
 * statement together with the one fact the hand-off knows at that moment and nothing else records:
 *
 *   If this refund's UNEARNED_REV_REVERSAL was settled by the "will never exist" decision (the pinned
 *   configuration does not post that type), then no journal exists for it and none ever will, so the
 *   `allocatedReliefAmount` staging recorded for it - "what the journal this refund is about to queue
 *   WILL raise" - is a claim about a posting with no counterpart. It is written down to 0 here, in the
 *   same statement that clears the flag, because the next refund of the order reads an ABSENT journal
 *   as "retention deleted it" (the o3d-o97 r3/r6 reading, sound while every enqueue wrote something)
 *   and counts the recorded amount as relief it never was: it under-credits Allocated Inventory by
 *   exactly those pounds. 0 is the vocabulary the reader already has - a recorded zero is "this refund
 *   raised no CR Allocated line at all" - so no column and no new reading is needed.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: it never touches the amount when the reversal was QUEUED (the
 * journal exists, and the reader resolves the amount against it), and it is never called for a refund
 * whose hand-off refused or threw (the flag stays set; the next refund is blocked by scjz.22 and the
 * reader refuses a flagged refund's relief outright).
 *
 * ONE STATEMENT, NOT TWO: clearing the flag first and zeroing afterwards would leave a window in which
 * the refund no longer blocks the next one and its relief still stands.
 */
export function refundReversalDecidedNeverToPost(
  refundId: string,
  settlement: RefundAccountingSettlement,
): boolean {
  return settlement.decidedNeverToPost.some((obligation) => (
    obligation.type === 'UNEARNED_REV_REVERSAL'
    && obligation.referenceType === 'SalesOrderRefund'
    && obligation.referenceId === refundId
  ))
}

export async function dischargeRefundAccountingObligation(
  client: Pick<RefundServiceClient, 'salesOrderRefund'>,
  refundId: string,
  settlement: RefundAccountingSettlement,
): Promise<void> {
  await client.salesOrderRefund.update({
    where: { id: refundId },
    data: {
      accountingRetryRequired: false,
      accountingWarning: null,
      accountingRetrySyncs: Prisma.DbNull,
      ...(refundReversalDecidedNeverToPost(refundId, settlement) ? { allocatedReliefAmount: 0 } : {}),
    },
  })
}
