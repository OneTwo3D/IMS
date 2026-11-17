import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { syncWcRefund, type WcRefundSyncDependencies } from '@/lib/connectors/woocommerce/sync/refund-sync'
import type { WcRefund } from '@/lib/connectors/woocommerce/sync/types'
import { toDecimal } from '@/lib/domain/math/decimal'
import {
  SHOP_REFUND_CONNECTOR,
  confirmShopRefundSettlement,
  shopRefundAmountEquals,
  raiseShopRefundTask,
  refundGrossForeign,
  shopRefundQuery,
} from '@/lib/domain/sales/shop-refund-tasks'
import { buildTaxTypeRateIndex } from '@/lib/domain/sales/refund-posted-tax-identity'

/**
 * o3d-zvec.19: "REFUND IN WOOCOMMERCE". IMS-initiated refunds write NOTHING to WooCommerce; one operator task tells a person to pay the customer
 * back there, and the person's later WooCommerce refund is matched to the IMS refund instead of raising a second credit note.
 *
 * Every double below stands in for the database; WooCommerce and Xero are never contacted (tests/no-outbound-network.cjs refuses any socket).
 */

const WC_AMOUNT = '12.00'

function wcRefund(over: Partial<WcRefund> = {}): WcRefund {
  return {
    id: 9001, parent_id: 1001, date_created: '2026-11-17T10:00:00', date_created_gmt: '2026-11-17T10:00:00', amount: WC_AMOUNT, reason: '', refunded_by: 1, refunded_payment: true,
    meta_data: [], line_items: [{ id: 501, name: 'Widget', product_id: 10, variation_id: 0, quantity: -1, tax_class: '', subtotal: '-10.00', subtotal_tax: '-2.00', total: '-10.00', total_tax: '-2.00', sku: 'W', meta_data: [], refund_total: 12 }],
    ...over,
  } as WcRefund
}

type Task = { id: string; externalOrderId: string; status: 'OPEN' | 'DONE'; doneBy: string | null; payload: unknown }
function task(id: string, refundId: string, gross: string | null, over: { currency?: string; cn?: string } = {}): Task {
  return {
    id, externalOrderId: refundId, status: 'OPEN', doneBy: null,
    payload: { orderNumber: 'SO-1', shopRefund: { refundId, creditNoteNumber: over.cn ?? `CN-${refundId}`, currency: over.currency ?? 'GBP', grossForeign: gross, netForeign: '10.00', reasonKind: 'GOODS_RETURNED' } },
  }
}

function world(input: { tasks: Task[]; refunds: Array<{ id: string; externalRefundId: number | null }>; failLink?: boolean }) {
  const tasks = input.tasks
  const refunds = input.refunds.map((refund) => ({ ...refund }))
  const parks: Array<Record<string, unknown>> = []
  const activity: Array<Record<string, unknown>> = []
  let createRefundCalls = 0
  const taskDouble = {
    async findMany() { return tasks.filter((t) => t.status === 'OPEN') },
    async updateMany(args: { where: { id: string; status: 'OPEN' }; data: { status: 'DONE'; doneBy: string } }) {
      const row = tasks.find((t) => t.id === args.where.id && t.status === args.where.status)
      if (!row) return { count: 0 }
      row.status = args.data.status
      row.doneBy = args.data.doneBy
      return { count: 1 }
    },
  }
  const refundDouble = {
    async findMany(args: { where: { id: { in: string[] }; externalRefundId: null } }) {
      return refunds.filter((r) => args.where.id.in.includes(r.id) && r.externalRefundId === null).map((r) => ({ id: r.id }))
    },
    async findFirst(args: { where: { externalRefundId?: number } }) { const row = refunds.find((r) => r.externalRefundId === args.where.externalRefundId); return row ? { orderId: 'so-1' } : null },
    async updateMany(args: { where: { id: string; externalRefundId: null }; data: { externalRefundId: number } }) {
      const row = refunds.find((r) => r.id === args.where.id && r.externalRefundId === null)
      if (!row) return { count: 0 }
      row.externalRefundId = args.data.externalRefundId
      return { count: 1 }
    },
  }
  const logs = {
    async findFirst() { return null },
    async create(args: { data: Record<string, unknown> }) { parks.push(args.data); return { id: `log-${parks.length}` } },
    async update() { return null },
    async updateMany() { return { count: 0 } },
  }
  const deps = {
    db: {
      async $transaction(cb: (tx: unknown) => unknown) {
        return cb({ async $executeRaw() { return 0 }, async $queryRaw() { return [{ id: 'so-1' }] }, wmsOperatorTask: taskDouble, salesOrderRefund: refundDouble, shoppingSyncLog: logs })
      },
      salesOrder: { async findFirst() { return { id: 'so-1', externalOrderNumber: 'WC-1001', fxRateToBase: 1, currency: 'GBP', totalBase: 12, taxBase: 2, taxRatePercent: 0.2, shippingBase: 0, lines: [] } } },
      salesOrderRefund: refundDouble,
      wmsOperatorTask: taskDouble,
      warehouse: { async findFirst() { return { id: 'wh' } } },
      organisation: { async findFirst() { return { baseCurrency: 'GBP' } } },
      shoppingSyncLog: logs,
    } as unknown as WcRefundSyncDependencies['db'],
    async createRefund() { createRefundCalls += 1; return { success: true as const } },
    async logActivity(entry: Record<string, unknown>) { activity.push(entry) },
  } as unknown as WcRefundSyncDependencies
  return { deps, tasks, refunds, parks, activity, get createRefundCalls() { return createRefundCalls } }
}

test('an equal-amount WooCommerce refund on an order with an open task is PARKED, never swallowed: nothing linked, no credit note, the task stays open', async () => {
  const w = world({ tasks: [task('t1', 'ims-r1', '12.00', { cn: 'CN-77' })], refunds: [{ id: 'ims-r1', externalRefundId: null }] })
  const result = await syncWcRefund(1001, wcRefund(), w.deps)
  assert.equal(result.outcome, 'quarantined-refusal')
  assert.equal(w.createRefundCalls, 0, 'no credit note is raised for it yet')
  assert.equal(w.refunds[0].externalRefundId, null, 'IMS does not link on its own: it cannot tell it from a separate refund')
  assert.equal(w.tasks[0].status, 'OPEN')
  assert.equal(w.parks.length, 1)
  assert.equal(w.parks[0].status, 'QUARANTINED')
  const message = String(w.parks[0].errorMessage)
  assert.match(message, /12\.00 GBP/)
  assert.match(message, /CN-77: 12\.00 GBP/)
  assert.match(message, /choose "Confirm this WooCommerce refund settles IMS refund"/)
  assert.match(message, /separate refund/)
  assert.match(message, /writes no marker to WooCommerce/)
  assert.equal(w.activity.length, 1)
  // a redelivery stays parked: still nothing created or linked
  assert.equal((await syncWcRefund(1001, wcRefund(), w.deps)).outcome, 'quarantined-refusal')
  assert.equal(w.createRefundCalls, 0)
})

test('a different amount is parked too, with both figures, and the message offers no confirm choice', async () => {
  const w = world({ tasks: [task('t1', 'ims-r1', '12.00', { cn: 'CN-77' })], refunds: [{ id: 'ims-r1', externalRefundId: null }] })
  const result = await syncWcRefund(1001, wcRefund({ amount: '9.50' }), w.deps)
  assert.equal(result.outcome, 'quarantined-refusal')
  assert.equal(w.createRefundCalls, 0)
  assert.equal(w.refunds[0].externalRefundId, null)
  const message = String(w.parks[0].errorMessage)
  assert.match(message, /9\.50 GBP/)
  assert.match(message, /CN-77: 12\.00 GBP/)
  assert.match(message, /None of them has this amount/)
  assert.doesNotMatch(message, /choose "Confirm/)
})

test('several equal candidates are parked, nothing linked', async () => {
  const w = world({
    tasks: [task('t1', 'ims-r1', '12.00', { cn: 'CN-1' }), task('t2', 'ims-r2', '12.00', { cn: 'CN-2' })],
    refunds: [{ id: 'ims-r1', externalRefundId: null }, { id: 'ims-r2', externalRefundId: null }],
  })
  assert.equal((await syncWcRefund(1001, wcRefund(), w.deps)).outcome, 'quarantined-refusal')
  assert.equal(w.createRefundCalls, 0)
  assert.deepEqual(w.refunds.map((r) => r.externalRefundId), [null, null])
  assert.match(String(w.parks[0].errorMessage), /CN-1: 12\.00 GBP; CN-2: 12\.00 GBP/)
})

test('a redelivery of a refund an IMS refund already holds is answered as already in IMS (the confirmation won the race)', async () => {
  const w = world({ tasks: [task('t1', 'ims-r1', '12.00')], refunds: [{ id: 'ims-r1', externalRefundId: 9001 }] })
  assert.deepEqual(await syncWcRefund(1001, wcRefund(), w.deps), { outcome: 'already-applied' })
  assert.equal(w.createRefundCalls, 0)
  assert.equal(w.parks.length, 0)
})

function txFor(tasks: Task[], refunds: Array<{ id: string; externalRefundId: number | null }>) {
  return {
    wmsOperatorTask: {
      async findMany() { return tasks.filter((t) => t.status === 'OPEN') },
      async updateMany(args: { where: { id: string; status: 'OPEN' }; data: { status: 'DONE'; doneBy: string } }) {
        const row = tasks.find((t) => t.id === args.where.id && t.status === args.where.status)
        if (!row) return { count: 0 }
        row.status = 'DONE'; row.doneBy = args.data.doneBy
        return { count: 1 }
      },
    },
    salesOrderRefund: {
      async findMany(args: { where: { id: { in: string[] }; externalRefundId: null } }) { return refunds.filter((r) => args.where.id.in.includes(r.id) && r.externalRefundId === null).map((r) => ({ id: r.id })) },
      async findFirst(args: { where: { externalRefundId: number } }) { return refunds.find((r) => r.externalRefundId === args.where.externalRefundId) ?? null },
      async updateMany(args: { where: { id: string; externalRefundId: null }; data: { externalRefundId: number } }) {
        const row = refunds.find((r) => r.id === args.where.id && r.externalRefundId === null)
        if (!row) return { count: 0 }
        row.externalRefundId = args.data.externalRefundId
        return { count: 1 }
      },
    },
  } as never
}

test('CONFIRM links the named IMS refund and resolves the task with no credit note; a second confirm is refused', async () => {
  const tasks = [task('t1', 'ims-r1', '12.00', { cn: 'CN-1' })]
  const refunds = [{ id: 'ims-r1', externalRefundId: null as number | null }]
  const tx = txFor(tasks, refunds)
  const input = { orderId: 'so-1', orderCurrency: 'GBP', imsRefundId: 'ims-r1', wcRefundId: 9001, amountForeign: toDecimal('12.00'), userId: 'u1' }
  assert.deepEqual(await confirmShopRefundSettlement(tx, input), { ok: true, taskId: 't1', creditNoteNumber: 'CN-1' })
  assert.equal(refunds[0].externalRefundId, 9001)
  assert.equal(tasks[0].status, 'DONE')
  assert.equal(tasks[0].doneBy, 'u1', 'who confirmed it')
  const again = await confirmShopRefundSettlement(tx, input)
  assert.equal(again.ok, false, 'the second confirm finds nothing waiting and changes nothing')
})

test('CONFIRM re-checks the match: another IMS refund, a different amount, another currency, or a taken storefront id is refused and changes nothing', async () => {
  const mk = () => ({ tasks: [task('t1', 'ims-r1', '12.00')], refunds: [{ id: 'ims-r1', externalRefundId: null as number | null }, { id: 'other', externalRefundId: 4 as number | null }] })
  const base = { orderId: 'so-1', orderCurrency: 'GBP', imsRefundId: 'ims-r1', wcRefundId: 9001, amountForeign: toDecimal('12.00'), userId: 'u1' }
  for (const [name, over] of [
    ['not the named refund', { imsRefundId: 'nope' }],
    ['different amount', { amountForeign: toDecimal('12.01') }],
    ['different currency', { orderCurrency: 'EUR' }],
    ['storefront id already recorded', { wcRefundId: 4 }],
  ] as const) {
    const w = mk()
    const result = await confirmShopRefundSettlement(txFor(w.tasks, w.refunds), { ...base, ...over })
    assert.equal(result.ok, false, name)
    assert.equal(w.refunds[0].externalRefundId, null, `${name}: nothing linked`)
    assert.equal(w.tasks[0].status, 'OPEN', `${name}: task untouched`)
  }
})

test('the amount test is to the minor unit and an unpriced refund never equals', () => {
  const open = (gross: string | null, currency: string | null = 'GBP') => ({ taskId: 't', refundId: 'r', creditNoteNumber: 'CN', currency, grossForeign: gross })
  assert.equal(shopRefundAmountEquals(open('12.00'), 'GBP', toDecimal('12.004')), true)
  assert.equal(shopRefundAmountEquals(open('12.00'), 'GBP', toDecimal('12.01')), false)
  assert.equal(shopRefundAmountEquals(open('12.00', 'EUR'), 'GBP', toDecimal('12.00')), false)
  assert.equal(shopRefundAmountEquals(open(null), 'GBP', toDecimal('12.00')), false)
})

test('the gross of an IMS refund is net plus the tax of each line (reverse charge: none), and null when a line cannot be priced', () => {
  const rates = buildTaxTypeRateIndex([{ accountingTaxType: 'OUTPUT2', rate: '0.2' }, { accountingTaxType: 'ZERO', rate: '0' }])
  assert.equal(refundGrossForeign([{ totalForeign: 10, accountingTaxType: 'OUTPUT2' }, { totalForeign: 5, accountingTaxType: 'ZERO' }], rates, 'GBP')?.toString(), '17')
  assert.equal(refundGrossForeign([{ totalForeign: 10, accountingTaxType: 'ECOUTPUT', reverseCharge: true }], rates, 'GBP')?.toString(), '10')
  assert.equal(refundGrossForeign([{ totalForeign: 10, accountingTaxType: 'UNKNOWN' }], rates, 'GBP'), null)
  assert.equal(refundGrossForeign([{ totalForeign: 10, accountingTaxType: null }], rates, 'GBP'), null)
})

/** An in-memory stand-in for the task table's unique key (connector, order, external order, reason, content hash). */
function taskTable() {
  const rows: Array<Record<string, unknown>> = []
  const calls = { taxRate: 0 }
  const tx = {
    taxRate: { async findMany() { calls.taxRate += 1; return [{ accountingTaxType: 'OUTPUT2', rate: '0.2' }] } },
    wmsOperatorTask: {
      async createMany(args: { data: Array<Record<string, unknown>> }) {
        let count = 0
        for (const row of args.data) {
          const key = ['connector', 'orderId', 'externalOrderId', 'reason', 'contentHash'].map((k) => String(row[k])).join('|')
          if (rows.some((r) => ['connector', 'orderId', 'externalOrderId', 'reason', 'contentHash'].map((k) => String(r[k])).join('|') === key)) continue
          rows.push(row)
          count += 1
        }
        return { count }
      },
    },
  }
  return { rows, tx: tx as never }
}

test('the task is raised ONCE per IMS refund, carries amount, currency, credit note and a fixed reason kind, and holds no personal data', async () => {
  const t = taskTable()
  const input = { orderId: 'so-1', orderNumber: 'SO-1', refundId: 'ims-r1', creditNoteNumber: 'CN-1', currency: 'GBP', lines: [{ totalForeign: 10, qty: 1, accountingTaxType: 'OUTPUT2', reverseCharge: false }] }
  assert.equal(await raiseShopRefundTask(t.tx, input), true)
  assert.equal(await raiseShopRefundTask(t.tx, input), false, 'the same refund again is the same task')
  assert.equal(await raiseShopRefundTask(t.tx, { ...input, refundId: 'ims-r2', creditNoteNumber: 'CN-2' }), true, 'another refund is another task')
  assert.equal(t.rows.length, 2)
  const [row] = t.rows as Array<{ connector: string; reason: string; externalOrderId: string; queryText: string; payload: { shopRefund: Record<string, unknown> } }>
  assert.equal(row.connector, SHOP_REFUND_CONNECTOR)
  assert.equal(row.reason, 'SHOP_REFUND_DUE')
  assert.equal(row.externalOrderId, 'ims-r1')
  assert.deepEqual(row.payload.shopRefund, { refundId: 'ims-r1', creditNoteNumber: 'CN-1', currency: 'GBP', grossForeign: '12.00', netForeign: '10.00', reasonKind: 'GOODS_RETURNED' })
  assert.match(row.queryText, /12\.00 GBP including tax/)
  assert.match(row.queryText, /IMS credit note CN-1/)
  assert.match(row.queryText, /written nothing to WooCommerce/)
  // no personal data: the text is built from ids, a credit note number and money only
  assert.doesNotMatch(row.queryText, /@|customer name|address/i)
  // the free-text reason is never an input to the task
  assert.deepEqual(Object.keys(input).filter((k) => /reason/i.test(k)), [])
})

test('a refund IMS could not price states the net, and says so', () => {
  const text = shopRefundQuery({ orderNumber: 'SO-1', creditNoteNumber: null, currency: 'GBP', grossForeign: null, netForeign: '10.00', reasonKind: 'AMOUNT_ONLY' })
  assert.match(text, /10\.00 GBP before tax/)
  assert.match(text, /could not work out the tax-inclusive figure/)
})

test('LOCK: REFUNDED and PARTIALLY_REFUNDED never map to a WooCommerce status (no status change from IMS for a refund)', async () => {
  const { IMS_TO_WC } = await import('@/lib/connectors/woocommerce/sync/order-status')
  for (const status of ['REFUNDED', 'PARTIALLY_REFUNDED', 'FULL', 'PARTIAL']) assert.equal(Object.hasOwn(IMS_TO_WC, status), false, `${status} must not be pushed to WooCommerce`)
  assert.equal(Object.values(IMS_TO_WC).some((wc) => /refund/i.test(String(wc))), false, 'no IMS status maps to the WooCommerce refunded status')
  assert.deepEqual(Object.keys(IMS_TO_WC).sort(), ['CANCELLED', 'ON_HOLD', 'SHIPPED'], 'the mapping is exactly the three it was: a new entry must be a deliberate, reviewed change')
})

test('the setting-free default: raising a refund task and linking one make no WooCommerce call (the write path does not exist)', () => {
  // The optional `_ims_to_be_refunded` WooCommerce meta (D7) is deliberately NOT built (filed as a follow-up): a LIVE write path. So nothing in the
  // refund task module may import the WooCommerce client, and the refund writer may not either.
  for (const file of ['lib/domain/sales/shop-refund-tasks.ts']) {
    const source = readFileSync(file, 'utf8')
    assert.doesNotMatch(source, /connectors\/woocommerce|wcFetch|wcPut|wcPost|_ims_to_be_refunded/, `${file} writes to WooCommerce`)
  }
})
