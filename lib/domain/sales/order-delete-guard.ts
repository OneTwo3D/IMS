import type { Prisma } from '@/app/generated/prisma/client'
import { WMS_LOOKUP_CONFIRMED_ABSENT } from '@/lib/domain/wms/order-status-sweep'

/**
 * o3d-5r8 — hard-delete safety for sales orders.
 *
 * A hard delete removes the ONLY thing in IMS that points at whatever the posting
 * workers already put (or are about to put) in an external system. Once the order row
 * is gone there is no order id to reconcile against, no allocation to reverse, and the
 * back-reference writes fail silently — the external ledger/WMS keeps a document that
 * IMS can no longer see, let alone reverse.
 *
 * The protocol is: every worker that makes a remote call for an order must first CLAIM
 * that work in a row the deleter can see, taking the order's row lock so the claim and
 * the delete serialise. The deleter then takes the same lock and refuses while any claim
 * is live. The two claim rows are:
 *
 *  - AccountingSyncLog — written at enqueue time (queueAccountingSync), i.e. strictly
 *    before any remote call, and stays PENDING → PROCESSING → SYNCED for the whole flight.
 *    A live row therefore covers both "queued", "in flight" and "already posted".
 *  - WmsOrderPushLink — until o3d-5r8 the WMS create pass had NO such row before its
 *    remote call (the link was written only AFTER pushOrder returned), so the push sweep
 *    now claims the link under the order lock before calling the WMS.
 *
 * Daily batches (A1 revenue deferral / A2 inventory allocation) are keyed by
 * `referenceType='DailyBatch'` and a synthetic `<group>-<date>[-<8 hex digest>]`
 * referenceId, NOT by order id, so they cannot be found by an order-id lookup. They are
 * detected here from the order's own stage stamps (revenueDeferredDate /
 * inventoryAllocatedDate) mapped to the batch reference the daily sync would have used.
 *
 * NOTE: this module only REFUSES. It does not reverse anything. Reversal semantics for
 * an already-posted A2 (so an allocated order can be withdrawn from the ledger rather
 * than merely protected from deletion) are tracked separately.
 */

/**
 * Sync-log statuses that must block an irreversible delete.
 *
 * PENDING / PROCESSING / SYNCED are "queued, in flight, or already in the external ledger" —
 * obviously blocking.
 *
 * FAILED is here too (o3d-ju8t), because it does NOT mean "nothing was posted". The accounting
 * processors make the REMOTE CALL BEFORE persisting SYNCED and the externalTransactionId: see
 * lib/connectors/xero/sync-processor.ts, where processEntry posts and only then opens the
 * transaction that records the result. An exception in that persistence window is caught and the
 * same row can later terminalise as FAILED — with a real document sitting in the ledger.
 *
 * So FAILED spans two genuinely different situations, "rejected before any remote mutation" and
 * "remote document exists, writeback failed", and nothing durable distinguishes them today.
 * Treating it as proof of the first is reading absence of a success marker as a positive fact
 * about the external system, on a path that cannot be undone. It fails closed instead.
 *
 * The cost is that an order whose accounting genuinely failed pre-call cannot be hard-deleted
 * until someone resolves the row. That is the right side to err on for an irreversible
 * operation, and the blocker message says so. Recording pre-call rejection distinctly — so it
 * can be safely ignored here — is the rest of o3d-ju8t.
 */
export const LIVE_ACCOUNTING_SYNC_STATUSES = ['PENDING', 'PROCESSING', 'SYNCED', 'FAILED'] as const

export type SalesOrderDeleteBlocker = {
  code:
    | 'wms_order_push_link'
    | 'wms_order_status_snapshot'
    | 'accounting_sync_live'
    | 'accounting_document_exists'
    | 'daily_batch_staged'
    | 'parked_refund'
  message: string
}

/**
 * `YYYY-MM-DD` key for a daily-batch stage stamp. Mirrors the accounting invariant
 * suite's dateKey so both derive the same batch reference from the same stamp.
 */
export function dailyBatchDateKey(value: Date | string | null | undefined): string | null {
  if (!value) return null
  const date = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString().slice(0, 10)
}

/**
 * Prisma `where` fragment matching a daily-batch referenceId for one stage date, in both
 * shapes that exist in the wild: the bare `<group>-<date>` QuickBooks writes and the
 * digest-suffixed `<group>-<date>-<8 hex>` Xero's buildDailyBatchReferenceId writes.
 * Returns null when the order was never staged into that batch.
 */
export function dailyBatchReferenceWhere(
  group: 'A1' | 'A2' | 'B',
  stagedAt: Date | string | null | undefined,
): Prisma.AccountingSyncLogWhereInput | null {
  const key = dailyBatchDateKey(stagedAt)
  if (!key) return null
  const bare = `${group}-${key}`
  return { OR: [{ referenceId: bare }, { referenceId: { startsWith: `${bare}-` } }] }
}

export type SalesOrderDeleteStageStamps = {
  revenueDeferredDate: Date | null
  inventoryAllocatedDate: Date | null
}

/**
 * Returns the reason a sales order must NOT be hard-deleted, or null when no external
 * document (or in-flight claim for one) references it.
 *
 * MUST be called inside the same transaction that takes the order's row lock and
 * performs the delete — the whole point is that a worker cannot slip a claim in between
 * the check and the delete.
 */
export async function findSalesOrderDeleteBlocker(
  tx: Prisma.TransactionClient,
  orderId: string,
  stamps: SalesOrderDeleteStageStamps,
): Promise<SalesOrderDeleteBlocker | null> {
  // Blockers are COLLECTED, not returned on first hit (o3d-eu0r r2). Several can apply at once —
  // a WMS snapshot alongside a PROCESSING or FAILED accounting row is ordinary — and the remedies
  // are NOT interchangeable. Returning the WMS one first told an operator to cancel while an
  // accounting call was still in flight or its outcome unknown, which is exactly how a cancelled
  // IMS order ends up with a live invoice in the ledger. They are ranked below by how severe the
  // required remedy is, so the operator is always told the most binding thing first.
  const blockers: SalesOrderDeleteBlocker[] = []

  // 0. Durable external-document markers, checked FIRST because they are the only evidence here
  // that survives retention (o3d-v7sy). Everything else in this guard reads AccountingSyncLog,
  // and purgeExpiredData deletes those rows past the retention window (six months by default).
  // An old order can therefore hold a real invoice in the external ledger, have no retained sync
  // row, and pass every other check — hard-deleted, stranding the document with no IMS order
  // behind it. accountingInvoiceId lives on the order itself and is never purged.
  //
  // CAVEAT (o3d-0g2n): this marker is only as reliable as the writeback that sets it. On
  // QuickBooks, updateBackReference runs after the sync row is SYNCED, swallows its failure, and
  // has no repair sweep — so a transient failure leaves a real invoice with no accountingInvoiceId.
  // Until that is fixed, the sync-log checks below are what covers that case, and only until
  // retention purges them.
  //
  // accountingInvoiceId ONLY — deliberately NOT invoicedAt. generateInvoiceNumber sets invoicedAt
  // when it merely assigns a LOCAL invoice number (app/actions/sales.ts ~2680), and that action is
  // available even with accounting sync disabled. Treating it as external-post evidence would make
  // an otherwise deletable order with no payments, no sync logs and no accounting document
  // permanently undeletable.
  const invoiced = await tx.salesOrder.findUnique({
    where: { id: orderId },
    select: { accountingInvoiceId: true },
  })
  if (invoiced?.accountingInvoiceId) {
    blockers.push({
      code: 'accounting_document_exists',
      message:
        `Cannot delete an order with an accounting document already posted `
        + `(invoice ${invoiced.accountingInvoiceId}). It needs an explicit reversal or credit note `
        + `in the accounting system first — cancelling the order does NOT reverse a posted invoice.`,
    })
  }

  // 1a. A WMS status snapshot is independent evidence that the warehouse holds this order
  // (o3d-eu0r). WmsOrderStatusSnapshot is populated by looking storefront-linked orders up in
  // the WMS, so it can carry a confirmed externalOrderId with NO push link — an order the WMS
  // knows about that this IMS never pushed. Worse, its FK is onDelete: Cascade, so deleting the
  // order silently erases the only local record that the remote order exists.
  //
  // order-status-sweep writes an empty externalOrderId in TWO different situations, and only one
  // of them is safe to delete on:
  //   - an AUTHORITATIVE lookup that found no such order  -> lastError = WMS_LOOKUP_NOT_FOUND
  //   - a lookup that ERRORED                             -> lastError = the exception message
  // Nothing ever removes either row. Blocking on both made an order that never reached the WMS
  // permanently undeletable; blocking on neither lets a genuine remote order be orphaned when the
  // lookup merely failed. So: positive evidence blocks, an authoritative MISSING does not, and
  // anything else — an error, or no marker at all — FAILS CLOSED (o3d-eu0r).
  //
  // STILL OPEN (o3d-x9nc): fetchOrderStatus returns null for BOTH "definitively absent" and
  // "ambiguous" (several merged candidates matching one reference), so both land on the same
  // WMS_LOOKUP_NOT_FOUND placeholder and an ambiguous result is still read as safe to delete.
  // Distinguishing them needs a persisted tri-state outcome rather than this lastError literal,
  // which is a stopgap — two files agreeing on a string, which is why it is exported rather than
  // duplicated.
  const snapshot = await tx.wmsOrderStatusSnapshot.findUnique({
    where: { orderId },
    select: {
      connectorLabel: true,
      externalOrderNumber: true,
      externalOrderId: true,
      statusLabel: true,
      lastError: true,
    },
  })
  if (snapshot && !snapshot.externalOrderId && snapshot.lastError !== WMS_LOOKUP_CONFIRMED_ABSENT) {
    blockers.push({
      code: 'wms_order_status_snapshot',
      message:
        `Cannot delete an order whose ${snapshot.connectorLabel} status lookup did not complete `
        + `(${snapshot.lastError ?? 'no result recorded'}). Until a lookup authoritatively reports the `
        + 'order is absent, it may still exist in the warehouse — re-run the status sweep, then retry.',
    })
  }
  if (snapshot?.externalOrderId) {
    const ref = snapshot.externalOrderNumber || snapshot.externalOrderId
    blockers.push({
      code: 'wms_order_status_snapshot',
      message:
        `Cannot delete an order the warehouse management system already holds `
        + `(${snapshot.connectorLabel} order ${ref}, ${snapshot.statusLabel}). Cancel the order instead `
        + 'so the WMS order is withdrawn — deleting would erase the only local record of it.',
    })
  }

  // 1b. WMS push link. The link row is the push sweep's claim: it exists from immediately before
  // the remote create until the order is withdrawn, so ANY link means the WMS may hold
  // (or be about to be handed) this order.
  const pushLink = await tx.wmsOrderPushLink.findUnique({
    where: { orderId },
    select: { state: true, externalOrderNumber: true, externalOrderId: true },
  })
  if (pushLink) {
    const ref = pushLink.externalOrderNumber ?? pushLink.externalOrderId
    blockers.push({
      code: 'wms_order_push_link',
      message:
        `Cannot delete an order that has been claimed for or sent to the warehouse management system ` +
        `(push state ${pushLink.state}${ref ? `, WMS order ${ref}` : ''}). Cancel the order instead so the WMS order is withdrawn.`,
    })
  }

  // 2. Accounting documents keyed by this order (or by one of its shipments).
  const shipments = await tx.shipment.findMany({ where: { orderId }, select: { id: true } })
  const shipmentIds = shipments.map((shipment) => shipment.id)
  const orderKeyed: Prisma.AccountingSyncLogWhereInput[] = [
    { referenceType: 'SalesOrder', referenceId: orderId },
  ]
  if (shipmentIds.length > 0) {
    orderKeyed.push({ referenceType: 'Shipment', referenceId: { in: shipmentIds } })
  }
  // externalTransactionId is the POST evidence, and status is not a proxy for it: Xero reverts an
  // already-posted row to PENDING when follow-up work fails, KEEPING the external id, and
  // cancelOrphanedAccountingSyncRows can then move that row to CANCELLED without clearing it.
  // So the STATUS FILTER cannot come first — a posted-but-cancelled row would not even be
  // selected, and if the back-reference also failed there is no accountingInvoiceId either. The
  // match is therefore "live status OR carries an external id", whatever the status (o3d-v7sy).
  //
  // NOT COVERED (o3d-sref): a STALE PROCESSING claim that the orphan sweep retires to CANCELLED
  // before its worker wrote a result. There is no external id yet, so nothing here can see it,
  // and a late remote success then strands the document. Closing that needs the orphan sweep to
  // keep such rows ambiguous rather than retired, and the processors to fence their writeback on
  // the claim they hold — the guard cannot do it alone.
  const candidateDocuments = await tx.accountingSyncLog.findMany({
    where: {
      OR: orderKeyed,
      AND: [{
        OR: [
          { status: { in: [...LIVE_ACCOUNTING_SYNC_STATUSES] } },
          { externalTransactionId: { not: null } },
        ],
      }],
    },
    select: { id: true, connector: true, type: true, status: true, externalTransactionId: true },
  })

  // Order matters: with several rows, findFirst could return a merely QUEUED one ahead of a
  // POSTED one and advise cancelling a document that is already in the ledger. Posted evidence
  // wins, then FAILED (unknown), then in-flight, then queued — most severe remedy first.
  const rank = (row: { status: string; externalTransactionId: string | null }): number => {
    if (row.externalTransactionId || row.status === 'SYNCED') return 0
    if (row.status === 'FAILED') return 1
    if (row.status === 'PROCESSING') return 2
    return 3
  }
  const liveDocument = [...candidateDocuments].sort((a, b) => rank(a) - rank(b))[0] ?? null
  if (liveDocument) {
    blockers.push({
      code: 'accounting_sync_live',
      // The remedy depends on whether the document is ALREADY IN THE LEDGER, which is what
      // externalTransactionId records — not on status alone. cancelOrderInvoiceSync retires
      // PENDING / FAILED / stale-PROCESSING rows and explicitly leaves SYNCED alone, because a
      // cancel-after-post needs an explicit reversal. Telling an operator to cancel a posted
      // document leaves a live receivable against a CANCELLED order.
      message: (liveDocument.status === 'SYNCED' || liveDocument.externalTransactionId)
        ? `Cannot delete an order whose ${liveDocument.connector} accounting document (${liveDocument.type}) `
          + `is already POSTED${liveDocument.externalTransactionId ? ` as ${liveDocument.externalTransactionId}` : ''}. `
          + 'It needs an explicit reversal or credit note in the accounting system — '
          + 'cancelling the order does NOT reverse a posted document.'
        : liveDocument.status === 'FAILED'
          ? `Cannot delete an order whose ${liveDocument.connector} accounting document (${liveDocument.type}) is FAILED. `
            + 'A failed sync does not prove nothing was posted — the remote call happens before the result is written back, '
            + 'so the document may exist in the ledger. Check the connector, then resolve the sync log.'
          : liveDocument.status === 'PROCESSING'
            // A freshly claimed PROCESSING row is deliberately NOT retired by cancellation — the
            // remote call may be in flight — so promising a cancel would be wrong here too.
            ? `Cannot delete an order whose ${liveDocument.connector} accounting document (${liveDocument.type}) `
              + 'is IN FLIGHT. Wait for it to settle, then delete or reverse depending on the outcome.'
            : `Cannot delete an order with accounting documents queued to ${liveDocument.connector} `
              + `(${liveDocument.type}, ${liveDocument.status}). Cancel the order instead so the document is retired before it posts.`,
    })
  }

  // 3. Daily batches. These are DailyBatch-keyed, so they are unreachable by order id —
  // derive the batch reference from the order's own stage stamps instead. A live batch
  // log means this order's value is inside a journal that is queued or already in the
  // ledger, and nothing here can take it back out.
  const stagedBatches: Array<{ group: 'A1' | 'A2'; type: string; label: string; stagedAt: Date | null }> = [
    { group: 'A1', type: 'DAILY_BATCH_REVENUE_DEFERRAL', label: 'A1 revenue deferral', stagedAt: stamps.revenueDeferredDate },
    { group: 'A2', type: 'DAILY_BATCH_INVENTORY_ALLOC', label: 'A2 inventory allocation', stagedAt: stamps.inventoryAllocatedDate },
  ]
  for (const batch of stagedBatches) {
    const referenceWhere = dailyBatchReferenceWhere(batch.group, batch.stagedAt)
    if (!referenceWhere) continue
    const liveBatch = await tx.accountingSyncLog.findFirst({
      where: {
        status: { in: [...LIVE_ACCOUNTING_SYNC_STATUSES] },
        type: batch.type as Prisma.AccountingSyncLogWhereInput['type'],
        referenceType: 'DailyBatch',
        ...referenceWhere,
      },
      select: { id: true, connector: true, referenceId: true, status: true },
    })
    if (!liveBatch) continue
    blockers.push({
      code: 'daily_batch_staged',
      message:
        `Cannot delete an order included in the ${batch.label} daily accounting batch ` +
        `(${liveBatch.connector} ${liveBatch.referenceId}, ${liveBatch.status}). ` +
        `The batch journal cannot be un-posted from here — cancel the order and have finance reverse the batch entry.`,
    })
  }

  // o3d-7yf / o3d-iup: a deliberately PARKED WooCommerce refund — a monetary-only refund the order
  // cannot tax uniformly, or a PENDING/FAILED amount mismatch — creates NO SalesOrderRefund, so the
  // caller's `_count.refunds` check cannot see it. Deleting the order cascades its
  // ShoppingOrderLink and orphans the park, so retryRefundSyncPark can never resolve the WC link,
  // stranding a refund whose money has already left the business.
  //
  // This runs on `tx`, inside the same order-row lock as every other blocker (o3d-5r8). Reading it
  // on the unlocked client would reopen exactly the window that lock exists to close: a park
  // written between the check and the delete would be missed.
  //
  // entityId scoping already excludes the entity-less missing-FX rows.
  const parkedRefund = await tx.shoppingSyncLog.findFirst({
    where: {
      connector: 'woocommerce',
      direction: 'FROM_CONNECTOR',
      entityType: 'SalesOrder',
      entityId: orderId,
      status: { in: ['PENDING', 'FAILED', 'QUARANTINED'] },
    },
    select: { id: true },
  })
  if (parkedRefund) {
    blockers.push({
      code: 'parked_refund',
      message: 'This order has an unresolved WooCommerce refund parked for review; resolve it in the '
        + 'sync exceptions inbox before deleting the order.',
    })
  }

  if (blockers.length === 0) return null

  // Most binding remedy first. A posted document needs a finance reversal; an ambiguous FAILED
  // one needs the connector checked before anything else is done; an in-flight one needs waiting.
  // Only once none of those apply is "cancel the order" the right advice — so WMS evidence and
  // merely-queued accounting work rank last, because cancelling genuinely resolves them.
  const REMEDY_ORDER: SalesOrderDeleteBlocker['code'][] = [
    // A parked refund outranks everything: the money has ALREADY left the business, and unlike
    // the others, cancelling the order does not resolve it (o3d-7yf/o3d-iup).
    'parked_refund',
    'accounting_document_exists',
    'daily_batch_staged',
    'accounting_sync_live',
    'wms_order_status_snapshot',
    'wms_order_push_link',
  ]
  const severity = (blocker: SalesOrderDeleteBlocker) => {
    const index = REMEDY_ORDER.indexOf(blocker.code)
    return index === -1 ? REMEDY_ORDER.length : index
  }
  return [...blockers].sort((a, b) => severity(a) - severity(b))[0]
}
