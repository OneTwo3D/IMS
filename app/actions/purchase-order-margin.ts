'use server'

import { z } from 'zod'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth/server'
import { hasPermission } from '@/lib/permissions'
import { loadListPriceFacts } from '@/lib/domain/purchasing/list-price-facts'
import { getSettingValue } from '@/lib/settings-store'
import {
  MARGIN_THRESHOLD_SETTING_KEY,
  assessLineAgainstMinimum,
  hasAnyMarginThreshold,
  parseMarginThresholdSettings,
  resolveMinimumMarginPct,
  type LineThresholdAssessment,
  type MarginThresholdMode,
} from '@/lib/domain/purchasing/margin-threshold'
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
  /** The line against its minimum margin (o3d-hqvrp.380): 'none' when no minimum applies, 'unknown' when the margin is unavailable. */
  threshold: LineThresholdAssessment
  /** o3d-hqvrp.381: the list price can be edited from the margin column (needs inventory.edit as well as inventory.prices). False for a variable parent, which is priced by its variations. */
  listPriceEditable: boolean
  /** The list price is stored VAT-inclusive; the edit still takes the ex-VAT price the column shows. */
  listPriceStoredVatInclusive: boolean
}

export type PoMarginPreview =
  | {
      success: true
      lines: PoLineMarginRow[]
      total: PoMarginTotal
      /** null when no minimum is configured anywhere: the form shows nothing extra. */
      thresholdMode: MarginThresholdMode | null
    }
  | { success: false; error: string }

export async function previewPoLineMargins(rawInput: z.input<typeof inputSchema>): Promise<PoMarginPreview> {
  const session = await requirePermission('inventory.prices')
  const mayEditPrice = hasPermission(session.user.role, 'inventory.edit')
  const parsed = inputSchema.safeParse(rawInput)
  if (!parsed.success) return { success: false, error: 'Invalid margin request' }
  const { lines, pricesIncludeVat, fxRate } = parsed.data
  if (lines.length === 0) return { success: true, lines: [], total: computePoMarginTotal([]), thresholdMode: null }

  const productIds = [...new Set(lines.map((l) => l.productId))]
  const [facts, thresholdRaw, layers] = await Promise.all([
    loadListPriceFacts(productIds),
    getSettingValue(MARGIN_THRESHOLD_SETTING_KEY),
    db.costLayer.findMany({
      where: { productId: { in: productIds }, remainingQty: { gt: 0 } },
      select: { productId: true, remainingQty: true, unitCostBase: true },
    }),
  ])
  const threshold = parseMarginThresholdSettings(thresholdRaw)
  const thresholdActive = hasAnyMarginThreshold(threshold)

  const costAgg = new Map<string, { value: ReturnType<typeof toDecimal>; qty: ReturnType<typeof toDecimal> }>()
  for (const l of layers) {
    const cur = costAgg.get(l.productId) ?? { value: toDecimal(0), qty: toDecimal(0) }
    cur.value = cur.value.add(toDecimal(l.remainingQty).mul(toDecimal(l.unitCostBase)))
    cur.qty = cur.qty.add(toDecimal(l.remainingQty))
    costAgg.set(l.productId, cur)
  }

  const rows: PoLineMarginRow[] = lines.map((l) => {
    const f = facts.get(l.productId)
    const result = computeLineMargin({
      qty: l.qty,
      unitCost: l.unitCost,
      discount: l.discount,
      purchaseUnitFactor: l.purchaseUnitFactor,
      taxRate: l.taxRate,
      pricesIncludeVat,
      fxRate,
      salesPrice: f?.salesPrice ?? null,
      salesPriceTaxInclusive: f?.salesPriceTaxInclusive ?? false,
      // The facts loader leaves the rate null on a 'fallback' match: refuse rather than strip an invented 0%.
      salesVatRate: f?.salesVatRate ?? null,
    })
    const minimum = thresholdActive && f
      ? resolveMinimumMarginPct(threshold, { productId: f.productId, parentId: f.parentId, categoryChain: f.categoryChain })
      : null
    const agg = costAgg.get(l.productId)
    return {
      key: l.key,
      result,
      currentCostBase: agg && agg.qty.gt(0) ? agg.value.div(agg.qty).toDecimalPlaces(4).toFixed() : null,
      threshold: assessLineAgainstMinimum(result, minimum),
      listPriceEditable: mayEditPrice && !!f && f.type !== 'VARIABLE',
      listPriceStoredVatInclusive: f?.salesPriceTaxInclusive ?? false,
    }
  })
  return {
    success: true,
    lines: rows,
    total: computePoMarginTotal(rows.map((r) => r.result)),
    thresholdMode: thresholdActive ? threshold.mode : null,
  }
}
