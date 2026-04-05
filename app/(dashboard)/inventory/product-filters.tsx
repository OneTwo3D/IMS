'use client'

import { useRouter, usePathname } from 'next/navigation'
import { useTransition, useCallback } from 'react'
import { Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'

type Props = {
  search?: string
  type?: string
  active?: string
}

export function ProductFilters({ search, type, active }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const [, startTransition] = useTransition()

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
    <div className="flex flex-wrap gap-3">
      <div className="relative flex-1 min-w-[200px] max-w-sm">
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
        className="w-44"
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
        className="w-40"
        value={active ?? 'all'}
        onChange={(e) => update('active', e.target.value === 'all' ? '' : e.target.value)}
      >
        <option value="all">All Status</option>
        <option value="true">Active only</option>
        <option value="false">Inactive only</option>
      </Select>
    </div>
  )
}
