'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Search, X, Plus, Loader2 } from 'lucide-react'
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
import { createPurchaseOrder, getSupplierLastPrices } from '@/app/actions/purchase-orders'
import { createSupplier, type SupplierRow } from '@/app/actions/suppliers'
import type { ProductRow } from '@/app/actions/products'
import type { CurrencyRow } from '@/app/actions/currencies'
import type { TaxRateRow, PurchaseUnitRow } from '@/app/actions/settings'
import { ProductLink } from '@/components/inventory/product-link'

type Warehouse = { id: string; code: string; name: string }

type Props = {
  suppliers: SupplierRow[]
  products: ProductRow[]
  warehouses: Warehouse[]
  currencies: CurrencyRow[]
  taxRates: TaxRateRow[]
  purchaseUnits: PurchaseUnitRow[]
  onClose: () => void
}

type LineItem = {
  key: string
  productId: string
  sku: string
  productName: string
  qty: number // purchase qty (in purchase units, or stock units if no unit)
  purchaseUnitId: string // '' = stock units
  unitCostForeign: number // cost per purchase unit
}

type AdditionalCost = {
  key: string
  description: string
  amountForeign: number
  vatable: boolean
  distributionMethod: string
}

function makeKey() {
  return Math.random().toString(36).slice(2)
}

export function PoFormDialog({ suppliers, products, warehouses, currencies, taxRates, purchaseUnits, onClose }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  // Header state
  const [supplierId, setSupplierId] = useState('')
  const [currency, setCurrency] = useState('GBP')
  const [fxRate, setFxRate] = useState(1)
  const [destinationWarehouseId, setDestinationWarehouseId] = useState('')
  const [supplierRef, setSupplierRef] = useState('')
  const [expectedDelivery, setExpectedDelivery] = useState('')
  const [notes, setNotes] = useState('')
  const [internalNotes, setInternalNotes] = useState('')

  // VAT
  const [taxRateId, setTaxRateId] = useState('')
  const [pricesIncludeVat, setPricesIncludeVat] = useState(false)

  // Landed costs
  const [additionalCosts, setAdditionalCosts] = useState<AdditionalCost[]>([])

  // Lines
  const [lines, setLines] = useState<LineItem[]>([])
  const [productSearch, setProductSearch] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const [lastPrices, setLastPrices] = useState<Record<string, { lastUnitCost: number; currency: string }>>({})

  const [error, setError] = useState('')

  // Local supplier list (can grow when user adds inline)
  const [allSuppliers, setAllSuppliers] = useState(suppliers)
  const [showNewSupplier, setShowNewSupplier] = useState(false)
  const [newSupplierName, setNewSupplierName] = useState('')
  const [newSupplierCurrency, setNewSupplierCurrency] = useState('GBP')
  const [creatingSup, setCreatingSup] = useState(false)

  async function handleCreateSupplier() {
    if (!newSupplierName.trim()) return
    setCreatingSup(true)
    const result = await createSupplier({ name: newSupplierName, currency: newSupplierCurrency })
    setCreatingSup(false)
    if (result.success && result.supplier) {
      setAllSuppliers((prev) => [...prev, result.supplier!].sort((a, b) => a.name.localeCompare(b.name)))
      handleSupplierChange(result.supplier.id)
      setShowNewSupplier(false)
      setNewSupplierName('')
      setNewSupplierCurrency('GBP')
    }
  }

  const selectedTaxRate = taxRates.find((t) => t.id === taxRateId)
  const vatRate = selectedTaxRate?.rate ?? 0

  // Currency symbol lookup (GBP → £, EUR → €, etc.)
  const symbolMap: Record<string, string> = { GBP: '£' }
  for (const c of currencies) symbolMap[c.code] = c.symbol
  const sym = symbolMap[currency] ?? currency

  // Build rate lookup
  const rateMap: Record<string, number> = { GBP: 1 }
  for (const c of currencies) {
    if (c.latestRate != null) rateMap[c.code] = c.latestRate
  }

  function setCurrencyAndRate(code: string) {
    setCurrency(code)
    if (code === 'GBP') setFxRate(1)
    else if (rateMap[code]) setFxRate(rateMap[code])
  }

  async function handleSupplierChange(id: string) {
    setSupplierId(id)
    const s = allSuppliers.find((sup) => sup.id === id)
    if (s) {
      setCurrencyAndRate(s.currency)
      if (s.taxRateId) setTaxRateId(s.taxRateId)
      else setTaxRateId('')
    }
    if (id) {
      const prices = await getSupplierLastPrices(id)
      setLastPrices(prices)
    } else {
      setLastPrices({})
    }
  }

  function addProduct(p: ProductRow) {
    if (lines.some((l) => l.productId === p.id)) return
    const lastPrice = lastPrices[p.id]
    setLines((prev) => [...prev, {
      key: makeKey(), productId: p.id, sku: p.sku, productName: p.name,
      qty: 1, purchaseUnitId: '', unitCostForeign: lastPrice?.lastUnitCost ?? 0,
    }])
    setProductSearch('')
    setShowSearch(false)
  }

  function updateLine(key: string, field: 'qty' | 'unitCostForeign' | 'purchaseUnitId', value: number | string) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, [field]: value } : l)))
  }

  // Build unit lookup
  const unitMap: Record<string, PurchaseUnitRow> = {}
  for (const u of purchaseUnits) unitMap[u.id] = u

  function getStockQty(line: LineItem): number {
    const unit = unitMap[line.purchaseUnitId]
    return unit ? line.qty * unit.conversionFactor : line.qty
  }

  // Calculations
  const lineSubtotalForeign = lines.reduce((sum, l) => {
    const net = pricesIncludeVat && vatRate > 0 ? (l.qty * l.unitCostForeign) / (1 + vatRate) : l.qty * l.unitCostForeign
    return sum + net
  }, 0)
  const taxTotalForeign = pricesIncludeVat
    ? lines.reduce((sum, l) => sum + l.qty * l.unitCostForeign, 0) - lineSubtotalForeign
    : lineSubtotalForeign * vatRate
  const additionalCostNet = additionalCosts.reduce((sum, ac) => sum + ac.amountForeign, 0)
  const additionalCostVat = additionalCosts.reduce((sum, ac) => ac.vatable && vatRate > 0 ? sum + ac.amountForeign * vatRate : sum, 0)
  const additionalCostTotal = additionalCostNet + additionalCostVat
  const grandTotalForeign = lineSubtotalForeign + taxTotalForeign + additionalCostTotal
  const grandTotalGbp = grandTotalForeign / fxRate

  const filteredProducts = products.filter((p) => {
    if (!productSearch) return true
    const q = productSearch.toLowerCase()
    return p.sku.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)
  }).slice(0, 20)

  async function handleSubmit() {
    setError('')
    if (!supplierId) { setError('Please select a supplier'); return }
    if (!lines.length) { setError('Add at least one product line'); return }

    startTransition(async () => {
      const result = await createPurchaseOrder({
        supplierId,
        currency,
        fxRateToGbp: fxRate,
        destinationWarehouseId: destinationWarehouseId || undefined,
        supplierRef: supplierRef || undefined,
        expectedDelivery: expectedDelivery || undefined,
        notes: notes || undefined,
        internalNotes: internalNotes || undefined,
        pricesIncludeVat,
        taxRateId: taxRateId || undefined,
        taxRateName: selectedTaxRate?.name,
        taxRateValue: vatRate,
        additionalCosts: additionalCosts.filter((ac) => ac.amountForeign > 0).map((ac) => ({
          description: ac.description,
          amountForeign: ac.amountForeign,
          vatable: ac.vatable,
          distributionMethod: ac.distributionMethod,
        })),
        lines: lines.map((l, i) => ({
          productId: l.productId,
          sku: l.sku,
          productName: l.productName,
          qty: getStockQty(l),
          purchaseUnitId: l.purchaseUnitId || undefined,
          purchaseUnitQty: l.purchaseUnitId ? l.qty : undefined,
          unitCostForeign: l.purchaseUnitId
            ? l.unitCostForeign / (unitMap[l.purchaseUnitId]?.conversionFactor ?? 1)
            : l.unitCostForeign,
          sortOrder: i,
        })),
      })
      if (result.success && result.po) {
        router.refresh()
        onClose()
        router.push(`/purchase-orders/${result.po.id}`)
      } else {
        setError(result.error ?? 'Failed to create PO')
      }
    })
  }

  return (
    <Dialog open onOpenChange={() => {}}>
    <DialogContent showCloseButton={false} className="w-[80vw] max-w-[80vw] sm:max-w-[80vw] max-h-[90vh] overflow-y-auto">
    <DialogHeader>
      <DialogTitle>New Purchase Order</DialogTitle>
    </DialogHeader>
    <div className="space-y-6">
      {/* Header fields */}
      <div className="rounded-md border p-4 space-y-4">
        <h2 className="font-medium text-sm text-muted-foreground uppercase tracking-wide">PO Details</h2>

        <div className="grid grid-cols-3 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="supplier">Supplier *</Label>
            {!showNewSupplier ? (
              <div className="flex gap-1.5">
                <select
                  id="supplier"
                  value={supplierId}
                  onChange={(e) => handleSupplierChange(e.target.value)}
                  className="flex-1 h-9 rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">Select supplier…</option>
                  {allSuppliers.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
                <Button type="button" variant="outline" size="sm" className="h-9 shrink-0" onClick={() => setShowNewSupplier(true)}>
                  <Plus className="h-3 w-3 mr-1" />New
                </Button>
              </div>
            ) : (
              <div className="flex gap-1.5 items-end">
                <Input
                  placeholder="Supplier name"
                  value={newSupplierName}
                  onChange={(e) => setNewSupplierName(e.target.value)}
                  className="flex-1 h-9 text-sm"
                  autoFocus
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleCreateSupplier() } }}
                />
                <select
                  value={newSupplierCurrency}
                  onChange={(e) => setNewSupplierCurrency(e.target.value)}
                  className="w-24 h-9 rounded-md border border-input bg-background px-2 text-sm font-mono"
                >
                  <option value="GBP">GBP</option>
                  {currencies.filter((c) => c.code !== 'GBP').map((c) => (
                    <option key={c.code} value={c.code}>{c.code}</option>
                  ))}
                </select>
                <Button type="button" size="sm" className="h-9 shrink-0" onClick={handleCreateSupplier} disabled={creatingSup || !newSupplierName.trim()}>
                  {creatingSup ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Add'}
                </Button>
                <Button type="button" variant="outline" size="sm" className="h-9 shrink-0" onClick={() => { setShowNewSupplier(false); setNewSupplierName('') }}>
                  Cancel
                </Button>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Currency / FX Rate</Label>
            <div className="flex gap-2">
              <select
                value={currency}
                onChange={(e) => setCurrencyAndRate(e.target.value)}
                className="w-28 h-9 rounded-md border border-input bg-background px-3 text-sm font-mono"
              >
                <option value="GBP">GBP £</option>
                {currencies.filter((c) => c.code !== 'GBP').map((c) => (
                  <option key={c.code} value={c.code}>{c.code} {c.symbol}</option>
                ))}
              </select>
              <div className="flex-1 relative">
                <span className="absolute left-3 top-2 text-xs text-muted-foreground">1 GBP =</span>
                <Input
                  type="number" min="0.0001" step="0.0001"
                  value={fxRate}
                  onChange={(e) => setFxRate(Number(e.target.value) || 1)}
                  className="pl-16 h-9 font-mono text-sm"
                  disabled={currency === 'GBP'}
                />
              </div>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>VAT Rate</Label>
            <div className="flex items-center gap-3">
              <select
                value={taxRateId}
                onChange={(e) => setTaxRateId(e.target.value)}
                className="flex-1 h-9 rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">No VAT</option>
                {taxRates.filter((t) => t.usedFor === 'PURCHASE' || t.usedFor === 'BOTH').map((t) => (
                  <option key={t.id} value={t.id}>{t.name} ({(t.rate * 100).toFixed(0)}%)</option>
                ))}
              </select>
              {taxRateId && (
                <label className="flex items-center gap-1.5 text-sm whitespace-nowrap cursor-pointer">
                  <input
                    type="checkbox"
                    checked={pricesIncludeVat}
                    onChange={(e) => setPricesIncludeVat(e.target.checked)}
                    className="rounded border-input"
                  />
                  Prices incl. VAT
                </label>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="warehouse">Destination Warehouse</Label>
            <select
              id="warehouse"
              value={destinationWarehouseId}
              onChange={(e) => setDestinationWarehouseId(e.target.value)}
              className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">Not specified</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>{w.code} — {w.name}</option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="expectedDelivery">Expected Delivery</Label>
            <Input id="expectedDelivery" type="date" value={expectedDelivery} onChange={(e) => setExpectedDelivery(e.target.value)} className="h-9 text-sm" />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="supplierRef">Supplier Reference</Label>
            <Input id="supplierRef" value={supplierRef} onChange={(e) => setSupplierRef(e.target.value)} placeholder="Supplier's order/invoice ref" className="h-9 text-sm" />
          </div>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="notes">Notes (visible to supplier)</Label>
            <Textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="text-sm resize-none" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="internalNotes">Internal Notes</Label>
            <Textarea id="internalNotes" value={internalNotes} onChange={(e) => setInternalNotes(e.target.value)} rows={2} className="text-sm resize-none" />
          </div>
        </div>
      </div>

      {/* Order Lines */}
      <div className="rounded-md border p-4 space-y-3">
        <h2 className="font-medium text-sm text-muted-foreground uppercase tracking-wide">Order Lines</h2>

        {lines.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-muted-foreground text-xs">
                  <th className="pb-2 text-left font-medium">Product</th>
                  {purchaseUnits.length > 0 && <th className="pb-2 text-left font-medium w-32">Unit</th>}
                  <th className="pb-2 text-right font-medium w-20">Qty</th>
                  {purchaseUnits.length > 0 && <th className="pb-2 text-right font-medium w-24">Stock Qty</th>}
                  <th className="pb-2 text-right font-medium w-32">
                    Unit Cost ({sym})
                    {pricesIncludeVat && vatRate > 0 ? ' incl.' : ''}
                  </th>
                  <th className="pb-2 text-right font-medium w-28">Line Total ({sym})</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {lines.map((line) => {
                  const grossTotal = line.qty * line.unitCostForeign
                  const netForeign = pricesIncludeVat && vatRate > 0 ? grossTotal / (1 + vatRate) : grossTotal
                  const netGbp = netForeign / fxRate
                  const stockQty = getStockQty(line)
                  const unit = unitMap[line.purchaseUnitId]
                  return (
                    <tr key={line.key}>
                      <td className="py-2 pr-3">
                        <ProductLink productId={line.productId} sku={line.sku} name={line.productName} />
                      </td>
                      {purchaseUnits.length > 0 && (
                        <td className="py-2 pr-3">
                          <select
                            value={line.purchaseUnitId}
                            onChange={(e) => updateLine(line.key, 'purchaseUnitId', e.target.value)}
                            className="h-7 rounded-md border border-input bg-background px-2 text-xs w-32"
                          >
                            <option value="">Each (1:1)</option>
                            {purchaseUnits.map((u) => (
                              <option key={u.id} value={u.id}>{u.abbreviation} (1:{u.conversionFactor} {u.stockUnitName})</option>
                            ))}
                          </select>
                        </td>
                      )}
                      <td className="py-2 pr-3">
                        <Input
                          type="number" min="1" step="1" value={line.qty}
                          onChange={(e) => updateLine(line.key, 'qty', Number(e.target.value) || 0)}
                          className="h-7 text-sm text-right w-20 ml-auto"
                        />
                      </td>
                      {purchaseUnits.length > 0 && (
                        <td className="py-2 pr-3 text-right text-xs tabular-nums">
                          {unit ? (
                            <span className="text-muted-foreground">{stockQty} {unit?.stockUnitName ?? 'pcs'}</span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                      )}
                      <td className="py-2 pr-3">
                        <Input
                          type="number" min="0" step="0.01" value={line.unitCostForeign}
                          onChange={(e) => updateLine(line.key, 'unitCostForeign', Number(e.target.value) || 0)}
                          className="h-7 text-sm text-right w-32 ml-auto font-mono"
                        />
                      </td>
                      <td className="py-2 pr-3 text-right font-mono text-xs">{netForeign.toFixed(2)}{sym}</td>
                      <td className="py-2">
                        <button type="button" onClick={() => setLines((p) => p.filter((l) => l.key !== line.key))} className="text-muted-foreground hover:text-destructive">
                          <X className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Product search */}
        <div className="relative">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search product to add…"
              value={productSearch}
              onChange={(e) => { setProductSearch(e.target.value); setShowSearch(true) }}
              onFocus={() => setShowSearch(true)}
              className="pl-8 h-8 text-sm"
            />
          </div>
          {showSearch && productSearch && (
            <div className="absolute z-10 top-9 left-0 right-0 bg-popover border rounded-md shadow-md max-h-64 overflow-y-auto">
              {filteredProducts.filter((p) => !lines.some((l) => l.productId === p.id)).map((p) => {
                const lastPrice = lastPrices[p.id]
                return (
                  <button
                    key={p.id} type="button"
                    className="w-full flex items-center justify-between px-3 py-2 hover:bg-accent text-sm text-left"
                    onMouseDown={() => addProduct(p)}
                  >
                    <span>
                      <span className="font-mono text-xs font-medium">{p.sku}</span>
                      <span className="ml-2 text-muted-foreground">{p.name}</span>
                    </span>
                    {lastPrice && (
                      <span className="text-xs text-muted-foreground ml-2 shrink-0">
                        Last: {lastPrice.lastUnitCost.toFixed(2)}{sym}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* Additional Costs (Landed Cost) */}
      <div className="rounded-md border p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-medium text-sm text-muted-foreground uppercase tracking-wide">Additional Costs</h2>
          <Button
            variant="outline" size="sm"
            onClick={() => setAdditionalCosts((prev) => [...prev, { key: makeKey(), description: '', amountForeign: 0, vatable: false, distributionMethod: 'BY_VALUE' }])}
          >
            <Plus className="h-3 w-3 mr-1" />Add Cost
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Shipping, customs duties, handling fees, etc. These are distributed as landed cost across product lines.
        </p>

        {additionalCosts.length > 0 && (
          <div className="space-y-2">
            {additionalCosts.map((ac) => (
              <div key={ac.key} className="flex items-center gap-2">
                <Input
                  placeholder="Description (e.g. Shipping)"
                  value={ac.description}
                  onChange={(e) => setAdditionalCosts((prev) => prev.map((c) => c.key === ac.key ? { ...c, description: e.target.value } : c))}
                  className="flex-1 h-8 text-sm"
                />
                <Input
                  type="number" min="0" step="0.01"
                  value={ac.amountForeign}
                  onChange={(e) => setAdditionalCosts((prev) => prev.map((c) => c.key === ac.key ? { ...c, amountForeign: Number(e.target.value) || 0 } : c))}
                  className="w-28 h-8 text-sm text-right font-mono"
                />
                <span className="text-xs text-muted-foreground w-8 shrink-0">{sym}</span>
                <label className="flex items-center gap-1 text-xs whitespace-nowrap cursor-pointer shrink-0">
                  <input
                    type="checkbox"
                    checked={ac.vatable}
                    onChange={(e) => setAdditionalCosts((prev) => prev.map((c) => c.key === ac.key ? { ...c, vatable: e.target.checked } : c))}
                    className="rounded border-input"
                  />
                  VAT
                </label>
                <select
                  value={ac.distributionMethod}
                  onChange={(e) => setAdditionalCosts((prev) => prev.map((c) => c.key === ac.key ? { ...c, distributionMethod: e.target.value } : c))}
                  className="h-8 rounded-md border border-input bg-background px-2 text-xs w-32 shrink-0"
                >
                  <option value="BY_VALUE">By Value</option>
                  <option value="BY_QUANTITY">By Quantity</option>
                  <option value="BY_WEIGHT">By Weight</option>
                  <option value="EQUAL_SPLIT">Equal Split</option>
                </select>
                <button type="button" onClick={() => setAdditionalCosts((p) => p.filter((c) => c.key !== ac.key))} className="text-muted-foreground hover:text-destructive shrink-0">
                  <X className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Totals */}
      {lines.length > 0 && (
        <div className="rounded-md border p-4">
          <div className="flex justify-end">
            <div className="text-sm space-y-1 min-w-64">
              <div className="flex justify-between text-muted-foreground">
                <span>Subtotal (net)</span>
                <span className="font-mono">{lineSubtotalForeign.toFixed(2)}{sym}</span>
              </div>
              {vatRate > 0 && (
                <div className="flex justify-between text-muted-foreground">
                  <span>VAT ({(vatRate * 100).toFixed(0)}%){pricesIncludeVat ? ' (extracted)' : ''}</span>
                  <span className="font-mono">{taxTotalForeign.toFixed(2)}{sym}</span>
                </div>
              )}
              {additionalCostNet > 0 && (
                <div className="flex justify-between text-muted-foreground">
                  <span>Additional Costs</span>
                  <span className="font-mono">{additionalCostNet.toFixed(2)}{sym}</span>
                </div>
              )}
              {additionalCostVat > 0 && (
                <div className="flex justify-between text-muted-foreground">
                  <span>VAT on Additional Costs</span>
                  <span className="font-mono">{additionalCostVat.toFixed(2)}{sym}</span>
                </div>
              )}
              <div className="flex justify-between font-medium border-t pt-1">
                <span>Total</span>
                <span className="font-mono">
                  {grandTotalForeign.toFixed(2)}{sym}
                  {currency !== 'GBP' && (
                    <span className="text-muted-foreground font-normal ml-2">(£{grandTotalGbp.toFixed(2)})</span>
                  )}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
    <DialogFooter>
      <Button variant="outline" onClick={onClose} disabled={isPending}>Cancel</Button>
      <Button onClick={handleSubmit} disabled={isPending}>
        {isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
        Create Purchase Order
      </Button>
    </DialogFooter>
    </DialogContent>
    </Dialog>
  )
}
