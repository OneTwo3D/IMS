/**
 * WHAT THE QOBLEX READ SKIPPED, DROPPED, READ AS ZERO OR RENAMED, as evidence entries (REPORTED_NOT_JUDGED: they sit in the `outOfPopulation`
 * bucket and never decide an outcome).
 *
 * The native column map and the first load's decisions change what is compared: rows are skipped (a Deleted product, a kit or non-inventory item that
 * holds no stock), ghost rows are dropped, a blank stock total over blank-or-zero warehouse cells is read as 0 on hand (blankStockIsZero), and the first
 * load's SKU renames are applied. The first-load ingest reports all of it (rowsSkipped, notes); this module hands it to the reader of the report, so an
 * export fault that reads as 0 or a row that vanished is visible and not agreed on by construction. An entry's key is `SKU|<marker>` (or
 * `<marker>|<detail>...`), the marker naming what happened:
 *
 *   qoblex-blank-as-zero   R2   the SKU's stock was read as 0 on hand because the total was blank and every cell blank or zero (value 0).
 *   qoblex-ghost-row       R2   a ghost row of the SKU was dropped (value: its quantity, zero or blank, so 0); R14 lists the same for the products part.
 *   qoblex-rows-skipped    R14  `qoblex-rows-skipped|<part>|<what skipped them>|<count>`: how many rows the map left out of a part.
 *   qoblex-sku-renamed     R14  `FROM|qoblex-sku-renamed|TO`: the first load's rename applied to the export; the export's SKU is compared as TO.
 *   qoblex-sku-rename-unused R14 `FROM|qoblex-sku-rename-unused`: a listed rename that changed no SKU cell of the export (a typo, or a SKU the export lacks).
 */

import type { CompareEntry } from '@/lib/reconciliation-pack/compare'
import { decimalText, parseDecimalStrict } from '@/lib/reconciliation-pack/compare'
import { keyToken, type KeyPart } from '@/lib/reconciliation-pack/identity'
import type { QoblexReadEvidence } from '@/lib/reconciliation-pack/qoblex-source'

const sku = (raw: string): KeyPart => ({ kind: 'sku', raw })
const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'other'

const listed = (key: KeyPart[], vendor: string | null): CompareEntry => ({ key: keyToken(key), ims: null, vendor, delta: null, imsCurrency: null, vendorCurrency: null, imsPresent: false, vendorPresent: true })

const unique = (skus: readonly string[]): string[] => [...new Set(skus)].sort()

/** R2 (quantity, a decimal value): the SKUs read as zero and the zero ghost rows of the stock part. */
export function stockEvidenceEntries(evidence: QoblexReadEvidence): CompareEntry[] {
  const out: CompareEntry[] = []
  for (const name of unique(evidence.stock.blankAsZero)) out.push(listed([sku(name), sku('qoblex-blank-as-zero')], '0'))
  for (const name of unique(evidence.stock.ghostRows.map((g) => g.sku))) {
    const quantity = evidence.stock.ghostRows.filter((g) => g.sku === name).map((g) => parseDecimalStrict(g.quantity.trim() === '' ? '0' : g.quantity.trim())).reduce((sum, q) => (sum === null || q === null ? null : sum.plus(q)), parseDecimalStrict('0'))
    out.push(listed([sku(name), sku('qoblex-ghost-row')], quantity === null ? '0' : decimalText(quantity)))
  }
  return out
}

/** R14 (presence): the ghost rows of the products part, the rows each part skipped, and the first load's renames. No values. */
export function coverageEvidenceEntries(evidence: QoblexReadEvidence): CompareEntry[] {
  const out: CompareEntry[] = []
  for (const name of unique(evidence.products.ghostRows.map((g) => g.sku))) out.push(listed([sku(name), sku('qoblex-ghost-row')], null))
  for (const [part, data] of [['products', evidence.products], ['stock', evidence.stock]] as const) {
    const byKind = new Map<string, number>()
    for (const [kind, count] of Object.entries(data.rowsSkipped)) byKind.set(slug(kind), (byKind.get(slug(kind)) ?? 0) + count)
    for (const [kind, count] of [...byKind.entries()].sort()) out.push(listed([sku('qoblex-rows-skipped'), sku(part), sku(kind), sku(String(count))], null))
  }
  for (const rename of [...evidence.skuRenames].sort((a, b) => a.from.localeCompare(b.from))) {
    out.push(rename.cells === 0 ? listed([sku(rename.from), sku('qoblex-sku-rename-unused')], null) : listed([sku(rename.from), sku('qoblex-sku-renamed'), sku(rename.to)], null))
  }
  return out
}
