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

export async function applyIncomingProductContent(
  client: ContentClient,
  params: {
    productId: string
    incoming: ProductContentSnapshot
    /** The source product's own last-modified stamp, when it supplied one. */
    sourceModifiedAt?: Date | null
    sourceSystem?: string
    now?: Date
  },
): Promise<ApplyContentResult> {
  const now = params.now ?? new Date()
  const existing = await client.productContent.findUnique({ where: { productId: params.productId } })
  const plan = planContentUpdate(snapshotFromRow(existing), params.incoming)
  if (plan.changed.length === 0) {
    return { changed: [], keptDespiteEmpty: plan.keptDespiteEmpty, created: false }
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
  return { changed: plan.changed, keptDespiteEmpty: plan.keptDespiteEmpty, created: existing === null }
}
