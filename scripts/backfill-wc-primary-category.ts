#!/usr/bin/env tsx
//
// One-off backfill: re-resolve each WC-linked product's IMS category using the
// primary-category logic (Yoast / Rank Math primary → deepest fallback), for
// products imported before that logic existed.
//
// Phase A — parents: pages WooCommerce /products (SIMPLE + VARIABLE parents),
// resolves the category, and updates the matching IMS product (joined by
// externalProductId, falling back to SKU) only when it actually changes.
// Phase B — variants: VARIANT products inherit their parent's resolved category.
//
// Never CLEARS a category (skips when nothing resolves / parent has no category).
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
    select: { id: true, sku: true, type: true, parentId: true, externalProductId: true, categoryId: true },
  })
  const byExternalId = new Map<string, typeof imsProducts[number]>()
  const bySku = new Map<string, typeof imsProducts[number]>()
  const currentCategoryById = new Map<string, string | null>()
  for (const p of imsProducts) {
    currentCategoryById.set(p.id, p.categoryId)
    if (p.externalProductId != null) byExternalId.set(p.externalProductId.toString(), p)
    const sku = p.sku?.trim()
    if (sku) bySku.set(sku, p)
  }

  let page = 1
  let scanned = 0
  let unmatched = 0
  let unresolved = 0
  const changes: Array<{ id: string; sku: string; from: string | null; to: string | null }> = []
  // The category each matched parent WILL have after this run (its resolved value) —
  // used so variants inherit the post-backfill parent category, in dry-run and apply.
  const resolvedByImsId = new Map<string, string>()

  while (true) {
    const res = await wcFetch('/products', { per_page: '100', page: String(page), status: 'any' })
    if (res.error) { console.error(`WC /products page ${page} failed: ${res.error}`); process.exit(1) }
    const products = (Array.isArray(res.data) ? res.data : []) as WcProductLite[]
    if (products.length === 0) break

    for (const wc of products) {
      scanned++
      // Prefer the durable WC-id link. Only fall back to SKU for products with no
      // externalProductId yet, and never let a shared SKU hijack a product already
      // linked to a different WC id.
      const wcSku = wc.sku?.trim()
      const skuMatch = wcSku ? bySku.get(wcSku) : undefined
      const ims = byExternalId.get(String(wc.id))
        ?? (skuMatch && skuMatch.externalProductId == null ? skuMatch : undefined)
      if (!ims) { unmatched++; continue }
      const resolved = resolveImsCategoryId(wc.categories ?? [], wc.meta_data, mirror)
      // Never CLEAR a category: if nothing resolves (no mapped/primary WC category),
      // leave the existing IMS category untouched rather than nulling it.
      if (resolved == null) { unresolved++; continue }
      resolvedByImsId.set(ims.id, resolved)
      if (resolved !== ims.categoryId) {
        changes.push({ id: ims.id, sku: ims.sku, from: ims.categoryId, to: resolved })
      }
    }

    if (res.totalPages && res.totalPages <= page) break
    page += 1
  }

  // Phase B: VARIANT products inherit their parent's (resolved) category. Only VARIANT
  // children are WooCommerce variations; KIT/BOM children are a different concept and
  // are intentionally out of scope. Use the parent's post-backfill category when known,
  // else its current stored category. Only propagate a non-null parent category (never
  // clear a variant's category).
  const typeById = new Map(imsProducts.map((p) => [p.id, p.type]))
  const variantChanges: Array<{ id: string; sku: string; from: string | null; to: string }> = []
  let orphanVariants = 0
  for (const p of imsProducts) {
    if (p.type !== 'VARIANT' || !p.parentId) continue
    // Defensive: a VARIANT should point at a VARIABLE parent. Skip + count anything else.
    if (typeById.get(p.parentId) !== 'VARIABLE') { orphanVariants++; continue }
    const parentCategory = resolvedByImsId.get(p.parentId) ?? currentCategoryById.get(p.parentId) ?? null
    if (parentCategory != null && parentCategory !== p.categoryId) {
      variantChanges.push({ id: p.id, sku: p.sku, from: p.categoryId, to: parentCategory })
    }
  }
  if (orphanVariants > 0) {
    console.warn(`WARNING: ${orphanVariants} VARIANT product(s) have a missing or non-VARIABLE parent — skipped.`)
  }

  // Resolve category names for a readable report.
  const allChanges = [...changes, ...variantChanges]
  const catIds = Array.from(new Set(allChanges.flatMap((c) => [c.from, c.to]).filter((x): x is string => Boolean(x))))
  const cats = catIds.length > 0
    ? await db.productCategory.findMany({ where: { id: { in: catIds } }, select: { id: true, name: true } })
    : []
  const nameById = new Map(cats.map((c) => [c.id, c.name]))
  const label = (id: string | null) => (id ? nameById.get(id) ?? id : '(none)')

  console.log(`Scanned ${scanned} WC products · matched IMS: ${scanned - unmatched} · unmatched (no IMS SKU/link): ${unmatched} · unresolved (no mapped category, left untouched): ${unresolved}`)
  console.log(`Phase A — parent category changes: ${changes.length}`)
  for (const c of changes.slice(0, 15)) console.log(`  ${c.sku}: ${label(c.from)} -> ${label(c.to)}`)
  if (changes.length > 15) console.log(`  … and ${changes.length - 15} more`)
  console.log(`Phase B — variant inheritance changes: ${variantChanges.length}`)
  for (const c of variantChanges.slice(0, 15)) console.log(`  ${c.sku}: ${label(c.from)} -> ${label(c.to)}`)
  if (variantChanges.length > 15) console.log(`  … and ${variantChanges.length - 15} more`)

  if (!APPLY) {
    // Note: ensureWcCategoryTreeMirrored() above mirrors the WC category TREE into
    // IMS ProductCategory (idempotent upserts) as a prerequisite for resolution —
    // that runs in dry-run too. No PRODUCT category assignments are written here.
    console.log('\nDRY RUN — no product category changes written. Re-run with --apply to persist.')
    return
  }

  let updated = 0
  for (const c of allChanges) {
    await db.product.update({ where: { id: c.id }, data: { categoryId: c.to } })
    updated++
  }
  console.log(`\nAPPLIED ${updated} category update(s) (${changes.length} parents, ${variantChanges.length} variants).`)
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error('FAILED:', e); process.exit(1) })
