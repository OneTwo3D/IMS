'use client'

import { useState, useTransition } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { updateOrganisation } from '@/app/actions/company'
import { FinancialYearStartSetting } from '@/components/settings/financial-year-start'
import type { CurrencyRow } from '@/app/actions/currencies'

type Props = {
  baseCurrency: string
  baseCurrencyLocked: boolean
  currencies: CurrencyRow[]
  financialYearStart: string
  onSaved: () => void
}

export function CurrencyStep({ baseCurrency: initialCurrency, baseCurrencyLocked, currencies, financialYearStart, onSaved }: Props) {
  const [isPending, startTransition] = useTransition()
  const [currency, setCurrency] = useState(initialCurrency)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  function handleSaveCurrency() {
    if (currency === initialCurrency) {
      setSaved(true)
      onSaved()
      setTimeout(() => setSaved(false), 2000)
      return
    }
    setError('')
    setSaved(false)
    startTransition(async () => {
      const result = await updateOrganisation({ baseCurrency: currency })
      if (!result.success) {
        setError(result.error ?? 'Failed to save')
        return
      }
      setSaved(true)
      onSaved()
      setTimeout(() => setSaved(false), 2000)
    })
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Currency &amp; Financial Year</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Set your base currency and financial year start date. Additional currencies for purchasing and sales can be added later in Settings.
        </p>
      </div>

      {/* Base Currency */}
      <div className="space-y-3">
        <Label className="text-sm font-medium">Base Currency</Label>
        {baseCurrencyLocked ? (
          <div className="flex items-start gap-2 rounded-lg border border-orange-200 bg-orange-50 p-3 text-sm text-orange-800">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <p>
              Base currency is locked to <strong>{initialCurrency}</strong> because transactions already exist.
              Reset the database to change it.
            </p>
          </div>
        ) : (
          <>
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm w-full max-w-xs"
            >
              {currencies.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} — {c.name} ({c.symbol})
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              This cannot be changed after the first transaction is recorded.
            </p>
          </>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        {!baseCurrencyLocked && (
          <Button onClick={handleSaveCurrency} disabled={isPending} size="sm">
            {isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            {saved ? 'Saved' : 'Save Currency'}
          </Button>
        )}
      </div>

      {/* Financial Year Start */}
      <div className="space-y-3 pt-2 border-t">
        <Label className="text-sm font-medium">Financial Year Start</Label>
        <p className="text-xs text-muted-foreground">
          This determines when your financial year begins for reporting and analytics.
        </p>
        <FinancialYearStartSetting currentValue={financialYearStart} />
      </div>
    </div>
  )
}
