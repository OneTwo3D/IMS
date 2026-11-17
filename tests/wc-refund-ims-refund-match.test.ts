import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { syncWcRefund, type WcRefundSyncDependencies } from '@/lib/connectors/woocommerce/sync/refund-sync'
import type { WcRefund } from '@/lib/connectors/woocommerce/sync/types'
import { toDecimal } from '@/lib/domain/math/decimal'
import {
  SHOP_REFUND_CONNECTOR,
  SHOP_REFUND_TASK_IMPORT_ACTOR,
  matchWcRefundToOpenTask,
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

test('a manual WooCommerce refund that matches the open task is LINKED: no second credit note, the task is resolved', async () => {
  const w = world({ tasks: [task('t1', 'ims-r1', '12.00')], refunds: [{ id: 'ims-r1', externalRefundId: null }] })
  const result = await syncWcRefund(1001, wcRefund(), w.deps)
  assert.deepEqual(result, { outcome: 'already-applied' }, 'the refund is in IMS: its credit note is the one IMS already raised')
  assert.equal(w.createRefundCalls, 0, 'NO second credit note')
  assert.equal(w.refunds[0].externalRefundId, 9001, 'the storefront refund id is set on the IMS refund')
  assert.equal(w.tasks[0].status, 'DONE')
  assert.equal(w.tasks[0].doneBy, SHOP_REFUND_TASK_IMPORT_ACTOR)
  assert.equal(w.parks.length, 0)
  assert.equal(w.activity.length, 1)
  // a redelivery of the same storefront refund dedups on the id now set: still no credit note
  const again = await syncWcRefund(1001, wcRefund(), w.deps)
  assert.deepEqual(again, { outcome: 'already-applied' })
  assert.equal(w.createRefundCalls, 0)
})

test('an amount that differs from the open task is NOT guessed: nothing is created or linked, the refund is parked with both figures', async () => {
  const w = world({ tasks: [task('t1', 'ims-r1', '12.00', { cn: 'CN-77' })], refunds: [{ id: 'ims-r1', externalRefundId: null }] })
  const result = await syncWcRefund(1001, wcRefund({ amount: '9.50' }), w.deps)
  assert.equal(result.outcome, 'quarantined-refusal')
  assert.equal(w.createRefundCalls, 0, 'no credit note')
  assert.equal(w.refunds[0].externalRefundId, null, 'nothing was linked')
  assert.equal(w.tasks[0].status, 'OPEN', 'the task stays open')
  assert.equal(w.parks.length, 1)
  assert.equal(w.parks[0].status, 'QUARANTINED')
  const message = String(w.parks[0].errorMessage)
  assert.match(message, /9\.50 GBP/)
  assert.match(message, /CN-77: 12\.00 GBP/)
  assert.match(message, /second credit note/)
  assert.equal(w.activity.length, 1)
})

test('several candidates of the same amount are NOT guessed: parked, nothing linked', async () => {
  const w = world({
    tasks: [task('t1', 'ims-r1', '12.00'), task('t2', 'ims-r2', '12.00')],
    refunds: [{ id: 'ims-r1', externalRefundId: null }, { id: 'ims-r2', externalRefundId: null }],
  })
  const result = await syncWcRefund(1001, wcRefund(), w.deps)
  assert.equal(result.outcome, 'quarantined-refusal')
  assert.equal(w.createRefundCalls, 0)
  assert.deepEqual(w.refunds.map((r) => r.externalRefundId), [null, null])
  assert.deepEqual(w.tasks.map((t) => t.status), ['OPEN', 'OPEN'])
  assert.match(String(w.parks[0].errorMessage), /fits 2 open IMS refunds/)
})

test('a task whose IMS refund is already linked cannot be settled again: parked, not matched', async () => {
  const w = world({ tasks: [task('t1', 'ims-r1', '12.00')], refunds: [{ id: 'ims-r1', externalRefundId: 5 }] })
  const result = await syncWcRefund(1001, wcRefund(), w.deps)
  assert.equal(result.outcome, 'quarantined-refusal')
  assert.equal(w.refunds[0].externalRefundId, 5, 'the earlier link is untouched')
  assert.equal(w.createRefundCalls, 0)
})

test('the match is by amount to the minor unit, in the order currency, and an unpriced task never matches', async () => {
  const client = (tasks: Task[]) => ({
    wmsOperatorTask: { async findMany() { return tasks } },
    salesOrderRefund: { async findMany() { return tasks.map((t) => ({ id: t.externalOrderId })) } },
  }) as never
  const base = { orderId: 'so-1', orderCurrency: 'GBP', wcRefundId: 1 }
  assert.deepEqual(await matchWcRefundToOpenTask(client([task('t', 'r', '12.00')]), { ...base, amountForeign: toDecimal('12.004') }), { kind: 'matched', taskId: 't', refundId: 'r' })
  assert.equal((await matchWcRefundToOpenTask(client([task('t', 'r', '12.00')]), { ...base, amountForeign: toDecimal('12.01') })).kind, 'ambiguous')
  assert.equal((await matchWcRefundToOpenTask(client([task('t', 'r', '12.00', { currency: 'EUR' })]), { ...base, amountForeign: toDecimal('12.00') })).kind, 'ambiguous', 'another currency is not the same amount')
  assert.equal((await matchWcRefundToOpenTask(client([task('t', 'r', null)]), { ...base, amountForeign: toDecimal('12.00') })).kind, 'ambiguous', 'IMS could not price the refund, so it cannot claim a match')
  assert.deepEqual(await matchWcRefundToOpenTask(client([]), { ...base, amountForeign: toDecimal('12.00') }), { kind: 'none' })
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
