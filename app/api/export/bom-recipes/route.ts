import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { buildTemplateCsv, csvResponse, toCsv } from '@/lib/csv'
import { requireApiAuth } from '@/lib/auth/server'
import { hasPermission } from '@/lib/permissions'
import { findBomRecipeDrift } from '@/lib/products/bom-recipe'

/**
 * READ-ONLY VIEW OF THE MANUFACTURING RECIPES, AND THE DRIFT CHECK (o3d-zjsb5.9).
 *
 * WHY THIS IS NOT AN IMPORT TEMPLATE OF ITS OWN. BOM recipes are loaded through the PRODUCTS CSV's
 * existing `components` column — one file, one ordering rule, one source cell for both
 * representations (see `lib/products/bom-recipe.ts`). So `?template=1` here returns the
 * PRODUCTS-shaped template rows an operator needs to state a manufacturing recipe, deliberately
 * cross-referenced to `/api/export/products?template=1`, rather than inventing a second import
 * surface that could disagree with the first.
 *
 * What this endpoint adds is the thing the products export cannot show: whether the recipe
 * actually reached `Bom`/`BomItem`, which is the half that PLANNING reads. `?drift=1` is the
 * consistency check between the two representations — the only thing that catches a divergence,
 * because the schema has no constraint tying them together.
 */

const RECIPE_HEADERS = ['sku', 'name', 'type', 'bomId', 'bomName', 'bomActive', 'bomClaimed', 'componentSku', 'componentName', 'qty', 'sortOrder']

const DRIFT_HEADERS = ['sku', 'productId', 'kind', 'detail']

const TEMPLATE_HEADERS = ['sku', 'name', 'type', 'components']
const TEMPLATE_REQUIRED_HEADERS = ['sku', 'name', 'type', 'components']

const MAX_EXPORT_ROWS = 50_000

export async function GET(req: NextRequest) {
  const session = await requireApiAuth()
  if (session instanceof NextResponse) return session
  if (!hasPermission(session.user.role, 'manufacturing')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  if (req.nextUrl.searchParams.get('template')) {
    return csvResponse(
      buildTemplateCsv(TEMPLATE_HEADERS, TEMPLATE_REQUIRED_HEADERS, [
        {
          sku: 'RAW-OAK',
          name: 'Oak board (component — must exist as a product first)',
          type: 'SIMPLE',
          components: '',
        },
        {
          sku: 'LEG-01',
          name: 'Table leg (a BOM can itself be a component of another BOM)',
          type: 'BOM',
          components: 'RAW-OAK:0.5',
        },
        {
          sku: 'TABLE-01',
          name: 'Oak table',
          type: 'BOM',
          components: 'LEG-01:4;RAW-OAK:2',
        },
      ]),
      'bom-recipes-template.csv',
    )
  }

  if (req.nextUrl.searchParams.get('drift')) {
    const drift = await findBomRecipeDrift(db)
    return csvResponse(
      toCsv(
        drift.map((row) => ({ sku: row.sku, productId: row.productId, kind: row.kind, detail: row.detail })),
        DRIFT_HEADERS,
      ),
      `bom-recipe-drift-${new Date().toISOString().slice(0, 10)}.csv`,
    )
  }

  const items = await db.bomItem.findMany({
    select: {
      qty: true,
      sortOrder: true,
      bom: { select: { id: true, name: true, active: true, productId: true } },
      parentProduct: { select: { sku: true, name: true, type: true } },
      component: { select: { sku: true, name: true } },
    },
    orderBy: [{ parentProductId: 'asc' }, { sortOrder: 'asc' }],
    take: MAX_EXPORT_ROWS,
  })

  const rows = items.map((item) => ({
    sku: item.parentProduct.sku,
    name: item.parentProduct.name,
    type: item.parentProduct.type,
    bomId: item.bom.id,
    bomName: item.bom.name,
    bomActive: item.bom.active ? 'TRUE' : 'FALSE',
    // Explicit, because an UNCLAIMED Bom is not maintained by the importer and will not track
    // `product_components` — that is drift waiting to happen, and the export must not hide it
    // behind rows that look identical to the claimed ones.
    bomClaimed: item.bom.productId ? 'TRUE' : 'FALSE',
    componentSku: item.component.sku,
    componentName: item.component.name,
    qty: item.qty.toString(),
    sortOrder: item.sortOrder,
  }))

  return csvResponse(
    toCsv(rows, RECIPE_HEADERS),
    `bom-recipes-${new Date().toISOString().slice(0, 10)}.csv`,
  )
}
