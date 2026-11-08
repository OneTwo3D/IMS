import { randomUUID } from 'node:crypto'
import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { logActivity, logActivityInTransaction } from '@/lib/activity-log'
import { HELD_SALES_INVOICE_RECORD_KIND } from '@/lib/domain/sales/wc-sync-row-families'
import { EMAIL_RECIPIENT_ERASED_REASON } from './email-recipient'
import { scrubContactBlock } from './contact-gate'
import { scrubReturnInboxEvents } from './return-events'
import { loadRawPayloadSubject, scrubRawPayloadsInTx, type RawPayloadCounts } from './raw-payloads'
import { SYSTEM_PAYMENT_NOTES, orderIsErasedInTx } from './order-state'
export { orderIsErasedInTx }
import { ledgerStanding } from '@/lib/domain/accounting/ledger-standing'
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

/**
 * TRANSACTION OPTIONS SIZED FOR THE WORKLOAD. An erasure is ONE transaction (the customer, every order, the scrubs and the proof commit
 * together or not at all), and a long-standing customer can have thousands of orders and tens of thousands of activity rows. Prisma's
 * default interactive-transaction timeout is 5 seconds, which a large customer would exceed, rolling the whole erasure back every time. The
 * work is also set-based (one locking query, bulk updates), so the timeout is a ceiling, not an expected duration.
 */
export const ERASURE_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 120_000 } as const

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
): Promise<Omit<ErasureCounts, 'customers' | 'shoppingCustomerLinks' | 'activityRowsScrubbed' | 'linkedFreeTextScrubbed' | keyof RawPayloadCounts>> {
  const counts = { salesOrders: 0, shipments: 0, shoppingOrderLinks: 0, wmsStatusSnapshots: 0, outboxRowsErased: 0, outboxRowsClaimedFenced: 0, accountingPayloadsScrubbed: 0, heldInvoicePayloadsScrubbed: 0, paymentNotesErased: 0, bounceRecordsDeleted: 0, notifications: 0 }
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
    // SUPPRESSION ROWS FOR THESE ORDERS' ADDRESSES are the erased person's data (the address, and the mail server's raw text, which can echo it):
    // the addresses are read from the outbox rows BEFORE they are replaced below and the matching suppression rows are deleted. The address
    // is normalised the way the suppression writer normalises it (trimmed, lower-cased). If another live customer later uses the same address,
    // a fresh bounce simply suppresses it again.
    const queuedTo = await tx.emailOutbox.findMany({ where: outboxWhere, select: { toEmail: true }, distinct: ['toEmail'] })
    const suppressAddresses = queuedTo.map((r) => r.toEmail.trim().toLowerCase()).filter((a) => a && a !== ERASURE_PLACEHOLDER_EMAIL)
    if (suppressAddresses.length > 0) counts.bounceRecordsDeleted += (await tx.emailSuppression.deleteMany({ where: { email: { in: suppressAddresses } } })).count
    // The raw mail-server text on these rows' lastError can echo the address, in any status: replaced, claim and status untouched.
    await tx.emailOutbox.updateMany({ where: { ...outboxWhere, lastError: { not: null }, NOT: { lastError: ERASED_FREE_TEXT_MARKER } }, data: { lastError: ERASED_FREE_TEXT_MARKER } })
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
    // The free-text NOTE on the order's payments is erased; the payment, its amount and its REFERENCE are kept (they reconcile with the bank and the
    // ledger). The importer's own receipt sentences are kept ONLY when the note equals one of them in full (it recognises its receipts by them); a note that merely starts with one is free text and goes.
    counts.paymentNotesErased += (await tx.payment.updateMany({
      where: { orderId: { in: ids }, notes: { not: null }, AND: [{ notes: { notIn: [...SYSTEM_PAYMENT_NOTES] } }] },
      data: { notes: null },
    })).count

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

const compiledText = new WeakMap<string[], RegExp | null>()
const compiledJson = new WeakMap<string[], RegExp | null>()
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** ONE alternation over every token, compiled once per token list (longest first): a customer with thousands of orders has thousands of tokens and tens of thousands of rows to test. */
function combined(tokens: string[], cache: WeakMap<string[], RegExp | null>, form: (token: string) => string): RegExp | null {
  if (cache.has(tokens)) return cache.get(tokens)!
  const regex = tokens.length === 0 ? null : new RegExp(tokens.map((t) => escapeRegex(form(t))).join('|'), 'gi')
  cache.set(tokens, regex)
  return regex
}

export function scrubIdentityText(text: string, tokens: string[]): string {
  const regex = combined(tokens, compiledText, (t) => t)
  return regex ? text.replace(regex, ERASED_TEXT) : text
}

function scrubIdentityJson(value: unknown, tokens: string[]): unknown {
  const regex = combined(tokens, compiledJson, (t) => JSON.stringify(t).slice(1, -1))
  if (!regex) return value
  const text = JSON.stringify(value)
  const out = text.replace(regex, ERASED_TEXT)
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
    const changedIds: string[] = []
    const descriptions: string[] = []
    const metadataJson: string[] = []
    const setMetadata: boolean[] = []
    for (const row of rows) {
      // STRUCTURE FIRST (independent of any value), then the value match as a second net.
      const structuralDescription = IDENTITY_BEARING_ENTITY_TYPES.includes(row.entityType) ? ERASED_ACTIVITY_DESCRIPTION : row.description
      const structuralMetadata = row.metadata == null ? row.metadata : redactIdentityKeys(row.metadata)
      const description = structuralDescription === ERASED_ACTIVITY_DESCRIPTION ? structuralDescription : scrubIdentityText(structuralDescription, tokens)
      const metadata = structuralMetadata == null ? structuralMetadata : scrubIdentityJson(structuralMetadata, tokens)
      const metadataChanged = JSON.stringify(metadata) !== JSON.stringify(row.metadata)
      if (description === row.description && !metadataChanged) continue
      changedIds.push(row.id)
      descriptions.push(description)
      setMetadata.push(metadataChanged)
      metadataJson.push(metadataChanged ? JSON.stringify(metadata ?? null) : 'null')
    }
    // ONE statement per chunk, not one round trip per row: the values differ per row, so they are passed as parallel arrays.
    for (const part of chunks(changedIds, 1000)) {
      const from = changedIds.indexOf(part[0]!)
      const to = from + part.length
      await tx.$executeRaw`
        UPDATE "activity_logs" a
           SET "description" = v.d,
               "metadata" = CASE WHEN v.setm THEN v.m::jsonb ELSE a."metadata" END
          FROM unnest(${part}::text[], ${descriptions.slice(from, to)}::text[], ${metadataJson.slice(from, to)}::text[], ${setMetadata.slice(from, to)}::boolean[]) AS v(id, d, m, setm)
         WHERE a."id" = v.id`
    }
    scrubbed += changedIds.length
  }
  return scrubbed
}

/**
 * THE CONTACT BLOCK IN THE ACCOUNTING SYNC PAYLOAD. A WooCommerce invoice job stores `contactName` and `contactEmail` in
 * `accounting_sync_logs.payload`, and the Xero processor reads them to find or create the ledger contact when it posts.
 *
 * NOT YET SENT (PENDING, FAILED, or CANCELLED and PROVEN never posted: see `neverPosted`): the contact name becomes the placeholder and the email is removed, so a later post can
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
  const all = await tx.accountingSyncLog.findMany({
    where: scope,
    select: { id: true, status: true, externalTransactionId: true, abandonedBeforeRemoteCall: true, settlementBasis: true, remoteAttemptedAt: true, attemptRevision: true },
  })
  // A CANCELLED row PROVEN never posted is not a ledger record: the cancelling writer stamped abandonedBeforeRemoteCall on a
  // row nobody ever claimed (the ledger standing says PROVEN_NOT_POSTED), and the row carries no document id, no remote
  // attempt stamp and attempt revision 0. Its name is scrubbed like an unsent row's. A CANCELLED row with ANY posting
  // evidence (an id, an attempt stamp, a claimed revision, an operator's word, no proof stamp) may have reached the ledger and
  // keeps its name with the SYNCED rows.
  const neverPosted = (r: (typeof all)[number]) =>
    // (With no caller payload proof, PROVEN_NOT_POSTED can only be a cancelled row: the ledger standing is the one reading of that.)
    ledgerStanding(r) === 'PROVEN_NOT_POSTED' && !(r.externalTransactionId ?? '').trim() && r.remoteAttemptedAt === null && r.attemptRevision === 0
  const isUnsent = (r: (typeof all)[number]) => r.status === 'PENDING' || r.status === 'FAILED' || neverPosted(r)
  const unsentIds = all.filter(isUnsent).map((r) => r.id)
  const keptIds = all.filter((r) => !isUnsent(r)).map((r) => r.id)
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

/** The contact block of an accounting payload, replaced the way the erasure replaces it (see contact-gate.ts). */
export const scrubContactInAccountingPayload = scrubContactBlock

/** The one identity-free marker written where a free-text column HAD a value, so a column that is checked for presence still reads as present. */
export const ERASED_FREE_TEXT_MARKER = 'Text removed by GDPR erasure'

/**
 * The only stock-movement note text kept: the historical storefront import's idempotency sentence, which carries nothing but an order number
 * (the import finds its earlier movements by it). Matched in full; any other note on these rows is cleared.
 */
const SYSTEM_STOCK_MOVEMENT_NOTE = /^Historical WC import \u2014 Order #\S+$/

/**
 * Free text on the rows that hang off an erased customer's orders but are written by other systems or people: the warehouse link's last
 * errors, order discrepancies, the returns inbox (reason, resolution note, raw warehouse payload) and the notes of the stock movements of
 * the orders' shipment lines. They can echo the recipient, and an OLD name or address (changed since) would not match the order's current
 * fields, so they are CLEARED, not matched against values: where a column had a value it now holds one fixed identity-free marker (so a
 * presence check still reads true), the raw return payload becomes an empty object, and every structured column (ids, references, quantities,
 * statuses, codes, timestamps) is kept. Returns the number of rows changed. Operates on the orders the caller has locked.
 */
export async function scrubLinkedFreeText(tx: Prisma.TransactionClient, orderIds: string[]): Promise<number> {
  let changed = 0
  const marker = ERASED_FREE_TEXT_MARKER
  for (const ids of chunks(orderIds)) {
    for (const field of ['lastError', 'dispatchLastError', 'dispatchUnresolvedError'] as const) {
      changed += (await tx.wmsOrderPushLink.updateMany({ where: { orderId: { in: ids }, [field]: { not: null }, NOT: { [field]: marker } }, data: { [field]: marker } })).count
    }
    // The status snapshot's last error (the sweep writes the connector's exception text there) and the refund's accounting warning.
    changed += (await tx.wmsOrderStatusSnapshot.updateMany({ where: { orderId: { in: ids }, lastError: { not: null }, NOT: { lastError: marker } }, data: { lastError: marker } })).count
    changed += (await tx.salesOrderRefund.updateMany({ where: { orderId: { in: ids }, accountingWarning: { not: null }, NOT: { accountingWarning: marker } }, data: { accountingWarning: marker } })).count
    changed += (await tx.wmsOrderDiscrepancy.updateMany({ where: { orderId: { in: ids }, detail: { not: null }, NOT: { detail: marker } }, data: { detail: marker } })).count
    for (const field of ['reason', 'resolutionNote'] as const) {
      changed += (await tx.wmsReturnsInbox.updateMany({ where: { orderId: { in: ids }, [field]: { not: null }, NOT: { [field]: marker } }, data: { [field]: marker } })).count
    }
    const returns = await tx.wmsReturnsInbox.findMany({ where: { orderId: { in: ids } }, select: { id: true, rawPayload: true } })
    // The return_inbox MUTATION EVENTS copy the free-text reason (and any resolution note) into their before / after JSON. They are found by
    // the inbox row ids and their free-text keys are replaced with the marker, set-based; null stays null and other keys are untouched.
    if (returns.length > 0) {
      const inboxIds = returns.map((r) => r.id)
      changed += await scrubReturnInboxEvents(tx, inboxIds)
    }
    const rawIds = returns.filter((r) => r.rawPayload != null && JSON.stringify(r.rawPayload) !== '{}').map((r) => r.id)
    if (rawIds.length > 0) changed += (await tx.wmsReturnsInbox.updateMany({ where: { id: { in: rawIds } }, data: { rawPayload: {} } })).count
    const movements = await tx.stockMovement.findMany({ where: { shipmentLine: { shipment: { orderId: { in: ids } } }, note: { not: null } }, select: { id: true, note: true } })
    const noteIds = movements.filter((m) => m.note !== marker && !SYSTEM_STOCK_MOVEMENT_NOTE.test(m.note!)).map((m) => m.id)
    if (noteIds.length > 0) changed += (await tx.stockMovement.updateMany({ where: { id: { in: noteIds } }, data: { note: marker } })).count
  }
  return changed
}

export type EraseCustomerResult =
  | { success: true; requestId: string }
  | { success: false; error: string }

/**
 * THE SHARED BODY OF EVERY ERASURE, run inside a transaction whose caller has ALREADY taken the locks (customer row first when there is
 * one, then the orders, in id order). `targetOrderIds` are the orders to erase; `eraseCustomer` says whether the customer row is erased
 * with them. The customer wrapper passes all of the customer's orders and true; the order-first entry passes one order and decides
 * `eraseCustomer` itself. Returns null on success or a refusal text (nothing written).
 */
async function eraseUnderLocksInTx(
  tx: Prisma.TransactionClient,
  input: { customerId: string | null; eraseCustomer: boolean; targetOrderIds: string[]; requestId: string; erasedAt: Date; trigger: ErasureTrigger; userId: string | null },
): Promise<string | null> {
  const { customerId, eraseCustomer, targetOrderIds: orderIds, erasedAt } = input
  // Every value that identifies the subject (the tokens that remove it from activity rows) is read only AFTER the caller's locks, so an edit
  // that was in flight has either committed (and is read here) or is blocked until the erasure is done.
  const before = eraseCustomer && customerId ? await tx.customer.findUnique({ where: { id: customerId } }) : null
  const orderRows = await tx.salesOrder.findMany({
    where: { id: { in: orderIds } },
    select: { customerName: true, customerEmail: true, customerVatNumber: true, billingAddress: true, shippingAddress: true, notes: true, internalNotes: true, trackingNumber: true },
  })
  const shipmentRows = await tx.shipment.findMany({ where: { orderId: { in: orderIds } }, select: { trackingNumber: true } })
  if (eraseCustomer && customerId) {
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
    if (claimed.count === 0) return 'Customer already anonymised'
  }
  const orderCounts = await eraseOrdersPersonalDataInTx(tx, orderIds, erasedAt)
  // A customer who REMAINS LIVE (it keeps another live order) must not go on listing an order that was erased: the customer's name, email and
  // link would keep the erased order attributable to them (getCustomerDetail lists a customer's orders). So the order is UNLINKED in the same
  // transaction, which is what WooCommerce does to the anonymised order (customer_id 0). Only the link goes: totals, tax, lines, ledger ids and
  // the invoice stay on the order. Nothing re-links it: the importer's update path never writes customerId, and the only writers of an order's
  // customerId are the creates (a manual order, a clone, which refuses an erased source, and the importer's create).
  if (!eraseCustomer && customerId) await tx.salesOrder.updateMany({ where: { id: { in: orderIds } }, data: { customerId: null } })
  // The addresses the person is known by (the customer's and each order's), read under the locks, also have their suppression rows deleted.
  const knownAddresses = [...new Set([before?.email, ...orderRows.map((o) => o.customerEmail)].map((a) => a?.trim().toLowerCase()).filter((a): a is string => Boolean(a)))]
  if (knownAddresses.length > 0) orderCounts.bounceRecordsDeleted += (await tx.emailSuppression.deleteMany({ where: { email: { in: knownAddresses } } })).count
  // THE STOREFRONT ACCOUNT LINK IS DELETED, not blanked: its externalCustomerId is the live storefront customer id and resolves to
  // the account, and nothing financial references the row (it has no dependants; orders keep their own order link). With it gone
  // a later order from the same storefront account finds no link, no email on the erased row to match, and so gets a FRESH
  // customer; the new identity belongs to a new record. Only when the customer itself is erased: a customer who keeps other live
  // orders keeps its link.
  // The storefront customer ids are read BEFORE the links are deleted: they find the same person's raw deliveries for orders IMS never imported.
  const storefrontCustomerIds = eraseCustomer && customerId
    ? [before?.externalCustomerId, ...(await tx.shoppingCustomerLink.findMany({ where: { customerId }, select: { externalCustomerId: true } })).map((l) => l.externalCustomerId)]
    : []
  const links = eraseCustomer && customerId ? await tx.shoppingCustomerLink.deleteMany({ where: { customerId } }) : { count: 0 }
  const tokens = collectIdentityTokens({
    customer: before as unknown as Record<string, unknown> | null,
    orders: orderRows as unknown as Array<Record<string, unknown>>,
    shipmentTracking: shipmentRows.map((r) => r.trackingNumber),
  })
  const activityRowsScrubbed = await scrubActivityLogIdentity(tx, [...(eraseCustomer && customerId ? [customerId] : []), ...orderIds], tokens)
  const linkedFreeTextScrubbed = await scrubLinkedFreeText(tx, orderIds)
  // THE RAW PAYLOAD COPIES (webhook inbox, queue snapshots, refund parks, tracking logs, warehouse return records), projected in this same transaction:
  // a failure here fails the whole erasure, so raw identity cannot be left behind silently. See raw-payloads.ts.
  const rawSubject = await loadRawPayloadSubject(tx, orderIds, storefrontCustomerIds)
  const rawCounts = await scrubRawPayloadsInTx(tx, rawSubject.subject, rawSubject.missing)
  const counts: ErasureCounts = { customers: eraseCustomer ? 1 : 0, shoppingCustomerLinks: links.count, activityRowsScrubbed, linkedFreeTextScrubbed, ...rawCounts, ...orderCounts }
  const record = {
    tag: 'sales',
    description: ERASURE_RECORD_DESCRIPTION,
    // The proof names the customer only when that customer was erased too; for a customer who stays live it would re-attribute the order.
    metadata: buildErasureRecordMetadata({ requestId: input.requestId, erasedAt, trigger: input.trigger, customerId: eraseCustomer ? customerId : null, orderIds, counts }),
    userId: input.userId,
  }
  // The proof is filed against the customer when the customer is erased, otherwise against the (first) order.
  if (eraseCustomer && customerId) await logActivityInTransaction(tx, { entityType: 'CUSTOMER', entityId: customerId, action: ERASURE_RECORD_ACTION, ...record })
  else await logActivityInTransaction(tx, { entityType: 'SALES_ORDER', entityId: orderIds[0]!, action: ERASURE_RECORD_ACTION, ...record })
  return null
}

/** Erase a customer and every order linked to them. Idempotent: a second call refuses and changes nothing. */
export async function eraseCustomerPersonalData(
  customerId: string,
  options: { trigger: ErasureTrigger; userId: string | null },
): Promise<EraseCustomerResult> {
  const requestId = randomUUID()
  const erasedAt = new Date()
  try {
    const refusal = await db.$transaction(async (tx): Promise<string | null> => {
      // LOCKS FIRST: the customer row is locked, then ALL of the customer's orders in one statement in id order (customer, then orders).
      // New orders cannot appear under the customer meanwhile: creating one takes the same customer row lock.
      const lockedCustomer = await tx.$queryRaw<Array<{ id: string; gdprAnonymisedAt: Date | null }>>`SELECT id, "gdprAnonymisedAt" FROM "customers" WHERE id = ${customerId} FOR UPDATE`
      if (lockedCustomer.length === 0) return 'Customer not found'
      if (lockedCustomer[0]!.gdprAnonymisedAt) return 'Customer already anonymised'
      const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "sales_orders" WHERE "customerId" = ${customerId} ORDER BY id FOR UPDATE`
      return eraseUnderLocksInTx(tx, { customerId, eraseCustomer: true, targetOrderIds: locked.map((o) => o.id), requestId, erasedAt, trigger: options.trigger, userId: options.userId })
    }, ERASURE_TRANSACTION_OPTIONS)
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

export type EraseOrderResult =
  | { success: true; already: true }
  | { success: true; already: false; requestId: string; customerErased: boolean }
  | { success: false; error: string }

/** Thrown inside the transaction when the order was relinked to another customer between the unlocked read and the locks: roll back and retry. */
class OrderRelinkedDuringErasure extends Error {}
const ORDER_ERASURE_ATTEMPTS = 3

/**
 * ORDER-FIRST ERASURE: erase ONE order (a guest order included), and the linked customer only when no live order remains.
 *
 * Lock order is the customer-erasure's (customer row, then ALL of that customer's orders in one id-ordered statement), so the two cannot
 * deadlock; a guest order locks just itself. The order's customer is read before the locks to know WHICH customer to lock, and read
 * again under them: if it changed, the transaction rolls back and retries (bounded; a persistent change fails loudly so the caller's
 * retry takes over). Idempotent: an order already marked erased writes nothing and records nothing.
 *
 * The customer row is erased in the same transaction when, under those locks, it is not already erased and every OTHER order linked to
 * it is already erased. A customer who keeps another live order keeps its row and link.
 */
export async function eraseOrderPersonalData(
  orderId: string,
  options: { trigger: ErasureTrigger; userId: string | null },
): Promise<EraseOrderResult> {
  const requestId = randomUUID()
  const erasedAt = new Date()
  try {
    for (let attempt = 1; attempt <= ORDER_ERASURE_ATTEMPTS; attempt += 1) {
      try {
        return await db.$transaction(async (tx): Promise<EraseOrderResult> => {
          const peek = await tx.salesOrder.findUnique({ where: { id: orderId }, select: { customerId: true } })
          if (!peek) return { success: false, error: 'Order not found' }
          let customerErased = false
          let customerLive = false
          if (peek.customerId) {
            const lockedCustomer = await tx.$queryRaw<Array<{ gdprAnonymisedAt: Date | null }>>`SELECT "gdprAnonymisedAt" FROM "customers" WHERE id = ${peek.customerId} FOR UPDATE`
            customerErased = lockedCustomer.length > 0 && lockedCustomer[0]!.gdprAnonymisedAt != null
            customerLive = lockedCustomer.length > 0 && !customerErased
            await tx.$queryRaw`SELECT id FROM "sales_orders" WHERE "customerId" = ${peek.customerId} ORDER BY id FOR UPDATE`
          } else {
            await tx.$queryRaw`SELECT id FROM "sales_orders" WHERE id = ${orderId} FOR UPDATE`
          }
          const order = await tx.salesOrder.findUnique({ where: { id: orderId }, select: { customerId: true, erasedAt: true } })
          if (!order) return { success: false, error: 'Order not found' }
          if (order.customerId !== peek.customerId) throw new OrderRelinkedDuringErasure()
          if (order.erasedAt) return { success: true, already: true }
          const liveOthers = peek.customerId && customerLive
            ? await tx.salesOrder.count({ where: { customerId: peek.customerId, id: { not: orderId }, erasedAt: null } })
            : 1
          const eraseCustomer = Boolean(peek.customerId) && customerLive && liveOthers === 0
          const refusal = await eraseUnderLocksInTx(tx, { customerId: peek.customerId, eraseCustomer, targetOrderIds: [orderId], requestId, erasedAt, trigger: options.trigger, userId: options.userId })
          if (refusal) return { success: false, error: refusal }
          return { success: true, already: false, requestId, customerErased: eraseCustomer }
        }, ERASURE_TRANSACTION_OPTIONS)
      } catch (e) {
        if (e instanceof OrderRelinkedDuringErasure && attempt < ORDER_ERASURE_ATTEMPTS) continue
        throw e
      }
    }
    return { success: false, error: ERASURE_FAILURE_DESCRIPTION }
  } catch (e) {
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
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
