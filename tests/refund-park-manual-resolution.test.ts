import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-w00 (Codex r1 #3): a QUARANTINED refund park used to be a dead end. The refund was refused
 * deliberately — an undeterminable gross→net basis, or an order that is not uniformly taxed — the money
 * had ALREADY left WooCommerce, and the only button on the row was Retry, which re-runs the same
 * refusal against the same order. The park kept counting in the exception inbox and kept blocking order
 * deletion / store rebinding forever, and an operator who reconciled it by hand had no way to say so.
 *
 * These pin the completion path: the operator supplies the one thing IMS cannot derive — which parts of
 * the order the money covered and how much of it each took — and that raises the credit note LINE-LINKED
 * (so each line carries its own VAT identity and the uniform-tax refusal does not apply), stamps the
 * WooCommerce refund id so a redelivery dedups instead of double-crediting, and resolves the park.
 *
 * Codex r2 #2: the allocation is now RECONCILED to the parked refund. Amounts are GROSS and must add up
 * to what the storefront returned — otherwise this path was itself a way to book a figure nobody checked
 * (£1 against a £100 refund cleared the exception forever and left the ledger £99 short).
 *
 * Codex r2 #3: SHIPPING is an allocation target. A refund that included postage previously could not be
 * expressed at all, so the operator's only options were to leave the park open or to push shipping money
 * onto a goods line — wrong account, wrong VAT.
 */

type ParkRow = { id: string; entityId: string | null; externalId: string | null; status: string; errorMessage: string | null; payload: unknown }

/**
 * A COHERENT non-uniformly-taxed order — the commonest quarantine cause. Goods £10 @ 20% + £20 @ 0% +
 * £5 shipping @ the order default 20%: net 35.00, VAT 3.00, gross 38.00. Gross per part: 12.00, 20.00
 * and 6.00. Every fixture below allocates against these, so the amounts add up to a real order.
 *
 * Codex r3 #1: each line also carries the ACCOUNTING TAX CODE its credit note will post under, because
 * that — not `TaxRate.rate` — is what the conversion has to use. The two are separable in this fixture:
 * clearing line-2's `accountingTaxType` makes it fall back to the order default (OUTPUT2, 20%) while its
 * nominal rate stays 0%, which is exactly the divergence that let a park be "reconciled" to a figure the
 * credit note would never come to. A fixture where the nominal rate and the posted identity can never
 * differ would prove nothing about the conversion.
 */
const ORDER = {
  id: 'so-1',
  currency: 'GBP',
  fxRateToBase: 1,
  taxRateName: 'UK Standard Rate' as string | null,
  shippingForeign: 5,
  // Order-level money, so the fixture is a whole order rather than a bag of lines: net 30 of goods +
  // 5 of postage, 3 of VAT, 38 gross. Asserted below.
  //
  // Codex r5 #1: `taxForeign` is also what SHIPPING was charged, because IMS stores no shipping-VAT
  // column — the postage's VAT is the 1.00 the order carries over and above its lines' 2.00. The
  // order's HEADER rate (taxRatePercent) is deliberately absent from this fixture: production may not
  // read it, and a fixture that still offered it could not show that it does not.
  subtotalForeign: 30,
  taxForeign: 3,
  discountAmount: 0,
  // Codex r6 #3: a WooCommerce park belongs to a WooCommerce-imported order, and the link is created in
  // the same write as the order. It is how production knows `taxForeign` is the plain SUM of the
  // components' VAT (nothing netted off it for an order-level discount), which is what makes the
  // shipping residue readable on a discounted order.
  shoppingLinks: [{ connector: 'woocommerce' }],
  totalForeign: 38,
  lines: [
    // Codex r4 #1: each line carries its OWN money — the net it was sold at and the VAT taken on it.
    // That pair, not the TaxRate row it points at, is what the line was CHARGED at, and it is the only
    // figure an admin editing the tax table cannot rewrite. `rate` is still on the taxRate object
    // because the real row has one; production must not read it, and the r4 tests below prove it does
    // not by moving it away from the money.
    { id: 'line-1', productId: 'product-1', externalLineItemId: 501, description: 'Widget @ 20%', totalForeign: 10, taxForeign: 2, taxRate: { rate: 0.2, reverseCharge: false, accountingTaxType: 'OUTPUT2' } },
    { id: 'line-2', productId: 'product-2', externalLineItemId: 502, description: 'Book @ 0%', totalForeign: 20, taxForeign: 0, taxRate: { rate: 0, reverseCharge: false, accountingTaxType: 'ZERORATEDOUTPUT' as string | null } },
  ],
}

/**
 * The tax rates IMS knows, which is how an accounting tax code is PRICED: the credit note posts a NET
 * line under a code and the connector re-grosses it at that code's rate, so IMS can only convert the
 * operator's gross when exactly one sales rate maps to the code.
 */
type TaxRateRow = { name: string; rate: number; accountingTaxType: string | null; active: boolean; usedFor: string }
const TAX_RATES: TaxRateRow[] = [
  { name: 'UK Standard Rate', rate: 0.2, accountingTaxType: 'OUTPUT2', active: true, usedFor: 'SALES' },
  { name: 'UK Zero Rate', rate: 0, accountingTaxType: 'ZERORATEDOUTPUT', active: true, usedFor: 'SALES' },
]

/**
 * Codex r4 #1: an admin editing a VAT rate. The TaxRate row the order's lines point at is the SAME row
 * — so its live `rate` moves with the table, exactly as it does in the database. The order's own money
 * does not move, because it is a record of what was billed.
 */
function editStandardRateTo(newRate: number) {
  state.taxRates = state.taxRates.map((taxRate) =>
    taxRate.name === 'UK Standard Rate' ? { ...taxRate, rate: newRate } : taxRate)
  for (const orderLine of state.order?.lines ?? []) {
    if (orderLine.taxRate.accountingTaxType === 'OUTPUT2') orderLine.taxRate.rate = newRate
  }
}
/** The parked WooCommerce refund: one 20% widget (12.00 gross) plus the postage (6.00 gross). */
const PARKED_GROSS = '18.00'

const state: {
  park: ParkRow | null
  parkQueryStatus: string | null
  landedRefund: { orderId: string; creditNoteNumber: string | null } | null
  order: typeof ORDER | null
  priorRefundLines: Array<{ salesOrderLineId: string | null; lineKind: string | null; totalForeign: number }>
  taxRates: TaxRateRow[]
  reverseChargeSalesTaxType: string
  createRefundCalls: Array<{ orderId: string; lines: unknown[]; reason: string; returnWarehouseId: unknown; options: { externalRefundId?: number; enforcePerTargetBalances?: boolean } }>
  createRefundResult: { success: boolean; error?: string }
  parkUpdates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>
  activity: Array<Record<string, unknown>>
  syncRefundsCalls: number
  returnWarehouse: { id: string } | null
} = {
  park: null,
  parkQueryStatus: null,
  landedRefund: null,
  order: null,
  priorRefundLines: [],
  taxRates: TAX_RATES,
  reverseChargeSalesTaxType: '',
  createRefundCalls: [],
  createRefundResult: { success: true },
  parkUpdates: [],
  activity: [],
  syncRefundsCalls: 0,
  returnWarehouse: { id: 'return-wh' },
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      shoppingSyncLog: {
        async findFirst(args: { where?: { id?: string; status?: string | { in?: string[] } } }) {
          const status = args?.where?.status
          // REFUND_PARK_WHERE passes { in: [...] }; the Record-manually query narrows it to the literal
          // 'QUARANTINED'. Both shapes have to be honoured or the narrowing looks like it happened when
          // it did not.
          state.parkQueryStatus = typeof status === 'string' ? status : null
          if (!state.park || args?.where?.id !== state.park.id) return null
          if (typeof status === 'string' && status !== state.park.status) return null
          if (status && typeof status === 'object' && !(status.in ?? []).includes(state.park.status)) return null
          return state.park
        },
        // Filters on the fields the production where-clauses actually use, so a where that does NOT
        // match cannot silently "succeed" — which is the whole point of the restore-quarantine test.
        async updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }) {
          state.parkUpdates.push(args)
          const where = args.where as { externalId?: string; entityId?: string; status?: string; errorMessage?: string | null }
          const park = state.park
          const matches = park != null &&
            (where.externalId == null || where.externalId === park.externalId) &&
            (where.entityId == null || where.entityId === park.entityId) &&
            (where.status == null || where.status === park.status) &&
            (where.errorMessage === undefined || where.errorMessage === park.errorMessage)
          if (!matches || !park) return { count: 0 }
          state.park = { ...park, status: String(args.data.status ?? park.status) }
          return { count: 1 }
        },
        async findMany() { return state.park ? [{ id: state.park.id }] : [] },
        async deleteMany() { return { count: 0 } },
      },
      shoppingOrderLink: { async findFirst() { return { externalOrderId: '1001' } } },
      salesOrderRefund: { async findFirst() { return state.landedRefund } },
      // What each part of the order has already been credited — the balance the new allocation is capped
      // against, so one line cannot absorb money that came off another. Scoped by orderId the way the
      // production query is, so a query that forgot to scope would return another order's refunds here
      // too rather than silently passing.
      salesOrderRefundLine: {
        async findMany(args: { where?: { refund?: { orderId?: string } } }) {
          if (args?.where?.refund?.orderId !== 'so-1') return []
          return state.priorRefundLines.map((line) => ({ ...line, refund: { orderId: 'so-1' } }))
        },
      },
      salesOrder: { async findUnique() { return state.order } },
      // How an accounting tax code is priced (Codex r3 #1). Returned in full so a production query that
      // forgot to filter deactivated / purchase-only rates would show up here rather than pass silently.
      taxRate: { async findMany() { return state.taxRates } },
      // Codex r7 #3: where returned UNITS go. A quarantine stops the automatic restock, so the hand
      // recording has to perform it — and an org with no default return warehouse has nowhere to put
      // them, which is a refusal with a one-setting remedy rather than a silent write-off.
      warehouse: { async findFirst() { return state.returnWarehouse } },
    },
  },
})
mock.module('@/lib/accounting', {
  namedExports: {
    getAccountingSettings: async () => ({ reverseChargeSalesTaxType: state.reverseChargeSalesTaxType }),
  },
})
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'user-1' } }),
    requireFreshPermission: async () => ({ user: { id: 'user-1' } }),
    freshAuthFailureResult: () => null,
  },
})
mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (entry: Record<string, unknown>) => { state.activity.push(entry) } },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })
mock.module('@/lib/connectors/woocommerce/sync/refund-sync', {
  namedExports: {
    // Stands in for a WooCommerce fetch that FAILS (or omits the refund): syncRefundsForOrder returns 0
    // and nothing re-parks the row, which is exactly the case that used to strand the quarantine.
    syncRefundsForOrder: async () => { state.syncRefundsCalls += 1; return 0 },
  },
})
mock.module('@/app/actions/sales', {
  namedExports: {
    createRefund: async (
      orderId: string,
      lines: unknown[],
      reason: string,
      returnWarehouseId: unknown,
      options: { externalRefundId?: number },
    ) => {
      state.createRefundCalls.push({ orderId, lines, reason, returnWarehouseId, options })
      return state.createRefundResult
    },
  },
})

type Allocation = { lineId: string | null; lineKind: 'sale' | 'shipping'; grossAmountForeign: number }
type Record_ = (parkId: string, allocations: Allocation[], reason: string) => Promise<{ success: boolean; error?: string }>
let action: Record_ | null = null
const recordRefundParkManually: Record_ = async (...args) => {
  if (!action) {
    const module_ = await import('@/app/actions/sync-exceptions')
    action = module_.recordRefundParkManually as unknown as Record_
  }
  return action(...args)
}

const line = (lineId: string, grossAmountForeign: number): Allocation => ({ lineId, lineKind: 'sale', grossAmountForeign })
const shipping = (grossAmountForeign: number): Allocation => ({ lineId: null, lineKind: 'shipping', grossAmountForeign })
/** The allocation that actually settles the parked refund: 12.00 of widget + 6.00 of postage. */
const SETTLING_ALLOCATION: Allocation[] = [line('line-1', 12), shipping(6)]

const QUARANTINE_MESSAGE = 'basis undeterminable — record it manually'
const QUARANTINED_PARK: ParkRow = {
  id: 'park-1',
  entityId: 'so-1',
  externalId: '7101',
  status: 'QUARANTINED',
  errorMessage: QUARANTINE_MESSAGE,
  payload: { id: 7101, amount: PARKED_GROSS, reason: 'Damaged item' },
}

test('the order fixture is a coherent order (o3d-w00)', () => {
  // The lines' OWN money adds up to the order's own money: nothing is asserted about this order that
  // the order does not itself say. A double whose parts exceed its total, or whose parts carry no
  // money at all, proves nothing about a path whose entire job is reconciling amounts.
  const linesNet = ORDER.lines.reduce((sum, orderLine) => sum + orderLine.totalForeign, 0)
  const linesVat = ORDER.lines.reduce((sum, orderLine) => sum + orderLine.taxForeign, 0)
  // What the postage bore, read the way production reads it: the VAT the order records over and above
  // its own lines (Codex r5 #1).
  const shippingVat = ORDER.taxForeign - linesVat
  const shippingRate = shippingVat / ORDER.shippingForeign
  assert.equal(linesNet, ORDER.subtotalForeign, 'the lines ARE the subtotal')
  assert.equal(linesVat + shippingVat, ORDER.taxForeign, 'VAT 3.00 — 2.00 on the widget, 1.00 on the postage')
  assert.equal(shippingRate, 0.2, 'the postage was charged at 20%')
  assert.equal(linesNet + ORDER.shippingForeign + ORDER.taxForeign, ORDER.totalForeign, 'net + VAT = 38.00')
  // The parked refund is one 20% widget (12.00 gross) plus the postage (6.00 gross).
  assert.equal(
    Number(PARKED_GROSS),
    ORDER.lines[0].totalForeign + ORDER.lines[0].taxForeign + ORDER.shippingForeign * (1 + shippingRate),
  )
  // Codex r3 #1 / r4 #1: the tax fixture is coherent too — every line's accounting tax code is priced
  // at the rate that line's OWN MONEY says it was sold at, and the order default prices at the rate the
  // order recorded for shipping. Otherwise the happy-path tests would be passing over an order the
  // conversion should have refused, and a fixture whose charged and posted rates can never differ would
  // say nothing at all about the check that separates them.
  const rateForCode = (code: string | null) =>
    TAX_RATES.filter((taxRate) => taxRate.accountingTaxType === code).map((taxRate) => taxRate.rate)
  for (const orderLine of ORDER.lines) {
    const chargedRate = orderLine.taxForeign / orderLine.totalForeign
    assert.deepEqual(rateForCode(orderLine.taxRate.accountingTaxType), [chargedRate], orderLine.description)
    // And the live row agrees with the money TODAY — which is what makes it a meaningful thing to move.
    assert.equal(orderLine.taxRate.rate, chargedRate, `${orderLine.description}: live row matches the sale`)
  }
  const orderDefault = TAX_RATES.find((taxRate) => taxRate.name === ORDER.taxRateName && taxRate.active)
  assert.equal(orderDefault?.rate, shippingRate, 'the order default prices at the rate shipping was charged')
})

test.beforeEach(() => {
  state.park = { ...QUARANTINED_PARK }
  state.parkQueryStatus = null
  state.landedRefund = null
  state.order = { ...ORDER, lines: ORDER.lines.map((line) => ({ ...line, taxRate: { ...line.taxRate } })) }
  state.priorRefundLines = []
  state.taxRates = TAX_RATES.map((taxRate) => ({ ...taxRate }))
  state.reverseChargeSalesTaxType = ''
  state.createRefundCalls = []
  state.createRefundResult = { success: true }
  state.parkUpdates = []
  state.activity = []
  state.syncRefundsCalls = 0
  state.returnWarehouse = { id: 'return-wh' }
})

test('recording a quarantined refund raises a LINE-LINKED credit note carrying the WooCommerce refund id (o3d-w00 Codex r1 #3)', async () => {
  const result = await recordRefundParkManually(
    'park-1',
    SETTLING_ALLOCATION,
    'WC refund 7101 — 1 widget at 20%, plus the postage',
  )

  assert.equal(result.success, true)
  assert.equal(state.createRefundCalls.length, 1)
  const call = state.createRefundCalls[0]
  // The LINK is the whole point: an unlinked monetary line is what both quarantine refusals reject, and
  // a linked one carries its own line's VAT rate so no header rate has to be guessed. The GROSS the
  // operator entered is converted at that same rate, so 12.00 gross at 20% stores 10.00 net.
  assert.deepEqual(
    (call.lines as Array<{ lineId?: string | null; qty: number; totalBase: number; lineKind?: string }>).map((refundLine) => ({
      lineId: refundLine.lineId, qty: refundLine.qty, totalBase: refundLine.totalBase, lineKind: refundLine.lineKind,
    })),
    [
      { lineId: 'line-1', qty: 0, totalBase: 10, lineKind: 'sale' },
      { lineId: null, qty: 0, totalBase: 5, lineKind: 'shipping' },
    ],
  )
  // Stamped with the Woo refund id, so a later redelivery dedups on it instead of raising a second
  // credit note — the globally unique externalRefundId is the replay key.
  assert.equal(call.options.externalRefundId, 7101)
  // No return warehouse: a hand-recorded monetary refund must not invent an inventory movement.
  assert.equal(call.returnWarehouseId, undefined)
})

test('a refund that included SHIPPING can be expressed, and posts as a shipping line (o3d-w00 Codex r2 #3)', async () => {
  // The defect: the dialog offered order lines only and the action hard-coded lineKind 'sale', so a
  // refund covering postage could not be described at all — leave the park open, or misattribute the
  // money to a goods line at that line's account and VAT. Shipping is now its own target, posted as the
  // unlinked shipping line a chargeback uses, grossed at the ORDER-DEFAULT identity the invoice charged
  // it under (20% here, even though line-2 is zero-rated).
  const result = await recordRefundParkManually('park-1', [shipping(6), line('line-1', 12)], 'postage refunded too')

  assert.equal(result.success, true)
  const lines = state.createRefundCalls[0].lines as Array<{ lineId?: string | null; productId: string | null; lineKind?: string; totalForeign?: number; totalBase: number }>
  const shippingLine = lines.find((refundLine) => refundLine.lineKind === 'shipping')
  assert.ok(shippingLine, 'the shipping allocation reaches the ledger as a shipping line')
  assert.equal(shippingLine?.lineId, null, 'shipping is not on an order line, so it is unlinked')
  assert.equal(shippingLine?.productId, null)
  assert.equal(shippingLine?.totalBase, 5, '6.00 gross at the order default 20% is 5.00 net')
  // And it is recorded as shipping in the audit trail, not buried inside a goods allocation.
  const logged = state.activity[0] as { metadata?: { allocations?: Array<{ lineKind?: string; grossForeign?: number }> } }
  assert.deepEqual(
    logged?.metadata?.allocations?.map((allocation) => ({ lineKind: allocation.lineKind, grossForeign: allocation.grossForeign })),
    [{ lineKind: 'shipping', grossForeign: 6 }, { lineKind: 'sale', grossForeign: 12 }],
  )
})

// ---------------------------------------------------------------------------------------------
// o3d-w00 Codex r7 #3: A QUARANTINE MUST NOT LOSE THE UNITS THAT CAME BACK.
//
// A quarantine stops the refund BEFORE createRefund, so the restock the itemised route would have
// performed never happens. This path — the only remedy a quarantine offers — used to send qty: 0 and no
// return warehouse for every allocation, so the returned units were not merely un-restocked: nothing on
// the refund, nothing in the activity log and nothing in the park recorded that any had been returned
// at all. That is a silent inventory write-off dressed as a refusal, and the posted-VAT fence
// quarantines ITEMISED refunds, which are precisely the ones that carry quantities.
// ---------------------------------------------------------------------------------------------

/** The same £18.00 refund, but ITEMISED: WooCommerce states 2 widgets came back off order line 501. */
const ITEMISED_PARK: ParkRow = {
  ...QUARANTINED_PARK,
  payload: {
    id: 7101,
    amount: PARKED_GROSS,
    reason: 'Damaged item',
    line_items: [{
      id: 9001,
      quantity: -2,
      total: '-10.00',
      total_tax: '-2.00',
      // Woo mints a fresh order-item id per refund line, so the ORDER line is named in the meta — the
      // same link the automatic route matches on.
      meta_data: [{ id: 1, key: '_refunded_item_id', value: '501' }],
    }],
  },
}

test('recording an ITEMISED park brings its units back into stock (o3d-w00 Codex r7 #3)', async () => {
  state.park = { ...ITEMISED_PARK }
  const result = await recordRefundParkManually('park-1', SETTLING_ALLOCATION, 'WC refund 7101 — 2 widgets returned')

  assert.equal(result.success, true)
  const call = state.createRefundCalls[0]
  const lines = call.lines as Array<{ lineId?: string | null; qty: number; lineKind?: string }>
  // The units are the payload's, matched to the IMS line by its external id — the same figures the
  // automatic route would have restocked, not a number the operator typed.
  assert.equal(lines.find((refundLine) => refundLine.lineId === 'line-1')?.qty, 2)
  // Shipping returns no goods however the money was allocated.
  assert.equal(lines.find((refundLine) => refundLine.lineKind === 'shipping')?.qty, 0)
  // And they have somewhere to go: without a return warehouse createSalesOrderRefund performs no
  // inbound movement at all, so the qty alone would still have lost them.
  assert.equal(call.returnWarehouseId, 'return-wh')
  const logged = state.activity[0] as { description?: string; metadata?: { restockedUnits?: number; returnWarehouseId?: string | null } }
  assert.equal(logged?.metadata?.restockedUnits, 2)
  assert.equal(logged?.metadata?.returnWarehouseId, 'return-wh')
  assert.match(String(logged?.description), /2 unit\(s\) were returned to stock/)
})

test('units on a line nobody credited ARE returned (o3d-w00 Codex r8 #2)', async () => {
  // r7 restocked only lines the operator also put money against, on the reasoning that an allocation is
  // what says which part of the order is being refunded. It is not: the PAYLOAD says what physically
  // came back. WooCommerce reports a returned quantity on lines carrying no refundable money — a fully
  // discounted item, a free gift, a line credited on an earlier refund — and the automatic route
  // restocks those units regardless. Filtering by allocation therefore reproduced, on a narrower set of
  // lines, exactly the silent write-off this block was added to end: the units recorded nowhere, and
  // the park closed behind them.
  //
  // Here the storefront returned 2 widgets (credited) AND 1 book (credited nothing — its whole value
  // was discounted away). Both come back.
  state.park = {
    ...ITEMISED_PARK,
    payload: {
      ...(ITEMISED_PARK.payload as Record<string, unknown>),
      line_items: [
        { id: 9001, quantity: -2, total: '-10.00', total_tax: '-2.00', meta_data: [{ id: 1, key: '_refunded_item_id', value: '501' }] },
        { id: 9002, quantity: -1, total: '0.00', total_tax: '0.00', meta_data: [{ id: 2, key: '_refunded_item_id', value: '502' }] },
      ],
    },
  }
  const result = await recordRefundParkManually('park-1', SETTLING_ALLOCATION, 'the widget, the postage, and a returned book')

  assert.equal(result.success, true)
  const call = state.createRefundCalls[0]
  const lines = call.lines as Array<{ lineId?: string | null; qty: number; totalForeign: number; totalBase: number; lineKind?: string }>
  assert.equal(lines.find((refundLine) => refundLine.lineId === 'line-1')?.qty, 2)
  const uncredited = lines.find((refundLine) => refundLine.lineId === 'line-2')
  assert.equal(uncredited?.qty, 1, 'the returned book is on the refund even though it was credited nothing')
  // And it credits nothing: the operator attributed no money to it, and the units are not an excuse to
  // invent some. createSalesOrderRefund keeps a line on qty > 0 OR totalBase > 0.
  assert.equal(uncredited?.totalForeign, 0)
  assert.equal(uncredited?.totalBase, 0)
  // Shipping returns no goods however the money was allocated.
  assert.equal(lines.find((refundLine) => refundLine.lineKind === 'shipping')?.qty, 0)
  assert.equal(call.returnWarehouseId, 'return-wh')
  const logged = state.activity[0] as { description?: string; metadata?: { restockedUnits?: number } }
  assert.equal(logged?.metadata?.restockedUnits, 3)
})

test('a monetary-only park still invents no inventory movement (o3d-w00 Codex r8 #2)', async () => {
  // The other half of the same rule: a park whose payload states no quantities returns no units, so a
  // hand-recorded MONETARY refund neither restocks nor demands a return warehouse. Carrying quantities
  // through independently of the money must not turn every monetary recording into a stock movement.
  state.park = { ...QUARANTINED_PARK }
  const result = await recordRefundParkManually('park-1', SETTLING_ALLOCATION, 'monetary goodwill refund')

  assert.equal(result.success, true)
  const call = state.createRefundCalls[0]
  assert.deepEqual((call.lines as Array<{ qty: number }>).map((refundLine) => refundLine.qty), [0, 0])
  assert.equal(call.returnWarehouseId, undefined, 'nothing came back, so no inventory movement is invented')
})

test('units WooCommerce reports on a line IMS cannot identify are recorded, not refused (o3d-w00 Codex r8 #2)', async () => {
  // Nobody can restock a line that matches no IMS product — the automatic route cannot either — so
  // refusing here would be a dead end for a case with no remedy rather than a safeguard. The units are
  // carried in the audit record instead, which is the only place anyone could go looking for them.
  state.park = {
    ...ITEMISED_PARK,
    payload: {
      ...(ITEMISED_PARK.payload as Record<string, unknown>),
      line_items: [
        { id: 9001, quantity: -2, total: '-10.00', total_tax: '-2.00', meta_data: [{ id: 1, key: '_refunded_item_id', value: '501' }] },
        { id: 9003, quantity: -4, total: '0.00', total_tax: '0.00', meta_data: [{ id: 3, key: '_refunded_item_id', value: '999' }] },
      ],
    },
  }
  const result = await recordRefundParkManually('park-1', SETTLING_ALLOCATION, 'WC refund 7101')

  assert.equal(result.success, true)
  const logged = state.activity[0] as { metadata?: { restockedUnits?: number; unmatchedRefundedQty?: Array<{ externalLineItemId: number; qty: number }> } }
  assert.equal(logged?.metadata?.restockedUnits, 2, 'only the units that matched an IMS line were restocked')
  assert.deepEqual(logged?.metadata?.unmatchedRefundedQty, [{ externalLineItemId: 999, qty: 4 }])
})

test('an itemised park with no default return warehouse is REFUSED, not silently written off (o3d-w00 Codex r7 #3)', async () => {
  // The one outcome that must not be available: recording the money and dropping the units, which
  // afterwards is indistinguishable from a correct recording. The remedy is one setting, and the park
  // stays QUARANTINED and recordable once it is made.
  state.park = { ...ITEMISED_PARK }
  state.returnWarehouse = null
  const result = await recordRefundParkManually('park-1', SETTLING_ALLOCATION, 'WC refund 7101')

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /returned 2 unit\(s\)/)
  assert.match(result.error ?? '', /no active default return warehouse/)
  assert.match(result.error ?? '', /Settings → Warehouses/)
  assert.equal(state.createRefundCalls.length, 0, 'no credit note either — the whole recording is refused')
  assert.equal(state.park?.status, 'QUARANTINED', 'and the park is still there to record once it is fixed')
})

test('a shipping allocation on an order with no shipping charge is refused (o3d-w00 Codex r2 #3)', async () => {
  state.order = { ...ORDER, shippingForeign: 0 }
  const result = await recordRefundParkManually('park-1', [shipping(18)], 'x')

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /carries no shipping charge/)
  assert.equal(state.createRefundCalls.length, 0)
})

test('an allocation that does not settle the parked refund is REFUSED, in both directions (o3d-w00 Codex r2 #2)', async () => {
  // The defect: the action read neither the parked payload nor its amount, so any positive allocation
  // whose lines belonged to the order cleared the park permanently. £1 against an £18 storefront refund
  // marked the exception SYNCED and left the ledger £17 short, with nothing to notice it.
  const under = await recordRefundParkManually('park-1', [line('line-1', 1)], 'under-allocated')
  assert.equal(under.success, false)
  assert.match(under.error ?? '', /comes to 1\.00 gross but WooCommerce refunded 18\.00/)

  const over = await recordRefundParkManually('park-1', [line('line-1', 12), line('line-2', 20), shipping(6)], 'over-allocated')
  assert.equal(over.success, false)
  assert.match(over.error ?? '', /comes to 38\.00 gross but WooCommerce refunded 18\.00/)

  assert.equal(state.createRefundCalls.length, 0, 'no credit note is raised for an amount nobody checked')
  assert.equal(state.parkUpdates.length, 0)
  assert.equal(state.park?.status, 'QUARANTINED')
})

test('the reconciliation is on the GROSS the credit note will come to, not the net stored (o3d-w00 Codex r2 #2)', async () => {
  // 15.00 of net across these targets (10.00 + 5.00) IS the settling split — but entered as if the
  // amounts were net it comes to 15.00 gross, £3 short of the refund. The check is what makes the two
  // bases impossible to confuse.
  const asIfNet = await recordRefundParkManually('park-1', [line('line-1', 10), shipping(5)], 'entered net by mistake')
  assert.equal(asIfNet.success, false)
  assert.match(asIfNet.error ?? '', /comes to 15\.00 gross but WooCommerce refunded 18\.00/)
  assert.match(asIfNet.error ?? '', /GROSS/)
})

test('a park with no stored WooCommerce refund cannot be recorded, and names the way to open it (o3d-w00 Codex r2 #2)', async () => {
  // Nothing to reconcile against — so recording is closed. Not a dead end though: Retry re-reads the
  // refund from WooCommerce and re-parks it WITH the payload (restoring the quarantine if that fetch
  // fails), after which this path works.
  state.park = { ...QUARANTINED_PARK, payload: null }
  const result = await recordRefundParkManually('park-1', SETTLING_ALLOCATION, 'x')

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /does not carry the WooCommerce refund/)
  assert.match(result.error ?? '', /Retry/)
  assert.equal(state.createRefundCalls.length, 0)
  assert.equal(state.park?.status, 'QUARANTINED')
})

test('one part of the order cannot absorb money that came off another (o3d-w00 Codex r2 #2)', async () => {
  // The order total cap in createSalesOrderRefund would let 18.00 gross land entirely on line-1 — the
  // total reconciles, but the credit posts to the wrong account at the wrong VAT. Each target is capped
  // at what it has left.
  const overLine = await recordRefundParkManually('park-1', [line('line-1', 18)], 'all on one line')
  assert.equal(overLine.success, false)
  assert.match(overLine.error ?? '', /Widget @ 20%/)
  assert.match(overLine.error ?? '', /more than it has left to refund/)

  // And earlier refunds count: 6.00 of line-1's 10.00 net is already credited, so the settling 12.00
  // gross (10.00 net) no longer fits.
  state.priorRefundLines = [{ salesOrderLineId: 'line-1', lineKind: 'sale', totalForeign: 6 }]
  const afterPrior = await recordRefundParkManually('park-1', SETTLING_ALLOCATION, 'x')
  assert.equal(afterPrior.success, false)
  assert.match(afterPrior.error ?? '', /after earlier refunds/)

  assert.equal(state.createRefundCalls.length, 0)
  assert.equal(state.park?.status, 'QUARANTINED')
})

test('the same target may not be allocated twice (o3d-w00 Codex r2 #2)', async () => {
  // Two rows for one target each pass their own balance check and together exceed it, and the audit
  // record stops saying where the money went.
  const duplicated = await recordRefundParkManually(
    'park-1',
    [line('line-1', 6), line('line-1', 6), shipping(6)],
    'split across two rows',
  )
  assert.equal(duplicated.success, false)
  assert.match(duplicated.error ?? '', /only once/)
  assert.equal(state.createRefundCalls.length, 0)
})

test('recording a quarantined refund RESOLVES the park so it stops blocking deletion and the inbox (o3d-w00 Codex r1 #3)', async () => {
  await recordRefundParkManually('park-1', SETTLING_ALLOCATION, 'reconciled by hand')

  assert.equal(state.parkUpdates.length, 1)
  assert.equal(state.parkUpdates[0].data.status, 'SYNCED')
  assert.equal(state.parkUpdates[0].data.errorMessage, null)
  // Scoped to this refund AND this order — never to the external id alone, which is shared with any
  // park another order might hold.
  assert.equal(state.parkUpdates[0].where.externalId, '7101')
  assert.equal(state.parkUpdates[0].where.entityId, 'so-1')
  // The evidence an auditor needs: who, which refund, what it was checked against, and exactly what was
  // attributed where — gross as entered and net as stored.
  const logged = state.activity[0] as { action?: string; metadata?: { externalRefundId?: number; allocations?: unknown[]; userId?: string; parkedGrossForeign?: string; restockedUnits?: number } }
  assert.equal(logged?.action, 'wc_refund_park_recorded_manually')
  assert.equal(logged?.metadata?.externalRefundId, 7101)
  assert.equal(logged?.metadata?.userId, 'user-1')
  assert.equal(logged?.metadata?.parkedGrossForeign, '18.00')
  // Codex r7 #3: `qty` is part of the evidence now — a hand-recorded refund that brought units back has
  // to be distinguishable from one that did not, and this park's payload states none.
  assert.deepEqual(logged?.metadata?.allocations, [
    { lineId: 'line-1', lineKind: 'sale', qty: 0, grossForeign: 12, totalForeign: 10, totalBase: 10 },
    { lineId: null, lineKind: 'shipping', qty: 0, grossForeign: 6, totalForeign: 5, totalBase: 5 },
  ])
  assert.equal(logged?.metadata?.restockedUnits, 0)
  assert.equal(state.createRefundCalls[0].returnWarehouseId, undefined, 'a monetary refund invents no inventory movement')
})

test('only a QUARANTINED park can be hand-recorded — a retryable one is left to Retry (o3d-w00 Codex r1 #3)', async () => {
  state.park = { ...QUARANTINED_PARK, status: 'FAILED' }
  const result = await recordRefundParkManually('park-1', SETTLING_ALLOCATION, 'x')

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /no longer quarantined/)
  // A PENDING/FAILED park is an ordinary retryable failure; hand-recording one would race the retry
  // into a duplicate credit note.
  assert.equal(state.parkQueryStatus, 'QUARANTINED')
  assert.equal(state.createRefundCalls.length, 0)
})

test('a refund that has since LANDED is never credited twice (o3d-w00 Codex r1 #3)', async () => {
  state.landedRefund = { orderId: 'so-1', creditNoteNumber: 'CN-1' }
  const sameOrder = await recordRefundParkManually('park-1', SETTLING_ALLOCATION, 'x')
  assert.equal(sameOrder.success, false)
  assert.match(sameOrder.error ?? '', /already been recorded \(credit note CN-1\)/)

  state.landedRefund = { orderId: 'so-OTHER', creditNoteNumber: 'CN-2' }
  const otherOrder = await recordRefundParkManually('park-1', SETTLING_ALLOCATION, 'x')
  assert.equal(otherOrder.success, false)
  assert.match(otherOrder.error ?? '', /already exists on a different order/)

  assert.equal(state.createRefundCalls.length, 0)
})

test('an unattributable or empty allocation is refused, and the park stays open (o3d-w00 Codex r1 #3)', async () => {
  // Deliberately NOT a dismiss button: resolving without a credit note would leave the ledger short by
  // the refunded amount, which is the silent mis-posting this whole fix is about.
  const empty = await recordRefundParkManually('park-1', [line('line-1', 0)], 'x')
  assert.equal(empty.success, false)
  assert.match(empty.error ?? '', /at least one order line or the shipping charge/)

  const noReason = await recordRefundParkManually('park-1', SETTLING_ALLOCATION, '   ')
  assert.equal(noReason.success, false)
  assert.match(noReason.error ?? '', /reason is required/)

  const foreign = await recordRefundParkManually('park-1', [line('line-999', 18)], 'x')
  assert.equal(foreign.success, false)
  assert.match(foreign.error ?? '', /is not on this order/)

  assert.equal(state.createRefundCalls.length, 0)
  assert.equal(state.parkUpdates.length, 0)
  assert.equal(state.park?.status, 'QUARANTINED')
})

test('a refund the ledger refuses leaves the park QUARANTINED and visible (o3d-w00 Codex r1 #3)', async () => {
  state.createRefundResult = { success: false, error: 'Refund total would exceed order total' }
  const result = await recordRefundParkManually('park-1', SETTLING_ALLOCATION, 'ledger says no')

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /exceed order total/)
  // Nothing was resolved: the operator fixes the split and tries again on the same row.
  assert.equal(state.parkUpdates.length, 0)
  assert.equal(state.park?.status, 'QUARANTINED')
})

// ---------------------------------------------------------------------------------------------
// o3d-w00 (Codex r3 #1): the conversion must use the tax identity the credit note ACTUALLY posts
// under, not the order line's nominal rate.
//
// `createSalesOrderRefund` snapshots each refund line's accountingTaxType and the credit-note payload
// sends the NET line under that code with lineAmountsIncludeTax: false, so the connector re-grosses at
// whatever that code is worth. Converting with `TaxRate.rate` instead let the park be resolved as
// "reconciled to £X" while the credit note came to something else entirely — the precise failure the
// reconciliation exists to prevent.
// ---------------------------------------------------------------------------------------------

test('a line whose tax rate has no accounting code is REFUSED, not converted at its nominal rate (o3d-w00 Codex r3 #1)', async () => {
  // The Codex case. line-2 is nominally 0%, so the old conversion stored 20.00 gross as 20.00 "net".
  // But with no accounting tax code of its own the credit note falls back to the ORDER-DEFAULT identity
  // (OUTPUT2, 20%) — exactly as the invoice did — and posts 20.00 net as 24.00 gross against a 20.00
  // storefront refund, with the park closed as reconciled. Refusing is the only honest answer, and the
  // remedy is a mapping an admin can add.
  state.park = { ...QUARANTINED_PARK, payload: { id: 7101, amount: '20.00' } }
  state.order!.lines[1].taxRate.accountingTaxType = null

  const result = await recordRefundParkManually('park-1', [line('line-2', 20)], 'the zero-rated book')

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /Book @ 0% was charged at 0%/)
  // The refusal states the divergence in the only terms that matter: what the credit note would post at.
  assert.match(result.error ?? '', /accounting tax code OUTPUT2, which is 20%/)
  assert.match(result.error ?? '', /Settings → Tax Rates/)
  assert.equal(state.createRefundCalls.length, 0, 'no credit note is raised on a rate that will not be used')
  assert.equal(state.park?.status, 'QUARANTINED')

  // And when the order default is missing too there is NO identity at all — a different refusal, not a
  // silent zero rate.
  state.order = { ...state.order!, taxRateName: null }
  const noIdentity = await recordRefundParkManually('park-1', [line('line-2', 20)], 'the zero-rated book')
  assert.equal(noIdentity.success, false)
  assert.match(noIdentity.error ?? '', /has no accounting tax code/)
  state.order = { ...state.order, taxRateName: ORDER.taxRateName }

  // And with the mapping in place the SAME allocation goes through, storing the true net — so the
  // refusal is about the missing identity, not about the line.
  state.order!.lines[1].taxRate.accountingTaxType = 'ZERORATEDOUTPUT'
  const mapped = await recordRefundParkManually('park-1', [line('line-2', 20)], 'the zero-rated book')
  assert.equal(mapped.success, true)
  const lines = state.createRefundCalls[0].lines as Array<{ totalBase: number }>
  assert.equal(lines[0].totalBase, 20, 'zero-rated: gross IS net')
})

test("shipping is converted at ITS OWN charged rate, not the order's header rate (o3d-w00 Codex r5 #1)", async () => {
  // `SalesOrder.taxRatePercent` is the order's HEADER DEFAULT. It is what createSalesOrder charged
  // shipping at and what the importer resolved for the order as a whole — and on an order whose
  // delivery was taxed unlike its goods it is not the shipping leg's rate. r4 read it as one, so the
  // check compared the posting rate against a figure shipping never bore.
  //
  // (1) ZERO-RATED DELIVERY on 20% goods: 10.00 @ 20% + 20.00 @ 0% + 5.00 of VAT-free postage — the
  // order carries 2.00 of VAT, all of it the widget's, and comes to 37.00 gross. Shipping still posts
  // under the ORDER-DEFAULT identity (OUTPUT2, 20%), so recording the 5.00 of postage would store 4.17
  // net and credit 0.83 of VAT the customer was never charged, against a park that reconciled exactly.
  state.order = { ...state.order!, taxForeign: 2, totalForeign: 37 }
  state.park = { ...QUARANTINED_PARK, payload: { id: 7101, amount: '5.00' } }

  const refused = await recordRefundParkManually('park-1', [shipping(5)], 'the postage only')

  assert.equal(refused.success, false)
  assert.match(refused.error ?? '', /The shipping charge was charged at 0% but/)
  assert.match(refused.error ?? '', /accounting tax code OUTPUT2, which is 20%/)
  // A refusal is only acceptable with a remedy, and both of shipping's are named.
  assert.match(refused.error ?? '', /Settings → Tax Rates/)
  assert.match(refused.error ?? '', /allocate this refund to the order lines it came off/)
  assert.equal(state.createRefundCalls.length, 0, 'no credit note is raised on a rate shipping never bore')
  assert.equal(state.park?.status, 'QUARANTINED')

  // (2) The mirror image, which the header rate refused for nothing: STANDARD-RATED DELIVERY on
  // zero-rated goods. 10.00 + 20.00 of VAT-free goods + 5.00 of postage carrying 1.00 of VAT — the
  // order's whole 1.00 of VAT is the postage's, so shipping was charged 20%, which is exactly what its
  // credit note posts at. 6.00 gross of postage converts to 5.00 net and records.
  state.order = {
    ...state.order,
    taxForeign: 1,
    totalForeign: 36,
    lines: state.order.lines.map((orderLine) => ({
      ...orderLine,
      taxForeign: 0,
      taxRate: { ...orderLine.taxRate, rate: 0, accountingTaxType: 'ZERORATEDOUTPUT' },
    })),
  }
  state.park = { ...QUARANTINED_PARK, payload: { id: 7101, amount: '6.00' } }

  const recorded = await recordRefundParkManually('park-1', [shipping(6)], 'the postage only')

  assert.equal(recorded.success, true)
  assert.deepEqual(
    (state.createRefundCalls[0].lines as Array<{ lineKind?: string; totalBase: number }>)
      .map((refundLine) => ({ lineKind: refundLine.lineKind, totalBase: refundLine.totalBase })),
    [{ lineKind: 'shipping', totalBase: 5 }],
    '6.00 gross of postage at the 20% it was really charged',
  )
})

test('shipping is REFUSED when the order-default identity no longer resolves (o3d-w00 Codex r3 #1)', async () => {
  // An unlinked shipping refund posts under the ACTIVE TaxRate named on the order. Deactivate it and
  // there is no identity at all — the credit note would post the line under whatever the connector
  // defaults to. The goods line, which carries its own code, is unaffected.
  state.taxRates = state.taxRates.map((taxRate) =>
    taxRate.name === 'UK Standard Rate' ? { ...taxRate, active: false } : taxRate)

  const result = await recordRefundParkManually('park-1', SETTLING_ALLOCATION, 'x')

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /Shipping posts under the order's default VAT identity/)
  assert.match(result.error ?? '', /deactivated/)
  assert.equal(state.createRefundCalls.length, 0)

  // Only the shipping leg was blocked: a goods-only allocation on the same order still records.
  state.park = { ...QUARANTINED_PARK, payload: { id: 7101, amount: '12.00' } }
  const goodsOnly = await recordRefundParkManually('park-1', [line('line-1', 12)], 'just the widget')
  assert.equal(goodsOnly.success, true)
})

test('an accounting tax code IMS prices two ways is REFUSED rather than picked from (o3d-w00 Codex r3 #1)', async () => {
  // A second sales rate mapped to OUTPUT2 at a different rate: IMS is being told the code is worth two
  // things, so it cannot say what the credit note would be grossed up by.
  state.taxRates = [...state.taxRates, { name: 'EU Standard Rate', rate: 0.19, accountingTaxType: 'OUTPUT2', active: true, usedFor: 'SALES' }]

  const result = await recordRefundParkManually('park-1', SETTLING_ALLOCATION, 'x')

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /more than one rate/)
  assert.match(result.error ?? '', /0\.19/)
  assert.equal(state.createRefundCalls.length, 0)
})

test('a reverse-charged line is REFUSED until the reverse-charge code is configured (o3d-w00 Codex r3 #1)', async () => {
  // A COHERENT reverse-charged line: 10.00 net with NO VAT taken on it, which is what reverse charge
  // means in the money. Under reverse charge the seller charges no VAT, so gross IS net — but only
  // because the credit note posts under the reverse-charge code. With that setting empty the swap does
  // not happen and the line posts under its base code (OUTPUT2, 20%), which would restate VAT the
  // customer never paid.
  state.park = { ...QUARANTINED_PARK, payload: { id: 7101, amount: '10.00' } }
  state.order!.lines[0].taxForeign = 0
  state.order!.lines[0].taxRate = { rate: 0, reverseCharge: true, accountingTaxType: 'OUTPUT2' }

  const unconfigured = await recordRefundParkManually('park-1', [line('line-1', 10)], 'RC widget')
  assert.equal(unconfigured.success, false)
  assert.match(unconfigured.error ?? '', /reverse-charged/)
  assert.match(unconfigured.error ?? '', /Settings → Accounting/)
  assert.equal(state.createRefundCalls.length, 0)

  // Configure it AND price it (Codex r4 #3 — the code has to be mapped, see below) and the same
  // allocation records, gross unchanged because there is no seller VAT.
  state.reverseChargeSalesTaxType = 'REVERSECHARGE'
  state.taxRates = [...state.taxRates, { name: 'EU Reverse Charge', rate: 0, accountingTaxType: 'REVERSECHARGE', active: true, usedFor: 'SALES' }]
  const configured = await recordRefundParkManually('park-1', [line('line-1', 10)], 'RC widget')
  assert.equal(configured.success, true)
  const lines = state.createRefundCalls[0].lines as Array<{ totalBase: number }>
  assert.equal(lines[0].totalBase, 10, 'reverse charge: gross IS net')
})

test('an UNMAPPED reverse-charge code is REFUSED, not assumed to be 0% (o3d-w00 Codex r4 #3)', async () => {
  // The reverse-charge swap changes the CODE the credit note posts under; it says nothing about what
  // that code is worth. IMS learns a code's rate from one place only — a TaxRate mapped to it — so an
  // UNMAPPED reverse-charge code is not evidence that the credit note grosses up by nothing. Treating
  // it as 0% converts the operator's gross as if no VAT were charged, and if the code turns out to be
  // VAT-bearing on the accounting side the credit note comes to more than the storefront refunded.
  state.park = { ...QUARANTINED_PARK, payload: { id: 7101, amount: '10.00' } }
  state.order!.lines[0].taxForeign = 0
  state.order!.lines[0].taxRate = { rate: 0, reverseCharge: true, accountingTaxType: 'OUTPUT2' }
  state.reverseChargeSalesTaxType = 'REVERSECHARGE'

  const unmapped = await recordRefundParkManually('park-1', [line('line-1', 10)], 'RC widget')
  assert.equal(unmapped.success, false)
  assert.match(unmapped.error ?? '', /no IMS tax rate is mapped to that code/)
  assert.match(unmapped.error ?? '', /An unmapped code is not a 0% one/)
  assert.equal(state.createRefundCalls.length, 0, 'nothing is credited on an assumed rate')

  // The remedy is one an admin can carry out, and it opens the very same row: map a 0% rate to the
  // code. Then the conversion is grounded in the tax table rather than in an assumption.
  state.taxRates = [...state.taxRates, { name: 'EU Reverse Charge', rate: 0, accountingTaxType: 'REVERSECHARGE', active: true, usedFor: 'SALES' }]
  const mapped = await recordRefundParkManually('park-1', [line('line-1', 10)], 'RC widget')
  assert.equal(mapped.success, true)
  const lines = state.createRefundCalls[0].lines as Array<{ totalBase: number }>
  assert.equal(lines[0].totalBase, 10, 'and it is still 0%, now because IMS was told so')
})

test('what a line was CHARGED comes from the order, not from the live tax table (o3d-w00 Codex r4 #1)', async () => {
  // The r3 divergence check compared the identity's rate against the line's LIVE TaxRate.rate — a
  // mutable row. An admin edits UK Standard Rate from 20% to 5% (a rate change, a correction, a new
  // regime) and every past order silently appears to have been sold at 5%: the check then compares
  // today's rate against today's rate and always agrees.
  //
  // The money is unaffected: line-1 still records 10.00 net with 2.00 of VAT taken on it, because that
  // is what the customer paid. So the credit note WOULD re-gross at 5% — 12.00 gross stored as 11.43
  // net, crediting 11.43 of revenue and 0.57 of VAT against a sale of 10.00 + 2.00. The total settles
  // the park to the penny and the VAT return is wrong by 1.43, with nothing to notice it.
  editStandardRateTo(0.05)
  state.park = { ...QUARANTINED_PARK, payload: { id: 7101, amount: '12.00' } }

  const result = await recordRefundParkManually('park-1', [line('line-1', 12)], 'the widget')

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /Widget @ 20% was charged at 20% but/)
  assert.match(result.error ?? '', /accounting tax code OUTPUT2, which is 5%/)
  assert.equal(state.createRefundCalls.length, 0, 'no credit note on a rate the customer never paid')
  assert.equal(state.park?.status, 'QUARANTINED')

  // Shipping is caught the same way, and from the same kind of source: SalesOrder.taxRatePercent is an
  // order column written alongside the money, not a read of the live rate row.
  state.park = { ...QUARANTINED_PARK, payload: { id: 7101, amount: '6.00' } }
  const postage = await recordRefundParkManually('park-1', [shipping(6)], 'the postage')
  assert.equal(postage.success, false)
  assert.match(postage.error ?? '', /The shipping charge was charged at 20% but/)

  // And the zero-rated line is untouched — one edited rate does not close the whole dialog.
  state.park = { ...QUARANTINED_PARK, payload: { id: 7101, amount: '20.00' } }
  const book = await recordRefundParkManually('park-1', [line('line-2', 20)], 'the book')
  assert.equal(book.success, true)
})

test('the identity the gross was converted at is carried into the ledger to be fenced (o3d-w00 Codex r4 #2)', async () => {
  // The conversion here and the posting inside createSalesOrderRefund are two independent reads of the
  // tax table and the accounting settings, so they can disagree — and a credit note posted under an
  // identity nobody divided by is exactly what the reconciliation exists to prevent. The ledger call
  // therefore carries what was assumed, so the transaction can re-check it under the order lock.
  const result = await recordRefundParkManually('park-1', SETTLING_ALLOCATION, 'reconciled by hand')

  assert.equal(result.success, true)
  const options = state.createRefundCalls[0].options as {
    expectedTaxIdentities?: Array<{ lineId: string | null; lineKind: string; accountingTaxType: string; reverseCharge: boolean; vatRate: string }>
  }
  assert.deepEqual(options.expectedTaxIdentities, [
    { lineId: 'line-1', lineKind: 'sale', accountingTaxType: 'OUTPUT2', reverseCharge: false, vatRate: '0.2' },
    { lineId: null, lineKind: 'shipping', accountingTaxType: 'OUTPUT2', reverseCharge: false, vatRate: '0.2' },
  ])
  // The rate carried is the one the gross was actually DIVIDED by, so the fence can catch a rate edited
  // in place — where the code stays identical and only its price moves.
  const submitted = state.createRefundCalls[0].lines as Array<{ lineId: string | null; totalForeign: number }>
  for (const expected of options.expectedTaxIdentities ?? []) {
    const converted = submitted.find((refundLine) => refundLine.lineId === expected.lineId)
    const gross = SETTLING_ALLOCATION.find((allocation) => allocation.lineId === expected.lineId)!.grossAmountForeign
    assert.equal(converted!.totalForeign * (1 + Number(expected.vatRate)), gross)
  }
})

test('the NET lines submitted re-gross to EXACTLY the storefront refund (o3d-w00 Codex r3 #1)', async () => {
  // Codex's closing ask on this finding: the mocked createRefund only proves what was SUBMITTED, so
  // assert the property that actually matters — that re-grossing those net lines at the rate each will
  // post under lands back on the parked figure. The rate is derived here from the fixture's tax table
  // and refund-service's documented fallback rule (line code, else the ACTIVE order-default code), NOT
  // from the production resolver, so this is a cross-check rather than a restatement.
  await recordRefundParkManually('park-1', SETTLING_ALLOCATION, 'reconciled by hand')

  const orderDefaultCode = state.taxRates.find((taxRate) => taxRate.name === ORDER.taxRateName && taxRate.active)?.accountingTaxType ?? null
  const postedRate = (lineId: string | null) => {
    const orderLine = lineId ? ORDER.lines.find((candidate) => candidate.id === lineId) : null
    const code = orderLine ? (orderLine.taxRate.accountingTaxType ?? orderDefaultCode) : orderDefaultCode
    const rates = state.taxRates.filter((taxRate) => taxRate.accountingTaxType === code).map((taxRate) => taxRate.rate)
    assert.equal(rates.length, 1, `exactly one rate prices ${code}`)
    return rates[0]
  }

  const submitted = state.createRefundCalls[0].lines as Array<{ lineId: string | null; totalForeign: number }>
  const creditNoteGross = submitted.reduce((sum, refundLine) => sum + refundLine.totalForeign * (1 + postedRate(refundLine.lineId)), 0)
  assert.equal(creditNoteGross.toFixed(2), Number(PARKED_GROSS).toFixed(2), 'the credit note settles the refund exactly')
})

test('the per-target caps are re-taken inside the refund transaction (o3d-w00 Codex r3 #2)', async () => {
  // The balances this action checks are read outside the refund transaction, so two concurrent
  // recordings against one order would each see the same line as fully refundable. The authoritative
  // cap has to be taken under the order lock, which is why the ledger call asks for it.
  const result = await recordRefundParkManually('park-1', SETTLING_ALLOCATION, 'x')

  assert.equal(result.success, true)
  assert.equal(state.createRefundCalls[0].options.enforcePerTargetBalances, true)
})

let retry: ((id: string) => Promise<{ success: boolean; error?: string; synced?: boolean }>) | null = null
const retryRefundSyncPark = async (id: string) => {
  if (!retry) {
    const module_ = await import('@/app/actions/sync-exceptions')
    retry = module_.retryRefundSyncPark as unknown as typeof retry
  }
  return retry!(id)
}

test('a retry that never reaches the refund RESTORES the quarantine instead of stranding it as PENDING (o3d-w00 Codex r1 #3)', async () => {
  // Retry deliberately transitions QUARANTINED -> PENDING so the sweep dedup stops skipping the refund.
  // When the WooCommerce fetch fails, nothing re-parks the row: it kept the original refusal message but
  // was no longer QUARANTINED, so the Record-manually action — the only thing that CAN resolve it —
  // disappeared from the row. That turned a retry into a one-way trip to a dead end.
  await retryRefundSyncPark('park-1')

  assert.equal(state.syncRefundsCalls, 1, 'the re-fetch was attempted')
  assert.equal(state.park?.status, 'QUARANTINED', 'the quarantine is restored, so Record manually stays available')
  assert.equal(state.park?.errorMessage, QUARANTINE_MESSAGE, 'and it still says why it was refused')
})
