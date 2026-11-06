import { randomUUID } from 'node:crypto'
import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { logActivity, logActivityInTransaction } from '@/lib/activity-log'
import { lockSalesOrder } from '@/lib/domain/sales/allocation-service'
import { HELD_SALES_INVOICE_RECORD_KIND } from '@/lib/domain/sales/wc-sync-row-families'
import { EMAIL_RECIPIENT_ERASED_REASON } from './email-recipient'
import { scrubContactBlock } from './contact-gate'
import { ERASED_ACTIVITY_DESCRIPTION, IDENTITY_BEARING_ENTITY_TYPES, redactIdentityKeys } from './activity-identity'
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
export const EMAIL_OUTBOX_ERASED_ERROR = EMAIL_RECIPIENT_ERASED_REASON

/**
 * Erase the personal data held on a set of sales orders and on the rows that hang off them. The caller owns
 * the transaction and MUST have locked every order (lockSalesOrder) before calling.
 */
export async function eraseOrdersPersonalDataInTx(
  tx: Prisma.TransactionClient,
  orderIds: string[],
  erasedAt: Date,
): Promise<Omit<ErasureCounts, 'customers' | 'shoppingCustomerLinks' | 'activityRowsScrubbed'>> {
  const counts = { salesOrders: 0, shipments: 0, shoppingOrderLinks: 0, wmsStatusSnapshots: 0, outboxRowsErased: 0, outboxRowsClaimedFenced: 0, accountingPayloadsScrubbed: 0, heldInvoicePayloadsScrubbed: 0, notifications: 0 }
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
    // the email builders refuse an order with no address. A PROCESSING row is handled below.
    const outboxWhere = { referenceType: 'SalesOrder', referenceId: { in: ids } }
    counts.outboxRowsErased += (await tx.emailOutbox.updateMany({
      where: { ...outboxWhere, status: { in: ['SENT', 'FAILED'] }, NOT: { toEmail: ERASURE_PLACEHOLDER_EMAIL } },
      data: { toEmail: ERASURE_PLACEHOLDER_EMAIL },
    })).count
    counts.outboxRowsErased += (await tx.emailOutbox.updateMany({
      where: { ...outboxWhere, status: { in: ['PENDING', 'PARKED_SEND_CAP'] } },
      data: { toEmail: ERASURE_PLACEHOLDER_EMAIL, status: 'FAILED', lastError: EMAIL_OUTBOX_ERASED_ERROR },
    })).count
    // A CLAIMED row: the address is replaced under only the status condition, so the claim fence (lockedBy,
    // processingStartedAt) is untouched and the sender's own terminal write still lands. The sender confirms the stored
    // address immediately before it sends (lib/email-outbox.ts) and refuses a row whose address changed; a row already on
    // the wire cannot be recalled. reconcileErasedEmailOutbox sweeps anything this missed.
    counts.outboxRowsClaimedFenced += (await tx.emailOutbox.updateMany({
      where: { ...outboxWhere, status: 'PROCESSING', NOT: { toEmail: ERASURE_PLACEHOLDER_EMAIL } },
      data: { toEmail: ERASURE_PLACEHOLDER_EMAIL },
    })).count

    counts.accountingPayloadsScrubbed += await scrubAccountingPayloadContacts(tx, ids)
    counts.heldInvoicePayloadsScrubbed += await scrubHeldInvoicePayloads(tx, ids)

    // Notifications are linked to an order only by the URL they point at.
    counts.notifications += (await tx.notification.updateMany({
      where: { OR: ids.flatMap((id) => [{ actionUrl: `/sales/${id}` }, { actionUrl: { startsWith: `/sales/${id}/` } }]) },
      data: { title: NOTIFICATION_ERASED_TITLE, message: NOTIFICATION_ERASED_MESSAGE },
    })).count
  }
  return counts
}

export const ERASED_TEXT = '[erased]'

type IdentitySource = { customer: Record<string, unknown> | null; orders: Array<Record<string, unknown>>; shipmentTracking: Array<string | null> }

const FREE_TEXT_KEYS = new Set(['notes', 'internalNotes'])
const GENERIC_TOKENS = new Set(['gdpr', 'anonymised', 'gb', 'uk', 'null', 'none', 'n/a'])

function collectStrings(value: unknown, into: string[], depth = 0): void {
  if (depth > 6 || value == null) return
  if (typeof value === 'string') into.push(value)
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, into, depth + 1)
  else if (typeof value === 'object') for (const v of Object.values(value as Record<string, unknown>)) collectStrings(v, into, depth + 1)
}

/**
 * Every value that identifies the subject, read BEFORE the columns are overwritten: the customer's and each order's
 * name, email, phone, company, VAT, addresses (every string in them), notes and tracking numbers. Short tokens and
 * generic ones (a country code) are dropped so the scrub does not mangle ordinary words.
 */
export function collectIdentityTokens(source: IdentitySource): string[] {
  const whole: string[] = []
  const words: string[] = []
  const rows = [...(source.customer ? [source.customer] : []), ...source.orders]
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      const found: string[] = []
      collectStrings(value, found)
      whole.push(...found)
      // Free text is matched only as a whole string: splitting it into words would redact ordinary words everywhere.
      if (!FREE_TEXT_KEYS.has(key)) for (const f of found) for (const part of f.split(/\s+/)) words.push(part)
    }
  }
  for (const t of source.shipmentTracking) if (t) whole.push(t)
  const tokens = new Set<string>()
  for (const candidate of [...whole, ...words]) {
    const t = candidate.trim()
    if (t.length < 3 || GENERIC_TOKENS.has(t.toLowerCase())) continue
    tokens.add(t)
  }
  return [...tokens].sort((a, b) => b.length - a.length)
}

export function scrubIdentityText(text: string, tokens: string[]): string {
  let out = text
  for (const token of tokens) out = out.replace(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ERASED_TEXT)
  return out
}

function scrubIdentityJson(value: unknown, tokens: string[]): unknown {
  const text = JSON.stringify(value)
  let out = text
  for (const token of tokens) {
    const escaped = JSON.stringify(token).slice(1, -1)
    out = out.replace(new RegExp(escaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ERASED_TEXT)
  }
  return out === text ? value : JSON.parse(out)
}

/**
 * Redact the subject's identity from activity rows written BEFORE the erasure (the old action's description carried the
 * name; a customer's created/updated rows do too). It replaces identifying VALUES in place and keeps the row, so
 * operational history and the accounting markers (which carry no identity) are untouched. The new erasure record is
 * excluded. Rows keyed to other entities that merely mention the subject cannot be found by key and are out of reach.
 */
export async function scrubActivityLogIdentity(
  tx: Prisma.TransactionClient,
  entityIds: string[],
  tokens: string[],
): Promise<number> {
  let scrubbed = 0
  for (const ids of chunks(entityIds)) {
    const rows = await tx.activityLog.findMany({
      where: { entityId: { in: ids }, NOT: { action: ERASURE_RECORD_ACTION } },
      select: { id: true, description: true, metadata: true, entityType: true },
    })
    for (const row of rows) {
      // STRUCTURE FIRST (independent of any value), then the value match as a second net.
      const structuralDescription = IDENTITY_BEARING_ENTITY_TYPES.includes(row.entityType) ? ERASED_ACTIVITY_DESCRIPTION : row.description
      const structuralMetadata = row.metadata == null ? row.metadata : redactIdentityKeys(row.metadata)
      const description = structuralDescription === ERASED_ACTIVITY_DESCRIPTION ? structuralDescription : scrubIdentityText(structuralDescription, tokens)
      const metadata = structuralMetadata == null ? structuralMetadata : scrubIdentityJson(structuralMetadata, tokens)
      if (description === row.description && JSON.stringify(metadata) === JSON.stringify(row.metadata)) continue
      await tx.activityLog.update({ where: { id: row.id }, data: { description, ...(JSON.stringify(metadata) === JSON.stringify(row.metadata) ? {} : { metadata: (metadata ?? Prisma.JsonNull) as Prisma.InputJsonValue }) } })
      scrubbed += 1
    }
  }
  return scrubbed
}

/**
 * THE CONTACT BLOCK IN THE ACCOUNTING SYNC PAYLOAD. A WooCommerce invoice job stores `contactName` and `contactEmail` in
 * `accounting_sync_logs.payload`, and the Xero processor reads them to find or create the ledger contact when it posts.
 *
 * NOT YET SENT (PENDING, FAILED): the contact name becomes the placeholder and the email is removed, so a later post can
 * only ever name the placeholder. Every financial field of the payload (lines, amounts, dates, currency, references) is
 * untouched, and the idempotency key does not depend on the contact, so a retry still dedupes.
 * ALREADY IN THE LEDGER OR CLAIMED (SYNCED, CANCELLED, PROCESSING): the name is part of what the ledger holds for the
 * posted document, and the document is retained as a financial record, so it is KEPT in the stored copy; only the contact
 * EMAIL, which is not part of the posted document, is removed. A claimed row's processor already holds its payload in memory.
 * The posting gate (resolveSalesPostContact) covers any post that happens after the erasure whatever the payload says.
 */
export async function scrubAccountingPayloadContacts(tx: Prisma.TransactionClient, orderIds: string[]): Promise<number> {
  const refunds = await tx.salesOrderRefund.findMany({ where: { orderId: { in: orderIds } }, select: { id: true } })
  const refIds = [...orderIds, ...refunds.map((r) => r.id)]
  const scope = { referenceType: { in: ['SalesOrder', 'SalesOrderRefund'] }, referenceId: { in: refIds } }
  const all = await tx.accountingSyncLog.findMany({ where: scope, select: { id: true, status: true } })
  const unsentIds = all.filter((r) => r.status === 'PENDING' || r.status === 'FAILED').map((r) => r.id)
  const keptIds = all.filter((r) => r.status !== 'PENDING' && r.status !== 'FAILED').map((r) => r.id)
  const unsent = unsentIds.length === 0 ? 0 : await tx.$executeRaw`
    UPDATE "accounting_sync_logs"
       SET "payload" = ("payload" - 'contactEmail') || jsonb_build_object('contactName', ${ERASURE_PLACEHOLDER_NAME}::text)
     WHERE "id" = ANY(${unsentIds}::text[]) AND ("payload"->>'contactName') IS NOT NULL`
  const kept = keptIds.length === 0 ? 0 : await tx.$executeRaw`
    UPDATE "accounting_sync_logs"
       SET "payload" = "payload" - 'contactEmail'
     WHERE "id" = ANY(${keptIds}::text[]) AND ("payload"->>'contactEmail') IS NOT NULL`
  return Number(unsent) + Number(kept)
}

/**
 * A WooCommerce invoice HOLD (shopping_sync_logs, record kind held-sales-invoice) parks the whole accounting payload,
 * contact block included, until WooCommerce numbers the invoice; the release later COPIES it into a new accounting row.
 * The parked copy gets the same treatment as an unsent accounting row: placeholder name, no email, everything financial
 * kept. (The release path also checks the marker itself, under the order lock, before it copies; see order-import.)
 */
export async function scrubHeldInvoicePayloads(tx: Prisma.TransactionClient, orderIds: string[]): Promise<number> {
  const rows = await tx.shoppingSyncLog.findMany({
    where: { connector: 'woocommerce', entityType: 'SalesOrder', recordKind: HELD_SALES_INVOICE_RECORD_KIND, entityId: { in: orderIds } },
    select: { id: true },
  })
  const ids = rows.map((r) => r.id)
  if (ids.length === 0) return 0
  return Number(await tx.$executeRaw`
    UPDATE "shopping_sync_logs"
       SET "payload" = jsonb_set("payload" #- '{accountingPayload,contactEmail}', '{accountingPayload,contactName}', to_jsonb(${ERASURE_PLACEHOLDER_NAME}::text))
     WHERE "id" = ANY(${ids}::text[]) AND ("payload" #>> '{accountingPayload,contactName}') IS NOT NULL`)
}

/**
 * Whether the order (or its customer) is erased, read INSIDE the caller's transaction and AFTER the caller has taken the order lock
 * (`lockSalesOrder`). Every place that copies a contact name or email into an accounting row or a parked hold reads it this way,
 * so the copy and the answer cannot be separated by an erasure.
 */
export async function orderIsErasedInTx(tx: Prisma.TransactionClient, orderId: string): Promise<boolean> {
  const row = await tx.salesOrder.findUnique({ where: { id: orderId }, select: { erasedAt: true, customer: { select: { gdprAnonymisedAt: true } } } })
  return Boolean(row?.erasedAt || row?.customer?.gdprAnonymisedAt)
}

/** The contact block of an accounting payload, replaced the way the erasure replaces it (see contact-gate.ts). */
export const scrubContactInAccountingPayload = scrubContactBlock

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
      // Read the identifying values BEFORE anything is overwritten (see collectIdentityTokens).
      const before = await tx.customer.findUnique({ where: { id: customerId } })
      const orderRows = before ? await tx.salesOrder.findMany({
        where: { customerId },
        select: { customerName: true, customerEmail: true, customerVatNumber: true, billingAddress: true, shippingAddress: true, notes: true, internalNotes: true, trackingNumber: true },
      }) : []
      const shipmentRows = before ? await tx.shipment.findMany({ where: { order: { customerId } }, select: { trackingNumber: true } }) : []
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
      const tokens = collectIdentityTokens({
        customer: before as unknown as Record<string, unknown> | null,
        orders: orderRows as unknown as Array<Record<string, unknown>>,
        shipmentTracking: shipmentRows.map((r) => r.trackingNumber),
      })
      const activityRowsScrubbed = await scrubActivityLogIdentity(tx, [customerId, ...orderIds], tokens)
      const counts: ErasureCounts = { customers: 1, shoppingCustomerLinks: links.count, activityRowsScrubbed, ...orderCounts }
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
