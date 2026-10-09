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
import { applyIncomingProductContent, type ApplyContentResult } from '@/lib/domain/product-content/store'
import type { Prisma } from '@/app/generated/prisma/client'

type WcContentSource = {
  description?: unknown
  short_description?: unknown
  images?: unknown
  date_modified_gmt?: unknown
}

export function extractWcContent(source: WcContentSource): ProductContentSnapshot {
  return {
    shortDescription: normalizeContentText(source.short_description),
    longDescription: normalizeContentText(source.description),
    images: normalizeImageRefs(source.images),
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
