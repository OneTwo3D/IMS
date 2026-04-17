'use client'

import { useState, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Trash2, Save, Search, X, AlertTriangle } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  checkProductComponentDuplicates,
  saveProductComponents,
  type ProductComponentDuplicateMatch,
  type ProductComponentRow,
} from '@/app/actions/products'

type SimpleProduct = { id: string; sku: string; name: string }

type ComponentLine = {
  key: number
  componentId: string
  qty: string
}

type Props = {
  productId: string
  productType: 'KIT' | 'BOM'
  initialComponents: ProductComponentRow[]
  allProducts: SimpleProduct[]
}

export function KitConfigurator({ productId, productType, initialComponents, allProducts }: Props) {
  const router = useRouter()
  const [lines, setLines] = useState<ComponentLine[]>(
    initialComponents.length > 0
      ? initialComponents.map((c, i) => ({ key: i, componentId: c.componentId, qty: c.qty }))
      : []
  )
  const [nextKey, setNextKey] = useState(initialComponents.length)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [duplicateWarnings, setDuplicateWarnings] = useState<ProductComponentDuplicateMatch[]>([])

  const isBom = productType === 'BOM'
  const options = allProducts.filter((p) => p.id !== productId)
  const productMap = new Map(allProducts.map((p) => [p.id, p]))

  function addLine() {
    setLines((prev) => [...prev, { key: nextKey, componentId: '', qty: '1' }])
    setNextKey((k) => k + 1)
  }

  function removeLine(key: number) {
    setLines((prev) => prev.filter((l) => l.key !== key))
  }

  function updateLine(key: number, field: 'componentId' | 'qty', value: string) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, [field]: value } : l)))
  }

  const validLines = lines.filter((line) => line.componentId && Number(line.qty) > 0)

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(async () => {
      if (validLines.length === 0) {
        setDuplicateWarnings([])
        return
      }

      try {
        const result = await checkProductComponentDuplicates(
          productId,
          validLines.map((line) => ({ componentId: line.componentId, qty: line.qty })),
        )
        if (!cancelled) {
          setDuplicateWarnings(result.matches)
        }
      } catch {
        if (!cancelled) {
          setDuplicateWarnings([])
        }
      }
    }, 250)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [productId, lines])

  async function handleSave() {
    setSaving(true)
    setMessage('')
    try {
      const result = await saveProductComponents(
        productId,
        validLines.map((line) => ({ componentId: line.componentId, qty: line.qty })),
      )
      setSaving(false)
      if (result.success) {
        setDuplicateWarnings(result.warnings ?? [])
        setMessage('Saved.')
        router.refresh()
        setTimeout(() => setMessage(''), 2000)
      } else {
        setMessage(result.error ?? 'Failed to save.')
      }
    } catch { setMessage('An unexpected error occurred.'); setSaving(false) }
  }

  const label = isBom ? 'Bill of Materials' : 'Kit Components'
  const hint = isBom
    ? 'Define which components are consumed when manufacturing this product.'
    : 'Define which components make up this kit. Stock is calculated from component availability.'

  // Already-selected IDs (to prevent duplicates)
  const selectedIds = new Set(lines.map((l) => l.componentId).filter(Boolean))

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{hint}</p>

      {duplicateWarnings.length > 0 && (
        <Alert className="border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
          <AlertTriangle className="h-4 w-4 text-amber-700 dark:text-amber-300" />
          <AlertTitle>Duplicate component configuration</AlertTitle>
          <AlertDescription className="text-amber-900 dark:text-amber-200">
            This {isBom ? 'BOM' : 'bundle'} has the same component list and quantities as:
            <ul className="mt-2 list-disc pl-5">
              {duplicateWarnings.map((match) => (
                <li key={match.productId}>
                  <span className="font-medium">{match.sku}</span>
                  {' — '}
                  {match.name}
                  {' '}
                  <span className="text-xs uppercase tracking-wide">({match.type})</span>
                  {match.parentSku ? ` under ${match.parentSku}` : ''}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {lines.length === 0 && (
        <p className="text-sm text-muted-foreground italic">No components added yet.</p>
      )}

      {lines.length > 0 && (
        <div className="space-y-2">
          <div className="grid grid-cols-[1fr_auto_auto] gap-2 text-xs text-muted-foreground px-1">
            <span>Component</span>
            <span className="w-24 text-center">Qty</span>
            <span className="w-8" />
          </div>
          {lines.map((line) => (
            <div key={line.key} className="grid grid-cols-[1fr_auto_auto] gap-2 items-center">
              <ComponentSearch
                value={line.componentId}
                options={options}
                selectedIds={selectedIds}
                productMap={productMap}
                onChange={(id) => updateLine(line.key, 'componentId', id)}
              />
              <Input
                type="number"
                min="0.0001"
                step="0.0001"
                value={line.qty}
                onChange={(e) => updateLine(line.key, 'qty', e.target.value)}
                className="h-8 text-sm w-24"
                placeholder="Qty"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => removeLine(line.key)}
                className="h-8 w-8 text-destructive hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-3 pt-1">
        <Button type="button" variant="outline" size="sm" onClick={addLine}>
          <Plus className="h-3.5 w-3.5 mr-1" />
          Add Component
        </Button>
        <Button type="button" size="sm" onClick={handleSave} disabled={saving}>
          <Save className="h-3.5 w-3.5 mr-1" />
          {saving ? 'Saving…' : `Save ${label}`}
        </Button>
        {message && (
          <span className={`text-sm ${message === 'Saved.' ? 'text-green-600' : 'text-destructive'}`}>
            {message}
          </span>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Inline search component for picking a product
// ---------------------------------------------------------------------------

function ComponentSearch({
  value,
  options,
  selectedIds,
  productMap,
  onChange,
}: {
  value: string
  options: SimpleProduct[]
  selectedIds: Set<string>
  productMap: Map<string, SimpleProduct>
  onChange: (id: string) => void
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  const selected = value ? productMap.get(value) : null

  const filtered = query
    ? options.filter((p) => {
        if (selectedIds.has(p.id) && p.id !== value) return false
        const q = query.toLowerCase()
        return p.sku.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)
      }).slice(0, 15)
    : []

  if (selected && !open) {
    return (
      <div className="flex items-center h-8 rounded-md border px-2 text-sm gap-1">
        <span className="font-mono text-xs text-muted-foreground">{selected.sku}</span>
        <span className="truncate flex-1">{selected.name}</span>
        <button
          type="button"
          onClick={() => { onChange(''); setQuery(''); setOpen(true) }}
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    )
  }

  return (
    <div className="relative" ref={ref}>
      <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
      <Input
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
        onFocus={() => { if (query) setOpen(true) }}
        placeholder="Search SKU or name..."
        className="h-8 text-sm pl-7"
        autoFocus={!value}
      />
      {open && query && (
        <div className="absolute z-50 top-full mt-1 left-0 right-0 max-h-48 overflow-y-auto rounded-md border bg-popover shadow-lg">
          {filtered.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">No products found.</p>
          ) : (
            filtered.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => { onChange(p.id); setQuery(''); setOpen(false) }}
                className="flex items-center w-full px-3 py-1.5 text-left hover:bg-muted/50 text-sm gap-2"
              >
                <span className="font-mono text-xs text-muted-foreground w-24 shrink-0">{p.sku}</span>
                <span className="truncate">{p.name}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
