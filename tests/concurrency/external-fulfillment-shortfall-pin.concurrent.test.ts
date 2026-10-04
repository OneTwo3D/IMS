import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * o3d-4gw0 — the external-fulfilment SHORTFALL judges demand against the PINNED recipe, proved against
 * a real Postgres.
 *
 * `findExternalFulfillmentShortfall` decides whether an external (storefront / 3PL) "shipped" update is
 * refused as short. It used to expand the CURRENT component graph for the sales line AND for every
 * refund line, while allocation, picking and the dispatch cap (`shipment-service.ts`) all read the
 * recipe pinned on `SalesOrderLine.fulfillmentRequirements` (o3d-kouj). A kit re-composed after the
 * order was pinned therefore made the three readers disagree about the same order:
 *
 *   - recipe GROWS after the pin  -> demand is overstated -> a fully-covered order is REFUSED
 *   - recipe SHRINKS after the pin -> demand is understated -> a genuinely short order is ACCEPTED,
 *     and the goods have already left, so the stock/COGS under-booking is permanent
 *
 * Every arm writes a real pin with the production capture function, THEN re-composes the kit, and
 * asserts (and prints) that the pin and the current graph really disagree before judging the result —
 * an arm whose recipe edit changed nothing would pass vacuously. The shortfall function takes no
 * locks and opens no transaction (three pooled reads, then a graph load); nothing here holds a lock.
 *
 * Gated behind RUN_DB_CONCURRENCY_TESTS=1: `npm run test:concurrency`.
 */

const SKIP = process.env.RUN_DB_CONCURRENCY_TESTS !== '1'

type Fixture = {
  orderId: string
  lineId: string
  warehouseId: string
  kitId: string
  aId: string
  bId: string
  suffix: string
}

async function loadDeps() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const [{ db }, kit, snapshot, shortfall, math] = await Promise.all([
    import('@/lib/db'),
    import('@/lib/products/kit-fulfillment'),
    import('@/lib/products/fulfillment-requirement-snapshot'),
    import('@/lib/fulfillment/external-fulfillment'),
    import('@/lib/domain/math/decimal'),
  ])
  return {
    db,
    loadFulfillmentProductGraph: kit.loadFulfillmentProductGraph,
    expandFulfillmentRequirementsDecimal: kit.expandFulfillmentRequirementsDecimal,
    captureFulfillmentRequirementSnapshot: snapshot.captureFulfillmentRequirementSnapshot,
    findExternalFulfillmentShortfall: shortfall.findExternalFulfillmentShortfall,
    toDecimal: math.toDecimal,
  }
}
type Deps = Awaited<ReturnType<typeof loadDeps>>

/** Kit K = aQty x A + bQty x B; one order line of `lineQty` K. Nothing pinned yet. */
async function createFixture(
  deps: Deps,
  recipe: { a: number; b: number },
  lineQty: number,
): Promise<Fixture> {
  const { db } = deps
  const suffix = randomUUID()
  const tag = `O4GW0-${suffix.slice(0, 8)}`
  const warehouse = await db.warehouse.create({
    data: { code: tag, name: `o3d-4gw0 ${suffix}`, active: true, availableForSale: true, syncToStore: false, isDefault: false },
    select: { id: true },
  })
  const mk = (sku: string, type: 'SIMPLE' | 'KIT') =>
    db.product.create({ data: { sku: `${tag}-${sku}`, name: `o3d-4gw0 ${sku} ${suffix}`, type }, select: { id: true } })
  const [a, b, kit] = await Promise.all([mk('A', 'SIMPLE'), mk('B', 'SIMPLE'), mk('K', 'KIT')])
  await db.productComponent.createMany({
    data: [
      { productId: kit.id, componentId: a.id, qty: recipe.a },
      { productId: kit.id, componentId: b.id, qty: recipe.b },
    ],
  })
  const order = await db.salesOrder.create({
    data: {
      orderNumber: tag,
      status: 'ALLOCATED',
      currency: 'GBP',
      subtotalForeign: 10, totalForeign: 10, subtotalBase: 10, totalBase: 10,
      shipFromWarehouseId: warehouse.id,
      lines: {
        create: [{
          productId: kit.id, description: 'o3d-4gw0 kit line', sku: `${tag}-K`, qty: lineQty,
          unitPriceForeign: 10, unitPriceBase: 10, totalForeign: 10, totalBase: 10,
        }],
      },
    },
    select: { id: true, lines: { select: { id: true } } },
  })
  return { orderId: order.id, lineId: order.lines[0].id, warehouseId: warehouse.id, kitId: kit.id, aId: a.id, bId: b.id, suffix }
}

async function destroyFixture(deps: Deps, f: Fixture) {
  const { db } = deps
  const errors: Error[] = []
  const run = async (label: string, op: () => Promise<unknown>) => {
    try { await op() } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)))
      console.warn(`o3d-4gw0 cleanup failed for ${label}: ${String(error)}`)
    }
  }
  await run('refund lines', () => db.salesOrderRefundLine.deleteMany({ where: { refund: { orderId: f.orderId } } }))
  await run('refunds', () => db.salesOrderRefund.deleteMany({ where: { orderId: f.orderId } }))
  await run('shipments', () => db.shipment.deleteMany({ where: { orderId: f.orderId } })) // cascades lines
  await run('order lines', () => db.salesOrderLine.deleteMany({ where: { orderId: f.orderId } }))
  await run('order', () => db.salesOrder.delete({ where: { id: f.orderId } }))
  await run('components', () => db.productComponent.deleteMany({ where: { productId: f.kitId } }))
  await run('products', () => db.product.deleteMany({ where: { id: { in: [f.kitId, f.aId, f.bId] } } }))
  await run('warehouse', () => db.warehouse.delete({ where: { id: f.warehouseId } }))
  if (errors.length > 0) throw new AggregateError(errors, 'o3d-4gw0 cleanup failed')
}

/** Pin the line EXACTLY as allocation does: capture from a freshly loaded graph. */
async function pinLine(deps: Deps, f: Fixture) {
  const graph = await deps.loadFulfillmentProductGraph(deps.db, [f.kitId])
  await deps.db.salesOrderLine.update({
    where: { id: f.lineId },
    data: { fulfillmentRequirements: deps.captureFulfillmentRequirementSnapshot(f.kitId, graph) as never },
  })
}

async function recompose(deps: Deps, f: Fixture, recipe: { a: number; b: number }) {
  await deps.db.productComponent.update({
    where: { productId_componentId: { productId: f.kitId, componentId: f.aId } },
    data: { qty: recipe.a },
  })
  await deps.db.productComponent.update({
    where: { productId_componentId: { productId: f.kitId, componentId: f.bId } },
    data: { qty: recipe.b },
  })
}

/**
 * PRECONDITION, asserted and printed: the pinned per-unit factor for A and the CURRENT graph's factor
 * for A are different numbers. Returns both so the arm can print them.
 */
async function assertPinDisagreesWithCurrentGraph(deps: Deps, f: Fixture, pinnedA: number, currentA: number) {
  const line = await deps.db.salesOrderLine.findUniqueOrThrow({ where: { id: f.lineId }, select: { fulfillmentRequirements: true } })
  const pin = line.fulfillmentRequirements as { requirements: Array<{ productId: string; factor: string }> } | null
  assert.ok(pin, 'precondition: the line carries a pin')
  const pinnedFactor = Number(pin.requirements.find((r) => r.productId === f.aId)?.factor)
  const graph = await deps.loadFulfillmentProductGraph(deps.db, [f.kitId])
  const currentFactor = Number(deps.expandFulfillmentRequirementsDecimal(f.kitId, 1, graph).get(f.aId))
  console.log(`o3d-4gw0 precondition: pinned A factor=${pinnedFactor} current-graph A factor=${currentFactor} (expected ${pinnedA} vs ${currentA}); pin present=1`)
  assert.equal(pinnedFactor, pinnedA, 'precondition: the pin holds the order-time recipe')
  assert.equal(currentFactor, currentA, 'precondition: the current graph holds the re-composed recipe')
  assert.notEqual(pinnedFactor, currentFactor, 'precondition: pin and current graph DISAGREE')
}

/** One SHIPPED shipment covering these leaf quantities of the line. */
async function shipLeaves(deps: Deps, f: Fixture, a: number, b: number) {
  await deps.db.shipment.create({
    data: {
      orderId: f.orderId,
      warehouseId: f.warehouseId,
      status: 'PACKED',
      lines: { create: [
        { lineId: f.lineId, productId: f.aId, qty: a },
        { lineId: f.lineId, productId: f.bId, qty: b },
      ] },
    },
  })
}

async function refundKits(deps: Deps, f: Fixture, kits: number, productId: string | null = f.kitId) {
  await deps.db.salesOrderRefund.create({
    data: {
      orderId: f.orderId,
      totalForeign: 10, totalBase: 10,
      source: 'o3d-4gw0-test',
      lines: { create: [{
        salesOrderLineId: f.lineId, productId, description: 'o3d-4gw0 refund', qty: kits,
        unitPriceBase: 10, totalBase: 10,
      }] },
    },
  })
}

async function withFixture(
  recipe: { a: number; b: number },
  lineQty: number,
  body: (deps: Deps, f: Fixture) => Promise<void>,
) {
  const deps = await loadDeps()
  const f = await createFixture(deps, recipe, lineQty)
  try {
    await body(deps, f)
  } finally {
    await destroyFixture(deps, f)
  }
}

const summarize = (rows: Array<{ productId: string; outstandingQty: string; demandQty: string }>, f: Fixture) =>
  rows.map((r) => `${r.productId === f.aId ? 'A' : r.productId === f.bId ? 'B' : r.productId}: demand ${r.demandQty} outstanding ${r.outstandingQty}`)

test('o3d-4gw0 GROW: kit re-composed A 1->3 after the pin; fully covered order is NOT reported short', { skip: SKIP }, async () => {
  await withFixture({ a: 1, b: 1 }, 2, async (deps, f) => {
    await pinLine(deps, f)
    await recompose(deps, f, { a: 3, b: 1 })
    await assertPinDisagreesWithCurrentGraph(deps, f, 1, 3)
    await shipLeaves(deps, f, 2, 2) // exactly what the pinned recipe needs for 2 kits
    const rows = await deps.findExternalFulfillmentShortfall(f.orderId)
    console.log(`o3d-4gw0 GROW result: ${JSON.stringify(summarize(rows, f))}`)
    assert.deepEqual(rows, [], 'covered against the PIN, so nothing is short (current graph would say A short by 4)')
  })
})

test('o3d-4gw0 SHRINK: kit re-composed A 3->1 after the pin; a genuinely short order IS reported short', { skip: SKIP }, async () => {
  await withFixture({ a: 3, b: 1 }, 2, async (deps, f) => {
    await pinLine(deps, f)
    await recompose(deps, f, { a: 1, b: 1 })
    await assertPinDisagreesWithCurrentGraph(deps, f, 3, 1)
    await shipLeaves(deps, f, 2, 2) // pinned demand for A is 6; only 2 shipped
    const rows = await deps.findExternalFulfillmentShortfall(f.orderId)
    console.log(`o3d-4gw0 SHRINK result: ${JSON.stringify(summarize(rows, f))}`)
    const a = rows.filter((r) => r.productId === f.aId)
    assert.equal(a.length, 1, 'exactly one shortfall row for A')
    assert.equal(a[0].demandQty, '6')
    assert.equal(a[0].outstandingQty, '4')
    assert.equal(rows.filter((r) => r.productId === f.bId).length, 0, 'B is covered')
  })
})

test('o3d-4gw0 REFUND: a refund line nets through the PINNED line recipe, not the current graph', { skip: SKIP }, async () => {
  await withFixture({ a: 1, b: 1 }, 2, async (deps, f) => {
    await pinLine(deps, f)
    await recompose(deps, f, { a: 3, b: 1 })
    await assertPinDisagreesWithCurrentGraph(deps, f, 1, 3)
    await refundKits(deps, f, 1) // one of the two kits cancelled before dispatch
    await shipLeaves(deps, f, 1, 1) // pinned: demand A=2-1=1, B=2-1=1 -> covered
    const rows = await deps.findExternalFulfillmentShortfall(f.orderId)
    console.log(`o3d-4gw0 REFUND result: ${JSON.stringify(summarize(rows, f))}`)
    assert.deepEqual(rows, [], 'demand and the refund both read the pin, so they net to exactly the shipment')
  })
})

test('o3d-4gw0 REFUND-ISOLATING: with demand read from the pin, a current-graph REFUND would hide a real shortfall', { skip: SKIP }, async () => {
  // Isolates the refund expansion from the demand expansion. Pinned A=1, current A=3, 2 kits, one kit
  // refunded, NOTHING shipped. Pinned demand A=2, refund nets the pinned 1 -> A short by 1. If only the
  // refund half read the current graph it would net 3, drive A's demand to zero, and hide the shortfall.
  await withFixture({ a: 1, b: 1 }, 2, async (deps, f) => {
    await pinLine(deps, f)
    await recompose(deps, f, { a: 3, b: 1 })
    await assertPinDisagreesWithCurrentGraph(deps, f, 1, 3)
    await refundKits(deps, f, 1)
    const rows = await deps.findExternalFulfillmentShortfall(f.orderId)
    console.log(`o3d-4gw0 REFUND-ISOLATING result: ${JSON.stringify(summarize(rows, f))}`)
    const a = rows.filter((r) => r.productId === f.aId)
    assert.equal(a.length, 1, 'exactly one shortfall row for A')
    assert.equal(a[0].demandQty, '1', 'pinned demand 2 less pinned refund 1')
    assert.equal(a[0].outstandingQty, '1')
  })
})

test('o3d-4gw0 UNPINNED: a line that was never allocated still follows the CURRENT graph (seam fallback)', { skip: SKIP }, async () => {
  await withFixture({ a: 1, b: 1 }, 2, async (deps, f) => {
    // No pin on purpose; re-compose, then ship the OLD recipe's quantities.
    await recompose(deps, f, { a: 3, b: 1 })
    const line = await deps.db.salesOrderLine.findUniqueOrThrow({ where: { id: f.lineId }, select: { fulfillmentRequirements: true } })
    console.log(`o3d-4gw0 UNPINNED precondition: pin present=${line.fulfillmentRequirements == null ? 0 : 1} (expected 0)`)
    assert.equal(line.fulfillmentRequirements, null, 'precondition: the line has no pin')
    await shipLeaves(deps, f, 2, 2)
    const rows = await deps.findExternalFulfillmentShortfall(f.orderId)
    console.log(`o3d-4gw0 UNPINNED result: ${JSON.stringify(summarize(rows, f))}`)
    const a = rows.filter((r) => r.productId === f.aId)
    assert.equal(a.length, 1, 'exactly one shortfall row for A under the current recipe')
    assert.equal(a[0].demandQty, '6')
    assert.equal(a[0].outstandingQty, '4')
  })
})

test('o3d-4gw0 REFUND-PRODUCT-MISMATCH: a refund line naming another product than its line falls back to its own product', { skip: SKIP }, async () => {
  // Same rule shipment-service applies: the line's pin is not about a different product, so the
  // refund expands the product it names. Refund 2 units of component A on the kit line: A nets 2.
  await withFixture({ a: 1, b: 1 }, 2, async (deps, f) => {
    await pinLine(deps, f)
    await refundKits(deps, f, 2, f.aId) // product A (a leaf) on a line whose product is the kit
    await shipLeaves(deps, f, 0, 2)
    const rows = await deps.findExternalFulfillmentShortfall(f.orderId)
    console.log(`o3d-4gw0 MISMATCH result: ${JSON.stringify(summarize(rows, f))} (refund line product=A, line product=kit)`)
    assert.deepEqual(rows, [], 'A demand 2 less refund-of-A 2 = 0; B demand 2 covered')
  })
})
