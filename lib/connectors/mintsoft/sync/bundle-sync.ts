import { createHash } from 'crypto'
import { Prisma, ProductLifecycleStatus, ProductType, WmsBundleSyncDirection } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { recordWmsMutationEvent } from '@/lib/domain/wms/mutation-audit'
import type { WmsBundleComponent, WmsBundleDto, WmsBundleRef } from '@/lib/connectors/wms/types'
import { getWmsConnector } from '@/lib/connectors/wms/registry'
import {
  BUNDLE_CLAIM_CHANGED_TEXT,
  BUNDLE_CLAIM_LEASE_MS,
  bundleLateResultText,
  BUNDLE_CLAIM_PREFIX,
  buildBundleSentClaimValue,
  buildBundleUnsentClaimValue,
  bundleCreateMaybeSentText,
  bundleStuckClaimText,
  classifyBundleCreateFailure,
  isBundleSentClaimValue,
  type BundleReconciliation,
} from './bundle-create-outcome'

const BUNDLE_CONCURRENCY = 4
const CONNECTOR = 'mintsoft' as const
const BUNDLE_SENTINEL_PREFIX = BUNDLE_CLAIM_PREFIX
const BUNDLE_SENTINEL_STALE_MS = BUNDLE_CLAIM_LEASE_MS

function buildBundleSentinel(): string {
  return buildBundleUnsentClaimValue()
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
  | { kind: 'claimed'; linkId: string; claimValue: string }
  | { kind: 'stuck' }
  | { kind: 'conflict'; reason: string }
> {
  try {
    const claimValue = buildBundleSentinel()
    const created = await db.wmsBundleLink.create({
      data: {
        connector: CONNECTOR,
        productId,
        externalBundleId: claimValue,
        checksum: null,
      },
      select: { id: true },
    })
    return { kind: 'claimed', linkId: created.id, claimValue }
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

  // A claim whose create may have reached Mintsoft is never taken over by the clock: see bundle-create-outcome.ts.
  if (isBundleSentClaimValue(existing.externalBundleId)) return { kind: 'stuck' }

  const ageMs = Date.now() - existing.updatedAt.getTime()
  if (ageMs < BUNDLE_SENTINEL_STALE_MS) {
    return { kind: 'conflict', reason: 'Bundle sync already in progress for this product.' }
  }

  // An UNSENT claim (its worker stopped before the request was handed over) may be taken over once its lease has expired.
  const claimValue = buildBundleSentinel()
  const stolen = await db.wmsBundleLink.updateMany({
    where: {
      id: existing.id,
      externalBundleId: existing.externalBundleId,
    },
    data: {
      externalBundleId: claimValue,
      checksum: null,
    },
  })
  if (stolen.count === 0) {
    return { kind: 'conflict', reason: 'Another worker reclaimed the stale bundle sentinel first.' }
  }
  return { kind: 'claimed', linkId: existing.id, claimValue }
}

/**
 * Mark the claim SENT immediately before the create request is handed over. If this cannot be recorded the
 * request is not sent: an unmarked claim must mean that nothing was sent.
 */
async function markBundleClaimSent(claim: { linkId: string; claimValue: string }): Promise<string | null> {
  const sentValue = buildBundleSentClaimValue()
  const marked = await db.wmsBundleLink.updateMany({
    where: { id: claim.linkId, externalBundleId: claim.claimValue },
    data: { externalBundleId: sentValue },
  })
  return marked.count === 1 ? sentValue : null
}

/**
 * THE FENCE, immediately before the request: one conditional update that succeeds only if the claim still exists with
 * exactly the value this worker wrote, and that refreshes its updatedAt (which is what an operator's release compares
 * with the in-flight window). A worker that was paused past a release, and a retry that has claimed the product since,
 * fails here and sends nothing.
 */
async function reverifyBundleClaim(claim: { linkId: string }, sentValue: string): Promise<boolean> {
  const held = await db.wmsBundleLink.updateMany({
    where: { id: claim.linkId, externalBundleId: sentValue },
    data: { externalBundleId: sentValue },
  })
  return held.count === 1
}

async function releaseBundleCreateSlot(linkId: string, claimValue: string): Promise<void> {
  // Only THIS worker's own claim: a row an operator has resolved or another run has taken is not ours to delete.
  await db.wmsBundleLink.deleteMany({
    where: {
      id: linkId,
      externalBundleId: claimValue,
    },
  }).catch((error) => {
    console.error('[mintsoft bundle sync] failed to release sentinel', linkId, error)
  })
}

async function finalizeBundleLink(linkId: string, expectedClaimValue: string, params: {
  externalBundleId: string
  checksum: string
}): Promise<{ success: boolean; stale: boolean; lastError: Error | null }> {
  let lastError: Error | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // Conditional on THIS worker's own claim value: a row that has changed (an operator linked it, another run
      // took it) is not overwritten by a late finish.
      const written = await db.wmsBundleLink.updateMany({
        where: { id: linkId, externalBundleId: expectedClaimValue },
        data: {
          externalBundleId: params.externalBundleId,
          checksum: params.checksum,
          lastSyncedAt: new Date(),
        },
      })
      if (written.count !== 1) return { success: false, stale: true, lastError: null }
      return { success: true, stale: false, lastError: null }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)))
      }
    }
  }
  return { success: false, stale: false, lastError }
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

function normalizeRemoteComponents(bundle: WmsBundleRef): WmsBundleComponent[] {
  return bundle.components.map((component) => ({
    externalProductId: component.externalProductId,
    sku: component.sku.trim(),
    quantity: roundQuantity(component.quantity),
  }))
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

  const pushScopes = scopes.filter((scope) => scope.direction === WmsBundleSyncDirection.IMS_TO_WMS)
  const pullScopes = scopes.filter((scope) => scope.direction === WmsBundleSyncDirection.WMS_TO_IMS)
  if (pushScopes.length === 0 && pullScopes.length === 0) {
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

  if (!wmsProductLink && !existingBundleLink) {
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

  const fetchKey = existingBundleLink?.externalBundleId ?? wmsProductLink?.externalProductId ?? null
  let remote: WmsBundleRef | null = null
  if (fetchKey) {
    try {
      remote = await connector.fetchBundle?.(fetchKey) ?? null
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
  }

  if (remote && (remote.unreadableComponentCount ?? 0) > 0) {
    // An INCOMPLETE answer is not a bundle IMS can compare: entries left out could be the ones that differ.
    return {
      status: 'ERROR',
      action: 'conflict',
      reason: `Mintsoft returned the bundle for ${candidate.sku} with ${remote.unreadableComponentCount} component entr${remote.unreadableComponentCount === 1 ? 'y' : 'ies'} IMS could not read, so it was not compared, linked or created again.`,
      productId,
      sku: candidate.sku,
      checksum,
    }
  }

  if (remote) {
    const remoteComponents = normalizeRemoteComponents(remote)

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

    if (pushScopes.length > 0) {
      await upsertBundleConflict({
        scopes: pushScopes,
        productId,
        sku: candidate.sku,
        imsValue: summariseComponents(imsComponents),
        wmsValue: summariseComponents(remoteComponents),
        message: 'Mintsoft bundle composition differs from IMS and cannot be updated via the Mintsoft API.',
      })
    }
    if (pullScopes.length > 0) {
      await upsertBundleConflict({
        scopes: pullScopes,
        productId,
        sku: candidate.sku,
        imsValue: summariseComponents(imsComponents),
        wmsValue: summariseComponents(remoteComponents),
        message: 'Mintsoft bundle composition differs from IMS. Update IMS to match Mintsoft or resolve the discrepancy manually.',
      })
    }

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

  if (pushScopes.length === 0) {
    await upsertBundleConflict({
      scopes: pullScopes,
      productId,
      sku: candidate.sku,
      imsValue: summariseComponents(imsComponents),
      wmsValue: null,
      message: 'Mintsoft has no bundle for this KIT product but every active binding is pull-only.',
    })
    return {
      status: 'CONFLICT',
      action: 'conflict',
      reason: 'Mintsoft has no bundle for this KIT and every active binding is pull-only.',
      productId,
      sku: candidate.sku,
      checksum,
    }
  }

  if (!wmsProductLink) {
    return {
      status: 'SKIPPED',
      action: 'no_wms_product_link',
      reason: 'Parent KIT product has no Mintsoft product link yet; push the product before creating a bundle.',
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

  if (claim.kind === 'stuck') {
    // An earlier create may have reached Mintsoft and the lookup above found no bundle. That proves nothing, and
    // neither does the time that has passed: keep the claim, send nothing, and put it where an operator resolves it.
    const stuckText = bundleStuckClaimText(candidate.sku, { kind: 'not-found' })
    await upsertBundleConflict({
      scopes: pushScopes,
      productId,
      sku: candidate.sku,
      imsValue: summariseComponents(imsComponents),
      wmsValue: null,
      message: stuckText,
    })
    return {
      status: 'CONFLICT',
      action: 'conflict',
      reason: stuckText,
      productId,
      sku: candidate.sku,
      checksum,
    }
  }

  const sentValue = await markBundleClaimSent(claim)
  if (!sentValue) {
    return {
      status: 'SKIPPED',
      action: 'noop',
      reason: 'The bundle claim changed hands before the create was sent; nothing was sent.',
      productId,
      sku: candidate.sku,
      checksum,
    }
  }

  let created: WmsBundleRef
  try {
    created = await connector.createBundle(dto, { beforeSend: () => reverifyBundleClaim(claim, sentValue) })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Mintsoft bundle create failed.'
    const failureKind = classifyBundleCreateFailure(message)
    if (failureKind === 'claim-changed') {
      await recordWmsMutationEvent({
        connector: 'mintsoft', direction: 'OUTBOUND', action: 'bundle_create', outcome: 'FAILED',
        entityType: 'PRODUCT', entityId: productId,
        summary: `Mintsoft bundle create for ${candidate.sku}: claim changed, create not sent`,
        after: { sku: candidate.sku, claimId: claim.linkId, sent: false },
        error: BUNDLE_CLAIM_CHANGED_TEXT,
      })
      return { status: 'SKIPPED', action: 'noop', reason: BUNDLE_CLAIM_CHANGED_TEXT, productId, sku: candidate.sku, checksum }
    }
    if (failureKind === 'not-sent') {
      // The installation's own hold refused the request before it left: Mintsoft received nothing, so
      // the claim is released and the next run is free to try.
      await releaseBundleCreateSlot(claim.linkId, sentValue)
      await recordWmsMutationEvent({
        connector: 'mintsoft', direction: 'OUTBOUND', action: 'bundle_create', outcome: 'FAILED',
        entityType: 'PRODUCT', entityId: productId,
        summary: `Mintsoft bundle create failed for ${candidate.sku}`,
        error: message,
      })
      return {
        status: 'ERROR',
        action: 'conflict',
        reason: message,
        productId,
        sku: candidate.sku,
        checksum,
      }
    }

    // MAYBE SENT. The claim is KEPT: releasing it would let the next run send a second create over one that
    // may have landed. Look the bundle up (a read) and bind it only if it is the bundle IMS wants.
    let reconciliation: BundleReconciliation
    let found: WmsBundleRef | null = null
    try {
      found = await connector.fetchBundle?.(wmsProductLink.externalProductId) ?? null
      if (!found) {
        reconciliation = { kind: 'not-found' }
      } else if ((found.unreadableComponentCount ?? 0) > 0) {
        reconciliation = { kind: 'incomplete', detail: `${found.unreadableComponentCount} component entr${found.unreadableComponentCount === 1 ? 'y' : 'ies'} could not be read` }
      } else {
        reconciliation = componentsEqual(normalizeRemoteComponents(found), imsComponents) ? { kind: 'bound' } : { kind: 'differs' }
      }
    } catch (lookupError) {
      reconciliation = { kind: 'lookup-failed', detail: lookupError instanceof Error ? lookupError.message : 'lookup failed' }
    }
    const text = bundleCreateMaybeSentText(candidate.sku, message, reconciliation)

    if (reconciliation.kind === 'bound' && found) {
      const finalizeFound = await finalizeBundleLink(claim.linkId, sentValue, { externalBundleId: found.externalBundleId, checksum })
      await recordWmsMutationEvent({
        connector: 'mintsoft', direction: 'OUTBOUND', action: 'bundle_create', outcome: finalizeFound.success ? 'SUCCEEDED' : 'FAILED',
        entityType: 'PRODUCT', entityId: productId, externalId: found.externalBundleId,
        summary: `Mintsoft bundle create for ${candidate.sku} was uncertain; the bundle was found in Mintsoft and linked`,
        after: { externalBundleId: found.externalBundleId, sku: candidate.sku, checksum },
        error: finalizeFound.success ? null : (finalizeFound.lastError?.message ?? 'bundle link finalize failed'),
      })
      if (finalizeFound.stale) {
        const lateText = bundleLateResultText(candidate.sku, found.externalBundleId)
        return { status: 'ERROR', action: 'conflict', reason: lateText, productId, sku: candidate.sku, checksum, externalBundleId: found.externalBundleId }
      }
      if (finalizeFound.success) {
        await resolveBundleConflict(scopes, productId)
        return {
          status: 'SYNCED',
          action: 'verified',
          reason: text,
          productId,
          sku: candidate.sku,
          checksum,
          externalBundleId: found.externalBundleId,
        }
      }
      // The link could not be written, so the claim still stands; the next run finds the bundle again.
      return {
        status: 'ERROR',
        action: 'conflict',
        reason: `${text} The link could not be saved (${finalizeFound.lastError?.message ?? 'unknown error'}); the next run finds the bundle again.`,
        productId,
        sku: candidate.sku,
        checksum,
        externalBundleId: found.externalBundleId,
      }
    }

    await recordWmsMutationEvent({
      connector: 'mintsoft', direction: 'OUTBOUND', action: 'bundle_create', outcome: 'FAILED',
      entityType: 'PRODUCT', entityId: productId,
      summary: `Mintsoft bundle create for ${candidate.sku} may have been sent; the claim is kept and nothing will be sent again until the bundle has been looked up`,
      after: { sku: candidate.sku, checksum, claimKept: true, lookup: reconciliation.kind },
      error: text,
    })
    // Surface it where operators resolve bundle problems, with the one sentence that says what to do.
    await upsertBundleConflict({
      scopes: pushScopes,
      productId,
      sku: candidate.sku,
      imsValue: summariseComponents(imsComponents),
      wmsValue: reconciliation.kind === 'differs' && found ? summariseComponents(normalizeRemoteComponents(found)) : null,
      message: reconciliation.kind === 'differs' && found
        ? 'Mintsoft bundle composition differs from IMS and cannot be updated via the Mintsoft API.'
        : text,
    })
    return {
      status: reconciliation.kind === 'differs' ? 'CONFLICT' : 'ERROR',
      action: 'conflict',
      reason: text,
      productId,
      sku: candidate.sku,
      checksum,
      ...(found ? { externalBundleId: found.externalBundleId } : {}),
    }
  }

  const finalize = await finalizeBundleLink(claim.linkId, sentValue, {
    externalBundleId: created.externalBundleId,
    checksum,
  })
  // Emitted after the finalize boundary (Codex r2): a remote create whose
  // local link failed is flagged, not reported as an unqualified success.
  await recordWmsMutationEvent({
    connector: 'mintsoft', direction: 'OUTBOUND', action: 'bundle_create', outcome: 'SUCCEEDED',
    entityType: 'PRODUCT', entityId: productId, externalId: created.externalBundleId,
    summary: finalize.stale
      ? bundleLateResultText(candidate.sku, created.externalBundleId)
      : finalize.success
      ? `Mintsoft bundle created for ${candidate.sku}`
      : `Mintsoft bundle created for ${candidate.sku}, but the local link finalize failed — manual recovery required`,
    after: { externalBundleId: created.externalBundleId, sku: candidate.sku, checksum, ...(finalize.success ? {} : { linkPersistFailed: true }) },
    error: finalize.success ? null : (finalize.lastError?.message ?? 'bundle link finalize failed'),
  })
  if (finalize.stale) {
    // The claim changed hands while the request was out: do not write over whatever is there now. The bundle Mintsoft
    // returned is recorded for reconciliation.
    const lateText = bundleLateResultText(candidate.sku, created.externalBundleId)
    await logActivity({
      entityType: 'SYSTEM',
      entityId: productId,
      tag: 'sync',
      action: 'mintsoft_bundle_create_late_result',
      description: lateText,
      metadata: { productId, sku: candidate.sku, externalBundleId: created.externalBundleId, checksum, triggeredBy, linkId: claim.linkId },
      level: 'ERROR',
      resolveUser: false,
    })
    return { status: 'ERROR', action: 'conflict', reason: lateText, productId, sku: candidate.sku, checksum, externalBundleId: created.externalBundleId }
  }
  if (!finalize.success) {
    await logActivity({
      entityType: 'SYSTEM',
      entityId: productId,
      tag: 'sync',
      action: 'mintsoft_bundle_finalize_failed',
      description: `Mintsoft bundle for ${candidate.sku} was created remotely but the local link finalize failed — manual recovery required`,
      metadata: {
        productId,
        sku: candidate.sku,
        externalBundleId: created.externalBundleId,
        checksum,
        triggeredBy,
        linkId: claim.linkId,
        error: finalize.lastError?.message ?? 'unknown',
      },
      level: 'ERROR',
      resolveUser: false,
    })
    return {
      status: 'ERROR',
      action: 'conflict',
      reason: `Mintsoft bundle was created remotely but the local link finalize failed: ${finalize.lastError?.message ?? 'unknown error'}`,
      productId,
      sku: candidate.sku,
      checksum,
      externalBundleId: created.externalBundleId,
    }
  }
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
      OR: [
        { wmsProductLinks: { some: { connector: CONNECTOR } } },
        { wmsBundleLinks: { some: { connector: CONNECTOR } } },
      ],
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
