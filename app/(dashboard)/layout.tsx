export const dynamic = 'force-dynamic'

import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { DashboardShell } from '@/components/layout/dashboard-shell'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { getBaseCurrencyDisplay } from '@/lib/base-currency'
import { BaseCurrencyProvider } from '@/components/providers/base-currency-provider'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth()

  if (!session?.user) redirect('/login')
  if (session.user.totpEnabled && !session.user.totpVerified) redirect('/2fa')

  const [org, pluginState, baseCurrency] = await Promise.all([
    db.organisation.findFirst({ select: { name: true, logoUrl: true } }),
    getIntegrationPluginState(),
    getBaseCurrencyDisplay(),
  ])

  return (
    <BaseCurrencyProvider value={baseCurrency}>
      <DashboardShell
        companyName={org?.name}
        logoUrl={org?.logoUrl}
        userRole={session.user.role}
        userName={session.user.name ?? ''}
        userEmail={session.user.email ?? ''}
        userPictureUrl={session.user.pictureUrl}
        shoppingIntegrationEnabled={pluginState.woocommerce}
        accountingIntegrationEnabled={pluginState.xero}
      >
        {children}
      </DashboardShell>
    </BaseCurrencyProvider>
  )
}
