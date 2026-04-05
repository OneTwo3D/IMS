'use client'

import { useState, useEffect, useRef, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Download, Columns3, Package } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table'
import { CsvImportButton } from './csv-import-button'
import { importProductsCsv } from '@/app/actions/import'
import { bulkDeleteProducts, bulkDeactivateProducts } from '@/app/actions/products'
import { buttonVariants } from '@/components/ui/button-variants'
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

type ColKey =
  | 'sku' | 'name' | 'type' | 'parentSku' | 'barcode'
  | 'dimensions' | 'weight' | 'salesPriceGbp' | 'salePriceGbp' | 'salesPriceTaxInclusive'
  | 'totalStock' | 'inventoryValue' | 'variantCount'
  | 'active' | 'createdAt' | 'updatedAt'

const ALL_COLUMNS: { key: ColKey; label: string; defaultVisible: boolean }[] = [
  { key: 'sku',                  label: 'SKU',                defaultVisible: true  },
  { key: 'name',                 label: 'Name',               defaultVisible: true  },
  { key: 'type',                 label: 'Type',               defaultVisible: true  },
  { key: 'parentSku',            label: 'Parent SKU',         defaultVisible: false },
  { key: 'barcode',              label: 'Barcode',            defaultVisible: false },
  { key: 'dimensions',           label: 'Dimensions (W×H×D)', defaultVisible: false },
  { key: 'weight',               label: 'Weight',             defaultVisible: false },
  { key: 'salesPriceGbp',        label: 'Regular Price',      defaultVisible: true  },
  { key: 'salePriceGbp',         label: 'Sale Price',         defaultVisible: false },
  { key: 'salesPriceTaxInclusive', label: 'Tax Incl.',        defaultVisible: false },
  { key: 'totalStock',           label: 'Stock',              defaultVisible: true  },
  { key: 'inventoryValue',       label: 'COGS Value',         defaultVisible: true  },
  { key: 'variantCount',         label: 'Variants',           defaultVisible: false },
  { key: 'active',               label: 'Status',             defaultVisible: true  },
  { key: 'createdAt',            label: 'Created',            defaultVisible: false },
  { key: 'updatedAt',            label: 'Updated',            defaultVisible: false },
]

const STORAGE_KEY = 'ims-product-table-cols'

function defaultVisibility(): Record<ColKey, boolean> {
  return Object.fromEntries(
    ALL_COLUMNS.map((c) => [c.key, c.defaultVisible])
  ) as Record<ColKey, boolean>
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
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)
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
  }

  async function handleBulkDeactivate() {
    const ids = [...selectedIds]
    setBulkPending(true)
    setBulkMsg(null)
    const result = await bulkDeactivateProducts(ids)
    setBulkPending(false)
    setSelectedIds(new Set())
    setBulkMsg(`Deactivated ${result.deactivated} product${result.deactivated !== 1 ? 's' : ''}.`)
    startTransition(() => router.refresh())
  }

  // Load from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) setVisible(JSON.parse(stored))
    } catch {
      // ignore
    }
  }, [])

  // Close picker on outside click
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
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)) } catch { /* noop */ }
  }

  const visibleCols = ALL_COLUMNS.filter((c) => visible[c.key])
  const totalPages = Math.ceil(total / pageSize)

  function buildPageHref(p: number) {
    const params = new URLSearchParams()
    if (searchParams.search) params.set('search', searchParams.search)
    if (searchParams.type) params.set('type', searchParams.type)
    if (searchParams.active) params.set('active', searchParams.active)
    params.set('page', String(p))
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
        return p.salesPriceGbp ? `£${Number(p.salesPriceGbp).toFixed(2)}` : '—'
      case 'salePriceGbp':
        return p.salePriceGbp ? `£${Number(p.salePriceGbp).toFixed(2)}` : '—'
      case 'salesPriceTaxInclusive':
        return p.salesPriceTaxInclusive ? 'Yes' : 'No'
      case 'totalStock':
        if (p.type === 'VARIABLE') return '—'
        if (p.type === 'NON_INVENTORY') return '∞'
        return `${Number(p.totalStock).toLocaleString()} ${p.stockUnit}`
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

  const numericCols = new Set<ColKey>(['totalStock', 'inventoryValue', 'salesPriceGbp', 'salePriceGbp', 'variantCount'])

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

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 justify-end">
        {/* Column visibility picker */}
        <div className="relative" ref={pickerRef}>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPickerOpen((o) => !o)}
          >
            <Columns3 className="h-4 w-4 mr-1" />
            Columns
          </Button>
          {pickerOpen && (
            <div className="absolute right-0 top-full mt-1 z-50 w-52 rounded-md border border-border bg-popover shadow-md p-2 space-y-1">
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

        {/* Export */}
        <a
          href="/api/export/products?template=1"
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          <Download className="h-4 w-4 mr-1" />
          Template
        </a>
        <a
          href="/api/export/products"
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          <Download className="h-4 w-4 mr-1" />
          Export CSV
        </a>

        {/* Import */}
        <CsvImportButton
          label="Import CSV"
          action={importProductsCsv}
          onDone={() => startTransition(() => router.refresh())}
        />
      </div>

      {/* Table */}
      <div className="rounded-lg border border-border bg-card overflow-x-auto">
        <Table>
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
              {visibleCols.map((c) => (
                <TableHead
                  key={c.key}
                  className={numericCols.has(c.key) ? 'text-right' : undefined}
                >
                  {c.label}
                </TableHead>
              ))}
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
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <div className="flex gap-2">
            {page > 1 && (
              <Link
                href={buildPageHref(page - 1)}
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
              >
                Previous
              </Link>
            )}
            {page < totalPages && (
              <Link
                href={buildPageHref(page + 1)}
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
              >
                Next
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
