import assert from 'node:assert/strict'
import test from 'node:test'
import { Prisma } from '@/app/generated/prisma/client'
import {
  FulfillmentGraphExpansionError,
  expandFulfillmentRequirementsDecimal,
  type FulfillmentGraphNode,
} from '@/lib/products/kit-fulfillment'

/**
 * o3d-0fok (Codex r1 finding 4) — THE DEPTH CAP DOES NOT BOUND A DIAMOND.
 *
 * `MAX_FULFILLMENT_GRAPH_DEPTH` bounds the LOAD: one `product.findMany` per level, and the loaded
 * map holds one entry per distinct product. The EXPANSION is a different walk with a different cost
 * model — `visit` recurses once per PATH to a kit, not once per kit — so a graph where many parents
 * share the same sub-kit multiplies instead of merging. Eight levels of a kit with four sub-kits is
 * NINE products and eighty-seven thousand visits, and it runs inside the sales order lock every
 * other order is queued behind. The depth cap makes the exponent small and finite; finite is not
 * bounded.
 */

/** `levels` nested KITs, each holding `width` components that are all the SAME next-level product. */
function diamondGraph(levels: number, width: number): Map<string, FulfillmentGraphNode> {
  const graph = new Map<string, FulfillmentGraphNode>()
  for (let level = 0; level < levels; level += 1) {
    const childId = `kit-${level + 1}`
    const childIsLeaf = level + 1 === levels
    graph.set(`kit-${level}`, {
      id: `kit-${level}`,
      type: 'KIT',
      fulfillmentGraphVersion: 0,
      // Every component is the same child, reached by `width` distinct routes. That is the diamond:
      // the map has one node per level, the walk has `width ^ level` paths to it.
      productComponents: Array.from({ length: width }, () => ({
        componentId: childId,
        componentSku: childId.toUpperCase(),
        qty: new Prisma.Decimal(1),
        componentType: (childIsLeaf ? 'SIMPLE' : 'KIT') as FulfillmentGraphNode['type'],
        componentOversellAllowed: false,
      })),
    })
  }
  graph.set(`kit-${levels}`, {
    id: `kit-${levels}`,
    type: 'SIMPLE',
    fulfillmentGraphVersion: 0,
    productComponents: [],
  })
  return graph
}

test('o3d-0fok: a diamond within the depth cap is REFUSED rather than run under the order lock', () => {
  // Eight levels of width four: nine products, 4^8 = 65,536 distinct paths to the leaf and 87,381
  // units of walk. Well inside MAX_FULFILLMENT_GRAPH_DEPTH, well past what may be done while
  // holding the lock.
  const graph = diamondGraph(8, 4)
  assert.equal(graph.size, 9, 'nine products — the LOAD is trivial, which is exactly why the load cap misses this')

  assert.throws(
    () => expandFulfillmentRequirementsDecimal('kit-0', 1, graph),
    (error: unknown) => {
      assert.ok(error instanceof FulfillmentGraphExpansionError)
      assert.equal(error.productId, 'kit-0', 'the root being expanded is named, because that is what an operator holds')
      assert.match(error.message, /50000 component paths/)
      assert.match(error.message, /Flatten the repeated sub-kits/, 'a refusal has to carry a remedy')
      return true
    },
  )
})

test('o3d-0fok: an ordinary diamond is unaffected and still expands to the exact quantity', () => {
  // Four levels of width four is 4^4 = 256 of the leaf per kit, at 341 units of walk. The bound
  // must not cost a real recipe anything, and the ARITHMETIC must be untouched: the requirement is
  // the sum over paths, not a memoised per-unit factor scaled back up.
  const requirements = expandFulfillmentRequirementsDecimal('kit-0', 3, diamondGraph(4, 4))

  assert.equal(requirements.size, 1)
  assert.equal(requirements.get('kit-4')?.toFixed(0), '768', '3 kits x 4^4 paths x qty 1')
})

test('o3d-0fok: the budget counts the WIDTH of a shallow node too, not only recursion depth', () => {
  // A single KIT with 60,000 SIMPLE components is one visit and sixty thousand leaf accumulations.
  // Counting only `visit` would leave that unbounded, which is the same defect one shape over.
  const wide: Map<string, FulfillmentGraphNode> = new Map([['kit-wide', {
    id: 'kit-wide',
    type: 'KIT' as const,
    fulfillmentGraphVersion: 0,
    productComponents: Array.from({ length: 60_000 }, (_unused, index) => ({
      componentId: `leaf-${index}`,
      componentSku: `LEAF-${index}`,
      qty: new Prisma.Decimal(1),
      componentType: 'SIMPLE' as const,
      componentOversellAllowed: false,
    })),
  }]])

  assert.throws(
    () => expandFulfillmentRequirementsDecimal('kit-wide', 1, wide),
    FulfillmentGraphExpansionError,
  )
})
