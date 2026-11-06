import { db } from '@/lib/db'
import { EMAIL_RECIPIENT_ERASED_REASON, ERASED_RECIPIENT_PLACEHOLDER } from '@/lib/domain/erasure/email-recipient'

/**
 * THE INVALID-RECIPIENT OUTCOME OF A SALES-ORDER EMAIL, WRITTEN UNDER THE ORDER LOCK (production only; the in-memory harness has no order
 * table and keeps its own path).
 *
 * When the mail server rejects an address, the drain records two things: a suppression row (the address, and the server's raw text, which
 * can echo the address) and the failed outbox row (the same raw text in lastError). If the order's person has been erased those must not be
 * written. So both are written in ONE transaction that first locks the order row (the lock the erasure takes) and reads the order's and its
 * customer's erasure markers: erased means NO suppression row, and the outbox row is failed with a fixed identity-free reason and the
 * placeholder address. The outbox write keeps the claim fence (id, status PROCESSING, lockedBy, processingStartedAt), so a worker whose
 * claim was taken over still writes nothing. Returns whether the fenced write landed.
 */
export async function writeInvalidRecipientOutcome(input: {
  orderId: string
  claim: { id: string; token: string; claimedAt: Date }
  normalizedRecipient: string
  suppressionReason: string
  now: Date
  settleData: Record<string, unknown>
}): Promise<boolean> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "sales_orders" WHERE id = ${input.orderId} FOR UPDATE`
    const order = await tx.salesOrder.findUnique({ where: { id: input.orderId }, select: { erasedAt: true, customer: { select: { gdprAnonymisedAt: true } } } })
    const erased = Boolean(order?.erasedAt || order?.customer?.gdprAnonymisedAt)
    if (!erased) {
      await tx.emailSuppression.upsert({
        where: { email: input.normalizedRecipient },
        create: { email: input.normalizedRecipient, reason: input.suppressionReason, source: 'smtp', lastHitAt: input.now },
        update: { reason: input.suppressionReason, source: 'smtp', lastHitAt: input.now },
      })
    }
    const data = erased
      ? { ...input.settleData, status: 'FAILED', toEmail: ERASED_RECIPIENT_PLACEHOLDER, lastError: EMAIL_RECIPIENT_ERASED_REASON }
      : input.settleData
    const settled = await tx.emailOutbox.updateMany({
      where: { id: input.claim.id, status: 'PROCESSING', lockedBy: input.claim.token, processingStartedAt: input.claim.claimedAt },
      data: { ...data, lockedBy: null } as never,
    })
    return settled.count > 0
  })
}

export type InvalidRecipientWriter = typeof writeInvalidRecipientOutcome
