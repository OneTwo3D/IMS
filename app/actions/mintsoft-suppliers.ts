'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requireFreshAdmin, requireRole } from '@/lib/auth/server'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'
import { serializeSettingValue } from '@/lib/settings-store'
import {
  confirmSupplierMapping,
  createMintsoftSupplierForImsSupplier,
  loadSupplierMappingScreen,
  unmapSupplier,
  type MappingActor,
  type MappingResult,
  type SupplierMappingScreen,
} from '@/lib/connectors/mintsoft/suppliers/mapping'
import { runMintsoftSupplierSync } from '@/lib/connectors/mintsoft/suppliers/supplier-sync'
import { MINTSOFT_ASN_SUPPLIER_REQUIRED_SETTING, MINTSOFT_SUPPLIER_CREATE_SETTING, MINTSOFT_TRANSFER_SUPPLIER_SETTING } from '@/lib/connectors/mintsoft/suppliers/settings'

/**
 * SETTINGS > MINTSOFT SUPPLIERS (/sync/mintsoft-suppliers): the operator screen that maps each IMS supplier to a Mintsoft supplier.
 * MANAGER and ADMIN only. Every decision is audited (lib/connectors/mintsoft/suppliers/mapping.ts). The two switches that change what IMS sends
 * to the live warehouse are ADMIN-only and need a fresh sign-in.
 */

const MAPPING_ROLES = ['ADMIN', 'MANAGER'] as const
const IdSchema = z.string().trim().min(1).max(64)

async function actor(): Promise<MappingActor> {
  const session = await requireRole(...MAPPING_ROLES)
  return { userId: session.user.id, label: session.user.name || session.user.email || session.user.id }
}

export async function getMintsoftSupplierMappingScreen(): Promise<SupplierMappingScreen> {
  await requireRole(...MAPPING_ROLES)
  return loadSupplierMappingScreen()
}

export async function refreshMintsoftSuppliers(): Promise<{ success: boolean; error?: string; message?: string }> {
  const who = await actor()
  if (!await isIntegrationPluginEnabled('mintsoft')) return { success: false, error: 'Mintsoft is disabled.' }
  try {
    const result = await runMintsoftSupplierSync({ triggeredBy: `operator:${who.userId ?? 'unknown'}`, userId: who.userId })
    revalidatePath('/sync/mintsoft-suppliers')
    return { success: true, message: `Read ${result.fetched} suppliers from Mintsoft (${result.created} new, ${result.missing} no longer listed). Nothing was written to Mintsoft.` }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'The Mintsoft supplier list could not be read.' }
  }
}

const ConfirmSchema = z.object({
  supplierId: IdSchema,
  externalSupplierId: z.string().trim().regex(/^\d+$/, 'Choose a Mintsoft supplier.'),
  source: z.enum(['OPERATOR_CONFIRMED_SUGGESTION', 'OPERATOR_PICKED']),
  suggestionScore: z.number().int().min(0).max(100).nullable().optional(),
})

export async function confirmMintsoftSupplierMapping(input: unknown): Promise<MappingResult> {
  const who = await actor()
  const parsed = ConfirmSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid request.' }
  const result = await confirmSupplierMapping({ ...parsed.data, actor: who })
  revalidatePath('/sync/mintsoft-suppliers')
  return result
}

export async function createMintsoftSupplierFromIms(supplierId: unknown): Promise<MappingResult> {
  const who = await actor()
  if (!await isIntegrationPluginEnabled('mintsoft')) return { success: false, error: 'Mintsoft is disabled.' }
  const parsed = IdSchema.safeParse(supplierId)
  if (!parsed.success) return { success: false, error: 'Invalid supplier.' }
  const result = await createMintsoftSupplierForImsSupplier({ supplierId: parsed.data, actor: who })
  revalidatePath('/sync/mintsoft-suppliers')
  return result
}

export async function unmapMintsoftSupplier(supplierId: unknown): Promise<MappingResult> {
  const who = await actor()
  const parsed = IdSchema.safeParse(supplierId)
  if (!parsed.success) return { success: false, error: 'Invalid supplier.' }
  const result = await unmapSupplier({ supplierId: parsed.data, actor: who })
  revalidatePath('/sync/mintsoft-suppliers')
  return result
}

/** Which IMS supplier transfer ASNs carry (owner decision 2026-11-19: "One Two Enterprises Ltd"). Blank clears it. */
export async function saveMintsoftTransferSupplier(supplierId: unknown): Promise<{ success: boolean; error?: string }> {
  const who = await actor()
  const value = typeof supplierId === 'string' ? supplierId.trim() : ''
  if (value && !IdSchema.safeParse(value).success) return { success: false, error: 'Invalid supplier.' }
  const supplier = value ? await db.supplier.findUnique({ where: { id: value }, select: { name: true } }) : null
  if (value && !supplier) return { success: false, error: 'That supplier does not exist.' }
  const previous = await db.$transaction(async (tx) => {
    const row = await tx.setting.findUnique({ where: { key: MINTSOFT_TRANSFER_SUPPLIER_SETTING } })
    await tx.setting.upsert({ where: { key: MINTSOFT_TRANSFER_SUPPLIER_SETTING }, create: { key: MINTSOFT_TRANSFER_SUPPLIER_SETTING, value: serializeSettingValue(MINTSOFT_TRANSFER_SUPPLIER_SETTING, value) }, update: { value: serializeSettingValue(MINTSOFT_TRANSFER_SUPPLIER_SETTING, value) } })
    return row?.value ?? ''
  })
  if (previous !== value) {
    await logActivity({
      entityType: 'SETTING', tag: 'sync', action: 'mintsoft_transfer_supplier_updated', userId: who.userId,
      description: value ? `Transfer ASNs now carry IMS supplier "${supplier?.name}".` : 'Transfer ASNs no longer have a supplier chosen.',
      metadata: { before: previous || null, after: value || null },
    })
  }
  revalidatePath('/sync/mintsoft-suppliers')
  return { success: true }
}

/**
 * The two switches. ADMIN only, fresh sign-in: they change what IMS sends to the LIVE warehouse. Both read ON only for the exact string 'true'.
 */
export async function saveMintsoftSupplierSwitches(input: unknown): Promise<{ success: boolean; error?: string }> {
  const session = await requireFreshAdmin()
  const parsed = z.object({ createEnabled: z.boolean(), asnRequired: z.boolean() }).safeParse(input)
  if (!parsed.success) return { success: false, error: 'Choose on or off for each switch.' }
  const entries = [
    [MINTSOFT_SUPPLIER_CREATE_SETTING, parsed.data.createEnabled],
    [MINTSOFT_ASN_SUPPLIER_REQUIRED_SETTING, parsed.data.asnRequired],
  ] as const
  const before = await db.$transaction(async (tx) => {
    const out: Record<string, boolean> = {}
    for (const [key, enabled] of entries) {
      const row = await tx.setting.findUnique({ where: { key } })
      out[key] = row?.value === 'true'
      const value = enabled ? 'true' : 'false'
      await tx.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
    }
    return out
  })
  for (const [key, enabled] of entries) {
    if (before[key] === enabled) continue
    await logActivity({
      entityType: 'SETTING', tag: 'sync', action: `${key}_updated`, userId: session.user.id, level: 'WARNING',
      description: key === MINTSOFT_SUPPLIER_CREATE_SETTING
        ? `Creating suppliers in Mintsoft is now ${enabled ? 'ON' : 'OFF'}.`
        : `An ASN without a mapped Mintsoft supplier is now ${enabled ? 'REFUSED' : 'created as before'}.`,
      metadata: { before: before[key], after: enabled },
    })
  }
  revalidatePath('/sync/mintsoft-suppliers')
  return { success: true }
}
