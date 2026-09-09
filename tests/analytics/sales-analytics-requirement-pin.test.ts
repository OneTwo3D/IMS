import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Prisma, ProductType, SalesOrderStatus } from '@/app/generated/prisma/client'
import {
  getMarginAnalyticsReport,
  getReturnsAnalyticsReport,
  type SalesFulfillmentAnalyticsClient,
} from '@/lib/domain/sales/sales-fulfillment-analytics'

/**
 * o3d-4gh9 — MARGIN AND RETURNS READ THE LINE'S PIN, NOT THE CURRENT COMPONENT GRAPH.
 *
 * o3d-kouj pinned each sales line's flat leaf requirements at allocation time, and put ONE seam in
 * front of every reader (`lineFulfillmentRequirements`) so that snapshot-aware and live-graph readers
 * cannot disagree about the same order. Three expansions in
 * lib/domain/sales/sales-fulfillment-analytics.ts remained: the fill-rate reader used the seam, and
 * MARGIN and RETURNS still expanded the CURRENT graph.
 *
 * WHY THAT IS A DEFECT AND NOT A PREFERENCE. For an in-flight or shipped line the current recipe is
 * not what the order was allocated against, so re-composing a kit RETROACTIVELY MOVES a reported
 * figure for orders that shipped weeks ago. Both of these publish numbers, so the wrong answer is
 * quiet: nothing throws, nothing warns, the margin is simply different from what it was yesterday.
 *
 * HOW THESE TESTS ARE BUILT. Each fixture puts the line's PIN and the CURRENT graph in DISAGREEMENT
 * — the kit was allocated as 2 x COMP-A + 1 x COMP-B and has since been re-composed to
 * 4 x COMP-A + 1 x COMP-B — and asserts the figure the pin implies. The control test beside it
 * removes the pin from exactly the same fixture and asserts the OTHER figure, which is what proves
 * the two are distinguishable at all: without it, a reader that had quietly stopped expanding
 * anything would satisfy the first assertion.
 *
 * WHY THE RETURNS SITE NEEDED MORE THAN A CHANGED CALL. The margin site already had the line object
 * in hand and only wanted `fulfillmentRequirements` on its SELECT. The returns site was keyed on
 * `parentProductId` taken off a shipment line, and a pin lives on a LINE — two lines of the same
 * product can legitimately hold snapshots at different graph versions — so it could not read a pin
 * as written. The line is now threaded through, which is the decision o3d-4gh9 said had to be made
 * rather than defaulted.
 */

function decimal(value: string | number): Prisma.Decimal {
  return new Prisma.Decimal(value)
}

/**
 * THE FAKE RETURNS ONLY WHAT THE READER ASKED FOR.
 *
 * WITHOUT THIS THESE TESTS PROVE AN ADJACENT PROPERTY, and the first draft of them did. A fixture
 * that hands back `fulfillmentRequirements` whichever columns the reader selected proves that the
 * reader CALLS the seam — and says nothing about whether the pin can ever reach it. Dropping
 * `fulfillmentRequirements: true` from the production SELECT leaves every call site untouched,
 * makes the snapshot invisible in production, and silently restores the current-graph answer: the
 * whole defect, with the fix still visibly in the source. Both mutations passed the first draft.
 *
 * So the delegate PROJECTS its rows through the `select` it is handed, exactly as the database
 * would. A column the reader does not ask for is not there.
 */
type SelectNode = { select?: Record<string, unknown> } | boolean | undefined

function project<T>(row: T, select: Record<string, unknown> | undefined): T {
  if (!select) return row
  if (Array.isArray(row)) return row.map((entry) => project(entry, select)) as unknown as T
  if (row === null || typeof row !== 'object') return row
  const source = row as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [key, node] of Object.entries(select)) {
    if (node === true) {
      out[key] = source[key]
      continue
    }
    const nested = (node as Exclude<SelectNode, boolean | undefined>)?.select
    if (nested) out[key] = project(source[key], nested as Record<string, unknown>)
  }
  return out as unknown as T
}

/** `findMany` that answers the fixture through the caller's own `select`. */
function selecting<T>(rows: () => T[]) {
  return {
    findMany: async (args?: unknown) => project(
      rows(),
      (args as { select?: Record<string, unknown> } | undefined)?.select,
    ),
  }
}

/** The CURRENT catalogue: the kit has been re-composed since the order was allocated. */
const RECOMPOSED_GRAPH = {
  findMany: async (args?: unknown) => (args as { where: { id: { in: string[] } } }).where.id.in
    .map((id) => (id === 'kit-1'
      ? {
        id,
        type: 'KIT',
        productComponents: [
          // Was 2. A kit re-composed to need twice as much COMP-A.
          { componentId: 'comp-a', qty: decimal('4'), component: { sku: 'COMP-A', type: 'SIMPLE', oversellAllowed: false } },
          { componentId: 'comp-b', qty: decimal('1'), component: { sku: 'COMP-B', type: 'SIMPLE', oversellAllowed: false } },
        ],
      }
      : { id, type: 'SIMPLE', productComponents: [] })),
}

/** What the order was ALLOCATED against, exactly as `captureFulfillmentRequirementSnapshot` writes it. */
const ALLOCATED_RECIPE = {
  version: 1,
  productId: 'kit-1',
  graphVersion: 3,
  capturedAt: '2026-05-30T09:00:00.000Z',
  requirements: [
    { productId: 'comp-a', factor: '2' },
    { productId: 'comp-b', factor: '1' },
  ],
}

function unusedDelegates() {
  const unused = { findMany: async () => [] }
  return {
    salesOrder: unused,
    salesOrderRefund: unused,
    salesOrderRefundLine: unused,
    cogsEntry: unused,
    stockMovement: unused,
    shipment: unused,
    activityLog: unused,
  }
}

// ---------------------------------------------------------------------------
// MARGIN
// ---------------------------------------------------------------------------

function marginClient(pin: unknown): SalesFulfillmentAnalyticsClient {
  return {
    ...unusedDelegates(),
    product: RECOMPOSED_GRAPH,
    salesOrder: selecting(() => [{
        id: 'order-1',
        status: SalesOrderStatus.PROCESSING,
        currency: 'GBP',
        customerId: null,
        customerName: 'Customer A',
        customerEmail: null,
        createdAt: new Date('2026-06-01T12:00:00.000Z'),
        expectedDelivery: null,
        paidAt: null,
        totalForeign: decimal('800'),
        totalBase: decimal('800'),
        taxForeign: decimal('0'),
        taxBase: decimal('0'),
        shippingForeign: decimal('0'),
        shippingBase: decimal('0'),
        discountAmount: decimal('0'),
        shoppingLinks: [],
        lines: [{
          id: 'line-1',
          productId: 'kit-1',
          sku: 'KIT-1',
          description: 'Starter kit',
          qty: decimal('4'),
          totalForeign: decimal('800'),
          totalBase: decimal('800'),
          taxForeign: decimal('0'),
          taxBase: decimal('0'),
          discountAmount: decimal('0'),
          fulfillmentRequirements: pin,
          product: { id: 'kit-1', sku: 'KIT-1', name: 'Starter kit', type: ProductType.KIT, category: { name: 'Kits' } },
        }],
      }]),
    cogsEntry: {
      findMany: async () => [{
        id: 'cogs-a',
        totalCostBase: decimal('140'),
        movement: {
          referenceType: 'SalesOrder',
          referenceId: 'order-1',
          productId: 'comp-a',
          createdAt: new Date('2026-06-01T13:00:00.000Z'),
          product: { sku: 'COMP-A', name: 'Component A', category: null },
          shipmentLine: { line: { productId: 'kit-1', product: { sku: 'KIT-1', name: 'Starter kit', category: { name: 'Kits' } } } },
        },
      }],
    },
    stockMovement: {
      // 4 x COMP-A and 2 x COMP-B left, against line-1.
      findMany: async () => [
        { qty: decimal('4'), referenceId: 'order-1', productId: 'comp-a', shipmentLine: { lineId: 'line-1' } },
        { qty: decimal('2'), referenceId: 'order-1', productId: 'comp-b', shipmentLine: { lineId: 'line-1' } },
      ],
    },
  }
}

async function marginRevenue(pin: unknown): Promise<string | undefined> {
  const report = await getMarginAnalyticsReport(
    { dateFrom: '2026-06-01', dateTo: '2026-06-01' },
    { client: marginClient(pin), now: () => new Date('2026-06-01T15:00:00.000Z') },
  )
  assert.equal(report.rows.length, 1, 'precondition: the kit line produced exactly one margin row')
  assert.equal(report.rows[0]?.productId, 'kit-1')
  return report.rows[0]?.revenueBase
}

test('o3d-4gh9: gross margin prorates revenue against the recipe the order was ALLOCATED from', async () => {
  // 4 x COMP-A + 2 x COMP-B shipped. Against the PIN (2 x A + 1 x B per kit) that is
  // min(4/2, 2/1) = 2 whole kits, so 2 of the 4 ordered kits at GBP200 each = GBP400.
  //
  // MUTATION ROUTE: put `expandFulfillmentRequirementsDecimal(line.productId, 1, graph)` back at
  // lib/domain/sales/sales-fulfillment-analytics.ts (the margin expansion), or drop
  // `fulfillmentRequirements` from either salesOrder loader's line SELECT. The current graph says
  // 4 x A + 1 x B, so coverage becomes min(4/4, 2/1) = 1 kit and this reads '200'.
  assert.equal(await marginRevenue(ALLOCATED_RECIPE), '400')
})

test('o3d-4gh9: with no pin the same fixture reports the CURRENT graph — so the two really differ', async () => {
  // THE CONTROL. Without it the assertion above would also hold for a reader that had stopped
  // expanding anything at all, or for a fixture whose two recipes happened to agree. A line that has
  // never been allocated has no snapshot, and `lineFulfillmentRequirements` then expands the live
  // graph — which is exactly the pre-o3d-kouj behaviour, and here it gives the OTHER answer.
  assert.equal(await marginRevenue(null), '200')
})

// ---------------------------------------------------------------------------
// RETURNS
// ---------------------------------------------------------------------------

function returnsClient(pin: unknown): SalesFulfillmentAnalyticsClient {
  return {
    ...unusedDelegates(),
    product: RECOMPOSED_GRAPH,
    salesOrderRefundLine: {
      findMany: async () => [{
        id: 'refund-line-1',
        refundId: 'refund-1',
        productId: 'kit-1',
        description: 'Starter kit',
        qty: decimal('1'),
        totalBase: decimal('200'),
        product: { id: 'kit-1', sku: 'KIT-1', name: 'Starter kit' },
        refund: {
          id: 'refund-1',
          reason: 'Damaged',
          totalBase: decimal('200'),
          refundedAt: new Date('2026-06-01T12:00:00.000Z'),
          order: { customerName: 'Customer A', lines: [{ productId: 'kit-1', qty: decimal('4') }] },
        },
      }],
    },
    stockMovement: selecting(() => [
      {
        productId: 'comp-a',
        qty: decimal('4'),
        shipmentLine: { lineId: 'sl-1', line: { id: 'line-1', productId: 'kit-1', fulfillmentRequirements: pin } },
      },
      {
        productId: 'comp-b',
        qty: decimal('2'),
        shipmentLine: { lineId: 'sl-1', line: { id: 'line-1', productId: 'kit-1', fulfillmentRequirements: pin } },
      },
    ]),
  }
}

async function returnsShippedQty(pin: unknown): Promise<{ shippedQty?: string; returnRatePct?: string }> {
  const report = await getReturnsAnalyticsReport(
    { dateFrom: '2026-06-01', dateTo: '2026-06-01' },
    { client: returnsClient(pin), now: () => new Date('2026-06-01T15:00:00.000Z') },
  )
  assert.equal(report.rows.length, 1, 'precondition: the kit refund produced exactly one returns row')
  assert.equal(report.rows[0]?.sku, 'KIT-1')
  return { shippedQty: report.rows[0]?.shippedQty, returnRatePct: report.rows[0]?.returnRatePct }
}

test('o3d-4gh9: the returns denominator converts dispatch through the line the goods shipped against', async () => {
  // Same arithmetic as the margin case, in the denominator: min(4/2, 2/1) = 2 whole kits dispatched,
  // one refunded, so a 50% return rate.
  //
  // MUTATION ROUTE: key the expansion back on `parentProductId` and expand `returnsGraph` directly
  // (the pre-o3d-4gh9 shape), or drop `fulfillmentRequirements` from the shipment line's `line`
  // SELECT. The current graph gives min(4/4, 2/1) = 1 kit, so shippedQty reads '1' and the return
  // rate reads '100'.
  assert.deepEqual(await returnsShippedQty(ALLOCATED_RECIPE), { shippedQty: '2', returnRatePct: '50' })
})

test('o3d-4gh9: with no pin the returns denominator reports the CURRENT graph — the control', async () => {
  assert.deepEqual(await returnsShippedQty(null), { shippedQty: '1', returnRatePct: '100' })
})

test('o3d-4gh9: an unreadable pin is REFUSED here too, not silently answered from the live graph', async () => {
  // `lineFulfillmentRequirements` fails closed on a snapshot it cannot read
  // (FulfillmentRequirementSnapshotError), because a line that HAS a snapshot is one the rest of the
  // system believes is protected from graph drift. Asserted at these two readers because they are
  // the ones that just started reading snapshots: a reader that swallowed the error and expanded the
  // live graph would reintroduce the divergence under a claim of correctness.
  await assert.rejects(
    () => marginRevenue({ version: 1, productId: 'kit-1', requirements: [] }),
    /could not be read/,
  )
  await assert.rejects(
    () => returnsShippedQty({ version: 1, productId: 'kit-1', requirements: [] }),
    /could not be read/,
  )
})
