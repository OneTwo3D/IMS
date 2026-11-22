/**
 * THE FIRST-LOAD WMS ARCHIVE PLAN (owner addition 2026-11-21 (b) to the lifecycle review): after the owner's filled review sheet is imported, every
 * product the owner set to Archived must also be archived (discontinued) in the WMS. This module PLANS it: which SKUs would change, and why every
 * other one would not. PURE: no file, no clock, no request. lib/first-load/wms-discontinue/cli.ts gathers the inputs, and
 * lib/first-load/wms-discontinue/execute.ts carries out a plan whose token the operator confirmed.
 *
 * WHO IS IN THE PLAN. Every catalogue entry whose lifecycle came from an owner decision (`lifecycleSource: 'decision'`) and is ARCHIVED: a decision the
 * transform refused (unknown SKU, Archived with stock and no reason, ...) never reaches the catalogue as ARCHIVED, so it is never planned.
 *
 * EACH ROW, in this order (the first that applies):
 *   - SKIP_NOT_A_WMS_PRODUCT   a VARIABLE parent, or a NON_INVENTORY product, that the WMS does not hold under exactly its SKU. A VARIABLE parent is
 *                              LOOKED UP like any other product first (#1126 R1 LOW): the WMS may hold a parent SKU, and then it is planned as a product.
 *   - REFUSED_NOT_FOUND        the WMS holds no product under EXACTLY this SKU (never matched by name, letter case or whitespace; a pre-rename spelling,
 *                              exact or differing only in letter case or whitespace, or a near match is named so it can be fixed in the WMS first).
 *   - REFUSED_BUNDLE           the WMS product is a bundle. A bundle is a WMS listing built from other products, not a stock line of its own; whether it
 *                              is to be discontinued is a separate decision from the owner's (made in the WMS by the operator), so it is never written here.
 *   - SKIP_ALREADY_DISCONTINUED the WMS product is already discontinued: nothing to change, reported.
 *   - REFUSED_FLAG_NOT_STATED  the WMS row carries no discontinued flag, so its current state cannot be shown or verified.
 *   - REFUSED_NO_STOCK_ROW     the WMS lists the product but no configured warehouse has a stock row for it (#1126 R1 LOW): "no row" is not read as 0.
 *   - REFUSED_STOCK            the WMS physical stock (summed over the configured warehouses) is above zero.
 *   - WOULD_ARCHIVE            everything else: product id, current flag (false) and stock (0, from a stock row).
 *
 * THE CONFIRMATION TOKEN is derived from the whole plan: every row's SKU, outcome, product id, flag and stock, the sheet id, the warehouses read, the
 * WMS client id and the connection's origin (#1126 R1 MED), and whether a real prepare of the manifest is blocked. Any change between two runs (a product
 * that gained stock, a fresher decisions file, another tenant or address) gives another token, so a stale plan can never be confirmed.
 */
import { canonicalJson, sha256Hex } from '../snapshot'
import type { CatalogueEntry } from '../transform'
import { looseSku } from '../lifecycle-review/model'
import { skuKey } from '../validate'

/**
 * The WMS product census as the connector read it (GET only): the SKU exactly as held, the bundle and discontinued flags, physical stock per SKU (a SKU with
 * no stock row in any configured warehouse is ABSENT from `physical`, never 0), and which tenant and address it was read from.
 */
export interface WmsCensus {
  products: ReadonlyArray<{ sku: string; productId: string; bundle: boolean; status: 'active' | 'discontinued' | 'not stated' }>
  physical: ReadonlyMap<string, number>
  warehouses: readonly string[]
  /** The WMS client (tenant) id every row was checked against. */
  clientId: string
  /** The origin of the WMS connection the census was read from (scheme, host, port). */
  origin: string
}

export type ArchiveOutcome =
  | 'WOULD_ARCHIVE'
  | 'SKIP_ALREADY_DISCONTINUED'
  | 'SKIP_NOT_A_WMS_PRODUCT'
  | 'REFUSED_NOT_FOUND'
  | 'REFUSED_BUNDLE'
  | 'REFUSED_FLAG_NOT_STATED'
  | 'REFUSED_NO_STOCK_ROW'
  | 'REFUSED_STOCK'

export interface ArchivePlanRow {
  sku: string
  outcome: ArchiveOutcome
  /** The WMS product id, or null when the WMS holds no product under the SKU. */
  productId: string | null
  /** The WMS discontinued flag as read: true, false, or null (not stated, or no product). */
  discontinued: boolean | null
  /** The WMS physical stock summed over the configured warehouses, or null when the WMS holds no product under the SKU or no stock row for it. */
  stock: number | null
  /** Whether a configured warehouse has a stock row for the product (false when the WMS holds no product under the SKU). */
  stockRow: boolean
  reason: string
}

export interface ArchivePlan {
  sheetId: string
  /** A real first-load:prepare of the manifest is blocked by other findings: the import cannot have been made from it. */
  prepareBlocked: boolean
  rows: ArchivePlanRow[]
  /** `MSA-` and 16 hex digits of the plan digest. */
  token: string
  digest: string
  counts: Record<ArchiveOutcome, number>
}

export const ARCHIVE_PLAN_KIND = 'first-load-wms-archive-plan'
export const ARCHIVE_PLAN_FORMAT_VERSION = 2

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

export function buildArchivePlan(input: {
  sheetId: string
  catalogue: readonly CatalogueEntry[]
  skuRenames: ReadonlyArray<{ from: string; to: string }>
  census: WmsCensus
  wmsLabel: string
  prepareBlocked: boolean
}): ArchivePlan {
  const { census, wmsLabel } = input
  const bySku = new Map(census.products.map((p) => [p.sku, p]))
  const fromOf = new Map(input.skuRenames.map((r) => [skuKey(r.to), r.from]))
  const rows: ArchivePlanRow[] = []
  const targets = input.catalogue.filter((e) => e.lifecycleSource === 'decision' && e.lifecycle === 'ARCHIVED').sort((a, b) => cmp(a.sku, b.sku))
  for (const entry of targets) {
    const row = (outcome: ArchiveOutcome, reason: string, product?: WmsCensus['products'][number]): ArchivePlanRow => {
      const stock = product === undefined ? undefined : census.physical.get(product.sku)
      return {
        sku: entry.sku,
        outcome,
        productId: product?.productId ?? null,
        discontinued: product === undefined || product.status === 'not stated' ? null : product.status === 'discontinued',
        stock: stock ?? null,
        stockRow: stock !== undefined,
        reason,
      }
    }
    const product = bySku.get(entry.sku)
    if (product === undefined) {
      if (entry.type === 'VARIABLE') { rows.push(row('SKIP_NOT_A_WMS_PRODUCT', `a VARIABLE parent ${wmsLabel} does not hold under exactly this SKU (each variation is a row of its own)`)); continue }
      if (entry.type === 'NON_INVENTORY') { rows.push(row('SKIP_NOT_A_WMS_PRODUCT', `a NON_INVENTORY product ${wmsLabel} does not hold under exactly this SKU`)); continue }
      const hints: string[] = []
      const from = fromOf.get(skuKey(entry.sku))
      if (from !== undefined) {
        if (bySku.has(from)) hints.push(`${wmsLabel} still holds the pre-rename SKU ${JSON.stringify(from)}: fix the SKU there first`)
        const fromNear = census.products.filter((p) => p.sku !== from && looseSku(p.sku) === looseSku(from)).map((p) => JSON.stringify(p.sku))
        if (fromNear.length > 0) hints.push(`${wmsLabel} holds ${fromNear.join(', ')}, which differs from the pre-rename SKU ${JSON.stringify(from)} only in letter case or whitespace: fix the SKU there first`)
      }
      const near = census.products.filter((p) => p.sku !== entry.sku && looseSku(p.sku) === looseSku(entry.sku)).map((p) => JSON.stringify(p.sku))
      if (near.length > 0) hints.push(`${wmsLabel} holds ${near.join(', ')}, which differs only in letter case or whitespace (never matched)`)
      rows.push(row('REFUSED_NOT_FOUND', `${wmsLabel} holds no product under exactly this SKU${hints.length > 0 ? `; ${hints.join('; ')}` : ''}`))
      continue
    }
    if (product.bundle) { rows.push(row('REFUSED_BUNDLE', `the ${wmsLabel} product ${product.productId} is a bundle (built from other products): discontinuing it is a separate decision, made in ${wmsLabel}, never written here`, product)); continue }
    if (product.status === 'discontinued') { rows.push(row('SKIP_ALREADY_DISCONTINUED', `the ${wmsLabel} product ${product.productId} is already discontinued: nothing to change`, product)); continue }
    if (product.status === 'not stated') { rows.push(row('REFUSED_FLAG_NOT_STATED', `the ${wmsLabel} product ${product.productId} carries no discontinued flag, so its state cannot be shown or verified`, product)); continue }
    const stock = census.physical.get(product.sku)
    if (stock === undefined) { rows.push(row('REFUSED_NO_STOCK_ROW', `no configured ${wmsLabel} warehouse has a stock row for the product ${product.productId}: its stock is unknown, never read as 0`, product)); continue }
    if (stock > 0) { rows.push(row('REFUSED_STOCK', `the ${wmsLabel} product ${product.productId} holds physical stock ${stock}: it is never archived while it holds stock`, product)); continue }
    if (stock < 0) { rows.push(row('REFUSED_STOCK', `the ${wmsLabel} product ${product.productId} shows physical stock ${stock} (below zero): its stock is not settled`, product)); continue }
    rows.push(row('WOULD_ARCHIVE', `would set the ${wmsLabel} product ${product.productId} discontinued (currently not discontinued, physical stock 0)`, product))
  }
  const digest = sha256Hex(canonicalJson({
    kind: ARCHIVE_PLAN_KIND,
    formatVersion: ARCHIVE_PLAN_FORMAT_VERSION,
    sheetId: input.sheetId,
    warehouses: [...census.warehouses].sort(cmp),
    clientId: census.clientId,
    origin: census.origin,
    prepareBlocked: input.prepareBlocked,
    rows: rows.map(({ sku, outcome, productId, discontinued, stock, stockRow }) => ({ sku, outcome, productId, discontinued, stock, stockRow })),
  }))
  const counts = { WOULD_ARCHIVE: 0, SKIP_ALREADY_DISCONTINUED: 0, SKIP_NOT_A_WMS_PRODUCT: 0, REFUSED_NOT_FOUND: 0, REFUSED_BUNDLE: 0, REFUSED_FLAG_NOT_STATED: 0, REFUSED_NO_STOCK_ROW: 0, REFUSED_STOCK: 0 } satisfies Record<ArchiveOutcome, number>
  for (const r of rows) counts[r.outcome]++
  return { sheetId: input.sheetId, prepareBlocked: input.prepareBlocked, rows, token: `MSA-${digest.slice(0, 16)}`, digest, counts }
}

export const isRefused = (outcome: ArchiveOutcome): boolean => outcome.startsWith('REFUSED_')
