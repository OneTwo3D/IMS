import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getProductionVarianceReport,
  getWipReport,
  type ManufacturingAnalyticsClient,
} from '@/lib/domain/manufacturing/manufacturing-analytics'

function manufacturingClient(input: {
  orders: unknown[]
  movements: unknown[]
  productionOrderArgs?: unknown[]
  stockMovementArgs?: unknown[]
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
    outputProduct: { sku: 'FG-1', name: 'Finished good' },
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
  assert.equal(componentA.scrapQty, '2')
  assert.equal(componentA.scrapValueBase, '10')
  assert.equal(componentA.yieldPct, '80')
  assert.equal(componentA.productionOrderHref, '/manufacturing/po-1')
  assert.equal(componentB.plannedQty, '10')
  assert.equal(componentB.actualQty, '7')
  assert.equal(componentB.varianceQty, '-3')
  assert.equal(componentB.variancePct, '-30')
  assert.equal(componentB.scrapQty, '0')
  assert.equal(report.totals.plannedQty, '30')
  assert.equal(report.totals.actualQty, '29')
  assert.equal(report.totals.varianceQty, '-1')
  assert.equal(report.totals.scrapQty, '2')
  assert.equal(report.totals.scrapValueBase, '10')
  assert.deepEqual(
    productionOrderArgs[0],
    {
      where: {
        orderType: 'ASSEMBLY',
        createdAt: {
          gte: new Date('2026-05-01T00:00:00Z'),
          lte: new Date('2026-05-31T23:59:59.999Z'),
        },
      },
      orderBy: [{ createdAt: 'desc' }, { reference: 'asc' }],
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

test('WIP value is the ManufacturingCostLine base total for in-progress production orders', async () => {
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
      outputProduct: { select: { sku: true, name: true } },
      warehouse: { select: { code: true, name: true } },
      manufacturingCostLines: { select: { amountBase: true } },
    },
  })
  assert.equal(report.rows[0].wipValueBase, '13')
  assert.equal(report.rows[0].manufacturingCostBase, '13')
  assert.equal(report.rows[0].consumedComponentValueBase, '30')
  assert.equal(report.rows[0].expectedOutputValueBase, '43')
  assert.equal(report.rows[0].remainingOutputQty, '9')
  assert.equal(report.rows[0].daysSinceStart, 5)
  assert.equal(report.totals.wipValueBase, '13')
  assert.equal(report.totals.consumedComponentValueBase, '30')
  assert.equal(report.totals.expectedOutputValueBase, '43')
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
