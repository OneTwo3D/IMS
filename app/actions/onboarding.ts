'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { lockIntegrationPluginSelection } from '@/lib/integration-plugin-selection-lock'
import { logActivity } from '@/lib/activity-log'
import { requireAdmin } from '@/lib/auth/server'
import { getSettingValue } from '@/lib/settings-store'
import { getIntegrationPluginState, INTEGRATION_PLUGIN_SETTING_KEYS, type IntegrationPluginState } from '@/lib/integration-plugins'
import { isBaseCurrencyLocked } from '@/lib/base-currency'
import type { SaveOnboardingPluginStateResult } from '@/lib/domain/onboarding/plugin-save-outcome'
import { syncCrontab } from '@/app/actions/cron'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OnboardingState = {
  complete: boolean
  dismissed: boolean
  currentStepKey: string
  hasStoredProgress: boolean
  companyConfigured: boolean
  currencyConfigured: boolean
  productCount: number
  warehouseCount: number
  pluginState: IntegrationPluginState
  isLegacyConfigured: boolean
  shouldShowBanner: boolean
  shouldAllowWizard: boolean
}

const DEFAULT_ORG_NAME = 'onetwoInventory'
const DEFAULT_ONBOARDING_STEP_KEY = 'welcome'

// audit-wrwr: persisted progress is the step KEY (reorder-proof). A legacy numeric
// value saved before this change is treated as "no key", so the user resumes at
// the start rather than being mis-routed by a now-shifted index.
function normalizeStoredStepKey(value: string | null | undefined): string | null {
  if (!value || /^\d+$/.test(value)) return null
  return /^[a-z][a-z-]*$/.test(value) ? value : null
}

function isOrganisationConfigured(org: {
  name: string | null
  legalName: string | null
  vatNumber: string | null
  companyNumber: string | null
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  county: string | null
  postcode: string | null
  country: string | null
  phone: string | null
  email: string | null
  website: string | null
  logoUrl: string | null
  documentLogoUrl: string | null
} | null): boolean {
  if (!org) return false

  return (
    (!!org.name && org.name !== DEFAULT_ORG_NAME) ||
    !!org.legalName ||
    !!org.vatNumber ||
    !!org.companyNumber ||
    !!org.addressLine1 ||
    !!org.addressLine2 ||
    !!org.city ||
    !!org.county ||
    !!org.postcode ||
    !!org.phone ||
    !!org.email ||
    !!org.website ||
    !!org.logoUrl ||
    !!org.documentLogoUrl ||
    (!!org.country && org.country !== 'GB')
  )
}

async function loadOnboardingFacts() {
  const [completeVal, dismissedVal, stepVal, pluginState, org, productCount, warehouseCount, currencyConfigured] = await Promise.all([
    getSettingValue('onboarding_complete'),
    getSettingValue('onboarding_dismissed'),
    getSettingValue('onboarding_current_step'),
    getIntegrationPluginState(),
    db.organisation.findFirst({
      select: {
        name: true,
        legalName: true,
        vatNumber: true,
        companyNumber: true,
        addressLine1: true,
        addressLine2: true,
        city: true,
        county: true,
        postcode: true,
        country: true,
        phone: true,
        email: true,
        website: true,
        logoUrl: true,
        documentLogoUrl: true,
      },
    }),
    db.product.count(),
    db.warehouse.count({ where: { active: true } }),
    isBaseCurrencyLocked(),
  ])

  const complete = completeVal === 'true'
  const dismissed = dismissedVal === 'true'
  const hasStoredProgress = stepVal != null
  const currentStepKey = normalizeStoredStepKey(stepVal) ?? DEFAULT_ONBOARDING_STEP_KEY
  const companyConfigured = isOrganisationConfigured(org)
  const pluginsConfigured = Object.values(pluginState).some(Boolean)
  const isLegacyConfigured = !hasStoredProgress && (companyConfigured || currencyConfigured || productCount > 0 || warehouseCount > 1 || pluginsConfigured)
  const shouldAllowWizard = !complete && (hasStoredProgress || !isLegacyConfigured)
  const shouldShowBanner = shouldAllowWizard && !dismissed

  return {
    complete,
    dismissed,
    currentStepKey,
    hasStoredProgress,
    companyConfigured,
    currencyConfigured,
    productCount,
    warehouseCount,
    pluginState,
    isLegacyConfigured,
    shouldShowBanner,
    shouldAllowWizard,
  }
}

// ---------------------------------------------------------------------------
// Read state
// ---------------------------------------------------------------------------

export async function getOnboardingState(): Promise<OnboardingState> {
  await requireAdmin()
  return loadOnboardingFacts()
}

/**
 * Lightweight check for the dashboard banner — avoids loading full state.
 */
export async function isOnboardingComplete(): Promise<boolean> {
  await requireAdmin()
  const state = await loadOnboardingFacts()
  return state.complete
}

export async function isOnboardingDismissed(): Promise<boolean> {
  await requireAdmin()
  const state = await loadOnboardingFacts()
  return state.dismissed
}

export async function shouldShowOnboardingBanner(): Promise<boolean> {
  await requireAdmin()
  const state = await loadOnboardingFacts()
  return state.shouldShowBanner
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export async function setOnboardingStep(stepKey: string): Promise<void> {
  await requireAdmin()
  const nextStep = normalizeStoredStepKey(stepKey) ?? DEFAULT_ONBOARDING_STEP_KEY
  await db.setting.upsert({
    where: { key: 'onboarding_current_step' },
    create: { key: 'onboarding_current_step', value: nextStep },
    update: { value: nextStep },
  })
  await logActivity({
    entityType: 'SETTING',
    tag: 'settings',
    action: 'updated',
    description: `Updated onboarding step to ${nextStep}`,
  })
  revalidatePath('/onboarding')
}

export async function completeOnboarding(): Promise<{ success: boolean; error?: string }> {
  await requireAdmin()
  const state = await loadOnboardingFacts()
  if (!state.companyConfigured) {
    return { success: false, error: 'Complete the company details step before finishing setup.' }
  }
  if (!state.currencyConfigured) {
    return { success: false, error: 'Save and lock the base currency before finishing setup.' }
  }

  await db.setting.upsert({
    where: { key: 'onboarding_complete' },
    create: { key: 'onboarding_complete', value: 'true' },
    update: { value: 'true' },
  })
  await db.setting.upsert({
    where: { key: 'onboarding_dismissed' },
    create: { key: 'onboarding_dismissed', value: 'false' },
    update: { value: 'false' },
  })
  await logActivity({
    entityType: 'SETTING',
    tag: 'settings',
    action: 'updated',
    description: 'Completed onboarding wizard',
  })
  revalidatePath('/dashboard')
  revalidatePath('/onboarding')
  return { success: true }
}

export async function dismissOnboarding(): Promise<void> {
  await requireAdmin()
  await db.setting.upsert({
    where: { key: 'onboarding_dismissed' },
    create: { key: 'onboarding_dismissed', value: 'true' },
    update: { value: 'true' },
  })
  await logActivity({
    entityType: 'SETTING',
    tag: 'settings',
    action: 'updated',
    description: 'Dismissed onboarding banner',
  })
  revalidatePath('/dashboard')
}

type PluginStateInput = {
  woocommerce: boolean
  shopify: boolean
  xero: boolean
  quickbooks: boolean
  mintsoft: boolean
}

/**
 * THREE outcomes, not two (o3d-osl8 round 7, finding 1). The union and the reasoning live in
 * lib/domain/onboarding/plugin-save-outcome.ts, next to the resolver that consumes it.
 *
 * WHY NOT A DURABLE OUTBOX RETRY for the scheduler half, which the repo does have
 * (lib/domain/integrations/outbox.ts). Every outbox drain in this app is a cron route
 * (app/api/cron/*) invoked BY the crontab this step is trying to write. An outbox row that
 * reconciles the crontab would therefore be drained by the crontab: in the failure that matters —
 * the managed block is absent, stale or unwritable — nothing would ever run it, and the row would
 * sit PENDING while the UI reported the work as scheduled. That is the same class of lie this
 * finding is about, moved into the queue. The recovery is instead an EXPLICIT operator action with
 * an existing home: Settings → System → Scheduler, which already reports crontab drift
 * (getCrontabStatus) and can re-run syncCrontab.
 */
export async function saveOnboardingPluginState(state: PluginStateInput): Promise<SaveOnboardingPluginStateResult> {
  await requireAdmin()

  // A cheap payload-only pre-check, so an obviously contradictory form never opens a transaction.
  // It is NOT the guarantee — `resulting`, below, is (round 6, finding 1).
  if (state.woocommerce && state.shopify) {
    return { status: 'refused', error: 'Choose either WooCommerce or Shopify, not both.' }
  }
  if (state.xero && state.quickbooks) {
    return { status: 'refused', error: 'Choose either Xero or QuickBooks, not both.' }
  }

  // Lock, read, validate, write — in that order, inside one transaction (o3d-osl8 round 6,
  // finding 1). This step writes every exclusivity-bearing key, so the RESULTING state is
  // determined by the payload; the read still matters because the lock it comes with is what stops
  // a concurrent PARTIAL write (saveIntegrationPluginState) from landing between this validation
  // and this commit and leaving both accounting connectors enabled.
  const outcome = await db.$transaction(async (tx): Promise<{ conflict: string } | { committed: IntegrationPluginState }> => {
    const current = await lockIntegrationPluginSelection(tx)
    const resulting = {
      ...current,
      woocommerce: state.woocommerce,
      shopify: state.shopify,
      xero: state.xero,
      quickbooks: state.quickbooks,
      mintsoft: state.mintsoft,
    }
    if (resulting.woocommerce && resulting.shopify) {
      return { conflict: 'Choose either WooCommerce or Shopify, not both.' }
    }
    if (resulting.xero && resulting.quickbooks) {
      return { conflict: 'Choose either Xero or QuickBooks, not both.' }
    }

    for (const [id, enabled] of [
      ['woocommerce', state.woocommerce],
      ['shopify', state.shopify],
      ['xero', state.xero],
      ['quickbooks', state.quickbooks],
      ['mintsoft', state.mintsoft],
    ] as const) {
      const key = INTEGRATION_PLUGIN_SETTING_KEYS[id]
      await tx.setting.upsert({
        where: { key },
        create: { key, value: String(enabled) },
        update: { value: String(enabled) },
      })
    }
    return { committed: resulting }
  })
  if ('conflict' in outcome) return { status: 'refused', error: outcome.conflict }

  await logActivity({
    entityType: 'SETTING',
    tag: 'settings',
    action: 'updated',
    description: 'Updated onboarding plugin selection',
    metadata: state,
  })

  // UNCONDITIONAL, and before the scheduler result is inspected (round 7, finding 1). The
  // selection is durable at this point; leaving the route cache holding the previous answer on the
  // scheduler-failure path made the server itself agree with the rolled-back UI, which is how a
  // stale connector survived a reload.
  revalidatePath('/onboarding')
  revalidatePath('/dashboard')

  const cronResult = await syncCrontab()
  if (!cronResult.success) {
    // NOT a rejected save. syncCrontab already logged its own crontab_sync ERROR; what this adds is
    // the committed selection, so the caller can keep showing what is actually stored instead of
    // guessing from its own optimistic copy.
    return {
      status: 'scheduler-failed',
      error: cronResult.error ?? 'Failed to apply scheduler changes',
      pluginState: outcome.committed,
    }
  }

  return { status: 'saved' }
}
