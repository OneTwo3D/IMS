'use client'

import { useState, useEffect, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Package, ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table'
import { PaginationBar } from '@/components/ui/pagination-bar'
import { bulkDeleteProducts, bulkDeactivateProducts } from '@/app/actions/products'
import { ALL_COLUMNS, STORAGE_KEY, COLS_CHANGED_EVENT, defaultVisibility } from '@/components/inventory/product-columns'
import type { ColKey } from '@/components/inventory/product-columns'
import type { ProductRow } from '@/app/actions/products'
import type { ProductType } from '@/app/generated/prisma/client'

const TYPE_LABELS: Record<ProductType, string> = {
  SIMPLE: 'Simple',
  VARIABLE: 'Variable',
  VARIANT: 'Variant',
  KIT: 'Kit',
  BOM: 'BOM',
  NON_INVENTORY: 'Non-Inventory',
}

const TYPE_COLOURS: Record<ProductType, 'default' | 'secondary' | 'outline'> = {
  SIMPLE: 'default',
  VARIABLE: 'secondary',
  VARIANT: 'outline',
  KIT: 'outline',
  BOM: 'outline',
  NON_INVENTORY: 'outline',
}

// Map column keys to server-side sort fields (only columns that support server sort)
const SORTABLE: Partial<Record<ColKey, string>> = {
  sku: 'sku', name: 'name', type: 'type',
  salesPriceGbp: 'salesPriceGbp', totalStock: 'totalStock',
  active: 'active', createdAt: 'createdAt', updatedAt: 'updatedAt',
}

type Props = {
  products: ProductRow[]
  total: number
  page: number
  pageSize: number
  searchParams: Record<string, string | undefined>
}

export function ProductTable({ products, total, page, pageSize, searchParams }: Props) {
  const router = useRouter()
  const [visible, setVisible] = useState<Record<ColKey, boolean>>(defaultVisibility)
  const [, startTransition] = useTransition()

  // Multiselect state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkPending, setBulkPending] = useState(false)
  const [bulkMsg, setBulkMsg] = useState<string | null>(null)

  const allPageIds = products.map((p) => p.id)
  const allSelected = allPageIds.length > 0 && allPageIds.every((id) => selectedIds.has(id))
  const someSelected = allPageIds.some((id) => selectedIds.has(id))

  function toggleSelectAll() {
    if (allSelected) {
      setSelectedIds((prev) => { const next = new Set(prev); allPageIds.forEach((id) => next.delete(id)); return next })
    } else {
      setSelectedIds((prev) => new Set([...prev, ...allPageIds]))
    }
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  async function handleBulkDelete() {
    const ids = [...selectedIds]
    if (!confirm(`Delete ${ids.length} product${ids.length !== 1 ? 's' : ''}? Products with activity or variants will be skipped.`)) return
    setBulkPending(true)
    setBulkMsg(null)
    try {
      const result = await bulkDeleteProducts(ids)
      setBulkPending(false)
      setSelectedIds(new Set())
      const skippedCount = result.skipped.length
      setBulkMsg(
        skippedCount > 0
          ? `Deleted ${result.deleted}, skipped ${skippedCount} (${result.skipped.map((s) => s.sku).join(', ')})`
          : `Deleted ${result.deleted} product${result.deleted !== 1 ? 's' : ''}.`
      )
      startTransition(() => router.refresh())
    } catch { setBulkMsg('An unexpected error occurred.'); setBulkPending(false) }
  }

  async function handleBulkDeactivate() {
    const ids = [...selectedIds]
    setBulkPending(true)
    setBulkMsg(null)
    try {
      const result = await bulkDeactivateProducts(ids)
      setBulkPending(false)
      setSelectedIds(new Set())
      setBulkMsg(`Deactivated ${result.deactivated} product${result.deactivated !== 1 ? 's' : ''}.`)
      startTransition(() => router.refresh())
    } catch { setBulkMsg('An unexpected error occurred.'); setBulkPending(false) }
  }

  // Load from localStorage on mount + listen for changes from filters column picker
  useEffect(() => {
    function load() {
      try {
        const stored = localStorage.getItem(STORAGE_KEY)
        if (stored) setVisible(JSON.parse(stored))
      } catch { /* ignore */ }
    }
    load()
    window.addEventListener(COLS_CHANGED_EVENT, load)
    return () => window.removeEventListener(COLS_CHANGED_EVENT, load)
  }, [])

  const visibleCols = ALL_COLUMNS.filter((c) => visible[c.key])
  const totalPages = Math.ceil(total / pageSize)

  const currentSort = searchParams.sort
  const currentDir = searchParams.dir ?? 'asc'

  function buildBaseParams() {
    const params = new URLSearchParams()
    if (searchParams.search) params.set('search', searchParams.search)
    if (searchParams.type) params.set('type', searchParams.type)
    if (searchParams.active) params.set('active', searchParams.active)
    if (searchParams.sort) params.set('sort', searchParams.sort)
    if (searchParams.dir) params.set('dir', searchParams.dir)
    return params
  }

  function buildPageHref(p: number) {
    const params = buildBaseParams()
    params.set('page', String(p))
    return `/inventory?${params.toString()}`
  }

  function buildSortHref(field: string) {
    const params = new URLSearchParams()
    if (searchParams.search) params.set('search', searchParams.search)
    if (searchParams.type) params.set('type', searchParams.type)
    if (searchParams.active) params.set('active', searchParams.active)
    params.set('sort', field)
    params.set('dir', currentSort === field && currentDir === 'asc' ? 'desc' : 'asc')
    params.set('page', '1')
    return `/inventory?${params.toString()}`
  }

  function renderCell(p: ProductRow, key: ColKey) {
    switch (key) {
      case 'sku':
        return (
          <Link
            href={`/inventory/${p.id}`}
            className="font-mono text-sm font-medium text-primary hover:underline"
          >
            {p.sku}
          </Link>
        )
      case 'name':
        return (
          <>
            <span className="font-medium">{p.name}</span>
            {p.type === 'VARIANT' && p.parentSku && (
              <span className="ml-1 text-xs text-muted-foreground">↳ {p.parentSku}</span>
            )}
            {p.type === 'VARIABLE' && p.variantCount > 0 && (
              <span className="ml-1 text-xs text-muted-foreground">
                {p.variantCount} variant{p.variantCount !== 1 ? 's' : ''}
              </span>
            )}
          </>
        )
      case 'type':
        return <Badge variant={TYPE_COLOURS[p.type]}>{TYPE_LABELS[p.type]}</Badge>
      case 'parentSku':
        return p.parentSku ?? '—'
      case 'barcode':
        return p.barcode ?? '—'
      case 'dimensions': {
        const parts = [p.widthCm, p.heightCm, p.depthCm].filter(Boolean)
        return parts.length === 3 ? `${p.widthCm}×${p.heightCm}×${p.depthCm} cm` : '—'
      }
      case 'weight':
        return p.weight ? `${p.weight} kg` : '—'
      case 'salesPriceGbp':
        if (p.type === 'VARIABLE' && p.priceRange) {
          return p.priceRange.min === p.priceRange.max
            ? `£${p.priceRange.min}`
            : `£${p.priceRange.min} – £${p.priceRange.max}`
        }
        return p.salesPriceGbp ? `£${Number(p.salesPriceGbp).toFixed(2)}` : '—'
      case 'salePriceGbp':
        if (p.type === 'VARIABLE') return '—'
        return p.salePriceGbp ? `£${Number(p.salePriceGbp).toFixed(2)}` : '—'
      case 'salesPriceTaxInclusive':
        return p.salesPriceTaxInclusive ? 'Yes' : 'No'
      case 'totalStock':
        if (p.type === 'NON_INVENTORY') return '∞'
        return `${Number(p.totalStock).toLocaleString()} ${p.stockUnit}`
      case 'allocatedStock':
        if (p.type === 'NON_INVENTORY') return '—'
        { const val = Number(p.allocatedStock); return val > 0 ? <span className="text-amber-600">{val.toLocaleString()}</span> : '—' }
      case 'availableStock':
        if (p.type === 'NON_INVENTORY') return '∞'
        { const val = Number(p.availableStock); return <span className={val < 0 ? 'text-destructive' : ''}>{val.toLocaleString()}</span> }
      case 'incomingStock':
        if (p.type === 'NON_INVENTORY') return '—'
        { const val = Number(p.incomingStock); return val > 0 ? <span className="text-blue-600">+{val.toLocaleString()}</span> : '—' }
      case 'inventoryValue':
        if (p.type === 'VARIABLE' || p.type === 'NON_INVENTORY') return '—'
        return `£${Number(p.inventoryValue).toFixed(2)}`
      case 'variantCount':
        return p.variantCount > 0 ? p.variantCount : '—'
      case 'active':
        return <Badge variant={p.active ? 'default' : 'outline'}>{p.active ? 'Active' : 'Inactive'}</Badge>
      case 'createdAt':
        return p.createdAt.toLocaleDateString()
      case 'updatedAt':
        return p.updatedAt.toLocaleDateString()
    }
  }

  const numericCols = new Set<ColKey>(['totalStock', 'allocatedStock', 'availableStock', 'incomingStock', 'inventoryValue', 'salesPriceGbp', 'salePriceGbp', 'variantCount'])

  return (
    <div className="space-y-3">
      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 px-3 py-2 rounded-lg border border-primary/30 bg-primary/5 text-sm">
          <span className="font-medium">{selectedIds.size} selected</span>
          <Button size="sm" variant="outline" onClick={handleBulkDeactivate} disabled={bulkPending}>
            Deactivate
          </Button>
          <Button size="sm" variant="destructive" onClick={handleBulkDelete} disabled={bulkPending}>
            Delete
          </Button>
          <Button size="sm" variant="ghost" onClick={() => { setSelectedIds(new Set()); setBulkMsg(null) }}>
            Clear
          </Button>
          {bulkMsg && <span className="text-xs text-muted-foreground">{bulkMsg}</span>}
        </div>
      )}
      {!selectedIds.size && bulkMsg && (
        <p className="text-xs text-muted-foreground px-1">{bulkMsg}</p>
      )}

      {/* Table */}
        <Table containerClassName="rounded-lg border border-border bg-card max-h-[calc(100vh-16rem)]" className="min-w-[900px]">
          <TableHeader>
            <TableRow>
              {/* Select-all checkbox */}
              <TableHead className="w-8 px-2">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected }}
                  onChange={toggleSelectAll}
                  className="h-3.5 w-3.5 accent-primary cursor-pointer"
                  aria-label="Select all"
                />
              </TableHead>
              {/* Thumbnail */}
              <TableHead className="w-12 px-2" />
              {visibleCols.map((c) => {
                const sortKey = SORTABLE[c.key]
                const isSorted = currentSort === sortKey
                return (
                  <TableHead
                    key={c.key}
                    className={numericCols.has(c.key) ? 'text-right' : undefined}
                  >
                    {sortKey ? (
                      <Link
                        href={buildSortHref(sortKey)}
                        className="inline-flex items-center gap-1 hover:text-foreground"
                      >
                        {c.label}
                        {isSorted
                          ? (currentDir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)
                          : <ArrowUpDown className="h-3 w-3 opacity-30" />}
                      </Link>
                    ) : c.label}
                  </TableHead>
                )
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {products.length === 0 ? (
              <TableRow>
                <TableCell colSpan={visibleCols.length + 2} className="text-center text-muted-foreground py-10">
                  No products found.{' '}
                  <Link href="/inventory/new" className="text-primary hover:underline">
                    Add one
                  </Link>
                </TableCell>
              </TableRow>
            ) : (
              products.map((p) => (
                <TableRow key={p.id} data-selected={selectedIds.has(p.id) || undefined} className="data-[selected]:bg-primary/5">
                  {/* Row checkbox */}
                  <TableCell className="w-8 px-2 py-1">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(p.id)}
                      onChange={() => toggleSelect(p.id)}
                      className="h-3.5 w-3.5 accent-primary cursor-pointer"
                      aria-label={`Select ${p.sku}`}
                    />
                  </TableCell>
                  {/* Thumbnail — always visible */}
                  <TableCell className="w-12 px-2 py-1">
                    <Link href={`/inventory/${p.id}`} className="block">
                      {p.imageUrl ? (
                        <img
                          src={p.imageUrl}
                          alt={p.name}
                          width={36}
                          height={36}
                          className="h-9 w-9 rounded object-cover border border-border bg-muted"
                        />
                      ) : (
                        <span className="flex h-9 w-9 items-center justify-center rounded border border-border bg-muted text-muted-foreground">
                          <Package className="h-4 w-4" />
                        </span>
                      )}
                    </Link>
                  </TableCell>
                  {visibleCols.map((c) => (
                    <TableCell
                      key={c.key}
                      className={numericCols.has(c.key) ? 'text-right font-mono text-sm' : undefined}
                    >
                      {renderCell(p, c.key)}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>

      {/* Pagination */}
      <PaginationBar page={page} totalPages={totalPages} buildHref={buildPageHref} />
    </div>
  )
}
