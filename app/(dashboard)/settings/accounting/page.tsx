import { AccessDenied } from '@/components/auth/access-denied'
import { authorizePage } from '@/lib/auth/server'
import type { Metadata } from 'next'
import Link from 'next/link'
import { CalendarDays, Receipt, Coins, RefreshCw, ArrowLeftRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Card } from '@/components/ui/card'
import { getSetting, getTaxRates } from '@/app/actions/settings'
import { getAccountingConnectionStatus } from '@/app/actions/accounting-sync'
import { getCurrentTaxRateDrift } from '@/lib/domain/accounting/tax-rate-drift-status'
import { getCurrencies, getLatestFxRates, getFxPushLog, getFxHealth } from '@/app/actions/currencies'
import { getBaseCurrencyCode } from '@/lib/base-currency'
import { FinancialYearStartSetting } from '@/components/settings/financial-year-start'
import { TaxRatesTable } from '@/components/settings/tax-rates-table'
import { CurrenciesTable } from '@/components/settings/currencies-table'
import { FxScheduleSettings } from '@/components/settings/fx-schedule'
import { FxRatesTable } from '@/components/settings/fx-rates-table'

export const metadata: Metadata = { title: 'Accounting Settings' }

const TABS = [
  { key: 'financial-year', label: 'Financial Year', icon: CalendarDays },
  { key: 'tax', label: 'Tax', icon: Receipt },
  { key: 'currencies', label: 'Currencies', icon: Coins },
  { key: 'fx-rates', label: 'FX Rates', icon: ArrowLeftRight },
] as const

type Tab = (typeof TABS)[number]['key']

export default async function AccountingSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  // o3d-512h: page-level authorization. The (dashboard) layout establishes only
  // AUTHENTICATION, and the sidebar hiding a link is not a boundary — without
  // this, any authenticated role that types the URL renders the page and its
  // reads run. Must stay the FIRST statement so a denial performs no read.
  const gate = await authorizePage('settings.company')
  if (!gate.authorized) return <AccessDenied permission={gate.permission} />

  const params = await searchParams
  const raw = typeof params.tab === 'string' ? params.tab : undefined
  const activeTab: Tab = TABS.some((t) => t.key === raw) ? (raw as Tab) : 'financial-year'

  const [fyData, taxData, currencyData, fxRatesData] = await Promise.all([
    activeTab === 'financial-year' ? loadFinancialYear() : null,
    activeTab === 'tax' ? loadTaxRates() : null,
    activeTab === 'currencies' ? loadCurrencies() : null,
    activeTab === 'fx-rates' ? loadFxRates() : null,
  ])

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-semibold">Accounting Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Financial year, VAT rates, currencies, and FX settings used across purchasing, sales, reporting, and optional accounting sync.
        </p>
      </div>

      <div className="flex gap-1 border-b">
        {TABS.map((tab) => {
          const Icon = tab.icon
          const active = tab.key === activeTab
          return (
            <Link
              key={tab.key}
              href={`/settings/accounting?tab=${tab.key}`}
              className={cn(
                'flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
                active
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {tab.label}
            </Link>
          )
        })}
      </div>

      {activeTab === 'financial-year' && fyData && (
        <Card className="p-6">
          <p className="text-sm text-muted-foreground mb-4">
            Set the start date of your financial year. This affects dashboard KPIs, year-to-date
            calculations, and analytics comparisons. Default is 6 April (UK tax year).
          </p>
          <FinancialYearStartSetting currentValue={fyData.fyStart ?? '04-06'} />
        </Card>
      )}

      {activeTab === 'tax' && taxData && (
        <Card className="p-6">
          <p className="text-sm text-muted-foreground mb-4">
            Define VAT rates for sales and purchases. Rates marked &quot;Both&quot; apply to sales and purchases.
            {' '}These rates still apply even when no accounting connector is enabled.
          </p>
          <TaxRatesTable taxRates={taxData.taxRates} drift={taxData.drift?.byTaxRateId} driftSyncEnabled={taxData.drift?.syncEnabled} accountingConnected={taxData.accountingConnected} />
        </Card>
      )}

      {activeTab === 'fx-rates' && fxRatesData && (
        <Card className="p-6">
          <div className="flex items-center gap-2 mb-4">
            <ArrowLeftRight className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-base font-semibold">FX Rates</h2>
          </div>
          <FxRatesTable
            baseCurrency={fxRatesData.baseCurrency}
            rates={fxRatesData.rates}
            pushLog={fxRatesData.pushLog}
            health={fxRatesData.health}
          />
        </Card>
      )}

      {activeTab === 'currencies' && currencyData && (
        <div className="space-y-6">
          <Card className="p-6">
            <div className="flex items-center gap-2 mb-4">
              <Coins className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-base font-semibold">Currencies &amp; FX Rates</h2>
            </div>
            <p className="text-sm text-muted-foreground mb-4">
              Define currencies used for purchasing. FX rates are fetched daily from the ECB
              via the <code className="text-xs">/api/cron/fx-rates</code> endpoint. The selected base
              currency is locked after setup and cannot be removed.
            </p>
            <CurrenciesTable currencies={currencyData.currencies} />
          </Card>

          <Card className="p-6">
            <div className="flex items-center gap-2 mb-4">
              <RefreshCw className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-base font-semibold">FX Rate Schedule</h2>
            </div>
            <p className="text-sm text-muted-foreground mb-4">
              Rates are fetched from the European Central Bank (ECB).
            </p>
            <FxScheduleSettings lastFetched={currencyData.fxLastFetched} />
          </Card>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Data loaders — only called for the active tab
// ---------------------------------------------------------------------------

async function loadFinancialYear() {
  const fyStart = await getSetting('financial_year_start')
  return { fyStart }
}

async function loadTaxRates() {
  const [taxRates, drift, accountingStatus] = await Promise.all([
    getTaxRates(false),
    getCurrentTaxRateDrift().catch(() => null),
    getAccountingConnectionStatus().catch(() => ({ connected: false })),
  ])
  return { taxRates, drift, accountingConnected: accountingStatus.connected }
}

async function loadCurrencies() {
  // `fx_schedule_enabled` / `fx_schedule_interval_hours` are NOT read here any more (Codex r20
  // HIGH): nothing in the application ever read them, so the panel's switch and interval were
  // controls that stored a value and changed nothing. The FX schedule is the `fx_rates` cron job.
  const [currencies, fxLastFetched] = await Promise.all([
    getCurrencies(false),
    getSetting('fx_last_fetched'),
  ])
  return { currencies, fxLastFetched }
}

async function loadFxRates() {
  const [baseCurrency, rates, pushLog, health] = await Promise.all([
    getBaseCurrencyCode(),
    getLatestFxRates(),
    getFxPushLog(20),
    getFxHealth(),
  ])
  return { baseCurrency, rates, pushLog, health }
}
