import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  runMintsoftProductVerify,
  runMintsoftProductVerifyForSkus,
} from '@/lib/connectors/mintsoft/sync/product-sync'
import { runMintsoftReturnsSync } from '@/lib/connectors/mintsoft/sync/returns-sync'
import { runStockSyncForBinding } from '@/lib/connectors/mintsoft/sync/stock-sync'
import { serializeSettingValue } from '@/lib/settings-store'
import { requireE2eAdminRoute } from '@/lib/testing/e2e-route-guard'

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
  barcode?: string | null
}

type SeedWmsProductLink = {
  sku: string
  externalProductId: string
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
  await db.wmsProductLink.deleteMany({ where: { connector: 'mintsoft' } })
  await db.wmsStockSnapshot.deleteMany({ where: { connector: 'mintsoft' } })
  await db.wmsStockDiscrepancy.deleteMany({ where: { connector: 'mintsoft' } })
  await db.wmsReturnsInbox.deleteMany({ where: { connector: 'mintsoft' } })
  await db.wmsInboundReceiptEvent.deleteMany({ where: { connector: 'mintsoft' } })
  await db.wmsAsnLineMap.deleteMany({ where: { asn: { connector: 'mintsoft' } } })
  await db.wmsAsnMap.deleteMany({ where: { connector: 'mintsoft' } })
  await db.wmsSyncJob.deleteMany({ where: { connector: 'mintsoft' } })
  await db.externalWmsBinding.deleteMany({ where: { connector: 'mintsoft' } })
  await db.wmsConnection.deleteMany({ where: { connector: 'mintsoft' } })
}

async function clearProductsBySku(skus: string[]) {
  if (skus.length === 0) return

  const products = await db.product.findMany({
    where: { sku: { in: skus } },
    select: { id: true },
  })
  const productIds = products.map((product) => product.id)

  if (productIds.length === 0) return

  await db.cogsEntry.deleteMany({
    where: {
      OR: [
        { movement: { productId: { in: productIds } } },
        { costLayer: { productId: { in: productIds } } },
      ],
    },
  })
  await db.costLayerSourceLine.deleteMany({
    where: {
      OR: [
        { sourceProductId: { in: productIds } },
        { costLayer: { productId: { in: productIds } } },
      ],
    },
  })
  await db.costLayer.deleteMany({
    where: { productId: { in: productIds } },
  })
  await db.stockMovement.deleteMany({
    where: { productId: { in: productIds } },
  })
  await db.wmsProductLink.deleteMany({
    where: {
      connector: 'mintsoft',
      productId: { in: productIds },
    },
  })
  await db.wmsAsnLineMap.deleteMany({
    where: { productId: { in: productIds } },
  })
  await db.supplierProduct.deleteMany({
    where: { productId: { in: productIds } },
  })
  await db.stockLevel.deleteMany({
    where: {
      productId: { in: productIds },
    },
  })
  await db.product.deleteMany({
    where: { id: { in: productIds } },
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
        barcode: seedProduct.barcode ?? null,
      },
      create: {
        sku: seedProduct.sku,
        name: seedProduct.name,
        barcode: seedProduct.barcode ?? null,
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

async function seedWmsProductLinks(links: SeedWmsProductLink[]) {
  for (const link of links) {
    const sku = link.sku.trim()
    const externalProductId = link.externalProductId.trim()
    if (!sku || !externalProductId) continue

    const product = await db.product.findUnique({
      where: { sku },
      select: { id: true, barcode: true },
    })
    if (!product) continue

    await db.wmsProductLink.upsert({
      where: {
        connector_productId: {
          connector: 'mintsoft',
          productId: product.id,
        },
      },
      create: {
        connector: 'mintsoft',
        productId: product.id,
        externalProductId,
        lastKnownBarcode: product.barcode,
      },
      update: {
        externalProductId,
        lastKnownBarcode: product.barcode,
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
  const session = await requireE2eAdminRoute(request)
  if (session instanceof NextResponse) return session

  if (request.nextUrl.searchParams.get('summary') === '1') {
    const [bindings, jobs, discrepancies, returnsInbox] = await Promise.all([
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
      db.wmsReturnsInbox.findMany({
        where: { connector: 'mintsoft' },
        orderBy: { updatedAt: 'desc' },
        take: 10,
        select: {
          externalReturnId: true,
          reference: true,
          sku: true,
          status: true,
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
      returnsInbox,
    })
  }

  const externalEventId = request.nextUrl.searchParams.get('externalEventId')
  const sku = request.nextUrl.searchParams.get('sku')
  const sourcePoId = request.nextUrl.searchParams.get('sourcePoId')
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
        processingError: true,
      },
    })

    return NextResponse.json({ events })
  }

  if (sku?.trim()) {
    const product = await db.product.findUnique({
      where: { sku: sku.trim() },
      select: {
        id: true,
        sku: true,
        barcode: true,
        wmsProductLinks: {
          where: { connector: 'mintsoft' },
          select: {
            externalProductId: true,
            payloadHash: true,
            lastKnownBarcode: true,
            lastSyncedAt: true,
            lastError: true,
          },
        },
        wmsStockDiscrepancies: {
          where: {
            connector: 'mintsoft',
          },
          orderBy: [{ lastSeenAt: 'desc' }],
          select: {
            category: true,
            status: true,
            imsValue: true,
            wmsValue: true,
            message: true,
          },
        },
      },
    })

    const stockLevels = product
      ? await db.stockLevel.findMany({
          where: { productId: product.id },
          select: {
            quantity: true,
            warehouse: {
              select: {
                code: true,
              },
            },
          },
          orderBy: {
            warehouse: {
              code: 'asc',
            },
          },
        })
      : []

    return NextResponse.json({
      product,
      stockLevels: stockLevels.map((row) => ({
        warehouseCode: row.warehouse.code,
        quantity: Number(row.quantity),
      })),
    })
  }

  if (sourcePoId?.trim()) {
    const asnMaps = await db.wmsAsnMap.findMany({
      where: {
        connector: 'mintsoft',
        sourceType: 'PURCHASE_ORDER',
        sourceId: sourcePoId.trim(),
      },
      orderBy: [{ createdAt: 'desc' }],
      select: {
        externalAsnId: true,
        status: true,
        createdAt: true,
        lines: {
          select: {
            externalAsnLineId: true,
            sourceLineId: true,
            sku: true,
            expectedQty: true,
          },
        },
      },
    })

    return NextResponse.json({
      asnMaps: asnMaps.map((asn) => ({
        externalAsnId: asn.externalAsnId,
        status: asn.status,
        createdAt: asn.createdAt,
        lines: asn.lines.map((line) => ({
          externalAsnLineId: line.externalAsnLineId,
          sourceLineId: line.sourceLineId,
          sku: line.sku,
          expectedQty: Number(line.expectedQty),
        })),
      })),
    })
  }

  return NextResponse.json({ error: 'Unsupported query' }, { status: 400 })
}

export async function POST(request: NextRequest) {
  const session = await requireE2eAdminRoute(request)
  if (session instanceof NextResponse) return session

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
    wmsProductLinks?: SeedWmsProductLink[]
    clearProductSkus?: string[]
    clearWarehouseCodes?: string[]
    clearNotificationsForUserEmail?: string
    runFirstBindingSync?: boolean
    runProductVerify?: boolean
    runProductVerifySkus?: string[]
    runReturnsSync?: boolean
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

  if (Array.isArray(body.wmsProductLinks) && body.wmsProductLinks.length > 0) {
    await seedWmsProductLinks(body.wmsProductLinks)
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

  if (body.runProductVerify) {
    const result = await runMintsoftProductVerify('e2e')
    return NextResponse.json({ success: true, verifyResult: result })
  }

  if (Array.isArray(body.runProductVerifySkus) && body.runProductVerifySkus.length > 0) {
    const result = await runMintsoftProductVerifyForSkus(body.runProductVerifySkus, 'e2e')
    return NextResponse.json({ success: true, verifyResult: result })
  }

  if (body.runReturnsSync) {
    const result = await runMintsoftReturnsSync('e2e')
    return NextResponse.json({ success: true, returnsResult: result })
  }

  return NextResponse.json({ success: true })
}
