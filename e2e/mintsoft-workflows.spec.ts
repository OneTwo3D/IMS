import { createHmac } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { createSimpleProduct, uniqueSuffix } from './helpers'
import { E2E_ADMIN_EMAIL } from './test-data'

const APP_BASE_URL = (process.env.E2E_BASE_URL ?? 'http://localhost:3001').replace(/\/$/, '')
const E2E_ROUTE_SECRET = process.env.E2E_ROUTE_SECRET ?? 'e2e-route-secret'

function withE2eHeaders(options?: { headers?: Record<string, string> }) {
  return {
    headers: {
      'x-e2e-secret': E2E_ROUTE_SECRET,
      ...options?.headers,
    },
  }
}

async function seedMintsoftE2e(
  page: import('@playwright/test').Page,
  payload: Record<string, unknown>,
) {
  const response = await page.request.post('/api/e2e/mintsoft', {
    ...withE2eHeaders(),
    data: payload,
  })
  expect(response.ok()).toBeTruthy()
  return response
}

function mintsoftE2eGet(
  page: import('@playwright/test').Page,
  url: string,
  options?: { headers?: Record<string, string> },
) {
  return page.request.get(url, withE2eHeaders(options))
}

function fieldByLabel(
  container: import('@playwright/test').Locator,
  label: string,
) {
  return container.locator('label', { hasText: label }).locator('..').locator('input, select, textarea')
}

test.describe.configure({ mode: 'serial' })

test.describe('Mintsoft integration workflows', () => {
  test.beforeEach(async ({ page }) => {
    await seedMintsoftE2e(page, {
      reset: true,
      pluginEnabled: false,
      apiKey: null,
      username: null,
      password: null,
      webhookSecret: null,
      fakeState: null,
      clearNotificationsForUserEmail: E2E_ADMIN_EMAIL,
    })
  })

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage({ storageState: 'e2e/.auth/admin.json' })
    try {
      await seedMintsoftE2e(page, {
        reset: true,
        pluginEnabled: false,
        apiKey: null,
        username: null,
        password: null,
        webhookSecret: null,
        fakeState: null,
        clearNotificationsForUserEmail: E2E_ADMIN_EMAIL,
      })
    } finally {
      await page.close()
    }
  })

  test('configures Mintsoft, creates a binding, runs sync, exports CSV, and shows a threshold notification', async ({ page }) => {
    test.setTimeout(90_000)
    const suffix = uniqueSuffix()
    const matchedSku = `MS-E2E-MATCHED-${suffix}`
    const missingSku = `MS-E2E-MISSING-${suffix}`
    const warehouseCode = `MSE2E${suffix}`
    const warehouseName = `Mintsoft E2E ${suffix}`

    await seedMintsoftE2e(page, {
      pluginEnabled: true,
      fakeState: {
        apiKey: 'e2e-static-ms-apikey',
        username: 'mintsoft.e2e.user',
        password: 'mintsoft.e2e.password',
        warehouses: [
          { id: 301, name: 'E2E Mintsoft Main' },
        ],
        stockLevelsByWarehouse: {
          '301': [
            {
              productId: 101,
              warehouseId: 301,
              clientId: 22,
              sku: matchedSku,
              level: 5,
            },
          ],
        },
      },
      warehouses: [
        {
          code: warehouseCode,
          name: warehouseName,
        },
      ],
      products: [
        {
          sku: matchedSku,
          name: `Mintsoft matched ${suffix}`,
          warehouseCode,
          quantity: 5,
        },
        {
          sku: missingSku,
          name: `Mintsoft missing ${suffix}`,
          warehouseCode,
          quantity: 7,
        },
      ],
    })

    try {
      await page.goto('/sync?connector=mintsoft')
      await expect(page.getByRole('heading', { name: 'Mintsoft Connector' })).toBeVisible()

      await page.getByRole('button', { name: 'Edit Connection' }).click()
      const connectionDialog = page.getByRole('dialog', { name: 'Edit Mintsoft Connection' })
      await fieldByLabel(connectionDialog, 'Base URL').fill(`${APP_BASE_URL}/api/e2e/mintsoft`)
      await fieldByLabel(connectionDialog, 'Username').fill('mintsoft.e2e.user')
      await fieldByLabel(connectionDialog, 'Password').fill('mintsoft.e2e.password')
      await fieldByLabel(connectionDialog, 'Webhook Secret').fill('e2e-mintsoft-webhook-secret')
      await connectionDialog.getByRole('button', { name: 'Save Connection' }).click()

      await expect(page.getByText('Mintsoft connection saved')).toBeVisible()
      await page.reload()

      await page.getByRole('button', { name: 'Add Binding' }).click()
      const bindingDialog = page.getByRole('dialog', { name: 'Add Mintsoft Warehouse Binding' })
      await fieldByLabel(bindingDialog, 'IMS Warehouse').selectOption({ label: `${warehouseCode} · ${warehouseName}` })
      await fieldByLabel(bindingDialog, 'Mintsoft Warehouse').selectOption('301')
      await fieldByLabel(bindingDialog, 'Absolute Delta Threshold').fill('1')
      await fieldByLabel(bindingDialog, 'Report Recipients').fill(E2E_ADMIN_EMAIL)
      await bindingDialog.getByRole('button', { name: 'Add Warehouse Binding' }).click()

      await expect(page.getByText('Mintsoft binding saved')).toBeVisible()

      const summaryAfterBindingResponse = await mintsoftE2eGet(page, '/api/e2e/mintsoft?summary=1')
      expect(summaryAfterBindingResponse.ok()).toBeTruthy()
      const summaryAfterBinding = await summaryAfterBindingResponse.json() as {
        bindings: Array<{
          id: string
          warehouseCode: string
          externalWarehouseId: string
        }>
      }
      const createdBinding = summaryAfterBinding.bindings.find(
        (binding) => binding.externalWarehouseId === '301',
      )
      expect(createdBinding).toBeTruthy()

      const syncResponse = await seedMintsoftE2e(page, {
        runFirstBindingSync: true,
      })
      const syncBody = await syncResponse.json() as {
        syncResult: {
          jobId: string | null
          status: string
          totalChecked: number
          mismatched: number
          errors: number
        }
      }
      expect(syncBody.syncResult).toMatchObject({
        status: 'SUCCEEDED',
        totalChecked: 2,
        mismatched: 1,
        errors: 0,
      })
      expect(syncBody.syncResult.jobId).toBeTruthy()

      const summaryAfterSyncResponse = await mintsoftE2eGet(page, '/api/e2e/mintsoft?summary=1')
      expect(summaryAfterSyncResponse.ok()).toBeTruthy()
      const summaryAfterSync = await summaryAfterSyncResponse.json() as {
        discrepancies: Array<{
          sku: string | null
          category: string
        }>
      }
      expect(summaryAfterSync.discrepancies).toContainEqual(
        expect.objectContaining({
          sku: missingSku,
          category: 'MISSING_IN_WMS',
        }),
      )

      await page.reload()
      const notificationBadge = page.locator('button[aria-label="Notifications"] > span')
      await expect(notificationBadge).toHaveText(/\d+/)
      await page.getByRole('button', { name: 'Notifications' }).click()
      await expect(page.getByText('Mintsoft stock discrepancies detected')).toBeVisible()

      const csvResponse = await page.request.get(`/api/export/mintsoft-sync/${syncBody.syncResult.jobId}`)
      expect(csvResponse.ok()).toBeTruthy()
      const csvText = await csvResponse.text()
      expect(csvText).toContain(matchedSku)
      expect(csvText).toContain(missingSku)
      expect(csvText).toContain('MISSING_IN_WMS')
    } finally {
      await seedMintsoftE2e(page, {
        reset: true,
        clearProductSkus: [matchedSku, missingSku],
        clearWarehouseCodes: [warehouseCode],
        pluginEnabled: false,
        apiKey: null,
        username: null,
        password: null,
        webhookSecret: null,
        fakeState: null,
        clearNotificationsForUserEmail: E2E_ADMIN_EMAIL,
      })
    }
  })

  test('creates a Mintsoft ASN from a purchase order with outstanding base-unit quantities', async ({ page }) => {
    test.setTimeout(120_000)
    const suffix = uniqueSuffix()
    const warehouseCode = `MSASN${suffix.slice(-6).toUpperCase()}`
    const warehouseName = `Mintsoft ASN ${suffix}`
    const product = await createSimpleProduct(page, { price: '14.00' })

    await seedMintsoftE2e(page, {
      pluginEnabled: true,
      fakeState: {
        apiKey: 'e2e-static-ms-apikey',
        username: 'mintsoft.e2e.user',
        password: 'mintsoft.e2e.password',
        warehouses: [
          { id: 301, name: 'E2E Mintsoft ASN Warehouse' },
        ],
        products: [
          {
            id: '901',
            sku: product.sku,
            name: product.name,
          },
        ],
        stockLevelsByWarehouse: {
          '301': [],
        },
        asns: [],
      },
      warehouses: [
        {
          code: warehouseCode,
          name: warehouseName,
        },
      ],
      wmsProductLinks: [
        {
          sku: product.sku,
          externalProductId: '901',
        },
      ],
    })

    try {
      await page.goto('/sync?connector=mintsoft')
      await page.getByRole('button', { name: 'Edit Connection' }).click()
      const connectionDialog = page.getByRole('dialog', { name: 'Edit Mintsoft Connection' })
      await fieldByLabel(connectionDialog, 'Base URL').fill(`${APP_BASE_URL}/api/e2e/mintsoft`)
      await fieldByLabel(connectionDialog, 'Username').fill('mintsoft.e2e.user')
      await fieldByLabel(connectionDialog, 'Password').fill('mintsoft.e2e.password')
      await fieldByLabel(connectionDialog, 'Webhook Secret').fill('e2e-mintsoft-webhook-secret')
      await connectionDialog.getByRole('button', { name: 'Save Connection' }).click()
      await expect(page.getByText('Mintsoft connection saved')).toBeVisible()

      await page.getByRole('button', { name: 'Add Binding' }).click()
      const bindingDialog = page.getByRole('dialog', { name: 'Add Mintsoft Warehouse Binding' })
      await fieldByLabel(bindingDialog, 'IMS Warehouse').selectOption({ label: `${warehouseCode} · ${warehouseName}` })
      await fieldByLabel(bindingDialog, 'Mintsoft Warehouse').selectOption('301')
      await bindingDialog.getByRole('button', { name: 'Add Warehouse Binding' }).click()
      await expect(page.getByText('Mintsoft binding saved')).toBeVisible()

      const linkedProductResponse = await mintsoftE2eGet(page, `/api/e2e/mintsoft?sku=${encodeURIComponent(product.sku)}`)
      expect(linkedProductResponse.ok()).toBeTruthy()
      const linkedProductBody = await linkedProductResponse.json() as {
        product: {
          wmsProductLinks: Array<{
            externalProductId: string
          }>
        } | null
      }
      expect(linkedProductBody.product?.wmsProductLinks[0]?.externalProductId).toBe('901')

      await page.goto('/purchase-orders')
      await page.getByRole('button', { name: /new po/i }).click()
      const poDialog = page.getByRole('dialog', { name: 'New Purchase Order' })
      await poDialog.locator('select').first().selectOption({ label: 'E2E Supplier' })
      await poDialog.getByLabel('Destination Warehouse').selectOption({ label: `${warehouseCode} — ${warehouseName}` })
      await poDialog.getByLabel('Supplier Reference').fill(`SUP-${suffix}`)
      await poDialog.getByPlaceholder(/search product to add/i).fill(product.sku)
      await poDialog.getByRole('button', { name: new RegExp(product.sku) }).first().click()
      await poDialog.getByRole('button', { name: /create purchase order/i }).click()

      await page.waitForURL(/\/purchase-orders\/.+/)
      const poId = page.url().split('/').pop()
      expect(poId).toBeTruthy()

      await page.getByRole('button', { name: /confirm & send po/i }).click()
      await expect(page.getByText(/^PO Sent$/)).toBeVisible()

      await page.getByRole('button', { name: 'Create Mintsoft ASN' }).click()
      const asnDialog = page.getByRole('dialog', { name: 'Create Mintsoft ASN' })
      await asnDialog.getByLabel('Packaging Type').selectOption('PALLET')
      await asnDialog.getByLabel('Package Count').fill('2')
      await asnDialog.getByLabel('ETA').fill('2026-05-01')
      await asnDialog.getByLabel('Carrier').fill('DHL Freight')
      await asnDialog.getByRole('button', { name: 'Create Mintsoft ASN' }).click()
      await expect(asnDialog).toBeHidden()

      await expect(page.getByRole('heading', { name: 'Mintsoft ASN' })).toBeVisible()
      await expect(page.getByText('No Mintsoft ASN has been created for this purchase order yet.')).toHaveCount(0)
      await expect(
        page.getByRole('row').filter({ has: page.getByText('1', { exact: true }) }).getByText('OPEN', { exact: true }),
      ).toBeVisible()

      const asnMapsResponse = await mintsoftE2eGet(page, `/api/e2e/mintsoft?sourcePoId=${encodeURIComponent(poId!)}`)
      expect(asnMapsResponse.ok()).toBeTruthy()
      const asnMapsBody = await asnMapsResponse.json() as {
        asnMaps: Array<{
          externalAsnId: string
          status: string
          lines: Array<{
            sku: string
            expectedQty: number
          }>
        }>
      }

      expect(asnMapsBody.asnMaps).toHaveLength(1)
      expect(asnMapsBody.asnMaps[0]).toMatchObject({
        externalAsnId: '1',
        status: 'OPEN',
      })
      expect(asnMapsBody.asnMaps[0]?.lines).toEqual([
        expect.objectContaining({
          sku: product.sku,
          expectedQty: 1,
        }),
      ])
    } finally {
      await seedMintsoftE2e(page, {
        reset: true,
        pluginEnabled: false,
        apiKey: null,
        username: null,
        password: null,
        webhookSecret: null,
        fakeState: null,
        clearNotificationsForUserEmail: E2E_ADMIN_EMAIL,
      })
    }
  })

  test('accepts an unmapped signed Mintsoft ASN webhook, leaves it pending, and records retry state', async ({ page }) => {
    test.setTimeout(60_000)
    const suffix = uniqueSuffix()
    const externalEventId = `mintsoft-event-${suffix}`
    const externalAsnId = `ASN-${suffix}`
    const webhookSecret = 'e2e-mintsoft-webhook-secret'
    const occurredAt = new Date().toISOString()

    await seedMintsoftE2e(page, {
      pluginEnabled: true,
      webhookSecret,
    })

    const rawBody = JSON.stringify({
      eventId: externalEventId,
      asnId: externalAsnId,
      status: 'BookedIn',
      occurredAt,
    })
    const signature = createHmac('sha256', webhookSecret).update(rawBody, 'utf8').digest('hex')

    const firstResponse = await page.request.post('/api/webhooks/mintsoft/asn-booked-in', {
      headers: {
        'content-type': 'application/json',
        'x-mintsoft-signature': signature,
      },
      data: rawBody,
    })
    expect(firstResponse.ok()).toBeTruthy()
    const firstBody = await firstResponse.json()
    expect(firstBody).toMatchObject({
      accepted: true,
      pending: true,
      processed: false,
      externalEventId,
      externalAsnId,
    })

    const duplicateResponse = await page.request.post('/api/webhooks/mintsoft/asn-booked-in', {
      headers: {
        'content-type': 'application/json',
        'x-mintsoft-signature': signature,
      },
      data: rawBody,
    })
    expect(duplicateResponse.ok()).toBeTruthy()
    const duplicateBody = await duplicateResponse.json()
    expect(duplicateBody).toMatchObject({
      accepted: true,
      pending: true,
      processed: false,
      externalEventId,
      externalAsnId,
    })

    const eventsResponse = await mintsoftE2eGet(page, `/api/e2e/mintsoft?externalEventId=${encodeURIComponent(externalEventId)}`)
    expect(eventsResponse.ok()).toBeTruthy()
    const eventsBody = await eventsResponse.json() as {
      events: Array<{
        externalAsnId: string | null
        processedAt: string | null
        processingError: string | null
        retryState: {
          kind: string
          attempts: number
          nextRetryAt: string | null
          message: string
        } | null
      }>
    }

    expect(eventsBody.events).toHaveLength(1)
    expect(eventsBody.events[0]?.externalAsnId).toBe(externalAsnId)
    expect(eventsBody.events[0]?.processedAt).toBeNull()
    expect(eventsBody.events[0]?.processingError).toMatch(/^RETRY_STATE:/)
    expect(eventsBody.events[0]?.retryState).toMatchObject({
      kind: 'pending',
      attempts: 1,
    })
    expect(eventsBody.events[0]?.retryState?.message).toMatch(/not mapped yet; waiting for ASN finalization/i)
  })

  test('runs Mintsoft product verify, backfills a missing IMS barcode, and surfaces barcode conflicts without overwriting either side', async ({ page }) => {
    test.setTimeout(90_000)
    const suffix = uniqueSuffix()
    const warehouseCode = `MSPV${suffix}`
    const warehouseName = `Mintsoft Product Verify ${suffix}`
    const backfillSku = `MS-E2E-BACKFILL-${suffix}`
    const conflictSku = `MS-E2E-CONFLICT-${suffix}`
    const backfillBarcode = `5901234123${suffix.slice(-3)}`
    const imsConflictBarcode = `5900000001${suffix.slice(-3)}`
    const wmsConflictBarcode = `5909999999${suffix.slice(-3)}`

    await seedMintsoftE2e(page, {
      pluginEnabled: true,
      fakeState: {
        apiKey: 'e2e-static-ms-apikey',
        username: 'mintsoft.e2e.user',
        password: 'mintsoft.e2e.password',
        warehouses: [
          { id: 301, name: 'E2E Mintsoft Main' },
        ],
        products: [
          {
            id: '501',
            sku: backfillSku,
            name: `Mintsoft backfill ${suffix}`,
            ean: backfillBarcode,
          },
          {
            id: '502',
            sku: conflictSku,
            name: `Mintsoft conflict ${suffix}`,
            ean: wmsConflictBarcode,
          },
        ],
        stockLevelsByWarehouse: {
          '301': [],
        },
      },
      warehouses: [
        {
          code: warehouseCode,
          name: warehouseName,
        },
      ],
      products: [
        {
          sku: backfillSku,
          name: `IMS backfill ${suffix}`,
          warehouseCode,
          quantity: 0,
          barcode: null,
        },
        {
          sku: conflictSku,
          name: `IMS conflict ${suffix}`,
          warehouseCode,
          quantity: 0,
          barcode: imsConflictBarcode,
        },
      ],
    })

    try {
      await page.goto('/sync?connector=mintsoft')
      await expect(page.getByRole('heading', { name: 'Mintsoft Connector' })).toBeVisible()

      await page.getByRole('button', { name: 'Edit Connection' }).click()
      const connectionDialog = page.getByRole('dialog', { name: 'Edit Mintsoft Connection' })
      await fieldByLabel(connectionDialog, 'Base URL').fill(`${APP_BASE_URL}/api/e2e/mintsoft`)
      await fieldByLabel(connectionDialog, 'Username').fill('mintsoft.e2e.user')
      await fieldByLabel(connectionDialog, 'Password').fill('mintsoft.e2e.password')
      await fieldByLabel(connectionDialog, 'Webhook Secret').fill('e2e-mintsoft-webhook-secret')
      await connectionDialog.getByRole('button', { name: 'Save Connection' }).click()
      await expect(page.getByText('Mintsoft connection saved')).toBeVisible()

      await page.getByRole('button', { name: 'Add Binding' }).click()
      const bindingDialog = page.getByRole('dialog', { name: 'Add Mintsoft Warehouse Binding' })
      await fieldByLabel(bindingDialog, 'IMS Warehouse').selectOption({ label: `${warehouseCode} · ${warehouseName}` })
      await fieldByLabel(bindingDialog, 'Mintsoft Warehouse').selectOption('301')
      await bindingDialog.getByRole('button', { name: 'Add Warehouse Binding' }).click()
      await expect(page.getByText('Mintsoft binding saved')).toBeVisible()

      await expect(page.getByRole('button', { name: 'Run Product Verify' })).toBeVisible()

      const verifyResponse = await seedMintsoftE2e(page, {
        runProductVerifySkus: [backfillSku, conflictSku],
      })
      const verifyBody = await verifyResponse.json() as {
        verifyResult: {
          status: string
          totalChecked: number
          corrected: number
          mismatched: number
          errors: number
        }
      }
      expect(verifyBody.verifyResult).toMatchObject({
        status: 'SUCCEEDED',
        totalChecked: 2,
        corrected: 2,
        mismatched: 1,
        errors: 0,
      })

      const backfillResponse = await mintsoftE2eGet(page, `/api/e2e/mintsoft?sku=${encodeURIComponent(backfillSku)}`)
      expect(backfillResponse.ok()).toBeTruthy()
      const backfillBody = await backfillResponse.json() as {
        product: {
          barcode: string | null
          wmsProductLinks: Array<{
            externalProductId: string
            lastKnownBarcode: string | null
            lastSyncedAt: string | null
            lastError: string | null
          }>
          wmsStockDiscrepancies: Array<{
            category: string
            status: string
          }>
        } | null
      }
      expect(backfillBody.product?.barcode).toBe(backfillBarcode)
      expect(backfillBody.product?.wmsProductLinks[0]?.externalProductId).toBe('501')
      expect(backfillBody.product?.wmsProductLinks[0]?.lastKnownBarcode).toBe(backfillBarcode)
      expect(backfillBody.product?.wmsProductLinks[0]?.lastSyncedAt).toBeTruthy()
      expect(backfillBody.product?.wmsProductLinks[0]?.lastError ?? null).toBeNull()
      expect(backfillBody.product?.wmsStockDiscrepancies).toContainEqual(
        expect.objectContaining({
          category: 'BARCODE_BACKFILLED_FROM_WMS',
          status: 'RESOLVED',
        }),
      )

      const conflictResponse = await mintsoftE2eGet(page, `/api/e2e/mintsoft?sku=${encodeURIComponent(conflictSku)}`)
      expect(conflictResponse.ok()).toBeTruthy()
      const conflictBody = await conflictResponse.json() as {
        product: {
          barcode: string | null
          wmsProductLinks: Array<{
            externalProductId: string
            lastKnownBarcode: string | null
          }>
          wmsStockDiscrepancies: Array<{
            category: string
            status: string
            imsValue: string | null
            wmsValue: string | null
          }>
        } | null
      }
      expect(conflictBody.product?.barcode).toBe(imsConflictBarcode)
      expect(conflictBody.product?.wmsProductLinks[0]?.externalProductId).toBe('502')
      expect(conflictBody.product?.wmsProductLinks[0]?.lastKnownBarcode).toBe(wmsConflictBarcode)
      expect(conflictBody.product?.wmsStockDiscrepancies).toContainEqual(
        expect.objectContaining({
          category: 'BARCODE_CONFLICT',
          status: 'OPEN',
          imsValue: imsConflictBarcode,
          wmsValue: wmsConflictBarcode,
        }),
      )

      const mintsoftBackfillResponse = await mintsoftE2eGet(page, `/api/e2e/mintsoft/api/Product?SKU=${encodeURIComponent(backfillSku)}`, {
        headers: {
          'ms-apikey': 'e2e-static-ms-apikey',
        },
      })
      expect(mintsoftBackfillResponse.ok()).toBeTruthy()
      const mintsoftBackfillProducts = await mintsoftBackfillResponse.json() as Array<{ EAN: string | null }>
      expect(mintsoftBackfillProducts[0]?.EAN).toBe(backfillBarcode)

      const mintsoftConflictResponse = await mintsoftE2eGet(page, `/api/e2e/mintsoft/api/Product?SKU=${encodeURIComponent(conflictSku)}`, {
        headers: {
          'ms-apikey': 'e2e-static-ms-apikey',
        },
      })
      expect(mintsoftConflictResponse.ok()).toBeTruthy()
      const mintsoftConflictProducts = await mintsoftConflictResponse.json() as Array<{ EAN: string | null }>
      expect(mintsoftConflictProducts[0]?.EAN).toBe(wmsConflictBarcode)

      await page.reload()
      await expect(page.getByText('BARCODE_CONFLICT')).toBeVisible()
    } finally {
      await seedMintsoftE2e(page, {
        reset: true,
        clearProductSkus: [backfillSku, conflictSku],
        clearWarehouseCodes: [warehouseCode],
        pluginEnabled: false,
        apiKey: null,
        username: null,
        password: null,
        webhookSecret: null,
        fakeState: null,
        clearNotificationsForUserEmail: E2E_ADMIN_EMAIL,
      })
    }
  })

  test('polls Mintsoft returns into the inbox and restocks selected stock into a chosen warehouse', async ({ page }) => {
    test.setTimeout(90_000)
    const suffix = uniqueSuffix()
    const warehouseCode = `MSRT${suffix}`
    const warehouseName = `Mintsoft Returns ${suffix}`
    const sku = `MS-E2E-RETURN-${suffix}`
    const returnId = `RET-${suffix}`

    await seedMintsoftE2e(page, {
      pluginEnabled: true,
      fakeState: {
        apiKey: 'e2e-static-ms-apikey',
        username: 'mintsoft.e2e.user',
        password: 'mintsoft.e2e.password',
        warehouses: [
          { id: 301, name: 'E2E Mintsoft Main' },
        ],
        returns: [
          {
            id: returnId,
            warehouseId: '301',
            sku,
            qty: 2,
            orderReference: null,
            reason: 'Damaged outer box',
            receivedAt: '2026-04-21T12:00:00.000Z',
          },
        ],
        stockLevelsByWarehouse: {
          '301': [],
        },
        products: [],
      },
      warehouses: [
        {
          code: warehouseCode,
          name: warehouseName,
        },
      ],
      products: [
        {
          sku,
          name: `Mintsoft return ${suffix}`,
          warehouseCode,
          quantity: 0,
        },
      ],
    })

    try {
      await page.goto('/sync?connector=mintsoft')
      await expect(page.getByRole('heading', { name: 'Mintsoft Connector' })).toBeVisible()

      await page.getByRole('button', { name: 'Edit Connection' }).click()
      const connectionDialog = page.getByRole('dialog', { name: 'Edit Mintsoft Connection' })
      await fieldByLabel(connectionDialog, 'Base URL').fill(`${APP_BASE_URL}/api/e2e/mintsoft`)
      await fieldByLabel(connectionDialog, 'Username').fill('mintsoft.e2e.user')
      await fieldByLabel(connectionDialog, 'Password').fill('mintsoft.e2e.password')
      await connectionDialog.getByRole('button', { name: 'Save Connection' }).click()
      await expect(page.getByText('Mintsoft connection saved')).toBeVisible()

      await page.getByRole('button', { name: 'Add Binding' }).click()
      const bindingDialog = page.getByRole('dialog', { name: 'Add Mintsoft Warehouse Binding' })
      await fieldByLabel(bindingDialog, 'IMS Warehouse').selectOption({ label: `${warehouseCode} · ${warehouseName}` })
      await fieldByLabel(bindingDialog, 'Mintsoft Warehouse').selectOption('301')
      await fieldByLabel(bindingDialog, 'Returns Mode').selectOption('POLL')
      await bindingDialog.getByRole('button', { name: 'Add Warehouse Binding' }).click()
      await expect(page.locator('tbody tr', { hasText: warehouseCode }).getByText('301')).toBeVisible()

      await page.getByRole('button', { name: 'Poll Returns' }).click()
      await expect(page.getByText(`Checked 1 returns, staged 1 new inbox items, 0 errors.`)).toBeVisible()
      await expect(page.getByText(returnId)).toBeVisible()
      await expect(page.getByText('Damaged outer box')).toBeVisible()

      await page.getByRole('button', { name: 'Restock' }).click()
      const restockDialog = page.getByRole('dialog', { name: 'Restock Mintsoft Return' })
      await fieldByLabel(restockDialog, 'Restock Warehouse').selectOption({ label: `${warehouseCode} · ${warehouseName}` })
      await restockDialog.getByRole('button', { name: 'Confirm Restock' }).click()

      await expect(page.getByText(`Restocked 2 units of ${sku} to ${warehouseCode}.`)).toBeVisible()
      await expect(page.locator('tbody tr', { hasText: returnId }).getByText('RESTOCKED')).toBeVisible()

      const productResponse = await mintsoftE2eGet(page, `/api/e2e/mintsoft?sku=${encodeURIComponent(sku)}`)
      expect(productResponse.ok()).toBeTruthy()
      const productBody = await productResponse.json() as {
        product: {
          id: string
        } | null
        stockLevels: Array<{
          warehouseCode: string
          quantity: number
        }>
      }
      expect(productBody.product?.id).toBeTruthy()
      expect(productBody.stockLevels).toContainEqual({
        warehouseCode,
        quantity: 2,
      })

      const summaryResponse = await mintsoftE2eGet(page, '/api/e2e/mintsoft?summary=1')
      expect(summaryResponse.ok()).toBeTruthy()
      const summaryBody = await summaryResponse.json() as {
        returnsInbox: Array<{
          externalReturnId: string
          status: string
        }>
      }
      expect(summaryBody.returnsInbox).toEqual(expect.arrayContaining([
        expect.objectContaining({
          externalReturnId: returnId,
          status: 'RESTOCKED',
        }),
      ]))
    } finally {
      await seedMintsoftE2e(page, {
        reset: true,
        clearProductSkus: [sku],
        clearWarehouseCodes: [warehouseCode],
        pluginEnabled: false,
        apiKey: null,
        username: null,
        password: null,
        webhookSecret: null,
        fakeState: null,
        clearNotificationsForUserEmail: E2E_ADMIN_EMAIL,
      })
    }
  })
})
