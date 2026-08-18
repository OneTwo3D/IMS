import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-w00 (Codex r2 #3): what the exception inbox OFFERS as places the refunded money can have come
 * from. The loader used to expose `SalesOrder.lines` and nothing else, so a refund that included postage
 * could not be described in the Record-manually dialog at all — the operator could only leave the park
 * open forever or push shipping money onto a goods line, which posts to the wrong account at the wrong
 * VAT. The server action accepting a shipping allocation is only half the remedy; if the row never
 * appears on screen the remedy still cannot be performed.
 *
 * Also pins what each target has LEFT to refund (Codex r2 #2), because offering the original amount
 * after part of it has already been credited invites an allocation the action will refuse.
 */

/** A COHERENT order: £10 @ 20% + £20 @ 0% goods + £5 shipping at the 20% order default = £38.00 gross. */
const ORDER = {
  id: 'so-1',
  orderNumber: 'SO-1001',
  currency: 'GBP',
  taxRatePercent: 0.2,
  taxRateName: 'UK Standard Rate',
  shippingForeign: 5,
  shippingService: 'Royal Mail',
  lines: [
    { id: 'line-1', description: 'Widget', sku: 'WIDGET', totalForeign: 10, taxRate: { name: 'UK Standard Rate', rate: 0.2, reverseCharge: false, accountingTaxType: 'OUTPUT2' } },
    { id: 'line-2', description: 'Book', sku: 'BOOK', totalForeign: 20, taxRate: { name: 'UK Zero Rate', rate: 0, reverseCharge: false, accountingTaxType: 'ZERORATEDOUTPUT' as string | null } },
  ],
}

/**
 * Codex r3 #1: the rate a target is OFFERED at is the rate its credit note will post at, which comes
 * from the accounting tax code the refund line will carry — so the tax rates IMS knows are part of the
 * fixture. Without them every target would be unpriceable and the dialog would offer nothing.
 */
type TaxRateRow = { name: string; rate: number; accountingTaxType: string | null; active: boolean; usedFor: string }
let TAX_RATES: TaxRateRow[] = []
const DEFAULT_TAX_RATES: TaxRateRow[] = [
  { name: 'UK Standard Rate', rate: 0.2, accountingTaxType: 'OUTPUT2', active: true, usedFor: 'SALES' },
  { name: 'UK Zero Rate', rate: 0, accountingTaxType: 'ZERORATEDOUTPUT', active: true, usedFor: 'SALES' },
]

const PARK = {
  id: 'park-1',
  status: 'QUARANTINED',
  entityId: 'so-1',
  externalId: '7101',
  errorMessage: 'not uniformly taxed — record it manually',
  createdAt: new Date('2026-06-05T10:00:00Z'),
  payload: { id: 7101, amount: '18.00' },
}

/** £2.00 net already credited against line-1, and £1.00 of the postage. */
const PRIOR_REFUND_LINES = [
  { salesOrderLineId: 'line-1', lineKind: 'sale', totalForeign: 2, refund: { orderId: 'so-1' } },
  { salesOrderLineId: null, lineKind: 'shipping', totalForeign: 1, refund: { orderId: 'so-1' } },
]

const emptyModel = {
  async findMany() { return [] },
  async findFirst() { return null },
  async findUnique() { return null },
  async count() { return 0 },
  async updateMany() { return { count: 0 } },
  async deleteMany() { return { count: 0 } },
}

mock.module('@/lib/db', {
  namedExports: {
    db: new Proxy({} as Record<string, unknown>, {
      get(_target, property: string) {
        if (property === 'shoppingSyncLog') {
          return { ...emptyModel, async findMany() { return [PARK] }, async count() { return 1 } }
        }
        if (property === 'salesOrder') {
          return { ...emptyModel, async findMany() { return [ORDER] } }
        }
        if (property === 'salesOrderRefundLine') {
          return {
            ...emptyModel,
            async findMany(args: { where?: { refund?: { orderId?: { in?: string[] } } } }) {
              // Scoped the way production scopes it, so an unscoped query would show up here.
              return (args?.where?.refund?.orderId?.in ?? []).includes('so-1') ? PRIOR_REFUND_LINES : []
            },
          }
        }
        if (property === 'taxRate') {
          return { ...emptyModel, async findMany() { return TAX_RATES } }
        }
        return emptyModel
      },
    }),
  },
})
mock.module('@/lib/accounting', {
  namedExports: { getAccountingSettings: async () => ({ reverseChargeSalesTaxType: '' }) },
})
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'user-1' } }),
    requireFreshPermission: async () => ({ user: { id: 'user-1' } }),
    freshAuthFailureResult: () => null,
  },
})
mock.module('@/lib/domain/integrations/outbox-admin', {
  namedExports: {
    IntegrationOutboxAdminError: class extends Error {},
    listIntegrationOutboxAdminRows: async () => ({ rows: [], total: 0 }),
    replayIntegrationOutboxAdminRow: async () => ({ success: true }),
  },
})
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })

test.beforeEach(() => {
  TAX_RATES = DEFAULT_TAX_RATES.map((taxRate) => ({ ...taxRate }))
  ORDER.lines[1].taxRate.accountingTaxType = 'ZERORATEDOUTPUT'
})

test('the Record-manually dialog is offered SHIPPING as well as the order lines (o3d-w00 Codex r2 #3)', async () => {
  const { getExceptionInboxData } = await import('@/app/actions/sync-exceptions')
  const data = await getExceptionInboxData()

  assert.equal(data.refundSyncParks.length, 1)
  const park = data.refundSyncParks[0]
  assert.equal(park.manuallyRecordable, true)
  assert.equal(park.refundGrossForeign, '18.00', 'the figure the allocation is reconciled to')

  const shipping = park.allocationTargets.find((target) => target.kind === 'shipping')
  assert.ok(shipping, 'shipping is an allocation target — without it a postage refund cannot be described')
  assert.equal(shipping?.lineId, null)
  assert.match(shipping?.description ?? '', /Royal Mail/)
  // Posted under the ORDER-DEFAULT identity (what the invoice charged shipping under), not under the
  // zero-rated goods line that happens to be the biggest thing on the order.
  assert.equal(shipping?.vatRate, '0.2')
  // £5.00 charged, £1.00 already credited: £4.00 net left, £4.80 gross — and gross is what the operator
  // enters, so offering the net figure would guarantee a refused allocation.
  assert.equal(shipping?.remainingNetForeign, '4.00')
  assert.equal(shipping?.remainingGrossForeign, '4.80')
})

test('each order line is offered at its OWN rate and its remaining balance (o3d-w00 Codex r2 #2)', async () => {
  const { getExceptionInboxData } = await import('@/app/actions/sync-exceptions')
  const data = await getExceptionInboxData()
  const targets = data.refundSyncParks[0].allocationTargets

  assert.deepEqual(
    targets.filter((target) => target.kind === 'sale').map((target) => ({
      lineId: target.lineId, vatRate: target.vatRate, remainingNetForeign: target.remainingNetForeign, remainingGrossForeign: target.remainingGrossForeign,
    })),
    [
      // £10.00 net at 20%, £2.00 already credited => £8.00 net / £9.60 gross left.
      { lineId: 'line-1', vatRate: '0.2', remainingNetForeign: '8.00', remainingGrossForeign: '9.60' },
      // Zero-rated: gross IS net, so the same figure on both sides — the mixed-rate order that made the
      // automatic conversion impossible in the first place.
      { lineId: 'line-2', vatRate: '0', remainingNetForeign: '20.00', remainingGrossForeign: '20.00' },
    ],
  )
  assert.deepEqual(targets.map((target) => target.unrecordableReason), [null, null, null], 'every target is allocatable')
})

test('a target whose POSTED VAT identity cannot be established is offered as unrecordable (o3d-w00 Codex r3 #1)', async () => {
  // The dialog's rate is the rate the CREDIT NOTE will post at, not the line's nominal one. Strip
  // line-2's accounting tax code and it falls back to the order default (OUTPUT2, 20%) while still
  // showing 0% on the invoice — so an operator entering £20 gross would settle a park with a £24 credit
  // note. The row says so, with the fix, instead of quietly offering a rate that will not be used.
  ORDER.lines[1].taxRate.accountingTaxType = null
  const { getExceptionInboxData } = await import('@/app/actions/sync-exceptions')
  const data = await getExceptionInboxData()
  const targets = data.refundSyncParks[0].allocationTargets

  const book = targets.find((target) => target.lineId === 'line-2')
  assert.match(book?.unrecordableReason ?? '', /Book was charged at 0%/)
  assert.match(book?.unrecordableReason ?? '', /Settings → Tax Rates/)
  // The other targets are untouched — one broken mapping does not close the whole dialog.
  assert.equal(targets.find((target) => target.lineId === 'line-1')?.unrecordableReason, null)
  assert.equal(targets.find((target) => target.kind === 'shipping')?.unrecordableReason, null)
})

test('shipping is unrecordable when the order-default rate is deactivated (o3d-w00 Codex r3 #1)', async () => {
  // Shipping posts under the ACTIVE TaxRate named on the order; deactivate it and there is no identity
  // to post under. The goods lines carry their own codes and stay allocatable.
  TAX_RATES = TAX_RATES.map((taxRate) => taxRate.name === 'UK Standard Rate' ? { ...taxRate, active: false } : taxRate)
  const { getExceptionInboxData } = await import('@/app/actions/sync-exceptions')
  const data = await getExceptionInboxData()
  const targets = data.refundSyncParks[0].allocationTargets

  const shipping = targets.find((target) => target.kind === 'shipping')
  assert.match(shipping?.unrecordableReason ?? '', /order's default VAT identity/)
  assert.equal(targets.find((target) => target.lineId === 'line-1')?.unrecordableReason, null, 'its own code still resolves')
})
