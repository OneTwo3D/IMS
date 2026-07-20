import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Prisma, ProductType } from '@/app/generated/prisma/client'
import { calculateDailyVelocity } from '@/lib/domain/inventory/velocity'
import {
  attributeWarehouseLessDemand,
  getDeadStockReport,
  getInventoryAgingReport,
  type InventoryHealthReportClient,
} from '@/lib/domain/inventory/inventory-health-reports'

function decimal(value: string | number): Prisma.Decimal {
  return new Prisma.Decimal(value)
}

const warehouse = { id: 'warehouse-1', code: 'WH1', name: 'Main warehouse' }

function product(overrides: Partial<{
  id: string
  sku: string
  name: string
  type: ProductType
  stockUnit: string
}> = {}) {
  return {
    id: overrides.id ?? 'product-1',
    sku: overrides.sku ?? 'SKU-1',
    name: overrides.name ?? 'Widget',
    type: overrides.type ?? ProductType.SIMPLE,
    stockUnit: overrides.stockUnit ?? 'pcs',
    category: { name: 'Finished goods' },
    supplierProducts: [{ supplier: { name: 'Supplier A' } }],
  }
}

function makeClient(overrides: Partial<InventoryHealthReportClient>): InventoryHealthReportClient {
  const unused = { findMany: async () => [] }
  return {
    stockLevel: unused,
    stockMovement: unused,
    costLayer: unused,
    cogsEntry: unused,
    kitItem: unused,
    ...overrides,
  }
}

test('inventory aging reconstructs as-of quantity from remaining cost layers plus later COGS', async () => {
  const client = makeClient({
    costLayer: {
      findMany: async () => [
        {
          id: 'layer-old',
          productId: 'product-1',
          warehouseId: 'warehouse-1',
          remainingQty: decimal('10'),
          unitCostBase: decimal('2'),
          receivedAt: new Date('2026-05-01T00:00:00.000Z'),
          product: product(),
          warehouse,
        },
        {
          id: 'layer-new',
          productId: 'product-1',
          warehouseId: 'warehouse-1',
          remainingQty: decimal('5'),
          unitCostBase: decimal('3'),
          receivedAt: new Date('2026-06-01T00:00:00.000Z'),
          product: product(),
          warehouse,
        },
      ],
    },
    cogsEntry: {
      findMany: async () => [
        { costLayerId: 'layer-old', qty: decimal('2') },
      ],
    },
  })

  const report = await getInventoryAgingReport(
    { asOf: '2026-06-01' },
    {
      paginate: false,
      deps: { client, now: () => new Date('2026-06-02T00:00:00.000Z') },
    },
  )

  assert.equal(report.asOf, '2026-06-01T23:59:59.999Z')
  assert.equal(report.pageInfo.totalRows, 2)
  assert.deepEqual(report.totals, { qty: '17', valueBase: '39' })
  assert.deepEqual(report.rows.map((row) => [row.bucket, row.qty, row.valueBase]), [
    ['0-30', '5', '15'],
    ['31-60', '12', '24'],
  ])
  assert.deepEqual(report.bucketSummary.map((row) => [row.bucket, row.qty, row.valueBase]), [
    ['0-30', '5', '15'],
    ['31-60', '12', '24'],
  ])
})

test('inventory aging reports BOM products from their own production cost layer', async () => {
  const client = makeClient({
    costLayer: {
      findMany: async () => [
        {
          id: 'bom-layer',
          productId: 'bom-1',
          warehouseId: 'warehouse-1',
          remainingQty: decimal('4'),
          unitCostBase: decimal('12.5'),
          receivedAt: new Date('2026-04-01T00:00:00.000Z'),
          product: product({ id: 'bom-1', sku: 'BOM-1', name: 'Manufactured widget', type: ProductType.BOM }),
          warehouse,
        },
      ],
    },
  })

  const report = await getInventoryAgingReport(
    { asOf: '2026-06-01', productType: ProductType.BOM },
    {
      paginate: false,
      deps: { client, now: () => new Date('2026-06-02T00:00:00.000Z') },
    },
  )

  assert.equal(report.rows.length, 1)
  assert.equal(report.rows[0]?.productType, ProductType.BOM)
  assert.equal(report.rows[0]?.source, 'cost_layer')
  assert.equal(report.rows[0]?.qty, '4')
  assert.equal(report.rows[0]?.valueBase, '50')
})

test('inventory aging rolls KIT exposure up from component cost layers when filtered to KIT', async () => {
  const client = makeClient({
    kitItem: {
      findMany: async () => [
        {
          parentProductId: 'kit-1',
          componentProductId: 'component-1',
          qty: decimal('2'),
          parentProduct: product({ id: 'kit-1', sku: 'KIT-1', name: 'Starter kit', type: ProductType.KIT }),
          component: product({ id: 'component-1', sku: 'COMP-1', name: 'Component' }),
        },
      ],
    },
    costLayer: {
      findMany: async () => [
        {
          id: 'component-layer',
          productId: 'component-1',
          warehouseId: 'warehouse-1',
          remainingQty: decimal('10'),
          unitCostBase: decimal('5'),
          receivedAt: new Date('2026-03-01T00:00:00.000Z'),
          product: product({ id: 'component-1', sku: 'COMP-1', name: 'Component' }),
          warehouse,
        },
      ],
    },
  })

  const report = await getInventoryAgingReport(
    { asOf: '2026-06-01', productType: ProductType.KIT },
    {
      paginate: false,
      deps: { client, now: () => new Date('2026-06-02T00:00:00.000Z') },
    },
  )

  assert.equal(report.kitAgingMode, 'component')
  assert.equal(report.rows.length, 1)
  assert.equal(report.rows[0]?.sku, 'COMP-1')
  assert.equal(report.rows[0]?.productName, 'Component for KIT-1')
  assert.equal(report.rows[0]?.source, 'kit_component')
  assert.equal(report.rows[0]?.qty, '10')
  assert.equal(report.rows[0]?.valueBase, '50')
  assert.match(report.notices[0] ?? '', /component exposure/)
  assert.match(report.notices[1] ?? '', /current CostLayer\.unitCostBase/)
})

test('inventory aging caps source cost-layer scans before in-memory bucketing', async () => {
  let observedTake: unknown
  const client = makeClient({
    costLayer: {
      findMany: async (args?: unknown) => {
        observedTake = (args as { take?: unknown } | undefined)?.take
        return Array.from({ length: Number(observedTake) }, (_, index) => ({
          id: `layer-${index}`,
          productId: 'product-1',
          warehouseId: 'warehouse-1',
          remainingQty: decimal('1'),
          unitCostBase: decimal('1'),
          receivedAt: new Date('2026-05-01T00:00:00.000Z'),
          product: product(),
          warehouse,
        }))
      },
    },
  })

  await assert.rejects(
    () => getInventoryAgingReport(
      { asOf: '2026-06-01' },
      {
        paginate: false,
        deps: { client, now: () => new Date('2026-06-02T00:00:00.000Z') },
      },
    ),
    /cost-layer scan exceeds 100,000 rows/,
  )
  assert.equal(observedTake, 100001)
})

test('inventory aging caps KIT component layer scans before component bucketing', async () => {
  const observedTakes: unknown[] = []
  const client = makeClient({
    kitItem: {
      findMany: async (args?: unknown) => {
        observedTakes.push((args as { take?: unknown } | undefined)?.take)
        return [{
          parentProductId: 'kit-1',
          componentProductId: 'component-1',
          qty: decimal('1'),
          parentProduct: product({ id: 'kit-1', sku: 'KIT-1', name: 'Starter kit', type: ProductType.KIT }),
          component: product({ id: 'component-1', sku: 'COMP-1', name: 'Component' }),
        }]
      },
    },
    costLayer: {
      findMany: async (args?: unknown) => {
        observedTakes.push((args as { take?: unknown } | undefined)?.take)
        return Array.from({ length: Number((args as { take?: number }).take) }, (_, index) => ({
          id: `component-layer-${index}`,
          productId: 'component-1',
          warehouseId: 'warehouse-1',
          remainingQty: decimal('1'),
          unitCostBase: decimal('1'),
          receivedAt: new Date('2026-05-01T00:00:00.000Z'),
          product: product({ id: 'component-1', sku: 'COMP-1', name: 'Component' }),
          warehouse,
        }))
      },
    },
  })

  await assert.rejects(
    () => getInventoryAgingReport(
      { asOf: '2026-06-01', productType: ProductType.KIT },
      {
        paginate: false,
        deps: { client, now: () => new Date('2026-06-02T00:00:00.000Z') },
      },
    ),
    /KIT component cost-layer scan exceeds 100,000 rows/,
  )
  assert.deepEqual(observedTakes, [50001, 100001])
})

test('warehouse-less imported sales history counts as demand, so the SKU is not called dead (o3d-t9k)', async () => {
  // The historical/initial sales import records past sales as WAREHOUSE-LESS SALE_DISPATCH movements
  // (migration 20260616120000_exempt_historical_imports_from_cogs_guard). Those rows used to be keyed by
  // bare productId while positions are keyed productId:warehouseId, so the key spaces never intersected
  // and the demand evidence was discarded — an import-reliant SKU could be recommended for reorder and
  // listed as dead at the same time. Acting on that would liquidate stock that is demonstrably selling.
  const capturedWhere: Array<Record<string, unknown>> = []
  const client = makeClient({
    stockLevel: {
      findMany: async () => [{
        productId: 'imported-1',
        warehouseId: 'warehouse-1',
        quantity: decimal('4'),
        product: product({ id: 'imported-1', sku: 'IMPORTED-1', name: 'Imported history item' }),
        warehouse,
      }],
    },
    costLayer: {
      findMany: async () => [{
        productId: 'imported-1',
        warehouseId: 'warehouse-1',
        remainingQty: decimal('4'),
        unitCostBase: decimal('5'),
        receivedAt: new Date('2026-01-01T00:00:00.000Z'),
      }],
    },
    stockMovement: {
      findMany: async (args?: unknown) => {
        capturedWhere.push((args as { where: Record<string, unknown> }).where)
        return [{
          id: 'sale-imported',
          productId: 'imported-1',
          fromWarehouseId: null,
          toWarehouseId: null,
          referenceType: 'WcHistorical', // <- the historical import shape: warehouse-less AND imported
          qty: decimal('1'),
          totalValueBase: decimal('5'),
          createdAt: new Date('2026-05-15T00:00:00.000Z'), // recent: well inside the 90-day threshold
          product: product({ id: 'imported-1', sku: 'IMPORTED-1', name: 'Imported history item' }),
        }]
      },
    },
  })

  const report = await getDeadStockReport(
    { asOf: '2026-06-01', thresholdDays: 90, warehouseId: 'warehouse-1' },
    { paginate: false, deps: { client, now: () => new Date('2026-06-02T00:00:00.000Z') } },
  )

  // 1. The query must not filter the warehouse-less rows out in the first place.
  const or = capturedWhere[0]?.OR as Array<Record<string, unknown>> | undefined
  assert.ok(or?.some((clause) => clause.fromWarehouseId === null), 'warehouse-less demand must not be filtered out')

  // 2. And the evidence must actually reach the position, not be dropped on a key that matches nothing.
  assert.deepEqual(report.rows.map((row) => row.sku), [], 'a SKU with recent imported demand is not dead')
  assert.equal(report.totals.neverSoldRows, 0)
})

test('collapsing warehouse-less demand is EXACT — identical velocity to cloning each movement (o3d-t9k)', async () => {
  // The commit claims collapsing is safe because calculateDailyVelocity is an associative fold and the
  // source query is already window-bounded. This proves it rather than asserting it: the collapsed
  // attribution and the naive clone-per-movement approach must produce byte-identical velocity rows,
  // including firstSaleAt — which the dead-stock report itself never surfaces, so nothing else covers it.
  const positions = [
    { productId: 'p1', warehouseId: 'w1' },
    { productId: 'p1', warehouseId: 'w2' },
  ]
  const base = { productId: 'p1', sku: 'P1', productName: 'Product 1' }
  // Revenue values DIFFER per row on purpose: revenueBase is additive, so a collapse that carried the
  // first row's value instead of summing it (and left it on the zero-quantity carrier) would double-count.
  // Metadata DIFFERS per row too: calculateDailyVelocity takes the LAST defined value for categoryName
  // and supplierNames, so a collapse that kept the first row's copy would disagree with the clone path.
  // The nullish row must be skipped rather than overwriting, exactly as `?? current` does.
  const sales = [
    { ...base, qty: 2, cogsBase: 10, revenueBase: 20, categoryName: 'First', supplierNames: ['A'], occurredAt: new Date('2025-07-01T00:00:00.000Z') },
    { ...base, qty: 3, cogsBase: 15, revenueBase: 30, categoryName: null, supplierNames: undefined, occurredAt: new Date('2026-05-15T00:00:00.000Z') },
    { ...base, qty: 1, cogsBase: 5, revenueBase: 10, categoryName: 'Last', supplierNames: ['B'], occurredAt: new Date('2026-01-10T00:00:00.000Z') },
  ]
  const window = { dateFrom: new Date('2025-06-02T00:00:00.000Z'), dateTo: new Date('2026-06-01T23:59:59.999Z') }

  const collapsed = calculateDailyVelocity(attributeWarehouseLessDemand(sales, positions), window)
  // The naive approach this replaces: one clone per (movement, position).
  const cloned = calculateDailyVelocity(
    sales.flatMap((sale) => positions.map((position) => ({ ...sale, key: `${position.productId}:${position.warehouseId}` }))),
    window,
  )

  const sortByKey = (rows: typeof collapsed) => [...rows].sort((a, b) => String(a.key).localeCompare(String(b.key)))
  assert.deepEqual(sortByKey(collapsed), sortByKey(cloned))
  // And sanity-check the values themselves, so an equal-but-both-wrong result cannot pass.
  assert.deepEqual(sortByKey(collapsed).map((row) => [row.key, row.qtySold, row.cogsBase, row.revenueBase, row.categoryName, row.supplierNames, row.firstSaleAt, row.lastSaleAt]), [
    ['p1:w1', '6', '30', '60', 'Last', ['B'], '2025-07-01T00:00:00.000Z', '2026-05-15T00:00:00.000Z'],
    ['p1:w2', '6', '30', '60', 'Last', ['B'], '2025-07-01T00:00:00.000Z', '2026-05-15T00:00:00.000Z'],
  ])
})

test('the collapse validates each row, so a negative cannot cancel against a positive (o3d-t9k)', async () => {
  // calculateDailyVelocity rejects negative inputs PER ROW. Summing before validating would let a
  // negative row net off against a positive one and slip past the check entirely.
  const positions = [{ productId: 'p1', warehouseId: 'w1' }]
  const base = { productId: 'p1', sku: 'P1', productName: 'Product 1' }
  assert.throws(
    () => attributeWarehouseLessDemand([
      { ...base, qty: 5, occurredAt: new Date('2026-01-10T00:00:00.000Z') },
      { ...base, qty: -5, occurredAt: new Date('2026-02-10T00:00:00.000Z') },
    ], positions),
    /negative qty/,
  )
  assert.throws(
    () => attributeWarehouseLessDemand([
      { ...base, qty: 1, revenueBase: 5, occurredAt: new Date('2026-01-10T00:00:00.000Z') },
      { ...base, qty: 1, revenueBase: -5, occurredAt: new Date('2026-02-10T00:00:00.000Z') },
    ], positions),
    /negative revenueBase/,
  )
})

test('a warehouse-less ordinary dispatch is NOT treated as imported demand (o3d-t9k)', async () => {
  // StockMovement's warehouse relations are optional with no explicit onDelete, so Prisma defaults to
  // SetNull: DELETING A WAREHOUSE rewrites its ordinary SalesOrder dispatches into the warehouse-less
  // shape. If provenance were not checked, that one warehouse's sales would be spread across every
  // warehouse holding the product and suppress legitimate dead-stock rows for the whole lookback window.
  // Only a genuine historical import may carry demand with no warehouse.
  const client = makeClient({
    stockLevel: {
      findMany: async () => [{
        productId: 'orphaned-1',
        warehouseId: 'warehouse-1',
        quantity: decimal('4'),
        product: product({ id: 'orphaned-1', sku: 'ORPHANED-1', name: 'Stock whose sale lost its warehouse' }),
        warehouse,
      }],
    },
    costLayer: {
      findMany: async () => [{
        productId: 'orphaned-1',
        warehouseId: 'warehouse-1',
        remainingQty: decimal('4'),
        unitCostBase: decimal('5'),
        receivedAt: new Date('2026-01-01T00:00:00.000Z'),
      }],
    },
    stockMovement: {
      findMany: async () => [{
        id: 'sale-orphaned',
        productId: 'orphaned-1',
        fromWarehouseId: null,       // warehouse deleted...
        referenceType: 'SalesOrder', // ...but this is a REAL dispatch, not an import
        qty: decimal('1'),
        totalValueBase: decimal('5'),
        createdAt: new Date('2026-05-15T00:00:00.000Z'),
        product: product({ id: 'orphaned-1', sku: 'ORPHANED-1', name: 'Stock whose sale lost its warehouse' }),
      }],
    },
  })

  const report = await getDeadStockReport(
    { asOf: '2026-06-01', thresholdDays: 90 },
    { paginate: false, deps: { client, now: () => new Date('2026-06-02T00:00:00.000Z') } },
  )

  // It must not count as demand for warehouse-1 — the SKU still reports as dead.
  assert.deepEqual(report.rows.map((row) => row.sku), ['ORPHANED-1'])
})

test('a historical-typed row WITH a destination warehouse is not imported demand either (o3d-t9k)', async () => {
  // The mapper guard must match HISTORICAL_IMPORT_MOVEMENT_SHAPE exactly — BOTH warehouse columns null.
  // Checking only fromWarehouseId would leave it weaker than the query it backstops, so a row carrying a
  // destination warehouse could still be spread across every warehouse if that predicate were loosened.
  const client = makeClient({
    stockLevel: {
      findMany: async () => [{
        productId: 'moved-1',
        warehouseId: 'warehouse-1',
        quantity: decimal('4'),
        product: product({ id: 'moved-1', sku: 'MOVED-1', name: 'Item with a destination warehouse' }),
        warehouse,
      }],
    },
    costLayer: {
      findMany: async () => [{
        productId: 'moved-1',
        warehouseId: 'warehouse-1',
        remainingQty: decimal('4'),
        unitCostBase: decimal('5'),
        receivedAt: new Date('2026-01-01T00:00:00.000Z'),
      }],
    },
    stockMovement: {
      findMany: async () => [{
        id: 'sale-moved',
        productId: 'moved-1',
        fromWarehouseId: null,
        toWarehouseId: 'warehouse-2', // <- has a destination, so NOT the import shape
        referenceType: 'WcHistorical',
        qty: decimal('1'),
        totalValueBase: decimal('5'),
        createdAt: new Date('2026-05-15T00:00:00.000Z'),
        product: product({ id: 'moved-1', sku: 'MOVED-1', name: 'Item with a destination warehouse' }),
      }],
    },
  })

  const report = await getDeadStockReport(
    { asOf: '2026-06-01', thresholdDays: 90 },
    { paginate: false, deps: { client, now: () => new Date('2026-06-02T00:00:00.000Z') } },
  )

  assert.deepEqual(report.rows.map((row) => row.sku), ['MOVED-1'])
})

test('warehouse-less demand is collapsed per product, not cloned per movement, and reaches every position (o3d-t9k)', async () => {
  // Cloning each movement per position would allocate movements x warehouses rows — up to the 100k source
  // limit times N, which defeats a guard that runs BEFORE the fan-out. Collapsing first is exact because
  // the velocity calculation is an associative fold and the query is already window-bounded. This asserts
  // the OBSERVABLE consequence: two warehouse-less sales on different dates, one product, two warehouses.
  const capturedWhere: Array<Record<string, unknown>> = []
  const twoWarehousePositions = [
    { productId: 'imported-1', warehouseId: 'warehouse-1', quantity: decimal('4'), product: product({ id: 'imported-1', sku: 'IMPORTED-1', name: 'Imported history item' }), warehouse },
    { productId: 'imported-1', warehouseId: 'warehouse-2', quantity: decimal('6'), product: product({ id: 'imported-1', sku: 'IMPORTED-1', name: 'Imported history item' }), warehouse: { ...warehouse, id: 'warehouse-2', code: 'WH2', name: 'Second warehouse' } },
  ]
  const client = makeClient({
    stockLevel: { findMany: async () => twoWarehousePositions },
    costLayer: {
      findMany: async () => [
        { productId: 'imported-1', warehouseId: 'warehouse-1', remainingQty: decimal('4'), unitCostBase: decimal('5'), receivedAt: new Date('2026-01-01T00:00:00.000Z') },
        { productId: 'imported-1', warehouseId: 'warehouse-2', remainingQty: decimal('6'), unitCostBase: decimal('5'), receivedAt: new Date('2026-01-01T00:00:00.000Z') },
      ],
    },
    stockMovement: {
      findMany: async (args?: unknown) => {
        capturedWhere.push((args as { where: Record<string, unknown> }).where)
        return [
          // Two sales, different dates — the collapse must keep BOTH ends of the range.
          { id: 'sale-old', productId: 'imported-1', fromWarehouseId: null, toWarehouseId: null, referenceType: 'WcHistorical', qty: decimal('2'), totalValueBase: decimal('10'), createdAt: new Date('2025-07-01T00:00:00.000Z'), product: product({ id: 'imported-1', sku: 'IMPORTED-1', name: 'Imported history item' }) },
          { id: 'sale-new', productId: 'imported-1', fromWarehouseId: null, toWarehouseId: null, referenceType: 'WcHistorical', qty: decimal('3'), totalValueBase: decimal('15'), createdAt: new Date('2026-05-15T00:00:00.000Z') , product: product({ id: 'imported-1', sku: 'IMPORTED-1', name: 'Imported history item' }) },
        ]
      },
    },
  })

  const report = await getDeadStockReport(
    { asOf: '2026-06-01', thresholdDays: 90 },
    { paginate: false, deps: { client, now: () => new Date('2026-06-02T00:00:00.000Z') } },
  )

  // Demand reached BOTH positions, so neither warehouse is called dead.
  assert.deepEqual(report.rows.map((row) => row.sku), [])
  assert.equal(report.totals.neverSoldRows, 0)
  // And the movement scan is bounded to products that actually hold stock in scope — as a RELATION
  // predicate, not an id list, which would bind one parameter per product and blow PostgreSQL's 32,767
  // bind limit well below the 100k position cap.
  const productPredicate = capturedWhere[0]?.product as { stockLevels?: { some?: Record<string, unknown> } } | undefined
  assert.deepEqual(productPredicate?.stockLevels?.some, { quantity: { gt: 0 } })
  assert.equal('productId' in (capturedWhere[0] ?? {}), false, 'must not bind an id list')
})

test('dead stock skips the movement scan entirely when no positions are in scope (o3d-t9k)', async () => {
  // Nothing can be dead if nothing is stocked, so the (potentially 100k-row) scan must not run at all.
  let movementScans = 0
  const client = makeClient({
    stockLevel: { findMany: async () => [] },
    costLayer: { findMany: async () => [] },
    stockMovement: {
      findMany: async () => {
        movementScans += 1
        return []
      },
    },
  })

  const report = await getDeadStockReport(
    { asOf: '2026-06-01', thresholdDays: 90, warehouseId: 'warehouse-1' },
    { paginate: false, deps: { client, now: () => new Date('2026-06-02T00:00:00.000Z') } },
  )

  assert.equal(movementScans, 0)
  assert.deepEqual(report.rows, [])
})

test('dead stock report sources current stocked rows and sale-dispatch velocity', async () => {
  const calls: Array<{ delegate: string; args?: unknown }> = []
  const client = makeClient({
    stockLevel: {
      findMany: async (args?: unknown) => {
        calls.push({ delegate: 'stockLevel', args })
        return [
          {
            productId: 'dead-1',
            warehouseId: 'warehouse-1',
            quantity: decimal('4'),
            product: product({ id: 'dead-1', sku: 'DEAD-1', name: 'Dead item' }),
            warehouse,
          },
          {
            productId: 'fast-1',
            warehouseId: 'warehouse-1',
            quantity: decimal('3'),
            product: product({ id: 'fast-1', sku: 'FAST-1', name: 'Fast item' }),
            warehouse,
          },
          {
            productId: 'new-1',
            warehouseId: 'warehouse-1',
            quantity: decimal('2'),
            product: product({ id: 'new-1', sku: 'NEW-1', name: 'New item' }),
            warehouse,
          },
        ]
      },
    },
    costLayer: {
      findMany: async (args?: unknown) => {
        calls.push({ delegate: 'costLayer', args })
        return [
          {
            productId: 'dead-1',
            warehouseId: 'warehouse-1',
            remainingQty: decimal('4'),
            unitCostBase: decimal('5'),
            receivedAt: new Date('2026-01-01T00:00:00.000Z'),
          },
          {
            productId: 'fast-1',
            warehouseId: 'warehouse-1',
            remainingQty: decimal('3'),
            unitCostBase: decimal('7'),
            receivedAt: new Date('2026-01-01T00:00:00.000Z'),
          },
          {
            productId: 'new-1',
            warehouseId: 'warehouse-1',
            remainingQty: decimal('2'),
            unitCostBase: decimal('11'),
            receivedAt: new Date('2026-05-15T00:00:00.000Z'),
          },
        ]
      },
    },
    stockMovement: {
      findMany: async (args?: unknown) => {
        calls.push({ delegate: 'stockMovement', args })
        return [
          {
            id: 'sale-dead',
            productId: 'dead-1',
            fromWarehouseId: 'warehouse-1',
            qty: decimal('1'),
            totalValueBase: decimal('5'),
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            product: product({ id: 'dead-1', sku: 'DEAD-1', name: 'Dead item' }),
          },
          {
            id: 'sale-fast',
            productId: 'fast-1',
            fromWarehouseId: 'warehouse-1',
            qty: decimal('1'),
            totalValueBase: decimal('7'),
            createdAt: new Date('2026-05-15T00:00:00.000Z'),
            product: product({ id: 'fast-1', sku: 'FAST-1', name: 'Fast item' }),
          },
        ]
      },
    },
  })

  const report = await getDeadStockReport(
    { asOf: '2026-06-01', thresholdDays: 90 },
    {
      paginate: false,
      deps: { client, now: () => new Date('2026-06-02T00:00:00.000Z') },
    },
  )

  assert.equal(report.asOf, '2026-06-01T23:59:59.999Z')
  assert.equal(report.thresholdDays, 90)
  assert.equal(report.velocityWindowDateFrom, '2025-06-02')
  assert.equal(report.velocityWindowDateTo, '2026-06-01')
  assert.deepEqual(report.rows.map((row) => [row.sku, row.qty, row.valueBase, row.daysSinceLastSale]), [
    ['DEAD-1', '4', '20', 151],
  ])
  assert.deepEqual(report.totals, { qty: '4', valueBase: '20', neverSoldRows: 0 })

  const stockMovementCall = calls.find((call) => call.delegate === 'stockMovement')
  assert.equal((stockMovementCall?.args as { where?: { type?: unknown } }).where?.type, 'SALE_DISPATCH')
})

test('dead stock report caps stock-level source scan before valuation and velocity work', async () => {
  let observedTake: unknown
  const client = makeClient({
    stockLevel: {
      findMany: async (args?: unknown) => {
        observedTake = (args as { take?: unknown } | undefined)?.take
        return Array.from({ length: Number(observedTake) }, (_, index) => ({
          productId: `product-${index}`,
          warehouseId: 'warehouse-1',
          quantity: decimal('1'),
          product: product({ id: `product-${index}`, sku: `SKU-${index}` }),
          warehouse,
        }))
      },
    },
  })

  await assert.rejects(
    () => getDeadStockReport(
      { asOf: '2026-06-01' },
      {
        paginate: false,
        deps: { client, now: () => new Date('2026-06-02T00:00:00.000Z') },
      },
    ),
    /stock-level scan exceeds 100,000 rows/,
  )
  assert.equal(observedTake, 100001)
})

test('dead stock uses historical first-stocked evidence, not only open cost layers', async () => {
  const client = makeClient({
    stockLevel: {
      findMany: async () => [
        {
          productId: 'restocked-1',
          warehouseId: 'warehouse-1',
          quantity: decimal('2'),
          product: product({ id: 'restocked-1', sku: 'RESTOCKED-1', name: 'Restocked item' }),
          warehouse,
        },
      ],
    },
    costLayer: {
      findMany: async () => [
        {
          productId: 'restocked-1',
          warehouseId: 'warehouse-1',
          remainingQty: decimal('0'),
          unitCostBase: decimal('4'),
          receivedAt: new Date('2025-01-01T00:00:00.000Z'),
        },
        {
          productId: 'restocked-1',
          warehouseId: 'warehouse-1',
          remainingQty: decimal('2'),
          unitCostBase: decimal('6'),
          receivedAt: new Date('2026-06-01T00:00:00.000Z'),
        },
      ],
    },
    stockMovement: { findMany: async () => [] },
  })

  const report = await getDeadStockReport(
    { asOf: '2026-06-15', thresholdDays: 90 },
    {
      paginate: false,
      deps: { client, now: () => new Date('2026-06-16T00:00:00.000Z') },
    },
  )

  assert.equal(report.rows.length, 1)
  assert.equal(report.rows[0]?.sku, 'RESTOCKED-1')
  assert.equal(report.rows[0]?.firstStockedAt, '2025-01-01T00:00:00.000Z')
  assert.equal(report.rows[0]?.valueBase, '12')
})

test('dead stock is evaluated per warehouse without rewriting product identity', async () => {
  const warehouse2 = { id: 'warehouse-2', code: 'WH2', name: 'Overflow warehouse' }
  const client = makeClient({
    stockLevel: {
      findMany: async () => [
        {
          productId: 'product-1',
          warehouseId: 'warehouse-1',
          quantity: decimal('2'),
          product: product(),
          warehouse,
        },
        {
          productId: 'product-1',
          warehouseId: 'warehouse-2',
          quantity: decimal('3'),
          product: product(),
          warehouse: warehouse2,
        },
      ],
    },
    costLayer: {
      findMany: async () => [
        {
          productId: 'product-1',
          warehouseId: 'warehouse-1',
          remainingQty: decimal('2'),
          unitCostBase: decimal('5'),
          receivedAt: new Date('2025-01-01T00:00:00.000Z'),
        },
        {
          productId: 'product-1',
          warehouseId: 'warehouse-2',
          remainingQty: decimal('3'),
          unitCostBase: decimal('5'),
          receivedAt: new Date('2025-01-01T00:00:00.000Z'),
        },
      ],
    },
    stockMovement: {
      findMany: async () => [
        {
          id: 'sale-wh1',
          productId: 'product-1',
          fromWarehouseId: 'warehouse-1',
          qty: decimal('1'),
          totalValueBase: decimal('5'),
          createdAt: new Date('2026-05-15T00:00:00.000Z'),
          product: product(),
        },
      ],
    },
  })

  const report = await getDeadStockReport(
    { asOf: '2026-06-15', thresholdDays: 90 },
    {
      paginate: false,
      deps: { client, now: () => new Date('2026-06-16T00:00:00.000Z') },
    },
  )

  assert.deepEqual(report.rows.map((row) => [row.productId, row.warehouseCode]), [
    ['product-1', 'WH2'],
  ])
})

test('dead stock supports thresholds beyond the default lookback and paginates rows', async () => {
  const client = makeClient({
    stockLevel: {
      findMany: async () => [
        {
          productId: 'old-1',
          warehouseId: 'warehouse-1',
          quantity: decimal('1'),
          product: product({ id: 'old-1', sku: 'OLD-1' }),
          warehouse,
        },
        {
          productId: 'old-2',
          warehouseId: 'warehouse-1',
          quantity: decimal('1'),
          product: product({ id: 'old-2', sku: 'OLD-2' }),
          warehouse,
        },
      ],
    },
    costLayer: {
      findMany: async () => [
        {
          productId: 'old-1',
          warehouseId: 'warehouse-1',
          remainingQty: decimal('1'),
          unitCostBase: decimal('1'),
          receivedAt: new Date('2024-01-01T00:00:00.000Z'),
        },
        {
          productId: 'old-2',
          warehouseId: 'warehouse-1',
          remainingQty: decimal('1'),
          unitCostBase: decimal('2'),
          receivedAt: new Date('2024-01-01T00:00:00.000Z'),
        },
      ],
    },
    stockMovement: { findMany: async () => [] },
  })

  const report = await getDeadStockReport(
    { asOf: '2026-06-01', thresholdDays: 730, page: 1, pageSize: 50 },
    {
      deps: { client, now: () => new Date('2026-06-02T00:00:00.000Z') },
    },
  )

  assert.equal(report.thresholdDays, 730)
  assert.equal(report.velocityWindowDateFrom, '2024-06-02')
  assert.equal(report.pageInfo.pageSize, 50)
  assert.equal(report.pageInfo.totalRows, 2)
})

test('dead stock handles empty stocked positions without querying cost-layer valuation', async () => {
  let costLayerCalls = 0
  const client = makeClient({
    stockLevel: { findMany: async () => [] },
    costLayer: {
      findMany: async () => {
        costLayerCalls += 1
        return []
      },
    },
    stockMovement: { findMany: async () => [] },
  })

  const report = await getDeadStockReport(
    { asOf: '2026-06-01' },
    {
      paginate: false,
      deps: { client, now: () => new Date('2026-06-02T00:00:00.000Z') },
    },
  )

  assert.equal(report.rows.length, 0)
  assert.equal(costLayerCalls, 0)
})

test('dead stock report caps cost-layer and sale-movement source scans', async () => {
  const baseLevel = {
    productId: 'product-1',
    warehouseId: 'warehouse-1',
    quantity: decimal('1'),
    product: product(),
    warehouse,
  }

  await assert.rejects(
    () => getDeadStockReport(
      { asOf: '2026-06-01' },
      {
        paginate: false,
        deps: {
          client: makeClient({
            stockLevel: { findMany: async () => [baseLevel] },
            costLayer: {
              findMany: async (args?: unknown) => Array.from({ length: Number((args as { take?: number }).take) }, (_, index) => ({
                productId: 'product-1',
                warehouseId: 'warehouse-1',
                remainingQty: decimal(index === 0 ? '1' : '0'),
                unitCostBase: decimal('1'),
                receivedAt: new Date('2026-01-01T00:00:00.000Z'),
              })),
            },
          }),
          now: () => new Date('2026-06-02T00:00:00.000Z'),
        },
      },
    ),
    /cost-layer valuation and first-stocked scan exceeds 100,000 rows/,
  )

  await assert.rejects(
    () => getDeadStockReport(
      { asOf: '2026-06-01' },
      {
        paginate: false,
        deps: {
          client: makeClient({
            stockLevel: { findMany: async () => [baseLevel] },
            costLayer: {
              findMany: async () => [{
                productId: 'product-1',
                warehouseId: 'warehouse-1',
                remainingQty: decimal('1'),
                unitCostBase: decimal('1'),
                receivedAt: new Date('2026-01-01T00:00:00.000Z'),
              }],
            },
            stockMovement: {
              findMany: async (args?: unknown) => Array.from({ length: Number((args as { take?: number }).take) }, (_, index) => ({
                id: `sale-${index}`,
                productId: 'product-1',
                fromWarehouseId: 'warehouse-1',
                qty: decimal('1'),
                totalValueBase: decimal('1'),
                createdAt: new Date('2026-05-01T00:00:00.000Z'),
                product: product(),
              })),
            },
          }),
          now: () => new Date('2026-06-02T00:00:00.000Z'),
        },
      },
    ),
    /sale-dispatch movement scan exceeds 100,000 rows/,
  )
})
