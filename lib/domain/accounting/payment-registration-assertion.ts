import type { Prisma } from '@/app/generated/prisma/client'
import { logActivityInTransaction } from '@/lib/activity-log'
import { lockSalesOrder } from '@/lib/domain/sales/allocation-service'
import { PAYMENT_REGISTRATION_TYPE, hasPostEvidence } from '@/lib/domain/accounting/payment-ledger-hold'
import { OPERATOR_ASSERTION_SETTLEMENT_BASIS } from '@/lib/domain/accounting/sync-row-settlement'

/**
 * o3d-5fx28 (owner decision 2026-11-18): AN ADMIN MAY ASSERT THAT A RETIRED PAYMENT REGISTRATION NEVER EXISTED IN THE LEDGER.
 *
 * THE ROW CLASS: an INVOICE_PAYMENT sync row that is CANCELLED, carries no document id, no settlement basis and no pre-call stamp
 * (`abandonedBeforeRemoteCall` is not true): a registration retired before the pre-call stamp existed, or after a worker had picked it
 * up. Nothing on it can say it was never sent, so it reads UNDECIDED and deletePayment refuses for ever; the only evidence-based exit
 * (reverseLedgerPayment with a reference the ledger confirms DELETED) needs a payment reference that does not exist when the payment
 * never reached the ledger.
 *
 * WHAT THIS DOES: records a durable OPERATOR_ASSERTION audit row (who, when, why) in the same transaction, then stamps the row
 * `abandonedBeforeRemoteCall = true`, which is the record `ledgerStanding` reads as "nothing was sent" (truth-table row 8). That clears the
 * receipt block for this row class and nothing else: a row with a document id, a FAILED / PENDING / PROCESSING row, a row an operator already
 * settled (OPERATOR_ASSERTION basis) and a shadow are all refused here, unchanged. The stamp is a PERSON'S word, not IMS evidence; the audit row
 * says so, and is what distinguishes it from the sweep's own proof.
 *
 * Compare-and-swapped on every fact the class is defined by, under the order lock, so a worker or settlement that changes the row in the
 * window makes this refuse instead of stamping a row that now means something else.
 */

export const PAYMENT_REGISTRATION_ASSERTION_REASON_MIN = 10

export type PaymentRegistrationAssertionRefusalCode = 'reason_required' | 'row_missing' | 'not_in_class' | 'row_moved'
export class PaymentRegistrationAssertionRefused extends Error {
  constructor(readonly code: PaymentRegistrationAssertionRefusalCode, message: string) {
    super(message)
    this.name = 'PaymentRegistrationAssertionRefused'
  }
}

export type PaymentRegistrationAssertionInput = {
  syncLogId: string
  orderId: string
  reason: string
  actorUserId: string
  now?: Date
}

type ClassRow = { type: string; referenceType: string; referenceId: string; status: string; externalTransactionId: string | null; settlementBasis: string | null; abandonedBeforeRemoteCall: boolean | null }

/** True for exactly the row class this assertion may clear. */
export function isAssertableRetiredRegistration(row: ClassRow, orderId: string): boolean {
  return row.type === PAYMENT_REGISTRATION_TYPE
    && row.referenceType === 'SalesOrder'
    && row.referenceId === orderId
    && row.status === 'CANCELLED'
    && !hasPostEvidence(row)
    && row.settlementBasis === null
    && row.abandonedBeforeRemoteCall !== true
}

export async function assertPaymentRegistrationNeverExisted(
  tx: Prisma.TransactionClient,
  input: PaymentRegistrationAssertionInput,
): Promise<{ syncLogId: string }> {
  const reason = input.reason.trim().slice(0, 500)
  if (reason.length < PAYMENT_REGISTRATION_ASSERTION_REASON_MIN) {
    throw new PaymentRegistrationAssertionRefused('reason_required', `Say why you are sure (at least ${PAYMENT_REGISTRATION_ASSERTION_REASON_MIN} characters): this is recorded against your name.`)
  }
  const now = input.now ?? new Date()
  await lockSalesOrder(tx, input.orderId)
  const row = await tx.accountingSyncLog.findUnique({
    where: { id: input.syncLogId },
    select: { id: true, connector: true, type: true, referenceType: true, referenceId: true, status: true, externalTransactionId: true, settlementBasis: true, abandonedBeforeRemoteCall: true, errorMessage: true },
  })
  if (!row) throw new PaymentRegistrationAssertionRefused('row_missing', 'That accounting entry no longer exists, so nothing was changed.')
  if (!isAssertableRetiredRegistration(row, input.orderId)) {
    throw new PaymentRegistrationAssertionRefused('not_in_class', 'Only a retired (cancelled) payment registration with no payment reference and no earlier operator decision can be asserted as never having existed. Nothing was changed.')
  }
  const note = `Operator asserted this registration never existed in the accounting system (${now.toISOString()}): ${reason}`
  // The audit row first, in THIS transaction and not best-effort: the stamp below must never commit without a name beside it.
  await logActivityInTransaction(tx, {
    entityType: 'SYNC',
    entityId: row.id,
    action: 'payment_registration_never_existed_asserted',
    tag: 'sync',
    level: 'WARNING',
    description: `Admin asserted that ${row.connector} ${row.type} for ${row.referenceType} ${row.referenceId} never existed in the accounting system. IMS did not check the accounting system: this is a person's word. ${reason}`,
    metadata: {
      settlementBasis: OPERATOR_ASSERTION_SETTLEMENT_BASIS,
      syncLogId: row.id,
      connector: row.connector,
      type: row.type,
      referenceType: row.referenceType,
      referenceId: row.referenceId,
      priorStatus: row.status,
      priorErrorMessage: row.errorMessage,
      userId: input.actorUserId,
      assertedAt: now.toISOString(),
      reason,
    },
    userId: input.actorUserId,
  })
  const stamped = await tx.accountingSyncLog.updateMany({
    where: { id: row.id, status: 'CANCELLED', externalTransactionId: null, settlementBasis: null, OR: [{ abandonedBeforeRemoteCall: null }, { abandonedBeforeRemoteCall: false }] },
    data: { abandonedBeforeRemoteCall: true, errorMessage: note },
  })
  // THROWN so the audit row rolls back with it.
  if (stamped.count !== 1) throw new PaymentRegistrationAssertionRefused('row_moved', 'That accounting entry changed while this was being recorded, so nothing was changed. Reload and look again.')
  return { syncLogId: row.id }
}
