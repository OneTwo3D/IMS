'use client'

import { useRouter, usePathname } from 'next/navigation'
import { useTransition, useCallback, useState, useEffect, useRef } from 'react'
import { Search, Settings2 } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { ALL_COLUMNS, STORAGE_KEY, COLS_CHANGED_EVENT, defaultVisibility } from '@/components/inventory/product-columns'
import type { ColKey } from '@/components/inventory/product-columns'

type Props = {
  search?: string
  type?: string
  active?: string
}

export function ProductFilters({ search, type, active }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const [, startTransition] = useTransition()

  // Column picker state (lazy init from localStorage)
  const [visible, setVisible] = useState<Record<ColKey, boolean>>(() => {
    if (typeof window === 'undefined') return defaultVisibility
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) return JSON.parse(stored)
    } catch { /* ignore */ }
    return defaultVisibility
  })
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false)
      }
    }
    if (pickerOpen) document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [pickerOpen])

  function toggleCol(key: ColKey, value: boolean) {
    const next = { ...visible, [key]: value }
    setVisible(next)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      window.dispatchEvent(new Event(COLS_CHANGED_EVENT))
    } catch { /* noop */ }
  }

  const update = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams()
      if (key !== 'search' && search) params.set('search', search)
      if (key !== 'type' && type) params.set('type', type)
      if (key !== 'active' && active) params.set('active', active)
      if (value) params.set(key, value)
      // reset page on filter change
      startTransition(() => {
        router.push(`${pathname}?${params.toString()}`)
      })
    },
    [router, pathname, search, type, active]
  )

  return (
    <div className="flex flex-wrap gap-3 items-center">
      <div className="relative flex-1 min-w-0 sm:min-w-[200px] max-w-sm">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
        <Input
          className="pl-8"
          placeholder="Search SKU, name, barcode…"
          defaultValue={search}
          onChange={(e) => {
            const val = e.target.value
            clearTimeout((window as { _searchTimer?: ReturnType<typeof setTimeout> })._searchTimer)
            ;(window as { _searchTimer?: ReturnType<typeof setTimeout> })._searchTimer = setTimeout(
              () => update('search', val),
              300
            )
          }}
        />
      </div>

      <Select
        className="w-full sm:w-44"
        value={type ?? 'ALL'}
        onChange={(e) => update('type', e.target.value === 'ALL' ? '' : e.target.value)}
      >
        <option value="ALL">All Types</option>
        <option value="SIMPLE">Simple</option>
        <option value="VARIABLE">Variable</option>
        <option value="KIT">Kit / Bundle</option>
        <option value="BOM">Bill of Materials</option>
        <option value="NON_INVENTORY">Non-Inventory</option>
      </Select>

      <Select
        className="w-full sm:w-40"
        value={active ?? 'true'}
        onChange={(e) => update('active', e.target.value === 'all' ? '' : e.target.value)}
      >
        <option value="all">All Status</option>
        <option value="true">Active only</option>
        <option value="false">Inactive only</option>
      </Select>

      <div className="relative" ref={pickerRef}>
        <Button variant="outline" size="sm" className="h-8" onClick={() => setPickerOpen((o) => !o)} title="Column settings">
          <Settings2 className="h-4 w-4" />
        </Button>
        {pickerOpen && (
          <div className="absolute right-0 top-full mt-1 z-50 w-[calc(100vw-2rem)] sm:w-52 rounded-md border border-border bg-popover shadow-md p-2 space-y-1">
            {ALL_COLUMNS.map((c) => (
              <label key={c.key} className="flex items-center gap-2 px-1 py-0.5 text-sm cursor-pointer hover:bg-accent rounded">
                <input
                  type="checkbox"
                  checked={!!visible[c.key]}
                  onChange={(e) => toggleCol(c.key, e.target.checked)}
                  className="h-3.5 w-3.5 accent-primary"
                />
                {c.label}
              </label>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
