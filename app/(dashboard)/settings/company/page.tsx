import type { Metadata } from 'next'
import {
  getOrganisation,
  getNumberingFormats,
  getEmailSettings,
  getBrandingColours,
  getDocumentTemplates,
  getShoppingConnectors,
} from '@/app/actions/company'
import { CompanySettingsClient } from './company-client'

export const metadata: Metadata = { title: 'Company Settings' }

export default async function CompanySettingsPage() {
  const [org, numbering, email, branding, templates, shoppingConnectors] = await Promise.all([
    getOrganisation(),
    getNumberingFormats(),
    getEmailSettings(),
    getBrandingColours(),
    getDocumentTemplates(),
    getShoppingConnectors(),
  ])

  return (
    <CompanySettingsClient
      org={org}
      numbering={numbering}
      email={email}
      branding={branding}
      templates={templates}
      shoppingConnectors={shoppingConnectors}
    />
  )
}
