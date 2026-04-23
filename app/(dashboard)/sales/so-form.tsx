'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Search, X, Plus, Loader2, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { createSalesOrder } from '@/app/actions/sales'
import { createCustomer, type CustomerRow, type AddressData } from '@/app/actions/customers'
import type { ProductRow } from '@/app/actions/products'
import type { CurrencyRow } from '@/app/actions/currencies'
import type { TaxRateRow, UserOption } from '@/app/actions/settings'
import type { StockLevelEntry } from '@/app/actions/stock'
import { ProductLink } from '@/components/inventory/product-link'
import { formatCountryDisplay, toIsoCountryCode } from '@/lib/countries'
import { formatMoney } from '@/lib/utils'
import type { TaxCategory } from '@/app/generated/prisma/client'
import { useBaseCurrency } from '@/components/providers/base-currency-provider'

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
  companyHomeCountry?: string | null
  onClose: () => void
}

type LineItem = {
  key: string
  productId: string
  sku: string
  name: string
  qty: number
  unitPrice: number
  discount: string
  productCategory: TaxCategory
  taxRateId: string | null
  taxRateValue: number
  taxRateName: string | null
  taxRateWarning: string | null
  taxRateAutoResolved: boolean
}
type FeeLine = { key: string; description: string; amount: number }

type ResolvedRate = {
  taxRateId: string | null
  taxRateValue: number
  taxRateName: string | null
  warning: string | null
}

/**
 * Client-side mirror of lib/tax/resolve-rate.ts `pickTaxRate`. Keep the
 * algorithm identical — the server re-resolves from the DB so it's
 * authoritative, but the client needs it for live previews.
 */
function resolveRateClientSide(
  category: TaxCategory,
  destinationCountry: string | null,
  rates: TaxRateRow[],
  usedFor: 'SALES' | 'PURCHASE',
  orderDefault: { id: string | null; name: string | null; rate: number },
): ResolvedRate {
  // Normalize free-text values ("United Kingdom", "UK") to ISO-2
  const iso = toIsoCountryCode(destinationCountry)
  const dest = iso ? iso.toLowerCase() : (destinationCountry ? destinationCountry.toLowerCase() : null)
  const applicable = rates.filter((r) => {
    if (!r.active) return false
    const uf = (r.usedFor || 'BOTH').toUpperCase()
    if (uf === 'BOTH') return true
    return uf === usedFor
  })

  // Step 1: exact (country + category)
  if (dest) {
    const exact = applicable.find(
      (r) => r.countryCode != null && r.countryCode.toLowerCase() === dest && r.taxCategory === category,
    )
    if (exact) {
      return { taxRateId: exact.id, taxRateValue: exact.rate, taxRateName: exact.name, warning: null }
    }
  }

  // Step 2: country STANDARD — only if product category is STANDARD
  if (dest && category === 'STANDARD') {
    const cs = applicable.find(
      (r) => r.countryCode != null && r.countryCode.toLowerCase() === dest && r.taxCategory === 'STANDARD',
    )
    if (cs) {
      return { taxRateId: cs.id, taxRateValue: cs.rate, taxRateName: cs.name, warning: null }
    }
  }

  // Step 3: global rate for the category
  const g = applicable.find((r) => r.countryCode == null && r.taxCategory === category)
  if (g) {
    return { taxRateId: g.id, taxRateValue: g.rate, taxRateName: g.name, warning: null }
  }

  // Step 4: order default — flagged
  return {
    taxRateId: orderDefault.id,
    taxRateValue: orderDefault.rate,
    taxRateName: orderDefault.name,
    warning: `No configured sales rate for ${dest ? dest.toUpperCase() : 'unknown country'} / ${category}. Using order default.`,
  }
}

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
  return [a.line1, a.line2, a.city, a.postcode, formatCountryDisplay(a.country)].filter(Boolean).join(', ')
}

export function SoFormDialog({ products, warehouses, currencies, taxRates, customers, stockLevels, avgCogs, users, currentUserName, companyHomeCountry, onClose }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const baseCurrency = useBaseCurrency()

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
  const [currency, setCurrency] = useState(baseCurrency.code)
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

  // Destination country: shippingAddress.country → billingAddress.country → home
  const destCountry =
    (shippingAddrObj?.country && shippingAddrObj.country.trim()) ||
    (billingAddrObj?.country && billingAddrObj.country.trim()) ||
    companyHomeCountry ||
    null

  const salesRates = taxRates.filter((t) => t.usedFor === 'SALES' || t.usedFor === 'BOTH')

  const orderDefault = {
    id: taxRateId || null,
    name: selectedTaxRate?.name ?? null,
    rate: vatRate,
  }

  function resolveForCategory(cat: TaxCategory): ResolvedRate {
    return resolveRateClientSide(cat, destCountry, taxRates, 'SALES', orderDefault)
  }

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
      // New shipping country → re-resolve auto lines against the new
      // destination. Compute the new country inline since state updates
      // from setShippingAddrObj haven't flushed yet.
      const newDest =
        (c.shippingAddress?.country && c.shippingAddress.country.trim()) ||
        (c.billingAddress?.country && c.billingAddress.country.trim()) ||
        companyHomeCountry ||
        null
      setLines((prev) =>
        prev.map((l) => {
          if (!l.taxRateAutoResolved) return l
          const resolved = resolveRateClientSide(l.productCategory, newDest, taxRates, 'SALES', orderDefault)
          if (resolved.taxRateValue === l.taxRateValue && resolved.taxRateId === l.taxRateId) {
            return { ...l, taxRateWarning: resolved.warning }
          }
          return rescaleLineForRate(l, resolved.taxRateValue, {
            taxRateId: resolved.taxRateId,
            taxRateValue: resolved.taxRateValue,
            taxRateName: resolved.taxRateName,
            taxRateWarning: resolved.warning,
            taxRateAutoResolved: true,
          })
        }),
      )
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
    const resolved = resolveForCategory(p.taxCategory)
    const lineRate = resolved.taxRateValue
    // DB prices are net OR gross depending on the product's own
    // salesPriceTaxInclusive flag. Convert using the *resolved* line-level
    // rate so each line grosses-up with its own VAT.
    const dbPrice = p.salesPriceBase ? Number(p.salesPriceBase) : 0
    const dbIsGross = !!p.salesPriceTaxInclusive && lineRate > 0
    const net = dbIsGross ? dbPrice / (1 + lineRate) : dbPrice
    const display = pricesIncludeVat && lineRate > 0 ? net * (1 + lineRate) : net
    const priceInCurrency = display * (currency === baseCurrency.code ? 1 : fxRate)
    setLines((prev) => [
      ...prev,
      {
        key: makeKey(),
        productId: p.id,
        sku: p.sku,
        name: p.name,
        qty: 1,
        unitPrice: Math.round(priceInCurrency * 100) / 100,
        discount: '',
        productCategory: p.taxCategory,
        taxRateId: resolved.taxRateId,
        taxRateValue: resolved.taxRateValue,
        taxRateName: resolved.taxRateName,
        taxRateWarning: resolved.warning,
        taxRateAutoResolved: true,
      },
    ])
    setProductSearch('')
    setShowSearch(false)
  }

  /**
   * Manually override the tax rate for a single line. Sets taxRateAutoResolved=false
   * so subsequent country/default-rate changes don't clobber the user's choice.
   * Rescales the displayed unit price so the underlying net stays the same.
   */
  function setLineTaxRate(lineKey: string, newTaxRateId: string | 'auto') {
    setLines((prev) =>
      prev.map((l) => {
        if (l.key !== lineKey) return l
        if (newTaxRateId === 'auto') {
          const resolved = resolveForCategory(l.productCategory)
          return rescaleLineForRate(l, resolved.taxRateValue, {
            taxRateId: resolved.taxRateId,
            taxRateValue: resolved.taxRateValue,
            taxRateName: resolved.taxRateName,
            taxRateWarning: resolved.warning,
            taxRateAutoResolved: true,
          })
        }
        const picked = taxRates.find((t) => t.id === newTaxRateId)
        if (!picked) return l
        return rescaleLineForRate(l, picked.rate, {
          taxRateId: picked.id,
          taxRateValue: picked.rate,
          taxRateName: picked.name,
          taxRateWarning: null,
          taxRateAutoResolved: false,
        })
      }),
    )
  }

  /**
   * Scale a line's displayed unit price when its rate changes, but only
   * when the form is showing gross prices (so the underlying net stays put).
   */
  function rescaleLineForRate(
    line: LineItem,
    newRate: number,
    patch: Partial<LineItem>,
  ): LineItem {
    if (!pricesIncludeVat || line.taxRateValue === newRate) {
      return { ...line, ...patch }
    }
    const factor = (1 + newRate) / (1 + line.taxRateValue)
    return {
      ...line,
      ...patch,
      unitPrice: Math.round(line.unitPrice * factor * 100) / 100,
    }
  }

  // Toggle between "prices include VAT" and "prices exclude VAT". Scales each
  // line by *its own* rate (lines can now have different rates). Shipping
  // and fees use the order-level rate.
  function toggleIncludeVat(checked: boolean) {
    if (checked !== pricesIncludeVat) {
      setLines((prev) =>
        prev.map((l) => {
          if (l.taxRateValue <= 0) return l
          const factor = checked ? (1 + l.taxRateValue) : 1 / (1 + l.taxRateValue)
          return { ...l, unitPrice: Math.round(l.unitPrice * factor * 100) / 100 }
        }),
      )
      if (vatRate > 0) {
        const factor = checked ? (1 + vatRate) : 1 / (1 + vatRate)
        setShippingAmount((prev) => Math.round(prev * factor * 100) / 100)
        setFees((prev) => prev.map((f) => ({ ...f, amount: Math.round(f.amount * factor * 100) / 100 })))
      }
    }
    setPricesIncludeVat(checked)
  }

  // When the order-level VAT rate changes: re-resolve every auto-resolved
  // line (since the order default may now feed fallback lines) and scale
  // shipping/fees by the new default rate.
  function handleTaxRateChange(newId: string) {
    const newRate = taxRates.find((t) => t.id === newId)?.rate ?? 0
    if (pricesIncludeVat && vatRate !== newRate) {
      const factor = (1 + newRate) / (1 + vatRate)
      setShippingAmount((prev) => Math.round(prev * factor * 100) / 100)
      setFees((prev) => prev.map((f) => ({ ...f, amount: Math.round(f.amount * factor * 100) / 100 })))
    }
    setTaxRateId(newId)
    // Defer re-resolve until state settles: use the helper directly with
    // the new default baked in.
    const picked = taxRates.find((t) => t.id === newId)
    const newDefault = { id: newId || null, name: picked?.name ?? null, rate: newRate }
    setLines((prev) =>
      prev.map((l) => {
        if (!l.taxRateAutoResolved) return l
        const resolved = resolveRateClientSide(l.productCategory, destCountry, taxRates, 'SALES', newDefault)
        if (resolved.taxRateValue === l.taxRateValue && resolved.taxRateId === l.taxRateId) {
          return { ...l, taxRateWarning: resolved.warning }
        }
        return rescaleLineForRate(l, resolved.taxRateValue, {
          taxRateId: resolved.taxRateId,
          taxRateValue: resolved.taxRateValue,
          taxRateName: resolved.taxRateName,
          taxRateWarning: resolved.warning,
          taxRateAutoResolved: true,
        })
      }),
    )
  }

  function stockAt(productId: string): StockLevelEntry {
    return stockLevels[productId]?.[warehouseId] ?? { total: 0, available: 0 }
  }

  // Calculations — per line with its own VAT rate + discount
  function getLineNet(l: LineItem): number {
    const gross = l.qty * l.unitPrice
    const disc = parseDiscount(l.discount, gross)
    const afterDisc = gross - disc
    return pricesIncludeVat && l.taxRateValue > 0 ? afterDisc / (1 + l.taxRateValue) : afterDisc
  }
  function getLineGross(l: LineItem): number {
    const gross = l.qty * l.unitPrice
    return gross - parseDiscount(l.discount, gross)
  }
  function getLineVat(l: LineItem): number {
    if (pricesIncludeVat) {
      return getLineGross(l) - getLineNet(l)
    }
    return getLineNet(l) * l.taxRateValue
  }

  const linesSubtotalBeforeOrderDisc = lines.reduce((s, l) => s + getLineNet(l), 0)
  const linesGrossBeforeOrderDisc = lines.reduce((s, l) => s + getLineGross(l), 0)
  const orderDiscountAmount = parseDiscount(orderDiscount, linesGrossBeforeOrderDisc)
  const orderDiscountNet = pricesIncludeVat && vatRate > 0 ? orderDiscountAmount / (1 + vatRate) : orderDiscountAmount

  const lineSubtotal = linesSubtotalBeforeOrderDisc - orderDiscountNet
  // Line VAT is the sum of each line's own VAT, minus the VAT component of
  // the order discount (which uses the order-level rate).
  const rawLineVat = lines.reduce((s, l) => s + getLineVat(l), 0)
  const orderDiscountVat = pricesIncludeVat
    ? orderDiscountAmount - orderDiscountNet
    : (vatRate > 0 ? orderDiscountNet * vatRate : 0)
  const lineVat = rawLineVat - orderDiscountVat

  const feesTotal = fees.reduce((s, f) => s + f.amount, 0)
  const shippingNet = pricesIncludeVat && vatRate > 0 ? shippingAmount / (1 + vatRate) : shippingAmount
  const shippingVat = pricesIncludeVat
    ? shippingAmount - shippingNet
    : (vatRate > 0 ? shippingNet * vatRate : 0)
  const feesNet = pricesIncludeVat && vatRate > 0 ? feesTotal / (1 + vatRate) : feesTotal
  const feesVat = pricesIncludeVat
    ? feesTotal - feesNet
    : (vatRate > 0 ? feesNet * vatRate : 0)
  const totalVat = lineVat + shippingVat + feesVat
  // Grand total = net subtotal (post order discount) + net shipping + net
  // fees + total VAT. Earlier code double-counted shipping/fees VAT by
  // adding it both via totalVat and separately.
  const grandTotal = lineSubtotal + shippingNet + feesNet + totalVat
  const totalCogs = lines.reduce((s, l) => s + l.qty * (avgCogs[l.productId] ?? 0), 0)
  const totalLineDiscounts = lines.reduce((s, l) => s + parseDiscount(l.discount, l.qty * l.unitPrice), 0)
  const totalAllDiscounts = totalLineDiscounts + orderDiscountAmount

  const filteredProducts = products.filter((p) => {
    if (!productSearch) return true
    const q = productSearch.toLowerCase()
    return p.sku.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)
  }).slice(0, 20)

  function handleSubmit(isDraft: boolean = false) {
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
        fxRateToBase: fxRate,
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
        isDraft,
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
            taxRateId: l.taxRateAutoResolved ? null : l.taxRateId, // only send explicit overrides
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
      <DialogContent showCloseButton={false} className="w-[95vw] sm:w-[80vw] max-w-[95vw] sm:max-w-[80vw]">
        <DialogHeader>
          <DialogTitle>New Sales Order</DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          {/* Customer + Order details */}
          <div className="rounded-md border p-4 space-y-4">
            <h2 className="font-medium text-sm text-muted-foreground uppercase tracking-wide">Order Details</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 *:min-w-0">
              {/* Customer */}
              <div className="space-y-1.5">
                <Label>Customer *</Label>
                {!showNewCustomer ? (
                  <div className="flex gap-1.5">
                    <select value={customerId} onChange={(e) => handleCustomerChange(e.target.value)} className="flex-1 min-w-0 h-9 rounded-md border border-input bg-background px-3 text-sm">
                      <option value="">Select customer…</option>
                      {allCustomers.map((c) => (<option key={c.id} value={c.id}>{c.fullName}{c.company ? ` (${c.company})` : ''}</option>))}
                    </select>
                    <Button type="button" variant="outline" size="icon" className="h-9 w-9 shrink-0" onClick={() => setShowNewCustomer(true)} title="New customer">
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>
                ) : (
                  <div className="flex gap-1.5">
                    <Input placeholder="Customer name" value={newCustName} onChange={(e) => setNewCustName(e.target.value)} className="flex-1 min-w-0 h-9 text-sm" autoFocus
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleCreateCustomer() } }} />
                    <Button type="button" size="sm" className="h-9" onClick={handleCreateCustomer} disabled={creatingCust || !newCustName.trim()}>
                      {creatingCust ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Add'}
                    </Button>
                    <Button type="button" variant="outline" size="sm" className="h-9" onClick={() => { setShowNewCustomer(false); setNewCustName('') }}>Cancel</Button>
                  </div>
                )}
              </div>
              <div className="space-y-1.5">
                <Label>Currency{currency !== baseCurrency.code ? ' / FX Rate' : ''}</Label>
                <div className="flex gap-2">
                  <select value={currency} onChange={(e) => setCurrencyAndRate(e.target.value)} className={`${currency === baseCurrency.code ? 'w-full' : 'w-28'} h-9 rounded-md border border-input bg-background px-3 text-sm font-mono`}>
                    <option value={baseCurrency.code}>{baseCurrency.code} {baseCurrency.symbol}</option>
                    {currencies.filter((c) => c.code !== baseCurrency.code).map((c) => (<option key={c.code} value={c.code}>{c.code} {c.symbol}</option>))}
                  </select>
                  {currency !== baseCurrency.code && (
                    <Input type="number" min="0.0001" step="0.0001" value={fxRate} onChange={(e) => setFxRate(Number(e.target.value) || 1)} className="flex-1 min-w-0 h-9 font-mono text-sm" />
                  )}
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
                  <select value={taxRateId} onChange={(e) => handleTaxRateChange(e.target.value)} className="flex-1 min-w-0 h-9 rounded-md border border-input bg-background px-3 text-sm">
                    <option value="">No VAT</option>
                    {taxRates.filter((t) => t.usedFor === 'SALES' || t.usedFor === 'BOTH').map((t) => (
                      <option key={t.id} value={t.id}>{t.name} ({(t.rate * 100).toFixed(0)}%)</option>
                    ))}
                  </select>
                  {taxRateId && (
                    <label className="flex items-center gap-1.5 text-sm whitespace-nowrap cursor-pointer">
                      <input type="checkbox" checked={pricesIncludeVat} onChange={(e) => toggleIncludeVat(e.target.checked)} className="rounded border-input" />
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
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2 border-t">
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
              <Table className="min-w-[800px]">
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Product</TableHead>
                    {warehouseId && <TableHead className="text-xs text-center w-20">Available</TableHead>}
                    <TableHead className="text-xs text-center w-16">Qty</TableHead>
                    <TableHead className="text-xs text-center w-28">
                      Price ({sym}){pricesIncludeVat ? ' incl.' : ''}
                    </TableHead>
                    <TableHead className="text-xs text-center w-24">Discount</TableHead>
                    <TableHead className="text-xs text-center w-32">VAT</TableHead>
                    <TableHead className="text-xs text-right w-24">Total ({sym})</TableHead>
                    <TableHead className="text-xs text-right w-20">COGS ({baseCurrency.code})</TableHead>
                    <TableHead className="w-8" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lines.map((line) => {
                    const stock = stockAt(line.productId)
                    const grossTotal = line.qty * line.unitPrice
                    const discAmount = parseDiscount(line.discount, grossTotal)
                    const lineTotal = grossTotal - discAmount
                    const cogs = (avgCogs[line.productId] ?? 0) * line.qty
                    return (
                      <TableRow key={line.key}>
                        <TableCell>
                          <ProductLink productId={line.productId} sku={line.sku} name={line.name} />
                        </TableCell>
                        {warehouseId && (
                          <TableCell className={`text-right text-xs tabular-nums ${stock.available < line.qty ? 'text-destructive font-medium' : 'text-muted-foreground'}`}>
                            {stock.available}
                          </TableCell>
                        )}
                        <TableCell>
                          <Input type="number" min="1" step="1" value={line.qty}
                            onChange={(e) => setLines((p) => p.map((l) => l.key === line.key ? { ...l, qty: Number(e.target.value) || 0 } : l))}
                            className="h-7 text-sm text-right w-16 ml-auto" />
                        </TableCell>
                        <TableCell>
                          <Input type="number" min="0" step="0.01" value={line.unitPrice}
                            onChange={(e) => setLines((p) => p.map((l) => l.key === line.key ? { ...l, unitPrice: Number(e.target.value) || 0 } : l))}
                            className="h-7 text-sm text-right w-28 ml-auto font-mono" />
                        </TableCell>
                        <TableCell>
                          <Input
                            value={line.discount}
                            onChange={(e) => setLines((p) => p.map((l) => l.key === line.key ? { ...l, discount: e.target.value } : l))}
                            placeholder={`${sym} or %`}
                            className={`h-7 text-sm text-right w-24 ml-auto font-mono ${discAmount > 0 ? 'text-destructive' : ''}`}
                          />
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center justify-end gap-1">
                            {line.taxRateWarning && (
                              <span title={line.taxRateWarning} className="text-yellow-600">
                                <AlertTriangle className="h-3 w-3" />
                              </span>
                            )}
                            <select
                              value={line.taxRateAutoResolved ? 'auto' : (line.taxRateId ?? '')}
                              onChange={(e) => setLineTaxRate(line.key, e.target.value as string)}
                              className="h-7 text-xs rounded-md border border-input bg-background px-1.5 font-mono w-28"
                              title={line.taxRateWarning ?? `Auto-resolved from ${line.productCategory}`}
                            >
                              <option value="auto">Auto {(line.taxRateValue * 100).toFixed(0)}%</option>
                              {salesRates.map((t) => (
                                <option key={t.id} value={t.id}>{t.name} ({(t.rate * 100).toFixed(0)}%)</option>
                              ))}
                            </select>
                          </div>
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs">{money(lineTotal)}</TableCell>
                        <TableCell className="text-right font-mono text-xs text-muted-foreground">{formatMoney(cogs, baseCurrency.symbol, baseCurrency.symbolPosition)}</TableCell>
                        <TableCell>
                          <button type="button" onClick={() => setLines((p) => p.filter((l) => l.key !== line.key))} className="text-muted-foreground hover:text-destructive">
                            <X className="h-4 w-4" />
                          </button>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
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
                          {p.salesPriceBase ? ` · ${formatMoney(Number(p.salesPriceBase), baseCurrency.symbol, baseCurrency.symbolPosition)}` : ''}
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
            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              <Label className="w-full sm:w-24 shrink-0 text-sm">Shipping</Label>
              <Input
                value={shippingService}
                onChange={(e) => setShippingService(e.target.value)}
                placeholder="e.g. Royal Mail, DPD Next Day"
                className="flex-1 min-w-[140px] h-8 text-sm"
              />
              <div className="flex items-center gap-2">
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
            </div>
            {fees.map((f) => (
              <div key={f.key} className="flex flex-wrap items-center gap-2">
                <Input placeholder="Fee description" value={f.description}
                  onChange={(e) => setFees((p) => p.map((ff) => ff.key === f.key ? { ...ff, description: e.target.value } : ff))}
                  className="flex-1 min-w-[140px] h-8 text-sm" />
                <div className="flex items-center gap-2">
                  <Input type="number" min="0" step="0.01" value={f.amount}
                    onChange={(e) => setFees((p) => p.map((ff) => ff.key === f.key ? { ...ff, amount: Number(e.target.value) || 0 } : ff))}
                    className="w-28 h-8 text-sm text-right font-mono" />
                  <span className="text-xs text-muted-foreground w-8">{sym}</span>
                  <button type="button" onClick={() => setFees((p) => p.filter((ff) => ff.key !== f.key))} className="text-muted-foreground hover:text-destructive">
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={() => setFees((p) => [...p, { key: makeKey(), description: '', amount: 0 }])}>
              <Plus className="h-3 w-3 mr-1" />Add Fee
            </Button>
          </div>

          {/* Totals */}
          {lines.length > 0 && (
            <div className="rounded-md border p-4">
              <div className="flex sm:justify-end">
                <div className="text-sm space-y-1 w-full sm:min-w-72 sm:w-auto">
                  <div className="flex justify-between text-muted-foreground">
                    <span>Subtotal{pricesIncludeVat ? '' : ' (net)'}</span>
                    <span className="font-mono">{money(linesGrossBeforeOrderDisc)}</span>
                  </div>
                  {/* Order-level discount */}
                  <div className="flex justify-between items-center text-muted-foreground">
                    <span>Order Discount</span>
                    <div className="flex items-center gap-1.5">
                      <Input
                        value={orderDiscount}
                        onChange={(e) => setOrderDiscount(e.target.value)}
                        placeholder={`${sym} or %`}
                        className={`h-6 text-xs text-right w-20 font-mono ${orderDiscountAmount > 0 ? 'text-destructive' : ''}`}
                      />
                      {orderDiscountAmount > 0 && (
                        <span className="font-mono text-destructive text-xs">{money(-orderDiscountAmount)}</span>
                      )}
                    </div>
                  </div>
                  {totalAllDiscounts > 0 && (
                    <div className="flex justify-between text-destructive text-xs">
                      <span>Total Discount{totalLineDiscounts > 0 && orderDiscountAmount > 0 ? ` (lines: ${money(totalLineDiscounts)} + order: ${money(orderDiscountAmount)})` : ''}</span>
                      <span className="font-mono">{money(-totalAllDiscounts)}</span>
                    </div>
                  )}
                  {shippingAmount > 0 && (
                    <div className="flex justify-between text-muted-foreground">
                      <span>Shipping</span>
                      <span className="font-mono">{money(shippingAmount)}</span>
                    </div>
                  )}
                  {feesTotal > 0 && (
                    <div className="flex justify-between text-muted-foreground">
                      <span>Fees</span>
                      <span className="font-mono">{money(feesTotal)}</span>
                    </div>
                  )}
                  {totalVat > 0 && (() => {
                    // Group line VAT by rate for the totals breakdown.
                    const byRate = new Map<number, number>()
                    for (const l of lines) {
                      const v = getLineVat(l)
                      if (v === 0) continue
                      byRate.set(l.taxRateValue, (byRate.get(l.taxRateValue) ?? 0) + v)
                    }
                    // Shipping + fees + order-discount VAT lumped with the order default.
                    const otherVat = shippingVat + feesVat - orderDiscountVat
                    if (otherVat !== 0) {
                      byRate.set(vatRate, (byRate.get(vatRate) ?? 0) + otherVat)
                    }
                    const rows = Array.from(byRate.entries())
                      .filter(([, amt]) => Math.abs(amt) > 0.005)
                      .sort(([a], [b]) => b - a)
                    return rows.map(([rate, amt]) => (
                      <div key={rate} className="flex justify-between text-muted-foreground">
                        <span>VAT @ {(rate * 100).toFixed(0)}%{pricesIncludeVat ? ' (extracted)' : ''}</span>
                        <span className="font-mono">{money(amt)}</span>
                      </div>
                    ))
                  })()}
                  <div className="flex justify-between font-medium border-t pt-1">
                    <span>Total</span>
                    <span className="font-mono">
                      {money(grandTotal)}
                      {currency !== baseCurrency.code && <span className="text-muted-foreground font-normal ml-2">({formatMoney(grandTotal / fxRate, baseCurrency.symbol, baseCurrency.symbolPosition)})</span>}
                    </span>
                  </div>
                  <div className="flex justify-between text-muted-foreground border-t pt-1">
                    <span>Est. COGS</span>
                    <span className="font-mono">{formatMoney(totalCogs, baseCurrency.symbol, baseCurrency.symbolPosition)}</span>
                  </div>
                  <div className="flex justify-between text-muted-foreground">
                    <span>Est. Margin</span>
                    <span className="font-mono">{formatMoney((lineSubtotal / fxRate) - totalCogs, baseCurrency.symbol, baseCurrency.symbolPosition)}</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isPending}>Cancel</Button>
          <Button variant="outline" onClick={() => handleSubmit(true)} disabled={isPending}>
            {isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Save as Draft
          </Button>
          <Button onClick={() => handleSubmit(false)} disabled={isPending}>
            {isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Create Order
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
