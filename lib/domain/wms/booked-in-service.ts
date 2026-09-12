import { db } from '@/lib/db'
import {
  WMS_INBOUND_EVENT_PROCESSING_STATUS,
  type WmsInboundEventProcessingStatus,
} from '@/lib/domain/wms/inbound-event-status'
import { logActivity } from '@/lib/activity-log'
import { recordWmsMutationEvent } from '@/lib/domain/wms/mutation-audit'
import type { WmsAsnRef } from '@/lib/connectors/wms/types'
import { recreateTransferCostLayersFromSnapshotSlice } from '@/lib/domain/inventory/transfer-cost-layer-recreation'
import {
  buildBookedInDryRun,
  isTransferUsableForWmsReceipt,
  reconcileBookedInQuantities,
  sliceTransferSnapshotForReceipt,
  type BookedInDryRun,
  type BookedInDryRunWarningCode,
} from './asn-reconciliation'
import { enqueueStockSync } from '@/lib/shopping'
import {
  isStockMovementIdempotencyConflict,
  wmsPurchaseReceiptMovementKey,
  wmsTransferInMovementKey,
} from '@/lib/domain/inventory/stock-movement-idempotency'
import {
  buildStockMovementValueFields,
  buildStockMovementValueFieldsFromTotal,
} from '@/lib/domain/inventory/stock-movement-value'
import { addMoney, multiplyMoney, toDecimal } from '@/lib/domain/math/decimal'
import { withSavepoint } from '@/lib/db/savepoint'
import {
  isTransferLineFullyLanded,
  loadTransferLineLandedQty,
  requireLandedQty,
} from '@/lib/domain/inventory/transfer-landed-quantity'
import {
  assertParentIsLocked,
  assertParentsWereLocked,
  lockPurchaseOrders,
  lockStockTransfers,
  lockWmsAsnLineMaps,
  lockWmsAsnMaps,
} from '@/lib/domain/wms/transfer-asn-lock-order'

// Booked-in reconciliation mutates stock levels, FIFO layers, PO lines, and sync state in one unit.
// The longer timeout avoids false rollback on large ASNs while preserving a bounded lock window.
const STOCK_TX_OPTIONS = { maxWait: 5000, timeout: 20000 }
const PENDING_ASN_FINALIZATION_REASON_PREFIX = 'PENDING_ASN_FINALIZATION:'
const MAX_PENDING_ATTEMPTS = 12
const MAX_FAILED_ATTEMPTS = 8
const PENDING_RETRY_BASE_MS = 60 * 1000
const FAILED_RETRY_BASE_MS = 5 * 60 * 1000
const MAX_PENDING_RETRY_MS = 30 * 60 * 1000
const MAX_FAILED_RETRY_MS = 60 * 60 * 1000

// The lifecycle values live in their own connector-agnostic module (see there for why); re-exported
// here because this file's own callers have always imported them from it.
export {
  WMS_INBOUND_EVENT_PROCESSING_STATUS,
  type WmsInboundEventProcessingStatus,
} from '@/lib/domain/wms/inbound-event-status'

// Approval-blocking warnings are structural mismatches that admin acknowledgement alone cannot
// resolve; the underlying IMS/Mintsoft data must be corrected. `received_over_expected` is a
// variance signal, so approval treats the over-count as accepted for processing.
const APPROVAL_BLOCKED_WARNING_CODES = new Set<BookedInDryRunWarningCode>([
  'remote_regression',
  'missing_local_line',
  'unsupported_source_type',
  'cost_layer_snapshot_missing',
])


type WebhookRetryKind = 'pending' | 'failed'

type WebhookRetryUpdate = {
  processingStatus: WmsInboundEventProcessingStatus
  processingAttempts: number
  nextRetryAt: Date | null
  deadLetteredAt: Date | null
  lastError: string
}

export type ProcessMintsoftBookedInResult =
  | {
    status: 'processed'
    eventId: string
    externalAsnId: string
    productIds: string[]
  }
  | {
    status: 'duplicate'
    eventId: string
    externalAsnId: string | null
  }
  | {
    status: 'pending'
    eventId: string
    externalAsnId: string | null
    reason: string
  }
  | {
    status: 'requires_review'
    eventId: string
    externalAsnId: string
    dryRun: BookedInDryRun
  }
  | {
    status: 'failed'
    eventId: string
    externalAsnId: string | null
    error: string
  }

export type ProcessMintsoftBookedInEventOptions = {
  fetchRemoteAsn: (externalAsnId: string) => Promise<WmsAsnRef | null>
  approveReview?: boolean
}

function formatReceiptReference(externalAsnId: string, poReference: string): string {
  const normalizedAsnId = externalAsnId.replace(/[^A-Za-z0-9-]/g, '').slice(0, 32) || 'ASN'
  return `MS-${normalizedAsnId}-${poReference}`.slice(0, 100)
}

async function markEventFailed(eventId: string, error: string): Promise<void> {
  await scheduleWebhookRetry(eventId, 'failed', error)
}

async function markEventPending(eventId: string, reason: string): Promise<void> {
  await scheduleWebhookRetry(eventId, 'pending', normalizePendingReason(reason))
}

function reviewErrorMessage(dryRun: BookedInDryRun): string {
  return `Mintsoft booked-in review required: ${dryRun.warnings.join(', ')}`
}

function approvalBlockedWarnings(dryRun: BookedInDryRun): BookedInDryRunWarningCode[] {
  return dryRun.warnings.filter((warning) => APPROVAL_BLOCKED_WARNING_CODES.has(warning))
}

function approvalBlockedLineSummaries(dryRun: BookedInDryRun): string[] {
  return dryRun.lines
    .map((line) => ({
      asnLineMapId: line.asnLineMapId,
      warnings: line.warnings.filter((warning) => APPROVAL_BLOCKED_WARNING_CODES.has(warning)),
    }))
    .filter((line) => line.warnings.length > 0)
    .map((line) => `${line.asnLineMapId} (${line.warnings.join(', ')})`)
}

function lineWarningDetails(dryRun: BookedInDryRun) {
  return dryRun.lines
    .filter((line) => line.warnings.length > 0)
    .map((line) => ({
      asnLineMapId: line.asnLineMapId,
      externalAsnLineId: line.externalAsnLineId,
      sku: line.sku,
      warnings: line.warnings,
    }))
}

function approvalBlockedErrorMessage(externalAsnId: string, dryRun: BookedInDryRun): string {
  const blockedWarnings = approvalBlockedWarnings(dryRun)
  const blockedLines = approvalBlockedLineSummaries(dryRun)
  const lineDetails = blockedLines.length > 0
    ? ` Affected ASN line maps: ${blockedLines.join('; ')}.`
    : ''

  return `Mintsoft booked-in review for ASN ${externalAsnId} cannot be approved until structural warnings are corrected: ${blockedWarnings.join(', ')}.${lineDetails} Fix the source IMS or Mintsoft data, then retry approval.`
}

function normalizePendingReason(reason: string): string {
  return reason.startsWith(PENDING_ASN_FINALIZATION_REASON_PREFIX)
    ? reason
    : `${PENDING_ASN_FINALIZATION_REASON_PREFIX}${reason}`
}

export function buildNextRetryDelayMs(
  kind: WebhookRetryKind,
  attempts: number,
  random: () => number = Math.random,
): number {
  const baseMs = kind === 'pending' ? PENDING_RETRY_BASE_MS : FAILED_RETRY_BASE_MS
  const capMs = kind === 'pending' ? MAX_PENDING_RETRY_MS : MAX_FAILED_RETRY_MS
  const baseDelay = Math.min(baseMs * (2 ** Math.max(attempts - 1, 0)), capMs)
  const jitter = baseDelay * 0.2 * ((random() - 0.5) * 2)
  return Math.min(capMs, Math.max(baseMs, Math.round(baseDelay + jitter)))
}

export function buildMintsoftWebhookRetryUpdate(
  kind: WebhookRetryKind,
  message: string,
  previousAttempts: number,
  now = new Date(),
  random: () => number = Math.random,
): WebhookRetryUpdate {
  const attempts = previousAttempts + 1
  const maxAttempts = kind === 'pending' ? MAX_PENDING_ATTEMPTS : MAX_FAILED_ATTEMPTS

  if (attempts >= maxAttempts) {
    return {
      processingStatus: WMS_INBOUND_EVENT_PROCESSING_STATUS.dead,
      processingAttempts: attempts,
      nextRetryAt: null,
      deadLetteredAt: now,
      lastError: message,
    }
  }

  return {
    processingStatus: kind === 'pending'
      ? WMS_INBOUND_EVENT_PROCESSING_STATUS.pendingRetry
      : WMS_INBOUND_EVENT_PROCESSING_STATUS.failedRetry,
    processingAttempts: attempts,
    nextRetryAt: new Date(now.getTime() + buildNextRetryDelayMs(kind, attempts, random)),
    deadLetteredAt: null,
    lastError: message,
  }
}

export function buildMintsoftWebhookSweepWhere(now = new Date()) {
  return {
    connector: 'mintsoft',
    processedAt: null,
    OR: [
      { processingStatus: WMS_INBOUND_EVENT_PROCESSING_STATUS.pending },
      {
        processingStatus: {
          in: [
            WMS_INBOUND_EVENT_PROCESSING_STATUS.pendingRetry,
            WMS_INBOUND_EVENT_PROCESSING_STATUS.failedRetry,
          ],
        },
        nextRetryAt: { lte: now },
      },
    ],
  }
}

export function buildMintsoftWebhookReplayForAsnWhere(externalAsnId: string) {
  return {
    connector: 'mintsoft',
    externalAsnId,
    processedAt: null,
  }
}

async function scheduleWebhookRetry(
  eventId: string,
  kind: WebhookRetryKind,
  message: string,
): Promise<void> {
  const event = await db.wmsInboundReceiptEvent.findUnique({
    where: { id: eventId },
    select: {
      processingAttempts: true,
    },
  })

  await db.wmsInboundReceiptEvent.update({
    where: { id: eventId },
    data: buildMintsoftWebhookRetryUpdate(kind, message, event?.processingAttempts ?? 0),
  })
}

export async function processBookedInEvent(
  eventId: string,
  options: ProcessMintsoftBookedInEventOptions,
): Promise<ProcessMintsoftBookedInResult> {
  const event = await db.wmsInboundReceiptEvent.findUnique({
    where: { id: eventId },
    select: {
      id: true,
      externalAsnId: true,
      processedAt: true,
    },
  })

  if (!event) {
    return {
      status: 'failed',
      eventId,
      externalAsnId: null,
      error: 'Webhook event not found',
    }
  }

  if (event.processedAt) {
    return {
      status: 'duplicate',
      eventId: event.id,
      externalAsnId: event.externalAsnId,
    }
  }

  if (!event.externalAsnId) {
    const error = 'Webhook payload did not include an ASN id'
    await markEventFailed(event.id, error)
    return {
      status: 'failed',
      eventId: event.id,
      externalAsnId: null,
      error,
    }
  }

  try {
    const mappedAsn = await db.wmsAsnMap.findUnique({
      where: {
        connector_externalAsnId: {
          connector: 'mintsoft',
          externalAsnId: event.externalAsnId,
        },
      },
      select: { id: true },
    })
    const remoteAsn = mappedAsn
      ? await options.fetchRemoteAsn(event.externalAsnId)
      : null

    const processed = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM wms_inbound_receipt_events WHERE id = ${event.id} FOR UPDATE`

      const lockedEvent = await tx.wmsInboundReceiptEvent.findUnique({
        where: { id: event.id },
        select: {
          id: true,
          externalAsnId: true,
          processedAt: true,
        },
      })

      if (!lockedEvent) {
        throw new Error('Webhook event disappeared during processing')
      }
      if (lockedEvent.processedAt) {
        return {
          duplicate: true,
          productIds: [] as string[],
        }
      }
      if (!lockedEvent.externalAsnId) {
        throw new Error('Webhook payload did not include an ASN id')
      }

      const asnMap = await tx.wmsAsnMap.findUnique({
        where: {
          connector_externalAsnId: {
            connector: 'mintsoft',
            externalAsnId: lockedEvent.externalAsnId,
          },
        },
        select: {
          id: true,
          externalAsnId: true,
          warehouseId: true,
          status: true,
        },
      })

      if (!asnMap) {
        return {
          duplicate: false,
          pending: true,
          pendingReason: normalizePendingReason(`ASN ${lockedEvent.externalAsnId} is not mapped yet; waiting for ASN finalization`),
          productIds: [] as string[],
        }
      }

      if (!remoteAsn) {
        return {
          duplicate: false,
          pending: true,
          pendingReason: `ASN ${lockedEvent.externalAsnId} is not available from Mintsoft yet; retrying booked-in reconciliation`,
          productIds: [] as string[],
        }
      }

      // ─── THE GLOBAL TRANSFER/ASN LOCK ORDER (6oyu.19, Codex round-9 MEDIUM-1) ───
      //
      // This transaction used to begin at step 4 — `wms_asn_line_maps FOR UPDATE`
      // right here — and reach its PARENTS only inside the receipt loops far below
      // (`purchase_orders`, then `stock_transfers`). That is ASN→PARENT, and every
      // other path over the same two rows is PARENT→ASN: the two manual transfer
      // actions and both Mintsoft ASN-creation flows. Two transactions over one
      // transfer in opposite orders is a deadlock, which PostgreSQL breaks by
      // aborting one of them — losing either a manual receipt or a webhook book-in.
      //
      // The crossing became real in round 6, when `receiveTransfer` gained
      // `absorbWmsSnapshotCreditIntoQtyReceived` and stopped being a pure READER of
      // these rows. See lib/domain/wms/transfer-asn-lock-order.ts for the order
      // itself and why it is this one.
      //
      // So: discover the parents from an UNLOCKED read, lock them at their own step,
      // then the ASN header, then the line rows. The discovery read can be stale in
      // one direction only — a line row for a parent it did not see — and
      // `assertParentsWereLocked` below refuses that case from the RE-READ rather
      // than locking a parent out of order to cover it.
      const discoveredLines = await tx.wmsAsnLineMap.findMany({
        where: { asnMapId: asnMap.id },
        select: { id: true, sourceType: true, sourceLineId: true },
      })
      const discoveredTransferLineIds = discoveredLines
        .filter((line) => line.sourceType === 'STOCK_TRANSFER_LINE')
        .map((line) => line.sourceLineId)
      const discoveredPurchaseLineIds = discoveredLines
        .filter((line) => line.sourceType === 'PURCHASE_ORDER_LINE')
        .map((line) => line.sourceLineId)
      const discoveredTransferParents = discoveredTransferLineIds.length === 0
        ? []
        : await tx.stockTransferLine.findMany({
          where: { id: { in: discoveredTransferLineIds } },
          select: { transferId: true },
        })
      const discoveredPurchaseParents = discoveredPurchaseLineIds.length === 0
        ? []
        : await tx.purchaseOrderLine.findMany({
          where: { id: { in: discoveredPurchaseLineIds } },
          select: { poId: true },
        })

      // STEP 2 — the parents. EVERY parent this ASN could reach, not just the ones
      // with actionable quantity: the actionable set is computed from the locked
      // rows, so it is not knowable yet, and locking the wider set is what makes the
      // step-2 lock complete. Also fixes a second, quieter crossing — the receipt
      // loops took these locks in Map insertion (ASN-line) order, so two events over
      // the same two transfers could cross on each other.
      const lockedTransferIds = await lockStockTransfers(
        tx,
        discoveredTransferParents.map((line) => line.transferId),
      )
      const lockedPurchaseOrderIds = await lockPurchaseOrders(
        tx,
        discoveredPurchaseParents.map((line) => line.poId),
      )

      // STEP 3 — the ASN header, which this transaction updates once the lines are
      // done. `finalizePendingAsn` locks the header first and updates line rows
      // after, so taking the header only at the end crossed it the same way one
      // table up.
      await lockWmsAsnMaps(tx, [asnMap.id])

      // STEP 4 — the line rows. Read again AFTER the parent locks: a row committed
      // between the discovery read and here belongs in this set, and the parent
      // assertion below is what decides whether this transaction may act on it.
      const lineIds = await tx.wmsAsnLineMap.findMany({
        where: {
          asnMapId: asnMap.id,
        },
        select: {
          id: true,
        },
      })
      await lockWmsAsnLineMaps(tx, lineIds.map((line) => line.id))

      const asnLines = await tx.wmsAsnLineMap.findMany({
        where: {
          asnMapId: asnMap.id,
        },
        select: {
          id: true,
          externalAsnLineId: true,
          sourceType: true,
          sourceLineId: true,
          productId: true,
          sku: true,
          expectedQty: true,
          qtyAccountedViaSnapshot: true,
          qtyAccountedViaReceipt: true,
          lastProcessedReceivedQty: true,
        },
      })

      const remoteLineByExternalId = new Map(remoteAsn.lines.map((line) => [line.externalLineId, line]))
      const remoteLineBySourceId = new Map(remoteAsn.lines.map((line) => [line.sourceLineId, line]))

      const candidateLines = asnLines
        .map((line) => {
          const remoteLine = remoteLineByExternalId.get(line.externalAsnLineId)
            ?? remoteLineBySourceId.get(line.sourceLineId)
          const currentRemoteReceivedQty = Math.max(0, Number(remoteLine?.quantity ?? 0))
          return {
            ...line,
            currentRemoteReceivedQty,
            currentReceivedQty: Math.min(
              Number(line.expectedQty),
              currentRemoteReceivedQty,
            ),
          }
        })

      const actionableLines = candidateLines
        .filter((line) => line.currentReceivedQty > Number(line.lastProcessedReceivedQty))

      const purchaseActionableLines = actionableLines.filter((line) => line.sourceType === 'PURCHASE_ORDER_LINE')
      const transferActionableLines = actionableLines.filter((line) => line.sourceType === 'STOCK_TRANSFER_LINE')

      const purchaseOrderLines = purchaseActionableLines.length > 0
        ? await tx.purchaseOrderLine.findMany({
            where: {
              id: {
                in: purchaseActionableLines.map((line) => line.sourceLineId),
              },
            },
            select: {
              id: true,
              poId: true,
              productId: true,
              qty: true,
              qtyReceived: true,
              unitCostBase: true,
              landedUnitCostBase: true,
              po: {
                select: {
                  id: true,
                  reference: true,
                  status: true,
                },
              },
            },
          })
        : []

      const transferLines = transferActionableLines.length > 0
        ? await tx.stockTransferLine.findMany({
            where: {
              id: {
                in: transferActionableLines.map((line) => line.sourceLineId),
              },
            },
            select: {
              id: true,
              transferId: true,
              productId: true,
              qty: true,
              qtyReceived: true,
              costLayerSnapshot: true,
            },
          })
        : []

      // The step-2 locks were taken from a read that ran BEFORE them. This is the
      // re-read, and every parent it names must be one of those locks — otherwise
      // this transaction would go on to write a transfer or a PO it does not hold.
      // Locking it now is the one thing that must not happen: it is a step-2 lock
      // taken at step 4, which is the inversion the whole order exists to prevent
      // (6oyu.19, Codex round-9 MEDIUM-1).
      assertParentsWereLocked({
        observedParentIds: transferLines.map((line) => line.transferId),
        lockedParentIds: lockedTransferIds,
        parentTable: 'stock_transfers',
        context: `booked-in reconciliation for ASN ${lockedEvent.externalAsnId}`,
      })
      assertParentsWereLocked({
        observedParentIds: purchaseOrderLines.map((line) => line.poId),
        lockedParentIds: lockedPurchaseOrderIds,
        parentTable: 'purchase_orders',
        context: `booked-in reconciliation for ASN ${lockedEvent.externalAsnId}`,
      })

      const purchaseLineById = new Map(purchaseOrderLines.map((line) => [line.id, line]))
      const transferLineById = new Map(transferLines.map((line) => [line.id, line]))
      const now = new Date()
      // Keep buildBookedInDryRun pure and I/O-free: this transaction holds row locks while
      // deriving review state, so any remote/database reads must happen before this point.
      const dryRun = buildBookedInDryRun({
        externalAsnId: lockedEvent.externalAsnId,
        generatedAt: now,
        lines: candidateLines.map((line) => {
          const purchaseLine = line.sourceType === 'PURCHASE_ORDER_LINE'
            ? purchaseLineById.get(line.sourceLineId)
            : null
          const transferLine = line.sourceType === 'STOCK_TRANSFER_LINE'
            ? transferLineById.get(line.sourceLineId)
            : null
          return {
            asnLineMapId: line.id,
            externalAsnLineId: line.externalAsnLineId,
            sourceType: line.sourceType,
            sourceLineId: line.sourceLineId,
            productId: line.productId,
            sku: line.sku,
            expectedQty: Number(line.expectedQty),
            currentRemoteReceivedQty: line.currentRemoteReceivedQty,
            localReceivedQty: Number(purchaseLine?.qtyReceived ?? transferLine?.qtyReceived ?? 0),
            qtyAccountedViaSnapshot: Number(line.qtyAccountedViaSnapshot),
            qtyAccountedViaReceipt: Number(line.qtyAccountedViaReceipt),
            lastProcessedReceivedQty: Number(line.lastProcessedReceivedQty),
            localLineExists: line.sourceType === 'PURCHASE_ORDER_LINE'
              ? Boolean(purchaseLine)
              : line.sourceType === 'STOCK_TRANSFER_LINE'
                ? Boolean(transferLine)
                : undefined,
            costLayerSnapshot: transferLine?.costLayerSnapshot,
          }
        }),
      })

      if (dryRun.warnings.length > 0 && !options.approveReview) {
        await tx.wmsInboundReceiptEvent.update({
          where: { id: lockedEvent.id },
          data: {
            processingStatus: WMS_INBOUND_EVENT_PROCESSING_STATUS.requiresReview,
            nextRetryAt: null,
            deadLetteredAt: null,
            lastError: reviewErrorMessage(dryRun),
            reviewDetails: dryRun,
            reviewedAt: null,
            reviewedBy: null,
          },
        })
        return {
          duplicate: false,
          pending: false,
          reviewRequired: true,
          dryRun,
          productIds: [] as string[],
        }
      }

      const blockedWarnings = approvalBlockedWarnings(dryRun)
      if (options.approveReview && blockedWarnings.length > 0) {
        const message = approvalBlockedErrorMessage(lockedEvent.externalAsnId, dryRun)
        await tx.wmsInboundReceiptEvent.update({
          where: { id: lockedEvent.id },
          data: {
            processingStatus: WMS_INBOUND_EVENT_PROCESSING_STATUS.requiresReview,
            nextRetryAt: null,
            deadLetteredAt: null,
            lastError: message,
            reviewDetails: dryRun,
            reviewedAt: null,
            reviewedBy: null,
          },
        })
        return {
          duplicate: false,
          pending: false,
          reviewRequired: true,
          dryRun,
          productIds: [] as string[],
        }
      }

      const receiptLinesByPoId = new Map<string, Array<{
        asnLineMapId: string
        poLineId: string
        productId: string
        sku: string
        expectedQty: number
        qtyAccountedViaSnapshot: number
        qtyAccountedViaReceipt: number
        currentReceivedQty: number
        lastProcessedReceivedQty: number
      }>>()
      const receiptLinesByTransferId = new Map<string, Array<{
        asnLineMapId: string
        transferLineId: string
        productId: string
        sku: string
        expectedQty: number
        qtyAccountedViaSnapshot: number
        qtyAccountedViaReceipt: number
        currentReceivedQty: number
        lastProcessedReceivedQty: number
      }>>()

      for (const line of actionableLines) {
        if (line.sourceType === 'PURCHASE_ORDER_LINE') {
          const poLine = purchaseLineById.get(line.sourceLineId)
          if (!poLine) {
            throw new Error(`Missing purchase order line ${line.sourceLineId} for ASN ${lockedEvent.externalAsnId}`)
          }

          const entry = receiptLinesByPoId.get(poLine.poId) ?? []
          entry.push({
            asnLineMapId: line.id,
            poLineId: poLine.id,
            productId: poLine.productId,
            sku: line.sku,
            expectedQty: Number(line.expectedQty),
            qtyAccountedViaSnapshot: Number(line.qtyAccountedViaSnapshot),
            qtyAccountedViaReceipt: Number(line.qtyAccountedViaReceipt),
            currentReceivedQty: line.currentReceivedQty,
            lastProcessedReceivedQty: Number(line.lastProcessedReceivedQty),
          })
          receiptLinesByPoId.set(poLine.poId, entry)
          continue
        }

        const transferLine = transferLineById.get(line.sourceLineId)
        if (!transferLine) {
          throw new Error(`Missing transfer line ${line.sourceLineId} for ASN ${lockedEvent.externalAsnId}`)
        }

        const entry = receiptLinesByTransferId.get(transferLine.transferId) ?? []
        entry.push({
          asnLineMapId: line.id,
          transferLineId: transferLine.id,
          productId: transferLine.productId,
          sku: line.sku,
          expectedQty: Number(line.expectedQty),
          qtyAccountedViaSnapshot: Number(line.qtyAccountedViaSnapshot),
          qtyAccountedViaReceipt: Number(line.qtyAccountedViaReceipt),
          currentReceivedQty: line.currentReceivedQty,
          lastProcessedReceivedQty: Number(line.lastProcessedReceivedQty),
        })
        receiptLinesByTransferId.set(transferLine.transferId, entry)
      }

      const touchedProductIds = new Set<string>()
      // q66in.4.6 audit timeline: per-line before/after images of what this
      // webhook actually changed, emitted as ONE mutation event after commit.
      const auditReceiptLines: Array<Record<string, unknown>> = []

      for (const [poId, receiptLines] of receiptLinesByPoId) {
        // Already held since step 2 (lockPurchaseOrders, above) — taking it here was
        // the out-of-order acquisition, because by now this transaction holds the ASN
        // line rows. Re-locking a row the transaction already holds is a no-op in
        // PostgreSQL, so the statement is gone rather than moved: leaving it would
        // read as though this were where the PO lock is taken (6oyu.19 Codex r9).
        assertParentIsLocked(poId, lockedPurchaseOrderIds, 'purchase_orders')

        const po = await tx.purchaseOrder.findUnique({
          where: { id: poId },
          select: {
            id: true,
            reference: true,
            status: true,
            destinationWarehouseId: true,
            lines: {
              select: {
                id: true,
                productId: true,
                qty: true,
                qtyReceived: true,
                unitCostBase: true,
                landedUnitCostBase: true,
              },
            },
          },
        })

        if (!po) {
          throw new Error(`Purchase order ${poId} not found for ASN ${lockedEvent.externalAsnId}`)
        }

        const lockedLineById = new Map(po.lines.map((line) => [line.id, line]))
        const reconciledLines = receiptLines.map((receiptLine) => {
          const poLine = lockedLineById.get(receiptLine.poLineId)
          if (!poLine) {
            throw new Error(`Purchase order line ${receiptLine.poLineId} not found on locked PO ${po.reference}`)
          }

          const reconciled = reconcileBookedInQuantities({
            expectedQty: receiptLine.expectedQty,
            currentReceivedQty: receiptLine.currentReceivedQty,
            localReceivedQty: Number(poLine.qtyReceived),
            lastProcessedReceivedQty: receiptLine.lastProcessedReceivedQty,
            qtyAccountedViaSnapshot: receiptLine.qtyAccountedViaSnapshot,
            qtyAccountedViaReceipt: receiptLine.qtyAccountedViaReceipt,
          })

          return {
            ...receiptLine,
            qtyReceived: reconciled.qtyReceived,
            reconciledManualQty: reconciled.reconciledManualQty,
            coveredBySnapshotQty: reconciled.coveredBySnapshotQty,
            stockQtyToAdd: reconciled.stockQtyToAdd,
            newlyProcessedQty: reconciled.newlyProcessedQty,
          }
        }).filter((receiptLine) => receiptLine.qtyReceived > 0 || receiptLine.reconciledManualQty > 0)

        const createdReceiptLines = reconciledLines.filter((receiptLine) => receiptLine.qtyReceived > 0)
        // audit-H7: the WMS books into the ASN-mapped warehouse, which can differ
        // from the PO destination. There's no operator to confirm on this
        // automated path, so record a WARNING (not a block) for reconciliation.
        if (createdReceiptLines.length > 0 && po.destinationWarehouseId && asnMap.warehouseId !== po.destinationWarehouseId) {
          await logActivity({
            entityType: 'PURCHASE_ORDER',
            entityId: poId,
            action: 'received_warehouse_divergence',
            tag: 'purchase',
            level: 'WARNING',
            description: `Mintsoft ASN ${lockedEvent.externalAsnId} booked ${createdReceiptLines.length} line(s) of PO ${po.reference} into a warehouse other than the PO destination.`,
            metadata: {
              reference: po.reference,
              externalAsnId: lockedEvent.externalAsnId,
              receivedWarehouseId: asnMap.warehouseId,
              destinationWarehouseId: po.destinationWarehouseId,
              lineCount: createdReceiptLines.length,
            },
          })
        }
        if (createdReceiptLines.length > 0) {
          await tx.purchaseReceipt.create({
            data: {
              poId,
              reference: formatReceiptReference(lockedEvent.externalAsnId, po.reference),
              externalKey: `mintsoft:po:${poId}:event:${lockedEvent.id}`,
              notes: `Mintsoft ASN booked-in webhook ${lockedEvent.externalAsnId}`,
              lines: {
                create: createdReceiptLines.map((receiptLine) => ({
                  poLineId: receiptLine.poLineId,
                  qtyReceived: receiptLine.qtyReceived,
                  coveredBySnapshotQty: receiptLine.coveredBySnapshotQty,
                  warehouseId: asnMap.warehouseId,
                })),
              },
            },
          })
        }

        for (const receiptLine of reconciledLines) {
          const poLine = lockedLineById.get(receiptLine.poLineId)
          if (!poLine) continue

          if (receiptLine.qtyReceived > 0) {
            const unitCostBase = Number(poLine.landedUnitCostBase ?? poLine.unitCostBase)
            if (receiptLine.stockQtyToAdd > 0) {
              try {
                // The catch below keeps using `tx`, so the failing insert must not poison it
                // (o3d-slrn). Without the savepoint the P2002 aborts the transaction and the
                // `continue` runs straight into a 25P02.
                await withSavepoint(tx, () => tx.stockMovement.create({
                  data: {
                    type: 'PURCHASE_RECEIPT',
                    productId: poLine.productId,
                    toWarehouseId: asnMap.warehouseId,
                    qty: receiptLine.stockQtyToAdd,
                    ...buildStockMovementValueFields({ qty: receiptLine.stockQtyToAdd, unitCostBase }),
                    note: `Received against ${po.reference} via Mintsoft webhook ${lockedEvent.externalAsnId}`,
                    referenceType: 'WmsAsnMap',
                    referenceId: asnMap.id,
                    idempotencyKey: wmsPurchaseReceiptMovementKey({
                      asnLineMapId: receiptLine.asnLineMapId,
                      receiptEventId: lockedEvent.id,
                    }),
                  },
                }))
              } catch (error) {
                if (!isStockMovementIdempotencyConflict(error)) throw error
                continue
              }

              await tx.costLayer.create({
                data: {
                  productId: poLine.productId,
                  warehouseId: asnMap.warehouseId,
                  receivedQty: receiptLine.stockQtyToAdd,
                  remainingQty: receiptLine.stockQtyToAdd,
                  unitCostBase,
                  poLineId: poLine.id,
                  isOpeningStock: false,
                },
              })

              await tx.stockLevel.upsert({
                where: {
                  productId_warehouseId: {
                    productId: poLine.productId,
                    warehouseId: asnMap.warehouseId,
                  },
                },
                create: {
                  productId: poLine.productId,
                  warehouseId: asnMap.warehouseId,
                  quantity: receiptLine.stockQtyToAdd,
                  reservedQty: 0,
                },
                update: {
                  quantity: { increment: receiptLine.stockQtyToAdd },
                },
              })
            }

            if (receiptLine.coveredBySnapshotQty > 0) {
              // Zero-qty movements are audit markers for quantities already
              // accounted by a prior snapshot; reports counting physical stock
              // movement should filter to qty > 0.
              await tx.stockMovement.create({
                data: {
                  type: 'WMS_RECEIPT_RECONCILIATION',
                  productId: poLine.productId,
                  toWarehouseId: asnMap.warehouseId,
                  qty: 0,
                  ...buildStockMovementValueFields({ qty: 0, unitCostBase: 0 }),
                  note: `Mintsoft snapshot already accounted for ${receiptLine.coveredBySnapshotQty} on ${po.reference}`,
                  referenceType: 'WmsAsnLineMap',
                  referenceId: receiptLine.asnLineMapId,
                },
              })
            }

            await tx.purchaseOrderLine.update({
              where: { id: poLine.id },
              data: {
                qtyReceived: { increment: receiptLine.qtyReceived },
              },
            })

            touchedProductIds.add(poLine.productId)
            auditReceiptLines.push({
              target: 'PURCHASE_ORDER',
              reference: po.reference,
              sku: receiptLine.sku,
              productId: poLine.productId,
              warehouseId: asnMap.warehouseId,
              qtyReceivedBefore: Number(poLine.qtyReceived),
              qtyReceivedAfter: Number(poLine.qtyReceived) + receiptLine.qtyReceived,
              stockQtyAdded: receiptLine.stockQtyToAdd,
              coveredBySnapshotQty: receiptLine.coveredBySnapshotQty,
            })
          }

          await tx.wmsAsnLineMap.update({
            where: { id: receiptLine.asnLineMapId },
            data: {
              qtyAccountedViaReceipt: { increment: receiptLine.newlyProcessedQty },
              lastProcessedReceivedQty: { increment: receiptLine.newlyProcessedQty },
              lastCallbackAt: now,
            },
          })
        }

        const updatedLines = await tx.purchaseOrderLine.findMany({
          where: { poId },
          select: {
            qty: true,
            qtyReceived: true,
          },
        })
        const allReceived = updatedLines.every((line) => Number(line.qtyReceived) >= Number(line.qty))
        await tx.purchaseOrder.update({
          where: { id: poId },
          data: {
            status: allReceived ? 'RECEIVED' : 'PARTIALLY_RECEIVED',
            ...(allReceived ? { receivedAt: now } : {}),
          },
        })
      }

      for (const [transferId, receiptLines] of receiptLinesByTransferId) {
        // Already held since step 2 (lockStockTransfers, above). This was the second
        // half of the cycle against `receiveTransfer`: by the time control reached
        // here the transaction held `wms_asn_line_maps`, so acquiring the transfer
        // row now is ASN→TRANSFER (6oyu.19 Codex r9).
        assertParentIsLocked(transferId, lockedTransferIds, 'stock_transfers')

        const transfer = await tx.stockTransfer.findUnique({
          where: { id: transferId },
          select: {
            id: true,
            reference: true,
            status: true,
            toWarehouseId: true,
            completedAt: true,
            lines: {
              select: {
                id: true,
                productId: true,
                qty: true,
                qtyReceived: true,
                costLayerSnapshot: true,
              },
            },
          },
        })

        if (!transfer) {
          throw new Error(`Transfer ${transferId} not found for ASN ${lockedEvent.externalAsnId}`)
        }

        // 6oyu.19 (Codex round-7 HIGH-1): the same predicate the stock-sync
        // alignment path now uses, so the two ways an ASN brings units into stock
        // agree about which parent statuses make an ASN usable.
        if (!isTransferUsableForWmsReceipt(transfer.status)) {
          throw new Error(`Transfer ${transfer.reference} is not in transit for ASN ${lockedEvent.externalAsnId}`)
        }

        const lockedLineById = new Map(transfer.lines.map((line) => [line.id, line]))
        // 6oyu.19 (Codex r6): the snapshot offset used to be a local
        // `max(qtyReceived, qtyAccountedViaSnapshot)` computed here. Same intent,
        // but it was one of four different formulas for the same question across the
        // four paths that rebuild layers from a dispatch snapshot. It now comes from
        // the one definition, which also gets a line spanning SEVERAL ASNs right —
        // the local max silently under-counted that.
        const landedByLineId = await loadTransferLineLandedQty(tx, transfer.lines)
        const reconciledLines = receiptLines.map((receiptLine) => {
          const transferLine = lockedLineById.get(receiptLine.transferLineId)
          if (!transferLine) {
            throw new Error(`Transfer line ${receiptLine.transferLineId} not found on locked transfer ${transfer.reference}`)
          }

          const reconciled = reconcileBookedInQuantities({
            expectedQty: receiptLine.expectedQty,
            currentReceivedQty: receiptLine.currentReceivedQty,
            localReceivedQty: Number(transferLine.qtyReceived),
            lastProcessedReceivedQty: receiptLine.lastProcessedReceivedQty,
            qtyAccountedViaSnapshot: receiptLine.qtyAccountedViaSnapshot,
            qtyAccountedViaReceipt: receiptLine.qtyAccountedViaReceipt,
          })

          return {
            ...receiptLine,
            qtyReceived: reconciled.qtyReceived,
            reconciledManualQty: reconciled.reconciledManualQty,
            coveredBySnapshotQty: reconciled.coveredBySnapshotQty,
            stockQtyToAdd: reconciled.stockQtyToAdd,
            newlyProcessedQty: reconciled.newlyProcessedQty,
            alreadyLanded: requireLandedQty(landedByLineId, transferLine.id),
          }
        }).filter((receiptLine) => receiptLine.qtyReceived > 0 || receiptLine.reconciledManualQty > 0)

        for (const receiptLine of reconciledLines) {
          const transferLine = lockedLineById.get(receiptLine.transferLineId)
          if (!transferLine) continue

          if (receiptLine.qtyReceived > 0) {
            if (receiptLine.stockQtyToAdd > 0) {
              const snapshotSlice = sliceTransferSnapshotForReceipt({
                snapshot: transferLine.costLayerSnapshot,
                alreadyLanded: receiptLine.alreadyLanded,
                qtyReceived: receiptLine.stockQtyToAdd,
              })
              const totalValueBase = snapshotSlice.reduce(
                (sum, entry) => addMoney(sum, multiplyMoney(entry.qty, entry.unitCostBase)),
                toDecimal(0),
              )
              try {
                // The catch below keeps using `tx`, so the failing insert must not poison it
                // (o3d-slrn). Without the savepoint the P2002 aborts the transaction and the
                // `continue` runs straight into a 25P02.
                await withSavepoint(tx, () => tx.stockMovement.create({
                  data: {
                    type: 'TRANSFER_IN',
                    productId: transferLine.productId,
                    fromWarehouseId: null,
                    toWarehouseId: transfer.toWarehouseId,
                    qty: receiptLine.stockQtyToAdd,
                    ...buildStockMovementValueFieldsFromTotal({ qty: receiptLine.stockQtyToAdd, totalValueBase }),
                    note: `Received against ${transfer.reference} via Mintsoft webhook ${lockedEvent.externalAsnId}`,
                    referenceType: 'WmsAsnMap',
                    referenceId: asnMap.id,
                    idempotencyKey: wmsTransferInMovementKey({
                      asnLineMapId: receiptLine.asnLineMapId,
                      receiptEventId: lockedEvent.id,
                    }),
                  },
                }))
              } catch (error) {
                if (!isStockMovementIdempotencyConflict(error)) throw error
                continue
              }

              await tx.stockLevel.upsert({
                where: {
                  productId_warehouseId: {
                    productId: transferLine.productId,
                    warehouseId: transfer.toWarehouseId,
                  },
                },
                create: {
                  productId: transferLine.productId,
                  warehouseId: transfer.toWarehouseId,
                  quantity: receiptLine.stockQtyToAdd,
                  reservedQty: 0,
                },
                update: {
                  quantity: { increment: receiptLine.stockQtyToAdd },
                },
              })

              // 6oyu.19: this loop used to create the destination layer and call
              // copyCostLayerSourceLinesProportionally IGNORING its result, which is
              // 0 for an ordinary PO-derived source layer (it has no sourceLines of
              // its own). The layer was therefore left with no costLayerSourceLine,
              // so the revaluation exclusion removed these units from COGS while
              // propagation had nowhere to carry the delta. The shared helper makes
              // the link a postcondition, and the quantity too — this path increments
              // stock immediately above and has no balancing layer, so an entry the
              // helper declined would leave the booked-in units unlayered (Codex
              // round-4 HIGH).
              //
              // It REFUSES a snapshot entry whose unit cost is negative (Codex
              // round-5 HIGH, o3d-gd2f), creating nothing and aborting this
              // transaction rather than let the stock increment above commit alone.
              // Do NOT wrap this call in a try or a savepoint.
              //
              // It settles NO deferred transit reclass (Codex round-4 LOW). A
              // landed-cost revaluation that landed while these units were in transit
              // was never persisted as an obligation, so creating the layer does not
              // discharge it; the delta remains in the transit clearing account.
              // Open, tracked as o3d-nrl4.
              //
              // `bookedQty` is `stockQtyToAdd`, the increment made immediately
              // above, and the helper's coverage postcondition is measured against
              // IT rather than against the slice (Codex round-8 HIGH-1). The two
              // differ whenever the dispatch snapshot has fewer unconsumed costed
              // units than the WMS has booked in, and this path has no balancing
              // step of its own, so the difference used to go on hand unlayered.
              // BALANCE_AT_ZERO_COST rather than REFUSE because the goods are
              // physically in the warehouse — refusing would fail a real receipt
              // that Mintsoft has already completed — and because the movement
              // written above already values them at the slice's total, i.e. it has
              // already priced the shortfall at zero.
              await recreateTransferCostLayersFromSnapshotSlice(
                tx,
                {
                  productId: transferLine.productId,
                  warehouseId: transfer.toWarehouseId,
                  transferLineId: transferLine.id,
                  contextLabel: `transfer ${transfer.reference} WMS receipt`,
                  bookedQty: receiptLine.stockQtyToAdd,
                  uncostedShortfall: 'BALANCE_AT_ZERO_COST',
                },
                snapshotSlice,
              )
            }

            if (receiptLine.coveredBySnapshotQty > 0) {
              // Zero-qty movements are audit markers for quantities already
              // accounted by a prior snapshot; reports counting physical stock
              // movement should filter to qty > 0.
              await tx.stockMovement.create({
                data: {
                  type: 'WMS_RECEIPT_RECONCILIATION',
                  productId: transferLine.productId,
                  toWarehouseId: transfer.toWarehouseId,
                  qty: 0,
                  ...buildStockMovementValueFields({ qty: 0, unitCostBase: 0 }),
                  note: `Mintsoft snapshot already accounted for ${receiptLine.coveredBySnapshotQty} on ${transfer.reference}`,
                  referenceType: 'WmsAsnLineMap',
                  referenceId: receiptLine.asnLineMapId,
                },
              })
            }

            await tx.stockTransferLine.update({
              where: { id: transferLine.id },
              data: {
                qtyReceived: { increment: receiptLine.qtyReceived },
              },
            })

            touchedProductIds.add(transferLine.productId)
            auditReceiptLines.push({
              target: 'STOCK_TRANSFER',
              reference: transfer.reference,
              sku: receiptLine.sku,
              productId: transferLine.productId,
              warehouseId: transfer.toWarehouseId,
              qtyReceivedBefore: Number(transferLine.qtyReceived),
              qtyReceivedAfter: Number(transferLine.qtyReceived) + receiptLine.qtyReceived,
              stockQtyAdded: receiptLine.stockQtyToAdd,
              coveredBySnapshotQty: receiptLine.coveredBySnapshotQty,
            })
          }

          await tx.wmsAsnLineMap.update({
            where: { id: receiptLine.asnLineMapId },
            data: {
              qtyAccountedViaReceipt: { increment: receiptLine.newlyProcessedQty },
              lastProcessedReceivedQty: { increment: receiptLine.newlyProcessedQty },
              lastCallbackAt: now,
            },
          })
        }

        const updatedLines = await tx.stockTransferLine.findMany({
          where: { transferId },
          select: {
            id: true,
            qty: true,
            qtyReceived: true,
          },
        })
        // Completion is a LANDED-quantity question (6oyu.19 Codex r6): a line the
        // stock-sync alignment brought in has a qtyReceived of zero and is fully
        // accounted for all the same.
        const updatedLanded = await loadTransferLineLandedQty(tx, updatedLines)
        const allReceived = updatedLines.every((line) => isTransferLineFullyLanded(line.qty, requireLandedQty(updatedLanded, line.id)))
        if (allReceived) {
          await tx.stockTransfer.update({
            where: { id: transferId },
            data: {
              status: 'RECEIVED',
              completedAt: transfer.completedAt ?? now,
            },
          })
        }
      }

      const refreshedLines = await tx.wmsAsnLineMap.findMany({
        where: { asnMapId: asnMap.id },
        select: {
          expectedQty: true,
          lastProcessedReceivedQty: true,
        },
      })
      const asnClosed = refreshedLines.every((line) => Number(line.lastProcessedReceivedQty) >= Number(line.expectedQty))
      const asnStatusAfter = asnClosed ? 'BOOKED_IN' : 'PARTIALLY_BOOKED_IN'

      await tx.wmsAsnMap.update({
        where: { id: asnMap.id },
        data: {
          status: asnClosed ? 'BOOKED_IN' : 'PARTIALLY_BOOKED_IN',
          lastCallbackAt: now,
          sloAlertedAt: null,
          ...(asnClosed ? { closedAt: now } : {}),
        },
      })

      if (actionableLines.length === 0) {
        await tx.wmsAsnLineMap.updateMany({
          where: { asnMapId: asnMap.id },
          data: { lastCallbackAt: now },
        })
      }

      await tx.wmsInboundReceiptEvent.update({
        where: { id: lockedEvent.id },
        data: {
          processedAt: now,
          processingStatus: WMS_INBOUND_EVENT_PROCESSING_STATUS.processed,
          nextRetryAt: null,
          deadLetteredAt: null,
          lastError: null,
        },
      })

      return {
        duplicate: false,
        pending: false,
        productIds: Array.from(touchedProductIds),
        auditLines: auditReceiptLines,
        asnMapId: asnMap.id,
        asnStatusBefore: asnMap.status as string,
        asnStatusAfter,
      }
    }, STOCK_TX_OPTIONS)

    if (processed.duplicate) {
      return {
        status: 'duplicate',
        eventId: event.id,
        externalAsnId: event.externalAsnId,
      }
    }

    if (processed.reviewRequired) {
      await logActivity({
        entityType: 'SYNC',
        entityId: event.id,
        tag: 'sync',
        action: 'mintsoft_booked_in_review_required',
        level: 'WARNING',
        description: `Mintsoft ASN booked-in webhook ${event.externalAsnId} requires manual review`,
        metadata: {
          externalAsnId: event.externalAsnId,
          warnings: processed.dryRun.warnings,
          lineWarnings: lineWarningDetails(processed.dryRun),
        },
        resolveUser: false,
      })
      return {
        status: 'requires_review',
        eventId: event.id,
        externalAsnId: event.externalAsnId,
        dryRun: processed.dryRun,
      }
    }

    if (processed.pending) {
      const pendingReason = normalizePendingReason(processed.pendingReason ?? `ASN ${event.externalAsnId ?? 'unknown'} is not mapped yet`)
      await markEventPending(event.id, pendingReason)
      return {
        status: 'pending',
        eventId: event.id,
        externalAsnId: event.externalAsnId,
        reason: pendingReason,
      }
    }

    if (processed.productIds.length > 0) {
      try {
        await enqueueStockSync(processed.productIds, 'IMS_CHANGE')
      } catch (error) {
        console.error(error)
      }
    }

    await logActivity({
      entityType: 'SYNC',
      entityId: event.id,
      tag: 'sync',
      action: 'mintsoft_booked_in_processed',
      description: `Processed Mintsoft ASN booked-in webhook ${event.externalAsnId}`,
      metadata: {
        externalAsnId: event.externalAsnId,
        productCount: processed.productIds.length,
      },
      resolveUser: false,
    })
    if ('auditLines' in processed && processed.auditLines) {
      await recordWmsMutationEvent({
        connector: 'mintsoft', direction: 'INBOUND', action: 'booked_in_receipt', outcome: 'SUCCEEDED',
        // Keyed to the ASN map (Codex r2: the webhook event id under
        // entityType ASN broke timeline lookups by ASN id).
        entityType: 'ASN', entityId: processed.asnMapId, externalId: event.externalAsnId,
        summary: `Booked-in webhook applied for ASN ${event.externalAsnId} — ${processed.auditLines.length} line(s) received`,
        before: { asnStatus: processed.asnStatusBefore },
        after: { asnStatus: processed.asnStatusAfter, lines: processed.auditLines, webhookEventId: event.id },
        triggeredBy: 'webhook',
      })
    }

    return {
      status: 'processed',
      eventId: event.id,
      externalAsnId: event.externalAsnId,
      productIds: processed.productIds,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Mintsoft booked-in processing failed'
    await markEventFailed(event.id, message)
    await logActivity({
      entityType: 'SYNC',
      entityId: event.id,
      tag: 'sync',
      action: 'mintsoft_booked_in_failed',
      level: 'ERROR',
      description: `Mintsoft ASN booked-in processing failed: ${message}`,
      metadata: {
        externalAsnId: event.externalAsnId,
      },
      resolveUser: false,
    })
    await recordWmsMutationEvent({
      connector: 'mintsoft', direction: 'INBOUND', action: 'booked_in_receipt', outcome: 'FAILED',
      // The ASN map may not be resolvable on failure — key by external ASN id
      // only and carry the webhook event id in the payload (Codex r2).
      entityType: 'ASN', entityId: null, externalId: event.externalAsnId,
      summary: `Booked-in webhook processing failed for ASN ${event.externalAsnId}`,
      after: { webhookEventId: event.id },
      error: message,
      triggeredBy: 'webhook',
    })
    return {
      status: 'failed',
      eventId: event.id,
      externalAsnId: event.externalAsnId,
      error: message,
    }
  }
}
