'use client'

import { useCallback, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft, ArrowRight, Building2, Check, CheckCircle2, Coins, Download, ExternalLink,
  Loader2, Package, Plug, Receipt, Sparkles, TrendingUp, Warehouse,
} from 'lucide-react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { WizardStepper, type StepDef } from '@/components/onboarding/wizard-stepper'
import { CompanyStep, type CompanyStepHandle } from '@/components/onboarding/company-step'
import { CurrencyStep } from '@/components/onboarding/currency-step'
import { IntegrationsStep } from '@/components/onboarding/integrations-step'
import { ProductsStep } from '@/components/onboarding/products-step'
import { CsvImportFlow } from '@/components/ui/csv-import-flow'
import { TaxRatesTable } from '@/components/settings/tax-rates-table'
import { UnifiedTaxRateMapper } from '@/components/settings/unified-tax-rate-mapper'
import { WarehousesTable } from '@/components/settings/warehouses-table'
import { setOnboardingStep, completeOnboarding } from '@/app/actions/onboarding'
import { importOpeningStockCsv } from '@/app/actions/import'
import type { OrganisationData } from '@/app/actions/company'
import type { CurrencyRow } from '@/app/actions/currencies'
import type { TaxRateRow } from '@/app/actions/settings'
import type { WarehouseRow } from '@/app/actions/settings'
import type { IntegrationPluginState } from '@/lib/integration-plugins'
import type { ShoppingConnectorCredentials, ShopifyConnectorCredentials } from '@/app/actions/shopping-sync'
import type { AccountingConnectionStatus, AccountingConnectorSettingsMasked } from '@/app/actions/accounting-sync'
import type { MintsoftOnboardingConnectionData } from '@/app/actions/mintsoft-sync'
import type { EmailSettings } from '@/app/actions/company'
import type { PublicAppUrlInfo } from '@/lib/public-app-url'

const STEPS: StepDef[] = [
  { key: 'welcome', label: 'Welcome', icon: Sparkles, skippable: false },
  { key: 'company', label: 'Company Details', icon: Building2, skippable: false },
  { key: 'currency', label: 'Currency & FY', icon: Coins, skippable: false },
  // audit-wrwr: integrations before tax — provider tax rates can only be imported
  // once WooCommerce/Xero are connected.
  { key: 'integrations', label: 'Integrations', icon: Plug, skippable: true },
  { key: 'tax', label: 'Tax Rates', icon: Receipt, skippable: true },
  { key: 'warehouses', label: 'Warehouses', icon: Warehouse, skippable: true },
  { key: 'products', label: 'Import Products', icon: Package, skippable: true },
  { key: 'opening-stock', label: 'Opening Stock', icon: TrendingUp, skippable: true },
  { key: 'done', label: 'All Done', icon: CheckCircle2, skippable: false },
]

type Props = {
  initialStepKey: string
  org: OrganisationData
  baseCurrencyLocked: boolean
  companyConfigured: boolean
  currencyConfigured: boolean
  currencies: CurrencyRow[]
  taxRates: TaxRateRow[]
  warehouses: WarehouseRow[]
  financialYearStart: string
  pluginState: IntegrationPluginState
  productCount: number
  wcCredentials: ShoppingConnectorCredentials
  shopifyCredentials: ShopifyConnectorCredentials
  accountingSettings: AccountingConnectorSettingsMasked
  accountingStatus: AccountingConnectionStatus
  mintsoftConnection: MintsoftOnboardingConnectionData
  emailSettings: EmailSettings
  publicAppUrlInfo: PublicAppUrlInfo
  suggestedPublicAppUrl: string | null
  testEmailDefault: string
}

export function OnboardingClient({
  initialStepKey,
  org,
  baseCurrencyLocked,
  companyConfigured: initialCompanyConfigured,
  currencyConfigured: initialCurrencyConfigured,
  currencies,
  taxRates,
  warehouses,
  financialYearStart,
  pluginState: initialPluginState,
  productCount,
  wcCredentials,
  shopifyCredentials,
  accountingSettings,
  accountingStatus,
  mintsoftConnection,
  emailSettings,
  publicAppUrlInfo,
  suggestedPublicAppUrl,
  testEmailDefault,
}: Props) {
  const router = useRouter()
  const companyStepRef = useRef<CompanyStepHandle | null>(null)
  // audit-wrwr: resume by step KEY (reorder-proof); unknown/legacy → start at 0.
  const initialStep = Math.max(0, STEPS.findIndex((s) => s.key === initialStepKey))
  const [step, setStep] = useState(initialStep)
  const [completedSteps, setCompletedSteps] = useState<Set<string>>(() => {
    const set = new Set<string>()
    // Mark prior steps as visited if resuming
    for (let i = 0; i < initialStep; i++) set.add(STEPS[i].key)
    return set
  })
  const [pluginDraft, setPluginDraft] = useState<{ base: IntegrationPluginState; value: IntegrationPluginState } | null>(null)
  const [companyConfiguredOverride, setCompanyConfiguredOverride] = useState<{ base: boolean; value: boolean } | null>(null)
  const [currencyConfiguredOverride, setCurrencyConfiguredOverride] = useState<{ base: boolean; value: boolean } | null>(null)
  const [integrationsReadyOverride, setIntegrationsReadyOverride] = useState<boolean | null>(null)
  const [integrationConnectedOverride, setIntegrationConnectedOverride] = useState<{
    wc: boolean | null
    shopify: boolean | null
    accounting: boolean | null
    mintsoft: boolean | null
  }>({
    wc: null,
    shopify: null,
    accounting: null,
    mintsoft: null,
  })
  const [finishing, setFinishing] = useState(false)
  const [finishError, setFinishError] = useState('')
  const [companyStepDirty, setCompanyStepDirty] = useState(false)
  const [taxTouched, setTaxTouched] = useState(false)
  const [warehousesTouched, setWarehousesTouched] = useState(false)
  const [productsImported, setProductsImported] = useState(productCount > 0)
  const [stockImported, setStockImported] = useState(false)
  const [nextPending, setNextPending] = useState(false)

  const plugins = pluginDraft?.base === initialPluginState ? pluginDraft.value : initialPluginState
  const companyConfigured = companyConfiguredOverride?.base === initialCompanyConfigured
    ? companyConfiguredOverride.value
    : initialCompanyConfigured
  const currencyConfigured = currencyConfiguredOverride?.base === initialCurrencyConfigured
    ? currencyConfiguredOverride.value
    : initialCurrencyConfigured

  const currentStepDef = STEPS[step]
  const isFirst = step === 0
  const isLast = step === STEPS.length - 1

  function markComplete(key: string) {
    setCompletedSteps((prev) => new Set(prev).add(key))
  }

  const wcConnected = integrationConnectedOverride.wc ?? (!!wcCredentials.url && !!wcCredentials.key && !!wcCredentials.secretMasked)
  const shopifyConnected = integrationConnectedOverride.shopify ?? (!!shopifyCredentials.storeDomain && !!shopifyCredentials.accessTokenMasked)
  const accountingConnected = integrationConnectedOverride.accounting ?? accountingStatus.connected
  const mintsoftConnected = integrationConnectedOverride.mintsoft ?? mintsoftConnection.status.configured
  const hasTaxRates = taxRates.some((rate) => rate.active)
  const anyIntegrationsEnabled = plugins.woocommerce || plugins.shopify || plugins.xero || plugins.quickbooks || plugins.mintsoft
  const hasAdditionalWarehouses = warehouses.length > 1

  function isStepReady(index: number) {
    const key = STEPS[index]?.key
    if (key === 'company') return companyConfigured || companyStepDirty
    if (key === 'currency') return currencyConfigured
    if (key === 'tax') return hasTaxRates || taxTouched
    if (key === 'integrations') {
      if (integrationsReadyOverride != null) return integrationsReadyOverride
      if (!anyIntegrationsEnabled) return false
      if (plugins.woocommerce && !wcConnected) return false
      if (plugins.shopify && !shopifyConnected) return false
      if ((plugins.xero || plugins.quickbooks) && !accountingConnected) return false
      if (plugins.mintsoft && !mintsoftConnected) return false
      return true
    }
    if (key === 'warehouses') return hasAdditionalWarehouses || warehousesTouched
    if (key === 'products') return productsImported
    if (key === 'opening-stock') return stockImported
    return true
  }

  function canAdvanceFromCurrentStep() {
    return isStepReady(step)
  }

  function canAccessStep(index: number) {
    if (index === step) return true
    if (index < step) return true
    if (index === step + 1) return canAdvanceFromCurrentStep()
    return STEPS.slice(0, index).every((_, priorIndex) => completedSteps.has(STEPS[priorIndex].key))
  }

  async function persistCurrentStepBeforeAdvance(targetIndex: number) {
    if (targetIndex <= step) return true
    if (STEPS[step].key !== 'company' || (companyConfigured && !companyStepDirty)) return true

    const saved = await companyStepRef.current?.save()
    return Boolean(saved)
  }

  async function goTo(index: number, opts?: { force?: boolean }) {
    if (!opts?.force && !canAccessStep(index)) return
    const canLeaveCurrentStep = await persistCurrentStepBeforeAdvance(index)
    if (!canLeaveCurrentStep) return

    // Mark current step as visited
    markComplete(STEPS[step].key)
    setStep(index)
    await setOnboardingStep(STEPS[index].key)
  }

  async function handleNext() {
    setNextPending(true)
    try {
      const nextStep = Math.min(step + 1, STEPS.length - 1)
      await goTo(nextStep)
    } finally {
      setNextPending(false)
    }
  }

  async function handleSkip() {
    await goTo(Math.min(step + 1, STEPS.length - 1), { force: true })
  }

  async function handleBack() {
    await goTo(Math.max(step - 1, 0))
  }

  const handleCompanyDirtyChange = useCallback((dirty: boolean) => {
    setCompanyStepDirty(dirty)
  }, [])

  const handlePluginStateChange = useCallback((nextPlugins: IntegrationPluginState) => {
    setPluginDraft({ base: initialPluginState, value: nextPlugins })
  }, [initialPluginState])

  const handleIntegrationConnectionStateChange = useCallback((updates: {
    wc?: boolean
    shopify?: boolean
    accounting?: boolean
    mintsoft?: boolean
  }) => {
    setIntegrationConnectedOverride((prev) => ({
      wc: updates.wc ?? prev.wc,
      shopify: updates.shopify ?? prev.shopify,
      accounting: updates.accounting ?? prev.accounting,
      mintsoft: updates.mintsoft ?? prev.mintsoft,
    }))
  }, [])

  function downloadOpeningStockTemplate() {
    // Columns accepted by importOpeningStockCsv (app/actions/import.ts) + one
    // illustrative row the user replaces with their data.
    const header = 'sku,warehouseCode,qty,unitCostBase,note'
    const example = 'SKU-001,MAIN,100,12.50,Opening balance'
    const blob = new Blob([`${header}\n${example}\n`], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'opening-stock-template.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  async function handleFinish() {
    setFinishing(true)
    setFinishError('')
    const result = await completeOnboarding()
    if (!result.success) {
      setFinishError(result.error ?? 'Failed to complete onboarding.')
      setFinishing(false)
      return
    }
    markComplete('done')
    router.push('/dashboard')
  }

  const shoppingEnabled = plugins.woocommerce || plugins.shopify
  const accountingEnabled = plugins.xero || plugins.quickbooks

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex flex-col lg:flex-row gap-6">
        {/* Left rail — stepper */}
        <aside className="lg:w-56 shrink-0">
          <div className="lg:sticky lg:top-6">
            <WizardStepper
              steps={STEPS}
              currentStep={step}
              completedSteps={completedSteps}
              isStepAccessible={canAccessStep}
              onStepClick={goTo}
            />
          </div>
        </aside>

        {/* Main content */}
        <div className="flex-1 min-w-0">
          <Card className="p-6">
            {/* Step 0: Welcome */}
            {currentStepDef.key === 'welcome' && (
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
                    <Sparkles className="h-5 w-5 text-primary" />
                  </div>
                  <h2 className="text-xl font-semibold">Welcome to One Two Inventory</h2>
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  This setup wizard will guide you through the initial configuration of your inventory
                  management system. You&apos;ll set up your company details, currency, tax rates,
                  integrations, warehouses, and optionally import your product catalog.
                </p>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  Each step saves independently — you can leave and return at any time. Optional
                  steps can be skipped and configured later from Settings.
                </p>
                <Button onClick={handleNext} className="mt-2">
                  Get Started <ArrowRight className="h-4 w-4 ml-2" />
                </Button>
              </div>
            )}

            {/* Step 1: Company Details */}
            {currentStepDef.key === 'company' && (
              <CompanyStep
                ref={companyStepRef}
                org={org}
                emailSettings={emailSettings}
                publicAppUrlInfo={publicAppUrlInfo}
                suggestedPublicAppUrl={suggestedPublicAppUrl}
                testEmailDefault={testEmailDefault}
                onDirtyChange={handleCompanyDirtyChange}
                onSaved={() => {
                  setCompanyConfiguredOverride({ base: initialCompanyConfigured, value: true })
                  setCompanyStepDirty(false)
                  markComplete('company')
                }}
              />
            )}

            {/* Step 2: Currency & Financial Year */}
            {currentStepDef.key === 'currency' && (
              <CurrencyStep
                baseCurrency={org.baseCurrency}
                baseCurrencyLocked={baseCurrencyLocked}
                currencies={currencies}
                financialYearStart={financialYearStart}
                onSaved={() => {
                  setCurrencyConfiguredOverride({ base: initialCurrencyConfigured, value: true })
                  markComplete('currency')
                }}
              />
            )}

            {/* Step 3: Tax Rates */}
            {currentStepDef.key === 'tax' && (
              <div className="space-y-4">
                <div>
                  <h2 className="text-lg font-semibold">Tax Rates</h2>
                  <p className="text-sm text-muted-foreground mt-1">
                    Review the pre-configured tax rates below. Add, edit, or remove rates as needed,
                    then map them to your WooCommerce and Xero tax rates.
                  </p>
                </div>
                <TaxRatesTable taxRates={taxRates} onChanged={() => setTaxTouched(true)} />
                <UnifiedTaxRateMapper
                  context="onboarding"
                  wcConnected={plugins.woocommerce && wcConnected}
                  accountingConnected={plugins.xero && accountingConnected}
                  onChanged={() => setTaxTouched(true)}
                />
              </div>
            )}

            {/* Step 4: Integrations */}
            {currentStepDef.key === 'integrations' && (
              <IntegrationsStep
                pluginState={plugins}
                wcCredentials={wcCredentials}
                shopifyCredentials={shopifyCredentials}
                accountingSettings={accountingSettings}
                accountingStatus={accountingStatus}
                mintsoftConnection={mintsoftConnection}
                publicAppUrlInfo={publicAppUrlInfo}
                onPluginStateChange={handlePluginStateChange}
                onConnectionStateChange={handleIntegrationConnectionStateChange}
                onReadyChange={setIntegrationsReadyOverride}
              />
            )}

            {/* Step 5: Warehouses */}
            {currentStepDef.key === 'warehouses' && (
              <div className="space-y-4">
                <div>
                  <h2 className="text-lg font-semibold">Warehouses</h2>
                  <p className="text-sm text-muted-foreground mt-1">
                    Review your default warehouse and add additional locations if you store
                    inventory in multiple places.
                  </p>
                </div>
                <WarehousesTable warehouses={warehouses} showStoreSync={false} onChanged={() => setWarehousesTouched(true)} />
              </div>
            )}

            {/* Step 6: Import Products */}
            {currentStepDef.key === 'products' && (
              <ProductsStep
                shoppingConnectorEnabled={shoppingEnabled}
                wcEnabled={plugins.woocommerce}
                wcConnected={wcConnected}
                shopifyEnabled={plugins.shopify}
                shopifyConnected={shopifyConnected}
                productCount={productCount}
                onImported={() => setProductsImported(true)}
              />
            )}

            {/* Step 7: Opening Stock */}
            {currentStepDef.key === 'opening-stock' && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-lg font-semibold">Opening Stock</h2>
                  <p className="text-sm text-muted-foreground mt-1">
                    Import your current stock levels and unit costs. This sets up FIFO cost layers
                    so cost-of-goods calculations are accurate from day one.
                  </p>
                </div>

                {stockImported && (
                  <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">
                    <Check className="h-4 w-4 shrink-0" />
                    <p>Opening stock imported successfully.</p>
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-3">
                  <Button variant="ghost" onClick={downloadOpeningStockTemplate}>
                    <Download className="h-4 w-4 mr-2" />
                    Download template
                  </Button>
                  <CsvImportFlow action={importOpeningStockCsv} onDone={() => setStockImported(true)}>
                    {({ busy, openFilePicker }) => (
                      <Button variant="outline" onClick={openFilePicker} disabled={busy}>
                        <TrendingUp className="h-4 w-4 mr-2" />
                        {busy ? 'Importing...' : 'Import Opening Stock CSV'}
                      </Button>
                    )}
                  </CsvImportFlow>
                </div>

                <p className="text-xs text-muted-foreground">
                  Download the template, fill in one row per SKU/warehouse — columns:
                  <code className="mx-1">sku</code>, <code className="mx-1">warehouseCode</code>,
                  <code className="mx-1">qty</code>, <code className="mx-1">unitCostBase</code> (cost per unit in your
                  base currency), and an optional <code className="mx-1">note</code> — then import it. Products and
                  warehouses must exist first; replace the example row.
                </p>
              </div>
            )}

            {/* Step 8: Done */}
            {currentStepDef.key === 'done' && (
              <div className="space-y-6">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-full bg-green-100 flex items-center justify-center">
                    <CheckCircle2 className="h-5 w-5 text-green-600" />
                  </div>
                  <h2 className="text-xl font-semibold">Setup Complete</h2>
                </div>

                <p className="text-sm text-muted-foreground leading-relaxed">
                  Your system is configured and ready to use. You can always adjust these settings
                  later from the Settings pages.
                </p>

                {/* Summary */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {STEPS.slice(1, -1).map((s) => (
                    <div key={s.key} className="flex items-center gap-2 text-sm">
                      {completedSteps.has(s.key) ? (
                        <Check className="h-4 w-4 text-green-600 shrink-0" />
                      ) : (
                        <span className="h-4 w-4 rounded-full border border-muted-foreground/30 shrink-0" />
                      )}
                      <span className={completedSteps.has(s.key) ? '' : 'text-muted-foreground'}>
                        {s.label}
                      </span>
                    </div>
                  ))}
                </div>

                {/* Integration follow-up reminders */}
                {(shoppingEnabled || accountingEnabled) && (
                  <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 space-y-2">
                    <h3 className="text-sm font-medium text-blue-900">Next Steps for Integrations</h3>
                    <ul className="text-sm text-blue-800 space-y-1.5">
                      {shoppingEnabled && (
                        <li className="flex items-start gap-2">
                          <ArrowRight className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                          <span>
                            Configure tax rate mapping and order status mapping in{' '}
                            <Link href="/sync" className="font-medium hover:underline inline-flex items-center gap-0.5">
                              Integrations <ExternalLink className="h-3 w-3" />
                            </Link>
                          </span>
                        </li>
                      )}
                      {accountingEnabled && !accountingStatus.connected && (
                        <li className="flex items-start gap-2">
                          <ArrowRight className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                          <span>
                            Complete the {plugins.quickbooks ? 'QuickBooks' : 'Xero'} OAuth connection in{' '}
                            <Link href="/sync" className="font-medium hover:underline inline-flex items-center gap-0.5">
                              Integrations <ExternalLink className="h-3 w-3" />
                            </Link>
                          </span>
                        </li>
                      )}
                      {accountingEnabled && accountingStatus.connected && (
                        <li className="flex items-start gap-2">
                          <ArrowRight className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                          <span>
                            Sync chart of accounts and complete account mapping in{' '}
                            <Link href="/sync" className="font-medium hover:underline inline-flex items-center gap-0.5">
                              Integrations <ExternalLink className="h-3 w-3" />
                            </Link>
                          </span>
                        </li>
                      )}
                    </ul>
                  </div>
                )}

                {finishError && <p className="text-sm text-destructive">{finishError}</p>}

                <Button onClick={handleFinish} disabled={finishing} size="lg">
                  {finishing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                  Go to Dashboard
                </Button>
              </div>
            )}
          </Card>

          {/* Navigation buttons */}
          {!isFirst && !isLast && (
            <div className="flex items-center justify-between mt-4">
              <Button variant="ghost" onClick={handleBack} disabled={isFirst}>
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back
              </Button>

              <div className="flex items-center gap-2">
                {currentStepDef.skippable && (
                  <Button variant="ghost" onClick={handleSkip}>
                    Skip
                  </Button>
                )}
                <Button onClick={handleNext} disabled={isLast || nextPending || !canAdvanceFromCurrentStep()}>
                  {nextPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                  Next
                  <ArrowRight className="h-4 w-4 ml-2" />
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
