'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, X, Check, RefreshCw, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  createCurrency,
  toggleCurrency,
  fetchAllFxRates,
  type CurrencyRow,
} from '@/app/actions/currencies'

type Props = { currencies: CurrencyRow[] }

export function CurrenciesTable({ currencies }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [showAdd, setShowAdd] = useState(false)
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [symbol, setSymbol] = useState('')
  const [error, setError] = useState('')
  const [refreshMsg, setRefreshMsg] = useState('')

  function handleAdd() {
    setError('')
    if (!code.trim() || !name.trim() || !symbol.trim()) {
      setError('All fields are required')
      return
    }
    startTransition(async () => {
      const result = await createCurrency({ code, name, symbol })
      if (result.success) {
        setCode('')
        setName('')
        setSymbol('')
        setShowAdd(false)
        router.refresh()
      } else {
        setError(result.error ?? 'Failed')
      }
    })
  }

  function handleToggle(c: CurrencyRow) {
    startTransition(async () => {
      await toggleCurrency(c.code, !c.active)
      router.refresh()
    })
  }

  function handleRefreshRates() {
    setRefreshMsg('')
    startTransition(async () => {
      const result = await fetchAllFxRates()
      if (result.success) {
        const parts: string[] = []
        if (result.updated.length) parts.push(`Updated: ${result.updated.join(', ')}`)
        if (result.failed.length) parts.push(`Failed: ${result.failed.join(', ')}`)
        setRefreshMsg(parts.join(' · ') || 'No currencies to update')
        router.refresh()
      } else {
        setRefreshMsg(result.error ?? 'Fetch failed')
      }
    })
  }

  // GBP always shown first, then active, then inactive
  const gbp: CurrencyRow = currencies.find((c) => c.code === 'GBP') ?? {
    code: 'GBP', name: 'British Pound', symbol: '£', active: true, latestRate: 1, rateDate: null,
  }
  const others = currencies.filter((c) => c.code !== 'GBP')
  const sorted = [gbp, ...others.filter((c) => c.active), ...others.filter((c) => !c.active)]

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={handleRefreshRates} disabled={isPending}>
          {isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />}
          Refresh FX Rates
        </Button>
        <Button size="sm" onClick={() => setShowAdd(true)} disabled={showAdd}>
          <Plus className="h-3 w-3 mr-1" />
          Add Currency
        </Button>
        {refreshMsg && <span className="text-xs text-muted-foreground ml-2">{refreshMsg}</span>}
      </div>

      {showAdd && (
        <div className="flex items-end gap-2 p-3 rounded-md border bg-muted/30">
          <div className="space-y-1">
            <Label className="text-xs">Code</Label>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 3))}
              placeholder="EUR"
              className="h-8 w-20 font-mono text-sm"
            />
          </div>
          <div className="space-y-1 flex-1">
            <Label className="text-xs">Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Euro"
              className="h-8 text-sm"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Symbol</Label>
            <Input
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.slice(0, 3))}
              placeholder="€"
              className="h-8 w-16 text-sm"
            />
          </div>
          <Button size="sm" className="h-8" onClick={handleAdd} disabled={isPending}>
            {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Add'}
          </Button>
          <Button size="sm" variant="ghost" className="h-8" onClick={() => { setShowAdd(false); setError('') }}>
            Cancel
          </Button>
        </div>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="rounded-md border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/50">
            <tr>
              <th className="px-4 py-2 text-left font-medium text-muted-foreground text-xs">Code</th>
              <th className="px-4 py-2 text-left font-medium text-muted-foreground text-xs">Name</th>
              <th className="px-4 py-2 text-left font-medium text-muted-foreground text-xs">Symbol</th>
              <th className="px-4 py-2 text-right font-medium text-muted-foreground text-xs">Rate (1 GBP =)</th>
              <th className="px-4 py-2 text-left font-medium text-muted-foreground text-xs">Updated</th>
              <th className="px-4 py-2 text-left font-medium text-muted-foreground text-xs">Status</th>
              <th className="w-12" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {sorted.map((c) => (
              <tr key={c.code} className={`hover:bg-muted/30 ${!c.active ? 'opacity-50' : ''}`}>
                <td className="px-4 py-2 font-mono font-medium">{c.code}</td>
                <td className="px-4 py-2">{c.name}</td>
                <td className="px-4 py-2">{c.symbol}</td>
                <td className="px-4 py-2 text-right font-mono text-xs">
                  {c.code === 'GBP' ? '1.0000' : c.latestRate != null ? c.latestRate.toFixed(4) : '—'}
                </td>
                <td className="px-4 py-2 text-muted-foreground text-xs">
                  {c.rateDate
                    ? new Date(c.rateDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
                    : c.code === 'GBP' ? '—' : 'Never'}
                </td>
                <td className="px-4 py-2">
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium border ${
                    c.active
                      ? 'bg-green-100 text-green-800 border-green-200 dark:bg-green-900 dark:text-green-200'
                      : 'bg-muted text-muted-foreground border-border'
                  }`}>
                    {c.active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td className="px-4 py-2">
                  {c.code !== 'GBP' && (
                    <Button
                      variant="ghost" size="sm" className="h-7 w-7 p-0"
                      onClick={() => handleToggle(c)}
                      disabled={isPending}
                    >
                      {c.active
                        ? <X className="h-3 w-3 text-muted-foreground" />
                        : <Check className="h-3 w-3 text-muted-foreground" />}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
