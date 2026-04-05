'use client'

import { useActionState, useState } from 'react'
import { Download } from 'lucide-react'
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
} from '@/components/ui/dialog'
import { fetchWcImage } from '@/app/actions/stock'
import type { ProductFormState } from '@/app/actions/products'

type VariableProduct = { id: string; sku: string; name: string }

type Props = {
  action: (prev: ProductFormState, formData: FormData) => Promise<ProductFormState>
  variableProducts: VariableProduct[]
  defaultValues?: {
    sku?: string
    name?: string
    description?: string
    type?: string
    parentId?: string
    barcode?: string
    weight?: string
    imageUrl?: string | null
    widthCm?: string | null
    heightCm?: string | null
    depthCm?: string | null
    salesPriceGbp?: string
    salePriceGbp?: string
    salesPriceTaxInclusive?: boolean
    stockUnit?: string
    oversellAllowed?: boolean
    active?: boolean
  }
  stockUnitOptions?: string[]
  onClose?: () => void
  title?: string
  inline?: boolean
}

// Variant type is only selectable when editing an existing variant.
// New variants are created via the parent product's variant generator.
const PRODUCT_TYPES_BASE = [
  { value: 'SIMPLE', label: 'Simple' },
  { value: 'VARIABLE', label: 'Variable (parent)' },
  { value: 'KIT', label: 'Kit / Bundle (virtual)' },
  { value: 'BOM', label: 'Bill of Materials (manufactured)' },
  { value: 'NON_INVENTORY', label: 'Non-Inventory (service / fee)' },
]

export function ProductForm({ action, variableProducts, defaultValues, stockUnitOptions, onClose, title, inline }: Props) {
  const [state, formAction, isPending] = useActionState(action, {})

  // All fields are controlled so values survive a failed server-action submission
  const [fields, setFields] = useState({
    sku:                  defaultValues?.sku                  ?? '',
    name:                 defaultValues?.name                 ?? '',
    description:          defaultValues?.description          ?? '',
    type:                 defaultValues?.type                 ?? 'SIMPLE',
    parentId:             defaultValues?.parentId             ?? '',
    barcode:              defaultValues?.barcode              ?? '',
    weight:               defaultValues?.weight               ?? '',
    salesPriceGbp:        defaultValues?.salesPriceGbp        ?? '',
    salePriceGbp:         defaultValues?.salePriceGbp         ?? '',
    salesPriceTaxInclusive: defaultValues?.salesPriceTaxInclusive ?? false,
    stockUnit:            defaultValues?.stockUnit            ?? 'pcs',
    oversellAllowed:      defaultValues?.oversellAllowed      ?? true,
    imageUrl:             defaultValues?.imageUrl             ?? '',
    widthCm:              defaultValues?.widthCm              ?? '',
    heightCm:             defaultValues?.heightCm             ?? '',
    depthCm:              defaultValues?.depthCm              ?? '',
    active:               defaultValues?.active               ?? true,
  })

  const [wcImporting, setWcImporting] = useState(false)
  const [wcError, setWcError] = useState('')

  function set<K extends keyof typeof fields>(key: K, value: (typeof fields)[K]) {
    setFields((prev) => ({ ...prev, [key]: value }))
  }

  const typeOptions = fields.type === 'VARIANT'
    ? [{ value: 'VARIANT', label: 'Variant (child)' }, ...PRODUCT_TYPES_BASE]
    : PRODUCT_TYPES_BASE

  async function importFromWc() {
    if (!fields.sku) { setWcError('Save the product with a SKU first'); return }
    setWcImporting(true)
    setWcError('')
    const result = await fetchWcImage(fields.sku)
    setWcImporting(false)
    if (result.error) { setWcError(result.error); return }
    if (result.imageUrl) set('imageUrl', result.imageUrl)
  }

  const e = state.errors ?? {}

  const formContent = (
    <form action={formAction} className="space-y-6">
      {state.message && (
        <p className="text-sm text-destructive">{state.message}</p>
      )}

      {/* Active — top of form */}
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="active"
          name="active"
          value="true"
          checked={fields.active}
          onChange={(ev) => set('active', ev.target.checked)}
          className="h-4 w-4"
        />
        <Label htmlFor="active" className="cursor-pointer">Active</Label>
      </div>

      {/* Core fields */}
      <div className="grid grid-cols-2 gap-4">
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
            {typeOptions.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </Select>
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

      {/* Parent selector — only relevant when editing an existing VARIANT */}
      {fields.type === 'VARIANT' && (
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
        </div>
      )}

      {/* Identifiers */}
      <div className="space-y-1.5">
        <Label htmlFor="barcode">Barcode / EAN</Label>
        <Input
          id="barcode"
          name="barcode"
          value={fields.barcode}
          onChange={(ev) => set('barcode', ev.target.value)}
          placeholder="e.g. 5060000000000"
        />
      </div>

      {/* Pricing */}
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="salesPriceGbp">Regular Price (GBP)</Label>
            <Input
              id="salesPriceGbp"
              name="salesPriceGbp"
              type="number"
              step="0.0001"
              min="0"
              value={fields.salesPriceGbp}
              onChange={(ev) => set('salesPriceGbp', ev.target.value)}
              placeholder="0.00"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="salePriceGbp">Sale Price (GBP)</Label>
            <Input
              id="salePriceGbp"
              name="salePriceGbp"
              type="number"
              step="0.0001"
              min="0"
              value={fields.salePriceGbp}
              onChange={(ev) => set('salePriceGbp', ev.target.value)}
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
      </div>

      {/* Stock unit + behaviour */}
      <div className="grid grid-cols-2 gap-4">
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
        <div className="flex gap-2">
          <Input
            id="imageUrl"
            name="imageUrl"
            value={fields.imageUrl}
            onChange={(ev) => set('imageUrl', ev.target.value)}
            placeholder="https://…"
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={importFromWc}
            disabled={wcImporting}
            title="Import from WooCommerce"
          >
            <Download className="h-4 w-4" />
          </Button>
        </div>
        {wcError && <p className="text-xs text-destructive">{wcError}</p>}
        {fields.imageUrl && (
          <div className="mt-2 w-24 h-24 rounded-lg border border-border overflow-hidden bg-muted">
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
        <div className="grid grid-cols-4 gap-2">
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

      {/* Actions */}
      <div className="flex gap-3 pt-2">
        <Button type="submit" disabled={isPending}>
          {isPending ? 'Saving…' : 'Save Product'}
        </Button>
        {onClose && (
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
        )}
      </div>
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
