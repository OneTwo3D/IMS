import { createHmac } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { decryptSecret } from '../lib/secrets.ts'

const wcEnabled = process.env.E2E_WC_ENABLED === 'true'
const xeroEnabled = process.env.E2E_XERO_ENABLED === 'true'
const databaseUrl = process.env.DATABASE_URL!
const baseUrl = process.env.E2E_BASE_URL ?? 'http://localhost:3000'

function psql(query: string) {
  return execFileSync('psql', [databaseUrl, '-At', '-F', '|', '-c', query], {
    encoding: 'utf8',
  }).trim()
}

function parseRows(raw: string) {
  if (!raw) return []
  return raw.split('\n').filter(Boolean).map((line) => line.split('|'))
}

function parsePossiblyPrefixedJson(text: string) {
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    const candidateStarts = [...trimmed.matchAll(/[\[{]/g)].map((match) => match.index ?? -1).filter((index) => index >= 0)
    for (const start of candidateStarts) {
      try {
        return JSON.parse(trimmed.slice(start))
      } catch {
        // Keep scanning until we find a valid trailing JSON payload.
      }
    }
    throw new Error(`Unable to parse JSON payload: ${text}`)
  }
}

function sqlString(value: string) {
  return `'${value.replace(/'/g, "''")}'`
}

function uniqueSuffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function getSettingValues(keys: string[]) {
  if (keys.length === 0) return {}

  const sensitiveKeys = new Set([
    'wc_consumer_secret',
    'wc_webhook_secret',
  ])
  const envFallbacks: Partial<Record<string, string>> = {
    wc_webhook_secret: 'WC_WEBHOOK_SECRET',
  }
  const result: Record<string, string> = {}
  const missingKeys = keys.filter((key) => {
    const envKey = envFallbacks[key]
    const envValue = envKey ? process.env[envKey] : undefined
    if (envValue) {
      result[key] = envValue
      return false
    }
    return true
  })

  if (missingKeys.length === 0) return result

  const rows = parseRows(psql(`
    select key, value
    from settings
    where key in (${missingKeys.map(sqlString).join(', ')})
    order by key asc;
  `))
  for (const [key, value] of rows) {
    result[key] = sensitiveKeys.has(key) ? decryptSecret(value) : value
  }

  return result
}

async function wcRequest(
  settings: Record<string, string>,
  path: string,
  init?: RequestInit,
) {
  const wcUrl = settings.wc_url
  const wcKey = settings.wc_consumer_key
  const wcSecret = settings.wc_consumer_secret
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

  const text = await res.text()
  if (!res.ok) {
    throw new Error(`WC API ${init?.method ?? 'GET'} ${path} failed: ${res.status} ${res.statusText} ${text}`)
  }

  try {
    return parsePossiblyPrefixedJson(text)
  } catch {
    throw new Error(`WC API ${init?.method ?? 'GET'} ${path} returned non-JSON payload: ${text}`)
  }
}

async function postSignedWebhook(
  resource: 'orders' | 'refunds',
  topic: string,
  payload: unknown,
  webhookSecret: string,
) {
  const body = JSON.stringify(payload)
  const signature = createHmac('sha256', webhookSecret).update(body).digest('base64')
  const response = await fetch(`${baseUrl}/api/webhooks/shopping/woocommerce/${resource}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-wc-webhook-signature': signature,
      'x-wc-webhook-topic': topic,
    },
    body,
  })

  if (!response.ok) {
    throw new Error(`Webhook ${resource}/${topic} failed: ${response.status} ${response.statusText} ${await response.text()}`)
  }
}

async function openXeroConnector(page: Page) {
  await page.goto('/sync?connector=xero')
  await expect(page.getByRole('heading', { name: 'Xero Connector' })).toBeVisible()
}

async function processPendingXeroSync(page: Page) {
  await openXeroConnector(page)
  await page.getByRole('button', { name: 'Sync' }).click()
  const processButton = page.getByRole('button', { name: /process pending now/i })
  await expect(processButton).toBeVisible()
  await expect(processButton).toBeEnabled()
  await processButton.click()
  await expect(page.getByText(/Sync complete:/i)).toBeVisible({ timeout: 120000 })
}

async function shipOrder(page: Page) {
  const createShipmentsButton = page.getByRole('button', { name: /create shipments/i })
  if (await createShipmentsButton.isVisible()) {
    await createShipmentsButton.click()
  }
  await expect(page.getByText(/shipment from/i)).toBeVisible({ timeout: 30000 })

  await page.getByRole('button', { name: /start picking/i }).click()
  await page.getByRole('button', { name: /mark packed/i }).click()
  await page.getByRole('button', { name: /^Ship$/ }).click()

  const dialog = page.getByRole('dialog', { name: /Ship/i })
  await expect(dialog).toBeVisible()
  await dialog.locator('select').selectOption({ label: 'Royal Mail' })
  await dialog.locator('input').fill(`E2E-WC-BUNDLE-${Date.now()}`)
  await dialog.getByRole('button', { name: /confirm shipment/i }).click()
  await expect(dialog).toBeHidden({ timeout: 30000 })
}

type WcSimpleProduct = {
  id: number
  sku: string
  name: string
  type: string
  status: string
}

test.describe.serial('@external @wc @xero WooCommerce bundle refund to Xero', () => {
  test.skip(!wcEnabled || !xeroEnabled, 'Set E2E_WC_ENABLED=true and E2E_XERO_ENABLED=true to run this live integration test.')

  test('imports a WooCommerce bundle order, syncs the Xero invoice, and refunds component stock/cogs correctly', async ({ page }) => {
    test.setTimeout(360000)

    const settings = getSettingValues([
      'wc_url',
      'wc_consumer_key',
      'wc_consumer_secret',
      'wc_webhook_secret',
    ])
    const webhookSecret = settings.wc_webhook_secret
    if (!webhookSecret) throw new Error('WooCommerce webhook secret is not configured')

    const suffix = uniqueSuffix()
    const tempWarehouseId = `wc_bundle_wh_${suffix}`
    const tempWarehouseCode = `WCB${suffix.slice(-6).toUpperCase()}`
    const tempComponentAId = `wc_bundle_component_a_${suffix}`
    const tempComponentBId = `wc_bundle_component_b_${suffix}`
    const tempBaseProductId = `wc_bundle_base_${suffix}`
    const componentASku = `E2E-WC-KIT-A-${suffix}`
    const componentBSku = `E2E-WC-KIT-B-${suffix}`
    const testOrderNote = `IMS WC/Xero bundle refund ${suffix}`

    const remoteProducts = await wcRequest(settings, '/products?status=publish&type=simple&per_page=50') as WcSimpleProduct[]
    const eligibleRemoteProducts = remoteProducts.filter((product) => product.type === 'simple' && product.status === 'publish' && product.sku)
    if (eligibleRemoteProducts.length === 0) {
      throw new Error('No published WooCommerce simple product with a SKU was found for bundle refund test')
    }

    let baseProductId = ''
    let baseSku = ''
    let baseExternalProductId = ''
    let baseOriginalType = 'SIMPLE'
    let baseOriginalParentId = ''
    let baseOriginalExternalProductId = ''
    let baseProductCreated = false

    for (const remoteProduct of eligibleRemoteProducts) {
      const existingRow = psql(`
        select
          id,
          sku,
          type,
          coalesce("parentId", ''),
          coalesce("externalProductId"::text, ''),
          exists(select 1 from product_components pc where pc."productId" = products.id)::text,
          exists(select 1 from sales_order_lines sol where sol."productId" = products.id)::text,
          exists(select 1 from stock_levels sl where sl."productId" = products.id and (sl.quantity <> 0 or sl."reservedQty" <> 0))::text
        from products
        where sku = ${sqlString(remoteProduct.sku)}
        limit 1;
      `)

      if (!existingRow) {
        psql(`
          insert into products (
            id, sku, name, type, "lifecycleStatus", "externalProductId",
            "salesPriceBase", "salesPriceTaxInclusive", "oversellAllowed",
            "stockUnit", "taxCategory", active, "createdAt", "updatedAt"
          ) values (
            ${sqlString(tempBaseProductId)}, ${sqlString(remoteProduct.sku)}, ${sqlString(remoteProduct.name)}, 'SIMPLE', 'ACTIVE', ${remoteProduct.id},
            20, false, true, 'pcs', 'STANDARD', true, now(), now()
          );
        `)
        baseProductId = tempBaseProductId
        baseSku = remoteProduct.sku
        baseExternalProductId = String(remoteProduct.id)
        baseOriginalExternalProductId = String(remoteProduct.id)
        baseProductCreated = true
        break
      }

      const [existingId, existingSku, existingType, existingParentId, existingExternalProductId, hasComponents, hasOrderLines, hasStock] = existingRow.split('|')
      if (existingType !== 'SIMPLE') continue
      if (hasComponents === 'true' || hasOrderLines === 'true' || hasStock === 'true') continue

      baseProductId = existingId
      baseSku = existingSku
      baseExternalProductId = String(remoteProduct.id)
      baseOriginalType = existingType
      baseOriginalParentId = existingParentId
      baseOriginalExternalProductId = existingExternalProductId

      if (existingExternalProductId !== String(remoteProduct.id)) {
        psql(`
          update products
          set "externalProductId" = ${remoteProduct.id},
              "updatedAt" = now()
          where id = ${sqlString(existingId)};
        `)
      }
      break
    }

    if (!baseProductId || !baseSku || !baseExternalProductId) {
      throw new Error('No eligible WooCommerce source product could be provisioned locally for bundle refund test')
    }

    const warehouseStates = parseRows(psql(`
      select id, "syncToStore"::text, "isDefault"::text, "defaultReturnWarehouse"::text
      from warehouses
      order by id;
    `))
    const tempWarehouseExists = psql(`select count(*) from warehouses where id = ${sqlString(tempWarehouseId)};`) === '1'
    const originalComponents = parseRows(psql(`
      select id, "componentId", qty::text, "sortOrder"::text
      from product_components
      where "productId" = ${sqlString(baseProductId)}
      order by "sortOrder", id;
    `))
    const componentAExists = psql(`select count(*) from products where id = ${sqlString(tempComponentAId)};`) === '1'
    const componentBExists = psql(`select count(*) from products where id = ${sqlString(tempComponentBId)};`) === '1'

    try {
      psql(`
        insert into warehouses (
          id, code, name, type, "availableForSale", "syncToStore",
          country, "isDefault", "defaultReturnWarehouse", active, "createdAt", "updatedAt"
        ) values (
          ${sqlString(tempWarehouseId)}, ${sqlString(tempWarehouseCode)}, ${sqlString(`WC Bundle Test ${suffix}`)}, 'STANDARD', true, true,
          'GB', true, true, true, now(), now()
        )
        on conflict (id) do update
        set code = excluded.code,
            name = excluded.name,
            "availableForSale" = true,
            "syncToStore" = true,
            "isDefault" = true,
            "defaultReturnWarehouse" = true,
            active = true,
            "updatedAt" = now();
      `)

      psql(`
        insert into products (
          id, sku, name, type, "lifecycleStatus", "salesPriceBase", "salesPriceTaxInclusive",
          "oversellAllowed", "stockUnit", "taxCategory", active, "createdAt", "updatedAt"
        ) values (
          ${sqlString(tempComponentAId)}, ${sqlString(componentASku)}, ${sqlString(`WC Bundle Component A ${suffix}`)}, 'SIMPLE', 'ACTIVE', 10, false,
          true, 'pcs', 'STANDARD', true, now(), now()
        )
        on conflict (id) do update
        set sku = excluded.sku,
            name = excluded.name,
            type = 'SIMPLE',
            "lifecycleStatus" = 'ACTIVE',
            "salesPriceBase" = 10,
            "salesPriceTaxInclusive" = false,
            "oversellAllowed" = true,
            "stockUnit" = 'pcs',
            "taxCategory" = 'STANDARD',
            active = true,
            "updatedAt" = now();
      `)

      psql(`
        insert into products (
          id, sku, name, type, "lifecycleStatus", "salesPriceBase", "salesPriceTaxInclusive",
          "oversellAllowed", "stockUnit", "taxCategory", active, "createdAt", "updatedAt"
        ) values (
          ${sqlString(tempComponentBId)}, ${sqlString(componentBSku)}, ${sqlString(`WC Bundle Component B ${suffix}`)}, 'SIMPLE', 'ACTIVE', 12, false,
          true, 'pcs', 'STANDARD', true, now(), now()
        )
        on conflict (id) do update
        set sku = excluded.sku,
            name = excluded.name,
            type = 'SIMPLE',
            "lifecycleStatus" = 'ACTIVE',
            "salesPriceBase" = 12,
            "salesPriceTaxInclusive" = false,
            "oversellAllowed" = true,
            "stockUnit" = 'pcs',
            "taxCategory" = 'STANDARD',
            active = true,
            "updatedAt" = now();
      `)

      psql(`update warehouses set "syncToStore" = false, "isDefault" = false, "defaultReturnWarehouse" = false;`)
      psql(`
        update warehouses
        set "syncToStore" = true,
            "isDefault" = true,
            "defaultReturnWarehouse" = true,
            active = true,
            "availableForSale" = true,
            "updatedAt" = now()
        where id = ${sqlString(tempWarehouseId)};
      `)

      psql(`
        insert into stock_levels (id, "productId", "warehouseId", quantity, "reservedQty", "updatedAt")
        values
          (${sqlString(`${tempComponentAId}_stock`)}, ${sqlString(tempComponentAId)}, ${sqlString(tempWarehouseId)}, 10, 0, now()),
          (${sqlString(`${tempComponentBId}_stock`)}, ${sqlString(tempComponentBId)}, ${sqlString(tempWarehouseId)}, 5, 0, now())
        on conflict ("productId", "warehouseId") do update
        set quantity = excluded.quantity,
            "reservedQty" = 0,
            "updatedAt" = now();
      `)

      psql(`
        insert into cost_layers (
          id, "productId", "warehouseId", "receivedQty", "remainingQty", "unitCostBase", "receivedAt"
        ) values
          (${sqlString(`${tempComponentAId}_layer`)}, ${sqlString(tempComponentAId)}, ${sqlString(tempWarehouseId)}, 10, 10, 5, now() - interval '10 minutes'),
          (${sqlString(`${tempComponentBId}_layer`)}, ${sqlString(tempComponentBId)}, ${sqlString(tempWarehouseId)}, 5, 5, 7, now() - interval '10 minutes')
        on conflict (id) do update
        set "remainingQty" = excluded."remainingQty",
            "unitCostBase" = excluded."unitCostBase",
            "receivedAt" = excluded."receivedAt";
      `)

      psql(`
        delete from product_components
        where "productId" = ${sqlString(baseProductId)};
      `)
      psql(`
        update products
        set type = 'KIT',
            "parentId" = null,
            "updatedAt" = now()
        where id = ${sqlString(baseProductId)};
      `)
      psql(`
        insert into product_components (id, "productId", "componentId", qty, "sortOrder")
        values
          (${sqlString(`${baseProductId}_component_a_${suffix}`)}, ${sqlString(baseProductId)}, ${sqlString(tempComponentAId)}, 2, 0),
          (${sqlString(`${baseProductId}_component_b_${suffix}`)}, ${sqlString(baseProductId)}, ${sqlString(tempComponentBId)}, 1, 1);
      `)
      psql(`
        insert into settings (key, value, "updatedAt")
        values ('wc_initial_import_completed', 'true', now())
        on conflict (key) do update
        set value = excluded.value,
            "updatedAt" = now();
      `)

      const createdOrder = await wcRequest(settings, '/orders', {
        method: 'POST',
        body: JSON.stringify({
          status: 'processing',
          set_paid: true,
          customer_note: testOrderNote,
          billing: {
            first_name: 'Bundle',
            last_name: 'Refund',
            email: `wc-bundle-${suffix}@example.com`,
            address_1: '1 Test Street',
            city: 'Cambridge',
            postcode: 'CB1 1AA',
            country: 'GB',
          },
          shipping: {
            first_name: 'Bundle',
            last_name: 'Refund',
            address_1: '1 Test Street',
            city: 'Cambridge',
            postcode: 'CB1 1AA',
            country: 'GB',
          },
          line_items: [{ product_id: Number(baseExternalProductId), quantity: 1 }],
        }),
      }) as {
        id: number
        line_items: Array<{ id: number; total: string; total_tax: string }>
      }

      await postSignedWebhook('orders', 'order.created', createdOrder, webhookSecret)

      let orderId = ''
      await expect.poll(() => {
        orderId = psql(`select id from sales_orders where "externalOrderId" = ${createdOrder.id} limit 1;`)
        return orderId
      }, {
        timeout: 120000,
      }).not.toBe('')
      if (!orderId) throw new Error(`WooCommerce order ${createdOrder.id} was not imported`)

      let allocationRows: string[][] = []
      await expect.poll(() => {
        allocationRows = parseRows(psql(`
          select p.sku, oa.qty::float8::text, sl.quantity::float8::text, sl."reservedQty"::float8::text
          from order_allocations oa
          join products p on p.id = oa."productId"
          join stock_levels sl on sl."productId" = oa."productId" and sl."warehouseId" = oa."warehouseId"
          where oa."orderId" = ${sqlString(orderId)}
          order by p.sku asc;
        `))
        return JSON.stringify(allocationRows)
      }, {
        timeout: 120000,
      }).toBe(JSON.stringify([
        [componentASku, '2', '10', '2'],
        [componentBSku, '1', '5', '1'],
      ]))
      expect(allocationRows).toEqual([
        [componentASku, '2', '10', '2'],
        [componentBSku, '1', '5', '1'],
      ])

      await page.goto(`/sales/${orderId}`)
      await expect(page.getByText(baseSku, { exact: true })).toBeVisible({ timeout: 30000 })
      await expect(page.getByText(componentASku, { exact: true })).toBeVisible({ timeout: 30000 })
      await expect(page.getByText(componentBSku, { exact: true })).toBeVisible({ timeout: 30000 })

      await shipOrder(page)
      await expect(page.getByText(/^Shipped$/).first()).toBeVisible({ timeout: 30000 })

      let shipmentRows: string[][] = []
      await expect.poll(() => {
        shipmentRows = parseRows(psql(`
          select p.sku, sum(sl.qty)::float8::text, st.quantity::float8::text, st."reservedQty"::float8::text
          from shipment_lines sl
          join products p on p.id = sl."productId"
          join shipments s on s.id = sl."shipmentId"
          join stock_levels st on st."productId" = sl."productId" and st."warehouseId" = s."warehouseId"
          where s."orderId" = ${sqlString(orderId)}
          group by p.sku, st.quantity, st."reservedQty"
          order by p.sku asc;
        `))
        return JSON.stringify(shipmentRows)
      }, {
        timeout: 120000,
      }).toBe(JSON.stringify([
        [componentASku, '2', '8', '0'],
        [componentBSku, '1', '4', '0'],
      ]))
      expect(shipmentRows).toEqual([
        [componentASku, '2', '8', '0'],
        [componentBSku, '1', '4', '0'],
      ])

      await processPendingXeroSync(page)

      await expect.poll(() => (
        psql(`
          select status
          from accounting_sync_logs
          where connector = 'xero'
            and type = 'SALES_INVOICE'
            and "referenceType" = 'SalesOrder'
            and "referenceId" = ${sqlString(orderId)}
          order by "createdAt" desc
          limit 1;
        `)
      ), {
        timeout: 120000,
      }).toBe('SYNCED')

      const orderDetail = await wcRequest(settings, `/orders/${createdOrder.id}`) as {
        total: string
        line_items: Array<{ id: number; total: string; total_tax: string }>
      }
      const wcLine = orderDetail.line_items[0]
      if (!wcLine) throw new Error(`WooCommerce order ${createdOrder.id} has no line items`)

      const createdRefund = await wcRequest(settings, `/orders/${createdOrder.id}/refunds`, {
        method: 'POST',
        body: JSON.stringify({
          amount: orderDetail.total,
          reason: `Bundle refund ${suffix}`,
          api_refund: false,
          line_items: [
            {
              id: wcLine.id,
              quantity: 1,
              refund_total: wcLine.total,
              refund_tax: [wcLine.total_tax],
            },
          ],
        }),
      }) as { id: number }

      const wcRefund = await wcRequest(settings, `/orders/${createdOrder.id}/refunds/${createdRefund.id}`) as { id: number }
      await postSignedWebhook('refunds', 'refund.created', wcRefund, webhookSecret)

      let refundId = ''
      await expect.poll(() => {
        refundId = psql(`
          select id
          from sales_order_refunds
          where "orderId" = ${sqlString(orderId)}
            and "externalRefundId" = ${createdRefund.id}
          limit 1;
        `)
        return refundId
      }, {
        timeout: 120000,
      }).not.toBe('')
      if (!refundId) throw new Error(`WooCommerce refund ${createdRefund.id} was not imported`)

      const refundSnapshotRows = parseRows(psql(`
        with refund_entries as (
          select
            rl.id as refund_line_id,
            jsonb_array_elements(coalesce(rl."costLayerSnapshot"::jsonb, '[]'::jsonb)) as entry
          from sales_order_refund_lines rl
          where rl."refundId" = ${sqlString(refundId)}
        )
        select
          p.sku,
          sum((refund_entries.entry ->> 'qty')::numeric)::float8::text,
          min(refund_entries.entry ->> 'source'),
          min((refund_entries.entry ->> 'unitCostBase')::numeric)::float8::text
        from refund_entries
        join cost_layers cl on cl.id = refund_entries.entry ->> 'costLayerId'
        join products p on p.id = cl."productId"
        group by p.sku
        order by p.sku asc;
      `))
      expect(refundSnapshotRows).toEqual([
        [componentASku, '2', 'shipment', '5'],
        [componentBSku, '1', 'shipment', '7'],
      ])

      let returnedStockRows: string[][] = []
      await expect.poll(() => {
        returnedStockRows = parseRows(psql(`
          select p.sku, sl.quantity::float8::text, sl."reservedQty"::float8::text
          from stock_levels sl
          join products p on p.id = sl."productId"
          where sl."warehouseId" = ${sqlString(tempWarehouseId)}
            and sl."productId" in (${sqlString(tempComponentAId)}, ${sqlString(tempComponentBId)})
          order by p.sku asc;
        `))
        return JSON.stringify(returnedStockRows)
      }, {
        timeout: 120000,
      }).toBe(JSON.stringify([
        [componentASku, '10', '0'],
        [componentBSku, '5', '0'],
      ]))
      expect(returnedStockRows).toEqual([
        [componentASku, '10', '0'],
        [componentBSku, '5', '0'],
      ])

      let returnedLayerRows: string[][] = []
      await expect.poll(() => {
        returnedLayerRows = parseRows(psql(`
          select p.sku, cl."receivedQty"::float8::text, cl."remainingQty"::float8::text, cl."unitCostBase"::float8::text
          from cost_layers cl
          join products p on p.id = cl."productId"
          where cl."warehouseId" = ${sqlString(tempWarehouseId)}
            and cl."productId" in (${sqlString(tempComponentAId)}, ${sqlString(tempComponentBId)})
            and cl."receivedAt" > now() - interval '10 minutes'
            and cl.id not in (${sqlString(`${tempComponentAId}_layer`)}, ${sqlString(`${tempComponentBId}_layer`)})
          order by p.sku asc, cl."receivedAt" asc;
        `))
        return JSON.stringify(returnedLayerRows)
      }, {
        timeout: 120000,
      }).toBe(JSON.stringify([
        [componentASku, '2', '2', '5'],
        [componentBSku, '1', '1', '7'],
      ]))
      expect(returnedLayerRows).toEqual([
        [componentASku, '2', '2', '5'],
        [componentBSku, '1', '1', '7'],
      ])

      await processPendingXeroSync(page)

      await expect.poll(() => (
        psql(`
          select coalesce(((payload -> 'lines' -> 0 ->> 'debit')::numeric)::float8::text, '')
          from accounting_sync_logs
          where connector = 'xero'
            and type = 'COGS_REVERSAL'
            and "referenceType" = 'SalesOrder'
            and "referenceId" = ${sqlString(orderId)}
          order by "createdAt" desc
          limit 1;
        `)
      ), {
        timeout: 120000,
      }).toBe('17')

      await expect.poll(() => (
        psql(`
          select status
          from accounting_sync_logs
          where connector = 'xero'
            and type = 'CREDIT_NOTE'
            and "referenceType" = 'SalesOrderRefund'
            and "referenceId" = ${sqlString(refundId)}
          order by "createdAt" desc
          limit 1;
        `)
      ), {
        timeout: 120000,
      }).toBe('SYNCED')
    } finally {
      psql(`delete from product_components where "productId" = ${sqlString(baseProductId)};`)
      for (const [id, componentId, qty, sortOrder] of originalComponents) {
        psql(`
          insert into product_components (id, "productId", "componentId", qty, "sortOrder")
          values (${sqlString(id)}, ${sqlString(baseProductId)}, ${sqlString(componentId)}, ${qty}, ${sortOrder})
          on conflict (id) do nothing;
        `)
      }
      psql(`
        update products
        set type = ${sqlString(baseOriginalType)},
            "parentId" = ${baseOriginalParentId ? sqlString(baseOriginalParentId) : 'null'},
            "externalProductId" = ${baseOriginalExternalProductId ? baseOriginalExternalProductId : 'null'},
            "updatedAt" = now()
        where id = ${sqlString(baseProductId)};
      `)
      for (const [warehouseId, syncToStore, isDefault, defaultReturnWarehouse] of warehouseStates) {
        psql(`
          update warehouses
          set "syncToStore" = ${syncToStore === 'true' ? 'true' : 'false'},
              "isDefault" = ${isDefault === 'true' ? 'true' : 'false'},
              "defaultReturnWarehouse" = ${defaultReturnWarehouse === 'true' ? 'true' : 'false'}
          where id = ${sqlString(warehouseId)};
        `)
      }
      psql(`delete from stock_levels where "warehouseId" = ${sqlString(tempWarehouseId)};`)
      psql(`delete from cost_layers where "warehouseId" = ${sqlString(tempWarehouseId)} and "productId" in (${sqlString(tempComponentAId)}, ${sqlString(tempComponentBId)});`)
      if (!componentAExists) {
        psql(`
          update products
          set active = false,
              "updatedAt" = now()
          where id = ${sqlString(tempComponentAId)};
        `)
      }
      if (!componentBExists) {
        psql(`
          update products
          set active = false,
              "updatedAt" = now()
          where id = ${sqlString(tempComponentBId)};
        `)
      }
      if (!tempWarehouseExists) {
        psql(`
          update warehouses
          set active = false,
              "availableForSale" = false,
              "syncToStore" = false,
              "isDefault" = false,
              "defaultReturnWarehouse" = false,
              "updatedAt" = now()
          where id = ${sqlString(tempWarehouseId)};
        `)
      }
      if (baseProductCreated) {
        psql(`
          update products
          set active = false,
              "externalProductId" = null,
              "updatedAt" = now()
          where id = ${sqlString(tempBaseProductId)};
        `)
      }
    }
  })
})
