import { Prisma } from '@/app/generated/prisma/client'
import { scrubReturnInboxEvents } from './return-events'
import { clearRawReturnLogs } from '@/lib/connectors/wms/return-record-keys'

/**
 * THE RAW PAYLOAD STORES: copies of what a connector sent, kept verbatim, that the erasure of an order has to reach.
 *
 *   shopping_webhook_events.payloadJson   the raw WooCommerce order / refund delivery (and its lastError, which can echo the body)
 *   shopping_sync_logs.payload            the pending-FX queue's order snapshot, a refund park's raw refund, the outbound tracking items
 *   shopping_sync_logs.errorMessage       exception text of those rows
 *   wms_sync_logs.payload                 raw warehouse return records written before the writer stopped storing them
 *   wms_returns_inbox (orderId NULL)      returns the warehouse reported with no order IMS could match: #844 reaches only linked rows
 *
 * WHAT REPLACES A PAYLOAD is an ALLOWLIST PROJECTION implemented ONCE, in SQL (migration 20261107150000), and used both by the statements here and by the
 * guard triggers that project a payload written AFTER an erasure. The webhook-inbox retention hold (shopping-webhook-retention.ts) is NOT touched: the hold
 * protects currency and creator evidence, and the projection keeps exactly that (currency, version, created_via, dates, totals, tax lines, base-currency meta).
 * `payloadHash`, the inbox's idempotency key, is a separate column and is never written here, so a redelivery of the original body is still a duplicate.
 *
 * HOW ROWS ARE FOUND, and what that cannot find (never silently):
 *   - webhook inbox: the storefront order id inside the payload (the order's own id, a refund's parent id) matched against the subject's order links, plus, for a
 *     customer erasure, the payload's customer id against the subject's storefront customer ids (the same person's orders IMS never imported);
 *   - sync logs: (connector, entityType, entityId) for an imported order; a row with no entityId (a queued order not yet imported, a refusal, a failed import) is found by
 *     its storefront order id (a row WITH an entityId is never matched by externalId: it is one number space for orders AND refunds);
 *   - returns: inbox rows by the order's numbers, and wms_sync_logs rows of returns jobs whose raw record names the return id or the order number under the keys
 *     the normaliser reads them from.
 * An erased order that looks like a storefront order but has no storefront link cannot be found in the inbox: it is COUNTED (`storefrontIdMissing`) and recorded
 * in the proof. After the writes, the same finders are run again with the "still carries identity" test; a row left over THROWS, which rolls the erasure back.
 */

export const RAW_PAYLOAD_MARKER = 'Text removed by GDPR erasure'

export type RawPayloadCounts = {
  /** Webhook inbox rows whose payload (or lastError) was projected. */
  rawWebhookEventsProjected: number
  /** Sync log rows whose payload (or errorMessage) was projected. */
  rawSyncLogsProjected: number
  /** Returns-inbox rows with no linked order (raw payload, reason, note cleared) plus warehouse sync log rows holding a raw return record. */
  rawReturnRecordsCleared: number
  /** Orders that look like storefront orders but have no storefront order link, so their inbox rows could not be looked for. */
  storefrontIdMissing: number
}

export const EMPTY_RAW_PAYLOAD_COUNTS: RawPayloadCounts = { rawWebhookEventsProjected: 0, rawSyncLogsProjected: 0, rawReturnRecordsCleared: 0, storefrontIdMissing: 0 }

type Client = Pick<Prisma.TransactionClient, '$executeRaw' | '$queryRaw'> & Pick<Prisma.TransactionClient, 'shoppingOrderLink' | 'shoppingSyncLog' | 'storefrontOrderErasureObligation' | 'salesOrder' | 'wmsOrderPushLink' | 'wmsReturnsInbox'>

export type RawPayloadSubject = {
  /** The locked IMS orders. */
  orderIds: string[]
  /** The storefront order ids of those orders. */
  storefrontOrderIds: string[]
  /** The storefront customer ids of a customer being erased (read BEFORE the links are deleted); empty for an order erased on its own. */
  storefrontCustomerIds: string[]
}

const chunks = <T,>(items: T[], size = 100): T[][] => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size))
const text = (ids: string[]) => Prisma.sql`${ids}::text[]`

function webhookWhere(subject: Pick<RawPayloadSubject, 'storefrontOrderIds' | 'storefrontCustomerIds'>): Prisma.Sql {
  return Prisma.sql`w."connector" = 'woocommerce' AND w."resource" IN ('orders', 'refunds')
    AND (gdpr_webhook_order_key(w."payloadJson", w."resource") = ANY(${text(subject.storefrontOrderIds)})
         OR (w."resource" = 'orders' AND (w."payloadJson"->>'customer_id') = ANY(${text(subject.storefrontCustomerIds)})))`
}
const webhookDirty = Prisma.sql`(w."payloadJson" IS DISTINCT FROM gdpr_project_webhook_payload(w."payloadJson", w."resource")
    OR (w."lastError" IS NOT NULL AND w."lastError" <> ${RAW_PAYLOAD_MARKER}::text))`

/** The IMS-side facts a subject's raw rows are found by, read under the caller's locks. */
export async function loadRawPayloadSubject(tx: Client, orderIds: string[], storefrontCustomerIds: Array<string | number | null | undefined>): Promise<{ subject: RawPayloadSubject; missing: number }> {
  const links = await tx.shoppingOrderLink.findMany({ where: { connector: 'woocommerce', orderId: { in: orderIds } }, select: { orderId: true, externalOrderId: true } })
  const linked = new Set(links.map((l) => l.orderId))
  const unlinked = orderIds.filter((id) => !linked.has(id))
  const missing = unlinked.length === 0 ? 0 : await tx.salesOrder.count({ where: { id: { in: unlinked }, OR: [{ externalOrderNumber: { not: null } }, { externalCreatedAt: { not: null } }] } })
  const customerIds = [...new Set(storefrontCustomerIds.map((v) => (v == null ? '' : String(v).trim())).filter((v) => v !== '' && v !== '0'))]
  return { subject: { orderIds, storefrontOrderIds: [...new Set(links.map((l) => l.externalOrderId))], storefrontCustomerIds: customerIds }, missing }
}

export async function scrubRawPayloadsInTx(tx: Client, subject: RawPayloadSubject, missing = 0): Promise<RawPayloadCounts> {
  const counts: RawPayloadCounts = { ...EMPTY_RAW_PAYLOAD_COUNTS, storefrontIdMissing: missing }

  // (BEFORE the projection: it neutralises the customer id the rows are found by.) DELIVERIES FOR AN ORDER IMS DOES NOT HOLD (found through the customer id): the later-write guard, the reconcile and a later import look an order up
  // by its link or by an open erasure obligation, so without one a redelivery of that order would be stored in full and the order created identifiable.
  // The obligation is order-keyed and carries no personal data; it is recorded here, in the same transaction, for every such storefront order id.
  const obligated: string[] = []
  if (subject.storefrontCustomerIds.length > 0) {
    // The queue snapshots of the same person's orders IMS never imported carry the customer id inside `order`: their order ids are found too.
    const queued = await tx.$queryRaw<Array<{ k: string | null }>>`
      SELECT DISTINCT l."externalId" AS k FROM "shopping_sync_logs" l WHERE (l."payload"->'order'->>'customer_id') = ANY(${text(subject.storefrontCustomerIds)})`
    const keys = await tx.$queryRaw<Array<{ k: string }>>`
      SELECT DISTINCT gdpr_webhook_order_key(w."payloadJson", w."resource") AS k FROM "shopping_webhook_events" w
       WHERE ${webhookWhere({ storefrontOrderIds: [], storefrontCustomerIds: subject.storefrontCustomerIds })}`
    const candidates = [...keys.map((r) => r.k), ...queued.map((r) => r.k ?? '')].filter((k) => /^[0-9]+$/.test(k) && !subject.storefrontOrderIds.includes(k))
    if (candidates.length > 0) {
      const held = new Set((await tx.shoppingOrderLink.findMany({ where: { connector: 'woocommerce', externalOrderId: { in: candidates } }, select: { externalOrderId: true } })).map((l) => l.externalOrderId))
      for (const id of candidates.filter((k) => !held.has(k))) {
        obligated.push(id)
        await tx.storefrontOrderErasureObligation.upsert({
          where: { connector_externalOrderId: { connector: 'woocommerce', externalOrderId: id } },
          create: { connector: 'woocommerce', externalOrderId: id },
          update: { retiredAt: null },
        })
      }
    }
  }

  if (subject.storefrontOrderIds.length > 0 || subject.storefrontCustomerIds.length > 0) {
    counts.rawWebhookEventsProjected += Number(await tx.$executeRaw`
      UPDATE "shopping_webhook_events" w
         SET "payloadJson" = gdpr_project_webhook_payload(w."payloadJson", w."resource"),
             "lastError" = CASE WHEN w."lastError" IS NULL THEN NULL ELSE ${RAW_PAYLOAD_MARKER}::text END
       WHERE ${webhookWhere(subject)} AND ${webhookDirty}`)
    const left = await tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM "shopping_webhook_events" w WHERE ${webhookWhere(subject)} AND ${webhookDirty}`
    if (Number(left[0]?.n ?? 0) > 0) throw new Error('Raw webhook payload projection incomplete')
  }

  // The storefront orders the sweep keys no-entityId rows by: the subject's linked ones AND the ones just obligated (customer-only, unimported).
  const sweepStorefrontIds = [...new Set([...subject.storefrontOrderIds, ...obligated])]
  for (const ids of subject.orderIds.length > 0 ? chunks(subject.orderIds) : [[] as string[]]) {
    const found = await tx.shoppingSyncLog.findMany({
      where: {
        connector: 'woocommerce',
        OR: [
          { entityType: { in: ['SalesOrder', 'ORDER'] }, entityId: { in: ids } },
          ...(sweepStorefrontIds.length > 0 ? [{ entityType: 'SalesOrder', entityId: null, externalId: { in: sweepStorefrontIds } }] : []),
        ],
      },
      select: { id: true },
    })
    // A row with no entityId (the queue, a refusal, a failed import) is keyed by the storefront order id; a row WITH one never is (externalId is one number space with refund ids).
    const logIds = found.map((r) => r.id)
    if (logIds.length === 0) continue
    counts.rawSyncLogsProjected += Number(await tx.$executeRaw`
      UPDATE "shopping_sync_logs" l
         SET "payload" = gdpr_project_sync_log_payload(l."payload"), "errorMessage" = gdpr_sync_log_row_message(l)
       WHERE l."id" = ANY(${text(logIds)}) AND gdpr_sync_log_row_dirty(l) AND gdpr_sync_log_row_erased(l)`)
    const left = await tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM "shopping_sync_logs" l WHERE l."id" = ANY(${text(logIds)}) AND gdpr_sync_log_row_dirty(l) AND gdpr_sync_log_row_erased(l)`
    if (Number(left[0]?.n ?? 0) > 0) throw new Error('Raw sync log projection incomplete')
  }

  // Returns: the order numbers the warehouse knows these orders by, and the return ids already known for them.
  const orders = await tx.salesOrder.findMany({ where: { id: { in: subject.orderIds } }, select: { orderNumber: true, externalOrderNumber: true } })
  const links = await tx.shoppingOrderLink.findMany({ where: { orderId: { in: subject.orderIds } }, select: { externalOrderNumber: true } })
  const pushLinks = await tx.wmsOrderPushLink.findMany({ where: { orderId: { in: subject.orderIds } }, select: { externalOrderNumber: true } })
  const refs = [...new Set([
    ...orders.flatMap((o) => [o.orderNumber, o.externalOrderNumber]),
    ...links.map((l) => l.externalOrderNumber),
    ...pushLinks.map((l) => l.externalOrderNumber),
  ].map((v) => (v ?? '').trim()).filter((v) => v !== ''))]
  const inbox = await tx.wmsReturnsInbox.findMany({
    where: { OR: [{ orderId: { in: subject.orderIds } }, ...(refs.length > 0 ? [{ orderId: null, reference: { in: refs } }] : [])] },
    select: { id: true, orderId: true, externalReturnId: true },
  })
  const unmatched = inbox.filter((r) => r.orderId === null).map((r) => r.id)
  if (unmatched.length > 0) {
    // The same clearing #844 gives a linked return; these rows had no order link for it to reach.
    for (const field of ['reason', 'resolutionNote'] as const) {
      await tx.wmsReturnsInbox.updateMany({ where: { id: { in: unmatched }, [field]: { not: null }, NOT: { [field]: RAW_PAYLOAD_MARKER } }, data: { [field]: RAW_PAYLOAD_MARKER } })
    }
    counts.rawReturnRecordsCleared += Number(await tx.$executeRaw`
      UPDATE "wms_returns_inbox" SET "rawPayload" = '{}'::jsonb WHERE "id" = ANY(${text(unmatched)}) AND "rawPayload" IS NOT NULL AND "rawPayload" <> '{}'::jsonb`)
  }
  // (After the clearing above: the marker's trigger would otherwise clear the payload first and the count would miss it.) A DURABLE MARKER on every inbox row the erasure reaches: a later poll that resolves the same return to no order (or to another) must still treat it as erased.
  if (inbox.length > 0) await tx.wmsReturnsInbox.updateMany({ where: { id: { in: inbox.map((r) => r.id) }, erasedAt: null }, data: { erasedAt: new Date() } })
  // The audit events of EVERY inbox row reached here (the linked ones are scrubbed by the free-text step too; this covers the unlinked ones it cannot find).
  if (inbox.length > 0) counts.rawReturnRecordsCleared += await scrubReturnInboxEvents(tx, inbox.map((r) => r.id))
  const returnIds = [...new Set(inbox.map((r) => r.externalReturnId))]
  if (returnIds.length > 0 || refs.length > 0) {
    counts.rawReturnRecordsCleared += await clearRawReturnLogs(tx, returnIds, refs)
  }
  return counts
}

/**
 * Projects the raw payloads of ERASED orders that neither the erasure nor the guard triggers saw: a delivery inserted while an erasure was still
 * uncommitted (the trigger cannot see an uncommitted marker). Idempotent, batch-limited, run from the email-outbox cron after each drain.
 * Returns the rows changed and the rows still left (the batch limit, or a row the finder could not reach).
 */
export async function reconcileRawPayloads(client: Pick<Prisma.TransactionClient, '$executeRaw' | '$queryRaw'>, batch = 500): Promise<{ projected: number; remaining: number }> {
  const projected = Number(await client.$executeRaw`
    UPDATE "shopping_webhook_events" w
       SET "payloadJson" = gdpr_project_webhook_payload(w."payloadJson", w."resource"),
           "lastError" = CASE WHEN w."lastError" IS NULL THEN NULL ELSE ${RAW_PAYLOAD_MARKER}::text END
     WHERE w."id" IN (SELECT w2."id" FROM "shopping_webhook_events" w2 WHERE w2."connector" = 'woocommerce' AND w2."resource" IN ('orders', 'refunds')
                         AND gdpr_storefront_order_erased(gdpr_webhook_order_key(w2."payloadJson", w2."resource"))
                         AND (w2."payloadJson" IS DISTINCT FROM gdpr_project_webhook_payload(w2."payloadJson", w2."resource") OR (w2."lastError" IS NOT NULL AND w2."lastError" <> ${RAW_PAYLOAD_MARKER}::text)) LIMIT ${batch})`)
  const logs = Number(await client.$executeRaw`
    UPDATE "shopping_sync_logs" l
       SET "payload" = gdpr_project_sync_log_payload(l."payload"), "errorMessage" = gdpr_sync_log_row_message(l)
     WHERE l."id" IN (SELECT l2."id" FROM "shopping_sync_logs" l2 WHERE gdpr_sync_log_row_erased(l2) AND gdpr_sync_log_row_dirty(l2) LIMIT ${batch})`)
  const leftWebhook = await client.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n FROM "shopping_webhook_events" w WHERE w."connector" = 'woocommerce' AND w."resource" IN ('orders', 'refunds')
       AND gdpr_storefront_order_erased(gdpr_webhook_order_key(w."payloadJson", w."resource")) AND ${webhookDirty}`
  const leftLogs = await client.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM "shopping_sync_logs" l WHERE gdpr_sync_log_row_erased(l) AND gdpr_sync_log_row_dirty(l)`
  return { projected: projected + logs, remaining: Number(leftWebhook[0]?.n ?? 0) + Number(leftLogs[0]?.n ?? 0) }
}

/** How many order and refund deliveries name no storefront order id at all, so no per-subject finder can ever reach them. Shown on the retention notice. */
export async function countUnkeyedStorefrontDeliveries(client: Pick<Prisma.TransactionClient, '$queryRaw'>): Promise<number> {
  const rows = await client.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n FROM "shopping_webhook_events" w
     WHERE w."connector" = 'woocommerce' AND w."resource" IN ('orders', 'refunds') AND w."payloadJson" <> '{}'::jsonb
       AND (gdpr_webhook_order_key(w."payloadJson", w."resource") IS NULL OR gdpr_webhook_order_key(w."payloadJson", w."resource") !~ '^[0-9]+$')`
  return Number(rows[0]?.n ?? 0)
}
