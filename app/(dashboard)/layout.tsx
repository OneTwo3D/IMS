export const dynamic = 'force-dynamic'

import { redirect } from 'next/navigation'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/auth/server'
import { DashboardShell } from '@/components/layout/dashboard-shell'
import { getIntegrationPluginState, isIntegrationModuleVisible } from '@/lib/integration-plugins'
import { getBaseCurrencyDisplay } from '@/lib/base-currency'
import { BaseCurrencyProvider } from '@/components/providers/base-currency-provider'
import { TimeZoneProvider } from '@/components/providers/timezone-provider'
import { DEFAULT_TIMEZONE } from '@/lib/format-datetime'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await requireAuth()

  if (session.user.totpEnabled && !session.user.totpVerified) redirect('/2fa')

  const [org, pluginState, baseCurrency] = await Promise.all([
    db.organisation.findFirst({ select: { name: true, logoUrl: true, timezone: true } }),
    getIntegrationPluginState(),
    getBaseCurrencyDisplay(),
  ])

  return (
    <BaseCurrencyProvider value={baseCurrency}>
      <TimeZoneProvider value={org?.timezone ?? DEFAULT_TIMEZONE}>
      <DashboardShell
        companyName={org?.name}
        logoUrl={org?.logoUrl}
        userRole={session.user.role}
        userName={session.user.name ?? ''}
        userEmail={session.user.email ?? ''}
        userPictureUrl={session.user.pictureUrl}
        shoppingIntegrationEnabled={pluginState.woocommerce || pluginState.shopify}
        accountingIntegrationEnabled={pluginState.xero || pluginState.quickbooks}
        wmsIntegrationEnabled={isIntegrationModuleVisible('wms', pluginState)}
      >
        {children}
      </DashboardShell>
      </TimeZoneProvider>
    </BaseCurrencyProvider>
  )
}
