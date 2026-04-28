'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { parseCsv } from '@/lib/csv'
import { logActivity } from '@/lib/activity-log'
import { requireAuth, requirePermission } from '@/lib/auth/server'
import { getBaseCurrencyCode } from '@/lib/base-currency'
import { toIsoCountryCode } from '@/lib/countries'
import {
  createCsvImportExecutionResult,
  createCsvImportPreviewResult,
  getCsvImportMode,
  isCsvImportDryRunMode,
  type CsvImportActionResult,
} from '@/lib/csv-import'

const MAX_IMPORT_BYTES = 10 * 1024 * 1024
const MAX_IMPORT_ROWS = 10_000

export type SupplierRow = {
  id: string
  name: string
  contactName: string | null
  email: string | null
  phone: string | null
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  county: string | null
  postcode: string | null
  country: string | null
  currency: string
  taxRateId: string | null
  taxRateName: string | null
  taxRate: number | null
  vatNumber: string | null
  accountNumber: string | null
  paymentTermsDays: number | null
  /** User-entered manual override for expected delivery time, in days. */
  manualDeliveryDays: number | null
  /** Computed average delivery time in days across completed POs (null if no history). */
  avgDeliveryDays: number | null
  /** Number of historical POs the avgDeliveryDays is based on. */
  avgDeliveryDaysCount: number
  notes: string | null
  active: boolean
}

export type SupplierInput = {
  name: string
  contactName?: string
  email?: string
  phone?: string
  addressLine1?: string
  addressLine2?: string
  city?: string
  county?: string
  postcode?: string
  country?: string
  currency?: string
  taxRateId?: string | null
  vatNumber?: string
  accountNumber?: string
  paymentTermsDays?: number | null
  manualDeliveryDays?: number | null
  notes?: string
}

function hasCsvValue(row: Record<string, string>, key: string): boolean {
  return typeof row[key] === 'string' && row[key].trim().length > 0
}

const SUPPLIER_SELECT = {
  id: true,
  name: true,
  contactName: true,
  email: true,
  phone: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  county: true,
  postcode: true,
  country: true,
  currency: true,
  taxRateId: true,
  taxRate: { select: { id: true, name: true, rate: true } },
  vatNumber: true,
  accountNumber: true,
  paymentTermsDays: true,
  manualDeliveryDays: true,
  notes: true,
  active: true,
} as const

function mapSupplier(
  s: {
    id: string
    name: string
    contactName: string | null
    email: string | null
    phone: string | null
    addressLine1: string | null
    addressLine2: string | null
    city: string | null
    county: string | null
    postcode: string | null
    country: string | null
    currency: string
    taxRateId: string | null
    taxRate: { id: string; name: string; rate: unknown } | null
    vatNumber: string | null
    accountNumber: string | null
    paymentTermsDays: number | null
    manualDeliveryDays: number | null
    notes: string | null
    active: boolean
  },
  avg: { days: number | null; count: number } = { days: null, count: 0 },
): SupplierRow {
  return {
    id: s.id,
    name: s.name,
    contactName: s.contactName,
    email: s.email,
    phone: s.phone,
    addressLine1: s.addressLine1,
    addressLine2: s.addressLine2,
    city: s.city,
    county: s.county,
    postcode: s.postcode,
    country: s.country,
    currency: s.currency,
    taxRateId: s.taxRateId,
    taxRateName: s.taxRate?.name ?? null,
    taxRate: s.taxRate ? Number(s.taxRate.rate) : null,
    vatNumber: s.vatNumber,
    accountNumber: s.accountNumber,
    paymentTermsDays: s.paymentTermsDays,
    manualDeliveryDays: s.manualDeliveryDays,
    avgDeliveryDays: avg.days,
    avgDeliveryDaysCount: avg.count,
    notes: s.notes,
    active: s.active,
  }
}

/**
 * Compute average delivery time (days from PO sent/created to received) per
 * supplier. Uses poSentAt if populated, otherwise createdAt as the start date.
 * Only includes POs that have been received.
 */
async function getAvgDeliveryDaysBySupplier(
  supplierIds: string[],
): Promise<Map<string, { days: number; count: number }>> {
  const result = new Map<string, { days: number; count: number }>()
  if (supplierIds.length === 0) return result
  const rows = await db.$queryRaw<
    { supplierId: string; avgDays: number | null; count: bigint }[]
  >`
    SELECT
      "supplierId",
      AVG(EXTRACT(EPOCH FROM ("receivedAt" - COALESCE("poSentAt", "createdAt"))) / 86400)::float AS "avgDays",
      COUNT(*)::bigint AS "count"
    FROM "purchase_orders"
    WHERE "receivedAt" IS NOT NULL
      AND "supplierId" = ANY(${supplierIds}::text[])
    GROUP BY "supplierId"
  `
  for (const r of rows) {
    if (r.avgDays != null) {
      result.set(r.supplierId, {
        days: Math.round(r.avgDays * 10) / 10,
        count: Number(r.count),
      })
    }
  }
  return result
}

export async function getSuppliers(includeInactive = false): Promise<SupplierRow[]> {
  await requireAuth()
  const rows = await db.supplier.findMany({
    where: includeInactive ? undefined : { active: true },
    select: SUPPLIER_SELECT,
    orderBy: { name: 'asc' },
  })
  const avgMap = await getAvgDeliveryDaysBySupplier(rows.map((r) => r.id))
  return rows.map((r) => mapSupplier(r, avgMap.get(r.id) ?? { days: null, count: 0 }))
}

export async function getSupplier(id: string): Promise<SupplierRow | null> {
  await requireAuth()
  const s = await db.supplier.findUnique({ where: { id }, select: SUPPLIER_SELECT })
  if (!s) return null
  const avgMap = await getAvgDeliveryDaysBySupplier([id])
  return mapSupplier(s, avgMap.get(id) ?? { days: null, count: 0 })
}

export async function createSupplier(input: SupplierInput): Promise<{ success: boolean; supplier?: SupplierRow; error?: string }> {
  await requirePermission('purchasing.create')
  try {
    const baseCurrency = await getBaseCurrencyCode()
    const normalizedCountry = input.country ? (toIsoCountryCode(input.country) ?? input.country.trim()) : null
    const s = await db.supplier.create({
      data: {
        name: input.name,
        contactName: input.contactName || null,
        email: input.email || null,
        phone: input.phone || null,
        addressLine1: input.addressLine1 || null,
        addressLine2: input.addressLine2 || null,
        city: input.city || null,
        county: input.county || null,
        postcode: input.postcode || null,
        country: normalizedCountry,
        currency: input.currency || baseCurrency,
        taxRateId: input.taxRateId || null,
        vatNumber: input.vatNumber || null,
        accountNumber: input.accountNumber || null,
        paymentTermsDays: input.paymentTermsDays ?? null,
        manualDeliveryDays: input.manualDeliveryDays ?? null,
        notes: input.notes || null,
      },
      select: SUPPLIER_SELECT,
    })
    revalidatePath('/purchase-orders')
    await logActivity({ entityType: 'SUPPLIER', entityId: s.id, tag: 'purchase', action: 'created', description: `Created supplier: ${input.name}` })
    return { success: true, supplier: mapSupplier(s) }
  } catch (e) {
    await logActivity({ entityType: 'SUPPLIER', tag: 'purchase', action: 'created', level: 'ERROR', description: `Failed to create supplier: ${String(e)}` })
    return { success: false, error: String(e) }
  }
}

export async function updateSupplier(id: string, input: Partial<SupplierInput> & { active?: boolean }): Promise<{ success: boolean; supplier?: SupplierRow; error?: string }> {
  await requirePermission('purchasing.create')
  try {
    const normalizedCountry = input.country !== undefined
      ? (input.country ? (toIsoCountryCode(input.country) ?? input.country.trim()) : null)
      : undefined
    const s = await db.supplier.update({
      where: { id },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.contactName !== undefined && { contactName: input.contactName || null }),
        ...(input.email !== undefined && { email: input.email || null }),
        ...(input.phone !== undefined && { phone: input.phone || null }),
        ...(input.addressLine1 !== undefined && { addressLine1: input.addressLine1 || null }),
        ...(input.addressLine2 !== undefined && { addressLine2: input.addressLine2 || null }),
        ...(input.city !== undefined && { city: input.city || null }),
        ...(input.county !== undefined && { county: input.county || null }),
        ...(input.postcode !== undefined && { postcode: input.postcode || null }),
        ...(normalizedCountry !== undefined && { country: normalizedCountry }),
        ...(input.currency !== undefined && { currency: input.currency }),
        ...(input.taxRateId !== undefined && { taxRateId: input.taxRateId || null }),
        ...(input.vatNumber !== undefined && { vatNumber: input.vatNumber || null }),
        ...(input.accountNumber !== undefined && { accountNumber: input.accountNumber || null }),
        ...(input.paymentTermsDays !== undefined && { paymentTermsDays: input.paymentTermsDays ?? null }),
        ...(input.manualDeliveryDays !== undefined && { manualDeliveryDays: input.manualDeliveryDays ?? null }),
        ...(input.notes !== undefined && { notes: input.notes || null }),
        ...(input.active !== undefined && { active: input.active }),
      },
      select: SUPPLIER_SELECT,
    })
    revalidatePath('/purchase-orders')
    await logActivity({ entityType: 'SUPPLIER', entityId: s.id, tag: 'purchase', action: 'updated', description: `Updated supplier: ${s.name}` })
    return { success: true, supplier: mapSupplier(s) }
  } catch (e) {
    await logActivity({ entityType: 'SUPPLIER', entityId: id, tag: 'purchase', action: 'updated', level: 'ERROR', description: `Failed to update supplier: ${String(e)}` })
    return { success: false, error: String(e) }
  }
}

export async function importSuppliersCsv(formData: FormData): Promise<CsvImportActionResult> {
  const mode = getCsvImportMode(formData)
  const preview = isCsvImportDryRunMode(mode)
  await requirePermission('purchasing.create')
  try {
    const baseCurrency = await getBaseCurrencyCode()
    const file = formData.get('file') as File
    if (!file) {
      return preview
        ? createCsvImportPreviewResult({ totalRows: 0, created: 0, updated: 0, errorCount: 1, errors: ['No file'], error: 'No file' })
        : createCsvImportExecutionResult({ created: 0, updated: 0, skipped: 0, errors: ['No file'], error: 'No file', success: false })
    }
    if (file.size > MAX_IMPORT_BYTES) {
      const error = `File exceeds maximum size (${MAX_IMPORT_BYTES / (1024 * 1024)} MB)`
      return preview
        ? createCsvImportPreviewResult({ totalRows: 0, created: 0, updated: 0, errorCount: 1, errors: [error], error })
        : createCsvImportExecutionResult({ created: 0, updated: 0, skipped: 0, errors: [error], error, success: false })
    }
    const parsed = parseCsv(await file.text())
    const rows = parsed.slice(0, MAX_IMPORT_ROWS)
    const dropped = parsed.length - rows.length
    const suppliers = await db.supplier.findMany({
      select: { id: true, name: true },
    })
    const byId = new Map(suppliers.map((supplier) => [supplier.id, supplier]))
    const byName = new Map<string, typeof suppliers>()
    for (const supplier of suppliers) {
      const key = supplier.name.trim().toLowerCase()
      byName.set(key, [...(byName.get(key) ?? []), supplier])
    }

    let created = 0
    let updated = 0
    let skipped = 0
    const errors: string[] = []
    if (dropped > 0) {
      errors.push(`File has more than ${MAX_IMPORT_ROWS} rows — ${dropped} row(s) skipped`)
    }
    for (let index = 0; index < rows.length; index++) {
      const r = rows[index]
      const lineNum = index + 2
      const supplierId = r.supplierId?.trim() || ''
      const name = (r.name || r.Name || '').trim()
      let existing = supplierId ? (byId.get(supplierId) ?? null) : null
      if (!existing && name) {
        const matches = byName.get(name.toLowerCase()) ?? []
        if (matches.length === 1) existing = matches[0]
        else if (matches.length > 1) {
          errors.push(`Row ${lineNum}: supplier name "${name}" matches multiple suppliers`)
          skipped++
          continue
        }
      }
      if (!name && !existing) {
        errors.push(`Row ${lineNum}: missing supplier name or no existing supplier match`)
        skipped++
        continue
      }
      try {
        if (existing) {
          if (!preview) {
            await db.supplier.update({
              where: { id: existing.id },
              data: {
                ...(name ? { name } : {}),
                ...(r.contactName?.trim() ? { contactName: r.contactName.trim() } : {}),
                ...(r.email?.trim() ? { email: r.email.trim() } : {}),
                ...(r.phone?.trim() ? { phone: r.phone.trim() } : {}),
                ...(r.currency?.trim() ? { currency: r.currency.trim().toUpperCase() } : {}),
                ...(r.vatNumber?.trim() ? { vatNumber: r.vatNumber.trim() } : {}),
                ...(r.accountNumber?.trim() ? { accountNumber: r.accountNumber.trim() } : {}),
                ...(hasCsvValue(r, 'paymentTermsDays') ? { paymentTermsDays: parseInt(r.paymentTermsDays, 10) } : {}),
                ...(r.addressLine1?.trim() ? { addressLine1: r.addressLine1.trim() } : {}),
                ...(r.addressLine2?.trim() ? { addressLine2: r.addressLine2.trim() } : {}),
                ...(r.city?.trim() ? { city: r.city.trim() } : {}),
                ...(r.county?.trim() ? { county: r.county.trim() } : {}),
                ...(r.postcode?.trim() ? { postcode: r.postcode.trim() } : {}),
                ...(r.country?.trim() ? { country: toIsoCountryCode(r.country.trim()) ?? r.country.trim() } : {}),
                ...(r.notes?.trim() ? { notes: r.notes.trim() } : {}),
              },
            })
          }
          updated++
        } else {
          if (!preview) {
            await db.supplier.create({
              data: {
                name,
                contactName: r.contactName?.trim() || null,
                email: r.email?.trim() || null,
                phone: r.phone?.trim() || null,
                currency: r.currency?.trim() || baseCurrency,
                vatNumber: r.vatNumber?.trim() || null,
                accountNumber: r.accountNumber?.trim() || null,
                paymentTermsDays: r.paymentTermsDays ? parseInt(r.paymentTermsDays, 10) : null,
                addressLine1: r.addressLine1?.trim() || null,
                addressLine2: r.addressLine2?.trim() || null,
                city: r.city?.trim() || null,
                county: r.county?.trim() || null,
                postcode: r.postcode?.trim() || null,
                country: r.country?.trim() ? (toIsoCountryCode(r.country.trim()) ?? r.country.trim()) : null,
                notes: r.notes?.trim() || null,
              },
            })
          }
          created++
        }
      } catch (error) {
        errors.push(`Row ${lineNum}: ${String(error)}`)
        skipped++
      }
    }
    if (preview) {
      return createCsvImportPreviewResult({
        totalRows: parsed.length,
        created,
        updated,
        errorCount: skipped + dropped,
        errors,
      })
    }
    revalidatePath('/purchase-orders/suppliers')
    await logActivity({
      entityType: 'IMPORT',
      tag: 'import',
      action: 'imported',
      level: errors.length && created === 0 && updated === 0 ? 'ERROR' : (errors.length ? 'WARNING' : 'INFO'),
      description: errors.length
        ? `Imported ${created} suppliers, updated ${updated} from CSV with warnings: ${errors[0]}`
        : `Imported ${created} suppliers, updated ${updated} from CSV`,
    })
    return createCsvImportExecutionResult({
      created,
      updated,
      skipped,
      errors,
      error: created === 0 && updated === 0 && errors.length > 0 ? errors[0] : undefined,
    })
  } catch (e) {
    await logActivity({ entityType: 'IMPORT', tag: 'import', action: 'imported', level: 'ERROR', description: `Failed to import suppliers from CSV: ${String(e)}` })
    const error = String(e)
    return preview
      ? createCsvImportPreviewResult({ totalRows: 0, created: 0, updated: 0, errorCount: 1, errors: [error], error })
      : createCsvImportExecutionResult({ created: 0, updated: 0, skipped: 0, errors: [error], error, success: false })
  }
}
