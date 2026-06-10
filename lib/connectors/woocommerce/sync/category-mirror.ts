import { db } from '@/lib/db'
import { wcFetch } from '../api'
import type { ConnectorCredentials } from '@/lib/connectors/types'
import {
  buildProductCategoryPathNormalized,
  cleanProductCategoryName,
} from '@/lib/products/categories'

export type WcCategory = {
  id: number
  name: string
  slug: string
  parent: number
}

export type WcCategoryMirror = {
  wcToIms: Map<number, string>
  wcDepth: Map<number, number>
}

const TREE_CACHE_TTL_MS = 5 * 60 * 1000
let cached: { fetchedAt: number; mirror: WcCategoryMirror } | null = null

export function clearWcCategoryMirrorCache(): void {
  cached = null
}

export async function fetchWcCategoryTree(
  creds?: ConnectorCredentials | null,
): Promise<{ ok: true; categories: WcCategory[] } | { ok: false; error: string }> {
  const all: WcCategory[] = []
  let page = 1
  while (true) {
    const res = await wcFetch('/products/categories', { per_page: '100', page: String(page) }, creds)
    if (res.error) return { ok: false, error: res.error }
    if (!Array.isArray(res.data)) return { ok: false, error: 'Unexpected response shape from WC categories endpoint' }
    for (const raw of res.data as Array<{ id: number; name: string; slug: string; parent?: number }>) {
      all.push({ id: raw.id, name: raw.name, slug: raw.slug, parent: raw.parent ?? 0 })
    }
    if (res.totalPages <= page) break
    page += 1
  }
  return { ok: true, categories: all }
}

/**
 * Build ancestor chain (root-most first) for a WC category id.
 * Cycle-safe via a `seen` guard.
 */
function chainFor(id: number, byId: Map<number, WcCategory>): WcCategory[] {
  const chain: WcCategory[] = []
  const seen = new Set<number>()
  let cur = byId.get(id)
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    chain.unshift(cur)
    cur = cur.parent !== 0 ? byId.get(cur.parent) : undefined
  }
  return chain
}

/**
 * Mirror WC's product category tree into IMS' ProductCategory model. Each WC
 * category becomes an IMS ProductCategory whose nameNormalized is the full
 * normalized path (matches the Phase 1 storage strategy). Returns:
 *   - wcToIms: Map<WC category id, IMS category id>
 *   - wcDepth: Map<WC category id, ancestor count> for picking the deepest leaf
 *
 * Result is cached per-process for TREE_CACHE_TTL_MS so repeated single-product
 * webhook calls don't hammer the WC categories endpoint.
 *
 * Returns null on failure to fetch/build, so callers can skip category linkage
 * and leave the product's categoryId untouched.
 */
export async function ensureWcCategoryTreeMirrored(
  creds?: ConnectorCredentials | null,
): Promise<WcCategoryMirror | null> {
  if (cached && Date.now() - cached.fetchedAt < TREE_CACHE_TTL_MS) {
    return cached.mirror
  }
  const fetched = await fetchWcCategoryTree(creds)
  if (!fetched.ok) return null
  const wcCategories = fetched.categories
  const byId = new Map(wcCategories.map((c) => [c.id, c] as const))

  // Order parents before children so each upsert can resolve its parentId.
  const sorted = [...wcCategories].sort((a, b) => chainFor(a.id, byId).length - chainFor(b.id, byId).length)

  const wcToIms = new Map<number, string>()
  const wcDepth = new Map<number, number>()
  for (const wc of sorted) {
    const chain = chainFor(wc.id, byId)
    const cleanedSegments = chain
      .map((c) => cleanProductCategoryName(c.name))
      .filter((s): s is string => s !== null && s.length > 0)
    if (cleanedSegments.length === 0) continue
    const nameNormalized = buildProductCategoryPathNormalized(cleanedSegments)
    const parentImsId = wc.parent !== 0 ? wcToIms.get(wc.parent) ?? null : null
    const leafName = cleanedSegments[cleanedSegments.length - 1]
    const node: { id: string } = await db.productCategory.upsert({
      where: { nameNormalized },
      create: { name: leafName, nameNormalized, parentId: parentImsId },
      update: {},
      select: { id: true },
    })
    wcToIms.set(wc.id, node.id)
    wcDepth.set(wc.id, chain.length - 1)
  }

  const mirror: WcCategoryMirror = { wcToIms, wcDepth }
  cached = { fetchedAt: Date.now(), mirror }
  return mirror
}

/**
 * From the categories array WC attaches to a product (id, name, slug only),
 * pick the IMS id corresponding to the deepest WC category. Falls back to
 * null if no WC category on the product maps to a mirrored entry.
 */
export function pickDeepestImsCategoryId(
  productWcCategories: ReadonlyArray<{ id: number }>,
  mirror: WcCategoryMirror,
): string | null {
  if (productWcCategories.length === 0) return null
  let bestWcId: number | null = null
  let bestDepth = -1
  for (const c of productWcCategories) {
    if (!mirror.wcToIms.has(c.id)) continue
    const depth = mirror.wcDepth.get(c.id) ?? 0
    if (depth > bestDepth) {
      bestWcId = c.id
      bestDepth = depth
    }
  }
  return bestWcId !== null ? mirror.wcToIms.get(bestWcId) ?? null : null
}
