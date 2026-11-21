/**
 * THE FIRST-LOAD MINTSOFT ARCHIVE PLAN (owner addition 2026-11-21 (b) to the lifecycle review): after the owner's filled review sheet is imported, every
 * product the owner set to Archived must also be archived (discontinued) in the WMS. This module only PLANS it: which SKUs would change, and why every
 * other one would not. PURE: no file, no clock, no request. lib/first-load/mintsoft-archive/cli.ts gathers the inputs.
 *
 * WHO IS IN THE PLAN. Every catalogue entry whose lifecycle came from an owner decision (`lifecycleSource: 'decision'`) and is ARCHIVED: a decision the
 * transform refused (unknown SKU, Archived with stock and no reason, ...) never reaches the catalogue as ARCHIVED, so it is never planned.
 *
 * EACH ROW, in this order (the first that applies):
 *   - SKIP_NOT_A_WMS_PRODUCT   a VARIABLE parent (a WooCommerce construct: its variations are rows of their own), or a NON_INVENTORY product the WMS does
 *                              not hold (no physical stock is kept for it).
 *   - REFUSED_NOT_FOUND        the WMS holds no product under EXACTLY this SKU (never matched by name, letter case or whitespace; a pre-rename spelling
 *                              or a near match is named so it can be fixed in the WMS first).
 *   - REFUSED_BUNDLE           the WMS product is a bundle (a bundle holds no stock of its own; archiving it is not what the owner decided).
 *   - SKIP_ALREADY_DISCONTINUED the WMS product is already discontinued: nothing to change, reported.
 *   - REFUSED_FLAG_NOT_STATED  the WMS row carries no discontinued flag, so its current state cannot be shown or verified.
 *   - REFUSED_STOCK            the WMS physical stock (summed over the configured warehouses) is above zero.
 *   - WOULD_ARCHIVE            everything else: product id, current flag (false) and stock (0).
 *
 * THE CONFIRMATION TOKEN is derived from the whole plan (every row's SKU, outcome, product id, flag and stock, the sheet id and the warehouses read): any
 * change between two runs (a product that gained stock, a fresher decisions file) gives another token, so a stale plan can never be confirmed.
 */
import { canonicalJson, sha256Hex } from '../snapshot'
import type { CatalogueEntry } from '../transform'
import { skuKey } from '../validate'

/** The WMS product census as the connector read it (GET only): the SKU exactly as held, the bundle and discontinued flags, physical stock per SKU. */
export interface WmsCensus {
  products: ReadonlyArray<{ sku: string; productId: string; bundle: boolean; status: 'active' | 'discontinued' | 'not stated' }>
  physical: ReadonlyMap<string, number>
  warehouses: readonly string[]
}

export type ArchiveOutcome =
  | 'WOULD_ARCHIVE'
  | 'SKIP_ALREADY_DISCONTINUED'
  | 'SKIP_NOT_A_WMS_PRODUCT'
  | 'REFUSED_NOT_FOUND'
  | 'REFUSED_BUNDLE'
  | 'REFUSED_FLAG_NOT_STATED'
  | 'REFUSED_STOCK'

export interface ArchivePlanRow {
  sku: string
  outcome: ArchiveOutcome
  /** The WMS product id, or null when the WMS holds no product under the SKU. */
  productId: string | null
  /** The WMS discontinued flag as read: true, false, or null (not stated, or no product). */
  discontinued: boolean | null
  /** The WMS physical stock summed over the configured warehouses, or null when the WMS holds no product under the SKU. */
  stock: number | null
  reason: string
}

export interface ArchivePlan {
  sheetId: string
  rows: ArchivePlanRow[]
  /** `MSA-` and 16 hex digits of the plan digest. */
  token: string
  digest: string
  counts: Record<ArchiveOutcome, number>
}

export const ARCHIVE_PLAN_KIND = 'first-load-mintsoft-archive-plan'
export const ARCHIVE_PLAN_FORMAT_VERSION = 1

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const loose = (sku: string): string => sku.normalize('NFC').replace(/\s+/gu, '').toUpperCase()

export function buildArchivePlan(input: {
  sheetId: string
  catalogue: readonly CatalogueEntry[]
  skuRenames: ReadonlyArray<{ from: string; to: string }>
  census: WmsCensus
  wmsLabel: string
}): ArchivePlan {
  const { census, wmsLabel } = input
  const bySku = new Map(census.products.map((p) => [p.sku, p]))
  const fromOf = new Map(input.skuRenames.map((r) => [skuKey(r.to), r.from]))
  const rows: ArchivePlanRow[] = []
  const targets = input.catalogue.filter((e) => e.lifecycleSource === 'decision' && e.lifecycle === 'ARCHIVED').sort((a, b) => cmp(a.sku, b.sku))
  for (const entry of targets) {
    const row = (outcome: ArchiveOutcome, reason: string, product?: WmsCensus['products'][number]): ArchivePlanRow => ({
      sku: entry.sku,
      outcome,
      productId: product?.productId ?? null,
      discontinued: product === undefined || product.status === 'not stated' ? null : product.status === 'discontinued',
      stock: product === undefined ? null : census.physical.get(product.sku) ?? 0,
      reason,
    })
    if (entry.type === 'VARIABLE') { rows.push(row('SKIP_NOT_A_WMS_PRODUCT', `a VARIABLE parent is a WooCommerce construct, not a ${wmsLabel} product (each variation is a row of its own)`)); continue }
    const product = bySku.get(entry.sku)
    if (product === undefined) {
      if (entry.type === 'NON_INVENTORY') { rows.push(row('SKIP_NOT_A_WMS_PRODUCT', `a NON_INVENTORY product ${wmsLabel} does not hold`)); continue }
      const hints: string[] = []
      const from = fromOf.get(skuKey(entry.sku))
      if (from !== undefined && bySku.has(from)) hints.push(`${wmsLabel} still holds the pre-rename SKU ${JSON.stringify(from)}: fix the SKU there first`)
      const near = census.products.filter((p) => p.sku !== entry.sku && loose(p.sku) === loose(entry.sku)).map((p) => JSON.stringify(p.sku))
      if (near.length > 0) hints.push(`${wmsLabel} holds ${near.join(', ')}, which differs only in letter case or whitespace (never matched)`)
      rows.push(row('REFUSED_NOT_FOUND', `${wmsLabel} holds no product under exactly this SKU${hints.length > 0 ? `; ${hints.join('; ')}` : ''}`))
      continue
    }
    if (product.bundle) { rows.push(row('REFUSED_BUNDLE', `the ${wmsLabel} product ${product.productId} is a bundle`, product)); continue }
    if (product.status === 'discontinued') { rows.push(row('SKIP_ALREADY_DISCONTINUED', `the ${wmsLabel} product ${product.productId} is already discontinued: nothing to change`, product)); continue }
    if (product.status === 'not stated') { rows.push(row('REFUSED_FLAG_NOT_STATED', `the ${wmsLabel} product ${product.productId} carries no discontinued flag, so its state cannot be shown or verified`, product)); continue }
    const stock = census.physical.get(product.sku) ?? 0
    if (stock > 0) { rows.push(row('REFUSED_STOCK', `the ${wmsLabel} product ${product.productId} holds physical stock ${stock}: it is never archived while it holds stock`, product)); continue }
    rows.push(row('WOULD_ARCHIVE', `would set the ${wmsLabel} product ${product.productId} discontinued (currently not discontinued, physical stock 0)`, product))
  }
  const digest = sha256Hex(canonicalJson({
    kind: ARCHIVE_PLAN_KIND,
    formatVersion: ARCHIVE_PLAN_FORMAT_VERSION,
    sheetId: input.sheetId,
    warehouses: [...census.warehouses].sort(cmp),
    rows: rows.map(({ sku, outcome, productId, discontinued, stock }) => ({ sku, outcome, productId, discontinued, stock })),
  }))
  const counts = { WOULD_ARCHIVE: 0, SKIP_ALREADY_DISCONTINUED: 0, SKIP_NOT_A_WMS_PRODUCT: 0, REFUSED_NOT_FOUND: 0, REFUSED_BUNDLE: 0, REFUSED_FLAG_NOT_STATED: 0, REFUSED_STOCK: 0 } satisfies Record<ArchiveOutcome, number>
  for (const r of rows) counts[r.outcome]++
  return { sheetId: input.sheetId, rows, token: `MSA-${digest.slice(0, 16)}`, digest, counts }
}

export const isRefused = (outcome: ArchiveOutcome): boolean => outcome.startsWith('REFUSED_')
