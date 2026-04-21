import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { getWmsConnector } from '@/lib/connectors/wms/registry'
import type { WmsReturnRecord } from '@/lib/connectors/wms/types'
import { resolveOrderForExternalFulfillment } from '@/lib/fulfillment/external-fulfillment'

type ReturnsBinding = {
  id: string
  externalWarehouseId: string
  warehouseId: string
  returnsMode: 'DISABLED' | 'POLL' | 'WEBHOOK'
  active: boolean
  connection: {
    active: boolean
  }
  warehouse: {
    code: string
    name: string
  }
}

const RETURNS_SYNC_DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000
const RETURNS_SYNC_OVERLAP_MS = 15 * 60 * 1000

export type MintsoftReturnsInboxRow = {
  id: string
  externalReturnId: string
  orderId: string | null
  orderNumber: string | null
  externalOrderNumber: string | null
  productId: string | null
  sku: string | null
  qty: string | null
  reason: string | null
  reference: string | null
  warehouseCode: string | null
  status: string
  receivedAt: string | null
  updatedAt: string
}

export type MintsoftReturnsSyncResult = {
  jobId: string | null
  status: 'SKIPPED' | 'SUCCEEDED' | 'PARTIAL' | 'FAILED'
  totalChecked: number
  matched: number
  mismatched: number
  corrected: number
  skipped: number
  errors: number
  skippedReason?: string
}

function trimToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function parseReceivedAt(value: string | null): Date | null {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed : null
}

export function selectMintsoftReturnBinding(
  record: Pick<WmsReturnRecord, 'externalWarehouseId'>,
  bindings: ReturnsBinding[],
): ReturnsBinding | null {
  const externalWarehouseId = trimToNull(record.externalWarehouseId)
  if (externalWarehouseId) {
    return bindings.find((binding) => binding.externalWarehouseId === externalWarehouseId) ?? null
  }

  return bindings.length === 1 ? bindings[0] ?? null : null
}

export async function resolveMintsoftReturnOrder(
  reference: string | null,
): Promise<{ id: string; orderNumber: string | null; externalOrderNumber: string | null } | null> {
  const normalizedReference = trimToNull(reference)
  if (!normalizedReference) return null

  return resolveOrderForExternalFulfillment('mintsoft', { externalOrderNumber: normalizedReference })
}

async function getReturnsBindings(): Promise<ReturnsBinding[]> {
  return db.externalWmsBinding.findMany({
    where: {
      connector: 'mintsoft',
      active: true,
      returnsMode: 'POLL',
      connection: {
        active: true,
      },
    },
    select: {
      id: true,
      externalWarehouseId: true,
      warehouseId: true,
      returnsMode: true,
      active: true,
      connection: {
        select: {
          active: true,
        },
      },
      warehouse: {
        select: {
          code: true,
          name: true,
        },
      },
    },
  }) as Promise<ReturnsBinding[]>
}

function getSummaryDate(summary: Prisma.JsonValue | null | undefined, key: string): Date | null {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return null
  const value = summary[key]
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed : null
}

async function getReturnsSyncSince(): Promise<Date> {
  const lastJob = await db.wmsSyncJob.findFirst({
    where: {
      connector: 'mintsoft',
      type: 'RETURNS_SYNC',
      status: {
        in: ['SUCCEEDED', 'PARTIAL'],
      },
      finishedAt: {
        not: null,
      },
    },
    orderBy: { finishedAt: 'desc' },
    select: {
      startedAt: true,
      finishedAt: true,
      summary: true,
    },
  })

  const cursor = getSummaryDate(lastJob?.summary, 'nextCursor')
    ?? getSummaryDate(lastJob?.summary, 'maxReceivedAt')
    ?? lastJob?.startedAt
    ?? lastJob?.finishedAt
    ?? new Date(Date.now() - RETURNS_SYNC_DEFAULT_LOOKBACK_MS)

  return new Date(cursor.getTime() - RETURNS_SYNC_OVERLAP_MS)
}

function buildReturnsSummary(input: {
  bindingCount: number
  since: Date
  created: number
  updated: number
  nextCursor: Date
  maxReceivedAt: Date | null
}): Prisma.InputJsonObject {
  return {
    bindingCount: input.bindingCount,
    since: input.since.toISOString(),
    created: input.created,
    updated: input.updated,
    nextCursor: input.nextCursor.toISOString(),
    ...(input.maxReceivedAt ? { maxReceivedAt: input.maxReceivedAt.toISOString() } : {}),
  }
}

async function completeReturnsJob(
  jobId: string,
  status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED',
  counters: Omit<MintsoftReturnsSyncResult, 'jobId' | 'status' | 'skippedReason'>,
  summary: Prisma.InputJsonObject,
) {
  await db.wmsSyncJob.update({
    where: { id: jobId },
    data: {
      status,
      finishedAt: new Date(),
      totalChecked: counters.totalChecked,
      matched: counters.matched,
      mismatched: counters.mismatched,
      corrected: counters.corrected,
      skipped: counters.skipped,
      errors: counters.errors,
      summary,
    },
  })
}

export function mapMintsoftReturnsInboxRow(row: {
  id: string
  externalReturnId: string
  sku: string | null
  qty: Prisma.Decimal | null
  reason: string | null
  reference: string | null
  status: string
  receivedAt: Date | null
  updatedAt: Date
  order: {
    id: string
    orderNumber: string | null
    externalOrderNumber: string | null
  } | null
  product: {
    id: string
  } | null
  warehouse: {
    code: string
  } | null
}): MintsoftReturnsInboxRow {
  return {
    id: row.id,
    externalReturnId: row.externalReturnId,
    orderId: row.order?.id ?? null,
    orderNumber: row.order?.orderNumber ?? null,
    externalOrderNumber: row.order?.externalOrderNumber ?? null,
    productId: row.product?.id ?? null,
    sku: row.sku,
    qty: row.qty?.toString() ?? null,
    reason: row.reason,
    reference: row.reference,
    warehouseCode: row.warehouse?.code ?? null,
    status: row.status,
    receivedAt: row.receivedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  }
}

export async function runMintsoftReturnsSync(triggeredBy: string): Promise<MintsoftReturnsSyncResult> {
  const bindings = await getReturnsBindings()
  if (bindings.length === 0) {
    return {
      jobId: null,
      status: 'SKIPPED',
      totalChecked: 0,
      matched: 0,
      mismatched: 0,
      corrected: 0,
      skipped: 0,
      errors: 0,
      skippedReason: 'No active Mintsoft bindings are configured for returns polling',
    }
  }

  const since = await getReturnsSyncSince()
  const startedAt = new Date()
  const job = await db.wmsSyncJob.create({
    data: {
      connector: 'mintsoft',
      type: 'RETURNS_SYNC',
      status: 'RUNNING',
      startedAt,
      triggeredBy,
      summary: buildReturnsSummary({
        bindingCount: bindings.length,
        since,
        created: 0,
        updated: 0,
        nextCursor: startedAt,
        maxReceivedAt: null,
      }),
    },
    select: { id: true },
  })

  const counters = {
    totalChecked: 0,
    matched: 0,
    mismatched: 0,
    corrected: 0,
    skipped: 0,
    errors: 0,
  }
  const logRows: Prisma.WmsSyncLogCreateManyInput[] = []
  let createdCount = 0
  let updatedCount = 0
  let maxReceivedAtSeen: Date | null = null
  let earliestFailedReceivedAt: Date | null = null

  try {
    const connector = getWmsConnector('mintsoft')
    const returns = await connector.pollReturns(since)

    for (const record of returns) {
      counters.totalChecked += 1

      try {
        const [order, product] = await Promise.all([
          resolveMintsoftReturnOrder(record.orderReference),
          trimToNull(record.sku)
            ? db.product.findUnique({
                where: { sku: record.sku as string },
                select: { id: true },
              })
            : Promise.resolve(null),
        ])
        const binding = selectMintsoftReturnBinding(record, bindings)
        const reference = trimToNull(record.orderReference)
        const reason = trimToNull(record.reason)
        const qty = record.qty == null ? null : new Prisma.Decimal(record.qty)
        const receivedAt = parseReceivedAt(record.receivedAt)
        const now = new Date()
        if (receivedAt && (!maxReceivedAtSeen || receivedAt > maxReceivedAtSeen)) {
          maxReceivedAtSeen = receivedAt
        }

        const existing = await db.wmsReturnsInbox.findUnique({
          where: {
            connector_externalReturnId: {
              connector: 'mintsoft',
              externalReturnId: record.externalReturnId,
            },
          },
          select: { id: true },
        })

        const saved = await db.wmsReturnsInbox.upsert({
          where: {
            connector_externalReturnId: {
              connector: 'mintsoft',
              externalReturnId: record.externalReturnId,
            },
          },
          create: {
            connector: 'mintsoft',
            externalReturnId: record.externalReturnId,
            orderId: order?.id ?? null,
            productId: product?.id ?? null,
            sku: trimToNull(record.sku),
            qty,
            reason,
            reference,
            warehouseId: binding?.warehouseId ?? null,
            receivedAt,
            rawPayload: (record.raw ?? {}) as Prisma.InputJsonValue,
            status: 'NEW',
          },
          update: {
            orderId: order?.id ?? null,
            productId: product?.id ?? null,
            sku: trimToNull(record.sku),
            qty,
            reason,
            reference,
            warehouseId: binding?.warehouseId ?? null,
            receivedAt,
            rawPayload: (record.raw ?? {}) as Prisma.InputJsonValue,
            updatedAt: now,
          },
          select: {
            id: true,
            productId: true,
            sku: true,
          },
        })

        if (existing) {
          updatedCount += 1
        } else {
          createdCount += 1
          counters.corrected += 1
        }

        const fullyMatched = Boolean(order) && Boolean(product)
        if (fullyMatched) {
          counters.matched += 1
        } else {
          counters.mismatched += 1
        }

        logRows.push({
          jobId: job.id,
          sku: saved.sku,
          productId: saved.productId,
          action: existing ? 'updated' : 'created',
          reason: [
            order ? null : 'ORDER_UNMATCHED',
            product ? null : 'SKU_UNMATCHED',
            binding ? null : 'WAREHOUSE_UNMATCHED',
          ].filter(Boolean).join(',') || 'MATCHED',
          payload: (record.raw ?? {}) as Prisma.InputJsonValue,
        })
      } catch (error) {
        counters.errors += 1
        const failedReceivedAt = parseReceivedAt(record.receivedAt)
        if (failedReceivedAt && (!earliestFailedReceivedAt || failedReceivedAt < earliestFailedReceivedAt)) {
          earliestFailedReceivedAt = failedReceivedAt
        }
        logRows.push({
          jobId: job.id,
          sku: trimToNull(record.sku),
          productId: null,
          action: 'error',
          reason: error instanceof Error ? error.message : 'Mintsoft returns sync error',
          payload: (record.raw ?? {}) as Prisma.InputJsonValue,
        })
      }
    }

    if (logRows.length > 0) {
      await db.wmsSyncLog.createMany({ data: logRows })
    }

    const status: 'SUCCEEDED' | 'PARTIAL' = counters.errors > 0 ? 'PARTIAL' : 'SUCCEEDED'
    const nextCursor = earliestFailedReceivedAt && earliestFailedReceivedAt < startedAt
      ? earliestFailedReceivedAt
      : startedAt
    const summary = buildReturnsSummary({
      bindingCount: bindings.length,
      since,
      created: createdCount,
      updated: updatedCount,
      nextCursor,
      maxReceivedAt: maxReceivedAtSeen,
    })

    await completeReturnsJob(job.id, status, counters, summary)
    await logActivity({
      entityType: 'SYSTEM',
      tag: 'sync',
      action: 'mintsoft_returns_sync',
      description: `Mintsoft returns sync completed: ${counters.totalChecked} checked, ${createdCount} new inbox items, ${counters.errors} errors.`,
      metadata: {
        jobId: job.id,
        ...summary,
      },
      resolveUser: false,
    })

    return {
      jobId: job.id,
      status,
      totalChecked: counters.totalChecked,
      matched: counters.matched,
      mismatched: counters.mismatched,
      corrected: counters.corrected,
      skipped: counters.skipped,
      errors: counters.errors,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Mintsoft returns sync failed'
    await completeReturnsJob(job.id, 'FAILED', counters, buildReturnsSummary({
      bindingCount: bindings.length,
      since,
      created: createdCount,
      updated: updatedCount,
      nextCursor: since,
      maxReceivedAt: maxReceivedAtSeen,
    }))
    await logActivity({
      entityType: 'SYSTEM',
      tag: 'sync',
      action: 'mintsoft_returns_sync_failed',
      level: 'ERROR',
      description: `Mintsoft returns sync failed: ${message}`,
      metadata: {
        jobId: job.id,
      },
      resolveUser: false,
    })

    return {
      jobId: job.id,
      status: 'FAILED',
      totalChecked: counters.totalChecked,
      matched: counters.matched,
      mismatched: counters.mismatched,
      corrected: counters.corrected,
      skipped: counters.skipped,
      errors: counters.errors + 1,
      skippedReason: message,
    }
  }
}
