import type { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { getWmsConnector } from '@/lib/connectors/wms/registry'
import {
  computeStockDiscrepancies,
  consolidateStockLines,
  hasStockThresholdBreach,
  isBindingDue,
  parseStockThresholds,
  type StockDiscrepancyFinding,
} from '@/lib/domain/wms/stock-sync-helpers'
import { resolveOpenWmsStockDiscrepancies, upsertWmsStockDiscrepancy } from '@/lib/domain/wms/stock-discrepancy'

const CONNECTOR = 'shiphero'

export type ShipheroStockSyncResult = {
  bindingId: string
  status: 'SUCCEEDED' | 'FAILED' | 'SKIPPED'
  checked: number
  discrepancies: number
  resolved: number
  thresholdBreaches: number
  error?: string
}

function num(value: Prisma.Decimal | number | null | undefined): number {
  if (value == null) return 0
  return typeof value === 'number' ? value : Number(value)
}

function discrepancyMessage(finding: StockDiscrepancyFinding): string {
  switch (finding.category) {
    case 'UNMAPPED_SKU':
      return `ShipHero reports SKU ${finding.sku} (qty ${finding.wmsQty}) with no matching IMS product.`
    case 'QTY_MISMATCH':
      return `Quantity mismatch for ${finding.sku}: IMS ${finding.imsQty} vs ShipHero ${finding.wmsQty} (delta ${finding.delta}).`
    case 'MISSING_IN_WMS':
      return `IMS holds ${finding.imsQty} of ${finding.sku} but the ShipHero feed omits it.`
    default:
      return `Stock discrepancy for ${finding.sku}.`
  }
}

/**
 * NOTIFICATION_ONLY stock sync for one ShipHero binding: fetch ShipHero stock,
 * diff against IMS, and log/resolve discrepancies. ALIGN_TO_WMS bindings get the
 * same detection here; auto-correction (cost-layer reconciliation) is deferred to
 * the ShipHero ASN child (h02x.8) and intentionally NOT applied in this slice.
 */
export async function runShipheroStockSyncForBinding(bindingId: string): Promise<ShipheroStockSyncResult> {
  const binding = await db.externalWmsBinding.findFirst({
    where: { id: bindingId, connector: CONNECTOR },
    select: {
      id: true,
      warehouseId: true,
      externalWarehouseId: true,
      active: true,
      stockSyncMode: true,
      discrepancyThresholds: true,
      connection: { select: { active: true } },
    },
  })

  const empty = { bindingId, checked: 0, discrepancies: 0, resolved: 0, thresholdBreaches: 0 }
  if (!binding || !binding.active || !binding.connection?.active || binding.stockSyncMode === 'DISABLED') {
    return { ...empty, status: 'SKIPPED', error: 'Binding not active or stock sync disabled' }
  }

  const now = new Date()
  try {
    const connector = getWmsConnector(CONNECTOR)
    const stockLines = consolidateStockLines(await connector.fetchStockLevels(binding.externalWarehouseId))
    const thresholds = parseStockThresholds(binding.discrepancyThresholds)
    const skus = stockLines.map((line) => line.sku)

    const products = skus.length > 0
      ? await db.product.findMany({ where: { sku: { in: skus } }, select: { id: true, sku: true } })
      : []
    const productBySku = new Map(products.map((product) => [product.sku, { id: product.id }]))
    const productIds = products.map((product) => product.id)

    const matchedStock = productIds.length > 0
      ? await db.stockLevel.findMany({ where: { warehouseId: binding.warehouseId, productId: { in: productIds } }, select: { productId: true, quantity: true } })
      : []
    const additionalStock = await db.stockLevel.findMany({
      where: {
        warehouseId: binding.warehouseId,
        quantity: { not: 0 },
        ...(productIds.length > 0 ? { productId: { notIn: productIds } } : {}),
      },
      select: { productId: true, quantity: true, product: { select: { sku: true } } },
    })

    const imsQtyByProductId = new Map<string, number>()
    const imsSkusByProductId = new Map<string, string>()
    for (const level of matchedStock) imsQtyByProductId.set(level.productId, num(level.quantity))
    for (const level of additionalStock) {
      imsQtyByProductId.set(level.productId, num(level.quantity))
      imsSkusByProductId.set(level.productId, level.product.sku)
    }

    const findings = computeStockDiscrepancies({ wmsLines: stockLines, productBySku, imsQtyByProductId, imsSkusByProductId })

    let thresholdBreaches = 0
    const conflictedSkus = new Set<string>()
    for (const finding of findings) {
      conflictedSkus.add(finding.sku)
      if (
        finding.category === 'QTY_MISMATCH'
        && finding.imsQty != null && finding.wmsQty != null
        && hasStockThresholdBreach(finding.imsQty, finding.wmsQty, thresholds)
      ) {
        thresholdBreaches += 1
      }
      await upsertWmsStockDiscrepancy({
        connector: CONNECTOR,
        warehouseId: binding.warehouseId,
        category: finding.category,
        productId: finding.productId,
        sku: finding.sku,
        imsValue: finding.imsQty != null ? String(finding.imsQty) : null,
        wmsValue: finding.wmsQty != null ? String(finding.wmsQty) : null,
        delta: finding.delta,
        message: discrepancyMessage(finding),
      }, now)
    }

    let resolved = 0
    for (const line of stockLines) {
      const product = productBySku.get(line.sku)
      if (product && !conflictedSkus.has(line.sku)) {
        await resolveOpenWmsStockDiscrepancies({ connector: CONNECTOR, warehouseId: binding.warehouseId, productId: product.id, sku: line.sku }, now)
        resolved += 1
      }
    }

    await db.externalWmsBinding.update({ where: { id: binding.id }, data: { lastStockSyncAt: now, lastStockSyncStatus: 'SUCCEEDED' } })
    return { bindingId, status: 'SUCCEEDED', checked: stockLines.length, discrepancies: findings.length, resolved, thresholdBreaches }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'ShipHero stock sync failed'
    await db.externalWmsBinding.update({ where: { id: binding.id }, data: { lastStockSyncAt: now, lastStockSyncStatus: 'FAILED' } }).catch(() => undefined)
    return { ...empty, status: 'FAILED', error: message }
  }
}

/** Run stock sync for every ShipHero binding whose cadence is due. */
export async function runDueShipheroStockSyncs(now: Date = new Date()): Promise<{ ran: number; due: number; results: ShipheroStockSyncResult[] }> {
  const bindings = await db.externalWmsBinding.findMany({
    where: { connector: CONNECTOR, active: true, stockSyncMode: { in: ['NOTIFICATION_ONLY', 'ALIGN_TO_WMS'] } },
    select: { id: true, lastStockSyncAt: true, syncFrequencyMinutes: true },
  })
  const due = bindings.filter((binding) => isBindingDue(binding.lastStockSyncAt, binding.syncFrequencyMinutes, now))
  const results: ShipheroStockSyncResult[] = []
  for (const binding of due) results.push(await runShipheroStockSyncForBinding(binding.id))
  return { ran: results.length, due: due.length, results }
}
