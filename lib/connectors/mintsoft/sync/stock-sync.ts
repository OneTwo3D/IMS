import { randomUUID } from 'crypto'
import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { recordWmsMutationEvent } from '@/lib/domain/wms/mutation-audit'
import { classifyUnresolvedWmsSku } from '@/lib/domain/wms/stock-sync-helpers'
import { createCostLayer } from '@/lib/cost-layers'
import { recreateTransferCostLayersFromSnapshotSlice } from '@/lib/domain/inventory/transfer-cost-layer-recreation'
import { notify } from '@/lib/notifications'
import { getWmsConnector } from '@/lib/connectors/wms/registry'
import {
  collectMissingInWmsCandidates,
  consolidateMintsoftStockLines,
  hasMintsoftThresholdBreach,
  planMintsoftAlignDown,
  planMintsoftAlignmentAllocations,
  parseMintsoftThresholds,
} from './stock-sync-helpers'
import { applyStockAdjustment } from '@/lib/domain/inventory/stock-adjustment-apply'
import {
  isTransferUsableForWmsReceipt,
  remainingCostableSnapshotQty,
  sliceTransferSnapshotForReceipt,
  WMS_RECEIPT_QTY_EPSILON,
  WMS_RECEIPT_USABLE_TRANSFER_STATUSES,
} from '@/lib/domain/wms/asn-reconciliation'
import {
  loadTransferLineLandedQty,
  requireLandedQty,
  resolveTransferLineResidualQty,
  resolveWmsAsnLineResidualQty,
  transferLineOutstandingQty,
  type TransferLineResidualQty,
  type WmsAsnLineResidualQty,
} from '@/lib/domain/inventory/transfer-landed-quantity'
import {
  buildStockMovementValueFields,
  buildStockMovementValueFieldsFromTotal,
} from '@/lib/domain/inventory/stock-movement-value'
import { lockStockTransfers, lockWmsAsnLineMaps } from '@/lib/domain/wms/transfer-asn-lock-order'
import { addMoney, multiplyMoney, toDecimal } from '@/lib/domain/math/decimal'
import { enqueueStockSync } from '@/lib/shopping'

/**
 * Codex P2 (6oyu.1): an applied alignment changes IMS on-hand, so the storefront
 * sync must be enqueued like every other stock mutation — otherwise WooCommerce
 * keeps advertising the pre-alignment quantity until an unrelated event syncs it
 * (for align-down that re-opens the oversell window the correction just closed).
 * Best-effort post-commit: a failure is surfaced as a WARNING, never thrown.
 */
async function enqueueAlignmentStockSync(binding: SyncBinding, productId: string, sku: string): Promise<void> {
  try {
    await enqueueStockSync([productId], 'IMS_CHANGE')
  } catch (error) {
    console.error(error)
    try {
      await logActivity({
        entityType: 'SYNC',
        entityId: binding.id,
        tag: 'sync',
        action: 'mintsoft_alignment_stock_sync_enqueue_failed',
        description: `Storefront stock sync enqueue failed after Mintsoft alignment for ${sku}; store stock may be stale until the next sync: ${error instanceof Error ? error.message : String(error)}`,
        level: 'WARNING',
        resolveUser: false,
      })
    } catch (logError) {
      console.error(logError)
    }
  }
}

type SyncBinding = {
  id: string
  connector: string
  active: boolean
  externalWarehouseId: string
  stockSyncMode: 'DISABLED' | 'NOTIFICATION_ONLY' | 'ALIGN_TO_WMS'
  syncFrequencyMinutes: number
  discrepancyThresholds: Prisma.JsonValue | null
  reportRecipients: string[]
  alignmentConfirmedAt: Date | null
  alignDownReasonId: string | null
  warehouseId: string
  lastStockSyncAt: Date | null
  connection: {
    active: boolean
  }
  warehouse: {
    id: string
    code: string
    name: string
  }
}

type SyncSummary = {
  externalWarehouseId: string
  thresholdBreaches: number
  notifiedUsers: number
  dryRun?: boolean
  alignmentCorrections?: number
  alignmentPreviews?: number
}

const STALE_RUNNING_STOCK_SYNC_MS = 3 * 60 * 1000
const STOCK_SYNC_HEARTBEAT_INTERVAL = 30 * 1000

type RunningStockSyncSummary = {
  externalWarehouseId: string
  bindingId: string
  leaseToken: string
  heartbeatAt: string
}

export type MintsoftStockSyncResult = {
  bindingId: string
  warehouseId: string
  warehouseCode: string
  jobId: string | null
  status: 'SKIPPED' | 'SUCCEEDED' | 'PARTIAL' | 'FAILED'
  totalChecked: number
  matched: number
  mismatched: number
  corrected: number
  skipped: number
  errors: number
  notifiedUsers: number
  dryRun?: boolean
  alignmentPreviews?: number
  skippedReason?: string
}

function formatQuantity(value: number): string {
  const rounded = value.toFixed(4)
  return rounded.replace(/\.?0+$/, '')
}

function buildDiscrepancyWhere(binding: SyncBinding, category: string, productId: string | null, sku: string) {
  return {
    connector: 'mintsoft',
    warehouseId: binding.warehouseId,
    category: category as never,
    status: 'OPEN' as const,
    ...(productId ? { productId } : { productId: null, sku }),
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

async function getSyncBinding(bindingId: string): Promise<SyncBinding | null> {
  return db.externalWmsBinding.findFirst({
    where: {
      id: bindingId,
      connector: 'mintsoft',
    },
    select: {
      id: true,
      connector: true,
      active: true,
      externalWarehouseId: true,
      stockSyncMode: true,
      syncFrequencyMinutes: true,
      discrepancyThresholds: true,
      reportRecipients: true,
      alignmentConfirmedAt: true,
      alignDownReasonId: true,
      warehouseId: true,
      lastStockSyncAt: true,
      connection: {
        select: {
          active: true,
        },
      },
      warehouse: {
        select: {
          id: true,
          code: true,
          name: true,
        },
      },
    },
  }) as Promise<SyncBinding | null>
}

type StockSyncReservation =
  | {
    binding: null
    jobId: null
    skippedReason: string
  }
  | {
    binding: SyncBinding
    jobId: string | null
    leaseToken?: string
    skippedReason?: string
  }

function parseRunningHeartbeat(summary: Prisma.JsonValue | null | undefined): Date | null {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return null
  const value = summary.heartbeatAt
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed : null
}

function parseRunningLeaseToken(summary: Prisma.JsonValue | null | undefined): string | null {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return null
  const value = summary.leaseToken
  return typeof value === 'string' && value.trim() ? value : null
}

function buildRunningStockSyncSummary(binding: SyncBinding, leaseToken: string, heartbeatAt: Date): RunningStockSyncSummary {
  return {
    externalWarehouseId: binding.externalWarehouseId,
    bindingId: binding.id,
    leaseToken,
    heartbeatAt: heartbeatAt.toISOString(),
  }
}

async function heartbeatStockSyncJob(jobId: string, binding: SyncBinding, leaseToken: string): Promise<boolean> {
  const heartbeatAt = new Date()
  const updated = await db.wmsSyncJob.updateMany({
    where: {
      id: jobId,
      status: 'RUNNING',
      AND: [
        { summary: { path: ['leaseToken'], equals: leaseToken } },
      ],
    },
    data: {
      summary: buildRunningStockSyncSummary(binding, leaseToken, heartbeatAt) as Prisma.InputJsonValue,
    },
  })

  return updated.count === 1
}

async function reserveStockSyncJob(
  bindingId: string,
  triggeredBy: string,
): Promise<StockSyncReservation> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM external_wms_bindings WHERE id = ${bindingId} FOR UPDATE`

    const binding = await tx.externalWmsBinding.findFirst({
      where: {
        id: bindingId,
        connector: 'mintsoft',
      },
      select: {
        id: true,
        connector: true,
        active: true,
        externalWarehouseId: true,
        stockSyncMode: true,
        syncFrequencyMinutes: true,
        discrepancyThresholds: true,
        reportRecipients: true,
        alignmentConfirmedAt: true,
        alignDownReasonId: true,
        warehouseId: true,
        lastStockSyncAt: true,
        connection: {
          select: {
            active: true,
          },
        },
        warehouse: {
          select: {
            id: true,
            code: true,
            name: true,
          },
        },
      },
    }) as SyncBinding | null

    if (!binding) {
      return {
        binding: null,
        jobId: null,
        skippedReason: 'Binding not found',
      } satisfies StockSyncReservation
    }

    if (!binding.active || !binding.connection.active || binding.stockSyncMode === 'DISABLED') {
      return {
        binding,
        jobId: null,
        skippedReason: !binding.active
          ? 'Binding inactive'
          : !binding.connection.active
            ? 'Connection inactive'
            : 'Stock sync disabled',
      } satisfies StockSyncReservation
    }

    const runningJob = await tx.wmsSyncJob.findFirst({
      where: {
        connector: 'mintsoft',
        type: 'STOCK_SYNC',
        warehouseId: binding.warehouseId,
        status: 'RUNNING',
      },
      select: {
        id: true,
        startedAt: true,
        summary: true,
      },
      orderBy: { startedAt: 'desc' },
    })

    if (runningJob) {
      const observedHeartbeatAt = parseRunningHeartbeat(runningJob.summary)
      const lastHeartbeatAt = observedHeartbeatAt ?? runningJob.startedAt
      const observedLeaseToken = parseRunningLeaseToken(runningJob.summary)
      const staleBefore = new Date(Date.now() - STALE_RUNNING_STOCK_SYNC_MS)
      if (lastHeartbeatAt < staleBefore) {
        if (!observedLeaseToken || !observedHeartbeatAt) {
          return {
            binding,
            jobId: runningJob.id,
            skippedReason: 'Stock sync already running for this binding; legacy lease metadata prevents safe reclaim',
          } satisfies StockSyncReservation
        }

        const fenceAnd: Prisma.WmsSyncJobWhereInput[] = []
        fenceAnd.push({ summary: { path: ['leaseToken'], equals: observedLeaseToken } })
        fenceAnd.push({ summary: { path: ['heartbeatAt'], equals: observedHeartbeatAt.toISOString() } })
        const reclaimed = await tx.wmsSyncJob.updateMany({
          where: {
            id: runningJob.id,
            status: 'RUNNING',
            AND: fenceAnd,
          },
          data: {
            status: 'FAILED',
            finishedAt: new Date(),
            errors: 1,
            summary: {
              externalWarehouseId: binding.externalWarehouseId,
              bindingId: binding.id,
              staleRecoveredAt: new Date().toISOString(),
              staleStartedAt: runningJob.startedAt.toISOString(),
              staleHeartbeatAt: lastHeartbeatAt.toISOString(),
              staleLeaseToken: observedLeaseToken,
            } satisfies Prisma.InputJsonObject,
          },
        })

        if (reclaimed.count === 0) {
          return {
            binding,
            jobId: runningJob.id,
            skippedReason: 'Stock sync already running for this binding',
          } satisfies StockSyncReservation
        }
      } else {
        return {
          binding,
          jobId: runningJob.id,
          skippedReason: 'Stock sync already running for this binding',
        } satisfies StockSyncReservation
      }
    }

    const leaseToken = randomUUID()
    const heartbeatAt = new Date()
    const job = await tx.wmsSyncJob.create({
      data: {
        connector: 'mintsoft',
        type: 'STOCK_SYNC',
        status: 'RUNNING',
        warehouseId: binding.warehouseId,
        startedAt: heartbeatAt,
        triggeredBy,
        summary: buildRunningStockSyncSummary(binding, leaseToken, heartbeatAt) as Prisma.InputJsonValue,
      },
      select: { id: true },
    })

    return {
      binding,
      jobId: job.id,
      leaseToken,
    } satisfies StockSyncReservation
  })
}

async function upsertDiscrepancy(params: {
  binding: SyncBinding
  category: 'MISSING_IN_WMS' | 'MISSING_IN_IMS' | 'UNMAPPED_SKU' | 'QTY_MISMATCH' | 'RECEIPT_TIMING_CONFLICT'
  productId: string | null
  sku: string
  imsValue: string | null
  wmsValue: string | null
  delta: number | null
  message: string | null
}) {
  const where = buildDiscrepancyWhere(params.binding, params.category, params.productId, params.sku)
  const now = new Date()

  const updated = await db.wmsStockDiscrepancy.updateMany({
    where,
    data: {
      imsValue: params.imsValue,
      wmsValue: params.wmsValue,
      delta: params.delta,
      message: params.message,
      lastSeenAt: now,
      detectionCount: {
        increment: 1,
      },
      resolvedAt: null,
      resolvedBy: null,
      resolvedNote: null,
    },
  })
  if (updated.count > 0) {
    return
  }

  try {
    await db.wmsStockDiscrepancy.create({
      data: {
        connector: 'mintsoft',
        warehouseId: params.binding.warehouseId,
        productId: params.productId,
        sku: params.sku,
        category: params.category,
        status: 'OPEN',
        imsValue: params.imsValue,
        wmsValue: params.wmsValue,
        delta: params.delta,
        message: params.message,
        firstSeenAt: now,
        lastSeenAt: now,
      },
    })
    return
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error
    }
  }

  await db.wmsStockDiscrepancy.updateMany({
    where,
    data: {
      imsValue: params.imsValue,
      wmsValue: params.wmsValue,
      delta: params.delta,
      message: params.message,
      lastSeenAt: now,
      detectionCount: {
        increment: 1,
      },
      resolvedAt: null,
      resolvedBy: null,
      resolvedNote: null,
    },
  })
}

async function resolveOpenDiscrepancies(binding: SyncBinding, productId: string, sku: string) {
  const now = new Date()

  await db.wmsStockDiscrepancy.updateMany({
    where: {
      connector: 'mintsoft',
      warehouseId: binding.warehouseId,
      status: 'OPEN',
      OR: [
        { productId },
        { sku },
      ],
      category: {
        in: ['MISSING_IN_WMS', 'MISSING_IN_IMS', 'UNMAPPED_SKU', 'QTY_MISMATCH', 'RECEIPT_TIMING_CONFLICT'],
      },
    },
    data: {
      status: 'RESOLVED',
      resolvedAt: now,
      resolvedNote: 'Resolved by Mintsoft stock sync',
    },
  })
}

async function detectReceiptTimingConflict(
  binding: SyncBinding,
  productId: string,
  delta: number,
): Promise<string | null> {
  if (delta <= 0) return null

  const candidates = await db.wmsAsnLineMap.findMany({
    where: {
      productId,
      asn: {
        connector: 'mintsoft',
        warehouseId: binding.warehouseId,
        closedAt: null,
      },
    },
    select: {
      sourceType: true,
      sourceLineId: true,
      expectedQty: true,
      lastProcessedReceivedQty: true,
      asn: {
        select: {
          externalAsnId: true,
        },
      },
    },
    take: 10,
  })

  for (const candidate of candidates) {
    if (candidate.sourceType !== 'PURCHASE_ORDER_LINE') continue

    const poLine = await db.purchaseOrderLine.findUnique({
      where: { id: candidate.sourceLineId },
      select: {
        qty: true,
        qtyReceived: true,
      },
    })
    if (!poLine) continue

    const outstandingReceipt = Number(poLine.qty) - Number(poLine.qtyReceived)
    const remainingExpected = Number(candidate.expectedQty) - Number(candidate.lastProcessedReceivedQty)
    if (outstandingReceipt > 0 && remainingExpected > 0 && delta <= remainingExpected) {
      return `Open ASN ${candidate.asn.externalAsnId} still has ${formatQuantity(remainingExpected)} pending receipt`
    }
  }

  return null
}

type AlignmentCandidateLine = {
  id: string
  sourceType: 'PURCHASE_ORDER_LINE' | 'STOCK_TRANSFER_LINE'
  sourceLineId: string
  productId: string
  sku: string
  /**
   * ASN SCOPE: how much room THIS ASN row itself still has (6oyu.19 Codex r7 HIGH-2).
   * Separately branded from the line-scope residue below so the two cannot be
   * swapped — round 6 subtracted the line-wide figure from each ASN row and
   * under-allocated every ASN after the first on a multi-ASN transfer line.
   */
  asnResidualQty: WmsAsnLineResidualQty
  /** Parent transfer id for a STOCK_TRANSFER_LINE candidate; null for a PO line. */
  transferId: string | null
  asn: {
    externalAsnId: string
    createdAt: Date
  }
}

/** An ASN row that exists but must NOT be aligned against, and why. */
type RefusedAlignmentCandidate = {
  asnLineMapId: string
  externalAsnId: string
  reason: string
  /**
   * `unusable` — the ASN line cannot be used at all (its transfer is gone or is not
   * in a status that may bring units to rest).
   * `capped` — it is usable, but for less than its outstanding quantity, because the
   * dispatch snapshot cannot cost the rest (Codex round-8 HIGH-1). The distinction
   * matters to the operator-facing reason: only the first is about transfer status.
   */
  kind: 'unusable' | 'capped'
}

type AlignmentCandidateSet = {
  candidates: AlignmentCandidateLine[]
  /**
   * LINE SCOPE: residue of every transfer line the usable candidates draw from,
   * keyed by transfer-line id. The planner applies this as a second cap, shared
   * across the line's open ASN rows.
   */
  transferLineResiduals: Map<string, TransferLineResidualQty>
  /**
   * Every parent transfer of every transfer-backed ASN row seen — INCLUDING the
   * refused ones — so the caller knows which `stock_transfers` rows to lock at step
   * 2. Refused ones are in deliberately: a status read before the lock is exactly
   * the fact the lock is being taken to settle, so filtering by it first would
   * choose the lock set from the answer the lock is meant to produce.
   */
  parentTransferIds: string[]
  refused: RefusedAlignmentCandidate[]
}

/**
 * The open ASN lines that may absorb a positive Mintsoft delta for this product.
 *
 * PARENT STATUS IS PART OF USABILITY (6oyu.19, Codex round-7 HIGH-1). Cancelling a
 * dispatch restores the whole line and its cost layers to the SOURCE and leaves the
 * transfer's ASN OPEN — nothing closes it. Without this check a later automatic
 * align-up used the cancelled line, added stock at the DESTINATION and created a
 * second replacement layer linked to the same source layer, so one later landed-cost
 * revaluation propagated into both live layers and double-posted the inventory
 * reclassification. The predicate is the one the WMS webhook book-in has always
 * applied, shared from lib/domain/wms/asn-reconciliation so the two agree.
 *
 * `lockedTransferIds`, when supplied, is the set of `stock_transfers` rows this
 * transaction holds FOR UPDATE. A candidate whose parent is not in it is refused:
 * its status could be changing underneath this read, and a cancellation that
 * interleaves with an alignment is exactly the concurrent form of the same defect.
 */
async function getAlignmentCandidateLines(
  tx: Prisma.TransactionClient,
  binding: SyncBinding,
  productId: string,
  lockedTransferIds?: ReadonlySet<string>,
): Promise<AlignmentCandidateSet> {
  const lines = await tx.wmsAsnLineMap.findMany({
    where: {
      productId,
      asn: {
        connector: 'mintsoft',
        warehouseId: binding.warehouseId,
        closedAt: null,
      },
      sourceType: {
        in: ['PURCHASE_ORDER_LINE', 'STOCK_TRANSFER_LINE'],
      },
    },
    select: {
      id: true,
      sourceType: true,
      sourceLineId: true,
      productId: true,
      sku: true,
      expectedQty: true,
      qtyAccountedViaSnapshot: true,
      lastProcessedReceivedQty: true,
      asn: {
        select: {
          externalAsnId: true,
          createdAt: true,
        },
      },
    },
    orderBy: [
      { asn: { createdAt: 'asc' } },
      { createdAt: 'asc' },
    ],
  })

  const transferLineIds = [...new Set(lines
    .filter((line) => line.sourceType === 'STOCK_TRANSFER_LINE')
    .map((line) => line.sourceLineId))]
  const transferLines = transferLineIds.length === 0
    ? []
    : await tx.stockTransferLine.findMany({
      where: { id: { in: transferLineIds } },
      select: {
        id: true,
        qty: true,
        qtyReceived: true,
        transferId: true,
        // The dispatch snapshot, because "outstanding on the line" is not the same
        // quantity as "still costable from the snapshot" and the plan must be capped
        // by BOTH (6oyu.19, Codex round-8 HIGH-1).
        costLayerSnapshot: true,
        transfer: { select: { reference: true, status: true } },
      },
    })
  const transferLineById = new Map(transferLines.map((line) => [line.id, line]))
  // 6oyu.19 (Codex r6): capacity must count what has LANDED on the transfer line by
  // ANY route — a manual receipt moves stock_transfer_lines.qtyReceived and touches
  // neither ASN column. One query for the whole candidate set.
  const landedByTransferLineId = await loadTransferLineLandedQty(
    tx,
    transferLines.map((line) => ({ id: line.id, qtyReceived: line.qtyReceived })),
  )

  const candidates: AlignmentCandidateLine[] = []
  const transferLineResiduals = new Map<string, TransferLineResidualQty>()
  const refused: RefusedAlignmentCandidate[] = []
  const parentTransferIds = new Set<string>()

  for (const line of lines) {
    const asnResidualQty = resolveWmsAsnLineResidualQty({
      asnLineMapId: line.id,
      expectedQty: line.expectedQty,
      qtyAccountedViaSnapshot: line.qtyAccountedViaSnapshot,
      lastProcessedReceivedQty: line.lastProcessedReceivedQty,
    })

    if (line.sourceType !== 'STOCK_TRANSFER_LINE') {
      candidates.push({
        id: line.id,
        sourceType: 'PURCHASE_ORDER_LINE',
        sourceLineId: line.sourceLineId,
        productId: line.productId,
        sku: line.sku,
        asnResidualQty,
        transferId: null,
        asn: line.asn,
      })
      continue
    }

    const transferLine = transferLineById.get(line.sourceLineId)
    if (!transferLine) {
      refused.push({
        asnLineMapId: line.id,
        externalAsnId: line.asn.externalAsnId,
        reason: `transfer line ${line.sourceLineId} no longer exists`,
        kind: 'unusable',
      })
      continue
    }
    parentTransferIds.add(transferLine.transferId)

    // Refused BEFORE the status is consulted, because an unlocked status is the one
    // thing this pass may not rely on. A row whose parent appeared after the step-2
    // locks were taken cannot be locked now without inverting the global order
    // (lib/domain/wms/transfer-asn-lock-order.ts), so it waits for the next sweep.
    if (lockedTransferIds && !lockedTransferIds.has(transferLine.transferId)) {
      refused.push({
        asnLineMapId: line.id,
        externalAsnId: line.asn.externalAsnId,
        reason: `transfer ${transferLine.transfer.reference} appeared after this run took its transfer locks`,
        kind: 'unusable',
      })
      continue
    }

    if (!isTransferUsableForWmsReceipt(transferLine.transfer.status)) {
      refused.push({
        asnLineMapId: line.id,
        externalAsnId: line.asn.externalAsnId,
        reason: `transfer ${transferLine.transfer.reference} is ${transferLine.transfer.status}`,
        kind: 'unusable',
      })
      continue
    }

    // BOTH caps, built from the same landed reading: what has not landed on the
    // line, and what the dispatch snapshot can still cost. Capping only by the first
    // is Codex round-8 HIGH-1 — the plan books ten units against a six-unit
    // remaining snapshot, stock goes up by ten and the layers cover six.
    const alignmentLanded = requireLandedQty(landedByTransferLineId, transferLine.id)
    const costableRemainingQty = remainingCostableSnapshotQty({
      snapshot: transferLine.costLayerSnapshot,
      alreadyLanded: alignmentLanded,
    })
    const lineResidual = resolveTransferLineResidualQty({
      lineQty: transferLine.qty,
      landed: alignmentLanded,
      costableRemainingQty,
    })
    const outstandingQty = transferLineOutstandingQty(transferLine.qty, alignmentLanded).toNumber()
    if (costableRemainingQty < outstandingQty - WMS_RECEIPT_QTY_EPSILON) {
      // Not a refusal of this candidate — it can still absorb what the snapshot can
      // cost — but the operator has to be able to tell a snapshot shortfall from a
      // threshold problem when the delta comes back only partly explained.
      refused.push({
        asnLineMapId: line.id,
        externalAsnId: line.asn.externalAsnId,
        reason: `transfer ${transferLine.transfer.reference} has ${formatQuantity(outstandingQty)} outstanding but its `
          + `dispatch snapshot can only cost ${formatQuantity(costableRemainingQty)} more unit`
          + `${costableRemainingQty === 1 ? '' : 's'}`,
        kind: 'capped',
      })
    }
    transferLineResiduals.set(transferLine.id, lineResidual)
    candidates.push({
      id: line.id,
      sourceType: 'STOCK_TRANSFER_LINE',
      sourceLineId: line.sourceLineId,
      productId: line.productId,
      sku: line.sku,
      asnResidualQty,
      transferId: transferLine.transferId,
      asn: line.asn,
    })
  }

  return {
    candidates,
    transferLineResiduals,
    parentTransferIds: [...parentTransferIds],
    refused,
  }
}

/**
 * Why no ASN line could take the delta, naming the refused ones. A cancelled parent
 * transfer is the answer an operator most needs to see, and a silent "no capacity"
 * would read as a threshold problem.
 */
function describeRefusedAlignmentCandidates(refused: ReadonlyArray<RefusedAlignmentCandidate>): string {
  if (refused.length === 0) return ''
  const listed = refused
    .slice(0, 3)
    .map((entry) => `ASN ${entry.externalAsnId} (${entry.reason})`)
    .join('; ')
  const more = refused.length > 3 ? ` and ${refused.length - 3} more` : ''
  // The status sentence is only true of the `unusable` ones. Appending it to a
  // snapshot cap would tell an operator to go and look at a transfer status that is
  // perfectly fine (Codex round-8 HIGH-1).
  const statusNote = refused.some((entry) => entry.kind === 'unusable')
    ? ` Alignment only uses an ASN whose transfer is ${WMS_RECEIPT_USABLE_TRANSFER_STATUSES.join(' or ')}.`
    : ''
  return ` Open ASN line${refused.length === 1 ? '' : 's'} skipped or capped: ${listed}${more}.${statusNote}`
}

async function lockStockLevelForAlignment(
  tx: Prisma.TransactionClient,
  productId: string,
  warehouseId: string,
): Promise<{ reservedQty: number; quantity: number }> {
  await tx.stockLevel.upsert({
    where: {
      productId_warehouseId: {
        productId,
        warehouseId,
      },
    },
    create: {
      productId,
      warehouseId,
      quantity: 0,
      reservedQty: 0,
    },
    update: {
      quantity: { increment: 0 },
    },
  })

  await tx.$queryRaw`
    SELECT id
    FROM stock_levels
    WHERE "productId" = ${productId} AND "warehouseId" = ${warehouseId}
    FOR UPDATE
  `

  const stockLevel = await tx.stockLevel.findUnique({
    where: {
      productId_warehouseId: {
        productId,
        warehouseId,
      },
    },
    select: {
      quantity: true,
      reservedQty: true,
    },
  })

  return {
    reservedQty: Number(stockLevel?.reservedQty ?? 0),
    quantity: Number(stockLevel?.quantity ?? 0),
  }
}

/**
 * Apply a positive Mintsoft delta by absorbing it into open ASN lines.
 *
 * EXPORTED FOR THE DB-BACKED PROOFS in
 * tests/concurrency/mintsoft-alignment-cancelled-transfer.concurrent.test.ts
 * (6oyu.19, Codex round-7 HIGH-1). Everything above this function reaches the LIVE
 * Mintsoft API, so this is the deepest seam a test can drive without going to the
 * wire; the alignment's own writes — candidate selection, locking, layer creation —
 * are all below it. Production's only caller is the sweep in this file.
 */
export async function applyMintsoftAlignmentForProduct(params: {
  binding: SyncBinding
  jobId: string
  productId: string
  sku: string
  delta: number
  dryRun: boolean
}): Promise<{
  applied: boolean
  dryRun: boolean
  correctedQty: number
  reason: string
}> {
  if (params.delta <= 0) {
    return {
      applied: false,
      dryRun: params.dryRun,
      correctedQty: 0,
      reason: 'Align To WMS only auto-corrects when Mintsoft is higher than IMS; align-down remains manual.',
    }
  }
  const outcome = await db.$transaction(async (tx) => {
    // THE LOCKS, IN THE GLOBAL ORDER (6oyu.19, Codex round-9 HIGH-1).
    //
    // Round 7 added them ASN-rows-then-transfers and claimed no cycle existed; round
    // 8 found the cycle — the Mintsoft ASN-creation path takes `stock_transfers`
    // first and then rewrites that transfer's `wms_asn_line_maps` rows — and
    // withdrew the locks entirely, leaving the CONCURRENT route of o3d-2y5u open on
    // the grounds that `development` has no guard at all so nothing regressed.
    //
    // Both rounds were reasoning about which order THIS function should take. The
    // answer was that the codebase needed ONE order and did not have one: three of
    // the four paths already took TRANSFER→ASN and only booked-in reconciliation
    // took ASN→TRANSFER. That is now fixed globally
    // (lib/domain/wms/transfer-asn-lock-order.ts), so alignment takes the same
    // order as everything else and the cycle round 8 withdrew for does not exist.
    //
    // WHAT THE LOCK BUYS. `cancelDispatchedTransfer` restores the FULL line quantity
    // and a second set of replacement cost layers at the SOURCE, then marks the
    // transfer CANCELLED. Without the transfer lock it could commit between this
    // function's status read and its writes, so both copies stayed live and a later
    // landed-cost revaluation posted the inventory reclassification twice — the
    // exact double-count this branch exists to close, one route over. The status
    // guard alone closes only the SEQUENTIAL form of that. The re-read below is what
    // makes the lock worth taking: taking a lock and then acting on the read from
    // before it would settle nothing.
    const discovery = await getAlignmentCandidateLines(tx, params.binding, params.productId)
    if (discovery.candidates.length === 0) {
      return {
        kind: 'unavailable' as const,
        correctedQty: 0,
        reason: `No open ASN line is available to absorb this WMS delta.${describeRefusedAlignmentCandidates(discovery.refused)}`,
      }
    }

    // STEP 2, then STEP 4 — never the other way about.
    const lockedTransferIds = new Set(await lockStockTransfers(tx, discovery.parentTransferIds))
    await lockWmsAsnLineMaps(tx, discovery.candidates.map((candidate) => candidate.id))

    // Read again UNDER the locks. Every fact the plan rests on — each parent
    // transfer's status, each ASN row's counters — is now covered by a lock this
    // transaction holds until it commits.
    const candidateSet = await getAlignmentCandidateLines(tx, params.binding, params.productId, lockedTransferIds)
    const candidates = candidateSet.candidates

    if (candidates.length === 0) {
      return {
        kind: 'unavailable' as const,
        correctedQty: 0,
        reason: `No open ASN line is available to absorb this WMS delta.${describeRefusedAlignmentCandidates(candidateSet.refused)}`,
      }
    }

    const plan = planMintsoftAlignmentAllocations({
      delta: params.delta,
      candidates: candidates.map((candidate) => ({
        asnLineMapId: candidate.id,
        asnResidualQty: candidate.asnResidualQty,
        transferLineId: candidate.sourceType === 'STOCK_TRANSFER_LINE' ? candidate.sourceLineId : null,
        sortAt: candidate.asn.createdAt,
        sortId: candidate.id,
      })),
      transferLineResiduals: candidateSet.transferLineResiduals,
    })

    if (plan.allocations.length === 0 || plan.unallocatedQty > 0.0001) {
      const coveredQty = params.delta - plan.unallocatedQty
      const refusedNote = describeRefusedAlignmentCandidates(candidateSet.refused)
      return {
        kind: 'unavailable' as const,
        correctedQty: 0,
        reason: coveredQty > 0
          ? `Open ASN lines only explain ${formatQuantity(coveredQty)} of the ${formatQuantity(params.delta)} delta; leaving stock unchanged.${refusedNote}`
          : `No open ASN line has remaining capacity for this WMS delta.${refusedNote}`,
      }
    }

    if (params.dryRun) {
      return {
        kind: 'dryRun' as const,
        correctedQty: params.delta,
        allocationCount: plan.allocations.length,
        reason: `Dry run: ${plan.allocations.length} ASN line${plan.allocations.length === 1 ? '' : 's'} would absorb ${formatQuantity(params.delta)}.`,
      }
    }

    const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]))
    const stockLevel = await lockStockLevelForAlignment(tx, params.productId, params.binding.warehouseId)

    for (const allocation of plan.allocations) {
      const candidate = candidateById.get(allocation.asnLineMapId)
      if (!candidate) {
        throw new Error(`Missing ASN line ${allocation.asnLineMapId} during alignment.`)
      }

      const movement = await tx.stockMovement.create({
        data: {
          type: 'WMS_RECEIPT_RECONCILIATION',
          productId: params.productId,
          toWarehouseId: params.binding.warehouseId,
          qty: allocation.qty,
          note: `Mintsoft alignment snapshot against ASN ${candidate.asn.externalAsnId}`,
          referenceType: 'WmsAsnLineMap',
          referenceId: candidate.id,
        },
        select: {
          id: true,
        },
      })

      if (candidate.sourceType === 'PURCHASE_ORDER_LINE') {
        const poLine = await tx.purchaseOrderLine.findUnique({
          where: { id: candidate.sourceLineId },
          select: {
            id: true,
            productId: true,
            unitCostBase: true,
            landedUnitCostBase: true,
          },
        })
        if (!poLine) {
          throw new Error(`Purchase order line ${candidate.sourceLineId} is missing for alignment.`)
        }
        const unitCostBase = Number(poLine.landedUnitCostBase ?? poLine.unitCostBase)
        await tx.stockMovement.update({
          where: { id: movement.id },
          data: buildStockMovementValueFields({ qty: allocation.qty, unitCostBase }),
        })

        await createCostLayer(tx, {
          productId: poLine.productId,
          warehouseId: params.binding.warehouseId,
          qty: allocation.qty,
          unitCostBase,
          poLineId: poLine.id,
          adjustmentMovementId: movement.id,
        })
      } else {
        const transferLine = await tx.stockTransferLine.findUnique({
          where: { id: candidate.sourceLineId },
          select: {
            id: true,
            productId: true,
            qtyReceived: true,
            costLayerSnapshot: true,
          },
        })
        if (!transferLine) {
          throw new Error(`Transfer line ${candidate.sourceLineId} is missing for alignment.`)
        }

        // 6oyu.19 (Codex round-6 HIGH-1): the offset used to be this ASN line's
        // `qtyAccountedViaSnapshot` alone, which ignores every unit a MANUAL receipt
        // or a webhook book-in already landed and layered — slicing from too low an
        // offset re-lays those layers. It now comes from the one definition of
        // "already landed", which counts both columns, so this path and the three in
        // app/actions/transfers.ts cannot disagree about where the snapshot resumes.
        const alreadyLanded = requireLandedQty(
          await loadTransferLineLandedQty(tx, [transferLine]),
          transferLine.id,
        )
        const snapshotSlice = sliceTransferSnapshotForReceipt({
          snapshot: transferLine.costLayerSnapshot,
          alreadyLanded,
          qtyReceived: allocation.qty,
        })

        if (snapshotSlice.length === 0 && allocation.qty > 0) {
          throw new Error(`Transfer line ${candidate.sourceLineId} has no FIFO snapshot left for alignment.`)
        }
        await tx.stockMovement.update({
          where: { id: movement.id },
          data: buildStockMovementValueFieldsFromTotal({
            qty: allocation.qty,
            totalValueBase: snapshotSlice.reduce(
              (sum, entry) => addMoney(sum, multiplyMoney(entry.qty, entry.unitCostBase)),
              toDecimal(0),
            ),
          }),
        })

        // 6oyu.19: same omission as the WMS webhook receipt path — the created
        // layer had no costLayerSourceLine whenever the source was a plain
        // PO-derived layer, stranding the landed-cost delta. Routed through the
        // shared helper so the link is guaranteed, not remembered — and so is the
        // quantity: stock is incremented for this allocation below, and an entry the
        // helper declined would leave it unlayered (Codex round-4 HIGH).
        //
        // It REFUSES a snapshot entry whose unit cost is negative (Codex round-5
        // HIGH, o3d-gd2f), creating nothing and aborting this transaction rather
        // than let the allocation's stock increment commit alone. Do NOT wrap this
        // call in a try or a savepoint.
        //
        // Note this alignment does NOT change the transfer's status, so a transfer
        // can be IN_TRANSIT with these units fully layered and propagatable. What is
        // still uncovered is a revaluation that landed while units were in transit:
        // nothing here discharges it and the delta stays in the transit clearing
        // account. Open, tracked as o3d-nrl4.
        //
        // `bookedQty` is `allocation.qty`, the stock increment made below, and the
        // helper's coverage postcondition is measured against IT (Codex round-8
        // HIGH-1). The old postcondition compared the created layers with the SLICE,
        // and the slice is only as long as the snapshot allowed — a ten-unit
        // allocation over a six-unit remaining snapshot compared six with six and
        // passed, then incremented stock by ten.
        //
        // `REFUSE` rather than `BALANCE_AT_ZERO_COST`, and it is a backstop rather
        // than a route: the plan above is already capped by
        // `remainingCostableSnapshotQty`, so a shortfall here means the cap and the
        // slicer have come to disagree. Alignment is an OPTIONAL auto-correction of
        // a WMS/IMS discrepancy — unlike the three receipt paths, nothing is
        // physically waiting to be booked — so inventing £0 units to push an
        // optional correction through would be strictly worse than leaving the
        // discrepancy where an operator can see it.
        await recreateTransferCostLayersFromSnapshotSlice(
          tx,
          {
            productId: transferLine.productId,
            warehouseId: params.binding.warehouseId,
            transferLineId: transferLine.id,
            adjustmentMovementId: movement.id,
            contextLabel: `transfer line ${transferLine.id} WMS stock-sync alignment`,
            bookedQty: allocation.qty,
            uncostedShortfall: 'REFUSE',
          },
          snapshotSlice,
        )
      }

      await tx.stockLevel.update({
        where: {
          productId_warehouseId: {
            productId: params.productId,
            warehouseId: params.binding.warehouseId,
          },
        },
        data: {
          quantity: { increment: allocation.qty },
        },
      })

      await tx.wmsAsnLineMap.update({
        where: { id: candidate.id },
        data: {
          qtyAccountedViaSnapshot: { increment: allocation.qty },
          note: null,
        },
      })
    }

    return {
      kind: 'applied' as const,
      correctedQty: params.delta,
      allocationCount: plan.allocations.length,
      reason: `Aligned ${formatQuantity(params.delta)} from Mintsoft to ${plan.allocations.length} open ASN line${plan.allocations.length === 1 ? '' : 's'}.`,
      reservedQty: stockLevel.reservedQty,
      quantityBefore: stockLevel.quantity,
      quantityAfter: stockLevel.quantity + params.delta,
      allocations: plan.allocations.map((allocation) => {
        const candidate = candidateById.get(allocation.asnLineMapId)
        if (!candidate) {
          throw new Error(`Missing ASN line ${allocation.asnLineMapId} during alignment result mapping.`)
        }
        return {
          asnLineMapId: candidate.id,
          externalAsnId: candidate.asn.externalAsnId,
          sourceType: candidate.sourceType,
          sourceLineId: candidate.sourceLineId,
          qty: allocation.qty,
        }
      }),
    }
  }, { maxWait: 5000, timeout: 30000 })

  if (outcome.kind === 'applied') {
    const reservedExceedsAvailable = outcome.reservedQty > outcome.quantityAfter
    await logActivity({
      entityType: 'SYNC',
      entityId: params.binding.id,
      tag: 'sync',
      action: 'mintsoft_alignment_applied',
      description: reservedExceedsAvailable
        ? `Applied Mintsoft alignment for ${params.sku} in ${params.binding.warehouse.code} — reservations exceed aligned quantity`
        : `Applied Mintsoft alignment for ${params.sku} in ${params.binding.warehouse.code}`,
      metadata: {
        warehouseId: params.binding.warehouseId,
        productId: params.productId,
        sku: params.sku,
        delta: params.delta,
        reservedQty: outcome.reservedQty,
        quantityBefore: outcome.quantityBefore,
        quantityAfter: outcome.quantityAfter,
        reservedExceedsAvailable,
        allocations: outcome.allocations,
      },
      level: reservedExceedsAvailable ? 'WARNING' : undefined,
      resolveUser: false,
    })
    await recordWmsMutationEvent({
      connector: 'mintsoft', direction: 'INBOUND', action: 'align_up', outcome: 'SUCCEEDED',
      entityType: 'STOCK_LEVEL', entityId: params.productId, jobId: params.jobId,
      summary: `Align-up: ${params.sku} in ${params.binding.warehouse.code} raised to match Mintsoft (+${params.delta})`,
      before: { sku: params.sku, warehouseId: params.binding.warehouseId, quantity: outcome.quantityBefore, reservedQty: outcome.reservedQty },
      after: { sku: params.sku, warehouseId: params.binding.warehouseId, quantity: outcome.quantityAfter, delta: params.delta, allocations: outcome.allocations },
      triggeredBy: 'stock-sync',
    })
    await enqueueAlignmentStockSync(params.binding, params.productId, params.sku)
  }

  return {
    applied: outcome.kind === 'applied',
    dryRun: outcome.kind === 'dryRun',
    correctedQty: outcome.correctedQty,
    reason: outcome.reason,
  }
}

/**
 * 6oyu.1: outstanding inbound quantity for a product across OPEN Mintsoft ASNs.
 * Covers both receipts still expected (Mintsoft has not booked them in) and
 * unreconciled alignment snapshot credits (booked-in webhook not yet processed).
 * Either being positive means a lower Mintsoft balance can be receipt timing,
 * so align-down must hold.
 */
async function getOpenAsnPendingQty(binding: SyncBinding, productId: string): Promise<number> {
  const lines = await db.wmsAsnLineMap.findMany({
    where: {
      productId,
      asn: {
        connector: 'mintsoft',
        warehouseId: binding.warehouseId,
        closedAt: null,
      },
    },
    select: {
      expectedQty: true,
      qtyAccountedViaSnapshot: true,
      lastProcessedReceivedQty: true,
    },
  })

  return lines.reduce((sum, line) => {
    const expected = Number(line.expectedQty)
    const snapshot = Number(line.qtyAccountedViaSnapshot)
    const received = Number(line.lastProcessedReceivedQty)
    const pendingReceipt = Math.max(0, expected - Math.max(snapshot, received))
    const unreconciledCredit = Math.max(0, snapshot - received)
    return sum + pendingReceipt + unreconciledCredit
  }, 0)
}

/**
 * 6oyu.1: auto-correct a NEGATIVE Mintsoft delta (IMS holds more than the WMS)
 * by posting a downward stock adjustment against the binding's align-down
 * adjustment reason. All safety gates live in planMintsoftAlignDown; the write
 * path is the same applyStockAdjustment the manual adjustment/stocktake flows
 * use (FIFO consumption, movement value fields, inventory GL journal).
 */
async function applyMintsoftAlignDownForProduct(params: {
  binding: SyncBinding
  jobId: string
  productId: string
  sku: string
  delta: number
  imsQty: number
  wmsQty: number
  dryRun: boolean
  runStartedAt: Date
}): Promise<{
  applied: boolean
  dryRun: boolean
  reason: string
}> {
  const [priorDiscrepancy, openAsnPendingQty, stockLevel, alignDownReason] = await Promise.all([
    db.wmsStockDiscrepancy.findFirst({
      where: buildDiscrepancyWhere(params.binding, 'QTY_MISMATCH', params.productId, params.sku),
      select: { delta: true, lastSeenAt: true },
    }),
    getOpenAsnPendingQty(params.binding, params.productId),
    db.stockLevel.findUnique({
      where: {
        productId_warehouseId: {
          productId: params.productId,
          warehouseId: params.binding.warehouseId,
        },
      },
      select: { reservedQty: true },
    }),
    // Codex P2: the save-time active + GL-account validation can go stale (the
    // reason deactivated or its account removed after binding save). Without a
    // live account code applyStockAdjustment would silently skip the inventory
    // journal, so revalidate here — a stale reason degrades to a manual hold.
    params.binding.alignDownReasonId
      ? db.adjustmentReason.findUnique({
          where: { id: params.binding.alignDownReasonId },
          select: { active: true, accountCode: true },
        })
      : Promise.resolve(null),
  ])

  const decision = planMintsoftAlignDown({
    delta: params.delta,
    imsQty: params.imsQty,
    wmsQty: params.wmsQty,
    reservedQty: Number(stockLevel?.reservedQty ?? 0),
    reasonConfigured: Boolean(alignDownReason?.active && alignDownReason?.accountCode),
    thresholds: parseMintsoftThresholds(params.binding.discrepancyThresholds),
    openAsnPendingQty,
    priorDiscrepancy: priorDiscrepancy
      ? {
          delta: priorDiscrepancy.delta == null ? null : Number(priorDiscrepancy.delta),
          lastSeenAt: priorDiscrepancy.lastSeenAt,
        }
      : null,
    runStartedAt: params.runStartedAt,
  })

  if (decision.action === 'hold') {
    return { applied: false, dryRun: false, reason: decision.reason }
  }

  if (params.dryRun) {
    return {
      applied: false,
      dryRun: true,
      reason: `Dry run: would align ${params.sku} down ${formatQuantity(Math.abs(decision.qty))} (${formatQuantity(params.imsQty)} → ${formatQuantity(params.wmsQty)}).`,
    }
  }

  const outcome = await db.$transaction(async (tx) => {
    // Re-check the on-hand quantity UNDER the lock: the delta was computed from a
    // fetch made earlier in the sweep, and a dispatch/receipt landing in between
    // would make it stale — applying it anyway would overshoot the correction.
    const locked = await lockStockLevelForAlignment(tx, params.productId, params.binding.warehouseId)
    if (locked.quantity !== params.imsQty) {
      return {
        applied: false as const,
        reason: `IMS stock moved during the sync run (${formatQuantity(params.imsQty)} → ${formatQuantity(locked.quantity)}); align-down skipped this run.`,
      }
    }

    const applied = await applyStockAdjustment({
      tx,
      productId: params.productId,
      warehouseId: params.binding.warehouseId,
      qty: decision.qty,
      reasonId: params.binding.alignDownReasonId ?? undefined,
      note: `Mintsoft Align To WMS: aligned down from ${formatQuantity(params.imsQty)} to ${formatQuantity(params.wmsQty)}`,
      referenceType: 'WmsSyncJob',
      referenceId: params.jobId,
      idempotencyToken: `mintsoft-align-down:${params.jobId}:${params.productId}`,
    })

    return {
      applied: true as const,
      reason: `Aligned ${params.sku} down ${formatQuantity(Math.abs(decision.qty))} to match Mintsoft (${formatQuantity(params.imsQty)} → ${formatQuantity(params.wmsQty)}).`,
      movementId: applied.movementId,
      reservedQty: locked.reservedQty,
    }
  }, { maxWait: 5000, timeout: 30000 })

  if (outcome.applied) {
    await logActivity({
      entityType: 'SYNC',
      entityId: params.binding.id,
      tag: 'sync',
      action: 'mintsoft_align_down_applied',
      description: `Applied Mintsoft align-down for ${params.sku} in ${params.binding.warehouse.code} (${formatQuantity(params.imsQty)} → ${formatQuantity(params.wmsQty)})`,
      metadata: {
        warehouseId: params.binding.warehouseId,
        productId: params.productId,
        sku: params.sku,
        delta: params.delta,
        quantityBefore: params.imsQty,
        quantityAfter: params.wmsQty,
        reservedQty: outcome.reservedQty,
        movementId: outcome.movementId,
        adjustmentReasonId: params.binding.alignDownReasonId,
      },
      level: 'WARNING',
      resolveUser: false,
    })
    await recordWmsMutationEvent({
      connector: 'mintsoft', direction: 'INBOUND', action: 'align_down', outcome: 'SUCCEEDED',
      entityType: 'STOCK_LEVEL', entityId: params.productId, jobId: params.jobId,
      summary: `Align-down: ${params.sku} in ${params.binding.warehouse.code} lowered to match Mintsoft (${params.imsQty} → ${params.wmsQty})`,
      before: { sku: params.sku, warehouseId: params.binding.warehouseId, quantity: params.imsQty, reservedQty: outcome.reservedQty },
      after: { sku: params.sku, warehouseId: params.binding.warehouseId, quantity: params.wmsQty, delta: params.delta, movementId: outcome.movementId, adjustmentReasonId: params.binding.alignDownReasonId },
      triggeredBy: 'stock-sync',
    })
    await enqueueAlignmentStockSync(params.binding, params.productId, params.sku)
  }

  return { applied: outcome.applied, dryRun: false, reason: outcome.reason }
}

async function notifyThresholdBreaches(binding: SyncBinding, breachCount: number): Promise<number> {
  if (breachCount === 0 || binding.reportRecipients.length === 0) return 0

  const recipients = binding.reportRecipients.map((recipient) => recipient.trim().toLowerCase()).filter(Boolean)
  if (recipients.length === 0) return 0

  const users = await db.user.findMany({
    where: {
      email: {
        in: recipients,
        mode: 'insensitive',
      },
    },
    select: {
      id: true,
      email: true,
    },
  })

  await Promise.all(users.map((user) => (
    notify({
      userId: user.id,
      type: 'warning',
      title: 'Mintsoft stock discrepancies detected',
      message: `${binding.warehouse.code}: ${breachCount} stock discrepancy${breachCount === 1 ? '' : 'ies'} exceeded the configured threshold.`,
      actionUrl: '/sync?connector=mintsoft',
    })
  )))

  return users.length
}

async function updateBindingSyncState(bindingId: string, status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED') {
  await db.externalWmsBinding.update({
    where: { id: bindingId },
    data: {
      lastStockSyncAt: new Date(),
      lastStockSyncStatus: status,
      // Only a run that actually completed its checks heals the watchdog's
      // stale-sync alert and advances its staleness anchor (Codex r4/r5: a
      // FAILED run advancing the anchor kept a permanently failing binding
      // "fresh", so the first stale alert would never fire).
      ...(status === 'FAILED' ? {} : { staleSyncAlertedAt: null, lastStockSyncSuccessAt: new Date() }),
    },
  })
}

async function completeJob(
  jobId: string,
  status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED',
  counters: Omit<MintsoftStockSyncResult, 'bindingId' | 'warehouseId' | 'warehouseCode' | 'jobId' | 'status' | 'notifiedUsers' | 'skippedReason'>,
  summary: SyncSummary,
  leaseToken?: string,
): Promise<boolean> {
  const updated = await db.wmsSyncJob.updateMany({
    where: {
      id: jobId,
      ...(leaseToken
        ? {
            status: 'RUNNING',
            AND: [{ summary: { path: ['leaseToken'], equals: leaseToken } }],
          }
        : {}),
    },
    data: {
      status,
      finishedAt: new Date(),
      totalChecked: counters.totalChecked,
      matched: counters.matched,
      mismatched: counters.mismatched,
      corrected: counters.corrected,
      skipped: counters.skipped,
      errors: counters.errors,
      summary: (
        leaseToken
          ? { ...summary, leaseToken }
          : summary
      ) as Prisma.InputJsonValue,
    },
  })

  return updated.count === 1
}

async function updateBindingSyncStateIfCurrent(
  bindingId: string,
  status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED',
  jobId: string,
  leaseToken: string,
): Promise<boolean> {
  const job = await db.wmsSyncJob.findFirst({
    where: {
      id: jobId,
      AND: [{ summary: { path: ['leaseToken'], equals: leaseToken } }],
    },
    select: {
      id: true,
      status: true,
    },
  })

  if (!job || job.status !== status) {
    return false
  }

  await updateBindingSyncState(bindingId, status)
  return true
}

export async function runStockSyncForBinding(
  bindingId: string,
  triggeredBy: string,
): Promise<MintsoftStockSyncResult> {
  const reservation = await reserveStockSyncJob(bindingId, triggeredBy)
  if (!reservation.binding) {
    return {
      bindingId,
      warehouseId: '',
      warehouseCode: '',
      jobId: null,
      status: 'FAILED',
      totalChecked: 0,
      matched: 0,
      mismatched: 0,
      corrected: 0,
      skipped: 0,
      errors: 1,
      notifiedUsers: 0,
      alignmentPreviews: 0,
      skippedReason: reservation.skippedReason,
    }
  }

  const binding = reservation.binding
  if (reservation.skippedReason) {
    return {
      bindingId: binding.id,
      warehouseId: binding.warehouseId,
      warehouseCode: binding.warehouse.code,
      jobId: reservation.jobId,
      status: 'SKIPPED',
      totalChecked: 0,
      matched: 0,
      mismatched: 0,
      corrected: 0,
      skipped: 0,
      errors: 0,
      notifiedUsers: 0,
      alignmentPreviews: 0,
      skippedReason: reservation.skippedReason,
    }
  }

  const job = { id: reservation.jobId! }
  const leaseToken = reservation.leaseToken!

  const counters = {
    totalChecked: 0,
    matched: 0,
    mismatched: 0,
    corrected: 0,
    alignmentPreviews: 0,
    skipped: 0,
    errors: 0,
  }

  let thresholdBreaches = 0
  const alignmentDryRun = binding.stockSyncMode === 'ALIGN_TO_WMS' && !binding.alignmentConfirmedAt
  // 6oyu.1: align-down's persistence gate compares the prior discrepancy's
  // lastSeenAt against this run's start — a row written by THIS run must not
  // count as prior evidence.
  const runStartedAt = new Date()
  let lastHeartbeatAt = Date.now()

  try {
    const refreshLease = async (force = false) => {
      if (!force && Date.now() - lastHeartbeatAt < STOCK_SYNC_HEARTBEAT_INTERVAL) {
        return
      }

      const kept = await heartbeatStockSyncJob(job.id, binding, leaseToken)
      if (!kept) {
        throw new Error('Mintsoft stock sync lease was lost')
      }
      lastHeartbeatAt = Date.now()
    }

    const connector = getWmsConnector('mintsoft')
    const fetchedLines = await connector.fetchStockLevels(binding.externalWarehouseId)
    await refreshLease(true)
    const stockLines = consolidateMintsoftStockLines(fetchedLines)
    const thresholds = parseMintsoftThresholds(binding.discrepancyThresholds)
    const skus = stockLines.map((line) => line.sku)
    const returnedSkus = new Set(skus)

    const products = skus.length > 0
      ? await db.product.findMany({
          where: { sku: { in: skus } },
          select: {
            id: true,
            sku: true,
            name: true,
          },
        })
      : []

    const productBySku = new Map(products.map((product) => [product.sku, product]))
    const productIds = products.map((product) => product.id)
    const stockLevels = productIds.length > 0
      ? await db.stockLevel.findMany({
          where: {
            warehouseId: binding.warehouseId,
            productId: { in: productIds },
          },
          select: {
            productId: true,
            quantity: true,
          },
        })
      : []
    const stockLevelByProductId = new Map(stockLevels.map((level) => [level.productId, level]))
    const missingSnapshotRows = await db.wmsStockSnapshot.findMany({
      where: {
        connector: 'mintsoft',
        warehouseId: binding.warehouseId,
        ...(productIds.length > 0 ? { productId: { notIn: productIds } } : {}),
      },
      select: {
        productId: true,
        externalQty: true,
        product: {
          select: {
            sku: true,
          },
        },
      },
    })
    const missingSnapshotProductIds = missingSnapshotRows.map((row) => row.productId)
    const excludedAdditionalStockProductIds = [...productIds, ...missingSnapshotProductIds]
    const missingSnapshotStockLevels = missingSnapshotProductIds.length > 0
      ? await db.stockLevel.findMany({
          where: {
            warehouseId: binding.warehouseId,
            productId: { in: missingSnapshotProductIds },
          },
          select: {
            productId: true,
            quantity: true,
            product: {
              select: {
                sku: true,
              },
            },
          },
        })
      : []
    const additionalStockLevels = await db.stockLevel.findMany({
      where: {
        warehouseId: binding.warehouseId,
        quantity: { not: 0 },
        ...(excludedAdditionalStockProductIds.length > 0
          ? { productId: { notIn: excludedAdditionalStockProductIds } }
          : {}),
      },
      select: {
        productId: true,
        quantity: true,
        product: {
          select: {
            sku: true,
          },
        },
      },
    })

    const logRows: Array<Prisma.WmsSyncLogCreateManyInput> = []

    for (const line of stockLines) {
      await refreshLease()
      counters.totalChecked += 1

      try {
        const product = productBySku.get(line.sku)
        if (!product) {
          counters.mismatched += 1
          // productBySku is built from an unfiltered Product-by-SKU lookup, so a miss
          // on a real SKU means the product is absent from IMS entirely — distinct
          // from a line that carries no SKU to resolve at all (6oyu.17).
          const category = classifyUnresolvedWmsSku(line.sku)
          await upsertDiscrepancy({
            binding,
            category,
            productId: null,
            sku: line.sku,
            imsValue: null,
            wmsValue: formatQuantity(line.quantity),
            delta: null,
            message: category === 'MISSING_IN_IMS'
              ? `Mintsoft holds stock for SKU ${line.sku}, which has no matching IMS product. Create or import the product in IMS.`
              : 'Mintsoft returned a stock line with no SKU, so it cannot be resolved to an IMS product. Fix the product record in Mintsoft.',
          })

          logRows.push({
            jobId: job.id,
            sku: line.sku,
            productId: null,
            action: 'discrepancy',
            wmsQty: line.quantity,
            delta: null,
            reason: category,
            payload: (line.raw ?? {}) as Prisma.InputJsonValue,
          })
          continue
        }

        const imsQty = Number(stockLevelByProductId.get(product.id)?.quantity ?? 0)
        const wmsQty = line.quantity
        const delta = wmsQty - imsQty

        await db.wmsStockSnapshot.upsert({
          where: {
            connector_warehouseId_productId: {
              connector: 'mintsoft',
              warehouseId: binding.warehouseId,
              productId: product.id,
            },
          },
          create: {
            connector: 'mintsoft',
            warehouseId: binding.warehouseId,
            productId: product.id,
            externalQty: wmsQty,
            imsQtyAtSync: imsQty,
            lastSeenAt: new Date(),
          },
          update: {
            externalQty: wmsQty,
            imsQtyAtSync: imsQty,
            lastSeenAt: new Date(),
          },
        })

        if (delta === 0) {
          counters.matched += 1
          await resolveOpenDiscrepancies(binding, product.id, product.sku)
          logRows.push({
            jobId: job.id,
            sku: product.sku,
            productId: product.id,
            action: 'noop',
            imsQtyBefore: imsQty,
            imsQtyAfter: imsQty,
            wmsQty,
            delta: 0,
            reason: 'MATCHED',
            payload: (line.raw ?? {}) as Prisma.InputJsonValue,
          })
          continue
        }

        counters.mismatched += 1

        if (binding.stockSyncMode === 'ALIGN_TO_WMS' && delta > 0) {
          const alignment = await applyMintsoftAlignmentForProduct({
            binding,
            jobId: job.id,
            productId: product.id,
            sku: product.sku,
            delta,
            dryRun: alignmentDryRun,
          })

          if (alignment.applied || alignment.dryRun) {
            if (alignment.applied) {
              counters.corrected += 1
              await resolveOpenDiscrepancies(binding, product.id, product.sku)
            } else {
              counters.alignmentPreviews += 1
            }
            logRows.push({
              jobId: job.id,
              sku: product.sku,
              productId: product.id,
              action: alignment.applied ? 'corrected' : 'discrepancy',
              imsQtyBefore: imsQty,
              imsQtyAfter: alignment.applied ? wmsQty : imsQty,
              wmsQty,
              delta,
              reason: alignment.applied ? alignment.reason : `DRY_RUN_PREVIEW: ${alignment.reason}`,
              payload: (line.raw ?? {}) as Prisma.InputJsonValue,
            })
            continue
          }
        }

        // 6oyu.1: align-down. A held decision falls through to the normal
        // discrepancy upsert below carrying the hold reason, which both surfaces
        // WHY it stayed manual and arms the persistence gate for the next run
        // (the gate reads the discrepancy this run writes).
        let alignDownHoldReason: string | null = null
        if (binding.stockSyncMode === 'ALIGN_TO_WMS' && delta < 0) {
          const alignDown = await applyMintsoftAlignDownForProduct({
            binding,
            jobId: job.id,
            productId: product.id,
            sku: product.sku,
            delta,
            imsQty,
            wmsQty,
            dryRun: alignmentDryRun,
            runStartedAt,
          })

          if (alignDown.applied) {
            counters.corrected += 1
            await resolveOpenDiscrepancies(binding, product.id, product.sku)
            logRows.push({
              jobId: job.id,
              sku: product.sku,
              productId: product.id,
              action: 'corrected',
              imsQtyBefore: imsQty,
              imsQtyAfter: wmsQty,
              wmsQty,
              delta,
              reason: alignDown.reason,
              payload: (line.raw ?? {}) as Prisma.InputJsonValue,
            })
            continue
          }

          if (alignDown.dryRun) {
            counters.alignmentPreviews += 1
            alignDownHoldReason = `DRY_RUN_PREVIEW: ${alignDown.reason}`
          } else {
            alignDownHoldReason = alignDown.reason
          }
        }

        const timingConflict = await detectReceiptTimingConflict(binding, product.id, delta)
        const category = timingConflict ? 'RECEIPT_TIMING_CONFLICT' : 'QTY_MISMATCH'
        const message = timingConflict
          ?? (
            alignDownHoldReason
              ? `IMS has ${formatQuantity(imsQty)} and Mintsoft has ${formatQuantity(wmsQty)} for ${product.sku}. ${alignDownHoldReason}`
              : `IMS has ${formatQuantity(imsQty)} and Mintsoft has ${formatQuantity(wmsQty)} for ${product.sku}.`
          )

        await upsertDiscrepancy({
          binding,
          category,
          productId: product.id,
          sku: product.sku,
          imsValue: formatQuantity(imsQty),
          wmsValue: formatQuantity(wmsQty),
          delta,
          message,
        })

        if (hasMintsoftThresholdBreach(imsQty, wmsQty, thresholds)) {
          thresholdBreaches += 1
        }

        logRows.push({
          jobId: job.id,
          sku: product.sku,
          productId: product.id,
          action: 'discrepancy',
          imsQtyBefore: imsQty,
          imsQtyAfter: imsQty,
          wmsQty,
          delta,
          reason: category,
          payload: (line.raw ?? {}) as Prisma.InputJsonValue,
        })
      } catch (error) {
        counters.errors += 1
        logRows.push({
          jobId: job.id,
          sku: line.sku,
          productId: null,
          action: 'error',
          wmsQty: line.quantity,
          reason: error instanceof Error ? error.message : 'Unexpected Mintsoft stock sync error',
          payload: (line.raw ?? {}) as Prisma.InputJsonValue,
        })
      }
    }

    const missingCandidates = collectMissingInWmsCandidates({
      returnedSkus,
      snapshots: missingSnapshotRows.map((row) => ({
        productId: row.productId,
        sku: row.product.sku,
        externalQty: Number(row.externalQty),
      })),
      stockLevels: [
        ...missingSnapshotStockLevels,
        ...additionalStockLevels,
      ].map((row) => ({
        productId: row.productId,
        sku: row.product.sku,
        quantity: Number(row.quantity),
      })),
    })

    for (const candidate of missingCandidates) {
      await refreshLease()
      counters.totalChecked += 1
      counters.mismatched += 1

      await upsertDiscrepancy({
        binding,
        category: 'MISSING_IN_WMS',
        productId: candidate.productId,
        sku: candidate.sku,
        imsValue: formatQuantity(candidate.imsQty),
        wmsValue: null,
        delta: null,
        message: candidate.lastExternalQty != null
          ? `Mintsoft did not return ${candidate.sku}; last seen external qty was ${formatQuantity(candidate.lastExternalQty)}.`
          : `Mintsoft did not return ${candidate.sku} for the linked warehouse.`,
      })

      if (hasMintsoftThresholdBreach(candidate.imsQty, 0, thresholds)) {
        thresholdBreaches += 1
      }

      logRows.push({
        jobId: job.id,
        sku: candidate.sku,
        productId: candidate.productId,
        action: 'discrepancy',
        imsQtyBefore: candidate.imsQty,
        imsQtyAfter: candidate.imsQty,
        wmsQty: null,
        delta: null,
        reason: 'MISSING_IN_WMS',
        payload: Prisma.JsonNull,
      })
    }

    if (logRows.length > 0) {
      await refreshLease(true)
      await db.wmsSyncLog.createMany({ data: logRows })
    }

    await refreshLease(true)
    const notifiedUsers = await notifyThresholdBreaches(binding, thresholdBreaches)
    const status: 'SUCCEEDED' | 'PARTIAL' = counters.errors > 0 ? 'PARTIAL' : 'SUCCEEDED'
    const summary: SyncSummary = {
      externalWarehouseId: binding.externalWarehouseId,
      thresholdBreaches,
      notifiedUsers,
      dryRun: alignmentDryRun,
      alignmentCorrections: counters.corrected,
      alignmentPreviews: counters.alignmentPreviews,
    }

    const completed = await completeJob(job.id, status, counters, summary, leaseToken)
    if (!completed) {
      throw new Error('Mintsoft stock sync lease was lost before completion')
    }
    await updateBindingSyncStateIfCurrent(binding.id, status, job.id, leaseToken)

    await logActivity({
      entityType: 'SYSTEM',
      tag: 'sync',
      action: 'mintsoft_stock_sync',
      description: `Mintsoft stock sync completed for ${binding.warehouse.code}: ${counters.totalChecked} checked, ${counters.mismatched} discrepancies, ${counters.errors} errors.`,
      metadata: {
        bindingId: binding.id,
        warehouseId: binding.warehouseId,
        jobId: job.id,
        ...summary,
      },
      resolveUser: false,
    })

    return {
      bindingId: binding.id,
      warehouseId: binding.warehouseId,
      warehouseCode: binding.warehouse.code,
      jobId: job.id,
      status,
      totalChecked: counters.totalChecked,
      matched: counters.matched,
      mismatched: counters.mismatched,
      corrected: counters.corrected,
      skipped: counters.skipped,
      errors: counters.errors,
      notifiedUsers,
      dryRun: alignmentDryRun,
      alignmentPreviews: counters.alignmentPreviews,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Mintsoft stock sync failed'

    await completeJob(job.id, 'FAILED', counters, {
      externalWarehouseId: binding.externalWarehouseId,
      thresholdBreaches: 0,
      notifiedUsers: 0,
      dryRun: alignmentDryRun,
      alignmentCorrections: counters.corrected,
      alignmentPreviews: counters.alignmentPreviews,
    }, leaseToken)
    await updateBindingSyncStateIfCurrent(binding.id, 'FAILED', job.id, leaseToken)

    await logActivity({
      entityType: 'SYSTEM',
      tag: 'sync',
      action: 'mintsoft_stock_sync_failed',
      level: 'ERROR',
      description: `Mintsoft stock sync failed for ${binding.warehouse.code}: ${message}`,
      metadata: {
        bindingId: binding.id,
        warehouseId: binding.warehouseId,
        jobId: job.id,
      },
      resolveUser: false,
    })

    return {
      bindingId: binding.id,
      warehouseId: binding.warehouseId,
      warehouseCode: binding.warehouse.code,
      jobId: job.id,
      status: 'FAILED',
      totalChecked: counters.totalChecked,
      matched: counters.matched,
      mismatched: counters.mismatched,
      corrected: counters.corrected,
      skipped: counters.skipped,
      errors: counters.errors + 1,
      notifiedUsers: 0,
      dryRun: alignmentDryRun,
      alignmentPreviews: counters.alignmentPreviews,
      skippedReason: message,
    }
  }
}

export async function createMintsoftBindingHandover(
  bindingId: string,
  triggeredBy: string,
): Promise<string | null> {
  const binding = await getSyncBinding(bindingId)
  if (!binding) return null

  const [snapshotCount, discrepancyCount] = await Promise.all([
    db.wmsStockSnapshot.count({
      where: {
        connector: 'mintsoft',
        warehouseId: binding.warehouseId,
      },
    }),
    db.wmsStockDiscrepancy.count({
      where: {
        connector: 'mintsoft',
        warehouseId: binding.warehouseId,
        status: 'OPEN',
      },
    }),
  ])

  const job = await db.wmsSyncJob.create({
    data: {
      connector: 'mintsoft',
      type: 'STOCK_SYNC',
      status: 'SUCCEEDED',
      warehouseId: binding.warehouseId,
      startedAt: new Date(),
      finishedAt: new Date(),
      triggeredBy,
      summary: {
        handover: true,
        snapshotCount,
        openDiscrepancies: discrepancyCount,
      } satisfies Prisma.InputJsonObject,
    },
    select: { id: true },
  })

  await db.externalWmsBinding.update({
    where: { id: binding.id },
    data: {
      lastStockSyncAt: new Date(),
      // A handover records a successful STOCK_SYNC, so it is watchdog
      // freshness too (Codex r6): without these, leaving alignment mode kept
      // the old/null success anchor (immediate false stale alert) or carried
      // a stale stamp that suppressed later genuine breaches.
      lastStockSyncSuccessAt: new Date(),
      lastStockSyncStatus: 'SUCCEEDED',
      staleSyncAlertedAt: null,
    },
  })

  return job.id
}

export async function clearMintsoftAlignmentCreditsForBinding(bindingId: string): Promise<{
  success: boolean
  blockedLines: number
  error?: string
}> {
  const binding = await getSyncBinding(bindingId)
  if (!binding) {
    return {
      success: true,
      blockedLines: 0,
    }
  }

  const lines = await db.wmsAsnLineMap.findMany({
    where: {
      qtyAccountedViaSnapshot: { gt: 0 },
      asn: {
        connector: 'mintsoft',
        warehouseId: binding.warehouseId,
        closedAt: null,
      },
    },
    select: {
      id: true,
      sku: true,
      qtyAccountedViaSnapshot: true,
      qtyAccountedViaReceipt: true,
      asn: {
        select: {
          externalAsnId: true,
        },
      },
    },
  })

  const blockedLines = lines.filter((line) => (
    Number(line.qtyAccountedViaSnapshot) > Number(line.qtyAccountedViaReceipt) + 0.0001
  ))

  if (blockedLines.length > 0) {
    const example = blockedLines[0]
    return {
      success: false,
      blockedLines: blockedLines.length,
      error: `Cannot leave Align To WMS while ${blockedLines.length} ASN line${blockedLines.length === 1 ? '' : 's'} still depend on unreconciled alignment credits. Example: ${example?.sku ?? 'unknown SKU'} on ASN ${example?.asn.externalAsnId ?? 'unknown'} still has snapshot stock that has not been confirmed by webhook receipts.`,
    }
  }

  return {
    success: true,
    blockedLines: 0,
  }
}
