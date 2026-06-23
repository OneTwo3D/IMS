/**
 * Daily batch sync — the core of the Xero Sub-Ledger architecture.
 *
 * Execution order: A1 → A2 → B (always in this sequence).
 *
 * Group A1 — Revenue Deferral: DR Sales / CR Unearned Revenue
 *   Any paid order, regardless of stock status (incl. backorders).
 *
 * Group A2 — Inventory Reclassification: DR Allocated / CR Available
 *   Only allocated orders (stock physically reserved).
 *
 * Group B — Shipment: DR Unearned / CR Sales + DR COGS / CR Allocated
 *   Per-shipment, with FIFO cost layer consumption.
 */

import { createHash } from 'node:crypto'

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { getBaseCurrencyCode } from '@/lib/base-currency'
import { getXeroSettings } from '@/lib/connectors/xero/settings'
import { normalizeOrderDiscountBase } from '@/lib/sales-currency'
import { Prisma } from '@/app/generated/prisma/client'
import {
  mirrorAccountingSyncLogToEvent,
  resetMirroredAccountingEventsToPending,
} from '@/lib/domain/accounting/accounting-event-mirror'
import { scheduleXeroAccountingOutbox } from '@/lib/connectors/xero/outbox'
import {
  parseCostLayerSnapshot,
  reduceSnapshotByCostLayer,
  reduceSnapshotByQty,
  sumCostLayerSnapshot,
  takeFromSnapshotEntries,
  type CostLayerSnapshotEntry,
} from '@/lib/cost-layer-snapshots'
import { addMoney, roundQuantity, subtractMoney, toDecimal, type Decimal } from '@/lib/domain/math/decimal'
import { GL_BASE_PRECISION, roundToGlPrecisionNumber } from '@/lib/domain/math/precision-policy'
import { buildInventoryReconciliationSweepJournal, loadInventoryGlReconciliation } from '@/lib/domain/accounting/inventory-gl-reconciliation'
import { buildCogsReconciliationSweepJournal, loadCogsGlReconciliation } from '@/lib/domain/accounting/cogs-gl-reconciliation'
import { recordCogsSubledgerMovement } from '@/lib/domain/accounting/cogs-subledger-movement'
import { recreateJournaledDateFilter } from '@/lib/domain/accounting/daily-batch-retention'
import { calculateCoverageByLine, requirementsMapToRows } from '@/lib/products/fulfillment-coverage'
import { isFullyShippedTerminalStatus, recognizeShipmentRevenue } from '@/lib/domain/accounting/revenue-recognition'
import {
  sumPostedUnearnedReversal,
  isFullyShippedNetOfRefunds,
  batchContainsFinalUnjournaledShipment,
} from '@/lib/domain/accounting/deferred-trueup'
import { expandFulfillmentRequirementsDecimal, loadFulfillmentProductGraph } from '@/lib/products/kit-fulfillment'

type MutableLayer = {
  id: string
  remainingQty: number
  unitCostBase: number
}

type LayerSnapshot = Map<string, MutableLayer[]>

type JournalLinePayload = {
  accountCode: string
  description: string
  debit?: number
  credit?: number
}
type AccountingMirrorClient = Pick<Prisma.TransactionClient, 'accountingSyncLog' | 'accountingEvent' | 'accountingEventLog' | 'integrationOutbox' | 'activityLog'>

const XERO_DAILY_BATCH_LOCK_KEY = 4_112_208_031
const XERO_CONNECTOR = 'xero'
export const XERO_DAILY_BATCH_DEFAULT_LIMIT = 1_000
export const XERO_DAILY_BATCH_MAX_LIMIT = 5_000
const DAILY_BATCH_TYPES = [
  'DAILY_BATCH_REVENUE_DEFERRAL',
  'DAILY_BATCH_INVENTORY_ALLOC',
  'DAILY_BATCH_GROUP_B',
  'DAILY_BATCH_INVENTORY_RECONCILIATION',
  'DAILY_BATCH_COGS_RECONCILIATION',
] as const

// GL postings round to the canonical GL precision (cogs-audit scjz.60); these
// thin aliases keep call sites terse while the precision lives in one place.
function round2(value: number): number {
  return roundToGlPrecisionNumber(value)
}

function round2Decimal(value: Decimal): number {
  return roundQuantity(value, GL_BASE_PRECISION).toNumber()
}

function normalizeDeferredDiscountBase(order: {
  fxRateToBase: Prisma.Decimal | number | null
  discountAmount: Prisma.Decimal | number | null
  pricesIncludeVat: boolean
  taxRatePercent: Prisma.Decimal | number | null
  shoppingLinks?: Array<{ connector: string }>
  lines?: Array<{ totalBase: Prisma.Decimal | number | null; taxRate?: { rate: Prisma.Decimal | number | null } | null }>
}): number {
  return normalizeOrderDiscountBase(order, order.lines)
}

function makeLayerKey(productId: string, warehouseId: string): string {
  return `${productId}|${warehouseId}`
}

export function buildDailyBatchReferenceId(
  group: 'A1' | 'A2' | 'B',
  date: string,
  entityIds: string[],
): string {
  const stableEntityIds = [...entityIds].sort()
  const digest = createHash('sha256')
    .update(stableEntityIds.join('|'))
    .digest('hex')
    .slice(0, 8)
  return `${group}-${date}-${digest}`
}

async function buildLayerSnapshot(
  tx: Prisma.TransactionClient,
  rows: Array<{ productId: string; warehouseId: string }>,
): Promise<LayerSnapshot> {
  const snapshot: LayerSnapshot = new Map()
  const keys = new Set(rows.map((row) => makeLayerKey(row.productId, row.warehouseId)))

  for (const key of keys) {
    const [productId, warehouseId] = key.split('|')
    const candidateLayers = await tx.costLayer.findMany({
      where: {
        productId,
        warehouseId,
        remainingQty: { gt: 0 },
      },
      orderBy: { receivedAt: 'asc' },
      select: { id: true, remainingQty: true, unitCostBase: true },
    })
    if (candidateLayers.length > 0) {
      await tx.$queryRaw`SELECT id FROM cost_layers WHERE id = ANY(${candidateLayers.map((layer) => layer.id)}::text[]) FOR UPDATE`
    }
    const layers = candidateLayers.length === 0
      ? []
      : await tx.costLayer.findMany({
          where: { id: { in: candidateLayers.map((layer) => layer.id) } },
          orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
          select: { id: true, remainingQty: true, unitCostBase: true },
        })
    snapshot.set(
      key,
      layers.map((layer) => ({
        id: layer.id,
        remainingQty: Number(layer.remainingQty),
        unitCostBase: Number(layer.unitCostBase),
      })),
    )
  }

  return snapshot
}

function requireShipmentSnapshotValue(order: {
  id: string
  shipments: Array<{
    id: string
    status: string
    lines: Array<{ id: string; qty: Prisma.Decimal | number; costLayerSnapshot: Prisma.JsonValue | null }>
  }>
}): Decimal {
  let total = toDecimal(0)
  let hasShippedLines = false

  for (const shipment of order.shipments) {
    if (shipment.status !== 'SHIPPED') continue
    for (const line of shipment.lines) {
      if (Number(line.qty) <= 0) continue
      hasShippedLines = true
      const snapshot = parseCostLayerSnapshot(line.costLayerSnapshot)
      if (snapshot.length === 0) {
        throw new Error(`Missing FIFO snapshot for already-shipped line ${line.id} on order ${order.id}`)
      }
      total = addMoney(total, sumCostLayerSnapshot(snapshot))
    }
  }

  if (!hasShippedLines) {
    throw new Error(`Order ${order.id} is marked shipped but has no shipped lines to reclassify`)
  }

  return roundQuantity(total, 2)
}

function consumeSnapshotLayers(
  snapshot: LayerSnapshot,
  productId: string,
  warehouseId: string,
  qty: number,
  trackDecrements?: Map<string, number>,
): CostLayerSnapshotEntry[] {
  const layers = snapshot.get(makeLayerKey(productId, warehouseId)) ?? []
  let remaining = qty
  const consumed: CostLayerSnapshotEntry[] = []

  for (const layer of layers) {
    if (remaining <= 0) break
    const take = Math.min(remaining, layer.remainingQty)
    if (take <= 0) continue
    consumed.push({
      costLayerId: layer.id,
      qty: take,
      unitCostBase: layer.unitCostBase,
    })
    layer.remainingQty -= take
    remaining -= take
    if (trackDecrements) {
      trackDecrements.set(layer.id, (trackDecrements.get(layer.id) ?? 0) + take)
    }
  }

  return consumed
}

async function createPendingSyncLog(
  tx: AccountingMirrorClient,
  params: {
    type: 'DAILY_BATCH_REVENUE_DEFERRAL' | 'DAILY_BATCH_INVENTORY_ALLOC' | 'DAILY_BATCH_GROUP_B' | 'DAILY_BATCH_INVENTORY_RECONCILIATION' | 'DAILY_BATCH_COGS_RECONCILIATION'
    referenceId: string
    payload: Record<string, unknown>
    currency: string
  },
): Promise<void> {
  const log = await tx.accountingSyncLog.create({
    data: {
      connector: XERO_CONNECTOR,
      type: params.type,
      status: 'PENDING',
      referenceType: 'DailyBatch',
      referenceId: params.referenceId,
      payload: params.payload as never,
    },
  })
  await scheduleXeroAccountingOutbox(tx, {
    accountingSyncLogId: log.id,
  })
  // Mirror failure must not abort the whole daily batch: the sync log + outbox
  // are already created (and will post), so swallow + warn here exactly as
  // queueAccountingSyncTx does, instead of rolling back every order in the group
  // (cogs-audit scjz.40).
  await mirrorAccountingSyncLogToEvent(tx, {
    syncLogId: log.id,
    connector: XERO_CONNECTOR,
    type: params.type,
    referenceType: 'DailyBatch',
    referenceId: params.referenceId,
    payload: params.payload,
    currency: params.currency,
    status: 'PENDING',
  }).catch((mirrorError: unknown) => tx.activityLog.create({
    data: {
      entityType: 'SYSTEM',
      action: 'accounting_event_mirror_error',
      tag: 'sync',
      level: 'WARNING',
      description: `Daily-batch sync entry ${log.id} was queued but accounting event mirroring failed: ${String(mirrorError)}`,
    },
  }).then(() => undefined))
}

async function lockCostLayers(
  tx: Prisma.TransactionClient,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM "cost_layers" WHERE id IN (${Prisma.join(ids)}) FOR UPDATE`,
  )
}

async function resetFailedDailyBatchLogs(): Promise<void> {
  await db.$transaction(async (tx) => {
    const failedLogs = await tx.accountingSyncLog.findMany({
      where: {
        connector: XERO_CONNECTOR,
        type: { in: [...DAILY_BATCH_TYPES] },
        status: 'FAILED',
      },
      select: { referenceId: true },
    })

    await tx.accountingSyncLog.updateMany({
      where: {
        connector: XERO_CONNECTOR,
        type: { in: [...DAILY_BATCH_TYPES] },
        status: 'FAILED',
      },
      data: {
        status: 'PENDING',
        retryCount: 0,
        errorMessage: null,
        processingStartedAt: null,
      },
    })

    await resetMirroredAccountingEventsToPending(tx, {
      connector: XERO_CONNECTOR,
      types: [...DAILY_BATCH_TYPES],
      referenceType: 'DailyBatch',
      referenceIds: failedLogs.map((log) => log.referenceId),
    })
  })
}

type DailyBatchLogType = typeof DAILY_BATCH_TYPES[number]
type DailyBatchGroup = 'groupA1' | 'groupA2' | 'groupB'

export type XeroDailyBatchResult = {
  groupA1: number
  groupA2: number
  groupB: number
  batchLimit: number
  hasMore: Record<DailyBatchGroup, boolean>
  errors: string[]
  // cogs-audit scjz.60.4: the rounding-residue (GL_BASE_PRECISION units) swept to the
  // rounding-difference account this run, or null when nothing was swept (balanced,
  // unavailable, material gap flagged, or no rounding account configured).
  inventoryReconciliationSwept?: number | null
  // khdw: same, for the COGS subledger-vs-GL rounding sweep.
  cogsReconciliationSwept?: number | null
}

export function resolveXeroDailyBatchLimit(value = process.env.XERO_DAILY_BATCH_LIMIT): number {
  if (value === undefined || value.trim() === '') return XERO_DAILY_BATCH_DEFAULT_LIMIT
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return XERO_DAILY_BATCH_DEFAULT_LIMIT
  return Math.min(Math.floor(parsed), XERO_DAILY_BATCH_MAX_LIMIT)
}

export function takeDailyBatchWindow<T>(
  rows: T[],
  limit: number,
): { rows: T[]; hasMore: boolean } {
  if (rows.length <= limit) return { rows, hasMore: false }
  return {
    rows: rows.slice(0, limit),
    hasMore: true,
  }
}

async function hasLiveDailyBatchLog(type: DailyBatchLogType, bareReferenceId: string): Promise<boolean> {
  // The live daily-batch posting stamps a digest-suffixed referenceId
  // (buildDailyBatchReferenceId -> `<group>-<date>-<8 hex>`), so an exact match on
  // the bare `<group>-<date>` never finds it and recreate would post a duplicate
  // batch (double-post). Match the bare key OR any digest-suffixed variant for the
  // same group+date (scjz.37).
  const count = await db.accountingSyncLog.count({
    where: {
      connector: XERO_CONNECTOR,
      type,
      status: { in: ['PENDING', 'PROCESSING', 'SYNCED'] },
      OR: [
        { referenceId: bareReferenceId },
        { referenceId: { startsWith: `${bareReferenceId}-` } },
      ],
    },
  })
  return count > 0
}

async function recreateMissingDailyBatchLogs(settings: Awaited<ReturnType<typeof getXeroSettings>>, baseCurrency: string): Promise<void> {
  // scjz.36: only recreate within the sync-log retention window — beyond it, SYNCED
  // daily-batch logs are pruned by data-retention, so a "missing" log can't be told
  // apart from one that already posted, and rebuilding would double-post the journal.
  const journaledDateFilter = await recreateJournaledDateFilter()
  const orphanA1Orders = await db.salesOrder.findMany({
    where: { revenueDeferredDate: journaledDateFilter },
    select: { revenueDeferredDate: true, unearnedRevenueAmount: true },
  })
  const orphanA2Orders = await db.salesOrder.findMany({
    where: { inventoryAllocatedDate: journaledDateFilter },
    select: { inventoryAllocatedDate: true, allocationBatchAmount: true },
  })
  const orphanBShipments = await db.shipment.findMany({
    where: { shipmentJournalDate: journaledDateFilter },
    select: { shipmentJournalDate: true, revenueRecognizedAmount: true, cogsBatchAmount: true },
  })

  const a1ByDate = new Map<string, { orderCount: number; total: number }>()
  for (const order of orphanA1Orders) {
    const stagedAt = order.revenueDeferredDate
    if (!stagedAt) continue
    const key = stagedAt.toISOString().slice(0, 10)
    const existing = a1ByDate.get(key) ?? { orderCount: 0, total: 0 }
    existing.orderCount += 1
    existing.total += Number(order.unearnedRevenueAmount ?? 0)
    a1ByDate.set(key, existing)
  }

  const a2ByDate = new Map<string, { orderCount: number; total: number }>()
  for (const order of orphanA2Orders) {
    const stagedAt = order.inventoryAllocatedDate
    if (!stagedAt) continue
    const key = stagedAt.toISOString().slice(0, 10)
    const existing = a2ByDate.get(key) ?? { orderCount: 0, total: 0 }
    existing.orderCount += 1
    existing.total += Number(order.allocationBatchAmount ?? 0)
    a2ByDate.set(key, existing)
  }

  const bByDate = new Map<string, { shipmentCount: number; revenue: number; cogs: number }>()
  for (const shipment of orphanBShipments) {
    const stagedAt = shipment.shipmentJournalDate
    if (!stagedAt) continue
    const key = stagedAt.toISOString().slice(0, 10)
    const existing = bByDate.get(key) ?? { shipmentCount: 0, revenue: 0, cogs: 0 }
    existing.shipmentCount += 1
    existing.revenue += Number(shipment.revenueRecognizedAmount ?? 0)
    existing.cogs += Number(shipment.cogsBatchAmount ?? 0)
    bByDate.set(key, existing)
  }

  for (const [date, summary] of a1ByDate) {
    const referenceId = `A1-${date}`
    if (summary.total <= 0 || await hasLiveDailyBatchLog('DAILY_BATCH_REVENUE_DEFERRAL', referenceId)) continue
    await db.$transaction(async (tx) => {
      await createPendingSyncLog(tx, {
        type: 'DAILY_BATCH_REVENUE_DEFERRAL',
        referenceId,
        currency: baseCurrency,
        payload: {
          date,
          reference: `Revenue Deferral ${date}`,
          narration: `Recreated revenue deferral batch: ${summary.orderCount} order(s), £${round2(summary.total).toFixed(2)}`,
          lines: [
            { accountCode: settings.xero_sales_account, description: `Daily revenue deferral — ${summary.orderCount} order(s)`, debit: round2(summary.total) },
            { accountCode: settings.xero_unearned_revenue_account, description: `Daily revenue deferral — ${summary.orderCount} order(s)`, credit: round2(summary.total) },
          ],
          _postingMode: 'submitted',
          _recreatedFromStage: true,
        },
      })
    })
  }

  for (const [date, summary] of a2ByDate) {
    const referenceId = `A2-${date}`
    if (summary.total <= 0 || await hasLiveDailyBatchLog('DAILY_BATCH_INVENTORY_ALLOC', referenceId)) continue
    await db.$transaction(async (tx) => {
      await createPendingSyncLog(tx, {
        type: 'DAILY_BATCH_INVENTORY_ALLOC',
        referenceId,
        currency: baseCurrency,
        payload: {
          date,
          reference: `Inventory Allocation ${date}`,
          narration: `Recreated inventory allocation batch: ${summary.orderCount} order(s), £${round2(summary.total).toFixed(2)}`,
          lines: [
            { accountCode: settings.xero_allocated_inventory_account, description: `Daily inventory allocation — ${summary.orderCount} order(s)`, debit: round2(summary.total) },
            { accountCode: settings.xero_inventory_account, description: `Daily inventory allocation — ${summary.orderCount} order(s)`, credit: round2(summary.total) },
          ],
          _postingMode: 'submitted',
          _recreatedFromStage: true,
        },
      })
    })
  }

  for (const [date, summary] of bByDate) {
    const referenceId = `B-${date}`
    if ((summary.revenue <= 0 && summary.cogs <= 0) || await hasLiveDailyBatchLog('DAILY_BATCH_GROUP_B', referenceId)) continue
    const lines: JournalLinePayload[] = []
    if (round2(summary.revenue) > 0) {
      lines.push(
        { accountCode: settings.xero_unearned_revenue_account, description: `Revenue recognition — ${summary.shipmentCount} shipment(s)`, debit: round2(summary.revenue) },
        { accountCode: settings.xero_sales_account, description: `Revenue recognition — ${summary.shipmentCount} shipment(s)`, credit: round2(summary.revenue) },
      )
    }
    if (round2(summary.cogs) > 0) {
      lines.push(
        { accountCode: settings.xero_cogs_account, description: `COGS — ${summary.shipmentCount} shipment(s)`, debit: round2(summary.cogs) },
        { accountCode: settings.xero_allocated_inventory_account, description: `COGS — ${summary.shipmentCount} shipment(s)`, credit: round2(summary.cogs) },
      )
    }
    await db.$transaction(async (tx) => {
      await createPendingSyncLog(tx, {
        type: 'DAILY_BATCH_GROUP_B',
        referenceId,
        currency: baseCurrency,
        payload: {
          date,
          reference: `Shipment COGS ${date}`,
          narration: `Recreated shipment batch: ${summary.shipmentCount} shipment(s), revenue £${round2(summary.revenue).toFixed(2)}, COGS £${round2(summary.cogs).toFixed(2)}`,
          lines,
          _postingMode: 'submitted',
          _recreatedFromStage: true,
        },
      })
    })
  }
}

export async function runDailyBatchSync(): Promise<XeroDailyBatchResult> {
  const batchLimit = resolveXeroDailyBatchLimit()
  const result: XeroDailyBatchResult = {
    groupA1: 0,
    groupA2: 0,
    groupB: 0,
    batchLimit,
    hasMore: { groupA1: false, groupA2: false, groupB: false },
    errors: [],
  }
  const lockRows = await db.$queryRaw<Array<{ locked: boolean }>>`
    SELECT pg_try_advisory_lock(${XERO_DAILY_BATCH_LOCK_KEY}) AS locked
  `
  if (!lockRows[0]?.locked) {
    result.errors.push('Daily batch already running')
    return result
  }

  try {
    const settings = await getXeroSettings()
    const baseCurrency = await getBaseCurrencyCode()
    const today = new Date().toISOString().slice(0, 10)

    if (settings.xero_sync_enabled !== 'true') {
      return result
    }

    await resetFailedDailyBatchLogs()
    await recreateMissingDailyBatchLogs(settings, baseCurrency)

  // --- Group A1: Revenue Deferral ---
  try {
    const orderWindow = takeDailyBatchWindow(await db.salesOrder.findMany({
      where: {
        paidAt: { not: null },
        revenueDeferredDate: null,
        accountingInvoiceId: { not: null },
        status: { notIn: ['CANCELLED', 'REFUNDED', 'DRAFT'] },
      },
      select: {
        id: true,
        orderNumber: true,
        externalOrderNumber: true,
        fxRateToBase: true,
        subtotalBase: true,
        shippingBase: true,
        discountAmount: true,
        pricesIncludeVat: true,
        taxRatePercent: true,
        shoppingLinks: {
          select: { connector: true },
        },
        lines: {
          select: {
            totalBase: true,
            taxRate: { select: { rate: true } },
          },
        },
      },
      orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
      take: batchLimit + 1,
    }), batchLimit)
    const orders = orderWindow.rows
    result.hasMore.groupA1 = orderWindow.hasMore

    if (orders.length > 0) {
      const orderDeferrals = orders.map((order) => {
        const discountBase = normalizeDeferredDiscountBase(order)
        return {
          orderId: order.id,
          amount: round2(Number(order.subtotalBase) + Number(order.shippingBase ?? 0) - discountBase),
        }
      })
      let totalRevenueDeferred = 0
      const journalLines: Array<{ accountCode: string; description: string; debit?: number; credit?: number }> = []

      for (const orderDeferral of orderDeferrals) totalRevenueDeferred += orderDeferral.amount

      totalRevenueDeferred = round2(totalRevenueDeferred)
      const invariantTotal = round2(orderDeferrals.reduce((sum, order) => sum + order.amount, 0))
      if (Math.abs(invariantTotal - totalRevenueDeferred) > 0.01) {
        throw new Error(`A1 revenue deferral invariant failed: per-order ${invariantTotal.toFixed(2)} != journal ${totalRevenueDeferred.toFixed(2)}`)
      }

      if (totalRevenueDeferred > 0) {
        journalLines.push(
          { accountCode: settings.xero_sales_account, description: `Daily revenue deferral — ${orders.length} order(s)`, debit: totalRevenueDeferred },
          { accountCode: settings.xero_unearned_revenue_account, description: `Daily revenue deferral — ${orders.length} order(s)`, credit: totalRevenueDeferred },
        )
      }

      await db.$transaction(async (tx) => {
        if (journalLines.length > 0) {
          const referenceId = buildDailyBatchReferenceId('A1', today, orders.map((order) => order.id))
          await createPendingSyncLog(tx, {
            type: 'DAILY_BATCH_REVENUE_DEFERRAL',
            referenceId,
            currency: baseCurrency,
            payload: {
              date: today,
              reference: `Revenue Deferral ${today} ${referenceId.slice(-8)}`,
              narration: `Daily revenue deferral: ${orders.length} order(s), £${totalRevenueDeferred.toFixed(2)}`,
              lines: journalLines,
              orderDeferrals,
              batchReferenceId: referenceId,
              batchDate: today,
              batchGroup: 'A1',
              batchEntityCount: orders.length,
              splitBatch: result.hasMore.groupA1,
              _postingMode: 'submitted',
            },
          })
        }

        const deferralByOrderId = new Map(orderDeferrals.map((order) => [order.orderId, order.amount]))
        for (const order of orders) {
          await tx.salesOrder.update({
            where: { id: order.id },
            data: {
              revenueDeferredDate: new Date(),
              unearnedRevenueAmount: deferralByOrderId.get(order.id) ?? 0,
            },
          })
        }
      })

      result.groupA1 = orders.length
    }
  } catch (e) {
    result.errors.push(`Group A1 error: ${String(e)}`)
  }

  // --- Group A2: Inventory Reclassification ---
  try {
    const orderWindow = takeDailyBatchWindow(await db.salesOrder.findMany({
      where: {
        revenueDeferredDate: { not: null },
        inventoryAllocatedDate: null,
        status: { in: ['ALLOCATED', 'PICKING', 'PACKING', 'SHIPPED', 'COMPLETED', 'DELIVERED', 'PARTIALLY_REFUNDED'] },
      },
      orderBy: [{ revenueDeferredDate: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        orderNumber: true,
        externalOrderNumber: true,
        status: true,
        allocations: {
          select: {
            id: true,
            productId: true,
            warehouseId: true,
            qty: true,
          },
        },
        shipments: {
          where: { status: 'SHIPPED' },
          select: {
            id: true,
            status: true,
            lines: {
              select: {
                id: true,
                qty: true,
                costLayerSnapshot: true,
              },
            },
          },
        },
      },
      take: batchLimit + 1,
    }), batchLimit)
    const orders = orderWindow.rows
    result.hasMore.groupA2 = orderWindow.hasMore

    if (orders.length > 0) {
      await db.$transaction(async (tx) => {
        let totalAllocatedValue = toDecimal(0)
        const unshippedOrders = orders.filter((order) => order.shipments.length === 0)
        const snapshot = await buildLayerSnapshot(
          tx,
          unshippedOrders.flatMap((order) =>
            order.allocations.map((alloc) => ({
              productId: alloc.productId,
              warehouseId: alloc.warehouseId,
            })),
          ),
        )
        const orderValues = new Map<string, number>()
        const allocationSnapshots = new Map<string, CostLayerSnapshotEntry[]>()

        for (const order of orders) {
          let orderCostValue = toDecimal(0)

          if (order.shipments.length > 0) {
            orderCostValue = requireShipmentSnapshotValue(order)
          } else {
            for (const alloc of order.allocations) {
              const allocationSnapshot = consumeSnapshotLayers(
                snapshot,
                alloc.productId,
                alloc.warehouseId,
                Number(alloc.qty),
              )
              allocationSnapshots.set(alloc.id, allocationSnapshot)
              orderCostValue = addMoney(orderCostValue, sumCostLayerSnapshot(allocationSnapshot))
            }
            orderCostValue = roundQuantity(orderCostValue, 2)
          }

          totalAllocatedValue = addMoney(totalAllocatedValue, orderCostValue)
          orderValues.set(order.id, orderCostValue.toNumber())
        }

        const totalAllocatedValueNumber = round2Decimal(totalAllocatedValue)
        if (totalAllocatedValueNumber > 0) {
          const referenceId = buildDailyBatchReferenceId('A2', today, orders.map((order) => order.id))
          await createPendingSyncLog(tx, {
            type: 'DAILY_BATCH_INVENTORY_ALLOC',
            referenceId,
            currency: baseCurrency,
            payload: {
              date: today,
              reference: `Inventory Allocation ${today} ${referenceId.slice(-8)}`,
              narration: `Daily inventory reclassification: ${orders.length} order(s), £${totalAllocatedValueNumber.toFixed(2)}`,
              lines: [
                { accountCode: settings.xero_allocated_inventory_account, description: `Daily inventory allocation — ${orders.length} order(s)`, debit: totalAllocatedValueNumber },
                { accountCode: settings.xero_inventory_account, description: `Daily inventory allocation — ${orders.length} order(s)`, credit: totalAllocatedValueNumber },
              ],
              batchReferenceId: referenceId,
              batchDate: today,
              batchGroup: 'A2',
              batchEntityCount: orders.length,
              splitBatch: result.hasMore.groupA2,
              _postingMode: 'submitted',
            },
          })
        }

        for (const order of orders) {
          for (const alloc of order.allocations) {
            await tx.orderAllocation.update({
              where: { id: alloc.id },
              data: {
                costLayerSnapshot: (allocationSnapshots.get(alloc.id) ?? []) as never,
              },
            })
          }
          await tx.salesOrder.update({
            where: { id: order.id },
            data: {
              inventoryAllocatedDate: new Date(),
              allocationBatchAmount: orderValues.get(order.id) ?? 0,
            },
          })
        }
      })

      result.groupA2 = orders.length
    }
  } catch (e) {
    result.errors.push(`Group A2 error: ${String(e)}`)
  }

  // --- Group B: Shipment Revenue Recognition + COGS ---
  try {
    const groupBCount = await db.$transaction(async (tx) => {
      const shipmentWindow = takeDailyBatchWindow(await tx.shipment.findMany({
        where: {
          status: 'SHIPPED',
          shipmentJournalDate: null,
          order: {
            status: { not: 'REFUNDED' },
            revenueDeferredDate: { not: null },
            inventoryAllocatedDate: { not: null },
          },
        },
        select: {
          id: true,
          orderId: true,
          warehouseId: true,
          createdAt: true,
          cogsBatchAmount: true,
          lines: {
            select: {
              id: true,
              lineId: true,
              productId: true,
              qty: true,
              costLayerSnapshot: true,
              line: {
                select: { id: true, productId: true, qty: true, totalBase: true },
              },
            },
          },
          order: {
            select: {
              orderNumber: true,
              externalOrderNumber: true,
              status: true,
              totalBase: true,
              unearnedRevenueAmount: true,
              lines: { select: { id: true, productId: true, qty: true, totalBase: true } },
              shipments: {
                select: {
                  id: true,
                  status: true,
                  shipmentJournalDate: true,
                  revenueRecognizedAmount: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'asc' },
        take: batchLimit + 1,
      }), batchLimit)
      const shipments = shipmentWindow.rows
      result.hasMore.groupB = shipmentWindow.hasMore

      if (shipments.length === 0) {
        return 0
      }

      let totalRevenue = 0
      let totalCogs = toDecimal(0)
      const layerDecrements = new Map<string, number>()
      const shipmentResults = new Map<string, { revenue: number; cogs: number }>()
      const shipmentSnapshots = new Map<string, CostLayerSnapshotEntry[]>()
      const shipmentsByOrder = new Map<string, typeof shipments>()
      const orderIds = Array.from(new Set(shipments.map((shipment) => shipment.orderId)))

      const [orderAllocations, priorShipmentLines, priorRefundLines] = await Promise.all([
        tx.orderAllocation.findMany({
          where: { orderId: { in: orderIds } },
          select: {
            id: true,
            orderId: true,
            lineId: true,
            productId: true,
            warehouseId: true,
            costLayerSnapshot: true,
          },
        }),
        tx.shipmentLine.findMany({
          where: {
            shipment: {
              orderId: { in: orderIds },
              shipmentJournalDate: { not: null },
            },
          },
          select: {
            costLayerSnapshot: true,
          },
        }),
        tx.salesOrderRefundLine.findMany({
          where: {
            refund: {
              orderId: { in: orderIds },
            },
          },
          select: {
            costLayerSnapshot: true,
          },
        }),
      ])

      const referencedCostLayerIds = Array.from(new Set(
        orderAllocations.flatMap((allocation) => (
          parseCostLayerSnapshot(allocation.costLayerSnapshot).map((entry) => entry.costLayerId)
        )),
      ))
      await lockCostLayers(tx, referencedCostLayerIds)
      const graph = await loadFulfillmentProductGraph(
        tx,
        Array.from(new Set(
          shipments.flatMap((shipment) => (
            shipment.order.lines.map((line) => line.productId).filter((value): value is string => !!value)
          )),
        )),
      )

      // --- scjz.68: refund-reversal-aware deferred-revenue true-up inputs ---
      // (1) posted UNEARNED_REV_REVERSAL per order — deferred revenue a refund credit
      //     note already took out of the unearned account, which the true-up must not
      //     recognize again; (2) for PARTIALLY_REFUNDED orders, the per-line coverage
      //     used to decide whether the order is fully shipped net of refunds.
      const allocationById = new Map(orderAllocations.map((allocation) => [allocation.id, allocation]))
      const partialOrderIds = new Set(
        shipments.filter((shipment) => shipment.order.status === 'PARTIALLY_REFUNDED').map((shipment) => shipment.orderId),
      )

      const refunds = await tx.salesOrderRefund.findMany({
        where: { orderId: { in: orderIds } },
        select: { id: true, orderId: true },
      })
      const refundIdToOrderId = new Map(refunds.map((refund) => [refund.id, refund.orderId]))
      const reversalSyncs = await tx.accountingSyncLog.findMany({
        where: {
          connector: 'xero',
          type: 'UNEARNED_REV_REVERSAL',
          status: { in: ['PENDING', 'PROCESSING', 'SYNCED'] },
          OR: [
            { referenceType: 'SalesOrder', referenceId: { in: orderIds } },
            { referenceType: 'SalesOrderRefund', referenceId: { in: refunds.map((refund) => refund.id) } },
          ],
        },
        select: { referenceType: true, referenceId: true, payload: true },
      })
      const reversalSyncsByOrder = new Map<string, Array<{ payload: unknown }>>()
      for (const sync of reversalSyncs) {
        const targetOrderId = sync.referenceType === 'SalesOrder'
          ? sync.referenceId
          : refundIdToOrderId.get(sync.referenceId)
        if (!targetOrderId) continue
        const list = reversalSyncsByOrder.get(targetOrderId) ?? []
        list.push({ payload: sync.payload })
        reversalSyncsByOrder.set(targetOrderId, list)
      }

      const shippedRowsByOrder = new Map<string, Array<{ lineId: string; productId: string; qty: number }>>()
      const refundedUnshippedRowsByOrder = new Map<string, Array<{ lineId: string; productId: string; qty: number }>>()
      if (partialOrderIds.size > 0) {
        const dispatchedShipmentLines = await tx.shipmentLine.findMany({
          where: { shipment: { orderId: { in: [...partialOrderIds] }, status: 'SHIPPED' } },
          select: { lineId: true, productId: true, qty: true, shipment: { select: { orderId: true } } },
        })
        for (const line of dispatchedShipmentLines) {
          if (!line.productId) continue
          const rows = shippedRowsByOrder.get(line.shipment.orderId) ?? []
          rows.push({ lineId: line.lineId, productId: line.productId, qty: Number(line.qty) })
          shippedRowsByOrder.set(line.shipment.orderId, rows)
        }
        // Returns of shipped units (shipment-source) do not reduce the ship
        // obligation, so only allocation-source (unshipped) refund qty counts.
        for (const refundLine of priorRefundLines) {
          for (const entry of parseCostLayerSnapshot(refundLine.costLayerSnapshot)) {
            if (entry.source !== 'allocation' || !entry.orderAllocationId) continue
            const allocation = allocationById.get(entry.orderAllocationId)
            if (!allocation?.productId || !partialOrderIds.has(allocation.orderId)) continue
            const rows = refundedUnshippedRowsByOrder.get(allocation.orderId) ?? []
            rows.push({ lineId: allocation.lineId, productId: allocation.productId, qty: toDecimal(entry.qty).toNumber() })
            refundedUnshippedRowsByOrder.set(allocation.orderId, rows)
          }
        }
      }

      const allocationAvailability = new Map<string, CostLayerSnapshotEntry[]>()
      for (const allocation of orderAllocations) {
        allocationAvailability.set(
          allocation.id,
          parseCostLayerSnapshot(allocation.costLayerSnapshot),
        )
      }

      for (const priorShipmentLine of priorShipmentLines) {
        for (const entry of parseCostLayerSnapshot(priorShipmentLine.costLayerSnapshot)) {
          if (!entry.orderAllocationId) continue
          const available = allocationAvailability.get(entry.orderAllocationId) ?? []
          // Relieve the allocation contra by QTY, not by exact costLayerId: a
          // dispatch consumes FIFO-oldest layers that can differ from the layers
          // the allocation pinned, so a costLayerId match would strand the
          // Allocated-Inventory contra (cogs-audit scjz.21).
          allocationAvailability.set(
            entry.orderAllocationId,
            reduceSnapshotByQty(available, entry.qty),
          )
        }
      }

      for (const priorRefundLine of priorRefundLines) {
        for (const entry of parseCostLayerSnapshot(priorRefundLine.costLayerSnapshot)) {
          if (entry.source !== 'allocation' || !entry.orderAllocationId) continue
          const available = allocationAvailability.get(entry.orderAllocationId) ?? []
          // Qty-based, matching the shipment relief above, so allocation availability
          // tracking is consistent and order-independent in total relieved qty (scjz.21).
          allocationAvailability.set(
            entry.orderAllocationId,
            reduceSnapshotByQty(available, entry.qty),
          )
        }
      }

      for (const shipment of shipments) {
        const existing = shipmentsByOrder.get(shipment.orderId) ?? []
        existing.push(shipment)
        shipmentsByOrder.set(shipment.orderId, existing)
      }

      for (const [orderId, orderShipments] of shipmentsByOrder) {
        const firstShipment = orderShipments[0]
        // Wrap per-order processing so a single order with a COGS gap
        // (e.g. cross-warehouse allocation mismatch, missing cost layers)
        // is skipped with an error log instead of aborting the entire
        // daily batch and rolling back every other order's revenue
        // recognition and COGS posting.
        try {
        const orderLayerDecrements = new Map<string, number>()
        const deferredBase = Number(firstShipment.order.unearnedRevenueAmount ?? firstShipment.order.totalBase)
        const orderLineTotal = firstShipment.order.lines.reduce((sum, line) => sum + Number(line.totalBase), 0)
        const requirementsByLine = new Map(
          firstShipment.order.lines
            .filter((line) => !!line.productId)
            .map((line) => [
              line.id,
              requirementsMapToRows(expandFulfillmentRequirementsDecimal(line.productId!, 1, graph)),
            ]),
        )
        const orderLineById = new Map(firstShipment.order.lines.map((line) => [line.id, line]))
        const recognizedPreviously = firstShipment.order.shipments.reduce((sum, shipment) => (
          shipment.shipmentJournalDate ? sum + Number(shipment.revenueRecognizedAmount ?? 0) : sum
        ), 0)
        // scjz.68: subtract deferred revenue a refund credit note already reversed
        // out of the unearned account so the true-up never re-recognizes it.
        const postedUnearnedReversal = sumPostedUnearnedReversal(
          reversalSyncsByOrder.get(orderId) ?? [],
          settings.xero_unearned_revenue_account,
        )
        const remainingDeferred = round2(Math.max(0, deferredBase - recognizedPreviously - postedUnearnedReversal))
        let runningRevenue = 0

        // scjz.68: a fully-shipped terminal order trues up the remainder; a
        // PARTIALLY_REFUNDED order may too, but only once every shippable line is
        // shipped net of refunds. Either way hold the true-up until this batch holds
        // the order's final dispatched-but-unjournaled shipment, so a batch-window
        // split cannot recognize a later shipment's revenue early.
        let isTrueUpEligible = isFullyShippedTerminalStatus(firstShipment.order.status)
        if (!isTrueUpEligible && firstShipment.order.status === 'PARTIALLY_REFUNDED') {
          const combinedCoverageByLine = calculateCoverageByLine(requirementsByLine, [
            ...(shippedRowsByOrder.get(orderId) ?? []),
            ...(refundedUnshippedRowsByOrder.get(orderId) ?? []),
          ])
          isTrueUpEligible = isFullyShippedNetOfRefunds(
            firstShipment.order.lines
              .filter((line) => !!line.productId)
              .map((line) => ({
                orderedQty: Number(line.qty),
                coveredQty: combinedCoverageByLine.get(line.id) ?? 0,
              })),
          )
        }
        if (isTrueUpEligible) {
          isTrueUpEligible = batchContainsFinalUnjournaledShipment(
            firstShipment.order.shipments.filter((shipment) => shipment.status === 'SHIPPED'),
            new Set(orderShipments.map((shipment) => shipment.id)),
          )
        }

        for (let index = 0; index < orderShipments.length; index++) {
          const shipment = orderShipments[index]
          const shippedCoverageByLine = calculateCoverageByLine(
            requirementsByLine,
            shipment.lines.map((line) => ({
              lineId: line.lineId,
              productId: line.productId,
              qty: Number(line.qty),
            })),
          )
          const shipmentLineValue = [...shippedCoverageByLine.entries()].reduce((sum, [lineId, coveredQty]) => {
            const line = orderLineById.get(lineId)
            const lineQty = Number(line?.qty ?? 0)
            if (!line || lineQty <= 0 || coveredQty <= 0) return sum
            return sum + (Number(line.totalBase) * Math.min(coveredQty, lineQty)) / lineQty
          }, 0)

          const proportionalRevenue = orderLineTotal > 0
            ? round2((shipmentLineValue / orderLineTotal) * deferredBase)
            : 0
          const revenueProportion = recognizeShipmentRevenue({
            proportionalRevenue,
            remainingDeferred,
            runningRevenue,
            isFinalShipmentOfFullyShippedTerminalOrder:
              isTrueUpEligible && index === orderShipments.length - 1,
          })

          // COGS: prefer immutable shipment-line snapshots when present.
          // This ensures retrospective landed-cost updates flow through
          // stored shipment COGS without re-consuming inventory.
          const shipmentSnapshotsForLines = shipment.lines.map((line) => (
            parseCostLayerSnapshot(line.costLayerSnapshot)
          ))
          const hasPrecomputedSnapshots = shipmentSnapshotsForLines.some((entries) => entries.length > 0)
          const precomputedCogs = hasPrecomputedSnapshots
            ? roundQuantity(
                shipmentSnapshotsForLines.reduce(
                  (sum, entries) => addMoney(sum, sumCostLayerSnapshot(entries)),
                  toDecimal(0),
                ),
                2,
              )
            : toDecimal(shipment.cogsBatchAmount ?? 0)
          const precomputedCogsNumber = precomputedCogs.toNumber()
          if (hasPrecomputedSnapshots) {
            const missingSnapshotLines = shipment.lines.filter((line, lineIndex) => (
              Number(line.qty) > 0 && shipmentSnapshotsForLines[lineIndex].length === 0
            ))
            if (missingSnapshotLines.length > 0) {
              throw new Error(`Incomplete precomputed FIFO snapshots for shipment ${shipment.id}`)
            }
            const cogsBatchAmount = Number(shipment.cogsBatchAmount ?? 0)
            if (cogsBatchAmount > 0 && Math.abs(round2(cogsBatchAmount) - precomputedCogsNumber) > 0.01) {
              throw new Error(`Precomputed COGS mismatch for shipment ${shipment.id}: batch ${round2(cogsBatchAmount).toFixed(2)} != snapshots ${precomputedCogsNumber.toFixed(2)}`)
            }
          }

          // If no pre-computed COGS and no snapshots, fall back to the
          // legacy allocation-based consumption path for backward compat.
          if (!hasPrecomputedSnapshots && precomputedCogs.lte(0)) {
            const shipmentCostSnapshot: CostLayerSnapshotEntry[] = []
            for (const sl of shipment.lines) {
              let remainingQty = Number(sl.qty)
              const matchingAllocations = orderAllocations.filter((allocation) => (
                allocation.orderId === shipment.orderId
                && allocation.lineId === sl.lineId
                && allocation.productId === sl.productId
                && allocation.warehouseId === shipment.warehouseId
              ))

              for (const allocation of matchingAllocations) {
                if (remainingQty <= 0) break
                const availableEntries = allocationAvailability.get(allocation.id) ?? []
                const consumed = takeFromSnapshotEntries(availableEntries, remainingQty, {
                  orderAllocationId: allocation.id,
                  shipmentLineId: sl.id,
                  source: 'shipment',
                })
                shipmentCostSnapshot.push(...consumed.taken)
                remainingQty = consumed.remainingQty
                allocationAvailability.set(
                  allocation.id,
                  reduceSnapshotByCostLayer(
                    availableEntries,
                    consumed.taken.map((entry) => ({ costLayerId: entry.costLayerId, qty: entry.qty })),
                  ),
                )
              }

              if (remainingQty > 0.0000001) {
                throw new Error(`Missing allocated cost layers for shipment line ${sl.id}`)
              }
            }

            for (const entry of shipmentCostSnapshot) {
              orderLayerDecrements.set(
                entry.costLayerId,
                (orderLayerDecrements.get(entry.costLayerId) ?? 0) + toDecimal(entry.qty).toNumber(),
              )
            }

            const legacyCogs = roundQuantity(sumCostLayerSnapshot(shipmentCostSnapshot), 2)
            const legacyCogsNumber = legacyCogs.toNumber()
            totalRevenue += revenueProportion
            totalCogs = addMoney(totalCogs, legacyCogs)
            runningRevenue += revenueProportion
            shipmentResults.set(shipment.id, { revenue: revenueProportion, cogs: legacyCogsNumber })
            for (const sl of shipment.lines) {
              shipmentSnapshots.set(
                sl.id,
                shipmentCostSnapshot.filter((entry) => entry.shipmentLineId === sl.id),
              )
            }
          } else {
            // Pre-computed path — snapshots already stored on shipment lines
            totalRevenue += revenueProportion
            totalCogs = addMoney(totalCogs, precomputedCogs)
            runningRevenue += revenueProportion
            shipmentResults.set(shipment.id, { revenue: revenueProportion, cogs: precomputedCogsNumber })
            // Snapshots are already on the shipment lines — no need to
            // write them again or track layerDecrements (already consumed)
          }
        }
        // Only publish legacy FIFO decrements after the whole order succeeds.
        // Failed orders keep shipmentJournalDate null and must not mutate layer
        // balances before their next retry.
        for (const [layerId, decrement] of orderLayerDecrements) {
          layerDecrements.set(layerId, (layerDecrements.get(layerId) ?? 0) + decrement)
        }
        } catch (orderError) {
          // Per-order failure: skip this order, log the error, continue
          // with remaining orders so the batch isn't blocked by one bad order.
          const orderRef = firstShipment.order.orderNumber ?? firstShipment.order.externalOrderNumber ?? orderId.slice(0, 8)
          result.errors.push(`Group B order ${orderRef}: ${String(orderError)}`)
          // Remove any partially-accumulated results for this order's shipments
          for (const s of orderShipments) {
            const sr = shipmentResults.get(s.id)
            if (sr) {
              totalRevenue -= sr.revenue
              totalCogs = subtractMoney(totalCogs, sr.cogs)
              shipmentResults.delete(s.id)
            }
            for (const sl of s.lines) shipmentSnapshots.delete(sl.id)
          }
        }
      }

      const journalLines: JournalLinePayload[] = []
      const processedShipmentCount = shipmentResults.size
      const totalCogsNumber = round2Decimal(totalCogs)

      if (totalRevenue > 0) {
        journalLines.push(
          { accountCode: settings.xero_unearned_revenue_account, description: `Revenue recognition — ${processedShipmentCount} shipment(s)`, debit: totalRevenue },
          { accountCode: settings.xero_sales_account, description: `Revenue recognition — ${processedShipmentCount} shipment(s)`, credit: totalRevenue },
        )
      }

      if (totalCogsNumber > 0) {
        journalLines.push(
          { accountCode: settings.xero_cogs_account, description: `COGS — ${processedShipmentCount} shipment(s)`, debit: totalCogsNumber },
          { accountCode: settings.xero_allocated_inventory_account, description: `COGS — ${processedShipmentCount} shipment(s)`, credit: totalCogsNumber },
        )
      }

      if (journalLines.length > 0) {
        const referenceId = buildDailyBatchReferenceId('B', today, [...shipmentResults.keys()])
        await createPendingSyncLog(tx, {
          type: 'DAILY_BATCH_GROUP_B',
          referenceId,
          currency: baseCurrency,
          payload: {
            date: today,
            reference: `Shipment COGS ${today} ${referenceId.slice(-8)}`,
            narration: `Daily shipment batch: ${processedShipmentCount} shipment(s), revenue £${totalRevenue.toFixed(2)}, COGS £${totalCogsNumber.toFixed(2)}`,
            lines: journalLines,
            batchReferenceId: referenceId,
            batchDate: today,
            batchGroup: 'B',
            batchEntityCount: processedShipmentCount,
            splitBatch: result.hasMore.groupB,
            _postingMode: 'submitted',
          },
        })
      }

      // Only mark shipments that were successfully processed. Failed
      // orders had their results removed from shipmentResults by the
      // per-order catch block — those shipments must remain untouched
      // (shipmentJournalDate stays null) so the next batch run retries.
      for (const shipment of shipments) {
        const resultForShipment = shipmentResults.get(shipment.id)
        if (!resultForShipment) continue // failed order — skip, leave retryable
        for (const line of shipment.lines) {
          const lineSnapshot = shipmentSnapshots.get(line.id)
          if (lineSnapshot) {
            await tx.shipmentLine.update({
              where: { id: line.id },
              data: {
                costLayerSnapshot: lineSnapshot as never,
              },
            })
          }
        }
        const shipmentJournalDate = new Date()
        await tx.shipment.update({
          where: { id: shipment.id },
          data: {
            shipmentJournalDate,
            cogsBatchAmount: resultForShipment.cogs,
            revenueRecognizedAmount: resultForShipment.revenue,
          },
        })
        // khdw: record this shipment's dispatch COGS in the COGS subledger ledger as
        // an immutable, correctly-dated row. The reconciliation reads the ledger (not
        // the live, revaluation-mutated cogsBatchAmount), so a same-window dispatch +
        // revaluation can't double-count. Idempotent per shipment.
        await recordCogsSubledgerMovement(tx, {
          sourceType: 'DISPATCH',
          sourceRef: shipment.id,
          idempotencyKey: `dispatch:${shipment.id}`,
          baseDelta: resultForShipment.cogs,
          journalDate: shipmentJournalDate,
        })
      }

      for (const [layerId, decrement] of layerDecrements) {
        await tx.costLayer.update({
          where: { id: layerId },
          data: { remainingQty: { decrement } },
        })
      }

      return processedShipmentCount
    })
    if (groupBCount > 0) {
      result.groupB = groupBCount
    }
  } catch (e) {
    result.errors.push(`Group B error: ${String(e)}`)
  }

    // cogs-audit scjz.60.4: sweep the inventory subledger-vs-GL rounding residue to
    // the rounding-difference account. Runs after the batch postings so the GL/
    // subledger snapshots it compares already reflect this run's journals. Guarded:
    //  - a rounding-difference account must be configured (its absence is the opt-out;
    //    residue is then accepted within tolerance, no line posted),
    //  - the comparison must be available (both GL accounts mapped AND point-in-time
    //    snapshots exist for the as-of date), and
    //  - the gap must be pure accumulated rounding ('sweep'); a material gap ('flag')
    //    is surfaced by the reconciliation invariant and NEVER swept (sweeping it
    //    would mask a genuine misstatement).
    // Idempotent per as-of date via hasLiveDailyBatchLog, so re-running the batch the
    // same period never double-posts. A failure here must never abort the batch — the
    // core postings already committed.
    result.inventoryReconciliationSwept = null
    try {
      const reconciliation = await loadInventoryGlReconciliation()
      const journal = buildInventoryReconciliationSweepJournal(reconciliation, {
        inventoryAccount: settings.xero_inventory_account ?? '',
        roundingAccount: settings.xero_rounding_difference_account ?? '',
        currency: baseCurrency,
      })
      if (journal) {
        const referenceId = `INVRECON-${journal.date}`
        if (!(await hasLiveDailyBatchLog('DAILY_BATCH_INVENTORY_RECONCILIATION', referenceId))) {
          await db.$transaction((tx) => createPendingSyncLog(tx, {
            type: 'DAILY_BATCH_INVENTORY_RECONCILIATION',
            referenceId,
            currency: baseCurrency,
            payload: {
              date: journal.date,
              reference: `Inventory reconciliation ${journal.date}`,
              narration: journal.narration,
              lines: journal.lines,
              batchReferenceId: referenceId,
              batchDate: journal.date,
              batchGroup: 'INVENTORY_RECONCILIATION',
              _postingMode: 'submitted',
            },
          }))
          // delta is signed (subledger - GL); records both magnitude and direction.
          result.inventoryReconciliationSwept = journal.subledgerHigher ? journal.amount : -journal.amount
        }
      }
    } catch (e) {
      result.errors.push(`Inventory reconciliation sweep error: ${String(e)}`)
    }

    // khdw: COGS subledger-vs-GL rounding sweep — same guard/idempotency/safety as
    // the inventory sweep above, on the COGS account. Reconciles the PERIOD MOVEMENT
    // (Σ dispatch cogsBatchAmount − Σ refund cogsReversalBase over the GL window) vs
    // the COGS account GL movement; sub-penny → swept, material → flagged (never
    // swept). Independent of inventory; a failure must never abort the batch.
    result.cogsReconciliationSwept = null
    try {
      const reconciliation = await loadCogsGlReconciliation()
      const journal = buildCogsReconciliationSweepJournal(reconciliation, {
        cogsAccount: settings.xero_cogs_account ?? '',
        roundingAccount: settings.xero_rounding_difference_account ?? '',
        currency: baseCurrency,
      })
      if (journal) {
        const referenceId = `COGSRECON-${journal.date}`
        if (!(await hasLiveDailyBatchLog('DAILY_BATCH_COGS_RECONCILIATION', referenceId))) {
          await db.$transaction((tx) => createPendingSyncLog(tx, {
            type: 'DAILY_BATCH_COGS_RECONCILIATION',
            referenceId,
            currency: baseCurrency,
            payload: {
              date: journal.date,
              reference: `COGS reconciliation ${journal.date}`,
              narration: journal.narration,
              lines: journal.lines,
              batchReferenceId: referenceId,
              batchDate: journal.date,
              batchGroup: 'COGS_RECONCILIATION',
              _postingMode: 'submitted',
            },
          }))
          // delta is signed (subledger - GL); records both magnitude and direction.
          result.cogsReconciliationSwept = journal.subledgerHigher ? journal.amount : -journal.amount
        }
      }
    } catch (e) {
      result.errors.push(`COGS reconciliation sweep error: ${String(e)}`)
    }

    // Log summary
    if (result.groupA1 > 0 || result.groupA2 > 0 || result.groupB > 0) {
      await logActivity({
        entityType: 'SYSTEM',
        action: 'xero_daily_batch',
        tag: 'sync',
        level: 'INFO',
        description: `Daily batch: A1=${result.groupA1} deferred, A2=${result.groupA2} allocated, B=${result.groupB} shipped`,
        metadata: result,
        resolveUser: false,
      })
    }

    return result
  } finally {
    await db.$executeRaw`SELECT pg_advisory_unlock(${XERO_DAILY_BATCH_LOCK_KEY})`
  }
}
