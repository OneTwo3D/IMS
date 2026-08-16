import { db } from '@/lib/db'
import { Prisma, type ProductType } from '@/app/generated/prisma/client'
import { toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'

type FulfillmentClient = Prisma.TransactionClient | typeof db

export type FulfillmentGraphNode = {
  id: string
  type: ProductType
  /**
   * o3d-4kfh r6: `Product.fulfillmentGraphVersion`, read in the SAME statement as this node's
   * component list. That matters: under READ COMMITTED every statement takes a fresh snapshot, so
   * reading the version in a separate query could see a version the loaded components do not belong
   * to — and the stamp would then certify a graph that was never expanded.
   *
   * r8 CORRECTION — the r6/r7 claim here was WRONG, AND IN THE UNSAFE DIRECTION. It said that
   * across the BFS batches the value was "conservative in the safe direction: a false refusal, never
   * a false acceptance", reasoning that a nested KIT edited between batch 1 and batch 2 bumps its
   * ancestors' versions too. The bump does reach the ancestors IN THE DATABASE — but the root node
   * in this map still carries the value batch 1 read, and every consumer compares the allocation
   * stamp against THIS map, never against the database. So an OLD stamp matched an OLD in-memory
   * root version, the CAS passed, and the requirements had meanwhile been expanded from the child's
   * NEW recipe. A uniform rescale then ships a fraction of the kit with all three checks green,
   * which is precisely the escape the version exists to close.
   *
   * What makes the value trustworthy is therefore not per-node atomicity but WHOLE-LOAD atomicity:
   * see {@link loadFulfillmentProductGraph}, which refuses to hand back a map whose nodes came from
   * different versions of the graph.
   */
  fulfillmentGraphVersion: number
  productComponents: Array<{
    componentId: string
    componentSku: string
    qty: Prisma.Decimal
    componentType: ProductType
    componentOversellAllowed: boolean
  }>
}

/**
 * How many times a torn load is re-walked before the caller is refused (o3d-4kfh r8).
 *
 * A tear means a component-graph edit committed WHILE we were walking, so the re-walk runs against
 * a settled graph and succeeds. Three consecutive tears would mean an editor committing between
 * every pair of our statements; at that point refusing is the honest answer.
 */
const MAX_FULFILLMENT_GRAPH_LOAD_ATTEMPTS = 3

/** Thrown when the graph could not be read as ONE consistent snapshot. Fail-closed, never silent. */
export class FulfillmentGraphSnapshotError extends Error {
  readonly movedProductIds: string[]

  constructor(movedProductIds: string[]) {
    super(
      'The component graph changed while it was being read, and could not be re-read as a single '
      + `consistent snapshot after ${MAX_FULFILLMENT_GRAPH_LOAD_ATTEMPTS} attempts (products `
      + `${movedProductIds.join(', ')}). Refusing rather than expanding a half-old, half-new recipe. `
      + 'Retry once the component edits in progress have settled.',
    )
    this.name = 'FulfillmentGraphSnapshotError'
    this.movedProductIds = movedProductIds
  }
}

/**
 * LOAD THE REACHABLE FULFILMENT GRAPH AS ONE CONSISTENT VERSION-SNAPSHOT (o3d-4kfh r8, Codex
 * finding 1).
 *
 * THE DEFECT THIS CLOSES. The walk is breadth-first: one `product.findMany` per level — batch 1 the
 * roots, batch 2 their KIT components, and so on. Under READ COMMITTED each of those is its own
 * snapshot. r7 moved the version read into the same `select` as each node's component list, which
 * made every NODE internally consistent and said nothing about the MAP. A nested KIT rescaled
 * between batch 1 and batch 2 therefore produced a map holding the root at its OLD version beside
 * the child's NEW recipe. Consumers (`findStaleFulfillmentGraphAllocation`) compare the stamp on
 * `OrderAllocation` to the ROOT node's version, so a stale stamp matched a stale in-memory root and
 * the CAS passed — while `expandFulfillmentRequirementsDecimal` walked the new child. A uniform
 * rescale (2xA+1xB -> 4xA+2xB) is proportional, so `findUncoveredCommittedShipment` passed too, and
 * the per-leaf dispatch cap sees nothing exceeding demand. Half a kit dispatched, every check green.
 *
 * WHY VERIFY-AND-REWALK, and not the two alternatives:
 *
 *   - A RECURSIVE CTE removes the batch boundaries outright and is the strongest answer, but it
 *     replaces `client.product.findMany` with `$queryRaw` on a client type that is deliberately
 *     `Prisma.TransactionClient | typeof db` and is satisfied by hand-rolled doubles across a dozen
 *     test files and four report modules, several of which arrive here through `as unknown as`
 *     casts with no `$queryRaw` at all. It would also re-express the traversal's semantics —
 *     `sortOrder`, the KIT/SIMPLE split, cycle handling, the `?? 0` defaults — in a second language.
 *     The atomicity is worth having; a second divergent implementation of the expansion is not the
 *     price to pay for it here.
 *   - CAPTURING EVERY NODE'S VERSION AND VALIDATING THE COMPLETE SET AT THE CAS is the real end
 *     state, but it needs `OrderAllocation.fulfillmentGraphVersion` to become a set rather than one
 *     `Int`. That is the full graph-version CAS filed as o3d-57b0 and explicitly out of scope.
 *
 * So: walk as before, then RE-READ the version of every node the walk visited, in ONE statement,
 * and compare it against what the walk captured. Versions only ever increment
 * (`bumpFulfillmentGraphVersions` does `{ increment: 1 }`), so there is no ABA: equal means
 * unmoved, not "moved and moved back". And the bump set is `productId` itself plus every KIT above
 * it, so an edit to ANY node in our map moves THAT node — detection never has to rely on the bump
 * propagating to an ancestor we happen to hold.
 *
 * WHICH INTERLEAVINGS ARE NOW DETECTED. Call the walk statements t1..tN and the verify read tR.
 *
 *   - an edit committing BEFORE t1: not a tear at all. Every batch reads the post-edit graph, the
 *     map is self-consistent, and an allocation stamped against the pre-edit graph fails the CAS as
 *     it always did. No re-walk, no extra cost beyond the one verify read.
 *   - an edit committing ANYWHERE IN (t1, tR] — including BETWEEN TWO BATCHES, the case r7 could
 *     not see, and including between the last batch and the verify read — moves at least one
 *     visited node's version, so the verify read reports a mismatch and the load is re-walked
 *     against the settled graph. The caller gets a map whose nodes all belong to ONE version.
 *   - an edit landing between a `findMany` and the relation sub-query Prisma may split it into:
 *     also inside (t1, tR], so also detected. This is why there is NO single-batch fast path — a
 *     nested read is not documented to be one SQL statement, and `relationLoadStrategy` is a
 *     configurable knob, so "one findMany is one snapshot" is not a property to build on.
 *   - a visited product DELETED in (t1, tR]: the verify read returns fewer rows than the map has
 *     nodes, which counts as moved, so we never expand a graph with a hole in it (a missing node is
 *     silently treated as a LEAF by `expandFulfillmentRequirementsDecimal`).
 *
 * WHAT REMAINS OPEN, STATED PLAINLY. An edit committing AFTER tR is invisible to this function and
 * to the whole calling transaction — nothing on these paths takes `COMPONENT_GRAPH_WRITE_LOCK_KEY`
 * against graph writers. This NARROWS the window to "after the graph read" instead of closing it;
 * serialising allocation and commitment against component writers is o3d-57b0 and is not done here.
 * Nor does this make the CAS a whole-graph CAS: the stamp is still the ROOT's version, so a
 * descendant edit is caught only because the bump reaches the root. What changed is that the root
 * version now certifies the recipe the caller actually expanded.
 */
export async function loadFulfillmentProductGraph(
  client: FulfillmentClient,
  rootProductIds: string[],
): Promise<Map<string, FulfillmentGraphNode>> {
  const roots = [...new Set(rootProductIds.filter(Boolean))]
  if (roots.length === 0) return new Map<string, FulfillmentGraphNode>()

  let movedProductIds: string[] = []
  for (let attempt = 1; attempt <= MAX_FULFILLMENT_GRAPH_LOAD_ATTEMPTS; attempt += 1) {
    const graph = await walkFulfillmentProductGraph(client, roots)
    if (graph.size === 0) return graph

    movedProductIds = await findMovedFulfillmentGraphVersions(client, graph)
    if (movedProductIds.length === 0) return graph
  }

  throw new FulfillmentGraphSnapshotError(movedProductIds)
}

/**
 * Re-read the version of every node the walk visited, in ONE statement, and report which have moved
 * since the walk captured them. A visited product that has disappeared counts as moved.
 */
async function findMovedFulfillmentGraphVersions(
  client: FulfillmentClient,
  graph: Map<string, FulfillmentGraphNode>,
): Promise<string[]> {
  const visitedIds = [...graph.keys()]
  const rows = await client.product.findMany({
    where: { id: { in: visitedIds } },
    select: { id: true, fulfillmentGraphVersion: true },
  })

  const currentById = new Map(rows.map((row) => [row.id, row.fulfillmentGraphVersion ?? 0]))
  const moved: string[] = []
  for (const [productId, node] of graph) {
    const current = currentById.get(productId)
    if (current === undefined || current !== node.fulfillmentGraphVersion) moved.push(productId)
  }
  return moved
}

/** One breadth-first walk of the reachable graph. Consistency is the caller's job, not this one's. */
async function walkFulfillmentProductGraph(
  client: FulfillmentClient,
  roots: string[],
): Promise<Map<string, FulfillmentGraphNode>> {
  const graph = new Map<string, FulfillmentGraphNode>()
  const queue = [...roots]

  while (queue.length > 0) {
    const batch = queue.filter((id) => !graph.has(id))
    queue.length = 0
    if (batch.length === 0) continue

    const rows = await client.product.findMany({
      where: { id: { in: batch } },
      select: {
        id: true,
        type: true,
        fulfillmentGraphVersion: true,
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
        fulfillmentGraphVersion: row.fulfillmentGraphVersion ?? 0,
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
