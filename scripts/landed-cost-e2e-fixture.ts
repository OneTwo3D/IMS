import 'dotenv/config'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../app/generated/prisma/client.ts'

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! })
const db = new PrismaClient({ adapter })

type Scenario = 'delivered' | 'shipped' | 'shipped-returned' | 'delivered-invoiced-mixed-costs'

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

async function seedAccountingSettings() {
  await Promise.all([
    upsertSetting('plugin_xero_enabled', 'true'),
    upsertSetting('xero_sync_enabled', 'true'),
    upsertSetting('xero_sync_purchase_invoice', 'submitted'),
    upsertSetting('xero_sync_cogs_journal', 'submitted'),
    upsertSetting('xero_sync_cogs_reversal', 'submitted'),
    upsertSetting('xero_sales_account', '200'),
    upsertSetting('xero_shipping_account', '210'),
    upsertSetting('xero_discount_account', '220'),
    upsertSetting('xero_cogs_account', '500'),
    upsertSetting('xero_inventory_account', '630'),
    upsertSetting('xero_allocated_inventory_account', '631'),
    upsertSetting('xero_unearned_revenue_account', '820'),
    upsertSetting('xero_transit_account', '640'),
  ])
}

async function ensureCurrency(code: string, name: string, symbol: string, symbolPosition: 'PREFIX' | 'POSTFIX') {
  return db.currency.upsert({
    where: { code },
    update: { name, symbol, symbolPosition, usedFor: 'BOTH', active: true },
    create: { code, name, symbol, symbolPosition, usedFor: 'BOTH', active: true },
  })
}

async function ensureBaseOrganisation() {
  const updated = await db.organisation.updateMany({
    data: { baseCurrency: 'GBP' },
  })
  if (updated.count === 0) {
    await db.organisation.create({
      data: {
        name: 'One Two Inventory E2E',
        country: 'GB',
        baseCurrency: 'GBP',
      },
    })
  }
}

async function ensureDefaultWarehouse() {
  return db.warehouse.upsert({
    where: { code: 'DEFAULT' },
    update: {
      name: 'Default',
      type: 'STANDARD',
      availableForSale: true,
      syncToStore: false,
      isDefault: true,
      defaultReturnWarehouse: true,
      active: true,
    },
    create: {
      code: 'DEFAULT',
      name: 'Default',
      type: 'STANDARD',
      availableForSale: true,
      syncToStore: false,
      isDefault: true,
      defaultReturnWarehouse: true,
      active: true,
    },
  })
}

async function seedForeignInvoiceFxMismatch() {
  const suffix = uniqueSuffix()
  const now = new Date()

  await seedAccountingSettings()
  await ensureBaseOrganisation()
  await Promise.all([
    ensureCurrency('GBP', 'British Pound Sterling', 'GBP', 'PREFIX'),
    ensureCurrency('EUR', 'Euro', 'EUR', 'POSTFIX'),
  ])
  await db.fxRate.create({
    data: {
      fromCurrency: 'GBP',
      toCurrency: 'EUR',
      rate: 1.5,
      fetchedAt: new Date(now.getTime() - 86_400_000),
      source: 'manual',
      manualOverride: true,
    },
  })

  const warehouse = await ensureDefaultWarehouse()
  const supplier = await db.supplier.create({
    data: {
      name: `Foreign FX Supplier ${suffix}`,
      currency: 'EUR',
      active: true,
    },
  })
  const product = await db.product.create({
    data: {
      sku: `E2E-FX-PO-${suffix}`,
      name: `FX PO Product ${suffix}`,
      type: 'SIMPLE',
      lifecycleStatus: 'ACTIVE',
      salesPriceBase: 20,
      salesPriceTaxInclusive: false,
      taxCategory: 'STANDARD',
      stockUnit: 'pcs',
      oversellAllowed: false,
      active: true,
    },
  })

  const po = await db.purchaseOrder.create({
    data: {
      reference: `PO-FX-${suffix}`,
      type: 'GOODS',
      supplierId: supplier.id,
      status: 'RECEIVED',
      currency: 'EUR',
      fxRateToBase: 1.25,
      subtotalForeign: 12.5,
      subtotalBase: 10,
      taxForeign: 0,
      taxBase: 0,
      totalForeign: 12.5,
      totalBase: 10,
      destinationWarehouseId: warehouse.id,
      receivedAt: now,
      lines: {
        create: [
          {
            productId: product.id,
            description: product.name,
            qty: 1,
            unitCostForeign: 12.5,
            unitCostBase: 10,
            totalForeign: 12.5,
            totalBase: 10,
            landedUnitCostBase: 10,
            qtyReceived: 1,
            qtyReturned: 0,
            sortOrder: 0,
          },
        ],
      },
    },
    include: {
      lines: true,
    },
  })

  const poLine = po.lines[0]
  const costLayer = await db.costLayer.create({
    data: {
      productId: product.id,
      warehouseId: warehouse.id,
      receivedQty: 1,
      remainingQty: 1,
      unitCostBase: 10,
      poLineId: poLine.id,
      isOpeningStock: false,
    },
  })
  await db.stockLevel.create({
    data: {
      productId: product.id,
      warehouseId: warehouse.id,
      quantity: 1,
      reservedQty: 0,
    },
  })

  console.log(JSON.stringify({
    scenario: 'foreign-invoice-fx-mismatch',
    goodsPoId: po.id,
    poLineId: poLine.id,
    costLayerId: costLayer.id,
    poFxRateToBase: 1.25,
    invoiceDateFxRateToBase: 1.5,
  }))
}

async function inspectForeignInvoiceFxMismatch(poId: string, poLineId: string, costLayerId: string) {
  const [invoice, invoiceLine, costLayer, syncLog] = await Promise.all([
    db.purchaseInvoice.findFirst({
      where: { poId },
      orderBy: { createdAt: 'desc' },
      select: { fxRateToBase: true, totalForeign: true, totalBase: true },
    }),
    db.purchaseInvoiceLine.findFirst({
      where: { poLineId, invoice: { poId } },
      orderBy: { id: 'desc' },
      select: { totalForeign: true, totalBase: true },
    }),
    db.costLayer.findUnique({
      where: { id: costLayerId },
      select: { unitCostBase: true },
    }),
    db.accountingSyncLog.findFirst({
      where: {
        connector: 'xero',
        type: 'PURCHASE_INVOICE',
        referenceType: 'PurchaseOrder',
        referenceId: poId,
      },
      orderBy: { createdAt: 'desc' },
      select: { payload: true },
    }),
  ])

  const payload = syncLog?.payload as { currencyRateToBase?: number } | null | undefined
  console.log(JSON.stringify({
    invoiceFxRateToBase: invoice ? Number(invoice.fxRateToBase) : null,
    invoiceTotalForeign: invoice ? Number(invoice.totalForeign) : null,
    invoiceTotalBase: invoice ? Number(invoice.totalBase) : null,
    invoiceLineTotalForeign: invoiceLine ? Number(invoiceLine.totalForeign) : null,
    invoiceLineTotalBase: invoiceLine ? Number(invoiceLine.totalBase) : null,
    costLayerUnitCostBase: costLayer ? Number(costLayer.unitCostBase) : null,
    accountingCurrencyRateToBase: payload?.currencyRateToBase ?? null,
  }))
}

async function ensureSupplier(name: string, suffix: string) {
  return db.supplier.create({
    data: {
      name: `${name} ${suffix}`,
      currency: 'GBP',
      active: true,
    },
  })
}

async function seedScenario(scenario: Scenario) {
  const suffix = uniqueSuffix()
  const now = new Date()

  await seedAccountingSettings()
  const warehouse = await ensureDefaultWarehouse()
  const supplier = await ensureSupplier('Landed Cost Supplier', suffix)
  const customer = await db.customer.create({
    data: {
      firstName: 'Landed',
      lastName: `Cost ${suffix}`,
      email: `landed-cost-${suffix}@example.com`,
      active: true,
    },
  })
  const product = await db.product.create({
    data: {
      sku: `E2E-LANDED-${suffix}`,
      name: `Landed Cost Product ${suffix}`,
      type: 'SIMPLE',
      lifecycleStatus: 'ACTIVE',
      salesPriceBase: 10,
      salesPriceTaxInclusive: false,
      taxCategory: 'STANDARD',
      stockUnit: 'pcs',
      oversellAllowed: false,
      active: true,
    },
  })

  const goodsPo = await db.purchaseOrder.create({
    data: {
      reference: `PO-GOODS-${suffix}`,
      type: 'GOODS',
      supplierId: supplier.id,
      status: scenario === 'delivered-invoiced-mixed-costs' ? 'INVOICED' : 'RECEIVED',
      currency: 'GBP',
      fxRateToBase: 1,
      subtotalForeign: 4,
      subtotalBase: 4,
      taxForeign: 0,
      taxBase: 0,
      totalForeign: scenario === 'delivered-invoiced-mixed-costs' ? 5 : 4,
      totalBase: scenario === 'delivered-invoiced-mixed-costs' ? 5 : 4,
      directFreightForeign: scenario === 'delivered-invoiced-mixed-costs' ? 1 : 0,
      directFreightBase: scenario === 'delivered-invoiced-mixed-costs' ? 1 : 0,
      destinationWarehouseId: warehouse.id,
      receivedAt: now,
      freightCostLines: scenario === 'delivered-invoiced-mixed-costs'
        ? {
            create: [
              {
                description: 'Handling',
                amountForeign: 1,
                amountBase: 1,
                vatable: false,
                distributionMethod: 'BY_VALUE',
                sortOrder: 0,
              },
            ],
          }
        : undefined,
      lines: {
        create: [
          {
            productId: product.id,
            description: product.name,
            qty: 1,
            unitCostForeign: 4,
            unitCostBase: 4,
            totalForeign: 4,
            totalBase: 4,
            landedUnitCostBase: scenario === 'delivered-invoiced-mixed-costs' ? 6 : 5,
            qtyReceived: 1,
            qtyReturned: 0,
            sortOrder: 0,
          },
        ],
      },
    },
    include: {
      lines: true,
    },
  })

  const poLine = goodsPo.lines[0]

  const freightPo = await db.purchaseOrder.create({
    data: {
      reference: `PO-FREIGHT-${suffix}`,
      type: 'FREIGHT',
      supplierId: supplier.id,
      status: 'RECEIVED',
      currency: 'GBP',
      fxRateToBase: 1,
      subtotalForeign: 1,
      subtotalBase: 1,
      taxForeign: 0,
      taxBase: 0,
      totalForeign: 1,
      totalBase: 1,
      receivedAt: now,
      freightCostLines: {
        create: [
          {
            description: 'Freight',
            amountForeign: 1,
            amountBase: 1,
            vatable: false,
            distributionMethod: 'BY_VALUE',
            sortOrder: 0,
          },
        ],
      },
      asFreightFor: {
        create: [
          {
            primaryPoId: goodsPo.id,
            method: 'BY_VALUE',
            allocated: true,
          },
        ],
      },
    },
    include: {
      freightCostLines: true,
    },
  })

  const isDeliveredOnly = scenario === 'delivered' || scenario === 'delivered-invoiced-mixed-costs'
  const originalLayer = await db.costLayer.create({
    data: {
      productId: product.id,
      warehouseId: warehouse.id,
      receivedQty: 1,
      remainingQty: isDeliveredOnly ? 1 : 0,
      unitCostBase: scenario === 'delivered-invoiced-mixed-costs' ? 6 : 5,
      receivedAt: new Date(now.getTime() - 60_000),
      poLineId: poLine.id,
      isOpeningStock: false,
    },
  })

  await db.stockLevel.create({
    data: {
      productId: product.id,
      warehouseId: warehouse.id,
      quantity: isDeliveredOnly ? 1 : 0,
      reservedQty: 0,
    },
  })

  let orderId: string | null = null
  if (!isDeliveredOnly) {
    const order = await db.salesOrder.create({
      data: {
        orderNumber: `SO-LANDED-${suffix}`,
        status: 'SHIPPED',
        currency: 'GBP',
        fxRateToBase: 1,
        customerId: customer.id,
        customerName: `${customer.firstName} ${customer.lastName}`,
        customerEmail: customer.email,
        billingAddress: { country: 'GB' } as never,
        shippingAddress: { country: 'GB' } as never,
        subtotalForeign: 10,
        shippingForeign: 0,
        taxForeign: 0,
        pricesIncludeVat: false,
        totalForeign: 10,
        subtotalBase: 10,
        shippingBase: 0,
        taxBase: 0,
        totalBase: 10,
        shipFromWarehouseId: warehouse.id,
        shippedAt: now,
        revenueDeferredDate: new Date(now.getTime() - 10_000),
        unearnedRevenueAmount: 10,
        inventoryAllocatedDate: new Date(now.getTime() - 9_000),
        allocationBatchAmount: 5,
        lines: {
          create: [
            {
              productId: product.id,
              sku: product.sku,
              description: product.name,
              qty: 1,
              unitPriceForeign: 10,
              unitPriceBase: 10,
              totalForeign: 10,
              totalBase: 10,
              cogsBase: 5,
            },
          ],
        },
      },
      include: {
        lines: true,
      },
    })

    const line = order.lines[0]
    orderId = order.id

    await db.shipment.create({
      data: {
        orderId: order.id,
        warehouseId: warehouse.id,
        status: 'SHIPPED',
        shippedAt: now,
        shipmentJournalDate: new Date(now.getTime() - 5_000),
        cogsBatchAmount: 5,
        revenueRecognizedAmount: 10,
        lines: {
          create: [
            {
              lineId: line.id,
              productId: product.id,
              qty: 1,
              costLayerSnapshot: [
                {
                  costLayerId: originalLayer.id,
                  qty: 1,
                  unitCostBase: 5,
                },
              ] as never,
            },
          ],
        },
      },
    })
  }

  console.log(JSON.stringify({
    scenario,
    freightPoId: freightPo.id,
    goodsPoId: goodsPo.id,
    orderId,
    warehouseId: warehouse.id,
    originalCostLayerId: originalLayer.id,
    poLineId: poLine.id,
  }))
}

async function inspectScenario(goodsPoId: string, poLineId: string, originalCostLayerId: string) {
  const poLine = await db.purchaseOrderLine.findUniqueOrThrow({
    where: { id: poLineId },
    select: {
      landedUnitCostBase: true,
    },
  })

  const costLayers = await db.costLayer.findMany({
    where: { poLineId },
    orderBy: { receivedAt: 'asc' },
    select: {
      id: true,
      receivedQty: true,
      remainingQty: true,
      unitCostBase: true,
      poLineId: true,
    },
  })

  const shipmentRefs = await db.$queryRawUnsafe<Array<{ shipmentId: string }>>(
    'SELECT DISTINCT "shipmentId" FROM "shipment_lines" WHERE "costLayerSnapshot" @> $1::jsonb',
    JSON.stringify([{ costLayerId: originalCostLayerId }]),
  )

  const shipment = shipmentRefs[0]
    ? await db.shipment.findUnique({
        where: { id: shipmentRefs[0].shipmentId },
        select: {
          cogsBatchAmount: true,
          lines: {
            select: {
              costLayerSnapshot: true,
            },
          },
          order: {
            select: {
              lines: {
                select: {
                  cogsBase: true,
                },
              },
              refunds: {
                select: {
                  lines: {
                    select: {
                      costLayerSnapshot: true,
                    },
                  },
                },
              },
            },
          },
        },
      })
    : null

  const cogsLogs = await db.accountingSyncLog.findMany({
    where: {
      connector: 'xero',
      type: 'COGS_JOURNAL',
      referenceType: 'PurchaseOrder',
      referenceId: goodsPoId,
    },
    orderBy: { createdAt: 'asc' },
    select: {
      payload: true,
    },
  })
  const transitLogs = await db.accountingSyncLog.findMany({
    where: {
      connector: 'xero',
      type: 'STOCK_IN_TRANSIT',
      referenceType: 'PurchaseOrder',
      referenceId: goodsPoId,
    },
    orderBy: { createdAt: 'asc' },
    select: {
      payload: true,
    },
  })

  console.log(JSON.stringify({
    landedUnitCostBase: Number(poLine.landedUnitCostBase),
    originalLayerUnitCostBase: Number(costLayers.find((layer) => layer.id === originalCostLayerId)?.unitCostBase ?? 0),
    returnLayers: costLayers
      .filter((layer) => layer.id !== originalCostLayerId)
      .map((layer) => ({
        id: layer.id,
        receivedQty: Number(layer.receivedQty),
        remainingQty: Number(layer.remainingQty),
        unitCostBase: Number(layer.unitCostBase),
        poLineId: layer.poLineId,
      })),
    shipmentCogsBatchAmount: shipment?.cogsBatchAmount != null ? Number(shipment.cogsBatchAmount) : null,
    salesOrderLineCogsBase: shipment?.order.lines[0]?.cogsBase != null ? Number(shipment.order.lines[0].cogsBase) : null,
    shipmentSnapshot: shipment?.lines[0]?.costLayerSnapshot ?? [],
    refundSnapshots: shipment?.order.refunds.flatMap((refund) => refund.lines.map((line) => line.costLayerSnapshot)) ?? [],
    stockInTransitJournalLines: transitLogs.map((log) => {
      const lines = (log.payload as { lines?: Array<{ accountCode?: string; debit?: number; credit?: number }> } | null)?.lines
      return Array.isArray(lines)
        ? lines.map((line) => ({
            accountCode: line.accountCode ?? null,
            debit: Number(line.debit ?? 0),
            credit: Number(line.credit ?? 0),
          }))
        : []
    }),
    cogsJournalLines: cogsLogs.map((log) => {
      const lines = (log.payload as { lines?: Array<{ accountCode?: string; debit?: number; credit?: number }> } | null)?.lines
      return Array.isArray(lines)
        ? lines.map((line) => ({
            accountCode: line.accountCode ?? null,
            debit: Number(line.debit ?? 0),
            credit: Number(line.credit ?? 0),
          }))
        : []
    }),
  }))
}

async function main() {
  const [command, ...args] = process.argv.slice(2)

  switch (command) {
    case 'seed': {
      const scenario = args[0] as Scenario | undefined
      if (!scenario || !['delivered', 'shipped', 'shipped-returned', 'delivered-invoiced-mixed-costs'].includes(scenario)) {
        throw new Error('seed requires one of: delivered, shipped, shipped-returned, delivered-invoiced-mixed-costs')
      }
      await seedScenario(scenario)
      break
    }
    case 'inspect': {
      const [goodsPoId, poLineId, originalCostLayerId] = args
      if (!goodsPoId || !poLineId || !originalCostLayerId) {
        throw new Error('inspect requires <goodsPoId> <poLineId> <originalCostLayerId>')
      }
      await inspectScenario(goodsPoId, poLineId, originalCostLayerId)
      break
    }
    case 'seed-foreign-invoice-fx-mismatch': {
      await seedForeignInvoiceFxMismatch()
      break
    }
    case 'inspect-foreign-invoice-fx-mismatch': {
      const [poId, poLineId, costLayerId] = args
      if (!poId || !poLineId || !costLayerId) {
        throw new Error('inspect-foreign-invoice-fx-mismatch requires <poId> <poLineId> <costLayerId>')
      }
      await inspectForeignInvoiceFxMismatch(poId, poLineId, costLayerId)
      break
    }
    default:
      throw new Error(
        'usage: tsx scripts/landed-cost-e2e-fixture.ts ' +
        '<seed|inspect|seed-foreign-invoice-fx-mismatch|inspect-foreign-invoice-fx-mismatch> [...]',
      )
  }
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(async () => {
    await db.$disconnect()
  })
