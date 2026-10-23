import assert from 'node:assert/strict'
import test from 'node:test'

import { WMS_MIN_REQUEST_INTERVAL_MS, WMS_PRODUCT_LIST_LIMIT } from '../../lib/reconciliation-pack/constants.ts'
import { clampedWmsLimit, readWms, type WmsProductRow, type WmsStockRow } from '../../lib/reconciliation-pack/wms-source.ts'
import { fakeWms, noSleep, PROBE_WH5, PROBE_WH6, toStockRow, type FakeWmsData, type WmsTweak } from './wms-fixtures.ts'

/**
 * THE WAREHOUSE-SYSTEM SOURCE over a double of the port: what a read PROVES. Mutations are listed in the PR.
 */

const probe = (): FakeWmsData => ({ stock: { '5': PROBE_WH5.map(toStockRow), '6': PROBE_WH6.map(toStockRow) } })
const synthetic = (n: number): WmsProductRow[] => Array.from({ length: n }, (_, i) => ({ id: String(1000 + i), sku: `SYN-${1000 + i}` }))
const reasonOf = (r: Awaited<ReturnType<typeof readWms>>) => (r.ok ? 'ok' : r.reason)

test('a full read is two stock sweeps then two proven product scans, in that order, paced, and holds the probe rows as they are', async () => {
  const wms = fakeWms(probe())
  const sleeps: number[] = []
  const read = await readWms(wms, ['5', '6'], { sleep: async (ms) => { sleeps.push(ms) } })
  assert.ok(read.ok)
  assert.deepEqual(wms.calls.map((c) => (c.kind === 'stock' ? `stock ${c.warehouse}` : `page ${c.pageNo}/${c.limit}`)), [
    'stock 5', 'stock 6', 'stock 5', 'stock 6',
    'page 1/100', 'page 2/100', 'page 1/100', 'page 2/100',
  ], '12 products: one short page, the page after it as the end proof; then the same again')
  assert.equal(sleeps.length, wms.calls.length - 1, 'a pause before every request but the first')
  assert.ok(sleeps.every((ms) => ms === WMS_MIN_REQUEST_INTERVAL_MS))
  assert.equal(read.value.stock.get('6')!.find((r) => r.sku === '129552751')!.onHand, 36, 'on hand is TotalStockLevel (36), not Level (28)')
  assert.equal(read.value.census.length, 12)
  assert.equal(read.value.allEmpty, false)
})

// [mutation: the second stock sweep removed, or only the row COUNTS compared]
test('STOCK INSTABILITY: any row that differs between the two sweeps (figure, bundle flag, product id, a SKU in one sweep only, a swapped SKU) is VENDOR_READ_UNSTABLE and there is no list', async () => {
  const change = (mutate: (rows: WmsStockRow[]) => WmsStockRow[]): WmsTweak => (call, n) => {
    if (call.kind !== 'stock' || n !== 3) return undefined // sweep B, warehouse 5 (calls: 1,2 = sweep A; 3,4 = sweep B)
    return { ok: true, value: mutate(PROBE_WH5.map(toStockRow)) }
  }
  const cases: Array<[string, (rows: WmsStockRow[]) => WmsStockRow[]]> = [
    ['a figure moved', (rows) => rows.map((r) => (r.sku === '129552751' ? { ...r, onHand: 35 } : r))],
    ['a bundle flag flipped', (rows) => rows.map((r) => (r.sku === '129552751' ? { ...r, bundle: true } : r))],
    ['a product id changed', (rows) => rows.map((r) => (r.sku === '129552751' ? { ...r, productId: '999999' } : r))],
    ['a SKU left', (rows) => rows.filter((r) => r.sku !== '129552751')],
    ['a SKU appeared', (rows) => [...rows, { sku: 'NEW-1', productId: '777', onHand: 1, bundle: false }]],
    ['same count, one SKU swapped for another', (rows) => rows.map((r) => (r.sku === '129552751' ? { ...r, sku: 'SWAPPED-1' } : r))],
  ]
  for (const [label, mutate] of cases) {
    const wms = fakeWms(probe(), change(mutate))
    assert.equal(reasonOf(await readWms(wms, ['5', '6'], { sleep: noSleep })), 'VENDOR_READ_UNSTABLE', label)
  }
})

test('a SKU or a product id that repeats inside one list is DUPLICATE_KEY; one SKU under two product ids (or an id under two SKUs) across warehouses is IDENTITY_CONFLICT', async () => {
  const dup = (rows: WmsStockRow[]): WmsTweak => (call) => (call.kind === 'stock' && call.warehouse === '5' ? { ok: true, value: rows } : undefined)
  const base = PROBE_WH5.map(toStockRow)
  assert.equal(reasonOf(await readWms(fakeWms(probe(), dup([...base, { ...base[0]!, productId: '31337' }])), ['5'], { sleep: noSleep })), 'DUPLICATE_KEY')
  assert.equal(reasonOf(await readWms(fakeWms(probe(), dup([...base, { ...base[0]!, sku: 'OTHER-SKU' }])), ['5'], { sleep: noSleep })), 'DUPLICATE_KEY')
  const swapped: FakeWmsData = { stock: { '5': base, '6': PROBE_WH6.map(toStockRow).map((r) => (r.sku === '129552751' ? { ...r, productId: '5555' } : r)) } }
  assert.equal(reasonOf(await readWms(fakeWms(swapped), ['5', '6'], { sleep: noSleep })), 'IDENTITY_CONFLICT')
  const otherSku: FakeWmsData = { stock: { '5': base, '6': PROBE_WH6.map(toStockRow).map((r) => (r.sku === '129552751' ? { ...r, sku: 'RENAMED' } : r)) } }
  assert.equal(reasonOf(await readWms(fakeWms(otherSku), ['5', '6'], { sleep: noSleep })), 'IDENTITY_CONFLICT')
})

// [mutation: the clamp removed from the source]
test('THE LIMIT IS CLAMPED, NEVER ABOVE 100: 101, 500, NaN, 0, a negative and a string all ask for a page size inside 1..100', async () => {
  assert.equal(WMS_PRODUCT_LIST_LIMIT, 100)
  for (const [asked, expected] of [[101, 100], [500, 100], [Number.MAX_SAFE_INTEGER, 100], [100, 100], [30, 30], [1.9, 1], [0, 1], [-5, 1], [Number.NaN, 100], [Number.POSITIVE_INFINITY, 100], ['500', 100], [undefined, 100], [null, 100]] as const) {
    assert.equal(clampedWmsLimit(asked), expected, String(asked))
  }
  const wms = fakeWms({ stock: { '5': [] }, census: synthetic(250) })
  const read = await readWms(wms, ['5'], { sleep: noSleep, limit: 500 })
  assert.ok(read.ok)
  for (const call of wms.calls) if (call.kind === 'page') assert.ok(call.limit <= 100 && call.limit >= 1, `limit ${call.limit}`)
})

// [mutation: the end-proof request (the page after a short page) removed]
test('PAGING: pages are exactly the limit until a short one, and the page AFTER the short one is asked for and must be empty - including when the list is an exact multiple of the limit', async () => {
  for (const [n, pages] of [[250, ['1', '2', '3', '4']], [200, ['1', '2', '3', '4']], [99, ['1', '2']], [100, ['1', '2', '3']], [0, ['1', '2']]] as const) {
    const wms = fakeWms({ stock: { '5': [] }, census: synthetic(n) })
    const read = await readWms(wms, ['5'], { sleep: noSleep })
    assert.ok(read.ok, `n=${n}`)
    assert.equal(read.value.census.length, n)
    const first = wms.calls.filter((c) => c.kind === 'page').slice(0, pages.length).map((c) => String((c as { pageNo: number }).pageNo))
    assert.deepEqual(first, [...pages], `n=${n}: the scan stops one page after the first short one`)
    assert.equal(wms.calls.filter((c) => c.kind === 'page').length, pages.length * 2, `n=${n}: read twice`)
  }
})

test('TRUNCATION AND DRIFT of the census: a page after the short one that still serves rows, a page larger than the limit, a repeated id, a repeated SKU, and a second scan that differs are all refused', async () => {
  const all = synthetic(250)
  const run = (tweak: WmsTweak, census = all) => readWms(fakeWms({ stock: { '5': [] }, census }, tweak), ['5'], { sleep: noSleep }).then(reasonOf)
  // calls: 1 = stock A, 2 = stock B, 3.. = scan 1 pages 1,2,3 (50 rows) and the end proof page 4
  // A truncation that is the SAME every time: page 3 is cut short and page 4 still holds the rest. Only the page after the short one can tell.
  assert.equal(await run((c) => (c.kind === 'page' && c.pageNo === 3 ? { ok: true, value: all.slice(200, 230) } : c.kind === 'page' && c.pageNo === 4 ? { ok: true, value: all.slice(230) } : undefined)), 'VENDOR_READ_UNSTABLE', 'the short page was a TRUNCATION: the page after it still serves rows')
  assert.equal(await run((c, n) => (c.kind === 'page' && c.pageNo === 4 && n === 6 ? { ok: true, value: all.slice(0, 1) } : undefined)), 'VENDOR_READ_UNSTABLE', 'the end proof returns a row')
  assert.equal(await run((c) => (c.kind === 'page' && c.pageNo === 1 ? { ok: true, value: all.slice(0, 101) } : undefined)), 'VENDOR_READ_UNSTABLE', 'more rows than the limit')
  assert.equal(await run((c) => (c.kind === 'page' && c.pageNo === 2 ? { ok: true, value: all.slice(0, 100) } : undefined)), 'VENDOR_READ_UNSTABLE', 'a vendor that ignores the page repeats ids')
  assert.equal(await run((c) => (c.kind === 'page' && c.pageNo === 2 ? { ok: true, value: all.slice(100, 200).map((r, i) => (i === 0 ? { ...r, sku: all[0]!.sku } : r)) } : undefined)), 'IDENTITY_CONFLICT', 'one SKU under two ids')
  // scan 2 differs from scan 1 (calls 3..6 are scan 1, 7.. scan 2)
  assert.equal(await run((c, n) => (c.kind === 'page' && c.pageNo === 3 && n > 6 ? { ok: true, value: all.slice(200, 249) } : undefined)), 'VENDOR_READ_UNSTABLE', 'a product left between the scans')
  assert.equal(await run((c, n) => (c.kind === 'page' && c.pageNo === 3 && n > 6 ? { ok: true, value: [...all.slice(200), { id: '90001', sku: 'LATE-1' }] } : undefined)), 'VENDOR_READ_UNSTABLE', 'a product appeared between the scans')
  assert.equal(await run((c, n) => (c.kind === 'page' && c.pageNo === 3 && n > 6 ? { ok: true, value: all.slice(200).map((r, i) => (i === 0 ? { ...r, sku: 'RENAMED-1' } : r)) } : undefined)), 'VENDOR_READ_UNSTABLE', 'a SKU changed under its id')
  assert.equal(await run(() => undefined), 'ok')
})

// [mutation: containment removed]
test('CONTAINMENT: every product a stock list shows must be in the census with the same SKU (absent is READ_INCOMPLETE, another SKU is IDENTITY_CONFLICT)', async () => {
  const stock = { '5': PROBE_WH5.map(toStockRow) }
  const census = PROBE_WH5.map((r) => ({ id: String(r.ProductId), sku: r.SKU }))
  assert.equal(reasonOf(await readWms(fakeWms({ stock, census }), ['5'], { sleep: noSleep })), 'ok')
  assert.equal(reasonOf(await readWms(fakeWms({ stock, census: census.slice(1) }), ['5'], { sleep: noSleep })), 'READ_INCOMPLETE')
  assert.equal(reasonOf(await readWms(fakeWms({ stock, census: census.map((r, i) => (i === 0 ? { ...r, sku: 'ELSE-1' } : r)) }), ['5'], { sleep: noSleep })), 'IDENTITY_CONFLICT')
})

test('the request budget and the page cap are CAP_EXCEEDED, never a shorter list; the warehouse list is validated', async () => {
  assert.equal(reasonOf(await readWms(fakeWms(probe()), ['5', '6'], { sleep: noSleep, budget: 5 })), 'CAP_EXCEEDED')
  assert.equal(reasonOf(await readWms(fakeWms(probe()), ['5', '6'], { sleep: noSleep, budget: 8 })), 'ok', '4 stock reads + 2 pages x 2 scans = 8')
  assert.equal(reasonOf(await readWms(fakeWms({ stock: { '5': [] }, census: synthetic(500) }), ['5'], { sleep: noSleep, maxPages: 3 })), 'CAP_EXCEEDED')
  assert.equal(reasonOf(await readWms(fakeWms(probe()), [], { sleep: noSleep })), 'CAP_EXCEEDED')
  assert.equal(reasonOf(await readWms(fakeWms(probe()), Array.from({ length: 21 }, (_, i) => String(i + 1)), { sleep: noSleep })), 'CAP_EXCEEDED')
  for (const bad of [['5', '5'], ['0'], ['05'], ['5a'], [''], ['-1'], ['1e3']]) assert.equal(reasonOf(await readWms(fakeWms(probe()), bad, { sleep: noSleep })), 'BAD_KEY', JSON.stringify(bad))
})

test('a port that fails, throws or answers something that is not a result is a closed reason and no list; a port reason outside the closed set is SOURCE_UNREADABLE', async () => {
  const fail = (value: unknown): WmsTweak => (call) => (call.kind === 'stock' ? (value as never) : undefined)
  assert.equal(reasonOf(await readWms(fakeWms(probe(), fail({ ok: false, reason: 'VENDOR_AUTH_REFUSED' })), ['5'], { sleep: noSleep })), 'VENDOR_AUTH_REFUSED')
  assert.equal(reasonOf(await readWms(fakeWms(probe(), fail({ ok: false, reason: 'free text with the key abc123' })), ['5'], { sleep: noSleep })), 'SOURCE_UNREADABLE')
  assert.equal(reasonOf(await readWms(fakeWms(probe(), fail(42)), ['5'], { sleep: noSleep })), 'SOURCE_UNREADABLE')
  assert.equal(reasonOf(await readWms(fakeWms(probe(), fail({ ok: true, value: 'rows' })), ['5'], { sleep: noSleep })), 'SOURCE_UNREADABLE')
  assert.equal(reasonOf(await readWms(fakeWms(probe(), fail({ ok: true, value: [{ sku: '', productId: '1', onHand: 1, bundle: false }] })), ['5'], { sleep: noSleep })), 'SOURCE_UNREADABLE')
  assert.equal(reasonOf(await readWms(fakeWms(probe(), fail({ ok: true, value: [{ sku: 'A', productId: '1', onHand: 1.5, bundle: false }] })), ['5'], { sleep: noSleep })), 'SOURCE_UNREADABLE')
  assert.equal(reasonOf(await readWms(fakeWms(probe(), fail({ ok: true, value: [{ sku: 'A', productId: '1', onHand: -1, bundle: false }] })), ['5'], { sleep: noSleep })), 'SOURCE_UNREADABLE')
  assert.equal(reasonOf(await readWms(fakeWms(probe(), fail({ ok: true, value: [{ sku: 'A', productId: '01', onHand: 1, bundle: false }] })), ['5'], { sleep: noSleep })), 'SOURCE_UNREADABLE')
  const throwing = { ...fakeWms(probe()), stockLevels: async () => { throw new Error('secret value') } }
  assert.equal(reasonOf(await readWms(throwing, ['5'], { sleep: noSleep })), 'SOURCE_UNREADABLE')
})

test('an empty estate (no stock rows, no products) is reported as such, so a caller can name the proof; one product or one row is not empty', async () => {
  const none = await readWms(fakeWms({ stock: { '5': [], '6': [] }, census: [] }), ['5', '6'], { sleep: noSleep })
  assert.ok(none.ok && none.value.allEmpty)
  const one = await readWms(fakeWms({ stock: { '5': [], '6': [] }, census: synthetic(1) }), ['5', '6'], { sleep: noSleep })
  assert.ok(one.ok && !one.value.allEmpty)
})
