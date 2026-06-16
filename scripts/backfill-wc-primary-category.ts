#!/usr/bin/env tsx
//
// One-off backfill: re-resolve each WC-linked product's IMS category using the
// primary-category logic (Yoast / Rank Math primary → deepest fallback), for
// products imported before that logic existed.
//
// Mirrors the importer's scope: pages WooCommerce /products (SIMPLE + VARIABLE
// parents — the products the importer assigns a category to; variations never
// carry a category), resolves the category, and updates the matching IMS product
// (joined by externalProductId, falling back to SKU) only when it actually changes.
//
// Dry-run by default. Pass --apply to write. Requires DATABASE_URL,
// SETTINGS_ENCRYPTION_KEY (to read encrypted WC credentials) in the environment.
//
//   tsx scripts/backfill-wc-primary-category.ts            # dry run
//   tsx scripts/backfill-wc-primary-category.ts --apply    # write

import { db } from '../lib/db/index'
import { wcFetch } from '../lib/connectors/woocommerce/api'
import { ensureWcCategoryTreeMirrored, resolveImsCategoryId } from '../lib/connectors/woocommerce/sync/category-mirror'

const APPLY = process.argv.includes('--apply')

type WcProductLite = {
  id: number
  sku: string
  categories?: { id: number }[]
  meta_data?: { key: string; value: unknown }[]
}

async function main() {
  console.log(`[backfill-wc-primary-category] mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`)

  const mirror = await ensureWcCategoryTreeMirrored()
  if (!mirror) {
    console.error('Could not build the WC category mirror (categories endpoint unreachable). Aborting.')
    process.exit(1)
  }

  // Index existing IMS products by their WC link and by SKU.
  const imsProducts = await db.product.findMany({
    select: { id: true, sku: true, externalProductId: true, categoryId: true },
  })
  const byExternalId = new Map<string, typeof imsProducts[number]>()
  const bySku = new Map<string, typeof imsProducts[number]>()
  for (const p of imsProducts) {
    if (p.externalProductId != null) byExternalId.set(p.externalProductId.toString(), p)
    if (p.sku) bySku.set(p.sku, p)
  }

  let page = 1
  let scanned = 0
  let unmatched = 0
  const changes: Array<{ id: string; sku: string; from: string | null; to: string | null }> = []

  while (true) {
    const res = await wcFetch('/products', { per_page: '100', page: String(page), status: 'any' })
    if (res.error) { console.error(`WC /products page ${page} failed: ${res.error}`); process.exit(1) }
    const products = (Array.isArray(res.data) ? res.data : []) as WcProductLite[]
    if (products.length === 0) break

    for (const wc of products) {
      scanned++
      const ims = byExternalId.get(String(wc.id)) ?? (wc.sku ? bySku.get(wc.sku) : undefined)
      if (!ims) { unmatched++; continue }
      const resolved = resolveImsCategoryId(wc.categories ?? [], wc.meta_data, mirror)
      // Only the importer's own resolution drives this column, so only touch rows
      // where the resolved category actually differs from what's stored.
      if (resolved !== ims.categoryId) {
        changes.push({ id: ims.id, sku: ims.sku, from: ims.categoryId, to: resolved })
      }
    }

    if (res.totalPages && res.totalPages <= page) break
    page += 1
  }

  // Resolve category names for a readable report.
  const catIds = Array.from(new Set(changes.flatMap((c) => [c.from, c.to]).filter((x): x is string => Boolean(x))))
  const cats = catIds.length > 0
    ? await db.productCategory.findMany({ where: { id: { in: catIds } }, select: { id: true, name: true } })
    : []
  const nameById = new Map(cats.map((c) => [c.id, c.name]))
  const label = (id: string | null) => (id ? nameById.get(id) ?? id : '(none)')

  console.log(`Scanned ${scanned} WC products · matched IMS: ${scanned - unmatched} · unmatched (no IMS SKU/link): ${unmatched}`)
  console.log(`Category changes to apply: ${changes.length}`)
  for (const c of changes.slice(0, 25)) {
    console.log(`  ${c.sku}: ${label(c.from)} -> ${label(c.to)}`)
  }
  if (changes.length > 25) console.log(`  … and ${changes.length - 25} more`)

  if (!APPLY) {
    console.log('\nDRY RUN — no changes written. Re-run with --apply to persist.')
    return
  }

  let updated = 0
  for (const c of changes) {
    await db.product.update({ where: { id: c.id }, data: { categoryId: c.to } })
    updated++
  }
  console.log(`\nAPPLIED ${updated} category update(s).`)
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error('FAILED:', e); process.exit(1) })
