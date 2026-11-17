'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { db } from '@/lib/db'
import { logActivityInTransaction } from '@/lib/activity-log'
import { requirePermission } from '@/lib/auth/server'
import { hasPermission } from '@/lib/permissions'
import { pushProductMetadata } from '@/lib/shopping'
import { scheduleWmsProductSync, isAnyWmsConnectorEnabled } from '@/lib/domain/wms/product-sync-dispatch'
import { ProductSkuTakenError, lockProductSkusForWrite } from '@/lib/products/sku-write-lock'
import { resolveExVatListPrice } from '@/lib/domain/purchasing/line-margin'
import { loadListPriceFacts } from '@/lib/domain/purchasing/list-price-facts'
import { LIST_PRICE_EDIT_REFUSAL_TEXT, storedListPriceFromExVat } from '@/lib/domain/purchasing/list-price-edit'

/**
 * INTERNAL ONLY (o3d-hqvrp.381). Adjust a product's default list price from the PO margin column.
 *
 * Gated on `inventory.prices`, the permission that already guards price figures and shows the column.
 * It writes the product row through the same product-update mechanics as the product editor: the SKU
 * write lock, one transaction, an activity-log entry in that transaction (a failed audit write rolls the
 * price back), then the product's normal post-commit sync (`pushProductMetadata`, and the WMS product
 * sync for a user who may sync). It NEVER calls a connector or a vendor API itself: WooCommerce and the
 * warehouse see the new price only through those dispatchers, which apply their own hold, shadow and
 * settings checks.
 *
 * The edit is the EX-VAT price the margin column shows. It is converted to the product's stored
 * convention (VAT-inclusive or not) exactly as the margin reads it back, so the margin after the edit is
 * computed from the same rule as before it. The line's own product is the one written: a variation is
 * priced on its own row, a variable parent is refused, siblings and the parent are never touched.
 */

const NO_SHOP_CONNECTOR = 'No runnable shopping connector configured'

const inputSchema = z.object({
  productId: z.string().min(1).max(64),
  exVatPrice: z.string().max(32),
})

export type ListPriceEditResult =
  | {
      success: true
      /** The list price as now stored, in the product's own convention. */
      storedPrice: string
      /** The ex-VAT price the margin column reads back from it. */
      exVatPrice: string
      /** Whether the product sync was dispatched; the price is saved either way. */
      syncNote: string | null
    }
  | { success: false; error: string }

export async function updateProductListPrice(rawInput: z.input<typeof inputSchema>): Promise<ListPriceEditResult> {
  const session = await requirePermission('inventory.prices')
  const parsed = inputSchema.safeParse(rawInput)
  if (!parsed.success) return { success: false, error: 'Invalid price request' }
  const { productId, exVatPrice } = parsed.data

  const facts = (await loadListPriceFacts([productId])).get(productId)
  if (!facts) return { success: false, error: 'Product not found' }
  const converted = storedListPriceFromExVat({
    exVatPrice,
    storedVatInclusive: facts.salesPriceTaxInclusive,
    salesVatRate: facts.salesVatRate,
    productType: facts.type,
  })
  if (!converted.ok) return { success: false, error: LIST_PRICE_EDIT_REFUSAL_TEXT[converted.reason] }
  const stored = converted.stored

  let before: string | null = null
  try {
    await db.$transaction(async (tx) => {
      await lockProductSkusForWrite(tx, [facts.sku])
      const current = await tx.product.findUnique({
        where: { id: productId },
        select: { sku: true, type: true, salesPriceBase: true, salesPriceTaxInclusive: true },
      })
      if (!current) throw new Error('Product not found')
      // Re-checked under the lock: the product may have been renamed, retyped or repriced convention since the facts were read.
      if (current.sku !== facts.sku) throw new ProductSkuTakenError(facts.sku)
      if (current.type === 'VARIABLE') throw new Error(LIST_PRICE_EDIT_REFUSAL_TEXT['variable-parent'])
      if (current.salesPriceTaxInclusive !== facts.salesPriceTaxInclusive) throw new Error('The product changed while the price was being saved. Reload and try again.')
      before = current.salesPriceBase?.toString() ?? null
      await tx.product.update({ where: { id: productId }, data: { salesPriceBase: stored.toFixed(4) } })
      await logActivityInTransaction(tx, {
        entityType: 'PRODUCT',
        entityId: productId,
        action: 'list_price_updated',
        tag: 'inventory',
        level: 'INFO',
        userId: session.user.id ?? null,
        description: `Changed list price of ${facts.sku} from the purchase order margin column`,
        metadata: {
          sku: facts.sku,
          from: before,
          to: stored.toFixed(4),
          enteredExVat: exVatPrice.trim(),
          storedVatInclusive: facts.salesPriceTaxInclusive,
          source: 'purchase-order-margin',
        },
      })
    })
  } catch (e) {
    if (e instanceof ProductSkuTakenError) return { success: false, error: 'The product changed while the price was being saved. Reload and try again.' }
    return { success: false, error: e instanceof Error ? e.message : String(e) }
  }

  // The normal product sync, after the commit, exactly as the product editor does it. Best effort: the price is already saved.
  const problems: string[] = []
  try {
    const pushed = await pushProductMetadata(productId)
    // No runnable shop connector, a skipped push and a shadowed one are all deliberate outcomes, not failures to report.
    if (!pushed.success && !pushed.shadowed && !pushed.skipped && pushed.error !== NO_SHOP_CONNECTOR) problems.push('the shop sync did not accept it yet')
  } catch (error) {
    console.error(error)
    problems.push('the shop sync did not accept it yet')
  }
  try {
    if (hasPermission(session.user.role, 'sync') && await isAnyWmsConnectorEnabled()) scheduleWmsProductSync(productId)
  } catch (error) {
    console.error(error)
    problems.push('the warehouse sync could not be scheduled')
  }
  for (const path of ['/inventory', `/inventory/${productId}`, '/purchase-orders']) {
    try { revalidatePath(path) } catch { /* cache refresh only */ }
  }

  const readBack = resolveExVatListPrice({
    salesPrice: stored.toFixed(4),
    salesPriceTaxInclusive: facts.salesPriceTaxInclusive,
    salesVatRate: facts.salesVatRate,
  })
  return {
    success: true,
    storedPrice: stored.toFixed(4),
    exVatPrice: readBack.kind === 'ok' ? readBack.price.toDecimalPlaces(6).toFixed() : exVatPrice.trim(),
    syncNote: problems.length > 0 ? `Price saved; ${problems.join(' and ')}. The product sync will retry.` : null,
  }
}
