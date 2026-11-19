/**
 * READ AND WRITE THE HUB COPY OF A PRODUCT'S CONTENT.
 *
 * `applyIncomingProductContent` is what an importer calls with the content it read from the source. It writes only
 * when a field really changes (a re-import of identical content touches no row, so `updatedAt` and the changed-at
 * stamps keep meaning something), and it never writes content back to the source: nothing in this module, or in
 * the importers that call it, has a path to WooCommerce.
 */

import { Prisma } from '@/app/generated/prisma/client'
import type { ProductContent } from '@/app/generated/prisma/client'
import {
  planContentUpdate,
  type ProductContentField,
  type ProductContentSnapshot,
  type ProductImageRef,
} from './snapshot'

type ContentClient = Pick<Prisma.TransactionClient, 'productContent'>

export function snapshotFromRow(row: Pick<ProductContent, 'shortDescription' | 'longDescription' | 'images'> | null): ProductContentSnapshot | null {
  if (!row) return null
  return {
    shortDescription: row.shortDescription,
    longDescription: row.longDescription,
    images: Array.isArray(row.images) ? (row.images as unknown as ProductImageRef[]) : [],
  }
}

export type ApplyContentResult = {
  changed: ProductContentField[]
  keptDespiteEmpty: ProductContentField[]
  created: boolean
}

export type IncomingContentParams = {
  productId: string
  incoming: ProductContentSnapshot
  /** The source product's own last-modified stamp, when it supplied one. */
  sourceModifiedAt?: Date | null
  sourceSystem?: string
  now?: Date
}

type ContentRowShape = Pick<ProductContent, 'shortDescription' | 'longDescription' | 'images'>

/** Plan and (only when something changed) write one product's content against the row already read for it. Returns the snapshot now stored. */
async function applyAgainstRow(
  client: ContentClient,
  params: IncomingContentParams,
  existing: ContentRowShape | null,
): Promise<{ result: ApplyContentResult; stored: ContentRowShape | null }> {
  const now = params.now ?? new Date()
  const plan = planContentUpdate(snapshotFromRow(existing), params.incoming)
  if (plan.changed.length === 0) {
    return { result: { changed: [], keptDespiteEmpty: plan.keptDespiteEmpty, created: false }, stored: existing }
  }
  const stamps: { shortDescriptionChangedAt?: Date; longDescriptionChangedAt?: Date; imagesChangedAt?: Date } = {
    ...(plan.changed.includes('shortDescription') ? { shortDescriptionChangedAt: now } : {}),
    ...(plan.changed.includes('longDescription') ? { longDescriptionChangedAt: now } : {}),
    ...(plan.changed.includes('images') ? { imagesChangedAt: now } : {}),
  }
  const data = {
    shortDescription: plan.next.shortDescription,
    longDescription: plan.next.longDescription,
    images: plan.next.images as unknown as Prisma.InputJsonValue,
    ...(params.sourceModifiedAt !== undefined ? { sourceModifiedAt: params.sourceModifiedAt } : {}),
    ...stamps,
  }
  await client.productContent.upsert({
    where: { productId: params.productId },
    create: { productId: params.productId, sourceSystem: params.sourceSystem ?? 'woocommerce', ...data },
    update: data,
  })
  return {
    result: { changed: plan.changed, keptDespiteEmpty: plan.keptDespiteEmpty, created: existing === null },
    stored: { shortDescription: plan.next.shortDescription, longDescription: plan.next.longDescription, images: plan.next.images as unknown as ProductContent['images'] },
  }
}

export async function applyIncomingProductContent(client: ContentClient, params: IncomingContentParams): Promise<ApplyContentResult> {
  const existing = await client.productContent.findUnique({ where: { productId: params.productId } })
  return (await applyAgainstRow(client, params, existing)).result
}

/**
 * The same as `applyIncomingProductContent` for many products with ONE read: the rows are fetched together and the items applied in order against
 * that copy (kept current as items change it, so a product repeated in the list sees the earlier item's result). Only a changed product costs a write.
 */
export async function applyIncomingProductContentBatch(client: ContentClient, items: readonly IncomingContentParams[]): Promise<ApplyContentResult[]> {
  if (items.length === 0) return []
  const rows = await client.productContent.findMany({ where: { productId: { in: [...new Set(items.map((item) => item.productId))] } } })
  const byProduct = new Map<string, ContentRowShape | null>(rows.map((row) => [row.productId, row]))
  const results: ApplyContentResult[] = []
  for (const item of items) {
    const { result, stored } = await applyAgainstRow(client, item, byProduct.get(item.productId) ?? null)
    byProduct.set(item.productId, stored)
    results.push(result)
  }
  return results
}
