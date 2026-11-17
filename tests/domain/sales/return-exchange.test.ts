import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  MAX_EXCHANGE_LINES,
  RETURN_EXCHANGE_OFF_REFUSAL,
  RETURN_EXCHANGE_SETTING_KEY,
  buildExchangeCatalogue,
  exchangeDefaultUnitPrice,
  exchangeDifference,
  exchangeDifferenceLabel,
  exchangeLineBadge,
  exchangeRequestRefusal,
  resolveReturnExchangeBlock,
  returnExchangeEnabledFromSetting,
  returnExchangeRefusals,
  type ReturnExchangeGateInput,
} from '@/lib/domain/sales/return-exchange'

// Exchanges inside a return: the rules. No database, no network.

const confirmed = (over: Partial<ReturnExchangeGateInput> = {}): ReturnExchangeGateInput => ({
  status: 'PROCESSING', allocations: 1, shipments: 0, accountingInvoiceId: null, wmsPush: false, hasExternalSource: false, ...over,
})

test('the switch is off unless the setting is exactly "true"', () => {
  assert.equal(RETURN_EXCHANGE_SETTING_KEY, 'return_exchange_enabled')
  for (const v of [null, undefined, '', 'false', 'TRUE', '1', 'yes']) assert.equal(returnExchangeEnabledFromSetting(v), false, String(v))
  assert.equal(returnExchangeEnabledFromSetting('true'), true)
})

test('an order IMS can add lines to is allowed, including one with earlier refunds and return expectations (an exchange only adds lines)', () => {
  assert.equal(resolveReturnExchangeBlock(confirmed()), null)
  for (const status of ['PENDING_PAYMENT', 'ON_HOLD', 'PROCESSING', 'ALLOCATED', 'PICKING', 'PACKING']) assert.equal(resolveReturnExchangeBlock(confirmed({ status })), null, status)
  assert.equal(resolveReturnExchangeBlock(confirmed({ refunds: 2, refundStatus: 'PARTIAL', returnExpectations: 1 })), null, 'earlier refunds do not endanger the lines an exchange adds')
  assert.equal(resolveReturnExchangeBlock(confirmed({ accountingInvoiceId: 'INV-1', wmsPush: true, hasExternalSource: true, payments: 1, paid: true })), null, 'a posted invoice, a warehouse push, a shop link and a payment are not blockers')
})

test('the confirmed-order edit gates apply: dispatched, picked or packed, an unposted invoice, the warehouse picking, fee lines, terminal orders', () => {
  for (const status of ['SHIPPED', 'COMPLETED']) assert.equal(resolveReturnExchangeBlock(confirmed({ status }))?.code, 'DISPATCHED', status)
  assert.equal(resolveReturnExchangeBlock(confirmed({ shippedShipments: 1 }))?.code, 'DISPATCHED', 'a partly shipped order is dispatched')
  assert.equal(resolveReturnExchangeBlock(confirmed({ shipments: 1, committedShipments: 1 }))?.code, 'SHIPMENT')
  assert.equal(resolveReturnExchangeBlock(confirmed({ invoiceNotPosted: true }))?.code, 'INVOICE_NOT_POSTED')
  assert.equal(resolveReturnExchangeBlock(confirmed({ status: 'PICKING', wmsPush: true }))?.code, 'WMS_PICKING')
  assert.equal(resolveReturnExchangeBlock(confirmed({ productlessLines: 1 }))?.code, 'FEE_LINES')
  assert.equal(resolveReturnExchangeBlock(confirmed({ status: 'CANCELLED' }))?.code, 'CANCELLED')
  assert.equal(resolveReturnExchangeBlock(confirmed({ status: 'DELIVERED' }))?.code, 'CLOSED')
  assert.equal(resolveReturnExchangeBlock(confirmed({ erased: true }))?.code, 'ERASED')
})

test('three rules of its own: a draft is not returned, a fully refunded order takes no lines, a batch-booked order keeps its total', () => {
  assert.equal(resolveReturnExchangeBlock(confirmed({ status: 'DRAFT' }))?.code, 'EXCHANGE_DRAFT')
  assert.equal(resolveReturnExchangeBlock(confirmed({ status: 'CANCELLED' }))?.code, 'CANCELLED', 'the terminal reason wins over the draft rule')
  assert.equal(resolveReturnExchangeBlock(confirmed({ refundStatus: 'FULL' }))?.code, 'EXCHANGE_FULLY_REFUNDED')
  assert.equal(resolveReturnExchangeBlock(confirmed({ accountingBookedAhead: true }))?.code, 'EXCHANGE_BOOKED_AHEAD')
  // The dispatch reason outranks the fully-refunded one (the order is closed to lines first).
  assert.equal(resolveReturnExchangeBlock(confirmed({ status: 'SHIPPED', refundStatus: 'FULL' }))?.code, 'DISPATCHED')
})

test('every refusal reads as operator wording, names what happened or the remedy, and carries no code, id or remote text', () => {
  const all: string[] = [
    ...Object.values(returnExchangeRefusals),
    RETURN_EXCHANGE_OFF_REFUSAL,
    ...[
      confirmed({ status: 'DRAFT' }), confirmed({ status: 'SHIPPED' }), confirmed({ shipments: 1, committedShipments: 1 }), confirmed({ invoiceNotPosted: true }), confirmed({ status: 'PICKING', wmsPush: true }),
      confirmed({ productlessLines: 1 }), confirmed({ status: 'CANCELLED' }), confirmed({ status: 'DELIVERED' }), confirmed({ erased: true }), confirmed({ refundStatus: 'FULL' }), confirmed({ accountingBookedAhead: true }),
    ].map((input) => resolveReturnExchangeBlock(input)!.reason),
    exchangeRequestRefusal([])!, exchangeRequestRefusal([{ productId: '', qty: 1, unitPriceForeign: 1 }])!, exchangeRequestRefusal([{ productId: 'a', qty: 0, unitPriceForeign: 1 }])!,
    exchangeRequestRefusal([{ productId: 'a', qty: 1, unitPriceForeign: -1 }])!, exchangeRequestRefusal([{ productId: 'a', qty: 1, unitPriceForeign: 1 }, { productId: 'a', qty: 1, unitPriceForeign: 1 }])!,
  ]
  for (const message of all) {
    assert.ok(message.length > 40, message)
    assert.match(message, /[.]$/, `a full sentence: ${message}`)
    assert.doesNotMatch(message, /o3d-|undefined|null|\[object|`|\bSQL\b|Prisma|Error:/, message)
    assert.doesNotMatch(message, /exchange_for_refund_id|exchangeForRefundId/, `no column name: ${message}`)
  }
  // Each one that refuses a write says nothing was written, or points at what to do instead.
  for (const message of Object.values(returnExchangeRefusals)) assert.match(message, /Nothing was recorded|Add replacement|Select the quantity/, message)
  assert.match(RETURN_EXCHANGE_OFF_REFUSAL, /nothing was recorded/i)
  assert.match(RETURN_EXCHANGE_OFF_REFUSAL, /administrator/)
})

test('the request shape: at least one line, a product each (once), a quantity above zero, a price of zero or more, a bounded count', () => {
  assert.equal(exchangeRequestRefusal([{ productId: 'a', qty: 1, unitPriceForeign: 0 }]), null, 'a free replacement is a well-formed line (the server decides whether the order can take it)')
  assert.match(exchangeRequestRefusal(undefined)!, /at least one replacement item/)
  assert.match(exchangeRequestRefusal([{ productId: 'a', qty: Number.NaN, unitPriceForeign: 1 }])!, /quantity above zero/)
  assert.match(exchangeRequestRefusal([{ productId: 'a', qty: 1, unitPriceForeign: Number.POSITIVE_INFINITY }])!, /price of zero or more/)
  assert.match(exchangeRequestRefusal([{ productId: 'a', qty: 1, unitPriceForeign: 1, taxRateId: 5 as unknown as string }])!, /tax rate/)
  const many = Array.from({ length: MAX_EXCHANGE_LINES + 1 }, (_, i) => ({ productId: `p${i}`, qty: 1, unitPriceForeign: 1 }))
  assert.match(exchangeRequestRefusal(many)!, /at most 50/)
})

test('the difference is shown, never moved: even, customer owes, refund due; under a cent is even', () => {
  assert.deepEqual(exchangeDifference({ replacementGross: 12, creditNoteGross: 12 }), { kind: 'EVEN', amount: 0 })
  assert.deepEqual(exchangeDifference({ replacementGross: 12.004, creditNoteGross: 12 }), { kind: 'EVEN', amount: 0 })
  assert.deepEqual(exchangeDifference({ replacementGross: 24, creditNoteGross: 12 }), { kind: 'CUSTOMER_OWES', amount: 12 })
  assert.deepEqual(exchangeDifference({ replacementGross: 6.5, creditNoteGross: 12 }), { kind: 'REFUND_DUE', amount: 5.5 })
  const money = (n: number) => `£${n.toFixed(2)}`
  assert.equal(exchangeDifferenceLabel(exchangeDifference({ replacementGross: 12, creditNoteGross: 12 }), money), 'Even exchange: no money moves.')
  assert.match(exchangeDifferenceLabel(exchangeDifference({ replacementGross: 24, creditNoteGross: 12 }), money), /^Customer owes £12\.00\. IMS does not charge it/)
  assert.match(exchangeDifferenceLabel(exchangeDifference({ replacementGross: 6.5, creditNoteGross: 12 }), money), /^Refund £5\.50\. IMS does not pay it out/)
})

test('the starting price: list or sale price, converted to the order currency and its price basis, never negative', () => {
  const base = { salesPriceBase: '10', salePriceBase: null, salesPriceTaxInclusive: false, pricesIncludeVat: false, rate: 0.2, fxRateToBase: 1 }
  assert.equal(exchangeDefaultUnitPrice(base), 10)
  assert.equal(exchangeDefaultUnitPrice({ ...base, pricesIncludeVat: true }), 12, 'a net list price on a VAT-inclusive order')
  assert.equal(exchangeDefaultUnitPrice({ ...base, salesPriceBase: '12', salesPriceTaxInclusive: true }), 10, 'a gross list price on a net order')
  assert.equal(exchangeDefaultUnitPrice({ ...base, salePriceBase: '8' }), 8, 'the sale price wins when one is set')
  assert.equal(exchangeDefaultUnitPrice({ ...base, fxRateToBase: 1.25 }), 12.5, 'foreign units per base unit')
  assert.equal(exchangeDefaultUnitPrice({ ...base, salesPriceBase: null }), 0)
  assert.equal(exchangeDefaultUnitPrice({ ...base, salesPriceBase: '-3' }), 0)
})

test('the catalogue offers stocked, sellable products only', () => {
  const product = (over: Record<string, unknown>) => ({ id: 'p', sku: 'S', name: 'N', type: 'SIMPLE', lifecycleStatus: 'ACTIVE', salesPriceBase: '10', salePriceBase: null, salesPriceTaxInclusive: false, ...over })
  const rows = buildExchangeCatalogue([product({ id: 'a' }), product({ id: 'v', type: 'VARIABLE' }), product({ id: 'n', type: 'NON_INVENTORY' }), product({ id: 'x', lifecycleStatus: 'DISCONTINUED' }), product({ id: 'e', lifecycleStatus: 'EOL' })], { pricesIncludeVat: false, taxRatePercent: 0.2, fxRateToBase: 1 })
  assert.deepEqual(rows.map((r) => r.id), ['a', 'e'])
  assert.equal(rows[0].defaultUnitPrice, 10)
})

test('a replacement line says which credit note it replaces', () => {
  assert.equal(exchangeLineBadge('CN-0007'), 'Replaces CN-0007')
  assert.equal(exchangeLineBadge(null), 'Exchange replacement')
})

// ---- the wiring (source pins; the behaviour is proven against a real database in tests/concurrency/return-exchange.concurrent.test.ts) ----

test('server-action guards: the offer and the preview ask for the refund permission first; an exchange also asks for edit and process before anything is read or written', async () => {
  const source = await readFile('app/actions/sales.ts', 'utf8')
  const offer = source.slice(source.indexOf('export async function getReturnExchangeOffer'))
  assert.match(offer.slice(0, 200), /await requirePermission\('sales\.refund'\)/)
  const preview = source.slice(source.indexOf('export async function previewReturnExchange'))
  assert.match(preview.slice(0, 250), /await requirePermission\('sales\.refund'\)/)
  const refund = source.slice(source.indexOf('export async function createRefund('))
  const exchangeBlock = refund.slice(refund.indexOf('if (options?.exchange) {'), refund.indexOf('const { getNumberingFormats }'))
  assert.match(exchangeBlock, /if \(isInternal\) return/, 'an internal caller cannot record an exchange')
  const order = ['requirePermission(\'sales.create\')', 'requirePermission(\'sales.process\')', 'readReturnExchangeEnabled()', 'prepareReturnExchange(', 'resolveOrderEditWmsGate(orderId, \'lines\')']
  let at = -1
  for (const needle of order) {
    const next = exchangeBlock.indexOf(needle)
    assert.ok(next > at, `${needle} comes after the previous step`)
    at = next
  }
})

test('the refund transaction checks the exchange under the order lock before anything is written and applies it before the refund is classified', async () => {
  const source = await readFile('lib/domain/sales/refund-service.ts', 'utf8')
  const check = source.indexOf('input.exchange.check(tx)')
  const lockAt = source.indexOf('await lockSalesOrder(tx, input.orderId)')
  const firstWrite = source.indexOf('await tx.salesOrderRefund.create(')
  const apply = source.indexOf('input.exchange.apply(tx')
  const classify = source.indexOf('const newStatus: \'REFUNDED\' | \'PARTIALLY_REFUNDED\' = isFullRefundAmount(')
  assert.ok(lockAt > 0 && check > lockAt && check < firstWrite, 'checked under the lock, before the refund row is written')
  assert.ok(apply > firstWrite && apply < classify, 'applied once the refund exists and before it is classified full or partial')
  assert.match(source, /netOrderTotal \+ \(exchangeApplied\?\.addedNetBase \?\? 0\)/, 'the classification is made against the order WITH the replacement lines')
})

test('the dialog sends no exchange unless the person switched it on, and the order page only offers it when the page said so', async () => {
  const client = await readFile('app/(dashboard)/sales/[id]/so-detail-client.tsx', 'utf8')
  assert.match(client, /\.\.\.\(exchangeOn \? \{ exchange:/)
  assert.match(client, /exchangeOffer\?\.offered === true/)
  assert.match(client, /Confirm that the replacement items do not reach WooCommerce/)
  const page = await readFile('app/(dashboard)/sales/[id]/page.tsx', 'utf8')
  assert.match(page, /hasPermission\(session\.user\.role, 'sales\.refund'\)/)
  assert.match(page, /exchangeOffer\?\.offered/)
})
