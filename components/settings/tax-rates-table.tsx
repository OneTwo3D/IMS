'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Pencil, X, Check, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { createTaxRate, updateTaxRate, type TaxRateRow } from '@/app/actions/settings'

type Props = { taxRates: TaxRateRow[] }

const USED_FOR_LABELS: Record<string, string> = {
  SALES: 'Sales',
  PURCHASE: 'Purchases',
  BOTH: 'Both',
}

function TaxRateFormDialog({
  rate,
  onClose,
}: {
  rate: TaxRateRow | null
  onClose: () => void
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [name, setName] = useState(rate?.name ?? '')
  const [rateVal, setRateVal] = useState(rate ? (rate.rate * 100).toFixed(2) : '')
  const [usedFor, setUsedFor] = useState(rate?.usedFor ?? 'BOTH')
  const [xeroTaxType, setXeroTaxType] = useState(rate?.xeroTaxType ?? '')
  const [error, setError] = useState('')

  function handleSave() {
    setError('')
    if (!name.trim()) { setError('Name is required'); return }
    const pct = parseFloat(rateVal)
    if (isNaN(pct) || pct < 0 || pct > 100) { setError('Rate must be between 0 and 100'); return }

    startTransition(async () => {
      const result = rate
        ? await updateTaxRate(rate.id, { name, rate: pct / 100, usedFor, xeroTaxType })
        : await createTaxRate({ name, rate: pct / 100, usedFor, xeroTaxType })

      if (result.success) {
        router.refresh()
        onClose()
      } else {
        setError(result.error ?? 'Save failed')
      }
    })
  }

  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent showCloseButton={false} className="max-w-md sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{rate ? 'Edit VAT Rate' : 'New VAT Rate'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <div className="space-y-1.5">
            <Label>Name *</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. UK Standard Rate" className="h-9" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Rate (%)</Label>
              <Input
                type="number" min="0" max="100" step="0.01"
                value={rateVal}
                onChange={(e) => setRateVal(e.target.value)}
                placeholder="20.00"
                className="h-9 font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Applies To</Label>
              <select
                value={usedFor}
                onChange={(e) => setUsedFor(e.target.value)}
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="BOTH">Sales &amp; Purchases</option>
                <option value="SALES">Sales only</option>
                <option value="PURCHASE">Purchases only</option>
              </select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Xero Tax Type Code</Label>
            <Input
              value={xeroTaxType}
              onChange={(e) => setXeroTaxType(e.target.value)}
              placeholder="e.g. OUTPUT2, INPUT2"
              className="h-9 font-mono"
            />
            <p className="text-xs text-muted-foreground">Used when syncing invoices to Xero</p>
          </div>

          {error && <p className="text-destructive text-sm">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isPending}>Cancel</Button>
          <Button onClick={handleSave} disabled={isPending}>
            {isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {rate ? 'Save Changes' : 'Create Rate'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function TaxRatesTable({ taxRates }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [editing, setEditing] = useState<TaxRateRow | null | undefined>(undefined)

  function handleToggle(rate: TaxRateRow) {
    startTransition(async () => {
      await updateTaxRate(rate.id, { active: !rate.active })
      router.refresh()
    })
  }

  const salesRates = taxRates.filter((r) => r.usedFor === 'SALES' || r.usedFor === 'BOTH')
  const purchaseRates = taxRates.filter((r) => r.usedFor === 'PURCHASE' || r.usedFor === 'BOTH')
  const sections = [
    { title: 'Sales VAT Rates', rates: salesRates },
    { title: 'Purchase VAT Rates', rates: purchaseRates },
  ]

  // Deduplicate: if a rate is BOTH, it appears in both sections. Show a flat list instead if all are BOTH.
  const allBoth = taxRates.every((r) => r.usedFor === 'BOTH')

  function renderTable(rates: TaxRateRow[]) {
    if (rates.length === 0) return <p className="text-sm text-muted-foreground py-2">No rates defined.</p>
    return (
      <div className="rounded-md border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/50">
            <tr>
              <th className="px-4 py-2 text-left font-medium text-muted-foreground text-xs">Name</th>
              <th className="px-4 py-2 text-right font-medium text-muted-foreground text-xs">Rate</th>
              {!allBoth && <th className="px-4 py-2 text-left font-medium text-muted-foreground text-xs">Applies To</th>}
              <th className="px-4 py-2 text-left font-medium text-muted-foreground text-xs">Xero Code</th>
              <th className="px-4 py-2 text-left font-medium text-muted-foreground text-xs">Status</th>
              <th className="w-16" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {rates.map((r) => (
              <tr key={r.id} className={`hover:bg-muted/30 ${!r.active ? 'opacity-50' : ''}`}>
                <td className="px-4 py-2 font-medium">{r.name}</td>
                <td className="px-4 py-2 text-right font-mono text-xs">{(r.rate * 100).toFixed(2)}%</td>
                {!allBoth && <td className="px-4 py-2 text-xs text-muted-foreground">{USED_FOR_LABELS[r.usedFor] ?? r.usedFor}</td>}
                <td className="px-4 py-2 font-mono text-xs text-muted-foreground">{r.xeroTaxType ?? '—'}</td>
                <td className="px-4 py-2">
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium border ${
                    r.active
                      ? 'bg-green-100 text-green-800 border-green-200 dark:bg-green-900 dark:text-green-200'
                      : 'bg-muted text-muted-foreground border-border'
                  }`}>
                    {r.active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td className="px-4 py-2">
                  <div className="flex items-center gap-1 justify-end">
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setEditing(r)}>
                      <Pencil className="h-3 w-3" />
                    </Button>
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => handleToggle(r)} disabled={isPending}>
                      {r.active ? <X className="h-3 w-3 text-muted-foreground" /> : <Check className="h-3 w-3 text-muted-foreground" />}
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setEditing(null)}>
          <Plus className="h-3 w-3 mr-1" />Add VAT Rate
        </Button>
      </div>

      {allBoth ? (
        renderTable(taxRates)
      ) : (
        sections.map((s) => (
          <div key={s.title} className="space-y-2">
            <h3 className="text-sm font-medium text-muted-foreground">{s.title}</h3>
            {renderTable(s.rates)}
          </div>
        ))
      )}

      {editing !== undefined && (
        <TaxRateFormDialog rate={editing} onClose={() => setEditing(undefined)} />
      )}
    </div>
  )
}
