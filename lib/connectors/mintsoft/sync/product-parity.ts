import type { Prisma, ProductType } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { addMoney, multiplyMoney, roundQuantity, toDecimal, type Decimal } from '@/lib/domain/math/decimal'
import type { WmsProductDto } from '@/lib/connectors/wms/types'
import { fitMintsoftProductName } from '../api/product-name'

/**
 * THE CHANGED PRODUCT FIELDS OF MINTSOFT SYNC PARITY (o3d-zvec.20), applied to the outbound DTO ONLY when
 * `mintsoft_product_parity_enabled` is on. Nothing here is called with the setting off, so the DTO, its hash and the bytes sent are
 * exactly what they were. See settings/product-parity.ts.
 *
 * COST IS BUSINESS-SENSITIVE. It travels only in the DTO that goes to Mintsoft. It is never put in a log line, an activity row, an
 * audit event or an error message from this module, and the sync run redacts `CostPrice` from the Mintsoft echo it keeps in the sync
 * log (see redactMintsoftCostPrice).
 */

type DecimalLike = Prisma.Decimal | number | string | null

export type ParityParent = {
  name: string
  weight: DecimalLike
  widthCm: DecimalLike
  heightCm: DecimalLike
  depthCm: DecimalLike
}

export type ParityProduct = {
  sku: string
  name: string
  type: ProductType
  parent?: ParityParent | null
}

type CostLayerLike = { remainingQty: DecimalLike; unitCostBase: DecimalLike }

/** CostPrice is a per-unit money figure; four places keep a cheap part's cost (the layers carry six). */
const COST_PRECISION = 4

/**
 * Weighted-average unit cost of the layers still holding stock: the figure the product page's inventory value divides to. No stock
 * on hand (so no layer to value) is NO cost: null, never zero, and the field is then not sent (the plugin sent a cost only when
 * it was non-zero).
 */
export function weightedAverageUnitCost(layers: readonly CostLayerLike[]): Decimal | null {
  let qty = toDecimal(0)
  let value = toDecimal(0)
  for (const layer of layers) {
    const remaining = toDecimal(layer.remainingQty)
    if (remaining.lte(0)) continue
    qty = addMoney(qty, remaining)
    value = addMoney(value, multiplyMoney(remaining, layer.unitCostBase))
  }
  return qty.gt(0) ? value.div(qty) : null
}

/** A KIT or BOM costs what its components cost: component quantity times that component's average cost (the product page's rule). */
export function componentsUnitCost(components: ReadonlyArray<{ qty: DecimalLike; layers: readonly CostLayerLike[] }>): Decimal | null {
  let total = toDecimal(0)
  let any = false
  for (const component of components) {
    const average = weightedAverageUnitCost(component.layers)
    if (!average) continue
    any = true
    total = addMoney(total, multiplyMoney(component.qty, average))
  }
  return any ? total : null
}

function toCostPrice(cost: Decimal | null): number | null {
  if (!cost) return null
  const rounded = roundQuantity(cost, COST_PRECISION)
  return rounded.gt(0) ? rounded.toNumber() : null
}

/** The IMS cost of one product from the same cost layers the product page values it with, or null when there is none to send. */
export async function readMintsoftProductCost(productId: string, type: ProductType): Promise<number | null> {
  if (type === 'KIT' || type === 'BOM') {
    const components = await db.productComponent.findMany({
      where: { productId },
      select: {
        qty: true,
        component: { select: { costLayers: { where: { remainingQty: { gt: 0 } }, select: { remainingQty: true, unitCostBase: true } } } },
      },
    })
    return toCostPrice(componentsUnitCost(components.map((c) => ({ qty: c.qty, layers: c.component.costLayers }))))
  }
  const layers = await db.costLayer.findMany({
    where: { productId, remainingQty: { gt: 0 } },
    select: { remainingQty: true, unitCostBase: true },
  })
  return toCostPrice(weightedAverageUnitCost(layers))
}

function numberOrNull(value: DecimalLike | undefined): number | null {
  return value == null ? null : Number(value)
}

/**
 * Inherit per field, as the plugin did: a variation's own value when it has one, the parent's when it has none. A product with no
 * parent inherits nothing. Only a missing (null) value inherits; a recorded zero is the variation's own value.
 */
export function inheritFromParent(
  own: Pick<WmsProductDto, 'weightKg' | 'heightCm' | 'widthCm' | 'depthCm'>,
  parent: ParityParent | null | undefined,
): Pick<WmsProductDto, 'weightKg' | 'heightCm' | 'widthCm' | 'depthCm'> {
  if (!parent) return own
  return {
    weightKg: own.weightKg ?? numberOrNull(parent.weight),
    heightCm: own.heightCm ?? numberOrNull(parent.heightCm),
    widthCm: own.widthCm ?? numberOrNull(parent.widthCm),
    depthCm: own.depthCm ?? numberOrNull(parent.depthCm),
  }
}

/** The parity DTO: fitted name, inherited weight and dimensions, and the cost when there is one. Pure. */
export function applyMintsoftProductParity(dto: WmsProductDto, product: ParityProduct, costPrice: number | null): WmsProductDto {
  const inherited = inheritFromParent(dto, product.type === 'VARIANT' ? product.parent : null)
  return {
    ...dto,
    ...inherited,
    name: fitMintsoftProductName(dto.name, product.type === 'VARIANT' ? product.parent?.name : null, product.sku),
    ...(costPrice != null ? { costPrice } : {}),
  }
}

/** The Mintsoft echo of a product with `CostPrice` removed, for any record that is shown to people (the sync log). */
export function redactMintsoftCostPrice<T>(raw: T): T {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const { CostPrice: _cost, ...rest } = raw as Record<string, unknown>
  void _cost
  return rest as T
}
