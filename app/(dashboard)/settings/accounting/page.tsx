import type { Metadata } from 'next'
import { CalendarDays, Receipt, Coins, RefreshCw } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { getSetting, getTaxRates } from '@/app/actions/settings'
import { getCurrencies } from '@/app/actions/currencies'
import { FinancialYearStartSetting } from '@/components/settings/financial-year-start'
import { TaxRatesTable } from '@/components/settings/tax-rates-table'
import { CurrenciesTable } from '@/components/settings/currencies-table'
import { FxScheduleSettings } from '@/components/settings/fx-schedule'

export const metadata: Metadata = { title: 'Accounting Settings' }

export default async function AccountingSettingsPage() {
  const [fyStart, taxRates, currencies, fxEnabled, fxInterval, fxLastFetched] = await Promise.all([
    getSetting('financial_year_start'),
    getTaxRates(false),
    getCurrencies(false),
    getSetting('fx_schedule_enabled'),
    getSetting('fx_schedule_interval_hours'),
    getSetting('fx_last_fetched'),
  ])

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-semibold">Accounting Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">Financial year, VAT rates, currencies, and accounting configuration.</p>
      </div>

      <Card className="p-6">
        <div className="flex items-center gap-2 mb-4">
          <CalendarDays className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">Financial Year</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          Set the start date of your financial year. This affects dashboard KPIs, year-to-date
          calculations, and analytics comparisons. Default is 6 April (UK tax year).
        </p>
        <FinancialYearStartSetting currentValue={fyStart ?? '04-06'} />
      </Card>

      <Card className="p-6">
        <div className="flex items-center gap-2 mb-4">
          <Receipt className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">VAT Rates</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          Define VAT rates for sales and purchases. Each rate can have a Xero tax type code
          for automatic invoice sync. Rates marked &quot;Both&quot; apply to sales and purchases.
        </p>
        <TaxRatesTable taxRates={taxRates} />
      </Card>

      <Card className="p-6">
        <div className="flex items-center gap-2 mb-4">
          <Coins className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">Currencies &amp; FX Rates</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          Define currencies used for purchasing. FX rates are fetched daily from the ECB
          via the <code className="text-xs">/api/cron/fx-rates</code> endpoint. GBP is always the
          base currency and cannot be removed.
        </p>
        <CurrenciesTable currencies={currencies} />
      </Card>

      <Card className="p-6">
        <div className="flex items-center gap-2 mb-4">
          <RefreshCw className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">FX Rate Schedule</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          Configure automatic FX rate updates. Rates are fetched from the European Central Bank (ECB).
        </p>
        <FxScheduleSettings
          enabled={fxEnabled === 'true'}
          intervalHours={fxInterval ?? '24'}
          lastFetched={fxLastFetched}
        />
      </Card>
    </div>
  )
}
