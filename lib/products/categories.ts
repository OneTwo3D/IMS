import { db } from '@/lib/db'
import type { Prisma } from '@/app/generated/prisma/client'
import {
  PRODUCT_CATEGORY_NAME_MAX_LENGTH, PRODUCT_CATEGORY_PATH_DELIMITER, PRODUCT_CATEGORY_PATH_DISPLAY_SEPARATOR,
  buildProductCategoryPathNormalized, cleanProductCategoryName, decodeHtmlEntities, normalizeProductCategoryName, parseProductCategoryPath,
} from './category-name'

export {
  PRODUCT_CATEGORY_NAME_MAX_LENGTH, PRODUCT_CATEGORY_PATH_DELIMITER, PRODUCT_CATEGORY_PATH_DISPLAY_SEPARATOR,
  buildProductCategoryPathNormalized, cleanProductCategoryName, decodeHtmlEntities, normalizeProductCategoryName, parseProductCategoryPath,
} from './category-name'


export type ProductCategoryOption = {
  id: string
  name: string
  parentId: string | null
}

export type ProductCategoryNode = ProductCategoryOption & {
  path: string
}


/**
 * Build a user-facing display path from cleaned segments, e.g. "Apparel > T-Shirts".
 */
export function buildProductCategoryPathDisplay(cleanedSegments: readonly string[]): string {
  return cleanedSegments.join(PRODUCT_CATEGORY_PATH_DISPLAY_SEPARATOR)
}

/**
 * Walk the IMS category tree from `options` to produce the full ancestor name
 * chain for `categoryId`, returned parent-most first. Returns an empty array if
 * the category is not in `options`.
 */
export function getProductCategoryAncestry(
  categoryId: string,
  options: readonly ProductCategoryOption[],
): ProductCategoryOption[] {
  const byId = new Map(options.map((c) => [c.id, c] as const))
  const chain: ProductCategoryOption[] = []
  let current = byId.get(categoryId)
  const seen = new Set<string>()
  while (current) {
    if (seen.has(current.id)) break // cycle guard, should never trigger
    seen.add(current.id)
    chain.unshift(current)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return chain
}

/**
 * Build a Map from category id to its display path ("A > B > C") given the
 * full set of options. One pass, memoized.
 */
export function buildProductCategoryPathMap(options: readonly ProductCategoryOption[]): Map<string, string> {
  const byId = new Map(options.map((c) => [c.id, c] as const))
  const cache = new Map<string, string>()
  function resolve(id: string): string {
    const memo = cache.get(id)
    if (memo !== undefined) return memo
    const node = byId.get(id)
    if (!node) {
      cache.set(id, '')
      return ''
    }
    const prefix = node.parentId ? resolve(node.parentId) : ''
    const display = prefix.length > 0
      ? `${prefix}${PRODUCT_CATEGORY_PATH_DISPLAY_SEPARATOR}${node.name}`
      : node.name
    cache.set(id, display)
    return display
  }
  for (const c of options) resolve(c.id)
  return cache
}

type CategoryUpsertClient = Pick<Prisma.TransactionClient, 'productCategory'> | Pick<typeof db, 'productCategory'>

/**
 * Resolve a category id from either a path string (e.g. "Apparel > T-Shirts")
 * or a bare leaf name (legacy callers, treated as a single-segment path).
 *
 * Walks the path top-down, upserting each segment under its computed parent.
 * `nameNormalized` stores the full normalized path so two leaves with the same
 * display name under different parents coexist:
 *
 *   "Apparel > T-Shirts" -> nameNormalized = "apparel>t-shirts"
 *   "Promo > T-Shirts"   -> nameNormalized = "promo>t-shirts"
 *
 * Returns the id of the deepest segment.
 */
export async function resolveProductCategoryIdByName(
  input: string | null | undefined,
  options?: {
    client?: CategoryUpsertClient
    dryRun?: boolean
  },
): Promise<string | null> {
  const segments = parseProductCategoryPath(input)
  if (segments.length === 0) return null
  for (const segment of segments) {
    if (segment.length > PRODUCT_CATEGORY_NAME_MAX_LENGTH) {
      throw new Error(`Product category names must be ${PRODUCT_CATEGORY_NAME_MAX_LENGTH} characters or fewer`)
    }
  }
  if (options?.dryRun) {
    return `preview-category:${buildProductCategoryPathNormalized(segments)}`
  }
  const client = options?.client ?? db
  let parentId: string | null = null
  for (let i = 0; i < segments.length; i++) {
    const partial = segments.slice(0, i + 1)
    const pathNormalized = buildProductCategoryPathNormalized(partial)
    const leafName = segments[i]
    const node: { id: string } = await client.productCategory.upsert({
      where: { nameNormalized: pathNormalized },
      create: {
        name: leafName,
        nameNormalized: pathNormalized,
        parentId,
      },
      // Preserve the first display spelling/case + parent linkage for this normalized key.
      update: {},
      select: { id: true },
    })
    parentId = node.id
  }
  return parentId
}

export async function listProductCategoryOptions(): Promise<ProductCategoryOption[]> {
  return db.productCategory.findMany({
    select: { id: true, name: true, parentId: true },
    orderBy: { name: 'asc' },
  })
}

/**
 * Return categories enriched with their full display path, sorted alphabetically
 * by path. Suitable for selector UIs.
 */
export async function listProductCategoryNodes(): Promise<ProductCategoryNode[]> {
  const options = await listProductCategoryOptions()
  const paths = buildProductCategoryPathMap(options)
  return options
    .map((o) => ({ ...o, path: paths.get(o.id) ?? o.name }))
    .sort((a, b) => a.path.localeCompare(b.path, 'en-US', { sensitivity: 'base' }))
}
