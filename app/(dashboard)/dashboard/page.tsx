import type { Metadata } from 'next'
import { getDashboardData } from '@/app/actions/dashboard'
import { DashboardClient } from './dashboard-client'

export const metadata: Metadata = { title: 'Dashboard' }

export default async function Page() {
  const initialPeriod = 'this_month' as const
  const initialCompare = 'previous_period' as const
  const { kpi, chartData, topProducts, recentOrders, incomingPOs, periodLabel, compLabel } = await getDashboardData(initialPeriod, initialCompare)

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
    />
  )
}
