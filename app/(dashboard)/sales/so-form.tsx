'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Search, X, Plus, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { createSalesOrder } from '@/app/actions/sales'
import { createCustomer, type CustomerRow, type AddressData } from '@/app/actions/customers'
import type { ProductRow } from '@/app/actions/products'
import type { CurrencyRow } from '@/app/actions/currencies'
import type { TaxRateRow, UserOption } from '@/app/actions/settings'
import type { StockLevelEntry } from '@/app/actions/stock'
import { ProductLink } from '@/components/inventory/product-link'

type Warehouse = { id: string; code: string; name: string }

type Props = {
  products: ProductRow[]
  warehouses: Warehouse[]
  currencies: CurrencyRow[]
  taxRates: TaxRateRow[]
  customers: CustomerRow[]
  stockLevels: Record<string, Record<string, StockLevelEntry>>
  avgCogs: Record<string, number>
  users: UserOption[]
  currentUserName: string
  onClose: () => void
}

type LineItem = { key: string; productId: string; sku: string; name: string; qty: number; unitPrice: number; discount: string }
type FeeLine = { key: string; description: string; amount: number }

/** Parse a discount string: "10%" → percentage, "5" → absolute value */
function parseDiscount(input: string, lineTotal: number): number {
  const s = input.trim()
  if (!s) return 0
  if (s.endsWith('%')) {
    const pct = parseFloat(s.slice(0, -1))
    return isNaN(pct) ? 0 : Math.round(lineTotal * pct / 100 * 10000) / 10000
  }
  const abs = parseFloat(s)
  return isNaN(abs) ? 0 : abs
}

function makeKey() { return Math.random().toString(36).slice(2) }

function formatAddr(a: AddressData | null): string {
  if (!a) return ''
  return [a.line1, a.line2, a.city, a.postcode, a.country].filter(Boolean).join(', ')
}

export function SoFormDialog({ products, warehouses, currencies, taxRates, customers, stockLevels, avgCogs, users, currentUserName, onClose }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  // Customer
  const [allCustomers, setAllCustomers] = useState(customers)
  const [customerId, setCustomerId] = useState('')
  const [customerName, setCustomerName] = useState('')
  const [customerEmail, setCustomerEmail] = useState('')
  const [showNewCustomer, setShowNewCustomer] = useState(false)
  const [newCustName, setNewCustName] = useState('')
  const [creatingCust, setCreatingCust] = useState(false)
  const [billingAddr, setBillingAddr] = useState('')
  const [shippingAddr, setShippingAddr] = useState('')
  const [billingAddrObj, setBillingAddrObj] = useState<Record<string, string> | null>(null)
  const [shippingAddrObj, setShippingAddrObj] = useState<Record<string, string> | null>(null)

  // Order
  const [currency, setCurrency] = useState('GBP')
  const [fxRate, setFxRate] = useState(1)
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.id ?? '')
  const [expectedDelivery, setExpectedDelivery] = useState('')
  const [salesRep, setSalesRep] = useState(currentUserName)
  const [notes, setNotes] = useState('')
  const [internalNotes, setInternalNotes] = useState('')
  const [taxRateId, setTaxRateId] = useState('')
  const [pricesIncludeVat, setPricesIncludeVat] = useState(true)

  // Lines
  const [lines, setLines] = useState<LineItem[]>([])
  const [productSearch, setProductSearch] = useState('')
  const [showSearch, setShowSearch] = useState(false)

  // Shipping, fees & discount
  const [shippingAmount, setShippingAmount] = useState(0)
  const [shippingService, setShippingService] = useState('')
  const [fees, setFees] = useState<FeeLine[]>([])
  const [orderDiscount, setOrderDiscount] = useState('')

  const [error, setError] = useState('')

  const selectedTaxRate = taxRates.find((t) => t.id === taxRateId)
  const vatRate = selectedTaxRate?.rate ?? 0

  const symbolMap: Record<string, string> = { GBP: '£' }
  for (const c of currencies) symbolMap[c.code] = c.symbol
  const sym = symbolMap[currency] ?? currency

  const rateMap: Record<string, number> = { GBP: 1 }
  for (const c of currencies) if (c.latestRate != null) rateMap[c.code] = c.latestRate

  function setCurrencyAndRate(code: string) {
    setCurrency(code)
    if (code === 'GBP') setFxRate(1)
    else if (rateMap[code]) setFxRate(rateMap[code])
  }

  function handleCustomerChange(id: string) {
    setCustomerId(id)
    const c = allCustomers.find((cu) => cu.id === id)
    if (c) {
      setCustomerName(c.fullName)
      setCustomerEmail(c.email ?? '')
      setBillingAddr(formatAddr(c.billingAddress))
      setShippingAddr(formatAddr(c.shippingAddress))
      setBillingAddrObj(c.billingAddress as Record<string, string> | null)
      setShippingAddrObj(c.shippingAddress as Record<string, string> | null)
    }
  }

  async function handleCreateCustomer() {
    if (!newCustName.trim()) return
    setCreatingCust(true)
    const parts = newCustName.trim().split(/\s+/)
    const result = await createCustomer({ firstName: parts[0], lastName: parts.slice(1).join(' ') || undefined })
    setCreatingCust(false)
    if (result.success && result.customer) {
      setAllCustomers((prev) => [...prev, result.customer!].sort((a, b) => a.fullName.localeCompare(b.fullName)))
      handleCustomerChange(result.customer.id)
      setShowNewCustomer(false)
      setNewCustName('')
    }
  }

  function addProduct(p: ProductRow) {
    if (lines.some((l) => l.productId === p.id)) return
    const price = p.salesPriceGbp ? Number(p.salesPriceGbp) * (currency === 'GBP' ? 1 : fxRate) : 0
    setLines((prev) => [...prev, { key: makeKey(), productId: p.id, sku: p.sku, name: p.name, qty: 1, unitPrice: Math.round(price * 100) / 100, discount: '' }])
    setProductSearch('')
    setShowSearch(false)
  }

  function stockAt(productId: string): StockLevelEntry {
    return stockLevels[productId]?.[warehouseId] ?? { total: 0, available: 0 }
  }

  // Calculations — per line with discount
  function getLineNet(l: LineItem): number {
    const gross = l.qty * l.unitPrice
    const disc = parseDiscount(l.discount, gross)
    const afterDisc = gross - disc
    return pricesIncludeVat && vatRate > 0 ? afterDisc / (1 + vatRate) : afterDisc
  }
  function getLineGross(l: LineItem): number {
    const gross = l.qty * l.unitPrice
    return gross - parseDiscount(l.discount, gross)
  }

  const linesSubtotalBeforeOrderDisc = lines.reduce((s, l) => s + getLineNet(l), 0)
  const linesGrossBeforeOrderDisc = lines.reduce((s, l) => s + getLineGross(l), 0)
  const orderDiscountAmount = parseDiscount(orderDiscount, linesGrossBeforeOrderDisc)
  const orderDiscountNet = pricesIncludeVat && vatRate > 0 ? orderDiscountAmount / (1 + vatRate) : orderDiscountAmount

  const lineSubtotal = linesSubtotalBeforeOrderDisc - orderDiscountNet
  const lineVat = pricesIncludeVat
    ? (linesGrossBeforeOrderDisc - orderDiscountAmount) - lineSubtotal
    : lineSubtotal * vatRate

  const feesTotal = fees.reduce((s, f) => s + f.amount, 0)
  const shippingNet = pricesIncludeVat && vatRate > 0 ? shippingAmount / (1 + vatRate) : shippingAmount
  const shippingVat = shippingAmount - shippingNet
  const feesNet = pricesIncludeVat && vatRate > 0 ? feesTotal / (1 + vatRate) : feesTotal
  const feesVat = feesTotal - feesNet
  const totalVat = lineVat + shippingVat + feesVat
  const grandTotal = lineSubtotal + totalVat + shippingNet + feesNet + shippingVat + feesVat
  const totalCogs = lines.reduce((s, l) => s + l.qty * (avgCogs[l.productId] ?? 0), 0)
  const totalLineDiscounts = lines.reduce((s, l) => s + parseDiscount(l.discount, l.qty * l.unitPrice), 0)
  const totalAllDiscounts = totalLineDiscounts + orderDiscountAmount

  const filteredProducts = products.filter((p) => {
    if (!productSearch) return true
    const q = productSearch.toLowerCase()
    return p.sku.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)
  }).slice(0, 20)

  function handleSubmit() {
    setError('')
    if (!customerId && !customerName.trim()) { setError('Select or enter a customer'); return }
    if (!lines.length) { setError('Add at least one product'); return }

    startTransition(async () => {
      const resolvedName = customerName || allCustomers.find((c) => c.id === customerId)?.fullName || ''
      const result = await createSalesOrder({
        customerId: customerId || undefined,
        customerName: resolvedName,
        billingAddress: billingAddrObj ?? undefined,
        shippingAddress: shippingAddrObj ?? undefined,
        customerEmail: customerEmail || undefined,
        currency,
        fxRateToGbp: fxRate,
        shipFromWarehouseId: warehouseId || undefined,
        expectedDelivery: expectedDelivery || undefined,
        salesRep: salesRep || undefined,
        notes: notes || undefined,
        internalNotes: internalNotes || undefined,
        shippingService: shippingService || undefined,
        shippingForeign: shippingAmount,
        taxRateName: selectedTaxRate?.name,
        taxRateValue: vatRate,
        pricesIncludeVat,
        fees: fees.filter((f) => f.amount > 0).map((f) => ({ description: f.description, amount: f.amount })),
        orderDiscountForeign: orderDiscountAmount,
        orderDiscountStr: orderDiscount || undefined,
        lines: lines.map((l) => {
          const gross = l.qty * l.unitPrice
          const disc = parseDiscount(l.discount, gross)
          return {
            productId: l.productId,
            sku: l.sku,
            description: l.name,
            qty: l.qty,
            unitPriceForeign: l.unitPrice, // original price, NOT discounted
            discountStr: l.discount || undefined,
            discountAmount: disc,
          }
        }),
      })
      if (result.success && result.order) {
        router.refresh()
        onClose()
        router.push(`/sales/${result.order.id}`)
      } else {
        setError(result.error ?? 'Failed to create order')
      }
    })
  }

  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent showCloseButton={false} className="w-[80vw] max-w-[80vw] sm:max-w-[80vw] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New Sales Order</DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          {/* Customer + Order details */}
          <div className="rounded-md border p-4 space-y-4">
            <h2 className="font-medium text-sm text-muted-foreground uppercase tracking-wide">Order Details</h2>
            <div className="grid grid-cols-3 gap-4">
              {/* Customer */}
              <div className="space-y-1.5">
                <Label>Customer *</Label>
                {!showNewCustomer ? (
                  <div className="flex gap-1.5">
                    <select value={customerId} onChange={(e) => handleCustomerChange(e.target.value)} className="flex-1 h-9 rounded-md border border-input bg-background px-3 text-sm">
                      <option value="">Select customer…</option>
                      {allCustomers.map((c) => (<option key={c.id} value={c.id}>{c.fullName}{c.company ? ` (${c.company})` : ''}</option>))}
                    </select>
                    <Button type="button" variant="outline" size="sm" className="h-9 shrink-0" onClick={() => setShowNewCustomer(true)}>
                      <Plus className="h-3 w-3 mr-1" />New
                    </Button>
                  </div>
                ) : (
                  <div className="flex gap-1.5">
                    <Input placeholder="Customer name" value={newCustName} onChange={(e) => setNewCustName(e.target.value)} className="flex-1 h-9 text-sm" autoFocus
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleCreateCustomer() } }} />
                    <Button type="button" size="sm" className="h-9" onClick={handleCreateCustomer} disabled={creatingCust || !newCustName.trim()}>
                      {creatingCust ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Add'}
                    </Button>
                    <Button type="button" variant="outline" size="sm" className="h-9" onClick={() => { setShowNewCustomer(false); setNewCustName('') }}>Cancel</Button>
                  </div>
                )}
              </div>
              <div className="space-y-1.5">
                <Label>Currency / FX Rate</Label>
                <div className="flex gap-2">
                  <select value={currency} onChange={(e) => setCurrencyAndRate(e.target.value)} className="w-28 h-9 rounded-md border border-input bg-background px-3 text-sm font-mono">
                    <option value="GBP">GBP £</option>
                    {currencies.filter((c) => c.code !== 'GBP').map((c) => (<option key={c.code} value={c.code}>{c.code} {c.symbol}</option>))}
                  </select>
                  <Input type="number" min="0.0001" step="0.0001" value={fxRate} onChange={(e) => setFxRate(Number(e.target.value) || 1)} className="flex-1 h-9 font-mono text-sm" disabled={currency === 'GBP'} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Ship From Warehouse</Label>
                <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm">
                  <option value="">Not specified</option>
                  {warehouses.map((w) => (<option key={w.id} value={w.id}>{w.code} — {w.name}</option>))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label>Delivery Date</Label>
                <Input type="date" value={expectedDelivery} onChange={(e) => setExpectedDelivery(e.target.value)} className="h-9 text-sm" />
              </div>
              <div className="space-y-1.5">
                <Label>Sales Representative</Label>
                <select value={salesRep} onChange={(e) => setSalesRep(e.target.value)} className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm">
                  {users.map((u) => (<option key={u.id} value={u.name}>{u.name}</option>))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label>VAT Rate</Label>
                <div className="flex items-center gap-3">
                  <select value={taxRateId} onChange={(e) => setTaxRateId(e.target.value)} className="flex-1 h-9 rounded-md border border-input bg-background px-3 text-sm">
                    <option value="">No VAT</option>
                    {taxRates.filter((t) => t.usedFor === 'SALES' || t.usedFor === 'BOTH').map((t) => (
                      <option key={t.id} value={t.id}>{t.name} ({(t.rate * 100).toFixed(0)}%)</option>
                    ))}
                  </select>
                  {taxRateId && (
                    <label className="flex items-center gap-1.5 text-sm whitespace-nowrap cursor-pointer">
                      <input type="checkbox" checked={pricesIncludeVat} onChange={(e) => setPricesIncludeVat(e.target.checked)} className="rounded border-input" />
                      Incl. VAT
                    </label>
                  )}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Customer Notes</Label>
                <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={1} placeholder="Visible on order confirmation & invoice" className="text-sm resize-none" />
              </div>
              <div className="space-y-1.5">
                <Label>Private Notes</Label>
                <Textarea value={internalNotes} onChange={(e) => setInternalNotes(e.target.value)} rows={1} placeholder="Internal only — not visible to customer" className="text-sm resize-none" />
              </div>
            </div>
            {/* Addresses */}
            {customerId && (
              <div className="grid grid-cols-2 gap-4 pt-2 border-t">
                <div className="text-xs">
                  <span className="text-muted-foreground">Billing:</span> {billingAddr || '—'}
                </div>
                <div className="text-xs">
                  <span className="text-muted-foreground">Shipping:</span> {shippingAddr || '—'}
                </div>
              </div>
            )}
          </div>

          {/* Lines */}
          <div className="rounded-md border p-4 space-y-3">
            <h2 className="font-medium text-sm text-muted-foreground uppercase tracking-wide">Line Items</h2>
            {lines.length > 0 && (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-muted-foreground text-xs">
                    <th className="pb-2 text-left font-medium">Product</th>
                    {warehouseId && <th className="pb-2 text-right font-medium w-20">Available</th>}
                    <th className="pb-2 text-right font-medium w-16">Qty</th>
                    <th className="pb-2 text-right font-medium w-28">
                      Price ({sym}){pricesIncludeVat && vatRate > 0 ? ' incl.' : ''}
                    </th>
                    <th className="pb-2 text-right font-medium w-24">Discount</th>
                    <th className="pb-2 text-right font-medium w-24">Total ({sym})</th>
                    <th className="pb-2 text-right font-medium w-20">COGS (£)</th>
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {lines.map((line) => {
                    const stock = stockAt(line.productId)
                    const grossTotal = line.qty * line.unitPrice
                    const discAmount = parseDiscount(line.discount, grossTotal)
                    const lineTotal = grossTotal - discAmount
                    const cogs = (avgCogs[line.productId] ?? 0) * line.qty
                    return (
                      <tr key={line.key}>
                        <td className="py-2 pr-3">
                          <ProductLink productId={line.productId} sku={line.sku} name={line.name} />
                        </td>
                        {warehouseId && (
                          <td className={`py-2 pr-3 text-right text-xs tabular-nums ${stock.available < line.qty ? 'text-destructive font-medium' : 'text-muted-foreground'}`}>
                            {stock.available}
                          </td>
                        )}
                        <td className="py-2 pr-3">
                          <Input type="number" min="1" step="1" value={line.qty}
                            onChange={(e) => setLines((p) => p.map((l) => l.key === line.key ? { ...l, qty: Number(e.target.value) || 0 } : l))}
                            className="h-7 text-sm text-right w-16 ml-auto" />
                        </td>
                        <td className="py-2 pr-3">
                          <Input type="number" min="0" step="0.01" value={line.unitPrice}
                            onChange={(e) => setLines((p) => p.map((l) => l.key === line.key ? { ...l, unitPrice: Number(e.target.value) || 0 } : l))}
                            className="h-7 text-sm text-right w-28 ml-auto font-mono" />
                        </td>
                        <td className="py-2 pr-3">
                          <Input
                            value={line.discount}
                            onChange={(e) => setLines((p) => p.map((l) => l.key === line.key ? { ...l, discount: e.target.value } : l))}
                            placeholder="0 or 10%"
                            className={`h-7 text-sm text-right w-24 ml-auto font-mono ${discAmount > 0 ? 'text-destructive' : ''}`}
                          />
                        </td>
                        <td className="py-2 pr-3 text-right font-mono text-xs">{lineTotal.toFixed(2)}{sym}</td>
                        <td className="py-2 pr-3 text-right font-mono text-xs text-muted-foreground">£{cogs.toFixed(2)}</td>
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
            )}
            {/* Product search */}
            <div className="relative">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />
                <Input placeholder="Search product to add…" value={productSearch}
                  onChange={(e) => { setProductSearch(e.target.value); setShowSearch(true) }}
                  onFocus={() => setShowSearch(true)} className="pl-8 h-8 text-sm" />
              </div>
              {showSearch && productSearch && (
                <div className="absolute z-10 top-9 left-0 right-0 bg-popover border rounded-md shadow-md max-h-64 overflow-y-auto">
                  {filteredProducts.filter((p) => !lines.some((l) => l.productId === p.id)).map((p) => {
                    const stock = stockAt(p.id)
                    return (
                      <button key={p.id} type="button" className="w-full flex items-center justify-between px-3 py-2 hover:bg-accent text-sm text-left" onMouseDown={() => addProduct(p)}>
                        <span>
                          <span className="font-mono text-xs font-medium">{p.sku}</span>
                          <span className="ml-2 text-muted-foreground">{p.name}</span>
                        </span>
                        <span className="text-xs text-muted-foreground ml-2 shrink-0">
                          {warehouseId ? `${stock.available} avail` : ''}
                          {p.salesPriceGbp ? ` · £${Number(p.salesPriceGbp).toFixed(2)}` : ''}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Shipping & Fees */}
          <div className="rounded-md border p-4 space-y-3">
            <h2 className="font-medium text-sm text-muted-foreground uppercase tracking-wide">Shipping & Fees</h2>
            <div className="flex items-center gap-3">
              <Label className="w-24 shrink-0 text-sm">Shipping</Label>
              <Input
                value={shippingService}
                onChange={(e) => setShippingService(e.target.value)}
                placeholder="e.g. Royal Mail, DPD Next Day"
                className="flex-1 h-8 text-sm"
              />
              <Input type="number" min="0" step="0.01" value={shippingAmount}
                onChange={(e) => setShippingAmount(Number(e.target.value) || 0)}
                className="w-28 h-8 text-sm text-right font-mono" />
              <span className="text-xs text-muted-foreground shrink-0">{sym}</span>
              {taxRateId && (
                <span className="text-xs text-muted-foreground shrink-0">
                  {pricesIncludeVat ? 'incl.' : 'excl.'} VAT
                </span>
              )}
            </div>
            {fees.map((f) => (
              <div key={f.key} className="flex items-center gap-2">
                <Input placeholder="Fee description" value={f.description}
                  onChange={(e) => setFees((p) => p.map((ff) => ff.key === f.key ? { ...ff, description: e.target.value } : ff))}
                  className="flex-1 h-8 text-sm" />
                <Input type="number" min="0" step="0.01" value={f.amount}
                  onChange={(e) => setFees((p) => p.map((ff) => ff.key === f.key ? { ...ff, amount: Number(e.target.value) || 0 } : ff))}
                  className="w-28 h-8 text-sm text-right font-mono" />
                <span className="text-xs text-muted-foreground w-8">{sym}</span>
                <button type="button" onClick={() => setFees((p) => p.filter((ff) => ff.key !== f.key))} className="text-muted-foreground hover:text-destructive">
                  <X className="h-4 w-4" />
                </button>
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={() => setFees((p) => [...p, { key: makeKey(), description: '', amount: 0 }])}>
              <Plus className="h-3 w-3 mr-1" />Add Fee
            </Button>
          </div>

          {/* Totals */}
          {lines.length > 0 && (
            <div className="rounded-md border p-4">
              <div className="flex justify-end">
                <div className="text-sm space-y-1 min-w-72">
                  <div className="flex justify-between text-muted-foreground">
                    <span>Subtotal (net)</span>
                    <span className="font-mono">{linesSubtotalBeforeOrderDisc.toFixed(2)}{sym}</span>
                  </div>
                  {/* Order-level discount */}
                  <div className="flex justify-between items-center text-muted-foreground">
                    <span>Order Discount</span>
                    <div className="flex items-center gap-1.5">
                      <Input
                        value={orderDiscount}
                        onChange={(e) => setOrderDiscount(e.target.value)}
                        placeholder="0 or %"
                        className={`h-6 text-xs text-right w-20 font-mono ${orderDiscountAmount > 0 ? 'text-destructive' : ''}`}
                      />
                      {orderDiscountAmount > 0 && (
                        <span className="font-mono text-destructive text-xs">-{orderDiscountAmount.toFixed(2)}{sym}</span>
                      )}
                    </div>
                  </div>
                  {orderDiscountAmount > 0 && (
                    <div className="flex justify-between text-muted-foreground">
                      <span>Net after discount</span>
                      <span className="font-mono">{lineSubtotal.toFixed(2)}{sym}</span>
                    </div>
                  )}
                  {totalAllDiscounts > 0 && (
                    <div className="flex justify-between text-destructive text-xs">
                      <span>Total Discount{totalLineDiscounts > 0 && orderDiscountAmount > 0 ? ` (lines: ${totalLineDiscounts.toFixed(2)}${sym} + order: ${orderDiscountAmount.toFixed(2)}${sym})` : ''}</span>
                      <span className="font-mono">-{totalAllDiscounts.toFixed(2)}{sym}</span>
                    </div>
                  )}
                  {shippingAmount > 0 && (
                    <div className="flex justify-between text-muted-foreground">
                      <span>Shipping</span>
                      <span className="font-mono">{shippingAmount.toFixed(2)}{sym}</span>
                    </div>
                  )}
                  {feesTotal > 0 && (
                    <div className="flex justify-between text-muted-foreground">
                      <span>Fees</span>
                      <span className="font-mono">{feesTotal.toFixed(2)}{sym}</span>
                    </div>
                  )}
                  {totalVat > 0 && (
                    <div className="flex justify-between text-muted-foreground">
                      <span>VAT ({(vatRate * 100).toFixed(0)}%){pricesIncludeVat ? ' (extracted)' : ''}</span>
                      <span className="font-mono">{totalVat.toFixed(2)}{sym}</span>
                    </div>
                  )}
                  <div className="flex justify-between font-medium border-t pt-1">
                    <span>Total</span>
                    <span className="font-mono">
                      {grandTotal.toFixed(2)}{sym}
                      {currency !== 'GBP' && <span className="text-muted-foreground font-normal ml-2">(£{(grandTotal / fxRate).toFixed(2)})</span>}
                    </span>
                  </div>
                  <div className="flex justify-between text-muted-foreground border-t pt-1">
                    <span>Est. COGS</span>
                    <span className="font-mono">£{totalCogs.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between text-muted-foreground">
                    <span>Est. Margin</span>
                    <span className="font-mono">£{((lineSubtotal / fxRate) - totalCogs).toFixed(2)}</span>
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
            Create Order
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
