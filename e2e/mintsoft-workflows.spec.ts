import { createHmac } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { uniqueSuffix } from './helpers'
import { E2E_ADMIN_EMAIL } from './test-data'

const APP_BASE_URL = (process.env.E2E_BASE_URL ?? 'http://localhost:3001').replace(/\/$/, '')

async function seedMintsoftE2e(
  page: import('@playwright/test').Page,
  payload: Record<string, unknown>,
) {
  const response = await page.request.post('/api/e2e/mintsoft', {
    data: payload,
  })
  expect(response.ok()).toBeTruthy()
  return response
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

      const summaryAfterBindingResponse = await page.request.get('/api/e2e/mintsoft?summary=1')
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

      const summaryAfterSyncResponse = await page.request.get('/api/e2e/mintsoft?summary=1')
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

  test('accepts a signed Mintsoft ASN webhook and keeps replays idempotent while the event is still pending', async ({ page }) => {
    test.setTimeout(60_000)
    const suffix = uniqueSuffix()
    const externalEventId = `mintsoft-event-${suffix}`
    const externalAsnId = `ASN-${suffix}`
    const webhookSecret = 'e2e-mintsoft-webhook-secret'

    await seedMintsoftE2e(page, {
      pluginEnabled: true,
      webhookSecret,
    })

    const rawBody = JSON.stringify({
      eventId: externalEventId,
      asnId: externalAsnId,
      status: 'BookedIn',
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
      externalEventId,
      externalAsnId,
    })

    const eventsResponse = await page.request.get(`/api/e2e/mintsoft?externalEventId=${encodeURIComponent(externalEventId)}`)
    expect(eventsResponse.ok()).toBeTruthy()
    const eventsBody = await eventsResponse.json() as {
      events: Array<{
        externalAsnId: string | null
        processedAt: string | null
      }>
    }

    expect(eventsBody.events).toHaveLength(1)
    expect(eventsBody.events[0]?.externalAsnId).toBe(externalAsnId)
    expect(eventsBody.events[0]?.processedAt).toBeNull()
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
        corrected: 1,
        mismatched: 1,
        errors: 0,
      })

      const backfillResponse = await page.request.get(`/api/e2e/mintsoft?sku=${encodeURIComponent(backfillSku)}`)
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

      const conflictResponse = await page.request.get(`/api/e2e/mintsoft?sku=${encodeURIComponent(conflictSku)}`)
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

      const mintsoftBackfillResponse = await page.request.get(`/api/e2e/mintsoft/api/Product?SKU=${encodeURIComponent(backfillSku)}`, {
        headers: {
          'ms-apikey': 'e2e-static-ms-apikey',
        },
      })
      expect(mintsoftBackfillResponse.ok()).toBeTruthy()
      const mintsoftBackfillProducts = await mintsoftBackfillResponse.json() as Array<{ EAN: string | null }>
      expect(mintsoftBackfillProducts[0]?.EAN).toBe(backfillBarcode)

      const mintsoftConflictResponse = await page.request.get(`/api/e2e/mintsoft/api/Product?SKU=${encodeURIComponent(conflictSku)}`, {
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
})
