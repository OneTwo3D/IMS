import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import type { XeroSupplierPrepayment, XeroSupplierPrepaymentRead } from '@/lib/connectors/xero/prepayments'
import * as fixtures from './po-landed-fixtures'

/**
 * PER-EVENT FX RATES FOR PURCHASING, STEP 2 (o3d-hqvrp.51): the goods of a foreign purchase order are received at the rate of the supplier
 * prepayment the owner recorded in Xero, or at the fx_rates rate of the receipt when there is none, through the ONE helper all three receipt paths
 * use; the landed-cost recalculation keeps each layer's own goods cost. Real PostgreSQL, the REAL receipt action, book-in, alignment and
 * recalculation.
 *
 * A FAKE LEDGER: the Xero prepayment read is replaced by `ledger` below (the reader's own parsing is proved against canned responses in
 * tests/accounting/purchase-event-fx-prepayment.test.ts). Nothing here reaches Xero, Mintsoft or WooCommerce.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const SKIP = { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' } as const
const TENANT = 'tenant-purchfx'

const ledger: { calls: string[]; answer: (reference: string) => XeroSupplierPrepaymentRead } = {
  calls: [],
  answer: () => ({ ok: true, tenantId: TENANT, prepayments: [] }),
}
mock.module('@/lib/connectors/xero/prepayments', {
  namedExports: {
    XERO_PREPAYMENTS_PAGE_SIZE: 100,
    XERO_PREPAYMENT_READ_TIMEOUT_MS: 20_000,
    readXeroSupplierPrepaymentsByReference: async (reference: string) => {
      ledger.calls.push(reference)
      return ledger.answer(reference)
    },
  },
})
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireRole: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireFreshPermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async () => {} } })
mock.module('@/lib/domain/wms/mutation-audit', { namedExports: { recordWmsMutationEvent: async () => {} } })
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })

const { loadEnv, enableStockReceiptPosting, uid, seedPo, addAsn, alignUp, receive, bookIn } = fixtures

const SWITCH = 'purchase_event_fx_rates_enabled'
const PO_RATE = '1.25'
/** seedPo's unit cost in base (5) at PO_RATE: 6.25 foreign. */
const UNIT_FOREIGN = '6.25'

async function setSetting(key: string, value: string | null): Promise<void> {
  const { db } = await import('@/lib/db')
  if (value === null) await db.setting.deleteMany({ where: { key } })
  else await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
}

async function withSwitch<T>(on: boolean, fn: () => Promise<T>): Promise<T> {
  await setSetting(SWITCH, on ? 'true' : 'false')
  try {
    return await fn()
  } finally {
    await setSetting(SWITCH, 'false')
  }
}

/**
 * A fresh three-letter currency per arm, so no other arm's (or file's) rates can be the latest. Removed with its rates after the file: a `currencies`
 * row left behind makes every later file's scratch-database guard refuse the database as an installed application.
 */
const createdCurrencies: string[] = []
async function freshCurrency(): Promise<string> {
  const { db } = await import('@/lib/db')
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  for (;;) {
    const code = `Q${letters[Math.floor(Math.random() * 26)]}${letters[Math.floor(Math.random() * 26)]}`
    if (await db.currency.findUnique({ where: { code } })) continue
    await db.currency.create({ data: { code, name: `purchfx ${code}`, symbol: code } })
    createdCurrencies.push(code)
    return code
  }
}

async function addRate(currency: string, rate: string, fetchedAt: Date): Promise<void> {
  const { db } = await import('@/lib/db')
  await db.fxRate.create({ data: { fromCurrency: 'GBP', toCurrency: currency, rate, fetchedAt, source: 'aelia' } })
}

type ForeignPo = Awaited<ReturnType<typeof seedPo>> & { currency: string; contactId: string; reference: string }

/**
 * A PO_SENT order from the real creation path (GBP, unit 5), turned into a foreign one at PO_RATE with consistent foreign amounts, and its supplier
 * linked to a Xero contact of TENANT. `withPoRate` adds the PO-date row to fx_rates (a day ago), so a fallback finds it unless a later row exists.
 */
async function seedForeignPo(label: string, qtys: number[], options: { withPoRate?: boolean } = {}): Promise<ForeignPo> {
  const { db } = await import('@/lib/db')
  const po = await seedPo(`fx-${label}`, qtys)
  const currency = await freshCurrency()
  if (options.withPoRate !== false) await addRate(currency, PO_RATE, new Date(Date.now() - 86_400_000))
  const row = await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.poId }, select: { reference: true, supplierId: true, subtotalBase: true, totalBase: true, lines: { select: { id: true, totalBase: true } } } })
  await db.purchaseOrder.update({
    where: { id: po.poId },
    data: {
      currency, fxRateToBase: PO_RATE,
      subtotalForeign: row.subtotalBase.mul(PO_RATE).toFixed(4), totalForeign: row.totalBase.mul(PO_RATE).toFixed(4),
    },
  })
  for (const line of row.lines) {
    await db.purchaseOrderLine.update({ where: { id: line.id }, data: { unitCostForeign: UNIT_FOREIGN, totalForeign: line.totalBase.mul(PO_RATE).toFixed(4) } })
  }
  const contactId = `contact-${uid()}`
  await db.supplier.update({ where: { id: row.supplierId }, data: { accountingContactId: contactId, accountingContactProvenance: `xero:${TENANT}` } })
  return { ...po, currency, contactId, reference: row.reference }
}

function prepaymentFor(po: ForeignPo, overrides: Partial<XeroSupplierPrepayment> = {}): XeroSupplierPrepayment {
  return {
    prepaymentId: `pp-${uid()}`, status: 'AUTHORISED', reference: po.reference, contactId: po.contactId, currencyCode: po.currency,
    currencyRate: new Prisma.Decimal('1.6'), total: new Prisma.Decimal('100'), date: '2026-11-20',
    ...overrides,
  }
}

function answerWith(po: ForeignPo, prepayments: XeroSupplierPrepayment[]): void {
  ledger.answer = (reference) => ({ ok: true, tenantId: TENANT, prepayments: reference === po.reference ? prepayments : [] })
}

async function written(po: { poId: string; lines: Array<{ poLineId: string }> }) {
  const { db } = await import('@/lib/db')
  const lineIds = po.lines.map((line) => line.poLineId)
  const [layers, receipts, grir, journals, lock] = await Promise.all([
    db.costLayer.findMany({ where: { poLineId: { in: lineIds } }, orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }], select: { unitCostBase: true, goodsUnitCostBase: true, fxRateToBase: true, receivedQty: true } }),
    db.purchaseReceipt.findMany({ where: { poId: po.poId }, orderBy: { createdAt: 'asc' }, select: { fxRateToBase: true, fxRateSource: true } }),
    db.grirSubledgerMovement.findMany({ where: { poId: po.poId, sourceType: 'RECEIPT' }, select: { baseDelta: true } }),
    db.accountingSyncLog.findMany({ where: { type: 'STOCK_RECEIPT', referenceId: po.poId }, select: { payload: true } }),
    db.purchaseOrderFxLock.findUnique({ where: { poId: po.poId } }),
  ])
  return {
    layers: layers.map((l) => ({ unit: l.unitCostBase.toString(), goods: l.goodsUnitCostBase?.toString() ?? null, rate: l.fxRateToBase?.toString() ?? null, qty: Number(l.receivedQty) })),
    receipts: receipts.map((r) => ({ rate: r.fxRateToBase?.toString() ?? null, source: r.fxRateSource })),
    grir: grir.map((g) => g.baseDelta.toString()),
    journals: journals.map((j) => j.payload as { narration?: string; lines?: Array<{ debit?: number }> }),
    lock,
  }
}

test.before(async () => {
  if (!RUN) return
  loadEnv()
  await enableStockReceiptPosting()
  await setSetting('xero_realised_fx_gain_loss_account', '4900')
  await setSetting('xero_purchase_price_variance_account', '5050')
  await setSetting(SWITCH, 'false')
})

test.after(async () => {
  if (!RUN || createdCurrencies.length === 0) return
  const { db } = await import('@/lib/db')
  await db.fxRate.deleteMany({ where: { toCurrency: { in: createdCurrencies } } })
  await db.currency.deleteMany({ where: { code: { in: createdCurrencies } } })
})

test.beforeEach(() => {
  ledger.calls = []
  ledger.answer = () => ({ ok: true, tenantId: TENANT, prepayments: [] })
})

// ─── OFF: byte-identical ────────────────────────────────────────────────────────────────────────────────────────

test('OFF: a foreign receipt is valued at the PO rate, writes no FX column and asks Xero nothing', SKIP, async () => {
  const po = await seedForeignPo('off', [4])
  answerWith(po, [prepaymentFor(po)])
  const received = await receive(po, po.lines[0]!, 4)
  assert.equal(received.success, true, received.error)
  const after = await written(po)
  console.log(`# OFF: ${JSON.stringify(after.layers)} receipts=${JSON.stringify(after.receipts)} calls=${ledger.calls.length}`)
  assert.deepEqual(after.layers, [{ unit: '5', goods: null, rate: null, qty: 4 }])
  assert.deepEqual(after.receipts, [{ rate: null, source: null }])
  assert.deepEqual(after.grir, ['20'])
  assert.equal(after.lock, null)
  assert.equal(ledger.calls.length, 0)
  assert.doesNotMatch(after.journals[0]?.narration ?? '', /rate/)
})

test('ON, base-currency order: unchanged, no Xero read', SKIP, async () => {
  const po = await seedPo('fx-gbp', [3])
  await withSwitch(true, async () => {
    const received = await receive(po, po.lines[0]!, 3)
    assert.equal(received.success, true, received.error)
  })
  const after = await written(po)
  assert.deepEqual(after.layers, [{ unit: '5', goods: null, rate: null, qty: 3 }])
  assert.deepEqual(after.receipts, [{ rate: null, source: null }])
  assert.equal(ledger.calls.length, 0)
})

// ─── ON: the prepayment rate ────────────────────────────────────────────────────────────────────────────────────

test('ON + one Xero prepayment: goods at its rate on the layer, the receipt, GR/IR and the journal; Xero read once per order', SKIP, async () => {
  const po = await seedForeignPo('pp', [4])
  answerWith(po, [prepaymentFor(po)])
  await withSwitch(true, async () => {
    assert.equal((await receive(po, po.lines[0]!, 2)).success, true)
    assert.equal((await receive(po, po.lines[0]!, 2)).success, true)
  })
  const after = await written(po)
  console.log(`# ON prepayment: ${JSON.stringify(after.layers)} receipts=${JSON.stringify(after.receipts)} grir=${after.grir} calls=${ledger.calls.length}`)
  // 6.25 foreign / 1.6 = 3.90625 per unit (the PO rate would give 5).
  assert.deepEqual(after.layers, [
    { unit: '3.90625', goods: '3.90625', rate: '1.6', qty: 2 },
    { unit: '3.90625', goods: '3.90625', rate: '1.6', qty: 2 },
  ])
  assert.deepEqual(after.receipts, [{ rate: '1.6', source: 'XERO_PREPAYMENT' }, { rate: '1.6', source: 'XERO_PREPAYMENT' }])
  assert.deepEqual(after.grir, ['7.8125', '7.8125'])
  assert.equal(after.journals.length, 2)
  for (const journal of after.journals) {
    assert.equal(journal.lines?.find((l) => typeof l.debit === 'number')?.debit, 7.81)
    assert.match(journal.narration ?? '', /Xero prepayment rate 1\.6 /)
  }
  assert.equal(ledger.calls.length, 1, 'the second receipt reuses the lock: no second Xero read')
  assert.ok(after.lock?.firstUsedAt, 'the lock is marked used')
  assert.equal(after.lock?.rateToBase.toString(), '1.6')
})

// ─── ON: the fallback ───────────────────────────────────────────────────────────────────────────────────────────

test('ON + no prepayment: goods at the fx_rates rate in force at the receipt (not the PO rate)', SKIP, async () => {
  const po = await seedForeignPo('fallback', [4])
  await addRate(po.currency, '1.4', new Date(Date.now() - 60_000))
  await withSwitch(true, async () => {
    const received = await receive(po, po.lines[0]!, 4)
    assert.equal(received.success, true, received.error)
  })
  const after = await written(po)
  console.log(`# ON fallback: ${JSON.stringify(after.layers)} ${JSON.stringify(after.receipts)}`)
  // 6.25 / 1.4 = 4.4642857... -> 4.464286
  assert.deepEqual(after.layers, [{ unit: '4.464286', goods: '4.464286', rate: '1.4', qty: 4 }])
  assert.deepEqual(after.receipts, [{ rate: '1.4', source: 'FX_TABLE' }])
  assert.equal(after.lock, null)
  assert.equal(ledger.calls.length, 1)
  assert.match(after.journals[0]?.narration ?? '', /exchange-rate table rate 1\.4 /)
})

test('ON + no prepayment + no fx_rates rate: refused, nothing written', SKIP, async () => {
  const po = await seedForeignPo('missing', [4], { withPoRate: false })
  const { db } = await import('@/lib/db')
  const stockBefore = await db.stockLevel.findUniqueOrThrow({ where: { productId_warehouseId: { productId: po.lines[0]!.productId, warehouseId: po.warehouseId } } })
  const result = await withSwitch(true, () => receive(po, po.lines[0]!, 4))
  console.log(`# ON missing rate: ${JSON.stringify(result)}`)
  assert.equal(result.success, false)
  assert.match(result.error ?? '', /FX rate|rate for/i)
  const after = await written(po)
  assert.deepEqual(after.layers, [])
  assert.deepEqual(after.receipts, [])
  assert.deepEqual(after.grir, [])
  assert.deepEqual(after.journals, [])
  const stockAfter = await db.stockLevel.findUniqueOrThrow({ where: { productId_warehouseId: { productId: po.lines[0]!.productId, warehouseId: po.warehouseId } } })
  assert.equal(stockAfter.quantity.toString(), stockBefore.quantity.toString())
})

// ─── ON: refusals ───────────────────────────────────────────────────────────────────────────────────────────────

test('ON: an ambiguous or foreign prepayment, a failed read and a supplier with no Xero contact are refused, nothing written, never guessed', SKIP, async () => {
  const { db } = await import('@/lib/db')
  const cases: Array<[string, (po: ForeignPo) => Promise<void>, RegExp]> = [
    ['two prepayments', async (po) => answerWith(po, [prepaymentFor(po), prepaymentFor(po)]), /2 Xero supplier prepayments/],
    ['wrong currency', async (po) => answerWith(po, [prepaymentFor(po, { currencyCode: 'EUR' })]), /is in EUR/],
    ['wrong contact', async (po) => answerWith(po, [prepaymentFor(po, { contactId: 'someone-else' })]), /different contact/],
    ['unlinked supplier', async (po) => {
      answerWith(po, [prepaymentFor(po)])
      const row = await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.poId }, select: { supplierId: true } })
      await db.supplier.update({ where: { id: row.supplierId }, data: { accountingContactProvenance: 'xero:another-org' } })
    }, /not linked to a contact/],
    ['failed read', async () => { ledger.answer = () => ({ ok: false, error: 'HTTP 503' }) }, /Could not read the Xero supplier prepayment/],
  ]
  for (const [label, arrange, message] of cases) {
    ledger.calls = []
    const po = await seedForeignPo(`refuse-${label.replace(/\s/g, '')}`, [2])
    await addRate(po.currency, '1.4', new Date(Date.now() - 60_000)) // a fallback rate exists: a refusal must NOT fall back to it
    await arrange(po)
    const result = await withSwitch(true, () => receive(po, po.lines[0]!, 2))
    const after = await written(po)
    console.log(`# refuse ${label}: ${result.error}`)
    assert.equal(result.success, false, label)
    assert.match(result.error ?? '', message, label)
    assert.deepEqual(after.layers, [], label)
    assert.deepEqual(after.receipts, [], label)
    assert.equal(after.lock, null, label)
  }
})

test('MED-2: with the switch and Xero sync on, a blank purchase price variance account refuses the receipt', SKIP, async () => {
  const po = await seedForeignPo('med2', [2])
  await setSetting('xero_purchase_price_variance_account', '')
  try {
    const result = await withSwitch(true, () => receive(po, po.lines[0]!, 2))
    assert.equal(result.success, false)
    assert.match(result.error ?? '', /Purchase Price Variance \(xero_purchase_price_variance_account\)/)
    assert.deepEqual((await written(po)).layers, [])
  } finally {
    await setSetting('xero_purchase_price_variance_account', '5050')
  }
})

// ─── the WMS book-in and the WMS align-up go through the same helper ────────────────────────────────────────────

test('ON, WMS book-in: the booked-in layer and receipt carry the prepayment rate', SKIP, async () => {
  const po = await seedForeignPo('bookin', [5])
  answerWith(po, [prepaymentFor(po)])
  const asn = await addAsn(po, po.lines[0]!, { expectedQty: 5 })
  const status = await withSwitch(true, () => bookIn(asn, po.lines[0]!, 5, 5))
  const after = await written(po)
  console.log(`# book-in: status=${status} ${JSON.stringify(after.layers)} ${JSON.stringify(after.receipts)}`)
  assert.equal(status, 'processed')
  assert.deepEqual(after.layers, [{ unit: '3.90625', goods: '3.90625', rate: '1.6', qty: 5 }])
  assert.deepEqual(after.receipts, [{ rate: '1.6', source: 'XERO_PREPAYMENT' }])
  assert.deepEqual(after.grir, ['19.53125'])
  assert.equal(ledger.calls.length, 1)
})

test('OFF, WMS book-in: unchanged (PO rate, no FX columns)', SKIP, async () => {
  const po = await seedForeignPo('bookin-off', [5])
  const asn = await addAsn(po, po.lines[0]!, { expectedQty: 5 })
  assert.equal(await bookIn(asn, po.lines[0]!, 5, 5), 'processed')
  const after = await written(po)
  assert.deepEqual(after.layers, [{ unit: '5', goods: null, rate: null, qty: 5 }])
  assert.deepEqual(after.receipts, [{ rate: null, source: null }])
  assert.equal(ledger.calls.length, 0)
})

test('ON, WMS align-up: the aligned layer carries the fallback rate; a refusal leaves stock unchanged', SKIP, async () => {
  const po = await seedForeignPo('align', [6])
  await addRate(po.currency, '1.4', new Date(Date.now() - 60_000))
  await addAsn(po, po.lines[0]!, { expectedQty: 6 })
  const aligned = await withSwitch(true, () => alignUp(po, po.lines[0]!, { delta: 6, imsQty: 0 }))
  const after = await written(po)
  console.log(`# align-up: ${JSON.stringify(aligned)} ${JSON.stringify(after.layers)}`)
  assert.equal(aligned.applied, true, aligned.reason)
  assert.deepEqual(after.layers, [{ unit: '4.464286', goods: '4.464286', rate: '1.4', qty: 6 }])
  assert.deepEqual(after.grir, ['26.785716'])

  const refused = await seedForeignPo('align-refused', [6])
  await addAsn(refused, refused.lines[0]!, { expectedQty: 6 })
  answerWith(refused, [prepaymentFor(refused), prepaymentFor(refused)])
  const result = await withSwitch(true, () => alignUp(refused, refused.lines[0]!, { delta: 6, imsQty: 0 }))
  assert.equal(result.applied, false)
  assert.match(result.reason, /2 Xero supplier prepayments/)
  assert.deepEqual((await written(refused)).layers, [])
})

// ─── landed cost: per layer ─────────────────────────────────────────────────────────────────────────────────────

test('landed-cost recalculation on mixed layers: the legacy layer takes the PO goods cost, the rate-locked layer keeps its own; both take the freight share', SKIP, async () => {
  const { db } = await import('@/lib/db')
  const po = await seedForeignPo('landed', [8])
  assert.equal((await receive(po, po.lines[0]!, 4)).success, true) // switch OFF: a legacy layer at the PO rate
  answerWith(po, [prepaymentFor(po)])
  await withSwitch(true, async () => {
    const received = await receive(po, po.lines[0]!, 4)
    assert.equal(received.success, true, received.error)
  })
  const before = await written(po)
  assert.deepEqual(before.layers.map((l) => [l.unit, l.goods]), [['5', null], ['3.90625', '3.90625']], 'PRECONDITION: one legacy and one locked layer')

  // 16.00 of direct freight over the line's 8 units: +2 per unit.
  await db.freightCostLine.create({ data: { poId: po.poId, description: 'freight', amountForeign: '20.0000', amountBase: '16.0000', vatable: false, distributionMethod: 'BY_VALUE', sortOrder: 0 } })
  const { recalculateDirectLandedCosts } = await import('@/lib/domain/purchasing/landed-cost-service')
  await db.$transaction((tx) => recalculateDirectLandedCosts(tx, po.poId, undefined, { triggeredById: null }), { timeout: 60_000, maxWait: 10_000 })
  const after = await written(po)
  console.log(`# landed recalc: ${JSON.stringify(after.layers)}`)
  assert.deepEqual(after.layers.map((l) => [l.unit, l.goods]), [['7', null], ['5.90625', '3.90625']])
})

// ─── the on-demand read ─────────────────────────────────────────────────────────────────────────────────────────

test('on-demand read: locks a found prepayment, replaces it while unused, keeps it once a receipt used it, and is refused while OFF', SKIP, async () => {
  const { db } = await import('@/lib/db')
  const { readPurchaseOrderXeroPrepayment } = await import('@/app/actions/purchase-orders')
  const po = await seedForeignPo('ondemand', [4])
  const first = prepaymentFor(po)
  answerWith(po, [first])
  const off = await readPurchaseOrderXeroPrepayment(po.poId)
  assert.equal(off.success, false)
  assert.equal(ledger.calls.length, 0)

  await withSwitch(true, async () => {
    const locked = await readPurchaseOrderXeroPrepayment(po.poId)
    assert.equal(locked.success, true, locked.error)
    assert.equal((await db.purchaseOrderFxLock.findUniqueOrThrow({ where: { poId: po.poId } })).xeroPrepaymentId, first.prepaymentId)

    const second = prepaymentFor(po, { currencyRate: new Prisma.Decimal('1.7') })
    answerWith(po, [second])
    const replaced = await readPurchaseOrderXeroPrepayment(po.poId)
    assert.equal(replaced.success, true, replaced.error)
    assert.equal((await db.purchaseOrderFxLock.findUniqueOrThrow({ where: { poId: po.poId } })).rateToBase.toString(), '1.7')

    assert.equal((await receive(po, po.lines[0]!, 4)).success, true)
    answerWith(po, [first])
    const kept = await readPurchaseOrderXeroPrepayment(po.poId)
    assert.equal(kept.success, false)
    assert.match(kept.error ?? '', /never revalued/)
    const lock = await db.purchaseOrderFxLock.findUniqueOrThrow({ where: { poId: po.poId } })
    assert.equal(lock.rateToBase.toString(), '1.7')
    assert.ok(lock.firstUsedAt)
  })
})
