import { createHash } from 'crypto'
import { Prisma, ProductLifecycleStatus, ProductType } from '@/app/generated/prisma/client'
import type { WmsDiscrepancyCategory } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { recordWmsMutationEvent } from '@/lib/domain/wms/mutation-audit'
import { isDeclarableCn8, normalizeCn8 } from '@/lib/trade/cn-validate'
import { DEFAULT_COUNTRY_OF_ORIGIN, toIsoCountryCode } from '@/lib/countries'
import type { WmsClearableProductField, WmsClearClaim, WmsProductDto, WmsProductRef } from '@/lib/connectors/wms/types'
import { isOutboundWriteHeldText } from '@/lib/security/outbound-write-hold-constants'
import { getWmsConnector } from '@/lib/connectors/wms/registry'
import { mintsoftProducerSeam } from '../producer-seam'
import { snapshotFromRow } from '@/lib/domain/product-content/store'
import { classifyIdentifierCodes, sameCode, type IdentifierCodes } from '@/lib/domain/products/identifiers'
import { readProductIdentifierSplitEnabled } from '@/lib/domain/products/identifier-split-flag'
import { classifyMintsoftProductRecord } from '../api/normalizers'
import { mintsoftCanClear, mintsoftFieldIsEmpty } from '../api/client'
import { readMintsoftProductParityEnabled } from '../settings/product-parity'
import { applyMintsoftProductParity, readMintsoftProductCost, redactMintsoftCostPrice } from './product-parity'
import { runMintsoftParentSkuDeletionPass, withMetadataConfirmation, type ParentDeletionCounters } from './parent-sku-deletion'
import { describeContentRun, syncMintsoftProductContent, type ContentLineResult } from './product-content-sync'

const ELIGIBLE_PRODUCT_TYPES = [
  ProductType.SIMPLE,
  ProductType.VARIANT,
  ProductType.KIT,
  ProductType.BOM,
] as const
const ELIGIBLE_PRODUCT_TYPE_SET = new Set<ProductType>(ELIGIBLE_PRODUCT_TYPES)
const PRODUCT_VERIFY_BATCH_SIZE = 100
const PRODUCT_SYNC_CONCURRENCY = 5
export const ELIGIBLE_PRODUCT_WHERE = {
  type: { in: [...ELIGIBLE_PRODUCT_TYPES] },
  lifecycleStatus: { not: ProductLifecycleStatus.ARCHIVED },
} satisfies Prisma.ProductWhereInput
export const PRODUCT_SYNC_CANDIDATE_SELECT = {
  id: true,
  sku: true,
  name: true,
  barcode: true,
  mpn: true,
  hsCode: true,
  countryOfOrigin: true,
  customsDescription: true,
  weight: true,
  widthCm: true,
  heightCm: true,
  depthCm: true,
  imageUrl: true,
  type: true,
  lifecycleStatus: true,
  // Read for the parity setting only (a variation inherits its parent's name base, weight and dimensions); unused while it is off.
  parent: { select: { name: true, weight: true, widthCm: true, heightCm: true, depthCm: true } },
  content: { select: { shortDescription: true, longDescription: true, images: true } },
  // Customs fields emptied in IMS (value -> nothing): the only evidence that Mintsoft's copy is to be cleared.
  customsClears: { select: { field: true, createdAt: true } },
  wmsProductLinks: {
    where: { connector: 'mintsoft' },
    select: {
      id: true,
      externalProductId: true,
      payloadHash: true,
      lastKnownBarcode: true,
      lastSyncedAt: true,
      lastError: true,
      contentSyncState: true,
    },
    take: 1,
  },
} satisfies Prisma.ProductSelect

type MintsoftProductSyncScope = {
  warehouseId: string
  warehouseCode: string
}

export type ProductSyncCandidate = {
  id: string
  sku: string
  name: string
  barcode: string | null
  /** Only read when the product identifier split is on. */
  mpn?: string | null
  hsCode: string | null
  countryOfOrigin: string | null
  customsDescription: string | null
  weight: Prisma.Decimal | null
  widthCm: Prisma.Decimal | null
  heightCm: Prisma.Decimal | null
  depthCm: Prisma.Decimal | null
  imageUrl: string | null
  type: ProductType
  lifecycleStatus: ProductLifecycleStatus
  parent?: { name: string; weight: Prisma.Decimal | null; widthCm: Prisma.Decimal | null; heightCm: Prisma.Decimal | null; depthCm: Prisma.Decimal | null } | null
  content?: { shortDescription: string | null; longDescription: string | null; images: Prisma.JsonValue } | null
  /** Customs fields emptied in IMS; absent on a candidate built without the relation (none). */
  customsClears?: Array<{ field: string; createdAt?: Date }>
  wmsProductLinks: Array<{
    id: string
    externalProductId: string
    payloadHash: string | null
    lastKnownBarcode: string | null
    lastSyncedAt: Date | null
    lastError: string | null
    contentSyncState?: Prisma.JsonValue | null
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
  /** The id of the sync job this product is processed in; stamped on the link only when its metadata is confirmed in Mintsoft. */
  runId?: string
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
  /** What the content step did in this run (descriptions and picture; see product-content-sync.ts). */
  content?: MintsoftContentCounters
  /**
   * Products whose upsert the producer-side hold kept as a shadow this run: nothing was sent and no link was stamped, so the
   * next run offers them again. PRESENT ONLY WHEN NON-ZERO, so a run on an installation that does not enforce the hold returns
   * exactly what it always did.
   */
  shadowed?: number
  /** PRESENT ONLY WHEN NON-ZERO: errors that are writes the outbound-write hold refused (also counted in `errors`). */
  outboundHeld?: number
  /**
   * What the parent SKU deletion pass did after a succeeded verify run (o3d-zvec.20). PRESENT ONLY WHEN THE PASS RAN (it is behind its own
   * setting, default off). Its `errors` are also counted in `errors`, and a pass that threw is counted there as one, so the cron reports it.
   */
  parentDeletion?: ParentDeletionCounters
}

export type MintsoftContentCounters = {
  /** Fields accepted by Mintsoft. */
  sent: number
  /** Products whose content was recorded as a shadow this run (nothing was sent). */
  shadowed: number
  /** Products whose live send the outbound-write hold refused (nothing left IMS). */
  held: number
  errors: number
}

type ProductSyncLineResult = {
  sku: string
  productId: string
  action: 'noop' | 'sync' | 'backfill' | 'conflict' | 'skip' | 'error' | 'shadow'
  reason: string
  payload: Prisma.WmsSyncLogCreateManyInput['payload']
  remoteUpdated: boolean
}

function toNullableNumber(value: Prisma.Decimal | null): number | null {
  return value == null ? null : Number(value)
}

function trimToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  return trimmed ? trimmed : null
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

export function isMintsoftProductEligible(product: Pick<ProductSyncCandidate, 'type' | 'lifecycleStatus'>): boolean {
  return ELIGIBLE_PRODUCT_TYPE_SET.has(product.type)
    && product.lifecycleStatus !== ProductLifecycleStatus.ARCHIVED
}

function toJsonPayload(value: unknown): Prisma.InputJsonValue {
  if (value == null) {
    return {}
  }

  if (value instanceof Date) {
    return value.toISOString()
  }

  if (Array.isArray(value)) {
    return value.map((entry) => (
      entry === undefined
        ? null
        : toJsonPayload(entry)
    )) as Prisma.InputJsonValue
  }

  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, entry instanceof Date ? entry.toISOString() : toJsonPayload(entry)]),
    ) as Prisma.InputJsonValue
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }

  return String(value)
}

export function buildMintsoftProductDto(product: ProductSyncCandidate): WmsProductDto {
  return {
    sku: product.sku,
    name: product.name,
    customsDescription: trimToNull(product.customsDescription),
    barcode: trimToNull(product.barcode),
    commodityCode: trimToNull(product.hsCode),
    // bhdm.7: canonicalise the origin at the WMS boundary; a blank or nonblank-invalid value declares the CN
    // default (an invalid one is also raised as an INVALID_COUNTRY_OF_ORIGIN discrepancy by the caller, never a
    // silent false declaration). See resolveMintsoftCountryOfManufacture.
    countryOfManufacture: resolveMintsoftCountryOfManufacture(product.countryOfOrigin).countryOfManufacture,
    weightKg: toNullableNumber(product.weight),
    heightCm: toNullableNumber(product.heightCm),
    widthCm: toNullableNumber(product.widthCm),
    depthCm: toNullableNumber(product.depthCm),
    imageUrl: trimToNull(product.imageUrl),
  }
}

/**
 * Gate a commodity (HS/CN) code before it is declared to the WMS. A code that is not a
 * declarable 2026 CN8 (see isDeclarableCn8) is omitted — commodityCode is nulled and the
 * offending value returned as invalidCnCode so the caller can raise a discrepancy. A valid
 * code is normalised to its canonical 8 digits (punctuation/spacing stripped) so the WMS
 * always receives e.g. "01012100", never "0101.2100". An absent code passes through as null.
 */
/**
 * bhdm.7: resolve the country of manufacture declared to the WMS from a stored IMS origin.
 *  - blank -> CN default (customs parity, legitimate, no discrepancy),
 *  - a recognised country (name/alias/code) -> canonical uppercase ISO-2,
 *  - a nonblank value that is NOT an assigned ISO country -> CN so customs still gets a country and fulfilment
 *    proceeds, with the offending value returned as invalidCountryOfOrigin so the caller raises a discrepancy
 *    (mirrors invalid HS-code handling — never a silent false declaration).
 */
export function resolveMintsoftCountryOfManufacture(countryOfOrigin: string | null): {
  countryOfManufacture: string
  invalidCountryOfOrigin: string | null
} {
  const trimmed = trimToNull(countryOfOrigin)
  if (!trimmed) return { countryOfManufacture: DEFAULT_COUNTRY_OF_ORIGIN, invalidCountryOfOrigin: null }
  const iso = toIsoCountryCode(trimmed)
  if (iso) return { countryOfManufacture: iso, invalidCountryOfOrigin: null }
  return { countryOfManufacture: DEFAULT_COUNTRY_OF_ORIGIN, invalidCountryOfOrigin: trimmed }
}

export function resolveMintsoftCommodityCode(commodityCode: string | null): {
  commodityCode: string | null
  invalidCnCode: string | null
} {
  if (!commodityCode) {
    return { commodityCode: null, invalidCnCode: null }
  }
  if (!isDeclarableCn8(commodityCode)) {
    return { commodityCode: null, invalidCnCode: commodityCode }
  }
  return { commodityCode: normalizeCn8(commodityCode), invalidCnCode: null }
}

/** The IMS product field behind each clearable WMS field (the marker table is keyed by the IMS name). */
export const IMS_FIELD_OF_WMS_CLEAR: Readonly<Record<WmsClearableProductField, 'customsDescription' | 'hsCode' | 'countryOfOrigin'>> = {
  customsDescription: 'customsDescription',
  commodityCode: 'hsCode',
  countryOfManufacture: 'countryOfOrigin',
}

/**
 * Customs fields to ERASE in Mintsoft on an UPDATE. A field is cleared only on EVIDENCE of intent: IMS recorded a
 * populated -> empty transition for it (`marked`, the IMS names from product_customs_clears), it is still empty, and Mintsoft
 * holds (or may hold) a value. A field that was merely never set is NOT a clear: an unset origin was historically declared to
 * Mintsoft as the CN default, so Mintsoft holds CN for products nobody cleared. `remoteRaw` is the Mintsoft record read in this
 * run; undefined means unknown, which counts as "may hold". An unusable IMS value (malformed HS code, invalid origin) is not
 * empty and never clears. Barcode / EAN / UPC are not here and never will be.
 */
export function resolveMintsoftCustomsClears(
  product: Pick<ProductSyncCandidate, 'hsCode' | 'countryOfOrigin' | 'customsDescription'>,
  remoteRaw: Record<string, unknown> | null | undefined,
  marked: readonly string[],
): WmsClearableProductField[] {
  const mayHold = (field: WmsClearableProductField): boolean => (remoteRaw ? !mintsoftFieldIsEmpty(remoteRaw, field) : true)
  const clears: WmsClearableProductField[] = []
  if (marked.includes('customsDescription') && !trimToNull(product.customsDescription) && mayHold('customsDescription')) clears.push('customsDescription')
  if (marked.includes('hsCode') && !trimToNull(product.hsCode) && mayHold('commodityCode')) clears.push('commodityCode')
  if (marked.includes('countryOfOrigin') && !trimToNull(product.countryOfOrigin) && mayHold('countryOfManufacture')) clears.push('countryOfManufacture')
  return clears
}

/**
 * Marked fields whose Mintsoft copy is already known to be empty: nothing to send, so the marker has done its job. Only
 * decidable from a read of the record (`remoteRaw` defined).
 */
export function resolveSettledCustomsMarkers(
  product: Pick<ProductSyncCandidate, 'hsCode' | 'countryOfOrigin' | 'customsDescription'>,
  remoteRaw: Record<string, unknown> | null | undefined,
  marked: readonly string[],
): string[] {
  if (!remoteRaw) return []
  const pending = new Set(resolveMintsoftCustomsClears(product, remoteRaw, marked).map((f) => IMS_FIELD_OF_WMS_CLEAR[f]))
  // The origin marker is never settled here: while the origin stays blank it also stops the CN default being re-declared.
  return marked.filter((m) => m !== 'countryOfOrigin' && !pending.has(m as never))
}

/** What a clear is told about the marker it was planned from: the version (createdAt) the planner saw. */
export type PlannedClearMarkers = Partial<Record<WmsClearableProductField, Date>>

export function plannedClearMarkers(markers: ReadonlyArray<{ field: string; createdAt?: Date }>): PlannedClearMarkers {
  const out: PlannedClearMarkers = {}
  for (const [wmsField, imsField] of Object.entries(IMS_FIELD_OF_WMS_CLEAR) as Array<[WmsClearableProductField, string]>) {
    const marker = markers.find((m) => m.field === imsField)
    if (marker?.createdAt) out[wmsField] = marker.createdAt
  }
  return out
}

/**
 * The claim taken around each clear request. Planning read the product and its markers some time before the request goes out; a
 * refill in between (the trigger then removes the marker) must not still send the clear. So immediately before the request the
 * marker row is locked (`FOR UPDATE`) and re-read in a transaction that stays open until the request settles: the clear goes
 * only while the SAME marker (same `createdAt`, so not a later empty -> refill -> empty cycle) is current and the IMS field is
 * still empty. A refill that races the request blocks on the lock (its trigger deletes the marker) and lands after it; one that
 * landed before finds the marker gone, or the field filled, and the clear is skipped.
 */
export function buildCustomsClearClaim(productId: string, planned: PlannedClearMarkers): WmsClearClaim {
  return async <T>(field: WmsClearableProductField, send: () => Promise<T>) => {
    const imsField = IMS_FIELD_OF_WMS_CLEAR[field]
    const plannedAt = planned[field]
    if (!plannedAt) return { claimed: false as const, reason: 'no marker was planned for this clear' }
    return db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ createdAt: Date }>>(
        Prisma.sql`SELECT "createdAt" FROM "product_customs_clears" WHERE "productId" = ${productId} AND "field" = ${imsField} FOR UPDATE`,
      )
      if (rows.length === 0) return { claimed: false as const, reason: 'the field was filled again, so its clear marker is gone' }
      if (rows[0].createdAt.getTime() !== plannedAt.getTime()) return { claimed: false as const, reason: 'the clear marker was replaced since the clear was planned' }
      const current = await tx.product.findUnique({ where: { id: productId }, select: { hsCode: true, countryOfOrigin: true, customsDescription: true } })
      if (!current) return { claimed: false as const, reason: 'the product no longer exists' }
      if (trimToNull(current[imsField])) return { claimed: false as const, reason: 'the IMS field is no longer empty' }
      return { claimed: true as const, value: await send() }
    }, { timeout: 60_000, maxWait: 10_000 })
  }
}

export const MINTSOFT_CANNOT_CLEAR_MESSAGE = 'Mintsoft cannot clear this field via the API — clear it in Mintsoft by hand'

/**
 * A marked clear of a field Mintsoft cannot clear through the API is never attempted. It is recorded ONCE per marker (the audit
 * row is looked up first) so an operator knows to clear it by hand, and the marker is settled, except the origin's, which also
 * stops the China default being re-declared over a cleared origin and so stays until the origin is filled again. Returns the
 * fields recorded.
 */
export async function settleUnsupportedCustomsClears(
  product: { id: string; sku: string; customsClears?: ReadonlyArray<{ field: string; createdAt?: Date }> },
  externalProductId: string,
  unsupported: readonly WmsClearableProductField[],
): Promise<void> {
  for (const field of unsupported) {
    const imsField = IMS_FIELD_OF_WMS_CLEAR[field]
    const marker = (product.customsClears ?? []).find((m) => m.field === imsField)
    const summary = `Mintsoft cannot clear ${imsField} for ${product.sku}`
    const already = await db.wmsMutationEvent.findFirst({
      where: {
        connector: 'mintsoft', action: 'product_upsert', entityType: 'PRODUCT', entityId: product.id, summary,
        ...(marker?.createdAt ? { createdAt: { gte: marker.createdAt } } : {}),
      },
      select: { id: true },
    })
    if (!already) {
      await recordWmsMutationEvent({
        connector: 'mintsoft', direction: 'OUTBOUND', action: 'product_upsert', outcome: 'FAILED',
        entityType: 'PRODUCT', entityId: product.id, externalId: externalProductId,
        summary, before: { field: imsField }, error: MINTSOFT_CANNOT_CLEAR_MESSAGE,
      })
    }
    if (imsField !== 'countryOfOrigin') {
      await db.productCustomsClear.deleteMany({ where: { productId: product.id, field: imsField } })
    }
  }
}

export function hashMintsoftProductDto(product: WmsProductDto): string {
  const orderedEntries = Object.entries(product).sort(([left], [right]) => left.localeCompare(right))
  return createHash('sha256').update(JSON.stringify(Object.fromEntries(orderedEntries))).digest('hex')
}

export function resolveMintsoftBarcodePlan(imsBarcode: string | null, wmsBarcode: string | null): BarcodePlan {
  if (!imsBarcode && !wmsBarcode) return { kind: 'noop', omitBarcode: true }
  if (imsBarcode && !wmsBarcode) return { kind: 'fill_wms_barcode', omitBarcode: false }
  if (!imsBarcode && wmsBarcode) return { kind: 'backfill', omitBarcode: true }
  if (imsBarcode === wmsBarcode) return { kind: 'match', omitBarcode: false }
  return { kind: 'conflict', omitBarcode: true }
}

export type MintsoftIdentifierPlan = {
  /** The aggregate across both slots, in the single-slot plan's vocabulary. `conflict` also covers a leftover code. */
  kind: BarcodePlan['kind']
  gtin: BarcodePlan
  mpn: BarcodePlan
  omitBarcode: boolean
  omitMpn: boolean
  /** A third distinct code neither slot could take, on either side. Never dropped: it is what makes this a conflict. */
  leftover: { ims: string; wms: string }
}

/**
 * The two-slot form of `resolveMintsoftBarcodePlan`, used only when the product identifier split is on.
 *
 * Each slot (GTIN -> Mintsoft EAN, MPN -> Mintsoft UPC) runs the single-slot state machine on its own values. A
 * GTIN-13 on one side and the same trade item as a GTIN-14 on the other is the same code (`sameCode`), not a conflict.
 *
 * ANY conflict, in either slot, or any leftover on either side, writes NOTHING to either Mintsoft field. A leftover is
 * a code the warehouse may hold stock under that IMS cannot place, and writing the other slot could overwrite exactly
 * that field (for instance a GTIN held in UPC), which is the decision a sync must not make. A human resolves the
 * BARCODE_CONFLICT discrepancy.
 *
 * Without a conflict a slot is written whenever IMS, or the WMS value about to be backfilled into IMS, has a value, so
 * the code lands in its canonical field (GTIN in EAN, MPN in UPC) even when Mintsoft had it in the other one.
 */
export function resolveMintsoftIdentifierPlan(ims: IdentifierCodes, wms: IdentifierCodes): MintsoftIdentifierPlan {
  const slot = (imsValue: string, wmsValue: string): BarcodePlan => {
    const wmsComparable = imsValue && wmsValue && sameCode(imsValue, wmsValue) ? imsValue : wmsValue
    return resolveMintsoftBarcodePlan(imsValue || null, wmsComparable || null)
  }
  const gtin = slot(ims.gtin, wms.gtin)
  const mpn = slot(ims.mpn, wms.mpn)
  const leftover = { ims: ims.leftover, wms: wms.leftover }
  const conflict = gtin.kind === 'conflict' || mpn.kind === 'conflict' || Boolean(leftover.ims || leftover.wms)

  const kinds = [gtin.kind, mpn.kind]
  let kind: BarcodePlan['kind']
  if (conflict) kind = 'conflict'
  else if (kinds.includes('fill_wms_barcode')) kind = 'fill_wms_barcode'
  else if (kinds.includes('backfill')) kind = 'backfill'
  else if (kinds.includes('match')) kind = 'match'
  else kind = 'noop'

  return {
    kind,
    gtin,
    mpn,
    omitBarcode: conflict || !(ims.gtin || wms.gtin),
    omitMpn: conflict || !(ims.mpn || wms.mpn),
    leftover,
  }
}

function describeIdentifierSet(codes: IdentifierCodes): string {
  const parts = [`GTIN ${codes.gtin || '(none)'}`, `MPN ${codes.mpn || '(none)'}`]
  if (codes.leftover) parts.push(`unplaced ${codes.leftover}`)
  return parts.join(', ')
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
    select: PRODUCT_SYNC_CANDIDATE_SELECT,
  })
}

async function listEligibleMintsoftProductsBatch(cursorId?: string): Promise<ProductSyncCandidate[]> {
  return db.product.findMany({
    where: ELIGIBLE_PRODUCT_WHERE,
    orderBy: { id: 'asc' },
    take: PRODUCT_VERIFY_BATCH_SIZE,
    ...(cursorId
      ? {
          cursor: { id: cursorId },
          skip: 1,
        }
      : {}),
    select: PRODUCT_SYNC_CANDIDATE_SELECT,
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
      ...(params.payloadHash !== undefined ? { payloadHash: params.payloadHash } : {}),
      ...(params.lastKnownBarcode !== undefined ? { lastKnownBarcode: params.lastKnownBarcode } : {}),
      ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
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

async function upsertProductDiscrepancy(params: {
  scopes: MintsoftProductSyncScope[]
  productId: string
  sku: string
  category: WmsDiscrepancyCategory
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
        category: params.category,
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

    try {
      await db.wmsStockDiscrepancy.create({
        data: {
          connector: 'mintsoft',
          warehouseId: scope.warehouseId,
          productId: params.productId,
          sku: params.sku,
          category: params.category,
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
        connector: 'mintsoft',
        warehouseId: scope.warehouseId,
        productId: params.productId,
        category: params.category,
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
  }
}

async function resolveProductDiscrepancy(
  scopes: MintsoftProductSyncScope[],
  productId: string,
  category: WmsDiscrepancyCategory,
) {
  const warehouseIds = scopes.map((scope) => scope.warehouseId)
  if (warehouseIds.length === 0) return

  await db.wmsStockDiscrepancy.updateMany({
    where: {
      connector: 'mintsoft',
      warehouseId: { in: warehouseIds },
      productId,
      category,
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
  /** What was backfilled; only the identifier split ever says anything but 'barcode'. */
  label?: 'barcode' | 'MPN'
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
      message: params.label === 'MPN' ? 'Mintsoft MPN was backfilled into IMS.' : 'Mintsoft barcode was backfilled into IMS.',
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

type PlannedIdentifiers = { barcode: string | null; mpn: string | null }

/**
 * Identifier split only: a backfill is a compare-and-set against the barcode and mpn the plan was built from, so an operator
 * edit made after the product snapshot was read is never overwritten. Zero rows means the values moved: report it on the
 * BARCODE_CONFLICT channel and write nothing (the next run re-plans from the fresh values).
 */
async function updateIdentifiersIfUnchanged(
  context: ProductSyncContext,
  expected: PlannedIdentifiers,
  data: { barcode?: string; mpn?: string },
): Promise<{ ok: true } | { ok: false; message: string }> {
  const result = await db.product.updateMany({
    where: { id: context.product.id, barcode: expected.barcode, mpn: expected.mpn },
    data,
  })
  if (result.count > 0) return { ok: true }
  const fresh = await db.product.findUnique({ where: { id: context.product.id }, select: { barcode: true, mpn: true } })
  const message = `IMS barcode/MPN changed (now barcode ${fresh?.barcode ?? '(none)'}, MPN ${fresh?.mpn ?? '(none)'}) while the Mintsoft sync was running; nothing was backfilled from Mintsoft. It is re-planned on the next run.`
  await upsertProductDiscrepancy({
    scopes: context.scopes,
    productId: context.product.id,
    sku: context.product.sku,
    category: 'BARCODE_CONFLICT',
    imsValue: `barcode ${fresh?.barcode ?? '(none)'}, MPN ${fresh?.mpn ?? '(none)'}`,
    wmsValue: [data.barcode && `GTIN ${data.barcode}`, data.mpn && `MPN ${data.mpn}`].filter(Boolean).join(', ') || null,
    message,
  })
  return { ok: false, message }
}

async function backfillBarcodeFromMintsoft(context: ProductSyncContext, barcode: string, alsoSet: { mpn?: string } = {}, expected?: PlannedIdentifiers): Promise<{
  ok: true
} | {
  ok: false
  message: string
}> {
  try {
    if (expected) {
      const guarded = await updateIdentifiersIfUnchanged(context, expected, { barcode, ...alsoSet })
      if (!guarded.ok) return guarded
    } else {
      await db.product.update({
        where: { id: context.product.id },
        data: { barcode, ...alsoSet },
      })
    }

    await createBarcodeBackfillAudit({
      scopes: context.scopes,
      productId: context.product.id,
      sku: context.product.sku,
      barcode,
    })
    await resolveProductDiscrepancy(context.scopes, context.product.id, 'BARCODE_CONFLICT')

    return { ok: true }
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
      throw error
    }
  }

  const owner = await getBarcodeOwner(barcode, context.product.id)
  const ownerSummary = owner ? `${owner.sku} (${owner.id})` : 'another IMS product'
  const message = `Cannot backfill from WMS — barcode already owned by IMS product ${ownerSummary}.`

  await upsertProductDiscrepancy({
    scopes: context.scopes,
    productId: context.product.id,
    sku: context.product.sku,
    category: 'BARCODE_CONFLICT',
    imsValue: null,
    wmsValue: barcode,
    message,
  })

  return { ok: false, message }
}

/** Identifier split only: copy the MPN Mintsoft holds into an IMS product that has none. Product.mpn is not unique. */
async function backfillMpnFromMintsoft(context: ProductSyncContext, mpn: string, expected: PlannedIdentifiers): Promise<{ ok: true } | { ok: false; message: string }> {
  const guarded = await updateIdentifiersIfUnchanged(context, expected, { mpn })
  if (!guarded.ok) return guarded
  await createBarcodeBackfillAudit({
    scopes: context.scopes,
    productId: context.product.id,
    sku: context.product.sku,
    barcode: mpn,
    label: 'MPN',
  })
  return { ok: true }
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
      remoteUpdated: false,
    }
  }

  const existingLink = getExistingLink(context.product)
  const authoritativeLookup = await fetchAuthoritativeMintsoftProduct(context)
  const authoritative = authoritativeLookup.product
  let dto = buildMintsoftProductDto(context.product)
  // CN validation (bhdm.3): never declare a malformed / non-2026 CN8 to the WMS. A valid code is
  // normalised to canonical 8 digits; a bad code is omitted (the rest of the product still syncs)
  // and recorded as a discrepancy below.
  const { commodityCode: validatedCommodityCode, invalidCnCode } = resolveMintsoftCommodityCode(dto.commodityCode)
  if (validatedCommodityCode !== dto.commodityCode) {
    dto = { ...dto, commodityCode: validatedCommodityCode }
  }

  // PRODUCT PARITY (o3d-zvec.20). Off (the default): nothing below this line changes, `dto` has no costPrice key, and the name,
  // weight and dimensions are the product's own, so the payload hash and every outbound byte are what they always were. On: the
  // name is fitted to Mintsoft's 99-character limit, a variation inherits its parent's weight and dimensions where its own are
  // missing, and the IMS cost is sent. Cost is business-sensitive and is kept out of every log below.
  const parityEnabled = await readMintsoftProductParityEnabled()
  if (parityEnabled) {
    const costPrice = await readMintsoftProductCost(context.product.id, context.product.type)
    dto = applyMintsoftProductParity(dto, context.product, costPrice)
  }
  const logRaw = <T>(raw: T): T => (parityEnabled ? redactMintsoftCostPrice(raw) : raw)

  // CLEARED CUSTOMS DATA reaches Mintsoft on an UPDATE only (a create has nothing to clear): a customs field IMS holds nothing
  // for is erased there rather than left stale. A blank origin no longer declares the CN default on an update; the
  // create keeps it. The payload hash carries the null, so the change is detected once and not re-sent.
  const earlyExternalProductId = resolveMintsoftExternalProductId({
    authoritativeProduct: authoritative,
    existingExternalProductId: existingLink?.externalProductId ?? null,
    existingLinkMatchesSku: authoritativeLookup.existingLinkMatchesSku,
  })
  const markedFields = earlyExternalProductId
    ? (context.product.customsClears ?? []).map((m) => m.field)
    : []
  const remoteRawForClears = authoritative ? (authoritative.raw ?? {}) : undefined
  const plannedClears = earlyExternalProductId ? resolveMintsoftCustomsClears(context.product, remoteRawForClears, markedFields) : []
  // A field Mintsoft has no API way to clear is never sent (and so never retried): recorded once for the operator instead.
  const clearFields = plannedClears.filter(mintsoftCanClear)
  const unsupportedClears = plannedClears.filter((f) => !mintsoftCanClear(f))
  const plannedMarkers = plannedClearMarkers(context.product.customsClears ?? [])
  // Markers whose Mintsoft copy is already empty are settled: drop them (no request needed).
  const settledMarkers = earlyExternalProductId ? resolveSettledCustomsMarkers(context.product, remoteRawForClears, markedFields) : []
  if (settledMarkers.length > 0) {
    await db.productCustomsClear.deleteMany({ where: { productId: context.product.id, field: { in: settledMarkers } } })
  }
  if (earlyExternalProductId && unsupportedClears.length > 0) {
    await settleUnsupportedCustomsClears(context.product, earlyExternalProductId, unsupportedClears)
  }
  // An origin the operator CLEARED (marked, still blank) is not re-declared as the CN default on an update, which would undo the
  // clear. An origin that was merely never set keeps the CN default exactly as before. This marker is kept after the clear
  // is verified (see resolveSettledCustomsMarkers) and goes only when the origin is filled again.
  if (earlyExternalProductId && markedFields.includes('countryOfOrigin') && !trimToNull(context.product.countryOfOrigin)) {
    dto = { ...dto, countryOfManufacture: null }
  }

  // Customs discrepancies (HS/CN code + country of origin) are reconciled HERE — BEFORE any barcode-related
  // early return — so a barcode conflict can never suppress them and leave a legacy issue unreported (Codex
  // review r9). A bad HS/CN code is omitted from the push; an invalid origin still declares CN for customs
  // continuity but is flagged, never a silent false declaration. Each is cleared once corrected.
  if (invalidCnCode) {
    await upsertProductDiscrepancy({
      scopes: context.scopes,
      productId: context.product.id,
      sku: context.product.sku,
      category: 'INVALID_HS_CODE',
      imsValue: invalidCnCode,
      wmsValue: null,
      message: `IMS HS/CN code "${invalidCnCode}" is not a declarable 2026 CN8 (must be exactly 8 digits and present in the EU CN list). Code was omitted from the Mintsoft push.`,
    })
  } else {
    await resolveProductDiscrepancy(context.scopes, context.product.id, 'INVALID_HS_CODE')
  }
  const { invalidCountryOfOrigin } = resolveMintsoftCountryOfManufacture(context.product.countryOfOrigin)
  if (invalidCountryOfOrigin) {
    await upsertProductDiscrepancy({
      scopes: context.scopes,
      productId: context.product.id,
      sku: context.product.sku,
      category: 'INVALID_COUNTRY_OF_ORIGIN',
      imsValue: invalidCountryOfOrigin,
      wmsValue: null,
      message: `IMS country of origin "${invalidCountryOfOrigin}" is not an assigned ISO 3166-1 alpha-2 country. Declared as ${DEFAULT_COUNTRY_OF_ORIGIN} to the WMS; correct the product's origin.`,
    })
  } else {
    await resolveProductDiscrepancy(context.scopes, context.product.id, 'INVALID_COUNTRY_OF_ORIGIN')
  }

  // THE IDENTIFIER SPLIT (o3d-mu0a). Off (the default): everything below is the single-barcode behaviour, unchanged, and
  // `dto` has no `mpn` key, so the payload hash and every outbound byte are what they always were. On: the GTIN goes to
  // EAN and the MPN to UPC, classified by shape, with the two-slot plan below.
  const splitEnabled = await readProductIdentifierSplitEnabled()
  const imsCodes = splitEnabled
    ? classifyIdentifierCodes({ EAN: context.product.barcode, UPC: context.product.mpn })
    : null
  if (imsCodes) dto = { ...dto, barcode: imsCodes.gtin || null, mpn: imsCodes.mpn || null }
  const wmsCodes = splitEnabled && authoritative
    ? classifyMintsoftProductRecord(authoritative.raw ?? { EAN: authoritative.barcode })
    : null

  let payloadHash = hashMintsoftProductDto(dto)
  const wmsBarcode = trimToNull(authoritative?.barcode)
  const identifierPlan = imsCodes
    ? resolveMintsoftIdentifierPlan(imsCodes, wmsCodes ?? { gtin: '', mpn: '', leftover: '' })
    : null
  const barcodePlan: BarcodePlan = identifierPlan
    ? { kind: identifierPlan.kind, omitBarcode: identifierPlan.omitBarcode } as BarcodePlan
    : resolveMintsoftBarcodePlan(dto.barcode, wmsBarcode)

  const failedBackfillResult = async (message: string, lastKnownBarcode: string | null): Promise<ProductSyncLineResult> => {
    const knownExternalProductId = authoritative?.externalId ?? existingLink?.externalProductId
    if (knownExternalProductId) {
      await upsertMintsoftProductLink({
        productId: context.product.id,
        externalProductId: knownExternalProductId,
        lastKnownBarcode,
        metadata: toJsonPayload(authoritative?.raw),
        lastError: message,
      })
    } else {
      await recordMintsoftProductLinkError(context.product.id, message)
    }
    return {
      sku: context.product.sku,
      productId: context.product.id,
      action: 'conflict',
      reason: message,
      payload: toJsonPayload(logRaw(authoritative?.raw)),
      remoteUpdated: false,
    }
  }

  if (identifierPlan && wmsCodes) {
    // NO backfill while the two-slot plan has any conflict or leftover: replacing Product.barcode in that state can erase an
    // IMS part number the conflict is about (barcode = part number A, Mintsoft EAN = a GTIN, Mintsoft UPC = a different part
    // number B). The conflict is reported below and a human decides.
    const mayBackfill = identifierPlan.kind !== 'conflict'
    // The values the plan was built from; each successful backfill advances it.
    let planned: PlannedIdentifiers = { barcode: context.product.barcode, mpn: context.product.mpn ?? null }
    if (mayBackfill && identifierPlan.gtin.kind === 'backfill' && wmsCodes.gtin) {
      // A part number sitting in Product.barcode is moved to Product.mpn in the SAME update, before barcode is replaced.
      const movedPartNumber = context.product.barcode?.trim() && !context.product.mpn?.trim() && imsCodes?.mpn
        ? { mpn: imsCodes.mpn }
        : {}
      const backfill = await backfillBarcodeFromMintsoft(context, wmsCodes.gtin, movedPartNumber, planned)
      if (!backfill.ok) return failedBackfillResult(backfill.message, wmsCodes.gtin)
      planned = { barcode: wmsCodes.gtin, mpn: movedPartNumber.mpn ?? planned.mpn }
      dto = { ...dto, barcode: wmsCodes.gtin }
    }
    if (mayBackfill && identifierPlan.mpn.kind === 'backfill' && wmsCodes.mpn) {
      const mpnBackfill = await backfillMpnFromMintsoft(context, wmsCodes.mpn, planned)
      if (!mpnBackfill.ok) return failedBackfillResult(mpnBackfill.message, wmsCodes.mpn)
      planned = { ...planned, mpn: wmsCodes.mpn }
      dto = { ...dto, mpn: wmsCodes.mpn }
    }
    payloadHash = hashMintsoftProductDto(dto)
  } else if (barcodePlan.kind === 'backfill' && wmsBarcode) {
    const backfill = await backfillBarcodeFromMintsoft(context, wmsBarcode)
    if (!backfill.ok) return failedBackfillResult(backfill.message, wmsBarcode)

    dto = {
      ...dto,
      barcode: wmsBarcode,
    }
    payloadHash = hashMintsoftProductDto(dto)
  }

  if (barcodePlan.kind === 'conflict' && identifierPlan && imsCodes && wmsCodes) {
    // The conflict branch is also where a leftover is reported: a code neither slot could take is never dropped. Both
    // sides are shown in full so the operator sees exactly which code could not be placed.
    await upsertProductDiscrepancy({
      scopes: context.scopes,
      productId: context.product.id,
      sku: context.product.sku,
      category: 'BARCODE_CONFLICT',
      imsValue: describeIdentifierSet(imsCodes),
      wmsValue: describeIdentifierSet(wmsCodes),
      message: `IMS identifiers (${describeIdentifierSet(imsCodes)}) cannot be reconciled with Mintsoft EAN/UPC (${describeIdentifierSet(wmsCodes)}). `
        + 'A code that neither the GTIN slot nor the MPN slot can take is never dropped or picked between automatically. Neither Mintsoft field was written.',
    })
  } else if (barcodePlan.kind === 'conflict') {
    await upsertProductDiscrepancy({
      scopes: context.scopes,
      productId: context.product.id,
      sku: context.product.sku,
      category: 'BARCODE_CONFLICT',
      imsValue: dto.barcode,
      wmsValue: wmsBarcode,
      message: `IMS barcode ${dto.barcode} differs from Mintsoft barcode ${wmsBarcode}. Barcode was not overwritten.`,
    })
  } else {
    await resolveProductDiscrepancy(context.scopes, context.product.id, 'BARCODE_CONFLICT')
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
      // A pending clear is work: an unchanged hash (a field blank in IMS all along) must not hide a value Mintsoft still holds.
      && clearFields.length === 0
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
      // CONFIRMED only by a read of the Mintsoft record made in THIS run whose id and SKU are the product's and whose payload
      // hash equals the stored one: a shadowed, held, skipped or content-only product never reaches here with that proof.
      metadata: toJsonPayload(
        context.runId && authoritative && externalProductId === authoritative.externalId && authoritative.sku.trim().toLowerCase() === dto.sku.trim().toLowerCase()
          ? withMetadataConfirmation(authoritative.raw, context.runId)
          : authoritative?.raw,
      ),
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
      payload: toJsonPayload(logRaw(authoritative?.raw)),
      remoteUpdated: false,
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
      payload: toJsonPayload(logRaw(authoritative?.raw)),
      remoteUpdated: false,
    }
  }

  // THE PRODUCER SEAM of the product upsert, immediately before the only call that writes the product to Mintsoft. A shadow stamps
  // nothing (no payload hash, no sync time, no link error), so the product is offered again until it is really sent, and it is
  // kept as a record of what would have been written. The reads and the local reconciliation above are not writes to Mintsoft.
  const upsertSeam = await mintsoftProducerSeam({
    operation: 'product.upsert',
    subjectType: 'Product',
    subjectId: context.product.id,
    payload: {
      product: dto,
      externalProductId: externalProductId ?? null,
      omitBarcode: barcodePlan.omitBarcode,
      ...(identifierPlan ? { omitMpn: identifierPlan.omitMpn } : {}),
      ...(externalProductId && clearFields.length ? { clearFields } : {}),
    },
    summary: { sku: context.product.sku, creating: !externalProductId },
  })
  if (!upsertSeam.proceed) {
    return {
      sku: context.product.sku,
      productId: context.product.id,
      action: 'shadow',
      reason: upsertSeam.notice,
      payload: toJsonPayload({ shadowed: true, reason: upsertSeam.reason }),
      remoteUpdated: false,
    }
  }

  let synced: Awaited<ReturnType<typeof context.connector.upsertProduct>>
  try {
    synced = await context.connector.upsertProduct(dto, {
      externalProductId,
      omitBarcode: barcodePlan.omitBarcode,
      ...(identifierPlan ? { omitMpn: identifierPlan.omitMpn } : {}),
      ...(externalProductId && clearFields.length ? { clearFields, clearClaim: buildCustomsClearClaim(context.product.id, plannedMarkers) } : {}),
    }, upsertSeam.clearance)
  } catch (error) {
    await recordWmsMutationEvent({
      connector: 'mintsoft', direction: 'OUTBOUND', action: 'product_upsert', outcome: 'FAILED',
      entityType: 'PRODUCT', entityId: context.product.id, externalId: externalProductId ?? null,
      summary: `Mintsoft product upsert failed for ${context.product.sku}`,
      before: { externalProductId: externalProductId ?? null },
      error: error instanceof Error ? error.message : 'Mintsoft product upsert failed',
    })
    throw error
  }
  // A rejected clear never fails the update. It is recorded on the event, and the stored hash is marked so the next run
  // offers the product again and retries the clear.
  const verifiedCleared = synced.clearOutcome?.cleared ?? []
  if (verifiedCleared.length > 0) {
    // Verified empty by the read-back: the marker is spent.
    await db.productCustomsClear.deleteMany({
      where: { productId: context.product.id, field: { in: verifiedCleared.filter((f) => f !== 'countryOfManufacture').map((f) => IMS_FIELD_OF_WMS_CLEAR[f]) } },
    })
  }
  const rejectedClears = synced.clearOutcome?.rejected ?? []
  // A clear skipped by the claim (the field was refilled meanwhile) is not a failure and is not retried.
  const skippedClears = synced.clearOutcome?.skipped ?? []
  if (rejectedClears.length > 0) payloadHash = `${payloadHash}:clear-pending`
  const upsertEvent = {
    connector: 'mintsoft', direction: 'OUTBOUND', action: 'product_upsert', outcome: 'SUCCEEDED',
    entityType: 'PRODUCT', entityId: context.product.id, externalId: synced.externalId,
    summary: synced.externalId === externalProductId
      ? `Mintsoft product updated for ${context.product.sku}`
      : `Mintsoft product created for ${context.product.sku}`,
    before: { externalProductId: externalProductId ?? null, payloadHash: existingLink?.payloadHash ?? null },
    after: { externalProductId: synced.externalId, sku: dto.sku, barcodeOmitted: barcodePlan.omitBarcode, ...(identifierPlan ? { mpnOmitted: identifierPlan.omitMpn } : {}), payloadHash, ...(rejectedClears.length ? { rejectedClears } : {}), ...(skippedClears.length ? { skippedClears } : {}) },
  } as const

  // The event records only AFTER the local link persisted (Codex r2) — a link
  // failure after a remote success is flagged, not silently reported clean.
  // The catch covers ONLY the link upsert (Codex r3: a failure of the
  // follow-up error-flag cleanup must not forge a false linkPersistFailed —
  // the link itself is already durably written by then).
  try {
    await upsertMintsoftProductLink({
      productId: context.product.id,
      externalProductId: synced.externalId,
      payloadHash,
      lastKnownBarcode: trimToNull(synced.barcode) ?? dto.barcode,
      // CONFIRMED: this run's live upsert was sent (the seam cleared it) and Mintsoft's echo names the product's SKU.
      metadata: toJsonPayload(
        context.runId && synced.sku.trim().toLowerCase() === dto.sku.trim().toLowerCase()
          ? withMetadataConfirmation(synced.raw, context.runId)
          : synced.raw,
      ),
      lastError: null,
      touchLastSyncedAt: true,
    })
  } catch (persistError) {
    await recordWmsMutationEvent({
      ...upsertEvent,
      summary: `${upsertEvent.summary}, but recording the product link failed`,
      after: { ...upsertEvent.after, linkPersistFailed: true },
      error: persistError instanceof Error ? persistError.message : 'Mintsoft product link persist failed',
    })
    throw persistError
  }
  await recordWmsMutationEvent(upsertEvent)
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
    payload: toJsonPayload(logRaw(synced.raw)),
    remoteUpdated: true,
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

function emptyProductSyncCounters(): Omit<MintsoftProductSyncResult, 'jobId' | 'status' | 'skippedReason'> {
  return {
    totalChecked: 0,
    matched: 0,
    mismatched: 0,
    corrected: 0,
    skipped: 0,
    errors: 0,
    content: { sent: 0, shadowed: 0, held: 0, errors: 0 },
  }
}

function applyProductSyncLineCounters(
  counters: Omit<MintsoftProductSyncResult, 'jobId' | 'status' | 'skippedReason'>,
  line: ProductSyncLineResult,
) {
  if (line.action === 'skip') counters.skipped += 1
  if (line.action === 'shadow') counters.shadowed = (counters.shadowed ?? 0) + 1
  if (line.action === 'noop') counters.matched += 1
  if (line.action === 'conflict') counters.mismatched += 1
  if (line.action === 'sync' || line.action === 'backfill' || line.remoteUpdated) {
    counters.corrected += 1
  }
}

async function processMintsoftProductChunk(params: {
  jobId: string
  products: ProductSyncCandidate[]
  scopes: MintsoftProductSyncScope[]
  connector: ReturnType<typeof getWmsConnector>
  counters: Omit<MintsoftProductSyncResult, 'jobId' | 'status' | 'skippedReason'>
  logs: Prisma.WmsSyncLogCreateManyInput[]
}) {
  const chunkResults = await Promise.all(
    params.products.map(async (product) => {
      try {
        const line = await syncOneMintsoftProduct({
          product,
          scopes: params.scopes,
          connector: params.connector,
          runId: params.jobId,
        })

        // The content step runs only for a product the meta step accepted, and its failure is its OWN line: it can
        // neither undo nor hide the meta result above.
        let content: ContentLineResult | null = null
        let contentError: string | null = null
        if (line.action !== 'skip') {
          try {
            const link = product.wmsProductLinks[0] ?? null
            content = await syncMintsoftProductContent({
              product: { id: product.id, sku: product.sku },
              link: link ? { id: link.id, externalProductId: link.externalProductId, contentSyncState: link.contentSyncState ?? null } : null,
              content: snapshotFromRow(product.content ?? null),
              connector: params.connector,
            })
          } catch (error) {
            contentError = error instanceof Error ? error.message : 'Mintsoft product content sync failed'
          }
        }

        return {
          product,
          line,
          error: null,
          content,
          contentError,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Mintsoft product sync failed'
        await recordMintsoftProductLinkError(product.id, message)
        return {
          product,
          line: null,
          error: message,
          content: null,
          contentError: null,
        }
      }
    }),
  )

  const contentCounters = (params.counters.content ??= { sent: 0, shadowed: 0, held: 0, errors: 0 })
  for (const result of chunkResults) {
    params.counters.totalChecked += 1

    if (result.line) {
      applyProductSyncLineCounters(params.counters, result.line)
      params.logs.push({
        jobId: params.jobId,
        sku: result.line.sku,
        productId: result.line.productId,
        action: result.line.action,
        reason: result.line.reason,
        payload: result.line.payload,
      })
      if (result.content) {
        const logAction = result.content.kind === 'sent'
          ? 'updated'
          : result.content.kind === 'shadow'
            ? 'shadow'
            : result.content.kind === 'held'
              ? 'skip'
              : null
        if (result.content.kind === 'sent') contentCounters.sent += result.content.fields.length
        if (result.content.kind === 'shadow') contentCounters.shadowed += 1
        if (result.content.kind === 'held') contentCounters.held += 1
        if (logAction) {
          params.logs.push({
            jobId: params.jobId,
            sku: result.product.sku,
            productId: result.product.id,
            action: logAction,
            reason: result.content.reason,
            payload: result.content.payload,
          })
        }
      }
      if (result.contentError) {
        contentCounters.errors += 1
        params.counters.errors += 1
        if (isOutboundWriteHeldText(result.contentError)) params.counters.outboundHeld = (params.counters.outboundHeld ?? 0) + 1
        params.logs.push({
          jobId: params.jobId,
          sku: result.product.sku,
          productId: result.product.id,
          action: 'error',
          reason: `Content sync failed: ${result.contentError}`,
          payload: toJsonPayload(null),
        })
      }
      continue
    }

    params.counters.errors += 1
    if (isOutboundWriteHeldText(result.error)) params.counters.outboundHeld = (params.counters.outboundHeld ?? 0) + 1
    params.logs.push({
      jobId: params.jobId,
      sku: result.product.sku,
      productId: result.product.id,
      action: 'error',
      reason: result.error ?? 'Mintsoft product sync failed',
      payload: toJsonPayload(null),
    })
  }
}

async function runMintsoftProductSyncJob(
  productBatches: AsyncIterable<ProductSyncCandidate[]>,
  type: 'PRODUCT_SYNC' | 'PRODUCT_VERIFY',
  triggeredBy: string,
  totalCandidates: number,
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
  const counters = emptyProductSyncCounters()
  const logs: Prisma.WmsSyncLogCreateManyInput[] = []

  try {
    for await (const batch of productBatches) {
      for (let index = 0; index < batch.length; index += PRODUCT_SYNC_CONCURRENCY) {
        await processMintsoftProductChunk({
          jobId: job.id,
          products: batch.slice(index, index + PRODUCT_SYNC_CONCURRENCY),
          scopes,
          connector,
          counters,
          logs,
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
      concurrency: PRODUCT_SYNC_CONCURRENCY,
      totalCandidates,
      content: { ...counters.content },
    })

    await logActivity({
      entityType: 'SYSTEM',
      tag: 'sync',
      action: type === 'PRODUCT_VERIFY' ? 'mintsoft_product_verify' : 'mintsoft_product_sync',
      description: `Mintsoft ${type === 'PRODUCT_VERIFY' ? 'product verify' : 'product sync'} completed: ${counters.totalChecked} checked, ${counters.corrected} changed, ${counters.mismatched} conflicts, ${counters.errors} errors. ${describeContentRun(counters.content)}`,
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

  return runMintsoftProductSyncJob((async function* () {
    yield [product]
  })(), 'PRODUCT_SYNC', triggeredBy, 1, {
    mode: 'single',
    productId,
    sku: product.sku,
  } satisfies Prisma.InputJsonObject)
}

export async function runMintsoftProductVerify(triggeredBy: string): Promise<MintsoftProductSyncResult> {
  const totalCandidates = await db.product.count({
    where: ELIGIBLE_PRODUCT_WHERE,
  })
  if (totalCandidates === 0) {
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

  const result = await runMintsoftProductSyncJob((async function* () {
    let cursorId: string | undefined
    while (true) {
      const batch = await listEligibleMintsoftProductsBatch(cursorId)
      if (batch.length === 0) {
        return
      }

      yield batch
      cursorId = batch[batch.length - 1]?.id
    }
  })(), 'PRODUCT_VERIFY', triggeredBy, totalCandidates, {
    mode: 'verify',
    totalCandidates,
    batchSize: PRODUCT_VERIFY_BATCH_SIZE,
    concurrency: PRODUCT_SYNC_CONCURRENCY,
  } satisfies Prisma.InputJsonObject)

  // PARENT SKU DELETION (o3d-zvec.20): behind its own setting (default off; the pass returns at once without reading anything else
  // when it is off). Only after a run that completed with no error, so it never acts on a partly-refreshed catalogue; the pass
  // itself still proves every variation from the stored links and refuses on any doubt.
  if (result.status === 'SUCCEEDED' && result.jobId) {
    try {
      const deletion = await runMintsoftParentSkuDeletionPass({ runId: result.jobId, triggeredBy })
      if (deletion) {
        // Folded into the result, not discarded: a pass that hit errors must reach the cron's exit status. Refusals and holds are
        // deliberate outcomes (each is recorded by the pass) and stay informational in `parentDeletion`.
        result.parentDeletion = deletion
        result.errors += deletion.errors
      }
    } catch (error) {
      // The verify run itself succeeded and stays reported as such; a failed pass deleted nothing it could not prove.
      result.errors += 1
      await logActivity({
        entityType: 'SYSTEM', tag: 'sync', action: 'mintsoft_parent_sku_delete_pass_failed', level: 'ERROR',
        description: `Mintsoft parent SKU deletion pass failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        resolveUser: false,
      })
    }
  }
  return result
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
      ...ELIGIBLE_PRODUCT_WHERE,
    },
    orderBy: { sku: 'asc' },
    select: PRODUCT_SYNC_CANDIDATE_SELECT,
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

  return runMintsoftProductSyncJob((async function* () {
    yield products
  })(), 'PRODUCT_VERIFY', triggeredBy, products.length, {
    mode: 'verify',
    totalCandidates: products.length,
    skuScope: normalizedSkus,
    concurrency: PRODUCT_SYNC_CONCURRENCY,
  } satisfies Prisma.InputJsonObject)
}
