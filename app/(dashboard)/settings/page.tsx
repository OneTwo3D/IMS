import type { Metadata } from 'next'
import { SlidersHorizontal, Coins, Ship, Receipt, PackageOpen, FileText, RotateCcw } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { getAdjustmentReasons, getSetting, getTaxRates, getPurchaseUnits } from '@/app/actions/settings'
import { getCurrencies } from '@/app/actions/currencies'
import { AdjustmentReasonsTable } from '@/components/settings/adjustment-reasons-table'
import { CurrenciesTable } from '@/components/settings/currencies-table'
import { LandedCostMethodSetting } from '@/components/settings/landed-cost-method'
import { TaxRatesTable } from '@/components/settings/tax-rates-table'
import { PurchaseUnitsTable } from '@/components/settings/purchase-units-table'
import { InvoiceTriggerSetting } from '@/components/settings/invoice-trigger'
import { DatabaseReset } from '@/components/settings/database-reset'

export const metadata: Metadata = { title: 'Settings' }

export default async function SettingsPage() {
  const [reasons, currencies, landedCostMethod, taxRates, purchaseUnits, invoiceTrigger] = await Promise.all([
    getAdjustmentReasons(),
    getCurrencies(false),
    getSetting('default_landed_cost_method'),
    getTaxRates(false),
    getPurchaseUnits(false),
    getSetting('invoice_trigger'),
  ])

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Configure system-wide options.
        </p>
      </div>

      {/* VAT Rates */}
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

      {/* Purchase Units */}
      <Card className="p-6">
        <div className="flex items-center gap-2 mb-4">
          <PackageOpen className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">Purchase Units</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          Define purchase packaging units and their conversion to stock units. For example,
          if you buy wire in 1 km rolls but stock it in metres, create a unit with conversion
          factor 1000.
        </p>
        <PurchaseUnitsTable units={purchaseUnits} />
      </Card>

      {/* Currencies */}
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

      {/* Invoice Generation */}
      <Card className="p-6">
        <div className="flex items-center gap-2 mb-4">
          <FileText className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">Invoice Generation</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          Configure when sales order invoices are automatically generated.
        </p>
        <InvoiceTriggerSetting currentValue={invoiceTrigger ?? 'manual'} />
      </Card>

      {/* Landed Cost Method */}
      <Card className="p-6">
        <div className="flex items-center gap-2 mb-4">
          <Ship className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">Landed Cost Distribution</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          Default method for distributing additional costs (shipping, customs, fees) across
          purchase order line items. This can be overridden per PO.
        </p>
        <LandedCostMethodSetting currentMethod={landedCostMethod ?? 'BY_VALUE'} />
      </Card>

      {/* Adjustment Reasons */}
      <Card className="p-6">
        <div className="flex items-center gap-2 mb-4">
          <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">Stock Adjustment Reasons</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          Define selectable reasons for stock adjustments. Each reason can be linked to a specific
          Xero account code — when set, adjustments using that reason will post to that account
          instead of the default inventory adjustment account.
        </p>
        <AdjustmentReasonsTable reasons={reasons} />
      </Card>

      {/* Database Reset */}
      <Card className="p-6 border-destructive/30">
        <div className="flex items-center gap-2 mb-4">
          <RotateCcw className="h-4 w-4 text-destructive" />
          <h2 className="text-base font-semibold text-destructive">Database Reset</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          Reset parts of the database. This is useful for clearing test data before going live,
          or for starting fresh. User accounts are always preserved.
        </p>
        <DatabaseReset />
      </Card>
    </div>
  )
}
