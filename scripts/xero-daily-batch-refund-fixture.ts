import 'dotenv/config'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../app/generated/prisma/client.ts'

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! })
const db = new PrismaClient({ adapter })

type SnapshotEntry = {
  costLayerId: string
  qty: number
  unitCostGbp: number
  orderAllocationId?: string
  shipmentLineId?: string
  source?: string
}

function parseSnapshot(value: unknown): SnapshotEntry[] {
  if (!Array.isArray(value)) return []
  const parsed: SnapshotEntry[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const row = entry as Record<string, unknown>
    const costLayerId = String(row.costLayerId ?? '')
    const qty = Number(row.qty ?? 0)
    if (!costLayerId || qty <= 0) continue
    parsed.push({
      costLayerId,
      qty,
      unitCostGbp: Number(row.unitCostGbp ?? 0),
      orderAllocationId: row.orderAllocationId ? String(row.orderAllocationId) : undefined,
      shipmentLineId: row.shipmentLineId ? String(row.shipmentLineId) : undefined,
      source: row.source ? String(row.source) : undefined,
    })
  }
  return parsed
}

function uniqueSuffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

async function upsertSetting(key: string, value: string) {
  await db.setting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  })
}

async function seed() {
  const suffix = uniqueSuffix()
  const now = new Date()

  await Promise.all([
    upsertSetting('xero_sync_enabled', 'true'),
    upsertSetting('xero_daily_batch_enabled', 'true'),
    upsertSetting('xero_sales_account', '200'),
    upsertSetting('xero_shipping_account', '210'),
    upsertSetting('xero_discount_account', '220'),
    upsertSetting('xero_cogs_account', '500'),
    upsertSetting('xero_inventory_account', '630'),
    upsertSetting('xero_allocated_inventory_account', '631'),
    upsertSetting('xero_unearned_revenue_account', '820'),
  ])

  const warehouse = await db.warehouse.upsert({
    where: { code: 'DEFAULT' },
    update: { name: 'Default', availableForSale: true, active: true },
    create: {
      code: 'DEFAULT',
      name: 'Default',
      type: 'STANDARD',
      availableForSale: true,
      syncToStore: false,
      isDefault: true,
      active: true,
    },
  })

  const taxRate = await db.taxRate.create({
    data: {
      name: `E2E VAT ${suffix}`,
      rate: 0.2,
      type: 'VAT',
      usedFor: 'SALES',
      countryCode: 'GB',
      active: true,
      isDefault: false,
      accountingTaxType: 'OUTPUT2',
    },
  })

  const customer = await db.customer.create({
    data: {
      firstName: 'Xero',
      lastName: `Refund ${suffix}`,
      email: `xero-refund-${suffix}@example.com`,
      active: true,
    },
  })

  const product = await db.product.create({
    data: {
      sku: `E2E-XERO-${suffix}`,
      name: `Xero Refund Fixture ${suffix}`,
      type: 'SIMPLE',
      lifecycleStatus: 'ACTIVE',
      salesPriceGbp: 12,
      salesPriceTaxInclusive: true,
      taxCategory: 'STANDARD',
      stockUnit: 'pcs',
      oversellAllowed: true,
      active: true,
    },
  })

  await db.stockLevel.create({
    data: {
      productId: product.id,
      warehouseId: warehouse.id,
      quantity: 4,
      reservedQty: 1,
    },
  })

  const costLayer = await db.costLayer.create({
    data: {
      productId: product.id,
      warehouseId: warehouse.id,
      receivedQty: 5,
      remainingQty: 5,
      unitCostGbp: 4,
      receivedAt: new Date(now.getTime() - 60_000),
      isOpeningStock: true,
    },
  })

  const order = await db.salesOrder.create({
    data: {
      orderNumber: `SO-E2E-XERO-${suffix}`,
      status: 'ALLOCATED',
      currency: 'GBP',
      fxRateToGbp: 1,
      customerId: customer.id,
      customerName: `${customer.firstName} ${customer.lastName}`,
      customerEmail: customer.email,
      billingAddress: { country: 'GB' } as never,
      shippingAddress: { country: 'GB' } as never,
      subtotalForeign: 20,
      shippingForeign: 0,
      taxRateName: taxRate.name,
      taxRatePercent: 0.2,
      taxForeign: 4,
      pricesIncludeVat: true,
      totalForeign: 24,
      subtotalGbp: 20,
      shippingGbp: 0,
      taxGbp: 4,
      totalGbp: 24,
      shipFromWarehouseId: warehouse.id,
      invoiceNumber: `INV-E2E-XERO-${suffix}`,
      invoicedAt: now,
      accountingInvoiceId: `xero-invoice-${suffix}`,
      paidAt: now,
      lines: {
        create: [
          {
            productId: product.id,
            sku: product.sku,
            description: product.name,
            qty: 2,
            unitPriceForeign: 12,
            unitPriceGbp: 12,
            discountAmount: 0,
            taxRateId: taxRate.id,
            taxForeign: 4,
            taxGbp: 4,
            totalForeign: 20,
            totalGbp: 20,
          },
        ],
      },
    },
    include: {
      lines: true,
    },
  })

  const line = order.lines[0]

  const allocation = await db.orderAllocation.create({
    data: {
      orderId: order.id,
      lineId: line.id,
      productId: product.id,
      warehouseId: warehouse.id,
      qty: 2,
    },
  })

  const shipment = await db.shipment.create({
    data: {
      orderId: order.id,
      warehouseId: warehouse.id,
      status: 'SHIPPED',
      shippedAt: now,
      lines: {
        create: [
          {
            lineId: line.id,
            productId: product.id,
            qty: 1,
          },
        ],
      },
    },
    include: {
      lines: true,
    },
  })

  const response = await fetch('http://127.0.0.1:3001/api/cron/xero-daily-batch')
  if (!response.ok) {
    throw new Error(`daily batch request failed: ${response.status} ${await response.text()}`)
  }
  const batchResult = await response.json() as {
    groupA1: number
    groupA2: number
    groupB: number
    errors: string[]
  }
  if (batchResult.errors.length > 0) {
    throw new Error(batchResult.errors.join('; '))
  }

  await db.salesOrder.update({
    where: { id: order.id },
    data: {
      status: 'SHIPPED',
      shippedAt: now,
      trackingNumber: `TRACK-${suffix}`,
    },
  })

  const seededOrder = await db.salesOrder.findUniqueOrThrow({
    where: { id: order.id },
    select: {
      unearnedRevenueAmount: true,
      allocationBatchAmount: true,
      shipments: {
        select: {
          cogsBatchAmount: true,
          revenueRecognizedAmount: true,
        },
      },
    },
  })

  console.log(JSON.stringify({
    orderId: order.id,
    productId: product.id,
    warehouseId: warehouse.id,
    allocationId: allocation.id,
    shipmentLineId: shipment.lines[0].id,
    costLayerId: costLayer.id,
    unearnedRevenueAmount: Number(seededOrder.unearnedRevenueAmount ?? 0),
    allocationBatchAmount: Number(seededOrder.allocationBatchAmount ?? 0),
    shipmentRevenueRecognizedAmount: Number(seededOrder.shipments[0]?.revenueRecognizedAmount ?? 0),
    shipmentCogsBatchAmount: Number(seededOrder.shipments[0]?.cogsBatchAmount ?? 0),
  }))
}

async function inspect(orderId: string, allocationId: string, shipmentLineId: string, costLayerId: string, productId?: string, warehouseId?: string) {
  const finalOrder = await db.salesOrder.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      status: true,
      revenueDeferredDate: true,
      inventoryAllocatedDate: true,
    },
  })

  const allocation = await db.orderAllocation.findUniqueOrThrow({
    where: { id: allocationId },
    select: { costLayerSnapshot: true },
  })

  const shipmentLine = await db.shipmentLine.findUniqueOrThrow({
    where: { id: shipmentLineId },
    select: { costLayerSnapshot: true },
  })

  const refund = await db.salesOrderRefund.findFirstOrThrow({
    where: { orderId },
    select: {
      id: true,
      lines: {
        select: {
          costLayerSnapshot: true,
        },
      },
    },
  })

  const orderLogs = await db.accountingSyncLog.findMany({
    where: {
      referenceId: orderId,
      type: { in: ['COGS_REVERSAL', 'UNEARNED_REV_REVERSAL'] },
    },
    select: {
      type: true,
      payload: true,
    },
    orderBy: { createdAt: 'asc' },
  })

  const refundLog = await db.accountingSyncLog.findFirst({
    where: {
      referenceType: 'SalesOrderRefund',
      referenceId: refund.id,
      type: 'CREDIT_NOTE',
    },
    select: { id: true },
  })

  const replacementLayers = productId && warehouseId
    ? await db.costLayer.findMany({
        where: {
          productId,
          warehouseId,
          id: { not: costLayerId },
        },
        select: {
          id: true,
          receivedQty: true,
          remainingQty: true,
          unitCostGbp: true,
          receivedAt: true,
        },
        orderBy: { receivedAt: 'asc' },
      })
    : []

  console.log(JSON.stringify({
    orderStatus: finalOrder.status,
    revenueDeferredDate: finalOrder.revenueDeferredDate?.toISOString() ?? null,
    inventoryAllocatedDate: finalOrder.inventoryAllocatedDate?.toISOString() ?? null,
    allocationSnapshot: parseSnapshot(allocation.costLayerSnapshot),
    shipmentSnapshot: parseSnapshot(shipmentLine.costLayerSnapshot),
    refundSnapshot: parseSnapshot(refund.lines[0]?.costLayerSnapshot),
    orderLogs,
    refundLogId: refundLog?.id ?? null,
    replacementLayers: replacementLayers.map((layer) => ({
      id: layer.id,
      receivedQty: Number(layer.receivedQty),
      remainingQty: Number(layer.remainingQty),
      unitCostGbp: Number(layer.unitCostGbp),
    })),
    costLayerId,
  }))
}

async function main() {
  const mode = process.argv[2]
  try {
    if (mode === 'seed') {
      await seed()
      return
    }

    if (mode === 'inspect') {
      const [orderId, allocationId, shipmentLineId, costLayerId, productId, warehouseId] = process.argv.slice(3)
      if (!orderId || !allocationId || !shipmentLineId || !costLayerId) {
        throw new Error('inspect mode requires orderId allocationId shipmentLineId costLayerId')
      }
      await inspect(orderId, allocationId, shipmentLineId, costLayerId, productId, warehouseId)
      return
    }

    throw new Error('usage: tsx scripts/xero-daily-batch-refund-fixture.ts <seed|inspect> [...]')
  } finally {
    await db.$disconnect()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
