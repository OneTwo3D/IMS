'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  savePoMarginThresholdSettings,
  searchProductsForMarginOverride,
  type MarginThresholdOverrideLabel,
  type MarginThresholdSettingsView,
} from '@/app/actions/po-margin-threshold'
import type { MarginThresholdMode } from '@/lib/domain/purchasing/margin-threshold'

type Props = {
  initial: MarginThresholdSettingsView
  categories: MarginThresholdOverrideLabel[]
}

type OverrideRow = { id: string; label: string; pct: string }

export function PoMarginThresholdSetting({ initial, categories }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [mode, setMode] = useState<MarginThresholdMode>(initial.settings.mode)
  const [globalPct, setGlobalPct] = useState(initial.settings.globalPct ?? '')
  const [categoryRows, setCategoryRows] = useState<OverrideRow[]>(
    Object.entries(initial.settings.categories).map(([id, pct]) => ({ id, pct, label: initial.categoryLabels[id] ?? id })),
  )
  const [productRows, setProductRows] = useState<OverrideRow[]>(
    Object.entries(initial.settings.products).map(([id, pct]) => ({ id, pct, label: initial.productLabels[id] ?? id })),
  )
  const [categoryToAdd, setCategoryToAdd] = useState('')
  const [productQuery, setProductQuery] = useState('')
  const [productMatches, setProductMatches] = useState<MarginThresholdOverrideLabel[]>([])
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  function save() {
    setMessage(null)
    startTransition(async () => {
      const result = await savePoMarginThresholdSettings({
        mode,
        globalPct: globalPct.trim() === '' ? null : globalPct,
        categories: Object.fromEntries(categoryRows.map((r) => [r.id, r.pct])),
        products: Object.fromEntries(productRows.map((r) => [r.id, r.pct])),
      })
      if (result.success) {
        setMessage({ ok: true, text: 'Saved' })
        router.refresh()
      } else {
        setMessage({ ok: false, text: result.error })
      }
    })
  }

  async function searchProducts() {
    setProductMatches(await searchProductsForMarginOverride(productQuery))
  }

  const rowEditor = (rows: OverrideRow[], setRows: (r: OverrideRow[]) => void, noun: string) => (
    <ul className="space-y-1">
      {rows.map((r) => (
        <li key={r.id} className="flex items-center gap-2 text-sm">
          <span className="flex-1 truncate">{r.label}</span>
          <Input
            aria-label={`Minimum margin % for ${r.label}`}
            className="h-8 w-24"
            inputMode="decimal"
            value={r.pct}
            onChange={(e) => setRows(rows.map((x) => (x.id === r.id ? { ...x, pct: e.target.value } : x)))}
          />
          <span className="text-xs text-muted-foreground">%</span>
          <button type="button" aria-label={`Remove ${noun} override for ${r.label}`} onClick={() => setRows(rows.filter((x) => x.id !== r.id))} className="text-muted-foreground hover:text-destructive">
            <X className="h-4 w-4" />
          </button>
        </li>
      ))}
      {rows.length === 0 && <li className="text-xs text-muted-foreground">No {noun} overrides.</li>}
    </ul>
  )

  return (
    <div className="space-y-5" data-testid="po-margin-threshold-settings">
      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor="po-min-margin-global">Minimum gross margin, all products (%)</label>
        <div className="flex items-center gap-2">
          <Input id="po-min-margin-global" className="h-8 w-28" inputMode="decimal" placeholder="none" value={globalPct} onChange={(e) => setGlobalPct(e.target.value)} />
          <span className="text-xs text-muted-foreground">Leave empty for no global minimum. With no minimum anywhere, purchase orders behave as before.</span>
        </div>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">When a line is below its minimum</legend>
        <label className="flex items-start gap-3 cursor-pointer">
          <input type="radio" name="poMarginMode" className="mt-0.5" checked={mode === 'warn'} onChange={() => setMode('warn')} />
          <div>
            <span className="text-sm font-medium">Warn</span>
            <p className="text-xs text-muted-foreground">The line is marked on the purchase order form. Saving and sending are not affected.</p>
          </div>
        </label>
        <label className="flex items-start gap-3 cursor-pointer">
          <input type="radio" name="poMarginMode" className="mt-0.5" checked={mode === 'block'} onChange={() => setMode('block')} />
          <div>
            <span className="text-sm font-medium">Block</span>
            <p className="text-xs text-muted-foreground">The order cannot be saved or sent until an override note is entered. The note is recorded on the order with who entered it and when.</p>
          </div>
        </label>
      </fieldset>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">Category overrides</h3>
        <p className="text-xs text-muted-foreground">A category minimum replaces the global one for its products, and for the categories below it that have no minimum of their own.</p>
        {rowEditor(categoryRows, setCategoryRows, 'category')}
        <div className="flex items-center gap-2">
          <select aria-label="Category to add" className="h-8 rounded-md border bg-background px-2 text-sm" value={categoryToAdd} onChange={(e) => setCategoryToAdd(e.target.value)}>
            <option value="">Add a category...</option>
            {categories.filter((c) => !categoryRows.some((r) => r.id === c.id)).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
          <Button
            size="sm" variant="outline" type="button" disabled={!categoryToAdd}
            onClick={() => {
              const c = categories.find((x) => x.id === categoryToAdd)
              if (c) setCategoryRows([...categoryRows, { id: c.id, label: c.label, pct: globalPct || '20' }])
              setCategoryToAdd('')
            }}
          >Add</Button>
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">Product overrides</h3>
        <p className="text-xs text-muted-foreground">The most specific minimum wins: product, then its parent product, then category, then the global minimum.</p>
        {rowEditor(productRows, setProductRows, 'product')}
        <div className="flex items-center gap-2">
          <Input className="h-8 w-64" placeholder="Search SKU or name" value={productQuery} onChange={(e) => setProductQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void searchProducts() } }} />
          <Button size="sm" variant="outline" type="button" onClick={() => void searchProducts()} disabled={productQuery.trim().length < 2}>Search</Button>
        </div>
        {productMatches.length > 0 && (
          <ul className="space-y-1 text-sm">
            {productMatches.filter((m) => !productRows.some((r) => r.id === m.id)).map((m) => (
              <li key={m.id}>
                <button type="button" className="text-left underline-offset-2 hover:underline" onClick={() => { setProductRows([...productRows, { id: m.id, label: m.label, pct: globalPct || '20' }]); setProductMatches([]); setProductQuery('') }}>
                  {m.label}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={save} disabled={isPending}>
          {isPending && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
          Save
        </Button>
        {message && <span className={`text-xs ${message.ok ? 'text-green-600' : 'text-destructive'}`}>{message.text}</span>}
      </div>
    </div>
  )
}
