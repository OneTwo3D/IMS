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

async function seedDispatch(skuArg?: string) {
  const suffix = uniqueSuffix()
  const warehouse = await ensureDefaultWarehouse()
  const product = skuArg
    ? await db.product.findFirstOrThrow({
        where: { sku: skuArg },
        select: { id: true, sku: true },
      })
    : await db.product.create({
        data: {
          sku: `E2E-COGS-DISPATCH-${suffix}`,
          name: `COGS Dispatch ${suffix}`,
          type: 'SIMPLE',
          lifecycleStatus: 'ACTIVE',
          salesPriceBase: 12,
          salesPriceTaxInclusive: false,
          taxCategory: 'STANDARD',
          stockUnit: 'pcs',
          oversellAllowed: false,
          active: true,
        },
        select: { id: true, sku: true },
      })

  await db.stockLevel.upsert({
    where: {
      productId_warehouseId: {
        productId: product.id,
        warehouseId: warehouse.id,
      },
    },
    update: {
      quantity: 1,
      reservedQty: 0,
    },
    create: {
      productId: product.id,
      warehouseId: warehouse.id,
      quantity: 1,
      reservedQty: 0,
    },
  })

  await db.costLayer.create({
    data: {
      productId: product.id,
      warehouseId: warehouse.id,
      receivedQty: 1,
      remainingQty: 1,
      unitCostBase: 4,
      receivedAt: new Date(Date.now() - 60_000),
      isOpeningStock: true,
    },
  })

  console.log(JSON.stringify({
    sku: product.sku,
    warehouseLabel: `${warehouse.code} — ${warehouse.name}`,
  }))
}

async function inspectDispatch(orderId: string) {
  const order = await db.salesOrder.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      lines: {
        select: {
          id: true,
          cogsBase: true,
        },
      },
      shipments: {
        select: {
          id: true,
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

async function seedAdjustmentSafe() {
  const suffix = uniqueSuffix()
  const warehouse = await ensureDefaultWarehouse()
  const product = await db.product.create({
    data: {
      sku: `E2E-COGS-ADJ-SAFE-${suffix}`,
      name: `COGS Adjustment Safe ${suffix}`,
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

  await db.stockLevel.create({
    data: {
      productId: product.id,
      warehouseId: warehouse.id,
      quantity: 0,
      reservedQty: 0,
    },
  })

  const note = `SAFE-ADJUST-${suffix}`
  const createdAt = new Date(Date.now() - 60_000)
  const movement = await db.stockMovement.create({
    data: {
      type: 'ADJUSTMENT',
      productId: product.id,
      fromWarehouseId: warehouse.id,
      qty: 5,
      note,
      createdAt,
    },
  })

  const costLayer = await db.costLayer.create({
    data: {
      productId: product.id,
      warehouseId: warehouse.id,
      receivedQty: 5,
      remainingQty: 0,
      unitCostBase: 4,
      receivedAt: new Date(Date.now() - 120_000),
      isOpeningStock: true,
    },
  })

  await db.cogsEntry.create({
    data: {
      costLayerId: costLayer.id,
      movementId: movement.id,
      qty: 5,
      unitCostBase: 4,
      totalCostBase: 20,
      createdAt,
    },
  })

  console.log(JSON.stringify({
    movementId: movement.id,
    sku: product.sku,
    note,
  }))
}

async function seedAdjustmentBlocked() {
  const suffix = uniqueSuffix()
  const warehouse = await ensureDefaultWarehouse()
  const product = await db.product.create({
    data: {
      sku: `E2E-COGS-ADJ-BLOCKED-${suffix}`,
      name: `COGS Adjustment Blocked ${suffix}`,
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

  await db.stockLevel.create({
    data: {
      productId: product.id,
      warehouseId: warehouse.id,
      quantity: 1,
      reservedQty: 0,
    },
  })

  const baseCreatedAt = new Date(Date.now() - 120_000)
  const baseNote = `BLOCKED-BASE-${suffix}`
  const baseMovement = await db.stockMovement.create({
    data: {
      type: 'ADJUSTMENT',
      productId: product.id,
      fromWarehouseId: warehouse.id,
      qty: 5,
      note: baseNote,
      createdAt: baseCreatedAt,
    },
  })

  const openingLayer = await db.costLayer.create({
    data: {
      productId: product.id,
      warehouseId: warehouse.id,
      receivedQty: 5,
      remainingQty: 0,
      unitCostBase: 4,
      receivedAt: new Date(Date.now() - 180_000),
      isOpeningStock: true,
    },
  })

  await db.cogsEntry.create({
    data: {
      costLayerId: openingLayer.id,
      movementId: baseMovement.id,
      qty: 5,
      unitCostBase: 4,
      totalCostBase: 20,
      createdAt: baseCreatedAt,
    },
  })

  const laterMovement = await db.stockMovement.create({
    data: {
      type: 'ADJUSTMENT',
      productId: product.id,
      toWarehouseId: warehouse.id,
      qty: 1,
      note: `BLOCKED-LATER-${suffix}`,
      createdAt: new Date(Date.now() - 60_000),
    },
  })

  await db.costLayer.create({
    data: {
      productId: product.id,
      warehouseId: warehouse.id,
      receivedQty: 1,
      remainingQty: 1,
      unitCostBase: 4,
      receivedAt: new Date(Date.now() - 60_000),
      isOpeningStock: false,
      adjustmentMovementId: laterMovement.id,
    },
  })

  console.log(JSON.stringify({
    movementId: baseMovement.id,
    sku: product.sku,
    note: baseNote,
  }))
}

async function inspectAdjustment(movementId: string) {
  const movement = await db.stockMovement.findUniqueOrThrow({
    where: { id: movementId },
    select: {
      id: true,
      productId: true,
      fromWarehouseId: true,
      toWarehouseId: true,
      qty: true,
      note: true,
      cogsEntries: {
        select: {
          costLayerId: true,
          qty: true,
          unitCostBase: true,
          totalCostBase: true,
        },
      },
    },
  })

  const warehouseId = movement.toWarehouseId ?? movement.fromWarehouseId
  const stockLevel = warehouseId
    ? await db.stockLevel.findUnique({
        where: {
          productId_warehouseId: {
            productId: movement.productId,
            warehouseId,
          },
        },
        select: { quantity: true },
      })
    : null

  const costLayers = warehouseId
    ? await db.costLayer.findMany({
        where: {
          productId: movement.productId,
          warehouseId,
        },
        orderBy: { receivedAt: 'asc' },
        select: {
          id: true,
          receivedQty: true,
          remainingQty: true,
          unitCostBase: true,
          adjustmentMovementId: true,
        },
      })
    : []

  console.log(JSON.stringify({
    signedQty: movement.toWarehouseId ? Number(movement.qty) : -Number(movement.qty),
    note: movement.note,
    stockQty: stockLevel ? Number(stockLevel.quantity) : null,
    cogsEntries: movement.cogsEntries.map((entry) => ({
      costLayerId: entry.costLayerId,
      qty: Number(entry.qty),
      unitCostBase: Number(entry.unitCostBase),
      totalCostBase: Number(entry.totalCostBase),
    })),
    costLayers: costLayers.map((layer) => ({
      id: layer.id,
      receivedQty: Number(layer.receivedQty),
      remainingQty: Number(layer.remainingQty),
      unitCostBase: Number(layer.unitCostBase),
      adjustmentMovementId: layer.adjustmentMovementId,
    })),
  }))
}

async function main() {
  const [command, ...args] = process.argv.slice(2)

  switch (command) {
    case 'seed-dispatch':
      await seedDispatch(args[0])
      break
    case 'inspect-dispatch':
      if (!args[0]) throw new Error('inspect-dispatch requires <orderId>')
      await inspectDispatch(args[0])
      break
    case 'seed-adjustment-safe':
      await seedAdjustmentSafe()
      break
    case 'seed-adjustment-blocked':
      await seedAdjustmentBlocked()
      break
    case 'inspect-adjustment':
      if (!args[0]) throw new Error('inspect-adjustment requires <movementId>')
      await inspectAdjustment(args[0])
      break
    default:
      throw new Error(
        'usage: node --experimental-strip-types scripts/cogs-e2e-fixture.ts ' +
        '<seed-dispatch|inspect-dispatch|seed-adjustment-safe|seed-adjustment-blocked|inspect-adjustment> [...]',
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
