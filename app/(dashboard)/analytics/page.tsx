import type { Metadata } from 'next'
import { generateForecasts, getForecastSettings } from '@/app/actions/forecasting'
import { ForecastClient } from './forecast-client'

export const metadata: Metadata = { title: 'Analytics — Reorder Forecast' }

export default async function AnalyticsPage() {
  const [forecasts, settings] = await Promise.all([
    generateForecasts(),
    getForecastSettings(),
  ])

  return <ForecastClient forecasts={forecasts} settings={settings} />
}
