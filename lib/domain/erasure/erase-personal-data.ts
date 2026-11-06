import { randomUUID } from 'node:crypto'
import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { logActivity, logActivityInTransaction } from '@/lib/activity-log'
import { lockSalesOrder } from '@/lib/domain/sales/allocation-service'
import {
  ERASURE_FAILURE_ACTION,
  ERASURE_FAILURE_DESCRIPTION,
  ERASURE_PLACEHOLDER_EMAIL,
  ERASURE_PLACEHOLDER_FIRST_NAME,
  ERASURE_PLACEHOLDER_LAST_NAME,
  ERASURE_PLACEHOLDER_NAME,
  ERASURE_RECORD_ACTION,
  ERASURE_RECORD_DESCRIPTION,
  buildErasureRecordMetadata,
  type ErasureCounts,
  type ErasureTrigger,
} from './erasure-record'

/**
 * THE ONE PLACE IMS ERASES A DATA SUBJECT'S PERSONAL DATA FROM ITS OWN TABLES.
 *
 * What is ERASED is decided column by column in lib/domain/erasure/erasure-classification.ts, and
 * tests/erasure-schema-classification.test.ts fails when a new personal-data column is not classified.
 * What is deliberately RETAINED is the accounting record: order totals, tax, lines, currency, order numbers,
 * the ledger and Xero ids, the issued invoice PDF (a statutory record, kept for six years) and the refund
 * reason text. Nothing here deletes a row; every table is updated in place, and the Customer row is kept so
 * the erasure record's surrogate still points at something.
 *
 * ORDERING AND LOCKS. The customer row is claimed first with a conditional update (it is the row concurrent
 * erasures contend on), then every order is locked in id order with lockSalesOrder, which is the lock the
 * importers take before writing an order. Because the importers read `erasedAt` under that same lock, an
 * import is either wholly before the erasure (and is then erased) or wholly after it (and is then refused),
 * never interleaved.
 *
 * THIS MAKES NO EXTERNAL CALL. It only changes IMS rows. Raising SalesOrder.updatedAt does mean the warehouse
 * push sweep sees the order as changed, which is why buildPushInput refuses an erased order: an erasure must
 * never turn into an outbound write of the placeholder values, or of anything else.
 */

const CHUNK = 500

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export const NOTIFICATION_ERASED_TITLE = 'Notification redacted'
export const NOTIFICATION_ERASED_MESSAGE = 'The text of this notification was removed by a personal-data erasure.'
export const EMAIL_OUTBOX_ERASED_ERROR = 'Cancelled: the recipient\'s personal data was erased'

/**
 * Erase the personal data held on a set of sales orders and on the rows that hang off them. The caller owns
 * the transaction and MUST have locked every order (lockSalesOrder) before calling.
 */
export async function eraseOrdersPersonalDataInTx(
  tx: Prisma.TransactionClient,
  orderIds: string[],
  erasedAt: Date,
): Promise<Omit<ErasureCounts, 'customers' | 'shoppingCustomerLinks'>> {
  const counts = { salesOrders: 0, shipments: 0, shoppingOrderLinks: 0, wmsStatusSnapshots: 0, outboxRowsErased: 0, outboxRowsDeferred: 0, notifications: 0 }
  for (const ids of chunks(orderIds)) {
    counts.salesOrders += (await tx.salesOrder.updateMany({
      where: { id: { in: ids } },
      data: {
        customerName: ERASURE_PLACEHOLDER_NAME,
        customerEmail: null,
        customerVatNumber: null,
        billingAddress: Prisma.JsonNull,
        shippingAddress: Prisma.JsonNull,
        notes: null,
        internalNotes: null,
        trackingNumber: null,
        erasedAt,
      },
    })).count
    counts.shipments += (await tx.shipment.updateMany({ where: { orderId: { in: ids }, trackingNumber: { not: null } }, data: { trackingNumber: null } })).count
    counts.shoppingOrderLinks += (await tx.shoppingOrderLink.updateMany({ where: { orderId: { in: ids } }, data: { metadata: Prisma.JsonNull } })).count
    counts.wmsStatusSnapshots += (await tx.wmsOrderStatusSnapshot.updateMany({
      where: { orderId: { in: ids } },
      data: { trackingNumber: null, carrier: null, deepLinkUrl: null },
    })).count

    // Outbox rows for these orders. A SENT or FAILED row keeps no address. A row still waiting to be sent is
    // CANCELLED (FAILED), because sending to an erased subject is the harm; that releases its slot in the
    // undelivered-reference unique index, which only matters if the same (kind, order) is queued again, and
    // the email builders refuse an order with no address. A PROCESSING row is mid-send under another
    // worker's claim fence: it is not touched, and is counted so the shortfall is visible.
    const outboxWhere = { referenceType: 'SalesOrder', referenceId: { in: ids } }
    counts.outboxRowsErased += (await tx.emailOutbox.updateMany({
      where: { ...outboxWhere, status: { in: ['SENT', 'FAILED'] }, NOT: { toEmail: ERASURE_PLACEHOLDER_EMAIL } },
      data: { toEmail: ERASURE_PLACEHOLDER_EMAIL },
    })).count
    counts.outboxRowsErased += (await tx.emailOutbox.updateMany({
      where: { ...outboxWhere, status: { in: ['PENDING', 'PARKED_SEND_CAP'] } },
      data: { toEmail: ERASURE_PLACEHOLDER_EMAIL, status: 'FAILED', lastError: EMAIL_OUTBOX_ERASED_ERROR },
    })).count
    counts.outboxRowsDeferred += await tx.emailOutbox.count({ where: { ...outboxWhere, status: 'PROCESSING' } })

    // Notifications are linked to an order only by the URL they point at.
    counts.notifications += (await tx.notification.updateMany({
      where: { OR: ids.flatMap((id) => [{ actionUrl: `/sales/${id}` }, { actionUrl: { startsWith: `/sales/${id}/` } }]) },
      data: { title: NOTIFICATION_ERASED_TITLE, message: NOTIFICATION_ERASED_MESSAGE },
    })).count
  }
  return counts
}

export type EraseCustomerResult =
  | { success: true; requestId: string }
  | { success: false; error: string }

/** Erase a customer and every order linked to them. Idempotent: a second call refuses and changes nothing. */
export async function eraseCustomerPersonalData(
  customerId: string,
  options: { trigger: ErasureTrigger; userId: string | null },
): Promise<EraseCustomerResult> {
  const requestId = randomUUID()
  const erasedAt = new Date()
  try {
    const refusal = await db.$transaction(async (tx): Promise<string | null> => {
      const claimed = await tx.customer.updateMany({
        where: { id: customerId, gdprAnonymisedAt: null },
        data: {
          firstName: ERASURE_PLACEHOLDER_FIRST_NAME,
          lastName: ERASURE_PLACEHOLDER_LAST_NAME,
          email: null,
          phone: null,
          company: null,
          taxNumber: null,
          billingAddress: Prisma.JsonNull,
          shippingAddress: Prisma.JsonNull,
          notes: null,
          externalCustomerId: null,
          active: false,
          gdprAnonymisedAt: erasedAt,
        },
      })
      if (claimed.count === 0) {
        const exists = await tx.customer.findUnique({ where: { id: customerId }, select: { id: true } })
        return exists ? 'Customer already anonymised' : 'Customer not found'
      }
      const orders = await tx.salesOrder.findMany({ where: { customerId }, select: { id: true }, orderBy: { id: 'asc' } })
      const orderIds = orders.map((o) => o.id)
      for (const id of orderIds) await lockSalesOrder(tx, id)
      const orderCounts = await eraseOrdersPersonalDataInTx(tx, orderIds, erasedAt)
      const links = await tx.shoppingCustomerLink.updateMany({ where: { customerId }, data: { metadata: Prisma.JsonNull } })
      const counts: ErasureCounts = { customers: 1, shoppingCustomerLinks: links.count, ...orderCounts }
      await logActivityInTransaction(tx, {
        entityType: 'CUSTOMER',
        entityId: customerId,
        tag: 'sales',
        action: ERASURE_RECORD_ACTION,
        description: ERASURE_RECORD_DESCRIPTION,
        metadata: buildErasureRecordMetadata({ requestId, erasedAt, trigger: options.trigger, customerId, orderIds, counts }),
        userId: options.userId,
      })
      return null
    })
    if (refusal) return { success: false, error: refusal }
    return { success: true, requestId }
  } catch (e) {
    // The exception text is NOT logged and NOT returned verbatim: a driver error can echo the values it was
    // writing. The class name is enough to triage; the transaction rolled back, so nothing was erased.
    await logActivity({
      entityType: 'CUSTOMER',
      entityId: customerId,
      tag: 'sales',
      action: ERASURE_FAILURE_ACTION,
      level: 'ERROR',
      description: ERASURE_FAILURE_DESCRIPTION,
      metadata: { requestId, trigger: options.trigger, errorClass: e instanceof Error ? e.constructor.name : typeof e },
      userId: options.userId,
    })
    return { success: false, error: ERASURE_FAILURE_DESCRIPTION }
  }
}
