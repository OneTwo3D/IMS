'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Trash2, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { saveProductComponents, type ProductComponentRow } from '@/app/actions/products'

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

  const isBom = productType === 'BOM'

  // Products selectable as components — exclude self
  const options = allProducts.filter((p) => p.id !== productId)

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

  async function handleSave() {
    const valid = lines.filter((l) => l.componentId && Number(l.qty) > 0)
    setSaving(true)
    setMessage('')
    const result = await saveProductComponents(
      productId,
      valid.map((l) => ({ componentId: l.componentId, qty: l.qty }))
    )
    setSaving(false)
    if (result.success) {
      setMessage('Saved.')
      router.refresh()
      setTimeout(() => setMessage(''), 2000)
    } else {
      setMessage(result.error ?? 'Failed to save.')
    }
  }

  const label = isBom ? 'Bill of Materials' : 'Kit Components'
  const hint = isBom
    ? 'Define which components are consumed when manufacturing this product.'
    : 'Define which components make up this kit. Stock is calculated from component availability.'

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{hint}</p>

      {lines.length === 0 && (
        <p className="text-sm text-muted-foreground italic">No components added yet.</p>
      )}

      {lines.length > 0 && (
        <div className="space-y-2">
          <div className="grid grid-cols-[1fr_20_auto] gap-2 text-xs text-muted-foreground px-1">
            <span>Component</span>
            <span className="w-20 text-center">Qty</span>
            <span className="w-8" />
          </div>
          {lines.map((line) => (
            <div key={line.key} className="grid grid-cols-[1fr_auto_auto] gap-2 items-center">
              <Select
                value={line.componentId}
                onChange={(e) => updateLine(line.key, 'componentId', e.target.value)}
                className="h-8 text-sm"
              >
                <option value="">— Select component —</option>
                {options.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.sku} — {p.name}
                  </option>
                ))}
              </Select>
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
