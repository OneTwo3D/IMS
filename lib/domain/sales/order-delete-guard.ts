import type { Prisma } from '@/app/generated/prisma/client'
import { WMS_LOOKUP_CONFIRMED_ABSENT } from '@/lib/domain/wms/order-status-sweep'
import { provesNoRemoteWmsCall } from '@/lib/domain/wms/order-push-sweep'
import { isOperatorAssertedSettlement } from '@/lib/domain/accounting/sync-row-settlement'

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
 * Daily batches (A1 revenue deferral / A2 inventory allocation / B shipment revenue+COGS)
 * are keyed by `referenceType='DailyBatch'` and a synthetic `<group>-<date>[-<8 hex digest>]`
 * referenceId, NOT by order id, so they cannot be found by an order-id lookup. They are
 * detected here from the batch reference the daily sync STAMPED on the row when it staged it
 * (revenueDeferredBatchRef / inventoryAllocatedBatchRef / Shipment.shipmentJournalBatchRef),
 * falling back for pre-o3d-0qoo rows to re-deriving that reference from the stage stamp
 * beside it (revenueDeferredDate / inventoryAllocatedDate / shipmentJournalDate).
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
    | 'committed_shipment'
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
 * Prisma `where` fragment matching the daily-batch referenceId a row was staged into.
 *
 * o3d-0qoo — TWO sources, and the match is their UNION:
 *
 *  - `persistedReferenceId`: the exact referenceId the daily sync stamped on the row inside
 *    the same transaction as the stage stamp. This is the reliable one, and the only one
 *    that survives a run crossing UTC midnight: both daily-sync implementations capture the
 *    batch date ONCE at run start and write the stage stamps with later new Date() calls, so
 *    a batch keyed A2-2026-07-20-<digest> can leave a stamp of 2026-07-21T00:0x:xxZ behind.
 *  - the derived shapes, in both forms that exist in the wild: the bare `<group>-<date>`
 *    QuickBooks writes and the digest-suffixed `<group>-<date>-<8 hex>` Xero's
 *    buildDailyBatchReferenceId writes. Pre-migration rows have no persisted ref, so this is
 *    all they have.
 *
 * The union — rather than "persisted, else derived" — is deliberate. This guard's job is to
 * REFUSE an irreversible delete, so it must never match a strictly smaller set than it did
 * before the column existed; a persisted ref that somehow disagreed with a real log would
 * otherwise open exactly the hole this closes. Over-matching costs a false blocker, which an
 * operator can investigate. Under-matching costs a journal nothing can take back out.
 *
 * Returns null only when the row was never staged into that batch at all.
 */
export function dailyBatchReferenceWhere(
  group: 'A1' | 'A2' | 'B',
  stagedAt: Date | string | null | undefined,
  persistedReferenceId?: string | null,
): Prisma.AccountingSyncLogWhereInput | null {
  const alternatives: Prisma.AccountingSyncLogWhereInput[] = []
  if (persistedReferenceId) alternatives.push({ referenceId: persistedReferenceId })
  const key = dailyBatchDateKey(stagedAt)
  if (key) {
    const bare = `${group}-${key}`
    alternatives.push({ referenceId: bare }, { referenceId: { startsWith: `${bare}-` } })
  }
  if (alternatives.length === 0) return null
  return { OR: alternatives }
}

export type SalesOrderDeleteStageStamps = {
  revenueDeferredDate: Date | null
  inventoryAllocatedDate: Date | null
  // o3d-0qoo: the exact batch referenceIds, required rather than optional so that a caller
  // that forgets to select them fails to compile instead of silently falling back to the
  // derive-from-stamp path this issue exists to stop relying on.
  revenueDeferredBatchRef: string | null
  inventoryAllocatedBatchRef: string | null
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
  //
  // ONE EXCEPTION (o3d-92fu): a VALIDATION_FAILED disposition the push sweep CREATED — no link
  // existed, so nothing had been claimed and buildPushInput threw on local data (a line with no
  // SKU) before pushOrder could be invoked. Without it, a purely local data error made an order
  // permanently undeletable: the failure aged into DEAD_LETTER, which this guard blocks on and
  // which the create pass will never retry.
  //
  // THE RULE IS NOT "attempts === 0" (o3d-2k5r). Read that way, this guard hard-deleted orders the
  // warehouse was fulfilling: claimForCreate writes its PENDING_CREATE claim at the schema default
  // of attempts 0 BEFORE the remote call, the increment that would record the call lives in a catch
  // whose write is `.catch(() => {})`-swallowed and does not run at all on a process kill, and the
  // disposition write then converted that claim while preserving attempts 0. Absence of a marker
  // was being read as a positive answer about a remote system.
  //
  // ONLY AN ABSENT LINK PROVES NOTHING WAS CALLED. Any pre-existing link — including a bare
  // PENDING_CREATE claim — is AMBIGUOUS, and the rule that says so lives in one place, next to the
  // writer that has to uphold it, so this reader cannot re-derive a weaker one.
  const pushLink = await tx.wmsOrderPushLink.findUnique({
    where: { orderId },
    select: { state: true, externalOrderNumber: true, externalOrderId: true, attempts: true, pushedAt: true },
  })
  if (pushLink && !provesNoRemoteWmsCall(pushLink)) {
    const ref = pushLink.externalOrderNumber ?? pushLink.externalOrderId
    // Name what actually blocks. Citing `attempts` alone printed "0 push attempts were made" for a
    // link carrying a real WMS order id — a refusal whose own reason argued for the delete.
    const evidence = ref
      ? `WMS order ${ref}`
      : pushLink.pushedAt
        ? 'a push to the warehouse is recorded against it'
        : `${pushLink.attempts} push attempt(s) may already have been dispatched`
    blockers.push({
      code: 'wms_order_push_link',
      message: pushLink.state === 'AMBIGUOUS_CREATE'
        // o3d-2k5r r4: its own message, because the generic one prescribes a remedy that cannot be
        // performed here. "Cancel the order so the WMS order is withdrawn" needs an external id to
        // withdraw, and the defining feature of this state is that IMS never learned one — a cancel
        // would report success having withdrawn nothing.
        ? 'Cannot delete an order whose WMS create was dispatched with no recorded outcome '
          + `(push state ${pushLink.state}). The warehouse may be holding an order for it under a `
          + 'reference IMS never learned, so a cancel here would withdraw nothing. Resolve it in the '
          + 'WMS first — the push chip carries the reference to search for and what to do with what '
          + 'you find.'
        : pushLink.state === 'VALIDATION_FAILED'
        ? `Cannot delete an order that may already have reached the warehouse management system `
          + `(${evidence}, and its payload only became invalid afterwards). A failed or unfinished push `
          + 'does not prove nothing was created — cancel the order instead so the WMS order is withdrawn.'
        : `Cannot delete an order that has been claimed for or sent to the warehouse management system `
          + `(push state ${pushLink.state}${ref ? `, WMS order ${ref}` : ''}). Cancel the order instead so the WMS order is withdrawn.`,
    })
  }

  // 2. Accounting documents keyed by this order (or by one of its shipments).
  const shipments = await tx.shipment.findMany({
    where: { orderId },
    // shipmentJournalDate / shipmentJournalBatchRef are for the Group B check further down,
    // and `status` for the committed-shipment blocker immediately below — read here so the
    // guard makes one shipment query rather than three.
    select: { id: true, status: true, shipmentJournalDate: true, shipmentJournalBatchRef: true },
  })
  const shipmentIds = shipments.map((shipment) => shipment.id)

  // 1c. A COMMITTED (non-PENDING) shipment is LOCAL evidence that fulfilment has started
  // (o3d-2y1c). Until now this query existed only to collect shipment ids for the accounting
  // checks, and nothing here blocked on a shipment at all — so a delete of an ALLOCATED order
  // holding a PICKING or PACKED shipment reached `salesOrderLine.deleteMany` and died on
  // `ShipmentLine.lineId`'s ON DELETE RESTRICT. The operator saw a raw foreign-key violation
  // rather than a reason, and the whole transaction rolled back.
  //
  // The FK firing is the database doing its job; the fix is to refuse BEFORE it, with a message
  // naming what blocks the delete and what can be done about it. This runs inside the same
  // order-row lock as every other blocker, so a shipment confirmed between the check and the
  // delete cannot slip through.
  //
  // PENDING is deliberately NOT a blocker. A PENDING shipment is a draft `confirmSalesOrderShipments`
  // generated from the allocation rows, it is not a commitment anywhere else in the codebase
  // (see UNCOMMITTED_SHIPMENT_STATUS), and `releaseOrderAllocationsInTx` — which the deleter calls
  // before deleting the lines — retires every unbacked draft via `reconcilePendingShipments`, whose
  // ShipmentLine rows cascade from Shipment. So the drafts are already gone by the time the lines
  // are deleted, and blocking on them would make every ordinary confirmed-allocation order
  // permanently undeletable. That half of the original o3d-2y1c report was fixed by PR #615.
  //
  // SHIPPED is included and is the most binding of the three: the stock has physically left, the
  // dispatch stock movements and FIFO consumption are done, and the allocation rows those cost
  // snapshots resolve through would go with the order. It can also now sit on an ALLOCATED (i.e.
  // status-deletable) order, because `reconcileOrderAfterShipment` no longer promotes an order that
  // shipped short to SHIPPED (o3d-0i5y) — so this blocker is what keeps that new state safe.
  const committedShipments = shipments.filter((shipment) => String(shipment.status) !== 'PENDING')
  if (committedShipments.length > 0) {
    const byStatus = new Map<string, number>()
    for (const shipment of committedShipments) {
      const status = String(shipment.status)
      byStatus.set(status, (byStatus.get(status) ?? 0) + 1)
    }
    const summary = [...byStatus.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([status, count]) => `${count} ${status.toLowerCase()}`)
      .join(', ')
    const hasDispatched = byStatus.has('SHIPPED')
    blockers.push({
      code: 'committed_shipment',
      message:
        `Cannot delete an order the warehouse has already started fulfilling (${summary}). `
        + (hasDispatched
          // Cancelling does NOT undo a dispatch — cancelSalesOrderFulfillmentState deletes the
          // PENDING/PICKING/PACKED shipments and leaves SHIPPED ones alone — so do not offer it
          // as the remedy for goods that have physically left.
          ? 'A dispatched shipment is stock that has already left the building, and its cost '
            + 'entries resolve through this order’s allocation rows — deleting the order would '
            + 'strand them. Raise a refund or return for the dispatched units instead; an order '
            + 'that has shipped is never a candidate for hard deletion.'
          // PICKING/PACKED only: cancellation is a real, atomic remedy — it deletes those
          // shipments in the same transaction as the allocation release.
          : 'A picked or packed shipment is stock the warehouse is already holding against this '
            + 'order. Cancel the order instead — cancelling deletes its picked and packed shipments '
            + 'and releases the reservations in one step. To keep the order and clear this blocker '
            + 'instead, use "Reopen for repack" on each picked/packed shipment (o3d-2k5): that reverts '
            + 'it to a PENDING draft, and a PENDING draft is deliberately not a blocker here.'),
    })
  }
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
  // DELIBERATELY NOT COVERED (o3d-anu8): a row an OPERATOR settled as NOT_POSTED. It lands CANCELLED
  // with externalTransactionId left NULL, so it matches neither arm above and the blocker for it
  // disappears — and that is the intended consequence, not an oversight. `buildSettlementData` says
  // so in as many words where it explains why the NOT_POSTED patch must never WRITE and never CLEAR
  // an external id: "leaving the column untouched leaves it NULL, which is what makes the order
  // deletable again". The alternative is the state o3d-nf9i exists to end, where a FAILED row that
  // nothing can resolve blocks the delete for ever. What makes it acceptable is that the assertion is
  // an audited act with a person's name on it (app/actions/accounting-settlement.ts), not that the
  // system has established anything — so this is the one place in this guard where a human's word,
  // and not evidence, is what lets a delete through.
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
    // o3d-anu8: settlementBasis, because SYNCED-plus-an-external-id is written by TWO things — the
    // connector's own writeback after the ledger answered, and an operator typing a document id into
    // the settlement dialog. This guard reports the first as fact; without this column it reports the
    // second as fact too.
    select: { id: true, connector: true, type: true, status: true, externalTransactionId: true, settlementBasis: true },
  })

  // Order matters: with several rows, findFirst could return a merely QUEUED one ahead of a
  // POSTED one and advise cancelling a document that is already in the ledger. Posted evidence
  // wins, then FAILED (unknown), then in-flight, then queued — most severe remedy first.
  //
  // o3d-anu8 splits the top rank in two. An operator-ASSERTED post still blocks the delete and still
  // needs a reversal, so it stays above FAILED; but where a connector-confirmed row exists as well,
  // that is the one to show, because its instruction rests on something the ledger said.
  const rank = (row: { status: string; externalTransactionId: string | null; settlementBasis: string | null }): number => {
    const posted = Boolean(row.externalTransactionId) || row.status === 'SYNCED'
    if (posted) return isOperatorAssertedSettlement(row.settlementBasis) ? 1 : 0
    if (row.status === 'FAILED') return 2
    if (row.status === 'PROCESSING') return 3
    return 4
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
        // o3d-anu8: SAY WHOSE CLAIM IT IS. "is already POSTED as X" is a statement about the ledger,
        // and on a settled row nobody has read the ledger: a human typed X in, IMS made no call and
        // compared no figure. The blocker is the same (the order must not be deleted while a document
        // may stand against it) but the instruction is not — "reverse it" assumes the document exists,
        // which is the very thing that has not been established.
        ? isOperatorAssertedSettlement(liveDocument.settlementBasis)
          ? `Cannot delete an order whose ${liveDocument.connector} accounting document (${liveDocument.type}) an OPERATOR `
            + `recorded as POSTED${liveDocument.externalTransactionId ? ` (${liveDocument.externalTransactionId})` : ''}. `
            + 'That is an assertion, not a confirmation: IMS never made the call and never read the document, so this id '
            + 'is what somebody typed in. Open it in the accounting system first. If the document is there it needs an '
            + 'explicit reversal or credit note — cancelling the order does NOT reverse a posted document; if it is not '
            + 'there, the settlement was recorded in error and that is what has to be corrected before anything is deleted.'
          : `Cannot delete an order whose ${liveDocument.connector} accounting document (${liveDocument.type}) `
            + `is already POSTED${liveDocument.externalTransactionId ? ` as ${liveDocument.externalTransactionId}` : ''}. `
            + 'It needs an explicit reversal or credit note in the accounting system — '
            + 'cancelling the order does NOT reverse a posted document.'
        : liveDocument.status === 'FAILED'
          ? `Cannot delete an order whose ${liveDocument.connector} accounting document (${liveDocument.type}) is FAILED. `
            + 'A failed sync does not prove nothing was posted — the remote call happens before the result is written back, '
            + 'so the document may exist in the ledger. Check the connector, then resolve the sync log.'
          : liveDocument.status === 'PROCESSING'
            // A claimed PROCESSING row is deliberately NOT retired by cancellation — the remote call
            // may be in flight — so promising a cancel would be wrong here too.
            //
            // "Wait for it to settle" is only true while the row's connector is ENABLED. Since
            // o3d-sref the orphan sweep no longer retires a stale claim, so a row belonging to a
            // switched-off connector stays PROCESSING indefinitely: no processor runs for it, and
            // nothing else terminalises it. Telling that operator to wait is advice that provably
            // cannot work, which is how a blocker becomes a dead end — so both cases are named.
            ? `Cannot delete an order whose ${liveDocument.connector} accounting document (${liveDocument.type}) `
              + `is IN FLIGHT. If ${liveDocument.connector} is still the active accounting connector, wait `
              + 'for it to settle, then delete or reverse depending on the outcome. If it has been '
              + 'switched off, this will NOT settle on its own: it can only be reclaimed by making '
              + `${liveDocument.connector} the EXCLUSIVELY active connector again — enabling it alongside `
              + 'another one is not enough, because only one accounting connector is ever dispatched to. '
              + 'If that is not possible, this order cannot currently be deleted (o3d-osl8): check the '
              + 'ledger for the document, because whether it exists decides whether deleting the order '
              + 'would strand it.'
            : `Cannot delete an order with accounting documents queued to ${liveDocument.connector} `
              + `(${liveDocument.type}, ${liveDocument.status}). Cancel the order instead so the document is retired before it posts.`,
    })
  }

  // 3. Daily batches. These are DailyBatch-keyed, so they are unreachable by order id — match
  // them on the batch reference the daily sync stamped on the row when it staged it, or, for
  // pre-o3d-0qoo rows that have none, on one re-derived from the stage stamp. A live batch
  // log means this order's value is inside a journal that is queued or already in the
  // ledger, and nothing here can take it back out.
  //
  // Group B (shipment revenue recognition + COGS) is checked alongside A1/A2 because it is
  // the same kind of claim: a DailyBatch-keyed journal that carries THIS order's value and
  // cannot be un-posted from here. Its stage stamp lives on the shipments rather than the
  // order, and its FK cascades, so deleting the order erases the only local record of what
  // the journal was built from.
  const stagedBatches: Array<{
    group: 'A1' | 'A2' | 'B'
    type: string
    label: string
    stagedAt: Date | null
    persistedRef: string | null
  }> = [
    {
      group: 'A1',
      type: 'DAILY_BATCH_REVENUE_DEFERRAL',
      label: 'A1 revenue deferral',
      stagedAt: stamps.revenueDeferredDate,
      persistedRef: stamps.revenueDeferredBatchRef,
    },
    {
      group: 'A2',
      type: 'DAILY_BATCH_INVENTORY_ALLOC',
      label: 'A2 inventory allocation',
      stagedAt: stamps.inventoryAllocatedDate,
      persistedRef: stamps.inventoryAllocatedBatchRef,
    },
    // One entry per journalled shipment: two shipments of the same order can be staged into
    // two different Group B batches (they are staged as they ship), so a single stamp cannot
    // stand for the order.
    ...shipments
      .filter((shipment) => shipment.shipmentJournalDate || shipment.shipmentJournalBatchRef)
      .map((shipment) => ({
        group: 'B' as const,
        type: 'DAILY_BATCH_GROUP_B',
        label: 'B shipment revenue/COGS',
        stagedAt: shipment.shipmentJournalDate,
        persistedRef: shipment.shipmentJournalBatchRef,
      })),
  ]
  // Several shipments of one order commonly land in the SAME Group B batch, and each would
  // otherwise repeat an identical query and push an identical blocker.
  const seenBatchKeys = new Set<string>()
  for (const batch of stagedBatches) {
    const batchKey = `${batch.group}|${batch.persistedRef ?? ''}|${dailyBatchDateKey(batch.stagedAt) ?? ''}`
    if (seenBatchKeys.has(batchKey)) continue
    seenBatchKeys.add(batchKey)
    const referenceWhere = dailyBatchReferenceWhere(batch.group, batch.stagedAt, batch.persistedRef)
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
    // o3d-2y1c: ranks below the accounting blockers (whose remedies are a ledger reversal or
    // waiting on an in-flight call) and above the WMS ones. A dispatched shipment is a physical
    // fact about goods; a WMS record is a fact about a document, and cancelling resolves the
    // latter. Ranked as one code rather than splitting SHIPPED out, because both variants of the
    // message are more specific than either WMS message.
    'committed_shipment',
    'wms_order_status_snapshot',
    'wms_order_push_link',
  ]
  const severity = (blocker: SalesOrderDeleteBlocker) => {
    const index = REMEDY_ORDER.indexOf(blocker.code)
    return index === -1 ? REMEDY_ORDER.length : index
  }
  return [...blockers].sort((a, b) => severity(a) - severity(b))[0]
}
