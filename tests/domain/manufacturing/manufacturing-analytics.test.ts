import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getProductionVarianceReport,
  getWipReport,
  ManufacturingAnalyticsSourceLimitError,
  type ManufacturingAnalyticsClient,
} from '@/lib/domain/manufacturing/manufacturing-analytics'

function manufacturingClient(input: {
  orders: unknown[]
  movements: unknown[]
  costLayers?: unknown[]
  productionOrderArgs?: unknown[]
  stockMovementArgs?: unknown[]
  costLayerArgs?: unknown[]
}): ManufacturingAnalyticsClient {
  return {
    productionOrder: {
      async findMany(args?: unknown) {
        input.productionOrderArgs?.push(args)
        return input.orders
      },
    },
    stockMovement: {
      async findMany(args?: unknown) {
        input.stockMovementArgs?.push(args)
        return input.movements
      },
    },
    costLayer: {
      async findMany(args?: unknown) {
        input.costLayerArgs?.push(args)
        return input.costLayers ?? []
      },
    },
  }
}

function assemblyOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'po-1',
    reference: 'MO-001',
    orderType: 'ASSEMBLY',
    status: 'COMPLETED',
    qtyPlanned: '10',
    qtyProduced: '8',
    scheduledAt: new Date('2026-05-02T00:00:00Z'),
    startedAt: new Date('2026-05-03T00:00:00Z'),
    completedAt: new Date('2026-05-04T00:00:00Z'),
    createdAt: new Date('2026-05-01T00:00:00Z'),
    warehouseId: 'wh-main',
    outputProductId: 'fg-1',
    componentSnapshot: null,
    outputProduct: {
      sku: 'FG-1',
      name: 'Finished good',
      productComponents: [
        { componentId: 'component-a', qty: '2' },
        { componentId: 'component-b', qty: '1' },
      ],
    },
    warehouse: { code: 'MAIN', name: 'Main warehouse' },
    bom: {
      items: [
        {
          componentProductId: 'component-a',
          qty: '2',
          component: { id: 'component-a', sku: 'COMP-A', name: 'Component A', stockUnit: 'pcs' },
        },
        {
          componentProductId: 'component-b',
          qty: '1',
          component: { id: 'component-b', sku: 'COMP-B', name: 'Component B', stockUnit: 'pcs' },
        },
      ],
    },
    ...overrides,
  }
}

test('production variance compares BOM planned quantities with PRODUCTION_OUT consumption', async () => {
  const productionOrderArgs: unknown[] = []
  const stockMovementArgs: unknown[] = []
  const report = await getProductionVarianceReport(
    { dateFrom: '2026-05-01', dateTo: '2026-05-31' },
    {},
    {
      client: manufacturingClient({
        orders: [assemblyOrder()],
        movements: [
          { referenceId: 'po-1', productId: 'component-a', qty: '22', totalValueBase: '110' },
          { referenceId: 'po-1', productId: 'component-b', qty: '7', totalValueBase: '35' },
        ],
        productionOrderArgs,
        stockMovementArgs,
      }),
      now: () => new Date('2026-06-01T00:00:00Z'),
    },
  )

  assert.equal(report.rows.length, 2)
  const componentA = report.rows.find((row) => row.componentSku === 'COMP-A')
  const componentB = report.rows.find((row) => row.componentSku === 'COMP-B')
  assert.ok(componentA)
  assert.ok(componentB)
  assert.equal(componentA.plannedQty, '20')
  assert.equal(componentA.actualQty, '22')
  assert.equal(componentA.varianceQty, '2')
  assert.equal(componentA.variancePct, '10')
  assert.equal(componentA.overConsumedQty, '2')
  assert.equal(componentA.overConsumedValueBase, '10')
  assert.equal(componentA.orderYieldPct, '80')
  assert.equal(componentA.productionOrderHref, '/manufacturing/po-1')
  assert.equal(componentB.plannedQty, '10')
  assert.equal(componentB.actualQty, '7')
  assert.equal(componentB.varianceQty, '-3')
  assert.equal(componentB.variancePct, '-30')
  assert.equal(componentB.overConsumedQty, '0')
  assert.equal(report.totals.plannedQty, '30')
  assert.equal(report.totals.actualQty, '29')
  assert.equal(report.totals.varianceQty, '-1')
  assert.equal(report.totals.overConsumedQty, '2')
  assert.equal(report.totals.overConsumedValueBase, '10')
  assert.deepEqual(
    productionOrderArgs[0],
    {
      where: {
        orderType: 'ASSEMBLY',
        status: { in: ['IN_PROGRESS', 'COMPLETED'] },
        completedAt: {
          gte: new Date('2026-05-01T00:00:00Z'),
          lt: new Date('2026-06-01T00:00:00Z'),
        },
      },
      orderBy: [{ completedAt: 'desc' }, { reference: 'asc' }],
      take: 50001,
      select: {
        id: true,
        reference: true,
        orderType: true,
        status: true,
        qtyPlanned: true,
        qtyProduced: true,
        scheduledAt: true,
        startedAt: true,
        completedAt: true,
        createdAt: true,
        outputProduct: { select: { sku: true, name: true } },
        warehouse: { select: { code: true, name: true } },
        bom: {
          select: {
            items: {
              orderBy: { sortOrder: 'asc' },
              select: {
                componentProductId: true,
                qty: true,
                component: { select: { id: true, sku: true, name: true, stockUnit: true } },
              },
            },
          },
        },
      },
    },
  )
  assert.deepEqual(stockMovementArgs[0], {
    where: {
      type: 'PRODUCTION_OUT',
      referenceType: 'ProductionOrder',
      referenceId: { in: ['po-1'] },
    },
    take: 50001,
    select: {
      referenceId: true,
      productId: true,
      qty: true,
      totalValueBase: true,
    },
  })
})

test('WIP value includes consumed component value and ManufacturingCostLine totals', async () => {
  const productionOrderArgs: unknown[] = []
  const report = await getWipReport(
    {},
    {},
    {
      client: manufacturingClient({
        orders: [
          assemblyOrder({
            id: 'po-wip',
            reference: 'MO-WIP',
            status: 'IN_PROGRESS',
            qtyPlanned: '12',
            qtyProduced: '3',
            startedAt: new Date('2026-05-29T00:00:00Z'),
            manufacturingCostLines: [
              { amountBase: '12.34' },
              { amountBase: '0.66' },
            ],
          }),
        ],
        movements: [
          { referenceId: 'po-wip', productId: 'component-a', qty: '4', totalValueBase: '20' },
          { referenceId: 'po-wip', productId: 'component-b', qty: '2', totalValueBase: '10' },
        ],
        productionOrderArgs,
      }),
      now: () => new Date('2026-06-03T00:00:00Z'),
    },
  )

  assert.equal(report.rows.length, 1)
  assert.deepEqual(productionOrderArgs[0], {
    where: { status: 'IN_PROGRESS' },
    orderBy: [{ startedAt: 'asc' }, { createdAt: 'asc' }, { reference: 'asc' }],
    take: 50001,
    select: {
      id: true,
      reference: true,
      orderType: true,
      status: true,
      qtyPlanned: true,
      qtyProduced: true,
      scheduledAt: true,
      startedAt: true,
      completedAt: true,
      createdAt: true,
      warehouseId: true,
      outputProductId: true,
      componentSnapshot: true,
      outputProduct: { select: { sku: true, name: true, productComponents: { select: { componentId: true, qty: true } } } },
      warehouse: { select: { code: true, name: true } },
      manufacturingCostLines: { select: { amountBase: true } },
    },
  })
  assert.equal(report.rows[0].wipValueBase, '43')
  assert.equal(report.rows[0].manufacturingCostBase, '13')
  assert.equal(report.rows[0].consumedComponentValueBase, '30')
  assert.equal(report.rows[0].expectedOutputValueBase, '43')
  assert.equal(report.rows[0].remainingOutputQty, '9')
  assert.equal(report.rows[0].daysSinceStart, '5')
  assert.equal(report.totals.wipValueBase, '43')
  assert.equal(report.totals.consumedComponentValueBase, '30')
  assert.equal(report.totals.expectedOutputValueBase, '43')
})

test('WIP values reserved not-yet-consumed components at weighted-average current cost (scjz.31)', async () => {
  const costLayerArgs: unknown[] = []
  const report = await getWipReport(
    {},
    {},
    {
      client: manufacturingClient({
        orders: [
          assemblyOrder({
            id: 'po-wip',
            reference: 'MO-WIP',
            status: 'IN_PROGRESS',
            qtyPlanned: '10',
            qtyProduced: '0',
            startedAt: new Date('2026-05-29T00:00:00Z'),
            manufacturingCostLines: [{ amountBase: '50' }],
          }),
        ],
        // component-b partially consumed (4 of the 10 required); component-a not yet started.
        movements: [
          { referenceId: 'po-wip', productId: 'component-b', qty: '4', totalValueBase: '12' },
        ],
        // component-a weighted-average cost = (10*4 + 10*6)/20 = 5; component-b = 3.
        costLayers: [
          { productId: 'component-a', warehouseId: 'wh-main', remainingQty: '10', unitCostBase: '4' },
          { productId: 'component-a', warehouseId: 'wh-main', remainingQty: '10', unitCostBase: '6' },
          { productId: 'component-b', warehouseId: 'wh-main', remainingQty: '50', unitCostBase: '3' },
        ],
        costLayerArgs,
      }),
      now: () => new Date('2026-06-03T00:00:00Z'),
    },
  )

  assert.equal(report.rows.length, 1)
  // Reserved = component-a (20 req - 0 consumed) * 5 + component-b (10 req - 4 consumed) * 3
  //          = 100 + 18 = 118
  assert.equal(report.rows[0].reservedComponentValueBase, '118')
  assert.equal(report.rows[0].consumedComponentValueBase, '12')
  assert.equal(report.rows[0].manufacturingCostBase, '50')
  // WIP = manufacturing 50 + consumed 12 + reserved 118 = 180
  assert.equal(report.rows[0].wipValueBase, '180')
  assert.equal(report.rows[0].expectedOutputValueBase, '180')
  assert.equal(report.totals.reservedComponentValueBase, '118')
  assert.equal(report.totals.wipValueBase, '180')
  // Cost layers fetched in a single batched query scoped to the BOM components.
  assert.equal(costLayerArgs.length, 1)
  assert.deepEqual((costLayerArgs[0] as { where: unknown }).where, {
    remainingQty: { gt: 0 },
    OR: [
      { productId: 'component-a', warehouseId: 'wh-main' },
      { productId: 'component-b', warehouseId: 'wh-main' },
    ],
  })
})

test('WIP reservation walks layers FIFO, not weighted-average (scjz.31)', async () => {
  const report = await getWipReport(
    {},
    {},
    {
      client: manufacturingClient({
        orders: [
          assemblyOrder({
            id: 'po-fifo',
            status: 'IN_PROGRESS',
            qtyPlanned: '1',
            qtyProduced: '0',
            manufacturingCostLines: [],
            // one component, 1 per unit -> reserve 1 unit
            outputProduct: { sku: 'FG-1', name: 'Finished good', productComponents: [{ componentId: 'component-a', qty: '1' }] },
          }),
        ],
        movements: [],
        // oldest layer is cheap; weighted-average would be ~50.5, FIFO is 1.
        costLayers: [
          { productId: 'component-a', warehouseId: 'wh-main', remainingQty: '10', unitCostBase: '1' },
          { productId: 'component-a', warehouseId: 'wh-main', remainingQty: '10', unitCostBase: '100' },
        ],
      }),
      now: () => new Date('2026-06-03T00:00:00Z'),
    },
  )

  assert.equal(report.rows[0].reservedComponentValueBase, '1')
  assert.equal(report.rows[0].wipValueBase, '1')
})

test('WIP reservation uses the frozen componentSnapshot over the live BOM (scjz.31)', async () => {
  const costLayerArgs: unknown[] = []
  const report = await getWipReport(
    {},
    {},
    {
      client: manufacturingClient({
        orders: [
          assemblyOrder({
            id: 'po-snap',
            status: 'IN_PROGRESS',
            qtyPlanned: '2',
            qtyProduced: '0',
            manufacturingCostLines: [],
            // live components say component-a, but the order was started against component-c.
            outputProduct: { sku: 'FG-1', name: 'Finished good', productComponents: [{ componentId: 'component-a', qty: '5' }] },
            componentSnapshot: [{ componentId: 'component-c', qty: 3 }],
          }),
        ],
        movements: [],
        costLayers: [
          { productId: 'component-c', warehouseId: 'wh-main', remainingQty: '100', unitCostBase: '4' },
        ],
        costLayerArgs,
      }),
      now: () => new Date('2026-06-03T00:00:00Z'),
    },
  )

  // Snapshot: 3 per unit * 2 planned = 6 units @ 4 = 24 (component-a is ignored).
  assert.equal(report.rows[0].reservedComponentValueBase, '24')
  assert.deepEqual((costLayerArgs[0] as { where: { OR: unknown } }).where.OR, [{ productId: 'component-c', warehouseId: 'wh-main' }])
})

test('WIP values an in-progress disassembly from the output product, not its BOM (scjz.31)', async () => {
  const costLayerArgs: unknown[] = []
  const report = await getWipReport(
    {},
    {},
    {
      client: manufacturingClient({
        orders: [
          assemblyOrder({
            id: 'po-disasm',
            orderType: 'DISASSEMBLY',
            status: 'IN_PROGRESS',
            qtyPlanned: '3',
            qtyProduced: '0',
            outputProductId: 'fg-disasm',
            manufacturingCostLines: [],
            // BOM components are recovered at completion, not reserved -> must be ignored.
            bom: { items: [{ componentProductId: 'component-a', qty: '5', component: { id: 'component-a', sku: 'COMP-A', name: 'A', stockUnit: 'pcs' } }] },
          }),
        ],
        movements: [],
        costLayers: [
          { productId: 'fg-disasm', warehouseId: 'wh-main', remainingQty: '50', unitCostBase: '7' },
          // a component layer that must NOT be drawn on
          { productId: 'component-a', warehouseId: 'wh-main', remainingQty: '50', unitCostBase: '999' },
        ],
        costLayerArgs,
      }),
      now: () => new Date('2026-06-03T00:00:00Z'),
    },
  )

  // 3 output units reserved @ 7 = 21; BOM component layer untouched.
  assert.equal(report.rows[0].reservedComponentValueBase, '21')
  assert.deepEqual((costLayerArgs[0] as { where: { OR: unknown } }).where.OR, [{ productId: 'fg-disasm', warehouseId: 'wh-main' }])
})

test('WIP depletes shared FIFO layers across in-progress orders (scjz.31)', async () => {
  const report = await getWipReport(
    {},
    {},
    {
      client: manufacturingClient({
        // Two orders, each reserving 10 of component-a in wh-main, started in order.
        orders: [
          assemblyOrder({
            id: 'po-early',
            reference: 'MO-EARLY',
            status: 'IN_PROGRESS',
            qtyPlanned: '10',
            qtyProduced: '0',
            startedAt: new Date('2026-05-01T00:00:00Z'),
            manufacturingCostLines: [],
            outputProduct: { sku: 'FG-1', name: 'Finished good', productComponents: [{ componentId: 'component-a', qty: '1' }] },
          }),
          assemblyOrder({
            id: 'po-late',
            reference: 'MO-LATE',
            status: 'IN_PROGRESS',
            qtyPlanned: '10',
            qtyProduced: '0',
            startedAt: new Date('2026-05-02T00:00:00Z'),
            manufacturingCostLines: [],
            outputProduct: { sku: 'FG-1', name: 'Finished good', productComponents: [{ componentId: 'component-a', qty: '1' }] },
          }),
        ],
        movements: [],
        costLayers: [
          { productId: 'component-a', warehouseId: 'wh-main', remainingQty: '10', unitCostBase: '1' },
          { productId: 'component-a', warehouseId: 'wh-main', remainingQty: '10', unitCostBase: '100' },
        ],
      }),
      now: () => new Date('2026-06-03T00:00:00Z'),
    },
  )

  const early = report.rows.find((row) => row.productionOrderReference === 'MO-EARLY')
  const late = report.rows.find((row) => row.productionOrderReference === 'MO-LATE')
  // Earliest-started order takes the cheap layer; the later one takes the next.
  assert.equal(early?.reservedComponentValueBase, '10')
  assert.equal(late?.reservedComponentValueBase, '1000')
  assert.equal(report.totals.reservedComponentValueBase, '1010')
})

test('production variance scopes by completedAt and consumption-capable statuses', async () => {
  const productionOrderArgs: unknown[] = []
  const stockMovementArgs: unknown[] = []
  const report = await getProductionVarianceReport(
    { dateFrom: '2026-03-01', dateTo: '2026-03-31' },
    {},
    {
      client: manufacturingClient({
        orders: [
          assemblyOrder({
            id: 'po-completed',
            reference: 'MO-COMP',
            createdAt: new Date('2026-01-15T00:00:00Z'),
            completedAt: new Date('2026-03-05T00:00:00Z'),
          }),
          assemblyOrder({
            id: 'po-draft',
            reference: 'MO-DRAFT',
            status: 'DRAFT',
            completedAt: null,
          }),
        ],
        movements: [
          { referenceId: 'po-completed', productId: 'component-a', qty: '20', totalValueBase: '100' },
          { referenceId: 'po-completed', productId: 'component-b', qty: '10', totalValueBase: '50' },
          { referenceId: 'po-draft', productId: 'component-a', qty: '0', totalValueBase: '0' },
        ],
        productionOrderArgs,
        stockMovementArgs,
      }),
      now: () => new Date('2026-04-01T00:00:00Z'),
    },
  )

  assert.equal(report.rows.length, 2)
  assert.equal(report.rows.every((row) => row.productionOrderId === 'po-completed'), true)
  assert.deepEqual((productionOrderArgs[0] as { where: unknown }).where, {
    orderType: 'ASSEMBLY',
    status: { in: ['IN_PROGRESS', 'COMPLETED'] },
    completedAt: {
      gte: new Date('2026-03-01T00:00:00Z'),
      lt: new Date('2026-04-01T00:00:00Z'),
    },
  })
  assert.deepEqual((stockMovementArgs[0] as { where: { referenceId: { in: string[] } } }).where.referenceId.in, ['po-completed'])
})

test('WIP report remains current-state and ignores date filters', async () => {
  const productionOrderArgs: unknown[] = []
  const report = await getWipReport(
    { dateFrom: '2026-05-01', dateTo: '2026-05-31' },
    {},
    {
      client: manufacturingClient({
        orders: [
          assemblyOrder({
            id: 'po-long-running',
            reference: 'MO-LONG',
            status: 'IN_PROGRESS',
            createdAt: new Date('2025-12-01T00:00:00Z'),
            startedAt: new Date('2025-12-02T00:00:00Z'),
            manufacturingCostLines: [{ amountBase: '5' }],
          }),
        ],
        movements: [],
        productionOrderArgs,
      }),
      now: () => new Date('2026-06-03T12:00:00Z'),
    },
  )

  assert.equal(report.rows.length, 1)
  assert.equal(report.rows[0].productionOrderId, 'po-long-running')
  assert.deepEqual((productionOrderArgs[0] as { where: unknown }).where, { status: 'IN_PROGRESS' })
})

test('WIP days since start uses decimal days for intraday work', async () => {
  const report = await getWipReport(
    {},
    {},
    {
      client: manufacturingClient({
        orders: [
          assemblyOrder({
            id: 'po-fast',
            reference: 'MO-FAST',
            status: 'IN_PROGRESS',
            createdAt: new Date('2026-06-03T13:00:00Z'),
            startedAt: new Date('2026-06-03T14:00:00Z'),
            manufacturingCostLines: [],
          }),
        ],
        movements: [],
      }),
      now: () => new Date('2026-06-03T16:00:00Z'),
    },
  )

  assert.equal(report.rows[0].daysSinceStart, '0.1')
})

test('production variance handles no BOM items and no consumption movements explicitly', async () => {
  const noBomReport = await getProductionVarianceReport(
    {},
    {},
    {
      client: manufacturingClient({
        orders: [assemblyOrder({ bom: { items: [] } })],
        movements: [],
      }),
      now: () => new Date('2026-06-01T00:00:00Z'),
    },
  )
  assert.equal(noBomReport.rows.length, 0)
  assert.equal(noBomReport.totals.plannedQty, '0')

  const noConsumptionReport = await getProductionVarianceReport(
    {},
    {},
    {
      client: manufacturingClient({
        orders: [assemblyOrder()],
        movements: [],
      }),
      now: () => new Date('2026-06-01T00:00:00Z'),
    },
  )
  assert.equal(noConsumptionReport.rows.length, 2)
  assert.equal(noConsumptionReport.rows[0].actualQty, '0')
  assert.equal(noConsumptionReport.rows[0].outcome, 'under_consumed')
  assert.equal(noConsumptionReport.rows[0].overConsumedQty, '0')
})

test('source-row caps surface as typed actionable errors', async () => {
  await assert.rejects(
    () => getProductionVarianceReport(
      {},
      {},
      {
        client: manufacturingClient({
          orders: Array.from({ length: 50001 }, (_, index) => assemblyOrder({ id: `po-${index}`, reference: `MO-${index}` })),
          movements: [],
        }),
        now: () => new Date('2026-06-01T00:00:00Z'),
      },
    ),
    (error) => error instanceof ManufacturingAnalyticsSourceLimitError &&
      error.message === 'Production variance source rows exceed 50,000; narrow the filters and retry.',
  )
})

test('manufacturing analytics pagination can be disabled for CSV exports', async () => {
  const report = await getProductionVarianceReport(
    { pageSize: 50 },
    { paginate: false },
    {
      client: manufacturingClient({
        orders: [assemblyOrder()],
        movements: [],
      }),
      now: () => new Date('2026-06-01T00:00:00Z'),
    },
  )

  assert.equal(report.rows.length, 2)
  assert.equal(report.pageInfo.page, 1)
  assert.equal(report.pageInfo.totalPages, 1)
  assert.equal(report.pageInfo.hasNextPage, false)
  assert.equal(report.pageInfo.hasPreviousPage, false)
})
