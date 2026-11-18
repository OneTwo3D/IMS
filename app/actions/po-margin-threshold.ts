'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requirePermission } from '@/lib/auth/server'
import { getSettingValue, serializeSettingValue } from '@/lib/settings-store'
import {
  MARGIN_THRESHOLD_SETTING_KEY,
  parseMarginThresholdSettings,
  validateMarginThresholdInput,
  type MarginThresholdSettings,
} from '@/lib/domain/purchasing/margin-threshold'

/**
 * INTERNAL ONLY (o3d-hqvrp.380). The purchase-order minimum gross margin settings: a global minimum, optional
 * per-category and per-product overrides, and the mode (warn or block). Admin-only, like every company
 * setting. Written by this dedicated action rather than the generic preference writer, so the value is
 * validated here (percentages 0 to 99.99, known categories and products) before anything is stored.
 */

export type MarginThresholdOverrideLabel = { id: string; label: string }

export type MarginThresholdSettingsView = {
  settings: MarginThresholdSettings
  categoryLabels: Record<string, string>
  productLabels: Record<string, string>
}

export async function getPoMarginThresholdSettings(): Promise<MarginThresholdSettingsView> {
  await requirePermission('settings.company')
  const settings = parseMarginThresholdSettings(await getSettingValue(MARGIN_THRESHOLD_SETTING_KEY))
  const [categories, products] = await Promise.all([
    db.productCategory.findMany({ where: { id: { in: Object.keys(settings.categories) } }, select: { id: true, name: true } }),
    db.product.findMany({ where: { id: { in: Object.keys(settings.products) } }, select: { id: true, sku: true, name: true } }),
  ])
  return {
    settings,
    categoryLabels: Object.fromEntries(categories.map((c) => [c.id, c.name])),
    productLabels: Object.fromEntries(products.map((p) => [p.id, `${p.sku} - ${p.name}`])),
  }
}

const searchSchema = z.string().trim().min(2).max(64)

/** Products matching a SKU or name fragment, for picking a per-product override. */
export async function searchProductsForMarginOverride(query: string): Promise<MarginThresholdOverrideLabel[]> {
  await requirePermission('settings.company')
  const parsed = searchSchema.safeParse(query)
  if (!parsed.success) return []
  const rows = await db.product.findMany({
    where: { OR: [{ sku: { contains: parsed.data, mode: 'insensitive' } }, { name: { contains: parsed.data, mode: 'insensitive' } }] },
    select: { id: true, sku: true, name: true },
    orderBy: { sku: 'asc' },
    take: 10,
  })
  return rows.map((p) => ({ id: p.id, label: `${p.sku} - ${p.name}` }))
}

export async function listCategoriesForMarginOverride(): Promise<MarginThresholdOverrideLabel[]> {
  await requirePermission('settings.company')
  const rows = await db.productCategory.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } })
  return rows.map((c) => ({ id: c.id, label: c.name }))
}

export type SavePoMarginThresholdResult = { success: true } | { success: false; error: string }

export async function savePoMarginThresholdSettings(raw: {
  mode: unknown
  globalPct: unknown
  categories: unknown
  products: unknown
}): Promise<SavePoMarginThresholdResult> {
  const session = await requirePermission('settings.company')
  const validated = validateMarginThresholdInput(raw ?? {})
  if (!validated.ok) return { success: false, error: validated.error }
  const { settings } = validated

  const categoryIds = Object.keys(settings.categories)
  const productIds = Object.keys(settings.products)
  const [knownCategories, knownProducts] = await Promise.all([
    categoryIds.length ? db.productCategory.count({ where: { id: { in: categoryIds } } }) : Promise.resolve(0),
    productIds.length ? db.product.count({ where: { id: { in: productIds } } }) : Promise.resolve(0),
  ])
  if (knownCategories !== categoryIds.length) return { success: false, error: 'A category override refers to a category that no longer exists' }
  if (knownProducts !== productIds.length) return { success: false, error: 'A product override refers to a product that no longer exists' }

  const value = serializeSettingValue(MARGIN_THRESHOLD_SETTING_KEY, JSON.stringify(settings))
  await db.setting.upsert({
    where: { key: MARGIN_THRESHOLD_SETTING_KEY },
    create: { key: MARGIN_THRESHOLD_SETTING_KEY, value },
    update: { value },
  })
  await logActivity({
    entityType: 'SETTING',
    tag: 'settings',
    action: 'updated',
    userId: session.user.id ?? null,
    description: `Updated purchase order minimum margin: mode ${settings.mode}, global ${settings.globalPct ?? 'none'}, ${categoryIds.length} category and ${productIds.length} product override(s)`,
  })
  try { revalidatePath('/settings/purchasing') } catch { /* cache refresh only */ }
  return { success: true }
}
