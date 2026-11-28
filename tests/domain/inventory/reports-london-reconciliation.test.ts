import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { Prisma as PrismaRuntime } from '../../../app/generated/prisma/client.ts'
import { businessDateYmd } from '../../../lib/business-date.ts'

/**
 * The inventory reports window on LONDON business days, so they reconcile across a BST month-end:
 *
 *   opening valuation (as-of D0) + stock received in (D0, D1] - COGS over (D0, D1]  =  closing valuation (as-of D1)
 *
 * The as-of valuation ends each day at London midnight (23:00Z in BST). The ledger, COGS and turnover reports used to window on UTC days, so in BST
 * a movement at 23:30Z fell in a different day for the valuation than for them. The movements below sit at 22:30Z and 23:30Z around both month ends.
 * A GMT month-end is the control: there the London and UTC days coincide, so the same identity holds either way.
 */

type CogsRow = ReturnType<typeof cogsRowFor>
let COGS_ROWS: CogsRow[] = []
let COGS_WHERE: { createdAt?: { gte?: Date; lt?: Date } } | null = null

function inWindow(at: Date, w: { gte?: Date; lt?: Date } | undefined): boolean {
  return (!w?.gte || at >= w.gte) && (!w?.lt || at < w.lt)
}

const cogsFindMany = async (args?: { where?: { createdAt?: { gte?: Date; lt?: Date } } }) => {
  COGS_WHERE = args?.where ?? null
  return COGS_ROWS.filter((r) => inWindow(r.createdAt, args?.where?.createdAt))
}

/** The as-of reader client of the fixture under test: getInventoryValuationReport reads through `db`, so the reader is served from the db mock below. */
let READER: Record<string, unknown> = {}
const STATIC_DB: Record<string, unknown> = {
  cogsEntry: { findMany: cogsFindMany },
  salesOrder: { findMany: async () => [] },
  salesOrderRefundLine: { findMany: async () => [] },
  shipmentLine: { findMany: async () => [] },
  product: { findMany: async () => [PRODUCT] },
  warehouse: { findMany: async () => [WAREHOUSE] },
}

mock.module('@/lib/db', {
  namedExports: {
    db: new Proxy({}, { get: (_t, prop: string) => STATIC_DB[prop] ?? READER[prop] }),
  },
})

const PRODUCT = { id: 'p1', sku: 'SKU-1', name: 'Widget', stockUnit: 'ea', category: null, supplierProducts: [] }
const WAREHOUSE = { id: 'w1', code: 'MAIN', name: 'Main' }

function cogsRowFor(cost: number, at: string) {
  return {
    id: `cogs-${at}`,
    qty: new PrismaRuntime.Decimal(cost),
    totalCostBase: new PrismaRuntime.Decimal(cost),
    createdAt: new Date(at),
    movement: { id: `mv-${at}`, referenceType: null, referenceId: null, fromWarehouseId: 'w1', toWarehouseId: null, product: PRODUCT, fromWarehouse: WAREHOUSE, toWarehouse: null, shipmentLine: null },
  }
}

async function load() {
  const fx = await import('./london-day-fixtures.ts')
  const { Prisma } = await import('../../../app/generated/prisma/client.ts')
  const { getStockMovementLedgerReport } = await import('../../../lib/domain/inventory/inventory-ledger-reports.ts')
  const { getCogsReport, getInventoryTurnoverReport, getInventoryValuationReport } = await import('../../../lib/domain/inventory/inventory-costing-reports.ts')
  return { fx, Prisma, getInventoryValuationReport, getStockMovementLedgerReport, getCogsReport, getInventoryTurnoverReport }
}

type Fixture = { label: string; d0: string; d1: string; moves: Array<{ id: string; kind: 'in' | 'out' | 'open'; qty: number; at: string }>; current: number; backfillTo: string; expect: { val0: string; val1: string; received: string; cogs: string; ledgerMovement: string } }

const FIXTURES: Fixture[] = [
  {
    label: 'BST month-end (30 Jun -> 31 Jul 2026)',
    d0: '2026-06-30',
    d1: '2026-07-31',
    backfillTo: '2026-08-01',
    // London: open + before-end(D0) + 23:30Z (= London 1 Jul, IN the window) + mid-month + 22:30Z 31 Jul (IN) + 23:30Z 31 Jul (= London 1 Aug, OUT).
    moves: [
      { id: 'open', kind: 'open', qty: 10, at: '2026-01-01T00:00:00.000Z' },
      { id: 'pre', kind: 'in', qty: 7, at: '2026-06-30T22:30:00.000Z' },
      { id: 'in-hour', kind: 'in', qty: 100, at: '2026-06-30T23:30:00.000Z' },
      { id: 'mid', kind: 'in', qty: 50, at: '2026-07-15T10:00:00.000Z' },
      { id: 'sale-in', kind: 'out', qty: 20, at: '2026-07-31T22:30:00.000Z' },
      { id: 'sale-out', kind: 'out', qty: 30, at: '2026-07-31T23:30:00.000Z' },
    ],
    current: 117,
    expect: { val0: '17.000000', val1: '147.000000', received: '150', cogs: '20.000000', ledgerMovement: '130.000000' },
  },
  {
    label: 'GMT month-end control (31 Jan -> 28 Feb 2026)',
    d0: '2026-01-31',
    d1: '2026-02-28',
    backfillTo: '2026-03-01',
    // In GMT the London day is the UTC day: both 22:30Z and 23:30Z on 31 Jan are D0, both on 28 Feb are in the window.
    moves: [
      { id: 'open', kind: 'open', qty: 10, at: '2025-12-01T00:00:00.000Z' },
      { id: 'pre', kind: 'in', qty: 7, at: '2026-01-31T22:30:00.000Z' },
      { id: 'late-d0', kind: 'in', qty: 100, at: '2026-01-31T23:30:00.000Z' },
      { id: 'mid', kind: 'in', qty: 50, at: '2026-02-15T10:00:00.000Z' },
      { id: 'sale-a', kind: 'out', qty: 20, at: '2026-02-28T22:30:00.000Z' },
      { id: 'sale-b', kind: 'out', qty: 30, at: '2026-02-28T23:30:00.000Z' },
      { id: 'sale-after', kind: 'out', qty: 5, at: '2026-03-01T00:30:00.000Z' },
    ],
    current: 112,
    expect: { val0: '117.000000', val1: '117.000000', received: '50', cogs: '50.000000', ledgerMovement: '0.000000' },
  },
]

for (const f of FIXTURES) {
  test(`reconciliation identity holds across ${f.label}`, async () => {
    const { fx, Prisma, getInventoryValuationReport, getStockMovementLedgerReport, getCogsReport, getInventoryTurnoverReport } = await load()
    const D = (v: number) => new Prisma.Decimal(v)
    const moves = f.moves.map((m) => ({
      id: m.id,
      type: m.kind === 'open' ? 'OPENING_STOCK' : m.kind === 'in' ? 'PURCHASE_RECEIPT' : 'SALE_DISPATCH',
      productId: 'p1',
      fromWarehouseId: m.kind === 'out' ? 'w1' : null,
      toWarehouseId: m.kind === 'out' ? null : 'w1',
      qty: D(m.qty),
      totalValueBase: D(m.qty),
      createdAt: new Date(m.at),
    })) as never[]
    const store = await fx.backfill(moves, f.current, f.d0, f.backfillTo)
    const reader = fx.readerClient(store, moves, f.current)

    // Valuation from the report operators read (getInventoryValuationReport), served by the real as-of reader over the fixture's backfilled store.
    READER = reader as unknown as Record<string, unknown>
    const val = async (asOf: string) => (await getInventoryValuationReport({ asOf, warehouseId: 'w1', includeZero: true }, { paginate: false })).totals.totalValueBase
    const val0 = D(Number(await val(f.d0)))
    const val1 = D(Number(await val(f.d1)))
    assert.equal(val0.toFixed(6), f.expect.val0)
    assert.equal(val1.toFixed(6), f.expect.val1)

    // Ledger over [d0+1, d1]: its opening is the valuation as-of d0 and its closing the valuation as-of d1.
    const dayAfter = new Date(Date.parse(`${f.d0}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
    const rows = (moves as Array<Row>).map((m) => ({
      ...m, product: PRODUCT, fromWarehouse: m.fromWarehouseId ? WAREHOUSE : null, toWarehouse: m.toWarehouseId ? WAREHOUSE : null,
      unitCostBase: D(1), referenceType: null, referenceId: null, note: null,
    }))
    const ledgerClient = ledgerClientFor(rows, Prisma as unknown as typeof PrismaRuntime)
    const ledger = await getStockMovementLedgerReport({ dateFrom: dayAfter, dateTo: f.d1, includeCost: true }, { client: ledgerClient as never, paginate: false })
    assert.equal(Number(ledger.totals.openingValueBase), Number(val0), 'ledger opening = valuation as-of D0')
    assert.equal(Number(ledger.totals.closingValueBase), Number(val1), 'ledger closing = valuation as-of D1')
    assert.equal(Number(ledger.totals.movementValueBase), Number(f.expect.ledgerMovement))

    // COGS over the same window, from the report itself (and from turnover, which windows COGS identically).
    COGS_ROWS = f.moves.filter((m) => m.kind === 'out').map((m) => cogsRowFor(m.qty, m.at))
    const cogs = await getCogsReport({ dateFrom: dayAfter, dateTo: f.d1, product: 'Widget' }, { paginate: false })
    assert.equal(cogs.totals.cogsBase.exactString(), String(Number(f.expect.cogs)))
    const turnover = await getInventoryTurnoverReport({ dateFrom: dayAfter, dateTo: f.d1, product: 'Widget' }, { paginate: false, client: { cogsEntry: { findMany: cogsFindMany }, inventorySnapshot: { findMany: async () => [] } } as never })
    assert.equal(Number(turnover.totals.cogsBase), Number(f.expect.cogs))

    // received is derived INDEPENDENTLY of every report: the sum of the inbound fixture moves whose London day is in (D0, D1].
    // (The old definition, ledger movement + COGS, reduced the identity to the ledger-closing assertion above.)
    const londonDay = (at: string) => businessDateYmd(new Date(at))
    const received = f.moves.filter((m) => m.kind === 'in' && londonDay(m.at) > f.d0 && londonDay(m.at) <= f.d1).reduce((sum, m) => sum.add(D(m.qty)), D(0))
    assert.equal(received.toFixed(0), f.expect.received)
    // COGS from the report's own total, never from a fixture constant.
    const cogsValue = D(Number(cogs.totals.cogsBase.exactString()))
    assert.equal(val0.add(received).sub(cogsValue).toFixed(6), val1.toFixed(6))
  })
}

/** Aggregate/findMany/count over in-memory rows honouring the where the ledger report builds (createdAt window, inbound/outbound type split). */
type Row = { id: string; type: string; createdAt: Date; fromWarehouseId: string | null; toWarehouseId: string | null; qty: PrismaRuntime.Decimal; totalValueBase: PrismaRuntime.Decimal }
type Where = {
  AND?: Where[]
  OR?: Where[]
  createdAt?: { gte?: Date; lt?: Date }
  type?: string | { in: string[] }
  fromWarehouseId?: { not: null } | null
  toWarehouseId?: { not: null } | null
}

function ledgerClientFor(rows: Row[], Prisma: typeof PrismaRuntime) {
  const matches = (row: Row, where: Where | undefined): boolean => {
    if (!where) return true
    if (Array.isArray(where.AND) && !where.AND.every((p) => matches(row, p))) return false
    if (Array.isArray(where.OR) && !where.OR.some((p) => matches(row, p))) return false
    if (where.createdAt) {
      const f = where.createdAt
      if (f.gte && row.createdAt < f.gte) return false
      if (f.lt && row.createdAt >= f.lt) return false
    }
    if (typeof where.type === 'string' && row.type !== where.type) return false
    if (typeof where.type === 'object' && !where.type.in.includes(row.type)) return false
    for (const field of ['fromWarehouseId', 'toWarehouseId'] as const) {
      const clause = where[field]
      if (clause && 'not' in clause && row[field] == null) return false
      if (clause === null && row[field] != null) return false
    }
    return true
  }
  const sum = (list: Row[], key: 'qty' | 'totalValueBase') => list.reduce((acc, r) => acc.add(r[key]), new Prisma.Decimal(0))
  return {
    stockMovement: {
      count: async (a: { where?: Where }) => rows.filter((r) => matches(r, a.where)).length,
      findMany: async (a: { where?: Where }) => rows.filter((r) => matches(r, a.where)),
      aggregate: async (a: { where?: Where }) => {
        const list = rows.filter((r) => matches(r, a.where))
        return { _sum: { qty: list.length ? sum(list, 'qty') : null, totalValueBase: list.length ? sum(list, 'totalValueBase') : null } }
      },
    },
  }
}

test('ledger, COGS and turnover windows start and end at London midnights (BST: 23:00Z), by exact where', async () => {
  const { getStockMovementLedgerReport, getCogsReport, getInventoryTurnoverReport } = await load()
  const wheres: Array<{ gte?: Date; lt?: Date }> = []
  const spy = {
    stockMovement: {
      count: async (a: Where & { where: Where }) => { wheres.push(a.where.AND?.[0]?.createdAt ?? a.where.createdAt ?? {}); return 0 },
      findMany: async () => [],
      aggregate: async () => ({ _sum: { qty: null, totalValueBase: null } }),
    },
  }
  await getStockMovementLedgerReport({ dateFrom: '2026-07-01', dateTo: '2026-07-31', includeCost: true }, { client: spy as never, paginate: false })
  const w = JSON.stringify(wheres[0])
  assert.match(w, /"gte":"2026-06-30T23:00:00.000Z"/)
  assert.match(w, /"lt":"2026-07-31T23:00:00.000Z"/)

  COGS_ROWS = []
  await getCogsReport({ dateFrom: '2026-07-01', dateTo: '2026-07-31', product: 'Widget' }, { paginate: false })
  assert.equal(COGS_WHERE!.createdAt!.gte!.toISOString(), '2026-06-30T23:00:00.000Z')
  assert.equal(COGS_WHERE!.createdAt!.lt!.toISOString(), '2026-07-31T23:00:00.000Z')

  await getInventoryTurnoverReport({ dateFrom: '2026-07-01', dateTo: '2026-07-31' }, { paginate: false, client: { cogsEntry: { findMany: cogsFindMany }, inventorySnapshot: { findMany: async () => [] } } as never })
  assert.equal(COGS_WHERE!.createdAt!.gte!.toISOString(), '2026-06-30T23:00:00.000Z')
  assert.equal(COGS_WHERE!.createdAt!.lt!.toISOString(), '2026-07-31T23:00:00.000Z')

  // GMT control: the London day is the UTC day.
  await getCogsReport({ dateFrom: '2026-02-01', dateTo: '2026-02-28', product: 'Widget' }, { paginate: false })
  assert.equal(COGS_WHERE!.createdAt!.gte!.toISOString(), '2026-02-01T00:00:00.000Z')
  assert.equal(COGS_WHERE!.createdAt!.lt!.toISOString(), '2026-03-01T00:00:00.000Z')
})

test('default report dates are the London day, not the UTC day (23:30Z in BST is already the next London day)', async () => {
  const { getCogsReport, getInventoryTurnoverReport } = await load()
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-07-01T23:30:00.000Z') })
  try {
    COGS_ROWS = []
    const cogs = await getCogsReport({ product: 'Widget' }, { paginate: false })
    assert.equal(cogs.dateTo, '2026-07-02')
    assert.equal(cogs.dateFrom, '2026-06-03', 'the 30 London days ending 2 July, as Gross Margin (not 31)')
    const turnover = await getInventoryTurnoverReport({}, { paginate: false, client: { cogsEntry: { findMany: cogsFindMany }, inventorySnapshot: { findMany: async () => [] } } as never })
    assert.equal(turnover.dateTo, '2026-07-02')
    assert.equal(turnover.dateFrom, '2026-04-03')
    // the default window ends at the London midnight after 2 July, i.e. 23:00Z on 2 July
    assert.equal(COGS_WHERE!.createdAt!.lt!.toISOString(), '2026-07-02T23:00:00.000Z')
  } finally {
    mock.timers.reset()
  }
})
