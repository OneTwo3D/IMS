'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requireAuth } from '@/lib/auth/server'

// ---------------------------------------------------------------------------
// Adjustment Reasons
// ---------------------------------------------------------------------------

export type AdjustmentReason = {
  id: string
  name: string
  xeroAccountCode: string | null
  sortOrder: number
  active: boolean
}

export async function getAdjustmentReasons(activeOnly = false): Promise<AdjustmentReason[]> {
  await requireAuth()
  return db.adjustmentReason.findMany({
    where: activeOnly ? { active: true } : undefined,
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    select: { id: true, name: true, xeroAccountCode: true, sortOrder: true, active: true },
  })
}

const reasonSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  xeroAccountCode: z.string().max(20).optional().or(z.literal('')),
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
  xeroAccountCode: string
  sortOrder: number
  active: boolean
}

export async function createAdjustmentReason(
  data: ReasonInput
): Promise<ReasonFormState> {
  await requireAuth()
  const parsed = reasonSchema.safeParse(data)
  if (!parsed.success) {
    return { errors: parsed.error.flatten().fieldErrors }
  }
  const { name, xeroAccountCode, sortOrder, active } = parsed.data
  try {
    const item = await db.adjustmentReason.create({
      data: { name, xeroAccountCode: xeroAccountCode || null, sortOrder, active },
      select: { id: true, name: true, xeroAccountCode: true, sortOrder: true, active: true },
    })
    logActivity({ entityType: 'SETTING', entityId: item.id, tag: 'settings', action: 'created', description: `Created adjustment reason: ${name}` })
    revalidatePath('/settings', 'layout')
    return { success: true, item }
  } catch {
    logActivity({ entityType: 'SETTING', tag: 'settings', action: 'created', level: 'ERROR', description: `Failed to create adjustment reason: ${name}` })
    return { message: 'Failed to create reason.' }
  }
}

export async function updateAdjustmentReason(
  id: string,
  data: ReasonInput
): Promise<ReasonFormState> {
  await requireAuth()
  const parsed = reasonSchema.safeParse(data)
  if (!parsed.success) {
    return { errors: parsed.error.flatten().fieldErrors }
  }
  const { name, xeroAccountCode, sortOrder, active } = parsed.data
  try {
    const item = await db.adjustmentReason.update({
      where: { id },
      data: { name, xeroAccountCode: xeroAccountCode || null, sortOrder, active },
      select: { id: true, name: true, xeroAccountCode: true, sortOrder: true, active: true },
    })
    logActivity({ entityType: 'SETTING', entityId: item.id, tag: 'settings', action: 'updated', description: `Updated adjustment reason: ${name}` })
    revalidatePath('/settings', 'layout')
    return { success: true, item }
  } catch {
    logActivity({ entityType: 'SETTING', entityId: id, tag: 'settings', action: 'updated', level: 'ERROR', description: `Failed to update adjustment reason: ${name}` })
    return { message: 'Failed to update reason.' }
  }
}

export async function deleteAdjustmentReason(id: string): Promise<{ error?: string }> {
  await requireAuth()
  try {
    await db.adjustmentReason.delete({ where: { id } })
    logActivity({ entityType: 'SETTING', entityId: id, tag: 'settings', action: 'deleted', description: 'Deleted adjustment reason' })
    revalidatePath('/settings', 'layout')
    return {}
  } catch {
    logActivity({ entityType: 'SETTING', entityId: id, tag: 'settings', action: 'deleted', level: 'ERROR', description: 'Failed to delete adjustment reason' })
    return { error: 'Failed to delete reason.' }
  }
}

// ---------------------------------------------------------------------------
// Tax Rates
// ---------------------------------------------------------------------------

export type TaxRateRow = {
  id: string
  name: string
  rate: number
  type: string
  usedFor: string
  xeroTaxType: string | null
  isDefault: boolean
  active: boolean
}

export async function getTaxRates(activeOnly = true): Promise<TaxRateRow[]> {
  await requireAuth()
  const rows = await db.taxRate.findMany({
    where: activeOnly ? { active: true } : undefined,
    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    select: { id: true, name: true, rate: true, type: true, usedFor: true, xeroTaxType: true, isDefault: true, active: true },
  })
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    rate: Number(r.rate),
    type: r.type,
    usedFor: r.usedFor,
    xeroTaxType: r.xeroTaxType,
    isDefault: r.isDefault,
    active: r.active,
  }))
}

export async function createTaxRate(input: {
  name: string
  rate: number
  usedFor: string
  xeroTaxType?: string
}): Promise<{ success: boolean; error?: string }> {
  await requireAuth()
  try {
    await db.taxRate.create({
      data: {
        name: input.name,
        rate: input.rate,
        usedFor: input.usedFor || 'BOTH',
        xeroTaxType: input.xeroTaxType || null,
      },
    })
    logActivity({ entityType: 'SETTING', tag: 'settings', action: 'created', description: `Created tax rate: ${input.name} (${input.rate}%)` })
    revalidatePath('/settings', 'layout')
    return { success: true }
  } catch (e) {
    logActivity({ entityType: 'SETTING', tag: 'settings', action: 'created', level: 'ERROR', description: `Failed to create tax rate: ${input.name}` })
    return { success: false, error: String(e) }
  }
}

export async function updateTaxRate(id: string, input: {
  name?: string
  rate?: number
  usedFor?: string
  xeroTaxType?: string
  active?: boolean
}): Promise<{ success: boolean; error?: string }> {
  await requireAuth()
  try {
    await db.taxRate.update({
      where: { id },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.rate !== undefined && { rate: input.rate }),
        ...(input.usedFor !== undefined && { usedFor: input.usedFor }),
        ...(input.xeroTaxType !== undefined && { xeroTaxType: input.xeroTaxType || null }),
        ...(input.active !== undefined && { active: input.active }),
      },
    })
    logActivity({ entityType: 'SETTING', entityId: id, tag: 'settings', action: 'updated', description: `Updated tax rate: ${input.name ?? id}` })
    revalidatePath('/settings', 'layout')
    return { success: true }
  } catch (e) {
    logActivity({ entityType: 'SETTING', entityId: id, tag: 'settings', action: 'updated', level: 'ERROR', description: `Failed to update tax rate: ${input.name ?? id}` })
    return { success: false, error: String(e) }
  }
}

// ---------------------------------------------------------------------------
// Global Settings (key-value)
// ---------------------------------------------------------------------------

export async function getSetting(key: string): Promise<string | null> {
  await requireAuth()
  const row = await db.setting.findUnique({ where: { key } })
  return row?.value ?? null
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
  await requireAuth()
  await db.setting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  })
  logActivity({ entityType: 'SETTING', tag: 'settings', action: 'updated', description: `Updated setting: ${key}` })
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
  await requireAuth()
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
    logActivity({ entityType: 'SETTING', tag: 'settings', action: 'created', description: `Created purchase unit: ${input.name}` })
    revalidatePath('/settings', 'layout')
    return { success: true }
  } catch (e) {
    logActivity({ entityType: 'SETTING', tag: 'settings', action: 'created', level: 'ERROR', description: `Failed to create purchase unit: ${input.name}` })
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
  await requireAuth()
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
    logActivity({ entityType: 'SETTING', entityId: id, tag: 'settings', action: 'updated', description: `Updated purchase unit: ${input.name ?? id}` })
    revalidatePath('/settings', 'layout')
    return { success: true }
  } catch (e) {
    logActivity({ entityType: 'SETTING', entityId: id, tag: 'settings', action: 'updated', level: 'ERROR', description: `Failed to update purchase unit: ${input.name ?? id}` })
    return { success: false, error: String(e) }
  }
}
