'use server'

import { resolveWritableTaxRateId } from '@/lib/tax/writable-tax-rate'
import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { parseCsv } from '@/lib/csv'
import { logActivity } from '@/lib/activity-log'
import { requireInternalUser, requirePermission } from '@/lib/auth/server'
import { SYSTEM_IMPORT, withSystemActor, withSystemOutcome, type SystemImportContext } from '@/lib/first-load/apply/system-import-capability'
import { getBaseCurrencyCode } from '@/lib/base-currency'
import { toIsoCountryCode } from '@/lib/countries'
import { loadPurchaseRatesByType } from '@/lib/first-load/purchase-tax-rates'
import {
  createCsvImportExecutionResult,
  createCsvImportPreviewResult,
  getCsvImportMode,
  isCsvImportDryRunMode,
  runCsvImportMutation,
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
  prepaid: boolean
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
  prepaid?: boolean
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
  prepaid: true,
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
    prepaid: boolean
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
    prepaid: s.prepaid,
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
  await requireInternalUser()
  const rows = await db.supplier.findMany({
    where: includeInactive ? undefined : { active: true },
    select: SUPPLIER_SELECT,
    orderBy: { name: 'asc' },
  })
  const avgMap = await getAvgDeliveryDaysBySupplier(rows.map((r) => r.id))
  return rows.map((r) => mapSupplier(r, avgMap.get(r.id) ?? { days: null, count: 0 }))
}

export async function getSupplier(id: string): Promise<SupplierRow | null> {
  await requireInternalUser()
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
    // A default rate id that a tax re-key retired follows its replacement; a plainly inactive one is refused (lib/tax/writable-tax-rate.ts).
    // Resolved INSIDE the write's transaction, holding the row share lock to commit, so a re-key apply cannot commit between the resolution and the insert (lib/tax/writable-tax-rate.ts).
    const s = await db.$transaction(async (tx) => {
    const writableTaxRateId = await resolveWritableTaxRateId(tx, input.taxRateId || null)
    return tx.supplier.create({
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
        taxRateId: writableTaxRateId ?? null,
        vatNumber: input.vatNumber || null,
        accountNumber: input.accountNumber || null,
        paymentTermsDays: input.paymentTermsDays ?? null,
        prepaid: input.prepaid ?? false,
        manualDeliveryDays: input.manualDeliveryDays ?? null,
        notes: input.notes || null,
      },
      select: SUPPLIER_SELECT,
    })
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
    // As on create; the rate the supplier already has may stay even if it is inactive (editing other fields must not fail).
    // Inside the write's transaction, holding the row share lock to commit (lib/tax/writable-tax-rate.ts).
    const s = await db.$transaction(async (tx) => {
    const currentTaxRateId = input.taxRateId ? (await tx.supplier.findUnique({ where: { id }, select: { taxRateId: true } }))?.taxRateId : null
    const writableTaxRateId = input.taxRateId ? await resolveWritableTaxRateId(tx, input.taxRateId, { keep: new Set([currentTaxRateId]) }) : null
    return tx.supplier.update({
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
        ...(input.taxRateId !== undefined && { taxRateId: writableTaxRateId ?? null }),
        ...(input.vatNumber !== undefined && { vatNumber: input.vatNumber || null }),
        ...(input.accountNumber !== undefined && { accountNumber: input.accountNumber || null }),
        ...(input.paymentTermsDays !== undefined && { paymentTermsDays: input.paymentTermsDays ?? null }),
        ...(input.prepaid !== undefined && { prepaid: input.prepaid }),
        ...(input.manualDeliveryDays !== undefined && { manualDeliveryDays: input.manualDeliveryDays ?? null }),
        ...(input.notes !== undefined && { notes: input.notes || null }),
        ...(input.active !== undefined && { active: input.active }),
      },
      select: SUPPLIER_SELECT,
    })
    })
    revalidatePath('/purchase-orders')
    await logActivity({ entityType: 'SUPPLIER', entityId: s.id, tag: 'purchase', action: 'updated', description: `Updated supplier: ${s.name}` })
    return { success: true, supplier: mapSupplier(s) }
  } catch (e) {
    await logActivity({ entityType: 'SUPPLIER', entityId: id, tag: 'purchase', action: 'updated', level: 'ERROR', description: `Failed to update supplier: ${String(e)}` })
    return { success: false, error: String(e) }
  }
}

export async function importSuppliersCsv(formData: FormData, system?: SystemImportContext): Promise<CsvImportActionResult> {
  const mode = getCsvImportMode(formData)
  const preview = isCsvImportDryRunMode(mode)
  // A system-actor context (the first-load apply runner, a CLI with no session) replaces the session check; anything
  // that is not the real capability takes the permission check, so a forged argument fails closed.
  if (system?.systemImportToken !== SYSTEM_IMPORT) await requirePermission('purchasing.create')
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

    // The supplier's default tax rate is given by its Xero tax type (`purchaseTaxType`), resolved to EXACTLY ONE active tax rate usable for purchases (usedFor PURCHASE or
    // BOTH) that carries that accountingTaxType. Zero or several refuse the row: a default tax rate is never guessed (by name or otherwise).
    const isSystemImport = system?.systemImportToken === SYSTEM_IMPORT
    const purchaseRatesByType = await loadPurchaseRatesByType(db)

    let created = 0
    let updated = 0
    let skipped = 0
    const createdSupplierIds: string[] = []
    const updatedSupplierIds: string[] = []
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
      // The first-load runner states both facts of every supplier: a blank currency would take the importer's silent default (the base currency), and a blank tax class
      // would leave the supplier without a default tax rate. The interactive importer keeps its defaults; a system import refuses the row.
      if (isSystemImport && !r.currency?.trim()) {
        errors.push(`Row ${lineNum}: currency is blank (a system import never takes the default currency)`)
        skipped++
        continue
      }
      const taxType = r.purchaseTaxType?.trim() ?? ''
      let taxRateId: string | null = null
      if (taxType !== '') {
        const matches = purchaseRatesByType.get(taxType) ?? []
        if (matches.length !== 1) {
          errors.push(`Row ${lineNum}: purchaseTaxType matches ${matches.length} active purchase tax rates (exactly one is needed)`)
          skipped++
          continue
        }
        taxRateId = matches[0]
      } else if (isSystemImport) {
        errors.push(`Row ${lineNum}: purchaseTaxType is blank (a system import never leaves the default tax rate unset)`)
        skipped++
        continue
      }
      try {
        if (existing) {
          if (!preview) {
            await db.$transaction(async (tx) => {
            // The matched active rate is re-resolved in the write's transaction (a re-key may have retired it since the lookup).
            const writableTaxRateId = taxRateId ? await resolveWritableTaxRateId(tx, taxRateId) : null
            await tx.supplier.update({
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
                ...(taxRateId ? { taxRateId: writableTaxRateId ?? taxRateId } : {}),
              },
            })
            })
          }
          if (!preview) updatedSupplierIds.push(existing.id)
          updated++
        } else {
          if (!preview) {
            const createdSupplier = await db.$transaction(async (tx) => {
            const writableTaxRateId = taxRateId ? await resolveWritableTaxRateId(tx, taxRateId) : null
            return tx.supplier.create({
              select: { id: true },
              data: {
                name,
                contactName: r.contactName?.trim() || null,
                email: r.email?.trim() || null,
                phone: r.phone?.trim() || null,
                currency: r.currency?.trim().toUpperCase() || baseCurrency,
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
                taxRateId: writableTaxRateId ?? taxRateId,
              },
            })
            })
            createdSupplierIds.push(createdSupplier.id)
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
    if (system?.systemImportToken !== SYSTEM_IMPORT) revalidatePath('/purchase-orders/suppliers')
    await logActivity(withSystemActor({
      entityType: 'IMPORT',
      tag: 'import',
      action: 'imported',
      level: errors.length && created === 0 && updated === 0 ? 'ERROR' : (errors.length ? 'WARNING' : 'INFO'),
      description: errors.length
        ? `Imported ${created} suppliers, updated ${updated} from CSV with warnings: ${errors[0]}`
        : `Imported ${created} suppliers, updated ${updated} from CSV`,
    }, system))
    const execution = createCsvImportExecutionResult({
      created,
      updated,
      skipped,
      errors,
      error: created === 0 && updated === 0 && errors.length > 0 ? errors[0] : undefined,
    })
    return withSystemOutcome(execution, system, { created: createdSupplierIds, updated: updatedSupplierIds })
  } catch (e) {
    const error = String(e)
    await runCsvImportMutation(mode, () => logActivity(withSystemActor({ entityType: 'IMPORT', tag: 'import', action: 'imported', level: 'ERROR', description: `Failed to import suppliers from CSV: ${error}` }, system)))
    return preview
      ? createCsvImportPreviewResult({ totalRows: 0, created: 0, updated: 0, errorCount: 1, errors: [error], error })
      : createCsvImportExecutionResult({ created: 0, updated: 0, skipped: 0, errors: [error], error, success: false })
  }
}
