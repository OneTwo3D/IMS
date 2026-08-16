'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requireAuth, requirePermission } from '@/lib/auth/server'
import {
  INTEGRATION_PLUGIN_SETTING_KEYS,
  type IntegrationPluginId,
} from '@/lib/integration-plugins'
import { lockIntegrationPluginSelection } from '@/lib/integration-plugin-selection-lock'
import { toIsoCountryCode } from '@/lib/countries'
import { getSettingValue, serializeSettingValue } from '@/lib/settings-store'
import { refreshMutableDocumentTaxSnapshotsForRate } from '@/lib/tax/document-tax-snapshot-refresh'
import { maybeQueueTaxRateSync } from '@/lib/accounting/tax-rate-sync-trigger'
import {
  planMissingTaxRateCreations,
  taxComponentsForCreation,
  type ImsRateForGeneration,
  type MissingTaxRatePreviewResult,
  type MissingTaxRateGenerateResult,
} from '@/lib/tax/generate-missing-tax-rates'
import { xeroReportTaxType, XERO_REPORT_TAX_TYPES, isXeroReportTaxType } from '@/lib/connectors/xero/tax-rate-report-type'
import {
  effectiveTaxRateFromComponents,
  normalizeTaxRateComponents,
  taxRateIsCompoundProfile,
  type TaxRateComponentInput,
} from '@/lib/tax/tax-rate-components'

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
  isCompound: boolean
  reverseCharge: boolean
  reportingCategory: string | null
  isDefault: boolean
  active: boolean
  components: {
    id: string
    name: string
    rate: number
    compoundOnPrevious: boolean
    accountingTaxType: string | null
    sortOrder: number
    active: boolean
  }[]
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
      isCompound: true,
      reverseCharge: true,
      reportingCategory: true,
      isDefault: true,
      active: true,
      components: {
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: {
          id: true,
          name: true,
          rate: true,
          compoundOnPrevious: true,
          accountingTaxType: true,
          sortOrder: true,
          active: true,
        },
      },
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
    isCompound: r.isCompound,
    reverseCharge: r.reverseCharge,
    reportingCategory: r.reportingCategory,
    isDefault: r.isDefault,
    active: r.active,
    components: r.components.map((component) => ({
      id: component.id,
      name: component.name,
      rate: Number(component.rate),
      compoundOnPrevious: component.compoundOnPrevious,
      accountingTaxType: component.accountingTaxType,
      sortOrder: component.sortOrder,
      active: component.active,
    })),
  }))
}

export async function createTaxRate(input: {
  name: string
  rate: number
  usedFor: string
  accountingTaxType?: string
  countryCode?: string | null
  taxCategory?: TaxCategoryValue
  isCompound?: boolean
  reverseCharge?: boolean
  reportingCategory?: string | null
  components?: TaxRateComponentInput[]
}): Promise<{ success: boolean; error?: string }> {
  await requirePermission('settings.company')
  try {
    // o3d-r30: same write-time TaxType validation as updateTaxRate — createTaxRate is also a
    // caller-controlled accountingTaxType write, so it must not bypass the guard.
    if (input.accountingTaxType) {
      const { validateAccountingTaxTypeForWrite } = await import('@/lib/accounting/accounting-tax-type-validation')
      const check = await validateAccountingTaxTypeForWrite(input.accountingTaxType)
      if (!check.ok) return { success: false, error: check.error }
    }
    const components = normalizeTaxRateComponents(input.components)
    const effectiveRate = effectiveTaxRateFromComponents(components) ?? input.rate
    const created = await db.taxRate.create({
      data: {
        name: input.name,
        rate: effectiveRate,
        usedFor: input.usedFor || 'BOTH',
        accountingTaxType: input.accountingTaxType || null,
        countryCode: input.countryCode ? input.countryCode.toLowerCase() : null,
        taxCategory: normaliseTaxCategory(input.taxCategory),
        isCompound: input.isCompound ?? taxRateIsCompoundProfile(components),
        reverseCharge: input.reverseCharge ?? false,
        reportingCategory: input.reportingCategory?.trim() || null,
        components: components.length > 0 ? {
          create: components.map((component) => ({
            name: component.name,
            rate: component.rate,
            compoundOnPrevious: component.compoundOnPrevious,
            accountingTaxType: component.accountingTaxType,
            sortOrder: component.sortOrder,
            active: component.active,
          })),
        } : undefined,
      },
      select: {
        id: true,
        name: true,
        accountingTaxType: true,
        components: {
          select: {
            name: true,
            rate: true,
            compoundOnPrevious: true,
            accountingTaxType: true,
            active: true,
          },
        },
      },
    })
    await logActivity({ entityType: 'SETTING', tag: 'settings', action: 'created', description: `Created tax rate: ${input.name} (${input.rate}%)` })
    await maybeQueueTaxRateSync({
      id: created.id,
      name: created.name,
      accountingTaxType: created.accountingTaxType,
      components: created.components.map((component) => ({
        name: component.name,
        rate: Number(component.rate),
        compoundOnPrevious: component.compoundOnPrevious,
        accountingTaxType: component.accountingTaxType,
        active: component.active,
      })),
    })
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
  isCompound?: boolean
  reverseCharge?: boolean
  reportingCategory?: string | null
  components?: TaxRateComponentInput[]
  active?: boolean
}): Promise<{ success: boolean; error?: string }> {
  await requirePermission('settings.company')
  try {
    // o3d-r30: validate a mapped accounting TaxType against Xero's LIVE rate set before persisting. The
    // mapper UI is populated from a (now cacheable) display list, so a rate archived in Xero after it was
    // shown must not be persisted here and break later invoice/bill sync. Fails CLOSED when Xero is
    // unreachable (can't confirm) rather than trust an unvalidated type.
    if (input.accountingTaxType) {
      const { validateAccountingTaxTypeForWrite } = await import('@/lib/accounting/accounting-tax-type-validation')
      const check = await validateAccountingTaxTypeForWrite(input.accountingTaxType)
      if (!check.ok) return { success: false, error: check.error }
    }
    const summary = await db.$transaction(async (tx) => {
      const components = input.components === undefined ? undefined : normalizeTaxRateComponents(input.components)
      const effectiveRate = components === undefined ? input.rate : (effectiveTaxRateFromComponents(components) ?? input.rate)
      const oldRate = await tx.taxRate.findUnique({
        where: { id },
        select: { id: true, name: true, rate: true },
      })
      if (!oldRate) throw new Error(`Tax rate ${id} not found`)
      const updated = await tx.taxRate.update({
        where: { id },
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(effectiveRate !== undefined && { rate: effectiveRate }),
          ...(input.usedFor !== undefined && { usedFor: input.usedFor }),
          ...(input.accountingTaxType !== undefined && { accountingTaxType: input.accountingTaxType || null }),
          ...(input.countryCode !== undefined && { countryCode: input.countryCode ? input.countryCode.toLowerCase() : null }),
          ...(input.taxCategory !== undefined && { taxCategory: normaliseTaxCategory(input.taxCategory) }),
          ...(input.isCompound !== undefined && { isCompound: input.isCompound }),
          ...(input.reverseCharge !== undefined && { reverseCharge: input.reverseCharge }),
          ...(input.reportingCategory !== undefined && { reportingCategory: input.reportingCategory?.trim() || null }),
          ...(input.active !== undefined && { active: input.active }),
        },
        select: { id: true, name: true, rate: true },
      })
      if (components !== undefined) {
        await tx.taxRateComponent.deleteMany({ where: { taxRateId: id } })
        if (components.length > 0) {
          await tx.taxRateComponent.createMany({
            data: components.map((component) => ({
              taxRateId: id,
              name: component.name,
              rate: component.rate,
              compoundOnPrevious: component.compoundOnPrevious,
              accountingTaxType: component.accountingTaxType,
              sortOrder: component.sortOrder,
              active: component.active,
            })),
          })
        }
        await tx.taxRate.update({
          where: { id },
          data: {
            isCompound: input.isCompound ?? taxRateIsCompoundProfile(components),
          },
        })
      }
      return refreshMutableDocumentTaxSnapshotsForRate(tx, { oldRate, newRate: updated })
    })
    await logActivity({
      entityType: 'SETTING',
      entityId: id,
      tag: 'settings',
      action: 'updated',
      description: `Updated tax rate: ${input.name ?? id}`,
      metadata: summary,
    })
    const refreshed = await db.taxRate.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        accountingTaxType: true,
        components: {
          select: {
            name: true,
            rate: true,
            compoundOnPrevious: true,
            accountingTaxType: true,
            active: true,
          },
        },
      },
    })
    if (refreshed) {
      await maybeQueueTaxRateSync({
        id: refreshed.id,
        name: refreshed.name,
        accountingTaxType: refreshed.accountingTaxType,
        components: refreshed.components.map((component) => ({
          name: component.name,
          rate: Number(component.rate),
          compoundOnPrevious: component.compoundOnPrevious,
          accountingTaxType: component.accountingTaxType,
          active: component.active,
        })),
      })
    }
    revalidatePath('/settings', 'layout')
    revalidatePath('/sales')
    revalidatePath('/purchase-orders')
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

export async function autoLinkQuickBooksTaxRates(): Promise<{
  success: boolean
  linked: number
  alreadyLinked: number
  unmatched: string[]
  quickBooksRatesCount: number
  error?: string
}> {
  await requirePermission('settings.company')
  try {
    const { getQuickBooksTaxCodes } = await import('@/lib/connectors/quickbooks/accounts')
    const qboRates = await getQuickBooksTaxCodes()
    const qboByName = new Map<string, { id: string; name: string }>()
    for (const rate of qboRates) {
      qboByName.set(rate.name.trim().toLowerCase(), rate)
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
      const match = qboByName.get(ims.name.trim().toLowerCase())
      if (!match) { unmatched.push(ims.name); continue }
      await db.taxRate.update({
        where: { id: ims.id },
        data: { accountingTaxType: match.id },
      })
      linked++
    }

    await logActivity({
      entityType: 'SETTING',
      tag: 'settings',
      action: 'quickbooks_tax_rates_linked',
      description: `Auto-linked ${linked} IMS tax rate(s) to QuickBooks tax codes (${alreadyLinked} already linked, ${unmatched.length} unmatched)`,
      metadata: { linked, alreadyLinked, unmatched, quickBooksRatesCount: qboRates.length },
    })
    revalidatePath('/settings/accounting')
    return {
      success: true,
      linked,
      alreadyLinked,
      unmatched,
      quickBooksRatesCount: qboRates.length,
    }
  } catch (e) {
    return { success: false, linked: 0, alreadyLinked: 0, unmatched: [], quickBooksRatesCount: 0, error: String(e) }
  }
}

// ---------------------------------------------------------------------------
// Generate + map missing accounting tax rates (onetwo3d-ims-30tg)
// ---------------------------------------------------------------------------

/** Load every ACTIVE IMS TaxRate (with active components) in the shape the
 *  connector-agnostic planner expects. */
async function loadImsRatesForGeneration(): Promise<ImsRateForGeneration[]> {
  const rows = await db.taxRate.findMany({
    where: { active: true },
    select: {
      id: true,
      name: true,
      rate: true,
      usedFor: true,
      reportingCategory: true,
      accountingTaxType: true,
      active: true,
      components: {
        where: { active: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: { name: true, rate: true, compoundOnPrevious: true },
      },
    },
  })
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    rate: Number(r.rate),
    usedFor: r.usedFor,
    reportingCategory: r.reportingCategory,
    accountingTaxType: r.accountingTaxType,
    active: r.active,
    components: r.components.map((c) => ({
      name: c.name,
      rate: Number(c.rate),
      compoundOnPrevious: c.compoundOnPrevious,
    })),
  }))
}

/**
 * Preview which Xero tax rates WOULD be created for active, unmapped IMS rates
 * with no existing Xero name-match. Read-only: nothing is written to Xero.
 * The UI shows this list in a confirmation dialog before generating.
 */
export async function previewMissingXeroTaxRates(): Promise<MissingTaxRatePreviewResult> {
  await requirePermission('settings.company')
  try {
    const { getXeroTaxRates } = await import('@/lib/connectors/xero/accounts')
    const result = await getXeroTaxRates()
    if (!result) {
      return { success: false, toCreate: [], alreadyMapped: 0, skippedExisting: 0, externalRatesCount: 0, supported: true, error: 'Failed to fetch Xero tax rates (not connected?)' }
    }
    const imsRates = await loadImsRatesForGeneration()
    const plan = planMissingTaxRateCreations(
      imsRates,
      result.taxRates.map((x) => ({ name: x.name, ratePct: x.rate })),
    )
    return {
      success: true,
      toCreate: plan.toCreate.map((rate) => ({
        taxRateId: rate.id,
        name: rate.name,
        ratePct: rate.rate * 100,
        reportingCategory: rate.reportingCategory,
        reportType: xeroReportTaxType({ reportingCategory: rate.reportingCategory, usedFor: rate.usedFor, name: rate.name, rate: rate.rate }),
      })),
      alreadyMapped: plan.alreadyMapped.length,
      skippedExisting: plan.skippedExisting.length,
      externalRatesCount: result.taxRates.length,
      supported: true,
      reportTypeOptions: XERO_REPORT_TAX_TYPES,
    }
  } catch (e) {
    return { success: false, toCreate: [], alreadyMapped: 0, skippedExisting: 0, externalRatesCount: 0, supported: true, error: String(e) }
  }
}

/**
 * Create the confirmed missing tax rates in Xero and map each back onto its IMS
 * rate (TaxRate.accountingTaxType = the returned Xero TaxType). Only creates
 * rates the user confirmed (taxRateIds) AND that are still create-eligible when
 * re-planned at write time, so nothing is duplicated if state changed since the
 * preview.
 */
export async function generateMissingXeroTaxRates(
  taxRateIds: string[],
  reportTypeOverrides?: Record<string, string>,
): Promise<MissingTaxRateGenerateResult> {
  await requirePermission('settings.company')
  try {
    const { getXeroTaxRates } = await import('@/lib/connectors/xero/accounts')
    const { putXeroTaxRate } = await import('@/lib/connectors/xero/tax-rates')
    const result = await getXeroTaxRates()
    if (!result) {
      return { success: false, created: 0, failed: [], externalRatesCount: 0, supported: true, error: 'Failed to fetch Xero tax rates (not connected?)' }
    }
    const confirmed = new Set(taxRateIds)
    const imsRates = await loadImsRatesForGeneration()
    const plan = planMissingTaxRateCreations(
      imsRates,
      result.taxRates.map((x) => ({ name: x.name, ratePct: x.rate })),
    )
    const targets = plan.toCreate.filter((rate) => confirmed.has(rate.id))

    let created = 0
    const failed: Array<{ name: string; error: string }> = []

    for (const rate of targets) {
      try {
        // Honour a user override from the confirmation dialog, but only if it's a
        // report type we know Xero accepts — otherwise fall back to the computed
        // default so we never post an invalid ReportTaxType.
        const override = reportTypeOverrides?.[rate.id]
        const reportTaxType = isXeroReportTaxType(override)
          ? override
          : xeroReportTaxType({ reportingCategory: rate.reportingCategory, usedFor: rate.usedFor, name: rate.name, rate: rate.rate })
        const components = taxComponentsForCreation(rate)
        const res = await putXeroTaxRate({ name: rate.name, reportTaxType, components, status: 'ACTIVE' })
        if (!res.success || !res.taxType) {
          failed.push({ name: rate.name, error: res.error ?? 'Xero did not return a tax type' })
          continue
        }
        await db.taxRate.update({ where: { id: rate.id }, data: { accountingTaxType: res.taxType } })
        created++
      } catch (e) {
        // Keep going so one rate's failure (e.g. the DB mapping write) doesn't
        // discard rates already created + mapped earlier in the loop.
        failed.push({ name: rate.name, error: e instanceof Error ? e.message : String(e) })
      }
    }

    await logActivity({
      entityType: 'SETTING',
      tag: 'settings',
      action: 'xero_tax_rates_generated',
      description: `Generated ${created} tax rate(s) in Xero and mapped them (${failed.length} failed)`,
      metadata: { created, failed, requested: taxRateIds.length },
    })
    revalidatePath('/settings/accounting')
    return { success: true, created, failed, externalRatesCount: result.taxRates.length, supported: true }
  } catch (e) {
    return { success: false, created: 0, failed: [], externalRatesCount: 0, supported: true, error: String(e) }
  }
}

/**
 * QuickBooks does not yet support programmatic tax-code creation. Return an
 * unsupported result so the connector-agnostic caller/UI degrades gracefully
 * (create the codes in QuickBooks, then use Auto-link).
 */
export async function previewMissingQuickBooksTaxRates(): Promise<MissingTaxRatePreviewResult> {
  await requirePermission('settings.company')
  return {
    success: true,
    toCreate: [],
    alreadyMapped: 0,
    skippedExisting: 0,
    externalRatesCount: 0,
    supported: false,
    error: 'Generating tax codes in QuickBooks is not supported yet — create them in QuickBooks, then use Auto-link.',
  }
}

export async function generateMissingQuickBooksTaxRates(_taxRateIds: string[], _reportTypeOverrides?: Record<string, string>): Promise<MissingTaxRateGenerateResult> {
  await requirePermission('settings.company')
  return {
    success: false,
    created: 0,
    failed: [],
    externalRatesCount: 0,
    supported: false,
    error: 'Generating tax codes in QuickBooks is not supported yet.',
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
  // o3d-osl8 round 5, finding 2. The integration plugin flags decide WHICH connector is active,
  // and other writers make destructive decisions from that answer (cancelOrphanedAccountingSyncRows
  // discards a non-active connector's queue). Changing them one generic key at a time is neither
  // atomic — the plugins UI fired five of these in parallel, so "Xero off, QuickBooks on" passed
  // through both-off and both-on states — nor serialized against those readers. Routed through
  // saveIntegrationPluginState instead, which does both. Refused rather than silently allowed so
  // the guarantee cannot be bypassed by a new call site.
  if ((Object.values(INTEGRATION_PLUGIN_SETTING_KEYS) as string[]).includes(key)) {
    throw new Error(`Use saveIntegrationPluginState to change ${key} — it must be written atomically and under the connector-selection lock.`)
  }
  await db.setting.upsert({
    where: { key },
    create: { key, value: serializeSettingValue(key, value) },
    update: { value: serializeSettingValue(key, value) },
  })
  await logActivity({ entityType: 'SETTING', tag: 'settings', action: 'updated', description: `Updated setting: ${key}` })
  revalidatePath('/settings', 'layout')
}

/** Not exported: nothing outside needs the name, and a 'use server' module's export surface is an RPC manifest. */
type IntegrationPluginStateInput = Partial<Record<IntegrationPluginId, boolean>>

/**
 * Write the integration plugin flags ATOMICALLY and under the accounting connector-selection lock
 * (o3d-osl8 round 5, finding 2).
 *
 * Both properties matter, for different readers:
 *   • ATOMIC — the plugins settings page previously issued one setSetting per flag, in parallel.
 *     A switch from Xero to QuickBooks therefore passed through observable both-off and both-on
 *     states. getActiveConnector resolves xero-first and returns null when both are off, so a
 *     reader landing in that window sees a DIFFERENT active connector than either the before or
 *     the after — including "none", which is the state the orphan cancel treats as "specify a
 *     connector" and the banner reports as "no accounting connector is enabled".
 *   • LOCKED — cancelOrphanedAccountingSyncRows takes the same lock around its
 *     read-decide-update, so a switch cannot land inside that window at all. Its generation check
 *     is the backstop if a writer ever skips this path; this is what keeps the backstop from
 *     firing during ordinary use.
 *   • VALIDATED UNDER THE LOCK (round 6, finding 1) — the exclusivity rule is evaluated against
 *     state read THROUGH the transaction, after the lock and the `FOR UPDATE` row locks. Reading
 *     it beforehand made the check advisory only: two concurrent partial requests each saw both
 *     connectors off, enabled one apiece, and committed a both-enabled state.
 *
 * Only the keys PRESENT in `state` are written, so a caller cannot silently disable a plugin it
 * did not mean to mention.
 */
export async function saveIntegrationPluginState(
  state: IntegrationPluginStateInput,
): Promise<{ success: boolean; error?: string }> {
  await requirePermission('settings.company')

  const entries = (Object.entries(state) as Array<[IntegrationPluginId, boolean | undefined]>)
    .filter((entry): entry is [IntegrationPluginId, boolean] => typeof entry[1] === 'boolean')
  if (entries.length === 0) return { success: true }

  // READ, VALIDATE AND WRITE IN ONE LOCKED TRANSACTION (o3d-osl8 round 6, finding 1).
  //
  // The exclusivity rule is checked against the RESULTING state, not just the payload, so a
  // PARTIAL write cannot turn both connectors on across two calls. That check is only worth
  // anything if the state it reads cannot move before the write lands — and it could: this used to
  // read through the pooled client BEFORE opening the locked transaction. Two concurrent partial
  // requests then both observed both connectors disabled, one enabled Xero and the other
  // QuickBooks, their writes serialized, and the result was BOTH ENABLED — an invalid state that
  // no later validation ever revisits and that getActiveConnector silently resolves Xero-first, so
  // nothing ever complains. WooCommerce/Shopify had the identical race.
  //
  // The read now goes through the transaction client, after the lock and under a `FOR UPDATE` row
  // lock on the plugin rows (lockIntegrationPluginSelection), so the state validated IS the state
  // written against — for writers that take the lock and for writers that do not.
  const conflict = await db.$transaction(async (tx) => {
    const resulting = { ...(await lockIntegrationPluginSelection(tx)) }
    for (const [id, enabled] of entries) resulting[id] = enabled
    if (resulting.xero && resulting.quickbooks) {
      return 'Enable either Xero or QuickBooks, not both — accounting dispatch is single-connector.'
    }
    if (resulting.woocommerce && resulting.shopify) {
      return 'Enable either WooCommerce or Shopify, not both.'
    }

    for (const [id, enabled] of entries) {
      const key = INTEGRATION_PLUGIN_SETTING_KEYS[id]
      await tx.setting.upsert({
        where: { key },
        create: { key, value: serializeSettingValue(key, String(enabled)) },
        update: { value: serializeSettingValue(key, String(enabled)) },
      })
    }
    return null
  })

  // Returned rather than thrown: a refusal is an ordinary outcome the form displays, and throwing
  // would reach the client as an opaque digest. The transaction has already committed nothing.
  if (conflict) return { success: false, error: conflict }

  await logActivity({
    entityType: 'SETTING',
    tag: 'settings',
    action: 'updated',
    description: `Updated integration plugins: ${entries.map(([id, enabled]) => `${id}=${enabled}`).join(', ')}`,
    metadata: Object.fromEntries(entries),
  })
  revalidatePath('/settings', 'layout')
  return { success: true }
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
  syncToStore: boolean
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
  syncToStore: true,
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
  country: z.string().max(100).default('GB'),
  availableForSale: z.boolean().default(true),
  syncToStore: z.boolean().default(false),
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
  const normalizedCountry = toIsoCountryCode(data.country)
  if (!normalizedCountry) {
    return { success: false, error: 'Select a valid country.' }
  }
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
        country: normalizedCountry,
        availableForSale: data.availableForSale,
        syncToStore: data.syncToStore,
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
  const normalizedCountry = toIsoCountryCode(data.country)
  if (!normalizedCountry) {
    return { success: false, error: 'Select a valid country.' }
  }
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
        country: normalizedCountry,
        availableForSale: data.availableForSale,
        syncToStore: data.syncToStore,
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
