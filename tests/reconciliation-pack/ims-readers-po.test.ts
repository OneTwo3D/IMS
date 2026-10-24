import assert from 'node:assert/strict'
import test from 'node:test'

import { readImsSnapshot, type ImsQueryClient } from '../../lib/reconciliation-pack/ims-readers.ts'

/**
 * THE TWO IMS SECTIONS BEHIND R7, R8 AND R11: the purchase orders in a committed-incoming status, and the transit sub-ledger grouped by
 * the order each row belongs to. A scripted connection answers by the statement's text; the statement and its bound values are inspected.
 */

function fake(answer: (sql: string, values?: unknown[]) => Array<Record<string, unknown>>, snapshots: [string, string] = ['10:20:', '10:20:']): ImsQueryClient & { sent: Array<{ sql: string; values?: unknown[] }> } {
  const sent: Array<{ sql: string; values?: unknown[] }> = []
  let reads = 0
  return {
    sent,
    async query(sql, values) {
      sent.push({ sql, values })
      if (/^BEGIN|^ROLLBACK|^SET LOCAL/i.test(sql)) return { rows: [] }
      if (/pg_current_snapshot/.test(sql)) return { rows: [{ snapshot: snapshots[Math.min(reads++, 1)], read_only: 'on', isolation: 'repeatable read' }] }
      return { rows: answer(sql, values) }
    },
  }
}
const sectionOf = async <K extends 'purchaseOrders' | 'transitSchedule' | 'fxRates' | 'firstLoadProvenance'>(name: K, client: ImsQueryClient, asOf?: string, rowCap?: number) => {
  const read = await readImsSnapshot(client, { sections: [name], ...(asOf !== undefined ? { asOf } : {}), ...(rowCap !== undefined ? { rowCap } : {}) })
  assert.ok(read.ok)
  return read.sections[name]!
}

// ---- purchaseOrders -------------------------------------------------------------------------------

const orderRow = (over: Record<string, unknown> = {}) => ({ id: 'po1', reference: 'QBX-PO1', status: 'PO_SENT', currency: 'GBP', discount: '0.0000', created: '2026-03-01T10:00:00.000Z', ...over })
const lineRow = (over: Record<string, unknown> = {}) => ({ id: 'l1', po_id: 'po1', sku: 'A', qty: '10', received: '4', cost: '2.500000', ...over })
const poAnswer = (orders: Array<Record<string, unknown>>, lines: Array<Record<string, unknown>>) => (sql: string) => (/FROM purchase_order_lines/.test(sql) ? lines : /FROM purchase_orders/.test(sql) ? orders : [])

// [mutation: the status list widened to draft/quote/received orders, or the type filter dropped, or the list restated in the SQL text]
test('purchaseOrders: reads every goods order in a committed-incoming status with its lines, the statuses BOUND from the one shared definition', async () => {
  const client = fake(poAnswer([orderRow(), orderRow({ id: 'po2', reference: 'QBX-PO2', status: 'PARTIALLY_RECEIVED', currency: 'USD' })], [lineRow(), lineRow({ id: 'l2', sku: 'B' }), lineRow({ id: 'l3', po_id: 'po2', sku: 'A' })]))
  const section = await sectionOf('purchaseOrders', client)
  assert.ok(section.ok)
  assert.deepEqual(section.value.map((o) => [o.id, o.reference, o.status, o.currency, o.createdAt, o.discount, o.lines.map((l) => l.sku)]), [['po1', 'QBX-PO1', 'PO_SENT', 'GBP', '2026-03-01T10:00:00.000Z', '0.0000', ['A', 'B']], ['po2', 'QBX-PO2', 'PARTIALLY_RECEIVED', 'USD', '2026-03-01T10:00:00.000Z', '0.0000', ['A']]])
  assert.deepEqual(section.value[0]!.lines[0], { id: 'l1', sku: 'A', qty: '10', qtyReceived: '4', unitCostBase: '2.500000' })
  const queries = client.sent.filter((q) => /FROM purchase_order/.test(q.sql))
  assert.equal(queries.length, 2)
  for (const q of queries) {
    assert.match(q.sql, /po\.type::text = 'GOODS'/)
    assert.deepEqual(q.values, [['PO_SENT', 'SHIPPED', 'PARTIALLY_RECEIVED']])
    assert.ok(!/DRAFT|RFQ_SENT|QUOTE_RECEIVED|RECEIVED'|CLOSED|CANCELLED/.test(q.sql), 'no status is spelled in the SQL text')
  }
})

test('purchaseOrders: a repeated reference, a line of an order not read, a value that is not a plain decimal, a status outside the list and a read over the cap each make the section unreadable with a closed code', async () => {
  const reason = async (orders: Array<Record<string, unknown>>, lines: Array<Record<string, unknown>> = [], cap?: number) => {
    const s = await sectionOf('purchaseOrders', fake(poAnswer(orders, lines)), undefined, cap)
    return s.ok ? 'ok' : s.reason
  }
  assert.equal(await reason([orderRow(), orderRow({ id: 'po2' })]), 'DUPLICATE_KEY')
  assert.equal(await reason([orderRow(), orderRow({ reference: 'OTHER' })]), 'DUPLICATE_KEY')
  assert.equal(await reason([orderRow()], [lineRow({ po_id: 'ghost' })]), 'SOURCE_UNREADABLE')
  assert.equal(await reason([orderRow()], [lineRow(), lineRow()]), 'DUPLICATE_KEY')
  assert.equal(await reason([orderRow()], [lineRow({ qty: '1e3' })]), 'BAD_VALUE')
  assert.equal(await reason([orderRow()], [lineRow({ received: null })]), 'BAD_VALUE')
  assert.equal(await reason([orderRow()], [lineRow({ cost: 'NaN' })]), 'BAD_VALUE')
  assert.equal(await reason([orderRow({ status: 'DRAFT' })]), 'SOURCE_UNREADABLE')
  assert.equal(await reason([orderRow({ currency: '' })]), 'CURRENCY_UNKNOWN')
  assert.equal(await reason([orderRow({ created: null })]), 'SOURCE_UNREADABLE')
  assert.equal(await reason([orderRow({ discount: 'x' })]), 'BAD_VALUE')
  assert.equal(await reason([orderRow({ discount: null })]), 'BAD_VALUE')
  assert.equal(await reason([orderRow(), orderRow({ id: 'po2', reference: 'B' })], [], 1), 'CAP_EXCEEDED')
  assert.equal(await reason([orderRow()], [lineRow(), lineRow({ id: 'l2' })], 1), 'CAP_EXCEEDED')
  assert.equal(await reason([orderRow()], [lineRow({ sku: '' })]), 'BAD_KEY')
  assert.equal(await reason([]), 'ok')
})

// ---- transitSchedule ------------------------------------------------------------------------------

const netRow = (over: Record<string, unknown> = {}) => ({ po_id: 'po1', source_type: 'PURCHASE_BILL', net: '100.500000', ...over })
const tOrder = (over: Record<string, unknown> = {}) => ({ id: 'po1', reference: 'QBX-PO1', status: 'PO_SENT', type: 'GOODS', created: '2026-09-01T10:00:00.000Z', ...over })
function transitAnswer(opts: { coverage?: Array<Record<string, unknown>>; net?: Array<Record<string, unknown>>; orders?: Array<Record<string, unknown>>; open?: Array<Record<string, unknown>> }) {
  return (sql: string) => {
    if (/FROM settings/.test(sql)) return opts.coverage ?? [{ value: '2026-01-01' }]
    if (/FROM transit_subledger_movements/.test(sql)) return opts.net ?? []
    if (/po\.id = ANY/.test(sql)) return opts.orders ?? []
    if (/po\.status::text = ANY/.test(sql)) return opts.open ?? []
    return []
  }
}

// [mutation: rows after the cycle date included / the date bound dropped / an unknown source type tolerated]
test('transitSchedule: needs the cycle date; reads the sub-ledger up to and including it (bound), splits the refund-in-transit leg, and names every order the rows name', async () => {
  assert.deepEqual(await sectionOf('transitSchedule', fake(transitAnswer({}))), { ok: false, reason: 'STALE_BASIS' })
  const client = fake(transitAnswer({ net: [netRow(), netRow({ source_type: 'STOCK_RECEIPT', net: '-40' }), netRow({ po_id: null, source_type: 'CUSTOMER_RETURN_IN_TRANSIT', net: '7.25' })], orders: [tOrder()], open: [tOrder(), tOrder({ id: 'po9', reference: 'QBX-PO9', created: '2026-10-01T00:00:00.000Z' })] }))
  const section = await sectionOf('transitSchedule', client, '2026-10-19')
  assert.ok(section.ok)
  assert.deepEqual(section.value, {
    asOf: '2026-10-19', coverageStart: '2026-01-01',
    net: [{ poId: 'po1', sourceType: 'PURCHASE_BILL', net: '100.500000' }, { poId: 'po1', sourceType: 'STOCK_RECEIPT', net: '-40' }],
    customerReturns: '7.25',
    orders: [{ id: 'po1', reference: 'QBX-PO1', status: 'PO_SENT', type: 'GOODS', createdAt: '2026-09-01T10:00:00.000Z' }],
    openOrders: [{ id: 'po1', reference: 'QBX-PO1', status: 'PO_SENT', type: 'GOODS', createdAt: '2026-09-01T10:00:00.000Z' }, { id: 'po9', reference: 'QBX-PO9', status: 'PO_SENT', type: 'GOODS', createdAt: '2026-10-01T00:00:00.000Z' }],
  })
  const sub = client.sent.find((q) => /FROM transit_subledger_movements/.test(q.sql))!
  assert.match(sub.sql, /m\.journal_date <= \$1::date/)
  assert.deepEqual(sub.values, ['2026-10-19'])
  const open = client.sent.find((q) => /po\.status::text = ANY/.test(q.sql))!
  assert.deepEqual(open.values, [['PO_SENT', 'SHIPPED', 'PARTIALLY_RECEIVED']])
})

test('transitSchedule: an unrecorded coverage watermark is null; a malformed or repeated one, an unknown source type, a row with no order, an order IMS does not hold and a read over the cap are each unreadable with a closed code', async () => {
  const reason = async (opts: Parameters<typeof transitAnswer>[0], cap?: number) => {
    const s = await sectionOf('transitSchedule', fake(transitAnswer(opts)), '2026-10-19', cap)
    return s.ok ? 'ok' : s.reason
  }
  const none = await sectionOf('transitSchedule', fake(transitAnswer({ coverage: [] })), '2026-10-19')
  assert.ok(none.ok && none.value.coverageStart === null)
  assert.equal(await reason({ coverage: [{ value: 'soon' }] }), 'SOURCE_UNREADABLE')
  assert.equal(await reason({ coverage: [{ value: '2026-13-45' }] }), 'SOURCE_UNREADABLE')
  assert.equal(await reason({ coverage: [{ value: '2026-01-01' }, { value: '2026-01-02' }] }), 'DUPLICATE_KEY')
  assert.equal(await reason({ net: [netRow({ source_type: 'NEW_FLOW' })], orders: [tOrder()] }), 'SOURCE_UNREADABLE')
  assert.equal(await reason({ net: [netRow({ po_id: null })] }), 'BAD_KEY')
  assert.equal(await reason({ net: [netRow({ po_id: null, source_type: 'SUPPLIER_RETURN' })] }), 'BAD_KEY')
  assert.equal(await reason({ net: [netRow({ po_id: 'po7', source_type: 'CUSTOMER_RETURN_IN_TRANSIT' })] }), 'SOURCE_UNREADABLE')
  assert.equal(await reason({ net: [netRow()], orders: [] }), 'BAD_KEY')
  assert.equal(await reason({ net: [netRow({ net: 'x' })], orders: [tOrder()] }), 'BAD_VALUE')
  assert.equal(await reason({ net: [netRow(), netRow()], orders: [tOrder()] }), 'DUPLICATE_KEY')
  assert.equal(await reason({ net: [netRow(), netRow({ source_type: 'STOCK_RECEIPT' })], orders: [tOrder()] }, 1), 'CAP_EXCEEDED')
  assert.equal(await reason({ net: [netRow()], orders: [tOrder({ type: 'OTHER' })] }), 'SOURCE_UNREADABLE')
  assert.equal(await reason({ net: [], orders: [] }), 'ok')
})

test('the two sections send only SELECTs (one statement each) and never a write', async () => {
  const client = fake(transitAnswer({ net: [netRow()], orders: [tOrder()] }))
  await readImsSnapshot(client, { sections: ['purchaseOrders', 'transitSchedule'], asOf: '2026-10-19' })
  for (const { sql } of client.sent) assert.ok(/^(BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY|ROLLBACK|SELECT\b|SET LOCAL )/.test(sql) && !sql.includes(';'), sql)
  assert.ok(!client.sent.some(({ sql }) => /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE|GRANT)\b/i.test(sql)))
})

// ---- fxRates --------------------------------------------------------------------------------------

// [mutation: rows from a currency other than the base read, or the table read with a window]
test('fxRates: reads every row quoted FROM the base currency (bound), exact decimals and instants; a bad rate, a missing instant, an empty currency or a read over the cap is unreadable', async () => {
  const row = (over: Record<string, unknown> = {}) => ({ currency: 'USD', rate: '1.25000000', fetched: '2026-02-20T00:00:00.000Z', ...over })
  const client = fake((sql) => (/FROM fx_rates/.test(sql) ? [row(), row({ currency: 'EUR', rate: '1.15', fetched: '2026-02-21T00:00:00.000Z' })] : []))
  const section = await sectionOf('fxRates', client)
  assert.ok(section.ok)
  assert.deepEqual(section.value, [{ currency: 'USD', rate: '1.25000000', fetchedAt: '2026-02-20T00:00:00.000Z' }, { currency: 'EUR', rate: '1.15', fetchedAt: '2026-02-21T00:00:00.000Z' }])
  const q = client.sent.find((x) => /FROM fx_rates/.test(x.sql))!
  assert.match(q.sql, /"fromCurrency" = \$1/)
  assert.deepEqual(q.values, ['GBP'])
  const reason = async (rows: Array<Record<string, unknown>>, cap?: number) => {
    const s = await sectionOf('fxRates', fake((sql) => (/FROM fx_rates/.test(sql) ? rows : [])), undefined, cap)
    return s.ok ? 'ok' : s.reason
  }
  assert.equal(await reason([row({ rate: 'NaN' })]), 'BAD_VALUE')
  assert.equal(await reason([row({ rate: '1e3' })]), 'BAD_VALUE')
  assert.equal(await reason([row({ rate: null })]), 'BAD_VALUE')
  assert.equal(await reason([row({ fetched: null })]), 'SOURCE_UNREADABLE')
  assert.equal(await reason([row({ currency: '' })]), 'CURRENCY_UNKNOWN')
  assert.equal(await reason([row(), row({ currency: 'EUR' })], 1), 'CAP_EXCEEDED')
  assert.equal(await reason([]), 'ok')
})

// ---- firstLoadProvenance ---------------------------------------------------------------------------------------------------------

// [mutation: provenance inferred without the run id / the actor kind not required / lines not counted]
test('firstLoadProvenance: the run record and every order carrying THAT run\'s system-actor creation row, with the lines they hold; no run record is null; two records, a repeated order id or a bad count is unreadable', async () => {
  const run = (over: Record<string, unknown> = {}) => ({ run_id: 'run-1', status: 'VERIFIED', created: '3', ...over })
  const answer = (runs: Array<Record<string, unknown>>, logs: Array<Record<string, unknown>>) => (sql: string) => (/FROM first_load_apply_runs/.test(sql) ? runs : /FROM activity_logs/.test(sql) ? logs : /count\(\*\)/.test(sql) ? [{ n: '3' }] : [])
  const client = fake(answer([run()], [{ id: 'po1' }, { id: 'po2' }]))
  const section = await sectionOf('firstLoadProvenance', client)
  assert.ok(section.ok)
  assert.deepEqual(section.value, { runId: 'run-1', status: 'VERIFIED', journalCreated: 3, attributed: ['po1', 'po2'], attributedLines: 3 })
  const log = client.sent.find((q) => /FROM activity_logs/.test(q.sql))!
  assert.match(log.sql, /"entityType"::text = 'PURCHASE_ORDER'/)
  assert.match(log.sql, /action = 'created'/)
  assert.match(log.sql, /metadata->'actor'->>'kind' = 'system'/)
  assert.match(log.sql, /metadata->'actor'->>'runId' = \$1/)
  assert.deepEqual(log.values, ['run-1'])
  const lines = client.sent.find((q) => /count\(\*\)/.test(q.sql))!
  assert.deepEqual(lines.values, [['po1', 'po2']])
  const none = await sectionOf('firstLoadProvenance', fake(answer([], [])))
  assert.ok(none.ok && none.value === null)
  const reason = async (runs: Array<Record<string, unknown>>, logs: Array<Record<string, unknown>> = []) => {
    const s = await sectionOf('firstLoadProvenance', fake(answer(runs, logs)))
    return s.ok ? 'ok' : s.reason
  }
  assert.equal(await reason([run(), run({ run_id: 'run-2' })]), 'DUPLICATE_KEY')
  assert.equal(await reason([run({ created: 'x' })]), 'BAD_VALUE')
  assert.equal(await reason([run({ status: 'BOGUS' })]), 'SOURCE_UNREADABLE')
  assert.equal(await reason([run({ run_id: '' })]), 'SOURCE_UNREADABLE')
  assert.equal(await reason([run()], [{ id: 'po1' }, { id: 'po1' }]), 'DUPLICATE_KEY')
  assert.equal(await reason([run({ created: null })]), 'ok')
  assert.equal(await reason([run()], [{ id: null }]), 'BAD_KEY')
})
