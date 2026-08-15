import assert from 'node:assert/strict'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * o3d-4kfh r3: the TS reservation census and the SQL one must apply their tolerance at the SAME
 * AGGREGATION STAGE.
 *
 * `loadReservationSourceRows` (TS) and the `reservation_sources` CTE in `invariants.ts` (SQL) are
 * two implementations of one question: how much of `StockLevel.reservedQty` is attributable to a
 * known source. The SQL applies `HAVING SUM(...) > tolerance` — per (product, warehouse), per UNION
 * arm, AFTER aggregation. The TS used to drop each ROW whose residual was <= 0.0001 BEFORE anything
 * was summed, so three legitimate 0.0001 residuals in one scope contributed 0 in TS and 0.0003 in
 * SQL. The unit suite cannot see this: the SQL-shape assertions compare query TEXT, and the TS
 * tests never run the SQL.
 *
 * So this one runs both against a real Postgres, on the same rows, and is gated on
 * RUN_DB_CONCURRENCY_TESTS=1 like its siblings. It creates its own fixtures under a
 * process-unique tag and deletes them again; it asserts nothing about pre-existing data.
 *
 * Both boundary directions are covered:
 *   - a scope whose rows are individually AT the tolerance but sum ABOVE it — must be credited by
 *     both (this is the case the old TS got wrong),
 *   - a scope whose whole sum is AT the tolerance — must be dropped by both.
 * 0.0001 is the smallest quantity `OrderAllocation.qty` (Decimal(12,4)) can represent, which is
 * what fixes the fixture quantities.
 */
test(
  'reservation sources: TS and SQL apply the quantity tolerance at the same aggregation stage',
  { skip: process.env.RUN_DB_CONCURRENCY_TESTS !== '1' },
  async () => {
    config({ path: '.env.local', quiet: true })
    config({ quiet: true })
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')

    const { db } = await import('../../lib/db/index.ts')
    const { loadReservationSourceRows } = await import('../../lib/domain/inventory/reservation-breakdown.ts')
    const { collectSqlInventoryInvariantFindings } = await import('../../lib/domain/inventory/invariants.ts')

    const tag = `o3d-4kfh-${process.pid}-${Math.floor(performance.now())}`
    const warehouseId = `${tag}-wh`
    // ABOVE: three rows of 0.0001 that sum to 0.0003. BELOW: one row of 0.0001, the whole scope.
    const aboveProductId = `${tag}-above`
    const belowProductId = `${tag}-below`
    const orderId = `${tag}-so`

    // Summed as Decimal, not as float: 3 x 0.0001 in binary floating point is
    // 0.00030000000000000003, which would make the assertion below about IEEE-754 rather than
    // about the tolerance stage.
    const { Prisma } = await import('../../app/generated/prisma/client.ts')
    const sum = (rows: Array<{ qty: string }>) => rows
      .reduce((total, row) => total.add(new Prisma.Decimal(row.qty)), new Prisma.Decimal(0))
      .toString()

    try {
      await db.warehouse.create({
        data: { id: warehouseId, code: warehouseId, name: warehouseId, active: true, availableForSale: true },
      })
      for (const productId of [aboveProductId, belowProductId]) {
        await db.product.create({
          data: { id: productId, sku: productId, name: productId, type: 'SIMPLE', lifecycleStatus: 'ACTIVE', active: true },
        })
      }
      await db.salesOrder.create({
        data: {
          id: orderId,
          orderNumber: orderId,
          status: 'PROCESSING',
          subtotalForeign: 0,
          totalForeign: 0,
          subtotalBase: 0,
          totalBase: 0,
        },
      })
      // One allocation row per LINE: (lineId, warehouseId, productId) is unique, so three rows in
      // one scope need three lines. That is exactly the real shape — several kit/bundle lines of
      // one order holding tiny residuals of the same component in the same warehouse.
      const lineIds = ['a', 'b', 'c'].map((suffix) => `${tag}-line-${suffix}`)
      for (const lineId of lineIds) {
        await db.salesOrderLine.create({
          data: {
            id: lineId,
            orderId,
            productId: aboveProductId,
            description: lineId,
            qty: '0.0001',
            unitPriceForeign: 0,
            unitPriceBase: 0,
            totalForeign: 0,
            totalBase: 0,
          },
        })
        await db.orderAllocation.create({
          data: { orderId, lineId, productId: aboveProductId, warehouseId, qty: '0.0001' },
        })
      }
      const belowLineId = `${tag}-line-below`
      await db.salesOrderLine.create({
        data: {
          id: belowLineId,
          orderId,
          productId: belowProductId,
          description: belowLineId,
          qty: '0.0001',
          unitPriceForeign: 0,
          unitPriceBase: 0,
          totalForeign: 0,
          totalBase: 0,
        },
      })
      await db.orderAllocation.create({
        data: { orderId, lineId: belowLineId, productId: belowProductId, warehouseId, qty: '0.0001' },
      })

      // The stock levels the two censuses are judged against: the ABOVE scope really does hold the
      // 0.0003 its rows claim, the BELOW scope holds nothing.
      await db.stockLevel.create({
        data: { productId: aboveProductId, warehouseId, quantity: '1', reservedQty: '0.0003' },
      })
      await db.stockLevel.create({
        data: { productId: belowProductId, warehouseId, quantity: '1', reservedQty: '0' },
      })

      // --- TS side -------------------------------------------------------------------------
      const aboveRows = await loadReservationSourceRows(undefined, { productId: aboveProductId, warehouseId })
      assert.equal(
        sum(aboveRows),
        '0.0003',
        'three rows individually AT the tolerance still sum above it — dropping them per-row is what diverged from SQL',
      )
      const belowRows = await loadReservationSourceRows(undefined, { productId: belowProductId, warehouseId })
      assert.equal(sum(belowRows), '0', 'a scope whose whole sum is AT the tolerance is dropped, as the SQL HAVING drops it')

      // --- SQL side ------------------------------------------------------------------------
      // The SQL census agrees with reservedQty in both scopes, so it must raise no mismatch. Run
      // per scope so an unrelated finding elsewhere in the database cannot be mistaken for one here.
      for (const productId of [aboveProductId, belowProductId]) {
        const findings = await collectSqlInventoryInvariantFindings(undefined, { productId, warehouseId })
        const mismatches = findings.filter((finding) => finding.code === 'stock_reserved_source_mismatch')
        assert.deepEqual(
          mismatches.map((finding) => ({ productId: finding.productId, details: finding.details })),
          [],
          `SQL reported a reservation-source mismatch for ${productId}; TS and SQL disagree about the same rows`,
        )
      }
    } finally {
      await db.orderAllocation.deleteMany({ where: { orderId } })
      await db.salesOrderLine.deleteMany({ where: { orderId } })
      await db.salesOrder.deleteMany({ where: { id: orderId } })
      await db.stockLevel.deleteMany({ where: { warehouseId } })
      await db.product.deleteMany({ where: { id: { in: [aboveProductId, belowProductId] } } })
      await db.warehouse.deleteMany({ where: { id: warehouseId } })
    }
  },
)

/**
 * o3d-4kfh r3: the committed-coverage census must exist in BOTH implementations and agree.
 *
 * `allocation_committed_shipment_uncovered` is written twice — once as a UNION arm in the SQL
 * collector, once in the row evaluator — and the unit suite proves neither against the other: the
 * "SQL collector output matches evaluator output" test feeds the evaluator's own findings back
 * through a `$queryRaw` double, so it exercises the mapping layer and not one line of SQL. This
 * runs the real query and the real evaluator over the same real rows.
 */
test(
  'committed-coverage census: the SQL branch and the row evaluator agree on real rows',
  { skip: process.env.RUN_DB_CONCURRENCY_TESTS !== '1' },
  async () => {
    config({ path: '.env.local', quiet: true })
    config({ quiet: true })
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')

    const { db } = await import('../../lib/db/index.ts')
    const {
      collectInventoryInvariantRows,
      collectSqlInventoryInvariantFindings,
      evaluateInventoryInvariantRows,
    } = await import('../../lib/domain/inventory/invariants.ts')

    const tag = `o3d-4kfh-cov-${process.pid}-${Math.floor(performance.now())}`
    const warehouseId = `${tag}-wh`
    const productId = `${tag}-p`
    const orderId = `${tag}-so`
    const lineId = `${tag}-line`

    try {
      await db.warehouse.create({
        data: { id: warehouseId, code: warehouseId, name: warehouseId, active: true, availableForSale: true },
      })
      await db.product.create({
        data: { id: productId, sku: productId, name: productId, type: 'SIMPLE', lifecycleStatus: 'ACTIVE', active: true },
      })
      await db.salesOrder.create({
        data: {
          id: orderId,
          orderNumber: orderId,
          status: 'PROCESSING',
          subtotalForeign: 0,
          totalForeign: 0,
          subtotalBase: 0,
          totalBase: 0,
        },
      })
      await db.salesOrderLine.create({
        data: {
          id: lineId,
          orderId,
          productId,
          description: lineId,
          qty: '10',
          unitPriceForeign: 0,
          unitPriceBase: 0,
          totalForeign: 0,
          totalBase: 0,
        },
      })
      // The corruption: 10 committed against a row of 5.
      await db.orderAllocation.create({
        data: { orderId, lineId, productId, warehouseId, qty: '5' },
      })
      const shipment = await db.shipment.create({
        data: {
          orderId,
          warehouseId,
          status: 'PICKING',
          lines: { create: [{ lineId, productId, qty: '10' }] },
        },
        select: { id: true },
      })
      await db.stockLevel.create({
        data: { productId, warehouseId, quantity: '10', reservedQty: '5' },
      })

      const sqlFindings = (await collectSqlInventoryInvariantFindings(undefined, { productId, warehouseId }))
        .filter((finding) => finding.code === 'allocation_committed_shipment_uncovered')
      const evaluatorFindings = evaluateInventoryInvariantRows(await collectInventoryInvariantRows())
        .filter((finding) => (
          finding.code === 'allocation_committed_shipment_uncovered'
          && finding.productId === productId
        ))

      assert.equal(sqlFindings.length, 1, 'the SQL branch must see it')
      assert.equal(evaluatorFindings.length, 1, 'and so must the row evaluator')
      const normalise = (finding: { productId?: string | null; warehouseId?: string | null; details: unknown }) => ({
        productId: finding.productId ?? null,
        warehouseId: finding.warehouseId ?? null,
        // jsonb comes back as strings from Postgres and as numbers from the evaluator, so the
        // comparison is on VALUE, not on representation.
        details: Object.fromEntries(
          Object.entries(finding.details as Record<string, unknown>)
            .map(([key, value]) => [key, typeof value === 'string' && !Number.isNaN(Number(value)) ? Number(value) : value]),
        ),
      })
      assert.deepEqual(normalise(sqlFindings[0]), normalise(evaluatorFindings[0]))
      assert.deepEqual(normalise(sqlFindings[0]).details, {
        lineId,
        sku: productId,
        committedQty: 10,
        allocatedQty: 5,
        delta: 5,
      })

      // And it disappears once the row covers the commitment — in BOTH implementations.
      await db.orderAllocation.updateMany({ where: { orderId, lineId }, data: { qty: '10' } })
      await db.stockLevel.updateMany({ where: { productId, warehouseId }, data: { reservedQty: '10' } })
      assert.deepEqual(
        (await collectSqlInventoryInvariantFindings(undefined, { productId, warehouseId }))
          .filter((finding) => finding.code === 'allocation_committed_shipment_uncovered'),
        [],
      )
      assert.deepEqual(
        evaluateInventoryInvariantRows(await collectInventoryInvariantRows())
          .filter((finding) => (
            finding.code === 'allocation_committed_shipment_uncovered'
            && finding.productId === productId
          )),
        [],
      )
      void shipment
    } finally {
      await db.shipmentLine.deleteMany({ where: { shipment: { orderId } } })
      await db.shipment.deleteMany({ where: { orderId } })
      await db.orderAllocation.deleteMany({ where: { orderId } })
      await db.salesOrderLine.deleteMany({ where: { orderId } })
      await db.salesOrder.deleteMany({ where: { id: orderId } })
      await db.stockLevel.deleteMany({ where: { warehouseId } })
      await db.product.deleteMany({ where: { id: productId } })
      await db.warehouse.deleteMany({ where: { id: warehouseId } })
    }
  },
)
