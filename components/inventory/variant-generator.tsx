'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Plus, Trash2, Sparkles, Package } from 'lucide-react'
import { StockFlowButton } from '@/components/inventory/stock-flow-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table'
import { saveProductOptions, generateVariantsFromOptions, deleteOrDeactivateVariant } from '@/app/actions/products'
import type { ProductOptionRow, ProductRow } from '@/app/actions/products'
import type { ProductLifecycleStatus } from '@/app/generated/prisma/client'

type Option = { name: string; values: string }

type Props = {
  productId: string
  initialOptions: ProductOptionRow[]
  variants: ProductRow[]
}

export function VariantGenerator({ productId, initialOptions, variants }: Props) {
  const router = useRouter()
  const statusLabels: Record<ProductLifecycleStatus, string> = {
    ACTIVE: 'Active',
    NOT_FOR_SALE: 'Not for sale',
    ARCHIVED: 'Archived',
  }
  const statusVariants: Record<ProductLifecycleStatus, 'default' | 'secondary' | 'outline'> = {
    ACTIVE: 'default',
    NOT_FOR_SALE: 'secondary',
    ARCHIVED: 'outline',
  }
  const [options, setOptions] = useState<Option[]>(
    initialOptions.length > 0
      ? initialOptions.map((o) => ({ name: o.name, values: o.values }))
      : [{ name: '', values: '' }]
  )
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  const [genMsg, setGenMsg] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function addOption() {
    setOptions((prev) => [...prev, { name: '', values: '' }])
    setSaveMsg(null)
  }

  function removeOption(i: number) {
    setOptions((prev) => prev.filter((_, idx) => idx !== i))
    setSaveMsg(null)
  }

  function updateOption(i: number, field: 'name' | 'values', value: string) {
    setOptions((prev) => prev.map((o, idx) => idx === i ? { ...o, [field]: value } : o))
    setSaveMsg(null)
  }

  async function handleSave() {
    setSaveMsg(null)
    const valid = options.filter((o) => o.name.trim() && o.values.trim())
    try {
      const result = await saveProductOptions(productId, valid)
      setSaveMsg(result.success ? 'Options saved.' : 'Error saving options.')
    } catch { setSaveMsg('An unexpected error occurred.') }
  }

  async function handleDeleteVariant(variantId: string, variantSku: string) {
    if (!confirm(`Delete variant ${variantSku}?`)) return
    try {
      const result = await deleteOrDeactivateVariant(variantId, false)
      if (result.action === 'deleted') {
        router.refresh()
      } else if (result.error === 'HAS_ACTIVITY') {
        if (confirm(`${variantSku} has order/stock activity and cannot be deleted. Deactivate it instead?`)) {
          await deleteOrDeactivateVariant(variantId, true)
          router.refresh()
        }
      } else {
        alert(result.error ?? 'Unexpected error')
      }
    } catch { alert('An unexpected error occurred.') }
  }

  function handleGenerate() {
    setGenMsg(null)
    startTransition(async () => {
      // Always save current options first so the server reads the latest set
      const valid = options.filter((o) => o.name.trim() && o.values.trim())
      await saveProductOptions(productId, valid)
      const result = await generateVariantsFromOptions(productId)
      if (result.error) {
        setGenMsg(`Error: ${result.error}`)
      } else {
        const msg = result.created > 0
          ? `Created ${result.created} variant${result.created !== 1 ? 's' : ''}${result.skipped > 0 ? `, ${result.skipped} skipped (already exist)` : ''}.`
          : `All ${result.skipped} combinations already exist.`
        setGenMsg(msg)
        router.refresh()
      }
    })
  }

  // Compute preview combinations from current options
  const preview: string[] = (() => {
    const valid = options.filter((o) => o.name.trim() && o.values.trim())
    if (valid.length === 0) return []
    const arrays = valid.map((o) => o.values.split(',').map((v) => v.trim()).filter(Boolean))
    return arrays
      .reduce<string[][]>(
        (acc, arr) => acc.flatMap((combo) => arr.map((v) => [...combo, v])),
        [[]]
      )
      .map((combo) => combo.join(' / '))
  })()

  return (
    <div className="space-y-5">
      {/* Attribute editor */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            Define attributes and their values (comma-separated) to generate variant combinations.
          </p>
          <Button type="button" variant="outline" size="sm" onClick={addOption}>
            <Plus className="h-3.5 w-3.5 mr-1" />
            Add Attribute
          </Button>
        </div>

        {options.map((opt, i) => (
          <div key={i} className="flex gap-2 items-center">
            <Input
              placeholder="Attribute (e.g. Color)"
              value={opt.name}
              onChange={(e) => updateOption(i, 'name', e.target.value)}
              className="w-36 shrink-0"
            />
            <Input
              placeholder="Values (e.g. Red, Blue, Green)"
              value={opt.values}
              onChange={(e) => updateOption(i, 'values', e.target.value)}
              className="flex-1"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => removeOption(i)}
              className="shrink-0 text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}

        <div className="flex items-center gap-3">
          <Button type="button" variant="outline" size="sm" onClick={handleSave} disabled={isPending}>
            Save Options
          </Button>
          {saveMsg && <span className="text-xs text-muted-foreground">{saveMsg}</span>}
        </div>
      </div>

      {/* Combination preview + generate button */}
      {preview.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {preview.length} combination{preview.length !== 1 ? 's' : ''}
          </p>
          <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
            {preview.map((p) => (
              <Badge key={p} variant="outline" className="text-xs font-normal">
                {p}
              </Badge>
            ))}
          </div>
          <div className="flex items-center gap-3 pt-1">
            <Button type="button" size="sm" onClick={handleGenerate} disabled={isPending}>
              <Sparkles className="h-3.5 w-3.5 mr-1" />
              {isPending ? 'Generating…' : 'Generate Variants'}
            </Button>
            {genMsg && <span className="text-xs text-muted-foreground">{genMsg}</span>}
          </div>
        </div>
      )}

      {/* Variants table */}
      {variants.length > 0 ? (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {variants.length} Variant{variants.length !== 1 ? 's' : ''}
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12 px-2" />
                <TableHead>SKU</TableHead>
                <TableHead>Name</TableHead>
                <TableHead className="text-right">Stock</TableHead>
                <TableHead className="text-right">Allocated</TableHead>
                <TableHead className="text-right">Available</TableHead>
                <TableHead className="text-right">Incoming</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {variants.map((v) => (
                <TableRow key={v.id}>
                  <TableCell className="w-12 px-2 py-1">
                    <Link href={`/inventory/${v.id}`} className="block">
                      {v.imageUrl ? (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img src={v.imageUrl} alt={v.name} className="h-8 w-8 rounded object-cover border border-border bg-muted" />
                      ) : (
                        <span className="flex h-8 w-8 items-center justify-center rounded border border-border bg-muted text-muted-foreground">
                          <Package className="h-3.5 w-3.5" />
                        </span>
                      )}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Link
                      href={`/inventory/${v.id}`}
                      className="font-mono text-sm text-primary hover:underline"
                    >
                      {v.sku}
                    </Link>
                  </TableCell>
                  <TableCell className="text-sm">{v.name}</TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {Number(v.totalStock).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {Number(v.allocatedStock) > 0
                      ? <span className="text-amber-600">{Number(v.allocatedStock).toLocaleString()}</span>
                      : '—'}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    <span className={Number(v.availableStock) < 0 ? 'text-destructive' : ''}>
                      {Number(v.availableStock).toLocaleString()}
                    </span>
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {Number(v.incomingStock) > 0
                      ? <span className="text-blue-600">+{Number(v.incomingStock).toLocaleString()}</span>
                      : '—'}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {v.salesPriceGbp ? `£${Number(v.salesPriceGbp).toFixed(2)}` : '—'}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariants[v.lifecycleStatus]} className="text-xs">
                      {statusLabels[v.lifecycleStatus]}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-0.5">
                      <StockFlowButton productId={v.id} iconOnly />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive"
                        title="Delete or deactivate variant"
                        onClick={() => handleDeleteVariant(v.id, v.sku)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        preview.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No variants yet. Define attributes above and generate variants.
          </p>
        )
      )}
    </div>
  )
}
