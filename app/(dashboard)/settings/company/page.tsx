import type { Metadata } from 'next'
import {
  getOrganisation,
  getBaseCurrencySettings,
  getNumberingFormats,
  getEmailSettings,
  getBrandingColours,
  getDocumentTemplates,
  getShoppingConnectors,
} from '@/app/actions/company'
import { getCurrencies } from '@/app/actions/currencies'
import { CompanySettingsClient } from './company-client'

export const metadata: Metadata = { title: 'Company Settings' }

export default async function CompanySettingsPage() {
  const [org, baseCurrencySettings, numbering, email, branding, templates, shoppingConnectors, currencies] = await Promise.all([
    getOrganisation(),
    getBaseCurrencySettings(),
    getNumberingFormats(),
    getEmailSettings(),
    getBrandingColours(),
    getDocumentTemplates(),
    getShoppingConnectors(),
    getCurrencies(false),
  ])

  return (
    <CompanySettingsClient
      org={org}
      baseCurrencyLocked={baseCurrencySettings.locked}
      numbering={numbering}
      email={email}
      branding={branding}
      templates={templates}
      shoppingConnectors={shoppingConnectors}
      currencies={currencies}
    />
  )
}
