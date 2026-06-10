'use client'

import { useRouter, usePathname } from 'next/navigation'
import { useTransition, useCallback, useState, useEffect } from 'react'
import { Search, Settings2 } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ALL_COLUMNS, STORAGE_KEY, COLS_CHANGED_EVENT, defaultVisibility } from '@/components/inventory/product-columns'
import type { ColKey } from '@/components/inventory/product-columns'

type Props = {
  search?: string
  type?: string
  lifecycleStatus?: string
  categoryId?: string
  supplierId?: string
  productCategories: { id: string; name: string; parentId: string | null; path: string }[]
  supplierOptions: { id: string; name: string }[]
}

export function ProductFilters({ search, type, lifecycleStatus, categoryId, supplierId, productCategories, supplierOptions }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const [isPending, startTransition] = useTransition()

  // Column picker state (lazy init from localStorage)
  const [visible, setVisible] = useState<Record<ColKey, boolean>>(() => {
    if (typeof window === 'undefined') return defaultVisibility
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) return JSON.parse(stored)
    } catch { /* ignore */ }
    return defaultVisibility
  })
  const [searchValue, setSearchValue] = useState(() => search ?? '')

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
      if (key !== 'lifecycleStatus' && lifecycleStatus && lifecycleStatus !== 'ALL') params.set('lifecycleStatus', lifecycleStatus)
      if (key !== 'categoryId' && categoryId) params.set('categoryId', categoryId)
      if (key !== 'supplierId' && supplierId) params.set('supplierId', supplierId)
      if (value) params.set(key, value)
      // reset page on filter change
      startTransition(() => {
        router.push(`${pathname}?${params.toString()}`)
      })
    },
    [router, pathname, search, type, lifecycleStatus, categoryId, supplierId]
  )

  useEffect(() => {
    const nextSearch = searchValue.trim()
    const currentSearch = search ?? ''
    if (nextSearch === currentSearch) return

    const timer = window.setTimeout(() => {
      update('search', nextSearch)
    }, 300)

    return () => window.clearTimeout(timer)
  }, [searchValue, search, update])

  return (
    <div className="flex flex-wrap gap-3 items-end">
      <div className="relative flex-1 min-w-0 sm:min-w-[200px] max-w-sm">
        <label htmlFor="inventory-search" className="sr-only">Search products</label>
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
        <Input
          id="inventory-search"
          className="pl-8"
          placeholder="Search SKU, name, barcode, MPN…"
          value={searchValue}
          onChange={(e) => setSearchValue(e.target.value)}
          aria-describedby="inventory-search-status"
        />
        <span id="inventory-search-status" className="sr-only" aria-live="polite">
          {isPending ? 'Updating product filters' : 'Product filters up to date'}
        </span>
      </div>
      <div className="w-full sm:w-44">
        <label htmlFor="inventory-type" className="sr-only">Filter by product type</label>
        <Select
          id="inventory-type"
          className="w-full"
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
      </div>

      <div className="w-full sm:w-40">
        <label htmlFor="inventory-status" className="sr-only">Filter by product status</label>
        <Select
          id="inventory-status"
          className="w-full"
          value={lifecycleStatus ?? 'ALL'}
          onChange={(e) => update('lifecycleStatus', e.target.value === 'ALL' ? '' : e.target.value)}
        >
          <option value="ALL">All Status</option>
          <option value="DRAFT">Draft</option>
          <option value="ACTIVE">Active</option>
          <option value="EOL">End of life</option>
          <option value="ARCHIVED">Archived</option>
        </Select>
      </div>

      <div className="w-full sm:w-48">
        <label htmlFor="inventory-category" className="sr-only">Filter by product category</label>
        {/* Product reporting categories are a small v1 taxonomy; switch to async search if this grows. */}
        <Select
          id="inventory-category"
          className="w-full"
          value={categoryId ?? ''}
          onChange={(e) => update('categoryId', e.target.value)}
        >
          <option value="">All Categories</option>
          {productCategories.map((category) => (
            <option key={category.id} value={category.id}>{category.path}</option>
          ))}
        </Select>
      </div>

      <div className="w-full sm:w-48">
        <label htmlFor="inventory-supplier" className="sr-only">Filter by preferred supplier</label>
        <Select
          id="inventory-supplier"
          className="w-full"
          value={supplierId ?? ''}
          onChange={(e) => update('supplierId', e.target.value)}
        >
          <option value="">All Suppliers</option>
          {supplierOptions.map((supplier) => (
            <option key={supplier.id} value={supplier.id}>{supplier.name}</option>
          ))}
        </Select>
      </div>

      <div className="hidden sm:block">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                aria-label="Column settings"
              />
            }
          >
            <Settings2 className="h-4 w-4" />
            Columns
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {ALL_COLUMNS.map((c) => (
              <DropdownMenuCheckboxItem
                key={c.key}
                checked={!!visible[c.key]}
                closeOnClick={false}
                onCheckedChange={(checked) => toggleCol(c.key, Boolean(checked))}
              >
                {c.label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
