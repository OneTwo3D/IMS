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
mock.module('@/lib/shopping', {
  namedExports: {
    pushProductMetadata: async (id: string) => {
      state.calls.push(`push:${id}`)
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
    scheduleWmsProductSync: (id: string) => { state.calls.push(`wms:${id}`) },
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
      return cb({ $queryRaw: async (sql: { values: unknown[] }) => { log.push('$executeRaw'); return sql.values.filter((v) => typeof v === 'string' && String(v).startsWith('id-')).map((id) => ({ id })) } })
    },
  }
  return { client, log }
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
  assert.ok(log.length <= 2 + 5 + 2 * 20, `${log.length} round trips for ${N} rows`)
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

// ------------------------------------------------------------------ the follow-up is the editor's follow-up

test('apply hands edited products to the same sync the product editor uses', async () => {
  const sync = await import('@/lib/products/csv-roundtrip/sync')
  await sync.runProductCsvStorefrontSync([
    { id: 'p1', lifecycleStatus: 'ACTIVE', classificationChanged: true },
    { id: 'p2', lifecycleStatus: 'ARCHIVED', classificationChanged: false },
  ])
  const wms = await sync.scheduleProductCsvWmsSync([{ id: 'p1', lifecycleStatus: 'ACTIVE', classificationChanged: true }])
  assert.deepEqual(wms, { scheduled: 1, deferred: 0 })
  assert.deepEqual(state.calls.sort(), ['hs:p1', 'push:p1', 'push:p2', 'stock:p1:IMS_CHANGE:', 'stock:p2:IMS_CHANGE:force', 'wms:p1'].sort())

  // The editor's own tail, read from its source: the same four calls with the same arguments.
  const editor = readFileSync(join(process.cwd(), 'app/actions/products.ts'), 'utf8')
  const tail = editor.slice(editor.indexOf('export async function updateProduct'), editor.indexOf('export type ProductSupplierRow'))
  assert.match(tail, /pushProductMetadata\(id\)/)
  assert.match(tail, /enqueueStockSync\(\[id\], 'IMS_CHANGE', \{\s*force: data\.lifecycleStatus === 'ARCHIVED'/)
  assert.match(tail, /isAnyWmsConnectorEnabled\(\)/)
  assert.match(tail, /scheduleWmsProductSync\(id\)/)
  assert.match(tail, /invalidateStaleHsProposal\(id\)/)
  assert.match(tail, /hasPermission\(session\.user\.role, 'sync'\)/)
})

test('the sync module writes to no vendor directly', () => {
  const source = readFileSync(join(process.cwd(), 'lib/products/csv-roundtrip/sync.ts'), 'utf8')
  assert.ok(!/wcPost|wcPut|pushImsProductToWc|upsertMintsoftProduct|fetch\(/.test(source.replace(/\/\*[\s\S]*?\*\//g, '')))
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
    scheduleWmsSync: async () => { out.push('wms') },
    afterResponse: (task) => { out.push('after'); void task() },
    storefrontSync: async (targets) => { out.push(`storefront:${targets.length}`) },
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

test('upload: preview writes and syncs nothing; apply writes, logs, revalidates and queues the sync after the response', async () => {
  const { client, log } = makeClient(2)
  const previewDeps = uploadDeps('ADMIN', client)
  const dry = await (await handleProductCsvUpload(upload('sku,name\nV0,A\nV1,B', 'preview'), previewDeps)).json() as { changedProducts: number }
  assert.equal(dry.changedProducts, 2)
  assert.deepEqual(previewDeps.out, [])
  assert.ok(!log.includes('$executeRaw'))

  const deps = uploadDeps('ADMIN', client)
  const done = await (await handleProductCsvUpload(upload('sku,name\nV0,A\nV1,B', 'apply'), deps)).json() as { written: number }
  assert.equal(done.written, 2)
  assert.deepEqual(deps.out.filter((o) => o !== 'log:csv_edited'), ['log:imported', 'wms', 'after', 'storefront:2', 'revalidate'])
})

test('upload: a role without the sync permission gets no warehouse sync (the editor rule)', async () => {
  const { client } = makeClient(1)
  const deps = uploadDeps('WAREHOUSE', client)
  await handleProductCsvUpload(upload('sku,name\nV0,A', 'apply'), deps)
  assert.ok(!deps.out.includes('wms'))
  assert.ok(deps.out.includes('after'))
})

test('download: price columns need inventory.prices, and the role needs inventory.edit', async () => {
  const { client } = makeClient(1)
  const req = (columns: string[]) => new Request('https://ims.test/d', { method: 'POST', body: JSON.stringify({ mode: 'ids', ids: ['id-0'], columns }) })
  const deps = (role: string) => ({ requireApiAuth: async () => session(role), client: client as never })
  assert.equal((await handleProductCsvDownload(req(['name']), deps('FINANCE'))).status, 403)
  assert.equal((await handleProductCsvDownload(req(['salesPriceBase']), deps('WAREHOUSE'))).status, 403)
  assert.equal((await handleProductCsvDownload(req(['bogus']), deps('ADMIN'))).status, 400)
})

test('REGRESSION (WMS fan-out): a bulk apply schedules NO per-product warehouse syncs and says so', async () => {
  const sync = await import('@/lib/products/csv-roundtrip/sync')
  const many = Array.from({ length: sync.PRODUCT_CSV_WMS_PER_PRODUCT_LIMIT + 1 }, (_, i) => ({ id: `b${i}`, lifecycleStatus: 'ACTIVE' as const, classificationChanged: false }))
  const outcome = await sync.scheduleProductCsvWmsSync(many)
  assert.deepEqual(outcome, { scheduled: 0, deferred: many.length })
  assert.deepEqual(state.calls.filter((c) => c.startsWith('wms:')), [])
  const atLimit = await sync.scheduleProductCsvWmsSync(many.slice(0, sync.PRODUCT_CSV_WMS_PER_PRODUCT_LIMIT))
  assert.equal(atLimit.scheduled, sync.PRODUCT_CSV_WMS_PER_PRODUCT_LIMIT)

  // Through the handler: the operator is told, and the storefront sync still runs once for the whole set.
  const { client } = makeClient(30)
  const deps = uploadDeps('ADMIN', client)
  deps.scheduleWmsSync = sync.scheduleProductCsvWmsSync
  const file = ['sku,name', ...Array.from({ length: 30 }, (_, i) => `V${i},E${i}`)].join('\n')
  const body = await (await handleProductCsvUpload(upload(file, 'apply'), deps)).json() as { warnings: string[] }
  assert.match(body.warnings.join(' '), /30 products were not queued for the warehouse/)
})

test('REGRESSION (storefront fan-out): pushes never exceed the concurrency ceiling, and stock sync is batched', async () => {
  const sync = await import('@/lib/products/csv-roundtrip/sync')
  const many = Array.from({ length: 200 }, (_, i) => ({ id: `s${i}`, lifecycleStatus: 'ACTIVE' as const, classificationChanged: false }))
  await sync.runProductCsvStorefrontSync(many)
  assert.equal(state.calls.filter((c) => c.startsWith('push:')).length, 200)
  assert.equal(state.calls.filter((c) => c.startsWith('stock:')).length, 1, 'one batched stock sync for all live products')
  assert.ok(state.peak <= sync.PRODUCT_CSV_SYNC_CONCURRENCY && state.peak > 1, `peak ${state.peak}`)
})
