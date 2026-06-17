#!/usr/bin/env tsx
//
// One-off backfill: HTML-entity-decode existing ProductCategory names that were
// mirrored/imported from WooCommerce before decoding existed (e.g. "Tool
// Changers &amp; Multi Material", "&#038;"). cleanProductCategoryName now
// decodes entities, which also changes the derived nameNormalized — so existing
// rows must be rewritten or the next WC sync would create duplicates against the
// new normalized keys.
//
// Recomputes BOTH name (decoded leaf) and nameNormalized (full path) topologically
// — a parent's decoded segment cascades into every descendant's path. Skips (and
// reports) any row whose decoded nameNormalized would collide with another
// category, so two categories are never silently merged.
//
// Dry-run by default. Pass --apply to write. Requires DATABASE_URL.
//
//   tsx scripts/backfill-decode-category-names.ts          # dry run
//   tsx scripts/backfill-decode-category-names.ts --apply  # write

import { db } from '../lib/db/index'
import {
  cleanProductCategoryName,
  normalizeProductCategoryName,
  PRODUCT_CATEGORY_PATH_DELIMITER,
} from '../lib/products/categories'

const APPLY = process.argv.includes('--apply')

type Row = { id: string; name: string; nameNormalized: string; parentId: string | null }

async function main() {
  console.log(`[backfill-decode-category-names] mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`)

  const rows: Row[] = await db.productCategory.findMany({
    select: { id: true, name: true, nameNormalized: true, parentId: true },
  })
  const byId = new Map(rows.map((r) => [r.id, r] as const))

  // Topological order (parents before children) so a node's new path can be
  // built from its parent's already-computed new path. Cycle-safe.
  const ordered: Row[] = []
  const placed = new Set<string>()
  function place(r: Row, stack: Set<string>) {
    if (placed.has(r.id) || stack.has(r.id)) return
    stack.add(r.id)
    const parent = r.parentId ? byId.get(r.parentId) : undefined
    if (parent) place(parent, stack)
    stack.delete(r.id)
    if (!placed.has(r.id)) {
      placed.add(r.id)
      ordered.push(r)
    }
  }
  for (const r of rows) place(r, new Set())

  const newNormById = new Map<string, string>()
  const newNameById = new Map<string, string>()
  for (const r of ordered) {
    const newLeaf = cleanProductCategoryName(r.name) ?? r.name
    const normalizedLeaf = normalizeProductCategoryName(newLeaf)
    const parentNorm = r.parentId ? newNormById.get(r.parentId) : undefined
    const newNorm = parentNorm
      ? `${parentNorm}${PRODUCT_CATEGORY_PATH_DELIMITER}${normalizedLeaf}`
      : normalizedLeaf
    newNormById.set(r.id, newNorm)
    newNameById.set(r.id, newLeaf)
  }

  // Detect collisions: a new normalized key already taken by a DIFFERENT category.
  const finalNormToIds = new Map<string, string[]>()
  for (const r of rows) {
    const norm = newNormById.get(r.id)!
    finalNormToIds.set(norm, [...(finalNormToIds.get(norm) ?? []), r.id])
  }
  const collisions = [...finalNormToIds.entries()].filter(([, ids]) => ids.length > 1)

  const changing = rows.filter(
    (r) => newNameById.get(r.id) !== r.name || newNormById.get(r.id) !== r.nameNormalized,
  )
  const collidingIds = new Set(collisions.flatMap(([, ids]) => ids))
  const safeChanges = changing.filter((r) => !collidingIds.has(r.id))

  console.log(`Categories: ${rows.length} total, ${changing.length} need decoding, ` +
    `${collisions.length} collision group(s), ${safeChanges.length} safe to update.`)
  for (const r of safeChanges) {
    console.log(`  ${r.id}: "${r.name}" → "${newNameById.get(r.id)}"  [${r.nameNormalized} → ${newNormById.get(r.id)}]`)
  }
  for (const [norm, ids] of collisions) {
    console.warn(`  ⚠ COLLISION on "${norm}" — categories ${ids.join(', ')} would merge; SKIPPED. Resolve manually.`)
  }

  if (!APPLY) {
    console.log('Dry run — no changes written. Re-run with --apply to write.')
    return
  }
  if (safeChanges.length === 0) {
    console.log('Nothing to update.')
    return
  }

  // Two-phase within a transaction to avoid transient unique violations: park
  // every changing row on a guaranteed-unique temp key, then write finals.
  await db.$transaction(async (tx) => {
    for (const r of safeChanges) {
      await tx.productCategory.update({ where: { id: r.id }, data: { nameNormalized: `__decode_migrate__:${r.id}` } })
    }
    for (const r of safeChanges) {
      await tx.productCategory.update({
        where: { id: r.id },
        data: { name: newNameById.get(r.id)!, nameNormalized: newNormById.get(r.id)! },
      })
    }
  })
  console.log(`Updated ${safeChanges.length} categor${safeChanges.length === 1 ? 'y' : 'ies'}.`)
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error('FAILED:', e); process.exit(1) })
