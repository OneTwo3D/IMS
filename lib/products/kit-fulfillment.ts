import { db } from '@/lib/db'
import { Prisma, type ProductType } from '@/app/generated/prisma/client'
import { toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'

type FulfillmentClient = Prisma.TransactionClient | typeof db

export type FulfillmentGraphNode = {
  id: string
  type: ProductType
  productComponents: Array<{
    componentId: string
    componentSku: string
    qty: Prisma.Decimal
    componentType: ProductType
    componentOversellAllowed: boolean
  }>
}

export async function loadFulfillmentProductGraph(
  client: FulfillmentClient,
  rootProductIds: string[],
): Promise<Map<string, FulfillmentGraphNode>> {
  const graph = new Map<string, FulfillmentGraphNode>()
  const queue = [...new Set(rootProductIds.filter(Boolean))]

  while (queue.length > 0) {
    const batch = queue.filter((id) => !graph.has(id))
    queue.length = 0
    if (batch.length === 0) continue

    const rows = await client.product.findMany({
      where: { id: { in: batch } },
      select: {
        id: true,
        type: true,
        productComponents: {
          select: {
            componentId: true,
            qty: true,
            component: { select: { sku: true, type: true, oversellAllowed: true } },
          },
          orderBy: { sortOrder: 'asc' },
        },
      },
    })

    for (const row of rows) {
      graph.set(row.id, {
        id: row.id,
        type: row.type,
        productComponents: row.productComponents.map((component) => ({
          componentId: component.componentId,
          componentSku: component.component.sku,
          qty: toDecimal(component.qty),
          componentType: component.component.type,
          componentOversellAllowed: component.component.oversellAllowed,
        })),
      })
      for (const component of row.productComponents) {
        if (component.component.type === 'KIT' && !graph.has(component.componentId)) {
          queue.push(component.componentId)
        }
      }
    }
  }

  return graph
}

export function expandFulfillmentRequirementsDecimal(
  productId: string,
  qty: DecimalInput,
  graph: Map<string, FulfillmentGraphNode>,
): Map<string, Prisma.Decimal> {
  const totals = new Map<string, Prisma.Decimal>()

  function addRequirement(componentProductId: string, requiredQty: Prisma.Decimal) {
    totals.set(
      componentProductId,
      (totals.get(componentProductId) ?? new Prisma.Decimal(0)).add(requiredQty),
    )
  }

  function visit(currentProductId: string, currentQty: Prisma.Decimal, stack: Set<string>) {
    if (!currentQty.isFinite() || currentQty.lte(0)) return
    const node = graph.get(currentProductId)
    if (!node) {
      // Product referenced as a component but not loaded in the graph —
      // possible orphaned component reference or data inconsistency.
      // Treat as a leaf (accumulate to totals) but log a warning so ops
      // can investigate rather than silently masking the issue.
      console.warn(`[kit-fulfillment] Product ${currentProductId} referenced as component but not found in graph — treating as leaf`)
      addRequirement(currentProductId, currentQty)
      return
    }
    if (node.type !== 'KIT' || node.productComponents.length === 0) {
      addRequirement(currentProductId, currentQty)
      return
    }
    if (stack.has(currentProductId)) {
      throw new Error(`Circular kit structure detected for product ${currentProductId}`)
    }

    stack.add(currentProductId)
    for (const component of node.productComponents) {
      const requiredQty = currentQty.mul(component.qty)
      if (component.componentType === 'KIT') {
        visit(component.componentId, requiredQty, stack)
      } else {
        addRequirement(component.componentId, requiredQty)
      }
    }
    stack.delete(currentProductId)
  }

  visit(productId, toDecimal(qty), new Set<string>())
  return totals
}

export function listFulfillmentLeafProductIds(
  productIds: string[],
  graph: Map<string, FulfillmentGraphNode>,
): string[] {
  const ids = new Set<string>()
  for (const productId of productIds) {
    for (const leafId of expandFulfillmentRequirementsDecimal(productId, 1, graph).keys()) {
      ids.add(leafId)
    }
  }
  return [...ids]
}

export function getFulfillmentAvailableQtyDecimal(
  productId: string,
  warehouseId: string,
  graph: Map<string, FulfillmentGraphNode>,
  stockByProductWarehouse: Map<string, Map<string, DecimalInput>>,
  memo = new Map<string, Prisma.Decimal>(),
  stack = new Set<string>(),
): Prisma.Decimal {
  const memoKey = `${productId}|${warehouseId}`
  const memoized = memo.get(memoKey)
  if (memoized) return memoized

  const node = graph.get(productId)
  if (!node || node.type !== 'KIT' || node.productComponents.length === 0) {
    const available = Prisma.Decimal.max(
      new Prisma.Decimal(0),
      toDecimal(stockByProductWarehouse.get(productId)?.get(warehouseId)),
    )
    memo.set(memoKey, available)
    return available
  }

  if (stack.has(memoKey)) {
    const zero = new Prisma.Decimal(0)
    memo.set(memoKey, zero)
    return zero
  }

  stack.add(memoKey)

  let available: Prisma.Decimal | null = null
  for (const component of node.productComponents) {
    if (!component.qty.isFinite() || component.qty.lte(0)) {
      available = new Prisma.Decimal(0)
      break
    }

    const componentAvailable = component.componentType === 'KIT'
      ? getFulfillmentAvailableQtyDecimal(component.componentId, warehouseId, graph, stockByProductWarehouse, memo, stack)
      : Prisma.Decimal.max(
        new Prisma.Decimal(0),
        toDecimal(stockByProductWarehouse.get(component.componentId)?.get(warehouseId)),
      )

    const componentCoverage = componentAvailable.div(component.qty)
    available = available == null ? componentCoverage : Prisma.Decimal.min(available, componentCoverage)
  }

  stack.delete(memoKey)
  const resolved = available == null ? new Prisma.Decimal(0) : Prisma.Decimal.max(new Prisma.Decimal(0), available)
  memo.set(memoKey, resolved)
  return resolved
}
