import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Prisma, ProductType } from '@/app/generated/prisma/client'
import {
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
