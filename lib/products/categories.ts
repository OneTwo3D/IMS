import { db } from '@/lib/db'
import type { Prisma } from '@/app/generated/prisma/client'

const ZERO_WIDTH_CHARS = /[\u200B-\u200D\uFEFF]/g
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g
const DIACRITICS = /\p{Diacritic}/gu

export const PRODUCT_CATEGORY_NAME_MAX_LENGTH = 100

export type ProductCategoryOption = {
  id: string
  name: string
  parentId: string | null
}

export function normalizeProductCategoryName(value: string): string {
  return cleanProductCategoryName(value)
    ?.normalize('NFKD')
    .replace(DIACRITICS, '')
    .toLocaleLowerCase('en-US') ?? ''
}

export function cleanProductCategoryName(value: string | null | undefined): string | null {
  const cleaned = value
    ?.normalize('NFKC')
    .replace(ZERO_WIDTH_CHARS, '')
    .replace(CONTROL_CHARS, ' ')
    .trim()
    .replace(/\s+/g, ' ') ?? ''
  return cleaned.length > 0 ? cleaned : null
}

export async function resolveProductCategoryIdByName(
  categoryName: string | null | undefined,
  options?: {
    client?: Pick<Prisma.TransactionClient, 'productCategory'> | Pick<typeof db, 'productCategory'>
    dryRun?: boolean
  },
): Promise<string | null> {
  const name = cleanProductCategoryName(categoryName)
  if (!name) return null
  if (name.length > PRODUCT_CATEGORY_NAME_MAX_LENGTH) {
    throw new Error(`Product category names must be ${PRODUCT_CATEGORY_NAME_MAX_LENGTH} characters or fewer`)
  }
  const nameNormalized = normalizeProductCategoryName(name)

  // Preview imports need a stable, non-database id so repeated rows with the same
  // normalized category key dedupe the same way as the live unique constraint.
  if (options?.dryRun) return `preview-category:${nameNormalized}`

  const client = options?.client ?? db
  const category = await client.productCategory.upsert({
    where: { nameNormalized },
    create: {
      name,
      nameNormalized,
    },
    // Preserve the first display spelling/case for this normalized key.
    update: {},
    select: { id: true },
  })
  return category.id
}

export async function listProductCategoryOptions(): Promise<ProductCategoryOption[]> {
  // Product reporting categories are expected to stay small in v1. If operators
  // start managing hundreds of categories, replace this with paged/searchable UI.
  return db.productCategory.findMany({
    select: { id: true, name: true, parentId: true },
    orderBy: { name: 'asc' },
  })
}
