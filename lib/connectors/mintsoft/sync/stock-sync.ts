import { randomUUID } from 'crypto'
import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { createCostLayer, copyCostLayerSourceLinesProportionally } from '@/lib/cost-layers'
import { notify } from '@/lib/notifications'
import { getWmsConnector } from '@/lib/connectors/wms/registry'
import {
  collectMissingInWmsCandidates,
  consolidateMintsoftStockLines,
  hasMintsoftThresholdBreach,
  planMintsoftAlignmentAllocations,
  parseMintsoftThresholds,
} from './stock-sync-helpers'
import { sliceTransferSnapshotForReceipt } from './booked-in-helpers'

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
    await tx.$executeRaw`SELECT id FROM external_wms_bindings WHERE id = ${bindingId} FOR UPDATE`

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
  category: 'MISSING_IN_WMS' | 'UNMAPPED_SKU' | 'QTY_MISMATCH' | 'RECEIPT_TIMING_CONFLICT'
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
        in: ['MISSING_IN_WMS', 'UNMAPPED_SKU', 'QTY_MISMATCH', 'RECEIPT_TIMING_CONFLICT'],
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
  expectedQty: number
  qtyAccountedViaSnapshot: number
  lastProcessedReceivedQty: number
  asn: {
    externalAsnId: string
    createdAt: Date
  }
}

async function getAlignmentCandidateLines(
  binding: SyncBinding,
  productId: string,
): Promise<AlignmentCandidateLine[]> {
  const lines = await db.wmsAsnLineMap.findMany({
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

  return lines.map((line) => ({
    id: line.id,
    sourceType: line.sourceType as 'PURCHASE_ORDER_LINE' | 'STOCK_TRANSFER_LINE',
    sourceLineId: line.sourceLineId,
    expectedQty: Number(line.expectedQty),
    qtyAccountedViaSnapshot: Number(line.qtyAccountedViaSnapshot),
    lastProcessedReceivedQty: Number(line.lastProcessedReceivedQty),
    asn: line.asn,
  }))
}

async function applyMintsoftAlignmentForProduct(params: {
  binding: SyncBinding
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
  const candidates = await getAlignmentCandidateLines(params.binding, params.productId)
  if (candidates.length === 0) {
    return {
      applied: false,
      dryRun: params.dryRun,
      correctedQty: 0,
      reason: 'No open ASN line is available to absorb this WMS delta.',
    }
  }

  const plan = planMintsoftAlignmentAllocations({
    delta: params.delta,
    candidates: candidates.map((candidate) => ({
      asnLineMapId: candidate.id,
      expectedQty: candidate.expectedQty,
      qtyAccountedViaSnapshot: candidate.qtyAccountedViaSnapshot,
      lastProcessedReceivedQty: candidate.lastProcessedReceivedQty,
      sortKey: `${candidate.asn.createdAt.toISOString()}:${candidate.id}`,
    })),
  })

  if (plan.allocations.length === 0 || plan.unallocatedQty > 0.0001) {
    const coveredQty = params.delta - plan.unallocatedQty
    return {
      applied: false,
      dryRun: params.dryRun,
      correctedQty: 0,
      reason: coveredQty > 0
        ? `Open ASN lines only explain ${formatQuantity(coveredQty)} of the ${formatQuantity(params.delta)} delta; leaving stock unchanged.`
        : 'No open ASN line has remaining capacity for this WMS delta.',
    }
  }

  if (params.dryRun) {
    return {
      applied: false,
      dryRun: true,
      correctedQty: params.delta,
      reason: `Dry run: ${plan.allocations.length} ASN line${plan.allocations.length === 1 ? '' : 's'} would absorb ${formatQuantity(params.delta)}.`,
    }
  }

  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]))

  await db.$transaction(async (tx) => {
    for (const allocation of plan.allocations) {
      const candidate = candidateById.get(allocation.asnLineMapId)
      if (!candidate) {
        throw new Error(`Missing ASN line ${allocation.asnLineMapId} during alignment.`)
      }

      if (candidate.sourceType === 'PURCHASE_ORDER_LINE') {
        const poLine = await tx.purchaseOrderLine.findUnique({
          where: { id: candidate.sourceLineId },
          select: {
            id: true,
            productId: true,
            unitCostBase: true,
          },
        })
        if (!poLine) {
          throw new Error(`Purchase order line ${candidate.sourceLineId} is missing for alignment.`)
        }

        await tx.stockMovement.create({
          data: {
            type: 'PURCHASE_RECEIPT',
            productId: params.productId,
            toWarehouseId: params.binding.warehouseId,
            qty: allocation.qty,
            note: `Mintsoft alignment snapshot against ASN ${candidate.asn.externalAsnId}`,
            referenceType: 'WmsAsnLineMap',
            referenceId: candidate.id,
          },
        })

        await createCostLayer(tx, {
          productId: poLine.productId,
          warehouseId: params.binding.warehouseId,
          qty: allocation.qty,
          unitCostBase: Number(poLine.unitCostBase),
          poLineId: poLine.id,
        })
      } else {
        const transferLine = await tx.stockTransferLine.findUnique({
          where: { id: candidate.sourceLineId },
          select: {
            id: true,
            productId: true,
            costLayerSnapshot: true,
          },
        })
        if (!transferLine) {
          throw new Error(`Transfer line ${candidate.sourceLineId} is missing for alignment.`)
        }

        await tx.stockMovement.create({
          data: {
            type: 'TRANSFER_IN',
            productId: params.productId,
            toWarehouseId: params.binding.warehouseId,
            qty: allocation.qty,
            note: `Mintsoft alignment snapshot against ASN ${candidate.asn.externalAsnId}`,
            referenceType: 'WmsAsnLineMap',
            referenceId: candidate.id,
          },
        })

        const snapshotSlice = sliceTransferSnapshotForReceipt({
          snapshot: transferLine.costLayerSnapshot,
          alreadyReceivedQty: candidate.qtyAccountedViaSnapshot,
          qtyReceived: allocation.qty,
        })

        if (snapshotSlice.length === 0 && allocation.qty > 0) {
          throw new Error(`Transfer line ${candidate.sourceLineId} has no FIFO snapshot left for alignment.`)
        }

        for (const entry of snapshotSlice) {
          const newLayerId = await createCostLayer(tx, {
            productId: transferLine.productId,
            warehouseId: params.binding.warehouseId,
            qty: entry.qty,
            unitCostBase: entry.unitCostBase,
          })
          await copyCostLayerSourceLinesProportionally(tx, entry.costLayerId, newLayerId, entry.qty)
        }
      }

      await tx.stockLevel.upsert({
        where: {
          productId_warehouseId: {
            productId: params.productId,
            warehouseId: params.binding.warehouseId,
          },
        },
        create: {
          productId: params.productId,
          warehouseId: params.binding.warehouseId,
          quantity: allocation.qty,
          reservedQty: 0,
        },
        update: {
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
  }, { maxWait: 5000, timeout: 30000 })

  return {
    applied: true,
    dryRun: false,
    correctedQty: params.delta,
    reason: `Aligned ${formatQuantity(params.delta)} from Mintsoft to ${plan.allocations.length} open ASN line${plan.allocations.length === 1 ? '' : 's'}.`,
  }
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
    skipped: 0,
    errors: 0,
  }

  let thresholdBreaches = 0
  const alignmentDryRun = binding.stockSyncMode === 'ALIGN_TO_WMS' && !binding.alignmentConfirmedAt
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
          await upsertDiscrepancy({
            binding,
            category: 'UNMAPPED_SKU',
            productId: null,
            sku: line.sku,
            imsValue: null,
            wmsValue: formatQuantity(line.quantity),
            delta: null,
            message: 'Mintsoft returned a SKU that is not mapped to an IMS product.',
          })

          logRows.push({
            jobId: job.id,
            sku: line.sku,
            productId: null,
            action: 'discrepancy',
            wmsQty: line.quantity,
            delta: null,
            reason: 'UNMAPPED_SKU',
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
            productId: product.id,
            sku: product.sku,
            delta,
            dryRun: alignmentDryRun,
          })

          if (alignment.applied || alignment.dryRun) {
            counters.corrected += 1
            await resolveOpenDiscrepancies(binding, product.id, product.sku)
            logRows.push({
              jobId: job.id,
              sku: product.sku,
              productId: product.id,
              action: alignment.applied ? 'corrected' : 'discrepancy',
              imsQtyBefore: imsQty,
              imsQtyAfter: alignment.applied ? wmsQty : imsQty,
              wmsQty,
              delta,
              reason: alignment.reason,
              payload: (line.raw ?? {}) as Prisma.InputJsonValue,
            })
            continue
          }
        }

        const timingConflict = await detectReceiptTimingConflict(binding, product.id, delta)
        const category = timingConflict ? 'RECEIPT_TIMING_CONFLICT' : 'QTY_MISMATCH'
        const message = timingConflict ?? `IMS has ${formatQuantity(imsQty)} and Mintsoft has ${formatQuantity(wmsQty)} for ${product.sku}.`

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
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Mintsoft stock sync failed'

    await completeJob(job.id, 'FAILED', counters, {
      externalWarehouseId: binding.externalWarehouseId,
      thresholdBreaches: 0,
      notifiedUsers: 0,
      dryRun: alignmentDryRun,
      alignmentCorrections: counters.corrected,
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
      lastStockSyncStatus: 'SUCCEEDED',
    },
  })

  return job.id
}

export async function clearMintsoftAlignmentCreditsForBinding(bindingId: string): Promise<number> {
  const binding = await getSyncBinding(bindingId)
  if (!binding) return 0

  const updated = await db.wmsAsnLineMap.updateMany({
    where: {
      qtyAccountedViaSnapshot: { gt: 0 },
      asn: {
        connector: 'mintsoft',
        warehouseId: binding.warehouseId,
        closedAt: null,
      },
    },
    data: {
      qtyAccountedViaSnapshot: 0,
      note: 'alignment credit cleared on mode exit',
    },
  })

  return updated.count
}
