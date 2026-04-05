import type { Metadata } from 'next'
import { generateForecasts, getForecastSettings } from '@/app/actions/forecasting'
import { ForecastClient } from './forecast-client'

export const metadata: Metadata = { title: 'Reorder Forecast' }

export default async function ForecastPage() {
  const [forecasts, settings] = await Promise.all([
    generateForecasts(),
    getForecastSettings(),
  ])
  return <ForecastClient forecasts={forecasts} settings={settings} />
}
