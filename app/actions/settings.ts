'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requireAuth, requirePermission } from '@/lib/auth/server'
import { getSettingValue, serializeSettingValue } from '@/lib/settings-store'

// ---------------------------------------------------------------------------
// Adjustment Reasons
// ---------------------------------------------------------------------------

export type AdjustmentReason = {
  id: string
  name: string
  accountCode: string | null
  sortOrder: number
  active: boolean
}

export async function getAdjustmentReasons(activeOnly = false): Promise<AdjustmentReason[]> {
  await requireAuth()
  return db.adjustmentReason.findMany({
    where: activeOnly ? { active: true } : undefined,
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    select: { id: true, name: true, accountCode: true, sortOrder: true, active: true },
  })
}

const reasonSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  accountCode: z.string().max(20).optional().or(z.literal('')),
  sortOrder: z.coerce.number().int().default(0),
  active: z.boolean().default(true),
})

export type ReasonFormState = {
  errors?: Record<string, string[]>
  message?: string
  success?: boolean
  item?: AdjustmentReason
}

export type ReasonInput = {
  name: string
  accountCode: string
  sortOrder: number
  active: boolean
}

export async function createAdjustmentReason(
  data: ReasonInput
): Promise<ReasonFormState> {
  await requirePermission('settings.company')
  const parsed = reasonSchema.safeParse(data)
  if (!parsed.success) {
    return { errors: parsed.error.flatten().fieldErrors }
  }
  const { name, accountCode, sortOrder, active } = parsed.data
  try {
    const item = await db.adjustmentReason.create({
      data: { name, accountCode: accountCode || null, sortOrder, active },
      select: { id: true, name: true, accountCode: true, sortOrder: true, active: true },
    })
    await logActivity({ entityType: 'SETTING', entityId: item.id, tag: 'settings', action: 'created', description: `Created adjustment reason: ${name}` })
    revalidatePath('/settings', 'layout')
    return { success: true, item }
  } catch {
    await logActivity({ entityType: 'SETTING', tag: 'settings', action: 'created', level: 'ERROR', description: `Failed to create adjustment reason: ${name}` })
    return { message: 'Failed to create reason.' }
  }
}

export async function updateAdjustmentReason(
  id: string,
  data: ReasonInput
): Promise<ReasonFormState> {
  await requirePermission('settings.company')
  const parsed = reasonSchema.safeParse(data)
  if (!parsed.success) {
    return { errors: parsed.error.flatten().fieldErrors }
  }
  const { name, accountCode, sortOrder, active } = parsed.data
  try {
    const item = await db.adjustmentReason.update({
      where: { id },
      data: { name, accountCode: accountCode || null, sortOrder, active },
      select: { id: true, name: true, accountCode: true, sortOrder: true, active: true },
    })
    await logActivity({ entityType: 'SETTING', entityId: item.id, tag: 'settings', action: 'updated', description: `Updated adjustment reason: ${name}` })
    revalidatePath('/settings', 'layout')
    return { success: true, item }
  } catch {
    await logActivity({ entityType: 'SETTING', entityId: id, tag: 'settings', action: 'updated', level: 'ERROR', description: `Failed to update adjustment reason: ${name}` })
    return { message: 'Failed to update reason.' }
  }
}

export async function deleteAdjustmentReason(id: string): Promise<{ error?: string }> {
  await requirePermission('settings.company')
  try {
    await db.adjustmentReason.delete({ where: { id } })
    await logActivity({ entityType: 'SETTING', entityId: id, tag: 'settings', action: 'deleted', description: 'Deleted adjustment reason' })
    revalidatePath('/settings', 'layout')
    return {}
  } catch {
    await logActivity({ entityType: 'SETTING', entityId: id, tag: 'settings', action: 'deleted', level: 'ERROR', description: 'Failed to delete adjustment reason' })
    return { error: 'Failed to delete reason.' }
  }
}

// ---------------------------------------------------------------------------
// Tax Rates
// ---------------------------------------------------------------------------

export type TaxCategoryValue = 'STANDARD' | 'REDUCED' | 'SECOND_REDUCED' | 'ZERO' | 'EXEMPT'

export type TaxRateRow = {
  id: string
  name: string
  rate: number
  type: string
  usedFor: string
  accountingTaxType: string | null
  countryCode: string | null
  taxCategory: TaxCategoryValue
  isDefault: boolean
  active: boolean
}

const TAX_CATEGORIES: TaxCategoryValue[] = ['STANDARD', 'REDUCED', 'SECOND_REDUCED', 'ZERO', 'EXEMPT']

function normaliseTaxCategory(input: unknown): TaxCategoryValue {
  if (typeof input === 'string' && (TAX_CATEGORIES as string[]).includes(input)) {
    return input as TaxCategoryValue
  }
  return 'STANDARD'
}

export async function getTaxRates(activeOnly = true): Promise<TaxRateRow[]> {
  await requireAuth()
  const rows = await db.taxRate.findMany({
    where: activeOnly ? { active: true } : undefined,
    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    select: {
      id: true,
      name: true,
      rate: true,
      type: true,
      usedFor: true,
      accountingTaxType: true,
      countryCode: true,
      taxCategory: true,
      isDefault: true,
      active: true,
    },
  })
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    rate: Number(r.rate),
    type: r.type,
    usedFor: r.usedFor,
    accountingTaxType: r.accountingTaxType,
    countryCode: r.countryCode,
    taxCategory: r.taxCategory as TaxCategoryValue,
    isDefault: r.isDefault,
    active: r.active,
  }))
}

export async function createTaxRate(input: {
  name: string
  rate: number
  usedFor: string
  accountingTaxType?: string
  countryCode?: string | null
  taxCategory?: TaxCategoryValue
}): Promise<{ success: boolean; error?: string }> {
  await requirePermission('settings.company')
  try {
    await db.taxRate.create({
      data: {
        name: input.name,
        rate: input.rate,
        usedFor: input.usedFor || 'BOTH',
        accountingTaxType: input.accountingTaxType || null,
        countryCode: input.countryCode ? input.countryCode.toLowerCase() : null,
        taxCategory: normaliseTaxCategory(input.taxCategory),
      },
    })
    await logActivity({ entityType: 'SETTING', tag: 'settings', action: 'created', description: `Created tax rate: ${input.name} (${input.rate}%)` })
    revalidatePath('/settings', 'layout')
    return { success: true }
  } catch (e) {
    await logActivity({ entityType: 'SETTING', tag: 'settings', action: 'created', level: 'ERROR', description: `Failed to create tax rate: ${input.name}` })
    return { success: false, error: String(e) }
  }
}

export async function updateTaxRate(id: string, input: {
  name?: string
  rate?: number
  usedFor?: string
  accountingTaxType?: string
  countryCode?: string | null
  taxCategory?: TaxCategoryValue
  active?: boolean
}): Promise<{ success: boolean; error?: string }> {
  await requirePermission('settings.company')
  try {
    await db.taxRate.update({
      where: { id },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.rate !== undefined && { rate: input.rate }),
        ...(input.usedFor !== undefined && { usedFor: input.usedFor }),
        ...(input.accountingTaxType !== undefined && { accountingTaxType: input.accountingTaxType || null }),
        ...(input.countryCode !== undefined && { countryCode: input.countryCode ? input.countryCode.toLowerCase() : null }),
        ...(input.taxCategory !== undefined && { taxCategory: normaliseTaxCategory(input.taxCategory) }),
        ...(input.active !== undefined && { active: input.active }),
      },
    })
    await logActivity({ entityType: 'SETTING', entityId: id, tag: 'settings', action: 'updated', description: `Updated tax rate: ${input.name ?? id}` })
    revalidatePath('/settings', 'layout')
    return { success: true }
  } catch (e) {
    await logActivity({ entityType: 'SETTING', entityId: id, tag: 'settings', action: 'updated', level: 'ERROR', description: `Failed to update tax rate: ${input.name ?? id}` })
    return { success: false, error: String(e) }
  }
}

/**
 * Auto-link IMS tax rates to Xero tax types by matching name (case-insensitive).
 * Fetches the live list of Xero tax rates and, for each IMS TaxRate whose
 * accountingTaxType is unset, sets it to the TaxType code of the Xero rate
 * with a matching name.
 */
export async function autoLinkXeroTaxRates(): Promise<{
  success: boolean
  linked: number
  alreadyLinked: number
  unmatched: string[]
  xeroRatesCount: number
  error?: string
}> {
  await requirePermission('settings.company')
  try {
    const { getXeroTaxRates } = await import('@/lib/connectors/xero/accounts')
    const result = await getXeroTaxRates()
    if (!result) {
      return { success: false, linked: 0, alreadyLinked: 0, unmatched: [], xeroRatesCount: 0, error: 'Failed to fetch Xero tax rates (not connected?)' }
    }
    const xeroByName = new Map<string, { taxType: string; name: string; rate: number }>()
    for (const x of result.taxRates) {
      xeroByName.set(x.name.trim().toLowerCase(), x)
    }

    const imsRates = await db.taxRate.findMany({
      where: { active: true },
      select: { id: true, name: true, accountingTaxType: true },
    })

    let linked = 0
    let alreadyLinked = 0
    const unmatched: string[] = []

    for (const ims of imsRates) {
      if (ims.accountingTaxType) { alreadyLinked++; continue }
      const match = xeroByName.get(ims.name.trim().toLowerCase())
      if (!match) { unmatched.push(ims.name); continue }
      await db.taxRate.update({
        where: { id: ims.id },
        data: { accountingTaxType: match.taxType },
      })
      linked++
    }

    await logActivity({
      entityType: 'SETTING',
      tag: 'settings',
      action: 'xero_tax_rates_linked',
      description: `Auto-linked ${linked} IMS tax rate(s) to Xero tax types (${alreadyLinked} already linked, ${unmatched.length} unmatched)`,
      metadata: { linked, alreadyLinked, unmatched, xeroRatesCount: result.taxRates.length },
    })
    revalidatePath('/settings/accounting')
    return {
      success: true,
      linked,
      alreadyLinked,
      unmatched,
      xeroRatesCount: result.taxRates.length,
    }
  } catch (e) {
    return { success: false, linked: 0, alreadyLinked: 0, unmatched: [], xeroRatesCount: 0, error: String(e) }
  }
}

// ---------------------------------------------------------------------------
// Account Codes (from active accounting integration)
// ---------------------------------------------------------------------------

export type AccountCodeOption = { code: string; name: string; type: string }

export async function getAccountCodes(): Promise<AccountCodeOption[]> {
  await requireAuth()
  const { listAccountCodes } = await import('@/lib/accounting')
  return listAccountCodes()
}

// ---------------------------------------------------------------------------
// Global Settings (key-value)
// ---------------------------------------------------------------------------

export async function getSetting(key: string): Promise<string | null> {
  await requireAuth()
  return getSettingValue(key)
}

export type UserOption = { id: string; name: string; email: string }

export async function getUsers(): Promise<UserOption[]> {
  await requireAuth()
  const rows = await db.user.findMany({
    where: { active: true },
    select: { id: true, name: true, email: true },
    orderBy: { name: 'asc' },
  })
  return rows.map((u) => ({ id: u.id, name: u.name ?? u.email, email: u.email }))
}

export async function setSetting(key: string, value: string): Promise<void> {
  await requirePermission('settings.company')
  await db.setting.upsert({
    where: { key },
    create: { key, value: serializeSettingValue(key, value) },
    update: { value: serializeSettingValue(key, value) },
  })
  await logActivity({ entityType: 'SETTING', tag: 'settings', action: 'updated', description: `Updated setting: ${key}` })
  revalidatePath('/settings', 'layout')
}

// ---------------------------------------------------------------------------
// Purchase Units
// ---------------------------------------------------------------------------

export type PurchaseUnitRow = {
  id: string
  name: string
  abbreviation: string
  conversionFactor: number
  stockUnitName: string
  active: boolean
}

export async function getPurchaseUnits(activeOnly = true): Promise<PurchaseUnitRow[]> {
  await requireAuth()
  const rows = await db.purchaseUnit.findMany({
    where: activeOnly ? { active: true } : undefined,
    orderBy: { name: 'asc' },
    select: { id: true, name: true, abbreviation: true, conversionFactor: true, stockUnitName: true, active: true },
  })
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    abbreviation: r.abbreviation,
    conversionFactor: Number(r.conversionFactor),
    stockUnitName: r.stockUnitName,
    active: r.active,
  }))
}

export async function createPurchaseUnit(input: {
  name: string
  abbreviation: string
  conversionFactor: number
  stockUnitName: string
}): Promise<{ success: boolean; error?: string }> {
  await requirePermission('settings.company')
  try {
    if (!input.name.trim()) return { success: false, error: 'Name is required' }
    if (!input.abbreviation.trim()) return { success: false, error: 'Abbreviation is required' }
    if (input.conversionFactor <= 0) return { success: false, error: 'Conversion factor must be greater than 0' }
    await db.purchaseUnit.create({
      data: {
        name: input.name,
        abbreviation: input.abbreviation,
        conversionFactor: input.conversionFactor,
        stockUnitName: input.stockUnitName || 'pcs',
      },
    })
    await logActivity({ entityType: 'SETTING', tag: 'settings', action: 'created', description: `Created purchase unit: ${input.name}` })
    revalidatePath('/settings', 'layout')
    return { success: true }
  } catch (e) {
    await logActivity({ entityType: 'SETTING', tag: 'settings', action: 'created', level: 'ERROR', description: `Failed to create purchase unit: ${input.name}` })
    return { success: false, error: String(e) }
  }
}

/** Returns unique stock unit names from all purchase units, plus "pcs" */
export async function getStockUnitOptions(): Promise<string[]> {
  await requireAuth()
  const rows = await db.purchaseUnit.findMany({
    where: { active: true },
    select: { stockUnitName: true },
    distinct: ['stockUnitName'],
    orderBy: { stockUnitName: 'asc' },
  })
  const names = new Set<string>(['pcs'])
  for (const r of rows) names.add(r.stockUnitName)
  return Array.from(names).sort()
}

export async function updatePurchaseUnit(id: string, input: {
  name?: string
  abbreviation?: string
  conversionFactor?: number
  stockUnitName?: string
  active?: boolean
}): Promise<{ success: boolean; error?: string }> {
  await requirePermission('settings.company')
  try {
    await db.purchaseUnit.update({
      where: { id },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.abbreviation !== undefined && { abbreviation: input.abbreviation }),
        ...(input.conversionFactor !== undefined && { conversionFactor: input.conversionFactor }),
        ...(input.stockUnitName !== undefined && { stockUnitName: input.stockUnitName }),
        ...(input.active !== undefined && { active: input.active }),
      },
    })
    await logActivity({ entityType: 'SETTING', entityId: id, tag: 'settings', action: 'updated', description: `Updated purchase unit: ${input.name ?? id}` })
    revalidatePath('/settings', 'layout')
    return { success: true }
  } catch (e) {
    await logActivity({ entityType: 'SETTING', entityId: id, tag: 'settings', action: 'updated', level: 'ERROR', description: `Failed to update purchase unit: ${input.name ?? id}` })
    return { success: false, error: String(e) }
  }
}

// ---------------------------------------------------------------------------
// Warehouses
// ---------------------------------------------------------------------------

export type WarehouseRow = {
  id: string
  code: string
  name: string
  type: string
  contactName: string | null
  email: string | null
  phone: string | null
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  postcode: string | null
  country: string
  availableForSale: boolean
  syncToWoocommerce: boolean
  isDefault: boolean
  defaultReturnWarehouse: boolean
  active: boolean
}

const warehouseFields = {
  id: true,
  code: true,
  name: true,
  type: true,
  contactName: true,
  email: true,
  phone: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  postcode: true,
  country: true,
  availableForSale: true,
  syncToWoocommerce: true,
  isDefault: true,
  defaultReturnWarehouse: true,
  active: true,
} as const

export async function getWarehousesForSettings(): Promise<WarehouseRow[]> {
  await requireAuth()
  return db.warehouse.findMany({
    orderBy: [{ isDefault: 'desc' }, { code: 'asc' }],
    select: warehouseFields,
  })
}

const warehouseSchema = z.object({
  code: z.string().min(1, 'Code is required').max(20),
  name: z.string().min(1, 'Name is required').max(100),
  type: z.enum(['STANDARD', 'QUARANTINE', 'RESTOCK']).default('STANDARD'),
  contactName: z.string().max(100).optional().or(z.literal('')),
  email: z.string().max(200).optional().or(z.literal('')),
  phone: z.string().max(50).optional().or(z.literal('')),
  addressLine1: z.string().max(200).optional().or(z.literal('')),
  addressLine2: z.string().max(200).optional().or(z.literal('')),
  city: z.string().max(100).optional().or(z.literal('')),
  postcode: z.string().max(20).optional().or(z.literal('')),
  country: z.string().max(10).default('GB'),
  availableForSale: z.boolean().default(true),
  syncToWoocommerce: z.boolean().default(false),
  isDefault: z.boolean().default(false),
  defaultReturnWarehouse: z.boolean().default(false),
  active: z.boolean().default(true),
})

export type WarehouseInput = z.infer<typeof warehouseSchema>

export async function createWarehouse(
  input: WarehouseInput
): Promise<{ success: boolean; item?: WarehouseRow; error?: string }> {
  await requirePermission('settings.company')
  const parsed = warehouseSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: Object.values(parsed.error.flatten().fieldErrors).flat()[0] ?? 'Validation failed' }
  }
  const data = parsed.data
  try {
    // Enforce unique code
    const existing = await db.warehouse.findUnique({ where: { code: data.code } })
    if (existing) return { success: false, error: `Warehouse code "${data.code}" already exists.` }

    // If setting as default, unset others
    if (data.isDefault) {
      await db.warehouse.updateMany({ where: { isDefault: true }, data: { isDefault: false } })
    }
    if (data.defaultReturnWarehouse) {
      await db.warehouse.updateMany({ where: { defaultReturnWarehouse: true }, data: { defaultReturnWarehouse: false } })
    }

    const item = await db.warehouse.create({
      data: {
        code: data.code,
        name: data.name,
        type: data.type,
        contactName: data.contactName || null,
        email: data.email || null,
        phone: data.phone || null,
        addressLine1: data.addressLine1 || null,
        addressLine2: data.addressLine2 || null,
        city: data.city || null,
        postcode: data.postcode || null,
        country: data.country,
        availableForSale: data.availableForSale,
        syncToWoocommerce: data.syncToWoocommerce,
        isDefault: data.isDefault,
        defaultReturnWarehouse: data.defaultReturnWarehouse,
        active: data.active,
      },
      select: warehouseFields,
    })
    await logActivity({ entityType: 'SETTING', entityId: item.id, tag: 'settings', action: 'created', description: `Created warehouse: ${data.code} — ${data.name}` })
    revalidatePath('/settings', 'layout')
    return { success: true, item }
  } catch (e) {
    await logActivity({ entityType: 'SETTING', tag: 'settings', action: 'created', level: 'ERROR', description: `Failed to create warehouse: ${data.code}` })
    return { success: false, error: String(e) }
  }
}

export async function updateWarehouse(
  id: string,
  input: WarehouseInput
): Promise<{ success: boolean; item?: WarehouseRow; error?: string }> {
  await requirePermission('settings.company')
  const parsed = warehouseSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: Object.values(parsed.error.flatten().fieldErrors).flat()[0] ?? 'Validation failed' }
  }
  const data = parsed.data
  try {
    // Enforce unique code (excluding self)
    const dup = await db.warehouse.findUnique({ where: { code: data.code } })
    if (dup && dup.id !== id) return { success: false, error: `Warehouse code "${data.code}" already exists.` }

    // If setting as default, unset others
    if (data.isDefault) {
      await db.warehouse.updateMany({ where: { isDefault: true, id: { not: id } }, data: { isDefault: false } })
    }
    if (data.defaultReturnWarehouse) {
      await db.warehouse.updateMany({ where: { defaultReturnWarehouse: true, id: { not: id } }, data: { defaultReturnWarehouse: false } })
    }

    const item = await db.warehouse.update({
      where: { id },
      data: {
        code: data.code,
        name: data.name,
        type: data.type,
        contactName: data.contactName || null,
        email: data.email || null,
        phone: data.phone || null,
        addressLine1: data.addressLine1 || null,
        addressLine2: data.addressLine2 || null,
        city: data.city || null,
        postcode: data.postcode || null,
        country: data.country,
        availableForSale: data.availableForSale,
        syncToWoocommerce: data.syncToWoocommerce,
        isDefault: data.isDefault,
        defaultReturnWarehouse: data.defaultReturnWarehouse,
        active: data.active,
      },
      select: warehouseFields,
    })
    await logActivity({ entityType: 'SETTING', entityId: id, tag: 'settings', action: 'updated', description: `Updated warehouse: ${data.code} — ${data.name}` })
    revalidatePath('/settings', 'layout')
    return { success: true, item }
  } catch (e) {
    await logActivity({ entityType: 'SETTING', entityId: id, tag: 'settings', action: 'updated', level: 'ERROR', description: `Failed to update warehouse: ${data.code}` })
    return { success: false, error: String(e) }
  }
}

export async function deleteWarehouse(
  id: string
): Promise<{ success: boolean; deactivated?: boolean; error?: string }> {
  await requirePermission('settings.company')
  try {
    // Check for references that prevent hard delete
    const [stocks, movements, poCount, soCount, allocations] = await Promise.all([
      db.stockLevel.count({ where: { warehouseId: id } }),
      db.stockMovement.count({ where: { OR: [{ fromWarehouseId: id }, { toWarehouseId: id }] } }),
      db.purchaseOrder.count({ where: { destinationWarehouseId: id } }),
      db.salesOrder.count({ where: { shipFromWarehouseId: id } }),
      db.orderAllocation.count({ where: { warehouseId: id } }),
    ])

    const hasData = stocks + movements + poCount + soCount + allocations > 0

    if (hasData) {
      // Deactivate instead of delete
      await db.warehouse.update({ where: { id }, data: { active: false } })
      await logActivity({ entityType: 'SETTING', entityId: id, tag: 'settings', action: 'updated', description: 'Deactivated warehouse (has associated data)' })
      revalidatePath('/settings', 'layout')
      return { success: true, deactivated: true }
    }

    await db.warehouse.delete({ where: { id } })
    await logActivity({ entityType: 'SETTING', entityId: id, tag: 'settings', action: 'deleted', description: 'Deleted warehouse' })
    revalidatePath('/settings', 'layout')
    return { success: true }
  } catch (e) {
    await logActivity({ entityType: 'SETTING', entityId: id, tag: 'settings', action: 'deleted', level: 'ERROR', description: 'Failed to delete warehouse' })
    return { success: false, error: String(e) }
  }
}
