import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PO_EMAIL_DISABLED_MESSAGE,
  decidePoSend,
  formatPoQty,
  poDocumentColumns,
  poDocumentRows,
  poLayoutFlags,
  poTaxLabel,
  poTotalsRows,
  runPoSend,
  type PoDocumentLine,
} from '../../lib/domain/purchasing/po-document.ts'

const line = (over: Partial<PoDocumentLine> = {}): PoDocumentLine => ({
  sku: 'SKU-1', name: 'Widget', barcode: null, mpn: null, supplierSku: null, qty: 10,
  purchaseUnitQty: null, purchaseUnitAbbreviation: null, stockUnitName: null,
  unitCost: 2.5, discountAmount: 0, total: 25, ...over,
})
const money = (n: number) => `£${n.toFixed(2)}`

test('columns always fill the 495pt content width, whatever optional columns are on', () => {
  for (const showSupplierSku of [false, true]) for (const showPurchaseUnits of [false, true]) {
    const cols = poDocumentColumns('£', { showSupplierSku, showPurchaseUnits })
    assert.equal(cols.reduce((s, c) => s + c.width, 0), 495)
    assert.ok(cols.every((c) => c.width > 0))
  }
})

test('row cell count matches the column count and optional columns follow the flags', () => {
  const lines = [line({ supplierSku: 'S-1', discountAmount: 1.5, total: 23.5, unitCost: 2.35 }), line({ sku: 'SKU-2' })]
  const flags = poLayoutFlags(lines)
  assert.deepEqual(flags, { showSupplierSku: true, showPurchaseUnits: false })
  const cols = poDocumentColumns('£', flags)
  const rows = poDocumentRows(lines, flags)
  assert.ok(rows.every((r) => r.length === cols.length))
  assert.deepEqual(rows[0], ['1', 'SKU-1', 'S-1', 'Widget', '—', '10', '2.35', '23.50'])
  assert.deepEqual(rows[1], ['2', 'SKU-2', '—', 'Widget', '—', '10', '2.50', '25.00'])

  const plain = poLayoutFlags([line()])
  assert.deepEqual(plain, { showSupplierSku: false, showPurchaseUnits: false })
  assert.equal(poDocumentRows([line()], plain)[0].length, poDocumentColumns('£', plain).length)
})

test('purchase-unit quantities show both units', () => {
  assert.equal(formatPoQty(line({ qty: 200, purchaseUnitQty: 2, purchaseUnitAbbreviation: 'box', stockUnitName: 'pcs' })), '2 box (200 pcs)')
  assert.equal(formatPoQty(line({ qty: 7 })), '7')
})

test('totals block: discounts are shown as included, never subtracted again; total is last and strong', () => {
  const rows = poTotalsRows({ subtotal: 90, lineDiscounts: 5, orderDiscount: 5, tax: 18, taxLabel: poTaxLabel('UK Standard Rate', 0.2), additionalCosts: 4, total: 112 }, money)
  assert.deepEqual(rows.map((r) => [r.label, r.amount]), [
    ['Subtotal (after discounts)', '£90.00'],
    ['Discounts included above (lines £5.00 + order £5.00)', '£10.00'],
    ['UK Standard Rate (20%)', '£18.00'],
    ['Additional costs', '£4.00'],
    ['Total', '£112.00'],
  ])
  assert.equal(rows.at(-1)?.strong, true)
  assert.equal(rows[1].muted, true)
})

test('totals block omits rows that are zero', () => {
  const rows = poTotalsRows({ subtotal: 25, lineDiscounts: 0, orderDiscount: 0, tax: 0, taxLabel: 'VAT', additionalCosts: 0, total: 25 }, money)
  assert.deepEqual(rows.map((r) => r.label), ['Subtotal (after discounts)', 'Total'])
  assert.equal(poTaxLabel(null, null), 'VAT')
})

test('decidePoSend needs a plausible supplier address', () => {
  assert.deepEqual(decidePoSend(' orders@supplier.test '), { action: 'queue', to: 'orders@supplier.test' })
  assert.deepEqual(decidePoSend(null), { action: 'skip', reason: 'no_supplier_email' })
  assert.deepEqual(decidePoSend('   '), { action: 'skip', reason: 'no_supplier_email' })
  assert.deepEqual(decidePoSend('not-an-email'), { action: 'skip', reason: 'invalid_supplier_email' })
})

test('runPoSend queues once through the injected outbox and reports it', async () => {
  const queued: string[] = []
  const r = await runPoSend('orders@supplier.test', { isEnabled: async () => true, queue: async (to) => { queued.push(to); return { queued: true } } })
  assert.equal(r.status, 'queued')
  assert.deepEqual(queued, ['orders@supplier.test'])
  assert.match(r.message, /confirmed/)
})

test('runPoSend: an undelivered duplicate is reported, not claimed as a new send', async () => {
  const r = await runPoSend('orders@supplier.test', { isEnabled: async () => true, queue: async () => ({ queued: false }) })
  assert.equal(r.status, 'already_queued')
  assert.match(r.message, /already queued/)
})

test('runPoSend: no supplier address confirms without touching the outbox and says so', async () => {
  let calls = 0
  for (const email of [null, '', 'garbage']) {
    const r = await runPoSend(email, { isEnabled: async () => true, queue: async () => { calls++; return { queued: true } } })
    assert.ok(r.status === 'no_supplier_email' || r.status === 'invalid_supplier_email')
    assert.match(r.message, /nothing was sent/)
  }
  assert.equal(calls, 0)
})

test('runPoSend: a failing outbox never throws, so the confirmation stands', async () => {
  const r = await runPoSend('orders@supplier.test', { isEnabled: async () => true, queue: async () => { throw new Error('db down') } })
  assert.equal(r.status, 'failed')
  assert.match(r.message, /confirmed/)
  assert.match(r.message, /db down/)
})

test('runPoSend: flag OFF confirms with nothing queued and the exact switched-off notice', async () => {
  let calls = 0
  const r = await runPoSend('orders@supplier.test', { isEnabled: async () => false, queue: async () => { calls++; return { queued: true } } })
  assert.equal(r.status, 'disabled')
  assert.equal(r.message, PO_EMAIL_DISABLED_MESSAGE)
  assert.equal(r.message, 'PO confirmed. Emailing POs to suppliers is switched off (Settings > Documents); download the PO PDF and send it to the supplier directly.')
  assert.equal(calls, 0)
})

test('runPoSend: an unreadable flag counts as OFF', async () => {
  let calls = 0
  const r = await runPoSend('orders@supplier.test', { isEnabled: async () => { throw new Error('db') }, queue: async () => { calls++; return { queued: true } } })
  assert.equal(r.status, 'disabled')
  assert.equal(calls, 0)
})

test('a discounted line does not read as discounted twice: 10 x 10 with a 10 discount shows net unit 9, total 90, no discount cell', () => {
  const l = line({ qty: 10, unitCost: 9, discountAmount: 10, total: 90 })
  const flags = poLayoutFlags([l])
  const cols = poDocumentColumns('£', flags)
  const [row] = poDocumentRows([l], flags)
  assert.ok(!cols.some((c) => /discount/i.test(c.label)))
  assert.equal(row.length, cols.length)
  assert.equal(Number(row[row.length - 2]) * Number(row[row.length - 3]), Number(row[row.length - 1]), 'qty x unit cost = total')
  assert.deepEqual(row.slice(-3), ['10', '9.00', '90.00'])
  // The discount is still stated, once, in the totals block.
  const totals = poTotalsRows({ subtotal: 90, lineDiscounts: 10, orderDiscount: 0, tax: 0, taxLabel: 'VAT', additionalCosts: 0, total: 90 }, money)
  assert.ok(totals.some((r) => r.label === 'Discounts included above (lines)' && r.amount === '£10.00'))
})
