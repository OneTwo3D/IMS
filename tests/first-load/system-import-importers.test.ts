import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, it, mock } from 'node:test'

import { freePort, startCluster, type Cluster } from '../scripts/real-postgres-cluster'
import { databaseUrl, ident, inheritedEnv, randomHex, runChild, socketPsql, tail, withClient } from '../../scripts/rehearse-first-install'

/**
 * THE FIRST-LOAD IMPORTERS RUN OUTSIDE NEXT, AS A SYSTEM ACTOR (spike + seam).
 *
 * The first-load apply runner will call the application's own CSV importers from a CLI. This file answers, on a real
 * throwaway cluster with the migrations applied, whether that works and what the seam does:
 *
 *   1. SPIKE. A tsx child process, with NO module mocks and no Next request, imports the real Server Action modules and calls
 *      importSuppliersCsv, importProductsCsv, importOpeningStockCsv, importPurchaseOrdersCsv, importTransfersCsv and
 *      createPurchaseOrder with a minted context. The parent judges what happened from the DATABASE, not from the child's report.
 *   2. SUPPRESSION. WooCommerce is configured and enabled before the child runs. The control arm shows that this configuration
 *      is live enough for the effects to produce rows (so "no rows" can mean something); the system run produces none.
 *   3. THE WEB PATH IS UNCHANGED. In this process, with the session check and next/cache replaced by recorders, the same
 *      importers still demand their permission, still revalidate, still queue the stock sync, and refuse when denied.
 *   4. LOOK-ALIKES. Contexts a client could send (a boolean, a string, another symbol, no token) are refused.
 *
 * Each arm names, in a comment, the one change to the subject that makes it red; the change was made, the arm went red, and
 * the change was reverted (see the pull request body for the table).
 */

const REPO = process.cwd()
const TAG = `SPK${randomHex(3).toUpperCase()}`
const CHILD_TIMEOUT_MS = 6 * 60 * 1000
const SETTINGS_KEY = 'prod_readiness_ci_settings_key__'

/** Tables whose growth would mean something was SENT or QUEUED to the outside world. */
const OUTBOUND_TABLES = ['integration_outbox', 'wms_sync_jobs', 'email_outbox', 'accounting_sync_logs'] as const
/** Tables a system-actor run of the four importers and createPurchaseOrder is expected to write (the census the runner will reuse). */
const EXPECTED_WRITES = new Set([
  'activity_logs', 'suppliers', 'product_categories', 'products', 'product_components', 'boms', 'bom_items',
  'stock_levels', 'stock_movements', 'cost_layers', 'purchase_orders', 'purchase_order_lines', 'supplier_products',
])

let root = ''
let cluster: Cluster
let url = ''
let childEnv: Record<string, string> = {}
type Db = typeof import('@/lib/db')['db']
let db: Db

const authCalls: string[] = []
const revalidated: string[] = []
let denyAll = false

// The web-path arms need the session check and the Next cache API replaced by recorders. They are installed here, before
// anything imports the Server Action modules; the spike child process is a separate process and sees neither.
async function installRecorders(): Promise<void> {
  const realAuth = await import('@/lib/auth/server')
  mock.module('@/lib/auth/server', {
    namedExports: {
      ...realAuth,
      requirePermission: async (permission: string) => {
        authCalls.push(permission)
        if (denyAll) throw new Error(`Forbidden: missing permission ${permission}`)
        return { user: { id: null, role: 'ADMIN' } }
      },
    },
  })
  const realCache = await import('next/cache')
  mock.module('next/cache', { namedExports: { ...realCache, revalidatePath: (path: string) => { revalidated.push(path) } } })
}

async function tableCounts(): Promise<Map<string, number>> {
  return withClient(url, async (client) => {
    const names = (await client.query<{ table_name: string }>(`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`)).rows.map((r) => r.table_name)
    const counts = new Map<string, number>()
    for (const name of names) counts.set(name, Number((await client.query<{ n: string }>(`select count(*)::text as n from ${ident(name)}`)).rows[0]!.n))
    return counts
  })
}

function changedTables(before: Map<string, number>, afterCounts: Map<string, number>): string[] {
  return [...afterCounts.keys()].filter((name) => afterCounts.get(name) !== (before.get(name) ?? 0)).sort()
}

const csvFile = (rows: string[][], mode = 'execute'): FormData => {
  const data = new FormData()
  data.set('file', new File([rows.map((r) => r.join(',')).join('\n') + '\n'], 'web.csv', { type: 'text/csv' }))
  data.set('mode', mode)
  return data
}

async function waitFor(what: string, predicate: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

async function outboxCount(): Promise<number> {
  return db.integrationOutbox.count()
}

type Step = { threw: boolean; message?: string; value?: any } // eslint-disable-line @typescript-eslint/no-explicit-any
let driver: Record<string, Step> = {}
let outboxBeforeDriver = 0
let outboxAfterDriver = 0
let countsBefore = new Map<string, number>()
let countsAfter = new Map<string, number>()
let controlRows = 0

describe('the first-load importers as a system actor', { timeout: 20 * 60 * 1000 }, () => {
  before(async () => {
    root = mkdtempSync('/var/tmp/ims-system-import-')
    for (const dir of ['home', 'npm-cache', 'tmp']) mkdirSync(join(root, dir))
    writeFileSync(join(root, 'empty.env'), '')
    const port = await freePort()
    cluster = startCluster(root, 'pg', port, '127.0.0.1')
    const role = `spike_${randomHex(4)}`
    const password = randomHex(16)
    socketPsql(cluster, `create role ${ident(role)} superuser login password '${password}';\ncreate database ims_spike owner ${ident(role)};\n`)
    url = databaseUrl(role, password, port, 'ims_spike')
    const verified = await withClient(url, async (client) => (await client.query<{ db: string; port: number }>('select current_database() as db, inet_server_port() as port')).rows[0]!)
    assert.deepEqual(verified, { db: 'ims_spike', port }, 'precondition: connected to the throwaway database')
    console.log(`precondition: current_database()=${verified.db}, port=${verified.port}`)

    childEnv = {
      ...inheritedEnv(root),
      DATABASE_URL: url,
      TMPDIR: join(root, 'tmp'),
      AUTH_SECRET: randomHex(16),
      CRON_SECRET: randomHex(16),
      SETTINGS_ENCRYPTION_KEY: SETTINGS_KEY,
      NEXT_PUBLIC_APP_URL: 'https://ims-spike.test',
      AUTH_URL: 'https://ims-spike.test',
      PUBLIC_APP_URL: 'https://ims-spike.test',
      IMS_SKIP_ENV_FILE: '1',
      DOTENV_CONFIG_PATH: join(root, 'empty.env'),
      DOTENV_CONFIG_QUIET: 'true',
      PRISMA_HIDE_UPDATE_MESSAGE: '1',
      CHECKPOINT_DISABLE: '1',
      FILE_SCAN_MODE: 'disabled',
      E2E_TEST_MODE: '1',
    }
    for (const [name, args] of [['migrate', ['migrate', 'deploy']]] as const) {
      const run = await runChild({ cmd: join(REPO, 'node_modules/.bin/prisma'), args: [...args], env: childEnv, cwd: REPO, timeoutMs: CHILD_TIMEOUT_MS })
      assert.equal(run.exitCode, 0, `${name} failed: ${tail(run.stdout + run.stderr, 1500)}`)
    }
    const seed = await runChild({ cmd: join(REPO, 'node_modules/.bin/tsx'), args: ['prisma/seed.ts'], env: childEnv, cwd: REPO, timeoutMs: CHILD_TIMEOUT_MS })
    assert.equal(seed.exitCode, 0, `seed failed: ${tail(seed.stdout + seed.stderr, 1500)}`)

    // This process talks to the same throwaway database through the application's own client.
    Object.assign(process.env, { DATABASE_URL: url, SETTINGS_ENCRYPTION_KEY: SETTINGS_KEY, AUTH_SECRET: childEnv.AUTH_SECRET, E2E_TEST_MODE: '1', IMS_SKIP_ENV_FILE: '1' })
    await installRecorders()
    db = (await import('@/lib/db')).db
    assert.equal((await db.$queryRaw<Array<{ d: string }>>`select current_database() as d`)[0]!.d, 'ims_spike', 'precondition: the application client points at the scratch database')

    // WooCommerce configured and enabled, pointing at a loopback port nothing listens on: every effect that is not suppressed
    // leaves a row behind (the outbox) and then fails to deliver.
    const { serializeSettingValue } = await import('@/lib/settings-store')
    const { INTEGRATION_PLUGIN_SETTING_KEYS } = await import('@/lib/integration-plugin-keys')
    for (const [key, value] of [
      [INTEGRATION_PLUGIN_SETTING_KEYS.woocommerce, 'true'],
      ['wc_url', 'http://127.0.0.1:9'],
      ['wc_consumer_key', 'ck_spike'],
      ['wc_consumer_secret', 'cs_spike'],
    ] as const) {
      const stored = serializeSettingValue(key, value)
      await db.setting.upsert({ where: { key }, create: { key, value: stored }, update: { value: stored } })
    }

    // CONTROL: the configuration is live enough for the effect to produce rows. Without this, "the system run queued
    // nothing" could simply mean WooCommerce was never going to queue anything here.
    const probe = await db.product.create({ data: { sku: `${TAG}-PROBE`, name: 'probe' }, select: { id: true } })
    const { enqueueStockSync } = await import('@/lib/shopping')
    const beforeControl = await outboxCount()
    try { await enqueueStockSync([probe.id], 'IMS_CHANGE') } catch { /* delivery may fail; the queued row is what is measured */ }
    controlRows = (await outboxCount()) - beforeControl
    console.log(`precondition (control): enqueueStockSync with WooCommerce configured queued ${controlRows} outbox row(s)`)
    assert.ok(controlRows > 0, 'precondition: the effect produces outbox rows in this configuration')

    // THE SPIKE: one tsx child, no mocks, no Next request.
    outboxBeforeDriver = await outboxCount()
    countsBefore = await tableCounts()
    const run = await runChild({
      cmd: join(REPO, 'node_modules/.bin/tsx'),
      args: ['tests/first-load/system-import-driver.ts'],
      env: { ...childEnv, SPIKE_TAG: TAG },
      cwd: REPO,
      timeoutMs: CHILD_TIMEOUT_MS,
    })
    const line = run.stdout.split('\n').find((candidate) => candidate.startsWith('SPIKE_DRIVER '))
    assert.ok(line, `the driver reported (exit ${run.exitCode}): ${tail(run.stdout + run.stderr, 3000)}`)
    driver = JSON.parse(line.slice('SPIKE_DRIVER '.length)) as Record<string, Step>
    outboxAfterDriver = await outboxCount()
    countsAfter = await tableCounts()
    console.log(`spike driver steps: ${Object.keys(driver).length}`)
  })

  after(async () => {
    try { await db?.$disconnect() } catch { /* the pool may already be closed */ }
    try { cluster?.stop() } finally { if (root) rmSync(root, { recursive: true, force: true }) }
  })

  // ------------------------------------------------------------------------------------------------------------------
  // 1. THE SPIKE
  // ------------------------------------------------------------------------------------------------------------------

  it('the three Server Action modules load under tsx outside Next, and revalidatePath is what throws there', () => {
    for (const name of ['import', 'suppliers', 'purchase-orders']) {
      assert.equal(driver[`load:${name}`]?.threw, false, `${name} loads: ${driver[`load:${name}`]?.message}`)
    }
    const exportsOf = (name: string): string[] => driver[`load:${name}`]!.value
    for (const fn of ['importProductsCsv', 'importOpeningStockCsv', 'importPurchaseOrdersCsv', 'importTransfersCsv']) assert.ok(exportsOf('import').includes(fn), fn)
    assert.ok(exportsOf('suppliers').includes('importSuppliersCsv'))
    assert.ok(exportsOf('purchase-orders').includes('createPurchaseOrder'))
    // The Next-only API: this is WHY the seam must skip it rather than the runner calling it.
    assert.equal(driver['revalidatePath-unmocked']!.threw, true, 'revalidatePath throws outside a request')
    assert.match(driver['revalidatePath-unmocked']!.message!, /static generation store missing/)
    console.log(`revalidatePath outside a request: ${driver['revalidatePath-unmocked']!.message}`)
  })

  it('every importer, called with a minted context and no mocks, writes its rows', async () => {
    // Mutation named: make the permission skip fire only for a different symbol -> the real requirePermission throws
    // (no session outside a request) and every step below reports threw:true.
    for (const step of ['suppliers', 'products', 'opening-stock', 'purchase-orders', 'create-purchase-order']) {
      assert.equal(driver[`system:${step}`]?.threw, false, `${step}: ${driver[`system:${step}`]?.message}`)
    }
    const sup = driver['system:suppliers']!.value
    const prod = driver['system:products']!.value
    const stock = driver['system:opening-stock']!.value
    const po = driver['system:purchase-orders']!.value
    console.log(`importer counters: suppliers ${JSON.stringify({ c: sup.created, u: sup.updated, s: sup.skipped })}, products ${JSON.stringify({ c: prod.created, u: prod.updated, s: prod.skipped, e: prod.errors })}, opening-stock ${JSON.stringify({ c: stock.created, s: stock.skipped })}, purchase-orders ${JSON.stringify({ c: po.created, s: po.skipped, e: po.errors })}`)

    const suppliers = await db.supplier.findMany({ where: { name: { startsWith: TAG } }, select: { id: true, name: true } })
    assert.equal(suppliers.length, 2, 'two suppliers were created')
    const products = await db.product.findMany({ where: { sku: { startsWith: TAG, not: `${TAG}-PROBE` } }, select: { id: true, sku: true, type: true, parentId: true } })
    assert.equal(products.length, 6, 'six products were created (variable parent, variant, two simples, a kit, a bom)')
    const bySku = new Map(products.map((p) => [p.sku, p]))
    assert.equal(bySku.get(`${TAG}-VAR-1`)!.parentId, bySku.get(`${TAG}-VAR`)!.id, 'the variant points at its parent')
    for (const sku of [`${TAG}-KIT`, `${TAG}-BOM`]) {
      assert.equal(await db.productComponent.count({ where: { productId: bySku.get(sku)!.id } }), 2, `${sku} has its two components`)
    }
    const layers = await db.costLayer.findMany({ where: { isOpeningStock: true, product: { sku: { startsWith: TAG } } }, select: { receivedQty: true, unitCostBase: true, product: { select: { sku: true } } } })
    assert.deepEqual(layers.map((l) => `${l.product.sku}=${l.receivedQty}@${l.unitCostBase}`).sort(), [`${TAG}-A=10@2.5`, `${TAG}-B=4@1.25`])
    const orders = await db.purchaseOrder.findMany({ where: { reference: { startsWith: TAG } }, select: { reference: true, status: true, lines: { select: { qty: true } } } })
    assert.deepEqual(orders.map((o) => `${o.reference}:${o.status}:${o.lines.length}`).sort(), [`${TAG}-PO-1:DRAFT:2`, `${TAG}-PO-2:DRAFT:1`])

    // The ids returned are the ids written.
    assert.deepEqual([...sup.system.touchedIds.created].sort(), suppliers.map((s) => s.id).sort())
    assert.deepEqual([...prod.system.touchedIds.created].sort(), products.map((p) => p.id).sort())
    assert.deepEqual([...stock.system.touchedIds.created].sort(), [bySku.get(`${TAG}-A`)!.id, bySku.get(`${TAG}-B`)!.id].sort())
    const poIds = (await db.purchaseOrder.findMany({ where: { reference: `${TAG}-PO-1` }, select: { id: true } })).map((p) => p.id)
    assert.deepEqual(po.system.touchedIds.created, poIds)
  })

  it('a system-actor import queues nothing outbound although WooCommerce is configured, and says what it did not queue', async () => {
    // Mutation named: call scheduleProductImportShoppingSync / enqueueStockSync unconditionally -> outbox rows appear.
    console.log(`outbox rows before the system run: ${outboxBeforeDriver}, after: ${outboxAfterDriver} (control queued ${controlRows})`)
    assert.equal(outboxAfterDriver, outboxBeforeDriver, 'integration_outbox did not grow')
    const grew = changedTables(countsBefore, countsAfter).filter((name) => (OUTBOUND_TABLES as readonly string[]).includes(name))
    assert.deepEqual(grew, [], 'no outbound table grew')
    const prod = driver['system:products']!.value
    const stock = driver['system:opening-stock']!.value
    assert.equal(prod.system.deferredEffects.shoppingMetadataPush.length, 6)
    assert.equal(prod.system.deferredEffects.stockSync.length, 6)
    assert.equal(stock.system.deferredEffects.stockSync.length, 2)
    assert.deepEqual(driver['system:suppliers']!.value.system.deferredEffects, { shoppingMetadataPush: [], stockSync: [] })
  })

  it('the tables a system-actor run wrote are exactly the expected set (the census the runner reuses)', () => {
    const changed = changedTables(countsBefore, countsAfter)
    console.log(`tables written by the system run (${changed.length}): ${changed.join(', ')}`)
    // Precondition: the census saw the writes at all.
    assert.ok(changed.includes('products') && changed.includes('cost_layers'), 'precondition: the census sees the product and cost-layer writes')
    const unexpected = changed.filter((name) => !EXPECTED_WRITES.has(name))
    assert.deepEqual(unexpected, [], 'no table outside the expected set changed')
  })

  it('the activity log names the system actor on every import, and no session user', async () => {
    // Mutation named: drop withSystemActor from one logActivity call -> that import has no actor row.
    const rows = await db.activityLog.findMany({ where: { metadata: { path: ['actor', 'runId'], equals: `run-${TAG}` } }, select: { entityType: true, userId: true, metadata: true, description: true } })
    console.log(`activity rows naming the run: ${rows.length}`)
    const kinds = rows.map((r) => r.entityType).sort()
    assert.deepEqual(kinds, ['IMPORT', 'IMPORT', 'IMPORT', 'IMPORT', 'PURCHASE_ORDER', 'PURCHASE_ORDER'], 'suppliers, products, opening stock and the PO import log once each; each of the two POs logs once')
    for (const row of rows) {
      assert.equal(row.userId, null)
      assert.deepEqual((row.metadata as { actor: unknown }).actor, { kind: 'system', runId: `run-${TAG}`, operator: 'Spike Operator' })
    }
  })

  it('transfers: accepted in preview, refused before any write otherwise', async () => {
    const executed = driver['system:transfers-execute']!
    assert.equal(executed.threw, false)
    assert.equal(executed.value.success, false)
    assert.match(executed.value.error, /cannot be imported by the system actor\. Nothing was written\./)
    assert.equal(await db.stockTransfer.count(), 0, 'no transfer exists in the scratch database')
    assert.equal(driver['system:transfers-preview']!.value.preview, true)
  })

  it('a context a client could send is not the capability', async () => {
    // Mutation named: gate the skip on `system` being truthy (or comparing a boolean) instead of the symbol -> these succeed.
    const names = Object.keys(driver).filter((key) => key.startsWith('forged:'))
    assert.equal(names.length, 18, 'six look-alikes against three actions')
    for (const key of names) {
      const step = driver[key]!
      const refused = step.threw || step.value?.success === false
      assert.ok(refused, `${key} was refused (${JSON.stringify(step).slice(0, 200)})`)
    }
    assert.equal(driver['no-context:suppliers']!.threw, true)
    assert.equal(await db.supplier.count({ where: { name: `${TAG} Forged` } }), 0, 'the forged suppliers import wrote nothing')
    assert.equal(await db.product.count({ where: { sku: `${TAG}-FORGED` } }), 0, 'the forged products import wrote nothing')
  })

  it('the capability cannot be minted inside the web application or from malformed input', () => {
    assert.match(driver['mint-inside-next-runtime']!.message!, /cannot be minted inside the web application/)
    assert.match(driver['mint-bad-run-id']!.message!, /run id/)
    assert.match(driver['mint-bad-operator']!.message!, /operator label/)
  })

  // ------------------------------------------------------------------------------------------------------------------
  // 2. THE WEB PATH IS UNCHANGED (this process, session check and Next cache replaced by recorders)
  // ------------------------------------------------------------------------------------------------------------------

  it('web path: every importer still asks for its permission, and refuses when it is denied', async () => {
    // Mutation named: delete the requirePermission call from validateImportFile / importSuppliersCsv / createPurchaseOrder
    // -> the denied call succeeds and writes.
    const imports = await import('@/app/actions/import')
    const suppliers = await import('@/app/actions/suppliers')
    const purchaseOrders = await import('@/app/actions/purchase-orders')
    denyAll = true
    authCalls.length = 0
    const before = await tableCounts()
    const refusals: Array<[string, () => Promise<unknown>]> = [
      ['purchasing.create', () => suppliers.importSuppliersCsv(csvFile([['name'], [`${TAG} Denied`]]))],
      ['inventory.edit', () => imports.importProductsCsv(csvFile([['sku', 'name', 'type'], [`${TAG}-DENIED`, 'denied', 'SIMPLE']]))],
      ['stock_control.adjust', () => imports.importOpeningStockCsv(csvFile([['sku', 'warehouseCode', 'qty', 'unitCostBase'], [`${TAG}-A`, 'DEFAULT', '1', '1']]))],
      ['purchasing.create', () => imports.importPurchaseOrdersCsv(csvFile([['orderKey', 'supplierName', 'sku', 'qty', 'unitCostForeign'], [`${TAG}-DENIED`, `${TAG} Supplier`, `${TAG}-A`, '1', '1']]))],
      ['stock_control.transfer', () => imports.importTransfersCsv(csvFile([['transferKey'], [`${TAG}-DENIED`]]))],
    ]
    for (const [permission, call] of refusals) {
      authCalls.length = 0
      await assert.rejects(call, /Forbidden: missing permission/)
      assert.deepEqual(authCalls, [permission], `asked for ${permission}`)
    }
    authCalls.length = 0
    const created = await purchaseOrders.createPurchaseOrder({ reference: `${TAG}-DENIED`, supplierId: 'x', currency: 'GBP', pricesIncludeVat: false, lines: [{ productId: 'x', sku: 'x', productName: 'x', qty: 1, unitCostForeign: 1 }] })
    assert.equal(created.success, false)
    assert.match(created.error!, /Forbidden: missing permission purchasing\.create/)
    assert.deepEqual(authCalls, ['purchasing.create'])
    denyAll = false
    // The only thing a refusal may leave behind is the error row createPurchaseOrder logs for itself; no business table changes.
    const changed = changedTables(before, await tableCounts())
    assert.deepEqual(changed.filter((name) => name !== 'activity_logs'), [], 'a denied web call wrote nothing but its own error log')
    console.log(`web path denial: ${refusals.length + 1} calls refused with their permission; tables changed: ${changed.join(', ') || 'none'}`)
  })

  it('web path: an allowed import still revalidates, queues the stock sync and has the unchanged response shape', async () => {
    // Mutation named: skip the enqueue unconditionally -> the poll below times out; skip it only for system -> still green (that
    // is the point: the web path is the one that queues).
    const imports = await import('@/app/actions/import')
    const suppliers = await import('@/app/actions/suppliers')
    authCalls.length = 0
    revalidated.length = 0
    const before = await outboxCount()

    const supplierResult = await suppliers.importSuppliersCsv(csvFile([['name'], [`${TAG} Web Supplier`]]))
    assert.equal(supplierResult.preview, false)
    assert.equal((supplierResult as { created: number }).created, 1)
    assert.equal('system' in supplierResult, false, 'no system outcome on the web path')

    const productResult = await imports.importProductsCsv(csvFile([['sku', 'name', 'type'], [`${TAG}-W1`, 'web one', 'SIMPLE']]))
    assert.equal((productResult as { created: number }).created, 1)
    assert.equal('system' in productResult, false)
    // The push and the sync are scheduled with setTimeout(0): wait for the rows they leave.
    const started = Date.now()
    await waitFor('the web products import to queue its stock sync', async () => (await outboxCount()) > before)
    console.log(`web path: the products import's queued row appeared ${Date.now() - started} ms after the call returned (the system run waited ${process.env.SPIKE_SETTLE_MS ?? '4000'} ms)`)

    // A product that no import has pushed, so the stock import's own enqueue is the only thing that can add a row.
    await db.product.create({ data: { sku: `${TAG}-W2`, name: 'web two' } })
    const stockBefore = await outboxCount()
    const stockResult = await imports.importOpeningStockCsv(csvFile([['sku', 'warehouseCode', 'qty', 'unitCostBase'], [`${TAG}-W2`, 'DEFAULT', '3', '1']]))
    assert.equal((stockResult as { created: number }).created, 1)
    assert.equal('system' in stockResult, false)
    await waitFor('the web opening-stock import to queue its stock sync', async () => (await outboxCount()) > stockBefore)

    assert.deepEqual([...new Set(authCalls)].sort(), ['inventory.edit', 'purchasing.create', 'stock_control.adjust'])
    assert.ok(revalidated.includes('/purchase-orders/suppliers') && revalidated.includes('/inventory') && revalidated.includes('/stock-control'), `revalidated: ${[...new Set(revalidated)].join(', ')}`)
    const row = await db.activityLog.findFirst({ where: { entityType: 'IMPORT', description: { contains: 'products' }, createdAt: { gt: new Date(Date.now() - 120_000) } }, orderBy: { createdAt: 'desc' }, select: { userId: true, metadata: true } })
    assert.ok(row, 'precondition: the web import logged')
    assert.equal(row.metadata, null, 'no actor metadata on the web path')
    console.log(`web path: permissions asked ${[...new Set(authCalls)].join(',')}; revalidated ${[...new Set(revalidated)].join(',')}; outbox rows queued ${(await outboxCount()) - before}`)
  })
})
