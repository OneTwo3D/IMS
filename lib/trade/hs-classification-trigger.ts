/**
 * Classification trigger on product change (6igm.7 + the change-detection half of 6igm.5).
 *
 * When a product's classification-relevant fields (name/description/category) change, its PENDING
 * HS-code proposal is stale, so we delete it — which makes the product a candidate for the
 * background sweep again (candidate = eligible product with no proposal). This is intentionally
 * cheap (no Anthropic call in the save path): the actual re-classification happens in the
 * rate-limited sweep, mirroring the plugin's enqueue → async-worker model rather than firing N
 * synchronous API calls on a bulk import.
 *
 * Human-decided (approved/rejected) and already-coded products are left untouched — the sweep's
 * candidate filter excludes them, so they are never auto-reclassified.
 */
import { db } from '@/lib/db'
import { hsClassificationFieldsHash, shouldInvalidateHsProposal } from '@/lib/trade/hs-classification-fields'

export async function invalidateStaleHsProposal(productId: string): Promise<void> {
  const pending = await db.hsCodeProposal.findFirst({
    where: { productId, status: 'PENDING' },
    select: { id: true, classificationFieldsHash: true },
  })
  // No pending proposal (never classified, or already reviewed) → nothing to invalidate; a
  // never-classified product is picked up by the sweep on its own.
  if (!pending) return

  const product = await db.product.findUnique({
    where: { id: productId },
    select: { name: true, description: true, category: { select: { name: true } } },
  })
  if (!product) return

  const currentHash = hsClassificationFieldsHash({
    name: product.name,
    description: product.description,
    categoryPath: product.category?.name ?? null,
  })
  // Drop a stale proposal (fields changed, or a pre-migration proposal with no baseline hash) so
  // the sweep re-proposes with the current fields.
  if (shouldInvalidateHsProposal(pending.classificationFieldsHash, currentHash)) {
    await db.hsCodeProposal.deleteMany({ where: { id: pending.id, status: 'PENDING' } })
  }
}
