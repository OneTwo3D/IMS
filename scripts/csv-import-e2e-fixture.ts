import 'dotenv/config'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../app/generated/prisma/client.ts'

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! })
const db = new PrismaClient({ adapter })

function uniqueSuffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
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
      active: true,
    },
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
}

async function ensureSecondWarehouse() {
  return db.warehouse.upsert({
    where: { code: 'E2E-SECOND' },
    update: {
      name: 'E2E Secondary',
      type: 'STANDARD',
      availableForSale: true,
      syncToStore: false,
      active: true,
    },
    create: {
      code: 'E2E-SECOND',
      name: 'E2E Secondary',
      type: 'STANDARD',
      availableForSale: true,
      syncToStore: false,
      active: true,
    },
  })
}

async function ensureSupplier() {
  return db.supplier.upsert({
    where: { id: 'e2e-supplier' },
    update: {
      name: 'E2E Supplier',
      currency: 'GBP',
      active: true,
    },
    create: {
      id: 'e2e-supplier',
      name: 'E2E Supplier',
      currency: 'GBP',
      active: true,
    },
  })
}

async function seedAdjustmentSource() {
  const suffix = uniqueSuffix()
  const warehouse = await ensureDefaultWarehouse()
  const product = await db.product.create({
    data: {
      sku: `E2E-CSV-ADJ-${suffix}`,
      name: `CSV Adjustment ${suffix}`,
      type: 'SIMPLE',
      lifecycleStatus: 'ACTIVE',
      salesPriceBase: 10,
      salesPriceTaxInclusive: false,
      taxCategory: 'STANDARD',
      stockUnit: 'pcs',
      oversellAllowed: false,
      active: true,
    },
    select: { id: true, sku: true },
  })

  await db.stockLevel.create({
    data: {
      productId: product.id,
      warehouseId: warehouse.id,
      quantity: 5,
      reservedQty: 0,
    },
  })

  await db.costLayer.create({
    data: {
      productId: product.id,
      warehouseId: warehouse.id,
      receivedQty: 5,
      remainingQty: 5,
      unitCostBase: 4,
      receivedAt: new Date(Date.now() - 60_000),
      isOpeningStock: true,
    },
  })

  console.log(JSON.stringify({
    sku: product.sku,
    warehouseCode: warehouse.code,
  }))
}

async function inspectAdjustmentImport(sku: string, note: string) {
  const product = await db.product.findFirstOrThrow({
    where: { sku },
    select: { id: true },
  })
  const warehouse = await db.warehouse.findUniqueOrThrow({
    where: { code: 'DEFAULT' },
    select: { id: true },
  })
  const movement = await db.stockMovement.findFirstOrThrow({
    where: {
      productId: product.id,
      note,
      type: 'ADJUSTMENT',
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      qty: true,
      cogsEntries: {
        select: {
          qty: true,
          unitCostBase: true,
          totalCostBase: true,
        },
      },
    },
  })
  const stockLevel = await db.stockLevel.findUnique({
    where: {
      productId_warehouseId: {
        productId: product.id,
        warehouseId: warehouse.id,
      },
    },
    select: { quantity: true },
  })
  const layers = await db.costLayer.findMany({
    where: {
      productId: product.id,
      warehouseId: warehouse.id,
    },
    select: {
      receivedQty: true,
      remainingQty: true,
      unitCostBase: true,
    },
    orderBy: { receivedAt: 'asc' },
  })

  console.log(JSON.stringify({
    stockQty: stockLevel ? Number(stockLevel.quantity) : null,
    movementQty: Number(movement.qty),
    cogsEntries: movement.cogsEntries.map((entry) => ({
      qty: Number(entry.qty),
      unitCostBase: Number(entry.unitCostBase),
      totalCostBase: Number(entry.totalCostBase),
    })),
    layers: layers.map((layer) => ({
      receivedQty: Number(layer.receivedQty),
      remainingQty: Number(layer.remainingQty),
      unitCostBase: Number(layer.unitCostBase),
    })),
  }))
}

async function inspectSalesImport(note: string) {
  const order = await db.salesOrder.findFirstOrThrow({
    where: { notes: note },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      status: true,
      currency: true,
      fxRateToBase: true,
      subtotalForeign: true,
      subtotalBase: true,
      totalForeign: true,
      totalBase: true,
      lines: {
        select: {
          sku: true,
          qty: true,
          unitPriceForeign: true,
          unitPriceBase: true,
          totalForeign: true,
          totalBase: true,
        },
      },
    },
  })

  console.log(JSON.stringify({
    id: order.id,
    status: order.status,
    currency: order.currency,
    fxRateToBase: Number(order.fxRateToBase),
    subtotalForeign: Number(order.subtotalForeign),
    subtotalBase: Number(order.subtotalBase),
    totalForeign: Number(order.totalForeign),
    totalBase: Number(order.totalBase),
    lines: order.lines.map((line) => ({
      sku: line.sku,
      qty: Number(line.qty),
      unitPriceForeign: Number(line.unitPriceForeign),
      unitPriceBase: Number(line.unitPriceBase),
      totalForeign: Number(line.totalForeign),
      totalBase: Number(line.totalBase),
    })),
  }))
}

async function inspectPurchaseImport(note: string) {
  const po = await db.purchaseOrder.findFirstOrThrow({
    where: { notes: note },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      status: true,
      currency: true,
      fxRateToBase: true,
      subtotalForeign: true,
      subtotalBase: true,
      totalForeign: true,
      totalBase: true,
      lines: {
        select: {
          product: { select: { sku: true } },
          qty: true,
          unitCostForeign: true,
          unitCostBase: true,
          totalForeign: true,
          totalBase: true,
        },
      },
    },
  })

  console.log(JSON.stringify({
    id: po.id,
    status: po.status,
    currency: po.currency,
    fxRateToBase: Number(po.fxRateToBase),
    subtotalForeign: Number(po.subtotalForeign),
    subtotalBase: Number(po.subtotalBase),
    totalForeign: Number(po.totalForeign),
    totalBase: Number(po.totalBase),
    lines: po.lines.map((line) => ({
      sku: line.product.sku,
      qty: Number(line.qty),
      unitCostForeign: Number(line.unitCostForeign),
      unitCostBase: Number(line.unitCostBase),
      totalForeign: Number(line.totalForeign),
      totalBase: Number(line.totalBase),
    })),
  }))
}

async function inspectShipmentCogs(orderId: string) {
  const order = await db.salesOrder.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      lines: {
        select: {
          cogsBase: true,
        },
      },
      shipments: {
        select: {
          cogsBatchAmount: true,
          lines: {
            select: {
              costLayerSnapshot: true,
            },
          },
        },
      },
    },
  })

  console.log(JSON.stringify({
    lineCogsBase: order.lines[0]?.cogsBase != null ? Number(order.lines[0].cogsBase) : null,
    shipmentCogsBatchAmount: order.shipments[0]?.cogsBatchAmount != null ? Number(order.shipments[0].cogsBatchAmount) : null,
    shipmentSnapshot: order.shipments[0]?.lines[0]?.costLayerSnapshot ?? [],
  }))
}

async function seedTransferSource() {
  const suffix = uniqueSuffix()
  const [sourceWarehouse, destinationWarehouse] = await Promise.all([
    ensureDefaultWarehouse(),
    ensureSecondWarehouse(),
  ])
  const product = await db.product.create({
    data: {
      sku: `E2E-CSV-TRF-${suffix}`,
      name: `CSV Transfer ${suffix}`,
      type: 'SIMPLE',
      lifecycleStatus: 'ACTIVE',
      salesPriceBase: 10,
      salesPriceTaxInclusive: false,
      taxCategory: 'STANDARD',
      stockUnit: 'pcs',
      oversellAllowed: false,
      active: true,
    },
    select: { id: true, sku: true },
  })

  await db.stockLevel.create({
    data: {
      productId: product.id,
      warehouseId: sourceWarehouse.id,
      quantity: 4,
      reservedQty: 0,
    },
  })

  await db.costLayer.create({
    data: {
      productId: product.id,
      warehouseId: sourceWarehouse.id,
      receivedQty: 4,
      remainingQty: 4,
      unitCostBase: 6,
      receivedAt: new Date(Date.now() - 60_000),
      isOpeningStock: true,
    },
  })

  console.log(JSON.stringify({
    sku: product.sku,
    fromWarehouseCode: sourceWarehouse.code,
    toWarehouseCode: destinationWarehouse.code,
  }))
}

async function inspectTransferImport(sku: string, notes: string) {
  const product = await db.product.findFirstOrThrow({
    where: { sku },
    select: { id: true },
  })
  const [sourceWarehouse, destinationWarehouse] = await Promise.all([
    db.warehouse.findUniqueOrThrow({ where: { code: 'DEFAULT' }, select: { id: true } }),
    db.warehouse.findUniqueOrThrow({ where: { code: 'E2E-SECOND' }, select: { id: true } }),
  ])
  const transfer = await db.stockTransfer.findFirstOrThrow({
    where: { notes },
    orderBy: { createdAt: 'desc' },
    select: {
      status: true,
      lines: {
        select: {
          qty: true,
          qtyReceived: true,
          costLayerSnapshot: true,
        },
      },
    },
  })
  const [sourceLevel, destinationLevel, destinationLayers] = await Promise.all([
    db.stockLevel.findUnique({
      where: { productId_warehouseId: { productId: product.id, warehouseId: sourceWarehouse.id } },
      select: { quantity: true },
    }),
    db.stockLevel.findUnique({
      where: { productId_warehouseId: { productId: product.id, warehouseId: destinationWarehouse.id } },
      select: { quantity: true },
    }),
    db.costLayer.findMany({
      where: { productId: product.id, warehouseId: destinationWarehouse.id },
      select: { receivedQty: true, remainingQty: true, unitCostBase: true },
      orderBy: { receivedAt: 'asc' },
    }),
  ])

  console.log(JSON.stringify({
    status: transfer.status,
    sourceQty: sourceLevel ? Number(sourceLevel.quantity) : null,
    destinationQty: destinationLevel ? Number(destinationLevel.quantity) : null,
    lineQty: Number(transfer.lines[0]?.qty ?? 0),
    qtyReceived: Number(transfer.lines[0]?.qtyReceived ?? 0),
    snapshot: transfer.lines[0]?.costLayerSnapshot ?? [],
    destinationLayers: destinationLayers.map((layer) => ({
      receivedQty: Number(layer.receivedQty),
      remainingQty: Number(layer.remainingQty),
      unitCostBase: Number(layer.unitCostBase),
    })),
  }))
}

async function seedProductRoundtrip() {
  const suffix = uniqueSuffix()
  const product = await db.product.create({
    data: {
      sku: `E2E-CSV-PROD-${suffix}`,
      name: `CSV Product ${suffix}`,
      type: 'SIMPLE',
      lifecycleStatus: 'ACTIVE',
      barcode: `BC-${suffix}`,
      weight: 1.25,
      salesPriceBase: 20,
      salePriceBase: 18,
      salesPriceTaxInclusive: true,
      stockUnit: 'pcs',
      oversellAllowed: false,
      active: true,
      description: 'Original description',
    },
    select: { id: true, sku: true },
  })

  console.log(JSON.stringify({ id: product.id, sku: product.sku }))
}

async function inspectProductRoundtrip(id: string) {
  const product = await db.product.findUniqueOrThrow({
    where: { id },
    select: {
      id: true,
      sku: true,
      name: true,
      barcode: true,
      weight: true,
      salesPriceBase: true,
      salePriceBase: true,
      salesPriceTaxInclusive: true,
      description: true,
    },
  })

  console.log(JSON.stringify({
    id: product.id,
    sku: product.sku,
    name: product.name,
    barcode: product.barcode,
    weight: product.weight != null ? Number(product.weight) : null,
    salesPriceBase: product.salesPriceBase != null ? Number(product.salesPriceBase) : null,
    salePriceBase: product.salePriceBase != null ? Number(product.salePriceBase) : null,
    salesPriceTaxInclusive: product.salesPriceTaxInclusive,
    description: product.description,
  }))
}

async function seedContactRoundtrip() {
  const suffix = uniqueSuffix()
  const customer = await db.customer.create({
    data: {
      firstName: 'CSV',
      lastName: `Contact ${suffix}`,
      email: `csv-contact-${suffix}@example.com`,
      company: 'Original Co',
      phone: '0123456789',
      billingAddress: {
        line1: '1 Existing Street',
        city: 'Cambridge',
        postcode: 'CB1 1AA',
        country: 'GB',
      },
      shippingAddress: {
        line1: '2 Existing Street',
        city: 'Cambridge',
        postcode: 'CB1 1AB',
        country: 'GB',
      },
      notes: 'Existing notes',
    },
    select: { id: true, email: true, firstName: true, lastName: true },
  })

  console.log(JSON.stringify({
    id: customer.id,
    email: customer.email,
    firstName: customer.firstName,
    lastName: customer.lastName,
  }))
}

async function inspectContactRoundtrip(id: string) {
  const customer = await db.customer.findUniqueOrThrow({
    where: { id },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      company: true,
      phone: true,
      billingAddress: true,
      shippingAddress: true,
      notes: true,
    },
  })

  console.log(JSON.stringify({
    id: customer.id,
    firstName: customer.firstName,
    lastName: customer.lastName,
    email: customer.email,
    company: customer.company,
    phone: customer.phone,
    billingAddress: customer.billingAddress,
    shippingAddress: customer.shippingAddress,
    notes: customer.notes,
  }))
}

async function seedSupplierRoundtrip() {
  const suffix = uniqueSuffix()
  const supplier = await db.supplier.create({
    data: {
      name: `CSV Supplier ${suffix}`,
      email: `csv-supplier-${suffix}@example.com`,
      contactName: 'Original Buyer',
      currency: 'EUR',
      vatNumber: 'VAT-123',
      accountNumber: 'AC-123',
      paymentTermsDays: 30,
      addressLine1: '1 Supplier Road',
      city: 'London',
      postcode: 'SW1A 1AA',
      country: 'GB',
      notes: 'Existing supplier notes',
    },
    select: { id: true, name: true },
  })

  console.log(JSON.stringify({ id: supplier.id, name: supplier.name }))
}

async function inspectSupplierRoundtrip(id: string) {
  const supplier = await db.supplier.findUniqueOrThrow({
    where: { id },
    select: {
      id: true,
      name: true,
      email: true,
      contactName: true,
      currency: true,
      vatNumber: true,
      accountNumber: true,
      paymentTermsDays: true,
      addressLine1: true,
      city: true,
      postcode: true,
      country: true,
      notes: true,
    },
  })

  console.log(JSON.stringify(supplier))
}

async function main() {
  const [command, ...args] = process.argv.slice(2)

  switch (command) {
    case 'seed-adjustment-source':
      await seedAdjustmentSource()
      break
    case 'inspect-adjustment-import':
      await inspectAdjustmentImport(args[0]!, args[1]!)
      break
    case 'inspect-sales-import':
      await inspectSalesImport(args[0]!)
      break
    case 'inspect-purchase-import':
      await inspectPurchaseImport(args[0]!)
      break
    case 'inspect-shipment-cogs':
      await inspectShipmentCogs(args[0]!)
      break
    case 'seed-transfer-source':
      await seedTransferSource()
      break
    case 'inspect-transfer-import':
      await inspectTransferImport(args[0]!, args[1]!)
      break
    case 'seed-product-roundtrip':
      await seedProductRoundtrip()
      break
    case 'inspect-product-roundtrip':
      await inspectProductRoundtrip(args[0]!)
      break
    case 'seed-contact-roundtrip':
      await seedContactRoundtrip()
      break
    case 'inspect-contact-roundtrip':
      await inspectContactRoundtrip(args[0]!)
      break
    case 'seed-supplier-roundtrip':
      await seedSupplierRoundtrip()
      break
    case 'inspect-supplier-roundtrip':
      await inspectSupplierRoundtrip(args[0]!)
      break
    case 'ensure-supplier':
      await ensureSupplier()
      console.log(JSON.stringify({ ok: true }))
      break
    default:
      throw new Error(`Unknown command: ${command}`)
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
