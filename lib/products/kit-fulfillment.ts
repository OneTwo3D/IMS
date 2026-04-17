import { db } from '@/lib/db'
import { Prisma, type ProductType } from '@/app/generated/prisma/client'

type FulfillmentClient = Prisma.TransactionClient | typeof db

export type FulfillmentGraphNode = {
  id: string
  type: ProductType
  productComponents: Array<{
    componentId: string
    qty: number
    componentType: ProductType
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
            component: { select: { type: true } },
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
          qty: Number(component.qty),
          componentType: component.component.type,
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

export function expandFulfillmentRequirements(
  productId: string,
  qty: number,
  graph: Map<string, FulfillmentGraphNode>,
): Map<string, number> {
  const totals = new Map<string, number>()

  function visit(currentProductId: string, currentQty: number, stack: Set<string>) {
    if (!Number.isFinite(currentQty) || currentQty <= 0) return
    const node = graph.get(currentProductId)
    if (!node || node.type !== 'KIT' || node.productComponents.length === 0) {
      totals.set(currentProductId, (totals.get(currentProductId) ?? 0) + currentQty)
      return
    }
    if (stack.has(currentProductId)) {
      throw new Error(`Circular kit structure detected for product ${currentProductId}`)
    }

    stack.add(currentProductId)
    for (const component of node.productComponents) {
      const requiredQty = currentQty * component.qty
      if (component.componentType === 'KIT') {
        visit(component.componentId, requiredQty, stack)
      } else {
        totals.set(component.componentId, (totals.get(component.componentId) ?? 0) + requiredQty)
      }
    }
    stack.delete(currentProductId)
  }

  visit(productId, qty, new Set<string>())
  return totals
}

export function listFulfillmentLeafProductIds(
  productIds: string[],
  graph: Map<string, FulfillmentGraphNode>,
): string[] {
  const ids = new Set<string>()
  for (const productId of productIds) {
    for (const leafId of expandFulfillmentRequirements(productId, 1, graph).keys()) {
      ids.add(leafId)
    }
  }
  return [...ids]
}

export function getFulfillmentAvailableQty(
  productId: string,
  warehouseId: string,
  graph: Map<string, FulfillmentGraphNode>,
  stockByProductWarehouse: Map<string, Map<string, number>>,
  memo = new Map<string, number>(),
  stack = new Set<string>(),
): number {
  const memoKey = `${productId}|${warehouseId}`
  if (memo.has(memoKey)) return memo.get(memoKey) ?? 0

  const node = graph.get(productId)
  if (!node || node.type !== 'KIT' || node.productComponents.length === 0) {
    const available = Math.max(0, stockByProductWarehouse.get(productId)?.get(warehouseId) ?? 0)
    memo.set(memoKey, available)
    return available
  }

  if (stack.has(memoKey)) {
    memo.set(memoKey, 0)
    return 0
  }

  stack.add(memoKey)

  let available = Number.POSITIVE_INFINITY
  for (const component of node.productComponents) {
    if (!Number.isFinite(component.qty) || component.qty <= 0) {
      available = 0
      break
    }

    const componentAvailable = component.componentType === 'KIT'
      ? getFulfillmentAvailableQty(component.componentId, warehouseId, graph, stockByProductWarehouse, memo, stack)
      : Math.max(0, stockByProductWarehouse.get(component.componentId)?.get(warehouseId) ?? 0)

    available = Math.min(available, componentAvailable / component.qty)
  }

  stack.delete(memoKey)
  const resolved = Number.isFinite(available) ? Math.max(0, available) : 0
  memo.set(memoKey, resolved)
  return resolved
}
