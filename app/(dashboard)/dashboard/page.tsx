import type { Metadata } from 'next'
import { getDashboardData } from '@/app/actions/dashboard'
import { auth } from '@/lib/auth'
import { shouldShowOnboardingBanner } from '@/app/actions/onboarding'
import { DashboardClient } from './dashboard-client'

export const metadata: Metadata = { title: 'Dashboard' }

export default async function Page() {
  const initialPeriod = 'this_month' as const
  const initialCompare = 'previous_period' as const

  const [dashboardData, session] = await Promise.all([
    getDashboardData(initialPeriod, initialCompare),
    auth(),
  ])

  const { kpi, chartData, topProducts, recentOrders, incomingPOs, periodLabel, compLabel } = dashboardData

  // Show onboarding banner only for admins who haven't completed or dismissed it
  let showOnboardingBanner = false
  if (session?.user?.role === 'ADMIN') {
    showOnboardingBanner = await shouldShowOnboardingBanner()
  }

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
    />
  )
}
