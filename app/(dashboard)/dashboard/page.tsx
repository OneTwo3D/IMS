import type { Metadata } from 'next'
import { getDashboardData } from '@/app/actions/dashboard'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { SUPPLIER_HOME_PATH } from '@/lib/auth/role-home'
import { shouldShowOnboardingBanner } from '@/app/actions/onboarding'
import { getNeedsAttentionView } from '@/app/actions/needs-attention'
import { DashboardClient } from './dashboard-client'

export const metadata: Metadata = { title: 'Dashboard' }

export default async function Page() {
  // A supplier has no dashboard permission; getDashboardData would throw and the
  // error boundary would show "Something went wrong". Send it to its own portal.
  const session = await auth()
  if (session?.user?.role === 'SUPPLIER') redirect(SUPPLIER_HOME_PATH)

  const initialPeriod = 'this_month' as const
  const initialCompare = 'previous_period' as const

  const dashboardData = await getDashboardData(initialPeriod, initialCompare)

  const { kpi, chartData, topProducts, recentOrders, incomingPOs, periodLabel, compLabel } = dashboardData

  // Show onboarding banner only for admins who haven't completed or dismissed it
  let showOnboardingBanner = false
  if (session?.user?.role === 'ADMIN') {
    showOnboardingBanner = await shouldShowOnboardingBanner()
  }

  // A failed count read must not take the dashboard down: the card is an aid, the KPIs are the page.
  const needsAttention = await getNeedsAttentionView().catch((error) => {
    console.error('[dashboard] needs-attention counts unavailable:', error)
    return null
  })

  return (
    <DashboardClient
      kpi={kpi}
      chartData={chartData}
      topProducts={topProducts}
      recentOrders={recentOrders}
      incomingPOs={incomingPOs}
      periodLabel={periodLabel}
      compLabel={compLabel}
      initialPeriod={initialPeriod}
      initialCompare={initialCompare}
      showOnboardingBanner={showOnboardingBanner}
      needsAttention={needsAttention}
    />
  )
}
