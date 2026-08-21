import { AccessDenied } from '@/components/auth/access-denied'
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
import { authorizePage } from '@/lib/auth/server'
import { CompanySettingsClient } from './company-client'

export const metadata: Metadata = { title: 'Company Settings' }

export default async function CompanySettingsPage() {
  // o3d-512h: page-level authorization. The (dashboard) layout establishes only
  // AUTHENTICATION, and the sidebar hiding a link is not a boundary — without
  // this, any authenticated role that types the URL renders the page and its
  // reads run. Must stay the FIRST statement so a denial performs no read.
  const gate = await authorizePage('settings.company')
  if (!gate.authorized) return <AccessDenied permission={gate.permission} />

  const session = gate.session
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
      testEmailDefault={session.user.email}
    />
  )
}
