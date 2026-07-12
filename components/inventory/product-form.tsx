'use client'

import { useActionState, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import type { ProductFormState } from '@/app/actions/products'
import { COUNTRY_LIST } from '@/lib/countries'
import { useBaseCurrency } from '@/components/providers/base-currency-provider'

type VariableProduct = { id: string; sku: string; name: string }
type ProductCategoryOption = { id: string; name: string; parentId: string | null; path: string }
type SupplierOption = { id: string; name: string }

type Props = {
  action: (prev: ProductFormState, formData: FormData) => Promise<ProductFormState>
  variableProducts: VariableProduct[]
  productCategories?: ProductCategoryOption[]
  supplierOptions?: SupplierOption[]
  defaultValues?: {
    sku?: string
    name?: string
    categoryName?: string | null
    description?: string
    type?: string
    parentId?: string
    preferredSupplierId?: string | null
    preferredSupplierLocked?: boolean
    barcode?: string
    mpn?: string
    hsCode?: string
    countryOfOrigin?: string
    customsDescription?: string
    weight?: string
    imageUrl?: string | null
    widthCm?: string | null
    heightCm?: string | null
    depthCm?: string | null
    salesPriceBase?: string
    salePriceBase?: string
    salesPriceTaxInclusive?: boolean
    taxCategory?: 'STANDARD' | 'REDUCED' | 'SECOND_REDUCED' | 'ZERO' | 'EXEMPT'
    stockUnit?: string
    oversellAllowed?: boolean
    active?: boolean
    lifecycleStatus?: 'DRAFT' | 'ACTIVE' | 'EOL' | 'ARCHIVED'
    leadTimeDays?: number | null
    observedLeadTimeDays?: number | null
  }
  stockUnitOptions?: string[]
  onClose?: () => void
  title?: string
  inline?: boolean
}

const PRODUCT_TYPES = [
  { value: 'SIMPLE', label: 'Simple' },
  { value: 'VARIABLE', label: 'Variable (parent)' },
  { value: 'VARIANT', label: 'Variant (child)' },
  { value: 'KIT', label: 'Kit / Bundle (virtual)' },
  { value: 'BOM', label: 'Bill of Materials (manufactured)' },
  { value: 'NON_INVENTORY', label: 'Non-Inventory (service / fee)' },
]

const CHILD_PRODUCT_TYPES = new Set(['VARIANT', 'KIT', 'BOM'])
const CATEGORY_DIACRITICS = /\p{Diacritic}/gu

function normalizeCategoryOption(value: string) {
  return value
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .normalize('NFKD')
    .replace(CATEGORY_DIACRITICS, '')
    .toLocaleLowerCase('en-US')
}

export function ProductForm({ action, variableProducts, productCategories, supplierOptions, defaultValues, stockUnitOptions, onClose, title, inline }: Props) {
  const baseCurrency = useBaseCurrency()
  const [state, formAction, isPending] = useActionState(action, {})

  // Inline mode (the product detail page) renders Save in the page header, on the
  // same row as the product name, via a portal into a slot the page provides.
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resolving an externally-rendered portal target requires a post-mount DOM read
    if (inline) setHeaderSlot(document.getElementById('product-detail-actions'))
  }, [inline])

  // All fields are controlled so values survive a failed server-action submission
  const [fields, setFields] = useState({
    sku:                  defaultValues?.sku                  ?? '',
    name:                 defaultValues?.name                 ?? '',
    categoryName:         defaultValues?.categoryName         ?? '',
    description:          defaultValues?.description          ?? '',
    type:                 defaultValues?.type                 ?? 'SIMPLE',
    parentId:             defaultValues?.parentId             ?? '',
    preferredSupplierId:  defaultValues?.preferredSupplierId  ?? '',
    preferredSupplierLocked: defaultValues?.preferredSupplierLocked ?? false,
    barcode:              defaultValues?.barcode              ?? '',
    mpn:                  defaultValues?.mpn                  ?? '',
    hsCode:               defaultValues?.hsCode               ?? '',
    countryOfOrigin:      defaultValues?.countryOfOrigin      ?? '',
    customsDescription:   defaultValues?.customsDescription   ?? '',
    weight:               defaultValues?.weight               ?? '',
    salesPriceBase:        defaultValues?.salesPriceBase        ?? '',
    salePriceBase:         defaultValues?.salePriceBase         ?? '',
    salesPriceTaxInclusive: defaultValues?.salesPriceTaxInclusive ?? false,
    taxCategory:          defaultValues?.taxCategory          ?? 'STANDARD',
    stockUnit:            defaultValues?.stockUnit            ?? 'pcs',
    oversellAllowed:      defaultValues?.oversellAllowed      ?? true,
    imageUrl:             defaultValues?.imageUrl             ?? '',
    widthCm:              defaultValues?.widthCm              ?? '',
    heightCm:             defaultValues?.heightCm             ?? '',
    depthCm:              defaultValues?.depthCm              ?? '',
    lifecycleStatus:      defaultValues?.lifecycleStatus      ?? (defaultValues?.active === false ? 'ARCHIVED' : 'ACTIVE'),
    leadTimeDays:         defaultValues?.leadTimeDays != null ? String(defaultValues.leadTimeDays) : '',
  })


  function set<K extends keyof typeof fields>(key: K, value: (typeof fields)[K]) {
    setFields((prev) => ({ ...prev, [key]: value }))
  }

  const e = state.errors ?? {}
  const cleanedCategoryPath = fields.categoryName
    .split('>')
    .map((segment) => segment.trim().replace(/\s+/g, ' '))
    .filter((segment) => segment.length > 0)
    .join(' > ')
  const categoryMatchesExisting = cleanedCategoryPath.length > 0
    && (productCategories ?? []).some((category) => normalizeCategoryOption(category.path) === normalizeCategoryOption(cleanedCategoryPath))
  const willCreateCategory = cleanedCategoryPath.length > 0 && !categoryMatchesExisting

  const formContent = (
    <form id="product-detail-form" action={formAction} className="space-y-6">
      {inline && headerSlot && createPortal(
        <Button type="submit" form="product-detail-form" disabled={isPending}>
          {isPending ? 'Saving…' : 'Save Product'}
        </Button>,
        headerSlot,
      )}
      {state.message && (
        <p className="text-sm text-destructive">{state.message}</p>
      )}

      <input
        type="hidden"
        name="active"
        value={fields.lifecycleStatus === 'ARCHIVED' ? 'false' : 'true'}
      />

      <div className="space-y-1.5">
        <Label htmlFor="lifecycleStatus">Status</Label>
        <Select
          id="lifecycleStatus"
          name="lifecycleStatus"
          value={fields.lifecycleStatus}
          onChange={(ev) => set('lifecycleStatus', ev.target.value as typeof fields.lifecycleStatus)}
        >
          <option value="ACTIVE">Active</option>
          <option value="DRAFT">Draft</option>
          <option value="EOL">End of life</option>
          <option value="ARCHIVED">Archived</option>
        </Select>
        <p className="text-xs text-muted-foreground">
          Active products can be sold and reordered. Draft products can be purchased before publication. EOL products can sell down existing stock but are excluded from reorder forecasts. Archived products are retired.
        </p>
      </div>

      {/* Core fields */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="sku">SKU *</Label>
          <Input
            id="sku"
            name="sku"
            value={fields.sku}
            onChange={(ev) => set('sku', ev.target.value)}
            placeholder="e.g. OT3D-001"
            aria-invalid={!!e.sku}
            className={e.sku ? 'border-destructive' : ''}
          />
          {e.sku && <p className="text-xs text-destructive">{e.sku[0]}</p>}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="type">Type *</Label>
          <Select
            id="type"
            name="type"
            value={fields.type}
            onChange={(ev) => set('type', ev.target.value)}
          >
            {PRODUCT_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </Select>
          {e.type && <p className="text-xs text-destructive">{e.type[0]}</p>}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="name">Name *</Label>
        <Input
          id="name"
          name="name"
          value={fields.name}
          onChange={(ev) => set('name', ev.target.value)}
          placeholder="Product name"
          aria-invalid={!!e.name}
          className={e.name ? 'border-destructive' : ''}
        />
        {e.name && <p className="text-xs text-destructive">{e.name[0]}</p>}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="categoryName">Category</Label>
        <div className="flex gap-2">
          <Input
            id="categoryName"
            name="categoryName"
            value={fields.categoryName}
            onChange={(ev) => set('categoryName', ev.target.value)}
            list="product-category-options"
            placeholder="e.g. Apparel > T-Shirts"
          />
          {fields.categoryName.trim() && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() => set('categoryName', '')}
            >
              Clear
            </Button>
          )}
        </div>
        <datalist id="product-category-options">
          {(productCategories ?? []).map((category) => (
            <option key={category.id} value={category.path} />
          ))}
        </datalist>
        <p className="text-xs text-muted-foreground">
          Type or pick from the list. Use <span className="font-mono">&gt;</span> to nest (e.g. <span className="font-mono">Apparel &gt; T-Shirts</span>). Manage the full tree in <a className="underline" href="/settings/inventory">Settings &gt; Inventory</a>.
        </p>
        {willCreateCategory && (
          <p className="text-xs text-muted-foreground">Will create new category &ldquo;{cleanedCategoryPath}&rdquo;.</p>
        )}
        {e.categoryName && <p className="text-xs text-destructive">{e.categoryName[0]}</p>}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-4 items-end">
        <div className="space-y-1.5">
          <Label htmlFor="preferredSupplierId">Preferred Supplier</Label>
          <Select
            id="preferredSupplierId"
            name="preferredSupplierId"
            value={fields.preferredSupplierId}
            onChange={(ev) => set('preferredSupplierId', ev.target.value)}
          >
            <option value="">No supplier</option>
            {(supplierOptions ?? []).map((supplier) => (
              <option key={supplier.id} value={supplier.id}>{supplier.name}</option>
            ))}
          </Select>
          {e.preferredSupplierId && <p className="text-xs text-destructive">{e.preferredSupplierId[0]}</p>}
        </div>
        <label className="flex items-center gap-2 h-9 text-sm">
          <input
            type="checkbox"
            name="preferredSupplierLocked"
            checked={fields.preferredSupplierLocked}
            onChange={(ev) => set('preferredSupplierLocked', ev.target.checked)}
            className="h-4 w-4 rounded border-border"
          />
          Lock supplier
        </label>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="description">Description</Label>
        <Textarea
          id="description"
          name="description"
          value={fields.description}
          onChange={(ev) => set('description', ev.target.value)}
          placeholder="Optional product description"
          rows={3}
        />
      </div>

      {/* Child selector — simple variants, bundle variants, and BOM variants live under a variable parent */}
      {CHILD_PRODUCT_TYPES.has(fields.type) && (
        <div className="space-y-1.5">
          <Label htmlFor="parentId">Parent Product</Label>
          <Select
            id="parentId"
            name="parentId"
            value={fields.parentId}
            onChange={(ev) => set('parentId', ev.target.value)}
          >
            <option value="">— None —</option>
            {variableProducts.map((p) => (
              <option key={p.id} value={p.id}>{p.sku} — {p.name}</option>
            ))}
          </Select>
          <p className="text-xs text-muted-foreground">
            {fields.type === 'VARIANT'
              ? 'Simple variants must stay attached to a variable parent.'
              : 'Leave blank for a standalone product, or select a variable parent to make this a child variant.'}
          </p>
          {e.parentId && <p className="text-xs text-destructive">{e.parentId[0]}</p>}
        </div>
      )}

      {/* Identifiers */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="barcode">Barcode / EAN</Label>
          <Input
            id="barcode"
            name="barcode"
            value={fields.barcode}
            onChange={(ev) => set('barcode', ev.target.value)}
            placeholder="e.g. 5060000000000"
          />
          {e.barcode && <p className="text-xs text-destructive">{e.barcode[0]}</p>}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="mpn">MPN</Label>
          <Input
            id="mpn"
            name="mpn"
            value={fields.mpn}
            onChange={(ev) => set('mpn', ev.target.value)}
            placeholder="e.g. ABC-123"
          />
          {e.mpn && <p className="text-xs text-destructive">{e.mpn[0]}</p>}
        </div>
      </div>

      {/* Customs */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="hsCode">HS Code</Label>
          <Input
            id="hsCode"
            name="hsCode"
            value={fields.hsCode}
            onChange={(ev) => set('hsCode', ev.target.value)}
            placeholder="e.g. 3926.90"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="countryOfOrigin">Country of Origin</Label>
          <Select
            id="countryOfOrigin"
            name="countryOfOrigin"
            value={fields.countryOfOrigin}
            onChange={(ev) => set('countryOfOrigin', ev.target.value)}
          >
            <option value="">— Select —</option>
            {COUNTRY_LIST.map((c) => (
              <option key={c.code} value={c.code}>{c.name}</option>
            ))}
          </Select>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="customsDescription">Customs Description</Label>
        <Input
          id="customsDescription"
          name="customsDescription"
          value={fields.customsDescription}
          onChange={(ev) => set('customsDescription', ev.target.value)}
          placeholder="Goods description for customs paperwork"
        />
      </div>

      {/* Pricing — hidden for VARIABLE products (price comes from variants) */}
      {fields.type === 'VARIABLE' ? (
        <p className="text-sm text-muted-foreground">Prices are set on individual variants.</p>
      ) : (
      <div className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="salesPriceBase">Regular Price ({baseCurrency.code})</Label>
            <Input
              id="salesPriceBase"
              name="salesPriceBase"
              type="number"
              step="0.0001"
              min="0"
              value={fields.salesPriceBase}
              onChange={(ev) => set('salesPriceBase', ev.target.value)}
              placeholder="0.00"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="salePriceBase">Sale Price ({baseCurrency.code})</Label>
            <Input
              id="salePriceBase"
              name="salePriceBase"
              type="number"
              step="0.0001"
              min="0"
              value={fields.salePriceBase}
              onChange={(ev) => set('salePriceBase', ev.target.value)}
              placeholder="0.00"
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="salesPriceTaxInclusive"
            name="salesPriceTaxInclusive"
            checked={fields.salesPriceTaxInclusive}
            onChange={(ev) => set('salesPriceTaxInclusive', ev.target.checked)}
            className="h-4 w-4"
          />
          <Label htmlFor="salesPriceTaxInclusive" className="cursor-pointer">
            Prices are tax-inclusive
          </Label>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="taxCategory">Tax Category</Label>
          <Select
            id="taxCategory"
            name="taxCategory"
            value={fields.taxCategory}
            onChange={(ev) => set('taxCategory', ev.target.value as typeof fields.taxCategory)}
          >
            <option value="STANDARD">Standard</option>
            <option value="REDUCED">Reduced</option>
            <option value="SECOND_REDUCED">2nd Reduced</option>
            <option value="ZERO">Zero-rated</option>
            <option value="EXEMPT">Exempt</option>
          </Select>
          <p className="text-xs text-muted-foreground">
            The effective VAT rate is resolved at order time from this category and the destination country.
          </p>
        </div>
      </div>
      )}

      {/* Stock unit + behaviour */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div className="space-y-1.5">
        <Label htmlFor="stockUnit">Stock Unit</Label>
        <Select id="stockUnit" name="stockUnit" value={fields.stockUnit} onChange={(ev) => set('stockUnit', ev.target.value)} className="w-32 font-mono">
          {(stockUnitOptions ?? ['pcs']).map((u) => (
            <option key={u} value={u}>{u}</option>
          ))}
        </Select>
        <p className="text-xs text-muted-foreground">Define additional units in Settings &gt; Purchase Units</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="oversellAllowed">When out of stock</Label>
        <Select
          id="oversellAllowed"
          name="oversellAllowed"
          value={fields.oversellAllowed ? 'true' : 'false'}
          onChange={(ev) => set('oversellAllowed', ev.target.value === 'true')}
        >
          <option value="false">Stop selling</option>
          <option value="true">Continue selling</option>
        </Select>
      </div>
      </div>

      {/* Image */}
      <div className="space-y-1.5">
        <Label htmlFor="imageUrl">Product Image URL</Label>
        <Input
          id="imageUrl"
          name="imageUrl"
          value={fields.imageUrl}
          onChange={(ev) => set('imageUrl', ev.target.value)}
          placeholder="https://…"
        />
        {fields.imageUrl && (
          <div className="mt-2 w-24 h-24 rounded-lg border border-border overflow-hidden bg-muted">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={fields.imageUrl}
              alt="Product"
              className="w-full h-full object-contain"
              onError={() => set('imageUrl', '')}
            />
          </div>
        )}
      </div>

      {/* Dimensions + Weight */}
      <div className="space-y-1.5">
        <Label className="text-sm font-medium">Dimensions &amp; Weight</Label>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 *:min-w-0">
          <div className="space-y-1">
            <Label htmlFor="widthCm" className="text-xs text-muted-foreground">Width (cm)</Label>
            <Input id="widthCm" name="widthCm" type="number" step="0.01" min="0"
              value={fields.widthCm} onChange={(ev) => set('widthCm', ev.target.value)}
              placeholder="0.00" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="heightCm" className="text-xs text-muted-foreground">Height (cm)</Label>
            <Input id="heightCm" name="heightCm" type="number" step="0.01" min="0"
              value={fields.heightCm} onChange={(ev) => set('heightCm', ev.target.value)}
              placeholder="0.00" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="depthCm" className="text-xs text-muted-foreground">Depth (cm)</Label>
            <Input id="depthCm" name="depthCm" type="number" step="0.01" min="0"
              value={fields.depthCm} onChange={(ev) => set('depthCm', ev.target.value)}
              placeholder="0.00" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="weight" className="text-xs text-muted-foreground">Weight (kg)</Label>
            <Input id="weight" name="weight" type="number" step="0.0001" min="0"
              value={fields.weight} onChange={(ev) => set('weight', ev.target.value)}
              placeholder="0.000" />
          </div>
        </div>
      </div>

      {/* Replenishment lead time */}
      <div className="space-y-1.5">
        <Label htmlFor="leadTimeDays" className="text-sm font-medium">Lead time (days)</Label>
        <Input id="leadTimeDays" name="leadTimeDays" type="number" step="1" min="1"
          value={fields.leadTimeDays} onChange={(ev) => set('leadTimeDays', ev.target.value)}
          placeholder={defaultValues?.observedLeadTimeDays != null ? String(defaultValues.observedLeadTimeDays) : '14'} />
        <p className="text-xs text-muted-foreground">
          {defaultValues?.observedLeadTimeDays != null
            ? `Leave blank to use the value auto-derived from purchase-order history (${defaultValues.observedLeadTimeDays} days). Enter a value to override it.`
            : 'Leave blank to use the auto-derived value once purchase-order history exists (defaults to 14 days). Enter a value to override it.'}
        </p>
      </div>

      {/* Actions — inline mode portals Save into the page header; dialog mode keeps a footer */}
      {!inline && (
        <DialogFooter>
          {onClose && (
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
          )}
          <Button type="submit" disabled={isPending}>
            {isPending ? 'Saving…' : 'Save Product'}
          </Button>
        </DialogFooter>
      )}
    </form>
  )

  if (inline) return formContent

  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent showCloseButton={false} className="max-w-2xl sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title ?? 'Product'}</DialogTitle>
        </DialogHeader>
        {formContent}
      </DialogContent>
    </Dialog>
  )
}
