import { createHash } from 'crypto'
import { Prisma, ProductLifecycleStatus, ProductType } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import type { WmsProductDto, WmsProductRef } from '@/lib/connectors/wms/types'
import { getWmsConnector } from '@/lib/connectors/wms/registry'

const ELIGIBLE_PRODUCT_TYPES = [
  ProductType.SIMPLE,
  ProductType.VARIANT,
  ProductType.KIT,
  ProductType.BOM,
] as const
const ELIGIBLE_PRODUCT_TYPE_SET = new Set<ProductType>(ELIGIBLE_PRODUCT_TYPES)

type MintsoftProductSyncScope = {
  warehouseId: string
  warehouseCode: string
}

type ProductSyncCandidate = {
  id: string
  sku: string
  name: string
  description: string | null
  barcode: string | null
  hsCode: string | null
  countryOfOrigin: string | null
  weight: Prisma.Decimal | null
  widthCm: Prisma.Decimal | null
  heightCm: Prisma.Decimal | null
  depthCm: Prisma.Decimal | null
  imageUrl: string | null
  type: ProductType
  lifecycleStatus: ProductLifecycleStatus
  wmsProductLinks: Array<{
    id: string
    externalProductId: string
    payloadHash: string | null
    lastKnownBarcode: string | null
    lastSyncedAt: Date | null
    lastError: string | null
  }>
}

type BarcodePlan =
  | { kind: 'noop'; omitBarcode: true }
  | { kind: 'fill_wms_barcode'; omitBarcode: false }
  | { kind: 'match'; omitBarcode: false }
  | { kind: 'backfill'; omitBarcode: true }
  | { kind: 'conflict'; omitBarcode: true }

type ProductSyncContext = {
  product: ProductSyncCandidate
  scopes: MintsoftProductSyncScope[]
  connector: ReturnType<typeof getWmsConnector>
}

export type MintsoftProductSyncResult = {
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

type ProductSyncLineResult = {
  sku: string
  productId: string
  action: 'noop' | 'sync' | 'backfill' | 'conflict' | 'skip' | 'error'
  reason: string
  payload: Prisma.WmsSyncLogCreateManyInput['payload']
}

function toNullableNumber(value: Prisma.Decimal | null): number | null {
  return value == null ? null : Number(value)
}

function trimToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  return trimmed ? trimmed : null
}

export function isMintsoftProductEligible(product: Pick<ProductSyncCandidate, 'type' | 'lifecycleStatus'>): boolean {
  return ELIGIBLE_PRODUCT_TYPE_SET.has(product.type)
    && product.lifecycleStatus !== ProductLifecycleStatus.ARCHIVED
}

function toJsonPayload(value: unknown): Prisma.InputJsonValue {
  if (value == null) {
    return {}
  }

  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
}

export function buildMintsoftProductDto(product: ProductSyncCandidate): WmsProductDto {
  return {
    sku: product.sku,
    name: product.name,
    customsDescription: trimToNull(product.description),
    barcode: trimToNull(product.barcode),
    commodityCode: trimToNull(product.hsCode),
    countryOfManufacture: trimToNull(product.countryOfOrigin),
    weightKg: toNullableNumber(product.weight),
    heightCm: toNullableNumber(product.heightCm),
    widthCm: toNullableNumber(product.widthCm),
    depthCm: toNullableNumber(product.depthCm),
    imageUrl: trimToNull(product.imageUrl),
  }
}

export function hashMintsoftProductDto(product: WmsProductDto): string {
  return createHash('sha256').update(JSON.stringify(product)).digest('hex')
}

export function resolveMintsoftBarcodePlan(imsBarcode: string | null, wmsBarcode: string | null): BarcodePlan {
  if (!imsBarcode && !wmsBarcode) return { kind: 'noop', omitBarcode: true }
  if (imsBarcode && !wmsBarcode) return { kind: 'fill_wms_barcode', omitBarcode: false }
  if (!imsBarcode && wmsBarcode) return { kind: 'backfill', omitBarcode: true }
  if (imsBarcode === wmsBarcode) return { kind: 'match', omitBarcode: false }
  return { kind: 'conflict', omitBarcode: true }
}

export function resolveMintsoftExternalProductId(params: {
  authoritativeProduct: WmsProductRef | null
  existingExternalProductId: string | null
  existingLinkMatchesSku: boolean
}): string | null {
  if (params.authoritativeProduct?.externalId) {
    return params.authoritativeProduct.externalId
  }

  if (params.existingLinkMatchesSku) {
    return params.existingExternalProductId
  }

  return null
}

async function getMintsoftProductSyncScopes(): Promise<MintsoftProductSyncScope[]> {
  const bindings = await db.externalWmsBinding.findMany({
    where: {
      connector: 'mintsoft',
      active: true,
      connection: {
        active: true,
      },
    },
    orderBy: [{ warehouse: { code: 'asc' } }],
    select: {
      warehouseId: true,
      warehouse: {
        select: {
          code: true,
        },
      },
    },
  })

  return bindings.map((binding) => ({
    warehouseId: binding.warehouseId,
    warehouseCode: binding.warehouse.code,
  }))
}

async function getProductSyncCandidate(productId: string): Promise<ProductSyncCandidate | null> {
  return db.product.findUnique({
    where: { id: productId },
    select: {
      id: true,
      sku: true,
      name: true,
      description: true,
      barcode: true,
      hsCode: true,
      countryOfOrigin: true,
      weight: true,
      widthCm: true,
      heightCm: true,
      depthCm: true,
      imageUrl: true,
      type: true,
      lifecycleStatus: true,
      wmsProductLinks: {
        where: { connector: 'mintsoft' },
        select: {
          id: true,
          externalProductId: true,
          payloadHash: true,
          lastKnownBarcode: true,
          lastSyncedAt: true,
          lastError: true,
        },
        take: 1,
      },
    },
  })
}

async function listEligibleMintsoftProducts(): Promise<ProductSyncCandidate[]> {
  return db.product.findMany({
    where: {
      type: { in: [...ELIGIBLE_PRODUCT_TYPES] },
      lifecycleStatus: { not: ProductLifecycleStatus.ARCHIVED },
    },
    orderBy: { sku: 'asc' },
    select: {
      id: true,
      sku: true,
      name: true,
      description: true,
      barcode: true,
      hsCode: true,
      countryOfOrigin: true,
      weight: true,
      widthCm: true,
      heightCm: true,
      depthCm: true,
      imageUrl: true,
      type: true,
      lifecycleStatus: true,
      wmsProductLinks: {
        where: { connector: 'mintsoft' },
        select: {
          id: true,
          externalProductId: true,
          payloadHash: true,
          lastKnownBarcode: true,
          lastSyncedAt: true,
          lastError: true,
        },
        take: 1,
      },
    },
  })
}

function getExistingLink(product: ProductSyncCandidate) {
  return product.wmsProductLinks[0] ?? null
}

async function upsertMintsoftProductLink(params: {
  productId: string
  externalProductId: string
  payloadHash?: string | null
  lastKnownBarcode?: string | null
  metadata?: Prisma.InputJsonValue
  lastError?: string | null
  touchLastSyncedAt?: boolean
}) {
  await db.wmsProductLink.upsert({
    where: {
      connector_productId: {
        connector: 'mintsoft',
        productId: params.productId,
      },
    },
    create: {
      connector: 'mintsoft',
      productId: params.productId,
      externalProductId: params.externalProductId,
      payloadHash: params.payloadHash ?? null,
      lastKnownBarcode: params.lastKnownBarcode ?? null,
      metadata: params.metadata ?? Prisma.JsonNull,
      lastError: params.lastError ?? null,
      lastSyncedAt: params.touchLastSyncedAt ? new Date() : null,
    },
    update: {
      externalProductId: params.externalProductId,
      payloadHash: params.payloadHash ?? undefined,
      lastKnownBarcode: params.lastKnownBarcode ?? undefined,
      metadata: params.metadata ?? undefined,
      lastError: params.lastError ?? null,
      ...(params.touchLastSyncedAt ? { lastSyncedAt: new Date() } : {}),
    },
  })
}

async function clearMintsoftProductLinkError(productId: string) {
  await db.wmsProductLink.updateMany({
    where: {
      connector: 'mintsoft',
      productId,
    },
    data: {
      lastError: null,
    },
  })
}

async function recordMintsoftProductLinkError(productId: string, error: string) {
  await db.wmsProductLink.updateMany({
    where: {
      connector: 'mintsoft',
      productId,
    },
    data: {
      lastError: error,
    },
  })
}

async function upsertBarcodeConflict(params: {
  scopes: MintsoftProductSyncScope[]
  productId: string
  sku: string
  imsValue: string | null
  wmsValue: string | null
  message: string
}) {
  const now = new Date()
  for (const scope of params.scopes) {
    const updated = await db.wmsStockDiscrepancy.updateMany({
      where: {
        connector: 'mintsoft',
        warehouseId: scope.warehouseId,
        productId: params.productId,
        category: 'BARCODE_CONFLICT',
        status: 'OPEN',
      },
      data: {
        sku: params.sku,
        imsValue: params.imsValue,
        wmsValue: params.wmsValue,
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

    if (updated.count > 0) continue

    await db.wmsStockDiscrepancy.create({
      data: {
        connector: 'mintsoft',
        warehouseId: scope.warehouseId,
        productId: params.productId,
        sku: params.sku,
        category: 'BARCODE_CONFLICT',
        status: 'OPEN',
        imsValue: params.imsValue,
        wmsValue: params.wmsValue,
        message: params.message,
        firstSeenAt: now,
        lastSeenAt: now,
      },
    })
  }
}

async function resolveBarcodeConflict(scopes: MintsoftProductSyncScope[], productId: string) {
  const warehouseIds = scopes.map((scope) => scope.warehouseId)
  if (warehouseIds.length === 0) return

  await db.wmsStockDiscrepancy.updateMany({
    where: {
      connector: 'mintsoft',
      warehouseId: { in: warehouseIds },
      productId,
      category: 'BARCODE_CONFLICT',
      status: 'OPEN',
    },
    data: {
      status: 'RESOLVED',
      resolvedAt: new Date(),
      resolvedNote: 'Resolved by Mintsoft product sync',
    },
  })
}

async function createBarcodeBackfillAudit(params: {
  scopes: MintsoftProductSyncScope[]
  productId: string
  sku: string
  barcode: string
}) {
  const now = new Date()
  if (params.scopes.length === 0) return

  await db.wmsStockDiscrepancy.createMany({
    data: params.scopes.map((scope) => ({
      connector: 'mintsoft',
      warehouseId: scope.warehouseId,
      productId: params.productId,
      sku: params.sku,
      category: 'BARCODE_BACKFILLED_FROM_WMS',
      status: 'RESOLVED',
      imsValue: null,
      wmsValue: params.barcode,
      message: 'Mintsoft barcode was backfilled into IMS.',
      firstSeenAt: now,
      lastSeenAt: now,
      resolvedAt: now,
      resolvedNote: 'Backfilled from Mintsoft during product verify',
    })),
  })
}

async function getBarcodeOwner(barcode: string, excludeProductId: string) {
  return db.product.findFirst({
    where: {
      barcode,
      NOT: { id: excludeProductId },
    },
    select: {
      id: true,
      sku: true,
      name: true,
    },
  })
}

async function fetchAuthoritativeMintsoftProduct(context: ProductSyncContext): Promise<{
  product: WmsProductRef | null
  existingLinkMatchesSku: boolean
}> {
  const existingLink = getExistingLink(context.product)

  if (existingLink?.externalProductId) {
    const linked = await context.connector.fetchProduct(existingLink.externalProductId)
    if (linked?.sku === context.product.sku) {
      return {
        product: linked,
        existingLinkMatchesSku: true,
      }
    }
  }

  return {
    product: await context.connector.fetchProductBySku(context.product.sku),
    existingLinkMatchesSku: false,
  }
}

async function backfillBarcodeFromMintsoft(context: ProductSyncContext, barcode: string): Promise<{
  ok: true
} | {
  ok: false
  message: string
}> {
  try {
    await db.product.update({
      where: { id: context.product.id },
      data: { barcode },
    })

    await createBarcodeBackfillAudit({
      scopes: context.scopes,
      productId: context.product.id,
      sku: context.product.sku,
      barcode,
    })
    await resolveBarcodeConflict(context.scopes, context.product.id)

    return { ok: true }
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
      throw error
    }
  }

  const owner = await getBarcodeOwner(barcode, context.product.id)
  const ownerSummary = owner ? `${owner.sku} (${owner.id})` : 'another IMS product'
  const message = `Cannot backfill from WMS — barcode already owned by IMS product ${ownerSummary}.`

  await upsertBarcodeConflict({
    scopes: context.scopes,
    productId: context.product.id,
    sku: context.product.sku,
    imsValue: null,
    wmsValue: barcode,
    message,
  })

  return { ok: false, message }
}

async function syncOneMintsoftProduct(
  context: ProductSyncContext,
): Promise<ProductSyncLineResult> {
  if (!isMintsoftProductEligible(context.product)) {
    return {
      sku: context.product.sku,
      productId: context.product.id,
      action: 'skip',
      reason: 'Product type or lifecycle is not eligible for Mintsoft sync',
      payload: toJsonPayload(null),
    }
  }

  const existingLink = getExistingLink(context.product)
  const authoritativeLookup = await fetchAuthoritativeMintsoftProduct(context)
  const authoritative = authoritativeLookup.product
  let dto = buildMintsoftProductDto(context.product)
  let payloadHash = hashMintsoftProductDto(dto)
  const wmsBarcode = trimToNull(authoritative?.barcode)
  const barcodePlan = resolveMintsoftBarcodePlan(dto.barcode, wmsBarcode)

  if (barcodePlan.kind === 'backfill' && wmsBarcode) {
    const backfill = await backfillBarcodeFromMintsoft(context, wmsBarcode)
    if (!backfill.ok) {
      const knownExternalProductId = authoritative?.externalId ?? existingLink?.externalProductId
      if (knownExternalProductId) {
        await upsertMintsoftProductLink({
          productId: context.product.id,
          externalProductId: knownExternalProductId,
          lastKnownBarcode: wmsBarcode,
          metadata: toJsonPayload(authoritative?.raw),
          lastError: backfill.message,
        })
      } else {
        await recordMintsoftProductLinkError(context.product.id, backfill.message)
      }
      return {
        sku: context.product.sku,
        productId: context.product.id,
        action: 'conflict',
        reason: backfill.message,
        payload: toJsonPayload(authoritative?.raw),
      }
    }

    dto = {
      ...dto,
      barcode: wmsBarcode,
    }
    payloadHash = hashMintsoftProductDto(dto)
  }

  if (barcodePlan.kind === 'conflict') {
    await upsertBarcodeConflict({
      scopes: context.scopes,
      productId: context.product.id,
      sku: context.product.sku,
      imsValue: dto.barcode,
      wmsValue: wmsBarcode,
      message: `IMS barcode ${dto.barcode} differs from Mintsoft barcode ${wmsBarcode}. Barcode was not overwritten.`,
    })
  } else {
    await resolveBarcodeConflict(context.scopes, context.product.id)
  }

  const externalProductId = resolveMintsoftExternalProductId({
    authoritativeProduct: authoritative,
    existingExternalProductId: existingLink?.externalProductId ?? null,
    existingLinkMatchesSku: authoritativeLookup.existingLinkMatchesSku,
  })
  const unchanged = Boolean(
    externalProductId
      && existingLink?.payloadHash
      && existingLink.payloadHash === payloadHash
      && (
        barcodePlan.kind === 'noop'
        || barcodePlan.kind === 'match'
        || barcodePlan.kind === 'backfill'
      ),
  )

  if (unchanged) {
    if (!externalProductId) {
      throw new Error('Mintsoft product sync could not resolve a stable external product ID')
    }

    await upsertMintsoftProductLink({
      productId: context.product.id,
      externalProductId,
      payloadHash,
      lastKnownBarcode: wmsBarcode ?? dto.barcode,
      metadata: toJsonPayload(authoritative?.raw),
      lastError: null,
    })
    await clearMintsoftProductLinkError(context.product.id)

    return {
      sku: context.product.sku,
      productId: context.product.id,
      action: barcodePlan.kind === 'backfill' ? 'backfill' : 'noop',
      reason: barcodePlan.kind === 'backfill'
        ? 'Barcode backfilled from Mintsoft; no remote update required'
        : 'Product already matches Mintsoft payload',
      payload: toJsonPayload(authoritative?.raw),
    }
  }

  if (barcodePlan.kind === 'conflict' && externalProductId && existingLink?.payloadHash === payloadHash) {
    await upsertMintsoftProductLink({
      productId: context.product.id,
      externalProductId,
      payloadHash,
      lastKnownBarcode: wmsBarcode ?? dto.barcode,
      metadata: toJsonPayload(authoritative?.raw),
      lastError: null,
    })
    await clearMintsoftProductLinkError(context.product.id)

    return {
      sku: context.product.sku,
      productId: context.product.id,
      action: 'conflict',
      reason: 'Barcode conflict recorded; non-barcode payload already matches Mintsoft',
      payload: toJsonPayload(authoritative?.raw),
    }
  }

  const synced = await context.connector.upsertProduct(dto, {
    externalProductId,
    omitBarcode: barcodePlan.omitBarcode,
  })

  await upsertMintsoftProductLink({
    productId: context.product.id,
    externalProductId: synced.externalId,
    payloadHash,
    lastKnownBarcode: trimToNull(synced.barcode) ?? dto.barcode,
    metadata: toJsonPayload(synced.raw),
    lastError: null,
    touchLastSyncedAt: true,
  })
  await clearMintsoftProductLinkError(context.product.id)

  return {
    sku: context.product.sku,
    productId: context.product.id,
    action: barcodePlan.kind === 'backfill'
      ? 'backfill'
      : barcodePlan.kind === 'conflict'
        ? 'conflict'
        : 'sync',
    reason: barcodePlan.kind === 'conflict'
      ? 'Barcode conflict preserved; Mintsoft product was updated without changing the barcode'
      : synced.externalId === externalProductId
        ? 'Mintsoft product updated'
        : 'Mintsoft product created',
    payload: toJsonPayload(synced.raw),
  }
}

async function completeProductJob(
  jobId: string,
  status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED',
  counters: Omit<MintsoftProductSyncResult, 'jobId' | 'status' | 'skippedReason'>,
  summary: Prisma.InputJsonValue,
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

async function createProductJob(
  type: 'PRODUCT_SYNC' | 'PRODUCT_VERIFY',
  triggeredBy: string,
  summary: Prisma.InputJsonValue,
  warehouseId: string | null,
) {
  return db.wmsSyncJob.create({
    data: {
      connector: 'mintsoft',
      type,
      status: 'RUNNING',
      warehouseId,
      startedAt: new Date(),
      triggeredBy,
      summary,
    },
    select: { id: true },
  })
}

async function runMintsoftProductSyncBatch(
  products: ProductSyncCandidate[],
  type: 'PRODUCT_SYNC' | 'PRODUCT_VERIFY',
  triggeredBy: string,
  summary: Prisma.InputJsonValue,
): Promise<MintsoftProductSyncResult> {
  const scopes = await getMintsoftProductSyncScopes()
  if (scopes.length === 0) {
    return {
      jobId: null,
      status: 'SKIPPED',
      totalChecked: 0,
      matched: 0,
      mismatched: 0,
      corrected: 0,
      skipped: 0,
      errors: 0,
      skippedReason: 'No active Mintsoft warehouse binding is configured',
    }
  }

  const connector = getWmsConnector('mintsoft')
  const warehouseScopeSummary = scopes.map((scope) => scope.warehouseCode)
  const job = await createProductJob(
    type,
    triggeredBy,
    summary,
    scopes.length === 1 ? scopes[0]!.warehouseId : null,
  )
  const counters = {
    totalChecked: 0,
    matched: 0,
    mismatched: 0,
    corrected: 0,
    skipped: 0,
    errors: 0,
  }
  const logs: Prisma.WmsSyncLogCreateManyInput[] = []

  try {
    for (const product of products) {
      counters.totalChecked += 1

      try {
        const line = await syncOneMintsoftProduct({
          product,
          scopes,
          connector,
        })

        if (line.action === 'skip') counters.skipped += 1
        if (line.action === 'noop') counters.matched += 1
        if (line.action === 'sync' || line.action === 'backfill') counters.corrected += 1
        if (line.action === 'conflict') counters.mismatched += 1

        logs.push({
          jobId: job.id,
          sku: line.sku,
          productId: line.productId,
          action: line.action,
          reason: line.reason,
          payload: line.payload,
        })
      } catch (error) {
        counters.errors += 1
        const message = error instanceof Error ? error.message : 'Mintsoft product sync failed'
        await recordMintsoftProductLinkError(product.id, message)
        logs.push({
          jobId: job.id,
          sku: product.sku,
          productId: product.id,
          action: 'error',
          reason: message,
          payload: toJsonPayload(null),
        })
      }
    }

    if (logs.length > 0) {
      await db.wmsSyncLog.createMany({ data: logs })
    }

    const status: 'SUCCEEDED' | 'PARTIAL' = counters.errors > 0 ? 'PARTIAL' : 'SUCCEEDED'
    await completeProductJob(job.id, status, counters, {
      ...(summary as Prisma.InputJsonObject),
      warehouseScopes: warehouseScopeSummary,
    })

    await logActivity({
      entityType: 'SYSTEM',
      tag: 'sync',
      action: type === 'PRODUCT_VERIFY' ? 'mintsoft_product_verify' : 'mintsoft_product_sync',
      description: `Mintsoft ${type === 'PRODUCT_VERIFY' ? 'product verify' : 'product sync'} completed: ${counters.totalChecked} checked, ${counters.corrected} changed, ${counters.mismatched} conflicts, ${counters.errors} errors.`,
      metadata: {
        jobId: job.id,
        warehouseScopes: warehouseScopeSummary,
        ...counters,
      },
      resolveUser: false,
    })

    return {
      jobId: job.id,
      status,
      ...counters,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Mintsoft product sync failed'
    await completeProductJob(job.id, 'FAILED', counters, {
      ...(summary as Prisma.InputJsonObject),
      warehouseScopes: warehouseScopeSummary,
      error: message,
    })

    await logActivity({
      entityType: 'SYSTEM',
      tag: 'sync',
      action: type === 'PRODUCT_VERIFY' ? 'mintsoft_product_verify_failed' : 'mintsoft_product_sync_failed',
      level: 'ERROR',
      description: `Mintsoft ${type === 'PRODUCT_VERIFY' ? 'product verify' : 'product sync'} failed: ${message}`,
      metadata: {
        jobId: job.id,
        warehouseScopes: warehouseScopeSummary,
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

export async function runMintsoftProductSyncForProduct(
  productId: string,
  triggeredBy: string,
): Promise<MintsoftProductSyncResult> {
  const product = await getProductSyncCandidate(productId)
  if (!product) {
    return {
      jobId: null,
      status: 'FAILED',
      totalChecked: 0,
      matched: 0,
      mismatched: 0,
      corrected: 0,
      skipped: 0,
      errors: 1,
      skippedReason: 'Product not found',
    }
  }

  return runMintsoftProductSyncBatch([product], 'PRODUCT_SYNC', triggeredBy, {
    mode: 'single',
    productId,
    sku: product.sku,
  } satisfies Prisma.InputJsonObject)
}

export async function runMintsoftProductVerify(triggeredBy: string): Promise<MintsoftProductSyncResult> {
  const products = await listEligibleMintsoftProducts()
  if (products.length === 0) {
    return {
      jobId: null,
      status: 'SKIPPED',
      totalChecked: 0,
      matched: 0,
      mismatched: 0,
      corrected: 0,
      skipped: 0,
      errors: 0,
      skippedReason: 'No eligible IMS products found for Mintsoft verify',
    }
  }

  return runMintsoftProductSyncBatch(products, 'PRODUCT_VERIFY', triggeredBy, {
    mode: 'verify',
    totalCandidates: products.length,
  } satisfies Prisma.InputJsonObject)
}

export async function runMintsoftProductVerifyForSkus(
  skus: string[],
  triggeredBy: string,
): Promise<MintsoftProductSyncResult> {
  const normalizedSkus = Array.from(
    new Set(
      skus
        .map((sku) => sku.trim())
        .filter(Boolean),
    ),
  )

  if (normalizedSkus.length === 0) {
    return {
      jobId: null,
      status: 'SKIPPED',
      totalChecked: 0,
      matched: 0,
      mismatched: 0,
      corrected: 0,
      skipped: 0,
      errors: 0,
      skippedReason: 'No eligible IMS products found for scoped Mintsoft verify',
    }
  }

  const products = await db.product.findMany({
    where: {
      sku: { in: normalizedSkus },
      type: { in: [...ELIGIBLE_PRODUCT_TYPES] },
      lifecycleStatus: { not: ProductLifecycleStatus.ARCHIVED },
    },
    orderBy: { sku: 'asc' },
    select: {
      id: true,
      sku: true,
      name: true,
      description: true,
      barcode: true,
      hsCode: true,
      countryOfOrigin: true,
      weight: true,
      widthCm: true,
      heightCm: true,
      depthCm: true,
      imageUrl: true,
      type: true,
      lifecycleStatus: true,
      wmsProductLinks: {
        where: { connector: 'mintsoft' },
        select: {
          id: true,
          externalProductId: true,
          payloadHash: true,
          lastKnownBarcode: true,
          lastSyncedAt: true,
          lastError: true,
        },
        take: 1,
      },
    },
  })

  if (products.length === 0) {
    return {
      jobId: null,
      status: 'SKIPPED',
      totalChecked: 0,
      matched: 0,
      mismatched: 0,
      corrected: 0,
      skipped: 0,
      errors: 0,
      skippedReason: 'No eligible IMS products found for scoped Mintsoft verify',
    }
  }

  return runMintsoftProductSyncBatch(products, 'PRODUCT_VERIFY', triggeredBy, {
    mode: 'verify',
    totalCandidates: products.length,
    skuScope: normalizedSkus,
  } satisfies Prisma.InputJsonObject)
}
