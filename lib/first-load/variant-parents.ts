/**
 * THE VARIANT-PARENT JOIN: Qoblex variants (which come with no parent) are joined to the WooCommerce variation that has the SAME SKU,
 * and the VARIABLE parent of that variation becomes the parent of the variant.
 *
 * PURE. It takes the parsed `variant-parents` rows (one per WooCommerce variation, written by the read-only snapshot command) and a view
 * of the Qoblex catalogue, and returns what to assign, which VARIABLE parents to emit, and a disposition for every row it read.
 *
 * THE JOIN KEY IS THE VARIATION SKU, NEVER A STEM. Stripping a trailing "-NN" from a variant SKU agrees with the real WooCommerce parent for
 * only about nine variants in ten on the real catalogue, and a wrong parent loads silently. The stem is computed here ONLY to warn
 * (`PARENT_STEM_MISMATCH`); it never assigns anything.
 *
 * A variant that matches no variation stays `VARIANT_WITHOUT_PARENT` (the caller rejects it): it is never loaded as a simple product, because that
 * would lose the parent link without a trace.
 */
import type { CanonRow } from './ingest'
import { VARIANT_PARENT_STATUS_LIFECYCLE } from './spec'
import { parseSku, skuKey, type Outcome } from './validate'

export type CatalogueView =
  | { state: 'candidate'; sku: string; type: string; parentSku: string }
  | { state: 'rejected' }
  | { state: 'excluded' }
  | { state: 'absent' }

export interface VariantJoinInput {
  rows: CanonRow[]
  /** What the Qoblex products dataset says about a SKU key (upper-case). */
  catalogue: (key: string) => CatalogueView
  /** SKU keys that already exist in the target IMS. */
  imsKeys: ReadonlySet<string>
  /** SKU key -> reason, from the accepted exclusion list. */
  exclusions: ReadonlyMap<string, string>
}

export interface VariantJoinDisposition {
  line: number
  key: string
  outcome: Outcome
  code: string
  reason: string
}

export interface VariantJoinFinding {
  severity: 'ERROR' | 'WARNING' | 'INFO'
  code: string
  message: string
  keys: string[]
}

export interface SyntheticParent {
  sku: string
  key: string
  name: string
  lifecycle: 'ACTIVE' | 'DRAFT'
  wooParentId: string
  variants: string[]
}

export interface VariantJoinResult {
  dispositions: VariantJoinDisposition[]
  findings: VariantJoinFinding[]
  /** Qoblex variant key -> parent SKU, for variants that had no parent. */
  assignments: Map<string, string>
  parents: SyntheticParent[]
  /** Every SKU key the dataset names (variations and parents), so an exclusion on one of them is not reported as stale. */
  namedKeys: Set<string>
  summary: { rowsRead: number; variantsJoined: number; parentsEmitted: number; parentsWithoutQoblexVariant: number }
}

interface Item {
  row: CanonRow
  variantSku: string
  variantKey: string
  parentSku: string
  parentKey: string
  parentName: string
  status: string
  lifecycle: 'ACTIVE' | 'DRAFT'
  wooVariationId: string
  wooParentId: string
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** The "-NN" stem of a variant SKU, used ONLY to warn when it disagrees with the real parent. */
export function skuStem(sku: string): string {
  return skuKey(sku).replace(/-\d+$/, '')
}

export function joinVariantParents(input: VariantJoinInput): VariantJoinResult {
  const dispositions: VariantJoinDisposition[] = []
  const findings: VariantJoinFinding[] = []
  const add = (row: CanonRow, key: string, outcome: Outcome, code: string, reason: string) => dispositions.push({ line: row.line, key, outcome, code, reason })
  const namedKeys = new Set<string>()

  // 1. Per-row validation. A row that cannot be understood is rejected: it is never skipped quietly.
  const valid: Item[] = []
  for (const row of input.rows) {
    const v = row.values
    const variant = parseSku(v.variantSku, 'variantSku')
    if (!variant.ok) { add(row, v.variantSku, 'REJECTED', 'BAD_SKU', variant.reason); continue }
    namedKeys.add(variant.key)
    const parent = parseSku(v.parentSku, 'parentSku')
    if (!parent.ok) { add(row, variant.sku, 'REJECTED', 'BAD_PARENT_SKU', parent.reason); continue }
    namedKeys.add(parent.key)
    if (v.parentName === '') { add(row, variant.sku, 'REJECTED', 'MISSING_PARENT_NAME', `the WooCommerce parent ${parent.sku} has no title`); continue }
    const status = v.parentStatus.trim().toLowerCase()
    const lifecycle = Object.prototype.hasOwnProperty.call(VARIANT_PARENT_STATUS_LIFECYCLE, status) ? VARIANT_PARENT_STATUS_LIFECYCLE[status] : undefined
    if (lifecycle === undefined) {
      add(row, variant.sku, 'REJECTED', 'UNMAPPED_PARENT_STATUS', `parent status ${JSON.stringify(v.parentStatus)} is not one of ${Object.keys(VARIANT_PARENT_STATUS_LIFECYCLE).join(', ')} (a closed list: add a mapping deliberately)`)
      continue
    }
    const badId = (['wooVariationId', 'wooParentId'] as const).find((column) => v[column] !== '' && !/^[0-9]{1,18}$/.test(v[column]))
    if (badId) { add(row, variant.sku, 'REJECTED', 'BAD_ID', `${badId} ${JSON.stringify(v[badId])} is not a whole number`); continue }
    valid.push({
      row, variantSku: variant.sku, variantKey: variant.key, parentSku: parent.sku, parentKey: parent.key, parentName: v.parentName,
      status, lifecycle, wooVariationId: v.wooVariationId, wooParentId: v.wooParentId,
    })
  }

  // 2. A variation SKU may appear once. An exact repeat is the same variation twice; anything else cannot be decided.
  const byVariant = new Map<string, Item[]>()
  for (const item of valid) byVariant.set(item.variantKey, [...(byVariant.get(item.variantKey) ?? []), item])
  const unique: Item[] = []
  for (const [, list] of [...byVariant.entries()].sort((a, b) => cmp(a[0], b[0]))) {
    const signatures = new Set(list.map((i) => JSON.stringify([i.variantSku, i.parentSku, i.parentName, i.status, i.wooVariationId, i.wooParentId])))
    if (list.length > 1 && signatures.size > 1) {
      for (const i of list) { add(i.row, i.variantSku, 'REJECTED', 'DUPLICATE_VARIATION_SKU', `the variation SKU appears ${list.length} times with different data (${[...new Set(list.map((x) => x.parentSku))].sort(cmp).join(', ')}): which is right cannot be decided`) }
      continue
    }
    unique.push(list[0])
    for (const extra of list.slice(1)) add(extra.row, extra.variantSku, 'EXCLUDED', 'DUPLICATE_ROW', 'exact duplicate of another variation row')
  }

  // 3. Every variation of one parent must agree on the parent, and one WooCommerce parent id must be one SKU.
  const byParent = new Map<string, Item[]>()
  for (const item of unique) byParent.set(item.parentKey, [...(byParent.get(item.parentKey) ?? []), item])
  const conflicted = new Set<string>()
  for (const [parentKey, list] of byParent) {
    if (new Set(list.map((i) => JSON.stringify([i.parentSku, i.parentName, i.status, i.wooParentId]))).size > 1) conflicted.add(parentKey)
  }
  const keysByParentId = new Map<string, Set<string>>()
  for (const item of unique) {
    if (item.wooParentId !== '') keysByParentId.set(item.wooParentId, (keysByParentId.get(item.wooParentId) ?? new Set<string>()).add(item.parentKey))
  }
  for (const keys of keysByParentId.values()) if (keys.size > 1) for (const key of keys) conflicted.add(key)

  const allVariationKeys = new Set(unique.map((i) => i.variantKey))
  const collides = (parentKey: string): string | null => {
    if (allVariationKeys.has(parentKey)) return 'it is also the SKU of a WooCommerce variation'
    const view = input.catalogue(parentKey)
    // A VARIABLE product the products file itself carries is the parent already: nothing is created, the variants simply join it.
    if (view.state === 'candidate' && view.type === 'VARIABLE') return null
    if (view.state === 'candidate' || view.state === 'rejected') return 'a Qoblex product has that SKU'
    if (input.imsKeys.has(parentKey)) return 'IMS already has a product with that SKU'
    return null
  }

  const providedByProducts = (parentKey: string): boolean => {
    const view = input.catalogue(parentKey)
    return view.state === 'candidate' && view.type === 'VARIABLE'
  }

  // 4. Dispositions per variation row, and the parents to emit.
  const assignments = new Map<string, string>()
  const parents = new Map<string, SyntheticParent>()
  const typeNotVariant: string[] = []
  const stemMismatch: string[] = []
  const joinedParentKeys = new Set<string>()
  const settledParents = new Set<string>()
  let variantsJoined = 0
  for (const [parentKey, list] of [...byParent.entries()].sort((a, b) => cmp(a[0], b[0]))) {
    const head = list[0]
    if (conflicted.has(parentKey)) {
      for (const i of list) { add(i.row, i.variantSku, 'REJECTED', 'PARENT_ATTRIBUTE_CONFLICT', `the variations of parent ${i.parentSku} disagree on the parent's SKU spelling, title, status or WooCommerce id: the parent is rejected with all of them`) }
      continue
    }
    const parentExcluded = input.exclusions.get(parentKey)
    const collision = parentExcluded === undefined ? collides(parentKey) : null
    if (collision !== null) {
      for (const i of list) { add(i.row, i.variantSku, 'REJECTED', 'PARENT_SKU_COLLIDES', `the parent SKU ${i.parentSku} cannot be created as a VARIABLE product: ${collision}`) }
      continue
    }
    for (const i of [...list].sort((a, b) => cmp(a.variantKey, b.variantKey))) {
      const variantExcluded = input.exclusions.get(i.variantKey)
      if (variantExcluded !== undefined) {
        add(i.row, i.variantSku, 'EXCLUDED', 'EXCLUDED_BY_LIST', `on the accepted exclusion list: ${variantExcluded}`)
        continue
      }
      const view = input.catalogue(i.variantKey)
      if (view.state === 'absent') { add(i.row, i.variantSku, 'EXCLUDED', 'NO_QOBLEX_PRODUCT', 'WooCommerce has this variation but Qoblex has no product with the SKU: nothing to join (the coverage check lists it unless it is excluded)'); continue }
      if (view.state === 'rejected') { add(i.row, i.variantSku, 'EXCLUDED', 'QOBLEX_ROW_REJECTED', 'the Qoblex row with this SKU was rejected (see the products dataset): it is not joined'); continue }
      if (view.state === 'excluded') { add(i.row, i.variantSku, 'EXCLUDED', 'EXCLUDED_BY_LIST', 'the Qoblex row with this SKU is on the exclusion list'); continue }
      if (view.type !== 'VARIANT') {
        add(i.row, i.variantSku, 'EXCLUDED', 'QOBLEX_TYPE_NOT_VARIANT', `Qoblex types this SKU as ${view.type}, which cannot have a parent in IMS: it loads as ${view.type} and the connector link step relates it to the WooCommerce variation`)
        typeNotVariant.push(i.variantSku)
        continue
      }
      if (view.parentSku !== '' && skuKey(view.parentSku) !== parentKey) {
        add(i.row, i.variantSku, 'REJECTED', 'PARENT_CONFLICT', `the products file gives parent ${view.parentSku} but WooCommerce says ${i.parentSku}`)
        continue
      }
      if (view.parentSku === '') assignments.set(i.variantKey, i.parentSku)
      if (parentExcluded !== undefined) {
        add(i.row, i.variantSku, 'EXCLUDED', 'PARENT_EXCLUDED_BY_LIST', `parent ${i.parentSku} is on the exclusion list (${parentExcluded}): the variant keeps it as its parent and is rejected, because the parent will not exist`)
        continue
      }
      variantsJoined++
      add(i.row, i.variantSku, 'EMITTED', 'VARIATION_JOINED', `joined by exact SKU to WooCommerce parent ${i.parentSku}`)
      joinedParentKeys.add(parentKey)
      if (skuStem(i.variantSku) !== parentKey) stemMismatch.push(`${i.variantSku} -> ${i.parentSku}`)
      if (providedByProducts(parentKey)) continue
      const parent = parents.get(parentKey) ?? { sku: head.parentSku, key: parentKey, name: head.parentName, lifecycle: head.lifecycle, wooParentId: head.wooParentId, variants: [] }
      parent.variants.push(i.variantSku)
      parents.set(parentKey, parent)
    }
    settledParents.add(parentKey)
  }

  // 5. Findings.
  const orphanParents = [...byParent.entries()]
    .filter(([key, list]) => settledParents.has(key) && !joinedParentKeys.has(key) && !input.exclusions.has(key) && !list.every((i) => input.exclusions.has(i.variantKey)))
    .map(([, list]) => list[0].parentSku)
    .sort(cmp)
  if (orphanParents.length > 0) {
    findings.push({
      severity: 'WARNING',
      code: 'WOO_PARENT_WITHOUT_QOBLEX_VARIANT',
      message: `${orphanParents.length} WooCommerce variable product(s) have no Qoblex variant: they are NOT loaded. Put each on the exclusion list with a reason, or load it later through the connector link step.`,
      keys: orphanParents,
    })
  }
  if (stemMismatch.length > 0) {
    findings.push({
      severity: 'WARNING',
      code: 'PARENT_STEM_MISMATCH',
      message: `${stemMismatch.length} variant(s) have a SKU whose "-NN" stem is not their WooCommerce parent's SKU. The parent was assigned from the WooCommerce variation (exact SKU), never from the stem; this is a cross-check only.`,
      keys: stemMismatch.sort(cmp),
    })
  }
  if (typeNotVariant.length > 0) {
    findings.push({
      severity: 'INFO',
      code: 'QOBLEX_TYPE_NOT_VARIANT',
      message: `${typeNotVariant.length} SKU(s) are WooCommerce variations but Qoblex types them as something that cannot have a parent (a bundle or manufactured product). They load with their Qoblex type and no parent.`,
      keys: typeNotVariant.sort(cmp),
    })
  }

  const emitted = [...parents.values()].sort((a, b) => cmp(a.key, b.key))
  return {
    dispositions,
    findings,
    assignments,
    parents: emitted,
    namedKeys,
    summary: { rowsRead: input.rows.length, variantsJoined, parentsEmitted: emitted.length, parentsWithoutQoblexVariant: orphanParents.length },
  }
}
