import { NextResponse } from 'next/server'
import type { ProductLifecycleStatus, ProductType } from '@/app/generated/prisma/client'
import type { AuthSession } from '@/lib/auth/server'
import { csvResponse } from '@/lib/csv'
import { hasPermission } from '@/lib/permissions'
import { chooseProductCsvColumns } from '@/lib/products/csv-roundtrip/columns'
import {
  loadSelectedProducts,
  PRODUCT_CSV_MAX_ROWS,
  ProductCsvSelectionTooLargeError,
  type ProductCsvSelection,
} from '@/lib/products/csv-roundtrip/selection'
import { createProductCsvStore, type ProductCsvDb } from '@/lib/products/csv-roundtrip/store'
import { buildProductCsvTemplate } from '@/lib/products/csv-roundtrip/template'
import type { ProductListFilter } from '@/lib/products/list-filter'

const PRODUCT_TYPES = new Set(['ALL', 'SIMPLE', 'VARIABLE', 'VARIANT', 'KIT', 'BOM', 'NON_INVENTORY'])
const LIFECYCLES = new Set(['ALL', 'DRAFT', 'ACTIVE', 'EOL', 'ARCHIVED'])

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function parseSelection(body: Record<string, unknown>): ProductCsvSelection | string {
  if (body.mode === 'ids') {
    if (!Array.isArray(body.ids) || body.ids.length === 0 || !body.ids.every((id) => typeof id === 'string')) return 'Select at least one product.'
    if (body.ids.length > PRODUCT_CSV_MAX_ROWS) return `Select at most ${PRODUCT_CSV_MAX_ROWS} products at once.`
    return { mode: 'ids', ids: body.ids as string[] }
  }
  if (body.mode === 'filter') {
    const raw = (body.filter ?? {}) as Record<string, unknown>
    const type = str(raw.type)
    const lifecycleStatus = str(raw.lifecycleStatus)
    if (type && !PRODUCT_TYPES.has(type)) return 'Unknown product type filter.'
    if (lifecycleStatus && !LIFECYCLES.has(lifecycleStatus)) return 'Unknown lifecycle filter.'
    const filter: ProductListFilter = {
      search: str(raw.search),
      type: type as ProductType | 'ALL' | undefined,
      lifecycleStatus: lifecycleStatus as ProductLifecycleStatus | 'ALL' | undefined,
      categoryId: str(raw.categoryId),
      supplierId: str(raw.supplierId),
    }
    return { mode: 'filter', filter }
  }
  return 'Choose products by id or by filter.'
}

export type ProductCsvDownloadDeps = {
  requireApiAuth: () => Promise<AuthSession | Response>
  client: ProductCsvDb
}

/**
 * The pre-filled "Edit by CSV" file for a selection and a set of columns.
 * Body: { mode: 'ids', ids: string[], columns: string[] } or { mode: 'filter', filter: {...}, columns: string[] }.
 * Needs inventory.edit; price columns also need inventory.prices.
 */
export async function handleProductCsvDownload(req: Request, deps: ProductCsvDownloadDeps): Promise<Response> {
  const session = await deps.requireApiAuth()
  if (session instanceof Response) return session
  const role = session.user.role
  if (!hasPermission(role, 'inventory.edit')) return new Response('Forbidden', { status: 403 })

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'The request body must be JSON.' }, { status: 400 })
  }

  const chosen = chooseProductCsvColumns(Array.isArray(body.columns) ? body.columns.map(String) : [], (permission) => hasPermission(role, permission))
  if (!chosen.ok) return NextResponse.json({ error: chosen.error }, { status: chosen.error.includes('permission') ? 403 : 400 })

  const selection = parseSelection(body)
  if (typeof selection === 'string') return NextResponse.json({ error: selection }, { status: 400 })

  try {
    const [products, tables] = await Promise.all([
      loadSelectedProducts(deps.client, selection),
      createProductCsvStore(deps.client).loadLookupTables(),
    ])
    if (products.length === 0) return NextResponse.json({ error: 'No products match that selection.' }, { status: 404 })
    const csv = buildProductCsvTemplate(products, chosen.columns, tables)
    return csvResponse(csv, `products-edit-${new Date().toISOString().slice(0, 10)}.csv`)
  } catch (error) {
    if (error instanceof ProductCsvSelectionTooLargeError) return NextResponse.json({ error: error.message }, { status: 413 })
    throw error
  }
}
