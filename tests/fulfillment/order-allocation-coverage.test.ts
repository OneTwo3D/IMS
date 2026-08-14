import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// o3d-9lx: selectOrdersNeedingAllocation is the single source of truth for "which orders still have
// outstanding allocation demand", shared by the replenishment backorder allocator and the periodic
// reallocation sweep. The real (pure) coverage math is exercised; only the product graph and the
// OrderAllocation read are stubbed.

// A SIMPLE product expands to a single leaf requirement of factor 1. Overridable so the
// nested-KIT cases (o3d-i4qd) can supply the unquantized multiplied factors that only a real
// KIT graph produces; every other test leaves the simple default in place.
let expandRequirements: (productId: string) => Map<string, number> =
  (productId: string) => new Map([[productId, 1]])

mock.module('@/lib/products/kit-fulfillment', {
  namedExports: {
    loadFulfillmentProductGraph: async () => ({}),
    expandFulfillmentRequirementsDecimal: (productId: string) => expandRequirements(productId),
  },
})

let allocRows: Array<{ orderId: string; lineId: string; productId: string; qty: number }> = []
let refundLineRows: Array<{ salesOrderLineId: string | null; qty: number; refund: { orderId: string } }> = []

mock.module('@/lib/db', {
  namedExports: {
    db: {
      orderAllocation: {
        findMany: async () => allocRows,
      },
      salesOrderRefundLine: {
        findMany: async () => refundLineRows,
      },
    },
  },
})

async function load() {
  return (await import('@/lib/fulfillment/order-allocation-coverage')).selectOrdersNeedingAllocation
}

function order(id: string, qty: number, productId: string | null = 'p1') {
  return { id, lines: [{ id: `${id}-l1`, qty, productId }] }
}

// Every existing test predates the refund netting; default to "nothing refunded".
function resetRefunds() {
  refundLineRows = []
}

test('an order with no allocations for its ordered line needs allocation', async () => {
  const select = await load()
  resetRefunds()
  allocRows = []
  const needing = await select([order('SO-1', 5)])
  assert.deepEqual(needing.map((o) => o.id), ['SO-1'])
})

test('a fully-allocated order is excluded', async () => {
  const select = await load()
  resetRefunds()
  allocRows = [{ orderId: 'SO-1', lineId: 'SO-1-l1', productId: 'p1', qty: 5 }]
  const needing = await select([order('SO-1', 5)])
  assert.deepEqual(needing, [])
})

test('a partially-allocated order still needs allocation', async () => {
  const select = await load()
  resetRefunds()
  allocRows = [{ orderId: 'SO-1', lineId: 'SO-1-l1', productId: 'p1', qty: 3 }]
  const needing = await select([order('SO-1', 5)])
  assert.deepEqual(needing.map((o) => o.id), ['SO-1'])
})

test('over-allocation (coverage >= qty) is not flagged', async () => {
  const select = await load()
  resetRefunds()
  allocRows = [{ orderId: 'SO-1', lineId: 'SO-1-l1', productId: 'p1', qty: 6 }]
  const needing = await select([order('SO-1', 5)])
  assert.deepEqual(needing, [])
})

test('a line with no productId is ignored (never flags the order)', async () => {
  const select = await load()
  resetRefunds()
  allocRows = []
  const needing = await select([order('SO-1', 5, null)])
  assert.deepEqual(needing, [])
})

test('the lineNeedsAllocation predicate narrows which outstanding lines count', async () => {
  const select = await load()
  resetRefunds()
  allocRows = []
  const orders = [order('SO-1', 5, 'p1'), order('SO-2', 5, 'p2')]
  // Only lines whose requirements touch p2 count -> only SO-2 is returned.
  const needing = await select(orders, (_line, reqs) => reqs.some((r) => r.productId === 'p2'))
  assert.deepEqual(needing.map((o) => o.id), ['SO-2'])
})

test('empty candidate list short-circuits to []', async () => {
  const select = await load()
  resetRefunds()
  assert.deepEqual(await select([]), [])
})

// --- o3d-jby: demand is NET of refunds, matching allocateSalesOrder ---------

test('a partially refunded line covered on NET demand is excluded (o3d-jby)', async () => {
  const select = await load()
  resetRefunds()
  // 10 ordered, 5 refunded, 5 allocated. allocateSalesOrder nets refunds under the lock and
  // considers this fully covered; comparing against GROSS qty here made the selector disagree
  // and hand the order back on every sweep rotation — each one resetting staged allocation
  // accounting and rewriting identical allocations.
  allocRows = [{ orderId: 'SO-1', lineId: 'SO-1-l1', productId: 'p1', qty: 5 }]
  refundLineRows = [{ salesOrderLineId: 'SO-1-l1', qty: 5, refund: { orderId: 'SO-1' } }]

  const needing = await select([order('SO-1', 10)])

  assert.deepEqual(needing.map((o) => o.id), [], 'net demand 5 is fully covered by 5 allocated')
})

test('a partially refunded line still SHORT on net demand is included (o3d-jby)', async () => {
  const select = await load()
  resetRefunds()
  // 10 ordered, 2 refunded, 5 allocated -> net demand 8, still 3 short.
  allocRows = [{ orderId: 'SO-1', lineId: 'SO-1-l1', productId: 'p1', qty: 5 }]
  refundLineRows = [{ salesOrderLineId: 'SO-1-l1', qty: 2, refund: { orderId: 'SO-1' } }]

  const needing = await select([order('SO-1', 10)])

  assert.deepEqual(needing.map((o) => o.id), ['SO-1'], 'netting refunds must not hide real shortfall')
})

test('a fully refunded, unallocated line is not selected forever (o3d-jby)', async () => {
  const select = await load()
  resetRefunds()
  allocRows = []
  refundLineRows = [{ salesOrderLineId: 'SO-1-l1', qty: 10, refund: { orderId: 'SO-1' } }]

  const needing = await select([order('SO-1', 10)])

  assert.deepEqual(needing.map((o) => o.id), [], 'zero net demand is not outstanding demand')
})

test('over-refunding clamps net demand at zero rather than going negative (o3d-jby)', async () => {
  const select = await load()
  resetRefunds()
  allocRows = []
  refundLineRows = [{ salesOrderLineId: 'SO-1-l1', qty: 12, refund: { orderId: 'SO-1' } }]

  const needing = await select([order('SO-1', 10)])

  assert.deepEqual(needing.map((o) => o.id), [])
})

test('refund lines not linked to an order line are ignored (o3d-jby)', async () => {
  const select = await load()
  resetRefunds()
  // A monetary-only refund line carries no salesOrderLineId; it reduces no line's demand.
  allocRows = []
  refundLineRows = [{ salesOrderLineId: null, qty: 10, refund: { orderId: 'SO-1' } }]

  const needing = await select([order('SO-1', 10)])

  assert.deepEqual(needing.map((o) => o.id), ['SO-1'], 'an unlinked refund line must not cancel demand')
})

test('a FULL-refunded order is excluded even with no linked refund lines (o3d-jby)', async () => {
  const select = await load()
  resetRefunds()
  // allocateSalesOrder short-circuits on refundStatus rather than netting lines, so a full
  // MONETARY refund (nothing linked to an order line) is zero demand there. Without the same
  // short-circuit here, gross demand survived and the order was rewritten every rotation.
  allocRows = []
  refundLineRows = []

  const needing = await select([{ ...order('SO-1', 10), refundStatus: 'FULL' }])

  assert.deepEqual(needing.map((o) => o.id), [])
})

test('a PARTIAL refundStatus still uses per-line netting (o3d-jby)', async () => {
  const select = await load()
  resetRefunds()
  allocRows = []
  refundLineRows = []

  const needing = await select([{ ...order('SO-1', 10), refundStatus: 'PARTIAL' }])

  assert.deepEqual(needing.map((o) => o.id), ['SO-1'], 'only FULL is unconditional zero demand')
})

test('a refund linked to ANOTHER order cannot cancel this order\'s demand (o3d-jby)', async () => {
  const select = await load()
  resetRefunds()
  // Nothing in the schema enforces that a refund line's salesOrderLineId belongs to its refund's
  // order, and createSalesOrderRefund does not validate it. Keyed by line id alone, order A's
  // mislinked refund would cancel order B's demand and drop B out of the sweep for good.
  allocRows = []
  refundLineRows = [
    { salesOrderLineId: 'SO-2-l1', qty: 10, refund: { orderId: 'SO-1' } },
  ]

  const needing = await select([order('SO-1', 10), order('SO-2', 10)])

  assert.deepEqual(
    needing.map((o) => o.id).sort(),
    ['SO-1', 'SO-2'],
    'the bad link is inert: it nets against SO-1 (which has no such line) and leaves SO-2 alone',
  )
})

// --- o3d-i4qd: nested KIT precision ------------------------------------------------------
//
// Nested KIT expansion multiplies factors without quantizing (0.3332 x 0.3332 = 0.11102224
// component units per kit) while OrderAllocation.qty is Decimal(12,4), so the writer stores
// 0.1110 — as much of that requirement as the schema can express. Dividing the stored figure
// by the unquantized factor to get kit units reads 0.99979968 of one kit: short by ~2e-4,
// two hundred times the 1e-6 tolerance. The line was therefore reported outstanding on every
// rotation, forever, and no allocation run could ever close it.

/** The factor a two-level KIT of 0.3332-per-level produces. */
const NESTED_FACTOR = 0.3332 * 0.3332
/** What OrderAllocation.qty can actually hold for one kit of that requirement. */
const NESTED_PERSISTED = 0.111

function kitOrder(id: string, qty: number) {
  expandRequirements = () => new Map([['component-1', NESTED_FACTOR]])
  return { id, lines: [{ id: `${id}-l1`, qty, productId: 'kit-1' }] }
}

test('o3d-i4qd: a nested-KIT line allocated to the persisted scale is NOT outstanding', async () => {
  const select = await load()
  resetRefunds()
  const candidate = kitOrder('SO-KIT', 1)
  allocRows = [{ orderId: 'SO-KIT', lineId: 'SO-KIT-l1', productId: 'component-1', qty: NESTED_PERSISTED }]
  const needing = await select([candidate])
  assert.deepEqual(needing, [], 'a line allocated as completely as Decimal(12,4) allows must not be re-selected')
  expandRequirements = (productId: string) => new Map([[productId, 1]])
})

test('o3d-i4qd: a nested-KIT line with NOTHING allocated is still outstanding', async () => {
  const select = await load()
  resetRefunds()
  const candidate = kitOrder('SO-KIT', 1)
  allocRows = []
  const needing = await select([candidate])
  assert.deepEqual(needing.map((o) => o.id), ['SO-KIT'], 'the fix must not make genuine shortfalls invisible')
  expandRequirements = (productId: string) => new Map([[productId, 1]])
})

test('o3d-i4qd: a nested-KIT line short by a whole kit is still outstanding', async () => {
  const select = await load()
  resetRefunds()
  const candidate = kitOrder('SO-KIT', 2)
  // Two kits ordered, one kit's worth of component allocated.
  allocRows = [{ orderId: 'SO-KIT', lineId: 'SO-KIT-l1', productId: 'component-1', qty: NESTED_PERSISTED }]
  const needing = await select([candidate])
  assert.deepEqual(needing.map((o) => o.id), ['SO-KIT'])
  expandRequirements = (productId: string) => new Map([[productId, 1]])
})

test('o3d-i4qd: a nested-KIT line split across warehouses is not re-selected for per-row rounding', async () => {
  const select = await load()
  resetRefunds()
  const candidate = kitOrder('SO-KIT', 2)
  // Each warehouse row rounds independently: 2 x 0.1110 = 0.2220, while the single-row figure
  // for 2 kits would be round(0.22204448, 4) = 0.2220. Both must read as covered.
  allocRows = [
    { orderId: 'SO-KIT', lineId: 'SO-KIT-l1', productId: 'component-1', qty: NESTED_PERSISTED },
    { orderId: 'SO-KIT', lineId: 'SO-KIT-l1', productId: 'component-1', qty: NESTED_PERSISTED },
  ]
  const needing = await select([candidate])
  assert.deepEqual(needing, [])
  expandRequirements = (productId: string) => new Map([[productId, 1]])
})

test('o3d-i4qd: a multi-component KIT missing ONE component is outstanding', async () => {
  const select = await load()
  resetRefunds()
  expandRequirements = () => new Map([['component-1', NESTED_FACTOR], ['component-2', 2]])
  const candidate = { id: 'SO-KIT2', lines: [{ id: 'SO-KIT2-l1', qty: 1, productId: 'kit-1' }] }
  allocRows = [{ orderId: 'SO-KIT2', lineId: 'SO-KIT2-l1', productId: 'component-1', qty: NESTED_PERSISTED }]
  const needing = await select([candidate])
  assert.deepEqual(needing.map((o) => o.id), ['SO-KIT2'], 'a component with no rows at all must still be seen')
  expandRequirements = (productId: string) => new Map([[productId, 1]])
})

// --- o3d-i4qd, Codex adversarial review -------------------------------------------------
//
// The five cases above are guards: they document intent and they pin the KIT-unit division that
// caused the forever-outstanding loop. Three of them, though, also pass with the production change
// reverted, and the split fixture has no actual per-row rounding deficit (0.1110 + 0.1110 IS the
// rounded aggregate 0.2220). The cases below are the mutation-sensitive ones: each FAILS with the
// specific production change it guards reverted, and each is about the SPLIT ALLOWANCE, the
// DECIMAL rounding rule, or the FAIL-CLOSED factor guard rather than about the scale alignment.

/** One kit's worth of a factor that rounds DOWN per row but UP in aggregate. */
const DRIFTING_FACTOR = 0.11104

test('o3d-i4qd: a split line drifting a full ULP is RE-SELECTED, not declared covered', async () => {
  const select = await load()
  resetRefunds()
  // The accepted trade-off. Two warehouses, one kit each: the writer stores round(0.11104, 4) =
  // 0.1110 per row (0.2220 total), while the requirement for the 2-kit line is
  // round(0.22208, 4) = 0.2221. Nothing is actually missing — the deficit is pure independent
  // per-row rounding — but the allowance is capped at half an ULP, so the line is re-selected.
  // Wasted work is the SAFE direction; the alternative (an allowance wide enough to absorb a
  // full ULP) is the bug in the next test. Closing this needs per-warehouse expected quantities,
  // i.e. the writer half of o3d-i4qd.
  expandRequirements = () => new Map([['component-1', DRIFTING_FACTOR]])
  allocRows = [
    { orderId: 'SO-DRIFT', lineId: 'SO-DRIFT-l1', productId: 'component-1', qty: 0.111 },
    { orderId: 'SO-DRIFT', lineId: 'SO-DRIFT-l1', productId: 'component-1', qty: 0.111 },
  ]
  const needing = await select([{ id: 'SO-DRIFT', lines: [{ id: 'SO-DRIFT-l1', qty: 2, productId: 'kit-1' }] }])
  assert.deepEqual(
    needing.map((o) => o.id),
    ['SO-DRIFT'],
    'an allowance that can absorb a full ULP would clear this — and would clear a real shortfall too',
  )
  expandRequirements = (productId: string) => new Map([[productId, 1]])
})

test('o3d-i4qd: two rows one ULP SHORT of the requirement stay outstanding', async () => {
  const select = await load()
  resetRefunds()
  // Same 2-kit nested requirement as the split guard above (required 0.2220), but the second
  // warehouse row is 0.1109 — genuinely one ULP short. Every persisted qty and the quantized
  // requirement are multiples of 1e-4, so ONE ULP is the smallest real shortfall the column can
  // express: an allowance able to reach 1e-4 hides a real one. The old (rows + 1) x half-ULP
  // budget was 1.51e-4 at two rows and did exactly that.
  const candidate = kitOrder('SO-SHORT', 2)
  allocRows = [
    { orderId: 'SO-SHORT', lineId: 'SO-SHORT-l1', productId: 'component-1', qty: NESTED_PERSISTED },
    { orderId: 'SO-SHORT', lineId: 'SO-SHORT-l1', productId: 'component-1', qty: 0.1109 },
  ]
  const needing = await select([candidate])
  assert.deepEqual(needing.map((o) => o.id), ['SO-SHORT'])
  expandRequirements = (productId: string) => new Map([[productId, 1]])
})

test('o3d-i4qd: a whole kit missing across two warehouses at factor 1e-4 is outstanding', async () => {
  const select = await load()
  resetRefunds()
  // Codex's counterexample for the growing split allowance. Factor 0.0001, three kits ordered =>
  // required 0.0003. Two warehouses hold 0.0001 each: 0.0002 persisted, ONE KIT GENUINELY
  // UNALLOCATED. The old allowance of 1.51e-4 declared it covered, so the missing kit would never
  // be allocated and never be reported.
  expandRequirements = () => new Map([['component-1', 0.0001]])
  allocRows = [
    { orderId: 'SO-TINY', lineId: 'SO-TINY-l1', productId: 'component-1', qty: 0.0001 },
    { orderId: 'SO-TINY', lineId: 'SO-TINY-l1', productId: 'component-1', qty: 0.0001 },
  ]
  const needing = await select([{ id: 'SO-TINY', lines: [{ id: 'SO-TINY-l1', qty: 3, productId: 'kit-1' }] }])
  assert.deepEqual(needing.map((o) => o.id), ['SO-TINY'], 'the split allowance must never hide a whole unit')
  expandRequirements = (productId: string) => new Map([[productId, 1]])
})

test('o3d-i4qd: an exact half quantizes the way the DATABASE rounds it, not the way a double does', async () => {
  const select = await load()
  resetRefunds()
  // Net demand 0.0003 at factor 0.5 is exactly 0.00015. Postgres rounds Decimal(12,4) HALF-UP and
  // stores 0.0002, so a row holding 0.0001 is one ULP short and the line is outstanding.
  // `Math.round(0.00015 * 1e4) / 1e4` disagrees: the scaled product of the binary doubles is
  // 1.4999999999999998, which rounds DOWN to 0.0001 and declares the short row sufficient.
  expandRequirements = () => new Map([['component-1', 0.5]])
  const candidate = { id: 'SO-HALF', lines: [{ id: 'SO-HALF-l1', qty: 0.0003, productId: 'kit-1' }] }

  allocRows = [{ orderId: 'SO-HALF', lineId: 'SO-HALF-l1', productId: 'component-1', qty: 0.0001 }]
  assert.deepEqual(
    (await select([candidate])).map((o) => o.id),
    ['SO-HALF'],
    '0.0001 does not cover a requirement the writer would store as 0.0002',
  )

  allocRows = [{ orderId: 'SO-HALF', lineId: 'SO-HALF-l1', productId: 'component-1', qty: 0.0002 }]
  assert.deepEqual(
    (await select([candidate])).map((o) => o.id),
    [],
    'and what the writer WOULD store must read as covered, or the line is outstanding forever',
  )
  expandRequirements = (productId: string) => new Map([[productId, 1]])
})

// ProductComponent.qty has no positivity constraint in the schema, so a zero or negative component
// qty reaches the comparison as an unusable factor. It must make the line OUTSTANDING (what
// calculateDecimalFulfillmentCoverage did by scoring 0), never skip the requirement — skipping is
// fail OPEN and drops a line with positive demand out of the sweep entirely.
for (const [label, factor] of [['zero', 0], ['negative', -2]] as const) {
  test(`o3d-i4qd: a ${label} component factor makes the line outstanding (fail closed)`, async () => {
    const select = await load()
    resetRefunds()
    expandRequirements = () => new Map([['component-1', factor]])
    // Allocated far beyond any plausible requirement: only the guard can decide this case.
    allocRows = [{ orderId: 'SO-BAD', lineId: 'SO-BAD-l1', productId: 'component-1', qty: 500 }]
    const needing = await select([{ id: 'SO-BAD', lines: [{ id: 'SO-BAD-l1', qty: 1, productId: 'kit-1' }] }])
    assert.deepEqual(
      needing.map((o) => o.id),
      ['SO-BAD'],
      'an unusable factor is a data defect to keep visible, not a reason to declare the line covered',
    )
    expandRequirements = (productId: string) => new Map([[productId, 1]])
  })
}

test('o3d-i4qd: a non-finite component factor never reads as covered', async () => {
  const select = await load()
  resetRefunds()
  // NaN cannot survive the shared Decimal conversion (`toDecimal` throws on a non-finite input),
  // so it never reaches the comparison at all — it fails LOUDLY instead of quietly. Either way the
  // one outcome that must be impossible is an empty result, i.e. "nothing needs allocation".
  expandRequirements = () => new Map([['component-1', Number.NaN]])
  allocRows = [{ orderId: 'SO-NAN', lineId: 'SO-NAN-l1', productId: 'component-1', qty: 500 }]
  const outcome = await select([{ id: 'SO-NAN', lines: [{ id: 'SO-NAN-l1', qty: 1, productId: 'kit-1' }] }])
    .then((orders) => orders.map((o) => o.id))
    .catch((error: unknown) => `rejected: ${(error as Error).message}`)
  assert.notDeepEqual(outcome, [], 'a NaN factor must never silently clear an order')
  expandRequirements = (productId: string) => new Map([[productId, 1]])
})
