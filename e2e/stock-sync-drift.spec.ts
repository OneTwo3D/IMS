/**
 * Regression tests for the WooCommerce stock-sync cache-integrity paths.
 *
 * Covered scenarios:
 *
 *   1. Drift detection
 *      An IMS product has a cached `wcProductId` that no longer belongs
 *      to it in WooCommerce (the WC product was deleted/recreated or
 *      its id was re-used for a different SKU). Without a preflight
 *      check, the stock push would overwrite the wrong product's stock
 *      for one full run before invalidating the cache. This test
 *      asserts that preflight blocks the push and clears the stale
 *      mapping instead.
 *
 *   2. Preflight-abort error surfacing
 *      A WooCommerce outage that hits the preflight batch read step
 *      must cause the dashboard to render the result with the error
 *      status and the "Stock sync failed" prefix, not the neutral
 *      success styling. This is the "manual sync surfaces hard
 *      failures" contract.
 *
 *   3. Credentials rebind wipes the cache
 *      Changing `wc_url` via the Save Settings button must clear
 *      every cached `wcProductId`. Cross-store stock-corruption
 *      protection lives at the credentials save boundary, not inside
 *      the sync path, so this is the regression test for that
 *      transition.
 *
 * A tiny in-process HTTP server plays the WooCommerce REST API so the
 * tests do not need a real WC sandbox. They run inside the dedicated
 * `wc-isolated` Playwright project (see playwright.config.ts) which
 * serializes them against all other WC-setting-mutating specs.
 */

import { test, expect } from '@playwright/test'
import http from 'node:http'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../app/generated/prisma/client'
import { pushStockToWc } from '../lib/connectors/woocommerce/sync/stock-sync'
import {
  WC_SYNC_ADVISORY_LOCK_KEY,
  WC_SETTINGS_VERSION_KEY,
} from '../lib/connectors/woocommerce/sync-lock'

// ---------------------------------------------------------------------------
// Fake WooCommerce REST API server
// ---------------------------------------------------------------------------

type FakeWcProduct = {
  id: number
  sku: string
  stock_quantity: number | null
  manage_stock: boolean
}

type FakeWcState = {
  /** WC id → product object. Change `sku` here to simulate drift. */
  products: Map<number, FakeWcProduct>
  /**
   * When true, the preflight batch read
   * (`GET /products?include=...`) returns 500 to simulate a WC
   * outage hitting the pre-push verification step.
   */
  preflightBroken: boolean
  /**
   * When true, hold `/products/batch` responses open until the test
   * releases them. Used to prove credential rebinds cannot commit in
   * the window between a batch version-check and the outbound POST.
   */
  pauseBatchResponse: boolean
  releaseBatchResponse: (() => void) | null
}

type FakeWcRecorder = {
  preflightQueries: string[] // raw `include` query-string values
  batchPosts: Array<{ update?: Array<{ id: number; stock_quantity?: number }> }>
}

async function startFakeWc(
  state: FakeWcState,
  recorder: FakeWcRecorder,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const urlObj = new URL(req.url ?? '/', 'http://internal')
    const path = urlObj.pathname
    const method = req.method ?? 'GET'

    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    // GET /wp-json/wc/v3/products?include=... (preflight)
    //   or ?sku=...                     (SKU → id resolution)
    if (method === 'GET' && path === '/wp-json/wc/v3/products') {
      const include = urlObj.searchParams.get('include')
      const sku = urlObj.searchParams.get('sku')

      if (include) {
        recorder.preflightQueries.push(include)
        if (state.preflightBroken) {
          return send(500, { code: 'rest_error', message: 'simulated preflight outage' })
        }
        const ids = include.split(',').map((s) => Number(s)).filter((n) => Number.isFinite(n))
        const found = ids.map((id) => state.products.get(id)).filter(Boolean)
        return send(200, found)
      }
      if (sku) {
        const match = [...state.products.values()].find((p) => p.sku === sku)
        return send(200, match ? [match] : [])
      }
      return send(200, [])
    }

    // POST /wp-json/wc/v3/products/batch (the push)
    if (method === 'POST' && path === '/wp-json/wc/v3/products/batch') {
      let raw = ''
      req.on('data', (chunk) => (raw += chunk))
      req.on('end', async () => {
        try {
          const body = JSON.parse(raw) as { update?: Array<{ id: number; stock_quantity?: number }> }
          recorder.batchPosts.push(body)
          if (state.pauseBatchResponse) {
            await new Promise<void>((resolve) => {
              state.releaseBatchResponse = () => {
                state.releaseBatchResponse = null
                resolve()
              }
            })
          }
          // Apply updates to the fake's state so the response mirrors real WC
          // behavior (useful when earlier assertions fail loudly).
          const updated: Array<{ id: number; sku: string; stock_quantity: number | null }> = []
          for (const entry of body.update ?? []) {
            const current = state.products.get(entry.id)
            if (current) {
              current.stock_quantity = entry.stock_quantity ?? current.stock_quantity
              updated.push({ id: current.id, sku: current.sku, stock_quantity: current.stock_quantity })
            } else {
              updated.push({ id: entry.id, sku: '', stock_quantity: null })
            }
          }
          send(200, { create: [], update: updated, delete: [] })
        } catch (e) {
          send(400, { error: String(e) })
        }
      })
      return
    }

    send(404, { error: `no route for ${method} ${path}` })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('fake WC server failed to start')
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Belt-and-braces: the `wc-isolated` Playwright project already serializes
// these specs against the rest of the suite, but this keeps tests in this
// file strictly in-order even if the project config is ever relaxed.
test.describe.configure({ mode: 'serial' })

test.describe('WooCommerce stock-sync cache integrity', () => {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! })
  const db = new PrismaClient({ adapter })

  const FAKE_WC_PRODUCT_ID = 9_999_001
  const PROBE_WC_PRODUCT_ID = 9_999_002
  const REBIND_WC_PRODUCT_ID = 9_999_003
  const BATCH_FENCE_WC_PRODUCT_ID = 9_999_004
  const REBOUND_BATCH_WC_PRODUCT_ID = 9_999_005
  const RUN_TAG = String(Date.now())
  const EXPECTED_SKU = `000-DRIFT-EXPECTED-${RUN_TAG}`
  const DRIFTED_SKU = `000-DRIFT-ACTUAL-${RUN_TAG}` // what the fake WC now has at the drifted id
  const PROBE_SKU = `000-PROBE-${RUN_TAG}`
  const REBIND_SKU = `000-REBIND-${RUN_TAG}`
  const BATCH_FENCE_SKU = `000-BATCH-FENCE-${RUN_TAG}`

  type SavedSetting = { key: string; value: string | null }
  const savedSettings: SavedSetting[] = []
  let savedWarehouseSyncFlag: boolean | null = null
  let driftProductId: string | null = null
  let probeProductId: string | null = null
  let rebindProductId: string | null = null
  let batchFenceProductId: string | null = null
  let fakeWc: { url: string; close: () => Promise<void> } | null = null

  const state: FakeWcState = {
    products: new Map<number, FakeWcProduct>([
      // The id the drift product is cached against. Critically, its SKU
      // does NOT match the IMS product's SKU — that's the drift.
      [
        FAKE_WC_PRODUCT_ID,
        {
          id: FAKE_WC_PRODUCT_ID,
          sku: DRIFTED_SKU,
          stock_quantity: 42,
          manage_stock: true,
        },
      ],
    ]),
    preflightBroken: false,
    pauseBatchResponse: false,
    releaseBatchResponse: null,
  }
  const recorder: FakeWcRecorder = {
    preflightQueries: [],
    batchPosts: [],
  }

  test.beforeAll(async () => {
    fakeWc = await startFakeWc(state, recorder)

    const settingsToSave = [
      'wc_url',
      'wc_consumer_key',
      'wc_consumer_secret',
      'wc_stock_sync_enabled',
      'wc_cogs_sync_enabled',
    ]
    for (const key of settingsToSave) {
      const existing = await db.setting.findUnique({ where: { key } })
      savedSettings.push({ key, value: existing?.value ?? null })
    }

    // Direct DB writes bypass saveWcCredentials by design: the spec is
    // testing the sync-path invariants with a deterministic initial
    // state, not the rebind-wipe flow (which has its own test below).
    await upsertSetting('wc_url', fakeWc.url)
    await upsertSetting('wc_consumer_key', 'test-key')
    await upsertSetting('wc_consumer_secret', 'test-secret')
    await upsertSetting('wc_stock_sync_enabled', 'true')
    await upsertSetting('wc_cogs_sync_enabled', 'false')

    const defaultWarehouse = await db.warehouse.findUnique({ where: { code: 'DEFAULT' } })
    if (!defaultWarehouse) throw new Error('DEFAULT warehouse missing — run db:seed:e2e')
    savedWarehouseSyncFlag = defaultWarehouse.syncToWoocommerce
    await db.warehouse.update({
      where: { code: 'DEFAULT' },
      data: { syncToWoocommerce: true },
    })

    // --- Drift test fixture (test 1) ---
    const driftProduct = await db.product.create({
      data: {
        sku: EXPECTED_SKU,
        name: 'Drift regression product',
        wcProductId: BigInt(FAKE_WC_PRODUCT_ID), // intentionally stale; column is BIGINT
      },
      select: { id: true },
    })
    driftProductId = driftProduct.id

    await db.stockLevel.create({
      data: {
        productId: driftProduct.id,
        warehouseId: defaultWarehouse.id,
        quantity: 10,
        reservedQty: 0,
      },
    })

    // --- Preflight-abort UI test fixture (test 2) ---
    const probeProduct = await db.product.create({
      data: {
        sku: PROBE_SKU,
        name: 'Preflight-abort probe product',
        wcProductId: BigInt(PROBE_WC_PRODUCT_ID),
      },
      select: { id: true },
    })
    probeProductId = probeProduct.id

    await db.stockLevel.create({
      data: {
        productId: probeProduct.id,
        warehouseId: defaultWarehouse.id,
        quantity: 5,
        reservedQty: 0,
      },
    })

    state.products.set(PROBE_WC_PRODUCT_ID, {
      id: PROBE_WC_PRODUCT_ID,
      sku: PROBE_SKU,
      stock_quantity: 0,
      manage_stock: true,
    })

    // --- Credentials rebind test fixture (test 3) ---
    const rebindProduct = await db.product.create({
      data: {
        sku: REBIND_SKU,
        name: 'Credentials rebind product',
        wcProductId: BigInt(REBIND_WC_PRODUCT_ID),
      },
      select: { id: true },
    })
    rebindProductId = rebindProduct.id
    // No matching fake-WC entry needed — this test only exercises the
    // save-credentials path, never touches the sync itself.

    // --- Batch fence regression fixture (test 4) ---
    const batchFenceProduct = await db.product.create({
      data: {
        sku: BATCH_FENCE_SKU,
        name: 'Batch fence regression product',
        wcProductId: BigInt(BATCH_FENCE_WC_PRODUCT_ID),
      },
      select: { id: true },
    })
    batchFenceProductId = batchFenceProduct.id

    await db.stockLevel.create({
      data: {
        productId: batchFenceProduct.id,
        warehouseId: defaultWarehouse.id,
        quantity: 7,
        reservedQty: 0,
      },
    })

    state.products.set(BATCH_FENCE_WC_PRODUCT_ID, {
      id: BATCH_FENCE_WC_PRODUCT_ID,
      sku: BATCH_FENCE_SKU,
      stock_quantity: 0,
      manage_stock: true,
    })
    state.products.set(REBOUND_BATCH_WC_PRODUCT_ID, {
      id: REBOUND_BATCH_WC_PRODUCT_ID,
      sku: BATCH_FENCE_SKU,
      stock_quantity: 0,
      manage_stock: true,
    })
  })

  test.afterAll(async () => {
    try {
      for (const pid of [driftProductId, probeProductId, rebindProductId, batchFenceProductId]) {
        if (!pid) continue
        await db.stockLevel.deleteMany({ where: { productId: pid } })
        await db.product.delete({ where: { id: pid } }).catch(() => {
          // product may have been removed by a failing test; swallow.
        })
      }
      if (savedWarehouseSyncFlag !== null) {
        await db.warehouse.update({
          where: { code: 'DEFAULT' },
          data: { syncToWoocommerce: savedWarehouseSyncFlag },
        })
      }
      for (const { key, value } of savedSettings) {
        if (value === null) {
          await db.setting.deleteMany({ where: { key } })
        } else {
          await upsertSetting(key, value)
        }
      }
    } finally {
      if (fakeWc) await fakeWc.close()
      await db.$disconnect()
    }
  })

  async function upsertSetting(key: string, value: string) {
    await db.setting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    })
  }

  async function clickPushStockNow(page: import('@playwright/test').Page) {
    await page.goto('/sync?connector=woocommerce')
    await expect(page.getByRole('heading', { name: 'WooCommerce Connector' })).toBeVisible()
    await page.getByRole('button', { name: 'Products', exact: true }).click()
    const pushButton = page.getByRole('button', { name: /push stock now/i })
    await expect(pushButton).toBeVisible()
    await pushButton.click()
  }

  test('preflight blocks stock push when cached wcProductId drifts and clears the mapping', async ({ page }) => {
    // Sanity: the fake WC has a DIFFERENT sku at the cached id.
    expect(state.products.get(FAKE_WC_PRODUCT_ID)?.sku).toBe(DRIFTED_SKU)
    expect(DRIFTED_SKU).not.toBe(EXPECTED_SKU)

    await clickPushStockNow(page)

    // Wait for the sync pipeline to complete a batch cycle. The
    // probe product is legitimate and will be pushed, so we can't
    // wait for "0 synced" — wait for the recorder instead.
    await expect
      .poll(() => recorder.batchPosts.length >= 1 || recorder.preflightQueries.length >= 1, {
        timeout: 30_000,
      })
      .toBe(true)

    // --- Assertion 1: fake WC received a preflight GET for the drifted id ---
    expect(recorder.preflightQueries.some((q) => q.split(',').includes(String(FAKE_WC_PRODUCT_ID)))).toBe(true)

    // --- Assertion 2: fake WC never received a batch push containing that id ---
    // This is the corruption-prevention invariant. With the preflight fix,
    // the stock update for a drifted id must never be posted.
    const pushedIds = recorder.batchPosts.flatMap((p) => (p.update ?? []).map((u) => u.id))
    expect(pushedIds).not.toContain(FAKE_WC_PRODUCT_ID)

    // --- Assertion 3: DB cleared the stale wcProductId so next run re-resolves ---
    const driftAfter = await db.product.findUnique({
      where: { id: driftProductId! },
      select: { wcProductId: true },
    })
    expect(driftAfter?.wcProductId).toBeNull()
  })

  test('preflight abort surfaces as a UI error, not a neutral success', async ({ page }) => {
    // Simulate a WooCommerce outage that hits the preflight batch-read
    // step. stock-sync's bail-out path populates `result.errors` and
    // returns with `pushed=false`, and the UI must render that as a
    // red error instead of the neutral "completed" treatment.
    state.preflightBroken = true

    try {
      await clickPushStockNow(page)

      // The dashboard sets a `data-sync-status` attribute on the
      // result span. Wait for it to land with value "error".
      const resultSpan = page.getByTestId('sync-result')
      await expect(resultSpan).toBeVisible({ timeout: 30_000 })
      await expect(resultSpan).toHaveAttribute('data-sync-status', 'error', {
        timeout: 30_000,
      })

      // The failure prefix from formatSyncResult must appear literally —
      // this is what operators see at a glance.
      await expect(resultSpan).toContainText('Stock sync failed')

      // probeProduct's cached mapping must survive the preflight outage.
      // The drift-protection path only clears mappings on positive proof
      // of drift, not on transport failures.
      const probeAfter = await db.product.findUnique({
        where: { id: probeProductId! },
        select: { wcProductId: true },
      })
      expect(probeAfter?.wcProductId).toBe(BigInt(PROBE_WC_PRODUCT_ID))
    } finally {
      state.preflightBroken = false
    }
  })

  test('changing WC credentials via Save Settings wipes cached wcProductId mappings', async ({ page }) => {
    // Before: rebindProduct has a valid-looking cached mapping.
    const before = await db.product.findUnique({
      where: { id: rebindProductId! },
      select: { wcProductId: true },
    })
    expect(before?.wcProductId).toBe(BigInt(REBIND_WC_PRODUCT_ID))

    // Navigate to Connection tab and bump `wc_url` by appending a
    // path segment. The server action `saveWcCredentials` compares
    // incoming values against what's currently in the DB and nulls
    // every `wcProductId` in the same transaction when it sees a
    // real change.
    await page.goto('/sync?connector=woocommerce')
    await expect(page.getByRole('heading', { name: 'WooCommerce Connector' })).toBeVisible()
    await page.getByRole('button', { name: 'Connection', exact: true }).click()

    const urlInput = page.getByTestId('wc-url-input')
    await expect(urlInput).toBeVisible()
    const originalUrl = (await urlInput.inputValue()).replace(/\/$/, '')
    const newUrl = `${originalUrl}/rebind-probe`
    await urlInput.fill(newUrl)

    await page.getByRole('button', { name: /save settings/i }).click()
    await expect(page.getByText(/saved/i)).toBeVisible({ timeout: 30_000 })

    // After: rebindProduct's cached id must be null.
    const after = await db.product.findUnique({
      where: { id: rebindProductId! },
      select: { wcProductId: true },
    })
    expect(after?.wcProductId).toBeNull()

    // probeProduct (still cached because test 2's preflight failure
    // is NOT a rebind) must ALSO have been wiped now — saveWcCredentials
    // issues a global updateMany, not a per-product filter.
    const probe = await db.product.findUnique({
      where: { id: probeProductId! },
      select: { wcProductId: true },
    })
    expect(probe?.wcProductId).toBeNull()

    // Restore the original URL so subsequent runs and other WC
    // specs see a working connector pointing at the fake server.
    await upsertSetting('wc_url', fakeWc!.url)
  })

  test('credential rebind cannot commit while a stock batch is between its version check and POST completion', async () => {
    state.pauseBatchResponse = true
    state.releaseBatchResponse = null
    recorder.batchPosts.length = 0

    await db.product.update({
      where: { id: batchFenceProductId! },
      data: { wcProductId: BigInt(BATCH_FENCE_WC_PRODUCT_ID) },
    })

    const syncPromise = pushStockToWc()

    await expect
      .poll(
        () => recorder.batchPosts.some((post) => (post.update ?? []).some((u) => u.id === BATCH_FENCE_WC_PRODUCT_ID)),
        { timeout: 30_000 },
      )
      .toBe(true)

    let rebindCommitted = false
    const rebindPromise = db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${WC_SYNC_ADVISORY_LOCK_KEY})`
      const currentVersion = await tx.setting.findUnique({
        where: { key: WC_SETTINGS_VERSION_KEY },
      })
      const nextVersion = String((Number.parseInt(currentVersion?.value ?? '0', 10) || 0) + 1)
      await tx.setting.upsert({
        where: { key: WC_SETTINGS_VERSION_KEY },
        create: { key: WC_SETTINGS_VERSION_KEY, value: nextVersion },
        update: { value: nextVersion },
      })
      await tx.product.update({
        where: { id: batchFenceProductId! },
        data: { wcProductId: BigInt(REBOUND_BATCH_WC_PRODUCT_ID) },
      })
    }).then(() => {
      rebindCommitted = true
    })

    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(rebindCommitted).toBe(false)

    const releaseBatchResponse = state.releaseBatchResponse as (() => void) | null
    if (!releaseBatchResponse) throw new Error('Expected releaseBatchResponse to be set before continuing')
    releaseBatchResponse()

    await syncPromise
    await rebindPromise

    const productAfter = await db.product.findUnique({
      where: { id: batchFenceProductId! },
      select: { wcProductId: true },
    })
    expect(productAfter?.wcProductId).toBe(BigInt(REBOUND_BATCH_WC_PRODUCT_ID))

    state.pauseBatchResponse = false
    state.releaseBatchResponse = null
  })
})
