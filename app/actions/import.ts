'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { parseCsv } from '@/lib/csv'
import { ProductType } from '@/app/generated/prisma/client'
import { logActivity } from '@/lib/activity-log'
import { requirePermission } from '@/lib/auth/server'
import { enqueueStockSync, pushProductMetadata } from '@/lib/shopping'
import { deriveLegacyActiveFromLifecycleStatus, deriveLifecycleStatusFromLegacyActive } from '@/lib/products/lifecycle'
import { validateProductStructureChange } from '@/lib/products/type-transforms'
import type { Permission } from '@/lib/auth/server'
import { getBaseCurrencyCode } from '@/lib/base-currency'
import {
  createCsvImportExecutionResult,
  createCsvImportPreviewResult,
  getCsvImportMode,
  type CsvImportActionResult,
  type CsvImportExecutionResult,
} from '@/lib/csv-import'

export type ImportResult = CsvImportExecutionResult

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

function buildImportPreviewResult(
  totalRows: number,
  result: { created: number; updated: number; skipped: number; errors: string[] },
  dropped: number,
  error?: string,
) {
  return createCsvImportPreviewResult({
    totalRows,
    created: result.created,
    updated: result.updated,
    errorCount: result.skipped + dropped,
    errors: result.errors,
    error,
  })
}

function readCsvValue(row: Record<string, string>, ...keys: string[]): string {
  let fallback = ''
  for (const key of keys) {
    const value = row[key]
    if (typeof value === 'string') {
      if (value.trim()) return value
      if (!fallback) fallback = value
    }
  }
  return fallback
}

function hasCsvValue(row: Record<string, string>, ...keys: string[]): boolean {
  return keys.some((key) => typeof row[key] === 'string' && row[key].trim().length > 0)
}

function parseOptionalNumber(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

function parseCsvBoolean(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'y'
}

function normalizeTaxRateValue(value: number | null): number | undefined {
  if (value === null || value <= 0) return undefined
  return value > 1 ? value / 100 : value
}

function getFxRateForCurrency(lineNum: number, currency: string, baseCurrency: string, rawFxRate: string): { fxRate: number | null; error?: string } {
  const parsed = parseOptionalNumber(rawFxRate)
  if (currency.toUpperCase() === baseCurrency.toUpperCase()) {
    if (parsed !== null && parsed <= 0) {
      return { fxRate: null, error: `Row ${lineNum}: fxRateToBase must be greater than zero` }
    }
    return { fxRate: parsed && parsed > 0 ? parsed : 1 }
  }
  if (parsed === null || parsed <= 0) {
    return { fxRate: null, error: `Row ${lineNum}: fxRateToBase is required for non-base currency ${currency}` }
  }
  return { fxRate: parsed }
}

type TaxRateLookupRow = {
  id: string
  name: string
  rate: number
  usedFor: string
  active: boolean
}

function resolveImportedTaxRateId(
  taxRates: TaxRateLookupRow[],
  usedFor: 'SALES' | 'PURCHASE',
  name: string | undefined,
  rate: number | undefined,
): string | undefined {
  if (!name && rate === undefined) return undefined
  const eligible = taxRates.filter((taxRate) => taxRate.active && (taxRate.usedFor === usedFor || taxRate.usedFor === 'BOTH'))
  const normalizedName = name?.trim().toLowerCase()
  if (normalizedName) {
    const byName = eligible.find((taxRate) => taxRate.name.trim().toLowerCase() === normalizedName)
    if (byName) return byName.id
  }
  if (rate !== undefined) {
    const byRate = eligible.find((taxRate) => Math.abs(taxRate.rate - rate) < 0.00005)
    if (byRate) return byRate.id
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Products CSV import
// ---------------------------------------------------------------------------

const VALID_TYPES = new Set<string>(['SIMPLE', 'VARIABLE', 'VARIANT', 'KIT', 'BOM', 'NON_INVENTORY'])

export async function importProductsCsv(formData: FormData): Promise<CsvImportActionResult> {
  const mode = getCsvImportMode(formData)
  const preview = mode === 'preview'
  const validated = await validateImportFile(formData, 'inventory.edit')
  if ('error' in validated) {
    const result = { created: 0, updated: 0, skipped: 0, errors: [validated.error] }
    return preview
      ? buildImportPreviewResult(0, result, 0, validated.error)
      : createCsvImportExecutionResult({ ...result, error: validated.error, success: false })
  }

  const text = await validated.file.text()
  const parsed = parseCsv(text)
  const { rows, dropped } = capRows(parsed)

  const result: ImportResult = { created: 0, updated: 0, skipped: 0, errors: [] }
  if (dropped > 0) {
    result.errors.push(`File has more than ${MAX_IMPORT_ROWS} rows — ${dropped} row(s) skipped`)
  }

  // Build parent lookup: sku → id
  const allProducts = await db.product.findMany({
    select: { id: true, sku: true, barcode: true, type: true, parentId: true, lifecycleStatus: true },
  })
  const skuToId = new Map(allProducts.map((p) => [p.sku, p.id]))
  const productById = new Map(allProducts.map((p) => [p.id, p]))
  const barcodeToId = new Map(
    allProducts
      .filter((product) => product.barcode)
      .map((product) => [product.barcode as string, product.id]),
  )
  const productIdToBarcode = new Map(
    allProducts.map((product) => [product.id, product.barcode ?? null]),
  )

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

    const productIdFromRow = readCsvValue(row, 'productId', 'productid').trim() || null
    const sku = row['sku']?.trim()
    const existingId = productIdFromRow
      ? (productById.get(productIdFromRow)?.id ?? null)
      : (sku ? (skuToId.get(sku) ?? null) : null)
    const existingProduct = existingId ? productById.get(existingId) ?? null : null
    const name = row['name']?.trim()
    const rawType = row['type']?.trim().toUpperCase()
    const type = rawType || existingProduct?.type || 'SIMPLE'

    if (productIdFromRow && !existingProduct) { result.errors.push(`Row ${lineNum}: productId "${productIdFromRow}" not found`); result.skipped++; continue }
    if (!sku) { result.errors.push(`Row ${lineNum}: missing sku`); result.skipped++; continue }
    if (!name && !existingProduct) { result.errors.push(`Row ${lineNum}: missing name`); result.skipped++; continue }
    if (!VALID_TYPES.has(type)) {
      result.errors.push(`Row ${lineNum}: invalid type "${rawType ?? type}"`)
      result.skipped++
      continue
    }

    // Resolve parent for VARIANTs
    const parentSku = row['parentSku']?.trim() || row['parentsku']?.trim() || null
    const parentProductId = readCsvValue(row, 'parentProductId', 'parentproductid').trim() || null
    let parentId: string | null = existingProduct?.parentId ?? null
    if (parentProductId) {
      parentId = productById.get(parentProductId)?.id ?? null
      if (!parentId) {
        result.errors.push(`Row ${lineNum}: parent productId "${parentProductId}" not found`)
        result.skipped++
        continue
      }
    } else if (parentSku) {
      parentId = skuToId.get(parentSku) ?? null
      if (!parentId) {
        result.errors.push(`Row ${lineNum}: parent SKU "${parentSku}" not found — ensure the VARIABLE parent is listed before its child products`)
        result.skipped++
        continue
      }
    }

    const lifecycleStatusRaw = row['lifecycleStatus']?.trim() || row['lifecyclestatus']?.trim() || null
    const lifecycleStatus = lifecycleStatusRaw === 'ACTIVE' || lifecycleStatusRaw === 'NOT_FOR_SALE' || lifecycleStatusRaw === 'ARCHIVED'
      ? lifecycleStatusRaw
      : hasCsvValue(row, 'active')
        ? deriveLifecycleStatusFromLegacyActive((row['active'] ?? 'TRUE').trim().toUpperCase() !== 'FALSE')
        : existingProduct?.lifecycleStatus ?? deriveLifecycleStatusFromLegacyActive(true)

      try {
        const barcode = hasCsvValue(row, 'barcode') ? row['barcode']!.trim() : undefined
      if (barcode) {
        const barcodeOwner = barcodeToId.get(barcode)
        if (barcodeOwner && barcodeOwner !== existingId) {
          result.errors.push(`Row ${lineNum} (${sku}): barcode "${barcode}" is already in use`)
          result.skipped++
          continue
        }
      }

      if (existingProduct) {
        const updateData: Record<string, unknown> = {}
        if (name) updateData.name = name
        if (hasCsvValue(row, 'description')) updateData.description = row['description']!.trim()
        if (rawType) updateData.type = type as ProductType
        if (parentProductId || parentSku) updateData.parentId = parentId
        if (barcode) updateData.barcode = barcode
        if (hasCsvValue(row, 'weight')) updateData.weight = row['weight']!.trim()
        if (hasCsvValue(row, 'widthCm', 'widthcm')) updateData.widthCm = readCsvValue(row, 'widthCm', 'widthcm').trim()
        if (hasCsvValue(row, 'heightCm', 'heightcm')) updateData.heightCm = readCsvValue(row, 'heightCm', 'heightcm').trim()
        if (hasCsvValue(row, 'depthCm', 'depthcm')) updateData.depthCm = readCsvValue(row, 'depthCm', 'depthcm').trim()
        if (hasCsvValue(row, 'salesPriceBase', 'salespricegbp')) updateData.salesPriceBase = readCsvValue(row, 'salesPriceBase', 'salespricegbp').trim()
        if (hasCsvValue(row, 'salePriceBase', 'salepricegbp')) updateData.salePriceBase = readCsvValue(row, 'salePriceBase', 'salepricegbp').trim()
        if (hasCsvValue(row, 'salesPriceTaxInclusive', 'salespricetaxinclusive')) updateData.salesPriceTaxInclusive = parseCsvBoolean(readCsvValue(row, 'salesPriceTaxInclusive', 'salespricetaxinclusive'))
        if (hasCsvValue(row, 'stockUnit', 'stockunit')) updateData.stockUnit = readCsvValue(row, 'stockUnit', 'stockunit').trim()
        if (hasCsvValue(row, 'oversellAllowed', 'oversellallowed')) updateData.oversellAllowed = parseCsvBoolean(readCsvValue(row, 'oversellAllowed', 'oversellallowed'))
        if (hasCsvValue(row, 'imageUrl', 'imageurl')) updateData.imageUrl = readCsvValue(row, 'imageUrl', 'imageurl').trim()
        if (lifecycleStatusRaw || hasCsvValue(row, 'active')) {
          updateData.active = deriveLegacyActiveFromLifecycleStatus(lifecycleStatus)
          updateData.lifecycleStatus = lifecycleStatus
        }

        const requestedParentId = (updateData.parentId as string | null | undefined) ?? existingProduct.parentId
        const previewParent = requestedParentId ? (productById.get(requestedParentId) ?? null) : null
        const structureValidation = preview && requestedParentId && previewParent && previewParent.type === ProductType.VARIABLE
          ? {
              ok: true as const,
              current: existingProduct,
              normalizedParentId: requestedParentId,
              clearComponents: existingProduct.type === ProductType.KIT || existingProduct.type === ProductType.BOM
                ? !(((updateData.type as ProductType | undefined) ?? existingProduct.type) === ProductType.KIT || ((updateData.type as ProductType | undefined) ?? existingProduct.type) === ProductType.BOM)
                : false,
              clearExternalMapping: existingProduct.type !== (((updateData.type as ProductType | undefined) ?? existingProduct.type))
                || existingProduct.parentId !== requestedParentId,
            }
          : await validateProductStructureChange({
              productId: existingProduct.id,
              type: (updateData.type as ProductType | undefined) ?? existingProduct.type,
              parentId: requestedParentId,
            })
        if (!structureValidation.ok) {
          result.errors.push(`Row ${lineNum} (${sku}): ${structureValidation.message}`)
          result.skipped++
          continue
        }

        if (!preview) {
          await db.$transaction(async (tx) => {
            await tx.product.update({
              where: { id: existingProduct.id },
              data: {
                ...updateData,
                ...(sku !== existingProduct.sku ? { sku } : {}),
                parentId: structureValidation.normalizedParentId,
                ...(structureValidation.clearExternalMapping ? { externalProductId: null } : {}),
              },
            })
            if (structureValidation.clearComponents) {
              await tx.productComponent.deleteMany({ where: { productId: existingProduct.id } })
            }
          })
        }
        if (existingProduct.sku !== sku) {
          skuToId.delete(existingProduct.sku)
          skuToId.set(sku, existingProduct.id)
        }
        const previousBarcode = productIdToBarcode.get(existingProduct.id) ?? null
        if (previousBarcode && previousBarcode !== barcode) {
          barcodeToId.delete(previousBarcode)
        }
        if (barcode) {
          barcodeToId.set(barcode, existingProduct.id)
        }
        productIdToBarcode.set(existingProduct.id, barcode ?? previousBarcode)
        productById.set(existingProduct.id, {
          ...existingProduct,
          sku,
          barcode: barcode ?? previousBarcode,
          type: ((updateData.type as ProductType | undefined) ?? existingProduct.type),
          parentId: structureValidation.normalizedParentId,
          lifecycleStatus,
        })
        touchedProducts.push({ id: existingProduct.id, lifecycleStatus })
        result.updated++
      } else {
        const createData = {
          sku,
          name,
          description: hasCsvValue(row, 'description') ? row['description']!.trim() : null,
          type: type as ProductType,
          parentId,
          barcode: barcode ?? null,
          weight: hasCsvValue(row, 'weight') ? row['weight']!.trim() : null,
          widthCm: hasCsvValue(row, 'widthCm', 'widthcm') ? readCsvValue(row, 'widthCm', 'widthcm').trim() : null,
          heightCm: hasCsvValue(row, 'heightCm', 'heightcm') ? readCsvValue(row, 'heightCm', 'heightcm').trim() : null,
          depthCm: hasCsvValue(row, 'depthCm', 'depthcm') ? readCsvValue(row, 'depthCm', 'depthcm').trim() : null,
          salesPriceBase: hasCsvValue(row, 'salesPriceBase', 'salespricegbp') ? readCsvValue(row, 'salesPriceBase', 'salespricegbp').trim() : null,
          salePriceBase: hasCsvValue(row, 'salePriceBase', 'salepricegbp') ? readCsvValue(row, 'salePriceBase', 'salepricegbp').trim() : null,
          salesPriceTaxInclusive: hasCsvValue(row, 'salesPriceTaxInclusive', 'salespricetaxinclusive') ? parseCsvBoolean(readCsvValue(row, 'salesPriceTaxInclusive', 'salespricetaxinclusive')) : false,
          stockUnit: hasCsvValue(row, 'stockUnit', 'stockunit') ? readCsvValue(row, 'stockUnit', 'stockunit').trim() : 'pcs',
          oversellAllowed: hasCsvValue(row, 'oversellAllowed', 'oversellallowed') ? parseCsvBoolean(readCsvValue(row, 'oversellAllowed', 'oversellallowed')) : true,
          imageUrl: hasCsvValue(row, 'imageUrl', 'imageurl') ? readCsvValue(row, 'imageUrl', 'imageurl').trim() : null,
          active: deriveLegacyActiveFromLifecycleStatus(lifecycleStatus),
          lifecycleStatus,
        }
        const previewParent = createData.parentId ? (productById.get(createData.parentId) ?? null) : null
        const structureValidation = preview && createData.parentId && previewParent
          ? previewParent.type === ProductType.VARIABLE
            ? {
                ok: true as const,
                current: null,
                normalizedParentId: createData.parentId,
                clearComponents: false,
                clearExternalMapping: false,
              }
            : {
                ok: false as const,
                fieldErrors: { parentId: ['Parent product must be an existing variable product'] },
                message: 'Parent product must be an existing variable product',
              }
          : await validateProductStructureChange({
              type: createData.type,
              parentId: createData.parentId,
            })
        if (!structureValidation.ok) {
          result.errors.push(`Row ${lineNum} (${sku}): ${structureValidation.message}`)
          result.skipped++
          continue
        }

        const created = preview
          ? {
              id: `preview-product:${sku}`,
              sku,
              barcode: barcode ?? null,
              type: createData.type,
              parentId: structureValidation.normalizedParentId,
              lifecycleStatus,
            }
          : await db.product.create({
              data: {
                ...createData,
                parentId: structureValidation.normalizedParentId,
              },
            })
        skuToId.set(sku, created.id)
        if (barcode) {
          barcodeToId.set(barcode, created.id)
        }
        productIdToBarcode.set(created.id, barcode ?? null)
        productById.set(created.id, {
          id: created.id,
          sku: created.sku,
          barcode: created.barcode,
          type: created.type,
          parentId: created.parentId,
          lifecycleStatus: created.lifecycleStatus,
        })
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
    let hasComponentError = false

    for (const part of parts) {
      const [compSku, qtyStr] = part.split(':').map((s) => s.trim())
      const componentId = skuToId.get(compSku)
      if (!componentId) {
        result.errors.push(`Row ${cr.lineNum}: component SKU "${compSku}" not found`)
        hasComponentError = true
        continue
      }
      const qty = parseFloat(qtyStr ?? '1')
      if (isNaN(qty) || qty <= 0) {
        result.errors.push(`Row ${cr.lineNum}: invalid qty for component "${compSku}"`)
        hasComponentError = true
        continue
      }
      components.push({ componentId, qty })
    }

    if (hasComponentError) {
      result.errors.push(`Row ${cr.lineNum}: ${cr.sku} components were not updated because one or more component values were invalid`)
      continue
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
        if (!preview) {
          await db.$transaction(async (tx) => {
            await tx.productComponent.deleteMany({ where: { productId } })
            await tx.productComponent.createMany({
              data: components.map((c, i) => ({
                productId,
                componentId: c.componentId,
                qty: c.qty,
                sortOrder: i,
              })),
            })
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
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        result.errors.push(`Components for ${cr.sku}: ${msg}`)
      }
    }
  }

  const syncTargets = [...new Map(touchedProducts.map((entry) => [entry.id, entry])).values()]
  if (preview) {
    return buildImportPreviewResult(rows.length + dropped, result, dropped)
  }

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
  return createCsvImportExecutionResult(result)
}

// ---------------------------------------------------------------------------
// Adjustments CSV import
// ---------------------------------------------------------------------------

export async function importAdjustmentsCsv(formData: FormData): Promise<CsvImportActionResult> {
  const mode = getCsvImportMode(formData)
  const preview = mode === 'preview'
  const validated = await validateImportFile(formData, 'stock_control.adjust')
  if ('error' in validated) {
    const result = { created: 0, updated: 0, skipped: 0, errors: [validated.error] }
    return preview
      ? buildImportPreviewResult(0, result, 0, validated.error)
      : createCsvImportExecutionResult({ ...result, error: validated.error, success: false })
  }

  const text = await validated.file.text()
  const parsed = parseCsv(text)
  const { rows, dropped } = capRows(parsed)

  const result: ImportResult = { created: 0, updated: 0, skipped: 0, errors: [] }
  if (dropped > 0) {
    result.errors.push(`File has more than ${MAX_IMPORT_ROWS} rows — ${dropped} row(s) skipped`)
  }

  // Build lookup maps
  const products = await db.product.findMany({ select: { id: true, sku: true, name: true } })
  const skuToId = new Map(products.map((p) => [p.sku, p.id]))

  const warehouses = await db.warehouse.findMany({ select: { id: true, code: true } })
  const codeToWarehouseId = new Map(warehouses.map((w) => [w.code.toUpperCase(), w.id]))
  const { applyStockAdjustment } = await import('./stock')

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

    try {
      if (!preview) {
        await db.$transaction(async (tx) => {
          await applyStockAdjustment({
            tx,
            productId,
            warehouseId,
            qty,
            note,
          })
        })
      }
      result.created++
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      result.errors.push(`Row ${lineNum} (${sku}): ${msg}`)
      result.skipped++
    }
  }

  if (preview) {
    return buildImportPreviewResult(rows.length + dropped, result, dropped)
  }

  revalidatePath('/stock-control')
  revalidatePath('/inventory')
  if (result.created > 0) {
    await logActivity({ entityType: 'IMPORT', tag: 'import', action: 'imported', description: `Imported ${result.created} stock adjustments from CSV` })
  } else if (result.errors.length > 0) {
    await logActivity({ entityType: 'IMPORT', tag: 'import', action: 'imported', level: 'ERROR', description: `Failed to import stock adjustments from CSV: ${result.errors[0]}` })
  }
  return createCsvImportExecutionResult(result)
}

// ---------------------------------------------------------------------------
// Opening stock CSV import
// ---------------------------------------------------------------------------

export async function importOpeningStockCsv(formData: FormData): Promise<CsvImportActionResult> {
  const mode = getCsvImportMode(formData)
  const preview = mode === 'preview'
  const validated = await validateImportFile(formData, 'stock_control.adjust')
  if ('error' in validated) {
    const result = { created: 0, updated: 0, skipped: 0, errors: [validated.error] }
    return preview
      ? buildImportPreviewResult(0, result, 0, validated.error)
      : createCsvImportExecutionResult({ ...result, error: validated.error, success: false })
  }

  const text = await validated.file.text()
  const parsed = parseCsv(text)
  const { rows, dropped } = capRows(parsed)

  const result: ImportResult = { created: 0, updated: 0, skipped: 0, errors: [] }
  if (dropped > 0) {
    result.errors.push(`File has more than ${MAX_IMPORT_ROWS} rows — ${dropped} row(s) skipped`)
  }

  const products = await db.product.findMany({
    select: { id: true, sku: true, type: true },
  })
  const skuToProduct = new Map(products.map((product) => [product.sku.toUpperCase(), product]))

  const warehouses = await db.warehouse.findMany({
    select: { id: true, code: true },
  })
  const codeToWarehouseId = new Map(warehouses.map((warehouse) => [warehouse.code.toUpperCase(), warehouse.id]))

  const stagedRows: Array<{
    lineNum: number
    sku: string
    warehouseCode: string
    productId: string
    warehouseId: string
    qty: number
    unitCostBase: number
    note: string | null
  }> = []
  const seenPairs = new Set<string>()

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const lineNum = i + 2

    const sku = readCsvValue(row, 'sku').trim().toUpperCase()
    const warehouseCode = readCsvValue(row, 'warehouseCode', 'warehouse').trim().toUpperCase()
    const qty = parseOptionalNumber(readCsvValue(row, 'qty', 'quantity'))
    const unitCostBase = parseOptionalNumber(readCsvValue(row, 'unitCostBase', 'avgUnitCostBase', 'averageUnitCostBase'))
    const note = readCsvValue(row, 'note').trim() || null

    if (!sku) { result.errors.push(`Row ${lineNum}: missing sku`); result.skipped++; continue }
    if (!warehouseCode) { result.errors.push(`Row ${lineNum}: missing warehouseCode`); result.skipped++; continue }
    if (qty === null || qty <= 0) { result.errors.push(`Row ${lineNum}: qty must be greater than zero`); result.skipped++; continue }
    if (unitCostBase === null || unitCostBase < 0) {
      result.errors.push(`Row ${lineNum}: unitCostBase must be zero or greater`)
      result.skipped++
      continue
    }

    const product = skuToProduct.get(sku)
    if (!product) { result.errors.push(`Row ${lineNum}: SKU "${sku}" not found`); result.skipped++; continue }
    if (product.type === ProductType.VARIABLE || product.type === ProductType.NON_INVENTORY || product.type === ProductType.KIT) {
      result.errors.push(`Row ${lineNum}: SKU "${sku}" cannot receive opening stock`)
      result.skipped++
      continue
    }

    const warehouseId = codeToWarehouseId.get(warehouseCode)
    if (!warehouseId) { result.errors.push(`Row ${lineNum}: warehouse "${warehouseCode}" not found`); result.skipped++; continue }

    const pairKey = `${product.id}:${warehouseId}`
    if (seenPairs.has(pairKey)) {
      result.errors.push(`Row ${lineNum}: duplicate opening stock row for SKU "${sku}" in warehouse "${warehouseCode}"`)
      result.skipped++
      continue
    }
    seenPairs.add(pairKey)

    stagedRows.push({
      lineNum,
      sku,
      warehouseCode,
      productId: product.id,
      warehouseId,
      qty,
      unitCostBase,
      note,
    })
  }

  const candidateProductIds = Array.from(new Set(stagedRows.map((row) => row.productId)))
  const candidateWarehouseIds = Array.from(new Set(stagedRows.map((row) => row.warehouseId)))

  const [existingStockLevels, existingCostLayers, existingMovements] = candidateProductIds.length > 0 && candidateWarehouseIds.length > 0
    ? await Promise.all([
        db.stockLevel.findMany({
          where: {
            productId: { in: candidateProductIds },
            warehouseId: { in: candidateWarehouseIds },
          },
          select: {
            productId: true,
            warehouseId: true,
            quantity: true,
            reservedQty: true,
          },
        }),
        db.costLayer.findMany({
          where: {
            productId: { in: candidateProductIds },
            warehouseId: { in: candidateWarehouseIds },
          },
          select: {
            productId: true,
            warehouseId: true,
          },
        }),
        db.stockMovement.findMany({
          where: {
            productId: { in: candidateProductIds },
            OR: [
              { toWarehouseId: { in: candidateWarehouseIds } },
              { fromWarehouseId: { in: candidateWarehouseIds } },
            ],
          },
          select: {
            productId: true,
            toWarehouseId: true,
            fromWarehouseId: true,
          },
        }),
      ])
    : [[], [], []]

  const existingStockLevelByPair = new Map<string, { quantity: number; reservedQty: number }>(
    existingStockLevels.map((level) => [
      `${level.productId}:${level.warehouseId}`,
      {
        quantity: Number(level.quantity),
        reservedQty: Number(level.reservedQty),
      },
    ]),
  )
  const existingCostLayerPairs = new Set(
    existingCostLayers.map((layer) => `${layer.productId}:${layer.warehouseId}`),
  )
  const existingMovementPairs = new Set<string>()
  for (const movement of existingMovements) {
    if (movement.toWarehouseId) existingMovementPairs.add(`${movement.productId}:${movement.toWarehouseId}`)
    if (movement.fromWarehouseId) existingMovementPairs.add(`${movement.productId}:${movement.fromWarehouseId}`)
  }

  const touchedProductIds = new Set<string>()
  const { applyOpeningStock } = await import('./stock')

  for (const row of stagedRows) {
    const pairKey = `${row.productId}:${row.warehouseId}`
    const existingLevel = existingStockLevelByPair.get(pairKey)
    const hasNonZeroStock = existingLevel
      ? Math.abs(existingLevel.quantity) > 0.0001 || Math.abs(existingLevel.reservedQty) > 0.0001
      : false
    const hasHistory = hasNonZeroStock || existingCostLayerPairs.has(pairKey) || existingMovementPairs.has(pairKey)

    if (hasHistory) {
      result.errors.push(`Row ${row.lineNum} (${row.sku} @ ${row.warehouseCode}): opening stock can only be imported into an empty warehouse record`)
      result.skipped++
      continue
    }

    try {
      if (!preview) {
        await db.$transaction(async (tx) => {
          await applyOpeningStock({
            tx,
            productId: row.productId,
            warehouseId: row.warehouseId,
            qty: row.qty,
            unitCostBase: row.unitCostBase,
            note: row.note,
          })
        })
      }
      result.created++
      touchedProductIds.add(row.productId)
      existingMovementPairs.add(pairKey)
      existingCostLayerPairs.add(pairKey)
      existingStockLevelByPair.set(pairKey, {
        quantity: row.qty,
        reservedQty: 0,
      })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      result.errors.push(`Row ${row.lineNum} (${row.sku}): ${msg}`)
      result.skipped++
    }
  }

  if (preview) {
    return buildImportPreviewResult(rows.length + dropped, result, dropped)
  }

  revalidatePath('/stock-control')
  revalidatePath('/inventory')
  if (touchedProductIds.size > 0) {
    try {
      await enqueueStockSync(Array.from(touchedProductIds), 'IMS_CHANGE')
    } catch (syncError) {
      console.error(syncError)
    }
  }
  if (result.created > 0) {
    await logActivity({ entityType: 'IMPORT', tag: 'import', action: 'imported', description: `Imported ${result.created} opening stock row(s) from CSV` })
  } else if (result.errors.length > 0) {
    await logActivity({ entityType: 'IMPORT', tag: 'import', action: 'imported', level: 'ERROR', description: `Failed to import opening stock from CSV: ${result.errors[0]}` })
  }
  return createCsvImportExecutionResult(result)
}

// ---------------------------------------------------------------------------
// Warehouse Transfers CSV import
// ---------------------------------------------------------------------------

export async function importTransfersCsv(formData: FormData): Promise<CsvImportActionResult> {
  const mode = getCsvImportMode(formData)
  const preview = mode === 'preview'
  const validated = await validateImportFile(formData, 'stock_control.transfer')
  if ('error' in validated) {
    const result = { created: 0, updated: 0, skipped: 0, errors: [validated.error] }
    return preview
      ? buildImportPreviewResult(0, result, 0, validated.error)
      : createCsvImportExecutionResult({ ...result, error: validated.error, success: false })
  }

  const parsed = parseCsv(await validated.file.text())
  const { rows, dropped } = capRows(parsed)
  const result: ImportResult = { created: 0, updated: 0, skipped: 0, errors: [] }
  if (dropped > 0) {
    result.errors.push(`File has more than ${MAX_IMPORT_ROWS} rows — ${dropped} row(s) skipped`)
  }

  const products = await db.product.findMany({ select: { id: true, sku: true, name: true } })
  const skuToProduct = new Map(products.map((p) => [p.sku.toUpperCase(), p]))
  const warehouses = await db.warehouse.findMany({ select: { id: true, code: true } })
  const codeToWh = new Map(warehouses.map((w) => [w.code.toUpperCase(), w.id]))
  const { createTransfer, dispatchTransfer, receiveTransfer } = await import('./transfers')

  const groups = new Map<string, {
    fromId: string
    toId: string
    notes: string
    status: 'DRAFT' | 'IN_TRANSIT' | 'RECEIVED'
    importKey?: string
    invalid: boolean
    lines: { productId: string; sku: string; productName: string; qty: number }[]
  }>()

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const lineNum = i + 2
    const fromCode = (row['fromWarehouseCode'] ?? row['fromwarehousecode'] ?? '').trim().toUpperCase()
    const toCode = (row['toWarehouseCode'] ?? row['towarehousecode'] ?? '').trim().toUpperCase()
    const sku = (row['sku'] ?? '').trim()
    const qty = Number(row['qty'] ?? 0)
    const statusRaw = readCsvValue(row, 'status').trim().toUpperCase()
    const transferKey = readCsvValue(row, 'transferKey', 'transferkey').trim()
    const status = (statusRaw || 'DRAFT') as 'DRAFT' | 'IN_TRANSIT' | 'RECEIVED'

    if (!fromCode || !toCode || !sku || qty <= 0) { result.errors.push(`Row ${lineNum}: missing required fields`); result.skipped++; continue }
    if (!['DRAFT', 'IN_TRANSIT', 'RECEIVED'].includes(status)) {
      result.errors.push(`Row ${lineNum}: invalid status "${statusRaw}"`)
      result.skipped++
      continue
    }
    const fromId = codeToWh.get(fromCode)
    const toId = codeToWh.get(toCode)
    if (!fromId) { result.errors.push(`Row ${lineNum}: warehouse "${fromCode}" not found`); result.skipped++; continue }
    if (!toId) { result.errors.push(`Row ${lineNum}: warehouse "${toCode}" not found`); result.skipped++; continue }
    const product = skuToProduct.get(sku.toUpperCase())
    if (!product) { result.errors.push(`Row ${lineNum}: SKU "${sku}" not found`); result.skipped++; continue }

    const notes = readCsvValue(row, 'notes')
    const key = transferKey || `${fromId}:${toId}:${notes}`
    const existing = groups.get(key)
    if (!existing) {
      groups.set(key, { fromId, toId, notes, status, importKey: transferKey || undefined, invalid: false, lines: [] })
    } else if (
      existing.fromId !== fromId ||
      existing.toId !== toId ||
      existing.notes !== notes ||
      existing.status !== status
    ) {
      existing.invalid = true
      result.errors.push(`Row ${lineNum}: grouped transfer "${key}" has inconsistent warehouse, status, or notes values`)
      result.skipped++
      continue
    }
    groups.get(key)!.lines.push({ productId: product.id, sku, productName: product.name, qty })
  }

  const explicitTransferKeys = Array.from(
    new Set(
      Array.from(groups.values())
        .map((group) => group.importKey)
        .filter((key): key is string => typeof key === 'string' && key.length > 0),
    ),
  )
  const existingTransferRefs = explicitTransferKeys.length
    ? new Set(
        (
          await db.stockTransfer.findMany({
            where: { reference: { in: explicitTransferKeys } },
            select: { reference: true },
          })
        ).map((transfer) => transfer.reference),
      )
    : new Set<string>()

  for (const g of groups.values()) {
    if (g.invalid) {
      result.skipped += g.lines.length
      continue
    }
    if (g.importKey && existingTransferRefs.has(g.importKey)) {
      result.errors.push(`Transfer "${g.importKey}" already exists — skipping duplicate import`)
      result.skipped += g.lines.length
      continue
    }
    try {
      if (!preview) {
        const created = await createTransfer(g.fromId, g.toId, g.lines, g.notes || undefined, g.importKey)
        if (!created.success || !created.transfer) {
          throw new Error(created.message || 'Failed to create transfer')
        }
        if (g.status === 'IN_TRANSIT' || g.status === 'RECEIVED') {
          const dispatched = await dispatchTransfer(created.transfer.id)
          if (!dispatched.success) {
            throw new Error(dispatched.message || 'Failed to dispatch transfer')
          }
        }
        if (g.status === 'RECEIVED') {
          const received = await receiveTransfer(created.transfer.id)
          if (!received.success) {
            throw new Error(received.message || 'Failed to receive transfer')
          }
        }
      }
      result.created += g.lines.length
      if (g.importKey) existingTransferRefs.add(g.importKey)
    } catch (e: unknown) {
      result.errors.push(String(e))
      result.skipped += g.lines.length
    }
  }

  if (preview) {
    return buildImportPreviewResult(rows.length + dropped, result, dropped)
  }

  revalidatePath('/stock-control/transfers')
  if (result.created > 0) {
    await logActivity({ entityType: 'IMPORT', tag: 'import', action: 'imported', description: `Imported ${result.created} transfers from CSV` })
  } else if (result.errors.length > 0) {
    await logActivity({ entityType: 'IMPORT', tag: 'import', action: 'imported', level: 'ERROR', description: `Failed to import transfers from CSV: ${result.errors[0]}` })
  }
  return createCsvImportExecutionResult(result)
}

// ---------------------------------------------------------------------------
// Sales Orders CSV import
// ---------------------------------------------------------------------------

export async function importSalesOrdersCsv(formData: FormData): Promise<CsvImportActionResult> {
  const mode = getCsvImportMode(formData)
  const preview = mode === 'preview'
  const validated = await validateImportFile(formData, 'sales.create')
  if ('error' in validated) {
    const result = { created: 0, updated: 0, skipped: 0, errors: [validated.error] }
    return preview
      ? buildImportPreviewResult(0, result, 0, validated.error)
      : createCsvImportExecutionResult({ ...result, error: validated.error, success: false })
  }
  const baseCurrency = await getBaseCurrencyCode()

  const parsed = parseCsv(await validated.file.text())
  const { rows, dropped } = capRows(parsed)
  const result: ImportResult = { created: 0, updated: 0, skipped: 0, errors: [] }
  if (dropped > 0) {
    result.errors.push(`File has more than ${MAX_IMPORT_ROWS} rows — ${dropped} row(s) skipped`)
  }

  const products = await db.product.findMany({ select: { id: true, sku: true, name: true } })
  const skuMap = new Map(products.map((p) => [p.sku.toUpperCase(), p]))
  const warehouses = await db.warehouse.findMany({ select: { id: true, code: true } })
  const warehouseCodeToId = new Map(warehouses.map((w) => [w.code.toUpperCase(), w.id]))
  const taxRates = (await db.taxRate.findMany({
    select: { id: true, name: true, rate: true, usedFor: true, active: true },
  })).map((taxRate) => ({
    ...taxRate,
    rate: Number(taxRate.rate),
  }))
  const { createSalesOrder } = await import('./sales')
  const { autoAllocateOrder } = await import('./allocation')

  const groups = new Map<string, {
    customerName: string
    customerEmail?: string
    importKey?: string
    currency: string
    fxRateToBase: number
    notes?: string
    shipFromWarehouseId?: string
    expectedDelivery?: string
    salesRep?: string
    shippingService?: string
    shippingForeign?: number
    orderTaxRateName?: string
    orderTaxRateValue?: number
    pricesIncludeVat: boolean
    orderDiscountForeign?: number
    invalid: boolean
    lines: { productId: string; sku: string; description: string; qty: number; unitPriceForeign: number; discountAmount?: number; discountStr?: string; taxRateId?: string }[]
  }>()

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const lineNum = i + 2
    const customerName = readCsvValue(row, 'customerName', 'customername', 'customer').trim()
    const sku = readCsvValue(row, 'sku').trim()
    const qty = Number(readCsvValue(row, 'qty') || 1)
    const unitPrice = parseOptionalNumber(readCsvValue(row, 'unitPriceForeign', 'unitPrice', 'unitprice', 'price'))

    if (!customerName) { result.errors.push(`Row ${lineNum}: missing customerName`); result.skipped++; continue }
    if (!sku) { result.errors.push(`Row ${lineNum}: missing sku`); result.skipped++; continue }
    if (!Number.isFinite(qty) || qty <= 0) { result.errors.push(`Row ${lineNum}: invalid qty`); result.skipped++; continue }
    if (unitPrice === null || unitPrice < 0) { result.errors.push(`Row ${lineNum}: invalid unitPriceForeign`); result.skipped++; continue }

    const product = skuMap.get(sku.toUpperCase())
    if (!product) { result.errors.push(`Row ${lineNum}: SKU "${sku}" not found`); result.skipped++; continue }

    const currency = readCsvValue(row, 'currency').trim() || baseCurrency
    const fxRateResolved = getFxRateForCurrency(lineNum, currency, baseCurrency, readCsvValue(row, 'fxRateToBase', 'fxRate', 'fxrate'))
    if (!fxRateResolved.fxRate) {
      result.errors.push(fxRateResolved.error ?? `Row ${lineNum}: invalid fxRateToBase`)
      result.skipped++
      continue
    }

    const shipFromWarehouseCode = readCsvValue(row, 'shipFromWarehouseCode', 'warehouseCode', 'warehouse').trim().toUpperCase()
    const shipFromWarehouseId = shipFromWarehouseCode ? warehouseCodeToId.get(shipFromWarehouseCode) : undefined
    if (shipFromWarehouseCode && !shipFromWarehouseId) {
      result.errors.push(`Row ${lineNum}: warehouse "${shipFromWarehouseCode}" not found`)
      result.skipped++
      continue
    }

    const explicitKey = readCsvValue(row, 'orderKey', 'orderkey', 'orderNumber', 'ordernumber').trim()
    const key = explicitKey || `row-${lineNum}`
    const lineTaxRateName = readCsvValue(row, 'taxRateName', 'taxrate', 'taxRate').trim() || undefined
    const lineTaxRateValue = normalizeTaxRateValue(parseOptionalNumber(readCsvValue(row, 'taxRateValue', 'taxratevalue')))
    const orderTaxRateName = readCsvValue(row, 'orderTaxRateName', 'ordertaxratename').trim() || lineTaxRateName
    const orderTaxRateValue = normalizeTaxRateValue(parseOptionalNumber(readCsvValue(row, 'orderTaxRateValue', 'ordertaxratevalue')))
      ?? lineTaxRateValue

    const resolvedLineTaxRateId = resolveImportedTaxRateId(taxRates, 'SALES', lineTaxRateName, lineTaxRateValue)
    if ((lineTaxRateName || lineTaxRateValue !== undefined) && !resolvedLineTaxRateId) {
      result.errors.push(`Row ${lineNum}: could not resolve sales tax rate`)
      result.skipped++
      continue
    }

    const groupCandidate = {
      customerName,
      customerEmail: readCsvValue(row, 'customerEmail', 'customeremail').trim() || undefined,
      importKey: explicitKey || undefined,
      currency,
      fxRateToBase: fxRateResolved.fxRate,
      notes: readCsvValue(row, 'notes').trim() || undefined,
      shipFromWarehouseId,
      expectedDelivery: readCsvValue(row, 'expectedDelivery', 'expecteddelivery').trim() || undefined,
      salesRep: readCsvValue(row, 'salesRep', 'salesrep').trim() || undefined,
      shippingService: readCsvValue(row, 'shippingService', 'shippingservice').trim() || undefined,
      shippingForeign: parseOptionalNumber(readCsvValue(row, 'shippingForeign', 'shipping', 'shippingAmount')) ?? undefined,
      orderTaxRateName,
      orderTaxRateValue,
      pricesIncludeVat: parseCsvBoolean(readCsvValue(row, 'pricesIncludeVat', 'pricesincludevat')),
      orderDiscountForeign: parseOptionalNumber(readCsvValue(row, 'orderDiscountForeign', 'discountAmount', 'orderDiscount')) ?? undefined,
      invalid: false,
      lines: [],
    }

    const existing = groups.get(key)
    if (!existing) {
      groups.set(key, groupCandidate)
    } else if (
      existing.customerName !== groupCandidate.customerName ||
      existing.customerEmail !== groupCandidate.customerEmail ||
      existing.currency !== groupCandidate.currency ||
      existing.fxRateToBase !== groupCandidate.fxRateToBase ||
      existing.notes !== groupCandidate.notes ||
      existing.shipFromWarehouseId !== groupCandidate.shipFromWarehouseId ||
      existing.expectedDelivery !== groupCandidate.expectedDelivery ||
      existing.salesRep !== groupCandidate.salesRep ||
      existing.shippingService !== groupCandidate.shippingService ||
      existing.shippingForeign !== groupCandidate.shippingForeign ||
      existing.orderTaxRateName !== groupCandidate.orderTaxRateName ||
      existing.orderTaxRateValue !== groupCandidate.orderTaxRateValue ||
      existing.pricesIncludeVat !== groupCandidate.pricesIncludeVat ||
      existing.orderDiscountForeign !== groupCandidate.orderDiscountForeign
    ) {
      existing.invalid = true
      result.errors.push(`Row ${lineNum}: grouped sales order "${key}" has inconsistent order-level fields`)
      result.skipped++
      continue
    }

    groups.get(key)!.lines.push({
      productId: product.id,
      sku: product.sku,
      description: product.name,
      qty,
      unitPriceForeign: unitPrice,
      discountAmount: parseOptionalNumber(readCsvValue(row, 'lineDiscountForeign', 'discountAmount', 'lineDiscountAmount')) ?? undefined,
      discountStr: readCsvValue(row, 'lineDiscountStr', 'discountStr', 'linediscountstr').trim() || undefined,
      taxRateId: resolvedLineTaxRateId,
    })
  }

  const explicitSalesKeys = Array.from(
    new Set(
      Array.from(groups.entries())
        .map(([groupKey, group]) => group.importKey ?? groupKey)
        .filter((key) => !key.startsWith('row-')),
    ),
  )
  const existingSalesOrderKeys = explicitSalesKeys.length
    ? new Set(
        (
          await db.salesOrder.findMany({
            where: { externalOrderNumber: { in: explicitSalesKeys } },
            select: { externalOrderNumber: true },
          })
        )
          .map((order) => order.externalOrderNumber)
          .filter((value): value is string => typeof value === 'string' && value.length > 0),
      )
    : new Set<string>()

  for (const [groupKey, g] of groups.entries()) {
    if (g.invalid) {
      result.skipped += g.lines.length
      continue
    }
    const importKey = g.importKey ?? (groupKey.startsWith('row-') ? undefined : groupKey)
    if (importKey && existingSalesOrderKeys.has(importKey)) {
      result.errors.push(`Sales order "${importKey}" already exists — skipping duplicate import`)
      result.skipped += g.lines.length
      continue
    }
    try {
      if (!preview) {
        const created = await createSalesOrder({
          externalOrderNumber: importKey,
          customerName: g.customerName,
          customerEmail: g.customerEmail,
          currency: g.currency,
          fxRateToBase: g.fxRateToBase,
          shipFromWarehouseId: g.shipFromWarehouseId,
          expectedDelivery: g.expectedDelivery,
          salesRep: g.salesRep,
          notes: g.notes,
          shippingService: g.shippingService,
          shippingForeign: g.shippingForeign ?? 0,
          taxRateName: g.orderTaxRateName,
          taxRateValue: g.orderTaxRateValue,
          pricesIncludeVat: g.pricesIncludeVat,
          orderDiscountForeign: g.orderDiscountForeign ?? 0,
          lines: g.lines,
          isDraft: true,
        })
        if (!created.success || !created.order) {
          throw new Error(created.error || 'Failed to create sales order')
        }
        await autoAllocateOrder(created.order.id)
      }
      result.created += g.lines.length
      if (importKey) existingSalesOrderKeys.add(importKey)
    } catch (e: unknown) {
      result.errors.push(String(e))
      result.skipped += g.lines.length
    }
  }

  if (preview) {
    return buildImportPreviewResult(rows.length + dropped, result, dropped)
  }

  revalidatePath('/sales')
  if (result.created > 0) {
    await logActivity({ entityType: 'IMPORT', tag: 'import', action: 'imported', description: `Imported ${result.created} sales orders from CSV` })
  } else if (result.errors.length > 0) {
    await logActivity({ entityType: 'IMPORT', tag: 'import', action: 'imported', level: 'ERROR', description: `Failed to import sales orders from CSV: ${result.errors[0]}` })
  }
  return createCsvImportExecutionResult(result)
}

// ---------------------------------------------------------------------------
// Purchase Orders CSV import
// ---------------------------------------------------------------------------

export async function importPurchaseOrdersCsv(formData: FormData): Promise<CsvImportActionResult> {
  const mode = getCsvImportMode(formData)
  const preview = mode === 'preview'
  const validated = await validateImportFile(formData, 'purchasing.create')
  if ('error' in validated) {
    const result = { created: 0, updated: 0, skipped: 0, errors: [validated.error] }
    return preview
      ? buildImportPreviewResult(0, result, 0, validated.error)
      : createCsvImportExecutionResult({ ...result, error: validated.error, success: false })
  }
  const baseCurrency = await getBaseCurrencyCode()

  const parsed = parseCsv(await validated.file.text())
  const { rows, dropped } = capRows(parsed)
  const result: ImportResult = { created: 0, updated: 0, skipped: 0, errors: [] }
  if (dropped > 0) {
    result.errors.push(`File has more than ${MAX_IMPORT_ROWS} rows — ${dropped} row(s) skipped`)
  }

  const products = await db.product.findMany({ select: { id: true, sku: true, name: true } })
  const skuMap = new Map(products.map((p) => [p.sku.toUpperCase(), p]))
  const suppliers = await db.supplier.findMany({ select: { id: true, name: true, currency: true } })
  const supplierMap = new Map(suppliers.map((s) => [s.name.toUpperCase(), s]))
  const warehouses = await db.warehouse.findMany({ select: { id: true, code: true } })
  const warehouseCodeToId = new Map(warehouses.map((w) => [w.code.toUpperCase(), w.id]))
  const taxRates = (await db.taxRate.findMany({
    select: { id: true, name: true, rate: true, usedFor: true, active: true },
  })).map((taxRate) => ({
    ...taxRate,
    rate: Number(taxRate.rate),
  }))
  const { createPurchaseOrder } = await import('./purchase-orders')

  const groups = new Map<string, {
    importKey?: string
    supplierId: string
    currency: string
    fxRateToBase: number
    notes?: string
    supplierRef?: string
    expectedDelivery?: string
    destinationWarehouseId?: string
    pricesIncludeVat: boolean
    orderTaxRateName?: string
    orderTaxRateValue?: number
    orderDiscountForeign?: number
    invalid: boolean
    lines: { productId: string; sku: string; productName: string; qty: number; unitCostForeign: number; discountAmount?: number; discountStr?: string; taxRateId?: string }[]
  }>()

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const lineNum = i + 2
    const supplierName = readCsvValue(row, 'supplierName', 'suppliername', 'supplier').trim()
    const sku = readCsvValue(row, 'sku').trim()
    const qty = Number(readCsvValue(row, 'qty') || 1)
    const unitCost = parseOptionalNumber(readCsvValue(row, 'unitCostForeign', 'unitcostforeign', 'unitcost', 'cost'))

    if (!supplierName) { result.errors.push(`Row ${lineNum}: missing supplierName`); result.skipped++; continue }
    if (!sku) { result.errors.push(`Row ${lineNum}: missing sku`); result.skipped++; continue }
    if (!Number.isFinite(qty) || qty <= 0) { result.errors.push(`Row ${lineNum}: invalid qty`); result.skipped++; continue }
    if (unitCost === null || unitCost < 0) { result.errors.push(`Row ${lineNum}: invalid unitCostForeign`); result.skipped++; continue }

    const supplier = supplierMap.get(supplierName.toUpperCase())
    if (!supplier) { result.errors.push(`Row ${lineNum}: supplier "${supplierName}" not found`); result.skipped++; continue }
    const product = skuMap.get(sku.toUpperCase())
    if (!product) { result.errors.push(`Row ${lineNum}: SKU "${sku}" not found`); result.skipped++; continue }

    const currency = readCsvValue(row, 'currency').trim() || supplier.currency || baseCurrency
    const fxRateResolved = getFxRateForCurrency(lineNum, currency, baseCurrency, readCsvValue(row, 'fxRateToBase', 'fxRate', 'fxrate'))
    if (!fxRateResolved.fxRate) {
      result.errors.push(fxRateResolved.error ?? `Row ${lineNum}: invalid fxRateToBase`)
      result.skipped++
      continue
    }

    const destinationWarehouseCode = readCsvValue(row, 'destinationWarehouseCode', 'warehouseCode', 'warehouse').trim().toUpperCase()
    const destinationWarehouseId = destinationWarehouseCode ? warehouseCodeToId.get(destinationWarehouseCode) : undefined
    if (destinationWarehouseCode && !destinationWarehouseId) {
      result.errors.push(`Row ${lineNum}: warehouse "${destinationWarehouseCode}" not found`)
      result.skipped++
      continue
    }

    const explicitKey = readCsvValue(row, 'orderKey', 'purchaseOrderKey', 'orderkey', 'reference').trim()
    const key = explicitKey || `row-${lineNum}`
    const lineTaxRateName = readCsvValue(row, 'taxRateName', 'taxrate', 'taxRate').trim() || undefined
    const lineTaxRateValue = normalizeTaxRateValue(parseOptionalNumber(readCsvValue(row, 'taxRateValue', 'taxratevalue')))
    const orderTaxRateName = readCsvValue(row, 'orderTaxRateName', 'ordertaxratename').trim() || lineTaxRateName
    const orderTaxRateValue = normalizeTaxRateValue(parseOptionalNumber(readCsvValue(row, 'orderTaxRateValue', 'ordertaxratevalue')))
      ?? lineTaxRateValue
    const resolvedLineTaxRateId = resolveImportedTaxRateId(taxRates, 'PURCHASE', lineTaxRateName, lineTaxRateValue)
    if ((lineTaxRateName || lineTaxRateValue !== undefined) && !resolvedLineTaxRateId) {
      result.errors.push(`Row ${lineNum}: could not resolve purchase tax rate`)
      result.skipped++
      continue
    }

    const groupCandidate = {
      importKey: explicitKey || undefined,
      supplierId: supplier.id,
      currency,
      fxRateToBase: fxRateResolved.fxRate,
      notes: readCsvValue(row, 'notes').trim() || undefined,
      supplierRef: readCsvValue(row, 'supplierRef', 'supplierref').trim() || undefined,
      expectedDelivery: readCsvValue(row, 'expectedDelivery', 'expecteddelivery').trim() || undefined,
      destinationWarehouseId,
      pricesIncludeVat: parseCsvBoolean(readCsvValue(row, 'pricesIncludeVat', 'pricesincludevat')),
      orderTaxRateName,
      orderTaxRateValue,
      orderDiscountForeign: parseOptionalNumber(readCsvValue(row, 'orderDiscountForeign', 'discountAmount', 'orderDiscount')) ?? undefined,
      invalid: false,
      lines: [],
    }

    const existing = groups.get(key)
    if (!existing) {
      groups.set(key, groupCandidate)
    } else if (
      existing.supplierId !== groupCandidate.supplierId ||
      existing.currency !== groupCandidate.currency ||
      existing.fxRateToBase !== groupCandidate.fxRateToBase ||
      existing.notes !== groupCandidate.notes ||
      existing.supplierRef !== groupCandidate.supplierRef ||
      existing.expectedDelivery !== groupCandidate.expectedDelivery ||
      existing.destinationWarehouseId !== groupCandidate.destinationWarehouseId ||
      existing.pricesIncludeVat !== groupCandidate.pricesIncludeVat ||
      existing.orderTaxRateName !== groupCandidate.orderTaxRateName ||
      existing.orderTaxRateValue !== groupCandidate.orderTaxRateValue ||
      existing.orderDiscountForeign !== groupCandidate.orderDiscountForeign
    ) {
      existing.invalid = true
      result.errors.push(`Row ${lineNum}: grouped purchase order "${key}" has inconsistent order-level fields`)
      result.skipped++
      continue
    }

    groups.get(key)!.lines.push({
      productId: product.id,
      sku: product.sku,
      productName: product.name,
      qty,
      unitCostForeign: unitCost,
      discountAmount: parseOptionalNumber(readCsvValue(row, 'lineDiscountForeign', 'discountAmount', 'lineDiscountAmount')) ?? undefined,
      discountStr: readCsvValue(row, 'lineDiscountStr', 'discountStr', 'linediscountstr').trim() || undefined,
      taxRateId: resolvedLineTaxRateId,
    })
  }

  const explicitPoKeys = Array.from(
    new Set(
      Array.from(groups.entries())
        .map(([groupKey, group]) => group.importKey ?? groupKey)
        .filter((key) => !key.startsWith('row-')),
    ),
  )
  const existingPoRefs = explicitPoKeys.length
    ? new Set(
        (
          await db.purchaseOrder.findMany({
            where: { reference: { in: explicitPoKeys } },
            select: { reference: true },
          })
        ).map((po) => po.reference),
      )
    : new Set<string>()

  for (const [groupKey, g] of groups.entries()) {
    if (g.invalid) {
      result.skipped += g.lines.length
      continue
    }
    const importKey = g.importKey ?? (groupKey.startsWith('row-') ? undefined : groupKey)
    if (importKey && existingPoRefs.has(importKey)) {
      result.errors.push(`Purchase order "${importKey}" already exists — skipping duplicate import`)
      result.skipped += g.lines.length
      continue
    }
    try {
      if (!preview) {
        const created = await createPurchaseOrder({
          reference: importKey,
          supplierId: g.supplierId,
          currency: g.currency,
          fxRateToBase: g.fxRateToBase,
          destinationWarehouseId: g.destinationWarehouseId,
          supplierRef: g.supplierRef,
          expectedDelivery: g.expectedDelivery,
          notes: g.notes,
          pricesIncludeVat: g.pricesIncludeVat,
          taxRateName: g.orderTaxRateName,
          taxRateValue: g.orderTaxRateValue,
          orderDiscountForeign: g.orderDiscountForeign,
          lines: g.lines.map((line, index) => ({
            ...line,
            sortOrder: index,
          })),
        })
        if (!created.success || !created.po) {
          throw new Error(created.error || 'Failed to create purchase order')
        }
      }
      result.created += g.lines.length
      if (importKey) existingPoRefs.add(importKey)
    } catch (e: unknown) {
      result.errors.push(String(e))
      result.skipped += g.lines.length
    }
  }

  if (preview) {
    return buildImportPreviewResult(rows.length + dropped, result, dropped)
  }

  revalidatePath('/purchase-orders')
  if (result.created > 0) {
    await logActivity({ entityType: 'IMPORT', tag: 'import', action: 'imported', description: `Imported ${result.created} purchase orders from CSV` })
  } else if (result.errors.length > 0) {
    await logActivity({ entityType: 'IMPORT', tag: 'import', action: 'imported', level: 'ERROR', description: `Failed to import purchase orders from CSV: ${result.errors[0]}` })
  }
  return createCsvImportExecutionResult(result)
}
