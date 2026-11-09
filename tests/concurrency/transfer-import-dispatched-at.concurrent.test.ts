import './scratch-database-setup' // FIRST: refuses to load unless the scratch database was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import * as fixtures from './po-landed-fixtures'

/**
 * importTransfersCsv: the optional `dispatchedAt` column moves ONLY the dispatch stamp (the stranded-in-transit clock reads it);
 * stock, FIFO consumption and the movement date stay at import time. Real action, real PostgreSQL, no network.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const SKIP = { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' } as const

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireRole: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async () => {} } })
mock.module('@/lib/domain/wms/mutation-audit', { namedExports: { recordWmsMutationEvent: async () => {} } })
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })
mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async () => {}, logActivityInTransaction: async () => {} },
})
mock.module('@/lib/fulfillment/backorder-allocator', { namedExports: { allocateBackordersForProducts: async () => ({}) } })
mock.module('@/lib/fulfillment/overallocation-rebalancer', { namedExports: { releaseOverallocations: async () => ({}) } })

test.before(async () => {
  if (!RUN) return
  fixtures.loadEnv()
  await fixtures.enableStockReceiptPosting()
})

async function seedSource(label: string) {
  const { db } = await import('@/lib/db')
  const po = await fixtures.seedPo(label, [10])
  const line = po.lines[0]!
  const received = await fixtures.receive(po, line, 10)
  assert.equal(received.success, true, received.error)
  const from = await db.warehouse.findUniqueOrThrow({ where: { id: po.warehouseId }, select: { code: true } })
  const to = await db.warehouse.create({ data: { code: `${fixtures.uid()}-D`, name: `${label} dest`, type: 'STANDARD' }, select: { code: true } })
  return { po, line, fromCode: from.code, toCode: to.code }
}

function form(rows: string[][], mode?: string): FormData {
  const csv = rows.map((row) => row.join(',')).join('\n')
  const fd = new FormData()
  fd.set('file', new File([csv], 'transfers.csv', { type: 'text/csv' }))
  if (mode) fd.set('mode', mode)
  return fd
}

const HEADER = ['transferKey', 'fromWarehouseCode', 'toWarehouseCode', 'status', 'sku', 'qty', 'dispatchedAt']

async function dispatchedAtOf(key: string) {
  const { db } = await import('@/lib/db')
  return db.stockTransfer.findFirst({ where: { reference: key }, select: { status: true, dispatchedAt: true, createdAt: true } })
}

test('dispatchedAt column: a date-only value is stamped 12:00 UK time; stock moves at import time', SKIP, async () => {
  const { importTransfersCsv } = await import('@/app/actions/import')
  const s = await seedSource('di-ok')
  const key = `${fixtures.uid()}-T1`
  const day = new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10)
  const result = await importTransfersCsv(form([HEADER, [key, s.fromCode, s.toCode, 'IN_TRANSIT', s.line.sku, '4', day]]))
  assert.equal(result.errors?.length ?? 0, 0, JSON.stringify(result.errors))
  const t = await dispatchedAtOf(key)
  assert.equal(t?.status, 'IN_TRANSIT')
  const [y, m, d] = day.split('-').map(Number)
  const hourUtc = t!.dispatchedAt!.getUTCHours()
  assert.ok(t!.dispatchedAt!.getUTCFullYear() === y && t!.dispatchedAt!.getUTCMonth() + 1 === m && t!.dispatchedAt!.getUTCDate() === d, 'same calendar day')
  assert.ok(hourUtc === 11 || hourUtc === 12, `12:00 London is 11:00 or 12:00 UTC, got ${hourUtc}`)
  assert.ok(t!.dispatchedAt!.getTime() < t!.createdAt.getTime(), 'the back-dated stamp precedes the transfer creation')
  assert.equal((await fixtures.snapshotOf(s.po, s.line)).stock, 6, 'the 4 left the source at import time')
})

test('dispatchedAt column: blank keeps the import time; DRAFT with a date, future and garbage are refused with nothing written', SKIP, async () => {
  const { importTransfersCsv } = await import('@/app/actions/import')
  const s = await seedSource('di-bad')
  const before = Date.now()
  const blankKey = `${fixtures.uid()}-B`
  const blank = await importTransfersCsv(form([HEADER, [blankKey, s.fromCode, s.toCode, 'IN_TRANSIT', s.line.sku, '1', '']]))
  assert.equal(blank.errors?.length ?? 0, 0, JSON.stringify(blank.errors))
  assert.ok((await dispatchedAtOf(blankKey))!.dispatchedAt!.getTime() >= before - 1000, 'blank = import time')

  const bad: Array<[string, string, RegExp]> = [
    ['DRAFT', '2026-01-01', /only allowed on IN_TRANSIT or RECEIVED/],
    ['IN_TRANSIT', new Date(Date.now() + 3 * 86_400_000).toISOString(), /in the future/],
    ['IN_TRANSIT', '20/10/2026', /must be YYYY-MM-DD/],
    ['IN_TRANSIT', '2000-01-01', /more than 366 days/],
  ]
  for (const [status, value, pattern] of bad) {
    const key = `${fixtures.uid()}-X`
    const result = await importTransfersCsv(form([HEADER, [key, s.fromCode, s.toCode, status, s.line.sku, '1', value]]))
    assert.match((result.errors ?? []).join(' | '), pattern, value)
    assert.equal(await dispatchedAtOf(key), null, `nothing written for ${value}`)
  }
  assert.equal((await fixtures.snapshotOf(s.po, s.line)).stock, 9, 'only the blank-date transfer moved stock')
})

test('dispatchedAt column: rows of one transferKey must agree, and preview validates the same way without writing', SKIP, async () => {
  const { importTransfersCsv } = await import('@/app/actions/import')
  const s = await seedSource('di-grp')
  const key = `${fixtures.uid()}-G`
  const day = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10)
  const other = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10)
  const mixed = await importTransfersCsv(form([HEADER,
    [key, s.fromCode, s.toCode, 'IN_TRANSIT', s.line.sku, '1', day],
    [key, s.fromCode, s.toCode, 'IN_TRANSIT', s.line.sku, '1', other]]))
  assert.match((mixed.errors ?? []).join(' | '), /inconsistent/)
  const previewKey = `${fixtures.uid()}-P`
  const preview = await importTransfersCsv(form([HEADER, [previewKey, s.fromCode, s.toCode, 'IN_TRANSIT', s.line.sku, '1', '2000-01-01']], 'preview'))
  assert.match(JSON.stringify(preview), /more than 366 days/)
  assert.equal(await dispatchedAtOf(previewKey), null)
})

test('one invalid row of an explicit transferKey group invalidates the WHOLE group: nothing is created, both rows are reported', SKIP, async () => {
  const { importTransfersCsv } = await import('@/app/actions/import')
  const s = await seedSource('di-poison')
  const key = `${fixtures.uid()}-Z`
  const day = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10)
  const future = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10)
  const result = await importTransfersCsv(form([HEADER,
    [key, s.fromCode, s.toCode, 'IN_TRANSIT', s.line.sku, '1', day],
    [key, s.fromCode, s.toCode, 'IN_TRANSIT', s.line.sku, '1', future]]))
  const errors = (result.errors ?? []).join(' | ')
  assert.match(errors, /Row 3: dispatchedAt .* in the future/, 'the invalid row is reported')
  assert.match(errors, new RegExp(`Transfer "${key}" was not created: row 3`), 'and the valid row\'s transfer is reported as not created')
  assert.equal(await dispatchedAtOf(key), null, 'no transfer exists')
  assert.equal((await fixtures.snapshotOf(s.po, s.line)).stock, 10, 'no stock moved')

  // A group whose rows all validate is still created whole (control).
  const okKey = `${fixtures.uid()}-Y`
  const ok = await importTransfersCsv(form([HEADER,
    [okKey, s.fromCode, s.toCode, 'IN_TRANSIT', s.line.sku, '1', day],
    [okKey, s.fromCode, s.toCode, 'IN_TRANSIT', s.line.sku, '2', day]]))
  assert.equal(ok.errors?.length ?? 0, 0, JSON.stringify(ok.errors))
  assert.ok(await dispatchedAtOf(okKey))
})

test('an invalid row FIRST in an explicit transferKey group invalidates the group too (not only a trailing one)', SKIP, async () => {
  const { importTransfersCsv } = await import('@/app/actions/import')
  const s = await seedSource('di-poison-first')
  const key = `${fixtures.uid()}-F`
  const day = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10)
  const future = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10)
  const result = await importTransfersCsv(form([HEADER,
    [key, s.fromCode, s.toCode, 'IN_TRANSIT', s.line.sku, '1', future],
    [key, s.fromCode, s.toCode, 'IN_TRANSIT', s.line.sku, '1', day],
    [key, s.fromCode, s.toCode, 'IN_TRANSIT', s.line.sku, '1', day]]))
  const errors = (result.errors ?? []).join(' | ')
  assert.match(errors, /Row 2: dispatchedAt .* in the future/)
  assert.match(errors, new RegExp(`Transfer "${key}" was not created: row 2`))
  assert.equal(await dispatchedAtOf(key), null, 'the later valid rows did not create a transfer on their own')
  assert.equal((await fixtures.snapshotOf(s.po, s.line)).stock, 10)
})
