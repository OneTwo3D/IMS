import { createHash } from 'crypto'
import { Prisma, ProductLifecycleStatus, ProductType, WmsBundleSyncDirection } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import type { WmsBundleComponent, WmsBundleDto, WmsBundleRef } from '@/lib/connectors/wms/types'
import { getWmsConnector } from '@/lib/connectors/wms/registry'

const BUNDLE_CONCURRENCY = 4
const CONNECTOR = 'mintsoft' as const
const BUNDLE_SENTINEL_PREFIX = 'pending:'
const BUNDLE_SENTINEL_STALE_MS = 10 * 60 * 1000

function buildBundleSentinel(): string {
  return `${BUNDLE_SENTINEL_PREFIX}${Date.now()}`
}

function isBundleSentinel(externalBundleId: string | null | undefined): boolean {
  return typeof externalBundleId === 'string' && externalBundleId.startsWith(BUNDLE_SENTINEL_PREFIX)
}

type BundleSyncScope = {
  warehouseId: string
  warehouseCode: string
  direction: WmsBundleSyncDirection
}

type BundleSyncCandidate = {
  id: string
  sku: string
  name: string
  type: ProductType
  lifecycleStatus: ProductLifecycleStatus
  productComponents: Array<{
    qty: Prisma.Decimal
    component: {
      id: string
      sku: string
      wmsProductLinks: Array<{ externalProductId: string }>
    }
  }>
  wmsProductLinks: Array<{ externalProductId: string }>
  wmsBundleLinks: Array<{
    id: string
    externalBundleId: string
    checksum: string | null
    lastSyncedAt: Date | null
  }>
}

export type MintsoftBundleSyncResult = {
  status: 'SKIPPED' | 'SYNCED' | 'CONFLICT' | 'SKIPPED_NOT_KIT' | 'ERROR'
  action: 'noop' | 'created' | 'conflict' | 'verified' | 'no_wms_product_link'
  reason: string
  productId: string
  sku: string
  checksum?: string
  externalBundleId?: string
}

export type MintsoftBundleVerifyResult = {
  status: 'SKIPPED' | 'SUCCEEDED' | 'PARTIAL' | 'FAILED'
  totalChecked: number
  synced: number
  conflicts: number
  skipped: number
  errors: number
  skippedReason?: string
}

const BUNDLE_CANDIDATE_SELECT = {
  id: true,
  sku: true,
  name: true,
  type: true,
  lifecycleStatus: true,
  productComponents: {
    orderBy: { sortOrder: 'asc' },
    select: {
      qty: true,
      component: {
        select: {
          id: true,
          sku: true,
          wmsProductLinks: {
            where: { connector: CONNECTOR },
            select: { externalProductId: true },
            take: 1,
          },
        },
      },
    },
  },
  wmsProductLinks: {
    where: { connector: CONNECTOR },
    select: { externalProductId: true },
    take: 1,
  },
  wmsBundleLinks: {
    where: { connector: CONNECTOR },
    select: {
      id: true,
      externalBundleId: true,
      checksum: true,
      lastSyncedAt: true,
    },
    take: 1,
  },
} satisfies Prisma.ProductSelect

function normalizeComponentSku(sku: string): string {
  return sku.trim().toUpperCase()
}

function roundQuantity(qty: number): number {
  return Math.round(qty * 10000) / 10000
}

function toNumber(value: Prisma.Decimal): number {
  return Number(value)
}

function toImsComponents(candidate: BundleSyncCandidate): WmsBundleComponent[] {
  return candidate.productComponents
    .filter((entry) => {
      const qty = toNumber(entry.qty)
      return entry.component.sku.trim() && Number.isFinite(qty) && qty > 0
    })
    .map((entry) => ({
      externalProductId: entry.component.wmsProductLinks[0]?.externalProductId ?? null,
      sku: entry.component.sku.trim(),
      quantity: roundQuantity(toNumber(entry.qty)),
    }))
    .sort((a, b) => normalizeComponentSku(a.sku).localeCompare(normalizeComponentSku(b.sku)))
}

export function computeBundleChecksum(params: {
  sku: string
  name: string
  packingInstructions: string | null
  components: WmsBundleComponent[]
}): string {
  const canonical = {
    sku: params.sku.trim(),
    name: params.name.trim(),
    packingInstructions: params.packingInstructions?.trim() ?? null,
    components: [...params.components]
      .sort((a, b) => normalizeComponentSku(a.sku).localeCompare(normalizeComponentSku(b.sku)))
      .map((component) => ({
        sku: component.sku.trim(),
        quantity: roundQuantity(component.quantity),
      })),
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

function componentsEqual(a: WmsBundleComponent[], b: WmsBundleComponent[]): boolean {
  if (a.length !== b.length) return false
  const sortedA = [...a].sort((x, y) => normalizeComponentSku(x.sku).localeCompare(normalizeComponentSku(y.sku)))
  const sortedB = [...b].sort((x, y) => normalizeComponentSku(x.sku).localeCompare(normalizeComponentSku(y.sku)))
  for (let i = 0; i < sortedA.length; i++) {
    if (normalizeComponentSku(sortedA[i].sku) !== normalizeComponentSku(sortedB[i].sku)) return false
    if (roundQuantity(sortedA[i].quantity) !== roundQuantity(sortedB[i].quantity)) return false
  }
  return true
}

async function getBundleSyncScopes(): Promise<BundleSyncScope[]> {
  const bindings = await db.externalWmsBinding.findMany({
    where: {
      connector: CONNECTOR,
      active: true,
      bundleSyncDirection: { not: WmsBundleSyncDirection.DISABLED },
      connection: { active: true },
    },
    orderBy: [{ warehouse: { code: 'asc' } }],
    select: {
      warehouseId: true,
      bundleSyncDirection: true,
      warehouse: { select: { code: true } },
    },
  })

  return bindings.map((binding) => ({
    warehouseId: binding.warehouseId,
    warehouseCode: binding.warehouse.code,
    direction: binding.bundleSyncDirection,
  }))
}

function resolveEffectiveDirection(scopes: BundleSyncScope[]): WmsBundleSyncDirection {
  if (scopes.some((scope) => scope.direction === WmsBundleSyncDirection.IMS_TO_WMS)) {
    return WmsBundleSyncDirection.IMS_TO_WMS
  }
  if (scopes.some((scope) => scope.direction === WmsBundleSyncDirection.WMS_TO_IMS)) {
    return WmsBundleSyncDirection.WMS_TO_IMS
  }
  return WmsBundleSyncDirection.DISABLED
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

async function upsertBundleConflict(params: {
  scopes: BundleSyncScope[]
  productId: string
  sku: string
  imsValue: string
  wmsValue: string | null
  message: string
}) {
  const now = new Date()
  for (const scope of params.scopes) {
    const updated = await db.wmsStockDiscrepancy.updateMany({
      where: {
        connector: CONNECTOR,
        warehouseId: scope.warehouseId,
        productId: params.productId,
        category: 'BUNDLE_DERIVATION_CONFLICT',
        status: 'OPEN',
      },
      data: {
        sku: params.sku,
        imsValue: params.imsValue,
        wmsValue: params.wmsValue,
        message: params.message,
        lastSeenAt: now,
        detectionCount: { increment: 1 },
        resolvedAt: null,
        resolvedBy: null,
        resolvedNote: null,
      },
    })

    if (updated.count > 0) continue

    try {
      await db.wmsStockDiscrepancy.create({
        data: {
          connector: CONNECTOR,
          warehouseId: scope.warehouseId,
          productId: params.productId,
          sku: params.sku,
          category: 'BUNDLE_DERIVATION_CONFLICT',
          status: 'OPEN',
          imsValue: params.imsValue,
          wmsValue: params.wmsValue,
          message: params.message,
          firstSeenAt: now,
          lastSeenAt: now,
        },
      })
      continue
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error
      }
    }

    await db.wmsStockDiscrepancy.updateMany({
      where: {
        connector: CONNECTOR,
        warehouseId: scope.warehouseId,
        productId: params.productId,
        category: 'BUNDLE_DERIVATION_CONFLICT',
        status: 'OPEN',
      },
      data: {
        sku: params.sku,
        imsValue: params.imsValue,
        wmsValue: params.wmsValue,
        message: params.message,
        lastSeenAt: now,
        detectionCount: { increment: 1 },
      },
    })
  }
}

async function resolveBundleConflict(scopes: BundleSyncScope[], productId: string) {
  if (scopes.length === 0) return
  await db.wmsStockDiscrepancy.updateMany({
    where: {
      connector: CONNECTOR,
      warehouseId: { in: scopes.map((scope) => scope.warehouseId) },
      productId,
      category: 'BUNDLE_DERIVATION_CONFLICT',
      status: 'OPEN',
    },
    data: {
      status: 'RESOLVED',
      resolvedAt: new Date(),
      resolvedNote: 'Resolved by Mintsoft bundle sync',
    },
  })
}

async function claimBundleCreateSlot(productId: string): Promise<
  | { kind: 'claimed'; linkId: string }
  | { kind: 'conflict'; reason: string }
> {
  try {
    const created = await db.wmsBundleLink.create({
      data: {
        connector: CONNECTOR,
        productId,
        externalBundleId: buildBundleSentinel(),
        checksum: null,
      },
      select: { id: true },
    })
    return { kind: 'claimed', linkId: created.id }
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error
  }

  const existing = await db.wmsBundleLink.findUnique({
    where: { connector_productId: { connector: CONNECTOR, productId } },
    select: { id: true, externalBundleId: true, checksum: true, updatedAt: true },
  })
  if (!existing) return { kind: 'conflict', reason: 'Bundle sync already in progress for this product.' }

  if (!isBundleSentinel(existing.externalBundleId)) {
    return { kind: 'conflict', reason: 'Bundle link already exists; follow the existing-link path.' }
  }

  const ageMs = Date.now() - existing.updatedAt.getTime()
  if (ageMs < BUNDLE_SENTINEL_STALE_MS) {
    return { kind: 'conflict', reason: 'Bundle sync already in progress for this product.' }
  }

  const stolen = await db.wmsBundleLink.updateMany({
    where: {
      id: existing.id,
      externalBundleId: existing.externalBundleId,
    },
    data: {
      externalBundleId: buildBundleSentinel(),
      checksum: null,
    },
  })
  if (stolen.count === 0) {
    return { kind: 'conflict', reason: 'Another worker reclaimed the stale bundle sentinel first.' }
  }
  return { kind: 'claimed', linkId: existing.id }
}

async function releaseBundleCreateSlot(linkId: string): Promise<void> {
  await db.wmsBundleLink.deleteMany({
    where: {
      id: linkId,
      externalBundleId: { startsWith: BUNDLE_SENTINEL_PREFIX },
    },
  }).catch((error) => {
    console.error('[mintsoft bundle sync] failed to release sentinel', linkId, error)
  })
}

async function finalizeBundleLink(linkId: string, params: {
  externalBundleId: string
  checksum: string
}): Promise<void> {
  await db.wmsBundleLink.update({
    where: { id: linkId },
    data: {
      externalBundleId: params.externalBundleId,
      checksum: params.checksum,
      lastSyncedAt: new Date(),
    },
  })
}

async function persistBundleLink(params: {
  productId: string
  externalBundleId: string
  checksum: string
}) {
  await db.wmsBundleLink.upsert({
    where: {
      connector_productId: {
        connector: CONNECTOR,
        productId: params.productId,
      },
    },
    create: {
      connector: CONNECTOR,
      productId: params.productId,
      externalBundleId: params.externalBundleId,
      checksum: params.checksum,
      lastSyncedAt: new Date(),
    },
    update: {
      externalBundleId: params.externalBundleId,
      checksum: params.checksum,
      lastSyncedAt: new Date(),
    },
  })
}

function summariseComponents(components: WmsBundleComponent[]): string {
  return components
    .map((component) => `${component.sku.trim()}×${roundQuantity(component.quantity)}`)
    .join(', ')
}

async function syncBundleInternal(
  productId: string,
  triggeredBy: 'cron' | 'product_mutation' | 'manual',
): Promise<MintsoftBundleSyncResult> {
  const scopes = await getBundleSyncScopes()
  if (scopes.length === 0) {
    return {
      status: 'SKIPPED',
      action: 'noop',
      reason: 'No active Mintsoft binding has bundle sync enabled.',
      productId,
      sku: '',
    }
  }

  const direction = resolveEffectiveDirection(scopes)
  if (direction === WmsBundleSyncDirection.DISABLED) {
    return {
      status: 'SKIPPED',
      action: 'noop',
      reason: 'Bundle sync is disabled for all Mintsoft bindings.',
      productId,
      sku: '',
    }
  }

  const candidate = (await db.product.findUnique({
    where: { id: productId },
    select: BUNDLE_CANDIDATE_SELECT,
  })) as BundleSyncCandidate | null

  if (!candidate) {
    return {
      status: 'SKIPPED',
      action: 'noop',
      reason: `Product ${productId} not found.`,
      productId,
      sku: '',
    }
  }

  if (candidate.type !== ProductType.KIT || candidate.lifecycleStatus === ProductLifecycleStatus.ARCHIVED) {
    await resolveBundleConflict(scopes, productId)
    return {
      status: 'SKIPPED_NOT_KIT',
      action: 'noop',
      reason: 'Bundle sync applies only to active KIT products.',
      productId,
      sku: candidate.sku,
    }
  }

  const imsComponents = toImsComponents(candidate)
  if (imsComponents.length === 0) {
    await upsertBundleConflict({
      scopes,
      productId,
      sku: candidate.sku,
      imsValue: '(no components)',
      wmsValue: null,
      message: 'KIT product has no components but bundle sync is enabled — Mintsoft may still retain the original bundle. Resolve by adding components, disabling bundle sync for this binding, or clearing the bundle in Mintsoft.',
    })
    return {
      status: 'CONFLICT',
      action: 'conflict',
      reason: 'KIT product has no components to sync.',
      productId,
      sku: candidate.sku,
    }
  }

  const wmsProductLink = candidate.wmsProductLinks[0] ?? null
  const rawBundleLink = candidate.wmsBundleLinks[0] ?? null
  const existingBundleLink = rawBundleLink && !isBundleSentinel(rawBundleLink.externalBundleId)
    ? rawBundleLink
    : null

  const dto: WmsBundleDto = {
    sku: candidate.sku,
    name: candidate.name,
    packingInstructions: null,
    components: imsComponents,
  }
  const checksum = computeBundleChecksum({
    sku: dto.sku,
    name: dto.name,
    packingInstructions: dto.packingInstructions,
    components: dto.components,
  })

  if (!wmsProductLink) {
    return {
      status: 'SKIPPED',
      action: 'no_wms_product_link',
      reason: 'Parent KIT product has no Mintsoft product link yet; sync product first.',
      productId,
      sku: candidate.sku,
    }
  }

  const connector = getWmsConnector(CONNECTOR)
  const missingLinks = imsComponents.filter((component) => !component.externalProductId)
  if (missingLinks.length > 0) {
    await upsertBundleConflict({
      scopes,
      productId,
      sku: candidate.sku,
      imsValue: summariseComponents(imsComponents),
      wmsValue: null,
      message: `Bundle components missing Mintsoft product links: ${missingLinks.map((component) => component.sku).join(', ')}.`,
    })
    return {
      status: 'CONFLICT',
      action: 'conflict',
      reason: 'Bundle components are missing Mintsoft product links.',
      productId,
      sku: candidate.sku,
      checksum,
    }
  }

  if (existingBundleLink && existingBundleLink.checksum === checksum) {
    await resolveBundleConflict(scopes, productId)
    return {
      status: 'SYNCED',
      action: 'noop',
      reason: 'Bundle is already in sync with Mintsoft.',
      productId,
      sku: candidate.sku,
      checksum,
      externalBundleId: existingBundleLink.externalBundleId,
    }
  }

  let remote: WmsBundleRef | null = null
  try {
    remote = existingBundleLink
      ? await connector.fetchBundle?.(existingBundleLink.externalBundleId) ?? null
      : await connector.fetchBundle?.(wmsProductLink.externalProductId) ?? null
  } catch (error) {
    return {
      status: 'ERROR',
      action: 'conflict',
      reason: error instanceof Error ? error.message : 'Mintsoft bundle fetch failed.',
      productId,
      sku: candidate.sku,
      checksum,
    }
  }

  if (remote) {
    const remoteComponents: WmsBundleComponent[] = remote.components.map((component) => ({
      externalProductId: component.externalProductId,
      sku: component.sku.trim(),
      quantity: roundQuantity(component.quantity),
    }))

    if (componentsEqual(remoteComponents, imsComponents)) {
      await persistBundleLink({
        productId,
        externalBundleId: remote.externalBundleId,
        checksum,
      })
      await resolveBundleConflict(scopes, productId)
      return {
        status: 'SYNCED',
        action: 'verified',
        reason: existingBundleLink
          ? 'Bundle composition confirmed against Mintsoft.'
          : 'Linked existing Mintsoft bundle that already matches IMS.',
        productId,
        sku: candidate.sku,
        checksum,
        externalBundleId: remote.externalBundleId,
      }
    }

    await upsertBundleConflict({
      scopes,
      productId,
      sku: candidate.sku,
      imsValue: summariseComponents(imsComponents),
      wmsValue: summariseComponents(remoteComponents),
      message: direction === WmsBundleSyncDirection.IMS_TO_WMS
        ? 'Mintsoft bundle composition differs from IMS and cannot be updated via the Mintsoft API.'
        : 'Mintsoft bundle composition differs from IMS. Resolve manually per WMS_TO_IMS review.',
    })

    return {
      status: 'CONFLICT',
      action: 'conflict',
      reason: 'Bundle composition diverged between IMS and Mintsoft.',
      productId,
      sku: candidate.sku,
      checksum,
      externalBundleId: remote.externalBundleId,
    }
  }

  if (direction !== WmsBundleSyncDirection.IMS_TO_WMS) {
    await upsertBundleConflict({
      scopes,
      productId,
      sku: candidate.sku,
      imsValue: summariseComponents(imsComponents),
      wmsValue: null,
      message: 'Mintsoft has no bundle for this KIT product but the binding direction is WMS_TO_IMS.',
    })
    return {
      status: 'CONFLICT',
      action: 'conflict',
      reason: 'Mintsoft has no bundle for this KIT and this binding is pull-only.',
      productId,
      sku: candidate.sku,
      checksum,
    }
  }

  if (!connector.createBundle) {
    return {
      status: 'ERROR',
      action: 'conflict',
      reason: 'Mintsoft connector does not support bundle creation in this environment.',
      productId,
      sku: candidate.sku,
      checksum,
    }
  }

  const claim = await claimBundleCreateSlot(productId)
  if (claim.kind === 'conflict') {
    return {
      status: 'SKIPPED',
      action: 'noop',
      reason: claim.reason,
      productId,
      sku: candidate.sku,
      checksum,
    }
  }

  let created: WmsBundleRef
  try {
    created = await connector.createBundle(dto)
  } catch (error) {
    await releaseBundleCreateSlot(claim.linkId)
    return {
      status: 'ERROR',
      action: 'conflict',
      reason: error instanceof Error ? error.message : 'Mintsoft bundle create failed.',
      productId,
      sku: candidate.sku,
      checksum,
    }
  }

  await finalizeBundleLink(claim.linkId, {
    externalBundleId: created.externalBundleId,
    checksum,
  })
  await resolveBundleConflict(scopes, productId)
  await logActivity({
    entityType: 'SYSTEM',
    entityId: productId,
    tag: 'sync',
    action: 'mintsoft_bundle_created',
    description: `Created Mintsoft bundle for ${candidate.sku}`,
    metadata: {
      productId,
      sku: candidate.sku,
      externalBundleId: created.externalBundleId,
      checksum,
      triggeredBy,
      componentCount: imsComponents.length,
    },
    resolveUser: false,
  })
  return {
    status: 'SYNCED',
    action: 'created',
    reason: 'Created new bundle in Mintsoft.',
    productId,
    sku: candidate.sku,
    checksum,
    externalBundleId: created.externalBundleId,
  }
}

export async function runBundleSyncForProduct(
  productId: string,
  triggeredBy: 'cron' | 'product_mutation' | 'manual' = 'manual',
): Promise<MintsoftBundleSyncResult> {
  return syncBundleInternal(productId, triggeredBy)
}

export async function runMintsoftBundleVerify(
  options?: { triggeredBy?: 'cron' | 'manual' },
): Promise<MintsoftBundleVerifyResult> {
  const triggeredBy = options?.triggeredBy ?? 'manual'
  const scopes = await getBundleSyncScopes()
  if (scopes.length === 0) {
    return {
      status: 'SKIPPED',
      totalChecked: 0,
      synced: 0,
      conflicts: 0,
      skipped: 0,
      errors: 0,
      skippedReason: 'No active Mintsoft binding has bundle sync enabled.',
    }
  }

  const candidates = await db.product.findMany({
    where: {
      type: ProductType.KIT,
      lifecycleStatus: { not: ProductLifecycleStatus.ARCHIVED },
      wmsProductLinks: { some: { connector: CONNECTOR } },
    },
    select: { id: true },
    orderBy: { sku: 'asc' },
  })

  const counters = { synced: 0, conflicts: 0, skipped: 0, errors: 0 }
  let index = 0

  async function worker(): Promise<void> {
    while (true) {
      const next = index++
      if (next >= candidates.length) return
      const candidate = candidates[next]
      try {
        const result = await syncBundleInternal(candidate.id, triggeredBy)
        if (result.status === 'SYNCED') counters.synced += 1
        else if (result.status === 'CONFLICT') counters.conflicts += 1
        else if (result.status === 'ERROR') counters.errors += 1
        else counters.skipped += 1
      } catch (error) {
        counters.errors += 1
        console.error('Mintsoft bundle verify failed', candidate.id, error)
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(BUNDLE_CONCURRENCY, candidates.length) }, () => worker()),
  )

  const totalChecked = candidates.length
  const status: MintsoftBundleVerifyResult['status'] = counters.errors > 0
    ? counters.synced + counters.conflicts > 0
      ? 'PARTIAL'
      : 'FAILED'
    : 'SUCCEEDED'

  await logActivity({
    entityType: 'SYSTEM',
    entityId: null,
    tag: 'sync',
    action: 'mintsoft_bundle_verify',
    description: `Mintsoft bundle verify ran across ${totalChecked} KIT product${totalChecked === 1 ? '' : 's'}`,
    metadata: {
      triggeredBy,
      totalChecked,
      ...counters,
    },
    resolveUser: false,
  })

  return {
    status,
    totalChecked,
    ...counters,
  }
}
