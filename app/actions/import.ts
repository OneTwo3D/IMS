'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { parseCsv } from '@/lib/csv'
import { ProductType } from '@/app/generated/prisma/client'
import { logActivity } from '@/lib/activity-log'
import { requirePermission } from '@/lib/auth/server'
import { enqueueStockSync, pushProductMetadata } from '@/lib/shopping'
import { deriveLegacyActiveFromLifecycleStatus, deriveLifecycleStatusFromLegacyActive } from '@/lib/products/lifecycle'
import type { Permission } from '@/lib/auth/server'
import { getBaseCurrencyCode } from '@/lib/base-currency'

export type ImportResult = {
  created: number
  updated: number
  skipped: number
  errors: string[]
}

// Hard caps on CSV imports to prevent memory blow-up / DoS via giant files.
const MAX_IMPORT_BYTES = 10 * 1024 * 1024 // 10 MB
const MAX_IMPORT_ROWS = 10_000

async function validateImportFile(
  formData: FormData,
  permission: Permission,
): Promise<{ file: File } | { error: string }> {
  await requirePermission(permission)
  const file = formData.get('file') as File | null
  if (!file) return { error: 'No file provided' }
  if (file.size > MAX_IMPORT_BYTES) {
    return { error: `File exceeds maximum size (${MAX_IMPORT_BYTES / (1024 * 1024)} MB)` }
  }
  return { file }
}

function capRows<T>(rows: T[]): { rows: T[]; dropped: number } {
  if (rows.length <= MAX_IMPORT_ROWS) return { rows, dropped: 0 }
  return { rows: rows.slice(0, MAX_IMPORT_ROWS), dropped: rows.length - MAX_IMPORT_ROWS }
}

// ---------------------------------------------------------------------------
// Products CSV import
// ---------------------------------------------------------------------------

const VALID_TYPES = new Set<string>(['SIMPLE', 'VARIABLE', 'VARIANT', 'KIT', 'BOM', 'NON_INVENTORY'])

export async function importProductsCsv(formData: FormData): Promise<ImportResult> {
  const validated = await validateImportFile(formData, 'inventory.edit')
  if ('error' in validated) return { created: 0, updated: 0, skipped: 0, errors: [validated.error] }

  const text = await validated.file.text()
  const parsed = parseCsv(text)
  const { rows, dropped } = capRows(parsed)

  const result: ImportResult = { created: 0, updated: 0, skipped: 0, errors: [] }
  if (dropped > 0) {
    result.errors.push(`File has more than ${MAX_IMPORT_ROWS} rows — ${dropped} row(s) skipped`)
  }

  // Build parent lookup: sku → id
  const allProducts = await db.product.findMany({ select: { id: true, sku: true } })
  const skuToId = new Map(allProducts.map((p) => [p.sku, p.id]))

  // Track rows with components to process in second pass
  const componentRows: { lineNum: number; sku: string; components: string }[] = []
  const touchedProducts: Array<{ id: string; lifecycleStatus: 'ACTIVE' | 'NOT_FOR_SALE' | 'ARCHIVED' }> = []

  // Pass 1: Create/update non-VARIANT products first, then VARIANTs
  // Sort rows so parents come before children
  const sorted = [...rows].sort((a, b) => {
    const typeOrder: Record<string, number> = { VARIABLE: 0, SIMPLE: 1, NON_INVENTORY: 1, KIT: 2, BOM: 2, VARIANT: 3 }
    const aType = (a['type'] ?? '').trim().toUpperCase()
    const bType = (b['type'] ?? '').trim().toUpperCase()
    return (typeOrder[aType] ?? 1) - (typeOrder[bType] ?? 1)
  })

  for (let i = 0; i < sorted.length; i++) {
    const row = sorted[i]
    const lineNum = rows.indexOf(row) + 2

    const sku = row['sku']?.trim()
    const name = row['name']?.trim()
    const type = (row['type']?.trim().toUpperCase()) || 'SIMPLE'

    if (!sku) { result.errors.push(`Row ${lineNum}: missing sku`); result.skipped++; continue }
    if (!name) { result.errors.push(`Row ${lineNum}: missing name`); result.skipped++; continue }
    if (!VALID_TYPES.has(type)) {
      result.errors.push(`Row ${lineNum}: invalid type "${type}"`)
      result.skipped++
      continue
    }

    // Resolve parent for VARIANTs
    const parentSku = row['parentSku']?.trim() || row['parentsku']?.trim() || null
    let parentId: string | null = null
    if (type === 'VARIANT' && parentSku) {
      parentId = skuToId.get(parentSku) ?? null
      if (!parentId) {
        result.errors.push(`Row ${lineNum}: parent SKU "${parentSku}" not found — ensure VARIABLE parent is listed before its variants`)
        result.skipped++
        continue
      }
    }

    const lifecycleStatusRaw = row['lifecycleStatus']?.trim() || row['lifecyclestatus']?.trim() || null
    const lifecycleStatus = lifecycleStatusRaw === 'ACTIVE' || lifecycleStatusRaw === 'NOT_FOR_SALE' || lifecycleStatusRaw === 'ARCHIVED'
      ? lifecycleStatusRaw
      : deriveLifecycleStatusFromLegacyActive((row['active'] ?? 'TRUE').trim().toUpperCase() !== 'FALSE')

    const data = {
      name,
      description: row['description']?.trim() || null,
      type: type as ProductType,
      parentId,
      barcode: row['barcode']?.trim() || null,
      weight: row['weight']?.trim() || null,
      widthCm: row['widthCm']?.trim() || row['widthcm']?.trim() || null,
      heightCm: row['heightCm']?.trim() || row['heightcm']?.trim() || null,
      depthCm: row['depthCm']?.trim() || row['depthcm']?.trim() || null,
      salesPriceBase: row['salesPriceBase']?.trim() || row['salespricegbp']?.trim() || null,
      salePriceBase: row['salePriceBase']?.trim() || row['salepricegbp']?.trim() || null,
      salesPriceTaxInclusive: (row['salesPriceTaxInclusive'] ?? row['salespricetaxinclusive'] ?? '').trim().toUpperCase() === 'TRUE',
      stockUnit: row['stockUnit']?.trim() || row['stockunit']?.trim() || 'pcs',
      oversellAllowed: (row['oversellAllowed'] ?? row['oversellallowed'] ?? 'TRUE').trim().toUpperCase() !== 'FALSE',
      imageUrl: row['imageUrl']?.trim() || row['imageurl']?.trim() || null,
      active: deriveLegacyActiveFromLifecycleStatus(lifecycleStatus),
      lifecycleStatus,
    }

    try {
      const existing = skuToId.get(sku)
      if (existing) {
        await db.product.update({ where: { id: existing }, data })
        touchedProducts.push({ id: existing, lifecycleStatus })
        result.updated++
      } else {
        const created = await db.product.create({ data: { sku, ...data } })
        skuToId.set(sku, created.id)
        touchedProducts.push({ id: created.id, lifecycleStatus })
        result.created++
      }

      // Track components for second pass
      const componentsStr = (row['components'] ?? '').trim()
      if (componentsStr && (type === 'KIT' || type === 'BOM')) {
        componentRows.push({ lineNum, sku, components: componentsStr })
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      result.errors.push(`Row ${lineNum} (${sku}): ${msg}`)
      result.skipped++
    }
  }

  // Pass 2: Set up components for KIT/BOM products
  for (const cr of componentRows) {
    const productId = skuToId.get(cr.sku)
    if (!productId) continue

    // Parse "SKU1:qty;SKU2:qty" format
    const parts = cr.components.split(';').map((s) => s.trim()).filter(Boolean)
    const components: { componentId: string; qty: number }[] = []

    for (const part of parts) {
      const [compSku, qtyStr] = part.split(':').map((s) => s.trim())
      const componentId = skuToId.get(compSku)
      if (!componentId) {
        result.errors.push(`Row ${cr.lineNum}: component SKU "${compSku}" not found`)
        continue
      }
      const qty = parseFloat(qtyStr ?? '1')
      if (isNaN(qty) || qty <= 0) {
        result.errors.push(`Row ${cr.lineNum}: invalid qty for component "${compSku}"`)
        continue
      }
      components.push({ componentId, qty })
    }

    if (components.length > 0) {
      // Check for self-reference
      if (components.some((c) => c.componentId === productId)) {
        result.errors.push(`Row ${cr.lineNum}: ${cr.sku} cannot be a component of itself`)
        continue
      }

      // Check for circular references via BFS
      let hasCycle = false
      const visited = new Set<string>()
      const queue = components.map((c) => c.componentId)
      while (queue.length > 0) {
        const current = queue.shift()!
        if (current === productId) { hasCycle = true; break }
        if (visited.has(current)) continue
        visited.add(current)
        const children = await db.productComponent.findMany({ where: { productId: current }, select: { componentId: true } })
        for (const child of children) queue.push(child.componentId)
      }
      if (hasCycle) {
        result.errors.push(`Row ${cr.lineNum}: circular BOM reference detected for ${cr.sku}`)
        continue
      }

      try {
        await db.productComponent.deleteMany({ where: { productId } })
        await db.productComponent.createMany({
          data: components.map((c, i) => ({
            productId,
            componentId: c.componentId,
            qty: c.qty,
            sortOrder: i,
          })),
        })
        const product = touchedProducts.find((entry) => entry.id === productId)
        if (!product) {
          const lifecycleRow = await db.product.findUnique({
            where: { id: productId },
            select: { lifecycleStatus: true },
          })
          if (lifecycleRow) {
            touchedProducts.push({ id: productId, lifecycleStatus: lifecycleRow.lifecycleStatus })
          }
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        result.errors.push(`Components for ${cr.sku}: ${msg}`)
      }
    }
  }

  const syncTargets = [...new Map(touchedProducts.map((entry) => [entry.id, entry])).values()]
  for (const target of syncTargets) {
    try {
      await pushProductMetadata(target.id)
    } catch (syncError) {
      console.error(syncError)
    }
    try {
      await enqueueStockSync([target.id], 'IMS_CHANGE', {
        force: target.lifecycleStatus === 'ARCHIVED',
      })
    } catch (syncError) {
      console.error(syncError)
    }
  }

  revalidatePath('/inventory')
  if (result.errors.length > 0 && result.created === 0 && result.updated === 0) {
    await logActivity({ entityType: 'IMPORT', tag: 'import', action: 'imported', level: 'ERROR', description: `Failed to import products from CSV: ${result.errors[0]}` })
  } else {
    await logActivity({ entityType: 'IMPORT', tag: 'import', action: 'imported', description: `Imported ${result.created} products, updated ${result.updated} from CSV` })
  }
  return result
}

// ---------------------------------------------------------------------------
// Adjustments CSV import
// ---------------------------------------------------------------------------

export async function importAdjustmentsCsv(formData: FormData): Promise<ImportResult> {
  const validated = await validateImportFile(formData, 'stock_control.adjust')
  if ('error' in validated) return { created: 0, updated: 0, skipped: 0, errors: [validated.error] }

  const text = await validated.file.text()
  const parsed = parseCsv(text)
  const { rows, dropped } = capRows(parsed)

  const result: ImportResult = { created: 0, updated: 0, skipped: 0, errors: [] }
  if (dropped > 0) {
    result.errors.push(`File has more than ${MAX_IMPORT_ROWS} rows — ${dropped} row(s) skipped`)
  }

  // Build lookup maps
  const products = await db.product.findMany({ select: { id: true, sku: true } })
  const skuToId = new Map(products.map((p) => [p.sku, p.id]))

  const warehouses = await db.warehouse.findMany({ select: { id: true, code: true } })
  const codeToWarehouseId = new Map(warehouses.map((w) => [w.code.toUpperCase(), w.id]))

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const lineNum = i + 2

    const sku = row['sku']?.trim()
    const warehouseCode = row['warehouseCode']?.trim().toUpperCase()
    const qtyStr = row['qty']?.trim()
    const note = row['note']?.trim() || null

    if (!sku) { result.errors.push(`Row ${lineNum}: missing sku`); result.skipped++; continue }
    if (!warehouseCode) { result.errors.push(`Row ${lineNum}: missing warehouseCode`); result.skipped++; continue }
    if (!qtyStr || isNaN(Number(qtyStr)) || Number(qtyStr) === 0) {
      result.errors.push(`Row ${lineNum}: invalid or zero qty`)
      result.skipped++
      continue
    }

    const productId = skuToId.get(sku)
    if (!productId) { result.errors.push(`Row ${lineNum}: SKU "${sku}" not found`); result.skipped++; continue }

    const warehouseId = codeToWarehouseId.get(warehouseCode)
    if (!warehouseId) { result.errors.push(`Row ${lineNum}: warehouse "${warehouseCode}" not found`); result.skipped++; continue }

    const qty = Number(qtyStr)
    const isAddition = qty > 0
    const absQty = Math.abs(qty).toString()

    try {
      await db.$transaction(async (tx) => {
        await tx.stockMovement.create({
          data: {
            type: 'ADJUSTMENT',
            productId,
            fromWarehouseId: isAddition ? null : warehouseId,
            toWarehouseId: isAddition ? warehouseId : null,
            qty: absQty,
            note,
          },
        })
        await tx.stockLevel.upsert({
          where: { productId_warehouseId: { productId, warehouseId } },
          create: { productId, warehouseId, quantity: isAddition ? absQty : `-${absQty}` },
          update: { quantity: { increment: qty } },
        })
      })
      result.created++
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      result.errors.push(`Row ${lineNum} (${sku}): ${msg}`)
      result.skipped++
    }
  }

  revalidatePath('/stock-control')
  revalidatePath('/inventory')
  if (result.created > 0) {
    await logActivity({ entityType: 'IMPORT', tag: 'import', action: 'imported', description: `Imported ${result.created} stock adjustments from CSV` })
  } else if (result.errors.length > 0) {
    await logActivity({ entityType: 'IMPORT', tag: 'import', action: 'imported', level: 'ERROR', description: `Failed to import stock adjustments from CSV: ${result.errors[0]}` })
  }
  return result
}

// ---------------------------------------------------------------------------
// Warehouse Transfers CSV import
// ---------------------------------------------------------------------------

export async function importTransfersCsv(formData: FormData): Promise<ImportResult> {
  const validated = await validateImportFile(formData, 'stock_control.transfer')
  if ('error' in validated) return { created: 0, updated: 0, skipped: 0, errors: [validated.error] }

  const parsed = parseCsv(await validated.file.text())
  const { rows, dropped } = capRows(parsed)
  const result: ImportResult = { created: 0, updated: 0, skipped: 0, errors: [] }
  if (dropped > 0) {
    result.errors.push(`File has more than ${MAX_IMPORT_ROWS} rows — ${dropped} row(s) skipped`)
  }

  const products = await db.product.findMany({ select: { id: true, sku: true } })
  const skuToId = new Map(products.map((p) => [p.sku.toUpperCase(), p.id]))
  const warehouses = await db.warehouse.findMany({ select: { id: true, code: true } })
  const codeToWh = new Map(warehouses.map((w) => [w.code.toUpperCase(), w.id]))

  // Group by from+to warehouse to create one transfer per pair
  const groups = new Map<string, { fromId: string; toId: string; notes: string; lines: { productId: string; sku: string; name: string; qty: number }[] }>()

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const lineNum = i + 2
    const fromCode = (row['fromWarehouseCode'] ?? row['fromwarehousecode'] ?? '').trim().toUpperCase()
    const toCode = (row['toWarehouseCode'] ?? row['towarehousecode'] ?? '').trim().toUpperCase()
    const sku = (row['sku'] ?? '').trim()
    const qty = Number(row['qty'] ?? 0)

    if (!fromCode || !toCode || !sku || qty <= 0) { result.errors.push(`Row ${lineNum}: missing required fields`); result.skipped++; continue }
    const fromId = codeToWh.get(fromCode)
    const toId = codeToWh.get(toCode)
    if (!fromId) { result.errors.push(`Row ${lineNum}: warehouse "${fromCode}" not found`); result.skipped++; continue }
    if (!toId) { result.errors.push(`Row ${lineNum}: warehouse "${toCode}" not found`); result.skipped++; continue }
    const productId = skuToId.get(sku.toUpperCase())
    if (!productId) { result.errors.push(`Row ${lineNum}: SKU "${sku}" not found`); result.skipped++; continue }

    const key = `${fromId}:${toId}`
    if (!groups.has(key)) groups.set(key, { fromId, toId, notes: row['notes'] ?? '', lines: [] })
    groups.get(key)!.lines.push({ productId, sku, name: sku, qty })
  }

  for (const g of groups.values()) {
    try {
      const ref = `TRF-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
      await db.stockTransfer.create({
        data: {
          reference: ref,
          fromWarehouseId: g.fromId,
          toWarehouseId: g.toId,
          notes: g.notes || null,
          lines: { create: g.lines.map((l) => ({ productId: l.productId, sku: l.sku, productName: l.name, qty: l.qty })) },
        },
      })
      result.created += g.lines.length
    } catch (e: unknown) {
      result.errors.push(String(e))
      result.skipped += g.lines.length
    }
  }

  revalidatePath('/stock-control/transfers')
  if (result.created > 0) {
    await logActivity({ entityType: 'IMPORT', tag: 'import', action: 'imported', description: `Imported ${result.created} transfers from CSV` })
  } else if (result.errors.length > 0) {
    await logActivity({ entityType: 'IMPORT', tag: 'import', action: 'imported', level: 'ERROR', description: `Failed to import transfers from CSV: ${result.errors[0]}` })
  }
  return result
}

// ---------------------------------------------------------------------------
// Sales Orders CSV import
// ---------------------------------------------------------------------------

export async function importSalesOrdersCsv(formData: FormData): Promise<ImportResult> {
  const validated = await validateImportFile(formData, 'sales.create')
  if ('error' in validated) return { created: 0, updated: 0, skipped: 0, errors: [validated.error] }
  const baseCurrency = await getBaseCurrencyCode()

  const parsed = parseCsv(await validated.file.text())
  const { rows, dropped } = capRows(parsed)
  const result: ImportResult = { created: 0, updated: 0, skipped: 0, errors: [] }
  if (dropped > 0) {
    result.errors.push(`File has more than ${MAX_IMPORT_ROWS} rows — ${dropped} row(s) skipped`)
  }

  const products = await db.product.findMany({ select: { id: true, sku: true, name: true, salesPriceBase: true } })
  const skuMap = new Map(products.map((p) => [p.sku.toUpperCase(), p]))

  // Group rows by customerName to create one order per customer
  const groups = new Map<string, { customerName: string; currency: string; notes: string; lines: { productId: string; sku: string; description: string; qty: number; unitPrice: number }[] }>()

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const lineNum = i + 2
    const customerName = (row['customerName'] ?? row['customername'] ?? row['customer'] ?? '').trim()
    const sku = (row['sku'] ?? '').trim()
    const qty = Number(row['qty'] ?? 1)
    const unitPrice = Number(row['unitPrice'] ?? row['unitprice'] ?? row['price'] ?? 0)

    if (!customerName) { result.errors.push(`Row ${lineNum}: missing customerName`); result.skipped++; continue }
    if (!sku) { result.errors.push(`Row ${lineNum}: missing sku`); result.skipped++; continue }

    const product = skuMap.get(sku.toUpperCase())
    if (!product) { result.errors.push(`Row ${lineNum}: SKU "${sku}" not found`); result.skipped++; continue }

    const price = unitPrice || (product.salesPriceBase ? Number(product.salesPriceBase) : 0)
    const currency = (row['currency'] ?? baseCurrency).trim()

    const key = customerName
    if (!groups.has(key)) groups.set(key, { customerName, currency, notes: row['notes'] ?? '', lines: [] })
    groups.get(key)!.lines.push({ productId: product.id, sku: product.sku, description: product.name, qty, unitPrice: price })
  }

  for (const g of groups.values()) {
    try {
      let subtotalForeign = 0
      const lineData = g.lines.map((l) => {
        const total = l.qty * l.unitPrice
        subtotalForeign += total
        return { productId: l.productId, sku: l.sku, description: l.description, qty: l.qty, unitPriceForeign: l.unitPrice, unitPriceBase: l.unitPrice, taxForeign: 0, taxBase: 0, totalForeign: total, totalBase: total }
      })
      const ref = `SO-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
      const so = await db.salesOrder.create({
        data: {
          orderNumber: ref, status: 'DRAFT', currency: g.currency, fxRateToBase: 1,
          customerName: g.customerName, subtotalForeign, shippingForeign: 0, taxForeign: 0,
          totalForeign: subtotalForeign, subtotalBase: subtotalForeign, shippingBase: 0, taxBase: 0, totalBase: subtotalForeign,
          notes: g.notes || null,
          lines: { create: lineData },
        },
      })
      // Auto-allocate stock
      const { autoAllocateOrder } = await import('./allocation')
      await autoAllocateOrder(so.id)
      result.created += g.lines.length
    } catch (e: unknown) {
      result.errors.push(String(e))
      result.skipped += g.lines.length
    }
  }

  revalidatePath('/sales')
  if (result.created > 0) {
    await logActivity({ entityType: 'IMPORT', tag: 'import', action: 'imported', description: `Imported ${result.created} sales orders from CSV` })
  } else if (result.errors.length > 0) {
    await logActivity({ entityType: 'IMPORT', tag: 'import', action: 'imported', level: 'ERROR', description: `Failed to import sales orders from CSV: ${result.errors[0]}` })
  }
  return result
}

// ---------------------------------------------------------------------------
// Purchase Orders CSV import
// ---------------------------------------------------------------------------

export async function importPurchaseOrdersCsv(formData: FormData): Promise<ImportResult> {
  const validated = await validateImportFile(formData, 'purchasing.create')
  if ('error' in validated) return { created: 0, updated: 0, skipped: 0, errors: [validated.error] }
  const baseCurrency = await getBaseCurrencyCode()

  const parsed = parseCsv(await validated.file.text())
  const { rows, dropped } = capRows(parsed)
  const result: ImportResult = { created: 0, updated: 0, skipped: 0, errors: [] }
  if (dropped > 0) {
    result.errors.push(`File has more than ${MAX_IMPORT_ROWS} rows — ${dropped} row(s) skipped`)
  }

  const products = await db.product.findMany({ select: { id: true, sku: true } })
  const skuMap = new Map(products.map((p) => [p.sku.toUpperCase(), p.id]))
  const suppliers = await db.supplier.findMany({ select: { id: true, name: true, currency: true } })
  const supplierMap = new Map(suppliers.map((s) => [s.name.toUpperCase(), s]))

  // Group by supplierName
  const groups = new Map<string, { supplierId: string; currency: string; notes: string; lines: { productId: string; qty: number; unitCostForeign: number }[] }>()

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const lineNum = i + 2
    const supplierName = (row['supplierName'] ?? row['suppliername'] ?? row['supplier'] ?? '').trim()
    const sku = (row['sku'] ?? '').trim()
    const qty = Number(row['qty'] ?? 1)
    const unitCost = Number(row['unitCostForeign'] ?? row['unitcostforeign'] ?? row['unitcost'] ?? row['cost'] ?? 0)

    if (!supplierName) { result.errors.push(`Row ${lineNum}: missing supplierName`); result.skipped++; continue }
    if (!sku) { result.errors.push(`Row ${lineNum}: missing sku`); result.skipped++; continue }

    const supplier = supplierMap.get(supplierName.toUpperCase())
    if (!supplier) { result.errors.push(`Row ${lineNum}: supplier "${supplierName}" not found`); result.skipped++; continue }
    const productId = skuMap.get(sku.toUpperCase())
    if (!productId) { result.errors.push(`Row ${lineNum}: SKU "${sku}" not found`); result.skipped++; continue }

    const currency = (row['currency'] ?? supplier.currency ?? baseCurrency).trim()
    const key = supplierName.toUpperCase()
    if (!groups.has(key)) groups.set(key, { supplierId: supplier.id, currency, notes: row['notes'] ?? '', lines: [] })
    groups.get(key)!.lines.push({ productId, qty, unitCostForeign: unitCost })
  }

  for (const g of groups.values()) {
    try {
      let subtotalForeign = 0
      const lineData = g.lines.map((l, i) => {
        const total = l.qty * l.unitCostForeign
        subtotalForeign += total
        return { productId: l.productId, qty: l.qty, unitCostForeign: l.unitCostForeign, unitCostBase: l.unitCostForeign, taxForeign: 0, taxBase: 0, totalForeign: total, totalBase: total, sortOrder: i }
      })
      const ref = `PO-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
      await db.purchaseOrder.create({
        data: {
          reference: ref, type: 'GOODS', supplierId: g.supplierId, currency: g.currency, fxRateToBase: 1,
          subtotalForeign, subtotalBase: subtotalForeign, taxForeign: 0, taxBase: 0,
          totalForeign: subtotalForeign, totalBase: subtotalForeign,
          notes: g.notes || null,
          lines: { create: lineData },
        },
      })
      result.created += g.lines.length
    } catch (e: unknown) {
      result.errors.push(String(e))
      result.skipped += g.lines.length
    }
  }

  revalidatePath('/purchase-orders')
  if (result.created > 0) {
    await logActivity({ entityType: 'IMPORT', tag: 'import', action: 'imported', description: `Imported ${result.created} purchase orders from CSV` })
  } else if (result.errors.length > 0) {
    await logActivity({ entityType: 'IMPORT', tag: 'import', action: 'imported', level: 'ERROR', description: `Failed to import purchase orders from CSV: ${result.errors[0]}` })
  }
  return result
}
