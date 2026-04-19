import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { requireAdmin } from '@/lib/auth/server'
import { getSettingValue } from '@/lib/settings-store'
import { getOrganisation, getBaseCurrencySettings } from '@/app/actions/company'
import { getCurrencies } from '@/app/actions/currencies'
import { getTaxRates, getWarehousesForSettings } from '@/app/actions/settings'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { getShoppingConnectorCredentials, getShopifyConnectorCredentials } from '@/app/actions/shopping-sync'
import { getAccountingSettingsMasked, getAccountingConnectionStatus } from '@/app/actions/accounting-sync'
import { db } from '@/lib/db'
import { OnboardingClient } from './onboarding-client'

export const metadata: Metadata = { title: 'Setup Wizard' }

export default async function OnboardingPage() {
  await requireAdmin()

  const onboardingComplete = await getSettingValue('onboarding_complete')
  if (onboardingComplete === 'true') redirect('/dashboard')

  const [
    org,
    baseCurrencySettings,
    currencies,
    taxRates,
    warehouses,
    financialYearStart,
    currentStep,
    pluginState,
    productCount,
    wcCredentials,
    shopifyCredentials,
    accountingSettings,
    accountingStatus,
  ] = await Promise.all([
    getOrganisation(),
    getBaseCurrencySettings(),
    getCurrencies(false),
    getTaxRates(false),
    getWarehousesForSettings(),
    getSettingValue('financial_year_start'),
    getSettingValue('onboarding_current_step'),
    getIntegrationPluginState(),
    db.product.count(),
    getShoppingConnectorCredentials(),
    getShopifyConnectorCredentials(),
    getAccountingSettingsMasked(),
    getAccountingConnectionStatus(),
  ])

  // If returning from an OAuth callback during onboarding, clear the pending flag
  const oauthPending = await getSettingValue('onboarding_oauth_pending')
  if (oauthPending === 'true') {
    await db.setting.upsert({
      where: { key: 'onboarding_oauth_pending' },
      create: { key: 'onboarding_oauth_pending', value: 'false' },
      update: { value: 'false' },
    })
  }

  return (
    <OnboardingClient
      initialStep={currentStep ? parseInt(currentStep, 10) : 0}
      org={org}
      baseCurrencyLocked={baseCurrencySettings.locked}
      currencies={currencies}
      taxRates={taxRates}
      warehouses={warehouses}
      financialYearStart={financialYearStart ?? '04-06'}
      pluginState={pluginState}
      productCount={productCount}
      wcCredentials={wcCredentials}
      shopifyCredentials={shopifyCredentials}
      accountingSettings={accountingSettings}
      accountingStatus={accountingStatus}
    />
  )
}
