import { ProductType } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'

const OPEN_SALES_ORDER_STATUSES = ['DRAFT', 'PENDING_PAYMENT', 'ON_HOLD', 'PROCESSING', 'ALLOCATED', 'PICKING', 'PACKING'] as const
const OPEN_PURCHASE_ORDER_STATUSES = ['DRAFT', 'RFQ_SENT', 'QUOTE_RECEIVED', 'PO_SENT', 'SHIPPED', 'PARTIALLY_RECEIVED'] as const
const OPEN_PRODUCTION_ORDER_STATUSES = ['DRAFT', 'IN_PROGRESS'] as const
const OPEN_TRANSFER_STATUSES = ['DRAFT', 'IN_TRANSIT'] as const

const CHILD_CAPABLE_TYPES = new Set<ProductType>([ProductType.VARIANT, ProductType.KIT, ProductType.BOM])
const COMPONENT_TYPES = new Set<ProductType>([ProductType.KIT, ProductType.BOM])
const TRANSFORMABLE_TYPES = new Set<ProductType>([ProductType.SIMPLE, ProductType.VARIANT, ProductType.KIT, ProductType.BOM])

/**
 * Everything a structure validation reads: the product row itself AND the five tables that
 * say whether the row is live (o3d-y89x r2).
 *
 * It has to name all six. `getProductTransformBlockers` used to read the module-level `db`
 * regardless of what the caller passed, so the editor's INSIDE-the-transaction re-validation
 * (o3d-42hw) checked the row under `tx` and the blockers on a different connection — i.e.
 * outside the locks it had just taken, against a snapshot that could already have moved.
 * Threading the client through is what makes `client: tx` mean what it says.
 */
export type ProductStructureClient = Pick<
  typeof db,
  'product' | 'stockLevel' | 'salesOrderLine' | 'purchaseOrderLine' | 'productionOrder' | 'stockTransferLine'
>

type ProductStructureInput = {
  productId?: string
  type: ProductType
  parentId?: string | null
  /**
   * Client to validate against. Defaults to the module-level `db`, which is what the
   * pre-transaction fast path uses. The editor re-validates INSIDE its write transaction
   * (o3d-42hw) and must pass `tx`, or it would re-read the same pre-lock state and prove
   * nothing — a WooCommerce import committing in between would still be overwritten with
   * structure decided against a state that no longer exists.
   */
  client?: ProductStructureClient
}

type CurrentProductShape = {
  id: string
  sku: string
  type: ProductType
  parentId: string | null
}

export type ProductStructureValidationResult =
  | {
      ok: true
      current: CurrentProductShape | null
      normalizedParentId: string | null
      clearComponents: boolean
      clearExternalMapping: boolean
    }
  | {
      ok: false
      fieldErrors: Record<string, string[]>
      message: string
    }

export type ProductTransformBlockers = {
  stockQty: number
  reservedQty: number
  openSalesOrderLines: number
  openPurchaseOrderLines: number
  openProductionOrders: number
  openTransferLines: number
}

export function isVariantChildProduct(input: { parentId?: string | null }): boolean {
  return Boolean(input.parentId)
}

export function canTypeHaveVariableParent(type: ProductType): boolean {
  return CHILD_CAPABLE_TYPES.has(type)
}

export function isComponentProductType(type: ProductType): boolean {
  return COMPONENT_TYPES.has(type)
}

/** True when any blocker is present. The one place "is this row live?" is decided. */
export function hasProductTransformBlockers(blockers: ProductTransformBlockers): boolean {
  return blockers.stockQty > 0
    || blockers.reservedQty > 0
    || blockers.openSalesOrderLines > 0
    || blockers.openPurchaseOrderLines > 0
    || blockers.openProductionOrders > 0
    || blockers.openTransferLines > 0
}

export function summarizeTransformBlockers(blockers: ProductTransformBlockers): string {
  const parts: string[] = []
  if (blockers.stockQty > 0) parts.push(`stock on hand (${blockers.stockQty.toFixed(2)})`)
  if (blockers.reservedQty > 0) parts.push(`reserved stock (${blockers.reservedQty.toFixed(2)})`)
  if (blockers.openSalesOrderLines > 0) parts.push(`${blockers.openSalesOrderLines} open sales order line${blockers.openSalesOrderLines === 1 ? '' : 's'}`)
  if (blockers.openPurchaseOrderLines > 0) parts.push(`${blockers.openPurchaseOrderLines} open purchase order line${blockers.openPurchaseOrderLines === 1 ? '' : 's'}`)
  if (blockers.openProductionOrders > 0) parts.push(`${blockers.openProductionOrders} open manufacturing order${blockers.openProductionOrders === 1 ? '' : 's'}`)
  if (blockers.openTransferLines > 0) parts.push(`${blockers.openTransferLines} open stock transfer line${blockers.openTransferLines === 1 ? '' : 's'}`)
  return parts.join(', ')
}

/**
 * The rows that make a product LIVE: stock, reservations, open sales/purchase/production/
 * transfer documents. Transforming a product's type or parent while any of these exist is
 * what the editor refuses (`Cannot change product type while this product has ...`).
 *
 * Exported (o3d-y89x r2) so the WooCommerce connector runs the SAME checks rather than a
 * second copy that drifts: the connector transforms SIMPLE rows too (SIMPLE→VARIABLE on the
 * parent branch, SIMPLE→VARIANT when adopting a variation) and was doing so without asking
 * any of these questions.
 *
 * `client` must be the transaction that holds the row locks; see ProductStructureClient.
 */
export async function getProductTransformBlockers(
  productId: string,
  client: ProductStructureClient = db,
): Promise<ProductTransformBlockers> {
  const [
    stockAggregate,
    openSalesOrderLines,
    openPurchaseOrderLines,
    openProductionOrders,
    openTransferLines,
  ] = await Promise.all([
    client.stockLevel.aggregate({
      where: { productId },
      _sum: { quantity: true, reservedQty: true },
    }),
    client.salesOrderLine.count({
      where: {
        productId,
        order: {
          status: { in: [...OPEN_SALES_ORDER_STATUSES] },
        },
      },
    }),
    client.purchaseOrderLine.count({
      where: {
        productId,
        po: {
          status: { in: [...OPEN_PURCHASE_ORDER_STATUSES] },
        },
      },
    }),
    client.productionOrder.count({
      where: {
        status: { in: [...OPEN_PRODUCTION_ORDER_STATUSES] },
        OR: [
          { outputProductId: productId },
          { outputProduct: { productComponents: { some: { componentId: productId } } } },
        ],
      },
    }),
    client.stockTransferLine.count({
      where: {
        productId,
        transfer: {
          status: { in: [...OPEN_TRANSFER_STATUSES] },
        },
      },
    }),
  ])

  return {
    stockQty: Number(stockAggregate._sum.quantity ?? 0),
    reservedQty: Number(stockAggregate._sum.reservedQty ?? 0),
    openSalesOrderLines,
    openPurchaseOrderLines,
    openProductionOrders,
    openTransferLines,
  }
}

export async function validateProductStructureChange(
  input: ProductStructureInput,
): Promise<ProductStructureValidationResult> {
  const client = input.client ?? db
  const normalizedParentId = input.parentId?.trim() ? input.parentId.trim() : null

  const current = input.productId
    ? await client.product.findUnique({
        where: { id: input.productId },
        select: { id: true, sku: true, type: true, parentId: true },
      })
    : null

  if (input.productId && !current) {
    return {
      ok: false,
      fieldErrors: { type: ['Product not found'] },
      message: 'Product not found',
    }
  }

  if (normalizedParentId && normalizedParentId === input.productId) {
    return {
      ok: false,
      fieldErrors: { parentId: ['A product cannot be its own parent'] },
      message: 'A product cannot be its own parent',
    }
  }

  if (normalizedParentId && !canTypeHaveVariableParent(input.type)) {
    return {
      ok: false,
      fieldErrors: {
        type: ['Only simple variants, bundle variants, and BOM variants can sit under a variable parent'],
      },
      message: 'Only variant, bundle, and BOM products can sit under a variable parent',
    }
  }

  if (input.type === ProductType.VARIANT && !normalizedParentId) {
    return {
      ok: false,
      fieldErrors: { parentId: ['Simple variants must stay attached to a variable parent'] },
      message: 'Simple variants must stay attached to a variable parent',
    }
  }

  if (normalizedParentId) {
    const parent = await client.product.findUnique({
      where: { id: normalizedParentId },
      select: { id: true, type: true },
    })
    if (!parent || parent.type !== ProductType.VARIABLE) {
      return {
        ok: false,
        fieldErrors: { parentId: ['Parent product must be an existing variable product'] },
        message: 'Parent product must be an existing variable product',
      }
    }
  }

  if (current) {
    const typeChanged = current.type !== input.type
    const parentChanged = (current.parentId ?? null) !== normalizedParentId

    if ((typeChanged || parentChanged) && (!TRANSFORMABLE_TYPES.has(current.type) || !TRANSFORMABLE_TYPES.has(input.type))) {
      return {
        ok: false,
        fieldErrors: {
          type: ['This product type cannot be transformed through the standard editor'],
        },
        message: 'This product type cannot be transformed through the standard editor',
      }
    }

    if ((typeChanged || parentChanged) && (current.type === ProductType.VARIABLE || input.type === ProductType.VARIABLE)) {
      return {
        ok: false,
        fieldErrors: {
          type: ['Variable parents cannot be converted through the standard editor'],
        },
        message: 'Variable parents cannot be converted through the standard editor',
      }
    }

    if ((typeChanged || parentChanged) && (current.type === ProductType.NON_INVENTORY || input.type === ProductType.NON_INVENTORY)) {
      return {
        ok: false,
        fieldErrors: {
          type: ['Non-inventory products cannot be converted through the standard editor'],
        },
        message: 'Non-inventory products cannot be converted through the standard editor',
      }
    }

    if (typeChanged || parentChanged) {
      // `client`, not the ambient `db`: inside the editor's write transaction this must read
      // the state the locks are holding, not a parallel connection's snapshot (o3d-y89x r2).
      const blockers = await getProductTransformBlockers(current.id, client)

      if (hasProductTransformBlockers(blockers)) {
        const summary = summarizeTransformBlockers(blockers)
        return {
          ok: false,
          fieldErrors: {
            type: [`Cannot change product type while this product has ${summary}`],
          },
          message: `Cannot change product type while this product has ${summary}`,
        }
      }
    }

    return {
      ok: true,
      current,
      normalizedParentId,
      clearComponents: isComponentProductType(current.type) && !isComponentProductType(input.type),
      clearExternalMapping: typeChanged || parentChanged,
    }
  }

  return {
    ok: true,
    current: null,
    normalizedParentId,
    clearComponents: false,
    clearExternalMapping: false,
  }
}
