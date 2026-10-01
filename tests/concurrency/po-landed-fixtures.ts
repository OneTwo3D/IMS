import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { config } from 'dotenv'
import { liveMintsoftBookedInAsnRef } from '@/tests/helpers/live-mintsoft-asn-ref'

/**
 * Shared DB-tier fixtures for the purchase-order landed-quantity arms (o3d-papk). NOT a test file: it is
 * imported by tests/concurrency/*.concurrent.test.ts AFTER their own `./scratch-database-setup` import and
 * module mocks, and reaches the application only through dynamic `import()`, so nothing opens the pool first.
 */

export function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
  }
}

export const UNIT_COST = 5

/** Unique by construction and NEVER truncated: 32 hex characters of entropy, then the readable part. */
export function uid(): string {
  return randomUUID().replace(/-/g, '')
}

export async function enableStockReceiptPosting(): Promise<void> {
  const { db } = await import('@/lib/db')
  for (const [key, value] of [
    ['plugin_xero_enabled', 'true'],
    ['xero_sync_enabled', 'true'],
    ['xero_sync_stock_receipt', 'submitted'],
    ['xero_inventory_account', '630'],
    ['xero_transit_account', '631'],
  ] as Array<[string, string]>) {
    await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
  }
}

export type SeededLine = {
  poLineId: string
  productId: string
  sku: string
  qty: number
}

export type SeededPo = {
  tag: string
  poId: string
  warehouseId: string
  binding: Record<string, unknown>
  lines: SeededLine[]
}

/** A PO_SENT purchase order with one line per entry in `lineQtys`, built by the real creation path. */
export async function seedPo(
  label: string,
  lineQtys: number[],
  status: 'PO_SENT' | 'CANCELLED' = 'PO_SENT',
  /** A SECOND order for the SAME warehouse and products as an earlier one (the mixed-world arms). */
  reuse?: SeededPo,
): Promise<SeededPo> {
  const { db } = await import('@/lib/db')
  const { createPurchaseOrder } = await import('@/app/actions/purchase-orders')
  const tag = `${uid()}-papk-${label}`
  const warehouse = reuse
    ? (reuse.binding.warehouse as { id: string; code: string; name: string })
    : await db.warehouse.create({
      data: { code: `${uid()}-W`, name: `${tag} wh`, type: 'STANDARD' },
      select: { id: true, code: true, name: true },
    })
  const supplier = await db.supplier.create({ data: { name: `${tag} supplier`, currency: 'GBP' }, select: { id: true } })
  const products: Array<{ id: string; sku: string }> = []
  for (let i = 0; i < lineQtys.length; i += 1) {
    if (reuse) {
      products.push({ id: reuse.lines[i]!.productId, sku: reuse.lines[i]!.sku })
      continue
    }
    const sku = `${uid()}-papk-${label}-${i}`
    const product = await db.product.create({
      data: { sku, name: `papk ${label} ${i}`, type: 'SIMPLE', countryOfOrigin: 'CN' },
      select: { id: true },
    })
    await db.stockLevel.create({
      data: { productId: product.id, warehouseId: warehouse.id, quantity: '0', reservedQty: '0' },
    })
    products.push({ id: product.id, sku })
  }
  const created = await createPurchaseOrder({
    reference: tag,
    supplierId: supplier.id,
    currency: 'GBP',
    fxRateToBase: 1,
    destinationWarehouseId: warehouse.id,
    pricesIncludeVat: false,
    taxRateValue: 0,
    lines: lineQtys.map((qty, i) => ({
      productId: products[i]!.id,
      sku: products[i]!.sku,
      productName: `papk ${label} ${i}`,
      qty,
      unitCostForeign: UNIT_COST,
    })),
  })
  assert.equal(created.success, true, `PRECONDITION: createPurchaseOrder must succeed: ${created.error}`)
  const po = await db.purchaseOrder.findUniqueOrThrow({
    where: { reference: tag },
    select: { id: true, lines: { select: { id: true, productId: true }, orderBy: { sortOrder: 'asc' } } },
  })
  await db.purchaseOrder.update({ where: { id: po.id }, data: { status } })
  const lines: SeededLine[] = lineQtys.map((qty, i) => {
    const line = po.lines.find((l) => l.productId === products[i]!.id)
    assert.ok(line, 'PRECONDITION: the created PO has a line for every product')
    return { poLineId: line.id, productId: products[i]!.id, sku: products[i]!.sku, qty }
  })
  return {
    tag,
    poId: po.id,
    warehouseId: warehouse.id,
    lines,
    binding: {
      id: `binding-${tag}`,
      connector: 'mintsoft', // wms-connector-boundary-ok: o3d-papk: a test fixture value, not a core flow branch
      active: true,
      externalWarehouseId: '1',
      stockSyncMode: 'ALIGN_TO_WMS',
      syncFrequencyMinutes: 60,
      discrepancyThresholds: null,
      reportRecipients: [],
      alignmentConfirmedAt: new Date(),
      alignDownReasonId: null,
      warehouseId: warehouse.id,
      lastStockSyncAt: null,
      connection: { active: true },
      warehouse,
    },
  }
}

export type SeededAsn = { asnId: string; asnLineMapId: string; externalAsnId: string; externalAsnLineId: string }

/** A PO-sourced ASN carrying ONE line. `closed` models a retired reservation (closedAt set). */
export async function addAsn(
  po: SeededPo,
  line: SeededLine,
  input: {
    expectedQty: number
    status?: string
    closed?: boolean
    viaSnapshot?: number
    createdAt?: Date
  },
): Promise<SeededAsn> {
  const { db } = await import('@/lib/db')
  const externalAsnId = `${uid()}-papk-asn`
  const asn = await db.wmsAsnMap.create({
    data: {
      connector: 'mintsoft', // wms-connector-boundary-ok: o3d-papk: a test fixture row, not a core flow branch
      externalAsnId,
      sourceType: 'PURCHASE_ORDER',
      sourceId: po.poId,
      warehouseId: po.warehouseId,
      status: (input.status ?? 'OPEN') as never,
      ...(input.closed ? { closedAt: new Date() } : {}),
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      lines: {
        create: [{
          externalAsnLineId: `${externalAsnId}-1`,
          sourceType: 'PURCHASE_ORDER_LINE',
          sourceLineId: line.poLineId,
          productId: line.productId,
          sku: line.sku,
          expectedQty: `${input.expectedQty}.0000`,
          ...(input.viaSnapshot ? { qtyAccountedViaSnapshot: `${input.viaSnapshot}.0000` } : {}),
        }],
      },
    },
    select: { id: true, lines: { select: { id: true, externalAsnLineId: true } } },
  })
  return {
    asnId: asn.id,
    asnLineMapId: asn.lines[0]!.id,
    externalAsnId,
    externalAsnLineId: asn.lines[0]!.externalAsnLineId,
  }
}

export async function alignUp(po: SeededPo, line: SeededLine, amounts: { delta: number; imsQty: number }) {
  const { applyMintsoftAlignmentForProduct } = await import('@/lib/connectors/mintsoft/sync/stock-sync')
  return applyMintsoftAlignmentForProduct({
    binding: po.binding as never,
    jobId: `papk-${uid()}`,
    productId: line.productId,
    sku: line.sku,
    delta: amounts.delta,
    imsQty: amounts.imsQty,
    dryRun: false,
  })
}

export async function receive(po: SeededPo, line: SeededLine, qty: number) {
  const { receivePurchaseOrder } = await import('@/app/actions/purchase-orders')
  return receivePurchaseOrder(po.poId, [{ poLineId: line.poLineId, qtyReceived: qty, warehouseId: po.warehouseId }])
}

export async function bookIn(asn: SeededAsn, line: SeededLine, expectedQty: number, bookedQty: number): Promise<string> {
  const { db } = await import('@/lib/db')
  const { processBookedInEvent } = await import('@/lib/domain/wms/booked-in-service')
  const event = await db.wmsInboundReceiptEvent.create({
    data: {
      connector: 'mintsoft', // wms-connector-boundary-ok: o3d-papk: a test fixture row, not a core flow branch
      externalEventId: `${uid()}-evt`,
      externalAsnId: asn.externalAsnId,
      payload: { asnId: asn.externalAsnId },
    },
    select: { id: true },
  })
  const remote = liveMintsoftBookedInAsnRef({
    externalAsnId: asn.externalAsnId,
    externalLineId: asn.externalAsnLineId,
    sourceLineId: line.poLineId,
    sku: line.sku,
    expectedQty,
    bookedQty,
  })
  const result = await processBookedInEvent(event.id, {
    fetchRemoteAsn: async () => ({ ...remote, status: 'RECEIVED', raw: null }),
  })
  return result.status
}

export async function snapshotOf(po: SeededPo, line: SeededLine) {
  const { db } = await import('@/lib/db')
  const [stock, layers, movements, journals, poLine, poRow, asnRows] = await Promise.all([
    db.stockLevel.findUnique({
      where: { productId_warehouseId: { productId: line.productId, warehouseId: po.warehouseId } },
      select: { quantity: true },
    }),
    db.costLayer.findMany({ where: { productId: line.productId, warehouseId: po.warehouseId }, select: { receivedQty: true } }),
    // EVERY movement, including the alignment's own WMS_RECEIPT_RECONCILIATION one, so a "no movement" claim is about all of them.
    db.stockMovement.findMany({ where: { productId: line.productId }, select: { qty: true } }),
    db.accountingSyncLog.count({ where: { type: 'STOCK_RECEIPT', referenceId: po.poId } }),
    db.purchaseOrderLine.findUniqueOrThrow({ where: { id: line.poLineId }, select: { qtyReceived: true } }),
    db.purchaseOrder.findUniqueOrThrow({ where: { id: po.poId }, select: { status: true } }),
    db.wmsAsnLineMap.findMany({
      where: { sourceLineId: line.poLineId },
      select: { id: true, qtyAccountedViaSnapshot: true, qtyAccountedViaReceipt: true },
    }),
  ])
  return {
    stock: Number(stock?.quantity ?? 0),
    layerCount: layers.length,
    layerQty: layers.reduce((sum, l) => sum + Number(l.receivedQty), 0),
    movementCount: movements.length,
    journals,
    qtyReceived: Number(poLine.qtyReceived),
    poStatus: poRow.status,
    credits: new Map(asnRows.map((r) => [r.id, { snapshot: Number(r.qtyAccountedViaSnapshot), receipt: Number(r.qtyAccountedViaReceipt) }])),
  }
}

