import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { Prisma } from '@/app/generated/prisma/client'
import { parseCsv } from '@/lib/csv'

/**
 * o3d-rv4a. THE ARITHMETIC IN EVERY ASSERTION IS WORKED OUT IN THE COMMENT ABOVE IT, FROM NAMED
 * INPUTS, AND NEVER BY RE-RUNNING THE IMPLEMENTATION.
 *
 * That is the only kind of test that could have caught this. The report did not crash and did not
 * disagree with itself; it published a confident wrong number. `assert.equal(row.revenueBase,
 * computeTheSameWayTheCodeDoes(fixture))` would have been green for the whole five rounds this
 * survived, and round 5 responded by writing the blindness down instead of removing it.
 *
 * THE ISSUE'S WORKED EXAMPLE, which every case below is a variation of: one order, one ex-VAT sales
 * line of 100, one dispatch, 40 of posted COGS, and one full credit against that line.
 *
 *   refund-blind (what shipped before this branch)   100 revenue | 60 margin | 60% — and no marker
 *   NET-basis credit of 100                            0 revenue | -40 margin | 0% — exact
 *   GROSS-basis credit of 120                        100 revenue | 60 margin | 60% — every one ≤
 *   unproven-basis credit of 100                     100 revenue | 60 margin | 60% — every one ≤
 *
 * The last two print the SAME NUMBERS the blind report printed. That is the point: the defect was
 * never only the arithmetic, it was that a bounded figure was presented as a measurement. A test
 * covering only the NET case would prove an adjacent property and leave both of those unexamined —
 * and they are precisely where the round-5 disclosure lived.
 */

const D = (value: string | number) => new Prisma.Decimal(value)
const WINDOW = { dateFrom: '2026-06-01', dateTo: '2026-06-30' }
/** Keeps `hasCogsGlScope` false so no accounting connector is reached. Filtering is mocked away. */
const FILTERS = { ...WINDOW, product: 'Widget' }

const WAREHOUSE = { id: 'wh-a', code: 'WHA', name: 'Warehouse A' }

function product(id: string) {
  return {
    id,
    sku: id.toUpperCase(),
    name: `Widget ${id}`,
    stockUnit: 'pcs',
    category: { name: 'Widgets' },
    supplierProducts: [],
  }
}

/**
 * One COGS entry for one dispatch movement, LINKED to the sales line it shipped.
 *
 * The link is what makes this report key revenue (and therefore credit) at line granularity —
 * `L:<lineId>` — instead of the blended `<orderId>:<productId>` pair. Both schemes are exercised
 * below, because the credit has to follow whichever one the report chose.
 */
function cogsEntry(input: {
  id: string
  orderId: string
  productId: string
  qty: string
  cost: string
  line?: { id: string; productId: string | null; totalBase: string }
}) {
  return {
    id: input.id,
    qty: D(input.qty),
    totalCostBase: D(input.cost),
    createdAt: new Date('2026-06-10T00:00:00.000Z'),
    movement: {
      id: `mv-${input.id}`,
      referenceType: 'SalesOrder',
      referenceId: input.orderId,
      fromWarehouseId: WAREHOUSE.id,
      toWarehouseId: null,
      product: product(input.productId),
      fromWarehouse: WAREHOUSE,
      toWarehouse: null,
      shipmentLine: input.line
        ? { lineId: input.line.id, line: { id: input.line.id, productId: input.line.productId, totalBase: D(input.line.totalBase) } }
        : null,
    },
  }
}

function order(id: string, lines: Array<{ productId: string; totalBase: string }>) {
  return {
    id,
    customerName: 'Acme',
    shoppingLinks: [],
    lines: lines.map((line) => ({ productId: line.productId, totalBase: D(line.totalBase) })),
  }
}

/** A credit line against a named sales line. `totalsBasis` is the parent refund's persisted marker. */
function creditAgainstLine(lineId: string, orderId: string, productId: string, totalBase: string, totalsBasis: string | null) {
  return {
    totalBase: D(totalBase),
    productId,
    salesOrderLine: { id: lineId, orderId, productId },
    refund: { orderId, totalsBasis },
  }
}

/** A credit line that names nothing keyable — a shipping or monetary-only credit. */
function creditNamingNothing(orderId: string, totalBase: string, totalsBasis: string | null) {
  return { totalBase: D(totalBase), productId: null, salesOrderLine: null, refund: { orderId, totalsBasis } }
}

let COGS_ROWS: unknown[] = []
let ORDERS: unknown[] = []
let CREDIT_LINES: unknown[] = []
let CREDIT_WHERE: Record<string, unknown> | null = null

mock.module('@/lib/db', {
  namedExports: {
    db: {
      cogsEntry: { findMany: async () => COGS_ROWS },
      salesOrder: { findMany: async () => ORDERS },
      salesOrderRefundLine: {
        findMany: async (args?: { where?: Record<string, unknown> }) => {
          CREDIT_WHERE = args?.where ?? null
          return CREDIT_LINES
        },
      },
      product: { findMany: async () => [] },
    },
  },
})

mock.module('@/lib/security/inventory-costing-access', {
  namedExports: {
    requireInventoryCostingReportAccess: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
    inventoryCostingApiAccessDenied: () => null,
  },
})
mock.module('@/lib/auth/server', {
  namedExports: {
    requireApiAuth: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
    requirePermission: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
    requireRole: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
  },
})
mock.module('@/app/actions/company', {
  namedExports: { getOrganisation: async () => ({ baseCurrency: 'GBP' }) },
})
mock.module('@/lib/domain/inventory/stock-position-reports', {
  namedExports: {
    getStockPositionFilterOptions: async () => ({ warehouses: [], categories: [], suppliers: [] }),
    stockPositionSelectedFilterOptionInputs: () => ({}),
  },
})

/** THE FIXTURE: the issue's worked example, with `credit` as the only variable. */
function workedExample(credit: unknown[], cost = '40') {
  COGS_ROWS = [cogsEntry({ id: 'c1', orderId: 'O1', productId: 'p1', qty: '1', cost, line: { id: 'L1', productId: 'p1', totalBase: '100' } })]
  ORDERS = [order('O1', [{ productId: 'p1', totalBase: '100' }])]
  CREDIT_LINES = credit
}

async function report() {
  const { getCogsReport } = await import('@/lib/domain/inventory/inventory-costing-reports')
  return await getCogsReport(FILTERS, { paginate: false })
}

/** The page's OWN cells and footers, read out of the element it returns. This is what is on screen. */
async function pageCells(): Promise<{ cell: (key: string) => string; cellOf: (key: string, row: unknown) => string; footer: (key: string) => string; summary: Map<string, string>; notices: string[] }> {
  const { default: CogsPage } = await import('@/app/(dashboard)/analytics/cogs/page')
  const element = await CogsPage({ searchParams: Promise.resolve({ ...FILTERS }) }) as {
    props: {
      columns: Array<{ key: string; render: (row: unknown) => unknown; footer?: unknown }>
      rows: unknown[]
      summary: Array<{ label: string; value: string }>
      notices: string[]
    }
  }
  const { columns, rows, summary, notices } = element.props
  const column = (key: string) => {
    const found = columns.find((c) => c.key === key)
    assert.ok(found, `the page has no ${key} column`)
    return found
  }
  return {
    cell: (key: string) => String(column(key).render(rows[0])),
    cellOf: (key: string, row: unknown) => String(column(key).render(row)),
    footer: (key: string) => String(column(key).footer),
    summary: new Map(summary.map((item) => [item.label, item.value])),
    notices,
  }
}

async function csvRows(): Promise<{ rows: Record<string, string>[]; header: string[]; metadata: Map<string, string> }> {
  const { GET } = await import('@/app/api/export/inventory-costing/route')
  const { NextRequest } = await import('next/server')
  const params = new URLSearchParams({ report: 'cogs', ...FILTERS })
  const res = await GET(new NextRequest(`https://ims.test/api/export/inventory-costing?${params.toString()}`))
  const body = await res.text()
  const metadata = new Map<string, string>()
  for (const line of body.split('\r\n')) {
    const match = /^"?# ([A-Za-z0-9_.]+)"?,(.*)$/.exec(line)
    if (match) metadata.set(match[1]!, match[2]!.replace(/^"|"$/g, '').replace(/""/g, '"'))
  }
  return { rows: parseCsv(body), header: body.split('\r\n')[0]!.split(','), metadata }
}

// ---------------------------------------------------------------------------------------------
// The three bases, at the numbers an operator sees
// ---------------------------------------------------------------------------------------------

test('NET credit: the fully credited line reads 0 revenue and MINUS 40 margin, exactly (o3d-rv4a)', async () => {
  // Line revenue 100 ex-VAT; the credit is stamped NET, so it is the same unit and comes off in
  // full: 100 - 100 = 0 revenue, 0 - 40 = -40 margin. Nothing was left unsubtracted, so no relation
  // is owed and the figures carry NO marker — `exact` is a claim, not a hedge.
  workedExample([creditAgainstLine('L1', 'O1', 'p1', '100', 'NET')])
  const { rows, totals } = await report()
  assert.equal(rows[0]!.revenueBase, '0.000000')
  assert.equal(rows[0]!.grossMarginBase, '-40.000000')
  assert.equal(rows[0]!.refundsNetBasis, '100.000000')
  assert.equal(rows[0]!.revenueBaseBound, 'exact')
  assert.equal(rows[0]!.grossMarginBaseBound, 'exact')
  assert.equal(rows[0]!.grossMarginPctBound, 'exact')
  assert.equal(totals.revenueBase, '0.000000')
  assert.equal(totals.grossMarginBase, '-40.000000')
  assert.equal(totals.revenueBaseBound, 'exact')

  const page = await pageCells()
  assert.equal(page.cell('revenue'), '£0.00')
  assert.equal(page.cell('margin'), '-£40.00')
  // Revenue is not positive, so the ratio is 0% under the same guard the Gross Margin report uses.
  // Before this branch a non-positive revenue was unreachable here; it is routine now.
  assert.equal(page.cell('marginPct'), '0%')
  assert.equal(page.footer('revenue'), '£0.00')
  assert.equal(page.summary.get('Gross margin (GBP)'), '-£40.00')
})

test('GROSS credit: the same 100/60/60% print, but every one of them marked ≤ (o3d-rv4a)', async () => {
  // A 120 VAT-inclusive credit against a 100 ex-VAT line. Its ex-VAT value is 120/(1+rate) — and the
  // rate is not recoverable from stored data on a mixed-rate order, so it is NOT converted and NOT
  // subtracted (refund-basis-analytics, o3d-w00's fail-closed conclusion). Revenue stays 100 and
  // margin 60, which is what the blind report printed; what changes is that all three now say they
  // are at most the true figure, and the 120 is published beside them so the reader can see how
  // loose that is.
  workedExample([creditAgainstLine('L1', 'O1', 'p1', '120', 'GROSS')])
  const { rows, totals } = await report()
  assert.equal(rows[0]!.revenueBase, '100.000000')
  assert.equal(rows[0]!.grossMarginBase, '60.000000')
  assert.equal(rows[0]!.grossMarginPct, '60')
  assert.equal(rows[0]!.refundsGrossBasis, '120.000000')
  assert.equal(rows[0]!.refundsNetBasis, '0.000000')
  assert.equal(rows[0]!.revenueBaseBound, 'upper')
  assert.equal(rows[0]!.grossMarginBaseBound, 'upper')
  // Margin is a RATIO: published 60%, and placing the credit at any ex-VAT value in [0, 120] takes
  // revenue to at most 100 and the quotient no higher, while the report's own `revenue > 0` guard
  // pins the worst reading to 0%. 0% is below 60%, so the published figure is a genuine ceiling here.
  assert.equal(rows[0]!.grossMarginPctBound, 'upper')
  assert.equal(totals.revenueBaseBound, 'upper')
  assert.equal(totals.refundsGrossBasis, '120.000000')

  const page = await pageCells()
  assert.equal(page.cell('revenue'), '£100.00 ≤')
  assert.equal(page.cell('margin'), '£60.00 ≤')
  assert.equal(page.cell('marginPct'), '60% ≤')
  assert.equal(page.cell('creditGross'), '£120.00')
  assert.equal(page.footer('revenue'), '£100.00 ≤')
  assert.equal(page.summary.get('Revenue (GBP, net of credit)'), '£100.00 ≤')
})

test('unproven basis: not converted, not guessed, and not reported as zero credit (o3d-rv4a)', async () => {
  // `totalsBasis` NULL is a first-class answer, not a missing NET (o3d-n8p/o3d-w00): a legacy row, or
  // one the o3d-lvk backfill could not PROVE either way. 100 of credit exists and is published; what
  // is withheld is the subtraction. Same 100/60/60%, same three ≤ marks, and the amount lands in the
  // unproven column rather than being quietly treated as net.
  workedExample([creditAgainstLine('L1', 'O1', 'p1', '100', null)])
  const { rows } = await report()
  assert.equal(rows[0]!.revenueBase, '100.000000')
  assert.equal(rows[0]!.grossMarginBase, '60.000000')
  assert.equal(rows[0]!.refundsUnknownBasis, '100.000000')
  assert.equal(rows[0]!.refundsNetBasis, '0.000000')
  assert.equal(rows[0]!.refundsGrossBasis, '0.000000')
  assert.equal(rows[0]!.revenueBaseBound, 'upper')
  assert.equal(rows[0]!.grossMarginBaseBound, 'upper')
  assert.equal(rows[0]!.grossMarginPctBound, 'upper')

  const page = await pageCells()
  assert.equal(page.cell('revenue'), '£100.00 ≤')
  assert.equal(page.cell('creditUnknown'), '£100.00')
})

test('an UNSTAMPED basis is not read as NET even when the amounts would agree (o3d-rv4a control)', async () => {
  // The two tests above differ ONLY in `totalsBasis`, at the same 100. Pin that the difference is
  // the marker and not the amount: read as NET this would be 0 revenue, and it is not.
  workedExample([creditAgainstLine('L1', 'O1', 'p1', '100', 'NET')])
  const asNet = await report()
  workedExample([creditAgainstLine('L1', 'O1', 'p1', '100', 'MYSTERY')])
  const asUnrecognised = await report()
  assert.equal(asNet.rows[0]!.revenueBase, '0.000000')
  assert.equal(asUnrecognised.rows[0]!.revenueBase, '100.000000')
  // An unrecognised marker is UNKNOWN, never NET. Guessing is the mislabelling the backfill exists
  // to avoid, and a future writer's new value must not silently become a subtraction.
  assert.equal(asUnrecognised.rows[0]!.refundsUnknownBasis, '100.000000')
  assert.equal(asUnrecognised.rows[0]!.revenueBaseBound, 'upper')
})

test('no credit at all: exact, unmarked, and the credit columns are zero (o3d-rv4a control)', async () => {
  // Not vacuous: the SAME cells read `£100.00 ≤` two tests up, on this same fixture with a
  // gross-basis credit added. Blindness looked exactly like this, which is why the control matters.
  workedExample([])
  const { rows, totals } = await report()
  assert.equal(rows[0]!.revenueBase, '100.000000')
  assert.equal(rows[0]!.grossMarginBase, '60.000000')
  assert.equal(rows[0]!.grossMarginPct, '60')
  assert.equal(rows[0]!.revenueBaseBound, 'exact')
  assert.equal(rows[0]!.grossMarginPctBound, 'exact')
  assert.equal(totals.revenueBaseBound, 'exact')
  const page = await pageCells()
  assert.equal(page.cell('revenue'), '£100.00')
  assert.equal(page.cell('marginPct'), '60%')
})

// ---------------------------------------------------------------------------------------------
// The ratio is not the linear figures, and the bound is not a signed sum
// ---------------------------------------------------------------------------------------------

test('the ratio verdict can differ from the two linear ones on one row (o3d-iigc r4 #1)', async () => {
  // 100 ex-VAT revenue, 150 of COGS, and a 120 gross-basis credit that cannot be placed. Published
  // margin is 100*(1 - 150/100) = -50%. Place that credit at its 100 ex-VAT value and revenue is 0,
  // where the report's guard prints 0% — and 0% is NOT "at most -50%". Revenue and margin are still
  // genuine ceilings; the ratio is not, and marking it ≤ would be a false claim.
  workedExample([creditAgainstLine('L1', 'O1', 'p1', '120', 'GROSS')], '150')
  const { rows } = await report()
  assert.equal(rows[0]!.grossMarginBase, '-50.000000')
  assert.equal(rows[0]!.grossMarginPct, '-50')
  assert.equal(rows[0]!.revenueBaseBound, 'upper')
  assert.equal(rows[0]!.grossMarginBaseBound, 'upper')
  assert.equal(rows[0]!.grossMarginPctBound, 'indeterminate')
  const page = await pageCells()
  assert.equal(page.cell('margin'), '-£50.00 ≤')
  assert.equal(page.cell('marginPct'), '-50% ?')
})

test('two opposite same-basis credits do not cancel behind the bound (o3d-la3n)', async () => {
  // +120 and -120 of GROSS credit. The signed bucket is ZERO, and zero is not negative, so any rule
  // that classified from `refundsGrossBasis + refundsUnknownBasis` would answer `upper` about a
  // figure whose truth can be 120 EITHER side of the published one — the two credits' ex-VAT values
  // need not cancel, because the rates behind them may differ. The interval is [-120, +120], it
  // straddles zero, and the only sound answer is that no direction is established.
  workedExample([
    creditAgainstLine('L1', 'O1', 'p1', '120', 'GROSS'),
    creditAgainstLine('L1', 'O1', 'p1', '-120', 'GROSS'),
  ])
  const { rows, totals } = await report()
  assert.equal(rows[0]!.refundsGrossBasis, '0.000000', 'the published bucket really is a zero')
  assert.equal(rows[0]!.revenueBase, '100.000000')
  assert.equal(rows[0]!.revenueBaseBound, 'indeterminate')
  assert.equal(rows[0]!.grossMarginBaseBound, 'indeterminate')
  assert.equal(totals.revenueBaseBound, 'indeterminate')
  const page = await pageCells()
  assert.equal(page.cell('revenue'), '£100.00 ?')
})

// ---------------------------------------------------------------------------------------------
// Credit that reached no row
// ---------------------------------------------------------------------------------------------

test('a NET credit that reached no row still bounds the totals (o3d-kyey)', async () => {
  // The trap a basis flag alone walks into: a NET credit IS the figure's unit, so it is `placeable`
  // and the basis flag stays true — while the credit sits unsubtracted because no row could own it.
  // 10 of net credit on a line this report has no revenue row for: every ROW is exact, and the
  // period totals are not.
  workedExample([creditAgainstLine('L9', 'O1', 'p9', '10', 'NET')])
  const { rows, totals } = await report()
  assert.equal(rows[0]!.revenueBase, '100.000000')
  assert.equal(rows[0]!.revenueBaseBound, 'exact', 'no credit reached this row')
  assert.equal(totals.refundsOutsideReportNetBasis, '10.000000')
  assert.equal(totals.refundsUnattributedNetBasis, '0.000000')
  assert.equal(totals.revenueBaseBound, 'upper')
  assert.equal(totals.grossMarginBaseBound, 'upper')
  const page = await pageCells()
  assert.equal(page.footer('revenue'), '£100.00 ≤')
  assert.equal(page.summary.get('Credit off-report — no revenue row here (net / gross / unproven)'), '£10.00 / £0.00 / £0.00')
})

test('a credit line naming nothing keyable is separated from one naming a row we lack (o3d-rv4a)', async () => {
  // Two different facts, kept apart because they have different remedies: a shipping or monetary-only
  // credit line can NEVER reach a product row however the dates are widened, while a credit naming a
  // product this window has no revenue row for may well appear on another period.
  workedExample([
    creditNamingNothing('O1', '7', 'GROSS'),
    creditAgainstLine('L9', 'O1', 'p9', '3', null),
  ])
  const { totals } = await report()
  assert.equal(totals.refundsUnattributedGrossBasis, '7.000000')
  assert.equal(totals.refundsOutsideReportUnknownBasis, '3.000000')
  assert.equal(totals.refundsGrossBasis, '7.000000', 'the report-wide credit total includes both')
  assert.equal(totals.refundsUnknownBasis, '3.000000')
  assert.equal(totals.revenueBaseBound, 'upper')
})

test('a row whose revenue is Unmatched publishes no relation, and its credit is not lost (o3d-rv4a)', async () => {
  // The dispatch references an order whose lines name a different product, so this key carries no
  // revenue — the null-not-zero discipline this report already had. A credit naming that key has no
  // figure anywhere to reduce, so it cannot be attributed at all and lands in the off-report totals;
  // the cell stays `Unmatched` with NO relation attached, because a withheld figure bears none, and
  // `exact` there would read as a measurement.
  COGS_ROWS = [cogsEntry({ id: 'c1', orderId: 'O1', productId: 'p1', qty: '1', cost: '40' })]
  ORDERS = [order('O1', [{ productId: 'other', totalBase: '100' }])]
  CREDIT_LINES = [creditAgainstLine('L1', 'O1', 'p1', '50', 'NET')]
  const { rows, totals } = await report()
  assert.equal(rows[0]!.revenueCaptured, false)
  assert.equal(rows[0]!.revenueBase, null)
  assert.equal(rows[0]!.revenueBaseBound, null, 'a withheld figure carries no relation, not `exact`')
  assert.equal(rows[0]!.grossMarginPctBound, null)
  assert.equal(totals.refundsOutsideReportNetBasis, '50.000000')
  assert.equal(totals.revenueBaseBound, 'upper')
  const page = await pageCells()
  assert.equal(page.cell('revenue'), 'Unmatched')
  assert.equal(page.cell('marginPct'), 'Unmatched')
})

test('credit that DID reach a row whose figure is withheld still bounds the totals (o3d-rv4a)', async () => {
  // THIS IS THE CASE THE TEST ABOVE DOES NOT REACH, and a green mutation is how I found that out:
  // replacing the withheld-row branch with the ordinary unplaced-credit one left the suite entirely
  // green, because in that fixture no credit ever reached a row at all.
  //
  // Here it does. One product bucket, two dispatches: order O1's is line-linked and carries 100 of
  // ex-VAT revenue, order O2's references an order whose lines name a different product, so the
  // GROUP's revenue is withheld (`revenueCaptured` is all-or-nothing per group, by design — a partial
  // figure summed with a hole in it is worse than no figure). A 100 NET credit against O1's line IS
  // attributed to this row. Its basis is the figure's own unit, so every completeness FLAG stays
  // true — and the credit is still missing from the period revenue, because the row it reached
  // publishes nothing for it to come off. Read from the flags alone the totals would say `exact`
  // over a period with a credit note missing from it.
  COGS_ROWS = [
    cogsEntry({ id: 'c1', orderId: 'O1', productId: 'p1', qty: '1', cost: '40', line: { id: 'L1', productId: 'p1', totalBase: '100' } }),
    cogsEntry({ id: 'c2', orderId: 'O2', productId: 'p1', qty: '1', cost: '15' }),
  ]
  ORDERS = [order('O1', [{ productId: 'p1', totalBase: '100' }]), order('O2', [{ productId: 'other', totalBase: '60' }])]
  CREDIT_LINES = [creditAgainstLine('L1', 'O1', 'p1', '100', 'NET')]
  const { rows, totals } = await report()
  assert.equal(rows.length, 1, 'one product bucket')
  assert.equal(rows[0]!.revenueCaptured, false)
  assert.equal(rows[0]!.revenueBase, null)
  assert.equal(rows[0]!.revenueBaseBound, null)
  // The credit reached the row and is published on it — it is not off-report and it is not lost.
  assert.equal(rows[0]!.refundsNetBasis, '100.000000')
  assert.equal(totals.refundsNetBasis, '100.000000')
  assert.equal(totals.refundsOutsideReportNetBasis, '0.000000')
  assert.equal(totals.refundsUnattributedNetBasis, '0.000000')
  // The withheld row contributes neither revenue nor margin to the period totals (that is what the
  // null means, and the totals have always summed it as nothing), so both are zero against 55 of
  // posted cost — and both are BOUNDED, because 100 of real credit sits outside them.
  assert.equal(totals.cogsBase, '55.000000')
  assert.equal(totals.revenueBase, '0.000000')
  assert.equal(totals.grossMarginBase, '0.000000')
  assert.equal(totals.revenueBaseBound, 'upper')
  assert.equal(totals.grossMarginBaseBound, 'upper')
  const page = await pageCells()
  assert.equal(page.footer('revenue'), '£0.00 ≤')
  assert.equal(page.cell('creditNet'), '£100.00')
})

// ---------------------------------------------------------------------------------------------
// Attribution: the same keys, and the same quantity share
// ---------------------------------------------------------------------------------------------

test('credit follows the BLENDED order:product key where revenue does (o3d-rv4a)', async () => {
  // No shipment-line link, so `resolveCogsRevenueKeys` falls back to `<orderId>:<productId>` and the
  // credit has to be keyed the same way. Keyed by line id instead it would reach no row, and the row
  // would publish 100 as exact with 100 of net credit sitting off-report.
  COGS_ROWS = [cogsEntry({ id: 'c1', orderId: 'O1', productId: 'p1', qty: '1', cost: '40' })]
  ORDERS = [order('O1', [{ productId: 'p1', totalBase: '100' }])]
  CREDIT_LINES = [{ totalBase: D('100'), productId: 'p1', salesOrderLine: null, refund: { orderId: 'O1', totalsBasis: 'NET' } }]
  const { rows, totals } = await report()
  assert.equal(rows[0]!.revenueBase, '0.000000')
  assert.equal(rows[0]!.revenueBaseBound, 'exact')
  assert.equal(totals.refundsOutsideReportNetBasis, '0.000000')
})

test('a line split across two warehouses shares its credit by the same qty proportion (scjz.50)', async () => {
  // One line of 4 units at 300 ex-VAT, dispatched 1 from WHA and 3 from WHB, with a 300 NET credit.
  // Revenue is allocated 75/225 by quantity share, so the credit must be too: 75 and 225. Charging
  // each warehouse the WHOLE 300 would report -225 and -75 and a report total 300 too low — the
  // mirror of the double-count that rule exists to prevent.
  COGS_ROWS = [
    { ...cogsEntry({ id: 'c1', orderId: 'O1', productId: 'p1', qty: '1', cost: '10', line: { id: 'L1', productId: 'p1', totalBase: '300' } }) },
    {
      ...cogsEntry({ id: 'c2', orderId: 'O1', productId: 'p1', qty: '3', cost: '30', line: { id: 'L1', productId: 'p1', totalBase: '300' } }),
      movement: {
        ...cogsEntry({ id: 'c2', orderId: 'O1', productId: 'p1', qty: '3', cost: '30', line: { id: 'L1', productId: 'p1', totalBase: '300' } }).movement,
        fromWarehouseId: 'wh-b',
        fromWarehouse: { id: 'wh-b', code: 'WHB', name: 'Warehouse B' },
      },
    },
  ]
  ORDERS = [order('O1', [{ productId: 'p1', totalBase: '300' }])]
  CREDIT_LINES = [creditAgainstLine('L1', 'O1', 'p1', '300', 'NET')]
  const { getCogsReport } = await import('@/lib/domain/inventory/inventory-costing-reports')
  const { rows, totals } = await getCogsReport({ ...FILTERS, groupBy: 'warehouse' }, { paginate: false })
  const byCode = new Map(rows.map((row) => [row.warehouseCode, row]))
  assert.equal(byCode.get('WHA')!.refundsNetBasis, '75.000000')
  assert.equal(byCode.get('WHB')!.refundsNetBasis, '225.000000')
  assert.equal(byCode.get('WHA')!.revenueBase, '0.000000')
  assert.equal(byCode.get('WHB')!.revenueBase, '0.000000')
  assert.equal(totals.revenueBase, '0.000000')
  assert.equal(totals.refundsNetBasis, '300.000000')
})

test('the credit window is the refund date, scoped to this report’s own orders (o3d-rv4a)', async () => {
  // Two facts about the query, asserted because both are decisions: the period rule is the refund's
  // own `refundedAt` (the same rule Gross Margin uses, so the two reports cannot answer one question
  // two ways), and the scope is the orders behind THIS report's dispatches — an unrestricted load
  // would fill the off-report totals with credit the operator's own filters excluded.
  workedExample([creditAgainstLine('L1', 'O1', 'p1', '100', 'NET')])
  await report()
  const refund = (CREDIT_WHERE as { refund: { orderId: { in: string[] }; refundedAt: { gte: Date; lt: Date } } }).refund
  assert.deepEqual(refund.orderId.in, ['O1'])
  assert.equal(refund.refundedAt.gte.toISOString(), '2026-06-01T00:00:00.000Z')
  assert.equal(refund.refundedAt.lt.toISOString(), '2026-07-01T00:00:00.000Z')
})

// ---------------------------------------------------------------------------------------------
// The CSV — a file reader has no tooltip
// ---------------------------------------------------------------------------------------------

test('the CSV gives every bounded figure its OWN column, immediately right of it (o3d-rv4a)', async () => {
  workedExample([creditAgainstLine('L1', 'O1', 'p1', '120', 'GROSS')], '150')
  const { header, rows } = await csvRows()
  for (const [figure, bound] of [
    ['revenueBase', 'revenueBaseBound'],
    ['grossMarginBase', 'grossMarginBaseBound'],
    ['grossMarginPct', 'grossMarginPctBound'],
  ]) {
    assert.ok(header.includes(bound!), `${bound} is missing from the file`)
    assert.equal(header.indexOf(bound!), header.indexOf(figure!) + 1, `${bound} must sit immediately right of ${figure}`)
  }
  // Basis-independent columns get no bound, because marking them would be noise.
  for (const key of ['qty', 'cogsBase', 'movementCount']) {
    assert.ok(!header.includes(`${key}Bound`), `${key} does not move with the refund basis`)
  }
  const [row] = rows
  // The same three verdicts the page prints, and the ratio disagreeing with the linear pair INSIDE
  // ONE FILE. A single shared flag column could not have said this.
  assert.equal(row!.revenueBase, '100.000000')
  assert.equal(row!.revenueBaseBound, 'upper')
  assert.equal(row!.grossMarginBase, '-50.000000')
  assert.equal(row!.grossMarginBaseBound, 'upper')
  assert.equal(row!.grossMarginPct, '-50')
  assert.equal(row!.grossMarginPctBound, 'indeterminate')
  assert.equal(row!.refundsGrossBasis, '120.000000')
  assert.equal(row!.refundsNetBasis, '0.000000')
})

test('the CSV carries the period totals and their bounds as metadata, untruncated (o3d-rv4a)', async () => {
  // A bound that exists only on the page is a disclosure the file reader never sees. The off-report
  // credit and the totals' own markers exist nowhere in `rows`, so they travel as `totals.<name>`
  // comment rows — and the assertion that the metadata was NOT truncated is load-bearing: the helper
  // silently drops everything but a handful of essential keys past 4096 bytes, which would take the
  // whole disclosure with it.
  workedExample([creditAgainstLine('L9', 'O1', 'p9', '10', 'NET')])
  const { metadata } = await csvRows()
  assert.equal(metadata.get('metadataTruncated'), undefined, 'the metadata must fit; see headerMetadata in lib/csv.ts')
  assert.equal(metadata.get('totals.revenueBaseBound'), 'upper')
  assert.equal(metadata.get('totals.grossMarginBaseBound'), 'upper')
  assert.equal(metadata.get('totals.refundsOutsideReportNetBasis'), '10.000000')
  assert.equal(metadata.get('totals.refundsUnattributedNetBasis'), '0.000000')
  const treatment = metadata.get('refundTreatment') ?? ''
  assert.match(treatment, /net-basis credit/)
  assert.doesNotMatch(treatment, /Refunds are NOT deducted/)
})

test('the report’s own notice names the basis it deducted and no longer claims blindness (o3d-rv4a)', async () => {
  workedExample([])
  const page = await pageCells()
  const notice = page.notices.find((line) => /net-basis credit/.test(line))
  assert.ok(notice, `no basis notice reached the page; notices were: ${JSON.stringify(page.notices)}`)
  for (const stale of [/Refunds are NOT deducted/, /keeps its full revenue and margin/, /refund-aware net revenue/]) {
    assert.ok(!page.notices.some((line) => stale.test(line)), `the round-5 disclosure is still on the page: ${stale}`)
  }
})

// ---------------------------------------------------------------------------------------------
// The mark is a fact about the bound, and no branch the cell controls may suppress it
// ---------------------------------------------------------------------------------------------

test('a withheld AMOUNT still prints the relation the producer published (o3d-la3n r3)', async () => {
  // o3d-la3n round 2 composed amount and mark into one string and let a `show` predicate branch
  // around the whole of it, so a row that owed "— ≥" printed a bare em dash. The fix was to pass the
  // amount RENDERER into the marker and append the mark after it, outside every branch the cell
  // controls. This report's own withheld amount is `Unmatched`, and it is that branch.
  //
  // A ROW LIKE THIS IS NOT REACHABLE FROM TODAY'S PRODUCER — it publishes a null bound with a null
  // amount — so the property is asserted directly on the renderer rather than through a fixture.
  // That is deliberate: the structure has to hold for whatever the producer publishes next, and a
  // test that could only reach it through today's producer would be a test of today's coincidence.
  workedExample([])
  const page = await pageCells()
  const row = { revenueBase: null, revenueBaseBound: 'upper', grossMarginBase: null, grossMarginBaseBound: 'lower', grossMarginPct: null, grossMarginPctBound: 'indeterminate' }
  assert.equal(page.cellOf('revenue', row), 'Unmatched ≤')
  assert.equal(page.cellOf('margin', row), 'Unmatched ≥')
  assert.equal(page.cellOf('marginPct', row), 'Unmatched ?')
})

test('the credit-share helper refuses a negative share rather than inverting the interval (o3d-rv4a)', async () => {
  // `Σ max(k·e, 0) = k · Σ max(e, 0)` holds only for k >= 0. A negative share would swap the
  // interval's ends and turn a sound ceiling into a claim the figure cannot support, so the helper
  // refuses instead of documenting the precondition. Asserted here because a defensive throw nothing
  // exercises is a comment with a stack trace.
  const { emptyCredits, scaleCredits } = await import('@/lib/domain/sales/refund-credit-buckets')
  assert.throws(() => scaleCredits(emptyCredits(), D('-1'), D('4')), /non-negative share/)
  assert.throws(() => scaleCredits(emptyCredits(), D('1'), D('0')), /non-negative share/)
  // And the share is taken as `value * numerator / denominator`, in that order — the same expression
  // the revenue allocation beside it uses. A third of 100 is 33.33… in both, so the two halves of the
  // subtraction carry the same residual instead of drifting apart.
  const buckets = emptyCredits()
  buckets.net = D('100')
  assert.equal(scaleCredits(buckets, D('1'), D('3')).net.toString(), D('100').mul(1).div(3).toString())
})
