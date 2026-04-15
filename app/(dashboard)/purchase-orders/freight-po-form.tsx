'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { X, Plus, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { createFreightPo } from '@/app/actions/purchase-orders'
import type { SupplierRow } from '@/app/actions/suppliers'
import type { CurrencyRow } from '@/app/actions/currencies'
import type { TaxRateRow } from '@/app/actions/settings'
import { formatMoney } from '@/lib/utils'
import { useBaseCurrency } from '@/components/providers/base-currency-provider'

type GoodsPo = { id: string; reference: string; supplierName: string; totalForeign: number; currency: string }

type Props = {
  suppliers: SupplierRow[]
  currencies: CurrencyRow[]
  taxRates: TaxRateRow[]
  goodsPos: GoodsPo[]
  onClose: () => void
}

type CostLine = {
  key: string
  description: string
  amountForeign: number
  vatable: boolean
  distributionMethod: string
}

function makeKey() { return Math.random().toString(36).slice(2) }

export function FreightPoDialog({ suppliers, currencies, taxRates, goodsPos, onClose }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const baseCurrency = useBaseCurrency()

  const [supplierId, setSupplierId] = useState('')
  const [currency, setCurrency] = useState(baseCurrency.code)
  const [fxRate, setFxRate] = useState(1)
  const [supplierRef, setSupplierRef] = useState('')
  const [notes, setNotes] = useState('')
  const [taxRateId, setTaxRateId] = useState('')

  const [selectedPoIds, setSelectedPoIds] = useState<string[]>([])
  const [costLines, setCostLines] = useState<CostLine[]>([])
  const [error, setError] = useState('')

  const selectedTaxRate = taxRates.find((t) => t.id === taxRateId)
  const vatRate = selectedTaxRate?.rate ?? 0

  const symbolMap: Record<string, string> = { [baseCurrency.code]: baseCurrency.symbol }
  const positionMap: Record<string, 'PREFIX' | 'POSTFIX'> = { [baseCurrency.code]: baseCurrency.symbolPosition }
  for (const c of currencies) {
    symbolMap[c.code] = c.symbol
    positionMap[c.code] = c.symbolPosition
  }
  const sym = symbolMap[currency] ?? currency
  const symPos = positionMap[currency] ?? 'PREFIX'
  const money = (n: number) => formatMoney(n, sym, symPos)

  const rateMap: Record<string, number> = { [baseCurrency.code]: 1 }
  for (const c of currencies) if (c.latestRate != null) rateMap[c.code] = c.latestRate

  function setCurrencyAndRate(code: string) {
    setCurrency(code)
    if (code === baseCurrency.code) setFxRate(1)
    else if (rateMap[code]) setFxRate(rateMap[code])
  }

  function handleSupplierChange(id: string) {
    setSupplierId(id)
    const s = suppliers.find((sup) => sup.id === id)
    if (s) setCurrencyAndRate(s.currency)
  }

  function togglePo(id: string) {
    setSelectedPoIds((prev) => prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id])
  }

  const subtotal = costLines.reduce((s, cl) => s + cl.amountForeign, 0)
  const vatTotal = costLines.reduce((s, cl) => cl.vatable && vatRate > 0 ? s + cl.amountForeign * vatRate : s, 0)
  const grandTotal = subtotal + vatTotal

  function handleSubmit() {
    setError('')
    if (!supplierId) { setError('Select a supplier'); return }
    if (!costLines.length) { setError('Add at least one cost line'); return }
    if (!selectedPoIds.length) { setError('Link to at least one primary PO'); return }

    startTransition(async () => {
      const result = await createFreightPo({
        supplierId,
        currency,
        fxRateToBase: fxRate,
        primaryPoIds: selectedPoIds,
        supplierRef: supplierRef || undefined,
        notes: notes || undefined,
        taxRateValue: vatRate,
        costLines: costLines.filter((cl) => cl.amountForeign > 0).map((cl) => ({
          description: cl.description,
          amountForeign: cl.amountForeign,
          vatable: cl.vatable,
          distributionMethod: cl.distributionMethod,
        })),
      })
      if (result.success) {
        router.refresh()
        if (result.po) router.push(`/purchase-orders/${result.po.id}`)
        onClose()
      } else {
        setError(result.error ?? 'Failed to create landed cost PO')
      }
    })
  }

  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent showCloseButton={false} className="w-[95vw] sm:w-[80vw] max-w-[95vw] sm:max-w-[80vw]">
        <DialogHeader>
          <DialogTitle>New Landed Cost PO</DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          {/* Header */}
          <div className="rounded-md border p-4 space-y-4">
            <h2 className="font-medium text-sm text-muted-foreground uppercase tracking-wide">Freight / Landed Cost Details</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 *:min-w-0">
              <div className="space-y-1.5">
                <Label>Supplier (e.g. FedEx, DHL) *</Label>
                <select
                  value={supplierId}
                  onChange={(e) => handleSupplierChange(e.target.value)}
                  className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">Select supplier…</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label>Currency / FX Rate</Label>
                <div className="flex gap-2">
                  <select
                    value={currency}
                    onChange={(e) => setCurrencyAndRate(e.target.value)}
                    className="w-28 h-9 rounded-md border border-input bg-background px-3 text-sm font-mono"
                  >
                    <option value={baseCurrency.code}>{baseCurrency.code} {baseCurrency.symbol}</option>
                    {currencies.filter((c) => c.code !== baseCurrency.code).map((c) => (
                      <option key={c.code} value={c.code}>{c.code} {c.symbol}</option>
                    ))}
                  </select>
                  <div className="flex-1 relative">
                    <span className="absolute left-3 top-2 text-xs text-muted-foreground">1 {baseCurrency.code} =</span>
                    <Input
                      type="number" min="0.0001" step="0.0001"
                      value={fxRate}
                      onChange={(e) => setFxRate(Number(e.target.value) || 1)}
                      className="pl-16 h-9 font-mono text-sm"
                      disabled={currency === baseCurrency.code}
                    />
                  </div>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>VAT Rate</Label>
                <select
                  value={taxRateId}
                  onChange={(e) => setTaxRateId(e.target.value)}
                  className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">No VAT</option>
                  {taxRates.filter((t) => t.usedFor === 'PURCHASE' || t.usedFor === 'BOTH').map((t) => (
                    <option key={t.id} value={t.id}>{t.name} ({(t.rate * 100).toFixed(0)}%)</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label>Supplier Reference</Label>
                <Input value={supplierRef} onChange={(e) => setSupplierRef(e.target.value)} placeholder="Invoice/tracking ref" className="h-9 text-sm" />
              </div>
              <div className="space-y-1.5 col-span-2">
                <Label>Notes</Label>
                <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={1} className="text-sm resize-none" />
              </div>
            </div>
          </div>

          {/* Linked Primary POs */}
          <div className="rounded-md border p-4 space-y-3">
            <h2 className="font-medium text-sm text-muted-foreground uppercase tracking-wide">Link to Primary PO(s) *</h2>
            <p className="text-xs text-muted-foreground">Select one or more goods POs that this landed cost applies to:</p>
            {goodsPos.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">No confirmed goods POs available for linking.</p>
            ) : (
              <div className="max-h-48 overflow-y-auto border rounded-md divide-y">
                {goodsPos.map((gp) => (
                  <label key={gp.id} className="flex items-center gap-3 px-3 py-2 hover:bg-muted/30 cursor-pointer text-sm">
                    <input
                      type="checkbox"
                      checked={selectedPoIds.includes(gp.id)}
                      onChange={() => togglePo(gp.id)}
                      className="rounded border-input"
                    />
                    <span className="font-mono text-xs font-medium w-36">{gp.reference}</span>
                    <span className="text-muted-foreground flex-1 truncate">{gp.supplierName}</span>
                    <span className="font-mono text-xs">{gp.totalForeign.toFixed(2)} {gp.currency}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* Cost Lines */}
          <div className="rounded-md border p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="font-medium text-sm text-muted-foreground uppercase tracking-wide">Cost Lines</h2>
              <Button
                variant="outline" size="sm"
                onClick={() => setCostLines((prev) => [...prev, { key: makeKey(), description: '', amountForeign: 0, vatable: false, distributionMethod: 'BY_VALUE' }])}
              >
                <Plus className="h-3 w-3 mr-1" />Add Cost
              </Button>
            </div>

            {costLines.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">Add cost lines for shipping, customs duties, handling fees, etc.</p>
            ) : (
              <div className="space-y-2">
                {costLines.map((cl) => (
                  <div key={cl.key} className="flex flex-wrap items-center gap-2">
                    <Input
                      placeholder="Description (e.g. Shipping, Customs, Insurance)"
                      value={cl.description}
                      onChange={(e) => setCostLines((p) => p.map((c) => c.key === cl.key ? { ...c, description: e.target.value } : c))}
                      className="flex-1 min-w-[140px] h-8 text-sm"
                    />
                    <div className="flex items-center gap-2">
                      <Input
                        type="number" min="0" step="0.01"
                        value={cl.amountForeign}
                        onChange={(e) => setCostLines((p) => p.map((c) => c.key === cl.key ? { ...c, amountForeign: Number(e.target.value) || 0 } : c))}
                        className="w-28 h-8 text-sm text-right font-mono"
                      />
                      <span className="text-xs text-muted-foreground w-8 shrink-0">{sym}</span>
                      <label className="flex items-center gap-1 text-xs whitespace-nowrap cursor-pointer shrink-0">
                        <input
                          type="checkbox"
                          checked={cl.vatable}
                          onChange={(e) => setCostLines((p) => p.map((c) => c.key === cl.key ? { ...c, vatable: e.target.checked } : c))}
                          className="rounded border-input"
                        />
                        VAT
                      </label>
                      <select
                        value={cl.distributionMethod}
                        onChange={(e) => setCostLines((p) => p.map((c) => c.key === cl.key ? { ...c, distributionMethod: e.target.value } : c))}
                        className="h-8 rounded-md border border-input bg-background px-2 text-xs w-32 shrink-0"
                      >
                        <option value="BY_VALUE">By Value</option>
                        <option value="BY_QUANTITY">By Quantity</option>
                        <option value="BY_WEIGHT">By Weight</option>
                        <option value="EQUAL_SPLIT">Equal Split</option>
                      </select>
                      <button type="button" onClick={() => setCostLines((p) => p.filter((c) => c.key !== cl.key))} className="text-muted-foreground hover:text-destructive shrink-0">
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Totals */}
            {costLines.length > 0 && (
              <div className="flex sm:justify-end border-t pt-3">
                <div className="text-sm space-y-1 w-full sm:min-w-56 sm:w-auto">
                  <div className="flex justify-between text-muted-foreground">
                    <span>Subtotal</span>
                    <span className="font-mono">{money(subtotal)}</span>
                  </div>
                  {vatTotal > 0 && (
                    <div className="flex justify-between text-muted-foreground">
                      <span>VAT ({(vatRate * 100).toFixed(0)}%)</span>
                      <span className="font-mono">{money(vatTotal)}</span>
                    </div>
                  )}
                  <div className="flex justify-between font-medium border-t pt-1">
                    <span>Total</span>
                    <span className="font-mono">
                      {money(grandTotal)}
                      {currency !== baseCurrency.code && (
                        <span className="text-muted-foreground font-normal ml-2">({formatMoney(grandTotal / fxRate, baseCurrency.symbol, baseCurrency.symbolPosition)})</span>
                      )}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isPending}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={isPending}>
            {isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Create Landed Cost PO
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
