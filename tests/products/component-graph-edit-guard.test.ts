import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import {
  collectFulfillmentAffectedRootProducts,
  componentGraphMutationAffectsFulfillment,
  describeComponentGraphEditBlockers,
  findComponentGraphEditBlockers,
} from '@/lib/products/component-graph-edit-guard'

/**
 * o3d-4kfh r5 — the component-graph edit guard, rescoped.
 *
 * WHAT THIS FILE DOES AND DOES NOT PROVE. It proves the guard's ANSWER, and that the answer is
 * consulted before the write. It CANNOT prove serialization: the guard takes the component-graph
 * advisory lock and the allocation/commitment writers take none, so under MVCC a concurrent
 * old-graph allocation can commit alongside the edit and nothing here would see it. That limitation
 * is stated in the guard module, filed as o3d-57b0, and backstopped by
 * `validateCommittedShipmentCoverage` at every shipment transition including dispatch — see
 * tests/domain/sales/shipment-service.test.ts.
 *
 * Two r4 defects are pinned here:
 *   - finding 5: an order that has SHIPPED (or been completed/delivered/cancelled) froze its KIT and
 *     every ancestor FOREVER, because dispatch retains allocation rows and a SHIPPED shipment has no
 *     deletion path. The refusal told the operator to dispatch, which could not clear it.
 *   - finding 6: a BOM's component list was guarded even though fulfilment expansion treats a BOM as
 *     a leaf and never reads it, so manufacturing recipe maintenance was refused for a sales reason.
 */

type ComponentEdge = { productId: string; componentId: string; parentType: 'KIT' | 'BOM' | 'SIMPLE' }
type LineFixture = {
  id: string
  orderId: string
  productId: string
  sku: string
  orderNumber: string
  /** The SALES ORDER's status — the lifecycle half finding 5 is about. */
  orderStatus: string
  allocationCount: number
  /** One entry per shipment line, carrying its SHIPMENT's status. */
  shipmentLineStatuses: string[]
}

type LineWhere = {
  productId: { in: string[] }
  OR: [
    { allocations: { some: Record<string, never> }; order: { status: { in: string[] } } },
    { shipmentLines: { some: { shipment: { status: { in: string[] } } } } },
  ]
}
type LineSelect = { shipmentLines: { where: { shipment: { status: { in: string[] } } } } }

/**
 * Faithful to the predicates production actually sends, and — critically — it READS THEM rather than
 * restating them. The in-flight status sets come out of `where.OR`, so this double cannot disagree
 * with the guard about which statuses are in flight, and a test asserting "a SHIPPED order does not
 * block" is testing production's list rather than a copy of it that could drift.
 *
 *  - `productComponent.findMany({ where: { componentId: { in } } })` for the upward walk, projecting
 *    the PARENT's type (a BOM parent is a fulfilment leaf and must not be walked through);
 *  - `salesOrderLine.findMany` with `productId in` AND the two-branch OR. Branch 1 is an allocation
 *    on a still-open order; branch 2 is a picking/packed shipment line. A double that ignored either
 *    condition would report every line on every affected product, which looks identical to a working
 *    guard on a fixture where everything blocks.
 */
function client(edges: ComponentEdge[], lines: LineFixture[]) {
  return {
    productComponent: {
      findMany: async ({ where }: { where: { componentId: { in: string[] } } }) => edges
        .filter((edge) => where.componentId.in.includes(edge.componentId))
        .map((edge) => ({ productId: edge.productId, product: { type: edge.parentType } })),
    },
    salesOrderLine: {
      findMany: async ({ where, select }: { where: LineWhere; select: LineSelect }) => {
        const openOrderStatuses = where.OR[0].order.status.in
        const committedShipmentStatuses = where.OR[1].shipmentLines.some.shipment.status.in
        const selectedShipmentStatuses = select.shipmentLines.where.shipment.status.in
        return lines
          .filter((line) => where.productId.in.includes(line.productId))
          .filter((line) => (
            (line.allocationCount > 0 && openOrderStatuses.includes(line.orderStatus))
            || line.shipmentLineStatuses.some((status) => committedShipmentStatuses.includes(status))
          ))
          .map((line) => ({
            id: line.id,
            orderId: line.orderId,
            productId: line.productId,
            sku: line.sku,
            description: line.sku,
            order: { orderNumber: line.orderNumber, externalOrderNumber: null },
            allocations: line.allocationCount > 0 ? [{ id: `alloc-${line.id}` }] : [],
            shipmentLines: line.shipmentLineStatuses
              .filter((status) => selectedShipmentStatuses.includes(status))
              .slice(0, 1)
              .map((status) => ({ id: `sl-${line.id}-${status}` })),
          }))
      },
    },
  } as never
}

/** A client that fails if it is touched at all — for the paths that must not query. */
const forbiddenClient = {
  productComponent: {
    findMany: async () => { throw new Error('the guard must not read for a mutation that cannot affect fulfilment') },
  },
  salesOrderLine: {
    findMany: async () => { throw new Error('the guard must not read for a mutation that cannot affect fulfilment') },
  },
} as never

function line(overrides: Partial<LineFixture> & Pick<LineFixture, 'id' | 'productId'>): LineFixture {
  return {
    orderId: `order-${overrides.id}`,
    sku: `SKU-${overrides.id}`,
    orderNumber: `SO-${overrides.id}`,
    orderStatus: 'ALLOCATED',
    allocationCount: 0,
    shipmentLineStatuses: [],
    ...overrides,
  }
}

const KIT_RECIPE_EDIT = { kind: 'components' as const, currentType: 'KIT' as const }

// ---------------------------------------------------------------------------
// Which mutations can change a sales line's requirements at all (r5 finding 6, and finding 1).
// ---------------------------------------------------------------------------

test('o3d-4kfh r5: a component-list edit matters on a KIT and NOT on a BOM', () => {
  // `expandFulfillmentRequirementsDecimal` recurses into a component only when its type is KIT. A
  // BOM is a fulfilment leaf, so its component list is a manufacturing recipe that no sales line
  // reads. r4 refused those edits anyway — a fulfilment guard blocking manufacturing maintenance.
  assert.equal(componentGraphMutationAffectsFulfillment({ kind: 'components', currentType: 'KIT' }), true)
  assert.equal(componentGraphMutationAffectsFulfillment({ kind: 'components', currentType: 'BOM' }), false)
})

test('o3d-4kfh r5: a type change matters exactly when KIT-NESS flips', () => {
  // KIT <-> BOM is the case r4 missed COMPLETELY: both types bear components, so `clearComponents`
  // was false and no guard ran at all, while the change flips whether fulfilment expands them.
  const affects = (currentType: 'KIT' | 'BOM' | 'SIMPLE', nextType: 'KIT' | 'BOM' | 'SIMPLE') =>
    componentGraphMutationAffectsFulfillment({ kind: 'kitness', currentType, nextType })

  assert.equal(affects('KIT', 'BOM'), true, 'recursively-expanded components become a leaf')
  assert.equal(affects('BOM', 'KIT'), true, 'and the reverse')
  assert.equal(affects('KIT', 'SIMPLE'), true)
  assert.equal(affects('SIMPLE', 'KIT'), true)
  assert.equal(affects('BOM', 'SIMPLE'), false, 'leaf before, leaf after — nothing expanded either way')
  assert.equal(affects('SIMPLE', 'BOM'), false)
  assert.equal(
    affects('KIT', 'KIT'),
    false,
    'renaming or repricing a kit is not a KIT-ness change and must not be refused',
  )
})

test('o3d-4kfh r5: a BOM recipe edit is answered WITHOUT touching the database', async () => {
  assert.deepEqual(
    await findComponentGraphEditBlockers(forbiddenClient, 'a-bom', { kind: 'components', currentType: 'BOM' }),
    [],
  )
})

test('o3d-4kfh r5: a BOM -> SIMPLE conversion is answered without touching the database', async () => {
  assert.deepEqual(
    await findComponentGraphEditBlockers(forbiddenClient, 'a-bom', {
      kind: 'kitness', currentType: 'BOM', nextType: 'SIMPLE',
    }),
    [],
  )
})

// ---------------------------------------------------------------------------
// The affected set.
// ---------------------------------------------------------------------------

test('o3d-4kfh: the affected set is the product itself plus its KIT ancestors, transitively', async () => {
  const edges: ComponentEdge[] = [
    { productId: 'inner-kit', componentId: 'comp', parentType: 'KIT' },
    { productId: 'outer-kit', componentId: 'inner-kit', parentType: 'KIT' },
  ]

  const affected = await collectFulfillmentAffectedRootProducts(client(edges, []), 'comp')

  assert.deepEqual([...affected].sort(), ['comp', 'inner-kit', 'outer-kit'])
})

test('o3d-4kfh: a BOM parent is NOT walked through — a BOM is a fulfilment leaf', async () => {
  const edges: ComponentEdge[] = [
    { productId: 'a-bom', componentId: 'comp', parentType: 'BOM' },
    { productId: 'a-kit-above-the-bom', componentId: 'a-bom', parentType: 'KIT' },
  ]

  const affected = await collectFulfillmentAffectedRootProducts(client(edges, []), 'comp')

  assert.deepEqual([...affected].sort(), ['comp'], 'the BOM stops the walk, and so does everything above it')
})

test('o3d-4kfh: a pre-existing component cycle does not hang the walk', async () => {
  const edges: ComponentEdge[] = [
    { productId: 'kit-a', componentId: 'kit-b', parentType: 'KIT' },
    { productId: 'kit-b', componentId: 'kit-a', parentType: 'KIT' },
  ]

  const affected = await collectFulfillmentAffectedRootProducts(client(edges, []), 'kit-a')

  assert.deepEqual([...affected].sort(), ['kit-a', 'kit-b'])
})

// ---------------------------------------------------------------------------
// What blocks — IN-FLIGHT work only (r5 finding 5).
// ---------------------------------------------------------------------------

test('o3d-4kfh: an ALLOCATED order line on a KIT ancestor blocks the edit', async () => {
  const edges: ComponentEdge[] = [{ productId: 'kit-1', componentId: 'comp', parentType: 'KIT' }]
  const lines = [line({ id: 'l1', productId: 'kit-1', orderStatus: 'ALLOCATED', allocationCount: 1 })]

  const blockers = await findComponentGraphEditBlockers(client(edges, lines), 'comp', KIT_RECIPE_EDIT)

  assert.deepEqual(blockers.map((blocker) => [blocker.orderRef, blocker.reason]), [['SO-l1', 'allocation']])
  assert.match(describeComponentGraphEditBlockers(blockers), /SO-l1/)
})

test('o3d-4kfh: a PICKING shipment line blocks it, and is reported as the committed reason', async () => {
  const edges: ComponentEdge[] = [{ productId: 'kit-1', componentId: 'comp', parentType: 'KIT' }]
  const lines = [line({
    id: 'l1', productId: 'kit-1', orderStatus: 'PICKING', allocationCount: 1, shipmentLineStatuses: ['PICKING'],
  })]

  const blockers = await findComponentGraphEditBlockers(client(edges, lines), 'comp', KIT_RECIPE_EDIT)

  assert.deepEqual(blockers.map((blocker) => blocker.reason), ['committed_shipment'])
  assert.match(describeComponentGraphEditBlockers(blockers), /picking\/packed/)
})

test('o3d-4kfh: a PACKED shipment line blocks it too', async () => {
  const edges: ComponentEdge[] = [{ productId: 'kit-1', componentId: 'comp', parentType: 'KIT' }]
  const lines = [line({ id: 'l1', productId: 'kit-1', orderStatus: 'PACKING', shipmentLineStatuses: ['PACKED'] })]

  const blockers = await findComponentGraphEditBlockers(client(edges, lines), 'comp', KIT_RECIPE_EDIT)

  assert.deepEqual(blockers.map((blocker) => blocker.reason), ['committed_shipment'])
})

test('o3d-4kfh r5: a SHIPPED order does NOT block — dispatch RETAINS its allocation rows', async () => {
  // The r4 permanent-freeze bug, in one fixture. Dispatch deliberately keeps the OrderAllocation row
  // (it is what the accounting sub-ledger and the reservation residual resolve through) and a
  // SHIPPED shipment has no deletion path anywhere in IMS. Counting either as a blocker meant the
  // first order to ship froze that KIT and its whole ancestor chain permanently — and the refusal
  // told the operator to dispatch, which is what had just happened.
  const edges: ComponentEdge[] = [{ productId: 'kit-1', componentId: 'comp', parentType: 'KIT' }]
  const lines = [line({
    id: 'l1', productId: 'kit-1', orderStatus: 'SHIPPED', allocationCount: 1, shipmentLineStatuses: ['SHIPPED'],
  })]

  assert.deepEqual(await findComponentGraphEditBlockers(client(edges, lines), 'comp', KIT_RECIPE_EDIT), [])
})

test('o3d-4kfh r5: COMPLETED, DELIVERED and CANCELLED orders do not block either', async () => {
  // None of them has a transition back into a picking state (`SALES_ORDER_TRANSITIONS`), so their
  // retained rows are history. Reading that history against the CURRENT graph is a real residual and
  // is filed as o3d-kouj — it is NOT solved by freezing the catalogue, which is what r4 did.
  const edges: ComponentEdge[] = [{ productId: 'kit-1', componentId: 'comp', parentType: 'KIT' }]
  for (const orderStatus of ['COMPLETED', 'DELIVERED', 'CANCELLED']) {
    const lines = [line({ id: 'l1', productId: 'kit-1', orderStatus, allocationCount: 1 })]
    assert.deepEqual(
      await findComponentGraphEditBlockers(client(edges, lines), 'comp', KIT_RECIPE_EDIT),
      [],
      `${orderStatus} must not freeze the catalogue`,
    )
  }
})

test('o3d-4kfh r5: a PICKING shipment on a CANCELLED order STILL blocks', async () => {
  // The shipment branch carries no order-status filter on purpose: units physically picked are in
  // flight whatever the order says. It has an exit — cancelSalesOrderFulfillmentState deletes
  // PENDING/PICKING/PACKED shipments, and dispatch does not require an open order — so this is not a
  // permanent freeze.
  const edges: ComponentEdge[] = [{ productId: 'kit-1', componentId: 'comp', parentType: 'KIT' }]
  const lines = [line({
    id: 'l1', productId: 'kit-1', orderStatus: 'CANCELLED', allocationCount: 1, shipmentLineStatuses: ['PICKING'],
  })]

  const blockers = await findComponentGraphEditBlockers(client(edges, lines), 'comp', KIT_RECIPE_EDIT)

  assert.deepEqual(blockers.map((blocker) => blocker.reason), ['committed_shipment'])
})

test('o3d-4kfh: an order line with only a PENDING draft does NOT block', async () => {
  // A draft commits nothing, and every allocation mutation path reconciles drafts against their
  // backing rows (`reconcilePendingShipments`).
  const edges: ComponentEdge[] = [{ productId: 'kit-1', componentId: 'comp', parentType: 'KIT' }]
  const lines = [line({ id: 'l1', productId: 'kit-1', orderStatus: 'ALLOCATED', shipmentLineStatuses: ['PENDING'] })]

  assert.deepEqual(await findComponentGraphEditBlockers(client(edges, lines), 'comp', KIT_RECIPE_EDIT), [])
})

test('o3d-4kfh: an order on an UNRELATED product does not block', async () => {
  const edges: ComponentEdge[] = [{ productId: 'kit-1', componentId: 'comp', parentType: 'KIT' }]
  const lines = [line({ id: 'l1', productId: 'other-kit', allocationCount: 1 })]

  assert.deepEqual(await findComponentGraphEditBlockers(client(edges, lines), 'comp', KIT_RECIPE_EDIT), [])
})

test('o3d-4kfh r5: a BOM -> KIT conversion IS guarded, on the product itself and its KIT ancestors', async () => {
  // Finding 1's shape. Nothing about the component rows changes; what changes is whether every KIT
  // above this product recurses into them. `validateProductStructureChange` cannot see it — it
  // counts open sales order lines on THIS product, and a nested inner kit has none.
  const edges: ComponentEdge[] = [{ productId: 'outer-kit', componentId: 'inner', parentType: 'KIT' }]
  const lines = [line({ id: 'l1', productId: 'outer-kit', orderStatus: 'PICKING', allocationCount: 1 })]

  const blockers = await findComponentGraphEditBlockers(client(edges, lines), 'inner', {
    kind: 'kitness', currentType: 'BOM', nextType: 'KIT',
  })

  assert.deepEqual(blockers.map((blocker) => blocker.orderRef), ['SO-l1'])
})

// ---------------------------------------------------------------------------
// The operator message must name actions that ACTUALLY clear the blocker (r5 finding 5).
// ---------------------------------------------------------------------------

test('o3d-4kfh r5: the refusal names real exits and says terminal orders do not block', async () => {
  const edges: ComponentEdge[] = [{ productId: 'kit-1', componentId: 'comp', parentType: 'KIT' }]
  const lines = [line({
    id: 'l1', productId: 'kit-1', orderStatus: 'PICKING', allocationCount: 1, shipmentLineStatuses: ['PICKING'],
  })]

  const message = describeComponentGraphEditBlockers(
    await findComponentGraphEditBlockers(client(edges, lines), 'comp', KIT_RECIPE_EDIT),
  )

  assert.match(message, /deallocate, dispatch or cancel those orders/i)
  assert.match(message, /dispatching it or cancelling its order/i)
  assert.match(
    message,
    /already shipped, completed, delivered or cancelled do NOT block/i,
    'the operator must be told the blocker CAN be cleared, which was untrue in r4',
  )
})

// --- Where the guard sits ---
//
// The behavioural half above proves the guard's answer. This half pins that the answer is consulted
// at all, inside the transaction and — for the type-change paths — BEFORE the type is written. It
// proves ORDERING ONLY. It cannot and does not prove serialization against a concurrent allocation.

const PRODUCTS_ACTIONS = path.join(process.cwd(), 'app/actions/products.ts')
const IMPORT_ACTIONS = path.join(process.cwd(), 'app/actions/import.ts')

async function bodyFrom(file: string, anchor: string, length: number): Promise<string> {
  const source = await readFile(file, 'utf8')
  const at = source.indexOf(anchor)
  assert.notEqual(at, -1, `${path.basename(file)} must still contain ${anchor}`)
  return source.slice(at, at + length)
}

test('o3d-4kfh: saveProductComponents consults the guard inside the transaction, before the write', async () => {
  const body = await bodyFrom(PRODUCTS_ACTIONS, 'const conflict = await db.$transaction', 4600)

  const lockAt = body.indexOf('COMPONENT_GRAPH_WRITE_LOCK_KEY')
  const guardAt = body.indexOf('findComponentGraphEditBlockers(tx')
  const deleteAt = body.indexOf('tx.productComponent.deleteMany')
  assert.notEqual(guardAt, -1, 'the in-flight sales guard must be called against tx')
  assert.ok(lockAt !== -1 && deleteAt !== -1, 'lock and delete must both still be present')
  assert.ok(lockAt < guardAt, 'the guard runs under the graph lock, not before it')
  assert.ok(guardAt < deleteAt, 'and before the components are destroyed')
  assert.match(
    body.slice(guardAt - 400, guardAt),
    /kind: 'components' as const, currentType: current\.type/,
    'and it declares a COMPONENT-LIST mutation with the type read UNDER the lock, so a BOM is a no-op',
  )
})

test('o3d-4kfh r5 (finding 1): updateProduct guards KIT-ness BEFORE it writes the new type', async () => {
  // r4 guarded only `clearComponents`, and ran AFTER `tx.product.update`. KIT <-> BOM satisfied
  // neither: no check ran at all, and any later refusal would have come after the invalid state had
  // already been committed to.
  const body = await bodyFrom(PRODUCTS_ACTIONS, 'let updatedCategoryChange', 6000)

  const affectsAt = body.indexOf('componentGraphMutationAffectsFulfillment(kitnessMutation)')
  const guardAt = body.indexOf('findComponentGraphEditBlockers(tx, id, kitnessMutation)')
  const updateAt = body.indexOf('await tx.product.update(')
  assert.notEqual(affectsAt, -1, 'the KIT-ness predicate must gate the guard')
  assert.notEqual(guardAt, -1, 'the guard must run on a KIT-ness change')
  assert.notEqual(updateAt, -1)
  assert.ok(guardAt < updateAt, 'the refusal must come BEFORE the type is written, not after')
  assert.match(
    body.slice(affectsAt - 300, affectsAt),
    /kind: 'kitness' as const/,
    'declared as a kitness mutation, so a plain KIT rename is not refused',
  )
})

test('o3d-4kfh r5 (finding 1): the CSV row update guards KIT-ness before its product.update too', async () => {
  const source = await readFile(IMPORT_ACTIONS, 'utf8')
  const at = source.indexOf('const outcome: RenameOutcome = await db.$transaction')
  assert.notEqual(at, -1)
  const body = source.slice(at, at + 5200)

  const guardAt = body.indexOf('findComponentGraphEditBlockers(tx, existingProduct.id, kitnessMutation)')
  const updateAt = body.indexOf('await tx.product.update(')
  assert.notEqual(guardAt, -1, 'the CSV type change must consult the guard')
  assert.ok(guardAt < updateAt, 'before the type is written')
  assert.match(body.slice(0, guardAt), /kind: 'kitness' as const/)
})

test('o3d-4kfh: the CSV component pass is guarded, as a component-list mutation', async () => {
  const csvBody = await bodyFrom(IMPORT_ACTIONS, 'await lockProductSkusForWrite(tx, [cr.sku])', 3000)
  const csvGuardAt = csvBody.indexOf('findComponentGraphEditBlockers(tx')
  const csvDeleteAt = csvBody.indexOf('tx.productComponent.deleteMany')
  assert.notEqual(csvGuardAt, -1, 'the CSV component write must consult the guard')
  assert.ok(csvGuardAt < csvDeleteAt, 'before it deletes the existing components')
  assert.match(
    csvBody.slice(csvGuardAt, csvGuardAt + 300),
    /kind: 'components',\s*\n\s*currentType: current\.type,/,
    'with the type read under the lock',
  )
})

test('o3d-4kfh r5 (finding 2): nothing claims the guard is atomic', async () => {
  // r4's comments asserted that holding the component-graph advisory lock made the check atomic
  // against a concurrent allocation. It does not: `allocateSalesOrder`, `confirmSalesOrderShipments`
  // and PENDING -> PICKING take no component-graph lock at all. Saying so was worse than saying
  // nothing, because it told the next reader the hole was closed.
  const guardSource = await readFile(
    path.join(process.cwd(), 'lib/products/component-graph-edit-guard.ts'),
    'utf8',
  )
  const productsSource = await readFile(PRODUCTS_ACTIONS, 'utf8')

  assert.doesNotMatch(
    productsSource,
    /so an allocation cannot commit between the check and the edit/,
    'the atomicity claim must be gone from the editor',
  )
  assert.match(guardSource, /NOT ATOMIC|NOT A SERIALIZATION BOUNDARY/, 'the module must say so plainly')
  assert.match(guardSource, /o3d-57b0/, 'and point at the filed graph-version CAS')
  assert.match(guardSource, /o3d-kouj/, 'and at the completed-history residual it does not solve')
})
