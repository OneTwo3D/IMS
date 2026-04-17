import { ProductType } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'

const OPEN_SALES_ORDER_STATUSES = ['DRAFT', 'PENDING_PAYMENT', 'ON_HOLD', 'PROCESSING', 'ALLOCATED', 'PICKING', 'PACKING'] as const
const OPEN_PURCHASE_ORDER_STATUSES = ['DRAFT', 'RFQ_SENT', 'QUOTE_RECEIVED', 'PO_SENT', 'SHIPPED', 'PARTIALLY_RECEIVED'] as const
const OPEN_PRODUCTION_ORDER_STATUSES = ['DRAFT', 'IN_PROGRESS'] as const
const OPEN_TRANSFER_STATUSES = ['DRAFT', 'IN_TRANSIT'] as const

const CHILD_CAPABLE_TYPES = new Set<ProductType>([ProductType.VARIANT, ProductType.KIT, ProductType.BOM])
const COMPONENT_TYPES = new Set<ProductType>([ProductType.KIT, ProductType.BOM])
const TRANSFORMABLE_TYPES = new Set<ProductType>([ProductType.SIMPLE, ProductType.VARIANT, ProductType.KIT, ProductType.BOM])

type ProductStructureInput = {
  productId?: string
  type: ProductType
  parentId?: string | null
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

type ProductTransformBlockers = {
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

function summarizeTransformBlockers(blockers: ProductTransformBlockers): string {
  const parts: string[] = []
  if (blockers.stockQty > 0) parts.push(`stock on hand (${blockers.stockQty.toFixed(2)})`)
  if (blockers.reservedQty > 0) parts.push(`reserved stock (${blockers.reservedQty.toFixed(2)})`)
  if (blockers.openSalesOrderLines > 0) parts.push(`${blockers.openSalesOrderLines} open sales order line${blockers.openSalesOrderLines === 1 ? '' : 's'}`)
  if (blockers.openPurchaseOrderLines > 0) parts.push(`${blockers.openPurchaseOrderLines} open purchase order line${blockers.openPurchaseOrderLines === 1 ? '' : 's'}`)
  if (blockers.openProductionOrders > 0) parts.push(`${blockers.openProductionOrders} open manufacturing order${blockers.openProductionOrders === 1 ? '' : 's'}`)
  if (blockers.openTransferLines > 0) parts.push(`${blockers.openTransferLines} open stock transfer line${blockers.openTransferLines === 1 ? '' : 's'}`)
  return parts.join(', ')
}

async function getProductTransformBlockers(productId: string): Promise<ProductTransformBlockers> {
  const [
    stockAggregate,
    openSalesOrderLines,
    openPurchaseOrderLines,
    openProductionOrders,
    openTransferLines,
  ] = await Promise.all([
    db.stockLevel.aggregate({
      where: { productId },
      _sum: { quantity: true, reservedQty: true },
    }),
    db.salesOrderLine.count({
      where: {
        productId,
        order: {
          status: { in: [...OPEN_SALES_ORDER_STATUSES] },
        },
      },
    }),
    db.purchaseOrderLine.count({
      where: {
        productId,
        po: {
          status: { in: [...OPEN_PURCHASE_ORDER_STATUSES] },
        },
      },
    }),
    db.productionOrder.count({
      where: {
        status: { in: [...OPEN_PRODUCTION_ORDER_STATUSES] },
        OR: [
          { outputProductId: productId },
          { outputProduct: { productComponents: { some: { componentId: productId } } } },
        ],
      },
    }),
    db.stockTransferLine.count({
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
  const normalizedParentId = input.parentId?.trim() ? input.parentId.trim() : null

  const current = input.productId
    ? await db.product.findUnique({
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
    const parent = await db.product.findUnique({
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
      const blockers = await getProductTransformBlockers(current.id)
      const hasBlockers =
        blockers.stockQty > 0
        || blockers.reservedQty > 0
        || blockers.openSalesOrderLines > 0
        || blockers.openPurchaseOrderLines > 0
        || blockers.openProductionOrders > 0
        || blockers.openTransferLines > 0

      if (hasBlockers) {
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
