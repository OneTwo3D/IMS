/**
 * OWNER DECISIONS (sku-renames), the pure part: which of the listed renames are accepted and which are refused, and why.
 *
 * ONE code path for two callers: the first-load transform (loadSkuRenames, which applies the accepted renames to the source datasets of a run) and the
 * reconciliation pack (lib/reconciliation-pack/qoblex-source.ts, which applies the SAME list to the native Qoblex export it compares, so a renamed SKU
 * is compared under the SKU IMS holds). Neither re-implements a rule.
 *
 * A rename is refused (never guessed) when: its SKU is bad, it has no reason, it renames a SKU to itself, its fromSku is listed twice, two renames share a
 * toSku, it chains into (or loops through) another rename, its toSku already exists in a source dataset, or (unless `fromMayBeAbsent`) its fromSku is in no
 * source dataset, or (when `excluded` is given: SKU key -> SKU of the exclusion list) it touches an excluded SKU. `present` maps a SKU key to the datasets that hold it.
 */

import type { CanonRow } from './ingest'
import { parseSku } from './validate'

export type SkuRenameItem = { row: CanonRow; from: string; fromKey: string; to: string; toKey: string }
export type SkuRenameRefusal = { line: number; label: string; code: string; reason: string }
export type SkuRenamePlan = {
  /** The accepted renames by the key of their fromSku, in file order. */
  accepted: Map<string, SkuRenameItem>
  /** Every refused row, in the order the transform reports them (rows that did not parse first, then the refused items). */
  refusals: SkuRenameRefusal[]
}

export function planSkuRenames(rows: readonly CanonRow[], present: ReadonlyMap<string, ReadonlySet<string>>, options: { fromMayBeAbsent?: boolean; excluded?: ReadonlyMap<string, string> } = {}): SkuRenamePlan {
  const refusals: SkuRenameRefusal[] = []
  const items: SkuRenameItem[] = []
  for (const row of rows) {
    const from = parseSku(row.values.fromSku, 'fromSku')
    const to = parseSku(row.values.toSku, 'toSku')
    const label = from.ok ? from.sku : row.values.fromSku
    if (!from.ok) { refusals.push({ line: row.line, label, code: 'BAD_SKU', reason: from.reason }); continue }
    if (!to.ok) { refusals.push({ line: row.line, label, code: 'BAD_SKU', reason: to.reason }); continue }
    if (row.values.reason === '') { refusals.push({ line: row.line, label, code: 'MISSING_REASON', reason: 'a SKU rename needs a written reason' }); continue }
    if (from.key === to.key) { refusals.push({ line: row.line, label, code: 'RENAME_TO_SELF', reason: `${from.sku} is renamed to ${to.sku}, which is the same SKU` }); continue }
    items.push({ row, from: from.sku, fromKey: from.key, to: to.sku, toKey: to.key })
  }
  const refused = new Map<SkuRenameItem, { code: string; reason: string }>()
  const refuse = (item: SkuRenameItem, code: string, reason: string): void => {
    if (!refused.has(item)) refused.set(item, { code, reason })
  }
  // An exclusion is the owner's record that a SKU is NOT loaded. A rename that touches an excluded SKU would silently move the product out of (or into) that decision, so it is refused.
  const excludedKeys = options.excluded
  if (excludedKeys) {
    for (const item of items) {
      if (excludedKeys.has(item.fromKey)) refuse(item, 'RENAME_FROM_EXCLUDED', `${item.from} is on sku-exclusions, so it is deliberately not loaded; a rename would override that. To keep it out, drop the rename and exclude ${item.from}; to load it as ${item.to}, remove the exclusion`)
      else if (excludedKeys.has(item.toKey)) refuse(item, 'RENAME_TO_EXCLUDED', `${item.to} is on sku-exclusions, so it is deliberately not loaded; the rename would silently exclude ${item.from} under that SKU. To exclude the renamed product, drop the rename and exclude ${item.from}; to load it, remove the exclusion`)
    }
  }
  const byFrom = new Map<string, SkuRenameItem[]>()
  const byTo = new Map<string, SkuRenameItem[]>()
  for (const item of items) {
    byFrom.set(item.fromKey, [...(byFrom.get(item.fromKey) ?? []), item])
    byTo.set(item.toKey, [...(byTo.get(item.toKey) ?? []), item])
  }
  for (const list of byFrom.values()) if (list.length > 1) for (const item of list) refuse(item, 'DUPLICATE_RENAME', `${item.from} is renamed ${list.length} times; which rename is meant cannot be decided`)
  for (const list of byTo.values()) if (list.length > 1) for (const item of list) refuse(item, 'RENAME_TARGET_COLLISION', `${list.length} SKUs are renamed to ${item.to}; they would become one product`)
  for (const item of items) {
    const next = byFrom.get(item.toKey)
    if (next) refuse(item, 'RENAME_CHAIN', `${item.to} is itself renamed (${next.map((n) => `${n.from} -> ${n.to}`).join(', ')}); a chain or a cycle of renames is never followed, state the final SKU directly`)
    const previous = byTo.get(item.fromKey)
    if (previous) refuse(item, 'RENAME_CHAIN', `${item.from} is the target of another rename (${previous.map((n) => `${n.from} -> ${n.to}`).join(', ')}); a chain or a cycle of renames is never followed`)
  }
  for (const item of items) {
    if (refused.has(item)) continue
    if (!present.has(item.fromKey)) {
      if (options.fromMayBeAbsent !== true) refuse(item, 'RENAME_FROM_NOT_IN_SOURCE', `${item.from} is in no source dataset of this run (a typo, or the wrong file)`)
    } else if (present.has(item.toKey)) refuse(item, 'RENAME_TARGET_EXISTS', `${item.to} already exists in the source (${[...present.get(item.toKey)!].join(', ')}); renaming ${item.from} to it would merge two different products`)
  }
  const accepted = new Map<string, SkuRenameItem>()
  for (const item of items) {
    const why = refused.get(item)
    if (why) refusals.push({ line: item.row.line, label: item.from, code: why.code, reason: why.reason })
    else accepted.set(item.fromKey, item)
  }
  return { accepted, refusals }
}
