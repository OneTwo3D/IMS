'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requireAdmin } from '@/lib/auth/server'
import { getSettingValue } from '@/lib/settings-store'
import { getIntegrationPluginState } from '@/lib/integration-plugins'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OnboardingState = {
  complete: boolean
  dismissed: boolean
  currentStep: number
  hasCustomOrgName: boolean
  productCount: number
  warehouseCount: number
  pluginState: {
    woocommerce: boolean
    shopify: boolean
    xero: boolean
    quickbooks: boolean
  }
}

// ---------------------------------------------------------------------------
// Read state
// ---------------------------------------------------------------------------

export async function getOnboardingState(): Promise<OnboardingState> {
  await requireAdmin()

  const [completeVal, dismissedVal, stepVal, pluginState, org, productCount, warehouseCount] = await Promise.all([
    getSettingValue('onboarding_complete'),
    getSettingValue('onboarding_dismissed'),
    getSettingValue('onboarding_current_step'),
    getIntegrationPluginState(),
    db.organisation.findFirst({ select: { name: true } }),
    db.product.count(),
    db.warehouse.count({ where: { active: true } }),
  ])

  return {
    complete: completeVal === 'true',
    dismissed: dismissedVal === 'true',
    currentStep: stepVal ? parseInt(stepVal, 10) : 0,
    hasCustomOrgName: !!org?.name && org.name !== 'onetwoInventory',
    productCount,
    warehouseCount,
    pluginState,
  }
}

/**
 * Lightweight check for the dashboard banner — avoids loading full state.
 */
export async function isOnboardingComplete(): Promise<boolean> {
  const val = await getSettingValue('onboarding_complete')
  return val === 'true'
}

export async function isOnboardingDismissed(): Promise<boolean> {
  const val = await getSettingValue('onboarding_dismissed')
  return val === 'true'
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export async function setOnboardingStep(step: number): Promise<void> {
  await requireAdmin()
  await db.setting.upsert({
    where: { key: 'onboarding_current_step' },
    create: { key: 'onboarding_current_step', value: String(step) },
    update: { value: String(step) },
  })
}

export async function completeOnboarding(): Promise<void> {
  await requireAdmin()
  await db.setting.upsert({
    where: { key: 'onboarding_complete' },
    create: { key: 'onboarding_complete', value: 'true' },
    update: { value: 'true' },
  })
  await logActivity({
    entityType: 'SETTING',
    tag: 'settings',
    action: 'updated',
    description: 'Completed onboarding wizard',
  })
  revalidatePath('/dashboard')
}

export async function dismissOnboarding(): Promise<void> {
  await requireAdmin()
  await db.setting.upsert({
    where: { key: 'onboarding_dismissed' },
    create: { key: 'onboarding_dismissed', value: 'true' },
    update: { value: 'true' },
  })
  revalidatePath('/dashboard')
}
