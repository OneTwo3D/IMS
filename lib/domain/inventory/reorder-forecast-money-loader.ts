import { db } from '@/lib/db'
import { resolveLineTaxRateBatch } from '@/lib/tax/resolve-rate'
import { currentUnitCostBase, type ForecastMoneyProductInputs } from '@/lib/domain/inventory/reorder-forecast-money'

const IN_BATCH = 1000

/**
 * Database reads behind Reorder Planning's forecast sales / margin, for the rows on the page
 * only. Price and VAT rules are the PO line margin's (previewPoLineMargins): the product's default list
 * price, the company's home country as the VAT destination, and a 'fallback' tax match (no configured
 * sales rate) counts as unresolved rather than an invented 0%. Cost is the open cost layers' weighted
 * average, else the latest cost layer. Read-only.
 */
export async function loadForecastMoneyInputs(productIds: string[]): Promise<Map<string, ForecastMoneyProductInputs>> {
  const out = new Map<string, ForecastMoneyProductInputs>()
  if (productIds.length === 0) return out
  const org = await db.organisation.findFirst({ select: { country: true } })
  for (let i = 0; i < productIds.length; i += IN_BATCH) {
    const ids = productIds.slice(i, i + IN_BATCH)
    const [products, openLayers] = await Promise.all([
      db.product.findMany({
        where: { id: { in: ids } },
        select: { id: true, salesPriceBase: true, salesPriceTaxInclusive: true, taxCategory: true },
      }),
      db.costLayer.findMany({
        where: { productId: { in: ids }, remainingQty: { gt: 0 } },
        select: { productId: true, remainingQty: true, unitCostBase: true },
      }),
    ])
    const openByProduct = new Map<string, Array<{ remainingQty: unknown; unitCostBase: unknown }>>()
    for (const layer of openLayers) {
      const list = openByProduct.get(layer.productId) ?? []
      list.push(layer)
      openByProduct.set(layer.productId, list)
    }
    const noOpen = ids.filter((id) => !openByProduct.has(id))
    const latestByProduct = new Map<string, unknown>()
    if (noOpen.length > 0) {
      const latest = await db.costLayer.findMany({
        where: { productId: { in: noOpen } },
        select: { productId: true, unitCostBase: true },
        orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
        distinct: ['productId'],
      })
      for (const layer of latest) latestByProduct.set(layer.productId, layer.unitCostBase)
    }
    const needVat = products.filter((p) => p.salesPriceTaxInclusive && p.salesPriceBase != null)
    const rateByProduct = new Map<string, number | null>()
    if (needVat.length > 0) {
      const resolved = await resolveLineTaxRateBatch(
        needVat.map((p) => ({ id: p.id, productCategory: p.taxCategory })),
        { destinationCountry: org?.country ?? null, usedFor: 'SALES', orderDefault: { id: null, name: null, rate: 0, accountingTaxType: null } },
      )
      for (const [id, r] of resolved) rateByProduct.set(id, r.matched !== 'fallback' ? r.taxRateValue : null)
    }
    for (const p of products) {
      out.set(p.id, {
        salesPrice: p.salesPriceBase,
        salesPriceTaxInclusive: p.salesPriceTaxInclusive,
        salesVatRate: rateByProduct.get(p.id) ?? null,
        unitCostBase: currentUnitCostBase(
          (openByProduct.get(p.id) ?? []) as Array<{ remainingQty: never; unitCostBase: never }>,
          latestByProduct.get(p.id) as never,
        ),
      })
    }
  }
  return out
}
