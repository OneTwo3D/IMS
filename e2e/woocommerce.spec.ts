import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { addStockAdjustment } from './helpers'

const wcEnabled = process.env.E2E_WC_ENABLED === 'true'
const databaseUrl = process.env.DATABASE_URL!

function psql(query: string) {
  return execFileSync('psql', [databaseUrl, '-At', '-F', '|', '-c', query], {
    encoding: 'utf8',
  }).trim()
}

function sqlString(value: string) {
  return `'${value.replace(/'/g, "''")}'`
}

async function openWooCommerceConnector(page: Page) {
  await page.goto('/sync?connector=woocommerce')
  await expect(page.getByRole('heading', { name: 'WooCommerce Connector' })).toBeVisible()
}

async function ensureWcProductAndStockSyncEnabled(page: Page) {
  await page.getByRole('button', { name: 'Products' }).click()

  const productCheckbox = page.locator('input[type="checkbox"]').nth(0)
  const stockCheckbox = page.locator('input[type="checkbox"]').nth(1)
  let changed = false

  if (!(await productCheckbox.isChecked())) {
    await productCheckbox.check()
    changed = true
  }
  if (!(await stockCheckbox.isChecked())) {
    await stockCheckbox.check()
    changed = true
  }

  if (changed) {
    await page.getByRole('button', { name: /save settings/i }).click()
    await expect(page.getByText(/saved/i)).toBeVisible()
  }
}

async function wcRequest(path: string, init?: RequestInit) {
  const wcUrl = psql(`select value from settings where key = 'wc_url' limit 1;`)
  const wcKey = psql(`select value from settings where key = 'wc_consumer_key' limit 1;`)
  const wcSecret = psql(`select value from settings where key = 'wc_consumer_secret' limit 1;`)
  if (!wcUrl || !wcKey || !wcSecret) throw new Error('WooCommerce credentials are not configured in settings')

  const auth = Buffer.from(`${wcKey}:${wcSecret}`).toString('base64')
  const res = await fetch(`${wcUrl.replace(/\/$/, '')}/wp-json/wc/v3${path}`, {
    ...init,
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })

  if (!res.ok) {
    throw new Error(`WC API ${init?.method ?? 'GET'} ${path} failed: ${res.status} ${res.statusText} ${await res.text()}`)
  }

  return res.json()
}

test.describe('@external @wc WooCommerce integration', () => {
  test.skip(!wcEnabled, 'Set E2E_WC_ENABLED=true to run live WooCommerce integration tests.')

  test('runs a live WooCommerce product sync and records it in the WC sync log', async ({ page }) => {
    await openWooCommerceConnector(page)

    await page.getByRole('button', { name: 'Products' }).click()
    const syncButton = page.getByRole('button', { name: /sync products now/i })
    await expect(syncButton).toBeVisible()
    await syncButton.click()

    await expect(page.getByText(/products sync completed:/i)).toBeVisible({ timeout: 60000 })

    await page.getByRole('button', { name: 'Sync Log' }).click()
    await expect(page.getByText(/PRODUCT/i).first()).toBeVisible()
  })

  test('runs a live WooCommerce order sync', async ({ page }) => {
    await openWooCommerceConnector(page)

    await page.getByRole('button', { name: 'Orders' }).click()

    const importButton = page.getByRole('button', { name: /import active orders/i })
    if (await importButton.isVisible()) {
      await importButton.click()
      await expect(page.getByText(/Import completed/i)).toBeVisible({ timeout: 120000 })
    }

    const syncButton = page.getByRole('button', { name: /sync orders now/i })
    await expect(syncButton).toBeVisible()
    await expect(syncButton).toBeEnabled()
    await syncButton.click()

    await expect(page.getByText(/orders sync completed:/i)).toBeVisible({ timeout: 60000 })
  })

  test('pushes edited shipment tracking back to live WooCommerce order meta', async ({ page }) => {
    test.setTimeout(240000)

    await openWooCommerceConnector(page)
    await ensureWcProductAndStockSyncEnabled(page)
    await page.getByRole('button', { name: 'Orders' }).click()

    const importButton = page.getByRole('button', { name: /import active orders/i })
    if (await importButton.isVisible()) {
      await importButton.click()
      await expect(page.getByText(/Import completed/i)).toBeVisible({ timeout: 120000 })
    }

    const syncProductsButton = page.getByRole('button', { name: /sync products now/i })
    await page.getByRole('button', { name: 'Products' }).click()
    await syncProductsButton.click()
    await expect(page.getByText(/products sync completed:/i)).toBeVisible({ timeout: 120000 })

    const productRow = psql(`select p.id || '|' || p.sku || '|' || coalesce(p."externalProductId"::text, '')
      from products p
      join shopping_sync_logs l on l."entityId" = p.id
      where l.direction = 'FROM_CONNECTOR'
        and l.status = 'SYNCED'
        and l."entityType" = 'Product'
        and p.active = true
        and p.type not in ('VARIABLE', 'KIT', 'NON_INVENTORY')
        and p."externalProductId" is not null
      order by l."createdAt" desc
      limit 1;`)
    const [productId, productSku, externalProductId] = productRow.split('|')
    if (!productId || !productSku || !externalProductId) throw new Error('No Woo-linked simple product found for tracking test')

    const warehouseRow = psql(`select code from warehouses where active = true and "syncToStore" = true order by "isDefault" desc, code asc limit 1;`)
    if (!warehouseRow) throw new Error('No sync-enabled warehouse available for WooCommerce order fulfillment test')
    await addStockAdjustment(page, productSku, 3, warehouseRow)

    const runTag = `${Date.now()}`
    const billingEmail = `tracking-e2e-${runTag}@example.com`
    const createdOrder = await wcRequest('/orders', {
      method: 'POST',
      body: JSON.stringify({
        status: 'processing',
        set_paid: false,
        customer_note: `IMS tracking E2E ${runTag}`,
        billing: {
          first_name: 'Tracking',
          last_name: 'E2E',
          email: billingEmail,
          address_1: '1 Test Street',
          city: 'Cambridge',
          postcode: 'CB1 1AA',
          country: 'GB',
        },
        shipping: {
          first_name: 'Tracking',
          last_name: 'E2E',
          address_1: '1 Test Street',
          city: 'Cambridge',
          postcode: 'CB1 1AA',
          country: 'GB',
        },
        line_items: [{ product_id: Number(externalProductId), quantity: 1 }],
      }),
    }) as { id: number; number: string }

    await page.goto('/sync?connector=woocommerce')
    await page.getByRole('button', { name: 'Orders' }).click()
    const syncOrdersButton = page.getByRole('button', { name: /sync orders now/i })
    if (await syncOrdersButton.isEnabled()) {
      await syncOrdersButton.click()
      await expect(page.getByText(/orders sync completed:/i)).toBeVisible({ timeout: 120000 })
    } else if (await importButton.isVisible()) {
      await importButton.click()
      await expect(page.getByText(/Import completed/i)).toBeVisible({ timeout: 120000 })
    }

    const orderId = await expect.poll(() => (
      psql(`select id from sales_orders where "externalOrderId" = ${createdOrder.id} limit 1;`)
    ), {
      timeout: 120000,
    })
    if (!orderId) throw new Error(`WC order ${createdOrder.id} was not imported into IMS`)

    await page.goto(`/sales/${orderId}`)
    await expect(page.getByText(productSku, { exact: true })).toBeVisible({ timeout: 30000 })

    const createShipmentsButton = page.getByRole('button', { name: /create shipments/i })
    if (await createShipmentsButton.isVisible()) {
      await createShipmentsButton.click()
    }
    await expect(page.getByText(/shipment from/i)).toBeVisible({ timeout: 30000 })

    await page.getByRole('button', { name: /start picking/i }).click()
    await page.getByRole('button', { name: /mark packed/i }).click()
    await page.getByRole('button', { name: /^Ship$/ }).click()

    const initialTracking = `E2E-WC-TRACK-${runTag}-A`
    const updatedTracking = `E2E-WC-TRACK-${runTag}-B`
    const shipDialog = page.getByRole('dialog', { name: 'Ship Parcel' })
    await expect(shipDialog).toBeVisible()
    await shipDialog.locator('select').selectOption({ label: 'Royal Mail' })
    await shipDialog.locator('input').fill(initialTracking)
    await shipDialog.getByRole('button', { name: /confirm shipment/i }).click()
    await expect(shipDialog).toBeHidden()

    await expect(page.getByText(`#${initialTracking}`)).toBeVisible({ timeout: 30000 })

    await page.getByRole('button', { name: /edit tracking/i }).click()
    const editDialog = page.getByRole('dialog', { name: 'Edit Tracking' })
    await expect(editDialog).toBeVisible()
    await editDialog.locator('select').selectOption({ label: 'DHL' })
    await editDialog.locator('input').fill(updatedTracking)
    await editDialog.getByRole('button', { name: /save tracking/i }).click()
    await expect(editDialog).toBeHidden()
    await expect(page.getByText(`#${updatedTracking}`)).toBeVisible({ timeout: 30000 })

    await expect.poll(async () => {
      const order = await wcRequest(`/orders/${createdOrder.id}`) as { meta_data?: Array<{ key: string; value: unknown }> }
      const meta = order.meta_data?.find((entry) => entry.key === '_wc_shipment_tracking_items')
      const items = Array.isArray(meta?.value) ? meta!.value as Array<Record<string, unknown>> : []
      const trackingNumbers = items
        .map((item) => typeof item.tracking_number === 'string' ? item.tracking_number : '')
        .filter(Boolean)
        .sort()
      const carriers = items
        .map((item) => {
          if (typeof item.custom_tracking_provider === 'string' && item.custom_tracking_provider) return item.custom_tracking_provider
          return typeof item.tracking_provider === 'string' ? item.tracking_provider : ''
        })
        .filter(Boolean)
        .sort()
      return JSON.stringify({ trackingNumbers, carriers })
    }, {
      timeout: 120000,
    }).toBe(JSON.stringify({
      trackingNumbers: [updatedTracking],
      carriers: ['DHL'],
    }))

    await expect.poll(() => (
      psql(`select id from shopping_sync_logs
        where "entityType" = 'SalesOrder'
          and direction = 'TO_CONNECTOR'
          and status = 'SYNCED'
          and "externalId" = ${createdOrder.id}
          and payload::text like '%_wc_shipment_tracking_items%'
          and payload::text like '%' || ${sqlString(updatedTracking)} || '%'
        order by "createdAt" desc
        limit 1;`)
    ), {
      timeout: 120000,
    }).not.toEqual('')
  })

  test.fixme('runs a live WooCommerce stock push and records TO_CONNECTOR sync activity', async () => {
    test.fail(true, 'The demo WooCommerce connector does not currently surface a stable completion signal for Push Stock Now in Playwright runs.')
  })
})
