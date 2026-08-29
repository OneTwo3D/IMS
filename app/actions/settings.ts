'use server'

import { revalidatePath } from 'next/cache'
import { unstable_rethrow } from 'next/navigation'
import { z } from 'zod'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requireInternalUser, requirePermission } from '@/lib/auth/server'
import {
  INTEGRATION_PLUGIN_SETTING_KEYS,
  type IntegrationPluginId,
  type IntegrationPluginState,
} from '@/lib/integration-plugins'
import { lockIntegrationPluginSelection } from '@/lib/integration-plugin-selection-lock'
import { completePluginSelectionSave, type PluginSelectionSaveResult } from '@/lib/domain/integrations/plugin-save-outcome'
import { runPostCommit } from '@/lib/domain/post-commit'
import { uniqueViolationTargetsField } from '@/lib/db/prisma-unique-violation'
import type { SettingSaveResult } from '@/lib/domain/settings/setting-save-outcome'
import { assertWritableSettingKeys } from '@/lib/domain/settings/writable-setting-keys'
import { reconcileCrontab } from '@/lib/crontab-reconcile'
import { normalizePublicAppUrl } from '@/lib/domain/settings/public-app-url-input'
import { validateBackupScheduleInput, type BackupScheduleInput } from '@/lib/domain/settings/backup-schedule-input'
import { toIsoCountryCode } from '@/lib/countries'
import { getSettingValue, serializeSettingValue, SENSITIVE_SETTING_KEYS } from '@/lib/settings-store'
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
  await requireInternalUser()
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
  /**
   * COMMITTED, but a step after the commit did not complete (o3d-osl8 round 10, finding 3). Additive
   * so no screen has to change to stop reporting a stored value as unsaved; a screen with somewhere
   * to put it can render it.
   */
  warning?: string
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
    // EVERYTHING BELOW IS POST-COMMIT (o3d-osl8 round 10, finding 3). The row is durable; the audit
    // entry and the cache revalidation are not part of that write, and either of them throwing used
    // to land in the catch below and report "Failed to create reason." over a reason that exists.
    const postCommit = await runPostCommit(async () => {
      await logActivity({ entityType: 'SETTING', entityId: item.id, tag: 'settings', action: 'created', description: `Created adjustment reason: ${name}` })
      revalidatePath('/settings', 'layout')
    }, 'Failed to record the new adjustment reason')
    if (postCommit.status === 'failed') return { success: true, item, warning: postCommit.error }
    return { success: true, item }
  } catch (e) {
    unstable_rethrow(e)
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
    const postCommit = await runPostCommit(async () => {
      await logActivity({ entityType: 'SETTING', entityId: item.id, tag: 'settings', action: 'updated', description: `Updated adjustment reason: ${name}` })
      revalidatePath('/settings', 'layout')
    }, 'Failed to record the adjustment reason change')
    if (postCommit.status === 'failed') return { success: true, item, warning: postCommit.error }
    return { success: true, item }
  } catch (e) {
    unstable_rethrow(e)
    await logActivity({ entityType: 'SETTING', entityId: id, tag: 'settings', action: 'updated', level: 'ERROR', description: `Failed to update adjustment reason: ${name}` })
    return { message: 'Failed to update reason.' }
  }
}

export async function deleteAdjustmentReason(id: string): Promise<{ error?: string; warning?: string }> {
  await requirePermission('settings.company')
  try {
    await db.adjustmentReason.delete({ where: { id } })
    const postCommit = await runPostCommit(async () => {
      await logActivity({ entityType: 'SETTING', entityId: id, tag: 'settings', action: 'deleted', description: 'Deleted adjustment reason' })
      revalidatePath('/settings', 'layout')
    }, 'Failed to record the adjustment reason deletion')
    // The row is GONE. Reporting an error here would invite a retry of a delete that succeeded.
    if (postCommit.status === 'failed') return { warning: postCommit.error }
    return {}
  } catch (e) {
    unstable_rethrow(e)
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
  await requireInternalUser()
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
}): Promise<{ success: boolean; error?: string; warning?: string }> {
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
    // EVERYTHING BELOW IS POST-COMMIT (o3d-osl8 round 10, finding 3 — the SECOND site of this shape,
    // and the one the round-9 structural test could not see, because it recognised a commit by two
    // hand-listed call spellings and this one commits through a bare Prisma create).
    // `maybeQueueTaxRateSync` reaches the accounting connector, so it is the most likely of the
    // three to fail — and its failure used to report `success: false` over a rate that EXISTS,
    // inviting the operator to create it a second time.
    const postCommit = await runPostCommit(async () => {
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
    }, 'Failed to complete follow-up work after the tax rate was created')
    if (postCommit.status === 'failed') return { success: true, warning: postCommit.error }
    return { success: true }
  } catch (e) {
    // FIRST: the guard above deliberately RETHROWS Next's control-flow exceptions, and this catch
    // would otherwise swallow the redirect it took care to preserve.
    unstable_rethrow(e)
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
}): Promise<{ success: boolean; error?: string; warning?: string }> {
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

    // EVERYTHING BELOW IS POST-COMMIT (o3d-osl8 round 9, finding 1 — found by the structural rule in
    // tests/settings/post-commit-contract.test.ts, not by another hand sweep). The tax rate, its
    // components and the document snapshot refresh are durable at this point. The activity row, the
    // read-back, the accounting-sync enqueue and the cache revalidation are not part of that write,
    // and any of them throwing used to land in the outer catch below and report `success: false` —
    // over a rate that HAS been updated. The Xero mapper then shows a red error and invites a retry
    // of a mapping that already landed.
    const postCommit = await runPostCommit(async () => {
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
    }, 'Failed to complete follow-up work after the tax rate was updated')

    // `success: true` because it IS. The warning is additive so no caller has to change to stop
    // reporting a stored rate as unsaved; a caller that wants to surface it can.
    if (postCommit.status === 'failed') return { success: true, warning: postCommit.error }
    return { success: true }
  } catch (e) {
    // FIRST (o3d-osl8 round 9, finding 4). This catch now sits outside a guard that deliberately
    // RETHROWS Next's control-flow exceptions, so without this line it would swallow the redirect
    // the guard just took care to preserve — and report a committed update as a failed one on the
    // way past. `unstable_rethrow` returns silently for ordinary errors.
    unstable_rethrow(e)
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
  warning?: string
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

    // ONE TRANSACTION FOR THE WHOLE LINK (o3d-osl8 round 11, finding 3). Row-at-a-time these each
    // committed on their own, so a failure on mapping seventeen left sixteen mappings durable and
    // the catch below reported `linked: 0` — a claim that nothing landed, over rows that had. The
    // set is small (active tax rates) and the caller's recovery is to run the link again, so
    // all-or-nothing is both cheap and the only outcome the return value can honestly describe.
    const plan = imsRates.flatMap((ims) => {
      if (ims.accountingTaxType) { alreadyLinked++; return [] }
      const match = xeroByName.get(ims.name.trim().toLowerCase())
      if (!match) { unmatched.push(ims.name); return [] }
      return [{ id: ims.id, taxType: match.taxType }]
    })
    await db.$transaction(async (tx) => {
      for (const entry of plan) {
        await tx.taxRate.update({ where: { id: entry.id }, data: { accountingTaxType: entry.taxType } })
      }
    })
    linked = plan.length

    // POST-COMMIT. The mappings are already written, one row at a time — reporting `success: false`
    // here would claim NONE of them landed, and the screen's recovery is to run the link again.
    const postCommit = await runPostCommit(async () => {
      await logActivity({
        entityType: 'SETTING',
        tag: 'settings',
        action: 'xero_tax_rates_linked',
        description: `Auto-linked ${linked} IMS tax rate(s) to Xero tax types (${alreadyLinked} already linked, ${unmatched.length} unmatched)`,
        metadata: { linked, alreadyLinked, unmatched, xeroRatesCount: result.taxRates.length },
      })
      revalidatePath('/settings/accounting')
    }, 'Failed to record the auto-link')
    return {
      success: true,
      linked,
      alreadyLinked,
      unmatched,
      xeroRatesCount: result.taxRates.length,
      ...(postCommit.status === 'failed' ? { warning: postCommit.error } : {}),
    }
  } catch (e) {
    unstable_rethrow(e)
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
  warning?: string
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

    // ONE TRANSACTION, for the same reason as the Xero path above.
    const plan = imsRates.flatMap((ims) => {
      if (ims.accountingTaxType) { alreadyLinked++; return [] }
      const match = qboByName.get(ims.name.trim().toLowerCase())
      if (!match) { unmatched.push(ims.name); return [] }
      return [{ id: ims.id, taxType: match.id }]
    })
    await db.$transaction(async (tx) => {
      for (const entry of plan) {
        await tx.taxRate.update({ where: { id: entry.id }, data: { accountingTaxType: entry.taxType } })
      }
    })
    linked = plan.length

    const postCommit = await runPostCommit(async () => {
      await logActivity({
        entityType: 'SETTING',
        tag: 'settings',
        action: 'quickbooks_tax_rates_linked',
        description: `Auto-linked ${linked} IMS tax rate(s) to QuickBooks tax codes (${alreadyLinked} already linked, ${unmatched.length} unmatched)`,
        metadata: { linked, alreadyLinked, unmatched, quickBooksRatesCount: qboRates.length },
      })
      revalidatePath('/settings/accounting')
    }, 'Failed to record the auto-link')
    return {
      success: true,
      linked,
      alreadyLinked,
      unmatched,
      quickBooksRatesCount: qboRates.length,
      ...(postCommit.status === 'failed' ? { warning: postCommit.error } : {}),
    }
  } catch (e) {
    unstable_rethrow(e)
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

    // POST-COMMIT, and the stakes are higher here than anywhere else in this file: the rates have
    // been created IN XERO and mapped locally. `success: false` would say none of that happened.
    const postCommit = await runPostCommit(async () => {
      await logActivity({
        entityType: 'SETTING',
        tag: 'settings',
        action: 'xero_tax_rates_generated',
        description: `Generated ${created} tax rate(s) in Xero and mapped them (${failed.length} failed)`,
        metadata: { created, failed, requested: taxRateIds.length },
      })
      revalidatePath('/settings/accounting')
    }, 'Failed to record the generated tax rates')
    return {
      success: true,
      created,
      failed,
      externalRatesCount: result.taxRates.length,
      supported: true,
      ...(postCommit.status === 'failed' ? { warning: postCommit.error } : {}),
    }
  } catch (e) {
    unstable_rethrow(e)
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
  // o3d-512h round 2 — the THIRD instance of the getEmailSettings class, and the
  // one the reviewer predicted. listAccountCodes resolves the active connector and
  // reads the stored chart of accounts (lib/connectors/xero/accounts.ts:
  // listStoredAccounts → db.accountingAccount), which is EXACTLY the data this
  // branch already guarded with requirePermission('sync') on
  // xero-sync.ts:getAccountingAccounts. Guarding one endpoint onto a table while a
  // sibling serves the same rows under requireAuth is not a boundary, it is a
  // detour — and it survived the first sweep because the read happens two modules
  // away, so nothing in this file looks like an accounting read.
  //
  // 'sync' matches the gate already established for this table, so ADMIN and
  // MANAGER keep the reach they had through the sibling; the sole caller
  // (/settings/inventory) gates on 'settings.company' and is ADMIN-only anyway.
  await requirePermission('sync')
  const { listAccountCodes } = await import('@/lib/accounting')
  return listAccountCodes()
}

// ---------------------------------------------------------------------------
// Global Settings (key-value)
// ---------------------------------------------------------------------------

export async function getSetting(key: string): Promise<string | null> {
  await requireInternalUser()
  // o3d-512h: getSetting takes an arbitrary key and getSettingValue DECRYPTS the
  // sensitive ones (lib/settings-store.ts:deserializeSettingValue), so with only
  // requireAuth this 'use server' export handed any authenticated principal —
  // WAREHOUSE, READONLY, even SUPPLIER — the SMTP password, the WooCommerce
  // consumer secret, the Xero client secret and every other stored credential,
  // just by naming the key.
  //
  // Gating the settings PAGES does not close this: a Server Action is its own
  // addressable endpoint and is reached without going through any page. The
  // legitimate callers of the sensitive keys are the backup and sales settings
  // pages, which are ADMIN-only, so 'settings' costs them nothing.
  if (SENSITIVE_SETTING_KEYS.has(key)) await requirePermission('settings')
  return getSettingValue(key)
}

export type UserOption = { id: string; name: string; email: string }

export async function getUsers(): Promise<UserOption[]> {
  // o3d-512h round 3 — this was the entry in the authentication-only inventory that
  // was already unsafe when the inventory was written. It returns the ACTIVE STAFF
  // DIRECTORY (id, display name, work email) for the sales-page assignee filter, and
  // under requireAuth it returned it to SUPPLIER — an external company — as a
  // ready-made phishing list against the buyer's own colleagues. The sibling that
  // serves the same table, users.ts:getUsers, gates on 'settings.users'.
  //
  // Internal-principal, not 'settings.users': the legitimate caller is the sales page,
  // which every internal role reaches. Pinning the reached model (below, in the
  // inventory) is what stops the next edit from widening WHAT it returns.
  await requireInternalUser()
  const rows = await db.user.findMany({
    where: { active: true },
    select: { id: true, name: true, email: true },
    orderBy: { name: 'asc' },
  })
  return rows.map((u) => ({ id: u.id, name: u.name ?? u.email, email: u.email }))
}

/**
 * Write ONE generic setting. Sugar over `setSettings`, which is where the contract lives.
 *
 * NOTE THE RETURN TYPE. It used to be `Promise<void>`, and that was the defect: the action
 * committed its upsert and then awaited `logActivity` and `revalidatePath`, so a failure in either
 * REJECTED a call whose write was already durable. Every one of the fourteen screens behind this
 * action has an outer `catch` that renders a rejection as a failed save. See `setSettings`.
 */
export async function setSetting(key: string, value: string): Promise<SettingSaveResult> {
  // The allowlist is asserted HERE TOO, not left to the delegation (Codex r19 HIGH, r20 HIGH).
  // `setSettings` runs the same check and this call would reach it — today. Both are exported
  // server actions, i.e. two separately addressable endpoints, and an endpoint whose authorization
  // depends on where it happens to forward to is one refactor away from having none. The cost is
  // one duplicated line; `tests/settings/writable-setting-keys.test.ts` proves each route refuses
  // on its own, for every family.
  assertWritableSettingKeys([key])
  return setSettings({ [key]: value })
}

/**
 * WRITE A GROUP OF SETTINGS ATOMICALLY, AND NEVER REJECT AFTER THE COMMIT
 * (o3d-osl8 round 9, finding 1).
 *
 * Two defects, both of them the same shape rounds 7 and 8 fixed at whichever sites were being
 * looked at that round, surviving here because a per-screen sweep cannot be complete:
 *
 *   1. A COMMITTED WRITE REPORTED AS A FAILED SAVE. `setSetting` committed, then awaited
 *      `logActivity` and `revalidatePath`. Either can reject — the activity-log write is a database
 *      round-trip — and the rejection escaped as a rejected server action. The Public App URL panel
 *      prints "Failed to save app URL", the Company onboarding step prints "Failed to save" AND
 *      refuses to advance, the scheduled-jobs editor prints "An error occurred": three claims that
 *      the value is not stored, over a value that is. The post-commit steps are now inside
 *      `runPostCommit`, which classifies instead of rejecting (and rethrows Next's control-flow
 *      throws first — round 9, finding 4).
 *
 *   2. AN ARBITRARY COMMITTED SUBSET. Seven screens saved several keys as `Promise.all(...)` of
 *      independent `setSetting` calls. `Promise.all` rejects on the first failure while the others
 *      keep running, so a failed save left some rows written and some not, with the screen showing
 *      one red error and no way to tell which. All the keys of one save now go in ONE transaction.
 *
 * WHAT THIS CONTRACT COVERS AND WHAT IT CANNOT. It covers every post-commit step of THIS writer, for
 * every caller, including callers that ignore the result — that is why the fix is here and not at
 * the call sites. It does NOT cover:
 *   • work a CALLER does after awaiting this action. A screen that commits here and then awaits
 *     something else has its own post-commit tail, and it must classify it (the two that do —
 *     `savePublicAppUrl` and `saveCronJobSettings` — are server actions for exactly that reason).
 *   • other settings writers. `lib/maintenance-mode.ts` and `lib/currencies/fx-refresh.ts` have
 *     private `setSetting` helpers of their own; they are not user-facing saves and report nothing
 *     to a screen, but they are not covered by this and are listed here rather than left implied.
 *   • the screens that DISCARD the returned `post-commit-failed`. Their save is honest — the value
 *     is stored and they say so — but the missing audit row or stale cache is not surfaced. Only
 *     the three screens that own a warning slot render it.
 */
export async function setSettings(values: Record<string, string>): Promise<SettingSaveResult> {
  await requirePermission('settings.company')

  const entries = Object.entries(values)
  if (entries.length === 0) return { status: 'saved' }

  // ONLY ALLOWLISTED PREFERENCE KEYS ARE WRITTEN, AND THE CHECK IS BEFORE THE COMMIT
  // (Codex r19 HIGH; the shape corrected r20 HIGH).
  //
  // This was, until r19, a hand-written loop over the integration plugin flags alone. r19 replaced
  // it with a DENYLIST of the system-managed families — and that was still the wrong shape, because
  // a denylist over a growing key space is only as complete as the last search for keys. It was
  // already incomplete when it was written: `MACHINE_MANAGED_SYNC_KEYS` in `app/actions/wc-sync.ts`
  // was not in it, so `wc_initial_import_completed` — the completion flag THIS BRANCH had just made
  // refusal-blocking — and the WooCommerce sync cursors were writable by any principal holding
  // `settings.company`, as were the `wc_url`/`wc_consumer_*` credential rows that `saveWcCredentials`
  // guards with validation, a fresh-auth gate, a lock and a version bump.
  //
  // So the rule is inverted. `lib/domain/settings/writable-setting-keys.ts` enumerates the ordinary
  // operator preferences the settings screens offer, and EVERYTHING ELSE IS REFUSED — including a
  // key nobody has thought about yet, which is the case the denylist could never cover. THROWN, not
  // returned: no screen offers an unlisted key, so reaching here is a call-site bug or a
  // hand-invoked action, not an outcome an operator can act on — and it happens before the
  // transaction, so nothing is committed.
  assertWritableSettingKeys(entries.map(([key]) => key))

  await db.$transaction(async (tx) => {
    for (const [key, value] of entries) {
      await tx.setting.upsert({
        where: { key },
        create: { key, value: serializeSettingValue(key, value) },
        update: { value: serializeSettingValue(key, value) },
      })
    }
  })

  // EVERYTHING BELOW IS POST-COMMIT.
  const outcome = await runPostCommit(async () => {
    await logActivity({
      entityType: 'SETTING',
      tag: 'settings',
      action: 'updated',
      description: `Updated setting${entries.length > 1 ? 's' : ''}: ${entries.map(([key]) => key).join(', ')}`,
    })
    revalidatePath('/settings', 'layout')
  }, 'Failed to record the settings change')

  if (outcome.status === 'failed') return { status: 'post-commit-failed', step: 'local', error: outcome.error }
  return { status: 'saved' }
}

/**
 * SAVE THE PUBLIC APP URL AND RECONCILE THE CRONTAB, SERVER-SIDE (o3d-osl8 round 9, finding 1).
 *
 * Previously the Settings panel and the onboarding Company step each did this by hand: `setSetting`
 * (which could reject after committing), then a second round-trip to `syncCrontab` (which re-runs a
 * permission gate that answers by throwing `NEXT_REDIRECT`), then a client-side classification of
 * the two. Three chances for the same defect, in two places, with the rule copied.
 *
 * One action: validate, commit, then run every post-commit step inside the guard. The screens only
 * render the returned outcome.
 */
export async function savePublicAppUrl(value: string): Promise<SettingSaveResult> {
  await requirePermission('settings.company')

  // BEFORE the write, so a refusal genuinely means nothing was stored. The client validates with
  // the same function for immediate feedback; this is the gate.
  const normalized = normalizePublicAppUrl(value)
  if (!normalized.ok) return { status: 'refused', error: normalized.error }

  const key = 'public_app_url'
  await db.setting.upsert({
    where: { key },
    create: { key, value: serializeSettingValue(key, normalized.url) },
    update: { value: serializeSettingValue(key, normalized.url) },
  })

  const local = await runPostCommit(async () => {
    await logActivity({ entityType: 'SETTING', tag: 'settings', action: 'updated', description: `Updated setting: ${key}` })
    revalidatePath('/settings', 'layout')
  }, 'Failed to record the settings change')
  if (local.status === 'failed') return { status: 'post-commit-failed', step: 'local', error: local.error }

  // The crontab embeds the public app URL in every managed job line, so it is genuinely stale until
  // this runs — and it is the step with a named operator recovery, which is why it reports
  // separately from the local steps above.
  const scheduler = await runPostCommit(reconcileCrontab, 'Failed to apply Public App URL changes.')
  if (scheduler.status === 'failed') return { status: 'post-commit-failed', step: 'scheduler', error: scheduler.error }
  return { status: 'saved' }
}

/**
 * SAVE THE BACKUP SCHEDULE, INCLUDING THE ROW THE SCHEDULER ACTUALLY READS (Codex r20 HIGH).
 *
 * This panel used to save through the generic `setSettings`, and that made its enable switch a
 * control that could do nothing. Two things read "are scheduled backups on?", and they are not the
 * same row:
 *
 *   • THE CRONTAB decides whether the job is invoked at all. `buildOtiCrontabBlock` reads
 *     `cron_backup_enabled` and falls back to the registry's `legacyEnabledKey`
 *     (`backup_schedule_enabled`) ONLY while the canonical row is absent. So the moment anyone
 *     touches the Scheduled Jobs editor, this screen's switch stops reaching the crontab entirely.
 *   • THE ROUTE decides whether an invocation does anything. `/api/cron/backup` skips unless
 *     `backup_schedule_enabled` is 'true'.
 *
 * And a generic settings save never reconciles the crontab, so even on an instance where the legacy
 * fallback was still live, switching backups on stored 'true' and installed no cron line — the
 * screen said Saved and no backup was ever taken.
 *
 * So this action writes BOTH rows, in one transaction, and reconciles the crontab as a post-commit
 * step it classifies rather than rejects — the shape `savePublicAppUrl` already uses for the same
 * reason. Writing both is deliberate and not belt-and-braces: they gate different things, and the
 * defect is precisely that they could disagree. The `legacyEnabledKey` fallback survives for
 * instances that have never written the canonical row; `saveCronJobSettings` mirrors in the other
 * direction so the editor cannot leave this row stale either.
 *
 * NOTE THE VALIDATION. The generic writer stored whatever the inputs contained; a blank or negative
 * retention silently became `parseInt('') || 30` at purge time. These are refused BEFORE the write,
 * so a refusal means the stored schedule still stands.
 */
export async function saveBackupScheduleSettings(input: BackupScheduleInput): Promise<SettingSaveResult> {
  await requirePermission('settings.company')

  // The SAME function the screen validates with, so a value that slips past the client is refused
  // here rather than stored.
  const validated = validateBackupScheduleInput(input)
  if (!validated.ok) return { status: 'refused', error: validated.error }
  const { retentionDays, maxCount, autoUpload } = validated

  const enabled = input.enabled ? 'true' : 'false'
  const entries: Array<[string, string]> = [
    // The row the CRONTAB reads. Canonical: once it exists the legacy fallback is never consulted.
    ['cron_backup_enabled', enabled],
    // The row the ROUTE reads. Kept equal to the canonical one, because a disagreement is either a
    // cron line that runs a no-op or a backup nothing invokes.
    ['backup_schedule_enabled', enabled],
    ['backup_retention_days', String(retentionDays)],
    ['backup_max_count', String(maxCount)],
    ['backup_auto_upload', autoUpload],
  ]

  await db.$transaction(async (tx) => {
    for (const [key, value] of entries) {
      await tx.setting.upsert({
        where: { key },
        create: { key, value: serializeSettingValue(key, value) },
        update: { value: serializeSettingValue(key, value) },
      })
    }
  })

  // EVERYTHING BELOW IS POST-COMMIT — see setSettings.
  const local = await runPostCommit(async () => {
    await logActivity({
      entityType: 'SETTING',
      tag: 'settings',
      action: 'updated',
      description: `Updated settings: ${entries.map(([key]) => key).join(', ')}`,
    })
    revalidatePath('/settings', 'layout')
  }, 'Failed to record the settings change')
  if (local.status === 'failed') return { status: 'post-commit-failed', step: 'local', error: local.error }

  // The crontab is genuinely stale until this runs: the enable switch IS a crontab line.
  const scheduler = await runPostCommit(reconcileCrontab, 'Failed to apply the backup schedule change.')
  if (scheduler.status === 'failed') return { status: 'post-commit-failed', step: 'scheduler', error: scheduler.error }
  return { status: 'saved' }
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
 *
 * THE SAME THREE OUTCOMES AS THE WIZARD'S WRITER, from the same union and the same guard (round 8,
 * finding 2). Round 7 split "refused" from "committed but the scheduler is behind" in
 * saveOnboardingPluginState and cross-ported only the WARNING to this screen, leaving the
 * classification itself duplicated in a component's try/catch — where a thrown `syncCrontab` was
 * still rendered as a failed save over a committed write. The scheduler reconciliation moved in
 * here for that reason: it is a post-commit step of this write, so it belongs inside the same
 * post-commit guard rather than being a second server round-trip the caller has to classify.
 */
export async function saveIntegrationPluginState(
  state: IntegrationPluginStateInput,
): Promise<PluginSelectionSaveResult> {
  await requirePermission('settings.company')

  const entries = (Object.entries(state) as Array<[IntegrationPluginId, boolean | undefined]>)
    .filter((entry): entry is [IntegrationPluginId, boolean] => typeof entry[1] === 'boolean')
  if (entries.length === 0) return { status: 'saved' }

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
  const outcome = await db.$transaction(async (tx): Promise<{ conflict: string } | { committed: IntegrationPluginState }> => {
    const resulting = { ...(await lockIntegrationPluginSelection(tx)) }
    for (const [id, enabled] of entries) resulting[id] = enabled
    if (resulting.xero && resulting.quickbooks) {
      return { conflict: 'Enable either Xero or QuickBooks, not both — accounting dispatch is single-connector.' }
    }
    if (resulting.woocommerce && resulting.shopify) {
      return { conflict: 'Enable either WooCommerce or Shopify, not both.' }
    }

    for (const [id, enabled] of entries) {
      const key = INTEGRATION_PLUGIN_SETTING_KEYS[id]
      await tx.setting.upsert({
        where: { key },
        create: { key, value: serializeSettingValue(key, String(enabled)) },
        update: { value: serializeSettingValue(key, String(enabled)) },
      })
    }
    return { committed: resulting }
  })

  // Returned rather than thrown: a refusal is an ordinary outcome the form displays, and throwing
  // would reach the client as an opaque digest. The transaction has already committed nothing.
  if ('conflict' in outcome) return { status: 'refused', error: outcome.conflict }

  // Post-commit, so no failure below may be reported as a rejected save — returned or thrown.
  return completePluginSelectionSave({
    committed: outcome.committed,
    postCommit: async () => {
      await logActivity({
        entityType: 'SETTING',
        tag: 'settings',
        action: 'updated',
        description: `Updated integration plugins: ${entries.map(([id, enabled]) => `${id}=${enabled}`).join(', ')}`,
        metadata: Object.fromEntries(entries),
      })
      revalidatePath('/settings', 'layout')
      // The RECONCILIATION, not the gated server action (round 9, finding 4): `syncCrontab` re-runs
      // `requirePermission`, which answers an invalidated or 2FA-unverified session by throwing
      // NEXT_REDIRECT — and round 8's post-commit guard swallowed that into a scheduler warning
      // instead of letting Next redirect. This caller has already run the identical gate above.
      return reconcileCrontab()
    },
  })
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
  await requireInternalUser()
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
}): Promise<{ success: boolean; error?: string; warning?: string }> {
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
    const postCommit = await runPostCommit(async () => {
      await logActivity({ entityType: 'SETTING', tag: 'settings', action: 'created', description: `Created purchase unit: ${input.name}` })
      revalidatePath('/settings', 'layout')
    }, 'Failed to record the new purchase unit')
    if (postCommit.status === 'failed') return { success: true, warning: postCommit.error }
    return { success: true }
  } catch (e) {
    unstable_rethrow(e)
    await logActivity({ entityType: 'SETTING', tag: 'settings', action: 'created', level: 'ERROR', description: `Failed to create purchase unit: ${input.name}` })
    return { success: false, error: String(e) }
  }
}

/** Returns unique stock unit names from all purchase units, plus "pcs" */
export async function getStockUnitOptions(): Promise<string[]> {
  await requireInternalUser()
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
}): Promise<{ success: boolean; error?: string; warning?: string }> {
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
    const postCommit = await runPostCommit(async () => {
      await logActivity({ entityType: 'SETTING', entityId: id, tag: 'settings', action: 'updated', description: `Updated purchase unit: ${input.name ?? id}` })
      revalidatePath('/settings', 'layout')
    }, 'Failed to record the purchase unit change')
    if (postCommit.status === 'failed') return { success: true, warning: postCommit.error }
    return { success: true }
  } catch (e) {
    unstable_rethrow(e)
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
  await requireInternalUser()
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
): Promise<{ success: boolean; item?: WarehouseRow; error?: string; warning?: string }> {
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
    /**
     * ONE TRANSACTION, NOT THREE COMMITS (o3d-osl8 round 11, finding 3).
     *
     * This action used to clear the existing default flag, clear the existing default-return flag,
     * and create the warehouse as three independent Prisma calls — three separate transactions.
     * A failure on the third (a concurrent duplicate `code`, any constraint) returned
     * `success: false` over two writes that were already durable, and left the tenant with NO
     * default warehouse and no default return warehouse. Round 10's post-commit guard could not see
     * that: it only starts after the final commit, so it changed WHERE the failure was reported
     * without changing what had already been written.
     *
     * The pre-read below cannot decide uniqueness on its own — two concurrent creates both see
     * "free" — so it exists for the MESSAGE, and the unique index on `code` is what enforces it.
     * Losing that race now aborts the transaction, so the default flags roll back with it, and the
     * catch turns the P2002 back into the same sentence the pre-read would have produced.
     */
    const existing = await db.warehouse.findUnique({ where: { code: data.code } })
    if (existing) return { success: false, error: `Warehouse code "${data.code}" already exists.` }

    const item = await db.$transaction(async (tx) => {
      // If setting as default, unset others
      if (data.isDefault) {
        await tx.warehouse.updateMany({ where: { isDefault: true }, data: { isDefault: false } })
      }
      if (data.defaultReturnWarehouse) {
        await tx.warehouse.updateMany({ where: { defaultReturnWarehouse: true }, data: { defaultReturnWarehouse: false } })
      }

      return tx.warehouse.create({
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
    })
    const postCommit = await runPostCommit(async () => {
      await logActivity({ entityType: 'SETTING', entityId: item.id, tag: 'settings', action: 'created', description: `Created warehouse: ${data.code} — ${data.name}` })
      revalidatePath('/settings', 'layout')
    }, 'Failed to record the new warehouse')
    if (postCommit.status === 'failed') return { success: true, item, warning: postCommit.error }
    return { success: true, item }
  } catch (e) {
    unstable_rethrow(e)
    await logActivity({ entityType: 'SETTING', tag: 'settings', action: 'created', level: 'ERROR', description: `Failed to create warehouse: ${data.code}` })
    // The unique index, not the pre-read, is what decides this under concurrency — and reporting it
    // as a raw Prisma error would tell the operator nothing they can act on.
    if (uniqueViolationTargetsField(e, 'code')) return { success: false, error: `Warehouse code "${data.code}" already exists.` }
    return { success: false, error: String(e) }
  }
}

export async function updateWarehouse(
  id: string,
  input: WarehouseInput
): Promise<{ success: boolean; item?: WarehouseRow; error?: string; warning?: string }> {
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

    const item = await db.$transaction(async (tx) => {
      // If setting as default, unset others
      if (data.isDefault) {
        await tx.warehouse.updateMany({ where: { isDefault: true, id: { not: id } }, data: { isDefault: false } })
      }
      if (data.defaultReturnWarehouse) {
        await tx.warehouse.updateMany({ where: { defaultReturnWarehouse: true, id: { not: id } }, data: { defaultReturnWarehouse: false } })
      }

      return tx.warehouse.update({
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
    })
    const postCommit = await runPostCommit(async () => {
      await logActivity({ entityType: 'SETTING', entityId: id, tag: 'settings', action: 'updated', description: `Updated warehouse: ${data.code} — ${data.name}` })
      revalidatePath('/settings', 'layout')
    }, 'Failed to record the warehouse change')
    if (postCommit.status === 'failed') return { success: true, item, warning: postCommit.error }
    return { success: true, item }
  } catch (e) {
    unstable_rethrow(e)
    await logActivity({ entityType: 'SETTING', entityId: id, tag: 'settings', action: 'updated', level: 'ERROR', description: `Failed to update warehouse: ${data.code}` })
    if (uniqueViolationTargetsField(e, 'code')) return { success: false, error: `Warehouse code "${data.code}" already exists.` }
    return { success: false, error: String(e) }
  }
}

export async function deleteWarehouse(
  id: string
): Promise<{ success: boolean; deactivated?: boolean; error?: string; warning?: string }> {
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
      // BOTH branches commit, so both have a post-commit tail. A rule that only looked after the
      // LAST commit in a function would have seen the delete branch and missed this one.
      const deactivatedPostCommit = await runPostCommit(async () => {
        await logActivity({ entityType: 'SETTING', entityId: id, tag: 'settings', action: 'updated', description: 'Deactivated warehouse (has associated data)' })
        revalidatePath('/settings', 'layout')
      }, 'Failed to record the warehouse deactivation')
      if (deactivatedPostCommit.status === 'failed') {
        return { success: true, deactivated: true, warning: deactivatedPostCommit.error }
      }
      return { success: true, deactivated: true }
    }

    await db.warehouse.delete({ where: { id } })
    const postCommit = await runPostCommit(async () => {
      await logActivity({ entityType: 'SETTING', entityId: id, tag: 'settings', action: 'deleted', description: 'Deleted warehouse' })
      revalidatePath('/settings', 'layout')
    }, 'Failed to record the warehouse deletion')
    if (postCommit.status === 'failed') return { success: true, warning: postCommit.error }
    return { success: true }
  } catch (e) {
    unstable_rethrow(e)
    await logActivity({ entityType: 'SETTING', entityId: id, tag: 'settings', action: 'deleted', level: 'ERROR', description: 'Failed to delete warehouse' })
    return { success: false, error: String(e) }
  }
}
