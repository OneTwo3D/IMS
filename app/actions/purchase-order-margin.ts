'use server'

import { z } from 'zod'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth/server'
import { resolveLineTaxRateBatch } from '@/lib/tax/resolve-rate'
import { toDecimal } from '@/lib/domain/math/decimal'
import {
  computeLineMargin,
  computePoMarginTotal,
  type LineMarginResult,
  type PoMarginTotal,
} from '@/lib/domain/purchasing/line-margin'

/**
 * INTERNAL ONLY (o3d-ywzag slice 1). Profit margin per purchase-order line, from the entered
 * price. It reads the product's sales price, so it is gated on `inventory.prices`, the permission
 * that already guards cost/price figures; SUPPLIER and WAREHOUSE do not hold it. Nothing here is
 * imported by the supplier portal, quote views, the PO PDF or supplier email (a test pins that).
 * Read-only: it writes nothing.
 */

const lineSchema = z.object({
  key: z.string().min(1).max(64),
  productId: z.string().min(1).max(64),
  qty: z.number().finite(),
  unitCost: z.number().finite(),
  discount: z.string().max(32).optional(),
  purchaseUnitFactor: z.number().finite().positive().default(1),
  taxRate: z.number().finite().min(0),
})

const inputSchema = z.object({
  pricesIncludeVat: z.boolean(),
  /** 1 base = fxRate foreign, as the form shows it; null when the form has none (refused, not guessed). */
  fxRate: z.number().finite().nullable(),
  lines: z.array(lineSchema).max(500),
})

export type PoLineMarginRow = {
  key: string
  result: LineMarginResult
  /** Open-layer average landed cost per unit, base currency; null when no stock is held. */
  currentCostBase: string | null
}

export type PoMarginPreview =
  | { success: true; lines: PoLineMarginRow[]; total: PoMarginTotal }
  | { success: false; error: string }

export async function previewPoLineMargins(rawInput: z.input<typeof inputSchema>): Promise<PoMarginPreview> {
  await requirePermission('inventory.prices')
  const parsed = inputSchema.safeParse(rawInput)
  if (!parsed.success) return { success: false, error: 'Invalid margin request' }
  const { lines, pricesIncludeVat, fxRate } = parsed.data
  if (lines.length === 0) return { success: true, lines: [], total: computePoMarginTotal([]) }

  const productIds = [...new Set(lines.map((l) => l.productId))]
  const [products, org, layers] = await Promise.all([
    db.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, salesPriceBase: true, salesPriceTaxInclusive: true, taxCategory: true },
    }),
    db.organisation.findFirst({ select: { country: true } }),
    db.costLayer.findMany({
      where: { productId: { in: productIds }, remainingQty: { gt: 0 } },
      select: { productId: true, remainingQty: true, unitCostBase: true },
    }),
  ])
  const byId = new Map(products.map((p) => [p.id, p]))

  // Sales VAT rate per product, only needed to strip VAT from an inclusive stored price. The company's
  // home country is the destination; same resolver the sales-order screen uses.
  const rateByProduct = new Map<string, { value: number; matched: string }>()
  const needVat = products.filter((p) => p.salesPriceTaxInclusive && p.salesPriceBase != null)
  if (needVat.length > 0) {
    const resolved = await resolveLineTaxRateBatch(
      needVat.map((p) => ({ id: p.id, productCategory: p.taxCategory })),
      {
        destinationCountry: org?.country ?? null,
        usedFor: 'SALES',
        orderDefault: { id: null, name: null, rate: 0, accountingTaxType: null },
      },
    )
    for (const [id, r] of resolved) rateByProduct.set(id, { value: r.taxRateValue, matched: r.matched })
  }

  const costAgg = new Map<string, { value: ReturnType<typeof toDecimal>; qty: ReturnType<typeof toDecimal> }>()
  for (const l of layers) {
    const cur = costAgg.get(l.productId) ?? { value: toDecimal(0), qty: toDecimal(0) }
    cur.value = cur.value.add(toDecimal(l.remainingQty).mul(toDecimal(l.unitCostBase)))
    cur.qty = cur.qty.add(toDecimal(l.remainingQty))
    costAgg.set(l.productId, cur)
  }

  const rows: PoLineMarginRow[] = lines.map((l) => {
    const p = byId.get(l.productId)
    const vat = p ? rateByProduct.get(p.id) : undefined
    const result = computeLineMargin({
      qty: l.qty,
      unitCost: l.unitCost,
      discount: l.discount,
      purchaseUnitFactor: l.purchaseUnitFactor,
      taxRate: l.taxRate,
      pricesIncludeVat,
      fxRate,
      salesPrice: p?.salesPriceBase ?? null,
      salesPriceTaxInclusive: p?.salesPriceTaxInclusive ?? false,
      // A 'fallback' match means no configured sales rate: refuse rather than strip an invented 0%.
      salesVatRate: vat && vat.matched !== 'fallback' ? vat.value : null,
    })
    const agg = costAgg.get(l.productId)
    return {
      key: l.key,
      result,
      currentCostBase: agg && agg.qty.gt(0) ? agg.value.div(agg.qty).toDecimalPlaces(4).toFixed() : null,
    }
  })
  return { success: true, lines: rows, total: computePoMarginTotal(rows.map((r) => r.result)) }
}
