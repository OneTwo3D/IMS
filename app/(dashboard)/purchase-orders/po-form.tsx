'use client'

import { useState, useTransition, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Search, X, Plus, Loader2, AlertTriangle } from 'lucide-react'
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
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { createPurchaseOrder, updatePurchaseOrder, getSupplierLastPrices, type PoDetail } from '@/app/actions/purchase-orders'
import { createSupplier, type SupplierRow } from '@/app/actions/suppliers'
import type { ProductRow } from '@/app/actions/products'
import type { CurrencyRow } from '@/app/actions/currencies'
import type { TaxRateRow, PurchaseUnitRow } from '@/app/actions/settings'
import { ProductLink } from '@/components/inventory/product-link'
import { formatMoney } from '@/lib/utils'
import { useBaseCurrency } from '@/components/providers/base-currency-provider'
import { formatCountryDisplay, toIsoCountryCode } from '@/lib/countries'
import type { TaxCategory } from '@/app/generated/prisma/client'

type Warehouse = { id: string; code: string; name: string; country?: string | null; contactName?: string | null; email?: string | null; phone?: string | null; addressLine1?: string | null; addressLine2?: string | null; city?: string | null; postcode?: string | null }

type Props = {
  suppliers: SupplierRow[]
  products: ProductRow[]
  warehouses: Warehouse[]
  currencies: CurrencyRow[]
  taxRates: TaxRateRow[]
  purchaseUnits: PurchaseUnitRow[]
  /** Fallback destination country when the receiving warehouse has none. */
  companyHomeCountry?: string | null
  onClose: () => void
  /**
   * When set, the dialog opens in **edit mode** — prefilled with the saved
   * PO and wired to call `updatePurchaseOrder` on save instead of creating
   * a new PO. Only DRAFT POs can be edited.
   */
  existingPo?: PoDetail | null
}

type LineItem = {
  key: string
  productId: string
  sku: string
  productName: string
  qty: number // purchase qty (in purchase units, or stock units if no unit)
  purchaseUnitId: string // '' = stock units
  unitCostForeign: number // cost per purchase unit
  discount: string // user-entered discount, e.g. "5%" or "2.50"
  productCategory: TaxCategory
  // Per-line tax rate. When `taxRateAutoResolved` is true, the line follows
  // the order/supplier rate; when false the user has manually overridden it.
  taxRateId: string | null
  taxRateValue: number
  taxRateName: string | null
  taxRateWarning: string | null
  taxRateAutoResolved: boolean
}

type ResolvedRate = {
  taxRateId: string | null
  taxRateValue: number
  taxRateName: string | null
  warning: string | null
}

/**
 * Live tax-rate preview for a line. Purchases follow the order/supplier rate
 * directly (see the early return below); sales mirror lib/tax/resolve-rate.ts
 * `pickTaxRate`. The server re-resolves from the DB and is authoritative.
 */
function resolveRateClientSide(
  category: TaxCategory,
  destinationCountry: string | null,
  rates: TaxRateRow[],
  usedFor: 'SALES' | 'PURCHASE',
  orderDefault: { id: string | null; name: string | null; rate: number },
): ResolvedRate {
  // Purchases: the supplier's Default VAT Rate (carried as the order-level rate)
  // is authoritative for every line. There is no destination-country/category
  // auto-resolution for POs — a "No VAT" supplier (orderDefault.id null, rate 0)
  // yields 0% on every line, and a manual per-line override still wins upstream.
  if (usedFor === 'PURCHASE') {
    return {
      taxRateId: orderDefault.id,
      taxRateValue: orderDefault.rate,
      taxRateName: orderDefault.name,
      warning: null,
    }
  }

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
    warning: `No configured purchase rate for ${dest ? dest.toUpperCase() : 'unknown country'} / ${category}. Using order default.`,
  }
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

/** Parse a discount string: "10%" → percentage of lineTotal, "5" → absolute amount. */
function parseDiscount(input: string, lineTotal: number): number {
  const s = input.trim()
  if (!s) return 0
  if (s.endsWith('%')) {
    const pct = parseFloat(s.slice(0, -1))
    return isNaN(pct) ? 0 : Math.round((lineTotal * pct / 100) * 10000) / 10000
  }
  const abs = parseFloat(s)
  return isNaN(abs) ? 0 : abs
}

export function PoFormDialog({ suppliers, products, warehouses, currencies, taxRates: taxRatesProp, purchaseUnits, companyHomeCountry, onClose, existingPo }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const isEditMode = !!existingPo
  const baseCurrency = useBaseCurrency()

  // When editing, the PO HEADER carries the supplier's Default VAT Rate (the
  // order-level rate that is authoritative for every line). Match it from the
  // header's stored name + percent — never from a line's rate, since a line may
  // hold a stale rate from before this PO's supplier was set to "No VAT", and
  // never by name alone: a rate may have been deactivated and replaced by an
  // active same-name rate at a different percent (e.g. "VAT" 21% → 20%), and a
  // name-only match would silently re-rate the PO. A name-with-different-percent
  // therefore falls through to synthesis, which preserves the exact saved
  // percent. A header with no tax (No VAT supplier) leaves this undefined → 0.
  const headerPercent = existingPo?.taxRatePercent ?? 0
  const headerHasTax = !!(existingPo && (existingPo.taxRateName || headerPercent > 0))
  const matchedHeaderRate = existingPo?.taxRateName
    ? taxRatesProp.find(
        (t) => t.name === existingPo.taxRateName
          && Math.abs(t.rate - headerPercent) < 0.0001,
      )
    : undefined

  // If the PO's header rate is no longer represented by an active rate at the
  // saved percent (deactivated, percent edited in place, or a percent-only
  // legacy header), preserve it as a synthetic selectable rate so editing the
  // PO doesn't silently drop or change its VAT. Only reuse the line's real
  // taxRateId when it points to a GENUINELY INACTIVE rate (so the server, which
  // resolves ids without an active filter, restores its full metadata). If that
  // id is still active (its percent has since drifted), use a sentinel instead
  // so the server falls back to the submitted percent rather than the live one.
  // Only recover a real id by header NAME (a null-name header can't be matched
  // to a specific rate, so it must use the sentinel + submitted percent).
  const recoveredLineRateId = existingPo?.taxRateName
    ? existingPo.lines.find((l) => l.taxRateName === existingPo.taxRateName)?.taxRateId ?? null
    : null
  const recoveredIdIsInactive =
    !!recoveredLineRateId && !taxRatesProp.some((t) => t.id === recoveredLineRateId)
  const inactiveHeaderRate: TaxRateRow | undefined =
    headerHasTax && !matchedHeaderRate
      ? {
          id: recoveredIdIsInactive
            ? (recoveredLineRateId as string)
            : `inactive:${existingPo!.taxRateName ?? `${Math.round(headerPercent * 100)}pct`}`,
          name: existingPo!.taxRateName ?? `VAT ${(headerPercent * 100).toFixed(0)}%`,
          rate: headerPercent,
          type: 'PERCENT',
          usedFor: 'PURCHASE',
          accountingTaxType: null,
          countryCode: null,
          taxCategory: 'STANDARD',
          isCompound: false,
          reverseCharge: false,
          reportingCategory: null,
          isDefault: false,
          active: false,
          components: [],
        }
      : undefined

  const initialTaxRate = matchedHeaderRate ?? inactiveHeaderRate
  // The working rate list includes the preserved inactive rate (if any) so the
  // header dropdown and every internal lookup can represent it.
  const taxRates = inactiveHeaderRate ? [inactiveHeaderRate, ...taxRatesProp] : taxRatesProp

  // Header state — prefilled from existingPo when editing
  const [supplierId, setSupplierId] = useState(existingPo?.supplierId ?? '')
  const [currency, setCurrency] = useState(existingPo?.currency ?? baseCurrency.code)
  const [fxRate, setFxRate] = useState(existingPo?.fxRateToBase ?? 1)
  const [destinationWarehouseId, setDestinationWarehouseId] = useState(existingPo?.destinationWarehouseId ?? '')
  const [supplierRef, setSupplierRef] = useState(existingPo?.supplierRef ?? '')
  const [skipPreferredSupplierUpdate, setSkipPreferredSupplierUpdate] = useState(existingPo?.skipPreferredSupplierUpdate ?? false)
  const [expectedDelivery, setExpectedDelivery] = useState(
    existingPo?.expectedDelivery ? existingPo.expectedDelivery.slice(0, 10) : '',
  )
  const [notes, setNotes] = useState(existingPo?.notes ?? '')
  const [internalNotes, setInternalNotes] = useState(existingPo?.internalNotes ?? '')

  // VAT — in edit mode we show stored NET prices (since that's how the DB
  // persists them), so pricesIncludeVat starts `false` regardless of how
  // the original PO was created.
  const [taxRateId, setTaxRateId] = useState(initialTaxRate?.id ?? '')
  const [pricesIncludeVat, setPricesIncludeVat] = useState(false)

  // Order-level discount — stored input string + live parsing against the
  // lines subtotal. Seeded from `existingPo` when editing.
  const [orderDiscount, setOrderDiscount] = useState(existingPo?.orderDiscountStr ?? '')

  // Landed costs — seeded from freightCostLines. Falls back to a single
  // aggregate row when the PO pre-dates per-line storage.
  const [additionalCosts, setAdditionalCosts] = useState<AdditionalCost[]>(() => {
    if (!existingPo) return []
    if (existingPo.freightCostLines.length > 0) {
      return existingPo.freightCostLines.map((cl) => ({
        key: makeKey(),
        description: cl.description,
        amountForeign: cl.amountForeign,
        vatable: cl.vatable,
        distributionMethod: cl.distributionMethod,
      }))
    }
    if (existingPo.directFreightForeign > 0) {
      return [{
        key: makeKey(),
        description: 'Additional cost',
        amountForeign: existingPo.directFreightForeign,
        vatable: false,
        distributionMethod: 'BY_VALUE',
      }]
    }
    return []
  })

  // Lines — seeded from existingPo with pre-discount unit cost reconstructed
  // so the user can re-edit the discount. Stored `unitCostForeign` is
  // always NET-of-VAT per stock unit, so the edit form starts in
  // "prices exclude VAT" mode.
  const [lines, setLines] = useState<LineItem[]>(() => {
    if (!existingPo) return []
    // Purchases follow the supplier's Default VAT Rate (the order-level rate)
    // for every line — there is no per-line auto-resolution and no persisted
    // per-line override flag, so on reopen every line re-derives its VAT from
    // the order default. This is what makes a "No VAT" supplier stick across
    // save → edit → reopen (a stale 20% line rate is dropped, not preserved).
    const lineOrderDefault = {
      id: initialTaxRate?.id ?? null,
      name: initialTaxRate?.name ?? existingPo.taxRateName ?? null,
      rate: initialTaxRate?.rate ?? 0,
    }
    return existingPo.lines.map((l) => {
      // Reconstruct pre-discount unit cost: the stored value is
      // (qty * unitCost - discount) / qty, so adding discount/qty back
      // gives the original entry.
      const preUnitCost = l.qty > 0 && l.discountAmount > 0
        ? Math.round((l.unitCostForeign + l.discountAmount / l.qty) * 10000) / 10000
        : l.unitCostForeign
      // Reconstruct purchase-unit qty/cost if the line used one.
      const purchaseUnitId = l.purchaseUnitId ?? ''
      const puFactor = purchaseUnitId
        ? (purchaseUnits.find((u) => u.id === purchaseUnitId)?.conversionFactor ?? 1)
        : 1
      const displayQty = purchaseUnitId && l.purchaseUnitQty != null ? Number(l.purchaseUnitQty) : l.qty
      const displayUnitCost = purchaseUnitId ? preUnitCost * puFactor : preUnitCost
      const product = products.find((p) => p.id === l.productId)
      return {
        key: makeKey(),
        productId: l.productId,
        sku: l.sku,
        productName: l.productName,
        qty: displayQty,
        purchaseUnitId,
        unitCostForeign: Math.round(displayUnitCost * 10000) / 10000,
        discount: l.discountStr ?? '',
        productCategory: (product?.taxCategory ?? 'STANDARD') as TaxCategory,
        // Re-derive line VAT from the order/supplier default on load (auto), so
        // it always tracks the supplier's Default VAT Rate. The net unit cost is
        // unchanged; only the VAT applied on top follows the order rate.
        taxRateId: lineOrderDefault.id,
        taxRateValue: lineOrderDefault.rate,
        taxRateName: lineOrderDefault.name,
        taxRateWarning: null,
        taxRateAutoResolved: true,
      }
    })
  })
  const [productSearch, setProductSearch] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const [lastPrices, setLastPrices] = useState<Record<string, { lastUnitCost: number; currency: string }>>({})

  const [error, setError] = useState('')

  // Load last-price map in edit mode so the "add product" search shows the
  // supplier's previous prices straight away.
  useEffect(() => {
    if (!existingPo) return
    getSupplierLastPrices(existingPo.supplierId)
      .then((prices) => setLastPrices(prices))
      .catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Local supplier list (can grow when user adds inline)
  const [allSuppliers, setAllSuppliers] = useState(suppliers)
  const [showNewSupplier, setShowNewSupplier] = useState(false)
  const [newSupplierName, setNewSupplierName] = useState('')
  const [newSupplierCurrency, setNewSupplierCurrency] = useState(baseCurrency.code)
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
      setNewSupplierCurrency(baseCurrency.code)
    }
  }

  const selectedTaxRate = taxRates.find((t) => t.id === taxRateId)
  const vatRate = selectedTaxRate?.rate ?? 0

  const purchaseRates = taxRates.filter((t) => t.usedFor === 'PURCHASE' || t.usedFor === 'BOTH')

  // Destination country = receiving warehouse → company home country.
  const destWarehouse = warehouses.find((w) => w.id === destinationWarehouseId)
  const destCountry =
    (destWarehouse?.country && destWarehouse.country.trim()) ||
    companyHomeCountry ||
    null

  const orderDefault = {
    id: taxRateId || null,
    name: selectedTaxRate?.name ?? null,
    rate: vatRate,
  }

  function resolveForCategory(cat: TaxCategory): ResolvedRate {
    return resolveRateClientSide(cat, destCountry, taxRates, 'PURCHASE', orderDefault)
  }

  // Currency symbol + position lookup
  const symbolMap: Record<string, string> = { [baseCurrency.code]: baseCurrency.symbol }
  const positionMap: Record<string, 'PREFIX' | 'POSTFIX'> = { [baseCurrency.code]: baseCurrency.symbolPosition }
  for (const c of currencies) {
    symbolMap[c.code] = c.symbol
    positionMap[c.code] = c.symbolPosition
  }
  const sym = symbolMap[currency] ?? currency
  const symPos = positionMap[currency] ?? 'PREFIX'
  const money = (n: number) => formatMoney(n, sym, symPos)

  // Build rate lookup
  const rateMap: Record<string, number> = { [baseCurrency.code]: 1 }
  for (const c of currencies) {
    if (c.latestRate != null) rateMap[c.code] = c.latestRate
  }

  function setCurrencyAndRate(code: string) {
    setCurrency(code)
    if (code === baseCurrency.code) setFxRate(1)
    else if (rateMap[code]) setFxRate(rateMap[code])
  }

  async function handleSupplierChange(id: string) {
    setSupplierId(id)
    const s = allSuppliers.find((sup) => sup.id === id)
    if (s) {
      setCurrencyAndRate(s.currency)
      // Route through handleTaxRateChange so existing auto lines re-resolve to
      // the new supplier's Default VAT Rate (keeps the live preview in step
      // with what the server will persist).
      handleTaxRateChange(s.taxRateId ?? '')
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
    const productCategory = (p.taxCategory ?? 'STANDARD') as TaxCategory
    const resolved = resolveForCategory(productCategory)
    const lineRate = resolved.taxRateValue
    // SupplierProduct.lastUnitCost is always stored NET of VAT. When the
    // form is in "prices incl. VAT" mode, gross up for display using the
    // line-level rate (so each line grosses up with its own VAT).
    const lastPrice = lastPrices[p.id]
    const netCost = lastPrice?.lastUnitCost ?? 0
    const displayCost = pricesIncludeVat && lineRate > 0 ? netCost * (1 + lineRate) : netCost
    setLines((prev) => [...prev, {
      key: makeKey(), productId: p.id, sku: p.sku, productName: p.name,
      qty: 1, purchaseUnitId: '', unitCostForeign: Math.round(displayCost * 10000) / 10000,
      discount: '',
      productCategory,
      taxRateId: resolved.taxRateId,
      taxRateValue: resolved.taxRateValue,
      taxRateName: resolved.taxRateName,
      taxRateWarning: resolved.warning,
      taxRateAutoResolved: true,
    }])
    setProductSearch('')
    setShowSearch(false)
  }

  /**
   * Scale a line's displayed unit cost when its rate changes, but only
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
      unitCostForeign: Math.round(line.unitCostForeign * factor * 10000) / 10000,
    }
  }

  /**
   * Per-line tax rate picker. 'auto' makes the line follow the order/supplier
   * rate; an explicit id is a manual override for this line.
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

  // Toggling the "incl. VAT" checkbox must rescale existing line prices so
  // the displayed values reflect the new mode. Each line scales by *its own*
  // rate (lines can have different rates).
  function toggleIncludeVat(checked: boolean) {
    if (checked !== pricesIncludeVat) {
      setLines((prev) =>
        prev.map((l) => {
          if (l.taxRateValue <= 0) return l
          const factor = checked ? (1 + l.taxRateValue) : 1 / (1 + l.taxRateValue)
          return { ...l, unitCostForeign: Math.round(l.unitCostForeign * factor * 10000) / 10000 }
        }),
      )
    }
    setPricesIncludeVat(checked)
  }

  // When the order-level VAT rate changes: re-resolve every auto-resolved
  // line (the order default may now feed fallback lines). Lines with a
  // manual override keep their own rate.
  function handleTaxRateChange(newId: string) {
    const picked = taxRates.find((t) => t.id === newId)
    const newRate = picked?.rate ?? 0
    setTaxRateId(newId)
    const newDefault = { id: newId || null, name: picked?.name ?? null, rate: newRate }
    setLines((prev) =>
      prev.map((l) => {
        if (!l.taxRateAutoResolved) return l
        const resolved = resolveRateClientSide(l.productCategory, destCountry, taxRates, 'PURCHASE', newDefault)
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

  // The receiving warehouse no longer affects purchase line VAT (lines follow
  // the order/supplier rate, not the destination country), so this only updates
  // the warehouse selection.
  function handleDestinationWarehouseChange(newId: string) {
    setDestinationWarehouseId(newId)
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

  // Calculations — each line uses its own per-line rate.
  function getLineGrossAfterDiscount(l: LineItem): number {
    const gross = l.qty * l.unitCostForeign
    return Math.max(0, gross - parseDiscount(l.discount, gross))
  }
  function getLineNet(l: LineItem): number {
    const rate = l.taxRateValue
    const grossAfterDisc = getLineGrossAfterDiscount(l)
    return pricesIncludeVat && rate > 0 ? grossAfterDisc / (1 + rate) : grossAfterDisc
  }
  function getLineVat(l: LineItem): number {
    const rate = l.taxRateValue
    if (pricesIncludeVat) return getLineGrossAfterDiscount(l) - getLineNet(l)
    return getLineNet(l) * rate
  }
  const lineSubtotalPreOrderDisc = lines.reduce((sum, l) => sum + getLineNet(l), 0)
  const lineGrossPreOrderDisc = lines.reduce((sum, l) => sum + getLineGrossAfterDiscount(l), 0)
  const rawLineVat = lines.reduce((sum, l) => sum + getLineVat(l), 0)

  // Order-level discount — parsed against the line gross (so "10%" means
  // 10% off the visible line subtotal). Split proportionally across net
  // + VAT so downstream per-rate totals each drop by the same percentage.
  const orderDiscountInputAmount = parseDiscount(orderDiscount, lineGrossPreOrderDisc)
  const orderDiscountGrossAmount = Math.min(orderDiscountInputAmount, lineGrossPreOrderDisc)
  const orderDiscountNetForeign = (() => {
    if (orderDiscountGrossAmount <= 0) return 0
    if (pricesIncludeVat) {
      // Input is a gross amount; the "net share" of the gross base.
      const netFrac = lineGrossPreOrderDisc > 0 ? lineSubtotalPreOrderDisc / lineGrossPreOrderDisc : 1
      return Math.round(orderDiscountGrossAmount * netFrac * 10000) / 10000
    }
    // When excl. VAT the input is already in net terms; it scales down
    // net + VAT proportionally on the subtract side.
    return orderDiscountGrossAmount
  })()
  const orderDiscountVatForeign = (() => {
    if (orderDiscountGrossAmount <= 0) return 0
    if (pricesIncludeVat) {
      return Math.round((orderDiscountGrossAmount - orderDiscountNetForeign) * 10000) / 10000
    }
    // For excl. VAT orders the user entered a net discount — compute the
    // VAT component it corresponds to using the blended line rate.
    const netBase = lineSubtotalPreOrderDisc
    const blendedVatRate = netBase > 0 ? rawLineVat / netBase : 0
    return Math.round(orderDiscountNetForeign * blendedVatRate * 10000) / 10000
  })()
  // Full foreign value of the discount in the same convention the user
  // entered it (stored verbatim on the order so the PO's discountAmount
  // matches what was typed).
  const orderDiscountForeign = orderDiscountGrossAmount

  const lineSubtotalForeign = Math.max(0, lineSubtotalPreOrderDisc - orderDiscountNetForeign)
  const taxTotalForeign = Math.max(0, rawLineVat - orderDiscountVatForeign)
  const totalLineDiscounts = lines.reduce(
    (sum, l) => sum + parseDiscount(l.discount, l.qty * l.unitCostForeign),
    0,
  )
  const totalAllDiscounts = totalLineDiscounts + orderDiscountGrossAmount

  const additionalCostNet = additionalCosts.reduce((sum, ac) => sum + ac.amountForeign, 0)
  const additionalCostVat = additionalCosts.reduce((sum, ac) => ac.vatable && vatRate > 0 ? sum + ac.amountForeign * vatRate : sum, 0)
  const additionalCostTotal = additionalCostNet + additionalCostVat
  const grandTotalForeign = lineSubtotalForeign + taxTotalForeign + additionalCostTotal
  const grandTotalBase = grandTotalForeign / fxRate

  const filteredProducts = products.filter((p) => {
    if (!productSearch) return true
    const q = productSearch.toLowerCase()
    return p.sku.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)
  }).slice(0, 20)

  async function handleSubmit() {
    setError('')
    if (!supplierId) { setError('Please select a supplier'); return }
    if (!lines.length) { setError('Add at least one product line'); return }

    const payload = {
      supplierId,
      currency,
      fxRateToBase: fxRate,
      destinationWarehouseId: destinationWarehouseId || undefined,
      supplierRef: supplierRef || undefined,
      skipPreferredSupplierUpdate,
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
      orderDiscountStr: orderDiscount || undefined,
      orderDiscountForeign,
      lines: lines.map((l, i) => {
        // Discount is computed against the displayed line gross (in
        // purchase-unit cost terms). Since `qty * unitCostForeign` is
        // invariant across the purchase-unit conversion, the absolute
        // discount value passes through unchanged.
        const gross = l.qty * l.unitCostForeign
        const discAmount = parseDiscount(l.discount, gross)
        return {
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
          discountStr: l.discount || undefined,
          discountAmount: discAmount > 0 ? discAmount : undefined,
          // Only send the id when the user has manually overridden this line.
          // Auto lines pass null so the server applies the order/supplier rate.
          taxRateId: l.taxRateAutoResolved ? null : l.taxRateId,
        }
      }),
    }

    startTransition(async () => {
      if (isEditMode && existingPo) {
        const result = await updatePurchaseOrder(existingPo.id, payload)
        if (result.success) {
          router.refresh()
          onClose()
        } else {
          setError(result.error ?? 'Failed to update PO')
        }
      } else {
        const result = await createPurchaseOrder(payload)
        if (result.success && result.po) {
          router.refresh()
          onClose()
          router.push(`/purchase-orders/${result.po.id}`)
        } else {
          setError(result.error ?? 'Failed to create PO')
        }
      }
    })
  }

  return (
    <Dialog open onOpenChange={() => {}}>
    <DialogContent showCloseButton={false} className="w-[95vw] sm:w-[80vw] max-w-[95vw] sm:max-w-[80vw]">
    <DialogHeader>
      <DialogTitle>{isEditMode ? `Edit Purchase Order — ${existingPo?.reference ?? ''}` : 'New Purchase Order'}</DialogTitle>
    </DialogHeader>
    <div className="space-y-6">
      {/* Header fields */}
      <div className="rounded-md border p-4 space-y-4">
        <h2 className="font-medium text-sm text-muted-foreground uppercase tracking-wide">PO Details</h2>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 *:min-w-0">
          <div className="space-y-1.5">
            <Label htmlFor="supplier">Supplier *</Label>
            {!showNewSupplier ? (
              <div className="flex gap-1.5">
                <select
                  id="supplier"
                  value={supplierId}
                  onChange={(e) => handleSupplierChange(e.target.value)}
                  className="flex-1 min-w-0 h-9 rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">Select supplier…</option>
                  {allSuppliers.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
                <Button type="button" variant="outline" size="icon" className="h-9 w-9 shrink-0" onClick={() => setShowNewSupplier(true)} title="New supplier">
                  <Plus className="h-4 w-4" />
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
                  <option value={baseCurrency.code}>{baseCurrency.code}</option>
                  {currencies.filter((c) => c.code !== baseCurrency.code).map((c) => (
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
            <div className="flex items-center gap-3">
              <select
                value={taxRateId}
                onChange={(e) => handleTaxRateChange(e.target.value)}
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
                    onChange={(e) => toggleIncludeVat(e.target.checked)}
                    className="rounded border-input"
                  />
                  Prices incl. VAT
                </label>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Supplier Tracking</Label>
            <label className="flex min-h-9 items-center gap-2 rounded-md border border-input px-3 text-sm">
              <input
                type="checkbox"
                checked={skipPreferredSupplierUpdate}
                onChange={(e) => setSkipPreferredSupplierUpdate(e.target.checked)}
                className="rounded border-input"
              />
              One-off PO
            </label>
            <p className="text-xs text-muted-foreground">
              One-off POs do not change products&apos; preferred supplier when sent.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="warehouse">Destination Warehouse</Label>
            <select
              id="warehouse"
              value={destinationWarehouseId}
              onChange={(e) => handleDestinationWarehouseChange(e.target.value)}
              className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">Not specified</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>{w.code} — {w.name}</option>
              ))}
            </select>
            {destWarehouse && (destWarehouse.addressLine1 || destWarehouse.city || destWarehouse.contactName) && (
              <div className="mt-1.5 rounded-md border border-dashed border-muted-foreground/30 bg-muted/30 px-3 py-2 text-xs text-muted-foreground space-y-0.5">
                <p className="font-medium text-foreground/70">Delivery Address</p>
                {destWarehouse.contactName && <p>{destWarehouse.contactName}</p>}
                {destWarehouse.addressLine1 && <p>{destWarehouse.addressLine1}</p>}
                {destWarehouse.addressLine2 && <p>{destWarehouse.addressLine2}</p>}
                {(destWarehouse.city || destWarehouse.postcode) && (
                  <p>{[destWarehouse.city, destWarehouse.postcode].filter(Boolean).join(', ')}</p>
                )}
                {destWarehouse.country && <p>{formatCountryDisplay(destWarehouse.country)}</p>}
                {destWarehouse.phone && <p>Tel: {destWarehouse.phone}</p>}
                {destWarehouse.email && <p>{destWarehouse.email}</p>}
              </div>
            )}
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

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 *:min-w-0">
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
          <Table className="min-w-[800px]">
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Product</TableHead>
                {purchaseUnits.length > 0 && <TableHead className="text-xs text-center w-32">Unit</TableHead>}
                <TableHead className="text-xs text-center w-20">Qty</TableHead>
                {purchaseUnits.length > 0 && <TableHead className="text-xs text-center w-24">Stock Qty</TableHead>}
                <TableHead className="text-xs text-center w-32">
                  Unit Cost ({sym})
                  {pricesIncludeVat ? ' incl.' : ''}
                </TableHead>
                <TableHead className="text-xs text-center w-24">Discount</TableHead>
                <TableHead className="text-xs text-center w-32">VAT</TableHead>
                <TableHead className="text-xs text-right w-28">Line Total ({sym})</TableHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((line) => {
                const netForeign = getLineNet(line)
                const stockQty = getStockQty(line)
                const unit = unitMap[line.purchaseUnitId]
                return (
                  <TableRow key={line.key}>
                    <TableCell>
                      <ProductLink productId={line.productId} sku={line.sku} name={line.productName} />
                    </TableCell>
                    {purchaseUnits.length > 0 && (
                      <TableCell>
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
                      </TableCell>
                    )}
                    <TableCell>
                      <Input
                        type="number" min="1" step="1" value={line.qty}
                        onChange={(e) => updateLine(line.key, 'qty', Number(e.target.value) || 0)}
                        className="h-7 text-sm text-right w-20 ml-auto"
                      />
                    </TableCell>
                    {purchaseUnits.length > 0 && (
                      <TableCell className="text-right text-xs tabular-nums">
                        {unit ? (
                          <span className="text-muted-foreground">{stockQty} {unit?.stockUnitName ?? 'pcs'}</span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    )}
                    <TableCell>
                      <Input
                        type="number" min="0" step="0.01" value={line.unitCostForeign}
                        onChange={(e) => updateLine(line.key, 'unitCostForeign', Number(e.target.value) || 0)}
                        className="h-7 text-sm text-right w-32 ml-auto font-mono"
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        value={line.discount}
                        onChange={(e) => setLines((p) => p.map((l) => l.key === line.key ? { ...l, discount: e.target.value } : l))}
                        placeholder={`${sym} or %`}
                        className={`h-7 text-sm text-right w-24 ml-auto font-mono ${parseDiscount(line.discount, line.qty * line.unitCostForeign) > 0 ? 'text-destructive' : ''}`}
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
                          title={line.taxRateWarning ?? 'Follows the order/supplier VAT rate'}
                        >
                          <option value="auto">Auto {(line.taxRateValue * 100).toFixed(0)}%</option>
                          {purchaseRates.map((t) => (
                            <option key={t.id} value={t.id}>{t.name} ({(t.rate * 100).toFixed(0)}%)</option>
                          ))}
                        </select>
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">{money(netForeign)}</TableCell>
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
                        Last: {money(lastPrice.lastUnitCost)}
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
              <div key={ac.key} className="flex flex-wrap items-center gap-2">
                <Input
                  placeholder="Description (e.g. Shipping)"
                  value={ac.description}
                  onChange={(e) => setAdditionalCosts((prev) => prev.map((c) => c.key === ac.key ? { ...c, description: e.target.value } : c))}
                  className="flex-1 min-w-[140px] h-8 text-sm"
                />
                <div className="flex items-center gap-2">
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
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Totals */}
      {lines.length > 0 && (
        <div className="rounded-md border p-4">
          <div className="flex sm:justify-end">
            <div className="text-sm space-y-1 w-full sm:min-w-72 sm:w-auto">
              <div className="flex justify-between text-muted-foreground">
                <span>Subtotal{pricesIncludeVat ? '' : ' (net)'}</span>
                <span className="font-mono">{money(lineSubtotalPreOrderDisc)}</span>
              </div>
              {/* Order-level discount input */}
              <div className="flex justify-between items-center text-muted-foreground">
                <span>Order Discount</span>
                <div className="flex items-center gap-1.5">
                  <Input
                    value={orderDiscount}
                    onChange={(e) => setOrderDiscount(e.target.value)}
                    placeholder={`${sym} or %`}
                    className={`h-6 text-xs text-right w-20 font-mono ${orderDiscountGrossAmount > 0 ? 'text-destructive' : ''}`}
                  />
                  {orderDiscountGrossAmount > 0 && (
                    <span className="font-mono text-destructive text-xs">{money(-orderDiscountGrossAmount)}</span>
                  )}
                </div>
              </div>
              {totalAllDiscounts > 0 && (
                <div className="flex justify-between text-destructive text-xs">
                  <span>
                    Total Discount
                    {totalLineDiscounts > 0 && orderDiscountGrossAmount > 0
                      ? ` (lines: ${money(totalLineDiscounts)} + order: ${money(orderDiscountGrossAmount)})`
                      : totalLineDiscounts > 0
                      ? ' (lines)'
                      : ' (order)'}
                  </span>
                  <span className="font-mono">{money(-totalAllDiscounts)}</span>
                </div>
              )}
              {taxTotalForeign > 0 && (() => {
                // Group line VAT by rate for the totals breakdown, then
                // scale each bucket by the same ratio the order discount
                // applies to the line VAT total so the rows still add up
                // to `taxTotalForeign`.
                const byRate = new Map<number, number>()
                for (const l of lines) {
                  const v = getLineVat(l)
                  if (v === 0) continue
                  const rate = l.taxRateValue
                  byRate.set(rate, (byRate.get(rate) ?? 0) + v)
                }
                const vatScale = rawLineVat > 0 ? taxTotalForeign / rawLineVat : 1
                const rows = Array.from(byRate.entries())
                  .map(([rate, amt]) => [rate, Math.round(amt * vatScale * 10000) / 10000] as const)
                  .filter(([, amt]) => Math.abs(amt) > 0.005)
                  .sort(([a], [b]) => b - a)
                return rows.map(([rate, amt]) => (
                  <div key={rate} className="flex justify-between text-muted-foreground">
                    <span>VAT @ {(rate * 100).toFixed(0)}%{pricesIncludeVat ? ' (extracted)' : ''}</span>
                    <span className="font-mono">{money(amt)}</span>
                  </div>
                ))
              })()}
              {additionalCostNet > 0 && (
                <div className="flex justify-between text-muted-foreground">
                  <span>Additional Costs</span>
                  <span className="font-mono">{money(additionalCostNet)}</span>
                </div>
              )}
              {additionalCostVat > 0 && (
                <div className="flex justify-between text-muted-foreground">
                  <span>VAT on Additional Costs</span>
                  <span className="font-mono">{money(additionalCostVat)}</span>
                </div>
              )}
              <div className="flex justify-between font-medium border-t pt-1">
                <span>Total</span>
                <span className="font-mono">
                  {money(grandTotalForeign)}
                  {currency !== baseCurrency.code && (
                    <span className="text-muted-foreground font-normal ml-2">({formatMoney(grandTotalBase, baseCurrency.symbol, baseCurrency.symbolPosition)})</span>
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
        {isEditMode ? 'Save Changes' : 'Create Purchase Order'}
      </Button>
    </DialogFooter>
    </DialogContent>
    </Dialog>
  )
}
