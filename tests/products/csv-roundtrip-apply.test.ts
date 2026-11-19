import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { beforeEach, mock } from 'node:test'

import { runProductCsvEdit } from '@/lib/products/csv-roundtrip/run'
import { createProductCsvStore } from '@/lib/products/csv-roundtrip/store'
import { handleProductCsvDownload } from '@/lib/products/csv-roundtrip/download-handler'
import { handleProductCsvUpload, type ProductCsvUploadDeps } from '@/lib/products/csv-roundtrip/upload-handler'
import { hasPermission, type Permission } from '@/lib/permissions'

const state = { calls: [] as string[], inFlight: 0, peak: 0 }
const failing = new Set<string>()
const wmsFailing = new Set<string>()
mock.module('@/lib/shopping', {
  namedExports: {
    pushProductMetadata: async (id: string) => {
      state.calls.push(`push:${id}`)
      if (failing.has(id)) throw new Error('storefront down')
      state.inFlight++
      state.peak = Math.max(state.peak, state.inFlight)
      await new Promise((resolve) => setImmediate(resolve))
      state.inFlight--
      return { success: true }
    },
    enqueueStockSync: async (ids: string[], reason: string, options?: { force?: boolean }) => {
      state.calls.push(`stock:${ids.join(',')}:${reason}:${options?.force ? 'force' : ''}`)
    },
  },
})
mock.module('@/lib/domain/wms/product-sync-dispatch', {
  namedExports: {
    isAnyWmsConnectorEnabled: async () => true,
    syncWmsProductNow: async (id: string) => {
      state.calls.push(`wms:${id}`)
      if (wmsFailing.has(id)) throw new Error('Warehouse sync did not complete: product: product sync FAILED (1 error(s))')
    },
  },
})
mock.module('@/lib/trade/hs-classification-trigger', {
  namedExports: { invalidateStaleHsProposal: async (id: string) => { state.calls.push(`hs:${id}`) } },
})

beforeEach(() => { state.calls.length = 0; state.inFlight = 0; state.peak = 0 })

// ------------------------------------------------------------------ a counting database client for the real store

type Row = Record<string, unknown>
function makeClient(count: number) {
  const rows: Row[] = Array.from({ length: count }, (_, i) => ({
    id: `id-${i}`, sku: `V${i}`, name: `Name ${i}`, description: 'd', barcode: null, mpn: null, countryOfOrigin: 'GB',
    weight: '0.5', widthCm: null, heightCm: null, depthCm: null, imageUrl: null, salesPriceBase: '9.99', salePriceBase: null,
    salesPriceTaxInclusive: false, stockUnit: 'pcs', oversellAllowed: true, preferredSupplierId: null,
    preferredSupplierLocked: false, categoryId: null, lifecycleStatus: 'ACTIVE', updatedAt: new Date('2026-11-01T10:00:00.000Z'),
  }))
  const bySku = new Map(rows.map((r) => [r.sku as string, r]))
  const log: string[] = []
  const marked: string[] = []
  const client = {
    supplier: { findMany: async () => { log.push('supplier.findMany'); return [] } },
    productCategory: { findMany: async () => { log.push('category.findMany'); return [] } },
    product: {
      findMany: async (args: { where: { sku?: { in: string[] }; barcode?: { in: string[] } } }) => {
        log.push('product.findMany')
        return (args.where.sku?.in ?? []).flatMap((sku) => (bySku.has(sku) ? [bySku.get(sku)!] : []))
      },
    },
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      log.push('$transaction')
      return cb({
        $queryRaw: async (sql: { values: unknown[] }) => { log.push('$executeRaw'); return sql.values.filter((v) => typeof v === 'string' && String(v).startsWith('id-')).map((id) => ({ id })) },
        $executeRaw: async (sql: { values: unknown[] }) => { log.push('marks'); marked.push(...(sql.values.find(Array.isArray) as string[])); return 0 },
      })
    },
  }
  return { client, log, marked }
}

test('SCALE: thousands of rows cost a bounded number of queries, not one per row', async () => {
  const N = 5000
  const { client, log } = makeClient(N)
  const file = ['sku,name,weight,salesPriceBase', ...Array.from({ length: N }, (_, i) => `V${i},Edited ${i},0.75,12.5`)].join('\n')

  const started = Date.now()
  const result = await runProductCsvEdit({ mode: 'apply', text: file, canUse: () => true, store: createProductCsvStore(client as never) })
  const elapsed = Date.now() - started

  assert.equal(result.written, N)
  assert.equal(result.errorRows, 0)
  const reads = log.filter((q) => q === 'product.findMany').length
  const writes = log.filter((q) => q === '$executeRaw').length
  // 1000 rows per read chunk and at most 250 products per statement: 5 reads, 20 writes, 2 lookup reads.
  assert.equal(reads, Math.ceil(N / 1000))
  assert.equal(writes, Math.ceil(N / 250))
  assert.equal(log.filter((q) => q === 'marks').length, writes, 'one mark statement per batch, in its transaction')
  assert.ok(log.length <= 2 + 5 + 3 * 20, `${log.length} round trips for ${N} rows`)
  assert.ok(log.length < N / 50, 'orders of magnitude below one query per row')
  console.log(`# scale: ${N} rows, ${log.length} client calls (${reads} reads, ${writes} statements), ${elapsed} ms`)
})

test('SCALE: a 20,000-variant preview reads in bulk and keeps its report bounded', async () => {
  const N = 20_000
  const { client, log } = makeClient(N)
  const file = ['sku,name', ...Array.from({ length: N }, (_, i) => `V${i},Edited ${i}`)].join('\n')
  const result = await runProductCsvEdit({ mode: 'preview', text: file, canUse: () => true, store: createProductCsvStore(client as never) })
  assert.equal(result.changedProducts, N)
  assert.ok(result.diffs.length <= 300 && result.diffsTruncated)
  assert.equal(log.filter((q) => q === '$transaction').length, 0)
  assert.equal(log.filter((q) => q === 'product.findMany').length, 20)
})

// ------------------------------------------------------------------ the sweep: the editor's follow-up, paced

type Mark = { productId: string; storefrontPending: boolean; warehousePending: boolean; updatedAt: Date }
const sweepWorld = { marks: [] as Mark[], deleted: [] as string[], released: [] as string[], limitsSeen: [] as number[], claimSql: [] as string[], lifecycle: new Map<string, string>() }
mock.module('@/lib/db', {
  namedExports: {
    db: {
      $queryRaw: async (sql: { sql: string; values: unknown[] }) => {
        if (/UPDATE "product_sync_marks" SET "claimedAt" = now\(\)/.test(sql.sql)) {
          const limit = sql.values.find((v) => typeof v === 'number' && v <= 1000 && v !== 5 && v !== 15) as number
          sweepWorld.limitsSeen.push(limit)
          sweepWorld.claimSql.push(sql.sql)
          return sweepWorld.marks.splice(0, limit)
        }
        return [{ remaining: sweepWorld.marks.length, parked: 0 }]
      },
      $executeRaw: async (sql: { sql: string; values: unknown[] }) => {
        if (/^\s*DELETE/.test(sql.sql)) sweepWorld.deleted.push(sql.values[0] as string)
        else sweepWorld.released.push(sql.values[1] as string)
        return 1
      },
      product: { findMany: async (args: { where: { id: { in: string[] } } }) => args.where.id.in.map((id) => ({ id, lifecycleStatus: sweepWorld.lifecycle.get(id) ?? 'ACTIVE' })) },
    },
  },
})
const marksFor = (n: number, prefix = 'm'): Mark[] => Array.from({ length: n }, (_, i) => ({ productId: `${prefix}${i}`, storefrontPending: true, warehousePending: true, updatedAt: new Date(0) }))

test('SWEEP: each run takes at most the batch size, whatever is asked for or owed', async () => {
  const { runProductSyncSweep } = await import('@/lib/products/csv-roundtrip/sync-sweep')
  const { PRODUCT_SYNC_SWEEP_BATCH } = await import('@/lib/products/csv-roundtrip/sync-constants')
  sweepWorld.marks = marksFor(60)
  sweepWorld.deleted.length = 0; sweepWorld.limitsSeen.length = 0
  const first = await runProductSyncSweep({ limit: 100_000 })
  assert.equal(PRODUCT_SYNC_SWEEP_BATCH, 25)
  assert.deepEqual(sweepWorld.limitsSeen, [25], 'a larger request is capped at the batch size')
  assert.equal(first.claimed, 25)
  assert.equal(first.remaining, 35)
  assert.equal(state.calls.filter((c) => c.startsWith('push:')).length, 25)
  assert.equal(state.calls.filter((c) => c.startsWith('wms:')).length, 25, 'warehouse sync once per owed product, awaited one by one')
  assert.equal(state.calls.filter((c) => c.startsWith('stock:')).length, 1, 'one stock sync through the shopping queue for the batch')
  assert.ok(state.peak <= 5)
  assert.equal(sweepWorld.deleted.length, 25, 'handed-over marks are deleted')
  const second = await runProductSyncSweep()
  assert.equal(second.claimed, 25)
  const third = await runProductSyncSweep()
  assert.deepEqual([third.claimed, third.remaining], [10, 0])
})

test('SWEEP: archived products get a forced stock sync, a failed push keeps its mark, a warehouse-less mark makes no warehouse call', async () => {
  const { runProductSyncSweep } = await import('@/lib/products/csv-roundtrip/sync-sweep')
  sweepWorld.marks = [
    { productId: 'live', storefrontPending: true, warehousePending: false, updatedAt: new Date(0) },
    { productId: 'gone', storefrontPending: true, warehousePending: false, updatedAt: new Date(0) },
  ]
  sweepWorld.lifecycle.set('gone', 'ARCHIVED')
  sweepWorld.deleted.length = 0; sweepWorld.released.length = 0
  const result = await runProductSyncSweep()
  sweepWorld.lifecycle.clear()
  assert.deepEqual(state.calls.filter((c) => c.startsWith('stock:')).sort(), ['stock:gone:IMS_CHANGE:force', 'stock:live:IMS_CHANGE:'])
  assert.deepEqual(state.calls.filter((c) => c.startsWith('wms:')), [])
  assert.equal(result.failed, 0)
})

test('SWEEP: a product whose storefront push throws is released with its error, not deleted', async () => {
  const { runProductSyncSweep } = await import('@/lib/products/csv-roundtrip/sync-sweep')
  sweepWorld.marks = marksFor(2, 'f')
  sweepWorld.deleted.length = 0; sweepWorld.released.length = 0
  failing.add('f0')
  const result = await runProductSyncSweep()
  failing.clear()
  assert.equal(result.failed, 1)
  assert.deepEqual(sweepWorld.released, ['f0'])
  assert.deepEqual(sweepWorld.deleted, ['f1'])
})

test('REGRESSION: a warehouse sync that fails (FAILED, PARTIAL or ERROR surfaces as a throw) keeps the mark and counts the attempt', async () => {
  const { runProductSyncSweep } = await import('@/lib/products/csv-roundtrip/sync-sweep')
  sweepWorld.marks = marksFor(3, 'w')
  sweepWorld.deleted.length = 0; sweepWorld.released.length = 0
  wmsFailing.add('w0'); wmsFailing.add('w1')
  const result = await runProductSyncSweep()
  wmsFailing.clear()
  assert.equal(result.failed, 2)
  assert.deepEqual(sweepWorld.released.sort(), ['w0', 'w1'], 'released with the error, lease cleared, not deleted')
  assert.deepEqual(sweepWorld.deleted, ['w2'])
  assert.ok(sweepWorld.claimSql.some((q) => /"attempts" = "attempts" \+ 1/.test(q)), 'the claim counts the attempt')
})

test('the sweep and the apply write to no vendor directly', () => {
  for (const file of ['lib/products/csv-roundtrip/sync-sweep.ts', 'lib/products/csv-roundtrip/store.ts', 'lib/products/csv-roundtrip/upload-handler.ts']) {
    const source = readFileSync(join(process.cwd(), file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    assert.ok(!/wcPost|wcPut|pushImsProductToWc|upsertMintsoftProduct|fetch\(/.test(source), file)
  }
})

// ------------------------------------------------------------------ the handlers: permissions and the apply wiring

const session = (role: string) => ({ user: { id: 'u1', role } }) as never
function uploadDeps(role: string | null, client: unknown): ProductCsvUploadDeps & { out: string[] } {
  const out: string[] = []
  return {
    out,
    requireApiAuth: async () => (role ? session(role) : new Response('Unauthorized', { status: 401 })),
    client: client as never,
    logActivity: (async (entry: { action: string }) => { out.push(`log:${entry.action}`) }) as never,
    revalidateInventory: () => { out.push('revalidate') },
  }
}
function upload(text: string, mode: string) {
  const form = new FormData()
  form.append('file', new File([text], 'edit.csv', { type: 'text/csv' }))
  form.append('mode', mode)
  return new Request('https://ims.test/api/products/csv-edit/upload', { method: 'POST', body: form })
}

test('upload: anonymous 401, no inventory.edit 403 (FINANCE can see prices but not edit)', async () => {
  const { client } = makeClient(1)
  assert.equal((await handleProductCsvUpload(upload('sku,name\nV0,x', 'apply'), uploadDeps(null, client))).status, 401)
  assert.equal((await handleProductCsvUpload(upload('sku,name\nV0,x', 'apply'), uploadDeps('FINANCE', client))).status, 403)
  assert.equal((await handleProductCsvUpload(upload('sku,name\nV0,x', 'apply'), uploadDeps('READONLY', client))).status, 403)
})

test('upload: price columns are refused for an editor without inventory.prices, and nothing is read or written', async () => {
  const { client, log } = makeClient(1)
  assert.equal(hasPermission('WAREHOUSE', 'inventory.edit' as Permission), true)
  assert.equal(hasPermission('WAREHOUSE', 'inventory.prices' as Permission), false)
  const deps = uploadDeps('WAREHOUSE', client)
  const response = await handleProductCsvUpload(upload('sku,salesPriceBase\nV0,1.00', 'apply'), deps)
  const body = await response.json() as { fatal: string }
  assert.equal(response.status, 400)
  assert.match(body.fatal, /salesPriceBase.*inventory\.prices/)
  assert.deepEqual(log, [])
  assert.deepEqual(deps.out, [])
})

test('upload: preview writes nothing; apply writes, marks the sync owed, logs, and makes ZERO vendor calls inline', async () => {
  const { client, log, marked } = makeClient(2)
  const previewDeps = uploadDeps('ADMIN', client)
  const dry = await (await handleProductCsvUpload(upload('sku,name\nV0,A\nV1,B', 'preview'), previewDeps)).json() as { changedProducts: number }
  assert.equal(dry.changedProducts, 2)
  assert.deepEqual(previewDeps.out, [])
  assert.ok(!log.includes('$executeRaw') && marked.length === 0)

  const deps = uploadDeps('ADMIN', client)
  const done = await (await handleProductCsvUpload(upload('sku,name\nV0,A\nV1,B', 'apply'), deps)).json() as { written: number; syncQueued: number; warnings: string[] }
  assert.equal(done.written, 2)
  assert.equal(done.syncQueued, 2)
  assert.deepEqual(marked.sort(), ['id-0', 'id-1'])
  assert.deepEqual(deps.out.filter((o) => o !== 'log:csv_edited'), ['log:imported', 'revalidate'])
  assert.deepEqual(state.calls, [], 'no storefront, stock or warehouse call was made')
  assert.match(done.warnings.join(' '), /will reach the shop and the warehouse over the next sync runs \(25 products every 5 minutes\)/)
})

test('REGRESSION (bulk): applying thousands of products makes zero vendor calls inline and marks every one', async () => {
  const N = 3000
  const { client, marked } = makeClient(N)
  const deps = uploadDeps('ADMIN', client)
  const file = ['sku,name', ...Array.from({ length: N }, (_, i) => `V${i},Bulk ${i}`)].join('\n')
  const done = await (await handleProductCsvUpload(upload(file, 'apply'), deps)).json() as { written: number }
  assert.equal(done.written, N)
  assert.equal(new Set(marked).size, N)
  assert.deepEqual(state.calls, [])
})

test('upload: a role without the sync permission does not owe the warehouse sync (the editor rule), and is told', async () => {
  const { client } = makeClient(1)
  const deps = uploadDeps('WAREHOUSE', client)
  const done = await (await handleProductCsvUpload(upload('sku,name\nV0,A', 'apply'), deps)).json() as { warnings: string[] }
  assert.match(done.warnings.join(' '), /reach the shop over the next sync runs/)
  assert.ok(!/and the warehouse over/.test(done.warnings.join(' ')))
})

test('download: price columns need inventory.prices, and the role needs inventory.edit', async () => {
  const { client } = makeClient(1)
  const req = (columns: string[]) => new Request('https://ims.test/d', { method: 'POST', body: JSON.stringify({ mode: 'ids', ids: ['id-0'], columns }) })
  const deps = (role: string) => ({ requireApiAuth: async () => session(role), client: client as never })
  assert.equal((await handleProductCsvDownload(req(['name']), deps('FINANCE'))).status, 403)
  assert.equal((await handleProductCsvDownload(req(['salesPriceBase']), deps('WAREHOUSE'))).status, 403)
  assert.equal((await handleProductCsvDownload(req(['bogus']), deps('ADMIN'))).status, 400)
})

