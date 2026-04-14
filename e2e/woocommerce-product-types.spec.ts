import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'

const wcEnabled = process.env.E2E_WC_ENABLED === 'true'
const databaseUrl = process.env.DATABASE_URL!

const TEMP_WAREHOUSE_ID = 'wc_type_test_wh'
const TEMP_WAREHOUSE_CODE = 'WC-TYPE-TEST'
const TEMP_COMPONENT_ID = 'wc_type_test_component'

function psql(query: string) {
  return execFileSync('psql', [databaseUrl, '-At', '-F', '|', '-c', query], {
    encoding: 'utf8',
  }).trim()
}

function escapeSql(value: string) {
  return value.replace(/'/g, "''")
}

function parseRows(raw: string) {
  if (!raw) return []
  return raw.split('\n').filter(Boolean).map((line) => line.split('|'))
}

async function openWooCommerceConnector(page: Page) {
  await page.goto('/sync?connector=woocommerce')
  await expect(page.getByRole('heading', { name: 'WooCommerce Connector' })).toBeVisible()
}

async function ensureWcStockSyncEnabled(page: Page) {
  await page.getByRole('button', { name: 'Products' }).click()

  const stockCheckbox = page.locator('input[type="checkbox"]').nth(1)
  let changed = false

  if (!(await stockCheckbox.isChecked())) {
    await stockCheckbox.check()
    changed = true
  }

  if (changed) {
    await page.getByRole('button', { name: /save settings/i }).click()
    await expect(page.getByText(/saved/i)).toBeVisible()
  }
}

async function runStockPush(page: Page) {
  const startedAt = psql(`select now()::text;`)
  await openWooCommerceConnector(page)
  await page.getByRole('button', { name: 'Products' }).click()
  await page.getByRole('button', { name: /push stock now/i }).click()

  const syncResult = page.getByTestId('sync-result')
  await expect.poll(() => (
    psql(`select coalesce(value, '') from settings where key = 'last_wc_stock_sync_attempt_at';`)
  ), {
    timeout: 120000,
  }).not.toEqual('')

  await expect(syncResult).toBeVisible({ timeout: 120000 })
  return {
    startedAt,
    text: (await syncResult.textContent())?.trim() ?? '',
    status: (await syncResult.getAttribute('data-sync-status')) ?? '',
  }
}

type CaseResult = {
  case: string
  supported: boolean
  status: string
  text: string
  detail: string
}

test.describe('@external @wc WooCommerce stock sync by product type', () => {
  test.skip(!wcEnabled, 'Set E2E_WC_ENABLED=true to run live WooCommerce integration tests.')

  test('checks simple, variant, kit virtual stock, and BOM stock push support', async ({ page }) => {
    test.setTimeout(240000)

    const baseRow = psql(`
      select id, sku, type, coalesce("parentId", ''), coalesce("wcProductId"::text, '')
      from products
      where type = 'SIMPLE'
        and active = true
        and "wcProductId" is not null
        and not exists (
          select 1 from product_components pc where pc."productId" = products.id
        )
      order by "updatedAt" desc
      limit 1;
    `)
    const [baseProductId, , baseOriginalType, baseOriginalParentId, baseWcProductId] = baseRow.split('|')
    if (!baseProductId || !baseWcProductId) throw new Error('No mapped SIMPLE Woo product found for product-type checks')

    const variantRow = psql(`
      select v.id, v.sku, coalesce(v."wcProductId"::text, '')
      from products v
      join products p on p.id = v."parentId"
      where v.type = 'VARIANT'
        and v.active = true
        and p.type = 'VARIABLE'
        and p.active = true
      order by v."updatedAt" desc
      limit 1;
    `)
    const [variantProductId, , variantOriginalWcProductId] = variantRow.split('|')
    if (!variantProductId) throw new Error('No local VARIANT product found for product-type checks')

    const warehouseFlags = parseRows(psql(`select id, "syncToWoocommerce"::text from warehouses order by id;`))
    const tempWarehouseExists = psql(`select count(*) from warehouses where id = '${TEMP_WAREHOUSE_ID}';`) === '1'
    const baseOriginalComponents = parseRows(psql(`
      select id, "componentId", qty::text, "sortOrder"::text
      from product_components
      where "productId" = '${baseProductId}'
      order by "sortOrder", id;
    `))
    const tempComponentExists = psql(`select count(*) from products where id = '${TEMP_COMPONENT_ID}';`) === '1'

    const results: CaseResult[] = []

    psql(`
      insert into warehouses (
        id, code, name, type, "availableForSale", "syncToWoocommerce",
        country, "isDefault", "defaultReturnWarehouse", active, "createdAt", "updatedAt"
      ) values (
        '${TEMP_WAREHOUSE_ID}', '${TEMP_WAREHOUSE_CODE}', 'Woo Type Test', 'STANDARD', true, true,
        'GB', false, false, true, now(), now()
      )
      on conflict (id) do update
      set code = excluded.code,
          name = excluded.name,
          "availableForSale" = true,
          "syncToWoocommerce" = true,
          active = true,
          "updatedAt" = now();
    `)

    psql(`
      insert into products (
        id, sku, name, type, active, "salesPriceTaxInclusive", "oversellAllowed",
        "stockUnit", "taxCategory", "createdAt", "updatedAt"
      ) values (
        '${TEMP_COMPONENT_ID}', '', 'Woo Type Test Component', 'SIMPLE', true, false, true,
        'pcs', 'STANDARD', now(), now()
      )
      on conflict (id) do update
      set sku = '',
          name = 'Woo Type Test Component',
          type = 'SIMPLE',
          active = true,
          "updatedAt" = now();
    `)

    psql(`update warehouses set "syncToWoocommerce" = false;`)
    psql(`update warehouses set "syncToWoocommerce" = true where id = '${TEMP_WAREHOUSE_ID}';`)

    try {
      await openWooCommerceConnector(page)
      await ensureWcStockSyncEnabled(page)

      const resetState = () => {
        psql(`delete from stock_levels where "warehouseId" = '${TEMP_WAREHOUSE_ID}';`)
        psql(`delete from product_components where "productId" = '${baseProductId}';`)
        psql(`
          update products
          set type = '${baseOriginalType}',
              "parentId" = ${baseOriginalParentId ? `'${baseOriginalParentId}'` : 'null'},
              "updatedAt" = now()
          where id = '${baseProductId}';
        `)
        psql(`
          update products
          set "wcProductId" = ${variantOriginalWcProductId ? variantOriginalWcProductId : 'null'},
              "updatedAt" = now()
          where id = '${variantProductId}';
        `)
      }

      resetState()
      psql(`
        insert into stock_levels (id, "productId", "warehouseId", quantity, "reservedQty", "updatedAt")
        values ('${baseProductId}_simple_stock', '${baseProductId}', '${TEMP_WAREHOUSE_ID}', 7, 0, now())
        on conflict ("productId", "warehouseId") do update
        set quantity = 7, "reservedQty" = 0, "updatedAt" = now();
      `)
      const simpleRun = await runStockPush(page)
      const simpleLogId = psql(`
        select id from wc_sync_logs
        where "entityType" = 'StockLevel'
          and direction = 'TO_WC'
          and status = 'SYNCED'
          and "wcId" = ${baseWcProductId}
          and "createdAt" > '${escapeSql(simpleRun.startedAt)}'::timestamp
        order by "createdAt" desc
        limit 1;
      `)
      results.push({
        case: 'SIMPLE',
        supported: simpleLogId !== '',
        status: simpleRun.status,
        text: simpleRun.text,
        detail: simpleLogId ? `created StockLevel log ${simpleLogId}` : 'no fresh StockLevel log',
      })

      resetState()
      psql(`
        update products
        set "wcProductId" = null,
            "updatedAt" = now()
        where id = '${variantProductId}';
      `)
      psql(`
        insert into stock_levels (id, "productId", "warehouseId", quantity, "reservedQty", "updatedAt")
        values ('${variantProductId}_variant_stock', '${variantProductId}', '${TEMP_WAREHOUSE_ID}', 4, 0, now())
        on conflict ("productId", "warehouseId") do update
        set quantity = 4, "reservedQty" = 0, "updatedAt" = now();
      `)
      const variantRun = await runStockPush(page)
      const variantWcProductId = psql(`
        select coalesce("wcProductId"::text, '')
        from products
        where id = '${variantProductId}';
      `)
      const variantLogId = variantWcProductId
        ? psql(`
          select id from wc_sync_logs
          where "entityType" = 'StockLevel'
            and direction = 'TO_WC'
            and status = 'SYNCED'
            and "wcId" = ${variantWcProductId}
            and "createdAt" > '${escapeSql(variantRun.startedAt)}'::timestamp
          order by "createdAt" desc
          limit 1;
        `)
        : ''
      results.push({
        case: 'VARIANT',
        supported: variantLogId !== '',
        status: variantRun.status,
        text: variantRun.text,
        detail: variantLogId
          ? `created StockLevel log ${variantLogId} via wcProductId ${variantWcProductId}`
          : (variantWcProductId ? `resolved wcProductId ${variantWcProductId} but no fresh StockLevel log` : 'wcProductId stayed null after push'),
      })

      resetState()
      psql(`
        update products
        set type = 'KIT',
            "parentId" = null,
            "updatedAt" = now()
        where id = '${baseProductId}';
      `)
      psql(`
        insert into product_components (id, "productId", "componentId", qty, "sortOrder")
        values ('${baseProductId}_kit_component', '${baseProductId}', '${TEMP_COMPONENT_ID}', 1, 0)
        on conflict ("productId", "componentId") do update
        set qty = 1, "sortOrder" = 0;
      `)
      psql(`
        insert into stock_levels (id, "productId", "warehouseId", quantity, "reservedQty", "updatedAt")
        values ('${TEMP_COMPONENT_ID}_kit_stock', '${TEMP_COMPONENT_ID}', '${TEMP_WAREHOUSE_ID}', 5, 0, now())
        on conflict ("productId", "warehouseId") do update
        set quantity = 5, "reservedQty" = 0, "updatedAt" = now();
      `)
      const kitRun = await runStockPush(page)
      const kitLogId = psql(`
        select id from wc_sync_logs
        where "entityType" = 'StockLevel'
          and direction = 'TO_WC'
          and status = 'SYNCED'
          and "wcId" = ${baseWcProductId}
          and "createdAt" > '${escapeSql(kitRun.startedAt)}'::timestamp
        order by "createdAt" desc
        limit 1;
      `)
      results.push({
        case: 'KIT',
        supported: kitLogId !== '',
        status: kitRun.status,
        text: kitRun.text,
        detail: kitLogId ? `created StockLevel log ${kitLogId}` : 'no fresh StockLevel log from virtual kit stock',
      })

      resetState()
      psql(`
        update products
        set type = 'BOM',
            "parentId" = null,
            "updatedAt" = now()
        where id = '${baseProductId}';
      `)
      psql(`
        insert into stock_levels (id, "productId", "warehouseId", quantity, "reservedQty", "updatedAt")
        values ('${baseProductId}_bom_stock', '${baseProductId}', '${TEMP_WAREHOUSE_ID}', 3, 0, now())
        on conflict ("productId", "warehouseId") do update
        set quantity = 3, "reservedQty" = 0, "updatedAt" = now();
      `)
      const bomRun = await runStockPush(page)
      const bomLogId = psql(`
        select id from wc_sync_logs
        where "entityType" = 'StockLevel'
          and direction = 'TO_WC'
          and status = 'SYNCED'
          and "wcId" = ${baseWcProductId}
          and "createdAt" > '${escapeSql(bomRun.startedAt)}'::timestamp
        order by "createdAt" desc
        limit 1;
      `)
      results.push({
        case: 'BOM',
        supported: bomLogId !== '',
        status: bomRun.status,
        text: bomRun.text,
        detail: bomLogId ? `created StockLevel log ${bomLogId}` : 'no fresh StockLevel log',
      })

      console.log(`WC_PRODUCT_TYPE_RESULTS=${JSON.stringify(results)}`)

      expect(results.find((r) => r.case === 'SIMPLE')?.supported).toBe(true)
      expect(results.find((r) => r.case === 'VARIANT')?.supported).toBe(true)
      expect(results.find((r) => r.case === 'KIT')?.supported).toBe(true)
      expect(results.find((r) => r.case === 'BOM')?.supported).toBe(true)
    } finally {
      psql(`delete from stock_levels where "warehouseId" = '${TEMP_WAREHOUSE_ID}';`)
      psql(`delete from product_components where "productId" = '${baseProductId}';`)
      for (const row of baseOriginalComponents) {
        const [id, componentId, qty, sortOrder] = row
        psql(`
          insert into product_components (id, "productId", "componentId", qty, "sortOrder")
          values ('${id}', '${baseProductId}', '${componentId}', ${qty}, ${sortOrder})
          on conflict (id) do nothing;
        `)
      }
      psql(`
        update products
        set type = '${baseOriginalType}',
            "parentId" = ${baseOriginalParentId ? `'${baseOriginalParentId}'` : 'null'},
            "updatedAt" = now()
        where id = '${baseProductId}';
      `)
      psql(`
        update products
        set "wcProductId" = ${variantOriginalWcProductId ? variantOriginalWcProductId : 'null'},
            "updatedAt" = now()
        where id = '${variantProductId}';
      `)
      for (const [warehouseId, syncFlag] of warehouseFlags) {
        psql(`
          update warehouses
          set "syncToWoocommerce" = ${syncFlag === 'true' ? 'true' : 'false'}
          where id = '${warehouseId}';
        `)
      }
      if (!tempComponentExists) {
        psql(`delete from products where id = '${TEMP_COMPONENT_ID}';`)
      }
      if (!tempWarehouseExists) {
        psql(`delete from warehouses where id = '${TEMP_WAREHOUSE_ID}';`)
      }
    }
  })
})
