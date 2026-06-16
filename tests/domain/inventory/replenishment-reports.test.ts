import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Prisma, ProductType } from '@/app/generated/prisma/client'
import {
  getBackorderDemandReport,
  getComponentShortageReport,
  getReorderReport,
  type ReplenishmentReportClient,
} from '@/lib/domain/inventory/replenishment-reports'
import { SourceScanTooLargeError } from '@/lib/security/source-scan-error'

function decimal(value: string | number): Prisma.Decimal {
  return new Prisma.Decimal(value)
}

function unusedClient(): ReplenishmentReportClient {
  const unused = { findMany: async () => [] }
  return {
    product: unused,
    stockLevel: unused,
    stockMovement: unused,
    purchaseOrderLine: unused,
    purchaseReceipt: unused,
    salesOrderLine: unused,
    orderAllocation: unused,
    shipmentLine: unused,
    productionOrder: unused,
    bomItem: unused,
  }
}

const category = { id: 'category-1', name: 'Finished goods' }
const supplier = { name: 'Supplier A' }

test('reorder report throws a typed source-scan error at the source row cap', async () => {
  const client: ReplenishmentReportClient = {
    ...unusedClient(),
    product: {
      findMany: async () => Array.from({ length: 50001 }, (_, index) => ({ id: `product-${index}` })),
    },
  }

  await assert.rejects(
    getReorderReport({}, { deps: { client, now: () => new Date('2026-06-30T00:00:00.000Z') } }),
    (error: unknown) => error instanceof SourceScanTooLargeError && /Replenishment product source rows exceed 50,000/.test(error.message),
  )
})

test('reorder report nets available and inbound open PO against lead-time demand', async () => {
  const client: ReplenishmentReportClient = {
    ...unusedClient(),
    product: {
      findMany: async () => [{
        id: 'product-1',
        sku: 'SKU-1',
        name: 'Widget',
        type: ProductType.SIMPLE,
        stockUnit: 'pcs',
        reorderPoint: null,
        reorderQty: decimal('12'),
        safetyStockQty: decimal('5'),
        category,
        preferredSupplier: null,
        supplierProducts: [{
          supplierId: 'supplier-1',
          supplierSku: 'SUP-SKU-1',
          lastUnitCost: decimal('2'),
          leadTimeDays: 10,
          supplier,
        }],
      }],
    },
    stockLevel: {
      findMany: async () => [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: decimal('4'), reservedQty: decimal('1'), warehouse: { code: 'WH1', name: 'Main Warehouse' } }],
    },
    stockMovement: {
      findMany: async () => [{
        productId: 'product-1',
        qty: decimal('90'),
        totalValueBase: decimal('180'),
        createdAt: new Date('2026-06-01T12:00:00.000Z'),
        product: { sku: 'SKU-1', name: 'Widget', category, supplierProducts: [{ supplier }] },
      }],
    },
    purchaseOrderLine: {
      findMany: async () => [{
        productId: 'product-1',
        qty: decimal('10'),
        qtyReceived: decimal('4'),
        qtyReturned: decimal('0'),
        po: { supplierId: 'supplier-1', expectedDelivery: new Date('2026-06-10T00:00:00.000Z'), destinationWarehouseId: 'warehouse-1', supplier },
      }],
    },
  }

  const report = await getReorderReport(
    { thresholdDays: 90 },
    { deps: { client, now: () => new Date('2026-06-01T18:00:00.000Z') } },
  )

  assert.equal(report.rows.length, 1)
  assert.equal(report.rows[0]?.averageDailyDemand, '1')
  assert.equal(report.rows[0]?.availableQty, '3')
  assert.equal(report.rows[0]?.warehouseAvailabilityBreakdown, 'Main Warehouse: 3') // warehouse name, not the id
  assert.equal(report.rows[0]?.inboundOpenPoQty, '6')
  assert.equal(report.rows[0]?.reorderPoint, '15')
  // Order-up-to: reorderPoint 15 + 8 weeks cover (1/day × 56) = 71 order-up-to level;
  // minus projected available 9 = 62 (above the configured 12 reorder qty min).
  assert.equal(report.rows[0]?.suggestedReorderQty, '62')
  assert.equal(report.rows[0]?.leadTimeDays, 10)
  assert.equal(report.rows[0]?.urgency, 'reorder')
})

test('reorder report orders up to N weeks of supply, not just to the reorder point', async () => {
  // SIMPLE product, no configured reorderQty/safety, lead time 10, available 0.
  // 90 units over a 90-day window → 1 unit/day. reorderPoint = 1×10 = 10.
  const makeClient = (): ReplenishmentReportClient => ({
    ...unusedClient(),
    product: {
      findMany: async () => [{
        id: 'product-1', sku: 'SKU-1', name: 'Widget', type: ProductType.SIMPLE, stockUnit: 'pcs',
        reorderPoint: null, reorderQty: null, safetyStockQty: decimal('0'), category,
        preferredSupplier: null,
        supplierProducts: [{ supplierId: 'supplier-1', supplierSku: 'S', lastUnitCost: decimal('2'), leadTimeDays: 10, supplier }],
      }],
    },
    stockLevel: { findMany: async () => [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: decimal('0'), reservedQty: decimal('0') }] },
    stockMovement: {
      findMany: async () => [{
        productId: 'product-1', qty: decimal('90'), totalValueBase: decimal('0'),
        createdAt: new Date('2026-05-15T00:00:00.000Z'),
        product: { sku: 'SKU-1', name: 'Widget', category, supplierProducts: [{ supplier }] },
      }],
    },
  })

  // Default 8 weeks: order-up-to = 10 + (1/day × 8 × 7 = 56) = 66; minus 0 available = 66.
  const def = await getReorderReport({ thresholdDays: 90 }, { deps: { client: makeClient(), now: () => new Date('2026-06-01T18:00:00.000Z') } })
  assert.equal(def.rows[0]?.reorderPoint, '10')
  assert.equal(def.rows[0]?.suggestedReorderQty, '66')

  // Configurable: 4 weeks → order-up-to = 10 + (1 × 28) = 38.
  const four = await getReorderReport({ thresholdDays: 90, targetCoverWeeks: 4 }, { deps: { client: makeClient(), now: () => new Date('2026-06-01T18:00:00.000Z') } })
  assert.equal(four.rows[0]?.suggestedReorderQty, '38')

  // Upper bound: an absurd weeks value is clamped to 52, not honoured literally.
  const huge = await getReorderReport({ thresholdDays: 90, targetCoverWeeks: 99999 }, { deps: { client: makeClient(), now: () => new Date('2026-06-01T18:00:00.000Z') } })
  assert.equal(huge.rows[0]?.suggestedReorderQty, String(10 + 52 * 7)) // 10 + 364 = 374
})

test('order-up-to edge cases: zero-demand degrades to top-up, backorder widens, at-point holds', async () => {
  const productRow = (over: Record<string, unknown>) => ({
    id: 'product-1', sku: 'SKU-1', name: 'Widget', type: ProductType.SIMPLE, stockUnit: 'pcs',
    reorderPoint: decimal('10'), reorderQty: null, safetyStockQty: decimal('0'), category,
    preferredSupplier: null,
    supplierProducts: [{ supplierId: 'supplier-1', supplierSku: 'S', lastUnitCost: decimal('2'), leadTimeDays: 7, supplier }],
    ...over,
  })
  const clientWith = (qtyOnHand: string): ReplenishmentReportClient => ({
    ...unusedClient(),
    product: { findMany: async () => [productRow({})] },
    stockLevel: { findMany: async () => [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: decimal(qtyOnHand), reservedQty: decimal('0') }] },
    // No stockMovement mock → zero velocity → targetCoverQty 0 → degrades to top-up.
  })
  const at = () => new Date('2026-06-01T18:00:00.000Z')

  // Zero demand, available 3, reorderPoint 10 → plain top-up gap 7 (no weeks cover added).
  const degrade = await getReorderReport({}, { deps: { client: clientWith('3'), now: at } })
  assert.equal(degrade.rows[0]?.suggestedReorderQty, '7')

  // Backorder: available -5 → order-up-to gap = 10 − (−5) = 15 (negative handled).
  const backorder = await getReorderReport({}, { deps: { client: clientWith('-5'), now: at } })
  assert.equal(backorder.rows[0]?.suggestedReorderQty, '15')
  assert.equal(backorder.rows[0]?.urgency, 'critical')

  // Exactly at the reorder point → no order (0 suggested). Excluded from the default
  // view (only products needing ≥1), but shown with the show-all toggle (includeZero).
  const atPointDefault = await getReorderReport({}, { deps: { client: clientWith('10'), now: at } })
  assert.equal(atPointDefault.rows.length, 0)
  const atPointAll = await getReorderReport({ includeZero: true }, { deps: { client: clientWith('10'), now: at } })
  assert.equal(atPointAll.rows[0]?.suggestedReorderQty, '0')
  assert.equal(atPointAll.rows[0]?.urgency, 'reorder')
})

test('reorder report: default view excludes zero-reorder; show-all + sort by qty desc', async () => {
  // Three products with no velocity (targetCoverQty 0): top-up = reorderPoint − available.
  // A needs 9, B needs 1, C is fully stocked (0). Default view shows A,B (sorted desc);
  // includeZero shows all three.
  const products = [
    { id: 'a', sku: 'SKU-A', reorderPoint: '10', qty: '1' }, // needs 9
    { id: 'b', sku: 'SKU-B', reorderPoint: '10', qty: '9' }, // needs 1
    { id: 'c', sku: 'SKU-C', reorderPoint: '10', qty: '50' }, // needs 0
  ]
  const makeClient = (): ReplenishmentReportClient => ({
    ...unusedClient(),
    product: {
      findMany: async () => products.map((p) => ({
        id: p.id, sku: p.sku, name: p.sku, type: ProductType.SIMPLE, stockUnit: 'pcs',
        reorderPoint: decimal(p.reorderPoint), reorderQty: null, safetyStockQty: decimal('0'), category,
        preferredSupplier: null,
        supplierProducts: [{ supplierId: 'supplier-1', supplierSku: 'S', lastUnitCost: decimal('1'), leadTimeDays: 7, supplier }],
      })),
    },
    stockLevel: { findMany: async () => products.map((p) => ({ productId: p.id, warehouseId: 'warehouse-1', quantity: decimal(p.qty), reservedQty: decimal('0') })) },
  })
  const at = () => new Date('2026-06-01T18:00:00.000Z')

  const def = await getReorderReport({}, { deps: { client: makeClient(), now: at } })
  assert.deepEqual(def.rows.map((r) => r.sku), ['SKU-A', 'SKU-B']) // zero-reorder C excluded, sorted qty desc
  assert.deepEqual(def.rows.map((r) => r.suggestedReorderQty), ['9', '1'])

  const all = await getReorderReport({ includeZero: true }, { deps: { client: makeClient(), now: at } })
  assert.deepEqual(all.rows.map((r) => r.sku), ['SKU-A', 'SKU-B', 'SKU-C']) // C included with 0
  assert.equal(all.rows[2]?.suggestedReorderQty, '0')
})

test('reorder report renders quantities as integers (suggested rounds up)', async () => {
  // 21 units / 90 days = 0.2333/day; lead time 14. reorderPoint 3.2667 → 3 (nearest),
  // order-up-to 3.2667 + 0.2333×56 = 16.333 → suggested 17 (rounded UP).
  const client: ReplenishmentReportClient = {
    ...unusedClient(),
    product: {
      findMany: async () => [{
        id: 'product-1', sku: 'SKU-1', name: 'Widget', type: ProductType.SIMPLE, stockUnit: 'pcs',
        reorderPoint: null, reorderQty: null, safetyStockQty: decimal('0'), category,
        preferredSupplier: null,
        supplierProducts: [{ supplierId: 'supplier-1', supplierSku: 'S', lastUnitCost: decimal('2'), leadTimeDays: 14, supplier }],
      }],
    },
    stockLevel: { findMany: async () => [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: decimal('0'), reservedQty: decimal('0') }] },
    stockMovement: {
      findMany: async () => [{
        productId: 'product-1', qty: decimal('21'), totalValueBase: decimal('0'),
        createdAt: new Date('2026-05-15T00:00:00.000Z'),
        product: { sku: 'SKU-1', name: 'Widget', category, supplierProducts: [{ supplier }] },
      }],
    },
  }
  const report = await getReorderReport({ thresholdDays: 90 }, { deps: { client, now: () => new Date('2026-06-01T18:00:00.000Z') } })
  assert.equal(report.rows[0]?.reorderPoint, '3')        // 3.2667 → nearest integer
  assert.equal(report.rows[0]?.suggestedReorderQty, '17') // 16.333 → rounded up
  assert.ok(!report.rows[0]?.suggestedReorderQty.includes('.'), 'suggested is an integer string')
})

test('reorder sort ties break by urgency then SKU at equal suggested quantity', async () => {
  // All three need exactly 10 (no velocity → suggested = reorderPoint − available):
  // X critical (avail 0), Y/Z reorder (avail 5). Order: X, then Y, Z by SKU.
  const products = [
    { id: 'z', sku: 'SKU-Z', reorderPoint: '15', qty: '5' },
    { id: 'x', sku: 'SKU-X', reorderPoint: '10', qty: '0' },
    { id: 'y', sku: 'SKU-Y', reorderPoint: '15', qty: '5' },
  ]
  const client: ReplenishmentReportClient = {
    ...unusedClient(),
    product: {
      findMany: async () => products.map((p) => ({
        id: p.id, sku: p.sku, name: p.sku, type: ProductType.SIMPLE, stockUnit: 'pcs',
        reorderPoint: decimal(p.reorderPoint), reorderQty: null, safetyStockQty: decimal('0'), category,
        preferredSupplier: null,
        supplierProducts: [{ supplierId: 'supplier-1', supplierSku: 'S', lastUnitCost: decimal('1'), leadTimeDays: 7, supplier }],
      })),
    },
    stockLevel: { findMany: async () => products.map((p) => ({ productId: p.id, warehouseId: 'warehouse-1', quantity: decimal(p.qty), reservedQty: decimal('0') })) },
  }
  const report = await getReorderReport({}, { deps: { client, now: () => new Date('2026-06-01T18:00:00.000Z') } })
  assert.deepEqual(report.rows.map((r) => r.suggestedReorderQty), ['10', '10', '10'])
  assert.deepEqual(report.rows.map((r) => r.sku), ['SKU-X', 'SKU-Y', 'SKU-Z'])
})

test('reorder totals are the sum of the displayed rounded rows', async () => {
  // Two rows with available 2.5 each: each rounds to 3 (half-up), so the footer is
  // 6, NOT round(5.0)=5 — proving totals sum the displayed integers.
  const products = [{ id: 'a', sku: 'SKU-A' }, { id: 'b', sku: 'SKU-B' }]
  const client: ReplenishmentReportClient = {
    ...unusedClient(),
    product: {
      findMany: async () => products.map((p) => ({
        id: p.id, sku: p.sku, name: p.sku, type: ProductType.SIMPLE, stockUnit: 'pcs',
        reorderPoint: decimal('10'), reorderQty: null, safetyStockQty: decimal('0'), category,
        preferredSupplier: null,
        supplierProducts: [{ supplierId: 'supplier-1', supplierSku: 'S', lastUnitCost: decimal('1'), leadTimeDays: 7, supplier }],
      })),
    },
    stockLevel: { findMany: async () => products.map((p) => ({ productId: p.id, warehouseId: 'warehouse-1', quantity: decimal('2.5'), reservedQty: decimal('0') })) },
  }
  const report = await getReorderReport({}, { deps: { client, now: () => new Date('2026-06-01T18:00:00.000Z') } })
  assert.deepEqual(report.rows.map((r) => r.availableQty), ['3', '3']) // 2.5 → 3 each
  assert.equal(report.totals.availableQty, '6')                        // sum of rounded, not round(5.0)=5
  assert.equal(report.totals.suggestedReorderQty, '16')               // (10−2.5)=7.5 → ceil 8, ×2
})

test('reorder report propagates the BOM parent order-up-to quantity into component demand', async () => {
  // Oak table (BOM) has sales velocity; oak board (component, 2 per table) does not.
  // Parent: reorderPoint 5 (configured), 8wk cover at 1/day = 56 → order-up-to 61.
  // Component demand = 61 × 2 = 122; the component (no velocity) adds no cover of its own.
  const client: ReplenishmentReportClient = {
    ...unusedClient(),
    product: {
      findMany: async () => [
        {
          id: 'raw-oak', sku: 'RAW-OAK', name: 'Oak board', type: ProductType.SIMPLE, stockUnit: 'each',
          reorderPoint: decimal(0), reorderQty: decimal(0), safetyStockQty: decimal(0), category,
          preferredSupplierId: null, preferredSupplier: null,
          supplierProducts: [{ supplierId: 'sup-timber', supplierSku: 'OAK-1', lastUnitCost: decimal(5), leadTimeDays: 7, supplier: { name: 'Timber Co' } }],
        },
        {
          id: 'bom-table', sku: 'BOM-TABLE', name: 'Oak table', type: ProductType.BOM, stockUnit: 'each',
          reorderPoint: decimal(5), reorderQty: null, safetyStockQty: decimal(0), category,
          preferredSupplierId: null, preferredSupplier: null, supplierProducts: [],
        },
      ],
    },
    stockLevel: { findMany: async () => [
      { productId: 'raw-oak', warehouseId: 'warehouse-1', quantity: decimal('0'), reservedQty: decimal('0') },
      { productId: 'bom-table', warehouseId: 'warehouse-1', quantity: decimal('0'), reservedQty: decimal('0') },
    ] },
    stockMovement: { findMany: async () => [{
      productId: 'bom-table', qty: decimal('90'), totalValueBase: decimal('0'),
      createdAt: new Date('2026-05-15T00:00:00.000Z'),
      product: { sku: 'BOM-TABLE', name: 'Oak table', category, supplierProducts: [] },
    }] },
    bomItem: { findMany: async () => [{ parentProductId: 'bom-table', componentProductId: 'raw-oak', qty: decimal(2) }] },
  }
  const report = await getReorderReport({ thresholdDays: 90 }, { deps: { client, now: () => new Date('2026-06-01T18:00:00.000Z') } })
  assert.equal(report.rows.find((r) => r.sku === 'BOM-TABLE')?.suggestedReorderQty, '61')
  assert.equal(report.rows.find((r) => r.sku === 'RAW-OAK')?.suggestedReorderQty, '122')
})

test('reorder report prefers the preferred supplier catalog row before stale supplier catalog rows', async () => {
  const supplierA = { name: 'Supplier A' }
  const supplierB = { name: 'Supplier B' }
  const client: ReplenishmentReportClient = {
    ...unusedClient(),
    product: {
      findMany: async () => [
        {
          id: 'product-1',
          sku: 'SKU-1',
          name: 'Preferred catalog',
          type: ProductType.SIMPLE,
          stockUnit: 'pcs',
          reorderPoint: decimal('10'),
          reorderQty: decimal('2'),
          safetyStockQty: decimal('0'),
          category,
          preferredSupplierId: 'supplier-b',
          preferredSupplier: { id: 'supplier-b', name: 'Supplier B' },
          supplierProducts: [
            { supplierId: 'supplier-a', supplierSku: 'A-SKU', lastUnitCost: decimal('1'), leadTimeDays: 30, supplier: supplierA },
            { supplierId: 'supplier-b', supplierSku: 'B-SKU', lastUnitCost: decimal('2'), leadTimeDays: 5, supplier: supplierB },
          ],
        },
        {
          id: 'product-2',
          sku: 'SKU-2',
          name: 'Catalog fallback',
          type: ProductType.SIMPLE,
          stockUnit: 'pcs',
          reorderPoint: decimal('10'),
          reorderQty: decimal('2'),
          safetyStockQty: decimal('0'),
          category,
          preferredSupplierId: null,
          preferredSupplier: null,
          supplierProducts: [
            { supplierId: 'supplier-a', supplierSku: 'A2-SKU', lastUnitCost: decimal('1'), leadTimeDays: 8, supplier: supplierA },
          ],
        },
        {
          id: 'product-3',
          sku: 'SKU-3',
          name: 'Preferred fallback',
          type: ProductType.SIMPLE,
          stockUnit: 'pcs',
          reorderPoint: decimal('10'),
          reorderQty: decimal('2'),
          safetyStockQty: decimal('0'),
          category,
          preferredSupplierId: 'supplier-b',
          preferredSupplier: { id: 'supplier-b', name: 'Supplier B' },
          supplierProducts: [],
        },
      ],
    },
    stockLevel: {
      findMany: async () => [
        { productId: 'product-1', warehouseId: 'warehouse-1', quantity: decimal('0'), reservedQty: decimal('0') },
        { productId: 'product-2', warehouseId: 'warehouse-1', quantity: decimal('0'), reservedQty: decimal('0') },
        { productId: 'product-3', warehouseId: 'warehouse-1', quantity: decimal('0'), reservedQty: decimal('0') },
      ],
    },
  }

  const report = await getReorderReport({}, { deps: { client, now: () => new Date('2026-06-01T00:00:00.000Z') } })

  assert.deepEqual(report.rows.map((row) => ({
    sku: row.sku,
    supplierId: row.supplierId,
    supplierName: row.supplierName,
    supplierSku: row.supplierSku,
    leadTimeDays: row.leadTimeDays,
  })), [
    { sku: 'SKU-1', supplierId: 'supplier-b', supplierName: 'Supplier B', supplierSku: 'B-SKU', leadTimeDays: 5 },
    { sku: 'SKU-2', supplierId: 'supplier-a', supplierName: 'Supplier A', supplierSku: 'A2-SKU', leadTimeDays: 8 },
    { sku: 'SKU-3', supplierId: 'supplier-b', supplierName: 'Supplier B', supplierSku: null, leadTimeDays: 14 },
  ])
})

test('reorder report supplier filter includes preferred suppliers and catalog-only suppliers', async () => {
  const client: ReplenishmentReportClient = {
    ...unusedClient(),
    product: {
      findMany: async (args?: unknown) => {
        const where = (args as { where: { OR: unknown[] } }).where
        assert.deepEqual(where.OR, [
          { preferredSupplierId: 'supplier-1' },
          { supplierProducts: { some: { supplierId: 'supplier-1' } } },
        ])
        return []
      },
    },
  }

  const report = await getReorderReport(
    { supplierId: 'supplier-1' },
    { deps: { client, now: () => new Date('2026-06-01T00:00:00.000Z') } },
  )

  assert.equal(report.rows.length, 0)
})

test('reorder report ignores non-stock product type filters', async () => {
  const client: ReplenishmentReportClient = {
    ...unusedClient(),
    product: {
      findMany: async (args?: unknown) => {
        const where = (args as { where: { type: { in: ProductType[] } } }).where
        assert.deepEqual(where.type.in, [
          ProductType.SIMPLE,
          ProductType.VARIANT,
          ProductType.KIT,
          ProductType.BOM,
        ])
        return []
      },
    },
  }

  const report = await getReorderReport(
    { productType: ProductType.NON_INVENTORY },
    { deps: { client, now: () => new Date('2026-06-01T18:00:00.000Z') } },
  )

  assert.equal(report.rows.length, 0)
})

test('reorder report treats configured reorderQty zero as opt-out', async () => {
  const client: ReplenishmentReportClient = {
    ...unusedClient(),
    product: {
      findMany: async () => [{
        id: 'product-1',
        sku: 'SKU-1',
        name: 'Widget',
        type: ProductType.SIMPLE,
        stockUnit: 'pcs',
        reorderPoint: decimal('10'),
        reorderQty: decimal('0'),
        safetyStockQty: decimal('0'),
        category,
        preferredSupplier: null,
        supplierProducts: [],
      }],
    },
    stockLevel: {
      findMany: async () => [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: decimal('0'), reservedQty: decimal('0') }],
    },
  }

  const report = await getReorderReport({}, { deps: { client, now: () => new Date('2026-06-01T00:00:00.000Z') } })

  assert.equal(report.rows.length, 0)
})

test('reorder report suppresses critical urgency when inbound covers a zero-stock SKU', async () => {
  const client: ReplenishmentReportClient = {
    ...unusedClient(),
    product: {
      findMany: async () => [{
        id: 'product-1',
        sku: 'SKU-1',
        name: 'Widget',
        type: ProductType.SIMPLE,
        stockUnit: 'pcs',
        reorderPoint: decimal('10'),
        reorderQty: decimal('12'),
        safetyStockQty: decimal('0'),
        category,
        preferredSupplier: null,
        supplierProducts: [],
      }],
    },
    stockLevel: {
      findMany: async () => [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: decimal('0'), reservedQty: decimal('0') }],
    },
    purchaseOrderLine: {
      findMany: async () => [{
        productId: 'product-1',
        qty: decimal('100'),
        qtyReceived: decimal('0'),
        qtyReturned: decimal('0'),
        po: { supplierId: 'supplier-1', expectedDelivery: null, destinationWarehouseId: 'warehouse-1', supplier },
      }],
    },
  }

  const report = await getReorderReport({}, { deps: { client, now: () => new Date('2026-06-01T00:00:00.000Z') } })

  assert.equal(report.rows.length, 0)
  assert.match(report.notices.join(' '), /projected available stock/)
})

test('reorder report falls back to observed supplier-product P95 lead time when configured lead time is absent', async () => {
  const client: ReplenishmentReportClient = {
    ...unusedClient(),
    product: {
      findMany: async () => [{
        id: 'product-1',
        sku: 'SKU-1',
        name: 'Widget',
        type: ProductType.SIMPLE,
        stockUnit: 'pcs',
        reorderPoint: null,
        reorderQty: null,
        safetyStockQty: decimal('0'),
        category,
        preferredSupplier: null,
        supplierProducts: [{
          supplierId: 'supplier-1',
          supplierSku: 'SUP-SKU-1',
          lastUnitCost: decimal('2'),
          leadTimeDays: null,
          supplier,
        }],
      }],
    },
    stockLevel: {
      findMany: async () => [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: decimal('0'), reservedQty: decimal('0') }],
    },
    stockMovement: {
      findMany: async () => [{
        productId: 'product-1',
        qty: decimal('90'),
        totalValueBase: decimal('180'),
        createdAt: new Date('2026-06-01T12:00:00.000Z'),
        product: { sku: 'SKU-1', name: 'Widget', category, supplierProducts: [{ supplier }] },
      }],
    },
    purchaseReceipt: {
      findMany: async () => [
        {
          id: 'receipt-1',
          receivedAt: new Date('2026-05-11T00:00:00.000Z'),
          po: { id: 'po-1', reference: 'PO-1', supplierId: 'supplier-1', expectedDelivery: null, poSentAt: new Date('2026-05-01T00:00:00.000Z'), createdAt: new Date('2026-05-01T00:00:00.000Z'), supplier },
          lines: [{ poLineId: 'line-1', qtyReceived: decimal('1'), poLine: { qty: decimal('1'), productId: 'product-1', product: { sku: 'SKU-1', name: 'Widget', category } } }],
        },
        {
          id: 'receipt-2',
          receivedAt: new Date('2026-05-21T00:00:00.000Z'),
          po: { id: 'po-2', reference: 'PO-2', supplierId: 'supplier-1', expectedDelivery: null, poSentAt: new Date('2026-05-01T00:00:00.000Z'), createdAt: new Date('2026-05-01T00:00:00.000Z'), supplier },
          lines: [{ poLineId: 'line-2', qtyReceived: decimal('1'), poLine: { qty: decimal('1'), productId: 'product-1', product: { sku: 'SKU-1', name: 'Widget', category } } }],
        },
      ],
    },
  }

  const report = await getReorderReport(
    { thresholdDays: 90 },
    { deps: { client, now: () => new Date('2026-06-01T18:00:00.000Z') } },
  )

  assert.equal(report.rows[0]?.leadTimeDays, 20)
  assert.equal(report.rows[0]?.reorderPoint, '20')
})

test('reorder report surfaces default lead-time fallback; no-movement product defaults to ABC class C', async () => {
  const client: ReplenishmentReportClient = {
    ...unusedClient(),
    product: {
      findMany: async (args?: unknown) => {
        const supplierProducts = (args as { select: { supplierProducts: { orderBy: unknown } } }).select.supplierProducts
        assert.deepEqual(supplierProducts.orderBy, [{ lastUnitCost: 'asc' }, { updatedAt: 'desc' }])
        return [{
          id: 'product-1',
          sku: 'SKU-1',
          name: 'Widget',
          type: ProductType.SIMPLE,
          stockUnit: 'pcs',
          reorderPoint: decimal('1'),
          reorderQty: null,
          safetyStockQty: decimal('0'),
          category,
          preferredSupplier: null,
          supplierProducts: [],
        }]
      },
    },
    stockLevel: {
      findMany: async () => [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: decimal('0'), reservedQty: decimal('0') }],
    },
  }

  const report = await getReorderReport({}, { deps: { client, now: () => new Date('2026-06-01T00:00:00.000Z') } })

  // No demand-window movement → product is absent from the ranked map, so it
  // takes the default class C.
  assert.equal(report.rows[0]?.abcClass, 'C')
  assert.equal(report.rows[0]?.leadTimeDays, 14)
  assert.match(report.notices.join(' '), /Default 14-day lead time/)
  assert.match(report.notices.join(' '), /ABC class is computed by demand volume/)
})

test('reorder report computes ABC class by demand volume (Pareto 80/95 on units)', async () => {
  // Classification uses the cumulative share of the SKUs ranked ABOVE each one.
  // A=800, B=150, C=49, D=1 (total 1000) → share-before = 0% / 80% / 95% / 99.9%.
  const movements = [
    { id: 'a', qty: '800' },
    { id: 'b', qty: '150' },
    { id: 'c', qty: '49' },
    { id: 'd', qty: '1' },
  ]
  const client: ReplenishmentReportClient = {
    ...unusedClient(),
    product: {
      findMany: async () => movements.map((m) => ({
        id: m.id,
        sku: `SKU-${m.id.toUpperCase()}`,
        name: `Product ${m.id}`,
        type: ProductType.SIMPLE,
        stockUnit: 'pcs',
        reorderPoint: decimal('100000'), // force every product into the report
        reorderQty: decimal('1'),
        safetyStockQty: decimal('0'),
        category,
        preferredSupplier: null,
        supplierProducts: [{ supplierId: 'supplier-1', supplierSku: 'S', lastUnitCost: decimal('1'), leadTimeDays: 7, supplier }],
      })),
    },
    stockLevel: {
      findMany: async () => movements.map((m) => ({ productId: m.id, warehouseId: 'warehouse-1', quantity: decimal('0'), reservedQty: decimal('0') })),
    },
    stockMovement: {
      findMany: async () => movements.map((m) => ({
        productId: m.id,
        qty: decimal(m.qty),
        totalValueBase: decimal('0'), // imports carry zero value — volume basis must still classify
        createdAt: new Date('2026-05-15T00:00:00.000Z'),
        product: { sku: `SKU-${m.id.toUpperCase()}`, name: `Product ${m.id}`, category, supplierProducts: [{ supplier }] },
      })),
    },
  }

  const report = await getReorderReport({ thresholdDays: 90 }, { deps: { client, now: () => new Date('2026-06-01T00:00:00.000Z') } })
  const abcBySku = new Map(report.rows.map((row) => [row.sku, row.abcClass]))
  assert.equal(abcBySku.get('SKU-A'), 'A') // share-before 0%   → A
  assert.equal(abcBySku.get('SKU-B'), 'B') // share-before 80%  → B
  assert.equal(abcBySku.get('SKU-C'), 'C') // share-before 95%  → C
  assert.equal(abcBySku.get('SKU-D'), 'C') // share-before 99.9% → C
})

test('reorder report: a single dominant mover is class A, not pushed to C by its own volume', async () => {
  // Regression for the share-after bug: ranking by cumulative share INCLUDING the
  // SKU would put the 960-unit product at 96% → C. It must be A.
  const movements = [
    { id: 'big', qty: '960' },
    { id: 'small', qty: '40' },
  ]
  const client: ReplenishmentReportClient = {
    ...unusedClient(),
    product: {
      findMany: async () => movements.map((m) => ({
        id: m.id,
        sku: `SKU-${m.id.toUpperCase()}`,
        name: `Product ${m.id}`,
        type: ProductType.SIMPLE,
        stockUnit: 'pcs',
        reorderPoint: decimal('100000'),
        reorderQty: decimal('1'),
        safetyStockQty: decimal('0'),
        category,
        preferredSupplier: null,
        supplierProducts: [{ supplierId: 'supplier-1', supplierSku: 'S', lastUnitCost: decimal('1'), leadTimeDays: 7, supplier }],
      })),
    },
    stockLevel: {
      findMany: async () => movements.map((m) => ({ productId: m.id, warehouseId: 'warehouse-1', quantity: decimal('0'), reservedQty: decimal('0') })),
    },
    stockMovement: {
      findMany: async () => movements.map((m) => ({
        productId: m.id,
        qty: decimal(m.qty),
        totalValueBase: decimal('0'),
        createdAt: new Date('2026-05-15T00:00:00.000Z'),
        product: { sku: `SKU-${m.id.toUpperCase()}`, name: `Product ${m.id}`, category, supplierProducts: [{ supplier }] },
      })),
    },
  }

  const report = await getReorderReport({ thresholdDays: 90 }, { deps: { client, now: () => new Date('2026-06-01T00:00:00.000Z') } })
  const abcBySku = new Map(report.rows.map((row) => [row.sku, row.abcClass]))
  assert.equal(abcBySku.get('SKU-BIG'), 'A')   // share-before 0%  → A
  assert.equal(abcBySku.get('SKU-SMALL'), 'C') // share-before 96% → C
})

test('reorder report caps velocity source rows', async () => {
  const client: ReplenishmentReportClient = {
    ...unusedClient(),
    product: { findMany: async () => [] },
    stockMovement: {
      findMany: async () => Array.from({ length: 50001 }, (_, index) => ({
        productId: `product-${index}`,
        qty: decimal('1'),
        totalValueBase: decimal('1'),
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
        product: { sku: `SKU-${index}`, name: 'Widget', category, supplierProducts: [] },
      })),
    },
  }

  await assert.rejects(
    () => getReorderReport({}, { deps: { client, now: () => new Date('2026-06-01T00:00:00.000Z') } }),
    /source rows exceed 50,000/,
  )
})

test('backorder report aggregates active sales demand not covered by committed shipments and allocations', async () => {
  const client: ReplenishmentReportClient = {
    ...unusedClient(),
    salesOrderLine: {
      findMany: async () => [
        {
          id: 'line-1',
          orderId: 'order-1',
          productId: 'product-1',
          sku: 'SKU-1',
          description: 'Widget',
          qty: decimal('10'),
          order: { orderNumber: 'SO-1', createdAt: new Date('2026-05-01T00:00:00.000Z'), expectedDelivery: null, status: 'PROCESSING' },
          product: { id: 'product-1', sku: 'SKU-1', name: 'Widget', type: ProductType.SIMPLE, stockUnit: 'pcs', category, supplierProducts: [{ supplier }] },
        },
        {
          id: 'line-2',
          orderId: 'order-2',
          productId: 'product-1',
          sku: 'SKU-1',
          description: 'Widget',
          qty: decimal('3'),
          order: { orderNumber: 'SO-2', createdAt: new Date('2026-05-03T00:00:00.000Z'), expectedDelivery: null, status: 'ALLOCATED' },
          product: { id: 'product-1', sku: 'SKU-1', name: 'Widget', type: ProductType.SIMPLE, stockUnit: 'pcs', category, supplierProducts: [{ supplier }] },
        },
      ],
    },
    orderAllocation: {
      findMany: async (args?: unknown) => {
        assert.deepEqual((args as { where: { lineId: { in: string[] } } }).where.lineId.in.sort(), ['line-1', 'line-2'])
        return [{ lineId: 'line-1', qty: decimal('4') }]
      },
    },
    shipmentLine: {
      findMany: async () => [{ lineId: 'line-1', qty: decimal('2'), shipment: { status: 'PACKED' } }],
    },
    purchaseOrderLine: {
      findMany: async () => [{
        productId: 'product-1',
        qty: decimal('20'),
        qtyReceived: decimal('5'),
        qtyReturned: decimal('0'),
        po: { supplierId: 'supplier-1', expectedDelivery: new Date('2026-05-20T00:00:00.000Z'), destinationWarehouseId: null, supplier },
      }],
    },
  }

  const report = await getBackorderDemandReport({}, { deps: { client, now: () => new Date('2026-06-01T00:00:00.000Z') } })

  assert.equal(report.rows.length, 1)
  assert.equal(report.rows[0]?.orderCount, 2)
  assert.equal(report.rows[0]?.orderedQty, '13')
  assert.equal(report.rows[0]?.committedQty, '2')
  assert.equal(report.rows[0]?.allocatedQty, '2')
  assert.equal(report.rows[0]?.backorderQty, '9')
  assert.equal(report.rows[0]?.inboundOpenPoQty, '15')
  assert.equal(report.rows[0]?.projectedFillDate, '2026-05-20')
  assert.match(report.notices.join(' '), /Unassigned inbound POs/)
})

test('component shortage report includes draft and in-progress production demand', async () => {
  const client: ReplenishmentReportClient = {
    ...unusedClient(),
    productionOrder: {
      findMany: async () => [
        {
          id: 'prod-1',
          reference: 'MO-1',
          status: 'DRAFT',
          warehouseId: 'warehouse-1',
          qtyPlanned: decimal('10'),
          qtyProduced: decimal('2'),
          scheduledAt: new Date('2026-06-15T00:00:00.000Z'),
          outputProduct: { sku: 'BOM-1', name: 'Assembly' },
          warehouse: { code: 'WH1', name: 'Main warehouse' },
          bom: {
            items: [{
              componentProductId: 'component-1',
              qty: decimal('2'),
              component: { id: 'component-1', sku: 'COMP-1', name: 'Component', type: ProductType.SIMPLE, stockUnit: 'pcs', category, supplierProducts: [{ supplier }] },
            }],
          },
        },
        {
          id: 'prod-2',
          reference: 'MO-2',
          status: 'IN_PROGRESS',
          warehouseId: 'warehouse-1',
          qtyPlanned: decimal('3'),
          qtyProduced: decimal('0'),
          scheduledAt: new Date('2026-06-10T00:00:00.000Z'),
          outputProduct: { sku: 'BOM-2', name: 'Second assembly' },
          warehouse: { code: 'WH1', name: 'Main warehouse' },
          bom: {
            items: [{
              componentProductId: 'component-1',
              qty: decimal('1'),
              component: { id: 'component-1', sku: 'COMP-1', name: 'Component', type: ProductType.SIMPLE, stockUnit: 'pcs', category, supplierProducts: [{ supplier }] },
            }],
          },
        },
      ],
    },
    stockLevel: {
      findMany: async () => [{ productId: 'component-1', warehouseId: 'warehouse-1', quantity: decimal('8'), reservedQty: decimal('1') }],
    },
    purchaseOrderLine: {
      findMany: async () => [{
        productId: 'component-1',
        qty: decimal('4'),
        qtyReceived: decimal('1'),
        qtyReturned: decimal('0'),
        po: { supplierId: 'supplier-1', expectedDelivery: null, destinationWarehouseId: 'warehouse-1', supplier },
      }],
    },
  }

  const report = await getComponentShortageReport({}, { deps: { client, now: () => new Date('2026-06-01T00:00:00.000Z') } })

  assert.equal(report.rows.length, 1)
  assert.equal(report.rows[0]?.productionOrderCount, 2)
  assert.equal(report.rows[0]?.requiredQty, '19')
  assert.equal(report.rows[0]?.availableQty, '7')
  assert.equal(report.rows[0]?.inboundOpenPoQty, '3')
  assert.equal(report.rows[0]?.shortageQty, '9')
  assert.deepEqual(report.rows[0]?.outputProducts, ['BOM-1 Assembly', 'BOM-2 Second assembly'])
  assert.equal(report.rows[0]?.earliestScheduledAt?.slice(0, 10), '2026-06-10')
  assert.match(report.notices.join(' '), /without a destination warehouse/)
})

test('reorder report labels BOM products with the latest production order manufacturer', async () => {
  const client: ReplenishmentReportClient = {
    ...unusedClient(),
    product: {
      findMany: async () => [
        {
          id: 'bom-product',
          sku: 'BOM-TABLE',
          name: 'Oak table',
          type: ProductType.BOM,
          stockUnit: 'each',
          reorderPoint: decimal(5),
          reorderQty: decimal(8),
          safetyStockQty: decimal(0),
          category,
          preferredSupplierId: null,
          preferredSupplier: null,
          supplierProducts: [],
        },
      ],
    },
    productionOrder: {
      findMany: async () => [
        {
          outputProductId: 'bom-product',
          warehouseId: 'wh-main',
          manufacturerId: 'sup-co-pack',
          manufacturer: { name: 'Co-Pack Co' },
          outputProduct: { type: ProductType.BOM },
          createdAt: new Date('2026-03-01T00:00:00.000Z'),
        },
      ],
    },
  }
  const report = await getReorderReport({}, { deps: { client, now: () => new Date('2026-06-30T00:00:00.000Z') } })
  assert.equal(report.rows.length, 1)
  assert.equal(report.rows[0]?.supplierName, 'Manufactured by Co-Pack Co')
  assert.equal(report.rows[0]?.supplierId, null)
})

test('reorder report falls back to "Manufactured in-house" when no manufacturer is set', async () => {
  const client: ReplenishmentReportClient = {
    ...unusedClient(),
    product: {
      findMany: async () => [
        {
          id: 'bom-product',
          sku: 'BOM-CHAIR',
          name: 'Oak chair',
          type: ProductType.BOM,
          stockUnit: 'each',
          reorderPoint: decimal(5),
          reorderQty: decimal(8),
          safetyStockQty: decimal(0),
          category,
          preferredSupplierId: null,
          preferredSupplier: null,
          supplierProducts: [],
        },
      ],
    },
    productionOrder: {
      findMany: async () => [
        {
          outputProductId: 'bom-product',
          warehouseId: 'wh-main',
          manufacturerId: null,
          manufacturer: null,
          outputProduct: { type: ProductType.BOM },
          createdAt: new Date('2026-03-01T00:00:00.000Z'),
        },
      ],
    },
  }
  const report = await getReorderReport({}, { deps: { client, now: () => new Date('2026-06-30T00:00:00.000Z') } })
  assert.equal(report.rows[0]?.supplierName, 'Manufactured in-house')
})

test('reorder report folds BOM component demand into the component reorder math', async () => {
  // Oak board (RAW) is a component of Oak table (BOM). The BOM needs 8 units
  // produced (gap = 5 reorder point - 0 available - 0 inbound, max with
  // configured reorderQty 8). Each BOM unit consumes 2 oak boards. So the
  // raw material picks up 16 units of extra demand on top of its own gap.
  const client: ReplenishmentReportClient = {
    ...unusedClient(),
    product: {
      findMany: async () => [
        {
          id: 'raw-oak',
          sku: 'RAW-OAK',
          name: 'Oak board',
          type: ProductType.SIMPLE,
          stockUnit: 'each',
          reorderPoint: decimal(0),
          reorderQty: decimal(0),
          safetyStockQty: decimal(0),
          category,
          preferredSupplierId: null,
          preferredSupplier: null,
          supplierProducts: [
            { supplierId: 'sup-timber', supplierSku: 'OAK-1', lastUnitCost: decimal(5), leadTimeDays: 7, supplier: { name: 'Timber Co' } },
          ],
        },
        {
          id: 'bom-table',
          sku: 'BOM-TABLE',
          name: 'Oak table',
          type: ProductType.BOM,
          stockUnit: 'each',
          reorderPoint: decimal(5),
          reorderQty: decimal(8),
          safetyStockQty: decimal(0),
          category,
          preferredSupplierId: null,
          preferredSupplier: null,
          supplierProducts: [],
        },
      ],
    },
    bomItem: {
      findMany: async () => [
        { parentProductId: 'bom-table', componentProductId: 'raw-oak', qty: decimal(2) },
      ],
    },
  }
  const report = await getReorderReport({}, { deps: { client, now: () => new Date('2026-06-30T00:00:00.000Z') } })
  const rawRow = report.rows.find((r) => r.sku === 'RAW-OAK')
  assert.ok(rawRow, 'raw material row present')
  assert.equal(rawRow?.reorderPoint, '16')
  assert.equal(rawRow?.suggestedReorderQty, '16')
  assert.deepEqual(rawRow?.neededFor, ['BOM BOM-TABLE'])
})

test('reorder report aggregates raw-material demand across multiple parent BOMs', async () => {
  const client: ReplenishmentReportClient = {
    ...unusedClient(),
    product: {
      findMany: async () => [
        {
          id: 'raw-oak',
          sku: 'RAW-OAK',
          name: 'Oak board',
          type: ProductType.SIMPLE,
          stockUnit: 'each',
          reorderPoint: decimal(0),
          reorderQty: decimal(0),
          safetyStockQty: decimal(0),
          category,
          preferredSupplierId: null,
          preferredSupplier: null,
          supplierProducts: [
            { supplierId: 'sup-timber', supplierSku: 'OAK-1', lastUnitCost: decimal(5), leadTimeDays: 7, supplier: { name: 'Timber Co' } },
          ],
        },
        {
          id: 'bom-table',
          sku: 'BOM-TABLE',
          name: 'Oak table',
          type: ProductType.BOM,
          stockUnit: 'each',
          reorderPoint: decimal(5),
          reorderQty: decimal(5),
          safetyStockQty: decimal(0),
          category,
          preferredSupplierId: null,
          preferredSupplier: null,
          supplierProducts: [],
        },
        {
          id: 'bom-shelf',
          sku: 'BOM-SHELF',
          name: 'Oak shelf',
          type: ProductType.BOM,
          stockUnit: 'each',
          reorderPoint: decimal(4),
          reorderQty: decimal(4),
          safetyStockQty: decimal(0),
          category,
          preferredSupplierId: null,
          preferredSupplier: null,
          supplierProducts: [],
        },
      ],
    },
    bomItem: {
      findMany: async () => [
        { parentProductId: 'bom-table', componentProductId: 'raw-oak', qty: decimal(2) },
        { parentProductId: 'bom-shelf', componentProductId: 'raw-oak', qty: decimal(1) },
      ],
    },
  }
  const report = await getReorderReport({}, { deps: { client, now: () => new Date('2026-06-30T00:00:00.000Z') } })
  const rawRow = report.rows.find((r) => r.sku === 'RAW-OAK')
  // 5 tables × 2 oak + 4 shelves × 1 oak = 14 extra units of demand.
  assert.equal(rawRow?.suggestedReorderQty, '14')
  assert.deepEqual(rawRow?.neededFor, ['BOM BOM-SHELF', 'BOM BOM-TABLE'])
})
