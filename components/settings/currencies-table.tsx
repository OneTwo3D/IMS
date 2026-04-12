'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, X, Check, RefreshCw, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
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
    code: 'GBP', name: 'British Pound', symbol: '£', symbolPosition: 'PREFIX', active: true, latestRate: 1, rateDate: null,
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

      <Table className="rounded-md border">
        <TableHeader className="bg-muted/50">
          <TableRow>
            <TableHead className="text-xs">Code</TableHead>
            <TableHead className="text-xs">Name</TableHead>
            <TableHead className="text-xs">Symbol</TableHead>
            <TableHead className="text-xs text-right">Rate (1 GBP =)</TableHead>
            <TableHead className="text-xs">Updated</TableHead>
            <TableHead className="text-xs">Status</TableHead>
            <TableHead className="w-12" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((c) => (
            <TableRow key={c.code} className={!c.active ? 'opacity-50' : ''}>
              <TableCell className="font-mono font-medium">{c.code}</TableCell>
              <TableCell>{c.name}</TableCell>
              <TableCell>{c.symbol}</TableCell>
              <TableCell className="text-right font-mono text-xs">
                {c.code === 'GBP' ? '1.0000' : c.latestRate != null ? c.latestRate.toFixed(4) : '—'}
              </TableCell>
              <TableCell className="text-muted-foreground text-xs">
                {c.rateDate
                  ? new Date(c.rateDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
                  : c.code === 'GBP' ? '—' : 'Never'}
              </TableCell>
              <TableCell>
                <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium border ${
                  c.active
                    ? 'bg-green-100 text-green-800 border-green-200 dark:bg-green-900 dark:text-green-200'
                    : 'bg-muted text-muted-foreground border-border'
                }`}>
                  {c.active ? 'Active' : 'Inactive'}
                </span>
              </TableCell>
              <TableCell>
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
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
