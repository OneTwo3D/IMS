import { db } from '@/lib/db'
import { EMAIL_RECIPIENT_ERASED_REASON, ERASED_RECIPIENT_PLACEHOLDER } from './email-recipient'

/**
 * THE RECONCILE PASS for outbox rows the erasure could not finish in its own transaction.
 *
 * The erasure replaces the address on every row it can see, including rows claimed by a sender (it changes only the
 * address, never the claim). What it cannot see is a row that appears or changes AFTER it commits: a row queued from a
 * stale read, or a claimed row the erasure raced with. This sweep finds every outbox row for an ERASED order that still
 * holds an address, replaces the address, and cancels the ones not yet sent (PENDING, PARKED_SEND_CAP). A row that is
 * still PROCESSING keeps its status and claim (the sender's own fenced terminal write settles it) and loses only the
 * address, which the sender's recipient confirm then refuses. It runs from the email-outbox cron after each drain, and
 * is idempotent.
 */
export async function reconcileErasedEmailOutbox(): Promise<{ addressesErased: number; cancelled: number }> {
  const cancelled = await db.$executeRaw`
    UPDATE "email_outbox" e
       SET "toEmail" = ${ERASED_RECIPIENT_PLACEHOLDER}, "status" = 'FAILED'::"EmailOutboxStatus", "lastError" = ${EMAIL_RECIPIENT_ERASED_REASON}
      FROM "sales_orders" o
     WHERE e."referenceType" = 'SalesOrder' AND e."referenceId" = o."id" AND o."erasedAt" IS NOT NULL
       AND e."toEmail" <> ${ERASED_RECIPIENT_PLACEHOLDER}
       AND e."status"::text IN ('PENDING', 'PARKED_SEND_CAP')`
  const addressesErased = await db.$executeRaw`
    UPDATE "email_outbox" e
       SET "toEmail" = ${ERASED_RECIPIENT_PLACEHOLDER}
      FROM "sales_orders" o
     WHERE e."referenceType" = 'SalesOrder' AND e."referenceId" = o."id" AND o."erasedAt" IS NOT NULL
       AND e."toEmail" <> ${ERASED_RECIPIENT_PLACEHOLDER}
       AND e."status"::text IN ('PROCESSING', 'SENT', 'FAILED')`
  return { addressesErased: Number(addressesErased) + Number(cancelled), cancelled: Number(cancelled) }
}
