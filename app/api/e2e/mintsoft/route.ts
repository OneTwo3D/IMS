import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { runStockSyncForBinding } from '@/lib/connectors/mintsoft/sync/stock-sync'
import { serializeSettingValue } from '@/lib/settings-store'
import { getE2eRouteAccessError } from '@/lib/testing/e2e-route-guard'

const E2E_MINTSOFT_STATE_KEY = 'e2e_mintsoft_state'
const PLUGIN_MINTSOFT_ENABLED_KEY = 'plugin_mintsoft_enabled'
const MINTSOFT_API_KEY = 'mintsoft_api_key'
const MINTSOFT_PASSWORD = 'mintsoft_password'
const MINTSOFT_USERNAME = 'mintsoft_username'
const MINTSOFT_WEBHOOK_SECRET = 'mintsoft_webhook_secret'

type SeedProduct = {
  sku: string
  name: string
  warehouseCode?: string
  quantity: number
}

type SeedWarehouse = {
  code: string
  name?: string
}

async function resetMintsoftPersistence() {
  const jobs = await db.wmsSyncJob.findMany({
    where: { connector: 'mintsoft' },
    select: { id: true },
  })
  const jobIds = jobs.map((job) => job.id)

  if (jobIds.length > 0) {
    await db.wmsSyncLog.deleteMany({
      where: { jobId: { in: jobIds } },
    })
  }

  await db.notificationReadReceipt.deleteMany({
    where: {
      notification: {
        title: 'Mintsoft stock discrepancies detected',
      },
    },
  })
  await db.notification.deleteMany({
    where: {
      title: 'Mintsoft stock discrepancies detected',
    },
  })
  await db.wmsStockSnapshot.deleteMany({ where: { connector: 'mintsoft' } })
  await db.wmsStockDiscrepancy.deleteMany({ where: { connector: 'mintsoft' } })
  await db.wmsInboundReceiptEvent.deleteMany({ where: { connector: 'mintsoft' } })
  await db.wmsSyncJob.deleteMany({ where: { connector: 'mintsoft' } })
  await db.externalWmsBinding.deleteMany({ where: { connector: 'mintsoft' } })
  await db.wmsConnection.deleteMany({ where: { connector: 'mintsoft' } })
}

async function clearProductsBySku(skus: string[]) {
  if (skus.length === 0) return

  await db.stockLevel.deleteMany({
    where: {
      product: {
        sku: { in: skus },
      },
    },
  })
  await db.product.deleteMany({
    where: { sku: { in: skus } },
  })
}

async function clearWarehousesByCode(codes: string[]) {
  if (codes.length === 0) return

  await db.warehouse.deleteMany({
    where: {
      code: { in: codes },
    },
  })
}

async function clearNotificationsForUserEmail(userEmail: string) {
  const user = await db.user.findUnique({
    where: { email: userEmail },
    select: { id: true },
  })
  if (!user) return

  await db.notificationReadReceipt.deleteMany({ where: { userId: user.id } })
  await db.notification.deleteMany({ where: { OR: [{ userId: user.id }, { userId: null }] } })
}

async function seedProducts(products: SeedProduct[]) {
  for (const seedProduct of products) {
    const warehouseCode = seedProduct.warehouseCode?.trim() || 'DEFAULT'
    const warehouse = await db.warehouse.upsert({
      where: { code: warehouseCode },
      update: {},
      create: {
        code: warehouseCode,
        name: warehouseCode,
      },
      select: { id: true },
    })

    const product = await db.product.upsert({
      where: { sku: seedProduct.sku },
      update: {
        name: seedProduct.name,
      },
      create: {
        sku: seedProduct.sku,
        name: seedProduct.name,
      },
      select: { id: true },
    })

    await db.stockLevel.upsert({
      where: {
        productId_warehouseId: {
          productId: product.id,
          warehouseId: warehouse.id,
        },
      },
      update: {
        quantity: seedProduct.quantity,
      },
      create: {
        productId: product.id,
        warehouseId: warehouse.id,
        quantity: seedProduct.quantity,
      },
    })
  }
}

async function seedWarehouses(warehouses: SeedWarehouse[]) {
  for (const warehouse of warehouses) {
    const code = warehouse.code.trim()
    if (!code) continue

    await db.warehouse.upsert({
      where: { code },
      update: {
        name: warehouse.name?.trim() || code,
        active: true,
      },
      create: {
        code,
        name: warehouse.name?.trim() || code,
      },
    })
  }
}

export async function GET(request: NextRequest) {
  const authError = getE2eRouteAccessError(request)
  if (authError) return authError

  if (request.nextUrl.searchParams.get('summary') === '1') {
    const [bindings, jobs, discrepancies] = await Promise.all([
      db.externalWmsBinding.findMany({
        where: { connector: 'mintsoft' },
        select: {
          id: true,
          externalWarehouseId: true,
          warehouse: {
            select: { code: true },
          },
        },
        orderBy: {
          warehouse: {
            code: 'asc',
          },
        },
      }),
      db.wmsSyncJob.findMany({
        where: { connector: 'mintsoft' },
        orderBy: { startedAt: 'desc' },
        take: 5,
        select: {
          id: true,
          status: true,
          warehouse: {
            select: { code: true },
          },
        },
      }),
      db.wmsStockDiscrepancy.findMany({
        where: {
          connector: 'mintsoft',
          status: 'OPEN',
        },
        orderBy: { lastSeenAt: 'desc' },
        take: 10,
        select: {
          sku: true,
          category: true,
        },
      }),
    ])

    return NextResponse.json({
      bindings: bindings.map((binding) => ({
        id: binding.id,
        warehouseCode: binding.warehouse.code,
        externalWarehouseId: binding.externalWarehouseId,
      })),
      jobs: jobs.map((job) => ({
        id: job.id,
        status: job.status,
        warehouseCode: job.warehouse?.code ?? null,
      })),
      discrepancies,
    })
  }

  const externalEventId = request.nextUrl.searchParams.get('externalEventId')
  if (externalEventId?.trim()) {
    const events = await db.wmsInboundReceiptEvent.findMany({
      where: {
        connector: 'mintsoft',
        externalEventId: externalEventId.trim(),
      },
      select: {
        externalEventId: true,
        externalAsnId: true,
        processedAt: true,
      },
    })

    return NextResponse.json({ events })
  }

  return NextResponse.json({ error: 'Unsupported query' }, { status: 400 })
}

export async function POST(request: NextRequest) {
  const authError = getE2eRouteAccessError(request)
  if (authError) return authError

  const body = await request.json() as {
    reset?: boolean
    pluginEnabled?: boolean
    apiKey?: string | null
    username?: string | null
    password?: string | null
    webhookSecret?: string | null
    fakeState?: Record<string, unknown> | null
    warehouses?: SeedWarehouse[]
    products?: SeedProduct[]
    clearProductSkus?: string[]
    clearWarehouseCodes?: string[]
    clearNotificationsForUserEmail?: string
    runFirstBindingSync?: boolean
  }

  if (body.reset) {
    await resetMintsoftPersistence()
  }

  if (body.clearNotificationsForUserEmail?.trim()) {
    await clearNotificationsForUserEmail(body.clearNotificationsForUserEmail.trim())
  }

  if (Array.isArray(body.clearProductSkus) && body.clearProductSkus.length > 0) {
    await clearProductsBySku(body.clearProductSkus)
  }

  if (Array.isArray(body.clearWarehouseCodes) && body.clearWarehouseCodes.length > 0) {
    await clearWarehousesByCode(body.clearWarehouseCodes)
  }

  if (typeof body.pluginEnabled === 'boolean') {
    await db.setting.upsert({
      where: { key: PLUGIN_MINTSOFT_ENABLED_KEY },
      create: { key: PLUGIN_MINTSOFT_ENABLED_KEY, value: String(body.pluginEnabled) },
      update: { value: String(body.pluginEnabled) },
    })
  }

  if (typeof body.apiKey === 'string') {
    await db.setting.upsert({
      where: { key: MINTSOFT_API_KEY },
      create: { key: MINTSOFT_API_KEY, value: serializeSettingValue(MINTSOFT_API_KEY, body.apiKey) },
      update: { value: serializeSettingValue(MINTSOFT_API_KEY, body.apiKey) },
    })
  }

  if (body.apiKey === null) {
    await db.setting.deleteMany({ where: { key: MINTSOFT_API_KEY } })
  }

  if (typeof body.username === 'string') {
    await db.setting.upsert({
      where: { key: MINTSOFT_USERNAME },
      create: { key: MINTSOFT_USERNAME, value: serializeSettingValue(MINTSOFT_USERNAME, body.username) },
      update: { value: serializeSettingValue(MINTSOFT_USERNAME, body.username) },
    })
  }

  if (body.username === null) {
    await db.setting.deleteMany({ where: { key: MINTSOFT_USERNAME } })
  }

  if (typeof body.password === 'string') {
    await db.setting.upsert({
      where: { key: MINTSOFT_PASSWORD },
      create: { key: MINTSOFT_PASSWORD, value: serializeSettingValue(MINTSOFT_PASSWORD, body.password) },
      update: { value: serializeSettingValue(MINTSOFT_PASSWORD, body.password) },
    })
  }

  if (body.password === null) {
    await db.setting.deleteMany({ where: { key: MINTSOFT_PASSWORD } })
  }

  if (typeof body.webhookSecret === 'string') {
    await db.setting.upsert({
      where: { key: MINTSOFT_WEBHOOK_SECRET },
      create: {
        key: MINTSOFT_WEBHOOK_SECRET,
        value: serializeSettingValue(MINTSOFT_WEBHOOK_SECRET, body.webhookSecret),
      },
      update: {
        value: serializeSettingValue(MINTSOFT_WEBHOOK_SECRET, body.webhookSecret),
      },
    })
  }

  if (body.webhookSecret === null) {
    await db.setting.deleteMany({ where: { key: MINTSOFT_WEBHOOK_SECRET } })
  }

  if (body.fakeState) {
    await db.setting.upsert({
      where: { key: E2E_MINTSOFT_STATE_KEY },
      create: {
        key: E2E_MINTSOFT_STATE_KEY,
        value: JSON.stringify(body.fakeState),
      },
      update: {
        value: JSON.stringify(body.fakeState),
      },
    })
  }

  if (body.fakeState === null) {
    await db.setting.deleteMany({ where: { key: E2E_MINTSOFT_STATE_KEY } })
  }

  if (Array.isArray(body.warehouses) && body.warehouses.length > 0) {
    await seedWarehouses(body.warehouses)
  }

  if (Array.isArray(body.products) && body.products.length > 0) {
    await seedProducts(body.products)
  }

  if (body.runFirstBindingSync) {
    const binding = await db.externalWmsBinding.findFirst({
      where: { connector: 'mintsoft' },
      orderBy: {
        warehouse: {
          code: 'asc',
        },
      },
      select: { id: true },
    })

    if (!binding) {
      return NextResponse.json({ error: 'No Mintsoft binding found' }, { status: 404 })
    }

    const result = await runStockSyncForBinding(binding.id, 'e2e')
    return NextResponse.json({ success: true, syncResult: result })
  }

  return NextResponse.json({ success: true })
}
