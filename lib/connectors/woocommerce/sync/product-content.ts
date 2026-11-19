/**
 * WOOCOMMERCE PRODUCT CONTENT -> THE HUB SNAPSHOT. READ-SIDE ONLY.
 *
 * Turns a product (or variation) payload that the importer has ALREADY fetched into the connector-agnostic content
 * snapshot, and hands it to the hub store. Nothing here calls WooCommerce, and nothing writes content back to it:
 * the flow is Woo -> IMS -> warehouse, and IMS never answers the storefront with content.
 *
 * A variation has no short description in WooCommerce (only `description`) and carries a single picture.
 */

import {
  normalizeContentText,
  normalizeImageRefs,
  type ProductContentSnapshot,
} from '@/lib/domain/product-content/snapshot'
import { applyIncomingProductContent, applyIncomingProductContentBatch, type ApplyContentResult } from '@/lib/domain/product-content/store'
import type { Prisma } from '@/app/generated/prisma/client'

type WcContentSource = {
  description?: unknown
  short_description?: unknown
  images?: unknown
  /** A wc/v3 VARIATION carries one picture as `image`, not an `images` list. */
  image?: unknown
  date_modified_gmt?: unknown
}

export function extractWcContent(source: WcContentSource): ProductContentSnapshot {
  return {
    shortDescription: normalizeContentText(source.short_description),
    longDescription: normalizeContentText(source.description),
    images: normalizeImageRefs(Array.isArray(source.images) ? source.images : source.image && typeof source.image === 'object' ? [source.image] : source.images),
  }
}

function sourceModifiedAt(source: WcContentSource): Date | undefined {
  const raw = source.date_modified_gmt
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  const ms = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(raw.trim()) ? raw.trim() : `${raw.trim()}Z`)
  return Number.isFinite(ms) ? new Date(ms) : undefined
}

/** Store one WooCommerce object's content on the IMS product it was written to. Inside the caller's transaction. */
export async function storeWcProductContent(
  tx: Prisma.TransactionClient,
  productId: string,
  source: WcContentSource,
): Promise<ApplyContentResult> {
  return applyIncomingProductContent(tx, {
    productId,
    incoming: extractWcContent(source),
    sourceModifiedAt: sourceModifiedAt(source),
    sourceSystem: 'woocommerce',
  })
}

/**
 * Store the content of MANY variations of one parent inside the caller's transaction with one read for all of them (a parent can have a thousand
 * variations inside a 60 s import transaction, and the per-variation read-then-write was two serial round trips each). Items are applied in order against an
 * in-memory copy of what was read, so a SKU repeated across variations of one parent behaves exactly as the one-at-a-time calls did.
 */
export async function storeWcVariationContentBatch(
  tx: Prisma.TransactionClient,
  items: ReadonlyArray<{ productId: string; source: WcContentSource }>,
): Promise<void> {
  if (items.length === 0) return
  await applyIncomingProductContentBatch(tx, items.map((item) => ({
    productId: item.productId,
    incoming: extractWcContent(item.source),
    sourceModifiedAt: sourceModifiedAt(item.source),
    sourceSystem: 'woocommerce',
  })))
}
