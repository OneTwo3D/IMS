import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import {
  collectFulfillmentAffectedRootProducts,
  describeComponentGraphEditBlockers,
  findComponentGraphEditBlockers,
} from '@/lib/products/component-graph-edit-guard'

/**
 * o3d-4kfh r4 (Codex finding 1) — a component-graph edit must not retroactively rewrite what an
 * in-flight sales order requires.
 *
 * IMS expands the CURRENT `ProductComponent` graph everywhere: allocation, the draft builder, the
 * per-leaf dispatch cap, the reservation census, the fulfilment analytics. Re-composing a KIT that
 * an order has already allocated or picked therefore changes that order's requirements after the
 * fact, and no downstream check can see it — the flat committed-coverage backstop compares per
 * (line, warehouse, product), the dispatch cap only rejects leaves that EXCEED demand, and
 * whole-kit coverage credits the half-kit that ships as half a kit.
 */

type ComponentEdge = { productId: string; componentId: string; parentType: 'KIT' | 'BOM' | 'SIMPLE' }
type LineFixture = {
  id: string
  orderId: string
  productId: string
  sku: string
  orderNumber: string
  allocationCount: number
  committedShipmentLineCount: number
  pendingShipmentLineCount: number
}

/**
 * Faithful to the two predicates production actually sends, and no more permissive:
 *
 *  - `productComponent.findMany({ where: { componentId: { in: [...] } } })` for the upward walk,
 *    projecting the PARENT's type (a BOM parent is a fulfilment leaf and must not be walked
 *    through — a double that ignored `product.type` would make the BOM test below vacuous);
 *  - `salesOrderLine.findMany` with the `productId in` + `OR[allocations.some, shipmentLines.some
 *    (non-PENDING)]` filter. A double that ignored the OR would report every line on every affected
 *    product, which is the opposite failure: a guard that blocks everything looks identical to a
 *    guard that works, on a fixture where everything is blocked.
 */
function client(edges: ComponentEdge[], lines: LineFixture[]) {
  return {
    productComponent: {
      findMany: async ({ where }: { where: { componentId: { in: string[] } } }) => edges
        .filter((edge) => where.componentId.in.includes(edge.componentId))
        .map((edge) => ({ productId: edge.productId, product: { type: edge.parentType } })),
    },
    salesOrderLine: {
      findMany: async ({ where }: { where: { productId: { in: string[] } } }) => lines
        .filter((line) => where.productId.in.includes(line.productId))
        .filter((line) => line.allocationCount > 0 || line.committedShipmentLineCount > 0)
        .map((line) => ({
          id: line.id,
          orderId: line.orderId,
          productId: line.productId,
          sku: line.sku,
          description: line.sku,
          order: { orderNumber: line.orderNumber, externalOrderNumber: null },
          allocations: line.allocationCount > 0 ? [{ id: `alloc-${line.id}` }] : [],
          // Production passes `where: { shipment: { status: { not: 'PENDING' } } }` on this
          // relation, so a PENDING draft must NOT show up here.
          shipmentLines: line.committedShipmentLineCount > 0 ? [{ id: `sl-${line.id}` }] : [],
        })),
    },
  } as never
}

function line(overrides: Partial<LineFixture> & Pick<LineFixture, 'id' | 'productId'>): LineFixture {
  return {
    orderId: `order-${overrides.id}`,
    sku: `SKU-${overrides.id}`,
    orderNumber: `SO-${overrides.id}`,
    allocationCount: 0,
    committedShipmentLineCount: 0,
    pendingShipmentLineCount: 0,
    ...overrides,
  }
}

test('o3d-4kfh r4: the affected set is the product itself plus its KIT ancestors, transitively', async () => {
  // Editing `comp` changes what a line for `outer-kit` requires, because expansion recurses through
  // KIT-typed components all the way down.
  const edges: ComponentEdge[] = [
    { productId: 'inner-kit', componentId: 'comp', parentType: 'KIT' },
    { productId: 'outer-kit', componentId: 'inner-kit', parentType: 'KIT' },
  ]

  const affected = await collectFulfillmentAffectedRootProducts(client(edges, []), 'comp')

  assert.deepEqual([...affected].sort(), ['comp', 'inner-kit', 'outer-kit'])
})

test('o3d-4kfh r4: a BOM parent is NOT walked through — a BOM is a fulfilment leaf', async () => {
  // `expandFulfillmentRequirementsDecimal` recurses only into KIT-typed components; a BOM product
  // is a leaf, so nothing below it can alter what a sales line for it requires. Walking through it
  // would block edits that are provably harmless.
  const edges: ComponentEdge[] = [
    { productId: 'a-bom', componentId: 'comp', parentType: 'BOM' },
    { productId: 'a-kit-above-the-bom', componentId: 'a-bom', parentType: 'KIT' },
  ]

  const affected = await collectFulfillmentAffectedRootProducts(client(edges, []), 'comp')

  assert.deepEqual([...affected].sort(), ['comp'], 'the BOM stops the walk, and so does everything above it')
})

test('o3d-4kfh r4: a pre-existing component cycle does not hang the walk', async () => {
  // detectComponentCycle stops new cycles being created; this must not spin on one that already
  // exists in the data.
  const edges: ComponentEdge[] = [
    { productId: 'kit-a', componentId: 'kit-b', parentType: 'KIT' },
    { productId: 'kit-b', componentId: 'kit-a', parentType: 'KIT' },
  ]

  const affected = await collectFulfillmentAffectedRootProducts(client(edges, []), 'kit-a')

  assert.deepEqual([...affected].sort(), ['kit-a', 'kit-b'])
})

test('o3d-4kfh r4: an ALLOCATED order line on a KIT ancestor blocks the edit', async () => {
  const edges: ComponentEdge[] = [{ productId: 'kit-1', componentId: 'comp', parentType: 'KIT' }]
  const lines = [line({ id: 'l1', productId: 'kit-1', allocationCount: 1 })]

  const blockers = await findComponentGraphEditBlockers(client(edges, lines), 'comp')

  assert.deepEqual(blockers.map((blocker) => [blocker.orderRef, blocker.reason]), [['SO-l1', 'allocation']])
  assert.match(describeComponentGraphEditBlockers(blockers), /SO-l1/)
})

test('o3d-4kfh r4: a PICKED order line blocks it, and is reported as the committed reason', async () => {
  // The severe case: the units are physically being handled against the old recipe.
  const edges: ComponentEdge[] = [{ productId: 'kit-1', componentId: 'comp', parentType: 'KIT' }]
  const lines = [line({ id: 'l1', productId: 'kit-1', allocationCount: 1, committedShipmentLineCount: 1 })]

  const blockers = await findComponentGraphEditBlockers(client(edges, lines), 'comp')

  assert.deepEqual(blockers.map((blocker) => blocker.reason), ['committed_shipment'])
  assert.match(describeComponentGraphEditBlockers(blockers), /picked\/packed\/shipped/)
})

test('o3d-4kfh r4: an order line with only a PENDING draft does NOT block', async () => {
  // A draft commits nothing, and the four allocation mutation paths already reconcile drafts
  // against their backing rows. Blocking on one would fire the guard on orders that can still be
  // rebuilt cleanly.
  const edges: ComponentEdge[] = [{ productId: 'kit-1', componentId: 'comp', parentType: 'KIT' }]
  const lines = [line({ id: 'l1', productId: 'kit-1', pendingShipmentLineCount: 1 })]

  assert.deepEqual(await findComponentGraphEditBlockers(client(edges, lines), 'comp'), [])
})

test('o3d-4kfh r4: an order on an UNRELATED product does not block', async () => {
  const edges: ComponentEdge[] = [{ productId: 'kit-1', componentId: 'comp', parentType: 'KIT' }]
  const lines = [line({ id: 'l1', productId: 'other-kit', allocationCount: 1 })]

  assert.deepEqual(await findComponentGraphEditBlockers(client(edges, lines), 'comp'), [])
})

// --- Where the guard sits ---
//
// The behavioural half above proves the guard's answer. This half pins that the answer is actually
// consulted, INSIDE the transaction and BEFORE the write — a guard evaluated after the delete, or
// outside the lock, is check-then-act and proves nothing about the graph being committed into.

const PRODUCTS_ACTIONS = path.join(process.cwd(), 'app/actions/products.ts')
const IMPORT_ACTIONS = path.join(process.cwd(), 'app/actions/import.ts')

async function bodyFrom(file: string, anchor: string, length: number): Promise<string> {
  const source = await readFile(file, 'utf8')
  const at = source.indexOf(anchor)
  assert.notEqual(at, -1, `${path.basename(file)} must still contain ${anchor}`)
  return source.slice(at, at + length)
}

test('o3d-4kfh r4: saveProductComponents consults the guard inside the transaction, before the write', async () => {
  const body = await bodyFrom(PRODUCTS_ACTIONS, 'const conflict = await db.$transaction', 3600)

  const lockAt = body.indexOf('COMPONENT_GRAPH_WRITE_LOCK_KEY')
  const guardAt = body.indexOf('findComponentGraphEditBlockers(tx')
  const deleteAt = body.indexOf('tx.productComponent.deleteMany')
  assert.notEqual(guardAt, -1, 'the in-flight sales guard must be called against tx')
  assert.ok(lockAt !== -1 && deleteAt !== -1, 'lock and delete must both still be present')
  assert.ok(lockAt < guardAt, 'the guard runs under the graph lock, not before it')
  assert.ok(guardAt < deleteAt, 'and before the components are destroyed')
})

test('o3d-4kfh r4: the CSV component pass and the KIT-conversion paths are guarded too', async () => {
  // The editor is not the only writer. A bulk import is not a licence to retroactively rewrite what
  // an already-picked order requires — the corruption is identical however the graph was edited.
  const csvBody = await bodyFrom(IMPORT_ACTIONS, 'await lockProductSkusForWrite(tx, [cr.sku])', 2600)
  const csvGuardAt = csvBody.indexOf('findComponentGraphEditBlockers(tx')
  const csvDeleteAt = csvBody.indexOf('tx.productComponent.deleteMany')
  assert.notEqual(csvGuardAt, -1, 'the CSV component write must consult the guard')
  assert.ok(csvGuardAt < csvDeleteAt, 'before it deletes the existing components')

  const importSource = await readFile(IMPORT_ACTIONS, 'utf8')
  const clearAt = importSource.indexOf('if (revalidated.clearComponents)')
  assert.notEqual(clearAt, -1)
  const clearBody = importSource.slice(clearAt, clearAt + 900)
  assert.match(clearBody, /findComponentGraphEditBlockers\(tx/, 'the CSV KIT-conversion clear must be guarded')

  const productsSource = await readFile(PRODUCTS_ACTIONS, 'utf8')
  const productsClearAt = productsSource.indexOf('if (revalidated.clearComponents)')
  assert.notEqual(productsClearAt, -1)
  const productsClearBody = productsSource.slice(productsClearAt, productsClearAt + 1200)
  assert.match(productsClearBody, /findComponentGraphEditBlockers\(tx/, 'the editor KIT-conversion clear must be guarded')
})
