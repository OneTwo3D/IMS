import { db } from '@/lib/db'
import { resolveLineTaxRateBatch } from '@/lib/tax/resolve-rate'

/**
 * The facts a purchase-order margin needs about a product's list price, read once and shared by the PO
 * margin preview, the minimum-margin guard and the list-price edit, so they cannot disagree on what a
 * product sells for. Read-only.
 *
 * Rules (the PO line margin's, o3d-ywzag):
 *  - the price is the line product's OWN default list price (`salesPriceBase`); a variation is priced on
 *    its own row, never from its parent or siblings;
 *  - when the price is stored VAT-inclusive, its sales VAT rate is resolved against the company's home
 *    country; a 'fallback' match (no configured sales rate) is unresolved (null), never an invented 0%.
 */
export type ListPriceFacts = {
  productId: string
  sku: string
  type: string
  parentId: string | null
  salesPrice: string | null
  salesPriceTaxInclusive: boolean
  salesVatRate: number | null
  /** The product's category id then its ancestors', nearest first; a variation with no category takes its parent's chain. */
  categoryChain: string[]
}

const CHAIN_LIMIT = 20

export async function loadListPriceFacts(productIds: readonly string[]): Promise<Map<string, ListPriceFacts>> {
  const out = new Map<string, ListPriceFacts>()
  const ids = [...new Set(productIds)]
  if (ids.length === 0) return out
  const [products, org, categories] = await Promise.all([
    db.product.findMany({
      where: { id: { in: ids } },
      select: { id: true, sku: true, type: true, parentId: true, categoryId: true, salesPriceBase: true, salesPriceTaxInclusive: true, taxCategory: true },
    }),
    db.organisation.findFirst({ select: { country: true } }),
    db.productCategory.findMany({ select: { id: true, parentId: true } }),
  ])
  const parentIds = [...new Set(products.map((p) => p.parentId).filter((x): x is string => !!x))]
  const parents = parentIds.length > 0
    ? await db.product.findMany({ where: { id: { in: parentIds } }, select: { id: true, categoryId: true } })
    : []
  const parentCategory = new Map(parents.map((p) => [p.id, p.categoryId]))
  const categoryParent = new Map(categories.map((c) => [c.id, c.parentId]))
  const chainOf = (start: string | null): string[] => {
    const chain: string[] = []
    let cur = start
    while (cur && chain.length < CHAIN_LIMIT && !chain.includes(cur)) {
      chain.push(cur)
      cur = categoryParent.get(cur) ?? null
    }
    return chain
  }

  const rateByProduct = new Map<string, number | null>()
  const needVat = products.filter((p) => p.salesPriceTaxInclusive && p.salesPriceBase != null)
  if (needVat.length > 0) {
    const resolved = await resolveLineTaxRateBatch(
      needVat.map((p) => ({ id: p.id, productCategory: p.taxCategory })),
      { destinationCountry: org?.country ?? null, usedFor: 'SALES', orderDefault: { id: null, name: null, rate: 0, accountingTaxType: null } },
    )
    for (const [id, r] of resolved) rateByProduct.set(id, r.matched !== 'fallback' ? r.taxRateValue : null)
  }

  for (const p of products) {
    const ownCategory = p.categoryId ?? (p.parentId ? parentCategory.get(p.parentId) ?? null : null)
    out.set(p.id, {
      productId: p.id,
      sku: p.sku,
      type: p.type,
      parentId: p.parentId,
      salesPrice: p.salesPriceBase?.toString() ?? null,
      salesPriceTaxInclusive: p.salesPriceTaxInclusive,
      salesVatRate: rateByProduct.get(p.id) ?? null,
      categoryChain: chainOf(ownCategory),
    })
  }
  return out
}
