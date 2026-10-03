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
import { validatePurchaseOrderStatusTransition } from '@/lib/domain/workflows/action-guards'
import {
  derivePurchaseOrderReceiptStatus,
  isPurchaseOrderUsableForWmsReceipt,
  loadPurchaseOrderLineLandedQty,
  loadPurchaseOrderLineOutstandingQty,
  requirePoLineLandedQty,
  requirePoLineOutstandingQty,
  resolvePurchaseOrderLineResidualQty,
  type PurchaseOrderLineResidualQty,
} from '@/lib/domain/inventory/po-line-landed-quantity'
import {
  buildStockMovementValueFields,
  buildStockMovementValueFieldsFromTotal,
} from '@/lib/domain/inventory/stock-movement-value'
import {
  lockPurchaseOrdersWithCostRows,
  lockStockTransfers,
  lockWmsAsnLineMaps,
  lockWmsAsnMaps,
} from '@/lib/domain/wms/transfer-asn-lock-order'
import { addMoney, multiplyMoney, roundQuantity, toDecimal } from '@/lib/domain/math/decimal'
import { enqueueStockSync } from '@/lib/shopping'
// o3d-6nd55: the align-up path credits PO-backed stock and lays a FIFO cost layer, so it is a
// RECEIPT writer and owes the same journal, the same transit subledger row and — above all — the
// same COST DEFINITION as the other two (the manual receipt in app/actions/purchase-orders.ts and
// the WMS book-in in lib/domain/wms/booked-in-service.ts).
import {
  getAccountingSettingsFor,
  getActiveAccountingConnectorId,
  queueAccountingSyncTx,
  readStockReceiptAccountsTx,
  type StockReceiptAccounts,
} from '@/lib/accounting'
import { accountingPayloadKey } from '@/lib/accounting/payload-key'
import { recordTransitSubledgerMovement } from '@/lib/domain/accounting/transit-subledger-movement'
import {
  CONTRIBUTING_LANDED_COST_LINK_WHERE,
  computeGrossUnitCostBaseByLine,
} from '@/lib/domain/purchasing/landed-cost-service'
import { lockAccountingMappingSelection } from '@/lib/integration-plugin-selection-lock'

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

// Exported for tests/concurrency/po-landed-quantity.concurrent.test.ts (o3d-papk A8): it is the align-down
// receipt-timing guard and is otherwise reachable only through a sweep that calls the live Mintsoft API.
export async function detectReceiptTimingConflict(
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
        id: true,
        qty: true,
        qtyReceived: true,
        po: { select: { status: true } },
      },
    })
    if (!poLine) continue

    // o3d-papk: OUTSTANDING is `qty - LANDED` (alignment lands units without writing qtyReceived), and an
    // order that expects nothing more (CANCELLED, CLOSED) has none.
    const outstandingReceipt = requirePoLineOutstandingQty(
      await loadPurchaseOrderLineOutstandingQty(db, [{
        id: poLine.id,
        qty: poLine.qty,
        qtyReceived: poLine.qtyReceived,
        poStatus: poLine.po.status,
      }]),
      poLine.id,
    ).qtyNumber
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
  /**
   * Parent purchase-order id for a PURCHASE_ORDER_LINE candidate; null for a transfer line
   * (o3d-6nd55 r2). Carried on the candidate so the cost read can be taken under a lock on that
   * order's cost rows instead of discovering the parent from inside the allocation loop, which is
   * after every lock has been taken and too late to add one.
   */
  purchaseOrderId: string | null
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
   * Which kind of parent an `unusable` refusal is about, so the operator-facing status sentence names the
   * right one (o3d-papk). Absent means a transfer.
   */
  parent?: 'purchase_order'
  /**
   * `unusable` — the ASN line cannot be used at all (its transfer is gone or is not
   * in a status that may bring units to rest).
   * `capped` — it is usable, but for less than its outstanding quantity, because the
   * dispatch snapshot cannot cost the rest (Codex round-8 HIGH-1). The distinction
   * matters to the operator-facing reason: only the first is about transfer status.
   * `raced` — the row (or its parent) was committed after this transaction took its
   * locks, so nothing this pass could read about it is covered by a lock. Nothing is
   * wrong with it; it simply belongs to the next sweep (Codex round-10 HIGH-1).
   */
  kind: 'unusable' | 'capped' | 'raced'
}

/**
 * The rows this transaction actually HOLDS, handed to the re-read so it can refuse
 * everything else (6oyu.19, Codex round-10 HIGH-1).
 *
 * WHY THE RE-READ NEEDS THIS AT ALL. Locking is done from a discovery read, so the
 * lock set is a set of ids chosen before the locks existed. The re-read that follows
 * runs at READ COMMITTED against the whole table and therefore sees rows committed
 * in between — for which this transaction holds nothing. Acting on one is acting on
 * an unlocked row: a concurrent book-in can move its counters between this read and
 * the stock write below, and the same units get booked twice.
 */
type AlignmentLockSet = {
  /** `stock_transfers` rows held FOR UPDATE (step 2a of the global order). */
  transferIds: ReadonlySet<string>
  /**
   * `purchase_orders` rows held FOR UPDATE (step 2b), together with their
   * `purchase_order_lines` and `freight_cost_lines` (steps 2c/2d) — o3d-6nd55 r2.
   *
   * A PO-backed candidate whose parent is absent here is refused as `raced`, exactly as a
   * transfer-backed candidate whose parent transfer is absent is. The reason is the same and it is not
   * about status: the cost this path is about to turn into a cost layer and a journal is read from
   * that order's rows, so an order this transaction does not hold is an order whose costs are still
   * moving. Round 1 of this issue read them with no lock at all.
   */
  purchaseOrderIds: ReadonlySet<string>
  /**
   * `wms_asn_line_maps` rows held FOR UPDATE (step 4 of the global order).
   *
   * THIS IS DISCOVERY'S WHOLE ROW SET, NOT THE USABLE SLICE OF IT (6oyu.19, Codex
   * round-13 MEDIUM-1). The caller locks every row the discovery read RETURNED —
   * candidates and refused rows alike — so membership here answers one question and
   * only one: *did this row exist when the plan was discovered?* That is a fact about
   * row identity, it cannot change under this transaction, and it is exactly the
   * moved-versus-unusable distinction the `raced` refusal needs.
   *
   * WHY IT USED TO BE THE CANDIDATES ONLY, AND WHY THAT WAS A BUG. Rounds 10-12
   * locked `discovery.candidates`, so a row discovery had already REFUSED — almost
   * always a cancelled parent — was absent from this set for a reason that had
   * nothing to do with racing. The re-read then relabelled it `raced`, and round 11's
   * terminal guard rejected the whole plan on the strength of it. Nothing closes a
   * cancelled transfer's ASN, so that row never goes away: one cancelled transfer
   * beside a healthy candidate for the same SKU turned "defer this sweep" into
   * "defer for ever". Locking the refused rows too carries discovery's own refusal
   * forward — the row comes back through the re-read and is refused again, under a
   * lock, by the same stable predicate — instead of re-deriving a different answer
   * from its absence.
   */
  asnLineMapIds: ReadonlySet<string>
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
   * LINE SCOPE for purchase orders (o3d-papk): residue of every PO line the usable PO candidates draw from,
   * keyed by PO-line id; the planner's second cap for them, shared across the line's open ASN rows.
   */
  purchaseLineResiduals: Map<string, PurchaseOrderLineResidualQty>
  /**
   * Every parent transfer of every transfer-backed ASN row seen — INCLUDING the
   * refused ones — so the caller knows which `stock_transfers` rows to lock at step
   * 2. Refused ones are in deliberately: a status read before the lock is exactly
   * the fact the lock is being taken to settle, so filtering by it first would
   * choose the lock set from the answer the lock is meant to produce.
   */
  parentTransferIds: string[]
  /**
   * Every parent purchase order of every PO-backed ASN row seen — INCLUDING the refused ones, for the
   * same reason `parentTransferIds` includes them — so the caller can take steps 2b-2d before it
   * re-reads (o3d-6nd55 r2).
   */
  parentPurchaseOrderIds: string[]
  /**
   * Every FREIGHT purchase order linked to one of those parents, so steps 2c/2d cover the freight
   * cost lines too (o3d-6nd55 r2). A freight order's `freight_cost_lines` hang off the FREIGHT order,
   * so locking only the primary would leave half of `computeGrossUnitCostBaseByLine`'s inputs
   * unlocked.
   *
   * Collected through `CONTRIBUTING_LANDED_COST_LINK_WHERE`, the same predicate the cost read uses, so
   * the set of orders locked and the set of orders read are one decision. A CANCELLED freight order
   * contributes nothing, so it is neither read nor locked; what stops it being cancelled *after* this
   * read is the lock on the PRIMARY order's row, which cancellation updates.
   */
  linkedFreightPurchaseOrderIds: string[]
  /**
   * Every `wms_asn_maps` header the discovered rows sit on, so the caller can take
   * step 3 of the global lock order before it re-reads (6oyu.19, Codex round-11
   * MEDIUM-1). The `closedAt: null` predicate below is a fact about THIS row, and
   * three paths move it — see the header note above `getAlignmentCandidateLines`.
   * Refused rows are in for the same reason `parentTransferIds` includes them: a
   * status or a `closedAt` read BEFORE the lock is exactly what the lock settles.
   */
  asnMapIds: string[]
  /**
   * EVERY `wms_asn_line_maps` row this read returned — candidates AND refused rows —
   * in the order the query produced them, so the caller's step-4 lock can cover
   * discovery's whole row set (6oyu.19, Codex round-13 MEDIUM-1). See
   * `AlignmentLockSet.asnLineMapIds` for why the usable slice was the wrong set to
   * lock. Refused rows are in for the same reason `parentTransferIds` and
   * `asnMapIds` include them: the facts that refused them were read BEFORE the lock,
   * and re-reading them under one is the whole point of the second pass.
   */
  discoveredLineIds: string[]
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
 * `locks`, when supplied, is what this transaction HOLDS, and the read becomes a
 * re-read: it may return only rows this transaction can still be sure of.
 *
 *   · `asnLineMapIds` — the `wms_asn_line_maps` rows held FOR UPDATE. A row outside
 *     that set is refused however innocent it looks. It was committed after the
 *     locks were taken, so its counters are unlocked and a book-in may be moving
 *     them right now; planning against them books the same units twice (6oyu.19,
 *     Codex round-10 HIGH-1 — and round-8 HIGH-2, which said the same thing and was
 *     dropped when round 8 withdrew the whole locking layer instead of fixing it).
 *     This is the general form: it refuses a raced PURCHASE_ORDER-backed row, whose
 *     parent PO this path never locks, as readily as a transfer-backed one, and it
 *     needs no new lock to do it, so the global lock order is untouched.
 *   · `transferIds` — the `stock_transfers` rows held FOR UPDATE. A transfer-backed
 *     candidate whose parent is not in it is refused: its status could be changing
 *     underneath this read, and a cancellation that interleaves with an alignment is
 *     exactly the concurrent form of the same defect.
 *
 *     DEFENCE IN DEPTH, WITH NO CLAIM OF INDEPENDENT NECESSITY (6oyu.19, Codex
 *     round-11 LOW-1). Round 10's comment justified keeping this alongside the
 *     row-id check by saying a locked row `can be repointed by
 *     `createMintsoftTransferAsn` between the two reads`. THAT PATH DOES NOT EXIST.
 *     `createMintsoftTransferAsn` (app/actions/mintsoft-sync.ts:3900-3924) updates
 *     an existing `wms_asn_line_maps` row's `productId`, `sku` and `expectedQty`
 *     ONLY; lines that drop out are DELETED and replacements are CREATED with fresh
 *     cuids, which the row-id refusal above already catches. Verified, not recalled:
 *       $ grep -rn 'wmsAsnLineMap\.\(update\|updateMany\|upsert\)' --include=*.ts app lib
 *       → 9 sites (mintsoft-sync 2976/3299/3904/4227, stock-sync 1215,
 *         transfer-landed-quantity 280, booked-in-service 914/1158/1213); NOT ONE
 *         has `asnMapId` or `sourceLineId` in its `data:` payload, and there is no
 *         raw `UPDATE wms_asn_line_maps` anywhere. Both columns are write-once.
 *       $ grep -rn 'stockTransferLine\.\(update\|updateMany\|upsert\)' …
 *       → 4 sites (transfers 577/867/1062, booked-in-service 1137); none writes
 *         `transferId`. So a locked row's parent transfer is write-once too.
 *     What is left for this check is the one shape the id check cannot see: an ASN
 *     row whose `sourceLineId` did not RESOLVE at discovery (refused `unusable`, so
 *     its parent never entered the lock set) but resolves at the re-read. No current
 *     path creates a transfer line after the ASN row that references it, so this is
 *     a tripwire for a future one — kept because it costs a set lookup, NOT because
 *     anything today reaches it.
 *
 * WHY NOT LOCK THE MISSING PARENTS INSTEAD (the other half of the round-10 finding).
 * Locking `purchase_orders` here would be in-order and legal, but it would not close
 * this: a parent that does not exist at step 2 cannot be locked at step 2, so a row
 * created afterwards still arrives unlocked and the re-read still has to refuse it.
 * The refusal is therefore the whole fix for the RACED row and the parent lock would
 * be decoration — and every extra lock is contention plus a new pair to keep ordered.
 *
 * `wms_asn_maps` IS NOW LOCKED, AND ROUND 10'S REASON FOR NOT LOCKING IT WAS FALSE
 * (6oyu.19, Codex round-11 MEDIUM-1). That comment said `nothing in this codebase
 * ever sets closedAt, so the closedAt: null filter above cannot change under this
 * transaction`. It was asserted from memory and it was wrong the day it was written:
 *       $ grep -rn 'closedAt' --include=*.ts app lib | grep -v generated
 *       → THREE writers — lib/domain/wms/booked-in-service.ts:1208 (the webhook
 *         book-in closes the header once every line is fully processed), and both
 *         ASN finalizers, app/actions/mintsoft-sync.ts:3294 and :4222 (a Mintsoft
 *         ASN that comes back already BOOKED_IN is stamped closed on creation).
 * So the `closedAt: null` predicate IS mutable while this transaction runs, and the
 * candidate set was resting on an unlocked row. The header is therefore taken at
 * step 3 of the global order (`lockWmsAsnMaps`, between the step-2 parents and the
 * step-4 line rows) before the re-read, which is where the predicate is evaluated.
 * The three writers all take the header before the line rows too, so the added lock
 * introduces no new pair: booked-in-service locks 2→3→4→5, and both finalizers
 * `SELECT id FROM wms_asn_maps … FOR UPDATE` (3255, 4183) before updating their line
 * rows.
 *
 * NO HEADER CHECK ACCOMPANIES THE HEADER LOCK, and that is deliberate rather than an
 * oversight. `asnMapId` is write-once (the grep above), so a row that survives the
 * row-id refusal necessarily still points at the header this transaction locked — a
 * `locks.asnMapIds.has(line.asnMapId)` test could not fail, and a guard that cannot
 * fail proves nothing. The LOCK is the fix; a check would be scenery.
 */
async function getAlignmentCandidateLines(
  tx: Prisma.TransactionClient,
  binding: SyncBinding,
  productId: string,
  locks?: AlignmentLockSet,
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
      // The step-3 lock target (6oyu.19, Codex round-11 MEDIUM-1).
      asnMapId: true,
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

  // o3d-6nd55 r2: THE PO-BACKED PARENTS, resolved HERE because the caller has to lock them at step 2b
  // and this is the only read that happens before step 2. One query for the whole candidate set, the
  // mirror of the transfer query above. `linkedFreightPurchaseOrderIds` uses the SAME predicate the
  // cost read uses (CONTRIBUTING_LANDED_COST_LINK_WHERE), so the orders locked and the orders read are
  // one decision rather than two.
  const purchaseLineIds = [...new Set(lines
    .filter((line) => line.sourceType === 'PURCHASE_ORDER_LINE')
    .map((line) => line.sourceLineId))]
  const purchaseLines = purchaseLineIds.length === 0
    ? []
    : await tx.purchaseOrderLine.findMany({
      where: { id: { in: purchaseLineIds } },
      select: {
        id: true,
        poId: true,
        qty: true,
        qtyReceived: true,
        po: {
          select: {
            reference: true,
            status: true,
            landedCostLinks: {
              where: { ...CONTRIBUTING_LANDED_COST_LINK_WHERE },
              select: { freightPoId: true },
            },
          },
        },
      },
    })
  const purchaseOrderIdByLineId = new Map(purchaseLines.map((line) => [line.id, line.poId]))
  const parentPurchaseOrderIds = new Set<string>()
  const linkedFreightPurchaseOrderIds = new Set<string>()
  // o3d-6nd55 r6 (Codex round-6 HIGH): PER LINE, not just as one global set. The global set is what the
  // caller LOCKS; this map is what the re-read CHECKS against the locked set, and the two are different
  // questions. Discovery runs before the locks, so a freight order linked in between contributes cost
  // lines that no lock covers — and only a per-line answer can name which candidate to refuse.
  const contributingFreightByLineId = new Map<string, string[]>()
  for (const line of purchaseLines) {
    parentPurchaseOrderIds.add(line.poId)
    const freightIds = line.po.landedCostLinks.map((link) => link.freightPoId)
    contributingFreightByLineId.set(line.id, freightIds)
    for (const freightPoId of freightIds) linkedFreightPurchaseOrderIds.add(freightPoId)
  }
  // 6oyu.19 (Codex r6): capacity must count what has LANDED on the transfer line by
  // ANY route — a manual receipt moves stock_transfer_lines.qtyReceived and touches
  // neither ASN column. One query for the whole candidate set.
  const landedByTransferLineId = await loadTransferLineLandedQty(
    tx,
    transferLines.map((line) => ({ id: line.id, qtyReceived: line.qtyReceived })),
  )
  // o3d-papk: the same for PO lines. `qty - qtyReceived` is not the room a PO line has left, because the
  // alignment lands units without writing qtyReceived. Read on `tx`, in the re-read that runs under the
  // step-2b purchase_orders locks; EVERY ASN row of the line counts, closed ones included.
  const landedByPurchaseLineId = await loadPurchaseOrderLineLandedQty(
    tx,
    purchaseLines.map((line) => ({ id: line.id, qtyReceived: line.qtyReceived })),
  )
  const purchaseLineById = new Map(purchaseLines.map((line) => [line.id, line]))

  const candidates: AlignmentCandidateLine[] = []
  const transferLineResiduals = new Map<string, TransferLineResidualQty>()
  const purchaseLineResiduals = new Map<string, PurchaseOrderLineResidualQty>()
  const refused: RefusedAlignmentCandidate[] = []
  const parentTransferIds = new Set<string>()
  const asnMapIds = new Set<string>(lines.map((line) => line.asnMapId))

  for (const line of lines) {
    // FIRST, BEFORE ANY FACT ABOUT THIS ROW IS READ. Under the locks, a row this
    // transaction does not hold is a row whose every column is still moving. It is
    // refused whatever its source type, which is what makes a raced PURCHASE_ORDER
    // line — the case round 10 found, and the one no parent lock on this path would
    // have covered — refused by the same statement as a raced transfer line.
    //
    // AND IT NOW MEANS ONLY ONE THING (6oyu.19, Codex round-13 MEDIUM-1). The lock
    // set is discovery's ENTIRE row set, so this test is `!discovered(line)` — the
    // row was committed between the discovery read and the step-4 lock. It no longer
    // fires for a row discovery saw and refused; that row is locked, comes back
    // through this loop, and is refused below by the predicate that refused it the
    // first time, now evaluated under a lock. `raced` therefore means MOVED, and
    // `unusable` means UNUSABLE, which is what makes the terminal guard on `raced`
    // in `applyMintsoftAlignmentForProduct` a one-sweep deferral rather than a
    // permanent block.
    if (locks && !locks.asnLineMapIds.has(line.id)) {
      refused.push({
        asnLineMapId: line.id,
        externalAsnId: line.asn.externalAsnId,
        reason: 'the ASN line was created after this run took its row locks',
        kind: 'raced',
      })
      continue
    }

    const asnResidualQty = resolveWmsAsnLineResidualQty({
      asnLineMapId: line.id,
      expectedQty: line.expectedQty,
      qtyAccountedViaSnapshot: line.qtyAccountedViaSnapshot,
      lastProcessedReceivedQty: line.lastProcessedReceivedQty,
    })

    if (line.sourceType !== 'STOCK_TRANSFER_LINE') {
      // o3d-6nd55 r2: THE PO-BACKED MIRROR OF THE TRANSFER PARENT CHECK BELOW. A candidate whose
      // parent order this transaction does not hold is refused as `raced` rather than planned against,
      // because the cost that is about to become a cost layer and a STOCK_RECEIPT journal is read from
      // that order's rows. Locking it now would invert the global order (step 2 is behind us by the
      // time the re-read runs), so it waits for the next sweep — the same one-sweep deferral a raced
      // transfer gets.
      const purchaseOrderId = purchaseOrderIdByLineId.get(line.sourceLineId)
      if (!purchaseOrderId) {
        refused.push({
          asnLineMapId: line.id,
          externalAsnId: line.asn.externalAsnId,
          reason: `purchase order line ${line.sourceLineId} no longer exists`,
          kind: 'unusable',
        })
        continue
      }
      if (locks && !locks.purchaseOrderIds.has(purchaseOrderId)) {
        refused.push({
          asnLineMapId: line.id,
          externalAsnId: line.asn.externalAsnId,
          reason: 'its purchase order appeared after this run took its cost-row locks',
          kind: 'raced',
        })
        continue
      }
      // o3d-papk: A CANCELLED OR CLOSED ORDER EXPECTS NOTHING MORE, so units can no more be brought to rest
      // against it than against a cancelled transfer. Refused as `unusable` and NEVER as `raced`: nothing
      // closes a cancelled order's ASN, so a `raced` refusal (terminal for the whole plan) would block
      // align-up for every SKU on it for ever, which is the round-13 lesson transfers already carry. The
      // order is held (checked above), so its status is read under the lock.
      const purchaseLine = purchaseLineById.get(line.sourceLineId)
      if (purchaseLine && !isPurchaseOrderUsableForWmsReceipt(purchaseLine.po.status)) {
        refused.push({
          asnLineMapId: line.id,
          externalAsnId: line.asn.externalAsnId,
          reason: `purchase order ${purchaseLine.po.reference} is ${purchaseLine.po.status}`,
          kind: 'unusable',
          parent: 'purchase_order',
        })
        continue
      }
      // ─── EVERY CONTRIBUTING FREIGHT ORDER MUST BE HELD TOO (o3d-6nd55 r6, Codex round-6 HIGH) ───
      //
      // THE HOLE THIS CLOSES. Round 2 discovered the linked freight orders BEFORE the locks and locked
      // that set, and this re-read then checked only the PRIMARY order and the ASN rows against what was
      // locked. A freight order LINKED in the window between discovery and the parent lock therefore
      // contributed its cost lines to the valuation while neither its parent row nor its cost rows were
      // held — so an fx rebase of that freight order could commit while the alignment posted, leaving the
      // cost layer and the STOCK_RECEIPT journal valued at a cost that had already changed.
      //
      // REFUSE, DO NOT LOCK ON DEMAND. Acquiring a parent discovered at THIS point means taking a lock
      // after others are already held, which is how a lock order gets taken backwards — the defect rounds
      // 3 to 5 were entirely about. The candidate is refused as `raced`, the terminal guard in
      // `applyMintsoftAlignmentForProduct` ends the plan, and the next sweep discovers the freight order
      // up front and locks it with the rest. One sweep of deferral, no unlocked valuation.
      //
      // IT IS CHECKED HERE, BEFORE ANY COST IS READ OR ANYTHING IS POSTED: this re-read builds the
      // candidate set the plan is made from, and the cost pass runs after the plan.
      const contributingFreightPoIds = contributingFreightByLineId.get(line.sourceLineId) ?? []
      const unheldFreightPoIds = locks
        ? contributingFreightPoIds.filter((freightPoId) => !locks.purchaseOrderIds.has(freightPoId))
        : []
      if (unheldFreightPoIds.length > 0) {
        refused.push({
          asnLineMapId: line.id,
          externalAsnId: line.asn.externalAsnId,
          reason: `a freight order contributing to its cost (${unheldFreightPoIds.join(', ')}) was linked `
            + 'after this run took its cost-row locks',
          kind: 'raced',
        })
        continue
      }
      // o3d-papk: the LINE-scope cap, from the same landed reading the manual receipt uses. A line the
      // alignment or a receipt has already brought in offers no capacity however open its ASN rows look.
      // `purchaseLine` exists: `purchaseOrderIdByLineId` found it above.
      purchaseLineResiduals.set(
        line.sourceLineId,
        resolvePurchaseOrderLineResidualQty({
          lineQty: purchaseLine!.qty,
          landed: requirePoLineLandedQty(landedByPurchaseLineId, line.sourceLineId),
        }),
      )
      candidates.push({
        id: line.id,
        sourceType: 'PURCHASE_ORDER_LINE',
        sourceLineId: line.sourceLineId,
        productId: line.productId,
        sku: line.sku,
        asnResidualQty,
        transferId: null,
        purchaseOrderId,
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
    if (locks && !locks.transferIds.has(transferLine.transferId)) {
      refused.push({
        asnLineMapId: line.id,
        externalAsnId: line.asn.externalAsnId,
        reason: `transfer ${transferLine.transfer.reference} appeared after this run took its transfer locks`,
        kind: 'raced',
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
      purchaseOrderId: null,
      asn: line.asn,
    })
  }

  return {
    candidates,
    transferLineResiduals,
    purchaseLineResiduals,
    parentTransferIds: [...parentTransferIds],
    parentPurchaseOrderIds: [...parentPurchaseOrderIds],
    linkedFreightPurchaseOrderIds: [...linkedFreightPurchaseOrderIds],
    asnMapIds: [...asnMapIds],
    discoveredLineIds: lines.map((line) => line.id),
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
  const transferStatusNote = refused.some((entry) => entry.kind === 'unusable' && entry.parent !== 'purchase_order')
    ? ` Alignment only uses an ASN whose transfer is ${WMS_RECEIPT_USABLE_TRANSFER_STATUSES.join(' or ')}.`
    : ''
  const purchaseStatusNote = refused.some((entry) => entry.kind === 'unusable' && entry.parent === 'purchase_order')
    ? ' Alignment does not use an ASN whose purchase order is CANCELLED or CLOSED.'
    : ''
  const statusNote = `${transferStatusNote}${purchaseStatusNote}`
  // And a raced row is not a problem to go and look at — it is work deferred by one
  // sweep. Saying so keeps it out of the operator's defect pile (Codex round-10).
  const racedNote = refused.some((entry) => entry.kind === 'raced')
    ? ' Rows created after this run took its locks are left to the next sync rather than acted on unlocked.'
    : ''
  return ` Open ASN line${refused.length === 1 ? '' : 's'} skipped or capped: ${listed}${more}.${statusNote}${racedNote}`
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
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * o3d-6nd55: WHAT DID THESE UNITS COST — ONE DEFINITION, SHARED WITH THE OTHER TWO RECEIPTS.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE DEFECT THIS REPLACES was `Number(poLine.landedUnitCostBase ?? poLine.unitCostBase)`, read
 * inline in the align-up loop. `landedUnitCostBase` is `Decimal @db.Decimal(18, 6) @default(0)`
 * and NOT NULL (prisma/schema.prisma:1319), and `createPurchaseOrder` never writes it — so the
 * `??` could NEVER fall through. An ordinary purchase order aligned up at a unit cost of ZERO: a
 * zero-cost FIFO layer and a zero-value stock movement for goods that cost real money. That is a
 * live inventory-value defect on its own, independent of any journal: a wrong cost layer is wrong
 * stock value, and no journal repairs it. It also bears on the switchover, where the `[firstload]`
 * reconciliation compares IMS inventory valuation against Qoblex within ±£1 per warehouse — a
 * zero-cost layer fails that in a way that reads as a migration error rather than a product
 * defect.
 *
 * WHY THE GROSS COST, AND WHY THE SHARED HELPER. `computeGrossUnitCostBaseByLine` is what the
 * MANUAL receipt uses (app/actions/purchase-orders.ts:1881) and what the WMS book-in was changed
 * to use (o3d-8f0p6): goods `unitCostBase` plus this line's share of the PO's own and its linked
 * freight POs' cost lines. It does not read `landedUnitCostBase` at all. Routing the third writer
 * through it means all three answer this question with ONE definition rather than three, and it is
 * never worse than the old expression — once landed cost HAS been allocated the recalc writes
 * `landedUnitCostBase = grossUnitCostBase` (landed-cost-service.ts:1159, :1514) so the two
 * coincide, and before allocation the old expression was simply 0.
 *
 * SO THERE IS NO NULL-VS-ZERO QUESTION AND NO MIGRATION. The column keeps its NOT NULL zero
 * default, because receipt time stops reading it. A GENUINELY free line — a free-of-charge sample,
 * a warranty replacement — has `unitCostBase` 0 and no freight share, so the gross cost is 0, no
 * value enters inventory and nothing is posted. That is correct, and it is distinguishable from
 * the defect, which had a POSITIVE goods cost and still produced 0.
 *
 * WHY THE WHOLE PURCHASE ORDER IS LOADED for one line: freight distribution is a property of the
 * ORDER (`BY_VALUE`, `BY_QTY`, `BY_WEIGHT` all divide one amount across every eligible line), so a
 * line's share cannot be computed from the line alone. The align-up loop had the PO LINE in hand
 * and not the PO, which is why it could not have used this helper without this widening.
 *
 * WHAT MAKES THE CACHE SAFE, AND IT IS NOT THE TRANSACTION (o3d-6nd55 r2, Codex round-2 HIGH-2).
 * Round 1's version of this paragraph said the inputs "cannot move — everything is inside the
 * transaction". That was wrong, and it is the exact shape of error this repository keeps recording: a
 * transaction gives a caller ISOLATION from uncommitted work, not exclusion of committed work, so
 * under READ COMMITTED a landed-cost change committing mid-loop was visible to the next read and the
 * first allocation's cached cost and the second allocation's fresh cost could differ inside one
 * alignment. What makes it safe is the LOCK: `applyMintsoftAlignmentForProduct` takes
 * `lockPurchaseOrders` then `lockPurchaseOrderCostRows` over the primary and linked freight orders at
 * step 2, BEFORE this function runs, so the rows this reads cannot be updated until the alignment
 * commits. The cache is then a saved query, not a correctness claim — and every cost is read in ONE
 * up-front pass before any movement, layer, journal or stock row is written, so there is no window
 * between "what these units cost" and "what was posted for them" even to reason about.
 */
type AlignmentPurchaseLineCost = {
  poId: string
  poReference: string
  productId: string
  /** Goods `unitCostBase` alone, kept only so the fallback below can be seen to be a fallback. */
  goodsUnitCostBase: number
  /** THE value: goods plus this line's freight share. Movement, layer and journal all use it. */
  grossUnitCostBase: number
}

/**
 * THE ONE CASE THE RE-READ CANNOT SETTLE (o3d-6nd55 r2), mirroring `assertParentsWereLocked` in
 * lib/domain/wms/transfer-asn-lock-order.ts.
 *
 * `getAlignmentCandidateLines` refuses a PO-backed candidate whose parent order is not in the locked
 * set, so by the time a candidate reaches the cost pass its parent IS held. This asserts that rather
 * than assuming it: if the two ever drift apart, the failure mode without this line is a cost read
 * from an unlocked order — silently the exact defect round 2 found — instead of a loud abort before
 * any stock moves.
 */
function assertPurchaseOrderWasLocked(
  candidate: AlignmentCandidateLine,
  lockedPurchaseOrderIds: ReadonlySet<string>,
): void {
  if (!candidate.purchaseOrderId || !lockedPurchaseOrderIds.has(candidate.purchaseOrderId)) {
    throw new Error(
      `Alignment reached the cost read for ASN line ${candidate.id} without holding its purchase order `
      + `(${candidate.purchaseOrderId ?? 'unknown'}). Refusing rather than reading a cost this `
      + 'transaction does not hold (o3d-6nd55).',
    )
  }
}

async function loadAlignmentPurchaseLineCost(
  tx: Prisma.TransactionClient,
  poLineId: string,
  cache: Map<string, AlignmentPurchaseLineCost>,
): Promise<AlignmentPurchaseLineCost> {
  const cached = cache.get(poLineId)
  if (cached) return cached

  const poLine = await tx.purchaseOrderLine.findUnique({
    where: { id: poLineId },
    select: {
      id: true,
      productId: true,
      unitCostBase: true,
      po: {
        select: {
          id: true,
          reference: true,
          lines: {
            select: {
              id: true,
              productId: true,
              qty: true,
              unitCostBase: true,
              totalBase: true,
              landedUnitCostBase: true,
              product: { select: { weight: true } },
            },
          },
          freightCostLines: {
            select: { amountBase: true, distributionMethod: true },
          },
          landedCostLinks: {
            // o3d-6nd55 r2 (Codex round-2 HIGH-1): a CANCELLED freight order must NOT contribute.
            // Round 1 selected every link, so cancelling a freight order — which leaves the link row
            // in place, marks the freight order CANCELLED and the link unallocated — still fed its
            // cost lines into this layer, this movement and this journal, overstating inventory by
            // freight the business had cancelled and disagreeing with what landed-cost recalculation
            // computes for the very same units. The predicate is not written out here: it is
            // CONTRIBUTING_LANDED_COST_LINK_WHERE, the one both recalc paths use
            // (landed-cost-service.ts audit-C3 and audit-izrf), so a fourth reader cannot invent a
            // fourth answer.
            where: { ...CONTRIBUTING_LANDED_COST_LINK_WHERE },
            select: {
              freightPO: {
                select: {
                  freightCostLines: {
                    select: { amountBase: true, distributionMethod: true },
                  },
                },
              },
            },
          },
        },
      },
    },
  })
  if (!poLine) {
    throw new Error(`Purchase order line ${poLineId} is missing for alignment.`)
  }

  const grossByLine = computeGrossUnitCostBaseByLine({
    lines: poLine.po.lines.map((line) => ({
      id: line.id,
      qty: line.qty,
      unitCostBase: line.unitCostBase,
      totalBase: line.totalBase,
      landedUnitCostBase: line.landedUnitCostBase,
      weight: line.product?.weight ?? null,
    })),
    directCostLines: poLine.po.freightCostLines.map((costLine) => ({
      amountBase: costLine.amountBase,
      distributionMethod: costLine.distributionMethod,
    })),
    linkedCostLines: poLine.po.landedCostLinks.flatMap((link) => (
      link.freightPO.freightCostLines.map((costLine) => ({
        amountBase: costLine.amountBase,
        distributionMethod: costLine.distributionMethod,
      }))
    )),
  })

  // Every line of the order is cached, not just the one asked for: the helper computed them all,
  // and a sibling allocation in this same sweep would otherwise re-read the order to get a number
  // that is already in hand.
  let requested: AlignmentPurchaseLineCost | null = null
  for (const line of poLine.po.lines) {
    const entry: AlignmentPurchaseLineCost = {
      poId: poLine.po.id,
      poReference: poLine.po.reference,
      productId: line.productId,
      goodsUnitCostBase: Number(line.unitCostBase),
      // The fallback is the GOODS cost, reached only when the helper declined the line — it skips a
      // line whose `qty` is not greater than zero, and such a line cannot be the subject of an
      // alignment allocation of positive quantity. It is deliberately NOT `landedUnitCostBase`.
      grossUnitCostBase: grossByLine.get(line.id) ?? Number(line.unitCostBase),
    }
    cache.set(line.id, entry)
    if (line.id === poLine.id) requested = entry
  }
  if (!requested) {
    throw new Error(`Purchase order line ${poLineId} is not a line of its own purchase order ${poLine.po.id}.`)
  }
  return requested
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
  /**
   * The IMS on-hand quantity `delta` was computed FROM — `stock_levels.quantity`
   * for this product and the binding's warehouse, as the sweep read it before this
   * call (6oyu.19, Codex round-12 HIGH-1).
   *
   * REQUIRED, and deliberately not defaulted. `delta` alone cannot be checked for
   * staleness: it is a difference, and a difference does not say what it was a
   * difference FROM. A caller that cannot name the basis cannot be told whether its
   * delta still holds, so it may not use this function. `applyMintsoftAlignDownForProduct`
   * has taken the same pair since it was written.
   */
  imsQty: number
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
  // o3d-6nd55: WHICH LEDGER a PO-backed allocation would post to, and whether it posts at all.
  // Resolved ONCE, here, and carried into the transaction as a PIN — `queueAccountingSyncTx` re-asks
  // under the plugin-selection lock and refuses outright if this connector stopped being the
  // serviced one, so a row can never be written against a ledger this decision was not about.
  //
  // THE ACCOUNT CODES ARE DELIBERATELY NOT TAKEN FROM HERE: they are read inside the transaction and
  // asserted again after the enqueue, for the reason spelled out at the enqueue. `syncEnabled` is
  // read here because it only decides whether to do any of this at all, and a flip of THAT is
  // answered by the enqueue's own fence.
  //
  // A DRY RUN pays these two pooled reads and uses neither. That is the cost of resolving the pin
  // before the transaction opens, which is what o3d-8f0p6 established for the book-in; a dry run is
  // an operator-triggered preview, not a sweep hot path.
  const accountingConnector = await getActiveAccountingConnectorId()
  const accountingSettings = await getAccountingSettingsFor(accountingConnector)

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

    // STEP 2, then STEP 3, then STEP 4 — never any other way about.
    //
    // STEP 3 IS HERE BECAUSE ROUND 10'S REASON FOR SKIPPING IT WAS FALSE (6oyu.19,
    // Codex round-11 MEDIUM-1). The candidate query selects on `asn.closedAt IS
    // NULL`; round 10 left the header unlocked on the written claim that nothing in
    // the codebase ever sets `closedAt`. Three paths do — booked-in-service.ts:1208
    // and the two ASN finalizers at mintsoft-sync.ts:3294 and :4222 — so the
    // predicate the plan rests on was a fact about a row this transaction did not
    // hold. It holds it now, from before the re-read that evaluates the predicate
    // until commit.
    const lockedTransferIds = new Set(await lockStockTransfers(tx, discovery.parentTransferIds))
    // STEPS 2b, 2c AND 2d — the PO-backed parents and their COST ROWS (o3d-6nd55 r2, Codex round-2
    // HIGH-2). Round 1 read `purchase_order_lines` and `freight_cost_lines` inside the allocation
    // loop with no lock at all, and cached the result for the rest of the transaction: a landed-cost
    // change committing while the loop ran left later allocations on the older cost, and the
    // concurrent recalculation could not revalue layers this transaction had not committed yet. The
    // rows locked here are exactly `computeGrossUnitCostBaseByLine`'s inputs, the primary orders' and
    // the linked freight orders' alike, in the sub-order
    // app/actions/purchase-orders.ts:2919-2921 already uses.
    // ONE call, so the parent-then-children order is not this caller's to get right (o3d-6nd55 r3).
    const lockedPurchaseOrderIds = new Set(await lockPurchaseOrdersWithCostRows(tx, [
      ...discovery.parentPurchaseOrderIds,
      ...discovery.linkedFreightPurchaseOrderIds,
    ]))
    await lockWmsAsnMaps(tx, discovery.asnMapIds)
    // STEP 4 COVERS EVERY ROW DISCOVERY SAW, NOT JUST THE USABLE ONES (6oyu.19,
    // Codex round-13 MEDIUM-1). Rounds 10-12 locked `discovery.candidates`, and the
    // re-read below reads `!locks.asnLineMapIds.has(id)` as "this row raced in".
    // Those two statements only agree if the unlocked rows are the new ones — and
    // they were not: a row discovery REFUSED, chiefly for a cancelled parent, was
    // also absent, so the re-read relabelled a stable refusal as a race and round
    // 11's terminal guard threw the whole plan away. Nothing closes a cancelled
    // transfer's ASN (proved in
    // tests/concurrency/mintsoft-alignment-cancelled-transfer.concurrent.test.ts),
    // so that row is there again next sweep and every sweep after: one cancelled
    // transfer permanently blocked align-up for its SKU.
    //
    // Locking discovery's whole row set is the smallest change that makes the two
    // statements agree, and it is in-order: same table, same step, more ids, taken
    // ascending by `lockWmsAsnLineMaps`, and every transfer-backed row's parent is
    // already in `parentTransferIds` (which has always included the refused ones) so
    // step 2 already covered them.
    const lockedAsnLineMapIds = new Set(
      await lockWmsAsnLineMaps(tx, discovery.discoveredLineIds),
    )

    // Read again UNDER the locks, AND ONLY WITHIN THEM. Every fact the plan rests on
    // — each parent transfer's status, each ASN row's counters — is now covered by a
    // lock this transaction holds until it commits, because a row the locks do not
    // cover is refused rather than planned against.
    //
    // ROUND 8 FOUND THIS AND ROUND 8 LOST IT. Its HIGH-2 said this re-read was not
    // restricted to the locked ids; the response was to withdraw the entire locking
    // layer for an unrelated deadlock cycle, and when round 9 fixed the cycle and put
    // the locks back, the unrestricted re-read came back with them. A withdrawn layer
    // takes its open findings with it — this is the one that had to travel.
    const candidateSet = await getAlignmentCandidateLines(tx, params.binding, params.productId, {
      transferIds: lockedTransferIds,
      purchaseOrderIds: lockedPurchaseOrderIds,
      asnLineMapIds: lockedAsnLineMapIds,
    })
    const candidates = candidateSet.candidates

    if (candidates.length === 0) {
      return {
        kind: 'unavailable' as const,
        correctedQty: 0,
        reason: `No open ASN line is available to absorb this WMS delta.${describeRefusedAlignmentCandidates(candidateSet.refused)}`,
      }
    }

    // A RACED ROW ENDS THIS PLAN (6oyu.19, Codex round-10 HIGH-1; demoted to defence
    // in depth at round 12, and PARTLY RESTORED at round 13 — see the two paragraphs
    // headed WHY THE REFUSAL STAYS ANYWAY and WHAT MUTATION D ACTUALLY ESTABLISHED,
    // which correct round 12's claim that the stock comparison below covers
    // everything this does).
    //
    // WHAT THIS CHECK WAS FOR, AND WHY THAT REASON IS NO LONGER ITS OWN. Round 10
    // built the refusal and consulted it on one branch only — to EXPLAIN an
    // incomplete plan — so a raced row was dropped without a word whenever the locked
    // rows happened to cover the whole delta. Round 11 made it terminal and argued
    // for it like this: `params.delta` is `wmsQty - imsQty` computed from a stock
    // read taken before this transaction began, a raced ASN row means an inbound
    // receipt committed after that read, and a receipt raises
    // `stock_levels.quantity` as it lands — so the delta is stale and must not be
    // applied.
    //
    // That argument is about THE STOCK MOVING. A new ASN row is one way to notice it.
    // It is not the only way, and this check only ever saw that one: a receipt against
    // an ASN line that already existed moves the stock while every candidate stays
    // locked and no `raced` entry is produced. The general form of round 11's own
    // argument is the comparison under the stock lock further down — locked quantity
    // against `params.imsQty` — which catches BOTH shapes and over a wider window.
    // That check is now the one carrying the stale-delta claim.
    //
    // HOW FAR THE SUBSUMPTION GOES, MEASURED RATHER THAN ASSERTED. Disabling this
    // refusal (`if (false && racedRefusals.length > 0)`) and running
    // tests/concurrency/transfer-asn-lock-order.concurrent.test.ts leaves BOTH raced
    // proofs still refusing and still posting ten units and £50 — the r10 arm passes
    // outright, and the r11 full-capacity arm fails on its refusal WORDING alone
    // (`/measured before an ASN line committed under this run/` against `IMS stock
    // moved during the sync run (0 → 10)…`). On THOSE TWO ROUTES the stock comparison
    // is what makes them safe and this check owns only the sentence. Read no further
    // than that: both are races that also move stock, so the measurement says nothing
    // about a race that does not — and one of those exists, immediately below.
    //
    // WHY THE REFUSAL STAYS ANYWAY — AND THE ROUND-12 VERSION OF THIS PARAGRAPH WAS
    // WRONG ABOUT WHY (6oyu.19, Codex round-13 LOW-1). It said the one shape the
    // stock comparison cannot see is a raced row that arrived WITHOUT moving
    // destination stock, and then that "no path reaches that today". A PATH REACHES
    // IT. ASN creation commits new `wms_asn_line_maps` rows and moves no stock while
    // doing it — grepped this round rather than recalled, because that claim was the
    // fourth premise on this branch asserted from memory:
    //       $ grep -n 'wmsAsnLineMap\.\(create\|createMany\|upsert\)' app/actions/mintsoft-sync.ts
    //       → 2985 (PO ASN) and 3913 (transfer ASN), the per-line creates on the
    //         reconcile-pending path; the first ASN of each kind is created with its
    //         lines nested inside `wmsAsnMap.create` at 3073 and 4001.
    //       $ grep -c 'stockLevel' app/actions/mintsoft-sync.ts
    //       → 0. The whole file never touches a `stock_levels` row, so neither
    //         creation transaction can move the quantity the comparison below reads.
    // So a raced row that moves no stock is reachable, the stock comparison cannot
    // see it, and this check is the only thing that does.
    //
    // WHAT MUTATION D ACTUALLY ESTABLISHED, stated no wider than the measurement.
    // Disabling this refusal left both raced proofs refusing, which says: ON THE
    // ROUTES THOSE TWO PROOFS STAGE, the stock comparison is what refuses. It does
    // NOT say those are the only routes — both proofs stage a race that also moves
    // stock, so they could not have exercised the shape above even if it were open.
    // The subsumption is over the staged routes, not over the space of races.
    //
    // So this check is kept on its own merits, not as scenery: it fires before the
    // planner, it names the ASN rows for the operator, and it covers a race the
    // quantity comparison is blind to. If it is ever removed, the stock comparison
    // below is what must not be — and the reverse now holds too.
    //
    // TERMINAL COSTS ONE SWEEP, AND ONLY BECAUSE `raced` NOW MEANS MOVED (6oyu.19,
    // Codex round-13 MEDIUM-1). Round 11 made this rejection terminal on the
    // argument that a raced row means the world moved. It did — but the set it
    // rejected on was not only moved rows. The step-4 lock covered
    // `discovery.candidates`, so a row discovery had REFUSED for a stable reason —
    // a cancelled parent, overwhelmingly — was unlocked too, and the re-read
    // relabelled it `raced`. Nothing closes a cancelled transfer's ASN, so the
    // deferral had no next sweep to be deferred to: one cancelled transfer beside a
    // healthy candidate for the same SKU blocked align-up for that SKU for ever.
    // The lock now covers discovery's whole row set (see the step-4 call above), so
    // a refused row is re-refused as `unusable` and this guard sees only rows that
    // genuinely arrived in the window. Both halves are proved in
    // tests/concurrency/mintsoft-alignment-cancelled-transfer.concurrent.test.ts —
    // the mixed world aligns and keeps aligning, and a genuinely raced row is still
    // terminal in
    // tests/concurrency/transfer-asn-lock-order.concurrent.test.ts.
    //
    // REFUSE, RATHER THAN RE-PLAN UNDER THE LOCKS. Re-planning would fix the
    // candidate set and not the input: the delta itself is the stale number, and it
    // cannot be recomputed here without re-reading Mintsoft, which is above this
    // seam and outside the transaction. Locking the raced row instead is also not
    // open — its parent may sit at step 2 while this transaction is already past it,
    // which is the inversion the global order exists to prevent. The next sweep
    // recomputes the delta from the settled stock level and the work is not lost; it
    // is deferred by one pass, which is what `kind: 'raced'` has always meant.
    const racedRefusals = candidateSet.refused.filter((entry) => entry.kind === 'raced')
    if (racedRefusals.length > 0) {
      return {
        kind: 'unavailable' as const,
        correctedQty: 0,
        reason: `This product's WMS delta was measured before ${racedRefusals.length === 1 ? 'an ASN line' : `${racedRefusals.length} ASN lines`} `
          + 'committed under this run, so the delta may already have been settled by a receipt this run cannot see; '
          + `leaving stock unchanged.${describeRefusedAlignmentCandidates(candidateSet.refused)}`,
      }
    }

    const plan = planMintsoftAlignmentAllocations({
      delta: params.delta,
      candidates: candidates.map((candidate) => ({
        asnLineMapId: candidate.id,
        asnResidualQty: candidate.asnResidualQty,
        transferLineId: candidate.sourceType === 'STOCK_TRANSFER_LINE' ? candidate.sourceLineId : null,
        purchaseLineId: candidate.sourceType === 'PURCHASE_ORDER_LINE' ? candidate.sourceLineId : null,
        sortAt: candidate.asn.createdAt,
        sortId: candidate.id,
      })),
      transferLineResiduals: candidateSet.transferLineResiduals,
      purchaseLineResiduals: candidateSet.purchaseLineResiduals,
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

    // THE DELTA IS ONLY GOOD WHILE THE QUANTITY IT WAS MEASURED FROM STILL STANDS
    // (6oyu.19, Codex round-12 HIGH-1).
    //
    // `params.delta` is `wmsQty - imsQty`, and `params.imsQty` is the IMS side of
    // that subtraction, read by `runStockSyncForBinding` below before this
    // transaction existed. Everything between that read and this line is outside every lock this
    // function takes, and a receipt landing in that window raises
    // `stock_levels.quantity` — so the shortfall the delta describes has already been
    // closed, in part or in whole, by units this plan cannot see. Applying it anyway
    // lays a second set of layers for the same units.
    //
    // WHY THE RACED-ROW REFUSAL BELOW IS NOT THIS CHECK, though round 11 wrote it as
    // if it were. Its argument was about the STOCK MOVING — "a receipt raises
    // stock_levels.quantity as it lands" — but its trigger is a new ASN LINE
    // appearing. A new line is one way a receipt announces itself and it is not the
    // only one: a receipt against an ASN line that ALREADY EXISTED, and which this
    // transaction therefore discovered and locked, moves the stock and leaves the
    // candidate set untouched. Every row is locked, no `raced` entry exists, and the
    // plan proceeds on the stale delta. Round 11 reached half of its own conclusion.
    //
    // THE GENERAL FORM IS THE QUANTITY ITSELF, and it is already in hand: the stock
    // row is locked here, the locked read returns the current quantity, and comparing
    // it with the basis costs one comparison. It subsumes the raced-row case (a raced
    // row that mattered moved the stock) and the case Codex found (stock moved with no
    // raced row), and its window is the WIDER one — from the sweep's read to this
    // lock, rather than from discovery to the locks.
    //
    // REFUSE, DO NOT RE-DERIVE. The delta cannot be recomputed here: `wmsQty` comes
    // from the Mintsoft API, above this seam and outside the transaction. The next
    // sweep measures both sides afresh and the work is deferred by one pass, not lost.
    //
    // `applyMintsoftAlignDownForProduct` has made exactly this check since it was
    // written (see its transaction below). Align-up simply never did.
    //
    // THE DRY RUN RETURNS ABOVE THIS AND IS NOT CHECKED, deliberately. It writes
    // nothing, so there is nothing to double-count; its preview can be stale by the
    // same window and an operator reading a preview is not committing to it. Taking a
    // `FOR UPDATE` on the stock row to sharpen a report would put lock contention on
    // a read-only path. Align-down's dry run returns before its transaction for the
    // same reason.
    if (stockLevel.quantity !== params.imsQty) {
      return {
        kind: 'unavailable' as const,
        correctedQty: 0,
        reason: `IMS stock moved during the sync run (${formatQuantity(params.imsQty)} → ${formatQuantity(stockLevel.quantity)}), `
          + `so the ${formatQuantity(params.delta)} delta measured against it may already have been settled; `
          + 'leaving stock unchanged.',
      }
    }

    // o3d-6nd55: ONE clock for the whole alignment. The journal date must not drift between two
    // allocations of one sweep — they are one unit of work and belong to one GL day.
    const now = new Date()

    // ─── EVERY COST, READ UP FRONT, UNDER THE STEP-2 LOCKS, BEFORE ANYTHING IS WRITTEN ───
    //
    // o3d-6nd55 r2 (Codex round-2 HIGH-2). Round 1 read each allocation's cost inside the loop below,
    // interleaved with the movement, layer and stock writes it fed. Two things were wrong with that,
    // and the lock fixes one while this pass fixes the other:
    //   · the rows were unlocked, so a landed-cost change could commit mid-loop — closed by
    //     `lockPurchaseOrders` + `lockPurchaseOrderCostRows` at step 2;
    //   · even locked, reading interleaved with writing leaves the ORDER of the two as the thing a
    //     reader has to verify. Reading every cost first makes "the cost that was posted is the cost
    //     that was read" true by construction rather than by inspection, and it is the shape the
    //     manual receipt already has (app/actions/purchase-orders.ts computes
    //     `grossUnitCostBaseByLine` for the whole order before its receipt loop).
    // It also fails EARLY: a missing purchase-order line aborts before any stock has been credited.
    const purchaseLineCostCache = new Map<string, AlignmentPurchaseLineCost>()
    const costByAsnLineMapId = new Map<string, AlignmentPurchaseLineCost>()
    for (const allocation of plan.allocations) {
      const candidate = candidateById.get(allocation.asnLineMapId)
      if (!candidate) {
        throw new Error(`Missing ASN line ${allocation.asnLineMapId} during alignment.`)
      }
      if (candidate.sourceType !== 'PURCHASE_ORDER_LINE') continue
      // The parent is in the locked set — `getAlignmentCandidateLines` refused the candidate
      // otherwise — so this read is covered by steps 2b-2d for the rest of this transaction.
      assertPurchaseOrderWasLocked(candidate, lockedPurchaseOrderIds)
      costByAsnLineMapId.set(
        candidate.id,
        await loadAlignmentPurchaseLineCost(tx, candidate.sourceLineId, purchaseLineCostCache),
      )
    }

    // ─── THE ACCOUNT MAPPING, LOCKED ONCE FOR THE WHOLE ALIGNMENT (o3d-6nd55 r2) ───
    //
    // ADOPTED FROM o3d-8f0p6 r4, NOT REINVENTED, and the key names are not copied: they live once in
    // `ACCOUNTING_MAPPING_SETTING_KEYS` inside the lock module, which `readStockReceiptAccountsTx`
    // derives from, because a lock that names different rows from its reader is not a lock.
    //
    // WHAT ROUND 1 GOT WRONG HERE (Codex round-2 HIGH-3). It read the codes inside the transaction and
    // re-read them after the enqueue, refusing on a difference. That re-read holds NOTHING: under READ
    // COMMITTED it sees a remap that had already committed, but a remap committing AFTER it — while
    // this transaction walks on through the remaining allocations, the stock-level updates and the ASN
    // updates — still ends with a journal committed on stale codes. Refusal was the wrong instrument;
    // the fix is a lock held to COMMIT, and it is the SAME advisory key `queueAccountingSyncTx`
    // already takes through `pinnedLedgerIsServicedUnderLock`, with the two mapping rows added to its
    // row set. One lock, one order, and the enqueue's later acquisition is a no-op re-entry.
    //
    // MEMOISED, so an alignment spanning several purchase orders cannot straddle a remap and put
    // earlier orders on the old mapping and later ones on the new one: whichever allocation first
    // needs the codes takes the lock and reads them, and every later one reuses that answer. LAZY, so
    // an alignment that posts nothing — a transfer-only plan, or a genuinely free line — takes no
    // accounting lock at all.
    let lockedAccounts: StockReceiptAccounts | null = null
    const accountsForPosting = async (connector: NonNullable<typeof accountingConnector>) => {
      if (!lockedAccounts) {
        await lockAccountingMappingSelection(tx, connector)
        lockedAccounts = await readStockReceiptAccountsTx(tx, connector)
      }
      return lockedAccounts
    }

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
        // o3d-6nd55: ONE value, read once, used by all three consumers below — the movement's value
        // fields, the cost layer's `unitCostBase` and the journal's amount. Three consumers
        // disagreeing about the cost of the same units would be a worse defect than the missing
        // journal. See `loadAlignmentPurchaseLineCost` for why this is the gross cost and why the
        // `landedUnitCostBase ?? unitCostBase` expression it replaces could never be anything but 0.
        // Read in the up-front pass above, under the step-2 cost-row locks, before anything was
        // written — NOT here. See that pass for why the order of the two matters.
        const purchaseCost = costByAsnLineMapId.get(candidate.id)
        if (!purchaseCost) {
          throw new Error(
            `Alignment has no pre-read cost for ASN line ${candidate.id}. The cost pass and the `
            + 'allocation loop must walk the same plan (o3d-6nd55).',
          )
        }
        const unitCostBase = purchaseCost.grossUnitCostBase
        await tx.stockMovement.update({
          where: { id: movement.id },
          data: buildStockMovementValueFields({ qty: allocation.qty, unitCostBase }),
        })

        await createCostLayer(tx, {
          productId: purchaseCost.productId,
          warehouseId: params.binding.warehouseId,
          qty: allocation.qty,
          unitCostBase,
          poLineId: candidate.sourceLineId,
          adjustmentMovementId: movement.id,
        })

        // ─── o3d-6nd55: THE RECEIPT JOURNAL, IN THE SAME TRANSACTION AS THE STOCK ───
        //
        // THE DEFECT THIS CLOSES. This path is the THIRD writer of inventory value from a purchase
        // order, and it queued NOTHING: no STOCK_RECEIPT journal and no transit subledger row.
        // `grep -n 'queueAccountingSync|STOCK_RECEIPT|recordTransitSubledger'` over this file
        // returned nothing at all. The manual receipt (app/actions/purchase-orders.ts:2064-2095) and
        // — since o3d-8f0p6 — the WMS book-in (lib/domain/wms/booked-in-service.ts) both post, so
        // the same physical arrival produced different books depending on the route it took. On the
        // live 3PL route this is not an edge: alignment snapshot credits are how an upward
        // Mintsoft/IMS delta is absorbed into an open ASN line (docs/mintsoft.md), i.e. a normal way
        // for purchased units to arrive.
        //
        // WHY NOTHING PICKS IT UP LATER, established for o3d-8f0p6 and unchanged here: the Xero
        // daily batch does not read `stock_movements` at all; its inventory reconciliation posts
        // Inventory ↔ Rounding difference and ONLY for an `action === 'sweep'` gap
        // (account-gl-reconciliation.ts:102 returns null otherwise, and the limit is 1 unit so a
        // receipt-sized gap is `flag` — surfaced, never posted); and the transit reconciliation
        // aggregates `transit_subledger_movements`, which are written AT POST TIME, so a posting
        // that never happened is absent from BOTH sides and the window TIES OUT EXACTLY. That last
        // point is why shipping o3d-8f0p6 alone did not make the transit account auditable: the
        // reconciliation that should have caught this hid it (the trap written down at
        // lib/domain/inventory/movement-cogs-relevance.ts:291-295).
        //
        // AND WHY INSIDE THE TRANSACTION. Stock and layers commit here; a journal queued after the
        // commit, or best-effort around it, is the same defect in a new costume — inventory value
        // raised with the ledger not told. Both live or neither.
        //
        // NO DOUBLE-POST AGAINST THE BOOK-IN, IN EITHER DIRECTION, and this is the exclusion that
        // makes the two fixes compose:
        //   · THIS path journals `allocation.qty` and, in this same transaction, increments
        //     `wms_asn_line_maps.qtyAccountedViaSnapshot` by it. A later book-in journals
        //     `stockQtyToAdd`, which is `qtyReceived − coveredBySnapshotQty`, and
        //     `coveredBySnapshotQty` is derived from exactly that column
        //     (asn-reconciliation.ts:203-205). So the units this path posts are the units the
        //     book-in deliberately excludes — pinned by arm 6 of
        //     tests/concurrency/wms-purchase-receipt-journal.concurrent.test.ts on the o3d-8f0p6
        //     branch, and from this side by the composition arms of
        //     tests/concurrency/mintsoft-align-up-stock-receipt-journal.concurrent.test.ts.
        //   · THE REVERSE is `resolveWmsAsnLineResidualQty`, which caps this path's allocation at
        //     `expectedQty − max(qtyAccountedViaSnapshot, lastProcessedReceivedQty)`. Units a
        //     book-in already landed raised `lastProcessedReceivedQty`, so they are outside every
        //     allocation this path can make and cannot be journalled here a second time.
        // The key carries the ASN LINE and this MOVEMENT, so it can collide with neither
        // `wms-purchase-receipt:<poId>:<eventId>` nor `purchase-receipt:<poId>:<receiptRef>`; and
        // because the movement id is fresh per allocation, one sweep crediting two ASN lines of one
        // order posts two journals for two disjoint quantities rather than one merged amount.
        const receiptValueBase = multiplyMoney(toDecimal(allocation.qty), toDecimal(unitCostBase))
        if (accountingConnector && accountingSettings.syncEnabled && receiptValueBase.gt(0)) {
          const amount = roundQuantity(receiptValueBase, 2).toNumber()
          // THE ACCOUNT CODES COME FROM THIS TRANSACTION, pinned to the SAME connector the enqueue
          // is pinned to (o3d-8f0p6 r2's round-1 HIGH 2, copied deliberately rather than reinvented).
          // A code read over the POOL before this transaction opened is a code an operator can remap
          // before it commits, and the enqueue's own fence does not cover it:
          // `pinnedLedgerIsServicedUnderLock` locks the `plugin_*` rows only
          // (lib/integration-plugin-selection-lock.ts:66-78), which is a different question from
          // "are these still the right account codes".
          const accounts = await accountsForPosting(accountingConnector)
          const payload = {
            date: now.toISOString().slice(0, 10),
            reference: `Receipt: ${purchaseCost.poReference}`,
            narration: `Stock receipt for PO ${purchaseCost.poReference} via Mintsoft alignment against ASN `
              + `${candidate.asn.externalAsnId}`,
            lines: [
              {
                accountCode: accounts.inventoryAccount,
                description: `Stock receipt: ${purchaseCost.poReference}`,
                debit: amount,
              },
              {
                accountCode: accounts.transitAccount,
                description: `Stock receipt: ${purchaseCost.poReference}`,
                credit: amount,
              },
            ],
          }
          const receiptIdempotencyKey = accountingPayloadKey(
            `wms-align-up:${candidate.id}:${movement.id}`,
            payload,
          )
          const queued = await queueAccountingSyncTx(tx, {
            type: 'STOCK_RECEIPT',
            referenceType: 'PurchaseOrder',
            referenceId: purchaseCost.poId,
            payload,
            idempotencyKey: receiptIdempotencyKey,
            // PIN THE LEDGER: the enqueue re-asks under the plugin-selection lock and refuses rather
            // than writing this row against a connector other than the one whose accounts are in the
            // payload above.
            connector: accountingConnector,
            // o3d-6nd55 r6 (merge with o3d-j625 #700) — THE CHART THE CODES ABOVE CAME FROM.
            //
            // o3d-j625 made `chartConnector` REQUIRED on every enqueue, so this call site has to name it
            // now that the two branches have met. It is `accountingConnector` because that is literally
            // the argument `accountsForPosting()` was given when this payload's account codes were read
            // — not a second resolution taken here, which is the divergence the requirement exists to
            // close. The merged WMS book-in names it the same way for the same reason.
            chartConnector: accountingConnector,
          })
          // NO POST-ENQUEUE RE-READ, and the reason is measured rather than argued (o3d-6nd55 r2,
          // following o3d-8f0p6 r4 to the same conclusion on the same evidence). Round 1 put one here
          // and refused on a difference. Codex round 2 showed refusal was the wrong instrument — it
          // sees only a remap that ALREADY committed — and the lock above replaced it. The re-read was
          // then re-run as a mutation: DELETING it turned no arm red, while deleting the LOCK is caught
          // by the mapping arm on its own. A check that cannot fail is not a guarantee, so it is gone
          // rather than believed. The lock is the guarantee.
          // 6oyu.4 (khdw): a receipt CREDITS the transit clearing account, draining goods-in-transit
          // into inventory, so the signed subledger delta is −amount. Recorded on the QUEUE'S OWN
          // decision (bcz9.4) rather than a second settings read, so the two can never disagree: a
          // journal that was not queued must not be mirrored, or the transit reconciliation would
          // report a GL/subledger gap that is really an artefact of this line.
          if (queued) {
            await recordTransitSubledgerMovement(tx, {
              sourceType: 'STOCK_RECEIPT',
              sourceRef: purchaseCost.poId,
              idempotencyKey: receiptIdempotencyKey,
              baseDelta: -amount,
              journalDate: payload.date,
            })
          }
        }
      } else {
        // TRANSFER-BACKED ALLOCATIONS GET NO JOURNAL, DELIBERATELY (o3d-6nd55). A transfer moves
        // units the business already owns between its own warehouses: their value never left
        // inventory and never entered PURCHASE goods-in-transit, whose sources are listed at
        // lib/domain/accounting/transit-subledger-movement.ts:20-35 and include no transfer. The
        // manual transfer receipt agrees — app/actions/transfers.ts queues no accounting sync at all
        // — and so does the WMS book-in's transfer loop, so posting nothing here is parity rather
        // than a second hole. The layers recreated below carry the DISPATCH snapshot's costs, which
        // are the costs inventory already holds.
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
        // can be IN_TRANSIT with these units fully layered and propagatable. A
        // revaluation that landed while units were in transit capitalised their share
        // itself at revaluation time (DR Inventory / CR Transit, o3d-nrl4 PR B:
        // capitaliseInTransitResidue, measured past this credit as LANDED quantity),
        // so nothing is owed here and this posts nothing.
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

    // ─── THE ORDER'S STATUS FOLLOWS WHAT HAS LANDED (o3d-papk C3, Codex MEDIUM) ───
    //
    // The alignment lands units without writing `qtyReceived`, so a purchase order stocked entirely by alignment
    // stayed PO_SENT / SHIPPED with `receivedAt` unset: no manual receipt is outstanding to run the derivation
    // that the receipt and the book-in carry, so nothing ever would. The same derivation
    // (`derivePurchaseOrderReceiptStatus`) runs here, over the landed quantity read on `tx`, under the
    // `purchase_orders` row lock taken at step 2b (held to commit): NO new lock. It only ever moves an order
    // FORWARD along the purchase-order workflow (`validatePurchaseOrderStatusTransition` refuses anything else),
    // so a RECEIVED, INVOICED, returned or closed order is left as it is.
    const alignedPurchaseOrderIds = [...new Set(plan.allocations.flatMap((allocation) => {
      const purchaseCost = costByAsnLineMapId.get(allocation.asnLineMapId)
      return purchaseCost ? [purchaseCost.poId] : []
    }))].sort()
    for (const poId of alignedPurchaseOrderIds) {
      const order = await tx.purchaseOrder.findUniqueOrThrow({
        where: { id: poId },
        select: { id: true, status: true, lines: { select: { id: true, qty: true, qtyReceived: true } } },
      })
      const landedByLineId = await loadPurchaseOrderLineLandedQty(tx, order.lines)
      const nextStatus = derivePurchaseOrderReceiptStatus(order.lines.map((line) => ({
        qty: line.qty,
        landed: requirePoLineLandedQty(landedByLineId, line.id),
      })))
      if (nextStatus === order.status) continue
      if (!validatePurchaseOrderStatusTransition(order.status, nextStatus).success) continue
      await tx.purchaseOrder.update({
        where: { id: order.id },
        data: { status: nextStatus, ...(nextStatus === 'RECEIVED' ? { receivedAt: now } : {}) },
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
            // The IMS side the delta was subtracted from, so the alignment can tell
            // under its own lock whether that quantity still stands (Codex r12
            // HIGH-1). Same pair the align-down call below passes.
            imsQty,
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
