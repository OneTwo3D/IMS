// ---------------------------------------------------------------------------
// Reorder MO planning (audit-M-mfg #2, #3)
//
// createReorderMOs turns reorder-report rows into draft manufacturing orders.
// Two gaps it must avoid: (a) silently dropping BOM products that have no active
// Bom (the operator thinks MOs were created), and (b) creating duplicate drafts
// on a double-click. This pure helper partitions the candidates into "create"
// and "skipped (with reason)" so both are surfaced and tested without a DB.
// ---------------------------------------------------------------------------

export type ReorderMoSkipReason =
  | 'no_active_bom'
  | 'no_warehouse'
  | 'recent_draft_exists'

export type ReorderMoSkip = { productId: string; sku: string; reason: ReorderMoSkipReason }

export type ReorderMoToCreate = {
  productId: string
  sku: string
  bomId: string
  warehouseId: string
  qtyPlanned: number
}

export type ReorderMoRow = { sku: string; suggestedReorderQty: number }

export function partitionReorderMoCandidates(input: {
  /** Eligible product ids (already filtered to BOM type + suggestedQty > 0). */
  productIds: string[]
  rowByProduct: Map<string, ReorderMoRow>
  bomIdByProduct: Map<string, string>
  warehouseByProduct: Map<string, string | undefined>
  /** Products with a reorder-sourced DRAFT MO created recently (double-click guard). */
  recentDraftProductIds: Set<string>
}): { toCreate: ReorderMoToCreate[]; skipped: ReorderMoSkip[] } {
  const toCreate: ReorderMoToCreate[] = []
  const skipped: ReorderMoSkip[] = []

  for (const productId of input.productIds) {
    const row = input.rowByProduct.get(productId)
    if (!row) continue
    if (input.recentDraftProductIds.has(productId)) {
      skipped.push({ productId, sku: row.sku, reason: 'recent_draft_exists' })
      continue
    }
    const bomId = input.bomIdByProduct.get(productId)
    if (!bomId) {
      skipped.push({ productId, sku: row.sku, reason: 'no_active_bom' })
      continue
    }
    const warehouseId = input.warehouseByProduct.get(productId)
    if (!warehouseId) {
      skipped.push({ productId, sku: row.sku, reason: 'no_warehouse' })
      continue
    }
    toCreate.push({ productId, sku: row.sku, bomId, warehouseId, qtyPlanned: row.suggestedReorderQty })
  }

  return { toCreate, skipped }
}

/**
 * The CLAIMED active Bom for each product (boms.productId = product), keyed by product id.
 *
 * Replaces "the most recently updated active Bom that has an item for this parent", which had no
 * unique answer once two Boms listed the same parent and let `updatedAt` pick between a claimed
 * recipe and a stray duplicate. A product with no claimed active Bom is simply absent from the
 * map, so `partitionReorderMoCandidates` reports it as `no_active_bom` instead of guessing.
 */
export async function claimedActiveBomIdsByProduct(
  client: {
    bom: {
      findMany(args: {
        where: { active: true; productId: { in: string[] } }
        select: { id: true; productId: true }
      }): Promise<Array<{ id: string; productId: string | null }>>
    }
  },
  productIds: string[],
): Promise<Map<string, string>> {
  const bomIdByProduct = new Map<string, string>()
  if (productIds.length === 0) return bomIdByProduct
  const claimed = await client.bom.findMany({
    where: { active: true, productId: { in: productIds } },
    select: { id: true, productId: true },
  })
  for (const bom of claimed) {
    if (bom.productId) bomIdByProduct.set(bom.productId, bom.id)
  }
  return bomIdByProduct
}
