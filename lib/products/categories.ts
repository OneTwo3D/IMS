import { db } from '@/lib/db'
import type { Prisma } from '@/app/generated/prisma/client'

const ZERO_WIDTH_CHARS = /[\u200B-\u200D\uFEFF]/g
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g
const DIACRITICS = /\p{Diacritic}/gu

export const PRODUCT_CATEGORY_NAME_MAX_LENGTH = 100
export const PRODUCT_CATEGORY_PATH_DELIMITER = '>'
export const PRODUCT_CATEGORY_PATH_DISPLAY_SEPARATOR = ' > '

export type ProductCategoryOption = {
  id: string
  name: string
  parentId: string | null
}

export type ProductCategoryNode = ProductCategoryOption & {
  path: string
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

/**
 * Split a user-supplied path string like "Apparel > T-Shirts > V-Neck" into
 * cleaned segments. Empty segments are dropped, so "Apparel >> T-Shirts" still
 * yields a 2-segment path. Trims surrounding whitespace and collapses runs.
 */
export function parseProductCategoryPath(input: string | null | undefined): string[] {
  if (!input) return []
  return input
    .split(PRODUCT_CATEGORY_PATH_DELIMITER)
    .map((segment) => cleanProductCategoryName(segment))
    .filter((segment): segment is string => segment !== null && segment.length > 0)
}

/**
 * Build the stored `nameNormalized` for a given sequence of cleaned segments
 * (parent-most first). This is the database identity for a category: two leaves
 * under different parents normalize to different strings so they coexist.
 */
export function buildProductCategoryPathNormalized(cleanedSegments: readonly string[]): string {
  return cleanedSegments
    .map((segment) => normalizeProductCategoryName(segment))
    .join(PRODUCT_CATEGORY_PATH_DELIMITER)
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
