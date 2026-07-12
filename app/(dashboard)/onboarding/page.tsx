import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { requireAdmin } from '@/lib/auth/server'
import { getOnboardingState } from '@/app/actions/onboarding'
import { getOrganisation, getBaseCurrencySettings, getEmailSettings } from '@/app/actions/company'
import { getCurrencies } from '@/app/actions/currencies'
import { getTaxRates, getWarehousesForSettings } from '@/app/actions/settings'
import { getShoppingConnectorCredentials, getShopifyConnectorCredentials } from '@/app/actions/shopping-sync'
import { getAccountingSettingsMasked, getAccountingConnectionStatus } from '@/app/actions/accounting-sync'
import { getWmsOnboardingConnectionData } from '@/app/actions/wms-onboarding'
import { detectPublicAppUrlFromHeaders, getPublicAppUrlInfo } from '@/lib/public-app-url'
import { getSettingValue } from '@/lib/settings-store'
import { OnboardingClient } from './onboarding-client'

export const metadata: Metadata = { title: 'Setup Wizard' }

export default async function OnboardingPage() {
  const session = await requireAdmin()
  const headerList = await headers()
  const suggestedPublicAppUrl = detectPublicAppUrlFromHeaders({
    forwardedHost: headerList.get('x-forwarded-host'),
    forwardedProto: headerList.get('x-forwarded-proto'),
    host: headerList.get('host'),
  })

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
    wmsConnection,
    emailSettings,
    publicAppUrlInfo,
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
    getWmsOnboardingConnectionData(),
    getEmailSettings(),
    getPublicAppUrlInfo(),
  ])

  if (onboardingState.complete || !onboardingState.shouldAllowWizard) {
    redirect('/dashboard')
  }

  return (
    <OnboardingClient
      initialStepKey={onboardingState.currentStepKey}
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
      wmsConnection={wmsConnection}
      emailSettings={emailSettings}
      publicAppUrlInfo={publicAppUrlInfo}
      suggestedPublicAppUrl={suggestedPublicAppUrl}
      testEmailDefault={session.user.email}
    />
  )
}
