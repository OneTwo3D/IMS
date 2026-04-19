import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { requireAdmin } from '@/lib/auth/server'
import { getOnboardingState } from '@/app/actions/onboarding'
import { getOrganisation, getBaseCurrencySettings } from '@/app/actions/company'
import { getCurrencies } from '@/app/actions/currencies'
import { getTaxRates, getWarehousesForSettings } from '@/app/actions/settings'
import { getShoppingConnectorCredentials, getShopifyConnectorCredentials } from '@/app/actions/shopping-sync'
import { getAccountingSettingsMasked, getAccountingConnectionStatus } from '@/app/actions/accounting-sync'
import { getSettingValue } from '@/lib/settings-store'
import { OnboardingClient } from './onboarding-client'

export const metadata: Metadata = { title: 'Setup Wizard' }

export default async function OnboardingPage() {
  await requireAdmin()

  const [
    onboardingState,
    org,
    baseCurrencySettings,
    currencies,
    taxRates,
    warehouses,
    financialYearStart,
    wcCredentials,
    shopifyCredentials,
    accountingSettings,
    accountingStatus,
  ] = await Promise.all([
    getOnboardingState(),
    getOrganisation(),
    getBaseCurrencySettings(),
    getCurrencies(false),
    getTaxRates(false),
    getWarehousesForSettings(),
    getSettingValue('financial_year_start'),
    getShoppingConnectorCredentials(),
    getShopifyConnectorCredentials(),
    getAccountingSettingsMasked(),
    getAccountingConnectionStatus(),
  ])

  if (onboardingState.complete || !onboardingState.shouldAllowWizard) {
    redirect('/dashboard')
  }

  return (
    <OnboardingClient
      initialStep={onboardingState.currentStep}
      org={org}
      baseCurrencyLocked={baseCurrencySettings.locked}
      currencies={currencies}
      taxRates={taxRates}
      warehouses={warehouses}
      financialYearStart={financialYearStart ?? '04-06'}
      pluginState={onboardingState.pluginState}
      productCount={onboardingState.productCount}
      companyConfigured={onboardingState.companyConfigured}
      currencyConfigured={onboardingState.currencyConfigured}
      wcCredentials={wcCredentials}
      shopifyCredentials={shopifyCredentials}
      accountingSettings={accountingSettings}
      accountingStatus={accountingStatus}
    />
  )
}
