'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requireAdmin } from '@/lib/auth/server'
import { getSettingValue } from '@/lib/settings-store'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { isBaseCurrencyLocked } from '@/lib/base-currency'
import { syncCrontab } from '@/app/actions/cron'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OnboardingState = {
  complete: boolean
  dismissed: boolean
  currentStep: number
  hasStoredProgress: boolean
  companyConfigured: boolean
  currencyConfigured: boolean
  productCount: number
  warehouseCount: number
  pluginState: {
    woocommerce: boolean
    shopify: boolean
    xero: boolean
    quickbooks: boolean
  }
  isLegacyConfigured: boolean
  shouldShowBanner: boolean
  shouldAllowWizard: boolean
}

const DEFAULT_ORG_NAME = 'onetwoInventory'
const LAST_ONBOARDING_STEP = 8

function clampOnboardingStep(step: number): number {
  if (!Number.isFinite(step)) return 0
  return Math.max(0, Math.min(LAST_ONBOARDING_STEP, Math.trunc(step)))
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
  const parsedStep = stepVal ? Number.parseInt(stepVal, 10) : 0
  const currentStep = clampOnboardingStep(parsedStep)
  const companyConfigured = isOrganisationConfigured(org)
  const pluginsConfigured = Object.values(pluginState).some(Boolean)
  const isLegacyConfigured = !hasStoredProgress && (companyConfigured || currencyConfigured || productCount > 0 || warehouseCount > 1 || pluginsConfigured)
  const shouldAllowWizard = !complete && (hasStoredProgress || !isLegacyConfigured)
  const shouldShowBanner = shouldAllowWizard && !dismissed

  return {
    complete,
    dismissed,
    currentStep,
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

export async function setOnboardingStep(step: number): Promise<void> {
  await requireAdmin()
  const nextStep = clampOnboardingStep(step)
  await db.setting.upsert({
    where: { key: 'onboarding_current_step' },
    create: { key: 'onboarding_current_step', value: String(nextStep) },
    update: { value: String(nextStep) },
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
}

export async function saveOnboardingPluginState(state: PluginStateInput): Promise<{ success: boolean; error?: string }> {
  await requireAdmin()

  if (state.woocommerce && state.shopify) {
    return { success: false, error: 'Choose either WooCommerce or Shopify, not both.' }
  }
  if (state.xero && state.quickbooks) {
    return { success: false, error: 'Choose either Xero or QuickBooks, not both.' }
  }

  await db.$transaction([
    db.setting.upsert({
      where: { key: 'plugin_woocommerce_enabled' },
      create: { key: 'plugin_woocommerce_enabled', value: String(state.woocommerce) },
      update: { value: String(state.woocommerce) },
    }),
    db.setting.upsert({
      where: { key: 'plugin_shopify_enabled' },
      create: { key: 'plugin_shopify_enabled', value: String(state.shopify) },
      update: { value: String(state.shopify) },
    }),
    db.setting.upsert({
      where: { key: 'plugin_xero_enabled' },
      create: { key: 'plugin_xero_enabled', value: String(state.xero) },
      update: { value: String(state.xero) },
    }),
    db.setting.upsert({
      where: { key: 'plugin_quickbooks_enabled' },
      create: { key: 'plugin_quickbooks_enabled', value: String(state.quickbooks) },
      update: { value: String(state.quickbooks) },
    }),
  ])

  await logActivity({
    entityType: 'SETTING',
    tag: 'settings',
    action: 'updated',
    description: 'Updated onboarding plugin selection',
    metadata: state,
  })

  const cronResult = await syncCrontab()
  if (!cronResult.success) {
    return { success: false, error: cronResult.error ?? 'Failed to apply scheduler changes' }
  }

  revalidatePath('/onboarding')
  revalidatePath('/dashboard')
  return { success: true }
}
