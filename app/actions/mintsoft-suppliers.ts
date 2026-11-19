'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { db } from '@/lib/db'
import { logActivityInTransaction } from '@/lib/activity-log'
import { requireFreshAdmin, requireRole } from '@/lib/auth/server'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'
import { serializeSettingValue } from '@/lib/settings-store'
import {
  confirmSupplierMapping,
  createMintsoftSupplierForImsSupplier,
  loadSupplierMappingScreen,
  resolveUnknownSupplierCreate,
  unmapSupplier,
  type MappingActor,
  type MappingResult,
  type SupplierMappingScreen,
} from '@/lib/connectors/mintsoft/suppliers/mapping'
import { runMintsoftSupplierSync } from '@/lib/connectors/mintsoft/suppliers/supplier-sync'
import { MINTSOFT_ASN_SEND_SUPPLIER_SETTING, MINTSOFT_ASN_SUPPLIER_REQUIRED_SETTING, MINTSOFT_SUPPLIER_CREATE_SETTING, MINTSOFT_TRANSFER_SUPPLIER_SETTING } from '@/lib/connectors/mintsoft/suppliers/settings'

/**
 * SETTINGS > MINTSOFT SUPPLIERS (/sync/mintsoft-suppliers): the operator screen that maps each IMS supplier to a Mintsoft supplier.
 * MANAGER and ADMIN only. Every decision is audited (lib/connectors/mintsoft/suppliers/mapping.ts). Everything that changes what IMS sends to the
 * live warehouse is ADMIN-only and needs a fresh sign-in: the three switches, the transfer supplier, and resolving an unknown create outcome.
 */

const MAPPING_ROLES = ['ADMIN', 'MANAGER'] as const
const IdSchema = z.string().trim().min(1).max(64)

async function actor(): Promise<MappingActor> {
  const session = await requireRole(...MAPPING_ROLES)
  return { userId: session.user.id, label: session.user.name || session.user.email || session.user.id }
}

export async function getMintsoftSupplierMappingScreen(): Promise<SupplierMappingScreen> {
  const session = await requireRole(...MAPPING_ROLES)
  return { ...(await loadSupplierMappingScreen()), viewerIsAdmin: session.user.role === 'ADMIN' }
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

const CreateSchema = z.object({
  supplierId: IdSchema,
  /** Present only when the operator confirmed "create anyway" after the duplicate guard refused; the reason is required. */
  createAnyway: z.object({ reason: z.string().trim().min(5).max(500) }).optional(),
})

export async function createMintsoftSupplierFromIms(input: unknown): Promise<MappingResult> {
  const who = await actor()
  if (!await isIntegrationPluginEnabled('mintsoft')) return { success: false, error: 'Mintsoft is disabled.' }
  const parsed = CreateSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid request.' }
  const result = await createMintsoftSupplierForImsSupplier({ supplierId: parsed.data.supplierId, createAnyway: parsed.data.createAnyway, actor: who })
  revalidatePath('/sync/mintsoft-suppliers')
  return result
}

const ResolveSchema = z.object({
  supplierId: IdSchema,
  reason: z.string().trim().min(5, 'Give a reason: what you checked in Mintsoft.').max(500),
  outcome: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('FOUND'), externalSupplierId: z.string().trim().regex(/^\d+$/, 'Enter the numeric Mintsoft supplier id.') }),
    z.object({ kind: z.literal('NOT_CREATED') }),
  ]),
})

/** Settle a create whose outcome is unknown (row in CREATING). ADMIN, fresh sign-in, with a reason. The only way out of CREATING. */
export async function resolveUnknownMintsoftSupplierCreate(input: unknown): Promise<MappingResult> {
  const session = await requireFreshAdmin()
  const parsed = ResolveSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid request.' }
  const result = await resolveUnknownSupplierCreate({ ...parsed.data, actor: { userId: session.user.id, label: session.user.name || session.user.email || session.user.id } })
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

/** Which IMS supplier transfer ASNs carry (owner decision 2026-11-19: "One Two Enterprises Ltd"). Blank clears it. ADMIN, fresh sign-in: it decides the supplier on every transfer ASN. */
export async function saveMintsoftTransferSupplier(supplierId: unknown): Promise<{ success: boolean; error?: string }> {
  const session = await requireFreshAdmin()
  const value = typeof supplierId === 'string' ? supplierId.trim() : ''
  if (value && !IdSchema.safeParse(value).success) return { success: false, error: 'Invalid supplier.' }
  const supplier = value ? await db.supplier.findUnique({ where: { id: value }, select: { name: true } }) : null
  if (value && !supplier) return { success: false, error: 'That supplier does not exist.' }
  await db.$transaction(async (tx) => {
    const row = await tx.setting.findUnique({ where: { key: MINTSOFT_TRANSFER_SUPPLIER_SETTING } })
    const previous = row?.value ?? ''
    await tx.setting.upsert({ where: { key: MINTSOFT_TRANSFER_SUPPLIER_SETTING }, create: { key: MINTSOFT_TRANSFER_SUPPLIER_SETTING, value: serializeSettingValue(MINTSOFT_TRANSFER_SUPPLIER_SETTING, value) }, update: { value: serializeSettingValue(MINTSOFT_TRANSFER_SUPPLIER_SETTING, value) } })
    if (previous === value) return
    // Audited in the same transaction: a failed audit write rolls the change back.
    await logActivityInTransaction(tx, {
      entityType: 'SETTING', tag: 'sync', action: 'mintsoft_transfer_supplier_updated', userId: session.user.id, level: 'WARNING',
      description: value ? `Transfer ASNs now carry IMS supplier "${supplier?.name}".` : 'Transfer ASNs no longer have a supplier chosen.',
      metadata: { before: previous || null, after: value || null },
    })
  })
  revalidatePath('/sync/mintsoft-suppliers')
  return { success: true }
}

/**
 * The three switches. ADMIN only, fresh sign-in: they change what IMS sends to the LIVE warehouse. Each reads ON only for the exact string 'true'.
 * "Required" cannot be saved ON unless "send the supplier on an ASN" is ON in the same save: a required supplier that is never sent would refuse
 * every ASN (and the field name is UNVERIFIED until controlled-run step 2 has read it back). Audited in the same transaction as the change.
 */
export async function saveMintsoftSupplierSwitches(input: unknown): Promise<{ success: boolean; error?: string }> {
  const session = await requireFreshAdmin()
  const parsed = z.object({ createEnabled: z.boolean(), asnRequired: z.boolean(), sendSupplierEnabled: z.boolean() }).safeParse(input)
  if (!parsed.success) return { success: false, error: 'Choose on or off for each switch.' }
  if (parsed.data.asnRequired && !parsed.data.sendSupplierEnabled) {
    return { success: false, error: 'Refusing an ASN without a mapped supplier needs "send the supplier on an ASN" to be on as well. Turn that on (only after controlled-run step 2 has verified the field), or leave this off.' }
  }
  const entries = [
    [MINTSOFT_SUPPLIER_CREATE_SETTING, parsed.data.createEnabled],
    [MINTSOFT_ASN_SEND_SUPPLIER_SETTING, parsed.data.sendSupplierEnabled],
    [MINTSOFT_ASN_SUPPLIER_REQUIRED_SETTING, parsed.data.asnRequired],
  ] as const
  const DESCRIPTION: Record<string, (enabled: boolean) => string> = {
    [MINTSOFT_SUPPLIER_CREATE_SETTING]: (enabled) => `Creating suppliers in Mintsoft is now ${enabled ? 'ON' : 'OFF'}.`,
    [MINTSOFT_ASN_SEND_SUPPLIER_SETTING]: (enabled) => `The mapped supplier ${enabled ? 'is now SENT' : 'is no longer sent'} on an ASN (ProductSupplierId).`,
    [MINTSOFT_ASN_SUPPLIER_REQUIRED_SETTING]: (enabled) => `An ASN without a mapped Mintsoft supplier is now ${enabled ? 'REFUSED' : 'created as before'}.`,
  }
  await db.$transaction(async (tx) => {
    for (const [key, enabled] of entries) {
      const row = await tx.setting.findUnique({ where: { key } })
      const before = row?.value === 'true'
      const value = enabled ? 'true' : 'false'
      await tx.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
      if (before === enabled) continue
      await logActivityInTransaction(tx, {
        entityType: 'SETTING', tag: 'sync', action: `${key}_updated`, userId: session.user.id, level: 'WARNING',
        description: DESCRIPTION[key]!(enabled),
        metadata: { before, after: enabled },
      })
    }
  })
  revalidatePath('/sync/mintsoft-suppliers')
  return { success: true }
}
