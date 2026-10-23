import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { RUN_STATUSES } from '../../lib/first-load/apply/constants.ts'
import { FIRST_LOAD_RUN_STATUSES, WDRAW_APPROVED_STATUS_KEY, WDRAW_DEFAULT_APPROVED_STATUS, WDRAW_DEFAULT_SUBMITTED_STATUS, WDRAW_SUBMITTED_STATUS_KEY } from '../../lib/reconciliation-pack/constants.ts'
import { alignmentState, classifyPopulation, readImsSnapshot, statementAllowed, type ImsQueryClient, type PopulationBoundaries } from '../../lib/reconciliation-pack/ims-readers.ts'

/** A scripted connection: answers by the statement's text, records every statement. */
function fake(answer: (sql: string, values?: unknown[]) => Array<Record<string, unknown>> | Error, snapshots: [string, string] = ['10:20:', '10:20:']): ImsQueryClient & { sent: string[] } {
  const sent: string[] = []
  let snapshotReads = 0
  return {
    sent,
    async query(sql, values) {
      sent.push(sql)
      if (/^BEGIN|^ROLLBACK|^SET LOCAL/i.test(sql)) return { rows: [] }
      if (/pg_current_snapshot/.test(sql)) {
        const snapshot = snapshots[Math.min(snapshotReads++, 1)]!
        return { rows: [{ snapshot, read_only: 'on', isolation: 'repeatable read' }] }
      }
      const out = answer(sql, values)
      if (out instanceof Error) throw out
      return { rows: out }
    },
  }
}
const SID = '7000000000000000001'
const identityRow = [{ sid: SID, db: 'ims' }]

test('the first-load statuses the reader knows are exactly the runner\'s own', () => {
  assert.deepEqual([...FIRST_LOAD_RUN_STATUSES], [...RUN_STATUSES])
})

test('one transaction: BEGIN REPEATABLE READ READ ONLY first, ROLLBACK last, only SELECT and fixed SET LOCAL between', async () => {
  const client = fake(() => identityRow)
  const read = await readImsSnapshot(client, { sections: ['identity'] })
  assert.equal(read.ok, true)
  assert.equal(client.sent[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  assert.equal(client.sent.at(-1), 'ROLLBACK')
  assert.equal(client.sent.filter((s) => /^BEGIN/.test(s)).length, 1)
  for (const sql of client.sent.slice(1, -1)) assert.match(sql, /^(SELECT|SET LOCAL )/, sql)
  assert.ok(client.sent.some((s) => /statement_timeout/.test(s)))
  if (read.ok) assert.deepEqual(read.sections.identity, { ok: true, value: { systemIdentifier: SID, database: 'ims' } })
})

test('the mode is proven, not assumed: a transaction that reads back as not read-only or not repeatable read is refused', async () => {
  for (const [ro, iso] of [['off', 'repeatable read'], ['on', 'read committed'], ['on', 'serializable']]) {
    const client: ImsQueryClient = { async query(sql) { return { rows: /pg_current_snapshot/.test(sql) ? [{ snapshot: 's', read_only: ro, isolation: iso }] : [] } } }
    assert.deepEqual(await readImsSnapshot(client, { sections: ['identity'] }), { ok: false, reason: 'SOURCE_UNREADABLE' }, `${ro}/${iso}`)
  }
})

test('a snapshot that moved between the start and the end is BASIS_MOVED and returns no data', async () => {
  const read = await readImsSnapshot(fake(() => identityRow, ['10:20:', '11:21:']), { sections: ['identity'] })
  assert.deepEqual(read, { ok: false, reason: 'BASIS_MOVED' })
})

test('a statement that is not a SELECT or a fixed SET LOCAL, or holds two statements, is never sent (a write cannot be added by accident)', async () => {
  // The wrapper is exercised through the only door there is: a section whose SQL is wrong. Prove the allowlist by making the
  // fake observe every statement and by checking that none of the real sections sends anything else, across ALL sections.
  const client = fake(() => [])
  await readImsSnapshot(client, { sections: ['identity', 'boundaries', 'stock', 'products', 'orders', 'storefrontStatus', 'taxes', 'xeroSyncLogs', 'snapshots', 'wmsBindings', 'xeroPostings'], asOf: '2026-10-19' })
  for (const sql of client.sent) assert.ok(/^(BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY|ROLLBACK|SELECT\b|SET LOCAL (statement_timeout|idle_in_transaction_session_timeout) = \d+$|SET LOCAL TIME ZONE 'UTC'$)/.test(sql) && !sql.includes(';'), sql)
  assert.ok(!client.sent.some((s) => /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE|GRANT)\b/i.test(s)))
})

test('the statement allowlist refuses every write, every second statement and every lookalike', () => {
  for (const sql of ['SELECT 1', '  select id FROM products ORDER BY id LIMIT 5', 'SET LOCAL statement_timeout = 120000', 'SET LOCAL idle_in_transaction_session_timeout = 600000', "SET LOCAL TIME ZONE 'UTC'"]) assert.equal(statementAllowed(sql), true, sql)
  for (const sql of [
    "INSERT INTO settings (key) VALUES ('x')", 'UPDATE products SET sku = sku', 'DELETE FROM products', 'TRUNCATE products', 'DROP TABLE products', 'ALTER TABLE products ADD x int', 'CREATE TABLE x (a int)', 'GRANT ALL ON products TO PUBLIC',
    'COMMIT', 'ROLLBACK', 'BEGIN', 'SET TRANSACTION READ WRITE', 'SET LOCAL transaction_read_only = off', 'SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE', 'SET LOCAL statement_timeout = 1; DELETE FROM products', 'SELECT 1; DELETE FROM products', 'SELECT 1;',
    'WITH d AS (DELETE FROM products RETURNING id) SELECT * FROM d', 'COPY products TO PROGRAM \'x\'', 'SELECT set_config(\'transaction_read_only\', \'off\', true)'.replace('SELECT', ' --\nUPDATE x SET a=1 --'), '', '  ', 'SET LOCAL statement_timeout = abc', 'SET LOCAL statement_timeout = 99999999',
  ]) assert.equal(statementAllowed(sql), false, sql)
  assert.equal(statementAllowed(undefined as never), false)
})

test('a timeout (57014) is READ_INCOMPLETE, another database error is SOURCE_UNREADABLE, and the transaction is rolled back either way', async () => {
  for (const [code, reason] of [['57014', 'READ_INCOMPLETE'], ['XX000', 'SOURCE_UNREADABLE']] as const) {
    const client = fake((sql) => /pg_control_system/.test(sql) ? Object.assign(new Error('boom with a secret value'), { code }) : [])
    const read = await readImsSnapshot(client, { sections: ['identity'] })
    assert.deepEqual(read, { ok: false, reason })
    assert.equal(client.sent.at(-1), 'ROLLBACK')
  }
})

test('more rows than the cap is CAP_EXCEEDED for that section, never a shorter list; exactly the cap is read in full', async () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, sku: `S${i}`, type: 'SIMPLE', active: true, lifecycle: 'ACTIVE' }))
  const over = await readImsSnapshot(fake(() => rows(4)), { sections: ['products'], rowCap: 3 })
  assert.ok(over.ok && over.sections.products!.ok === false && over.sections.products!.reason === 'CAP_EXCEEDED')
  const client = fake((sql) => { assert.match(sql, /LIMIT 4$/); return rows(3) })
  const exact = await readImsSnapshot(client, { sections: ['products'], rowCap: 3 })
  assert.ok(exact.ok && exact.sections.products!.ok && exact.sections.products!.value.length === 3)
})

const stockRow = (over: Record<string, unknown> = {}) => ({ id: 'sl1', product_id: 'p1', sku: 'A1', product_type: 'SIMPLE', warehouse_id: 'w1', warehouse_code: 'MAIN', quantity: '5.000000', reserved: '0.000000', ...over })

test('a row that cannot be read exactly makes its WHOLE section unreadable with a closed code (nothing dropped, defaulted or coerced)', async () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['no stock level id', { id: null }, 'BAD_KEY'],
    ['empty sku', { sku: '' }, 'BAD_KEY'],
    ['control character in a key', { warehouse_code: 'MA\nIN' }, 'BAD_KEY'],
    ['quantity not text', { quantity: 5 }, 'BAD_VALUE'],
    ['quantity NaN', { quantity: 'NaN' }, 'BAD_VALUE'],
    ['quantity exponent', { quantity: '1e3' }, 'BAD_VALUE'],
    ['quantity null', { quantity: null }, 'BAD_VALUE'],
    ['reserved missing', { reserved: undefined }, 'BAD_VALUE'],
  ]
  for (const [name, over, reason] of cases) {
    const read = await readImsSnapshot(fake(() => [stockRow(), stockRow({ id: 'sl2', product_id: 'p2', sku: 'A2', ...over })]), { sections: ['stock'] })
    assert.ok(read.ok, name)
    assert.deepEqual(read.sections.stock, { ok: false, reason }, name)
  }
})

test('duplicate identities are DUPLICATE_KEY: the same stock level id, the same product and warehouse, the same sku', async () => {
  const dup = async (sections: Parameters<typeof readImsSnapshot>[1]['sections'], rows: Array<Record<string, unknown>>) => (await readImsSnapshot(fake(() => rows), { sections }) as Extract<Awaited<ReturnType<typeof readImsSnapshot>>, { ok: true }>).sections
  assert.deepEqual((await dup(['stock'], [stockRow(), stockRow()])).stock, { ok: false, reason: 'DUPLICATE_KEY' })
  assert.deepEqual((await dup(['stock'], [stockRow(), stockRow({ id: 'sl2' })])).stock, { ok: false, reason: 'DUPLICATE_KEY' })
  const product = (id: string, sku: string) => ({ id, sku, type: 'SIMPLE', active: true, lifecycle: 'ACTIVE' })
  assert.deepEqual((await dup(['products'], [product('a', 'S'), product('b', 'S')])).products, { ok: false, reason: 'DUPLICATE_KEY' })
})

test('stock of a product type that carries no stock is excluded AND listed, never compared and never dropped', async () => {
  const read = await readImsSnapshot(fake(() => [stockRow(), stockRow({ id: 'sl2', product_id: 'p2', sku: 'FEE', product_type: 'NON_INVENTORY' }), stockRow({ id: 'sl3', product_id: 'p3', sku: 'PAR', product_type: 'VARIABLE' })]), { sections: ['stock'] })
  assert.ok(read.ok && read.sections.stock!.ok)
  if (read.ok && read.sections.stock!.ok) {
    assert.deepEqual(read.sections.stock!.value.tracked.map((p) => p.sku), ['A1'])
    assert.deepEqual(read.sections.stock!.value.untracked.map((p) => p.sku).sort(), ['FEE', 'PAR'])
  }
})

test('boundaries: only a VERIFIED run is a verified first load; an unknown status, a second row or a setting that is not exactly "true" is unreadable', async () => {
  const run = (rows: Array<Record<string, unknown>>, settings: Array<Record<string, unknown>> = []) => readImsSnapshot(fake((sql) => /first_load_apply_runs/.test(sql) ? rows : settings), { sections: ['boundaries'] })
  const val = async (rows: Array<Record<string, unknown>>, settings: Array<Record<string, unknown>> = []) => { const r = await run(rows, settings); assert.ok(r.ok); return r.sections.boundaries! }
  const verified = await val([{ status: 'VERIFIED', cut: '2026-10-01T10:00:00.000Z' }], [{ key: 'wc_initial_import_completed', value: 'true', at: '2026-10-02T10:00:00.000Z' }, { key: 'retention_sales_orders_months', value: '24', at: '2026-10-02T10:00:00.000Z' }])
  assert.deepEqual(verified, { ok: true, value: { firstLoad: { state: 'verified', cutAt: '2026-10-01T10:00:00.000Z' }, storefrontImport: { state: 'completed', cutAt: '2026-10-02T10:00:00.000Z' }, retentionMonths: 24 } })
  assert.deepEqual((await val([])), { ok: true, value: { firstLoad: { state: 'absent' }, storefrontImport: { state: 'not-completed' }, retentionMonths: 0 } })
  const b = await val([{ status: 'APPLIED', cut: '2026-10-01T10:00:00.000Z' }])
  assert.ok(b.ok && b.value.firstLoad.state === 'unverified')
  assert.deepEqual(await val([{ status: 'MADE_UP', cut: '2026-10-01T10:00:00.000Z' }]), { ok: false, reason: 'SOURCE_UNREADABLE' })
  assert.deepEqual(await val([{ status: 'VERIFIED', cut: '2026-10-01T10:00:00.000Z' }, { status: 'VERIFIED', cut: '2026-10-01T10:00:00.000Z' }]), { ok: false, reason: 'DUPLICATE_KEY' })
  assert.deepEqual(await val([{ status: 'VERIFIED', cut: null }]), { ok: false, reason: 'SOURCE_UNREADABLE' })
  for (const value of ['True', 'false', '1', '"true"', '']) assert.deepEqual(await val([], [{ key: 'wc_initial_import_completed', value, at: '2026-10-02T10:00:00.000Z' }]), { ok: false, reason: 'SOURCE_UNREADABLE' }, value)
  for (const value of ['-1', '12.5', 'many', '99999']) assert.deepEqual(await val([], [{ key: 'retention_sales_orders_months', value, at: '2026-10-02T10:00:00.000Z' }]), { ok: false, reason: 'SOURCE_UNREADABLE' }, value)
})

test('snapshots: rows with no run row, or a run row that counts another number of rows, are READ_INCOMPLETE; a bad date is STALE_BASIS', async () => {
  const row = { product_id: 'p1', warehouse_id: 'w1', qty: '1.000000', value: '2.000000', reliable: true }
  const read = (run: Array<Record<string, unknown>>, values: Array<Record<string, unknown>>, asOf = '2026-10-19') => readImsSnapshot(fake((sql) => /inventory_snapshot_runs/.test(sql) ? run : /FROM inventory_snapshots/.test(sql) ? values : []), { sections: ['snapshots'], asOf })
  const section = async (...args: Parameters<typeof read>) => { const r = await read(...args); assert.ok(r.ok); return r.sections.snapshots! }
  const good = await section([{ stock_count: '1', snapshot_count: '1' }], [row])
  assert.ok(good.ok && good.value.run!.snapshotCount === 1 && good.value.values.length === 1)
  const empty = await section([{ stock_count: '0', snapshot_count: '0' }], [])
  assert.ok(empty.ok && empty.value.run !== null && empty.value.values.length === 0)
  const noRun = await section([], [])
  assert.ok(noRun.ok && noRun.value.run === null, 'no run row is reported as null: missing evidence, not a zero')
  assert.deepEqual(await section([], [row]), { ok: false, reason: 'READ_INCOMPLETE' })
  assert.deepEqual(await section([{ stock_count: '2', snapshot_count: '2' }], [row]), { ok: false, reason: 'READ_INCOMPLETE' })
  for (const asOf of ['2026-13-40', 'yesterday', '']) assert.deepEqual(await section([], [], asOf), { ok: false, reason: 'STALE_BASIS' }, asOf)
  const none = await readImsSnapshot(fake(() => []), { sections: ['snapshots'] })
  assert.ok(none.ok && !none.sections.snapshots!.ok)
})

// [mutation: the P0 record read from updated_at / a non-VERIFIED run accepted / a row dropped for want of a time]
test('xeroPostings: the P0 instant is when the VERIFIED first load STARTED; every row that could be a write is kept with its own status and instant; a row it cannot read makes the section unreadable', async () => {
  const read = async (runs: Array<Record<string, unknown>>, rows: Array<Record<string, unknown>>) => {
    const client = fake((sql) => (/first_load_apply_runs/.test(sql) ? runs : /FROM accounting_sync_logs/.test(sql) ? rows : []))
    const r = await readImsSnapshot(client, { sections: ['xeroPostings'] })
    assert.ok(r.ok)
    return { section: r.sections.xeroPostings!, sent: client.sent }
  }
  const log = (over: Record<string, unknown> = {}) => ({ id: 'cl1', type: 'SALES_INVOICE', status: 'SYNCED', at: '2026-10-05T10:00:00.000Z', ...over })
  const good = await read([{ status: 'VERIFIED', started: '2026-10-01T09:00:00.000Z' }], [log(), log({ id: 'cl2', type: 'INVOICE_PDF', status: 'PROCESSING' }), log({ id: 'cl3', type: 'TAX_RATE_SYNC', status: 'FAILED' })])
  assert.deepEqual(good.section, { ok: true, value: { p0: { state: 'verified', startedAt: '2026-10-01T09:00:00.000Z' }, rows: [log(), log({ id: 'cl2', type: 'INVOICE_PDF', status: 'PROCESSING' }), log({ id: 'cl3', type: 'TAX_RATE_SYNC', status: 'FAILED' })] } })
  const sql = good.sent.find((s) => /FROM accounting_sync_logs/.test(s))!
  assert.match(sql, /connector = 'xero'/)
  assert.match(sql, /status::text IN \('SYNCED', 'PROCESSING'\) OR "externalTransactionId" IS NOT NULL/)
  assert.ok(!/type::text (<>|NOT IN|!=)/.test(sql) && !/settlement_basis/.test(sql), 'no type and no settlement basis is left out of the population')
  assert.match(good.sent.find((s) => /first_load_apply_runs/.test(s))!, /created_at/)

  const states = async (runs: Array<Record<string, unknown>>) => (await read(runs, [])).section
  assert.deepEqual(await states([]), { ok: true, value: { p0: { state: 'absent' }, rows: [] } })
  assert.deepEqual(await states([{ status: 'APPLIED', started: '2026-10-01T09:00:00.000Z' }]), { ok: true, value: { p0: { state: 'unverified' }, rows: [] } })
  assert.deepEqual(await states([{ status: 'MADE_UP', started: '2026-10-01T09:00:00.000Z' }]), { ok: false, reason: 'SOURCE_UNREADABLE' })
  assert.deepEqual(await states([{ status: 'VERIFIED', started: null }]), { ok: false, reason: 'SOURCE_UNREADABLE' })
  assert.deepEqual(await states([{ status: 'VERIFIED', started: 'yesterday' }]), { ok: false, reason: 'SOURCE_UNREADABLE' })
  assert.deepEqual(await states([{ status: 'VERIFIED', started: '2026-10-01T09:00:00.000Z' }, { status: 'VERIFIED', started: '2026-10-01T09:00:00.000Z' }]), { ok: false, reason: 'DUPLICATE_KEY' })

  const run = [{ status: 'VERIFIED', started: '2026-10-01T09:00:00.000Z' }]
  const bad: Array<[string, Record<string, unknown>, string]> = [
    ['no id', { id: null }, 'BAD_KEY'], ['unknown type', { type: 'NEW_TYPE' }, 'SOURCE_UNREADABLE'], ['unknown status', { status: 'LOST' }, 'SOURCE_UNREADABLE'],
    ['no instant', { at: null }, 'SOURCE_UNREADABLE'], ['instant not ISO', { at: 'last week' }, 'SOURCE_UNREADABLE'],
  ]
  for (const [name, over, reason] of bad) assert.deepEqual((await read(run, [log(), log({ id: 'cl2', ...over })])).section, { ok: false, reason }, name)
  assert.deepEqual((await read(run, [log(), log()])).section, { ok: false, reason: 'DUPLICATE_KEY' })
  const over = await readImsSnapshot(fake((sql) => (/FROM accounting_sync_logs/.test(sql) ? [log(), log({ id: 'cl2' }), log({ id: 'cl3' })] : [])), { sections: ['xeroPostings'], rowCap: 2 })
  assert.ok(over.ok && over.sections.xeroPostings!.ok === false && over.sections.xeroPostings!.reason === 'CAP_EXCEEDED', 'more rows than the cap is CAP_EXCEEDED, never a shorter list')
})

test('options are validated: duplicate or unknown sections, a cap or a timeout out of range', async () => {
  for (const options of [{ sections: ['identity', 'identity'] }, { sections: ['nope'] }, { sections: ['identity'], rowCap: 0 }, { sections: ['identity'], rowCap: 1e9 }, { sections: ['identity'], statementTimeoutMs: 0 }, { sections: ['identity'], statementTimeoutMs: 1e9 }]) {
    const client = fake(() => identityRow)
    assert.deepEqual(await readImsSnapshot(client, options as never), { ok: false, reason: 'BAD_MODE' })
    assert.deepEqual(client.sent, [], 'nothing is sent for a refused request')
  }
})

test('open orders: links are joined by order, a link for an unknown order or a second link of one connector is refused', async () => {
  const order = (id: string) => ({ id, status: 'PROCESSING', currency: 'GBP', total: '10.0000', created: '2026-10-05T10:00:00.000Z', updated: null })
  const run = async (orders: Array<Record<string, unknown>>, links: Array<Record<string, unknown>>) => {
    const r = await readImsSnapshot(fake((sql) => /FROM sales_orders/.test(sql) && !/shopping_order_links/.test(sql) ? orders : links), { sections: ['orders'] })
    assert.ok(r.ok); return r.sections.orders!
  }
  const ok = await run([order('o1'), order('o2')], [{ order_id: 'o1', connector: 'woocommerce', external_id: '101' }])
  assert.ok(ok.ok)
  if (ok.ok) { assert.deepEqual(ok.value.map((o) => o.links.length), [1, 0]); assert.equal(ok.value[0]!.externalUpdatedAt, null) }
  assert.deepEqual(await run([order('o1')], [{ order_id: 'zz', connector: 'woocommerce', external_id: '101' }]), { ok: false, reason: 'SOURCE_UNREADABLE' })
  assert.deepEqual(await run([order('o1')], [{ order_id: 'o1', connector: 'woocommerce', external_id: '101' }, { order_id: 'o1', connector: 'woocommerce', external_id: '102' }]), { ok: false, reason: 'DUPLICATE_KEY' })
  assert.deepEqual(await run([{ ...order('o1'), status: 'SHIPPED' }], []), { ok: false, reason: 'SOURCE_UNREADABLE' }, 'a status outside the open set is not silently kept')
})

// ---- the boundary classifier -------------------------------------------------------------------

const B: PopulationBoundaries = { firstLoad: { state: 'verified', cutAt: '2026-10-01T10:00:00.000Z' }, storefrontImport: { state: 'completed', cutAt: '2026-10-02T10:00:00.000Z' }, retentionMonths: 0 }

test('classifier: before a recorded boundary is OUT with its reason; at the boundary or after is IN', () => {
  assert.deepEqual(classifyPopulation(B, 'storefront-order', '2026-10-02T09:59:59.999Z', '2026-10-19'), { kind: 'out', reason: 'BEFORE_STOREFRONT_IMPORT' })
  assert.deepEqual(classifyPopulation(B, 'storefront-order', '2026-10-02T10:00:00.000Z', '2026-10-19'), { kind: 'in' })
  assert.deepEqual(classifyPopulation(B, 'storefront-order', '2026-10-05T00:00:00.000Z', '2026-10-19'), { kind: 'in' })
  assert.deepEqual(classifyPopulation(B, 'first-load', '2026-10-01T09:00:00.000Z', '2026-10-19'), { kind: 'out', reason: 'BEFORE_FIRST_LOAD' })
  assert.deepEqual(classifyPopulation(B, 'first-load', '2026-10-01T10:00:00.000Z', '2026-10-19'), { kind: 'in' })
})

test('classifier: a missing, unverified or unreadable record, or no creation instant, is UNKNOWN (never in, never out)', () => {
  const unknown = { kind: 'unknown', reason: 'NO_POPULATION_RECORD' }
  const t = '2026-10-05T00:00:00.000Z'
  assert.deepEqual(classifyPopulation({ ...B, firstLoad: { state: 'absent' } }, 'first-load', t, '2026-10-19'), unknown)
  assert.deepEqual(classifyPopulation({ ...B, firstLoad: { state: 'unverified' } }, 'first-load', t, '2026-10-19'), unknown)
  assert.deepEqual(classifyPopulation({ ...B, storefrontImport: { state: 'not-completed' } }, 'storefront-order', t, '2026-10-19'), unknown)
  assert.deepEqual(classifyPopulation({ ...B, firstLoad: { state: 'verified', cutAt: 'garbage' } }, 'first-load', t, '2026-10-19'), unknown)
  for (const created of [null, '', 'not a date', '2026-10-05', '2026-13-45T00:00:00.000Z']) assert.deepEqual(classifyPopulation(B, 'storefront-order', created, '2026-10-19'), unknown, String(created))
  assert.deepEqual(classifyPopulation({ ...B, retentionMonths: 6 }, 'storefront-order', t, 'bad date'), unknown)
})

test('classifier: the retention horizon is asOf minus the recorded months (end-of-month clamped); zero keeps everything', () => {
  const kept = { ...B, storefrontImport: { state: 'completed', cutAt: '2020-01-01T00:00:00.000Z' } as const, retentionMonths: 6 }
  assert.deepEqual(classifyPopulation(kept, 'storefront-order', '2026-04-18T23:59:59.999Z', '2026-10-19'), { kind: 'out', reason: 'OLDER_THAN_RETENTION' })
  assert.deepEqual(classifyPopulation(kept, 'storefront-order', '2026-04-19T00:00:00.000Z', '2026-10-19'), { kind: 'in' })
  assert.deepEqual(classifyPopulation(kept, 'storefront-order', '2026-02-28T00:00:00.000Z', '2026-08-31'), { kind: 'in' }, '31 Aug - 6 months clamps to 28 Feb')
  assert.deepEqual(classifyPopulation(kept, 'storefront-order', '2026-02-27T23:00:00.000Z', '2026-08-31'), { kind: 'out', reason: 'OLDER_THAN_RETENTION' })
  assert.deepEqual(classifyPopulation({ ...kept, retentionMonths: 0 }, 'storefront-order', '2021-01-01T00:00:00.000Z', '2026-10-19'), { kind: 'in' })
})

test('alignment state: DISABLED takes no part, NOTIFICATION_ONLY and unconfirmed ALIGN are unconfirmed, confirmed ALIGN is confirmed', () => {
  assert.equal(alignmentState({ stockSyncMode: 'DISABLED', alignmentConfirmed: true }), 'disabled')
  assert.equal(alignmentState({ stockSyncMode: 'NOTIFICATION_ONLY', alignmentConfirmed: true }), 'unconfirmed')
  assert.equal(alignmentState({ stockSyncMode: 'ALIGN_TO_WMS', alignmentConfirmed: false }), 'unconfirmed')
  assert.equal(alignmentState({ stockSyncMode: 'ALIGN_TO_WMS', alignmentConfirmed: true }), 'confirmed')
})

// ---- the storefront status section (R9) ----------------------------------------------------------

// [mutation: a malformed admitted-status setting read as the default / a mapping status not checked against the enum]
test('storefrontStatus: the importer\'s admitted statuses (absent = its default, malformed = unreadable, normalised, unique) and every mapping row', async () => {
  const run = async (settings: Array<Record<string, unknown>>, mappings: Array<Record<string, unknown>> = []) => {
    const r = await readImsSnapshot(fake((sql) => /FROM settings/.test(sql) ? settings : /shopping_status_mappings/.test(sql) ? mappings : []), { sections: ['storefrontStatus'] })
    assert.ok(r.ok); return r.sections.storefrontStatus!
  }
  assert.deepEqual(await run([]), { ok: true, value: { configured: ['processing'], withdrawal: { submitted: 'pending-wdraw', approved: 'withdrawn' }, mappings: [] } }, 'absent = the documented default')
  assert.deepEqual(await run([{ key: 'wc_sync_order_statuses', value: '["wc-On-Hold"," processing ","on-hold"]' }], [{ external_status: 'wc-weird', ims_status: 'PICKING' }]), { ok: true, value: { configured: ['on-hold', 'processing'], withdrawal: { submitted: 'pending-wdraw', approved: 'withdrawn' }, mappings: [{ externalStatus: 'wc-weird', imsStatus: 'PICKING' }] } })
  assert.deepEqual(await run([{ key: 'wc_sync_order_statuses', value: '[]' }]), { ok: true, value: { configured: [], withdrawal: { submitted: 'pending-wdraw', approved: 'withdrawn' }, mappings: [] } }, 'an empty selection is a decision: import nothing')
  for (const value of ['not json', '{}', '"processing"', '[1]', '[""]', '["a b"]', '["x/y"]', '[null]', '["a\\nb"]', JSON.stringify(Array.from({ length: 101 }, (_, i) => `s${i}`)), null, 5]) {
    assert.deepEqual(await run([{ key: 'wc_sync_order_statuses', value }]), { ok: false, reason: 'SOURCE_UNREADABLE' }, String(value))
  }
  assert.deepEqual(await run([{ key: 'wc_sync_order_statuses', value: '["processing"]' }, { key: 'wc_sync_order_statuses', value: '["processing"]' }]), { ok: false, reason: 'DUPLICATE_KEY' })
  assert.deepEqual(await run([], [{ external_status: 'x', ims_status: 'NOT_A_STATUS' }]), { ok: false, reason: 'SOURCE_UNREADABLE' })
  assert.deepEqual(await run([], [{ external_status: 'x', ims_status: 'PICKING' }, { external_status: 'x', ims_status: 'PICKING' }]), { ok: false, reason: 'DUPLICATE_KEY' })
  assert.deepEqual(await run([], [{ external_status: '', ims_status: 'PICKING' }]), { ok: false, reason: 'BAD_KEY' })
})

// [mutation: a malformed withdrawal status read as the default / an empty value not defaulted]
test('storefrontStatus: the withdrawal pair is read as the importer reads it - the stored value normalised, the default when absent or empty, unreadable (never defaulted) when it is not a status slug', async () => {
  const run = async (settings: Array<Record<string, unknown>>) => {
    const r = await readImsSnapshot(fake((sql) => /FROM settings/.test(sql) ? settings : []), { sections: ['storefrontStatus'] })
    assert.ok(r.ok); return r.sections.storefrontStatus!
  }
  const pair = async (settings: Array<Record<string, unknown>>) => { const r = await run(settings); return r.ok ? r.value.withdrawal : r }
  assert.deepEqual(await pair([{ key: 'wc_withdrawal_submitted_status', value: ' WC-Wdraw-Asked ' }, { key: 'wc_withdrawal_approved_status', value: 'wdraw-done' }]), { submitted: 'wdraw-asked', approved: 'wdraw-done' })
  assert.deepEqual(await pair([{ key: 'wc_withdrawal_submitted_status', value: '' }]), { submitted: 'pending-wdraw', approved: 'withdrawn' }, 'an empty value is the default, as the importer reads it')
  for (const value of ['  ', 'a b', 'x/y', 'a'.repeat(65), 5, null]) assert.deepEqual(await run([{ key: 'wc_withdrawal_submitted_status', value }]), { ok: false, reason: 'SOURCE_UNREADABLE' }, String(value))
  assert.deepEqual(await run([{ key: 'wc_withdrawal_approved_status', value: 'a' }, { key: 'wc_withdrawal_approved_status', value: 'a' }]), { ok: false, reason: 'DUPLICATE_KEY' })
})

test('PIN: the withdrawal keys and defaults the pack reads are the connector\'s own', () => {
  const source = readFileSync('lib/connectors/woocommerce/sync/withdrawal.ts', 'utf8')
  for (const needle of [`WDRAW_SUBMITTED_STATUS_KEY = '${WDRAW_SUBMITTED_STATUS_KEY}'`, `WDRAW_APPROVED_STATUS_KEY = '${WDRAW_APPROVED_STATUS_KEY}'`, `DEFAULT_WDRAW_SUBMITTED_STATUS = '${WDRAW_DEFAULT_SUBMITTED_STATUS}'`, `DEFAULT_WDRAW_APPROVED_STATUS = '${WDRAW_DEFAULT_APPROVED_STATUS}'`, 'normaliseStatus(map.get(WDRAW_SUBMITTED_STATUS_KEY) || DEFAULT_WDRAW_SUBMITTED_STATUS)', 'normaliseStatus(map.get(WDRAW_APPROVED_STATUS_KEY) || DEFAULT_WDRAW_APPROVED_STATUS)']) assert.ok(source.includes(needle), needle)
})
