/**
 * ITEMS R2 AND R5: IMS AGAINST THE QOBLEX EXPORT (lib/reconciliation-pack/qoblex-source.ts), stock and valuation.
 *
 * Neither reads a vendor: the only outside input is the operator-supplied export, and without --qoblex-export (the source absent) the run
 * reports QOBLEX_EXPORT_OFF before either is called (run.ts) and nothing is read.
 *
 * THE BASIS (stated, decided from the catalogue and the as-of convention of the pack). The IMS side is the INVENTORY SNAPSHOT of the cycle
 * date D (inventory_snapshots: quantity and valueBase in GBP, the daily point-in-time capture the ledger items R6 and R10 also stand on),
 * read in the same one REPEATABLE READ READ ONLY transaction as the products, warehouses and WMS bindings it is resolved against. The
 * live stock levels are NOT used: the export is a past instant and the live figure has moved since. The export must be for the same D
 * (manifest asOf equal to --as-of), exported after D ended; that is the operator's declaration (U10), so equality of two figures taken at
 * two slightly different instants is only as good as that declaration.
 *
 * THE POPULATION. The locations are the manifest's: a location declared threePl is set aside (IMS holds no feed for a 3PL's stock in P1,
 * F8) and the rest are NON-3PL. A non-3PL location must resolve to an IMS warehouse by its code and that warehouse must have NO WMS binding
 * of any connector (a declared non-3PL warehouse that IMS knows as a 3PL's is a contradiction, NO_POPULATION_RECORD). A location the export
 * contains but the manifest does not declare makes the stock part unreadable (qoblex-source.ts).
 *
 *   R2  The identity is (SKU, warehouse code); the value is the quantity on hand, EXACT (the finest stored precision, 0.0001). A position
 *       of zero and no position are the same thing, so zero rows are dropped on BOTH sides before the comparison (otherwise the
 *       snapshot's sparse rows and Qoblex's explicit zeros would disagree about nothing). Several lots of one SKU in one location are
 *       summed only when the export tells them apart by distinct lot references (qoblex-source.ts). An empty population on both sides
 *       passes only on the named proof that the snapshot run row exists and records nothing for the population.
 *       In phase P1 the item is LISTED ONLY by the readiness gate (owner decision D3: IMS has no feed for non-3PL movements until the
 *       operators mirror them); the pack compares it exactly all the same.
 *
 *   R5  The identities are each non-3PL warehouse and each COMPANY (the manifest's grouping of its warehouses; IMS has no company concept,
 *       so the declaration is shared by both sides). The value is the valuation in GBP: IMS = the sum of the snapshot's valueBase; Qoblex
 *       = the sum over its stock rows of quantity x unit cost (each product rounded half-up to six decimals, the snapshot's scale). The
 *       pass rule is the catalogue's composite: the difference may be at most max(GBP 1, 0.05% of the LARGER of the two totals),
 *       inclusive. Every (SKU, warehouse) whose own valuation differs by MORE than 0.5% of the larger is also LISTED, under the
 *       outOfPopulation bucket (REPORTED_NOT_JUDGED): it never decides the outcome. Any currency other than GBP, a cost missing on a
 *       row with stock, a foreign exchange rate on a GBP row, or a snapshot row that is not point-in-time reliable makes the item
 *       inconclusive; nothing is converted or guessed.
 *       UNVERIFIED (U14): the exact formula Qoblex uses for its valuation is not known; quantity x unit cost of the stock export is the
 *       stated reading, and a difference in method shows up as a difference here.
 */

import { Prisma } from '@/app/generated/prisma/client'
import { compareItem, decimalText, outcomeOfComparison, parseDecimalStrict, type CompareEntry, type CompareResult, type SideRow } from '@/lib/reconciliation-pack/compare'
import { R5_PER_SKU_LIST_FRACTION, QOBLEX_BASE_CURRENCY, type PackReasonCode, type PackSourceCode } from '@/lib/reconciliation-pack/constants'
import { keyToken, type KeyPart } from '@/lib/reconciliation-pack/identity'
import type { ImsRead, ImsReadOptions, ImsSnapshots } from '@/lib/reconciliation-pack/ims-readers'
import type { ItemInput } from '@/lib/reconciliation-pack/report'
import type { QoblexExport, QoblexLocation, QoblexLot, QoblexSource } from '@/lib/reconciliation-pack/qoblex-source'

export const QOBLEX_ITEM_IDS = ['R2', 'R5'] as const
export type QoblexItemId = (typeof QOBLEX_ITEM_IDS)[number]
export function isQoblexItem(id: string): id is QoblexItemId {
  return (QOBLEX_ITEM_IDS as readonly string[]).includes(id)
}

export type QoblexItemContext = {
  asOf: string
  ims?: (options: ImsReadOptions) => Promise<ImsRead>
  /** Absent = the run named no export: the item reads nothing. */
  qoblex?: QoblexSource
}

const IMS: PackSourceCode = 'ims-database'
const QOBLEX: PackSourceCode = 'qoblex-file'
const SOURCES: readonly PackSourceCode[] = [IMS, QOBLEX]

const inconclusive = (id: QoblexItemId, sources: readonly PackSourceCode[], ...reasons: PackReasonCode[]): ItemInput => ({ id, outcome: 'inconclusive', reasons: [...new Set(reasons)], sources: [...sources] })

function fromComparison(id: QoblexItemId, result: CompareResult): ItemInput {
  const verdict = outcomeOfComparison(result)
  const proof = verdict.outcome === 'pass' && result.status === 'compared' ? result.proof : null
  return { id, outcome: verdict.outcome, reasons: verdict.reasons, proof, sources: [...SOURCES], entries: result.status === 'compared' ? result.buckets : undefined }
}

const Dec = Prisma.Decimal
type Dec = Prisma.Decimal
const dec = (text: string): Dec => parseDecimalStrict(text) ?? new Dec(NaN)

// ---------------------------------------------------------------------------------------------
// The IMS side: the snapshot of the cycle date, resolved to SKUs and warehouse codes.
// ---------------------------------------------------------------------------------------------

export type ImsPosition = { sku: string; code: string; qty: Dec; value: Dec; reliable: boolean }
type ImsView = { ok: true; positions: ImsPosition[] } | { ok: false; reason: PackReasonCode }

/** The positions of the cycle date's snapshot in the non-3PL locations of the manifest, or the closed reason they cannot be had. */
export async function readImsPositions(readIms: (options: ImsReadOptions) => Promise<ImsRead>, asOf: string, scope: readonly QoblexLocation[]): Promise<ImsView> {
  const read = await readIms({ sections: ['snapshots', 'products', 'warehouses', 'wmsBindings'], asOf })
  if (!read.ok) return { ok: false, reason: read.reason }
  const snapshots = read.sections.snapshots
  const products = read.sections.products
  const warehouses = read.sections.warehouses
  const bindings = read.sections.wmsBindings
  for (const section of [snapshots, products, warehouses, bindings]) {
    if (section === undefined) return { ok: false, reason: 'SOURCE_UNREADABLE' }
    if (!section.ok) return { ok: false, reason: section.reason }
  }
  const snapshot = (snapshots as { ok: true; value: ImsSnapshots }).value
  const productList = (products as { ok: true; value: Array<{ id: string; sku: string }> }).value
  const warehouseList = (warehouses as { ok: true; value: Array<{ id: string; code: string }> }).value
  const bindingList = (bindings as { ok: true; value: Array<{ warehouseId: string }> }).value

  const byCode = new Map(warehouseList.map((w) => [w.code, w.id]))
  const inScope = new Map<string, string>()
  for (const location of scope) {
    const id = byCode.get(location.code)
    if (id === undefined) return { ok: false, reason: 'NO_POPULATION_RECORD' }
    // A warehouse the manifest calls non-3PL that IMS has a WMS binding for is a contradiction: it is never compared as non-3PL.
    if (bindingList.some((b) => b.warehouseId === id)) return { ok: false, reason: 'NO_POPULATION_RECORD' }
    inScope.set(id, location.code)
  }
  // The snapshot of the cycle date must exist (its run row), and name only products and warehouses IMS holds.
  if (snapshot.run === null) return { ok: false, reason: 'SNAPSHOT_UNAVAILABLE' }
  const skuById = new Map(productList.map((p) => [p.id, p.sku]))
  const knownWarehouse = new Set(warehouseList.map((w) => w.id))
  const positions: ImsPosition[] = []
  for (const row of snapshot.values) {
    const sku = skuById.get(row.productId)
    if (sku === undefined || !knownWarehouse.has(row.warehouseId)) return { ok: false, reason: 'SNAPSHOT_UNAVAILABLE' }
    const code = inScope.get(row.warehouseId)
    if (code === undefined) continue
    const qty = parseDecimalStrict(row.qty)
    const value = parseDecimalStrict(row.valueBase)
    if (qty === null || value === null) return { ok: false, reason: 'BAD_VALUE' }
    positions.push({ sku, code, qty, value, reliable: row.valueReplayReliable })
  }
  return { ok: true, positions }
}

// ---------------------------------------------------------------------------------------------
// The Qoblex side
// ---------------------------------------------------------------------------------------------

export type QoblexPosition = { sku: string; code: string; qty: Dec; value: Dec | null }

/** Quantity (and, with `valued`, value in GBP) per (SKU, location) over the non-3PL locations. Lots of one position are summed. */
export function qoblexPositions(lots: readonly QoblexLot[], scope: ReadonlySet<string>, valued: boolean): { ok: true; positions: QoblexPosition[] } | { ok: false; reason: PackReasonCode } {
  const by = new Map<string, QoblexPosition>()
  for (const lot of lots) {
    if (!scope.has(lot.location)) continue
    const qty = dec(lot.qty)
    let value: Dec | null = null
    if (valued) {
      if (lot.currency !== QOBLEX_BASE_CURRENCY) return { ok: false, reason: 'CURRENCY_UNKNOWN' }
      // A rate on a base-currency row is a conversion this comparison does not make: only blank or exactly 1 is the base currency's own.
      if (lot.fxRateToBase !== '' && !(parseDecimalStrict(lot.fxRateToBase)?.equals(1) ?? false)) return { ok: false, reason: 'CURRENCY_UNKNOWN' }
      if (qty.isZero()) value = new Dec(0)
      else {
        if (lot.unitCost === null) return { ok: false, reason: 'VALUE_MISSING' }
        value = qty.mul(dec(lot.unitCost)).toDecimalPlaces(6, Dec.ROUND_HALF_UP)
      }
    }
    const id = `${lot.sku}\u0001${lot.location}`
    const have = by.get(id)
    if (have) by.set(id, { ...have, qty: have.qty.plus(qty), value: value === null ? null : (have.value ?? new Dec(0)).plus(value) })
    else by.set(id, { sku: lot.sku, code: lot.location, qty, value })
  }
  return { ok: true, positions: [...by.values()] }
}

type Loaded = { qoblex: QoblexExport; scope: QoblexLocation[]; lots: QoblexLot[] }
async function loadQoblex(source: QoblexSource): Promise<{ ok: true; value: Loaded } | { ok: false; reason: PackReasonCode }> {
  const read = await source.read()
  if (!read.ok) return { ok: false, reason: read.reason }
  const qoblex = read.value
  if (!qoblex.stock.ok) return { ok: false, reason: qoblex.stock.reason }
  const scope = qoblex.locations.filter((l) => !l.threePl)
  // With no non-3PL location there is no population: that is not an empty stock, it is no record of what to compare.
  if (scope.length === 0) return { ok: false, reason: 'NO_POPULATION_RECORD' }
  return { ok: true, value: { qoblex, scope, lots: qoblex.stock.value } }
}

// ---------------------------------------------------------------------------------------------
// R2
// ---------------------------------------------------------------------------------------------

const stockKey = (sku: string, code: string): KeyPart[] => [{ kind: 'sku', raw: sku }, { kind: 'warehouse', raw: code }]

async function runR2(context: QoblexItemContext): Promise<ItemInput> {
  if (context.qoblex === undefined || context.ims === undefined) return inconclusive('R2', [], 'SOURCE_UNREADABLE')
  const loaded = await loadQoblex(context.qoblex)
  if (!loaded.ok) return inconclusive('R2', [QOBLEX], loaded.reason)
  const { scope, lots } = loaded.value
  const view = await readImsPositions(context.ims, context.asOf, scope)
  if (!view.ok) return inconclusive('R2', [IMS, QOBLEX], view.reason)
  const theirs = qoblexPositions(lots, new Set(scope.map((l) => l.code)), false)
  if (!theirs.ok) return inconclusive('R2', [IMS, QOBLEX], theirs.reason)

  // A position of zero is no position: zero rows leave both sides.
  const ims: SideRow[] = view.positions.filter((p) => !p.qty.isZero()).map((p) => ({ key: stockKey(p.sku, p.code), value: decimalText(p.qty) }))
  const vendor: SideRow[] = theirs.positions.filter((p) => !p.qty.isZero()).map((p) => ({ key: stockKey(p.sku, p.code), value: decimalText(p.qty) }))
  const result = compareItem('R2', { ims, vendor, imsComplete: true, vendorComplete: true, emptyProof: 'snapshot-run-row-present' })
  return fromComparison('R2', result)
}

// ---------------------------------------------------------------------------------------------
// R5
// ---------------------------------------------------------------------------------------------

const warehouseKey = (code: string): KeyPart[] => [{ kind: 'warehouse', raw: code }]
const companyKey = (company: string): KeyPart[] => [{ kind: 'warehouse', raw: 'COMPANY' }, { kind: 'warehouse', raw: company }]

async function runR5(context: QoblexItemContext): Promise<ItemInput> {
  if (context.qoblex === undefined || context.ims === undefined) return inconclusive('R5', [], 'SOURCE_UNREADABLE')
  const loaded = await loadQoblex(context.qoblex)
  if (!loaded.ok) return inconclusive('R5', [QOBLEX], loaded.reason)
  const { scope, lots } = loaded.value
  const view = await readImsPositions(context.ims, context.asOf, scope)
  if (!view.ok) return inconclusive('R5', [IMS, QOBLEX], view.reason)
  // A valuation resting on a snapshot row that is not point-in-time reliable is not a valuation of that day.
  if (view.positions.some((p) => !p.reliable)) return inconclusive('R5', [IMS, QOBLEX], 'SNAPSHOT_UNAVAILABLE')
  const theirs = qoblexPositions(lots, new Set(scope.map((l) => l.code)), true)
  if (!theirs.ok) return inconclusive('R5', [IMS, QOBLEX], theirs.reason)

  const sum = (rows: ReadonlyArray<{ code: string; v: Dec }>, codes: readonly string[]): Dec => rows.filter((r) => codes.includes(r.code)).reduce((acc, r) => acc.plus(r.v), new Dec(0))
  const mine = view.positions.map((p) => ({ code: p.code, v: p.value }))
  const other = theirs.positions.map((p) => ({ code: p.code, v: p.value ?? new Dec(0) }))
  const side = (rows: ReadonlyArray<{ code: string; v: Dec }>): SideRow[] => {
    const out: SideRow[] = []
    for (const location of scope) out.push({ key: warehouseKey(location.code), value: decimalText(sum(rows, [location.code])), currency: QOBLEX_BASE_CURRENCY })
    for (const company of [...new Set(scope.map((l) => l.company))]) {
      out.push({ key: companyKey(company), value: decimalText(sum(rows, scope.filter((l) => l.company === company).map((l) => l.code))), currency: QOBLEX_BASE_CURRENCY })
    }
    return out
  }
  const result = compareItem('R5', { ims: side(mine), vendor: side(other), imsComplete: true, vendorComplete: true, emptyProof: 'snapshot-run-row-present' })
  if (result.status !== 'compared') return fromComparison('R5', result)

  // THE PER-SKU LIST: reported, never decisive. A (SKU, warehouse) whose valuation differs by more than 0.5% of the larger of the two.
  const imsBy = new Map(view.positions.map((p) => [`${p.sku}\u0001${p.code}`, p] as const))
  const qobBy = new Map(theirs.positions.map((p) => [`${p.sku}\u0001${p.code}`, p] as const))
  const used = new Set<string>(comparisonTokens(result))
  const listed: CompareEntry[] = []
  for (const id of [...new Set([...imsBy.keys(), ...qobBy.keys()])].sort()) {
    const a = imsBy.get(id)
    const b = qobBy.get(id)
    const x = a ? a.value : null
    const y = b ? (b.value ?? new Dec(0)) : null
    const larger = Dec.max((x ?? new Dec(0)).abs(), (y ?? new Dec(0)).abs())
    if (larger.isZero()) continue
    const difference = (x ?? new Dec(0)).minus(y ?? new Dec(0)).abs()
    if (!difference.gt(larger.mul(R5_PER_SKU_LIST_FRACTION))) continue
    const sku = (a ?? b)!.sku
    const code = (a ?? b)!.code
    const token = keyToken(stockKey(sku, code))
    // Two identities that print alike are never both listed: a token is the key of the evidence.
    if (used.has(token)) return inconclusive('R5', SOURCES, 'DUPLICATE_KEY')
    used.add(token)
    listed.push({ key: token, ims: x === null ? null : decimalText(x), vendor: y === null ? null : decimalText(y), delta: null, imsCurrency: x === null ? null : QOBLEX_BASE_CURRENCY, vendorCurrency: y === null ? null : QOBLEX_BASE_CURRENCY, imsPresent: x !== null, vendorPresent: y !== null })
  }
  const buckets = { ...result.buckets, outOfPopulation: [...result.buckets.outOfPopulation, ...listed] }
  return fromComparison('R5', { ...result, buckets })
}

function comparisonTokens(result: Extract<CompareResult, { status: 'compared' }>): string[] {
  return Object.values(result.buckets).flatMap((entries) => entries.map((entry) => entry.key as string))
}

/** Run R2 or R5. Never throws; whatever cannot be proven is inconclusive with a closed reason. */
export async function runQoblexItem(id: QoblexItemId, context: QoblexItemContext): Promise<ItemInput> {
  if (context.qoblex === undefined) return { id, outcome: 'inconclusive', reasons: ['QOBLEX_EXPORT_OFF'] }
  try {
    return id === 'R2' ? await runR2(context) : await runR5(context)
  } catch {
    return inconclusive(id, [], 'INTERNAL_ERROR')
  }
}
